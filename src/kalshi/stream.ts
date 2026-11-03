/**
 * Real-time Kalshi data over Kalshi's WebSocket API: the feed behind Kalshi Pro's live
 * screens. Read-only: it never places or changes orders.
 *
 *  - ticker:           best bid/ask, last price, volume for the markets we care about
 *  - trade:            the trade tape for markets we hold
 *  - fill:             our own fills, the moment they happen
 *  - market_positions: our positions with cost, realized P/L and fees, as they change
 *
 * Reconnects by itself with backoff; switches between Kalshi's new and legacy hosts.
 */
import { signRequest, type KalshiCredentials } from './client';

const WS_PATH = '/trade-api/ws/v2';
const HOSTS: Record<'prod' | 'demo', string[]> = {
  prod: ['wss://external-api-ws.kalshi.com', 'wss://api.elections.kalshi.com'],
  demo: ['wss://external-api-ws.demo.kalshi.co', 'wss://demo-api.kalshi.co'],
};

export interface TickerState {
  bid: number; ask: number; last: number; volume: number; openInterest: number;
  bidSize: number; askSize: number; ts: number;
}
export interface PositionState {
  ticker: string;
  /** Net contracts: positive = YES, negative = NO. */
  position: number;
  cost: number;
  realized: number;
  fees: number;
  ts: number;
}
export interface FillEvent {
  ticker: string; side: 'yes' | 'no'; count: number; price: number; fee: number;
  isTaker: boolean; orderId: string; clientOrderId?: string; ts: number;
}
export interface TradeEvent { ticker: string; yesPrice: number; count: number; takerSide: string; ts: number }

export type StreamStatus = 'off' | 'connecting' | 'live' | 'reconnecting' | 'error';

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : NaN;
};

export class KalshiStream {
  status: StreamStatus = 'off';
  lastError: string | null = null;
  lastMessageAt = 0;
  connectedAt = 0;
  readonly tickers = new Map<string, TickerState>();
  readonly positions = new Map<string, PositionState>();
  readonly fills: FillEvent[] = [];
  readonly tape = new Map<string, TradeEvent[]>();

  private ws: WebSocket | null = null;
  private wanted = new Set<string>();
  private subscribed = new Set<string>();
  private sids: Record<string, number> = {};
  private nextId = 1;
  private pending = new Map<number, string>();
  private stopped = true;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pinger: ReturnType<typeof setInterval> | null = null;

  constructor(
    private creds: KalshiCredentials,
    private opts: {
      onFill?: (f: FillEvent) => void;
      onPosition?: (p: PositionState) => void;
      /** For tests: connect here instead of Kalshi. */
      url?: string;
      log?: (msg: string) => void;
    } = {},
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.status = 'off';
    if (this.timer) clearTimeout(this.timer);
    if (this.pinger) clearInterval(this.pinger);
    this.timer = null;
    this.pinger = null;
    try { this.ws?.close(); } catch {}
    this.ws = null;
    this.subscribed.clear();
    this.sids = {};
  }

  /** Markets to stream prices (and, for held ones, trades) for. */
  setMarkets(tickers: Iterable<string>): void {
    const next = new Set([...tickers].filter(Boolean).slice(0, 400));
    const same = next.size === this.wanted.size && [...next].every((t) => this.wanted.has(t));
    this.wanted = next;
    if (!same && this.status === 'live') this.syncMarkets();
  }

  private url(): string {
    if (this.opts.url) return this.opts.url;
    const hosts = HOSTS[this.creds.env];
    return hosts[this.attempt % hosts.length] + WS_PATH;
  }

  private connect(): void {
    if (this.stopped) return;
    this.status = this.attempt === 0 ? 'connecting' : 'reconnecting';
    const ts = Date.now().toString();
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url(), {
        headers: {
          'KALSHI-ACCESS-KEY': this.creds.apiKeyId,
          'KALSHI-ACCESS-SIGNATURE': signRequest(this.creds.privateKeyPem, 'GET', WS_PATH, ts),
          'KALSHI-ACCESS-TIMESTAMP': ts,
        },
      } as any);
    } catch (e) {
      this.fail(e);
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.attempt > 0) this.opts.log?.('Kalshi live feed reconnected.');
      this.status = 'live';
      this.lastError = null;
      this.attempt = 0;
      this.connectedAt = Date.now();
      this.lastMessageAt = Date.now();
      this.subscribed.clear();
      this.sids = {};
      this.send('subscribe', { channels: ['fill'] }, 'fill');
      this.send('subscribe', { channels: ['market_positions'] }, 'market_positions');
      this.syncMarkets();
      if (this.pinger) clearInterval(this.pinger);
      this.pinger = setInterval(() => { try { (ws as any).ping?.(); } catch {} }, 20_000);
    };
    ws.onmessage = (ev) => this.onMessage(typeof ev.data === 'string' ? ev.data : String(ev.data));
    ws.onerror = () => { this.lastError = 'connection error'; };
    ws.onclose = (ev) => {
      if (this.pinger) clearInterval(this.pinger);
      this.pinger = null;
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.stopped) return;
      this.fail(new Error(ev.reason || `closed (${ev.code})`));
    };
  }

  private fail(e: unknown): void {
    this.lastError = e instanceof Error ? e.message : String(e);
    this.status = 'reconnecting';
    this.attempt++;
    // Say so once per outage, not on every retry.
    if (this.attempt === 1 || this.attempt === 4) this.opts.log?.(`Kalshi live feed: ${this.lastError}. Retrying; prices fall back to regular updates meanwhile.`);
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.attempt, 5));
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), delay);
  }

  private send(cmd: string, params: Record<string, unknown>, tag?: string): void {
    const id = this.nextId++;
    if (tag) this.pending.set(id, tag);
    try { this.ws?.send(JSON.stringify({ id, cmd, params })); } catch {}
  }

  /** (Re)subscribe ticker + trade for the wanted markets. */
  private syncMarkets(): void {
    const list = [...this.wanted];
    for (const ch of ['ticker', 'trade'] as const) {
      const sid = this.sids[ch];
      if (sid !== undefined) { this.send('unsubscribe', { sids: [sid] }); delete this.sids[ch]; }
      // Ask for the current prices right away: quiet markets may not tick for minutes.
      if (list.length) this.send('subscribe', ch === 'ticker' ? { channels: [ch], market_tickers: list, send_initial_snapshot: true } : { channels: [ch], market_tickers: list }, ch);
    }
    this.subscribed = new Set(list);
  }

  private onMessage(raw: string): void {
    this.lastMessageAt = Date.now();
    let m: any;
    try { m = JSON.parse(raw); } catch { return; }
    const msg = m?.msg ?? {};
    switch (m?.type) {
      case 'subscribed': {
        const tag = this.pending.get(m.id);
        if (tag && msg.sid !== undefined) this.sids[tag] = msg.sid;
        this.pending.delete(m.id);
        return;
      }
      case 'error':
        this.lastError = `Kalshi stream: ${msg.msg ?? 'error'} (${msg.code ?? '?'})`;
        this.opts.log?.(this.lastError);
        return;
      case 'ticker':
      case 'ticker_v2': {
        const t = msg.market_ticker;
        if (!t) return;
        const prev = this.tickers.get(t);
        const pick = (k: string, fallback: number | undefined) => (msg[k] !== undefined ? num(msg[k]) : fallback ?? NaN);
        this.tickers.set(t, {
          bid: pick('yes_bid_dollars', prev?.bid),
          ask: pick('yes_ask_dollars', prev?.ask),
          last: pick('price_dollars', prev?.last),
          volume: pick('volume_fp', prev?.volume),
          openInterest: pick('open_interest_fp', prev?.openInterest),
          bidSize: pick('yes_bid_size_fp', prev?.bidSize),
          askSize: pick('yes_ask_size_fp', prev?.askSize),
          ts: num(msg.ts_ms) || Date.now(),
        });
        return;
      }
      case 'trade': {
        const t = msg.market_ticker;
        if (!t) return;
        const list = this.tape.get(t) ?? [];
        list.unshift({ ticker: t, yesPrice: num(msg.yes_price_dollars), count: num(msg.count_fp), takerSide: msg.taker_outcome_side ?? msg.taker_side ?? '', ts: num(msg.ts_ms) || Date.now() });
        if (list.length > 20) list.length = 20;
        this.tape.set(t, list);
        const cur = this.tickers.get(t);
        if (cur) cur.last = num(msg.yes_price_dollars);
        return;
      }
      case 'fill': {
        const side = (msg.purchased_side ?? msg.side) === 'no' ? 'no' : 'yes';
        const yes = num(msg.yes_price_dollars);
        const f: FillEvent = {
          ticker: msg.market_ticker, side, count: num(msg.count_fp), price: side === 'yes' ? yes : +(1 - yes).toFixed(4),
          fee: num(msg.fee_cost), isTaker: !!msg.is_taker, orderId: msg.order_id, clientOrderId: msg.client_order_id,
          ts: num(msg.ts_ms) || Date.now(),
        };
        this.fills.unshift(f);
        if (this.fills.length > 50) this.fills.length = 50;
        this.opts.onFill?.(f);
        return;
      }
      case 'market_position':
      case 'market_positions': {
        const t = msg.market_ticker;
        if (!t) return;
        const p: PositionState = {
          ticker: t,
          position: num(msg.position_fp),
          cost: num(msg.position_cost_dollars),
          realized: num(msg.realized_pnl_dollars),
          fees: num(msg.fees_paid_dollars),
          ts: Date.now(),
        };
        if (p.position === 0) this.positions.delete(t); else this.positions.set(t, p);
        this.opts.onPosition?.(p);
        return;
      }
    }
  }

  /** Prices from a REST read, used until the stream sends its own. */
  seedTicker(ticker: string, q: { bid: number; ask: number; last: number }): void {
    if (this.tickers.has(ticker) || !Number.isFinite(q.bid) || !Number.isFinite(q.ask)) return;
    this.tickers.set(ticker, { bid: q.bid, ask: q.ask, last: q.last, volume: NaN, openInterest: NaN, bidSize: NaN, askSize: NaN, ts: Date.now() - 60_000 });
  }

  /** Seed positions from the REST snapshot (the stream only sends changes). */
  seedPositions(rows: PositionState[]): void {
    for (const r of rows) if (r.position !== 0 && !this.positions.has(r.ticker)) this.positions.set(r.ticker, r);
  }
}
