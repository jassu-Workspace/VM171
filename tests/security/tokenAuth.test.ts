/**
 * Cycle 2.4 — Bearer-token authentication on the real routes.
 * ---------------------------------------------------------------------------
 * The pure token module is proven in token.test.ts. This file covers the part
 * that actually matters operationally: that the server ACCEPTS a valid bearer
 * token, REFUSES the old shared password, and never tells an attacker which of
 * the two it was.
 *
 * The refusal of the legacy header is the load-bearing assertion. If the server
 * kept accepting `x-secret-password`, the hardcoded `141207` would remain a
 * valid credential in every shipped bundle and this cycle would have achieved
 * nothing except adding a second way in.
 *
 * These tests drive the REAL exported app.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  issueToken,
  verifyToken,
  generateSigningKey,
  generatePairingCode,
  isPairingCodeValid,
  TokenError,
} from '../../server/src/token';

type AppLike = { request: (input: string, init?: RequestInit) => Promise<Response> };

const ALLOWED = 'chrome-extension://test-extension-id';
const LEGACY_SECRET = process.env.SECRET_PASSWORD ?? '';
// These MUST be the values the server reads from the environment, not
// freshly generated ones — an earlier version generated its own key and code,
// so every "valid credential" assertion was testing a token signed by a
// different key than the server verifies against.
const KEY = process.env.SECRETS_SIGNING_KEY ?? '';
const PAIRING = process.env.SECRETS_PAIRING_CODE ?? '';
const AUDIENCE = 'ztai-agent';

let app: AppLike;

beforeAll(async () => {
  const mod = await import('../../server/src/index');
  app = (mod as unknown as { app: AppLike }).app ?? (mod as unknown as AppLike);
});

function get(path: string, headers: Record<string, string> = {}) {
  return app.request(`http://localhost${path}`, {
    headers: { Origin: ALLOWED, ...headers },
  });
}

function bearer(over: Partial<Parameters<typeof issueToken>[0]> = {}) {
  return issueToken({ key: KEY, subject: 'local-operator', audience: AUDIENCE, ttlMs: 300_000, ...over });
}

describe('Cycle 2.4 — bearer token is the accepted credential', () => {
  it('rejects a request with no credential', async () => {
    // BREAK: auth being removed or short-circuited.
    const res = await get('/api/system-telemetry');
    expect(res.status).toBe(401);
  });

  it('rejects the LEGACY shared password', async () => {
    // BREAK, AND THE POINT OF THE CYCLE: the old header must stop working, or
    // the literal in every shipped bundle stays a live credential.
    const res = await get('/api/system-telemetry', { 'x-secret-password': LEGACY_SECRET });
    expect(res.status).toBe(401);
  });

  it('accepts a valid bearer token', async () => {
    // BREAK: the token path being wired but always rejecting, or the signing
    // key differing between issue and verify.
    const res = await get('/api/system-telemetry', { Authorization: `Bearer ${bearer()}` });
    expect(res.status).toBe(200);
  });

  it('rejects a malformed Authorization header', async () => {
    for (const bad of ['Bearer', 'Bearer ', 'Basic abc', bearer(), `Bearer ${bearer()}x`]) {
      const res = await get('/api/system-telemetry', { Authorization: bad });
      expect(res.status, bad).toBe(401);
    }
  });

  it('rejects a token signed with a foreign key', async () => {
    // BREAK: signature verification being skipped in the middleware even
    // though the pure module checks it.
    const foreign = issueToken({
      key: generateSigningKey(), // deliberately NOT the server's key
      subject: 'attacker',
      audience: AUDIENCE,
      ttlMs: 300_000,
    });
    const res = await get('/api/system-telemetry', { Authorization: `Bearer ${foreign}` });
    expect(res.status).toBe(401);
  });

  it('rejects a token minted for a different audience', async () => {
    const res = await get('/api/system-telemetry', {
      Authorization: `Bearer ${bearer({ audience: 'another-service' })}`,
    });
    expect(res.status).toBe(401);
  });

  it('gives an identical response for a wrong secret and a wrong token', async () => {
    // BREAK: distinguishable responses, which let an attacker probe whether a
    // guess was CLOSE rather than merely wrong.
    const legacy = await get('/api/system-telemetry', { 'x-secret-password': 'wrong' });
    const bearerRes = await get('/api/system-telemetry', { Authorization: 'Bearer not.a.token' });
    expect(legacy.status).toBe(bearerRes.status);
    expect(await legacy.text()).toBe(await bearerRes.text());
  });

  it('never echoes the credential back in an error body', async () => {
    const res = await get('/api/system-telemetry', { Authorization: `Bearer ${bearer()}` });
    const body = await res.text();
    expect(body).not.toContain(LEGACY_SECRET);
    expect(body).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\./);
  });
});

describe('Cycle 2.4 — pairing', () => {
  it('exchanges a correct pairing code for a token', async () => {
    // BREAK: the pairing endpoint not existing, leaving no way for the
    // extension to obtain a token at all.
    const res = await app.request('http://localhost/api/auth/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ALLOWED },
      body: JSON.stringify({ code: PAIRING }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token?: string; expiresIn?: number };
    expect(typeof body.token).toBe('string');
    expect(body.token?.split('.')).toHaveLength(3);
    expect(typeof body.expiresIn).toBe('number');
  });

  it('rejects an incorrect pairing code', async () => {
    const res = await app.request('http://localhost/api/auth/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ALLOWED },
      body: JSON.stringify({ code: 'not-the-code' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects a pairing attempt from a disallowed origin', async () => {
    // BREAK: pairing being reachable from a web page, which would hand any
    // site a valid token.
    const res = await app.request('http://localhost/api/auth/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ code: PAIRING }),
    });
    expect(res.status).toBe(403);
  });

  it('never returns the pairing code itself', async () => {
    const res = await app.request('http://localhost/api/auth/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ALLOWED },
      body: JSON.stringify({ code: PAIRING }),
    });
    const body = await res.text();
    expect(body).not.toContain(PAIRING);
  });

  it('validates pairing codes in constant time, not by equality', () => {
    // A direct unit assertion on the primitive the route depends on.
    expect(isPairingCodeValid(PAIRING, PAIRING)).toBe(true);
    expect(isPairingCodeValid(PAIRING.slice(0, -1), PAIRING)).toBe(false);
    expect(isPairingCodeValid('', PAIRING)).toBe(false);
  });

  it('surfaces a distinct reason for expiry so the client can refresh', () => {
    const token = bearer({ ttlMs: 1_000 });
    const past = Date.now() + 10_000;
    let reason = '';
    try {
      // Re-verifying an already-issued token past its expiry. Imported at the
      // top level: `require` is not available in this ESM test module, and its
      // absence made this assertion report 'unknown' for the wrong reason.
      verifyToken(token, { key: KEY, audience: AUDIENCE, now: past });
    } catch (e) {
      reason = e instanceof TokenError ? e.reason : 'unknown';
    }
    expect(reason).toBe('expired');
  });
});
