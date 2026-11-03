/**
 * Every rule that can stop a pick from being bought, in one place: what it does, the setting
 * behind it, its value now, and its on/off switch. The app shows this as
 * "Rules in force"; a test fails if a skip reason appears in the code that no rule here explains,
 * so the list can't fall behind the code.
 */
import { DEFAULT_CONFIG, ruleOn, type AppConfig } from '../config';

export type Stage = 'Feed' | 'Matching' | 'Win chance' | 'Price & edge' | 'Order' | 'Live picks' | 'Waiting orders' | 'Safety';

export interface Rule {
  id: string;
  stage: Stage;
  name: string;
  /** What it does, in plain words. */
  what: string;
  /** Current value, from the settings in force. */
  value?: (cfg: AppConfig) => string;
  /** Off because of a setting. */
  offWhen?: (cfg: AppConfig) => boolean;
  /** Skip reasons this rule produces (matched against the app's messages). */
  match: RegExp[];
  /** Why this rule can't be switched off (there would be nothing real to buy). */
  required?: string;
}

/** Rules whose switch is an existing setting (the rest use risk.rulesOff). */
export const MAPPED: Record<string, { on: (k: AppConfig) => boolean }> = {
  block25: { on: (k) => k.risk.blockOver25 !== false },
  blockBtts: { on: (k) => k.risk.blockBtts !== false },
  stated: { on: (k) => !!k.risk.requireStatedAboveCost },
  highRisk: { on: (k) => !k.risk.tradeHighRisk },
  rest: { on: (k) => k.risk.restOrders !== false },
  kalshiOdds: { on: (k) => k.risk.useKalshiOdds !== false },
  claude: { on: (k) => k.ai.enabled !== false && k.ai.precheck !== 'off' },
  liveMode: { on: (k) => k.live.mode !== 'off' },
  liveSwitch: { on: (k) => k.live.mode === 'trade' && k.trading?.live !== false },
  pregameSwitch: { on: (k) => k.trading?.pregame !== false },
};

/**
 * The values behind each rule, editable in the Rules panel next to its switch. `path` is where
 * the value lives in the settings; numbers are shown as `stored × scale` in `unit`.
 */
export interface RuleField {
  path: string; label: string; unit: string;
  kind: 'number' | 'choice';
  scale?: number; min?: number; max?: number; step?: number;
  choices?: { value: string; label: string }[];
}
const num = (path: string, label: string, unit: string, min: number, max: number, step: number, scale = 1): RuleField => ({ path, label, unit, kind: 'number', min, max, step, scale });
export const RULE_FIELDS: Record<string, RuleField[]> = {
  minProb: [num('risk.minProbability', 'Minimum', '%', 0, 99, 1, 100)],
  edge: [num('risk.minEdge', 'Base minimum', '%', 0, 50, 0.5, 100), num('risk.edgeUncertainty', 'Uncertainty buffer', '×', 0, 5, 0.1)],
  lean: [num('risk.marketWeight', 'Market share', '%', 0, 100, 5, 100)],
  gap: [num('risk.maxGapToMarket', 'Max gap', 'pts', 0, 100, 1, 100)],
  maxPrice: [num('risk.maxPrice', 'Max price', '¢', 1, 99, 1, 100)],
  spread: [num('risk.maxSpreadCents', 'Max spread', '¢', 1, 99, 1)],
  minWin: [num('risk.minWinProfit', 'Minimum win', '$', 0, 100, 0.25)],
  stake: [
    { path: 'risk.stakeMode', label: 'Stake', unit: '', kind: 'choice', choices: [{ value: 'flat', label: 'Flat' }, { value: 'kelly', label: 'Kelly' }] },
    num('risk.kellyMultiplier', 'Kelly fraction', '×', 0.05, 1, 0.05),
  ],
  kickoff: [num('risk.minMinutesBeforeKickoff', 'Stop before kickoff', 'min', 0, 1440, 1)],
  perTrade: [num('risk.maxNotionalPerOrder', 'Per order', '$', 1, 100_000, 1), num('risk.maxPositionPct', 'Max share of cash', '%', 1, 100, 1, 100), num('risk.maxContractsPerOrder', 'Max contracts', '', 1, 100_000, 1)],
  daily: [num('risk.maxDailySpend', 'Per day (0 = none)', '$', 0, 1_000_000, 5)],
  exposure: [num('risk.maxOpenExposurePct', 'Share of balance', '%', 1, 100, 5, 100)],
  openCount: [num('risk.maxOpenPositions', 'Open positions', '', 1, 1000, 1)],
  perKind: [num('risk.maxOpenPerBetType', 'Per kind (0 = none)', '', 0, 1000, 1)],
  claude: [{ path: 'ai.precheck', label: 'When on', unit: '', kind: 'choice', choices: [{ value: 'veto', label: 'Can stop it' }, { value: 'advise', label: 'Log only' }] }],
  liveMinute: [num('live.maxMinutesSinceKickoff', 'Latest', 'min', 1, 150, 1)],
  liveAge: [num('live.maxPickAgeSec', 'Max age', 's', 10, 3600, 10)],
  liveJump: [num('live.maxPriceJump', 'Jump', 'pts', 1, 100, 1, 100)],
};
/** Fields set from the balance while "Size limits from my balance" is on. */
export const AUTO_SIZED = ['risk.maxNotionalPerOrder', 'risk.maxOpenPositions', 'risk.maxDailySpend'];

export function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<any>((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}
export function setPath(obj: any, path: string, v: unknown): void {
  const parts = path.split('.');
  let o = obj;
  for (const p of parts.slice(0, -1)) o = o[p] ??= {};
  o[parts[parts.length - 1]!] = v;
}

/**
 * Check a value typed in the Rules panel (in shown units) and turn it into the stored value.
 * Throws with a plain message if it's out of range.
 */
export function ruleFieldValue(f: RuleField, raw: unknown): number | string {
  if (f.kind === 'choice') {
    const v = String(raw);
    if (!f.choices!.some((c) => c.value === v)) throw new Error(`${f.label}: choose ${f.choices!.map((c) => c.label).join(' or ')}.`);
    return v;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < f.min! || n > f.max!) throw new Error(`${f.label} must be ${f.min}-${f.max}${f.unit ? ' ' + f.unit : ''}.`);
  return +(n / (f.scale ?? 1)).toFixed(6);
}

const NO_MARKET = 'Always on: without it there is no Kalshi market to buy.';
const REQUIRED: Record<string, string> = {
  betType: NO_MARKET, league: NO_MARKET, marketType: NO_MARKET, game: NO_MARKET, line: NO_MARKET,
  active: 'Always on: Kalshi refuses orders on closed, settled or paused markets.',
  livePickPre: 'Always on: in-play picks are priced by the live engine; the pre-game scan has no live price for them.',
  graded: 'Always on: a graded pick is a finished game, so there is nothing left to buy.',
  error: 'Always on: a pick that hit an error has no price to buy at.',
};

const c = (v: number) => `${Math.round(v * 100)}¢`;
const pc = (v: number) => `${+(v * 100).toFixed(1)}%`;

export const RULES: Rule[] = [
  // ---------------------------------------------------------------- Feed
  { id: 'published', stage: 'Feed', name: 'Published picks only', what: 'Only picks PredyGo published to its tiers are considered (never the full model list).', value: () => 'always on', match: [] },
  { id: 'tier', stage: 'Feed', name: 'PredyGo tier', what: 'Only picks sent to the tier set in Settings (admin = all tiers; Elite includes Pro and Free).', value: (k) => k.source.tier ?? 'elite', match: [] },
  { id: 'horizon', stage: 'Feed', name: 'Look-ahead window', what: 'Pre-game picks are scanned up to 72 hours before kickoff; later ones are picked up as they come into range.', value: () => '72 h', match: [/will be checked later/] },
  { id: 'stale', stage: 'Feed', name: 'Finished games ignored', what: 'Picks for games that finished hours or days ago but are still listed in the feed are ignored.', value: () => 'always on', match: [] },
  { id: 'graded', stage: 'Feed', name: 'Graded picks ignored', what: 'Picks that already have a result are history, not bets.', value: () => 'always on', match: [/Graded result/] },

  // ---------------------------------------------------------------- Matching
  { id: 'betType', stage: 'Matching', name: 'Bet type Kalshi can settle', what: 'The bet code must map to a Kalshi contract that settles the same way (totals, team goals, BTTS, double chance).', value: () => 'always on', match: [/unsupported_bet/, /isn't on Kalshi/, /code and (market )?definition disagree/, /has no Kalshi equivalent/] },
  { id: 'league', stage: 'Matching', name: 'League on Kalshi', what: 'The league must be one Kalshi lists (mapped in leagues.json, or found by searching Kalshi for the same two teams on the same date).', value: () => 'always on', match: [/league_not_on_kalshi/, /not on Kalshi/, /league not mapped to Kalshi/] },
  { id: 'marketType', stage: 'Matching', name: 'Market type offered', what: 'Kalshi must offer that market for the league (e.g. team-goals markets exist for only ~19 competitions).', value: () => 'always on', match: [/market_type_not_offered/, /doesn't list/, /no markets of this type/] },
  { id: 'game', stage: 'Matching', name: 'Same game found', what: 'Both teams and the date must match one Kalshi game (two possible games = skipped).', value: () => 'always on', match: [/no_event/, /ambiguous_event/, /Game not found/, /matched two/, /no Kalshi market for this match/, /matched more than one game/] },
  { id: 'line', stage: 'Matching', name: 'Same line found', what: 'The exact line (e.g. over 1.5) must exist in that game.', value: () => 'always on', match: [/no_market/, /not this line/] },
  { id: 'active', stage: 'Matching', name: 'Market open for trading', what: 'Closed, settled or paused markets are skipped (the game is decided or over).', value: () => 'always on', match: [/market_not_active/, /^market is /, /Contract is /, /already decided on Kalshi/, /^market \S+ on Kalshi/] },
  { id: 'livePickPre', stage: 'Matching', name: 'Live picks go to the live engine', what: 'In-play picks are handled by Live picks, not by the pre-game scan.', value: () => 'always on', match: [/live_pick/, /In-play pick/, /in-play pick \(not traded\)/] },

  // ---------------------------------------------------------------- Win chance
  { id: 'hitRate', stage: 'Win chance', name: 'Needs 30 graded results', what: "On: a bet type is only traded once it has 30+ graded results to take its real hit rate from. Off: bet types with fewer use PredyGo's stated confidence instead, so they can trade too. (Where the win chance comes from is set in Settings.)", value: () => '30 graded minimum', match: [/^only \S+ graded/, /no track record for/, /no stated confidence/] },
  { id: 'minProb', stage: 'Win chance', name: 'Minimum win chance', what: 'Skip picks whose win chance (or PredyGo confidence) is below this.', value: (k) => pc(k.risk.minProbability ?? 0), match: [/^win chance .*minimum/, /^PredyGo confidence .*minimum/] },
  { id: 'block25', stage: 'Win chance', name: 'Block Over 2.5 goals', what: 'Over 2.5 goals picks are skipped by default; untick to trade them. Check the hit rates in Diagnostics and decide for yourself.', value: (k) => (k.risk.blockOver25 !== false ? 'blocked' : 'allowed'), offWhen: (k) => k.risk.blockOver25 === false, match: [/Over 2\.5 goals picks are turned off/] },
  { id: 'blockBtts', stage: 'Win chance', name: 'Block BTTS', what: 'Both-teams-to-score picks are skipped by default; untick to trade them. Check the hit rates in Diagnostics and decide for yourself.', value: (k) => (k.risk.blockBtts !== false ? 'blocked' : 'allowed'), offWhen: (k) => k.risk.blockBtts === false, match: [/BTTS picks are turned off/] },
  { id: 'pause', stage: 'Win chance', name: 'Paused bet types / leagues', what: 'Bet types or leagues paused until a time.', value: (k) => `${(k.risk.paused ?? []).filter((p) => Date.parse(p.until) > Date.now()).length} active`, match: [/paused by/] },

  // ---------------------------------------------------------------- Price & edge
  { id: 'edge', stage: 'Price & edge', name: 'Edge needed', what: 'Win chance (leaned toward the market) minus price and fee must beat: base minimum + uncertainty buffer × how unsure the hit rate is.', value: (k) => `${pc(k.risk.minEdge)} + ${k.risk.edgeUncertainty ?? 0}× uncertainty`, match: [/^edge .*needed/, /fee rounding leaves too little edge/] },
  { id: 'lean', stage: 'Price & edge', name: 'Lean toward market price', what: "Part of the win chance comes from Kalshi's own price, so a cheap price on a weak team doesn't look like a big edge.", value: (k) => pc(k.risk.marketWeight ?? 0), match: [] },
  { id: 'gap', stage: 'Price & edge', name: 'Max gap to market', what: "Skip when the win chance is far above Kalshi's price (the market probably knows something: injury, lineup).", value: (k) => (k.risk.maxGapToMarket ? `${Math.round(k.risk.maxGapToMarket * 100)} pts` : 'off'), match: [/^market disagrees/, /^feed odds disagree/] },
  { id: 'stated', stage: 'Price & edge', name: 'Stated confidence above price', what: "PredyGo's own confidence must also beat the price.", value: (k) => (k.risk.requireStatedAboveCost ? 'on' : 'off'), offWhen: (k) => !k.risk.requireStatedAboveCost, match: [/^stated .*below price/] },
  { id: 'maxPrice', stage: 'Price & edge', name: 'Never pay more than', what: 'No buys above this price (default 96¢: at 97¢+ there is nothing left to win).', value: (k) => c(k.risk.maxPrice ?? 1), match: [/^price \S+ > \S+ max/] },
  { id: 'highRisk', stage: 'Feed', name: 'PredyGo high-risk picks', what: 'PredyGo "HIGH RISK / HIGH REWARD" late-game live plays (not graded, not in its record). Skipped unless the High-risk picks switch is on.', value: (k) => (k.risk.tradeHighRisk ? 'bought' : 'skipped'), match: [/^high-risk pick/] },
  { id: 'lost', stage: 'Price & edge', name: 'As good as lost', what: 'No buys at 3¢ or less (the market says the bet has all but lost).', value: () => '3¢', match: [/as good as lost/] },
  { id: 'spread', stage: 'Price & edge', name: 'Max bid/ask spread', what: 'Skip markets whose buy and sell prices are too far apart (thin, easy to overpay).', value: (k) => `${k.risk.maxSpreadCents}¢`, match: [/^spread .* > /] },
  { id: 'minWin', stage: 'Price & edge', name: 'Minimum win per trade', what: 'A trade must stand to win at least this much after the fee (bets are raised to reach it when limits allow).', value: (k) => `$${(k.risk.minWinProfit ?? 0).toFixed(2)}`, match: [/^would win only/] },
  { id: 'stake', stage: 'Price & edge', name: 'Stake size', what: 'Flat = the full per-trade amount; Kelly = bigger edge, bigger bet.', value: (k) => k.risk.stakeMode, match: [/stake too small/, /^too small$/] },

  // ---------------------------------------------------------------- Order
  { id: 'kickoff', stage: 'Order', name: 'Minutes before kickoff', what: 'No pre-game buy this close to kickoff (default 2 min); never after kickoff.', value: (k) => `${k.risk.minMinutesBeforeKickoff} min`, match: [/^kickoff in /, /match already started/, /Already kicked off/] },
  { id: 'kickoffMatch', stage: 'Order', name: 'Kickoff matches Kalshi', what: "PredyGo's kickoff must agree with Kalshi's schedule within 45 minutes (else it may be the wrong game).", value: () => 'always on', match: [/kickoff time disagrees/] },
  { id: 'perTrade', stage: 'Order', name: 'Per-trade limit', what: 'Most dollars in one order (and at most this share of cash).', value: (k) => `$${k.risk.maxNotionalPerOrder} · ${Math.round(k.risk.maxPositionPct * 100)}% of cash`, match: [] },
  { id: 'daily', stage: 'Order', name: 'Daily limit', what: 'Most spent in a day (0 = no daily limit).', value: (k) => (k.risk.maxDailySpend > 0 ? `$${k.risk.maxDailySpend}` : 'none'), offWhen: (k) => !(k.risk.maxDailySpend > 0), match: [/daily spend cap/] },
  { id: 'exposure', stage: 'Order', name: 'Max open bets (% of balance)', what: 'Money in open bets and waiting orders stays under this share of your balance (default 100%: your cash is the limit).', value: (k) => pc(k.risk.maxOpenExposurePct), match: [/^open bets already/] },
  { id: 'openCount', stage: 'Order', name: 'Max open positions', what: 'Most open bets at once.', value: (k) => String(k.risk.maxOpenPositions), match: [/open-position cap/] },
  { id: 'onePerMatch', stage: 'Order', name: 'One bet per game', what: 'On by default (live picks included): one bet per game, counting bets already won, lost or sold on it.', value: () => 'on', match: [/already have a bet on this match/] },
  { id: 'perKind', stage: 'Order', name: 'Max open bets of one kind', what: 'At most this many open bets of the same kind (0 = no limit).', value: (k) => (k.risk.maxOpenPerBetType ? String(k.risk.maxOpenPerBetType) : 'no limit'), offWhen: (k) => !k.risk.maxOpenPerBetType, match: [/open bets of this kind/] },
  { id: 'noDouble', stage: 'Order', name: 'No doubling up', what: 'A pick or market already bought (or with a waiting order) is not bought again; a sliver under one contract does not count.', value: () => 'always on', match: [/another pick already maps/, /already traded this prediction/, /already bought this market/, /already hold a position/, /^traded$/, /^holding$/, /^waiting$/] },
  { id: 'freshPrice', stage: 'Order', name: 'Price checked at order time', what: 'Every order re-reads the live price and balance first; if the pick no longer passes at that price it is skipped. Buys are all-or-nothing (no slivers).', value: () => 'always on', match: [/^at the live price/, /no price on Kalshi right now/, /only .* contract\(s\) for sale/, /order not filled/] },
  { id: 'approved', stage: 'Order', name: 'Never above the price you approved', what: 'A pick you placed by hand is never bought above the price you saw.', value: () => 'always on', match: [/^price rose to/, /declined by user/] },
  { id: 'claude', stage: 'Order', name: 'AI pre-trade check', what: 'The AI assistant (Claude or ChatGPT, whichever is chosen in the AI assistant panel) checks each order matches the pick (right game, line, side) and can stop it.', value: (k) => (k.ai.enabled ? k.ai.precheck : 'off'), offWhen: (k) => !k.ai.enabled || k.ai.precheck === 'off', match: [/^AI check/, /^Claude check/] },

  // ---------------------------------------------------------------- Live picks
  { id: 'liveMode', stage: 'Live picks', name: 'Check live picks', what: "On (default): live picks are found, priced and shown. Whether they are bought is the Live switch in the top bar; with it off you can still click Buy. Off: live picks are ignored.", value: (k) => (k.live.mode !== 'off' ? 'on' : 'off'), match: [] },
  { id: 'minute80', stage: 'Live picks', name: 'No buys from the 80th minute', what: 'On by default (manual buys included): nothing is bought at or after the 80th minute of play (the match minute from PredyGo, or 95 min after kickoff by the clock).', value: () => 'always on', match: [/^minute \d+: no buys/] },
  { id: 'liveMinute', stage: 'Live picks', name: 'Latest pick (minutes after kickoff)', what: 'Live picks later than this in the game are skipped (default 95).', value: (k) => `${k.live.maxMinutesSinceKickoff} min`, match: [/min after kickoff \(limit/] },
  { id: 'liveAge', stage: 'Live picks', name: 'Live pick max age', what: 'A live pick must be priced within this many seconds of appearing (default 300).', value: (k) => `${k.live.maxPickAgeSec} s`, match: [/live pick too old/, /too old by the time/, /already open when the app started/] },
  { id: 'liveRecord', stage: 'Live picks', name: 'Live track record', what: 'Live picks are only traded for over-goals bets that need one more goal (what the live record covers).', value: () => 'on', match: [/no live track record/, /^needs \S+ more goals/] },
  { id: 'liveWon', stage: 'Live picks', name: 'Already won on the score', what: 'A live over-goals pick whose line is already passed on the score shown is skipped (nothing left to win).', value: () => 'always on', match: [/already won on the score shown/] },
  { id: 'liveJump', stage: 'Live picks', name: 'Price-jump check', what: "Without a live score, skip when Kalshi's price jumped in the last 10 minutes (a goal probably just went in) or is far below the one-goal rate.", value: (k) => `${Math.round(k.live.maxPriceJump * 100)} pts`, match: [/no score in the feed/, /no score or odds in the feed/, /far (above|below) the pick's odds/] },

  // ---------------------------------------------------------------- Waiting orders
  { id: 'rest', stage: 'Waiting orders', name: 'Buy at my price', what: 'When the ask is too high, a buy order waits on the book at the most the pick is worth until the kickoff cutoff; repriced if outbid, cancelled if the pick changes.', value: (k) => (k.risk.restOrders !== false ? 'on' : 'off'), offWhen: (k) => k.risk.restOrders === false, match: [/resting order re-placed/, /no lower price is worth a resting order/] },
  { id: 'kalshiOdds', stage: 'Live picks', name: 'Use Kalshi odds over feed odds', what: "On: picks are judged on Kalshi's live price instead of the odds in the feed, so more picks can trade (including live picks already in play when the app starts, and ones re-checked after a price skip); a price jump on Kalshi still stops a pick. Off: the feed's odds are used and can block a trade, and live picks already open at start are skipped.", value: (k) => (k.risk.useKalshiOdds !== false ? 'on' : 'off'), offWhen: (k) => k.risk.useKalshiOdds === false, match: [] },

  // ---------------------------------------------------------------- Safety
  { id: 'pregameSwitch', stage: 'Safety', name: 'Pre-game switch', what: 'Top-bar switch: off = no automatic pre-game buys and waiting pre-game orders cancelled; you can still place a pre-game pick by hand.', value: (k) => (k.trading?.pregame !== false ? 'on' : 'off'), offWhen: (k) => k.trading?.pregame === false, match: [/^pre-game trading is off/] },
  { id: 'liveSwitch', stage: 'Safety', name: 'Live switch', what: 'Top-bar switch: on = live picks that pass the rules are bought automatically; off (default) = they are checked and shown, and bought only when you click Buy.', value: (k) => (k.live.mode === 'trade' ? 'on' : 'off'), offWhen: (k) => k.live.mode !== 'trade', match: [/would buy \(Live switch off\)/] },
  { id: 'kill', stage: 'Safety', name: 'Kill switch', what: 'Stops all buying and cancels waiting orders until you turn it off.', value: () => 'manual', match: [/kill switch is on/] },
  { id: 'region', stage: 'Safety', name: 'Region allowed', what: 'Kalshi must be allowed where you trade from.', value: (k) => [k.state, k.country].filter(Boolean).join(', ') || 'not set', match: [] },
  { id: 'kalshiErr', stage: 'Safety', name: 'Kalshi refused / no reply', what: 'If Kalshi refuses an order for account reasons, or does not answer, trading stops for that run.', value: () => 'always on', match: [/^Kalshi refused the order/, /^No reply from Kalshi/] },
  { id: 'error', stage: 'Safety', name: 'Errors', what: 'A pick that hits an unexpected error is skipped and checked again later.', value: () => 'always on', match: [/^error: /] },
];

export interface RuleView {
  id: string; stage: Stage; name: string; what: string; value: string;
  status: 'on' | 'off' | 'switched off';
  /** The switch: is the rule switched on? */
  on: boolean;
  /** Why the switch can't be used (required rule). */
  locked: string | null;
  /** Editable values behind the rule (saved settings, in shown units). */
  fields: (RuleField & { value: number | string; def: number | string; auto?: boolean })[];
}

/** Is the rule's switch on (saved settings; kill switch passed in since it's a file)? */
export function ruleSwitchOn(r: Rule, saved: AppConfig, killOn = false): boolean {
  if (r.id === 'kill') return killOn;
  if (REQUIRED[r.id]) return true;
  return MAPPED[r.id] ? MAPPED[r.id]!.on(saved) : ruleOn(saved.risk, r.id);
}

/** The rules with values, switch positions and status as they stand. */
export function rulesView(saved: AppConfig, inForce: AppConfig, killOn = false): RuleView[] {
  return RULES.map((r) => {
    const on = ruleSwitchOn(r, saved, killOn);
    return {
      id: r.id, stage: r.stage, name: r.name, what: r.what,
      // A switched-off rule shows the value it will use when switched back on.
      value: r.value ? r.value(!on ? saved : inForce) : '',
      on,
      locked: REQUIRED[r.id] ?? null,
      fields: (RULE_FIELDS[r.id] ?? []).map((f) => {
        const shown = (v: unknown) => (f.kind === 'number' ? +((Number(v) || 0) * (f.scale ?? 1)).toFixed(4) : String(v ?? ''));
        return { ...f, value: shown(getPath(saved, f.path)), def: shown(getPath(DEFAULT_CONFIG, f.path)), auto: saved.risk.autoSize !== false && AUTO_SIZED.includes(f.path) || undefined };
      }),
      status: r.id === 'kill' ? (killOn ? 'on' : 'off')
        : !on ? (MAPPED[r.id] ? 'off' : 'switched off')
        : r.offWhen?.(saved) ? 'off' : 'on',
    };
  });
}

export const isRequired = (id: string) => !!REQUIRED[id];

/** The rule that explains a skip reason, if any. */
export function ruleFor(reason: string): Rule | undefined {
  return RULES.find((r) => r.match.some((m) => m.test(reason)));
}
