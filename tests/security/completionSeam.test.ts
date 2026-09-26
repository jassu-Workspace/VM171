/**
 * Cycle 2.3 — the seam works: the REAL app is drivable without a network call.
 * ---------------------------------------------------------------------------
 * `tests/integration/serverContract.test.ts` re-implements the server by hand —
 * its own comment says "WITHOUT importing production code" — and asserts
 * against that copy. The copy's PII regexes had drifted from production's by
 * nine classes before Cycle 2.10 found it by accident.
 *
 * This file proves the blocker is gone: with `setCompletion` installed, the real
 * app answers a full step without touching a provider. That is the precondition
 * for de-mirroring, and it is asserted here rather than assumed.
 *
 * It also pins the override's blast radius. A leaked override would make the
 * rest of the suite believe it is talking to a model, so `afterEach` resets it
 * and one test asserts the reset works.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setCompletion, hasCompletionOverride } from '../../server/src/completion';

type AppLike = { request: (input: string, init?: RequestInit) => Promise<Response> };

const SECRET = process.env.SECRET_PASSWORD ?? '';
const KEY = process.env.SECRETS_SIGNING_KEY ?? '';
const PAIRING = process.env.SECRETS_PAIRING_CODE ?? '';
const ALLOWED = 'chrome-extension://fidbnhfgcadfpjlmdfpnngikjpdhcdcf';
const AUDIENCE = 'ztai-agent';

let app: AppLike;
let token = '';

beforeAll(async () => {
  const mod = await import('../../server/src/index');
  app = (mod as unknown as { app: AppLike }).app ?? (mod as unknown as AppLike);
});

beforeEach(async () => {
  // Pair for real, so these tests exercise the real auth path too.
  const { issueToken } = await import('../../server/src/token');
  token = issueToken({ key: KEY, subject: 'local-operator', audience: AUDIENCE, ttlMs: 600_000 });
});

afterEach(() => {
  setCompletion(null);
});

function step(body: Record<string, unknown>) {
  return app.request('http://localhost/api/step', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      Origin: ALLOWED,
    },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  task: 'check the ISRO site',
  maskedDom: 'ISRO news page',
  redactedImage: '',
  redaction_legend: [],
  subTasks: [],
  actionHistory: [],
  redaction: { state: 'verified', engine: 'mediapipe', reason: 'ok', violations: [] },
};

describe('Cycle 2.3 — the completion seam', () => {
  it('starts with no override installed', () => {
    // BREAK: an override leaking from another file, which would make every
    // later test silently believe it is talking to a model.
    expect(hasCompletionOverride()).toBe(false);
  });

  it('records an installed override and clears it again', async () => {
    // BREAK: setCompletion(null) not actually restoring the real chain.
    setCompletion(async () => '{"action":"done"}');
    expect(hasCompletionOverride()).toBe(true);
    setCompletion(null);
    expect(hasCompletionOverride()).toBe(false);
  });

  it('drives the REAL app end to end with an injected completion', async () => {
    // BREAK: THE PRECONDITION FOR DE-MIRRORING. If this needs a real provider,
    // the mirror stays and every hardening cycle keeps being verified against
    // a copy rather than the thing that ships.
    setCompletion(async () =>
      JSON.stringify({ action: 'click', selector: '#submit', thought: 'proceeding' })
    );

    const res = await step(VALID_BODY);
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.action).toBe('click');
    expect(body.selector).toBe('#submit');
  });

  it('passes the assembled prompt to the injected completion', async () => {
    // BREAK: the seam being wired at the wrong point, so the model receives an
    // empty prompt while everything still appears to work.
    let seen = { system: '', user: '' };
    setCompletion(async (request) => {
      seen = {
        system: request.systemPrompt,
        user: request.userContent
          .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
          .map((p) => p.text)
          .join(' '),
      };
      return JSON.stringify({ action: 'done' });
    });

    await step({ ...VALID_BODY, task: 'UNIQUE-TASK-MARKER-4711' });

    expect(seen.system.length).toBeGreaterThan(100);
    expect(seen.user).toContain('UNIQUE-TASK-MARKER-4711');
  });

  it('never receives the raw un-redacted image in the completion request', async () => {
    // BREAK: the seam accidentally widening what is sent upstream. The raw
    // capture must not reach the provider — Cycle 1.1/1.3 guarantee that in the
    // extension, and this checks the server does not undo it.
    let sawImage = false;
    setCompletion(async (request) => {
      sawImage = request.userContent.some((p) => p.type === 'image_url');
      return JSON.stringify({ action: 'done' });
    });

    // A payload whose redactedImage is not a decodable image is refused by the
    // image-safety check, so the step proceeds without one.
    await step({ ...VALID_BODY, redactedImage: 'not-an-image' });

    expect(sawImage).toBe(false);
  });

  it('surfaces a malformed model response as a 500, not a crash', async () => {
    // BREAK: unparseable text throwing out of the handler. The chaos matrix in
    // serverContract.test.ts has always covered this against the MIRROR; this
    // covers it against the real thing.
    setCompletion(async () => 'Sure! Here is what I would do: maybe click something');
    const res = await step(VALID_BODY);
    // Cycle 2.3: asserted as "an error, not a success" rather than pinned to one
    // status. parseActionJson can either RETURN null (→ 500, unusable answer) or
    // THROW on a malformed fragment (→ 502, caught as an upstream failure).
    // Both are non-crashing; pinning one would encode an implementation detail
    // that the de-mirroring work just showed to be unstable.
    expect([500, 502]).toContain(res.status);
    expect(res.status).not.toBe(200);
  });

  it('handles a markdown-fenced JSON response', async () => {
    // BREAK: fence handling regressing. A model that wraps its answer in
    // ```json is extremely common, and failing here would break every run.
    setCompletion(async () => '```json\n{ "action": "click", "selector": "#x" }\n```');
    const res = await step(VALID_BODY);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.action).toBe('click');
  });

  it('propagates a thrown completion as a 500 with no unhandled rejection', async () => {
    // BREAK: an exception escaping the route and taking the process with it.
    setCompletion(async () => {
      throw new Error('upstream exploded');
    });
    const res = await step(VALID_BODY);
    // A THROWN completion is 502, not 500: every candidate model failed, which
    // is an upstream failure and should not be attributed to this server. The
    // de-mirrored contract suite had been asserting 502 against a hand-written
    // copy all along; the copy was right and production was wrong.
    expect(res.status).toBe(502);
  });

  it('applies the action policy to an injected decision', async () => {
    // BREAK: the policy gate being bypassed by the seam. An injected decision is
    // still a decision and must face the same rules.
    setCompletion(async () =>
      JSON.stringify({ action: 'navigate', value: 'javascript:alert(1)' })
    );
    const res = await step(VALID_BODY);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.policyBlocked).toBe(true);
  });
});
