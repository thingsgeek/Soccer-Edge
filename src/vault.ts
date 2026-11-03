/**
 * Encrypted credential vault, unlocked with a password at launch.
 *
 * Layers:
 *  1. Password: scrypt(password, random salt) -> 256-bit key -> AES-256-GCM.
 *     The password is never stored. A wrong password fails GCM authentication.
 *  2. Windows only: the whole file is also sealed with DPAPI (CurrentUser), so a
 *     copy of vault.dat is useless on another Windows account or machine.
 *
 * Decrypted secrets live only in memory while the app runs.
 */
import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appHome, ensureHome } from './config';

export interface Secrets {
  predygoKey: string;
  kalshiKeyId: string;
  kalshiPrivateKeyPem: string;
  /** Optional: Anthropic API key for the Claude assistant. */
  anthropicKey?: string;
  /** Optional: OpenAI API key for the ChatGPT assistant. */
  openaiKey?: string;
}

const SCRYPT = { N: 1 << 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
export const MIN_PASSWORD_LENGTH = 8;

export const vaultPath = (): string => join(appHome(), 'vault.dat');
export const vaultExists = (): boolean => existsSync(vaultPath());

function deriveKey(password: string, salt: Buffer, params = SCRYPT): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password.normalize('NFKC'), salt, 32, params, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

interface Envelope {
  v: 1;
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string };
  iv: string;
  tag: string;
  data: string;
}

export async function seal(secrets: Secrets, password: string, params = SCRYPT): Promise<Envelope> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKey(password, salt, params);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from('soccer-edge-vault-v1'));
  const data = Buffer.concat([cipher.update(JSON.stringify(secrets), 'utf8'), cipher.final()]);
  key.fill(0);
  return {
    v: 1,
    kdf: { name: 'scrypt', N: params.N, r: params.r, p: params.p, salt: salt.toString('base64') },
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

export class WrongPasswordError extends Error {
  constructor() { super('Wrong password.'); this.name = 'WrongPasswordError'; }
}

export async function open(env: Envelope, password: string): Promise<Secrets> {
  const key = await deriveKey(password, Buffer.from(env.kdf.salt, 'base64'), {
    N: env.kdf.N, r: env.kdf.r, p: env.kdf.p, maxmem: SCRYPT.maxmem,
  });
  try {
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'));
    d.setAAD(Buffer.from('soccer-edge-vault-v1'));
    d.setAuthTag(Buffer.from(env.tag, 'base64'));
    const plain = Buffer.concat([d.update(Buffer.from(env.data, 'base64')), d.final()]);
    return JSON.parse(plain.toString('utf8')) as Secrets;
  } catch {
    throw new WrongPasswordError();
  } finally {
    key.fill(0);
  }
}

// ------------------------------------------------------------ Windows DPAPI layer

const PS_PROTECT = `
Add-Type -AssemblyName System.Security
$in = [Console]::In.ReadToEnd().Trim()
$bytes = [Convert]::FromBase64String($in)
$out = [System.Security.Cryptography.ProtectedData]::Protect($bytes, [Text.Encoding]::UTF8.GetBytes('soccer-edge'), 'CurrentUser')
[Console]::Out.Write([Convert]::ToBase64String($out))`;

const PS_UNPROTECT = PS_PROTECT.replace('::Protect(', '::Unprotect(');

async function powershell(script: string, stdinText: string): Promise<string> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const proc = Bun.spawn(['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    stdin: new Blob([stdinText]),
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
  } as any);
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`Windows encryption (DPAPI) failed: ${err.trim().slice(0, 300)}`);
  return out.trim();
}

const useDpapi = () => process.platform === 'win32';

async function writeFileAtomic(path: string, content: string) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
}

/** Encrypt and save. Replaces any existing vault. */
export async function saveVault(secrets: Secrets, password: string): Promise<void> {
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  ensureHome();
  const env = JSON.stringify(await seal(secrets, password));
  const plainWrap = JSON.stringify({ wrap: 'none', data: Buffer.from(env).toString('base64') });
  let body = plainWrap;
  if (useDpapi()) {
    // Extra layer; the password encryption alone still protects the keys if it's unavailable.
    try {
      const sealed = await powershell(PS_PROTECT, Buffer.from(env).toString('base64'));
      // Only use it if it round-trips on this machine.
      if ((await powershell(PS_UNPROTECT, sealed)) === Buffer.from(env).toString('base64')) {
        body = JSON.stringify({ wrap: 'dpapi', data: sealed });
      }
    } catch {
      body = plainWrap;
    }
  }
  await writeFileAtomic(vaultPath(), body);
}

/** Decrypt with the password. Throws WrongPasswordError on a bad password. */
export async function loadVault(password: string): Promise<Secrets> {
  const outer = JSON.parse(readFileSync(vaultPath(), 'utf8')) as { wrap: 'dpapi' | 'none'; data: string };
  let envB64 = outer.data;
  if (outer.wrap === 'dpapi') {
    if (!useDpapi()) throw new Error('This vault was created on Windows and can only be opened there.');
    try {
      envB64 = await powershell(PS_UNPROTECT, outer.data);
    } catch {
      throw new Error('This vault belongs to a different Windows user or computer. Delete it and enter your keys again.');
    }
  }
  return open(JSON.parse(Buffer.from(envB64, 'base64').toString('utf8')), password);
}

export function deleteVault(): void {
  if (vaultExists()) rmSync(vaultPath());
  clearAutoUnlock();
}

// ------------------------------------------------------------ unlock on this PC (background mode)
// Background mode has to unlock after a reboot with nobody there. Your app password is kept
// encrypted by Windows (DPAPI) for your Windows account on this PC only; it can't be read on
// another PC or by another Windows user. Removed when background mode is turned off.

export const autoUnlockPath = (): string => join(appHome(), 'unlock.dat');
export const autoUnlockSupported = (): boolean => useDpapi();
export const autoUnlockSaved = (): boolean => existsSync(autoUnlockPath());

/** Save the password for unlocking at startup (checks it opens the vault first). */
export async function saveAutoUnlock(password: string): Promise<void> {
  if (!useDpapi()) throw new Error('Unlocking on this PC needs Windows.');
  await loadVault(password); // throws WrongPasswordError on a bad password
  const b64 = Buffer.from(password, 'utf8').toString('base64');
  const sealed = await powershell(PS_PROTECT, b64);
  if ((await powershell(PS_UNPROTECT, sealed)) !== b64) throw new Error('Windows encryption (DPAPI) did not round-trip on this PC.');
  ensureHome();
  await writeFileAtomic(autoUnlockPath(), JSON.stringify({ wrap: 'dpapi', data: sealed }));
}

/** The saved password, or null when none is saved or Windows can't decrypt it. */
export async function loadAutoUnlock(): Promise<string | null> {
  if (!useDpapi() || !autoUnlockSaved()) return null;
  try {
    const { data } = JSON.parse(readFileSync(autoUnlockPath(), 'utf8')) as { data: string };
    return Buffer.from(await powershell(PS_UNPROTECT, data), 'base64').toString('utf8');
  } catch {
    return null;
  }
}

export function clearAutoUnlock(): void {
  try { if (existsSync(autoUnlockPath())) rmSync(autoUnlockPath()); } catch {}
}

/** Constant-time compare for the "confirm password" field. */
export function samePassword(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
