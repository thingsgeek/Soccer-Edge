#!/usr/bin/env bun
/**
 * soccer-edge: match soccer predictions to Kalshi markets and trade the ones with real edge.
 */
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { focusExistingInstance, openWindowDetached, quitInstance, runningInstance, startGui, waitForInstance } from './gui/server';
import { newerVersion, runTask, serviceSupported, taskInstalled, updateStableExe } from './service';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import {
  appHome, configPath, dailyLeft, ensureHome, effectiveConfig, killSwitchPath, loadConfig, saveConfig,
  type AppConfig,
} from './config';
import { loadCredentials, type KalshiCredentials } from './kalshi/client';
import { getBalance, getPositions } from './kalshi/account';
import { scan } from './pipeline';
import { loadPredictions } from './predictions/sources';
import { buildCalibration, calibrationLabel, MIN_GRADED } from './predictions/calibration';
import { matchPrediction, type MatchResult } from './match/matcher';
import { checkRegion, loadEligibility, regionLabel } from './trade/eligibility';
import { execute, killSwitchActive } from './trade/executor';
import { record, spentToday, uncertainOrders } from './trade/ledger';
import {
  describeProposal, failureLabel, kickoffLocal, PROPOSAL_HEADERS, proposalRows, table,
} from './format';

import { APP_VERSION } from './version';
const VERSION = APP_VERSION;

function parseArgs(argv: string[]) {
  const [cmd = 'help', ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; }
      else flags[key] = true;
    }
  }
  return { cmd, flags };
}

function applyFlags(cfg: AppConfig, flags: Record<string, string | boolean>): AppConfig {
  if (typeof flags.file === 'string') cfg.source = { ...cfg.source, type: 'file', path: flags.file };
  if (flags.demo) cfg.kalshi.env = 'demo';
  return cfg;
}

function requireCreds(cfg: AppConfig): KalshiCredentials {
  const creds = loadCredentials(cfg.kalshi.env, cfg.kalshi.apiKeyId, cfg.kalshi.privateKeyPath);
  if (!creds) throw new Error('Kalshi API key not configured. Run "soccer-edge setup".');
  return creds;
}

async function ask(rl: ReturnType<typeof createInterface>, q: string, def?: string): Promise<string> {
  // Windows "Copy as path" wraps paths in quotes; strip them.
  const a = (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim().replace(/^"(.*)"$/, '$1');
  return a || def || '';
}

// ---------------------------------------------------------------- commands

async function cmdSetup() {
  ensureHome();
  const cfg = loadConfig();
  const rl = createInterface({ input: stdin, output: stdout });
  console.log(`Settings are saved on this computer only: ${configPath()}\n`);
  console.log('Kalshi API key: create one at kalshi.com > Account > API keys. Kalshi shows a Key ID and downloads a private key (.pem) once.');
  cfg.kalshi.env = ((await ask(rl, 'Environment (demo = practice money, prod = real money)', cfg.kalshi.env)) === 'prod' ? 'prod' : 'demo');
  cfg.kalshi.apiKeyId = await ask(rl, 'Kalshi Key ID', cfg.kalshi.apiKeyId);
  cfg.kalshi.privateKeyPath = await ask(rl, 'Path to private key .pem file', cfg.kalshi.privateKeyPath);
  cfg.country = (await ask(rl, 'Country you trade from (2-letter code, e.g. US, CO)', cfg.country ?? 'US')).toUpperCase();
  cfg.state = cfg.country === 'US' ? (await ask(rl, 'US state you trade from (2 letters)', cfg.state)).toUpperCase() : undefined;
  const srcType = await ask(rl, 'Predictions source: predygo (feed URL) or file', cfg.source.type);
  if (srcType === 'predygo') {
    cfg.source = { ...cfg.source, type: 'predygo', url: await ask(rl, 'Feed URL', cfg.source.url) };
    // The feed token is a secret: never written to a file. The window app keeps it in the encrypted vault.
    console.log('Feed token: set it in the PREDYGO_FEED_TOKEN environment variable (it is never saved to a file).');
  } else {
    cfg.source = { ...cfg.source, type: 'file', path: await ask(rl, 'Predictions file (JSON or CSV)', cfg.source.path) };
  }
  const mode = await ask(rl, 'Trade mode: approve (confirm each trade) or auto', cfg.mode);
  cfg.mode = mode === 'auto' ? 'auto' : 'approve';
  rl.close();
  saveConfig(cfg);

  const elig = checkRegion(cfg, await loadEligibility(cfg.eligibilityUrl));
  console.log(elig.ok ? `\n${elig.label}: allowed per the current list.` : `\n${elig.reason}`);
  try {
    const creds = requireCreds(cfg);
    const bal = await getBalance(creds);
    console.log(`Connected to Kalshi (${cfg.kalshi.env}). Cash: $${(bal.cashCents / 100).toFixed(2)}`);
  } catch (e) {
    console.log(`Could not connect to Kalshi yet: ${e instanceof Error ? e.message : e}`);
  }
}

async function cmdCoverage(cfg: AppConfig, flags: Record<string, string | boolean>) {
  const horizon = Number(flags.horizon ?? 168);
  const now = Date.now();
  const all = await loadPredictions(cfg.source);
  const upcoming = all.filter((p) => p.won == null && new Date(p.kickoff).getTime() > now && new Date(p.kickoff).getTime() - now <= horizon * 3600_000);
  console.log(`Checking ${upcoming.length} upcoming predictions (next ${horizon}h) against Kalshi...\n`);
  const results: MatchResult[] = [];
  for (const p of upcoming) results.push(await matchPrediction(p));

  const ok = results.filter((r) => r.ok) as Extract<MatchResult, { ok: true }>[];
  const bad = results.filter((r) => !r.ok) as Extract<MatchResult, { ok: false }>[];
  if (ok.length) {
    console.log(table(['Kickoff', 'Match', 'Pick', 'Kalshi contract'], ok.map((r) => [
      kickoffLocal(r.prediction.kickoff), `${r.prediction.home} v ${r.prediction.away}`, r.prediction.bet, `${r.side.toUpperCase()} ${r.market.ticker}`,
    ])));
  }
  const byReason = new Map<string, number>();
  for (const r of bad) byReason.set(failureLabel(r), (byReason.get(failureLabel(r)) ?? 0) + 1);
  console.log(`\nMatched ${ok.length} of ${results.length}.`);
  for (const [why, n] of [...byReason].sort((a, b) => b[1] - a[1])) console.log(`  ${n} ${why}`);
  const leagues = new Map<string, number>();
  for (const r of bad) if (r.reason === 'league_not_on_kalshi') leagues.set(r.prediction.league, (leagues.get(r.prediction.league) ?? 0) + 1);
  if (leagues.size && flags.verbose) {
    console.log('\nLeagues with no Kalshi mapping:');
    for (const [l, n] of [...leagues].sort((a, b) => b[1] - a[1])) console.log(`  ${n}  ${l}`);
  }
  const missed = bad.filter((r) => r.reason === 'no_event' || r.reason === 'ambiguous_event');
  if (missed.length && flags.verbose) {
    console.log('\nMapped leagues where the game was not found (add team aliases if Kalshi lists it):');
    for (const r of missed) console.log(`  ${r.prediction.league}: ${r.prediction.home} v ${r.prediction.away} ${r.detail ? `(${r.detail})` : ''}`);
  }
}

async function cmdCalibration(cfg: AppConfig) {
  const all = await loadPredictions(cfg.source);
  const cal = buildCalibration(all);
  const rows = [...cal.values()].sort((a, b) => b.graded - a.graded).map((c) => [
    calibrationLabel(c.bet),
    String(c.graded),
    c.avgStatedPct != null ? `${c.avgStatedPct.toFixed(1)}%` : '-',
    `${(c.probability * 100).toFixed(1)}%`,
    c.source,
    c.graded >= MIN_GRADED ? 'yes' : `no (<${MIN_GRADED})`,
  ]);
  console.log(table(['Bet', 'Graded', 'Stated', 'Hit rate used', 'From', 'Tradable'], rows));
  console.log(`\nMode: ${cfg.calibration}. In hit-rate mode the bot prices each pick at its bet type's real hit rate, not the stated %.`);
}

async function cmdScan(cfg: AppConfig, flags: Record<string, string | boolean>) {
  let bankroll = Number(flags.bankroll ?? NaN);
  const creds = loadCredentials(cfg.kalshi.env, cfg.kalshi.apiKeyId, cfg.kalshi.privateKeyPath);
  if (!Number.isFinite(bankroll)) {
    bankroll = creds ? (await getBalance(creds)).cashCents / 100 : 500;
    if (!creds) console.log('No Kalshi key set; sizing against a $500 example bankroll (use --bankroll to change).\n');
  }
  const dailyRemaining = dailyLeft(cfg.risk, spentToday(cfg.kalshi.env));
  const res = await scan(cfg, { bankroll, dailyRemaining, horizonHours: Number(flags.horizon ?? 72) });
  const matched = res.results.filter((r) => r.ok).length;
  console.log(`${res.upcoming.length} upcoming picks, ${matched} matched to Kalshi, ${res.proposals.length} priced.\n`);
  const show = flags.all ? res.proposals : res.proposals.filter((p) => !p.skip || p.edge > 0);
  if (show.length) console.log(table(PROPOSAL_HEADERS, proposalRows(show)));
  else console.log('Nothing with positive edge right now. (Use --all to see every priced pick.)');
  if (res.unpriced.length && flags.all) {
    console.log('\nMatched but not priced:');
    for (const u of res.unpriced) console.log(`  ${u.match.prediction.home} v ${u.match.prediction.away} ${u.match.prediction.bet}: ${u.reason}`);
  }
  const tradable = res.proposals.filter((p) => !p.skip && p.contracts > 0).length;
  console.log(`\n${tradable} trade(s) pass every check. Bankroll used for sizing: $${bankroll.toFixed(2)}.`);
}

async function cmdRun(cfg: AppConfig, flags: Record<string, string | boolean>) {
  if (killSwitchActive()) throw new Error('Kill switch is on. Run "soccer-edge resume" to allow trading again.');
  const elig = checkRegion(cfg, await loadEligibility(cfg.eligibilityUrl));
  if (!elig.ok) throw new Error(elig.reason);
  const creds = requireCreds(cfg);

  if (cfg.mode === 'auto' && !flags.auto) {
    console.log('Config is set to auto mode, but --auto was not passed. Running in approve mode.\n');
    cfg.mode = 'approve';
  }
  const bal = await getBalance(creds);
  const bankroll = bal.cashCents / 100;
  const dailyRemaining = dailyLeft(cfg.risk, spentToday(creds.env));
  console.log(`Kalshi ${creds.env === 'prod' ? 'PRODUCTION (real money)' : 'demo'} | cash $${bankroll.toFixed(2)} | left today $${dailyRemaining.toFixed(2)} | mode ${cfg.mode}\n`);

  // Waiting orders need the app running to look after them (fills, cancels): not from here.
  cfg.risk.restOrders = false;
  const res = await scan(cfg, { bankroll, dailyRemaining, horizonHours: Number(flags.horizon ?? 72) });
  const candidates = res.proposals.filter((p) => !p.skip && p.contracts > 0);
  if (candidates.length === 0) {
    console.log('No trades pass the checks right now.');
    return;
  }
  console.log(table(PROPOSAL_HEADERS, proposalRows(candidates)) + '\n');

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const summary = await execute(cfg, creds, candidates, {
      log: (m) => console.log(m),
      confirm: async (p) => {
        console.log('\n' + describeProposal(p));
        const a = (await rl.question('Place this order? [y/N] ')).trim().toLowerCase();
        return a === 'y' || a === 'yes';
      },
    });
    console.log(`\nDone. Orders sent: ${summary.placed}, filled: ${summary.filled}, spent: $${summary.spent.toFixed(2)}.`);
    if (summary.stoppedReason) console.log(`Stopped early: ${summary.stoppedReason}`);
  } finally {
    rl.close();
  }
}

async function cmdStatus(cfg: AppConfig) {
  console.log(`Data folder: ${appHome()}`);
  console.log(`Environment: ${cfg.kalshi.env} | Region: ${regionLabel(cfg)} | Mode: ${cfg.mode} | Calibration: ${cfg.calibration}`);
  console.log(`Kill switch: ${killSwitchActive() ? 'ON (no orders)' : 'off'}`);
  console.log(`Spent today: $${spentToday(cfg.kalshi.env).toFixed(2)}${cfg.risk.maxDailySpend > 0 ? ` of $${cfg.risk.maxDailySpend}` : ' (no daily limit)'}`);
  const unsure = uncertainOrders(cfg.kalshi.env);
  if (unsure.length) {
    console.log(`Orders with no reply from Kalshi (check them in your Kalshi account): ${unsure.length}`);
    for (const o of unsure) console.log(`  ${o.at}  ${o.side.toUpperCase()} ${o.count} ${o.ticker}  client id ${o.clientOrderId}`);
  }
  const creds = loadCredentials(cfg.kalshi.env, cfg.kalshi.apiKeyId, cfg.kalshi.privateKeyPath);
  if (!creds) { console.log('Kalshi key: not set'); return; }
  const [bal, pos] = await Promise.all([getBalance(creds), getPositions(creds)]);
  console.log(`Cash: $${(bal.cashCents / 100).toFixed(2)} | Portfolio: $${(bal.portfolioValueCents / 100).toFixed(2)} | Open positions: ${pos.size}`);
  for (const [t, n] of pos) console.log(`  ${n > 0 ? 'YES' : 'NO '} ${Math.abs(n)}  ${t}`);
}

function cmdKill(reason?: string) {
  ensureHome();
  writeFileSync(killSwitchPath(), `${new Date().toISOString()} ${reason ?? 'manual'}\n`);
  record({ type: 'kill', at: new Date().toISOString(), reason });
  console.log('Kill switch ON. No new orders will be placed until "soccer-edge resume".');
}

function cmdResume() {
  if (existsSync(killSwitchPath())) rmSync(killSwitchPath());
  record({ type: 'resume', at: new Date().toISOString() });
  console.log('Kill switch off.');
}

const HELP = `soccer-edge ${VERSION}

Usage: soccer-edge <command> [options]

  setup          Save your Kalshi key, state, prediction source and trade mode (local only)
  coverage       Show which upcoming predictions have a matching Kalshi market   [--horizon H] [--verbose]
  calibration    Show each bet type's real hit rate vs its stated confidence
  scan           Price matched picks and show edge and size, without trading      [--all] [--bankroll N]
  run            Scan, then place orders (asks before each one unless --auto)    [--auto]
  status         Balance, open positions, today's spend, kill switch
  kill [reason]  Stop all new orders immediately
  resume         Lift the kill switch

Common options:
  --file PATH    Use a local predictions file (JSON or CSV) instead of the configured source
  --demo         Use Kalshi's demo environment for this command
  --horizon H    Only look at matches kicking off within H hours (default 72; coverage 168)
`;

async function dispatch(cmd: string, flags: Record<string, string | boolean>, rest: string[]): Promise<void> {
  const cfg = effectiveConfig(applyFlags(loadConfig(), flags));
  switch (cmd) {
    case 'setup': return cmdSetup();
    case 'coverage': return cmdCoverage(cfg, flags);
    case 'calibration': return cmdCalibration(cfg);
    case 'scan': return cmdScan(cfg, flags);
    case 'run': return cmdRun(cfg, flags);
    case 'status': return cmdStatus(cfg);
    case 'kill': return cmdKill(rest.filter((a) => !a.startsWith('--')).join(' ') || undefined);
    case 'resume': return cmdResume();
    case 'version': case '--version': console.log(VERSION); return;
    default: console.log(HELP);
  }
}

const MENU: { key: string; label: string; cmd: string; flags?: Record<string, string | boolean> }[] = [
  { key: '1', label: 'Setup (Kalshi key, state, predictions source)', cmd: 'setup' },
  { key: '2', label: 'Coverage: which picks have a Kalshi market', cmd: 'coverage', flags: { verbose: true } },
  { key: '3', label: 'Calibration: real hit rate per bet type', cmd: 'calibration' },
  { key: '4', label: 'Scan: show edge and size, no trading', cmd: 'scan' },
  { key: '5', label: 'Run: place trades (asks before each one)', cmd: 'run' },
  { key: '6', label: 'Status: balance, positions, today\'s spend', cmd: 'status' },
  { key: '7', label: 'Kill switch ON (stop all new orders)', cmd: 'kill' },
  { key: '8', label: 'Kill switch OFF', cmd: 'resume' },
];

/** Shown when the .exe is double-clicked (no arguments), so the window stays open. */
async function interactiveMenu(): Promise<void> {
  const prompt = async (q: string) => {
    // A fresh reader each time: setup and run open their own on the same input.
    const rl = createInterface({ input: stdin, output: stdout });
    try { return (await rl.question(q)).trim(); } finally { rl.close(); }
  };
  for (;;) {
    const cfg = loadConfig();
    console.log(`\n=== soccer-edge ${VERSION} ===`);
    console.log(`Kalshi: ${cfg.kalshi.env === 'prod' ? 'PRODUCTION (real money)' : 'demo'} | Region: ${regionLabel(cfg)} | Mode: ${cfg.mode} | Kill switch: ${killSwitchActive() ? 'ON' : 'off'}`);
    if (!existsSync(configPath())) console.log('First time? Choose 1 to set up.');
    for (const m of MENU) console.log(`  ${m.key}. ${m.label}`);
    console.log('  0. Exit');
    const choice = await prompt('\nChoose: ');
    if (choice === '0' || choice.toLowerCase() === 'q' || choice.toLowerCase() === 'exit') return;
    const item = MENU.find((m) => m.key === choice);
    if (!item) continue;
    console.log('');
    try {
      await dispatch(item.cmd, item.flags ?? {}, []);
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : e}`);
    }
    await prompt('\nPress Enter to return to the menu...');
  }
}

/** No console window in the Windows build, so startup errors go to a log and a message box. */
async function reportStartupError(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  try { ensureHome(); writeFileSync(join(appHome(), 'error.log'), `${new Date().toISOString()} ${e instanceof Error ? e.stack : msg}\n`, { flag: 'a' }); } catch {}
  if (process.platform === 'win32') {
    const ps = `Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show(${JSON.stringify('Soccer Edge could not start:\n\n' + msg).replace(/\$/g, '`$')}, 'Soccer Edge') | Out-Null`;
    const proc = Bun.spawn(['powershell.exe', '-NoProfile', '-Command', ps], { windowsHide: true } as any);
    await proc.exited;
  } else if (process.platform === 'darwin') {
    const text = ('Soccer Edge could not start:\n\n' + msg).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    try { await Bun.spawn(['osascript', '-e', `display dialog "${text}" with title "Soccer Edge" buttons {"OK"} default button "OK" with icon stop`]).exited; } catch {}
    console.error(`Error: ${msg}`);
  } else {
    console.error(`Error: ${msg}`);
  }
}

/**
 * Background mode is set up: make sure the background copy is running (this exe's version or
 * newer), then open a window onto it. Returns false to start normally instead.
 */
async function launchViaService(): Promise<boolean> {
  if (!serviceSupported() || !(await taskInstalled(true))) return false;
  let inst = await runningInstance();
  if (inst && !inst.background) return false; // a normal window copy is running: just focus it below
  if (inst && newerVersion(APP_VERSION, inst.version ?? '0')) {
    // This exe is newer: swap it in.
    await quitInstance(inst);
    inst = null;
  }
  if (!inst) {
    try { await updateStableExe(APP_VERSION); } catch {}
    if (!(await runTask())) return false;
    inst = await waitForInstance((i) => i.background === true, 45_000);
    if (!inst) return false;
  }
  openWindowDetached(`http://127.0.0.1:${inst.port}/?t=${inst.token}`);
  return true;
}

/** Started by Windows (Task Scheduler) in background mode. No windows or message boxes here. */
async function runService() {
  try {
    // Another background copy already running: nothing to do. (A normal window copy may be
    // running when you switch background mode on; it hands over and closes.)
    const inst = await runningInstance();
    if (inst?.background) process.exit(0);
    await startGui({ openWindow: false, background: true });
  } catch (e) {
    try { ensureHome(); writeFileSync(join(appHome(), 'error.log'), `${new Date().toISOString()} background start: ${e instanceof Error ? e.stack : e}\n`, { flag: 'a' }); } catch {}
    process.exit(1); // Task Scheduler restarts it
  }
}

async function launchApp() {
  try {
    if (await launchViaService()) process.exit(0);
    if (await focusExistingInstance()) process.exit(0);
    await startGui();
  } catch (e) {
    await reportStartupError(e);
    process.exit(1);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === 'app') return launchApp();
  if (args[0] === 'service') return runService();
  if (args[0] === '--console') {
    try {
      await interactiveMenu();
    } catch (e) {
      // Keep the window open so the error can be read.
      console.error(`Error: ${e instanceof Error ? e.message : e}`);
      const rl = createInterface({ input: stdin, output: stdout });
      await rl.question('Press Enter to close...');
      rl.close();
    }
    process.exit(0);
  }
  const { cmd, flags } = parseArgs(args);
  await dispatch(cmd, flags, args.slice(1));
}

main().catch((e) => {
  console.error(`Error: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
