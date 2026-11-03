/**
 * Local configuration. Everything lives on the user's own machine:
 *   Windows: %APPDATA%\soccer-edge\
 *   Mac:     ~/Library/Application Support/soccer-edge/
 *   Other:   ~/.soccer-edge/
 * Override with SOCCER_EDGE_HOME.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type KalshiEnv = 'demo' | 'prod';
export type TradeMode = 'approve' | 'auto';
export type Calibration = 'hit-rate' | 'stated';

export interface RiskConfig {
  /**
   * 'kelly': stake = kellyMultiplier x Kelly x cash (bigger edge, bigger bet).
   * 'flat': every pick that clears the edge bar gets the full per-trade amount.
   * Both are then capped by maxPositionPct, maxNotionalPerOrder and the daily limit.
   */
  stakeMode: 'kelly' | 'flat';
  /**
   * Hard floor, 0-1: never trade a pick whose win chance (the app's hit-rate estimate,
   * and PredyGo's stated confidence when the feed gives one) is below this. No override.
   */
  minProbability: number;
  /** Never buy above this price (0-1): at 95¢+ there's almost nothing left to win. */
  maxPrice: number;
  /** Share of the edge calculation taken from the market price (0 = model only). */
  marketWeight: number;
  /**
   * Skip when the win chance is this far above the Kalshi price or the feed's own odds
   * (0-1). A gap that big usually means the model is missing something about the match.
   */
  maxGapToMarket?: number;
  /** At most this many open bets of the same kind (team scores, totals, BTTS, result). 0 = no limit. */
  maxOpenPerBetType: number;
  /** Never hold two bets on the same match. */
  onePerMatch: boolean;
  /**
   * Size everything from the balance to fit as many good trades as the money allows:
   * per trade at most maxPositionPct of balance (rounded down to $0.50); daily limit =
   * maxOpenExposurePct of balance; open positions limited by money, not a count ($1
   * minimum per bet); and when more picks qualify than the money covers, each stake is
   * cut so they all get a share instead of the first few taking everything.
   */
  autoSize?: boolean;
  /** Every trade must stand to win at least this many dollars (profit after the fee) if it wins. */
  minWinProfit?: number;
  /** Skip Over 2.5 goals picks (TOTALGOALS+2.5). Off by default; check their hit rate in your own results. */
  blockOver25?: boolean;
  /** Skip both-teams-to-score picks (BTTS). Off by default; check their hit rate in your own results. */
  blockBtts?: boolean;
  /**
   * Rules switched off in the Rules panel (ids from src/trade/rules.ts). Each one is skipped
   * wherever it's enforced. New installs start with the rules PredyGo's own picks don't need
   * switched off (see DEFAULT_RULES_OFF); existing installs keep every rule on.
   */
  rulesOff?: string[];
  /** Buy PredyGo picks flagged high_risk (late-game "HIGH RISK / HIGH REWARD", not graded). Default off. */
  tradeHighRisk?: boolean;
  /**
   * Use Kalshi odds over feed odds: judge every pick on Kalshi's live price instead of the
   * feed's odds, so the feed's odds don't block a trade, and live picks are checked against Kalshi's
   * price history. Also lets live picks seen late, or skipped on price, be re-checked.
   */
  useKalshiOdds?: boolean;
  /** Which one-time settings update has been applied (21 = v0.21.0). */
  settingsRev?: number;
  /** Total cost of open bets may not exceed this share of the bankroll. */
  maxOpenExposurePct: number;
  /** Fraction of full Kelly to bet (0.25 = quarter Kelly). */
  kellyMultiplier: number;
  /** Max share of available cash in one position. */
  maxPositionPct: number;
  /**
   * Base minimum edge (calibrated probability minus price incl. fees), 0-1.
   * The edge actually required is this plus `edgeUncertainty` standard errors
   * of the bet type's hit rate.
   */
  minEdge: number;
  /** Standard errors of hit-rate uncertainty added to minEdge. 0 = flat minimum. */
  edgeUncertainty: number;
  /** Hard cap: contracts per order. */
  maxContractsPerOrder: number;
  /** Hard cap: dollars at risk per order. */
  maxNotionalPerOrder: number;
  /** Daily spending limit in dollars; 0 = no daily limit (cash and open-bets limits still apply). */
  maxDailySpend: number;
  /** Max positions opened by this tool that are still unsettled. */
  maxOpenPositions: number;
  /** Don't trade within this many minutes of kickoff (prices move fast, lineups land). */
  minMinutesBeforeKickoff: number;
  /** Skip markets whose bid/ask spread is wider than this (cents). */
  maxSpreadCents: number;
  /** Also require the source's stated confidence to beat the price (guards against pooled hit rates). */
  requireStatedAboveCost: boolean;
  /**
   * Buy at our price: when the ask is too high, leave a buy order on the book at the most the
   * pick is worth (maker fee), until minMinutesBeforeKickoff. Default on.
   */
  restOrders?: boolean;
  /** Bet types or leagues paused until a time. */
  paused?: PauseRule[];
}

export interface PauseRule {
  kind: 'bet' | 'league';
  /** Bet code (e.g. "VISITA MARCA") or league name as PredyGo sends it. */
  value: string;
  until: string;
  reason: string;
  by: 'claude' | 'you';
}

export interface SourceConfig {
  /** 'predygo' = PredyGo JSON feed; 'file' = local JSON or CSV in the same shape. */
  type: 'predygo' | 'file';
  url?: string;
  token?: string;
  path?: string;
  /** Ignore predictions below this stated confidence (0-100). */
  minStatedPct?: number;
  /** Ask PredyGo for the full model list (?all=true), not only the picks published on the website. Default false (published only). */
  includeAll?: boolean;
  /** Only picks delivered to this PredyGo tier ('elite' default; 'any' = no filter). Needs the feed to say which tier each pick went to. */
  tier?: string;
}

export type LiveMode = 'off' | 'watch' | 'trade';

export interface LiveConfig {
  /** off: ignore live picks. watch: record Kalshi's price when each one appears. trade: also buy. */
  mode: LiveMode;
  /** Seconds between live checks. 5-60. */
  pollSec: number;
  /** Only act on a live pick this many seconds after it first appears. */
  maxPickAgeSec: number;
  /** Skip when Kalshi's price is this far above the pick's own odds (a goal has probably gone in). */
  maxPriceJump: number;
  /** Don't act on live picks made later than this many minutes after kickoff (wall clock). */
  maxMinutesSinceKickoff: number;
}

export interface AppConfig {
  kalshi: {
    env: KalshiEnv;
    apiKeyId?: string;
    privateKeyPath?: string;
  };
  /** ISO country the user trades from (e.g. "US", "CO"). Required before any order. */
  country?: string;
  /** Two-letter US state, when country is US. */
  state?: string;
  source: SourceConfig;
  calibration: Calibration;
  mode: TradeMode;
  risk: RiskConfig;
  /** Optional URL of an eligibility JSON you host, so the state list can be updated without a new build. */
  eligibilityUrl?: string;
  /** Minutes between scans (price refresh, and auto-trade when on). 2-60. */
  scanIntervalMin: number;
  /** Turn auto-trade back on after a restart, when it was on when the app closed. Default off. */
  resumeAuto?: boolean;
  /** Disclaimer the user accepted (version, when). The app does nothing until the current version is accepted. */
  disclaimer?: { version: number; at: string };
  /** Last settings XML imported automatically (so the same file isn't applied twice). */
  settingsImport?: { hash: string; at: string; path: string };
  /** Top-bar Pre-game / Live switches (defaults: pre-game on, live off; a missing value = on). */
  trading?: { pregame?: boolean; live?: boolean };
  live: LiveConfig;
  /** Kalshi Pro-style real-time data (WebSocket): live prices, positions, P/L and fills. Display only. */
  pro: { realtime: boolean; chosen?: boolean };
  ai: AiConfig;
}

export interface AiConfig {
  /** Use the AI check at all (needs that provider's API key in the vault). */
  enabled: boolean;
  /** Which assistant: Claude (Anthropic key) or ChatGPT (OpenAI key). */
  provider?: 'claude' | 'chatgpt';
  /** Before each order: off, advise (log only) or veto (Claude can stop the trade). */
  precheck: 'off' | 'advise' | 'veto';
  /** If Claude can't be reached in time: true = trade anyway, false = skip the trade. */
  failOpen: boolean;
  /** Model for the per-trade check (cheap, fast). */
  checkModel: string;
  /** Stop calling Claude for the day after spending this much, dollars. */
  dailyBudgetUsd: number;
  /** Which one-time Claude settings update has been applied. */
  aiRev?: number;
}

export const DEFAULT_CONFIG: AppConfig = {
  kalshi: { env: 'demo' },
  source: { type: 'file', path: 'predictions.json', minStatedPct: 0, includeAll: false, tier: 'elite' },
  calibration: 'hit-rate',
  mode: 'approve',
  scanIntervalMin: 5,
  live: { mode: 'trade', pollSec: 10, maxPickAgeSec: 300, maxPriceJump: 0.15, maxMinutesSinceKickoff: 95 },
  // Live picks are checked and shown; the top-bar Live switch (off) decides if they're bought.
  trading: { pregame: true, live: false },
  pro: { realtime: true },
  ai: {
    enabled: false, provider: 'claude', precheck: 'off', failOpen: true,
    checkModel: 'claude-haiku-5-5', dailyBudgetUsd: 0.5,
  },
  // Defaults follow how PredyGo's picks are meant to be used (as flexible as possible):
  // the filters PredyGo's own picks don't need start switched off, with sensible values ready
  // for anyone who switches them on. Buying stays manual until you turn automation on.
  risk: {
    stakeMode: 'flat',
    minProbability: 0.65,
    maxPrice: 0.96,
    marketWeight: 0.3,
    maxGapToMarket: 0.3,
    maxOpenPerBetType: 0,
    onePerMatch: true,
    autoSize: true,
    minWinProfit: 0.5,
    blockOver25: false,
    blockBtts: false,
    useKalshiOdds: true,
    restOrders: false,
    paused: [],
    maxOpenExposurePct: 1,
    kellyMultiplier: 0.25,
    maxPositionPct: 0.1,
    minEdge: 0.05,
    edgeUncertainty: 1,
    maxContractsPerOrder: 50,
    maxNotionalPerOrder: 25,
    maxDailySpend: 0,
    maxOpenPositions: 10,
    minMinutesBeforeKickoff: 2,
    maxSpreadCents: 8,
    requireStatedAboveCost: false,
    rulesOff: [],
  },
};

/** Rules a new install (and Restore defaults) starts with switched off: the ones that second-guess PredyGo's picks. */
export const DEFAULT_RULES_OFF = ['hitRate', 'minProb', 'edge', 'lean', 'gap', 'spread', 'minWin', 'openCount', 'liveRecord', 'liveJump'];
DEFAULT_CONFIG.risk.rulesOff = [...DEFAULT_RULES_OFF];

/** Is this rule switched on? (Rules panel; missing = on.) */
export function ruleOn(risk: { rulesOff?: string[] } | undefined, id: string): boolean {
  return !risk?.rulesOff?.includes(id);
}

/**
 * Rules switched off that work by a value: open them up in the config the engine uses (the
 * saved values stay, ready for when the rule is switched back on). Rules checked in code
 * (one bet per game, the 80th minute, ...) look at ruleOn() where they're enforced.
 */
export function ruleSwitches(cfg: AppConfig): AppConfig {
  const off = cfg.risk.rulesOff ?? [];
  if (!off.length) return cfg;
  const c = structuredClone(cfg);
  const r = c.risk, has = (id: string) => off.includes(id);
  if (has('minProb')) r.minProbability = 0;
  if (has('edge')) { r.minEdge = -1; r.edgeUncertainty = 0; }
  if (has('lean')) r.marketWeight = 0;
  if (has('gap')) r.maxGapToMarket = 0;
  if (has('maxPrice')) r.maxPrice = 0.99;
  if (has('spread')) r.maxSpreadCents = 99;
  if (has('minWin')) r.minWinProfit = 0;
  if (has('kickoff')) r.minMinutesBeforeKickoff = 0;
  if (has('perTrade')) { r.maxNotionalPerOrder = 1_000_000; r.maxPositionPct = 1; r.maxContractsPerOrder = 1_000_000; }
  if (has('daily')) r.maxDailySpend = 0;
  if (has('exposure')) r.maxOpenExposurePct = 1;
  if (has('openCount')) r.maxOpenPositions = 1_000_000;
  if (has('perKind')) r.maxOpenPerBetType = 0;
  if (has('pause')) r.paused = [];
  if (has('onePerMatch')) r.onePerMatch = false;
  if (has('tier')) c.source.tier = 'any';
  if (has('liveMinute')) c.live.maxMinutesSinceKickoff = 1_000_000;
  if (has('liveAge')) c.live.maxPickAgeSec = 1_000_000;
  if (has('liveJump')) c.live.maxPriceJump = 1;
  return c;
}


export function appHome(): string {
  if (process.env.SOCCER_EDGE_HOME) return process.env.SOCCER_EDGE_HOME;
  if (process.platform === 'win32' && process.env.APPDATA) return join(process.env.APPDATA, 'soccer-edge');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'soccer-edge');
  return join(homedir(), '.soccer-edge');
}

export function ensureHome(): string {
  const dir = appHome();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export const configPath = (): string => join(appHome(), 'config.json');
export const ledgerPath = (): string => join(appHome(), 'ledger.jsonl');
export const liveLogPath = (): string => join(appHome(), 'live.jsonl');
export const picksLogPath = (): string => join(appHome(), 'picks.jsonl');
export const exportsDir = (): string => join(appHome(), 'exports');
export const killSwitchPath = (): string => join(appHome(), 'KILL');

function merge<T>(base: T, over: Partial<T> | undefined): T {
  if (!over) return base;
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof (base as any)[k] === 'object') {
      out[k] = merge((base as any)[k], v as any);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * v0.36: the Follow PredyGo switch is gone (its behaviour is now the defaults). Settings that had
 * it on (saved, or in an imported XML file) become the same settings, so trading carries on as before.
 */
export function migrateFollow(cfg: AppConfig): void {
  if ((cfg.risk as any).followAll === true) {
    cfg.risk.rulesOff = [...new Set([...(cfg.risk.rulesOff ?? []), ...DEFAULT_RULES_OFF])];
    Object.assign(cfg.risk, {
      blockOver25: false, blockBtts: false, paused: [], maxPrice: 0.96, maxSpreadCents: 99, minWinProfit: 0,
      requireStatedAboveCost: false, onePerMatch: true, maxOpenPerBetType: 0, maxOpenExposurePct: 1,
      minMinutesBeforeKickoff: 2, stakeMode: 'flat', maxDailySpend: 0, restOrders: false, useKalshiOdds: true,
    });
    Object.assign(cfg.live, { mode: 'trade', maxMinutesSinceKickoff: 95, maxPickAgeSec: 300 });
    cfg.ai.precheck = 'off';
  }
  delete (cfg.risk as any).followAll;
}

export function loadConfig(): AppConfig {
  let fileCfg: Partial<AppConfig> = {};
  if (existsSync(configPath())) {
    fileCfg = JSON.parse(readFileSync(configPath(), 'utf-8'));
  }
  const cfg = merge(DEFAULT_CONFIG, fileCfg);
  // Settings saved by builds before v0.21: flat stakes, no cap per bet kind, 60% of cash in
  // open bets. Applied once to saved settings; later choices are kept.
  if (fileCfg.risk && !((fileCfg.risk as Partial<RiskConfig>).settingsRev! >= 21)) {
    Object.assign(cfg.risk, { stakeMode: 'flat', maxOpenPerBetType: 0, maxOpenExposurePct: 0.6, maxPositionPct: 0.1 });
  }
  // Builds before v0.22.2: no daily spending limit by default. Money at risk is still capped
  // by the open-bets share and your Kalshi cash.
  if (fileCfg.risk && !((fileCfg.risk as Partial<RiskConfig>).settingsRev! >= 22)) cfg.risk.maxDailySpend = 0;
  cfg.risk.settingsRev = 22;
  // v0.35: rule switches. Saved settings from before keep every rule on.
  if (fileCfg.risk && (fileCfg.risk as Partial<RiskConfig>).rulesOff === undefined) cfg.risk.rulesOff = [];
  migrateFollow(cfg);
  // v0.39: the live mode dropdown is gone; the Live switch decides buying. "Watch" becomes
  // checking live picks with the Live switch off (same behaviour). Older configs without a
  // Live switch setting keep what they had (switch on only if they were trading live).
  if (Object.keys(fileCfg).length && (fileCfg.trading as any)?.live === undefined) cfg.trading = { ...cfg.trading, live: cfg.live.mode === 'trade' };
  if (cfg.live.mode === 'watch') { cfg.live.mode = 'trade'; cfg.trading = { ...cfg.trading, live: false }; }
  // Builds before v0.23: the AI budget is capped at $0.50 a day.
  if (fileCfg.ai && !((fileCfg.ai as Partial<AiConfig>).aiRev! >= 1)) cfg.ai.dailyBudgetUsd = Math.min(cfg.ai.dailyBudgetUsd, 0.5);
  cfg.ai.aiRev = 3;
  // v0.40: Claude or ChatGPT. The provider follows the saved check model.
  if (cfg.ai.provider !== 'claude' && cfg.ai.provider !== 'chatgpt') cfg.ai.provider = cfg.ai.checkModel.startsWith('gpt') ? 'chatgpt' : 'claude';
  // v0.37: no Claude manager or reviews in the app any more; drop their old settings.
  for (const k of ['manager', 'managerEveryMin', 'managerModel', 'reviewModel', 'reviewEveryHours', 'autoApply']) delete (cfg.ai as any)[k];
  // v0.1 saved a flat 3% minimum edge. Move configs still on that old default to the
  // uncertainty-adjusted rule; anyone who chose their own number keeps it.
  if (fileCfg.risk && (fileCfg.risk as Partial<RiskConfig>).edgeUncertainty === undefined && fileCfg.risk.minEdge === 0.03) {
    cfg.risk.minEdge = DEFAULT_CONFIG.risk.minEdge;
  }
  // v0.8.0 saved real-time off by default; it's on by default now unless the user turned it off.
  if (fileCfg.pro && fileCfg.pro.realtime === false && !fileCfg.pro.chosen) cfg.pro.realtime = true;
  // Only picks PredyGo publishes are ever traded (v0.21.4): the model-only list is no longer
  // an option, so it can't be switched on by accident.
  cfg.source.includeAll = !ruleOn(cfg.risk, 'published');
  // Free has no API access: a saved Free tier falls back to Elite.
  if (cfg.source.tier === 'free') cfg.source.tier = 'elite';
  // Environment overrides (handy for testing; secrets never need to be in the file).
  if (process.env.KALSHI_API_KEY) cfg.kalshi.apiKeyId = process.env.KALSHI_API_KEY;
  if (process.env.KALSHI_PRIVATE_KEY_FILE) cfg.kalshi.privateKeyPath = process.env.KALSHI_PRIVATE_KEY_FILE;
  if ((process.env.KALSHI_ENV === 'prod' || process.env.KALSHI_ENV === 'demo') && process.env.KALSHI_ENV !== cfg.kalshi.env) {
    console.warn(`Note: KALSHI_ENV=${process.env.KALSHI_ENV} overrides config (${cfg.kalshi.env}).`);
    cfg.kalshi.env = process.env.KALSHI_ENV;
  }
  if (process.env.PREDYGO_FEED_TOKEN) cfg.source.token = process.env.PREDYGO_FEED_TOKEN;
  return cfg;
}

/**
 * The settings the engine actually trades with: rules switched off are opened up and the
 * Live switch is applied. The saved settings are untouched, so switching a rule back on
 * brings its value back.
 */
export function effectiveConfig(cfg: AppConfig): AppConfig {
  return liveSwitch(ruleSwitches(cfg));
}

/** The Live switch off: live picks are still checked and shown (watch) but never bought. */
function liveSwitch(cfg: AppConfig): AppConfig {
  if (cfg.trading?.live !== false || cfg.live.mode !== 'trade') return cfg;
  const c = structuredClone(cfg);
  c.live.mode = 'watch';
  return c;
}


/** The Pre-game switch (missing = on). */
export const pregameOn = (cfg: Pick<AppConfig, 'trading'>): boolean => cfg.trading?.pregame !== false;

/** What's left of today's spending limit (Infinity when there's no daily limit). */
export function dailyLeft(risk: Pick<RiskConfig, 'maxDailySpend'>, spent: number): number {
  return risk.maxDailySpend > 0 ? Math.max(0, risk.maxDailySpend - spent) : Infinity;
}

/** The three dollar limits worked out from the balance (see RiskConfig.autoSize). */
export function autoLimits(risk: Pick<RiskConfig, 'maxPositionPct' | 'maxOpenExposurePct'>, bankroll: number) {
  // $5 or 5% of cash, whichever is more, but never over the max share of cash per trade.
  const perTrade = Math.max(1, Math.floor(Math.min(bankroll * risk.maxPositionPct, Math.max(5, bankroll * 0.05)) * 2) / 2);
  const atRisk = Math.max(perTrade, Math.floor(bankroll * (risk.maxOpenExposurePct ?? 0.3) * 2) / 2);
  // A count would only get in the way: money at risk is the limit ($1 minimum per bet).
  const maxOpenPositions = Math.max(1, Math.min(50, Math.floor(atRisk)));
  return { maxNotionalPerOrder: perTrade, maxOpenPositions, maxDailySpend: 0 };
}

/** Apply autoLimits when autoSize is on; true if anything changed. */
export function applyAutoSize(cfg: AppConfig, bankroll: number): boolean {
  if (cfg.risk.autoSize === false || !(bankroll > 0)) return false;
  const a = autoLimits(cfg.risk, bankroll);
  const changed = a.maxNotionalPerOrder !== cfg.risk.maxNotionalPerOrder || a.maxOpenPositions !== cfg.risk.maxOpenPositions || a.maxDailySpend !== cfg.risk.maxDailySpend;
  Object.assign(cfg.risk, a);
  return changed;
}

/**
 * Save settings (config.json). Never anything secret: keys and tokens live only in the
 * encrypted vault (or come from environment variables), so they are stripped here even if a
 * copy of the config carrying them is saved by mistake.
 */
export function saveConfig(cfg: AppConfig): void {
  ensureHome();
  const c = structuredClone(cfg) as any;
  // The Kalshi Key ID is only an identifier (the private key stays in its own .pem file or the
  // vault); one that came from KALSHI_API_KEY isn't written into the file either.
  if (c.kalshi) { delete c.kalshi.privateKeyPem; if (process.env.KALSHI_API_KEY && c.kalshi.apiKeyId === process.env.KALSHI_API_KEY) delete c.kalshi.apiKeyId; }
  if (c.source) delete c.source.token;
  for (const k of Object.keys(c.ai ?? {})) if (/key|token|secret|password/i.test(k)) delete c.ai[k];
  writeFileSync(configPath(), JSON.stringify(c, null, 2), { mode: 0o600 });
}
