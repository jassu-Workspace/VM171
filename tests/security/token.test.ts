/**
 * Cycle 2.4 — Locally-issued JWT authentication, replacing the shared password.
 * ---------------------------------------------------------------------------
 * WHY THIS SHAPE
 *
 * The task list said "per-user JWT". This is a SINGLE-OPERATOR local tool: one
 * extension, one loopback server. A user database, password resets and a
 * multi-tenant session store would be ceremony around a problem that does not
 * exist here. What the shared secret genuinely lacked is not identity — it is
 * EXPIRY, REVOCATION and SCOPE, and all three come free with a signed token.
 *
 * So: HS256, issued locally, no account system.
 *
 *   1. Server generates a random signing key on first boot (never committed).
 *   2. It prints a one-time PAIRING CODE to the operator's console.
 *   3. The extension exchanges that code at POST /api/auth/pair for a signed,
 *      short-lived token, which it stores in chrome.storage.local.
 *   4. Every API call presents `Authorization: Bearer <jwt>`.
 *
 * The property that actually matters: the credential is no longer a PUBLIC
 * LITERAL. `141207` shipped inside the extension bundle and was readable by
 * anyone who unpacked it. A per-process random key cannot be.
 *
 * WHAT THIS DOES NOT FIX, stated plainly
 * Cycle 2.5's origin allowlist is still half a fix on its own, because an
 * attacker with the bundle could read the old secret. This cycle is the other
 * half. Neither is sufficient alone; together they are.
 *
 * Pure module: no Hono, no database, no clock of its own. `now` is injected so
 * expiry is testable without sleeping.
 */
import { describe, it, expect } from 'vitest';
import {
  issueToken,
  verifyToken,
  generateSigningKey,
  generatePairingCode,
  isPairingCodeValid,
  TokenError,
  type TokenClaims,
} from '../../server/src/token';

const KEY = generateSigningKey();
const NOW = 1_700_000_000_000; // fixed ms epoch
const OTHER_KEY = generateSigningKey();

const AUDIENCE = 'ztai-agent';

describe('Cycle 2.4 — signing keys and pairing codes', () => {
  it('generates a 256-bit signing key', () => {
    // BREAK: a short or predictable key. 32 bytes = 256 bits, base64url of
    // 32 bytes is 43 characters with no padding.
    expect(KEY).toHaveLength(43);
    expect(KEY).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('generates a distinct key each time', () => {
    expect(generateSigningKey()).not.toBe(generateSigningKey());
  });

  it('generates a pairing code long enough to resist brute force', () => {
    // BREAK: a 4- or 6-digit code, which is trivially guessable from a browser
    // given the origin guard is the only thing slowing an attacker down.
    const code = generatePairingCode();
    expect(code.length).toBeGreaterThanOrEqual(20);
  });

  it('accepts a correct pairing code', () => {
    const code = generatePairingCode();
    expect(isPairingCodeValid(code, code)).toBe(true);
  });

  it('rejects an incorrect pairing code', () => {
    expect(isPairingCodeValid('wrong-code-entirely', generatePairingCode())).toBe(false);
  });

  it('rejects a pairing code check when no code is configured', () => {
    // BREAK: an unpaired server accepting an empty submitted code.
    expect(isPairingCodeValid('', '')).toBe(false);
    expect(isPairingCodeValid('anything', undefined)).toBe(false);
  });
});

describe('Cycle 2.4 — issuing a token', () => {
  it('produces a three-segment JWT', () => {
    // BREAK: a non-JWT format sneaking through.
    const token = issueToken({ key: KEY, subject: 'local-operator', audience: AUDIENCE, ttlMs: 60_000, now: NOW });
    expect(token.split('.')).toHaveLength(3);
  });

  it('round-trips the subject and audience', () => {
    const token = issueToken({ key: KEY, subject: 'local-operator', audience: AUDIENCE, ttlMs: 60_000, now: NOW });
    const claims = verifyToken(token, { key: KEY, audience: AUDIENCE, now: NOW });
    expect(claims.sub).toBe('local-operator');
    expect(claims.aud).toBe(AUDIENCE);
  });

  it('sets an expiry in the future', () => {
    // JWT temporal claims are SECONDS since epoch (RFC 7519), not
    // milliseconds. An earlier version of this test compared `exp` against a
    // millisecond `now` and failed by a factor of 1000 — the implementation
    // was correct and the assertion was not.
    const token = issueToken({ key: KEY, subject: 'op', audience: AUDIENCE, ttlMs: 60_000, now: NOW });
    const claims = verifyToken(token, { key: KEY, audience: AUDIENCE, now: NOW });
    expect(claims.iat).toBe(Math.floor(NOW / 1000));
    expect(claims.exp).toBe(Math.floor(NOW / 1000) + 60);
    expect(claims.exp).toBeGreaterThan(Math.floor(NOW / 1000));
  });

  it('gives every token a distinct id so revocation is possible', () => {
    // BREAK: two tokens issued in the same second being byte-identical, which
    // would make per-token revocation meaningless.
    const a = issueToken({ key: KEY, subject: 'op', audience: AUDIENCE, ttlMs: 60_000, now: NOW });
    const b = issueToken({ key: KEY, subject: 'op', audience: AUDIENCE, ttlMs: 60_000, now: NOW });
    expect(a).not.toBe(b);
  });
});

describe('Cycle 2.4 — verifying a token', () => {
  const issue = (over: Partial<Parameters<typeof issueToken>[0]> = {}) =>
    issueToken({ key: KEY, subject: 'op', audience: AUDIENCE, ttlMs: 60_000, now: NOW, ...over });

  it('accepts a valid unexpired token', () => {
    const claims = verifyToken(issue(), { key: KEY, audience: AUDIENCE, now: NOW + 1_000 });
    expect(claims.sub).toBe('op');
  });

  it('rejects an expired token', () => {
    // BREAK: no expiry enforcement, which is one of the three things the
    // shared secret could not do.
    expect(() => verifyToken(issue({ ttlMs: 1_000 }), { key: KEY, audience: AUDIENCE, now: NOW + 10_000 })).toThrow(
      TokenError
    );
  });

  it('rejects a token signed with a different key', () => {
    // BREAK: signature verification being skipped or the key not checked. THIS
    // is the property that makes the secret un-leakable from the bundle.
    const foreign = issueToken({ key: OTHER_KEY, subject: 'op', audience: AUDIENCE, ttlMs: 60_000, now: NOW });
    expect(() => verifyToken(foreign, { key: KEY, audience: AUDIENCE, now: NOW })).toThrow(TokenError);
  });

  it('rejects a token whose payload was edited', () => {
    // BREAK: accepting a tampered payload. Anyone holding a valid token could
    // otherwise rewrite the subject or extend the expiry.
    const token = issue();
    const [h, p, s] = token.split('.');
    const decoded = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    decoded.exp = NOW + 999_999_999;
    const forged = `${h}.${Buffer.from(JSON.stringify(decoded)).toString('base64url')}.${s}`;
    expect(() => verifyToken(forged, { key: KEY, audience: AUDIENCE, now: NOW })).toThrow(TokenError);
  });

  it('rejects a token minted for a different audience', () => {
    // BREAK: a token for another service being replayed here.
    const other = issue({ audience: 'some-other-service' });
    expect(() => verifyToken(other, { key: KEY, audience: AUDIENCE, now: NOW })).toThrow(TokenError);
  });

  it('rejects a structurally invalid token', () => {
    for (const bad of ['', 'not-a-token', 'a.b', 'a.b.c.d', '...']) {
      expect(() => verifyToken(bad, { key: KEY, audience: AUDIENCE, now: NOW }), bad).toThrow(TokenError);
    }
  });

  it('rejects a token signed with the all-zero key', () => {
    // BREAK: the classic JWT bypass where an empty signature is accepted
    // because the implementation checks truthiness rather than equality.
    const zeroKey = 'A'.repeat(43);
    const forged = issueToken({ key: zeroKey, subject: 'op', audience: AUDIENCE, ttlMs: 60_000, now: NOW });
    expect(() => verifyToken(forged, { key: KEY, audience: AUDIENCE, now: NOW })).toThrow(TokenError);
  });

  it('rejects a token with an empty signature segment', () => {
    const token = issue();
    const [h, p] = token.split('.');
    expect(() => verifyToken(`${h}.${p}.`, { key: KEY, audience: AUDIENCE, now: NOW })).toThrow(TokenError);
  });

  it('reports a distinct error reason for expiry versus signature failure', () => {
    // BREAK: a caller unable to tell "refresh your token" from "you are not
    // authenticated", which the extension needs in order to react correctly.
    let expiryReason = '';
    try {
      verifyToken(issue({ ttlMs: 1_000 }), { key: KEY, audience: AUDIENCE, now: NOW + 10_000 });
    } catch (e) {
      expiryReason = (e as TokenError).reason;
    }
    let sigReason = '';
    try {
      verifyToken(issue({ key: OTHER_KEY }), { key: KEY, audience: AUDIENCE, now: NOW });
    } catch (e) {
      sigReason = (e as TokenError).reason;
    }
    expect(expiryReason).not.toBe('');
    expect(sigReason).not.toBe('');
    expect(expiryReason).not.toBe(sigReason);
  });
});

describe('Cycle 2.4 — claims contract', () => {
  it('round-trips a full claim set', () => {
    const token = issueToken({ key: KEY, subject: 'local-operator', audience: AUDIENCE, ttlMs: 90_000, now: NOW });
    const claims: TokenClaims = verifyToken(token, { key: KEY, audience: AUDIENCE, now: NOW });
    expect(typeof claims.sub).toBe('string');
    expect(typeof claims.aud).toBe('string');
    expect(typeof claims.iat).toBe('number');
    expect(typeof claims.exp).toBe('number');
    expect(typeof claims.jti).toBe('string');
  });
});
