/**
 * Cycle 3.2 — Confirmation gates, and the client honouring the server verdict.
 * ---------------------------------------------------------------------------
 * A server-side flag the client ignores is security theatre. These tests cover
 * the half that is easy to get wrong: whether the extension actually acts on
 * `policyBlocked` and `requiresConfirmation` before anything reaches the
 * content script.
 *
 * The fingerprint binding is the subtle part. A confirmation given for one
 * click must not become consent for a DIFFERENT click later, and must not
 * survive into a new run. Keying on the action's content rather than a boolean
 * per step is what prevents both.
 *
 * `describeAction` and `requestHumanConfirmation` are exported from the
 * background module precisely so they can be tested here; they are production
 * functions, not test hooks, and the module is imported for its behaviour
 * rather than mocked.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

type BackgroundModule = {
  describeAction: (a: Record<string, unknown>) => string;
  requestHumanConfirmation: (label: string) => Promise<boolean>;
  // The real reply path. A decline or approval is NOT a reply to the prompt
  // broadcast — it is a separate CONFIRM_RESPONSE message routed to
  // answerConfirmation, correlated by requestId. These are exported so the
  // tests can drive that path rather than fabricating a reply.
  answerConfirmation: (requestId: string, confirmed: boolean) => boolean;
  getPendingConfirmation: () => { requestId: string; label: string } | null;
};

let mod: BackgroundModule;

beforeEach(async () => {
  vi.resetModules();
  mod = (await import('@/entrypoints/background/index')) as unknown as BackgroundModule;
});

describe('Cycle 3.2 — action descriptions are human-readable', () => {
  it('names the action and its target', () => {
    // BREAK: a confirmation prompt saying "Continue?" — the operator cannot
    // meaningfully consent to something they were not told.
    expect(mod.describeAction({ action: 'click', target: 'Place order' })).toBe(
      'click → Place order'
    );
  });

  it('falls back through selector, id and value', () => {
    expect(mod.describeAction({ action: 'click', selector: '#submit' })).toContain('#submit');
    expect(mod.describeAction({ action: 'click', id: 'agent-7' })).toContain('agent-7');
    expect(mod.describeAction({ action: 'navigate', value: 'https://isro.gov.in' })).toContain(
      'isro.gov.in'
    );
  });

  it('always produces something rather than an empty label', () => {
    // BREAK: an empty prompt, which reads as a bug and trains the operator to
    // click through without reading.
    expect(mod.describeAction({ action: 'click' })).toBe('click → the page');
    expect(mod.describeAction({})).toBeTruthy();
  });

  it('truncates a very long value so the prompt stays readable', () => {
    const long = 'x'.repeat(5000);
    const label = mod.describeAction({ action: 'type', value: long });
    expect(label.length).toBeLessThan(120);
  });
});

describe('Cycle 3.2 — a confirmation that cannot be delivered is a decline', () => {
  // NOTE ON WHAT WAS HERE BEFORE
  //
  // Three cases mocked `sendMessage` to resolve `{ confirmed: true }` and
  // asserted requestHumanConfirmation returned true. That passed while the
  // feature was completely unreachable: the real message was never sent by
  // anything, nothing listened, and no reply type existed. A test that
  // fabricates the reply proves only that the function READS a reply.
  //
  // The cases below drive the REAL path — a CONFIRM_RESPONSE routed to
  // answerConfirmation and correlated by requestId. See also
  // confirmationRoundTrip.test.ts, which asserts the message plumbing exists.

  it('resolves false when the broadcast fails', async () => {
    // BREAK, AND THE POINT: a closed port or a crashed view must fail SAFE.
    // Treating an undeliverable confirmation as consent inverts the whole
    // control. The prompt is a broadcast now, so this is about the broadcast
    // failing — the wait below must still decline.
    vi.useFakeTimers();
    try {
      const sendMessage = vi.fn().mockRejectedValue(new Error('Receiving end does not exist'));
      (globalThis as unknown as { chrome: { runtime: { sendMessage: unknown } } }).chrome.runtime.sendMessage =
        sendMessage;

      // No answer arrives, so this settles via the timeout -> decline.
      const pending = mod.requestHumanConfirmation('click → Delete account');
      await vi.advanceTimersByTimeAsync(130_000);
      await expect(pending).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves false when the operator declines', async () => {
    // A real decline travels back as CONFIRM_RESPONSE, not as a reply to the
    // broadcast. Driving it through the real handler is the point: mocking
    // sendMessage to return a fabricated reply is what hid that no listener
    // existed.
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    (globalThis as unknown as { chrome: { runtime: { sendMessage: unknown } } }).chrome.runtime.sendMessage =
      sendMessage;

    const pending = mod.requestHumanConfirmation('x');
    // Let the request register before answering it.
    await vi.waitFor(() => expect(mod.getPendingConfirmation()).not.toBeNull());

    const { requestId } = mod.getPendingConfirmation()!;
    expect(mod.answerConfirmation(requestId, false)).toBe(true);
    await expect(pending).resolves.toBe(false);
  });

  it('resolves true when the operator approves', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    (globalThis as unknown as { chrome: { runtime: { sendMessage: unknown } } }).chrome.runtime.sendMessage =
      sendMessage;

    const pending = mod.requestHumanConfirmation('click → Post');
    await vi.waitFor(() => expect(mod.getPendingConfirmation()).not.toBeNull());

    const { requestId } = mod.getPendingConfirmation()!;
    expect(mod.answerConfirmation(requestId, true)).toBe(true);
    await expect(pending).resolves.toBe(true);
  });

  it('ignores an answer that does not match the pending prompt', async () => {
    // A stale reply must never approve an action the operator was not shown.
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    (globalThis as unknown as { chrome: { runtime: { sendMessage: unknown } } }).chrome.runtime.sendMessage =
      sendMessage;

    const pending = mod.requestHumanConfirmation('click → Post');
    await vi.waitFor(() => expect(mod.getPendingConfirmation()).not.toBeNull());

    expect(mod.answerConfirmation('cfm-someone-elses-prompt', true)).toBe(false);
    // Still pending, so the correct answer still works.
    const { requestId } = mod.getPendingConfirmation()!;
    expect(mod.answerConfirmation(requestId, true)).toBe(true);
    await expect(pending).resolves.toBe(true);
  });

  it('ignores an answer when nothing is pending', async () => {
    expect(mod.answerConfirmation('cfm-nothing', true)).toBe(false);
  });

  it('declines when the operator never answers', async () => {
    // BREAK: an unanswered prompt auto-proceeding. Silence is not consent.
    vi.useFakeTimers();
    try {
      const sendMessage = vi.fn().mockReturnValue(new Promise(() => {}));
      (globalThis as unknown as { chrome: { runtime: { sendMessage: unknown } } }).chrome.runtime.sendMessage =
        sendMessage;

      const pending = mod.requestHumanConfirmation('click → Pay');
      // Not yet expired — the operator is still within their window. Proving
      // the negative matters as much as the timeout: a prompt that resolved
      // immediately would be consent-by-default.
      let settled = false;
      void pending.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(settled, 'must still be waiting, not auto-approved').toBe(false);

      // Past CONFIRMATION_TIMEOUT_MS (120s), silence is a decline.
      await vi.advanceTimersByTimeAsync(70_000);
      await expect(pending).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
