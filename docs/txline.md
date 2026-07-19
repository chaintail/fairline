# TxLINE integration notes

What we actually used, verified against the live API on 2026-07-19.

## Access

Free World Cup tier: on-chain `subscribe(serviceLevel, weeks)` on the TxLINE
Solana program, then `POST /auth/guest/start` → guest JWT, sign
`"{txSig}:{leagues}:{jwt}"` with the subscribing wallet, `POST
/api/token/activate` → long-lived API token. Data requests carry
`Authorization: Bearer <jwt>` + `X-Api-Token: <token>`; the JWT is renewed via
`/auth/guest/start` whenever a 401/403 appears (`lib/live.js`).

Service level here is mainnet Level 1: **60-second batch delay**, no rate
limits. That cadence shaped the design (10s poll, 60s history step).

## Endpoints used

| endpoint | use | notes |
|---|---|---|
| `GET /api/fixtures/snapshot` | find the fixture | `Participant1IsHome` is feed positioning, not venue truth |
| `GET /api/scores/snapshot/{fixtureId}` | current state + event list | returns an *event list*; the max-`Seq` item carries current state |
| `GET /api/odds/snapshot/{fixtureId}?asOf=<now>` | current consensus board | **without `asOf` the window only covers the current batch and is often empty** |
| `GET /api/odds/updates/{fixtureId}` | full odds history | 16k+ messages for the Final; used to rebuild edge history |
| `GET /api/odds/stream`, `/api/scores/stream` | SSE firehose | used by our capture tooling; production path for the real-time tier |

## Payload facts our reducers rely on

- Odds prices are **decimal odds × 1000** (`Prices: [2376, 3165, 3801]`).
- `Pct` carries de-margined percentages as 3-decimal strings, `"NA"` on
  quarter lines — we prefer `Pct`, fall back to proportional de-margining.
- The consensus bookmaker is `TXLineStablePriceDemargined` (id 10021).
- Period markets ship alongside full-match ones, flagged by `MarketPeriod`
  (e.g. `half=1`) — they must be filtered out of a full-match consensus.
- Scores payloads use PascalCase in snapshots and camelCase in streams; the
  soccer phase enum is `NS/H1/HT/H2/ET1/ET2/PE/END/FET/FPE/…`; per-period
  score blocks (`H1/H2/…/Total`) carry `Goals/YellowCards/RedCards/Corners`.
- Every scores message has a `Seq` — the hook for TxLINE's on-chain
  stat-validation proofs (future leg; see architecture.md).

## Friction we hit (kept honest for the submission write-up)

1. The odds snapshot's implicit time window (empty between batches) — fixed
   with `asOf`, but it cost a debugging cycle; the docs don't call it out.
2. Docs pages describe flows well but omit example payloads; the OpenAPI YAML
   (`/docs/docs.yaml`) is the real source of truth and excellent — schemas for
   every message type; we generated our synthetic fixture directly from it.
3. `/scores/updates/{fixtureId}` returns the *complete* match history, but
   as one-shot SSE-formatted `data:` lines, not a JSON array — an earlier
   pass here called it broken based on `.json()` failing on it, which cost
   real correctness during the live final: `/scores/snapshot`'s small
   rolling window (~35-40 events) can silently drop real events (including
   goals) between polls. Parse `/scores/updates` as SSE instead; it's the
   reliable source for current state, not just history.
4. Devnet airdrop faucets were dry, so the devnet path (free Level 1,
   0s sampling) was untestable from this environment; mainnet free tier
   worked end to end.
5. Pre-match, `GameState` on odds is `null` and scores arrive as
   `scheduled`/`comment` actions — reducers need permissive defaults.
