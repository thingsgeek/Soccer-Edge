/**
 * Turn whatever the user pasted from Kalshi into a usable key, and find out which
 * Kalshi environment (live or demo) the key belongs to.
 */
import { createPrivateKey } from 'node:crypto';
import { getBalance } from './account';
import { KalshiApiError, type KalshiCredentials } from './client';
import type { KalshiEnv } from '../config';

/**
 * Accepts a PEM with or without line breaks (pasting into some fields flattens it),
 * PKCS#1 ("RSA PRIVATE KEY") or PKCS#8 ("PRIVATE KEY"). Returns a clean PEM or throws.
 */
export function normalizePrivateKey(pasted: string): string {
  const text = pasted.trim().replace(/\r/g, '');
  const m = text.match(/-----BEGIN ((?:RSA )?PRIVATE KEY)-----([\s\S]*?)-----END \1-----/);
  if (!m) {
    if (/BEGIN (?:PUBLIC KEY|CERTIFICATE)/.test(text)) throw new Error('That is a public key. Paste the PRIVATE key Kalshi gave you.');
    throw new Error('That does not look like a private key. It should start with "-----BEGIN RSA PRIVATE KEY-----".');
  }
  const label = m[1]!;
  const body = m[2]!.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/=]+$/.test(body)) throw new Error('The private key text is damaged. Copy it again from Kalshi.');
  const pem = `-----BEGIN ${label}-----\n${body.match(/.{1,64}/g)!.join('\n')}\n-----END ${label}-----\n`;
  try {
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== 'rsa') throw new Error('not rsa');
  } catch {
    throw new Error('The private key could not be read. Copy the whole key from Kalshi, including the BEGIN and END lines.');
  }
  return pem;
}

export function normalizeKeyId(pasted: string): string {
  const id = pasted.trim();
  if (!/^[0-9a-fA-F-]{20,64}$/.test(id)) throw new Error('The Kalshi Key ID should look like 1a2b3c4d-....');
  return id;
}

export interface KalshiConnection {
  creds: KalshiCredentials;
  cashCents: number;
}

/**
 * Kalshi keys are tied to one environment. Try live first, then demo.
 * `prefer` lets the user force one.
 */
export async function connectKalshi(apiKeyId: string, privateKeyPem: string, prefer?: KalshiEnv): Promise<KalshiConnection> {
  const order: KalshiEnv[] = prefer ? [prefer] : ['prod', 'demo'];
  let lastErr: unknown;
  for (const env of order) {
    const creds: KalshiCredentials = { env, apiKeyId, privateKeyPem };
    try {
      const bal = await getBalance(creds);
      return { creds, cashCents: bal.cashCents };
    } catch (e) {
      lastErr = e;
      if (!(e instanceof KalshiApiError && (e.statusCode === 401 || e.statusCode === 403 || e.statusCode === 404))) throw e;
    }
  }
  const detail = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(`Kalshi did not accept this Key ID and private key on ${order.join(' or ')}. Check you copied both from the same key. (${detail.slice(0, 160)})`);
}
