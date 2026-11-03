/**
 * Backtest published PredyGo picks against Kalshi's real prices at the moment each was published.
 *
 *   bun run scripts/backtest-published.ts picks.psv > out.json
 *
 * Input: one pick per line, "league|home|away|bet|kickoff (New York wall time)|published at (UTC ISO)|win|loss|confidence".
 * Output (JSON lines): each pick, whether it matched a Kalshi market, the market, the ask/bid at publication,
 * and Kalshi's settlement. Strategy rules are applied afterwards (scripts/backtest-score.ts) so they can be
 * compared without re-downloading prices.
 */
import { readFileSync } from 'node:fs';
import { kalshiPrefixesFor, loadLeagueBook, setEventWindow } from '../src/kalshi/markets';
import { resolveSpec } from '../src/match/bets';
import { findEvent, findMarket, discoverPrefixes } from '../src/match/matcher';
import { wallTimeToUtc } from '../src/predictions/time';
import { publicGet } from '../src/kalshi/client';
import type { Prediction } from '../src/predictions/types';

const rows = readFileSync(process.argv[2]!, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => l.split('|'));
const preds = rows.map(([league, home, away, bet, ko, sent, res, pct, source], i) => ({
  source: source ?? 'pregame',
  p: { id: `${i}`, league: league!, home: home!, away: away!, bet: bet!, kickoff: wallTimeToUtc(ko!, 'America/New_York')!, statedPct: Number(pct), won: res === 'win', source: 'pregame' } as Prediction,
  sent: sent!, res: res!, pct: Number(pct),
}));
setEventWindow(Math.floor(Math.min(...preds.map((x) => Date.parse(x.p.kickoff))) / 1000) - 2 * 86_400);
const SUFFIX = { total: 'TOTAL', btts: 'BTTS', team_total: 'TEAMTOTAL', not_win: 'GAME' } as const;

for (const { p, sent, res, pct, source } of preds) {
  const out: Record<string, unknown> = { league: p.league, match: `${p.home} v ${p.away}`, bet: p.bet, kickoff: p.kickoff, sent, res, pct, source };
  const { spec } = resolveSpec(p.bet, p.canonical);
  if (!spec) { console.log(JSON.stringify({ ...out, miss: 'unsupported bet' })); continue; }
  out.side = spec.side;
  let prefixes = kalshiPrefixesFor(p.league);
  let found: any = null; let reason = prefixes.length ? 'no_event' : 'league_not_on_kalshi';
  const tryPrefixes = async (list: string[]) => {
    for (const prefix of list) {
      const book = await loadLeagueBook(prefix);
      const events = book.events[SUFFIX[spec.kind]];
      if (!events.length) { reason = `no ${SUFFIX[spec.kind]} markets for ${prefix}`; continue; }
      const { event } = findEvent(p, events);
      if (!event) continue;
      const market = findMarket(spec, p, event);
      if (!market) { reason = 'no_market'; continue; }
      return { event, market, prefix };
    }
    return null;
  };
  found = await tryPrefixes(prefixes);
  if (!found) { const more = await discoverPrefixes(p, prefixes).catch(() => []); if (more.length) found = await tryPrefixes(more.slice(0, 2)); }
  if (!found) { console.log(JSON.stringify({ ...out, miss: reason })); continue; }
  const m = found.market;
  const series = m.ticker.split('-')[0];
  const at = Math.floor(Date.parse(sent) / 1000);
  let ask: number | null = null, bid: number | null = null, priceAgeMin: number | null = null;
  try {
    const c = await publicGet(`/series/${series}/markets/${m.ticker}/candlesticks`, { start_ts: at - 3 * 3600, end_ts: at + 120, period_interval: 1 });
    const q = ((c.candlesticks ?? []) as any[]).map((x) => [x.end_period_ts, parseFloat(x.yes_ask?.close_dollars), parseFloat(x.yes_bid?.close_dollars)] as const)
      .filter((x) => x[1] > 0 && x[1] < 1);
    const last = q.filter((x) => x[0] <= at + 60).pop() ?? q[0];
    if (last) { ask = last[1]; bid = last[2]; priceAgeMin = Math.round((at - last[0]) / 60); }
  } catch {}
  console.log(JSON.stringify({ ...out, ticker: m.ticker, title: m.yes_sub_title ?? m.title, ask, bid, priceAgeMin, kalshi: m.result ?? null, minutesToKickoff: Math.round((Date.parse(p.kickoff) - Date.parse(sent)) / 60000) }));
}
