/**
 * Cycle 1.1 — `detectionAvailable`: an empty detection result is an UNKNOWN,
 * not a clean bill of health.
 * ---------------------------------------------------------------------------
 * THE BUG (finding N1)
 *
 * `runSecurityBoundaryVerification` derives its verdict from the detection map
 * alone:
 *
 *     coverageCheckPassed = coveredCount === detectionMap.length
 *     passed = coverageCheckPassed && !rawPIIFound && violations.length === 0
 *
 * When the ML engines fail to load, `detectAndBlurFaces` / `detectUIElements`
 * return `[]`. The verifier then compares `0 === 0`, coverage "passes", and the
 * whole conjunction evaluates to `passed: true` — so an image that was NEVER
 * scanned is certified as verified, and the un-redacted frame is released to
 * the outbound path.
 *
 * Detection reporting nothing and detection being broken are indistinguishable
 * today. This test file makes them distinguishable.
 *
 * Breaks caught here:
 *   - the vacuous empty-map pass (the actual vulnerability)
 *   - a future refactor that reintroduces "no regions == nothing to check"
 *   - callers treating `unavailable` as `passed`
 */
import { describe, it, expect } from 'vitest';
import {
  runSecurityBoundaryVerification,
  type SensitiveRegion,
  type RedactedRegion,
  type SanitizedDomElement,
  type DetectionAvailability,
} from '@/utils/leakVerifier';

// ── Hand-derived fixtures (never computed by the code under test) ──
// A page with no sensitive content at all. No placeholders, nothing to mask.
const CLEAN_DOM: SanitizedDomElement[] = [
  { id: 'agent-1', tag: 'div', text: 'Orbital mechanics reference table' },
  { id: 'agent-2', tag: 'span', text: 'Launch window: Q3' },
];

const NO_REGIONS: SensitiveRegion[] = [];
const NO_REDACTIONS: RedactedRegion[] = [];

// A genuinely detected-and-masked region, used to prove that a populated
// map is unaffected by the availability signal.
const ONE_FACE: SensitiveRegion[] = [
  { id: 'face_1', type: 'FACE', text: '', bbox: [100, 100, 200, 200], confidence: 0.99 },
];
const ONE_MASK: RedactedRegion[] = [
  { id: 'face_1', type: 'face', paddedBbox: [90, 90, 220, 220] },
];

describe('Cycle 1.1 — detection availability is distinguishable from a clean scan', () => {
  it('reports unverified when detection did not run and the region list is empty', () => {
    // BREAK: someone removes the availability guard, or defaults it to
    // "available" when the caller forgets to pass it. Today this returns
    // passed:true because 0 === 0.
    const result = runSecurityBoundaryVerification(
      NO_REGIONS,
      NO_REDACTIONS,
      CLEAN_DOM,
      0.85,
      { detectionAvailable: false }
    );

    expect(result.detectionCheck.available).toBe(false);
    expect(result.detectionCheck.state).toBe('unavailable');
    expect(result.passed).toBe(false);
    expect(result.reasons.join('; ')).toMatch(/detection/i);
  });

  it('distinguishes unavailable from clean for identical empty inputs', () => {
    // BREAK: the core distinction this whole cycle exists for. If both
    // branches collapse to the same verdict the signal is useless.
    const unavailable = runSecurityBoundaryVerification(
      NO_REGIONS,
      NO_REDACTIONS,
      CLEAN_DOM,
      0.85,
      { detectionAvailable: false }
    );
    const clean = runSecurityBoundaryVerification(
      NO_REGIONS,
      NO_REDACTIONS,
      CLEAN_DOM,
      0.85,
      { detectionAvailable: true }
    );

    // Same inputs, opposite meaning.
    expect(unavailable.passed).toBe(false);
    expect(clean.passed).toBe(true);

    expect(unavailable.detectionCheck.state).not.toBe(clean.detectionCheck.state);
  });

  it('reports passed when detection ran and legitimately found nothing', () => {
    // BREAK: over-correction. Failing closed on a genuinely clean page would
    // break every real run — this guards against that regression.
    const result = runSecurityBoundaryVerification(
      NO_REGIONS,
      NO_REDACTIONS,
      CLEAN_DOM,
      0.85,
      { detectionAvailable: true }
    );

    expect(result.detectionCheck.state).toBe('clean');
    expect(result.passed).toBe(true);
  });

  it('reports unverified when detection was requested but produced no regions on an image-bearing step', () => {
    // BREAK: a caller that hardcodes `detectionAvailable: true` to make the
    // error go away. Availability must reflect the engine, not the caller's
    // intent — an engine that reports "loaded" but yields zero detections on a
    // screenshot is still not trustworthy evidence.
    const result = runSecurityBoundaryVerification(
      NO_REGIONS,
      NO_REDACTIONS,
      CLEAN_DOM,
      0.85,
      { detectionAvailable: true, engineLoaded: false }
    );

    expect(result.detectionCheck.state).toBe('unavailable');
    expect(result.passed).toBe(false);
  });

  it('keeps a populated, fully covered detection passing regardless of availability flag', () => {
    // BREAK: the availability check being applied so bluntly that it overrides
    // real geometric proof. A verified face mask must still pass.
    const result = runSecurityBoundaryVerification(
      ONE_FACE,
      ONE_MASK,
      CLEAN_DOM,
      0.85,
      { detectionAvailable: true }
    );

    expect(result.detectionCheck.state).toBe('detected');
    expect(result.coverageCheck.passed).toBe(true);
    expect(result.passed).toBe(true);
  });

  it('still fails closed on a coverage gap when detection was available', () => {
    // BREAK: the new branch accidentally short-circuiting the existing
    // geometric enclosure proof.
    const tooSmall: RedactedRegion[] = [
      { id: 'face_1', type: 'face', paddedBbox: [150, 150, 20, 20] },
    ];

    const result = runSecurityBoundaryVerification(
      ONE_FACE,
      tooSmall,
      CLEAN_DOM,
      0.85,
      { detectionAvailable: true }
    );

    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('Coverage gap'))).toBe(true);
  });

  it('still fails closed on residual plaintext when detection was available', () => {
    // BREAK: the plaintext sweep being bypassed by the new early return.
    const leakyDOM: SanitizedDomElement[] = [
      { id: 'agent-9', tag: 'div', text: 'Aadhaar 2345 6789 0123' },
    ];

    const result = runSecurityBoundaryVerification(
      NO_REGIONS,
      NO_REDACTIONS,
      leakyDOM,
      0.85,
      { detectionAvailable: true }
    );

    expect(result.jsonSanitizationCheck.rawPIIFound).toBe(true);
    expect(result.passed).toBe(false);
  });

  it('reports unavailable before evaluating an empty detection map', () => {
    // BREAK: ordering. The availability verdict must be present on the result
    // even when every other check trivially passes, because a caller decides
    // whether to block based on `detectionCheck`, not on `reasons`.
    const result = runSecurityBoundaryVerification(
      NO_REGIONS,
      NO_REDACTIONS,
      CLEAN_DOM,
      0.85,
      { detectionAvailable: false }
    );

    expect(result.detectionCheck.available).toBe(false);
    expect(result.detectionCheck.reason).toBeTruthy();
    expect(result.coverageCheck.totalSensitive).toBe(0);
  });

  it('treats a missing availability argument as unknown rather than available', () => {
    // BREAK: a default of `true`. Omitting the signal must not silently
    // restore the vacuous pass — it must fail safe.
    const result = runSecurityBoundaryVerification(
      NO_REGIONS,
      NO_REDACTIONS,
      CLEAN_DOM,
      0.85
    );

    expect(result.detectionCheck.available).toBe(false);
    expect(result.passed).toBe(false);
  });

  it('rejects a malformed availability argument instead of trusting it', () => {
    // BREAK: coercion games. `detectionAvailable: 'yes'` must not be truthy-
    // coerced into a pass.
    const bogus = { detectionAvailable: 'yes' } as unknown as DetectionAvailability;

    const result = runSecurityBoundaryVerification(
      NO_REGIONS,
      NO_REDACTIONS,
      CLEAN_DOM,
      0.85,
      bogus
    );

    expect(result.detectionCheck.available).toBe(false);
    expect(result.passed).toBe(false);
  });
});
