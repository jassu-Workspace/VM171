/**
 * Response-schema tests — Phase 3
 * ---------------------------------------------------------------------------
 * The old `parseActionJson` had no test coverage at all, which is why a
 * heuristic that guessed at malformed output survived. These cases pin the
 * behaviour that replaced it.
 *
 * The property under test is not "does it parse" — it is "does it refuse
 * anything the extension must never act on".
 */
import { describe, it, expect } from 'vitest';
import { parseActionResponse, ActionResponseSchema } from '../../server/src/responseSchema';

describe('parseActionResponse — well-formed replies', () => {
  it('accepts a minimal valid action', () => {
    const out = parseActionResponse('{"action":"click","id":"agent-14"}');
    expect(out.action).toBe('click');
    expect(out.id).toBe('agent-14');
  });

  it('accepts every action in the documented vocabulary', () => {
    for (const a of ['click', 'select', 'zoom', 'type', 'navigate', 'scroll', 'wait', 'done', 'back']) {
      expect(parseActionResponse(JSON.stringify({ action: a })).action).toBe(a);
    }
  });

  it('unwraps a ```json fence, which models emit constantly', () => {
    const out = parseActionResponse('```json\n{"action":"type","value":"hello"}\n```');
    expect(out.action).toBe('type');
    expect(out.value).toBe('hello');
  });

  it('unwraps a bare ``` fence with no language tag', () => {
    expect(parseActionResponse('```\n{"action":"wait"}\n```').action).toBe('wait');
  });

  it('keeps a free-form scratchpad, whose shape differs per domain', () => {
    const out = parseActionResponse(
      JSON.stringify({ action: 'done', scratchpad: { candidates: [{ id: 1 }], anything: 'goes' } }),
    );
    expect(out.scratchpad).toBeDefined();
    expect((out.scratchpad as Record<string, unknown>).anything).toBe('goes');
  });
});

describe('parseActionResponse — refusals', () => {
  it('rejects a hallucinated action verb rather than forwarding it', () => {
    // The point of the enum. An unknown verb reaching executeAction is the
    // exact failure this schema exists to prevent.
    expect(() => parseActionResponse('{"action":"delete_everything"}')).toThrow(/validation/);
  });

  it('rejects a missing action field', () => {
    expect(() => parseActionResponse('{"thought":"hmm"}')).toThrow(/validation/);
  });

  it('rejects an unknown top-level key', () => {
    // Stripping the key and hoping nothing used it is not safe enough when
    // the model invented it.
    expect(() => parseActionResponse('{"action":"click","execute_shell":"rm -rf /"}')).toThrow();
  });

  it('rejects an empty response', () => {
    expect(() => parseActionResponse('   ')).toThrow(/empty/);
  });

  it('rejects plain prose with no JSON at all', () => {
    expect(() => parseActionResponse('I think you should click the button')).toThrow(/not valid JSON/);
  });

  it('rejects malformed JSON with a trailing comma', () => {
    // The old implementation silently repaired this. Now it does not, which
    // is the intended change: a repair step is a guess, and a guess about an
    // action that clicks a live button is not a good guess.
    expect(() => parseActionResponse('{"action":"click",}')).toThrow(/not valid JSON/);
  });

  it('rejects JSON embedded in surrounding prose', () => {
    // The old brace-searching would have found this object. Refusing is
    // correct: prose around the payload is a signal the model is confused.
    expect(() => parseActionResponse('Sure! {"action":"click"} Hope that helps.')).toThrow();
  });

  it('rejects an oversized value rather than forwarding it', () => {
    const huge = 'x'.repeat(70_000);
    expect(() => parseActionResponse(JSON.stringify({ action: 'type', value: huge }))).toThrow(/validation/);
  });

  it('rejects a response over 1MB before attempting to parse it', () => {
    const huge = JSON.stringify({ action: 'click', value: 'x'.repeat(1_100_000) });
    expect(() => parseActionResponse(huge)).toThrow(/exceeds 1MB/);
  });
});

describe('ActionResponseSchema', () => {
  it('exposes the schema for direct use', () => {
    expect(ActionResponseSchema.safeParse({ action: 'click' }).success).toBe(true);
    expect(ActionResponseSchema.safeParse({ action: 'nope' }).success).toBe(false);
  });
});
