/**
 * Origin allowlist — Cycle 2.5 (audit finding #3, CRITICAL)
 * ---------------------------------------------------------------------------
 * The server used `cors({ origin: '*' })` and authenticated with a shared
 * secret that was hardcoded in the extension bundle. Together: any webpage the
 * operator visited could pass preflight and POST to `http://localhost:3000` with
 * the public secret, making an agent holding `<all_urls>` + `scripting` click
 * and type on any site they had logged into. `/api/system-telemetry` was
 * readable the same way, exposing a host fingerprint.
 *
 * This is the control that matters, and it is deliberately NOT CORS:
 *
 *   CORS only constrains browsers that opt in to honouring it. A server-side
 *   `Origin` check holds regardless of what the client claims to be, and also
 *   covers non-browser callers. CORS remains as a secondary, correct layer.
 *
 * Design decisions:
 *   - EXACT MATCH. No prefix matching, no case folding, no trailing-slash
 *     normalisation. `chrome-extension://id` and `chrome-extension://id/` are
 *     different strings, and only an exact allowlist entry should pass.
 *   - NO ORIGIN = ALLOWED THROUGH TO AUTH. curl, the test runner and Playwright
 *     send no Origin; blocking them would break legitimate local tooling for no
 *     security gain, and the secret still gates them.
 *   - PREFLIGHT IS NOT EVALUATED. Rejecting OPTIONS would mean the extension
 *     can never call the server — a functional break, not a security win.
 *   - ORIGIN IS CHECKED BEFORE AUTH, so a rejection cannot be used to probe
 *     whether a guessed secret was close.
 */
import type { Context, Next } from 'hono';

export const DEFAULT_ALLOWED_ORIGINS: readonly string[] = [
  // The real, PINNED extension id (see extension/wxt.config.ts `key`).
  // This used to be the literal 'chrome-extension://test-extension-id', which
  // matched nothing: originGuard rejected every real extension request with a
  // 403 before authentication, so the product was non-functional by default.
  // The unit tests passed because they asserted that placeholder against itself.
  'chrome-extension://fidbnhfgcadfpjlmdfpnngikjpdhcdcf',
  'http://localhost:3300',
  'http://localhost:3000',
];

/**
 * Parse a comma-separated allowlist. Entries are trimmed and empties dropped;
 * nothing is lowercased or otherwise normalised, because normalisation is how
 * allowlists grow holes.
 */
export function parseAllowedOrigins(raw: string | undefined | null): Set<string> {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return new Set(DEFAULT_ALLOWED_ORIGINS);
  }
  return new Set(
    raw
      .split(',')
      .map((o) => o.trim())
      .filter((o) => o.length > 0)
  );
}

export function isOriginAllowed(origin: string, allowed: ReadonlySet<string>): boolean {
  return allowed.has(origin);
}

/**
 * Hono middleware enforcing the allowlist.
 *
 * Must be registered BEFORE the CORS and auth middleware, so that a disallowed
 * origin is refused before any credential is examined.
 */
export function originGuard(allowed: ReadonlySet<string>) {
  // The return type is `Response | void`, not `void`: a middleware that
  // short-circuits must RETURN the Response. An earlier version annotated this
  // `Promise<void>` and used `await c.json(...)`, which does not finalise the
  // context — every rejection surfaced as 500 "Context is not finalized"
  // instead of 403. The compiler caught the inconsistency when `strict` and a
  // working tsconfig arrived, which is precisely the class of mistake it
  // exists to prevent.
  return async function originGuardMiddleware(
    c: Context,
    next: Next
  ): Promise<Response | void> {
    if (c.req.method === 'OPTIONS') {
      await next();
      return;
    }

    const origin = c.req.header('origin');

    // No Origin: a non-browser caller (curl, the test runner, Playwright).
    // Authentication still applies downstream.
    if (!origin) {
      await next();
      return;
    }

    if (!isOriginAllowed(origin, allowed)) {
      // Deliberately does not echo the rejected origin back into the body.
      // RETURNING the Response is what short-circuits the chain in Hono —
      // awaiting c.json() alone leaves the context unfinalised and produces a
      // 500 "Context is not finalized" instead of a 403.
      return c.json({ error: 'Origin not allowed.' }, 403);
    }

    await next();
  };
}
