/**
 * Minimal AI clients for the optional pre-trade check: Claude (Anthropic Messages API) or
 * ChatGPT (OpenAI Chat Completions API). One call, JSON out (structured outputs), with a
 * timeout, a cost estimate and one daily budget shared by both.
 */
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { appHome, ensureHome } from '../config';
import { readJsonl } from '../trade/picklog';

export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
export const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

export type AiProvider = 'claude' | 'chatgpt';
export const PROVIDER_NAME: Record<AiProvider, string> = { claude: 'Claude', chatgpt: 'ChatGPT' };

/** USD per million tokens [input, output]: Anthropic's pricing page (Oct 2026), OpenAI's (Oct 2026). */
export const PRICES: Record<string, [number, number]> = {
  'claude-haiku-5-5': [0.1, 0.5],
  'claude-sonnet-5-5': [2, 10],
  'claude-opus-5-5': [4, 20],
  'gpt-6-luna': [0.1, 0.5],
  'gpt-6.1-sol': [2, 10],
  'gpt-6-astra': [10, 50],
};

export const MODEL_CHOICES: { id: string; label: string; provider: AiProvider }[] = [
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (cheapest, fast)', provider: 'claude' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (balanced)', provider: 'claude' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (strongest, pricier)', provider: 'claude' },
  { id: 'gpt-6-luna', label: 'GPT-6 Luna (cheapest, fast)', provider: 'chatgpt' },
  { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol (balanced)', provider: 'chatgpt' },
  { id: 'gpt-6-astra', label: 'GPT-6 Astra (strongest, pricier)', provider: 'chatgpt' },
];
/** The cheap default model for each provider. */
export const DEFAULT_MODEL: Record<AiProvider, string> = { claude: 'claude-haiku-5-5', chatgpt: 'gpt-6-luna' };
export const providerOf = (model: string): AiProvider => MODEL_CHOICES.find((m) => m.id === model)?.provider ?? (/^claude/i.test(model) ? 'claude' : 'chatgpt');

/** API key formats, to catch a key pasted into the wrong box. */
export function keyLooksRight(provider: AiProvider, key: string): string | null {
  if (provider === 'claude') return /^sk-ant-[\w-]{20,}$/.test(key) ? null : "That doesn't look like an Anthropic API key (it starts with sk-ant-).";
  if (key.startsWith('sk-ant-')) return 'That is an Anthropic (Claude) key. Choose Claude, or paste an OpenAI key (it starts with sk-).';
  return /^sk-[\w-]{20,}$/.test(key) ? null : "That doesn't look like an OpenAI API key (it starts with sk-).";
}

export const aiUsagePath = (): string => join(appHome(), 'ai-usage.jsonl');

export class ClaudeError extends Error {
  constructor(msg: string, readonly status?: number) { super(msg); this.name = 'ClaudeError'; }
}

/**
 * Estimated cost. A model without a known price (new, discovered from the provider) is costed
 * like a cheap model if its name says small/fast, else at the highest known price, so the
 * daily budget errs on the safe side.
 */
export function costOf(model: string, inTok: number, outTok: number): number {
  const known = PRICES[model];
  const top = Object.values(PRICES).reduce((a, p) => (p[1] > a[1] ? p : a));
  const [i, o] = known ?? (/(haiku|luna|nano|mini|lite|flash|small)/i.test(model) ? [0.25, 1.25] : top);
  return (inTok * i + outTok * o) / 1e6;
}

/** Dollars spent on the AI check today (local date, both providers). */
export function spentTodayUsd(): number {
  const today = new Date().toLocaleDateString('en-CA');
  return +readJsonl<{ at: string; cost: number }>(aiUsagePath())
    .filter((u) => new Date(u.at).toLocaleDateString('en-CA') === today)
    .reduce((a, u) => a + (u.cost || 0), 0).toFixed(4);
}

/** Today's AI spend by what it was for (trade checks, key check), with call counts. */
export function spentTodayByPurpose(): Record<string, { cost: number; calls: number }> {
  const today = new Date().toLocaleDateString('en-CA');
  const out: Record<string, { cost: number; calls: number }> = {};
  for (const u of readJsonl<{ at: string; cost: number; purpose?: string }>(aiUsagePath())) {
    if (new Date(u.at).toLocaleDateString('en-CA') !== today) continue;
    const k = u.purpose ?? 'other';
    out[k] = { cost: +((out[k]?.cost ?? 0) + (u.cost || 0)).toFixed(4), calls: (out[k]?.calls ?? 0) + 1 };
  }
  return out;
}

function logUsage(purpose: string, model: string, inTok: number, outTok: number): number {
  const cost = costOf(model, inTok, outTok);
  try { ensureHome(); appendFileSync(aiUsagePath(), JSON.stringify({ at: new Date().toISOString(), purpose, model, inTok, outTok, cost: +cost.toFixed(6) }) + '\n'); } catch {}
  return cost;
}

export interface ClaudeCall<T> { data: T; model: string; inputTokens: number; outputTokens: number; costUsd: number; ms: number }

export async function callClaude<T>(opts: {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  schema: Record<string, unknown>;
  maxTokens: number;
  timeoutMs: number;
  purpose: string;
  budgetUsd?: number;
  url?: string;
}): Promise<ClaudeCall<T>> {
  if (opts.budgetUsd !== undefined && spentTodayUsd() >= opts.budgetUsd) {
    throw new ClaudeError(`Daily AI budget of $${opts.budgetUsd.toFixed(2)} reached`);
  }
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(opts.url ?? process.env.SOCCER_EDGE_ANTHROPIC_URL ?? ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'x-api-key': opts.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: opts.maxTokens,
        system: opts.system,
        messages: [{ role: 'user', content: opts.user }],
        output_config: { format: { type: 'json_schema', schema: opts.schema } },
      }),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (e) {
    throw new ClaudeError(e instanceof Error && e.name === 'TimeoutError' ? `Claude didn't answer within ${Math.round(opts.timeoutMs / 1000)}s` : `Couldn't reach Claude: ${e instanceof Error ? e.message : e}`);
  }
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.message ?? res.statusText;
    throw new ClaudeError(res.status === 401 ? 'Anthropic rejected the API key' : `Claude error ${res.status}: ${msg}`, res.status);
  }
  const inTok = Number(body?.usage?.input_tokens ?? 0) + Number(body?.usage?.cache_read_input_tokens ?? 0) + Number(body?.usage?.cache_creation_input_tokens ?? 0);
  const outTok = Number(body?.usage?.output_tokens ?? 0);
  const cost = logUsage(opts.purpose, opts.model, inTok, outTok);
  if (body?.stop_reason === 'refusal') throw new ClaudeError('Claude declined this request');
  const text = (body?.content ?? []).filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('');
  let data: T;
  try { data = JSON.parse(text) as T; } catch { throw new ClaudeError(body?.stop_reason === 'max_tokens' ? 'Claude ran out of room before finishing' : "Claude's answer wasn't valid JSON"); }
  return { data, model: opts.model, inputTokens: inTok, outputTokens: outTok, costUsd: cost, ms: Date.now() - started };
}

type CallOpts = Parameters<typeof callClaude>[0];

/** ChatGPT (OpenAI Chat Completions, strict JSON schema): same inputs and result as callClaude. */
export async function callOpenAI<T>(opts: CallOpts): Promise<ClaudeCall<T>> {
  if (opts.budgetUsd !== undefined && spentTodayUsd() >= opts.budgetUsd) {
    throw new ClaudeError(`Daily AI budget of $${opts.budgetUsd.toFixed(2)} reached`);
  }
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(opts.url ?? process.env.SOCCER_EDGE_OPENAI_URL ?? OPENAI_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: opts.model,
        max_completion_tokens: opts.maxTokens,
        messages: [{ role: 'system', content: opts.system }, { role: 'user', content: opts.user }],
        response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema: opts.schema } },
      }),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (e) {
    throw new ClaudeError(e instanceof Error && e.name === 'TimeoutError' ? `ChatGPT didn't answer within ${Math.round(opts.timeoutMs / 1000)}s` : `Couldn't reach ChatGPT: ${e instanceof Error ? e.message : e}`);
  }
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.message ?? res.statusText;
    throw new ClaudeError(res.status === 401 ? 'OpenAI rejected the API key' : `ChatGPT error ${res.status}: ${msg}`, res.status);
  }
  const inTok = Number(body?.usage?.prompt_tokens ?? 0);
  const outTok = Number(body?.usage?.completion_tokens ?? 0);
  const cost = logUsage(opts.purpose, opts.model, inTok, outTok);
  const choice = body?.choices?.[0];
  if (choice?.message?.refusal) throw new ClaudeError('ChatGPT declined this request');
  let data: T;
  try { data = JSON.parse(String(choice?.message?.content ?? '')) as T; } catch { throw new ClaudeError(choice?.finish_reason === 'length' ? 'ChatGPT ran out of room before finishing' : "ChatGPT's answer wasn't valid JSON"); }
  return { data, model: opts.model, inputTokens: inTok, outputTokens: outTok, costUsd: cost, ms: Date.now() - started };
}

/** Call whichever assistant the model belongs to. */
export function callAI<T>(opts: CallOpts): Promise<ClaudeCall<T>> {
  return providerOf(opts.model) === 'chatgpt' ? callOpenAI<T>(opts) : callClaude<T>(opts);
}

// ------------------------------------------------------------ model discovery

export interface ModelChoice { id: string; label: string; provider: AiProvider }

/** Chat models only: OpenAI's list also has embeddings, speech, image and realtime models. */
const OPENAI_SKIP = /(embed|tts|whisper|audio|realtime|transcribe|image|dall-e|moderation|search|computer-use|codex|instruct|-\d{4}-\d{2}-\d{2}$)/i;

/**
 * Ask the provider which models this key can use right now (Anthropic GET /v1/models, OpenAI
 * GET /v1/models), so a retired model is never offered or used. Newest first.
 */
export async function listModels(provider: AiProvider, apiKey: string, timeoutMs = 15_000): Promise<ModelChoice[]> {
  const base = provider === 'chatgpt'
    ? (process.env.SOCCER_EDGE_OPENAI_URL ?? OPENAI_URL).replace(/\/chat\/completions$/, '/models')
    : (process.env.SOCCER_EDGE_ANTHROPIC_URL ?? ANTHROPIC_URL).replace(/\/messages$/, '/models');
  const headers: Record<string, string> = provider === 'chatgpt'
    ? { authorization: `Bearer ${apiKey}` }
    : { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  const out: ModelChoice[] = [];
  let url = base + (provider === 'claude' ? '?limit=100' : '');
  for (let page = 0; page < 5 && url; page++) {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new ClaudeError(`${PROVIDER_NAME[provider]} model list: ${body?.error?.message ?? res.status}`, res.status);
    for (const m of body?.data ?? []) {
      const id = String(m?.id ?? '');
      if (!id) continue;
      if (provider === 'chatgpt' && (!/^(gpt|o\d|chatgpt)/i.test(id) || OPENAI_SKIP.test(id))) continue;
      if (provider === 'claude' && !/^claude/i.test(id)) continue;
      const known = MODEL_CHOICES.find((k) => k.id === id);
      out.push({ id, provider, label: known?.label ?? (m.display_name ? String(m.display_name) : id), created: Date.parse(m.created_at ?? '') || Number(m.created ?? 0) * 1000 } as ModelChoice & { created: number });
    }
    url = provider === 'claude' && body?.has_more && body?.last_id ? `${base}?limit=100&after_id=${encodeURIComponent(body.last_id)}` : '';
  }
  return (out as (ModelChoice & { created: number })[]).sort((a, b) => b.created - a.created).map(({ id, label, provider }) => ({ id, label, provider }));
}

const CHEAP = /(haiku|luna|nano|mini|lite|flash|small)/i;
/**
 * The model to use when the saved one isn't offered any more: the cheapest known one still
 * listed, else the newest small/fast one, else the newest. (Checks are short; cheap is right.)
 */
export function pickModel(list: ModelChoice[], saved: string | undefined): string | null {
  if (!list.length) return null;
  if (saved && list.some((m) => m.id === saved)) return saved;
  const known = list.filter((m) => PRICES[m.id]).sort((a, b) => PRICES[a.id]![0] - PRICES[b.id]![0]);
  return known[0]?.id ?? list.find((m) => CHEAP.test(m.id))?.id ?? list[0]!.id;
}

// ------------------------------------------------------------ chat (plain text answers)

export interface ChatTurn { role: 'user' | 'assistant'; content: string }

/**
 * A plain-text chat answer from the chosen assistant (Claude or ChatGPT, by model). Used by the
 * "Ask the AI" box: read-only analysis, no tools, so it can't change settings or trade.
 */
export async function chatAI(opts: { apiKey: string; model: string; system: string; messages: ChatTurn[]; maxTokens: number; timeoutMs: number; budgetUsd?: number }): Promise<{ text: string; costUsd: number; model: string; inputTokens: number; outputTokens: number }> {
  if (opts.budgetUsd !== undefined && spentTodayUsd() >= opts.budgetUsd) throw new ClaudeError(`Daily AI budget of $${opts.budgetUsd.toFixed(2)} reached`);
  const gpt = providerOf(opts.model) === 'chatgpt';
  const name = gpt ? 'ChatGPT' : 'Claude';
  let res: Response;
  try {
    res = gpt
      ? await fetch(process.env.SOCCER_EDGE_OPENAI_URL ?? OPENAI_URL, {
        method: 'POST', headers: { authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: opts.model, max_completion_tokens: opts.maxTokens, messages: [{ role: 'system', content: opts.system }, ...opts.messages] }),
        signal: AbortSignal.timeout(opts.timeoutMs),
      })
      : await fetch(process.env.SOCCER_EDGE_ANTHROPIC_URL ?? ANTHROPIC_URL, {
        method: 'POST', headers: { 'x-api-key': opts.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: opts.model, max_tokens: opts.maxTokens, system: opts.system, messages: opts.messages }),
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
  } catch (e) {
    throw new ClaudeError(e instanceof Error && e.name === 'TimeoutError' ? `${name} didn't answer within ${Math.round(opts.timeoutMs / 1000)}s` : `Couldn't reach ${name}: ${e instanceof Error ? e.message : e}`);
  }
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new ClaudeError(res.status === 401 ? `${gpt ? 'OpenAI' : 'Anthropic'} rejected the API key` : `${name} error ${res.status}: ${body?.error?.message ?? res.statusText}`, res.status);
  const inTok = gpt ? Number(body?.usage?.prompt_tokens ?? 0) : Number(body?.usage?.input_tokens ?? 0) + Number(body?.usage?.cache_read_input_tokens ?? 0) + Number(body?.usage?.cache_creation_input_tokens ?? 0);
  const outTok = gpt ? Number(body?.usage?.completion_tokens ?? 0) : Number(body?.usage?.output_tokens ?? 0);
  const costUsd = logUsage('chat', opts.model, inTok, outTok);
  const text = gpt
    ? String(body?.choices?.[0]?.message?.content ?? body?.choices?.[0]?.message?.refusal ?? '')
    : (body?.content ?? []).filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('');
  if (!text.trim()) throw new ClaudeError(`${name} returned an empty answer`);
  return { text, costUsd, model: opts.model, inputTokens: inTok, outputTokens: outTok };
}
