// GET /api/state?mode=replay|live — one signed envelope, the current tick.
import { replayTick } from "../lib/engine.js";
import { liveTick, liveConfigured } from "../lib/live.js";
import { signEnvelope } from "../lib/sign.js";

export default async function handler(req, res) {
  const mode = (req.query.mode || "replay") === "live" ? "live" : "replay";
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  try {
    if (mode === "live" && !liveConfigured()) {
      res.status(503).json({ error: "live mode not configured (TXLINE_API_TOKEN missing); use mode=replay" });
      return;
    }
    const envelope = mode === "replay" ? replayTick(Date.now()) : await liveTick();
    res.status(200).json(signEnvelope(envelope));
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
}
