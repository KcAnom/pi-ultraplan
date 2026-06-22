/**
 * Unit tests for pure functions — no I/O, no network, no providers.
 *
 * Targets: extractJson, parseStructuredPlan, parseVerdict, parseScore, redact.
 * These are the highest-risk untested code paths identified in the audit.
 */
import { describe, it, expect } from "vitest";
import { extractJson, parseStructuredPlan, renderPlan } from "../src/plan.js";
import { parseVerdict } from "../src/verify.js";
import { parseScore } from "../src/eval.js";
import { redact, redactObject } from "../src/redact.js";

// ── extractJson ──────────────────────────────────────────────────────
describe("extractJson", () => {
  it("returns clean JSON as-is", () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}');
  });

  it("strips markdown fences", () => {
    const input = '```json\n{"a":1}\n```';
    expect(extractJson(input)).toBe('{"a":1}');
  });

  it("scans for first balanced object when trailing text exists", () => {
    const input = 'prefix {"a":1} suffix';
    expect(extractJson(input)).toBe('{"a":1}');
  });

  it("returns null for non-JSON input", () => {
    expect(extractJson("plain text")).toBeNull();
    expect(extractJson("")).toBeNull();
  });

  it("handles nested braces correctly", () => {
    expect(extractJson('{"a":{"b":2}}')).toBe('{"a":{"b":2}}');
  });

  it("ignores braces inside strings", () => {
    expect(extractJson('{"a":"{not a brace}"}')).toBe('{"a":"{not a brace}"}');
  });
});

// ── parseStructuredPlan ──────────────────────────────────────────────
describe("parseStructuredPlan", () => {
  it("parses a valid plan", () => {
    const result = parseStructuredPlan(JSON.stringify({
      goal: "Add rate limiting",
      steps: [{ id: "s1", intent: "Add middleware", targetFiles: ["src/middleware.ts"], rationale: "Needed", acceptanceCriteria: ["Tests pass"], risk: "low" }],
      risks: ["Rate limit bypass"],
      verification: ["Run tests"],
    }));
    expect(result.plan).not.toBeNull();
    expect(result.plan!.goal).toBe("Add rate limiting");
    expect(result.plan!.steps).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects empty steps array", () => {
    const result = parseStructuredPlan('{"goal":"x","steps":[],"risks":[],"verification":[]}');
    expect(result.plan).toBeNull();
    expect(result.errors).toContain("Plan has no steps.");
  });

  it("flags missing acceptanceCriteria", () => {
    const result = parseStructuredPlan(JSON.stringify({
      goal: "x",
      steps: [{ id: "s1", intent: "do", targetFiles: [], rationale: "", acceptanceCriteria: [], risk: "low" }],
      risks: [],
      verification: [],
    }));
    expect(result.errors).toContain("Step s1 has no acceptance criteria.");
  });

  it("defaults invalid risk to medium", () => {
    const result = parseStructuredPlan(JSON.stringify({
      goal: "x",
      steps: [{ id: "s1", intent: "do", targetFiles: [], rationale: "", acceptanceCriteria: ["test"], risk: "critical" }],
      risks: [],
      verification: [],
    }));
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.plan!.steps[0].risk).toBe("medium");
  });

  it("returns null for non-JSON text", () => {
    const result = parseStructuredPlan("not json");
    expect(result.plan).toBeNull();
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

// ── parseVerdict ─────────────────────────────────────────────────────
describe("parseVerdict", () => {
  it("parses SOUND verdict", () => {
    const v = parseVerdict("correctness", "VERDICT: SOUND\n- minor nit\n- another");
    expect(v.sound).toBe(true);
    expect(v.issues).toHaveLength(2);
  });

  it("parses NEEDS_REVISION verdict", () => {
    const v = parseVerdict("security", "VERDICT: NEEDS_REVISION\n- SQL injection risk\n- missing auth");
    expect(v.sound).toBe(false);
    expect(v.issues.length).toBeGreaterThan(0);
  });

  it("defaults to unsound on empty input", () => {
    const v = parseVerdict("feasibility", "");
    expect(v.sound).toBe(false);
  });

  it("defaults to unsound on ambiguous first line", () => {
    const v = parseVerdict("completeness", "I think this is probably ok but...");
    expect(v.sound).toBe(false);
  });

  it("parses numbered lists too", () => {
    const v = parseVerdict("correctness", "VERDICT: SOUND\n1. first issue\n2. second");
    expect(v.issues).toHaveLength(2);
  });
});

// ── parseScore ───────────────────────────────────────────────────────
describe("parseScore", () => {
  it("parses a valid score JSON", () => {
    const raw = JSON.stringify({
      overall: 0.85,
      dimensions: { specificity: 0.9, completeness: 0.8, correctness: 0.85 },
      rationale: "Solid plan",
    });
    const score = parseScore(raw);
    expect(score.overall).toBeCloseTo(0.85);
    expect(score.dimensions.specificity).toBe(0.9);
  });

  it("returns zero on unparseable input", () => {
    expect(parseScore("garbage").overall).toBe(0);
  });

  it("normalizes 0-10 scale to 0-1", () => {
    const score = parseScore(JSON.stringify({ overall: 8, dimensions: {}, rationale: "" }));
    expect(score.overall).toBe(0.8);
  });
});

// ── redact ───────────────────────────────────────────────────────────
describe("redact", () => {
  it("redacts Bearer tokens", () => {
    const input = "Authorization: Bearer abcdefghijklmnop";
    expect(redact(input)).not.toContain("abcdefghijklmnop");
    expect(redact(input)).toContain("[REDACTED]");
  });

  it("redacts OpenAI-style keys", () => {
    const input = "OPENAI_API_KEY=sk-1234567890abcdef";
    expect(redact(input)).not.toContain("sk-1234567890abcdef");
  });

  it("redacts key=value assignments", () => {
    const input = "API_KEY=hunter2hunter";
    expect(redact(input)).not.toContain("hunter2hunter");
    expect(redact(input)).toContain("[REDACTED]");
  });

  it("is idempotent", () => {
    const input = "PASSWORD=secret123456";
    const once = redact(input);
    const twice = redact(once);
    expect(once).toBe(twice);
  });

  it("does not redact ordinary prose with 'key' or 'secret'", () => {
    const input = "The secret to success is consistency";
    expect(redact(input)).toBe(input);
  });

  it("does not redact short values after key-like names", () => {
    const input = "KEY=short";
    expect(redact(input)).toBe(input); // "short" is < 6 chars
  });
});

// ── redactObject ─────────────────────────────────────────────────────
describe("redactObject", () => {
  it("redacts sensitive keys by name", () => {
    const obj = { API_KEY: "plainword", name: "test" };
    const result = redactObject(obj) as typeof obj;
    expect(result.API_KEY).toBe("[REDACTED]");
    expect(result.name).toBe("test");
  });

  it("redacts nested objects recursively", () => {
    const obj = { config: { secret: "abcdefgh", port: 8080 } };
    const result = redactObject(obj) as any;
    expect(result.config.secret).not.toBe("abcdefgh");
  });

  it("passes through non-strings", () => {
    const obj = { count: 42, enabled: true };
    const result = redactObject(obj) as any;
    expect(result.count).toBe(42);
    expect(result.enabled).toBe(true);
  });
});

// ── renderPlan (deterministic rendering) ─────────────────────────────
describe("renderPlan", () => {
  it("renders a plan with steps", () => {
    const plan = {
      goal: "Test",
      steps: [{ id: "s1", intent: "Do it", targetFiles: ["a.ts"], rationale: "Because", acceptanceCriteria: ["Works"], risk: "low" as const }],
      risks: ["Bad things"],
      verification: ["Check"],
    };
    const text = renderPlan(plan);
    expect(text).toContain("# Goal");
    expect(text).toContain("Do it");
    expect(text).toContain("a.ts");
  });
});
