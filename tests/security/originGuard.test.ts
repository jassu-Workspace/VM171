/**
 * Cycle 2.5 — Server-side origin allowlist (audit finding #3, CRITICAL).
 * ---------------------------------------------------------------------------
 * THE VULNERABILITY
 *
 * The server sets `cors({ origin: '*' })` and authenticates with a shared
 * secret. The secret was hardcoded in the extension source, so it was public.
 * Together those two facts meant ANY WEBPAGE the operator visited could:
 *
 *     fetch('http://localhost:3000/api/step', {
 *       headers: { 'x-secret-password': '141207' },   // read from the bundle
 *       ...
 *     })
 *
 * Preflight succeeds because the server allows `*` and permits the custom
 * header. The agent holds `host_permissions: ['<all_urls>']` plus `scripting`,
 * so a hostile page could make it click and type on any site the operator had
 * logged into.
 *
 * WHY A SERVER-SIDE CHECK, NOT JUST CORS
 *
 * CORS only constrains browsers that choose to honour it. The control that
 * actually matters is an explicit `Origin` check in the server: it holds
 * regardless of what the client claims to be, and it also covers non-browser
 * callers. CORS is kept as a secondary, correct layer.
 *
 * Requests with NO `Origin` header are allowed through to authentication —
 * curl, the test runner and Playwright do not send one, and the secret still
 * gates them. Blocking them would break legitimate local tooling for no
 * security gain.
 *
 * These tests drive the REAL exported app, not a mirror.
 *
 * Breaks caught here:
 *   - a disallowed origin being served even with a valid secret
 *   - the allowlist accidentally blocking no-Origin callers
 *   - the preflight path being rejected
 *   - an allowlisted origin being rejected
 */
import { describe, it, expect, beforeAll } from 'vitest';

type AppLike = { request: (input: string, init?: RequestInit) => Promise<Response> };

const SECRET = process.env.SECRET_PASSWORD ?? '';
const ALLOWED = 'chrome-extension://test-extension-id';
const HOSTILE = 'https://evil.example';

let app: AppLike;

beforeAll(async () => {
  const mod = await import('../../server/src/index');
  app = (mod as unknown as { app: AppLike }).app ?? (mod as unknown as AppLike);
});

function post(headers: Record<string, string>) {
  return app.request('http://localhost/api/step', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-secret-password': SECRET, ...headers },
    body: JSON.stringify({ task: 't', maskedDom: 'd' }),
  });
}

describe('Cycle 2.5 — origin allowlist', () => {
  it('refuses a disallowed origin even when the secret is valid', () => {
    // BREAK: THE VULNERABILITY. If this ever returns anything but 403, any
    // webpage can drive the local agent again.
    // Currently returns 200/4xx-from-downstream because there is no check.
    return post({ Origin: HOSTILE }).then((res) => {
      expect(res.status).toBe(403);
    });
  });

  it('allows an allowlisted origin through the origin gate', () => {
    // BREAK: the comparison being wrong (e.g. prefix match) so the real
    // extension origin gets locked out and the agent stops working.
    return post({ Origin: ALLOWED }).then((res) => {
      expect(res.status).not.toBe(403);
    });
  });

  it('allows a request with no Origin header', () => {
    // BREAK: over-strictness breaking curl, the test runner and Playwright.
    // They send no Origin, and the secret still gates them.
    return post({}).then((res) => {
      expect(res.status).not.toBe(403);
    });
  });

  it('does not evaluate the origin rule for an OPTIONS preflight', () => {
    // BREAK: rejecting preflight means the extension can never call the
    // server at all — a total functional break, not a security win.
    return app
      .request('http://localhost/api/step', {
        method: 'OPTIONS',
        headers: { Origin: HOSTILE },
      })
      .then((res) => {
        expect(res.status).not.toBe(403);
      });
  });

  it('refuses a disallowed origin on a GET route too', () => {
    // BREAK: the guard being applied only to POST /api/step, leaving
    // /api/sessions and /api/system-telemetry reachable from a page.
    return app
      .request('http://localhost/api/system-telemetry', {
        headers: { Origin: HOSTILE, 'x-secret-password': SECRET },
      })
      .then((res) => {
        expect(res.status).toBe(403);
      });
  });

  it('refuses a disallowed origin even with a wrong secret, and does not leak which failed', () => {
    // BREAK: an origin-rejection path that skips auth and reveals ordering.
    // Both must be 403 for origin — the origin check runs first, so the
    // response cannot be used to probe the secret.
    return post({ Origin: HOSTILE, 'x-secret-password': 'wrong' }).then((res) => {
      expect(res.status).toBe(403);
    });
  });

  it('still returns 401 for a bad secret on an allowed origin', () => {
    // BREAK: the origin guard swallowing the auth path entirely, so a bad
    // secret would look like success.
    return app
      .request('http://localhost/api/step', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-secret-password': 'wrong', Origin: ALLOWED },
        body: JSON.stringify({ task: 't', maskedDom: 'd' }),
      })
      .then((res) => {
        expect(res.status).toBe(401);
      });
  });

  it('treats an Origin differing only in case as disallowed', () => {
    // BREAK: a case-insensitive comparison letting an attacker vary the host.
    return post({ Origin: HOSTILE.toUpperCase() }).then((res) => {
      expect(res.status).toBe(403);
    });
  });

  it('does not accept a trailing-slash variant of an allowed origin', () => {
    // BREAK: sloppy normalisation letting `chrome-extension://id/` or
    // `http://localhost:3300/` slip past an exact-match allowlist.
    return post({ Origin: 'http://localhost:3300/' }).then((res) => {
      expect(res.status).toBe(403);
    });
  });
});
