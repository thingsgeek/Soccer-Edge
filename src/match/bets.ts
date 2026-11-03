/**
 * Translate a source bet into the Kalshi contract that settles the same way.
 *
 * All Kalshi soccer contracts used here settle on 90 minutes plus stoppage time,
 * which is also how the PredyGo bets are graded.
 */
export type BetSpec =
  /** Total goals over `line`: YES on the "Over line" market (Under = NO on it). */
  | { kind: 'total'; line: number; side: 'yes' | 'no' }
  /** Both teams to score: YES (No = NO). */
  | { kind: 'btts'; side: 'yes' | 'no' }
  /** One team scores over `line`: YES on that team's market (Under = NO). */
  | { kind: 'team_total'; team: 'home' | 'away'; line: number; side: 'yes' | 'no' }
  /**
   * Double chance. "Home or draw" (1X) is the same outcome as "away does not win",
   * so it is a NO on the away-win market (and X2 a NO on the home-win market).
   */
  | { kind: 'not_win'; team: 'home' | 'away'; side: 'no' };

export function describeSpec(s: BetSpec): string {
  switch (s.kind) {
    case 'total': return s.side === 'yes' ? `Over ${s.line} goals (YES)` : `Under ${s.line} goals (NO on Over ${s.line})`;
    case 'btts': return s.side === 'yes' ? 'Both teams to score (YES)' : 'Both teams to score: No (NO)';
    case 'team_total': return `${s.team} team ${s.side === 'yes' ? 'over' : 'under'} ${s.line} goals (${s.side.toUpperCase()})`;
    case 'not_win': return `${s.team} team does not win (NO on ${s.team} win)`;
  }
}

/** Half-goal lines only: whole-number lines can push, and Kalshi has no push. */
const halfLine = (n: number) => Number.isFinite(n) && Math.abs(n * 2 - Math.round(n * 2)) < 1e-9 && !Number.isInteger(n);

export function parseBet(code: string): BetSpec | null {
  const c = code.trim().toUpperCase().replace(/\s+/g, ' ');
  let m = c.match(/^(?:T|TOTALGOALS|TOTAL|OVER|O)\s*\+?\s*(\d+(?:\.\d+)?)$/);
  if (m) {
    const line = parseFloat(m[1]!);
    return halfLine(line) ? { kind: 'total', line, side: 'yes' } : null;
  }
  if (c === 'BTTS' || c === 'GG' || c === 'BTTS YES') return { kind: 'btts', side: 'yes' };
  // "LOCAL MARCA" = home team scores; "VISITA MARCA" = away team scores.
  // "REG" variants come from a different PredyGo model but describe the same bet.
  if (/^LOCAL MARCA( REG)?$/.test(c) || c === 'HOME SCORES') return { kind: 'team_total', team: 'home', line: 0.5, side: 'yes' };
  if (/^VISITA MARCA( REG)?$/.test(c) || c === 'AWAY SCORES') return { kind: 'team_total', team: 'away', line: 0.5, side: 'yes' };
  if (c === '1X') return { kind: 'not_win', team: 'away', side: 'no' };
  if (c === 'X2') return { kind: 'not_win', team: 'home', side: 'no' };
  return null;
}

/**
 * PredyGo API's structured market definition, e.g.
 * { market: "team_totals", team: "away", name: "Over", point: 0.5 }.
 */
export interface CanonicalMarket {
  market?: string;
  team?: string;
  name?: string;
  point?: number | string;
}

export function parseCanonical(c: CanonicalMarket | null | undefined): BetSpec | null {
  if (!c || typeof c !== 'object') return null;
  const market = String(c.market ?? '').toLowerCase().replace(/[\s-]+/g, '_');
  const name = String(c.name ?? '').toLowerCase().trim();
  const point = Number(c.point);
  const team = String(c.team ?? '').toLowerCase();
  const t = team === 'home' || team === 'away' ? team : null;
  const side = name === 'over' || name === 'yes' ? 'yes' : name === 'under' || name === 'no' ? 'no' : null;

  if ((market === 'totals' || market === 'total' || market === 'total_goals') && side && halfLine(point)) {
    return { kind: 'total', line: point, side };
  }
  if ((market === 'team_totals' || market === 'team_total') && t && side && halfLine(point)) {
    return { kind: 'team_total', team: t, line: point, side };
  }
  if ((market === 'btts' || market === 'both_teams_to_score') && side) return { kind: 'btts', side };
  if (market === 'double_chance' || market === 'doublechance') {
    const n = name.replace(/\s+/g, '');
    if (['1x', 'home/draw', 'homeordraw', 'home_draw'].includes(n)) return { kind: 'not_win', team: 'away', side: 'no' };
    if (['x2', 'draw/away', 'draworaway', 'draw_away'].includes(n)) return { kind: 'not_win', team: 'home', side: 'no' };
  }
  return null;
}

export function sameSpec(a: BetSpec, b: BetSpec): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The bet code mapping is verified against Kalshi settlements; the canonical
 * definition covers codes we don't know. If both exist and disagree, refuse.
 */
export function resolveSpec(code: string, canonical?: CanonicalMarket | null): { spec: BetSpec | null; conflict?: boolean } {
  const fromCode = parseBet(code);
  const fromCanon = parseCanonical(canonical);
  if (fromCode && fromCanon && !sameSpec(fromCode, fromCanon)) return { spec: null, conflict: true };
  return { spec: fromCode ?? fromCanon };
}
