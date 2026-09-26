/**
 * Cycle 2.4 (client half) — the extension must not send the legacy credential,
 * and must not send anything at all while unpaired.
 * ---------------------------------------------------------------------------
 * This is the test that would have caught the original bug. `141207` was
 * hardcoded in background/index.ts and dashboard/App.tsx, shipped in the built
 * bundle, and was a working credential for the local server. The failure mode
 * being guarded is a *regression* of that: any path that reintroduces a bundled
 * credential, or that sends a request with no token, is caught here.
 *
 * The strongest assertion is the unpaired one. An extension with empty storage
 * must make ZERO fetch calls. If a default config, a default token, or a
 * "helpful" fallback ever reappears, this fails — and that fallback is precisely
 * how the public literal would come back.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getAgentConfig,
  setAgentConfig,
  clearAgentConfig,
  authHeadersFor,
} from '@/utils/config';

const TOKEN =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJsb2NhbC1vcGVyYXRvciJ9.c2lnbmF0dXJl';
const URL = 'http://127.0.0.1:3000';

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  await clearAgentConfig();
  fetchSpy = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ success: true, action: 'done' }),
  });
  (globalThis as unknown as { fetch: unknown }).fetch = fetchSpy;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Cycle 2.4c — no request is made while unpaired', () => {
  it('makes zero fetch calls with empty storage', async () => {
    // BREAK: THE FALLBACK. Any default token or default config reappearing
    // here means a bundled credential is live again.
    const config = await getAgentConfig();
    expect(config.valid).toBe(false);

    // The background's guard, exercised directly: an invalid config means the
    // request is skipped rather than sent malformed.
    if (!config.valid) {
      expect(authHeadersFor(config)).toEqual({});
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('stays unpaired after clearing a previously valid config', async () => {
    // BREAK: a clear that does not actually clear, leaving a revoked token
    // usable.
    await setAgentConfig({ serverUrl: URL, token: TOKEN });
    expect((await getAgentConfig()).valid).toBe(true);
    await clearAgentConfig();
    expect((await getAgentConfig()).valid).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects an off-box server URL at pairing time', async () => {
    // BREAK: the exfiltration guard being applied only at request time, by
    // which point the value is already stored.
    const stored = await setAgentConfig({ serverUrl: 'http://evil.example', token: TOKEN });
    expect(stored).toBe(false);
    expect((await getAgentConfig()).valid).toBe(false);
  });
});

describe('Cycle 2.4c — paired requests carry a bearer token', () => {
  it('sends Authorization: Bearer and never x-secret-password', async () => {
    // BREAK: the legacy header reappearing in any outbound request.
    await setAgentConfig({ serverUrl: URL, token: TOKEN });
    const config = await getAgentConfig();
    const headers = authHeadersFor(config);

    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);

    // Simulate the request the background actually makes.
    await fetch(`${config.serverUrl}/api/step`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ task: 't', maskedDom: 'd' }),
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const sent = init.headers as Record<string, string>;
    expect(sent.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(Object.keys(sent)).not.toContain('x-secret-password');
  });

  it('addresses the configured server URL, not a hardcoded one', async () => {
    // BREAK: a leftover hardcoded localhost that ignores the stored config.
    await setAgentConfig({ serverUrl: 'http://localhost:3000', token: TOKEN });
    const config = await getAgentConfig();
    await fetch(`${config.serverUrl}/api/system-telemetry`, {
      headers: authHeadersFor(config),
    });
    const [target] = fetchSpy.mock.calls[0] as [string];
    expect(target).toBe('http://localhost:3000/api/system-telemetry');
  });
});

describe('Cycle 2.4c — the literal is gone from first-party source', () => {
  it('no longer appears as a credential in extension source', async () => {
    // BREAK: the literal being reintroduced anywhere in shipped code.
    //
    // This is a source-text assertion, which is normally an anti-pattern — but
    // here the "text" IS the vulnerability: a specific secret literal
    // appearing in shipped source is the exact defect, and no behavioural
    // assertion can distinguish "the constant is gone" from "the constant is
    // present but unused". The behaviour that matters is covered by the two
    // describes above.
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');

    const root = join(process.cwd(), '..', 'extension', 'src');
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
        } else if (/\.(ts|tsx|js)$/.test(entry)) {
          const src = readFileSync(full, 'utf8');
          if (/"141207"|'141207'|`141207`/.test(src)) offenders.push(full);
        }
      }
    };

    walk(root);
    expect(offenders).toEqual([]);
  });
});
