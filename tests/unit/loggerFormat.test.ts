import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getLogFormat,
  setLogFormat,
  formatLogEntry,
  setRedactor,
  createRedactor,
  REDACTED,
} from '../../server/src/logger';
import {
  pruneSessions,
  safeSessionId,
  SESSIONS_DIR,
  initSession,
} from '../../server/src/sessionStorage';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

describe('Task 1 — LOG_FORMAT switch in logger.ts', () => {
  const originalEnv = process.env.LOG_FORMAT;

  beforeEach(() => {
    delete process.env.LOG_FORMAT;
    setLogFormat(null);
    setRedactor(
      createRedactor({
        SECRET_PASSWORD: 'super-secret-password-12345',
        GEMINI_API_KEY: 'AIzaSyD-dummy-test-key-54321',
      })
    );
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.LOG_FORMAT = originalEnv;
    } else {
      delete process.env.LOG_FORMAT;
    }
  });

  it('defaults to pretty format when LOG_FORMAT is unset', () => {
    delete process.env.LOG_FORMAT;
    expect(getLogFormat()).toBe('pretty');
  });

  it('honours LOG_FORMAT=json', () => {
    process.env.LOG_FORMAT = 'json';
    expect(getLogFormat()).toBe('json');
  });

  it('honours LOG_FORMAT=pretty', () => {
    process.env.LOG_FORMAT = 'pretty';
    expect(getLogFormat()).toBe('pretty');
  });

  it('falls back to pretty when LOG_FORMAT has an unknown value', () => {
    process.env.LOG_FORMAT = 'unsupported-format';
    expect(getLogFormat()).toBe('pretty');
  });

  it('formats log lines as JSON when format is json', () => {
    const formatted = formatLogEntry('info', 'Server is running', 'json');
    const parsed = JSON.parse(formatted) as { timestamp: string; level: string; message: string };
    expect(parsed.level).toBe('info');
    expect(parsed.message).toBe('Server is running');
    expect(typeof parsed.timestamp).toBe('string');
  });

  it('redacts secrets when formatting as JSON', () => {
    const formatted = formatLogEntry('error', 'Auth failed with super-secret-password-12345', 'json');
    const parsed = JSON.parse(formatted) as { timestamp: string; level: string; message: string };
    expect(parsed.message).not.toContain('super-secret-password-12345');
    expect(parsed.message).toContain(REDACTED);
  });

  it('formats log lines with level markers and colors in pretty mode', () => {
    const formatted = formatLogEntry('info', 'Hello world', 'pretty');
    expect(formatted).toContain('ℹ INFO');
    expect(formatted).toContain('Hello world');
  });

  it('redacts secrets in pretty mode', () => {
    const formatted = formatLogEntry('warn', 'Key AIzaSyD-dummy-test-key-54321 expired', 'pretty');
    expect(formatted).not.toContain('AIzaSyD-dummy-test-key-54321');
    expect(formatted).toContain(REDACTED);
  });
});

describe('Task 1 — sessionStorage env defaults for pruneSessions', () => {
  const originalDays = process.env.SESSION_RETENTION_DAYS;
  const originalMax = process.env.MAX_SESSIONS;
  const createdSessions: string[] = [];

  afterEach(() => {
    if (originalDays !== undefined) {
      process.env.SESSION_RETENTION_DAYS = originalDays;
    } else {
      delete process.env.SESSION_RETENTION_DAYS;
    }
    if (originalMax !== undefined) {
      process.env.MAX_SESSIONS = originalMax;
    } else {
      delete process.env.MAX_SESSIONS;
    }
    for (const id of createdSessions) {
      try {
        rmSync(join(SESSIONS_DIR, id), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    createdSessions.length = 0;
  });

  it('pruneSessions accepts empty options and uses default bounds', () => {
    const result = pruneSessions({});
    expect(typeof result.removed).toBe('number');
    expect(typeof result.remaining).toBe('number');
  });

  it('pruneSessions honours SESSION_RETENTION_DAYS env var when options are empty', () => {
    process.env.SESSION_RETENTION_DAYS = '1';
    const id = safeSessionId('test-env-retention-old');
    createdSessions.push(id);
    const dir = join(SESSIONS_DIR, id);
    mkdirSync(dir, { recursive: true });
    const oldDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(
      join(dir, 'session_meta.json'),
      JSON.stringify({ sessionId: id, createdAt: oldDate, status: 'completed' }),
      'utf8'
    );

    const res = pruneSessions();
    expect(existsSync(dir)).toBe(false);
    expect(res.removed).toBeGreaterThanOrEqual(1);
  });
});
