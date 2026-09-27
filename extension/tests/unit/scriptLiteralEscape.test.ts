/**
 * Page-controlled `id` / `name` reach a JavaScript string literal.
 *
 * `handleNativeSelect` (src/entrypoints/content/index.ts) reads a <select>'s
 * `id` and `name` — both fully attacker-controlled — and splices them into a
 * script body that `executeInMainWorld` injects via `script.textContent`. A page
 * that sets `id='x");...//'` closes the literal and appends its own statements.
 *
 * The production template is mirrored here so the assertions run against real
 * parsed JavaScript rather than a hand-inspected string: a value that breaks out
 * either throws or comes back as something other than the value that went in.
 */
import { describe, it, expect } from 'vitest';
import { escapeForScriptLiteral } from '../../src/utils/outboundText';

/** Stand-in for the page's `document`, as seen from inside the injected body. */
const elementDocument = { getElementById: (): unknown => ({ dispatchEvent: (): void => {} }) };

/** Reports the id back, so a literal can be asked what it actually contains. */
const idDocument = { getElementById: (id: string): string => id };

/** Mirror of the bridge template built in handleNativeSelect. */
const bridgeBody = (value: string): string => `
      const el = document.getElementById("${escapeForScriptLiteral(value)}");
      if (el) { el.dispatchEvent(new Event('change')); }
    `;

/**
 * Ask the injected literal what string it actually contains. A breakout cannot
 * survive this: it either fails to parse, or the value no longer round-trips.
 */
const idSeenByInjectedScript = (value: string): string => {
  const lookup = new Function(
    'document',
    `return document.getElementById("${escapeForScriptLiteral(value)}");`
  );
  return lookup(idDocument);
};

describe('escapeForScriptLiteral — page attributes injected into a JS string', () => {
  it('neutralises a double-quote breakout so the payload stays inert data', () => {
    const payload = 'x");throw new Error("PWNED");//';

    expect(() => new Function('document', bridgeBody(payload))(elementDocument)).not.toThrow();
    expect(idSeenByInjectedScript(payload)).toBe(payload);
  });

  it('neutralises a backslash, which would otherwise escape the closing quote', () => {
    const payload = 'x\\';
    const trailingBackslash = 'x\\";throw new Error("PWNED");//';

    expect(() => new Function('document', bridgeBody(payload))(elementDocument)).not.toThrow();
    expect(() => new Function('document', bridgeBody(trailingBackslash))(elementDocument)).not.toThrow();
    expect(idSeenByInjectedScript(payload)).toBe(payload);
  });

  it('neutralises line terminators, which would truncate the injected body', () => {
    for (const payload of ['a\nb', 'a\rb', 'a\u2028b', 'a\u2029b']) {
      expect(() => new Function('document', bridgeBody(payload))(elementDocument)).not.toThrow();
      expect(idSeenByInjectedScript(payload)).toBe(payload);
    }
  });

  it('leaves ordinary attributes untouched, so the lookup still matches', () => {
    // These are NOT HTML-escaped. A page whose id contains `&` must still be
    // found by getElementById, so encoding it as `&amp;` would be a regression.
    for (const id of ['state-select', 'a&b', "o'brien", 'a<b>c', 'back`tick', '']) {
      expect(idSeenByInjectedScript(id)).toBe(id);
    }
  });
});
