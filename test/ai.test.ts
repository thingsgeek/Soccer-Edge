import { afterAll, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'se-ai-'));
process.env.SOCCER_EDGE_HOME = home;
const { callClaude, spentTodayUsd, costOf } = await import('../src/ai/claude');
const { precheck } = await import('../src/ai/assistant');
const { DEFAULT_CONFIG } = await import('../src/config');

let reply: any = { verdict: 'ok', reason: 'fine', issues: [] };
let lastBody: any = null;
let lastHeaders: Record<string, string> = {};
let status = 200;
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    lastHeaders = Object.fromEntries(req.headers);
    lastBody = await req.json();
    if (status !== 200) return Response.json({ type: 'error', error: { message: 'invalid x-api-key' } }, { status });
    return Response.json({ content: [{ type: 'text', text: JSON.stringify(reply) }], stop_reason: 'end_turn', usage: { input_tokens: 1500, output_tokens: 300 } });
  },
});
process.env.SOCCER_EDGE_ANTHROPIC_URL = `http://127.0.0.1:${server.port}/v1/messages`;
afterAll(() => { server.stop(true); rmSync(home, { recursive: true, force: true }); });
beforeEach(() => { status = 200; reply = { verdict: 'ok', reason: 'fine', issues: [] }; });

const schema = { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'], additionalProperties: false };

test('Claude call: structured output request, cost and usage tracked, budget enforced', async () => {
  const r = await callClaude<any>({ apiKey: 'sk-ant-test', model: 'claude-haiku-5-5', system: 's', user: 'u', schema, maxTokens: 1000, timeoutMs: 5000, purpose: 'test' });
  expect(r.data.verdict).toBe('ok');
  expect(lastHeaders['x-api-key']).toBe('sk-ant-test');
  expect(lastHeaders['anthropic-version']).toBe('2023-06-01');
  expect(lastBody).toMatchObject({ model: 'claude-haiku-5-5', output_config: { format: { type: 'json_schema', schema } } });
  expect(r.costUsd).toBeCloseTo(costOf('claude-haiku-5-5', 1500, 300), 8);
  expect(r.costUsd).toBeCloseTo(0.0003, 6); // $0.10/M in, $0.50/M out
  expect(spentTodayUsd()).toBeGreaterThan(0);
  await expect(callClaude<any>({ apiKey: 'k', model: 'claude-haiku-5-5', system: 's', user: 'u', schema, maxTokens: 10, timeoutMs: 5000, purpose: 'test', budgetUsd: 0.0001 })).rejects.toThrow('budget');
  status = 401;
  await expect(callClaude<any>({ apiKey: 'bad', model: 'claude-haiku-5-5', system: 's', user: 'u', schema, maxTokens: 10, timeoutMs: 5000, purpose: 'test' })).rejects.toThrow('rejected the API key');
});

const proposal: any = {
  match: { ok: true, prediction: { id: 'p', league: 'USA MLS', home: 'LAFC', away: 'Austin FC', bet: 'T+1.5', kickoff: new Date().toISOString(), statedPct: 80, source: 'pregame' },
    spec: { kind: 'total', line: 1.5, side: 'yes' }, side: 'yes', event: { title: 'Los Angeles F vs Austin' }, market: { ticker: 'KXMLSTOTAL-X-2', title: 'Over 1.5', yes_sub_title: 'Over 1.5 goals scored', status: 'active' } },
  probability: 0.81, quote: { ask: 0.7, bid: 0.69, spreadCents: 1 }, cost: 0.715, edge: 0.095, kelly: 0.3, contracts: 6, notional: 4.2, required: 0.05,
};


test('pre-trade check: verdict, fail-open/closed when Claude is down', async () => {
  const cfg: any = structuredClone(DEFAULT_CONFIG);
  reply = { verdict: 'block', reason: 'contract is for first half', issues: [{ type: 'mapping', detail: 'bet code and contract disagree' }] };
  const r = await precheck(cfg, 'sk-ant-x', proposal, {});
  expect(r.result.verdict).toBe('block');
  expect(JSON.parse(lastBody.messages[0].content).kalshiContract.ticker).toBe('KXMLSTOTAL-X-2');
  status = 500;
  expect((await precheck({ ...cfg, ai: { ...cfg.ai, failOpen: true } }, 'k', proposal, {})).result.verdict).toBe('ok');
  expect((await precheck({ ...cfg, ai: { ...cfg.ai, failOpen: false } }, 'k', proposal, {})).result.verdict).toBe('block');
});



test('ChatGPT: strict JSON schema request, usage costed, same result shape; one key per provider', async () => {
  const { callOpenAI, callAI, keyLooksRight, providerOf } = await import('../src/ai/claude');
  let body: any = null, auth = '', st = 200;
  const oa = Bun.serve({
    port: 0,
    async fetch(req) {
      auth = req.headers.get('authorization') ?? '';
      body = await req.json();
      if (st !== 200) return Response.json({ error: { message: 'bad key' } }, { status: st });
      return Response.json({ choices: [{ message: { content: JSON.stringify({ verdict: 'ok' }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 200 } });
    },
  });
  process.env.SOCCER_EDGE_OPENAI_URL = `http://127.0.0.1:${oa.port}/v1/chat/completions`;
  try {
    const r = await callOpenAI<{ verdict: string }>({ apiKey: 'sk-test', model: 'gpt-6-luna', system: 'sys', user: 'u', schema, maxTokens: 100, timeoutMs: 5000, purpose: 'precheck' });
    expect(r.data.verdict).toBe('ok');
    expect(auth).toBe('Bearer sk-test');
    expect(body.response_format).toMatchObject({ type: 'json_schema', json_schema: { strict: true, schema } });
    expect(body.messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(r.costUsd).toBeCloseTo((1000 * 0.1 + 200 * 0.5) / 1e6, 10);
    // callAI picks the provider from the model
    expect((await callAI<{ verdict: string }>({ apiKey: 'sk-test', model: 'gpt-6-luna', system: 's', user: 'u', schema, maxTokens: 100, timeoutMs: 5000, purpose: 'precheck' })).model).toBe('gpt-6-luna');
    st = 401;
    await expect(callOpenAI({ apiKey: 'x', model: 'gpt-6-luna', system: 's', user: 'u', schema, maxTokens: 10, timeoutMs: 5000, purpose: 'precheck' })).rejects.toThrow('OpenAI rejected the API key');
  } finally { delete process.env.SOCCER_EDGE_OPENAI_URL; oa.stop(true); }
  expect(providerOf('gpt-6-luna')).toBe('chatgpt');
  expect(providerOf('claude-haiku-5-5')).toBe('claude');
  expect(keyLooksRight('chatgpt', 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz')).toContain('Anthropic');
  expect(keyLooksRight('chatgpt', 'sk-proj-abcdefghijklmnopqrstuvwxyz')).toBeNull();
  expect(keyLooksRight('claude', 'sk-proj-abcdefghijklmnopqrstuvwxyz')).toContain('sk-ant-');
});

test('model discovery: chat models only, newest first; a retired saved model is replaced by the cheapest still offered', async () => {
  const { listModels, pickModel } = await import('../src/ai/claude');
  const oa = Bun.serve({ port: 0, fetch: () => Response.json({ data: [
    { id: 'gpt-6-luna', created: 1_780_000_000 }, { id: 'text-embedding-4', created: 1_790_000_000 }, { id: 'gpt-6-astra', created: 1_785_000_000 },
    { id: 'gpt-6-realtime', created: 1_791_000_000 }, { id: 'tts-2', created: 1_792_000_000 }, { id: 'gpt-7-nano', created: 1_793_000_000 },
  ] }) });
  process.env.SOCCER_EDGE_OPENAI_URL = `http://127.0.0.1:${oa.port}/v1/chat/completions`;
  try {
    const list = await listModels('chatgpt', 'sk-test');
    expect(list.map((m) => m.id)).toEqual(['gpt-7-nano', 'gpt-6-astra', 'gpt-6-luna']);
    expect(pickModel(list, 'gpt-6-astra')).toBe('gpt-6-astra');          // still offered: kept
    expect(pickModel(list, 'gpt-5-old')).toBe('gpt-6-luna');             // retired: cheapest known
    expect(pickModel(list.filter((m) => m.id !== 'gpt-6-luna' && m.id !== 'gpt-6-astra'), 'gpt-5-old')).toBe('gpt-7-nano'); // only unknown ones: a small/fast one
  } finally { delete process.env.SOCCER_EDGE_OPENAI_URL; oa.stop(true); }
  const { costOf } = await import('../src/ai/claude');
  expect(costOf('gpt-7-nano', 1e6, 0)).toBe(0.25);                       // unknown cheap model: a cheap estimate
  expect(costOf('mystery-model', 1e6, 0)).toBe(10);                      // unknown: highest known price, so the budget errs safe
});
