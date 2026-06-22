# pi-ultraplan

A provider-agnostic `/ultraplan` pattern:
fire a heavy "planning" agent off to the background, keep your terminal free,
poll for a structured plan, gate it on human approval with an interactive dialog,
optionally execute it in an isolated worktree.

Works as a **Pi extension** with full TUI integration, slash commands, and
automatic plan export. Also runs standalone via CLI and HTTP API.

The reference provider is custom model **`fairy-tales-deepseek-openai`** running
**`deepseek-v4-pro`** — but the engine not include it. Swap the provider,
keep the engine.

## Architecture

```
trigger (CLI / API / Pi extension)   ← swappable surface
        │
        ▼
   Dispatcher  (dispatcher.ts)        ← 100% generic engine
   ├─ idempotency lock (set before any await)
   ├─ detached poll loop + timeout
   ├─ status-guarded delivery (late polls can't resurrect killed jobs)
   ├─ orphan reaping on error
   └─ event bus: ready / progress / phase / gate / approved / failed / killed
        │
        ▼
   AgentProvider  (types.ts)          ← the ONLY thing you implement per backend
        │
        ▼
   DeepSeek Provider (providers/deepseek/)
   ├─ chat.ts         ← OpenAI-compatible transport + cost metering
   ├─ planners.ts     ← multi-lens fan-out (pragmatist, adversary, scale, maintainer)
   ├─ synthesis.ts    ← structured JSON reconciliation with parse-retry
   ├─ repair.ts       ← fold verification critique into plan
   └─ index.ts        ← AgentProvider orchestrator (launch/poll/approve/reject/execute)
        │
        ▼
   file-backed store (store.ts)       ← every state claim verifiable on disk
```

## The ultra pipeline (plan mode)

1. **Fan out** — N planners in parallel, each a different lens (`pragmatist`,
   `adversary`, `scale`, `maintainer`). `PI_PLANNERS` controls N (default 3,
   max 4). One planner failing doesn't sink the run; all-fail → `failed`.
2. **Synthesize** — reconcile the drafts into one structured `StructuredPlan`
   JSON with parse-retry and prose fallback.
3. **Adversarial verify** — 4-lens panel (correctness, security, feasibility,
   completeness). Tie or majority refute triggers repair. Configurable via
   `PI_VERIFIERS` and `PI_VERIFY_ROUNDS`.
4. **Repair** — fold critique back into the plan, re-verify. Loops up to
   `PI_VERIFY_ROUNDS` (default 2) before gating regardless.
5. **Gate** — interactive dialog: **Approve & Execute**, **Approve only**,
   **Reject**. Plans exported to `~/Documents/ultraplan-plans/` on approve.

## Pi Extension

Load automatically (symlinked at `.pi/extensions/`) or via `-e`:

```bash
pi -e extensions/ultraplan.ts
```

### Slash Commands

| Command | Description |
|---------|-------------|
| `/ultraplan <prompt>` | Dispatch a plan — fan-out → synthesize → verify → gate |
| `/ustatus [suffix]` | List recent sessions, filter by sessionId suffix |
| `/uview <suffix>` | View full plan details for a specific session |

### Tools (LLM-callable)

| Tool | Description |
|------|-------------|
| `ultraplan_plan` | Start planning — returns sessionId immediately, runs in background |
| `ultraplan_status` | Read persisted state of any session |
| `ultraplan_approve` | Approve a plan at the gate |
| `ultraplan_reject` | Reject with a note (feeds cross-run memory) |
| `ultraplan_execute` | Execute approved plan → worktree PR/patch |
| `ultraplan_stop` | Halt a running job |
| `ultraplan_eval` | Run benchmark suite with LLM-judge scoring |
| `ultraplan_audit` | Read append-only audit log |

### TUI Surfaces

- **Footer** — live session tracker, store-reconciled against disk state
- **Widget** — progress stream above editor (`planning 0/3 → synthesizing → verifying`)
- **Status line** — active job count
- **Gate dialog** — `select()` with Approve & Execute / Approve only / Reject
- **Plan export** — `.md` files written to `~/Documents/ultraplan-plans/` on approve

## CLI

```bash
# Launch — returns immediately, prints plan at the gate
npx tsx src/cli.ts plan "Add Redis rate limiting to POST /api/login"

# Execute an approved plan
npx tsx src/cli.ts execute <sessionId>

# Inspect persisted state
npx tsx src/cli.ts status <sessionId>

# Human gate
npx tsx src/cli.ts approve <sessionId>
npx tsx src/cli.ts reject  <sessionId> "use sliding window, not fixed"

# Cancel a running job
npx tsx src/cli.ts stop <sessionId>

# Run benchmark eval
npx tsx src/cli.ts eval benchmarks/sample.json

# Read audit log
npx tsx src/cli.ts audit

# HTTP API (SSE + web UI)
npx tsx src/cli.ts serve 8080
```

## Swapping providers

Implement `AgentProvider` (see `src/types.ts`) against any backend — OpenAI
Assistants, Gemini, a queue+worker pod — and pass it to `new Dispatcher(...)`.
Nothing else changes.

## Env

| var | default | meaning |
| --- | --- | --- |
| `PI_BASE_URL` | `http://localhost:8000/v1` | OpenAI-compatible base |
| `PI_API_KEY` | — | bearer token |
| `PI_MODEL` | `deepseek-v4-pro` | default model |
| `PI_PLANNERS` | `3` | fan-out width (1–4) |
| `PI_VERIFIERS` | `3` | verification panel size (1–4) |
| `PI_VERIFY_ROUNDS` | `2` | max verify→repair loops (1–3) |
| `PI_MAX_TOOL_STEPS` | `12` | max tool calls per planner |
| `PI_COST_CEILING_USD` | — | hard cost cap per run |
| `PI_COST_JSON` | — | per-model pricing overrides |
| `PI_FALLBACK_MODELS` | — | comma-separated fallback chain |
| `PI_PLAN_DIR` | `~/Documents/ultraplan-plans` | plan export directory |
| `PI_ALLOW_UNSOUND_EXEC` | — | set to `1` to execute plans that failed verification |
| `PI_SESSION_DIR` | `~/.pi/ultraplan/sessions` | where session records persist |
