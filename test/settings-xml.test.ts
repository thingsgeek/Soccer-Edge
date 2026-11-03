import { expect, test } from 'bun:test';
import { DEFAULT_CONFIG } from '../src/config';
import { exportSettingsXml, importSettingsXml } from '../src/settings-xml';

const cfg = () => structuredClone(DEFAULT_CONFIG);

test('export -> import round-trips every setting, with no keys or account details', () => {
  const a = cfg();
  a.risk.maxNotionalPerOrder = 7.5; a.risk.rulesOff = ['edge', 'region']; a.live.mode = 'trade'; a.trading = { pregame: false, live: true };
  a.state = 'FL'; a.country = 'US';
  (a as any).kalshi = { env: 'prod', apiKeyId: 'SECRET-ID' };
  a.disclaimer = { version: 1, at: 'x' };
  const xml = exportSettingsXml(a, '0.31.0');
  expect(xml).toContain('<soccerEdgeSettings format="1"');
  expect(xml).not.toContain('SECRET-ID');
  expect(xml).not.toContain('disclaimer');
  expect(xml).not.toContain('eligibilityUrl');
  const b = cfg();
  const r = importSettingsXml(b, xml);
  expect(r.ignored).toEqual([]);
  expect(b.risk.maxNotionalPerOrder).toBe(7.5);
  expect(b.risk.rulesOff).toEqual(['edge', 'region']);
  expect(b.live.mode).toBe('trade');
  expect(b.trading).toEqual({ pregame: false, live: true });
  expect(b.state).toBe('FL');
  expect(b.disclaimer).toBeUndefined();           // importing never accepts the disclaimer
  expect((b as any).kalshi.apiKeyId).toBeUndefined();
});

test('import ignores unsafe, unknown and mistyped entries instead of guessing', () => {
  const b = cfg();
  const xml = `<?xml version="1.0"?><soccerEdgeSettings format="1">
    <setting key="disclaimer.version" type="number">9</setting>
    <setting key="kalshi.env" type="string">demo</setting>
    <setting key="eligibilityUrl" type="string">https://evil.example</setting>
    <setting key="__proto__.x" type="boolean">true</setting>
    <setting key="nonsense.thing" type="number">1</setting>
    <setting key="risk.maxNotionalPerOrder" type="string">lots</setting>
    <setting key="risk.maxPrice" type="number">-1</setting>
    <setting key="live.mode" type="string">yolo</setting>
    <setting key="risk.minEdge" type="number">0.04</setting>
  </soccerEdgeSettings>`;
  const r = importSettingsXml(b, xml);
  expect(r.changed.map((c) => c.key)).toEqual(['risk.minEdge']);
  expect(r.ignored.length).toBe(8);
  expect(b.disclaimer).toBeUndefined();
  expect(({} as any).x).toBeUndefined();
  expect(() => importSettingsXml(cfg(), '<html></html>')).toThrow(/Not a Soccer Edge settings file/);
  expect(() => importSettingsXml(cfg(), '<soccerEdgeSettings format="9"></soccerEdgeSettings>')).toThrow(/newer Soccer Edge/);
});

test('DISCLAIMER.md matches the disclaimer the app shows', async () => {
  const { disclaimerText } = await import('../src/disclaimer');
  const md = await Bun.file(new URL('../DISCLAIMER.md', import.meta.url)).text();
  expect(md.startsWith(disclaimerText())).toBe(true);
});

test('a settings file from before v0.36 with Follow PredyGo on imports as the same settings', async () => {
  const { DEFAULT_RULES_OFF } = await import('../src/config');
  const b = cfg(); b.risk.rulesOff = [];
  const xml = '<soccerEdgeSettings format="1"><setting key="risk.followAll" type="boolean">true</setting><setting key="risk.maxPrice" type="number">0.8</setting></soccerEdgeSettings>';
  importSettingsXml(b, xml);
  expect((b.risk as any).followAll).toBeUndefined();
  expect(b.risk.rulesOff).toEqual(DEFAULT_RULES_OFF);
  expect(b.risk.maxPrice).toBe(0.96);
  expect(b.live.mode).toBe('trade');
});

test('rule switches travel in the file; bad ids are refused', () => {
  const b = cfg();
  expect(importSettingsXml(b, '<soccerEdgeSettings format="1"><setting key="risk.rulesOff" type="string"></setting></soccerEdgeSettings>').changed).toHaveLength(1);
  expect(b.risk.rulesOff).toEqual([]);
  expect(importSettingsXml(b, '<soccerEdgeSettings format="1"><setting key="risk.rulesOff" type="string">edge,&lt;x&gt;</setting></soccerEdgeSettings>').ignored[0]!.key).toBe('risk.rulesOff');
});
