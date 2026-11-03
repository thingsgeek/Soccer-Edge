/**
 * Would "buy at our price" have filled, and paid? For each published pick in priced.jsonl:
 * bid at what the app's rules say it's worth (planRest), from publication until 15 min before
 * kickoff, and count a fill when Kalshi's YES ask (or NO ask) came down to the bid in a 1-minute
 * candle. Compares with buying at the ask when the ask already passed.
 *   bun run scripts/backtest-resting.ts priced.jsonl [minEdge] [uncertainty]
 */
import { readFileSync } from 'node:fs';
import { evaluate, planRest } from '../src/trade/edge';
import { DEFAULT_CONFIG } from '../src/config';
import { resolveSpec } from '../src/match/bets';
import { publicGet } from '../src/kalshi/client';

const rows = readFileSync(process.argv[2]!, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.ask != null && r.minutesToKickoff >= 20);
const minEdge = Number(process.argv[3] ?? DEFAULT_CONFIG.risk.minEdge), unc = Number(process.argv[4] ?? 1);
const risk = { ...DEFAULT_CONFIG.risk, minEdge, edgeUncertainty: unc, autoSize: false, maxNotionalPerOrder: 5, maxOpenExposurePct: 1, minWinProfit: 0 };
const won = (r: any) => (r.kalshi === 'yes' || r.kalshi === 'no' ? r.kalshi === r.side : r.res === 'win');
// Hit rates by bet type from the input itself (in-sample).
const hit: Record<string, [number, number]> = {};
for (const r of rows) { const a = (hit[r.bet] ??= [0, 0]); a[1]++; if (won(r)) a[0]++; }
const tot = { take: { n: 0, w: 0, cost: 0, pnl: 0 }, rest: { n: 0, w: 0, cost: 0, pnl: 0 }, restUnfilled: 0, none: 0 };
for (const r of rows) {
  const [w, n] = hit[r.bet] ?? [0, 0];
  if (!n) continue;
  const p = (w + 1) / (n + 2), se = Math.sqrt(p * (1 - p) / n);
  const spec = resolveSpec(r.bet).spec!;
  const mk = (ask: number, bid: number) => ({ ok: true, prediction: { id: r.match, bet: r.bet, league: r.league, kickoff: r.kickoff, statedPct: r.pct }, spec, event: {}, side: r.side,
    market: { ticker: r.ticker, status: 'active', yes_ask_dollars: (r.side === 'yes' ? ask : 1 - bid).toFixed(4), yes_bid_dollars: (r.side === 'yes' ? bid : 1 - ask).toFixed(4), no_ask_dollars: (r.side === 'yes' ? 1 - bid : ask).toFixed(4) } }) as any;
  const ctx = { bankroll: 57, dailyRemaining: Infinity, minutesToKickoff: r.minutesToKickoff, probabilityStdErr: se, statedProbability: r.pct / 100 };
  const m = mk(r.ask, r.bid ?? r.ask - 0.01);
  const take = evaluate(m, p, risk, ctx);
  if (take && !take.skip && take.contracts > 0) {
    tot.take.n++; const c = take.contracts * take.cost; tot.take.cost += c; if (won(r)) tot.take.w++; tot.take.pnl += (won(r) ? take.contracts : 0) - c;
    console.log(`TAKE ${r.match} ${r.bet} ask ${r.ask} ${won(r) ? 'won' : 'lost'}`);
    continue;
  }
  const plan = planRest(m, p, risk, ctx, r.kickoff);
  if (!plan) { tot.none++; continue; }
  // Price path from publication to 15 min before kickoff.
  const series = r.ticker.split('-')[0];
  const t0 = Math.floor(Date.parse(r.sent) / 1000), t1 = Math.floor(Date.parse(r.kickoff) / 1000) - 15 * 60;
  let lowAsk = Infinity;
  try {
    const c = await publicGet(`/series/${series}/markets/${r.ticker}/candlesticks`, { start_ts: t0, end_ts: t1, period_interval: 1 });
    for (const x of (c.candlesticks ?? []) as any[]) {
      // Our side's ask: YES ask, or 1 - YES bid for NO.
      const a = r.side === 'yes' ? parseFloat(x.yes_ask?.low_dollars ?? x.yes_ask?.close_dollars) : 1 - parseFloat(x.yes_bid?.high_dollars ?? x.yes_bid?.close_dollars);
      if (Number.isFinite(a)) lowAsk = Math.min(lowAsk, a);
    }
  } catch (e) { console.log('candles failed', r.ticker, String(e).slice(0, 80)); continue; }
  const px = plan.rest!.price;
  // Filled when the ask came down to our bid (we were first in line at bid+1c).
  if (lowAsk <= px + 1e-9) {
    tot.rest.n++; const c = plan.contracts * plan.cost; tot.rest.cost += c; if (won(r)) tot.rest.w++; tot.rest.pnl += (won(r) ? plan.contracts : 0) - c;
    console.log(`REST FILLED ${r.match} ${r.bet} bid ${px} (ask ${r.ask}, low ask ${lowAsk}) ${won(r) ? 'won' : 'lost'}`);
  } else { tot.restUnfilled++; console.log(`rest unfilled ${r.match} ${r.bet} bid ${px} (ask ${r.ask}, low ask ${lowAsk})`); }
  await Bun.sleep(150);
}
const f = (x: any) => `${x.n} trades, won ${x.n ? Math.round(100 * x.w / x.n) : 0}%, staked $${x.cost.toFixed(2)}, P/L $${x.pnl.toFixed(2)} (${x.cost ? (100 * x.pnl / x.cost).toFixed(0) : 0}%)`;
console.log(`\nminEdge ${minEdge}, uncertainty ${unc}\nBought at the ask: ${f(tot.take)}\nWaited at our price, filled: ${f(tot.rest)}\nWaited, never filled: ${tot.restUnfilled}\nNo price worth it: ${tot.none}`);
