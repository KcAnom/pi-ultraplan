/**
 * Benchmark eval harness.
 *
 * For each task: plan it headlessly through the engine (Dispatcher +
 * deepseekProvider), wait for the human gate (or a failure / timeout), read the
 * recorded plan + metrics back from the store, then judge the plan with an LLM
 * and score it. One bad task never sinks the run — every failure mode degrades
 * to status 'failed' / score 0 with an error string, and the benchmark
 * continues.
 */
import { Dispatcher } from './dispatcher.js';
import { deepseekProvider } from './providers/deepseek.js';
import * as store from './store.js';
import { extractJson } from './plan.js';

export interface EvalTask {
  id: string;
  prompt: string;
  repoRoot?: string;
  rubric?: string;
}

export interface TaskResult {
  id: string;
  sessionId?: string;
  status: string;
  score: number;
  dimensions: Record<string, number>;
  rationale: string;
  metrics: { planMs: number; rounds: number; repaired: boolean; costUsd: number };
  error?: string;
}

export interface Scorecard {
  tasks: TaskResult[];
  aggregate: { meanScore: number; passRate: number; totalCostUsd: number; n: number };
}

export interface RunEvalOpts {
  judgeModel?: string;
  passThreshold?: number;
  timeoutMs?: number;
  onProgress?: (msg: string) => void;
}

const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_PASS_THRESHOLD = 0.7;

/** Clamp a finite number into [lo, hi]; non-finite input falls back to lo. */
function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(n, hi));
}

/**
 * Normalize a raw "overall" number to 0..1. A value already in [0,1] is taken
 * as-is; a value that looks like a 0..10 or 0..100 scale is divided down before
 * clamping. Never throws.
 */
function normalizeOverall(n: unknown): number {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) return 0;
  if (v > 1 && v <= 10) return clamp(v / 10, 0, 1);
  if (v > 10 && v <= 100) return clamp(v / 100, 0, 1);
  if (v > 100) return 1;
  return clamp(v, 0, 1);
}

/**
 * Parse a judge reply into a score. Tolerant: extract JSON, parse it, read
 * overall / dimensions / rationale defensively. NEVER throws — total failure
 * yields a zeroed, clearly-labeled result.
 */
export function parseScore(raw: unknown): {
  overall: number;
  dimensions: Record<string, number>;
  rationale: string;
} {
  const fail = { overall: 0, dimensions: {}, rationale: 'unparseable judge output' };
  if (typeof raw !== 'string') return fail;

  let json: string | null;
  try {
    json = extractJson(raw);
  } catch {
    json = null;
  }
  if (json === null) return fail;

  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return fail;
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return fail;

  const obj = data as Record<string, unknown>;

  const overall = normalizeOverall(obj.overall);

  const dimensions: Record<string, number> = {};
  const rawDims = obj.dimensions;
  if (rawDims !== null && typeof rawDims === 'object' && !Array.isArray(rawDims)) {
    for (const [k, v] of Object.entries(rawDims as Record<string, unknown>)) {
      const num = typeof v === 'number' ? v : Number(v);
      dimensions[k] = clamp(num, 0, 1);
    }
  }

  const rationale = typeof obj.rationale === 'string' ? obj.rationale : '';

  return { overall, dimensions, rationale };
}

/** Build the judge chat messages: a strict reviewer scoring the plan on
 *  specificity, completeness, correctness (each 0..1) plus an overall, replying
 *  with ONLY a JSON object. */
export function judgeMessages(
  task: EvalTask,
  planText: string,
): { role: string; content: string }[] {
  const system = [
    'You are a strict, impartial plan reviewer.',
    'SCORE the implementation plan against the task and rubric on three',
    'dimensions, each from 0 to 1:',
    '- specificity: are steps concrete, with real file paths and testable',
    '  acceptance criteria (1.0) vs. vague hand-waving (0.0)?',
    '- completeness: does the plan cover everything the task needs, including',
    '  edge cases and verification (1.0) vs. major gaps (0.0)?',
    '- correctness: is the approach technically sound and free of mistakes',
    '  (1.0) vs. wrong or contradictory (0.0)?',
    'Also give an overall score from 0 to 1 reflecting the plan as a whole.',
    'Be demanding: reserve high scores for genuinely strong plans.',
    'Respond with ONLY a JSON object, no markdown fences and no prose, of the',
    'exact shape:',
    '{ "overall": <0..1>, "dimensions": { "specificity": <0..1>,',
    '  "completeness": <0..1>, "correctness": <0..1> }, "rationale": <string> }',
  ].join('\n');

  const userParts: string[] = [];
  userParts.push(`Task:\n${task.prompt}`);
  if (task.rubric) userParts.push(`\nRubric:\n${task.rubric}`);
  userParts.push(`\nPlan to score:\n${planText || '(no plan was produced)'}`);

  return [
    { role: 'system', content: system },
    { role: 'user', content: userParts.join('\n') },
  ];
}

/**
 * Plan one task and wait for it to reach the gate, fail, or time out. Returns
 * the sessionId on success, or an error string. Listeners are always removed
 * before returning (no leak). Never throws.
 */
function planTask(
  dispatcher: Dispatcher,
  task: EvalTask,
  timeoutMs: number,
): Promise<{ sessionId: string } | { error: string }> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onGate: ((e: { sessionId: string }) => void) | undefined;
    let onFailed: ((e: { sessionId: string; reason: string }) => void) | undefined;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (onGate) dispatcher.off('gate', onGate);
      if (onFailed) dispatcher.off('failed', onFailed);
    };

    const finish = (result: { sessionId: string } | { error: string }) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    // The sessionId is only known after dispatch resolves; events may already
    // be in flight, so buffer matching by capturing it here.
    let targetSid: string | undefined;

    onGate = (e) => {
      if (targetSid && e.sessionId === targetSid) finish({ sessionId: e.sessionId });
    };
    onFailed = (e) => {
      if (targetSid && e.sessionId === targetSid) finish({ error: e.reason });
    };
    dispatcher.on('gate', onGate);
    dispatcher.on('failed', onFailed);

    timer = setTimeout(() => {
      finish({ error: `eval timed out after ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);

    void dispatcher
      .dispatch({ prompt: task.prompt, repoRoot: task.repoRoot, channel: `eval-${task.id}` })
      .then((handle) => {
        if ('error' in handle) {
          finish({ error: handle.error });
          return;
        }
        targetSid = handle.sessionId;
        // A gate/failed could have fired between dispatch() resolving and this
        // assignment; reconcile by reading the store once.
        const rec = store.read(handle.sessionId);
        if (rec?.status === 'awaiting_approval' || rec?.status === 'approved') {
          finish({ sessionId: handle.sessionId });
        } else if (rec?.status === 'failed' || rec?.status === 'killed') {
          finish({ error: rec.error ?? rec.status });
        }
      })
      .catch((e) => {
        finish({ error: e instanceof Error ? e.message : String(e) });
      });
  });
}

/** Call the LLM judge over the OpenAI-compatible /chat/completions endpoint and
 *  return the raw assistant text. Throws on transport/HTTP errors (the caller
 *  wraps this in try/catch). */
async function callJudge(
  messages: { role: string; content: string }[],
  model: string,
): Promise<string> {
  const baseUrl = process.env.PI_BASE_URL || 'http://localhost:8000/v1';
  const apiKey = process.env.PI_API_KEY || '';
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({ model, messages, stream: false }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`judge HTTP ${res.status}: ${body.slice(0, 500)}`);
  }
  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const text = json.choices?.[0]?.message?.content;
  if (!text) throw new Error('judge returned empty completion');
  return text;
}

const zeroMetrics = () => ({ planMs: 0, rounds: 0, repaired: false, costUsd: 0 });

/**
 * Run the full benchmark: plan each task, judge it, score it, aggregate.
 * Sequential. Any single-task failure is captured as status 'failed' / score 0
 * with an error string and never aborts the run.
 */
export async function runEval(
  benchmark: EvalTask[],
  opts: RunEvalOpts = {},
): Promise<Scorecard> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const passThreshold = opts.passThreshold ?? DEFAULT_PASS_THRESHOLD;
  const judgeModel = opts.judgeModel || process.env.PI_MODEL || 'deepseek-v4-pro';
  const onProgress = opts.onProgress;

  const tasks: TaskResult[] = [];

  // Single Dispatcher with unique channels per task, rather than N dispatchers
  // (N event emitters) that would never be cleaned up.
  const dispatcher = new Dispatcher(deepseekProvider);

  for (const task of benchmark) {
    onProgress?.(`[${task.id}] planning`);
    let planned: { sessionId: string } | { error: string };
    try {
      planned = await planTask(dispatcher, task, timeoutMs);
    } catch (e) {
      planned = { error: e instanceof Error ? e.message : String(e) };
    }

    if ('error' in planned) {
      onProgress?.(`[${task.id}] failed: ${planned.error}`);
      tasks.push({
        id: task.id,
        status: 'failed',
        score: 0,
        dimensions: {},
        rationale: '',
        metrics: zeroMetrics(),
        error: planned.error,
      });
      continue;
    }

    const sessionId = planned.sessionId;
    const rec = store.read(sessionId);
    if (!rec) {
      tasks.push({
        id: task.id,
        sessionId,
        status: 'failed',
        score: 0,
        dimensions: {},
        rationale: '',
        metrics: zeroMetrics(),
        error: 'session record not found after planning',
      });
      continue;
    }

    const planText = rec.plan?.text || '';
    const metrics = {
      planMs: rec.updatedAt - rec.startedAt,
      rounds: rec.verification?.rounds ?? 0,
      repaired: rec.verification?.repaired ?? false,
      costUsd: rec.cost?.usd ?? 0,
    };

    if (!planText) {
      onProgress?.(`[${task.id}] no plan produced`);
      tasks.push({
        id: task.id,
        sessionId,
        status: 'failed',
        score: 0,
        dimensions: {},
        rationale: '',
        metrics,
        error: rec.error ?? 'no plan produced',
      });
      continue;
    }

    // Judge the plan. A judge failure scores 0 with an error — never a crash.
    onProgress?.(`[${task.id}] judging`);
    try {
      const reply = await callJudge(judgeMessages(task, planText), judgeModel);
      const parsed = parseScore(reply);
      onProgress?.(`[${task.id}] scored ${parsed.overall.toFixed(2)}`);
      tasks.push({
        id: task.id,
        sessionId,
        status: rec.status,
        score: parsed.overall,
        dimensions: parsed.dimensions,
        rationale: parsed.rationale,
        metrics,
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      onProgress?.(`[${task.id}] judge error: ${error}`);
      tasks.push({
        id: task.id,
        sessionId,
        status: rec.status,
        score: 0,
        dimensions: {},
        rationale: '',
        metrics,
        error,
      });
    }
  }

  const n = benchmark.length;
  const scores = tasks.map((t) => t.score);
  const sum = scores.reduce((a, b) => a + b, 0);
  const meanScore = n === 0 ? 0 : sum / n;
  const passes = scores.filter((s) => s >= passThreshold).length;
  const passRate = n === 0 ? 0 : passes / n;
  const totalCostUsd = tasks.reduce((a, t) => a + t.metrics.costUsd, 0);

  return {
    tasks,
    aggregate: { meanScore, passRate, totalCostUsd, n },
  };
}
