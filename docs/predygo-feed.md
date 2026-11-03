# PredyGo feed (as used by Soccer Edge)

Source of truth: https://predygo.com/api-docs (copy saved Oct 17 2026).

- Base `https://predygo.com/api/v1`, key as `Authorization: Bearer <key>` (or `X-API-Key`).
- `GET /predictions` - upcoming picks sent to your tier, pre-game and live (`source`).
  Tier keys: `limit` 1-500 (default 200). Admin `?all=true`: full model list,
  `limit` up to 5000 (default 2000), paged with `offset`; rows carry `posted`.
- `GET /results` - graded picks (`result` win/loss/push/void, `score`). Tier keys:
  `days` default 2, max 7. Admin `all=true`: default 90, max 365.
- `GET /me` - `tier`, `scope`, `pick_limit`, `live_limit` (null = uncapped).
- Every row: `id`, `key` (row_id::bet), `league`, `home`, `away`,
  `market {code, name, canonical}`, `confidence`, `odds` ("6.50 / +550" on published
  picks, raw decimal on the full list), `kickoff`, `source`, `tiers` (e.g. ["pro","elite"]),
  `result`, `score`, `posted_at`, `graded_at`, and on the full list `posted`.
- 60 requests/minute per key; 429 with Retry-After.

What the app asks for:
- Published picks (default): `/predictions?limit=500`, `/results?limit=500&days=7`; with an admin key also `/results?all=true&days=90`, keeping only `posted` rows for the chosen tier (a 90-day record for hit rates).
- Full list (setting off): `?all=true&limit=2000` (+`days=90` on results), paged.
- Tier filter (default Elite): keeps rows whose `tiers` include the chosen tier.
- Live loop: `/predictions?limit=200` every 10 s (6 requests/min).
