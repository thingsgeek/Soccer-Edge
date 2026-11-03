/**
 * Authenticated account calls: balance, positions, orders.
 *
 * Order-body mapping onto Kalshi's V2 single YES-side book adapted from
 * OctagonAI/kalshi-trading-bot-cli (src/tools/kalshi/orders-v2.ts), MIT License,
 * Copyright (c) Octagon AI, Inc. See THIRD_PARTY_NOTICES.md.
 */
import { authed, type KalshiCredentials } from './client';

export interface Balance {
  /** Cash available, cents. */
  cashCents: number;
  portfolioValueCents: number;
}

export async function getBalance(creds: KalshiCredentials): Promise<Balance> {
  const r = await authed(creds, 'GET', '/portfolio/balance');
  return { cashCents: Number(r.balance ?? 0), portfolioValueCents: Number(r.portfolio_value ?? 0) };
}

/** Net contracts per ticker (positive YES, negative NO). Flat markets omitted. */
export async function getPositions(creds: KalshiCredentials): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const r = await authed(creds, 'GET', '/portfolio/positions', { params: { limit: 1000, cursor } });
    for (const p of (r.market_positions ?? []) as { ticker: string; position_fp?: string; position?: number }[]) {
      const n = parseFloat(String(p.position_fp ?? p.position ?? '0'));
      // Less than one contract is dust (a sliver filled by a seller): not a position to protect.
      if (Number.isFinite(n) && Math.abs(n) >= 1) out.set(p.ticker, n);
    }
    cursor = r.cursor || undefined;
    if (!cursor) break;
  }
  return out;
}

/** Positions with cost and P/L (REST snapshot; the live stream sends changes after this). */
export async function getPositionsDetail(creds: KalshiCredentials): Promise<{ ticker: string; position: number; cost: number; realized: number; fees: number; ts: number }[]> {
  const out: { ticker: string; position: number; cost: number; realized: number; fees: number; ts: number }[] = [];
  let cursor: string | undefined;
  const n = (v: unknown) => { const x = parseFloat(String(v ?? '')); return Number.isFinite(x) ? x : NaN; };
  for (let page = 0; page < 20; page++) {
    const r = await authed(creds, 'GET', '/portfolio/positions', { params: { limit: 1000, cursor } });
    for (const p of (r.market_positions ?? []) as any[]) {
      const position = n(p.position_fp ?? p.position);
      if (!position) continue;
      out.push({
        ticker: p.ticker,
        position,
        cost: n(p.market_exposure_dollars ?? (p.market_exposure != null ? p.market_exposure / 100 : NaN)),
        realized: n(p.realized_pnl_dollars ?? (p.realized_pnl != null ? p.realized_pnl / 100 : NaN)),
        fees: n(p.fees_paid_dollars ?? (p.fees_paid != null ? p.fees_paid / 100 : NaN)),
        ts: Date.now(),
      });
    }
    cursor = r.cursor || undefined;
    if (!cursor) break;
  }
  return out;
}

export interface OrderIntent {
  ticker: string;
  /** Which contract we are buying. */
  side: 'yes' | 'no';
  count: number;
  /** Limit price on the chosen side, dollars (0.01-0.99). */
  limitPrice: number;
  clientOrderId: string;
  /**
   * Leave it on the book (good till canceled) until this time, unix seconds. post_only:
   * if it would cross the book right away Kalshi rejects it, so it never pays the taker fee.
   */
  restUntil?: number;
  /** Sell what we hold instead of buying (reduce_only, takes the bid now). */
  sell?: boolean;
}

/**
 * V2 orders quote the YES side of a single book: bid = buy YES, ask = sell YES.
 * Buying NO at p is the same as selling YES at 1 - p.
 */
export function toV2Body(o: OrderIntent) {
  const yesPrice = o.side === 'yes' ? o.limitPrice : 1 - o.limitPrice;
  // Buying YES / selling NO = bid on the YES book; buying NO / selling YES = ask.
  const buysYes = o.sell ? o.side === 'no' : o.side === 'yes';
  const body: Record<string, unknown> = {
    ticker: o.ticker,
    side: buysYes ? 'bid' : 'ask',
    count: o.count.toFixed(2),
    price: yesPrice.toFixed(4),
    // Default: all or nothing at our limit or better, right now. "Take what's there" (IOC) once
    // filled 0.02 of a contract when the book showed no size: a $0.01 bet that then blocked
    // the real one. Sells stay IOC (Kalshi only allows reduce_only with IOC).
    time_in_force: o.sell ? 'immediate_or_cancel' : 'fill_or_kill',
    self_trade_prevention_type: 'taker_at_cross',
    client_order_id: o.clientOrderId,
  };
  if (o.restUntil && !o.sell) {
    body.time_in_force = 'good_till_canceled';
    body.expiration_time = Math.floor(o.restUntil);
    body.post_only = true;
  }
  if (o.sell) body.reduce_only = true;
  return body;
}

export interface OrderState { orderId: string; clientOrderId?: string; ticker: string; status: 'resting' | 'canceled' | 'executed'; filled: number; remaining: number; avgPrice?: number; avgFee?: number; raw?: any }

/** Read an order as the side we bought (pass it: listed orders may not say which side). */
export function orderState(o: any, side?: 'yes' | 'no'): OrderState {
  const n = (v: unknown) => { const x = parseFloat(String(v ?? '')); return Number.isFinite(x) ? x : 0; };
  const filled = n(o.fill_count_fp ?? o.fill_count);
  const cost = n(o.taker_fill_cost_dollars) + n(o.maker_fill_cost_dollars);
  const fees = n(o.taker_fees_dollars) + n(o.maker_fees_dollars);
  const s = side ?? (o.outcome_side === 'no' ? 'no' : 'yes');
  const yes = n(o.yes_price_dollars);
  return {
    orderId: o.order_id, clientOrderId: o.client_order_id, ticker: o.ticker,
    // Anything that isn't working or filled (expired, rejected...) is off the book.
    status: o.status === 'resting' || o.status === 'pending' ? 'resting' : o.status === 'executed' ? 'executed' : 'canceled',
    filled, remaining: n(o.remaining_count_fp ?? o.remaining_count),
    avgPrice: filled > 0 ? (cost > 0 ? cost / filled : s === 'yes' ? yes : 1 - yes) : undefined,
    avgFee: filled > 0 ? fees / filled : undefined,
    raw: o,
  };
}

/** One order's current state (fills, still resting or not). */
export async function getOrder(creds: KalshiCredentials, orderId: string, side?: 'yes' | 'no'): Promise<OrderState> {
  const r = await authed(creds, 'GET', `/portfolio/orders/${encodeURIComponent(orderId)}`);
  return orderState(r.order, side);
}

/** Every order of ours still resting on the book. */
export async function getRestingOrders(creds: KalshiCredentials): Promise<OrderState[]> {
  const out: OrderState[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const r = await authed(creds, 'GET', '/portfolio/orders', { params: { status: 'resting', limit: 200, cursor } });
    for (const o of (r.orders ?? []) as any[]) out.push(orderState(o));
    cursor = r.cursor || undefined;
    if (!cursor) break;
  }
  return out;
}

/** Cancel a resting order. Returns how many contracts were taken off the book. */
export async function cancelOrder(creds: KalshiCredentials, orderId: string, ticker: string): Promise<number> {
  const r = await authed(creds, 'DELETE', `/portfolio/events/orders/${encodeURIComponent(orderId)}`, { params: { market_ticker: ticker } });
  return parseFloat(r.reduced_by ?? '0') || 0;
}

export interface OrderResult {
  orderId: string;
  filled: number;
  remaining: number;
  avgPrice?: number;
  avgFee?: number;
}

/** Current state of one market in the account's environment (fresh quote before ordering). */
export async function getMarket(creds: KalshiCredentials, ticker: string): Promise<import('./types').KalshiMarket> {
  const r = await authed(creds, 'GET', `/markets/${encodeURIComponent(ticker)}`);
  return r.market;
}

export async function placeOrder(creds: KalshiCredentials, o: OrderIntent): Promise<OrderResult> {
  const r = await authed(creds, 'POST', '/portfolio/events/orders', { body: toV2Body(o) });
  const filled = parseFloat(r.fill_count_fp ?? r.fill_count ?? '0') || 0;
  const avgYes = r.average_fill_price !== undefined ? parseFloat(r.average_fill_price) : undefined;
  const rem = parseFloat(r.remaining_count_fp ?? r.remaining_count ?? '');
  return {
    orderId: r.order_id,
    filled,
    // Not in the reply: assume what didn't fill is still there (a sync corrects it).
    remaining: Number.isFinite(rem) ? rem : Math.max(0, o.count - filled),
    // Convert the YES-side fill price back to the side we bought.
    avgPrice: avgYes === undefined ? undefined : o.side === 'yes' ? avgYes : 1 - avgYes,
    avgFee: r.average_fee_paid !== undefined ? parseFloat(r.average_fee_paid) : undefined,
  };
}

/** One fill on your account, as the side it bought (selling YES shows up as buying NO). */
export interface AccountFill { ticker: string; purchased: 'yes' | 'no'; count: number; yesPrice: number; fee: number; ts: number }

/** Every fill since `minTs` (unix seconds), newest first. */
export async function getFills(creds: KalshiCredentials, minTs: number): Promise<AccountFill[]> {
  const out: AccountFill[] = [];
  const n = (v: unknown) => { const x = parseFloat(String(v ?? '')); return Number.isFinite(x) ? x : NaN; };
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const r = await authed(creds, 'GET', '/portfolio/fills', { params: { limit: 200, min_ts: minTs, cursor } });
    for (const f of (r.fills ?? []) as any[]) {
      const side = f.side === 'no' ? 'no' : 'yes';
      const purchased: 'yes' | 'no' = f.purchased_side === 'yes' || f.purchased_side === 'no' ? f.purchased_side : f.action === 'sell' ? (side === 'yes' ? 'no' : 'yes') : side;
      let yes = n(f.yes_price_dollars ?? f.yes_price_fixed);
      if (!Number.isFinite(yes) && f.yes_price != null) yes = n(f.yes_price) / 100;
      if (!Number.isFinite(yes)) { const no = n(f.no_price_dollars ?? f.no_price_fixed ?? (f.no_price != null ? n(f.no_price) / 100 : NaN)); if (Number.isFinite(no)) yes = 1 - no; }
      const count = n(f.count_fp ?? f.count);
      const ts = Date.parse(f.created_time ?? '') || n(f.ts_ms) || (n(f.ts) * 1000);
      if (!f.ticker && !f.market_ticker) continue;
      out.push({ ticker: f.ticker ?? f.market_ticker, purchased, count, yesPrice: yes, fee: n(f.fee_cost) || 0, ts });
    }
    cursor = r.cursor || undefined;
    if (!cursor) break;
  }
  return out;
}

/**
 * Contracts still held when each market settled (from Kalshi's settlement records since
 * `minTs`, seconds). A trade the app bought that isn't fully here was sold before settlement.
 */
export async function getSettlements(creds: KalshiCredentials, minTs: number): Promise<Map<string, { yes: number; no: number }> & { earliestMs?: number }> {
  const out = new Map<string, { yes: number; no: number }>() as Map<string, { yes: number; no: number }> & { earliestMs?: number };
  const n = (v: unknown) => { const x = parseFloat(String(v ?? '')); return Number.isFinite(x) ? x : 0; };
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const r = await authed(creds, 'GET', '/portfolio/settlements', { params: { limit: 1000, min_ts: minTs, cursor } });
    for (const x of (r.settlements ?? []) as any[]) {
      if (!x.ticker) continue;
      const cur = out.get(x.ticker) ?? { yes: 0, no: 0 };
      cur.yes += n(x.yes_count_fp ?? x.yes_count); cur.no += n(x.no_count_fp ?? x.no_count);
      out.set(x.ticker, cur);
      const t = Date.parse(x.settled_time ?? '');
      if (Number.isFinite(t) && !(t >= (out.earliestMs ?? Infinity))) out.earliestMs = t;
    }
    cursor = r.cursor || undefined;
    if (!cursor) break;
  }
  return out;
}

/**
 * Every market position on the account (settled ones included), including ones closed back to
 * zero (Kalshi keeps those with their realized P/L until the market settles). Position is signed:
 * positive = YES contracts, negative = NO contracts.
 */
export interface AccountPosition { position: number; realized: number; fees: number }
export async function getAccountPositions(creds: KalshiCredentials): Promise<Map<string, AccountPosition>> {
  const out = new Map<string, AccountPosition>();
  const n = (v: unknown) => { const x = parseFloat(String(v ?? '')); return Number.isFinite(x) ? x : NaN; };
  // Settled first, so a market's unsettled entry (the live one) wins if both come back.
  for (const status of ['settled', 'unsettled'] as const) {
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    let r: any;
    try { r = await authed(creds, 'GET', '/portfolio/positions', { params: { limit: 1000, cursor, settlement_status: status } }); }
    catch (e) { if (status === 'settled') break; throw e; }
    for (const p of (r.market_positions ?? []) as any[]) {
      if (!p.ticker) continue;
      out.set(p.ticker, {
        position: n(p.position_fp ?? p.position) || 0,
        realized: n(p.realized_pnl_dollars ?? (p.realized_pnl != null ? n(p.realized_pnl) / 100 : NaN)),
        fees: n(p.fees_paid_dollars ?? (p.fees_paid != null ? n(p.fees_paid) / 100 : NaN)),
      });
    }
    cursor = r.cursor || undefined;
    if (!cursor) break;
  }
  }
  return out;
}
