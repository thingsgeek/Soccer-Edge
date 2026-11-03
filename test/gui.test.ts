import { afterAll, beforeAll, describe, expect, setSystemTime, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'se-gui-'));
process.env.SOCCER_EDGE_HOME = home;

const { saveVault, loadVault, WrongPasswordError, vaultPath } = await import('../src/vault');
const { normalizePrivateKey } = await import('../src/kalshi/keys');
const { startGui } = await import('../src/gui/server');

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const KEY_ID = '0a1b2c3d-4e5f-6789-abcd-ef0123456789';
const PG_KEY = 'pg_live_testkey123';

describe('vault', () => {
  test('round trip, wrong password, nothing readable on disk', async () => {
    const secrets = { predygoKey: PG_KEY, kalshiKeyId: KEY_ID, kalshiPrivateKeyPem: PEM };
    await saveVault(secrets, 'correct horse');
    const raw = readFileSync(vaultPath(), 'utf8');
    const decoded = Buffer.from(JSON.parse(raw).data, 'base64').toString();
    expect(raw).not.toContain(PG_KEY);
    expect(decoded).not.toContain(PG_KEY);
    expect(decoded).not.toContain('PRIVATE KEY');
    expect(decoded).not.toContain('correct horse');
    expect(await loadVault('correct horse')).toEqual(secrets);
    await expect(loadVault('wrong horse!')).rejects.toBeInstanceOf(WrongPasswordError);
    await expect(saveVault(secrets, 'short')).rejects.toThrow('at least');
    rmSync(vaultPath());
  });
});

describe('pasted private keys', () => {
  test('accepts a key whose line breaks were lost', () => {
    const flat = PEM.replace(/\n/g, ' ');
    expect(normalizePrivateKey(flat)).toBe(normalizePrivateKey(PEM));
  });
  test('rejects junk and public keys with a clear message', () => {
    expect(() => normalizePrivateKey('hello')).toThrow('does not look like a private key');
    expect(() => normalizePrivateKey('-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----')).toThrow('public key');
  });
});

// ---------------------------------------------------------------- app window, end to end

const realFetch = globalThis.fetch;
const orders: any[] = [];
let pgAuthOk = true;
let eventsFetched = 0;

const kickoff = new Date(Date.now() + 3 * 3600_000);
kickoff.setUTCSeconds(0, 0);
const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');
const mon = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][kickoff.getUTCMonth()];
const evTicker = `KXMLSTOTAL-${String(kickoff.getUTCFullYear()).slice(2)}${mon}${String(kickoff.getUTCDate()).padStart(2, '0')}CINCLB`;
const market = {
  ticker: `${evTicker}-2`, event_ticker: evTicker, title: 'Will over 1.5 goals be scored?', yes_sub_title: 'Over 1.5 goals scored',
  floor_strike: 1.5, strike_type: 'greater', status: 'active',
  yes_ask_dollars: '0.7000', yes_bid_dollars: '0.6900', no_ask_dollars: '0.3100',
  occurrence_datetime: iso(kickoff.getTime() + 3 * 3600_000), close_time: iso(kickoff.getTime() + 48 * 3600_000),
};
// PredyGo stores New York wall time.
const nyWall = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(kickoff);

let heldPositions: { ticker: string; position_fp: string }[] = [];
let app: Awaited<ReturnType<typeof startGui>>;
let base = '';
let token = '';

beforeAll(async () => {
  // These end-to-end tests price from the model alone (market blending has its own tests).
  writeFileSync(join(home, 'config.json'), JSON.stringify({ source: { type: 'file', includeAll: true }, risk: { marketWeight: 0, maxOpenExposurePct: 1, autoSize: false, restOrders: true, rulesOff: ['hitRate'] } }));
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
    if (url.hostname === '127.0.0.1') return realFetch(input, init);
    const auth = init?.headers?.Authorization ?? init?.headers?.authorization;
    if (url.hostname === 'predygo.com') {
      if (!pgAuthOk || auth !== `Bearer ${PG_KEY}`) return Response.json({ error: 'Invalid or disabled API key.' }, { status: 401 });
      // Shapes follow https://predygo.com/api-docs
      if (url.pathname === '/api/v1/me') return Response.json({ tier: 'pro', scope: 'all markets, pre-game only' });
      if (url.pathname === '/api/v1/results') return Response.json({ tier: 'pro', count: 0, results: [] });
      const all = url.searchParams.get('all') === 'true';
      const over15 = { code: 'T+1.5', name: 'Over 1.5 goals', canonical: { market: 'totals', name: 'Over', point: 1.5 } };
      if (url.pathname === '/api/v1/predictions') return Response.json({ tier: 'pro', count: 3, predictions: [
        { id: 1, league: 'USA MLS', home: 'FC Cincinnati', away: 'Columbus Crew', market: over15, confidence: 83, kickoff: nyWall, source: 'pregame', result: 'pending', score: null },
        { id: 2, league: 'Norway Division 1', home: 'Hodd', away: 'Ranheim', market: over15, confidence: 83, kickoff: nyWall, source: 'pregame', result: 'pending', score: null },
        { id: 3, league: 'USA MLS', home: 'FC Cincinnati', away: 'Columbus Crew', market: over15, confidence: 90, kickoff: nyWall, source: 'live', result: 'pending', score: '0-0' },
        { id: 4, league: 'Venezuela Cup', home: 'Aragua', away: 'Caracas', market: { code: 'VISITA MARCA' }, confidence: 78, kickoff: nyWall, source: 'pregame', result: 'pending', posted: true },
        ...(all ? [{ id: 5, league: 'Venezuela Cup', home: 'Aragua', away: 'Caracas', market: { code: 'T+2.5' }, confidence: 70, kickoff: nyWall, source: 'pregame', result: 'pending', posted: false }] : []),
      ] });
    }
    if (url.hostname === 'api.elections.kalshi.com' || url.hostname === 'demo-api.kalshi.co') {
      const signed = !!init?.headers?.['KALSHI-ACCESS-SIGNATURE'];
      if (url.pathname.endsWith('/exchange/status')) return Response.json({ exchange_active: true, trading_active: true }, { headers: { date: new Date().toUTCString() } });
      if (url.pathname.endsWith('/candlesticks')) return Response.json({ ticker: market.ticker, candlesticks: [1, 2, 3].map((i) => ({ end_period_ts: Math.floor(Date.now() / 1000) - (4 - i) * 3600, yes_bid: { close_dollars: (0.6 + i * 0.02).toFixed(4) }, yes_ask: { close_dollars: (0.62 + i * 0.02).toFixed(4) } })) });
      if (url.pathname.endsWith('/series')) return Response.json({ series: [{ ticker: 'KXMLSTOTAL', title: 'MLS Total', tags: ['Soccer'] }] });
      if (url.pathname.endsWith('/events')) {
        const st = url.searchParams.get('series_ticker');
        if (st === 'KXMLSTOTAL') eventsFetched++;
        return Response.json({ cursor: '', events: st === 'KXMLSTOTAL' ? [{ event_ticker: evTicker, series_ticker: st, title: 'Cincinnati vs Columbus: Total Goals', markets: [market] }] : [] });
      }
      if (url.hostname === 'demo-api.kalshi.co') return new Response('unauthorized', { status: 401 });
      if (!signed || init.headers['KALSHI-ACCESS-KEY'] !== KEY_ID) return new Response('unauthorized', { status: 401 });
      if (url.pathname.endsWith('/portfolio/balance')) return Response.json({ balance: 50_000, portfolio_value: 216 });
      if (url.pathname.endsWith('/portfolio/fills')) return Response.json({ fills: [{ ticker: market.ticker, count: 3 }], cursor: '' });
      if (url.pathname.endsWith('/portfolio/settlements')) return Response.json({ settlements: [], cursor: '' });
      // The trade reconciliation reads unsettled positions: this account still holds what the app bought.
      if (url.pathname.endsWith('/portfolio/positions') && url.searchParams.get('settlement_status') === 'unsettled') return Response.json({ market_positions: [{ ticker: market.ticker, position_fp: '1000.00' }], cursor: '' });
      if (url.pathname.endsWith('/portfolio/positions')) return Response.json({ market_positions: heldPositions, cursor: '' });
      if (url.pathname.endsWith('/portfolio/fills')) return Response.json({ fills: [], cursor: '' });
      if (url.pathname.includes('/markets/')) return Response.json({ market });
      if (url.pathname.endsWith('/portfolio/events/orders')) {
        const b = JSON.parse(init.body);
        orders.push(b);
        return Response.json({ order_id: 'o1', fill_count: b.count, remaining_count: '0.00', average_fill_price: b.price, average_fee_paid: '0.0200' }, { status: 201 });
      }
    }
    return new Response('not mocked: ' + url, { status: 599 });
  }) as typeof fetch;
  app = await startGui({ openWindow: false, exitWhenIdle: false });
  base = `http://127.0.0.1:${app.port}`;
  token = new URL(app.url).searchParams.get('t')!;
});

afterAll(() => {
  app?.stop();
  globalThis.fetch = realFetch;
  rmSync(home, { recursive: true, force: true });
});

const api = async (path: string, body: object = {}, tok = token) => {
  const r = await realFetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-session': tok }, body: JSON.stringify(body) });
  const text = await r.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch {}
  return { status: r.status, data };
};

describe('app window', () => {
  test('page and API refuse requests without the launch token', async () => {
    expect((await realFetch(base + '/')).status).toBe(403);
    expect((await realFetch(base + '/?t=nope')).status).toBe(403);
    expect((await realFetch(base + '/?t=' + token)).status).toBe(200);
    expect((await api('/api/state', {}, 'bad')).status).toBe(403);
  });

  test('first run shows the disclaimer; nothing can be set up until both boxes are ticked', async () => {
    expect((await api('/api/state')).data).toMatchObject({ disclaimerAccepted: false, vaultExists: false, unlocked: false });
    expect((await api('/api/create', { password: 'secret-pass' })).data.error).toContain('Accept the disclaimer first');
    expect((await api('/api/unlock', { password: 'secret-pass' })).data.error).toContain('Accept the disclaimer first');
    expect((await api('/api/disclaimer/accept', { acks: [true, false] })).data.error).toContain('Tick both boxes');
    expect((await api('/api/disclaimer/accept', { acks: [true, true] })).data).toMatchObject({ ok: true });
    expect((await api('/api/state')).data).toMatchObject({ disclaimerAccepted: true });
  });

  test('first run asks for setup', async () => {
    const s = await api('/api/state');
    expect(s.data).toMatchObject({ vaultExists: false, unlocked: false });
  });

  test('setup validates inputs with clear messages', async () => {
    const good = { predygoKey: PG_KEY, kalshiKeyId: KEY_ID, kalshiPrivateKey: PEM, usState: 'FL', password: 'secret-pass', confirm: 'secret-pass' };
    expect((await api('/api/create', { ...good, confirm: 'different' })).data.error).toContain('do not match');
    expect((await api('/api/create', { ...good, kalshiPrivateKey: 'junk' })).data.error).toContain('private key');
    expect((await api('/api/create', { ...good, usState: '' })).data.error).toContain('state');
    expect((await api('/api/create', { ...good, country: 'GB', usState: '' })).data.error).toContain('excludes United Kingdom');
    pgAuthOk = false;
    expect((await api('/api/create', good)).data.error).toContain('Invalid or disabled API key');
    pgAuthOk = true;
    const ok = await api('/api/create', { ...good, kalshiPrivateKey: PEM.replace(/\n/g, ' ') });
    expect(ok.status).toBe(200);
    const s = (await api('/api/state')).data;
    expect(s).toMatchObject({ unlocked: true, env: 'prod', usState: 'FL', country: 'US', regionLabel: 'FL, United States', cash: 500, predygo: { tier: 'pro' } });
    expect(existsSync(join(home, 'vault.dat'))).toBe(true);
    expect(readFileSync(join(home, 'config.json'), 'utf8')).not.toContain(PG_KEY);
  });

  test('lock, wrong password, unlock', async () => {
    await api('/api/lock');
    expect((await api('/api/state')).data.unlocked).toBe(false);
    expect((await api('/api/scan')).status).toBe(401);
    expect((await api('/api/unlock', { password: 'nope-nope' })).status).toBe(401);
    expect((await api('/api/unlock', { password: 'secret-pass' })).status).toBe(200);
    expect((await api('/api/state')).data.unlocked).toBe(true);
  });

  test('scan pulls PredyGo picks with the saved key and prices them on Kalshi', async () => {
    expect((await api('/api/scan')).status).toBe(200);
    const s = (await api('/api/state')).data;
    expect(s.feedMode).toBe('posted'); // published picks only, always
    expect(s.positions).toBe(2.16); // Kalshi's portfolio_value = open positions, shown next to cash
    expect(s.scan.upcoming).toBe(4);
    expect(s.scan.matched).toBe(1);
    expect(s.scan.unmatched['in-play pick (not traded)']).toBe(1);
    const row = s.scan.rows[0];
    expect(row).toMatchObject({ match: 'FC Cincinnati v Columbus Crew', pick: 'T+1.5', ticker: market.ticker, tradable: true });
    expect(row.edge).toBeGreaterThan(0.05);
    expect(s.scan.unmatched['league not mapped to Kalshi']).toBe(2); // Norway Div 1 + Venezuela Cup (model pick)
  });

  test('Place sends one guarded order; kill switch blocks the next', async () => {
    const id = (await api('/api/state')).data.scan.rows[0].id;
    expect((await api('/api/place', { id })).status).toBe(200);
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ ticker: market.ticker, side: 'bid', price: '0.7000', time_in_force: 'fill_or_kill' });
    const s = (await api('/api/state')).data;
    expect(s.log.some((l: any) => l.level === 'trade')).toBe(true);
    expect(s.spentToday).toBeGreaterThan(0);

    await api('/api/kill');
    await api('/api/place', { id });
    expect(orders).toHaveLength(1);
    expect((await api('/api/auto', { on: true })).data.error).toContain('kill switch');
    await api('/api/resume');
  });

  test('old prices: shown as stale and Place refuses until the next scan', async () => {
    await api('/api/scan');
    let s = (await api('/api/state')).data;
    expect(s.scan.stale).toBe(false);
    expect(s.auto.intervalMin).toBe(5);
    expect(s.auto.nextAt).not.toBeNull(); // prices refresh on their own, auto-trade or not
    const n = orders.length;
    setSystemTime(new Date(Date.now() + 8 * 60_000));
    try {
      s = (await api('/api/state')).data;
      expect(s.scan.stale).toBe(true);
      expect(s.scan.ageSec).toBeGreaterThanOrEqual(8 * 60 - 1);
      const r = await api('/api/place', { id: s.scan.rows[0].id });
      expect(r.data.error).toContain('minutes old');
      expect(orders).toHaveLength(n);
    } finally { setSystemTime(); }
  });

  test('a trade survives an update that changes prediction ids, and Kalshi holdings count too', async () => {
    const lp = join(home, 'ledger.jsonl');
    // Rewrite the earlier order as if an older version had recorded it under a different id.
    writeFileSync(lp, readFileSync(lp, 'utf8').replace(/"predictionId":"[^"]+"/g, '"predictionId":"old-format-id"'));
    await api('/api/scan');
    let row = (await api('/api/state')).data.scan.rows[0];
    expect(row).toMatchObject({ status: 'traded', tradable: false });
    expect((await api('/api/place', { id: row.id })).data.error).toContain('already bought');
    // No local record at all (new PC, or bought on kalshi.com): Kalshi's positions still block it.
    writeFileSync(lp, '');
    heldPositions = [{ ticker: market.ticker, position_fp: '3.00' }];
    await api('/api/scan');
    row = (await api('/api/state')).data.scan.rows[0];
    expect(row).toMatchObject({ status: 'holding', tradable: false });
    expect((await api('/api/place', { id: row.id })).data.error).toContain('already hold');
    expect(orders).toHaveLength(1);
  });

  test('Place anyway: overrides the edge check for one pick, within the limits', async () => {
    writeFileSync(join(home, 'ledger.jsonl'), '');
    heldPositions = [];
    market.yes_ask_dollars = '0.8900';
    market.yes_bid_dollars = '0.8800';
    const { clearMarketCache } = await import('../src/kalshi/markets');
    clearMarketCache();
    try {
      // Buy at my price (default on): the 89c ask is too high, so the pick gets a bid below it.
      await api('/api/scan');
      const bid = (await api('/api/state')).data.scan.rows[0];
      expect(bid.tradable).toBe(true);
      expect(bid.rest.price).toBeLessThan(0.89);
      expect(bid.rest.price).toBeLessThanOrEqual(bid.rest.maxPay);
      expect(bid.rest.ask).toBe(0.89);
      // Off: as before, the pick is skipped on edge and "Place anyway" is offered.
      expect((await api('/api/settings', { risk: { restOrders: false } })).status).toBe(200);
      await api('/api/scan');
      const row = (await api('/api/state')).data.scan.rows[0];
      expect(row.tradable).toBe(false);
      expect(row.status).toContain('edge');
      expect(row.maxForce).toBeGreaterThan(1);
      expect((await api('/api/place', { id: row.id })).data.error).toContain('Not tradable');
      expect((await api('/api/place', { id: row.id, force: true, contracts: 999 })).data.error).toContain('At most');
      const n = orders.length;
      const r = await api('/api/place', { id: row.id, force: true, contracts: 2 });
      expect(r.data).toMatchObject({ ok: true, placed: 1 });
      expect(orders).toHaveLength(n + 1);
      expect(orders[n]).toMatchObject({ ticker: market.ticker, count: '2.00', price: '0.8900' });
      expect((await api('/api/state')).data.scan.rows[0].status).toBe('traded');
    } finally {
      market.yes_ask_dollars = '0.7000';
      market.yes_bid_dollars = '0.6900';
      clearMarketCache();
      await api('/api/settings', { risk: { restOrders: true } });
    }
  });

  test('with auto-trading on, Scan now also places what passes', async () => {
    const lp = join(home, 'ledger.jsonl');
    const saved = readFileSync(lp, 'utf8');
    writeFileSync(lp, '');
    heldPositions = [];
    const { clearMarketCache } = await import('../src/kalshi/markets');
    clearMarketCache();
    const n = orders.length;
    await api('/api/scan');
    expect(orders).toHaveLength(n); // auto off: scan only
    expect((await api('/api/auto', { on: true })).status).toBe(200);
    try {
      await api('/api/scan');
      expect(orders.length).toBe(n + 1);
      expect((await api('/api/state')).data.scan.rows[0].status).toBe('traded');
    } finally {
      await api('/api/auto', { on: false });
      writeFileSync(lp, saved + readFileSync(lp, 'utf8'));
    }
  });

  test('a ready pick that auto-trade could not buy shows why (order-time check)', async () => {
    const lp = join(home, 'ledger.jsonl');
    const saved = readFileSync(lp, 'utf8');
    writeFileSync(lp, '');
    heldPositions = [];
    const { clearMarketCache } = await import('../src/kalshi/markets');
    clearMarketCache();
    (market as any).yes_ask_size_fp = '0.40'; // the table can't see this; the order step can
    const n = orders.length;
    expect((await api('/api/auto', { on: true })).status).toBe(200);
    try {
      await api('/api/scan');
      expect(orders.length).toBe(n);
      const row = (await api('/api/state')).data.scan.rows[0];
      expect(row.tradable).toBe(true);
      expect(row.autoNote).toMatch(/^only 0\.4 contract\(s\) for sale at \d+¢ right now \(/);
    } finally {
      delete (market as any).yes_ask_size_fp;
      await api('/api/auto', { on: false });
      writeFileSync(lp, saved + readFileSync(lp, 'utf8'));
    }
  });

  test('Export data: one file with orders, decisions, results and settings, and no secrets', async () => {
    const r = await api('/api/export', { reveal: false });
    expect(r.status).toBe(200);
    const text = readFileSync(r.data.path, 'utf8');
    expect(text).not.toContain(PG_KEY);
    expect(text).not.toContain('PRIVATE KEY');
    expect(text).not.toContain(KEY_ID);
    const d = JSON.parse(text);
    expect(d).toMatchObject({ format: 1, app: 'Soccer Edge' });
    expect(d.orders.length).toBeGreaterThan(0);
    expect(d.orders[0]).toMatchObject({ ticker: market.ticker, source: expect.any(String) });
    expect(d.pregameDecisions.length).toBeGreaterThan(0);
    expect(d.pregameDecisions[0]).toMatchObject({ ticker: market.ticker, probability: expect.any(Number), ask: expect.any(Number) });
    expect(d.kalshi.markets[market.ticker]).toMatchObject({ status: 'active' });
    expect(d.settings.risk.minProbability).toBeDefined();
    expect(d.notes.purpose).toContain('Soccer Edge');
    // Download link works only with the token.
    expect((await realFetch(`${base}/export/${r.data.fileName}?t=${token}`)).status).toBe(200);
    expect((await realFetch(`${base}/export/${r.data.fileName}?t=bad`)).status).toBe(403);
    expect((await realFetch(`${base}/export/..%2Fvault.dat?t=${token}`)).status).toBe(404);
  });

  test('Real-time Kalshi data: positions with live price and P/L, fills in the log', async () => {
    let sock: any = null;
    const ws = Bun.serve({
      port: 0,
      fetch(req, srv) { return srv.upgrade(req) ? undefined : new Response('no', { status: 400 }); },
      websocket: {
        open(w) { sock = w; },
        message(w, d) { const m = JSON.parse(String(d)); if (m.cmd === 'subscribe') w.send(JSON.stringify({ id: m.id, type: 'subscribed', msg: { sid: m.id } })); },
      },
    });
    process.env.SOCCER_EDGE_WS_URL = `ws://127.0.0.1:${ws.port}/trade-api/ws/v2`;
    try {
      expect((await api('/api/state')).data.pro.on).toBe(true); // on by default
      await api('/api/pro', { on: false });
      expect((await api('/api/pro', { on: true })).status).toBe(200);
      for (let i = 0; i < 100 && !sock; i++) await Bun.sleep(20);
      sock.send(JSON.stringify({ type: 'market_position', msg: { market_ticker: market.ticker, position_fp: '4.00', position_cost_dollars: '2.8000', realized_pnl_dollars: '0', fees_paid_dollars: '0.06' } }));
      // No price ticks yet (quiet market): value comes from Kalshi's REST prices.
      let r0: any;
      for (let i = 0; i < 100; i++) { r0 = (await api('/api/state')).data.pro.positions[0]; if (r0?.bid != null) break; await Bun.sleep(30); }
      expect(r0).toMatchObject({ bid: 0.69, value: 2.76 });
      sock.send(JSON.stringify({ type: 'ticker', msg: { market_ticker: market.ticker, price_dollars: '0.8000', yes_bid_dollars: '0.7900', yes_ask_dollars: '0.8100', volume_fp: '100.00', open_interest_fp: '10.00', yes_bid_size_fp: '1.00', yes_ask_size_fp: '1.00', ts_ms: Date.now() } }));
      sock.send(JSON.stringify({ type: 'fill', msg: { market_ticker: market.ticker, purchased_side: 'yes', yes_price_dollars: '0.7000', count_fp: '4.00', fee_cost: '0.06', order_id: 'o', ts_ms: Date.now() } }));
      let s: any;
      for (let i = 0; i < 100; i++) { s = (await api('/api/state')).data; if (s.pro.positions[0]?.bid === 0.79 && s.log.some((l: any) => l.msg.startsWith('Kalshi fill'))) break; await Bun.sleep(30); }
      expect(s.pro).toMatchObject({ on: true, status: 'live' });
      expect(s.pro.positions[0]).toMatchObject({ ticker: market.ticker, side: 'yes', contracts: 4, cost: 2.8, bid: 0.79, value: 3.16, pnl: 0.36 });
      expect(s.log.some((l: any) => l.msg.startsWith('Kalshi fill: 4 × YES'))).toBe(true);
      // Goal: the over 1.5 is in -> YES jumps to 99c. Shown as won right away, and logged once.
      expect((await api('/api/state')).data.trades.rows[0].decided).toBeNull();
      sock.send(JSON.stringify({ type: 'ticker', msg: { market_ticker: market.ticker, price_dollars: '0.9900', yes_bid_dollars: '0.9900', yes_ask_dollars: '1.0000', volume_fp: '120.00', open_interest_fp: '10.00', yes_bid_size_fp: '1.00', yes_ask_size_fp: '1.00', ts_ms: Date.now() } }));
      for (let i = 0; i < 100; i++) { s = (await api('/api/state')).data; if (s.trades.rows[0]?.decided === 'won') break; await Bun.sleep(30); }
      expect(s.trades.rows[0]).toMatchObject({ decided: 'won', now: 1 });
      expect(s.trades.totals.decidedWon).toBeGreaterThan(0);
      s = (await api('/api/state')).data;
      expect(s.log.filter((l: any) => l.msg.startsWith('✓ WON')).length).toBeGreaterThan(0);
      expect(new Set(s.log.filter((l: any) => l.msg.startsWith('✓ WON')).map((l: any) => l.msg)).size).toBe(s.log.filter((l: any) => l.msg.startsWith('✓ WON')).length);
      expect((await api('/api/openurl', { url: 'https://evil.example.com' })).data.error).toContain('Only Kalshi');
      expect((await api('/api/pro', { on: false })).status).toBe(200);
      s = (await api('/api/state')).data;
      expect(s.pro.on).toBe(false);
      // Your trades: every filled order with stake, value now and P/L.
      expect(s.trades.rows.length).toBeGreaterThan(0);
      expect(s.trades.rows[0]).toMatchObject({ ticker: market.ticker, side: 'yes', status: 'open', cost: expect.any(Number) });
      expect(s.trades.totals.open).toBeGreaterThan(0);
      expect(s.balanceHistory.length).toBeGreaterThan(0);
    } finally { delete process.env.SOCCER_EDGE_WS_URL; ws.stop(true); }
  });

  test('price chart for a trade', async () => {
    const r = await api('/api/chart', { ticker: market.ticker, side: 'yes', from: Date.now() - 3 * 3600e3 });
    expect(r.data.points.slice(0, 3).map((p: any) => p.v)).toEqual([0.62, 0.64, 0.66]);
    const no = await api('/api/chart', { ticker: market.ticker, side: 'no', from: Date.now() - 3 * 3600e3 });
    expect(no.data.points[0].v).toBeCloseTo(1 - 0.64, 4);
    expect((await api('/api/chart', { ticker: '../x' })).data.error).toBeDefined();
  });

  test('Claude assistant: key saved encrypted after a check; only the pre-trade check remains', async () => {
    let lastChat: any = null;
    const ai = Bun.serve({
      port: 0,
      async fetch(req) {
        // Model discovery: Anthropic's list, with one retired model gone and a new one added.
        if (req.method === 'GET') return Response.json({ data: [{ id: 'claude-new-6', display_name: 'Claude New 6', created_at: '2026-11-01T00:00:00Z' }, { id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5', created_at: '2026-06-09T00:00:00Z' }], has_more: false });
        const body: any = await req.json();
        const sys = String(body.system);
        if (sys.includes('THE APP DATA')) { lastChat = body; return Response.json({ content: [{ type: 'text', text: 'Over 1.5 picks made +$2.10 on 12 trades.' }], usage: { input_tokens: 9000, output_tokens: 80 } }); }
        const out = sys.startsWith('Reply with ok') ? { ok: true }
          : sys.includes('You review') ? { summary: 'Few trades so far; results are mostly noise.', tuning: [{ setting: 'minEdge', suggested: 0.07, reason: 'thin edges lost', confidence: 0.8 }, { setting: 'maxDailySpend', suggested: 500, reason: 'more volume', confidence: 0.9 }], watchlist: ['live 70-90 min'] }
          : { verdict: 'ok', reason: 'fine', issues: [] };
        return Response.json({ content: [{ type: 'text', text: JSON.stringify(out) }], usage: { input_tokens: 1000, output_tokens: 200 } });
      },
    });
    process.env.SOCCER_EDGE_ANTHROPIC_URL = `http://127.0.0.1:${ai.port}/v1/messages`;
    try {
      expect((await api('/api/state')).data.ai.hasKey).toBe(false);
      expect((await api('/api/ai/key', { key: 'nope', password: 'secret-pass' })).data.error).toContain('sk-ant-');
      expect((await api('/api/ai/key', { key: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz', password: 'wrong-pass' })).data.error).toContain('Wrong app password');
      expect((await api('/api/ai/key', { key: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz', password: 'secret-pass' })).status).toBe(200);
      expect(readFileSync(join(home, 'vault.dat'), 'utf8')).not.toContain('sk-ant-api03');
      let s = (await api('/api/state')).data;
      expect(s.ai).toMatchObject({ hasKey: true, settings: { precheck: 'off', checkModel: 'claude-haiku-5-5' } });
      expect(s.ai.modelsFrom).toBe('provider');                              // asked Anthropic which models the key can use
      expect(s.ai.models.map((m: any) => m.id)).toEqual(['claude-new-6', 'claude-haiku-5-5']);
      expect((await api('/api/ai/settings', { checkModel: 'claude-opus-5-5' })).data.error).toContain("doesn't offer");
      expect(s.ai.review).toBeUndefined();
      expect(s.manager).toBeUndefined();
      expect((await api('/api/ai/review')).status).toBe(404);   // no reviews or manager in the app
      expect((await api('/api/ai/manager')).status).toBe(404);
      // ChatGPT: its own key; switching changes the assistant and its model list (one at a time)
      expect((await api('/api/ai/settings', { provider: 'chatgpt' })).status).toBe(200);
      s = (await api('/api/state')).data;
      expect(s.ai).toMatchObject({ provider: 'chatgpt', hasKey: false, keys: { claude: true, chatgpt: false }, settings: { checkModel: 'gpt-6-luna' } });
      expect(s.ai.models.every((m: any) => m.provider === 'chatgpt')).toBe(true);
      expect((await api('/api/ai/key', { provider: 'chatgpt', key: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz', password: 'secret-pass' })).data.error).toContain('Anthropic');
      expect((await api('/api/ai/settings', { provider: 'claude' })).status).toBe(200);
      s = (await api('/api/state')).data;
      expect(s.ai).toMatchObject({ provider: 'claude', hasKey: true, settings: { checkModel: 'claude-haiku-5-5' } });
      expect((await api('/api/ai/settings', { precheck: 'advise', dailyBudgetUsd: 2 })).status).toBe(200);
      // Ask the AI: read-only, answers from a key-free snapshot of the app
      expect((await api('/api/ai/chat', { messages: [{ role: 'user', content: 'How are my bets doing?' }] })).data.error).toContain('Use Claude');
      await api('/api/ai/settings', { enabled: true });
      const chat = (await api('/api/ai/chat', { messages: [{ role: 'user', content: 'How are my bets doing?' }] })).data;
      expect(chat.reply).toContain('Over 1.5');
      expect(lastChat.messages).toEqual([{ role: 'user', content: 'How are my bets doing?' }]);
      expect(lastChat.system).toContain('rulesInForce');
      expect(lastChat.system).not.toContain('sk-ant-api03');
      expect(lastChat.system).not.toContain('PRIVATE KEY');
      expect(lastChat.system).not.toContain(PG_KEY);
      expect((await api('/api/ai/chat', { messages: [] })).data.error).toContain('Type a question');
      await api('/api/ai/settings', { enabled: false });
      expect((await api('/api/state')).data.ai.settings).toMatchObject({ precheck: 'advise', dailyBudgetUsd: 2 });
    } finally { delete process.env.SOCCER_EDGE_ANTHROPIC_URL; ai.stop(true); }
  });

  test('diagnostics explain every pick and check every connection', async () => {
    expect((await api('/api/diagnostics')).status).toBe(200);
    let d: any;
    for (let i = 0; i < 100; i++) {
      d = (await api('/api/state')).data.diagnostics;
      if (!d.running) break;
      await Bun.sleep(100);
    }
    expect(d.error).toBeNull();
    const r = d.report;
    const check = (name: string) => r.checks.find((c: any) => c.name === name);
    expect(check('API key').status).toBe('ok');
    expect(r.checks.some((c: any) => /Full prediction list|In use/.test(c.name))).toBe(false);
    expect(check('Account').detail).toContain('LIVE');
    expect(check('PC clock').status).toBe('ok');
    expect(check('Region').status).toBe('ok');
    const byLabel = (l: string, bet: string) => r.picks.find((p: any) => p.label === l && p.bet === bet);
    const cin = r.picks.find((p: any) => p.label === 'FC Cincinnati v Columbus Crew' && p.verdict !== 'info');
    expect(cin.steps.map((s: any) => s.step)).toEqual(['Timing', 'Bet type', 'League', 'Kalshi markets', 'Game', 'Contract', 'Win probability', 'Price', 'Checks']);
    expect(['ok', 'warn']).toContain(cin.verdict); // already traded earlier in this test run -> still priced
    const ven = byLabel('Aragua v Caracas', 'VISITA MARCA');
    expect(ven.verdict).toBe('fail');
    expect(ven.summary).toContain('League not on Kalshi');
    expect(r.picks.some((p: any) => p.summary.includes('In-play'))).toBe(true);
    expect(d.text).toContain('Soccer Edge diagnostics');
    expect(d.text).not.toContain(PG_KEY);
    expect(d.text).not.toContain('PRIVATE KEY');
  });

  test('market data refreshes between scans', async () => {
    const before = eventsFetched;
    await api('/api/scan');
    expect(eventsFetched).toBeGreaterThan(before - 1); // fetched or within TTL
    const { clearMarketCache } = await import('../src/kalshi/markets');
    clearMarketCache();
    const mid = eventsFetched;
    await api('/api/scan');
    expect(eventsFetched).toBe(mid + 1);
  });

  test('settings validate and persist', async () => {
    expect((await api('/api/settings', { risk: { maxDailySpend: -5 } })).data.error).toContain('Daily limit');
    // Published picks only, always: a request to turn it off is ignored.
    expect((await api('/api/settings', { postedOnly: false })).status).toBe(200);
    expect((await api('/api/state')).data.postedOnly).toBe(true);
    const { loadConfig } = await import('../src/config');
    expect(loadConfig().source.includeAll).toBe(false);
    expect((await api('/api/settings', { usState: 'TX', risk: { maxDailySpend: 40, minEdge: 0.05 } })).status).toBe(200);
    let s = (await api('/api/state')).data;
    expect(s.usState).toBe('TX');
    // Colombia: allowed, no state
    expect((await api('/api/settings', { country: 'CO' })).status).toBe(200);
    s = (await api('/api/state')).data;
    expect(s).toMatchObject({ country: 'CO', usState: null, regionLabel: 'Colombia', eligibility: null });
    // Canada: excluded by Kalshi, trading disabled
    await api('/api/settings', { country: 'CA' });
    s = (await api('/api/state')).data;
    expect(s.eligibility).toContain('excludes Canada');
    await api('/api/settings', { country: 'US', usState: 'TX' });
    s = (await api('/api/state')).data;
    expect(s.risk.maxDailySpend).toBe(40);
    // Refresh interval: 2-60 minutes
    expect((await api('/api/settings', { scanIntervalMin: 1 })).data.error).toContain('between 2 and 60');
    expect((await api('/api/settings', { scanIntervalMin: 61 })).data.error).toContain('between 2 and 60');
    expect((await api('/api/settings', { scanIntervalMin: 10 })).status).toBe(200);
    s = (await api('/api/state')).data;
    expect(s.auto.intervalMin).toBe(10);
    expect(Date.parse(s.auto.nextAt) - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).scanIntervalMin).toBe(10);
    expect((await api('/api/preset')).status).toBe(404); // no "Use recommended": Restore defaults is the one preset
  });

  test('every setting can be changed in the window, and Restore defaults puts them all back', async () => {
    const { DEFAULT_CONFIG } = await import('../src/config');
    expect((await api('/api/settings', { risk: { kellyMultiplier: 3 } })).data.error).toContain('Kelly fraction');
    expect((await api('/api/settings', { calibration: 'magic' })).data.error).toContain('hit rate');
    expect((await api('/api/settings', {
      risk: { kellyMultiplier: 0.5, maxContractsPerOrder: 12, maxSpreadCents: 5, minMinutesBeforeKickoff: 30, requireStatedAboveCost: false, maxNotionalPerOrder: 7 },
      minStatedPct: 70, calibration: 'stated', liveMaxPriceJump: 0.3, livePollSec: 20,
    })).status).toBe(200);
    await api('/api/settings', { risk: { tradeHighRisk: true } });
    await api('/api/rules/toggle', { id: 'edge', on: true });
    let s = (await api('/api/state')).data;
    expect(s.minStatedPct).toBe(70);
    expect(s.calibrationMode).toBe('stated');
    expect(s.defaults.risk.maxNotionalPerOrder).toBe(DEFAULT_CONFIG.risk.maxNotionalPerOrder);
    const region = { country: s.country, usState: s.usState };
    expect((await api('/api/settings/defaults')).status).toBe(200);
    s = (await api('/api/state')).data;
    const d = DEFAULT_CONFIG.risk;
    expect(s.risk).toMatchObject({ kellyMultiplier: d.kellyMultiplier, maxContractsPerOrder: d.maxContractsPerOrder, maxSpreadCents: d.maxSpreadCents,
      minMinutesBeforeKickoff: d.minMinutesBeforeKickoff, requireStatedAboveCost: d.requireStatedAboveCost });
    expect(s.rules.find((r: any) => r.id === 'edge').on).toBe(false);   // rule switches back to defaults
    expect(s.rules.find((r: any) => r.id === 'onePerMatch').on).toBe(true);
    expect(s.risk.tradeHighRisk).toBeFalsy();
    expect(s.live.pollSec).toBe(DEFAULT_CONFIG.live.pollSec);
    expect(s.live.mode).toBe(DEFAULT_CONFIG.live.mode);
    expect(s.calibrationMode).toBe(DEFAULT_CONFIG.calibration);
    expect(s.minStatedPct).toBe(DEFAULT_CONFIG.source.minStatedPct ?? 0);
    expect(s.auto.on).toBe(false);
    expect({ country: s.country, usState: s.usState }).toEqual(region);   // region kept
    expect(s.unlocked).toBe(true);                                         // keys kept
  });

  test('every rule has a switch in the Rules panel', async () => {
    const rule = (s: any, id: string) => s.rules.find((r: any) => r.id === id);
    let s = (await api('/api/state')).data;
    expect(rule(s, 'game').locked).toContain('Always on');
    expect((await api('/api/rules/toggle', { id: 'game', on: false })).data.error).toContain("can't be switched off");
    expect((await api('/api/rules/toggle', { id: 'nope', on: false })).data.error).toContain('Unknown rule');
    // A rule in the switched-off list
    expect((await api('/api/rules/toggle', { id: 'minute80', on: false })).status).toBe(200);
    s = (await api('/api/state')).data;
    expect(rule(s, 'minute80')).toMatchObject({ on: false, status: 'switched off' });
    expect(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).risk.rulesOff).toContain('minute80');
    await api('/api/rules/toggle', { id: 'minute80', on: true });
    expect(rule((await api('/api/state')).data, 'minute80').on).toBe(true);
    // A rule that is a setting
    await api('/api/rules/toggle', { id: 'block25', on: true });
    s = (await api('/api/state')).data;
    expect(s.risk.blockOver25).toBe(true);
    expect(rule(s, 'block25').on).toBe(true);
    await api('/api/rules/toggle', { id: 'highRisk', on: false });
    expect((await api('/api/state')).data.risk.tradeHighRisk).toBe(true);
    await api('/api/rules/toggle', { id: 'highRisk', on: true });
    // A rule that is off by default can be switched on
    expect((await api('/api/rules/toggle', { id: 'edge', on: true })).status).toBe(200);
    expect(rule((await api('/api/state')).data, 'edge').on).toBe(true);
    await api('/api/rules/toggle', { id: 'edge', on: false });
    // Values behind a rule are edited next to its switch (shown units in, stored units out)
    expect(rule(s, 'minProb').fields[0]).toMatchObject({ path: 'risk.minProbability', unit: '%' });
    expect((await api('/api/rules/set', { id: 'minProb', path: 'risk.minProbability', value: 72 })).status).toBe(200);
    s = (await api('/api/state')).data;
    expect(s.risk.minProbability).toBe(0.72);
    expect(rule(s, 'minProb').fields[0].value).toBe(72);
    expect((await api('/api/rules/set', { id: 'minProb', path: 'risk.minProbability', value: 150 })).data.error).toContain('0-99');
    expect((await api('/api/rules/set', { id: 'minProb', path: 'risk.maxPrice', value: 50 })).data.error).toContain('Unknown rule setting');
    expect((await api('/api/rules/set', { id: 'stake', path: 'risk.stakeMode', value: 'yolo' })).data.error).toContain('Flat or Kelly');
    expect((await api('/api/rules/set', { id: 'liveJump', path: 'live.maxPriceJump', value: 20 })).status).toBe(200);
    expect((await api('/api/state')).data.live.maxPriceJump).toBe(0.2);
    // Pre-game switch off stops auto-buying only: a pick can still be placed by hand
    await api('/api/trading', { pregame: false });
    expect((await api('/api/place', { id: 'anything' })).data.error ?? '').not.toContain('Pre-game');
    await api('/api/trading', { pregame: true });
    // The kill switch row is the kill switch
    await api('/api/rules/toggle', { id: 'kill', on: true });
    expect(rule((await api('/api/state')).data, 'kill')).toMatchObject({ on: true, status: 'on' });
    await api('/api/rules/toggle', { id: 'kill', on: false });
    expect(rule((await api('/api/state')).data, 'kill').on).toBe(false);
  });

  test('forget deletes the vault only with confirmation', async () => {
    await api('/api/lock');
    expect((await api('/api/forget', { confirm: 'yes' })).data.error).toContain('DELETE');
    expect((await api('/api/forget', { confirm: 'DELETE' })).status).toBe(200);
    expect(existsSync(join(home, 'vault.dat'))).toBe(false);
  });
});

test('page script parses (no syntax errors in the app window)', async () => {
  const { renderPage } = await import('../src/gui/page');
  const html = renderPage('t');
  const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
  expect(() => new Function(script)).not.toThrow();
});

test('every element the page script uses exists before the script runs', async () => {
  const { renderPage } = await import('../src/gui/page');
  const html = renderPage('t');
  const at = html.indexOf('<script>');
  const markup = html.slice(0, at), script = html.slice(at, html.lastIndexOf('</script>'));
  const ids = new Set([...markup.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  // Elements the script only reaches after building them itself (rendered tables, dialogs it creates).
  const made = new Set([...script.matchAll(/id=\\?"([^"\\]+)\\?"/g)].map((m) => m[1]).concat([...script.matchAll(/\.id = '([^']+)'/g)].map((m) => m[1])));
  const used = [...new Set([...script.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]))];
  const missing = used.filter((id) => !ids.has(id) && !made.has(id));
  expect(missing).toEqual([]);
});
