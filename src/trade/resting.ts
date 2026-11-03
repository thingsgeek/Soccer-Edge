/**
 * Buy at our price: looks after the buy orders the app leaves on the Kalshi book.
 * Each pass it reads their fills, records them, and cancels an order when:
 *  - the kill switch is on,
 *  - its time is up (minMinutesBeforeKickoff; Kalshi also expires it on its own),
 *  - the pick no longer qualifies, is worth less than the order's price, or someone
 *    outbid us and the pick is worth more (the next scan places it again at the new price),
 *  - the ask became worth taking (the next scan buys at the ask).
 */
import type { AppConfig } from '../config';
import type { KalshiCredentials } from '../kalshi/client';
import { cancelOrder, getOrder, getRestingOrders, orderState, type OrderState } from '../kalshi/account';
import { KalshiApiError } from '../kalshi/client';
import { journalEntry } from './journal';
import { record, readLedger, restingOrders, type OrderEntry } from './ledger';
import { killSwitchActive, restContext } from './executor';

export interface RestingSync {
  /** Contracts that filled since the last pass. */
  newlyFilled: number;
  canceled: number;
  stillResting: number;
}

/** Why an order should come off the book now, or null to leave it. */
export type KeepCheck = (o: OrderEntry) => string | null;

/** Re-placements per pick before the app stops chasing the price. */
export const MAX_REST_ATTEMPTS = 8;

export async function syncResting(
  cfg: AppConfig,
  creds: KalshiCredentials,
  opts: { log: (level: 'info' | 'warn', msg: string) => void; keep?: KeepCheck; now?: () => number; force?: string },
): Promise<RestingSync> {
  const now = opts.now ?? Date.now;
  const out: RestingSync = { newlyFilled: 0, canceled: 0, stillResting: 0 };
  const mine = restingOrders(creds.env);
  if (!mine.length) return out;
  let book = new Map<string, OrderState>();
  try { book = new Map((await getRestingOrders(creds)).map((o) => [o.orderId, o])); } catch {}

  const byClient = new Map([...book.values()].map((x) => [x.clientOrderId, x]));
  for (const o of mine) {
    // Placement timed out: find it on the book by our client id; not there = never rested.
    let st = o.orderId ? book.get(o.orderId) : byClient.get(o.clientOrderId);
    if (!st && !o.orderId) {
      if (now() - Date.parse(o.at) > 120_000) note(o, { orderId: '', ticker: o.ticker, status: 'canceled', filled: o.filled ?? 0, remaining: 0 }, opts.log, 'not on the book');
      continue;
    }
    if (st?.raw) st = { ...orderState(st.raw, o.side), raw: st.raw };
    if (!st) { try { st = await getOrder(creds, o.orderId!, o.side); } catch { continue; } }
    // A maker fill is at our limit price; trust that over a cost field in the other side's dollars.
    if (st.filled > 0 && st.avgPrice !== undefined && Math.abs(st.avgPrice - o.limitPrice) > 0.015) st = { ...st, avgPrice: o.limitPrice };
    if (!o.orderId && st.orderId) o.orderId = st.orderId;
    note(o, st, opts.log);
    if (st.status !== 'resting') continue;

    const why = opts.force
      ?? (killSwitchActive() ? 'kill switch is on' : null)
      ?? (o.expiresAt && now() >= Date.parse(o.expiresAt) - 30_000 ? 'too close to kickoff' : null)
      ?? opts.keep?.(o) ?? null;
    if (!why) { out.stillResting++; continue; }
    try {
      try { await cancelOrder(creds, o.orderId!, o.ticker); }
      catch (e) { if (!(e instanceof KalshiApiError && e.statusCode === 404)) throw e; } // already gone (expired)
      let fin = st;
      try { fin = await getOrder(creds, o.orderId!, o.side); } catch {}
      note(o, { ...fin, status: 'canceled' }, opts.log, why);
      out.canceled++;
      opts.log('info', `Resting order off the book: ${o.match ?? o.ticker} ${o.bet ?? ''} at ${Math.round(o.limitPrice * 100)}¢ (${why})${(fin.filled ?? 0) > 0 ? `, ${fin.filled} of ${o.count} had filled` : ''}.`);
    } catch (e) {
      opts.log('warn', `Could not cancel the resting order on ${o.ticker}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return out;

  function note(o: OrderEntry, st: OrderState, log: typeof opts.log, reason?: string) {
    const before = o.filled ?? 0;
    if (st.filled === before && st.status === (o.restStatus ?? 'resting')) return;
    record({ type: 'order_update', at: new Date(now()).toISOString(), clientOrderId: o.clientOrderId, filled: st.filled, avgPrice: st.avgPrice, avgFee: st.avgFee, status: st.status, ...(reason ? { reason } : {}) });
    if (st.filled > before) {
      out.newlyFilled += st.filled - before;
      log('info', `Resting order filled: ${st.filled - before} × ${o.side.toUpperCase()} ${o.match ?? o.ticker} ${o.bet ?? ''} at ${Math.round((st.avgPrice ?? o.limitPrice) * 100)}¢ (${st.filled} of ${o.count}).`);
      const ctx = restContext.get(o.clientOrderId);
      if (ctx && before === 0) { journalEntry({ ...ctx, filled: st.filled, avgPrice: st.avgPrice, avgFee: st.avgFee }); restContext.delete(o.clientOrderId); }
    }
    o.filled = st.filled; o.restStatus = st.status;
  }
}

/**
 * Kill switch: cancel every order of ours resting on Kalshi that the app placed (matched by
 * client id), including ones the ledger lost track of, then record them.
 */
export async function cancelAllAppOrders(cfg: AppConfig, creds: KalshiCredentials, log: (level: 'info' | 'warn', msg: string) => void, reason: string): Promise<number> {
  const mineIds = new Set(readLedger().filter((e) => e.type === 'order' && e.env === creds.env).map((e) => (e as OrderEntry).clientOrderId));
  let n = 0;
  try {
    for (const o of await getRestingOrders(creds)) {
      if (!o.clientOrderId || !mineIds.has(o.clientOrderId)) continue;
      try { await cancelOrder(creds, o.orderId, o.ticker); n++; } catch (e) { log('warn', `Could not cancel ${o.ticker}: ${e instanceof Error ? e.message : e}`); }
    }
  } catch (e) { log('warn', `Could not list waiting orders on Kalshi: ${e instanceof Error ? e.message : e}`); }
  await syncResting(cfg, creds, { log, force: reason }).catch(() => {});
  if (n) log('warn', `Took ${n} waiting order(s) off the Kalshi book (${reason}).`);
  return n;
}

/** Times the app has placed an order for this pick (resting re-placements count). */
export function attemptsFor(env: 'demo' | 'prod', predictionId: string): number {
  return readLedger().filter((e) => e.type === 'order' && e.env === env && e.predictionId === predictionId && !e.error).length;
}
