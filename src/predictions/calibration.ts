/**
 * Turn a source's stated confidence into a probability you can trade on.
 *
 * Stated confidence is often a class label rather than a per-match probability
 * (every pick of one bet type can state the same number whatever the match). Trading on the
 * stated number would size bets against an edge that isn't there. So by default
 * the probability for a bet type is its historical hit rate, with a light prior
 * so a small sample can't produce an extreme number.
 */
import type { Calibration } from '../config';
import type { Prediction } from './types';
import snapshot from '../../data/calibration.json';

export interface BetCalibration {
  bet: string;
  graded: number;
  wins: number;
  /** Posterior mean hit rate, Beta(1,1) prior. */
  probability: number;
  /** Standard error of that hit rate: how far off it could plausibly be. */
  stdErr: number;
  avgStatedPct: number | null;
  /** combined = bundled snapshot plus picks graded since it was taken. */
  source: 'history' | 'snapshot' | 'combined';
}

export function stdErr(p: number, n: number): number {
  return n > 0 ? Math.sqrt((p * (1 - p)) / n) : 1;
}

/** Below this many graded picks a bet type is not traded under hit-rate calibration. */
export const MIN_GRADED = 30;

export function calibrationFromHistory(history: Prediction[]): Map<string, BetCalibration> {
  const acc = new Map<string, { n: number; w: number; pctSum: number }>();
  for (const p of history) {
    if (p.won == null) continue;
    // Pre-game prices are judged on pre-game results only; live picks are a different bet.
    if (p.source && p.source.toLowerCase() !== 'pregame') continue;
    const a = acc.get(p.bet) ?? { n: 0, w: 0, pctSum: 0 };
    a.n++;
    if (p.won) a.w++;
    a.pctSum += p.statedPct;
    acc.set(p.bet, a);
  }
  const out = new Map<string, BetCalibration>();
  for (const [bet, a] of acc) {
    out.set(bet, {
      bet,
      graded: a.n,
      wins: a.w,
      probability: (a.w + 1) / (a.n + 2),
      stdErr: stdErr((a.w + 1) / (a.n + 2), a.n),
      avgStatedPct: a.pctSum / a.n,
      source: 'history',
    });
  }
  return out;
}

export function snapshotCalibration(): Map<string, BetCalibration> {
  const out = new Map<string, BetCalibration>();
  for (const row of (snapshot as { bets: { bet: string; graded: number; wins: number; avgStatedPct: number }[] }).bets) {
    out.set(row.bet, {
      bet: row.bet,
      graded: row.graded,
      wins: row.wins,
      probability: (row.wins + 1) / (row.graded + 2),
      stdErr: stdErr((row.wins + 1) / (row.graded + 2), row.graded),
      avgStatedPct: row.avgStatedPct,
      source: 'snapshot',
    });
  }
  return out;
}

/**
 * Prefer live history from the feed when it has enough graded picks for a bet type;
 * otherwise fall back to the bundled snapshot.
 */
/** Prefix for hit rates that apply to model-only picks (posted:false). */
export const MODEL_PREFIX = 'model:';

function overlay(base: Map<string, BetCalibration>, history: Prediction[], prefix = ''): Map<string, BetCalibration> {
  const out = new Map([...base].map(([k, v]) => [prefix + k, { ...v, bet: prefix + k }] as const));
  for (const [bet, c] of calibrationFromHistory(history)) {
    const key = prefix + bet;
    if (c.graded >= MIN_GRADED || !out.has(key)) out.set(key, { ...c, bet: key });
  }
  return out;
}

/** Kickoffs after this were not in the bundled snapshot. */
export const SNAPSHOT_THROUGH = Date.parse(`${(snapshot as { asOf: string }).asOf}T23:59:59-04:00`);

/**
 * Snapshot plus picks graded since it was taken (kickoff after the snapshot date), so a
 * few dozen fresh results add to the bundled record instead of replacing it.
 */
function combine(base: Map<string, BetCalibration>, history: Prediction[], prefix: string): Map<string, BetCalibration> {
  const out = new Map([...base].map(([k, v]) => [prefix + k, { ...v, bet: prefix + k }] as const));
  const fresh = calibrationFromHistory(history.filter((p) => Date.parse(p.kickoff) > SNAPSHOT_THROUGH));
  for (const [bet, c] of fresh) {
    const key = prefix + bet;
    const s = out.get(key);
    if (!s) { out.set(key, { ...c, bet: key }); continue; }
    const n = s.graded + c.graded, w = s.wins + c.wins;
    const stated = s.avgStatedPct != null && c.avgStatedPct != null ? (s.avgStatedPct * s.graded + c.avgStatedPct * c.graded) / n : s.avgStatedPct ?? c.avgStatedPct;
    const p = (w + 1) / (n + 2);
    out.set(key, { bet: key, graded: n, wins: w, probability: p, stdErr: stdErr(p, n), avgStatedPct: stated, source: 'combined' });
  }
  return out;
}

/**
 * Two sets of hit rates:
 *  - "T+1.5": for posted picks, from graded posted picks (PredyGo's best).
 *  - "model:T+1.5": for model-only picks, from the full graded list when the results
 *    feed includes it, otherwise the bundled snapshot (measured on the full list).
 * Live history replaces the snapshot once a bet type has MIN_GRADED graded picks.
 */
export function buildCalibration(history: Prediction[]): Map<string, BetCalibration> {
  const snap = snapshotCalibration();
  const graded = history.filter((p) => p.won != null);
  const hasFullList = graded.some((p) => p.posted === false);
  const posted = overlay(snap, graded.filter((p) => p.posted !== false));
  // The snapshot was measured on the full list, so model picks extend it with newer results.
  const model = hasFullList ? combine(snap, graded, MODEL_PREFIX) : overlay(snap, [], MODEL_PREFIX);
  return new Map([...posted, ...model]);
}

/** Display name for a calibration key ("model:T+1.5" -> "T+1.5 (model picks)"). */
export function calibrationLabel(key: string): string {
  return key.startsWith(MODEL_PREFIX) ? `${key.slice(MODEL_PREFIX.length)} (model picks)` : key;
}

export interface ProbabilityResult {
  probability: number | null;
  reason?: string;
  calibration?: BetCalibration;
}

export function probabilityFor(
  p: Prediction,
  mode: Calibration,
  table: Map<string, BetCalibration>,
): ProbabilityResult {
  if (mode === 'stated') {
    if (!Number.isFinite(p.statedPct)) return { probability: null, reason: 'no stated confidence' };
    return { probability: Math.min(Math.max(p.statedPct / 100, 0), 1) };
  }
  // Model-only picks get the full list's hit rate, never the posted picks' (higher) one.
  const c = p.posted === false ? table.get(MODEL_PREFIX + p.bet) : table.get(p.bet);
  if (!c) return { probability: null, reason: `no track record for ${p.bet}${p.posted === false ? ' (model picks)' : ''}` };
  if (c.graded < MIN_GRADED) {
    return { probability: null, reason: `only ${c.graded} graded ${p.bet} picks (need ${MIN_GRADED})`, calibration: c };
  }
  return { probability: c.probability, calibration: c };
}

// ---------------------------------------------------------------- live picks

/** Stages of a game for live picks: minutes since kickoff, wall clock (half-time included). */
export const LIVE_STAGES = [
  { upToMin: 70, label: 'up to 70 min after kickoff' },
  { upToMin: 90, label: '70-90 min after kickoff' },
  { upToMin: Infinity, label: '90+ min after kickoff' },
] as const;

/** Graded live picks from the results feed, by bet code and stage: wins / graded. */
let liveRates = new Map<string, { wins: number; graded: number }>();
const liveKey = (bet: string, stage: number) => `${bet.trim().toUpperCase()}|${stage}`;
export const liveStageOf = (minutes: number) => LIVE_STAGES.findIndex((s) => minutes < s.upToMin);

/** Record the graded live picks in the latest results feed (called on every feed load). */
export function setLiveHistory(history: Prediction[]): void {
  const next = new Map<string, { wins: number; graded: number }>();
  for (const p of history) {
    if (p.won == null || !p.source || p.source.toLowerCase() === 'pregame' || !p.pickedAt) continue;
    const mins = (Date.parse(p.pickedAt) - Date.parse(p.kickoff)) / 60_000;
    if (!Number.isFinite(mins) || mins < -5) continue;
    const k = liveKey(p.bet, liveStageOf(Math.max(0, mins)));
    const a = next.get(k) ?? { wins: 0, graded: 0 };
    a.graded++; if (p.won) a.wins++;
    next.set(k, a);
  }
  liveRates = next;
}

/** This bet type's own live record at this stage, once it has at least MIN_GRADED graded picks. */
export function liveRateFor(bet: string, minutes: number): { wins: number; graded: number } | null {
  const r = liveRates.get(liveKey(bet, liveStageOf(minutes)));
  return r && r.graded >= MIN_GRADED ? r : null;
}

/** All live picks' record at this stage (every bet type together), once it has MIN_GRADED graded picks. */
export function liveStageRecord(minutes: number): { wins: number; graded: number } | null {
  const st = liveStageOf(minutes);
  let wins = 0, graded = 0;
  for (const [k, r] of liveRates) if (k.endsWith(`|${st}`)) { wins += r.wins; graded += r.graded; }
  return graded >= MIN_GRADED ? { wins, graded } : null;
}

/** Each stage of the game with all live picks' record from the results feed. */
export function liveStagesSummary(): { label: string; graded: number; wins: number }[] {
  return LIVE_STAGES.map((s, i) => {
    let wins = 0, graded = 0;
    for (const [k, r] of liveRates) if (k.endsWith(`|${i}`)) { wins += r.wins; graded += r.graded; }
    return { label: s.label, graded, wins };
  });
}

/** Live record per bet type and stage, for diagnostics. */
export function liveRatesSummary(): { bet: string; stage: string; wins: number; graded: number; used: boolean }[] {
  return [...liveRates].map(([k, r]) => { const [bet, st] = k.split('|'); return { bet: bet!, stage: LIVE_STAGES[+st!]!.label, ...r, used: r.graded >= MIN_GRADED }; })
    .sort((a, b) => a.bet.localeCompare(b.bet) || a.stage.localeCompare(b.stage));
}
