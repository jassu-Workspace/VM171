/**
 * Cycle 3.9 follow-up — model downloads must fail CLOSED on digest mismatch.
 * ---------------------------------------------------------------------------
 * THE DEFECT
 *
 * `extension/scripts/fetch-models.mjs` downloaded three binary assets from a
 * public CDN and jsdelivr over plain HTTPS with **no integrity check at all**,
 * then wrote whatever bytes came back into `extension/public/` — which is
 * bundled straight into the shipped extension.
 *
 * Two of the three are executable:
 *
 *   vision_wasm_internal.wasm   — WebAssembly, instantiated by the extension
 *   vision_wasm_internal.js     — the loader that instantiates it
 *   face_landmarker.task        — a model graph parsed at load
 *
 * So a compromised CDN, a poisoned mirror, or anything able to answer that
 * HTTPS request could substitute a payload and the extension would load it.
 * There was no digest to compare against, so there was nothing to notice.
 *
 * WORSE, IT FAILED OPEN. Three separate paths all carried on regardless:
 *
 *   - HTTP not ok      -> warn, continue
 *   - fetch threw      -> warn, continue
 *   - write succeeded  -> done, no verification at any point
 *
 * The Definition of Done required "model downloads fail closed on digest
 * mismatch". That was never implemented. `grep -c sha256 fetch-models.mjs`
 * returned 0.
 *
 * THE FIX
 *
 * Digests are pinned in a manifest, and an asset with no pinned digest is
 * REFUSED rather than trusted. "I do not know what this should be" and "this is
 * fine" are different answers, and collapsing them is the actual hole.
 *
 * A mismatch is not a warning. The file is removed, the exit code is non-zero,
 * and `public/` is left clean — a half-written or substituted model must never
 * survive to be bundled.
 *
 * The digests below were computed from the copies already vendored in this
 * repository, so they are the real bytes the extension ships today.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  sha256Hex,
  verifyBuffer,
  resolveIntegrity,
  ASSET_MANIFEST,
} from '../../extension/scripts/modelIntegrity.mjs';

// Typed loosely on purpose: the module under test is plain ESM (it is run
// directly by node), so it carries JSDoc types rather than TypeScript ones and
// there is nothing to import structurally here.
interface IntegrityVerdict {
  ok: boolean;
  reason: string;
  actual: string;
  expected: string | null;
}

const EXT = join(process.cwd(), '..', 'extension');

describe('Cycle 3.9 — digest verification is real', () => {
  it('computes the same digest as sha256sum', () => {
    // BREAK: a hand-rolled or wrong hash function. Derived by hand from a
    // known vector rather than by calling the code under test.
    expect(sha256Hex(Buffer.from(''))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex(Buffer.from('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('accepts a matching digest', () => {
    // BREAK: a verifier that rejects everything is technically "secure".
    const v = verifyBuffer(Buffer.from('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(v.ok).toBe(true);
  });

  it('rejects a mismatched digest', () => {
    const v = verifyBuffer(Buffer.from('abc'), 'f'.repeat(64));
    expect(v.ok).toBe(false);
  });

  it('never reports ok when the expected digest is absent', () => {
    // BREAK: the actual hole. "No digest known" silently becoming "trusted" is
    // how an unpinned asset gets in.
    const v = verifyBuffer(Buffer.from('abc'), undefined);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('no-digest-pinned');
  });

  it('rejects a malformed digest rather than comparing garbage', () => {
    // BREAK: a 3-character expected value "matching" because both sides are
    // truncated to nothing.
    for (const bad of ['', 'abc', 'z'.repeat(64), 'A'.repeat(63)]) {
      expect(verifyBuffer(Buffer.from('abc'), bad).ok, bad).toBe(false);
    }
  });
});

describe('Cycle 3.9 — the pinned digests match what the repo actually ships', () => {
  it('every manifest entry pins a well-formed sha256', () => {
    for (const [dest, digest] of Object.entries(ASSET_MANIFEST)) {
      expect(digest, dest).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('every vendored asset verifies against its pinned digest', () => {
    // This is the assertion that matters most: it proves the pins describe the
    // bytes this extension really loads, not a value copied from somewhere.
    let checked = 0;
    for (const [dest, digest] of Object.entries(ASSET_MANIFEST)) {
      const full = join(EXT, dest);
      if (!existsSync(full)) continue;
      const actual = sha256Hex(readFileSync(full));
      expect(actual, `${dest} does not match its pinned digest`).toBe(digest);
      checked += 1;
    }
    // BREAK: vacuous pass — every file "missing", so the loop checked nothing.
    expect(checked, 'no vendored assets were actually verified').toBeGreaterThan(0);
  });

  it('catches a single flipped byte', () => {
    // BREAK: a comparison loose enough to tolerate corruption.
    const real = readFileSync(join(EXT, 'public/mediapipe/face_landmarker.task'));
    const tampered = Buffer.from(real);
    tampered[0] ^= 0xff;
    const v: IntegrityVerdict = verifyBuffer(tampered, ASSET_MANIFEST['public/mediapipe/face_landmarker.task']);
    expect(v.ok).toBe(false);
  });
});

describe('Cycle 3.9 — unpinned assets are refused, not trusted', () => {
  it('refuses an asset with no pinned digest', () => {
    // BREAK: a permissive default that lets new assets through unverified.
    const r = resolveIntegrity('public/mediapipe/something-new.task');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no-digest-pinned');
  });

  it('accepts a legitimate re-pin, and only for an explicit override', () => {
    // Re-pinning is a real, necessary operation when MediaPipe ships a new
    // version. It has to be possible — but explicit, so it cannot happen by
    // accident when someone adds a URL.
    const r = resolveIntegrity('public/mediapipe/wasm/vision_wasm_internal.wasm');
    expect(r.ok).toBe(true);

    const overridden = resolveIntegrity(
      'public/mediapipe/wasm/vision_wasm_internal.wasm',
      'f'.repeat(64),
    );
    expect(overridden.ok).toBe(true);
    expect(overridden.digest).toBe('f'.repeat(64));
  });
});
