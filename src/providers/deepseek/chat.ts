/**
 * OpenAI-compatible /chat/completions transport.
 *
 * Pure fetch wrapper with cost metering. Used by every pipeline stage
 * (planners, synthesis, verify, repair, execute).
 */
import { parseUsage, type CostMeter } from '../../routing.js';

const BASE_URL = process.env.PI_BASE_URL || 'http://localhost:8000/v1';
const API_KEY = process.env.PI_API_KEY || '';
const PROVIDER_NAME = 'fairy-tales-deepseek-openai';

/** HTTP request timeout (ms). Prevents hanging forever on a stalled
 *  connection. Default 5 min — planners + synthesis can take a while. */
const FETCH_TIMEOUT_MS =
  Number(process.env.PI_FETCH_TIMEOUT_MS) || 300_000;

export const DEFAULT_MODEL = process.env.PI_MODEL || 'deepseek-v4-pro';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Raw chat call against the OpenAI-compatible endpoint. Throws on HTTP errors,
 *  empty completions, or cost ceiling exceeded. */
export async function chat(
  messages: ChatMessage[],
  model: string,
  signal: AbortSignal,
  meter?: CostMeter,
): Promise<string> {
  meter?.guard();
  // Combine the caller's abort signal with a hard timeout so a stalled
  // connection can't hang the entire pipeline forever.
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), FETCH_TIMEOUT_MS);
  let combinedSignal: AbortSignal;
  try {
    // AbortSignal.any is available in Node 20+ and modern runtimes.
    combinedSignal = (AbortSignal as any).any?.([signal, timeoutController.signal]) ?? signal;
  } catch {
    combinedSignal = signal;
  }
  // If the caller's signal fires first, stop the timeout timer.
  signal.addEventListener('abort', () => clearTimeout(timeoutId), { once: true });

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    signal: combinedSignal,
    headers: {
      'Content-Type': 'application/json',
      ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
    },
    body: JSON.stringify({ model, messages, stream: false }),
  });
  clearTimeout(timeoutId);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${PROVIDER_NAME} HTTP ${res.status}: ${body.slice(0, 500)}`);
  }
  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  meter?.add(model, parseUsage(json));
  const text = json.choices?.[0]?.message?.content;
  if (!text) throw new Error(`${PROVIDER_NAME}: empty completion`);
  return text;
}
