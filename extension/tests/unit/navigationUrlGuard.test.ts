/**
 * The `navigate` action assigns to `window.location.href` (content/index.ts).
 * Assigning `javascript:` there executes script in the page, so the value has to
 * be constrained at this hop too and not only by the server-side action policy.
 *
 * These tests run against the post-normalisation value, which is what the
 * assignment actually receives.
 */
import { describe, it, expect } from 'vitest';
import { isSafeNavigationUrl } from '../../src/utils/outboundText';

describe('isSafeNavigationUrl — the value handed to window.location.href', () => {
  it('permits absolute http and https targets', () => {
    for (const url of [
      'http://example.com',
      'https://example.com',
      'https://example.com/orders/2024?q=1#row-9',
      'https://example.com:8443/a',
      'HTTPS://EXAMPLE.COM/',
    ]) {
      expect(isSafeNavigationUrl(url)).toBe(true);
    }
  });

  it('permits relative and protocol-relative targets, which is what the caller already produces', () => {
    for (const url of [
      '/dashboard/orders',
      '/',
      '//cdn.example.com/lib.js',
      'orders/2024.html',
      '?page=2',
      '#section-3',
    ]) {
      expect(isSafeNavigationUrl(url)).toBe(true);
    }
  });

  it('refuses javascript: and the casing and whitespace variants of it', () => {
    for (const url of [
      'javascript:alert(1)',
      'JavaScript:alert(document.domain)',
      'JAVASCRIPT:alert(1)',
      ' javascript:alert(1)',
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      'jav\tascript:alert(1)',
      'java\rscript:alert(1)',
      '\u0000javascript:alert(1)',
    ]) {
      expect(isSafeNavigationUrl(url)).toBe(false);
    }
  });

  it('refuses every other scheme', () => {
    for (const url of [
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'about:blank',
      'blob:https://example.com/2b3c',
      'mailto:someone@example.com',
    ]) {
      expect(isSafeNavigationUrl(url)).toBe(false);
    }
  });
});
