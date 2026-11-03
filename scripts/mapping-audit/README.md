# Kalshi name-mapping audit

Checks every Kalshi soccer competition and team against PredyGo's names, using the app's own matcher.

1. `python3 kalshi_pull.py` – downloads Kalshi's soccer series and events (public API, ~15 min) to `series.json` / `events.json`.
2. `bun audit.ts <predygo-teams.csv> [since YYYY-MM-DD]` – scores each Kalshi team against PredyGo's team list
   (default: teams with games since 2026-09-01) and writes `audit.json`.

Kalshi teams scoring below 0.6 can't be matched; add a line to `data/team-aliases.json`
(PredyGo name -> Kalshi name). Kalshi competitions with no entry in `data/leagues.json` are only found by
the app's fallback search (both teams must match at 0.85+); add PredyGo's competition name to map them.
Run from this folder.
