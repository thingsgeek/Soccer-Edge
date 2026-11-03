/**
 * Score rule sets on the output of backtest-published.ts with the app's own decision code.
 *   bun run scripts/backtest-score.ts priced.jsonl
 */
import { readFileSync } from 'node:fs';
import { evaluate } from '../src/trade/edge';
import { DEFAULT_CONFIG, autoLimits } from '../src/config';
import { resolveSpec } from '../src/match/bets';

const rows = readFileSync(process.argv[2]!, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.ask != null);
const won = (r: any) => (r.kalshi === 'yes' || r.kalshi === 'no' ? r.kalshi === r.side : r.res === 'win');
// Hit rates from the input itself, by bet type and by confidence band (90%+ or below).
// (In-sample: fine for comparing rule sets with each other, optimistic as absolute numbers.)
const tally = (key: (r: any) => string) => { const m = new Map<string, [number, number]>(); for (const r of rows) { const k = key(r), a = m.get(k) ?? [0, 0]; a[1]++; if (won(r)) a[0]++; m.set(k, a); } return m; };
const byBet = tally((r) => r.bet), byBand = tally((r) => `${r.bet}|${Number(r.pct) >= 90 ? 'hi' : 'lo'}`);
const rate = (bet: string) => byBet.get(bet) ?? [0, 0];
const band = (bet: string, pct: number) => byBand.get(`${bet}|${pct >= 90 ? 'hi' : 'lo'}`) ?? rate(bet);
const pooled = (bet: string, pct: number, k = 20) => { const [w, n] = rate(bet), [bw, bn] = band(bet, pct); const p = (w + 1) / (n + 2); return { p: (bw + k * p) / (bn + k), n: bn + k }; };

function run(name: string, risk: any, probOf: (r: any) => { p: number; n: number }) {
  let n = 0, w = 0, cost = 0, pnl = 0; const reasons: Record<string, number> = {};
  for (const r of rows) {
    if (r.minutesToKickoff < 2) { reasons['published after kickoff'] = (reasons['published after kickoff'] ?? 0) + 1; continue; }
    const spec = resolveSpec(r.bet).spec!;
    const market: any = { ticker: r.ticker, status: 'active', yes_ask_dollars: r.ask.toFixed(4), yes_bid_dollars: (r.bid ?? r.ask - 0.01).toFixed(4), no_ask_dollars: (1 - (r.bid ?? r.ask - 0.01)).toFixed(4), no_bid_dollars: (1 - r.ask).toFixed(4) };
    const { p, n: graded } = probOf(r);
    const se = Math.sqrt(p * (1 - p) / graded);
    const prop = evaluate({ ok: true, prediction: { id: r.match, bet: r.bet, statedPct: r.pct } as any, spec, event: {} as any, market, side: spec.side } as any, p, risk,
      { bankroll: 57, dailyRemaining: 34, minutesToKickoff: r.minutesToKickoff, probabilityStdErr: se, statedProbability: r.pct / 100 })!;
    if (!prop || prop.skip || prop.contracts < 1) { const k = (prop?.skip ?? 'no price').replace(/[\d.]+/g, '#').slice(0, 40); reasons[k] = (reasons[k] ?? 0) + 1; continue; }
    n++; const c = prop.contracts * prop.cost; cost += c; const win = won(r); if (win) w++; pnl += (win ? prop.contracts : 0) - c;
  }
  console.log(`\n${name}\n  trades ${n}  won ${n ? Math.round(100 * w / n) : 0}%  staked $${cost.toFixed(2)}  P/L $${pnl.toFixed(2)} (${cost ? (100 * pnl / cost).toFixed(0) : 0}%)`);
  console.log('  skipped:', Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v}× ${k}`).join(' · '));
}
const base = { ...DEFAULT_CONFIG.risk, ...autoLimits(DEFAULT_CONFIG.risk, 57), minEdge: 0.03 };
const typeRate = (r: any) => { const [w, n] = rate(r.bet); return { p: (w + 1) / (n + 2), n }; };
run('A. Current settings (type hit rate, 30% market lean, 3% + 1x uncertainty)', base, typeRate);
run('B. Uncertainty 0.5x', { ...base, edgeUncertainty: 0.5 }, typeRate);
run('C. Uncertainty 0.5x, market lean 15%', { ...base, edgeUncertainty: 0.5, marketWeight: 0.15 }, typeRate);
run('D. Just "positive expected value" (no lean, no buffer, min edge 1%)', { ...base, edgeUncertainty: 0, marketWeight: 0, minEdge: 0.01 }, typeRate);
run('E. Current settings + confidence-level hit rates (pooled)', base, (r) => pooled(r.bet, r.pct));
run('F. Uncertainty 0.5x + confidence-level hit rates', { ...base, edgeUncertainty: 0.5 }, (r) => pooled(r.bet, r.pct));
run('G. Buy everything priced (for reference)', { ...base, edgeUncertainty: 0, marketWeight: 0, minEdge: -1, maxGapToMarket: 0, minProbability: 0, requireStatedAboveCost: false }, typeRate);
