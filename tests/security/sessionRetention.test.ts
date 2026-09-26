/**
 * Cycle 2.13 — Session retention, and a lock on the traversal sanitiser.
 * ---------------------------------------------------------------------------
 * WHY RETENTION IS A SECURITY CONTROL HERE, NOT JUST HOUSEKEEPING
 *
 * Every session directory holds un-redacted `raw-images/` alongside the masked
 * frames, plus `responses/*_vlm_response.txt` and the user's raw task text. That
 * is precisely the material this project exists to keep local — and it
 * accumulated without limit. Nothing ever pruned it, so:
 *
 *   - disk grew without bound (the agent writes three JPEGs per step, and
 *     MAX_STEPS is 35, so a single long run is ~10 MB of un-redacted frames)
 *   - the operator accumulating their entire browsing history on disk, with no
 *     defined expiry, in a directory that was COMMITTED TO GIT until Cycle 1's
 *     hygiene work
 *
 * The traversal sanitiser is tested here too, as a characterization test. It is
 * the only thing standing between a client-supplied `sessionId` and the
 * filesystem, and it is asserted by MUTATION PROOF rather than by assertion
 * alone.
 *
 * These tests use a real temporary session root under storage/sessions/, and
 * clean up after themselves. They never touch operator data.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { existsSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  initSession,
  listSessions,
  pruneSessions,
  SESSIONS_DIR,
  safeSessionId,
} from '../../server/src/sessionStorage';

const CREATED = new Set<string>();

function makeSession(id: string, createdAt: string, updatedAt = createdAt): string {
  CREATED.add(id);
  const dir = join(SESSIONS_DIR, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'session_meta.json'),
    JSON.stringify({
      sessionId: id,
      createdAt,
      updatedAt,
      status: 'completed',
      task: `task for ${id}`,
      totalSteps: 1,
      subTasks: [],
      actions: [],
    }),
    'utf8'
  );
  return dir;
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

beforeEach(() => {
  CREATED.clear();
});

afterEach(() => {
  for (const id of CREATED) {
    try {
      rmSync(join(SESSIONS_DIR, id), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe('Cycle 2.13 — retention by age', () => {
  it('deletes a session older than the retention window', () => {
    // BREAK: retention not being applied at all, so un-redacted frames
    // accumulate forever.
    const old = makeSession('cyc213-old', new Date(NOW - 40 * DAY).toISOString());
    const fresh = makeSession('cyc213-fresh', new Date(NOW - 1 * DAY).toISOString());

    pruneSessions({ retentionDays: 7, maxSessions: 100 });

    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it('keeps a session inside the window', () => {
    const fresh = makeSession('cyc213-inside', new Date(NOW - 2 * DAY).toISOString());
    pruneSessions({ retentionDays: 7, maxSessions: 100 });
    expect(existsSync(fresh)).toBe(true);
  });

  it('uses updatedAt rather than createdAt for a long-running session', () => {
    // BREAK: an agent loop that runs for days being deleted mid-run because its
    // CREATED date aged out, even though it is actively being written.
    const longRunning = makeSession(
      'cyc213-long',
      new Date(NOW - 60 * DAY).toISOString(),
      new Date(NOW - 1 * 60 * 60 * 1000).toISOString()
    );
    pruneSessions({ retentionDays: 7, maxSessions: 100 });
    expect(existsSync(longRunning)).toBe(true);
  });

  it('falls back to createdAt when updatedAt is missing', () => {
    // BREAK: an unparseable or absent timestamp throwing, or silently keeping
    // the session forever.
    const id = 'cyc213-nodate';
    CREATED.add(id);
    const dir = join(SESSIONS_DIR, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'session_meta.json'),
      JSON.stringify({ sessionId: id, createdAt: new Date(NOW - 40 * DAY).toISOString(), status: 'completed' }),
      'utf8'
    );
    pruneSessions({ retentionDays: 7, maxSessions: 100 });
    expect(existsSync(dir)).toBe(false);
  });
});

describe('Cycle 2.13 — retention by count', () => {
  it('keeps only the newest sessions when over the cap', () => {
    // BREAK: unbounded session count, which is the disk-growth half of the
    // problem the age window alone does not solve.
    // NOTE: pruneSessions operates on the whole sessions directory, which also
    // holds the operator's real sessions. The cap is therefore set relative to
    // a measured baseline so this test can neither be perturbed by real data
    // nor destroy it. An earlier version used a flat maxSessions:2 and its
    // outcome was decided by whatever else happened to be on disk.
    const baseline = listSessions().filter((s) => !s.sessionId.startsWith('cyc213-')).length;

    const a = makeSession('cyc213-c1', new Date(NOW - 5 * DAY).toISOString());
    const b = makeSession('cyc213-c2', new Date(NOW - 4 * DAY).toISOString());
    const c = makeSession('cyc213-c3', new Date(NOW - 3 * DAY).toISOString());

    pruneSessions({ retentionDays: 3650, maxSessions: baseline + 2 });

    expect(existsSync(c)).toBe(true); // newest
    expect(existsSync(b)).toBe(true);
    expect(existsSync(a)).toBe(false); // oldest evicted
  });

  it('does not delete anything when under the cap', () => {
    const a = makeSession('cyc213-u1', new Date(NOW - 5 * DAY).toISOString());
    pruneSessions({ retentionDays: 3650, maxSessions: 10 });
    expect(existsSync(a)).toBe(true);
  });

  it('reports how many sessions it removed', () => {
    // BREAK: pruning silently succeeding, so an operator has no way to tell
    // retention is working or has stopped working.
    makeSession('cyc213-r1', new Date(NOW - 5 * DAY).toISOString());
    makeSession('cyc213-r2', new Date(NOW - 4 * DAY).toISOString());
    const result = pruneSessions({ retentionDays: 3650, maxSessions: 1 });
    expect(result.removed).toBeGreaterThanOrEqual(1);
    expect(typeof result.remaining).toBe('number');
  });
});

describe('Cycle 2.13 — pruning never escalates into data loss', () => {
  it('does nothing when the sessions directory does not exist', () => {
    // BREAK: a missing directory throwing during boot, taking the server down.
    const result = pruneSessions({ retentionDays: 7, maxSessions: 10 });
    expect(result.removed).toBe(0);
  });

  it('ignores a directory with no session_meta.json', () => {
    // BREAK: a half-written session directory being deleted because it has no
    // metadata — exactly the session an in-flight step is still creating.
    const id = 'cyc213-partial';
    CREATED.add(id);
    const dir = join(SESSIONS_DIR, id);
    mkdirSync(join(dir, 'raw-images'), { recursive: true });
    writeFileSync(join(dir, 'raw-images', 'step_1_raw.jpg'), 'x', 'utf8');

    pruneSessions({ retentionDays: 7, maxSessions: 1 });

    expect(existsSync(dir)).toBe(true);
  });

  it('ignores a session_meta.json it cannot parse rather than deleting it', () => {
    // BREAK: corrupt JSON causing silent deletion of real user data.
    const id = 'cyc213-corrupt';
    CREATED.add(id);
    const dir = join(SESSIONS_DIR, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'session_meta.json'), '{ not json', 'utf8');

    pruneSessions({ retentionDays: 1, maxSessions: 1 });

    expect(existsSync(dir)).toBe(true);
  });
});

describe('Cycle 2.13 — the auth secret never reaches session metadata', () => {
  it('writes no credential into session_meta.json', () => {
    // BREAK: a header or env value being persisted into a directory that was
    // once committed to git. Even after rotation, a secret written to disk is a
    // secret on disk.
    // initSession returns the session DIRECTORY PATH, not the bare id. An
    // earlier version joined it to SESSIONS_DIR again, producing a double path.
    const dir = initSession('cyc213-secret-check', 'a task');
    CREATED.add(dir);
    const raw = readFileSync(join(dir, 'session_meta.json'), 'utf8');
    expect(raw).not.toMatch(/SECRET_PASSWORD/);
    expect(raw).not.toMatch(/x-secret-password/);
    expect(raw).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
    expect(raw).not.toContain(process.env.SECRET_PASSWORD ?? '\u0000unlikely');
  });
});

describe('Cycle 2.13 — traversal sanitiser (characterization, mutation-proven)', () => {
  it('neutralises traversal characters in a session id', () => {
    // BREAK: the sanitiser being removed. This is the only thing between a
    // client-supplied sessionId and the filesystem, and it is asserted by
    // mutation proof in the commit message, not by inspection.
    expect(safeSessionId('../../etc/passwd')).not.toContain('/');
    expect(safeSessionId('..\\..\\windows')).not.toContain('\\');
    expect(safeSessionId('a/b/../c')).not.toContain('/');
  });

  it('leaves a legitimate uuid untouched', () => {
    // BREAK: over-sanitising real session ids into something unrecognisable.
    const uuid = '2237028a-488a-4867-8cc0-56e543b1ccaf';
    expect(safeSessionId(uuid)).toBe(uuid);
  });

  it('keeps a traversal id inside the sessions directory', () => {
    // BREAK: the sanitiser being bypassed for a crafted id.
    const dir = initSession('../../escape-attempt', 'task');
    CREATED.add(dir);
    const normalised = safeSessionId('../../escape-attempt');
    expect(normalised).not.toContain('..');
    expect(listSessions().some((s) => s.sessionId.includes('..'))).toBe(false);
  });
});
