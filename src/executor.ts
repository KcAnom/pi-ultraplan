import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runToolLoop } from './agentLoop.js';
import { createExecTools } from './execTools.js';
import {
  createWorktree,
  commitAll,
  formatPatch,
  detectRemote,
  openPr,
} from './worktree.js';
import type { StructuredPlan } from './plan.js';

export interface ExecOptions {
  plan: StructuredPlan;
  planText: string;
  repoRoot: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  signal: AbortSignal;
  testCmd?: string;
  maxRepairs?: number;
  openPullRequest?: boolean;
  onStep?: (note: string) => void;
}

export interface ExecResult {
  mode: 'pr' | 'patch';
  branch: string;
  patchPath?: string;
  prUrl?: string;
  testGate: { ran: boolean; passed: boolean; cmd?: string; output: string };
  repairs: number;
}

const EXEC_SYSTEM =
  'You are an expert engineer EXECUTING an approved plan. Use write_file to make ' +
  'every change. Read files first when needed. Make all edits, then stop.';

// Autodetect a test command from the worktree's package.json, falling back to a
// type-check. Returned commands are all whitespace-safe for tokenization.
function autodetectTestCmd(dir: string): string {
  try {
    const pkgRaw = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
    const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, unknown> };
    const scripts = pkg.scripts ?? {};
    if (typeof scripts.test === 'string') return 'npm test';
    if (typeof scripts.build === 'string') return 'npm run build';
  } catch {
    // No/invalid package.json: fall through to the type-check default.
  }
  return 'npx tsc --noEmit';
}

// Run the test command in `dir`, capturing combined stdout+stderr. Splits the
// command into program + args and invokes via execFileSync (NO shell), so the
// command string is never interpreted by a shell.
function runTestGate(cmd: string, dir: string): { passed: boolean; output: string } {
  const parts = cmd.split(/\s+/).filter((p) => p.length > 0);
  const program = parts[0] ?? '';
  const args = parts.slice(1);
  if (program === '') return { passed: false, output: 'error: empty test command' };
  try {
    const out = execFileSync(program, args, {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { passed: true, output: out };
  } catch (err) {
    const e = err as { stdout?: unknown; stderr?: unknown; message?: unknown };
    const output =
      `${e.stdout ?? ''}${e.stderr ?? ''}` ||
      (typeof e.message === 'string' ? e.message : String(err));
    return { passed: false, output };
  }
}

export async function executePlan(opts: ExecOptions): Promise<ExecResult> {
  const branch = 'pi/exec-' + Date.now().toString(36);
  const wt = createWorktree(opts.repoRoot, branch);

  try {
    // Capture the base commit BEFORE any edits, for the patch diff base.
    const baseSha = execFileSync('git', ['-C', wt.dir, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();

    const tools = createExecTools(wt.dir);

    // 1. Edit loop: apply the plan.
    if (!opts.signal.aborted) {
      await runToolLoop({
        baseUrl: opts.baseUrl,
        apiKey: opts.apiKey,
        model: opts.model,
        signal: opts.signal,
        tools,
        system: EXEC_SYSTEM,
        user: 'Approved plan to execute:\n\n' + opts.planText,
        maxSteps: 24,
        onStep: opts.onStep,
      });
    }

    // 2. Test gate.
    const cmd = opts.testCmd || autodetectTestCmd(wt.dir);
    let gate = runTestGate(cmd, wt.dir);
    let passed = gate.passed;
    let output = gate.output;

    // 3. Self-repair loop.
    const maxRepairs = opts.maxRepairs ?? 2;
    let repairs = 0;
    while (!passed && repairs < maxRepairs && !opts.signal.aborted) {
      repairs++;
      opts.onStep?.(`repair attempt ${repairs}`);
      await runToolLoop({
        baseUrl: opts.baseUrl,
        apiKey: opts.apiKey,
        model: opts.model,
        signal: opts.signal,
        tools,
        system: EXEC_SYSTEM,
        user:
          'The tests failed. Fix the code so they pass.\n\n' +
          'Command: ' +
          cmd +
          '\n\nOutput:\n' +
          output,
        maxSteps: 24,
        onStep: opts.onStep,
      });
      gate = runTestGate(cmd, wt.dir);
      passed = gate.passed;
      output = gate.output;
    }

    const testGate = { ran: true, passed, cmd, output };

    // Honor abort before any irreversible side effects (commit/push/PR/patch).
    // The finally block still runs to clean up the temporary worktree.
    if (opts.signal.aborted) throw new Error('aborted before commit');

    // 4. Commit all edits.
    commitAll(wt.dir, 'pi-exec: ' + opts.plan.goal);

    // 5. Output: PR (if possible) or patch.
    if (opts.openPullRequest !== false) {
      const remote = detectRemote(opts.repoRoot);
      if (remote.hasRemote && remote.hasGh) {
        try {
          const prUrl = openPr(
            opts.repoRoot,
            wt.dir,
            branch,
            'pi-exec: ' + opts.plan.goal,
            opts.planText,
          );
          return { mode: 'pr', branch, prUrl, testGate, repairs };
        } catch {
          // Fall through to patch on any PR failure.
        }
      }
    }

    const patchPath = path.join(opts.repoRoot, branch.replace(/\//g, '_') + '.patch');
    formatPatch(wt.dir, baseSha, patchPath);
    return { mode: 'patch', branch, patchPath, testGate, repairs };
  } finally {
    wt.cleanup();
    // Remove the temporary branch so stale branches don't accumulate.
    try {
      execFileSync('git', ['-C', opts.repoRoot, 'branch', '-D', branch], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {}
  }
}
