/**
 * "Export data": one JSON file with everything needed to review and improve the trading
 * rules later: every decision the app made (pre-game and live), every order, how each
 * market settled, Kalshi's own fills and settlements, PredyGo's graded results, and the
 * settings in force. No keys, passwords or private keys are included.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { exportsDir, ledgerPath, liveLogPath, picksLogPath, type AppConfig } from './config';
import { authed, type KalshiCredentials } from './kalshi/client';
import { getBalance, getMarket, getPositions } from './kalshi/account';
import { loadPredictions } from './predictions/sources';
import { buildCalibration } from './predictions/calibration';
import { type LiveObservation } from './live';
import { liveStagesSummary } from './predictions/calibration';
import { readJsonl, type PickLogEntry } from './trade/picklog';
import type { LedgerEntry, OrderEntry } from './trade/ledger';
import { aiLogPath } from './ai/assistant';
import { aiUsagePath } from './ai/claude';
import { journalCsv, journalRows } from './trade/journal';

export const EXPORT_FORMAT = 1;

const FIELD_NOTES = {
  purpose: 'Soccer Edge data export. Hand this file to an AI assistant (or any analyst) to review how the trading rules performed and tune them.',
  'summary': 'Totals computed at export time: orders, contracts, cost, settled results and profit/loss by source (pregame, live, forced).',
  'settings': 'App settings at export time (risk limits, minimum edge, minimum win chance, stake mode, live settings). Keys and secrets removed.',
  'calibration': 'Win-chance tables the app used: hit rate per bet type (posted and model picks) and live hit rate by minutes since kickoff.',
  'orders': 'Every order the app sent (trade log), each with the settled market result and profit/loss when known. side yes/no = contract bought; limitPrice = max price paid per contract; avgFee = fee per contract; uncertain = no reply from Kalshi.',
  'ledger': 'Raw trade log: orders, skips (with reason) and kill switch on/off.',
  'pregameDecisions': 'picks.jsonl: each pre-game pick the app priced. Logged when first seen and again when status changes, price moves 2c+, or hourly. probability = app win chance; required = edge needed; status = ready / skip reason / too small.',
  'liveDecisions': 'live.jsonl: each live pick the app checked, with Kalshi price at that moment, win chance by stage of game, edge and what it did (traded / watch / skip / old).',
  'kalshi.markets': 'Current state of every market referenced above: status, result (yes/no once settled), prices.',
  'kalshi.fills / settlements / positions / balance': "Kalshi's own records for this account (source of truth for money).",
  'predygo.graded': 'PredyGo graded picks (pick id, bet, result) to compare model hit rates with what was traded.',
  'journal': 'Trade journal: one record per trade with the settings in force when it was placed, the PredyGo pick as received, the Kalshi market at that moment (prices, size for sale, volume), the app\'s win chance and where it came from (hit-rate table row and sample size), edge vs edge needed, stake, Claude\'s verdict - plus its outcomes: decided early, Kalshi settlement with P/L, and PredyGo\'s own grading. Also saved as a CSV next to this file for spreadsheets.',
  'claude': "AI pre-trade check verdicts (Claude or ChatGPT) and what they cost.",
};

function redactedSettings(cfg: AppConfig): unknown {
  const c = structuredClone(cfg) as any;
  if (c.kalshi) { delete c.kalshi.apiKeyId; delete c.kalshi.privateKeyPath; }
  if (c.source) { delete c.source.token; delete c.source.path; }
  return c;
}

async function pages(creds: KalshiCredentials, path: string, key: string, maxPages = 10): Promise<unknown[]> {
  const out: unknown[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const r = await authed(creds, 'GET', path, { params: { limit: 200, cursor } });
    out.push(...((r?.[key] ?? []) as unknown[]));
    cursor = r?.cursor || undefined;
    if (!cursor) break;
  }
  return out;
}

async function settle<T>(p: Promise<T>): Promise<T | { error: string }> {
  try { return await p; } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
}

async function inBatches<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

export interface ExportResult { path: string; fileName: string; bytes: number; summary: unknown }

export async function buildExport(opts: { cfg: AppConfig; creds: KalshiCredentials; version: string; now?: Date }): Promise<ExportResult> {
  const now = opts.now ?? new Date();
  const env = opts.creds.env;
  const ledger = readJsonl<LedgerEntry>(ledgerPath());
  const picks = readJsonl<PickLogEntry>(picksLogPath());
  const live = readJsonl<LiveObservation>(liveLogPath());
  const orders = ledger.filter((e): e is OrderEntry => e.type === 'order' && e.env === env);

  // Every market we know about, with its settled result.
  const tickers = [...new Set([...orders.map((o) => o.ticker), ...picks.map((p) => p.ticker), ...live.map((l) => l.ticker).filter(Boolean) as string[]])].slice(0, 400);
  const marketRows = await inBatches(tickers, 6, async (t) => {
    try {
      const m: any = await getMarket(opts.creds, t);
      return [t, { status: m.status, result: m.result ?? null, yes_bid: m.yes_bid_dollars, yes_ask: m.yes_ask_dollars, last_price: m.last_price_dollars, close_time: m.close_time, title: m.title, yes_sub_title: m.yes_sub_title }] as const;
    } catch (e) {
      return [t, { error: e instanceof Error ? e.message : String(e) }] as const;
    }
  });
  const markets = Object.fromEntries(marketRows);

  // Orders with outcome and profit/loss.
  const orderRows = orders.map((o) => {
    const m: any = markets[o.ticker] ?? {};
    const filled = o.filled ?? 0;
    const cost = filled * ((o.avgPrice ?? o.limitPrice) + (o.avgFee ?? 0));
    const result: string | null = m.result === 'yes' || m.result === 'no' ? m.result : null;
    const won = result ? result === o.side : null;
    const pnl = won === null || filled === 0 ? null : +((won ? filled : 0) - cost).toFixed(2);
    const source = o.forced ? 'forced' : live.some((l) => l.id === o.predictionId && l.action === 'traded') ? 'live' : 'pregame';
    return { ...o, source, cost: +cost.toFixed(2), marketResult: result, won, pnl };
  });

  const bySource: Record<string, { orders: number; filled: number; contracts: number; cost: number; settled: number; wins: number; losses: number; pnl: number }> = {};
  for (const o of orderRows) {
    const s = (bySource[o.source] ??= { orders: 0, filled: 0, contracts: 0, cost: 0, settled: 0, wins: 0, losses: 0, pnl: 0 });
    s.orders++;
    if ((o.filled ?? 0) > 0) { s.filled++; s.contracts += o.filled ?? 0; s.cost += o.cost; }
    if (o.won !== null && (o.filled ?? 0) > 0) { s.settled++; o.won ? s.wins++ : s.losses++; s.pnl += o.pnl ?? 0; }
  }
  for (const s of Object.values(bySource)) { s.cost = +s.cost.toFixed(2); s.pnl = +s.pnl.toFixed(2); }

  const [balance, positions, fills, settlements, graded] = await Promise.all([
    settle(getBalance(opts.creds)),
    settle(getPositions(opts.creds).then((m) => Object.fromEntries(m))),
    settle(pages(opts.creds, '/portfolio/fills', 'fills')),
    settle(pages(opts.creds, '/portfolio/settlements', 'settlements')),
    settle(loadPredictions(opts.cfg.source)),
  ]);

  const gradedRows = Array.isArray(graded)
    ? graded.filter((p) => p.won != null).map((p) => ({ id: p.id, league: p.league, match: `${p.home} v ${p.away}`, bet: p.bet, kickoff: p.kickoff, source: p.source, posted: p.posted, statedPct: Number.isFinite(p.statedPct) ? p.statedPct : null, odds: p.odds ?? null, won: p.won }))
    : graded;
  const calibration = Array.isArray(graded)
    ? [...buildCalibration(graded)].map(([k, c]) => ({ key: k, graded: c.graded, wins: c.wins, probability: +c.probability.toFixed(4), stdErr: +c.stdErr.toFixed(4), source: c.source }))
    : [];

  const summary = {
    env,
    orders: orderRows.length,
    bySource,
    pregameDecisionsLogged: picks.length,
    liveDecisionsLogged: live.length,
    liveActions: live.reduce<Record<string, number>>((a, l) => ((a[l.action] = (a[l.action] ?? 0) + 1), a), {}),
  };

  const data = {
    format: EXPORT_FORMAT,
    app: 'Soccer Edge',
    version: opts.version,
    exportedAt: now.toISOString(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    notes: FIELD_NOTES,
    summary,
    settings: redactedSettings(opts.cfg),
    calibration: { betTypes: calibration, livePhases: liveStagesSummary() },
    orders: orderRows,
    ledger,
    pregameDecisions: picks,
    liveDecisions: live,
    kalshi: { balance, positions, fills, settlements, markets },
    predygo: { graded: gradedRows },
    journal: journalRows(),
    claude: {
      log: readJsonl(aiLogPath()),
      usage: readJsonl(aiUsagePath()) },
  };

  mkdirSync(exportsDir(), { recursive: true });
  const stamp = now.toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})(\d{4})$/, '$1-$2');
  const fileName = `soccer-edge-export-${stamp}.json`;
  const path = join(exportsDir(), fileName);
  const text = JSON.stringify(data, null, 1);
  writeFileSync(path, text);
  try { writeFileSync(path.replace(/\.json$/, '-journal.csv'), journalCsv()); } catch {}
  return { path, fileName, bytes: Buffer.byteLength(text), summary };
}
