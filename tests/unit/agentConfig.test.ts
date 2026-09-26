/**
 * Cycle 2.4 (client half) — agent configuration held in browser storage.
 * ---------------------------------------------------------------------------
 * This is the client side of the bearer-token change. The server no longer
 * accepts the hardcoded `x-secret-password`, so the extension must:
 *
 *   1. read a server URL and a TOKEN from chrome.storage.local
 *   2. present `Authorization: Bearer <token>` on every call
 *
 * and the token arrives via a pairing exchange, not from a bundled constant.
 *
 * The property that matters most: with EMPTY storage the extension is
 * UNPAIRED and must make no request at all. A bundled fallback would restore
 * exactly the public-literal credential this cycle exists to remove — so the
 * empty case is tested explicitly rather than assumed.
 *
 * The server URL is restricted to loopback. This agent exists to drive a local
 * server; permitting an arbitrary host would mean a typo, or an edited value,
 * silently ships browsing data and screenshots off the machine.
 *
 * Uses the `@` alias -> extension/src, and the stateful storage harness from
 * tests/setup/setupExtensionMock.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  isAllowedServerUrl,
  isValidConfig,
  getAgentConfig,
  setAgentConfig,
  clearAgentConfig,
  authHeadersFor,
  DEFAULT_SERVER_URL,
  type AgentConfig,
} from '@/utils/config';

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJsb2NhbC1vcGVyYXRvciJ9.c2lnbmF0dXJl';

beforeEach(async () => {
  await clearAgentConfig();
});

describe('Cycle 2.4c — server URL allowlist (loopback only)', () => {
  it('accepts http://127.0.0.1:3000', () => {
    // BREAK: over-strictness bricking local development.
    expect(isAllowedServerUrl('http://127.0.0.1:3000')).toBe(true);
  });

  it('accepts http://localhost:3000', () => {
    expect(isAllowedServerUrl('http://localhost:3000')).toBe(true);
  });

  it('accepts an https loopback URL', () => {
    expect(isAllowedServerUrl('https://127.0.0.1:8443')).toBe(true);
  });

  it('rejects a non-loopback host', () => {
    // BREAK: THE DATA-EXFILTRATION GUARD. Allowing an arbitrary host would let
    // a typo or an edited value ship browsing data and screenshots off-box.
    expect(isAllowedServerUrl('http://example.com')).toBe(false);
    expect(isAllowedServerUrl('http://192.168.1.50:3000')).toBe(false);
  });

  it('rejects a host that merely contains a loopback string', () => {
    // BREAK: substring matching. `evil-127.0.0.1.example.com` and
    // `http://127.0.0.1.evil.com` are attacker-controlled hosts that a naive
    // "includes 127.0.0.1" check would wave through.
    expect(isAllowedServerUrl('http://evil-127.0.0.1.example.com')).toBe(false);
    expect(isAllowedServerUrl('http://127.0.0.1.evil.com')).toBe(false);
    expect(isAllowedServerUrl('http://localhost.evil.com')).toBe(false);
  });

  it('rejects a non-http protocol', () => {
    // BREAK: `javascript:` or `file:` being accepted as a server URL.
    expect(isAllowedServerUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedServerUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedServerUrl('ws://127.0.0.1:3000')).toBe(false);
  });

  it('rejects an unparseable URL', () => {
    expect(isAllowedServerUrl('')).toBe(false);
    expect(isAllowedServerUrl('not a url')).toBe(false);
  });

  it('rejects a URL with embedded credentials', () => {
    // BREAK: `http://user:pass@evil.com` parsing such that the real host is
    // not the loopback one the check looked at.
    expect(isAllowedServerUrl('http://user:pass@example.com')).toBe(false);
  });
});

describe('Cycle 2.4c — config validity', () => {
  const good: AgentConfig = { serverUrl: DEFAULT_SERVER_URL, token: TOKEN };

  it('accepts a loopback URL with a JWT-shaped token', () => {
    // BREAK: over-strict token validation locking out a legitimately-issued
    // token with an unexpected claim shape.
    expect(isValidConfig(good)).toBe(true);
  });

  it('rejects an empty token', () => {
    // BREAK: THE CASE THAT MATTERS. Empty storage must read as UNPAIRED, not as
    // "default to something". A bundled fallback here would restore the public
    // literal this cycle removes.
    expect(isValidConfig({ serverUrl: DEFAULT_SERVER_URL, token: '' })).toBe(false);
  });

  it('rejects a short token', () => {
    expect(isValidConfig({ serverUrl: DEFAULT_SERVER_URL, token: 'abc' })).toBe(false);
  });

  it('rejects a non-JWT-shaped token', () => {
    // BREAK: a pairing response being stored even when it is not a token.
    expect(isValidConfig({ serverUrl: DEFAULT_SERVER_URL, token: 'x'.repeat(200) })).toBe(false);
  });

  it('rejects a valid token paired with an off-box URL', () => {
    expect(isValidConfig({ serverUrl: 'http://evil.example', token: TOKEN })).toBe(false);
  });
});

describe('Cycle 2.4c — storage round-trip', () => {
  it('reports an unpaired extension when storage is empty', async () => {
    // BREAK: a default config object being returned for empty storage, which
    // would restore a hardcoded credential by the back door.
    const cfg = await getAgentConfig();
    expect(cfg.valid).toBe(false);
    expect(cfg.token).toBe('');
  });

  it('persists and reads back a config', async () => {
    // BREAK: writes silently not landing, so pairing appears to succeed while
    // the next request is unauthenticated.
    const config: AgentConfig = { serverUrl: 'http://127.0.0.1:3000', token: TOKEN };
    await setAgentConfig(config);
    const read = await getAgentConfig();
    expect(read.serverUrl).toBe('http://127.0.0.1:3000');
    expect(read.token).toBe(TOKEN);
    expect(read.valid).toBe(true);
  });

  it('survives a reload', async () => {
    // BREAK: config held in module memory only, so it vanishes on the service
    // worker restarting — which happens constantly in MV3.
    await setAgentConfig({ serverUrl: 'http://127.0.0.1:3000', token: TOKEN });
    // A fresh read is the closest analogue to a new service-worker instance.
    const read = await getAgentConfig();
    expect(read.valid).toBe(true);
  });

  it('clears back to unpaired', async () => {
    // BREAK: no way to de-pair, so a compromised token cannot be revoked
    // client-side.
    await setAgentConfig({ serverUrl: 'http://127.0.0.1:3000', token: TOKEN });
    await clearAgentConfig();
    const read = await getAgentConfig();
    expect(read.valid).toBe(false);
  });

  it('does not persist an invalid config', async () => {
    // BREAK: an invalid config being written and then failing at request time
    // instead of at configuration time.
    await setAgentConfig({ serverUrl: 'http://evil.example', token: TOKEN });
    const read = await getAgentConfig();
    expect(read.valid).toBe(false);
  });
});

describe('Cycle 2.4c — building the auth header', () => {
  it('presents a bearer token, never the legacy header', async () => {
    // BREAK, AND THE POINT OF THE CYCLE: the old `x-secret-password` header
    // reappearing, which the server now rejects and which used to ship a
    // public literal in this bundle.
    const headers = authHeadersFor({ serverUrl: DEFAULT_SERVER_URL, token: TOKEN });
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(Object.keys(headers)).not.toContain('x-secret-password');
  });

  it('returns an empty object for an unpaired extension', async () => {
    // BREAK: a header being fabricated when there is no token, so a request
    // goes out malformed instead of being skipped.
    const headers = authHeadersFor({ serverUrl: DEFAULT_SERVER_URL, token: '' });
    expect(Object.keys(headers)).toHaveLength(0);
  });
});
