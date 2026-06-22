import type { ToolModule } from './tools.js';
import { parseUsage } from './routing.js';

export interface ToolLoopOpts {
  baseUrl: string;
  apiKey: string;
  model: string;
  system: string;
  user: string;
  tools: ToolModule;
  signal: AbortSignal;
  maxSteps?: number; // default 6
  onStep?: (note: string) => void;
  meter?: import('./routing.js').CostMeter;
}

interface ChatMessage {
  role: string;
  content: string | null;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

// Parse JSON without throwing; return fallback on failure.
function safeParse<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export async function runToolLoop(opts: ToolLoopOpts): Promise<string> {
  // PI_MAX_TOOL_STEPS env or opts.maxSteps; default 12 (was 6)
  // so planners exploring a repo have enough steps for discovery.
  const envSteps = Number(process.env.PI_MAX_TOOL_STEPS);
  const maxSteps = opts.maxSteps ?? (envSteps > 0 ? envSteps : 12);
  const messages: ChatMessage[] = [
    { role: 'system', content: opts.system },
    { role: 'user', content: opts.user },
  ];

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.apiKey) headers['authorization'] = `Bearer ${opts.apiKey}`;

  const post = async (body: unknown): Promise<ChatMessage> => {
    opts.meter?.guard();
    // Combine the caller's abort signal with a hard timeout.
    const FETCH_TIMEOUT_MS = Number(process.env.PI_FETCH_TIMEOUT_MS) || 300_000;
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), FETCH_TIMEOUT_MS);
    let combinedSignal: AbortSignal;
    try {
      combinedSignal = (AbortSignal as any).any?.([opts.signal, timeoutController.signal]) ?? opts.signal;
    } catch {
      combinedSignal = opts.signal;
    }
    opts.signal.addEventListener('abort', () => clearTimeout(timeoutId), { once: true });

    const res = await fetch(`${opts.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: combinedSignal,
    });
    clearTimeout(timeoutId);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`chat/completions ${res.status}: ${text.slice(0, 500)}`);
    }
    const raw = await res.text();
    const data = safeParse<{ choices?: { message?: ChatMessage }[] }>(raw, {});
    opts.meter?.add(opts.model, parseUsage(safeParse<unknown>(raw, {})));
    return data.choices?.[0]?.message ?? { role: 'assistant', content: '' };
  };

  for (let round = 0; round < maxSteps; round++) {
    if (opts.signal.aborted) return '';

    const message = await post({
      model: opts.model,
      messages,
      tools: opts.tools.definitions,
      tool_choice: 'auto',
      stream: false,
    });

    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (toolCalls.length === 0) {
      return message.content ?? '';
    }

    // Push the assistant message verbatim, then resolve each tool call.
    messages.push(message);
    for (const call of toolCalls) {
      if (opts.signal.aborted) return '';
      // A malformed/partially-streamed tool_call may lack id or function.name.
      // A tool message with a missing tool_call_id makes the NEXT request 400,
      // so skip any call we can't safely answer.
      const id = typeof call.id === 'string' && call.id ? call.id : null;
      const name = call.function?.name ?? '';
      if (!id || !name) continue;
      const args = safeParse<Record<string, unknown>>(call.function?.arguments || '{}', {});
      const result = await opts.tools.execute(name, args);
      messages.push({ role: 'tool', tool_call_id: id, content: result });
      opts.onStep?.(`tool: ${name}`);
    }
  }

  if (opts.signal.aborted) return '';

  // Tool rounds exhausted: force a final text answer with no tools.
  // Include tools alongside tool_choice:'none': tool_choice is only valid when
  // a tools array is present, so omitting it 400s on some gateways.
  const final = await post({
    model: opts.model,
    messages,
    tools: opts.tools.definitions,
    tool_choice: 'none',
    stream: false,
  });
  return final.content ?? '';
}
