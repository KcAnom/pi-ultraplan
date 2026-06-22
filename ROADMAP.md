# pi-ultraplan → best-in-class ultraplan

What it takes to make this the best-equipped ultraplan system, ordered by
dependency and impact. The ordering is deliberate: each phase unlocks the next,
and the early phases dominate plan *quality* while the later ones dominate
*scale and trust*.

North star: **given a repo and a goal, produce a plan so specific and so
stress-tested that a competent engineer (or an executor agent) can carry it out
with zero further questions — and then optionally carry it out itself.**

Where we are today (the scaffold): generic dispatcher, provider seam, file
store, multi-lens fan-out → synthesize → adversarial verify → repair → human
gate, live progress streaming. That's the skeleton. It plans *in a vacuum*.

---

## Phase 0 — Harden the engine (foundation)

You can't build trust on detached promises and a flat-file store.

- Durable job state: move `store.ts` from JSON files to SQLite (or Postgres),
  keyed by run, with a status index. Keep the atomic-write discipline.
- Real background execution: replace the `void (async () => …)` in the provider
  with a job queue + worker pool (BullMQ/Redis, or a simple in-proc queue first)
  so jobs survive process restarts and you can run many concurrently.
- Resume-after-crash: on boot, re-attach polls to any job still `running`.
- Per-stage timeouts, retries with backoff, and a token/cost budget per run
  (the engine already has the timeout hook).
- **Done when:** kill the process mid-plan and it resumes; 50 concurrent runs
  don't trip over each other.

## Phase 1 — Ground the planners in the codebase  ⭐ biggest quality lever

Right now planners get only the prompt. Real ultraplan power is *exploration*.

- Give the provider a **tool-use loop** (OpenAI function-calling): `read_file`,
  `grep`, `list_dir`, `run` (sandboxed), so each planner explores before it
  plans. DeepSeek-v4-pro via your gateway must expose tool calling — if not,
  fall back to a retrieval pre-pass.
- **Repo context packer:** build a symbol/file index + embeddings; before
  planning, retrieve the top-k relevant files and inject them. This alone turns
  "add middleware somewhere" into "edit `src/routes/login.ts:42`".
- Snapshot the repo state (git SHA) into the run record so a plan is tied to the
  code it was written against.
- **Done when:** plans reference real file paths, real function names, and real
  existing patterns — verifiable by grepping the plan against the repo.

## Phase 2 — Make the plan a structured artifact (not prose)

Prose plans can't be executed deterministically or scored.

- Define a `Plan` schema: ordered steps, each with `targetFiles`, `intent`,
  `acceptanceCriteria`, `risk`. Force the synthesizer to emit it (JSON mode or a
  parse-and-retry loop).
- Keep a human-readable render for the gate, but store the structured form — it
  becomes the contract the executor consumes in Phase 4.
- **Done when:** every gated plan is machine-checkable (steps map to files that
  exist; acceptance criteria are testable statements).

## Phase 3 — Verification rigor (panel, not a single skeptic)

We have one verifier. Best-in-class is adversarial and diverse.

- **Multi-voter panel:** N independent verifiers, each a different lens
  (correctness, security, does-it-actually-reproduce, completeness). Majority
  refute → repair. Default-to-refuted when uncertain.
- **Loop-until-confident:** repair → re-verify, up to K rounds or until the
  panel passes (cap rounds; log if capped).
- **Completeness critic:** a final agent asking "what did every planner miss?"
  — its findings seed another fan-out round if material.
- **Done when:** known-bad plans get caught and repaired; the verdict records
  which lens objected and why.

## Phase 4 — Execution (the second half of ultraplan)

Planning that can't execute is half a product. This is the "execute remotely →
PR" branch.

- On `approved`, spawn an **executor agent per step** (or per file) in an
  **isolated git worktree** (the engine already anticipates `mode: 'execute'`).
- Gate execution on the plan's `acceptanceCriteria`: run tests/build; on
  failure, a **self-repair loop** feeds the error back to the executor.
- Produce a real artifact: a branch + PR (GitHub/GitLab API) with the plan as
  the PR body, or a patch for the "bring it back" branch.
- **Done when:** approve a plan and a green PR appears, tests passing, with no
  human edits.

## Phase 5 — Provider & model routing

Cost and resilience. The seam is already there (`AgentProvider`).

- Multiple provider adapters behind the same interface; **per-stage model
  selection** — cheap/fast model for the N planners, your strongest model for
  synthesis + verification + execution.
- Fallback chain (primary down → secondary), and parallel-best (run two
  synthesizers, judge, keep the winner) for high-stakes plans.
- Hard cost ceiling per run, surfaced in the gate ("this plan cost $X").
- **Done when:** one model outage doesn't fail a run; planner cost drops 3–5×
  with no quality loss.

## Phase 6 — Surfaces

Meet users where they are. All of these are thin clients over the same engine.

- HTTP API (the engine as a service) → web UI with a live plan view + edit-in-
  place at the gate (ultraplan's "edit the plan" affordance).
- Slack/Discord `/plan` command; GitHub bot (`/plan` in an issue → PR).
- IDE/CLI integration that streams the same `progress`/`gate` events.
- **Done when:** the same run is launchable from CLI, web, and chat, and the
  plan is editable before approval.

## Phase 7 — Eval harness & ops (how you know you're "best")

You can't claim best without measuring it.

- A **benchmark set**: real tasks with rubrics; score each plan on specificity,
  correctness, completeness (LLM-judge + spot human review).
- Run the eval on every prompt/model change — catch regressions before ship.
- Telemetry: per-stage latency, cost, repair rate, approval rate, execution
  pass rate. Dashboards.
- **Done when:** changing a prompt shows a measured ±% on the benchmark, not a
  vibe.

## Phase 8 — Memory, safety, governance

What makes it trustworthy and compounding.

- **Cross-run memory:** learn repo conventions, prior decisions, rejected
  approaches — inject into future planners (a project memory like the one you
  already use).
- Sandboxed execution (containers, no host access), secret redaction in prompts
  and logs, network egress policy.
- Approval policies (who can approve execution to which branches), full audit
  trail of every plan, verdict, and change.
- **Done when:** you'd let it open PRs against production code unattended within
  policy.

---

## The spine, compressed

0. Harden engine (durable + queued + resumable)
1. **Ground planners in the codebase** ✅ done (sandboxed repo tools + tool-use loop; ReDoS-hardened grep in a worker)
2. Structured plan artifact ✅ done (schema + tolerant parser + render + file validation + prose fallback)
3. Verification panel + repair loop ✅ done (4-lens panel, majority/tie refute rule, loop-until-confident capped at PI_VERIFY_ROUNDS, always gates for the human)
4. Execution → PR with test gating + self-repair ✅ done (worktree-isolated executor, auto-detected test gate + self-repair, PR via gh with patch fallback, abort-safe, injection-safe)
   — ⟹ CORE ULTRAPLAN COMPLETE: ground → fan-out → structured synthesis → panel verify/repair → gate → execute
5. Provider/model routing + cost control ✅ done (per-stage models, fallback chain across ALL stages incl. planners + panel, per-run cost meter + hard ceiling, unpriced-model estimate)
6. Surfaces (API/web/chat/IDE) ✅ done (node:http API + SSE progress + XSS-safe web UI; concurrent sessions via unique channels; foundation for chat/IDE clients)
7. Eval harness + telemetry ✅ done (benchmark runner + LLM-judge scorecard, per-run metrics, fail-isolated, bulletproof score parsing)
8. Memory + safety + governance ✅ done (cross-run memory injection, secret redaction incl. by-key-name, append-only audit trail, execution policy gate)

ALL 8 PHASES COMPLETE — provider-agnostic ultraplan for deepseek-v4-pro, every stage adversarially built + independently verified.

**Pi integration complete**: 8 tools, 3 slash commands (/ultraplan, /ustatus, /uview), TUI footer with store reconciliation, progress widget, interactive gate dialog (Approve & Execute / Approve only / Reject), plan export to `~/Documents/ultraplan-plans/`, session recovery on restart, safety hooks, model_select reactivity.

If you only do three things to leapfrog: **1 (grounding), 4 (execution), 7
(eval).** Grounding makes plans real, execution makes them shippable, eval
proves it's the best — the rest is leverage on those three.
