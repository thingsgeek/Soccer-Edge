/**
 * Append-only local record of every proposal, order and result (JSON lines).
 * Keep it: it's your audit trail, and the daily spend cap is computed from it.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { ensureHome, ledgerPath } from '../config';

export interface OrderEntry {
  type: 'order';
  at: string;
  env: 'demo' | 'prod';
  predictionId: string;
  ticker: string;
  side: 'yes' | 'no';
  count: number;
  limitPrice: number;
  probability: number;
  edge: number;
  clientOrderId: string;
  orderId?: string;
  filled?: number;
  avgPrice?: number;
  /** Fee paid per filled contract, dollars. */
  avgFee?: number;
  error?: string;
  /**
   * The request may have reached Kalshi (timeout / network error), so the order
   * might have filled. Counted as spent and as traded until checked by hand.
   */
  uncertain?: boolean;
  /** What was bet on (recorded from v0.9.1). */
  match?: string;
  bet?: string;
  league?: string;
  /** Placed with "Place anyway", overriding the edge/price checks. */
  forced?: boolean;
  /** Placed by the Claude manager (not the app's own rules). */
  by?: 'claude';
  /** Buy at our price: a buy order left on the book (good till canceled) until `expiresAt`. */
  resting?: boolean;
  expiresAt?: string;
  /** The most this pick was worth when the order went in. */
  maxPay?: number;
  /** Book state of a resting order, updated from Kalshi (see order_update entries). */
  restStatus?: 'resting' | 'canceled' | 'executed';
  /** Time of the latest order_update merged in (a resting order's last fill or cancel). */
  updatedAt?: string;
}

/** Later news about an order (a resting order filling or being canceled), merged into it on read. */
export interface OrderUpdate {
  type: 'order_update';
  at: string;
  clientOrderId: string;
  filled: number;
  avgPrice?: number;
  avgFee?: number;
  status: 'resting' | 'canceled' | 'executed';
  reason?: string;
}

export type LedgerEntry =
  | OrderEntry
  | OrderUpdate
  | { type: 'skip'; at: string; predictionId: string; ticker?: string; reason: string }
  | { type: 'kill' | 'resume'; at: string; reason?: string };

export function record(entry: LedgerEntry): void {
  ensureHome();
  appendFileSync(ledgerPath(), JSON.stringify(entry) + '\n');
}

export function readLedger(): LedgerEntry[] {
  if (!existsSync(ledgerPath())) return [];
  const rows = readFileSync(ledgerPath(), 'utf-8')
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try { return [JSON.parse(l) as LedgerEntry]; } catch { return []; }
    });
  return mergeUpdates(rows);
}

/** Apply order_update entries to their orders (latest wins); the updates stay in the list. */
export function mergeUpdates(rows: LedgerEntry[]): LedgerEntry[] {
  const byId = new Map<string, OrderEntry>();
  for (const e of rows) {
    if (e.type === 'order') byId.set(e.clientOrderId, e);
    else if (e.type === 'order_update') {
      const o = byId.get(e.clientOrderId);
      if (!o) continue;
      o.filled = e.filled;
      if (e.avgPrice !== undefined) o.avgPrice = e.avgPrice;
      if (e.avgFee !== undefined) o.avgFee = e.avgFee;
      o.restStatus = e.status;
      o.updatedAt = e.at;
    }
  }
  return rows;
}

/** Resting buy orders still on the book, as far as the app knows. */
export function restingOrders(env: 'demo' | 'prod', entries = readLedger()): OrderEntry[] {
  return entries.filter((e): e is OrderEntry => e.type === 'order' && e.env === env && !!e.resting && e.restStatus === 'resting' && (!e.error || !!e.uncertain));
}

/** Dollars a resting order could still spend (unfilled part, fee included). */
export function restingExposure(o: OrderEntry): number {
  return Math.max(0, o.count - (o.filled ?? 0)) * (o.limitPrice + 0.01);
}

const localDay = (iso: string) => new Date(iso).toLocaleDateString('en-CA');

/**
 * Money already paid back today by today's trades that settled as wins. It is taken off
 * today's spend, so winnings free up the daily limit (losses still count in full).
 */
let dailyCredit: ((env: 'demo' | 'prod') => number) | null = null;
export function setDailyCredit(fn: ((env: 'demo' | 'prod') => number) | null): void { dailyCredit = fn; }
export const isToday = (iso: string) => localDay(iso) === localDay(new Date().toISOString());

/** Gross dollars committed today (local date), before winnings are credited back. */
export function grossSpentToday(env: 'demo' | 'prod', entries = readLedger()): number {
  const today = localDay(new Date().toISOString());
  let total = 0;
  for (const e of entries) {
    if (e.type !== 'order' || e.env !== env || localDay(e.at) !== today) continue;
    if (e.uncertain) total += e.count * (e.limitPrice + 0.02);
    else if (!e.error) total += (e.filled ?? 0) * ((e.avgPrice ?? e.limitPrice) + (e.avgFee ?? 0));
  }
  return +total.toFixed(2);
}

/**
 * Dollars counted against the daily limit: today's spend (filled orders incl. fees, plus
 * orders whose outcome is unknown at full size) minus what today's settled wins paid back.
 */
export function spentToday(env: 'demo' | 'prod', entries = readLedger()): number {
  const gross = grossSpentToday(env, entries);
  let credit = 0;
  try { credit = dailyCredit?.(env) ?? 0; } catch {}
  return +Math.max(0, gross - credit).toFixed(2);
}

/**
 * Prediction ids already acted on (filled, or possibly filled), so a re-run never doubles a
 * position. A fill under one contract (a sliver) doesn't count: the pick can still be bought.
 */
export function tradedPredictionIds(env: 'demo' | 'prod', entries = readLedger()): Set<string> {
  return new Set(
    entries
      .filter((e): e is OrderEntry => e.type === 'order' && e.env === env && (e.uncertain === true || (!e.error && ((e.filled ?? 0) >= 1 || e.restStatus === 'resting'))))
      .map((e) => e.predictionId),
  );
}

/**
 * Markets already bought (filled, or possibly filled). Prediction ids can change format
 * between app or feed versions, so the market ticker is the dependable record.
 */
export function tradedTickers(env: 'demo' | 'prod', entries = readLedger()): Set<string> {
  return new Set(
    entries
      .filter((e): e is OrderEntry => e.type === 'order' && e.env === env && (e.uncertain === true || (!e.error && ((e.filled ?? 0) >= 1 || e.restStatus === 'resting'))))
      .map((e) => e.ticker),
  );
}

export function uncertainOrders(env: 'demo' | 'prod', entries = readLedger()): OrderEntry[] {
  return entries.filter((e): e is OrderEntry => e.type === 'order' && e.env === env && e.uncertain === true);
}
