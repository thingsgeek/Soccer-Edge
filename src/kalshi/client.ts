/**
 * Kalshi REST client: RSA-PSS request signing, retry with backoff, demo/prod.
 *
 * Request signing and retry logic adapted from OctagonAI/kalshi-trading-bot-cli
 * (src/tools/kalshi/api.ts), MIT License, Copyright (c) Octagon AI, Inc.
 * See THIRD_PARTY_NOTICES.md.
 */
import { createSign, constants } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { KalshiEnv } from '../config';

const BASE_URLS: Record<KalshiEnv, string> = {
  prod: 'https://api.elections.kalshi.com/trade-api/v2',
  demo: 'https://demo-api.kalshi.co/trade-api/v2',
};

/** Public market data is always read from production, so matching reflects real markets. */
const PUBLIC_DATA_URL = BASE_URLS.prod;

export class KalshiApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly statusText: string,
    public readonly body: string,
  ) {
    super(`Kalshi API error: ${statusCode} ${statusText}${body ? ` - ${body.slice(0, 300)}` : ''}`);
    this.name = 'KalshiApiError';
  }
}

export interface KalshiCredentials {
  env: KalshiEnv;
  apiKeyId: string;
  privateKeyPem: string;
}

export function loadCredentials(env: KalshiEnv, apiKeyId?: string, privateKeyPath?: string): KalshiCredentials | null {
  if (!apiKeyId || !privateKeyPath) return null;
  return { env, apiKeyId, privateKeyPem: readFileSync(privateKeyPath, 'utf-8') };
}

export function signRequest(privateKeyPem: string, method: string, path: string, timestamp: string): string {
  const signer = createSign('SHA256');
  signer.update(timestamp + method.toUpperCase() + path);
  signer.end();
  return signer.sign({ key: privateKeyPem, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, 'base64');
}

const MAX_RETRIES = 4;
const TIMEOUT_MS = 30_000;

/** 429, 5xx, timeouts and network errors are worth retrying; other 4xx are not. */
function retryable(e: unknown): boolean {
  if (e instanceof KalshiApiError) return e.statusCode === 429 || e.statusCode >= 500;
  return true;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Params = Record<string, string | number | boolean | undefined>;

/**
 * Kalshi allows about 20 reads a second on a basic account. Space every request at
 * least READ_SPACING_MS apart (shared by the whole app) so a big market refresh never
 * trips the limit and leaves games out. Order requests are never delayed.
 */
const READ_SPACING_MS = process.env.NODE_ENV === 'test' ? 0 : 50;
let nextReadAt = 0;
async function readSlot(): Promise<void> {
  const now = Date.now();
  if (nextReadAt - now > 30_000) nextReadAt = now; // the clock moved back: don't stall
  const at = Math.max(now, nextReadAt);
  nextReadAt = at + READ_SPACING_MS;
  if (at > now) await sleep(at - now);
}
/** After a 429, pause all reads briefly. */
function backOffReads(ms: number) { nextReadAt = Math.max(nextReadAt, Date.now() + ms); }

async function request(
  method: 'GET' | 'POST' | 'DELETE',
  base: string,
  path: string,
  opts: { params?: Params; body?: unknown; creds?: KalshiCredentials | null; retries?: number } = {},
): Promise<any> {
  const retries = opts.retries ?? MAX_RETRIES;
  for (let attempt = 0; ; attempt++) {
    try {
      const url = new URL(base + path);
      for (const [k, v] of Object.entries(opts.params ?? {})) {
        if (v !== undefined && v !== '') url.searchParams.append(k, String(v));
      }
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (opts.creds) {
        // Signature covers timestamp + method + path, without the query string.
        const ts = Date.now().toString();
        headers['KALSHI-ACCESS-KEY'] = opts.creds.apiKeyId;
        headers['KALSHI-ACCESS-TIMESTAMP'] = ts;
        headers['KALSHI-ACCESS-SIGNATURE'] = signRequest(opts.creds.privateKeyPem, method, url.pathname, ts);
      }
      if (method === 'GET') await readSlot();
      const res = await fetch(url, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new KalshiApiError(res.status, res.statusText, await res.text().catch(() => ''));
      if (res.status === 204) return {};
      return await res.json();
    } catch (e) {
      // Never retry an order POST blindly: a timeout may mean it was placed.
      const safeToRetry = method === 'GET' && retryable(e);
      const limited = e instanceof KalshiApiError && e.statusCode === 429;
      if (!safeToRetry || attempt >= (limited ? Math.max(retries, 6) : retries)) throw e;
      const wait = Math.min(1000 * 2 ** attempt, 15_000) * (0.8 + Math.random() * 0.4);
      if (limited) backOffReads(wait);
      await sleep(wait);
    }
  }
}

/** Unauthenticated read of public market data (production). */
export function publicGet(path: string, params?: Params): Promise<any> {
  return request('GET', PUBLIC_DATA_URL, path, { params });
}

/** Authenticated call against the user's account, in the configured environment. */
export function authed(
  creds: KalshiCredentials,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  opts: { params?: Params; body?: unknown } = {},
): Promise<any> {
  return request(method, BASE_URLS[creds.env], path, { ...opts, creds });
}

/** Follow a cursor-paginated public endpoint. */
export async function publicGetAll<T>(path: string, params: Params, key: string, maxPages = 10): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await publicGet(path, { ...params, cursor });
    const rows = (res[key] ?? []) as T[];
    out.push(...rows);
    cursor = res.cursor || undefined;
    if (!cursor || rows.length === 0) break;
  }
  return out;
}
