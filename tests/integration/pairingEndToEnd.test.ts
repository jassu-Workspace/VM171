/**
 * Cycle 2.4 (client half) — end-to-end pairing against the real server.
 * ---------------------------------------------------------------------------
 * The unit tests prove each piece: the token module issues and verifies, the
 * config module stores and reads, the validators accept and refuse. None of
 * that proves the two halves FIT — that a code minted by the real server
 * endpoint is accepted by the real auth middleware, and that the legacy header
 * is dead end to end.
 *
 * That is what this file does, and it is the test that would have caught the
 * half-finished state where the server had moved to bearer tokens but the
 * extension still sent `x-secret-password`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  getAgentConfig,
  setAgentConfig,
  clearAgentConfig,
  authHeadersFor,
} from '@/utils/config';

type AppLike = { request: (input: string, init?: RequestInit) => Promise<Response> };

const ALLOWED = 'chrome-extension://test-extension-id';
const PAIRING = process.env.SECRETS_PAIRING_CODE ?? '';

let app: AppLike;

beforeAll(async () => {
  const mod = await import('../../server/src/index');
  app = (mod as unknown as { app: AppLike }).app ?? (mod as unknown as AppLike);
});

beforeEach(async () => {
  await clearAgentConfig();
});

afterAll(async () => {
  await clearAgentConfig();
});

/** What the Options page does on "Pair". */
async function pairAsOperatorWould(serverUrl: string, code: string) {
  const res = await app.request('http://localhost/api/auth/pair', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ALLOWED },
    body: JSON.stringify({ code }),
  });

  if (!res.ok) return { ok: false as const, status: res.status, token: '' };

  const body = (await res.json()) as { token?: string };
  if (!body.token) return { ok: false as const, status: res.status, token: '' };

  const saved = await setAgentConfig({ serverUrl, token: body.token });
  return { ok: saved, status: res.status, token: body.token };
}

describe('Cycle 2.4c — the full pairing exchange works end to end', () => {
  it('exchanges the console code for a token the server then accepts', async () => {
    // BREAK: any half-finished migration. The server issuing a token the auth
    // middleware will not honour, or the client failing to store it.
    const paired = await pairAsOperatorWould('http://127.0.0.1:3000', PAIRING);
    expect(paired.ok).toBe(true);
    expect(paired.token.split('.')).toHaveLength(3);

    const config = await getAgentConfig();
    expect(config.valid).toBe(true);

    // The token the extension stored must actually work on a protected route.
    const res = await app.request('http://localhost/api/system-telemetry', {
      headers: { Origin: ALLOWED, ...authHeadersFor(config) },
    });
    expect(res.status).toBe(200);
  });

  it('refuses a protected route with the legacy header even after pairing', async () => {
    // BREAK, AND THE POINT OF THE CYCLE: the old literal remaining a live
    // credential. If this returns 200, the bundle still ships a working secret.
    await pairAsOperatorWould('http://127.0.0.1:3000', PAIRING);

    const res = await app.request('http://localhost/api/system-telemetry', {
      headers: { Origin: ALLOWED, 'x-secret-password': '141207' },
    });
    expect(res.status).toBe(401);
  });

  it('refuses a protected route while unpaired', async () => {
    // BREAK: a default config being fabricated so the extension "works" out of
    // the box — which is how the public literal came back the first time.
    const config = await getAgentConfig();
    expect(config.valid).toBe(false);

    const res = await app.request('http://localhost/api/system-telemetry', {
      headers: { Origin: ALLOWED, ...authHeadersFor(config) },
    });
    expect(res.status).toBe(401);
  });

  it('does not pair from a disallowed origin', async () => {
    // BREAK: pairing reachable from a web page, which would hand any site a
    // token and undo the entire cycle.
    const res = await app.request('http://localhost/api/auth/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ code: PAIRING }),
    });
    expect(res.status).toBe(403);
  });

  it('rejects a wrong pairing code without issuing a token', async () => {
    const res = await app.request('http://localhost/api/auth/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ALLOWED },
      body: JSON.stringify({ code: 'not-the-real-code-at-all' }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { token?: string };
    expect(body.token).toBeUndefined();
  });
});
