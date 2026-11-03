import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { generateKeyPairSync, createVerify, constants } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signRequest, type KalshiCredentials } from '../src/kalshi/client';
import { killSwitchPath, type AppConfig } from '../src/config';
import { CLASSIC_CONFIG as DEFAULT_CONFIG } from './classic';
import { acquireRunLock, clientOrderIdFor, execute } from '../src/trade/executor';
import { readLedger, spentToday, tradedPredictionIds } from '../src/trade/ledger';
import type { Proposal } from '../src/trade/edge';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const creds: KalshiCredentials = { env: 'demo', apiKeyId: 'key-123', privateKeyPem: pem };

test('request signature verifies with RSA-PSS over timestamp+method+path', () => {
  const sig = signRequest(pem, 'POST', '/trade-api/v2/portfolio/events/orders', '1700000000000');
  const v = createVerify('SHA256');
  v.update('1700000000000POST/trade-api/v2/portfolio/events/orders');
  expect(v.verify({ key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, sig, 'base64')).toBe(true);
});

test('client order id is stable per prediction and market', () => {
  expect(clientOrderIdFor('demo', 'p1', 'T1')).toBe(clientOrderIdFor('demo', 'p1', 'T1'));
  expect(clientOrderIdFor('demo', 'p1', 'T1')).not.toBe(clientOrderIdFor('prod', 'p1', 'T1'));
  expect(clientOrderIdFor('demo', 'p1', 'T1')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

// ---- fake Kalshi ----
let orders: any[] = [];
let positions: { ticker: string; position_fp: string }[] = [];
let orderResponse: (body: any) => Response | Promise<Response>;
let marketAsk: Record<string, string> = {};
let marketStatus = 'active';
let askSize: Record<string, string> = {};
let balanceCents = 100_000;
const realFetch = globalThis.fetch;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'se-'));
  process.env.SOCCER_EDGE_HOME = home;
  orders = [];
  positions = [];
  marketAsk = {};
  marketStatus = 'active';
  askSize = {};
  balanceCents = 100_000;
  orderResponse = (b) => Response.json({ order_id: `o${orders.length}`, fill_count: b.count, remaining_count: '0.00', average_fill_price: b.price, average_fee_paid: '0.0100' }, { status: 201 });
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = new URL(String(input));
    expect(init.headers['KALSHI-ACCESS-KEY']).toBe('key-123');
    expect(url.host).toBe('demo-api.kalshi.co');
    if (url.pathname.endsWith('/portfolio/positions')) return Response.json({ market_positions: positions, cursor: '' });
    if (url.pathname.endsWith('/portfolio/balance')) return Response.json({ balance: balanceCents, portfolio_value: balanceCents });
    const mm = url.pathname.match(/\/markets\/([^/]+)$/);
    if (mm) {
      const ticker = decodeURIComponent(mm[1]!);
      const ask = marketAsk[ticker] ?? '0.7000';
      return Response.json({ market: { ticker, title: 't', status: marketStatus, yes_ask_dollars: ask, no_ask_dollars: (1 - parseFloat(ask) + 0.02).toFixed(4), yes_bid_dollars: (parseFloat(ask) - 0.02).toFixed(4), ...(askSize[ticker] ? { yes_ask_size_fp: askSize[ticker], yes_bid_size_fp: askSize[ticker] } : {}) } });
    }
    if (url.pathname.endsWith('/portfolio/events/orders') && init.method === 'POST') {
      const body = JSON.parse(init.body);
      orders.push(body);
      return orderResponse(body);
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(home, { recursive: true, force: true });
});

const inTwoHours = () => new Date(Date.now() + 2 * 3600_000).toISOString();
const proposal = (id: string, ticker: string, contracts = 10, ask = 0.7, side: 'yes' | 'no' = 'yes', kickoff = inTwoHours()): Proposal => ({
  match: { ok: true, prediction: { id, league: 'L', kickoff, home: 'A', away: 'B', bet: 'T+1.5', statedPct: 80 }, spec: { kind: 'total', line: 1.5, side }, event: { event_ticker: 'E', series_ticker: 'S', title: 'A vs B' }, market: { ticker, title: 't', status: 'active' }, side } as any,
  probability: 0.81, quote: { ask, bid: ask - 0.02, spreadCents: 2 }, cost: ask + 0.0147, edge: 0.09, kelly: 0.3, contracts, notional: contracts * ask,
});
// Older guard tests price from the model alone; market blending and exposure caps have their own tests.
const BASE = structuredClone(DEFAULT_CONFIG);
BASE.risk = { ...BASE.risk, autoSize: false, marketWeight: 0, maxGapToMarket: 0, maxOpenExposurePct: 1, maxOpenPerBetType: 99 };
const cfg = (over: Partial<AppConfig> = {}): AppConfig => ({ ...structuredClone(BASE), mode: 'auto', state: 'FL', ...over });
const quiet = { log: () => {}, confirm: async () => true };

describe('executor guards', () => {
  test('places an IOC order at the ask and records the fill with fees', async () => {
    const s = await execute(cfg(), creds, [proposal('p1', 'T1')], quiet);
    expect(s.filled).toBe(1);
    expect(orders[0]).toMatchObject({ ticker: 'T1', side: 'bid', price: '0.7000', count: '10.00', time_in_force: 'fill_or_kill', client_order_id: clientOrderIdFor('demo', 'p1', 'T1') });
    expect(spentToday('demo')).toBeCloseTo(7.1, 6);
  });

  test('refuses to trade without an allowed state', async () => {
    const s1 = await execute(cfg({ state: undefined }), creds, [proposal('p1', 'T1')], quiet);
    const s2 = await execute(cfg({ state: 'NJ' }), creds, [proposal('p1', 'T1')], quiet);
    expect(orders).toHaveLength(0);
    expect(s1.stoppedReason).toContain('No country set');
    expect(s2.stoppedReason).toContain('restricted');
  });

  test('approve mode only sends orders the user confirms', async () => {
    const asked: string[] = [];
    const s = await execute(cfg({ mode: 'approve' }), creds, [proposal('p1', 'T1'), proposal('p2', 'T2')], {
      log: () => {},
      confirm: async (p) => { asked.push(p.match.market.ticker); return p.match.market.ticker === 'T2'; },
    });
    expect(asked).toEqual(['T1', 'T2']);
    expect(orders.map((o) => o.ticker)).toEqual(['T2']);
    expect(s.filled).toBe(1);
  });

  test('kill switch blocks everything, including one turned on during the prompt', async () => {
    writeFileSync(killSwitchPath(), 'test');
    let s = await execute(cfg(), creds, [proposal('p1', 'T1')], quiet);
    expect(orders).toHaveLength(0);
    expect(s.stoppedReason).toContain('kill');
    rmSync(killSwitchPath());
    s = await execute(cfg({ mode: 'approve' }), creds, [proposal('p1', 'T1')], {
      log: () => {},
      confirm: async () => { writeFileSync(killSwitchPath(), 'during prompt'); return true; },
    });
    expect(orders).toHaveLength(0);
  });

  test('a late "yes" after kickoff approaches does not trade', async () => {
    const s = await execute(cfg({ mode: 'approve' }), creds, [proposal('p1', 'T1', 10, 0.7, 'yes', new Date(Date.now() + 20 * 60_000).toISOString())], {
      log: () => {},
      confirm: async () => true,
      now: () => Date.now() + 10 * 60_000, // user answered 10 minutes later: 10 min to kickoff < 15
    });
    expect(orders).toHaveLength(0);
    expect(s.placed).toBe(0);
  });

  test('re-prices at order time: less cash means a smaller order; no edge means no order', async () => {
    balanceCents = 6_000; // $60: 10% position cap = $6 -> 8 contracts at ~$0.71
    await execute(cfg(), creds, [proposal('p1', 'T1', 10, 0.7)], quiet);
    expect(orders[0].count).toBe('8.00');
    balanceCents = 100_000;
    marketAsk = { T2: '0.7800' }; // auto mode: price rose, edge now 0.81 - 0.79 < required
    await execute(cfg(), creds, [proposal('p2', 'T2', 10, 0.7)], quiet);
    expect(orders).toHaveLength(1);
  });

  test('approved price is a hard ceiling', async () => {
    marketAsk = { T1: '0.7100' }; // still has edge, but above the 70c the user approved
    await execute(cfg({ mode: 'approve' }), creds, [proposal('p1', 'T1', 10, 0.7)], quiet);
    expect(orders).toHaveLength(0);
    marketAsk = { T1: '0.6800' }; // cheaper: buys, at the better price
    await execute(cfg({ mode: 'approve' }), creds, [proposal('p1', 'T1', 10, 0.7)], quiet);
    expect(orders[0]).toMatchObject({ price: '0.6800', count: '10.00' });
  });

  test('skips if the price moved up or the market closed before ordering', async () => {
    marketAsk = { T1: '0.7400' };
    await execute(cfg(), creds, [proposal('p1', 'T1')], quiet);
    expect(orders).toHaveLength(0);
    marketAsk = {};
    marketStatus = 'closed';
    await execute(cfg(), creds, [proposal('p2', 'T2')], quiet);
    expect(orders).toHaveLength(0);
  });

  test('daily spend cap trims and then stops', async () => {
    const c = cfg();
    c.risk.maxDailySpend = 10; // first fill costs $7.10 incl. fee, $2.90 left
    const s = await execute(c, creds, [proposal('p1', 'T1', 10, 0.7), proposal('p2', 'T2', 10, 0.7), proposal('p3', 'T3', 10, 0.7)], quiet);
    expect(orders[0].count).toBe('10.00');
    expect(orders[1].count).toBe('4.00'); // floor(2.90 / 0.7147)
    expect(orders).toHaveLength(2);
    expect(s.stoppedReason).toContain('daily spend cap');
  });

  test('auto-size spreads the budget: every qualifying pick gets a share instead of the first taking it all', async () => {
    const c = cfg();
    c.risk.autoSize = true;
    c.risk.maxDailySpend = 10;
    await execute(c, creds, [proposal('p1', 'T1', 10, 0.7), proposal('p2', 'T2', 10, 0.7), proposal('p3', 'T3', 10, 0.7)], quiet);
    expect(orders.map((o) => o.ticker)).toEqual(['T1', 'T2', 'T3']);
    expect(orders.map((o) => o.count)).toEqual(['4.00', '5.00', '5.00']); // $10 split 3 ways, then the rest split 2 ways
    // Everything fits at full size: no cutting.
    orders.length = 0;
    const c2 = cfg(); c2.risk.autoSize = true; c2.risk.maxDailySpend = 100;
    await execute(c2, creds, [proposal('q1', 'T4', 3, 0.7), proposal('q2', 'T5', 3, 0.7)], quiet);
    expect(orders.map((o) => o.count)).toEqual(['3.00', '3.00']);
  });

  test('only buys what is for sale at the price: a thin book never turns into a pennies bet', async () => {
    askSize = { T1: '0.02', T2: '4.50' };
    await execute(cfg(), creds, [proposal('s1', 'T1', 10, 0.7), proposal('s2', 'T2', 10, 0.7)], quiet);
    expect(orders.map((o) => [o.ticker, o.count])).toEqual([['T2', '4.00']]);
    expect(readLedger().some((e: any) => e.type === 'skip' && e.ticker === 'T1' && /for sale/.test(e.reason))).toBe(true);
  });

  test('an order cut by the limits below the minimum win is not sent', async () => {
    const c = cfg();
    c.risk.maxDailySpend = 1; // room for 1 contract at 70c, which would win only $0.28
    const s = await execute(c, creds, [proposal('m1', 'T1', 10, 0.7)], quiet);
    expect(orders).toHaveLength(0);
    expect(readLedger().some((e: any) => e.type === 'skip' && /would win only/.test(e.reason))).toBe(true);
    void s;
  });

  test('never doubles up: same prediction, a ticker already held, or two picks on one market', async () => {
    await execute(cfg(), creds, [proposal('p1', 'T1')], quiet);
    positions = [{ ticker: 'T9', position_fp: '5.00' }];
    await execute(cfg(), creds, [proposal('p1', 'T1'), proposal('p9', 'T9'), proposal('pA', 'T5'), proposal('pB', 'T5')], quiet);
    expect(orders.map((o) => o.ticker)).toEqual(['T1', 'T5']);
  });

  test('a market bought under an older prediction id is not bought again', async () => {
    await execute(cfg(), creds, [proposal('1234', 'T1')], quiet); // id format used by an older version
    await execute(cfg(), creds, [proposal('1234::T+1.5', 'T1')], quiet);
    expect(orders).toHaveLength(1);
  });

  test('Place anyway buys a pick the edge check skipped, but never overrides hard rules', async () => {
    marketAsk = { T1: '0.8500', T2: '0.8500' };
    const noEdge = { ...proposal('p1', 'T1', 3, 0.85), skip: 'edge -5.0% < 4.4% needed' };
    await execute(cfg({ mode: 'approve' }), creds, [noEdge], quiet);
    expect(orders).toHaveLength(0); // not without force
    await execute(cfg({ mode: 'approve' }), creds, [noEdge], { ...quiet, force: true });
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ ticker: 'T1', price: '0.8500', count: '3.00' });
    const { readLedger } = await import('../src/trade/ledger');
    expect(readLedger().some((e: any) => e.type === 'order' && e.forced === true)).toBe(true);
    // Hard rule: game already started.
    const started = { ...proposal('p2', 'T2', 3, 0.85, 'yes', new Date(Date.now() - 600_000).toISOString()), skip: 'match already started', hard: true };
    await execute(cfg({ mode: 'approve' }), creds, [started], { ...quiet, force: true });
    // Hard rule re-checked live even if the scan said it was fine.
    await execute(cfg({ mode: 'approve' }), creds, [{ ...proposal('p3', 'T2', 3, 0.85, 'yes', new Date(Date.now() - 600_000).toISOString()), skip: 'edge' }], { ...quiet, force: true });
    expect(orders).toHaveLength(1);
  });

  test('Claude pre-trade check sees the final order and can stop it', async () => {
    const seen: any[] = [];
    await execute(cfg(), creds, [proposal('p1', 'T1')], { ...quiet, precheck: async (p) => { seen.push(p); return { ok: false, reason: 'wrong team' }; } });
    expect(orders).toHaveLength(0);
    expect(seen[0]).toMatchObject({ contracts: 10, quote: { ask: 0.7 } });
    const { readLedger } = await import('../src/trade/ledger');
    expect(readLedger().some((e: any) => e.type === 'skip' && e.reason.includes('AI check: wrong team'))).toBe(true);
    await execute(cfg(), creds, [proposal('p2', 'T2')], { ...quiet, precheck: async () => ({ ok: true }) });
    expect(orders.map((o) => o.ticker)).toEqual(['T2']);
  });

  test('spread the risk: one bet per match, a couple per bet kind, open exposure capped', async () => {
    const c = cfg();
    c.risk = { ...c.risk, maxOpenPerBetType: 2, onePerMatch: true, maxOpenExposurePct: 1 };
    const tt = (game: string, team: string) => `KXEPLTEAMTOTAL-26OCT18${game}-${team}1`;
    // Kalshi shows what we hold after each fill.
    const buy = async (id: string, ticker: string, conf = c) => {
      await execute(conf, creds, [proposal(id, ticker, 3)], quiet);
      const last = orders[orders.length - 1];
      if (last?.ticker === ticker) positions.push({ ticker, position_fp: '3.00' });
    };
    await buy('a', tt('ARSCHE', 'ARS'));
    await buy('b', `KXEPLTOTAL-26OCT18ARSCHE-2`); // same match
    await buy('c', tt('LIVMCI', 'LIV'));
    await buy('d', tt('TOTWHU', 'TOT')); // third team-goals bet
    expect(orders.map((o) => o.ticker)).toEqual([tt('ARSCHE', 'ARS'), tt('LIVMCI', 'LIV')]);
    const { readLedger } = await import('../src/trade/ledger');
    const reasons = readLedger().filter((e: any) => e.type === 'skip').map((e: any) => e.reason);
    expect(reasons).toContain('already have a bet on this match');
    expect(reasons.some((r: string) => r.startsWith('already 2 open bets of this kind'))).toBe(true);
    expect(readLedger().find((e: any) => e.type === 'order')).toMatchObject({ match: 'A v B', bet: 'T+1.5' });
    // Exposure: $1,000 cash; 2 bets x 3 @ ~0.71 open; cap 0.3% of bankroll leaves no room.
    const tight = cfg();
    tight.risk = { ...tight.risk, maxOpenPerBetType: 99, maxOpenExposurePct: 0.003 };
    await buy('e', 'KXEPLGAME-26OCT18NEWBOU-NEW', tight);
    expect(orders).toHaveLength(2);
    expect(readLedger().some((e: any) => e.type === 'skip' && /open bets already \$/.test(e.reason))).toBe(true);
  });

  test('stops on a Kalshi access refusal (e.g. geolocation)', async () => {
    orderResponse = () => new Response('{"error":"trading restricted in your location"}', { status: 403 });
    const s = await execute(cfg(), creds, [proposal('p1', 'T1'), proposal('p2', 'T2')], quiet);
    expect(orders).toHaveLength(1);
    expect(s.stoppedReason).toContain('Kalshi refused');
  });

  test('no reply from Kalshi: counted as possibly filled, never re-sent, run stops', async () => {
    orderResponse = () => { throw new Error('The operation timed out.'); };
    const s = await execute(cfg(), creds, [proposal('p1', 'T1'), proposal('p2', 'T2')], quiet);
    expect(orders).toHaveLength(1); // POST is never retried
    expect(s.stoppedReason).toContain('may have filled');
    expect(tradedPredictionIds('demo').has('p1')).toBe(true);
    expect(spentToday('demo')).toBeCloseTo(7.2, 6);
    orderResponse = (b) => Response.json({ order_id: 'x', fill_count: b.count, remaining_count: '0.00', average_fill_price: b.price }, { status: 201 });
    await execute(cfg(), creds, [proposal('p1', 'T1')], quiet);
    expect(orders).toHaveLength(1); // next run does not re-order p1
  });

  test('one run at a time: another live process blocks, a dead one does not, in-app runs queue', async () => {
    const lock = join(home, 'run.lock');
    writeFileSync(lock, `${process.ppid} ${new Date().toISOString()}\n`); // a live process (e.g. a CLI run)
    await expect(execute(cfg(), creds, [proposal('p1', 'T1')], quiet)).rejects.toThrow('Another trading run');
    writeFileSync(lock, '999999 2026-01-01\n'); // left behind by a crashed app
    await execute(cfg(), creds, [proposal('p1', 'T1')], quiet);
    expect(orders).toHaveLength(1);
    // Pre-game and live runs started together both go through, one after the other.
    await Promise.all([
      execute(cfg(), creds, [proposal('p2', 'T2')], quiet),
      execute(cfg(), creds, [proposal('p3', 'T3')], { ...quiet, live: { deadlineMs: Date.now() + 30_000 } }),
    ]);
    expect(orders.map((o) => o.ticker).sort()).toEqual(['T1', 'T2', 'T3']);
    expect(existsSync(lock)).toBe(false);
  });

  test('an order that did not fill can be tried again later with a new order id', async () => {
    orderResponse = (b) => Response.json({ order_id: 'x', fill_count: '0.00', remaining_count: '0.00' }, { status: 201 });
    await execute(cfg(), creds, [proposal('p1', 'T1')], quiet);
    orderResponse = (b) => Response.json({ order_id: 'y', fill_count: b.count, remaining_count: '0.00', average_fill_price: b.price, average_fee_paid: '0.0100' }, { status: 201 });
    await execute(cfg(), creds, [proposal('p1', 'T1')], quiet);
    expect(orders).toHaveLength(2);
    expect(orders[0].client_order_id).not.toBe(orders[1].client_order_id);
  });

  test('a 5xx on an order counts as possibly filled (never re-sent, counted as spent)', async () => {
    orderResponse = () => new Response('bad gateway', { status: 502 });
    const r = await execute(cfg(), creds, [proposal('p1', 'T1')], quiet);
    expect(r.stoppedReason).toContain('may have filled');
    await execute(cfg(), creds, [proposal('p1', 'T1')], quiet);
    expect(orders).toHaveLength(1);
  });

  test('positions bought outside the app do not use up its open-position slots', async () => {
    positions = Array.from({ length: 12 }, (_, i) => ({ ticker: `OTHER${i}`, position_fp: '1.00' }));
    await execute(cfg(), creds, [proposal('p1', 'T1')], quiet);
    expect(orders).toHaveLength(1);
  });

  test('a NO purchase is sent as an ask on the YES book', async () => {
    marketAsk = { T2: '0.7200' }; // fake NO ask = 1 - 0.72 + 0.02 = 0.30
    await execute(cfg(), creds, [proposal('p1', 'T2', 5, 0.30, 'no')], quiet);
    expect(orders[0]).toMatchObject({ side: 'ask', price: '0.7000' });
  });
});

test('winnings paid back today free up the daily limit; losses still count', async () => {
  const { setDailyCredit, spentToday, grossSpentToday } = await import('../src/trade/ledger');
  const at = new Date().toISOString();
  const entries: any[] = [
    { type: 'order', at, env: 'prod', predictionId: 'a', ticker: 'A', side: 'yes', count: 10, limitPrice: 0.5, filled: 10, avgPrice: 0.5, avgFee: 0.02 },
    { type: 'order', at, env: 'prod', predictionId: 'b', ticker: 'B', side: 'yes', count: 10, limitPrice: 0.5, filled: 10, avgPrice: 0.5, avgFee: 0.02 },
  ];
  expect(grossSpentToday('prod', entries)).toBe(10.4);
  setDailyCredit(() => 0);
  expect(spentToday('prod', entries)).toBe(10.4);
  setDailyCredit(() => 10); // A won and paid $10
  expect(spentToday('prod', entries)).toBe(0.4);
  setDailyCredit(() => 30);
  expect(spentToday('prod', entries)).toBe(0);
  setDailyCredit(null);
});

test('trade journal: every fill is recorded with settings, pick, Kalshi data and numbers; outcomes are appended', async () => {
  const { readJournal, journalRows, journalOutcome, journalCsv } = await import('../src/trade/journal');
  const c = cfg();
  c.risk.minEdge = 0.042;
  await execute(c, creds, [proposal('j1', 'T1', 3, 0.7)], quiet);
  const e: any = readJournal().find((l: any) => l.type === 'entry');
  expect(e).toMatchObject({ mode: 'auto', predygo: { id: 'j1' }, kalshi: { ticker: 'T1', sideBought: 'yes', yesAsk: 0.7 }, order: { filled: 3, limitPrice: 0.7 } });
  expect(e.settings.risk.minEdge).toBe(0.042);
  expect(e.model.winChance).toBeGreaterThan(0);
  journalOutcome({ key: e.key, kind: 'settled', result: 'won', payout: 3, pnl: 0.85 });
  journalOutcome({ key: e.key, kind: 'predygo', result: 'won' });
  const row = journalRows()[0]!;
  expect(row.settled!.result).toBe('won');
  expect(row.predygo!.result).toBe('won');
  const csv = journalCsv().trim().split('\n');
  expect(csv).toHaveLength(2);
  expect(csv[1]).toContain('T1');
  expect(csv[1]).toContain('0.042');
});

test('trades from before the journal are rebuilt from the logs, once', async () => {
  const { backfillJournal, journalRows } = await import('../src/trade/journal');
  const ledger = [{ type: 'order', at: '2026-10-15T05:50:00Z', env: 'prod', predictionId: 'p9', ticker: 'KXUELTEAMTOTAL-26OCT15OLMOLY-OLY1', side: 'yes', count: 10, limitPrice: 0.57, filled: 10, avgPrice: 0.57, avgFee: 0.02, probability: 0.793, edge: 0.15, clientOrderId: 'c9' }];
  const picks = [{ at: '2026-10-15T05:47:00Z', ticker: 'KXUELTEAMTOTAL-26OCT15OLMOLY-OLY1', match: 'Atalanta v Pafos FC', bet: 'VISITA MARCA', league: 'UEFA Europa League', statedPct: 78, posted: false, ask: 0.57, bid: 0.55, probability: 0.793, required: 0.074 }];
  expect(backfillJournal(ledger, picks, [])).toBe(1);
  expect(backfillJournal(ledger, picks, [])).toBe(0);
  const e: any = journalRows()[0]!.entry;
  expect(e).toMatchObject({ reconstructed: true, predygo: { home: 'Atalanta', away: 'Pafos FC', bet: 'VISITA MARCA', statedPct: 78 }, order: { filled: 10 }, settings: null });
});
