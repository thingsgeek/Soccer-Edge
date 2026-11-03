/**
 * Settings as an XML file: export your settings, and import them on another computer (or after
 * a reinstall) to set everything at once. A file named soccer-edge-settings.xml next to the
 * app, or in its data folder, is imported automatically when it is new or has changed.
 *
 * Never in the file: API keys or passwords (those live in the encrypted vault, not in
 * settings), the disclaimer acceptance, where the app fetches eligibility/picks from, Kalshi
 * account details, and internal bookkeeping. Importing can't skip the disclaimer.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appHome, DEFAULT_CONFIG, migrateFollow, type AppConfig } from './config';

export const SETTINGS_XML_NAME = 'soccer-edge-settings.xml';
const FORMAT = 1;

/** Keys never exported or imported (secrets, safety, where data comes from, bookkeeping). */
const EXCLUDED = [
  /^kalshi\./, /^disclaimer(\.|$)/, /^eligibilityUrl$/, /^source\.(url|token|type|includeAll)$/,
  /^settingsRev$/, /^aiRev$/, /^settingsImport(\.|$)/, /^risk\.paused$/, /^pro\.chosen$/,
  /[Kk]ey$/, /[Tt]oken$/, /[Pp]assword$/, /[Ss]ecret/,
];
const allowed = (key: string) => !EXCLUDED.some((r) => r.test(key));

type Leaf = string | number | boolean;
/** Text settings that only take certain values. */
const CHOICES: Record<string, string[]> = {
  'live.mode': ['off', 'watch', 'trade'], 'ai.precheck': ['off', 'advise', 'veto'], 'risk.stakeMode': ['flat', 'kelly'],
  mode: ['approve', 'auto'], calibration: ['hit-rate', 'stated'],
};
/** List settings, written as comma-separated ids (the rule switches). */
const LISTS = ['risk.rulesOff'];
const isLeaf = (v: unknown): v is Leaf => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

function leaves(obj: unknown, prefix = '', out: [string, Leaf][] = []): [string, Leaf][] {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (isLeaf(v)) out.push([key, v]);
    else if (LISTS.includes(key) && Array.isArray(v)) out.push([key, v.map(String).join(',')]);
    else if (v && typeof v === 'object' && !Array.isArray(v)) leaves(v, key, out);
  }
  return out;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&');

/** The saved settings (not the opened-up view the engine trades with) as XML. */
export function exportSettingsXml(cfg: AppConfig, appVersion: string): string {
  const rows = leaves(cfg).filter(([k]) => allowed(k)).sort(([a], [b]) => a.localeCompare(b));
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<!-- Soccer Edge settings. No keys or passwords are stored here. Import it in Settings, or put it next to the app as ${SETTINGS_XML_NAME}. -->`,
    `<soccerEdgeSettings format="${FORMAT}" app="${esc(appVersion)}" exported="${new Date().toISOString()}">`,
    ...rows.map(([k, v]) => `  <setting key="${esc(k)}" type="${typeof v}">${esc(String(v))}</setting>`),
    '</soccerEdgeSettings>',
    '',
  ].join('\n');
}

/** Top-level settings not in the defaults. */
const EXTRA_TOP = ['resumeAuto', 'trading', 'country', 'state'];

export interface ImportResult { changed: { key: string; from: unknown; to: Leaf }[]; ignored: { key: string; why: string }[] }

function get(obj: any, key: string): unknown {
  return key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}
function set(obj: any, key: string, v: Leaf | string[]) {
  const parts = key.split('.');
  let o = obj;
  for (const p of parts.slice(0, -1)) { if (!o[p] || typeof o[p] !== 'object') o[p] = {}; o = o[p]; }
  o[parts[parts.length - 1]!] = v;
}

/** Apply an XML settings file to cfg (in place). Unknown, unsafe or mistyped settings are ignored, not guessed. */
export function importSettingsXml(cfg: AppConfig, xml: string): ImportResult {
  if (!/<soccerEdgeSettings\b/.test(xml)) throw new Error('Not a Soccer Edge settings file (no <soccerEdgeSettings>).');
  const fmt = Number(/<soccerEdgeSettings[^>]*\bformat="(\d+)"/.exec(xml)?.[1] ?? FORMAT);
  if (fmt > FORMAT) throw new Error(`This settings file is from a newer Soccer Edge (format ${fmt}). Update the app first.`);
  const res: ImportResult = { changed: [], ignored: [] };
  const re = /<setting\s+key="([^"]*)"\s+type="(string|number|boolean)"\s*>([\s\S]*?)<\/setting>/g;
  for (let m; (m = re.exec(xml));) {
    const key = unesc(m[1]!), type = m[2]!, raw = unesc(m[3]!.trim());
    if (!/^[A-Za-z0-9_.]+$/.test(key) || key.split('.').some((p) => p === '__proto__' || p === 'constructor' || p === 'prototype')) { res.ignored.push({ key, why: 'not a valid setting name' }); continue; }
    if (!allowed(key)) { res.ignored.push({ key, why: 'not allowed in a settings file' }); continue; }
    if (LISTS.includes(key)) {
      const ids = raw.split(',').map((x) => x.trim()).filter(Boolean);
      if (type !== 'string' || ids.some((x) => !/^[A-Za-z0-9]{1,40}$/.test(x))) { res.ignored.push({ key, why: 'should be a comma-separated list of rule ids' }); continue; }
      const from = get(cfg, key) as string[] | undefined;
      if ((from ?? []).join(',') !== ids.join(',')) { set(cfg, key, ids as any); res.changed.push({ key, from, to: ids.join(',') }); }
      continue;
    }
    const top = key.split('.')[0]!;
    if (!(top in DEFAULT_CONFIG) && !EXTRA_TOP.includes(top)) { res.ignored.push({ key, why: 'unknown setting' }); continue; }
    const known = get(DEFAULT_CONFIG, key) ?? get(cfg, key);
    if (known !== undefined && typeof known !== type) { res.ignored.push({ key, why: `should be a ${typeof known}` }); continue; }
    let v: Leaf;
    if (type === 'number') { v = Number(raw); if (!Number.isFinite(v) || v < 0) { res.ignored.push({ key, why: 'not a valid number' }); continue; } }
    else if (type === 'boolean') { if (raw !== 'true' && raw !== 'false') { res.ignored.push({ key, why: 'not true/false' }); continue; } v = raw === 'true'; }
    else {
      if (raw.length > 200) { res.ignored.push({ key, why: 'too long' }); continue; }
      const choices = CHOICES[key];
      if (choices && !choices.includes(raw)) { res.ignored.push({ key, why: `must be one of ${choices.join(', ')}` }); continue; }
      v = raw;
    }
    const from = get(cfg, key);
    if (from !== v) { set(cfg, key, v); res.changed.push({ key, from, to: v }); }
  }
  migrateFollow(cfg); // a file from before v0.36 may still have Follow PredyGo on
  return res;
}

/** soccer-edge-settings.xml next to the app or in its data folder, if it is new or changed since the last import. */
export function pendingSettingsFile(cfg: AppConfig): { path: string; xml: string; hash: string } | null {
  const dirs = [dirname(process.execPath), appHome()];
  for (const d of dirs) {
    const path = join(d, SETTINGS_XML_NAME);
    if (!existsSync(path)) continue;
    try {
      const xml = readFileSync(path, 'utf8');
      const hash = createHash('sha256').update(xml).digest('hex');
      if (cfg.settingsImport?.hash === hash) return null;
      return { path, xml, hash };
    } catch { return null; }
  }
  return null;
}

/** Settings that make the app trade by itself, for a clear warning after an import turns them on. */
export const AUTOMATION_KEYS = ['resumeAuto', 'live.mode', 'trading.live', 'risk.tradeHighRisk'];
