/**
 * The confirmation gate must be REACHABLE.
 *
 * The gate itself worked: a destructive action was refused pending approval,
 * which is the correct safe default. What did not work is that approval could
 * never be GIVEN. `requestHumanConfirmation` sent a message nothing listened
 * for, and neither the request nor any reply type existed in the validated
 * message unions, so the reply would also have been rejected at the boundary.
 * Every gated action — post, send, share, delete, pay, transfer — could only
 * ever time out and decline.
 *
 * The existing confirmationGate.test.ts mocks `sendMessage`, so it proves the
 * function READS a reply while proving nothing can SEND one. That is how a
 * feature which cannot work passed its own tests.
 *
 * These tests therefore assert against the real schemas and the real handler
 * wiring, not against a mock.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  BackgroundMessageSchema,
  SidepanelMessageSchema,
  ConfirmResponseMessageSchema,
  ConfirmationRequestMessageSchema,
  ConfirmationResolvedMessageSchema,
} from '../../extension/src/types/messages';

const BACKGROUND_SRC = readFileSync(
  join(__dirname, '../../extension/src/entrypoints/background/index.ts'),
  'utf8',
);
const SIDEPANEL_SRC = readFileSync(
  join(__dirname, '../../extension/src/entrypoints/sidepanel/App.tsx'),
  'utf8',
);

describe('the confirmation request is a valid message', () => {
  it('is accepted by the sidepanel union so the prompt can be rendered', () => {
    const parsed = SidepanelMessageSchema.safeParse({
      type: 'CONFIRMATION_REQUEST',
      payload: { label: 'click → Post', requestId: 'cfm-abc123' },
    });
    expect(parsed.success).toBe(true);
  });

  it('carries a requestId, which the answer must echo back', () => {
    const parsed = ConfirmationRequestMessageSchema.safeParse({
      type: 'CONFIRMATION_REQUEST',
      payload: { label: 'click → Post', requestId: 'cfm-abc123' },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a prompt with no requestId, which could never be answered', () => {
    const parsed = ConfirmationRequestMessageSchema.safeParse({
      type: 'CONFIRMATION_REQUEST',
      payload: { label: 'click → Post' },
    });
    expect(parsed.success).toBe(false);
  });
});

describe('the confirmation answer is a valid message', () => {
  it('is accepted by the background union — the handler that was missing', () => {
    const parsed = BackgroundMessageSchema.safeParse({
      type: 'CONFIRM_RESPONSE',
      payload: { confirmed: true, requestId: 'cfm-abc123' },
    });
    expect(parsed.success).toBe(true);
  });

  it('requires a boolean decision and a requestId', () => {
    expect(
      ConfirmResponseMessageSchema.safeParse({
        type: 'CONFIRM_RESPONSE',
        payload: { confirmed: true, requestId: 'cfm-abc123' },
      }).success,
    ).toBe(true);

    // No requestId: cannot be correlated, so it must not be accepted.
    expect(
      ConfirmResponseMessageSchema.safeParse({
        type: 'CONFIRM_RESPONSE',
        payload: { confirmed: true },
      }).success,
    ).toBe(false);

    // Not a boolean: "maybe" is not approval.
    expect(
      ConfirmResponseMessageSchema.safeParse({
        type: 'CONFIRM_RESPONSE',
        payload: { confirmed: 'yes', requestId: 'cfm-abc123' },
      }).success,
    ).toBe(false);
  });

  it('carries a dismissal message so a stale prompt can be cleared', () => {
    expect(
      SidepanelMessageSchema.safeParse({
        type: 'CONFIRMATION_RESOLVED',
        payload: { requestId: 'cfm-abc123' },
      }).success,
    ).toBe(true);
    expect(ConfirmationResolvedMessageSchema.safeParse({
      type: 'CONFIRMATION_RESOLVED',
      payload: { requestId: 'cfm-abc123' },
    }).success).toBe(true);
  });
});

describe('the round trip is actually wired', () => {
  // These are the assertions that would have failed before the fix. They read
  // the real source rather than exercising a mock, because the defect was
  // precisely that no real listener existed.

  it('the background HANDLES CONFIRM_RESPONSE', () => {
    expect(BACKGROUND_SRC).toMatch(/message\.type === ['"]CONFIRM_RESPONSE['"]/);
  });

  it('the sidepanel LISTENS for the prompt', () => {
    expect(SIDEPANEL_SRC).toMatch(/CONFIRMATION_REQUEST/);
  });

  it('the sidepanel SENDS an answer', () => {
    expect(SIDEPANEL_SRC).toMatch(/CONFIRM_RESPONSE/);
  });

  it('the sidepanel renders an Approve control and a Decline control', () => {
    expect(SIDEPANEL_SRC).toMatch(/Approve/);
    expect(SIDEPANEL_SRC).toMatch(/Decline/);
  });

  it('the background sends the prompt rather than only waiting', () => {
    // Before the fix the only thing that ever answered was the timeout, which
    // is why the agent silently stalled for 60s on any gated action.
    expect(BACKGROUND_SRC).toMatch(/type: ['"]CONFIRMATION_REQUEST['"]/);
  });
});

describe('a stale answer cannot approve a different action', () => {
  // The dangerous failure mode this guards: the operator is shown "Post",
  // walks away, and by the time they click Approve the agent has moved to
  // "Transfer funds". The id makes that impossible.

  it('the background compares the answer against the pending prompt', () => {
    expect(BACKGROUND_SRC).toMatch(/requestId\s*!==\s*requestId|!==\s*pending\.requestId/);
  });

  it('ignores an answer when nothing is pending', () => {
    expect(BACKGROUND_SRC).toMatch(/answerConfirmation[\s\S]{0,200}!pending/);
  });
});

describe('failing closed is preserved', () => {
  it('the background still declines on timeout rather than assuming approval', () => {
    // The whole point of the feature. Making approval reachable must not have
    // turned an unanswered prompt into consent.
    expect(BACKGROUND_SRC).toMatch(/setTimeout\([\s\S]{0,80}res\(false\)/);
  });

  it('the timeout is still finite, so a forgotten sidepanel cannot park the agent forever', () => {
    expect(BACKGROUND_SRC).toMatch(/CONFIRMATION_TIMEOUT_MS\s*=\s*\d/);
  });
});
