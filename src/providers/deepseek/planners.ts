/**
 * Multi-lens planner fan-out.
 *
 * Spawns N planners in parallel, each with a distinct lens (pragmatist,
 * adversary, scale, maintainer). Each planner either explores the repo via
 * the tool loop (when a repoRoot is configured) or runs a plain chat call.
 * One planner failing doesn't sink the run — drafts are gathered via
 * allSettled semantics.
 */
import type { LaunchOpts } from '../../types.js';
import * as store from '../../store.js';
import { runToolLoop } from '../../agentLoop.js';
import { createRepoTools } from '../../tools.js';
import { renderMemoryBlock } from '../../memory.js';
import { callWithFallback, fallbackModels, type CostMeter } from '../../routing.js';
import { chat, type ChatMessage, DEFAULT_MODEL } from './chat.js';

/** How many planners to fan out to (capped at LENSES.length). Default 3. */
export const PLANNER_COUNT = Math.max(
  1,
  Math.min(Number(process.env.PI_PLANNERS) || 3, 4),
);

export const clamp = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(Number.isFinite(n) ? Math.trunc(n) : lo, hi));

const BASE_URL = process.env.PI_BASE_URL || 'http://localhost:8000/v1';
const API_KEY = process.env.PI_API_KEY || '';

export const PLAN_SYSTEM_BASE = [
  'You are an expert software architect operating in PLAN MODE.',
  'Produce a precise, step-by-step implementation plan for the request.',
  'Do NOT write the full implementation — output a plan a competent engineer',
  'could execute without further questions: goal, affected files (paths),',
  'ordered steps, key decisions with rationale, risks, and a verification plan.',
].join(' ');

export const LENSES: { lens: string; addendum: string }[] = [
  {
    lens: 'pragmatist',
    addendum:
      'Optimize for the simplest correct path that ships fast. Cut scope to ' +
      'the essential. Prefer boring, proven building blocks.',
  },
  {
    lens: 'adversary',
    addendum:
      'Attack the problem: enumerate failure modes, edge cases, race ' +
      'conditions, and security holes the obvious approach would miss, and ' +
      'plan defenses for each.',
  },
  {
    lens: 'scale',
    addendum:
      'Optimize for performance, concurrency, and operational behavior under ' +
      'load. Call out hot paths, data growth, and observability.',
  },
  {
    lens: 'maintainer',
    addendum:
      'Optimize for testability, clarity, and long-term maintenance. Plan the ' +
      'test strategy and the seams that keep this changeable later.',
  },
];

export function buildUserMessage(prompt: string, seedPlan?: string): string {
  const parts: string[] = [];
  if (seedPlan) parts.push('Here is a draft plan to refine:', '', seedPlan, '');
  parts.push(prompt);
  return parts.join('\n');
}

/** Status-guarded record update: a killed job always wins, so a fan-out that
 *  finishes after a cancel can't resurrect the session. */
function guardedUpdate(
  sessionId: string,
  fn: (rec: store.SessionRecord) => store.SessionRecord,
) {
  store.update(sessionId, (rec) => (rec.status === 'killed' ? rec : fn(rec)));
}

/**
 * Fan out to N lensed planners in parallel, returning every draft that
 * succeeded. allSettled-style (one planner failing doesn't sink the run), and
 * the per-planner completion count is written to the store as each resolves so
 * the engine can stream live "planning k/N" progress.
 */
export async function fanOutPlanners(
  sessionId: string,
  opts: LaunchOpts,
  model: string,
  meter?: CostMeter,
): Promise<{ lens: string; text: string }[]> {
  const chosen = LENSES.slice(0, PLANNER_COUNT);
  const memoryBlock = renderMemoryBlock();
  const user = memoryBlock
    ? `${memoryBlock}\n\n${buildUserMessage(opts.prompt, opts.seedPlan)}`
    : buildUserMessage(opts.prompt, opts.seedPlan);
  const root = opts.repoRoot || process.env.PI_REPO_ROOT;
  let done = 0;

  const plannerModels = [model, ...fallbackModels()];
  const tasks = chosen.map(({ lens, addendum }) => {
    const run = callWithFallback(plannerModels, (m) =>
      root
        ? runToolLoop({
            baseUrl: BASE_URL,
            apiKey: API_KEY,
            model: m,
            system: `${PLAN_SYSTEM_BASE} ${addendum}`,
            user,
            tools: createRepoTools(root),
            signal: opts.signal,
            meter,
            onStep: () =>
              guardedUpdate(sessionId, (rec) => ({
                ...rec,
                progress: `planning ${done}/${chosen.length}`,
              })),
          })
        : chat(
            [
              { role: 'system', content: `${PLAN_SYSTEM_BASE} ${addendum}` },
              { role: 'user', content: user },
            ],
            m,
            opts.signal,
            meter,
          ),
    );
    return run
      .then((text) =>
        text.trim()
          ? ({ ok: true as const, lens, text })
          : ({ ok: false as const, lens }),
      )
      .catch(() => ({ ok: false as const, lens }))
      .finally(() => {
        done += 1;
        guardedUpdate(sessionId, (rec) => ({
          ...rec,
          progress: `planning ${done}/${chosen.length}`,
        }));
      });
  });

  const results = await Promise.all(tasks);
  return results.flatMap((r) => (r.ok ? [{ lens: r.lens, text: r.text }] : []));
}
