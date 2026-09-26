/**
 * Cycle 1.5 — Image safety: validate bytes, not labels.
 * ---------------------------------------------------------------------------
 * FINDING N5 (live bug)
 *
 * The server builds the VLM payload as:
 *     'data:image/jpeg;base64,' + imageBase64          (index.ts:925)
 * but the frames arriving from the client are not all JPEG:
 *   - the content script's redacted frame is `canvas.toDataURL('image/jpeg')`
 *     -> JPEG bytes, correctly labelled
 *   - `browser.tabs.captureVisibleTab({format:'jpeg'})` is JPEG
 *   - but a `captureVisibleTab` default, or any client sending PNG/WebP, is NOT
 *
 * So the server can label PNG bytes as JPEG. Depending on the provider that is
 * either a silent decode failure or a content-type confusion. More importantly,
 * the server currently trusts a client-supplied string completely: any bytes
 * at all are accepted and forwarded.
 *
 * The two safety properties:
 *   1. MAGIC BYTES — the declared type must match the actual leading bytes.
 *   2. BOUNDED SIZE — a cap on decoded dimensions and encoded length, so a
 *      decompression bomb or a 40 MB payload cannot exhaust the process.
 *
 * Note on EXIF: the main path re-encodes through a canvas
 * (`canvas.toDataURL`), which incidentally strips EXIF/GPS. This module does
 * not rely on that — it cannot, because it is validating bytes it was handed.
 *
 * Breaks caught here:
 *   - PNG bytes accepted under a JPEG label (the N5 bug)
 *   - an unsupported/absent format being accepted
 *   - magic-byte checking being skippable via a permissive decode path
 *   - base64 that decodes to nothing being treated as a valid image
 */
import { describe, it, expect } from 'vitest';
import { detectImageFormat, validateImagePayload, type ImageFormat } from '../../server/src/imageSafety';

/**
 * Hand-built byte fixtures — NOT produced by the code under test.
 * Each is a real file signature followed by filler.
 */
const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const JPEG_BYTES = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, // JPEG SOI + APP0
  0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
]);
const GIF_BYTES = Uint8Array.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, // GIF89a
  0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00,
]);
const RIFF_BYTES = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, // "RIFF"
  0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20, // "WEBP VP8 "
]);
const TEXT_BYTES = Uint8Array.from([
  0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e, 0x3c, 0x2f, // "<html></"
  0x68, 0x74, 0x6d, 0x6c, 0x3e, 0x00, 0x00, 0x00,
]);

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

describe('Cycle 1.5 — format detection from magic bytes', () => {
  it('detects PNG from its signature', () => {
    // BREAK: signature matching broken for PNG.
    expect(detectImageFormat(PNG_BYTES)).toBe('png');
  });

  it('detects JPEG from its SOI marker', () => {
    // BREAK: JPEG detection regressing.
    expect(detectImageFormat(JPEG_BYTES)).toBe('jpeg');
  });

  it('detects GIF from its header', () => {
    expect(detectImageFormat(GIF_BYTES)).toBe('gif');
  });

  it('detects WebP only when the RIFF container says WEBP', () => {
    // BREAK: matching any RIFF file as WebP. `RIFF....AVI ` must not pass.
    expect(detectImageFormat(RIFF_BYTES)).toBe('webp');
    const avi = Uint8Array.from([
      0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00,
      0x41, 0x56, 0x49, 0x20, 0x00, 0x00, 0x00, 0x00,
    ]);
    expect(detectImageFormat(avi)).not.toBe('webp');
  });

  it('reports unknown for non-image bytes', () => {
    // BREAK: HTML or script bytes being accepted as an image.
    expect(detectImageFormat(TEXT_BYTES)).toBe('unknown');
  });

  it('reports unknown for an empty buffer', () => {
    expect(detectImageFormat(new Uint8Array(0))).toBe('unknown');
  });

  it('reports unknown for a buffer too short to hold any signature', () => {
    // BREAK: a 2-byte buffer throwing on an out-of-range read.
    expect(detectImageFormat(Uint8Array.from([0xff, 0xd8]))).toBe('unknown');
  });
});

describe('Cycle 1.5 — payload validation', () => {
  it('accepts JPEG bytes declared as JPEG', () => {
    // BREAK: the happy path being refused.
    const v = validateImagePayload(b64(JPEG_BYTES), 'image/jpeg');
    expect(v.ok).toBe(true);
    expect(v.format).toBe('jpeg');
  });

  it('rejects PNG bytes declared as JPEG — the N5 bug', () => {
    // BREAK: THE LIVE BUG. The server labels every frame `image/jpeg`; a PNG
    // frame would sail through and be forwarded mislabelled.
    const v = validateImagePayload(b64(PNG_BYTES), 'image/jpeg');
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/mismatch/i);
  });

  it('rejects JPEG bytes declared as PNG', () => {
    // BREAK: the check being one-directional.
    const v = validateImagePayload(b64(JPEG_BYTES), 'image/png');
    expect(v.ok).toBe(false);
  });

  it('accepts PNG bytes when PNG is declared', () => {
    // BREAK: over-strictness that would break a legitimate PNG client.
    const v = validateImagePayload(b64(PNG_BYTES), 'image/png');
    expect(v.ok).toBe(true);
    expect(v.format).toBe('png');
  });

  it('rejects a payload that decodes to nothing', () => {
    // BREAK: empty base64 being treated as a valid image.
    const v = validateImagePayload('', 'image/jpeg');
    expect(v.ok).toBe(false);
  });

  it('rejects a payload that is not valid base64', () => {
    // BREAK: a decode error being swallowed and treated as an empty image.
    const v = validateImagePayload('!!!not-base64!!!', 'image/jpeg');
    expect(v.ok).toBe(false);
  });

  it('rejects a non-image payload even when the declared type matches', () => {
    // BREAK: format detection being skipped when the label looks plausible.
    const v = validateImagePayload(b64(TEXT_BYTES), 'image/jpeg');
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/not a recognised image format|unsupported|unknown/i);
  });

  it('rejects an empty declared type rather than assuming one', () => {
    // BREAK: a missing label defaulting to image/jpeg and passing.
    const v = validateImagePayload(b64(PNG_BYTES), '');
    expect(v.ok).toBe(false);
  });

  it('rejects a payload whose encoded length exceeds the cap', () => {
    // BREAK: no size ceiling, letting a huge or decompression-bomb payload
    // through. 1 MB of base64 is far beyond any legitimate screenshot.
    const huge = b64(new Uint8Array(1024 * 1024));
    const v = validateImagePayload(huge, 'image/jpeg', { maxEncodedBytes: 64 * 1024 });
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/large|size|exceed/i);
  });

  it('reports the decoded byte length on success', () => {
    // BREAK: losing the length, so a caller cannot log or budget from it.
    const v = validateImagePayload(b64(JPEG_BYTES), 'image/jpeg');
    expect(v.ok).toBe(true);
    expect(v.byteLength).toBe(JPEG_BYTES.length);
  });

  it('strips a data-URL prefix before validating', () => {
    // BREAK: a client sending `data:image/jpeg;base64,xxx` and the validator
    // choking on the prefix instead of the bytes.
    const v = validateImagePayload(`data:image/jpeg;base64,${b64(JPEG_BYTES)}`, 'image/jpeg');
    expect(v.ok).toBe(true);
  });

  it('tolerates whitespace and newlines in base64', () => {
    // BREAK: wrapped base64 (some clients wrap at 76 chars) being rejected.
    const wrapped = b64(JPEG_BYTES).replace(/(.{4})/g, '$1\n');
    const v = validateImagePayload(wrapped, 'image/jpeg');
    expect(v.ok).toBe(true);
  });
});
