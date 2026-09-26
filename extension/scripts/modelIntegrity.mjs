/**
 * Model integrity — Cycle 3.9
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * `fetch-models.mjs` downloaded three assets from jsdelivr and
 * storage.googleapis.com and wrote whatever came back into `extension/public/`,
 * which is bundled into the shipped extension. Two of the three are executable:
 *
 *   vision_wasm_internal.wasm — WebAssembly the extension instantiates
 *   vision_wasm_internal.js   — the loader that instantiates it
 *   face_landmarker.task      — a graph parsed at load
 *
 * There was no digest to compare against, so a compromised CDN, a poisoned
 * mirror, or anything able to answer that HTTPS request could substitute a
 * payload and the extension would load it without anything noticing.
 *
 * THE ACTUAL HOLE IS NOT A MISSING CHECK, IT IS A MISSING PIN
 *
 * The obvious bug is "no digest is verified". The subtler one is what happens
 * when a digest is *absent*. If `expected === undefined` quietly means "trust
 * me", then adding one URL to a list is enough to get an unverified binary
 * installed — and it looks like a normal code change. So an asset with no
 * pinned digest is REFUSED. "I do not know what this should be" and "this is
 * fine" are different answers.
 *
 * Re-pinning is a real, necessary operation when MediaPipe ships a new
 * version, so `resolveIntegrity` accepts an explicit override. It has to be
 * passed deliberately; it cannot happen by accident.
 *
 * Pure and dependency-free apart from node:crypto, so it is testable without a
 * network, a filesystem, or a running extension.
 *
 * The digests below were computed from the copies already vendored in this
 * repository, so they describe the bytes this extension really ships — and a
 * test re-verifies that on every run, so the pins cannot silently rot.
 */
import { createHash } from 'node:crypto';

/**
 * dest path -> pinned sha256 (hex).
 *
 * If you legitimately upgrade MediaPipe, update the pin in the SAME commit
 * that changes the URL. A pin that drifts from the asset it describes is worse
 * than no pin, because it looks like verification.
 */
/** @type {Record<string, string>} */
export const ASSET_MANIFEST = {
  'public/mediapipe/wasm/vision_wasm_internal.js':
    '9440cf0cc0cea21800e31581ec32aeedcc5fbf9df4509796bbc7d3f99e52ab9c',
  'public/mediapipe/wasm/vision_wasm_internal.wasm':
    'f82a8e6c05e08a44cc9f9e7ec5f845935bcbb1b1500ebe8c2f4812fb4e2917dc',
  'public/mediapipe/face_landmarker.task':
    '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff',
};

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * @typedef {'ok'|'no-digest-pinned'|'malformed-digest'|'digest-mismatch'} VerdictReason
 * @typedef {{ ok: boolean, reason: VerdictReason, actual: string, expected: string|null }} IntegrityVerdict
 */

/** sha256 of a buffer, lowercase hex. */
/** @param {Buffer|Uint8Array|string} input @returns {string} */
export function sha256Hex(input) {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input);
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Compare bytes against a pinned digest.
 *
 * Fails closed in every uncertain case. A malformed expected value is a
 * REFUSAL, not a wildcard — otherwise a 3-character "digest" would match
 * anything and the check would pass while proving nothing.
 */
export function verifyBuffer(input, expected) {
  const actual = sha256Hex(input);

  if (expected === undefined || expected === null || expected === '') {
    return { ok: false, reason: 'no-digest-pinned', actual, expected: null };
  }
  if (typeof expected !== 'string' || !HEX64.test(expected)) {
    return { ok: false, reason: 'malformed-digest', actual, expected: null };
  }
  if (actual !== expected) {
    return { ok: false, reason: 'digest-mismatch', actual, expected };
  }
  return { ok: true, reason: 'ok', actual, expected };
}

/**
 * Decide which digest a given destination must satisfy.
 *
 * `override` exists for deliberate re-pinning. It is a parameter rather than
 * an env var read deep inside the download loop so that "why is this trusted"
 * is always visible at the call site.
 */
export function resolveIntegrity(dest, override) {
  if (override !== undefined) {
    if (typeof override !== 'string' || !HEX64.test(override)) {
      return { ok: false, reason: 'malformed-digest', digest: null };
    }
    return { ok: true, reason: 'ok', digest: override };
  }

  const pinned = ASSET_MANIFEST[dest];
  if (!pinned) {
    // Refuse. See the header: absent is not the same as trusted.
    return { ok: false, reason: 'no-digest-pinned', digest: null };
  }
  if (!HEX64.test(pinned)) {
    return { ok: false, reason: 'malformed-digest', digest: null };
  }
  return { ok: true, reason: 'ok', digest: pinned };
}

/** Human-readable explanation for a refusal, used by the downloader. */
export function explain(verdict) {
  switch (verdict.reason) {
    case 'digest-mismatch':
      return 'digest mismatch — the downloaded bytes are not the bytes we pinned';
    case 'malformed-digest':
      return 'the pinned digest is malformed, so nothing can be verified against it';
    case 'no-digest-pinned':
      return 'no digest is pinned for this asset, so it cannot be trusted';
    default:
      return 'ok';
  }
}
