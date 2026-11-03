<p align="center"><img src="assets/soccer-ball-256.png" width="96" alt=""></p>

# Soccer Edge

> ## ⚠️ READ THIS FIRST
>
> **Soccer Edge is a free, open-source engine for people to test and build on. It is provided
> "AS IS", with NO WARRANTY of any kind. You can lose real money with it.**
>
> - **You must optimize the code and every setting for your own needs before you trade.** The
>   defaults are a starting point, not advice, and they are not tuned for you, your money or
>   your goals. Test with small amounts, or with Kalshi's demo account, first.
> - **You make every trading decision.** By default the engine only *shows* picks. Nothing is
>   bought unless you click **Place** / **Buy**, or you turn automation on yourself. If you do,
>   it trades by the rules *you* set. Nobody else sees, controls, approves or reviews your
>   trades: not PredyGo, not the authors.
> - **Not financial, investment, legal or betting advice.** Win chances and "edge" figures are
>   model outputs and can be wrong.
> - **You are responsible** for following Kalshi's terms (including its Developer Agreement)
>   and the laws where you live. Kalshi is only available in some places.
> - Not affiliated with, endorsed by or sponsored by Kalshi.
>
> Full text: [DISCLAIMER.md](DISCLAIMER.md). The app shows it on first run and does nothing
> until you accept it.

## What it is

A desktop app (Windows, and macOS 11+) that:

1. **Reads soccer picks** from the [PredyGo](https://predygo.com/api-docs) API with your own key
   (pre-game and live), or from your own JSON/CSV file on the command line.
2. **Finds the matching Kalshi market** for each pick (total goals, team to score, both teams to
   score, double chance), and checks the kickoff time against Kalshi's schedule.
3. **Shows each pick with Kalshi's live price**, the win chance from the bet type's real track
   record, the edge after Kalshi's fees, and a suggested stake within your limits.
4. **You decide.** Click **Place** (pre-game) or **Buy** (live) to send one order with your own
   Kalshi API key. Every order is re-checked against the live price and your limits first.

Optional, all **off by default** and turned on only by you: auto-trade, live trading, an AI pre-trade check
and an "Ask the AI" chat about your own data (Claude or ChatGPT, one at a time) with your own key, and a Windows background mode.

**Rules in force** lists every rule that can stop a pick, each with an on/off switch and the
values behind it, editable in place. Out of the box the rules that second-guess PredyGo's picks
are off; "Restore defaults" (bottom of Settings) returns to that setup. A few rules are locked on
because "off" would mean buying something that doesn't exist or is already over. On by
default: no buys from the 80th minute, one bet per game, the region check, and kickoff times
agreeing with Kalshi.

Your keys never leave your computer: they are stored encrypted with your password (plus
Windows' own per-user encryption on Windows). There is no server.

## Features

### Picks and matching
- Reads **published PredyGo picks** with your own key, filtered to your tier (you can only pick
  your key's own tier or a lower one).
- Matches each pick to the **exact Kalshi contract**: same league, game, line and side; the kickoff
  must agree with Kalshi's schedule.
- Separate **Pre-game picks**, **Live picks** and **Currently Active Positions** panels, each with a
  status pill that says whether anything is bought automatically ("Buying automatically (Auto-trade
  switch on)") or shown only.
- Live picks are always checked and shown. Their win chance comes from your own graded results by
  stage of the game, or PredyGo's stated confidence until there's enough history.

### Trading
- **Manual by default:** **Place** (pre-game) or **Buy** (live) sends one order after a confirmation.
  Every order re-checks Kalshi's live price and your balance first, and is all-or-nothing.
- Top-bar switches: **Auto-trade**, **Pre-game**, **Live**, **High-risk picks** (off by default), and
  **Stop all trading** (kill switch: stops buying and cancels waiting orders).
- **Buy at my price** (optional): leaves an order on Kalshi's book at what the pick is worth, until
  shortly before kickoff.
- **Use Kalshi odds over feed odds:** judges picks on Kalshi's live price so more picks can trade.

### Rules in force (in Settings)
- Every rule that can stop a pick, in the order it's applied, with an **on/off switch** and its
  **values editable in place**: minimum win chance, edge, max price, spread, stake (flat or Kelly),
  per-trade, daily and open-bet limits, live minute and pick age, and more.
- Rules where "off" would mean buying something that doesn't exist are locked on, with the reason.
- Defaults are set for **as many picks as possible**; switching off a rule that can cost money fast
  (one bet per game, no buys from the 80th minute, region check...) asks first.
- **Restore defaults** puts every setting and rule back; every tooltip shows its default.

### AI assistant (optional, your own key)
- **Claude** (Anthropic) or **ChatGPT** (OpenAI), one at a time, each with its own encrypted key.
- **Pre-trade check:** confirms each order is the right game, line and side; can stop it or just log.
- **Ask the AI:** a chat about your own settings, rules, trades, results, picks, activity and
  diagnostics. Read-only: it can't change anything or trade.
- Models are **discovered from the provider**, so a retired model is replaced automatically. Daily
  spending budget; the cost of every call is shown.

### Data and insight
- Trades with live P/L and trend sparklines, a balance chart, and a **profit scorecard** by bet type,
  price, league and source.
- **Activity** log: each result is announced once, when a trade you hold is decided or settles.
- **Diagnostics:** checks PredyGo, Kalshi, your settings and every pick, and explains why each pick
  was bought or skipped.
- **Export data:** one JSON file with orders, decisions, settlements, the trade journal and settings.
- **Settings as XML:** export and import; a `soccer-edge-settings.xml` next to the app is imported
  automatically.

### Security and safety
- Keys are stored **only in an encrypted file on your PC** (AES-256-GCM, key derived from your app
  password with scrypt). The settings file can never contain a secret. There is no server.
- A full **disclaimer** must be accepted before setup. Nobody else (not PredyGo, not the authors)
  sees or controls your trades.
- **Region check** against Kalshi's restricted states and countries.

### Running it
- **Background mode (Windows):** starts with Windows, unlocks itself with your password kept
  encrypted for your Windows account, and keeps trading with the window closed.
- **Updates:** start a new exe and it replaces the running copy.
- A **command-line** mode for headless use.

## What you need

- A **Kalshi** account and API key (Kalshi > Account > API keys). Using the API means accepting
  Kalshi's Developer Agreement.
- A picks source: a **PredyGo** API key (PredyGo Pro or Elite with the API add-on), or your own
  file of picks for the command-line tools.
- Optional: an **Anthropic** (Claude) or **OpenAI** (ChatGPT) API key for the AI pre-trade check.

## Install

- **Windows**: download `soccer-edge-v<version>.7z` from Releases, unzip, run `soccer-edge.exe`.
  Windows may warn that the app is unsigned; that's expected for a community build.
- **macOS 11+**: download `soccer-edge-mac-v<version>.zip`, unzip, drag to Applications,
  right-click > Open the first time.
- **From source**: see below.

First run: accept the disclaimer, paste your keys, choose a password. Then **Scan now**.

## Settings, and sharing them

Every rule the engine applies is listed under **Rules in force**, with a tooltip on every
control. **Export settings (XML)** saves your settings (never keys or passwords) to a file;
**Import settings (XML)** loads one. A file named `soccer-edge-settings.xml` next to the app, or
in its data folder, is imported automatically when it is new or has changed.

Data folder: `%APPDATA%\soccer-edge` (Windows), `~/Library/Application Support/soccer-edge`
(Mac). **Export data** writes everything the app decided and traded (no keys) to one JSON file,
for your own analysis.

## Build from source

Requires [Bun](https://bun.sh) 1.4+.

```sh
bun install
bun test                      # all tests must pass
bun run src/cli.ts            # run the app from source
bun run src/cli.ts help       # command-line tools (coverage, calibration, scan, ...)
```

Release builds (Python 3 with `py7zr` and `Pillow`):

```sh
python3 scripts/release.py          # Windows .7z (soccer-ball icon, version info) + source zip
python3 scripts/release.py --mac    # also the macOS 11+ app
python3 scripts/make-icon.py        # redraw the icon from assets/soccer-ball.svg (needs Playwright)
```

## How the code is laid out

| Path | What |
|---|---|
| `src/cli.ts` | Entry point: no arguments opens the app; `service` runs Windows background mode; other commands are CLI tools |
| `src/gui/` | Local web UI (`page.ts`), its server and API (`server.ts`), tooltips (`tips.ts`) |
| `src/predictions/` | PredyGo feed and file loading, hit-rate calibration |
| `src/match/` | Bet parsing and matching picks to Kalshi markets |
| `src/kalshi/` | Kalshi Trade API v2 client (RSA-PSS signed) |
| `src/trade/` | Pricing and edge (`edge.ts`), order execution and limits (`executor.ts`), the rules registry (`rules.ts`), P/L tracking |
| `src/live.ts` | In-play engine |
| `src/ai/` | Optional AI pre-trade check (Claude or ChatGPT) |
| `src/settings-xml.ts` | Settings export/import |
| `src/disclaimer.ts` | The disclaimer text (also `DISCLAIMER.md`) |
| `test/` | Bun tests |

## Contributing

Fork it, change it, share it. Pull requests are welcome; `bun test` must pass, and new filters
need an entry in `src/trade/rules.ts` and new controls a tooltip in `src/gui/tips.ts` (tests
check both). Please keep the disclaimer and the "off by default" automation in anything you
redistribute.

## License

[MIT](LICENSE). Parts of the Kalshi client are adapted from MIT-licensed code; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
