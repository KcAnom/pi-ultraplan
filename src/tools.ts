import * as fs from 'node:fs';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';

export interface ChatTool {
  type: 'function';
  function: { name: string; description: string; parameters: object };
}

export interface ToolModule {
  definitions: ChatTool[];
  execute(name: string, args: Record<string, unknown>): Promise<string>;
}

const EXCLUDED = new Set(['node_modules', '.git', '.pi', 'dist']);

// Skip lines longer than this in grep — a secondary bound only.
const MAX_GREP_LINE_LEN = 2000;
// Hard wall-clock budget for a grep. The line-length cap alone does NOT stop
// ReDoS: the model controls the pattern, and a catastrophic pattern (e.g.
// /(a+)+$/) backtracks exponentially on an ordinary ~60-char line (~100s).
// JS regex is synchronous, so the only reliable interrupt is to run the match
// in a worker thread the main thread can terminate when it blows the budget.
const GREP_TIMEOUT_MS = 2500;

// Worker body (plain CommonJS, run via { eval: true } so no TS loader is needed
// in the worker). Walks the sandbox root and matches; the parent kills it if it
// exceeds GREP_TIMEOUT_MS.
const GREP_WORKER_SRC = `(function () {
  const { parentPort, workerData } = require('worker_threads');
  const fs = require('fs');
  const path = require('path');
  const { root, pattern, globSource, globFlags, excluded, maxLen, maxMatches } = workerData;
  const ex = new Set(excluded);
  let re;
  try { re = new RegExp(pattern); } catch (e) { parentPort.postMessage('error: invalid regex: ' + e.message); return; }
  const globRe = globSource ? new RegExp(globSource, globFlags) : null;
  function* walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      if (ex.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) yield* walk(full);
      else if (ent.isFile()) yield full;
    }
  }
  function looksBinary(buf) {
    const n = Math.min(buf.length, 4096);
    for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
    return false;
  }
  const matches = [];
  outer: for (const file of walk(root)) {
    const rel = path.relative(root, file);
    if (globRe && !globRe.test(rel)) continue;
    let buf;
    try { buf = fs.readFileSync(file); } catch (e) { continue; }
    if (looksBinary(buf)) continue;
    const lines = buf.toString('utf8').split('\\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length > maxLen) continue;
      if (re.test(line)) {
        matches.push(rel + ':' + (i + 1) + ': ' + line.trim());
        if (matches.length >= maxMatches) break outer;
      }
    }
  }
  parentPort.postMessage(matches.join('\\n'));
})();`;

export function createRepoTools(root: string): ToolModule {
  // Canonical root for prefix checks; fall back to resolved if it doesn't exist yet.
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    realRoot = path.resolve(root);
  }

  // Resolve an incoming path inside the sandbox. Returns the safe absolute path,
  // or an Error whose message is the error string to surface to the caller.
  function safeResolve(p: string): string | Error {
    const resolved = path.resolve(realRoot, p);
    // For symlink escape: realpath the deepest existing ancestor.
    let probe = resolved;
    let real: string | null = null;
    while (true) {
      try {
        real = fs.realpathSync(probe);
        break;
      } catch {
        const parent = path.dirname(probe);
        if (parent === probe) break; // hit filesystem root
        probe = parent;
      }
    }
    // Combine the real ancestor with the remaining (non-existent) suffix.
    let canonical: string;
    if (real === null) {
      canonical = resolved;
    } else if (probe === resolved) {
      canonical = real;
    } else {
      const suffix = path.relative(probe, resolved);
      canonical = path.resolve(real, suffix);
    }
    if (canonical !== realRoot && !canonical.startsWith(realRoot + path.sep)) {
      return new Error(`error: path escapes sandbox root: ${p}`);
    }
    return canonical;
  }

  function isExcluded(name: string): boolean {
    return EXCLUDED.has(name);
  }

  function listDir(p: string): string {
    const target = safeResolve(p);
    if (target instanceof Error) return target.message;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(target, { withFileTypes: true });
    } catch (e) {
      return `error: cannot list directory: ${(e as Error).message}`;
    }
    const lines: string[] = [];
    for (const ent of entries) {
      if (isExcluded(ent.name)) continue;
      const kind = ent.isDirectory() ? 'dir' : 'file';
      lines.push(`${ent.name} (${kind})`);
    }
    lines.sort();
    return lines.join('\n');
  }

  function readFile(p: string, maxBytes: number): string {
    const target = safeResolve(p);
    if (target instanceof Error) return target.message;
    let buf: Buffer;
    try {
      buf = fs.readFileSync(target);
    } catch (e) {
      return `error: cannot read file: ${(e as Error).message}`;
    }
    if (buf.length > maxBytes) {
      return buf.subarray(0, maxBytes).toString('utf8') + '\n…[truncated]';
    }
    return buf.toString('utf8');
  }

  function grep(pattern: string, glob?: string): Promise<string> {
    // Compile-check up front for a clean error message (compiling a regex does
    // not execute it, so this is cheap and safe).
    try {
      new RegExp(pattern);
    } catch (e) {
      return Promise.resolve(`error: invalid regex: ${(e as Error).message}`);
    }
    let globRe: RegExp | null = null;
    if (glob) {
      try {
        globRe = globToRegExp(glob);
      } catch (e) {
        return Promise.resolve(`error: invalid glob: ${(e as Error).message}`);
      }
    }
    // Run the actual matching in a worker under a hard wall-clock budget. If a
    // catastrophic pattern blows the budget, terminate the worker and surface a
    // timeout — the main thread (and the whole dispatcher) stays responsive.
    return new Promise<string>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (value: string, w?: Worker) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void w?.terminate();
        resolve(value);
      };
      const worker = new Worker(GREP_WORKER_SRC, {
        eval: true,
        workerData: {
          root: realRoot,
          pattern,
          globSource: globRe ? globRe.source : null,
          globFlags: globRe ? globRe.flags : '',
          excluded: [...EXCLUDED],
          maxLen: MAX_GREP_LINE_LEN,
          maxMatches: 100,
        },
      });
      timer = setTimeout(
        () =>
          finish(
            'error: grep timed out — pattern too expensive (possible ReDoS); narrow the pattern',
            worker,
          ),
        GREP_TIMEOUT_MS,
      );
      worker.on('message', (msg: unknown) =>
        finish(typeof msg === 'string' ? msg : String(msg), worker),
      );
      worker.on('error', (e) => finish(`error: grep failed: ${(e as Error).message}`, worker));
      worker.on('exit', () => finish('', worker));
    });
  }

  // Minimal glob -> RegExp matched against relative paths. Supports * and ?.
  function globToRegExp(glob: string): RegExp {
    let out = '';
    for (let i = 0; i < glob.length; i++) {
      const c = glob[i];
      if (c === '*') {
        if (glob[i + 1] === '*') {
          out += '.*';
          i++;
          if (glob[i + 1] === '/') i++;
        } else {
          out += '[^/]*';
        }
      } else if (c === '?') {
        out += '[^/]';
      } else if ('.+^${}()|[]\\'.includes(c)) {
        out += '\\' + c;
      } else {
        out += c;
      }
    }
    return new RegExp('^' + out + '$');
  }

  const definitions: ChatTool[] = [
    {
      type: 'function',
      function: {
        name: 'list_dir',
        description:
          'List the immediate entries of a directory inside the repository. Returns each entry as "name (dir|file)".',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Directory path relative to the repository root. Defaults to ".".',
            },
          },
          required: [],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description:
          'Read the contents of a file inside the repository, truncated to maxBytes.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'File path relative to the repository root.',
            },
            maxBytes: {
              type: 'number',
              description: 'Maximum number of bytes to return (default 50000).',
            },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'grep',
        description:
          'Search file contents under the repository root with a JavaScript regular expression. Returns up to 100 matches as "relpath:line: <trimmed line>".',
        parameters: {
          type: 'object',
          properties: {
            pattern: {
              type: 'string',
              description: 'JavaScript regular expression to search for.',
            },
            glob: {
              type: 'string',
              description:
                'Optional glob (supports * ** ?) to restrict matched files by relative path.',
            },
          },
          required: ['pattern'],
          additionalProperties: false,
        },
      },
    },
  ];

  async function execute(name: string, args: Record<string, unknown>): Promise<string> {
    try {
      const a = args ?? {};
      switch (name) {
        case 'list_dir': {
          const p = typeof a.path === 'string' ? a.path : '.';
          return listDir(p);
        }
        case 'read_file': {
          if (typeof a.path !== 'string') return 'error: "path" must be a string';
          let maxBytes = 50000;
          if (a.maxBytes !== undefined) {
            if (typeof a.maxBytes !== 'number' || !Number.isFinite(a.maxBytes) || a.maxBytes < 0) {
              return 'error: "maxBytes" must be a non-negative number';
            }
            maxBytes = Math.floor(a.maxBytes);
          }
          return readFile(a.path, maxBytes);
        }
        case 'grep': {
          if (typeof a.pattern !== 'string') return 'error: "pattern" must be a string';
          let glob: string | undefined;
          if (a.glob !== undefined) {
            if (typeof a.glob !== 'string') return 'error: "glob" must be a string';
            glob = a.glob;
          }
          return await grep(a.pattern, glob);
        }
        default:
          return `error: unknown tool: ${name}`;
      }
    } catch (e) {
      return `error: ${(e as Error).message}`;
    }
  }

  return { definitions, execute };
}
