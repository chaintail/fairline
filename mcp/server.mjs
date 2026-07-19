#!/usr/bin/env node
// FairLine MCP server — a thin stdio wrapper around FairLine's existing
// public read-only HTTP endpoints (api/state.js, api/edge-log.js, api/key.js).
// It adds no new logic: every tool call is a fetch() against a running
// FairLine deployment (default: the production demo) and a light reshape of
// the JSON that endpoint already returns. See docs/feed.md and
// docs/architecture.md in the repo root for the full envelope schema.
//
// Run standalone:
//   node mcp/server.mjs
// Configure the target deployment with FAIRLINE_BASE_URL (defaults to the
// public demo, https://fairline-demo.vercel.app).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_URL = (process.env.FAIRLINE_BASE_URL || "https://fairline-demo.vercel.app").replace(/\/+$/, "");

const HONESTY_NOTE =
  "Replay mode is a labeled synthetic fixture (deterministic, seeded, clearly " +
  "marked dataSource.kind = \"synthetic-fixture\") — useful for demoing mechanics, " +
  "not a real match. Live mode ingests the real TxLINE feed for a 2026 World Cup " +
  "Final fixture but carries a ~60s upstream batch delay (informative, not " +
  "tradeable), and may be unconfigured in a given deployment — in that case the " +
  "underlying endpoint returns HTTP 503 and this tool surfaces that as an error, " +
  "which is expected/honest, not a bug.";

async function fetchJson(path) {
  const url = `${BASE_URL}${path}`;
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error(`request to ${url} failed: ${e.message || e}`);
  }
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`non-JSON response from ${url} (status ${res.status}): ${text.slice(0, 300)}`);
  }
  if (!res.ok) {
    // FairLine's own error envelopes are already `{ "error": "..." }` — surface
    // them as-is rather than throwing a generic HTTP error, since a 503 on
    // live mode (not configured) is an expected, documented outcome.
    const detail = body && body.error ? body.error : text.slice(0, 300);
    throw new Error(`${url} -> HTTP ${res.status}: ${detail}`);
  }
  return body;
}

function textResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorResult(err) {
  return {
    content: [{ type: "text", text: `FairLine request failed: ${err.message || err}` }],
    isError: true,
  };
}

const modeSchema = z
  .enum(["replay", "live"])
  .default("replay")
  .describe(
    "replay (default): deterministic seeded synthetic fixture, always available. " +
      "live: the real TxLINE feed for a 2026 World Cup Final fixture, ~60s upstream " +
      "delay, returns an error if live mode isn't configured on this deployment."
  );

const server = new McpServer({
  name: "fairline",
  version: "1.0.0",
  title: "FairLine — model-vs-market soccer pricing oracle",
});

server.registerTool(
  "get_fair_odds",
  {
    title: "Get current fair odds",
    description:
      "Current FairLine match state and model-derived fair odds for one soccer " +
      "fixture: score/clock/phase/cards, model probabilities and fair prices " +
      "(1X2 and totals), the de-margined market consensus when available, and " +
      "per-outcome edge (model minus consensus, in probability points and EV). " +
      "This is one signed envelope (same shape /api/state returns), not a time " +
      "series — use get_market_edge for history. " +
      HONESTY_NOTE,
    inputSchema: { mode: modeSchema },
  },
  async ({ mode }) => {
    try {
      const data = await fetchJson(`/api/state?mode=${mode}`);
      return textResult(data);
    } catch (e) {
      return errorResult(e);
    }
  }
);

server.registerTool(
  "get_market_edge",
  {
    title: "Get model-vs-market edge history",
    description:
      "Historical series of FairLine's model-vs-consensus edge (probability " +
      "points) over the course of the match — the divergence trail, one row per " +
      "tick. Use sinceMs to window to recent action instead of the full match. " +
      "On the synthetic replay fixture this demonstrates repricing mechanics " +
      "(instant model reaction vs a lagged simulated market), not predictive " +
      "skill; on live mode it's measured against the real de-margined TxLINE " +
      "consensus but on a ~60s-delayed feed. " +
      HONESTY_NOTE,
    inputSchema: {
      mode: modeSchema,
      sinceMs: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          "Optional epoch-ms cutoff: only return rows from roughly this point " +
            "forward. In live mode this also tightens the polling window (20s " +
            "instead of 60s) so recent in-play action keeps its shape. Omit for " +
            "the full available history."
        ),
      limit: z
        .number()
        .int()
        .positive()
        .max(500)
        .optional()
        .describe(
          "Optional cap on the number of most-recent rows returned (applied " +
            "client-side after the fetch; the underlying endpoint has its own " +
            "internal row cap, typically a few hundred points)."
        ),
    },
  },
  async ({ mode, sinceMs, limit }) => {
    try {
      const qs = new URLSearchParams({ mode, format: "json" });
      if (sinceMs !== undefined) qs.set("sinceMs", String(sinceMs));
      const data = await fetchJson(`/api/edge-log?${qs.toString()}`);
      if (limit && Array.isArray(data.rows) && data.rows.length > limit) {
        const rows = data.rows.slice(-limit);
        return textResult({ ...data, points: rows.length, rows, truncatedTo: limit });
      }
      return textResult(data);
    } catch (e) {
      return errorResult(e);
    }
  }
);

server.registerTool(
  "get_signing_key",
  {
    title: "Get the feed's Ed25519 signing key",
    description:
      "The Ed25519 public key FairLine signs envelopes with, plus the exact " +
      "canonicalization rule needed to verify a signature: recursively sort all " +
      "object keys, JSON.stringify with no whitespace, UTF-8 encode the envelope " +
      "with its `signature` field removed, then verify Ed25519 against this " +
      "public key. Use this alongside get_fair_odds/raw /api/state or /api/feed " +
      "output to independently confirm an envelope hasn't been tampered with. " +
      "Not affected by replay/live mode.",
    inputSchema: {},
  },
  async () => {
    try {
      const data = await fetchJson("/api/key");
      return textResult(data);
    } catch (e) {
      return errorResult(e);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
