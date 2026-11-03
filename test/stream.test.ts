import { afterAll, expect, test } from 'bun:test';
import { generateKeyPairSync, createVerify, constants } from 'node:crypto';
import { KalshiStream } from '../src/kalshi/stream';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const creds = { env: 'prod' as const, apiKeyId: 'key-1', privateKeyPem: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString() };

const received: any[] = [];
let headers: Record<string, string> = {};
let sockets: any[] = [];
const server = Bun.serve({
  port: 0,
  fetch(req, srv) {
    headers = Object.fromEntries(req.headers);
    // Kalshi checks the signature over timestamp + GET + /trade-api/ws/v2.
    const v = createVerify('SHA256');
    v.update(headers['kalshi-access-timestamp'] + 'GET' + '/trade-api/ws/v2');
    const ok = v.verify({ key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, headers['kalshi-access-signature']!, 'base64');
    if (!ok) return new Response('bad signature', { status: 401 });
    return srv.upgrade(req) ? undefined : new Response('no', { status: 400 });
  },
  websocket: {
    open(ws) { sockets.push(ws); },
    message(ws, data) {
      const m = JSON.parse(String(data));
      received.push(m);
      if (m.cmd === 'subscribe') ws.send(JSON.stringify({ id: m.id, type: 'subscribed', msg: { channel: m.params.channels[0], sid: m.id } }));
    },
  },
});
afterAll(() => server.stop(true));

const until = async (f: () => boolean, ms = 3000) => { const t = Date.now(); while (!f() && Date.now() - t < ms) await Bun.sleep(20); return f(); };

test('real-time stream: signed connect, subscriptions, prices, positions, fills, reconnect', async () => {
  const fills: any[] = [];
  const s = new KalshiStream(creds, { url: `ws://127.0.0.1:${server.port}/trade-api/ws/v2`, onFill: (f) => fills.push(f) });
  s.setMarkets(['KXEPLTOTAL-26OCT18ARSCHE-2']);
  s.start();
  expect(await until(() => s.status === 'live')).toBe(true);
  expect(headers['kalshi-access-key']).toBe('key-1');
  expect(await until(() => received.length >= 4)).toBe(true);
  const chans = received.filter((m) => m.cmd === 'subscribe').map((m) => m.params.channels[0]).sort();
  expect(chans).toEqual(['fill', 'market_positions', 'ticker', 'trade']);
  expect(received.find((m) => m.params?.channels?.[0] === 'ticker').params.market_tickers).toEqual(['KXEPLTOTAL-26OCT18ARSCHE-2']);

  const ws = sockets[0];
  ws.send(JSON.stringify({ type: 'ticker', sid: 3, msg: { market_ticker: 'KXEPLTOTAL-26OCT18ARSCHE-2', price_dollars: '0.7100', yes_bid_dollars: '0.7000', yes_ask_dollars: '0.7200', volume_fp: '1500.00', open_interest_fp: '900.00', yes_bid_size_fp: '50.00', yes_ask_size_fp: '20.00', ts_ms: Date.now() } }));
  ws.send(JSON.stringify({ type: 'market_position', sid: 2, msg: { market_ticker: 'KXEPLTOTAL-26OCT18ARSCHE-2', position_fp: '6.00', position_cost_dollars: '4.2600', realized_pnl_dollars: '0.0000', fees_paid_dollars: '0.0900', volume_fp: '6.00' } }));
  ws.send(JSON.stringify({ type: 'fill', sid: 1, msg: { trade_id: 't', order_id: 'o', market_ticker: 'KXEPLTOTAL-26OCT18ARSCHE-2', is_taker: true, side: 'yes', purchased_side: 'yes', yes_price_dollars: '0.7100', count_fp: '6.00', fee_cost: '0.090000', ts_ms: Date.now() } }));
  ws.send(JSON.stringify({ type: 'trade', sid: 4, msg: { market_ticker: 'KXEPLTOTAL-26OCT18ARSCHE-2', yes_price_dollars: '0.7300', count_fp: '10.00', taker_outcome_side: 'yes', ts_ms: Date.now() } }));
  expect(await until(() => fills.length === 1 && s.tape.size === 1)).toBe(true);
  expect(s.tickers.get('KXEPLTOTAL-26OCT18ARSCHE-2')).toMatchObject({ bid: 0.7, ask: 0.72, last: 0.73, volume: 1500 });
  expect(s.positions.get('KXEPLTOTAL-26OCT18ARSCHE-2')).toMatchObject({ position: 6, cost: 4.26, fees: 0.09 });
  expect(fills[0]).toMatchObject({ side: 'yes', count: 6, price: 0.71, fee: 0.09 });

  // Market list changes: resubscribe ticker/trade.
  const before = received.length;
  s.setMarkets(['KXEPLTOTAL-26OCT18ARSCHE-2', 'KXMLSGAME-26OCT18LAFCATX-LAFC']);
  expect(await until(() => received.slice(before).some((m) => m.cmd === 'subscribe' && m.params.market_tickers?.length === 2))).toBe(true);

  // Dropped connection: reconnects and subscribes again.
  ws.close();
  expect(await until(() => s.status !== 'live', 1000)).toBe(true);
  expect(await until(() => s.status === 'live' && sockets.length === 2, 5000)).toBe(true);
  s.stop();
  expect(s.status).toBe('off');
});
