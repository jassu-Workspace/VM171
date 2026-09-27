/**
 * Minimal Node.js type shims — avoids requiring @types/node to keep deps exact.
 * Only declares the specific globals/modules actually used in the codebase.
 */

declare module 'node:crypto' {
  export function randomUUID(): string;
  export function randomBytes(size: number): Buffer;
  export function createHmac(alg: string, key: string | Buffer): {
    update(data: string): { digest(enc: string): string };
  };
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
}

declare module 'node:fs' {
  export function appendFileSync(path: string, data: string, options?: { encoding?: string }): void;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function existsSync(path: string): boolean;
}

declare module 'node:path' {
  export function join(...paths: string[]): string;
  export function dirname(p: string): string;
}

declare module 'node:url' {
  export function fileURLToPath(url: string): string;
}

declare module 'node:module' {
  export function createRequire(url: string): (id: string) => unknown;
}

/**
 * Minimal surface for onnxruntime-node.
 *
 * It is an OPTIONAL dependency: a server without the native binary must still
 * boot and serve the agent, reporting redaction as unavailable rather than
 * crashing. That is why redaction.ts loads it through createRequire inside a
 * try/catch instead of a top-level import — and why these types describe only
 * what is actually called.
 */
declare module 'node:zlib' {
  export function inflateSync(buf: Uint8Array): Buffer;
  export function deflateSync(buf: Uint8Array): Buffer;
}

declare module 'onnxruntime-node' {
  export class Tensor {
    constructor(type: string, data: Float32Array, dims: number[]);
    data: Float32Array;
    dims: readonly number[];
  }
  export interface InferenceSession {
    inputNames: readonly string[];
    run(feeds: Record<string, Tensor>): Promise<Record<string, Tensor>>;
  }
  export const InferenceSession: {
    create(path: string, options?: Record<string, unknown>): Promise<InferenceSession>;
  };
}

declare namespace NodeJS {
  interface Timeout {
    ref(): Timeout;
    unref(): Timeout;
  }
}

// Override setTimeout/clearTimeout to use NodeJS.Timeout for unref() support
declare function setTimeout(callback: () => void, ms: number): NodeJS.Timeout;
declare function clearTimeout(timeoutId: NodeJS.Timeout | number): void;
