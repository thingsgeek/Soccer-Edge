/**
 * Pre-game decision log (picks.jsonl): what the app saw for each pick it priced, so the
 * decisions can be graded later. One line when a pick is first priced, then again only
 * when its status changes, its price moves 2¢ or more, or an hour has passed.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { ensureHome, picksLogPath } from '../config';
import type { Proposal } from './edge';

export interface PickLogEntry {
  at: string;
  env: 'demo' | 'prod';
  id: string;
  league: string;
  match: string;
  bet: string;
  kickoff: string;
  posted?: boolean;
  source?: string;
  statedPct?: number;
  ticker: string;
  side: 'yes' | 'no';
  ask: number;
  bid: number;
  probability: number;
  probabilityStdErr?: number;
  required?: number;
  edge: number;
  contracts: number;
  status: string;
}

const last = new Map<string, { at: number; ask: number; status: string }>();
const REPEAT_MS = 3600_000;

export function logPicks(proposals: Proposal[], env: 'demo' | 'prod', now = Date.now()): number {
  let n = 0;
  const lines: string[] = [];
  for (const p of proposals) {
    const pr = p.match.prediction;
    const status = p.skip ?? (p.contracts > 0 ? 'ready' : 'too small');
    const key = `${env}|${pr.id}|${p.match.market.ticker}`;
    const prev = last.get(key);
    if (prev && prev.status === status && Math.abs(prev.ask - p.quote.ask) < 0.02 - 1e-9 && now - prev.at < REPEAT_MS) continue;
    last.set(key, { at: now, ask: p.quote.ask, status });
    const e: PickLogEntry = {
      at: new Date(now).toISOString(), env, id: pr.id, league: pr.league, match: `${pr.home} v ${pr.away}`, bet: pr.bet,
      kickoff: pr.kickoff, posted: pr.posted, source: pr.source, statedPct: Number.isFinite(pr.statedPct) ? pr.statedPct : undefined,
      ticker: p.match.market.ticker, side: p.match.side, ask: p.quote.ask, bid: p.quote.bid, probability: p.probability,
      probabilityStdErr: p.inputs?.probabilityStdErr, required: p.required, edge: +p.edge.toFixed(4), contracts: p.contracts, status,
    };
    lines.push(JSON.stringify(e));
    n++;
  }
  if (lines.length) {
    try { ensureHome(); appendFileSync(picksLogPath(), lines.join('\n') + '\n'); } catch {}
  }
  return n;
}

export function readJsonl<T = unknown>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as T]; } catch { return []; } });
}
