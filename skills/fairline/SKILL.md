---
name: fairline
description: "Use when an agent needs FairLine's model-vs-market soccer pricing data — current fair odds, the model-vs-consensus edge/divergence history, or the feed's Ed25519 signing key. Covers the fairline MCP server's three tools, how to install/run it, honest replay-vs-live caveats, and a described (not implemented) pattern for polling edge and acting on a threshold. Triggers: 'FairLine odds', 'model vs market edge', 'pricing oracle', 'TxLINE consensus', fetching /api/state or /api/edge-log by hand."
---

# FairLine

FairLine is a model-vs-market pricing oracle for in-play soccer. It reprices a
match continuously from TxLINE score/clock/card state with a transparent
in-play Poisson model (Dixon-Coles corrected, red-card adjusted — see
`docs/model.md` in the repo), publishes fair odds as Ed25519-signed envelopes,
and logs its edge (model minus the de-margined market consensus) tick by
tick. It prices; it does not quote or place bets, and it makes no real-money
claims.

Two modes, always labeled:

- **replay** (default) — a committed, seeded, deterministic **synthetic**
  fixture. Always available, good for demoing mechanics. Its "consensus" is a
  simulated market, so edge here shows repricing dynamics, not real alpha.
- **live** — the real TxLINE feed for a 2026 World Cup Final fixture, with a
  **~60 second** upstream batch delay (informative, not tradeable). May be
  unconfigured on a given deployment, in which case the underlying endpoint
  (and any tool wrapping it) returns an honest error/503 — that is expected,
  not a bug, and callers should treat it as "unavailable here," not "broken."

Full write-ups: `docs/architecture.md`, `docs/feed.md`, `docs/model.md` in
the repo (https://github.com/chaintail/fairline).

## Installing / running the MCP server

The MCP server (`mcp/server.mjs`) is a thin stdio wrapper: every tool call is
a `fetch()` against FairLine's existing public HTTP read endpoints on a
running deployment. It adds no pricing logic of its own.

**As a Claude Code plugin** (this repo doubles as the plugin root):

```
/plugin install fairline@<marketplace-or-path>
```

or, added straight from a local checkout, point Claude Code's plugin loader
at the repo root — it picks up `.claude-plugin/plugin.json` and `.mcp.json`,
which wires the `fairline` MCP server to
`node ${CLAUDE_PLUGIN_ROOT}/mcp/server.mjs`.

**Standalone** (any MCP-capable client, including Codex — see the repo
README's "Codex compatibility" section for a `mcp_servers` TOML snippet):

```bash
cd fairline
npm install                 # pulls in @modelcontextprotocol/sdk (the one dep)
node mcp/server.mjs         # stdio MCP server; talks to fairline-demo.vercel.app
```

Configure the target deployment with `FAIRLINE_BASE_URL` (defaults to
`https://fairline-demo.vercel.app`, the public demo):

```bash
FAIRLINE_BASE_URL=http://localhost:3000 node mcp/server.mjs
```

## The three tools

### `get_fair_odds({ mode })`

Wraps `GET /api/state?mode=…`. Returns one signed envelope: match state
(score/clock/phase/cards), model probabilities + fair prices (1X2 and
totals), the de-margined consensus when available, and per-outcome edge
(probability points + EV). `mode` defaults to `replay`.

Example call and (shape of) response:

```
get_fair_odds({ mode: "replay" })
->
{
  "mode": "replay",
  "dataSource": { "kind": "synthetic-fixture", "label": "SYNTHETIC FIXTURE — deterministic replay" },
  "match": { "participant1": "Azuria", "participant2": "Ferrona", "phase": "H2", "clock": "66:27", "score": {"home":1,"away":1} },
  "model": { "oneXTwo": { "probs": {"home":0.243,"draw":0.583,"away":0.174}, "fairPrices": {"home":4114,"draw":1717,"away":5734} }, "totals": {...} },
  "consensus": { "oneXTwo": {"home":0.266,"draw":0.574,"away":0.160} },
  "edge": { "oneXTwo": { "home": {"edgePp":-2.32,"ev":-0.087}, ... } },
  "signature": { "alg": "Ed25519", "publicKey": "...", "value": "..." }
}
```

### `get_market_edge({ mode, sinceMs?, limit? })`

Wraps `GET /api/edge-log?mode=…&sinceMs=…`. Returns the divergence trail: one
row per tick with model/consensus 1X2 probabilities and edge in probability
points. `sinceMs` (epoch ms) windows to recent action instead of the whole
match; in live mode it also tightens the poll cadence. `limit` caps the
number of most-recent rows the tool returns.

```
get_market_edge({ mode: "replay", limit: 3 })
-> { "mode": "replay", "points": 3, "rows": [ { "fixtureTimeSec": 4590, "score": "1-1",
     "model1x2": [0.243,0.583,0.174], "consensus1x2": [0.266,0.574,0.160],
     "edgePp1x2": [-2.34,0.88,1.46] }, ... ] }
```

### `get_signing_key({})`

Wraps `GET /api/key`. Returns the Ed25519 public key and the exact
canonicalization rule (recursively sort all object keys, `JSON.stringify`
with no whitespace, UTF-8 encode the envelope with `signature` removed, then
verify Ed25519 against this key). Not affected by mode; use it alongside
either tool above, or raw `/api/state` / `/api/feed` output, to independently
confirm an envelope wasn't tampered with.

## Pattern: watching for a divergence crossing (described, not implemented)

A common use for `get_market_edge` is noticing when the model and market
start disagreeing by more than noise, and reacting. This skill describes the
shape of that loop in prose — it is **not** wired up as code, a scheduled
job, or any kind of sub-agent here; an agent following this skill runs it
step by step in its own turn, or a host application implements it as a
regular timer:

1. Pick a threshold in probability points (e.g. 3-5pp on the 1X2 home/draw/
   away edge, informed by `docs/model.md`'s note that pre-match edge should
   be ~0 by construction — persistent pre-match edge or unusually large
   in-play edge is the signal worth noticing) and a poll interval (seconds
   in replay, tens of seconds in live — polling faster than the ~60s live
   batch cadence documented above adds nothing).
2. On each wake, call `get_market_edge` with `sinceMs` set to the last poll's
   timestamp (not the whole match) so each check only looks at new rows.
3. Compare each new row's `edgePp1x2` entries against the threshold. If
   `mode` is `live` and the call errors (503, unconfigured), treat that as
   "no signal available this cycle," not a failure to escalate.
4. When a crossing is found, the appropriate action is context-specific
   (surface it to a human, log it, annotate a dashboard, feed it to
   whatever downstream consumer the host application has) — this skill
   does not prescribe one, and does not spawn any additional agent to
   handle it. Keep the reaction inline in the same session/loop that
   noticed the crossing.
5. Re-arm for the next interval. Because both replay and live are pure
   functions of time/upstream state (`docs/architecture.md`), there is no
   session state to carry between wakes beyond "what's the last `sinceMs`
   I've already seen."

## Raw HTTP fallback (no MCP)

Every tool is a thin wrapper; an agent without MCP access can hit the same
endpoints directly:

```bash
curl "https://fairline-demo.vercel.app/api/state?mode=replay"
curl "https://fairline-demo.vercel.app/api/edge-log?mode=replay&format=json&sinceMs=0"
curl "https://fairline-demo.vercel.app/api/key"
```

See `public/llms.txt` in the repo for the same fallback aimed at agents
landing on the site directly.
