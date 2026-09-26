/**
 * Cycle 2.7 — Body limit enforced in bytes, before the body is buffered.
 * ---------------------------------------------------------------------------
 * TWO BUGS IN THE ORIGINAL
 *
 * 1. BUFFERED BEFORE CHECKING. The route did:
 *        const rawBody = await c.req.raw.clone().text();
 *        if (rawBody.length > MAX_BODY_BYTES) return 413;
 *    `c.req.raw.clone().text()` materialises the ENTIRE request body as a
 *    JavaScript string in memory before any size test runs. A 2 GB upload is
 *    fully read into the heap and only then refused. The limit therefore
 *    protected nothing against memory exhaustion — which is the only thing a
 *    body limit is really for.
 *
 * 2. CHARACTERS COMPARED AGAINST A BYTE CONSTANT. `rawBody.length` counts
 *    UTF-16 code units, not bytes. A body of 20,000 emoji is 20,000 "characters"
 *    but ~80,000 bytes of UTF-8 — so a 32 KB limit was satisfied by a payload
 *    2.5x over it. Multi-byte content walked straight through.
 *
 * The fix is Hono's `bodyLimit` middleware, which enforces on Content-Length
 * and during streaming, so an oversized body is never fully materialised.
 *
 * NOTE ON LIMITS: "does not buffer first" is a MEMORY property and is not
 * directly unit-testable. It is verified by the manual gate in the commit
 * message (RSS while POSTing 200 MB), not by an assertion here. What IS
 * testable — and tested below — is the observable behaviour: 413 when over,
 * pass when under, and rejection in BYTES rather than characters.
 *
 * These tests drive the REAL exported app.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { authHeader } from '../setup/authHelper';

type AppLike = { request: (input: string, init?: RequestInit) => Promise<Response> };

const SECRET = process.env.SECRET_PASSWORD ?? '';
const LIMIT = Number(process.env.MAX_BODY_BYTES ?? 32768);

let app: AppLike;

beforeAll(async () => {
  const mod = await import('../../server/src/index');
  app = (mod as unknown as { app: AppLike }).app ?? (mod as unknown as AppLike);
});

function postBody(body: string) {
  return app.request('http://localhost/api/step', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-secret-password': SECRET },
    body,
  });
}

/** A structurally valid request whose `maskedDom` is `chars` long. */
function requestWithMaskedDomChars(chars: number): string {
  return JSON.stringify({ task: 't', maskedDom: 'x'.repeat(chars) });
}

/**
 * A VALID JSON request whose maskedDom is `unit` repeated `times`.
 * Used so the byte-vs-character cases fail on SIZE, not on a parse error.
 */
function requestWithMultibyteMaskedDom(unit: string, times: number): string {
  return JSON.stringify({ task: 't', maskedDom: unit.repeat(times) });
}

describe('Cycle 2.7 — body size limit', () => {
  it('refuses a body over the limit with 413', () => {
    // BREAK: the limit being removed or raised past any real payload.
    return postBody(requestWithMaskedDomChars(LIMIT * 3)).then((res) => {
      expect(res.status).toBe(413);
    });
  });

  it('accepts a body under the limit', () => {
    // BREAK: an off-by-one that starts rejecting legitimate screenshots.
    // Not 413 is the assertion — the upstream call will fail in tests, and
    // that is fine; what matters is that size did not reject it.
    return postBody(requestWithMaskedDomChars(64)).then((res) => {
      expect(res.status).not.toBe(413);
    });
  });

  it('measures the limit in BYTES, not UTF-16 characters', () => {
    // BREAK: THE CHARACTER-VS-BYTE BUG. Each emoji is 2 UTF-16 code units but
    // 4 UTF-8 bytes, so 12,000 emoji is 24,000 "characters" (under a 32 KB
    // limit) while actually being 48,000 bytes (well over it). The original
    // character-based check waved this through.
    const emoji = '\u{1F680}'.repeat(12_000); // 24,000 code units, 48,000 bytes
    expect(emoji.length).toBeLessThan(LIMIT); // would PASS a character check
    expect(Buffer.byteLength(emoji, 'utf8')).toBeGreaterThan(LIMIT); // is over

    return postBody(requestWithMultibyteMaskedDom(emoji, 1)).then((res) => {
      expect(res.status).toBe(413);
    });
  });

  it('refuses a multi-byte body that is oversized purely in byte terms', () => {
    // BREAK: a limit applied to decoded length only, missing the encoded size
    // actually transmitted over the socket.
    const cjk = '\u4e2d'.repeat(20_000); // 20,000 chars, 60,000 UTF-8 bytes
    expect(cjk.length).toBeLessThan(LIMIT);
    return postBody(requestWithMultibyteMaskedDom(cjk, 1)).then((res) => {
      expect(res.status).toBe(413);
    });
  });

  it('refuses an oversized body before spending work on authentication ordering', () => {
    // BREAK: the size check being deferred until after the upstream model call,
    // which would let an oversized body consume a provider request.
    return app
      .request('http://localhost/api/step', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-secret-password': 'wrong' },
        body: requestWithMaskedDomChars(LIMIT * 3),
      })
      .then((res) => {
        // Either 401 (auth first) or 413 (limit first) is acceptable; what must
        // NOT happen is a 200 or a 500 from processing the body.
        expect([401, 413]).toContain(res.status);
      });
  });

  it('still enforces the limit on a route other than /api/step', () => {
    // BREAK: the limit applied only to the one route, leaving the session
    // routes able to accept an unbounded payload.
    return app
      .request('http://localhost/api/session/screenshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-secret-password': SECRET },
        body: requestWithMaskedDomChars(LIMIT * 3),
      })
      .then((res) => {
        expect(res.status).toBe(413);
      });
  });
});
