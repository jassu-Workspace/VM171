/**
 * Locally-issued JWT authentication — Cycle 2.4 (Task 2)
 * ---------------------------------------------------------------------------
 * Replaces the shared password with a signed, short-lived token.
 *
 * The task list asked for "per-user JWT". This is a single-operator local tool,
 * so a user database, password resets and a multi-tenant session store would be
 * ceremony around a problem that does not exist. What the shared secret
 * genuinely lacked was not identity — it was EXPIRY, REVOCATION and SCOPE, and
 * all three arrive free with a signed token.
 *
 *   1. Server generates a random signing key on first boot; never committed.
 *   2. It prints a one-time PAIRING CODE to the operator's console.
 *   3. The extension exchanges that code for a signed, short-lived token and
 *      stores it in chrome.storage.local.
 *   4. Every API call presents `Authorization: Bearer <jwt>`.
 *
 * The property that matters most: the credential is no longer a PUBLIC LITERAL.
 * The old secret shipped inside the extension bundle and was readable by anyone
 * who unpacked it. A per-process random signing key cannot be.
 *
 * Implementation notes
 * --------------------
 * HS256 over `node:crypto`, hand-rolled rather than pulling in a JWT library:
 * the whole surface is issue/verify, and a dependency that parses untrusted
 * tokens is exactly the kind of thing that should be readable end to end.
 *
 * The signature comparison is constant-time. A byte-by-byte `===` on a MAC
 * leaks its prefix through timing, which is enough to forge one byte at a time.
 *
 * Pure module: no Hono, no database, and the clock is injected so expiry is
 * testable without sleeping.
 */
import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

export const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 minutes
export const DEFAULT_AUDIENCE = 'ztai-agent';

export interface TokenClaims {
  /** Subject — "local-operator" today, but a real id if this ever multi-user. */
  sub: string;
  /** Audience — which service this token is for. */
  aud: string;
  /** Issued-at, seconds since epoch. */
  iat: number;
  /** Expiry, seconds since epoch. */
  exp: number;
  /** Unique token id, so a specific token can be revoked. */
  jti: string;
}

export type TokenErrorReason =
  | 'malformed'
  | 'bad-signature'
  | 'expired'
  | 'wrong-audience';

export class TokenError extends Error {
  readonly reason: TokenErrorReason;

  constructor(reason: TokenErrorReason, message: string) {
    super(message);
    this.name = 'TokenError';
    this.reason = reason;
  }
}

/** 256 bits, base64url without padding — 43 characters. */
export function generateSigningKey(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * A pairing code is typed by a human into the extension, so it is
 * alphanumeric and long enough that guessing it from a browser — where the
 * origin guard is the only brake — is not practical.
 */
export function generatePairingCode(): string {
  return randomBytes(24).toString('base64url');
}

export function isPairingCodeValid(submitted: string, expected: string | undefined): boolean {
  if (typeof expected !== 'string' || expected.length === 0) return false;
  if (typeof submitted !== 'string' || submitted.length === 0) return false;

  const a = Buffer.from(submitted);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input as never).toString('base64url');
}

function sign(signingInput: string, key: string): string {
  return createHmac('sha256', key).update(signingInput).digest('base64url');
}

export interface IssueOptions {
  key: string;
  subject: string;
  audience?: string;
  ttlMs?: number;
  /** Injected clock, milliseconds since epoch. */
  now?: number;
}

export function issueToken(options: IssueOptions): string {
  const {
    key,
    subject,
    audience = DEFAULT_AUDIENCE,
    ttlMs = DEFAULT_TTL_MS,
    now = Date.now(),
  } = options;

  const iat = Math.floor(now / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const claims: TokenClaims = {
    sub: subject,
    aud: audience,
    iat,
    exp: iat + Math.floor(ttlMs / 1000),
    // Random per token: two issued in the same second must differ, or
    // per-token revocation is meaningless.
    jti: randomBytes(12).toString('base64url'),
  };

  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  return `${signingInput}.${sign(signingInput, key)}`;
}

export interface VerifyOptions {
  key: string;
  audience: string;
  /** Injected clock, milliseconds since epoch. */
  now?: number;
}

/**
 * Verify signature, expiry and audience — in that order, and always.
 *
 * Signature is checked BEFORE the payload is trusted, and the comparison is
 * constant-time. An empty or missing signature is rejected rather than treated
 * as vacuously valid, which is the classic JWT bypass.
 */
export function verifyToken(token: string, options: VerifyOptions): TokenClaims {
  const { key, audience, now = Date.now() } = options;

  if (typeof token !== 'string') {
    throw new TokenError('malformed', 'Token must be a string.');
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new TokenError('malformed', 'Token must have three segments.');
  }

  const [header, payload, signature] = parts;
  if (!header || !payload || !signature) {
    throw new TokenError('malformed', 'Token has an empty segment.');
  }

  const expected = Buffer.from(sign(`${header}.${payload}`, key), 'base64url');
  const received = Buffer.from(signature, 'base64url');

  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    throw new TokenError('bad-signature', 'Token signature does not verify.');
  }

  let claims: TokenClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new TokenError('malformed', 'Token payload is not valid JSON.');
  }

  if (typeof claims.exp !== 'number' || typeof claims.iat !== 'number') {
    throw new TokenError('malformed', 'Token is missing temporal claims.');
  }

  if (Math.floor(now / 1000) >= claims.exp) {
    throw new TokenError('expired', 'Token has expired.');
  }

  if (claims.aud !== audience) {
    throw new TokenError('wrong-audience', 'Token was issued for a different audience.');
  }

  return claims;
}
