/**
 * Zero-Trust Egress — the raw-only blind spot.
 * ---------------------------------------------------------------------------
 * WHAT THIS PINS, AND HONESTLY SO
 *
 * tests/security/egressInvariant.test.ts proves that when a step carries BOTH
 * a redacted and a raw frame, only the redacted one reaches the provider. It
 * cannot fail for the case that matters most — a request carrying rawImage
 * but NO redactedImage — because the attach guard in server/src/index.ts
 * (`if (imageBase64.trim().length > 50)`, where imageBase64 derives ONLY from
 * redactedImage) simply skips attachment. Such a test would pass vacuously,
 * exercising the guard's else-branch rather than any redaction logic, and the
 * property would rest on imageSafety and the guard, not on the test.
 *
 * So this file does NOT claim "redaction was verified on the raw-only path".
 * It pins the ACTUAL structural property, behaviorally, end to end through
 * the real app and the completion seam:
 *
 *   1. a raw-only request attaches NO image at all — the raw frame cannot
 *      become the outbound image by the absence of a redacted one;
 *   2. a valid raw frame cannot substitute for an invalid redacted one — the
 *      attach guard reads only the redacted variable, even with a crafted
 *      redactedImage and a perfectly valid rawImage sitting beside it;
 *   3. outbound userContent is a pure function of the redacted image: two
 *      requests differing ONLY in raw bytes produce byte-identical outbound
 *      behaviour, so raw bytes can never leak through the attached frame;
 *   4. (the asymmetric control) a redacted-only request attaches exactly the
 *      redacted image — proving tests 1–3 pass because of the guard's
 *      direction, not because attachment is broken altogether.
 *
 * If a future change routes rawImage into userContent, tests 1–3 fail. If it
 * breaks attachment entirely, test 4 fails. New file; egressInvariant.test.ts
 * is untouched.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { app } from '../../server/src/index';
import { setCompletion } from '../../server/src/completion';
import type { CompletionRequest } from '../../server/src/completionTypes';
import { SESSIONS_DIR } from '../../server/src/sessionStorage';
import { authHeader } from '../setup/authHelper';

const ALLOWED_ORIGIN = 'chrome-extension://fidbnhfgcadfpjlmdfpnngikjpdhcdcf';

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

// Standard JPEG SOI + JFIF APP0 header so the bytes are a valid JPEG if they
// are ever validated; the markers make each frame unambiguous.
const JPEG_HEADER = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
]);

function frame(marker: string, filler: number): string {
  return Buffer.concat([JPEG_HEADER, Buffer.from(marker), Buffer.alloc(64, filler)]).toString('base64');
}

const RAW_MARKER_A = 'RAW_ONLY_FRAME_MARKER_AAAAAAAA';
const RAW_MARKER_B = 'RAW_ONLY_FRAME_MARKER_BBBBBBBB';
const REDACTED_MARKER = 'REDACTED_FRAME_MARKER_CCCCCCCC';

function stepPayload(sessionId: string, images: Record<string, string>): Record<string, unknown> {
  return {
    task: 'Verify raw-only egress boundary',
    maskedDom: '<div>Safe sanitized DOM content</div>',
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
    ...images,
  };
}

async function postStep(sessionId: string, images: Record<string, string>): Promise<Response> {
  return app.request('http://localhost/api/step', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: ALLOWED_ORIGIN,
      ...authHeader(),
    },
    body: JSON.stringify(stepPayload(sessionId, images)),
  });
}

function imagePartsOf(request: CompletionRequest): Array<{ type: string }> {
  return request.userContent.filter((part) => part.type === 'image_url');
}

describe('egress raw-only path — un-redacted imagery never becomes the outbound image', () => {
  it('raw-only request attaches no image to the outbound provider payload', async () => {
    // BREAK: a future fallback (raw when redacted is absent) silently
    // promoting the un-redacted frame to the outbound image.
    const sessionId = `egress-rawonly-${randomUUID()}`;
    CREATED_SESSIONS.add(sessionId);

    let captured: CompletionRequest | null = null;
    setCompletion(async (request: CompletionRequest): Promise<string> => {
      captured = request;
      return JSON.stringify({ action: 'done', summary: 'Verification step completed successfully.' });
    });

    // NOTE: redactedImage is OMITTED entirely, not merely empty.
    const res = await postStep(sessionId, { rawImage: frame(RAW_MARKER_A, 0xbb) });
    expect(res.status).toBe(200);
    expect(captured).not.toBeNull();

    if (captured) {
      const seen = captured as CompletionRequest;
      expect(imagePartsOf(seen)).toHaveLength(0);
      const outbound = JSON.stringify(seen.userContent);
      expect(outbound).not.toContain(RAW_MARKER_A);
    }
  });

  it('a valid raw frame cannot substitute for an invalid redacted one', async () => {
    // BREAK: the attach guard being widened to "either frame", so a crafted
    // (short/invalid) redactedImage plus a valid rawImage leaks the raw frame.
    // The guard must read ONLY the redacted variable.
    const sessionId = `egress-rawsub-${randomUUID()}`;
    CREATED_SESSIONS.add(sessionId);

    let captured: CompletionRequest | null = null;
    setCompletion(async (request: CompletionRequest): Promise<string> => {
      captured = request;
      return JSON.stringify({ action: 'done', summary: 'Verification step completed successfully.' });
    });

    const res = await postStep(sessionId, {
      // Passes the base64 charset check but is far below the attach threshold.
      redactedImage: 'AAAA',
      rawImage: frame(RAW_MARKER_A, 0xbb),
    });
    expect(res.status).toBe(200);
    expect(captured).not.toBeNull();

    if (captured) {
      const seen = captured as CompletionRequest;
      expect(imagePartsOf(seen)).toHaveLength(0);
      expect(JSON.stringify(seen.userContent)).not.toContain(RAW_MARKER_A);
    }
  });

  it('outbound userContent is byte-identical when only the raw bytes differ', async () => {
    // BREAK: raw bytes influencing the outbound payload in any way — e.g. a
    // fallback, a merge, or metadata derived from the raw frame. The outbound
    // payload must be a pure function of the redacted image.
    const redactedImage = frame(REDACTED_MARKER, 0xaa);
    const seen: string[] = [];

    setCompletion(async (request: CompletionRequest): Promise<string> => {
      seen.push(JSON.stringify(request.userContent));
      return JSON.stringify({ action: 'done', summary: 'Verification step completed successfully.' });
    });

    const sessionA = `egress-rawvar-a-${randomUUID()}`;
    const sessionB = `egress-rawvar-b-${randomUUID()}`;
    CREATED_SESSIONS.add(sessionA);
    CREATED_SESSIONS.add(sessionB);

    const resA = await postStep(sessionA, { redactedImage, rawImage: frame(RAW_MARKER_A, 0xbb) });
    const resB = await postStep(sessionB, { redactedImage, rawImage: frame(RAW_MARKER_B, 0xcc) });
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    expect(seen).toHaveLength(2);

    // Byte-identical outbound behaviour despite differing raw frames — and the
    // attached frame is the redacted one in both cases.
    expect(seen[1]).toBe(seen[0]);
    expect(seen[0]).toContain(redactedImage);
    expect(seen[0]).not.toContain(RAW_MARKER_A);
    expect(seen[0]).not.toContain(RAW_MARKER_B);
  });

  it('redacted-only request still attaches exactly the redacted image (control)', async () => {
    // Control: proves the three tests above pass because of the guard's
    // DIRECTION (redacted drives attachment), not because attachment itself
    // is broken. If attachment ever stops working, THIS is the test that fails.
    const sessionId = `egress-redonly-${randomUUID()}`;
    CREATED_SESSIONS.add(sessionId);

    let captured: CompletionRequest | null = null;
    setCompletion(async (request: CompletionRequest): Promise<string> => {
      captured = request;
      return JSON.stringify({ action: 'done', summary: 'Verification step completed successfully.' });
    });

    const redactedImage = frame(REDACTED_MARKER, 0xaa);
    const res = await postStep(sessionId, { redactedImage });
    expect(res.status).toBe(200);
    expect(captured).not.toBeNull();

    if (captured) {
      const seen = captured as CompletionRequest;
      const parts = imagePartsOf(seen);
      expect(parts).toHaveLength(1);
      const part = parts[0];
      if (part && part.type === 'image_url') {
        expect(part.image_url.url).toBe(`data:image/jpeg;base64,${redactedImage}`);
      }
    }
  });
});
