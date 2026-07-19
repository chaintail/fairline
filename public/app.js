/* FairLine front end — no dependencies, hand-rolled SVG charts. */
(() => {
  const OUTCOMES = ["home", "draw", "away"];
  const COLORS = { home: "#3987e5", draw: "#008300", away: "#d55181" };
  const $ = (id) => document.getElementById(id);

  const state = {
    mode: new URLSearchParams(location.search).get("mode") === "live" ? "live" : "replay",
    rows: [],            // edge-log rows (history + appended ticks)
    latest: null,        // latest envelope
    es: null,
    pubkey: null,
    cryptoKey: null,
    sigState: "—",
    liveRefresh: null,
  };

  // ---------------------------------------------------------------- helpers
  const fmtP = (p) => (p == null ? "—" : (p * 100).toFixed(1) + "%");
  const fmtPrice = (thousandths) => (thousandths == null ? "—" : (thousandths / 1000).toFixed(3));
  const fmtPp = (pp) => (pp == null ? "—" : (pp > 0 ? "+" : "") + pp.toFixed(2));
  const fmtEv = (ev) => (ev == null ? "—" : (ev > 0 ? "+" : "") + (ev * 100).toFixed(1) + "%");
  const rowX = (r) => (r.fixtureTimeSec != null ? r.fixtureTimeSec : r.ts);

  // ------------------------------------------------------------- signature
  const canonicalize = (v) => {
    if (Array.isArray(v)) return "[" + v.map(canonicalize).join(",") + "]";
    if (v && typeof v === "object")
      return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonicalize(v[k])).join(",") + "}";
    return JSON.stringify(v);
  };
  const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

  async function verifySig(envelope) {
    if (!envelope.signature || !envelope.signature.value) return "unsigned";
    try {
      if (!state.cryptoKey) {
        state.cryptoKey = await crypto.subtle.importKey(
          "raw", b64ToBytes(envelope.signature.publicKey), { name: "Ed25519" }, false, ["verify"]);
      }
      const { signature, ...body } = envelope;
      const ok = await crypto.subtle.verify({ name: "Ed25519" }, state.cryptoKey,
        b64ToBytes(signature.value), new TextEncoder().encode(canonicalize(body)));
      return ok ? "verified" : "INVALID";
    } catch { return "n/a"; }
  }

  function paintSigChip() {
    const chip = $("sigChip");
    const map = {
      verified: ["sig ✓ verified in-browser", "ok"],
      INVALID: ["sig ✗ INVALID", "bad"],
      unsigned: ["unsigned", "muted"],
      "n/a": ["sig — (browser lacks Ed25519)", "muted"],
      "—": ["signature —", "muted"],
    };
    const [text, cls] = map[state.sigState] || map["—"];
    chip.textContent = text;
    chip.className = "chip " + cls;
  }

  // ------------------------------------------------------------ scoreboard
  function paintScoreboard(env) {
    $("homeName").textContent = env.match.participant1 || "Home";
    $("awayName").textContent = env.match.participant2 || "Away";
    $("scoreLine").textContent = `${env.match.score.home} : ${env.match.score.away}`;
    $("clock").textContent = env.match.clock;
    $("phase").textContent = ({ NS: "pre-match", H1: "1st half", HT: "half-time", H2: "2nd half", END: "full time" })[env.match.phase] || env.match.phase;
    $("homeCards").textContent = "🟥".repeat(env.match.redCards.home) + "🟨".repeat(Math.min(env.match.yellowCards.home, 3));
    $("awayCards").textContent = "🟨".repeat(Math.min(env.match.yellowCards.away, 3)) + "🟥".repeat(env.match.redCards.away);
  }

  // ----------------------------------------------------------- price board
  function paintBoard(env) {
    const tbody = $("board").querySelector("tbody");
    const rows = [];
    const e1 = env.edge && env.edge.oneXTwo;
    const labels = { home: env.match.participant1, draw: "Draw", away: env.match.participant2 };
    for (const k of OUTCOMES) {
      const m = env.model.oneXTwo.probs[k];
      const c = env.consensus.oneXTwo ? env.consensus.oneXTwo[k] : null;
      const ed = e1 ? e1[k] : null;
      rows.push({
        label: labels[k], dot: COLORS[k], model: m,
        fair: env.model.oneXTwo.fairPrices[k], cons: c,
        pp: ed ? ed.edgePp : null, ev: ed ? ed.ev : null,
      });
    }
    for (const [line, t] of Object.entries(env.model.totals || {})) {
      const c = env.consensus.totals && env.consensus.totals[line];
      const ed = env.edge.totals && env.edge.totals[line];
      rows.push({
        label: `Over ${line}`, dot: null, model: t.over, fair: t.fairPriceOver,
        cons: c ? c.over : null, pp: ed ? ed.over.edgePp : null, ev: ed ? ed.over.ev : null,
      });
    }
    tbody.innerHTML = rows.map((r) => `
      <tr>
        <td>${r.dot ? `<span class="mkdot" style="background:${r.dot}"></span>` : ""}${r.label}</td>
        <td>${fmtP(r.model)}</td>
        <td>${fmtPrice(r.fair)}</td>
        <td>${fmtP(r.cons)}</td>
        <td class="${r.pp > 0 ? "pos" : r.pp < 0 ? "neg" : ""}">${fmtPp(r.pp)}</td>
        <td class="${r.ev > 0 ? "pos" : r.ev < 0 ? "neg" : ""}">${fmtEv(r.ev)}</td>
      </tr>`).join("");
    $("boardNote").textContent = env.mode === "live"
      ? "consensus: TxLINE StablePrice (de-margined, 60s delay)"
      : "consensus: simulated StablePrice-shaped market (synthetic)";
  }

  // ---------------------------------------------------------------- charts
  function niceTicks(rows) {
    // x ticks: every 15 match minutes in replay (using clock), 5 wall-minutes live
    const ticks = [];
    if (!rows.length) return ticks;
    if (state.mode === "replay") {
      let lastMin = -1;
      for (const r of rows) {
        const min = parseInt((r.clock || "0:00").split(":")[0], 10);
        if (min % 15 === 0 && min !== lastMin && r.phase !== "NS") {
          ticks.push({ x: rowX(r), label: min + "'" });
          lastMin = min;
        }
      }
    } else {
      const t0 = rowX(rows[0]), t1 = rowX(rows[rows.length - 1]);
      const step = Math.max(5 * 60_000, Math.ceil((t1 - t0) / 8 / 60000) * 60000);
      for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
        const d = new Date(t);
        ticks.push({ x: t, label: d.getUTCHours().toString().padStart(2, "0") + ":" + d.getUTCMinutes().toString().padStart(2, "0") + "Z" });
      }
    }
    return ticks;
  }

  function eventMarkers(rows) {
    const out = [];
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1], cur = rows[i];
      if (prev.score !== cur.score) out.push({ x: rowX(cur), icon: "⚽", label: cur.score });
      const pr = prev.reds || [0, 0], cr = cur.reds || [0, 0];
      if (cr[0] > pr[0] || cr[1] > pr[1]) out.push({ x: rowX(cur), icon: "🟥", label: "red card" });
    }
    return out;
  }

  function phaseBands(rows) {
    const bands = [];
    let start = null, phase = null;
    for (const r of rows) {
      const banded = r.phase === "NS" || r.phase === "HT" || r.phase === "END";
      if (banded && start == null) { start = rowX(r); phase = r.phase; }
      if ((!banded || r.phase !== phase) && start != null) { bands.push({ x0: start, x1: rowX(r), phase }); start = banded ? rowX(r) : null; phase = banded ? r.phase : null; }
    }
    if (start != null) bands.push({ x0: start, x1: rowX(rows[rows.length - 1]), phase });
    return bands;
  }

  function drawChart(svgId, tipId, rows, seriesDef, yDomain, yFormat) {
    const svg = $(svgId);
    const W = svg.clientWidth || 900, H = svg.clientHeight || 240;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const PAD = { l: 44, r: 12, t: 10, b: 22 };
    const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
    if (!rows.length) { svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" class="axis-label">waiting for data…</text>`; return; }

    const x0 = rowX(rows[0]), x1 = Math.max(rowX(rows[rows.length - 1]), x0 + 1);
    const X = (v) => PAD.l + ((v - x0) / (x1 - x0)) * iw;
    const [y0, y1] = yDomain(rows);
    const Y = (v) => PAD.t + ih - ((v - y0) / (y1 - y0 || 1)) * ih;

    let out = "";
    // phase bands
    for (const b of phaseBands(rows)) out += `<rect class="phase-band" x="${X(b.x0)}" y="${PAD.t}" width="${Math.max(0, X(b.x1) - X(b.x0))}" height="${ih}"/>`;
    // y grid + labels
    const ySteps = 4;
    for (let i = 0; i <= ySteps; i++) {
      const v = y0 + ((y1 - y0) * i) / ySteps;
      out += `<line class="${Math.abs(v) < 1e-9 && y0 < 0 ? "zero-line" : "gridline"}" x1="${PAD.l}" x2="${W - PAD.r}" y1="${Y(v)}" y2="${Y(v)}"/>`;
      out += `<text class="axis-label" x="${PAD.l - 6}" y="${Y(v) + 3}" text-anchor="end">${yFormat(v)}</text>`;
    }
    // x ticks
    for (const t of niceTicks(rows)) {
      out += `<line class="gridline" x1="${X(t.x)}" x2="${X(t.x)}" y1="${PAD.t}" y2="${PAD.t + ih}"/>`;
      out += `<text class="axis-label" x="${X(t.x)}" y="${H - 6}" text-anchor="middle">${t.label}</text>`;
    }
    // event markers
    for (const m of eventMarkers(rows)) {
      out += `<line class="event-line" x1="${X(m.x)}" x2="${X(m.x)}" y1="${PAD.t + 12}" y2="${PAD.t + ih}"/>`;
      out += `<text class="event-icon" x="${X(m.x)}" y="${PAD.t + 10}" text-anchor="middle">${m.icon}</text>`;
    }
    // series
    for (const s of seriesDef) {
      let d = "", pen = false;
      for (const r of rows) {
        const v = s.get(r);
        if (v == null) { pen = false; continue; }
        d += (pen ? "L" : "M") + X(rowX(r)).toFixed(1) + " " + Y(v).toFixed(1) + " ";
        pen = true;
      }
      out += `<path class="series ${s.dashed ? "dashed" : ""}" stroke="${s.color}" d="${d}"/>`;
    }
    svg.innerHTML = out;

    // hover layer
    const tip = $(tipId);
    svg.onmousemove = (ev) => {
      const rect = svg.getBoundingClientRect();
      const mx = ev.clientX - rect.left;
      const targetX = x0 + ((mx - PAD.l) / iw) * (x1 - x0);
      let best = rows[0], bd = Infinity;
      for (const r of rows) { const d = Math.abs(rowX(r) - targetX); if (d < bd) { bd = d; best = r; } }
      const lines = seriesDef.filter((s) => s.get(best) != null).map((s) =>
        `<tr><td><span class="mkdot" style="background:${s.color};display:inline-block;width:7px;height:7px;border-radius:50%"></span> ${s.name}</td><td style="text-align:right">${yFormat(s.get(best))}</td></tr>`).join("");
      tip.innerHTML = `<div class="t-head">${best.clock || new Date(best.ts).toISOString().slice(11, 16) + "Z"} · ${best.score}${(best.reds && (best.reds[0] + best.reds[1])) ? " · 🟥" : ""}</div><table>${lines}</table>`;
      tip.style.display = "block";
      const tw = tip.offsetWidth;
      tip.style.left = Math.min(Math.max(mx - tw / 2, 4), rect.width - tw - 4) + "px";
      tip.style.top = "10px";
      // crosshair
      const old = svg.querySelector(".crosshair");
      if (old) old.remove();
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("class", "crosshair");
      line.setAttribute("x1", X(rowX(best))); line.setAttribute("x2", X(rowX(best)));
      line.setAttribute("y1", PAD.t); line.setAttribute("y2", PAD.t + ih);
      svg.appendChild(line);
    };
    svg.onmouseleave = () => { tip.style.display = "none"; const c = svg.querySelector(".crosshair"); if (c) c.remove(); };
  }

  function redraw() {
    const rows = state.rows;
    const probSeries = [];
    OUTCOMES.forEach((k, i) => probSeries.push({ name: k, color: COLORS[k], dashed: false, get: (r) => (r.model1x2 ? r.model1x2[i] : null) }));
    OUTCOMES.forEach((k, i) => probSeries.push({ name: k + " (mkt)", color: COLORS[k], dashed: true, get: (r) => (r.consensus1x2 ? r.consensus1x2[i] : null) }));
    drawChart("probChart", "probTip", rows, probSeries, () => [0, 1], (v) => (v * 100).toFixed(0) + "%");

    const edgeSeries = OUTCOMES.map((k, i) => ({ name: k, color: COLORS[k], dashed: false, get: (r) => (r.edgePp1x2 ? r.edgePp1x2[i] : null) }));
    drawChart("edgeChart", "edgeTip", rows, edgeSeries, (rs) => {
      let m = 2;
      for (const r of rs) if (r.edgePp1x2) for (const e of r.edgePp1x2) m = Math.max(m, Math.abs(e));
      m = Math.ceil(m);
      return [-m, m];
    }, (v) => v.toFixed(1));

    const legend = OUTCOMES.map((k) => `<span class="key"><span class="dot" style="background:${COLORS[k]}"></span>${k}</span>`).join("");
    $("probLegend").innerHTML = legend;
    $("edgeLegend").innerHTML = legend;
  }

  // -------------------------------------------------------------- data flow
  function envelopeToRow(env) {
    const m = env.model.oneXTwo.probs, c = env.consensus.oneXTwo, e = env.edge.oneXTwo;
    return {
      fixtureTimeSec: env.mode === "replay" ? env.fixtureTimeSec : undefined,
      ts: env.publishedAt,
      phase: env.match.phase,
      clock: env.match.clock,
      score: `${env.match.score.home}-${env.match.score.away}`,
      reds: [env.match.redCards.home, env.match.redCards.away],
      model1x2: [m.home, m.draw, m.away],
      consensus1x2: c ? [c.home, c.draw, c.away] : null,
      edgePp1x2: e ? [e.home.edgePp, e.draw.edgePp, e.away.edgePp] : null,
    };
  }

  async function loadHistory() {
    try {
      // live mode: rolling 3h window — without it, days of pre-match drift
      // squeeze the in-play story into the right edge of the charts
      const since = state.mode === "live" ? `&sinceMs=${Date.now() - 3 * 3600_000}` : "";
      const r = await fetch(`/api/edge-log?mode=${state.mode}${since}`);
      const d = await r.json();
      state.rows = d.rows || [];
      redraw();
    } catch { /* keep whatever we have */ }
  }

  function connect() {
    if (state.es) state.es.close();
    const es = new EventSource(`/api/feed?mode=${state.mode}`);
    state.es = es;
    $("connChip").textContent = "connecting…";
    $("connChip").className = "chip muted";
    es.onopen = () => { $("connChip").textContent = "● feed connected"; $("connChip").className = "chip ok"; };
    es.onerror = () => { $("connChip").textContent = "feed reconnecting…"; $("connChip").className = "chip bad"; };
    es.addEventListener("price", async (msg) => {
      const env = JSON.parse(msg.data);
      state.latest = env;
      paintScoreboard(env);
      paintBoard(env);
      state.sigState = await verifySig(env);
      paintSigChip();

      const row = envelopeToRow(env);
      const rows = state.rows;
      if (state.mode === "replay") {
        const last = rows.length ? rows[rows.length - 1] : null;
        if (last && row.fixtureTimeSec < last.fixtureTimeSec - 5) {
          // fixture looped — start the story over
          state.rows = [];
          loadHistory();
        } else if (!last || row.fixtureTimeSec - last.fixtureTimeSec >= 5) {
          rows.push(row);
        } else {
          rows[rows.length - 1] = { ...rows[rows.length - 1], ...row };
        }
      } else if (!rows.length || row.ts - rows[rows.length - 1].ts >= 30_000) {
        rows.push(row);
      }
      redraw();
    });
    es.addEventListener("feed-error", (msg) => {
      try { const e = JSON.parse(msg.data); $("connChip").textContent = "feed error: " + e.error; $("connChip").className = "chip bad"; } catch {}
    });
  }

  function paintModeChrome() {
    document.querySelectorAll("#modeTabs button").forEach((b) => b.classList.toggle("active", b.dataset.mode === state.mode));
    const chip = $("dataChip");
    if (state.mode === "live") {
      chip.textContent = "REAL TxLINE DATA · 60s delay";
      chip.className = "chip live-real";
      $("honestyText").innerHTML = "Live mode ingests the <em>real</em> TxLINE StablePrice feed (free World Cup tier, 60-second batch delay) and official score state for the 2026 World Cup Final, reprices it continuously with the FairLine model, and signs every published tick. The model baseline was frozen from the pre-match consensus. Replay mode (the default view) is a clearly-labeled synthetic fixture for deterministic demos.";
    } else {
      chip.textContent = "SYNTHETIC FIXTURE";
      chip.className = "chip synthetic";
      $("honestyText").innerHTML = "Replay mode replays a deterministic, seeded <em>synthetic</em> TxLINE-shaped fixture — synthetic score events and a simulated de-margined consensus path — through exactly the code path a live TxLINE feed enters. It demonstrates the engine's mechanics, not real-world alpha. Live mode ingests the real TxLINE StablePrice feed (free World Cup tier, 60-second batch delay) for the 2026 World Cup Final.";
    }
    $("curlFeed").textContent = `curl -N "${location.origin}/api/feed?mode=${state.mode}"`;
    $("dlJson").href = `/api/edge-log?mode=${state.mode}`;
    $("dlCsv").href = `/api/edge-log?mode=${state.mode}&format=csv`;
  }

  function setMode(mode) {
    state.mode = mode;
    state.rows = [];
    state.sigState = "—";
    const url = new URL(location);
    url.searchParams.set("mode", mode);
    history.replaceState(null, "", url);
    paintModeChrome();
    paintSigChip();
    loadHistory();
    connect();
    clearInterval(state.liveRefresh);
    if (mode === "live") state.liveRefresh = setInterval(loadHistory, 60_000);
  }

  // ------------------------------------------------------------------ boot
  document.querySelectorAll("#modeTabs button").forEach((b) => b.onclick = () => setMode(b.dataset.mode));
  window.addEventListener("resize", redraw);
  fetch("/api/key").then((r) => r.json()).then((k) => {
    $("pubkey").textContent = k.configured
      ? `alg: Ed25519\npublicKey (base64): ${k.publicKey}\ncanonicalization: ${k.canonicalization}`
      : "signing not configured on this deployment";
  }).catch(() => {});
  setMode(state.mode);
})();
