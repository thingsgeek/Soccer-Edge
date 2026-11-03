import type { CanonicalMarket } from '../match/bets';

export interface Prediction {
  /** Stable id from the source (PredyGo id + bet code). */
  id: string;
  league: string;
  /** Kickoff in UTC, ISO string. */
  kickoff: string;
  home: string;
  away: string;
  /** Source bet code, e.g. "T+1.5", "BTTS", "1X", "LOCAL MARCA". */
  bet: string;
  /** Structured market definition, when the source provides one (PredyGo API). */
  canonical?: CanonicalMarket | null;
  /** Confidence as stated by the source, 0-100. */
  statedPct: number;
  /** Graded outcome if the match is finished: true = bet won. Push/void stay null. */
  won?: boolean | null;
  /** "pregame" or "live". In-play picks are never traded. */
  source?: string;
  /** True if PredyGo posted this pick; false if it's from the full model list. Unknown when the feed doesn't say. */
  posted?: boolean;
  /** Live picks: score when the pick was made [home, away], if the feed says. */
  score?: [number, number];
  /** Live picks: match minute when the pick was made, if the feed says. */
  minute?: number;
  /** Live picks: when the pick was made (UTC ISO), if the feed says. */
  pickedAt?: string;
  /** PredyGo high_risk: a late-game HIGH RISK / HIGH REWARD play, not graded or counted in its record. */
  highRisk?: boolean;
  /** Decimal odds the source saw for this bet, if the feed says. */
  odds?: number;
}
