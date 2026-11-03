/**
 * Find the Kalshi market that settles the same way as a prediction.
 */
import type { Prediction } from '../predictions/types';
import type { KalshiEvent, KalshiMarket } from '../kalshi/types';
import { allSoccerGames, kalshiPrefixesFor, loadLeagueBook, type MarketSuffix } from '../kalshi/markets';
import { resolveSpec, type BetSpec } from './bets';
import { teamSimilarity, TEAM_MATCH_THRESHOLD } from './teams';

export type MatchFailure =
  | 'unsupported_bet'
  | 'live_pick'
  | 'league_not_on_kalshi'
  | 'market_type_not_offered'
  | 'no_event'
  | 'ambiguous_event'
  | 'no_market'
  | 'market_not_active';

export type MatchResult =
  | { ok: true; prediction: Prediction; spec: BetSpec; event: KalshiEvent; market: KalshiMarket; side: 'yes' | 'no' }
  | { ok: false; prediction: Prediction; spec?: BetSpec; reason: MatchFailure; detail?: string; market?: KalshiMarket };

const SUFFIX_FOR: Record<BetSpec['kind'], MarketSuffix> = {
  total: 'TOTAL',
  btts: 'BTTS',
  team_total: 'TEAMTOTAL',
  not_win: 'GAME',
};

const MONTHS: Record<string, number> = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

/** Date encoded in an event ticker, e.g. KXMLSTOTAL-26OCT18CINCLB -> 2026-10-18 (UTC midnight). */
export function eventDate(eventTicker: string): Date | null {
  const m = eventTicker.match(/-(\d{2})([A-Z]{3})(\d{2})/);
  if (!m || MONTHS[m[2]!] === undefined) return null;
  return new Date(Date.UTC(2000 + +m[1]!, MONTHS[m[2]!]!, +m[3]!));
}

/** "Cincinnati vs Columbus: Total Goals" -> ["Cincinnati", "Columbus"] */
export function eventTeams(title: string): [string, string] | null {
  const core = title.split(':')[0]!;
  const parts = core.split(/\s+(?:vs\.?|v)\s+/i);
  if (parts.length !== 2) return null;
  // Some Kalshi titles repeat the separator ("Avispa vs vs Hiroshima").
  const clean = (s: string) => s.trim().replace(/^(?:vs\.?|v)\s+/i, '').trim();
  return [clean(parts[0]!), clean(parts[1]!)];
}

interface Candidate { event: KalshiEvent; score: number }

export function findEvent(p: Prediction, events: KalshiEvent[]): { event?: KalshiEvent; reason?: MatchFailure; detail?: string } {
  const kickoff = new Date(p.kickoff).getTime();
  const candidates: Candidate[] = [];
  for (const ev of events) {
    const d = eventDate(ev.event_ticker);
    // Event tickers carry a calendar date; allow one day either side for time zones.
    // No date in the ticker means we can't confirm it's this game: skip it.
    if (!d || Math.abs(d.getTime() - kickoff) > 36 * 3600_000) continue;
    const teams = eventTeams(ev.title);
    if (!teams) continue;
    const straight = [teamSimilarity(p.home, teams[0]), teamSimilarity(p.away, teams[1])];
    const swapped = [teamSimilarity(p.home, teams[1]), teamSimilarity(p.away, teams[0])];
    const best = Math.min(...straight) >= Math.min(...swapped) ? straight : swapped;
    if (Math.min(...best) < TEAM_MATCH_THRESHOLD) continue;
    candidates.push({ event: ev, score: best[0]! + best[1]! });
  }
  if (candidates.length === 0) return { reason: 'no_event' };
  candidates.sort((a, b) => b.score - a.score);
  const [first, second] = candidates;
  if (second && second.event.event_ticker !== first!.event.event_ticker && first!.score - second.score < 0.15) {
    return { reason: 'ambiguous_event', detail: `${first!.event.title} / ${second.event.title}` };
  }
  return { event: first!.event };
}

/** Team name a team-specific market refers to: "San Diego FC over 0.5 goals" -> "San Diego FC". */
export function marketTeam(m: KalshiMarket): string {
  const label = m.yes_sub_title ?? m.title;
  return label
    // Cup markets say "Reg Time: Atletico Mineiro" (settles on 90 minutes, as our picks do).
    .replace(/^(?:reg(?:ulation)?\.?\s*time|regulation|90\s*min(?:utes)?)\s*:\s*/i, '')
    .replace(/\s+over\s+[\d.]+\s+goals?.*$/i, '')
    .replace(/^Will\s+/i, '')
    .replace(/\s+wins?$/i, '')
    .trim();
}

/**
 * The market for `team`, only if it is clearly that team and not the opponent:
 * it must look more like `team` than `opponent` by a margin, and beat every other market by a margin.
 */
function pickTeamMarket(markets: KalshiMarket[], team: string, opponent: string): KalshiMarket | undefined {
  const MARGIN = 0.2;
  const scored = markets
    .map((m) => ({ m, s: teamSimilarity(team, marketTeam(m)), o: teamSimilarity(opponent, marketTeam(m)) }))
    .filter((x) => x.s >= TEAM_MATCH_THRESHOLD && x.s - x.o >= MARGIN)
    .sort((a, b) => b.s - a.s);
  if (scored.length === 0) return undefined;
  if (scored.length > 1 && scored[0]!.s - scored[1]!.s < MARGIN) return undefined;
  return scored[0]!.m;
}

export function findMarket(spec: BetSpec, p: Prediction, ev: KalshiEvent): KalshiMarket | undefined {
  const markets = ev.markets ?? [];
  switch (spec.kind) {
    case 'total':
      return markets.find((m) => m.floor_strike === spec.line && (m.strike_type ?? 'greater') === 'greater');
    case 'btts':
      return markets.find((m) => /both teams to score/i.test(m.title) || /-BTTS$/.test(m.ticker)) ?? (markets.length === 1 ? markets[0] : undefined);
    case 'team_total': {
      const atLine = markets.filter((m) => m.floor_strike === spec.line);
      return spec.team === 'home' ? pickTeamMarket(atLine, p.home, p.away) : pickTeamMarket(atLine, p.away, p.home);
    }
    case 'not_win': {
      const teamMarkets = markets.filter((m) => !/^tie$|^draw$/i.test(marketTeam(m)) && !/-TIE$/.test(m.ticker));
      return spec.team === 'home' ? pickTeamMarket(teamMarkets, p.home, p.away) : pickTeamMarket(teamMarkets, p.away, p.home);
    }
  }
}

/** Both teams must match this well (and the date) to use a competition found by search. */
const DISCOVERY_THRESHOLD = 0.85;

/**
 * Kalshi competitions listing this exact game (both teams clearly match, same date), for a
 * pick whose league isn't in leagues.json or wasn't found there. Best match first.
 */
export async function discoverPrefixes(p: Prediction, exclude: string[] = []): Promise<string[]> {
  let index;
  try { index = await allSoccerGames(); } catch { return []; }
  const kickoff = new Date(p.kickoff).getTime();
  const hits: { prefix: string; score: number }[] = [];
  for (const { prefix, events } of index) {
    if (exclude.includes(prefix)) continue;
    for (const ev of events) {
      const d = eventDate(ev.event_ticker);
      if (!d || Math.abs(d.getTime() - kickoff) > 36 * 3600_000) continue;
      const teams = eventTeams(ev.title);
      if (!teams) continue;
      const h = teamSimilarity(p.home, teams[0]);
      const a = teamSimilarity(p.away, teams[1]);
      if (Math.min(h, a) >= DISCOVERY_THRESHOLD) hits.push({ prefix, score: h + a });
    }
  }
  hits.sort((x, y) => y.score - x.score);
  return [...new Set(hits.map((x) => x.prefix))];
}

export async function matchPrediction(p: Prediction, opts: { allowLive?: boolean; discover?: boolean } = {}): Promise<MatchResult> {
  const first = await matchIn(p, kalshiPrefixesFor(p.league), opts);
  if (first.ok || opts.discover === false) return first;
  // Not found under the listed competition (or none listed): search all of Kalshi's soccer.
  if (!['league_not_on_kalshi', 'no_event', 'market_type_not_offered'].includes(first.reason)) return first;
  const found = await discoverPrefixes(p, kalshiPrefixesFor(p.league));
  if (found.length === 0) return first;
  const second = await matchIn(p, found.slice(0, 2), opts);
  return second.ok ? second : first.reason === 'league_not_on_kalshi' ? second : first;
}

async function matchIn(p: Prediction, prefixes: string[], opts: { allowLive?: boolean }): Promise<MatchResult> {
  if (!opts.allowLive && p.source && p.source.toLowerCase() !== 'pregame') return { ok: false, prediction: p, reason: 'live_pick', detail: p.source };
  const { spec, conflict } = resolveSpec(p.bet, p.canonical);
  if (!spec) return { ok: false, prediction: p, reason: 'unsupported_bet', detail: conflict ? `${p.bet}: code and market definition disagree` : p.bet };
  if (prefixes.length === 0) return { ok: false, prediction: p, spec, reason: 'league_not_on_kalshi', detail: p.league };

  const suffix = SUFFIX_FOR[spec.kind];
  let lastFailure: MatchResult | null = null;
  for (const prefix of prefixes) {
    const book = await loadLeagueBook(prefix);
    if (book.events[suffix].length === 0) {
      lastFailure = { ok: false, prediction: p, spec, reason: 'market_type_not_offered', detail: `${prefix}${suffix}` };
      continue;
    }
    const found = findEvent(p, book.events[suffix]);
    if (!found.event) {
      lastFailure = { ok: false, prediction: p, spec, reason: found.reason!, detail: found.detail ?? `${prefix}${suffix}` };
      continue;
    }
    const market = findMarket(spec, p, found.event);
    if (!market) {
      lastFailure = { ok: false, prediction: p, spec, reason: 'no_market', detail: found.event.event_ticker };
      continue;
    }
    if (market.status !== 'active') {
      lastFailure = { ok: false, prediction: p, spec, reason: 'market_not_active', detail: `${market.ticker} is ${market.status}`, market };
      continue;
    }
    return { ok: true, prediction: p, spec, event: found.event, market, side: spec.side };
  }
  return lastFailure ?? { ok: false, prediction: p, spec, reason: 'no_event' };
}
