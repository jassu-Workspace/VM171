/**
 * Cycle 2.6 — CORS must not advertise the API as shareable.
 * ---------------------------------------------------------------------------
 * The origin guard (2.5) is the control that matters: it refuses the request
 * server-side regardless of what the client claims. But CORS is still a real,
 * separate layer, and leaving it at `origin: '*'` actively works against the
 * guard:
 *
 *   - It tells every browser "this resource is shareable with anyone", which
 *     is the exact opposite of the intended posture.
 *   - On an allowed origin it returns the requester's origin, so the browser
 *     lets the calling page READ the response body. On a disallowed origin it
 *     must omit the header entirely, so the browser blocks the read even
 *     though the server already returned 403.
 *   - `Access-Control-Allow-Credentials` must stay false: this API
 *     authenticates with an explicit header, not cookies, so credentialed CORS
 *     would add ambient-authority risk for no benefit.
 *
 * RED showed the wildcard was still live: the response carried
 * `Access-Control-Allow-Origin: *` for a hostile origin.
 *
 * Breaks caught here:
 *   - the wildcard reappearing in any form
 *   - a disallowed origin still receiving an allow-origin header
 *   - an allowed origin receiving the wildcard instead of its own value
 *   - credentials being enabled
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { authHeader } from '../setup/authHelper';

type AppLike = { request: (input: string, init?: RequestInit) => Promise<Response> };

const SECRET = process.env.SECRET_PASSWORD ?? '';
const ALLOWED = 'chrome-extension://test-extension-id';
const HOSTILE = 'https://evil.example';

let app: AppLike;

beforeAll(async () => {
  const mod = await import('../../server/src/index');
  app = (mod as unknown as { app: AppLike }).app ?? (mod as unknown as AppLike);
});

function preflight(origin: string) {
  return app.request('http://localhost/api/step', {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type,x-secret-password',
    },
  });
}

describe('Cycle 2.6 — CORS allowlist', () => {
  it('never returns the wildcard for a preflight from an allowed origin', () => {
    // BREAK: `origin: '*'` surviving anywhere. The wildcard is the signal that
    // the API is shareable with every site.
    return preflight(ALLOWED).then((res) => {
      expect(res.headers.get('access-control-allow-origin')).not.toBe('*');
    });
  });

  it('echoes the requester origin for an allowed origin', () => {
    // BREAK: refusing to echo, which would make the browser block a legitimate
    // extension call — a functional break dressed up as security.
    return preflight(ALLOWED).then((res) => {
      expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED);
    });
  });

  it('omits the allow-origin header for a disallowed origin', () => {
    // BREAK: a disallowed origin still being told it may read the response.
    // The origin guard already 403s; CORS must not contradict that.
    return preflight(HOSTILE).then((res) => {
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    });
  });

  it('does not enable credentialed CORS', () => {
    // BREAK: `credentials: true`. This API uses an explicit auth header, not
    // cookies, so credentials would add ambient-authority risk for no benefit.
    return preflight(ALLOWED).then((res) => {
      expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    });
  });

  it('permits the auth header on an allowed origin', () => {
    // BREAK: the allow-headers list losing the header the extension actually
    // authenticates with, which would break every real browser request.
    //
    // This assertion USED to name `x-secret-password`, and it was correct at
    // the time: that was the auth header. Cycle 2.4 replaced it with an
    // `Authorization: Bearer` token, and this test was never updated — so it
    // kept passing while the live header was missing from the allowlist. The
    // server was rejecting every authenticated browser request and the suite
    // was green.
    //
    // The name is corrected; the break it guards is not weakened. This is the
    // second time this exact assertion has now been caught by something other
    // than the test that owns it.
    return preflight(ALLOWED).then((res) => {
      const allowed = res.headers.get('access-control-allow-headers') ?? '';
      expect(allowed.toLowerCase()).toContain('authorization');
    });
  });

  it('does not advertise the legacy header the server refuses on purpose', () => {
    // The auth middleware rejects `x-secret-password` deliberately. CORS
    // telling a browser it may send a header that is guaranteed to be refused
    // is worse than saying nothing: it produces a confusing failure instead
    // of a clean one.
    return preflight(ALLOWED).then((res) => {
      const allowed = res.headers.get('access-control-allow-headers') ?? '';
      expect(allowed.toLowerCase()).not.toContain('x-secret-password');
    });
  });

  it('does not leak the rejected origin into an allow-origin header', () => {
    // BREAK: a reflection bug turning the check into `origin === requestOrigin`
    // for any value, which is how CORS bypasses happen.
    return preflight(HOSTILE).then((res) => {
      const header = res.headers.get('access-control-allow-origin');
      expect(header === null || header !== HOSTILE).toBe(true);
    });
  });
});
