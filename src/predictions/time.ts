/**
 * Convert a wall-clock time ("2026-10-14 14:45:00") in an IANA time zone to UTC ISO.
 * PredyGo stores match_date as local wall time without an offset.
 */
export function wallTimeToUtc(wall: string, timeZone: string): string {
  const m = wall.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) {
    const d = new Date(wall);
    if (Number.isNaN(d.getTime())) throw new Error(`Unparseable date: ${wall}`);
    return d.toISOString();
  }
  const [, y, mo, d, h, mi, s] = m;
  const asIfUtc = Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +(s ?? 0));
  // Offset of the zone at that instant, found by formatting the guess back into the zone.
  const offset = (t: number) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(t));
    const get = (type: string) => +(parts.find((p) => p.type === type)?.value ?? 0);
    const zoned = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    return zoned - t;
  };
  let utc = asIfUtc - offset(asIfUtc);
  utc = asIfUtc - offset(utc); // second pass settles DST edges
  return new Date(utc).toISOString();
}
