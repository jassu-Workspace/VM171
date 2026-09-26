/**
 * Cycle 1.4 — Server-side redaction policy and degraded-step accounting.
 * ---------------------------------------------------------------------------
 * WHY THE SERVER MUST ENFORCE THIS
 *
 * Cycles 1.1-1.3 made the extension honest about redaction provenance. But the
 * extension is not a trust boundary the server can rely on: it is JavaScript
 * running in a browser, the payload arrives over HTTP, and a compromised or
 * buggy client can claim `state: 'verified'` for a frame it never redacted.
 *
 * The server therefore treats the envelope as a CLAIM to be evaluated against
 * policy, never as ground truth. Two independent things happen here:
 *
 *   1. Policy    — `REJECT_UNREDACTED` decides whether a non-verified frame is
 *                 refused outright (hard block) or accepted-but-recorded.
 *                 Default is accept-and-record, so the agent keeps working.
 *   2. Accounting — every degraded/unavailable step is written to the session
 *                 and surfaced in telemetry, so a run that quietly lost its
 *                 visual channel cannot pass unnoticed.
 *
 * Breaks caught here:
 *   - a verified claim being taken on trust with no policy evaluation
 *   - REJECT_UNREDACTED defaulting to block (breaks the product by default)
 *   - REJECT_UNREDACTED defaulting to accept (loses the opt-in hard block)
 *   - a missing envelope being treated as verified
 *   - degraded steps failing to increment any counter
 *   - a client-supplied counter being trusted over the server's own tally
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateRedactionPolicy,
  normalizeRedactionEnvelope,
  createDegradationTally,
  recordDegradation,
  type RedactionEnvelopeInput,
} from '../../server/src/redactionPolicy';

const NOW = '2026-09-26T00:00:00.000Z';

function envelope(over: Partial<RedactionEnvelopeInput> = {}): RedactionEnvelopeInput {
  return {
    state: 'verified',
    engine: 'mediapipe',
    degradedAt: null,
    reason: 'Face detection live; 1 redaction(s) applied.',
    violations: [],
    ...over,
  };
}

describe('Cycle 1.4 — envelope normalisation', () => {
  it('accepts a well-formed verified envelope', () => {
    // BREAK: valid input being rejected by an over-strict validator.
    const n = normalizeRedactionEnvelope(envelope());
    expect(n.state).toBe('verified');
  });

  it('treats a missing envelope as unavailable, never verified', () => {
    // BREAK: THE CRITICAL CASE. An absent envelope means an old or tampered
    // client. Defaulting it to 'verified' would let an un-redacted frame
    // through while looking clean.
    const n = normalizeRedactionEnvelope(undefined);
    expect(n.state).toBe('unavailable');
  });

  it('treats an unrecognised state string as unavailable', () => {
    // BREAK: `state: 'VERIFIED!'` or `'ok'` being coerced into trust.
    const n = normalizeRedactionEnvelope(
      envelope({ state: 'totally-verified' as unknown as 'verified' })
    );
    expect(n.state).toBe('unavailable');
  });

  it('truncates an oversized reason instead of storing it whole', () => {
    // BREAK: unbounded operator-supplied text landing in session metadata and
    // telemetry. Page-derived text must not be able to flood storage.
    const n = normalizeRedactionEnvelope(envelope({ reason: 'x'.repeat(5000) }));
    expect(n.reason.length).toBeLessThanOrEqual(512);
  });

  it('caps the violations array', () => {
    // BREAK: an unbounded violations array inflating session files.
    const many = Array.from({ length: 500 }, (_, i) => `violation ${i}`);
    const n = normalizeRedactionEnvelope(envelope({ violations: many }));
    expect(n.violations.length).toBeLessThanOrEqual(50);
  });

  it('coerces a non-string state to unavailable rather than throwing', () => {
    // BREAK: a malformed payload crashing the route instead of degrading.
    const n = normalizeRedactionEnvelope(
      envelope({ state: 42 as unknown as 'verified' })
    );
    expect(n.state).toBe('unavailable');
  });
});

describe('Cycle 1.4 — REJECT_UNREDACTED policy', () => {
  it('accepts a verified frame by default', () => {
    // BREAK: the happy path being refused.
    const v = evaluateRedactionPolicy(envelope(), false);
    expect(v.accepted).toBe(true);
    expect(v.degraded).toBe(false);
  });

  it('accepts but records a degraded frame by default', () => {
    // BREAK: the chosen product posture. Default must be fail-visible, not
    // fail-closed, or a model-load failure bricks the agent.
    const v = evaluateRedactionPolicy(
      envelope({ state: 'degraded', engine: 'unavailable', degradedAt: NOW, reason: 'engine down' }),
      false
    );
    expect(v.accepted).toBe(true);
    expect(v.degraded).toBe(true);
    expect(v.degradedReason).toMatch(/engine down/);
  });

  it('accepts but records an unavailable frame by default', () => {
    // BREAK: unavailable being silently treated as fine.
    const v = evaluateRedactionPolicy(envelope({ state: 'unavailable' }), false);
    expect(v.accepted).toBe(true);
    expect(v.degraded).toBe(true);
  });

  it('refuses a degraded frame when REJECT_UNREDACTED is enabled', () => {
    // BREAK: the opt-in hard block not existing. This is the escape hatch for
    // an operator who cannot accept any un-redacted egress.
    const v = evaluateRedactionPolicy(
      envelope({ state: 'degraded', reason: 'engine down' }),
      true
    );
    expect(v.accepted).toBe(false);
    expect(v.status).toBe(400);
    expect(v.error).toMatch(/UNREDACTED/);
  });

  it('refuses an unavailable frame when REJECT_UNREDACTED is enabled', () => {
    // BREAK: only 'degraded' being blocked while 'unavailable' slips through —
    // the worse case, since unavailable means nothing was checked at all.
    const v = evaluateRedactionPolicy(envelope({ state: 'unavailable' }), true);
    expect(v.accepted).toBe(false);
    expect(v.status).toBe(400);
  });

  it('still accepts a verified frame when REJECT_UNREDACTED is enabled', () => {
    // BREAK: the hard block being unconditional, which would stop all traffic.
    const v = evaluateRedactionPolicy(envelope(), true);
    expect(v.accepted).toBe(true);
  });

  it('never marks a refused frame as merely degraded', () => {
    // BREAK: a caller reading `degraded: true` and proceeding anyway.
    const v = evaluateRedactionPolicy(envelope({ state: 'unavailable' }), true);
    expect(v.degraded).toBe(false);
  });
});

describe('Cycle 1.4 — degradation accounting', () => {
  it('starts with zero degraded steps', () => {
    // BREAK: a pre-populated counter inflating the telemetry figure.
    const t = createDegradationTally();
    expect(t.degradedSteps).toBe(0);
    expect(t.unavailableSteps).toBe(0);
    expect(t.worstState).toBeNull();
  });

  it('counts a degraded step and records the worst state seen', () => {
    // BREAK: degraded steps never being counted, so a fully degraded run
    // reports a clean bill of health.
    const t = createDegradationTally();
    recordDegradation(t, envelope({ state: 'degraded' }));
    expect(t.degradedSteps).toBe(1);
    expect(t.worstState).toBe('degraded');
  });

  it('escalates the worst state to unavailable', () => {
    // BREAK: 'unavailable' being ranked below 'degraded'. Unavailable is the
    // worse condition: nothing was checked.
    const t = createDegradationTally();
    recordDegradation(t, envelope({ state: 'degraded' }));
    recordDegradation(t, envelope({ state: 'unavailable' }));
    expect(t.worstState).toBe('unavailable');
  });

  it('does not downgrade the worst state back to degraded', () => {
    // BREAK: ordering-dependent output — a later benign step erasing the fact
    // that an earlier step was unscanned.
    const t = createDegradationTally();
    recordDegradation(t, envelope({ state: 'unavailable' }));
    recordDegradation(t, envelope({ state: 'degraded' }));
    expect(t.worstState).toBe('unavailable');
  });

  it('does not count a verified step as degraded', () => {
    // BREAK: every step inflating the degraded counter.
    const t = createDegradationTally();
    recordDegradation(t, envelope({ state: 'verified' }));
    expect(t.degradedSteps).toBe(0);
    expect(t.unavailableSteps).toBe(0);
    expect(t.worstState).toBeNull();
  });

  it('ignores a client-supplied degradedAt timestamp when ranking', () => {
    // BREAK: a client forging timestamps to manipulate the record. Ordering
    // must come from server arrival order, not client claims.
    const t = createDegradationTally();
    recordDegradation(
      t,
      envelope({ state: 'unavailable', degradedAt: '1999-01-01T00:00:00.000Z' })
    );
    expect(t.worstState).toBe('unavailable');
  });

  it('keeps the tally internally consistent across mixed steps', () => {
    // BREAK: counters drifting apart under a realistic mixed sequence.
    const t = createDegradationTally();
    recordDegradation(t, envelope({ state: 'verified' }));
    recordDegradation(t, envelope({ state: 'degraded' }));
    recordDegradation(t, envelope({ state: 'verified' }));
    recordDegradation(t, envelope({ state: 'unavailable' }));
    recordDegradation(t, envelope({ state: 'degraded' }));

    expect(t.degradedSteps).toBe(2);
    expect(t.unavailableSteps).toBe(1);
    expect(t.worstState).toBe('unavailable');
  });
});
