/**
 * Cycle 3.9 — the server binds to loopback only.
 * ---------------------------------------------------------------------------
 * THE DEFECT
 *
 * `server/.env.example` documents:
 *
 *     HOST=127.0.0.1
 *     # Loopback only. The server must never be reachable off-box.
 *
 * `HOST` was never read anywhere in the codebase. `serve({ fetch, port })` was
 * called with no hostname, and Node's default is to bind every interface. The
 * documented control did not exist.
 *
 * Verified on a real boot in Cycle 3.8: the server answered on the machine's
 * LAN address, not just on 127.0.0.1.
 *
 * WHY IT MATTERS EVEN THOUGH AUTH HELD
 *
 * Authentication was never bypassed — an unauthenticated request still got a
 * 401. This is defense in depth rather than an open door. But the threat it
 * removes is real: anything on the same network segment can reach the pairing
 * endpoint, and the pairing code is the ONLY credential in the design. A
 * machine on an untrusted network (a coffee-shop Wi-Fi, a hotel LAN, a
 * compromised router) gets to talk to the auth surface at all. There is no
 * reason for it to be able to.
 *
 * Also worth noting: `originGuard` blocks browser-origin requests, but a
 * direct request from another machine carries no `Origin` header at all, so
 * the origin guard is not a substitute for not binding.
 *
 * These tests spawn the REAL built server and observe the REAL socket. A test
 * that grepped `src/index.ts` for the string `hostname` would pass against a
 * file that mentions it in a comment, and would not notice the server still
 * binding wide open — which is precisely how the original defect survived.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';

import { build } from '../../server/scripts/build.mjs';

const SERVER_DIR = join(process.cwd(), '..', 'server');
const ARTIFACT = join(SERVER_DIR, 'dist', 'index.js');

/** A non-loopback IPv4 on this machine, i.e. what another host would use. */
function externalAddress(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return null;
}

function canConnect(host: string, port: number, timeoutMs = 1200): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

async function waitForPort(port: number, proc: ChildProcess, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`server exited early (code ${proc.exitCode})`);
    if (await canConnect('127.0.0.1', port, 500)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

let nextPort = 3171 + Math.floor(Math.random() * 40);

interface Booted {
  proc: ChildProcess;
  port: number;
}

/**
 * Boot the real built artifact. Placeholder credentials only — these grant no
 * access to anything, and a live key must never reach a test runner.
 */
function boot(env: Record<string, string>): Booted {
  const port = nextPort++;
  // The child must NOT inherit the test runner's own environment wholesale.
  // Vitest exports VITEST=1, and the server skips serve() entirely when it
  // sees that — so the process would start, never listen, and exit 0. The
  // first run of this test failed for exactly that reason, which is a
  // reminder that a RED has to be RED for the right reason.
  const { VITEST: _vitest, NODE_ENV: _nodeEnv, ...inherited } = process.env;
  const proc = spawn(process.execPath, [ARTIFACT], {
    cwd: SERVER_DIR,
    env: {
      ...inherited,
      PORT: String(port),
      NODE_ENV: 'production',
      SECRET_PASSWORD: 'test-placeholder-not-a-secret',
      GEMINI_API_KEY: 'test-placeholder-not-a-key',
      SECRETS_SIGNING_KEY: 'test-signing-key-placeholder',
      SECRETS_PAIRING_CODE: 'test-pairing-code',
      SESSION_STORAGE_DIR: '/tmp/loopback-test-sessions',
      ...env,
    },
    stdio: 'ignore',
  });
  return { proc, port };
}

const external = externalAddress();
const booted: Booted[] = [];

// HERMETIC BUILD.
//
// This file spawns the built artifact, and `server/dist/` is gitignored — so on
// a fresh CI checkout it does not exist. The first version of the CI workflow
// ran `npm test` with no build step, and this file failed there while passing
// locally, because locally `dist/` happened to be left over from earlier work.
// A test that passes only because of untracked state left by a previous run is
// not a test.
//
// Building here makes the file self-sufficient and matches what
// buildQuality.test.ts already does.
beforeAll(async () => {
  await build();
}, 180_000);

afterAll(() => {
  for (const { proc } of booted) {
    try {
      proc.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
});

describe('Cycle 3.9 — the server is not reachable off-box', () => {
  it('found a non-loopback address to test against', () => {
    // If this fails, every assertion below is vacuous — the same failure mode
    // as Cycle 1.1, where a detection check passed because detection was
    // never actually attempted. Better to fail loudly than to prove nothing.
    expect(external, 'no non-loopback IPv4 on this machine to test against').toBeTruthy();
  });

  it('does NOT listen on a non-loopback interface by default', async () => {
    // BREAK: the defect. `serve({fetch, port})` with no hostname binds every
    // interface, so the server answered on the LAN address.
    const server = boot({});
    booted.push(server);
    expect(await waitForPort(server.port, server.proc)).toBe(true);

    // Sanity: it IS up on loopback. Without this, a server that failed to
    // start at all would "pass" the next assertion.
    expect(await canConnect('127.0.0.1', server.port)).toBe(true);

    expect(
      await canConnect(external!, server.port),
      `server accepted a connection on the external interface ${external} — HOST is not being honoured`,
    ).toBe(false);
  });

  it('honours HOST when it is set explicitly', async () => {
    // BREAK: HOST accepted as configuration but ignored, which is what made
    // the documented control fictional in the first place.
    const server = boot({ HOST: '127.0.0.1' });
    booted.push(server);
    expect(await waitForPort(server.port, server.proc)).toBe(true);
    expect(await canConnect('127.0.0.1', server.port)).toBe(true);
    expect(await canConnect(external!, server.port)).toBe(false);
  });

  it('still refuses a non-loopback HOST rather than silently binding wide', async () => {
    // BREAK: HOST=0.0.0.0 in a .env, quietly restoring the wide bind. A
    // documented "loopback only" posture should not be undoable by editing
    // one line of configuration without noticing.
    const server = boot({ HOST: '0.0.0.0' });
    booted.push(server);
    expect(await waitForPort(server.port, server.proc)).toBe(true);
    expect(
      await canConnect(external!, server.port),
      'HOST=0.0.0.0 widened the bind; a loopback-only posture must be enforced, not merely documented',
    ).toBe(false);
  });
});
