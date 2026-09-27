/**
 * Request contract — Cycle 2.9 (Task 3)
 * ---------------------------------------------------------------------------
 * /api/step validated two fields with hand-rolled `typeof` checks and trusted
 * everything else: the base64 images, the legend, the action history, the
 * sub-task list. No shape check, no ceiling, no rejection of unknown keys.
 *
 * Since the server was reachable from any web page (Cycle 2.5), "trusted"
 * meant "whatever a page sent".
 *
 * `.strict()` is the load-bearing choice: the extension sends exactly twelve
 * keys, so anything else is a client bug or an attempt to smuggle a field past
 * whatever validator comes next.
 *
 * Ceilings are grounded in measurement, not taste — 176 screenshots, median
 * 130 KB, max 197 KB, and up to three base64 frames per step gives a realistic
 * step of ~0.8 MB. Limits sit an order of magnitude above that so normal
 * operation is never at the boundary.
 *
 * ORDERING: this runs BEFORE the PII firewall. Malformed payloads are rejected
 * on shape; the firewall still guards well-formed ones. Both layers survive.
 */
import { z } from 'zod';

/**
 * Base64 image payload.
 *
 * The charset is constrained here, before Cycle 1.5's magic-byte check, so
 * arbitrary bytes never reach the format validator. Length is bounded well
 * above the ~264 KB a max-size frame produces.
 */
const base64Image = z
  .string()
  .max(8 * 1024 * 1024, 'image payload exceeds 8MB')
  .regex(/^[A-Za-z0-9+/\s]*={0,2}$/, 'image payload is not base64')
  .optional()
  .nullable();

const legendEntry = z
  .object({
    id: z.string().max(32),
    type: z.string().max(64),
    bbox: z.array(z.number().finite()).length(4, 'bbox must be exactly four numbers'),
  })
  .strict();

const actionEntry = z
  .object({
    action: z.string().max(64),
    target: z.string().max(512).optional(),
    value: z.string().max(8192).optional(),
  })
  .strict();

/** The Cycle 1.4 provenance envelope. Normalised further by redactionPolicy. */
const redactionEnvelope = z
  .object({
    state: z.enum(['verified', 'degraded', 'unavailable']).optional(),
    engine: z.string().max(64).optional(),
    degradedAt: z.string().max(64).nullable().optional(),
    reason: z.string().max(1024).optional(),
    violations: z.array(z.string().max(256)).max(50).optional(),
  })
  .strict()
  .optional()
  .nullable();

export const MAX_SCRATCHPAD_BYTES = 16384;

const boundedScratchpad = z
  .unknown()
  .refine(
    (val) => {
      if (val === undefined || val === null) return true;
      try {
        const str = typeof val === 'string' ? val : JSON.stringify(val);
        return str.length <= MAX_SCRATCHPAD_BYTES;
      } catch {
        return false;
      }
    },
    `scratchpad exceeds ${MAX_SCRATCHPAD_BYTES} bytes`
  )
  .optional()
  .nullable();

export const StepSchema = z
  .object({
    // `.refine` rather than `.min(1)`: min(1) accepts a string of spaces, and
    // the hand-rolled check this replaced was `task.trim().length === 0`. A
    // whitespace-only task is exactly as useless to the model and exactly as
    // good a place to smuggle content as an empty one.
    task: z
      .string()
      .max(8192, 'task exceeds 8192 characters')
      .refine((s) => s.trim().length > 0, 'task must not be empty'),
    maskedDom: z.string().max(2 * 1024 * 1024, 'maskedDom exceeds 2MB'),
    redactedImage: base64Image,
    redaction_legend: z.array(legendEntry).max(500, 'too many legend entries').optional().nullable(),
    scratchpad: boundedScratchpad,
    sessionId: z.string().max(64, 'sessionId exceeds 64 characters').optional().nullable(),
    step: z.number().int('step must be an integer').min(0).max(10_000).optional().nullable(),
    rawImage: base64Image,
    vlmImage: base64Image,
    subTasks: z.array(z.string().max(4096)).max(200, 'too many subTasks').optional().nullable(),
    actionHistory: z.array(actionEntry).max(200, 'too many actionHistory entries').optional().nullable(),
    redaction: redactionEnvelope,
  })
  .strict();

export const SessionInitSchema = z
  .object({
    sessionId: z.string().max(64).optional(),
    task: z.string().max(8192).optional(),
  })
  .strict();

export const SessionFinalizeSchema = z
  .object({
    sessionId: z.string().max(64).optional(),
    summary: z.string().max(8192).optional(),
  })
  .strict();

export const SessionScreenshotSchema = z
  .object({
    sessionId: z.string().max(64).optional(),
    step: z.number().int().min(0).max(10_000).optional(),
    image: base64Image,
  })
  .strict();

export type StepPayload = z.infer<typeof StepSchema>;
