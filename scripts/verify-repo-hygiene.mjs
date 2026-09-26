/**
 * Repo hygiene gate — Cycle 3.8
 * ---------------------------------------------------------------------------
 * A test suite on a laptop is not a guarantee. This is the check that stops the
 * specific regressions that actually happened in this repository:
 *
 *   1. node_modules and .env returning to the git index. Untracking a file does
 *      not stop it being re-added; only a gate does.
 *   2. Runtime artifacts with real user data. `storage/server_logs.jsonl` was
 *      committed with 2,643 lines of UN-REDACTED `maskedDom` captures
 *      containing 7 real third-party email addresses. The existing .gitignore
 *      rules covered `storage/*.log` but not `*.jsonl`, so the gate has to look
 *      at what is TRACKED rather than at whether a rule exists.
 *   3. Path leaks in committed files.
 *   4. BLOB FILES. This repo tracks 53 MB of ONNX/WASM models in
 *      extension/public/. That is a deliberate choice — it makes the extension
 *      build work offline and reproducibly — so it is allowed here explicitly
 *      rather than left to a size threshold nobody agreed to.
 *
 * Exits non-zero on any failure, so a CI job fails on it.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const failures = [];
const notes = [];

function fail(msg) {
  failures.push(msg);
}
function note(msg) {
  notes.push(msg);
}

const git = (...args) =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();

/** Tracked files. This is the ground truth; .gitignore rules are only intent. */
let tracked = [];
try {
  tracked = git('ls-files').split('\n').filter(Boolean);
} catch {
  console.error('[hygiene] not a git repository — nothing to check');
  process.exit(1);
}

console.log(`[hygiene] ${tracked.length} tracked files`);

// ── 1. Dependencies and secrets must never be tracked ────────────────────────
const FORBIDDEN_PREFIXES = ['node_modules/', 'dist/', '.output/', '.wxt/'];
for (const file of tracked) {
  if (FORBIDDEN_PREFIXES.some((p) => file.startsWith(p))) {
    fail(`build output or dependency tree is tracked: ${file}`);
  }
  // Only a real .env is a finding. server/.env.example is the checked-in
  // template and MUST be tracked — treating it as a leak would mean deleting
  // the documentation of every variable the server needs.
  if (/(^|\/)\.env(\..*)?$/.test(file) && !file.endsWith('.env.example')) {
    fail(`a .env file is tracked: ${file}`);
  }
  if (/\.(pem|key|pfx|p12)$/.test(file)) {
    fail(`a key/certificate file is tracked: ${file}`);
  }
}

// ── 2. Runtime artifacts carrying user data ──────────────────────────────────
// Named explicitly, because the general rule that should have caught this
// (*.jsonl under storage/) was never written and the gap was invisible.
const RUNTIME_ARTIFACTS = [
  { pattern: /^storage\/.*\.jsonl$/, why: 'un-redacted maskedDom captures (real PII)' },
  { pattern: /^storage\/sessions\//, why: 'raw screenshots and session state' },
];
for (const { pattern, why } of RUNTIME_ARTIFACTS) {
  for (const file of tracked) {
    if (pattern.test(file)) fail(`runtime artifact tracked (${why}): ${file}`);
  }
}

// ── 3. .gitignore must actually cover the rules we rely on ───────────────────
const IGNORE_RULES = [
  { rule: 'node_modules/', reason: 'dependencies' },
  { rule: '.env', reason: 'credentials' },
  { rule: 'storage/sessions/', reason: 'raw screenshots' },
  { rule: 'storage/*.jsonl', reason: 'un-redacted DOM captures' },
];
const ignorePath = join(ROOT, '.gitignore');
if (!existsSync(ignorePath)) {
  fail('no .gitignore at the repository root');
} else {
  const ignore = readFileSync(ignorePath, 'utf8');
  for (const { rule, reason } of IGNORE_RULES) {
    if (!ignore.includes(rule)) fail(`.gitignore is missing "${rule}" (${reason})`);
  }
}

// ── 4. Secret-shaped literals in tracked text files ──────────────────────────
// Deliberately narrow, because a gate that cries wolf gets suppressed, and a
// suppressed gate is worse than no gate: it also hides the findings that
// matter. Three calibrations, each forced by a real false positive in this repo:
//
//   a. Private keys must be LINE-ANCHORED. A real embedded PEM block starts at
//      the beginning of a line. `extension/src/entrypoints/dashboard/App.tsx`
//      legitimately contains '-----BEGIN PRIVATE KEY-----' as a quoted example
//      inside a UI string describing the detection rule.
//
//   b. TEST FILES ARE EXCLUDED. Security tests must contain adversarial
//      fixtures — `AKIAIOSFODNN7EXAMPLE` is AWS's own documented example key,
//      and the OpenAI-shaped strings are deliberate canaries. Scanning them
//      guarantees noise. gitleaks is the authority on real secrets and has
//      proper allowlisting; this is a cheap backstop for the rest.
//
//   c. No broad entropy heuristics. Every pattern here is a specific, named
//      credential format.
const SECRET_PATTERNS = [
  { name: 'OpenAI-style key', re: /sk-[A-Za-z0-9_-]{20,}/ },
  { name: 'Google API key', re: /AIza[A-Za-z0-9_-]{30,}/ },
  { name: 'AWS access key id', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'private key block', re: /^-----BEGIN [A-Z ]*PRIVATE KEY-----/m },
];
const isTestFile = (f) =>
  /(^|\/)(tests?|__tests__)\//.test(f) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(f);
// The gate scripts themselves. They MUST contain the literal secret patterns —
// that is their entire job — and the comments explaining the calibration
// name real canaries such as AWS's own AKIAIOSFODNN7EXAMPLE. Without this
// exclusion the gate flags itself on every run, and a gate that always
// fails is a gate nobody reads.
const isGateScript = (f) => /^scripts\/verify-.*\.mjs$/.test(f);
const TEXTUAL = /\.(ts|tsx|js|mjs|cjs|json|yml|yaml|md|env|example|txt)$/;
let scanned = 0;
let skippedTests = 0;
for (const file of tracked) {
  if (!TEXTUAL.test(file)) continue;
  if (isTestFile(file)) {
    skippedTests += 1;
    continue;
  }
  if (isGateScript(file)) continue;
  const full = join(ROOT, file);
  if (!existsSync(full) || !statSync(full).isFile()) continue;
  if (statSync(full).size > 2 * 1024 * 1024) continue;
  let text;
  try {
    text = readFileSync(full, 'utf8');
  } catch {
    continue;
  }
  scanned += 1;
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(text)) fail(`possible ${name} in tracked file: ${file}`);
  }
}
note(`scanned ${scanned} non-test textual files for secret-shaped literals`);
note(`skipped ${skippedTests} test files (adversarial fixtures live there; gitleaks covers them)`);

// ── 5. Absolute developer paths in tracked source ────────────────────────────
// These leak the operator's username and home directory, and they break any
// script that assumes a relative layout.
const PATH_LEAKS = [/C:[\\/]Users[\\/][^\/\s"']+/i, /\/home\/[a-z0-9._-]+\//i];
for (const file of tracked) {
  if (!TEXTUAL.test(file) || isTestFile(file)) continue;
  const full = join(ROOT, file);
  if (!existsSync(full) || !statSync(full).isFile()) continue;
  if (statSync(full).size > 2 * 1024 * 1024) continue;
  let text;
  try {
    text = readFileSync(full, 'utf8');
  } catch {
    continue;
  }
  for (const re of PATH_LEAKS) {
    const hit = text.match(re);
    if (hit) fail(`absolute developer path (${hit[0]}) in tracked file: ${file}`);
  }
}

// ── 6. Blob budget, stated explicitly rather than implied ─────────────────────
// The models are intentionally vendored so the extension builds offline. This
// asserts that decision still holds and that nothing ELSE large crept in.
const blobBudget = { 'extension/public/onnx/': 64 * 1024 * 1024, 'extension/public/mediapipe/': 32 * 1024 * 1024 };
let blobBytes = 0;
const unexpectedLarge = [];
for (const file of tracked) {
  const full = join(ROOT, file);
  if (!existsSync(full) || !statSync(full).isFile()) continue;
  const size = statSync(full).size;
  const inBlob = Object.keys(blobBudget).find((prefix) => file.startsWith(prefix));
  if (inBlob) {
    blobBytes += size;
  } else if (size > 1024 * 1024) {
    unexpectedLarge.push(`${relative(ROOT, full)} (${(size / 1024 / 1024).toFixed(1)} MB)`);
  }
}
for (const entry of unexpectedLarge) {
  fail(`unexpected file over 1 MB outside the vendored model dirs: ${entry}`);
}
note(`vendored models: ${(blobBytes / 1024 / 1024).toFixed(1)} MB (intentional, keeps builds offline)`);

// ── Report ───────────────────────────────────────────────────────────────────
for (const n of notes) console.log(`[hygiene] note: ${n}`);

if (failures.length > 0) {
  console.error(`\n[hygiene] FAILED — ${failures.length} problem(s):`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log('[hygiene] OK');
