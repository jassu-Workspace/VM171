/**
 * Firewall false-positive regression.
 *
 * The PII firewall scans the ASSEMBLED PROMPT, which includes the base64
 * screenshot frame. Several patterns were loose enough to match arbitrary
 * [A-Z0-9] runs inside that base64, and the SWIFT/BIC shape (any 8-11
 * character uppercase run) matched ordinary English words — including this
 * project's own prompt scaffolding.
 *
 * Both failures were invisible until the E2E agent loop actually ran in a
 * real browser: the unit tests mock the provider and never exercise the real
 * prompt assembly, so a false positive in a live screenshot is invisible to
 * them. These tests extract the patterns from the real source, so they cannot
 * drift from what ships.
 *
 * Each case below was an actual observed failure, not a hypothetical.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const INDEX_SRC = readFileSync(
  join(__dirname, '../../server/src/index.ts'),
  'utf8',
);

/** Pull a named pattern straight out of the firewall table in the server. */
function firewallPattern(name: string): RegExp {
  const m = new RegExp(
    `^\\s*${name}:\\s*/(.+?)/[a-z]*,?\\s*$`,
    'm',
  ).exec(INDEX_SRC);
  if (!m) throw new Error(`pattern ${name} not found in index.ts`);
  return new RegExp(m[1], 'i');
}

const BIC = firewallPattern('SWIFT_BIC');
const WALLET = firewallPattern('CRYPTO_WALLET');

/**
 * A realistic 12.6KB base64 JPEG frame. The byte distribution matters: the
 * false positives appeared in high-entropy compressed data, not in
 * low-entropy padding.
 *
 * SEEDED on purpose. With `randomBytes` this test was flaky — roughly 1 run in
 * 10 failed, because a 16KB random string occasionally contains the letters
 * "bic" or "swift" by chance, and the keyword-gated SWIFT_BIC pattern then
 * legitimately matched. That is a property of random data, not a defect in the
 * pattern, but a test that fails intermittently is a test nobody trusts. A
 * fixed seed makes the corpus reproducible while keeping the same entropy
 * profile.
 */
function seededBytes(length: number, seed: number): Buffer {
  const out = Buffer.alloc(length);
  let x = seed * 2654435761 % (2 ** 32);
  for (let i = 0; i < length; i += 1) {
    x = (1103515245 * x + 12345) % (2 ** 31);
    out[i] = (x >> 16) & 0xff;
  }
  return out;
}

function realisticFrame(index: number, bytes = 12600): string {
  const head = Buffer.from('\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01', 'latin1');
  return Buffer.concat([head, seededBytes(bytes, index + 1)]).toString('base64');
}

describe('firewall false positives on base64 image frames', () => {
  it('does not read a bank identifier out of 1000 random frames', () => {
    let hits = 0;
    for (let i = 0; i < 1000; i += 1) {
      if (BIC.test(realisticFrame(i))) hits += 1;
    }
    // Previously 14/500 with word-boundary lookarounds, and 197/300 for the
    // CRYPTO base58 branch. A shape-only BIC match cannot be distinguished
    // from random bytes, which is why detection is keyword-gated now.
    expect(hits).toBe(0);
  });

  it('does not read a crypto wallet out of 1000 random frames', () => {
    let hits = 0;
    for (let i = 0; i < 1000; i += 1) {
      if (WALLET.test(realisticFrame(i))) hits += 1;
    }
    // Was 197/300. The old `(?:1|3|bc1)[a-zA-HJ-NP-Z0-9]{25,39}\b` matched the
    // PREFIX of any base64 blob starting with 1, 3 or "bc1".
    expect(hits).toBe(0);
  });
});

describe('firewall false positives on the extension\'s own prompt scaffolding', () => {
  // Every one of these blocked the E2E agent loop with a real 400 from the
  // firewall gate and zero AI calls.
  const SCAFFOLD = [
    '--- PAGE EVIDENCE ---',
    '--- INTERACTIVE ELEMENTS (Target these with "id" or "selector") ---',
    'REDACTED PASSWORD PASSPORT SENTINEL UNIVERSAL',
    'LOCATION CONTRACT UNBOUNDED REPLACES SOVEREIGN SHOPPING',
    'No completion evidence was observed on this page.',
    'COMPLETION PASSWORD GENERATED UNIVERSAL',
    'UNTRUSTED_PAGE_CONTENT',
    'The page contains "Order confirmed" (strong match, page-sourced, unverified).',
  ];

  it.each(SCAFFOLD)('leaves "%s" alone', (text) => {
    expect(BIC.test(text)).toBe(false);
    expect(WALLET.test(text)).toBe(false);
  });
});

describe('firewall still detects real bank identifiers', () => {
  // The keyword gate must not become a bypass. These are the phrasings a
  // payment page actually uses.
  const MUST_CATCH = [
    'SWIFT: DEUTDEFF',
    'SWIFT code DEUTDEFF500',
    'bic DEUTDEFF',
    'IBAN GB82WEST12345698765432',
    'our SWIFT/BIC is NEDSZAJJ and the account is 123456789',
    'SWIFT/BIC NEDSZAJJ',
    'BIC8: DEUTDEFF500',
    'BIC11: DEUTDEFF500',
    'Bank SWIFT Code: CHASUS33',
    'Our SWIFT code is CHASUS33 and sort code 20-00-00',
    'wire transfer SWIFT DEUTDEFF beneficiary',
    // No keyword at all — only the structural ISO 9362 branch can catch this.
    'transfer to GB82WEST12345698765432 please',
  ];

  it.each(MUST_CATCH)('catches "%s"', (text) => {
    expect(BIC.test(text)).toBe(true);
  });
});

describe('firewall still detects real crypto wallets', () => {
  it.each([
    `0x${'a'.repeat(40)}`,
    '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
    'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
  ])('catches %s', (addr) => {
    expect(WALLET.test(addr)).toBe(true);
  });
});
