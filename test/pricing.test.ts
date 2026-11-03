import { describe, expect, test } from 'bun:test';
import { effectiveKickoff, evaluate, feePerContract, orderFee, quoteFor, requiredEdge } from '../src/trade/edge';
import { CLASSIC_CONFIG as DEFAULT_CONFIG } from './classic';
import { calibrationFromHistory, probabilityFor, MIN_GRADED } from '../src/predictions/calibration';
import { wallTimeToUtc } from '../src/predictions/time';
const RISK0 = { ...DEFAULT_CONFIG.risk, marketWeight: 0 };
import { checkState } from '../src/trade/eligibility';
import { toV2Body } from '../src/kalshi/account';
import type { KalshiMarket } from '../src/kalshi/types';
import type { Prediction } from '../src/predictions/types';

const market = (yesAsk: string, noAsk: string, yesBid: string): KalshiMarket => ({
  ticker: 'KXTEST-1', title: 't', status: 'active', yes_ask_dollars: yesAsk, no_ask_dollars: noAsk, yes_bid_dollars: yesBid,
});
const match = (m: KalshiMarket, side: 'yes' | 'no' = 'yes') =>
  ({ ok: true, prediction: { id: 'p', league: 'L', kickoff: '', home: 'A', away: 'B', bet: 'T+1.5', statedPct: 80 }, spec: { kind: 'total', line: 1.5, side: 'yes' }, event: { event_ticker: 'E', series_ticker: 'S', title: 'A vs B' }, market: m, side }) as any;
const ctx = { bankroll: 1000, dailyRemaining: 100, minutesToKickoff: 120 };

describe('fees and quotes', () => {
  test('Kalshi fee formula', () => {
    expect(feePerContract(0.5)).toBeCloseTo(0.0175, 6);
    expect(feePerContract(0.9)).toBeCloseTo(0.0063, 6);
  });
  test('NO side quote uses no_ask and the complement of yes_ask', () => {
    const q = quoteFor(market('0.62', '0.40', '0.60'), 'no')!;
    expect(q.ask).toBe(0.4);
    expect(q.bid).toBeCloseTo(0.38, 9);
    expect(q.spreadCents).toBe(2);
  });
});

describe('evaluate', () => {
  test('no trade when price already reflects the probability', () => {
    const p = evaluate(match(market('0.85', '0.17', '0.83')), 0.81, RISK0, ctx)!;
    expect(p.edge).toBeLessThan(0);
    expect(p.contracts).toBe(0);
    expect(p.skip).toContain('edge');
  });
  test('sizes a real edge with quarter Kelly and the per-order cap', () => {
    const p = evaluate(match(market('0.70', '0.32', '0.68')), 0.81, RISK0, ctx)!;
    // quarter Kelly of $1000 would be ~$76; capped by 5% ($50) and $25 per order, fee included.
    expect(p.contracts * 0.7 + orderFee(p.contracts, 0.7)).toBeLessThanOrEqual(25);
    expect((p.contracts + 1) * 0.7 + orderFee(p.contracts + 1, 0.7)).toBeGreaterThan(25);
    expect(p.edge).toBeCloseTo(0.81 - (0.7 + orderFee(p.contracts, 0.7) / p.contracts), 9);
    expect(p.skip).toBeUndefined();
  });
  test('fee is rounded up per order, as Kalshi charges it', () => {
    expect(orderFee(1, 0.5)).toBe(0.02);
    expect(orderFee(100, 0.5)).toBe(1.75);
  });
  test('requires stated confidence to clear the price too', () => {
    const p = evaluate(match(market('0.70', '0.32', '0.68')), 0.81, { ...RISK0, minProbability: 0.6 }, { ...ctx, statedProbability: 0.65 })!;
    expect(p.skip).toContain('stated');
  });
  test('skips when the feed kickoff disagrees with Kalshi', () => {
    const p = evaluate(match(market('0.70', '0.32', '0.68')), 0.81, RISK0, { ...ctx, kickoffMismatch: true })!;
    expect(p.skip).toContain('kickoff');
  });
  test('respects the daily remaining budget', () => {
    const p = evaluate(match(market('0.70', '0.32', '0.68')), 0.81, RISK0, { ...ctx, dailyRemaining: 3 })!;
    expect(p.contracts * p.cost).toBeLessThanOrEqual(3);
  });
  test('skips near kickoff and on wide spreads', () => {
    expect(evaluate(match(market('0.70', '0.32', '0.68')), 0.81, RISK0, { ...ctx, minutesToKickoff: 5 })!.skip).toContain('kickoff');
    expect(evaluate(match(market('0.70', '0.45', '0.50')), 0.81, RISK0, ctx)!.skip).toContain('spread');
  });
  test('no ask means no proposal', () => {
    expect(evaluate(match(market('', '', '')), 0.9, RISK0, ctx)).toBeNull();
  });
});

describe('calibration', () => {
  const graded = (bet: string, won: boolean, pct = 77): Prediction => ({ id: Math.random().toString(), league: 'L', kickoff: '', home: 'a', away: 'b', bet, statedPct: pct, won });
  test('uses hit rate, not stated pct', () => {
    const hist = [...Array(52).fill(0).map(() => graded('TOTALGOALS+2.5', true)), ...Array(48).fill(0).map(() => graded('TOTALGOALS+2.5', false))];
    const table = calibrationFromHistory(hist);
    const r = probabilityFor(graded('TOTALGOALS+2.5', false), 'hit-rate', table);
    expect(r.probability).toBeCloseTo(53 / 102, 9);
  });
  test('refuses to price bet types with too little history', () => {
    const table = calibrationFromHistory(Array(MIN_GRADED - 1).fill(0).map(() => graded('BTTS', true)));
    expect(probabilityFor(graded('BTTS', true), 'hit-rate', table).probability).toBeNull();
  });
});

describe('kickoff cross-check', () => {
  const m = (occ: string, close?: string) => ({ ticker: 't', title: 't', status: 'active', occurrence_datetime: occ, close_time: close }) as KalshiMarket;
  // Real schedules from Oct 14, 2026.
  test('EFL (settles +3h) and Argentina (settles +4h) both agree with PredyGo times', () => {
    const efl = effectiveKickoff('2026-10-14T18:45:00.000Z', m('2026-10-14T21:45:00Z', '2026-10-16T18:45:00Z'));
    const arg = effectiveKickoff('2026-10-14T22:00:00.000Z', m('2026-10-15T02:00:00Z', '2026-10-16T22:00:00Z'));
    expect(efl).toEqual({ kickoffMs: Date.parse('2026-10-14T18:45:00Z'), mismatch: false });
    expect(arg).toEqual({ kickoffMs: Date.parse('2026-10-14T22:00:00Z'), mismatch: false });
  });
  test('flags a feed time off by an hour and uses the earlier time', () => {
    const r = effectiveKickoff('2026-10-14T19:45:00.000Z', m('2026-10-14T21:45:00Z', '2026-10-16T18:45:00Z'));
    expect(r.mismatch).toBe(true);
    expect(new Date(r.kickoffMs).toISOString()).toBe('2026-10-14T18:45:00.000Z');
  });
  test('without a usable close time, assumes the earliest plausible kickoff', () => {
    // Settles 3.5h after the feed time: not a standard offset, so assume the earliest kickoff.
    const r = effectiveKickoff('2026-10-14T22:30:00.000Z', m('2026-10-15T02:00:00Z'));
    expect(r.mismatch).toBe(false);
    expect(new Date(r.kickoffMs).toISOString()).toBe('2026-10-14T21:45:00.000Z');
    // MLS (Oct 14 2026, San Diego v Houston): 10:30 PM ET kickoff, settles +3h, closes +54h.
    // The feed time is trusted, so trading stays open until 15 min before the real kickoff.
    const mls = effectiveKickoff('2026-10-15T02:30:00.000Z', m('2026-10-15T05:30:00Z', '2026-10-17T08:30:00Z'));
    expect(mls).toEqual({ kickoffMs: Date.parse('2026-10-15T02:30:00Z'), mismatch: false });
    expect(effectiveKickoff('2026-10-14T16:00:00.000Z', m('2026-10-15T02:00:00Z')).mismatch).toBe(true);
  });
});

describe('time zones', () => {
  test('PredyGo wall time (New York) to UTC', () => {
    expect(wallTimeToUtc('2026-10-14 14:45:00', 'America/New_York')).toBe('2026-10-14T18:45:00.000Z'); // EDT
    expect(wallTimeToUtc('2026-12-14 14:45', 'America/New_York')).toBe('2026-12-14T19:45:00.000Z'); // EST
  });
});

describe('region', () => {
  test('countries', async () => {
    const { checkRegion, loadEligibility, regionLabel } = await import('../src/trade/eligibility');
    const data = await loadEligibility();
    expect(checkRegion({ country: 'CO' }, data)).toEqual({ ok: true, label: 'Colombia' });
    expect(checkRegion({ country: 'BR' }, data).ok).toBe(true);
    for (const c of ['CA', 'GB', 'FR', 'AU', 'VE', 'RU']) expect(checkRegion({ country: c }, data).ok).toBe(false);
    expect(checkRegion({ country: 'US', state: 'FL' }, data).ok).toBe(true);
    expect(checkRegion({ country: 'US' }, data).ok).toBe(false);
    expect(checkRegion({ country: 'PR' }, data).ok).toBe(false);
    expect(checkRegion({}, data).ok).toBe(false);
    expect(checkRegion({ state: 'FL' }, data).ok).toBe(true); // old configs = US
    expect(regionLabel({ country: 'CO' })).toBe('Colombia');
  });
});

describe('eligibility', () => {
  const data = { asOf: 'x', kalshi: { sportsRestricted: ['NJ', 'NV'], platformRestricted: [] } };
  test('blocks restricted and missing states', () => {
    expect(checkState('FL', data).ok).toBe(true);
    expect(checkState('nj', data).ok).toBe(false);
    expect(checkState(undefined, data).ok).toBe(false);
    expect(checkState('ZZ', data).ok).toBe(false);
  });
});

describe('order encoding (V2 YES-side book)', () => {
  test('buy YES at 0.62 is a bid at 0.62', () => {
    const b = toV2Body({ ticker: 'T', side: 'yes', count: 3, limitPrice: 0.62, clientOrderId: 'c' });
    expect(b).toMatchObject({ side: 'bid', price: '0.6200', count: '3.00', time_in_force: 'fill_or_kill' });
  });
  test('buy NO at 0.30 is an ask (sell YES) at 0.70', () => {
    const b = toV2Body({ ticker: 'T', side: 'no', count: 5, limitPrice: 0.3, clientOrderId: 'c' });
    expect(b).toMatchObject({ side: 'ask', price: '0.7000', count: '5.00' });
  });
});

describe('required edge', () => {
  test('base plus hit-rate uncertainty', () => {
    const risk = { ...RISK0 };
    expect(risk.minEdge).toBe(0.05);
    expect(requiredEdge(risk, 0.024)).toBeCloseTo(0.074, 9);
    expect(requiredEdge(risk)).toBeCloseTo(0.08, 9); // stated mode: assume +-3 pts
    expect(requiredEdge({ ...risk, edgeUncertainty: 0 }, 0.05)).toBeCloseTo(0.05, 9);
  });
  test('a small sample needs more edge', () => {
    const ctxBase = { bankroll: 1000, dailyRemaining: 100, minutesToKickoff: 120 };
    const m = match(market('0.73', '0.29', '0.72'));
    // prob 0.81, cost ~0.744 -> edge ~6.6%
    expect(evaluate(m, 0.81, RISK0, { ...ctxBase, probabilityStdErr: 0.01 })!.skip).toBeUndefined();
    expect(evaluate(m, 0.81, RISK0, { ...ctxBase, probabilityStdErr: 0.049 })!.skip).toContain('needed');
  });
});

describe('config upgrade', () => {
  test('old flat 3% default moves to the new rule; a custom value is kept', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'se-cfg-'));
    const prev = process.env.SOCCER_EDGE_HOME;
    process.env.SOCCER_EDGE_HOME = dir;
    const { loadConfig } = await import('../src/config');
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ risk: { minEdge: 0.03 } }));
    expect(loadConfig().risk).toMatchObject({ minEdge: 0.05, edgeUncertainty: 1 });
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ risk: { minEdge: 0.04 } }));
    expect(loadConfig().risk.minEdge).toBe(0.04);
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ risk: { minEdge: 0.03, edgeUncertainty: 0 } }));
    expect(loadConfig().risk.minEdge).toBe(0.03);
    process.env.SOCCER_EDGE_HOME = prev;
    rmSync(dir, { recursive: true, force: true });
  });
});

test('65% floor: low win chance or low PredyGo confidence is never traded, even with a big edge', async () => {
  const { CLASSIC_CONFIG: DEFAULT_CONFIG } = await import('./classic');
  const m: any = { ok: true, prediction: { id: 'x', bet: 'T+1.5' }, spec: { kind: 'total', line: 1.5, side: 'yes' }, side: 'yes',
    market: { ticker: 'T', status: 'active', yes_ask_dollars: '0.4200', yes_bid_dollars: '0.4100', no_ask_dollars: '0.5900' } };
  const ctx = { bankroll: 50, dailyRemaining: 20, minutesToKickoff: 120 };
  const lowWin = evaluate(m, 0.55, RISK0, ctx)!;
  expect(lowWin.edge).toBeGreaterThan(0.1);
  expect(lowWin).toMatchObject({ skip: 'win chance 55% < 65% minimum', hard: true, contracts: 0 });
  const lowStated = evaluate({ ...m, market: { ...m.market, yes_ask_dollars: '0.6000', yes_bid_dollars: '0.5900' } }, 0.8, RISK0, { ...ctx, statedProbability: 0.6 })!;
  expect(lowStated).toMatchObject({ skip: 'PredyGo confidence 60% < 65% minimum', hard: true });
  const ok = evaluate({ ...m, market: { ...m.market, yes_ask_dollars: '0.6000', yes_bid_dollars: '0.5900' } }, 0.8, RISK0, { ...ctx, statedProbability: 0.8 })!;
  expect(ok.skip).toBeUndefined();
});

test("lean toward the market: a cheap price on a flat bet-type rate isn't a huge edge; 95c+ is no-trade", async () => {
  const { CLASSIC_CONFIG: DEFAULT_CONFIG } = await import('./classic');
  const m: any = { ok: true, prediction: { id: 'x', bet: 'VISITA MARCA' }, spec: { kind: 'team_total', team: 'away', line: 0.5, side: 'yes' }, side: 'yes',
    market: { ticker: 'T', status: 'active', yes_ask_dollars: '0.5700', yes_bid_dollars: '0.5500', no_ask_dollars: '0.4500' } };
  const ctx = { bankroll: 50, dailyRemaining: 20, minutesToKickoff: 120 };
  const flat = evaluate(m, 0.793, { ...DEFAULT_CONFIG.risk, marketWeight: 0 }, ctx)!;
  const lean = evaluate(m, 0.793, DEFAULT_CONFIG.risk, ctx)!;
  expect(lean.priced).toBeCloseTo(0.7 * 0.793 + 0.3 * 0.56, 6);
  expect(lean.edge).toBeLessThan(flat.edge - 0.06);
  expect(lean.probability).toBe(0.793); // the shown win chance (and the minimum rule) stay the model's
  const pricey = evaluate({ ...m, market: { ...m.market, yes_ask_dollars: '0.9600', yes_bid_dollars: '0.9500' } }, 0.99, DEFAULT_CONFIG.risk, ctx)!;
  expect(pricey.skip).toBe('price 96¢ > 94¢ max');
});

test('confidence just under the minimum shows a decimal', async () => {
  const { pctBelow } = await import('../src/trade/edge');
  expect(pctBelow(0.645, 0.65)).toBe('64.5%');
  expect(pctBelow(0.6, 0.65)).toBe('60%');
});

test('market or feed odds far below the win chance: skipped (Helmond v NAC 1X at 38c, odds 2.5)', async () => {
  const { CLASSIC_CONFIG: DEFAULT_CONFIG } = await import('./classic');
  const m: any = { ok: true, prediction: { id: 'x', bet: '1X' }, spec: { kind: 'not_win', team: 'away', side: 'no' }, side: 'no',
    market: { ticker: 'T', status: 'active', yes_ask_dollars: '0.6300', yes_bid_dollars: '0.6200', no_ask_dollars: '0.3800' } };
  const ctx = { bankroll: 50, dailyRemaining: 20, minutesToKickoff: 120 };
  const p = evaluate(m, 0.789, DEFAULT_CONFIG.risk, ctx)!;
  expect(p.skip).toMatch(/^market disagrees: win chance 79% vs Kalshi 38¢/);
  // Atalanta v Pafos (won): 79% vs 56c is within the 30-point gap.
  const ok = evaluate({ ...m, side: 'yes', market: { ...m.market, yes_ask_dollars: '0.5700', yes_bid_dollars: '0.5500' } }, 0.793, DEFAULT_CONFIG.risk, ctx)!;
  expect(ok.skip ?? '').not.toMatch(/disagree/);
  // Feed's own odds: 2.5 = 40%.
  // Feed's own odds (2.5 = 40%) only count when "Use Kalshi live odds" is off; on by default.
  const withOdds = { ...m, side: 'yes', prediction: { ...m.prediction, odds: 2.5 }, market: { ...m.market, yes_ask_dollars: '0.5700', yes_bid_dollars: '0.5500' } };
  expect(evaluate(withOdds, 0.789, DEFAULT_CONFIG.risk, ctx)!.skip ?? '').not.toMatch(/feed odds/);
  const odds = evaluate(withOdds, 0.789, { ...DEFAULT_CONFIG.risk, useKalshiOdds: false }, ctx)!;
  expect(odds.skip).toMatch(/^feed odds disagree/);
});

test('Over 2.5 and BTTS are blocked by default; each can be turned back on', async () => {
  const { CLASSIC_CONFIG: DEFAULT_CONFIG } = await import('./classic');
  const m = (bet: string): any => ({ ok: true, prediction: { id: 'x', bet }, spec: { kind: 'total', line: 2.5, side: 'yes' }, side: 'yes',
    market: { ticker: 'T', status: 'active', yes_ask_dollars: '0.4000', yes_bid_dollars: '0.3900', no_ask_dollars: '0.6100' } });
  const ctx = { bankroll: 50, dailyRemaining: 20, minutesToKickoff: 120 };
  const r = { ...DEFAULT_CONFIG.risk, maxGapToMarket: 0 };
  expect(evaluate(m('TOTALGOALS+2.5'), 0.7, r, ctx)!).toMatchObject({ skip: 'Over 2.5 goals picks are turned off in Settings', hard: true });
  expect(evaluate(m('BTTS'), 0.7, r, ctx)!).toMatchObject({ skip: 'BTTS picks are turned off in Settings', hard: true });
  expect(evaluate(m('T+2.5'), 0.7, r, ctx)!.skip).toBe('Over 2.5 goals picks are turned off in Settings'); // same bet, other spelling (3-8 in real trading)
  expect(evaluate(m('TOTALGOALS+2.5'), 0.7, { ...r, blockOver25: false }, ctx)!.skip ?? '').not.toMatch(/turned off/);
  expect(evaluate(m('BTTS'), 0.7, { ...r, blockBtts: false }, ctx)!.skip ?? '').not.toMatch(/turned off/);
});

test('limits sized from the balance: per trade, open positions, daily', async () => {
  const { autoLimits, applyAutoSize, DEFAULT_CONFIG } = await import('../src/config');
  // $64.49, up to 5% a trade, 50% at risk -> up to $3 a trade, $32 a day, room for 32 $1 bets.
  expect(autoLimits({ maxPositionPct: 0.05, maxOpenExposurePct: 0.5 }, 64.49)).toEqual({ maxNotionalPerOrder: 3, maxOpenPositions: 32, maxDailySpend: 0 }); // no daily limit
  // 3% -> $1.93 rounds down to $1.50; 30% at risk -> $19.
  expect(autoLimits({ maxPositionPct: 0.03, maxOpenExposurePct: 0.3 }, 64.49)).toEqual({ maxNotionalPerOrder: 1.5, maxOpenPositions: 19, maxDailySpend: 0 });
  // Never below $1 per trade or 1 position.
  expect(autoLimits({ maxPositionPct: 0.05, maxOpenExposurePct: 0.3 }, 5)).toEqual({ maxNotionalPerOrder: 1, maxOpenPositions: 1, maxDailySpend: 0 });
  const cfg = structuredClone(DEFAULT_CONFIG);
  expect(applyAutoSize(cfg, 64.49)).toBe(true);
  expect(applyAutoSize(cfg, 64.49)).toBe(false);
  cfg.risk.autoSize = false; cfg.risk.maxNotionalPerOrder = 7;
  expect(applyAutoSize(cfg, 100)).toBe(false);
  expect(cfg.risk.maxNotionalPerOrder).toBe(7);
});

test('minimum win: tiny bets are raised to win at least $0.50, or skipped if the limits say no', async () => {
  const { CLASSIC_CONFIG: DEFAULT_CONFIG } = await import('./classic');
  const { minContractsFor, winProfit } = await import('../src/trade/edge');
  expect(minContractsFor(0.75, 0.5)).toBe(3); // 2 would win $0.49 after the fee
  expect(winProfit(3, 0.75)).toBeGreaterThanOrEqual(0.5);
  expect(minContractsFor(0.98, 0.5)).toBeGreaterThan(25);
  const m: any = { ok: true, prediction: { id: 'x', bet: 'VISITA MARCA' }, spec: { kind: 'team_total', team: 'away', line: 0.5, side: 'yes' }, side: 'yes',
    market: { ticker: 'T', status: 'active', yes_ask_dollars: '0.7500', yes_bid_dollars: '0.7400', no_ask_dollars: '0.2600' } };
  const risk = { ...DEFAULT_CONFIG.risk, marketWeight: 0, maxGapToMarket: 0, minEdge: 0.01, edgeUncertainty: 0, kellyMultiplier: 0.05, maxNotionalPerOrder: 5, maxPositionPct: 0.1, stakeMode: 'kelly' as const };
  // Kelly alone would buy 1 contract (wins $0.24): raised to 3.
  const p = evaluate(m, 0.82, risk, { bankroll: 50, dailyRemaining: 20, minutesToKickoff: 120 })!;
  expect(p.skip).toBeUndefined();
  expect(p.contracts).toBe(3);
  // $2 left today can't buy 3: skipped instead of a pennies bet.
  const q = evaluate(m, 0.82, risk, { bankroll: 50, dailyRemaining: 2, minutesToKickoff: 120 })!;
  expect(q.skip).toMatch(/^would win only \$0\.\d\d \(min \$0\.50/);
  // Turned off (0): old behaviour.
  expect(evaluate(m, 0.82, { ...risk, minWinProfit: 0 }, { bankroll: 50, dailyRemaining: 20, minutesToKickoff: 120 })!.contracts).toBe(1);
});

test('won/lost shown the moment the bet condition is met, before Kalshi settles', async () => {
  const { earlyResult } = await import('../src/trade/tracker');
  // Team to score / over: goal in -> YES at 99c+ = won.
  expect(earlyResult('KXUELTEAMTOTAL-26OCT15OLMOLY-OLY1', 'yes', 0.99).decided).toBe('won');
  expect(earlyResult('KXCZEFNLTOTAL-26OCT16OPAJIH-2', 'yes', 0.995).decided).toBe('won');
  expect(earlyResult('KXCZEFNLBTTS-26OCT16PRITRI-BTTS', 'yes', 1).decided).toBe('won');
  // An "under" (NO on over) loses for good once the line is passed.
  expect(earlyResult('KXCZEFNLTOTAL-26OCT16OPAJIH-2', 'no', 0.005).decided).toBe('lost');
  // Before the goal, even at 97c, it's only "winning".
  expect(earlyResult('KXUELTEAMTOTAL-26OCT15OLMOLY-OLY1', 'yes', 0.97)).toEqual({ decided: null, outlook: 'winning' });
  // Match result can still change: never called early, only winning/losing.
  expect(earlyResult('KXEERSTEDIVGAME-26OCT16HELBRE-BRE', 'no', 0.995)).toEqual({ decided: null, outlook: 'winning' });
  expect(earlyResult('KXEERSTEDIVGAME-26OCT16HELBRE-BRE', 'no', 0.05)).toEqual({ decided: null, outlook: 'losing' });
  expect(earlyResult('KXEERSTEDIVGAME-26OCT16HELBRE-BRE', 'no', 0.5)).toEqual({ decided: null, outlook: null });
});

test('default: only picks published on PredyGo', async () => {
  const { CLASSIC_CONFIG: DEFAULT_CONFIG } = await import('./classic');
  expect(DEFAULT_CONFIG.source.includeAll).toBe(false);
});

test('v0.21: $5 bets, no per-kind cap, 60% open; live picks skip the market-gap check; old saved settings updated once', async () => {
  const { DEFAULT_CONFIG, autoLimits } = await import('../src/config');
  expect(autoLimits(DEFAULT_CONFIG.risk, 58)).toMatchObject({ maxNotionalPerOrder: 5, maxDailySpend: 0 });
  expect(autoLimits(DEFAULT_CONFIG.risk, 40).maxNotionalPerOrder).toBe(4); // never over 10% of cash
  expect(autoLimits(DEFAULT_CONFIG.risk, 300).maxNotionalPerOrder).toBe(15); // 5% once that's over $5
  expect(DEFAULT_CONFIG.risk).toMatchObject({ stakeMode: 'flat', maxOpenPerBetType: 0, maxOpenExposurePct: 1 }); // v0.35 defaults: open bets limited by cash
  // Real Salt Lake v San Jose, live over 1.5 at 41c (won): no longer blocked by the 30-point gap.
  const m: any = { ok: true, prediction: { id: 'x', bet: 'T+1.5' }, spec: { kind: 'total', line: 1.5, side: 'yes' }, side: 'yes',
    market: { ticker: 'T', status: 'active', yes_ask_dollars: '0.4100', yes_bid_dollars: '0.4000', no_ask_dollars: '0.6000' } };
  const ctx = { bankroll: 58, dailyRemaining: 30, minutesToKickoff: Infinity, probabilityStdErr: 0.02 };
  const risk = { ...DEFAULT_CONFIG.risk, ...autoLimits(DEFAULT_CONFIG.risk, 58), rulesOff: [] };
  expect(evaluate(m, 0.82, risk, ctx)!.skip).toMatch(/market disagrees/);
  const live = evaluate(m, 0.82, risk, { ...ctx, live: true })!;
  expect(live.skip).toBeUndefined();
  expect(live.contracts).toBe(11); // flat $5 at 41c, fee included
  // Saved settings from before v0.21 get the new values once; a later choice is kept.
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { loadConfig } = await import('../src/config');
  const dir = mkdtempSync(join(tmpdir(), 'se-rev-')), prev = process.env.SOCCER_EDGE_HOME;
  process.env.SOCCER_EDGE_HOME = dir;
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ risk: { stakeMode: 'kelly', maxOpenPerBetType: 2, maxOpenExposurePct: 0.3, maxPositionPct: 0.05, minEdge: 0.04 } }));
    expect(loadConfig().risk).toMatchObject({ stakeMode: 'flat', maxOpenPerBetType: 0, maxOpenExposurePct: 0.6, maxPositionPct: 0.1, minEdge: 0.04, settingsRev: 22, maxDailySpend: 0 });
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ risk: { maxOpenPerBetType: 3, settingsRev: 21 } }));
    expect(loadConfig().risk.maxOpenPerBetType).toBe(3);
  } finally { if (prev === undefined) delete process.env.SOCCER_EDGE_HOME; else process.env.SOCCER_EDGE_HOME = prev; rmSync(dir, { recursive: true, force: true }); }
});
