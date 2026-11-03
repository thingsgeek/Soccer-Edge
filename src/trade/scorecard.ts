/**
 * Profit scorecard: settled trades (won, lost, sold) grouped by what they were, so it's plain
 * what makes money and what doesn't. Shown on the page.
 */
export interface ScoreRow { status: string; cost: number; pnl: number | null; bet: string | null; league: string | null; paid: number; source: string; entry?: string; at: string }

export interface ScoreLine { key: string; trades: number; won: number; lost: number; sold: number; staked: number; pnl: number; roi: number }

export interface Scorecard {
  overall: ScoreLine;
  last7: ScoreLine;
  byBet: ScoreLine[];
  byLeague: ScoreLine[];
  byPrice: ScoreLine[];
  bySource: ScoreLine[];
  byEntry: ScoreLine[];
}

export function priceBand(paid: number): string {
  const c = Math.round(paid * 100);
  return c < 60 ? 'under 60¢' : c < 70 ? '60-69¢' : c < 80 ? '70-79¢' : c < 90 ? '80-89¢' : '90¢+';
}

const ENTRY: Record<string, string> = { ask: 'bought at the ask', resting: 'waited at our price', claude: 'placed by Claude' };

function line(key: string, rows: ScoreRow[]): ScoreLine {
  const staked = rows.reduce((a, r) => a + (r.cost || 0), 0);
  const pnl = rows.reduce((a, r) => a + (r.pnl ?? 0), 0);
  return {
    key, trades: rows.length,
    won: rows.filter((r) => r.status === 'won').length,
    lost: rows.filter((r) => r.status === 'lost').length,
    sold: rows.filter((r) => r.status === 'sold').length,
    staked: +staked.toFixed(2), pnl: +pnl.toFixed(2), roi: staked > 0 ? +(pnl / staked).toFixed(4) : 0,
  };
}

function group(rows: ScoreRow[], keyOf: (r: ScoreRow) => string): ScoreLine[] {
  const m = new Map<string, ScoreRow[]>();
  for (const r of rows) { const k = keyOf(r); m.set(k, [...(m.get(k) ?? []), r]); }
  return [...m.entries()].map(([k, rs]) => line(k, rs)).sort((a, b) => b.trades - a.trades || b.pnl - a.pnl);
}

export function scorecard(all: ScoreRow[], nowMs = Date.now()): Scorecard {
  const settled = all.filter((r) => r.status === 'won' || r.status === 'lost' || r.status === 'sold');
  return {
    overall: line('all trades', settled),
    last7: line('last 7 days', settled.filter((r) => Date.parse(r.at) >= nowMs - 7 * 86400e3)),
    byBet: group(settled, (r) => r.bet ?? 'unknown'),
    byLeague: group(settled, (r) => r.league ?? 'unknown'),
    byPrice: group(settled, (r) => priceBand(r.paid)),
    bySource: group(settled, (r) => r.source === 'live' ? 'live' : r.source === 'forced' ? 'placed anyway' : 'pre-game'),
    byEntry: group(settled, (r) => ENTRY[r.entry ?? 'ask'] ?? 'bought at the ask'),
  };
}
