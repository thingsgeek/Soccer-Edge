import { ruleOn } from './config';
/**
 * Predictions -> calibrated probabilities -> matched Kalshi markets -> sized proposals.
 * Read-only: nothing here places orders.
 */
import type { AppConfig } from './config';
import { loadPredictions } from './predictions/sources';
import type { Prediction } from './predictions/types';
import { buildCalibration, probabilityFor, type BetCalibration } from './predictions/calibration';
import { matchPrediction, type MatchResult } from './match/matcher';
import { kalshiPrefixesFor, loadLeagueBook } from './kalshi/markets';
import { effectiveKickoff, evaluate, planRest, priceSkip, type Proposal } from './trade/edge';

export interface ScanOptions {
  /** Only consider matches kicking off within this many hours. */
  horizonHours?: number;
  /** Bankroll to size against, dollars. Live balance is used when trading. */
  bankroll: number;
  dailyRemaining: number;
  /** Price of our own resting buy on this market, if any (so we don't bid against ourselves). */
  ownBid?: (ticker: string) => number | undefined;
  now?: Date;
}

export interface ScanResult {
  upcoming: Prediction[];
  results: MatchResult[];
  proposals: Proposal[];
  /** Matched but no probability (e.g. too little track record). */
  unpriced: { match: Extract<MatchResult, { ok: true }>; reason: string }[];
  calibration: Map<string, BetCalibration>;
  /** Graded picks from the results feed (for the trade journal's PredyGo outcome). */
  graded: Prediction[];
}

async function inBatches<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

export async function scan(cfg: AppConfig, opts: ScanOptions): Promise<ScanResult> {
  const now = opts.now ?? new Date();
  const horizon = (opts.horizonHours ?? 72) * 3600_000;
  const all = await loadPredictions(cfg.source);
  const calibration = buildCalibration(all);

  const upcoming = all.filter((p) => {
    const t = new Date(p.kickoff).getTime();
    return p.won == null && t > now.getTime() && (t - now.getTime() <= horizon || !ruleOn(cfg.risk, 'horizon'));
  });

  // Warm the market books for every league we need, a few at a time.
  const prefixes = [...new Set(upcoming.flatMap((p) => kalshiPrefixesFor(p.league)))];
  await inBatches(prefixes, 4, (p) => loadLeagueBook(p));

  const results = await inBatches(upcoming, 8, (p) => matchPrediction(p));

  const proposals: Proposal[] = [];
  const unpriced: ScanResult['unpriced'] = [];
  for (const r of results) {
    if (!r.ok) continue;
    const priced = priceMatch(r, cfg, calibration, opts, now);
    if (priced.proposal) proposals.push(priced.proposal);
    else unpriced.push({ match: r, reason: priced.reason });
  }
  proposals.sort((a, b) => b.edge - a.edge);
  return { upcoming, results, proposals, unpriced, calibration, graded: all.filter((p) => p.won != null) };
}

/** Price one matched pick exactly as a scan does. */
export function priceMatch(
  r: Extract<MatchResult, { ok: true }>,
  cfg: AppConfig,
  calibration: Map<string, BetCalibration>,
  opts: Pick<ScanOptions, 'bankroll' | 'dailyRemaining' | 'ownBid'>,
  now: Date,
): { proposal?: Proposal; reason: string; kickoffMs?: number; kickoffMismatch?: boolean; probabilitySource?: BetCalibration } {
  let prob = probabilityFor(r.prediction, cfg.calibration, calibration);
  // "Needs 30 graded results" switched off (the default): bet types without enough graded results trade on PredyGo's own number.
  if (prob.probability == null && !ruleOn(cfg.risk, 'hitRate') && Number.isFinite(r.prediction.statedPct)) prob = { ...prob, probability: Math.min(0.99, Math.max(0, r.prediction.statedPct / 100)) };
  if (prob.probability == null) return { reason: prob.reason ?? 'no probability', probabilitySource: prob.calibration };
  const ko = effectiveKickoff(r.prediction.kickoff, r.market);
  const sizing = {
    bankroll: opts.bankroll,
    dailyRemaining: opts.dailyRemaining,
    minutesToKickoff: (ko.kickoffMs - now.getTime()) / 60_000,
    kickoffMismatch: ko.mismatch,
    statedProbability: Number.isFinite(r.prediction.statedPct) ? r.prediction.statedPct / 100 : undefined,
    probabilityStdErr: cfg.calibration === 'hit-rate' ? prob.calibration?.stdErr : undefined,
  };
  let proposal = evaluate(r, prob.probability, cfg.risk, sizing);
  // Buy at our price: the ask is too high, but a buy order on the book at what the pick is
  // worth may fill (sellers come and go all day). It waits until minMinutesBeforeKickoff.
  if (proposal?.skip && priceSkip(proposal.skip) && cfg.risk.restOrders !== false && sizing.minutesToKickoff > cfg.risk.minMinutesBeforeKickoff + 1) {
    const expiresAt = new Date(ko.kickoffMs - cfg.risk.minMinutesBeforeKickoff * 60_000).toISOString();
    const plan = planRest(r, prob.probability, cfg.risk, sizing, expiresAt, opts.ownBid?.(r.market.ticker));
    if (plan) proposal = { ...plan, calibration: proposal.calibration };
  }
  if (proposal && prob.calibration) {
    const c = prob.calibration;
    proposal.calibration = { key: c.bet, graded: c.graded, wins: c.wins, hitRate: +c.probability.toFixed(4), stdErr: +c.stdErr.toFixed(4), statedAvg: c.avgStatedPct, source: c.source };
  }
  return {
    proposal: proposal ?? undefined,
    reason: proposal ? (proposal.skip ?? 'ready') : 'no ask price on Kalshi',
    kickoffMs: ko.kickoffMs,
    kickoffMismatch: ko.mismatch,
    probabilitySource: prob.calibration,
  };
}
