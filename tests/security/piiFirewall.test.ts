/**
 * Cycle 2.10 — PII firewall regression, against the REAL route.
 * ---------------------------------------------------------------------------
 * WHY THIS IS A CHARACTERIZATION TEST, NOT A NORMAL ONE
 *
 * `checkFirewallViolations` already exists and already fails closed. There is
 * nothing new to build, so the usual RED-then-GREEN cycle does not apply.
 * Instead the test earns trust by MUTATION PROVING: the firewall is disabled,
 * every rejection test must go RED, and only then is it restored. A test that
 * cannot fail when the thing it covers is removed is decoration.
 *
 * WHY IT MATTERS MORE NOW THAN BEFORE
 *
 * 1. Finding N8 — the mirror in serverContract.test.ts had DRIFTED from
 *    production. Its regex set covered CARD, PRIVATE_KEY, JWT, API_KEY,
 *    AADHAAR and PAN. Production additionally covers SSN, PASSPORT,
 *    DRIVING_LICENSE, BANK_ACCOUNT, IFSC_CODE, SWIFT_BIC, UPI_ID,
 *    CRYPTO_WALLET, PERSON, PHONE, EMAIL, DOB, PASSWORD, PIN_CRED, HEALTH_ID,
 *    TAX_ID and MEDICAL_RECORD. A test running against a copy could not have
 *    caught that, and would not catch it reappearing.
 *
 * 2. Cycle 2.9 inserted schema validation directly above the firewall. That
 *    reordering is exactly the kind of change that can silently short-circuit a
 *    downstream guard, so the firewall's reachability is now pinned by test
 *    from both sides.
 *
 * These tests drive the REAL exported app.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { authHeader } from '../setup/authHelper';

type AppLike = { request: (input: string, init?: RequestInit) => Promise<Response> };

const SECRET = process.env.SECRET_PASSWORD ?? '';
const ALLOWED = 'chrome-extension://fidbnhfgcadfpjlmdfpnngikjpdhcdcf';

let app: AppLike;

beforeAll(async () => {
  const mod = await import('../../server/src/index');
  app = (mod as unknown as { app: AppLike }).app ?? (mod as unknown as AppLike);
});

async function postMaskedDom(maskedDom: string) {
  const res = await app.request('http://localhost/api/step', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader(), Origin: ALLOWED },
    body: JSON.stringify({
      task: 'check the page',
      maskedDom,
      redactedImage: '',
      redaction_legend: [],
      subTasks: [],
      actionHistory: [],
    }),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as { error?: string } };
}

function expectRejected(result: { status: number; body: { error?: string } }, label: string) {
  // The firewall's own error code, not merely any 400 — otherwise a schema
  // rejection would satisfy the assertion and the firewall could be dead.
  expect(result.status, `${label} should be rejected`).toBe(400);
  expect(result.body.error, `${label} should cite the firewall`).toMatch(
    /UNSANITIZED_PAYLOAD_REJECTED/
  );
}

describe('Cycle 2.10 — the firewall rejects unmasked PII in the masked DOM', () => {
  // Each of these is a class the production firewall covers. The mirror did NOT
  // cover all of them (finding N8), which is why they are enumerated explicitly.
  const cases: Array<[string, string]> = [
    ['Aadhaar', 'Aadhaar 2345 6789 0123'],
    ['PAN', 'PAN ABCDE1234F on file'],
    ['private key', '-----BEGIN RSA PRIVATE KEY-----'],
    ['bearer JWT', 'Authorization: Bearer eyJhbG.eyJzdWIi.sig'],
    ['stripe-style key', 'key sk-live-abcdefghij0123456789'],
    ['github token', 'token ghp_abcdefghij0123456789'],
    ['AWS access key id', 'AKIAIOSFODNN7EXAMPLE'],
    ['SSN', 'SSN 123-45-6789'],
    ['bank account', 'account no. 123456789012'],
    ['IFSC', 'IFSC SBIN0000123'],
    ['UPI id', 'pay him at user@okaxis'],
    ['crypto wallet', 'wallet 0x1234567890abcdef1234567890abcdef12345678'],
    ['phone', 'call 9876543210'],
    ['email', 'write to someone@example.com'],
    ['date of birth', 'DOB 01/01/1990'],
    ['password', 'password: hunter2xyz'],
    ['ATM pin', 'ATM PIN 4821'],
    ['passport', 'passport M1234567'],
    ['driving licence', 'DL MH1420150012345'],
    ['tax id', 'tax 12ABCDE1234F1Z9'],
    ['health id', 'Health ID 12-3456-7890-1234'],
    ['medical record', 'Patient ID AB-1234-CD'],
    ['full address', '1600 Pennsylvania Ave, Washington'],
    ['person name', 'Mr. John Smith'],
  ];

  for (const [label, sample] of cases) {
    it(`rejects ${label}`, async () => {
      // BREAK: the firewall losing any one class, or being bypassed by the
      // schema layer inserted above it in Cycle 2.9.
      expectRejected(await postMaskedDom(sample), label);
    });
  }
});

describe('Cycle 2.10 — the firewall does not over-block', () => {
  const benign: Array<[string, string]> = [
    ['already-placeholder-masked text', 'Contact [EMAIL] or call [PHONE]'],
    ['ordinary prose', 'Orbital mechanics reference table for mission planners'],
    ['a search query', 'latest ISRO launch updates 2026'],
    ['a masked card placeholder', 'Payment method: [CARD]'],
    ['a dev url with no key shape', 'See https://example.com/docs for details'],
  ];

  for (const [label, sample] of benign) {
    it(`allows ${label}`, async () => {
      // BREAK: over-matching. A firewall that blocks legitimate pages is a
      // firewall the operator disables, and this agent targets documentation
      // and government portals full of exactly this text.
      const result = await postMaskedDom(sample);
      expect(result.body.error ?? '', `${label} must not be firewall-rejected`).not.toMatch(
        /UNSANITIZED_PAYLOAD_REJECTED/
      );
    });
  }
});

describe('Cycle 2.10 — the firewall runs BEFORE the PII leaves for the model', () => {
  it('does not reach the upstream model for a payload containing PII', async () => {
    // BREAK: the rejection happening but the upstream call already having been
    // made, which would mean the PII left the machine regardless.
    //
    // Distinguishable from the schema-rejection path by the error code: a
    // schema failure says INVALID_REQUEST_SHAPE, the firewall says
    // UNSANITIZED_PAYLOAD_REJECTED.
    const result = await postMaskedDom('Aadhaar 2345 6789 0123');
    expect(result.body.error).toBe('UNSANITIZED_PAYLOAD_REJECTED');
  });
});

describe('Task C — firewall covers all outbound prompt fields', () => {
  async function postPayload(overrides: Record<string, unknown>) {
    const res = await app.request('http://localhost/api/step', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader(), Origin: ALLOWED },
      body: JSON.stringify({
        task: 'check the page',
        maskedDom: 'safe content',
        redactedImage: '',
        redaction_legend: [],
        subTasks: [],
        actionHistory: [],
        ...overrides,
      }),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as { error?: string } };
  }

  it('rejects unmasked PII in task', async () => {
    const result = await postPayload({ task: 'Call customer at 9876543210' });
    expectRejected(result, 'task containing phone number');
  });

  it('rejects unmasked PII in scratchpad', async () => {
    const result = await postPayload({ scratchpad: { patient: 'Patient ID AB-1234-CD' } });
    expectRejected(result, 'scratchpad containing medical record');
  });

  it('rejects unmasked PII in actionHistory', async () => {
    const result = await postPayload({
      actionHistory: [{ action: 'type', value: 'password: hunter2xyz' }],
    });
    expectRejected(result, 'actionHistory containing password');
  });

  it('rejects unmasked PII in subTasks', async () => {
    const result = await postPayload({
      subTasks: ['Pay him at user@okaxis'],
    });
    expectRejected(result, 'subTasks containing UPI ID');
  });
});

