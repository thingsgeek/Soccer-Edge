/**
 * Load Kalshi soccer events (with their markets) for the leagues a run needs.
 * Uses public, unauthenticated market data only.
 *
 * Cached briefly so one scan doesn't refetch the same league, but refreshed between
 * scans: Kalshi adds games through the day and prices move.
 */
import { publicGet, publicGetAll } from './client';
import type { KalshiEvent, KalshiSeries } from './types';
import leagueData from '../../data/leagues.json';
import { readOverride } from '../data';

export const MARKET_SUFFIXES = ['GAME', 'TOTAL', 'BTTS', 'TEAMTOTAL'] as const;
export type MarketSuffix = (typeof MARKET_SUFFIXES)[number];

/** Market data older than this is refetched. */
export const BOOK_TTL_MS = 90_000;
const SERIES_TTL_MS = 60 * 60_000;

let leagues: Record<string, string[]> | null = null;

function leagueMap(): Record<string, string[]> {
  if (!leagues) {
    const extra = readOverride<{ leagues: Record<string, string[]> }>('leagues.json');
    leagues = { ...(leagueData as { leagues: Record<string, string[]> }).leagues, ...(extra?.leagues ?? {}) };
  }
  return leagues;
}

export function kalshiPrefixesFor(league: string): string[] {
  return leagueMap()[league] ?? [];
}

/** League name for a Kalshi ticker (e.g. KXUELTEAMTOTAL-... -> "UEFA Europa League"), for trades saved without one. */
export function leagueForTicker(ticker: string): string | null {
  const series = ticker.split('-')[0] ?? '';
  const suffix = ['TEAMTOTAL', 'TOTAL', 'BTTS', 'GAME'].find((x) => series.endsWith(x));
  const prefix = suffix ? series.slice(0, -suffix.length) : series;
  const names = Object.entries(leagueMap()).filter(([, ps]) => ps.includes(prefix)).map(([n]) => n);
  return names.find((n) => !/qualif/i.test(n)) ?? names[0] ?? null;
}

export interface LeagueBook {
  prefix: string;
  /** Events keyed by suffix (GAME, TOTAL, ...). */
  events: Record<MarketSuffix, KalshiEvent[]>;
  /** Which of the four series Kalshi lists for this league at all. */
  seriesListed: Record<MarketSuffix, boolean>;
  loadedAt: number;
}

let seriesCache: { at: number; series: KalshiSeries[] } | null = null;

export async function soccerSeries(): Promise<KalshiSeries[]> {
  if (seriesCache && Date.now() - seriesCache.at < SERIES_TTL_MS) return seriesCache.series;
  const res = await publicGet('/series', { category: 'Sports' });
  const series = ((res.series ?? []) as KalshiSeries[]).filter((s) => s.tags?.includes('Soccer'));
  seriesCache = { at: Date.now(), series };
  return series;
}

export async function soccerSeriesTickers(): Promise<Set<string>> {
  return new Set((await soccerSeries()).map((s) => s.ticker));
}

/** Fixed window for replays; null = rolling "closing after 1 day ago". */
let fixedMinCloseTs: number | null = null;

/** Widen the window, e.g. to replay past predictions against settled markets. */
export function setEventWindow(sinceUnixSeconds: number): void {
  fixedMinCloseTs = sinceUnixSeconds;
  bookCache.clear();
}

async function eventsForSeries(seriesTicker: string): Promise<KalshiEvent[]> {
  // No status filter: status=open drops upcoming soccer events. min_close_ts keeps
  // the payload small (a full page with nested markets is ~1.5 MB). Inactive
  // markets are filtered out per market later.
  const minCloseTs = fixedMinCloseTs ?? Math.floor(Date.now() / 1000) - 86_400;
  return publicGetAll<KalshiEvent>(
    '/events',
    { series_ticker: seriesTicker, with_nested_markets: true, limit: 200, min_close_ts: minCloseTs },
    'events',
    5,
  );
}

const bookCache = new Map<string, { at: number; book: Promise<LeagueBook> }>();

/** Drop all cached market data (next scan refetches everything). */
export function clearMarketCache(): void {
  bookCache.clear();
}

// ------------------------------------------------------------ discovery for unlisted leagues

/** Women's, youth-less eSoccer and other series a men's club pick should never land on. */
const NOT_FOR_DISCOVERY = /women|femmin|vrouwen|liga f\b|nwsl|ewsl|esoccer|fifa w|frauen|feminin|\bw\b/i;
const DISCOVERY_TTL_MS = 10 * 60_000;
let gameIndex: { at: number; index: Promise<{ prefix: string; events: KalshiEvent[] }[]> } | null = null;

/**
 * Every upcoming/recent game Kalshi lists across all soccer competitions (GAME series only),
 * so a pick from a league missing from leagues.json (a cup, a new league, a renamed one)
 * can still be found. Refreshed every 10 minutes.
 */
export function allSoccerGames(): Promise<{ prefix: string; events: KalshiEvent[] }[]> {
  if (gameIndex && Date.now() - gameIndex.at < DISCOVERY_TTL_MS) return gameIndex.index;
  const index = (async () => {
    const series = (await soccerSeries()).filter((s) => s.ticker.endsWith('GAME') && !NOT_FOR_DISCOVERY.test(`${s.title} ${s.ticker.replace(/GAME$/, '')}`) && !/W$/.test(s.ticker.replace(/GAME$/, '')));
    const out: { prefix: string; events: KalshiEvent[] }[] = [];
    let failed = 0;
    for (let i = 0; i < series.length; i += 8) {
      const batch = await Promise.all(series.slice(i, i + 8).map(async (s) => {
        try {
          // Titles and tickers only (no nested markets): a small payload per competition.
          const minCloseTs = fixedMinCloseTs ?? Math.floor(Date.now() / 1000) - 86_400;
          const events = await publicGetAll<KalshiEvent>('/events', { series_ticker: s.ticker, limit: 200, min_close_ts: minCloseTs }, 'events', 2);
          return { prefix: s.ticker.replace(/GAME$/, ''), events };
        }
        catch { failed++; return { prefix: s.ticker.replace(/GAME$/, ''), events: [] as KalshiEvent[] }; }
      }));
      out.push(...batch.filter((b) => b.events.length));
    }
    // Some competitions couldn't be read (rate limit, network): try again in a minute
    // instead of leaving their games out for the full 10 minutes.
    if (failed && gameIndex) gameIndex.at = Date.now() - DISCOVERY_TTL_MS + 60_000;
    return out;
  })();
  gameIndex = { at: Date.now(), index };
  index.catch(() => { if (gameIndex?.index === index) gameIndex = null; });
  return index;
}

export function loadLeagueBook(prefix: string): Promise<LeagueBook> {
  const hit = bookCache.get(prefix);
  // Replays use a fixed window and settled data: no need to refresh.
  if (hit && (fixedMinCloseTs !== null || Date.now() - hit.at < BOOK_TTL_MS)) return hit.book;
  const book = (async () => {
    const known = await soccerSeriesTickers();
    const events = {} as Record<MarketSuffix, KalshiEvent[]>;
    const seriesListed = {} as Record<MarketSuffix, boolean>;
    await Promise.all(
      MARKET_SUFFIXES.map(async (suffix) => {
        const ticker = prefix + suffix;
        seriesListed[suffix] = known.has(ticker);
        events[suffix] = seriesListed[suffix] ? await eventsForSeries(ticker) : [];
      }),
    );
    return { prefix, events, seriesListed, loadedAt: Date.now() };
  })();
  bookCache.set(prefix, { at: Date.now(), book });
  // A failed load must not stick: the next scan retries.
  book.catch(() => { if (bookCache.get(prefix)?.book === book) bookCache.delete(prefix); });
  return book;
}
