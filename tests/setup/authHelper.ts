/**
 * Test helper — mint a valid bearer token.
 *
 * Cycle 2.4: the shared password is gone, so every test that authenticated with
 * `x-secret-password` now presents a signed token instead. Centralised here so
 * the key, audience and TTL are defined once; a second copy is another thing
 * that can drift.
 */
import { issueToken, DEFAULT_AUDIENCE } from '../../server/src/token';

const KEY = process.env.SECRETS_SIGNING_KEY ?? '';
export const PAIRING_CODE = process.env.SECRETS_PAIRING_CODE ?? '';
export const AUDIENCE = DEFAULT_AUDIENCE;

/** A fresh valid token. Long TTL so tests never race a clock. */
export function authHeader(): Record<string, string> {
  return {
    Authorization: `Bearer ${issueToken({
      key: KEY,
      subject: 'local-operator',
      audience: AUDIENCE,
      ttlMs: 3_600_000,
    })}`,
  };
}
