/**
 * Replay graded past predictions against Kalshi's settled markets.
 *
 * For every pick we can match, Kalshi's settlement should agree with the source's
 * grading: if the pick won, the contract side we'd have bought must have settled
 * in our favor. Any disagreement means a mapping bug (wrong team, wrong line, wrong
 * side) and must be fixed before trading.
 *
 *   bun run scripts/replay.ts your-graded-picks.csv   (a CSV or JSON export of your own graded picks)
 */
import { readFileSync } from 'node:fs';
import { loadPredictions } from '../src/predictions/sources';
import { kalshiPrefixesFor, loadLeagueBook, setEventWindow } from '../src/kalshi/markets';
import { resolveSpec } from '../src/match/bets';
import { findEvent, findMarket } from '../src/match/matcher';

const path = process.argv[2];
if (!path) throw new Error('usage: bun run scripts/replay.ts <predictions.csv|json>');
readFileSync(path); // fail early if missing

const preds = await loadPredictions({ type: 'file', path });
const earliest = Math.min(...preds.map((p) => new Date(p.kickoff).getTime()));
setEventWindow(Math.floor(earliest / 1000) - 86_400);

const SUFFIX = { total: 'TOTAL', btts: 'BTTS', team_total: 'TEAMTOTAL', not_win: 'GAME' } as const;
let matched = 0, agree = 0, disagree = 0, unsettled = 0;
const misses: string[] = [];
const problems: string[] = [];

for (const p of preds) {
  const spec = resolveSpec(p.bet, p.canonical).spec;
  const prefixes = kalshiPrefixesFor(p.league);
  if (!spec || prefixes.length === 0) { misses.push(`${p.league} | ${p.home} v ${p.away} | ${p.bet} | ${!spec ? 'unsupported bet' : 'league unmapped'}`); continue; }
  let hit = false;
  for (const prefix of prefixes) {
    const book = await loadLeagueBook(prefix);
    const events = book.events[SUFFIX[spec.kind]];
    const { event, reason } = findEvent(p, events);
    if (!event) { misses.push(`${p.league} | ${p.home} v ${p.away} | ${p.bet} | ${reason} (${events.length} ${prefix}${SUFFIX[spec.kind]} events loaded)`); continue; }
    const market = findMarket(spec, p, event);
    if (!market) { misses.push(`${p.league} | ${p.home} v ${p.away} | ${p.bet} | no market in ${event.event_ticker}`); continue; }
    hit = true;
    matched++;
    const res = market.result;
    if (res !== 'yes' && res !== 'no') { unsettled++; break; }
    const ourSideWon = res === spec.side;
    const line = `${p.home} v ${p.away} | ${p.bet} -> ${spec.side.toUpperCase()} ${market.ticker} | Kalshi=${res} PredyGo=${p.won ? 'won' : 'lost'}`;
    if (p.won == null) { unsettled++; }
    else if (ourSideWon === p.won) { agree++; }
    else { disagree++; problems.push(line); }
    break;
  }
  void hit;
}

console.log(`Predictions: ${preds.length}`);
console.log(`Matched to a Kalshi market: ${matched}`);
console.log(`Settlement agrees with PredyGo grading: ${agree}`);
console.log(`Settlement DISAGREES: ${disagree}`);
console.log(`Not yet settled / ungraded: ${unsettled}`);
if (problems.length) { console.log('\nDisagreements:'); for (const l of problems) console.log('  ' + l); }
if (misses.length) { console.log('\nNot matched:'); for (const l of misses) console.log('  ' + l); }
