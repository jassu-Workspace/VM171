/**
 * Typed message contract — Cycle 3.6
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS FIXES
 *
 * The background and the content script exchange thirteen message types, and
 * every one of them was untyped. `browser.tabs.sendMessage` returns `{}` by
 * default, so `response.success`, `response.data`, `response.image` and the
 * rest were all `any` in practice and all unchecked by the compiler.
 *
 * That is not a cosmetic problem. It means a field renamed on one side is
 * `undefined` on the other at RUNTIME, with no error anywhere — which is
 * exactly the class of defect that has bitten this project repeatedly:
 * unescaped DOM fields, an envelope that was never sent, a redaction state
 * nothing consumed. Each was invisible to every tool in the repo.
 *
 * The contract is declared once, here, and both sides are checked against it.
 * Adding a message type without declaring its payload no longer compiles.
 *
 * Note on the shape: responses are modelled as a discriminated map keyed by
 * request type, so `sendToTab(tabId, 'GET_DOM')` returns the DOM response type
 * rather than `{}`. Payloads the content script does not consume are omitted
 * rather than typed `any`, so a caller cannot pass one by accident.
 */

/** Redaction provenance, as produced by the content script (Cycle 1.2). */
export interface RedactionEnvelope {
  state: 'verified' | 'degraded' | 'unavailable';
  engine: string;
  degradedAt: string | null;
  reason: string;
  violations: string[];
}

export interface LegendEntry {
  id: string;
  type: string;
  bbox: number[];
}

export interface MaskedDomElement {
  id: string;
  tag: string;
  text: string;
  meta?: string;
}

export interface ActionDecision {
  action: string;
  id?: string;
  selector?: string;
  target?: string;
  value?: string;
  thought?: string;
  scroll_direction?: string;
  taskMode?: string;
  domain?: string;
  /** Cycle 3.1: set by the server-side action policy. */
  policyBlocked?: boolean;
  policyReason?: string;
  policyRisk?: 'safe' | 'caution' | 'dangerous';
  requiresConfirmation?: boolean;
}

export interface OkResponse {
  success: true;
}

export interface ErrorResponse {
  success: false;
  error: string;
}

export type Result<T> = (T & OkResponse) | ErrorResponse;

/** Request payload -> response type. */
export interface TabMessageMap {
  PING: { request: Record<string, never>; response: OkResponse };
  GET_DOM: {
    request: Record<string, never>;
    response: Result<{ data: string }>;
  };
  GET_SCREENSHOT: {
    request: Record<string, never>;
    response: Result<{
      image: string;
      rawImage?: string;
      legend?: LegendEntry[];
      redaction?: RedactionEnvelope;
    }>;
  };
  EXECUTE_ACTION: {
    request: { payload: ActionDecision };
    response: Result<{ submitted?: boolean }>;
  };
  WAIT_FOR_STABLE: {
    request: Record<string, never>;
    response: Result<{ stable: boolean }>;
  };
  SHOW_SHIELD: {
    request: { payload: { active: boolean } };
    response: OkResponse;
  };
  GET_PROGRESSION_BUTTON: {
    request: Record<string, never>;
    response: Result<{ found: boolean; id?: string; selector?: string; label?: string }>;
  };
}

export type TabMessageType = keyof TabMessageMap;

/**
 * Send a typed message to a content script.
 *
 * The response type follows from the message type, so `response.data` is
 * `string` rather than an error. A send that fails resolves to an ErrorResponse
 * rather than throwing, matching how every call site already handles it.
 */
export async function sendToTab<K extends TabMessageType>(
  browserRuntime: {
    tabs: { sendMessage: (tabId: number, msg: unknown) => Promise<unknown> };
  },
  tabId: number,
  type: K,
  payload?: TabMessageMap[K]['request']
): Promise<TabMessageMap[K]['response']> {
  try {
    const response = await browserRuntime.tabs.sendMessage(tabId, {
      type,
      ...(payload ?? {}),
    });
    if (response && typeof response === 'object') {
      return response as TabMessageMap[K]['response'];
    }
    return { success: false, error: `Empty response for ${type}` };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Runtime -> UI messages, which flow over `runtime.sendMessage`, not tabs. */
export interface UiMessageMap {
  LOG_UPDATE: { payload: string };
  AGENT_STATUS: { payload: { isRunning: boolean } };
  AGENT_ACTIVITY: { payload: Record<string, unknown> };
  SCRATCHPAD_UPDATE: { payload: Record<string, unknown> };
  GET_TELEMETRY: { request: Record<string, never>; response: Record<string, unknown> };
  /** Cycle 3.2: the operator's answer to an irreversible-action prompt. */
  REQUEST_CONFIRMATION: {
    payload: { label: string };
    response: { confirmed: boolean };
  };
}

export type UiMessageType = keyof UiMessageMap;
