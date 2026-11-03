/**
 * Optional background mode (Windows): Soccer Edge runs as a Task Scheduler task that starts
 * with Windows (whether or not anyone is signed in), restarts itself if it crashes, and keeps
 * trading with no window open. The window becomes a control panel you can open and close.
 *
 * Pieces:
 *  - A stable copy of the exe in %LOCALAPPDATA%\soccer-edge\bin (so moving or replacing the
 *    downloaded exe doesn't break the task; newer versions copy themselves over it).
 *  - The task "Soccer Edge" runs `soccer-edge.exe service` as you, with your Windows password
 *    (Windows keeps it; the app never stores it), so your files and keys work as normal.
 *  - Your app password kept encrypted for your Windows account (vault.ts: unlock.dat), so the
 *    keys unlock after a reboot.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { appHome, ensureHome } from './config';

export const TASK_NAME = 'Soccer Edge';

export function serviceSupported(): boolean {
  return process.platform === 'win32' && /soccer-edge[^\\/]*\.exe$/i.test(process.execPath);
}

export function stableExePath(): string {
  const base = process.env.LOCALAPPDATA ?? appHome();
  return join(base, 'soccer-edge', 'bin', 'soccer-edge.exe');
}
const stableVersionPath = () => join(dirname(stableExePath()), 'version.txt');

export function windowsUser(): string {
  const u = process.env.USERNAME ?? '';
  const d = process.env.USERDOMAIN ?? '';
  return d ? `${d}\\${u}` : u;
}

async function run(args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe', windowsHide: true } as any);
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out: `${out}\n${err}`.trim() };
}

let installedCache: { at: number; value: boolean } | null = null;

/** Is the background task set up? (cached for a minute; schtasks is slow) */
export async function taskInstalled(fresh = false): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  if (!fresh && installedCache && Date.now() - installedCache.at < 60_000) return installedCache.value;
  const r = await run(['schtasks.exe', '/Query', '/TN', TASK_NAME]).catch(() => ({ code: 1, out: '' }));
  installedCache = { at: Date.now(), value: r.code === 0 };
  return installedCache.value;
}

const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function taskXml(user: string, exe: string): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Soccer Edge: buys PredyGo picks on Kalshi in the background. Turn it off in Soccer Edge Settings.</Description>
  </RegistrationInfo>
  <Triggers>
    <BootTrigger>
      <Enabled>true</Enabled>
      <Delay>PT1M</Delay>
    </BootTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEsc(user)}</UserId>
      <LogonType>Password</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>6</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>"${xmlEsc(exe)}"</Command>
      <Arguments>service</Arguments>
      <WorkingDirectory>${xmlEsc(dirname(exe))}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

/** "0.26.2" > "0.26.1" */
export function newerVersion(a: string, b: string): boolean {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** Put this exe in the stable folder when it's newer than the copy there (or there is none). */
export async function updateStableExe(myVersion: string): Promise<boolean> {
  const dest = stableExePath();
  if (resolve(process.execPath).toLowerCase() === resolve(dest).toLowerCase()) return false;
  let have = '';
  try { have = readFileSync(stableVersionPath(), 'utf8').trim(); } catch {}
  if (existsSync(dest) && have && !newerVersion(myVersion, have)) return false;
  mkdirSync(dirname(dest), { recursive: true });
  // The old copy may still be closing: retry for a few seconds.
  for (let i = 0; ; i++) {
    try { copyFileSync(process.execPath, dest); break; }
    catch (e) { if (i >= 15) throw e; await Bun.sleep(1000); }
  }
  writeFileSync(stableVersionPath(), myVersion);
  return true;
}

/** Create (or replace) the task. Needs your Windows password; Windows stores it, the app doesn't. */
export async function installTask(windowsPassword: string, myVersion: string): Promise<void> {
  if (!serviceSupported()) throw new Error('Background mode needs the Windows app (soccer-edge.exe).');
  await updateStableExe(myVersion);
  ensureHome();
  const xmlPath = join(appHome(), 'task.xml');
  writeFileSync(xmlPath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(taskXml(windowsUser(), stableExePath()), 'utf16le')]));
  try {
    const r = await run(['schtasks.exe', '/Create', '/TN', TASK_NAME, '/XML', xmlPath, '/RU', windowsUser(), '/RP', windowsPassword, '/F']);
    installedCache = null;
    if (r.code !== 0) {
      const msg = r.out.replace(windowsPassword, '***').replace(/\s+/g, ' ').trim();
      throw new Error(/password|user name|logon/i.test(msg) ? `Windows didn't accept that password for ${windowsUser()}. (${msg})` : `Windows couldn't create the task: ${msg}`);
    }
  } finally {
    try { rmSync(xmlPath, { force: true }); } catch {}
  }
}

export async function runTask(): Promise<boolean> {
  const r = await run(['schtasks.exe', '/Run', '/TN', TASK_NAME]).catch(() => ({ code: 1, out: '' }));
  return r.code === 0;
}

export async function deleteTask(): Promise<void> {
  const r = await run(['schtasks.exe', '/Delete', '/TN', TASK_NAME, '/F']);
  installedCache = null;
  if (r.code !== 0 && await taskInstalled(true)) throw new Error(`Windows couldn't remove the task: ${r.out.replace(/\s+/g, ' ').trim()}`);
}
