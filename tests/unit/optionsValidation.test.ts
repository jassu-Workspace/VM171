/**
 * Cycle 2.4 (client half) — pairing form validation.
 * ---------------------------------------------------------------------------
 * The validators live in extension/src/utils/optionsValidation.ts, not here.
 * An earlier version of this file DEFINED them, which meant the "tests" were
 * asserting against code that shipped nowhere.
 */
import { describe, it, expect } from 'vitest';
import {
  validatePairingCode,
  validateServerUrlField,
  validateTokenField,
  defaultServerUrl,
} from '@/utils/optionsValidation';

describe('Cycle 2.4c — pairing form validation', () => {
  it('accepts a well-formed pairing code', () => {
    const code = 'aB3-_xYz0123456789ABCDEFGHIJ';
    expect(validatePairingCode(code).ok).toBe(true);
  });

  it('rejects an empty code with actionable guidance', () => {
    // BREAK: an empty submit silently doing nothing.
    const v = validatePairingCode('');
    expect(v.ok).toBe(false);
    expect(v.message).toMatch(/paste/i);
  });

  it('rejects a code containing invalid characters', () => {
    expect(validatePairingCode('code with spaces!').ok).toBe(false);
  });

  it('rejects a suspiciously short code', () => {
    // BREAK: a 4-digit code being accepted, which is trivially guessable.
    expect(validatePairingCode('1234').ok).toBe(false);
  });

  it('rejects a JWT pasted into the code field and says so', () => {
    // BREAK: a helpful error beats "invalid code" when the user pasted the
    // wrong thing into the wrong box.
    const v = validatePairingCode('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ9.sig');
    expect(v.ok).toBe(false);
    expect(v.message).toMatch(/token/i);
  });

  it('accepts a loopback server URL', () => {
    expect(validateServerUrlField('http://127.0.0.1:3000').ok).toBe(true);
    expect(validateServerUrlField('http://localhost:3000').ok).toBe(true);
  });

  it('rejects a non-loopback server URL and explains the restriction', () => {
    // BREAK: the exfiltration guard being a silent rejection, so the operator
    // does not learn WHY their working address is refused.
    const v = validateServerUrlField('http://192.168.1.10:3000');
    expect(v.ok).toBe(false);
    expect(v.message).toMatch(/loopback/i);
  });

  it('rejects an empty server URL', () => {
    expect(validateServerUrlField('').ok).toBe(false);
  });

  it('accepts a well-formed token', () => {
    expect(
      validateTokenField('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJsb2NhbCJ9.c2lnbmF0dXJl').ok
    ).toBe(true);
  });

  it('rejects a malformed token', () => {
    expect(validateTokenField('nope').ok).toBe(false);
  });

  it('offers a sensible default server URL', () => {
    // BREAK: an empty default, so the operator has to know the address.
    expect(defaultServerUrl()).toBe('http://127.0.0.1:3000');
  });
});
