/**
 * Region check before any order. The user declares where they trade from:
 * a country, plus a state inside the US. The app refuses to trade from places on
 * the restricted lists. Kalshi also checks your account and location and has the
 * final say: a refusal from Kalshi stops trading.
 */
import bundled from '../../data/eligibility.json';
import { readOverride } from '../data';

export interface EligibilityData {
  asOf: string;
  note?: string;
  kalshi: {
    /** US states where sports contracts are blocked. */
    sportsRestricted: string[];
    /** US states where Kalshi is unavailable entirely. */
    platformRestricted: string[];
    /** ISO country codes Kalshi excludes (outside the US). */
    countryRestricted?: string[];
    countrySource?: string;
  };
}

export const US_STATES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN',
  'MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA',
  'WV','WI','WY',
]);

/** ISO 3166-1 alpha-2 codes (sovereign states and common territories). */
export const COUNTRIES = (
  'AD AE AF AG AI AL AM AO AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BW BY BZ CA CC CD CF ' +
  'CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF ' +
  'GG GH GI GL GM GN GP GQ GR GT GU GW GY HK HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP ' +
  'KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA ' +
  'NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH ' +
  'SI SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG US UY UZ VA VC VE VG VI VN ' +
  'VU WF WS XK YE YT ZA ZM ZW'
).split(' ');
const COUNTRY_SET = new Set(COUNTRIES);

/** US territories have their own rules; treat them as needing a US state answer of "none". */
const US_TERRITORIES = new Set(['PR', 'GU', 'VI', 'AS', 'MP']);

let regionNames: Intl.DisplayNames | null = null;
export function countryName(code: string): string {
  try {
    regionNames ??= new Intl.DisplayNames(['en'], { type: 'region' });
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}

export function countryOptions(): { code: string; name: string }[] {
  return COUNTRIES.map((code) => ({ code, name: countryName(code) })).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Order of preference: eligibilityUrl (a list you host), then eligibility.json in the
 * settings folder, then the list bundled with this build.
 */
export async function loadEligibility(url?: string): Promise<EligibilityData> {
  if (url) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (res.ok) return (await res.json()) as EligibilityData;
      console.warn(`Warning: eligibility list at ${url} returned ${res.status}; using the local list.`);
    } catch (e) {
      console.warn(`Warning: could not load eligibility list from ${url} (${e instanceof Error ? e.message : e}); using the local list.`);
    }
  }
  return readOverride<EligibilityData>('eligibility.json') ?? (bundled as EligibilityData);
}

export type EligibilityResult = { ok: true; label: string } | { ok: false; reason: string };

export interface Region {
  country?: string;
  state?: string;
  /** The Rules panel can switch the region check off (risk.rulesOff "region"). */
  risk?: { rulesOff?: string[] };
}

/** Normalise a region; configs from before country support are US. */
export function regionOf(cfg: Region): Region {
  const country = (cfg.country ?? (cfg.state ? 'US' : '')).trim().toUpperCase() || undefined;
  return { country, state: cfg.state?.trim().toUpperCase() || undefined };
}

export function regionLabel(r: Region): string {
  const reg = regionOf(r);
  if (!reg.country) return 'not set';
  return reg.country === 'US' ? `${reg.state ?? '?'}, United States` : countryName(reg.country);
}

export function checkRegion(region: Region, data: EligibilityData): EligibilityResult {
  const { country, state } = regionOf(region);
  if (region.risk?.rulesOff?.includes('region')) return { ok: true, label: `${regionLabel(region)} (region check switched off)` };
  if (!country) return { ok: false, reason: 'No country set. Choose where you trade from in Settings.' };
  if (!COUNTRY_SET.has(country)) return { ok: false, reason: `"${country}" is not a country code.` };

  if (country === 'US') {
    if (!state) return { ok: false, reason: 'Choose the US state you trade from in Settings.' };
    if (!US_STATES.has(state)) return { ok: false, reason: `"${state}" is not a US state code.` };
    if (data.kalshi.platformRestricted.includes(state)) return { ok: false, reason: `Kalshi is not available in ${state} (list as of ${data.asOf}).` };
    if (data.kalshi.sportsRestricted.includes(state)) {
      return { ok: false, reason: `Kalshi sports contracts are restricted in ${state} (list as of ${data.asOf}). Trading is disabled.` };
    }
    return { ok: true, label: `${state}, United States` };
  }

  if (US_TERRITORIES.has(country)) {
    return { ok: false, reason: `${countryName(country)} is a US territory with its own rules. Not supported by this app.` };
  }
  const restricted = data.kalshi.countryRestricted ?? [];
  if (restricted.includes(country)) {
    return { ok: false, reason: `Kalshi excludes ${countryName(country)} (${data.kalshi.countrySource ?? `list as of ${data.asOf}`}). Trading is disabled.` };
  }
  return { ok: true, label: countryName(country) };
}

/** Kept for older callers: a US state on its own. */
export function checkState(state: string | undefined, data: EligibilityData): EligibilityResult {
  return checkRegion({ country: 'US', state }, data);
}
