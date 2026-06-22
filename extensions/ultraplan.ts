/**
 * Pi Extension: ultraplan tools
 *
 * Thin wrappers around the pi-ultraplan engine. Correct Pi tool contract:
 *   execute(toolCallId, params, signal, onUpdate?, context?) => PiToolShell
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { EvalTask } from "../src/eval.js";

// ── Bootstrap: Pi credentials → env vars ──────────────────────────────
function bootstrapEnvFromPiConfig() {
  // Skip only when both are set AND the key is not an unexpanded $VAR reference.
  const keyLooksUnexpanded =
    !process.env.PI_API_KEY ||
    /^\$[A-Z_][A-Z0-9_]*$/.test(process.env.PI_API_KEY);
  if (process.env.PI_BASE_URL && process.env.PI_API_KEY && !keyLooksUnexpanded) return;
  try {
    const raw = readFileSync(join(homedir(), ".pi", "agent", "models.json"), "utf8");
    const cfg = JSON.parse(raw) as { providers?: Record<string, { baseUrl?: string; apiKey?: string }> };
    const p = cfg.providers?.[process.env.PI_PROVIDER_NAME || "fairy-tales-deepseek-openai"];
    if (p?.baseUrl) process.env.PI_BASE_URL = p.baseUrl + "/v1";
    if (p?.apiKey) {
      // Expand $VAR references from models.json against the real environment.
      const resolved = p.apiKey.replace(/^\$([A-Z_][A-Z0-9_]*)$/, (_, name) =>
        process.env[name] ?? p.apiKey,
      );
      process.env.PI_API_KEY = resolved;
    }
  } catch { /* env vars must be set manually */ }
}
bootstrapEnvFromPiConfig();

// ── Lazy engine loader (dynamic import after bootstrap) ───────────────
interface Engine {
  Dispatcher: typeof import("../src/dispatcher.js").Dispatcher;
  deepseekProvider: typeof import("../src/providers/deepseek.js").deepseekProvider;
  store: typeof import("../src/store.js");
  readAudit: typeof import("../src/audit.js").readAudit;
  runEval: typeof import("../src/eval.js").runEval;
}
let _e: Engine | null = null;
async function getEngine(): Promise<Engine> {
  if (_e) return _e;
  const [disp, prov, st, aud, ev] = await Promise.all([
    import("../src/dispatcher.js"),
    import("../src/providers/deepseek.js"),
    import("../src/store.js"),
    import("../src/audit.js"),
    import("../src/eval.js"),
  ]);
  _e = { Dispatcher: disp.Dispatcher, deepseekProvider: prov.deepseekProvider, store: st, readAudit: aud.readAudit, runEval: ev.runEval };
  // Wire footer reconciliation: any render after this reads real store state.
  _storeRead = st.read.bind(st);
  return _e;
}

// ── Helpers ───────────────────────────────────────────────────────────
function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }
function sid(v: unknown): string | undefined { return typeof v === "string" && v.trim() ? v.trim() : undefined; }
function ok(details: unknown) { return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details }; }
function fail(msg: string) { return { content: [{ type: "text", text: msg }], details: { error: msg }, isError: true }; }

// ── Plan export to Finder-accessible folder ─────────────────────────
const PLAN_EXPORT_DIR = process.env.PI_PLAN_DIR || join(homedir(), "Documents", "ultraplan-plans");
function exportPlanToDisk(sessionId: string, prompt: string, plan: any, cost: any): string {
  mkdirSync(PLAN_EXPORT_DIR, { recursive: true });
  const shortId = sessionId.slice(-12);
  const date = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `ultraplan-${shortId}-${date}.md`;
  const filepath = join(PLAN_EXPORT_DIR, filename);
  const sp = plan?.structured;
  let md = `# Ultraplan: ${prompt?.slice(0, 80) ?? "(no plan)"}\n\n`;
  md += `**Session**: ${sessionId}\n`;
  md += `**Date**: ${new Date().toISOString()}\n`;
  if (cost) md += `**Cost**: \$${cost.usd.toFixed(4)} (${cost.promptTokens} in / ${cost.completionTokens} out)\n`;
  md += `\n`;
  if (sp?.steps) {
    md += `## Goal\n${sp.goal}\n\n## Steps\n\n`;
    for (const s of sp.steps) {
      md += `### ${s.id}. ${s.intent}\n`;
      if (s.targetFiles?.length) md += `- **Files**: ${s.targetFiles.join(", ")}\n`;
      if (s.rationale) md += `- **Rationale**: ${s.rationale}\n`;
      if (s.acceptanceCriteria?.length) {
        md += `- **Acceptance**:\n`;
        for (const ac of s.acceptanceCriteria) md += `  - ${ac}\n`;
      }
      md += `- **Risk**: ${s.risk}\n\n`;
    }
    if (sp.risks?.length) {
      md += `## Risks\n${sp.risks.map((r: string) => `- ${r}`).join("\n")}\n\n`;
    }
    if (sp.verification?.length) {
      md += `## Verification\n${sp.verification.map((v: string) => `- ${v}`).join("\n")}\n`;
    }
  } else {
    md += plan?.text ?? "(no plan text)";
  }
  writeFileSync(filepath, md, "utf8");
  return filepath;
}

// ── Approve + export to Finder-accessible folder ────────────────────
async function approveAndExport(
  dispatcher: any, sessionId: string, prompt: string, e: Engine, ui: any,
): Promise<void> {
  await dispatcher.approve(sessionId);
  const rec = e.store.read(sessionId);
  if (rec?.plan) {
    const exported = exportPlanToDisk(sessionId, rec.prompt, rec.plan, rec.cost);
    ui?.notify?.(`Plan saved to ${exported}`, "info");
  }
}

// ── TUI session bar widget ───────────────────────────────────────────
const activeSessions = new Map<string, { progress?: string; phase?: string; prompt?: string }>();
// Gap #2 — latest progress string for the above-editor widget.
let latestProgress = "";
// Lazy-loaded store read — set once engine boots, used to reconcile
// stale sessions that were modified externally (e.g. CLI approve/reject).
let _storeRead: ((id: string) => any) | null = null;

// ── Extension ─────────────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {

  pi.on("session_start", async (_event, ctx) => {
    // D1 — session recovery: scan the store for sessions that were still
    // running when Pi last shut down, and rebuild the activeSessions map
    // so the footer shows them and the user can poll/approve/reject.
    try {
      const { readdirSync, readFileSync: rfs } = await import("node:fs");
      const dir = process.env.PI_SESSION_DIR || join(homedir(), ".pi", "ultraplan", "sessions");
      try {
        for (const file of readdirSync(dir)) {
          if (!file.endsWith(".json")) continue;
          try {
            const rec = JSON.parse(rfs(join(dir, file), "utf8")) as any;
            if (rec.status === "running" || rec.status === "awaiting_approval") {
              activeSessions.set(rec.sessionId, {
                progress: rec.progress,
                phase: rec.status,
                prompt: rec.prompt,
              });
            }
          } catch { /* skip corrupt files */ }
        }
      } catch { /* dir may not exist yet */ }
    } catch { /* best-effort; bootstrapEnv may not have run yet */ }

    // Don't override Pi's default footer — use a widget below the editor
    // instead. Pi's footer (model, context, tokens, branch) stays visible.
    ctx.ui.setWidget("ultraplan-session-bar", (_tui, theme) => {
      return {
        render(_width: number): string[] {
          // Reconcile: remove sessions whose store status is no longer active.
          if (_storeRead) {
            for (const [id] of activeSessions) {
              const rec = _storeRead(id);
              if (!rec || (rec.status !== "running" && rec.status !== "awaiting_approval")) {
                activeSessions.delete(id);
                latestProgress = "";
              }
            }
          }
          if (activeSessions.size === 0) return [];
          const parts: string[] = [];
          for (const [id, s] of activeSessions) {
            const ph = s.phase === "awaiting_approval" ? theme.fg("warning", "GATE")
              : s.phase === "failed" || s.phase === "killed" ? theme.fg("dim", (s.phase ?? "running").toUpperCase())
              : theme.fg("success", (s.phase ?? "running").toUpperCase());
            parts.push(theme.fg("dim", `ultraplan: ${id.slice(-12)} `) + ph + (s.progress ? theme.fg("dim", ` ${s.progress}`) : ""));
          }
          return [parts.join(theme.fg("warning", " | "))];
        },
        invalidate() {},
      };
    }, { placement: "belowEditor" });

    // D4 — status line showing active job count, kept fresh by event handlers
    const updateStatus = () => {
      ctx.ui.setStatus("ultraplan", activeSessions.size > 0
        ? `⚡ ${activeSessions.size} active`
        : "idle");
    };
    updateStatus();

    // Gap #2 — widget above editor showing live plan progress.
    // Dismissed automatically when no sessions are active.
    ctx.ui.setWidget("ultraplan-progress", (_tui, theme) => {
      return {
        render(width: number): string[] {
          if (!latestProgress) return [];
          return [truncateToWidth(
            theme.fg("success", " ◉ ") + theme.fg("dim", latestProgress),
            width, ""
          )];
        },
        invalidate() {},
      };
    }, { placement: "aboveEditor" });
  });

  // F5 — safety hook: intercept tool calls that could conflict with or
  // damage active ultraplan sessions (worktree executors, store writes).
  pi.on("tool_call", async (event, ctx) => {
    if (activeSessions.size === 0) return;
    // isToolCallEventType requires a dynamic import from the pi package.
    // Guard structurally: check the input shape instead.
    const input = (event as any).input;
    if (!input?.command) return;
    const cmd: string = input.command;
    // Refuse destructive git operations on the ultraplan store directory.
    if (/\brm\s+.*\.pi\/ultraplan/i.test(cmd)) {
      ctx.ui.notify?.("ultraplan blocked: destructive operation on session store", "warning");
      return { block: true, reason: "ultraplan: operation targets session store" };
    }
    // Warn about worktree mounts in /tmp (executor creates pi-worktree-* dirs).
    if (/\brm\s+.*\/tmp\/pi-worktree-/i.test(cmd)) {
      ctx.ui.notify?.("ultraplan: removing executor worktree directories", "warning");
    }
  });

  // F5 — context injection: when ultraplan sessions are active, remind the
  // agent they exist and can be polled/approved via the registered tools.
  pi.on("before_agent_start", async (event) => {
    if (activeSessions.size === 0) return;
    const lines: string[] = [];
    for (const [id, s] of activeSessions) {
      lines.push(`  ${id.slice(-12)} [${s.phase ?? "running"}] ${s.prompt?.slice(0, 80) ?? ""}`);
    }
    return {
      systemPrompt:
        `\nYou have ${activeSessions.size} active ultraplan planning session(s):\n` +
        lines.join("\n") +
        "\nUse ultraplan_status to check, ultraplan_approve to approve, ultraplan_reject to reject.\n\n" +
        (event.systemPrompt ?? ""),
    };
  });

  // Gap #3 — model_select: detect when the user switches models via /model
  // so ultraplan tools can adapt (e.g. use the current model as default).
  // Pi fires 'model_select' with { providerName, modelId } on every switch.
  let currentModel: string | undefined;
  pi.on("model_select", async (event) => {
    const e = event as any;
    if (e?.modelId) currentModel = e.modelId;
  });

  // ── Slash commands (D2) ───────────────────────────────────────────
  pi.registerCommand("ultraplan", {
    description: "Dispatch an ultraplan planning job — fan-out → synthesize → verify → gate",
    handler: async (args: string, ctx) => {
      if (!args.trim()) return { content: [{ type: "text", text: "usage: /ultraplan <prompt>" }] };
      const e = await getEngine();
      const dispatcher = new e.Dispatcher(e.deepseekProvider);
      const ui = ctx?.ui;
      const prompt = args.trim();
      let lastProgress = "";

      // Same event wiring as ultraplan_plan — footer, widget, status, gate dialog.
      dispatcher.on("progress", (ev) => {
        lastProgress = ev.detail;
        latestProgress = ev.detail;
        activeSessions.set(ev.sessionId, { progress: ev.detail, phase: "running", prompt });
        ui?.setStatus?.("ultraplan", `⚡ ${activeSessions.size} active`);
        ui?.requestRender?.();
      });
      dispatcher.on("phase", (ev) => {
        activeSessions.set(ev.sessionId, { progress: lastProgress, phase: ev.phase, prompt });
        if (ev.phase === "awaiting_approval" || ev.phase === "failed" || ev.phase === "killed" || ev.phase === "approved") {
          latestProgress = "";
        }
        ui?.setStatus?.("ultraplan", `⚡ ${activeSessions.size} active`);
        ui?.requestRender?.();
      });
      dispatcher.on("gate", (ev) => {
        activeSessions.set(ev.sessionId, { phase: "awaiting_approval", prompt });
        ui?.requestRender?.();
        void (async () => {
          const planText = (ev as any).plan?.text ?? "(no plan text)";
          const structured = (ev as any).plan?.structured;
          let summary: string;
          if (structured && structured.steps?.length > 0) {
            const lines: string[] = [];
            lines.push(`Goal: ${structured.goal}`);
            lines.push("");
            for (const step of structured.steps) {
              lines.push(`${step.id}. ${step.intent}`);
              if (step.targetFiles?.length) lines.push(`   files: ${step.targetFiles.join(", ")}`);
              if (step.acceptanceCriteria?.length) {
                for (const ac of step.acceptanceCriteria) lines.push(`   ✓ ${ac}`);
              }
              lines.push(`   risk: ${step.risk ?? "?"}`);
              lines.push("");
            }
            if (structured.risks?.length) {
              lines.push("Risks: " + structured.risks.join("; "));
            }
            summary = lines.join("\n");
          } else {
            summary = planText;
          }
          if (ui?.select) {
            const choice = await ui.select(
              `Plan Ready — ${(ev as any).sessionId?.slice(-12) ?? "?"}`,
              [
                "Approve & Execute",
                "Approve only",
                `View full plan (${structured?.steps?.length ?? 0} steps)`,
                "Reject",
              ],
            );
            if (choice === "Approve & Execute") {
              await approveAndExport(dispatcher, (ev as any).sessionId, prompt, e, ui);
              activeSessions.set((ev as any).sessionId, { phase: "executing", progress: "executing", prompt });
              ui?.requestRender?.();
              try {
                if (e.deepseekProvider.execute) {
                  const rec = e.store.read((ev as any).sessionId);
                  if (rec?.repoRoot) {
                    await e.deepseekProvider.execute((ev as any).sessionId, { openPullRequest: false });
                  }
                }
              } catch (err) {
                ui?.notify?.(`Execute failed: ${errMsg(err)}`, "error");
              }
              activeSessions.delete((ev as any).sessionId);
            } else if (choice === "Approve only") {
              await approveAndExport(dispatcher, (ev as any).sessionId, prompt, e, ui);
              activeSessions.set((ev as any).sessionId, { phase: "approved", prompt });
            } else if (choice?.startsWith("View")) {
              // Show the full plan in a confirm, then re-prompt.
              await ui.confirm?.("Plan Details", summary);
              void (async () => {
                // Re-present the gate dialog after viewing.
                // The event handler returns a second select.
                const choice2 = await ui.select?.(
                  `Plan Ready — ${(ev as any).sessionId?.slice(-12) ?? "?"}`,
                  ["Approve & Execute", "Approve only", "Reject"],
                );
                if (choice2 === "Approve & Execute") {
                  await approveAndExport(dispatcher, (ev as any).sessionId, prompt, e, ui);
                  activeSessions.set((ev as any).sessionId, { phase: "executing", progress: "executing", prompt });
                  ui?.requestRender?.();
                  try {
                    if (e.deepseekProvider.execute) {
                      const rec = e.store.read((ev as any).sessionId);
                      if (rec?.repoRoot) {
                        await e.deepseekProvider.execute((ev as any).sessionId, { openPullRequest: false });
                      }
                    }
                  } catch (err) {
                    ui?.notify?.(`Execute failed: ${errMsg(err)}`, "error");
                  }
                  activeSessions.delete((ev as any).sessionId);
                } else if (choice2 === "Approve only") {
                  await approveAndExport(dispatcher, (ev as any).sessionId, prompt, e, ui);
                  activeSessions.set((ev as any).sessionId, { phase: "approved", prompt });
                } else {
                  const note = await ui.input?.("Reject note (optional):", "");
                  await dispatcher.reject((ev as any).sessionId, note || undefined);
                  activeSessions.delete((ev as any).sessionId);
                }
                latestProgress = "";
                ui?.setStatus?.("ultraplan", activeSessions.size > 0 ? `⚡ ${activeSessions.size} active` : "idle");
                ui?.requestRender?.();
              })();
              return; // skip the footer update below — handled in inner closure
            } else {
              const note = await ui.input?.("Reject note (optional):", "");
              await dispatcher.reject((ev as any).sessionId, note || undefined);
              activeSessions.delete((ev as any).sessionId);
            }
            latestProgress = "";
            ui?.setStatus?.("ultraplan", activeSessions.size > 0 ? `⚡ ${activeSessions.size} active` : "idle");
            ui?.requestRender?.();
          } else {
            ui?.notify?.(`🅿 Plan gated — use ultraplan_approve/${(ev as any).sessionId?.slice(-12)} or ultraplan_reject`, "warning");
          }
        })();
      });
      dispatcher.on("failed", (ev) => {
        activeSessions.set(ev.sessionId, { phase: "failed", prompt });
        latestProgress = "";
        ui?.requestRender?.();
      });
      dispatcher.on("killed", (ev) => { activeSessions.delete(ev.sessionId); latestProgress = ""; ui?.requestRender?.(); });
      dispatcher.on("approved", (ev) => {
        activeSessions.set(ev.sessionId, { phase: "approved", prompt });
        latestProgress = "";
        ui?.requestRender?.();
      });

      const result = await dispatcher.dispatch({
        prompt,
        mode: "plan",
        channel: `cmd-${Date.now()}`,
      });
      if ("error" in result) return { content: [{ type: "text", text: `error: ${result.error}` }], isError: true };
      activeSessions.set(result.sessionId, { progress: "launched", phase: "running", prompt });
      ui?.requestRender?.();
      return { content: [{ type: "text", text: `dispatched ${result.sessionId}` }] };
    },
  });

  pi.registerCommand("ustatus", {
    description: "Check ultraplan session status. Usage: /ustatus [sessionId-suffix]",
    handler: async (args: string) => {
      const e = await getEngine();
      const dir = join(homedir(), ".pi", "ultraplan", "sessions");
      const suffix = args.trim();
      const { readdirSync, readFileSync: rfs } = await import("node:fs");
      try {
        const files = readdirSync(dir).filter(f => f.endsWith(".json"));
        const matching = suffix
          ? files.filter(f => f.includes(suffix))
          : files.slice(-5);
        if (matching.length === 0) return { content: [{ type: "text", text: "no sessions found" }] };
        const lines: string[] = [];
        for (const f of matching) {
          const rec = JSON.parse(rfs(join(dir, f), "utf8")) as any;
          lines.push(`${rec.sessionId.slice(-12)}  [${rec.status}]  ${rec.progress ?? ""}  ${rec.prompt?.slice(0, 60) ?? ""}`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch {
        return { content: [{ type: "text", text: "no sessions (store directory empty or missing)" }] };
      }
    },
  });

  // ── /uview — show full plan for a past session ──────────────────
  pi.registerCommand("uview", {
    description: "View full plan details for a session. Usage: /uview <sessionId-suffix>",
    handler: async (args: string) => {
      const suffix = args.trim();
      if (!suffix) return { content: [{ type: "text", text: "usage: /uview <sessionId-suffix>" }] };
      const e = await getEngine();
      const dir = join(homedir(), ".pi", "ultraplan", "sessions");
      const { readdirSync, readFileSync: rfs } = await import("node:fs");
      try {
        const files = readdirSync(dir).filter(f => f.includes(suffix) && f.endsWith(".json"));
        if (files.length === 0) return { content: [{ type: "text", text: `no session matching "${suffix}"` }] };
        const rec = JSON.parse(rfs(join(dir, files[0]), "utf8")) as any;
        const sp = rec.plan?.structured;
        let output = `Session: ${rec.sessionId}\nStatus: ${rec.status}\nPrompt: ${rec.prompt ?? "(none)"}\nModel: ${rec.model} / ${rec.provider}\n`;
        if (rec.cost) output += `Cost: \$${rec.cost.usd.toFixed(4)} (${rec.cost.promptTokens} in / ${rec.cost.completionTokens} out)\n`;
        if (sp?.steps) {
          output += `\nGoal: ${sp.goal}\n\n`;
          for (const s of sp.steps) {
            output += `${s.id}. ${s.intent}\n`;
            if (s.targetFiles?.length) output += `   files: ${s.targetFiles.join(", ")}\n`;
            if (s.acceptanceCriteria?.length) {
              for (const ac of s.acceptanceCriteria) output += `   ✓ ${ac}\n`;
            }
            output += `   risk: ${s.risk}\n\n`;
          }
        } else {
          output += `\n${rec.plan?.text ?? "(no plan text)"}`;
        }
        return { content: [{ type: "text", text: output }] };
      } catch (err) {
        return { content: [{ type: "text", text: `error reading session: ${errMsg(err)}` }], isError: true };
      }
    },
  });

  // ── ultraplan_plan ──────────────────────────────────────────────
  pi.registerTool({
    name: "ultraplan_plan",
    description: "Dispatch an ultraplan planning job. Fan-out → synthesize → verify/repair → gate. Returns immediately with sessionId.",
    parameters: Type.Object({
      prompt: Type.String({ description: "The planning task." }),
      repoRoot: Type.Optional(Type.String({ description: "Repo root. Defaults to cwd." })),
      model: Type.Optional(Type.String({ description: "Override model." })),
      seedPlan: Type.Optional(Type.String({ description: "Draft plan to refine." })),
    }),
    execute: async (_tcId, params, _signal, _onUpdate, context) => {
      const e = await getEngine();
      const dispatcher = new e.Dispatcher(e.deepseekProvider);
      const repoRoot = (params as any).repoRoot || process.cwd();
      const prompt = (params as any).prompt as string;
      const model = (params as any).model as string | undefined;
      const seedPlan = (params as any).seedPlan as string | undefined;
      const ui = context?.ui;
      let lastProgress = "";

      dispatcher.on("progress", (ev) => {
        lastProgress = ev.detail;
        latestProgress = ev.detail;
        activeSessions.set(ev.sessionId, { progress: ev.detail, phase: "running", prompt });
        ui?.setStatus?.("ultraplan", `⚡ ${activeSessions.size} active`);
        ui?.requestRender?.();
      });
      dispatcher.on("phase", (ev) => {
        activeSessions.set(ev.sessionId, { progress: lastProgress, phase: ev.phase, prompt });
        if (ev.phase === "awaiting_approval" || ev.phase === "failed" || ev.phase === "killed" || ev.phase === "approved") {
          latestProgress = "";
        }
        ui?.setStatus?.("ultraplan", `⚡ ${activeSessions.size} active`);
        ui?.requestRender?.();
        if (ev.phase === "awaiting_approval") ui?.notify?.(`🅿 Plan ready — ${ev.sessionId.slice(-12)}`, "warning");
      });
      dispatcher.on("gate", (ev) => {
        activeSessions.set(ev.sessionId, { phase: "awaiting_approval", prompt });
        ui?.requestRender?.();
        // Present the plan to the user and ask for an approve/reject decision.
        // Runs detached so it doesn't block the event bus.
        void (async () => {
          const planText = (ev as any).plan?.text ?? "(no plan text)";
          const structured = (ev as any).plan?.structured;
          let summary: string;
          if (structured && structured.steps?.length > 0) {
            const lines: string[] = [];
            lines.push(`Goal: ${structured.goal}`);
            lines.push("");
            for (const step of structured.steps) {
              lines.push(`${step.id}. ${step.intent}`);
              if (step.targetFiles?.length) lines.push(`   files: ${step.targetFiles.join(", ")}`);
              if (step.acceptanceCriteria?.length) {
                for (const ac of step.acceptanceCriteria) lines.push(`   ✓ ${ac}`);
              }
              lines.push(`   risk: ${step.risk ?? "?"}`);
              lines.push("");
            }
            if (structured.risks?.length) {
              lines.push("Risks: " + structured.risks.join("; "));
            }
            summary = lines.join("\n");
          } else {
            summary = planText;
          }

          if (ui?.select) {
            const choice = await ui.select(
              `Plan Ready — ${(ev as any).sessionId?.slice(-12) ?? "?"}`,
              [
                "Approve & Execute",
                "Approve only",
                `View full plan (${structured?.steps?.length ?? 0} steps)`,
                "Reject",
              ],
            );
            if (choice === "Approve & Execute") {
              await approveAndExport(dispatcher, (ev as any).sessionId, prompt, e, ui);
              activeSessions.set((ev as any).sessionId, { phase: "executing", progress: "executing", prompt });
              ui?.requestRender?.();
              try {
                if (e.deepseekProvider.execute) {
                  const rec = e.store.read((ev as any).sessionId);
                  if (rec?.repoRoot) {
                    await e.deepseekProvider.execute((ev as any).sessionId, { openPullRequest: false });
                  }
                }
              } catch (err) {
                ui?.notify?.(`Execute failed: ${errMsg(err)}`, "error");
              }
              activeSessions.delete((ev as any).sessionId);
            } else if (choice === "Approve only") {
              await approveAndExport(dispatcher, (ev as any).sessionId, prompt, e, ui);
              activeSessions.set((ev as any).sessionId, { phase: "approved", prompt });
            } else if (choice?.startsWith("View")) {
              await ui.confirm?.("Plan Details", summary);
              void (async () => {
                const choice2 = await ui.select?.(
                  `Plan Ready — ${(ev as any).sessionId?.slice(-12) ?? "?"}`,
                  ["Approve & Execute", "Approve only", "Reject"],
                );
                if (choice2 === "Approve & Execute") {
                  await approveAndExport(dispatcher, (ev as any).sessionId, prompt, e, ui);
                  activeSessions.set((ev as any).sessionId, { phase: "executing", progress: "executing", prompt });
                  ui?.requestRender?.();
                  try {
                    if (e.deepseekProvider.execute) {
                      const rec = e.store.read((ev as any).sessionId);
                      if (rec?.repoRoot) {
                        await e.deepseekProvider.execute((ev as any).sessionId, { openPullRequest: false });
                      }
                    }
                  } catch (err) {
                    ui?.notify?.(`Execute failed: ${errMsg(err)}`, "error");
                  }
                  activeSessions.delete((ev as any).sessionId);
                } else if (choice2 === "Approve only") {
                  await approveAndExport(dispatcher, (ev as any).sessionId, prompt, e, ui);
                  activeSessions.set((ev as any).sessionId, { phase: "approved", prompt });
                } else {
                  const note = await ui.input?.("Reject note (optional):", "");
                  await dispatcher.reject((ev as any).sessionId, note || undefined);
                  activeSessions.delete((ev as any).sessionId);
                }
                latestProgress = "";
                ui?.setStatus?.("ultraplan", activeSessions.size > 0 ? `⚡ ${activeSessions.size} active` : "idle");
                ui?.requestRender?.();
              })();
              return;
            } else {
              const note = await ui.input?.("Reject note (optional):", "");
              await dispatcher.reject((ev as any).sessionId, note || undefined);
              activeSessions.delete((ev as any).sessionId);
            }
            latestProgress = "";
            ui?.setStatus?.("ultraplan", activeSessions.size > 0 ? `⚡ ${activeSessions.size} active` : "idle");
            ui?.requestRender?.();
          } else {
            // Non-interactive mode: the plan sits at the gate, watchable via ultraplan_status.
            ui?.notify?.(`🅿 Plan gated — use ultraplan_approve/${(ev as any).sessionId?.slice(-12)} or ultraplan_reject`, "warning");
          }
        })();
      });
      dispatcher.on("failed", (ev) => {
        activeSessions.set(ev.sessionId, { phase: "failed", prompt });
        ui?.requestRender?.();
      });
      dispatcher.on("killed", (ev) => { activeSessions.delete(ev.sessionId); latestProgress = ""; ui?.requestRender?.(); });
      dispatcher.on("approved", (ev) => {
        activeSessions.set(ev.sessionId, { phase: "approved", prompt });
        latestProgress = "";
        ui?.requestRender?.();
      });
      dispatcher.on("failed", (ev) => {
        activeSessions.set(ev.sessionId, { phase: "failed", prompt });
        latestProgress = "";
        ui?.requestRender?.();
      });

      const result = await dispatcher.dispatch({
        prompt, repoRoot, model, seedPlan, mode: "plan", channel: `pi-${Date.now()}`,
      });
      if ("error" in result) return fail(result.error);
      activeSessions.set(result.sessionId, { progress: "launched", phase: "running", prompt });
      ui?.requestRender?.();
      return ok({
        sessionId: result.sessionId, status: "planning",
        note: "Plan runs in background. Use ultraplan_status, ultraplan_approve/reject when at the gate.",
      });
    },
  });

  // ── ultraplan_status ────────────────────────────────────────────
  pi.registerTool({
    name: "ultraplan_status",
    description: "Read full persisted state of an ultraplan session.",
    parameters: Type.Object({
      sessionId: Type.String({ description: "Session ID from ultraplan_plan." }),
    }),
    execute: async (_tcId, params) => {
      const s = sid((params as any).sessionId);
      if (!s) return fail("sessionId is required");
      const e = await getEngine();
      const rec = e.store.read(s);
      if (!rec) return fail(`session not found: ${s}`);
      return ok({
        sessionId: rec.sessionId, status: rec.status, progress: rec.progress,
        prompt: rec.prompt, model: rec.model, provider: rec.provider,
        plan: rec.plan ? { text: rec.plan.text, structured: rec.plan.structured ? {
          goal: rec.plan.structured.goal, stepCount: rec.plan.structured.steps.length,
          steps: rec.plan.structured.steps.map(st => ({ id: st.id, intent: st.intent, targetFiles: st.targetFiles, risk: st.risk })),
        } : undefined } : undefined,
        verification: rec.verification ? { sound: rec.verification.sound, rounds: rec.verification.rounds, repaired: rec.verification.repaired, votes: rec.verification.votes } : undefined,
        planWarnings: rec.planWarnings,
        cost: rec.cost ? { usd: rec.cost.usd, promptTokens: rec.cost.promptTokens, completionTokens: rec.cost.completionTokens } : undefined,
        startedAt: new Date(rec.startedAt).toISOString(), updatedAt: new Date(rec.updatedAt).toISOString(),
      });
    },
  });

  // ── ultraplan_approve ───────────────────────────────────────────
  pi.registerTool({
    name: "ultraplan_approve",
    description: "Approve a plan waiting at the gate.",
    parameters: Type.Object({
      sessionId: Type.String({ description: "Session ID to approve." }),
    }),
    execute: async (_tcId, params, _signal, _onUpdate, context) => {
      const s = sid((params as any).sessionId);
      if (!s) return fail("sessionId is required");
      const e = await getEngine();
      const dispatcher = new e.Dispatcher(e.deepseekProvider);
      await dispatcher.approve(s);
      // Export plan to Finder-accessible folder.
      const rec = e.store.read(s);
      if (rec?.plan) {
        const exported = exportPlanToDisk(s, rec.prompt, rec.plan, rec.cost);
        context?.ui?.notify?.(`Plan saved to ${exported}`, "info");
      }
      const existing = activeSessions.get(s);
      activeSessions.set(s, { ...existing, phase: "approved" });
      latestProgress = "";
      context?.ui?.setStatus?.("ultraplan", activeSessions.size > 0 ? `⚡ ${activeSessions.size} active` : "idle");
      context?.ui?.requestRender?.();
      return ok({ sessionId: s, status: "approved" });
    },
  });

  // ── ultraplan_reject ────────────────────────────────────────────
  pi.registerTool({
    name: "ultraplan_reject",
    description: "Reject a plan with a note — feeds cross-run memory.",
    parameters: Type.Object({
      sessionId: Type.String({ description: "Session ID to reject." }),
      note: Type.Optional(Type.String({ description: "Why it was rejected." })),
    }),
    execute: async (_tcId, params, _signal, _onUpdate, context) => {
      const s = sid((params as any).sessionId);
      if (!s) return fail("sessionId is required");
      const e = await getEngine();
      const dispatcher = new e.Dispatcher(e.deepseekProvider);
      await dispatcher.reject(s, (params as any).note);
      activeSessions.delete(s);
      latestProgress = "";
      context?.ui?.setStatus?.("ultraplan", activeSessions.size > 0 ? `⚡ ${activeSessions.size} active` : "idle");
      context?.ui?.requestRender?.();
      return ok({ sessionId: s, status: "rejected", note: (params as any).note });
    },
  });

  // ── ultraplan_execute ───────────────────────────────────────────
  pi.registerTool({
    name: "ultraplan_execute",
    description: "Execute an approved plan: worktree-isolated edits → test gate → self-repair → PR or patch.",
    parameters: Type.Object({
      sessionId: Type.String({ description: "Session ID to execute." }),
      openPullRequest: Type.Optional(Type.Boolean({ description: "Create a PR. Default: false." })),
      testCmd: Type.Optional(Type.String({ description: "Override test command." })),
    }),
    execute: async (_tcId, params, _signal, _onUpdate, context) => {
      const s = sid((params as any).sessionId);
      if (!s) return fail("sessionId is required");
      const e = await getEngine();
      if (!e.deepseekProvider.execute) return fail("Execute not supported by this provider");
      try {
        const existing = activeSessions.get(s);
        activeSessions.set(s, { ...existing, phase: "executing", progress: "executing" });
        context?.ui?.requestRender?.();
        const result = await e.deepseekProvider.execute(s, {
          openPullRequest: (params as any).openPullRequest ?? false,
          testCmd: (params as any).testCmd,
        });
        activeSessions.delete(s);
        latestProgress = "";
        context?.ui?.setStatus?.("ultraplan", activeSessions.size > 0 ? `⚡ ${activeSessions.size} active` : "idle");
        context?.ui?.requestRender?.();
        return ok({ sessionId: s, mode: result.mode, branch: result.branch, prUrl: result.prUrl, patchPath: result.patchPath, testGate: result.testGate, repairs: result.repairs });
      } catch (err) { return fail(errMsg(err)); }
    },
  });

  // ── ultraplan_stop ──────────────────────────────────────────────
  pi.registerTool({
    name: "ultraplan_stop",
    description: "Halt a running ultraplan job. Idempotent.",
    parameters: Type.Object({
      sessionId: Type.String({ description: "Session ID to stop." }),
    }),
    execute: async (_tcId, params, _signal, _onUpdate, context) => {
      const s = sid((params as any).sessionId);
      if (!s) return fail("sessionId is required");
      const e = await getEngine();
      const dispatcher = new e.Dispatcher(e.deepseekProvider);
      await dispatcher.stop(s);
      activeSessions.delete(s);
      latestProgress = "";
      context?.ui?.setStatus?.("ultraplan", activeSessions.size > 0 ? `⚡ ${activeSessions.size} active` : "idle");
      context?.ui?.requestRender?.();
      return ok({ sessionId: s, status: "stopped" });
    },
  });

  // ── ultraplan_eval ──────────────────────────────────────────────
  pi.registerTool({
    name: "ultraplan_eval",
    description: "Run benchmark eval: plan each task, LLM-judge, emit scorecard.",
    parameters: Type.Object({
      tasks: Type.Array(Type.Object({
        id: Type.String({}), prompt: Type.String({}),
        repoRoot: Type.Optional(Type.String({})), rubric: Type.Optional(Type.String({})),
      })),
    }),
    execute: async (_tcId, params) => {
      const tasks = (params as any).tasks as EvalTask[];
      if (!Array.isArray(tasks) || tasks.length === 0) return fail("tasks must be a non-empty array");
      const e = await getEngine();
      const card = await e.runEval(tasks);
      return ok({
        aggregate: card.aggregate,
        tasks: card.tasks.map(t => ({ id: t.id, status: t.status, score: t.score, dimensions: t.dimensions, metrics: t.metrics, error: t.error })),
      });
    },
  });

  // ── ultraplan_audit ─────────────────────────────────────────────
  pi.registerTool({
    name: "ultraplan_audit",
    description: "Read recent entries from the append-only ultraplan audit log.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: "Entries to return. Default: 20." })),
    }),
    execute: async (_tcId, params) => {
      const e = await getEngine();
      const all = e.readAudit();
      const n = typeof (params as any).limit === "number" && (params as any).limit > 0 ? Math.floor((params as any).limit) : 20;
      return ok({
        total: all.length,
        entries: all.slice(-n).map(entry => ({ timestamp: new Date(entry.ts).toISOString(), event: entry.event, sessionId: entry.sessionId, details: entry.details })),
      });
    },
  });
}
