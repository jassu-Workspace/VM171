/**
 * Completion types — Cycle 2.1
 *
 * Kept separate from completion.ts so the seam can be imported by tests without
 * pulling in anything that touches the OpenAI SDK or the environment.
 */

/** One part of a multimodal chat message. */
export type CompletionContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface CompletionRequest {
  /** Session identifier, for logging and cache scoping. */
  sessionId: string;
  /** The assembled system prompt, including the domain classifier output. */
  systemPrompt: string;
  /**
   * The user turn. Page-derived text lives here — masked, delimited, and
   * neutralised by Cycles 1.6 and 1.7. The raw screenshot never is.
   */
  userContent: CompletionContentPart[];
}

/**
 * A completion returns the model's RAW text. Parsing into an action is a
 * separate concern with its own failure modes, so it is not hidden behind this
 * boundary: a test can return deliberately malformed text and assert on the
 * parse failure.
 */
export type CompletionFn = (request: CompletionRequest) => Promise<string>;
