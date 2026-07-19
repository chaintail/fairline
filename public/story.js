/* FairLine story page — one live chart: draw-outcome edge (model - market,
   pp) over time, pulled from the real production edge-log. Adapted from the
   hand-rolled SVG line-chart approach in app.js (no chart library). Degrades
   to a fallback message on fetch failure (offline dev, CORS, endpoint
   quirks after the match ends), rather than breaking the page. */
(() => {
  const SOURCE = "https://fairline-demo.vercel.app/api/edge-log?mode=live&format=json&sinceMs=0";
  const svg = document.getElementById("liveChart");
  const fallback = document.getElementById("chartFallback");
  const status = document.getElementById("chartStatus");

  function showFallback(msg) {
    svg.classList.add("hide");
    fallback.classList.add("show");
    status.textContent = "unavailable";
    if (msg) fallback.firstChild && (fallback.title = msg);
  }

  function drawDrawEdge(rows) {
    const pts = rows
      .map((r) => ({ x: r.ts ?? r.fixtureTimeSec, y: Array.isArray(r.edgePp1x2) ? r.edgePp1x2[1] : null }))
      .filter((p) => p.x != null && p.y != null);
    if (pts.length < 2) { showFallback("not enough points"); return; }

    const W = svg.clientWidth || 900, H = svg.clientHeight || 220;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const PAD = { l: 40, r: 12, t: 12, b: 22 };
    const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;

    const x0 = pts[0].x, x1 = Math.max(pts[pts.length - 1].x, x0 + 1);
    let yMax = 2;
    for (const p of pts) yMax = Math.max(yMax, Math.abs(p.y));
    yMax = Math.ceil(yMax / 2) * 2;
    const y0 = -yMax, y1 = yMax;

    const X = (v) => PAD.l + ((v - x0) / (x1 - x0)) * iw;
    const Y = (v) => PAD.t + ih - ((v - y0) / (y1 - y0)) * ih;

    let out = "";
    const ySteps = 4;
    for (let i = 0; i <= ySteps; i++) {
      const v = y0 + ((y1 - y0) * i) / ySteps;
      out += `<line class="${Math.abs(v) < 1e-9 ? "zero-line" : "gridline"}" x1="${PAD.l}" x2="${W - PAD.r}" y1="${Y(v)}" y2="${Y(v)}"/>`;
      out += `<text class="axis-label" x="${PAD.l - 6}" y="${Y(v) + 3}" text-anchor="end">${v.toFixed(0)}pp</text>`;
    }
    const xTicks = 5;
    for (let i = 0; i <= xTicks; i++) {
      const t = x0 + ((x1 - x0) * i) / xTicks;
      const d = new Date(t);
      out += `<line class="gridline" x1="${X(t)}" x2="${X(t)}" y1="${PAD.t}" y2="${PAD.t + ih}"/>`;
      out += `<text class="axis-label" x="${X(t)}" y="${H - 6}" text-anchor="middle">${d.getUTCHours().toString().padStart(2, "0")}:${d.getUTCMinutes().toString().padStart(2, "0")}Z</text>`;
    }

    let line = "", area = `M${X(pts[0].x).toFixed(1)} ${Y(0).toFixed(1)} `;
    pts.forEach((p, i) => {
      const cmd = (i === 0 ? "M" : "L") + X(p.x).toFixed(1) + " " + Y(p.y).toFixed(1) + " ";
      line += cmd;
      area += "L" + X(p.x).toFixed(1) + " " + Y(p.y).toFixed(1) + " ";
    });
    area += `L${X(pts[pts.length - 1].x).toFixed(1)} ${Y(0).toFixed(1)} Z`;
    out += `<path class="draw-fill" d="${area}"/>`;
    out += `<path class="draw-series" d="${line}"/>`;
    svg.innerHTML = out;

    const last = pts[pts.length - 1];
    status.textContent = `live · ${pts.length} points · latest ${last.y > 0 ? "+" : ""}${last.y.toFixed(1)}pp`;
  }

  async function load() {
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 12000);
      const r = await fetch(SOURCE, { signal: ctrl.signal, mode: "cors" });
      clearTimeout(timeout);
      if (!r.ok) throw new Error("HTTP " + r.status);
      const d = await r.json();
      const rows = d.rows || [];
      if (!rows.length) { showFallback("empty response"); return; }
      drawDrawEdge(rows);
    } catch (e) {
      showFallback(String(e && e.message || e));
    }
  }

  load();
  window.addEventListener("resize", () => { if (!svg.classList.contains("hide")) load(); });
})();
