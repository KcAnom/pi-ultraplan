/**
 * Draft synthesis — reconcile N lensed drafts into one authoritative plan.
 *
 * Structured path: demands JSON (StructuredPlan), retries once on parse/validation
 * errors. Prose fallback: plain text synthesis when structured fails both attempts,
 * so the pipeline never hard-fails without a plan at the gate.
 */
import type { CostMeter } from '../../routing.js';
import { chat, type ChatMessage, DEFAULT_MODEL } from './chat.js';
import {
  PLAN_JSON_INSTRUCTION,
  parseStructuredPlan,
  type StructuredPlan,
} from '../../plan.js';

const SYNTHESIS_SYSTEM = [
  'You are a principal engineer running a planning review. You are given',
  'several independent draft plans for the same task, each written from a',
  'different perspective. Produce ONE authoritative implementation plan that',
  'takes the strongest idea from each draft, reconciles their disagreements',
  '(state the tradeoff and your choice), and drops the weak parts. The result',
  'must be self-contained — the reader will not see the drafts. Sections:',
  'Goal, Affected files, Ordered steps, Key decisions & tradeoffs, Risks,',
  'Verification plan.',
].join(' ');

export function synthesisUser(
  prompt: string,
  drafts: { lens: string; text: string }[],
): string {
  const bundle = drafts
    .map((d, i) => `### Draft ${i + 1} — "${d.lens}" perspective\n${d.text}`)
    .join('\n\n');
  return `Original task:\n${prompt}\n\nDraft plans:\n\n${bundle}`;
}

/**
 * Reconcile the drafts into one STRUCTURED plan. Demands JSON; parses it; on
 * parse failure OR any soft validation error (e.g. a step with empty
 * acceptanceCriteria) retries ONCE with the errors fed back, then parses again.
 * Returns { plan: null } when both attempts fail, and always returns the final
 * attempt's errors so the caller can surface them at the gate.
 */
export async function synthesize(
  prompt: string,
  drafts: { lens: string; text: string }[],
  model: string,
  signal: AbortSignal,
  meter?: CostMeter,
): Promise<{ plan: StructuredPlan | null; errors: string[] }> {
  const system = `${SYNTHESIS_SYSTEM}\n\n${PLAN_JSON_INSTRUCTION}`;
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: synthesisUser(prompt, drafts) },
  ];

  const first = await chat(messages, model, signal, meter);
  const parsed1 = parseStructuredPlan(first);
  if (parsed1.plan && parsed1.errors.length === 0) {
    return { plan: parsed1.plan, errors: [] };
  }
  if (signal.aborted) return { plan: parsed1.plan, errors: parsed1.errors };

  // Retry once with the errors fed back as an extra user turn.
  messages.push({ role: 'assistant', content: first });
  messages.push({
    role: 'user',
    content:
      'Your previous reply was not an acceptable plan. Issues:\n' +
      parsed1.errors.map((e) => `- ${e}`).join('\n') +
      '\n\nRespond again with ONLY the valid JSON object, fixing every issue ' +
      'above (every step must have non-empty acceptanceCriteria).\n\n' +
      PLAN_JSON_INSTRUCTION,
  });
  const second = await chat(messages, model, signal, meter);
  const parsed2 = parseStructuredPlan(second);
  return { plan: parsed2.plan, errors: parsed2.errors };
}

/** Plain-prose synthesis fallback — no JSON contract. Used only when
 *  structured synthesis fails both attempts. */
export async function synthesizeProse(
  prompt: string,
  drafts: { lens: string; text: string }[],
  model: string,
  signal: AbortSignal,
  meter?: CostMeter,
): Promise<string> {
  if (drafts.length === 1 && drafts[0].text.trim()) return drafts[0].text;
  return chat(
    [
      { role: 'system', content: SYNTHESIS_SYSTEM },
      { role: 'user', content: synthesisUser(prompt, drafts) },
    ],
    model,
    signal,
    meter,
  );
}
