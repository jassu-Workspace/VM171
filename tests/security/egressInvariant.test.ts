/**
 * Zero-Trust Egress Invariant — Un-redacted imagery must never reach the AI provider.
 * ---------------------------------------------------------------------------
 * WHAT THE INVARIANT IS
 *
 * The product's central architectural promise, documented in README.md and
 * ZERO_TRUST_AI_WEB_AGENT_SPECIFICATION.md, is zero-trust privacy: raw, un-redacted
 * DOM and imagery remain strictly local to the operator's machine and NEVER egress
 * to any upstream AI model or external provider.
 *
 * When an agent execution step is processed by `/api/step`:
 *   - The request payload carries both `redactedImage` and `rawImage`.
 *   - `redactedImage` (sanitized locally) is the ONLY image that may be attached
 *     to the outbound provider payload (`userContent`).
 *   - `rawImage` is retained exclusively for local session audit logging on disk
 *     (`saveSessionStep`) and must NEVER reach `userContent` or be dispatched upstream.
 *
 * WHY THIS IS PINNED
 *
 * An independent review revealed that while the property was documented and
 * maintained in `server/src/index.ts`, no existing test asserted this egress
 * boundary against the real application. Without this regression test, a future edit
 * (e.g. falling back to `rawImage` in `userContent` or widening the completion seam)
 * could silently violate the central zero-trust guarantee without breaking any tests.
 *
 * This test drives the REAL server application end-to-end via the completion seam
 * (`resolveCompletion` / `setCompletion`), providing an unambiguous, recognizable
 * marker in the raw payload and asserting that:
 *   1. Outbound provider userContent contains the sanitized/redacted image.
 *   2. Outbound provider userContent does NOT contain the raw image or its marker.
 *   3. The raw image IS safely stored in local session storage for operator review.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { app } from '../../server/src/index';
import { setCompletion } from '../../server/src/completion';
import type { CompletionRequest } from '../../server/src/completionTypes';
import { SESSIONS_DIR } from '../../server/src/sessionStorage';
import { authHeader } from '../setup/authHelper';

const ALLOWED_ORIGIN = 'chrome-extension://fidbnhfgcadfpjlmdfpnngikjpdhcdcf';

// Track session directories created by tests to guarantee clean-up.
const CREATED_SESSIONS = new Set<string>();

afterEach(() => {
  setCompletion(null);
  for (const id of CREATED_SESSIONS) {
    try {
      rmSync(join(SESSIONS_DIR, id), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  CREATED_SESSIONS.clear();
});

describe('Zero-Trust Egress Invariant — Un-redacted imagery never reaches AI provider', () => {
  it('forwards only redacted imagery to the provider and keeps raw imagery on disk', async () => {
    // Distinct, unambiguous markers in the payloads to eliminate reliance on length comparisons.
    const RAW_MARKER = 'RAW_UNREDACTED_SECRET_CAMERA_FRAME_MARKER_9911';
    const REDACTED_MARKER = 'REDACTED_SAFE_IMAGE_MARKER_112233_SAFE';

    // Standard JPEG SOI + JFIF APP0 header so validateImagePayload identifies both as valid JPEGs.
    const JPEG_HEADER = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
    ]);

    const rawBuffer = Buffer.concat([JPEG_HEADER, Buffer.from(RAW_MARKER), Buffer.alloc(32, 0xbb)]);
    const rawImage = rawBuffer.toString('base64');

    const redactedBuffer = Buffer.concat([JPEG_HEADER, Buffer.from(REDACTED_MARKER), Buffer.alloc(32, 0xaa)]);
    const redactedImage = redactedBuffer.toString('base64');

    const sessionId = `egress-inv-${randomUUID()}`;
    CREATED_SESSIONS.add(sessionId);

    // Install completion override on the seam to capture the outbound provider request.
    let capturedRequest: CompletionRequest | null = null;
    setCompletion(async (request: CompletionRequest): Promise<string> => {
      capturedRequest = request;
      return JSON.stringify({ action: 'done', summary: 'Verification step completed successfully.' });
    });

    const stepPayload = {
      task: 'Verify imagery privacy boundary',
      maskedDom: '<div>Safe sanitized DOM content</div>',
      redactedImage,
      rawImage,
      sessionId,
      step: 1,
      redaction_legend: [],
      subTasks: [],
      actionHistory: [],
      redaction: {
        state: 'verified',
        engine: 'mediapipe',
        reason: 'sanitized',
        violations: [],
      },
    };

    const res = await app.request('http://localhost/api/step', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: ALLOWED_ORIGIN,
        ...authHeader(),
      },
      body: JSON.stringify(stepPayload),
    });

    expect(res.status).toBe(200);
    expect(capturedRequest).not.toBeNull();

    if (capturedRequest) {
      const userContentJson = JSON.stringify(capturedRequest.userContent);

      // BREAK: redacted image missing from outbound provider call.
      expect(userContentJson).toContain(redactedImage);

      // BREAK: raw un-redacted base64 payload leaking to external AI provider in userContent.
      expect(userContentJson).not.toContain(rawImage);

      // BREAK: raw un-redacted marker or decoded bytes leaking to external AI provider anywhere in prompt/content.
      expect(userContentJson).not.toContain(RAW_MARKER);

      // Assert specific multimodal message structure: exactly one image part, matching redactedImage.
      const imageParts = capturedRequest.userContent.filter((part) => part.type === 'image_url');
      expect(imageParts.length).toBe(1);
      const imagePart = imageParts[0];
      if (imagePart && imagePart.type === 'image_url') {
        expect(imagePart.image_url.url).toBe(`data:image/jpeg;base64,${redactedImage}`);
        expect(imagePart.image_url.url).not.toContain(rawImage);
        expect(imagePart.image_url.url).not.toContain(RAW_MARKER);
      }
    }

    // Converse assertion: raw un-redacted image MUST be persisted to disk storage by saveSessionStep.
    // BREAK: local session audit logging failing to persist raw imagery for operator audit.
    const rawDiskPath = join(SESSIONS_DIR, sessionId, 'raw-images', 'step_1_raw.jpg');
    expect(existsSync(rawDiskPath)).toBe(true);
    const storedRawBytes = readFileSync(rawDiskPath);
    expect(storedRawBytes.includes(Buffer.from(RAW_MARKER))).toBe(true);
    expect(storedRawBytes.equals(rawBuffer)).toBe(true);

    // Also verify masked image is stored on disk alongside raw image.
    const maskedDiskPath = join(SESSIONS_DIR, sessionId, 'masked-images', 'step_1_masked.jpg');
    expect(existsSync(maskedDiskPath)).toBe(true);
    const storedMaskedBytes = readFileSync(maskedDiskPath);
    expect(storedMaskedBytes.includes(Buffer.from(REDACTED_MARKER))).toBe(true);
    expect(storedMaskedBytes.equals(redactedBuffer)).toBe(true);
  });
});
