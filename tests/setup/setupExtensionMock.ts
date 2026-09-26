/**
 * Test setup for WXT extension globals in Vitest
 */
import { vi } from 'vitest';

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
    local: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    },
  },
  scripting: {
    executeScript: vi.fn().mockResolvedValue([]),
  },
};

(globalThis as any).chrome = mockChrome;
(globalThis as any).browser = mockChrome;
(globalThis as any).defineContentScript = (def: any) => def;

if (typeof (globalThis as any).PointerEvent === 'undefined') {
  class MockPointerEvent extends (typeof MouseEvent !== 'undefined' ? MouseEvent : Event) {
    pointerId: number;
    pointerType: string;
    isPrimary: boolean;
    constructor(type: string, params: any = {}) {
      super(type, params);
      this.pointerId = params.pointerId ?? 0;
      this.pointerType = params.pointerType ?? 'mouse';
      this.isPrimary = params.isPrimary ?? false;
    }
  }
  (globalThis as any).PointerEvent = MockPointerEvent;
}

process.env.SECRET_PASSWORD = process.env.SECRET_PASSWORD || 'test-secret-password';

// Cycle 2.5: the server reads ALLOWED_ORIGINS at import time, and setup files
// run before test modules, so this must be set here — not inside a test file —
// or the origin guard would reject every supertest/app.request call.
process.env.ALLOWED_ORIGINS =
  process.env.ALLOWED_ORIGINS ||
  'chrome-extension://test-extension-id,http://localhost:3300,http://localhost:3000';


