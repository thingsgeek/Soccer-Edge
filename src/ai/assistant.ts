/**
 * AI in the loop: the pre-trade check (cheap model, Claude or ChatGPT). Just before an order is sent, the AI
 * looks at the pick, the exact Kalshi contract, the price and the app's win-chance estimate,
 * and answers ok / caution / block. In "can stop it" mode a "block" stops that trade. The AI
 * can only stop trades, never start one or make one bigger. Off by default.
 */
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { appHome, ensureHome, type AppConfig } from '../config';
import type { Proposal } from '../trade/edge';
import { callAI, ClaudeError, type ClaudeCall } from './claude';

export const aiLogPath = (): string => join(appHome(), 'ai.jsonl');

const ISSUE_TYPES = ['bad_data', 'naming', 'mapping', 'timing', 'grading', 'pricing', 'calibration', 'other'] as const;

function append(path: string, obj: unknown) {
  try { ensureHome(); appendFileSync(path, JSON.stringify(obj) + '\n'); } catch {}
}

/**
 * Settled facts Claude keeps re-reporting. Passed with every check so it doesn't
 * flag them again.
 */
export const SETTLED_FACTS = [
  'edgeAfterFees = blended win chance (70% PredyGo hit rate + 30% Kalshi mid price, setting marketWeight) minus cost incl. fees. It is intentionally lower than appWinProbability minus cost.',
  'Kalshi often shortens a club to its city or adds the city (NAC Breda = "Breda", Libertad FC of Ecuador = "Libertad Loja"); the app matches both teams, the league and the date, so these are the correct matches.',
  'PredyGo retired "VISITA MARCA REG" on Oct 16; old orders still show it. It is the same bet as VISITA MARCA and is counted with it.',
  'Some early orders have no match/bet fields; the contract title identifies them.',
  'Picks whose win chance is more than maxGapToMarket above the Kalshi price or the feed odds are already skipped (e.g. Helmond v NAC 1X).',
  'A kickoff that disagrees with Kalshi\'s schedule by more than 45 min is skipped on purpose; report the specific games only if it looks systematic for a league.',
  'Leagues Kalshi does not list, or markets Kalshi does not offer, cannot be traded (checked Oct 16: Kalshi has no Lithuania, Slovenia 2. SNL, Tanzania or Azerbaijan soccer); mention only new, high-volume ones.',
  'Bet codes: T+1.5 / T+2.5 / T+3.5 and TOTALGOALS+2.5 = total goals in the match by both teams over the line (Kalshi "Total Goals" markets, the correct match). LOCAL MARCA / VISITA MARCA = home / away team scores at least once (Kalshi team-total over 0.5). 1X = away team does not win (NO on the away-win contract). BTTS = both teams score.',
  'Live picks without a score in the feed are only traded when the feed gives odds to check the price against; a missing live score is a known PredyGo feed gap, not a mapping error.',
  'Win chance comes from each bet type\'s real graded hit rate, not PredyGo\'s stated confidence. A gap between stated confidence and win chance is expected, not a problem to report.',
  'Buy at my price: when the ask is too high, the app leaves a buy order at the most the pick is worth (best bid + 1c, capped), until minMinutesBeforeKickoff; "waited at our price" trades are those.',
  'Live picks are always "one more goal" picks (T+0.5 at 0-0, T+1.5 at 1 goal, T+2.5 at 2 goals), so the same stage rate applies to every line; picks priced far below it are skipped.',
  'Live pick win chances come from the graded live record by stage of the game (later stages win less often), or PredyGo\'s stated confidence until there is a record.',
];

// ------------------------------------------------------------ 1. pre-trade check

export interface PrecheckResult { verdict: 'ok' | 'caution' | 'block'; reason: string; issues: { type: string; detail: string }[] }

const PRECHECK_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['ok', 'caution', 'block'] },
    reason: { type: 'string' },
    issues: {
      type: 'array',
      items: { type: 'object', properties: { type: { type: 'string', enum: [...ISSUE_TYPES] }, detail: { type: 'string' } }, required: ['type', 'detail'], additionalProperties: false },
    },
  },
  required: ['verdict', 'reason', 'issues'],
  additionalProperties: false,
};

const PRECHECK_SYSTEM = `You are the last check before an automated trade on Kalshi (a regulated prediction market), placed for a soccer prediction from the PredyGo engine.
Decide if this specific order should go ahead. Be fast and concrete. Answer:
- "block" only for a real, specific problem: the Kalshi contract does not settle the same way as the predicted bet (wrong team, wrong line, wrong side, full time vs regulation, wrong game or date), team names that look like different clubs, a kickoff/time that doesn't fit, data that is clearly broken (impossible score, minute, odds or confidence), or the price disagreeing so sharply with the model that the model is probably missing information (for example a live goal or red card).
- "caution" for softer concerns worth logging but not stopping the trade.
- "ok" otherwise. Most well-matched orders should be "ok"; don't block for general market risk or small edges, the app's own rules already handle sizing and edge. The user trades for profit and accepts risk; only stop orders that are actually wrong.
In "issues", note anything about this pick or its Kalshi match-up that looks wrong (bad data, naming, mapping, timing, grading, pricing, calibration). Keep each detail to one sentence. Empty list if none. The input's settledFacts are known and handled: don't block for them or list them as issues.`;

/** What the bought side pays out on, with the team names filled in. */
export function betMeaning(p: Proposal): string {
  const s = p.match.spec, pr = p.match.prediction;
  const name = (t: 'home' | 'away') => (t === 'home' ? pr.home : pr.away);
  const side = p.match.side.toUpperCase();
  switch (s.kind) {
    case 'total': return `${side} pays if the match has ${s.side === 'yes' ? 'more' : 'fewer'} than ${s.line} total goals (both teams combined).`;
    case 'btts': return `${side} pays if both teams ${s.side === 'yes' ? 'score' : 'do not both score'}.`;
    case 'team_total': return `${side} pays if ${name(s.team)} score${s.side === 'yes' ? 's more' : 's fewer'} than ${s.line} goals${s.line === 0.5 && s.side === 'yes' ? ' (at least one goal)' : ''}. It is NOT a bet on ${name(s.team)} winning; the result of the match doesn't matter.`;
    case 'not_win': return `${side} pays unless ${name(s.team)} win (a draw or a ${name(s.team === 'home' ? 'away' : 'home')} win both pay).`;
  }
}

export function describeForCheck(p: Proposal, extra: { liveMinute?: number; score?: string; calibrationN?: number; source?: string }) {
  const pr = p.match.prediction;
  const m = p.match.market as any;
  return {
    prediction: {
      league: pr.league, home: pr.home, away: pr.away, bet: pr.bet, kickoffUtc: pr.kickoff,
      source: pr.source ?? 'pregame', posted: pr.posted, statedConfidencePct: Number.isFinite(pr.statedPct) ? pr.statedPct : null,
      sourceOdds: pr.odds ?? null, liveScore: extra.score ?? (pr.score ? pr.score.join('-') : null), liveMinute: extra.liveMinute ?? pr.minute ?? null,
    },
    kalshiContract: {
      eventTitle: p.match.event?.title, ticker: m.ticker, title: m.title, yesSubtitle: m.yes_sub_title, status: m.status,
      sideBought: p.match.side, matchedAs: p.match.spec,
      // In plain words, so a contract titled only with a team name isn't read as "to win".
      betMeaning: betMeaning(p),
      kalshiRules: typeof m.rules_primary === 'string' ? m.rules_primary.slice(0, 400) : undefined,
      closeTime: m.close_time, settlementTime: m.occurrence_datetime ?? m.expected_expiration_time,
    },
    pricing: {
      // A resting order: show the real book plus our own limit, not our limit as the "ask".
      ...(p.rest
        ? { orderType: 'resting buy at our price (waits on the book until shortly before kickoff)', askForOurSide: p.rest.askNow, bidForOurSide: p.rest.bidNow, ourLimitPrice: p.rest.price, worthUpTo: p.rest.maxPay, feeNote: 'maker fee (about a quarter of the taker fee)' }
        : { orderType: 'buy now at the ask (all or nothing)', askForOurSide: p.quote.ask, bidForOurSide: p.quote.bid }),
      spreadCents: p.rest ? Math.round((p.rest.askNow - p.rest.bidNow) * 100) : p.quote.spreadCents,
      appWinProbability: +p.probability.toFixed(4),
      blendedProbabilityForEdge: p.priced !== undefined ? +p.priced.toFixed(4) : null,
      edgeNote: 'edgeAfterFees = blendedProbabilityForEdge - costPerContractInclFees; the blend leans part of the way toward the Kalshi price on purpose', probabilityStdErr: p.inputs?.probabilityStdErr ?? null, gradedSampleSize: extra.calibrationN ?? null,
      edgeAfterFees: +p.edge.toFixed(4), edgeRequired: p.required ?? null, contracts: p.contracts, costPerContractInclFees: +p.cost.toFixed(4),
    },
    nowUtc: new Date().toISOString(),
  };
}

export async function precheck(cfg: AppConfig, apiKey: string, p: Proposal, extra: Parameters<typeof describeForCheck>[1]): Promise<{ result: PrecheckResult; call?: ClaudeCall<PrecheckResult>; error?: string }> {
  const input = { ...describeForCheck(p, extra), settledFacts: SETTLED_FACTS };
  try {
    const call = await callAI<PrecheckResult>({
      apiKey, model: cfg.ai.checkModel, system: PRECHECK_SYSTEM, user: JSON.stringify(input), schema: PRECHECK_SCHEMA,
      maxTokens: 4000, timeoutMs: p.match.prediction.source && p.match.prediction.source !== 'pregame' ? 12_000 : 25_000,
      purpose: 'precheck', budgetUsd: cfg.ai.dailyBudgetUsd,
    });
    append(aiLogPath(), { kind: 'precheck', at: new Date().toISOString(), ticker: p.match.market.ticker, pick: `${p.match.prediction.home} v ${p.match.prediction.away} ${p.match.prediction.bet}`, ...call.data, model: call.model, cost: call.costUsd, ms: call.ms });
    return { result: call.data, call };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    append(aiLogPath(), { kind: 'precheck', at: new Date().toISOString(), ticker: p.match.market.ticker, pick: `${p.match.prediction.home} v ${p.match.prediction.away} ${p.match.prediction.bet}`, verdict: 'error', reason: error });
    return { result: { verdict: cfg.ai.failOpen ? 'ok' : 'block', reason: error, issues: [] }, error };
  }
}

export { ClaudeError };
