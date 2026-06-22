// Provider-agnostic adversarial verification panel.
// NO network and NO I/O: the chat function is injected so this is unit-testable.

export interface Vote {
  lens: string;
  sound: boolean;
  issues: string[];
}

export interface PanelResult {
  sound: boolean;
  refuted: number;
  total: number;
  votes: Vote[];
}

export type ChatFn = (
  messages: { role: string; content: string }[],
  model: string,
  signal: AbortSignal,
) => Promise<string>;

// Four distinct adversarial verifier system prompts. Each is skeptical by
// default and demands a leading VERDICT line plus a bulleted issue list.
const VERDICT_INSTRUCTION =
  'Reply with the FIRST line being exactly "VERDICT: SOUND" or "VERDICT: NEEDS_REVISION", ' +
  'then a bulleted list (lines starting with "-") of concrete, specific issues. ' +
  'You are adversarial: actively try to refute the plan. If you are unsure or lack ' +
  'evidence that it is correct, default to VERDICT: NEEDS_REVISION.';

export const VERIFIER_LENSES: { lens: string; system: string }[] = [
  {
    lens: 'correctness',
    system:
      'You are a rigorous correctness reviewer. Determine whether the plan\'s steps are ' +
      'logically right and complete for the stated goal. Look for wrong ordering, false ' +
      'assumptions, logical gaps, and steps that do not actually achieve the goal. ' +
      VERDICT_INSTRUCTION,
  },
  {
    lens: 'security',
    system:
      'You are an adversarial security reviewer. Determine whether the plan introduces ' +
      'vulnerabilities or unsafe operations (injection, secret leakage, unsafe shell/eval, ' +
      'path traversal, destructive or irreversible actions, missing auth/validation). ' +
      VERDICT_INSTRUCTION,
  },
  {
    lens: 'feasibility',
    system:
      'You are a feasibility reviewer. Determine whether this plan can actually be executed ' +
      'against a real repository: do referenced files, APIs, tools, and prerequisites exist, ' +
      'and are the steps concretely actionable rather than hand-wavy? ' +
      VERDICT_INSTRUCTION,
  },
  {
    lens: 'completeness',
    system:
      'You are a completeness reviewer. Determine what is MISSING from the plan: unhandled ' +
      'edge cases, no tests, no rollback or recovery, no error handling, ignored failure modes. ' +
      VERDICT_INSTRUCTION,
  },
];

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  const i = Math.trunc(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

// Parse a raw verifier reply into a Vote. Never throws on any input.
export function parseVerdict(lens: string, raw: string): Vote {
  const text = typeof raw === 'string' ? raw : '';
  const lines = text.split(/\r?\n/);

  // First non-empty line, uppercased, drives the verdict.
  let verdictLine = '';
  for (const line of lines) {
    if (line.trim() !== '') {
      verdictLine = line.trim().toUpperCase();
      break;
    }
  }

  // Skeptical default: only SOUND when SOUND is present and NEEDS_REVISION is not.
  const sound =
    verdictLine.includes('SOUND') && !verdictLine.includes('NEEDS_REVISION');

  // Issues = subsequent lines starting with '-', '*', or a digit followed by '.'/')'.
  const issues: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') continue;
    const bullet = /^[-*]\s*/;
    const numbered = /^\d+[.)]\s*/;
    if (bullet.test(line)) {
      const issue = line.replace(bullet, '').trim();
      if (issue !== '') issues.push(issue);
    } else if (numbered.test(line)) {
      const issue = line.replace(numbered, '').trim();
      if (issue !== '') issues.push(issue);
    }
  }

  return { lens, sound, issues };
}

export async function runVerifyPanel(opts: {
  prompt: string;
  planText: string;
  model: string;
  signal: AbortSignal;
  chat: ChatFn;
  verifiers?: number;
}): Promise<PanelResult> {
  const n = clamp(opts.verifiers ?? 3, 1, VERIFIER_LENSES.length);
  const lenses = VERIFIER_LENSES.slice(0, n);

  const user = `Task:\n${opts.prompt}\n\nPlan to refute:\n${opts.planText}`;

  const settled = await Promise.allSettled(
    lenses.map((lens) =>
      opts.chat(
        [
          { role: 'system', content: lens.system },
          { role: 'user', content: user },
        ],
        opts.model,
        opts.signal,
      ),
    ),
  );

  const votes: Vote[] = settled.map((res, i) => {
    const lens = lenses[i].lens;
    if (res.status === 'fulfilled') {
      return parseVerdict(lens, res.value);
    }
    // A rejected verifier call is a fail-safe REFUTE vote (skeptical).
    return { lens, sound: false, issues: ['verifier call failed'] };
  });

  const refuted = votes.reduce((acc, v) => acc + (v.sound ? 0 : 1), 0);

  // Decision rule: the panel is NOT sound iff refuted > 0 AND refuted * 2 >= total,
  // i.e. a tie OR a majority of refutes triggers revision.
  const sound = !(refuted > 0 && refuted * 2 >= n);

  return { sound, refuted, total: n, votes };
}
