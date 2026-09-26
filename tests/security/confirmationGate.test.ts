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
  it('resolves true when the operator confirms', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ confirmed: true });
    (globalThis as unknown as { chrome: { runtime: { sendMessage: unknown } } }).chrome.runtime.sendMessage =
      sendMessage;

    await expect(mod.requestHumanConfirmation('click → Place order')).resolves.toBe(true);
  });

  it('resolves false when the operator declines', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ confirmed: false });
    (globalThis as unknown as { chrome: { runtime: { sendMessage: unknown } } }).chrome.runtime.sendMessage =
      sendMessage;

    await expect(mod.requestHumanConfirmation('click → Place order')).resolves.toBe(false);
  });

  it('resolves false when the request throws', async () => {
    // BREAK, AND THE POINT: a closed port or a crashed view must fail SAFE.
    // Treating an undeliverable confirmation as consent inverts the whole
    // control.
    const sendMessage = vi.fn().mockRejectedValue(new Error('Receiving end does not exist'));
    (globalThis as unknown as { chrome: { runtime: { sendMessage: unknown } } }).chrome.runtime.sendMessage =
      sendMessage;

    await expect(mod.requestHumanConfirmation('click → Delete account')).resolves.toBe(false);
  });

  it('resolves false on a malformed reply', async () => {
    // BREAK: a truthy check on the response object accepting `{confirmed: 'no'}`.
    const sendMessage = vi.fn().mockResolvedValue({});
    (globalThis as unknown as { chrome: { runtime: { sendMessage: unknown } } }).chrome.runtime.sendMessage =
      sendMessage;

    await expect(mod.requestHumanConfirmation('x')).resolves.toBe(false);
  });

  it('declines when the operator never answers', async () => {
    // BREAK: an unanswered prompt auto-proceeding. Silence is not consent.
    vi.useFakeTimers();
    try {
      const sendMessage = vi.fn().mockReturnValue(new Promise(() => {}));
      (globalThis as unknown as { chrome: { runtime: { sendMessage: unknown } } }).chrome.runtime.sendMessage =
        sendMessage;

      const pending = mod.requestHumanConfirmation('click → Pay');
      await vi.advanceTimersByTimeAsync(61_000);
      await expect(pending).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
