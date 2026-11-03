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
are off; "Restore defaults" in Settings returns to that setup. A few rules are locked on
because "off" would mean buying something that doesn't exist or is already over. On by
default: no buys from the 80th minute, one bet per game, the region check, and kickoff times
agreeing with Kalshi.

Your keys never leave your computer: they are stored encrypted with your password (plus
Windows' own per-user encryption on Windows). There is no server.

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
