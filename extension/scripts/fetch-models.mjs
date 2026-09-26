/**
 * fetch-models.mjs — One-time downloader for local ML assets.
 *
 * Downloads MediaPipe WASM + model into extension/public/ so the extension can
 * load everything via browser.runtime.getURL(...) — no remote CDNs at runtime.
 *
 * ── FAILS CLOSED ───────────────────────────────────────────────────────────
 * This script used to have no integrity check at all. It fetched three assets
 * from jsdelivr and storage.googleapis.com over plain HTTPS and wrote whatever
 * came back into extension/public/, which is bundled into the shipped
 * extension. Two of the three are EXECUTABLE:
 *
 *     vision_wasm_internal.wasm — WebAssembly the extension instantiates
 *     vision_wasm_internal.js   — the loader that instantiates it
 *     face_landmarker.task      — a graph parsed at load
 *
 * So a compromised CDN, a poisoned mirror, or anything able to answer that
 * request could substitute a payload, and nothing would have noticed.
 *
 * It also failed OPEN on every error path — HTTP error, thrown fetch, and
 * success alike all just continued.
 *
 * Now:
 *   - every asset must have a pinned sha256 (scripts/modelIntegrity.mjs)
 *   - an asset with NO pin is REFUSED, not trusted
 *   - a digest mismatch DELETES the file and fails the run
 *   - any failure exits non-zero, and public/ is left clean
 *
 * A partially written or substituted model must never survive to be bundled.
 *
 * Idempotent: skips a file only if it is present AND matches its pin.
 * Run via: npm run fetch-models
 *
 * To upgrade MediaPipe legitimately: change the URL and re-pin in the SAME
 * commit (npm run fetch-models -- --update-pins prints the digests to paste).
 */
import { mkdir, writeFile, access, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveIntegrity, sha256Hex, explain } from './modelIntegrity.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const UPDATE_PINS = process.argv.includes('--update-pins');

/** @type {Array<{ url: string, dest: string }>} */
const ASSETS = [
  // MediaPipe Tasks Vision WASM runtime (v0.10.14)
  {
    url: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm/vision_wasm_internal.js',
    dest: 'public/mediapipe/wasm/vision_wasm_internal.js',
  },
  {
    url: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm/vision_wasm_internal.wasm',
    dest: 'public/mediapipe/wasm/vision_wasm_internal.wasm',
  },
  // MediaPipe FaceLandmarker model (float16)
  {
    url: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
    dest: 'public/mediapipe/face_landmarker.task',
  },
];

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetch one asset and install it ONLY if it matches its pin.
 *
 * Returns a result object rather than throwing, so main() can report every
 * failure in one run instead of stopping at the first — an operator fixing a
 * broken bootstrap wants the whole list, not one error at a time.
 */
async function downloadAsset({ url, dest }) {
  const absDest = join(ROOT, dest);

  // 1. Resolve the pin BEFORE spending a request. An unpinned asset is refused
  //    without touching the network at all.
  const pin = resolveIntegrity(dest);
  if (!pin.ok) {
    return { dest, ok: false, reason: pin.reason, detail: explain(pin) };
  }

  // 2. Idempotence, but only for a file that still matches its pin. The old
  //    version skipped on mere existence, so a corrupted or substituted file
  //    left behind by an earlier run was trusted forever.
  if (await fileExists(absDest)) {
    const { readFile } = await import('node:fs/promises');
    const existing = await readFile(absDest);
    const check = sha256Hex(existing) === pin.digest;
    if (check) {
      return { dest, ok: true, skipped: true, detail: 'already present and matches its pin' };
    }
    console.log(`  [stale] ${dest} exists but does NOT match its pin — refetching`);
  }

  console.log(`  [fetch] ${url}`);
  let buffer;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      // Fail closed. The old code warned and moved on, leaving the extension
      // silently missing a model it would fail to load at runtime.
      return { dest, ok: false, reason: 'http-error', detail: `HTTP ${res.status}` };
    }
    buffer = Buffer.from(await res.arrayBuffer());
  } catch (error) {
    return {
      dest,
      ok: false,
      reason: 'network-error',
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  // 3. Verify BEFORE writing. Writing first and checking afterwards would leave
  //    a window in which a bad file exists on disk.
  if (sha256Hex(buffer) !== pin.digest) {
    const actual = sha256Hex(buffer);
    // Make sure nothing partial is left behind for a later step to pick up.
    await rm(absDest, { force: true });
    if (UPDATE_PINS) {
      console.log(`  [pin]   ${dest}`);
      console.log(`           ${actual}`);
    }
    return {
      dest,
      ok: false,
      reason: 'digest-mismatch',
      detail: `expected ${pin.digest}, got ${actual}`,
    };
  }

  await mkdir(dirname(absDest), { recursive: true });
  await writeFile(absDest, buffer);
  return { dest, ok: true, detail: `${buffer.length} bytes, digest verified` };
}

async function main() {
  console.log('📦 fetch-models — downloading local ML assets (digest-verified)\n');

  /** @type {Array<{dest: string, ok: boolean, reason?: string, detail: string}>} */
  const results = [];
  for (const asset of ASSETS) {
    try {
      const r = await downloadAsset(asset);
      results.push(r);
      const mark = r.ok ? (r.skipped ? '[skip]' : '[ok]  ') : '[FAIL]';
      console.log(`  ${mark} ${r.dest} — ${r.detail}`);
    } catch (error) {
      // Still fail closed: an unexpected throw is a failure, not a warning.
      results.push({
        dest: asset.dest,
        ok: false,
        reason: 'unexpected',
        detail: error instanceof Error ? error.message : String(error),
      });
      console.log(`  [FAIL] ${asset.dest} — ${error instanceof Error ? error.message : error}`);
    }
  }

  const failed = results.filter((r) => !r.ok);
  const digests = results
    .filter((r) => r.reason === 'digest-mismatch')
    .map((r) => r.dest);

  if (digests.length > 0) {
    console.log(
      '\n⚠️  Digest mismatch. If this upgrade is intentional, re-pin in\n' +
        '    extension/scripts/modelIntegrity.mjs and commit the pin WITH the URL\n' +
        '    change. A pin that drifts from its asset is worse than no pin.',
    );
  }

  if (failed.length > 0) {
    console.error(`\n❌ ${failed.length} asset(s) failed verification. Nothing unverified was kept.`);
    if (UPDATE_PINS) {
      console.error('   Re-run without --update-pins once the pins are updated.');
    }
    process.exitCode = 1;
    return;
  }

  console.log('\n✅ fetch-models complete — every asset verified against its pinned digest.');
}

main();
