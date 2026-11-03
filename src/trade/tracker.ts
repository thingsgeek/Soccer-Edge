/**
 * Your trades, as they stand now: every order the app filled, with what it cost, what it's
 * worth at the current price (or what it paid out once settled), and the profit or loss.
 * Plus a balance history and price charts for each trade.
 */
import { leagueForTicker } from '../kalshi/markets';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { appHome, ensureHome } from '../config';
import type { KalshiCredentials } from '../kalshi/client';
import { publicGet } from '../kalshi/client';
import { getAccountPositions, getFills, getMarket, getSettlements, type AccountFill, type AccountPosition } from '../kalshi/account';
import { isToday, readLedger, type OrderEntry } from './ledger';
import { readJsonl } from './picklog';

export const balanceLogPath = (): string => join(appHome(), 'balance.jsonl');

interface MarketInfo { title: string; status: string; result: string | null; bid: number; ask: number; last: number; closeTime?: string; at: number }

/**
 * Bets that can only be won once and then stay won: "over" totals, a team to score, both
 * teams to score. Once the goal goes in, Kalshi's price for YES jumps to 99c+ - well
 * before the market settles. Match results (GAME) can still change, so they're never
 * called early.
 */
const ONE_WAY = /(TEAMTOTAL|TOTAL|BTTS)-/;
export function earlyResult(ticker: string, side: 'yes' | 'no', now: number): { decided: 'won' | 'lost' | null; outlook: 'winning' | 'losing' | null } {
  if (!Number.isFinite(now)) return { decided: null, outlook: null };
  if (ONE_WAY.test(ticker) && now >= 0.99 && side === 'yes') return { decided: 'won', outlook: null };
  if (ONE_WAY.test(ticker) && now <= 0.01 && side === 'no') return { decided: 'lost', outlook: null };
  return { decided: null, outlook: now >= 0.9 ? 'winning' : now <= 0.1 ? 'losing' : null };
}

const n = (v: unknown) => { const x = parseFloat(String(v ?? '')); return Number.isFinite(x) ? x : NaN; };

export class TradeTracker {
  private markets = new Map<string, MarketInfo>();
  private inflight = new Map<string, Promise<void>>();
  private lastBalance: { at: number; total: number } | null = null;
  private sparks = new Map<string, { at: number; pts: number[]; settled: boolean }>();
  private sparkInflight = new Set<string>();
  /** Account fills from Kalshi, refreshed every minute: how trades closed outside the app are found. */
  private fills: { at: number; list: AccountFill[] } | null = null;
  private fillsInflight = false;
  private lastSync = 0;
  /** Unsettled positions on Kalshi (incl. ones closed to zero), refreshed with the fills. */
  private acct: { at: number; pos: Map<string, AccountPosition> } | null = null;
  private settlements: { at: number; since: number; map: Map<string, { yes: number; no: number }>; earliestMs?: number } | null = null;
  /** Last error per Kalshi read (fills, positions, settlements), for diagnostics. */
  syncErrors: Record<string, string> = {};
  /** Seams for tests. */
  setFills(list: AccountFill[]): void { this.fills = { at: Date.now(), list }; }
  setAccountPositions(pos: Map<string, AccountPosition>): void { this.acct = { at: Date.now(), pos }; }
  setSettlements(map: Map<string, { yes: number; no: number }>, since = 0, earliestMs?: number): void { this.settlements = { at: Date.now(), since, map, earliestMs }; }
  /** Market info, for tests. */
  setMarket(ticker: string, m: Partial<MarketInfo>): void { this.markets.set(ticker, { title: ticker, status: 'active', result: null, bid: NaN, ask: NaN, last: NaN, at: Date.now(), ...m }); }

  /** What the reconciliation is working from, for diagnostics. */
  syncStatus(env: 'demo' | 'prod') {
    const rows = this.trades(env).all;
    const settled = rows.filter((r) => r.status === 'won' || r.status === 'lost' || r.status === 'sold');
    return {
      fills: this.fills ? { count: this.fills.list.length, at: new Date(this.fills.at).toISOString() } : null,
      positions: this.acct ? { count: this.acct.pos.size, at: new Date(this.acct.at).toISOString() } : null,
      settlements: this.settlements ? { count: this.settlements.map.size, earliest: this.settlements.earliestMs ? new Date(this.settlements.earliestMs).toISOString() : null, at: new Date(this.settlements.at).toISOString() } : null,
      errors: { ...this.syncErrors },
      settledTrades: settled.map((r) => {
        const rec = this.settlements?.map.get(r.ticker);
        return { ticker: r.ticker, match: r.match, status: r.status, contracts: r.contracts, pnl: r.pnl, heldAtSettlement: rec ? Math.max(0, r.side === 'yes' ? rec.yes - rec.no : rec.no - rec.yes) : null };
      }),
    };
  }

  /** Per app trade: what Kalshi says is still held, for diagnostics. */
  reconcileReport(env: 'demo' | 'prod'): { ticker: string; match: string | null; side: string; appQty: number; kalshiQty: number | null; status: string }[] {
    // One line per market: the app's orders on it added up (a sliver plus a full order are one
    // position on Kalshi), against what Kalshi holds.
    const by = new Map<string, { ticker: string; match: string | null; side: 'yes' | 'no'; appQty: number; status: string }>();
    for (const r of this.trades(env).all.filter((r) => r.status === 'open' || r.status === 'settling')) {
      const k = `${r.ticker}|${r.side}`;
      const cur = by.get(k) ?? { ticker: r.ticker, match: r.match, side: r.side, appQty: 0, status: r.status };
      cur.appQty = +(cur.appQty + r.contracts - (r.soldQty ?? 0)).toFixed(2);
      by.set(k, cur);
    }
    return [...by.values()].map((r) => {
      const p = this.acct?.pos.get(r.ticker);
      const held = !this.acct ? null : !p ? 0 : r.side === 'yes' ? Math.max(0, p.position) : Math.max(0, -p.position);
      return { ...r, kalshiQty: held };
    });
  }

  private refreshFills(): void {
    if (this.fillsInflight || Date.now() - this.lastSync < 60_000) return;
    const creds = this.creds();
    if (!creds) return;
    this.fillsInflight = true;
    this.lastSync = Date.now();
    const since = Math.floor(Date.now() / 1000) - 31 * 86400;
    // Each read on its own: one failing must not leave the others stale (it used to).
    const err = (k: string) => (e: unknown) => { this.syncErrors[k] = `${new Date().toLocaleTimeString()}: ${e instanceof Error ? e.message : e}`; return null; };
    Promise.all([
      getFills(creds, since).then((list) => { this.fills = { at: Date.now(), list }; delete this.syncErrors.fills; }).catch(err('fills')),
      getAccountPositions(creds).then((pos) => { this.acct = { at: Date.now(), pos }; delete this.syncErrors.positions; }).catch(err('positions')),
      getSettlements(creds, since).then((m) => { this.settlements = { at: Date.now(), since: since * 1000, map: m, earliestMs: m.earliestMs }; delete this.syncErrors.settlements; }).catch(err('settlements')),
    ]).finally(() => { this.fillsInflight = false; });
  }

  /**
   * Contracts of `side` closed on Kalshi since `fromMs` (sold, or netted off by buying the other
   * side), with the money they brought back after fees.
   */
  private closedOnKalshi(ticker: string, side: 'yes' | 'no', fromMs: number): { qty: number; proceeds: number } {
    let qty = 0, proceeds = 0;
    for (const f of this.fills?.list ?? []) {
      if (f.ticker !== ticker || f.purchased === side || !(f.ts >= fromMs - 5000) || !(f.count > 0)) continue;
      const per = side === 'yes' ? f.yesPrice : 1 - f.yesPrice;
      if (!Number.isFinite(per)) continue;
      qty += f.count;
      proceeds += f.count * per - (f.fee || 0);
    }
    return { qty, proceeds };
  }

  /**
   * Contracts of `side` still held when `ticker` settled, from Kalshi's settlement records;
   * null when those records aren't loaded or don't reach back to the trade.
   */
  private heldAtSettlement(ticker: string, side: 'yes' | 'no', boughtMs: number, closeTime?: string): number | null {
    const s = this.settlements;
    if (!s || !(boughtMs >= s.since)) return null;
    const r = s.map.get(ticker);
    // Selling YES is recorded as buying NO: a market sold before the end settles with both
    // counts (7 YES and 7 NO = nothing held). What was held is the difference.
    if (r) return Math.max(0, side === 'yes' ? r.yes - r.no : r.no - r.yes);
    // No settlement record: nothing was held when it settled (all sold). Kalshi can take a while
    // to post the record after the result, so only trust that once the market closed 3h+ before,
    // and only if Kalshi's live records reach back that far (older ones get archived).
    const closed = Date.parse(closeTime ?? '');
    if (!Number.isFinite(closed) || s.at - closed <= 3 * 3600e3) return null;
    if (!(s.earliestMs !== undefined && s.earliestMs <= closed)) return null;
    return 0;
  }

  /** Small price history for the inline chart next to a trade (refreshed every 5 minutes). */
  spark(ticker: string, side: 'yes' | 'no', fromMs: number, settled: boolean): number[] | null {
    const key = `${ticker}|${side}`;
    const cur = this.sparks.get(key);
    const fresh = cur && (cur.settled || Date.now() - cur.at < 5 * 60_000);
    if (!fresh && !this.sparkInflight.has(key) && this.sparkInflight.size < 4) {
      this.sparkInflight.add(key);
      priceHistory(ticker, side, fromMs - 2 * 3600e3)
        .then((pts) => {
          const vs = pts.map((p) => p.v);
          const step = Math.max(1, Math.ceil(vs.length / 40));
          this.sparks.set(key, { at: Date.now(), pts: vs.filter((_, i) => i % step === 0 || i === vs.length - 1), settled });
        })
        .catch(() => this.sparks.set(key, { at: Date.now(), pts: cur?.pts ?? [], settled: false }))
        .finally(() => this.sparkInflight.delete(key));
    }
    return cur?.pts ?? null;
  }

  constructor(private creds: () => KalshiCredentials | null) {}

  /** Market title/status/prices, refreshed every 60s for open markets, never once settled. */
  private refresh(ticker: string): void {
    const cur = this.markets.get(ticker);
    const settled = cur && (cur.result === 'yes' || cur.result === 'no');
    if (settled || (cur && Date.now() - cur.at < 60_000) || this.inflight.has(ticker)) return;
    const creds = this.creds();
    if (!creds) return;
    const p = getMarket(creds, ticker).then((m: any) => {
      this.markets.set(ticker, {
        title: `${m.title ?? ticker}${m.yes_sub_title ? ` · ${m.yes_sub_title}` : ''}`,
        status: m.status ?? '',
        result: m.result === 'yes' || m.result === 'no' ? m.result : null,
        bid: n(m.yes_bid_dollars), ask: n(m.yes_ask_dollars), last: n(m.last_price_dollars),
        closeTime: m.close_time, at: Date.now(),
      });
    }).catch(() => {}).finally(() => this.inflight.delete(ticker));
    this.inflight.set(ticker, p);
  }

  /** Latest REST read of a market (refreshed in the background every 60s). */
  quote(ticker: string): { bid: number; ask: number; last: number; title: string; status: string; result: string | null } | null {
    this.refresh(ticker);
    const m = this.markets.get(ticker);
    return m ? { bid: m.bid, ask: m.ask, last: m.last, title: m.title, status: m.status, result: m.result } : null;
  }

  /** Trades placed by the app in the last `days` days, newest first. */
  trades(env: 'demo' | 'prod', live?: (ticker: string) => { bid: number; ask: number; last: number } | null, days = 3650) {
    const since = Date.now() - days * 86400e3;
    const orders = readLedger().filter((e): e is OrderEntry => e.type === 'order' && e.env === env && ((e.filled ?? 0) > 0 || !!e.uncertain) && Date.parse(e.at) >= since);
    const liveObs = readJsonl<{ id: string; action: string; match?: string; bet?: string }>(join(appHome(), 'live.jsonl'));
    const picks = readJsonl<{ id: string; match?: string; bet?: string }>(join(appHome(), 'picks.jsonl'));
    const nameOf = new Map<string, { match?: string; bet?: string }>();
    for (const x of [...picks, ...liveObs]) if (x.match) nameOf.set(x.id, { match: x.match, bet: x.bet });

    this.refreshFills();
    // Per market: how much the app bought, and how much of it was closed on Kalshi since.
    const bought = new Map<string, { qty: number; first: number; last: number }>();
    for (const o of orders) {
      const b = bought.get(o.ticker) ?? { qty: 0, first: Infinity, last: -Infinity };
      b.qty += o.filled ?? (o.uncertain ? o.count : 0); b.first = Math.min(b.first, Date.parse(o.at)); b.last = Math.max(b.last, Date.parse(o.at), Date.parse(o.updatedAt ?? '') || 0);
      bought.set(o.ticker, b);
    }
    const allRows = orders.slice().reverse().map((o) => {
      this.refresh(o.ticker);
      const m = this.markets.get(o.ticker);
      const qty = o.filled ?? (o.uncertain ? o.count : 0);
      const paid = o.avgPrice ?? o.limitPrice;
      const fee = (o.avgFee ?? 0) * qty;
      const cost = qty * paid + fee;
      const lq = live?.(o.ticker) ?? null;
      const bid = lq?.bid ?? m?.bid ?? NaN;
      const ask = lq?.ask ?? m?.ask ?? NaN;
      let status: 'open' | 'won' | 'lost' | 'unknown' | 'settling' | 'sold' = 'open';
      let now = o.side === 'yes' ? bid : 1 - ask; // what you could sell it for now
      // Game over, result not posted yet: the order book is empty, so value at the last trade.
      const closed = m && !m.result && /closed|determined|settled|finalized/i.test(m.status);
      if (closed || (!Number.isFinite(now) || (bid === 0 && ask >= 0.99))) {
        const last = lq?.last ?? m?.last ?? NaN;
        if (Number.isFinite(last) && last > 0) now = o.side === 'yes' ? last : 1 - last;
        if (closed) status = 'settling';
      }
      if (m?.result) {
        status = m.result === o.side ? 'won' : 'lost';
        now = status === 'won' ? 1 : 0;
      } else if (o.uncertain) status = 'unknown';
      // Decided before Kalshi settles (goal scored on an "over"/"team to score" bet): count
      // it at the payout it's going to get.
      let early = status === 'open' || status === 'settling' ? earlyResult(o.ticker, o.side, now) : { decided: null as 'won' | 'lost' | null, outlook: null as 'winning' | 'losing' | null };
      if (early.decided) now = early.decided === 'won' ? 1 : 0;
      let value = Number.isFinite(now) ? qty * now : NaN;
      // Closed on Kalshi (sold, or netted off with the other side): this row's share of it.
      const b = bought.get(o.ticker);
      const closed2 = b && b.qty > 0 ? this.closedOnKalshi(o.ticker, o.side, b.first) : { qty: 0, proceeds: 0 };
      // Second source: what Kalshi holds now (unsettled), or held when it settled. Any shortfall
      // against what the app bought was closed on Kalshi, however the fill was labelled. Without
      // the settled half, a sold trade went back to "won"/"lost" at full payout once the game
      // settled, and the totals no longer matched the balance.
      const heldAtSettle = m?.result ? this.heldAtSettlement(o.ticker, o.side, b?.first ?? NaN, m.closeTime) : null;
      if (b && b.qty > 0 && this.acct && this.acct.at > b.last + 5000 && m && (!m.result || heldAtSettle != null) && !o.uncertain) {
        const p = this.acct.pos.get(o.ticker);
        const held = heldAtSettle ?? (!p ? 0 : o.side === 'yes' ? Math.max(0, p.position) : Math.max(0, -p.position));
        const gone = Math.max(0, b.qty - held);
        if (gone > closed2.qty + 1e-6) {
          const missing = gone - closed2.qty;
          // Money back for the part the fills didn't explain: Kalshi's realized P/L on the market
          // when everything is closed, else the current sale price.
          const appCost = orders.filter((x) => x.ticker === o.ticker).reduce((a, x) => a + (x.filled ?? 0) * ((x.avgPrice ?? x.limitPrice) + (x.avgFee ?? 0)), 0);
          const perNow = o.side === 'yes' ? bid : 1 - ask;
          // Settled: Kalshi's realized P/L covers the sale and the settlement payout, so the sale
          // is what's left after taking out the payout on contracts still held.
          const payout = m.result ? held * (m.result === o.side ? 1 : 0) : 0;
          const est = p && Number.isFinite(p.realized) && closed2.qty === 0 && (held === 0 || m.result)
            ? Math.max(0, appCost + p.realized - payout)
            : missing * (Number.isFinite(perNow) && !m.result ? perNow : paid);
          closed2.qty = gone;
          closed2.proceeds += est;
        }
      }
      const soldFrac = b && b.qty > 0 ? Math.min(1, closed2.qty / b.qty) : 0;
      const soldQty = +(qty * soldFrac).toFixed(2);
      if (soldFrac > 0) {
        const back = closed2.proceeds * (qty / b!.qty) * Math.min(1, b!.qty / Math.max(closed2.qty, 1e-9));
        if (soldFrac >= 0.999) {
          status = 'sold'; early = { decided: null, outlook: null };
          value = back; now = qty > 0 ? back / qty : NaN;
        } else {
          value = (Number.isFinite(now) ? (qty - soldQty) * now : 0) + back;
        }
      }
      const named = o.match ? { match: o.match, bet: o.bet } : nameOf.get(o.predictionId);
      return {
        at: o.at,
        ticker: o.ticker,
        title: m?.title ?? o.ticker,
        match: named?.match ?? null,
        // Early trades (before the app saved these on each order): the bet is in the pick id, the league in the ticker.
        bet: named?.bet ?? (o.predictionId?.includes('::') ? o.predictionId.split('::').pop()! : null),
        source: o.forced ? 'forced' : liveObs.some((l) => l.id === o.predictionId && l.action === 'traded') ? 'live' : 'pregame',
        league: o.league ?? leagueForTicker(o.ticker),
        entry: (o.by === 'claude' ? 'claude' : o.resting ? 'resting' : 'ask') as 'claude' | 'resting' | 'ask',
        side: o.side,
        contracts: qty,
        paid,
        cost: +cost.toFixed(2),
        now: Number.isFinite(now) ? +now.toFixed(4) : null,
        value: Number.isFinite(value) ? +value.toFixed(2) : null,
        pnl: Number.isFinite(value) ? +(value - cost).toFixed(2) : null,
        status,
        soldQty: soldQty > 0 ? soldQty : null,
        decided: early.decided,
        outlook: early.outlook,
        liveTick: !!lq,
        spark: null as number[] | null,
      };
    });
    // Every trade counts in the totals (overall record); the list shows the latest 100.
    const rows = allRows.slice(0, 100);
    // Inline price charts for the 25 most recent trades.
    rows.slice(0, 25).forEach((r) => { r.spark = this.spark(r.ticker, r.side, Date.parse(r.at), r.status === 'won' || r.status === 'lost'); });
    const open = allRows.filter((r) => r.status === 'open' || r.status === 'settling');
    const settled = allRows.filter((r) => r.status === 'won' || r.status === 'lost' || r.status === 'sold');
    const sum = (rs: typeof rows, k: 'cost' | 'value' | 'pnl') => +rs.reduce((a, r) => a + (Number(r[k]) || 0), 0).toFixed(2);
    return {
      rows,
      all: allRows,
      totals: {
        open: open.length, openCost: sum(open, 'cost'), openValue: sum(open, 'value'), openPnl: sum(open, 'pnl'),
        won: settled.filter((r) => r.status === 'won').length, lost: settled.filter((r) => r.status === 'lost').length,
        sold: settled.filter((r) => r.status === 'sold').length,
        settledPnl: sum(settled, 'pnl'),
        trades: allRows.length, since: allRows.length ? allRows[allRows.length - 1]!.at : null,
        decidedWon: open.filter((r) => r.decided === 'won').length, decidedLost: open.filter((r) => r.decided === 'lost').length,
      },
    };
  }

  /** Payouts already received today from today's trades that settled as wins. */
  paidBackToday(env: 'demo' | 'prod'): number {
    let total = 0;
    for (const o of readLedger()) {
      if (o.type !== 'order' || o.env !== env || o.error || o.uncertain || !isToday(o.at) || !(o.filled! > 0)) continue;
      this.refresh(o.ticker);
      const m = this.markets.get(o.ticker);
      if (m?.result && m.result === o.side) total += o.filled!;
    }
    return +total.toFixed(2);
  }

  /** Record cash + positions value (skips near-duplicates). */
  recordBalance(cash: number, positions: number): void {
    const total = +(cash + positions).toFixed(2);
    const now = Date.now();
    if (this.lastBalance && Math.abs(this.lastBalance.total - total) < 0.005 && now - this.lastBalance.at < 30 * 60_000) return;
    this.lastBalance = { at: now, total };
    try { ensureHome(); appendFileSync(balanceLogPath(), JSON.stringify({ at: new Date(now).toISOString(), cash, positions, total }) + '\n'); } catch {}
  }

  balanceHistory(days = 14): { t: number; v: number }[] {
    const since = Date.now() - days * 86400e3;
    const pts = readJsonl<{ at: string; total: number }>(balanceLogPath()).map((x) => ({ t: Date.parse(x.at), v: x.total })).filter((x) => x.t >= since && Number.isFinite(x.v));
    if (pts.length <= 300) return pts;
    const step = Math.ceil(pts.length / 300);
    return pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
  }
}

/**
 * Price history for one trade's contract, from the side you bought: what one contract
 * could be sold for (YES: YES bid; NO: 1 - YES ask). Hourly candles, or 1-minute ones
 * for the last day.
 */
export async function priceHistory(ticker: string, side: 'yes' | 'no', fromMs: number): Promise<{ t: number; v: number }[]> {
  const series = ticker.split('-')[0]!;
  const end = Math.floor(Date.now() / 1000);
  const start = Math.floor(Math.max(fromMs, Date.now() - 14 * 86400e3) / 1000);
  const interval = end - start <= 26 * 3600 ? 1 : 60;
  const r = await publicGet(`/series/${series}/markets/${ticker}/candlesticks`, { start_ts: start, end_ts: end, period_interval: interval });
  const out: { t: number; v: number }[] = [];
  for (const c of (r?.candlesticks ?? []) as any[]) {
    const bid = n(c?.yes_bid?.close_dollars);
    const ask = n(c?.yes_ask?.close_dollars);
    const v = side === 'yes' ? bid : 1 - ask;
    if (Number.isFinite(v) && v >= 0 && v <= 1) out.push({ t: c.end_period_ts * 1000, v: +v.toFixed(4) });
  }
  return out;
}
