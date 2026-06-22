#!/usr/bin/env node
/**
 * Minimal CLI demonstrating the engine end-to-end against
 * fairy-tales-deepseek-openai / deepseek-v4-pro.
 *
 *   npx tsx src/cli.ts plan   "Add rate limiting to the /api/login route"
 *   npx tsx src/cli.ts status <sessionId>
 *   npx tsx src/cli.ts approve <sessionId>
 *   npx tsx src/cli.ts reject  <sessionId> "needs Redis, not in-memory"
 *   npx tsx src/cli.ts stop    <sessionId>
 *
 * `plan` returns immediately with a sessionId (terminal stays free, exactly
 * like ultraplan), then prints the plan when the gate is reached.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { Dispatcher } from './dispatcher.js';
import { runEval, type EvalTask, type Scorecard } from './eval.js';
import { deepseekProvider } from './providers/deepseek.js';
import { startServer } from './server.js';
import * as store from './store.js';
import { readAudit } from './audit.js';

const [, , cmd, ...rest] = process.argv;
const d = new Dispatcher(deepseekProvider);

async function main() {
  switch (cmd) {
    // `execute <sessionId>` runs the approved plan through the executor.
    // (Disambiguated from execute-mode planning: a single arg matching an
    //  existing session record means "run it"; anything else is a prompt.)
    case 'execute': {
      const maybeId = rest[0];
      if (rest.length === 1 && maybeId && store.read(maybeId)) {
        await runExecute(maybeId);
        break;
      }
      await runPlan('execute', rest);
      break;
    }
    case 'plan': {
      await runPlan('plan', rest);
      break;
    }
    // `eval <benchmarkFile.json>` runs the LLM-judged benchmark harness.
    case 'eval': {
      await runEvalCmd(rest[0]);
      break;
    }
    // `serve [port]` starts the HTTP API (default 8080); stays running.
    case 'serve': {
      startServer(Number(rest[0]) || 8080);
      break;
    }
    case 'status': {
      const rec = store.read(rest[0]);
      console.log(rec ? JSON.stringify(rec, null, 2) : 'no such session');
      break;
    }
    // `audit [n]` prints the most recent audit entries (default 20).
    case 'audit': {
      const all = readAudit();
      const n = Number(rest[0]) || 20;
      const recent = all.slice(-n);
      if (recent.length === 0) {
        console.log('no audit entries');
      } else {
        for (const e of recent) {
          const when = new Date(e.ts).toISOString();
          const sid = e.sessionId ? ` ${e.sessionId}` : '';
          const det = e.details ? ` ${JSON.stringify(e.details)}` : '';
          console.log(`${when}  ${e.event}${sid}${det}`);
        }
      }
      break;
    }
    case 'approve':
      await d.approve(rest[0]);
      console.log('approved');
      break;
    case 'reject':
      await d.reject(rest[0], rest.slice(1).join(' '));
      console.log('rejected');
      break;
    case 'stop':
      await d.stop(rest[0]);
      console.log('stopped');
      break;
    default:
      die('commands: plan | execute | eval | serve | status | audit | approve | reject | stop');
  }
}

/** Dispatch-mode planning (plan | execute mode), driven off the event bus. */
async function runPlan(mode: 'plan' | 'execute', rest: string[]): Promise<void> {
  const prompt = rest.join(' ').trim();
  if (!prompt) return die('usage: cli.ts plan <prompt>');

  // Drive entirely off the engine's event bus — no separate polling here.
  const finished = new Promise<void>((resolve) => {
    d.on('phase', ({ phase, detail }) => {
      if (phase !== 'running')
        console.error(`  · → ${phase}${detail ? ` (${detail})` : ''}`);
    });
    d.on('progress', ({ detail }) => console.error(`  · ${detail}…`));
    d.on('gate', ({ sessionId, plan }) => {
      const rec = store.read(sessionId);
      const v = rec?.verification;
      console.log('\n=== DRAFT PLAN (awaiting approval) ===\n');
      console.log(plan.text);
      if (plan.structured) {
        console.log(`\n(structured: ${plan.structured.steps.length} steps)`);
      }
      const warnings = rec?.planWarnings;
      if (warnings && warnings.length > 0) {
        console.log('\n⚠ plan warnings:');
        for (const w of warnings) console.log(`  - ${w}`);
      }
      if (v) {
        const roundWord = v.rounds === 1 ? 'round' : 'rounds';
        console.error(
          `\n  verify: ${v.sound ? 'SOUND' : 'NEEDS_REVISION'} after ` +
            `${v.rounds} ${roundWord}`,
        );
        const refutes = v.votes.filter((vote) => !vote.sound);
        for (const vote of refutes) {
          console.error(`    ✗ ${vote.lens}:`);
          for (const issue of vote.issues) console.error(`      - ${issue}`);
        }
      }
      const c = rec?.cost;
      if (c) {
        console.error(
          `\n  cost: $${c.usd.toFixed(4)} ` +
            `(${c.promptTokens} in / ${c.completionTokens} out tok)`,
        );
      }
      console.error(`\n→ approve:  npx tsx src/cli.ts approve ${sessionId}`);
      console.error(`→ reject:   npx tsx src/cli.ts reject ${sessionId} "<why>"`);
      console.error(`→ execute:  npx tsx src/cli.ts execute ${sessionId}`);
      resolve();
    });
    d.on('failed', ({ reason }) => {
      console.error(`\n✗ failed: ${reason}`);
      resolve();
    });
  });

  const res = await d.dispatch({ prompt, mode });
  if ('error' in res) return die(res.error);

  console.error(`◇ launched ${deepseekProvider.name} (${deepseekProvider.defaultModel})`);
  console.error(`  sessionId: ${res.sessionId}`);
  console.error('  terminal is free — streaming progress…\n');

  await finished;
}

/** Execute an approved plan via the provider's executor, printing the outcome. */
async function runExecute(sessionId: string): Promise<void> {
  if (!deepseekProvider.execute) {
    return die(`provider "${deepseekProvider.name}" cannot execute plans`);
  }
  try {
    console.error(`◇ executing session ${sessionId}…\n`);
    const r = await deepseekProvider.execute(sessionId);
    console.log(`mode:    ${r.mode}`);
    console.log(`branch:  ${r.branch}`);
    if (r.mode === 'pr') {
      console.log(`prUrl:   ${r.prUrl ?? '(none)'}`);
    } else {
      console.log(`patch:   ${r.patchPath ?? '(none)'}`);
    }
    const g = r.testGate;
    console.log(
      `tests:   ${g.ran ? (g.passed ? 'PASSED' : 'FAILED') : 'not run'}` +
        `${g.cmd ? ` (cmd: ${g.cmd})` : ''}`,
    );
    console.log(`repairs: ${r.repairs}`);
  } catch (e) {
    return die(`execute failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Run the benchmark harness over a JSON file of EvalTasks, print a scorecard
 *  to stdout, and write the full Scorecard JSON next to the benchmark file. */
async function runEvalCmd(benchmarkPath: string | undefined): Promise<void> {
  if (!benchmarkPath) return die('usage: cli.ts eval <benchmarkFile.json>');

  let raw: string;
  try {
    raw = readFileSync(benchmarkPath, 'utf8');
  } catch (e) {
    return die(`cannot read benchmark file "${benchmarkPath}": ${errMsg(e)}`);
  }

  let benchmark: EvalTask[];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('expected a JSON array of EvalTask');
    benchmark = parsed as EvalTask[];
  } catch (e) {
    return die(`invalid benchmark JSON in "${benchmarkPath}": ${errMsg(e)}`);
  }

  console.error(`◇ running eval over ${benchmark.length} task(s)…\n`);
  const card = await runEval(benchmark, { onProgress: (msg) => console.error('  · ' + msg) });

  printScorecard(card);

  const outPath = benchmarkPath + '.results.json';
  try {
    writeFileSync(outPath, JSON.stringify(card, null, 2));
    console.error(`\n✓ wrote results to ${outPath}`);
  } catch (e) {
    return die(`failed to write results to "${outPath}": ${errMsg(e)}`);
  }
}

/** Print a readable per-task + aggregate scorecard to stdout. */
function printScorecard(card: Scorecard): void {
  console.log('\n=== SCORECARD ===\n');
  for (const t of card.tasks) {
    const m = t.metrics;
    console.log(
      `${t.id}  [${t.status}]  score=${t.score.toFixed(2)}  ` +
        `planMs=${m.planMs}  rounds=${m.rounds}  repaired=${m.repaired}  ` +
        `cost=$${m.costUsd.toFixed(4)}` +
        (t.error ? `  error=${t.error}` : ''),
    );
  }
  const a = card.aggregate;
  console.log('\n--- aggregate ---');
  console.log(`n:           ${a.n}`);
  console.log(`meanScore:   ${a.meanScore.toFixed(2)}`);
  console.log(`passRate:    ${(a.passRate * 100).toFixed(0)}%`);
  console.log(`totalCost:   $${a.totalCostUsd.toFixed(4)}`);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

void main();
