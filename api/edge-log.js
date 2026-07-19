// GET /api/edge-log?mode=replay|live&format=json|csv — model-vs-consensus
// edge history. Replay history is recomputed deterministically (pure function
// of time); live history is rebuilt from TxLINE's own /odds/updates history,
// so no database is needed (docs/architecture.md documents the storage seam
// a persistent deployment would use instead).
import { edgeSeries, fixtureTime } from "../lib/engine.js";
import { liveEdgeSeries, liveConfigured } from "../lib/live.js";

export default async function handler(req, res) {
  const mode = (req.query.mode || "replay") === "live" ? "live" : "replay";
  const format = req.query.format === "csv" ? "csv" : "json";
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    let rows;
    if (mode === "live") {
      if (!liveConfigured()) {
        res.status(503).json({ error: "live mode not configured; use mode=replay" });
        return;
      }
      const sinceMs = Number(req.query.sinceMs || 0) || 0;
      // live edge steps at the upstream batch cadence (60s); a windowed
      // request tightens to 20s so in-play action keeps its shape
      rows = await liveEdgeSeries(sinceMs ? 20_000 : 60_000, 400, sinceMs);
    } else {
      rows = edgeSeries(fixtureTime(Date.now()), 30);
    }
    if (format === "csv") {
      const header = "t,phase,clock_or_ts,score,model_home,model_draw,model_away,cons_home,cons_draw,cons_away,edge_home_pp,edge_draw_pp,edge_away_pp";
      const lines = rows.map((r) => [
        r.fixtureTimeSec ?? r.ts, r.phase, r.clock ?? r.ts, r.score,
        ...(r.model1x2 || ["", "", ""]),
        ...(r.consensus1x2 || ["", "", ""]),
        ...(r.edgePp1x2 || ["", "", ""]),
      ].join(","));
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="fairline-edge-log-${mode}.csv"`);
      res.status(200).send([header, ...lines].join("\n"));
    } else {
      res.status(200).json({ mode, points: rows.length, rows });
    }
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
}
