import { expect, test } from 'bun:test';
import { whyCounts } from '../src/diagnostics';

test('whyCounts groups pick outcomes into buckets', () => {
  const r = Object.fromEntries(whyCounts([
    { verdict: 'ok', summary: 'Tradable: 5 × YES at 78¢, edge 4%.' },
    { verdict: 'fail', summary: "Kalshi doesn't list team-goal markets for England League 1 right now." },
    { verdict: 'fail', summary: 'League not on Kalshi (or not mapped).' },
    { verdict: 'warn', summary: 'On Kalshi, not traded: edge -3.1% < 4.2% needed.' },
    { verdict: 'warn', summary: 'On Kalshi, not traded: edge -1.0% < 4.0% needed.' },
    { verdict: 'info', summary: 'More than 24 h away; will be checked later.' },
  ]));
  expect(r['Tradable now']).toBe(1);
  expect(r['Kalshi has no market for this league or bet type']).toBe(2);
  expect(r['On Kalshi, but the price is too high for the hit rate']).toBe(2);
  expect(r['Too far ahead (picked up later)']).toBe(1);
});
