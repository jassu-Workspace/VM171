/**
 * Completion seam — Cycle 2.1
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * `tests/integration/serverContract.test.ts` re-implements the server by hand.
 * It copies the auth middleware, the PII firewall and the validation block into
 * a `createTestApp()` and asserts against THAT COPY. The file says so itself:
 * "WITHOUT importing production code (100% decoupled)".
 *
 * The consequences are concrete, not stylistic:
 *
 *   - The copy's PII regexes have DRIFTED. They cover CARD, PRIVATE_KEY, JWT,
 *     API_KEY, AADHAAR and PAN. Production additionally covers SSN, PASSPORT,
 *     DRIVING_LICENSE, BANK_ACCOUNT, IFSC_CODE, SWIFT_BIC, UPI_ID,
 *     CRYPTO_WALLET, PERSON, PHONE, EMAIL, DOB, PASSWORD, PIN_CRED, HEALTH_ID,
 *     TAX_ID and MEDICAL_RECORD — a gap found by Cycle 2.10, invisible until a
 *     test drove the real thing.
 *   - If production auth or the firewall were deleted, the suite stayed green.
 *   - Every one of the twenty-odd hardening cycles since has been verified
 *     against a MIRROR, because the real app could not be driven in a test
 *     without reaching a real AI provider.
 *
 * The blocker was always the same thing: `/api/step` calls a live model. Mock
 * the network boundary and the real app becomes testable.
 *
 * `setCompletion` is that seam. It installs a function in place of the upstream
 * call. It is a production API, not a test hook: index.ts consults it on every
 * step, and it is empty in normal operation.
 */
import type { CompletionRequest, CompletionFn } from './completionTypes';

let override: CompletionFn | null = null;

/**
 * Install a replacement for the upstream model call.
 *
 * Pass `null` to restore the real provider chain. Tests must reset this in
 * `afterEach`: a leaked override would silently make the rest of the suite
 * believe it is talking to a model.
 */
export function setCompletion(fn: CompletionFn | null): void {
  override = fn;
}

export function hasCompletionOverride(): boolean {
  return override !== null;
}

/**
 * Resolve the completion function to use for this step.
 *
 * `real` is supplied by the caller — index.ts builds the provider chain from
 * its own configuration. The override wins when present.
 */
export function resolveCompletion(real: CompletionFn): CompletionFn {
  return override ?? real;
}
