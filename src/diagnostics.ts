/**
 * Diagnostics: health checks for every connection and a step-by-step trace of
 * every pick in the feed, explaining exactly why it was or wasn't tradable.
 * Never includes keys or the password.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appHome, dailyLeft, killSwitchPath, liveLogPath, type AppConfig } from './config';
import { readJsonl } from './trade/picklog';
import type { KalshiCredentials } from './kalshi/client';
import { getBalance, getPositions } from './kalshi/account';
import { kalshiPrefixesFor, loadLeagueBook, MARKET_SUFFIXES, soccerSeries, type MarketSuffix } from './kalshi/markets';
import type { KalshiEvent } from './kalshi/types';
import { checkPredygoKey, loadPredictions, PREDYGO_API, type FeedEndpointAudit } from './predictions/sources';
import type { Prediction } from './predictions/types';
import { buildCalibration, calibrationLabel, liveRatesSummary, MIN_GRADED, MODEL_PREFIX, type BetCalibration } from './predictions/calibration';
import { describeSpec, parseBet, parseCanonical, resolveSpec, type BetSpec } from './match/bets';
import { discoverPrefixes, eventDate, eventTeams, findEvent, findMarket, matchPrediction } from './match/matcher';
import { teamSimilarity, TEAM_MATCH_THRESHOLD } from './match/teams';
import { priceMatch } from './pipeline';
import { checkRegion, loadEligibility } from './trade/eligibility';
import { grossSpentToday, spentToday, uncertainOrders } from './trade/ledger';
import { vaultPath } from './vault';

export type Status = 'ok' | 'warn' | 'fail' | 'info';

export interface Check {
  area: string;
  name: string;
  status: Status;
  detail: string;
}

export interface TraceStep {
  step: string;
  status: Status;
  detail: string;
}

export interface PickTrace {
  id: string;
  label: string;
  league: string;
  bet: string;
  kickoff: string;
  verdict: Status;
  summary: string;
  steps: TraceStep[];
  posted?: boolean;
  /** For unmapped leagues: Kalshi series that look like this league. */
  leagueSuggestions?: { prefix: string; title: string; score: number }[];
  /** For games not found: closest Kalshi games around that date. */
  nearest?: { ticker: string; title: string; date: string; home: number; away: number }[];
}

export interface DiagnosticsReport {
  generatedAt: string;
  version: string;
  checks: Check[];
  feed: { predictions?: FeedEndpointAudit; results?: FeedEndpointAudit };
  calibration: { bet: string; graded: number; hitRate: number; stdErr: number; stated: number | null; source: string; tradable: boolean }[];
  picks: PickTrace[];
  counts: Record<Status, number>;
}

const SUFFIX_FOR: Record<BetSpec['kind'], MarketSuffix> = { total: 'TOTAL', btts: 'BTTS', team_total: 'TEAMTOTAL', not_win: 'GAME' };
const SUFFIX_LABEL: Record<MarketSuffix, string> = { GAME: 'match winner', TOTAL: 'total goals', BTTS: 'both teams to score', TEAMTOTAL: 'team goals' };

const fmtTime = (iso: string) => new Date(iso).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function timed<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: string; ms: number }> {
  const t = Date.now();
  try { return { value: await fn(), ms: Date.now() - t }; } catch (e) { return { error: errMsg(e), ms: Date.now() - t }; }
}

// ------------------------------------------------------------ league suggestions

const LEAGUE_STOP = new Set(['league', 'liga', 'division', 'premier', 'first', 'game', 'super', 'primera', 'pro', 'the', 'de', 'cup', '1', 'i', 'a']);
const words = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter(Boolean);

/** Group pick outcomes into a few buckets, so "why so few trades" is answered at a glance. */
export function whyCounts(picks: { verdict: Status; summary: string }[]): [string, number][] {
  const bucket = (p: { verdict: Status; summary: string }) => {
    const s = p.summary;
    if (p.verdict === 'ok') return 'Tradable now';
    if (/^Graded result/.test(s)) return 'Already graded';
    if (/kicked off|Live picks section/i.test(s)) return 'Kicked off / live (see Live picks)';
    if (/scans look|later/i.test(s)) return 'Too far ahead (picked up later)';
    if (/isn't on Kalshi|League not on Kalshi|doesn't list/.test(s)) return 'Kalshi has no market for this league or bet type';
    if (/Game not found|matched two|not this line|Contract is/.test(s)) return 'Game or line not found on Kalshi';
    if (/edge/i.test(s)) return 'On Kalshi, but the price is too high for the hit rate';
    if (/^On Kalshi, not traded/.test(s)) return `On Kalshi, not traded: ${s.replace(/^On Kalshi, not traded: /, '').replace(/[\d.]+/g, '#').slice(0, 60)}`;
    return s.replace(/[\d.]+/g, '#').slice(0, 70) || 'Other';
  };
  const m = new Map<string, number>();
  for (const p of picks) m.set(bucket(p), (m.get(bucket(p)) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

export async function suggestLeagues(league: string): Promise<{ prefix: string; title: string; score: number }[]> {
  const series = await soccerSeries();
  const want = new Set(words(league));
  const wantCore = new Set([...want].filter((w) => !LEAGUE_STOP.has(w)));
  const out: { prefix: string; title: string; score: number }[] = [];
  for (const s of series) {
    if (!s.ticker.endsWith('GAME')) continue;
    const have = words(s.title);
    const core = have.filter((w) => wantCore.has(w)).length;
    if (core === 0) continue;
    const all = have.filter((w) => want.has(w)).length;
    out.push({ prefix: s.ticker.slice(0, -4), title: s.title, score: core * 2 + all });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 3);
}

// ------------------------------------------------------------ nearest games

function nearestGames(p: Prediction, events: KalshiEvent[]) {
  const kickoff = new Date(p.kickoff).getTime();
  return events
    .map((ev) => {
      const d = eventDate(ev.event_ticker);
      const teams = eventTeams(ev.title);
      if (!d || !teams || Math.abs(d.getTime() - kickoff) > 3 * 86_400_000) return null;
      const straight = [teamSimilarity(p.home, teams[0]), teamSimilarity(p.away, teams[1])] as const;
      return { ticker: ev.event_ticker, title: ev.title.split(':')[0]!, date: d.toISOString().slice(0, 10), home: +straight[0].toFixed(2), away: +straight[1].toFixed(2) };
    })
    .filter((x): x is NonNullable<typeof x> => !!x)
    .sort((a, b) => b.home + b.away - (a.home + a.away))
    .slice(0, 3);
}

// ------------------------------------------------------------ one pick

export async function tracePick(
  p: Prediction,
  cfg: AppConfig,
  calibration: Map<string, BetCalibration>,
  ctx: { now: Date; bankroll: number; dailyRemaining: number; horizonHours: number },
): Promise<PickTrace> {
  const steps: TraceStep[] = [];
  const t: PickTrace = {
    id: p.id, label: `${p.home} v ${p.away}`, league: p.league, bet: p.bet, kickoff: p.kickoff,
    verdict: 'fail', summary: '', steps, posted: p.posted,
  };
  const done = (verdict: Status, summary: string) => { t.verdict = verdict; t.summary = summary; return t; };

  // 1. Timing and source
  const mins = (new Date(p.kickoff).getTime() - ctx.now.getTime()) / 60_000;
  const when = mins >= 0 ? `kicks off ${fmtTime(p.kickoff)} (in ${mins < 120 ? Math.round(mins) + ' min' : (mins / 60).toFixed(1) + ' h'})` : `kicked off ${fmtTime(p.kickoff)} (${Math.round(-mins)} min ago)`;
  if (p.won != null) { steps.push({ step: 'Feed', status: 'info', detail: `Already graded (${p.won ? 'won' : 'lost'}).` }); return done('info', 'Graded result (history), not a live pick.'); }
  if (p.source && p.source.toLowerCase() !== 'pregame') { steps.push({ step: 'Feed', status: 'info', detail: `Source "${p.source}": checked by the Live picks section, not by the pre-game scan.` }); return done('info', 'In-play pick: see Live picks.'); }
  if (mins < 0) { steps.push({ step: 'Timing', status: 'info', detail: when }); return done('info', 'Already kicked off.'); }
  if (mins > ctx.horizonHours * 60) { steps.push({ step: 'Timing', status: 'info', detail: `${when}; scans look ${ctx.horizonHours} h ahead.` }); return done('info', `More than ${ctx.horizonHours} h away; will be checked later.`); }
  steps.push({ step: 'Timing', status: 'ok', detail: when });

  // 2. Bet type
  const fromCode = parseBet(p.bet);
  const fromCanon = parseCanonical(p.canonical);
  const { spec, conflict } = resolveSpec(p.bet, p.canonical);
  if (!spec) {
    const canon = p.canonical ? ` Market definition: ${JSON.stringify(p.canonical)}.` : ' No market definition in the feed.';
    steps.push({ step: 'Bet type', status: 'fail', detail: conflict ? `Code "${p.bet}" and the feed's market definition describe different bets, so it's skipped for safety.${canon}` : `"${p.bet}" has no Kalshi equivalent.${canon}` });
    return done('fail', conflict ? 'Bet code and definition disagree.' : `Bet type ${p.bet} isn't on Kalshi.`);
  }
  steps.push({ step: 'Bet type', status: 'ok', detail: `${p.bet} → ${describeSpec(spec)}${fromCode ? '' : ' (from the feed\'s market definition)'}${fromCode && fromCanon ? ' · code and definition agree' : ''}` });

  // 3. League
  let prefixes = kalshiPrefixesFor(p.league);
  let searched = false;
  if (prefixes.length === 0) {
    // Not in leagues.json: the scan searches every Kalshi soccer competition for this game.
    const found = await discoverPrefixes(p).catch(() => [] as string[]);
    if (found.length) { prefixes = found.slice(0, 2); searched = true; }
  }
  if (prefixes.length === 0) {
    try { t.leagueSuggestions = await suggestLeagues(p.league); } catch {}
    const hint = t.leagueSuggestions?.length
      ? ` Possible Kalshi series: ${t.leagueSuggestions.map((s) => `${s.prefix} ("${s.title}")`).join(', ')}. If one is right, add it to leagues.json.`
      : ' Kalshi doesn\'t appear to list this league.';
    steps.push({ step: 'League', status: 'fail', detail: `"${p.league}" isn't mapped to a Kalshi series.${hint}` });
    return done('fail', 'League not on Kalshi (or not mapped).');
  }
  steps.push({ step: 'League', status: 'ok', detail: searched ? `${p.league} isn't in leagues.json, but this game was found by searching Kalshi: ${prefixes.join(', ')}` : `${p.league} → ${prefixes.join(', ')}` });

  // 4. Market type in that league
  const suffix = SUFFIX_FOR[spec.kind];
  let anyEvents = false;
  const lines: string[] = [];
  const books = [];
  for (const prefix of prefixes) {
    const book = await loadLeagueBook(prefix);
    books.push(book);
    lines.push(MARKET_SUFFIXES.map((s) => `${SUFFIX_LABEL[s]}: ${book.seriesListed[s] ? `${book.events[s].length} games` : 'not offered'}`).join(' · '));
    if (book.events[suffix].length > 0) anyEvents = true;
  }
  if (!anyEvents) {
    steps.push({ step: 'Kalshi markets', status: 'fail', detail: `Kalshi has no "${SUFFIX_LABEL[suffix]}" games open in this league right now. Available: ${lines.join(' | ')}` });
    return done('fail', `Kalshi doesn't list ${SUFFIX_LABEL[suffix]} markets for ${p.league} right now.`);
  }
  steps.push({ step: 'Kalshi markets', status: 'ok', detail: lines.join(' | ') });

  // 5. The game
  let allEvents = books.flatMap((b) => b.events[suffix]);
  let found = findEvent(p, allEvents);
  if (!found.event && !searched) {
    // Listed under another competition (a cup, a playoff): the scan searches for it.
    const other = await discoverPrefixes(p, prefixes).catch(() => [] as string[]);
    if (other.length) {
      const extra = await Promise.all(other.slice(0, 2).map((x) => loadLeagueBook(x)));
      const evs = extra.flatMap((b) => b.events[suffix]);
      const again = findEvent(p, evs);
      if (again.event) { found = again; allEvents = evs; steps.push({ step: 'Search', status: 'info', detail: `Not under ${prefixes.join(', ')}; found by searching Kalshi under ${other.slice(0, 2).join(', ')}.` }); }
    }
  }
  if (!found.event) {
    t.nearest = nearestGames(p, allEvents);
    const near = t.nearest.length
      ? ` Closest Kalshi games: ${t.nearest.map((n) => `${n.title} (${n.date}, name match ${n.home}/${n.away})`).join('; ')}. Name match needs ${TEAM_MATCH_THRESHOLD} for both teams; if one of these is the same game, add a team alias.`
      : ' No Kalshi games for this league within 3 days of kickoff.';
    steps.push({ step: 'Game', status: 'fail', detail: (found.reason === 'ambiguous_event' ? `Matched more than one game: ${found.detail}.` : 'Not found on Kalshi.') + near });
    return done('fail', found.reason === 'ambiguous_event' ? 'Team names matched two Kalshi games.' : 'Game not found on Kalshi.');
  }
  steps.push({ step: 'Game', status: 'ok', detail: `${found.event.title.split(':')[0]} [${found.event.event_ticker}]` });

  // 6. The exact contract
  const market = findMarket(spec, p, found.event);
  if (!market) {
    const offered = (found.event.markets ?? []).map((m) => m.yes_sub_title ?? m.title).slice(0, 8).join('; ');
    steps.push({ step: 'Contract', status: 'fail', detail: `No contract for ${describeSpec(spec)}. Kalshi offers: ${offered || 'nothing'}.` });
    return done('fail', 'Game found, but not this line.');
  }
  if (market.status !== 'active') {
    steps.push({ step: 'Contract', status: 'fail', detail: `${market.ticker} is ${market.status}.` });
    return done('fail', `Contract is ${market.status}.`);
  }
  steps.push({ step: 'Contract', status: 'ok', detail: `${market.yes_sub_title ?? market.title} [${market.ticker}] · YES ask ${market.yes_ask_dollars ?? '–'} · NO ask ${market.no_ask_dollars ?? '–'}` });

  // 7. Price and checks (same code path as a scan)
  const match = await matchPrediction(p);
  if (!match.ok) { steps.push({ step: 'Price', status: 'warn', detail: `Market changed during the check (${match.reason}). Run again.` }); return done('warn', 'Market changed during check.'); }
  const priced = priceMatch(match, cfg, calibration, { bankroll: ctx.bankroll, dailyRemaining: ctx.dailyRemaining }, ctx.now);
  const cal = priced.probabilitySource;
  if (!priced.proposal) {
    steps.push({ step: 'Win probability', status: 'fail', detail: priced.reason + (cal ? ` (${cal.graded} graded, need ${MIN_GRADED})` : '') });
    return done('fail', priced.reason);
  }
  const pr = priced.proposal;
  steps.push({
    step: 'Win probability', status: 'ok',
    detail: cfg.calibration === 'hit-rate' && cal
      ? `${pct(pr.probability)} = real hit rate of PredyGo's ${p.bet} picks (${cal.wins}/${cal.graded} won, ${cal.source === 'history' ? 'from your results feed' : cal.source === 'combined' ? 'Oct 14 snapshot + newer results from your feed' : 'bundled full-list snapshot'}). PredyGo stated ${p.statedPct}%.`
      : `${pct(pr.probability)} (stated confidence)`,
  });
  if (priced.kickoffMismatch) steps.push({ step: 'Kickoff check', status: 'fail', detail: `Feed kickoff ${fmtTime(p.kickoff)} disagrees with Kalshi's schedule for ${market.ticker}. Usually a time-zone problem in the feed.` });
  steps.push({
    step: 'Price', status: pr.edge > 0 ? 'ok' : 'warn',
    detail: `Buy ${pr.match.side.toUpperCase()} at ${Math.round(pr.quote.ask * 100)}¢ + fee = ${(pr.cost * 100).toFixed(1)}¢ per $1 payout · spread ${pr.quote.spreadCents}¢ · edge ${pr.edge >= 0 ? '+' : ''}${pct(pr.edge)} (need ${pct(pr.required ?? cfg.risk.minEdge)} = ${pct(cfg.risk.minEdge)} base + ${cfg.risk.edgeUncertainty}× ±${pct(cal?.stdErr ?? 0.03)} hit-rate uncertainty)`,
  });
  if (pr.skip) {
    steps.push({ step: 'Checks', status: 'warn', detail: `Skipped: ${pr.skip}.` });
    return done('warn', `On Kalshi, not traded: ${pr.skip}.`);
  }
  steps.push({ step: 'Checks', status: 'ok', detail: `Passes all checks: ${pr.contracts} contracts ≈ $${(pr.contracts * pr.cost).toFixed(2)} incl. fees.` });
  return done('ok', `Tradable: ${pr.contracts} × ${pr.match.side.toUpperCase()} at ${Math.round(pr.quote.ask * 100)}¢, edge ${pct(pr.edge)}.`);
}

// ------------------------------------------------------------ full report

export async function runDiagnostics(opts: {
  cfg: AppConfig;
  creds: KalshiCredentials;
  predygoKey: string;
  version: string;
  recentErrors?: string[];
  autoOn?: boolean;
  feedMode?: 'all' | 'posted' | null;
  tier?: string;
  useKalshiOdds?: boolean;
  /** App trades still open, with what Kalshi holds for each (null = Kalshi not read yet). */
  tradeCheck?: { ticker: string; match: string | null; side: string; appQty: number; kalshiQty: number | null; status: string }[];
  /** What the trade list reconciles from (tracker.syncStatus). */
  sync?: { fills: { count: number } | null; positions: { count: number } | null; settlements: { count: number; earliest: string | null } | null; errors: Record<string, string>;
    settledTrades: { ticker: string; match: string | null; status: string; contracts: number; pnl: number | null; heldAtSettlement: number | null }[] };
  horizonHours?: number;
}): Promise<DiagnosticsReport> {
  const { cfg, creds } = opts;
  const now = new Date();
  const horizonHours = opts.horizonHours ?? 72;
  const checks: Check[] = [];
  const add = (area: string, name: string, status: Status, detail: string) => { checks.push({ area, name, status, detail }); };

  // App
  add('App', 'Version', 'info', `${opts.version} · ${process.platform} · data folder ${appHome()}`);
  if (process.platform === 'win32') {
    try {
      const { taskInstalled, windowsUser } = await import('./service');
      const { autoUnlockSaved } = await import('./vault');
      const on = await taskInstalled(true);
      add('App', 'Background mode', 'info', on ? `On: starts with Windows as ${windowsUser()}${autoUnlockSaved() ? ', unlocks itself' : ' (saved unlock missing: turn it off and on again)'}` : 'Off: runs only while the window is open');
    } catch {}
  }
  try {
    const exits = readFileSync(join(appHome(), 'exits.log'), 'utf8').trim().split('\n').slice(-3);
    if (exits.length && exits[0]) add('App', 'Last stops', 'info', exits.map((l) => { const [at, ...r] = l.split(' '); return `${new Date(at!).toLocaleString()}: ${r.join(' ')}`; }).join(' · '));
  } catch {}
  try {
    const wrap = JSON.parse(readFileSync(vaultPath(), 'utf8')).wrap;
    add('App', 'Saved keys', wrap === 'dpapi' ? 'ok' : process.platform === 'win32' ? 'warn' : 'ok',
      wrap === 'dpapi' ? 'Encrypted with your password and locked to this Windows account' : 'Encrypted with your password (Windows account lock unavailable on this PC)');
  } catch { add('App', 'Saved keys', 'fail', 'Could not read vault file'); }

  // PredyGo
  const me = await timed(() => checkPredygoKey(opts.predygoKey));
  add('PredyGo', 'API key', me.error ? 'fail' : 'ok', me.error ?? `Accepted · tier ${me.value?.tier ?? '?'} · scope ${me.value?.scope ?? '?'} · picks/day ${me.value?.pickLimit == null ? (me.value?.tier === 'admin' ? 'uncapped' : '?') : me.value.pickLimit} · live picks ${me.value?.liveLimit == null ? (me.value?.tier === 'admin' ? 'uncapped' : '?') : me.value.liveLimit} · ${me.ms} ms`);
  if (opts.useKalshiOdds !== undefined) add('Settings', 'Odds used', 'info', opts.useKalshiOdds
    ? "Kalshi odds over feed odds: Kalshi live prices are used and the feed's odds are ignored. Live picks already in play are judged on Kalshi's price now; price skips re-checked every minute."
    : "Feed odds: the feed's odds can block trades; live picks open at app start are not traded.");

  // Kalshi
  const t0 = Date.now();
  const ex = await timed(async () => {
    const res = await fetch('https://api.elections.kalshi.com/trade-api/v2/exchange/status', { signal: AbortSignal.timeout(15_000) });
    return { body: (await res.json()) as { exchange_active?: boolean; trading_active?: boolean }, date: res.headers.get('date') };
  });
  if (ex.error) add('Kalshi', 'Exchange', 'fail', ex.error);
  else {
    const b = ex.value!.body;
    add('Kalshi', 'Exchange', b.exchange_active && b.trading_active ? 'ok' : 'warn', `${b.exchange_active ? 'open' : 'closed'} · trading ${b.trading_active ? 'active' : 'paused'} · ${ex.ms} ms`);
    if (ex.value!.date) {
      const skew = (new Date(ex.value!.date).getTime() - (t0 + ex.ms / 2)) / 1000;
      add('Kalshi', 'PC clock', Math.abs(skew) > 20 ? 'fail' : Math.abs(skew) > 5 ? 'warn' : 'ok',
        Math.abs(skew) <= 5 ? 'In sync' : `Your clock is ${Math.abs(skew).toFixed(0)} s ${skew > 0 ? 'behind' : 'ahead'}. Kalshi rejects signed requests when the clock is off; turn on "Set time automatically" in Windows.`);
    }
  }
  const bal = await timed(() => getBalance(creds));
  add('Kalshi', 'Account', bal.error ? 'fail' : 'ok', bal.error ?? `${creds.env === 'prod' ? 'LIVE' : 'DEMO'} · cash $${(bal.value!.cashCents / 100).toFixed(2)} · ${bal.ms} ms`);
  const pos = await timed(() => getPositions(creds));
  if (!pos.error) add('Kalshi', 'Open positions', pos.value!.size >= cfg.risk.maxOpenPositions ? 'warn' : 'info', `${pos.value!.size} of max ${cfg.risk.maxOpenPositions}`);
  try {
    const series = await soccerSeries();
    add('Kalshi', 'Soccer markets', series.length ? 'ok' : 'warn', `${series.length} soccer series listed`);
  } catch (e) { add('Kalshi', 'Soccer markets', 'fail', errMsg(e)); }

  // Region and safety
  const elig = await loadEligibility(cfg.eligibilityUrl);
  const st = checkRegion(cfg, elig);
  add('Trading', 'Region', st.ok ? 'ok' : 'fail', st.ok ? `${st.label}: allowed (list as of ${elig.asOf}). Kalshi's own account checks still apply.` : st.reason);
  const kill = existsSync(killSwitchPath());
  add('Trading', 'Kill switch', kill ? 'warn' : 'ok', kill ? 'ON: no orders will be placed' : 'Off');
  add('Trading', 'Mode', 'info', opts.autoOn ? 'Auto-trade ON' : 'Manual: you click Place');
  const spent = spentToday(creds.env);
  if (opts.tradeCheck) {
    const tc = opts.tradeCheck;
    const off = tc.filter((t) => t.kalshiQty != null && Math.abs(t.kalshiQty - t.appQty) > 0.01);
    add('Trading', 'Trades vs Kalshi', off.length ? 'warn' : 'ok', !tc.length ? 'No open app trades.'
      : tc.every((t) => t.kalshiQty == null) ? `${tc.length} open trade(s); Kalshi account not read yet (checked every minute).`
      : off.length ? `${off.length} open trade(s) don't match your Kalshi account: ${off.slice(0, 8).map((t) => `${t.match ?? t.ticker} ${t.side.toUpperCase()} app ${t.appQty} vs Kalshi ${t.kalshiQty}`).join(' | ')}`
      : `All ${tc.length} open trade(s) match your Kalshi account.`);
  }
  if (opts.sync) {
    const y = opts.sync;
    const errs = Object.entries(y.errors);
    // Graded won/lost while Kalshi says fewer contracts were held at settlement = sold, mis-graded.
    const bad = y.settledTrades.filter((t) => (t.status === 'won' || t.status === 'lost') && t.heldAtSettlement != null && t.heldAtSettlement + 0.01 < t.contracts);
    const noRec = y.settledTrades.filter((t) => (t.status === 'won' || t.status === 'lost') && t.heldAtSettlement == null).length;
    add('Trading', 'Results vs Kalshi settlements', errs.length || bad.length ? 'warn' : 'ok',
      `Read from Kalshi: ${y.fills ? y.fills.count + ' fills' : 'fills not read'}, ${y.positions ? y.positions.count + ' positions' : 'positions not read'}, ${y.settlements ? y.settlements.count + ' settlement records' + (y.settlements.earliest ? ` (from ${y.settlements.earliest.slice(0, 10)})` : '') : 'settlements not read'}` +
      (errs.length ? ` · errors: ${errs.map(([k, v]) => `${k}: ${v}`).join(' | ')}` : '') +
      ` · ${y.settledTrades.length} settled trade(s): ${y.settledTrades.filter((t) => t.status === 'won').length} won, ${y.settledTrades.filter((t) => t.status === 'lost').length} lost, ${y.settledTrades.filter((t) => t.status === 'sold').length} sold` +
      (noRec ? ` · ${noRec} graded without a Kalshi settlement record` : '') +
      (bad.length ? ` · ${bad.length} graded won/lost but Kalshi held fewer at settlement: ${bad.slice(0, 6).map((t) => `${t.match ?? t.ticker} (${t.status}, held ${t.heldAtSettlement} of ${t.contracts})`).join(' | ')}` : ''));
  }
  const capped = cfg.risk.maxDailySpend > 0;
  add('Trading', 'Daily limit', capped && spent >= cfg.risk.maxDailySpend ? 'warn' : 'info', `$${spent.toFixed(2)} ${capped ? `of $${cfg.risk.maxDailySpend.toFixed(2)} ` : ''}used today${capped ? '' : ' (no daily limit)'}${grossSpentToday(creds.env) > spent + 0.005 ? ` ($${grossSpentToday(creds.env).toFixed(2)} spent, less winnings already paid back)` : ''}${capped && spent >= cfg.risk.maxDailySpend ? ' — limit reached, no new trades until the day resets' : ''} · $${cfg.risk.maxNotionalPerOrder} per trade${cfg.risk.autoSize !== false ? ' (limits sized from balance)' : ''} · min edge ${pct(cfg.risk.minEdge)} + ${cfg.risk.edgeUncertainty}× hit-rate uncertainty · min win chance ${Math.round((cfg.risk.minProbability ?? 0) * 100)}% · ${cfg.risk.stakeMode === 'flat' ? 'flat stakes' : 'Kelly stakes'} up to ${Math.round(cfg.risk.maxPositionPct * 100)}% of cash · live ${cfg.live.mode}`);
  const unsure = uncertainOrders(creds.env);
  if (unsure.length) add('Trading', 'Unconfirmed orders', 'warn', `${unsure.length} order(s) got no reply from Kalshi: ${unsure.map((o) => o.ticker).join(', ')}. Check your Kalshi portfolio.`);
  for (const e of opts.recentErrors ?? []) add('Recent errors', 'Log', 'warn', e);

  // Picks
  let preds: Prediction[] = [];
  const feedLoad = await timed(() => loadPredictions({ ...cfg.source, type: 'predygo', url: PREDYGO_API, token: opts.predygoKey }));
  if (feedLoad.error) add('PredyGo', 'Load', 'fail', feedLoad.error);
  else preds = feedLoad.value!;
  const calibrationMap = buildCalibration(preds);
  const bankroll = bal.value ? bal.value.cashCents / 100 : 0;
  const dailyRemaining = dailyLeft(cfg.risk, spent);
  // Games more than 3 hours past kickoff are over, even if PredyGo still lists them as pending
  // or in play. The app never trades them.
  const STALE_MS = 3 * 3600_000;
  const stale = preds.filter((p) => p.won == null && now.getTime() - Date.parse(p.kickoff) > STALE_MS);
  const open = preds.filter((p) => p.won == null && !stale.includes(p));
  const picks: PickTrace[] = [];
  for (const p of open) {
    try { picks.push(await tracePick(p, cfg, calibrationMap, { now, bankroll, dailyRemaining, horizonHours })); }
    catch (e) { picks.push({ id: p.id, label: `${p.home} v ${p.away}`, league: p.league, bet: p.bet, kickoff: p.kickoff, verdict: 'fail', summary: `Check failed: ${errMsg(e)}`, steps: [] }); }
  }
  const order: Record<Status, number> = { ok: 0, warn: 1, fail: 2, info: 3 };
  picks.sort((a, b) => order[a.verdict] - order[b.verdict] || a.kickoff.localeCompare(b.kickoff));

  const calibration = [...calibrationMap.values()].sort((a, b) => b.graded - a.graded).map((c) => ({
    bet: calibrationLabel(c.bet), graded: c.graded, hitRate: c.probability, stdErr: c.stdErr, stated: c.avgStatedPct, source: c.source, tradable: c.graded >= MIN_GRADED,
  }));
  if (calibration.length && !calibration.every((c) => c.source === 'snapshot')) {
    add('PredyGo', 'Hit rates', 'ok', `From your results feed: ${calibration.filter((c) => c.source !== 'snapshot').map((c) => `${c.bet} ${c.graded}`).join(', ')}`);
  }

  const counts: Record<Status, number> = { ok: 0, warn: 0, fail: 0, info: 0 };
  for (const c of checks) counts[c.status]++;
  return { generatedAt: now.toISOString(), version: opts.version, checks, feed: {}, calibration, picks, counts };
}

// ------------------------------------------------------------ plain-text report

const ICON: Record<Status, string> = { ok: '[OK]  ', warn: '[WARN]', fail: '[FAIL]', info: '[INFO]' };

export function reportText(r: DiagnosticsReport): string {
  const out: string[] = [];
  out.push(`Soccer Edge diagnostics · ${new Date(r.generatedAt).toLocaleString()} · v${r.version}`);
  out.push('(No keys or passwords are included in this report.)', '');
  let area = '';
  for (const c of r.checks) {
    if (c.area !== area) { area = c.area; out.push(`== ${area}`); }
    out.push(`${ICON[c.status]} ${c.name}: ${c.detail}`);
  }
  for (const [k, a] of Object.entries(r.feed)) {
    if (a?.ok) out.push(`   ${k} fields: ${a.fieldsSeen?.join(', ')}${a.byResult ? ` · results: ${JSON.stringify(a.byResult)}` : ''}`);
  }
  out.push('', '== Hit rates used');
  for (const c of r.calibration.filter((c) => !/\(model picks\)/.test(c.bet))) out.push(`   ${c.bet.padEnd(18)} ${String(c.graded).padStart(4)} graded · hit ${(c.hitRate * 100).toFixed(1)}% ±${(c.stdErr * 100).toFixed(1)} · stated ${c.stated?.toFixed(1) ?? '-'}% · ${c.source}${c.tradable ? '' : ' · not traded (too few)'}`);
  {
    const lr = liveRatesSummary();
    out.push('', '== Live win rates (graded live picks in your results feed)');
    if (!lr.length) out.push('   none yet: live picks use all graded live picks at that stage of the game, or PredyGo\'s stated confidence until 30 are graded');
    for (const x of lr) out.push(`   ${x.bet.padEnd(14)} ${x.stage.padEnd(28)} ${String(x.graded).padStart(4)} graded · won ${(100 * x.wins / x.graded).toFixed(0)}%${x.used ? '' : ' · built-in table used (fewer than 30)'}`);
  }
  out.push('', '== Why picks did or didn\'t trade');
  for (const [k, n] of whyCounts(r.picks)) out.push(`   ${String(n).padStart(4)}  ${k}`);
  out.push('', `== Picks (${r.picks.length})`);
  for (const p of r.picks) {
    out.push(`${ICON[p.verdict]} ${p.label} · ${p.league} · ${p.bet} · ${new Date(p.kickoff).toLocaleString()}`);
    out.push(`        ${p.summary}`);
    for (const s of p.steps) out.push(`        - ${s.step}: ${s.detail}`);
  }
  return out.join('\n');
}
