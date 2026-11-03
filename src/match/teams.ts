/**
 * Fuzzy team-name matching between a prediction source and Kalshi.
 * Kalshi uses short names ("Wolverhampton", "Los Angeles G", "San Diego FC");
 * sources use their own ("LA Galaxy", "Sheff Utd", "St. Louis City SC").
 */
import aliasData from '../../data/team-aliases.json';
import { readOverride } from '../data';

// Generic club-form words only. Words that tell clubs apart ("United" vs "City",
// "Real", "Sporting") are deliberately NOT here.
const STOP = new Set([
  'fc', 'cf', 'sc', 'afc', 'ac', 'cd', 'ca', 'cs', 'sk', 'fk', 'nk', 'if', 'ik', 'bk', 'sv', 'vfl', 'vfb', 'tsg',
  'club', 'de', 'del', 'the', 'and', 'calcio', 'clube', 'esporte', 'futbol', 'football', 'soccer', 'cp', 'ud', 'rcd',
]);

/**
 * City names spelled in the local language on one side and in English on the other
 * ("Dinamo Bucuresti" on Kalshi, "Dinamo Bucharest" in PredyGo). Mapped to one form.
 */
const EXONYMS: Record<string, string> = {
  bucuresti: 'bucharest', praha: 'prague', beograd: 'belgrade', warszawa: 'warsaw', wien: 'vienna',
  lisboa: 'lisbon', kobenhavn: 'copenhagen', munchen: 'munich', koln: 'cologne', nurnberg: 'nuremberg',
  kyiv: 'kiev', athina: 'athens', moskva: 'moscow', cracow: 'krakow', goteborg: 'gothenburg',
  zagreb: 'zagreb', sevilla: 'sevilla',
};
const EXONYM_RE = new RegExp(`\\b(${Object.keys(EXONYMS).join('|')})\\b`, 'g');

export function normalize(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/&/g, ' and ')
    .replace(/\bst\.?\s/g, 'saint ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\butd\b/g, 'united')
    .replace(EXONYM_RE, (w) => EXONYMS[w]!)
    .replace(/\s+/g, ' ')
    .trim();
}

let aliases: Map<string, string> | null = null;

function aliasMap(): Map<string, string> {
  if (!aliases) {
    const extra = readOverride<{ aliases: Record<string, string> }>('team-aliases.json');
    const all = { ...(aliasData as { aliases: Record<string, string> }).aliases, ...(extra?.aliases ?? {}) };
    aliases = new Map(Object.entries(all).map(([k, v]) => [normalize(k), normalize(v)]));
  }
  return aliases;
}

function canonical(name: string): string {
  const n = normalize(name);
  return aliasMap().get(n) ?? n;
}

function tokens(n: string): string[] {
  const all = n.split(' ').filter(Boolean);
  const core = all.filter((t) => !STOP.has(t));
  return core.length > 0 ? core : all;
}

/** Spelling variants of the same word: "warsaw"/"warszawa", "munich"/"munchen". */
function sharedStem(x: string, y: string): boolean {
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  return i >= 4 && i >= 0.6 * Math.min(x.length, y.length);
}

/**
 * Similarity in [0, 1]. 1 = same team for practical purposes.
 * Handles exact matches, aliases, token overlap and truncated names ("Los Angeles G").
 */
export function teamSimilarity(a: string, b: string): number {
  const ca = canonical(a);
  const cb = canonical(b);
  if (ca === cb) return 1;
  const ta = tokens(ca);
  const tb = tokens(cb);
  if (ta.length === 0 || tb.length === 0) return 0;
  // Same once club-form words are dropped ("FC Cajamarca" / "Cajamarca"): nearly certain, but
  // a name that matches exactly still wins when two clubs share a town.
  if (ta.join(' ') === tb.join(' ')) return 0.97;

  // Token overlap, where a token also matches if one is a prefix of the other (min 1 char for
  // truncated trailing tokens like "G" for "Galaxy", else 3).
  const used = new Set<number>();
  let hits = 0;
  // Exact token matches count fully; prefix/stem matches a little less, so "Atlas" prefers
  // "Atlas" over "Atlante" and "Goias" prefers "Goias" over "Goianiense".
  let weighted = 0;
  for (const x of ta) {
    for (let j = 0; j < tb.length; j++) {
      if (used.has(j)) continue;
      const y = tb[j]!;
      const short = x.length <= y.length ? x : y;
      const long = x.length <= y.length ? y : x;
      const minPrefix = short.length === 1 ? 1 : 3;
      if (x === y || (short.length >= minPrefix && long.startsWith(short)) || sharedStem(x, y)) {
        used.add(j);
        hits++;
        weighted += x === y ? 1 : 0.9;
        break;
      }
    }
  }
  const score = (2 * weighted) / (ta.length + tb.length);

  // Every token of the shorter name found in the longer one ("Brighton" in "Brighton
  // and Hove Albion"). Moderate score: the event-level match still needs the opponent
  // and the date to agree, which rules out "Bristol" picking the wrong Bristol club.
  const shorter = Math.min(ta.length, tb.length);
  const contained = hits === shorter && (ta.length === shorter ? ta : tb).join('').length >= 4 ? 0.7 : 0;

  // Compact forms: "westbrom" vs "west bromwich" style.
  const ja = ta.join('');
  const jb = tb.join('');
  const compact = ja.length >= 4 && jb.length >= 4 && (ja.startsWith(jb) || jb.startsWith(ja)) ? 0.85 : 0;

  return Math.max(score, compact, contained);
}

export const TEAM_MATCH_THRESHOLD = 0.6;
