/**
 * Desktop app: a local-only web UI opened as an app window (Edge --app on Windows).
 *
 * Security:
 *  - Listens on 127.0.0.1 only, random port.
 *  - Every API call needs a per-launch random token, and the Host header must be
 *    the loopback address (blocks other websites and DNS-rebinding).
 *  - Secrets stay in memory after unlock; "Lock" wipes them.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appHome, DEFAULT_CONFIG, pregameOn, ruleOn, applyAutoSize, dailyLeft, effectiveConfig, ensureHome, killSwitchPath, loadConfig, saveConfig, type AppConfig, type RiskConfig } from '../config';
import type { KalshiCredentials } from '../kalshi/client';
import { getBalance, getPositions } from '../kalshi/account';
import { connectKalshi, normalizeKeyId, normalizePrivateKey } from '../kalshi/keys';
import { checkPredygoKey, FeedAuthError, PREDYGO_API, tierForKey, tiersForKey, type PredygoAccount } from '../predictions/sources';
import { scan, type ScanResult } from '../pipeline';
import { reportText, runDiagnostics, type DiagnosticsReport } from '../diagnostics';
import { clearMarketCache } from '../kalshi/markets';
import { lastFeedMode } from '../predictions/sources';
import { APP_VERSION } from '../version';
import { DISCLAIMER_ACKS, DISCLAIMER_VERSION } from '../disclaimer';
import { AUTOMATION_KEYS, exportSettingsXml, importSettingsXml, pendingSettingsFile, type ImportResult } from '../settings-xml';
import { failureLabel } from '../format';
import { checkRegion, countryOptions, loadEligibility, regionLabel, regionOf, US_STATES } from '../trade/eligibility';
import { execute, killSwitchActive } from '../trade/executor';
import { cancelAllAppOrders, syncResting, type KeepCheck } from '../trade/resting';
import { scorecard } from '../trade/scorecard';
import { priceSkip } from '../trade/edge';
import { AUTO_SIZED, isRequired, RULE_FIELDS, ruleFieldValue, RULES, rulesView, setPath } from '../trade/rules';
import { readLedger, record, restingExposure, restingOrders, setDailyCredit, spentToday, tradedPredictionIds, tradedTickers, uncertainOrders } from '../trade/ledger';
import { maxForcedContracts, type Proposal } from '../trade/edge';
import { LiveEngine, type LiveContext } from '../live';
import { liveStagesSummary } from '../predictions/calibration';
import { KalshiStream } from '../kalshi/stream';
import { TradeTracker, priceHistory } from '../trade/tracker';
import { precheck } from '../ai/assistant';
import { callAI, chatAI, DEFAULT_MODEL, keyLooksRight, listModels, MODEL_CHOICES, pickModel, PROVIDER_NAME, providerOf, spentTodayByPurpose, spentTodayUsd, type AiProvider, type ModelChoice } from '../ai/claude';
import { readJsonl } from '../trade/picklog';
import { picksLogPath, liveLogPath } from '../config';
import { getMarket, getPositionsDetail } from '../kalshi/account';
import { logPicks } from '../trade/picklog';
import { backfillJournal, journalOutcome, journalRows } from '../trade/journal';
import { tiersSeen } from '../predictions/sources';
import type { Prediction } from '../predictions/types';
import { buildExport } from '../export';
import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import { exportsDir } from '../config';
import {
  autoUnlockSaved, clearAutoUnlock, deleteVault, loadAutoUnlock, loadVault, MIN_PASSWORD_LENGTH, samePassword, saveAutoUnlock, saveVault, vaultExists, WrongPasswordError, type Secrets,
} from '../vault';
import { deleteTask, installTask, runTask, serviceSupported, taskInstalled, windowsUser } from '../service';
import { renderPage } from './page';

const IDLE_EXIT_MS = 3 * 60_000;
/** Longest a scan / trade cycle may take before the app stops waiting for it. */
const CYCLE_LIMIT_MS = 5 * 60_000;

/** Resolve or reject with the promise, or reject after ms (the slow work carries on unwatched). */
export function withTimeout<T>(p: Promise<T>, ms: number, why: () => string): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<T>((_, rej) => { t = setTimeout(() => rej(new Error(why())), ms); })]).finally(() => clearTimeout(t));
}
let shutdown: (reason: string) => void = () => {};
let openWindowHere: () => void = () => {};

interface Session {
  secrets: Secrets;
  creds: KalshiCredentials;
  cashCents: number;
  /** Market value of open positions (Kalshi's portfolio_value), cents. */
  positionsCents?: number;
  predygo?: PredygoAccount;
  /** Kalshi positions (ticker -> contracts) from the last refresh. */
  held?: Map<string, number>;
}

interface LogLine { at: string; level: 'info' | 'warn' | 'error' | 'trade'; msg: string }

export interface ServerHandle { url: string; port: number; stop: () => void }

export async function startGui(opts: { openWindow?: boolean; port?: number; exitWhenIdle?: boolean; background?: boolean } = {}): Promise<ServerHandle> {
  ensureHome();
  const token = randomBytes(24).toString('hex');
  let session: Session | null = null;
  let lastScan: { at: string; result: ScanResult } | null = null;
  let auto = { on: false, nextAt: null as string | null, timer: null as ReturnType<typeof setTimeout> | null };
  /** Why auto-trade didn't buy a pick the table shows as ready (checks made only at order time). */
  const autoNotes = new Map<string, { at: number; reason: string }>();
  /** Background mode: started by Windows, keeps running with no window open. */
  let background = !!opts.background;
  let busy = false;
  let cycleRunning = false;
  let cycleStep = '';
  let lastBeat = Date.now();
  let failedUnlocks = 0;
  let diag: { running: boolean; report: DiagnosticsReport | null; text: string | null; error: string | null } = { running: false, report: null, text: null, error: null };
  let unlockBlockedUntil = 0;
  const logs: LogLine[] = [];
  const liveEngine = new LiveEngine();
  let stream: KalshiStream | null = null;
  const marketTitles = new Map<string, string>();
  const tracker = new TradeTracker(() => session?.creds ?? null);
  // Winnings from today's settled trades free up the daily limit.
  setDailyCredit((env) => tracker.paidBackToday(env));
  let restPositions: { at: number; rows: Awaited<ReturnType<typeof getPositionsDetail>> } = { at: 0, rows: [] };
  let liveTimer: ReturnType<typeof setTimeout> | null = null;
  let livePolling = false;

  const log = (level: LogLine['level'], msg: string) => {
    logs.push({ at: new Date().toISOString(), level, msg });
    if (logs.length > 300) logs.splice(0, logs.length - 300);
  };

  // A half-written or hand-edited config.json must never stop the timers: keep the last good one.
  let lastGoodCfg: AppConfig | null = null;
  let cfgErrorLogged = false;
  const safeConfig = (): AppConfig => {
    try { lastGoodCfg = loadConfig(); cfgErrorLogged = false; }
    catch (e) {
      if (!lastGoodCfg) throw e;
      if (!cfgErrorLogged) { log('error', `config.json could not be read (${errMsg(e)}); using the last good settings.`); cfgErrorLogged = true; }
    }
    // Rules switched off are opened up for trading; the saved settings stay as they are.
    return effectiveConfig(structuredClone(lastGoodCfg!));
  };

  /** A saved tier above the PredyGo key's own tier is brought down to it (and saved, with a note). */
  const clampTier = () => {
    const keyTier = session?.predygo?.tier;
    const cfg = loadConfig();
    const t = tierForKey(cfg.source.tier, keyTier);
    if (t && t !== cfg.source.tier) {
      log('info', `PredyGo tier set to ${t}: your key is ${keyTier}, so it only receives ${t} picks (and the tiers below).`);
      cfg.source = { ...cfg.source, tier: t };
      saveConfig(cfg);
    }
  };

  const cfgFor = (s: Session): AppConfig => {
    const cfg = safeConfig();
    cfg.kalshi.env = s.creds.env;
    cfg.source = { type: 'predygo', url: PREDYGO_API, token: s.secrets.predygoKey, minStatedPct: cfg.source.minStatedPct, includeAll: !ruleOn(cfg.risk, 'published'), tier: cfg.source.tier };
    return cfg;
  };

  const lock = () => {
    stopScheduler();
    stopLive();
    stopStream();
    if (session) {
      session.secrets.kalshiPrivateKeyPem = '';
      session.secrets.predygoKey = '';
      session.creds.privateKeyPem = '';
    }
    session = null;
    lastScan = null;
  };

  // ------------------------------------------------------------ actions

  async function withBusy<T>(fn: () => Promise<T>): Promise<T> {
    if (busy) throw new Error('Still working on the previous action. Try again in a moment.');
    busy = true;
    try { return await fn(); } finally { busy = false; }
  }

  /** Log each trade once, the moment it's decided (goal scored) and when Kalshi settles it. */
  const announced = new Map<string, string>();
  let announcedPrimed = false;
  function announceResults<T extends { rows: { ticker: string; match: string | null; bet: string | null; title: string; status: string; decided?: string | null; pnl: number | null }[] }>(t: T): T {
    const stateOf = (r: T['rows'][number]) => (r.status === 'won' || r.status === 'lost' || r.status === 'sold' ? r.status : r.decided ? `decided-${r.decided}` : null);
    for (const r of t.rows) {
      const state = stateOf(r);
      const prev = announced.get(r.ticker);
      announced.set(r.ticker, state ?? 'open');
      if (!state) continue;
      // Only news: a trade this session already saw before, whose result just changed. A trade
      // first seen already settled (first look after start, or older trades coming into the
      // list, e.g. switching Today / All) is history, not activity. Settling a trade already
      // announced as decided the same way isn't news either.
      if (!announcedPrimed || prev === undefined || prev === state || prev === `decided-${state}`) continue;
      const name = `${r.match ?? r.title}${r.bet ? ` · ${r.bet}` : ''}`;
      const pnl = r.pnl == null ? '' : ` (${r.pnl >= 0 ? '+' : '-'}$${Math.abs(r.pnl).toFixed(2)})`;
      if (state === 'decided-won') log('trade', `✓ WON: ${name}${pnl} - bet condition met; Kalshi pays out when it settles.`);
      else if (state === 'decided-lost') log('trade', `✗ LOST: ${name}${pnl} - bet condition can no longer be met.`);
      else if (state === 'won') log('trade', `✓ Won: ${name}${pnl}.`);
      else if (state === 'sold') log('trade', `↩ Sold on Kalshi: ${name}${pnl} - closed outside the app; P/L is what came back.`);
      else log('trade', `✗ Lost: ${name}${pnl}.`);
    }
    announcedPrimed = true;
    if (Date.now() - journalCheckedAt > 20_000) { journalCheckedAt = Date.now(); try { journalTradeOutcomes(t.rows); } catch {} }
    return t;
  }

  /** Trade journal: record each trade's early decision and Kalshi settlement once. */
  let journalCheckedAt = 0;
  function journalTradeOutcomes(rows: { ticker: string; status: string; decided?: string | null; value?: number | null; pnl?: number | null }[]) {
    for (const j of journalRows()) {
      const e = j.entry as any;
      const tr = rows.find((r) => r.ticker === e.kalshi.ticker);
      if (!tr) continue;
      if (!j.decided && (tr.decided === 'won' || tr.decided === 'lost')) journalOutcome({ key: e.key, kind: 'decided', result: tr.decided, detail: 'bet condition met/failed before settlement (Kalshi price 99c+/1c-)' });
      if (!j.settled && (tr.status === 'won' || tr.status === 'lost')) {
        const filled = Number(e.order.filled) || 0;
        const payout = tr.status === 'won' ? filled : 0;
        journalOutcome({ key: e.key, kind: 'settled', result: tr.status, payout: +payout.toFixed(2), pnl: +(payout - (Number(e.order.cost) || 0)).toFixed(2) });
      }
      if (!j.settled && tr.status === 'sold' && tr.value != null) {
        journalOutcome({ key: e.key, kind: 'settled', result: 'sold', payout: +Number(tr.value).toFixed(2), pnl: +(Number(tr.value) - (Number(e.order.cost) || 0)).toFixed(2), detail: 'closed on Kalshi before settlement (sold or netted off)' });
      }
    }
  }

  /** Trade journal: PredyGo's own grading of each traded pick (from the results feed). */
  function journalPredygoGrades(graded: Prediction[]) {
    const byId = new Map(graded.map((g) => [g.id, g]));
    for (const j of journalRows()) {
      if (j.predygo) continue;
      const e = j.entry as any;
      const g = byId.get(e.predygo.id) ?? graded.find((x) => x.home === e.predygo.home && x.away === e.predygo.away && x.bet === e.predygo.bet && x.kickoff === e.predygo.kickoff);
      if (g && g.won != null) journalOutcome({ key: e.key, kind: 'predygo', result: g.won ? 'won' : 'lost', detail: g.score ? `score ${g.score.join('-')}` : undefined });
    }
  }

  /** Balance (cash + open positions) used for automatic limits. */
  const bankrollNow = () => (session ? (session.cashCents + (session.positionsCents ?? 0)) / 100 : 0);

  /** Recompute per-trade / open positions / daily limits from the balance when auto-size is on. */
  function autoSizeNow(): void {
    try {
      const c = loadConfig();
      if (applyAutoSize(c, bankrollNow())) {
        saveConfig(c);
        log('info', `Limits sized to your $${bankrollNow().toFixed(2)} balance: up to $${c.risk.maxNotionalPerOrder} per trade (${Math.round(c.risk.maxPositionPct * 100)}%), ${c.risk.maxDailySpend > 0 ? `$${c.risk.maxDailySpend} a day` : 'no daily limit'}, up to ${Math.round((c.risk.maxOpenExposurePct ?? 0.3) * 100)}% of it in open bets, split across as many picks as qualify.`);
      }
    } catch {}
  }

  async function doScan(): Promise<ScanResult> {
    if (!session) throw new Error('Locked.');
    const s = session;
    const [bal, held] = await Promise.all([getBalance(s.creds), getPositions(s.creds).catch(() => s.held)]);
    s.cashCents = bal.cashCents;
    s.positionsCents = bal.portfolioValueCents;
    tracker.recordBalance(bal.cashCents / 100, bal.portfolioValueCents / 100);
    autoSizeNow();
    const cfg = cfgFor(s);
    if (held) s.held = held;
    const dailyRemaining = dailyLeft(cfg.risk, spentToday(s.creds.env));
    const mineResting = restingOrders(s.creds.env);
    // Kalshi holds back the cash our waiting orders could spend; size as if it were free, or a
    // waiting order would look unaffordable and be cancelled and re-placed every other scan.
    const heldBack = mineResting.reduce((a, o) => a + restingExposure(o), 0);
    const result = await scan(cfg, { bankroll: bal.cashCents / 100 + heldBack, dailyRemaining, horizonHours: 72, ownBid: (t) => mineResting.find((o) => o.ticker === t)?.limitPrice });
    lastScan = { at: new Date().toISOString(), result };
    try { journalPredygoGrades(result.graded ?? []); } catch {}
    setTimeout(updateStreamMarkets, 0);
    try { logPicks(result.proposals, s.creds.env); } catch {}
    const tradable = result.proposals.filter((p) => !p.skip && p.contracts > 0).length;
    log('info', `Scan: ${result.upcoming.length} upcoming picks, ${result.results.filter((r) => r.ok).length} on Kalshi, ${tradable} worth trading.`);
    return result;
  }

  // ------------------------------------------------------------ AI assistant (Claude or ChatGPT, one at a time)


  /** One assistant at a time: the chosen provider's key, if the AI check is on. */
  const providerNow = (): AiProvider => (safeConfig().ai?.provider === 'chatgpt' ? 'chatgpt' : 'claude');
  const keyFor = (p: AiProvider) => (p === 'chatgpt' ? session?.secrets.openaiKey : session?.secrets.anthropicKey) || null;
  const aiName = () => PROVIDER_NAME[providerNow()];
  const aiKey = () => (safeConfig().ai?.enabled ? keyFor(providerNow()) : null);

  /**
   * Models the provider offers this key right now (asked at unlock, key save, assistant switch,
   * then daily, and again if a call says the model is gone). A saved model that's no longer
   * offered is replaced by the cheapest one still there, so a retired model is never used.
   */
  const discovered: Partial<Record<AiProvider, { at: number; list: ModelChoice[] }>> = {};
  const modelsFor = (p: AiProvider): ModelChoice[] => discovered[p]?.list.length ? discovered[p]!.list : MODEL_CHOICES.filter((m) => m.provider === p);
  async function refreshModels(p: AiProvider = providerNow(), force = false): Promise<void> {
    const key = keyFor(p);
    if (!key) return;
    const d = discovered[p];
    if (!force && d && Date.now() - d.at < 24 * 3600e3) return;
    try {
      const list = await listModels(p, key);
      if (!list.length) return;
      discovered[p] = { at: Date.now(), list };
      const cfg = loadConfig();
      if ((cfg.ai.provider ?? 'claude') !== p) return;
      const pick = pickModel(list, cfg.ai.checkModel);
      if (pick && pick !== cfg.ai.checkModel) {
        log('warn', `${PROVIDER_NAME[p]} no longer offers ${cfg.ai.checkModel}; the check now uses ${pick}.`);
        cfg.ai.checkModel = pick;
        saveConfig(cfg);
      }
    } catch (e) { log('info', `Couldn't read the ${PROVIDER_NAME[p]} model list (${errMsg(e)}); using the built-in list.`); }
  }

  /** Claude's verdicts per contract, reused for 6 hours unless the price moves 5c+ (saves cost and duplicate issues). */
  const precheckCache = new Map<string, { at: number; ask: number; result: { verdict: string; reason: string } }>();

  /** The AI check executor runs on the final order, if turned on. */
  function claudePrecheck(): ((p: Proposal) => Promise<{ ok: boolean; reason?: string; verdict?: string }>) | undefined {
    const key = aiKey();
    const cfg = safeConfig();
    if (!key || cfg.ai.precheck === 'off') return undefined;
    return async (p) => {
      const calKey = p.match.prediction.posted === false ? `model:${p.match.prediction.bet}` : p.match.prediction.bet;
      const n = lastScan?.result.calibration.get(calKey)?.graded;
      const pick = `${p.match.prediction.home} v ${p.match.prediction.away} ${p.match.prediction.bet}`;
      const ck = `${p.match.market.ticker}|${p.match.side}`;
      const hit = precheckCache.get(ck);
      if (hit && Date.now() - hit.at < 6 * 3600e3 && Math.abs(hit.ask - p.quote.ask) < 0.05) {
        if (hit.result.verdict === 'block' && cfg.ai.precheck === 'veto') return { ok: false, reason: `${hit.result.reason} (${aiName()}, earlier check)` };
        return { ok: true, verdict: hit.result.verdict, reason: hit.result.reason };
      }
      let { result, error } = await precheck(cfg, key, p, { calibrationN: n });
      // The model was retired: find what's offered now and try once more.
      if (error && /\b404\b|model/i.test(error)) {
        await refreshModels(providerNow(), true);
        const fresh = safeConfig();
        if (fresh.ai.checkModel !== cfg.ai.checkModel) ({ result, error } = await precheck(fresh, key, p, { calibrationN: n }));
      }
      if (!error) precheckCache.set(ck, { at: Date.now(), ask: p.quote.ask, result });
      if (error) {
        log('warn', `${aiName()} check unavailable (${error}); ${cfg.ai.failOpen ? 'trading without it' : 'skipping the trade'}.`);
        return cfg.ai.failOpen ? { ok: true, verdict: 'unavailable', reason: error } : { ok: false, reason: `${aiName()} unavailable: ${error}` };
      }
      if (result.verdict === 'block') {
        log('warn', `${aiName()} ${cfg.ai.precheck === 'veto' ? 'blocked' : 'would block'} ${pick}: ${result.reason}`);
        return cfg.ai.precheck === 'veto' ? { ok: false, reason: result.reason, verdict: 'block' } : { ok: true, verdict: 'block (advice only)', reason: result.reason };
      }
      log('info', `${aiName()} check ${result.verdict === 'ok' ? 'OK' : 'caution'}: ${pick}${result.verdict === 'caution' ? ` (${result.reason})` : ''}`);
      return { ok: true, verdict: result.verdict, reason: result.reason };
    };
  }

  const CHAT_SYSTEM = [
    'You are the analysis assistant built into Soccer Edge, an open-source app that trades Kalshi soccer markets using picks from the PredyGo engine. The user owns this install and is asking about their own data.',
    'You get a JSON snapshot of the app: settings and every rule in "Rules in force" (switch on/off and values), the profit scorecard, trades (open and settled, with results and P/L), balance history, the current pre-game and live picks with why each was or was not bought, waiting orders, recent activity log lines, and the latest diagnostics report if one was run.',
    'Answer from that data: be specific, quote numbers, and say how big the sample is (with under ~30 settled trades in a group, results are mostly noise). If the data does not contain the answer, say so and say what would (for example: run Diagnostics, or Export data).',
    'When suggesting a change, name the exact rule or setting as the app shows it (e.g. "Rules in force > Never pay more than: 96 -> 92") and why. You cannot change anything or place trades yourself: the user decides and makes changes.',
    'Keep answers short and plain: a few sentences or a short list. No code unless asked.',
  ].join('\n');

  /** A compact, key-free snapshot of what the window shows, for the chat. */
  async function chatContext(): Promise<string> {
    const st: any = await stateView();
    const prim = (o: any) => Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v == null || ['string', 'number', 'boolean'].includes(typeof v)));
    const trades = st.trades?.all ?? st.trades?.rows ?? [];
    const snap = {
      app: { version: st.version, now: new Date().toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, account: session?.creds.env === 'prod' ? 'Kalshi LIVE (real money)' : 'Kalshi demo', cash: st.cash, positionsValue: st.positions, region: st.regionLabel, predygoTier: st.tier, killSwitch: st.killSwitch },
      switches: { autoTrade: st.auto?.on, autoTradeEveryMin: st.auto?.intervalMin, preGame: st.trading?.pregame, live: st.trading?.live, highRiskPicks: st.risk?.tradeHighRisk },
      settings: { risk: st.risk, live: st.live && prim(st.live), calibration: st.calibrationMode, minStatedPct: st.minStatedPct, aiCheck: st.ai?.settings && { provider: st.ai.provider, enabled: st.ai.settings.enabled, precheck: st.ai.settings.precheck, model: st.ai.settings.checkModel, dailyBudgetUsd: st.ai.settings.dailyBudgetUsd, spentToday: st.ai.spentToday } },
      rulesInForce: (st.rules ?? []).map((r: any) => ({ stage: r.stage, rule: r.name, on: r.on, status: r.status, value: r.value, ...(r.fields?.length ? { values: Object.fromEntries(r.fields.map((f: any) => [f.label, `${f.value}${f.unit ? ' ' + f.unit : ''}`])) } : {}) })),
      scorecard: st.scorecard,
      trades: { total: trades.length, totals: st.trades?.totals, newestFirst: trades.slice(0, 200).map(prim) },
      balanceHistory: st.balanceHistory,
      preGamePicks: st.scan && { at: st.scan.at, upcoming: st.scan.upcoming, onKalshi: st.scan.matched, skippedByReason: st.scan.unmatched, rows: (st.scan.rows ?? []).slice(0, 60).map(prim) },
      livePicks: st.live && { mode: st.live.mode, picks: (st.live.rows ?? st.live.picks ?? []).slice(0, 40).map(prim) },
      waitingOrders: st.waiting, paused: st.paused,
      activityLog: (st.log ?? []).slice(-120).map((l: any) => `${l.at} ${l.level}: ${l.msg}`),
      diagnostics: st.diagnostics?.text ? String(st.diagnostics.text).slice(0, 30_000) : 'not run yet (the user can press Diagnostics)',
    };
    let text = JSON.stringify(snap);
    if (text.length > 180_000) { snap.trades.newestFirst = snap.trades.newestFirst.slice(0, 80); snap.activityLog = snap.activityLog.slice(-50); text = JSON.stringify(snap).slice(0, 180_000); }
    // Belt and braces: nothing that looks like a key or token leaves in the snapshot.
    return text.replace(/sk-(ant-)?[\w-]{16,}/g, '[key]').replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, '[private key]');
  }

  function aiView() {
    const cfg = safeConfig();
    return {
      provider: providerNow(),
      name: aiName(),
      hasKey: !!keyFor(providerNow()),
      keys: { claude: !!session?.secrets.anthropicKey, chatgpt: !!session?.secrets.openaiKey },
      settings: cfg.ai,
      models: modelsFor(providerNow()),
      modelsFrom: discovered[providerNow()]?.list.length ? 'provider' : 'built-in',
      spentToday: spentTodayUsd(),
      spentBy: spentTodayByPurpose(),
    };
  }

  async function doExecute(proposals: Proposal[], mode: 'approve' | 'auto', force = false) {
    if (!session) throw new Error('Locked.');
    const s = session;
    const cfg = cfgFor(s);
    cfg.mode = mode;
    const summary = await execute(cfg, s.creds, proposals, {
      log: (m) => log(m.startsWith('filled') ? 'trade' : 'info', m),
      confirm: async () => true, // a click on "Place" (or auto mode being on) is the approval
      force,
      precheck: claudePrecheck(),
    });
    if (summary.stoppedReason) log('warn', `Stopped: ${summary.stoppedReason}`);
    if (summary.placed === 0 && !summary.stoppedReason) log('info', 'No order sent.');
    try { const b = await getBalance(s.creds); s.cashCents = b.cashCents; s.positionsCents = b.portfolioValueCents; } catch {}
    try { s.held = await getPositions(s.creds); } catch {}
    return summary;
  }

  // One scheduler: every scan interval it rescans so the table's prices stay fresh;
  // when auto-trade is on it also places what passes. Runs only while unlocked and the
  // window is open (the app exits when the window closes).
  const intervalMin = () => safeConfig().scanIntervalMin;

  // Optional (Settings: "Keep auto-trade on after a restart"): a Windows update or crash used
  // to switch auto-trade off silently, and picks published after that went untraded.
  const autoStatePath = () => join(appHome(), 'auto-trade.json');
  function rememberAuto(on: boolean) {
    try { ensureHome(); writeFileSync(autoStatePath(), JSON.stringify({ on, at: new Date().toISOString() })); } catch {}
  }
  function resumeAutoIfOn() {
    if (!safeConfig().resumeAuto && !background) return;
    let was = false;
    try { was = existsSync(autoStatePath()) && JSON.parse(readFileSync(autoStatePath(), 'utf8')).on === true; } catch {}
    if (!was) return;
    if (killSwitchActive()) { log('warn', 'Auto-trading was on when the app closed, but the kill switch is on, so it stays off.'); rememberAuto(false); return; }
    auto.on = true;
    log('warn', `Auto-trading resumed (it was on when the app closed): scanning every ${intervalMin()} minutes.`);
  }

  function stopAuto() {
    auto.on = false;
    rememberAuto(false);
  }

  function stopScheduler() {
    if (auto.timer) clearTimeout(auto.timer);
    auto = { on: false, nextAt: null, timer: null };
  }

  // ------------------------------------------------------------ real-time Kalshi data (Pro view)

  function stopStream() {
    stream?.stop();
    stream = null;
  }

  async function startStream() {
    if (!session || stream || !safeConfig().pro?.realtime) return;
    const s = session;
    stream = new KalshiStream(s.creds, {
      url: process.env.SOCCER_EDGE_WS_URL,
      log: (m) => log('warn', m),
      onFill: (f) => {
        log('trade', `Kalshi fill: ${f.count} × ${f.side.toUpperCase()} ${f.ticker} @ ${Math.round(f.price * 100)}¢${f.fee ? ` (fee $${f.fee.toFixed(2)})` : ''}`);
        getBalance(s.creds).then((b) => { s.cashCents = b.cashCents; s.positionsCents = b.portfolioValueCents; tracker.recordBalance(b.cashCents / 100, b.portfolioValueCents / 100); }).catch(() => {});
      },
    });
    stream.start();
    try { stream.seedPositions(await getPositionsDetail(s.creds)); } catch {}
    updateStreamMarkets();
  }

  /** Stream prices for what we hold, what's in the picks table and recent live picks. */
  function updateStreamMarkets() {
    if (!stream || !session) return;
    const t = new Set<string>([...stream.positions.keys(), ...(session.held?.keys() ?? [])]);
    for (const p of lastScan?.result.proposals ?? []) t.add(p.match.market.ticker);
    for (const o of liveEngine.observations.slice(0, 20)) if (o.ticker) t.add(o.ticker);
    stream.setMarkets(t);
    for (const ticker of stream.positions.keys()) {
      if (marketTitles.has(ticker)) continue;
      marketTitles.set(ticker, ticker);
      getMarket(session.creds, ticker).then((m) => marketTitles.set(ticker, `${(m as any).title ?? ''}${m.yes_sub_title ? ` · ${m.yes_sub_title}` : ''}`.trim() || ticker)).catch(() => marketTitles.delete(ticker));
    }
  }

  function proView() {
    const on = !!safeConfig().pro?.realtime;
    if (!on || !stream) return { on, status: on ? 'connecting' : 'off', error: null, positions: [], fills: [], totals: null };
    updateStreamMarkets();
    // Stream down or still connecting: show positions from Kalshi's REST API (every 20s).
    if (stream.status !== 'live' && session && Date.now() - restPositions.at > 20_000) {
      restPositions.at = Date.now();
      getPositionsDetail(session.creds).then((rows) => { restPositions = { at: Date.now(), rows }; stream?.seedPositions(rows); }).catch(() => {});
    }
    // Prices not streamed yet: fill from Kalshi's REST API (refreshed every 60s).
    for (const t of stream.positions.keys()) {
      if (stream.tickers.has(t)) continue;
      const q = tracker.quote(t);
      if (q) { stream.seedTicker(t, q); if (!marketTitles.has(t) || marketTitles.get(t) === t) marketTitles.set(t, q.title); }
    }
    const rows = [...stream.positions.values()].map((p) => {
      const tk = stream!.tickers.get(p.ticker);
      const yes = p.position > 0;
      const qty = Math.abs(p.position);
      // Value at what you could sell for now: YES at the bid, NO at 1 - YES ask. A decided game
      // is valued at its result, and an emptied book (game over, result not posted) at the last trade.
      const q = tracker.quote(p.ticker);
      const side = yes ? 'yes' : 'no';
      const emptyBook = !!tk && !(tk.bid > 0) && !(tk.ask < 1);
      const closed = !!q && /closed|determined|settled|finalized/i.test(q.status);
      const last = Number.isFinite(tk?.last) ? tk!.last : q && Number.isFinite(q.last) ? q.last : NaN;
      const mark = q?.result === 'yes' || q?.result === 'no' ? (q.result === side ? 1 : 0)
        : (emptyBook || closed) && Number.isFinite(last) && last > 0 ? (yes ? last : 1 - last)
        : tk ? (yes ? tk.bid : 1 - tk.ask) : NaN;
      const decided = q?.result === 'yes' || q?.result === 'no' ? (q.result === side ? 'won' : 'lost') : (emptyBook || closed) ? 'game over' : null;
      const value = Number.isFinite(mark) ? qty * mark : NaN;
      const tape = stream!.tape.get(p.ticker) ?? [];
      return {
        ticker: p.ticker,
        title: marketTitles.get(p.ticker) ?? p.ticker,
        side: yes ? 'yes' : 'no',
        contracts: qty,
        cost: p.cost,
        avg: qty ? p.cost / qty : NaN,
        bid: tk?.bid ?? null, ask: tk?.ask ?? null, last: tk?.last ?? null,
        volume: tk?.volume ?? null,
        value: Number.isFinite(value) ? +value.toFixed(2) : null,
        pnl: Number.isFinite(value) && Number.isFinite(p.cost) ? +(value - p.cost).toFixed(2) : null,
        realized: Number.isFinite(p.realized) ? p.realized : null,
        updatedAgoSec: tk ? Math.round((Date.now() - tk.ts) / 1000) : null,
        tape: tape.slice(0, 5),
        decided,
      };
    }).sort((a, b) => (b.cost || 0) - (a.cost || 0));
    const sum = (k: 'cost' | 'value' | 'pnl') => +rows.reduce((a, r) => a + (Number(r[k]) || 0), 0).toFixed(2);
    return {
      on, status: stream.status, error: stream.lastError,
      ageSec: stream.lastMessageAt ? Math.round((Date.now() - stream.lastMessageAt) / 1000) : null,
      positions: rows,
      fills: stream.fills.slice(0, 10),
      totals: { cost: sum('cost'), value: sum('value'), pnl: sum('pnl') },
    };
  }

  /** Live best price for the side we'd buy, when the stream has it. */
  function liveQuote(ticker: string, side: 'yes' | 'no'): { ask: number; bid: number; ageSec: number } | null {
    const tk = stream?.tickers.get(ticker);
    if (!tk || !Number.isFinite(tk.ask) || !Number.isFinite(tk.bid)) return null;
    return side === 'yes'
      ? { ask: tk.ask, bid: tk.bid, ageSec: Math.round((Date.now() - tk.ts) / 1000) }
      : { ask: +(1 - tk.bid).toFixed(4), bid: +(1 - tk.ask).toFixed(4), ageSec: Math.round((Date.now() - tk.ts) / 1000) };
  }

  // ------------------------------------------------------------ live picks (seconds, not minutes)

  function stopLive() {
    if (liveTimer) clearTimeout(liveTimer);
    liveTimer = null;
    liveEngine.reset();
  }

  function scheduleLive(delayMs: number) {
    if (liveTimer) clearTimeout(liveTimer);
    liveTimer = null;
    if (!session || safeConfig().live.mode === 'off') return;
    liveTimer = setTimeout(liveTickSafe, delayMs);
  }

  /** What the live engine needs to price and (when allowed) buy a live pick. */
  async function liveContext(s: Session, cfg: AppConfig): Promise<LiveContext> {
    const elig = checkRegion(cfg, await loadEligibility(cfg.eligibilityUrl));
    return {
      cfg,
      creds: s.creds,
      bankroll: s.cashCents / 100,
      dailyRemaining: dailyLeft(cfg.risk, spentToday(s.creds.env)),
      alreadyIn: (p) => {
        if (!ruleOn(cfg.risk, 'noDouble')) return null;
        const a = alreadyIn(p);
        return a === 'traded' ? 'already bought this market' : a === 'holding' ? 'already hold this market' : null;
      },
      tradingBlocked: () => (killSwitchActive() ? 'kill switch is on' : elig.ok ? null : elig.reason),
      execute: async (p, deadlineMs) => {
        const c = cfgFor(s);
        c.mode = 'auto';
        const sum = await execute(c, s.creds, [p], {
          log: (m) => log(m.startsWith('filled') ? 'trade' : 'info', m),
          confirm: async () => true, // live trading on (or the Buy click) is the approval
          live: { deadlineMs },
          regionChecked: true,
          precheck: claudePrecheck(),
        });
        try { const b = await getBalance(s.creds); s.cashCents = b.cashCents; s.positionsCents = b.portfolioValueCents; } catch {}
        try { s.held = await getPositions(s.creds); } catch {}
        return sum;
      },
      log,
    };
  }

  async function liveTick() {
    liveTimer = null;
    if (!session) return;
    const s = session;
    const cfg = cfgFor(s);
    if (cfg.live.mode === 'off') return;
    if (!livePolling) {
      livePolling = true;
      try {
        await withTimeout(liveEngine.poll(await liveContext(s, cfg)), CYCLE_LIMIT_MS, () => `live check stuck for ${CYCLE_LIMIT_MS / 60_000} min`);
      } catch (e) {
        log('error', `Live check failed: ${errMsg(e)}`);
      } finally {
        livePolling = false;
      }
    }
    updateStreamMarkets();
    if (session === s) scheduleLive(safeConfig().live.pollSec * 1000);
  }

  function schedule(delayMs: number) {
    if (auto.timer) clearTimeout(auto.timer);
    auto.nextAt = new Date(Date.now() + delayMs).toISOString();
    auto.timer = setTimeout(tickSafe, delayMs);
  }

  /** Scan, and when auto-trading is on, place everything that passes. */
  /** Waiting orders: record fills; take them off the book when their time is up or the pick changed. */
  async function syncWaiting(r: ScanResult | null, trading: boolean, extra?: KeepCheck) {
    if (!session) return;
    const keep: KeepCheck = (o) => {
      const x = extra?.(o);
      if (x) return x;
      if (!r || o.by === 'claude') return null; // Claude's own orders are Claude's to manage (expiry still applies)
      const p = r.proposals.find((q) => q.match.market.ticker === o.ticker);
      if (!p) return 'the pick is no longer in the PredyGo feed';
      // Sizing (cash, minimum win) isn't a reason to pull an order that's already working.
      if (p.skip && /stake too small|would win only|daily spend cap|open bets already/.test(p.skip)) return null;
      if (p.rest) {
        if (p.rest.maxPay < o.limitPrice - 0.005) return `now worth only ${Math.round(p.rest.maxPay * 100)}¢`;
        // Moving up / switching to the ask needs auto-trade to place the new order.
        if (trading && p.rest.price > o.limitPrice + 0.005 && !(o.filled ?? 0)) return `outbid at ${Math.round(p.rest.bidNow * 100)}¢; re-placing at ${Math.round(p.rest.price * 100)}¢`;
        return null;
      }
      if (!p.skip && p.contracts > 0) return trading && !(o.filled ?? 0) ? 'the ask is now worth taking' : null;
      if (p.skip && /^kickoff in /.test(p.skip)) return null; // the order's own expiry handles the cutoff
      return p.skip && !priceSkip(p.skip) ? p.skip : `no longer worth ${Math.round(o.limitPrice * 100)}¢`;
    };
    try {
      const res = await syncResting(safeConfig(), session.creds, { log: (lv, m) => log(lv, m), keep });
      if (res.newlyFilled > 0) { try { const b = await getBalance(session.creds); session.cashCents = b.cashCents; session.positionsCents = b.portfolioValueCents; } catch {} }
    } catch (e) { log('warn', `Waiting orders check failed: ${errMsg(e)}`); }
  }

  async function scanAndTrade(trading: boolean) {
    cycleStep = 'loading PredyGo picks and Kalshi prices';
    const r = await doScan();
    cycleStep = 'checking waiting orders';
    const pre = pregameOn(safeConfig());
    // Pre-game switch off: waiting (pre-game) orders come off the book too.
    await syncWaiting(r, trading, pre ? undefined : () => 'pre-game trading is off');
    cycleStep = 'placing orders';
    if (!trading) return;
    const noDouble = ruleOn(safeConfig().risk, 'noDouble');
    const candidates = r.proposals.filter((p) => !p.skip && p.contracts > 0 && (!noDouble || !alreadyIn(p)));
    if (!candidates.length) return;
    if (!pre) {
      for (const p of candidates) autoNotes.set(p.match.prediction.id, { at: Date.now(), reason: 'pre-game trading is off (top-bar switch)' });
      return;
    }
    const started = Date.now();
    const summary = await doExecute(candidates, 'auto');
    // Order-time checks (one bet per match, open-bets cap, Claude, contracts for sale...) record
    // their reason in the ledger; show it on the pick so a ready pick never sits unexplained.
    const skips = readLedger().filter((e): e is Extract<typeof e, { type: 'skip' }> => e.type === 'skip' && Date.parse(e.at) >= started - 1000);
    for (const p of candidates) {
      const id = p.match.prediction.id;
      if (alreadyIn(p)) { autoNotes.delete(id); continue; }
      const why = skips.filter((e) => e.predictionId === id).pop()?.reason ?? summary.stoppedReason ?? 'no order sent (see Activity)';
      autoNotes.set(id, { at: Date.now(), reason: why });
    }
  }

  async function tick() {
    if (!session) return;
    refreshModels().catch(() => {}); // at most once a day
    if (busy) { schedule(30_000); return; }
    const trading = auto.on && !killSwitchActive();
    if (auto.on && !trading) { log('warn', 'Auto-trading paused: kill switch is on.'); stopAuto(); }
    try {
      cycleRunning = true;
      cycleStep = 'starting';
      await withBusy(() => withTimeout(scanAndTrade(trading), CYCLE_LIMIT_MS, () => `stuck for ${CYCLE_LIMIT_MS / 60_000} min at: ${cycleStep}`));
    } catch (e) {
      log('error', `${trading ? 'Auto-trade cycle' : 'Scheduled scan'} failed: ${errMsg(e)}`);
      syncWaiting(null, false).catch(() => {});
      if (e instanceof FeedAuthError && auto.on) { stopAuto(); log('warn', 'Auto-trading stopped.'); }
    }
    cycleRunning = false;
    if (session) schedule(intervalMin() * 60_000);
  }
  // Belt and braces: whatever happens inside a cycle, the next one is always booked.
  const tickSafe = () => tick().catch((e) => { cycleRunning = false; log('error', `Scheduled scan crashed: ${errMsg(e)}`); if (session) schedule(5 * 60_000); });
  const liveTickSafe = () => liveTick().catch((e) => { livePolling = false; log('error', `Live check crashed: ${errMsg(e)}`); if (session) scheduleLive(30_000); });

  /** Prices older than this can't be used for Place; scan again first. */
  const maxScanAgeMs = () => (intervalMin() + 2) * 60_000;

  // ------------------------------------------------------------ state for the page

  function contractLabel(p: Proposal): string {
    const pr = p.match.prediction;
    const sp = p.match.spec;
    const team = (t: 'home' | 'away') => (t === 'home' ? pr.home : pr.away);
    switch (sp.kind) {
      case 'total': return sp.side === 'yes' ? `Over ${sp.line} goals · YES` : `Under ${sp.line} goals · NO on Over`;
      case 'btts': return sp.side === 'yes' ? 'Both teams score · YES' : 'Both teams score · NO';
      case 'team_total': return `${team(sp.team)} ${sp.side === 'yes' ? 'over' : 'under'} ${sp.line} goals · ${sp.side.toUpperCase()}`;
      case 'not_win': return `${team(sp.team)} to win · NO`;
    }
  }

  /** Why this pick must not be bought again, if it mustn't: our own record first, then Kalshi's. */
  function alreadyIn(p: Proposal, env = session?.creds.env ?? 'prod'): 'traded' | 'holding' | 'waiting' | null {
    const w = restingOrders(env).find((o) => o.ticker === p.match.market.ticker);
    if (w && !(w.filled ?? 0)) return 'waiting';
    if (tradedPredictionIds(env).has(p.match.prediction.id) || tradedTickers(env).has(p.match.market.ticker)) return 'traded';
    if (session?.held?.has(p.match.market.ticker)) return 'holding';
    return null;
  }

  /** Contracts "Place anyway" may buy for a pick the checks skipped (0 = not allowed). */
  function forceMax(p: Proposal): number {
    if (!session || !p.skip || p.hard || alreadyIn(p)) return 0;
    const cfg = loadConfig();
    const dailyRemaining = dailyLeft(cfg.risk, spentToday(session.creds.env));
    return maxForcedContracts(p, cfg.risk, session.cashCents / 100, dailyRemaining);
  }

  function proposalView(p: Proposal) {
    const pr = p.match.prediction;
    const done = alreadyIn(p);
    const maxForce = forceMax(p);
    return {
      id: pr.id,
      kickoff: pr.kickoff,
      league: pr.league,
      match: `${pr.home} v ${pr.away}`,
      pick: pr.bet,
      contract: contractLabel(p),
      ticker: p.match.market.ticker,
      required: p.required ?? null,
      posted: pr.posted ?? null,
      side: p.match.side,
      probability: p.probability,
      ask: p.quote.ask,
      edge: p.edge,
      contracts: p.contracts,
      cost: +(p.contracts * p.cost).toFixed(2),
      status: done ?? p.skip ?? (p.contracts > 0 ? 'ready' : 'too small'),
      tradable: !done && !p.skip && p.contracts > 0,
      autoNote: (() => { const n = autoNotes.get(pr.id); return !done && n && Date.now() - n.at < 20 * 60_000 ? `${n.reason} (${new Date(n.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })})` : null; })(),
      maxForce,
      live: liveQuote(p.match.market.ticker, p.match.side),
      unitCost: p.cost,
      rest: p.rest ? { price: p.rest.price, maxPay: p.rest.maxPay, ask: p.rest.askNow, until: p.rest.expiresAt } : null,
      waiting: (() => { const w = restingOrders(session?.creds.env ?? 'prod').find((o) => o.ticker === p.match.market.ticker); return w ? { price: w.limitPrice, filled: w.filled ?? 0, count: w.count, until: w.expiresAt ?? null, by: w.by ?? null } : null; })(),
    };
  }

  async function stateView() {
    const cfg = loadConfig();
    const base = {
      vaultExists: vaultExists(),
      unlocked: !!session,
      autoUnlocking: autoUnlocking && !session,
      disclaimerAccepted: disclaimerAccepted(),
      background,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      states: [...US_STATES].sort(),
      countries: countryOptions(),
      unlockBlockedFor: Math.max(0, Math.ceil((unlockBlockedUntil - Date.now()) / 1000)),
    };
    if (!session) return base;
    const env = session.creds.env;
    const elig = checkRegion(cfg, await loadEligibility(cfg.eligibilityUrl));
    const unmatched: Record<string, number> = {};
    for (const r of lastScan?.result.results ?? []) if (!r.ok) unmatched[failureLabel(r)] = (unmatched[failureLabel(r)] ?? 0) + 1;
    return {
      ...base,
      env,
      cash: session.cashCents / 100,
      positions: session.positionsCents == null ? null : session.positionsCents / 100,
      predygo: session.predygo ?? null,
      usState: regionOf(cfg).state ?? null,
      country: regionOf(cfg).country ?? null,
      regionLabel: regionLabel(cfg),
      eligibility: elig.ok ? null : elig.reason,
      killSwitch: killSwitchActive(),
      auto: { on: auto.on, nextAt: auto.nextAt, intervalMin: intervalMin() },
      pro: proView(),
      ai: aiView(),
      trades: announceResults(tracker.trades(env, (t) => { const tk = stream?.tickers.get(t); return tk && Number.isFinite(tk.bid) && Number.isFinite(tk.ask) ? { bid: tk.bid, ask: tk.ask, last: tk.last } : null; })),
      balanceHistory: tracker.balanceHistory(),
      trading: { pregame: pregameOn(cfg), live: cfg.trading?.live !== false },
      live: {
        ...cfg.live,
        lastPollAt: liveEngine.lastPollAt,
        error: liveEngine.lastError,
        open: liveEngine.openCount,
        rows: liveEngine.observations.slice(0, 40),
        phases: liveStagesSummary().map((p) => ({ label: p.label, graded: p.graded, hit: p.graded ? (p.wins + 1) / (p.graded + 2) : null })),
      },
      busy,
      spentToday: spentToday(env),
      uncertain: uncertainOrders(env).length,
      risk: cfg.risk,
      minStatedPct: cfg.source.minStatedPct ?? 0,
      calibrationMode: cfg.calibration,
      defaults: {
        risk: DEFAULT_CONFIG.risk, live: DEFAULT_CONFIG.live, ai: DEFAULT_CONFIG.ai, pro: DEFAULT_CONFIG.pro, scanIntervalMin: DEFAULT_CONFIG.scanIntervalMin,
        calibration: DEFAULT_CONFIG.calibration, minStatedPct: DEFAULT_CONFIG.source.minStatedPct ?? 0, resumeAuto: false,
      },
      resumeAuto: !!cfg.resumeAuto,
      rules: rulesView(cfg, safeConfig(), killSwitchActive()),
      waiting: restingOrders(env).map((o) => ({ clientOrderId: o.clientOrderId, match: o.match ?? o.ticker, bet: o.bet ?? null, side: o.side, price: o.limitPrice, maxPay: o.maxPay ?? null, count: o.count, filled: o.filled ?? 0, until: o.expiresAt ?? null, by: o.by ?? null, at: o.at })),
      paused: (cfg.risk.paused ?? []).filter((x) => Date.parse(x.until) > Date.now()),
      scorecard: (() => { try { return scorecard(tracker.trades(env).all as any); } catch { return null; } })(),
      postedOnly: true,
      service: await serviceView(),
      tier: cfg.source?.tier ?? 'elite',
      tiersSeen: [...tiersSeen],
      feedMode: lastFeedMode,
      version: APP_VERSION,
      diagnostics: { running: diag.running, error: diag.error, report: diag.report, text: diag.text },
      scan: lastScan && {
        at: lastScan.at,
        upcoming: lastScan.result.upcoming.length,
        matched: lastScan.result.results.filter((r) => r.ok).length,
        unmatched,
        rows: lastScan.result.proposals.map((p) => proposalView(p)),
        ageSec: Math.round((Date.now() - Date.parse(lastScan.at)) / 1000),
        stale: Date.now() - Date.parse(lastScan.at) > maxScanAgeMs(),
      },
      log: logs.slice(-120).reverse(),
    };
  }

  // ------------------------------------------------------------ routing

  const tokenBuf = Buffer.from(token);
  const goodToken = (t: string | null) => {
    if (!t) return false;
    const b = Buffer.from(t);
    return b.length === tokenBuf.length && timingSafeEqual(b, tokenBuf);
  };

  const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
  const fail = (msg: string, status = 400) => json({ error: msg }, status);

  /** Open the vault and connect. Returns null when unlocked, 'wrong' for a bad password, else the problem. */
  async function unlockWith(password: string): Promise<string | null> {
    let secrets: Secrets;
    try {
      secrets = await loadVault(password);
    } catch (e) {
      return e instanceof WrongPasswordError ? 'wrong' : errMsg(e);
    }
    const cfg = loadConfig();
    try {
      const conn = await connectKalshi(secrets.kalshiKeyId, secrets.kalshiPrivateKeyPem, cfg.kalshi.env);
      session = { secrets, creds: conn.creds, cashCents: conn.cashCents };
      try { const n = backfillJournal(readLedger(), readJsonl(picksLogPath()), readJsonl(liveLogPath())); if (n) log('info', `Trade journal: rebuilt ${n} earlier trade(s) from the logs.`); } catch {}
    } catch (e) {
      return `Unlocked, but Kalshi refused the saved key: ${errMsg(e)}`;
    }
    refreshModels().catch(() => {});
    try { session.predygo = await checkPredygoKey(secrets.predygoKey); clampTier(); }
    catch (e) { log('warn', `PredyGo: ${errMsg(e)}`); }
    log('info', `Unlocked. Connected to Kalshi ${session.creds.env === 'prod' ? 'LIVE' : 'demo'}.`);
    resumeAutoIfOn();
    schedule(1500);
    scheduleLive(3000);
    startStream().catch(() => {});
    return null;
  }

  /** Background mode after a reboot: unlock with the password Windows keeps for this PC. Retries while the network comes up. */
  async function autoUnlockLoop() {
    for (let warned = false; !disclaimerAccepted() && background; warned = true) {
      if (!warned) log('warn', 'Background mode: waiting for the disclaimer to be accepted in the Soccer Edge window before trading.');
      await Bun.sleep(30_000);
    }
    autoUnlocking = true;
    try { await autoUnlockTries(); } finally { autoUnlocking = false; }
  }
  /** Background mode is unlocking by itself (the window says so instead of asking for the password). */
  let autoUnlocking = false;
  async function autoUnlockTries() {
    for (let attempt = 1; !session && background; attempt++) {
      const pw = await loadAutoUnlock();
      if (!pw) { log('warn', 'Background mode: no saved unlock on this PC, so nothing trades until you open Soccer Edge and unlock.'); return; }
      const r = await unlockWith(pw);
      if (!r) { log('info', 'Background mode: unlocked automatically after startup.'); return; }
      if (r === 'wrong') { log('error', 'Background mode: the saved unlock no longer matches your password. Turn background mode off and on again in Settings.'); return; }
      if (attempt === 1 || attempt % 10 === 0) log('warn', `Background mode: couldn't unlock yet (${r}); trying again every minute.`);
      await Bun.sleep(60_000);
    }
  }

  const disclaimerAccepted = (): boolean => { try { return (loadConfig().disclaimer?.version ?? 0) >= DISCLAIMER_VERSION; } catch { return false; } };

  /** Apply an imported settings file: save, log what changed, restart the live loop if needed. */
  function applyImport(cfg: AppConfig, r: ImportResult, from: string) {
    saveConfig(cfg);
    const auto = r.changed.filter((c) => AUTOMATION_KEYS.includes(c.key) && (c.to === true || c.to === 'trade'));
    log(r.changed.length ? 'warn' : 'info', `Settings imported from ${from}: ${r.changed.length} changed${r.ignored.length ? `, ${r.ignored.length} ignored (${r.ignored.slice(0, 4).map((i) => `${i.key}: ${i.why}`).join('; ')}${r.ignored.length > 4 ? '; ...' : ''})` : ''}.`);
    if (auto.length) log('warn', `The imported settings turn on automation: ${auto.map((c) => c.key).join(', ')}. Check them in Settings.`);
    if (session) scheduleLive(500);
  }

  /** What Settings shows about background mode. */
  async function serviceView() {
    const supported = serviceSupported();
    return { supported, installed: supported ? await taskInstalled() : false, background, autoUnlock: autoUnlockSaved(), user: supported ? windowsUser() : null };
  }

  async function handleApi(path: string, body: any): Promise<Response> {
    switch (path) {
      case '/api/state':
        return json(await stateView());

      case '/api/quit':
        log('info', 'Quitting.');
        setTimeout(() => shutdown('quit'), 300);
        return json({ ok: true });

      case '/api/open':
        if (!background) openWindowHere();
        return json({ ok: true, background });

      case '/api/disclaimer/accept': {
        const acks = Array.isArray(body.acks) ? body.acks : [];
        if (acks.length !== DISCLAIMER_ACKS.length || !acks.every((a: unknown) => a === true)) return fail('Tick both boxes to accept the disclaimer.');
        const cfg = loadConfig();
        cfg.disclaimer = { version: DISCLAIMER_VERSION, at: new Date().toISOString() };
        saveConfig(cfg);
        log('info', `Disclaimer accepted (version ${DISCLAIMER_VERSION}).`);
        return json({ ok: true });
      }

      case '/api/heartbeat':
        lastBeat = Date.now();
        return json({ ok: true });

      case '/api/create': {
        if (!disclaimerAccepted()) return fail('Accept the disclaimer first.');
        if (vaultExists()) return fail('Credentials are already saved. Unlock them, or use "Forgot password" to start over.');
        const password = String(body.password ?? '');
        if (password.length < MIN_PASSWORD_LENGTH) return fail(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
        if (!samePassword(password, String(body.confirm ?? ''))) return fail('The two passwords do not match.');
        const country = String(body.country ?? 'US').toUpperCase();
        const usState = country === 'US' ? String(body.usState ?? '').toUpperCase() : undefined;
        if (country === 'US' && !US_STATES.has(usState!)) return fail('Choose the US state you trade from.');
        const regionCheck = checkRegion({ country, state: usState }, await loadEligibility(loadConfig().eligibilityUrl));
        if (!regionCheck.ok) return fail(regionCheck.reason);
        let keyId: string, pem: string;
        try { keyId = normalizeKeyId(String(body.kalshiKeyId ?? '')); pem = normalizePrivateKey(String(body.kalshiPrivateKey ?? '')); }
        catch (e) { return fail(errMsg(e)); }
        const predygoKey = String(body.predygoKey ?? '').trim();
        if (!predygoKey) return fail('Paste your PredyGo API key.');
        let predygo: PredygoAccount;
        try { predygo = await checkPredygoKey(predygoKey); }
        catch (e) { return fail(e instanceof FeedAuthError ? `${e.message} Check the key in your PredyGo account.` : `Could not reach PredyGo: ${errMsg(e)}`); }
        let conn;
        try { conn = await connectKalshi(keyId, pem); } catch (e) { return fail(errMsg(e)); }
        const secrets: Secrets = { predygoKey, kalshiKeyId: keyId, kalshiPrivateKeyPem: pem };
        await saveVault(secrets, password);
        const cfg = loadConfig();
        cfg.country = country;
        cfg.state = usState;
        cfg.kalshi.env = conn.creds.env;
        cfg.source = { type: 'predygo', url: PREDYGO_API, minStatedPct: cfg.source.minStatedPct, includeAll: false, tier: cfg.source.tier };
        saveConfig(cfg);
        try { const n = backfillJournal(readLedger(), readJsonl(picksLogPath()), readJsonl(liveLogPath())); if (n) log('info', `Trade journal: rebuilt ${n} earlier trade(s) from the logs.`); } catch {}
        session = { secrets, creds: conn.creds, cashCents: conn.cashCents, predygo };
        clampTier();
        log('info', `Saved and connected to Kalshi ${conn.creds.env === 'prod' ? 'LIVE' : 'demo'}.`);
        schedule(1500);
        scheduleLive(3000);
        startStream().catch(() => {});
        return json({ ok: true });
      }

      case '/api/unlock': {
        if (!disclaimerAccepted()) return fail('Accept the disclaimer first.');
        if (!vaultExists()) return fail('Nothing saved yet.');
        if (Date.now() < unlockBlockedUntil) return fail(`Too many attempts. Wait ${Math.ceil((unlockBlockedUntil - Date.now()) / 1000)} seconds.`, 429);
        const r = await unlockWith(String(body.password ?? ''));
        if (r === 'wrong') {
          failedUnlocks++;
          if (failedUnlocks >= 5) unlockBlockedUntil = Date.now() + Math.min(60_000 * 2 ** (failedUnlocks - 5), 30 * 60_000);
          return fail('Wrong password.', 401);
        }
        if (r) return fail(r);
        failedUnlocks = 0;
        return json({ ok: true });
      }

      case '/api/forget': {
        if (String(body.confirm ?? '') !== 'DELETE') return fail('Type DELETE to confirm.');
        lock();
        deleteVault();
        rememberAuto(false);
        log('warn', 'Saved credentials deleted.');
        return json({ ok: true });
      }
    }

    // Everything below needs an unlocked session.
    if (!session) return fail('Locked.', 401);

    switch (path) {
      case '/api/lock':
        lock();
        return json({ ok: true });

      case '/api/service/install': {
        if (!serviceSupported()) return fail('Background mode needs the Windows app.');
        const appPassword = String(body.appPassword ?? ''), winPassword = String(body.winPassword ?? '');
        if (!winPassword) return fail(`Enter the Windows password for ${windowsUser()}.`);
        try { await saveAutoUnlock(appPassword); }
        catch (e) { return fail(e instanceof WrongPasswordError ? 'That is not your Soccer Edge password.' : errMsg(e)); }
        try { await installTask(winPassword, APP_VERSION); }
        catch (e) { clearAutoUnlock(); return fail(errMsg(e)); }
        log('warn', `Background mode ON: Soccer Edge starts with Windows (as ${windowsUser()}), unlocks itself, and keeps trading with the window closed.`);
        if (background) return json({ ok: true });
        // Hand over to the background copy: stop our own scanning, start the task, and send this
        // window to it. If it doesn't come up, carry on here.
        const wasAuto = auto.on;
        rememberAuto(wasAuto);
        stopScheduler();
        if (liveTimer) { clearTimeout(liveTimer); liveTimer = null; }
        const started = await runTask();
        const inst = started ? await waitForInstance((i) => i.pid !== process.pid && i.background === true, 45_000) : null;
        if (!inst) {
          auto.on = wasAuto;
          schedule(1500);
          scheduleLive(3000);
          return fail('Background mode is set up, but it did not start yet. This window keeps trading for now; it will take over at the next restart (or open Soccer Edge again).');
        }
        lock();
        setTimeout(() => shutdown('switched to background mode'), 1500);
        return json({ ok: true, url: `http://127.0.0.1:${inst.port}/?t=${inst.token}` });
      }

      case '/api/service/uninstall': {
        try { await deleteTask(); } catch (e) { return fail(errMsg(e)); }
        clearAutoUnlock();
        if (background) {
          background = false;
          writeInstanceFile(server.port!, token, false);
          lastBeat = Date.now();
        }
        log('warn', 'Background mode OFF: Soccer Edge runs only while its window is open again.');
        return json({ ok: true });
      }

      case '/api/pro': {
        const cfg = loadConfig();
        cfg.pro = { ...(cfg.pro ?? { realtime: true }), realtime: !!body.on, chosen: true };
        saveConfig(cfg);
        if (cfg.pro.realtime) { log('info', 'Real-time Kalshi data ON: live prices, positions, P/L and fills.'); await startStream(); }
        else { stopStream(); log('info', 'Real-time Kalshi data OFF.'); }
        return json({ ok: true });
      }

      case '/api/ai/key': {
        // Save (or remove, with a blank key) the API key for Claude or ChatGPT. Saving a key
        // also makes that the assistant in use: only one is used at a time.
        if (!session) return fail('Locked.');
        const provider: AiProvider = body.provider === 'chatgpt' ? 'chatgpt' : body.provider === 'claude' ? 'claude' : providerNow();
        const name = PROVIDER_NAME[provider];
        const key = String(body.key ?? '').trim();
        const password = String(body.password ?? '');
        if (key) { const bad = keyLooksRight(provider, key); if (bad) return fail(bad); }
        let saved: Secrets;
        try { saved = await loadVault(password); } catch (e) { return fail(e instanceof WrongPasswordError ? 'Wrong app password.' : errMsg(e)); }
        const cfg0 = loadConfig();
        let model = providerOf(cfg0.ai.checkModel) === provider ? cfg0.ai.checkModel : DEFAULT_MODEL[provider];
        if (key) {
          // Use a model this key can actually use (falls back to the built-in default).
          try { const list = await listModels(provider, key); if (list.length) { discovered[provider] = { at: Date.now(), list }; model = pickModel(list, model) ?? model; } } catch {}
        }
        if (key) {
          // One tiny call to confirm the key works (costs a fraction of a cent).
          try {
            await callAI<{ ok: boolean }>({ apiKey: key, model, system: 'Reply with ok=true.', user: 'ping', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }, maxTokens: 300, timeoutMs: 30_000, purpose: 'key-check' });
          } catch (e) { return fail(`${name} didn't accept the key: ${errMsg(e)}`); }
        }
        const next: Secrets = provider === 'chatgpt' ? { ...saved, openaiKey: key || undefined } : { ...saved, anthropicKey: key || undefined };
        await saveVault(next, password);
        session.secrets.anthropicKey = next.anthropicKey;
        session.secrets.openaiKey = next.openaiKey;
        if (key) { cfg0.ai.provider = provider; cfg0.ai.checkModel = model; saveConfig(cfg0); }
        log('info', key ? `${provider === 'chatgpt' ? 'OpenAI' : 'Anthropic'} API key saved (encrypted). ${name} is the assistant in use.` : `${provider === 'chatgpt' ? 'OpenAI' : 'Anthropic'} API key removed.`);
        return json({ ok: true });
      }

      case '/api/ai/chat': {
        // "Ask the AI": a read-only question about this app's own data. No tools: it can't
        // change settings or trade; it answers from a snapshot of what the window shows.
        const key = aiKey();
        if (!key) return fail(`Add an API key and switch on "Use ${aiName()}" first.`);
        const turns = (Array.isArray(body.messages) ? body.messages : [])
          .filter((m: any) => (m?.role === 'user' || m?.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
          .slice(-12).map((m: any) => ({ role: m.role as 'user' | 'assistant', content: String(m.content).slice(0, 4000) }));
        if (!turns.length || turns[turns.length - 1]!.role !== 'user') return fail('Type a question.');
        const cfg = safeConfig();
        const ctx = await chatContext();
        try {
          const r = await chatAI({
            apiKey: key, model: cfg.ai.checkModel, maxTokens: 2500, timeoutMs: 120_000, budgetUsd: cfg.ai.dailyBudgetUsd,
            system: CHAT_SYSTEM + '\n\nTHE APP DATA (JSON snapshot taken just now):\n' + ctx,
            messages: turns,
          });
          return json({ ok: true, reply: r.text, cost: +r.costUsd.toFixed(4), model: r.model, contextChars: ctx.length });
        } catch (e) { return fail(errMsg(e)); }
      }

      case '/api/ai/settings': {
        const cfg = loadConfig();
        const a = { ...cfg.ai };
        if (body.enabled !== undefined) a.enabled = !!body.enabled;
        if (['off', 'advise', 'veto'].includes(body.precheck)) a.precheck = body.precheck;
        if (body.failOpen !== undefined) a.failOpen = !!body.failOpen;
        if (body.dailyBudgetUsd !== undefined) { const b = Number(body.dailyBudgetUsd); if (!(b >= 0.05 && b <= 50)) return fail('Daily AI budget must be $0.05-$50.'); a.dailyBudgetUsd = b; }
        if (body.provider !== undefined) {
          // Switch assistant (one at a time), with its cheap model unless one of its models is given.
          if (body.provider !== 'claude' && body.provider !== 'chatgpt') return fail('Choose Claude or ChatGPT.');
          const prov: AiProvider = body.provider;
          if (prov !== a.provider) { a.provider = prov; if (providerOf(a.checkModel) !== prov) a.checkModel = pickModel(modelsFor(prov), DEFAULT_MODEL[prov]) ?? DEFAULT_MODEL[prov]; }
        }
        const prov: AiProvider = a.provider === 'chatgpt' ? 'chatgpt' : 'claude';
        if (body.checkModel !== undefined && providerOf(String(body.checkModel)) === prov) {
          if (!modelsFor(prov).some((m) => m.id === body.checkModel)) return fail(`${PROVIDER_NAME[prov]} doesn't offer ${body.checkModel} to your key.`);
          a.checkModel = body.checkModel;
        }
        cfg.ai = a;
        saveConfig(cfg);
        log('info', `${PROVIDER_NAME[a.provider ?? 'claude']} assistant settings saved.`);
        if (body.provider !== undefined) refreshModels(prov).catch(() => {});
        return json({ ok: true });
      }

      case '/api/journal': {
        const t = String(body.ticker ?? '');
        const rows = journalRows().filter((r) => (r.entry as any).kalshi?.ticker === t);
        return json({ ok: true, rows });
      }

      case '/api/waiting/cancel': {
        const id = String(body.clientOrderId ?? '');
        if (!restingOrders(session.creds.env).some((o) => o.clientOrderId === id)) return fail('That order is no longer waiting.');
        await syncWaiting(null, false, (o) => (o.clientOrderId === id ? 'cancelled by you' : null));
        return json({ ok: true });
      }

      case '/api/pause/remove': {
        const c = loadConfig();
        const before = (c.risk.paused ?? []).length;
        c.risk.paused = (c.risk.paused ?? []).filter((x) => !(x.kind === body.kind && x.value === body.value));
        if (c.risk.paused.length === before) return fail('No such pause.');
        saveConfig(c);
        log('info', `Pause removed: ${body.value}.`);
        return json({ ok: true });
      }

      case '/api/chart': {
        const ticker = String(body.ticker ?? '');
        if (!/^[A-Z0-9.\-]+$/.test(ticker)) return fail('Bad ticker.');
        const side = body.side === 'no' ? 'no' : 'yes';
        const from = Number(body.from) || Date.now() - 86400e3;
        const pts = await priceHistory(ticker, side, from - 2 * 3600e3);
        const tk = stream?.tickers.get(ticker);
        if (tk && Number.isFinite(tk.bid) && Number.isFinite(tk.ask)) pts.push({ t: Date.now(), v: +(side === 'yes' ? tk.bid : 1 - tk.ask).toFixed(4) });
        return json({ ok: true, points: pts });
      }

      case '/api/openurl': {
        // Open Kalshi (or Kalshi Pro) in the normal browser, where you're signed in.
        const u = String(body.url ?? '');
        if (!/^https:\/\/(pro\.)?kalshi\.com(\/[\w\-./?=&#%]*)?$/.test(u)) return fail('Only Kalshi links can be opened.');
        if (process.platform === 'win32') { try { spawn('explorer.exe', [u], { detached: true, stdio: 'ignore' }).unref(); } catch {} }
        else if (process.platform === 'darwin') { try { spawn('open', [u], { detached: true, stdio: 'ignore' }).unref(); } catch {} }
        return json({ ok: true });
      }

      case '/api/scan':
        // With auto-trading on, "Scan now" also places what passes (it used to only
        // refresh prices and push the next auto run back).
        await withBusy(() => scanAndTrade(auto.on && !killSwitchActive()));
        schedule(intervalMin() * 60_000);
        return json({ ok: true });

      case '/api/place': {
        const p = lastScan?.result.proposals.find((x) => x.match.prediction.id === body.id);
        if (!p) return fail('That pick is no longer in the list. Scan again.');
        const age = Date.now() - Date.parse(lastScan!.at);
        if (age > maxScanAgeMs()) return fail(`These prices are ${Math.round(age / 60_000)} minutes old. Press Scan now first.`);
        const prior = alreadyIn(p);
        if (prior && ruleOn(safeConfig().risk, 'noDouble')) return fail(prior === 'traded' ? 'You already bought this market.' : 'You already hold a position in this market on Kalshi.');
        if (body.force === true && p.skip) {
          // "Place anyway": the user overrides the edge/price checks for this one pick.
          if (p.hard) return fail(`Can't override: ${p.skip}.`);
          const max = forceMax(p);
          const n = Math.floor(Number(body.contracts));
          if (!Number.isFinite(n) || n < 1) return fail('Enter how many contracts to buy.');
          if (n > max) return fail(`At most ${max} contracts (per-trade and daily limits).`);
          const forced: Proposal = { ...p, contracts: n, notional: +(n * p.quote.ask).toFixed(2) };
          log('warn', `Place anyway: ${p.match.prediction.home} v ${p.match.prediction.away} (${p.skip}), ${n} contracts at up to ${Math.round(p.quote.ask * 100)}¢.`);
          const sum = await withBusy(() => doExecute([forced], 'approve', true));
          return json({ ok: true, placed: sum.placed, filled: sum.filled });
        }
        if (p.skip || p.contracts < 1) return fail(`Not tradable: ${p.skip ?? 'too small'}`);
        const sum = await withBusy(() => doExecute([p], 'approve'));
        return json({ ok: true, placed: sum.placed, filled: sum.filled });
      }

      case '/api/auto': {
        if (body.on) {
          if (killSwitchActive()) return fail('Turn the kill switch off first.');
          auto.on = true;
          rememberAuto(true);
          log('warn', `Auto-trading ON: scanning every ${intervalMin()} minutes and placing every trade that passes the checks, while this window is open.`);
          schedule(1000);
        } else {
          stopAuto();
          log('info', 'Auto-trading OFF. Prices still refresh on schedule.');
        }
        return json({ ok: true });
      }

      case '/api/export': {
        if (!session) return fail('Locked.');
        const r = await buildExport({ cfg: cfgFor(session), creds: session.creds, version: APP_VERSION });
        log('info', `Exported data to ${r.path} (${Math.round(r.bytes / 1024)} KB).`);
        if (process.platform === 'win32' && body.reveal !== false) {
          try { spawn('explorer.exe', [`/select,${r.path}`], { detached: true, stdio: 'ignore' }).unref(); } catch {}
        }
        else if (process.platform === 'darwin' && body.reveal !== false) { try { spawn('open', ['-R', r.path], { detached: true, stdio: 'ignore' }).unref(); } catch {} }
        return json({ ok: true, path: r.path, fileName: r.fileName, bytes: r.bytes, summary: r.summary });
      }

      case '/api/live': {
        const mode = String(body.mode ?? '');
        if (!['off', 'watch', 'trade'].includes(mode)) return fail('Unknown live mode.');
        const cfg = loadConfig();
        if (mode === 'trade') {
          if (killSwitchActive()) return fail('Turn the kill switch off first.');
          const elig = checkRegion(cfg, await loadEligibility(cfg.eligibilityUrl));
          if (!elig.ok) return fail(elig.reason);
        }
        const was = cfg.live.mode;
        cfg.live.mode = mode as AppConfig['live']['mode'];
        if (mode === 'trade') cfg.trading = { ...(cfg.trading ?? {}), live: true };
        saveConfig(cfg);
        if (mode === 'off') { stopLive(); log('info', 'Live picks: off.'); }
        else {
          if (was === 'off') liveEngine.reset();
          log(mode === 'trade' ? 'warn' : 'info', mode === 'trade'
            ? `Live trading ON: new live picks are checked every ${cfg.live.pollSec}s and bought when they pass the checks, while this window is open.`
            : `Live picks: watching every ${cfg.live.pollSec}s (no orders).`);
          scheduleLive(500);
        }
        return json({ ok: true });
      }

      case '/api/live/buy': {
        // Buy one live pick now, by hand (any live mode). Same checks as automatic live buys.
        const id = String(body.id ?? '');
        const cfg = cfgFor(session);
        if (killSwitchActive()) return fail('The kill switch is on.');
        const o = await liveEngine.buyNow(id, await liveContext(session, cfg));
        if (!o) return fail('This live pick is no longer open in the feed.');
        if (o.action !== 'traded') return fail(`Not bought: ${o.reason}`);
        return json({ ok: true, reason: o.reason });
      }

      case '/api/settings/defaults': {
        // Every setting back to its default. Kept: keys (vault), region, Kalshi account,
        // PredyGo tier and source, the accepted disclaimer, background mode.
        const cfg = loadConfig();
        const d = structuredClone(DEFAULT_CONFIG);
        cfg.risk = d.risk;
        cfg.live = d.live;
        cfg.ai = d.ai;
        cfg.pro = { ...d.pro, chosen: true };
        cfg.scanIntervalMin = d.scanIntervalMin;
        cfg.calibration = d.calibration;
        cfg.mode = d.mode;
        cfg.source = { ...cfg.source, minStatedPct: d.source.minStatedPct };
        cfg.resumeAuto = false;
        cfg.trading = structuredClone(d.trading);
        stopAuto();
        if (session) applyAutoSize(cfg, bankrollNow());
        saveConfig(cfg);
        log('warn', 'All settings restored to their defaults. Auto-trade is off.');
        if (session) { schedule(cfg.scanIntervalMin * 60_000); scheduleLive(500); }
        if (cfg.pro.realtime) startStream().catch(() => {}); else stopStream();
        return json({ ok: true });
      }

      case '/api/settings/export':
        return json({ ok: true, xml: exportSettingsXml(loadConfig(), APP_VERSION), fileName: 'soccer-edge-settings.xml' });

      case '/api/settings/import': {
        const xml = String(body.xml ?? '');
        if (!xml || xml.length > 200_000) return fail('Choose a Soccer Edge settings .xml file.');
        const cfg = loadConfig();
        let r: ImportResult;
        try { r = importSettingsXml(cfg, xml); } catch (e) { return fail(errMsg(e)); }
        applyImport(cfg, r, 'the file you chose');
        return json({ ok: true, changed: r.changed.length, ignored: r.ignored });
      }

      case '/api/trading': {
        // Top-bar Pre-game / Live switches.
        const cfg = loadConfig();
        const t = { ...(cfg.trading ?? {}) };
        if (body.live === true) {
          if (killSwitchActive()) return fail('Turn the kill switch off first.');
          const elig = checkRegion(cfg, await loadEligibility(cfg.eligibilityUrl));
          if (!elig.ok) return fail(elig.reason);
        }
        if (typeof body.pregame === 'boolean') {
          t.pregame = body.pregame;
          log(body.pregame ? 'warn' : 'info', body.pregame ? 'Pre-game trading ON.' : 'Pre-game trading OFF: no new pre-game buys; waiting pre-game orders come off the book at the next check.');
        }
        if (typeof body.live === 'boolean') {
          t.live = body.live;
          const wasMode = cfg.live.mode;
          if (body.live && cfg.live.mode !== 'trade') cfg.live.mode = 'trade';
          log(body.live ? 'warn' : 'info', body.live ? 'Live trading ON.' : 'Live trading OFF: live picks are still checked and shown, but not bought.');
          if (body.live && wasMode === 'off') liveEngine.reset();
          scheduleLive(500);
        }
        cfg.trading = t;
        saveConfig(cfg);
        return json({ ok: true });
      }

      case '/api/rules/set': {
        // A value typed next to a rule in the Rules panel.
        const id = String(body.id ?? ''), path = String(body.path ?? '');
        const rule = RULES.find((r) => r.id === id);
        const f = (RULE_FIELDS[id] ?? []).find((x) => x.path === path);
        if (!rule || !f) return fail('Unknown rule setting.');
        const cfg = loadConfig();
        if (cfg.risk.autoSize !== false && AUTO_SIZED.includes(path)) return fail(`"${f.label}" is worked out from your balance while "Size limits from my balance" is on (Settings). Switch that off to set it yourself.`);
        let v: number | string;
        try { v = ruleFieldValue(f, body.value); } catch (e) { return fail(errMsg(e)); }
        setPath(cfg, path, v);
        if (path === 'live.mode' && v === 'trade') cfg.trading = { ...cfg.trading, live: true };
        if (path === 'ai.precheck') cfg.ai.enabled = true;
        if (session) applyAutoSize(cfg, bankrollNow());
        saveConfig(cfg);
        log('info', `${rule.name}: ${f.label} set to ${body.value}${f.unit ? ' ' + f.unit : ''}.`);
        lastScan = null;
        if (session) { schedule(1500); scheduleLive(500); }
        return json({ ok: true });
      }

      case '/api/rules/toggle': {
        // A switch in the Rules panel. Rules backed by a setting change that setting; the rest
        // go in risk.rulesOff. Required rules can't be switched off.
        const id = String(body.id ?? ''), on = !!body.on;
        const rule = RULES.find((r) => r.id === id);
        if (!rule) return fail('Unknown rule.');
        if (isRequired(id)) return fail(`"${rule.name}" can't be switched off: there would be nothing real to buy.`);
        const cfg = loadConfig();
        switch (id) {
          case 'kill': return handleApi(on ? '/api/kill' : '/api/resume', {});
          case 'liveSwitch': return handleApi('/api/trading', { live: on });
          case 'liveMode': if (!on) cfg.live.mode = 'off'; else { if (cfg.live.mode === 'off') liveEngine.reset(); cfg.live.mode = 'trade'; } break;
          case 'pregameSwitch': return handleApi('/api/trading', { pregame: on });
          case 'block25': cfg.risk.blockOver25 = on; break;
          case 'blockBtts': cfg.risk.blockBtts = on; break;
          case 'stated': cfg.risk.requireStatedAboveCost = on; break;
          case 'highRisk': cfg.risk.tradeHighRisk = !on; break;
          case 'rest': cfg.risk.restOrders = on; break;
          case 'kalshiOdds': cfg.risk.useKalshiOdds = on; break;
          case 'claude': cfg.ai.precheck = on ? 'veto' : 'off'; if (on) cfg.ai.enabled = true; break;
          default: {
            const off = new Set(cfg.risk.rulesOff ?? []);
            if (on) off.delete(id); else off.add(id);
            cfg.risk.rulesOff = [...off];
          }
        }
        if (session) applyAutoSize(cfg, bankrollNow());
        saveConfig(cfg);
        log(on ? 'info' : 'warn', `Rule "${rule.name}" switched ${on ? 'on' : 'off'}.`);
        lastScan = null;
        if (session) { schedule(1500); scheduleLive(500); }
        return json({ ok: true });
      }

      case '/api/kill': {
        stopAuto();
        writeFileSync(killSwitchPath(), `${new Date().toISOString()} app\n`);
        record({ type: 'kill', at: new Date().toISOString(), reason: 'app button' });
        log('warn', 'Kill switch ON. No new orders; taking waiting orders off the book.');
        cancelAllAppOrders(safeConfig(), session.creds, (lv, m) => log(lv, m), 'kill switch is on').catch(() => {});
        return json({ ok: true });
      }

      case '/api/resume': {
        if (existsSync(killSwitchPath())) rmSync(killSwitchPath());
        record({ type: 'resume', at: new Date().toISOString() });
        log('info', 'Kill switch off.');
        return json({ ok: true });
      }

      case '/api/diagnostics': {
        if (diag.running) return json({ ok: true, running: true });
        const s0 = session;
        diag = { running: true, report: null, text: null, error: null };
        clearMarketCache(); // check against fresh Kalshi data
        runDiagnostics({
          cfg: cfgFor(s0),
          creds: s0.creds,
          predygoKey: s0.secrets.predygoKey,
          version: APP_VERSION,
          tradeCheck: (() => { try { return tracker.reconcileReport(session!.creds.env); } catch { return undefined; } })(),
          sync: (() => { try { return tracker.syncStatus(session!.creds.env); } catch { return undefined; } })(),
          autoOn: auto.on,
          feedMode: lastFeedMode,
          tier: safeConfig().source?.tier ?? 'elite',
          useKalshiOdds: safeConfig().risk?.useKalshiOdds !== false,
          recentErrors: logs.filter((l) => l.level === 'error').slice(-5).map((l) => `${new Date(l.at).toLocaleTimeString()} ${l.msg}`),
        })
          .then((report) => { diag = { running: false, report, text: reportText(report), error: null }; log('info', `Diagnostics: ${report.counts.fail} problem(s), ${report.counts.warn} warning(s).`); })
          .catch((e) => { diag = { running: false, report: null, text: null, error: errMsg(e) }; log('error', `Diagnostics failed: ${errMsg(e)}`); });
        return json({ ok: true, running: true });
      }

      case '/api/settings': {
        const cfg = loadConfig();
        if (body.country !== undefined) {
          const country = String(body.country).toUpperCase();
          if (!countryOptions().some((c) => c.code === country)) return fail('Unknown country.');
          cfg.country = country;
          if (country !== 'US') cfg.state = undefined;
        }
        if (body.usState !== undefined && regionOf(cfg).country === 'US') {
          const st = String(body.usState).toUpperCase();
          if (!US_STATES.has(st)) return fail('Choose a US state.');
          cfg.state = st;
        }
        const num = (v: unknown, lo: number, hi: number, name: string) => {
          const n = Number(v);
          if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${name} must be between ${lo} and ${hi}.`);
          return n;
        };
        const oldInterval = cfg.scanIntervalMin;
        try {
          if (body.stakeMode !== undefined) {
            if (body.stakeMode !== 'flat' && body.stakeMode !== 'kelly') throw new Error('Stake must be flat or kelly.');
            cfg.risk.stakeMode = body.stakeMode;
          }
          if (body.livePollSec !== undefined) cfg.live.pollSec = Math.round(num(body.livePollSec, 5, 60, 'Live check interval (seconds)'));
          if (body.liveMaxMinutes !== undefined) cfg.live.maxMinutesSinceKickoff = Math.round(num(body.liveMaxMinutes, 30, 130, 'Live latest pick (minutes)'));
          if (body.liveMaxAgeSec !== undefined) cfg.live.maxPickAgeSec = Math.round(num(body.liveMaxAgeSec, 10, 300, 'Live pick max age (seconds)'));
          if (body.liveMaxPriceJump !== undefined) cfg.live.maxPriceJump = num(body.liveMaxPriceJump, 0.01, 1, 'Live: biggest recent price jump');
          if (body.minStatedPct !== undefined) cfg.source = { ...cfg.source, minStatedPct: Math.round(num(body.minStatedPct, 0, 99, 'Minimum PredyGo confidence')) };
          if (body.calibration !== undefined) {
            if (body.calibration !== 'hit-rate' && body.calibration !== 'stated') throw new Error('Win chance must come from the hit rate or the stated confidence.');
            cfg.calibration = body.calibration;
          }
        } catch (e) { return fail(errMsg(e)); }
        if (body.scanIntervalMin !== undefined) {
          try { cfg.scanIntervalMin = Math.round(num(body.scanIntervalMin, 2, 60, 'Refresh interval (minutes)')); }
          catch (e) { return fail(errMsg(e)); }
        }
        if (body.tier !== undefined) {
          const t = String(body.tier).toLowerCase();
          if (!/^[a-z][a-z0-9_-]{0,30}$/.test(t)) return fail('Unknown tier.');
          if (t === 'free') return fail('The Free tier has no API access, so it can\'t be traded.');
          const allowed = tiersForKey(session?.predygo?.tier);
          if (allowed && !allowed.includes(t)) return fail(`Your PredyGo key is ${session!.predygo!.tier}: it only receives ${allowed.join(' and ')} picks, so ${t} can't be chosen.`);
          cfg.source = { ...cfg.source, tier: t };
          lastScan = null;
        }
        if (body.resumeAuto !== undefined) { cfg.resumeAuto = !!body.resumeAuto; rememberAuto(auto.on); }
        // Published picks only, always (no setting).
        const r = body.risk as Partial<RiskConfig> | undefined;
        if (r) {
          try {
            if (r.maxDailySpend !== undefined) cfg.risk.maxDailySpend = Number(r.maxDailySpend) === 0 || String(r.maxDailySpend).trim() === '' ? 0 : num(r.maxDailySpend, 1, 100_000, 'Daily limit');
            if (r.maxNotionalPerOrder !== undefined) cfg.risk.maxNotionalPerOrder = num(r.maxNotionalPerOrder, 1, 10_000, 'Per-trade limit');
            if (r.maxOpenPositions !== undefined) cfg.risk.maxOpenPositions = Math.round(num(r.maxOpenPositions, 1, 200, 'Open positions'));
            if (r.minEdge !== undefined) cfg.risk.minEdge = num(r.minEdge, 0, 0.5, 'Minimum edge');
            if (r.maxPrice !== undefined) cfg.risk.maxPrice = num(r.maxPrice, 0.5, 0.99, 'Max price');
            if (r.maxGapToMarket !== undefined) cfg.risk.maxGapToMarket = num(r.maxGapToMarket, 0, 1, 'Max gap to market');
            if (r.marketWeight !== undefined) cfg.risk.marketWeight = num(r.marketWeight, 0, 0.7, 'Lean toward market');
            if (r.maxOpenPerBetType !== undefined) cfg.risk.maxOpenPerBetType = Math.round(num(r.maxOpenPerBetType, 0, 20, 'Max open bets of one kind (0 = no limit)'));
            if (r.maxOpenExposurePct !== undefined) cfg.risk.maxOpenExposurePct = num(r.maxOpenExposurePct, 0.05, 1, 'Max open bets share');
            cfg.risk.onePerMatch = true; // hard rule, always on
            if (r.minWinProfit !== undefined) cfg.risk.minWinProfit = num(r.minWinProfit, 0, 100, 'Minimum win');
            if (r.autoSize !== undefined) cfg.risk.autoSize = !!r.autoSize;
            if (r.restOrders !== undefined) cfg.risk.restOrders = !!r.restOrders;
            if (r.blockOver25 !== undefined) cfg.risk.blockOver25 = !!r.blockOver25;
            if (r.tradeHighRisk !== undefined) { cfg.risk.tradeHighRisk = !!r.tradeHighRisk; log('warn', cfg.risk.tradeHighRisk ? 'High-risk picks ON: PredyGo HIGH RISK / HIGH REWARD plays are bought too.' : 'High-risk picks OFF: PredyGo HIGH RISK plays are skipped.'); }
            if (r.blockBtts !== undefined) cfg.risk.blockBtts = !!r.blockBtts;
            if (r.useKalshiOdds !== undefined) cfg.risk.useKalshiOdds = !!r.useKalshiOdds;
            if (r.minProbability !== undefined) cfg.risk.minProbability = num(r.minProbability, 0.5, 0.99, 'Minimum win chance');
            if (r.maxPositionPct !== undefined) cfg.risk.maxPositionPct = num(r.maxPositionPct, 0.01, 0.5, 'Max share of cash per trade');
            if (r.edgeUncertainty !== undefined) cfg.risk.edgeUncertainty = num(r.edgeUncertainty, 0, 3, 'Uncertainty buffer');
            if (r.kellyMultiplier !== undefined) cfg.risk.kellyMultiplier = num(r.kellyMultiplier, 0.05, 1, 'Kelly fraction');
            if (r.maxContractsPerOrder !== undefined) cfg.risk.maxContractsPerOrder = Math.round(num(r.maxContractsPerOrder, 1, 10_000, 'Most contracts per order'));
            if (r.maxSpreadCents !== undefined) cfg.risk.maxSpreadCents = Math.round(num(r.maxSpreadCents, 1, 99, 'Widest bid-ask spread'));
            if (r.minMinutesBeforeKickoff !== undefined) cfg.risk.minMinutesBeforeKickoff = Math.round(num(r.minMinutesBeforeKickoff, 0, 240, 'Stop buying before kickoff'));
            if (r.requireStatedAboveCost !== undefined) cfg.risk.requireStatedAboveCost = !!r.requireStatedAboveCost;
          } catch (e) { return fail(errMsg(e)); }
        }
        if (session) applyAutoSize(cfg, bankrollNow());
        saveConfig(cfg);
        // A new interval takes effect now; other changes keep the current countdown.
        if (session && (cfg.scanIntervalMin !== oldInterval || !auto.timer)) schedule(cfg.scanIntervalMin * 60_000);
        log('info', 'Settings saved.');
        return json({ ok: true });
      }
    }
    return fail('Not found', 404);
  }

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: opts.port ?? 0,
    idleTimeout: 120,
    async fetch(req) {
      const url = new URL(req.url);
      const host = req.headers.get('host') ?? '';
      if (host !== `127.0.0.1:${server.port}` && host !== `localhost:${server.port}`) return new Response('Forbidden', { status: 403 });

      if (req.method === 'GET' && url.pathname === '/') {
        if (!goodToken(url.searchParams.get('t'))) return new Response('Open the app from soccer-edge.exe.', { status: 403 });
        return new Response(renderPage(token), {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
            'X-Frame-Options': 'DENY',
            'Referrer-Policy': 'no-referrer',
          },
        });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/export/')) {
        // Download a file made by "Export data" (token required; name can't leave the exports folder).
        if (!goodToken(url.searchParams.get('t'))) return new Response('Forbidden', { status: 403 });
        const name = basename(decodeURIComponent(url.pathname.slice('/export/'.length)));
        if (!/^soccer-edge-export-[\w-]+\.json$/.test(name)) return new Response('Not found', { status: 404 });
        const file = Bun.file(join(exportsDir(), name));
        if (!(await file.exists())) return new Response('Not found', { status: 404 });
        return new Response(file, { headers: { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' } });
      }
      if (url.pathname === '/api/bye' && req.method === 'POST' && goodToken(url.searchParams.get('t'))) {
        // Window closed or reloading: exit in ~15s unless the page checks back in.
        lastBeat = Date.now() - IDLE_EXIT_MS + 8_000;
        return new Response(null, { status: 204 });
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
        if (!goodToken(req.headers.get('x-session'))) return new Response('Forbidden', { status: 403 });
        lastBeat = Date.now();
        if (!(req.headers.get('content-type') ?? '').includes('application/json')) return new Response('Bad request', { status: 400 });
        let body: any = {};
        try { body = await req.json(); } catch {}
        try {
          return await handleApi(url.pathname, body);
        } catch (e) {
          log('error', errMsg(e));
          return fail(errMsg(e), 500);
        }
      }
      return new Response('Not found', { status: 404 });
    },
  });

  const appUrl = `http://127.0.0.1:${server.port}/?t=${token}`;
  writeInstanceFile(server.port!, token, background);

  // Shut down: wipe secrets, stop timers and the server, release the trade lock, exit.
  let shuttingDown = false;
  shutdown = (reason: string) => {
    if (shuttingDown || opts.exitWhenIdle === false) return;
    shuttingDown = true;
    try { lock(); } catch {}
    clearInterval(idle);
    try { server.stop(true); } catch {}
    removeInstanceFile();
    try {
      const lockFile = join(appHome(), 'run.lock');
      if (existsSync(lockFile) && parseInt(readFileSync(lockFile, 'utf8'), 10) === process.pid) rmSync(lockFile, { force: true });
    } catch {}
    console.log(`Exiting: ${reason}`);
    try { appendFileSync(join(appHome(), 'exits.log'), `${new Date().toISOString()} ${reason}\n`); } catch {}
    process.exit(0);
  };

  // Safety net: an unexpected error anywhere must never end the app silently (Windows shows no
  // console). Record it in error.log and Activity, and keep running.
  const crashNote = (kind: string, e: unknown) => {
    const msg = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
    try { appendFileSync(join(appHome(), 'error.log'), `${new Date().toISOString()} ${kind}: ${msg}\n`); } catch {}
    try { log('error', `Unexpected error (${kind}), still running: ${errMsg(e)}`); } catch {}
  };
  process.on('uncaughtException', (e) => crashNote('uncaught', e));
  process.on('unhandledRejection', (e) => crashNote('unhandled promise', e));

  // Watchdog: if a check is overdue (a stuck step, a lost timer), start one now.
  setInterval(() => {
    if (!session) return;
    const due = auto.nextAt ? Date.parse(auto.nextAt) : NaN;
    if (Number.isFinite(due) && Date.now() - due > 3 * 60_000 && !cycleRunning) {
      log('warn', `Watchdog: the scheduled check was ${Math.round((Date.now() - due) / 60_000)} min overdue; running it now.`);
      schedule(1_000);
    }
  }, 60_000);

  // Fallback: exit once the window has been gone for a while. Auto-trading only runs with the window open.
  // Not while the app window's browser process is still running (closing it exits the app on its
  // own): Edge pauses minimized / power-saving windows, so their check-ins stop without the
  // window being closed. And not right after the PC wakes from sleep (the window hasn't had a
  // chance to check in yet).
  let lastTick = Date.now();
  const idle = setInterval(() => {
    const t = Date.now();
    const gap = t - lastTick;
    lastTick = t;
    if (gap > 30_000) { lastBeat = t; log('info', `The PC was asleep or paused for ${Math.max(1, Math.round(gap / 60_000))} min; carrying on.`); return; }
    if (opts.exitWhenIdle === false || background || appWindowRunning()) return;
    if (t - lastBeat > IDLE_EXIT_MS) shutdown('window closed (no check-in for 3 min)');
  }, 5_000);

  // soccer-edge-settings.xml next to the app or in its data folder: applied when new or changed.
  try {
    const cfg0 = loadConfig();
    const f = pendingSettingsFile(cfg0);
    if (f) {
      const r = importSettingsXml(cfg0, f.xml);
      cfg0.settingsImport = { hash: f.hash, at: new Date().toISOString(), path: f.path };
      applyImport(cfg0, r, f.path);
    }
  } catch (e) { log('error', `Could not import the settings file: ${errMsg(e)}`); }

  if (background) autoUnlockLoop().catch((e) => log('error', `Background mode: unlock failed: ${errMsg(e)}`));

  if (opts.openWindow !== false) openAppWindow(appUrl, () => {
    // The app window's own browser process ended: the window was closed. Give a reload or a
    // reopened window a few seconds to check in, then exit.
    const closedAt = Date.now();
    setTimeout(() => { if (lastBeat < closedAt) shutdown('window closed'); }, 4_000);
  });
  openWindowHere = () => openAppWindow(appUrl);

  return {
    url: appUrl,
    port: server.port!,
    stop: () => { clearInterval(idle); lock(); server.stop(true); removeInstanceFile(); },
  };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ------------------------------------------------------------ single instance

const instancePath = () => join(appHome(), 'instance.json');

function writeInstanceFile(port: number, token: string, background = false) {
  writeFileSync(instancePath(), JSON.stringify({ port, token, pid: process.pid, version: APP_VERSION, background }), { mode: 0o600 });
}

export interface InstanceInfo { port: number; token: string; pid: number; version?: string; background?: boolean }

/** The running copy, if it answers. */
export async function runningInstance(): Promise<InstanceInfo | null> {
  try {
    const i = JSON.parse(readFileSync(instancePath(), 'utf8')) as InstanceInfo;
    const res = await fetch(`http://127.0.0.1:${i.port}/api/heartbeat`, {
      method: 'POST', headers: { 'x-session': i.token, 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(1500),
    });
    return res.ok ? i : null;
  } catch {
    return null;
  }
}

export async function waitForInstance(ok: (i: InstanceInfo) => boolean, ms: number): Promise<InstanceInfo | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const i = await runningInstance();
    if (i && ok(i)) return i;
    await Bun.sleep(1000);
  }
  return null;
}

/** Ask a running copy to quit, and wait until it has. */
export async function quitInstance(i: InstanceInfo, ms = 20_000): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${i.port}/api/quit`, {
      method: 'POST', headers: { 'x-session': i.token, 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(3000),
    });
  } catch {}
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!(await runningInstance())) return true;
    await Bun.sleep(500);
  }
  return false;
}

function removeInstanceFile() {
  try {
    const cur = JSON.parse(readFileSync(instancePath(), 'utf8'));
    if (cur.pid === process.pid) rmSync(instancePath());
  } catch {}
}

/** If the app is already running, bring its window back instead of starting a second copy. */
export async function focusExistingInstance(): Promise<boolean> {
  try {
    const { port, token } = JSON.parse(readFileSync(instancePath(), 'utf8'));
    // Ask the running copy to open its window (it then knows when that window closes).
    const res = await fetch(`http://127.0.0.1:${port}/api/open`, {
      method: 'POST',
      headers: { 'x-session': token, 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------ window

/** Separate Edge profile for the app window, so its browser process lives exactly as long as the window. */
const edgeProfileDir = () => join(appHome(), 'window');
/** Edge process that holds the app window (the first launch that stays running). */
let windowProc: { pid: number } | null = null;
/** True while the app window's own browser process (Windows / Edge) is running. */
export function appWindowRunning(): boolean {
  const p = windowProc as { exitCode?: number | null } | null;
  return !!p && (p.exitCode === null || p.exitCode === undefined);
}
/** Called when the app window's browser process ends. */
let onWindowClosed: (() => void) | null = null;

/** Open the app window from this (short-lived) process, left running after it exits. */
export function openWindowDetached(url: string) {
  const edge = [
    `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env.LOCALAPPDATA}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ].find((p) => p && existsSync(p));
  try {
    if (edge) spawn(edge, [`--app=${url}`, '--window-size=1280,880', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${edgeProfileDir()}`], { detached: true, stdio: 'ignore' }).unref();
    else spawn('explorer.exe', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch {}
}

export function openAppWindow(url: string, onClosed?: () => void) {
  if (onClosed) onWindowClosed = onClosed;
  if (process.platform === 'win32') {
    const edgePaths = [
      `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${process.env.LOCALAPPDATA}\\Microsoft\\Edge\\Application\\msedge.exe`,
    ];
    const edge = edgePaths.find((p) => p && existsSync(p));
    if (edge) {
      const started = Date.now();
      const proc = Bun.spawn([
        edge, `--app=${url}`, '--window-size=1280,880', '--no-first-run', '--no-default-browser-check',
        `--user-data-dir=${edgeProfileDir()}`, '--disable-background-mode', '--disable-features=msEdgeStartupBoost',
      ], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: false } as any);
      proc.exited.then(() => {
        // A launch that ends within a few seconds just handed the window to an Edge process
        // already running this profile; only the long-lived one marks the window closing.
        if (Date.now() - started < 5_000 && windowProc && windowProc !== proc) return;
        if (Date.now() - started < 5_000 && !windowProc) return;
        if (windowProc === proc) windowProc = null;
        onWindowClosed?.();
      });
      setTimeout(() => { if (proc.exitCode === null && !windowProc) windowProc = proc; }, 5_000);
      return;
    }
    Bun.spawn(['cmd.exe', '/c', 'start', '""', url], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true } as any);
    return;
  }
  if (process.platform === 'darwin') {
    // Mac: its own app window in Chrome / Edge / Brave (closing it quits Soccer Edge), else the default browser.
    const home = process.env.HOME ?? '';
    const browsers = ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium'].flatMap((n) => [
      `/Applications/${n}.app/Contents/MacOS/${n}`, `${home}/Applications/${n}.app/Contents/MacOS/${n}`]);
    const b = browsers.find((p) => existsSync(p));
    if (b) {
      try {
        Bun.spawn([b, `--app=${url}`, '--window-size=1280,880', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${edgeProfileDir()}`],
          { stdio: ['ignore', 'ignore', 'ignore'] });
        return;
      } catch {}
    }
  }
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  try { Bun.spawn([opener, url], { stdio: ['ignore', 'ignore', 'ignore'] }); } catch { console.log(`Open ${url}`); }
}
