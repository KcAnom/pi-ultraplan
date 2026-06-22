/**
 * The generic engine — ports the non-model-specific 80% of ultraplan.tsx.
 *
 * Responsibilities (all provider-agnostic):
 *  - idempotency lock set SYNCHRONOUSLY before the async launch (ultraplan's
 *    `ultraplanLaunching: true` trick — closes the double-launch race)
 *  - detached poll loop with phase-change callbacks + a shouldStop predicate
 *  - status-guarded result delivery (a late poll can't resurrect a killed job)
 *  - orphan reaping: any throw after launch() succeeds cancels the session
 *  - out-of-band result bus (results arrive via events, not the launch return)
 */
import { EventEmitter } from 'events';
import type { AgentProvider, LaunchOpts, Phase, Plan } from './types.js';

const POLL_INTERVAL_MS = 750; // snappy enough to stream sub-status live
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // ultraplan's 30 min

export interface DispatchOpts {
  prompt: string;
  seedPlan?: string;
  mode?: 'plan' | 'execute';
  model?: string;
  /** One logical slot. A second dispatch on the same channel while one is
   *  active is rejected (ultraplan allows exactly one live session). */
  channel?: string;
  timeoutMs?: number;
  /** Repo root to ground planning against (Phase 1). Optional. */
  repoRoot?: string;
}

export interface DispatchHandle {
  sessionId: string;
  url?: string;
}

interface Job {
  sessionId: string;
  channel: string;
  phase: Phase;
  controller: AbortController;
}

export interface DispatcherEvents {
  phase: { sessionId: string; phase: Phase; detail?: string };
  progress: { sessionId: string; detail: string }; // live sub-status, streamed
  ready: { sessionId: string; url?: string }; // launched, now pollable
  gate: { sessionId: string; plan: Plan }; // plan ready, awaiting approval
  approved: { sessionId: string; plan: Plan };
  failed: { sessionId: string; reason: string };
  killed: { sessionId: string };
}

export class Dispatcher extends EventEmitter {
  private jobs = new Map<string, Job>(); // sessionId -> job
  private locks = new Set<string>(); // channels currently launching/active

  constructor(private provider: AgentProvider) {
    super();
  }

  private emitPhase(sessionId: string, phase: Phase, detail?: string) {
    this.emit('phase', { sessionId, phase, detail });
  }

  /** Launch a job. Resolves immediately (like ultraplan) with a handle; the
   *  work runs detached and outcomes arrive via events. */
  async dispatch(opts: DispatchOpts): Promise<DispatchHandle | { error: string }> {
    const channel = opts.channel ?? 'default';

    // Lock BEFORE any await — this is the critical race fix from ultraplan.
    if (this.locks.has(channel)) {
      return { error: `channel "${channel}" already has an active session` };
    }
    this.locks.add(channel);

    let sessionId: string | undefined;
    const controller = new AbortController();
    try {
      const elig = await this.provider.checkEligibility();
      if (!elig.ok) {
        this.locks.delete(channel);
        return { error: `not eligible: ${elig.reasons.join('; ')}` };
      }

      const launchOpts: LaunchOpts = {
        prompt: opts.prompt,
        seedPlan: opts.seedPlan,
        mode: opts.mode ?? 'plan',
        model: opts.model,
        repoRoot: opts.repoRoot,
        signal: controller.signal,
      };
      const { sessionId: sid, url } = await this.provider.launch(launchOpts);
      sessionId = sid;

      const job: Job = { sessionId: sid, channel, phase: 'running', controller };
      this.jobs.set(sid, job);
      this.emit('ready', { sessionId: sid, url });
      this.emitPhase(sid, 'running');

      this.startDetachedPoll(job, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      return { sessionId: sid, url };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      // Orphan reap: if launch half-succeeded, halt the remote so it doesn't
      // run unattended.
      if (sessionId) {
        void this.provider.cancel(sessionId).catch(() => {});
        this.jobs.delete(sessionId);
      }
      this.locks.delete(channel);
      return { error: reason };
    }
  }

  private startDetachedPoll(job: Job, timeoutMs: number): void {
    const started = Date.now();
    let lastDetail: string | undefined;
    void (async () => {
      try {
        while (true) {
          // shouldStop: the job was killed out from under us.
          if (!this.jobs.has(job.sessionId)) return;
          if (Date.now() - started > timeoutMs) {
            throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`);
          }

          const { phase, artifact, detail } = await this.provider.poll(job.sessionId);

          // Re-check liveness AFTER the await: a stop that landed during the
          // poll must win, so we never deliver for a killed job.
          if (!this.jobs.has(job.sessionId)) return;

          if (phase !== job.phase) {
            job.phase = phase;
            this.emitPhase(job.sessionId, phase, detail);
          }
          // Stream sub-status (planning k/N → synthesizing → verifying →
          // revising) even while the phase string stays 'running'.
          if (detail && detail !== lastDetail && phase === 'running') {
            lastDetail = detail;
            this.emit('progress', { sessionId: job.sessionId, detail });
          }

          if (phase === 'awaiting_approval' && artifact) {
            // Reached the human gate. Surface the plan, then stop polling; an
            // approve()/reject() call drives the rest.
            this.emit('gate', { sessionId: job.sessionId, plan: artifact });
            return;
          }
          if (phase === 'approved' && artifact) {
            this.finish(job, 'approved', { plan: artifact });
            return;
          }
          if (phase === 'done') return;
          if (phase === 'failed' || phase === 'killed') {
            this.finish(job, phase, { reason: detail ?? phase });
            return;
          }

          await sleep(POLL_INTERVAL_MS, job.controller.signal);
        }
      } catch (e) {
        // A kill makes the poll throw — that's expected; swallow it.
        if (!this.jobs.has(job.sessionId)) return;
        const reason = e instanceof Error ? e.message : String(e);
        void this.provider.cancel(job.sessionId).catch(() => {});
        this.finish(job, 'failed', { reason });
      }
    })();
  }

  private finish(
    job: Job,
    kind: 'approved' | 'failed' | 'killed',
    extra: { plan?: Plan; reason?: string },
  ) {
    this.jobs.delete(job.sessionId);
    this.locks.delete(job.channel);
    if (kind === 'approved' && extra.plan) {
      this.emit('approved', { sessionId: job.sessionId, plan: extra.plan });
    } else if (kind === 'failed') {
      this.emit('failed', { sessionId: job.sessionId, reason: extra.reason ?? 'failed' });
    } else {
      this.emit('killed', { sessionId: job.sessionId });
    }
  }

  /** Human approved the plan sitting at the gate. Emits 'approved' with the
   *  plan (the "teleport back" handoff). */
  async approve(sessionId: string): Promise<void> {
    await this.provider.approve(sessionId);
    const { artifact } = await this.provider.poll(sessionId);
    const job = this.jobs.get(sessionId);
    // The plan may have been gated with the job already off the active map
    // (poll returned at awaiting_approval). Rebuild a minimal finish path.
    if (artifact) {
      this.emit('approved', { sessionId, plan: artifact });
    }
    if (job) {
      this.jobs.delete(sessionId);
      this.locks.delete(job.channel);
    }
  }

  async reject(sessionId: string, note?: string): Promise<void> {
    await this.provider.reject(sessionId, note);
    const job = this.jobs.get(sessionId);
    this.emit('failed', { sessionId, reason: note ?? 'rejected' });
    if (job) {
      this.jobs.delete(sessionId);
      this.locks.delete(job.channel);
    }
  }

  /** Stop a running job (ultraplan's stopUltraplan): abort + cancel + unlock. */
  async stop(sessionId: string): Promise<void> {
    const job = this.jobs.get(sessionId);
    if (job) {
      job.controller.abort();
      this.jobs.delete(sessionId);
      this.locks.delete(job.channel);
    }
    await this.provider.cancel(sessionId).catch(() => {});
    this.emit('killed', { sessionId });
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}
