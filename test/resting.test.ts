import { afterEach, beforeEach, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KalshiCredentials } from '../src/kalshi/client';
import { killSwitchPath, type AppConfig } from '../src/config';
import { CLASSIC_CONFIG as DEFAULT_CONFIG } from './classic';
import { evaluate, makerOrderFee, orderFee, planRest, priceSkip, activePause, type Proposal } from '../src/trade/edge';
import { execute } from '../src/trade/executor';
import { mergeUpdates, readLedger, restingOrders, tradedTickers, type LedgerEntry } from '../src/trade/ledger';
import { syncResting } from '../src/trade/resting';
import { toV2Body } from '../src/kalshi/account';
import { scorecard } from '../src/trade/scorecard';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const creds: KalshiCredentials = { env: 'demo', apiKeyId: 'k', privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
const inMin = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

const cfgWith = (risk: Partial<AppConfig['risk']> = {}): AppConfig => ({
  ...structuredClone(DEFAULT_CONFIG), country: 'CO', mode: 'auto',
  risk: { ...structuredClone(DEFAULT_CONFIG.risk), marketWeight: 0, maxNotionalPerOrder: 5, maxOpenExposurePct: 1, autoSize: false, minWinProfit: 0, requireStatedAboveCost: false, ...risk },
});
const matchAt = (ask: number, bid: number, kickoff = inMin(120)) => ({
  ok: true, prediction: { id: 'p1', league: 'USA MLS', kickoff, home: 'A', away: 'B', bet: 'T+1.5', statedPct: 83 },
  spec: { kind: 'total', line: 1.5, side: 'yes' }, event: { event_ticker: 'E', title: 'A vs B' },
  market: { ticker: 'KXT-1', status: 'active', yes_ask_dollars: ask.toFixed(4), yes_bid_dollars: bid.toFixed(4), no_ask_dollars: (1 - bid).toFixed(4), occurrence_datetime: new Date(Date.parse(kickoff) + 3 * 3600e3).toISOString(), close_time: new Date(Date.parse(kickoff) + 48 * 3600e3).toISOString() },
  side: 'yes',
}) as any;
const ctx = { bankroll: 100, dailyRemaining: Infinity, minutesToKickoff: 120, probabilityStdErr: 0.02 };

test('maker fee is about a quarter of the taker fee', () => {
  expect(makerOrderFee(10, 0.5)).toBe(0.05);
  expect(orderFee(10, 0.5)).toBe(0.18);
});

test('buy at our price: bids one cent over the best bid, never above what the pick is worth', () => {
  const risk = cfgWith().risk;
  // 81% win chance, ask 84c: too high (need 5% + 1x2% = 7%).
  const m = matchAt(0.84, 0.70);
  const atAsk = evaluate(m, 0.81, risk, ctx)!;
  expect(priceSkip(atAsk.skip)).toBe(true);
  const plan = planRest(m, 0.81, risk, ctx, inMin(105))!;
  // Worth up to 0.81 - 0.07 - maker fee ~ 73c; best bid is 70c -> bid 71c.
  expect(plan.rest!.maxPay).toBe(0.73);
  expect(plan.rest!.price).toBe(0.71);
  expect(plan.skip).toBeUndefined();
  expect(plan.contracts).toBeGreaterThan(0);
  expect(plan.edge).toBeGreaterThanOrEqual(plan.required!);
  // Best bid already above what it's worth: wait at the most it's worth.
  expect(planRest(matchAt(0.84, 0.78), 0.81, risk, ctx, inMin(105))!.rest!.price).toBe(0.73);
  // Our own order is the best bid: don't bid against ourselves.
  expect(planRest(matchAt(0.84, 0.71), 0.81, risk, ctx, inMin(105), 0.71)!.rest!.price).toBe(0.71);
  // Not a price problem (win chance under the minimum): no plan.
  expect(planRest(m, 0.6, risk, ctx, inMin(105))).toBeNull();
});

test('order body: resting = good till canceled, post only, expiry; sell = reduce only', () => {
  const b = toV2Body({ ticker: 'T', side: 'yes', count: 3, limitPrice: 0.71, clientOrderId: 'c', restUntil: 1_800_000_000 });
  expect(b).toMatchObject({ side: 'bid', price: '0.7100', time_in_force: 'good_till_canceled', post_only: true, expiration_time: 1_800_000_000 });
  const n = toV2Body({ ticker: 'T', side: 'no', count: 3, limitPrice: 0.3, clientOrderId: 'c', restUntil: 1_800_000_000 });
  expect(n).toMatchObject({ side: 'ask', price: '0.7000' });
  const sell = toV2Body({ ticker: 'T', side: 'yes', count: 2, limitPrice: 0.9, clientOrderId: 'c', sell: true });
  expect(sell).toMatchObject({ side: 'ask', time_in_force: 'immediate_or_cancel', reduce_only: true });
  expect(toV2Body({ ticker: 'T', side: 'no', count: 2, limitPrice: 0.9, clientOrderId: 'c', sell: true })).toMatchObject({ side: 'bid', price: '0.1000' });
});

test('ledger: updates merge into their order; resting orders block a second order on the market', () => {
  const rows: LedgerEntry[] = [
    { type: 'order', at: inMin(-10), env: 'demo', predictionId: 'p', ticker: 'T', side: 'yes', count: 5, limitPrice: 0.7, probability: 0.8, edge: 0.05, clientOrderId: 'c1', orderId: 'o1', filled: 0, resting: true, restStatus: 'resting' },
    { type: 'order_update', at: inMin(-5), clientOrderId: 'c1', filled: 2, avgPrice: 0.7, avgFee: 0.004, status: 'resting' },
  ];
  mergeUpdates(rows);
  expect(rows[0]).toMatchObject({ filled: 2, restStatus: 'resting', avgPrice: 0.7 });
  expect(tradedTickers('demo', rows).has('T')).toBe(true);
  rows.push({ type: 'order_update', at: inMin(-1), clientOrderId: 'c1', filled: 2, status: 'canceled' });
  mergeUpdates(rows);
  expect(restingOrders('demo', rows)).toHaveLength(0);
  expect(tradedTickers('demo', rows).has('T')).toBe(true); // 2 filled: still bought
});

test('pauses: active ones skip matching picks', () => {
  const risk = cfgWith({ paused: [{ kind: 'bet', value: 't+1.5', until: inMin(60), reason: 'losing', by: 'claude' }] }).risk;
  expect(activePause({ bet: 'T+1.5', league: 'X' }, risk)).toContain('paused by Claude');
  expect(evaluate(matchAt(0.7, 0.69), 0.81, risk, ctx)!.skip).toContain('paused');
  expect(activePause({ bet: 'T+1.5', league: 'X' }, { paused: [{ kind: 'bet', value: 'T+1.5', until: inMin(-1), reason: '', by: 'you' }] })).toBeNull();
});

// ---- fake Kalshi for orders that wait on the book ----
const realFetch = globalThis.fetch;
let home = '';
let book: Record<string, any> = {};
let posted: any[] = [];
let cancelled: string[] = [];
let ask = 0.84, bid = 0.70;
let omitRemaining = false;
let mockKickoff: string | null = null;
beforeEach(() => {
  omitRemaining = false; mockKickoff = null;
  home = mkdtempSync(join(tmpdir(), 'se-rest-'));
  process.env.SOCCER_EDGE_HOME = home;
  book = {}; posted = []; cancelled = []; ask = 0.84; bid = 0.70;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = new URL(String(input));
    const p = url.pathname;
    if (p.endsWith('/portfolio/positions')) return Response.json({ market_positions: [], cursor: '' });
    if (p.endsWith('/portfolio/balance')) return Response.json({ balance: 10_000, portfolio_value: 0 });
    const mt = p.match(/\/markets\/([^/]+)$/);
    if (mt) return Response.json({ market: { ...matchAt(ask, bid, mockKickoff ?? inMin(120)).market, ticker: decodeURIComponent(mt[1]!) } });
    if (p.endsWith('/portfolio/events/orders') && init.method === 'POST') {
      const b = JSON.parse(init.body); posted.push(b);
      const id = `o${posted.length}`;
      book[id] = { order_id: id, client_order_id: b.client_order_id, ticker: b.ticker, outcome_side: 'yes', status: 'resting', yes_price_dollars: b.price, fill_count_fp: '0.00', remaining_count_fp: b.count, initial_count_fp: b.count, taker_fees_dollars: '0', maker_fees_dollars: '0', taker_fill_cost_dollars: '0', maker_fill_cost_dollars: '0' };
      if (b.client_order_id === 'timeout') throw new Error('timeout');
      return Response.json(omitRemaining ? { order_id: id, fill_count: '0.00' } : { order_id: id, fill_count: '0.00', remaining_count: b.count }, { status: 201 });
    }
    if (p.endsWith('/portfolio/orders') && (init?.method ?? 'GET') === 'GET') return Response.json({ orders: Object.values(book).filter((o: any) => o.status === 'resting'), cursor: '' });
    const one = p.match(/\/portfolio\/orders\/([^/]+)$/);
    if (one) return Response.json({ order: book[one[1]!] });
    const del = p.match(/\/portfolio\/events\/orders\/([^/]+)$/);
    if (del && init.method === 'DELETE') { cancelled.push(del[1]!); const o = book[del[1]!]; const left = o.remaining_count_fp; o.status = 'canceled'; o.remaining_count_fp = '0.00'; return Response.json({ order_id: o.order_id, reduced_by: left, ts_ms: Date.now() }); }
    return new Response('not mocked ' + p, { status: 599 });
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; rmSync(home, { recursive: true, force: true }); });

const restProposal = (cfg: AppConfig): Proposal => planRest(matchAt(ask, bid), 0.81, cfg.risk, ctx, inMin(105))!;

test('a resting order goes on the book, fills later, and is recorded', async () => {
  const cfg = cfgWith();
  const p = restProposal(cfg);
  const sum = await execute(cfg, creds, [p], { confirm: async () => true, log: () => {}, regionChecked: true });
  expect(sum.placed).toBe(1);
  expect(posted[0]).toMatchObject({ time_in_force: 'good_till_canceled', post_only: true, price: '0.7100' });
  expect(restingOrders('demo')).toHaveLength(1);
  // Placing again: the market already has our order.
  await execute(cfg, creds, [p], { confirm: async () => true, log: () => {}, regionChecked: true });
  expect(posted).toHaveLength(1);
  // A seller comes down: 3 fill at 71c.
  Object.assign(book.o1, { fill_count_fp: '3.00', remaining_count_fp: String(Number(posted[0].count) - 3), maker_fill_cost_dollars: '2.13', maker_fees_dollars: '0.01' });
  const logs: string[] = [];
  const r = await syncResting(cfg, creds, { log: (_l, m) => logs.push(m) });
  expect(r.newlyFilled).toBe(3);
  const o = readLedger().find((e) => e.type === 'order') as any;
  expect(o).toMatchObject({ filled: 3, restStatus: 'resting' });
  expect(o.avgPrice).toBeCloseTo(0.71, 4);
  expect(logs.join(' ')).toContain('filled');
});

test('waiting orders come off the book: time up, kill switch, pick changed', async () => {
  const cfg = cfgWith();
  await execute(cfg, creds, [restProposal(cfg)], { confirm: async () => true, log: () => {}, regionChecked: true });
  // Pick changed (keep says no):
  await syncResting(cfg, creds, { log: () => {}, keep: () => 'outbid' });
  expect(cancelled).toEqual(['o1']);
  expect(restingOrders('demo')).toHaveLength(0);
  expect(readLedger().filter((e) => e.type === 'order_update').pop()).toMatchObject({ status: 'canceled', reason: 'outbid' });
  // New order, then the kill switch:
  await execute(cfg, creds, [restProposal(cfg)], { confirm: async () => true, log: () => {}, regionChecked: true });
  expect(posted).toHaveLength(2);
  writeFileSync(killSwitchPath(), 'x');
  await syncResting(cfg, creds, { log: () => {} });
  expect(cancelled).toEqual(['o1', 'o2']);
});

test('if the ask became worth it by order time, the app just buys at the ask', async () => {
  const cfg = cfgWith();
  const p = restProposal(cfg);
  ask = 0.72; bid = 0.71;
  await execute(cfg, creds, [p], { confirm: async () => true, log: () => {}, regionChecked: true });
  expect(posted[0]).toMatchObject({ time_in_force: 'fill_or_kill', price: '0.7200' });
});

test('scorecard groups settled trades', () => {
  const at = new Date().toISOString();
  const sc = scorecard([
    { status: 'won', cost: 7, pnl: 3, bet: 'T+1.5', league: 'MLS', paid: 0.7, source: 'pregame', entry: 'resting', at },
    { status: 'lost', cost: 8, pnl: -8, bet: 'T+1.5', league: 'MLS', paid: 0.8, source: 'pregame', entry: 'ask', at },
    { status: 'open', cost: 5, pnl: 0, bet: 'BTTS', league: 'EPL', paid: 0.5, source: 'pregame', at },
  ]);
  expect(sc.overall).toMatchObject({ trades: 2, won: 1, lost: 1, pnl: -5 });
  expect(sc.byPrice.map((l) => l.key).sort()).toEqual(['70-79¢', '80-89¢']);
  expect(sc.byEntry.find((l) => l.key === 'waited at our price')!.pnl).toBe(3);
});

const onTicker = (p: Proposal, ticker: string, id: string): Proposal => ({ ...p, match: { ...p.match, prediction: { ...p.match.prediction, id }, market: { ...p.match.market, ticker } } });

test('waiting orders count for one-bet-per-match and the open-positions cap', async () => {
  const cfg = cfgWith({ onePerMatch: true, maxOpenPositions: 2 });
  const p = restProposal(cfg);
  const ps = [onTicker(p, 'KXMLSTOTAL-26OCT19AB-1', 'a'), onTicker(p, 'KXMLSTOTAL-26OCT19AB-3', 'b'), onTicker(p, 'KXMLSTOTAL-26OCT19CD-1', 'c'), onTicker(p, 'KXMLSTOTAL-26OCT19EF-1', 'd')];
  await execute(cfg, creds, ps, { confirm: async () => true, log: () => {}, regionChecked: true });
  // AB-1 placed, AB-3 same match skipped, CD-1 placed, EF-1 over the cap of 2.
  expect(posted.map((x) => x.ticker)).toEqual(['KXMLSTOTAL-26OCT19AB-1', 'KXMLSTOTAL-26OCT19CD-1']);
});

test('placement reply without remaining_count is still recorded as waiting', async () => {
  omitRemaining = true;
  const cfg = cfgWith();
  await execute(cfg, creds, [restProposal(cfg)], { confirm: async () => true, log: () => {}, regionChecked: true });
  expect(restingOrders('demo')).toHaveLength(1);
});

test('kill switch: every app order on the book is cancelled, even one the ledger lost', async () => {
  const cfg = cfgWith();
  await execute(cfg, creds, [restProposal(cfg)], { confirm: async () => true, log: () => {}, regionChecked: true });
  // An app order on the book that the ledger shows as failed:
  const cid = (readLedger().find((e) => e.type === 'order') as any).clientOrderId;
  book.o1.status = 'resting';
  writeFileSync(join(home, 'ledger.jsonl'), JSON.stringify({ type: 'order', at: inMin(-1), env: 'demo', predictionId: 'p1', ticker: 'KXT-1', side: 'yes', count: 5, limitPrice: 0.71, probability: 0.8, edge: 0.05, clientOrderId: cid, error: 'timeout', uncertain: true }) + '\n');
  const { cancelAllAppOrders } = await import('../src/trade/resting');
  writeFileSync(killSwitchPath(), 'x');
  expect(await cancelAllAppOrders(cfg, creds, () => {}, 'kill switch is on')).toBe(1);
  expect(cancelled).toEqual(['o1']);
});

test('NO-side fill read from the book list is recorded at our NO price', async () => {
  const cfg = cfgWith();
  const p = restProposal(cfg);
  const noP: Proposal = { ...p, match: { ...p.match, side: 'no' as const } };
  // Book an order by hand as if placed for NO at 30c.
  writeFileSync(join(home, 'ledger.jsonl'), JSON.stringify({ type: 'order', at: inMin(-5), env: 'demo', predictionId: 'p1', ticker: 'KXT-1', side: 'no', count: 5, limitPrice: 0.3, probability: 0.8, edge: 0.05, clientOrderId: 'cno', orderId: 'oN', filled: 0, resting: true, restStatus: 'resting', expiresAt: inMin(60) }) + '\n');
  book.oN = { order_id: 'oN', client_order_id: 'cno', ticker: 'KXT-1', status: 'resting', yes_price_dollars: '0.7000', fill_count_fp: '2.00', remaining_count_fp: '3.00', taker_fees_dollars: '0', maker_fees_dollars: '0', taker_fill_cost_dollars: '0', maker_fill_cost_dollars: '0' };
  void noP;
  await syncResting(cfg, creds, { log: () => {} });
  const o = readLedger().find((e) => e.type === 'order') as any;
  expect(o.filled).toBe(2);
  expect(o.avgPrice).toBeCloseTo(0.3, 4);
});

test('a sliver (under one contract) does not count as having bought the pick', () => {
  const rows: LedgerEntry[] = [{ type: 'order', at: inMin(-1), env: 'demo', predictionId: 'p', ticker: 'T', side: 'yes', count: 6, limitPrice: 0.7, probability: 0.8, edge: 0.05, clientOrderId: 'c', orderId: 'o', filled: 0.02 }];
  expect(tradedTickers('demo', rows).has('T')).toBe(false);
  rows.push({ type: 'order', at: inMin(0), env: 'demo', predictionId: 'p', ticker: 'T', side: 'yes', count: 6, limitPrice: 0.7, probability: 0.8, edge: 0.05, clientOrderId: 'c2', orderId: 'o2', filled: 6 });
  expect(tradedTickers('demo', rows).has('T')).toBe(true);
});

test('defaults (as PredyGo intends): no edge or win-chance filter, but max price and kickoff still apply', async () => {
  const { effectiveConfig, DEFAULT_CONFIG } = await import('../src/config');
  const risk = effectiveConfig(structuredClone(DEFAULT_CONFIG)).risk;
  const m = matchAt(0.84, 0.82);
  const p = evaluate(m, 0.6, risk, ctx)!; // 60% win chance at 84c: a skip with every rule on
  expect(p.skip).toBeUndefined();
  expect(p.contracts).toBeGreaterThan(0);
  expect(evaluate(matchAt(0.97, 0.96), 0.9, risk, ctx)!.skip).toContain('max'); // nothing left to win
  expect(evaluate(m, 0.6, risk, { ...ctx, minutesToKickoff: 1 })!.skip).toContain('kickoff');
  expect(evaluate(m, 0.6, cfgWith().risk, ctx)!.skip).toBeTruthy(); // every rule on: filtered
});

test('defaults: filters opened, nonsense still blocked, saved settings untouched', async () => {
  const { effectiveConfig, DEFAULT_CONFIG } = await import('../src/config');
  const saved = structuredClone(DEFAULT_CONFIG);
  const f = effectiveConfig(saved);
  expect(saved.risk.minProbability).toBe(DEFAULT_CONFIG.risk.minProbability); // untouched
  expect(f.risk).toMatchObject({ blockBtts: false, blockOver25: false, maxPrice: 0.96, minMinutesBeforeKickoff: 2, onePerMatch: true, maxOpenExposurePct: 1 });
  expect(f.risk).toMatchObject({ maxDailySpend: 0, restOrders: false, useKalshiOdds: true, stakeMode: 'flat' });
  expect(f.ai.precheck).toBe('off');
  const btts = { ...matchAt(0.7, 0.69), prediction: { ...matchAt(0.7, 0.69).prediction, bet: 'BTTS' } };
  expect(evaluate(btts, 0.5, f.risk, ctx)!.skip).toBeUndefined();                       // any win chance (PredyGo gates bet types at the source)
  expect(evaluate(matchAt(0.7, 0.69), 0.8, f.risk, { ...ctx, minutesToKickoff: 5 })!.skip).toBeUndefined(); // 5 min before kickoff ok
  expect(evaluate(matchAt(0.7, 0.69), 0.8, f.risk, { ...ctx, minutesToKickoff: 1 })!.skip).toContain('kickoff');
  expect(evaluate(matchAt(0.97, 0.96), 0.9, f.risk, ctx)!.skip).toContain('max');       // nothing left to win
  expect(evaluate(matchAt(0.03, 0.02), 0.9, f.risk, ctx)!.skip).toContain('lost');      // as good as lost
});

test('a saved Follow PredyGo setting (before v0.36) becomes the same settings', async () => {
  const { migrateFollow, effectiveConfig, DEFAULT_RULES_OFF } = await import('../src/config');
  const saved: any = cfgWith({ blockBtts: true, maxPrice: 0.8, minMinutesBeforeKickoff: 15, maxOpenExposurePct: 0.6, stakeMode: 'kelly' });
  saved.risk.followAll = true; saved.risk.rulesOff = ['region'];
  saved.ai.precheck = 'veto';
  migrateFollow(saved);
  expect(saved.risk.followAll).toBeUndefined();
  expect(saved.risk.rulesOff).toEqual(['region', ...DEFAULT_RULES_OFF]);
  expect(saved.risk).toMatchObject({ blockBtts: false, maxPrice: 0.96, minMinutesBeforeKickoff: 2, maxOpenExposurePct: 1, stakeMode: 'flat', restOrders: false });
  expect(saved.live).toMatchObject({ mode: 'trade', maxMinutesSinceKickoff: 95, maxPickAgeSec: 300 });
  expect(saved.ai.precheck).toBe('off');
  expect(evaluate(matchAt(0.84, 0.82), 0.6, effectiveConfig(saved).risk, ctx)!.skip).toBeUndefined();
  const off: any = cfgWith({ maxPrice: 0.8 }); off.risk.followAll = false;
  migrateFollow(off);
  expect(off.risk.followAll).toBeUndefined();
  expect(off.risk.maxPrice).toBe(0.8);                                                  // was off: nothing changes
});

test('PredyGo high-risk picks are skipped unless turned on, with any rule settings', async () => {
  const { effectiveConfig, DEFAULT_CONFIG } = await import('../src/config');
  const hr = { ...matchAt(0.7, 0.69), prediction: { ...matchAt(0.7, 0.69).prediction, highRisk: true } };
  for (const risk of [cfgWith().risk, effectiveConfig(structuredClone(DEFAULT_CONFIG)).risk]) {
    expect(evaluate(hr, 0.95, risk, { ...ctx, live: true })).toMatchObject({ skip: 'high-risk pick (PredyGo: late-game, not graded); turned off', hard: true });
    expect(evaluate(hr, 0.95, { ...risk, tradeHighRisk: true }, { ...ctx, live: true })!.skip ?? '').not.toMatch(/high-risk/);
  }
  const { normalizeRows } = await import('../src/predictions/sources');
  const row = (extra: object) => ({ id: 1, league: 'L', home: 'A', away: 'B', market: { code: 'T+1.5' }, confidence: 80, kickoff: '2026-11-03T15:00:00Z', source: 'live', ...extra });
  expect(normalizeRows([row({ high_risk: true })])[0]!.highRisk).toBe(true);
  expect(normalizeRows([row({ high_risk: false })])[0]!.highRisk).toBeUndefined();
  expect(normalizeRows([row({})])[0]!.highRisk).toBeUndefined();
});

test('Pre-game / Live switches', async () => {
  const { effectiveConfig, pregameOn, DEFAULT_CONFIG } = await import('../src/config');
  const base = structuredClone(DEFAULT_CONFIG);
  expect(base.live.mode).toBe('trade');                                                         // live picks checked by default
  expect(effectiveConfig(base).live.mode).toBe('watch');                                       // ...but the Live switch starts off
  base.trading = { live: true };
  expect(effectiveConfig(base).live.mode).toBe('trade');                                        // live on
  expect(effectiveConfig({ ...base, trading: { live: false } }).live.mode).toBe('watch');      // live off
  expect(base.live.mode).toBe('trade');                                                         // saved settings untouched
  expect(pregameOn({})).toBe(true);
  expect(pregameOn({ trading: { pregame: false } })).toBe(false);
});
