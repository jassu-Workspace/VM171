/**
 * Image safety — Cycle 1.5 (finding N5)
 * ---------------------------------------------------------------------------
 * The server labels every outbound frame:
 *     'data:image/jpeg;base64,' + imageBase64        (index.ts:925)
 * but not every frame is JPEG. The content script's redacted frame is a canvas
 * `toDataURL('image/jpeg')`, and `captureVisibleTab({format:'jpeg'})` is JPEG
 * too — but a client sending PNG or WebP is not, and the server currently
 * forwards whatever string it is handed.
 *
 * This module validates BYTES, not labels:
 *   1. magic-byte format detection, so a declared type must match reality
 *   2. a bounded encoded size, so a decompression bomb or a runaway payload
 *      cannot exhaust the process
 *
 * On EXIF: the main client path re-encodes through a canvas, which incidentally
 * strips EXIF/GPS. This module deliberately does not rely on that — it validates
 * bytes it was given and cannot assume a provenance it has not checked.
 *
 * Pure and dependency-free. No decoding, no image library, no network: only the
 * leading signature bytes are inspected, so this is cheap enough to run on
 * every step.
 */

export type ImageFormat = 'jpeg' | 'png' | 'gif' | 'webp' | 'unknown';

export interface ImageValidationOptions {
  /** Ceiling on the base64 string length. Default 12 MB. */
  maxEncodedBytes?: number;
}

export interface ImageValidationResult {
  ok: boolean;
  format: ImageFormat;
  byteLength: number;
  error?: string;
}

const DEFAULT_MAX_ENCODED_BYTES = 12 * 1024 * 1024;

const DATA_URL_PREFIX = /^data:[\w.+-]+\/[\w.+-]+;base64,/i;

/** MIME subtype -> expected format. */
function formatForMime(mime: string): ImageFormat {
  const normalized = mime.trim().toLowerCase();
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return 'jpeg';
  if (normalized === 'image/png') return 'png';
  if (normalized === 'image/gif') return 'gif';
  if (normalized === 'image/webp') return 'webp';
  return 'unknown';
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (bytes[i] !== signature[i]) return false;
  }
  return true;
}

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    const byte = bytes[offset + i];
    if (byte === undefined) return out;
    out += String.fromCharCode(byte);
  }
  return out;
}

/**
 * Identify an image purely from its leading bytes.
 *
 * WebP is deliberately strict: it is a RIFF container, so the `RIFF` magic
 * alone is not enough — the form type at offset 8 must read `WEBP`. Otherwise
 * any RIFF file (AVI, WAV) would be misidentified.
 */
export function detectImageFormat(bytes: Uint8Array): ImageFormat {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'png';
  }
  // JPEG: FF D8 FF
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return 'jpeg';
  }
  // GIF: "GIF87a" / "GIF89a"
  const gif = asciiAt(bytes, 0, 6);
  if (gif === 'GIF87a' || gif === 'GIF89a') {
    return 'gif';
  }
  // WebP: "RIFF" .... "WEBP"
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && bytes.length >= 12) {
    if (asciiAt(bytes, 8, 4) === 'WEBP') {
      return 'webp';
    }
  }
  return 'unknown';
}

function stripDataUrl(value: string): string {
  return value.replace(DATA_URL_PREFIX, '');
}

/**
 * Validate an outbound image payload.
 *
 * Rejects, in order: empty input, over-size input, undecodable base64, a
 * declared type that is not an image, bytes that are not an image at all, and
 * finally a declared/actual format mismatch (the N5 bug).
 */
export function validateImagePayload(
  base64: string,
  declaredMime: string,
  options: ImageValidationOptions = {}
): ImageValidationResult {
  const maxEncodedBytes = options.maxEncodedBytes ?? DEFAULT_MAX_ENCODED_BYTES;
  const fail = (error: string, byteLength = 0): ImageValidationResult => ({
    ok: false,
    format: 'unknown',
    byteLength,
    error,
  });

  if (typeof base64 !== 'string' || base64.trim().length === 0) {
    return fail('Image payload is empty.');
  }

  const cleaned = stripDataUrl(base64).replace(/\s+/g, '');

  if (cleaned.length === 0) {
    return fail('Image payload contained no base64 data.');
  }

  if (cleaned.length > maxEncodedBytes) {
    return fail(
      `Image payload too large: ${cleaned.length} encoded bytes exceeds the ${maxEncodedBytes} limit.`
    );
  }

  let bytes: Uint8Array;
  try {
    const buf = Buffer.from(cleaned, 'base64');
    // Buffer.from is lenient: it silently drops invalid characters. If the
    // round-trip does not reproduce the input, the input was not base64.
    if (buf.length === 0 || buf.toString('base64').replace(/=+$/, '') !== cleaned.replace(/=+$/, '')) {
      return fail('Image payload is not valid base64.');
    }
    bytes = new Uint8Array(buf);
  } catch {
    return fail('Image payload could not be decoded as base64.');
  }

  const actual = detectImageFormat(bytes);
  if (actual === 'unknown') {
    return fail('Image payload bytes are not a recognised image format.', bytes.length);
  }

  const declared = formatForMime(declaredMime ?? '');
  if (declared === 'unknown') {
    return fail(`Unsupported or missing declared image type: "${declaredMime}".`, bytes.length);
  }

  if (declared !== actual) {
    return fail(
      `Image format mismatch: declared ${declared} but the bytes are ${actual}.`,
      bytes.length
    );
  }

  return { ok: true, format: actual, byteLength: bytes.length };
}
