# FairLine — model-vs-market pricing oracle

FairLine is an autonomous in-play pricing engine for soccer. It reprices a match
continuously from TxLINE score and clock state, publishes fair odds as a
**signed, public SSE feed**, and logs its edge against the TxLINE StablePrice
de-margined consensus tick by tick.

It is positioned as a **pricing oracle, not a quoting bot** — it needs no venue
to quote on. Anything downstream (a market maker, a bet screener, a settlement
layer) can subscribe to the feed and verify every price cryptographically.

**Live demo:** https://fairline-demo.vercel.app *(replay mode by default; live
mode ingests the real TxLINE feed for the 2026 World Cup Final)*

## What it does

1. **Ingests TxLINE state** — official score, cards, clock, phase from the
   scores feed; de-margined StablePrice consensus from the odds feed.
2. **Reprices continuously** — an in-play Poisson model with a time-varying
   scoring-intensity profile, Dixon-Coles low-score correction, and red-card
   adjustments. Baseline intensities are calibrated to the pre-match consensus
   board, so all in-play divergence comes from *repricing dynamics*, not from a
   disagreement baked in at kickoff. Math in [docs/model.md](docs/model.md).
3. **Publishes fair odds** — 1X2 + totals as an SSE feed of Ed25519-signed
   envelopes. Anyone can verify any tick against the feed public key
   (`/api/key`), offline. Schema in [docs/feed.md](docs/feed.md).
4. **Logs edge** — model minus consensus, in probability points and EV terms,
   per tick, downloadable as JSON/CSV (`/api/edge-log`).

## Two modes, one code path

| | data | purpose |
|---|---|---|
| **Replay** (default) | committed, seeded, **clearly-labeled synthetic** TxLINE-shaped fixture | deterministic demo: a full match with goals, cards and a red card every ~9 minutes, forever, with no server state |
| **Live** | the **real TxLINE mainnet feed** (free World Cup tier, 60s batch delay) | the same engine pricing the 2026 World Cup Final |

Both modes enter the engine through the same reducers (`lib/txline.js`) — the
replay is not a mock UI, it is the live pipeline fed recorded-shaped data. See
[docs/architecture.md](docs/architecture.md).

**Honesty notes.** The synthetic fixture's "consensus" is a simulated market
(same model family, slightly different parameters, reaction lag, seeded noise);
edge against it demonstrates mechanics, not alpha. Live-mode edge is measured
against real StablePrice, but on the free tier's 60-second delay — informative,
not tradeable. No real-money claims anywhere.

## Run it

```bash
npm test                         # model + engine + signing tests (node --test)
node scripts/generate-fixture.mjs  # regenerate the committed fixture (deterministic)
node scripts/generate-keypair.mjs  # mint a signing key -> FAIRLINE_SIGNING_KEY
PORT=3000 node scripts/dev-server.mjs
```

Environment (all optional — replay mode works with none):

```bash
FAIRLINE_SIGNING_KEY=   # base64 PKCS8 Ed25519 private key; unset -> feed marked unsigned
TXLINE_API_TOKEN=       # TxLINE free-tier API token (activated on-chain)
TXLINE_JWT=             # optional bootstrap guest JWT (auto-renewed at runtime)
TXLINE_FIXTURE_ID=      # default 18257739 (2026 World Cup Final)
```

## API

| endpoint | what |
|---|---|
| `GET /api/feed?mode=replay\|live` | SSE stream of signed price envelopes |
| `GET /api/state?mode=…` | one signed envelope (current tick) |
| `GET /api/edge-log?mode=…&format=json\|csv` | edge history |
| `GET /api/key` | Ed25519 public key + canonicalization contract |
| `POST /api/verify` | reference envelope verification |

## Repo layout

```
lib/       model.js (pricing math) · txline.js (feed reducers) · engine.js (replay)
           live.js (TxLINE ingestion) · sign.js (Ed25519 envelopes)
api/       Vercel serverless endpoints (feed, state, edge-log, key, verify)
fixtures/  committed synthetic replay fixture (seeded, regenerable)
scripts/   fixture generator · keypair generator · dev server
public/    the live view (no-dependency SVG charts) · llms.txt (agent-facing index)
docs/      model math · feed schema · architecture · TxLINE integration notes
mcp/       stdio MCP server wrapping the read endpoints above (agent access)
skills/    fairline/SKILL.md — how an agent should use the MCP tools
test/      node --test suites
```

## For agents

FairLine ships a thin **stdio MCP server** (`mcp/server.mjs`, using the
official `@modelcontextprotocol/sdk`) that wraps the read endpoints above as
three tools — `get_fair_odds`, `get_market_edge`, `get_signing_key` — plus a
Claude Code plugin bundle (`.claude-plugin/plugin.json` + `.mcp.json` +
`skills/fairline/SKILL.md`) that documents how to use them, including honest
replay-vs-live caveats and a described (not implemented) divergence-polling
pattern. Agents without MCP access can hit the same endpoints directly; see
`public/llms.txt` (served at `/llms.txt` on the live site) for the raw-HTTP
fallback.

```bash
npm install                 # pulls in @modelcontextprotocol/sdk, the one added dep
FAIRLINE_BASE_URL=https://fairline-demo.vercel.app node mcp/server.mjs
```

### Codex compatibility

The same stdio server works unchanged with Codex's `mcp_servers` config
(`~/.codex/config.toml` or a project-level equivalent):

```toml
[mcp_servers.fairline]
command = "node"
args = ["/absolute/path/to/fairline/mcp/server.mjs"]

[mcp_servers.fairline.env]
FAIRLINE_BASE_URL = "https://fairline-demo.vercel.app"
```

Codex plugins don't have a sub-agent mechanism, and this bundle doesn't rely
on one — the tools are plain request/response wrappers, and the
divergence-polling pattern in the skill is described in prose for the host
agent to run itself, not delegated to a spawned sub-agent.

MIT license.
