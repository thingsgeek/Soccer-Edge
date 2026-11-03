import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'se-live-'));
process.env.SOCCER_EDGE_HOME = home;

const { LiveEngine, goalsNeeded, liveProbability } = await import('../src/live');
const { CLASSIC_CONFIG: DEFAULT_CONFIG } = await import('./classic');
const { clearMarketCache } = await import('../src/kalshi/markets');
const { normalizeRows } = await import('../src/predictions/sources');
const { execute } = await import('../src/trade/executor');
const { readLedger } = await import('../src/trade/ledger');
const { setLiveHistory } = await import('../src/predictions/calibration');

// A made-up graded live record (not real PredyGo results): 82/100 won up to 70 min, 69/100
// at 70-90 min, 27/50 after 90 min. Live win chances come from this, as from a results feed.
function syntheticLiveRecord() {
  const ko = Date.parse('2026-01-10T18:00:00Z');
  const rows: any[] = [];
  const add = (n: number, w: number, minAfter: number) => { for (let i = 0; i < n; i++) rows.push({ id: `s${rows.length}`, league: 'L', home: 'h', away: 'a', bet: 'SYN', statedPct: 80, kickoff: new Date(ko).toISOString(), won: i < w, source: 'live', pickedAt: new Date(ko + minAfter * 60_000).toISOString() }); };
  add(100, 82, 30); add(100, 69, 80); add(50, 27, 92);
  return rows;
}
setLiveHistory(syntheticLiveRecord());

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const creds = { env: 'prod' as const, apiKeyId: 'k', privateKeyPem: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString() };

// A game that kicked off 40 minutes ago.
const kickoff = new Date(Date.now() - 40 * 60_000);
kickoff.setUTCSeconds(0, 0);
const nyWall = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(kickoff);
const mon = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][kickoff.getUTCMonth()];
const evTicker = `KXMLSTOTAL-${String(kickoff.getUTCFullYear()).slice(2)}${mon}${String(kickoff.getUTCDate()).padStart(2, '0')}CINCLB`;
const iso = (ms: number) => new Date(ms).toISOString();
const market = {
  ticker: `${evTicker}-2`, event_ticker: evTicker, title: 'Over 1.5', yes_sub_title: 'Over 1.5 goals scored',
  floor_strike: 1.5, strike_type: 'greater', status: 'active',
  yes_ask_dollars: '0.7000', yes_bid_dollars: '0.6900', no_ask_dollars: '0.3100',
  occurrence_datetime: iso(kickoff.getTime() + 3 * 3600_000), close_time: iso(kickoff.getTime() + 48 * 3600_000),
};

let livePicks: any[] = [];
const sentOrders: any[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = new URL(String(input));
  if (url.hostname === 'predygo.com') return Response.json({ predictions: url.searchParams.get('all') ? [] : livePicks });
  if (url.pathname.endsWith('/series')) return Response.json({ series: [{ ticker: 'KXMLSTOTAL', title: 'MLS Total', tags: ['Soccer'] }] });
  if (url.pathname.endsWith('/events')) {
    const st = url.searchParams.get('series_ticker');
    return Response.json({ cursor: '', events: st === 'KXMLSTOTAL' ? [{ event_ticker: evTicker, series_ticker: st, title: 'Cincinnati vs Columbus: Total Goals', markets: [market] }] : [] });
  }
  if (url.pathname.includes('/markets/')) return Response.json({ market });
  if (url.pathname.endsWith('/portfolio/positions')) return Response.json({ market_positions: [], cursor: '' });
  if (url.pathname.endsWith('/portfolio/balance')) return Response.json({ balance: 5000, portfolio_value: 0 });
  if (url.pathname.endsWith('/portfolio/events/orders')) {
    const b = JSON.parse(init.body);
    sentOrders.push(b);
    return Response.json({ order_id: 'o', fill_count: b.count, remaining_count: '0.00', average_fill_price: b.price, average_fee_paid: '0.0150' }, { status: 201 });
  }
  return new Response('not mocked ' + url, { status: 599 });
}) as typeof fetch;
afterAll(() => { globalThis.fetch = realFetch; rmSync(home, { recursive: true, force: true }); });

const pick = (id: number, bet: string, score: string, extra: object = {}) => ({
  id, key: `${id}::${bet}`, league: 'USA MLS', home: 'FC Cincinnati', away: 'Columbus Crew',
  market: { code: bet }, kickoff: nyWall, source: 'live', result: 'pending', score, ...extra,
});

function ctx(mode: 'watch' | 'trade', calls: any[] = []) {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.source = { type: 'predygo', url: 'https://predygo.com/api/v1', token: 't' };
  cfg.live.mode = mode;
  cfg.risk = { ...cfg.risk, stakeMode: 'flat', maxNotionalPerOrder: 5, maxPositionPct: 0.1, minEdge: 0.03, marketWeight: 0, maxOpenExposurePct: 1 };
  return {
    cfg, creds, bankroll: 50, dailyRemaining: 25,
    alreadyIn: () => null, tradingBlocked: () => null,
    execute: async (p: any, deadlineMs: number) => { calls.push({ p, deadlineMs }); return { placed: 1, filled: p.contracts }; },
    log: () => {},
    priceHistory: async () => history,
  };
}
// Kalshi price history the no-score check reads (steady by default).
let history: { t: number; v: number }[] = [];
const steady = (v: number) => Array.from({ length: 10 }, (_, i) => ({ t: Date.now() - (10 - i) * 60_000, v }));

beforeEach(() => { clearMarketCache(); market.yes_ask_dollars = '0.7000'; market.yes_bid_dollars = '0.6900'; history = steady(0.69); });

test('late live picks (55% stage of the game) are never bought', async () => {
  const calls: any[] = [];
  const eng = new LiveEngine();
  livePicks = [];
  await eng.poll(ctx('trade', calls));
  const late = new Date(Date.now() - 108 * 60_000);
  const lateWall = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(late);
  market.yes_ask_dollars = '0.4200'; market.yes_bid_dollars = '0.4100';
  livePicks = [{ ...pick(20, 'T+1.5', '1-0', { odds: 2.0 }), kickoff: lateWall }];
  await eng.poll(ctx('trade', calls));
  expect(calls).toHaveLength(0);
  expect(eng.observations[0]!.reason).toMatch(/^minute 9[34]: no buys from the 80th minute on$/);
});

describe('live picks', () => {
  test('hit rate by stage of the game, and goals still needed', () => {
    expect(liveProbability(40).probability).toBeCloseTo(83 / 102, 5);
    expect(liveProbability(80).probability).toBeCloseTo(70 / 102, 5);
    expect(liveProbability(95).probability).toBeCloseTo(28 / 52, 5);
    // No graded live record at all: PredyGo's stated confidence, else 50% with no confidence.
    setLiveHistory([]);
    expect(liveProbability(40, 'T+1.5', 84)).toMatchObject({ probability: 0.84, graded: 0 });
    expect(liveProbability(40)).toMatchObject({ probability: 0.5, stdErr: 1 });
    setLiveHistory(syntheticLiveRecord());
    expect(goalsNeeded(1.5, [1, 0])).toBe(1);
    expect(goalsNeeded(1.5, [0, 0])).toBe(2);
    expect(goalsNeeded(1.5, [2, 0])).toBe(0);
    expect(goalsNeeded(1.5, undefined)).toBeNull();
  });

  test('reads score, minute, pick time and odds from the feed', () => {
    const [p] = normalizeRows([{ ...pick(1, 'T+1.5', '1-0'), minute: 34, registered: nyWall, odds: 1.4 }]);
    expect(p).toMatchObject({ score: [1, 0], minute: 34, odds: 1.4, source: 'live' });
    expect(p!.pickedAt).toBe(kickoff.toISOString());
    const [q] = normalizeRows([{ ...pick(2, 'T+1.5', ''), livehg: 0, liveaw: 1 }]);
    expect(q!.score).toEqual([0, 1]);
  });

  test('PredyGo odds mode: picks open when the app starts are never traded; new ones are, within seconds', async () => {
    const calls: any[] = [];
    const eng = new LiveEngine();
    const legacy = () => { const c = ctx('trade', calls); c.cfg.risk.useKalshiOdds = false; return c; };
    livePicks = [pick(1, 'T+1.5', '1-0')];
    await eng.poll(legacy());
    expect(eng.observations[0]).toMatchObject({ action: 'old' });
    expect(calls).toHaveLength(0);

    livePicks = [pick(1, 'T+1.5', '1-0'), pick(2, 'T+1.5', '0-1')];
    await eng.poll(legacy());
    expect(calls).toHaveLength(1);
    expect(calls[0].p.match.market.ticker).toBe(market.ticker);
    expect(calls[0].p.contracts).toBe(6); // flat $5 at 70¢: 7 would be $5.01 with the fee
    expect(calls[0].deadlineMs - Date.now()).toBeGreaterThan(30_000);
    expect(eng.observations[0]).toMatchObject({ action: 'traded', score: '0-1', ask: 0.7 });
    // Seen once only.
    await eng.poll(legacy());
    expect(calls).toHaveLength(1);
  });

  test('Kalshi odds (default): a pick already in play at start is judged on Kalshi\'s price now; price skips are re-checked', async () => {
    const calls: any[] = [];
    const eng = new LiveEngine();
    livePicks = [pick(30, 'T+1.5', '1-0', { odds: 3.0 })]; // PredyGo odds (33%) would have blocked this
    await eng.poll(ctx('trade', calls));
    expect(calls).toHaveLength(1);
    expect(eng.observations[0]!.action).toBe('traded');
    expect(eng.observations[0]!.reason).toContain("checked on Kalshi's current price");
    expect(calls[0].p.liveInfo.checkedBy).toContain('Kalshi live price');

    // Too pricey now: skipped, then bought a minute later once the price comes back.
    market.yes_ask_dollars = '0.9500'; market.yes_bid_dollars = '0.9400'; history = steady(0.94);
    livePicks = [pick(30, 'T+1.5', '1-0'), pick(31, 'T+1.5', '0-1')];
    await eng.poll(ctx('trade', calls));
    expect(eng.observations[0]).toMatchObject({ id: '31::T+1.5', action: 'skip' });
    const skipsLogged = eng.observations.length;
    await eng.poll(ctx('trade', calls)); // within the minute: not re-checked
    expect(eng.observations.length).toBe(skipsLogged);
    market.yes_ask_dollars = '0.7000'; market.yes_bid_dollars = '0.6900'; history = steady(0.69);
    const later = ctx('trade', calls);
    (later as any).now = () => Date.now() + 61_000;
    await eng.poll(later);
    expect(calls).toHaveLength(2);
    expect(eng.observations[0]).toMatchObject({ id: '31::T+1.5', action: 'traded' });
  });

  test('watch mode records what it would buy without ordering', async () => {
    const calls: any[] = [];
    const eng = new LiveEngine();
    livePicks = [];
    await eng.poll(ctx('watch', calls));
    livePicks = [pick(3, 'T+1.5', '1-0')];
    await eng.poll(ctx('watch', calls));
    expect(calls).toHaveLength(0);
    expect(eng.observations[0]).toMatchObject({ action: 'watch' });
    expect(readFileSync(join(home, 'live.jsonl'), 'utf8')).toContain('"action":"watch"');
  });

  test('skips: score already enough, needs two goals, goal just scored, price too high', async () => {
    const calls: any[] = [];
    const eng = new LiveEngine();
    livePicks = [];
    await eng.poll(ctx('trade', calls));
    livePicks = [pick(4, 'T+1.5', '2-0'), pick(5, 'T+1.5', '0-0')];
    await eng.poll(ctx('trade', calls));
    expect(eng.observations.map((o) => o.reason).sort()).toEqual(['already won on the score shown', 'needs 2 more goals (live record covers one-goal picks)']);

    market.yes_ask_dollars = '0.9500'; market.yes_bid_dollars = '0.9400';
    livePicks = [pick(6, 'T+1.5', '1-0', { odds: 1.6 })];
    await eng.poll(ctx('trade', calls));
    expect(eng.observations[0]!.reason).toMatch(/goal probably (just )?scored/); // Kalshi's price jumped

    // No score: checked against the pick's odds, or (no odds either) Kalshi's own recent prices.
    market.yes_ask_dollars = '0.7000'; market.yes_bid_dollars = '0.6900';
    livePicks = [pick(8, 'T+1.5', ''), pick(10, 'T+1.5', '', { odds: 1.42 })];
    await eng.poll(ctx('trade', calls));
    expect(eng.observations.find((o) => o.id === '8::T+1.5')!.action).toBe('traded'); // steady price: fine
    expect(eng.observations.find((o) => o.id === '10::T+1.5')!.action).toBe('traded');
    // Price jumped 45c -> 69c in the last few minutes: a goal just went in, the pick is stale.
    history = [...steady(0.45).slice(0, 7), { t: Date.now() - 60_000, v: 0.69 }];
    livePicks = [pick(11, 'T+1.5', '')];
    await eng.poll(ctx('trade', calls));
    expect(eng.observations[0]!.reason).toMatch(/jumped 45¢ → 69¢.*goal probably just scored/);
    // Far below the one-goal rate (82%): probably needs two goals.
    market.yes_ask_dollars = '0.5000'; market.yes_bid_dollars = '0.4900'; history = steady(0.49);
    livePicks = [pick(12, 'T+1.5', '')];
    await eng.poll(ctx('trade', calls));
    expect(eng.observations[0]!.reason).toMatch(/far below the 8\d% one-goal rate/);
    // No history at all: not traded blind.
    market.yes_ask_dollars = '0.7000'; market.yes_bid_dollars = '0.6900'; history = [];
    livePicks = [pick(13, 'T+1.5', '')];
    await eng.poll(ctx('trade', calls));
    expect(eng.observations[0]!.reason).toContain('no recent Kalshi price history');
    calls.length = 0;
    market.yes_ask_dollars = '0.9500'; market.yes_bid_dollars = '0.9400'; history = steady(0.94);

    livePicks = [pick(7, 'T+1.5', '1-0')];
    await eng.poll(ctx('trade', calls));
    expect(eng.observations[0]!.reason).toMatch(/edge|max/);
    expect(calls).toHaveLength(0);
  });
});

test('end to end: a new live pick goes through the real order path during the game', async () => {
  const eng = new LiveEngine();
  const c = ctx('trade');
  c.cfg.country = 'US'; c.cfg.state = 'FL';
  c.execute = (p: any, deadlineMs: number) => execute({ ...c.cfg, mode: 'auto' }, creds, [p], { log: () => {}, confirm: async () => true, live: { deadlineMs }, regionChecked: true });
  livePicks = [];
  await eng.poll(c);
  livePicks = [pick(9, 'T+1.5', '1-0')];
  await eng.poll(c);
  expect(sentOrders).toHaveLength(1);
  expect(sentOrders[0]).toMatchObject({ ticker: market.ticker, side: 'bid', price: '0.7000', count: '6.00', time_in_force: 'fill_or_kill' });
  expect(eng.observations[0]).toMatchObject({ action: 'traded', reason: 'bought 6 contracts' });
  expect(readLedger().filter((e: any) => e.type === 'order')).toHaveLength(1);
});


test('a live pick Kalshi already settled: "already decided", before the pick, never re-checked; one row per pick', async () => {
  const calls: any[] = [];
  const eng = new LiveEngine();
  livePicks = [];
  await eng.poll(ctx('trade', calls));
  const saved = { status: market.status, result: (market as any).result, close: (market as any).close_time };
  Object.assign(market, { status: 'finalized', result: 'yes', close_time: new Date(Date.now() - 90_000).toISOString() });
  try {
    livePicks = [pick(40, 'T+1.5', '1-1')];
    await eng.poll(ctx('trade', calls));
    const o = eng.observations[0]!;
    expect(o.reason).toMatch(/^already decided on Kalshi: YES at .+, before this pick arrived$/);
    expect(o.decidedBeforePick).toBe(true);
    expect(calls).toHaveLength(0);
    const later = ctx('trade', calls); (later as any).now = () => Date.now() + 61_000;
    await eng.poll(later); // final: no re-check
    expect(eng.observations.filter((x) => x.id === '40::T+1.5')).toHaveLength(1);
  } finally { Object.assign(market, saved); }
});

test('a re-check that finds the bet settled after the pick arrived is not blamed on PredyGo', async () => {
  const calls: any[] = [];
  const eng = new LiveEngine();
  livePicks = [];
  await eng.poll(ctx('trade', calls));
  market.yes_ask_dollars = '0.9500'; market.yes_bid_dollars = '0.9400'; history = steady(0.94); // too pricey: re-check later
  livePicks = [pick(41, 'T+1.5', '1-0')];
  await eng.poll(ctx('trade', calls));
  expect(eng.observations[0]).toMatchObject({ id: '41::T+1.5', action: 'skip' });
  const saved = { status: market.status, result: (market as any).result, close: (market as any).close_time };
  Object.assign(market, { status: 'finalized', result: 'yes', close_time: new Date(Date.now() + 5 * 60_000).toISOString() });
  try {
    clearMarketCache();
    const later = ctx('trade', calls); (later as any).now = () => Date.now() + 6 * 60_000;
    await eng.poll(later);
    const o = eng.observations[0]!;
    expect(o.reason).toMatch(/^already decided on Kalshi: YES at /);
    expect(o.reason).not.toContain('before this pick arrived');
    expect(o.decidedBeforePick).toBeUndefined();
  } finally { Object.assign(market, saved); }
});

test('live win rates: each bet type uses its own graded live record by stage once 30+ are graded; pre-game rates ignore live results', async () => {
  const { setLiveHistory, calibrationFromHistory } = await import('../src/predictions/calibration');
  const ko = Date.parse('2026-10-10T18:00:00Z');
  const mk = (i: number, bet: string, minAfter: number, won: boolean, source = 'live'): any => ({ id: `${i}`, league: 'L', home: 'h', away: 'a', bet, statedPct: 85, kickoff: new Date(ko).toISOString(), won, source, pickedAt: new Date(ko + minAfter * 60_000).toISOString() });
  const hist: any[] = [];
  for (let i = 0; i < 40; i++) hist.push(mk(i, 'T+0.5', 80, i < 20));           // late over 0.5: 50%
  for (let i = 0; i < 10; i++) hist.push(mk(100 + i, 'T+1.5', 30, true));      // too few: all live picks at this stage
  for (let i = 0; i < 40; i++) hist.push(mk(200 + i, 'T+1.5', 0, i < 30, 'pregame'));
  setLiveHistory(hist);
  const late = liveProbability(80, 'T+0.5');
  expect(late.probability).toBeCloseTo(21 / 42, 5);
  expect(late.graded).toBe(40);
  setLiveHistory([...hist, ...syntheticLiveRecord()]);
  expect(liveProbability(30, 'T+1.5').probability).toBeCloseTo(93 / 112, 5); // too few of its own: all live picks up to 70 min (82+10 of 110)
  const pre = calibrationFromHistory(hist);
  expect(pre.get('T+1.5')).toMatchObject({ graded: 40, wins: 30 });                 // live rows left out
  expect(pre.get('T+0.5')).toBeUndefined();
  setLiveHistory(syntheticLiveRecord());
});
