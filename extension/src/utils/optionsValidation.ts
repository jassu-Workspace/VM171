/**
 * Pairing validation — Cycle 2.4 (client half)
 * ---------------------------------------------------------------------------
 * The Options page is how a human completes pairing: paste the one-time code
 * the server printed, and the page exchanges it for a token held in browser
 * storage.
 *
 * These validators are separated from the component so they can be tested
 * directly. The point is that the UI cannot become a place where an invalid
 * value is accepted and then fails mysteriously at request time — the operator
 * learns about it here, where they are looking.
 *
 * The exchange itself is a network call covered by the server-side pairing
 * tests. What lives here is what we accept, and how clearly we say no.
 */
import { isAllowedServerUrl, isValidToken, DEFAULT_SERVER_URL } from './config';

export type PairingField = 'serverUrl' | 'code' | 'token';

export interface FieldValidation {
  ok: boolean;
  message?: string;
}

/**
 * A pairing code is base64url of 24 random bytes — 32 characters. A short value
 * is a paste error; a very long one with dots is a token pasted into the wrong
 * box, which is worth naming explicitly rather than reporting as "invalid".
 */
export function validatePairingCode(code: string): FieldValidation {
  const trimmed = (code ?? '').trim();

  if (trimmed.length === 0) {
    return { ok: false, message: 'Paste the pairing code from the server console.' };
  }

  // Check the JWT shape BEFORE the charset, so pasting a token into the code
  // box gets the useful message instead of a complaint about dots.
  if (trimmed.includes('.')) {
    return { ok: false, message: 'That looks like a token, not a pairing code.' };
  }

  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    return { ok: false, message: 'A pairing code contains only letters, digits, - and _.' };
  }

  if (trimmed.length < 20) {
    return { ok: false, message: 'That looks too short to be a pairing code.' };
  }

  return { ok: true };
}

export function validateServerUrlField(value: string): FieldValidation {
  const trimmed = (value ?? '').trim();

  if (trimmed.length === 0) {
    return { ok: false, message: 'Enter the server address.' };
  }

  if (!isAllowedServerUrl(trimmed)) {
    return {
      ok: false,
      message: 'Only a loopback address is allowed (127.0.0.1 or localhost).',
    };
  }

  return { ok: true };
}

export function validateTokenField(token: string): FieldValidation {
  const trimmed = (token ?? '').trim();

  if (trimmed.length === 0) {
    return { ok: false, message: 'Paste the issued token.' };
  }

  if (!isValidToken(trimmed)) {
    return { ok: false, message: 'That does not look like a JWT.' };
  }

  return { ok: true };
}

export function defaultServerUrl(): string {
  return DEFAULT_SERVER_URL;
}
