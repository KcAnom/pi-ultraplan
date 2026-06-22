/**
 * fairy-tales-deepseek-openai / deepseek-v4-pro provider adapter.
 *
 * THE PROVIDER SEAM. The dispatcher never learns that a single "plan" is really
 * N parallel planners + synthesis + verify + repair — that's a provider concern.
 *
 * Pipeline (plan mode):
 *   1. fanOutPlanners() — N lensed planners in parallel
 *   2. synthesize()     — structured JSON reconciliation
 *   3. runVerifyPanel() — 4-lens adversarial panel
 *   4. repairPlan()     — fold critique back in, re-verify (capped)
 *   5. Gate             — human approve() / reject()
 *
 * Speaks OpenAI-compatible /chat/completions. Point PI_BASE_URL at your gateway.
 */
import type { AgentProvider, LaunchOpts, PollResult, Phase } from '../../types.js';
import * as store from '../../store.js';
import {
  stageModel,
  fallbackModels,
  callWithFallback,
  CostMeter,
  CostExceededError,
} from '../../routing.js';
import { repoSnapshot } from '../../repoSnapshot.js';
import { renderPlan, validatePlanFiles } from '../../plan.js';
import type { StructuredPlan } from '../../plan.js';
import { runVerifyPanel } from '../../verify.js';
import type { ChatFn } from '../../verify.js';
import { executePlan } from '../../executor.js';
import type { ExecResult } from '../../executor.js';
import { renderMemoryBlock, addMemory } from '../../memory.js';
import { audit } from '../../audit.js';
import { redact, redactObject } from '../../redact.js';

import { chat, type ChatMessage, DEFAULT_MODEL } from './chat.js';
import { fanOutPlanners, buildUserMessage, clamp, PLANNER_COUNT } from './planners.js';
import { synthesize, synthesizeProse } from './synthesis.js';
import { repairPlan, repairPlanProse } from './repair.js';

const PROVIDER_NAME = 'fairy-tales-deepseek-openai';

/** Max verify→repair rounds before gating regardless. Default 2, range 1–3. */
const MAX_VERIFY_ROUNDS = clamp(Number(process.env.PI_VERIFY_ROUNDS) || 2, 1, 3);

/** Panel size, passed through to runVerifyPanel (undefined → its default). */
const VERIFIERS = process.env.PI_VERIFIERS
  ? clamp(Number(process.env.PI_VERIFIERS), 1, 4)
  : undefined;

const EXECUTE_SYSTEM = [
  'You are an expert software engineer. Execute the approved plan below and',
  'produce the concrete changes (code, diffs, commands) needed to complete it.',
].join(' ');

/** ChatFn adapter over chat(): re-tags message roles and applies fallback chain
 *  so a failing verify model routes to a backup instead of degrading the whole
 *  panel to fail-safe refute votes. */
const makeChatFn = (meter?: CostMeter): ChatFn =>
  (messages, model, signal) =>
    callWithFallback([model, ...fallbackModels()], (m) =>
      chat(messages as ChatMessage[], m, signal, meter),
    );

let counter = 0;
function newSessionId(): string {
  counter += 1;
  return `ft-${process.pid}-${counter}-${Date.now().toString(36)}`;
}

/** Status-guarded record update: a killed job always wins. */
function guardedUpdate(
  sessionId: string,
  fn: (rec: store.SessionRecord) => store.SessionRecord,
) {
  store.update(sessionId, (rec) => (rec.status === 'killed' ? rec : fn(rec)));
}

/** How often the async job writes a heartbeat timestamp (ms). */
const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Start a heartbeat loop that writes `lastHeartbeat` to the session record
 * every HEARTBEAT_INTERVAL_MS. Returns a stop function (call to clean up).
 * The heartbeat only fires while the session is still 'running' — once the
 * status changes to anything else (awaiting_approval, failed, killed, done),
 * the interval stops itself.
 */
function startHeartbeat(sessionId: string): () => void {
  const timer = setInterval(() => {
    store.update(sessionId, (rec) => {
      if (rec.status !== 'running') {
        // Already finished — stop signaling. The interval cleanup happens
        // via the returned stop function, but the guard here is belt-and-suspenders.
        return rec;
      }
      return { ...rec, lastHeartbeat: Date.now() };
    });
  }, HEARTBEAT_INTERVAL_MS);
  return () => clearInterval(timer);
}

export const deepseekProvider: AgentProvider = {
  name: PROVIDER_NAME,
  defaultModel: DEFAULT_MODEL,

  async checkEligibility() {
    const reasons: string[] = [];
    if (!process.env.PI_BASE_URL) {
      reasons.push('PI_BASE_URL not set (using default http://localhost:8000/v1)');
    }
    if (!process.env.PI_API_KEY) reasons.push('PI_API_KEY not set');
    return { ok: true, reasons };
  },

  async launch(opts: LaunchOpts) {
    const model = opts.model || DEFAULT_MODEL;
    const sessionId = newSessionId();
    const root = opts.repoRoot || process.env.PI_REPO_ROOT;

    const ceiling = process.env.PI_COST_CEILING_USD
      ? Number(process.env.PI_COST_CEILING_USD)
      : null;
    const meter = new CostMeter(
      Number.isFinite(ceiling as number) ? (ceiling as number) : null,
    );
    const chatFn = makeChatFn(meter);

    let snapshot: store.SessionRecord['snapshot'];
    if (root) {
      const { sha, branch, dirty } = repoSnapshot(root);
      snapshot = { sha, branch, dirty };
    }

    store.write({
      sessionId,
      status: 'running',
      prompt: opts.prompt,
      mode: opts.mode,
      model,
      provider: PROVIDER_NAME,
      progress: opts.mode === 'execute' ? 'executing' : `planning 0/${PLANNER_COUNT}`,
      snapshot,
      repoRoot: root,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    });

    audit('plan.launched', sessionId, { mode: opts.mode });

    void (async () => {
      const stopHeartbeat = startHeartbeat(sessionId);
      try {
        if (opts.mode === 'execute') {
          const execModel = stageModel('execute');
          const text = await callWithFallback(
            [execModel, ...fallbackModels()],
            (m) =>
              chat(
                [
                  { role: 'system', content: EXECUTE_SYSTEM },
                  { role: 'user', content: buildUserMessage(opts.prompt, opts.seedPlan) },
                ],
                m,
                opts.signal,
                meter,
              ),
          );
          guardedUpdate(sessionId, (rec) => ({
            ...rec,
            status: 'awaiting_approval',
            progress: undefined,
            cost: {
              usd: meter.spentUsd(),
              promptTokens: meter.promptTokens(),
              completionTokens: meter.completionTokens(),
            },
            plan: { text: redact(text), model: execModel, provider: PROVIDER_NAME, createdAt: Date.now() },
          }));
          audit('plan.gated', sessionId, { sound: false, costUsd: meter.spentUsd() });
          return;
        }

        const plannerModel = stageModel('planner');
        const verifyModel = stageModel('verify');
        const fallbacks = fallbackModels();

        const costRecord = () => ({
          usd: meter.spentUsd(),
          promptTokens: meter.promptTokens(),
          completionTokens: meter.completionTokens(),
        });

        // 1. Fan out
        const drafts = await fanOutPlanners(sessionId, opts, plannerModel, meter);
        if (opts.signal.aborted) return;
        if (drafts.length === 0) {
          guardedUpdate(sessionId, (rec) => ({
            ...rec,
            status: 'failed',
            progress: undefined,
            error: 'all planners failed',
          }));
          return;
        }
        const redactedDrafts = drafts.map((d) => ({ lens: d.lens, text: redact(d.text) }));
        guardedUpdate(sessionId, (rec) => ({
          ...rec,
          drafts: redactedDrafts,
          progress: `synthesizing ${drafts.length} drafts`,
        }));

        // 2. Synthesize
        const { plan: structured, errors: synthErrors } = await callWithFallback(
          [stageModel('synthesis'), ...fallbacks],
          (m) => synthesize(opts.prompt, redactedDrafts, m, opts.signal, meter),
        );
        if (opts.signal.aborted) return;

        if (structured) {
          let plan = structured;
          let rendered = renderPlan(plan);

          guardedUpdate(sessionId, (rec) => ({ ...rec, progress: 'verifying plan' }));
          let round = 0;
          let panel: Awaited<ReturnType<typeof runVerifyPanel>> = {
            sound: false,
            refuted: 0,
            total: 0,
            votes: [],
          };
          try {
            panel = await runVerifyPanel({
              prompt: opts.prompt,
              planText: rendered,
              model: verifyModel,
              signal: opts.signal,
              chat: chatFn,
              verifiers: VERIFIERS,
            });
            if (opts.signal.aborted) return;
            while (!panel.sound && round < MAX_VERIFY_ROUNDS) {
              round++;
              guardedUpdate(sessionId, (rec) => ({
                ...rec,
                progress: `revising plan (round ${round})`,
              }));
              const critique = panel.votes
                .filter((v) => !v.sound)
                .map((v) => `[${v.lens}] ${v.issues.join('; ')}`)
                .join('\n');
              plan = await callWithFallback(
                [stageModel('repair'), ...fallbacks],
                (m) => repairPlan(opts.prompt, plan, critique, m, opts.signal, meter),
              );
              rendered = renderPlan(plan);
              if (opts.signal.aborted) return;
              panel = await runVerifyPanel({
                prompt: opts.prompt,
                planText: rendered,
                model: verifyModel,
                signal: opts.signal,
                chat: chatFn,
                verifiers: VERIFIERS,
              });
              if (opts.signal.aborted) return;
            }
          } catch (e) {
            if (!(e instanceof CostExceededError)) throw e;
          }
          const verification = {
            sound: panel.sound,
            rounds: round,
            repaired: round > 0,
            votes: panel.votes,
          };

          const fileWarnings = root ? validatePlanFiles(plan, root) : [];
          const allWarnings = [...synthErrors, ...fileWarnings];
          const warnings = allWarnings.length > 0 ? allWarnings : undefined;

          guardedUpdate(sessionId, (rec) => ({
            ...rec,
            status: 'awaiting_approval',
            progress: undefined,
            verification,
            planWarnings: warnings,
            cost: costRecord(),
            plan: {
              text: redact(rendered),
              structured: redactObject(plan),
              model: plannerModel,
              provider: PROVIDER_NAME,
              createdAt: Date.now(),
            },
          }));
          audit('plan.gated', sessionId, {
            sound: verification.sound,
            costUsd: meter.spentUsd(),
          });
          return;
        }

        // Prose fallback
        guardedUpdate(sessionId, (rec) => ({ ...rec, progress: 'synthesizing (prose fallback)' }));
        let text = await callWithFallback(
          [stageModel('synthesis'), ...fallbacks],
          (m) => synthesizeProse(opts.prompt, redactedDrafts, m, opts.signal, meter),
        );
        if (opts.signal.aborted) return;

        guardedUpdate(sessionId, (rec) => ({ ...rec, progress: 'verifying plan' }));
        let proseRound = 0;
        let prosePanel: Awaited<ReturnType<typeof runVerifyPanel>> = {
          sound: false,
          refuted: 0,
          total: 0,
          votes: [],
        };
        try {
          prosePanel = await runVerifyPanel({
            prompt: opts.prompt,
            planText: text,
            model: verifyModel,
            signal: opts.signal,
            chat: chatFn,
            verifiers: VERIFIERS,
          });
          if (opts.signal.aborted) return;
          while (!prosePanel.sound && proseRound < MAX_VERIFY_ROUNDS) {
            proseRound++;
            guardedUpdate(sessionId, (rec) => ({
              ...rec,
              progress: `revising plan (round ${proseRound})`,
            }));
            const critique = prosePanel.votes
              .filter((v) => !v.sound)
              .map((v) => `[${v.lens}] ${v.issues.join('; ')}`)
              .join('\n');
            text = await callWithFallback(
              [stageModel('repair'), ...fallbacks],
              (m) => repairPlanProse(opts.prompt, text, critique, m, opts.signal, meter),
            );
            if (opts.signal.aborted) return;
            prosePanel = await runVerifyPanel({
              prompt: opts.prompt,
              planText: text,
              model: verifyModel,
              signal: opts.signal,
              chat: chatFn,
              verifiers: VERIFIERS,
            });
            if (opts.signal.aborted) return;
          }
        } catch (e) {
          if (!(e instanceof CostExceededError)) throw e;
        }
        const proseVerification = {
          sound: prosePanel.sound,
          rounds: proseRound,
          repaired: proseRound > 0,
          votes: prosePanel.votes,
        };

        if (!text.trim()) {
          text = renderPlan({ goal: opts.prompt, steps: [], risks: [], verification: [] });
        }

        guardedUpdate(sessionId, (rec) => ({
          ...rec,
          status: 'awaiting_approval',
          progress: undefined,
          verification: proseVerification,
          cost: costRecord(),
          plan: { text: redact(text), structured: undefined, model: plannerModel, provider: PROVIDER_NAME, createdAt: Date.now() },
        }));
        audit('plan.gated', sessionId, {
          sound: proseVerification.sound,
          costUsd: meter.spentUsd(),
        });
      } catch (e) {
        if (e instanceof CostExceededError) {
          guardedUpdate(sessionId, (rec) => ({
            ...rec,
            status: 'failed',
            progress: undefined,
            error: 'cost ceiling exceeded',
            cost: {
              usd: meter.spentUsd(),
              promptTokens: meter.promptTokens(),
              completionTokens: meter.completionTokens(),
            },
          }));
          return;
        }
        const aborted = opts.signal.aborted;
        guardedUpdate(sessionId, (rec) => ({
          ...rec,
          status: aborted ? 'killed' : 'failed',
          progress: undefined,
          error: e instanceof Error ? e.message : String(e),
        }));
      } finally {
        stopHeartbeat();
      }
    })();

    return { sessionId };
  },

  async poll(sessionId: string): Promise<PollResult> {
    const rec = store.read(sessionId);
    if (!rec) return { phase: 'failed', detail: 'session not found' };
    return {
      phase: rec.status as Phase,
      artifact: rec.plan,
      detail: rec.error ?? rec.rejectNote ?? rec.progress,
    };
  },

  async approve(sessionId: string) {
    store.update(sessionId, (rec) =>
      rec.status === 'awaiting_approval' ? { ...rec, status: 'approved' } : rec,
    );
    audit('plan.approved', sessionId);
  },

  async reject(sessionId: string, note?: string) {
    const rec = store.read(sessionId);
    store.update(sessionId, (r) =>
      r.status === 'awaiting_approval'
        ? { ...r, status: 'failed', rejectNote: note ?? 'rejected by user' }
        : r,
    );
    if (rec) {
      addMemory('rejected', 'Task: ' + rec.prompt + ' — rejected: ' + (note || '(no note)'));
    }
    audit('plan.rejected', sessionId, { note });
  },

  async cancel(sessionId: string) {
    store.update(sessionId, (rec) =>
      rec.status === 'done' || rec.status === 'failed'
        ? rec
        : { ...rec, status: 'killed' },
    );
  },

  async execute(
    sessionId: string,
    opts?: { openPullRequest?: boolean; testCmd?: string },
  ): Promise<ExecResult> {
    const rec = store.read(sessionId);
    if (!rec) throw new Error(`session not found: ${sessionId}`);
    if (rec.status !== 'approved' && rec.status !== 'awaiting_approval') {
      throw new Error(
        `cannot execute: session is "${rec.status}" (need approved or awaiting_approval)`,
      );
    }
    if (!rec.plan?.structured) {
      throw new Error('cannot execute: no structured plan on this session');
    }
    if (!rec.repoRoot) {
      throw new Error('cannot execute: no repoRoot recorded for this session');
    }
    if (
      rec.verification &&
      rec.verification.sound === false &&
      process.env.PI_ALLOW_UNSOUND_EXEC !== '1'
    ) {
      audit('exec.blocked', sessionId, { reason: 'unsound' });
      throw new Error(
        'refusing to execute: plan did not pass verification (sound=false). ' +
          'Set PI_ALLOW_UNSOUND_EXEC=1 to override.',
      );
    }

    const result = await executePlan({
      plan: rec.plan.structured,
      planText: rec.plan.text,
      repoRoot: rec.repoRoot,
      baseUrl: process.env.PI_BASE_URL || 'http://localhost:8000/v1',
      apiKey: process.env.PI_API_KEY || '',
      model: rec.model,
      signal: new AbortController().signal,
      openPullRequest: opts?.openPullRequest,
      testCmd: opts?.testCmd,
    });

    store.update(sessionId, (cur) => ({ ...cur, execResult: result }));
    audit('exec.done', sessionId, {
      mode: result.mode,
      prUrl: result.prUrl,
      patchPath: result.patchPath,
    });
    return result;
  },
};
