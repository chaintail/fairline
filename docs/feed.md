# The FairLine feed

## Transport

`GET /api/feed?mode=replay|live` — `text/event-stream` (SSE), CORS-open.

- Replay mode: one `price` event per second.
- Live mode: one `price` event per ~10 seconds (upstream free tier batches at
  60s, so faster polling adds nothing).
- Standard `EventSource` semantics; the serverless platform bounds a single
  connection's lifetime, clients auto-reconnect, and ticks are pure functions
  of time, so reconnects lose nothing.

Events:

```
event: price          # a signed envelope (below)
event: feed-error     # {"error": "..."} — upstream hiccup; stream continues
```

`GET /api/state` returns exactly one envelope (same shape) for curl-friendly
inspection.

## The envelope

```jsonc
{
  "v": 1,
  "producer": "fairline",
  "mode": "replay",                     // or "live"
  "dataSource": {                       // honesty block — always present
    "kind": "synthetic-fixture",        // or "txline-mainnet"
    "label": "SYNTHETIC FIXTURE — deterministic replay",
    "fixtureId": 90000001,
    "loop": 91                          // replay iteration counter
  },
  "publishedAt": 1784447953413,         // ms epoch
  "fixtureTimeSec": 2141,               // replay only: position in the fixture
  "match": {
    "participant1": "Azuria", "participant2": "Ferrona",
    "phase": "H1",                      // NS|H1|HT|H2|ET1|ET2|PE|END|FET|FPE
    "clock": "32:40",
    "score": { "home": 1, "away": 0 },
    "redCards": { "home": 0, "away": 0 },
    "yellowCards": { "home": 0, "away": 1 }
  },
  "model": {
    "name": "in-play Poisson, time-decay intensity, card-adjusted",
    "remaining": { "lambdaHome": 0.8987, "lambdaAway": 0.6806 },
    "oneXTwo": {
      "probs": { "home": 0.739, "draw": 0.1878, "away": 0.0732 },
      "fairPrices": { "home": 1353, "draw": 5325, "away": 13655 }   // decimal odds × 1000 (TxLINE price units)
    },
    "totals": { "2.5": { "over": 0.4, "under": 0.6, "fairPriceOver": 2500 } }
  },
  "consensus": {                        // de-margined market, same structure
    "source": "TXLineStablePriceDemargined",
    "oneXTwo": { "home": 0.7611, "draw": 0.1775, "away": 0.0614 },
    "totals": { "2.5": { "over": 0.41, "under": 0.59 } }
  },
  "edge": {                             // model minus consensus
    "oneXTwo": { "home": { "model": 0.739, "consensus": 0.7611,
                            "edgePp": -2.21, "ev": -0.029 }, ... },
    "totals":  { "2.5": { "over": { ... } } }
  },
  "terminal": false,
  "signature": {                        // or null + "signing": "disabled …"
    "alg": "Ed25519",
    "publicKey": "…base64 raw 32-byte key…",
    "canonicalization": "recursive-key-sort JSON of the envelope without the `signature` field",
    "value": "…base64 signature…"
  }
}
```

## Verifying a tick

The signature covers the canonical serialization of the envelope **without**
the `signature` field: recursively sort all object keys, `JSON.stringify` with
no whitespace, UTF-8 encode, verify with Ed25519 against `/api/key`.

Reference implementations: `lib/sign.js` (Node), the in-browser verifier in
`public/app.js` (WebCrypto), and `POST /api/verify` as a hosted convenience.
The demo page verifies every incoming tick in your browser and shows the
result in the header chip.

## Edge log

`GET /api/edge-log?mode=…` → `{ mode, points, rows: [...] }`;
`&format=csv` → CSV download. Replay history is recomputed deterministically;
live history is rebuilt from TxLINE's own `/odds/updates` archive.
