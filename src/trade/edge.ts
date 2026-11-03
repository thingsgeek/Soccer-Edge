/**
 * Price a matched prediction, compute edge after fees, and size with fractional Kelly.
 */
import { parseBet } from '../match/bets';
import { ruleOn, type RiskConfig } from '../config';
import { dollars, type KalshiMarket } from '../kalshi/types';
import type { MatchResult } from '../match/matcher';

/** Kalshi's general trading fee: 0.07 x contracts x P x (1 - P), rounded up per order. */
export const FEE_RATE = 0.07;

export function feePerContract(price: number): number {
  return FEE_RATE * price * (1 - price);
}

/** Fee for a whole order, rounded up to the cent as Kalshi charges it. */
export function orderFee(contracts: number, price: number): number {
  return Math.ceil(FEE_RATE * contracts * price * (1 - price) * 100 - 1e-9) / 100;
}

/**
 * Resting (maker) orders pay about a quarter of the taker fee on Kalshi: 1.75% x P x (1 - P)
 * when filled, nothing to cancel (rivermarkets.com Kalshi fee guide, Aug 2026).
 */
export const MAKER_FEE_RATE = 0.0175;
export function makerFeePerContract(price: number): number {
  return MAKER_FEE_RATE * price * (1 - price);
}
export function makerOrderFee(contracts: number, price: number): number {
  return Math.ceil(MAKER_FEE_RATE * contracts * price * (1 - price) * 100 - 1e-9) / 100;
}

const H = 3600_000;
/**
 * Kalshi soccer schedule fields, measured on 58 matched games (Oct 2026):
 *  - occurrence_datetime = kickoff + 3h or + 4h depending on the league (rarely + 2h);
 *  - before kickoff, close_time = scheduled kickoff + 48h.
 */
const SETTLE_MIN_MS = 1.9 * H;
const SETTLE_MAX_MS = 4.25 * H;
const CLOSE_AFTER_KICKOFF_MS = 48 * H;
const MAX_KICKOFF_DISAGREEMENT_MS = 45 * 60_000;
/** Settlement offsets seen in practice (kickoff + 2h / 3h / 4h), and how far off one may be. */
const SETTLE_OFFSETS_MS = [2 * H, 3 * H, 4 * H];
const OFFSET_TOLERANCE_MS = 15 * 60_000;

/**
 * Kickoff used for the "too close to kickoff" guard, cross-checked against Kalshi's schedule.
 * Returns the earliest plausible kickoff and flags a feed time that disagrees (wrong time
 * zone, rescheduled game).
 */
export function effectiveKickoff(feedKickoffIso: string, m: KalshiMarket): { kickoffMs: number; mismatch: boolean } {
  const feed = new Date(feedKickoffIso).getTime();
  const occ = new Date(m.occurrence_datetime ?? m.expected_expiration_time ?? NaN).getTime();
  if (!Number.isFinite(occ)) return { kickoffMs: feed, mismatch: false };

  // Precise: close_time - 48h, when it is consistent with the settlement time.
  const fromClose = new Date(m.close_time ?? NaN).getTime() - CLOSE_AFTER_KICKOFF_MS;
  if (Number.isFinite(fromClose) && occ - fromClose >= SETTLE_MIN_MS && occ - fromClose <= SETTLE_MAX_MS) {
    return { kickoffMs: Math.min(feed, fromClose), mismatch: Math.abs(feed - fromClose) > MAX_KICKOFF_DISAGREEMENT_MS };
  }
  // close_time doesn't follow the 48h rule for every league (MLS: +54h). Then trust the feed
  // time when the settlement time sits a standard offset after it (e.g. MLS: kickoff + 3h).
  if (SETTLE_OFFSETS_MS.some((o) => Math.abs(occ - feed - o) <= OFFSET_TOLERANCE_MS)) return { kickoffMs: feed, mismatch: false };
  // Otherwise only a range is known: kickoff is between occ - 4.25h and occ - 1.9h. Assume the earliest.
  const earliest = occ - SETTLE_MAX_MS;
  const latest = occ - SETTLE_MIN_MS;
  const mismatch = feed < earliest - MAX_KICKOFF_DISAGREEMENT_MS || feed > latest + MAX_KICKOFF_DISAGREEMENT_MS;
  return { kickoffMs: Math.min(feed, earliest), mismatch };
}

export interface Quote {
  /** Price to buy the side we want, dollars. */
  ask: number;
  /** Best bid on the same side, dollars. */
  bid: number;
  spreadCents: number;
}

export function quoteFor(m: KalshiMarket, side: 'yes' | 'no'): Quote | null {
  const ask = dollars(side === 'yes' ? m.yes_ask_dollars : m.no_ask_dollars);
  // The NO bid is the complement of the YES ask, and vice versa.
  const bid = side === 'yes' ? dollars(m.yes_bid_dollars) : 1 - dollars(m.yes_ask_dollars);
  if (!Number.isFinite(ask) || ask <= 0 || ask >= 1) return null;
  const spreadCents = Number.isFinite(bid) ? Math.round((ask - bid) * 100) : 99;
  return { ask, bid, spreadCents };
}

export interface Proposal {
  match: Extract<MatchResult, { ok: true }>;
  probability: number;
  /** Win chance after leaning toward the market price (what edge is measured from). */
  priced?: number;
  quote: Quote;
  /** Ask plus estimated fee, per contract. */
  cost: number;
  /** probability - cost. */
  edge: number;
  /** Full-Kelly fraction of bankroll. */
  kelly: number;
  contracts: number;
  /** Edge this pick needs to be traded. */
  required?: number;
  /** Dollars at risk = contracts x ask (fee excluded). */
  notional: number;
  skip?: string;
  /** The skip is a safety rule that "Place anyway" cannot override (game started, kickoff unclear, daily cap). */
  hard?: boolean;
  /**
   * Buy at our price: the ask is too high, so a buy order waits on the book at `price`
   * (the best bid + 1c, never above `maxPay`, the most this pick is worth after the maker fee)
   * until `expiresAt`. quote.ask / cost / edge above are for that price.
   */
  rest?: { price: number; maxPay: number; askNow: number; bidNow: number; expiresAt: string };
  /** Where the win chance came from (hit-rate table row), for the trade journal. */
  calibration?: { key: string; graded: number; wins: number; hitRate: number; stdErr: number; statedAvg: number | null; source: string };
  /** Live picks: stage of the game, score and odds at pick time, for the trade journal. */
  liveInfo?: Record<string, unknown>;
  /** What the probability rests on, kept so the pick can be re-priced at order time. */
  inputs?: Pick<SizingContext, 'probabilityStdErr' | 'statedProbability'>;
}

export interface SizingContext {
  /** Cash available to trade, dollars. */
  bankroll: number;
  /** Dollars still allowed today under maxDailySpend. */
  dailyRemaining: number;
  /** Minutes until kickoff. */
  minutesToKickoff: number;
  /** Feed kickoff and Kalshi's schedule disagree. */
  kickoffMismatch?: boolean;
  /** Source's stated confidence 0-1, checked when risk.requireStatedAboveCost is on. */
  statedProbability?: number;
  /** Standard error of the probability estimate (from the hit-rate sample). */
  probabilityStdErr?: number;
  /** In-play pick: cheap prices are normal during a game, so the market-gap check is skipped. */
  live?: boolean;
  /**
   * Price a resting buy at this price instead of taking the ask: maker fee, the market's real
   * mid for the lean, no spread rule (the order sits inside the spread).
   */
  restAt?: number;
}

/** A percentage below a threshold, with a decimal when whole numbers would read "65% < 65%". */
export function pctBelow(v: number, floor: number): string {
  return Math.round(v * 100) >= Math.round(floor * 100) ? `${(Math.floor(v * 1000) / 10).toFixed(1)}%` : `${Math.round(v * 100)}%`;
}

/** Edge needed for this pick: base minimum plus a buffer for how uncertain the probability is. */
export function requiredEdge(risk: RiskConfig, probabilityStdErr?: number): number {
  const se = probabilityStdErr ?? 0.03; // stated-confidence mode: no sample size, assume ±3 points
  return risk.minEdge + Math.max(0, risk.edgeUncertainty ?? 0) * se;
}

/** Bet types turned off in Settings (Over 2.5 goals, BTTS). Returns the skip reason, or null. */
export function blockedBet(bet: string, risk: Pick<RiskConfig, 'blockOver25' | 'blockBtts'>): string | null {
  // By meaning, not spelling: PredyGo sends Over 2.5 as both "TOTALGOALS+2.5" and "T+2.5".
  const s = parseBet(bet);
  if (risk.blockOver25 !== false && s?.kind === 'total' && s.line === 2.5 && s.side === 'yes') return 'Over 2.5 goals picks are turned off in Settings';
  if (risk.blockBtts !== false && s?.kind === 'btts' && s.side === 'yes') return 'BTTS picks are turned off in Settings';
  return null;
}

/** A pause that covers this pick right now, or null. */
export function activePause(pred: { bet: string; league: string }, risk: Pick<RiskConfig, 'paused'>, nowMs = Date.now()): string | null {
  const norm = (x: string) => x.trim().toUpperCase().replace(/\s+/g, ' ');
  for (const r of risk.paused ?? []) {
    if (!(Date.parse(r.until) > nowMs)) continue;
    const v = r.kind === 'bet' ? pred.bet : pred.league;
    if (v && norm(v) === norm(r.value)) {
      const until = new Date(r.until).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      return `${r.kind === 'bet' ? r.value : r.value} paused by ${r.by === 'claude' ? 'Claude' : 'you'} until ${until}: ${r.reason}`;
    }
  }
  return null;
}

/** Profit (after the fee) if `contracts` bought at `price` win. */
export function winProfit(contracts: number, price: number): number {
  return contracts * (1 - price) - orderFee(contracts, price);
}

/** Fewest contracts that stand to win at least `minProfit` at this price. */
export function minContractsFor(price: number, minProfit: number | undefined): number {
  if (!minProfit || minProfit <= 0 || price >= 1) return 1;
  let n = Math.max(1, Math.ceil(minProfit / (1 - price)));
  while (winProfit(n, price) < minProfit - 1e-9 && n < 10_000) n++;
  return n;
}

/** "Place anyway" is never allowed this close to kickoff. */
export const MIN_FORCE_MINUTES = 2;

/**
 * Most contracts a manual "Place anyway" may buy: the per-trade limit, the max share of
 * bankroll per position, the contract cap and what is left of today's limit, fees included.
 * Kelly is ignored on purpose (it says 0 when the model sees no edge).
 */
export function maxForcedContracts(p: Pick<Proposal, 'quote'>, risk: RiskConfig, bankroll: number, dailyRemaining: number): number {
  const ask = p.quote.ask;
  const budget = Math.min(risk.maxNotionalPerOrder, risk.maxPositionPct * bankroll, dailyRemaining, bankroll);
  let n = Math.min(risk.maxContractsPerOrder, Math.floor(budget / ask));
  while (n > 0 && n * ask + orderFee(n, ask) > budget + 1e-9) n--;
  return Math.max(0, n);
}

export function evaluate(
  match: Extract<MatchResult, { ok: true }>,
  probability: number,
  risk: RiskConfig,
  ctx: SizingContext,
): Proposal | null {
  const real = quoteFor(match.market, match.side);
  if (!real && ctx.restAt === undefined) return null;
  const resting = ctx.restAt !== undefined;
  const quote: Quote = resting
    ? { ask: ctx.restAt!, bid: real?.bid ?? NaN, spreadCents: real ? real.spreadCents : 99 }
    : real!;
  const fee1 = resting ? makerFeePerContract : feePerContract;
  const feeN = resting ? makerOrderFee : orderFee;
  const cost = quote.ask + fee1(quote.ask);
  // The win chance is a bet-type average; the price knows about this particular match.
  // Lean part of the way toward the market so a cheap price on a weak team doesn't look
  // like a huge edge. The minimum win-chance rule still uses the model's own number.
  const w = Math.min(0.9, Math.max(0, risk.marketWeight ?? 0));
  const ref = real ?? quote;
  const mid = Number.isFinite(ref.bid) && ref.bid > 0 ? (ref.ask + ref.bid) / 2 : ref.ask;
  const priced = w > 0 ? (1 - w) * probability + w * mid : probability;
  const edge = priced - cost;
  const kelly = edge > 0 ? edge / (1 - cost) : 0;
  const base: Proposal = {
    match, probability, priced, quote, cost, edge, kelly, contracts: 0, notional: 0,
    inputs: { probabilityStdErr: ctx.probabilityStdErr, statedProbability: ctx.statedProbability },
  };

  const blocked = blockedBet(match.prediction.bet, risk);
  if (blocked) return { ...base, skip: blocked, hard: true };
  // PredyGo "HIGH RISK / HIGH REWARD" plays (late-game, not graded, not in its record): off unless chosen.
  if (match.prediction.highRisk && !risk.tradeHighRisk) return { ...base, skip: 'high-risk pick (PredyGo: late-game, not graded); turned off', hard: true };
  const paused = activePause(match.prediction, risk);
  if (paused) return { ...base, skip: paused };
  if (ctx.kickoffMismatch && ruleOn(risk, 'kickoffMatch')) return { ...base, skip: 'kickoff time disagrees with Kalshi schedule', hard: true };
  if (ctx.minutesToKickoff < Math.min(MIN_FORCE_MINUTES, risk.minMinutesBeforeKickoff)) {
    return { ...base, skip: ctx.minutesToKickoff < 0 ? 'match already started' : `kickoff in ${Math.round(ctx.minutesToKickoff)} min`, hard: true };
  }
  if (ctx.minutesToKickoff < risk.minMinutesBeforeKickoff) return { ...base, skip: `kickoff in ${Math.round(ctx.minutesToKickoff)} min` };
  const need = requiredEdge(risk, ctx.probabilityStdErr);
  base.required = need;
  // Rules switched off arrive here opened up (ruleSwitches): minimum 0, edge -1, gap 0, ...
  const floor = risk.minProbability ?? 0;
  if (probability < floor) return { ...base, skip: `win chance ${pctBelow(probability, floor)} < ${Math.round(floor * 100)}% minimum`, hard: true };
  if (ctx.statedProbability !== undefined && ctx.statedProbability < floor) {
    return { ...base, skip: `PredyGo confidence ${pctBelow(ctx.statedProbability, floor)} < ${Math.round(floor * 100)}% minimum`, hard: true };
  }
  if (ruleOn(risk, 'lost') && quote.ask <= 0.03 + 1e-9) return { ...base, skip: `price ${Math.round(quote.ask * 100)}¢: as good as lost`, hard: true };
  if (risk.maxPrice && quote.ask > risk.maxPrice + 1e-9) return { ...base, skip: `price ${Math.round(quote.ask * 100)}¢ > ${Math.round(risk.maxPrice * 100)}¢ max` };
  if (!resting && quote.spreadCents > risk.maxSpreadCents) return { ...base, skip: `spread ${quote.spreadCents}c > ${risk.maxSpreadCents}c` };
  const gapMax = risk.maxGapToMarket ?? 0;
  if (gapMax > 0 && !ctx.live) {
    if (probability - mid > gapMax + 1e-9) {
      return { ...base, skip: `market disagrees: win chance ${Math.round(probability * 100)}% vs Kalshi ${Math.round(mid * 100)}¢ (gap over ${Math.round(gapMax * 100)} pts)` };
    }
    const odds = match.prediction.odds;
    if (risk.useKalshiOdds === false && odds && odds > 1 && probability - 1 / odds > gapMax + 1e-9) {
      return { ...base, skip: `feed odds disagree: win chance ${Math.round(probability * 100)}% vs odds ${odds} (${Math.round(100 / odds)}%)` };
    }
  }
  if (edge < need) return { ...base, skip: `edge ${(edge * 100).toFixed(1)}% < ${(need * 100).toFixed(1)}% needed` };
  // The pooled hit rate says nothing about this particular match. Requiring the source's
  // own confidence to clear the price too filters out games the market rates much lower.
  if (risk.requireStatedAboveCost && ctx.statedProbability !== undefined && ctx.statedProbability < cost) {
    return { ...base, skip: `stated ${(ctx.statedProbability * 100).toFixed(0)}% below price` };
  }

  let stake = risk.stakeMode === 'flat' ? Infinity : risk.kellyMultiplier * kelly * ctx.bankroll;
  stake = Math.min(stake, risk.maxPositionPct * ctx.bankroll, risk.maxNotionalPerOrder, ctx.dailyRemaining);
  let contracts = Math.floor(stake / cost);
  contracts = Math.min(contracts, risk.maxContractsPerOrder);
  // Shrink until the real order (fee rounded up to the cent) still fits the budget.
  while (contracts > 0 && contracts * quote.ask + feeN(contracts, quote.ask) > Math.min(stake, ctx.dailyRemaining) + 1e-9) contracts--;
  if (contracts < 1 && ctx.dailyRemaining < cost) return { ...base, skip: 'daily spend cap reached', hard: true };
  // Minimum win: a bet that could only win a few cents isn't worth the risk or the fee.
  // Kelly may size it smaller; raise it to the minimum when the limits allow, else skip.
  const minN = minContractsFor(quote.ask, risk.minWinProfit);
  if (contracts < minN) {
    const cap = Math.min(risk.maxPositionPct * ctx.bankroll, risk.maxNotionalPerOrder, ctx.dailyRemaining);
    if (minN <= risk.maxContractsPerOrder && minN * quote.ask + feeN(minN, quote.ask) <= cap + 1e-9) contracts = minN;
    else return { ...base, skip: `would win only $${Math.max(0, winProfit(Math.max(contracts, 1), quote.ask)).toFixed(2)} (min $${(risk.minWinProfit ?? 0).toFixed(2)}; limits don't allow ${minN} contracts)` };
  }
  // "Stake size" switched off: a stake too small for one contract still buys one, if the cash and limits allow.
  if (contracts < 1 && !ruleOn(risk, 'stake') && quote.ask + feeN(1, quote.ask) <= Math.min(ctx.bankroll, ctx.dailyRemaining) + 1e-9) contracts = 1;
  if (contracts < 1) return { ...base, skip: 'stake too small for 1 contract' };
  const realCost = quote.ask + feeN(contracts, quote.ask) / contracts;
  if (priced - realCost < need) {
    return { ...base, cost: realCost, edge: priced - realCost, skip: 'fee rounding leaves too little edge at this size' };
  }
  return { ...base, cost: realCost, edge: priced - realCost, contracts, notional: +(contracts * quote.ask).toFixed(2) };
}

/** Skips that a lower price can fix (the rest are about the pick or the game, not the price). */
export function priceSkip(skip: string | undefined): boolean {
  return !!skip && /^edge |^price \d+¢ > |^spread |^stated \d+% below price|^fee rounding|^would win only/.test(skip);
}

/**
 * Buy at our price. When the ask is too high, find the most this pick is worth (every rule
 * passes at that price, maker fee included) and bid there: one cent over the best bid,
 * capped at that maximum, so the order is first in line and pays as little as possible.
 * `ownPrice`: our order already on the book at this price (then the best bid may be ours,
 * and we don't bid against ourselves). Null when no price a cent or more under the ask works.
 */
export function planRest(
  match: Extract<MatchResult, { ok: true }>,
  probability: number,
  risk: RiskConfig,
  ctx: SizingContext,
  expiresAt: string,
  ownPrice?: number,
): Proposal | null {
  const q = quoteFor(match.market, match.side);
  if (!q) return null;
  const top = Math.min(q.ask - 0.01, risk.maxPrice ?? 0.99, 0.98);
  let maxPay: number | null = null;
  for (let c = Math.round(top * 100); c >= 5; c--) {
    const pr = evaluate(match, probability, risk, { ...ctx, restAt: c / 100 });
    if (pr && !pr.skip && pr.contracts >= 1) { maxPay = c / 100; break; }
    // Below a price where the problem isn't the price, stop: lower won't fix it.
    if (pr?.skip && !priceSkip(pr.skip)) return null;
  }
  if (maxPay == null) return null;
  const bid = Number.isFinite(q.bid) && q.bid > 0 && q.bid < q.ask ? q.bid : 0;
  const weAreBest = ownPrice !== undefined && Math.abs(bid - ownPrice) < 0.005;
  // No bid at all: we are the market; wait at what it's worth.
  const target = Math.round(Math.min(maxPay, !bid ? maxPay : weAreBest ? bid : bid + 0.01) * 100) / 100;
  if (target < 0.05) return null;
  const pr = evaluate(match, probability, risk, { ...ctx, restAt: target });
  if (!pr || pr.skip || pr.contracts < 1) return null;
  return { ...pr, rest: { price: target, maxPay, askNow: q.ask, bidNow: bid, expiresAt } };
}
