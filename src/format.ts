import type { MatchResult } from './match/matcher';
import type { Proposal } from './trade/edge';
import { describeSpec } from './match/bets';

export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) => cells.map((c, i) => (c ?? '').padEnd(widths[i]!)).join('  ');
  return [line(headers), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n');
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const usd = (x: number) => `$${x.toFixed(2)}`;

export function kickoffLocal(iso: string): string {
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function proposalRows(ps: Proposal[]): string[][] {
  return ps.map((p) => [
    kickoffLocal(p.match.prediction.kickoff),
    `${p.match.prediction.home} v ${p.match.prediction.away}`,
    p.match.prediction.bet,
    `${p.match.side.toUpperCase()} ${p.match.market.ticker}`,
    pct(p.probability),
    usd(p.quote.ask),
    (p.edge >= 0 ? '+' : '') + pct(p.edge),
    p.skip ? '-' : `${p.contracts} (${usd(p.notional)})`,
    p.skip ?? 'TRADE',
  ]);
}

export const PROPOSAL_HEADERS = ['Kickoff', 'Match', 'Pick', 'Kalshi contract', 'Prob', 'Ask', 'Edge', 'Size', 'Status'];

export function describeProposal(p: Proposal): string {
  const pr = p.match.prediction;
  return [
    `${pr.home} v ${pr.away} (${pr.league}), ${kickoffLocal(pr.kickoff)}`,
    `  Pick: ${pr.bet} -> ${describeSpec(p.match.spec)}`,
    `  Contract: ${p.match.market.title} [${p.match.market.ticker}]`,
    `  Buy ${p.contracts} x ${p.match.side.toUpperCase()} at up to ${usd(p.quote.ask)} = ${usd(p.notional)} (+ ~${usd(p.contracts * (p.cost - p.quote.ask))} fees)`,
    `  Calibrated probability ${pct(p.probability)} vs cost ${pct(p.cost)} -> edge ${pct(p.edge)}`,
  ].join('\n');
}

export function failureLabel(r: Extract<MatchResult, { ok: false }>): string {
  switch (r.reason) {
    case 'unsupported_bet': return 'bet type has no Kalshi equivalent';
    case 'live_pick': return 'in-play pick (not traded)';
    case 'league_not_on_kalshi': return 'league not mapped to Kalshi';
    case 'market_type_not_offered': return 'Kalshi has no markets of this type in this league right now';
    case 'no_event': return 'no Kalshi market for this match';
    case 'ambiguous_event': return 'team names matched more than one game';
    case 'no_market': return 'game found, but not this line';
    case 'market_not_active': {
      const m = r.market;
      if (m && (m.result === 'yes' || m.result === 'no' || /^(finalized|settled|determined)$/.test(m.status ?? ''))) return `already decided on Kalshi${m.result ? `: ${m.result.toUpperCase()}` : ''}`;
      return `market ${m?.status ?? 'not open'} on Kalshi`;
    }
  }
}
