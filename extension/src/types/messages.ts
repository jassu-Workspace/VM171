/**
 * Extension internal message schemas and contracts — Cycle 3.7
 * ---------------------------------------------------------------------------
 * Background and content script message listeners previously accepted untyped
 * payloads from `browser.runtime.onMessage.addListener`. Chrome and the WXT
 * runtime type incoming messages as `unknown`, which led to unchecked property
 * accesses and TS18046 compiler errors.
 *
 * More importantly, `runtime.onMessage` is an external security boundary:
 * any extension component, content script, or caller with messaging access
 * can dispatch messages into these handlers. Treating incoming payloads as
 * trusted objects without shape validation allows arbitrary or malformed data
 * to reach internal handlers.
 *
 * `.strict()` is enforced across all message schemas (with controlled
 * passthrough only on extensible action decisions) so unknown or smuggled keys
 * are rejected immediately at the boundary before processing.
 *
 * Ceilings on strings and payloads prevent resource exhaustion and runaway
 * memory allocation across the extension boundary.
 */
import { z } from 'zod';

/**
 * Action decision payload executed by the content script (Cycle 3.1).
 * Supports standard navigation, typing, clicks, and progression actions.
 */
export const ActionDecisionSchema = z
  .object({
    action: z.string().max(64, 'action name exceeds 64 characters'),
    id: z.string().max(512).optional(),
    selector: z.string().max(2048).optional(),
    target: z.string().max(2048).optional(),
    value: z.string().max(65536).optional(),
    text: z.string().max(65536).optional(),
    thought: z.string().max(8192).optional(),
    scroll_direction: z.string().max(32).optional(),
    taskMode: z.string().max(64).optional(),
    domain: z.string().max(512).optional(),
    policyBlocked: z.boolean().optional(),
    policyReason: z.string().max(1024).optional(),
    policyRisk: z.enum(['safe', 'caution', 'dangerous']).optional(),
    requiresConfirmation: z.boolean().optional(),
    amount: z.number().optional(),
    summary: z.string().max(8192).optional(),
    url: z.string().max(4096).optional(),
    updatedScratchpad: z.unknown().optional(),
    isSubmitAction: z.boolean().optional(),
    buttonLabel: z.string().max(256).optional(),
    wasInsideDialog: z.boolean().optional(),
  })
  .passthrough();

export type ActionDecisionPayload = z.infer<typeof ActionDecisionSchema>;

/* ---------------------------------------------------------------------------
 * Background Service Worker Messages
 * ------------------------------------------------------------------------- */

export const GetTelemetryMessageSchema = z
  .object({
    type: z.literal('GET_TELEMETRY'),
  })
  .strict();

export const GetModelStatusMessageSchema = z
  .object({
    type: z.literal('GET_MODEL_STATUS'),
  })
  .strict();

export const CaptureTabMessageSchema = z
  .object({
    type: z.literal('CAPTURE_TAB'),
  })
  .strict();

export const StopAgentMessageSchema = z
  .object({
    type: z.literal('STOP_AGENT'),
  })
  .strict();

export const StartAgentMessageSchema = z
  .object({
    type: z.literal('START_AGENT'),
    payload: z
      .string()
      .max(8192, 'task exceeds 8192 characters')
      .refine((s) => s.trim().length > 0, 'task must not be empty'),
    targetTabId: z.number().int().optional(),
  })
  .strict();

export const BackgroundMessageSchema = z.discriminatedUnion('type', [
  GetTelemetryMessageSchema,
  GetModelStatusMessageSchema,
  CaptureTabMessageSchema,
  StopAgentMessageSchema,
  StartAgentMessageSchema,
]);

export type BackgroundMessage = z.infer<typeof BackgroundMessageSchema>;
export type GetTelemetryMessage = z.infer<typeof GetTelemetryMessageSchema>;
export type GetModelStatusMessage = z.infer<typeof GetModelStatusMessageSchema>;
export type CaptureTabMessage = z.infer<typeof CaptureTabMessageSchema>;
export type StopAgentMessage = z.infer<typeof StopAgentMessageSchema>;
export type StartAgentMessage = z.infer<typeof StartAgentMessageSchema>;

/* ---------------------------------------------------------------------------
 * Content Script Messages
 * ------------------------------------------------------------------------- */

export const PingMessageSchema = z
  .object({
    type: z.literal('PING'),
  })
  .strict();

export const GetDomMessageSchema = z
  .object({
    type: z.literal('GET_DOM'),
  })
  .strict();

export const ExecuteActionMessageSchema = z
  .object({
    type: z.literal('EXECUTE_ACTION'),
    payload: ActionDecisionSchema,
  })
  .strict();

export const WaitForStableMessageSchema = z
  .object({
    type: z.literal('WAIT_FOR_STABLE'),
  })
  .strict();

export const ShowShieldMessageSchema = z
  .object({
    type: z.literal('SHOW_SHIELD'),
    payload: z
      .object({
        active: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const AuditPageMessageSchema = z
  .object({
    type: z.literal('AUDIT_PAGE'),
  })
  .strict();

export const GetScreenshotMessageSchema = z
  .object({
    type: z.literal('GET_SCREENSHOT'),
  })
  .strict();

export const GetProgressionButtonMessageSchema = z
  .object({
    type: z.literal('GET_PROGRESSION_BUTTON'),
  })
  .strict();

export const ContentMessageSchema = z.discriminatedUnion('type', [
  PingMessageSchema,
  GetDomMessageSchema,
  ExecuteActionMessageSchema,
  WaitForStableMessageSchema,
  ShowShieldMessageSchema,
  AuditPageMessageSchema,
  GetScreenshotMessageSchema,
  GetProgressionButtonMessageSchema,
]);

export type ContentMessage = z.infer<typeof ContentMessageSchema>;
export type PingMessage = z.infer<typeof PingMessageSchema>;
export type GetDomMessage = z.infer<typeof GetDomMessageSchema>;
export type ExecuteActionMessage = z.infer<typeof ExecuteActionMessageSchema>;
export type WaitForStableMessage = z.infer<typeof WaitForStableMessageSchema>;
export type ShowShieldMessage = z.infer<typeof ShowShieldMessageSchema>;
export type AuditPageMessage = z.infer<typeof AuditPageMessageSchema>;
export type GetScreenshotMessage = z.infer<typeof GetScreenshotMessageSchema>;
export type GetProgressionButtonMessage = z.infer<typeof GetProgressionButtonMessageSchema>;
