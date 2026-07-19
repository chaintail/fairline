# Architecture

```
                                     ┌────────────────────────────────────────┐
   TxLINE mainnet (real)             │            FairLine engine             │
   /scores/updates ───────┐          │                                        │
   /odds/snapshot?asOf ──┤  live     │  txline.js reducers                    │
   /odds/updates ────────┘  mode ──► │   scoreToState()  oddsToConsensus()    │
                                     │            │                │          │
   fixtures/replay-fixture.json      │            ▼                ▼          │
   (committed, seeded, synthetic,    │        model.js         edge calc      │
   TxLINE-shaped) ────── replay ──►  │   priceState() fitLambdas()            │
                            mode     │            │                           │
                                     │            ▼                           │
                                     │   sign.js (Ed25519 envelopes)          │
                                     └───────┬──────────┬──────────┬──────────┘
                                             ▼          ▼          ▼
                                        /api/feed  /api/state  /api/edge-log
                                          (SSE)      (JSON)    (JSON/CSV)
                                             │
                                             ▼
                                     public/ live view (SVG, no deps)
                                     + any subscriber (curl, bots, settlement)
```

## The one deliberate trick: state is a function of time

Replay mode has **no server state, no scheduler, no database**. The fixture is
a committed JSON timeline; `fixtureTime(now) = ((now − anchor) × speed) mod
duration` maps wall-clock to a position in it; everything else is pure
computation. Consequences:

- **Autonomous operation** — the feed prices, publishes, and survives restarts
  and redeploys with zero intervention. There is nothing to babysit: a
  serverless invocation at any instant reproduces the exact tick every other
  invocation would produce.
- **Deterministic validation** — two auditors hitting `/api/state` at the same
  moment get byte-identical envelopes (same signature input); the edge log is
  reproducible from scratch at any time.
- Reconnects/cold starts are free — no session to lose.

Live mode keeps the same property per-tick: an envelope is a pure function of
the latest upstream snapshots. Its edge *history* is rebuilt on demand from
TxLINE's own `/odds/updates` + `/scores/updates` archives, so the deployment
still needs no storage. **Storage seam:** a production deployment that wanted
its own durable archive would insert an append-only store (S3/Postgres) behind
`liveEdgeSeries()` — one function — without touching the pricing path.

## Where a full TxLINE integration plugs in

`lib/live.js` is the only file that talks to TxLINE. It uses the free World
Cup tier (on-chain activated token + auto-renewed guest JWT) and snapshot
polling, sized to that tier's 60-second batch cadence. Upgrading to the
real-time tier is a config change (service level 12) plus swapping the poller
for the SSE client (`/api/odds/stream`, `/api/scores/stream` — the same
payloads our reducers already consume). The on-chain validation endpoints
(`/api/scores/stat-validation`, Merkle proofs against TxLINE's Solana
accounts) are the natural next leg: anchor each FairLine envelope to the
TxLINE sequence number it priced, so a consumer can verify both the input
data (TxLINE's proof) and the output price (our signature). Not built in the
hackathon window — documented so the seam is visible.

## Security posture

- TxLINE credentials live in env vars, never in the repo; the repo ships
  `.env.example` only.
- The signing key is env-only; the public key is served, the private key never
  leaves the deployment.
- All read endpoints are public by design (it's an oracle); there are no
  write endpoints, no user input beyond query params (validated to enums),
  and no persistence to poison. `POST /api/verify` parses JSON in a try/catch
  and returns a boolean — worst case is a 400.
