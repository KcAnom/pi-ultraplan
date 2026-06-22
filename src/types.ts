/**
 * Provider-agnostic "ultraplan" engine — type contracts.
 *
 * The whole point of this file is the AgentProvider interface: the dispatcher
 * (dispatcher.ts) knows nothing about DeepSeek, OpenAI, or anything else. Swap
 * the provider, keep the engine. Everything Claude Code does in the original
 * ultraplan.tsx that ISN'T model-specific lives in the dispatcher; the one
 * model-specific part is an AgentProvider implementation.
 */

/** Lifecycle phases. Mirrors ultraplan's running | needs_input | done | failed,
 *  plus an explicit human-approval gate (the generic stand-in for an
 *  "approved ExitPlanMode" signal). */
export type Phase =
  | 'idle'
  | 'launching'
  | 'running'
  | 'needs_input'
  | 'awaiting_approval'
  | 'approved'
  | 'executing'
  | 'done'
  | 'failed'
  | 'killed';

export type Mode = 'plan' | 'execute';

import type { StructuredPlan } from './plan.js';

/** The handoff artifact — the equivalent of the plan that teleports back. */
export interface Plan {
  /** Human-readable render. */
  text: string;
  /** Structured form when synthesis produced valid JSON; absent on fallback. */
  structured?: StructuredPlan;
  model: string;
  provider: string;
  createdAt: number;
}

export interface LaunchOpts {
  prompt: string;
  /** Optional draft plan to refine (ultraplan's seedPlan). */
  seedPlan?: string;
  mode: Mode;
  /** Override the provider's default model. */
  model?: string;
  /** Repo root to ground planning against (Phase 1). Optional. */
  repoRoot?: string;
  signal: AbortSignal;
}

export interface PollResult {
  phase: Phase;
  artifact?: Plan;
  /** Human-readable detail for failures / needs_input. */
  detail?: string;
}

/**
 * The only thing a new backend has to implement. Implement this against any
 * provider — OpenAI Assistants, Gemini, a queue+worker pod, whatever — and the
 * dispatcher runs it unchanged.
 */
export interface AgentProvider {
  readonly name: string;
  readonly defaultModel: string;

  /** Preconditions (ultraplan's checkRemoteAgentEligibility). */
  checkEligibility(): Promise<{ ok: boolean; reasons: string[] }>;

  /** Kick off the job. Returns immediately with a handle; the heavy work runs
   *  detached and progress is observed via poll(). */
  launch(opts: LaunchOpts): Promise<{ sessionId: string; url?: string }>;

  /** One observation tick. Pure read — never mutates the engine's state. */
  poll(sessionId: string): Promise<PollResult>;

  /** Record the human decision on a plan that is awaiting_approval. */
  approve(sessionId: string): Promise<void>;
  reject(sessionId: string, note?: string): Promise<void>;

  /** Halt + reap (ultraplan's archiveRemoteSession). Must be idempotent. */
  cancel(sessionId: string): Promise<void>;

  /** Execute an approved plan, producing a PR or patch. Optional: not every
   *  provider can run code. Requires an approved (or awaiting-approval)
   *  structured plan and a recorded repoRoot. */
  execute?(
    sessionId: string,
    opts?: { openPullRequest?: boolean; testCmd?: string },
  ): Promise<import('./executor.js').ExecResult>;
}
