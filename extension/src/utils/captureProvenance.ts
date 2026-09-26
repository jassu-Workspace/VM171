/**
 * Capture provenance — Cycle 1.3 (finding N2, CRITICAL)
 * ---------------------------------------------------------------------------
 * The bug this module exists to prevent
 *
 * `background/index.ts` carried a "Bulletproof Capture" fallback. When the
 * content script's screenshot failed for ANY reason, it called
 * `browser.tabs.captureVisibleTab()` — a raw, completely UN-REDACTED browser
 * capture — and assigned it to the variable named `redactedImage`:
 *
 *     if (!rawImage && typeof browser?.tabs?.captureVisibleTab === 'function') {
 *       const directCapture = await browser.tabs.captureVisibleTab(null, {...});
 *       redactedImage = <raw capture>;            // never redacted
 *     }
 *
 * `redactedImage` is the field the server forwards to the AI provider as the
 * trusted image. So the fail-closed guarantee was defeated by a reliability
 * feature, and the variable name hid it completely: a raw frame sat in a field
 * whose name asserted it had been redacted.
 *
 * Project decision: fail-VISIBLE, not fail-closed. The fallback is kept so the
 * agent keeps working, but it is always labelled `degraded` and never
 * `verified`. Provenance travels with the frame instead of being implied by a
 * name.
 *
 * Pure by design: no chrome APIs, no clock, no globals. `now` is injected so
 * tests are deterministic. The caller performs the actual capture and passes
 * the result in.
 */

export type RedactionState = 'verified' | 'degraded' | 'unavailable';
export type CaptureSource = 'content-script' | 'direct-capture-fallback' | 'unavailable';

export interface RedactionEnvelope {
  state: RedactionState;
  engine: string;
  degradedAt: string | null;
  reason: string;
  violations: string[];
}

export interface RedactionLegendEntry {
  id: string;
  type: string;
  bbox: number[];
}

export type ContentScriptCapture =
  | {
      ok: true;
      image: string;
      rawImage?: string;
      legend?: RedactionLegendEntry[];
      redaction?: RedactionEnvelope;
    }
  | { ok: false; reason: string };

export interface DirectCapture {
  /** Is `browser.tabs.captureVisibleTab` usable right now? */
  available: boolean;
  /** The raw data URL it produced, or null. */
  capture: string | null;
}

export interface CaptureResolution {
  source: CaptureSource;
  /**
   * Frame eligible for the OUTBOUND request. Sourced ONLY from the content
   * script. A direct `captureVisibleTab` fallback NEVER lands here — that
   * capture is un-redacted, and the whole point of the zero-trust pipeline is
   * that un-redacted pixels never leave the machine. `null` means send no
   * image at all (DOM-only step).
   */
  image: string | null;
  /**
   * Frame for LOCAL ARCHIVAL ONLY (`raw-images/`). May be an un-redacted
   * direct capture, which is why it must never be sent anywhere.
   */
  archivalImage: string | null;
  /** Mask legend. Always empty for a direct-capture fallback. */
  legend: RedactionLegendEntry[];
  redactionState: RedactionState;
  degradedAt: string | null;
  degradedReason: string | null;
}

const DATA_URL_PREFIX = /^data:image\/\w+;base64,/;

function stripDataUrl(value: string | null | undefined): string {
  if (typeof value !== 'string') return '';
  return value.replace(DATA_URL_PREFIX, '');
}

function isUsableImage(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Decide which frame to send and — critically — what to call it.
 *
 * SECURITY PROPERTY (must never regress):
 *   `image` is populated ONLY from the content script. A raw
 *   `captureVisibleTab` fallback goes to `archivalImage` and nowhere else, so
 *   un-redacted pixels never leave the machine. The original code already
 *   behaved this way — it forced `redactedImage` empty on redaction failure
 *   and proceeded DOM-only. An earlier draft of this module conflated the two
 *   and would have shipped un-redacted pixels to the AI provider.
 *
 * Precedence:
 *   1. Content script produced a usable frame -> outbound from it, keeping the
 *      provenance it reported. A `degraded` envelope stays degraded; nothing
 *      here may upgrade it.
 *   2. Content script failed, direct capture available -> archive the raw
 *      capture, send NO image, label the step `degraded` so the operator learns
 *      the run lost its visual channel.
 *   3. Neither -> `unavailable`, null image, reason recorded.
 */
export function resolveCaptureSource(input: {
  contentScript: ContentScriptCapture;
  direct: DirectCapture;
  now?: () => string;
}): CaptureResolution {
  const { contentScript, direct } = input;
  const now = input.now ?? (() => new Date().toISOString());

  if (contentScript.ok && isUsableImage(contentScript.image)) {
    const envelope = contentScript.redaction;
    const state: RedactionState = envelope?.state ?? 'degraded';
    return {
      source: 'content-script',
      image: stripDataUrl(contentScript.image),
      archivalImage: stripDataUrl(contentScript.rawImage) || null,
      legend: Array.isArray(contentScript.legend) ? contentScript.legend : [],
      redactionState: state,
      degradedAt: state === 'degraded' ? envelope?.degradedAt ?? now() : null,
      degradedReason: state === 'degraded' ? envelope?.reason ?? 'Redaction provenance missing.' : null,
    };
  }

  const failureReason = contentScript.ok
    ? 'Content script returned an empty image.'
    : contentScript.reason;

  if (direct.available && isUsableImage(direct.capture)) {
    return {
      source: 'direct-capture-fallback',
      // SECURITY: null, not the raw capture. Un-redacted pixels stay local.
      image: null,
      archivalImage: stripDataUrl(direct.capture),
      // No mask pipeline ran, so no legend may be implied.
      legend: [],
      redactionState: 'degraded',
      degradedAt: now(),
      degradedReason:
        `Un-redacted captureVisibleTab fallback used because the content script failed: ${failureReason}`,
    };
  }

  return {
    source: 'unavailable',
    image: null,
    archivalImage: null,
    legend: [],
    redactionState: 'unavailable',
    degradedAt: now(),
    degradedReason: `No frame available. Content script: ${failureReason}`,
  };
}
