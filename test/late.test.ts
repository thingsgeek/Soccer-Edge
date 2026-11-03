import { expect, test } from 'bun:test';
import { matchMinuteNow, tooLateInGame } from '../src/trade/late';

const ko = Date.parse('2026-10-19T18:00:00Z');
const at = (min: number) => ko + min * 60_000;

test('before kickoff and first half are fine', () => {
  expect(tooLateInGame(ko, at(-10))).toBeNull();
  expect(tooLateInGame(ko, at(44))).toBeNull();
});
test('clock: 80th minute is 95 min after kickoff', () => {
  expect(Math.round(matchMinuteNow(ko, at(60)))).toBe(45);
  expect(tooLateInGame(ko, at(94))).toBeNull();
  expect(tooLateInGame(ko, at(95))).toMatch(/^minute 80: no buys/);
});
test('feed minute wins when later than the clock, and moves on with time', () => {
  expect(tooLateInGame(ko, at(80), 81)).toMatch(/^minute 81/);
  expect(tooLateInGame(ko, at(80), 75, at(75))).toMatch(/^minute 80/);
  expect(tooLateInGame(ko, at(80), 70, at(80))).toBeNull();
});

test('one bet per game counts filled, waiting and unconfirmed orders, ever', async () => {
  const { gamesTraded } = await import('../src/trade/executor');
  const g = gamesTraded('prod', [
    { type: 'order', env: 'prod', ticker: 'KXEPLTOTAL-26OCT19ARSCHE-2', filled: 3 },          // bought (settled later still counts)
    { type: 'order', env: 'prod', ticker: 'KXEPLTOTAL-26OCT19LIVMCI-2', filled: 0, resting: true, restStatus: 'resting' },
    { type: 'order', env: 'prod', ticker: 'KXEPLTOTAL-26OCT19TOTNEW-2', filled: 0, error: 'x', uncertain: true },
    { type: 'order', env: 'prod', ticker: 'KXEPLTOTAL-26OCT19BOUFUL-2', filled: 0, error: 'refused' }, // never placed
    { type: 'order', env: 'demo', ticker: 'KXEPLTOTAL-26OCT19WOLBRE-2', filled: 5 },
  ]);
  expect([...g.keys()].sort()).toEqual(['26OCT19ARSCHE', '26OCT19LIVMCI', '26OCT19TOTNEW']);
});

test('one bet per game, no exceptions', async () => {
  const { oneBetPerGame } = await import('../src/trade/executor');
  const o15 = 'KXEPLTOTAL-26OCT19ARSCHE-2', o25 = 'KXEPLTOTAL-26OCT19ARSCHE-3';
  expect(oneBetPerGame(o15, [], 70)).toBeNull();
  expect(oneBetPerGame(o25, [o15], -20)).toMatch(/already have a bet/); // even before kickoff, one line up
  expect(oneBetPerGame(o25, [o15], 30)).toMatch(/already have a bet/);
});
