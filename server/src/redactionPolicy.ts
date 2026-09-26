/**
 * Redaction policy — Cycle 1.4
 * ---------------------------------------------------------------------------
 * The extension is not a trust boundary. It is JavaScript in a browser, its
 * payload arrives over HTTP, and a buggy or tampered client can claim
 * `state: 'verified'` for a frame it never redacted. The server therefore
 * treats the provenance envelope as a CLAIM to be evaluated against policy,
 * never as ground truth.
 *
 * Two independent responsibilities:
 *
 *   1. Policy      — `REJECT_UNREDACTED` decides whether a non-verified frame
 *                    is refused (hard block) or accepted-but-recorded.
 *                    Default: accept-and-record, so the agent keeps working
 *                    and the operator is told. This is a deliberate product
 *                    decision, not an oversight.
 *   2. Accounting  — degraded/unavailable steps are tallied in arrival order
 *                    so a run that quietly lost its visual channel cannot pass
 *                    unnoticed. Client-supplied timestamps are deliberately
 *                    ignored for ranking: only the server's own ordering counts.
 *
 * Pure and dependency-free so it is directly unit-testable.
 */

export type RedactionState = 'verified' | 'degraded' | 'unavailable';

export interface RedactionEnvelopeInput {
  state?: unknown;
  engine?: unknown;
  degradedAt?: unknown;
  reason?: unknown;
  violations?: unknown;
}

export interface NormalizedRedactionEnvelope {
  state: RedactionState;
  engine: string;
  degradedAt: string | null;
  reason: string;
  violations: string[];
}

const VALID_STATES: readonly RedactionState[] = ['verified', 'degraded', 'unavailable'];

const MAX_REASON_LENGTH = 512;
const MAX_VIOLATIONS = 50;
const MAX_ENGINE_LENGTH = 64;

function clampString(value: unknown, max: number, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Coerce an untrusted envelope into a bounded, well-typed record.
 *
 * Anything unrecognised becomes `unavailable` — never `verified`. An absent
 * envelope means an old or tampered client, and treating that as verified
 * would let an un-redacted frame through while looking clean.
 */
export function normalizeRedactionEnvelope(
  input: RedactionEnvelopeInput | undefined | null
): NormalizedRedactionEnvelope {
  if (input === null || input === undefined || typeof input !== 'object') {
    return {
      state: 'unavailable',
      engine: 'unknown',
      degradedAt: null,
      reason: 'No redaction provenance supplied by the client.',
      violations: [],
    };
  }

  const rawState = input.state;
  const state: RedactionState =
    typeof rawState === 'string' && (VALID_STATES as readonly string[]).includes(rawState)
      ? (rawState as RedactionState)
      : 'unavailable';

  const rawViolations = Array.isArray(input.violations) ? input.violations : [];

  return {
    state,
    engine: clampString(input.engine, MAX_ENGINE_LENGTH, 'unknown'),
    degradedAt:
      typeof input.degradedAt === 'string' && input.degradedAt.length > 0
        ? clampString(input.degradedAt, 64, '')
        : null,
    reason: clampString(input.reason, MAX_REASON_LENGTH, 'No reason supplied.'),
    violations: rawViolations
      .slice(0, MAX_VIOLATIONS)
      .map((v) => clampString(v, 256, '[unprintable]')),
  };
}

export interface RedactionPolicyVerdict {
  accepted: boolean;
  status: number;
  error?: string;
  /** True only when the frame was accepted despite not being verified. */
  degraded: boolean;
  degradedReason: string | null;
  state: RedactionState;
}

/**
 * Decide whether a step carrying this envelope may proceed.
 *
 * @param envelope  the client's provenance claim (untrusted)
 * @param rejectUnredacted  operator opt-in hard block (REJECT_UNREDACTED)
 */
export function evaluateRedactionPolicy(
  envelope: RedactionEnvelopeInput | undefined | null,
  rejectUnredacted: boolean
): RedactionPolicyVerdict {
  const normalized = normalizeRedactionEnvelope(envelope);

  if (normalized.state === 'verified') {
    return {
      accepted: true,
      status: 200,
      degraded: false,
      degradedReason: null,
      state: 'verified',
    };
  }

  if (rejectUnredacted) {
    return {
      accepted: false,
      status: 400,
      error: `UNREDACTED_PAYLOAD_REJECTED: redaction state was '${normalized.state}'. Reason: ${normalized.reason}`,
      // A refused frame is NOT 'degraded' — a caller reading `degraded` must
      // not be able to treat a block as a soft warning and proceed anyway.
      degraded: false,
      degradedReason: null,
      state: normalized.state,
    };
  }

  return {
    accepted: true,
    status: 200,
    degraded: true,
    degradedReason: normalized.reason,
    state: normalized.state,
  };
}

export interface DegradationTally {
  degradedSteps: number;
  unavailableSteps: number;
  worstState: RedactionState | null;
  lastDegradedReason: string | null;
}

export function createDegradationTally(): DegradationTally {
  return {
    degradedSteps: 0,
    unavailableSteps: 0,
    worstState: null,
    lastDegradedReason: null,
  };
}

/**
 * Fold one step into the tally.
 *
 * `worstState` only ever escalates: unavailable is worse than degraded,
 * because unavailable means nothing was checked at all. Ordering comes from
 * arrival, never from the client's `degradedAt`, so a forged timestamp cannot
 * manipulate the record.
 */
export function recordDegradation(
  tally: DegradationTally,
  envelope: RedactionEnvelopeInput | undefined | null
): DegradationTally {
  const { state, reason } = normalizeRedactionEnvelope(envelope);

  if (state === 'verified') {
    return tally;
  }

  if (state === 'degraded') {
    tally.degradedSteps += 1;
  } else {
    tally.unavailableSteps += 1;
  }

  tally.lastDegradedReason = reason;

  if (tally.worstState !== 'unavailable') {
    tally.worstState = state;
  }

  return tally;
}
