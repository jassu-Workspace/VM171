/**
 * Periodic session-retention prune.
 * ---------------------------------------------------------------------------
 * pruneSessions() ran at boot and in shutdown() only, so a long-running
 * server never pruned and a hard kill skipped the shutdown prune. This file
 * pins the periodic loop in server/src/index.ts:
 *
 *   1. the production tick interval is hourly (retention granularity is days);
 *   2. the loop actually prunes an expired session without touching anything
 *      else (driven with a short interval; SESSION_STORAGE_DIR is already a
 *      throwaway tmpdir in tests, so the operator's real storage is safe);
 *   3. the timer is unref'd, so it never holds the process open;
 *   4. the loop survives repeated ticks and stops cleanly on request.
 *
 * New file; no existing test is modified.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  startPeriodicPrune,
  stopPeriodicPrune,
  RETENTION_PRUNE_INTERVAL_MS,
} from '../../server/src/index';
import { SESSIONS_DIR } from '../../server/src/sessionStorage';

const CREATED = new Set<string>();

function makeOldSession(id: string): void {
  CREATED.add(id);
  const dir = join(SESSIONS_DIR, id);
  mkdirSync(dir, { recursive: true });
  const ancient = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
  writeFileSync(
    join(dir, 'session_meta.json'),
    JSON.stringify({
      sessionId: id,
      createdAt: ancient,
      updatedAt: ancient,
      status: 'completed',
      task: `periodic-prune task for ${id}`,
      totalSteps: 1,
      subTasks: [],
      actions: [],
    }),
    'utf8'
  );
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return cond();
}

afterEach(() => {
  stopPeriodicPrune();
  for (const id of CREATED) {
    try {
      rmSync(join(SESSIONS_DIR, id), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  CREATED.clear();
});

describe('periodic retention prune', () => {
  it('ticks hourly by default', () => {
    // BREAK: an interval typo (seconds vs ms) silently making retention
    // effectively never — or a hot loop pruning constantly.
    expect(RETENTION_PRUNE_INTERVAL_MS).toBe(60 * 60 * 1000);
  });

  it('prunes an expired session on its tick', async () => {
    // BREAK: the loop existing but never pruning (wrong dir, swallowed error).
    const id = `periodic-prune-old-${Date.now()}`;
    makeOldSession(id);
    expect(existsSync(join(SESSIONS_DIR, id))).toBe(true);

    startPeriodicPrune(25);
    const gone = await waitFor(() => !existsSync(join(SESSIONS_DIR, id)), 3000);
    expect(gone).toBe(true);
  });

  it('leaves fresh sessions alone on its tick', async () => {
    const id = `periodic-prune-fresh-${Date.now()}`;
    CREATED.add(id);
    const dir = join(SESSIONS_DIR, id);
    mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(
      join(dir, 'session_meta.json'),
      JSON.stringify({
        sessionId: id,
        createdAt: now,
        updatedAt: now,
        status: 'active',
        task: 'fresh session under test',
        totalSteps: 0,
        subTasks: [],
        actions: [],
      }),
      'utf8'
    );

    startPeriodicPrune(25);
    await new Promise((resolve) => setTimeout(resolve, 250));
    // BREAK: a periodic prune that deletes the ACTIVE run it is meant to protect.
    expect(existsSync(dir)).toBe(true);
  });

  it('holds no process reference and stops on request', async () => {
    // BREAK: the timer keeping a test runner or a stopped server alive, or a
    // stop that leaves a stray chain pruning behind the caller's back.
    const timer = startPeriodicPrune(25);
    expect(typeof timer.unref).toBe('function');
    expect(timer.hasRef()).toBe(false);

    // The loop survives repeated ticks without throwing (prune failure must
    // never crash or hang the server).
    await new Promise((resolve) => setTimeout(resolve, 150));

    stopPeriodicPrune();
    const id = `periodic-prune-stopped-${Date.now()}`;
    makeOldSession(id);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(existsSync(join(SESSIONS_DIR, id))).toBe(true);
  });
});
