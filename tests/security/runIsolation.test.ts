/**
 * Cycle 3.3 — Run isolation.
 * ---------------------------------------------------------------------------
 * THREE REAL DEFECTS IN THE EXISTING RUN CONTROL
 *
 * 1. `stopRequested` is a SINGLE MODULE-LEVEL BOOLEAN. Starting a second run
 *    resets it to false, which silently un-stops the first. Two overlapping runs
 *    share one flag, so "stop" cannot mean "stop that run".
 *
 * 2. THERE IS NO CONCURRENT-RUN GUARD. START_AGENT starts a run with no check
 *    for an active one. Two runs then share the flag, the scratchpad, the
 *    telemetry counters and — worst — the DOM, so they interleave clicks and
 *    typing on the same page.
 *
 * 3. STOP IS ONLY CHECKED AT THE TOP OF A STEP. A step can spend up to 35s
 *    waiting on the model, so pressing stop can take the best part of a minute
 *    to take effect. Cancellation needs to be observable mid-step, not only
 *    between steps.
 *
 * The fix is a run-scoped controller: each run gets an id and its own
 * cancellation token, only one run may be active, and a stale run's stop cannot
 * affect a newer one.
 *
 * Pure and dependency-free, so all of this is testable without a browser.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { RunController, type RunRecord } from '@/utils/runControl';

let controller: RunController;
let counter: number;

beforeEach(() => {
  controller = new RunController();
  counter = 0;
});

/**
 * Start and unwrap. The controller returns an explicit StartOutcome rather than
 * the run or null, because a refusal must be able to say WHY — a silent null is
 * the worst outcome for a control the operator just pressed.
 */
function start(tabId = 1): RunRecord {
  counter += 1;
  const outcome = controller.start({ runId: `run-${counter}`, tabId, startedAt: 1_000 + counter });
  if (!outcome.accepted) throw new Error(`unexpected refusal: ${outcome.reason}`);
  return outcome.run;
}

/** Attempt a start without unwrapping, for the refusal assertions. */
function attempt(runId: string, tabId: number) {
  return controller.start({ runId, tabId, startedAt: 5_000 });
}

describe('Cycle 3.3 — only one run may be active', () => {
  it('starts a run when nothing is active', () => {
    // BREAK: the guard refusing the first run.
    const run = start();
    expect(run.runId).toBe('run-1');
    expect(controller.isActive()).toBe(true);
  });

  it('refuses a second concurrent run', () => {
    // BREAK, AND THE POINT: two runs interleaving clicks and typing on the
    // same page while sharing one cancellation flag.
    start(1);
    const second = attempt('run-2', 2);

    expect(second.accepted).toBe(false);
    expect(second.accepted ? '' : second.reason).toBe('already-running');
    expect(controller.isActive()).toBe(true);
    expect(controller.activeRunId()).toBe('run-1');
  });

  it('allows a new run once the previous one has finished', () => {
    // BREAK: a run that never clears its active slot, permanently bricking the
    // extension after a single use.
    const first = start();
    controller.finish(first.runId);
    expect(controller.isActive()).toBe(false);

    const second = start(2);
    expect(second).not.toBeNull();
    expect(controller.activeRunId()).toBe('run-2');
  });

  it('allows a new run after the previous one was stopped', () => {
    start();
    controller.requestStop();
    controller.finish(controller.activeRunId() ?? '');
    expect(attempt('run-x', 1).accepted).toBe(true);
  });
});

describe('Cycle 3.3 — cancellation is per run', () => {
  it('stops only the run that was asked to stop', () => {
    // BREAK: the single global boolean. After run-2 starts, stopping run-1 must
    // not touch run-2.
    start(1);
    controller.finish('run-1');
    const second = start(2);

    controller.requestStop('run-1'); // a stale stop for an already-finished run

    expect(controller.isStopRequested(second.runId)).toBe(false);
  });

  it('reports stop for the run that requested it', () => {
    const run = start();
    expect(controller.isStopRequested(run.runId)).toBe(false);
    controller.requestStop(run.runId);
    expect(controller.isStopRequested(run.runId)).toBe(true);
  });

  it('clears the stop flag when a run finishes', () => {
    // BREAK: a stale stop flag poisoning the NEXT run, which would appear as
    // an agent that stops itself immediately after starting.
    const first = start();
    controller.requestStop(first.runId);
    controller.finish(first.runId);

    const second = start();
    expect(controller.isStopRequested(second.runId)).toBe(false);
  });

  it('does not report a stop for a run that never existed', () => {
    // BREAK: a lookup that returns truthy for unknown ids, which would make the
    // loop abort on a typo.
    expect(controller.isStopRequested('never-existed')).toBe(false);
  });
});

describe('Cycle 3.3 — the active run can be identified and released', () => {
  it('exposes the active run id and tab', () => {
    const run = start(7);
    expect(controller.activeRunId()).toBe('run-1');
    expect(controller.activeTabId()).toBe(7);
    expect(controller.activeRun()?.runId).toBe(run.runId);
  });

  it('reports no active tab when idle', () => {
    // BREAK: a stale tab id making the loop target a closed tab.
    expect(controller.activeTabId()).toBeNull();
    expect(controller.activeRun()).toBeNull();
  });

  it('ignores a finish for a run that is not the active one', () => {
    // BREAK: a late `finally` from an old run clearing the CURRENT run's slot,
    // which would let a third run start while the second is still going.
    const first = start(1);
    controller.finish(first.runId);
    const second = start(2);

    controller.finish(first.runId); // duplicate/late finish

    expect(controller.activeRunId()).toBe(second.runId);
    expect(controller.isActive()).toBe(true);
  });

  it('stopRequest returns the id of the run it stopped, or null when idle', () => {
    // BREAK: a stop that silently no-ops, so the operator sees no reaction.
    expect(controller.requestStop()).toBeNull();
    const run = start();
    expect(controller.requestStop()).toBe(run.runId);
  });
});
