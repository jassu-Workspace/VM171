/**
 * Cycle 3.9 review follow-up — the operator can actually use this thing.
 * ---------------------------------------------------------------------------
 * THREE DEFECTS FOUND WHILE UPDATING THE LAUNCHER SCRIPTS
 *
 * 1. CORS DID NOT PERMIT THE `Authorization` HEADER.
 *
 *    `cors({ allowHeaders: ['Content-Type', 'x-secret-password'] })`. The
 *    extension authenticates with `Authorization: Bearer <jwt>` — that header
 *    was added in Cycle 2.4 and the allowlist was never updated. A browser
 *    preflights any cross-origin request carrying a non-simple header, and
 *    answers a preflight it does not sanction with a failure, so every
 *    authenticated call from the extension would have been blocked.
 *
 *    This is exactly the class of bug a passing smoke test misses: the Cycle
 *    3.8 smoke test used curl, which does not preflight, so it exercised the
 *    happy path and reported 200 while a real browser would fail. The lesson
 *    generalises — a smoke test must reproduce the client's actual behaviour,
 *    and a browser client's behaviour includes preflight.
 *
 * 2. THE PAIRING CODE WAS NEVER PRINTED.
 *
 *    `PAIRING_CODE` is generated on boot and validated on use, but never
 *    logged. `server/.env.example` states that boot "prints BOTH to the
 *    console". It did not. So an operator who did not happen to set
 *    SECRETS_PAIRING_CODE had no way to learn the code, and the extension
 *    could not be paired at all. Cycle 2.4 shipped non-functional on the
 *    default path — the tests passed because they injected a known code.
 *
 * 3. THE BOOT BANNER REPORTED A HEADER THAT IS NO LONGER ACCEPTED.
 *
 *    It printed `Auth header: x-secret-password`, while the auth middleware
 *    carries an explicit comment that the legacy header is NO LONGER
 *    ACCEPTED, deliberately. An operator reading the banner would build an
 *    integration against a header that fails.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { build } from '../../server/scripts/build.mjs';
import { DEFAULT_ALLOWED_ORIGINS } from '../../server/src/originGuard';

const SERVER_DIR = join(process.cwd(), '..', 'server');
const ARTIFACT = join(SERVER_DIR, 'dist', 'index.js');
const PORT = 3291;

let proc: ChildProcess;
let boot = '';

// HERMETIC BUILD — see the note in loopbackBinding.test.ts. Same defect, same fix.
beforeAll(async () => {
  await build();
  const { VITEST: _v, NODE_ENV: _n, ...inherited } = process.env;
  proc = spawn(process.execPath, [ARTIFACT], {
    cwd: SERVER_DIR,
    env: {
      ...inherited,
      PORT: String(PORT),
      NODE_ENV: 'production',
      SECRET_PASSWORD: 'test-placeholder-not-a-secret',
      GEMINI_API_KEY: 'test-placeholder-not-a-key',
      SECRETS_SIGNING_KEY: 'test-signing-key-placeholder',
      SESSION_STORAGE_DIR: '/tmp/pairing-test-sessions',
      // SECRETS_PAIRING_CODE is deliberately NOT set — that is the default
      // path, and it is the one that was broken.
      //
      // It is also CLEARED rather than merely omitted. The server treats a
      // present-but-empty value as unset and generates a code, and an earlier
      // run of this test silently inherited SECRETS_PAIRING_CODE from the
      // ambient shell, took the "pinned" branch, and failed for a reason that
      // had nothing to do with the defect. A test whose result depends on the
      // environment it happens to be launched in is not a test.
      SECRETS_PAIRING_CODE: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout?.on('data', (d) => (boot += d.toString()));
  proc.stderr?.on('data', (d) => (boot += d.toString()));

  // Wait for the END of the boot banner, not its start.
  //
  // This originally waited for "ONLINE", which was the last line the banner
  // used to print. The pairing block was appended AFTER it, so the assertions
  // below ran before the line they were checking had been written — a test
  // that passed or failed according to log ordering rather than behaviour.
  // The trailing pairing line is a stable end-of-banner marker.
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    if (/one-time; needed once/i.test(boot)) break;
    if (proc.exitCode !== null) throw new Error(`server exited early:\n${boot}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}, 240_000);

afterAll(() => {
  try {
    proc?.kill('SIGTERM');
  } catch {
    /* already gone */
  }
});

describe('Cycle 3.9 — the browser preflight the curl smoke test never sent', () => {
  it('sanctions the Authorization header on preflight', async () => {
    // BREAK: allowHeaders listing only Content-Type and the dead
    // x-secret-password, so every authenticated browser request is blocked.
    const origin = DEFAULT_ALLOWED_ORIGINS[0];
    const res = await fetch(`http://127.0.0.1:${PORT}/api/step`, {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
    });
    const allowed = res.headers.get('access-control-allow-headers') ?? '';
    expect(allowed.toLowerCase()).toContain('authorization');
  });

  it('no longer advertises the header that is deliberately rejected', async () => {
    // BREAK: the banner and the CORS allowlist both still naming
    // x-secret-password, which the auth middleware refuses on purpose.
    const origin = DEFAULT_ALLOWED_ORIGINS[0];
    const res = await fetch(`http://127.0.0.1:${PORT}/api/step`, {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    expect((res.headers.get('access-control-allow-headers') ?? '').toLowerCase()).not.toContain(
      'x-secret-password',
    );
  });
});

describe('Cycle 3.9 — the operator can learn the pairing code', () => {
  it('prints a pairing code on boot when none is configured', () => {
    // BREAK: PAIRING_CODE generated but never logged, so the default path
    // could not be paired at all. This is the whole cycle.
    expect(boot).toContain('ONLINE');
    expect(boot.toLowerCase()).toMatch(/pairing code/);
  });

  it('prints a code an operator can actually type', () => {
    // BREAK: printing the label with no value, or a redacted placeholder.
    // The redactor would also mangle a short generated code, so this asserts
    // the value survives to the console.
    const match = boot.match(/pairing code[:\s]+([A-Za-z0-9-]{6,})/i);
    expect(match, `no pairing code value found in boot output:\n${boot.slice(-800)}`).toBeTruthy();
    expect(match![1].length).toBeGreaterThanOrEqual(6);
  });

  it('does not print the signing key alongside it', () => {
    // BREAK: printing the signing key too. The pairing code is a one-time
    // user-facing credential; the signing key is not, and echoing it widens
    // the blast radius of a shoulder-surf or a pasted terminal.
    expect(boot).not.toContain('test-signing-key-placeholder');
  });

  it('reports the auth scheme the server actually enforces', () => {
    // BREAK: the banner printing `Auth header: x-secret-password` while the
    // middleware explicitly refuses that header.
    expect(boot).not.toMatch(/Auth header:\s*x-secret-password/i);
    expect(boot.toLowerCase()).toMatch(/bearer/);
  });
});
