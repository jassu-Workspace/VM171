/**
 * Untrusted content delimiting and neutralisation — Cycle 1.7
 * ---------------------------------------------------------------------------
 * The text in `maskedDom` originates from the page, which means it originates
 * from an attacker. This module does two things:
 *
 *   1. DELIMIT — wrap page-derived text in explicit markers and name the source,
 *      so the model has a signal that the region is data, not instruction.
 *   2. NEUTRALISE — detect imperative phrasing and wrap it in a visible tag
 *      rather than deleting it.
 *
 * NOT AN INJECTION DEFENCE, and deliberately not pretending to be one:
 *
 *   Neutralisation is regex-based and therefore BYPASSABLE BY REPHRASING. That
 *   limitation is pinned by a test in `untrustedContent.test.ts` so it stays a
 *   recorded fact rather than an unstated assumption.
 *
 *   The compensating control is a server-side action policy between the model
 *   and `executeAction` (Spec 3, Cycle 3.1). Because that gate exists
 *   independently of the prompt text, a successful injection still cannot cause
 *   a dangerous action. This module is a QUALITY control: it reduces derailed
 *   steps and wasted context, and it leaves an audit trail of what a page tried.
 *
 * TAGGING, NOT DELETION, is a deliberate choice. Deleting matched text corrupts
 * pages that legitimately discuss instructions — and this agent targets
 * documentation and Indian government portals, where "follow the instructions
 * below" is normal, useful content. A tag preserves the surrounding meaning for
 * the model while removing imperative force, and stays auditable.
 *
 * Pure, no DOM dependency.
 */

export const UNTRUSTED_OPEN = '<<<UNTRUSTED_PAGE_CONTENT';
export const UNTRUSTED_CLOSE = 'UNTRUSTED_PAGE_CONTENT>>>';
export const UNTRUSTED_CMD_TAG = '⟦UNTRUSTED_CMD';

/**
 * Imperative phrasings commonly used to redirect an agent. Ordered
 * longest-first so a longer phrase is not partially matched by a shorter one.
 *
 * Kept deliberately narrow: a wide net would flag ordinary documentation and
 * make the signal worthless.
 */
const IMPERATIVE_PATTERNS: readonly RegExp[] = [
  // "ignore/disregard/forget previous/prior/above instructions/rules"
  /\b(?:ignore|disregard|forget|override|bypass)\s+(?:all\s+|any\s+)?(?:the\s+)?(?:previous|prior|above|earlier|preceding|foregoing)\s+(?:instructions?|rules?|prompts?|directions?|guidance?)\b/gi,
  // "do not tell the user", "without informing the user"
  /\b(?:do\s+not|don't|never)\s+(?:tell|inform|notify|warn)\s+(?:the\s+)?(?:user|operator|human)\b/gi,
  // "you must now", "from now on you", "your new role is"
  /\byou\s+(?:must|shall|will)\s+now\b/gi,
  /\bfrom\s+now\s+on[, ]+you\b/gi,
  /\byour\s+new\s+(?:role|instruction|purpose)\s+is\b/gi,
  // "send/email/post the contents to"
  /\b(?:send|email|post|upload|exfiltrate|transmit)\s+(?:the\s+)?(?:contents?|data|file|files|keys?|secrets?|credentials?)\s+to\b/gi,
  // role/system markers
  /^\s*(?:###\s*)?(?:system|assistant|developer)\s*:/gim,
];

export interface NeutralizationResult {
  text: string;
  /** One entry per neutralised span, for the operator audit trail. */
  audit: string[];
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Neutralise imperative spans by wrapping them in a visible tag.
 *
 * The matched text is PRESERVED inside the tag. Idempotent by construction:
 * already-tagged regions are split out and only the text BETWEEN tags is
 * transformed. Without that, a second pass would re-match the imperative inside
 * its own tag and nest `⟦UNTRUSTED_CMD:⟦UNTRUSTED_CMD:…⟧⟧` — which matters
 * because this runs on every step of an agent loop.
 */
export function neutralizeImperatives(input: string): NeutralizationResult {
  if (typeof input !== 'string' || input.length === 0) {
    return { text: '', audit: [] };
  }

  const audit: string[] = [];

  // Split on complete existing tags, keeping the delimiters, so the payload
  // inside them is never re-examined.
  const segments = input.split(/(⟦UNTRUSTED_CMD:[^⟧]*⟧)/g);

  const transformed = segments.map((segment) => {
    // Odd-indexed segments are the captured tags; pass them through untouched.
    if (segment.startsWith(`${UNTRUSTED_CMD_TAG}:`) && segment.endsWith('⟧')) {
      return segment;
    }

    let out = segment;
    for (const pattern of IMPERATIVE_PATTERNS) {
      pattern.lastIndex = 0;
      out = out.replace(pattern, (match) => {
        const trimmed = match.trim();
        if (trimmed.length === 0) return match;
        audit.push(trimmed);
        return `${UNTRUSTED_CMD_TAG}:${trimmed}⟧`;
      });
    }
    return out;
  });

  return { text: transformed.join(''), audit };
}

/**
 * Wrap untrusted text in delimiters, neutralising any attempt by the page to
 * emit the delimiters itself.
 *
 * DELIMITER INJECTION is the threat: if page content can emit the closing
 * marker, everything after it reads as trusted instruction. Any occurrence
 * inside the payload is therefore defanged first.
 */
export function wrapUntrusted(input: string, source: string): string {
  const body = typeof input === 'string' ? input : '';

  // Defang delimiter markers in the payload. The real markers are emitted only
  // by this function, at the very start and very end.
  const openRe = new RegExp(escapeForRegex(UNTRUSTED_OPEN), 'g');
  const closeRe = new RegExp(escapeForRegex(UNTRUSTED_CLOSE), 'g');

  const defanged = body.replace(openRe, '‹untrusted-open›').replace(closeRe, '‹untrusted-close›');

  return `${UNTRUSTED_OPEN}:${source}\n${defanged}\n${UNTRUSTED_CLOSE}`;
}

/**
 * The full outbound transform: neutralise imperatives, then delimit.
 * This is what the content script should call on page-derived text.
 */
export function prepareOutboundText(input: string, source: string): {
  text: string;
  audit: string[];
} {
  const { text, audit } = neutralizeImperatives(input);
  return { text: wrapUntrusted(text, source), audit };
}
