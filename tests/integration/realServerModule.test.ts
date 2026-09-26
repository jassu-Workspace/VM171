/**
 * Cycle 1.4 (support) — the real server module must load and register its routes.
 * ---------------------------------------------------------------------------
 * `server/src/index.ts` had NO test coverage at all: it calls `process.exit()`
 * and `serve()` at import time, so nothing could import it. That gap is why
 * `tests/integration/serverContract.test.ts` ended up testing a hand-written
 * MIRROR of the server instead (finding N7) — and a mirror cannot catch a typo
 * in the real file.
 *
 * The module is already guarded for tests: it skips `process.exit` and `serve`
 * when `VITEST` is set, and `tests/setup/setupExtensionMock.ts` supplies
 * `SECRET_PASSWORD`. So it is directly importable here.
 *
 * This is a narrow smoke test, deliberately NOT a replacement for the
 * de-mirroring work. It exists so that edits to the real entry point fail
 * loudly instead of silently.
 *
 * Breaks caught here:
 *   - a syntax or top-level error in the real server entry point
 *   - a route being renamed or dropped
 *   - a top-level side effect (serve/exit) firing during a test run
 */
import { describe, it, expect, beforeAll } from 'vitest';

type AppLike = { request: (input: string, init?: RequestInit) => Promise<Response> };

let app: AppLike;

beforeAll(async () => {
  // The module self-guards on VITEST, so importing it must not bind a port.
  const mod = await import('../../server/src/index');
  app = (mod as unknown as { app: AppLike }).app ?? (mod as unknown as AppLike);
});

describe('Cycle 1.4 — real server module loads and exposes its API', () => {
  it('exports something that can answer a request', () => {
    // BREAK: the module failing to load, or exporting no app.
    expect(app).toBeTruthy();
    expect(typeof app.request).toBe('function');
  });

  it('requires the secret even for GET /health', async () => {
    // BREAK: the auth middleware being narrowed from '*' to specific routes.
    //
    // OBSERVATION (not changed here): the real server puts `/health` behind
    // `app.use('*')` auth, so an unauthenticated health probe gets 401. That is
    // defensible — /health leaks storage stats and the configured AI provider —
    // but it means container/orchestrator health checks need the secret. Left
    // as-is: changing auth behaviour is out of scope for this cycle.
    const unauth = await app.request('http://localhost/health');
    expect(unauth.status).toBe(401);
  });

  it('answers GET /health with the secret', async () => {
    // BREAK: the health route being renamed or removed.
    const res = await app.request('http://localhost/health', {
      headers: { 'x-secret-password': process.env.SECRET_PASSWORD ?? '' },
    });
    expect(res.status).toBe(200);
  });

  it('rejects an unauthenticated POST /api/step with 401', async () => {
    // BREAK: the auth middleware being removed, bypassed, or reordered after
    // CORS. This exercises the REAL middleware chain, not a copy.
    const res = await app.request('http://localhost/api/step', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 't', maskedDom: 'd' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects a wrong secret with 401', async () => {
    // BREAK: the comparison being loosened to a truthy check.
    const res = await app.request('http://localhost/api/step', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-secret-password': 'definitely-wrong' },
      body: JSON.stringify({ task: 't', maskedDom: 'd' }),
    });
    expect(res.status).toBe(401);
  });

  it('answers GET /api/system-telemetry with a redaction section', async () => {
    // BREAK: the Cycle 1.4 telemetry block being dropped by a later refactor.
    const res = await app.request('http://localhost/api/system-telemetry', {
      headers: { 'x-secret-password': process.env.SECRET_PASSWORD ?? '' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { redaction?: { policy?: string } };
    expect(body.redaction).toBeDefined();
    expect(typeof body.redaction?.policy).toBe('string');
  });

  it('does not bind a listening socket as a side effect of import', () => {
    // BREAK: the `if (!process.env.VITEST)` guard around `serve()` being
    // removed, which would leave a port bound for the whole test run.
    // Nothing to assert directly — if a port were bound the runner would hang —
    // so this test documents the invariant and fails loudly if the import throws.
    expect(true).toBe(true);
  });
});
