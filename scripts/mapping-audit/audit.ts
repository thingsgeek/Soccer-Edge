import { readFileSync, writeFileSync } from 'node:fs';
import { teamSimilarity, normalize } from '../../src/match/teams';
import { eventTeams } from '../../src/match/matcher';
import leagueData from '../../data/leagues.json';
const series: any[] = JSON.parse(readFileSync('series.json', 'utf8'));
const events: Record<string, { t: string; title: string }[]> = JSON.parse(readFileSync('events.json', 'utf8'));
const pg = readFileSync(process.argv[2]!, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const MON=['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC']; const SINCE = process.argv[3] ?? '2026-09-01';
const SUF = /(TEAMTOTAL|GAME|TOTAL|BTTS)$/;
// prefix -> { title, suffixes, teams: Map<name, count>, last date }
const pref: Record<string, { titles: string[]; sfx: Set<string>; teams: Map<string, number>; events: number; last: string }> = {};
for (const s of series) {
  const m = s.ticker.match(SUF); if (!m) continue;
  const p = s.ticker.slice(0, -m[1].length);
  const e = (pref[p] ??= { titles: [], sfx: new Set(), teams: new Map(), events: 0, last: '' });
  e.titles.push(s.title); e.sfx.add(m[1]);
  for (const ev of events[s.ticker] ?? []) {
    const tm = eventTeams(ev.title); if (!tm) continue;
    e.events++;
    const m2 = ev.t.match(/-(\d{2})([A-Z]{3})(\d{2})/); if (!m2) continue;
    const d = `20${m2[1]}-${String(MON.indexOf(m2[2])+1).padStart(2,'0')}-${m2[3]}`; if (d > e.last) e.last = d;
    if (d < SINCE) continue;
    for (const t of tm) e.teams.set(t, (e.teams.get(t) ?? 0) + 1);
  }
}
const mapped = new Map<string, string[]>();
for (const [lg, ps] of Object.entries((leagueData as any).leagues as Record<string, string[]>)) for (const p of ps) mapped.set(p, [...(mapped.get(p) ?? []), lg]);
// token index for speed
const idx = new Map<string, Set<number>>();
const toks = (s: string) => normalize(s).split(' ').filter((t) => t.length >= 2);
pg.forEach((n, i) => { for (const t of toks(n)) { const k = t.slice(0, 3); if (!idx.has(k)) idx.set(k, new Set()); idx.get(k)!.add(i); } });
const best = (k: string) => {
  const cand = new Set<number>(); for (const t of toks(k)) for (const i of idx.get(t.slice(0, 3)) ?? []) cand.add(i);
  const r = [...cand].map((i) => ({ n: pg[i]!, s: teamSimilarity(pg[i]!, k) })).sort((a, b) => b.s - a.s);
  return r.slice(0, 4);
};
const out: any[] = [];
for (const [p, e] of Object.entries(pref)) {
  if (e.teams.size === 0) continue;
  const teams = [...e.teams.entries()].map(([k, c]) => { let b = best(k); if (!b[0] || b[0].s < 0.85) b = pg.map((n) => ({ n, s: teamSimilarity(n, k) })).sort((x, y) => y.s - x.s).slice(0, 4); return { kalshi: k, games: c, best: b[0]?.n ?? null, score: +(b[0]?.s ?? 0).toFixed(2), alts: b.slice(1).map((x) => `${x.n} ${x.s.toFixed(2)}`) }; });
  out.push({ prefix: p, title: e.titles[0], sfx: [...e.sfx], events: e.events, last: e.last, leagues: mapped.get(p) ?? [], teams });
}
writeFileSync('audit.json', JSON.stringify(out, null, 1));
const all = out.flatMap((o) => o.teams.map((t: any) => ({ ...t, prefix: o.prefix })));
console.log('prefixes with games', out.length, 'kalshi teams', all.length,
  '>=0.85', all.filter((t) => t.score >= 0.85).length, '0.6-0.85', all.filter((t) => t.score >= 0.6 && t.score < 0.85).length, '<0.6', all.filter((t) => t.score < 0.6).length);
console.log('unmapped prefixes', out.filter((o) => !o.leagues.length).length);
