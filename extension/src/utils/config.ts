/**
 * Agent configuration — Cycle 2.4 (client half) / Cycle 2.2
 * ---------------------------------------------------------------------------
 * The server no longer accepts the hardcoded `x-secret-password`. The extension
 * must therefore hold a server URL and a TOKEN in browser storage and present
 * `Authorization: Bearer <token>`.
 *
 * The property that matters most: with EMPTY storage the extension is UNPAIRED
 * and must make no request at all. A bundled fallback — a default token, a
 * default secret — would restore exactly the public literal that Cycle 2.4
 * exists to remove, just one layer down. So the empty case returns an invalid
 * config rather than a usable one, and the background refuses to send.
 *
 * WHY LOOPBACK ONLY
 * This agent exists to drive a local server. Allowing an arbitrary host would
 * mean a typo, or a hand-edited storage value, silently shipping browsing data
 * and screenshots off the machine. The check compares the parsed hostname
 * against an exact set, so `evil-127.0.0.1.example.com` and
 * `127.0.0.1.evil.com` are both rejected — a substring or endsWith check would
 * wave both through.
 *
 * WHY BROWSER STORAGE, NOT wxt/storage
 * `wxt/storage` is used nowhere in this repo, `extension/vitest.config.mjs`
 * loads no setup file, and it would couple the unit tests to WXT internals. A
 * thin wrapper over `browser.storage.local` is explicit and directly testable
 * against the harness in tests/setup/setupExtensionMock.ts.
 *
 * Pure where it can be: the validation functions take a value and return a
 * verdict, with no storage access, so they are testable in isolation.
 */
import { browser } from 'wxt/browser';

export interface AgentConfig {
  serverUrl: string;
  token: string;
}

export const DEFAULT_SERVER_URL = 'http://127.0.0.1:3000';

const STORAGE_KEY = 'agentConfig';

/** Exact host allowlist. No suffix or substring matching. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** A JWT is three base64url segments; a minimum length rejects obvious junk. */
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const MIN_TOKEN_LENGTH = 40;

/**
 * True only for an http(s) URL whose hostname is exactly loopback.
 *
 * Credentials embedded in the URL are rejected outright: `http://user:pass@…`
 * parses such that the real host is not necessarily the one being checked.
 */
export function isAllowedServerUrl(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username.length > 0 || url.password.length > 0) return false;

  return LOOPBACK_HOSTS.has(url.hostname);
}

export function isValidToken(token: unknown): boolean {
  return (
    typeof token === 'string' &&
    token.length >= MIN_TOKEN_LENGTH &&
    JWT_SHAPE.test(token)
  );
}

export function isValidConfig(config: Partial<AgentConfig> | null | undefined): boolean {
  if (!config) return false;
  return isAllowedServerUrl(config.serverUrl ?? '') && isValidToken(config.token);
}

/**
 * Build the outbound auth header.
 *
 * Returns an EMPTY object when unpaired, so a caller can skip the request
 * rather than send a malformed one. The legacy `x-secret-password` header is
 * never produced.
 */
export function authHeadersFor(config: Partial<AgentConfig> | null | undefined): Record<string, string> {
  if (!isValidConfig(config)) return {};
  return { Authorization: `Bearer ${(config as AgentConfig).token}` };
}

export interface ResolvedConfig extends AgentConfig {
  valid: boolean;
}

const EMPTY: ResolvedConfig = { serverUrl: '', token: '', valid: false };

/** Read the stored config. Empty storage yields an INVALID config, not a default. */
export async function getAgentConfig(): Promise<ResolvedConfig> {
  try {
    const stored = (await browser.storage.local.get(STORAGE_KEY)) as Record<string, unknown>;
    const raw = stored?.[STORAGE_KEY] as Partial<AgentConfig> | undefined;
    if (!raw || typeof raw !== 'object') return { ...EMPTY };

    const config: AgentConfig = {
      serverUrl: typeof raw.serverUrl === 'string' ? raw.serverUrl : '',
      token: typeof raw.token === 'string' ? raw.token : '',
    };

    return { ...config, valid: isValidConfig(config) };
  } catch {
    return { ...EMPTY };
  }
}

/**
 * Persist a config, refusing anything invalid.
 *
 * Rejecting at write time means a bad value surfaces while the operator is
 * looking at the Options page, not later as a mysteriously unauthenticated
 * request.
 */
export async function setAgentConfig(config: AgentConfig): Promise<boolean> {
  if (!isValidConfig(config)) return false;
  try {
    await browser.storage.local.set({ [STORAGE_KEY]: { serverUrl: config.serverUrl, token: config.token } });
    return true;
  } catch {
    return false;
  }
}

export async function clearAgentConfig(): Promise<void> {
  try {
    await browser.storage.local.remove(STORAGE_KEY);
  } catch {
    // Nothing to do: an unremovable value will fail validation on read anyway.
  }
}
