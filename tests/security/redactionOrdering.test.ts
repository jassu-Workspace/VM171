/**
 * Regression: server-side masking must happen BEFORE the redaction policy gate.
 *
 * WHAT BROKE
 * ----------
 * The first implementation of server-side redaction placed the masking block
 * AFTER `evaluateRedactionPolicy`. With `REJECT_UNREDACTED=true`, the gate
 * rejected the step on the CLIENT's degraded envelope — before the server had
 * any chance to mask anything. Result: every single step failed with
 *
 *   400 UNREDACTED_PAYLOAD_REJECTED: redaction state was 'degraded'
 *
 * even though the server could and did redact successfully a few lines later.
 * The feature was correct; it was simply unreachable.
 *
 * The gate exists to judge evidence. Once the server has produced a verified
 * mask, the client's degraded claim is no longer the deciding evidence, so the
 * gate must be given the server's result instead.
 *
 * This is the exact configuration a real user hits: REJECT_UNREDACTED=true is
 * the recommended setting once redaction works.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SERVER_SRC = readFileSync(join(__dirname, '../../server/src/index.ts'), 'utf8');

describe('server masking precedes the policy gate', () => {
  it('redacts before evaluating the policy, not after', () => {
    const redactAt = SERVER_SRC.indexOf('await redactOnServer(');
    const policyAt = SERVER_SRC.indexOf('evaluateRedactionPolicy(');
    expect(redactAt).toBeGreaterThan(-1);
    expect(policyAt).toBeGreaterThan(-1);
    expect(
      redactAt,
      'redactOnServer must be called BEFORE evaluateRedactionPolicy — otherwise the gate ' +
        'rejects on the client claim before the server can mask anything',
    ).toBeLessThan(policyAt);
  });

  it('gives the gate the server result when the server masked the frame', () => {
    // Otherwise a step whose frame IS provably redacted is still rejected
    // because the client claimed 'degraded'.
    expect(SERVER_SRC).toMatch(/serverMasked\s*\?/);
    expect(SERVER_SRC).toMatch(/state:\s*'verified',\s*engine:\s*'server-side'/);
  });

  it('still fails closed when masking is unavailable and the flag is on', () => {
    // Reordering must not weaken this: an unmasaked frame is still refused.
    expect(SERVER_SRC).toMatch(/REDACTION_UNAVAILABLE/);
    expect(SERVER_SRC).toMatch(/if \(REJECT_UNREDACTED\)/);
  });

  it('a server-masked frame is never replaced by the raw one', () => {
    // The invariant egressRawOnly pins, restated for the new path.
    expect(SERVER_SRC).toMatch(/outboundIsMasked\s*\?\s*\(vlmImageForUpstream as string\)\s*:\s*imageBase64/);
  });
});
