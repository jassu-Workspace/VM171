/**
 * Run control — Cycle 3.3
 * ---------------------------------------------------------------------------
 * WHAT THIS REPLACES
 *
 * The extension had exactly one piece of run state: a module-level
 * `let stopRequested = false`.
 *
 *   1. ONE FLAG FOR ALL RUNS. Starting a second run reset it, silently
 *      un-stopping the first, and "stop" could not mean "stop that run".
 *   2. NO CONCURRENT-RUN GUARD. START_AGENT began a run with no check for an
 *      active one, so two runs could interleave clicks and typing on the same
 *      page while sharing the flag, the scratchpad and the telemetry counters.
 *   3. STOP ONLY BETWEEN STEPS. A step can spend up to 35s waiting on the
 *      model, so pressing stop could take most of a minute to take effect.
 *
 * (1) and (2) are fixed here. (3) is a call-site concern — the loop must
 * consult `isStopRequested` at points WITHIN a step, not only at the top of one
 * — and is wired in the background, where the fetch already has an
 * AbortController that can be triggered.
 *
 * The controller holds ONE active run, which is the correct model for this
 * product: an agent that clicks and types in a page cannot sanely run twice in
 * that page at once. A second start is refused rather than queued, so the
 * operator gets immediate, honest feedback instead of a silent no-op.
 *
 * Pure and dependency-free — no chrome APIs, no clock of its own. `startedAt` is
 * supplied by the caller so ordering is testable.
 */

export interface RunRecord {
  runId: string;
  tabId: number;
  startedAt: number;
  stopRequested: boolean;
}

export interface StartRequest {
  runId: string;
  tabId: number;
  startedAt: number;
}

export type RunHandle = RunRecord;

/** Outcome of an attempted start, so the caller can report WHY it was refused. */
export type StartOutcome =
  | { accepted: true; run: RunRecord }
  | { accepted: false; reason: 'already-running'; activeRunId: string | null };

export class RunController {
  private active: RunRecord | null = null;

  /**
   * Begin a run, or refuse it.
   *
   * Refusal is explicit rather than silent: a caller that ignored this would
   * appear to start a run that never begins, which is the worst possible
   * failure mode for a control the operator just pressed.
   */
  start(request: StartRequest): StartOutcome {
    if (this.active) {
      return { accepted: false, reason: 'already-running', activeRunId: this.active.runId };
    }
    const run: RunRecord = {
      runId: request.runId,
      tabId: request.tabId,
      startedAt: request.startedAt,
      stopRequested: false,
    };
    this.active = run;
    return { accepted: true, run };
  }

  /**
   * Request cancellation.
   *
   * Scoped to `runId` when given, so a late stop for a finished run cannot
   * cancel the run that replaced it. Returns the id actually stopped, or null
   * when there was nothing to stop.
   */
  requestStop(runId?: string): string | null {
    if (!this.active) return null;
    if (runId !== undefined && runId !== this.active.runId) return null;
    this.active.stopRequested = true;
    return this.active.runId;
  }

  /** True only for the ACTIVE run, and only once a stop was requested for it. */
  isStopRequested(runId: string): boolean {
    if (!this.active) return false;
    if (this.active.runId !== runId) return false;
    return this.active.stopRequested;
  }

  /**
   * Release the slot.
   *
   * Scoped to `runId` on purpose: a late `finally` from an older run must not
   * clear the slot belonging to a newer one, which would let a third run start
   * while the second is still going.
   */
  finish(runId: string): void {
    if (!this.active) return;
    if (this.active.runId !== runId) return;
    this.active = null;
  }

  /** Abort the active run and free the slot in one step. */
  cancel(runId?: string): string | null {
    const stopped = this.requestStop(runId);
    if (stopped) this.finish(stopped);
    return stopped;
  }

  isActive(): boolean {
    return this.active !== null;
  }

  activeRunId(): string | null {
    return this.active?.runId ?? null;
  }

  activeTabId(): number | null {
    return this.active?.tabId ?? null;
  }

  activeRun(): RunRecord | null {
    return this.active;
  }
}

/** Process-wide controller. One active run is the product's model. */
export const runController = new RunController();
