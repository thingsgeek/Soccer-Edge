/**
 * In-play picks. PredyGo publishes live picks during games ("one more goal" overs). The
 * price on Kalshi moves with every minute and every goal, so a pick is only worth acting
 * on in the first seconds after it appears.
 *
 * Every few seconds the live loop reads the open live picks. Picks that were already open
 * when the app started are only recorded, never traded. Each new pick is checked once:
 * matched to its Kalshi market, priced from the live order book, compared with the hit rate
 * of live picks made at the same stage of a game, and then recorded (watch) or bought (trade).
 */
import { tooLateInGame } from './trade/late';
import { appendFileSync } from 'node:fs';
import { ensureHome, liveLogPath, type AppConfig, ruleOn } from './config';
import { loadLivePicks } from './predictions/sources';
import type { Prediction } from './predictions/types';
import { matchPrediction, type MatchResult } from './match/matcher';
import { getMarket } from './kalshi/account';
import type { KalshiCredentials } from './kalshi/client';
import { evaluate, requiredEdge, type Proposal } from './trade/edge';
import { priceHistory } from './trade/tracker';
import { LIVE_STAGES, liveRateFor, liveStageOf, liveStageRecord, MIN_GRADED, stdErr } from './predictions/calibration';
import { failureLabel } from './format';
import { readJsonl } from './trade/picklog';

/** The stages of a game used for live hit rates (records come from your results feed). */
export const LIVE_PHASES = LIVE_STAGES;

/**
 * Win chance for a live pick: this bet type's own graded live record at this stage of the
 * game, else all live picks' record at this stage (both from your results feed, once 30+
 * are graded), else PredyGo's stated confidence for the pick, else 50% with no confidence.
 */
export function liveProbability(minutesSinceKickoff: number, bet?: string, statedPct?: number): { probability: number; stdErr: number; label: string; graded: number } {
  const stage = LIVE_STAGES[liveStageOf(Math.max(0, minutesSinceKickoff))]!.label;
  const own = bet ? liveRateFor(bet, minutesSinceKickoff) : null;
  const rec = own ?? liveStageRecord(minutesSinceKickoff);
  if (rec) {
    const p = (rec.wins + 1) / (rec.graded + 2);
    return { probability: p, stdErr: stdErr(p, rec.graded), label: `${own ? bet + ' ' : 'all live picks '}${stage} (results feed)`, graded: rec.graded };
  }
  if (statedPct !== undefined && Number.isFinite(statedPct) && statedPct > 0) {
    const p = Math.min(0.99, statedPct / 100);
    return { probability: p, stdErr: stdErr(p, MIN_GRADED), label: `PredyGo's stated confidence (no graded live record for ${stage} yet)`, graded: 0 };
  }
  return { probability: 0.5, stdErr: 1, label: `no live record for ${stage} yet`, graded: 0 };
}

/** Goals still needed for an over bet to win, from the score at the time of the pick. */
export function goalsNeeded(line: number, score: [number, number] | undefined): number | null {
  if (!score) return null;
  return Math.max(0, Math.floor(line - score[0] - score[1]) + 1);
}

/** The feed's pick time, if it's sensible (after kickoff, not in the future). */
function pickedTime(p: Prediction, nowMs: number): number | null {
  const ms = p.pickedAt ? Date.parse(p.pickedAt) : NaN;
  if (!Number.isFinite(ms) || ms < Date.parse(p.kickoff) - 5 * 60_000 || ms > nowMs + 60_000) return null;
  return ms;
}

export interface LiveObservation {
  at: string;
  id: string;
  league: string;
  match: string;
  bet: string;
  score?: string;
  minute?: number;
  /** Minutes since kickoff (wall clock) when this row was checked. */
  sinceKickoffMin: number;
  /** Minutes since kickoff when PredyGo made the pick, if different. */
  pickedMin?: number;
  /** Kalshi had already settled this bet when the pick arrived: it could never be traded. */
  decidedBeforePick?: boolean;
  ageSec: number;
  odds?: number;
  ticker?: string;
  contract?: string;
  ask?: number;
  probability?: number;
  required?: number;
  edge?: number;
  contracts?: number;
  /** watch = recorded only; traded = order sent; skip = checked and not traded; old = open before the app started. */
  action: 'watch' | 'traded' | 'skip' | 'old';
  reason: string;
}

export interface LiveContext {
  cfg: AppConfig;
  creds: KalshiCredentials;
  bankroll: number;
  dailyRemaining: number;
  /** True if this pick/market must not be bought again (already traded or held). */
  alreadyIn: (p: Proposal) => string | null;
  /** Kill switch, region etc.: a reason trading is off right now, or null. */
  tradingBlocked: () => string | null;
  execute: (p: Proposal, deadlineMs: number) => Promise<{ placed: number; filled: number; contracts?: number; stoppedReason?: string }>;
  log: (level: 'info' | 'warn' | 'error' | 'trade', msg: string) => void;
  now?: () => number;
  /** Recent Kalshi prices for a contract (what one could be sold for), oldest first. */
  priceHistory?: (ticker: string, side: 'yes' | 'no', fromMs: number) => Promise<{ t: number; v: number }[]>;
}

const MAX_KEPT = 200;
/** With Kalshi odds on: how often a live pick skipped on price is looked at again. */
export const LIVE_RECHECK_MS = 60_000;
/** At most this many re-checks per poll, to stay well inside Kalshi's read limit. */
const MAX_RECHECKS_PER_POLL = 8;

/** Skips that will never change for this pick: not worth re-checking. */
const FINAL_SKIP = /^(minute \d+: no buys|high-risk pick|already decided|not on Kalshi|no live track record|already won|\d+ min after kickoff|already (bought|hold)|would buy \(Live switch off\)|never trade|blocked|.*turned off in Settings)/i;

export class LiveEngine {
  private firstSeen = new Map<string, number>();
  private loggedOld = new Set<string>();
  private primed = false;
  /** Kalshi-odds mode: when to look at a skipped pick again, and the last reason recorded. */
  private recheckAt = new Map<string, number>();
  private lastReason = new Map<string, string>();
  /** Live picks open in the latest poll, for a Buy click. */
  private open = new Map<string, Prediction>();
  observations: LiveObservation[] = [];
  lastPollAt: string | null = null;
  lastError: string | null = null;
  openCount = 0;

  reset(): void {
    this.firstSeen.clear();
    this.recheckAt.clear();
    this.lastReason.clear();
    this.primed = false;
  }

  /** Buy one open live pick now (a click), priced on Kalshi's current price with every check. */
  async buyNow(id: string, ctx: LiveContext): Promise<LiveObservation | null> {
    const p = this.open.get(id);
    if (!p) return null;
    const cfg = structuredClone(ctx.cfg);
    cfg.live.mode = 'trade';
    const t = (ctx.now ?? Date.now)();
    await this.handle(p, { ...ctx, cfg }, t, 0, true);
    return this.observations.find((o) => o.id === id) ?? null;
  }

  async poll(ctx: LiveContext): Promise<void> {
    const now = ctx.now ?? Date.now;
    let picks: Prediction[];
    try {
      picks = await loadLivePicks(ctx.cfg.source);
      this.lastError = null;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      throw e;
    }
    this.lastPollAt = new Date(now()).toISOString();
    const t = now();
    // The feed can leave live picks "open" for hours after the game ended (not yet graded).
    // A game more than 3 hours past kickoff is over: ignore those picks.
    if (ruleOn(ctx.cfg.risk, 'stale')) picks = picks.filter((p) => t - Date.parse(p.kickoff) < 3 * 3600_000);
    this.openCount = picks.length;
    this.open = new Map(picks.map((p) => [p.id, p]));
    // Don't re-log the same old picks every time the app restarts.
    if (!this.primed && this.loggedOld.size === 0) {
      for (const o of readJsonl<{ id: string; action: string }>(liveLogPath()).slice(-2000)) if (o.action === 'old') this.loggedOld.add(o.id);
    }
    const fresh: Prediction[] = [];
    for (const p of picks) {
      if (this.firstSeen.has(p.id)) continue;
      // The clock starts when this app first sees the pick (the feed's own pick time may be
      // in another time zone). Picks already open when the app started are old news,
      // unless the feed's pick time says it was made moments ago.
      let seenAt = t;
      if (!this.primed) {
        const pickedMs = pickedTime(p, t);
        seenAt = pickedMs != null && t - pickedMs <= ctx.cfg.live.maxPickAgeSec * 1000 ? pickedMs : -Infinity;
      }
      this.firstSeen.set(p.id, seenAt);
      fresh.push(p);
    }
    const wasPrimed = this.primed;
    this.primed = true;
    const kalshiOdds = ctx.cfg.risk.useKalshiOdds !== false;
    const run = async (p: Prediction, seenMs: number, ageSec: number, catchUp: boolean) => {
      let retry = false;
      try {
        retry = await this.handle(p, ctx, seenMs, ageSec, catchUp);
      } catch (e) {
        retry = true;
        this.record(this.base(p, t, ageSec, { action: 'skip', reason: `error: ${e instanceof Error ? e.message : e}` }));
      }
      if (retry && kalshiOdds) this.recheckAt.set(p.id, t + LIVE_RECHECK_MS);
      else this.recheckAt.delete(p.id);
    };
    for (const p of fresh) {
      const seen = this.firstSeen.get(p.id)!;
      const ageSec = seen === -Infinity ? Infinity : Math.max(0, (t - seen) / 1000);
      if (!wasPrimed && ageSec > ctx.cfg.live.maxPickAgeSec) {
        // Kalshi odds on: a pick already in play is judged on Kalshi's price right now and
        // the game's current stage, so it can still be traded. Off: old news, never traded.
        if (kalshiOdds) { await run(p, t, ageSec, true); continue; }
        if (!this.loggedOld.has(p.id)) {
          this.loggedOld.add(p.id);
          this.record(this.base(p, t, ageSec, { action: 'old', reason: 'already open when the app started' }));
        }
        continue;
      }
      await run(p, seen === -Infinity ? t : seen, ageSec, false);
    }
    // Picks skipped on price (spread, edge, price jump, no fill...) get another look while in play.
    if (kalshiOdds) {
      const freshIds = new Set(fresh.map((p) => p.id));
      let n = 0;
      for (const p of picks) {
        if (n >= MAX_RECHECKS_PER_POLL) break;
        const at = this.recheckAt.get(p.id);
        if (at === undefined || at > t || freshIds.has(p.id)) continue;
        n++;
        const seen = this.firstSeen.get(p.id) ?? t;
        await run(p, t, seen === -Infinity ? Infinity : Math.max(0, (t - seen) / 1000), true);
      }
    } else this.recheckAt.clear();
    // Forget picks that left the feed so the maps don't grow forever.
    const open = new Set(picks.map((p) => p.id));
    for (const id of this.firstSeen.keys()) if (!open.has(id)) this.firstSeen.delete(id);
    for (const id of this.recheckAt.keys()) if (!open.has(id)) this.recheckAt.delete(id);
    for (const id of this.lastReason.keys()) if (!open.has(id)) this.lastReason.delete(id);
  }

  private base(p: Prediction, t: number, ageSec: number, extra: Pick<LiveObservation, 'action' | 'reason'> & Partial<LiveObservation>): LiveObservation {
    const pickedMs = pickedTime(p, t) ?? this.firstSeen.get(p.id) ?? t;
    return {
      at: new Date(t).toISOString(),
      id: p.id,
      league: p.league,
      match: `${p.home} v ${p.away}`,
      bet: p.bet,
      score: p.score ? `${p.score[0]}-${p.score[1]}` : undefined,
      minute: p.minute,
      sinceKickoffMin: Math.round((t - Date.parse(p.kickoff)) / 60_000),
      pickedMin: Math.round((Math.min(pickedMs > 0 ? pickedMs : t, t) - Date.parse(p.kickoff)) / 60_000),
      ageSec: Number.isFinite(ageSec) ? Math.round(ageSec) : -1,
      odds: p.odds,
      ...extra,
    };
  }

  private record(o: LiveObservation): void {
    // One row per pick: a re-check replaces the pick's earlier row (the log file keeps every check).
    const prev = this.observations.findIndex((x) => x.id === o.id);
    if (prev >= 0) this.observations.splice(prev, 1);
    this.observations.unshift(o);
    if (this.observations.length > MAX_KEPT) this.observations.length = MAX_KEPT;
    try { ensureHome(); appendFileSync(liveLogPath(), JSON.stringify(o) + '\n'); } catch {}
  }

  /** Returns true when the pick is worth checking again later (skipped on price, not for good). */
  private async handle(p: Prediction, ctx: LiveContext, seenMs: number, ageSec: number, catchUp = false): Promise<boolean> {
    const now = ctx.now ?? Date.now;
    const cfg = ctx.cfg;
    const kalshiOdds = cfg.risk.useKalshiOdds !== false;
    const t0 = now();
    // A catch-up / re-check is priced now, so it gets the normal window from now.
    const deadlineMs = (catchUp ? t0 : seenMs) + cfg.live.maxPickAgeSec * 1000;
    const obs = (extra: Pick<LiveObservation, 'action' | 'reason'> & Partial<LiveObservation>): boolean => {
      const retry = extra.action === 'skip' && !FINAL_SKIP.test(extra.reason);
      // Re-checks only log when the reason changes (numbers aside), so the log isn't flooded.
      const sig = `${extra.action}|${extra.reason.replace(/[\d.]+/g, '#')}`;
      if (!catchUp || this.lastReason.get(p.id) !== sig || extra.action !== 'skip') {
        this.record(this.base(p, now(), ageSec, catchUp && extra.action !== 'old' ? { ...extra, reason: `${extra.reason} (checked on Kalshi's current price)` } : extra));
      }
      this.lastReason.set(p.id, sig);
      return retry;
    };

    const r = await matchPrediction(p, { allowLive: true });
    if (!r.ok) {
      const mk = r.market;
      if (r.reason === 'market_not_active' && mk && /^already decided/.test(failureLabel(r))) {
        // Kalshi settles an over-X market the moment enough goals are in.
        const closedMs = mk.close_time ? Date.parse(mk.close_time) : NaN;
        // When the pick first reached the app (re-checks pass their own time as seenMs).
        const first = this.firstSeen.get(p.id);
        const pickedMs = pickedTime(p, t0) ?? (first !== undefined && Number.isFinite(first) ? first : catchUp ? NaN : seenMs);
        const before = Number.isFinite(closedMs) && Number.isFinite(pickedMs) && closedMs <= pickedMs + 60_000;
        const at = Number.isFinite(closedMs) ? ` at ${new Date(closedMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : '';
        return obs({ action: 'skip', reason: `${failureLabel(r)}${at}${before ? ', before this pick arrived' : ''}`, ticker: mk.ticker, decidedBeforePick: before || undefined });
      }
      return obs({ action: 'skip', reason: `not on Kalshi: ${failureLabel(r)}` });
    }
    const m: Extract<MatchResult, { ok: true }> = r;
    const contract = m.market.yes_sub_title ?? m.market.ticker;

    // Fresh order book, not the cached scan copy.
    const fresh = await getMarket(ctx.creds, m.market.ticker);
    const match = { ...m, market: { ...m.market, ...fresh } };
    if (fresh.status !== 'active') return obs({ action: 'skip', reason: `market is ${fresh.status}`, ticker: m.market.ticker, contract });

    // Catch-ups use the game's stage right now (later stages win less often), not pick time.
    const sinceKo = ((catchUp ? t0 : pickedTime(p, t0) ?? Math.min(seenMs, t0)) - Date.parse(p.kickoff)) / 60_000;
    const lp = liveProbability(sinceKo, p.bet, p.statedPct);
    let reason: string | null = null;
    let noScoreCheck = false;
    const late = ruleOn(cfg.risk, 'minute80') ? tooLateInGame(Date.parse(p.kickoff), t0, p.minute, pickedTime(p, t0) ?? null) : null;
    if (late) reason = late;
    else if (sinceKo > cfg.live.maxMinutesSinceKickoff) reason = `${Math.round(sinceKo)} min after kickoff (limit ${cfg.live.maxMinutesSinceKickoff})`;
    else if (m.spec.kind !== 'total' || m.spec.side !== 'yes') {
      if (ruleOn(cfg.risk, 'liveRecord')) reason = `no live track record for ${p.bet}`;
    }
    else {
      const need = goalsNeeded(m.spec.line, p.score);
      // No score in the feed: every PredyGo live pick on record needed exactly one more goal,
      // so assume that, but only when the pick's odds are there to check the price against.
      if (need === null && (kalshiOdds || !p.odds)) noScoreCheck = true; // checked against Kalshi's own prices below
      else if (need === 0 && ruleOn(cfg.risk, 'liveWon')) reason = 'already won on the score shown';
      else if (need !== null && need > 1 && ruleOn(cfg.risk, 'liveRecord')) reason = `needs ${need} more goals (live record covers one-goal picks)`;
    }

    const proposal = evaluate(match, lp.probability, cfg.risk, {
      bankroll: ctx.bankroll,
      dailyRemaining: ctx.dailyRemaining,
      minutesToKickoff: Infinity,
      probabilityStdErr: lp.stdErr,
      live: true,
    });
    if (!proposal) return obs({ action: 'skip', reason: 'no price on Kalshi right now', ticker: m.market.ticker, contract });
    const priced = {
      ticker: m.market.ticker,
      contract,
      ask: proposal.quote.ask,
      probability: lp.probability,
      required: requiredEdge(cfg.risk, lp.stdErr),
      edge: proposal.edge,
      contracts: proposal.contracts,
    };
    // No score and no odds from PredyGo: use Kalshi's own prices instead.
    //  - The one-goal-needed hit rate only applies if the market agrees one goal is needed:
    //    a price well below it means more goals are needed (or something else is wrong).
    //  - A price that jumped in the last 10 minutes means a goal just went in and the
    //    pick was made on the old score.
    // Kalshi odds on: the price-history check runs on every live pick (the feed's score can lag).
    if (!reason && (noScoreCheck || kalshiOdds) && ruleOn(cfg.risk, 'liveJump')) {
      const band = cfg.live.maxPriceJump;
      if (proposal.quote.ask < lp.probability - band) {
        reason = `no score in the feed; Kalshi at ${Math.round(proposal.quote.ask * 100)}¢ is far below the ${Math.round(lp.probability * 100)}% one-goal rate (probably needs more goals)`;
      } else {
        let hist: { t: number; v: number }[] = [];
        try { hist = await (ctx.priceHistory ?? priceHistory)(m.market.ticker, m.side, now() - 12 * 60_000); } catch { hist = []; }
        const recent = hist.filter((h) => h.t >= now() - 11 * 60_000 && Number.isFinite(h.v));
        if (recent.length < 2) reason = 'no score or odds in the feed, and no recent Kalshi price history to check against';
        else {
          const low = Math.min(...recent.map((h) => h.v));
          const nowBid = Number.isFinite(proposal.quote.bid) ? proposal.quote.bid : recent[recent.length - 1]!.v;
          if (nowBid - low > band) reason = `no score in the feed; Kalshi price jumped ${Math.round(low * 100)}¢ → ${Math.round(nowBid * 100)}¢ in the last 10 min: goal probably just scored`;
        }
      }
    }
    // A price far above the pick's own odds usually means a goal has just gone in.
    if (!reason && !kalshiOdds && p.odds && proposal.quote.ask > 1 / p.odds + cfg.live.maxPriceJump) {
      reason = `price ${Math.round(proposal.quote.ask * 100)}¢ is far above the pick's odds (${Math.round(100 / p.odds)}¢): goal probably scored`;
    }
    // Far below: the market sees something the pick didn't (red card, wrong game, stale pick).
    if (!reason && !kalshiOdds && p.odds && proposal.quote.ask < 1 / p.odds - cfg.live.maxPriceJump) {
      reason = `price ${Math.round(proposal.quote.ask * 100)}¢ is far below the pick's odds (${Math.round(100 / p.odds)}¢)`;
    }
    if (!reason && proposal.skip) reason = proposal.skip;
    if (!reason && proposal.contracts < 1) reason = 'too small';
    if (!reason) reason = ctx.alreadyIn(proposal);
    if (reason) return obs({ action: 'skip', reason, ...priced });

    if (cfg.live.mode !== 'trade') return obs({ action: 'watch', reason: 'would buy (Live switch off): click Buy to buy it', ...priced });
    const blocked = ctx.tradingBlocked();
    if (blocked) return obs({ action: 'skip', reason: blocked, ...priced });
    if (now() > deadlineMs) return obs({ action: 'skip', reason: 'too old by the time it was priced', ...priced });

    proposal.liveInfo = {
      sinceKickoffMin: Math.round(sinceKo), stageHitRate: +lp.probability.toFixed(4), stageGraded: lp.graded ?? null,
      score: p.score ? p.score.join('-') : null, minute: p.minute ?? null, odds: p.odds ?? null,
      checkedBy: kalshiOdds ? `Kalshi live price + price history${p.score ? ' + score' : ''}${catchUp ? ' (caught up / re-checked)' : ''}` : noScoreCheck ? 'Kalshi price history (no score/odds in feed)' : p.score ? 'score' : 'odds',
    };
    ctx.log('info', `Live pick: ${p.home} v ${p.away} ${p.bet}${p.score ? ` at ${p.score.join('-')}` : ''} → ${contract} at ${Math.round(proposal.quote.ask * 100)}¢ (model ${Math.round(lp.probability * 100)}%).`);
    const sum = await ctx.execute(proposal, deadlineMs);
    return obs(sum.filled > 0
      ? { action: 'traded', reason: `bought ${sum.contracts ?? sum.filled} contracts`, ...priced }
      : { action: 'skip', reason: sum.stoppedReason ?? 'order not filled (see Activity)', ...priced });
  }
}
