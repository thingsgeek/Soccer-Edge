import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'se-trk-'));
process.env.SOCCER_EDGE_HOME = home;
const { TradeTracker } = await import('../src/trade/tracker');
afterAll(() => rmSync(home, { recursive: true, force: true }));

const at = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();
const order = (ticker: string, side: 'yes' | 'no', filled: number, price: number, minAgo: number) =>
  JSON.stringify({ type: 'order', at: at(minAgo), env: 'prod', predictionId: ticker, ticker, side, count: filled, limitPrice: price, probability: 0.8, edge: 0.1, clientOrderId: ticker, filled, avgPrice: price, avgFee: 0.01, match: 'A v B', bet: 'T+1.5' });

test('trades closed on Kalshi are reconciled from account fills: sold, partly sold, netted with the other side', () => {
  writeFileSync(join(home, 'ledger.jsonl'), [
    order('KXT-1', 'yes', 6, 0.70, 60),   // sold all 6 on Kalshi at 80c
    order('KXT-2', 'yes', 10, 0.50, 60),  // sold 4 of 10 at 60c
    order('KXT-3', 'no', 5, 0.40, 60),    // closed by buying YES at 30c (NO worth 70c)
    order('KXT-4', 'yes', 3, 0.60, 60),   // untouched
  ].join('\n') + '\n');
  const tr = new TradeTracker(() => null);
  tr.setFills([
    { ticker: 'KXT-1', purchased: 'yes', count: 6, yesPrice: 0.70, fee: 0.06, ts: Date.parse(at(60)) }, // the app's own buy
    { ticker: 'KXT-1', purchased: 'no', count: 6, yesPrice: 0.80, fee: 0.06, ts: Date.parse(at(20)) },  // sold
    { ticker: 'KXT-2', purchased: 'no', count: 4, yesPrice: 0.60, fee: 0, ts: Date.parse(at(20)) },
    { ticker: 'KXT-3', purchased: 'yes', count: 5, yesPrice: 0.30, fee: 0, ts: Date.parse(at(20)) },
    { ticker: 'KXT-4', purchased: 'no', count: 3, yesPrice: 0.20, fee: 0, ts: Date.parse(at(120)) },  // before the app bought: ignored
  ]);
  const q = { bid: 0.55, ask: 0.57, last: 0.56 };
  const { rows, totals } = tr.trades('prod', () => q);
  const r = (t: string) => rows.find((x) => x.ticker === t)!;
  expect(r('KXT-1')).toMatchObject({ status: 'sold', value: 4.74, pnl: +(4.74 - (6 * 0.70 + 0.06)).toFixed(2) });
  expect(r('KXT-2').status).toBe('open');
  expect(r('KXT-2').soldQty).toBe(4);
  expect(r('KXT-2').value).toBe(+(6 * 0.55 + 4 * 0.60).toFixed(2));
  expect(r('KXT-3')).toMatchObject({ status: 'sold', value: 3.5 });
  expect(r('KXT-4')).toMatchObject({ status: 'open', soldQty: null });
  expect(totals.sold).toBe(2);
  expect(totals.open).toBe(2);
});

test('position check: nothing held on Kalshi while the market is open = closed, even when fills say nothing', () => {
  writeFileSync(join(home, 'ledger.jsonl'), [
    order('KXARG-1', 'yes', 5, 0.67, 30),  // sold on Kalshi, fill not recognised
    order('KXARG-2', 'yes', 6, 0.66, 30),  // still held
    order('KXARG-3', 'yes', 7, 0.59, 0.01), // bought seconds ago: snapshot older than the buy
  ].join('\n') + '\n');
  const tr = new TradeTracker(() => null);
  tr.setFills([]);
  for (const t of ['KXARG-1', 'KXARG-2', 'KXARG-3']) tr.setMarket(t, { status: 'active', bid: 0.64, ask: 0.66 });
  tr.setAccountPositions(new Map([['KXARG-1', { position: 0, realized: -0.2, fees: 0.1 }], ['KXARG-2', { position: 6, realized: 0, fees: 0.05 }]]));
  (tr as any).acct.at = Date.now() - 20_000;
  const { rows } = tr.trades('prod');
  const r = (t: string) => rows.find((x) => x.ticker === t)!;
  expect(r('KXARG-1').status).toBe('sold');
  expect(r('KXARG-1').value).toBe(+(5 * 0.67 + 5 * 0.01 - 0.2).toFixed(2)); // cost + Kalshi's realized P/L
  expect(r('KXARG-2').status).toBe('open');
  expect(r('KXARG-3').status).toBe('open');
  const rep = tr.reconcileReport('prod');
  expect(rep.find((x) => x.ticker === 'KXARG-2')).toMatchObject({ appQty: 6, kalshiQty: 6 });
});

test('after settlement: a trade sold earlier stays sold; one held to the end is graded', () => {
  writeFileSync(join(home, 'ledger.jsonl'), [
    order('KXSET-1', 'yes', 5, 0.55, 600), // sold before the game ended; then the market settled YES
    order('KXSET-2', 'yes', 4, 0.70, 600), // held to settlement, won
    order('KXSET-3', 'yes', 3, 0.60, 600), // settled just now, record not posted yet
  ].join('\n') + '\n');
  const tr = new TradeTracker(() => null);
  tr.setFills([]);
  const longAgo = new Date(Date.now() - 5 * 3600e3).toISOString();
  tr.setMarket('KXSET-1', { status: 'finalized', result: 'yes', closeTime: longAgo });
  tr.setMarket('KXSET-2', { status: 'finalized', result: 'yes', closeTime: longAgo });
  tr.setMarket('KXSET-3', { status: 'finalized', result: 'yes', closeTime: new Date().toISOString() });
  tr.setAccountPositions(new Map([['KXSET-1', { position: 0, realized: -0.14, fees: 0.05 }], ['KXSET-2', { position: 0, realized: 1.16, fees: 0.04 }]]));
  (tr as any).acct.at = Date.now() - 20_000;
  tr.setSettlements(new Map([['KXSET-2', { yes: 4, no: 0 }]]), Date.now() - 31 * 86400e3, Date.now() - 10 * 86400e3);
  const { rows, totals } = tr.trades('prod');
  const r = (t: string) => rows.find((x) => x.ticker === t)!;
  expect(r('KXSET-1').status).toBe('sold');
  expect(r('KXSET-1').pnl).toBe(-0.14);
  expect(r('KXSET-2')).toMatchObject({ status: 'won', value: 4 });
  expect(r('KXSET-3').status).toBe('won'); // no record yet: graded as before until Kalshi posts it
  expect(totals.sold).toBe(1);
});

test('no settlement record, but Kalshi\'s live records don\'t reach back that far: graded as before', () => {
  writeFileSync(join(home, 'ledger.jsonl'), order('KXOLD-1', 'yes', 5, 0.55, 600) + '\n');
  const tr = new TradeTracker(() => null);
  tr.setFills([]);
  tr.setMarket('KXOLD-1', { status: 'finalized', result: 'yes', closeTime: new Date(Date.now() - 5 * 3600e3).toISOString() });
  tr.setAccountPositions(new Map());
  (tr as any).acct.at = Date.now() - 20_000;
  tr.setSettlements(new Map(), Date.now() - 31 * 86400e3, Date.now() - 3600e3); // earliest record after this market closed
  expect(tr.trades('prod').rows[0]!.status).toBe('won');
});

test('sold before settlement shows up in Kalshi\'s record as YES and NO both held: that nets to nothing', () => {
  writeFileSync(join(home, 'ledger.jsonl'), order('KXCHACO-2', 'yes', 7, 0.606, 600) + '\n');
  const tr = new TradeTracker(() => null);
  tr.setFills([]);
  tr.setMarket('KXCHACO-2', { status: 'finalized', result: 'yes', closeTime: new Date(Date.now() - 5 * 3600e3).toISOString() });
  tr.setAccountPositions(new Map([['KXCHACO-2', { position: 0, realized: -0.38, fees: 0.07 }]]));
  (tr as any).acct.at = Date.now() - 20_000;
  tr.setSettlements(new Map([['KXCHACO-2', { yes: 7, no: 7 }]]), Date.now() - 31 * 86400e3, Date.now() - 10 * 86400e3);
  const r = tr.trades('prod').rows[0]!;
  expect(r.status).toBe('sold');
  expect(r.pnl).toBe(-0.38);
});

test('trades vs Kalshi: several app orders on one market are compared as one position', () => {
  writeFileSync(join(home, 'ledger.jsonl'), [order('KXENP-2', 'yes', 0.01, 0.7, 30), order('KXENP-2', 'yes', 7, 0.7, 20)].join('\n') + '\n');
  const tr = new TradeTracker(() => null);
  tr.setFills([]);
  tr.setMarket('KXENP-2', { status: 'active', bid: 0.7, ask: 0.72 });
  tr.setAccountPositions(new Map([['KXENP-2', { position: 7.01, realized: 0, fees: 0.1 }]]));
  (tr as any).acct.at = Date.now() - 5_000;
  expect(tr.reconcileReport('prod')).toEqual([{ ticker: 'KXENP-2', match: 'A v B', side: 'yes', appQty: 7.01, status: 'open', kalshiQty: 7.01 }]);
});
