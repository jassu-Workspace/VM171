import { mkdirSync, writeFileSync, existsSync, readdirSync, statSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, '..', '..');
// Exported (Cycle 2.13) so retention tests can create and assert against real
// session directories without duplicating this path resolution — a second
// copy of the path is another thing that can drift.
//
// SESSION_STORAGE_DIR overrides the root. This exists because the retention
// tests must NEVER write into the operator's real storage: an earlier version
// of them did exactly that, and left residue behind. A test suite that can
// delete real user data is not a test suite, it is a hazard.
export const SESSIONS_DIR = process.env.SESSION_STORAGE_DIR
  ? join(process.env.SESSION_STORAGE_DIR, 'sessions')
  : join(__dirname, '..', 'storage', 'sessions');

export interface StepStorageData {
  sessionId: string;
  step: number;
  task: string;
  subTasks?: string[];
  rawImage?: string;
  maskedImage?: string;
  vlmImage?: string;
  vlmModel?: string;
  promptContext?: string;
  vlmResponse?: string;
  actionJson?: Record<string, unknown>;
}

export interface SessionMeta {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  status: 'active' | 'completed' | 'aborted' | 'error';
  task: string;
  totalSteps: number;
  subTasks: string[];
  actions: Array<{ step: number; action: string; timestamp: string }>;
  summary?: string;
  durationMs?: number;
  imageStats?: {
    rawImagesCount: number;
    maskedImagesCount: number;
    vlmImagesCount: number;
  };
}

/**
 * Initializes a session directory structure under storage/sessions/<sessionId>/
 *
 * Returns the session path, or null when the directory could not be created.
 * A null/boolean RETURN (rather than throwing) is the module-wide contract
 * for write failures: the three saveSessionStep call sites in index.ts sit in
 * the middle of the step pipeline with no try/catch today, so throwing there
 * would either crash into the global 500 handler — turning a disk problem
 * into a failed step and aborting a run that could otherwise conclude — or
 * require a try/catch at every site. A flag the caller logs preserves every
 * route's status code while making the failure visible in the redacting
 * server log and detectable by programmatic callers. No route changes status
 * except init/finalize, which already model failure with their 400 shapes.
 */
export function initSession(sessionId: string, initialTask: string = ''): string | null {
  const safe = safeSessionId(sessionId);
  const sessionPath = join(SESSIONS_DIR, safe);

  try {
    if (!existsSync(sessionPath)) {
      mkdirSync(sessionPath, { recursive: true });
    }

    const subDirs = [
      'raw-images',
      'masked-images',
      'vlm-images',
      'raw_images',
      'masked_images',
      'vlm_images',
      'prompts',
      'responses',
    ];
    for (const sub of subDirs) {
      const p = join(sessionPath, sub);
      if (!existsSync(p)) {
        mkdirSync(p, { recursive: true });
      }
    }

    const metaFile = join(sessionPath, 'session_meta.json');
    if (!existsSync(metaFile)) {
      const meta: SessionMeta = {
        sessionId: safe,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: 'active',
        task: initialTask,
        totalSteps: 0,
        subTasks: [],
        actions: [],
        imageStats: {
          rawImagesCount: 0,
          maskedImagesCount: 0,
          vlmImagesCount: 0,
        },
      };
      writeFileSync(metaFile, JSON.stringify(meta, null, 2), 'utf8');
    }

    if (initialTask) {
      writeFileSync(join(sessionPath, 'prompts', 'user_goal.txt'), initialTask, 'utf8');
    }
  } catch {
    // Propagate as null: the caller logs via the redacting server log (a
    // console.warn here would bypass it) and the /api/session/init route maps
    // null to its existing 400 shape. Returning a path for a directory that
    // was never created would be a lie the audit trail cannot afford.
    return null;
  }

  return sessionPath;
}

/**
 * Saves all artifacts for a specific agent execution step:
 * raw images, masked images, vlm images, prompts, and VLM responses.
 *
 * Returns true when every write landed, false when any write failed — see the
 * contract note on initSession for why a flag, not a throw. A partial write
 * still returns false even when later writes succeed, so the caller can never
 * mistake a degraded audit trail for a complete one.
 */
export function saveSessionStep(data: StepStorageData): boolean {
  // Set by the per-image catch below: an image that failed to decode or land
  // must not be silently absorbed into an overall success.
  let failed = false;
  try {
    const safe = safeSessionId(data.sessionId);
    const sessionPath = initSession(safe, data.task);
    // initSession signals failure with null (never a throw); without a
    // directory every write below would throw, so fail fast and say so.
    if (sessionPath === null) return false;

    // Helper function to decode and save base64 image across directory targets
    const saveImageToDirs = (dirs: string[], filename: string, base64Str: string): number => {
      try {
        const cleanBase64 = base64Str.replace(/^data:image\/\w+;base64,/, '').trim();
        if (cleanBase64.length > 50) {
          const buffer = Buffer.from(cleanBase64, 'base64');
          for (const dir of dirs) {
            const dirPath = join(sessionPath, dir);
            if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true });
            writeFileSync(join(dirPath, filename), buffer);
          }
          return buffer.length;
        }
      } catch {
        // Propagate to the return flag: the caller logs via the redacting
        // server log. Swallowing here reported a complete audit trail while
        // frames were missing from disk.
        failed = true;
      }
      return 0;
    };

    // 1. Raw Picture: Must store every unredacted screenshot taken
    if (data.rawImage && data.rawImage.trim().length > 50) {
      saveImageToDirs(['raw-images', 'raw_images'], `step_${data.step}_raw.jpg`, data.rawImage);
    }

    // 2. Masked Picture: If any images are masked, store them in masked-images folder
    if (data.maskedImage && data.maskedImage.trim().length > 50) {
      saveImageToDirs(['masked-images', 'masked_images'], `step_${data.step}_masked.jpg`, data.maskedImage);
    }

    // 3. VLM Image: The exact image payload transmitted to the VLM (local or hosted)
    const vlmPayload = data.vlmImage || data.maskedImage || data.rawImage;
    if (vlmPayload && vlmPayload.trim().length > 50) {
      const vlmBytes = saveImageToDirs(['vlm-images', 'vlm_images'], `step_${data.step}_vlm.jpg`, vlmPayload);
      const vlmMeta = {
        step: data.step,
        timestamp: new Date().toISOString(),
        byteSize: vlmBytes,
        isMasked: Boolean(data.maskedImage && data.maskedImage.trim().length > 50),
        model: data.vlmModel || 'vlm-hybrid',
        hasRawOriginal: Boolean(data.rawImage && data.rawImage.trim().length > 50),
      };
      for (const dir of ['vlm-images', 'vlm_images']) {
        const dirPath = join(sessionPath, dir);
        if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true });
        writeFileSync(join(dirPath, `step_${data.step}_vlm_meta.json`), JSON.stringify(vlmMeta, null, 2), 'utf8');
      }
    }

    // 3. User Prompt & Subtasks in TXT
    if (data.task) {
      writeFileSync(join(sessionPath, 'prompts', 'user_goal.txt'), data.task, 'utf8');
    }

    if (data.subTasks && data.subTasks.length > 0) {
      const subtasksText = data.subTasks.map((st, i) => `Milestone ${i + 1}: ${st}`).join('\n');
      writeFileSync(join(sessionPath, 'prompts', 'subtasks.txt'), subtasksText, 'utf8');
    }

    if (data.promptContext) {
      writeFileSync(join(sessionPath, 'prompts', `step_${data.step}_context.txt`), data.promptContext, 'utf8');
    }

    // 4. Response generated by the server VLM in TXT and JSON
    if (data.vlmResponse) {
      writeFileSync(join(sessionPath, 'responses', `step_${data.step}_vlm_response.txt`), data.vlmResponse, 'utf8');
    }

    if (data.actionJson) {
      writeFileSync(join(sessionPath, 'responses', `step_${data.step}_action.json`), JSON.stringify(data.actionJson, null, 2), 'utf8');
    }

    // 5. Update session_meta.json
    const metaFile = join(sessionPath, 'session_meta.json');
    let meta: SessionMeta;
    if (existsSync(metaFile)) {
      try {
        meta = JSON.parse(readFileSync(metaFile, 'utf8'));
      } catch {
        meta = {
          sessionId: safe,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          status: 'active',
          task: data.task,
          totalSteps: 0,
          subTasks: [],
          actions: [],
        };
      }
    } else {
      meta = {
        sessionId: safe,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: 'active',
        task: data.task,
        totalSteps: 0,
        subTasks: [],
        actions: [],
      };
    }

    meta.updatedAt = new Date().toISOString();
    meta.totalSteps = Math.max(meta.totalSteps, data.step);
    if (data.subTasks && data.subTasks.length > 0) {
      meta.subTasks = data.subTasks;
    }
    if (data.actionJson && data.actionJson.action) {
      meta.actions.push({
        step: data.step,
        action: String(data.actionJson.action),
        timestamp: new Date().toISOString(),
      });
    }

    const countJpgs = (sub: string) => {
      try {
        const p = join(sessionPath, sub);
        return existsSync(p) ? readdirSync(p).filter((f) => f.endsWith('.jpg')).length : 0;
      } catch {
        return 0;
      }
    };
    meta.imageStats = {
      rawImagesCount: Math.max(countJpgs('raw-images'), countJpgs('raw_images')),
      maskedImagesCount: Math.max(countJpgs('masked-images'), countJpgs('masked_images')),
      vlmImagesCount: Math.max(countJpgs('vlm-images'), countJpgs('vlm_images')),
    };

    writeFileSync(metaFile, JSON.stringify(meta, null, 2), 'utf8');

    return !failed;
  } catch {
    // Propagate as false: the step-pipeline callers log via the redacting
    // server log and keep their 200s (an audit-write failure must not abort
    // the run), while tests and tools can detect the failure directly.
    return false;
  }
}

/**
 * Finalizes the session with completed or aborted status.
 *
 * Returns true when the metadata write landed (or there was nothing to
 * write), false when it failed — same flag-not-throw contract as initSession:
 * the /api/session/finalize route maps false to its existing 400 shape.
 */
export function finalizeSession(sessionId: string, status: 'completed' | 'aborted' | 'error', summary?: string): boolean {
  try {
    const safe = safeSessionId(sessionId);
    const sessionPath = join(SESSIONS_DIR, safe);
    const metaFile = join(sessionPath, 'session_meta.json');

    if (existsSync(metaFile)) {
      const meta: SessionMeta = JSON.parse(readFileSync(metaFile, 'utf8'));
      meta.status = status;
      meta.updatedAt = new Date().toISOString();
      if (meta.createdAt) {
        meta.durationMs = Math.max(0, new Date(meta.updatedAt).getTime() - new Date(meta.createdAt).getTime());
      }
      if (summary) meta.summary = summary;
      writeFileSync(metaFile, JSON.stringify(meta, null, 2), 'utf8');
    }
    return true;
  } catch {
    // Propagate as false; the caller logs via the redacting server log.
    return false;
  }
}

export const initSessionDir = initSession;

/**
 * Cycle 2.13: the traversal sanitiser is now a named, exported, TESTABLE
 * function rather than an inline `.replace()` repeated at three call sites.
 *
 * This is the only thing standing between a client-supplied `sessionId` and the
 * filesystem. It was correct before; it is now asserted by tests AND mutation-
 * proven, so a future refactor that inlines it again cannot silently drop it.
 * Everything outside [A-Za-z0-9_-] becomes '_', which also collapses '/' and
 * '\' and so neutralises '..' traversal on both POSIX and Windows.
 */
export function safeSessionId(sessionId: string): string {
  return String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Calculates storage statistics across all saved sessions for the dashboard
 */
export function getStorageStats(): { sessionsCount: number; totalDiskBytes: number } {
  try {
    if (!existsSync(SESSIONS_DIR)) {
      return { sessionsCount: 0, totalDiskBytes: 0 };
    }

    const entries = readdirSync(SESSIONS_DIR);
    let count = 0;
    let totalBytes = 0;

    function calculateDirSize(dirPath: string): number {
      let bytes = 0;
      try {
        const files = readdirSync(dirPath);
        for (const file of files) {
          const fullPath = join(dirPath, file);
          const st = statSync(fullPath);
          if (st.isDirectory()) {
            bytes += calculateDirSize(fullPath);
          } else {
            bytes += st.size;
          }
        }
      } catch {
        // ignore
      }
      return bytes;
    }

    for (const entry of entries) {
      const fullPath = join(SESSIONS_DIR, entry);
      try {
        const st = statSync(fullPath);
        if (st.isDirectory()) {
          count += 1;
          totalBytes += calculateDirSize(fullPath);
        }
      } catch {
        // ignore
      }
    }

    return { sessionsCount: count, totalDiskBytes: totalBytes };
  } catch (err) {
    console.warn('[sessionStorage] getStorageStats failed:', err);
    return { sessionsCount: 0, totalDiskBytes: 0 };
  }
}

/**
 * Returns all saved sessions sorted by most recent
 */
export function listSessions(): SessionMeta[] {
  try {
    if (!existsSync(SESSIONS_DIR)) return [];
    const entries = readdirSync(SESSIONS_DIR);
    const sessions: SessionMeta[] = [];
    for (const entry of entries) {
      const metaFile = join(SESSIONS_DIR, entry, 'session_meta.json');
      if (existsSync(metaFile)) {
        try {
          const meta: SessionMeta = JSON.parse(readFileSync(metaFile, 'utf8'));
          sessions.push(meta);
        } catch {
          // ignore
        }
      }
    }
    return sessions.sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime());
  } catch {
    return [];
  }
}

/**
 * Retrieves detailed session data including step artifacts
 */
export function getSessionDetails(sessionId: string): {
  meta: SessionMeta;
  steps: Array<{
    step: number;
    hasRawImage: boolean;
    hasMaskedImage: boolean;
    hasVlmImage: boolean;
    action?: Record<string, unknown>;
  }>;
} | null {
  try {
    const safe = safeSessionId(sessionId);
    const sessionPath = join(SESSIONS_DIR, safe);
    const metaFile = join(sessionPath, 'session_meta.json');
    if (!existsSync(metaFile)) return null;

    const meta: SessionMeta = JSON.parse(readFileSync(metaFile, 'utf8'));
    const steps: Array<{
      step: number;
      hasRawImage: boolean;
      hasMaskedImage: boolean;
      hasVlmImage: boolean;
      action?: Record<string, unknown>;
    }> = [];

    for (let s = 1; s <= meta.totalSteps; s++) {
      const rawImg =
        existsSync(join(sessionPath, 'raw-images', `step_${s}_raw.jpg`)) ||
        existsSync(join(sessionPath, 'raw_images', `step_${s}_raw.jpg`));
      const maskedImg =
        existsSync(join(sessionPath, 'masked-images', `step_${s}_masked.jpg`)) ||
        existsSync(join(sessionPath, 'masked_images', `step_${s}_masked.jpg`));
      const vlmImg =
        existsSync(join(sessionPath, 'vlm-images', `step_${s}_vlm.jpg`)) ||
        existsSync(join(sessionPath, 'vlm_images', `step_${s}_vlm.jpg`));

      let action: Record<string, unknown> | undefined;
      const actionFile = join(sessionPath, 'responses', `step_${s}_action.json`);
      if (existsSync(actionFile)) {
        try {
          action = JSON.parse(readFileSync(actionFile, 'utf8'));
        } catch {
          // ignore
        }
      }
      steps.push({
        step: s,
        hasRawImage: rawImg,
        hasMaskedImage: maskedImg,
        hasVlmImage: vlmImg,
        action,
      });
    }

    return { meta, steps };
  } catch {
    return null;
  }
}

/**
 * Prune stored sessions — Cycle 2.13.
 *
 * Every session directory holds un-redacted `raw-images/` alongside the masked
 * frames, plus VLM responses and the user's raw task text. That is exactly the
 * material this project exists to keep local, and it previously accumulated
 * without limit: three JPEGs per step with MAX_STEPS=35 means a single long run
 * is ~10 MB, and the directory was committed to git until the Cycle 1 hygiene
 * work. Retention is therefore a security control here, not housekeeping.
 *
 * Ordering: age first, then count. A session can fail either test; applying
 * count after age means the cap is evaluated against what actually survived.
 *
 * Two deliberate refusals to delete:
 *   - a directory with no session_meta.json — that is a session an in-flight
 *     step is still creating, and deleting it would break the active run
 *   - a session_meta.json that will not parse — corrupt JSON must not become
 *     silent deletion of real user data
 */
function parseRetentionNumeric(raw: string | undefined, defaultValue: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return defaultValue;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
    console.warn(`[sessionStorage] Invalid ${name}="${raw}". Expected non-negative integer. Falling back to default (${defaultValue}).`);
    return defaultValue;
  }
  return parsed;
}

export const DEFAULT_RETENTION_DAYS = parseRetentionNumeric(process.env.SESSION_RETENTION_DAYS, 7, 'SESSION_RETENTION_DAYS');
export const DEFAULT_MAX_SESSIONS = parseRetentionNumeric(process.env.MAX_SESSIONS, 100, 'MAX_SESSIONS');

export interface PruneOptions {
  retentionDays?: number;
  maxSessions?: number;
}

export interface PruneResult {
  removed: number;
  remaining: number;
}

export function pruneSessions(options: PruneOptions = {}): PruneResult {
  const retentionDays =
    typeof options.retentionDays === 'number' && Number.isFinite(options.retentionDays)
      ? options.retentionDays
      : parseRetentionNumeric(process.env.SESSION_RETENTION_DAYS, 7, 'SESSION_RETENTION_DAYS');

  const maxSessions =
    typeof options.maxSessions === 'number' && Number.isFinite(options.maxSessions)
      ? options.maxSessions
      : parseRetentionNumeric(process.env.MAX_SESSIONS, 100, 'MAX_SESSIONS');

  const removed: string[] = [];

  try {
    if (!existsSync(SESSIONS_DIR)) return { removed: 0, remaining: 0 };

    const now = Date.now();
    const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
    const survivors: Array<{ id: string; stamp: number }> = [];

    for (const entry of readdirSync(SESSIONS_DIR)) {
      const metaFile = join(SESSIONS_DIR, entry, 'session_meta.json');

      // Refuse to delete an in-flight session: no metadata means a step is
      // still being written.
      if (!existsSync(metaFile)) continue;

      let meta: SessionMeta;
      try {
        meta = JSON.parse(readFileSync(metaFile, 'utf8'));
      } catch {
        // Corrupt metadata is not evidence of an expired session.
        continue;
      }

      // updatedAt wins over createdAt so a long-running agent loop is not
      // deleted mid-run just because it started a week ago.
      const stampSource = meta.updatedAt || meta.createdAt;
      const stamp = stampSource ? new Date(stampSource).getTime() : NaN;

      if (Number.isNaN(stamp)) continue;

      if (stamp < cutoff) {
        try {
          rmSync(join(SESSIONS_DIR, entry), { recursive: true, force: true });
          removed.push(entry);
        } catch {
          // A session we cannot remove is not fatal; skip it.
        }
        continue;
      }

      survivors.push({ id: entry, stamp });
    }

    // Count cap: newest kept, oldest evicted.
    survivors.sort((a, b) => b.stamp - a.stamp);
    const keep = survivors.slice(0, Math.max(0, maxSessions));
    for (const victim of survivors.slice(keep.length)) {
      try {
        rmSync(join(SESSIONS_DIR, victim.id), { recursive: true, force: true });
        removed.push(victim.id);
      } catch {
        // ignore
      }
    }

    return { removed: removed.length, remaining: keep.length };
  } catch {
    // Never throw into the request pipeline or the boot sequence.
    return { removed: removed.length, remaining: 0 };
  }
}
