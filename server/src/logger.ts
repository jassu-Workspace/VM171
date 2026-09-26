/**
 * Server logging — Cycle 1.8 (observability without content leakage)
 * ---------------------------------------------------------------------------
 * Two problems, both about the same thing: logs are durable, widely-readable
 * copies of exactly the material this project exists to keep local.
 *
 * 1. STDOUT/STDERR — the request logger, payload-size log, step log and the
 *    degradation warnings touch the user's task text, the masked DOM, base64
 *    image prefixes, the auth secret, and provider error strings (which
 *    routinely echo request fragments back). That output lands in
 *    server_out.log / server_err.log and from there into any CI job or shell
 *    scrollback that captures it.
 *
 * 2. DISK — `logRequest` wrote the FULL `maskedDom` and the agent's typed
 *    `returnedAction.value` into storage/server_logs.jsonl on every step.
 *    Client-side redaction is not a defence here: this runs in the server
 *    process, and any caller holding the shared secret can post arbitrary text.
 *
 * The policy: log LENGTHS, COUNTS and STATES. Never content, never secrets.
 *
 * createRedactor() is pure and returns a reusable transform. It redacts:
 *   - every registered secret / API key, all occurrences
 *   - unregistered but key-shaped tokens (sk-, JWTs, private-key headers)
 *   - long base64 runs, replaced by a `[base64:N chars]` marker that preserves
 *     the operational signal while destroying the payload
 * Short ordinary identifiers are left alone so logs stay useful.
 */
import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve /storage relative to the server project root (the parent of /src).
const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, '..', '..');
const STORAGE_DIR_REL = join(__dirname, '..', 'storage');
const LOG_FILE = join(STORAGE_DIR_REL, 'server_logs.jsonl');

export const REDACTED = '[REDACTED]';

// Key-shaped tokens that must be redacted even when never registered here,
// because a provider error string or a header dump can carry one.
const KEY_SHAPED_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bAIza[A-Za-z0-9_-]{20,}/g,
  /\bghp_[A-Za-z0-9]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // The END marker is OPTIONAL on purpose: a private key that reaches a log
  // line is very often truncated (head -c, an error message, a wrapped
  // payload). Requiring both markers would leak exactly the fragment most
  // likely to be logged.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----)?/g,
];

// A long unbroken base64-ish run. The threshold is deliberately high so short
// identifiers (session ids, hashes, "abc123") are never mangled.
const BASE64_RUN = /[A-Za-z0-9+/]{80,}={0,2}/g;

export type Redactor = (input: string) => string;

/**
 * Build a redactor bound to a set of known secret values.
 *
 * Secrets are matched literally, longest first, so a short secret that happens
 * to be a substring of a longer one cannot partially rewrite the longer one.
 * Empty / non-string entries are ignored — registering `''` would otherwise
 * match everywhere and turn the whole log into one marker.
 */
export function createRedactor(secrets: Record<string, string | undefined>): Redactor {
  const literals = Object.values(secrets ?? {})
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    // Longest first: prevents a short secret from corrupting a longer match.
    .sort((a, b) => b.length - a.length)
    .map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

  return function redact(input: string): string {
    if (typeof input !== 'string' || input.length === 0) return '';

    let out = input;

    for (const literal of literals) {
      if (literal.length === 0) continue;
      out = out.replace(new RegExp(literal, 'g'), REDACTED);
    }

    for (const pattern of KEY_SHAPED_PATTERNS) {
      pattern.lastIndex = 0;
      out = out.replace(pattern, REDACTED);
    }

    out = out.replace(BASE64_RUN, (match) => `[base64:${match.length} chars]`);

    return out;
  };
}

/**
 * Process-wide redactor. Registered lazily so the module can be imported by
 * tests before any environment exists.
 */
let processRedactor: Redactor | null = null;
export function setRedactor(redact: Redactor): void {
  processRedactor = redact;
}
export function redactForLog(input: string): string {
  return processRedactor ? processRedactor(input) : input;
}

export type LogFormat = 'json' | 'pretty';
export type LogLevel = 'info' | 'success' | 'warn' | 'error';

let currentLogFormat: LogFormat | null = null;

export function getLogFormat(): LogFormat {
  if (currentLogFormat) return currentLogFormat;
  const envVal = (process.env.LOG_FORMAT ?? '').trim().toLowerCase();
  if (envVal === 'json') return 'json';
  if (envVal === 'pretty' || envVal === '') return 'pretty';
  console.warn(`[logger] Unrecognized LOG_FORMAT="${process.env.LOG_FORMAT}". Defaulting to "pretty".`);
  return 'pretty';
}

export function setLogFormat(format: LogFormat | null): void {
  currentLogFormat = format;
}

const LOG_COLORS = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

export function formatLogEntry(level: LogLevel, msg: string, format: LogFormat = getLogFormat()): string {
  const cleanMsg = redactForLog(msg);
  if (format === 'json') {
    return JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message: cleanMsg,
    });
  }

  const ts = new Date().toISOString();
  switch (level) {
    case 'info':
      return `${LOG_COLORS.cyan}[${ts}] ℹ INFO${LOG_COLORS.reset}  ${cleanMsg}`;
    case 'success':
      return `${LOG_COLORS.green}[${ts}] ✔ SUCCESS${LOG_COLORS.reset} ${cleanMsg}`;
    case 'warn':
      return `${LOG_COLORS.yellow}[${ts}] ⚠ WARN${LOG_COLORS.reset}  ${cleanMsg}`;
    case 'error':
      return `${LOG_COLORS.red}[${ts}] ✖ ERROR${LOG_COLORS.reset} ${cleanMsg}`;
  }
}

export const log = {
  info(msg: string): void {
    console.log(formatLogEntry('info', msg));
  },
  success(msg: string): void {
    console.log(formatLogEntry('success', msg));
  },
  warn(msg: string): void {
    console.warn(formatLogEntry('warn', msg));
  },
  error(msg: string): void {
    console.error(formatLogEntry('error', msg));
  },
};

/** What we persist about a step. Content is summarised, never stored. */
export interface ServerLogRecord {
  sessionId: string;
  timestamp: string;
  /**
   * @deprecated Accepted for call-site compatibility but NEVER persisted.
   * Only derived statistics are written. See `maskedDomChars`.
   */
  maskedDom?: string;
  maskedDomChars?: number;
  redactionLegend: Array<{ id: string; type: string; bbox: number[] }>;
  returnedAction: { action: string; selector?: string; id?: string; value?: string };
  /** Optional Cycle 1.4 provenance. */
  redactionState?: string;
}

export interface PersistedLogRecord {
  sessionId: string;
  timestamp: string;
  maskedDomChars: number;
  redactionCount: number;
  redactionTypes: string[];
  returnedAction: { action: string; selector?: string; id?: string; valueChars?: number };
  redactionState?: string;
}

/**
 * Reduce a record to statistics only.
 *
 * The page text and the agent's typed value are replaced by their LENGTHS. That
 * is all an operator needs to operate the system — which step ran, how much
 * context it had, how much it typed — and none of it is the content itself.
 */
export function toPersistedRecord(record: ServerLogRecord): PersistedLogRecord {
  const maskedDomChars = record.maskedDomChars ?? record.maskedDom?.length ?? 0;
  const action = record.returnedAction ?? { action: 'unknown' };

  const persisted: PersistedLogRecord = {
    sessionId: record.sessionId,
    timestamp: record.timestamp,
    maskedDomChars,
    redactionCount: record.redactionLegend?.length ?? 0,
    redactionTypes: Array.from(new Set((record.redactionLegend ?? []).map((r) => r.type))),
    returnedAction: {
      action: action.action,
      ...(action.selector ? { selector: action.selector } : {}),
      ...(action.id ? { id: action.id } : {}),
      ...(typeof action.value === 'string' ? { valueChars: action.value.length } : {}),
    },
  };

  if (record.redactionState) {
    persisted.redactionState = record.redactionState;
  }

  return persisted;
}

/** Append a JSON-lines entry. Degrades gracefully; never throws upward. */
export function logRequest(record: ServerLogRecord): void {
  try {
    if (!existsSync(STORAGE_DIR_REL)) {
      mkdirSync(STORAGE_DIR_REL, { recursive: true });
    }
    const safe = toPersistedRecord(record);
    appendFileSync(LOG_FILE, JSON.stringify(safe) + '\n', { encoding: 'utf8' });
  } catch (err) {
    // Never break the request pipeline — swallow storage errors.
    console.warn('[serverLogger] storage write failed:', err instanceof Error ? err.message : err);
  }
}
