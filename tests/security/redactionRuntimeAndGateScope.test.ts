/**
 * Two defects that made the agent both unsafe and useless, and that no test
 * could see because both only appear in a real browser with a real model.
 *
 * 1. The redaction models never loaded. onnxruntime-web resolves its runtime
 *    from `wasmPaths`; that was never set, so it fell back to XMLHttpRequest,
 *    which an MV3 service worker does not have. Every model aborted with
 *    "XMLHttpRequest is not defined" and degraded — meaning PII was NOT being
 *    masked while the UI reported the agent as ready. The runtime files were
 *    also never copied into the bundle, so no path could have worked.
 *
 * 2. The destructive-action gate matched the model's own narration. `thought`
 *    and `reason` were in the scanned field list, so a navigate to a blog post
 *    ABOUT posting was gated because the model's summary said "posting", and
 *    the agent stopped to ask a human about a page read.
 *
 * Together these produced the behaviour reported in the field: the agent
 * refuses to post, the operator cannot tell whether that is policy or a
 * broken model, and the honest-looking UI says everything is fine.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { evaluateAction } from '../../server/src/actionPolicy';

const BACKGROUND_SRC = readFileSync(
  join(__dirname, '../../extension/src/entrypoints/background/index.ts'),
  'utf8',
);
const COPY_ASSETS_SRC = readFileSync(
  join(__dirname, '../../extension/scripts/copy-assets.mjs'),
  'utf8',
);
const WXT_CONFIG_SRC = readFileSync(
  join(__dirname, '../../extension/wxt.config.ts'),
  'utf8',
);

const POLICY = { maxStep: 35, step: 1 };

describe('the redaction runtime is loadable in a service worker', () => {
  it('sets ort.env.wasm.wasmPaths', () => {
    // Without this ORT resolves its runtime through XMLHttpRequest, which does
    // not exist in an MV3 service worker. The failure is silent in the UI.
    expect(BACKGROUND_SRC).toMatch(/ort\.env\.wasm\.wasmPaths\s*=/);
  });

  it('resolves the runtime from the extension origin, not a remote host', () => {
    // A CDN path would also break the zero-egress claim: the runtime would be
    // fetched off-origin, and every frame is redacted through it.
    expect(BACKGROUND_SRC).toMatch(/wasmPaths[\s\S]{0,200}runtime\.getURL/);
    const block = /wasmPaths\s*=\s*\{[\s\S]{0,400}?\}/.exec(BACKGROUND_SRC)?.[0] ?? '';
    expect(block).not.toMatch(/https?:\/\//);
  });

  it('keeps numThreads at 1, since SharedArrayBuffer is unavailable', () => {
    expect(BACKGROUND_SRC).toMatch(/ort\.env\.wasm\.numThreads\s*=\s*1/);
  });

  it('copies the runtime into the bundle at build time', () => {
    expect(COPY_ASSETS_SRC).toMatch(/onnxruntime-web/);
    expect(COPY_ASSETS_SRC).toMatch(/ort-wasm-simd-threaded\.wasm/);
  });

  it('exposes the runtime to the extension', () => {
    expect(WXT_CONFIG_SRC).toMatch(/ort\/\*/);
  });

  it('warns loudly if the runtime is missing rather than degrading silently', () => {
    // A missing runtime is a privacy failure, not a performance nit: the
    // models that mask PII cannot load without it.
    expect(COPY_ASSETS_SRC).toMatch(/warn[\s\S]{0,120}models will degrade/i);
  });
});

describe('the destructive gate judges the control, not the commentary', () => {
  const gated = (a: Record<string, unknown>) =>
    evaluateAction(a, POLICY).requiresConfirmation;

  it('still gates clicking a control labelled with a destructive verb', () => {
    // The whole point of the gate. Unchanged.
    expect(gated({ action: 'click', selector: '#post-btn' })).toBe(true);
    expect(gated({ action: 'click', target: 'Delete' })).toBe(true);
    expect(gated({ action: 'click', id: 'agent-4', selector: '[aria-label="Send"]' })).toBe(true);
  });

  it('does NOT gate because the model merely TALKED about a destructive verb', () => {
    // The regression. `thought` and `reason` are the model's narration; a page
    // about posting, or a summary mentioning transfers, is not an irreversible
    // action. Before this fix each of these returned true.
    expect(
      gated({
        action: 'navigate',
        value: 'https://example.com/blog/posting-guide',
        thought: 'I should post something after reading this',
        reason: 'the page discusses posting',
      }),
    ).toBe(false);

    expect(
      gated({
        action: 'click',
        selector: '#article-body',
        thought: 'this section explains wire transfer fees',
        reason: 'reading about transfers',
      }),
    ).toBe(false);
  });

  it('does NOT gate ordinary work', () => {
    expect(gated({ action: 'navigate', value: 'https://example.com/inbox' })).toBe(false);
    expect(gated({ action: 'type', selector: '#search', value: 'cats' })).toBe(false);
    expect(gated({ action: 'scroll', value: 'down' })).toBe(false);
    expect(gated({ action: 'screenshot' })).toBe(false);
  });

  it('does not let a concluding summary trip the gate', () => {
    // A `done` whose summary mentions a purchase should end the run normally.
    expect(
      gated({ action: 'done', summary: 'Completed the checkout flow', thought: 'purchase done' }),
    ).toBe(false);
  });
});

describe('autonomy does not mean removing the gate', () => {
  it('the gate is still reachable, so autonomy was achieved by narrowing it', () => {
    // Guard against a future "make it autonomous" change that deletes the
    // control instead of fixing its false positives.
    expect(BACKGROUND_SRC).toMatch(/requestHumanConfirmation/);
    expect(BACKGROUND_SRC).toMatch(/needs confirmation and was not approved/);
  });

  it('a genuinely destructive action is still refused without approval', () => {
    const verdict = evaluateAction({ action: 'click', selector: '#delete-account' }, POLICY);
    expect(verdict.requiresConfirmation).toBe(true);
    expect(verdict.allowed).toBe(true);
    expect(verdict.risk).toBe('dangerous');
  });
});
