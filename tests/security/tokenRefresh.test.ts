/**
 * Token refresh — POST /api/auth/refresh.
 * ---------------------------------------------------------------------------
 * A full run (up to MAX_STEPS model calls at up to 35 s each plus settling
 * delays) outlasts the 15-minute token TTL, after which every call 401s with
 * no recovery: minting via /api/auth/pair needs the one-time pairing code
 * printed once on the operator's console. This file pins the refresh path:
 *
 *   1. a valid token yields a NEW token (no pairing code required);
 *   2. an EXPIRED token is refused (a refresh that honoured expired tokens
 *      would be a signature bypass, not a refresh);
 *   3. a forged (foreign-key) token is refused;
 *   4. the new token actually works against a protected route.
 *
 * Drives the REAL exported app. New file; no existing test is modified.
 */
import { describe, it, expect } from 'vitest';
import {
  issueToken,
  verifyToken,
  generateSigningKey,
  DEFAULT_TTL_MS,
} from '../../server/src/token';
import { app } from '../../server/src/index';

const ALLOWED = 'chrome-extension://fidbnhfgcadfpjlmdfpnngikjpdhcdcf';
// The values the server itself reads; a freshly generated key would sign
// tokens the server cannot verify (see tokenAuth.test.ts).
const KEY = process.env.SECRETS_SIGNING_KEY ?? '';
const AUDIENCE = 'ztai-agent';

function mint(over: Partial<Parameters<typeof issueToken>[0]> = {}): string {
  return issueToken({ key: KEY, subject: 'local-operator', audience: AUDIENCE, ttlMs: 300_000, ...over });
}

function refresh(token: string | null): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Origin: ALLOWED,
  };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return app.request('http://localhost/api/auth/refresh', {
    method: 'POST',
    headers,
    body: JSON.stringify({}),
  });
}

describe('POST /api/auth/refresh', () => {
  it('refreshes a valid token without the pairing code', async () => {
    // BREAK: long runs dying mid-mission at the 15-minute mark with no
    // recovery path that does not need the operator at the console.
    const old = mint();
    const res = await refresh(old);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token?: string; expiresIn?: number };
    expect(typeof body.token).toBe('string');
    expect(body.token?.split('.')).toHaveLength(3);
    expect(body.expiresIn).toBe(DEFAULT_TTL_MS);
    // A fresh jti means a genuinely new token, not an echo.
    expect(body.token).not.toBe(old);
  });

  it('issues a new token with a fresh (later) expiry', async () => {
    const old = mint({ ttlMs: 60_000 });
    const res = await refresh(old);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string };
    const oldClaims = verifyToken(old, { key: KEY, audience: AUDIENCE });
    const newClaims = verifyToken(body.token, { key: KEY, audience: AUDIENCE });
    expect(newClaims.exp).toBeGreaterThan(oldClaims.exp);
    expect(newClaims.sub).toBe(oldClaims.sub);
    expect(newClaims.aud).toBe(AUDIENCE);
  });

  it('refuses an EXPIRED token', async () => {
    // BREAK, AND THE LOAD-BEARING ASSERTION: honouring an expired token here
    // would turn this endpoint into a signature bypass.
    const expired = mint({ ttlMs: -1_000 });
    const res = await refresh(expired);
    expect(res.status).toBe(401);
  });

  it('refuses a forged token signed with a foreign key', async () => {
    const forged = issueToken({
      key: generateSigningKey(),
      subject: 'local-operator',
      audience: AUDIENCE,
      ttlMs: 300_000,
    });
    const res = await refresh(forged);
    expect(res.status).toBe(401);
  });

  it('refuses a token minted for a different audience', async () => {
    const res = await refresh(mint({ audience: 'another-service' }));
    expect(res.status).toBe(401);
  });

  it('refuses a request with no bearer token', async () => {
    const res = await refresh(null);
    expect(res.status).toBe(401);
  });

  it('the refreshed token actually works against a protected route', async () => {
    const res = await refresh(mint());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string };
    const protectedRes = await app.request('http://localhost/api/system-telemetry', {
      headers: { Origin: ALLOWED, Authorization: `Bearer ${body.token}` },
    });
    expect(protectedRes.status).toBe(200);
  });
});
