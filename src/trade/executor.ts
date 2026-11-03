/**
 * Turn proposals into orders, one at a time, behind every guard:
 * single-run lock, region check, kill switch, kickoff and price re-checked at the
 * moment of ordering, daily spend cap, open-position cap, no doubling up (by
 * prediction and by market), and in approve mode an explicit yes for each trade.
 */
import { closeSync, existsSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { AppConfig } from '../config';
import { matchMinuteNow, tooLateInGame } from './late';
import { appHome, pregameOn, ruleOn, dailyLeft, ensureHome, killSwitchPath } from '../config';
import type { KalshiCredentials } from '../kalshi/client';
import { KalshiApiError } from '../kalshi/client';
import { getBalance, getMarket, getPositions, placeOrder } from '../kalshi/account';
import { journalEntry } from './journal';
import { activePause, effectiveKickoff, evaluate, makerOrderFee, maxForcedContracts, minContractsFor, orderFee, planRest, winProfit, type Proposal } from './edge';
import { checkRegion, loadEligibility } from './eligibility';
import { readLedger, record, restingExposure, restingOrders, spentToday, tradedPredictionIds, tradedTickers } from './ledger';

/**
 * What a resting order needs for its journal line once it fills (kept in memory; after a
 * restart the journal is rebuilt from the ledger instead).
 */
export const restContext = new Map<string, Omit<Parameters<typeof journalEntry>[0], 'filled' | 'avgPrice' | 'avgFee'>>();

export interface ExecuteOptions {
  /** Called in approve mode; return true to place the order. */
  confirm: (p: Proposal) => Promise<boolean>;
  log: (msg: string) => void;
  /**
   * The user already saw and approved this exact price and size (the Place button):
   * never pay more or buy more than that.
   */
  approved?: boolean;
  /**
   * "Place anyway": the user chose to buy this pick although the edge, spread or
   * kickoff-buffer checks say no. Hard rules (game started, kickoff unclear, kill switch,
   * region, daily cap, already holding) still apply, and the size is still capped.
   */
  force?: boolean;
  /**
   * In-play pick: the game has started on purpose, so the kickoff rules don't apply.
   * Instead the order is dropped if it can't be sent before `deadlineMs`.
   */
  live?: { deadlineMs: number };
  /**
   * Last look before the order goes out (the AI check). Gets the final, live-priced
   * order; returning { ok: false } skips it. It can only stop a trade, never change it.
   */
  precheck?: (p: Proposal) => Promise<{ ok: boolean; reason?: string; verdict?: string }>;
  /** The caller already checked the region just now (saves a request on the live path). */
  regionChecked?: boolean;
  /** How long to wait for another run in this app to finish before giving up. Default 60s. */
  lockWaitMs?: number;
  /** For tests. */
  now?: () => number;
}


export interface ExecuteSummary {
  placed: number;
  /** Orders that filled. */
  filled: number;
  /** Contracts bought across those orders. */
  contracts?: number;
  spent: number;
  stoppedReason?: string;
}

export function killSwitchActive(): boolean {
  return existsSync(killSwitchPath());
}

/** Kalshi errors that mean "you can't trade this from here / at all" rather than a one-off problem. */
function isAccessBlock(e: unknown): boolean {
  if (!(e instanceof KalshiApiError)) return false;
  if (e.statusCode === 401 || e.statusCode === 403) return true;
  return /geo|location|jurisdiction|restricted|not permitted|not allowed/i.test(e.body);
}

/**
 * Same prediction + market + environment + attempt always gets the same client_order_id,
 * so a duplicate send of one attempt is rejected by Kalshi. The attempt number is how many
 * orders were already sent for that pair (an IOC that didn't fill can be tried again later
 * with a new id; Kalshi answers 409 to a reused one).
 */
export function clientOrderIdFor(env: string, predictionId: string, ticker: string, attempt = 0): string {
  const h = createHash('sha256').update(`${env}|${predictionId}|${ticker}${attempt ? `|${attempt}` : ''}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

const LOCK_STALE_MS = 2 * 3600_000;

/** The game a market belongs to: the middle of the ticker (KXMLSTOTAL-26OCT14LAFCATX-2 -> 26OCT14LAFCATX). */
export function matchKeyOf(ticker: string): string | null {
  return ticker.split('-')[1] ?? null;
}

/** Games (match keys) the app has ever bet on, with those bets' tickers in order: filled, waiting, or unconfirmed orders. */
export function gamesTraded(env: string, ledger: readonly unknown[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const e of ledger as any[]) {
    if (e?.type !== 'order' || e.env !== env || (e.error && !e.uncertain)) continue;
    if ((e.filled ?? 0) > 0 || e.uncertain || e.restStatus === 'resting') {
      const k = matchKeyOf(e.ticker);
      if (!k) continue;
      const l = out.get(k) ?? [];
      if (!l.includes(e.ticker)) l.push(e.ticker);
      out.set(k, l);
    }
  }
  return out;
}

/** Hard rule, no exceptions: one bet per game. Returns the skip reason, or null for the first bet. */
export function oneBetPerGame(ticker: string, previous: readonly string[], _matchMinute?: number): string | null {
  return previous.some((t) => t !== ticker) ? 'already have a bet on this match' : null;
}

/** Kind of bet a market is: team goals, total goals, both teams score, or result. */
export function betFamilyOf(ticker: string): string | null {
  const series = ticker.split('-')[0] ?? '';
  return ['TEAMTOTAL', 'TOTAL', 'BTTS', 'GAME'].find((s) => series.endsWith(s)) ?? null;
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === 'EPERM'; }
}

/**
 * One trading run at a time across processes (the app and a command-line run), so two
 * runs can't both spend today's budget. A lock left by a crashed or closed app (its
 * process is gone) is taken over at once.
 */
export function acquireRunLock(): () => void {
  ensureHome();
  const path = join(appHome(), 'run.lock');
  try {
    const fd = openSync(path, 'wx');
    writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
    closeSync(fd);
  } catch (e: any) {
    if (e?.code !== 'EEXIST') throw e;
    let pid = NaN;
    try { pid = parseInt(readFileSync(path, 'utf8'), 10); } catch {}
    const age = Date.now() - statSync(path).mtimeMs;
    if (pidAlive(pid) && age < LOCK_STALE_MS) {
      throw new Error(`Another trading run is in progress (lock: ${path}). If none is, delete that file.`);
    }
    rmSync(path, { force: true });
    return acquireRunLock();
  }
  return () => rmSync(path, { force: true });
}

/** Inside one app, runs queue up instead of failing: pre-game, manual and live share the budget. */
let runQueue: Promise<void> = Promise.resolve();

async function acquireInProcess(waitMs: number): Promise<() => void> {
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const prev = runQueue;
  runQueue = prev.then(() => mine);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    prev.then(() => false),
    new Promise<boolean>((r) => { timer = setTimeout(() => r(true), Math.max(0, waitMs)); }),
  ]);
  clearTimeout(timer);
  if (timedOut) {
    // Give up our place without blocking the runs queued behind us.
    prev.then(() => release());
    throw new Error('another order run was still in progress');
  }
  return release;
}

export async function execute(
  cfg: AppConfig,
  creds: KalshiCredentials,
  proposals: Proposal[],
  opts: ExecuteOptions,
): Promise<ExecuteSummary> {
  const now = opts.now ?? Date.now;
  const summary: ExecuteSummary = { placed: 0, filled: 0, spent: 0 };

  if (!opts.regionChecked) {
    const elig = checkRegion(cfg, await loadEligibility(cfg.eligibilityUrl));
    if (!elig.ok) return { ...summary, stoppedReason: elig.reason };
  }

  const waitMs = opts.live ? opts.live.deadlineMs - now() : opts.lockWaitMs ?? 60_000;
  let releaseQueue: () => void;
  try { releaseQueue = await acquireInProcess(waitMs); }
  catch (e) { return { ...summary, stoppedReason: e instanceof Error ? e.message : String(e) }; }
  let releaseFile: () => void;
  try { releaseFile = acquireRunLock(); }
  catch (e) { releaseQueue(); throw e; }
  const release = () => { releaseFile(); releaseQueue(); };
  try {
    const env = creds.env;
    const positions = await getPositions(creds);
    const ledger = readLedger();
    const done = tradedPredictionIds(env, ledger);
    const doneTickers = tradedTickers(env, ledger);
    // Waiting orders count as spent (what they could still spend) against a daily limit.
    let spent = spentToday(env, ledger) + restingOrders(env, ledger).reduce((a, o) => a + restingExposure(o), 0);
    // Open positions this app opened (bought per the ledger and still held on Kalshi).
    // Positions bought by hand or in other markets don't use up the app's slots.
    const appTickers = new Set(ledger.filter((e) => e.type === 'order' && e.env === env && (e.uncertain || (e.filled ?? 0) > 0)).map((e) => (e as { ticker: string }).ticker));
    // Waiting orders are bets too: they count for one-per-match, per-kind and open-position caps.
    const restingTick = new Set(restingOrders(env, ledger).map((o) => o.ticker));
    const tradedGames = gamesTraded(env, ledger);
    let openCount = new Set([...[...positions.keys()].filter((t) => appTickers.has(t)), ...restingTick]).size;
    const costOf = (ticker: string) => ledger.reduce((a, e) => {
      if (e.type !== 'order' || e.env !== env || e.ticker !== ticker) return a;
      if (e.uncertain) return a + e.count * (e.limitPrice + 0.02);
      return (e.filled ?? 0) > 0 ? a + (e.filled ?? 0) * ((e.avgPrice ?? e.limitPrice) + (e.avgFee ?? 0)) : a;
    }, 0);
    const attempts = (id: string, ticker: string) => ledger.filter((e) => e.type === 'order' && e.env === env && e.predictionId === id && e.ticker === ticker).length;
    const seenTickers = new Set<string>();

    // Spread the money: when more picks qualify than today's budget covers at full size,
    // each gets an equal share (at least one contract) so more of them are bought.
    let spreadLeft = cfg.risk.autoSize && !opts.force && !opts.live
      ? new Set(proposals.filter((p) => p.contracts >= 1 && !p.skip && !done.has(p.match.prediction.id) && !doneTickers.has(p.match.market.ticker) && !positions.has(p.match.market.ticker)).map((p) => p.match.market.ticker)).size
      : 0;
    const fullCost = proposals.filter((p) => p.contracts >= 1 && !p.skip).reduce((a, p) => a + p.contracts * p.cost, 0);
    if (spreadLeft > 1 && fullCost <= dailyLeft(cfg.risk, spent)) spreadLeft = 0; // everything fits at full size

    for (const p of proposals) {
      if (opts.force ? p.hard || p.contracts < 1 : p.contracts < 1 || p.skip) continue;
      const id = p.match.prediction.id;
      const ticker = p.match.market.ticker;

      // Two picks can map to one contract (e.g. VISITA MARCA and its REG variant). Take the first (best edge).
      const noDouble = ruleOn(cfg.risk, 'noDouble');
      if (noDouble && seenTickers.has(ticker)) { opts.log(`skip ${ticker}: another pick already maps to this market`); continue; }
      seenTickers.add(ticker);

      if (killSwitchActive()) { summary.stoppedReason = 'kill switch is on'; break; }
      if (noDouble && done.has(id)) { opts.log(`skip ${ticker}: already traded this prediction`); continue; }
      if (noDouble && doneTickers.has(ticker)) { opts.log(`skip ${ticker}: you already bought this market`); continue; }
      if (noDouble && positions.has(ticker)) { opts.log(`skip ${ticker}: you already hold a position here`); continue; }
      // Spread the risk: one bet per match, and only a couple of open bets of the same kind
      // (five "team to score" bets win or lose together on the same kind of outcome).
      {
        const openApp = [...new Set([...[...positions.keys()].filter((t) => appTickers.has(t)), ...restingTick])];
        const mk = matchKeyOf(ticker), fam = betFamilyOf(ticker);
        // Hard rule (Claude can't turn it off; only its own switch in Rules in force): one bet per game, ever,
        // counting bets already won, lost or sold on that game.
        const gameMin = matchMinuteNow(Date.parse(p.match.prediction.kickoff), now(), p.match.prediction.minute);
        const onGame = mk ? [...(tradedGames.get(mk) ?? []), ...openApp.filter((t) => matchKeyOf(t) === mk && !(tradedGames.get(mk) ?? []).includes(t))] : [];
        const oneBet = mk && ruleOn(cfg.risk, 'onePerMatch') ? oneBetPerGame(ticker, onGame, gameMin) : null;
        const why = oneBet
          ? oneBet
          : fam && cfg.risk.maxOpenPerBetType > 0 && openApp.filter((t) => betFamilyOf(t) === fam).length >= cfg.risk.maxOpenPerBetType
            ? `already ${cfg.risk.maxOpenPerBetType} open bets of this kind (${fam.toLowerCase()})`
            : null;
        if (why) {
          record({ type: 'skip', at: new Date(now()).toISOString(), predictionId: id, ticker, reason: why });
          opts.log(`skip ${ticker}: ${why}`);
          continue;
        }
      }
      if (openCount >= cfg.risk.maxOpenPositions) { summary.stoppedReason = `open-position cap (${cfg.risk.maxOpenPositions}) reached`; break; }

      const remaining = dailyLeft(cfg.risk, spent);
      let shownCount = Math.min(p.contracts, Math.floor(remaining / p.cost));
      const minN = minContractsFor(p.quote.ask, cfg.risk.minWinProfit);
      if (spreadLeft > 1 && shownCount > 1) {
        const share = Math.max(minN, Math.floor(remaining / spreadLeft / p.cost));
        if (share < shownCount) { opts.log(`${ticker}: ${shownCount} → ${share} contracts to leave room for ${spreadLeft - 1} more pick(s)`); shownCount = share; }
      }
      if (spreadLeft > 0) spreadLeft--;
      if (shownCount < 1) { summary.stoppedReason = `daily spend cap ($${cfg.risk.maxDailySpend}) reached`; break; }
      const sized: Proposal = shownCount === p.contracts ? p : { ...p, contracts: shownCount, notional: +(shownCount * p.quote.ask).toFixed(2) };

      if (cfg.mode === 'approve' && !(await opts.confirm(sized))) {
        record({ type: 'skip', at: new Date(now()).toISOString(), predictionId: id, ticker, reason: 'declined by user' });
        continue;
      }

      // Re-check everything that can change while a prompt sits open, then price the
      // pick again from the live quote and current cash, exactly as a scan would.
      if (killSwitchActive()) { summary.stoppedReason = 'kill switch is on'; break; }
      let fresh;
      let cashNow: number;
      try {
        [fresh, cashNow] = await Promise.all([getMarket(creds, ticker), getBalance(creds).then((b) => b.cashCents / 100)]);
      } catch (e) {
        opts.log(`skip ${ticker}: could not refresh the market (${e instanceof Error ? e.message : e})`);
        continue;
      }
      const liveMatch = { ...p.match, market: { ...p.match.market, ...fresh } };
      const ko = effectiveKickoff(p.match.prediction.kickoff, liveMatch.market);
      const skip = (reason: string) => {
        record({ type: 'skip', at: new Date(now()).toISOString(), predictionId: id, ticker, reason });
        opts.log(`skip ${ticker}: ${reason}`);
      };
      if (fresh.status !== 'active') { skip(`market is ${fresh.status}`); continue; }
      // Hard rule (even forced/manual buys): nothing from the 80th minute on.
      const late = ruleOn(cfg.risk, 'minute80') ? tooLateInGame(ko.kickoffMs, now(), p.match.prediction.minute) : null;
      if (late) { skip(late); continue; }
      const sizing = {
        bankroll: cashNow,
        dailyRemaining: dailyLeft(cfg.risk, spent),
        minutesToKickoff: opts.live ? Infinity : (ko.kickoffMs - now()) / 60_000,
        kickoffMismatch: opts.live ? false : ko.mismatch,
        ...p.inputs,
        live: !!opts.live,
      };
      let live = evaluate(liveMatch, p.probability, cfg.risk, sizing);
      // Buy at our price: if the ask still isn't worth it, re-plan the resting order on the
      // fresh book (if it now is, just buy at the ask).
      let rest = false;
      if (p.rest && !opts.force && (!live || live.skip)) {
        const plan = planRest(liveMatch, p.probability, cfg.risk, sizing, p.rest.expiresAt);
        if (!plan) { skip(live?.skip ? `at the live price: ${live.skip}, and no lower price is worth a resting order` : 'no price on Kalshi right now'); continue; }
        live = plan; rest = true;
      }
      if (!live) { skip('no price on Kalshi right now'); continue; }
      let liveMax = live.contracts;
      // Forced buys, and "Price checked at order time" switched off: a soft skip at the live price doesn't stop the order.
      if ((opts.force || !ruleOn(cfg.risk, 'freshPrice')) && !live.hard) liveMax = live.skip ? maxForcedContracts(live, cfg.risk, cashNow, dailyLeft(cfg.risk, spent)) : live.contracts;
      else if (live.skip) { skip(`at the live price: ${live.skip}`); continue; }
      const liveP: Proposal = live;
      if (liveMax < 1) { skip(live.hard ? `at the live price: ${live.skip}` : 'at the live price: too small'); continue; }
      if (opts.live && now() > opts.live.deadlineMs) { skip('live pick too old by the time the price came back'); continue; }
      const limitPrice = live.quote.ask;
      if ((opts.approved || opts.force || cfg.mode === 'approve') && ruleOn(cfg.risk, 'approved') && limitPrice > sized.quote.ask + 1e-9) {
        // Never pay more than the price the user approved.
        skip(`price rose to ${Math.round(limitPrice * 100)}¢ (you approved ${Math.round(sized.quote.ask * 100)}¢)`);
        continue;
      }
      // Live sizing can only shrink the order (less cash, less edge), never grow it past what was shown.
      let count = Math.min(liveMax, sized.contracts);
      // Total open exposure: what's already riding plus this order stays under the cap.
      if (cfg.risk.maxOpenExposurePct > 0 && cfg.risk.maxOpenExposurePct < 1) {
        // Resting orders count at what they could still spend.
        const openCost = [...positions.keys()].filter((t) => appTickers.has(t)).reduce((a, t) => a + costOf(t), 0)
          + restingOrders(env, ledger).reduce((a, o) => a + restingExposure(o), 0);
        const room = cfg.risk.maxOpenExposurePct * (cashNow + openCost) - openCost;
        while (count > 0 && count * limitPrice + orderFee(count, limitPrice) > room + 1e-9) count--;
        if (count < 1) { skip(`open bets already $${openCost.toFixed(2)} (${Math.round(cfg.risk.maxOpenExposurePct * 100)}% of bankroll limit)`); continue; }
      }
      // Only buy what's actually for sale at this price. Kalshi allows fractions of a
      // contract, so a thin book once filled 0.02 of a 2-contract order (a $0.02 bet).
      if (!rest) {
        const size = parseFloat(String((fresh as any)[p.match.side === 'yes' ? 'yes_ask_size_fp' : 'yes_bid_size_fp'] ?? ''));
        if (Number.isFinite(size) && size < count) {
          const avail = Math.floor(size + 1e-9);
          if (avail < Math.max(1, minContractsFor(limitPrice, opts.force ? 0 : cfg.risk.minWinProfit))) {
            skip(`only ${size} contract(s) for sale at ${Math.round(limitPrice * 100)}¢ right now`);
            continue;
          }
          opts.log(`${ticker}: only ${size} for sale at ${Math.round(limitPrice * 100)}¢, buying ${avail}`);
          count = avail;
        }
      }
      if (count < sized.contracts) opts.log(`${ticker}: size cut from ${sized.contracts} to ${count} at the live price/balance`);
      // Never send an order that could only win pennies (limits can cut it below the minimum).
      if (!opts.force && winProfit(count, limitPrice) < (cfg.risk.minWinProfit ?? 0) - 1e-9) {
        skip(`would win only $${winProfit(count, limitPrice).toFixed(2)} with ${count} contract(s) (min $${(cfg.risk.minWinProfit ?? 0).toFixed(2)})`);
        continue;
      }

      let claudeVerdict: { verdict: string; reason?: string } | null = null;
      if (opts.precheck) {
        const final: Proposal = { ...liveP, contracts: count, notional: +(count * limitPrice).toFixed(2) };
        const verdict = await opts.precheck(final);
        claudeVerdict = { verdict: verdict.verdict ?? (verdict.ok ? 'ok' : 'block'), reason: verdict.reason };
        if (!verdict.ok) { skip(`AI check: ${verdict.reason ?? 'blocked'}`); continue; }
        if (killSwitchActive()) { summary.stoppedReason = 'kill switch is on'; break; }
        if (opts.live && now() > opts.live.deadlineMs) { skip('live pick too old after the AI check'); continue; }
      }

      if (rest && attempts(id, ticker) >= 8) { skip('resting order re-placed 8 times already; leaving this pick'); continue; }
      const clientOrderId = clientOrderIdFor(env, id, ticker, attempts(id, ticker));
      const base = {
        type: 'order' as const,
        env,
        predictionId: id,
        ticker,
        side: p.match.side,
        count,
        limitPrice,
        probability: p.probability,
        edge: liveP.edge,
        clientOrderId,
        match: `${p.match.prediction.home} v ${p.match.prediction.away}`,
        bet: p.match.prediction.bet,
        league: p.match.prediction.league,
        ...(opts.force ? { forced: true } : {}),
        ...(rest && liveP.rest ? { resting: true, expiresAt: liveP.rest.expiresAt, maxPay: liveP.rest.maxPay } : {}),
      };
      try {
        const res = await placeOrder(creds, { ticker, side: p.match.side, count, limitPrice, clientOrderId, ...(rest && liveP.rest ? { restUntil: Date.parse(liveP.rest.expiresAt) / 1000 } : {}) });
        summary.placed++;
        const entry = {
          ...base, at: new Date(now()).toISOString(), orderId: res.orderId, filled: res.filled, avgPrice: res.avgPrice, avgFee: res.avgFee,
          ...(rest ? { restStatus: (res.filled >= count - 1e-9 ? 'executed' : 'resting') as 'resting' | 'executed' } : {}),
        };
        record(entry);
        ledger.push(entry);
        const jctx = {
          key: clientOrderId, env, cfg, mode: (opts.force ? 'forced' : opts.live ? 'live' : cfg.mode === 'approve' ? 'approve' : 'auto') as 'forced' | 'live' | 'approve' | 'auto',
          proposal: { ...liveP, calibration: p.calibration ?? liveP.calibration, liveInfo: p.liveInfo ?? liveP.liveInfo, match: liveMatch } as Proposal,
          market: fresh as any, count, limitPrice, claude: claudeVerdict, now: new Date(now()),
        };
        const journal = (filled: number, extra: { avgPrice?: number; avgFee?: number; uncertain?: boolean }) => journalEntry({ ...jctx, filled, ...extra });
        if (res.filled > 0) journal(res.filled, { avgPrice: res.avgPrice, avgFee: res.avgFee });
        else if (rest) restContext.set(clientOrderId, jctx);
        if (rest && res.filled < count - 1e-9) {
          done.add(id); doneTickers.add(ticker); restingTick.add(ticker); openCount++;
          spent += Math.max(0, count - res.filled) * (limitPrice + 0.01);
          opts.log(`resting buy: ${count} × ${p.match.side.toUpperCase()} ${ticker} at ${Math.round(limitPrice * 100)}¢ (ask was ${Math.round((liveP.rest?.askNow ?? limitPrice) * 100)}¢; worth up to ${Math.round((liveP.rest?.maxPay ?? limitPrice) * 100)}¢), on the book until ${new Date(liveP.rest!.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);
        }
        if (res.filled > 0) {
          const cost = res.filled * ((res.avgPrice ?? limitPrice) + (res.avgFee ?? 0));
          spent += cost;
          summary.spent += cost;
          summary.filled++;
          summary.contracts = (summary.contracts ?? 0) + res.filled;
          openCount++;
          done.add(id);
          appTickers.add(ticker);
          positions.set(ticker, res.filled);
          opts.log(`filled ${res.filled} x ${p.match.side.toUpperCase()} ${ticker} @ $${(res.avgPrice ?? limitPrice).toFixed(2)}`);
        } else if (!rest) {
          opts.log(`no fill on ${ticker}: nothing available at $${limitPrice.toFixed(2)} (order cancelled, nothing left resting)`);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // 4xx = Kalshi refused it: not placed. 5xx = the exchange may have taken it anyway.
        if (e instanceof KalshiApiError && e.statusCode < 500) {
          const entry = { ...base, at: new Date(now()).toISOString(), error: msg };
          record(entry);
          ledger.push(entry);
          if (isAccessBlock(e) && ruleOn(cfg.risk, 'kalshiErr')) {
            summary.stoppedReason = `Kalshi refused the order (${msg}). Stopping: check your location and account.`;
            break;
          }
          opts.log(`order rejected on ${ticker}: ${msg}`);
        } else {
          // Timeout, network error or 5xx: the order may have reached Kalshi and filled.
          const entry = { ...base, at: new Date(now()).toISOString(), error: msg, uncertain: true, ...(rest ? { restStatus: 'resting' as const } : {}) };
          record(entry);
          ledger.push(entry);
          journalEntry({
            key: clientOrderId, env, cfg, mode: opts.force ? 'forced' : opts.live ? 'live' : cfg.mode === 'approve' ? 'approve' : 'auto',
            proposal: { ...liveP, calibration: p.calibration, liveInfo: p.liveInfo, match: liveMatch } as Proposal,
            market: fresh as any, count, limitPrice, filled: count, uncertain: true, claude: claudeVerdict, now: new Date(now()),
          });
          spent += count * (limitPrice + 0.02);
          done.add(id);
          positions.set(ticker, count);
          if (!ruleOn(cfg.risk, 'kalshiErr')) { opts.log(`no reply from Kalshi for ${ticker} (${msg}); it may have filled. Carrying on (rule switched off).`); continue; }
          summary.stoppedReason = `No reply from Kalshi for the ${ticker} order (${msg}). It may have filled; check "soccer-edge status" before running again. Stopping.`;
          break;
        }
      }
    }
    summary.spent = +summary.spent.toFixed(2);
    return summary;
  } finally {
    release();
  }
}
