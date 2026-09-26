/**
 * Stateful chrome.storage mock — Cycle 2.2
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * The original mock was:
 *
 *     storage: { local: { get: vi.fn().mockResolvedValue({}), set: vi.fn(), remove: vi.fn() } }
 *
 * `get` returned a fresh `{}` for every call and `set` discarded its argument.
 * Every test using it therefore saw permanently EMPTY storage, no matter what
 * it wrote. A test like "persists and reads back a config" would pass against
 * that mock for the wrong reason — or fail, depending on how it was written.
 *
 * This harness is backed by a real Map, so get/set/remove behave as the
 * browser API does, including returning undefined for a key that was never
 * set. That last detail is load-bearing: it is what lets a test distinguish
 * "unpaired" from "configured".
 *
 * `__resetStorage()` is a TEST UTILITY and lives here in the setup file, never
 * on a production class.
 */
import { vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const store = new Map<string, unknown>();

export function __resetStorage(): void {
  store.clear();
}

const localArea = {
  get: vi.fn(async (keys?: string | string[] | null): Promise<Record<string, unknown>> => {
    if (keys === undefined || keys === null) {
      return Object.fromEntries(store);
    }
    const list = Array.isArray(keys) ? keys : [keys];
    const out: Record<string, unknown> = {};
    for (const k of list) {
      if (store.has(k)) out[k] = store.get(k);
    }
    return out;
  }),

  set: vi.fn(async (items: Record<string, unknown>): Promise<void> => {
    for (const [k, v] of Object.entries(items ?? {})) store.set(k, v);
  }),

  remove: vi.fn(async (keys: string | string[]): Promise<void> => {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const k of list) store.delete(k);
  }),

  clear: vi.fn(async (): Promise<void> => {
    store.clear();
  }),
};

const mockChrome = {
  runtime: {
    id: 'sih-test-extension-id',
    onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    sendMessage: vi.fn().mockResolvedValue({ success: true }),
    getURL: vi.fn((path: string) => `chrome-extension://mock-id/${path}`),
  },
  tabs: {
    captureVisibleTab: vi.fn().mockResolvedValue(''),
    sendMessage: vi.fn().mockResolvedValue({ success: true }),
    query: vi.fn().mockResolvedValue([{ id: 1, url: 'https://www.amazon.in' }]),
    get: vi.fn().mockResolvedValue({ id: 1, status: 'complete', url: 'https://www.amazon.in' }),
    update: vi.fn().mockResolvedValue({ id: 1 }),
    create: vi.fn().mockResolvedValue({ id: 2 }),
  },
  storage: {
    local: localArea,
    session: localArea,
    sync: localArea,
  },
  scripting: {
    executeScript: vi.fn().mockResolvedValue([]),
  },
};

(globalThis as unknown as { chrome: unknown }).chrome = mockChrome;
(globalThis as unknown as { browser: unknown }).browser = mockChrome;
(globalThis as unknown as { defineContentScript: unknown }).defineContentScript = (def: unknown) => def;

if (typeof (globalThis as unknown as { PointerEvent: unknown }).PointerEvent === 'undefined') {
  class MockPointerEvent extends (typeof MouseEvent !== 'undefined' ? MouseEvent : Event) {
    pointerId: number;
    pointerType: string;
    isPrimary: boolean;
    constructor(type: string, params: Record<string, unknown> = {}) {
      super(type, params);
      this.pointerId = (params.pointerId as number) ?? 0;
      this.pointerType = (params.pointerType as string) ?? '';
      this.isPrimary = (params.isPrimary as boolean) ?? false;
    }
  }
  (globalThis as unknown as { PointerEvent: unknown }).PointerEvent = MockPointerEvent;
}

// ── Server-side environment ────────────────────────────────────────
//
// Cycle 2.4: the shared password is no longer a credential. The server issues
// signed bearer tokens and the legacy `x-secret-password` header is rejected on
// purpose. SECRET_PASSWORD is retained ONLY so the Cycle 1.8 logger-redaction
// tests have a realistic secret to prove is never written to a log.
process.env.SECRET_PASSWORD = process.env.SECRET_PASSWORD || 'test-secret-password';

// A KNOWN signing key and pairing code so tests can mint valid tokens. In
// normal operation both are generated per process and only ever reach the
// operator's console.
process.env.SECRETS_SIGNING_KEY =
  process.env.SECRETS_SIGNING_KEY || 'test-signing-key-0123456789abcdefghijklmno';
process.env.SECRETS_PAIRING_CODE = process.env.SECRETS_PAIRING_CODE || 'test-pairing-code-0123456789';

process.env.ALLOWED_ORIGINS =
  process.env.ALLOWED_ORIGINS ||
  'chrome-extension://test-extension-id,http://localhost:3300,http://localhost:3000';

// Cycle 2.7: read at import time, so tests need a small limit to exercise the
// oversized case cheaply. Production defaults to 20 MB.
process.env.MAX_BODY_BYTES = process.env.MAX_BODY_BYTES || '32768';

// Cycle 2.13: point session storage at a throwaway root BEFORE the server
// modules are imported. Without this the retention tests write into — and prune
// — the operator's real storage/sessions, which already happened once.
process.env.SESSION_STORAGE_DIR =
  process.env.SESSION_STORAGE_DIR || join(tmpdir(), `ztai-test-storage-${process.pid}`);

export { localArea };
