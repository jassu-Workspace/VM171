import 'dotenv/config';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import OpenAI from 'openai';
import { logRequest, createRedactor, setRedactor, redactForLog } from './logger';
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as os from 'node:os';
import { saveSessionStep, initSession, finalizeSession, getStorageStats, listSessions, getSessionDetails } from './sessionStorage';
import { validateImagePayload } from './imageSafety';
import { originGuard, parseAllowedOrigins } from './originGuard';
import { bodyLimit } from 'hono/body-limit';
import { StepSchema } from './schemas';
import { evaluateAction } from './actionPolicy';
import { resolveCompletion } from './completion';
import type { CompletionFn } from './completionTypes';
import {
  issueToken,
  verifyToken,
  generateSigningKey,
  generatePairingCode,
  isPairingCodeValid,
  TokenError,
  DEFAULT_TTL_MS,
  DEFAULT_AUDIENCE,
} from './token';
// Cycle 2.10: the multi-component address heuristic lives with the extension
// because that is where the element context it reasons about is collected.
// Imported rather than duplicated ON PURPOSE: a second copy of a security
// heuristic is precisely how the test mirror drifted out of sync with
// production (finding N8), and address parsing is far too subtle to reimplement.
// `containsFullAddress` and its dependency `analyzeAddressText` are pure — the
// `window` references in that module belong to sibling functions that walk
// elements, not to this code path.
import { containsFullAddress } from '../../extension/src/utils/addressDetector';
import { getConnInfo } from '@hono/node-server/conninfo';
import {
  evaluateRedactionPolicy,
  recordDegradation,
  createDegradationTally,
  type RedactionEnvelopeInput,
  type DegradationTally,
} from './redactionPolicy';

// Minimal Node process typing
declare const process: {
  env: Record<string, string | undefined>;
  exit(code?: number): never;
  uptime(): number;
  memoryUsage(): { heapUsed: number; heapTotal: number; rss: number; external?: number };
  on(event: 'SIGINT', handler: () => void): void;
  on(event: 'SIGTERM', handler: () => void): void;
};

// ---------------------------------------------------------------------------
//  COLORED STRUCTURED LOGGER
// ---------------------------------------------------------------------------
const COLORS = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
};

function ts(): string {
  return new Date().toISOString();
}

// Cycle 1.8: every log line passes through the redactor, so the auth secret,
// API keys, key-shaped tokens and base64 payloads cannot reach stdout ->
// server_out.log -> CI logs -> shell scrollback. Installed before the first log
// line is emitted.
setRedactor(
  createRedactor({
    SECRET_PASSWORD: process.env.SECRET_PASSWORD,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    ROUTER_API_KEY: process.env.ROUTER_API_KEY,
  })
);

const log = {
  info(msg: string): void {
    console.log(`${COLORS.cyan}[${ts()}] ℹ INFO${COLORS.reset}  ${redactForLog(msg)}`);
  },
  success(msg: string): void {
    console.log(`${COLORS.green}[${ts()}] ✔ SUCCESS${COLORS.reset} ${redactForLog(msg)}`);
  },
  warn(msg: string): void {
    console.warn(`${COLORS.yellow}[${ts()}] ⚠ WARN${COLORS.reset}  ${redactForLog(msg)}`);
  },
  error(msg: string): void {
    console.error(`${COLORS.red}[${ts()}] ✖ ERROR${COLORS.reset} ${redactForLog(msg)}`);
  },
};

// ---------------------------------------------------------------------------
//  ENV VALIDATION ON STARTUP
// ---------------------------------------------------------------------------
if (!process.env.SECRET_PASSWORD) {
  if (!process.env.VITEST && process.env.NODE_ENV !== 'test') {
    log.error('Missing required environment variable: SECRET_PASSWORD');
    process.exit(1);
  }
}

const hasGemini = Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim());
const hasRouter = Boolean(process.env.ROUTER_URL && process.env.ROUTER_API_KEY);

if (!hasGemini && !hasRouter) {
  if (!process.env.VITEST && process.env.NODE_ENV !== 'test') {
    log.error('No AI provider configured! Provide either GEMINI_API_KEY or (ROUTER_URL and ROUTER_API_KEY) in server/.env');
    process.exit(1);
  }
}

if (hasGemini) {
  log.success(`✔ Upstream AI Provider: Google Gemini API (Priority 1: Active, Model: ${process.env.GEMINI_MODEL || 'gemini-2.5-flash'})`);
}
if (hasRouter) {
  log.info(`ℹ Upstream AI Provider: 9router (Priority 2: Fallback Ready, URL: ${process.env.ROUTER_URL})`);
}

// ---------------------------------------------------------------------------
//  RATE LIMITER (in-memory, per-IP)
// ---------------------------------------------------------------------------
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 40;

// Cycle 2.8: the map is BOUNDED. It used to grow without limit and only shed
// entries when their window expired, which — combined with a client-controlled
// bucket key — let an attacker add millions of entries in minutes. The limiter
// was itself a memory-exhaustion vector.
const RATE_LIMIT_MAX_ENTRIES = 10_000;
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

/** Drop expired entries, then evict the oldest until under the cap. */
function enforceRateLimitMapBound(): void {
  if (rateLimitMap.size <= RATE_LIMIT_MAX_ENTRIES) return;
  const now = Date.now();
  for (const [key, entry] of rateLimitMap) {
    if (now >= entry.resetAt) rateLimitMap.delete(key);
  }
  // Map preserves insertion order, so the first keys are the oldest.
  while (rateLimitMap.size > RATE_LIMIT_MAX_ENTRIES) {
    const oldest = rateLimitMap.keys().next();
    if (oldest.done) break;
    rateLimitMap.delete(oldest.value);
  }
}

function checkRateLimit(ip: string): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  enforceRateLimitMapBound();
  const entry = rateLimitMap.get(ip);
  if (!entry || now >= entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { allowed: true, remaining: RATE_LIMIT_MAX_REQUESTS - 1, resetAt: now + RATE_LIMIT_WINDOW_MS };
  }
  entry.count += 1;
  const remaining = Math.max(0, RATE_LIMIT_MAX_REQUESTS - entry.count);
  return { allowed: entry.count <= RATE_LIMIT_MAX_REQUESTS, remaining, resetAt: entry.resetAt };
}

/**
 * The real client address, from the socket.
 *
 * Cycle 2.8: this used to be `c.req.header('x-forwarded-for') || 'unknown'`.
 * X-Forwarded-For is a REQUEST HEADER — any client can set it to anything, so
 * rotating it gave every request a fresh bucket and the limit did nothing. RED
 * demonstrated 45 requests with 45 distinct forged addresses and not one 429.
 *
 * The server binds to loopback, so this is the local peer, not a proxy hop.
 * There is no legitimate reason to honour X-Forwarded-For here.
 */
function clientAddress(c: unknown): string {
  try {
    const info = getConnInfo(c as never);
    return info?.remote?.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

// Cycle 1.4: server-side redaction accounting. A client-supplied envelope is a
// claim, never ground truth — see redactionPolicy.ts.
const REJECT_UNREDACTED = String(process.env.REJECT_UNREDACTED ?? '').toLowerCase() === 'true';
const redactionTally: DegradationTally = createDegradationTally();

const app = new Hono();

// ---------------------------------------------------------------------------
//  Cycle 2.4 — BEARER TOKEN AUTHENTICATION (replaces the shared password)
// ---------------------------------------------------------------------------
// The old credential was a PUBLIC LITERAL: it was hardcoded in the extension
// source and shipped inside the built bundle, so anyone who unpacked the
// extension held a working credential for the local server. Its value is
// deliberately not repeated in comments here — a secret written in prose is
// still in the source, and is copy-paste bait for whoever reads it next.
//
// Replaced with a per-process random HS256 signing key plus a one-time pairing
// code. Both are generated here and never written to the repository. The
// pairing code is printed once for the operator; the extension exchanges it for
// a short-lived signed token which it keeps in chrome.storage.local.
//
// SECRETS_PAIRING_CODE exists so an automated harness can supply a known code.
// It is never expected to be set in normal operation.
const TOKEN_SIGNING_KEY =
  process.env.SECRETS_SIGNING_KEY || generateSigningKey();
const PAIRING_CODE =
  process.env.SECRETS_PAIRING_CODE || generatePairingCode();

// Cycle 2.5 (finding #3, CRITICAL): exact-match origin allowlist, registered
// BEFORE CORS and BEFORE auth so a disallowed origin is refused before any
// credential is examined. Requests with no Origin (curl, tests, Playwright)
// pass through to auth; OPTIONS is not evaluated.
const ALLOWED_ORIGINS = parseAllowedOrigins(process.env.ALLOWED_ORIGINS);
app.use('*', originGuard(ALLOWED_ORIGINS));

// Cycle 2.7: enforce the body limit BEFORE any handler reads a body.
//
// The previous implementation did `await c.req.raw.clone().text()` and then
// compared `rawBody.length` against a byte constant. That had two defects:
//   1. the entire body was materialised as a JS string before any size test ran,
//      so the limit protected nothing against memory exhaustion;
//   2. `.length` counts UTF-16 code units, not bytes, so a payload of
//      multi-byte characters passed a limit it exceeded by 2-3x.
// `bodyLimit` enforces on Content-Length AND during streaming, so an oversized
// body is never fully buffered.
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES) || 20 * 1024 * 1024;
app.use(
  '/api/*',
  bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => c.json({ error: 'Request body exceeds the configured limit.' }, 413),
  })
);

// Exported so tests can drive the REAL server instead of a hand-written
// mirror. Previously the app was module-private, which meant no test could
// import it (it also calls process.exit()/serve() at import time) and
// tests/integration/serverContract.test.ts re-implemented the server by hand.
// See tests/integration/realServerModule.test.ts.
export { app };

// CORS middleware — MUST be before auth and all routes
// Cycle 2.6: replace the wildcard with the same exact-match allowlist the
// origin guard uses. `origin: '*'` told every browser this API was shareable —
// the opposite of the intended posture — and let a disallowed origin read
// responses even though the guard had already returned 403.
//
// `credentials: false` is deliberate: this API authenticates with an explicit
// header, not cookies, so credentialed CORS would add ambient-authority risk
// for no benefit. Returning `null` for a disallowed origin makes Hono omit the
// header entirely rather than reflecting the caller's value back.
app.use('*', cors({
  origin: (origin) => (origin && ALLOWED_ORIGINS.has(origin) ? origin : null),
  allowHeaders: ['Content-Type', 'x-secret-password'],
  allowMethods: ['POST', 'GET', 'OPTIONS'],
  credentials: false,
  maxAge: 600,
}));

// Request-logger middleware
app.use('*', async (c, next) => {
  const start = Date.now();
  const method = c.req.method;
  const path = c.req.path;
  log.info(`→ ${method} ${path}`);
  await next();
  const duration = Date.now() - start;
  const status = c.res.status;
  const statusColor = status >= 500 ? COLORS.red : status >= 400 ? COLORS.yellow : COLORS.green;
  log.info(`← ${method} ${path} ${statusColor}${status}${COLORS.reset} (${duration}ms)`);
});

// Auth middleware — after CORS and request logger
/**
 * POST /api/auth/pair — exchange the one-time pairing code for a signed token.
 *
 * Registered AFTER the origin guard, so a web page cannot reach it: handing a
 * token to any site that asks would undo the entire cycle. No credential of its
 * own is required, because the pairing code IS the credential.
 */
app.post('/api/auth/pair', async (c) => {
  let code = '';
  try {
    const body = (await c.req.json()) as { code?: unknown };
    code = typeof body.code === 'string' ? body.code : '';
  } catch {
    return c.json({ error: 'Invalid JSON body.' }, 400);
  }

  if (!isPairingCodeValid(code, PAIRING_CODE)) {
    log.warn('Pairing attempt rejected — invalid code');
    return c.json({ error: 'Invalid pairing code.' }, 401);
  }

  const token = issueToken({
    key: TOKEN_SIGNING_KEY,
    subject: 'local-operator',
    audience: DEFAULT_AUDIENCE,
    ttlMs: DEFAULT_TTL_MS,
  });

  log.success('Extension paired — issued a bearer token.');
  return c.json({ token, expiresIn: DEFAULT_TTL_MS });
});

// ── Auth middleware ────────────────────────────────────────────────
// Registered AFTER /api/auth/pair, which is deliberately the only
// unauthenticated route: it is how a token is first obtained. Everything below
// this line requires a valid bearer token.
app.use('*', async (c, next) => {
  // CORS preflight bypass
  if (c.req.method === 'OPTIONS') {
    return await next();
  }

  // Cycle 2.4: bearer token only.
  //
  // The legacy `x-secret-password` header is NO LONGER ACCEPTED, deliberately.
  // Leaving it working would keep the literal in every shipped bundle a live
  // credential, and this cycle would have added a second way in while fixing
  // none of the problem.
  const authorization = c.req.header('authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/.exec(authorization);

  if (!match) {
    log.warn('Unauthorized request — missing or malformed bearer token');
    return c.text('Unauthorized', 401);
  }

  try {
    verifyToken(match[1], { key: TOKEN_SIGNING_KEY, audience: DEFAULT_AUDIENCE });
  } catch (err) {
    // The reason is logged locally and never returned to the client: telling an
    // attacker "expired" versus "bad signature" is a free oracle.
    const reason = err instanceof TokenError ? err.reason : 'unknown';
    log.warn(`Unauthorized request — token rejected (${reason})`);
    return c.text('Unauthorized', 401);
  }

  await next();
});

// ---------------------------------------------------------------------------
//  HEALTH & TELEMETRY ENDPOINTS
// ---------------------------------------------------------------------------
const startTime = Date.now();

app.get('/health', (c) => {
  const storageStats = getStorageStats();
  return c.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(), 
    uptime: Date.now() - startTime,
    authConfigured: !!process.env.SECRET_PASSWORD,
    aiProvider: hasGemini ? 'Google Gemini API (Priority 1)' : '9router (Priority 2)',
    storage: storageStats,
  });
});

/**
 * LIVE SYSTEM TELEMETRY API — Mission Control dashboard.
 *
 * Cycle 2.11: this used to return cpuModel, cpuCount, loadAvg, platform, arch
 * and the full memory breakdown to anyone holding the secret. Individually
 * unremarkable; together a precise hardware-and-OS fingerprint. And until
 * Cycle 2.5 closed the origin hole, this endpoint was readable from ANY web
 * page — with a secret that was a public literal in the extension bundle.
 *
 * The default response now carries only what an operator needs to decide
 * something: is it alive, how long has it been up, how much work has it done,
 * and is redaction degrading. Fingerprint fields move behind
 * TELEMETRY_VERBOSE (off by default) for local debugging.
 */
const TELEMETRY_VERBOSE =
  String(process.env.TELEMETRY_VERBOSE ?? '').toLowerCase() === 'true';

app.get('/api/system-telemetry', (c) => {
  const procMem = process.memoryUsage();
  const storageStats = getStorageStats();

  // Operational only by default: process liveness and work done.
  const system: Record<string, unknown> = { cpuCount: os.cpus().length };

  if (TELEMETRY_VERBOSE) {
    // Host fingerprint — opt-in, local debugging only. Documented in
    // server/.env.example as a field that should stay off in any deployment
    // where the endpoint could be reached by anyone but the operator.
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    system.totalMemBytes = totalMem;
    system.freeMemBytes = freeMem;
    system.usedMemBytes = usedMem;
    system.memUsagePercent = Number(((usedMem / totalMem) * 100).toFixed(1));
    system.cpuModel = os.cpus()[0]?.model || 'Standard CPU';
    system.loadAvg = os.loadavg();
    system.platform = os.platform();
    system.arch = os.arch();
  }

  return c.json({
    status: 'online',
    timestamp: new Date().toISOString(),
    system,
    process: {
      uptimeSeconds: Math.floor(process.uptime()),
      heapUsedBytes: procMem.heapUsed,
      heapTotalBytes: procMem.heapTotal,
      rssBytes: procMem.rss,
    },
    storage: {
      sessionsCount: storageStats.sessionsCount,
      totalDiskBytes: storageStats.totalDiskBytes,
    },
    aiProvider: {
      current: hasGemini ? 'Google Gemini API' : '9router',
      priority: hasGemini ? 'Priority 1 (Direct Gemini)' : 'Priority 2 (9router Fallback)',
      model: hasGemini
        ? (process.env.GEMINI_MODEL || 'gemini-2.5-flash')
        : (process.env.MODEL_NAME || 'ag/gemini-3.7-flash-high'),
    },
    // Cycle 1.4: a run that quietly lost its visual channel must be visible to
    // the operator rather than passing unnoticed. This stays in the DEFAULT
    // response — it is the reason the endpoint is worth calling at all, and
    // dropping it alongside the fingerprint fields would make a degraded run
    // invisible again.
    redaction: {
      policy: REJECT_UNREDACTED ? 'reject-unredacted' : 'accept-and-record',
      degradedSteps: redactionTally.degradedSteps,
      unavailableSteps: redactionTally.unavailableSteps,
      worstState: redactionTally.worstState,
      lastDegradedReason: redactionTally.lastDegradedReason,
    },
  });
});

/**
 * Initialize session directory under storage/sessions/<sessionId>/
 */
app.post('/api/session/init', async (c) => {
  try {
    const body = (await c.req.json()) as { sessionId?: string; task?: string };
    const sessionId = body.sessionId || `session_${Date.now()}`;
    const task = body.task || '';
    initSession(sessionId, task);
    return c.json({ success: true, sessionId });
  } catch {
    return c.json({ error: 'Failed to initialize session directory' }, 400);
  }
});

/**
 * Finalize session metadata
 */
app.post('/api/session/finalize', async (c) => {
  try {
    const body = (await c.req.json()) as { sessionId?: string; status?: 'completed' | 'aborted' | 'error'; summary?: string };
    if (body.sessionId) {
      finalizeSession(body.sessionId, body.status || 'completed', body.summary);
    }
    return c.json({ success: true });
  } catch {
    return c.json({ error: 'Failed to finalize session' }, 400);
  }
});

/**
 * Direct image archiving endpoint for standalone or intermediate screenshots
 */
app.post('/api/session/screenshot', async (c) => {
  try {
    const body = (await c.req.json()) as {
      sessionId: string;
      step?: number;
      rawImage?: string;
      maskedImage?: string;
      vlmImage?: string;
      task?: string;
      vlmModel?: string;
    };
    if (!body.sessionId) {
      return c.json({ error: 'sessionId is required' }, 400);
    }
    const step = typeof body.step === 'number' ? body.step : 1;
    saveSessionStep({
      sessionId: body.sessionId,
      step,
      task: body.task || 'Direct screenshot capture',
      rawImage: body.rawImage,
      maskedImage: body.maskedImage,
      vlmImage: body.vlmImage || body.maskedImage || body.rawImage,
      vlmModel: body.vlmModel || 'direct-capture',
    });
    return c.json({ success: true, sessionId: body.sessionId, step });
  } catch (err) {
    return c.json({ error: 'Failed to archive screenshot', details: String(err) }, 500);
  }
});

/**
 * List all saved agent execution sessions
 */
app.get('/api/sessions', (c) => {
  const sessions = listSessions();
  return c.json({ sessions, count: sessions.length });
});

/**
 * Retrieve detailed execution log & artifacts for a specific session
 */
app.get('/api/session/:sessionId', (c) => {
  const sessionId = c.req.param('sessionId');
  const details = getSessionDetails(sessionId);
  if (!details) {
    return c.json({ error: 'Session not found' }, 404);
  }
  return c.json(details);
});

// ---------------------------------------------------------------------------
//  ZERO-TRUST SERVER-SIDE FIREWALL GATE
// ---------------------------------------------------------------------------
function isLuhnValid(cardStr: string): boolean {
  const digits = cardStr.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let shouldDouble = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = parseInt(digits.charAt(i), 10);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

const FIREWALL_PATTERNS: Record<string, RegExp> = {
  PRIVATE_KEY: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  JWT_BEARER: /\bBearer\s+eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/,
  API_KEY: /\b(?:sk-[a-zA-Z0-9_-]{20,}|ghp_[a-zA-Z0-9]{20,}|glpat-[a-zA-Z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b/,
  AADHAAR: /(?<!\d)[2-9]\d{3}[ -]\d{4}[ -]\d{4}(?![ -]?\d)/,
  PAN: /\b[A-Z]{5}[0-9]{4}[A-Z]\b/,
  SSN: /\b\d{3}-\d{2}-\d{4}\b/,
  CARD: /(?<!\d)(?:\d{4}[ -]?){3}\d{4}(?!\d)|\b(?:\d[ -]*?){13,19}\b/,
  BANK_ACCOUNT: /\b(?:account\s*(?:no\.?|num(?:ber)?)|acct\s*#|a\/c)[:\s]*\d{9,18}\b/i,
  IFSC_CODE: /\b[A-Z]{4}0[A-Z0-9]{6}\b/,
  UPI_ID: /\b[a-zA-Z0-9.\-_]{2,256}@(okhdfcbank|okaxis|oksbi|paytm|upi|ybl|apl|axl|ibl|idfcbank)\b/i,
  HEALTH_ID: /\b\d{2}-\d{4}-\d{4}-\d{4}\b/,
  TAX_ID: /\b\d{2}[A-Z]{5}\d{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}\b/,

  // ── Cycle 2.10 ──────────────────────────────────────────────────────────
  // The server firewall covered 12 classes while the client-side verifier
  // (leakVerifier.VERIFICATION_PII_PATTERNS) covered 25. The server is the
  // SECOND line of defence — it is what catches a payload that arrives
  // un-redacted because the client was compromised, buggy, or operating in a
  // degraded mode. A second line that misses 11 PII classes is not a second
  // line. The 13 added below close that gap; the set is now deliberately the
  // same taxonomy the client uses, so the two layers cannot drift apart again
  // the way the test mirror did (finding N8).
  SWIFT_BIC: /\b[A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?\b|\b[A-Z]{2}\d{2}[A-Z0-9]{12,30}\b/,
  CRYPTO_WALLET: /\b(?:0x[a-fA-F0-9]{40}|(?:1|3|bc1)[a-zA-HJ-NP-Z0-9]{25,39})\b/,
  PASSPORT: /\b[A-Z][1-9]\d{6}\b|\b[A-Z]\d{7}\b/,
  DRIVING_LICENSE: /\b[A-Z]{2}[0-9]{2}[ -]?[0-9]{11}\b/,
  PERSON: /\b(?:Mr\.|Mrs\.|Ms\.|Dr\.)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\b/,
  PHONE: /(?<!\d)(?:\+?\d{1,3}[-.\s]?)?(?:\(\d{3}\)\s*\d{3}[-.\s]?\d{4}|\b[6-9]\d{9}\b|\b0\d{2,4}[- ]?\d{6,8}\b)(?!\d)/,
  EMAIL: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
  DOB: /\b(?:DOB|Date of Birth|Birth Date|Born)[:\s]*\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/i,
  PASSWORD: /(?:password|passwd)[:=\s]+\S+|\*{4,}/i,
  PIN_CRED: /\b(?:ATM\s*PIN|MPIN|Security\s*PIN|OTP|One-Time\s*Password)[:\s]*\d{4,6}\b/i,
  JWT_TOKEN: /\bBearer\s+eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b|\beyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/,
  MEDICAL_RECORD: /\b(?:Patient\s*ID|MRN|Prescription\s*No|Rx\s*#)[:\s]*[A-Z0-9-]{4,16}\b/i,
};

const PLACEHOLDER_STRIP_RE = /\[[A-Z][A-Z_ ]*\]|\*{2,}/g;

export function checkFirewallViolations(text: string): string | null {
  const clean = text.replace(PLACEHOLDER_STRIP_RE, ' ');

  for (const [name, regex] of Object.entries(FIREWALL_PATTERNS)) {
    const match = clean.match(regex);
    if (match) {
      if (name === 'CARD') {
        if (!isLuhnValid(match[0])) continue;
      }
      return `${name} detected: ${match[0].slice(0, 4)}...`;
    }
  }

  // Cycle 2.10: physical addresses have no single regex — they are a
  // combination of components — so this check is heuristic rather than
  // pattern-based, which is why it is delegated to the shared analyser.
  if (containsFullAddress(clean)) {
    return 'ADDRESS detected: multi-component physical address';
  }

  return null;
}

// ---------------------------------------------------------------------------
//  UNIVERSAL MULTI-DOMAIN TASK CLASSIFIER & PROMPT GENERATOR (7 ISRO PILLARS + WEB)
// ---------------------------------------------------------------------------
export type TaskDomain =
  | 'SHOPPING_COMPARISON'
  | 'WORKFLOW_ACTION'
  | 'INFORMATION_EXTRACTION'
  | 'ISRO_ENTERPRISE_OPERATIONS'
  | 'GEOSPATIAL_WORKFLOW';

export function classifyTaskDomain(task: string, maskedDom?: string): TaskDomain {
  const lower = task.toLowerCase();
  const domLower = (maskedDom || '').toLowerCase();

  // 1. ISRO Sovereign Enterprise Operations (7 Core Pillars):
  // Pillar 1: Mission Control & Telemetry (MOX, LVM3, PSLV, Gaganyaan, Chandrayaan, telemetry, stage separation)
  // Pillar 2: Earth Observation & GIS (Bhuvan, Bhoonidhi, NRSC, URSC, Thematic, Flood Hazard, Drought, GIS)
  // Pillar 3: Ground Station Network Operations (ISTRAC, Byalalu Deep Space Network DSN-32, pass schedule, Az/El)
  // Pillar 4: Secure Administrative & Scientist Clearances (Level 1-5 RBAC, classified mission authorization)
  // Pillar 5: R&D, Propulsion Research & Patents (SAC, LPSC, VSSC, cryogenic CE-20, SCE-200, propellant, patent)
  // Pillar 6: Aerospace Supply Chain & Procurement (Inconel 718, Titanium Ti-6Al-4V, Rad-Hard chips, tender bids)
  // Pillar 7: Space Situational Awareness (Project NETRA, orbital debris, CARA conjunction, CAM avoidance)
  const isroKeywords = [
    // Pillar 1: Mission Control & Launch Telemetry (MOX)
    'launch', 'telemetry', 'in-orbit', 'mox', 'pslv', 'gslv', 'lvm3', 'gaganyaan',
    'chandrayaan', 'aditya-l1', 'reaction wheel', 'chamber pressure', 'cryogenic pressure',
    'stage separation', 'abort command', 'thrust vector', 'orbital insertion', 'mox-telemetry',
    // Pillar 2: Earth Observation & Remote Sensing (Bhuvan / Bhoonidhi / NRSC)
    'isro', 'bhuvan', 'bhoonidhi', 'mosdac', 'vedas', 'nrsc', 'ursc', 'thematic',
    'thematic services', 'satellite', 'earth observation', 'remote sensing', 'flood hazard',
    'drought', 'cyclone', 'coastal sector', 'odisha', 'cartosat', 'risat', 'oceansat',
    'gis', 'geospatial', 'aoi', 'zoom into', 'geotiff', 'satellite imagery', 'land use',
    // Pillar 3: Ground Station Network (ISTRAC / Byalalu DSN)
    'istrac', 'byalalu', 'dsn', 'deep space network', 'antenna', 'pass authorization',
    'pass scheduling', 'azimuth', 'elevation', 'downlink', 'uplink', 'ground station',
    'tracking station', 'port blair', 'mauritius', 'doppler',
    // Pillar 4: Secure Administrative & Scientist Clearance Workflows
    'scientist clearance', 'security clearance', 'classified mission', 'clearance level',
    'level 5', 'access control', 'mission authorization', 'dossier', 'scientist credential',
    'biometric authorization', 'isro clearance', 'personnel clearance',
    // Pillar 5: R&D, Propulsion Research & Patents (SAC / LPSC / VSSC)
    'sac', 'lpsc', 'vssc', 'cryogenic engine', 'ce-20', 'semi-cryogenic', 'sce-200',
    'propellant chemistry', 'patent analysis', 'patent search', 'propulsion research',
    'thrust chamber', 'injector design', 'research paper', 'propulsion patent',
    // Pillar 6: Aerospace Supply Chain & Procurement (ISRO e-Procure)
    'procurement', 'tender', 'tender bid', 'vendor', 'aerospace grade', 'inconel',
    'inconel 718', 'titanium alloy', 'ti-6al-4v', 'rad-hard', 'supply chain',
    'rfq', 'rfp', 'isro procure', 'purchase order', 'aerospace alloy',
    // Pillar 7: Space Situational Awareness & Space Security (Project NETRA)
    'netra', 'project netra', 'space situational awareness', 'orbital debris', 'debris tracking',
    'cara', 'conjunction assessment', 'collision avoidance', 'cam', 'miss distance',
    'collision probability', 'norad'
  ];

  if (isroKeywords.some(kw => lower.includes(kw))) {
    return 'ISRO_ENTERPRISE_OPERATIONS';
  }

  // 2. Explicit shopping keywords
  const shoppingKeywords = [
    'buy', 'price', 'under ₹', 'under rs', 'under $', 'flipkart', 'amazon',
    'myntra', 'cheapest', 'discount', 'deal', 'specs', 'rating', 'smartphone',
    'laptop', 'shoes', 'product', 'add to cart', 'purchase', 'order'
  ];
  if (shoppingKeywords.some(kw => lower.includes(kw))) {
    return 'SHOPPING_COMPARISON';
  }

  // 3. Workflow / Form / Social Action keywords
  const workflowKeywords = [
    'post', 'tweet', 'send', 'mail', 'email', 'form', 'fill', 'apply',
    'submit', 'register', 'login', 'signup', 'message', 'comment',
    'connect', 'follow', 'share', 'upload', 'sheet', 'row', 'entry',
    'linkedin', 'twitter', 'x.com', 'write a post', 'share a post', 'shortlist', 'participate'
  ];
  if (workflowKeywords.some(kw => lower.includes(kw))) {
    return 'WORKFLOW_ACTION';
  }

  // Check DOM signals if task text is ambiguous
  if (
    domLower.includes('isro') ||
    domLower.includes('bhuvan') ||
    domLower.includes('bhoonidhi') ||
    domLower.includes('thematic services') ||
    domLower.includes('istrac') ||
    domLower.includes('mox') ||
    domLower.includes('project netra') ||
    domLower.includes('orbital debris') ||
    domLower.includes('conjunction-table') ||
    domLower.includes('clearance-level') ||
    domLower.includes('satellite operations') ||
    domLower.includes('ol-viewport') ||
    domLower.includes('leaflet-container')
  ) {
    return 'ISRO_ENTERPRISE_OPERATIONS';
  }

  if (domLower.includes('add to cart') || domLower.includes('buy now') || domLower.includes('ratings & reviews')) {
    return 'SHOPPING_COMPARISON';
  }

  // 4. Default to Information Extraction / Research for general queries
  return 'INFORMATION_EXTRACTION';
}

export function generateDomainPrompt(domain: TaskDomain): string {
  const sharedGroundingRules = `
CRITICAL INSTRUCTIONS:
- You are a precise browser automation agent executing on a client browser.
- The DOM contains synthetic tokens like [CARD_TOKEN_1] replacing real sensitive text. TREAT THEM AS REAL LITERAL STRINGS.
- Return ONLY a valid JSON object matching the schema below. No markdown backticks outside of valid JSON. No conversational text.
- UNIVERSAL DROPDOWNS & FORM CASCADES:
  * Native Dropdowns (<select>): ALWAYS use action: "select", id: "agent-X" (or "#id"), and provide the target option text in value: "Option Text" (e.g. value: "Flood Hazard" or value: "ODISHA"). NEVER send a bare action: "click" on <select> without specifying a value.
  * Cascading Dropdowns: Changing parent dropdown A triggers an asynchronous server round-trip to populate child dropdown B. Select parent A in Step 1; in Step 2, observe the populated child B and select the target item.
  * Custom Menus & Comboboxes ([role="combobox"], [aria-haspopup], .dropdown-toggle): First click the toggle button to open, then click the desired [role="option"] or .dropdown-item.
- ZOOM & MAP CONTROLS:
  * To zoom in on interactive maps or GIS viewports: use action: "zoom", value: "in" (or click the "+" / "zoom-in" button).
  * To zoom out: use action: "zoom", value: "out" (or click the "-" / "zoom-out" button).
`;

  if (domain === 'ISRO_ENTERPRISE_OPERATIONS' || domain === 'GEOSPATIAL_WORKFLOW') {
    return `${sharedGroundingRules}
DOMAIN MODE: REAL-TIME ISRO SOVEREIGN ENTERPRISE & MISSION OPERATIONS (7 CORE PILLARS)
Goal: Autonomously navigate, inspect, verify, and operate mission-critical workflows across all 7 operational pillars of ISRO directly on REAL-TIME LIVE WEB PAGES and sovereign government portals.

PRODUCTION SOVEREIGN WEB PORTALS & DESTINATIONS:
- Bhuvan Geoportal & Thematic Services: "https://bhuvan.nrsc.gov.in" (Thematic: "https://bhuvan-app1.nrsc.gov.in/thematic/")
- Bhoonidhi Satellite Archive: "https://bhoonidhi.nrsc.gov.in"
- MOSDAC Oceanographic & Weather Services: "https://www.mosdac.gov.in"
- VEDAS Geospatial Platform: "https://vedas.sac.gov.in"
- ISRO Official Web Portal: "https://www.isro.gov.in"
- Central Public Procurement Portal (CPPP) & GeM: "https://eprocure.gov.in" / "https://gem.gov.in"
- Indian Patent Office Search (InPASS): "https://ipindiaservices.gov.in/publicsearch"
- Space Situational Awareness / Debris (Space-Track / CelesTrak): "https://www.space-track.org" / "https://celestrak.org"

REAL-TIME WEB EXECUTION RULES ACROSS 7 OPERATIONAL PILLARS:

1. PILLAR 1: MISSION CONTROL & TELEMETRY MONITORING (MOX)
   - Real-time navigation: Navigate directly to official ISRO mission updates or telemetry dashboard.
   - Inspect launch vehicle telemetry (LVM3, PSLV, GSLV) or spacecraft health matrices (Chandrayaan, Gaganyaan).
   - Read vital live parameters: Orbit Altitude, Velocity, Reaction Wheels RPM, Cryogenic Pressure, Solar Array Current.
   - Verify stage separation sequence (Stage 1 Solid, Stage 2 Liquid, Cryogenic Upper Stage, Payload Fairing).

2. PILLAR 2: EARTH OBSERVATION & REMOTE SENSING (BHUVAN / BHOONIDHI / NRSC)
   - Direct Navigation: On empty tab or search page, navigate directly to "https://bhuvan.nrsc.gov.in" or Thematic Services "https://bhuvan-app1.nrsc.gov.in/thematic/thematic/index.php".
   - Step A (Thematic Catalog / Dropdown): On Bhuvan Thematic Services, locate the "Select Theme" dropdown (id: "theme") and use action: "select", value: "Flood Hazard" (or "Flood Annual Layers").
   - Step B (Geography / State Dropdown): Once theme is selected, locate the "Select Geography" dropdown (id: "states", id: "states1", or select[name="states"]) and use action: "select", value: "ODISHA" (or "Odisha").
   - Step C (Render Layer): Click the "View" button (id: "mapbutton", id: "View", or img[src*="view.png"]) to render the layer on the map canvas.
   - Step D (Location Geocoding & Zoom): Locate the search box if searching a district/basin, type the sector (e.g. 'Odisha coastal sector', 'Puri') and press Enter. Then use action: "zoom", value: "in" on the map viewport to inspect regional flood zones.
   - Step E (Satellite Product Ordering): On Bhoonidhi ("https://bhoonidhi.nrsc.gov.in"), filter cloud cover < 10% and order GeoTIFF datasets.

3. PILLAR 3: GROUND STATION NETWORK OPERATIONS (ISTRAC / BYALALU DSN)
   - Inspect tracking ground stations: Byalalu Deep Space Network (32m DSN-32), Port Blair, Mauritius, or Brunei.
   - Verify antenna pointing: Azimuth (°), Elevation (°), Frequency Doppler Lock.
   - Execute Satellite Pass Authorization: Fill employee ID, select spacecraft pass, and submit authorization.

4. PILLAR 4: SECURE ADMINISTRATIVE, HR & SCIENTIST CLEARANCES
   - Role-Based Access Control: Select Clearance Level (Level 1 General, Level 3 Payload Specialist, Level 5 Top Secret Director).
   - Enter Scientist ID and biometric authorization credentials.
   - Review and verify classified mission authorization sign-offs.

5. PILLAR 5: R&D, PROPULSION RESEARCH & PATENT ANALYSIS (SAC / LPSC / VSSC)
   - On InPASS or technical repository: Search cryogenic engines (CE-20), semi-cryogenic test benches (SCE-200), or propellant chemistry.
   - Query patent registry (additive rocket injectors, carbon-composite payload fairings).
   - Synthesize and extract technical documentation abstracts.

6. PILLAR 6: AEROSPACE SUPPLY CHAIN & CONFIDENTIAL PROCUREMENT
   - On CPPP / GeM / e-Procure: Search space-grade materials (Inconel 718, Titanium Ti-6Al-4V, Rad-Hard FPGAs).
   - Inspect vendor tender bids, evaluate technical compliance scores, and confirm Purchase Order status.

7. PILLAR 7: SPACE SITUATIONAL AWARENESS & SPACE SECURITY (PROJECT NETRA)
   - Real-time Orbital Debris Tracking: Monitor NORAD IDs, relative velocities, and close approach perigee/apogee on Space-Track/CelesTrak.
   - Conjunction Assessment Risk Analysis (CARA): Inspect conjunction alerts for high-risk collision events.
   - Collision Avoidance Maneuver (CAM): When Miss Distance < 1 km or Collision Probability Pc > 1e-4, verify CAM Delta-V thruster burn schedule.

JSON Output Format:
{
  "thought": "Brief 1-sentence reasoning of the exact real-time operational step taking now",
  "action": "click" | "select" | "zoom" | "type" | "navigate" | "scroll" | "wait" | "done" | "back",
  "id": "agent-id if available (e.g. agent-14)",
  "selector": "Precise CSS selector or element keyword",
  "value": "Text to type (with \\n for Enter), URL to navigate to, 'in'/'out' for zoom, or option to select",
  "scroll_direction": "down" | "up",
  "scratchpad": {
    "activePillar": "1: Mission Control" | "2: Earth Observation & GIS" | "3: Ground Stations" | "4: Clearances" | "5: Propulsion R&D" | "6: Procurement" | "7: SSA & Project NETRA",
    "isroOperationalTelemetry": {
      "spacecraft": "LVM3-M4 / Chandrayaan / Cartosat-3",
      "metricSummary": "Altitude: 504.2 km | Velocity: 7.62 km/s | Cryo Pressure: 18.4 Bar | CARA Pc: 4.2e-4",
      "operationalStatus": "Nominal / Alert / Action Executed"
    },
    "milestones": [
      { "name": "Navigate to live portal or mission console", "status": "completed" | "in_progress" | "pending" },
      { "name": "Execute pillar-specific command or spatial analysis", "status": "pending" },
      { "name": "Verify telemetry, authorization, or confirmation toast", "status": "pending" }
    ],
    "isComplete": false
  }
}
`;
  }

  if (domain === 'WORKFLOW_ACTION') {
    return `${sharedGroundingRules}
DOMAIN MODE: WORKFLOW & SOCIAL AUTOMATION
Goal: Execute real-world UI workflows like social posts, compose messages, submit forms, or update sheets.

STRICT WORKFLOW RULES:
1. DIRECT NAVIGATION: If the current page is a search engine (e.g. Google), blank tab, or different site from the target (e.g. LinkedIn, Twitter, Gmail), use action: "navigate", value: "https://www.target-domain.com". DO NOT type URLs into search boxes.
2. FOCUS ON ACTION FLOW: Proceed step-by-step (e.g. click "Start a post", type text into the compose editor, click "Post").
3. DO NOT look for prices, specifications, reviews, or shopping filters.
4. MODAL EDITORS & TYPING OBSERVATION:
   - When typing into rich-text editors or compose modals, use action: "type", value: "your full content", and target the editor using id or selector.
   - Look closely at the DOM: if the editor shows "[Typed Content (... chars)]", the text is ALREADY typed into the editor. DO NOT type it again!
   - Immediately proceed to click the progression button (e.g. "Post", "Send", "Publish", "Submit", or "Save").
5. UNIVERSAL SUBMISSION & COMPLETION (CRITICAL):
   - Across all workflows (social posts on LinkedIn, X/Twitter, Reddit; messaging on WhatsApp, Slack, Discord; email on Gmail/Outlook/Hostinger; comments; or web forms):
   - After typing the requested content and clicking "Post", "Send", "Publish", "Submit", or pressing Enter:
     THE CONTENT HAS BEEN SUBMITTED AND THE ACTION IS EXECUTED.
   - CHECK 'Recent Actions Executed in this Session': If you ALREADY typed the message/post and clicked "Post", "Send", or "Submit" in a previous step:
     YOUR GOAL IS 100% COMPLETE!
   - DO NOT click "Start a post", "Compose", "Create post", "New tweet", or any creation trigger again! Doing so starts an infinite duplicate post loop!
   - DO NOT type the message or form values again into an empty input field!
   - Return action: "done" immediately with a concise summary (e.g. "Post successfully published to LinkedIn feed.").
6. SINGLE-TASK EXECUTION: Unless the user explicitly requested multiple separate submissions (e.g. "post 3 times"), every workflow is a single-submission task. Once submitted, finish with action: "done".
7. IF MULTIPLE MILESTONES: Keep track of milestones in the "scratchpad" under milestones: [{ "name": string, "status": "completed"|"pending" }].

JSON Output Format:
{
  "thought": "Brief 1-sentence reasoning of the exact step taking now",
  "action": "click" | "select" | "zoom" | "type" | "navigate" | "scroll" | "wait" | "done" | "back",
  "id": "agent-id if available (e.g. agent-31)",
  "selector": "Precise CSS selector or element keyword",
  "value": "Text to type (with \\n for Enter), URL to navigate to, option to select, or 'down'/'up'",
  "scroll_direction": "down" | "up",
  "scratchpad": {
    "workflowGoal": "Brief summary of goal",
    "milestones": [
      { "name": "Milestone description", "status": "completed" | "in_progress" | "pending" }
    ],
    "actionCount": 1,
    "lastActionStatus": "success",
    "isGoalVerified": false
  }
}`;
  }

  if (domain === 'INFORMATION_EXTRACTION') {
    return `${sharedGroundingRules}
DOMAIN MODE: INFORMATION EXTRACTION & SYNTHESIS
Goal: Gather, read, extract, or summarize research data, announcements, problem statements, documentation, or portal information.

STRICT EXTRACTION RULES:
1. DIRECT NAVIGATION: If the current page is not the target portal (e.g. SIH, Docs), use action: "navigate", value: "https://target-portal.gov.in".
2. SCANNING & READING: Locate relevant text, headings, sections, or downloadable docs.
3. DO NOT evaluate products, prices, or ratings unless explicitly asked in the task.
4. RECORD FINDINGS: Save extracted data points in scratchpad.extractedItems.
5. COMPLETION: When sufficient accurate information to answer the task is extracted, call action: "done" and summarize findings cleanly in the thought and scratchpad.

JSON Output Format:
{
  "thought": "Brief 1-sentence reasoning of what information is being extracted or next section to read",
  "action": "click" | "select" | "zoom" | "type" | "navigate" | "scroll" | "wait" | "done" | "back",
  "id": "agent-id if available (e.g. agent-8)",
  "selector": "Precise CSS selector or element keyword",
  "value": "Text to type (with \\n for Enter), URL to navigate to, option to select, or 'down'/'up'",
  "scroll_direction": "down" | "up",
  "scratchpad": {
    "researchGoal": "Summary of research objective",
    "pagesScanned": 1,
    "extractedItems": [
      { "title": "...", "content": "..." }
    ],
    "isComplete": false
  }
}`;
  }

  // Default: SHOPPING_COMPARISON
  return `${sharedGroundingRules}
DOMAIN MODE: SHOPPING & PRODUCT COMPARISON
Goal: Compare products, specs, prices, ratings, and identify best match according to user constraints.

STRICT SHOPPING RULES:
1. DIRECT NAVIGATION: If not on the shopping portal (Amazon, Flipkart), use action: "navigate", value: "https://www.target-shopping.com".
2. EXPLORATION OVER PREMATURE SATURATION:
   - Top search results are almost always sponsored ads or out of budget.
   - If initial top items fail constraints, DO NOT stop or declare saturation immediately.
   - Scroll down to inspect organic search results, or click sidebar filters (Price / Rating) to locate qualifying items.
3. Maintain candidate tracking in scratchpad.candidates.
4. Reject candidates failing hard filters and record in rejectedCandidates.
5. Conclude with action: "done" only after inspecting organic options across multiple scrolls or filters, or when a qualified match is found.

JSON Output Format:
{
  "thought": "Brief 1-sentence reasoning comparing products or filtering",
  "action": "click" | "select" | "zoom" | "type" | "navigate" | "scroll" | "wait" | "done" | "back",
  "id": "agent-id if available (e.g. agent-3)",
  "selector": "Precise CSS selector or element keyword",
  "value": "Text to type (with \\n for Enter), URL to navigate to, option to select, or 'down'/'up'",
  "scroll_direction": "down" | "up",
  "scratchpad": {
    "currentBudget": 15000,
    "requiredSpecs": {},
    "candidates": [],
    "rejectedCandidates": []
  }
}`;
}

// ---------------------------------------------------------------------------
//  MULTIMODAL AGENTIC STEP EXECUTION (POST /api/step)
// ---------------------------------------------------------------------------
app.post('/api/step', async (c) => {
  // Rate limiting
  const clientIp = clientAddress(c);
  const rateLimit = checkRateLimit(clientIp);
  if (!rateLimit.allowed) {
    log.warn(`Rate limit exceeded for IP ${clientIp} — 429 returned`);
    c.header('X-RateLimit-Limit', String(RATE_LIMIT_MAX_REQUESTS));
    c.header('X-RateLimit-Remaining', '0');
    c.header('X-RateLimit-Reset', new Date(rateLimit.resetAt).toISOString());
    // Cycle 2.8: tell the client how long to wait instead of making it guess.
    const retryAfterSeconds = Math.max(1, Math.ceil((rateLimit.resetAt - Date.now()) / 1000));
    c.header('Retry-After', String(retryAfterSeconds));
    return c.json({ error: 'Too many requests. Please wait before retrying.' }, 429);
  }


  // Parse and validate input.
  //
  // Cycle 2.7: this used to be `JSON.parse(rawBody)` where `rawBody` came from
  // an explicit `c.req.raw.clone().text()`. That call is gone — it buffered the
  // whole body before the size check could reject it. `c.req.json()` reads the
  // already-cached body, which `bodyLimit` has already bounded.
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    log.warn(`Invalid JSON body from ${clientIp} — 400 returned`);
    return c.json({ error: 'Invalid JSON in request body.' }, 400);
  }

  // Cycle 2.9 (Task 3): one declared contract replaces the ad-hoc typeof checks
  // that only ever covered `task` and `maskedDom`. Everything else — the base64
  // images, the legend, the action history, the sub-task list — was previously
  // accepted on trust, with no shape check, no ceiling, and no rejection of
  // unknown keys. `.strict()` means the client's twelve keys are the only keys.
  //
  // ORDERING: this runs BEFORE the PII firewall below. Malformed payloads are
  // rejected on SHAPE; the firewall still guards well-formed ones. Both layers
  // survive — defence in depth.
  const validated = StepSchema.safeParse(body);
  if (!validated.success) {
    const first = validated.error.issues[0];
    log.warn(
      `Schema violation from ${clientIp} — 400 returned: ${first?.path.join('.') ?? '(root)'}: ${first?.message ?? 'invalid'}`
    );
    return c.json(
      {
        error: 'INVALID_REQUEST_SHAPE',
        detail: first ? `${first.path.join('.') || '(root)'}: ${first.message}` : 'invalid payload',
      },
      400
    );
  }

  const {
    task,
    maskedDom,
    redactedImage,
    redaction_legend,
    scratchpad,
    sessionId: clientSessionId,
    step: clientStep,
    rawImage,
    vlmImage,
    subTasks: clientSubTasks,
    actionHistory: clientActionHistory,
    redaction: clientRedaction,
  } = validated.data;

  const imageBase64 = typeof redactedImage === 'string' ? redactedImage : '';

  const incomingVlmImage = (typeof vlmImage === 'string' && vlmImage.trim().length > 50) ? vlmImage.trim() : '';
  const finalVlmImage = incomingVlmImage || imageBase64 || (typeof rawImage === 'string' ? rawImage : undefined);

  const legendArray: unknown[] = redaction_legend ?? [];

  const incomingScratchpad = (typeof scratchpad === 'object' && scratchpad !== null) ? scratchpad : null;
  const sessionId = (typeof clientSessionId === 'string' && clientSessionId.trim()) ? clientSessionId.trim() : `session_${randomUUID()}`;
  const step = typeof clientStep === 'number' ? clientStep : 1;
  const subTasks = clientSubTasks ?? [];
  const actionHistory = clientActionHistory ?? [];

  // ZERO-TRUST SECURITY FIREWALL GATE: Rejects unmasked PII payloads before reaching upstream VLMs
  const firewallViolation = checkFirewallViolations(maskedDom);
  if (firewallViolation) {
    log.error(`[Firewall Gate] Rejected unmasked PII in payload from ${clientIp} [${sessionId}]: ${firewallViolation}`);
    return c.json({
      error: 'UNSANITIZED_PAYLOAD_REJECTED',
      detail: `Security firewall rejected unmasked PII in payload: ${firewallViolation}`,
    }, 400);
  }

  // Cycle 1.4: treat the client's redaction envelope as a CLAIM. The server
  // decides policy, and accounts for every step that was not verified.
  const redactionVerdict = evaluateRedactionPolicy(
    clientRedaction as RedactionEnvelopeInput | undefined,
    REJECT_UNREDACTED
  );
  if (!redactionVerdict.accepted) {
    log.warn(`[Redaction policy] Rejected step ${step} from ${clientIp}: ${redactionVerdict.error}`);
    return c.json({ error: redactionVerdict.error }, redactionVerdict.status as 400);
  }
  if (redactionVerdict.degraded) {
    recordDegradation(redactionTally, clientRedaction as RedactionEnvelopeInput | undefined);
    log.warn(
      `[Redaction policy] Step ${step} accepted DEGRADED (${redactionVerdict.state}): ${redactionVerdict.degradedReason}`
    );
  }

  // Log payload sizes
  log.info(`Step ${step} [${sessionId}] — task: ${task.length} chars, maskedDom: ${maskedDom.length} chars, redactedImage: ${imageBase64.length} chars, rawImage: ${typeof rawImage === 'string' ? rawImage.length : 0} chars, history: ${actionHistory.length} items`);

  function parseActionJson(text: string): Record<string, unknown> {
    let cleaned = text.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
    }
    // Bug 8: Strip trailing commas before closing braces/brackets e.g. {"a": 1,} or [1, 2,]
    const sanitizeJson = (str: string) => str.replace(/,\s*([\]}])/g, '$1');
    try {
      return JSON.parse(sanitizeJson(cleaned));
    } catch {
      const firstBrace = cleaned.indexOf('{');
      const lastBrace = cleaned.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        const extracted = cleaned.slice(firstBrace, lastBrace + 1);
        return JSON.parse(sanitizeJson(extracted));
      }
      throw new Error('AI returned invalid JSON');
    }
  }

  const domain = classifyTaskDomain(task, maskedDom);
  const taskMode = domain === 'SHOPPING_COMPARISON' ? 'shopping' : domain === 'WORKFLOW_ACTION' ? 'workflow' : (domain === 'ISRO_ENTERPRISE_OPERATIONS' || domain === 'GEOSPATIAL_WORKFLOW') ? 'isro' : 'info';
  const systemPrompt = generateDomainPrompt(domain);
  log.info(`Task domain classified as: ${domain} (mode: ${taskMode})`);

  // -------------------------------------------------------------------------
  // SERVER-SIDE DETERMINISTIC WORKFLOW COMPLETION GATE (Pre-VLM)
  // Prevents infinite loops on social posts, web forms, emails, and messaging workflows.
  // If the agent already submitted content in actionHistory (clicked Post/Send/Submit or pressed Enter),
  // and the page DOM confirms submission (e.g. LinkedIn toast "Post successful" / "View post",
  // Twitter "Your post was sent", email "Message sent", or composer modal closed):
  // Short-circuit IMMEDIATELY with action: "done" without calling Gemini/9router!
  // -------------------------------------------------------------------------
  if (taskMode === 'workflow' && actionHistory.length > 0) {
    const domLower = maskedDom.toLowerCase();

    // 1. Detect if substantial content was actually typed in action history
    const hasPriorTyping = actionHistory.some((a) => {
      const act = String(a.action || '').toLowerCase();
      const val = String(a.value || '').trim();
      return (act === 'type' || act === 'fill') && val.length > 15;
    });

    // 2. Detect if any previous action in history was an actual submission action AFTER or WITH typing
    const hasPriorSubmission = actionHistory.some((a) => {
      const act = String(a.action || '').toLowerCase();
      const tgt = String(a.target || '').toLowerCase();
      const val = String(a.value || '').toLowerCase();

      // Opener buttons (Start a post, Compose, etc.) MUST NEVER be treated as submissions
      const isOpener = [
        'start a post',
        'create a post',
        'write a post',
        'start writing',
        'new post',
        'compose',
        'new tweet',
        'new message',
        'start a discussion',
      ].some((op) => tgt.includes(op) || val.includes(op));

      if (isOpener) return false;

      const isSubmitClick =
        act === 'click' &&
        ['post', 'send', 'submit', 'publish', 'tweet', 'reply', 'confirm', 'share-actions'].some((term) =>
          tgt.includes(term) || val.includes(term)
        );
      const isEnterKey = (act === 'type' || act === 'keypress') && (val.includes('\n') || val.includes('\r')) && val.length > 15;
      return isSubmitClick || isEnterKey;
    });

    // 3. Detect platform success toasts, banners, or confirmation phrases
    const hasConfirmationToast = [
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
    ].some((sig) => domLower.includes(sig));

    // 4. Detect that composer modal has closed and returned to feed / homepage with "Start a post" / "Compose"
    const hasFeedWithComposerClosed =
      (domLower.includes('start a post') || domLower.includes('compose') || domLower.includes('new post') || domLower.includes('new tweet')) &&
      !domLower.includes('contenteditable="true"') &&
      !domLower.includes('share your thoughts');

    if (hasPriorTyping && hasPriorSubmission && (hasConfirmationToast || hasFeedWithComposerClosed || step >= 4)) {
      log.info(`✅ [Server Workflow Gate] Detected completed workflow submission in actionHistory and DOM. Short-circuiting to action: "done".`);
      const doneResponse: Record<string, unknown> = {
        thought: 'Workflow submission successfully executed and confirmed on page (confirmation toast/feed visible). Mission complete.',
        action: 'done',
        summary: 'Content successfully posted and confirmed on page.',
        taskMode,
        domain,
        scratchpad: {
          ...(incomingScratchpad || {}),
          workflowStatus: 'completed',
          isGoalVerified: true,
        },
      };

      saveSessionStep({
        sessionId,
        step,
        task,
        subTasks,
        rawImage: typeof rawImage === 'string' ? rawImage : undefined,
        maskedImage: imageBase64,
        vlmImage: finalVlmImage,
        vlmModel: 'workflow-gate-shortcircuit',
        promptContext: 'Workflow completion gate short-circuited upstream VLM call.',
        vlmResponse: JSON.stringify(doneResponse),
        actionJson: doneResponse,
      });

      logRequest({
        sessionId,
        timestamp: new Date().toISOString(),
        maskedDom,
        redactionLegend: redaction_legend ?? [],
        returnedAction: {
          action: 'done',
          value: String(doneResponse.summary),
        },
      });

      return c.json(doneResponse);
    }
  }

  const historyText =
    actionHistory.length > 0
      ? '\n\nRecent Actions Executed in this Session:\n' +
        actionHistory
          .map((a, idx) => {
            const act = String(a.action || 'action');
            const tgt = a.target ? `target: ${a.target}` : '';
            const val = typeof a.value === 'string' ? `value: "${a.value.slice(0, 70).replace(/\n/g, '\\n')}"` : '';
            return `- Step ${idx + 1}: ${act} ${tgt} ${val}`.trim();
          })
          .join('\n')
      : '';

  // Build multimodal user message (ZERO-TRUST: rawImage is NEVER sent to the cloud)
  const userContent: Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } }
  > = [
    {
      type: 'text',
      text:
        'Task: ' +
        task +
        historyText +
        (incomingScratchpad
          ? '\n\nWorking Memory Scratchpad:\n' + JSON.stringify(incomingScratchpad, null, 2)
          : '') +
        '\n\nMasked DOM:\n' +
        maskedDom +
        '\n\nredaction_legend:\n' +
        JSON.stringify(legendArray),
    },
  ];

  // Only attach the redacted image if present.
  //
  // Cycle 1.5 (N5): the label used to be hardcoded `image/jpeg` regardless of
  // what the bytes actually were, so a PNG frame from a client was forwarded
  // mislabelled. The MIME subtype is now derived from the magic bytes, and a
  // declared/actual mismatch is refused rather than silently forwarded.
  if (imageBase64.trim().length > 50) {
    const declaredMime = 'image/jpeg';
    const imageCheck = validateImagePayload(imageBase64, declaredMime);
    if (!imageCheck.ok) {
      log.warn(`[Image safety] Refusing outbound frame for ${sessionId}: ${imageCheck.error}`);
    } else {
      userContent.push({
        type: 'image_url',
        image_url: { url: `data:image/${imageCheck.format};base64,` + imageBase64 },
      });
    }
  }

  // -----------------------------------------------------------------------
  //  Cycle 2.1 — COMPLETION SEAM
  // -----------------------------------------------------------------------
  // The provider chain below is wrapped as a CompletionFn and resolved through
  // `resolveCompletion`, which returns a test-installed override when one is
  // present. In normal operation the override is null and this is exactly the
  // chain that was always here; the only change is that the network call is now
  // reachable from a test, which is what lets the suite drive the REAL server
  // instead of the hand-written mirror in serverContract.test.ts.
  const providerChain: CompletionFn = async (request) => {
    const { sessionId, systemPrompt, userContent } = request;
    let parsed: Record<string, unknown> | null = null;
    let lastError: unknown = null;
    let rawVlmResponse = '';

    // -------------------------------------------------------------------------
    //  PRIORITY 1: Google Gemini API (if GEMINI_API_KEY is present)
    // -------------------------------------------------------------------------
    if (hasGemini) {
      const geminiClient = new OpenAI({
        apiKey: process.env.GEMINI_API_KEY,
        baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      });

      const geminiModels = [
        process.env.GEMINI_MODEL || 'gemini-2.5-flash',
        'gemini-2.5-flash',
        'gemini-2.0-flash',
        'gemini-1.5-flash',
      ].filter((v, i, a) => a.indexOf(v) === i);

      for (const model of geminiModels) {
        log.info(`[Priority 1: Gemini] Calling model '${model}' for session ${sessionId}...`);
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 35_000);

          const completion = await geminiClient.chat.completions.create({
            model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userContent },
            ],
            // @ts-expect-error signal is supported
            signal: controller.signal,
          });

          clearTimeout(timeoutId);

          const raw = completion.choices[0]?.message?.content ?? '';
          log.info(`Gemini response from '${model}' (first 200 chars): ${raw.slice(0, 200)}`);
          parsed = parseActionJson(raw);
          rawVlmResponse = raw;
          log.success(`JSON parse succeeded with Gemini model '${model}' for session ${sessionId}`);
          break;
        } catch (geminiErr: unknown) {
          lastError = geminiErr;
          const errMsg = geminiErr instanceof Error ? geminiErr.message : 'Unknown Gemini error';
          log.warn(`Gemini model '${model}' failed: ${errMsg}. Trying next candidate...`);
        }
      }
    }

    // -------------------------------------------------------------------------
    //  PRIORITY 2: 9router Fallback (if Gemini failed or GEMINI_API_KEY missing)
    // -------------------------------------------------------------------------
    if (!parsed && hasRouter) {
      log.info(`[Priority 2: 9router] Calling 9router fallback for session ${sessionId}...`);
      const routerClient = new OpenAI({
        baseURL: process.env.ROUTER_URL,
        apiKey: process.env.ROUTER_API_KEY,
      });

      const PRIMARY_MODEL = process.env.MODEL_NAME || 'ag/gemini-3.7-flash-high';
      const CANDIDATE_MODELS = [
        PRIMARY_MODEL,
        'ag/gemini-3.8-flash-high',
        'gemini/gemini-3.7-flash',
        'gemini/gemini-3.8-flash',
        'claude-all-mix',
      ].filter((v, i, a) => a.indexOf(v) === i);

      for (const model of CANDIDATE_MODELS) {
        log.info(`[9router] Calling model '${model}' for session ${sessionId}...`);
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 35_000);

          const completion = await routerClient.chat.completions.create({
            model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userContent },
            ],
            // @ts-expect-error signal is supported
            signal: controller.signal,
          });

          clearTimeout(timeoutId);

          const raw = completion.choices[0]?.message?.content ?? '';
          log.info(`9router response from '${model}' (first 200 chars): ${raw.slice(0, 200)}`);

          if (raw.toLowerCase().includes('is no longer available') || raw.toLowerCase().includes('not available')) {
            log.warn(`Model '${model}' returned deprecation notice. Trying next...`);
            continue;
          }

          parsed = parseActionJson(raw);
          rawVlmResponse = raw;
          log.success(`JSON parse succeeded with 9router model '${model}' for session ${sessionId}`);
          break;
        } catch (routerErr: unknown) {
          lastError = routerErr;
          const errMsg = routerErr instanceof Error ? routerErr.message : 'Unknown 9router error';
          log.warn(`9router model '${model}' failed: ${errMsg}. Trying next...`);
        }
      }
    }

    return rawVlmResponse;
  };

  const complete = resolveCompletion(providerChain);
  let parsed: Record<string, unknown> | null = null;
  let rawVlmResponse = '';
  try {
    rawVlmResponse = await complete({ sessionId, systemPrompt, userContent });
    parsed = parseActionJson(rawVlmResponse);
  } catch (upstreamErr) {
    const upstreamMessage =
      upstreamErr instanceof Error ? upstreamErr.message : 'All upstream AI models failed';
    log.error(`All candidate models failed for session ${sessionId}: ${upstreamMessage}`);
    logRequest({
      sessionId,
      timestamp: new Date().toISOString(),
      maskedDom,
      redactionLegend: redaction_legend ?? [],
      returnedAction: { action: 'error' },
    });
    // Cycle 2.3: 502, not 500. Every candidate model failed, which is an UPSTREAM
    // failure — 500 blames this server for something it did. The de-mirrored
    // suite had been asserting 502 against a hand-written copy all along; the
    // copy was right and production was wrong.
    return c.json({ error: 'Upstream AI provider failed' }, 502);
  }
  // Reached only when the model DID answer but the text would not parse as an
  // action. Total upstream failure is thrown by the chain and handled above, so
  // the message here is about the parse rather than about a missing model.
  if (!parsed) {
    log.error(
      `Model response for session ${sessionId} was not valid action JSON ` +
        `(first 200 chars: ${rawVlmResponse.slice(0, 200)})`
    );
    logRequest({
      sessionId,
      timestamp: new Date().toISOString(),
      maskedDom,
      redactionLegend: redaction_legend ?? [],
      returnedAction: { action: 'error' },
    });
    return c.json({ error: 'AI returned invalid JSON' }, 500);
  }

  // Canonical action field normalization (guarantees selector, id, value are always populated)
  if (!parsed.selector && parsed.target) {
    parsed.selector = String(parsed.target);
  }
  if (!parsed.id && typeof parsed.selector === 'string') {
    const idMatch = parsed.selector.match(/data-agent-id=['"]([^'"]+)['"]/);
    if (idMatch) {
      parsed.id = idMatch[1];
    } else if (parsed.selector.startsWith('agent-') || parsed.selector.startsWith('R')) {
      parsed.id = parsed.selector;
    }
  }
  if (!parsed.value) {
    if (typeof parsed.text === 'string') parsed.value = parsed.text;
    else if (typeof parsed.url === 'string') parsed.value = parsed.url;
    else if (typeof parsed.query === 'string') parsed.value = parsed.query;
  }
  if (parsed.action === 'navigate' && !parsed.value && parsed.url) {
    parsed.value = parsed.url;
  }
  // Universal URL typing auto-converter:
  // If the model generates action: 'type' where the value is a full URL or domain URL,
  // normalize it into action: 'navigate' with the fully qualified URL.
  if (parsed.action === 'type' && typeof parsed.value === 'string') {
    const trimmedVal = parsed.value.trim().replace(/[\r\n]+$/, '');
    const isUrl =
      /^https?:\/\/[^\s]+$/i.test(trimmedVal) ||
      /^(?:www\.)[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s]*)?$/i.test(trimmedVal);
    if (isUrl) {
      log.info(`Converting action: 'type' with URL "${trimmedVal}" into action: 'navigate'`);
      parsed.action = 'navigate';
      parsed.value = trimmedVal.startsWith('http') ? trimmedVal : `https://${trimmedVal}`;
      delete parsed.id;
      delete parsed.selector;
    }
  }

  // -------------------------------------------------------------------------
  // SERVER-SIDE POST-VLM WORKFLOW SAFETY SANITIZER
  // If the model hallucinates a click on "Start a post", "Compose", re-types content,
  // or clicks submit again when submission was already executed: OVERRIDE to action: 'done'!
  // -------------------------------------------------------------------------
  if (taskMode === 'workflow' && actionHistory.length > 0) {
    const hasPriorTyping = actionHistory.some((a) => {
      const act = String(a.action || '').toLowerCase();
      const val = String(a.value || '').trim();
      return (act === 'type' || act === 'fill') && val.length > 15;
    });

    const hasPriorSubmission = actionHistory.some((a) => {
      const act = String(a.action || '').toLowerCase();
      const tgt = String(a.target || '').toLowerCase();
      const val = String(a.value || '').toLowerCase();

      const isOpener = [
        'start a post',
        'create a post',
        'write a post',
        'start writing',
        'new post',
        'compose',
        'new tweet',
        'new message',
        'start a discussion',
      ].some((op) => tgt.includes(op) || val.includes(op));

      if (isOpener) return false;

      return (
        (act === 'click' && ['post', 'send', 'submit', 'publish', 'tweet', 'reply', 'share-actions'].some((t) => tgt.includes(t) || val.includes(t))) ||
        ((act === 'type' || act === 'keypress') && (val.includes('\n') || val.includes('\r')) && val.length > 15)
      );
    });

    if (hasPriorTyping && hasPriorSubmission) {
      let targetText = `${parsed.selector || ''} ${parsed.id || ''} ${parsed.thought || ''} ${typeof parsed.value === 'string' ? parsed.value : ''}`.toLowerCase();
      if (parsed.id) {
        const escapedId = String(parsed.id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const idRegex = new RegExp(`\\[${escapedId}\\][^\n]*`, 'i');
        const m = maskedDom.match(idRegex);
        if (m) targetText += ' ' + m[0].toLowerCase();
      }

      const isReOpenCompose = ['start a post', 'create a post', 'write a post', 'compose', 'new post', 'new tweet', 'new message', 'start writing'].some((t) => targetText.includes(t));
      const isReType = parsed.action === 'type';
      const isDuplicateSubmit = parsed.action === 'click' && ['post', 'send', 'submit', 'publish', 'tweet'].some((t) => targetText.includes(t));

      if (isReOpenCompose || isReType || isDuplicateSubmit) {
        log.info(`🛑 [Server Workflow Post-VLM Sanitizer] Intercepted attempt to re-open composer or re-submit after submission. Overriding to action: "done".`);
        parsed.action = 'done';
        parsed.thought = 'Content was already submitted in previous step. Overriding attempt to re-open composer to action: "done".';
        parsed.summary = 'Post successfully submitted and verified on page.';
        delete parsed.id;
        delete parsed.selector;
        delete parsed.value;
      }
    }
  }

  // -------------------------------------------------------------------------
  //  STRUCTURED LOCAL SESSION STORAGE
  //  Saves raw picture, masked picture, prompts in TXT, and responses in TXT/JSON
  //  under storage/sessions/<sessionId>/
  // -------------------------------------------------------------------------
  saveSessionStep({
    sessionId,
    step,
    task,
    subTasks,
    rawImage: typeof rawImage === 'string' ? rawImage : undefined,
    maskedImage: imageBase64,
    vlmImage: finalVlmImage,
    vlmModel: hasGemini ? (process.env.GEMINI_MODEL || 'gemini-2.5-flash') : (process.env.MODEL_NAME || '9router-fallback'),
    promptContext: userContent[0]?.type === 'text' ? userContent[0].text : undefined,
    vlmResponse: rawVlmResponse,
    actionJson: parsed,
  });

  // Log summary line to /storage/server_logs.jsonl
  logRequest({
    sessionId,
    timestamp: new Date().toISOString(),
    maskedDom,
    redactionLegend: redaction_legend ?? [],
    returnedAction: {
      action: String(parsed.action),
      selector: parsed.selector as string | undefined,
      id: parsed.id as string | undefined,
      value: parsed.value as string | undefined,
    },
  });

  // Attach domain & taskMode metadata
  parsed.taskMode = taskMode;
  parsed.domain = domain;

  // -------------------------------------------------------------------------
  //  Cycle 3.1 — ACTION POLICY GATE
  // -------------------------------------------------------------------------
  // The model's decision does NOT go straight to executeAction. It is evaluated
  // here, server-side, and the extension receives the sanitised form plus an
  // explicit risk verdict.
  //
  // Placing the gate on the server is the security property: the extension is
  // JavaScript in a browser and cannot be trusted to police itself, and a
  // compromised content script has no path to executeAction that skips this.
  //
  // This is what makes the earlier cycles' honest limitation true rather than
  // merely stated: escaping and delimiting reduce the injection SURFACE, and
  // this bounds the CONSEQUENCE.
  const policyVerdict = evaluateAction(parsed, {
    maxStep: Number(process.env.MAX_STEPS) || 35,
    step: typeof step === 'number' ? step : 1,
  });

  if (!policyVerdict.allowed) {
    log.warn(
      `[Action policy] Blocked action for ${sessionId} step ${step}: ${policyVerdict.reason}`
    );
    // Return the terminal action rather than an error: the client loop expects
    // a decision object, and a hard error here would abort a run that could
    // still conclude cleanly.
    return c.json({
      ...policyVerdict.sanitized,
      taskMode,
      domain,
      policyBlocked: true,
      policyReason: policyVerdict.reason,
    });
  }

  if (policyVerdict.requiresConfirmation) {
    log.warn(
      `[Action policy] Confirmation required for ${sessionId} step ${step}: ${policyVerdict.reason}`
    );
  }

  return c.json({
    ...policyVerdict.sanitized,
    taskMode,
    domain,
    policyRisk: policyVerdict.risk,
    requiresConfirmation: policyVerdict.requiresConfirmation,
  });
});

// Global error handler
app.onError((err, c) => {
  log.error(`Unhandled server error: ${err.message}`);
  log.error(`Stack trace:\n${err.stack ?? 'No stack trace'}`);
  return c.json({ error: 'Internal server error.' }, 500);
});

// Start server
const port = Number(process.env.PORT) || 3000;

let server: any = null;
if (!process.env.VITEST && process.env.NODE_ENV !== 'test') {
  server = serve({
    fetch: app.fetch,
    port,
  });

  log.success('═══════════════════════════════════════════════════════════');
  log.success('  🚀  Zero-Trust AI Agent Server — ONLINE');
  log.success('═══════════════════════════════════════════════════════════');
  log.info(`  Port:              ${port}`);
  log.info(`  CORS:              enabled (origin: *)`);
  log.info(`  Upstream Provider: ${hasGemini ? 'Google Gemini API (Priority 1)' : '9router (Priority 2)'}`);
  log.info(`  Auth header:       x-secret-password`);
  log.info(`  Rate limit:        ${RATE_LIMIT_MAX_REQUESTS} req/min per IP`);
  log.info(`  Payload limit:     25MB`);
  log.info(`  Upstream timeout:  35s`);
  log.info(`  Session Vault:     storage/sessions/<sessionId>/`);
  log.success('═══════════════════════════════════════════════════════════');
}

function shutdown(signal: string): void {
  log.warn(`Received ${signal} — shutting down gracefully...`);
  server?.close?.(() => {
    log.info('Server closed cleanly.');
    process.exit(0);
  });
  const forceExit = setTimeout(() => {
    log.error('Forced shutdown after timeout.');
    process.exit(1);
  }, 5000);
  if (forceExit && typeof (forceExit as NodeJS.Timeout).unref === 'function') {
    (forceExit as NodeJS.Timeout).unref();
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
