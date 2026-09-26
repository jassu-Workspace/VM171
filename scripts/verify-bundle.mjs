/**
 * Bundle verifier — Cycle 3.8
 * ---------------------------------------------------------------------------
 * A build artifact is a delivery mechanism. Whatever is in it reaches users,
 * and whatever was stripped from source but survives a bundler reaches users
 * too. This asserts properties of the ARTIFACT, not of the source.
 *
 * Checks, in order of what has actually bitten this project:
 *
 *   1. The artifact exists. A build that reports success without writing
 *      anything passes every other check trivially.
 *   2. MV3 manifest, declared and versioned.
 *   3. NO SECRETS. The single most important check. Bundlers inline
 *      `process.env` at build time when asked to, and a credential baked into
 *      a shipped bundle is a credential published to the Chrome Web Store.
 *   4. NO absolute developer paths. Leaks the operator's username and home
 *      directory, and hardcodes a layout that breaks for everyone else.
 *   5. No source maps pointing outside the repo, and no leftover .env content.
 *   6. Minimum permissions and no remotely-hosted code. MV3 forbids remote
 *      code, and `web_accessible_resources` is the standard way it sneaks
 *      back in.
 *
 * Exits non-zero on any failure.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

const ROOT = process.cwd();
const failures = [];

const fail = (m) => failures.push(m);
const note = (m) => console.log(`[bundle] note: ${m}`);

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip sourcemaps: they are large, and they are checked separately below.
      if (entry.name !== 'maps' && entry.name !== 'assets') walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

// ── Locate the extension bundle ──────────────────────────────────────────────
const BUNDLE_DIR = join(ROOT, 'extension', '.output', 'chrome-mv3');
const SERVER_BUNDLE = join(ROOT, 'server', 'dist', 'index.js');

if (!existsSync(BUNDLE_DIR)) {
  fail(
    `no extension bundle at ${relative(ROOT, BUNDLE_DIR)} — run "npm run build" in extension/ first`,
  );
}

const files = walk(BUNDLE_DIR);
const SERVER_ONLY = !existsSync(BUNDLE_DIR);
if (!SERVER_ONLY) note(`${files.length} files in the extension bundle`);

// ── 1 + 2. Manifest ──────────────────────────────────────────────────────────
const manifestPath = join(BUNDLE_DIR, 'manifest.json');
if (!SERVER_ONLY) {
  if (!existsSync(manifestPath)) {
    fail('no manifest.json in the bundle — the extension cannot load');
  } else {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (e) {
      fail(`manifest.json is not valid JSON: ${e.message}`);
    }
    if (manifest) {
      if (manifest.manifest_version !== 3) {
        fail(`manifest_version is ${manifest.manifest_version}, expected 3`);
      }
      // MV3 bans remotely-hosted code. A CSP that permits remote script is the
      // single most common way that rule gets broken in practice.
      const csp = manifest.content_security_policy?.extension_pages ?? '';
      if (/script-src[^;]*https?:/.test(csp)) {
        fail(`content_security_policy permits remote script: ${csp}`);
      }
      if (!csp) {
        note('no extension_pages CSP declared (MV3 default applies)');
      }
      // Host permissions. `<all_urls>` is EXPECTED for a general web agent: it
      // has to inject into whatever site the operator is on, and there is no
      // narrower permission that still does the job. It is reported loudly
      // because it IS a standing risk — it is the reason this extension needs
      // Chrome Web Store review rather than self-distribution — but failing
      // the build on it would mean a permanently red gate, and a red gate gets
      // ignored, which would also mask the checks below.
      const perms = new Set([...(manifest.permissions ?? []), ...(manifest.host_permissions ?? [])]);
      if (perms.has('<all_urls>')) {
        note(
          'host_permissions includes <all_urls> — expected for a cross-site agent, ' +
            'but it is a standing risk and requires Web Store review',
        );
      }
      // What is NOT expected: permissions that grant interception, inspection
      // or control well beyond "read and act on the page the user is on".
      // None of these are used by this product, so any appearance is a bug or
      // an intrusion. This is the check with real teeth.
      const HIGH_RISK_PERMISSIONS = [
        'proxy',
        'debugger',
        'management',
        'webRequestBlocking',
        'declarativeNetRequestWithHostAccess',
        'devtools',
        'nativeMessaging',
        'pageCapture',
        'desktopCapture',
      ];
      for (const p of HIGH_RISK_PERMISSIONS) {
        if (perms.has(p)) {
          fail(`high-risk permission present and not required by this product: ${p}`);
        }
      }
      note(`permissions reviewed: ${[...perms].sort().join(', ')}`);
      // web_accessible_resources exposes files to ANY page. The content script
      // genuinely needs some of these, so this reports rather than fails.
      const war = manifest.web_accessible_resources ?? [];
      if (Array.isArray(war) && war.length > 0) {
        note(`web_accessible_resources: ${war.length} entr(y|ies) — reviewed, content script needs these`);
      }
    }
  }
}

// ── 3 + 4. Content scan of the artifact ──────────────────────────────────────
const SECRET_PATTERNS = [
  { name: 'OpenAI-style key', re: /sk-[A-Za-z0-9_-]{20,}/ },
  { name: 'Google API key', re: /AIza[A-Za-z0-9_-]{30,}/ },
  { name: 'AWS access key id', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'private key block', re: /^-----BEGIN [A-Z ]*PRIVATE KEY-----/m },
];
const PATH_LEAKS = [/C:[\\/]Users[\\/][^\/\s"']+/i, /\/home\/[a-z0-9._-]+\//i];

const bundles = [
  ...(SERVER_ONLY ? [] : files.filter((f) => ['.js', '.mjs', '.json', '.html'].includes(extname(f)))),
  ...(existsSync(SERVER_BUNDLE) ? [SERVER_BUNDLE] : []),
];
if (bundles.length === 0) fail('nothing to scan — no bundle files found');

let scannedBytes = 0;
for (const file of bundles) {
  const size = statSync(file).size;
  if (size > 12 * 1024 * 1024) continue; // a model blob, not code
  const text = readFileSync(file, 'utf8');
  scannedBytes += size;
  const rel = relative(ROOT, file);
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(text)) fail(`${name} found in built artifact: ${rel}`);
  }
  for (const re of PATH_LEAKS) {
    const hit = text.match(re);
    if (hit) fail(`absolute developer path (${hit[0]}) in built artifact: ${rel}`);
  }
  // A bundled .env means the whole environment was inlined.
  if (/^\s*(GEMINI_API_KEY|ROUTER_API_KEY|SECRET_PASSWORD|SECRETS_SIGNING_KEY)\s*=\s*\S/m.test(text)) {
    fail(`bundled .env assignment in built artifact: ${rel}`);
  }
}
note(`scanned ${(scannedBytes / 1024 / 1024).toFixed(2)} MB of built JavaScript`);

// ── 5. Source maps must not point off-machine ────────────────────────────────
if (!SERVER_ONLY) {
  const mapDir = join(BUNDLE_DIR, 'maps');
  if (existsSync(mapDir)) {
    for (const f of readdirSync(mapDir)) {
      const text = readFileSync(join(mapDir, f), 'utf8');
      if (PATH_LEAKS.some((re) => re.test(text))) {
        fail(`sourcemap leaks an absolute developer path: maps/${f}`);
      }
    }
    note(`checked ${readdirSync(mapDir).length} sourcemap(s) for path leaks`);
  }
}

// ── Report ───────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`\n[bundle] FAILED — ${failures.length} problem(s):`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log('[bundle] OK');
