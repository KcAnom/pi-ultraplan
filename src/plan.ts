import * as fs from 'node:fs';
import * as path from 'node:path';

export type Risk = 'low' | 'medium' | 'high';

export interface PlanStep {
  id: string;
  intent: string;
  targetFiles: string[];
  rationale: string;
  acceptanceCriteria: string[];
  risk: Risk;
}

export interface StructuredPlan {
  goal: string;
  steps: PlanStep[];
  risks: string[];
  verification: string[];
}

export const PLAN_JSON_INSTRUCTION: string = [
  'Respond with ONLY a single JSON object that matches the following shape.',
  'Do not include markdown code fences. Do not include any prose before or after the JSON.',
  '',
  'The JSON object has exactly these fields:',
  '- "goal": string. A one-sentence statement of the overall objective.',
  '- "steps": array of step objects (ordered). Each step object has exactly these fields:',
  '    - "id": string. Sequential identifier "s1", "s2", "s3", ... matching the step order.',
  '    - "intent": string. What this step does.',
  '    - "targetFiles": array of strings. Repo-relative paths this step touches.',
  '    - "rationale": string. Why this step is needed.',
  '    - "acceptanceCriteria": array of strings. Concrete, testable statements that must hold',
  '      after the step is done. Must be non-empty.',
  '    - "risk": string. Exactly one of "low", "medium", or "high".',
  '- "risks": array of strings. Overall risks for the plan.',
  '- "verification": array of strings. The overall verification plan.',
  '',
  'acceptanceCriteria entries must be concrete testable statements (not vague goals).',
  'targetFiles must be repo-relative paths. risk must be one of low|medium|high.',
  'Step ids must be "s1", "s2", "s3", ... in order.',
  'Output the raw JSON object only.',
].join('\n');

/**
 * Tolerant JSON extraction. Strips code fences; returns the trimmed text if it
 * parses as JSON; otherwise scans for the first balanced top-level {...} object,
 * ignoring braces inside double-quoted strings and respecting backslash escapes.
 * Never throws. Returns null if no JSON object is found.
 */
export function extractJson(text: string): string | null {
  if (typeof text !== 'string') return null;

  let s = text.trim();

  // Strip surrounding ```json / ``` fences if present.
  if (s.startsWith('```')) {
    s = s.replace(/^```[^\n]*\n?/, '');
    if (s.endsWith('```')) s = s.slice(0, -3);
    s = s.trim();
  }

  // If the trimmed text parses as JSON, return it.
  try {
    JSON.parse(s);
    return s;
  } catch {
    // Fall through to scanning.
  }

  // Scan for the first balanced top-level {...} object.
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) {
          return s.slice(start, i + 1);
        }
      }
    }
  }

  return null;
}

function asString(v: unknown, dflt = ''): string {
  return typeof v === 'string' ? v : dflt;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

/**
 * Parses and defensively validates/coerces a StructuredPlan from model output.
 * Never throws on any input. Returns { plan: null, errors } when no JSON object
 * is found or steps is missing/empty; otherwise { plan, errors }.
 */
export function parseStructuredPlan(text: string): { plan: StructuredPlan | null; errors: string[] } {
  const errors: string[] = [];

  let raw: string | null = null;
  try {
    raw = extractJson(text);
  } catch {
    raw = null;
  }

  if (raw === null) {
    errors.push('No JSON object found in input.');
    return { plan: null, errors };
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    errors.push(`Failed to parse JSON: ${e instanceof Error ? e.message : String(e)}`);
    return { plan: null, errors };
  }

  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    errors.push('Top-level JSON value is not an object.');
    return { plan: null, errors };
  }

  const obj = data as Record<string, unknown>;

  const goal = asString(obj.goal, '');

  const rawSteps = obj.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    errors.push('Plan has no steps.');
    return { plan: null, errors };
  }

  const steps: PlanStep[] = [];
  for (let i = 0; i < rawSteps.length; i++) {
    const rs = rawSteps[i];
    const step =
      rs !== null && typeof rs === 'object' && !Array.isArray(rs)
        ? (rs as Record<string, unknown>)
        : {};

    const defaultId = `s${i + 1}`;
    const id = asString(step.id, defaultId) || defaultId;
    const intent = asString(step.intent, '');
    const rationale = asString(step.rationale, '');
    const targetFiles = asStringArray(step.targetFiles);

    const acceptanceCriteria = asStringArray(step.acceptanceCriteria);
    if (acceptanceCriteria.length === 0) {
      errors.push(`Step ${id} has no acceptance criteria.`);
    }

    let risk: Risk;
    const rawRisk = step.risk;
    if (rawRisk === 'low' || rawRisk === 'medium' || rawRisk === 'high') {
      risk = rawRisk;
    } else {
      risk = 'medium';
      errors.push(`Step ${id} has invalid risk; defaulting to 'medium'.`);
    }

    steps.push({ id, intent, targetFiles, rationale, acceptanceCriteria, risk });
  }

  const plan: StructuredPlan = {
    goal,
    steps,
    risks: asStringArray(obj.risks),
    verification: asStringArray(obj.verification),
  };

  return { plan, errors };
}

/**
 * Deterministic markdown rendering of a plan. Stable ordering, no randomness.
 */
export function renderPlan(p: StructuredPlan): string {
  const lines: string[] = [];

  lines.push('# Goal');
  lines.push(p.goal);
  lines.push('');

  lines.push('## Steps');
  for (let i = 0; i < p.steps.length; i++) {
    const step = p.steps[i];
    lines.push(`${i + 1}. ${step.intent}`);
    lines.push(`- files: ${step.targetFiles.join(', ')}`);
    lines.push(`- rationale: ${step.rationale}`);
    lines.push('- acceptance:');
    for (const c of step.acceptanceCriteria) {
      lines.push(`  - ${c}`);
    }
    lines.push(`- risk: ${step.risk}`);
  }
  lines.push('');

  lines.push('## Risks');
  for (const r of p.risks) {
    lines.push(`- ${r}`);
  }
  lines.push('');

  lines.push('## Verification');
  for (const v of p.verification) {
    lines.push(`- ${v}`);
  }

  return lines.join('\n');
}

const CREATE_INTENT = /\b(create|new file|scaffold)\b|\badd\b.*\bfile\b/i;

/**
 * Returns a warning per targetFile that does not exist under root. Files that
 * resolve outside root are warned as "outside repo". Existence checks are
 * skipped for steps whose intent suggests file creation. Never throws.
 */
export function validatePlanFiles(p: StructuredPlan, root: string): string[] {
  const warnings: string[] = [];
  const rootResolved = path.resolve(root);
  const prefix = rootResolved.endsWith(path.sep) ? rootResolved : rootResolved + path.sep;

  for (const step of p.steps) {
    const isCreation = CREATE_INTENT.test(step.intent);
    for (const f of step.targetFiles) {
      let resolved: string;
      try {
        resolved = path.resolve(rootResolved, f);
      } catch {
        warnings.push(`Step ${step.id}: could not resolve path "${f}".`);
        continue;
      }

      if (resolved !== rootResolved && !resolved.startsWith(prefix)) {
        warnings.push(`Step ${step.id}: "${f}" resolves outside repo.`);
        continue;
      }

      if (isCreation) continue;

      try {
        if (!fs.existsSync(resolved)) {
          warnings.push(`Step ${step.id}: file "${f}" does not exist.`);
        }
      } catch {
        warnings.push(`Step ${step.id}: could not check "${f}".`);
      }
    }
  }

  return warnings;
}
