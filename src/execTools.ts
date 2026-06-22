import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolModule, ChatTool } from './tools.js';

const EXCLUDED = new Set(['node_modules', '.git', '.pi', 'dist']);

export function createExecTools(root: string): ToolModule {
  // Canonical root for prefix checks; fall back to resolved if it doesn't exist yet.
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    realRoot = path.resolve(root);
  }

  // Resolve an incoming path inside the sandbox. Returns the safe absolute path,
  // or an Error whose message is the error string to surface to the caller.
  // Replicates the audited safeResolve in tools.ts: realpath the deepest
  // existing ancestor, recombine the non-existent suffix, then require the
  // canonical path to equal realRoot or sit under realRoot + path.sep.
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

  function writeFile(p: string, content: string): string {
    const target = safeResolve(p);
    if (target instanceof Error) return target.message;
    // Defend against writing the sandbox root itself.
    if (target === realRoot) {
      return 'error: refusing to write to the sandbox root';
    }
    // Create missing parent directories ONLY after the escape check has passed,
    // so we never mkdir/write outside the sandbox.
    const parent = path.dirname(target);
    try {
      fs.mkdirSync(parent, { recursive: true });
    } catch (e) {
      return `error: cannot create parent directory: ${(e as Error).message}`;
    }
    try {
      fs.writeFileSync(target, content, 'utf8');
    } catch (e) {
      return `error: cannot write file: ${(e as Error).message}`;
    }
    return `wrote ${content.length} bytes to ${path.relative(realRoot, target)}`;
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
        name: 'write_file',
        description:
          'Write a file inside the repository, creating any missing parent directories. Overwrites existing files. Returns a confirmation or an error string.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'File path relative to the repository root.',
            },
            content: {
              type: 'string',
              description: 'Full UTF-8 contents to write to the file.',
            },
          },
          required: ['path', 'content'],
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
        case 'write_file': {
          if (typeof a.path !== 'string') return 'error: "path" must be a string';
          if (typeof a.content !== 'string') return 'error: "content" must be a string';
          return writeFile(a.path, a.content);
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
