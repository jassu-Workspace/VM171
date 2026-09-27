/**
 * The Bridge: Background Service Worker
 * Handles the communication bridge between the popup UI, content script, and the server.
 * Now runs a continuous multimodal agentic loop.
 */
import { browser } from 'wxt/browser';
import * as ort from 'onnxruntime-web';
import { generateSessionId, SessionLogger, AgentSession } from '../../utils/sessionLogger';
import { resolveCaptureSource, type RedactionLegendEntry, type RedactionEnvelope } from '../../utils/captureProvenance';
import { runController } from '../../utils/runControl';

interface ScreenshotResponse {
  success: boolean;
  image?: string;
  rawImage?: string;
  legend?: RedactionLegendEntry[];
  redaction?: RedactionEnvelope;
  error?: string;
}

interface ProgressionButtonResponse {
  success: boolean;
  found: boolean;
  id?: string;
  selector?: string;
  label?: string;
}

interface ActionResultResponse {
  success: boolean;
  error?: string;
  isSubmitAction?: boolean;
  buttonLabel?: string;
  wasInsideDialog?: boolean;
}
import { sendToTab, type ActionDecision } from '../../utils/messaging';
import { getAgentConfig, authHeadersFor, isAllowedServerUrl, DEFAULT_SERVER_URL } from '../../utils/config';
import { detectUIElements, getUIStatus, checkModelAvailability } from '../../utils/onnxEngine';
import { getOcrStatus, checkOcrAvailability } from '../../utils/ocrEngine';
import { BackgroundMessageSchema } from '../../types/messages';

// ONNX Runtime Web configuration: single-threaded WASM fallback,
// safe for MV3 service workers where SharedArrayBuffer is unavailable.
ort.env.wasm.numThreads = 1;

console.log('🛰 Background script initialized');

// Cycle 2.4: the server URL and credential are NO LONGER compiled in.
//
// The old hardcoded shared secret was a public literal — it shipped inside the
// built bundle, so anyone who unpacked the extension held a working credential
// for the local server. Its value is deliberately NOT repeated here: a secret
// written in a comment is still in the source, and is copy-paste bait for
// whoever reads it next.
//
// Both values now come from browser storage, set once through the pairing flow,
// and an UNPAIRED extension must not send anything at all rather than fall back
// to a default. See utils/config.ts for why the server URL is loopback-only.
const MAX_STEPS = 35;

// ── Cycle 3.2 — confirmation bookkeeping ──────────────────────────
//
// A confirmation is bound to the step AND the action, so a confirmation for one
// click cannot be replayed as consent for a different one on a later step.
// A Set of fingerprints, not a boolean per step.
const confirmedActions = new Set<string>();

function actionFingerprint(step: number, action: Record<string, unknown>): string {
  return [
    step,
    String(action.action ?? ''),
    String(action.id ?? ''),
    String(action.selector ?? ''),
    String(action.target ?? ''),
    String(action.value ?? '').slice(0, 64),
  ].join('|');
}

function isStepConfirmed(step: number, action: Record<string, unknown>): boolean {
  return confirmedActions.has(actionFingerprint(step, action));
}

function markStepConfirmed(step: number, action: Record<string, unknown>): void {
  confirmedActions.add(actionFingerprint(step, action));
  // Bound the set: a long run must not accumulate confirmations forever.
  if (confirmedActions.size > 64) {
    const first = confirmedActions.values().next();
    if (!first.done) confirmedActions.delete(first.value);
  }
}

function clearConfirmations(): void {
  confirmedActions.clear();
}

/** A short, human-readable description of what is about to happen. */
export function describeAction(action: Record<string, unknown>): string {
  const type = String(action.action ?? 'act');
  const target =
    (typeof action.target === 'string' && action.target) ||
    (typeof action.selector === 'string' && action.selector) ||
    (typeof action.id === 'string' && action.id) ||
    (typeof action.value === 'string' && action.value.slice(0, 40)) ||
    'the page';
  return `${type} → ${target}`;
}

/**
 * Ask the operator to confirm an irreversible action.
 *
 * Resolves false on ANY failure — a closed port, a crashed view, a timeout —
 * because the safe default for a confirmation you cannot deliver is to not act.
 */
/**
 * The confirmation currently awaiting an answer, if any.
 *
 * Held as module state rather than threaded through the call so the message
 * handler can answer it. `resolve` is attached once the waiter is listening,
 * so an answer that arrives in the same tick as the request is not lost.
 */
interface PendingConfirmation {
  requestId: string;
  label: string;
  resolve: ((accepted: boolean) => void) | null;
}
let pendingConfirmation: PendingConfirmation | null = null;

/**
 * How long to wait for a human before declining. Long enough to read a prompt
 * and answer it, short enough that a forgotten sidepanel does not leave the
 * agent parked indefinitely.
 */
const CONFIRMATION_TIMEOUT_MS = 120_000;

/**
 * Apply the operator's answer. An answer whose requestId does not match the
 * pending prompt is IGNORED and logged, not applied — a stale reply must never
 * approve an action the operator was not shown.
 */
export function answerConfirmation(requestId: string, confirmed: boolean): boolean {
  const pending = pendingConfirmation;
  if (!pending) {
    console.warn('[Confirmation] answer arrived with no prompt pending; ignoring.');
    return false;
  }
  if (pending.requestId !== requestId) {
    console.warn('[Confirmation] answer did not match the pending prompt; ignoring.');
    return false;
  }
  pendingConfirmation = null;
  pending.resolve?.(confirmed);
  return true;
}

/** The prompt awaiting an answer, for a UI that opens after the request. */
export function getPendingConfirmation(): { requestId: string; label: string } | null {
  return pendingConfirmation
    ? { requestId: pendingConfirmation.requestId, label: pendingConfirmation.label }
    : null;
}

export async function requestHumanConfirmation(label: string): Promise<boolean> {
  // Correlate the prompt with its answer. Without an id, a reply that arrives
  // after the agent has moved on to a different destructive step would approve
  // THAT step instead — the operator never saw it. An unmatched reply is
  // dropped and treated as a decline.
  const requestId = `cfm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  pendingConfirmation = { requestId, label, resolve: null };

  // Tell any open UI to prompt. This is a broadcast, not a request/response:
  // if nothing is listening the agent still waits below, and the timeout
  // still declines. Failing closed is the point.
  try {
    browser.runtime
      .sendMessage({ type: 'CONFIRMATION_REQUEST', payload: { label, requestId } })
      .catch(() => {});
  } catch {
    // No UI open. Not an error — the wait below still applies.
  }

  try {
    const accepted = await Promise.race([
      new Promise<boolean>((resolve) => {
        if (pendingConfirmation) pendingConfirmation.resolve = resolve;
      }),
      // Unchanged in spirit: a confirmation that cannot be delivered is a
      // decline. The difference is that it can now actually be delivered.
      new Promise<boolean>((res) => setTimeout(() => res(false), CONFIRMATION_TIMEOUT_MS)),
    ]);
    return accepted;
  } catch (err) {
    console.error('[Confirmation] request failed, defaulting to decline:', err);
    return false;
  } finally {
    pendingConfirmation = null;
    try {
      browser.runtime
        .sendMessage({ type: 'CONFIRMATION_RESOLVED', payload: { requestId } })
        .catch(() => {});
    } catch {
      // No UI open; nothing to clear.
    }
  }
}
const STEP_DELAY_MS = 2500;

// Cycle 3.3: DEPRECATED. This single module-level flag could not express "stop
// THAT run" — starting a second run reset it and silently un-stopped the first,
// and nothing prevented two runs from interleaving clicks and typing on the same
// page. Replaced by runController, which scopes cancellation to a run id and
// refuses a concurrent start. Kept only as a mirror for the two status reads
// below, which the controller now answers authoritatively.
let stopRequested = false;

console.log('🌐 Default server URL:', DEFAULT_SERVER_URL, '(the active URL comes from paired storage)');

/**
 * PHASE 1 — Telemetry Engine (Mission Control Dashboard)
 * In-memory state polled by the dashboard via `{ type: 'GET_TELEMETRY' }`.
 * Uses only standard Web APIs — no native OS APIs, no extra permissions.
 */
export type LoopStatus = 'Idle' | 'Scanning' | 'Redacting' | 'Thinking' | 'Executing';

export interface TelemetryData {
  /** Total number of requests sent to the 9router. */
  apiCalls: number;
  /** Accumulated size (in KB) of masked DOM + base64 images sent. */
  totalPayloadSent: number;
  /** Time taken (in ms) for the last server round-trip. */
  lastLatency: number;
  /** Current agentic-loop state. */
  loopStatus: LoopStatus;
}

const telemetryData: TelemetryData = {
  apiCalls: 0,
  totalPayloadSent: 0,
  lastLatency: 0,
  loopStatus: 'Idle',
};

/**
 * PHASE 5 — Local Model Runtime Status.
 * Tracks the live/degraded status of each on-device model plus the last
 * inference latency. Polled by the dashboard via GET_MODEL_STATUS.
 */
export interface ModelStatusData {
  ui: 'live' | 'degraded';
  face: 'live' | 'degraded';
  ocr: 'live' | 'degraded';
  lastInferenceMs: number;
}

let lastInferenceMs = 0;

const modelStatus: ModelStatusData = {
  ui: 'degraded',
  face: 'degraded',
  ocr: 'degraded',
  lastInferenceMs: 0,
};

/** Whether model files have been checked at least once. */
let modelAvailabilityChecked = false;

/**
 * Check if the MediaPipe face_landmarker.task file exists.
 * Uses GET with Range header instead of HEAD because Chrome MV3 service
 * workers block HEAD requests to browser.runtime.getURL() resources.
 */
async function checkFaceModelAvailability(): Promise<boolean> {
  const url = browser.runtime.getURL('/mediapipe/face_landmarker.task');
  console.log('[background] Checking Face model:', url);
  try {
    const res = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' } });
    console.log('[background] Face model response status:', res.status);
    return res.ok || res.status === 206;
  } catch (error) {
    console.error('[background] Face availability check failed:', error instanceof Error ? error.message : error);
    return false;
  }
}

/**
 * Refresh modelStatus from the engines AND from lightweight file-availability
 * checks. File presence => 'live' even before a session is created, so the
 * dashboard shows the true state at idle.
 */
function refreshModelStatus(): ModelStatusData {
  modelStatus.ui = getUIStatus();
  modelStatus.ocr = getOcrStatus();
  // face status is set by the content script; default degraded here.
  modelStatus.lastInferenceMs = lastInferenceMs;
  return modelStatus;
}

/**
 * Run a one-time lightweight availability check for all three model files.
 * Updates modelStatus in-place so the dashboard can show 'live' at idle.
 * Safe to call repeatedly — only runs until first success.
 */
async function runModelAvailabilityCheck(): Promise<void> {
  console.log('[background] Running model availability checks...');
  try {
    const [uiOk, faceOk, ocrOk] = await Promise.all([
      checkModelAvailability(),
      checkFaceModelAvailability(),
      checkOcrAvailability(),
    ]);
    // Only flip to 'live' if file exists; never override an active session.
    if (uiOk) modelStatus.ui = 'live';
    if (faceOk) modelStatus.face = 'live';
    if (ocrOk) modelStatus.ocr = 'live';
    modelAvailabilityChecked = true;
    console.log('[background] Results - UI:', uiOk, 'Face:', faceOk, 'OCR:', ocrOk);
    console.log('[background] modelStatus after check:', JSON.stringify(modelStatus));
  } catch (error) {
    console.error('[background] Availability check error:', error instanceof Error ? error.message : error);
  }
}

function setLoopStatus(status: LoopStatus): void {
  telemetryData.loopStatus = status;
}

/**
 * Accumulate outbound payload size in KB.
 * maskedDom is a UTF-16 JS string (~1 byte/char for ASCII payloads) and
 * redactedImage is raw base64 — summing char length / 1024 is the standard
 * lightweight client-side approximation (no OS APIs needed).
 */
function trackPayloadSent(maskedDom: string, redactedImage: string): void {
  const chars = (maskedDom?.length ?? 0) + (redactedImage?.length ?? 0);
  telemetryData.totalPayloadSent += chars / 1024;
}

/**
 * Sleep helper for introducing a delay between agent steps
 */
async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Safe wrapper for browser.runtime.sendMessage — catches errors when the
 * popup/dashboard is closed and no listener exists.
 */
function safeSendMessage(message: unknown): void {
  try {
    browser.runtime.sendMessage(message);
  } catch (error) {
    console.warn('Failed to send runtime message (popup may be closed):', error instanceof Error ? error.message : error);
  }
}

/**
 * Sends a POST request to the server with the task, masked DOM, and redacted screenshot
 */
async function callServer(
  task: string,
  maskedDom: string,
  redactedImage: string = '',
  redaction_legend: Array<{ id: string; type: string; bbox: number[] }> = [],
  scratchpad: unknown = null,
  sessionId?: string,
  step?: number,
  rawImage?: string,
  subTasks?: string[],
  actionHistory?: Array<{ action: string; target?: string; value?: string }>,
  vlmImage?: string,
  redactionEnvelope?: {
    state: 'verified' | 'degraded' | 'unavailable';
    engine: string;
    degradedAt: string | null;
    reason: string;
    violations: string[];
  }
) {
  // Cycle 2.4: refuse to send while unpaired. A default token here would be
  // the public literal all over again.
  const config = await getAgentConfig();
  if (!config.valid) {
    const message =
      'Extension is not paired with a server. Open the extension options and complete pairing.';
    console.error('❌', message);
    throw new Error(message);
  }
  const target = `${config.serverUrl}/api/step`;
  console.log('🌐 Sending request to:', target);
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 35_000);

    const response = await fetch(target, {
      method: 'POST',
      mode: 'cors',
      headers: {
        'Content-Type': 'application/json',
        ...authHeadersFor(config),
      },
      body: JSON.stringify({
        task,
        maskedDom,
        redactedImage,
        redaction_legend,
        scratchpad,
        sessionId,
        step,
        rawImage,
        vlmImage: vlmImage || redactedImage || rawImage,
        subTasks,
        actionHistory,
        // Cycle 1.4 integration gap: the envelope was computed but never sent,
        // so the server evaluated `undefined` for every step and counted the
        // whole run as unavailable. A permanently-firing alarm is worse than no
        // alarm, because it teaches the operator to ignore the signal.
        redaction: redactionEnvelope ?? null,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      let errorDetail = `Server responded with status ${response.status}`;
      try {
        const errorJson = await response.json();
        if (errorJson && errorJson.error) {
          errorDetail = `${errorDetail}: ${errorJson.error}`;
        }
      } catch {
        // ignore parse error on error response
      }
      throw new Error(errorDetail);
    }

    return response.json();
  } catch (error) {
    const errorName = error instanceof Error ? error.name : 'Unknown';
    const errorMessage = error instanceof Error ? error.message : String(error);
    const httpStatus = error instanceof Error && error.message.match(/status (\d+)/)
      ? RegExp.$1
      : 'N/A';
    console.error(`❌ SERVER ERROR — name: ${errorName}, message: ${errorMessage}, httpStatus: ${httpStatus}`);
    throw error;
  }
}

/**
 * Local UI Vision via ONNX Runtime Web.
 * Delegates to onnxEngine.detectUIElements which loads ui_detector.onnx
 * from the extension's public directory (browser.runtime.getURL) and runs
 * full YOLOv8 inference (preprocess -> session.run -> postprocess/NMS).
 *
 * Graceful degradation: if ui_detector.onnx is absent, onnxEngine returns
 * [] and status flips to 'degraded'. The agentic loop continues unaffected.
 */
export async function runLocalUIVision(base64Image: string): Promise<any> {
  try {
    const elements = await detectUIElements(base64Image);
    return elements;
  } catch (error) {
    // onnxEngine internally sets status='degraded' and returns [] on failure.
    // This catch is a final safety net so the agentic loop never crashes.
    console.warn('Local UI vision degraded:', error instanceof Error ? error.message : error);
    return [];
  }
}

/**
 * Checks if a tab's URL is restricted by Chrome MV3 security (e.g. chrome://, about:, extension://).
 */
export function isRestrictedUrl(url: string | undefined | null): boolean {
  if (!url) return true;
  return (
    url.startsWith('chrome://') ||
    url.startsWith('chrome-extension://') ||
    url.startsWith('edge://') ||
    url.startsWith('about:') ||
    url.includes('chromewebstore.google.com') ||
    url.includes('chrome.google.com/webstore')
  );
}

/**
 * Ensures the content script is injected into the given tab.
 * In MV3, manifest-declared content scripts are only auto-injected on new
 * page loads — existing tabs need programmatic injection.
 * Returns true if the content script is ready, false otherwise.
 */
async function ensureContentScriptInjected(tabId: number, maxRetries = 5): Promise<boolean> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Ping the content script — if it responds, it's already loaded.
      const response = await sendToTab(browser, tabId, 'PING');
      if (response && response.success) {
        return true;
      }
    } catch {
      // Content script not ready yet.
    }

    try {
      // Programmatically inject the content script via the scripting API.
      await browser.scripting.executeScript({
        target: { tabId },
        files: ['content-scripts/content.js'],
      });
    } catch {
      // Tab may be busy or reloading
    }

    await sleep(400);
  }

  try {
    const response = await sendToTab(browser, tabId, 'PING');
    return !!(response && response.success);
  } catch {
    return false;
  }
}

/**
 * Robustly waits for a tab to finish navigating and ensures its content script is ready.
 */
async function waitForTabReady(tabId: number, timeoutMs = 8000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const tab = await browser.tabs.get(tabId);
      if (tab.status === 'complete') {
        break;
      }
    } catch {
      // tab might be transitioning
    }
    await sleep(300);
  }

  return await ensureContentScriptInjected(tabId, 4);
}

/**
 * Resolves element IDs (e.g. agent-14) or selectors to human-friendly product/button titles
 * using the current masked DOM representation so the HUD and console show readable targets.
 */
function getHumanReadableTarget(
  idOrSelector: string | undefined,
  maskedText: string,
  action: string,
  value?: string
): string {
  if (action === 'back') return 'Search Results Catalog';
  if (action === 'scroll') return value === 'up' ? 'Scroll Up' : 'Scroll Down Page';
  if (action === 'done') return 'Mission Accomplished';
  if (action === 'select' || action === 'choose') {
    if (value && typeof value === 'string') {
      return `"${value.trim()}" in dropdown (${idOrSelector || 'select'})`;
    }
  }
  if (!idOrSelector) return 'Active Page';

  if (typeof idOrSelector === 'string') {
    const rawId = idOrSelector.replace(/^#/, '');
    if (rawId.startsWith('agent-')) {
      const escapedId = rawId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // 1. Match inner text inside element: [agent-X] <tag...>Text</tag>
      const textRegex = new RegExp(`\\[${escapedId}\\][^\n<]*<([a-zA-Z0-9]+)[^>]*>([^<\n\r]{2,80})`, 'i');
      const textMatch = maskedText.match(textRegex);
      if (textMatch && textMatch[2]?.trim()) {
        const cleaned = textMatch[2].trim().replace(/\s+/g, ' ');
        if (cleaned.length > 0 && !cleaned.startsWith('<')) {
          return cleaned.length > 45 ? `"${cleaned.slice(0, 42)}..."` : `"${cleaned}"`;
        }
      }

      // 2. Match placeholder or aria-label or title
      const attrRegex = new RegExp(`\\[${escapedId}\\][^\n]*?(?:placeholder|aria-label|title)="([^"\r\n]{2,60})"`, 'i');
      const attrMatch = maskedText.match(attrRegex);
      if (attrMatch && attrMatch[1]?.trim()) {
        const val = attrMatch[1].trim();
        return val.length > 45 ? `"${val.slice(0, 42)}..."` : `"${val}"`;
      }
      return `#${rawId}`;
    }
  }

  return idOrSelector;
}

export function detectTaskMode(task: string): 'shopping' | 'workflow' | 'info' {
  const lower = task.toLowerCase();

  const shoppingDomains = ['amazon.', 'flipkart.', 'myntra.', 'walmart.', 'ebay.', 'bestbuy.', 'aliexpress.', 'target.', 'ajio.', 'meesho.'];
  const hasShoppingDomain = shoppingDomains.some((d) => lower.includes(d));
  const shoppingKeywords = [
    'under ₹', 'under rs', 'under $', 'buy ', 'purchase', 'shoes', 'smartphone', 'phone under',
    'laptop under', 'cheapest', 'best price', 'discount', 'rating >', 'stars & up', 'add to cart'
  ];
  const hasShoppingKeyword = shoppingKeywords.some((kw) => lower.includes(kw));

  const workflowKeywords = [
    'linkedin', 'twitter', 'x.com', 'tweet', 'mail.', 'gmail', 'outlook', 'hostinger',
    'send email', 'send an email', 'compose', 'draft email', 'write email',
    'google sheet', 'google doc', 'sheets.new', 'docs.new', 'notion', 'spreadsheet',
    'post on', 'create post', 'write post', 'write a post', 'share a post', 'publish', 'submit form', 'fill form',
    'sign up', 'register', 'apply now', 'create an account', 'new sheet', 'new doc',
    'reply to', 'comment on', 'send message', 'direct message', 'shortlist', 'participate'
  ];
  const hasWorkflowKeyword = workflowKeywords.some((kw) => lowerTaskMatch(lower, workflowKeywords));

  const infoKeywords = [
    'sih', 'problem statement', 'research', 'search for', 'find details', 'gather details',
    'scrape', 'extract', 'list all', 'find information', 'wikipedia', 'news', 'articles',
    'bulletin', 'portal', 'results for', 'look up', 'lookup', 'what is', 'who is'
  ];
  const hasInfoKeyword = infoKeywords.some((kw) => lowerTaskMatch(lower, infoKeywords));

  function lowerTaskMatch(text: string, list: string[]): boolean {
    return list.some((k) => text.includes(k));
  }

  if (hasShoppingDomain || (hasShoppingKeyword && !hasWorkflowKeyword)) {
    return 'shopping';
  }
  if (hasWorkflowKeyword) {
    return 'workflow';
  }
  if (hasInfoKeyword) {
    return 'info';
  }
  return 'workflow';
}

/**
 * Resolves direct website destination URL from task when starting from a search engine or blank tab
 */
export function resolveTargetUrlFromTask(task: string, currentUrl?: string): string | null {
  const lower = task.toLowerCase();
  const current = (currentUrl || '').toLowerCase();

  const domainMap: Array<{ triggers: string[]; url: string; hostMatch: string }> = [
    { triggers: ['linkedin.com', 'linkedin'], url: 'https://www.linkedin.com', hostMatch: 'linkedin.com' },
    { triggers: ['twitter.com', 'x.com', 'twitter'], url: 'https://twitter.com', hostMatch: 'x.com' },
    { triggers: ['github.com', 'github'], url: 'https://github.com', hostMatch: 'github.com' },
    { triggers: ['amazon.in', 'amazon.com', 'amazon'], url: 'https://www.amazon.in', hostMatch: 'amazon.' },
    { triggers: ['flipkart.com', 'flipkart'], url: 'https://www.flipkart.com', hostMatch: 'flipkart.com' },
    { triggers: ['gmail.com', 'gmail', 'mail.google.com'], url: 'https://mail.google.com', hostMatch: 'mail.google.com' },
    { triggers: ['sih.gov.in', 'sih portal', 'sih'], url: 'https://sih.gov.in', hostMatch: 'sih.gov.in' },
    { triggers: ['bhuvan.nrsc.gov.in', 'isro bhuvan', 'bhuvan thematic', 'bhuvan'], url: 'https://bhuvan.nrsc.gov.in', hostMatch: 'bhuvan' },
    { triggers: ['bhoonidhi.nrsc.gov.in', 'bhoonidhi'], url: 'https://bhoonidhi.nrsc.gov.in', hostMatch: 'bhoonidhi' },
    { triggers: ['mosdac.gov.in', 'mosdac'], url: 'https://www.mosdac.gov.in', hostMatch: 'mosdac' },
    { triggers: ['vedas.sac.gov.in', 'vedas'], url: 'https://vedas.sac.gov.in', hostMatch: 'vedas' },
    { triggers: ['isro.gov.in', 'isro portal', 'isro website'], url: 'https://www.isro.gov.in', hostMatch: 'isro.gov.in' },
    { triggers: ['youtube.com', 'youtube'], url: 'https://www.youtube.com', hostMatch: 'youtube.com' },
    { triggers: ['reddit.com', 'reddit'], url: 'https://www.reddit.com', hostMatch: 'reddit.com' },
  ];

  const navIntent = /^(?:go to|open|navigate to|visit|browse to|launch)\s+/i.test(lower);

  const isSearchOrBlank =
    !current ||
    current.includes('google.com') ||
    current.includes('google.co') ||
    current.includes('bing.com') ||
    current.includes('duckduckgo.com') ||
    current.includes('newtab') ||
    current.includes('chrome://') ||
    current === 'about:blank';

  for (const entry of domainMap) {
    const matched = entry.triggers.some((t) => lower.includes(t));
    if (matched) {
      if (current.includes(entry.hostMatch)) {
        return null; // already on this domain!
      }
      if (navIntent || isSearchOrBlank) {
        return entry.url;
      }
    }
  }

  // Explicit URL match (e.g. "go to example.com" or "open https://example.com" or starting from search/blank)
  const explicitUrlMatch = lower.match(/\b(?:https?:\/\/)?([a-z0-9-]+\.[a-z]{2,}(?:\/[^\s]*)?)\b/i);
  if (explicitUrlMatch && (navIntent || isSearchOrBlank)) {
    const raw = explicitUrlMatch[0];
    return raw.startsWith('http') ? raw : `https://${raw}`;
  }

  return null;
}

export interface ScratchpadStats {
  evaluatedCount: number;
  rejectedCount: number;
  matchedCount: number;
  rejectionReasons: string[];
  activeMilestone: string;
  completedMilestonesCount: number;
  totalMilestonesCount: number;
  isGoalVerified: boolean;
}

/**
 * Extracts live candidate evaluation and workflow statistics from the working scratchpad
 */
export function extractScratchpadStats(scratchpad: Record<string, unknown> | null): ScratchpadStats {
  let evaluatedCount = 0;
  let rejectedCount = 0;
  let matchedCount = 0;
  const rejectionReasons: string[] = [];
  let activeMilestone = '';
  let completedMilestonesCount = 0;
  let totalMilestonesCount = 0;
  let isGoalVerified = false;

  if (scratchpad && typeof scratchpad === 'object') {
    const sp = scratchpad as Record<string, any>;
    if (Array.isArray(sp.evaluatedCandidates)) {
      evaluatedCount = sp.evaluatedCandidates.length;
      for (const cand of sp.evaluatedCandidates) {
        if (cand.verdict === 'rejected') {
          rejectedCount++;
          if (cand.rejectionReason) {
            rejectionReasons.push(cand.rejectionReason);
          }
        } else if (cand.verdict === 'candidate_matched') {
          matchedCount++;
        }
      }
    }
    if (Array.isArray(sp.extractedItems)) {
      evaluatedCount = Math.max(evaluatedCount, sp.extractedItems.length);
      matchedCount = Math.max(matchedCount, sp.extractedItems.length);
    }
    if (Array.isArray(sp.milestones)) {
      totalMilestonesCount = sp.milestones.length;
      completedMilestonesCount = sp.milestones.filter((m: any) => m.status === 'completed').length;
      const active = sp.milestones.find((m: any) => m.status === 'in_progress');
      if (active && active.name) {
        activeMilestone = active.name;
      }
    }
    if (sp.verificationGate?.satisfied || sp.workflowGate?.actionConfirmed) {
      isGoalVerified = true;
      matchedCount = Math.max(matchedCount, 1);
    }
  }

  return {
    evaluatedCount,
    rejectedCount,
    matchedCount,
    rejectionReasons,
    activeMilestone,
    completedMilestonesCount,
    totalMilestonesCount,
    isGoalVerified,
  };
}

/**
 * The central multimodal agentic loop.
 * Runs up to MAX_STEPS, scanning the DOM and screen, querying the AI,
 * executing actions, and pausing between steps.
 */
async function runAgentLoop(task: string, tabId: number): Promise<void> {
  console.log('🚀 runAgentLoop started');
  // --- Session logging (client-side, local only) ---
  const sessionId = generateSessionId();
  let timestamp = Date.now();
  const subTasks: string[] = [];
  let collectedActions: Array<{ type: string; selector?: string; id?: string; value?: string }> = [];

  // Log the session once the loop terminates (success, done, or abort).
  const finalizeSession = async (
    maskedDomText: string,
    maskedImageBase64: string
  ): Promise<void> => {
    const session: AgentSession = {
      sessionId,
      timestamp,
      userPrompt: task,
      subTasks,
      maskedDomText,
      maskedImageBase64,
      returnedActions: collectedActions,
    };
    await SessionLogger.logSession(session);
  };

  // Destination-First Tab Setup & Pre-Flight Navigation:
  // Check if the user's task specifies a target domain/URL (e.g. LinkedIn, Amazon, Twitter, etc.).
  let preResolvedDestinationUrl: string | null = null;
  if (typeof browser?.tabs?.get === 'function') {
    try {
      const tab = await browser.tabs.get(tabId);
      preResolvedDestinationUrl = resolveTargetUrlFromTask(task, tab?.url);
      const isRestricted = isRestrictedUrl(tab?.url);
      const isDashboardTab = tab?.url?.includes('dashboard.html');

      if (preResolvedDestinationUrl) {
        // Direct destination navigation: NEVER load or touch google.com!
        safeSendMessage({
          type: 'LOG_UPDATE',
          payload: `🌐 Destination detected: Navigating directly to ${preResolvedDestinationUrl}...`,
        });

        if (isDashboardTab && typeof browser?.tabs?.create === 'function') {
          const freshTab = await browser.tabs.create({ url: preResolvedDestinationUrl, active: true });
          if (freshTab && freshTab.id) {
            tabId = freshTab.id;
          }
        } else if (typeof browser?.tabs?.update === 'function') {
          await browser.tabs.update(tabId, { url: preResolvedDestinationUrl });
        }

        collectedActions.push({ type: 'navigate', value: preResolvedDestinationUrl });
        await waitForTabReady(tabId, 10000);
        await sleep(1500);
      } else if (isRestricted) {
        // Only if starting on an unnavigable internal/new tab with NO explicit destination,
        // provide a standard search gateway.
        safeSendMessage({
          type: 'LOG_UPDATE',
          payload: '🚀 Homepage/New Tab detected. Auto-launching search gateway to start mission...',
        });

        if (isDashboardTab && typeof browser?.tabs?.create === 'function') {
          const freshTab = await browser.tabs.create({ url: 'https://www.google.com', active: true });
          if (freshTab && freshTab.id) {
            tabId = freshTab.id;
          }
        } else if (typeof browser?.tabs?.update === 'function') {
          await browser.tabs.update(tabId, { url: 'https://www.google.com' });
        }

        await waitForTabReady(tabId, 10000);
      }
    } catch (err) {
      console.warn('[background] Tab setup / destination check error:', err);
    }
  }

  // Ensure the content script is injected before starting the loop.
  safeSendMessage({ type: 'LOG_UPDATE', payload: 'Checking content script injection...' });
  const scriptReady = await ensureContentScriptInjected(tabId);
  if (!scriptReady) {
    safeSendMessage({ type: 'LOG_UPDATE', payload: 'Failed to inject content script. Make sure the tab is a normal web page (not chrome:// or a store page).' });
    setLoopStatus('Idle');
    return;
  }
  safeSendMessage({ type: 'LOG_UPDATE', payload: 'Content script ready.' });

  // Track failed selectors with retry counts (resets on DOM change)
  const initialTaskMode = detectTaskMode(task);
  let activeTaskMode: 'shopping' | 'workflow' | 'info' = initialTaskMode;
  const failedSelectorCounts = new Map<string, number>();
  let consecutiveFailures = 0;
  const MAX_CONSECUTIVE_FAILURES = 3;
  let previousDomHash = '';
  let currentScratchpad: Record<string, unknown> | null = null;
  let lastMaskedText = '';
  let lastRedactedImage = '';
  let searchQueryCount = 0;
  let scrollCount = 0;
  let candidateInspectionCount = 0;
  let previousAction: { type: string; id?: string; selector?: string; value?: string } | null = null;
  const actionHistory: Array<{ action: string; target?: string; value?: string }> = [];
  let lastTypedText = '';
  let lastSubmittedContent = '';
  let lastSubmittedStep = -1;
  const workflowState = {
    contentTyped: false,
    typedContentSnippet: '',
    submissionInitiated: false,
    submissionStep: -1,
    submissionButtonLabel: '',
  };
  let lastThought = '';
  let completedSuccessfully = false;
  let isTaskFinished = false;
  let finalStep = 1;
  stopRequested = false;

  // Cycle 3.3: claim the single run slot. The caller already refused a
  // concurrent start, so this is expected to succeed; if it somehow does not,
  // the loop still runs, and the guard below keeps it honest.
  const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const claimed = runController.start({ runId, tabId, startedAt: Date.now() });
  if (!claimed.accepted) {
    safeSendMessage({
      type: 'LOG_UPDATE',
      payload: `Refusing to start: run ${claimed.activeRunId ?? 'unknown'} is already active.`,
    });
    return;
  }

  safeSendMessage({ type: 'AGENT_STATUS', payload: { isRunning: true } });
  try {
    await browser.tabs.sendMessage(tabId, { type: 'SHOW_SHIELD', payload: { active: true } });
  } catch {
    // ignore
  }

  if (preResolvedDestinationUrl) {
    safeSendMessage({
      type: 'AGENT_ACTIVITY',
      payload: {
        step: 1,
        maxSteps: MAX_STEPS,
        phase: 'Executing',
        thought: `Navigated directly to destination from task: ${preResolvedDestinationUrl}`,
        action: 'navigate',
        targetLabel: preResolvedDestinationUrl,
        value: preResolvedDestinationUrl,
        statusText: `Navigated directly to ${preResolvedDestinationUrl}`,
        taskMode: activeTaskMode,
        actionCount: 1,
        ...extractScratchpadStats(currentScratchpad),
      },
    });
  }

  try {
    for (let step = 1; step <= MAX_STEPS; step++) {
      finalStep = step;
      // Cycle 3.3: the controller is authoritative. The loop-local flag is kept
      // as an OR so a stop that arrived before registration is not lost, but a
      // stop scoped to THIS run is what actually governs the loop.
      stopRequested = stopRequested || runController.isStopRequested(runId);
      if (stopRequested) {
        safeSendMessage({ type: 'LOG_UPDATE', payload: '🛑 Agent stopped by user.' });
        break;
      }

      // Check if target tab is still open
      try {
        const tabCheck = await browser.tabs.get(tabId);
        if (!tabCheck) {
          safeSendMessage({ type: 'LOG_UPDATE', payload: 'Target tab was closed. Aborting agent loop.' });
          break;
        }
      } catch {
        safeSendMessage({ type: 'LOG_UPDATE', payload: 'Target tab was closed. Aborting agent loop.' });
        break;
      }

      // Telemetry: mark loop as scanning at the top of every step.
      setLoopStatus('Scanning');
      const stepStartStats = extractScratchpadStats(currentScratchpad);
      safeSendMessage({
        type: 'AGENT_ACTIVITY',
        payload: {
          step,
          maxSteps: MAX_STEPS,
          phase: 'Scanning',
          thought: lastThought,
          statusText: `Step ${step}/${MAX_STEPS}: Scanning DOM structure & visual frame...`,
          taskMode: activeTaskMode,
          actionCount: collectedActions.length,
          ...stepStartStats,
        },
      });
      // Step A: Log scanning intent
      safeSendMessage({ type: 'LOG_UPDATE', payload: `Step ${step}: Scanning DOM & capturing screen...` });

      // Step B: GET_DOM — fetch masked DOM text (await maskedText)
      let maskedText = '';
      let domFetchSuccess = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const domResponse = await sendToTab(browser, tabId, 'GET_DOM');

          if (domResponse && domResponse.success && domResponse.data) {
            const domData = JSON.parse(domResponse.data);
            maskedText = domData.maskedText || '';
            lastMaskedText = maskedText;
            domFetchSuccess = true;
            break;
          }
        } catch {
          await ensureContentScriptInjected(tabId, 2);
          await sleep(500);
        }
      }

      if (!domFetchSuccess) {
        safeSendMessage({ type: 'LOG_UPDATE', payload: `Step ${step}: Reconnecting to page...` });
        await waitForTabReady(tabId);
        continue;
      }

      // Simplified stuck detection: purely track DOM changes without injecting artificial unrequested scrolls
      const currentDomHash = maskedText.length + '_' + (maskedText.match(/value="[^"]"/g) || []).length;
      if (currentDomHash === previousDomHash && currentDomHash !== '0_0') {
        consecutiveFailures++;
        if (consecutiveFailures >= 12) {
          safeSendMessage({ type: 'LOG_UPDATE', payload: `Agent paused: Page unchanged for 12 consecutive steps. Ending run.` });
          break;
        }
      } else {
        consecutiveFailures = 0;
        failedSelectorCounts.clear();
      }
      previousDomHash = currentDomHash;

      // -----------------------------------------------------------------------
      // PRE-FLIGHT UNIVERSAL WORKFLOW COMPLETION TERMINATOR
      // If content was already typed and submitted in a previous step, or if the page DOM
      // displays a platform submission confirmation toast (e.g. LinkedIn "Post successful" / "View post",
      // Twitter "Your post was sent", email "Message sent", or web form confirmation),
      // terminate IMMEDIATELY with action: 'done' WITHOUT capturing screenshots or querying the VLM!
      // -----------------------------------------------------------------------
      const maskedTextLower = maskedText.toLowerCase();
      const hasSubmissionConfirmationToast = [
        'post successful',
        'view post',
        'post published',
        'your post was shared',
        'your post was sent',
        'your tweet was sent',
        'message sent',
        'your message has been sent',
        'email sent successfully',
        'response has been recorded',
        'form submitted successfully',
        'thank you for your submission',
        'submission confirmed',
        'submission received',
      ].some((term) => maskedTextLower.includes(term));

      const hasClosedComposerOnFeed =
        (maskedTextLower.includes('start a post') || maskedTextLower.includes('compose') || maskedTextLower.includes('new tweet')) &&
        !maskedTextLower.includes('contenteditable="true"') &&
        !maskedTextLower.includes('share your thoughts');

      const hasSubstantialTypedContent = workflowState.contentTyped || lastTypedText.length > 15;
      const isPostSubmissionStep =
        hasSubstantialTypedContent &&
        (workflowState.submissionInitiated ||
          (lastSubmittedContent && lastSubmittedStep > 0) ||
          (step >= 4 && lastTypedText.length > 30));

      if (
        activeTaskMode === 'workflow' &&
        isPostSubmissionStep &&
        (hasSubmissionConfirmationToast || hasClosedComposerOnFeed || step > (workflowState.submissionStep > 0 ? workflowState.submissionStep : lastSubmittedStep))
      ) {
        const actionLabel = workflowState.submissionButtonLabel || 'Post';
        console.log(`✅ [Universal Workflow Pre-Flight Terminator] Submission confirmed on page (${actionLabel}). Concluding mission.`);
        safeSendMessage({
          type: 'LOG_UPDATE',
          payload: `✅ Universal Workflow Complete: ${actionLabel} submitted and confirmed on page. Mission accomplished!`,
        });

        const targetLabel = 'Workflow Executed & Verified';
        const statusText = 'Workflow action executed successfully!';
        const summaryText = `Workflow successfully executed: Content submitted via ${actionLabel} and confirmed on page.`;

        safeSendMessage({
          type: 'AGENT_ACTIVITY',
          payload: {
            step,
            maxSteps: MAX_STEPS,
            phase: 'Complete',
            thought: `Workflow submission verified on page (${actionLabel}). Concluding mission.`,
            action: 'done',
            targetLabel,
            statusText,
            summary: summaryText,
            taskMode: activeTaskMode,
            actionCount: collectedActions.length,
            ...extractScratchpadStats(currentScratchpad),
          },
        });
        completedSuccessfully = true;
        isTaskFinished = true;
        collectedActions.push({ type: 'done' });
        await finalizeSession(lastMaskedText, lastRedactedImage);
        setLoopStatus('Idle');
        safeSendMessage({ type: 'AGENT_STATUS', payload: { isRunning: false } });
        try {
          await browser.tabs.update(tabId, { active: true });
          await browser.tabs.sendMessage(tabId, { type: 'SHOW_SHIELD', payload: { active: false } });
        } catch {
          // ignore
        }
        break;
      }

      // Step C: GET_SCREENSHOT — capture + locally redact (await { image, rawImage, legend })
      // Telemetry: redaction happens locally via Canvas + MediaPipe + Tesseract.
      setLoopStatus('Redacting');
      safeSendMessage({
        type: 'AGENT_ACTIVITY',
        payload: {
          step,
          maxSteps: MAX_STEPS,
          phase: 'Redacting',
          thought: lastThought,
          statusText: `Step ${step}/${MAX_STEPS}: Shielding sensitive data locally in enclave...`,
          ...extractScratchpadStats(currentScratchpad),
        },
      });

      let archivalRawImage = '';
      let outboundImage = '';
      let redaction_legend: Array<{ id: string; type: string; bbox: number[] }> = [];
      let redactionState: 'verified' | 'degraded' | 'unavailable' = 'unavailable';
      let degradedReason: string | null = null;
      let directCaptureForArchive: string | null = null;

      try {
        const screenshotResponse = await Promise.race([
          browser.tabs.sendMessage<unknown, ScreenshotResponse>(tabId, {
            type: 'GET_SCREENSHOT',
          }),
          new Promise<null>((res) => setTimeout(() => res(null), 12000)),
        ]);

        if (screenshotResponse?.success) {
          directCaptureForArchive = null;
          // Cycle 1.3: single tested decision point for frame selection.
          // `image` is outbound-only and is populated solely from the content
          // script; a raw direct capture can never land there.
          const resolution = resolveCaptureSource({
            contentScript: {
              ok: true,
              image: screenshotResponse.image ?? '',
              rawImage: screenshotResponse.rawImage,
              legend: screenshotResponse.legend,
              redaction: screenshotResponse.redaction,
            },
            direct: { available: false, capture: null },
          });

          outboundImage = resolution.image ?? '';
          archivalRawImage = resolution.archivalImage ?? '';
          redaction_legend = resolution.legend;
          redactionState = resolution.redactionState;
          degradedReason = resolution.degradedReason;
          lastRedactedImage = outboundImage;
        }
      } catch (error) {
        console.warn('Content script GET_SCREENSHOT error:', error);
      }

      // ARCHIVAL-ONLY FALLBACK (Cycle 1.3): if the content script produced no
      // raw frame, capture directly via the service worker so raw-images/ is
      // never missed. This capture is UN-REDACTED and is therefore archived
      // locally only — it must never become the outbound image. Previously
      // this was enforced by the `if (!redactedImage)` guard further down;
      // that separation is now explicit and unit-tested.
      if (!archivalRawImage && typeof browser?.tabs?.captureVisibleTab === 'function') {
        try {
          const directCapture = await browser.tabs.captureVisibleTab(undefined, {
            format: 'jpeg',
            quality: 70,
          });
          if (directCapture) {
            archivalRawImage = directCapture.replace(/^data:image\/\w+;base64,/, '');
            directCaptureForArchive = archivalRawImage;
            console.log(`📸 [Archive Fallback] Direct capture archived (not sent) for Step ${step}`);
          }
        } catch (captureErr) {
          console.warn(`[Archive Fallback] Direct captureVisibleTab failed:`, captureErr);
        }
      }

      // Zero-Trust: with no verified frame, the step proceeds DOM-only. The
      // degraded state is recorded so the dashboard and operator can see that
      // the run lost its visual channel.
      if (!outboundImage) {
        safeSendMessage({
          type: 'LOG_UPDATE',
          payload: `Step ${step}: Visual frame unavailable or timed out. Proceeding with DOM-first perception.`,
        });
        if (redactionState !== 'unavailable') {
          redactionState = 'degraded';
        }
        degradedReason =
          degradedReason ??
          'No outbound frame: content script produced no redacted image.';
        lastRedactedImage = '';
      }

      // VLM Visual Frame: the exact image payload transmitted to the VLM.
      const vlmImage = outboundImage || '';

      // Step D: Local UI Vision via ONNX — runLocalUIVision(image)
      let uiElements: Array<{ type: string; bbox: number[] }> = [];
      try {
        const uiStart = Date.now();
        uiElements = await runLocalUIVision(outboundImage);
        lastInferenceMs = Date.now() - uiStart;
        if (uiElements.length > 0) {
          safeSendMessage({ type: 'LOG_UPDATE', payload: `Local CV processed. Detected ${uiElements.length} UI element(s).` });
        }
      } catch (error) {
        // UI vision skipped if model not initialized
      }

      // Step E: Log VLM query intent
      // Telemetry: cloud-reasoning phase.
      setLoopStatus('Thinking');
      safeSendMessage({
        type: 'AGENT_ACTIVITY',
        payload: {
          step,
          maxSteps: MAX_STEPS,
          phase: 'Thinking',
          thought: lastThought,
          statusText: `Step ${step}/${MAX_STEPS}: Zero-trust reasoning & decision in progress...`,
          ...extractScratchpadStats(currentScratchpad),
        },
      });
      safeSendMessage({ type: 'LOG_UPDATE', payload: `Step ${step}: PII redacted locally. Querying hybrid VLM...` });

      // Step F: Fetch the AI decision from the server. `outboundImage` is the
      // redacted frame; `archivalRawImage` is local-only and is stored, not sent
      // to the model as a trusted image.
      let aiDecision;
      try {
        const roundTripStart = Date.now();
        aiDecision = await callServer(
          task,
          maskedText,
          outboundImage,
          redaction_legend,
          currentScratchpad,
          sessionId,
          step,
          archivalRawImage,
          subTasks,
          actionHistory.slice(-8),
          vlmImage,
          redactionState === 'verified'
            ? {
                state: 'verified',
                engine: 'mediapipe',
                degradedAt: null,
                reason: 'Redaction verified locally before release.',
                violations: [],
              }
            : {
                state: redactionState === 'degraded' ? 'degraded' : 'unavailable',
                engine: 'mediapipe',
                // The server ranks states by arrival order and never trusts a
                // client timestamp, so this is left null rather than invented.
                degradedAt: null,
                reason: degradedReason ?? 'No outbound frame this step.',
                violations: [],
              }
        );
        // Telemetry: record latency, request count, and outbound payload size.
        telemetryData.lastLatency = Date.now() - roundTripStart;
        telemetryData.apiCalls += 1;
        trackPayloadSent(maskedText, outboundImage);
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : 'Unknown error';
        safeSendMessage({ type: 'LOG_UPDATE', payload: `Step ${step}: Server connection failed (${errMsg}). Aborting loop.` });
        break;
      }

      // Update scratchpad & thought from AI decision
      if (aiDecision) {
        // Canonical normalization of AI decision fields
        if (!aiDecision.selector && (aiDecision as any).target) {
          aiDecision.selector = String((aiDecision as any).target);
        }
        if (!aiDecision.id && typeof aiDecision.selector === 'string') {
          const idMatch = aiDecision.selector.match(/data-agent-id=['"]([^'"]+)['"]/);
          if (idMatch) {
            aiDecision.id = idMatch[1];
          } else if (aiDecision.selector.startsWith('agent-') || aiDecision.selector.startsWith('R')) {
            aiDecision.id = aiDecision.selector;
          }
        }
        if (!aiDecision.value) {
          if (typeof (aiDecision as any).text === 'string') aiDecision.value = (aiDecision as any).text;
          else if (typeof (aiDecision as any).url === 'string') aiDecision.value = (aiDecision as any).url;
          else if (typeof (aiDecision as any).query === 'string') aiDecision.value = (aiDecision as any).query;
        }
        if (aiDecision.action === 'navigate' && !aiDecision.value && (aiDecision as any).url) {
          aiDecision.value = (aiDecision as any).url;
        }

        // Universal URL typing auto-converter:
        // If the model generates action: 'type' where the value is a full URL or domain URL,
        // it intended to navigate to that destination rather than type text into an input.
        if (aiDecision.action === 'type' && typeof aiDecision.value === 'string') {
          const trimmedVal = aiDecision.value.trim().replace(/[\r\n]+$/, '');
          const isUrlLike =
            /^https?:\/\/[^\s]+$/i.test(trimmedVal) ||
            /^(?:www\.)[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s]*)?$/i.test(trimmedVal);
          if (isUrlLike) {
            console.log(`🌐 [Auto-Navigate] Converting action: 'type' with URL "${trimmedVal}" into action: 'navigate'`);
            safeSendMessage({
              type: 'LOG_UPDATE',
              payload: `🌐 Auto-Navigating directly to ${trimmedVal} instead of typing URL into input.`,
            });
            aiDecision.action = 'navigate';
            aiDecision.value = trimmedVal.startsWith('http') ? trimmedVal : `https://${trimmedVal}`;
            delete aiDecision.id;
            delete aiDecision.selector;
          }
        }

        if (aiDecision.thought) {
          lastThought = aiDecision.thought;
        }
        if (aiDecision.taskMode && typeof aiDecision.taskMode === 'string') {
          activeTaskMode = aiDecision.taskMode as 'shopping' | 'workflow' | 'info';
        }
        if (aiDecision.updatedScratchpad) {
          currentScratchpad = aiDecision.updatedScratchpad;
          safeSendMessage({ type: 'SCRATCHPAD_UPDATE', payload: currentScratchpad });
        }
      }

      const updatedStats = extractScratchpadStats(currentScratchpad);

      // -----------------------------------------------------------------------
      // UNIVERSAL WORKFLOW POST-SUBMISSION & COMPLETION GUARD
      // If the agent previously submitted content (via clicking Post/Send/Submit or Enter),
      // and now the model attempts to re-open the composer (e.g. clicking "Start a post"),
      // re-type content, repeatedly click submit, or take further redundant actions:
      // Conclude the mission with action: 'done'!
      // -----------------------------------------------------------------------
      if (activeTaskMode === 'workflow' && (workflowState.submissionInitiated || (lastSubmittedContent && lastSubmittedStep > 0))) {
        const subStep = workflowState.submissionStep > 0 ? workflowState.submissionStep : lastSubmittedStep;
        const resolvedTargetText = getHumanReadableTarget(aiDecision.id || aiDecision.selector, maskedText, aiDecision.action, aiDecision.value);
        const targetDesc = `${aiDecision.selector || ''} ${aiDecision.id || ''} ${resolvedTargetText} ${aiDecision.thought || ''} ${typeof aiDecision.value === 'string' ? aiDecision.value : ''}`.toLowerCase();

        // 1. Detect attempts to re-open the composer / post creator on feed / homepage
        const isReOpenComposeClick = [
          'start a post',
          'create a post',
          'write a post',
          'compose',
          'new post',
          'new tweet',
          'new message',
          'start writing',
          'share-box',
          'feed-shared-creator',
          'share-box-feed-entry',
        ].some((term) => targetDesc.includes(term));

        // 2. Detect attempts to re-type content or form fields
        const isReTypeAttempt = aiDecision.action === 'type';

        // 3. Detect repeated duplicate submit button clicks
        const isDuplicateSubmitClick =
          aiDecision.action === 'click' &&
          ['post', 'send', 'submit', 'publish', 'tweet', 'share-actions'].some((term) => targetDesc.includes(term));

        // Check if there is an explicit subsequent multi-task milestone pending (e.g. "now open sheet...")
        const hasUncompletedSubsequentMilestone =
          updatedStats.totalMilestonesCount > 1 &&
          updatedStats.completedMilestonesCount < updatedStats.totalMilestonesCount &&
          updatedStats.activeMilestone &&
          !updatedStats.activeMilestone.toLowerCase().includes('post') &&
          !updatedStats.activeMilestone.toLowerCase().includes('send') &&
          !updatedStats.activeMilestone.toLowerCase().includes('submit') &&
          !updatedStats.activeMilestone.toLowerCase().includes('compose') &&
          !updatedStats.activeMilestone.toLowerCase().includes('verify');

        if (
          !hasUncompletedSubsequentMilestone &&
          (isReOpenComposeClick || isReTypeAttempt || isDuplicateSubmitClick || step > subStep)
        ) {
          const actionLabel = workflowState.submissionButtonLabel || 'Post';
          console.log(`✅ [Universal Workflow Guard] Workflow submission verified (${actionLabel}). Overriding to action: "done".`);
          safeSendMessage({
            type: 'LOG_UPDATE',
            payload: `✅ Workflow Complete: ${actionLabel} submitted and verified successfully. Concluding mission.`,
          });
          aiDecision.action = 'done';
          aiDecision.summary = `Workflow successfully executed: Content submitted via ${actionLabel} and confirmed on page.`;
          delete aiDecision.id;
          delete aiDecision.selector;
          delete aiDecision.value;
        }
      }

      // Track search query occurrences (shopping catalog queries)
      const isTypingSearch =
        activeTaskMode === 'shopping' &&
        aiDecision.action === 'type' &&
        typeof aiDecision.value === 'string' &&
        (aiDecision.value.includes('\n') || searchQueryCount >= 1);
      if (isTypingSearch) {
        searchQueryCount++;
      }

      // -----------------------------------------------------------------------
      // ANTI-LOOP GUARD 1: Product Page Re-Search Trap Interceptor (SHOPPING ONLY)
      // If previous action was clicking a candidate product, and the candidate was
      // rejected in the scratchpad, intercept attempts to re-type search queries
      // into a header search bar and override to 'back' to return to catalog.
      // -----------------------------------------------------------------------
      const isCandidateInspectionPhase =
        activeTaskMode === 'shopping' &&
        updatedStats.rejectedCount > 0 &&
        (!updatedStats.activeMilestone ||
          (!updatedStats.activeMilestone.toLowerCase().includes('navigate') &&
           !updatedStats.activeMilestone.toLowerCase().includes('query') &&
           !updatedStats.activeMilestone.toLowerCase().includes('search/filter')));

      let isGlobalSearchInput = false;
      if (isCandidateInspectionPhase && aiDecision.action === 'type') {
        const targetId = aiDecision.id || (aiDecision.selector && aiDecision.selector.match(/data-agent-id=['"]([^'"]+)['"]/)?.[1]);
        if (targetId) {
          const escapedId = targetId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const elementMatch = maskedText.match(new RegExp(`\\[${escapedId}\\]([^\n\r]+)`, 'i'));
          if (elementMatch) {
            const line = elementMatch[1].toLowerCase();
            const isModalOrEditor =
              line.includes('role="dialog"') ||
              line.includes('role="textbox"') ||
              line.includes('contenteditable') ||
              line.includes('ql-editor') ||
              line.includes('prosemirror') ||
              line.includes('drafteditor');
            const isSearchField =
              line.includes('type="search"') ||
              line.includes('role="search"') ||
              line.includes('name="q"') ||
              line.includes('name="field-keywords"') ||
              line.includes('twotabsearchtextbox') ||
              line.includes('search-input') ||
              line.includes('placeholder="search');

            isGlobalSearchInput = isSearchField && !isModalOrEditor;
          }
        }
      }

      const isProductPageReSearchTrap =
        activeTaskMode === 'shopping' &&
        isCandidateInspectionPhase &&
        isGlobalSearchInput &&
        previousAction?.type === 'click' &&
        aiDecision.action === 'type' &&
        typeof aiDecision.value === 'string' &&
        aiDecision.value.length > 2;

      if (isProductPageReSearchTrap) {
        console.log('🔄 [LoopGuard] Intercepted redundant search on product page. Overriding to "back" action to return to search catalog.');
        safeSendMessage({
          type: 'LOG_UPDATE',
          payload: '🔄 Anti-Loop Guard: Product rejected — backtracking to search catalog instead of re-searching.',
        });
        aiDecision.action = 'back';
        delete aiDecision.id;
        delete aiDecision.selector;
        delete aiDecision.value;
      }

      // -----------------------------------------------------------------------
      // ANTI-LOOP GUARD: Stutter Breaker (Action Repetition Breaker)
      // Detects when the agent gets trapped repeating the exact same action 3 times.
      // (Oscillation cycle breaker removed per user request)
      // -----------------------------------------------------------------------
      const currentTargetKey = aiDecision.id || aiDecision.selector || '';
      const currentActionSig = {
        action: aiDecision.action,
        target: currentTargetKey,
        value: typeof aiDecision.value === 'string' ? aiDecision.value.slice(0, 30) : '',
      };

      if (actionHistory.length >= 2) {
        const last1 = actionHistory[actionHistory.length - 1];
        const last2 = actionHistory[actionHistory.length - 2];
        const isStutter =
          last1.action === currentActionSig.action &&
          last1.target === currentActionSig.target &&
          last1.value === currentActionSig.value &&
          last2.action === currentActionSig.action &&
          last2.target === currentActionSig.target &&
          last2.value === currentActionSig.value;

        if (isStutter) {
          safeSendMessage({
            type: 'LOG_UPDATE',
            payload: `⚠ Anti-Loop Guard: Stutter detected on ${currentActionSig.action} (${currentActionSig.target || currentActionSig.value}). Breaking repetition...`,
          });
          if (activeTaskMode === 'workflow') {
            safeSendMessage({
              type: 'LOG_UPDATE',
              payload: `✅ Workflow Stutter Breaker: Concluding repeated action on "${currentActionSig.action}". Mission complete.`,
            });
            aiDecision.action = 'done';
            aiDecision.summary = `Workflow action concluded after repeated execution on ${currentActionSig.target || 'target'}.`;
            delete aiDecision.id;
            delete aiDecision.selector;
            delete aiDecision.value;
          } else if (aiDecision.action === 'type') {
            try {
              const progResp = await browser.tabs.sendMessage<unknown, ProgressionButtonResponse>(tabId, { type: 'GET_PROGRESSION_BUTTON' });
              if (progResp && progResp.success && progResp.found && (progResp.id || progResp.selector)) {
                safeSendMessage({
                  type: 'LOG_UPDATE',
                  payload: `🎯 Progression Breaker: Found action button "${progResp.label || 'Submit'}". Progressing forward...`,
                });
                aiDecision.action = 'click';
                if (progResp.id) aiDecision.id = progResp.id;
                if (progResp.selector) aiDecision.selector = progResp.selector;
                delete aiDecision.value;
              } else {
                aiDecision.action = 'scroll';
                aiDecision.value = 'down';
                delete aiDecision.id;
                delete aiDecision.selector;
              }
            } catch {
              aiDecision.action = 'scroll';
              aiDecision.value = 'down';
              delete aiDecision.id;
              delete aiDecision.selector;
            }
          } else if (aiDecision.action === 'click') {
            aiDecision.action = 'scroll';
            aiDecision.value = 'down';
            delete aiDecision.id;
            delete aiDecision.selector;
          }
        }
      }

      // -----------------------------------------------------------------------
      // ANTI-LOOP GUARD 2: Deep Exploration vs. Saturation Balance (SHOPPING ONLY)
      // Top search results on Amazon/Flipkart are almost always sponsored ads.
      // Under step 10, NEVER declare saturation or premature completion — force scrolling organic listings.
      // -----------------------------------------------------------------------
      if (activeTaskMode === 'shopping') {
        if (step < 10 && updatedStats.matchedCount === 0) {
          if (currentScratchpad && typeof currentScratchpad === 'object') {
            (currentScratchpad as Record<string, unknown>).explorationDirective =
              'CONTINUE EXPLORING: The top items on screen are sponsored ads or out of budget. Do NOT stop or declare saturation. Scroll down to inspect organic results or click sidebar filters (Price / Rating) to locate qualifying items.';
          }
          if (aiDecision.action === 'done') {
            safeSendMessage({
              type: 'LOG_UPDATE',
              payload: `🛍 Catalog Guard: Premature exit intercepted (step ${step}/10, 0 matches). Scrolling down to inspect organic listings...`,
            });
            aiDecision.action = 'scroll';
            aiDecision.value = 'down';
            (aiDecision as any).amount = 800;
            delete aiDecision.id;
            delete aiDecision.selector;
          }
        } else if (step >= 16 && (candidateInspectionCount >= 2 || scrollCount >= 4)) {
          if (currentScratchpad && typeof currentScratchpad === 'object') {
            (currentScratchpad as Record<string, unknown>).saturationDirective =
              `CANDIDATE SATURATION (${updatedStats.evaluatedCount} evaluated): After thorough exploration across multiple scrolls/inspections, conclude with action 'done' and present your comparative summary of best alternatives.`;
          }
        }
      }

      // -----------------------------------------------------------------------
      // ANTI-LOOP GUARD 3: Saturation Forced Completion (ONLY AFTER DEEP SEARCH)
      // Only force completes if the model has actually searched & scrolled past step 22 in shopping
      // -----------------------------------------------------------------------
      if (
        activeTaskMode === 'shopping' &&
        step >= 22 &&
        updatedStats.evaluatedCount >= 3 &&
        aiDecision.action !== 'done' &&
        (searchQueryCount >= 3 || scrollCount >= 5 || consecutiveFailures >= 2)
      ) {
        safeSendMessage({
          type: 'LOG_UPDATE',
          payload: '🎯 Exploration threshold reached. Synthesizing comparative summary of evaluated options...',
        });
        aiDecision.action = 'done';
        const cands = (currentScratchpad as any)?.evaluatedCandidates || [];
        aiDecision.summary =
          `Evaluated ${updatedStats.evaluatedCount} candidate options against constraints. Comparative Summary:\n` +
          cands
            .map(
              (c: any, i: number) =>
                `${i + 1}. ${c.title || 'Option'}: Price ${c.price || 'N/A'}, Rating ${c.rating || 'N/A'}${
                  c.rejectionReason ? ` (Note: ${c.rejectionReason})` : ' (Matched)'
                }`
            )
            .join('\n') +
          '\n\nRecommendation: Evaluated top alternatives within budget.';
      }

      // Step G: If action === 'done', complete the task
      if (aiDecision.action === 'done') {
        completedSuccessfully = true;
        finalStep = step;
        let matchDetails = '';
        let hasRealMatch = false;

        if (activeTaskMode === 'shopping') {
          if (currentScratchpad && typeof currentScratchpad === 'object') {
            const sp = currentScratchpad as Record<string, any>;
            const vg = sp.verificationGate || sp.matchedProduct || sp.selectedItem || sp.finalChoice;
            if (vg && typeof vg === 'object') {
              const rawTitle = vg.matchedTitle || vg.title || vg.name || '';
              const price = vg.matchedPrice || vg.price || '';
              const rating = vg.matchedRating || vg.rating || '';
              const isInvalidTitle =
                !rawTitle ||
                rawTitle === 'None' ||
                rawTitle.toLowerCase().includes('none') ||
                rawTitle.toLowerCase().includes('n/a');
              if (!isInvalidTitle && vg.satisfied !== false) {
                hasRealMatch = true;
                const details = [rawTitle, price, rating].filter(Boolean);
                matchDetails = ` Matched: ${details.join(' | ')}`;
              } else if (!isInvalidTitle) {
                const details = [rawTitle, price, rating].filter(Boolean);
                matchDetails = ` Best Alternative: ${details.join(' | ')}`;
              }
            }
          }
        } else if (activeTaskMode === 'workflow') {
          const sp = currentScratchpad as Record<string, any> | null;
          hasRealMatch = Boolean(sp?.workflowGate?.actionConfirmed || updatedStats.isGoalVerified);
        } else {
          // info
          const sp = currentScratchpad as Record<string, any> | null;
          hasRealMatch = Boolean(sp?.verificationGate?.satisfied || (sp?.extractedItems && sp.extractedItems.length > 0));
        }

        const summaryText =
          typeof aiDecision.summary === 'string' && aiDecision.summary.trim()
            ? aiDecision.summary.trim()
            : typeof aiDecision.value === 'string' && aiDecision.value.trim()
            ? aiDecision.value.trim()
            : matchDetails || (activeTaskMode === 'workflow' ? 'Workflow action completed successfully.' : 'Mission completed successfully.');

        if (activeTaskMode === 'workflow') {
          safeSendMessage({ type: 'LOG_UPDATE', payload: `✅ Workflow Complete! ${summaryText.slice(0, 140)}` });
        } else if (activeTaskMode === 'info') {
          safeSendMessage({ type: 'LOG_UPDATE', payload: `📊 Research Complete! ${summaryText.slice(0, 140)}` });
        } else {
          if (hasRealMatch) {
            safeSendMessage({ type: 'LOG_UPDATE', payload: `✅ Task Complete!${matchDetails}` });
          } else if (matchDetails) {
            safeSendMessage({ type: 'LOG_UPDATE', payload: `🎯 Exploration Concluded:${matchDetails}` });
          } else {
            safeSendMessage({ type: 'LOG_UPDATE', payload: `🎯 Exploration Concluded: Evaluated available options.` });
          }
        }

        const targetLabel =
          activeTaskMode === 'workflow'
            ? 'Workflow Executed & Verified'
            : activeTaskMode === 'info'
            ? 'Information Synthesized'
            : hasRealMatch
            ? 'Mission Goal Certified'
            : 'Catalog Options Evaluated';

        const statusText =
          activeTaskMode === 'workflow'
            ? 'Workflow action executed successfully!'
            : activeTaskMode === 'info'
            ? 'Research and extraction completed.'
            : hasRealMatch
            ? 'Task completed successfully!'
            : 'Exploration completed. See evaluated options.';

        safeSendMessage({
          type: 'AGENT_ACTIVITY',
          payload: {
            step,
            maxSteps: MAX_STEPS,
            phase: 'Complete',
            thought: aiDecision.thought || lastThought,
            action: 'done',
            targetLabel,
            statusText,
            summary: summaryText,
            taskMode: activeTaskMode,
            actionCount: collectedActions.length,
            ...updatedStats,
          },
        });
        completedSuccessfully = true;
        isTaskFinished = true;
        collectedActions.push({ type: 'done' });
        await finalizeSession(lastMaskedText, lastRedactedImage);
        setLoopStatus('Idle');
        safeSendMessage({ type: 'AGENT_STATUS', payload: { isRunning: false } });
        try {
          await browser.tabs.update(tabId, { active: true });
          await browser.tabs.sendMessage(tabId, { type: 'SHOW_SHIELD', payload: { active: false } });
        } catch {
          // ignore
        }
        break;
      }

      // Skip only if selector repeatedly failed without DOM changes
      const rawTarget = aiDecision.selector || aiDecision.id || (typeof aiDecision.value === 'string' ? aiDecision.value.slice(0, 30) : 'action');
      const selectorKey = `${aiDecision.action}:${rawTarget}`;
      const failCount = failedSelectorCounts.get(selectorKey) || 0;
      if (failCount >= 2) {
        safeSendMessage({ type: 'LOG_UPDATE', payload: `⚠ Target "${selectorKey}" failed ${failCount} times consecutively. Skipping to allow alternative strategy.` });
        continue;
      }

      // Step G.2: Direct Navigation Handler via Native WebExtensions API
      if (aiDecision.action === 'navigate') {
        if (isTaskFinished) {
          console.log('[background] Task already completed; rejecting post-completion navigation.');
          break;
        }
        let targetUrl = (typeof aiDecision.value === 'string' ? aiDecision.value.trim() : '') || (aiDecision as any).url || '';
        // Guard against navigating back to google.com if we are already in an active workflow or past submission
        if (targetUrl.includes('google.com') && (activeTaskMode === 'workflow' || lastSubmittedStep > 0 || workflowState.submissionInitiated)) {
          console.log('[background] Guard: Rejecting navigation to google.com during workflow execution/completion.');
          continue;
        }
        if (targetUrl) {
          if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
            targetUrl = 'https://' + targetUrl;
          }
          setLoopStatus('Executing');
          collectedActions.push({ type: 'navigate', value: targetUrl });
          subTasks.push(`navigate: ${targetUrl}`);
          safeSendMessage({ type: 'LOG_UPDATE', payload: `Step ${step}: Navigating to ${targetUrl}...` });
          safeSendMessage({
            type: 'AGENT_ACTIVITY',
            payload: {
              step,
              maxSteps: MAX_STEPS,
              phase: 'Executing',
              thought: aiDecision.thought || `Navigating to ${targetUrl}`,
              action: 'navigate',
              targetLabel: targetUrl,
              value: targetUrl,
              statusText: `Step ${step}: Navigating to ${targetUrl}...`,
              taskMode: activeTaskMode,
              actionCount: collectedActions.length,
              ...updatedStats,
            },
          });
          consecutiveFailures = 0;
          previousDomHash = '';
          try {
            await browser.tabs.update(tabId, { url: targetUrl });
            await waitForTabReady(tabId);
            await sleep(2000);
            await ensureContentScriptInjected(tabId);
          } catch (navErr) {
            console.warn('[background] Direct navigation error:', navErr);
          }
          continue;
        }
      }

      // Cycle 3.1 — HONOUR THE SERVER'S POLICY VERDICT.
      //
      // A gate the client can ignore is theatre. The server evaluates the
      // model's decision and returns `policyBlocked` / `requiresConfirmation`;
      // the loop must act on both before anything reaches the content script.
      if (aiDecision.policyBlocked) {
        safeSendMessage({
          type: 'LOG_UPDATE',
          payload: `Step ${step}: Action blocked by server policy — ${aiDecision.policyReason ?? 'no reason given'}`,
        });
        safeSendMessage({ type: 'AGENT_ACTIVITY', payload: { step, phase: 'Blocked', statusText: 'Action blocked by policy' } });
        break;
      }

      if (aiDecision.requiresConfirmation && !isStepConfirmed(step, aiDecision)) {
        const label = describeAction(aiDecision);
        const accepted = await requestHumanConfirmation(label);
        if (!accepted) {
          safeSendMessage({
            type: 'LOG_UPDATE',
            payload: `Step ${step}: Declined — "${label}" needs confirmation and was not approved.`,
          });
          safeSendMessage({ type: 'AGENT_STATUS', payload: { isRunning: false } });
          break;
        }
        markStepConfirmed(step, aiDecision);
        safeSendMessage({ type: 'LOG_UPDATE', payload: `Step ${step}: Confirmed — ${label}` });
      }

      // Step H: If action is 'click', 'select', 'zoom', 'type', 'navigate', 'scroll', or 'back', send EXECUTE_ACTION to the content script
      if (
        aiDecision.action === 'click' ||
        aiDecision.action === 'select' ||
        aiDecision.action === 'zoom' ||
        aiDecision.action === 'type' ||
        aiDecision.action === 'navigate' ||
        aiDecision.action === 'scroll' ||
        aiDecision.action === 'back'
      ) {
        // Telemetry: local execution phase.
        setLoopStatus('Executing');
        collectedActions.push({
          type: aiDecision.action,
          selector: aiDecision.selector,
          id: aiDecision.id,
          value: aiDecision.value,
        });
        subTasks.push(aiDecision.id ?? aiDecision.selector ?? (typeof aiDecision.value === 'string' ? aiDecision.value : 'action'));
        const humanTarget = getHumanReadableTarget(aiDecision.id || aiDecision.selector, maskedText, aiDecision.action, aiDecision.value);
        const isBack = aiDecision.action === 'back';
        safeSendMessage({
          type: 'AGENT_ACTIVITY',
          payload: {
            step,
            maxSteps: MAX_STEPS,
            phase: isBack ? 'Backtracking' : 'Executing',
            thought: aiDecision.thought || lastThought,
            action: aiDecision.action,
            targetLabel: humanTarget,
            value: aiDecision.value,
            statusText: isBack
              ? (activeTaskMode === 'shopping' ? `Step ${step}: Backtracking to search catalog...` : `Step ${step}: Navigating back...`)
              : `Step ${step}: Executing ${aiDecision.action} on ${humanTarget}`,
            taskMode: activeTaskMode,
            actionCount: collectedActions.length + 1,
            ...updatedStats,
          },
        });
        safeSendMessage({ type: 'LOG_UPDATE', payload: `Step ${step}: Executing ${aiDecision.action} on ${humanTarget}` });
        previousAction = {
          type: aiDecision.action,
          id: aiDecision.id,
          selector: aiDecision.selector,
          value: aiDecision.value,
        };
        actionHistory.push({
          action: aiDecision.action,
          target: aiDecision.id || aiDecision.selector || '',
          value: typeof aiDecision.value === 'string' ? aiDecision.value.slice(0, 30) : '',
        });
        if (actionHistory.length > 20) actionHistory.shift();

        // Universal Submission Tracking: record typed content and submission events
        if (aiDecision.action === 'type' && typeof aiDecision.value === 'string') {
          lastTypedText = aiDecision.value.trim().replace(/[\r\n]+$/, '');
          if (lastTypedText.length > 15) {
            workflowState.contentTyped = true;
            workflowState.typedContentSnippet = lastTypedText.slice(0, 50);
          }
          // Multiline post composers (contenteditable, textbox, compose modals) should not treat Enter as post submission!
          const isPostComposerTarget = ['post', 'compose', 'tweet', 'contenteditable', 'textbox', 'share-box', 'feed-shared'].some((t) =>
            `${aiDecision.selector || ''} ${aiDecision.id || ''}`.toLowerCase().includes(t)
          );
          if (!isPostComposerTarget && (aiDecision.value.endsWith('\n') || aiDecision.value.endsWith('\r')) && lastTypedText.length > 15) {
            lastSubmittedContent = lastTypedText;
            lastSubmittedStep = step;
            workflowState.submissionInitiated = true;
            workflowState.submissionStep = step;
            workflowState.submissionButtonLabel = 'Enter';
          }
        } else if (aiDecision.action === 'click') {
          const clickTargetText = `${aiDecision.selector || ''} ${aiDecision.id || ''} ${aiDecision.thought || ''} ${humanTarget}`.toLowerCase();
          const isOpenerClick = [
            'start a post',
            'create a post',
            'write a post',
            'start writing',
            'new post',
            'compose',
            'new tweet',
            'new message',
            'start a discussion',
          ].some((phrase) => clickTargetText.includes(phrase));

          const isSubmitClick =
            !isOpenerClick &&
            ['send', 'post', 'submit', 'publish', 'reply', 'tweet', 'wds-ic-send', 'share-actions', 'send-filled'].some((term) =>
              clickTargetText.includes(term)
            );
          const hasTypedSubstantialContent = workflowState.contentTyped || lastTypedText.length > 15;
          if (isSubmitClick && hasTypedSubstantialContent) {
            lastSubmittedContent = lastTypedText || workflowState.typedContentSnippet;
            lastSubmittedStep = step;
            workflowState.submissionInitiated = true;
            workflowState.submissionStep = step;
            workflowState.submissionButtonLabel = humanTarget || 'Post';
          }
        }

        if (aiDecision.action === 'scroll') {
          scrollCount++;
        } else if (aiDecision.action === 'click') {
          const isCandidateClick =
            Boolean(updatedStats.activeMilestone &&
              (updatedStats.activeMilestone.toLowerCase().includes('inspect') ||
               updatedStats.activeMilestone.toLowerCase().includes('candidate') ||
               updatedStats.activeMilestone.toLowerCase().includes('spec'))) ||
            Boolean(aiDecision.thought && aiDecision.thought.toLowerCase().includes('candidate'));
          if (isCandidateClick) {
            candidateInspectionCount++;
          }
        }
        try {
          const actionResult = await browser.tabs.sendMessage<unknown, ActionResultResponse>(tabId, {
            type: 'EXECUTE_ACTION',
            payload: aiDecision,
          });
          // Capture content-script confirmed submission telemetry (strictly requires substantial typed content)
          const hasTypedSubstantialContent = workflowState.contentTyped || lastTypedText.length > 15;
          if (actionResult && actionResult.isSubmitAction && hasTypedSubstantialContent) {
            workflowState.submissionInitiated = true;
            workflowState.submissionStep = step;
            workflowState.submissionButtonLabel = actionResult.buttonLabel || workflowState.submissionButtonLabel || 'Post';
          }
          // Check if action actually succeeded
          if (actionResult && actionResult.success === false) {
            failedSelectorCounts.set(selectorKey, failCount + 1);
            safeSendMessage({ type: 'LOG_UPDATE', payload: `⚠ Action notice: ${actionResult.error || 'Failed'}.` });
            // Feed failure context into scratchpad for the next AI reasoning step
            if (currentScratchpad && typeof currentScratchpad === 'object') {
              (currentScratchpad as Record<string, unknown>).lastExecutionFailure = `Action '${aiDecision.action}' on '${selectorKey}' failed: ${actionResult.error}. Choose alternative element.`;
            }
          } else if (actionResult && actionResult.success === true) {
            failedSelectorCounts.delete(selectorKey);
            if (currentScratchpad && typeof currentScratchpad === 'object') {
              delete (currentScratchpad as Record<string, unknown>).lastExecutionFailure;
            }
          }
        } catch (error) {
          // If action triggers navigation (e.g. form submit on Enter or link click),
          // content script unloads and sendMessage rejects. This is expected!
          console.log('Action triggered navigation / page transition:', error);
        }
      }

      // Bug 7: Post-action dispatch settling delay (augmented for cascading dropdown / AJAX updates)
      const actionSettlingDelay =
        aiDecision.action === 'select' ||
        (typeof aiDecision.selector === 'string' && (aiDecision.selector.includes('select') || aiDecision.selector.includes('theme') || aiDecision.selector.includes('state')))
          ? 600
          : 350;
      await sleep(actionSettlingDelay);

      // Step I: Send WAIT_FOR_STABLE or wait for page navigation to complete
      try {
        await Promise.race([
          browser.tabs.sendMessage(tabId, { type: 'WAIT_FOR_STABLE' }),
          new Promise<null>((res) => setTimeout(() => res(null), 3500)),
        ]);
      } catch {
        // Expected if page navigated and old script unloaded
      }

      // If an action opened a child tab, track the new active tab ONLY if spawned by this tab
      try {
        const activeTabs = await browser.tabs.query({ active: true, currentWindow: true });
        if (
          activeTabs &&
          activeTabs[0]?.id &&
          activeTabs[0].id !== tabId &&
          (activeTabs[0] as any).openerTabId === tabId &&
          !isRestrictedUrl(activeTabs[0].url)
        ) {
          tabId = activeTabs[0].id;
          safeSendMessage({ type: 'LOG_UPDATE', payload: `Following child tab navigation (${tabId}).` });
        }
      } catch {
        // ignore
      }

      // If page navigated, wait for tab status 'complete' and ensure content script is re-injected
      await waitForTabReady(tabId);
      await sleep(STEP_DELAY_MS);
    }
    // Natural loop completion (exhausted MAX_STEPS) — log the session.
    await finalizeSession(lastMaskedText, lastRedactedImage);
    // Telemetry: loop is idle again.
    setLoopStatus('Idle');
    safeSendMessage({
      type: 'AGENT_ACTIVITY',
      payload: {
        step: MAX_STEPS,
        maxSteps: MAX_STEPS,
        phase: 'Complete',
        thought: lastThought,
        statusText: 'Agent execution finished.',
        ...extractScratchpadStats(currentScratchpad),
      },
    });
  } catch (error) {
    // Any unexpected error: report and abort the loop
    safeSendMessage({ type: 'LOG_UPDATE', payload: `Agent loop error: ${error instanceof Error ? error.message : 'Unknown error'}` });
    await finalizeSession(lastMaskedText, lastRedactedImage);
    setLoopStatus('Idle');
  } finally {
    // Cycle 3.3: release the single run slot. Without this the extension bricks
    // itself after a single run — every later START_AGENT is refused as
    // "already running" with no way out. Scoped by runId so a late finally from
    // an older run cannot clear a newer one's slot.
    runController.finish(runId);
    safeSendMessage({ type: 'AGENT_STATUS', payload: { isRunning: false } });
    if (!completedSuccessfully) {
      safeSendMessage({
        type: 'AGENT_ACTIVITY',
        payload: {
          step: finalStep,
          maxSteps: MAX_STEPS,
          phase: stopRequested ? 'Aborted' : 'Idle',
          thought: lastThought,
          statusText: stopRequested ? 'Agent stopped by user.' : 'Agent idle.',
          ...extractScratchpadStats(currentScratchpad),
        },
      });
    }
    try {
      await browser.tabs.update(tabId, { active: true });
      await browser.tabs.sendMessage(tabId, { type: 'SHOW_SHIELD', payload: { active: false } });
    } catch {
      // ignore
    }
  }
}
export default defineBackground(() => {
  // Run model availability check on startup so dashboard shows LIVE immediately
  void runModelAvailabilityCheck();

  // Configure Chrome side panel to open on toolbar icon click
  try {
    if ((chrome as any)?.sidePanel?.setPanelBehavior) {
      (chrome as any).sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((e: unknown) => {
        console.warn('[background] sidePanel.setPanelBehavior error:', e);
      });
    }
  } catch (e) {
    console.warn('[background] sidePanel not available:', e);
  }

  let lastTabCaptureTimestamp = 0;

  browser.runtime.onMessage.addListener((rawMessage, _sender, sendResponse) => {
    console.log('📡 Received runtime message:', rawMessage);
    const parsed = BackgroundMessageSchema.safeParse(rawMessage);
    if (!parsed.success) {
      return false;
    }
    const message = parsed.data;

    // The operator's answer to a confirmation prompt. This is the message that
    // was missing: without a handler here, a gated action could only ever time
    // out and decline, because nothing could reply.
    if (message.type === 'CONFIRM_RESPONSE') {
      const applied = answerConfirmation(message.payload.requestId, message.payload.confirmed);
      sendResponse({ success: applied });
      return false;
    }

    // PHASE 1 — Dashboard telemetry poll. Must stay synchronous (no async work)
    // so the dashboard's 1s setInterval never hangs.
    if (message.type === 'GET_TELEMETRY') {
      // Non-blocking: ensure model availability is checked so status is accurate.
      runModelAvailabilityCheck();
      sendResponse(telemetryData);
      return false;
    }

    // PHASE 5 — Local model runtime status poll.
    // Await the availability check BEFORE sending response so the dashboard
    // sees the correct 'live' status on first load.
    if (message.type === 'GET_MODEL_STATUS') {
      void (async () => {
        await runModelAvailabilityCheck();
        sendResponse(refreshModelStatus());
      })();
      return true; // async response
    }

    // Handle CAPTURE_TAB (screenshot request from content script) with rate-limiting & retry resilience
    if (message.type === 'CAPTURE_TAB') {
      const now = Date.now();
      const elapsed = now - lastTabCaptureTimestamp;
      const delay = elapsed < 500 ? 500 - elapsed : 0;

      setTimeout(async () => {
        try {
          lastTabCaptureTimestamp = Date.now();
          const dataUrl = await browser.tabs.captureVisibleTab(undefined, {
            format: 'jpeg',
            quality: 70,
          });
          sendResponse(dataUrl);
        } catch (_firstErr) {
          // Retry once after 600ms on rate-limit or transient window error
          setTimeout(async () => {
            try {
              lastTabCaptureTimestamp = Date.now();
              const retryUrl = await browser.tabs.captureVisibleTab(undefined, {
                format: 'jpeg',
                quality: 70,
              });
              sendResponse(retryUrl);
            } catch {
              sendResponse(null);
            }
          }, 600);
        }
      }, delay);

      // Return true to indicate async response
      return true;
    }

    // Handle STOP_AGENT
    if (message.type === 'STOP_AGENT') {
      // Cycle 3.3: scoped to the active run, and idempotent. The previous code
      // set a global that a subsequent START_AGENT would clear.
      stopRequested = runController.requestStop() !== null;
      setLoopStatus('Idle');
      browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
        if (tabs[0]?.id) {
          browser.tabs.sendMessage(tabs[0].id, { type: 'SHOW_SHIELD', payload: { active: false } }).catch(() => {});
        }
      }).catch(() => {});
      sendResponse({ success: true });
      return false;
    }

    // Handle START_AGENT messages
    if (message.type === 'START_AGENT') {
      const task = message.payload;
      const specifiedTabId = message.targetTabId;

      // Cycle 3.3: refuse a concurrent run rather than starting a second one.
      // Two runs would share the scratchpad, the telemetry counters and — worst
      // of all — the DOM, interleaving clicks and typing in the same page.
      if (runController.isActive()) {
        sendResponse({
          success: false,
          error: 'An agent run is already in progress. Stop it before starting another.',
          activeRunId: runController.activeRunId(),
        });
        return false;
      }

      // Telemetry: agent is leaving Idle as soon as a task is accepted.
      setLoopStatus('Scanning');

      // Send message to popup/sidepanel that the agent has started
      safeSendMessage({ type: 'LOG_UPDATE', payload: 'Agent started...' });

      // Immediately acknowledge message so the sender channel closes cleanly
      sendResponse({ success: true });

      // Run the continuous multimodal agentic loop in the background
      (async () => {
        try {
          let tabId = specifiedTabId;
          if (!tabId) {
            const tabs = await browser.tabs.query({ active: true, currentWindow: true });
            if (tabs && tabs[0]?.id) {
              tabId = tabs[0].id;
            }
          }

          if (!tabId) {
            safeSendMessage({ type: 'LOG_UPDATE', payload: 'No target tab found' });
            setLoopStatus('Idle');
            safeSendMessage({ type: 'AGENT_STATUS', payload: { isRunning: false } });
            return;
          }

          // Mitigate MV3 background timer throttling by ensuring target tab is active
          try {
            await browser.tabs.update(tabId, { active: true });
          } catch {
            // ignore
          }

          await runAgentLoop(task, tabId);
        } catch (error) {
          safeSendMessage({ type: 'LOG_UPDATE', payload: 'Agent loop failed to start' });
          setLoopStatus('Idle');
          safeSendMessage({ type: 'AGENT_STATUS', payload: { isRunning: false } });
        }
      })();

      return false;
    }

    return false;
  });

  // Ensure side panel opens when clicking extension action icon
  try {
    if ((chrome as any)?.sidePanel?.setPanelBehavior) {
      (chrome as any).sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
    }
  } catch {
    // ignore
  }
});

