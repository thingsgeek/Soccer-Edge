import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, DEFAULT_RULES_OFF, effectiveConfig, ruleOn, ruleSwitches } from '../src/config';
import { checkRegion } from '../src/trade/eligibility';
import { RULES, rulesView } from '../src/trade/rules';

test('a switched-off rule opens up its value in the config the engine uses; the saved value stays', () => {
  const c = structuredClone(DEFAULT_CONFIG);
  c.risk.rulesOff = ['minProb', 'edge', 'perTrade', 'liveAge', 'tier', 'onePerMatch'];
  const e = ruleSwitches(c);
  expect(e.risk.minProbability).toBe(0);
  expect(e.risk.minEdge).toBeLessThan(0);
  expect(e.risk.maxNotionalPerOrder).toBeGreaterThan(1000);
  expect(e.live.maxPickAgeSec).toBeGreaterThan(1000);
  expect(e.source.tier).toBe('any');
  expect(e.risk.onePerMatch).toBe(false);
  expect(c.risk.minProbability).toBe(DEFAULT_CONFIG.risk.minProbability); // saved untouched
  expect(effectiveConfig(c).risk.minProbability).toBe(0);                   // what the app uses
  expect(ruleOn(c.risk, 'minute80')).toBe(true);
  expect(ruleOn({ rulesOff: ['minute80'] }, 'minute80')).toBe(false);
});

test('new installs start with the PredyGo-aligned rules off; existing installs keep every rule on', async () => {
  const home = mkdtempSync(join(tmpdir(), 'se-rules-'));
  process.env.SOCCER_EDGE_HOME = home;
  const { loadConfig } = await import('../src/config');
  expect(loadConfig().risk.rulesOff).toEqual(DEFAULT_RULES_OFF);
  writeFileSync(join(home, 'config.json'), JSON.stringify({ risk: { maxNotionalPerOrder: 5 } }));
  expect(loadConfig().risk.rulesOff).toEqual([]);
  delete process.env.SOCCER_EDGE_HOME;
});

test('region check can be switched off', () => {
  const data: any = { asOf: 'x', kalshi: { sportsRestricted: [], platformRestricted: [], countryRestricted: ['CA'] } };
  expect(checkRegion({ country: 'CA' }, data).ok).toBe(false);
  expect(checkRegion({ country: 'CA', risk: { rulesOff: ['region'] } }, data).ok).toBe(true);
});

test('every rule shows a switch; the impossible ones are locked with the reason', () => {
  const c = structuredClone(DEFAULT_CONFIG);
  const v = rulesView(c, effectiveConfig(c));
  expect(v).toHaveLength(RULES.length);
  const locked = v.filter((r) => r.locked).map((r) => r.id).sort();
  expect(locked).toEqual(['active', 'betType', 'error', 'game', 'graded', 'league', 'line', 'livePickPre', 'marketType']);
  for (const id of DEFAULT_RULES_OFF) expect(v.find((r) => r.id === id)!.on).toBe(false);
  expect(v.find((r) => r.id === 'minute80')!.on).toBe(true);
  expect(v.find((r) => r.id === 'onePerMatch')!.on).toBe(true);
  expect(v.every((r) => !/Follow/.test(r.status + r.what + (r.locked ?? '')))).toBe(true);
});

test('one bet per game and the 80th minute can be switched off', async () => {
  const { oneBetPerGame } = await import('../src/trade/executor');
  // The executor only asks oneBetPerGame when the rule is on (see executor.ts); the rule itself is unchanged.
  expect(oneBetPerGame('KXEPLTOTAL-26OCT19ARSCHE-3', ['KXEPLTOTAL-26OCT19ARSCHE-2'], 10)).toMatch(/already have a bet/);
  const src = await Bun.file(new URL('../src/trade/executor.ts', import.meta.url)).text();
  expect(src).toContain("ruleOn(cfg.risk, 'onePerMatch') ? oneBetPerGame(");
  expect(src).toContain("ruleOn(cfg.risk, 'minute80') ? tooLateInGame(");
});

test('a PredyGo tier above the key\'s own tier is brought down to it', async () => {
  const { tierForKey, tiersForKey } = await import('../src/predictions/sources');
  expect(tierForKey('elite', 'pro')).toBe('pro');
  expect(tierForKey('any', 'pro')).toBe('pro');
  expect(tierForKey('pro', 'pro')).toBe('pro');
  expect(tierForKey('pro', 'elite')).toBe('pro');      // a lower choice stands (fewer picks)
  expect(tierForKey('elite', 'admin')).toBe('elite');  // admin / unknown: the choice stands
  expect(tierForKey('any', undefined)).toBe('any');
  expect(tiersForKey('pro')).toEqual(['pro']);
  expect(tiersForKey('elite')).toEqual(['pro', 'elite']);
  expect(tiersForKey('admin')).toBeNull();
});

test('Claude is off out of the box', () => {
  expect(DEFAULT_CONFIG.ai.enabled).toBe(false);
  expect(DEFAULT_CONFIG.ai.precheck).toBe('off');
});

test('live mode dropdown gone: watch becomes "Live switch off"; old configs keep their live buying', async () => {
  const home = mkdtempSync(join(tmpdir(), 'se-live-'));
  process.env.SOCCER_EDGE_HOME = home;
  const { loadConfig } = await import('../src/config');
  expect(loadConfig()).toMatchObject({ live: { mode: 'trade' }, trading: { live: false } });           // new install
  writeFileSync(join(home, 'config.json'), JSON.stringify({ live: { mode: 'watch' } }));
  expect(loadConfig()).toMatchObject({ live: { mode: 'trade' }, trading: { live: false } });
  writeFileSync(join(home, 'config.json'), JSON.stringify({ live: { mode: 'trade' } }));
  expect(loadConfig().trading!.live).toBe(true);                                                         // was trading live
  writeFileSync(join(home, 'config.json'), JSON.stringify({ live: { mode: 'watch' }, trading: { live: true } }));
  expect(loadConfig()).toMatchObject({ live: { mode: 'trade' }, trading: { live: false } });           // watch never bought
  writeFileSync(join(home, 'config.json'), JSON.stringify({ live: { mode: 'off' } }));
  expect(loadConfig().live.mode).toBe('off');
  delete process.env.SOCCER_EDGE_HOME;
});

test('config.json never holds a secret, even if a config carrying one is saved', async () => {
  const home = mkdtempSync(join(tmpdir(), 'se-secret-'));
  process.env.SOCCER_EDGE_HOME = home;
  const { loadConfig, saveConfig } = await import('../src/config');
  const c: any = loadConfig();
  c.source.token = 'pg_live_SECRET'; c.kalshi.privateKeyPem = '-----BEGIN PRIVATE KEY-----x'; c.ai.someApiKey = 'sk-ant-SECRET';
  saveConfig(c);
  const { readFileSync } = await import('node:fs');
  const text = readFileSync(join(home, 'config.json'), 'utf8');
  expect(text).not.toContain('SECRET');
  expect(text).not.toContain('PRIVATE KEY');
  expect(c.source.token).toBe('pg_live_SECRET'); // the object in memory is untouched
  delete process.env.SOCCER_EDGE_HOME;
});
