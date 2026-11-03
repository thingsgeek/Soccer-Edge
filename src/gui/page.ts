/** The single page the app window shows. No external resources (strict CSP). */
import { TIPS } from './tips';
import { BALL_SVG } from './ball-svg';
import { DISCLAIMER_ACKS, DISCLAIMER_POINTS, DISCLAIMER_SHORT, DISCLAIMER_TITLE } from '../disclaimer';

export function renderPage(token: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Soccer Edge</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,${Buffer.from(BALL_SVG).toString('base64')}">
<style>
  .chatlog { margin-top: 8px; max-height: 360px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; }
  .chatlog:empty { display: none; }
  .chatmsg { padding: 6px 9px; border-radius: 8px; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; line-height: 1.4; }
  .chatmsg.user { background: rgba(37,99,235,.10); align-self: flex-end; max-width: 90%; }
  .chatmsg.assistant { background: var(--line, #eef0f3); max-width: 100%; }

  .rule { padding: 8px 0; border-top: 1px solid var(--line); }
  .rule-top { display: flex; align-items: center; gap: 10px; }
  .rule-top .switch { flex: none; }
  .rule-name { flex: 1; min-width: 0; cursor: help; overflow-wrap: anywhere; }
  .rule-top .badge { flex: none; white-space: nowrap; }
  .rule-sub { margin: 4px 0 0 52px; display: flex; flex-wrap: wrap; gap: 4px 12px; }
  .rule-sub .rule-ed { margin: 0 !important; }
  .rule.dim { opacity: .75; }

  :root {
    --bg: #f4f5f7; --panel: #ffffff; --ink: #1b1f24; --muted: #5d6673; --line: #dfe3e8;
    --accent: #0f6cbd; --accent-ink: #ffffff; --good: #107c41; --bad: #c42b1c; --warn: #9a6700;
    --live: #c42b1c; --demo: #0f6cbd; --chip: #eef1f4; --focus: #0f6cbd55;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #1c1d20; --panel: #26282c; --ink: #e8eaed; --muted: #a0a7b1; --line: #3a3d42;
      --accent: #4ea1f3; --accent-ink: #0b1220; --good: #5fd08a; --bad: #ff7a6b; --warn: #e3b341;
      --live: #ff7a6b; --demo: #4ea1f3; --chip: #303338; --focus: #4ea1f355;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.45 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif; }
  h1 { font-size: 20px; margin: 0; font-weight: 600; letter-spacing: -0.01em; }
  h2 { font-size: 15px; margin: 0 0 10px; font-weight: 600; }
  .wrap { max-width: 1180px; margin: 0 auto; padding: 18px 20px 40px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 18px; }
  .narrow { max-width: 560px; margin: 48px auto; }
  label { display: block; font-weight: 600; margin: 14px 0 5px; }
  .hint { color: var(--muted); font-size: 12.5px; margin-top: 4px; }
  input, select, textarea {
    width: 100%; padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px;
    background: var(--bg); color: var(--ink); font: inherit;
  }
  textarea { font-family: Consolas, "Cascadia Mono", monospace; font-size: 12px; min-height: 120px; resize: vertical; }
  input:focus, select:focus, textarea:focus, button:focus-visible { outline: 3px solid var(--focus); outline-offset: 1px; }
  button {
    font: inherit; font-weight: 600; border-radius: 6px; padding: 8px 14px; cursor: pointer;
    border: 1px solid var(--line); background: var(--panel); color: var(--ink);
  }
  button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
  button.danger { color: var(--bad); }
  button.small { padding: 4px 10px; font-size: 13px; }
  button:disabled { opacity: .5; cursor: default; }
  .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .chip { white-space: nowrap; }
  a { color: var(--accent); }
  .spacer { flex: 1; }
  .err { color: var(--bad); margin-top: 12px; white-space: pre-wrap; }
  .ok { color: var(--good); }
  .badge { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 12px; font-weight: 700; letter-spacing: .02em; }
  .badge.live { background: var(--live); color: #fff; }
  .badge.demo { background: var(--demo); color: #fff; }
  .chip { background: var(--chip); border-radius: 6px; padding: 6px 10px; }
  .chip b { font-variant-numeric: tabular-nums; }
  .banner { border-radius: 6px; padding: 10px 12px; margin: 12px 0 0; border: 1px solid; }
  .banner.bad { border-color: var(--bad); color: var(--bad); }
  .banner.warn { border-color: var(--warn); color: var(--warn); }
  .banner.ok { border-color: var(--good); color: var(--good); }
  .grid { display: grid; grid-template-columns: 1fr 320px; gap: 16px; margin-top: 16px; }
  @media (max-width: 980px) { .grid { grid-template-columns: 1fr; } }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--line); vertical-align: middle; }
  th { color: var(--muted); font-weight: 600; font-size: 12px; white-space: nowrap; }
  td.ko { white-space: nowrap; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  tr.dim td { color: var(--muted); }
  .pos { color: var(--good); font-weight: 600; }
  .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--good); margin-left: 4px; vertical-align: middle; }
  .dot.off { background: var(--warn); }
  .chart { position: relative; }
  .chart svg { display: block; width: 100%; height: auto; overflow: visible; }
  .chart .tip { position: absolute; pointer-events: none; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 4px 8px; font-size: 12px; white-space: nowrap; box-shadow: 0 4px 14px rgba(0,0,0,.15); }
  .chart .axis { fill: var(--muted); font-size: 11px; }
  .badge.won { background: var(--good); color: #fff; } .badge.lost { background: var(--bad); color: #fff; } .badge.open { background: var(--chip); color: var(--ink); }
  .badge { display: inline-block; border-radius: 5px; padding: 1px 7px; font-size: 12px; font-weight: 600; }
  .badge.settling, .badge.unknown { background: var(--warn); color: #fff; }
  .badge.sold { background: var(--chip); color: var(--ink); border: 1px solid var(--muted, #888); }
  .badge.winning { background: transparent; color: var(--good); border: 1px solid var(--good); } .badge.losing { background: transparent; color: var(--bad); border: 1px solid var(--bad); }
  .sparkbtn { border: 0; background: transparent; padding: 0; cursor: pointer; line-height: 0; }
  .sparkbtn:hover svg { outline: 1px solid var(--line); border-radius: 4px; }
  button.icon { padding: 2px 6px; }
  .neg { color: var(--muted); }
  .log { max-height: 420px; overflow: auto; font-size: 12.5px; }
  .log div { padding: 4px 0; border-bottom: 1px dashed var(--line); }
  .log .t { color: var(--muted); font-variant-numeric: tabular-nums; margin-right: 6px; }
  .log .trade { color: var(--good); font-weight: 600; }
  .log .warn { color: var(--warn); }
  .log .error { color: var(--bad); }
  .switch { display: inline-flex; align-items: center; gap: 8px; font-weight: 600; cursor: pointer; }
  .settings input:disabled, .settings select:disabled, select:disabled { opacity: .4; cursor: not-allowed; }
  .switch:has(input:disabled) { opacity: .45; cursor: not-allowed; }
  .settings div:has(> input:disabled) > label, .settings div:has(> select:disabled) > label { opacity: .45; }
  label[title]:not(.switch)::after, .switch[title]::after, summary[title]::after { content: " ⓘ"; color: var(--muted, #94a3b8); font-weight: 400; font-size: 12px; }
  .switch input { flex: 0 0 40px; min-width: 40px; width: 40px; height: 22px; margin: 0; appearance: none; background: var(--line); border-radius: 999px; position: relative; padding: 0; border: 0; cursor: pointer; }
  .switch input::after { content: ""; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: left .15s; }
  .switch input:checked { background: var(--good); }
  .switch input:checked::after { left: 21px; }
  details summary { cursor: pointer; font-weight: 600; }
  .settings { display: grid; grid-template-columns: repeat(2, 1fr); gap: 0 12px; }
  .empty { color: var(--muted); padding: 22px 8px; text-align: center; }
  .hidden { display: none !important; }
  .lockicon { width: 40px; height: 40px; margin-bottom: 8px; color: var(--accent); }

  .pill { display: inline-block; min-width: 46px; text-align: center; padding: 1px 7px; border-radius: 999px; font-size: 11.5px; font-weight: 700; letter-spacing: .03em; }
  .pill.ok { background: color-mix(in srgb, var(--good) 18%, transparent); color: var(--good); }
  .pill.warn { background: color-mix(in srgb, var(--warn) 20%, transparent); color: var(--warn); }
  .pill.fail { background: color-mix(in srgb, var(--bad) 18%, transparent); color: var(--bad); }
  .pill.info { background: var(--chip); color: var(--muted); }
  .overlay { position: fixed; inset: 0; background: rgba(0,0,0,.45); display: flex; align-items: flex-start; justify-content: center; padding: 28px 16px; z-index: 10; overflow: auto; }
  .modal { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; width: min(1040px, 100%); padding: 18px 20px 22px; box-shadow: 0 18px 50px rgba(0,0,0,.3); }
  .dgrid { display: grid; grid-template-columns: 130px 210px 70px 1fr; gap: 0; font-size: 13px; }
  .dgrid > div { padding: 6px 8px; border-bottom: 1px solid var(--line); }
  .dgrid .area { color: var(--muted); font-weight: 600; }
  .pick { border: 1px solid var(--line); border-radius: 8px; margin: 8px 0; }
  .pick summary { padding: 9px 12px; display: flex; gap: 10px; align-items: center; list-style: none; }
  .pick summary::-webkit-details-marker { display: none; }
  .pick summary .sum { color: var(--muted); font-weight: 400; }
  .steps { padding: 0 12px 10px 12px; }
  .steps div { display: grid; grid-template-columns: 70px 120px 1fr; gap: 8px; padding: 5px 0; border-top: 1px dashed var(--line); font-size: 12.5px; }
  .counts span { margin-right: 10px; }
  .need { display: block; font-size: 11px; color: var(--muted); font-weight: 400; }
  .tag { font-size: 11px; color: var(--muted); border: 1px solid var(--line); border-radius: 4px; padding: 0 4px; margin-left: 4px; }
</style>
</head>
<body style="padding-bottom:40px">
<div id="d0-footer" style="position:fixed;left:0;right:0;bottom:0;background:#fffbeb;border-top:1px solid #f59e0b;padding:6px 16px;font-size:12px;text-align:center;z-index:50"></div>
<div class="wrap">

<!-- ============ Disclaimer: must be accepted before anything else ============ -->
<section id="disclaimer" class="card narrow hidden" style="max-width:780px;border:4px solid #b42318">
  <h1 id="d0-title" style="color:#b42318;font-size:24px"></h1>
  <ul id="d0-points" style="line-height:1.55;font-size:15px;padding-left:20px"></ul>
  <div style="background:#fef3f2;border-radius:8px;padding:12px;margin-top:12px">
    <label style="display:flex;gap:10px;align-items:flex-start;justify-content:flex-start;text-align:left;cursor:pointer;margin-bottom:10px"><input type="checkbox" id="d0-ack1" style="width:18px;height:18px;flex:none;margin:2px 0 0"><span id="d0-ack1t" style="font-weight:600;flex:1"></span></label>
    <label style="display:flex;gap:10px;align-items:flex-start;justify-content:flex-start;text-align:left;cursor:pointer"><input type="checkbox" id="d0-ack2" style="width:18px;height:18px;flex:none;margin:2px 0 0"><span id="d0-ack2t" style="font-weight:600;flex:1"></span></label>
  </div>
  <div class="row" style="margin-top:14px"><button class="primary" id="d0-go" disabled>I agree, continue</button><span id="d0-err" class="hint"></span></div>
</section>

<!-- ============ First run: paste keys + choose password ============ -->
<section id="setup" class="card narrow hidden">
  <svg class="lockicon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>
  <h1>Set up Soccer Edge</h1>
  <p class="hint">Your keys are encrypted with your password and stored only on this computer.</p>

  <label for="s-pg">PredyGo API key</label>
  <input id="s-pg" autocomplete="off" spellcheck="false" placeholder="pg_live_...">

  <label for="s-kid">Kalshi Key ID</label>
  <input id="s-kid" autocomplete="off" spellcheck="false" placeholder="e.g. 1a2b3c4d-5e6f-...">
  <div class="hint">Kalshi → Account &amp; security → API keys → Create key.</div>

  <label for="s-pem">Kalshi private key</label>
  <textarea id="s-pem" spellcheck="false" placeholder="-----BEGIN RSA PRIVATE KEY-----&#10;...&#10;-----END RSA PRIVATE KEY-----"></textarea>
  <div class="row" style="margin-top:6px"><button class="small" id="s-pemfile" type="button">Load from .txt or .pem file…</button><input type="file" id="s-pemfile-input" accept=".pem,.txt,.key" class="hidden"></div>

  <label for="s-country">Country you trade from</label>
  <select id="s-country"></select>
  <div id="s-state-wrap">
    <label for="s-state">US state</label>
    <select id="s-state"><option value="">Choose…</option></select>
  </div>
  <div id="s-region-msg" class="hint"></div>

  <label for="s-pw">Password</label>
  <input id="s-pw" type="password" autocomplete="new-password">
  <label for="s-pw2">Confirm password</label>
  <input id="s-pw2" type="password" autocomplete="new-password">
  <div class="hint">You'll enter this each time the app opens. It can't be recovered. If you forget it, you'll paste your keys again.</div>

  <div class="row" style="margin-top:18px"><button class="primary" id="s-go">Save and connect</button><span id="s-busy" class="hint hidden">Checking your keys…</span></div>
  <div id="s-err" class="err"></div>
</section>

<!-- ============ Unlock ============ -->
<section id="unlock" class="card narrow hidden">
  <svg class="lockicon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>
  <h1>Unlock Soccer Edge</h1>
  <div id="u-auto" class="banner ok hidden" style="margin-top:6px"><b>Unlocking automatically…</b><br>Background mode is on, so Soccer Edge unlocks itself with the password saved (encrypted by Windows) on this PC. You don't need to type it; this window opens by itself in a moment. <a href="#" id="u-manual">Type my password instead</a><div class="hint" style="margin-top:6px">To always be asked for the password, turn off "Run in the background" in Settings.</div></div>
  <div id="u-form">
  <label for="u-pw">Password</label>
  <input id="u-pw" type="password" autocomplete="current-password" autofocus>
  <div class="row" style="margin-top:16px"><button class="primary" id="u-go">Unlock</button><span id="u-busy" class="hint hidden">Unlocking…</span></div>
  </div>
  <div id="u-err" class="err"></div>
  <details style="margin-top:22px"><summary>Forgot password?</summary>
    <p class="hint">Deletes your saved keys from this computer so you can enter them again. Your Kalshi and PredyGo accounts aren't affected.</p>
    <div class="row"><input id="u-del" placeholder="Type DELETE" style="max-width:180px"><button class="danger" id="u-forget">Delete saved keys</button></div>
  </details>
</section>

<!-- ============ Main ============ -->
<section id="main" class="hidden">
  <div class="row">
    <h1>Soccer Edge</h1>
    <span id="m-env" class="badge"></span>
    <span class="spacer"></span>
    <span class="chip" id="m-pg" title="">PredyGo <b id="m-pgtier">–</b></span>
    <span class="chip" title="Cash on Kalshi · current value of your open positions">Cash <b id="m-cash">–</b><span id="m-posv"></span></span>
    <span class="chip" title="Spent today, less winnings already paid back today / daily limit">Today <b id="m-spent">–</b> / <b id="m-cap">–</b></span>
    <span class="chip" id="m-region" title="Where you trade from · which PredyGo list the app reads">–</span>
    <button id="m-diag" class="small">Diagnostics</button>
    <span id="m-prochip" class="chip hidden" title="Real-time Kalshi data"></span>
    <button id="m-openpro" class="small" title="Open Kalshi Pro (pro.kalshi.com) in your browser">Kalshi Pro ↗</button>
    <button id="m-export" class="small" title="Save every trade, decision and result to one file you can hand back for tuning">Export data</button>
    <button id="c-xml-export" class="small">Export settings</button>
    <button id="c-xml-import" class="small">Import settings</button>
    <input type="file" id="c-xml-file" accept=".xml,text/xml" class="hidden">
    <button id="m-lock" class="small">Lock</button>
    <button id="m-quit" class="small" title="Stop the app completely (needed before replacing the .exe)">Quit</button>
  </div>
  <div id="m-banners"></div>

  <div class="card" style="margin-top:14px">
    <div class="row">
      <button class="primary" id="m-scan">Scan now</button>
      <label class="switch"><input type="checkbox" id="m-auto"> Auto-trade</label>
      <label class="switch"><input type="checkbox" id="m-pregame"> Pre-game</label>
      <label class="switch"><input type="checkbox" id="m-livesw"> Live</label>
      <label class="switch"><input type="checkbox" id="m-highrisk"> High-risk picks</label>
      <span id="m-autoinfo" class="hint"></span>
      <span class="spacer"></span>
      <button id="m-kill" class="danger">Stop all trading</button>
    </div>
  </div>

  <div class="grid">
    <div>
    <div class="card" id="m-tradescard" style="margin-bottom:16px">
      <div class="row"><h2 style="margin:0">Your trades</h2><span style="margin-left:10px;display:inline-flex;gap:4px"><button id="m-tr-today" class="small">Today</button><button id="m-tr-all" class="small">All trades</button></span><span class="spacer"></span><span id="m-tradesum" class="hint"></span></div>
      <div id="m-balchart" style="margin-top:10px"></div>
      <div id="m-trades" style="margin-top:10px"></div>
    </div>
    <div class="card hidden" id="m-waitcard" style="margin-bottom:16px">
      <div class="row"><h2 style="margin:0">Waiting orders</h2><span class="spacer"></span><span class="hint" title="When Kalshi's asking price is too high, the app leaves a buy order at the most the pick is worth. It fills if a seller comes down to it, and comes off the book before kickoff.">Buying at your price</span></div>
      <div id="m-waiting" style="margin-top:10px"></div>
    </div>
    <div class="card" id="m-scorecard-card" style="margin-bottom:16px">
      <details id="m-scorecard-d"><summary><b>Profit scorecard</b> <span id="m-scorecard-sum" class="hint"></span></summary><div id="m-scorecard" style="margin-top:10px"></div></details>
    </div>
    <div class="card hidden" id="m-procard" style="margin-bottom:16px">
      <div class="row"><h2 style="margin:0">Currently Active Positions</h2><span class="spacer"></span><span id="m-proinfo" class="hint"></span></div>
      <div id="m-positions" style="margin-top:10px"></div>
      <div id="m-fills" class="hint" style="margin-top:8px"></div>
    </div>
    <div class="card">
      <div class="row"><h2 style="margin:0">Pre-game picks</h2><span id="m-prebuy" class="badge open" style="margin-left:8px"></span><span class="spacer"></span><span id="m-scaninfo" class="hint"></span></div>
      <div id="m-table" style="margin-top:10px"><div class="empty">Press <b>Scan now</b> to load today's PredyGo picks and Kalshi prices.</div></div>
      <div id="m-unmatched" class="hint" style="margin-top:10px"></div>
    </div>
    <div class="card" style="margin-top:16px">
      <div class="row">
        <h2 style="margin:0">Live picks</h2>
        <span id="m-livebuy" class="badge open" style="margin-left:8px"></span>
        <span class="spacer"></span><span id="m-liveinfo" class="hint"></span>
      </div>
      <div id="m-live" style="margin-top:10px"></div>
    </div>
    </div>
    <div>
      <div class="card">
        <h2>Activity</h2>
        <div id="m-log" class="log"></div>
      </div>
      <div class="card" style="margin-top:16px" id="ai-card">
        <div class="row"><h2 style="margin:0">AI assistant</h2><span class="spacer"></span><span id="ai-status" class="hint"></span></div>
        <div class="row" style="margin-top:8px;gap:8px"><label for="ai-provider" class="hint" style="margin:0">Assistant</label><select id="ai-provider" style="width:auto" title="Claude (Anthropic key) or ChatGPT (OpenAI key). Only one is used at a time; each keeps its own key."><option value="claude">Claude (Anthropic)</option><option value="chatgpt">ChatGPT (OpenAI)</option></select><span class="hint">one at a time</span></div>
        <div id="ai-setup" class="hidden" style="margin-top:8px">
          <div class="hint" id="ai-setup-hint"></div>
          <div class="settings" style="margin-top:8px">
            <div><label for="ai-key" id="ai-key-label">API key</label><input id="ai-key" type="password" autocomplete="off"></div>
            <div><label for="ai-pw">App password</label><input id="ai-pw" type="password" autocomplete="off"></div>
          </div>
          <div class="row" style="margin-top:8px"><button id="ai-save" class="primary">Save key</button><span id="ai-msg" class="hint"></span></div>
        </div>
        <div id="ai-main" class="hidden" style="margin-top:8px">
          <div id="ai-chat">
            <div class="hint">Ask about your own data: settings, rules, trades and results, today's picks, activity and the latest diagnostics. The AI reads a snapshot of what this window shows (never your keys) and can only answer; it can't change settings or trade.</div>
            <div id="ai-chat-log" class="chatlog"></div>
            <textarea id="ai-chat-in" rows="2" placeholder="e.g. Which bet types are losing money? Is my max price too high?" style="width:100%;margin-top:6px;resize:vertical;font:inherit"></textarea>
            <div class="row" style="margin-top:6px"><button id="ai-chat-send" class="primary small">Ask</button><button id="ai-chat-clear" class="small">Clear chat</button><span id="ai-chat-msg" class="hint"></span></div>
          </div>
          <details style="margin-top:10px"><summary id="ai-sum">AI settings</summary>
            <div class="settings" style="margin-top:8px">
              <div style="grid-column:1/-1"><label class="switch"><input type="checkbox" id="ai-enabled"> <span id="ai-enabled-label">Use the AI check</span></label></div>
              <div><label for="ai-precheck">Before each trade</label><select id="ai-precheck"><option value="veto">Check, and the AI can stop it</option><option value="advise">Check, log only</option><option value="off">Don't check</option></select></div>
              <div><label for="ai-failopen">If the AI doesn't answer</label><select id="ai-failopen"><option value="1">Trade anyway</option><option value="0">Skip the trade</option></select></div>
              <div><label for="ai-checkmodel">Check model</label><select id="ai-checkmodel"></select><div class="hint" id="ai-models-from"></div></div>
              <div><label for="ai-budget">Daily AI budget ($)</label><input id="ai-budget" type="number" min="0.05" max="50" step="0.05"></div>
            </div>
            <div class="row" style="margin-top:8px"><button id="ai-savesettings">Save AI settings</button><span id="ai-smsg" class="hint"></span></div>
            <div class="settings" style="margin-top:12px">
              <div><label for="ai-key2" id="ai-key2-label">Replace key (blank = remove)</label><input id="ai-key2" type="password" autocomplete="off"></div>
              <div><label for="ai-pw2">App password</label><input id="ai-pw2" type="password" autocomplete="off"></div>
            </div>
            <div class="row" style="margin-top:8px"><button id="ai-save2">Update key</button><span id="ai-msg2" class="hint"></span></div>
          </details>
        </div>
      </div>
      <div class="card" style="margin-top:16px">
        <details><summary>Settings</summary>
          <div class="settings">
            <div><label for="c-country">Country</label><select id="c-country"></select></div>
            <div id="c-state-wrap"><label for="c-state">US state</label><select id="c-state"></select></div>
            <div style="grid-column:1/-1"><label class="switch" title="Per-trade limit = Max % of cash per trade x balance. Daily limit = Max open bets % x balance. Open positions are limited by money, not a count. When more picks qualify than the money covers, each stake is cut so all of them get a share. Updated on every scan."><input type="checkbox" id="c-autosize"> Size from my balance (fit as many trades as possible)</label><div class="hint" id="c-autosize-hint"></div></div>
            <div><label for="c-tier" title="Only picks PredyGo sent to this tier's channels. Only your key's own tier and the tiers below it can be chosen: PredyGo sends a key its own tier's picks and nothing more.">PredyGo tier</label><select id="c-tier"></select><div class="hint" id="c-tier-hint"></div></div>
            <div style="display:flex;align-items:end"><label class="switch" title="If auto-trade was on when the app closed (crash, update, restart), turn it back on when you unlock. Saved as soon as you click."><input type="checkbox" id="c-resumeauto"> Keep auto-trade on after a restart</label></div>
            <div><label for="c-livepoll">Live check every (sec)</label><input id="c-livepoll" type="number" min="5" max="60" step="1"></div>
            <div><label for="c-minstated">Minimum PredyGo confidence (%)</label><input id="c-minstated" type="number" min="0" max="99" step="1"></div>
            <div><label for="c-calib">Win chance from</label><select id="c-calib"><option value="hit-rate">Real hit rate of the bet type</option><option value="stated">PredyGo's stated confidence</option></select></div>
            <div style="grid-column:1/-1"><label class="switch" style="font-weight:600"><input type="checkbox" id="c-pro"> Real-time Kalshi data (Kalshi Pro feed)</label><div class="hint">Live prices, positions, profit/loss and fills streamed from Kalshi. Display only; orders still re-check the price when sent.</div></div>
            <div style="grid-column:1/-1" id="c-svc-wrap" class="hidden"><label class="switch" style="font-weight:600"><input type="checkbox" id="c-svc"> Run in the background (starts with Windows, keeps trading with this window closed)</label><div class="hint" id="c-svc-hint"></div>
              <div id="c-svc-form" class="hidden" style="margin-top:8px;display:flex;gap:10px;flex-wrap:wrap;align-items:end">
                <div><label for="c-svc-app">Soccer Edge password</label><input id="c-svc-app" type="password" autocomplete="current-password"></div>
                <div><label for="c-svc-win" id="c-svc-winlabel">Windows password</label><input id="c-svc-win" type="password" autocomplete="off"></div>
                <button id="c-svc-go">Turn on</button><button id="c-svc-cancel" class="small">Cancel</button><span id="c-svc-msg" class="hint"></span>
              </div>
            </div>
            <div><label for="c-interval">Refresh prices every (min)</label><input id="c-interval" type="number" min="2" max="60" step="1"></div>
          </div>
          <div class="row" style="margin-top:12px"><button id="c-save">Save settings</button><span id="c-msg" class="hint"></span></div>
          <h3 style="margin:18px 0 0;font-size:15px" title="Every rule that can stop a pick from being bought: its switch, its values and whether it is on. Hover a rule for what it does.">Rules in force <span id="m-rules-sum" class="hint" style="font-weight:400"></span></h3>
          <div id="m-rules" style="margin-top:6px;font-size:13px"></div>
          <div class="row" style="margin-top:12px"><button id="c-defaults">Restore defaults</button><span class="hint">Every setting above and every rule (switches and values) back to its default.</span></div>
        </details>
      </div>
    </div>
  </div>
</section>
</div>

<div id="chartbox" class="overlay hidden" role="dialog" aria-modal="true" aria-labelledby="c-title">
  <div class="modal" style="width:min(760px,100%)">
    <div class="row"><h1 id="c-title" style="font-size:17px">Price</h1><span class="spacer"></span><button id="c-close" class="small">Close</button></div>
    <div id="c-sub" class="hint"></div>
    <div id="c-chart" style="margin-top:12px"><div class="empty">Loading…</div></div>
  </div>
</div>

<div id="jbox" class="overlay hidden" role="dialog" aria-modal="true" aria-labelledby="j-title">
  <div class="modal" style="width:min(820px,100%)">
    <div class="row"><h1 id="j-title" style="font-size:17px">Trade details</h1><span class="spacer"></span><button id="j-close" class="small">Close</button></div>
    <div id="j-body" style="margin-top:10px;max-height:70vh;overflow:auto"></div>
  </div>
</div>

<div id="diag" class="overlay hidden" role="dialog" aria-modal="true" aria-labelledby="d-title">
  <div class="modal">
    <div class="row">
      <h1 id="d-title">Diagnostics</h1>
      <span id="d-counts" class="counts hint"></span>
      <span class="spacer"></span>
      <button id="d-run" class="small">Run again</button>
      <button id="d-copy" class="small">Copy report</button>
      <button id="d-close" class="small">Close</button>
    </div>
    <div id="d-body" style="margin-top:12px"><div class="empty">Running checks…</div></div>
  </div>
</div>

<script>
const TOKEN = ${JSON.stringify(token)};
// Tooltips for controls without one in the markup (src/gui/tips.ts); labels with a tooltip get an ⓘ.
const TIPS = ${JSON.stringify(TIPS)};
const DISCLAIMER = ${JSON.stringify({ title: DISCLAIMER_TITLE, points: DISCLAIMER_POINTS, acks: DISCLAIMER_ACKS, short: DISCLAIMER_SHORT })};
const AUTO_NOTE = '\\n\\nThis is your decision. The engine will place real orders by the rules you set; nobody else controls or reviews them. Optimize your settings for your own needs first.';
function confirmAuto(msg) { return confirm(msg + AUTO_NOTE); }
function showDisclaimer() {
  if ($('d0-points').children.length === 0) {
    $('d0-title').textContent = DISCLAIMER.title;
    $('d0-points').innerHTML = DISCLAIMER.points.map((p) => '<li style="margin-bottom:8px">' + esc(p) + '</li>').join('');
    $('d0-ack1t').textContent = DISCLAIMER.acks[0];
    $('d0-ack2t').textContent = DISCLAIMER.acks[1];
  }
  show('disclaimer');
}
for (const [id, t] of Object.entries(TIPS)) {
  const el = document.getElementById(id);
  if (!el) continue;
  if (!el.title) el.title = t;
  const lab = document.querySelector('label[for="' + id + '"]') || el.closest('label');
  if (lab && !lab.title) lab.title = t;
}
const $ = (id) => document.getElementById(id);
const fmt$ = (n) => '$' + Number(n).toFixed(2);
const pct = (x, d = 1) => (x * 100).toFixed(d) + '%';
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let state = null;
let shown = '';

async function api(path, body = {}) {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-session': TOKEN }, body: JSON.stringify(body) });
  let data = {};
  try { data = await r.json(); } catch {}
  if (!r.ok) throw new Error(data.error || ('Error ' + r.status));
  return data;
}

function show(id) {
  if (shown === id) return;
  shown = id;
  for (const s of ['disclaimer', 'setup', 'unlock', 'main']) $(s).classList.toggle('hidden', s !== id);
  if (id === 'unlock') setTimeout(() => $('u-pw').focus(), 30);
  if (id === 'setup') setTimeout(() => $('s-pg').focus(), 30);
}

function fillCountries(sel, value) {
  if (sel.options.length === 0) for (const c of state.countries) sel.add(new Option(c.name, c.code));
  sel.value = value || 'US';
}
function syncStateVisibility(countrySel, wrap) { wrap.classList.toggle('hidden', countrySel.value !== 'US'); }
function fillStates(sel, value) {
  if (sel.options.length <= 1) for (const s of state.states) sel.add(new Option(s, s));
  if (value) sel.value = value;
}

let failedPolls = 0;
function deadBanner(on) {
  let b = document.getElementById('dead-banner');
  if (!on) { if (b) b.remove(); return; }
  if (b) return;
  b = document.createElement('div');
  b.id = 'dead-banner';
  b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#b42318;color:#fff;padding:12px 16px;font-weight:600;text-align:center';
  b.textContent = 'Soccer Edge has stopped: nothing is being scanned or traded. Close this window and start Soccer Edge again (auto-trade picks up where it left off).';
  document.body.appendChild(b);
}
async function refresh() {
  try { state = await api('/api/state'); failedPolls = 0; deadBanner(false); }
  catch (e) { if (e instanceof TypeError && ++failedPolls >= 3) deadBanner(true); return; }
  if (!state.disclaimerAccepted) { showDisclaimer(); return; }
  applyDefaultNotes(state.defaults);
  if (!state.unlocked) {
    show(state.vaultExists ? 'unlock' : 'setup');
    // Background mode unlocking itself: say so instead of asking for a password that isn't needed.
    const autoNow = !!state.autoUnlocking && !manualUnlock;
    $('u-auto').classList.toggle('hidden', !autoNow);
    $('u-form').classList.toggle('hidden', autoNow);
    if (!state.vaultExists) {
      if ($('s-country').options.length === 0) { fillCountries($('s-country'), 'US'); syncStateVisibility($('s-country'), $('s-state-wrap')); }
      fillStates($('s-state'));
    }
    return;
  }
  show('main');
  render();
}

const ago = (sec) => sec < 60 ? 'just now' : Math.floor(sec / 60) + ' min ago';

function render() {
  const s = state;
  const live = s.env === 'prod';
  $('m-env').textContent = live ? 'LIVE · real money' : 'DEMO · practice';
  $('m-env').className = 'badge ' + (live ? 'live' : 'demo');
  $('m-cash').textContent = fmt$(s.cash);
  $('m-posv').innerHTML = s.positions ? ' · Positions <b>' + fmt$(s.positions) + '</b>' : '';
  $('m-region').textContent = (s.regionLabel || '–').replace(', United States', ', US') + (s.feedMode === 'all' ? ' · full list' : s.feedMode === 'posted' ? ' · posted picks' : '');
  renderDiag();
  $('m-pgtier').textContent = s.predygo && s.predygo.tier ? s.predygo.tier : 'connected';
  $('m-pg').title = s.predygo && s.predygo.scope ? 'Scope: ' + s.predygo.scope : '';
  $('m-spent').textContent = fmt$(s.spentToday);
  $('m-cap').textContent = s.risk.maxDailySpend > 0 ? fmt$(s.risk.maxDailySpend) : 'no limit';

  const banners = [];
  if (s.killSwitch) banners.push('<div class="banner bad">All trading is stopped. <button class="small" id="m-resume">Allow trading again</button></div>');
  if (s.eligibility) banners.push('<div class="banner bad">' + esc(s.eligibility) + '</div>');
  if (s.scan && s.scan.stale && !s.busy) banners.push('<div class="banner warn">These prices are ' + Math.floor(s.scan.ageSec / 60) + ' minutes old, so placing is paused. <button class="small" id="m-rescan">Scan now</button></div>');
  if (s.uncertain) banners.push('<div class="banner warn">' + s.uncertain + ' order(s) got no reply from Kalshi and may have filled. Check your Kalshi portfolio.</div>');
  $('m-banners').innerHTML = banners.join('');
  if ($('m-resume')) $('m-resume').onclick = () => act('/api/resume');
  if ($('m-rescan')) $('m-rescan').onclick = () => act('/api/scan');

  $('m-auto').checked = s.auto.on;
  $('m-auto').disabled = s.killSwitch || !!s.eligibility;
  const nextAt = s.auto.nextAt ? new Date(s.auto.nextAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'now';
  $('m-autoinfo').textContent = s.auto.on
    ? 'Every ' + s.auto.intervalMin + ' min · next check ' + nextAt + ' · runs while this window is open'
    : 'Off: you place each trade yourself';
  $('m-kill').disabled = s.killSwitch;
  // Same pill as Live picks: is anything here bought without a click?
  {
    const preOn = !s.trading || s.trading.pregame !== false, autoBuy = preOn && s.auto.on && !s.killSwitch;
    $('m-prebuy').textContent = autoBuy ? 'Buying automatically (Auto-trade switch on)' : !preOn ? 'Shown only: click Place (Pre-game switch off)' : s.killSwitch ? 'Shown only (kill switch on)' : 'Shown only: click Place (Auto-trade switch off)';
    $('m-prebuy').className = 'badge ' + (autoBuy ? 'won' : 'open');
    $('m-prebuy').title = 'Pre-game picks are bought automatically only with Auto-trade on and the Pre-game switch on (top bar).';
  }
  $('m-scan').disabled = s.busy;
  $('m-scan').textContent = s.busy ? 'Working…' : 'Scan now';

  if (s.scan) {
    $('m-scaninfo').textContent = s.scan.upcoming + ' upcoming picks · ' + s.scan.matched + ' on Kalshi · prices from ' + new Date(s.scan.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + ' (' + ago(s.scan.ageSec) + ')' + (s.busy ? ' · refreshing…' : s.auto.nextAt ? ' · next refresh ' + nextAt : '');
    $('m-scaninfo').className = 'hint' + (s.scan.stale ? ' neg' : '');
    const rows = [...s.scan.rows].sort((a, b) => (b.tradable - a.tradable) || (b.edge - a.edge));
    $('m-table').innerHTML = rows.length ? '<table><thead><tr><th>Kickoff</th><th>Match</th><th>Pick → Kalshi</th><th class="num">Win %</th><th class="num">Price</th><th class="num">Edge</th><th class="num">Stake</th><th></th></tr></thead><tbody>' +
      rows.map((r) => '<tr class="' + (r.tradable ? '' : 'dim') + '">' +
        '<td class="ko">' + new Date(r.kickoff).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) + '</td>' +
        '<td>' + esc(r.match) + '<div class="hint">' + esc(r.league) + '</div></td>' +
        '<td>' + esc(r.pick) + ' <button class="small icon" data-kalshi="' + esc(r.ticker) + '" title="Open this game on Kalshi: comments, chart and rules (in your browser)">💬</button><div class="hint">' + esc(r.contract) + '</div></td>' +
        '<td class="num">' + pct(r.probability, 0) + '</td>' +
        '<td class="num">' + (r.rest ? '<span title="Kalshi asks ' + Math.round(r.rest.ask * 100) + '¢, more than this pick is worth. The app bids ' + Math.round(r.rest.price * 100) + '¢ (worth up to ' + Math.round(r.rest.maxPay * 100) + '¢) and waits.">bid ' + Math.round(r.rest.price * 100) + '¢</span><div class="hint">ask ' + Math.round(r.rest.ask * 100) + '¢</div>' : r.live && Math.round(r.live.ask * 100) !== Math.round(r.ask * 100) ? '<span title="Live price now (scan price ' + Math.round(r.ask * 100) + '¢)">' + Math.round(r.live.ask * 100) + '¢<span class="dot"></span></span>' : Math.round(r.ask * 100) + '¢' + (r.live ? '<span class="dot" title="Live"></span>' : '')) + '</td>' +
        '<td class="num ' + (r.required != null && r.edge >= r.required ? 'pos' : 'neg') + '">' + (r.edge > 0 ? '+' : '') + pct(r.edge) + (r.required != null ? '<span class="need">need ' + pct(r.required) + '</span>' : '') + '</td>' +
        '<td class="num">' + (r.tradable ? r.contracts + ' · ' + fmt$(r.cost) : '–') + '</td>' +
        '<td>' + (r.tradable ? '<button class="small primary" data-place="' + esc(r.id) + '"' + (s.killSwitch || s.eligibility || s.busy || s.scan.stale ? ' disabled' : '') + (r.rest ? ' title="Leave a buy order at ' + Math.round(r.rest.price * 100) + '¢ until ' + new Date(r.rest.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + '"' : '') + '>' + (r.rest ? 'Bid ' + Math.round(r.rest.price * 100) + '¢' : 'Place') + '</button>' + (r.autoNote ? '<div class="hint" style="color:#b45309">Auto-buy skipped: ' + esc(r.autoNote) + '</div>' : '') : (r.status === 'waiting' && r.waiting ? '<span class="ok" title="A buy order is on the book at your price">⏳ Waiting at ' + Math.round(r.waiting.price * 100) + '¢</span>' + (r.waiting.by === 'claude' ? ' <span class="hint">(Claude)</span>' : '') + '<div class="hint">' + (r.waiting.filled ? r.waiting.filled + ' of ' + r.waiting.count + ' filled · ' : '') + (r.waiting.until ? 'until ' + new Date(r.waiting.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '') + '</div>' : r.status === 'traded' ? '<span class="ok">✓ Traded</span>' : r.status === 'holding' ? '<span class="ok">✓ In portfolio</span>' : '<span class="hint">' + esc(r.status) + '</span>' + (r.maxForce > 0 ? '<div><button class="small" data-force="' + esc(r.id) + '"' + (s.killSwitch || s.eligibility || s.busy || s.scan.stale ? ' disabled' : '') + ' title="Override the edge/price checks for this pick">Place anyway</button></div>' : ''))) + '</td>' +
        '</tr>').join('') + '</tbody></table>'
      : '<div class="empty">None of the upcoming picks have a Kalshi market right now.</div>';
    const um = Object.entries(s.scan.unmatched).map(([k, v]) => k + ' (' + v + ')').join(' · ');
    $('m-unmatched').innerHTML = um ? 'Skipped picks: ' + esc(um) + ' · <a href="#" id="m-why">Why?</a>' : '';
    if ($('m-why')) $('m-why').onclick = (e) => { e.preventDefault(); openDiag(true); };
    document.querySelectorAll('[data-place]').forEach((b) => b.onclick = () => place(b.dataset.place));
    document.querySelectorAll('[data-force]').forEach((b) => b.onclick = () => placeAnyway(b.dataset.force));
    document.querySelectorAll('#m-table [data-kalshi]').forEach((b) => b.onclick = () => openKalshi(b.dataset.kalshi));
  }

  renderLive(s);
  renderPro(s);
  renderService(s);
  renderTrades(s);
  renderAi(s);
  renderWaiting(s);
  renderRules(s);
  renderScorecard(s);

  $('m-log').innerHTML = s.log.map((l) => '<div><span class="t">' + new Date(l.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + '</span><span class="' + l.level + '">' + esc(l.msg) + '</span></div>').join('') || '<div class="hint">Nothing yet.</div>';

  if (!document.activeElement || !document.activeElement.closest('.settings')) {
    fillCountries($('c-country'), s.country);
    fillStates($('c-state'), s.usState);
    syncStateVisibility($('c-country'), $('c-state-wrap'));
    $('c-interval').value = s.auto.intervalMin;
    $('c-minstated').value = s.minStatedPct ?? 0;
    $('c-calib').value = s.calibrationMode || 'hit-rate';
    {
      // Tiers come from the PredyGo feed (each pick's "tiers" list); the saved choice and
      // "Any tier" are always offered.
      // The API (and so trading) is only available on Pro and Elite; Free is never offered.
      // API access (and so trading) is a Pro/Elite add-on; admin keys see everything.
      // A Pro key is only offered Pro (PredyGo sends a key its own tier's picks and nothing more).
      const keyTier = String((s.predygo && s.predygo.tier) || '').toLowerCase();
      const allowed = keyTier === 'pro' ? ['pro'] : null;
      const names = allowed || [...new Set(['elite', 'pro', ...(s.tiersSeen || []), s.tier || 'elite'].filter((t) => t && t !== 'any' && t !== 'free'))];
      const admin = keyTier === 'admin';
      const want = names.join(',') + (admin ? ',admin' : '');
      if ($('c-tier').dataset.k !== want) {
        $('c-tier').dataset.k = want;
        $('c-tier').innerHTML = names.map((t) => '<option value="' + esc(t) + '">' + esc(t.charAt(0).toUpperCase() + t.slice(1)) + '</option>').join('') + (admin || s.tier === 'any' ? '<option value="any">Everything (admin key)</option>' : '');
      }
      $('c-tier').value = s.tier || 'elite';
      const fed = (s.tiersSeen || []).filter((t) => t !== 'free');
      $('c-tier-hint').textContent = fed.length ? 'From your PredyGo feed: ' + fed.join(', ') + ' (Free has no API access)' : 'No tier info from PredyGo yet (scan first).';
    }
    $('m-highrisk').checked = !!s.risk.tradeHighRisk;
    $('c-resumeauto').checked = !!s.resumeAuto;
    $('c-autosize').checked = s.risk.autoSize !== false;
    autoSizeView(s);
    $('c-livepoll').value = s.live.pollSec;
  }
}

async function act(path, body) {
  try { await api(path, body); } catch (e) { alertMsg(e.message); }
  await refresh();
}
function noteMsg(m) { const d = document.createElement('div'); d.className = 'banner ok'; d.textContent = m; $('m-banners').prepend(d); setTimeout(() => d.remove(), 7000); }
function alertMsg(m) { const d = document.createElement('div'); d.className = 'banner bad'; d.textContent = m; $('m-banners').prepend(d); setTimeout(() => d.remove(), 9000); }

async function place(id) {
  const r = state.scan.rows.find((x) => x.id === id);
  if (!r) return;
  const msg = 'Place this trade on Kalshi ' + (state.env === 'prod' ? '(REAL MONEY)' : '(demo)') + '?\\n\\n' + r.match + '\\n' + r.pick + ' → ' + r.contract + '\\n' + r.contracts + ' contracts at up to ' + Math.round(r.ask * 100) + '¢ ≈ ' + fmt$(r.cost) + ' incl. fees';
  if (!confirm(msg)) return;
  await act('/api/place', { id });
}

const cents = (x) => (x == null || !isFinite(x) ? '–' : Math.round(x * 100) + '¢');
const money = (x) => (x == null || !isFinite(x) ? '–' : (x < 0 ? '−$' : '$') + Math.abs(x).toFixed(2));
function renderService(s) {
  const S = s.service;
  $('c-svc-wrap').classList.toggle('hidden', !S || !S.supported);
  if (!S || !S.supported) return;
  const formOpen = !$('c-svc-form').classList.contains('hidden');
  if (!formOpen) $('c-svc').checked = !!S.installed;
  $('c-svc-winlabel').textContent = 'Windows password for ' + (S.user || 'this account');
  $('c-svc-hint').textContent = S.installed && S.background
    ? 'On: running in the background as ' + S.user + '. It starts with Windows (even when nobody signs in), unlocks itself and restarts if it crashes. Closing this window does not stop it; Stop all trading or Quit do.' + (S.autoUnlock ? '' : ' Saved unlock missing: turn this off and on again.')
    : S.installed ? 'On: starts with Windows. This window is a normal copy; the background copy takes over when you open Soccer Edge again or Windows restarts.'
    : 'Off: Soccer Edge runs only while this window is open. Turn on to keep trading after you close it and after Windows restarts.';
}

function renderPro(s) {
  const P = s.pro || { on: false };
  if (document.activeElement !== $('c-pro')) $('c-pro').checked = !!P.on;
  $('m-procard').classList.toggle('hidden', !P.on);
  const chip = $('m-prochip');
  chip.classList.toggle('hidden', !P.on);
  if (!P.on) { pollEvery(4000); return; }
  pollEvery(1500);
  const live = P.status === 'live';
  chip.innerHTML = '<span class="dot' + (live ? '' : ' off') + '"></span> ' + (live ? 'Live' : P.status === 'reconnecting' ? 'Reconnecting…' : 'Connecting…');
  chip.title = P.error ? 'Kalshi stream: ' + P.error : 'Real-time Kalshi data';
  $('m-proinfo').textContent = live ? (P.positions.length + ' open · updated ' + (P.ageSec == null ? '–' : P.ageSec + 's ago')) : (P.error ? 'Waiting for Kalshi: ' + P.error : 'Connecting to Kalshi…');
  const rows = P.positions || [];
  $('m-positions').innerHTML = rows.length
    ? '<table><thead><tr><th>Market</th><th>Side</th><th class="num">Qty</th><th class="num">Avg</th><th class="num">Bid / Ask</th><th class="num">Last</th><th class="num">Value</th><th class="num">P/L</th></tr></thead><tbody>' +
      rows.map((r) => '<tr>' +
        '<td>' + esc(r.title) + '<div class="hint">' + esc(r.ticker) + (r.tape && r.tape.length ? ' · tape ' + r.tape.slice(0, 3).map((t) => cents(t.yesPrice) + '×' + Math.round(t.count)).join(' ') : '') + '</div></td>' +
        '<td>' + r.side.toUpperCase() + '</td>' +
        '<td class="num">' + Math.round(r.contracts) + '</td>' +
        '<td class="num">' + cents(r.avg) + '</td>' +
        '<td class="num">' + (r.decided ? '<span class="hint" title="' + (r.decided === 'game over' ? 'The game is over: Kalshi emptied the order book, so this is valued at the last trade until the result posts.' : 'Kalshi has the result; it pays out when the market settles.') + '">' + r.decided + '</span>' : cents(r.bid) + ' / ' + cents(r.ask)) + '</td>' +
        '<td class="num">' + cents(r.last) + '</td>' +
        '<td class="num">' + money(r.value) + '</td>' +
        '<td class="num ' + (r.pnl > 0 ? 'pos' : r.pnl < 0 ? 'neg' : '') + '">' + (r.pnl > 0 ? '+' : '') + money(r.pnl) + '</td>' +
        '</tr>').join('') +
      (P.totals ? '<tr><td colspan="6"><b>Total</b> (cost ' + money(P.totals.cost) + ')</td><td class="num"><b>' + money(P.totals.value) + '</b></td><td class="num ' + (P.totals.pnl > 0 ? 'pos' : P.totals.pnl < 0 ? 'neg' : '') + '"><b>' + (P.totals.pnl > 0 ? '+' : '') + money(P.totals.pnl) + '</b></td></tr>' : '') +
      '</tbody></table>'
    : '<div class="hint">No open positions.</div>';
  const f = P.fills || [];
  $('m-fills').innerHTML = f.length ? 'Recent fills: ' + f.slice(0, 5).map((x) => esc(new Date(x.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + ' ' + Math.round(x.count) + '× ' + x.side.toUpperCase() + ' ' + x.ticker + ' @ ' + cents(x.price))).join(' · ') : '';
}
// ---- charts (inline SVG, one series, hover crosshair + tooltip)
function lineChart(el, pts, o) {
  o = o || {};
  if (!pts || pts.length < 2) { el.innerHTML = '<div class="hint">' + (o.empty || 'Not enough data yet.') + '</div>'; return; }
  const W = 700, H = o.height || 180, L = 44, R = 12, T = 10, B = 24;
  const xs = pts.map((p) => p.t).concat((o.marks || []).map((m) => m.t)), ys = pts.map((p) => p.v).concat(o.ref != null ? [o.ref] : []);
  let x0 = Math.min(...xs), x1 = Math.max(...xs); if (x1 === x0) x1 = x0 + 1;
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  const pad = (y1 - y0) * 0.12 || (o.money ? 1 : 0.05); y0 -= pad; y1 += pad;
  if (!o.money) { y0 = Math.max(0, y0); y1 = Math.min(1, y1); }
  const X = (t) => L + ((t - x0) / (x1 - x0)) * (W - L - R), Y = (v) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
  const fmtV = o.money ? (v) => '$' + v.toFixed(2) : (v) => Math.round(v * 100) + '¢';
  const span = x1 - x0;
  const fmtT = (t) => { const d = new Date(t); return span > 2 * 86400e3 ? d.toLocaleDateString([], { month: 'short', day: 'numeric' }) : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
  const grid = [0, 0.5, 1].map((f) => { const v = y0 + f * (y1 - y0); return '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(v) + '" y2="' + Y(v) + '" stroke="var(--line)" stroke-width="1"/><text class="axis" x="' + (L - 6) + '" y="' + (Y(v) + 4) + '" text-anchor="end">' + fmtV(v) + '</text>'; }).join('');
  const xt = [x0, (x0 + x1) / 2, x1].map((t, i) => '<text class="axis" x="' + X(t) + '" y="' + (H - 6) + '" text-anchor="' + ['start', 'middle', 'end'][i] + '">' + fmtT(t) + '</text>').join('');
  const path = pts.map((p, i) => (i ? 'L' : 'M') + X(p.t).toFixed(1) + ' ' + Y(p.v).toFixed(1)).join(' ');
  const ref = o.ref != null ? '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(o.ref) + '" y2="' + Y(o.ref) + '" stroke="var(--muted)" stroke-width="1.5" stroke-dasharray="5 4"/><text class="axis" x="' + (W - R) + '" y="' + (Y(o.ref) - 5) + '" text-anchor="end">' + esc(o.refLabel || '') + ' ' + fmtV(o.ref) + '</text>' : '';
  const markers = (o.marks || []).map((m) => '<circle cx="' + X(m.t) + '" cy="' + Y(m.v) + '" r="4.5" fill="var(--accent)" stroke="var(--panel)" stroke-width="2"/>').join('');
  const last = pts[pts.length - 1];
  el.innerHTML = '<div class="chart"><svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(o.label || 'chart') + '">' + grid + xt + ref +
    '<path d="' + path + '" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>' + markers +
    '<circle cx="' + X(last.t) + '" cy="' + Y(last.v) + '" r="4" fill="var(--accent)" stroke="var(--panel)" stroke-width="2"/>' +
    '<line class="xh" x1="0" x2="0" y1="' + T + '" y2="' + (H - B) + '" stroke="var(--muted)" stroke-width="1" visibility="hidden"/><circle class="xp" r="4" fill="var(--accent)" stroke="var(--panel)" stroke-width="2" visibility="hidden"/>' +
    '<rect x="' + L + '" y="0" width="' + (W - L - R) + '" height="' + H + '" fill="transparent" class="hit"/></svg><div class="tip" style="display:none"></div></div>';
  const svg = el.querySelector('svg'), tip = el.querySelector('.tip'), xh = el.querySelector('.xh'), xp = el.querySelector('.xp');
  el.querySelector('.hit').addEventListener('mousemove', (e) => {
    const r = svg.getBoundingClientRect(), px = ((e.clientX - r.left) / r.width) * W;
    const t = x0 + ((px - L) / (W - L - R)) * (x1 - x0);
    let best = pts[0]; for (const p of pts) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    xh.setAttribute('x1', X(best.t)); xh.setAttribute('x2', X(best.t)); xh.setAttribute('visibility', 'visible');
    xp.setAttribute('cx', X(best.t)); xp.setAttribute('cy', Y(best.v)); xp.setAttribute('visibility', 'visible');
    tip.style.display = 'block';
    tip.textContent = new Date(best.t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' · ' + fmtV(best.v);
    const left = (X(best.t) / W) * r.width; tip.style.left = Math.min(Math.max(0, left - tip.offsetWidth / 2), r.width - tip.offsetWidth) + 'px'; tip.style.top = '-6px';
  });
  el.querySelector('.hit').addEventListener('mouseleave', () => { tip.style.display = 'none'; xh.setAttribute('visibility', 'hidden'); xp.setAttribute('visibility', 'hidden'); });
}

/** Small inline chart: price line, dashed line at the price paid, last point marked. */
function sparkSvg(vals, paid, now) {
  const v = (vals || []).slice();
  if (now != null && isFinite(now)) v.push(now);
  if (v.length < 2) return '<span class="hint">–</span>';
  const W = 96, H = 26, P = 3;
  const lo = Math.min(...v, paid), hi = Math.max(...v, paid), span = hi - lo || 0.01;
  const X = (i) => P + (i / (v.length - 1)) * (W - 2 * P), Y = (x) => P + (1 - (x - lo) / span) * (H - 2 * P);
  const up = v[v.length - 1] >= paid;
  return '<svg class="spark" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" role="img" aria-label="Price since the trade, now ' + Math.round(v[v.length - 1] * 100) + ' cents vs ' + Math.round(paid * 100) + ' paid">' +
    '<line x1="' + P + '" x2="' + (W - P) + '" y1="' + Y(paid) + '" y2="' + Y(paid) + '" stroke="var(--muted)" stroke-width="1" stroke-dasharray="3 3"/>' +
    '<path d="' + v.map((x, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(x).toFixed(1)).join(' ') + '" fill="none" stroke="' + (up ? 'var(--good)' : 'var(--bad)') + '" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>' +
    '<circle cx="' + X(v.length - 1) + '" cy="' + Y(v[v.length - 1]) + '" r="2.6" fill="' + (up ? 'var(--good)' : 'var(--bad)') + '"/></svg>';
}
/** Kalshi's page for a market's game (comments, chart, rules), opened in your normal browser. */
function kalshiUrl(ticker) {
  const parts = String(ticker).split('-');
  return 'https://kalshi.com/markets/' + parts[0].toLowerCase() + '/m/' + (parts[0] + '-' + (parts[1] || '')).toLowerCase();
}
function openKalshi(ticker) { api('/api/openurl', { url: kalshiUrl(ticker) }).catch((e) => alertMsg(e.message)); }

let tradesView = (() => { try { return localStorage.getItem('tradesView') === 'all' ? 'all' : 'today'; } catch { return 'today'; } })();
function setTradesView(v) { tradesView = v; try { localStorage.setItem('tradesView', v); } catch {} if (state) renderTrades(state); }
function renderTrades(s) {
  const T = s.trades || { rows: [], totals: null };
  function tradeBadge(r) {
    if (r.decided === 'won') return '<span class="badge won" title="The bet condition is met (e.g. the goal is in). Kalshi pays out when it settles the market.">Won ✓</span>';
    if (r.decided === 'lost') return '<span class="badge lost" title="The bet condition can no longer be met. Kalshi settles it after the game.">Lost</span>';
    if (r.status === 'open' && r.outlook === 'winning') return '<span class="badge winning" title="Kalshi prices this at 90c+: very likely to win, not decided yet.">Winning</span>';
    if (r.status === 'open' && r.outlook === 'losing') return '<span class="badge losing" title="Kalshi prices this at 10c or less: very likely to lose, not decided yet.">Losing</span>';
    if (r.status === 'sold') return '<span class="badge sold" title="Closed on Kalshi before it settled (sold, or netted off with the other side). Value and P/L are what you got back.">Sold on Kalshi</span>';
    return '<span class="badge ' + r.status + '">' + ({ open: 'Open', won: 'Won', lost: 'Lost', settling: 'Settling', unknown: 'Check' }[r.status] || '?') + '</span>' + (r.soldQty ? '<div class="hint">' + r.soldQty + ' sold on Kalshi</div>' : '');
  }
  // Today (default) or all trades; the totals count only the trades shown.
  const all = T.rows || [];
  const day = (iso) => new Date(iso).toLocaleDateString();
  const today = day(new Date().toISOString());
  const rows = tradesView === 'all' ? all : all.filter((r) => day(r.at) === today);
  const isOpen = (r) => r.status === 'open' || r.status === 'settling';
  const hiddenOpen = tradesView === 'all' ? 0 : all.filter((r) => isOpen(r) && day(r.at) !== today).length;
  $('m-tr-today').className = 'small' + (tradesView === 'all' ? '' : ' primary');
  $('m-tr-all').className = 'small' + (tradesView === 'all' ? ' primary' : '');
  const sumOf = (rs, k) => +rs.reduce((a, r) => a + (Number(r[k]) || 0), 0).toFixed(2);
  const op = rows.filter(isOpen), st = rows.filter((r) => r.status === 'won' || r.status === 'lost' || r.status === 'sold');
  const t = tradesView === 'all' ? T.totals : T.totals ? {
    open: op.length, openCost: sumOf(op, 'cost'), openValue: sumOf(op, 'value'), openPnl: sumOf(op, 'pnl'),
    decidedWon: op.filter((r) => r.decided === 'won').length, decidedLost: op.filter((r) => r.decided === 'lost').length,
    won: st.filter((r) => r.status === 'won').length, lost: st.filter((r) => r.status === 'lost').length, sold: st.filter((r) => r.status === 'sold').length,
    settledPnl: sumOf(st, 'pnl'),
  } : null;
  const pnlSpan = (v) => '<span class="' + (v > 0 ? 'pos' : v < 0 ? 'neg' : '') + '">' + (v > 0 ? '+' : '') + money(v) + '</span>';
  if (t && tradesView === 'all') {
    const decided = t.won + t.lost;
    $('m-tradesum').innerHTML = '<b>Overall' + (t.since ? ' since ' + new Date(t.since).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '') + ':</b> ' + t.won + ' won – ' + t.lost + ' lost' + (decided ? ' (' + Math.round(100 * t.won / decided) + '% won)' : '') + (t.sold ? ' · ' + t.sold + ' sold' : '') + ' · P/L ' + pnlSpan(t.settledPnl) + (t.open ? ' | ' + t.open + ' open · staked ' + money(t.openCost) + ' · ' + pnlSpan(t.openPnl) : '');
  } else
  $('m-tradesum').innerHTML = t ? (t.open + ' open · staked ' + money(t.openCost) + ' · worth ' + money(t.openValue) + ' · <span class="' + (t.openPnl > 0 ? 'pos' : t.openPnl < 0 ? 'neg' : '') + '">' + (t.openPnl > 0 ? '+' : '') + money(t.openPnl) + '</span>' + (t.decidedWon || t.decidedLost ? ' (' + (t.decidedWon ? t.decidedWon + ' already won' : '') + (t.decidedWon && t.decidedLost ? ', ' : '') + (t.decidedLost ? t.decidedLost + ' already lost' : '') + ')' : '') + ' | settled ' + t.won + 'W–' + t.lost + 'L' + (t.sold ? ' · ' + t.sold + ' sold' : '') + ' · <span class="' + (t.settledPnl > 0 ? 'pos' : t.settledPnl < 0 ? 'neg' : '') + '">' + (t.settledPnl > 0 ? '+' : '') + money(t.settledPnl) + '</span>') : '';
  const bh = s.balanceHistory || [];
  if (!$('m-balchart').dataset.n || +$('m-balchart').dataset.n !== bh.length) {
    $('m-balchart').dataset.n = bh.length;
    lineChart($('m-balchart'), bh, { money: true, height: 150, label: 'Account balance over time', empty: 'Balance chart: builds up as the app runs (cash + positions, recorded on every scan).' });
  }
  const key = tradesView + JSON.stringify(rows.map((r) => [r.ticker, r.at, r.now, r.status, (r.spark || []).length])) + hiddenOpen;
  if ($('m-trades').dataset.k === key) return;
  $('m-trades').dataset.k = key;
  $('m-trades').innerHTML = rows.length
    ? '<table><thead><tr><th>Placed</th><th>Trade</th><th>Trend</th><th class="num">Qty</th><th class="num">Paid</th><th class="num">Now</th><th class="num">Staked</th><th class="num">Value</th><th class="num">P/L</th><th></th></tr></thead><tbody>' +
      rows.map((r, i) => '<tr>' +
        '<td class="ko">' + new Date(r.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + '</td>' +
        '<td>' + esc(r.match || r.title) + '<div class="hint">' + (r.bet ? esc(r.bet) + ' → ' : '') + r.side.toUpperCase() + ' · ' + esc(r.match ? r.title : r.ticker) + ' · ' + r.source + '</div></td>' +
        '<td><button class="sparkbtn" data-chart="' + i + '" title="Open the full chart">' + sparkSvg(r.spark, r.paid, r.status === 'open' || r.status === 'settling' ? r.now : null) + '</button></td>' +
        '<td class="num">' + Math.round(r.contracts) + '</td>' +
        '<td class="num">' + cents(r.paid) + '</td>' +
        '<td class="num">' + cents(r.now) + (r.liveTick && r.status === 'open' ? '<span class="dot" title="Live"></span>' : '') + '</td>' +
        '<td class="num">' + money(r.cost) + '</td>' +
        '<td class="num">' + money(r.value) + '</td>' +
        '<td class="num ' + (r.pnl > 0 ? 'pos' : r.pnl < 0 ? 'neg' : '') + '">' + (r.pnl == null ? '–' : (r.pnl > 0 ? '+' : '') + money(r.pnl)) + '</td>' +
        '<td>' + tradeBadge(r) + ' <button class="small icon" data-journal="' + esc(r.ticker) + '" title="Trade details: the PredyGo pick, Kalshi prices, the numbers the app used and the settings when it was placed, and the outcome">ⓘ</button> <button class="small icon" data-kalshi="' + esc(r.ticker) + '" title="Open this game on Kalshi: comments, chart and rules (in your browser)">💬</button></td>' +
        '</tr>').join('') + '</tbody></table>'
    : '<div class="hint">' + (tradesView === 'all' ? 'No trades in the last 30 days.' : 'No trades today. <a href="#" id="m-tr-showall">Show all trades</a>') + '</div>';
  if (hiddenOpen) $('m-trades').insertAdjacentHTML('beforeend', '<div class="hint" style="margin-top:6px">' + hiddenOpen + ' trade(s) from earlier days still open. <a href="#" id="m-tr-showall2">Show all trades</a></div>');
  ['m-tr-showall', 'm-tr-showall2'].forEach((id) => { const a = document.getElementById(id); if (a) a.onclick = (e) => { e.preventDefault(); setTradesView('all'); }; });
  document.querySelectorAll('[data-chart]').forEach((b) => b.onclick = () => openChart(rows[+b.dataset.chart]));
  document.querySelectorAll('#m-trades [data-kalshi]').forEach((b) => b.onclick = () => openKalshi(b.dataset.kalshi));
  document.querySelectorAll('#m-trades [data-journal]').forEach((b) => b.onclick = () => openJournal(b.dataset.journal));
}

async function openChart(r) {
  $('chartbox').classList.remove('hidden');
  $('c-title').textContent = r.match || r.title;
  $('c-sub').textContent = (r.bet ? r.bet + ' → ' : '') + r.side.toUpperCase() + ' · ' + r.title + ' · ' + Math.round(r.contracts) + ' contracts at ' + cents(r.paid) + ' · line = what one contract sells for now';
  $('c-chart').innerHTML = '<div class="empty">Loading…</div>';
  try {
    const res = await api('/api/chart', { ticker: r.ticker, side: r.side, from: Date.parse(r.at) });
    lineChart($('c-chart'), res.points, { ref: r.paid, refLabel: 'paid', height: 240, label: 'Price since the trade', marks: [{ t: Date.parse(r.at), v: r.paid }], empty: 'Kalshi has no price history for this market yet.' });
  } catch (e) { $('c-chart').innerHTML = '<div class="hint">' + esc(e.message) + '</div>'; }
}
$('c-close').onclick = () => $('chartbox').classList.add('hidden');
$('j-close').onclick = () => $('jbox').classList.add('hidden');
async function openJournal(ticker) {
  $('jbox').classList.remove('hidden');
  $('j-body').innerHTML = '<div class="empty">Loading…</div>';
  let r;
  try { r = await api('/api/journal', { ticker }); } catch (e) { $('j-body').textContent = e.message; return; }
  if (!r.rows.length) { $('j-body').innerHTML = '<div class="hint">No journal record for this trade (it was placed before v0.16.0 started recording them).</div>'; return; }
  const kv = (o) => '<table class="kv">' + Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => '<tr><td class="hint" style="padding-right:12px">' + esc(k) + '</td><td>' + esc(typeof v === 'object' ? JSON.stringify(v) : String(v)) + '</td></tr>').join('') + '</table>';
  const pctv = (x) => x == null ? null : (x * 100).toFixed(1) + '%';
  $('j-body').innerHTML = r.rows.map((row) => {
    const e = row.entry, risk = (e.settings || {}).risk || {}, live = (e.settings || {}).live || {};
    const out = ['decided', 'settled', 'predygo'].filter((k) => row[k]).map((k) => ({ decided: 'Decided early', settled: 'Kalshi settled', predygo: 'PredyGo graded' })[k] + ': <b class="' + (row[k].result === 'won' ? 'pos' : 'neg') + '">' + row[k].result + '</b>' + (row[k].pnl != null ? ' (' + (row[k].pnl >= 0 ? '+' : '') + fmt$(row[k].pnl) + ')' : '') + (row[k].detail ? ' <span class="hint">' + esc(row[k].detail) + '</span>' : '') + ' <span class="hint">' + new Date(row[k].at).toLocaleString() + '</span>').join('<br>') || '<span class="hint">Not decided yet.</span>';
    return '<h2 style="font-size:15px;margin:6px 0">' + esc(e.predygo.home + ' v ' + e.predygo.away + ' · ' + e.predygo.bet) + '</h2>' +
      '<div class="hint">Placed ' + new Date(e.at).toLocaleString() + ' · ' + esc(e.mode) + ' · app ' + esc(e.appVersion) + '</div>' +
      '<h3 style="font-size:14px;margin:12px 0 4px">Outcome</h3><div>' + out + '</div>' +
      '<h3 style="font-size:14px;margin:12px 0 4px">PredyGo pick</h3>' + kv({ league: e.predygo.league, kickoff: e.predygo.kickoff ? new Date(e.predygo.kickoff).toLocaleString() : null, source: e.predygo.source, published: e.predygo.posted, 'stated confidence': e.predygo.statedPct != null ? e.predygo.statedPct + '%' : null, odds: e.predygo.odds, 'score at pick': e.predygo.score, minute: e.predygo.minute }) +
      '<h3 style="font-size:14px;margin:12px 0 4px">Kalshi at the time</h3>' + kv({ contract: e.kalshi.title ? e.kalshi.title + (e.kalshi.yesSubtitle ? ' · ' + e.kalshi.yesSubtitle : '') : null, ticker: e.kalshi.ticker, side: e.kalshi.sideBought, 'YES ask / bid': e.kalshi.yesAsk + ' / ' + e.kalshi.yesBid, 'for sale': e.kalshi.sideBought === 'yes' ? e.kalshi.yesAskSize : e.kalshi.yesBidSize, volume: e.kalshi.volume }) +
      '<h3 style="font-size:14px;margin:12px 0 4px">The numbers the app used</h3>' + kv({ 'win chance': pctv(e.model.winChance), 'from': e.model.winChanceSource ? e.model.winChanceSource.key + ' (' + e.model.winChanceSource.wins + '/' + e.model.winChanceSource.graded + ' won, ' + e.model.winChanceSource.source + ')' : (e.model.live ? 'live: ' + e.model.live.sinceKickoffMin + ' min after kickoff, checked by ' + e.model.live.checkedBy : null), 'blended with market': pctv(e.model.blendedForEdge), edge: pctv(e.model.edge), 'edge needed': pctv(e.model.edgeNeeded), 'Claude check': e.claude ? e.claude.verdict + (e.claude.reason ? ' – ' + e.claude.reason : '') : 'off' }) +
      '<h3 style="font-size:14px;margin:12px 0 4px">Order</h3>' + kv({ contracts: e.order.filled, price: e.order.avgPrice ?? e.order.limitPrice, 'fee per contract': e.order.avgFee, cost: fmt$(e.order.cost), 'pays if it wins': fmt$(e.order.maxPayout) }) +
      '<h3 style="font-size:14px;margin:12px 0 4px">Settings in force</h3>' + kv({ 'base min edge': pctv(risk.minEdge), 'uncertainty buffer': risk.edgeUncertainty, 'lean toward market': pctv(risk.marketWeight), 'max gap to market': risk.maxGapToMarket != null ? Math.round(risk.maxGapToMarket * 100) + ' pts' : null, 'min win chance': pctv(risk.minProbability), 'never pay more than': risk.maxPrice, 'minimum win': risk.minWinProfit != null ? fmt$(risk.minWinProfit) : null, 'stake': risk.stakeMode, 'per trade': fmt$(risk.maxNotionalPerOrder), 'daily limit': risk.maxDailySpend > 0 ? fmt$(risk.maxDailySpend) : 'none', 'live mode': live.mode, 'Claude check mode': (e.settings || {}).claudeCheck }) + (e.reconstructed ? '<div class="hint">Rebuilt from the logs: this trade was placed before the journal existed, so the settings at the time were not recorded.</div>' : '');
  }).join('<hr>');
}

// ---- AI assistant (Claude or ChatGPT)
const pctv = (x) => (x == null ? '–' : Math.abs(x) < 1 && x !== 0 ? (x * 100).toFixed(1).replace(/\\.0$/, '') + '%' : String(x));
// Switching these off can cost real money fast; ask first.
const RISKY_OFF = { minute80: 'buy at any minute of a game', onePerMatch: 'bet on the same game more than once', noDouble: 'buy the same pick again on every scan',
  region: 'trade without checking where you are (Kalshi still checks your account)', kalshiErr: 'keep placing orders after Kalshi refuses one or does not answer',
  perTrade: 'place orders of any size your cash allows', exposure: 'put all your cash in open bets', freshPrice: 'buy even when the live price no longer passes',
  approved: 'pay more than the price you saw', kickoffMatch: 'buy picks whose kickoff disagrees with Kalshi (possibly the wrong game)' };
/** The value editors next to a rule (numbers and choices), saved on change. */
function ruleEditors(r) {
  return (r.fields || []).map((f) => {
    const rf = esc(r.id + '|' + f.path);
    const defShown = f.kind === 'choice' ? ((f.choices.find((c) => c.value === f.def) || {}).label || f.def) : (f.unit === '$' ? '$' + f.def : f.def + (f.unit ? ' ' + f.unit : ''));
    const tip = esc(f.label + '. Default: ' + defShown + '.' + (f.auto ? ' (worked out from your balance: switch off "Size limits from my balance" in Settings to set it)' : ''));
    const input = f.kind === 'choice'
      ? '<select data-rf="' + rf + '" title="' + tip + '">' + f.choices.map((c) => '<option value="' + esc(c.value) + '"' + (c.value === f.value ? ' selected' : '') + '>' + esc(c.label) + '</option>').join('') + '</select>'
      : '<input type="number" data-rf="' + rf + '" title="' + tip + '" value="' + esc(String(f.value)) + '" min="' + f.min + '" max="' + f.max + '" step="' + f.step + '" style="width:76px"' + (f.auto ? ' disabled' : '') + '>';
    return '<span class="rule-ed" style="display:inline-flex;align-items:center;gap:4px;margin:2px 10px 2px 0"><span class="hint">' + esc(f.label) + '</span>' + (f.unit === '$' ? '<span class="hint">$</span>' : '') + input + (f.unit && f.unit !== '$' ? '<span class="hint">' + esc(f.unit) + '</span>' : '') + '</span>';
  }).join('');
}
function renderRules(s) {
  const R = s.rules;
  if (!R) return;
  // Don't redraw under someone typing a value.
  if (document.activeElement && document.activeElement.closest && document.activeElement.closest('#m-rules') && document.activeElement.dataset.rf) return;
  const k = JSON.stringify(R.map((r) => [r.value, r.status, r.on, r.locked, r.fields]));
  if ($('m-rules').dataset.k === k) return;
  $('m-rules').dataset.k = k;
  const on = R.filter((r) => r.status === 'on').length;
  $('m-rules-sum').textContent = '· ' + on + ' on, ' + (R.length - on) + ' off';
  const stages = [...new Set(R.map((r) => r.stage))];
  // One block per rule: switch, name (wraps), badge; then its current value and editors on their own lines,
  // so nothing is cut off in a narrow window.
  const badge = (r) => r.status === 'on' ? '<span class="badge won">on</span>' : '<span class="badge open">off</span>';
  $('m-rules').innerHTML = '<div class="hint">Every rule that can stop a pick, in the order the app applies them, each with its own switch and the values behind it (change a value and it is saved straight away; it applies when the rule is on). Hover a name for what it does. "Restore defaults" below puts everything back.</div>' +
    stages.map((st) => '<div style="margin-top:12px;font-weight:600">' + esc(st) + '</div>' + R.filter((r) => r.stage === st).map((r) =>
      '<div class="rule' + (r.status === 'on' ? '' : ' dim') + '">' +
        '<div class="rule-top"><label class="switch" title="' + esc(r.locked || ((r.on ? 'Switch off: ' : 'Switch on: ') + r.name)) + '"><input type="checkbox" data-rule="' + esc(r.id) + '"' + (r.on ? ' checked' : '') + (r.locked ? ' disabled' : '') + '></label>' +
        '<span class="rule-name" title="' + esc(r.what) + '">' + esc(r.name) + '</span>' + badge(r) + '</div>' +
        (r.value && !(r.fields && r.fields.length) ? '<div class="rule-sub hint">' + esc(r.value) + '</div>' : '') +
        (r.fields && r.fields.length ? '<div class="rule-sub">' + ruleEditors(r) + '</div>' : '') +
      '</div>').join('')).join('');
  document.querySelectorAll('[data-rf]').forEach((el) => el.onchange = async () => {
    const [id, path] = el.dataset.rf.split('|');
    try { await api('/api/rules/set', { id, path, value: el.value }); }
    catch (e) { alertMsg(e.message); }
    el.blur();
    await refresh();
  });
  document.querySelectorAll('[data-rule]').forEach((b) => b.onchange = async () => {
    const id = b.dataset.rule, want = b.checked, rule = R.find((x) => x.id === id);
    if (!want && RISKY_OFF[id] && !confirm('Switch off "' + rule.name + '"?\\n\\nThe app will ' + RISKY_OFF[id] + '. This is your decision.')) { b.checked = true; return; }
    if (id === 'kill' && want && !confirm('Stop all trading? No new orders until you switch this off again.')) { b.checked = false; return; }
    await act('/api/rules/toggle', { id, on: want });
  });
}
function renderWaiting(s) {
  const W = s.waiting || [], P = s.paused || [];
  $('m-waitcard').classList.toggle('hidden', !W.length && !P.length);
  const k = JSON.stringify([W, P]);
  if ($('m-waiting').dataset.k === k) return;
  $('m-waiting').dataset.k = k;
  const t = (iso) => iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  $('m-waiting').innerHTML = (W.length ? '<table><thead><tr><th>Match</th><th>Bet</th><th class="num">Bid</th><th class="num">Worth up to</th><th class="num">Filled</th><th>Until</th><th></th></tr></thead><tbody>' + W.map((o) =>
    '<tr><td>' + esc(o.match) + (o.by === 'claude' ? ' <span class="hint">(Claude)</span>' : '') + '</td><td>' + esc(o.bet || '') + ' ' + o.side.toUpperCase() + '</td><td class="num">' + Math.round(o.price * 100) + '¢</td><td class="num">' + (o.maxPay != null ? Math.round(o.maxPay * 100) + '¢' : '–') + '</td><td class="num">' + o.filled + ' / ' + o.count + '</td><td>' + t(o.until) + '</td>' +
    '<td><button class="small" data-wcancel="' + esc(o.clientOrderId) + '">Cancel</button></td></tr>').join('') + '</tbody></table>' : '<div class="hint">No waiting orders.</div>') +
    (P.length ? '<div style="margin-top:10px;font-weight:600">Paused</div>' + P.map((x) => '<div class="row" style="margin-top:4px"><span>' + esc(x.value) + ' <span class="hint">(' + x.kind + ', by ' + (x.by === 'claude' ? 'Claude' : 'you') + ', until ' + new Date(x.until).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ')</span><div class="hint">' + esc(x.reason) + '</div></span><span class="spacer"></span><button class="small" data-unpause="' + esc(x.kind + '|' + x.value) + '">Restart</button></div>').join('') : '');
  document.querySelectorAll('[data-wcancel]').forEach((b) => b.onclick = () => act('/api/waiting/cancel', { clientOrderId: b.dataset.wcancel }));
  document.querySelectorAll('[data-unpause]').forEach((b) => b.onclick = () => { const [kind, ...v] = b.dataset.unpause.split('|'); act('/api/pause/remove', { kind, value: v.join('|') }); });
}
function renderScorecard(s) {
  const S = s.scorecard;
  if (!S) return;
  const k = JSON.stringify(S.overall) + JSON.stringify(S.last7);
  if ($('m-scorecard').dataset.k === k) return;
  $('m-scorecard').dataset.k = k;
  const money = (v) => (v >= 0 ? '+' : '−') + '$' + Math.abs(v).toFixed(2);
  const roi = (v) => (v >= 0 ? '+' : '') + Math.round(v * 100) + '%';
  $('m-scorecard-sum').textContent = S.overall.trades ? '· ' + S.overall.trades + ' settled · ' + money(S.overall.pnl) + ' (' + roi(S.overall.roi) + ') · last 7 days ' + money(S.last7.pnl) : '· no settled trades yet';
  const table = (title, L) => !L.length ? '' : '<div style="margin-top:10px;font-weight:600">' + title + '</div><table><thead><tr><th></th><th class="num">Trades</th><th class="num">W-L-S</th><th class="num">Staked</th><th class="num">P/L</th><th class="num">ROI</th></tr></thead><tbody>' +
    L.map((l) => '<tr><td>' + esc(l.key) + '</td><td class="num">' + l.trades + '</td><td class="num">' + l.won + '-' + l.lost + '-' + l.sold + '</td><td class="num">$' + l.staked.toFixed(2) + '</td><td class="num ' + (l.pnl >= 0 ? 'pos' : 'neg') + '">' + money(l.pnl) + '</td><td class="num ' + (l.roi >= 0 ? 'pos' : 'neg') + '">' + roi(l.roi) + '</td></tr>').join('') + '</tbody></table>';
  $('m-scorecard').innerHTML = !S.overall.trades ? '<div class="hint">Settled trades show here by bet type, price, league and how they were bought.</div>' :
    '<div class="hint">W-L-S = won, lost, sold. ROI = profit ÷ money staked. Small groups are mostly luck.</div>' +
    table('By bet type', S.byBet) + table('By price paid', S.byPrice) + table('Live vs pre-game', S.bySource) + table('How it was bought', S.byEntry) + table('By league (top 12)', S.byLeague.slice(0, 12));
}
const AI_INFO = {
  claude: { name: 'Claude', company: 'Anthropic', placeholder: 'sk-ant-...' },
  chatgpt: { name: 'ChatGPT', company: 'OpenAI', placeholder: 'sk-...' },
};
function renderAi(s) {
  const A = s.ai;
  if (!A) return;
  const P = AI_INFO[A.provider] || AI_INFO.claude;
  if (document.activeElement !== $('ai-provider')) $('ai-provider').value = A.provider;
  $('ai-setup').classList.toggle('hidden', A.hasKey);
  $('ai-main').classList.toggle('hidden', !A.hasKey);
  $('ai-setup-hint').textContent = 'Optional. Add an ' + P.company + ' API key to have ' + P.name + ' check each order before it is sent (right game, line and side), and choose in ' + P.name + ' settings whether it can stop a trade. Stored encrypted with your other keys. Typical cost: under $0.001 per check.';
  $('ai-key-label').textContent = P.company + ' API key';
  $('ai-key').placeholder = P.placeholder; $('ai-key2').placeholder = P.placeholder;
  $('ai-sum').textContent = P.name + ' settings';
  $('ai-enabled-label').textContent = 'Use ' + P.name;
  $('ai-savesettings').textContent = 'Save ' + P.name + ' settings';
  $('ai-key2-label').textContent = 'Replace ' + P.company + ' key (blank = remove)';
  $('ai-status').textContent = !A.hasKey ? 'Off · no ' + P.company + ' API key' : !A.settings.enabled ? 'Off' :
    P.name + ': ' + ({ veto: 'checking trades (can stop them)', advise: 'checking trades (log only)', off: 'on, not checking trades' }[A.settings.precheck]) + ' · today $' + A.spentToday.toFixed(3) + ' of $' + A.settings.dailyBudgetUsd.toFixed(2) +
    (A.spentBy ? ' (' + Object.entries(A.spentBy).map(([k, v]) => ({ precheck: 'trade checks', 'key-check': 'key check' }[k] || k) + ' $' + v.cost.toFixed(3) + ' × ' + v.calls).join(', ') + ')' : '');
  if (!A.hasKey) return;
  if (!document.activeElement || !document.activeElement.closest('#ai-card details')) {
    const st = A.settings;
    const mk = A.models.map((m) => m.id).join(',');
    if ($('ai-checkmodel').dataset.k !== mk) { $('ai-checkmodel').dataset.k = mk; $('ai-checkmodel').innerHTML = A.models.map((m) => '<option value="' + m.id + '">' + esc(m.label) + '</option>').join(''); }
    $('ai-enabled').checked = st.enabled; $('ai-precheck').value = st.precheck; $('ai-failopen').value = st.failOpen ? '1' : '0';
    $('ai-checkmodel').value = st.checkModel; $('ai-budget').value = st.dailyBudgetUsd;
    $('ai-models-from').textContent = A.modelsFrom === 'provider' ? 'The models ' + P.company + ' offers your key today (checked daily).' : 'Built-in list (the ' + P.company + ' model list could not be read yet).';
  }
}
async function saveAiKey(keyEl, pwEl, msgEl) {
  const P = AI_INFO[$('ai-provider').value] || AI_INFO.claude;
  msgEl.textContent = 'Checking the key with ' + P.name + '…';
  try { await api('/api/ai/key', { provider: $('ai-provider').value, key: keyEl.value.trim(), password: pwEl.value }); keyEl.value = ''; pwEl.value = ''; msgEl.textContent = 'Saved.'; }
  catch (e) { msgEl.textContent = e.message; }
  await refresh();
}
$('ai-provider').onchange = (e) => act('/api/ai/settings', { provider: e.target.value });

// ---- Ask the AI (chat). The conversation lives in this window only.
const chat = [];
function renderChat() {
  $('ai-chat-log').innerHTML = chat.map((m) => '<div class="chatmsg ' + m.role + '">' + esc(m.content) + '</div>').join('');
  $('ai-chat-log').scrollTop = $('ai-chat-log').scrollHeight;
}
async function sendChat() {
  const q = $('ai-chat-in').value.trim();
  if (!q || $('ai-chat-send').disabled) return;
  chat.push({ role: 'user', content: q });
  $('ai-chat-in').value = ''; renderChat();
  $('ai-chat-send').disabled = true; $('ai-chat-msg').textContent = 'Thinking…';
  try {
    const r = await api('/api/ai/chat', { messages: chat });
    chat.push({ role: 'assistant', content: r.reply });
    $('ai-chat-msg').textContent = r.model + ' · $' + Number(r.cost || 0).toFixed(4);
  } catch (e) { chat.pop(); $('ai-chat-in').value = q; $('ai-chat-msg').textContent = e.message; }
  $('ai-chat-send').disabled = false;
  renderChat();
}
$('ai-chat-send').onclick = sendChat;
$('ai-chat-in').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } };
$('ai-chat-clear').onclick = () => { chat.length = 0; renderChat(); $('ai-chat-msg').textContent = ''; };
$('ai-save').onclick = () => saveAiKey($('ai-key'), $('ai-pw'), $('ai-msg'));
$('ai-save2').onclick = () => saveAiKey($('ai-key2'), $('ai-pw2'), $('ai-msg2'));
// Switches and dropdowns save as soon as they change.
for (const id of ['ai-enabled', 'ai-precheck', 'ai-failopen', 'ai-checkmodel']) $(id).onchange = () => $('ai-savesettings').onclick();
$('ai-savesettings').onclick = async () => {
  try {
    await api('/api/ai/settings', { enabled: $('ai-enabled').checked, precheck: $('ai-precheck').value, failOpen: $('ai-failopen').value === '1',
      checkModel: $('ai-checkmodel').value, dailyBudgetUsd: Number($('ai-budget').value),
    });
    $('ai-smsg').textContent = 'Saved.'; setTimeout(() => $('ai-smsg').textContent = '', 2500);
  } catch (e) { $('ai-smsg').textContent = e.message; }
  if (document.activeElement) document.activeElement.blur();
  await refresh();
};

let pollTimer = null, pollMs = 0;
function pollEvery(ms) { if (ms === pollMs) return; pollMs = ms; if (pollTimer) clearInterval(pollTimer); pollTimer = setInterval(refresh, ms); }

// "Size limits from my balance": the three dollar limits are worked out by the app.
function autoSizeView(s) {
  const on = $('c-autosize').checked;
  const bank = s && s.cash != null ? s.cash + (s.positions || 0) : null;
  const r = (s && s.risk) || {};
  $('c-autosize-hint').textContent = on
    ? 'From your balance' + (bank != null ? ' ($' + bank.toFixed(2) + ')' : '') + ': up to ' + Math.round((r.maxPositionPct || 0) * 100) + '% of it per trade and ' + Math.round((r.maxOpenExposurePct || 0) * 100) + '% of it in open bets at once (set both under Rules in force). No daily limit: as bets settle, the money is free for new picks.'
    : 'Off: you set the per-trade limit, open positions and daily limit yourself under Rules in force.';
}
$('c-autosize').onchange = (e) => { autoSizeView(state); act('/api/settings', { risk: { autoSize: e.target.checked } }); };
$('c-tier').onchange = (e) => act('/api/settings', { tier: e.target.value }).then(() => act('/api/scan'));
$('m-tr-today').onclick = () => setTradesView('today');
$('m-tr-all').onclick = () => setTradesView('all');
$('m-highrisk').onchange = (e) => {
  if (e.target.checked && !confirm('Buy PredyGo HIGH RISK / HIGH REWARD picks too? They are late-game live plays outside the standard PredyGo picks, and are not graded or counted in its record.')) { e.target.checked = false; return; }
  act('/api/settings', { risk: { tradeHighRisk: e.target.checked } });
};
$('c-resumeauto').onchange = (e) => act('/api/settings', { resumeAuto: e.target.checked });
$('c-pro').onchange = (e) => act('/api/pro', { on: e.target.checked });
$('m-openpro').onclick = () => api('/api/openurl', { url: 'https://pro.kalshi.com/' }).catch((e) => alertMsg(e.message));

const LIVE_ACTION = { traded: '<span class="ok">✓ Bought</span>', watch: '<span class="pos">Would buy</span>', skip: '', old: '' };
function renderLive(s) {
  const L = s.live;
  // Buying is the top-bar Live switch; checking live picks is a rule (Check live picks).
  const buying = L.mode === 'trade';
  $('m-livebuy').textContent = L.mode === 'off' ? 'Not checked (rule "Check live picks" is off)' : buying ? 'Buying automatically (Live switch on)' : 'Shown only: click Buy (Live switch off)';
  $('m-livebuy').className = 'badge ' + (buying ? 'won' : 'open');
  $('m-livebuy').title = 'Turn automatic live buying on or off with the Live switch in the top bar.';
  const T = s.trading || {};
  $('m-pregame').checked = T.pregame !== false;
  $('m-livesw').checked = L.mode === 'trade';
  const t = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  $('m-liveinfo').textContent = L.mode === 'off' ? 'Not checking' :
    (L.error ? 'Last check failed: ' + L.error : 'Every ' + L.pollSec + 's' + (L.lastPollAt ? ' · last check ' + t(L.lastPollAt) : ' · starting…') + ' · ' + L.open + ' open live picks');
  if (L.mode === 'off') { $('m-live').innerHTML = '<div class="hint">Turn on Watch to see each live pick with Kalshi’s price the moment it appears.</div>'; return; }
  const rows = L.rows || [];
  $('m-live').innerHTML = rows.length ? '<table><thead><tr><th>Time</th><th>Match</th><th>Pick → Kalshi</th><th class="num">Win %</th><th class="num">Price</th><th class="num">Edge</th><th></th></tr></thead><tbody>' +
    rows.map((r) => '<tr class="' + (r.action === 'traded' || r.action === 'watch' ? '' : 'dim') + '">' +
      '<td class="ko">' + t(r.at) + '</td>' +
      '<td>' + esc(r.match) + '<div class="hint">' + esc(r.league) + (r.score ? ' · ' + esc(r.score) : '') + ' · ' + r.sinceKickoffMin + ' min since KO' + (r.pickedMin != null && Math.abs(r.pickedMin - r.sinceKickoffMin) > 2 ? ' (picked at ' + r.pickedMin + ')' : '') + '</div></td>' +
      '<td>' + esc(r.bet) + (r.contract ? '<div class="hint">' + esc(r.contract) + '</div>' : '') + '</td>' +
      '<td class="num">' + (r.probability != null ? pct(r.probability, 0) : '–') + '</td>' +
      '<td class="num">' + (r.ask != null ? Math.round(r.ask * 100) + '¢' : '–') + (r.odds ? '<span class="need">odds ' + r.odds.toFixed(2) + '</span>' : '') + '</td>' +
      '<td class="num ' + (r.edge != null && r.required != null && r.edge >= r.required ? 'pos' : 'neg') + '">' + (r.edge != null ? (r.edge > 0 ? '+' : '') + pct(r.edge) : '–') + (r.required != null ? '<span class="need">need ' + pct(r.required) + '</span>' : '') + '</td>' +
      '<td>' + (LIVE_ACTION[r.action] || '') + (r.action === 'watch' ? ' <button class="small primary" data-livebuy="' + esc(r.id) + '"' + (s.killSwitch || s.eligibility ? ' disabled' : '') + '>Buy</button>' : '') + '<div class="hint">' + esc(r.reason) + '</div></td>' +
      '</tr>').join('') + '</tbody></table>'
    : '<div class="hint">No live picks yet. ' + (s && s.risk && s.risk.useKalshiOdds === false ? 'Picks already open when the app started are not traded; new' : 'Every in-play pick is judged on Kalshi\u2019s live price, including ones already open when the app started; new') + ' ones appear here within ' + L.pollSec + ' seconds.</div>';
  document.querySelectorAll('[data-livebuy]').forEach((b) => b.onclick = async () => {
    if (!confirm('Buy this live pick now' + (state.env === 'prod' ? ' with REAL MONEY' : '') + '? It is re-priced on Kalshi\u2019s current price and goes through every check first.')) return;
    b.disabled = true;
    try { await api('/api/live/buy', { id: b.dataset.livebuy }); } catch (e) { alertMsg(e.message); }
    await refresh();
  });
}

$('m-pregame').onchange = (e) => act('/api/trading', { pregame: e.target.checked });
$('m-livesw').onchange = async (e) => {
  if (e.target.checked) {
    const ok = confirmAuto('Trade live picks' + (state.env === 'prod' ? ' with REAL MONEY' : '') + '?\\n\\nNew live picks are checked every ' + state.live.pollSec + ' seconds and bought when they pass the checks, up to ' + fmt$(state.risk.maxNotionalPerOrder) + ' per trade.');
    if (!ok) { e.target.checked = false; return; }
  }
  await act('/api/trading', { live: e.target.checked });
};

async function placeAnyway(id) {
  const r = state.scan.rows.find((x) => x.id === id);
  if (!r || !(r.maxForce > 0)) return;
  const live = state.env === 'prod';
  const head = 'PLACE ANYWAY' + (live ? ' (REAL MONEY)' : ' (demo)') + '\\n\\n' + r.match + '\\n' + r.pick + ' → ' + r.contract +
    '\\n\\nThe app skipped this pick: ' + r.status + '.\\nModel ' + pct(r.probability, 0) + ' vs price ' + Math.round(r.ask * 100) + '¢ → edge ' + (r.edge > 0 ? '+' : '') + pct(r.edge) +
    (r.required != null ? ' (needs ' + pct(r.required) + ')' : '') + '.\\n\\nHow many contracts? (1–' + r.maxForce + ', about ' + fmt$(r.unitCost) + ' each incl. fees)';
  const ans = prompt(head, String(r.maxForce));
  if (ans === null) return;
  const n = Math.floor(Number(ans));
  if (!(n >= 1 && n <= r.maxForce)) { alertMsg('Enter a whole number from 1 to ' + r.maxForce + '.'); return; }
  if (!confirm('Buy ' + n + ' contracts at up to ' + Math.round(r.ask * 100) + '¢ (≈ ' + fmt$(n * r.unitCost) + ' incl. fees)' + (live ? ' with REAL MONEY' : '') + '?')) return;
  try {
    const res = await api('/api/place', { id, force: true, contracts: n });
    if (!res.placed) alertMsg('No order was sent. See Activity for why (for example, the price moved).');
  } catch (e) { alertMsg(e.message); }
  await refresh();
}

// ---- setup
$('s-country').onchange = () => {
  syncStateVisibility($('s-country'), $('s-state-wrap'));
  $('s-region-msg').textContent = $('s-country').value === 'US' ? '' : 'Outside the US, the app checks Kalshi’s list of excluded countries. Kalshi also verifies your account and location.';
};
$('c-country').onchange = () => syncStateVisibility($('c-country'), $('c-state-wrap'));
$('s-pemfile').onclick = () => $('s-pemfile-input').click();
$('s-pemfile-input').onchange = async (e) => { const f = e.target.files[0]; if (f) $('s-pem').value = await f.text(); };
$('s-go').onclick = async () => {
  $('s-err').textContent = ''; $('s-go').disabled = true; $('s-busy').classList.remove('hidden');
  try {
    await api('/api/create', {
      predygoKey: $('s-pg').value, kalshiKeyId: $('s-kid').value, kalshiPrivateKey: $('s-pem').value,
      country: $('s-country').value, usState: $('s-state').value, password: $('s-pw').value, confirm: $('s-pw2').value,
    });
    for (const id of ['s-pg', 's-kid', 's-pem', 's-pw', 's-pw2']) $(id).value = '';
    await refresh();
  } catch (e) { $('s-err').textContent = e.message; }
  finally { $('s-go').disabled = false; $('s-busy').classList.add('hidden'); }
};

// ---- unlock
async function unlock() {
  $('u-err').textContent = ''; $('u-go').disabled = true; $('u-busy').classList.remove('hidden');
  try { await api('/api/unlock', { password: $('u-pw').value }); $('u-pw').value = ''; await refresh(); }
  catch (e) { $('u-err').textContent = e.message; $('u-pw').select(); }
  finally { $('u-go').disabled = false; $('u-busy').classList.add('hidden'); }
}
$('u-go').onclick = unlock;
var manualUnlock = false; // var: read by refresh(), which may run before this line
$('u-manual').onclick = (e) => { e.preventDefault(); manualUnlock = true; $('u-auto').classList.add('hidden'); $('u-form').classList.remove('hidden'); $('u-pw').focus(); };
$('u-pw').onkeydown = (e) => { if (e.key === 'Enter') unlock(); };
$('u-forget').onclick = async () => {
  try { await api('/api/forget', { confirm: $('u-del').value.trim() }); $('u-del').value = ''; await refresh(); }
  catch (e) { $('u-err').textContent = e.message; }
};

// ---- main
$('m-lock').onclick = () => act('/api/lock');
$('c-svc').onchange = async (e) => {
  if (e.target.checked) { $('c-svc-form').classList.remove('hidden'); e.target.checked = false; $('c-svc-msg').textContent = ''; $('c-svc-app').focus(); return; }
  if (!confirm('Turn off background mode? Soccer Edge will only run while its window is open, and will not start with Windows.')) { e.target.checked = true; return; }
  await act('/api/service/uninstall');
};
$('c-svc-cancel').onclick = () => { $('c-svc-form').classList.add('hidden'); $('c-svc-app').value = ''; $('c-svc-win').value = ''; refresh(); };
$('c-svc-go').onclick = async () => {
  if (!confirmAuto('Turn on background mode? Soccer Edge will start with Windows and keep running, and trading if you turned automation on, with this window closed.')) return;
  $('c-svc-go').disabled = true;
  $('c-svc-msg').textContent = 'Setting up… (this can take up to a minute)';
  try {
    const r = await api('/api/service/install', { appPassword: $('c-svc-app').value, winPassword: $('c-svc-win').value });
    $('c-svc-app').value = ''; $('c-svc-win').value = '';
    $('c-svc-form').classList.add('hidden');
    if (r.url) { $('c-svc-msg').textContent = 'Switching to the background copy…'; location.href = r.url; return; }
  } catch (err) { $('c-svc-msg').textContent = err.message; }
  finally { $('c-svc-go').disabled = false; }
  refresh();
};
const d0sync = () => { $('d0-go').disabled = !($('d0-ack1').checked && $('d0-ack2').checked); };
$('d0-ack1').onchange = d0sync;
$('d0-ack2').onchange = d0sync;
$('d0-go').onclick = async () => {
  try { await api('/api/disclaimer/accept', { acks: [$('d0-ack1').checked, $('d0-ack2').checked] }); await refresh(); }
  catch (e) { $('d0-err').textContent = e.message; }
};
$('d0-footer').innerHTML = esc(DISCLAIMER.short) + ' <a href="#" id="d0-read">Read the full disclaimer</a>';
$('d0-read').onclick = (e) => { e.preventDefault(); alert(DISCLAIMER.title + '\\n\\n' + DISCLAIMER.points.map((p) => '\u2022 ' + p).join('\\n\\n')); };
$('c-xml-export').onclick = async () => {
  try {
    const r = await api('/api/settings/export');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([r.xml], { type: 'application/xml' }));
    a.download = r.fileName;
    document.body.appendChild(a); a.click(); a.remove();
    noteMsg('Exported ' + r.fileName + ' (no keys or passwords in it).');
  } catch (e) { alertMsg(e.message); }
};
$('c-xml-import').onclick = () => $('c-xml-file').click();
$('c-xml-file').onchange = async (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const r = await api('/api/settings/import', { xml: await f.text() });
    noteMsg('Imported ' + f.name + ': ' + r.changed + ' setting(s) changed' + (r.ignored.length ? ', ' + r.ignored.length + ' ignored (see Activity)' : '') + '.');
    if (document.activeElement) document.activeElement.blur(); // so the form shows the imported values
    await refresh();
  } catch (err) { alertMsg(err.message); }
};
$('m-quit').onclick = async () => {
  if (state.background && !confirm('Background mode is on. Quit stops it (and all trading) until you open Soccer Edge again or Windows restarts. Quit anyway?')) return;
  if (!state.background && state.auto && state.auto.on && !confirm('Auto-trading is on. Quit anyway? Nothing trades while the app is closed.')) return;
  try { await api('/api/quit'); } catch {}
  document.body.innerHTML = '<div style="padding:40px;font:16px system-ui">Soccer Edge has stopped. You can close this window.</div>';
  setTimeout(() => window.close(), 400);
};
$('m-scan').onclick = () => act('/api/scan');
$('m-kill').onclick = () => { if (confirm('Stop all trading? Auto-trade turns off and no new orders are placed until you allow trading again.')) act('/api/kill'); };
$('m-auto').onchange = (e) => {
  if (e.target.checked) {
    const live = state.env === 'prod';
    const ok = confirmAuto('Turn on auto-trading' + (live ? ' with REAL MONEY' : '') + '?\\n\\nEvery ' + state.auto.intervalMin + ' minutes the app will scan and place every trade that passes the checks, up to ' + fmt$(state.risk.maxNotionalPerOrder) + ' per trade' + (state.risk.maxDailySpend > 0 ? ' and ' + fmt$(state.risk.maxDailySpend) + ' per day' : ' (no daily limit)') + '. It only runs while this window is open.');
    if (!ok) { e.target.checked = false; return; }
  }
  act('/api/auto', { on: e.target.checked });
};
$('c-defaults').onclick = async () => {
  if (!confirm('Restore every setting and every rule (switches and values) to its default?\\n\\nYour keys, region, PredyGo tier, accepted disclaimer and background mode stay as they are. Auto-trade turns off, and Live and High-risk picks go back to off.')) return;
  try { await api('/api/settings/defaults'); noteMsg('All settings are back to their defaults.'); }
  catch (e) { alertMsg(e.message); }
  if (document.activeElement) document.activeElement.blur(); // so the form shows the defaults
  await refresh();
};
// "Default: ..." at the end of each setting's tooltip, from the app's real defaults.
const DEFAULT_NOTES = {
  'c-livepoll': (d) => d.live.pollSec + ' s',
  'c-pro': (d) => (d.pro.realtime ? 'on' : 'off'), 'c-interval': (d) => d.scanIntervalMin + ' min', 'c-autosize': (d) => (d.risk.autoSize ? 'on' : 'off'),
  'c-resumeauto': (d) => (d.resumeAuto ? 'on' : 'off'),
  'c-minstated': (d) => d.minStatedPct + '%', 'c-calib': (d) => (d.calibration === 'stated' ? "PredyGo's stated confidence" : 'real hit rate'),
  'm-auto': () => 'off', 'm-pregame': () => 'on', 'm-livesw': () => 'off', 'm-highrisk': () => 'off',
  'ai-enabled': (d) => (d.ai.enabled ? 'on' : 'off'), 'ai-precheck': (d) => d.ai.precheck, 'ai-failopen': (d) => (d.ai.failOpen ? 'trade anyway' : 'skip'),
  'ai-budget': (d) => '$' + d.ai.dailyBudgetUsd, 'ai-checkmodel': (d) => d.ai.checkModel, 'c-svc': () => 'off',
};
function applyDefaultNotes(d) {
  if (!d) return;
  for (const [id, f] of Object.entries(DEFAULT_NOTES)) {
    const el = $(id);
    if (!el || el.dataset.defnote) continue;
    let note = '';
    try { note = ' Default: ' + f(d) + '.'; } catch { continue; }
    el.dataset.defnote = '1';
    for (const t of [el, el.closest('label'), document.querySelector('label[for="' + id + '"]')]) if (t) t.title = (t.title || '') + note;
  }
}
$('c-save').onclick = async () => {
  try {
    await api('/api/settings', { country: $('c-country').value, usState: $('c-country').value === 'US' ? $('c-state').value : undefined,
      minStatedPct: Number($('c-minstated').value), calibration: $('c-calib').value,
      scanIntervalMin: Number($('c-interval').value), livePollSec: Number($('c-livepoll').value) });
    $('c-msg').textContent = 'Saved.'; setTimeout(() => $('c-msg').textContent = '', 2500);
  } catch (e) { $('c-msg').textContent = e.message; }
  await refresh();
};

// Keep-alive so the app knows the window is open; tell it when the window closes.
setInterval(() => api('/api/heartbeat').catch(() => {}), 20000);
window.addEventListener('pagehide', () => navigator.sendBeacon('/api/bye?t=' + TOKEN));
// ---- diagnostics
const LABEL = { ok: 'OK', warn: 'WARN', fail: 'FAIL', info: 'INFO' };
const pill = (st) => '<span class="pill ' + st + '">' + LABEL[st] + '</span>';
let diagOpen = false;
function renderDiag() {
  if (!diagOpen || !state || !state.diagnostics) return;
  const d = state.diagnostics;
  $('d-run').disabled = d.running;
  $('d-copy').disabled = !d.text;
  if (d.running) { $('d-body').innerHTML = '<div class="empty">Running checks against PredyGo and Kalshi… (10–30 seconds)</div>'; $('d-counts').textContent = ''; return; }
  if (d.error) { $('d-body').innerHTML = '<div class="banner bad">' + esc(d.error) + '</div>'; return; }
  const r = d.report;
  if (!r) return;
  if ($('d-body').dataset.at === r.generatedAt) return; // don't redraw (keeps open/closed state)
  $('d-body').dataset.at = r.generatedAt;
  const pc = { ok: 0, warn: 0, fail: 0, info: 0 };
  r.picks.forEach((p) => pc[p.verdict]++);
  $('d-counts').innerHTML = '<span>' + r.counts.fail + ' problems</span><span>' + r.counts.warn + ' warnings</span><span>' + new Date(r.generatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }) + '</span>';
  let h = '<h2>Connections and settings</h2><div class="dgrid">';
  let area = '';
  for (const c of r.checks) {
    h += '<div class="area">' + (c.area !== area ? esc(c.area) : '') + '</div><div>' + esc(c.name) + '</div><div>' + pill(c.status) + '</div><div>' + esc(c.detail) + '</div>';
    area = c.area;
  }
  h += '</div>';
  h += '<h2 style="margin-top:20px">Picks in the feed (' + r.picks.length + ')</h2>';
  h += '<div class="hint" style="margin-bottom:6px">' + pc.ok + ' tradable · ' + pc.warn + ' on Kalshi but skipped · ' + pc.fail + ' not on Kalshi · ' + pc.info + ' not checked (live, started or later). Click a pick to see each step.</div>';
  if (!r.picks.length) h += '<div class="empty">The feed has no open picks right now.</div>';
  for (const p of r.picks) {
    h += '<details class="pick"' + (p.verdict === 'fail' && r.picks.length <= 6 ? ' open' : '') + '><summary>' + pill(p.verdict) +
      '<b>' + esc(p.label) + '</b><span class="hint">' + esc(p.league) + ' · ' + esc(p.bet) + ' · ' + new Date(p.kickoff).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) + '</span>' +
      '<span class="spacer"></span><span class="sum">' + esc(p.summary) + '</span></summary><div class="steps">' +
      p.steps.map((st) => '<div>' + pill(st.status) + '<b>' + esc(st.step) + '</b><span>' + esc(st.detail) + '</span></div>').join('') + '</div></details>';
  }
  h += '<h2 style="margin-top:20px">Hit rates used to price picks</h2><table><thead><tr><th>Bet</th><th class="num">Graded</th><th class="num">Stated</th><th class="num">Hit rate</th><th class="num">± uncertainty</th><th>From</th><th></th></tr></thead><tbody>' +
    r.calibration.map((c) => '<tr><td>' + esc(c.bet) + '</td><td class="num">' + c.graded + '</td><td class="num">' + (c.stated != null ? c.stated.toFixed(1) + '%' : '–') + '</td><td class="num">' + pct(c.hitRate) + '</td><td class="num">' + (c.stdErr != null ? pct(c.stdErr) : '–') + '</td><td>' + (c.source === 'history' ? 'your results feed' : c.source === 'combined' ? 'snapshot + newer results' : 'bundled snapshot') + '</td><td>' + (c.tradable ? '' : '<span class="hint">too few to trade</span>') + '</td></tr>').join('') +
    '</tbody></table>';
  for (const [k, a] of Object.entries(r.feed)) {
    if (a && a.ok) h += '<div class="hint" style="margin-top:8px">' + (k === 'predictions' ? 'Picks' : 'Results') + ' feed fields: ' + esc((a.fieldsSeen || []).join(', ')) + '</div>';
  }
  $('d-body').innerHTML = h;
}
async function openDiag(run) {
  diagOpen = true;
  $('diag').classList.remove('hidden');
  $('d-body').dataset.at = '';
  if (run || !(state.diagnostics && (state.diagnostics.report || state.diagnostics.running))) await api('/api/diagnostics').catch((e) => alertMsg(e.message));
  await refresh();
  const poll = setInterval(async () => { if (!diagOpen) return clearInterval(poll); await refresh(); if (!state.diagnostics.running) clearInterval(poll); }, 1500);
}
$('m-diag').onclick = () => openDiag(true);
$('m-export').onclick = async () => {
  const b = $('m-export');
  b.disabled = true; b.textContent = 'Exporting…';
  try {
    const r = await api('/api/export');
    const a = document.createElement('a');
    a.href = '/export/' + encodeURIComponent(r.fileName) + '?t=' + TOKEN;
    a.download = r.fileName;
    document.body.appendChild(a); a.click(); a.remove();
    const d = document.createElement('div'); d.className = 'banner ok';
    d.textContent = 'Exported ' + r.fileName + ' (' + Math.max(1, Math.round(r.bytes / 1024)) + ' KB). Saved in ' + r.path + ' and in your Downloads.';
    $('m-banners').prepend(d); setTimeout(() => d.remove(), 15000);
  } catch (e) { alertMsg('Export failed: ' + e.message); }
  finally { b.disabled = false; b.textContent = 'Export data'; }
};
$('d-run').onclick = () => { $('d-body').dataset.at = ''; openDiag(true); };
$('d-close').onclick = () => { diagOpen = false; $('diag').classList.add('hidden'); };
$('diag').onclick = (e) => { if (e.target === $('diag')) $('d-close').onclick(); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && diagOpen) $('d-close').onclick(); });
$('d-copy').onclick = async () => {
  const text = state.diagnostics && state.diagnostics.text;
  if (!text) return;
  try { await navigator.clipboard.writeText(text); $('d-copy').textContent = 'Copied'; }
  catch { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); $('d-copy').textContent = 'Copied'; }
  setTimeout(() => $('d-copy').textContent = 'Copy report', 2000);
};

pollEvery(4000);
refresh();
</script>
</body>
</html>`;
}
