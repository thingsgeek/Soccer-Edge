/**
 * Hard rule, no setting turns it off: never buy at or after the 80th minute of a game.
 * Uses the match minute PredyGo gives (moved on by the time since the pick), and the clock
 * since kickoff (80 minutes of play + ~15 min half-time = 95 min), whichever is later.
 */
export const LATEST_MATCH_MINUTE = 80;
const HALF_TIME_MIN = 15;

export function matchMinuteNow(kickoffMs: number, nowMs: number, feedMinute?: number | null, feedAtMs?: number | null): number {
  const sinceKo = (nowMs - kickoffMs) / 60_000;
  const byClock = sinceKo <= 45 ? sinceKo : Math.max(45, sinceKo - HALF_TIME_MIN);
  const byFeed = Number.isFinite(feedMinute as number)
    ? (feedMinute as number) + (Number.isFinite(feedAtMs as number) ? Math.max(0, (nowMs - (feedAtMs as number)) / 60_000) : 0)
    : -Infinity;
  return Math.max(byClock, byFeed);
}

/** The skip reason when it is too late in the game to buy, else null. */
export function tooLateInGame(kickoffMs: number, nowMs: number, feedMinute?: number | null, feedAtMs?: number | null): string | null {
  if (!Number.isFinite(kickoffMs) || nowMs < kickoffMs) return null;
  const m = matchMinuteNow(kickoffMs, nowMs, feedMinute, feedAtMs);
  return m >= LATEST_MATCH_MINUTE ? `minute ${Math.floor(m)}: no buys from the ${LATEST_MATCH_MINUTE}th minute on` : null;
}
