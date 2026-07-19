// GET /api/feed?mode=replay|live — the published SSE price feed.
//
// Each SSE message is a signed FairLine envelope (see docs/feed.md). Replay
// mode emits once per second; live mode polls the 60s-delayed TxLINE free
// tier every 10 seconds. Serverless note: the platform bounds any single
// connection's duration; EventSource auto-reconnects and replay state is a
// pure function of wall-clock time, so reconnects are seamless.

import { replayTick } from "../lib/engine.js";
import { liveTick, liveConfigured } from "../lib/live.js";
import { signEnvelope } from "../lib/sign.js";

export const config = { supportsResponseStreaming: true, maxDuration: 300 };

export default async function handler(req, res) {
  const mode = (req.query.mode || "replay") === "live" ? "live" : "replay";
  if (mode === "live" && !liveConfigured()) {
    res.status(503).json({ error: "live mode not configured on this deployment (TXLINE_API_TOKEN missing); use mode=replay" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "X-Accel-Buffering": "no",
  });

  let closed = false;
  req.on("close", () => { closed = true; });

  const intervalMs = mode === "replay" ? 1000 : 10_000;
  let n = 0;

  const emit = async () => {
    if (closed) return;
    try {
      const envelope = mode === "replay" ? replayTick(Date.now()) : await liveTick();
      const signed = signEnvelope(envelope);
      res.write(`id: ${Date.now()}\nevent: price\ndata: ${JSON.stringify(signed)}\n\n`);
    } catch (e) {
      res.write(`event: feed-error\ndata: ${JSON.stringify({ error: String(e.message || e) })}\n\n`);
    }
  };

  await emit();
  const timer = setInterval(async () => {
    n++;
    if (closed || n > 280_000 / intervalMs) {
      clearInterval(timer);
      if (!closed) res.end();
      return;
    }
    await emit();
  }, intervalMs);
}
