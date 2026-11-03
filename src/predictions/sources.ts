/**
 * Prediction sources. Anything that produces Prediction[] can plug in here.
 *
 * Built in:
 *   - PredyGo API (https://predygo.com/api/v1/predictions + /results), Bearer key
 *   - Local file: JSON or CSV in the same row shape
 *
 * Field names are read leniently so CSV exports (HomeTeam, AwayTeam, match_date, success)
 * and the API's fields (home, away, kickoff, result) both work.
 */
import { readFileSync } from 'node:fs';
import type { SourceConfig } from '../config';
import type { Prediction } from './types';
import { wallTimeToUtc } from './time';
import type { CanonicalMarket } from '../match/bets';
import { setLiveHistory } from './calibration';

export const PREDYGO_API = 'https://predygo.com/api/v1';
export const PREDYGO_TIMEZONE = 'America/New_York';

type Row = Record<string, unknown>;

function pick(r: Row, ...keys: string[]): unknown {
  for (const k of keys) {
    if (r[k] !== undefined && r[k] !== null && r[k] !== '') return r[k];
    const lower = Object.keys(r).find((x) => x.toLowerCase() === k.toLowerCase());
    if (lower && r[lower] !== undefined && r[lower] !== null && r[lower] !== '') return r[lower];
  }
  return undefined;
}

function parseKickoff(v: unknown, timeZone: string): string | null {
  if (v === undefined) return null;
  if (typeof v === 'number') return new Date(v > 1e12 ? v : v * 1000).toISOString();
  const s = String(v).trim();
  // Has an explicit zone (Z or +hh:mm): trust it. Otherwise it's PredyGo wall time.
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  try { return wallTimeToUtc(s, timeZone); } catch { return null; }
}

function parseOutcome(v: unknown): boolean | null {
  if (v === undefined) return null;
  const s = String(v).trim().toLowerCase();
  if (['yes', 'win', 'won', 'true', '1', 'w'].includes(s)) return true;
  if (['no', 'loss', 'lost', 'lose', 'false', '0', 'l'].includes(s)) return false;
  return null; // pending, push, void, unknown
}

/** Bet names PredyGo retired (fixed at the source Oct 16). Diagnostics flags them if they ever come back. */
export const RETIRED_BET_NAMES: Record<string, string> = { 'VISITA MARCA REG': 'VISITA MARCA', 'LOCAL MARCA REG': 'LOCAL MARCA' };

export function normalizeRows(rows: Row[], timeZone = PREDYGO_TIMEZONE): Prediction[] {
  const out: Prediction[] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const home = pick(r, 'home', 'HomeTeam', 'home_team', 'homeTeam');
    const away = pick(r, 'away', 'AwayTeam', 'away_team', 'awayTeam');
    // PredyGo API: market = { code, name, canonical }. Files: bet = "T+1.5".
    const marketField = pick(r, 'market');
    const marketObj = marketField && typeof marketField === 'object' ? (marketField as Record<string, unknown>) : null;
    const bet = marketObj ? marketObj.code : pick(r, 'bet', 'market', 'pick', 'type');
    const canonical = marketObj && marketObj.canonical && typeof marketObj.canonical === 'object' ? (marketObj.canonical as CanonicalMarket) : null;
    const kickoff = parseKickoff(pick(r, 'kickoff', 'match_date', 'start_time', 'date', 'matchDate'), timeZone);
    if (!home || !away || !bet || !kickoff) continue;
    const betCode = String(bet).trim().toUpperCase();
    // PredyGo's stable key is "row_id::bet"; otherwise build one from the row id.
    const stableKey = pick(r, 'key');
    const rowId = pick(r, 'row_id', 'rowId', 'id', 'row_key', 'fixture_id', 'api_fixture_id') ?? `${home}-${away}-${kickoff}`;
    const pct = Number(pick(r, 'confidence', 'pct', 'probability', 'prob'));
    const source = pick(r, 'source');
    out.push({
      id: stableKey !== undefined ? String(stableKey) : `${rowId}::${betCode}`,
      league: String(pick(r, 'league', 'name', 'competition', 'league_name') ?? '').trim(),
      kickoff,
      home: String(home).trim(),
      away: String(away).trim(),
      bet: betCode,
      canonical,
      // Accept 0-1 or 0-100.
      statedPct: Number.isFinite(pct) ? (pct <= 1 ? pct * 100 : pct) : NaN,
      won: parseOutcome(pick(r, 'result', 'success', 'outcome', 'won', 'graded')),
      source: source === undefined ? undefined : String(source),
      posted: postedFlag(r),
      highRisk: ((v) => v === true || v === 1 || v === 'true' || v === '1')(pick(r, 'high_risk', 'highRisk')) || undefined,
      ...liveFields(r, timeZone),
    });
  }
  return out;
}

function liveFields(r: Row, timeZone: string): Pick<Prediction, 'score' | 'minute' | 'pickedAt' | 'odds'> {
  const out: Pick<Prediction, 'score' | 'minute' | 'pickedAt' | 'odds'> = {};
  const sc = pick(r, 'score', 'live_score', 'liveScore');
  const m = sc === undefined ? null : String(sc).match(/^\s*(\d+)\s*[-:]\s*(\d+)\s*$/);
  if (m) out.score = [Number(m[1]), Number(m[2])];
  else {
    const h = Number(pick(r, 'livehg', 'live_home_goals', 'home_score'));
    const a = Number(pick(r, 'liveaw', 'liveag', 'live_away_goals', 'away_score'));
    if (Number.isInteger(h) && Number.isInteger(a) && pick(r, 'livehg', 'live_home_goals', 'home_score') !== undefined) out.score = [h, a];
  }
  const minute = Number(pick(r, 'minute', 'live_minute', 'livetime', 'elapsed'));
  if (Number.isFinite(minute) && minute > 0) out.minute = minute;
  const at = parseKickoff(pick(r, 'picked_at', 'pickedAt', 'posted_at', 'created_at', 'registered', 'published_at'), timeZone);
  if (at) out.pickedAt = at;
  // Published picks give odds as "6.50 / +550" (decimal / American); the full list as a plain decimal.
  const odds = parseFloat(String(pick(r, 'odds', 'price', 'decimal_odds') ?? ''));
  if (Number.isFinite(odds) && odds > 1) out.odds = odds;
  return out;
}

/** Whether the row was a posted pick (vs model-only), if the feed says. */
function postedFlag(r: Row): boolean | undefined {
  const v = pick(r, 'posted', 'is_posted', 'published', 'sent');
  if (v !== undefined) return v === true || ['true', '1', 'yes'].includes(String(v).toLowerCase());
  const origin = pick(r, 'origin', 'list', 'kind');
  if (origin !== undefined) {
    const o = String(origin).toLowerCase();
    if (['posted', 'pick', 'picks', 'published', 'sent'].includes(o)) return true;
    if (['model', 'prediction', 'predictions', 'all', 'unposted'].includes(o)) return false;
  }
  return undefined;
}

function parseCsv(text: string): Row[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return [];
  const split = (line: string): string[] => {
    const cells: string[] = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    return cells;
  };
  const header = split(lines[0]!).map((h) => h.trim());
  return lines.slice(1).map((l) => {
    const cells = split(l);
    return Object.fromEntries(header.map((h, i) => [h, (cells[i] ?? '').trim()]));
  });
}

export function rowsFromPayload(payload: unknown): Row[] {
  if (Array.isArray(payload)) return payload as Row[];
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    for (const key of ['predictions', 'results', 'rows', 'data', 'items', 'picks']) {
      const v = obj[key];
      if (Array.isArray(v)) return v as Row[];
      if (v && typeof v === 'object') {
        const inner = rowsFromPayload(v);
        if (inner.length) return inner;
      }
    }
  }
  throw new Error('Unexpected response from the prediction feed (no list of predictions found).');
}

export class FeedAuthError extends Error {
  constructor(msg: string) { super(msg); this.name = 'FeedAuthError'; }
}

async function getJson(url: string, key?: string, paramAttempt = false, retried = false): Promise<unknown> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  // 60 requests/minute per key. A short Retry-After is worth one wait-and-retry.
  if (res.status === 429) {
    // One connection per key: another computer (or another copy of the app) is using it.
    let code = '';
    try { code = String(((await res.clone().json()) as { code?: string })?.code ?? ''); } catch {}
    if (code === 'key_in_use') throw new Error('PredyGo: this API key is in use from another computer or copy of the app (one connection per key). Close the other one; the key frees up after 15 minutes without use.');
  }
  if (res.status === 429 && !retried) {
    const wait = Number(res.headers.get('retry-after'));
    if (Number.isFinite(wait) && wait >= 0 && wait <= 15) {
      await new Promise((r) => setTimeout(r, wait * 1000 + 200));
      return getJson(url, key, paramAttempt, true);
    }
  }
  if (paramAttempt && (res.status === 400 || res.status === 403 || res.status === 404 || res.status === 422)) {
    throw new FeedRejectedParam(`all=true not accepted (${res.status})`);
  }
  if (res.status === 401 || res.status === 403) {
    let msg = res.status === 403
      ? 'PredyGo: API access is not enabled for this account.'
      : 'PredyGo rejected the API key.';
    try { const j = await res.json() as { error?: string }; if (j?.error) msg = `PredyGo: ${j.error}`; } catch {}
    throw new FeedAuthError(msg);
  }
  if (res.status === 429) {
    const wait = res.headers.get('retry-after');
    throw new Error(`PredyGo rate limit reached${wait ? `; try again in ${wait}s` : ''}.`);
  }
  if (!res.ok) throw new Error(`PredyGo ${new URL(url).pathname} returned ${res.status} ${res.statusText}`);
  return res.json();
}

export interface PredygoAccount { tier?: string; scope?: string; pickLimit?: number | null; liveLimit?: number | null }

/** Check a PredyGo key. Returns the key's tier and scope from /me (or throws FeedAuthError). */
export async function checkPredygoKey(key: string, base = PREDYGO_API): Promise<PredygoAccount> {
  const me = (await getJson(`${base}/me`, key)) as Record<string, unknown> | null;
  const tier = me?.tier ?? (me as any)?.key?.tier;
  const scope = me?.scope ?? (me as any)?.key?.scope;
  const lim = (v: unknown) => (v === null ? null : Number.isFinite(Number(v)) ? Number(v) : undefined);
  return { tier: tier == null ? undefined : String(tier), scope: scope == null ? undefined : String(scope), pickLimit: lim(me?.pick_limit ?? (me as any)?.key?.pick_limit), liveLimit: lim(me?.live_limit ?? (me as any)?.key?.live_limit) };
}

/** Which list the last PredyGo load used: the full model list, or posted picks only. */
export let lastFeedMode: 'all' | 'posted' | null = null;

class FeedRejectedParam extends Error {}

/**
 * Query strings per the PredyGo API docs:
 *  - published (tier-scoped) feeds: limit 1-500; /results defaults to the last 2 days, up
 *    to 7 - ask for 7;
 *  - admin full list (all=true): limit up to 5000 (paged with offset); /results up to 365
 *    days (default 90).
 */
export function feedQuery(path: string, all: boolean, offset = 0): string {
  const results = path.endsWith('/results');
  if (all) return `?all=true&limit=2000${offset ? `&offset=${offset}` : ''}${results ? '&days=90' : ''}`;
  return `?limit=500${results ? '&days=7' : ''}`;
}

async function getFeed(base: string, path: string, key: string | undefined, includeAll: boolean): Promise<{ rows: Row[]; mode: 'all' | 'posted' }> {
  if (includeAll) {
    try {
      const rows: Row[] = [];
      for (let page = 0; page < 3; page++) {
        const got = rowsFromPayload(await getJson(`${base}${path}${feedQuery(path, true, rows.length)}`, key, true));
        rows.push(...got);
        if (got.length < 2000) break;
      }
      return { rows, mode: 'all' };
    } catch (e) {
      // Older server or a member key: fall back to posted picks.
      if (!(e instanceof FeedRejectedParam)) throw e;
    }
  }
  return { rows: rowsFromPayload(await getJson(`${base}${path}${feedQuery(path, false)}`, key)), mode: 'posted' };
}

/**
 * Tier filter: keep only picks delivered to the chosen PredyGo tier, using each row's
 * `tiers` array (per the API docs; a `tier` string is also understood).
 * A tier key's feed is already scoped to its tier; an admin key sees every tier, so this
 * is what keeps an admin key to the Elite set. Rows without tier info: every published
 * pick is kept and lastTierStatus says so.
 * A pick counts for a tier only if it was delivered to that tier's channels. Live picks
 * are sent to the Elite and Pro channels, so they're kept for those tiers.
 */
/** Tier names seen in the feed's `tiers` fields (for the Settings dropdown). */
export const tiersSeen = new Set<string>();
export let lastTierStatus: { tier: string; filtered: boolean; kept: number; dropped: number; droppedSample?: string[] } | null = null;
const TIER_RANK: Record<string, number> = { free: 0, pro: 1, elite: 2 };
/**
 * The tier to filter on, given the PredyGo key's own tier: a choice above the key's tier is
 * brought down to it (PredyGo only sends a key its own tier's picks, so a higher choice can't
 * add any; this just keeps the setting honest). Admin or unknown key tiers: the choice stands.
 */
export function tierForKey(chosen: string | undefined, keyTier: string | undefined): string | undefined {
  const k = TIER_RANK[String(keyTier ?? '').toLowerCase()], c = TIER_RANK[String(chosen ?? '')];
  if (k === undefined || k === 0) return chosen;
  if (chosen === 'any' || (c !== undefined && c > k)) return String(keyTier).toLowerCase();
  return chosen;
}
/** Tiers a key can choose from (null = no limit: admin or unknown). */
export function tiersForKey(keyTier: string | undefined): string[] | null {
  const k = TIER_RANK[String(keyTier ?? '').toLowerCase()];
  if (k === undefined || k === 0) return null;
  return Object.keys(TIER_RANK).filter((t) => t !== 'free' && TIER_RANK[t]! <= k);
}
/** Tiers each tier receives: higher tiers include every pick of the tiers below them. */
export const TIER_INCLUDES: Record<string, string[]> = { elite: ['elite', 'pro', 'free'], pro: ['pro', 'free'], free: ['free'] };

export function filterTier(rows: Row[], tier: string | undefined, record = true): Row[] {
  if (!tier || tier === 'any') { if (record) lastTierStatus = null; return rows; }
  const tiersOf = (r: Record<string, unknown>): string[] | null => {
    const t = pick(r, 'tier', 'tiers', 'plan_tier', 'plans');
    // Names like "Predygo Elite" or "ELITE" count as "elite". An empty list says nothing
    // (live picks go out through the API, not a channel): treated like no tier info.
    const norm = (x: unknown) => String(x).toLowerCase().replace(/^predygo[\s_-]*/, '').trim();
    if (Array.isArray(t)) return t.length ? t.map(norm).filter(Boolean) : null;
    if (typeof t === 'string' && t.trim()) return t.split(/[,;|]+/).map(norm).filter(Boolean);
    return null;
  };
  for (const r of rows) if (r && typeof r === 'object') for (const t of tiersOf(r as Record<string, unknown>) ?? []) if (t) tiersSeen.add(t);
  const known = rows.some((r) => r && typeof r === 'object' && tiersOf(r as Record<string, unknown>) !== null);
  if (!known) { if (record) lastTierStatus = { tier, filtered: false, kept: rows.length, dropped: 0 }; return rows; }
  const kept = rows.filter((r) => {
    const t = tiersOf(r as Record<string, unknown>);
    // No tier info on a row (live picks go out through the API with an empty list; a
    // brand-new pick may not have its deliveries recorded yet): keep it. Only a row that
    // names its tiers and leaves ours out is dropped.
    if (!t) return true;
    // Tiers are nested: Elite gets everything Pro and Free get, Pro gets everything Free gets.
    const covered = TIER_INCLUDES[tier] ?? [tier];
    return t.some((x) => covered.some((c) => x === c || x.split(/[\s_-]+/).includes(c)));
  });
  const droppedSample = rows.filter((r) => !kept.includes(r)).slice(0, 6).map((r: any) => `${pick(r, 'home') ?? '?'} v ${pick(r, 'away') ?? '?'} (${(tiersOf(r) ?? []).join('/') || 'no tiers'})`);
  if (record) lastTierStatus = { tier, filtered: true, kept: kept.length, dropped: rows.length - kept.length, droppedSample };
  return kept;
}

export async function loadPredictions(src: SourceConfig, timeZone = PREDYGO_TIMEZONE): Promise<Prediction[]> {
  let preds: Prediction[];
  if (src.type === 'predygo') {
    const base = (src.url ?? PREDYGO_API).replace(/\/(predictions|results)\/?$/, '').replace(/\/$/, '');
    const includeAll = src.includeAll !== false;
    const upcomingFeed = await getFeed(base, '/predictions', src.token, includeAll);
    lastFeedMode = upcomingFeed.mode;
    const upcoming = normalizeRows(upcomingFeed.mode === 'posted' ? filterTier(upcomingFeed.rows, src.tier) : upcomingFeed.rows, timeZone);
    // Graded history powers hit-rate calibration. Use the same list as the picks
    // (all vs posted) so hit rates describe the picks actually being traded.
    let history: Prediction[] = [];
    try {
      const hf = await getFeed(base, '/results', src.token, upcomingFeed.mode === 'all');
      history = normalizeRows(hf.mode === 'posted' ? filterTier(hf.rows, src.tier, false) : hf.rows, timeZone);
      // Published picks only, but an admin key: the full graded list goes back 90 days
      // (tier keys only get 7), and each row says whether it was published. Keep the
      // published rows for the chosen tier - a far bigger sample for the hit rates.
      if (hf.mode === 'posted') {
        try {
          const full = rowsFromPayload(await getJson(`${base}/results${feedQuery('/results', true)}`, src.token, true));
          const published = full.filter((r) => r && typeof r === 'object' && pick(r as Record<string, unknown>, 'posted') !== false && String(pick(r as Record<string, unknown>, 'posted') ?? 'true') !== 'false');
          if (published.length > history.length) history = normalizeRows(filterTier(published, src.tier, false), timeZone);
        } catch (e) {
          if (e instanceof FeedAuthError) throw e; // anything else (403 for tier keys): keep the 7 days
        }
      }
    } catch (e) {
      if (e instanceof FeedAuthError) throw e;
    }
    setLiveHistory(history);
    const seen = new Set<string>();
    preds = [...history, ...upcoming].filter((p) => {
      const k = `${p.id}|${p.won == null ? 'open' : 'graded'}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  } else {
    if (!src.path) throw new Error('source.path is not set');
    const text = readFileSync(src.path, 'utf-8');
    preds = normalizeRows(src.path.toLowerCase().endsWith('.csv') ? parseCsv(text) : rowsFromPayload(JSON.parse(text)), timeZone);
  }
  const min = src.minStatedPct ?? 0;
  return preds.filter((p) => p.won != null || !(p.statedPct < min));
}

/** The live-board query: in-play picks only (PredyGo, Oct 17). */
export const LIVE_QUERY = '?source=live&limit=500';
/** live_count from the latest live-board response (null if the server didn't send it). */
export let lastLiveCount: number | null = null;
export function liveCountOf(body: unknown): number | null {
  const n = body && typeof body === 'object' && !Array.isArray(body) ? Number((body as Record<string, unknown>).live_count) : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * Open in-play picks, for the live loop. Reads the posted list (where live picks are
 * published) and, when the key allows it, the full list too. One or two requests.
 */
export async function loadLivePicks(src: SourceConfig, timeZone = PREDYGO_TIMEZONE): Promise<Prediction[]> {
  if (src.type !== 'predygo') return [];
  const base = (src.url ?? PREDYGO_API).replace(/\/(predictions|results)\/?$/, '').replace(/\/$/, '');
  const lists = await Promise.all([
    // ?source=live = only the in-play board, best first, never hidden by the daily pick quota.
    // Servers without the parameter ignore it; rows are still filtered to live below.
    getJson(`${base}/predictions${LIVE_QUERY}`, src.token).then((body) => { lastLiveCount = liveCountOf(body); return rowsFromPayload(body); }).then((rows) => filterTier(rows, src.tier, false)),
    src.includeAll !== false && lastFeedMode !== 'posted'
      ? getJson(`${base}/predictions${feedQuery('/predictions', true)}&source=live`, src.token, true).then(rowsFromPayload).catch((e) => { if (e instanceof FeedAuthError) throw e; return [] as Row[]; })
      : Promise.resolve([] as Row[]),
  ]);
  const seen = new Set<string>();
  return normalizeRows(lists.flat(), timeZone).filter((p) => {
    if (!p.source || p.source.toLowerCase() === 'pregame' || p.won != null || seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });
}

/** Kept for callers/tests that used the old name. */
export const fromPredyGoRows = (rows: Row[], timeZone = PREDYGO_TIMEZONE) => normalizeRows(rows, timeZone);

// ------------------------------------------------------------ diagnostics

export interface FeedEndpointAudit {
  path: string;
  ok: boolean;
  status?: number;
  ms?: number;
  error?: string;
  rawRows?: number;
  parsedRows?: number;
  /** Why rows couldn't be read, with counts. */
  dropped?: Record<string, number>;
  fieldsSeen?: string[];
  bySource?: Record<string, number>;
  byResult?: Record<string, number>;
  /** Rows still using a retired bet name (e.g. VISITA MARCA REG), as sent by the server. */
  oldNames?: Record<string, number>;
  /** Live (in-play) rows in this response: match, bet, tiers, kickoff. */
  liveRows?: string[];
  /** Live rows for games that finished hours ago (still served as in play). */
  staleLive?: number;
  topLevel?: Record<string, unknown>;
}

