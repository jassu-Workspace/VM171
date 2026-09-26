/**
 * Cycle 1.8 — Observability that cannot leak the content it observes.
 * ---------------------------------------------------------------------------
 * The logging surface currently includes the request logger, the payload-size
 * log, the step log, and the degradation warnings added in Cycles 1.2-1.4.
 * Between them they touch: the user's task text, the masked DOM, base64 image
 * prefixes, the auth secret, and provider error strings (which routinely echo
 * request fragments back).
 *
 * That data goes to stdout, into `server_out.log` / `server_err.log`, and from
 * there into any CI job or shell scrollback that captures it. A log line is a
 * durable, widely-readable copy of exactly the material the whole project
 * exists to keep local.
 *
 * The redaction pipeline is not a defence here: `log.info` runs in the server
 * process, downstream of the content script's client-side masking, and any
 * caller with the shared secret can post arbitrary text.
 *
 * Policy enforced by these tests:
 *   - register secrets and API keys; they must never appear in output
 *   - never log page content, masked DOM, or base64 image prefixes
 *   - DO log lengths, counts and states, which is all that is needed to operate
 *   - provider error strings are redacted before they reach a log line
 *
 * Breaks caught here:
 *   - a secret reaching a log line
 *   - a base64 payload fragment reaching a log line
 *   - a provider error echoing request content into logs
 *   - redaction being so aggressive that operational logging stops working
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRedactor, REDACTED } from '../../server/src/logger';

describe('Cycle 1.8 — secret redaction', () => {
  let redact: (input: string) => string;

  beforeEach(() => {
    redact = createRedactor({
      SECRET_PASSWORD: '141207',
      GEMINI_API_KEY: 'AIzaSyD-super-secret-key-value',
      ROUTER_API_KEY: 'sk-0routerkey1234567890',
    });
  });

  it('replaces a registered secret with a redaction marker', () => {
    // BREAK: the auth secret appearing in stdout / server_out.log.
    expect(redact('auth header x-secret-password: 141207')).toContain(REDACTED);
  });

  it('replaces a registered API key', () => {
    // BREAK: a live Gemini or router key in a log file.
    const out = redact('calling model with AIzaSyD-super-secret-key-value');
    expect(out).toContain(REDACTED);
    expect(out).not.toContain('AIzaSyD-super-secret-key-value');
  });

  it('replaces every occurrence, not just the first', () => {
    // BREAK: a secret repeated in one line surviving after the first redaction.
    const out = redact('141207 and then 141207 again');
    expect(out).not.toContain('141207');
  });

  it('redacts secrets of differing lengths in one pass', () => {
    // BREAK: a length-sorted or single-pass implementation missing shorter keys.
    const out = redact('sk-0routerkey1234567890 / 141207');
    expect(out).not.toContain('sk-0routerkey1234567890');
    expect(out).not.toContain('141207');
  });

  it('leaves non-secret operational text intact', () => {
    // BREAK: over-redaction making the logs useless. Operators need to see
    // which route, which step, which state.
    const msg = 'Step 4 -> POST /api/step 200 in 812ms redaction=degraded';
    expect(redact(msg)).toBe(msg);
  });

  it('handles an empty string', () => {
    expect(redact('')).toBe('');
  });

  it('tolerates being given no secrets to redact', () => {
    // BREAK: crashing when no secrets are configured, e.g. in tests.
    const bare = createRedactor({});
    expect(bare('anything at all')).toBe('anything at all');
  });

  it('ignores empty and non-string secret values', () => {
    // BREAK: an empty registered value matching everywhere and turning the
    // entire log into one redaction marker.
    const messy = createRedactor({ A: '', B: undefined as unknown as string });
    expect(messy('normal text')).toBe('normal text');
  });
});

describe('Cycle 1.8 — content leakage guards', () => {
  let redact: (input: string) => string;

  beforeEach(() => {
    redact = createRedactor({ SECRET_PASSWORD: '141207' });
  });

  it('strips a long base64 image prefix', () => {
    // BREAK: the first N chars of a screenshot frame in the log. A prefix is
    // enough to reconstruct a thumbnail for small images.
    const b64 = 'A'.repeat(400) + 'ENDOFIMAGE';
    const out = redact(`frame=${b64}`);
    expect(out).not.toContain('ENDOFIMAGE');
    expect(out).toMatch(/\[base64:[0-9]+ chars\]/);
  });

  it('reports the length rather than the content of a base64 payload', () => {
    // BREAK: losing the operational signal along with the content.
    const b64 = 'B'.repeat(120);
    const out = redact(`frame=${b64}`);
    expect(out).toContain('[base64:120 chars]');
  });

  it('does not strip a short ordinary token that merely looks base64-ish', () => {
    // BREAK: over-eager base64 detection mangling normal identifiers.
    expect(redact('session abc123')).toBe('session abc123');
  });

  it('redacts an API-key-shaped token even when unregistered', () => {
    // BREAK: relying only on registered secrets. An unregistered key in an
    // error string would otherwise sail through.
    const out = redact('provider rejected sk-proj-abcdefghij0123456789');
    expect(out).not.toContain('sk-proj-abcdefghij0123456789');
  });

  it('redacts a JWT-shaped token even when unregistered', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const out = redact(`auth was ${jwt}`);
    expect(out).not.toContain(jwt);
  });

  it('redacts a private key header even when unregistered', () => {
    const out = redact('-----BEGIN RSA PRIVATE KEY-----\nMIIEow==');
    expect(out).not.toContain('BEGIN RSA PRIVATE KEY');
  });
});

export {};
