/**
 * Cycle 1.3 — Capture provenance: keep the outbound and archival channels apart.
 * ---------------------------------------------------------------------------
 * CORRECTION TO AN EARLIER AUDIT CLAIM
 *
 * An earlier audit reported a CRITICAL leak here: that the "Bulletproof
 * Capture" fallback assigned a raw un-redacted `captureVisibleTab` frame to
 * `redactedImage`. That claim was WRONG. Verified against the source:
 *
 *   - the fallback assigns to `rawImage`  (background/index.ts:917)
 *   - on redaction failure `redactedImage` is forced to `''`  (:932)
 *   - `const vlmImage = redactedImage || ''`  (:937)
 *
 * So the original code never sent an un-redacted frame; it degraded to a
 * DOM-only step. The leak was in the AUDIT, not the code.
 *
 * This cycle still earns its place, for two real reasons:
 *   1. The separation between "frame to send" and "frame to archive" was
 *      implicit, spread across ~50 lines, and inferred from variable NAMES.
 *      It is now one tested pure function.
 *   2. When redaction fails the step goes DOM-only SILENTLY apart from one log
 *      line. An operator has no running signal that a run lost its visual
 *      channel. `redactionState` + `degradedReason` make that observable.
 *
 * The critical property pinned below is that a raw capture can NEVER occupy
 * the outbound slot. A first draft of `captureProvenance.ts` violated this,
 * which is why the test asserts `image === null` rather than trusting the
 * module's own docstring.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resolveCaptureSource, type CaptureResolution } from '@/utils/captureProvenance';

const DATA_URL = 'data:image/jpeg;base64,AAAA';
const RAW_DATA_URL = 'data:image/png;base64,BBBB';
const PNG_DATA_URL = 'data:image/png;base64,CCCC';

function contentScriptOk(overrides: Partial<Parameters<typeof resolveCaptureSource>[0]> = {}) {
  return {
    ok: true as const,
    image: DATA_URL,
    rawImage: RAW_DATA_URL,
    legend: [{ id: 'R1', type: 'human_face', bbox: [1, 2, 3, 4] }],
    redaction: {
      state: 'verified' as const,
      engine: 'mediapipe' as const,
      degradedAt: null,
      reason: 'Face detection live; 1 redaction(s) applied.',
      violations: [] as string[],
    },
    ...overrides,
  };
}

function contentScriptFailed(reason = 'FAIL_CLOSED_VERIFICATION_ERROR: coverage gap') {
  return { ok: false as const, reason };
}

function directCaptureAvailable(available: boolean) {
  return { available, capture: available ? PNG_DATA_URL : null };
}

describe('Cycle 1.3 — capture provenance', () => {
  let now: string;
  beforeEach(() => {
    now = '2026-09-26T00:00:00.000Z';
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
  });

  it('keeps the content script frame and its verified provenance when it succeeds', () => {
    // BREAK: provenance being dropped on the happy path, forcing the consumer
    // to guess. Cycle 1.2's envelope must survive to the background.
    const res = resolveCaptureSource({
      contentScript: contentScriptOk(),
      direct: directCaptureAvailable(true),
      now: () => now,
    }) as CaptureResolution;

    expect(res.source).toBe('content-script');
    // Prefix-stripped: the server re-attaches `data:image/jpeg;base64,` itself.
    expect(res.image).toBe('AAAA');
    expect(res.redactionState).toBe('verified');
    expect(res.degradedAt).toBeNull();
  });

  it('marks a verified frame from the content script as verified even with a non-empty legend', () => {
    // BREAK: "has a legend" being used as a proxy for "was verified".
    const res = resolveCaptureSource({
      contentScript: contentScriptOk(),
      direct: directCaptureAvailable(true),
      now: () => now,
    }) as CaptureResolution;

    expect(res.legend.length).toBe(1);
    expect(res.redactionState).toBe('verified');
  });

  it('never places an un-redacted fallback capture in the outbound image slot', () => {
    // BREAK: THE CRITICAL PROPERTY. `image` is what reaches the AI provider.
    // A raw captureVisibleTab frame has had no mask pipeline applied, so it
    // must be null here and confined to `archivalImage`.
    //
    // NOTE: an earlier draft of captureProvenance returned the raw capture as
    // `image`, which would have introduced exactly the leak this project
    // exists to prevent. The original background code did NOT have this bug —
    // it forced `redactedImage` empty and went DOM-only.
    const res = resolveCaptureSource({
      contentScript: contentScriptFailed(),
      direct: directCaptureAvailable(true),
      now: () => now,
    }) as CaptureResolution;

    expect(res.source).toBe('direct-capture-fallback');
    expect(res.image).toBeNull();
    expect(res.archivalImage).toBe('CCCC');
  });

  it('labels the lost visual channel as degraded when the fallback is used', () => {
    // BREAK: the operator not learning that a run went blind.
    const res = resolveCaptureSource({
      contentScript: contentScriptFailed(),
      direct: directCaptureAvailable(true),
      now: () => now,
    }) as CaptureResolution;

    expect(res.redactionState).toBe('degraded');
    expect(res.degradedAt).toBe(now);
    expect(res.degradedReason).toMatch(/un-redacted/i);
  });

  it('never returns an empty legend alongside a degraded fallback', () => {
    // BREAK: a fabricated legend implying masks were applied to a frame that
    // never went through the mask pipeline.
    const res = resolveCaptureSource({
      contentScript: contentScriptFailed(),
      direct: directCaptureAvailable(true),
      now: () => now,
    }) as CaptureResolution;

    expect(res.legend).toEqual([]);
  });

  it('reports unavailable when the content script fails and no direct capture exists', () => {
    // BREAK: substituting an empty string and letting the caller discover the
    // problem downstream.
    const res = resolveCaptureSource({
      contentScript: contentScriptFailed('no frames'),
      direct: directCaptureAvailable(false),
      now: () => now,
    }) as CaptureResolution;

    expect(res.source).toBe('unavailable');
    expect(res.image).toBeNull();
    expect(res.archivalImage).toBeNull();
    expect(res.redactionState).toBe('unavailable');
    expect(res.degradedReason).toMatch(/no frames/i);
  });

  it('preserves a degraded state reported by the content script itself', () => {
    // BREAK: Cycle 1.2's degraded release being upgraded to verified by the
    // background because the content script "succeeded".
    const res = resolveCaptureSource({
      contentScript: contentScriptOk({
        redaction: {
          state: 'degraded' as const,
          engine: 'unavailable' as const,
          degradedAt: now,
          reason: 'MediaPipe FaceLandmarker is degraded (model/WASM unavailable).',
          violations: ['Detection unavailable: engine down'],
        },
      }),
      direct: directCaptureAvailable(true),
      now: () => now,
    }) as CaptureResolution;

    expect(res.source).toBe('content-script');
    expect(res.redactionState).toBe('degraded');
    expect(res.degradedAt).toBe(now);
    expect(res.degradedReason).toMatch(/MediaPipe/);
  });

  it('does not fall back to a direct capture when the content script already produced a frame', () => {
    // BREAK: the fallback firing opportunistically and replacing a properly
    // redacted frame with a raw one.
    const res = resolveCaptureSource({
      contentScript: contentScriptOk(),
      direct: directCaptureAvailable(true),
      now: () => now,
    }) as CaptureResolution;

    expect(res.source).toBe('content-script');
    expect(res.image).toBe('AAAA');
  });

  it('strips the data-URL prefix from the selected image exactly once', () => {
    // BREAK: double-prefixing or leaving `data:...;base64,` in the payload the
    // server later re-attaches a header to.
    const res = resolveCaptureSource({
      contentScript: contentScriptOk(),
      direct: directCaptureAvailable(true),
      now: () => now,
    }) as CaptureResolution;

    expect(res.image?.startsWith('data:')).toBe(false);
    expect(res.image).toBe('AAAA');
  });

  it('treats an empty content-script image as a failure and falls back', () => {
    // BREAK: an empty string being treated as a valid frame and shipped.
    const res = resolveCaptureSource({
      contentScript: contentScriptOk({ image: '' }),
      direct: directCaptureAvailable(true),
      now: () => now,
    }) as CaptureResolution;

    expect(res.source).toBe('direct-capture-fallback');
    expect(res.redactionState).toBe('degraded');
  });

  it('treats a whitespace-only content-script image as a failure and falls back', () => {
    // BREAK: `if (image)` passing on whitespace, then a zero-byte frame going
    // to the provider.
    const res = resolveCaptureSource({
      contentScript: contentScriptOk({ image: '   ' }),
      direct: directCaptureAvailable(true),
      now: () => now,
    }) as CaptureResolution;

    expect(res.source).toBe('direct-capture-fallback');
    expect(res.redactionState).toBe('degraded');
  });
});
