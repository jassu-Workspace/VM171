/**
 * Cycle 2.11 — Telemetry must not be a host fingerprint.
 * ---------------------------------------------------------------------------
 * GET /api/system-telemetry returned, to anyone holding the shared secret:
 *
 *   cpuModel, cpuCount, loadAvg, platform, arch,
 *   totalMemBytes, freeMemBytes, usedMemBytes, memUsagePercent,
 *   heapUsedBytes, heapTotalBytes, rssBytes, totalDiskBytes
 *
 * Individually each is unremarkable. Together they are a precise hardware and
 * OS fingerprint, and this endpoint was reachable from ANY web page until
 * Cycle 2.5 closed that. The secret was also a public literal in the extension
 * bundle, so for the whole life of the project the fingerprint was public.
 *
 * The distinction that matters: an operator needs to know the server is alive
 * and how much work it has done. They do NOT need the CPU model to make that
 * decision. So the default response keeps operational fields and drops
 * fingerprint fields; the latter move behind TELEMETRY_VERBOSE for local
 * debugging, off by default.
 *
 * The Cycle 1.4 redaction accounting STAYS in the default response. That is
 * precisely the kind of field this endpoint exists for, and removing it would
 * reintroduce the "permanently-invisible degradation" problem.
 *
 * These tests drive the REAL exported app.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { authHeader } from '../setup/authHelper';

type AppLike = { request: (input: string, init?: RequestInit) => Promise<Response> };

const SECRET = process.env.SECRET_PASSWORD ?? '';
const ALLOWED = 'chrome-extension://test-extension-id';

let app: AppLike;

beforeAll(async () => {
  const mod = await import('../../server/src/index');
  app = (mod as unknown as { app: AppLike }).app ?? (mod as unknown as AppLike);
});

async function telemetry() {
  const res = await app.request('http://localhost/api/system-telemetry', {
    headers: { ...authHeader(), Origin: ALLOWED },
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Fingerprint fields that must not be present in the default response. */
const FINGERPRINT_FIELDS = [
  'cpuModel',
  'loadAvg',
  'platform',
  'arch',
  'totalMemBytes',
  'freeMemBytes',
  'usedMemBytes',
  'memUsagePercent',
];

describe('Cycle 2.11 — the default telemetry response is not a fingerprint', () => {
  it('answers 200 with the secret', async () => {
    // BREAK: over-restricting the endpoint into uselessness.
    const { status } = await telemetry();
    expect(status).toBe(200);
  });

  it('requires the secret', async () => {
    // BREAK: the fingerprint fields being protected only by the origin guard
    // while the endpoint itself is public.
    const res = await app.request('http://localhost/api/system-telemetry', {
      headers: { Origin: ALLOWED },
    });
    expect(res.status).toBe(401);
  });

  for (const field of FINGERPRINT_FIELDS) {
    it(`omits ${field} by default`, async () => {
      // BREAK: any fingerprint field reappearing in the default response.
      const { body } = await telemetry();
      const system = (body.system ?? {}) as Record<string, unknown>;
      expect(Object.keys(system)).not.toContain(field);
      expect(JSON.stringify(body)).not.toContain(`"${field}"`);
    });
  }

  it('keeps the operational fields an operator actually needs', async () => {
    // BREAK: stripping so aggressively that the endpoint stops earning its
    // keep. Liveness and work-done are the reason it exists.
    const { body } = await telemetry();
    expect(body.status).toBe('online');
    expect(typeof body.timestamp).toBe('string');

    const process_ = (body.process ?? {}) as Record<string, unknown>;
    expect(typeof process_.uptimeSeconds).toBe('number');
    expect(typeof process_.heapUsedBytes).toBe('number');
  });

  it('keeps the Cycle 1.4 redaction accounting visible', async () => {
    // BREAK: dropping the degradation counters while fingerprinting. Those
    // counters are the whole reason this endpoint is worth calling, and losing
    // them would make a degraded run invisible again.
    const { body } = await telemetry();
    const redaction = body.redaction as Record<string, unknown> | undefined;
    expect(redaction).toBeDefined();
    expect(typeof redaction?.degradedSteps).toBe('number');
    expect(typeof redaction?.unavailableSteps).toBe('number');
    expect(typeof redaction?.policy).toBe('string');
  });

  it('never exposes the auth secret or any API key', async () => {
    // BREAK: a config dump leaking into telemetry, which would then land in
    // storage/server_logs.jsonl and any CI log that scraped the response.
    const { body } = await telemetry();
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain(SECRET);
    expect(serialised).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
    expect(serialised).not.toMatch(/AIza[A-Za-z0-9_-]{10,}/);
  });

  it('does not echo the process environment', async () => {
    const { body } = await telemetry();
    expect(JSON.stringify(body)).not.toMatch(/process\.env/);
  });
});
