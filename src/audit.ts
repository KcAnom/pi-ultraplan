import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { redactObject } from './redact.js';

const FILE = process.env.PI_AUDIT_FILE || path.join(process.env.HOME || process.env.USERPROFILE || process.cwd(), '.pi', 'ultraplan', 'audit.jsonl');

export interface AuditEntry {
  ts: number;
  event: string;
  sessionId?: string;
  details?: Record<string, unknown>;
}

/** Append one audit entry as a JSONL line. Best-effort: never throws. */
export function audit(event: string, sessionId?: string, details?: Record<string, unknown>): void {
  try {
    const entry: AuditEntry = {
      ts: Date.now(),
      event,
      sessionId,
      details: details ? redactObject(details) : undefined,
    };
    mkdirSync(path.dirname(FILE), { recursive: true });
    appendFileSync(FILE, JSON.stringify(entry) + '\n');
  } catch (e) {
    // Auditing must not break the pipeline, but must not fail silently either.
    console.error(`[ultraplan:audit] failed to write audit entry "${event}": ${e instanceof Error ? e.message : e}`);
  }
}

/** Read + parse the audit JSONL. Skips corrupt lines; missing file -> []. Never throws. */
export function readAudit(): AuditEntry[] {
  let raw: string;
  try {
    raw = readFileSync(FILE, 'utf8');
  } catch {
    return [];
  }
  const entries: AuditEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as AuditEntry);
    } catch {
      // Skip corrupt line.
    }
  }
  return entries;
}
