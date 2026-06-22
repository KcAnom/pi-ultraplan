/**
 * File-backed session store.
 *
 * Sessions live on disk (under .pi/sessions by default) so that every claim the
 * engine makes is verifiable from disk — a poll reads the real recorded state,
 * not an in-memory belief that could drift from reality. It also makes the
 * whole thing survive a process restart: a detached job's result is still there
 * when you come back.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, readdirSync } from 'fs';
import { join } from 'path';
import type { Phase, Plan } from './types.js';

export interface SessionRecord {
  sessionId: string;
  status: Phase;
  prompt: string;
  mode: string;
  model: string;
  provider: string;
  url?: string;
  plan?: Plan;
  error?: string;
  rejectNote?: string;
  /** Live sub-status while status === 'running' (e.g. "planning 3/3"). */
  progress?: string;
  /** Individual planner drafts kept for auditability (verifiable on disk). */
  drafts?: { lens: string; text: string }[];
  /** Adversarial verification verdict on the synthesized plan. votes = the
   *  FINAL round's panel votes. */
  verification?: {
    sound: boolean;
    rounds: number;
    repaired: boolean;
    votes: { lens: string; sound: boolean; issues: string[] }[];
  };
  /** Per-targetFile warnings from validating a structured plan against the repo. */
  planWarnings?: string[];
  /** Repo grounding snapshot captured at launch (Phase 1), when a root is set. */
  snapshot?: { sha: string | null; branch: string | null; dirty: boolean };
  /** Resolved repo root recorded at launch; required to execute the plan. */
  repoRoot?: string;
  /** Result of executing the approved plan (PR or patch + test gate). */
  execResult?: import('./executor.js').ExecResult;
  /** Aggregate cost/usage for this session's model calls (when metered). */
  cost?: { usd: number; promptTokens: number; completionTokens: number };
  /** Last heartbeat timestamp written by the live async job. Used by
   *  the zombie reaper to detect crashed/stranded sessions. */
  lastHeartbeat?: number;
  startedAt: number;
  updatedAt: number;
}

const ROOT = process.env.PI_SESSION_DIR || join(process.env.HOME || process.env.USERPROFILE || process.cwd(), '.pi', 'ultraplan', 'sessions');

function pathFor(sessionId: string): string {
  return join(ROOT, `${sessionId}.json`);
}

export function ensureStore(): void {
  mkdirSync(ROOT, { recursive: true });
}

export function write(rec: SessionRecord): void {
  ensureStore();
  rec.updatedAt = Date.now();
  // Atomic write: temp + rename, so a concurrent poll never reads a half file.
  // Retry once on ENOENT from a concurrent write racing the temp file.
  for (let attempt = 0; attempt < 2; attempt++) {
    const tmp = pathFor(rec.sessionId) + '.tmp';
    writeFileSync(tmp, JSON.stringify(rec, null, 2));
    try {
      renameSync(tmp, pathFor(rec.sessionId));
      return;
    } catch (e) {
      if (attempt === 0) continue;
      throw e;
    }
  }
}

export function read(sessionId: string): SessionRecord | undefined {
  const p = pathFor(sessionId);
  if (!existsSync(p)) return undefined;
  return JSON.parse(readFileSync(p, 'utf8')) as SessionRecord;
}

/** Read-modify-write. Returns the new record, or undefined if it vanished. */
export function update(
  sessionId: string,
  fn: (rec: SessionRecord) => SessionRecord,
): SessionRecord | undefined {
  const cur = read(sessionId);
  if (!cur) return undefined;
  const next = fn(cur);
  write(next);
  return next;
}

/**
 * Max age of a heartbeat before a running session is declared a zombie.
 * Default 120s — generous enough to survive slow API calls, short enough
 * that a crashed subagent is detected quickly.
 */
const HEARTBEAT_TIMEOUT_MS =
  Number(process.env.PI_HEARTBEAT_TIMEOUT_MS) || 120_000;

/**
 * Scan all session files on disk. If a session is 'running' and its
 * heartbeat is older than HEARTBEAT_TIMEOUT_MS, mark it 'failed' with
 * a descriptive error. Returns the count of zombies reaped.
 *
 * Call this on server startup and periodically (e.g. every 60s) so
 * crashed sessions don't show as "running" forever.
 */
export function reapZombies(): number {
  ensureStore();
  let entries: string[];
  try {
    entries = readdirSync(ROOT);
  } catch {
    return 0;
  }
  const now = Date.now();
  let reaped = 0;
  for (const name of entries) {
    if (!name.endsWith('.json') || name.endsWith('.tmp')) continue;
    const sessionId = name.slice(0, -5); // strip .json
    const p = pathFor(sessionId);
    let rec: SessionRecord;
    try {
      rec = JSON.parse(readFileSync(p, 'utf8')) as SessionRecord;
    } catch {
      // Corrupt file: can't parse at all. Delete the .tmp and skip.
      continue;
    }
    if (rec.status !== 'running') continue;
    const hb = rec.lastHeartbeat ?? rec.startedAt;
    if (now - hb > HEARTBEAT_TIMEOUT_MS) {
      rec.status = 'failed';
      rec.error = `session timed out (no heartbeat for ${Math.round((now - hb) / 1000)}s)`;
      rec.updatedAt = now;
      try {
        write(rec);
        reaped += 1;
      } catch {
        // Best effort.
      }
    }
  }
  return reaped;
}

/** Return every session record on disk, with zombies auto-reaped first. */
export function listSessions(): SessionRecord[] {
  reapZombies();
  ensureStore();
  let entries: string[];
  try {
    entries = readdirSync(ROOT);
  } catch {
    return [];
  }
  const out: SessionRecord[] = [];
  for (const name of entries) {
    if (!name.endsWith('.json') || name.endsWith('.tmp')) continue;
    const sessionId = name.slice(0, -5);
    const rec = read(sessionId);
    if (rec) out.push(rec);
  }
  return out;
}
