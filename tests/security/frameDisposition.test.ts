/**
 * Cycle 1.2 — Redaction provenance: classify a verification outcome into a
 * disposition the capture pipeline can act on.
 * ---------------------------------------------------------------------------
 * WHY A DISPOSITION LAYER
 *
 * Cycle 1.1 made the verifier fail closed when detection never ran. But it
 * cannot distinguish two very different situations:
 *
 *   1. A genuine leak   — a coverage gap, residual plaintext PII, a
 *                         low-confidence region. The frame contains data that
 *                         should not have left the machine. BLOCK IT.
 *   2. An unknown frame — detection never ran, so we have no evidence either
 *                         way. Nothing is proven to be leaking, but nothing is
 *                         proven safe either. RELEASE AS DEGRADED, AND SAY SO.
 *
 * Treating both as "throw" (Cycle 1.1 alone) is correct-but-useless: the
 * background's capture fallback then substitutes a raw un-redacted frame into
 * the field named `redactedImage`, unlabelled. Treating both as "release" is
 * the original bug. This module is the seam between them.
 *
 * Breaks caught here:
 *   - a real leak being downgraded to a degraded release (catastrophic)
 *   - an unknown frame being blocked (breaks the product for no safety gain)
 *   - the distinction collapsing back into one boolean
 */
import { describe, it, expect } from 'vitest';
import {
  runSecurityBoundaryVerification,
  classifyVerification,
  type SensitiveRegion,
  type RedactedRegion,
  type SanitizedDomElement,
  type DetectionAvailability,
  type VerificationResult,
} from '@/utils/leakVerifier';

const DETECTION_RAN: DetectionAvailability = { detectionAvailable: true };
const DETECTION_DOWN: DetectionAvailability = {
  detectionAvailable: false,
  reason: 'MediaPipe FaceLandmarker is degraded (model/WASM unavailable).',
};

const NO_REGIONS: SensitiveRegion[] = [];
const NO_REDACTIONS: RedactedRegion[] = [];
const CLEAN_DOM: SanitizedDomElement[] = [
  { id: 'agent-1', tag: 'div', text: 'Orbital mechanics reference table' },
];

const ONE_FACE: SensitiveRegion[] = [
  { id: 'face_1', type: 'FACE', text: '', bbox: [100, 100, 200, 200], confidence: 0.99 },
];
const ONE_MASK: RedactedRegion[] = [
  { id: 'face_1', type: 'face', paddedBbox: [90, 90, 220, 220] },
];
const UNDERSIZED_MASK: RedactedRegion[] = [
  { id: 'face_1', type: 'face', paddedBbox: [150, 150, 20, 20] },
];

// The exact marker the verifier emits for an availability failure. Matched by
// prefix so a reworded message cannot silently turn a degraded frame into a
// block (or vice versa) without a test noticing.
const UNAVAILABLE_PREFIX = 'Detection unavailable:';

function verify(
  detected: SensitiveRegion[],
  redacted: RedactedRegion[],
  dom: SanitizedDomElement[],
  availability: DetectionAvailability
): VerificationResult {
  return runSecurityBoundaryVerification(detected, redacted, dom, 0.85, availability);
}

describe('Cycle 1.2 — frame disposition', () => {
  it('releases a verified frame', () => {
    // BREAK: the happy path stops being releasable.
    const result = verify(ONE_FACE, ONE_MASK, CLEAN_DOM, DETECTION_RAN);
    expect(classifyVerification(result)).toBe('release-verified');
  });

  it('releases a degraded frame when detection simply never ran', () => {
    // BREAK: over-blocking. A frame we could not scan is not a frame we proved
    // leaky — it must still be usable, just labelled.
    const result = verify(NO_REGIONS, NO_REDACTIONS, CLEAN_DOM, DETECTION_DOWN);
    expect(classifyVerification(result)).toBe('release-degraded');
  });

  it('blocks a frame with a geometric coverage gap', () => {
    // BREAK: a real, proven leak being waved through as merely degraded. This
    // is the single most important assertion in the file.
    const result = verify(ONE_FACE, UNDERSIZED_MASK, CLEAN_DOM, DETECTION_RAN);
    expect(classifyVerification(result)).toBe('block');
  });

  it('blocks a frame carrying residual plaintext PII', () => {
    // BREAK: plaintext sweep being downgraded to a warning.
    const leakyDOM: SanitizedDomElement[] = [
      { id: 'agent-9', tag: 'div', text: 'Aadhaar 2345 6789 0123' },
    ];
    const result = verify(NO_REGIONS, NO_REDACTIONS, leakyDOM, DETECTION_RAN);
    expect(classifyVerification(result)).toBe('block');
  });

  it('blocks a low-confidence detected region', () => {
    // BREAK: the confidence threshold being bypassed by a later refactor.
    const lowConfidence: SensitiveRegion[] = [
      { id: 'face_1', type: 'FACE', text: '', bbox: [100, 100, 200, 200], confidence: 0.4 },
    ];
    const result = verify(lowConfidence, ONE_MASK, CLEAN_DOM, DETECTION_RAN);
    expect(classifyVerification(result)).toBe('block');
  });

  it('blocks when detection was down AND a real leak is also present', () => {
    // BREAK: availability short-circuiting the leak checks. A frame that both
    // went unscanned and shows a coverage gap must block, not degrade.
    const result = verify(ONE_FACE, UNDERSIZED_MASK, CLEAN_DOM, DETECTION_DOWN);
    expect(classifyVerification(result)).toBe('block');
  });

  it('treats detection-down with a clean DOM and no regions as degraded, not blocked', () => {
    // BREAK: the inverse error — refusing to distinguish these two.
    const result = verify(NO_REGIONS, NO_REDACTIONS, CLEAN_DOM, DETECTION_DOWN);
    expect(result.detectionCheck.available).toBe(false);
    expect(result.jsonSanitizationCheck.rawPIIFound).toBe(false);
    expect(result.coverageCheck.passed).toBe(true);
    expect(classifyVerification(result)).toBe('release-degraded');
  });

  it('does not treat an engine-reported-not-loaded frame as verified', () => {
    // BREAK: engineLoaded:false being treated as a pass because
    // detectionAvailable was true.
    const result = verify(ONE_FACE, ONE_MASK, CLEAN_DOM, {
      detectionAvailable: true,
      engineLoaded: false,
    });
    expect(classifyVerification(result)).toBe('release-degraded');
  });

  it('releases a frame where detection ran and legitimately found nothing', () => {
    // BREAK: a genuinely clean page being labelled degraded — would generate
    // false operator alarms and erode trust in the signal.
    const result = verify(NO_REGIONS, NO_REDACTIONS, CLEAN_DOM, DETECTION_RAN);
    expect(result.detectionCheck.state).toBe('clean');
    expect(classifyVerification(result)).toBe('release-verified');
  });
});

describe('Cycle 1.2 — disposition is driven by violations, not by the passed flag alone', () => {
  it('blocks whenever a violation exists that is not the availability marker', () => {
    // BREAK: a future refactor that rewords the availability message, breaking
    // prefix matching and silently converting degraded frames into blocks.
    // This pins the contract: any non-availability violation means block.
    const result = verify(ONE_FACE, UNDERSIZED_MASK, CLEAN_DOM, DETECTION_RAN);

    const nonAvailability = result.jsonSanitizationCheck.violations.filter(
      (v) => !v.startsWith(UNAVAILABLE_PREFIX)
    );
    expect(nonAvailability.length).toBeGreaterThan(0);
    expect(classifyVerification(result)).toBe('block');
  });

  it('releases degraded only when the availability marker is the sole violation', () => {
    // BREAK: the precise condition for 'release-degraded'. If detection down
    // adds any other violation, the frame is no longer merely unknown.
    const result = verify(NO_REGIONS, NO_REDACTIONS, CLEAN_DOM, DETECTION_DOWN);

    const violations = result.jsonSanitizationCheck.violations;
    expect(violations.length).toBe(1);
    expect(violations[0].startsWith(UNAVAILABLE_PREFIX)).toBe(true);
    expect(classifyVerification(result)).toBe('release-degraded');
  });
});
