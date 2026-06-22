/**
 * Plan repair — fold verification critique back into the current plan.
 *
 * Structured repair: revises a StructuredPlan via JSON synthesis, falling back
 * to the original plan on parse failure. Prose repair: free-text revision for
 * the fallback path. Both are idempotent — a failed repair returns the input
 * unchanged.
 */
import type { CostMeter } from '../../routing.js';
import { chat, type ChatMessage, DEFAULT_MODEL } from './chat.js';
import {
  PLAN_JSON_INSTRUCTION,
  parseStructuredPlan,
  renderPlan,
  type StructuredPlan,
} from '../../plan.js';

const REPAIR_SYSTEM = [
  'You are a principal engineer. Revise the plan to fully address every issue',
  'the reviewer raised, without losing the plan\'s strengths. Output the',
  'complete revised plan only (self-contained, same section structure).',
].join(' ');

/** One repair round folding the critique back into the CURRENT structured plan.
 *  Asks for a REVISED structured plan (same JSON contract) and parses it; if the
 *  revision fails to parse, the original plan is returned unchanged. */
export async function repairPlan(
  prompt: string,
  plan: StructuredPlan,
  critique: string,
  model: string,
  signal: AbortSignal,
  meter?: CostMeter,
): Promise<StructuredPlan> {
  const current = renderPlan(plan);
  const out = await chat(
    [
      { role: 'system', content: `${REPAIR_SYSTEM}\n\n${PLAN_JSON_INSTRUCTION}` },
      {
        role: 'user',
        content: `Task:\n${prompt}\n\nCurrent plan:\n${current}\n\nReviewer issues:\n${critique}`,
      },
    ],
    model,
    signal,
    meter,
  );
  const { plan: revised } = parseStructuredPlan(out);
  return revised ?? plan;
}

/** Prose repair round (fallback path only): folds the critique back into a
 *  free-text plan, mirroring the original text-based repair behavior. */
export async function repairPlanProse(
  prompt: string,
  plan: string,
  critique: string,
  model: string,
  signal: AbortSignal,
  meter?: CostMeter,
): Promise<string> {
  return chat(
    [
      { role: 'system', content: REPAIR_SYSTEM },
      {
        role: 'user',
        content: `Task:\n${prompt}\n\nCurrent plan:\n${plan}\n\nReviewer issues:\n${critique}`,
      },
    ],
    model,
    signal,
    meter,
  );
}
