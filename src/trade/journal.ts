/**
 * Trade journal (journal.jsonl): the full story of every trade, for historical review.
 * Never pruned or rewritten - only appended.
 *
 *  - "entry" (when an order fills): the settings in force, the PredyGo pick exactly as
 *    received, the Kalshi market at that moment, the app's numbers (win chance and where
 *    it came from, edge, edge needed, stake) and Claude's pre-trade verdict.
 *  - "outcome" lines as they happen: decided early (goal in), settled by Kalshi
 *    (won/lost, payout, P/L), and PredyGo's own grading of the pick.
 *
 * Join entries and outcomes on `key` (the order's client id).
 */
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { appHome, ensureHome, type AppConfig } from '../config';
import { APP_VERSION } from '../version';
import type { Proposal } from './edge';
import { readJsonl } from './picklog';

export const journalPath = (): string => join(appHome(), 'journal.jsonl');

export interface JournalEntry {
  type: 'entry';
  key: string;
  at: string;
  env: 'demo' | 'prod';
  appVersion: string;
  mode: 'auto' | 'approve' | 'forced' | 'live' | 'claude';
  settings: unknown;
  predygo: Record<string, unknown>;
  kalshi: Record<string, unknown>;
  model: Record<string, unknown>;
  order: Record<string, unknown>;
  claude: { verdict: string; reason?: string } | null;
}

export interface JournalOutcome {
  type: 'outcome';
  key: string;
  at: string;
  kind: 'decided' | 'settled' | 'predygo';
  result: 'won' | 'lost' | 'sold';
  payout?: number;
  pnl?: number;
  detail?: string;
}

const n = (v: unknown) => { const x = parseFloat(String(v ?? '')); return Number.isFinite(x) ? x : null; };

/** Settings that shape a trade decision (no keys). */
export function decisionSettings(cfg: AppConfig) {
  return {
    risk: cfg.risk,
    live: cfg.live,
    calibrationMode: cfg.calibration,
    publishedPicksOnly: cfg.source?.includeAll === false,
    scanIntervalMin: cfg.scanIntervalMin,
    claudeCheck: cfg.ai?.enabled ? cfg.ai.precheck : 'off',
  };
}

export function journalEntry(args: {
  key: string; env: 'demo' | 'prod'; cfg: AppConfig; mode: JournalEntry['mode']; proposal: Proposal; market: Record<string, any>;
  count: number; limitPrice: number; filled: number; avgPrice?: number; avgFee?: number; uncertain?: boolean;
  claude: JournalEntry['claude']; liveInfo?: Record<string, unknown>; now?: Date;
}): void {
  const { proposal: p, market: m } = args;
  const pr = p.match.prediction as any;
  const e: JournalEntry = {
    type: 'entry',
    key: args.key,
    at: (args.now ?? new Date()).toISOString(),
    env: args.env,
    appVersion: APP_VERSION,
    mode: args.mode,
    settings: decisionSettings(args.cfg),
    predygo: {
      id: pr.id, league: pr.league, home: pr.home, away: pr.away, bet: pr.bet, kickoff: pr.kickoff,
      statedPct: Number.isFinite(pr.statedPct) ? pr.statedPct : null, odds: pr.odds ?? null, posted: pr.posted ?? null,
      source: pr.source ?? 'pregame', pickedAt: pr.pickedAt ?? null, postedAt: pr.postedAt ?? null,
      score: pr.score ? pr.score.join('-') : null, minute: pr.minute ?? null, canonical: pr.canonical ?? null,
    },
    kalshi: {
      ticker: m.ticker, event: p.match.event?.event_ticker ?? m.event_ticker ?? null, eventTitle: p.match.event?.title ?? null,
      title: m.title ?? null, yesSubtitle: m.yes_sub_title ?? null, sideBought: p.match.side, matchedAs: p.match.spec,
      yesAsk: n(m.yes_ask_dollars), yesBid: n(m.yes_bid_dollars), last: n(m.last_price_dollars),
      yesAskSize: n(m.yes_ask_size_fp), yesBidSize: n(m.yes_bid_size_fp), volume: n(m.volume_fp ?? m.volume), openInterest: n(m.open_interest_fp ?? m.open_interest),
      closeTime: m.close_time ?? null, occurrence: m.occurrence_datetime ?? m.expected_expiration_time ?? null,
    },
    model: {
      winChance: p.probability, winChanceSource: (p as any).calibration ?? null, blendedForEdge: p.priced ?? null,
      edge: p.edge, edgeNeeded: p.required ?? null, kelly: p.kelly, costPerContract: p.cost,
      ...(args.liveInfo ? { live: args.liveInfo } : {}),
    },
    order: {
      contracts: args.count, limitPrice: args.limitPrice, filled: args.filled, avgPrice: args.avgPrice ?? null, avgFee: args.avgFee ?? null,
      cost: +(args.filled * ((args.avgPrice ?? args.limitPrice) + (args.avgFee ?? 0))).toFixed(4),
      maxPayout: args.filled, uncertain: !!args.uncertain,
    },
    claude: args.claude,
  };
  try { ensureHome(); appendFileSync(journalPath(), JSON.stringify(e) + '\n'); } catch {}
}

export function journalOutcome(o: Omit<JournalOutcome, 'type' | 'at'> & { at?: string }): void {
  const line: JournalOutcome = { type: 'outcome', at: o.at ?? new Date().toISOString(), ...o } as JournalOutcome;
  try { ensureHome(); appendFileSync(journalPath(), JSON.stringify(line) + '\n'); } catch {}
}

export function readJournal(): (JournalEntry | JournalOutcome)[] {
  return readJsonl<JournalEntry | JournalOutcome>(journalPath());
}

/**
 * One row per trade: the entry plus its outcomes. `outcomesSeen` lets callers avoid
 * writing the same outcome twice.
 */
export function journalRows() {
  const rows = new Map<string, { entry: JournalEntry; decided?: JournalOutcome; settled?: JournalOutcome; predygo?: JournalOutcome }>();
  const lines = readJournal();
  for (const l of lines) if (l.type === 'entry') rows.set(l.key, { entry: l });
  for (const l of lines) if (l.type === 'outcome') { const r = rows.get(l.key); if (r) r[l.kind] = l; }
  return [...rows.values()];
}

/** Flat table (one line per trade) for a spreadsheet. */
export function journalCsv(): string {
  const cols = ['placed_at', 'mode', 'app_version', 'league', 'match', 'bet', 'source', 'posted', 'stated_pct', 'predygo_odds', 'live_score', 'live_minute',
    'kalshi_ticker', 'side', 'yes_ask', 'yes_bid', 'ask_size', 'win_chance', 'win_chance_from', 'graded_n', 'blended', 'edge', 'edge_needed',
    'contracts', 'price', 'cost', 'claude', 'min_edge', 'uncertainty_buffer', 'market_weight', 'max_gap', 'min_win', 'max_price', 'published_only',
    'decided', 'kalshi_result', 'pnl', 'predygo_result'];
  const esc = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const out = [cols.join(',')];
  for (const r of journalRows()) {
    const e = r.entry as any;
    const s = e.settings ?? {}; const risk = s.risk ?? {};
    const src = e.model?.winChanceSource ?? {};
    out.push([
      e.at, e.mode, e.appVersion, e.predygo.league, `${e.predygo.home} v ${e.predygo.away}`, e.predygo.bet, e.predygo.source, e.predygo.posted, e.predygo.statedPct, e.predygo.odds,
      e.predygo.score, e.predygo.minute, e.kalshi.ticker, e.kalshi.sideBought, e.kalshi.yesAsk, e.kalshi.yesBid, e.kalshi.sideBought === 'yes' ? e.kalshi.yesAskSize : e.kalshi.yesBidSize,
      e.model.winChance, src.key ?? (e.model.live ? 'live stage' : ''), src.graded ?? '', e.model.blendedForEdge, e.model.edge, e.model.edgeNeeded,
      e.order.filled, e.order.avgPrice ?? e.order.limitPrice, e.order.cost, e.claude ? e.claude.verdict : '', risk.minEdge, risk.edgeUncertainty, risk.marketWeight,
      risk.maxGapToMarket, risk.minWinProfit, risk.maxPrice, s.publishedPicksOnly,
      r.decided?.result ?? '', r.settled?.result ?? '', r.settled?.pnl ?? '', r.predygo?.result ?? '',
    ].map(esc).join(','));
  }
  return out.join('\n') + '\n';
}

/**
 * Trades placed before the journal existed: rebuild what we can from the trade log and
 * the decision logs (picks.jsonl / live.jsonl). Marked reconstructed; settings unknown.
 * Runs once (only when the journal has no entry for an order).
 */
export function backfillJournal(ledger: any[], picks: any[], live: any[]): number {
  const have = new Set(readJournal().filter((l) => l.type === 'entry').map((l) => l.key));
  let n = 0;
  for (const o of ledger) {
    if (o.type !== 'order' || !(o.filled > 0 || o.uncertain) || have.has(o.clientOrderId)) continue;
    const t = Date.parse(o.at);
    const before = (x: any) => x.ticker === o.ticker && Date.parse(x.at) <= t + 60_000;
    const d = [...picks].reverse().find(before);
    const l = [...live].reverse().find((x: any) => before(x) && x.action === 'traded') ?? [...live].reverse().find(before);
    const src = l && (!d || Date.parse(l.at) > Date.parse(d.at)) ? l : d;
    const filled = o.filled ?? o.count;
    const price = o.avgPrice ?? o.limitPrice;
    const line = {
      type: 'entry', key: o.clientOrderId, at: o.at, env: o.env, appVersion: 'before 0.16.0', reconstructed: true,
      mode: o.forced ? 'forced' : l && src === l ? 'live' : 'auto',
      settings: null,
      predygo: { id: o.predictionId, league: src?.league ?? o.league ?? null, home: (src?.match ?? o.match ?? '').split(' v ')[0] || null, away: (src?.match ?? o.match ?? '').split(' v ')[1] || null,
        bet: src?.bet ?? o.bet ?? null, kickoff: src?.kickoff ?? null, statedPct: src?.statedPct ?? null, odds: src?.odds ?? null, posted: src?.posted ?? null,
        source: src === l ? 'live' : 'pregame', score: src?.score ?? null, minute: src?.minute ?? null },
      kalshi: { ticker: o.ticker, sideBought: o.side, yesAsk: src?.ask ?? null, yesBid: src?.bid ?? null },
      model: { winChance: o.probability ?? src?.probability ?? null, edge: o.edge ?? src?.edge ?? null, edgeNeeded: src?.required ?? null,
        ...(src === l ? { live: { sinceKickoffMin: l.sinceKickoffMin ?? null } } : {}) },
      order: { contracts: o.count, limitPrice: o.limitPrice, filled, avgPrice: o.avgPrice ?? null, avgFee: o.avgFee ?? null,
        cost: +(filled * (price + (o.avgFee ?? 0))).toFixed(4), maxPayout: filled, uncertain: !!o.uncertain },
      claude: null,
    };
    try { ensureHome(); appendFileSync(journalPath(), JSON.stringify(line) + '\n'); n++; } catch {}
  }
  return n;
}
