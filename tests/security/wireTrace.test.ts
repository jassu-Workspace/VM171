/**
 * Cycle 3.11 — the wire trace, and the limit it exists to make visible.
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 *
 * A 413 was being returned by `bodyLimit` and NO log line named the endpoint
 * that produced it. The cause was middleware ORDER, and it is permanent unless
 * something asserts it:
 *
 *     originGuard        <- registered first
 *     bodyLimit          <- 413 short-circuits HERE
 *     cors
 *     request logger     <- NEVER RUNS for a rejected body
 *     auth
 *
 * `bodyLimit` returns a Response without calling `next()`, so the request
 * logger — the only thing that printed `→ METHOD path` — is never reached for
 * an oversized body. Every attempt to diagnose this from outside the process
 * (a logging proxy, a patched `globalThis.fetch`) was blind to the request for
 * unrelated reasons: an MV3 service worker restarts and loses patched globals,
 * and a proxy is only useful if something is actually routed through it.
 *
 * The fix is a diagnostic registered ABOVE `bodyLimit` that speaks on the way
 * in. These tests pin that property, because "it works" is not a durable claim
 * — a future reorder of the middleware stack would silently restore the exact
 * blindness this file exists to prevent.
 *
 * `isolate: true` in vitest.config.ts is what makes the env-gated registration
 * testable: WIRE_TRACE is read once at module-evaluation time, so each case
 * resets the module registry and re-imports to get a fresh registration.
 *
 * Breaks caught here:
 *   - the trace being moved below bodyLimit (the original bug)
 *   - the trace leaking into normal runs when WIRE_TRACE is unset
 *   - the trace printing a body, a header, or a query string
 *   - the trace reporting a size for a request that declared none
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';

type AppLike = { request: (input: string, init?: RequestInit) => Promise<Response> };

/** The limit actually in force for tests. setupExtensionMock.ts pins this. */
const LIMIT = Number(process.env.MAX_BODY_BYTES ?? 32768);

let app: AppLike;

/** Load a FRESH copy of the server with the current env. */
async function loadServer(): Promise<AppLike> {
  vi.resetModules();
  const mod = await import('../../server/src/index');
  return (mod as unknown as { app: AppLike }).app ?? (mod as unknown as AppLike);
}

/** Every stderr line the server emitted while `fn` ran. */
async function captureStderr<T>(fn: () => Promise<T>): Promise<{ result: T; stderr: string }> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  try {
    const result = await fn();
    return { result, stderr: lines.join('\n') };
  } finally {
    spy.mockRestore();
  }
}

/** A body guaranteed to exceed the limit. */
function oversized(): string {
  return JSON.stringify({ task: 't', maskedDom: 'x'.repeat(LIMIT * 3) });
}

beforeAll(async () => {
  app = await loadServer();
});

afterEach(() => {
  delete process.env.WIRE_TRACE;
});

describe('Cycle 3.11 — the wire trace sees what the request logger cannot', () => {
  it('is completely absent when WIRE_TRACE is unset', async () => {
    // BREAK: the trace being left permanently enabled. It writes two lines per
    // request to stderr, so in production it would double the server's log
    // volume and bury the lines an operator actually needs.
    delete process.env.WIRE_TRACE;
    app = await loadServer();
    const { stderr } = await captureStderr(() =>
      app.request('http://localhost/health', { headers: { authorization: 'Bearer x' } }),
    );
    expect(stderr).not.toContain('[wire]');
  });

  it('names the endpoint and size of a request that bodyLimit rejects with 413', async () => {
    // BREAK: the trace being registered below bodyLimit, or removed. This is
    // THE regression. The request logger cannot cover this case, so if the
    // trace regresses the 413 becomes undiagnosable again with nothing failing.
    process.env.WIRE_TRACE = '1';
    app = await loadServer();

    const body = oversized();
    const { result, stderr } = await captureStderr(() =>
      app.request('http://localhost/api/step', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Set explicitly: Hono's in-process request helper does not always
          // populate a computed content-length, and the point of the assertion
          // is the SIZE, so it is stated rather than inferred.
          'content-length': String(Buffer.byteLength(body, 'utf8')),
        },
        body,
      }),
    );

    // The request really was rejected for size.
    expect(result.status).toBe(413);

    // The trace named the endpoint...
    expect(stderr).toContain('/api/step');
    // ...the method...
    expect(stderr).toMatch(/POST \/api\/step/);
    // ...the size, in bytes...
    expect(stderr).toMatch(/content-length=\d+B/);
    // ...the outcome...
    expect(stderr).toContain('status=413');
    // ...and the limit it was measured against.
    expect(stderr).toContain(`limit=${LIMIT}B`);
  });

  it('logs the inbound line even when the response is produced downstream', async () => {
    // BREAK: the trace only logging on the way OUT. Then a middleware that
    // throws, hangs, or never finalises the context produces no line at all —
    // which is the same blindness in a different costume.
    process.env.WIRE_TRACE = '1';
    app = await loadServer();

    const { stderr } = await captureStderr(() =>
      app.request('http://localhost/health', {
        headers: { authorization: 'Bearer not-a-real-token' },
      }),
    );

    // Emitted before the request could possibly have been answered.
    expect(stderr).toContain('[wire] >> GET /health');
    expect(stderr).toContain('[wire] << GET /health');
    expect(stderr).toContain('status=401');
  });

  it('reports "absent" rather than inventing a size when none was declared', async () => {
    // BREAK: `Number(undefined)` becoming NaN and printing "content-length=NaNB",
    // or a `?? 0` fallback reporting a body of zero bytes for a request that
    // genuinely sent one. A chunked request has no declared length, and saying
    // so is the only honest output.
    process.env.WIRE_TRACE = '1';
    app = await loadServer();

    const { stderr } = await captureStderr(() =>
      app.request('http://localhost/api/step', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ task: 't', maskedDom: 'short' }),
      }),
    );

    expect(stderr).toContain('content-length=chunked/absent');
    expect(stderr).not.toContain('NaN');
  });

  it('never prints a body, a query string, or an auth header', async () => {
    // BREAK: the trace being "just a bit more useful" by including the payload
    // or the full URL. The first would put page text and base64 screenshots in
    // server_err.log — the exact leak logger.ts exists to prevent. The second
    // would put a token in the log, because `?token=` is a real query param on
    // some deployments. c.req.path excludes the query string; that is load
    // bearing and this assertion is what keeps it that way.
    process.env.WIRE_TRACE = '1';
    app = await loadServer();

    const canary = 'CANARY-SECRET-b7f3a91c4e2d';
    const { stderr } = await captureStderr(() =>
      app.request(`http://localhost/api/session/screenshot?token=${canary}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${canary}`,
        },
        body: oversized(),
      }),
    );

    expect(stderr).toContain('[wire]');
    expect(stderr).not.toContain(canary);
    expect(stderr).not.toContain('Bearer');
  });
});

describe('Cycle 3.11 — the limit in force is the limit that gets reported', () => {
  it('agrees with the limit bodyLimit actually enforces', async () => {
    // BREAK: MAX_BODY_BYTES drifting between the value used for the trace and
    // the value passed to bodyLimit — a forked constant, or one computed after
    // the middleware was registered. The trace would then report a threshold
    // the server never applied, which is worse than reporting none.
    //
    // This is the assertion that encodes the actual root cause of the 413:
    // the payload was ~50KB and the enforced limit was 32KB, but the limit
    // being reasoned about was the 20MB default. Over by ~18KB, and invisible.
    process.env.WIRE_TRACE = '1';
    app = await loadServer();

    const just_under = JSON.stringify({ task: 't', maskedDom: 'x'.repeat(LIMIT - 200) });
    const just_over = JSON.stringify({ task: 't', maskedDom: 'x'.repeat(LIMIT + 200) });

    const under = await app.request('http://localhost/api/step', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: just_under,
    });
    const over = await app.request('http://localhost/api/step', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: just_over,
    });

    expect(over.status).toBe(413);
    expect(under.status).not.toBe(413);

    // The payload that started this investigation is over the enforced limit.
    // Asserted as a number so the failure message states the real arithmetic
    // instead of leaving the next reader to reconstruct it.
    const measuredPayload = 51_633;
    expect(
      measuredPayload > LIMIT,
      `payload ${measuredPayload}B must exceed the enforced limit ${LIMIT}B for this regression to mean anything`,
    ).toBe(true);
  });
});
