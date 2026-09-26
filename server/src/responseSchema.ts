/**
 * Upstream model response contract — Phase 3
 * ---------------------------------------------------------------------------
 * `/api/step` validated its REQUESTS rigorously with a strict zod schema
 * (see schemas.ts, Cycle 2.9) but trusted the model's REPLY. The reply was
 * run through `parseActionJson`, which stripped markdown fences, searched
 * for the first `{` and the last `}`, removed trailing commas, and parsed
 * whatever survived. That is rescuing malformed output rather than
 * constraining it, and the result flows straight into the action executed
 * on a web page.
 *
 * The asymmetry was the defect: this project clearly understood that an
 * unvalidated boundary is a security property, and applied that reasoning
 * to one side of the conversation only.
 *
 * Design:
 *   - The schema describes the action vocabulary the prompts actually ask
 *     for. An action name outside this set is not "unexpected but probably
 *     fine" — it is either a hallucination or an attempt to steer the
 *     agent, and the extension should never see it.
 *   - `.passthrough()` on the scratchpad, NOT on the action itself. The
 *     scratchpad is a free-form working memory the prompts define per
 *     domain, so pinning its shape would reject valid replies. The action
 *     fields are NOT free-form; that is the point.
 *   - Length ceilings on every string, consistent with the request schema.
 *     A model that returns a 5 MB selector should fail, not be forwarded.
 *
 * ORDERING: the raw text is JSON-parsed first (that is unavoidable — the
 * model returns text), and only then validated. Fence-stripping is kept
 * for exactly one reason, documented below: models wrap JSON in ```json
 * constantly, and rejecting that is a false negative, not a safety win.
 */
import { z } from 'zod';

/**
 * The action vocabulary. Every value here appears in the JSON Output Format
 * blocks in index.ts. `select` and `zoom` are the two that are easy to
 * forget and that the extension's own prompts rely on heavily.
 */
export const ACTION_NAMES = [
  'click',
  'select',
  'zoom',
  'type',
  'navigate',
  'scroll',
  'wait',
  'done',
  'back',
] as const;

export const ActionResponseSchema = z
  .object({
    /** One sentence of reasoning. Free text, but bounded. */
    thought: z.string().max(4096).optional(),

    /**
     * The action verb. `.strict()` on the enum means a hallucinated or
     * injected verb is a validation failure rather than something the
     * extension has to defend against downstream.
     */
    action: z.enum(ACTION_NAMES),

    /** Element id assigned by the content script, when one is known. */
    id: z.string().max(512).optional(),

    /** CSS selector or element keyword. */
    selector: z.string().max(2048).optional(),

    /** Typed text, URL, option label, or 'in'/'out' for zoom. */
    value: z.string().max(65536).optional(),

    scroll_direction: z.enum(['up', 'down']).optional(),

    /** Terminal summary. Only meaningful alongside action: 'done'. */
    summary: z.string().max(8192).optional(),

    /**
     * The model's working memory. `.passthrough()` rather than `.strict()`:
     * the prompts define a different scratchpad shape per domain (shopping
     * tracks candidates, workflow tracks milestones, ISRO tracks telemetry),
     * so enumerating them here would reject valid replies. It carries no
     * executable meaning — the action above is what gets performed.
     */
    scratchpad: z.record(z.string(), z.unknown()).optional(),

    taskMode: z.string().max(64).optional(),
    domain: z.string().max(64).optional(),
  })
  // Unknown top-level keys are rejected. A model that invents an
  // `execute_shell` key has hallucinated, and the safest response to a
  // hallucinated key is to refuse the whole object rather than strip the key
  // and hope nothing depended on it.
  .strict();

export type ActionResponse = z.infer<typeof ActionResponseSchema>;

/**
 * Parse a raw model reply into a validated action.
 *
 * Replaces the old fence-stripping-plus-brace-searching heuristic. The one
 * concession to reality is the ```json wrapper: models emit it constantly,
 * and treating a well-formed object as invalid purely because of markdown
 * fencing is a false negative, not a safety improvement. Everything AFTER
 * the JSON parse is schema-enforced — no comma-stripping, no brace
 * searching, no best-effort salvage.
 *
 * Throws with a caller-legible reason. The caller decides the HTTP status
 * and whether to retry; this function does not silently return a
 * half-validated object.
 */
export function parseActionResponse(text: string): ActionResponse {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (trimmed.length === 0) {
    throw new Error('Model returned an empty response.');
  }

  // Length ceiling before parsing, so a pathological response cannot make
  // JSON.parse allocate unboundedly.
  if (trimmed.length > 1_000_000) {
    throw new Error('Model response exceeds 1MB and was rejected before parsing.');
  }

  let candidate = trimmed;
  if (candidate.startsWith('```')) {
    candidate = candidate
      .replace(/^```(?:json)?\s*\n?/i, '')
      .replace(/\n?```\s*$/i, '')
      .trim();
  }

  let raw: unknown;
  try {
    // No comma-stripping and no brace-searching. If it is not valid JSON,
    // it is not valid JSON.
    raw = JSON.parse(candidate);
  } catch {
    throw new Error('Model response was not valid JSON.');
  }

  const result = ActionResponseSchema.safeParse(raw);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first?.path.join('.') || '(root)';
    // The reason is safe to log and to return: it names a FIELD and a
    // problem, never the content. Returning the offending value would leak
    // model output into a response body for no benefit.
    throw new Error(
      `Model response failed validation at ${path}: ${first?.message ?? 'invalid'}`,
    );
  }

  return result.data;
}
