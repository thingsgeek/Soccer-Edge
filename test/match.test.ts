import { describe, expect, test } from 'bun:test';
import { parseBet } from '../src/match/bets';
import { teamSimilarity, TEAM_MATCH_THRESHOLD } from '../src/match/teams';
import { eventDate, eventTeams, findEvent, findMarket } from '../src/match/matcher';
import type { KalshiEvent, KalshiMarket } from '../src/kalshi/types';
import type { Prediction } from '../src/predictions/types';

describe('parseBet', () => {
  test('totals', () => {
    expect(parseBet('T+1.5')).toEqual({ kind: 'total', line: 1.5, side: 'yes' });
    expect(parseBet('TOTALGOALS+2.5')).toEqual({ kind: 'total', line: 2.5, side: 'yes' });
    expect(parseBet('T+2')).toBeNull(); // whole-number lines can push; no Kalshi equivalent
  });
  test('team scores', () => {
    expect(parseBet('LOCAL MARCA')).toEqual({ kind: 'team_total', team: 'home', line: 0.5, side: 'yes' });
    expect(parseBet('VISITA MARCA')).toEqual({ kind: 'team_total', team: 'away', line: 0.5, side: 'yes' });
    expect(parseBet('VISITA MARCA REG')).toEqual({ kind: 'team_total', team: 'away', line: 0.5, side: 'yes' });
  });
  test('double chance is a NO on the other team winning', () => {
    expect(parseBet('1X')).toEqual({ kind: 'not_win', team: 'away', side: 'no' });
    expect(parseBet('X2')).toEqual({ kind: 'not_win', team: 'home', side: 'no' });
  });
  test('btts and unknown', () => {
    expect(parseBet('BTTS')).toEqual({ kind: 'btts', side: 'yes' });
    expect(parseBet('CORNERS+9.5')).toBeNull();
  });
});

describe('teamSimilarity', () => {
  const same = (a: string, b: string) => expect(teamSimilarity(a, b)).toBeGreaterThanOrEqual(TEAM_MATCH_THRESHOLD);
  const diff = (a: string, b: string) => expect(teamSimilarity(a, b)).toBeLessThan(TEAM_MATCH_THRESHOLD);

  test('matches real Kalshi vs PredyGo names', () => {
    same('Wolverhampton', 'Wolverhampton');
    same('Legia Warsaw', 'Legia Warszawa');
    same('Athletico Paranaense', 'Paranaense');
    same('Universidad de Concepcion', 'U de Concepcion');
    same('Karlsruher SC', 'Karlsruhe');
    same('St Pauli', 'St. Pauli');
    same('Piast Gliwice', 'Gliwice');
    same('LA Galaxy', 'Los Angeles G');
    same('Rennes', 'Stade Rennais');
    same('Nice', 'Nice');
    same('Bristol City', 'Bristol City');
  });
  test('does not confuse rival clubs', () => {
    diff('Manchester United', 'Manchester City');
    diff('Bristol City', 'Bristol Rovers');
    diff('Sheffield United', 'Sheffield Wednesday');
    diff('Real Madrid', 'Atletico Madrid');
    diff('Inter Miami', 'Inter Milan');
  });
});

describe('event parsing', () => {
  test('ticker date and teams', () => {
    expect(eventDate('KXMLSTOTAL-26OCT18CINCLB')!.toISOString()).toBe('2026-10-18T00:00:00.000Z');
    expect(eventTeams('Cincinnati vs Columbus: Total Goals')).toEqual(['Cincinnati', 'Columbus']);
  });
});

const pred = (home: string, away: string, kickoff = '2026-10-18T23:00:00.000Z', bet = 'T+1.5'): Prediction => ({
  id: 'x', league: 'USA MLS', kickoff, home, away, bet, statedPct: 80,
});
const ev = (ticker: string, title: string, markets: Partial<KalshiMarket>[] = []): KalshiEvent => ({
  event_ticker: ticker, series_ticker: ticker.split('-')[0]!, title,
  markets: markets.map((m) => ({ title: '', status: 'active', ...m, ticker: `${ticker}-${m.ticker ?? 'M'}` }) as KalshiMarket),
});

describe('findEvent', () => {
  const events = [
    ev('KXMLSTOTAL-26OCT18CINCLB', 'Cincinnati vs Columbus: Total Goals'),
    ev('KXMLSTOTAL-26OCT25CINCLB', 'Cincinnati vs Columbus: Total Goals'),
    ev('KXMLSTOTAL-26OCT18SJNSH', 'San Jose vs Nashville: Total Goals'),
  ];
  test('picks the game on the right date', () => {
    expect(findEvent(pred('FC Cincinnati', 'Columbus Crew'), events).event!.event_ticker).toBe('KXMLSTOTAL-26OCT18CINCLB');
  });
  test('no game when the date is far off', () => {
    expect(findEvent(pred('FC Cincinnati', 'Columbus Crew', '2026-11-01T23:00:00Z'), events).reason).toBe('no_event');
  });
  test('needs both teams', () => {
    expect(findEvent(pred('FC Cincinnati', 'Nashville'), events).reason).toBe('no_event');
  });
});

describe('findMarket', () => {
  const p = pred('San Diego FC', 'Houston');
  test('total picks the exact line', () => {
    const e = ev('KXMLSTOTAL-26OCT18SDHOU', 'San Diego FC vs Houston', [
      { ticker: '1', floor_strike: 0.5, strike_type: 'greater' },
      { ticker: '2', floor_strike: 1.5, strike_type: 'greater' },
      { ticker: '3', floor_strike: 2.5, strike_type: 'greater' },
    ]);
    expect(findMarket(parseBet('T+1.5')!, p, e)!.ticker).toEndWith('-2');
    expect(findMarket(parseBet('TOTALGOALS+2.5')!, p, e)!.ticker).toEndWith('-3');
  });
  test('team total picks the right team at 0.5', () => {
    const e = ev('KXMLSTEAMTOTAL-26OCT18SDHOU', 'San Diego FC vs Houston: Team Total', [
      { ticker: 'SD1', floor_strike: 0.5, yes_sub_title: 'San Diego FC over 0.5 goals' },
      { ticker: 'SD2', floor_strike: 1.5, yes_sub_title: 'San Diego FC over 1.5 goals' },
      { ticker: 'HOU1', floor_strike: 0.5, yes_sub_title: 'Houston over 0.5 goals' },
    ]);
    expect(findMarket(parseBet('LOCAL MARCA')!, p, e)!.ticker).toEndWith('-SD1');
    expect(findMarket(parseBet('VISITA MARCA')!, p, e)!.ticker).toEndWith('-HOU1');
  });
  test('1X maps to the away-win market (bought as NO)', () => {
    const e = ev('KXMLSGAME-26OCT18SDHOU', 'San Diego FC vs Houston', [
      { ticker: 'SD', yes_sub_title: 'San Diego FC' },
      { ticker: 'HOU', yes_sub_title: 'Houston' },
      { ticker: 'TIE', yes_sub_title: 'Tie' },
    ]);
    expect(findMarket(parseBet('1X')!, p, e)!.ticker).toEndWith('-HOU');
    expect(findMarket(parseBet('X2')!, p, e)!.ticker).toEndWith('-SD');
  });
});

import { parseCanonical, resolveSpec } from '../src/match/bets';
import { normalizeRows } from '../src/predictions/sources';

describe('PredyGo API format (api-docs)', () => {
  test('documented example row', () => {
    const [p] = normalizeRows([{
      id: 1234, league: 'England Championship', home: 'Burnley', away: 'Charlton',
      market: { code: 'VISITA MARCA', name: 'Away team to score', canonical: { market: 'team_totals', team: 'away', name: 'Over', point: 0.5 } },
      confidence: 97, odds: '6.50 / +550', kickoff: '2026-10-18 15:00:00', source: 'pregame', result: 'pending', score: null,
    }]);
    expect(p).toMatchObject({ id: '1234::VISITA MARCA', league: 'England Championship', home: 'Burnley', away: 'Charlton', bet: 'VISITA MARCA', statedPct: 97, won: null, source: 'pregame' });
    expect(p!.kickoff).toBe('2026-10-18T19:00:00.000Z'); // New York wall time
    expect(resolveSpec(p!.bet, p!.canonical).spec).toEqual({ kind: 'team_total', team: 'away', line: 0.5, side: 'yes' });
  });
  test('graded results', () => {
    const rows = ['win', 'loss', 'push', 'void'].map((result, i) => ({ id: i, league: 'L', home: 'a', away: 'b', market: { code: 'BTTS' }, confidence: 60, kickoff: '2026-10-01 12:00:00', result }));
    expect(normalizeRows(rows).map((p) => p.won)).toEqual([true, false, null, null]);
  });
  test('canonical definitions', () => {
    expect(parseCanonical({ market: 'totals', name: 'Over', point: 2.5 })).toEqual({ kind: 'total', line: 2.5, side: 'yes' });
    expect(parseCanonical({ market: 'totals', name: 'Under', point: 2.5 })).toEqual({ kind: 'total', line: 2.5, side: 'no' });
    expect(parseCanonical({ market: 'totals', name: 'Over', point: 2 })).toBeNull();
    expect(parseCanonical({ market: 'btts', name: 'No' })).toEqual({ kind: 'btts', side: 'no' });
    expect(parseCanonical({ market: 'double_chance', name: '1X' })).toEqual({ kind: 'not_win', team: 'away', side: 'no' });
    expect(parseCanonical({ market: 'h2h', name: 'Home' })).toBeNull();
  });
  test('code and definition must agree', () => {
    expect(resolveSpec('LOCAL MARCA', { market: 'team_totals', team: 'away', name: 'Over', point: 0.5 })).toEqual({ spec: null, conflict: true });
    expect(resolveSpec('NEWCODE', { market: 'totals', name: 'Over', point: 3.5 }).spec).toEqual({ kind: 'total', line: 3.5, side: 'yes' });
  });
});

describe('full list fallback', () => {
  test('uses all=true when the server supports it, otherwise posted picks', async () => {
    const { loadPredictions } = await import('../src/predictions/sources');
    const real = globalThis.fetch;
    const row = (id: number) => ({ id, league: 'L', home: 'a', away: 'b', market: { code: 'BTTS' }, confidence: 60, kickoff: '2030-01-01 12:00:00', result: 'pending' });
    let supports = true;
    const seen: string[] = [];
    globalThis.fetch = (async (input: any) => {
      const u = new URL(String(input));
      seen.push(u.pathname + u.search);
      if (u.searchParams.get('all') === 'true' && !supports) return Response.json({ error: 'bad param' }, { status: 400 });
      const n = u.searchParams.get('all') === 'true' ? 3 : 1;
      return Response.json({ predictions: Array.from({ length: n }, (_, i) => row(i)), results: [] });
    }) as typeof fetch;
    try {
      const mod = await import('../src/predictions/sources');
      expect((await loadPredictions({ type: 'predygo', token: 'k' })).length).toBe(3);
      expect(mod.lastFeedMode).toBe('all');
      expect(seen).toContain('/api/v1/results?all=true&limit=2000&days=90');
      supports = false;
      expect((await loadPredictions({ type: 'predygo', token: 'k' })).length).toBe(1);
      expect(mod.lastFeedMode).toBe('posted');
      expect((await loadPredictions({ type: 'predygo', token: 'k', includeAll: false })).length).toBe(1);
      expect(seen).toContain('/api/v1/results?limit=500&days=7');
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe('cup markets labelled "Reg Time:"', () => {
  test('1X finds the away-win contract', () => {
    const { findMarket, marketTeam } = require('../src/match/matcher');
    const ev = { event_ticker: 'KXCONMEBOLSUDGAME-26OCT14ATLTOR', series_ticker: 'S', title: 'Atletico Mineiro vs Montevideo City', markets: [
      { ticker: 'KXCONMEBOLSUDGAME-26OCT14ATLTOR-ATL', title: '', status: 'active', yes_sub_title: 'Reg Time: Atletico Mineiro' },
      { ticker: 'KXCONMEBOLSUDGAME-26OCT14ATLTOR-TOR', title: '', status: 'active', yes_sub_title: 'Reg Time: Montevideo City' },
      { ticker: 'KXCONMEBOLSUDGAME-26OCT14ATLTOR-TIE', title: '', status: 'active', yes_sub_title: 'Reg Time: Tie' },
    ] };
    const p = { id: 'x', league: 'Copa Sudamericana', kickoff: '2026-10-14T22:00:00Z', home: 'Atletico Mineiro', away: 'Montevideo City Torque', bet: '1X', statedPct: 80 };
    expect(marketTeam(ev.markets[1])).toBe('Montevideo City');
    expect(findMarket({ kind: 'not_win', team: 'away', side: 'no' }, p, ev).ticker).toEndWith('-TOR');
  });
});

describe('admin full list (posted vs model)', () => {
  test('uses the stable key and the posted flag', () => {
    const [a, b] = normalizeRows([
      { key: '275675::T+1.5', id: 99, league: 'L', home: 'Sarmiento', away: 'River Plate', market: { code: 'T+1.5' }, confidence: 83, kickoff: '2026-10-14 18:00:00', source: 'pregame', result: 'pending', posted: false, odds: 1.62 },
      { key: '275650::VISITA MARCA', league: 'L', home: 'Portsmouth', away: 'Sheff Utd', market: { code: 'VISITA MARCA' }, confidence: 78, kickoff: '2026-10-14 14:45:00', posted: true },
    ]);
    expect(a).toMatchObject({ id: '275675::T+1.5', posted: false });
    expect(b).toMatchObject({ id: '275650::VISITA MARCA', posted: true });
  });

  test('model-only picks never get the posted picks\' hit rate', async () => {
    const { buildCalibration, probabilityFor } = await import('../src/predictions/calibration');
    const g = (posted: boolean, won: boolean) => ({ id: Math.random().toString(), league: 'L', kickoff: '2026-10-15T18:00:00Z', home: 'a', away: 'b', bet: 'T+1.5', statedPct: 83, won, posted });
    // Posted picks: 45/50 won (90%). Full list incl. 100 model picks at 70/100.
    const posted = [...Array(45).fill(0).map(() => g(true, true)), ...Array(5).fill(0).map(() => g(true, false))];
    const model = [...Array(70).fill(0).map(() => g(false, true)), ...Array(30).fill(0).map(() => g(false, false))];
    const withFull = buildCalibration([...posted, ...model]);
    const pick = (postedFlag: boolean) => ({ id: 'x', league: 'L', kickoff: '', home: 'a', away: 'b', bet: 'T+1.5', statedPct: 83, posted: postedFlag });
    expect(probabilityFor(pick(true), 'hit-rate', withFull).probability).toBeCloseTo(46 / 52, 6);
    // Model picks: the whole graded list's record, not the posted picks' (higher) one.
    expect(probabilityFor(pick(false), 'hit-rate', withFull).probability).toBeCloseTo(116 / 152, 6); // the full graded list, posted and model (115/150)
    // No model rows in results (and no bundled snapshot): model picks have no record, never the posted one.
    const postedOnly = buildCalibration(posted);
    expect(probabilityFor(pick(true), 'hit-rate', postedOnly).probability).toBeCloseTo(46 / 52, 6);
    expect(probabilityFor(pick(false), 'hit-rate', postedOnly).probability).toBeNull();
  });
});

test('city names in the local language match the English ones (Kalshi "Dinamo Bucuresti")', () => {
  expect(teamSimilarity('Dinamo Bucharest', 'Dinamo Bucuresti')).toBe(1);
  expect(teamSimilarity('Dukla Praha', 'Dukla Prague')).toBe(1);
  expect(teamSimilarity('Dinamo Bucharest', 'Rapid Bucuresti')).toBeLessThan(0.6);
  expect(teamSimilarity('Sport Huancayo', 'Huancayo')).toBe(1);
});

test('tier filter: Elite includes Pro and Free picks; no-op (and reported) while the feed has no tier info', async () => {
  const { filterTier, lastTierStatus: _ } = await import('../src/predictions/sources');
  const mod = await import('../src/predictions/sources');
  const rows: any[] = [
    { id: 1, tiers: ['elite'], source: 'pregame' },
    { id: 2, tiers: ['pro'], source: 'pregame' },
    { id: 3, tiers: ['pro', 'elite'], source: 'pregame' },
    { id: 4, source: 'live' },
    { id: 5, tiers: ['free'], source: 'pregame' },
  ];
  expect(filterTier(rows, 'elite').map((r: any) => r.id)).toEqual([1, 2, 3, 4, 5]);
  expect(mod.lastTierStatus).toMatchObject({ tier: 'elite', filtered: true, kept: 5, dropped: 0 });
  expect(filterTier(rows, 'pro').map((r: any) => r.id)).toEqual([2, 3, 4, 5]); // Elite-only pick left out
  expect(filterTier(rows, 'any')).toHaveLength(5);
  const plain = [{ id: 1 }, { id: 2 }];
  expect(filterTier(plain, 'elite')).toHaveLength(2);
  expect(mod.lastTierStatus).toMatchObject({ filtered: false });
  void _;
});

test('PredyGo API docs: odds "6.50 / +550", tiers array, query strings', async () => {
  const { normalizeRows, feedQuery, filterTier } = await import('../src/predictions/sources');
  const [p] = normalizeRows([{ id: 1234, key: '1234::VISITA MARCA', league: 'England Championship', home: 'Burnley', away: 'Charlton', market: { code: 'VISITA MARCA', name: 'Away team to score', canonical: { market: 'team_totals', team: 'away', name: 'Over', point: 0.5 } }, confidence: 97, odds: '6.50 / +550', kickoff: '2026-10-18 15:00:00', source: 'pregame', tiers: ['pro', 'elite'], result: 'pending', score: null }]);
  expect(p!.odds).toBe(6.5);
  expect(filterTier([{ tiers: ['pro'] }, { tiers: ['pro', 'elite'] }] as any, 'elite')).toHaveLength(2); // Elite includes Pro
  expect(filterTier([{ tiers: ['elite'] }, { tiers: ['pro', 'elite'] }] as any, 'pro')).toHaveLength(1);
  expect(feedQuery('/predictions', false)).toBe('?limit=500');
  expect(feedQuery('/results', false)).toBe('?limit=500&days=7');
  expect(feedQuery('/results', true, 2000)).toBe('?all=true&limit=2000&offset=2000&days=90');
});

test('published picks with an admin key: hit-rate history from 90 days of published rows (tier keys: 7 days)', async () => {
  const { loadPredictions } = await import('../src/predictions/sources');
  const real = globalThis.fetch;
  const g = (id: number, posted: boolean, tiers: string[]) => ({ id, key: `${id}::T+1.5`, league: 'L', home: 'a' + id, away: 'b', market: { code: 'T+1.5' }, confidence: 80, kickoff: '2026-10-01 12:00:00', result: 'win', posted, tiers, source: 'pregame' });
  let admin = true;
  globalThis.fetch = (async (input: any) => {
    const u = new URL(String(input));
    if (u.pathname.endsWith('/predictions')) return Response.json({ predictions: [] });
    if (u.searchParams.get('all') === 'true') {
      if (!admin) return Response.json({ error: 'admin only' }, { status: 403 });
      return Response.json({ results: [g(1, true, ['elite']), g(2, false, []), g(3, true, ['pro']), g(4, true, ['pro', 'elite']), g(5, true, ['elite'])] });
    }
    return Response.json({ results: [g(9, true, ['elite'])] });
  }) as typeof fetch;
  try {
    let preds = await loadPredictions({ type: 'predygo', token: 'k', includeAll: false, tier: 'elite' });
    expect(preds.filter((p) => p.won != null).map((p) => p.home).sort()).toEqual(['a1', 'a3', 'a4', 'a5']); // published (Elite includes Pro), model row dropped
    admin = false;
    preds = await loadPredictions({ type: 'predygo', token: 'k', includeAll: false, tier: 'elite' });
    expect(preds.filter((p) => p.won != null).map((p) => p.home)).toEqual(['a9']);
  } finally { globalThis.fetch = real; }
});

test('tier filter: live picks with an empty tiers list are kept; "Predygo Elite" counts as elite', async () => {
  const { filterTier } = await import('../src/predictions/sources');
  const rows: any[] = [
    { id: 1, tiers: ['Predygo Elite'], source: 'pregame' },
    { id: 2, tiers: [], source: 'live' },
    { id: 3, tiers: ['pro'], source: 'pregame' },
    { id: 4, tiers: 'pro, elite', source: 'pregame' },
  ];
  expect(filterTier(rows, 'elite').map((r: any) => r.id)).toEqual([1, 2, 3, 4]);
});

test('live loop reads the ?source=live board, keeps only open live rows, records live_count', async () => {
  const src = await import('../src/predictions/sources');
  const real = globalThis.fetch;
  const urls: string[] = [];
  const row = (id: number, source: string, result = 'pending') => ({ id, key: `${id}::T+1.5`, league: 'L', home: 'h' + id, away: 'a', market: { code: 'T+1.5' }, confidence: 85, kickoff: '2026-10-17 12:00:00', result, source, tiers: ['elite'] });
  globalThis.fetch = (async (input: any) => {
    urls.push(String(input));
    return Response.json({ live_count: 2, live_limit: null, predictions: [row(1, 'live'), row(2, 'live'), row(3, 'pregame')] });
  }) as typeof fetch;
  try {
    const picks = await src.loadLivePicks({ type: 'predygo', token: 'k', includeAll: false, tier: 'elite' });
    expect(picks.map((p) => p.home)).toEqual(['h1', 'h2']);
    expect(urls[0]).toContain('/predictions?source=live&limit=500');
    expect(src.lastLiveCount).toBe(2);
  } finally { globalThis.fetch = real; }
});

test('Kalshi names checked against PredyGo teams and competitions (Oct 17 audit)', async () => {
  const { kalshiPrefixesFor } = await import('../src/kalshi/markets');
  const pairs: [string, string][] = [
    ['KuPS Kuopio', 'Kuopion Palloseura'], ['Inter Club dEscaldes', 'IC Escaldes'], ['Aris Salonika', 'Aris Thessaloniki'],
    ['Hapoel Beer Sheva', 'Be`er Sheva'], ['Neom SC', 'AL Suqoor'], ['ACS Sepsi', 'Sepsi OSK'], ['Dalian Young Boy', 'Dalian Yingbo FC'],
    ['FK Radnicki 1923', 'Radnicki Kragujevac'], ['Tractor Sazi', 'Tractor Tabriz'], ['South Korea', 'Korea Republic'],
    ['South Korea', 'Republic of Korea'], ['Ha Noi FC', 'Hanoi'], ['Cong An HCMC', 'Cong an TP Ho Chi Minh'],
    ['Sparta Rotterdam Reserves', 'Jong Sparta'], ['Imigresen FC', 'Immigration FC'], ['FC Haka', 'Valkeakoski'],
    ['SG Sonnenhof Grossaspach', 'Großaspach'], ['Maritimo', 'Madeira'], ['FC Twente', 'Enschede'], ['Grazer AK', 'GAK'],
  ];
  for (const [pg, k] of pairs) expect(`${pg} ${teamSimilarity(pg, k) >= TEAM_MATCH_THRESHOLD}`).toBe(`${pg} true`);
  // Kalshi sometimes repeats the separator in titles.
  expect(eventTeams('Avispa vs vs Hiroshima: Total Goals')).toEqual(['Avispa', 'Hiroshima']);
  expect(teamSimilarity('Sanfrecce Hiroshima', eventTeams('Avispa vs vs Hiroshima')![1])).toBeGreaterThanOrEqual(TEAM_MATCH_THRESHOLD);
  // PredyGo's spellings of competitions Kalshi lists.
  expect(kalshiPrefixesFor('Türkiye Super Lig')).toEqual(['KXSUPERLIG']);
  expect(kalshiPrefixesFor('UAE Premier League')).toEqual(['KXUAEPL']);
  expect(kalshiPrefixesFor('Indonesia Super League')).toEqual(['KXIDNSL']);
  expect(kalshiPrefixesFor('USA NWSL Women')).toEqual(['KXNWSL']);
  expect(kalshiPrefixesFor('Uruguay Clausura')).toEqual(['KXURYPD']);
});

test('tiers are nested: Elite keeps pro- and free-only picks, Pro keeps free-only, Free keeps free only', async () => {
  const { filterTier } = await import('../src/predictions/sources');
  const rows: any[] = [
    { id: 1, tiers: ['elite'] }, { id: 2, tiers: 'free,pro' }, { id: 3, tiers: ['free'] }, { id: 4, tiers: ['pro'] }, { id: 5, tiers: [] },
  ];
  expect(filterTier(rows, 'elite').map((r: any) => r.id)).toEqual([1, 2, 3, 4, 5]);
  expect(filterTier(rows, 'pro').map((r: any) => r.id)).toEqual([2, 3, 4, 5]);
  expect(filterTier(rows, 'free').map((r: any) => r.id)).toEqual([2, 3, 5]);
});
