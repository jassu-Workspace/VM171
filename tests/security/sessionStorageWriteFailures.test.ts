/**
 * Storage write failures are visible to the caller.
 * ---------------------------------------------------------------------------
 * sessionStorage's write functions used to catch every filesystem error with
 * console.warn and return normally, so execution continued and no caller —
 * route or test — could tell the audit save had failed. They now report
 * failure with a return flag (null/false, never a throw; see the contract
 * note on initSession), and the routes log via the redacting server log.
 *
 * This file pins the caller-visible half of that contract by importing a
 * fresh copy of the module with SESSION_STORAGE_DIR pointed somewhere writes
 * cannot succeed:
 *
 *   1. initSession returns null (not a path to a directory that was never
 *      created) when the storage root is unusable;
 *   2. saveSessionStep returns false when the storage root is unusable;
 *   3. finalizeSession returns false when the metadata write itself fails
 *      (a directory masquerading as session_meta.json makes the read throw);
 *   4. the same calls return success against a writable root, so the flags
 *      are real signals rather than constants.
 *
 * The unwritable root is a regular FILE (path/sessions under it fails with
 * ENOTDIR), inside the OS tmpdir — the operator's real storage is never
 * touched. New file; no existing test is modified.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORIGINAL_STORAGE_DIR = process.env.SESSION_STORAGE_DIR;
const BLOCKER = join(tmpdir(), `ztai-writefail-blocker-${process.pid}`);
const CREATED_ROOTS = new Set<string>();

async function freshStorage(storageDir: string): Promise<typeof import('../../server/src/sessionStorage')> {
  vi.resetModules();
  process.env.SESSION_STORAGE_DIR = storageDir;
  return import('../../server/src/sessionStorage');
}

afterEach(async () => {
  vi.resetModules();
  if (ORIGINAL_STORAGE_DIR === undefined) {
    delete process.env.SESSION_STORAGE_DIR;
  } else {
    process.env.SESSION_STORAGE_DIR = ORIGINAL_STORAGE_DIR;
  }
  try {
    rmSync(BLOCKER, { force: true });
  } catch {
    /* ignore */
  }
  for (const root of CREATED_ROOTS) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  CREATED_ROOTS.clear();
});

describe('storage write failures are caller-visible', () => {
  it('initSession returns null when the storage root is unusable', async () => {
    // BREAK: returning a path for a directory that was never created, so the
    // route reports success and the audit trail has a hole shaped like a session.
    writeFileSync(BLOCKER, 'not a directory', 'utf8');
    const mod = await freshStorage(BLOCKER);
    expect(mod.initSession('writefail-init', 'a task')).toBeNull();
    expect(existsSync(join(mod.SESSIONS_DIR, 'writefail-init'))).toBe(false);
  });

  it('saveSessionStep returns false when the storage root is unusable', async () => {
    // BREAK: the step pipeline believing raw/masked frames landed on disk
    // while nothing was written.
    writeFileSync(BLOCKER, 'not a directory', 'utf8');
    const mod = await freshStorage(BLOCKER);
    const ok = mod.saveSessionStep({ sessionId: 'writefail-step', step: 1, task: 'a task' });
    expect(ok).toBe(false);
  });

  it('finalizeSession returns false when the metadata write itself fails', async () => {
    // BREAK: final status silently lost while the route reports success.
    const root = join(tmpdir(), `ztai-writefail-meta-${process.pid}-${Date.now()}`);
    CREATED_ROOTS.add(root);
    const mod = await freshStorage(root);
    const dir = mod.initSession('writefail-finalize', 'a task');
    expect(dir).not.toBeNull();
    // A directory where session_meta.json should be: existsSync passes, then
    // the read throws, so the write path is genuinely exercised and fails.
    rmSync(join(dir as string, 'session_meta.json'), { force: true });
    mkdirSync(join(dir as string, 'session_meta.json'), { recursive: true });
    expect(mod.finalizeSession('writefail-finalize', 'completed', 'done')).toBe(false);
  });

  it('the same calls report success against a writable root', async () => {
    // Guards the other direction: the flags must be real signals, not constants.
    const root = join(tmpdir(), `ztai-writefail-ok-${process.pid}-${Date.now()}`);
    CREATED_ROOTS.add(root);
    const mod = await freshStorage(root);
    expect(mod.initSession('writefail-ok', 'a task')).not.toBeNull();
    expect(mod.saveSessionStep({ sessionId: 'writefail-ok', step: 1, task: 'a task' })).toBe(true);
    expect(mod.finalizeSession('writefail-ok', 'completed', 'done')).toBe(true);
  });
});
