// Per-stage model routing + cost metering. process.env reads only; never throws on bad env.

export type Stage = 'planner' | 'synthesis' | 'verify' | 'repair' | 'execute';

export function stageModel(stage: Stage): string {
  return (
    process.env['PI_' + stage.toUpperCase() + '_MODEL'] ||
    process.env.PI_MODEL ||
    'deepseek-v4-pro'
  );
}

export function fallbackModels(): string[] {
  const raw = process.env.PI_FALLBACK_MODELS;
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export function parseUsage(json: unknown): Usage {
  const usage =
    json && typeof json === 'object'
      ? (json as Record<string, unknown>).usage
      : undefined;
  const u =
    usage && typeof usage === 'object'
      ? (usage as Record<string, unknown>)
      : {};
  return {
    promptTokens: num(u.prompt_tokens),
    completionTokens: num(u.completion_tokens),
  };
}

export interface ModelCost {
  inPer1k: number;
  outPer1k: number;
}

const DEFAULT_COSTS: Record<string, ModelCost> = {
  'deepseek-v4-pro': { inPer1k: 0.0005, outPer1k: 0.0015 },
};

export function costTable(): Record<string, ModelCost> {
  const table: Record<string, ModelCost> = { ...DEFAULT_COSTS };
  const raw = process.env.PI_COST_JSON;
  if (!raw) return table;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      Object.assign(table, parsed as Record<string, ModelCost>);
    }
  } catch {
    // Bad JSON -> defaults only.
  }
  return table;
}

// Estimate used for models absent from the cost table, so token spend (and the
// cost ceiling) stay meaningful for fallback/unpriced models instead of silently
// reading as $0. Override per-model via PI_COST_JSON, or set a "default" key
// there to tune the estimate.
const DEFAULT_PRICE: ModelCost = { inPer1k: 0.0005, outPer1k: 0.0015 };

export function costOf(model: string, u: Usage): number {
  const table = costTable();
  const cost = table[model] ?? table['default'] ?? DEFAULT_PRICE;
  const inPer1k = num(cost.inPer1k);
  const outPer1k = num(cost.outPer1k);
  return (num(u.promptTokens) / 1000) * inPer1k + (num(u.completionTokens) / 1000) * outPer1k;
}

export class CostExceededError extends Error {}

export class CostMeter {
  private readonly ceiling: number | null;
  private usd = 0;
  private prompt = 0;
  private completion = 0;

  constructor(ceilingUsd: number | null) {
    this.ceiling = ceilingUsd;
  }

  add(model: string, u: Usage): void {
    this.prompt += num(u.promptTokens);
    this.completion += num(u.completionTokens);
    this.usd += costOf(model, u);
  }

  spentUsd(): number {
    return this.usd;
  }

  promptTokens(): number {
    return this.prompt;
  }

  completionTokens(): number {
    return this.completion;
  }

  remainingUsd(): number | null {
    return this.ceiling === null ? null : this.ceiling - this.usd;
  }

  exceeded(): boolean {
    return this.ceiling === null ? false : this.usd >= this.ceiling;
  }

  guard(): void {
    if (this.exceeded()) {
      throw new CostExceededError('cost ceiling exceeded');
    }
  }
}

/**
 * Call `fn` with each model in `models` in order, returning the first success.
 * Throws the last error if all models fail. CostExceededError is re-thrown
 * immediately (ceiling enforcement is cooperative: the guard() check before
 * every call is a best-effort budget gate, not a strict hard limit — a
 * concurrent call can push spend over the ceiling between guard and spend).
 */
export async function callWithFallback<T>(
  models: string[],
  fn: (model: string) => Promise<T>,
): Promise<T> {
  if (models.length === 0) {
    throw new Error('callWithFallback: no models provided');
  }
  let lastErr: unknown;
  for (const model of models) {
    try {
      return await fn(model);
    } catch (err) {
      if (err instanceof CostExceededError) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}
