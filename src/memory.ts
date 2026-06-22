import fs from 'node:fs';
import path from 'node:path';

const FILE = process.env.PI_MEMORY_FILE || path.join(process.env.HOME || process.env.USERPROFILE || process.cwd(), '.pi', 'ultraplan', 'memory.jsonl');

export interface MemoryEntry {
  id: string;
  kind: 'rejected' | 'convention' | 'note';
  text: string;
  createdAt: number;
}

let counter = 0;

// Append one JSONL entry; best-effort, never throws. Empty text is skipped.
export function addMemory(kind: MemoryEntry['kind'], text: string): void {
  if (!text || !text.trim()) return;
  const entry: MemoryEntry = {
    id: `${++counter}-${Date.now()}`,
    kind,
    text,
    createdAt: Date.now(),
  };
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.appendFileSync(FILE, JSON.stringify(entry) + '\n');
  } catch (e) {
    // best-effort: log to stderr so memory loss is never silent
    console.error(`[ultraplan:memory] failed to write memory entry: ${e instanceof Error ? e.message : e}`);
  }
}

// Read entries, skipping corrupt lines; return the most recent `limit`. Never throws.
export function getMemories(limit = 20): MemoryEntry[] {
  let raw: string;
  try {
    if (!fs.existsSync(FILE)) return [];
    raw = fs.readFileSync(FILE, 'utf8');
  } catch {
    return [];
  }
  const entries: MemoryEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as MemoryEntry;
      entries.push(parsed);
    } catch {
      // skip corrupt line
    }
  }
  return entries.slice(-limit);
}

// Compact block to prepend to a planner prompt; '' when no memories.
export function renderMemoryBlock(limit = 8): string {
  const entries = getMemories(limit);
  if (entries.length === 0) return '';
  const bullets = entries.map((e) => `- [${e.kind}] ${e.text}`).join('\n');
  return `Project memory — lessons from prior runs (honor these):\n${bullets}`;
}
