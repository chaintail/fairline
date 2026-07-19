// Live mode: the same engine pointed at the real TxLINE mainnet feed.
//
// Credentials come from env (free World Cup tier, activated on-chain; see
// docs/txline.md). The JWT is a short-lived guest session renewed via
// /auth/guest/start; the API token is long-lived. Ingestion is snapshot
// polling — appropriate for the free tier's 60-second batch delay — and the
// edge history is reconstructed on demand from TxLINE's own /odds/updates and
// /scores/snapshot history, so the deployment needs no database.

import { priceState, fitLambdas } from "./model.js";
import { normalizedTime, oddsToConsensus, scoreToState, hasScoreState, mergeScoreEvents, isTerminal } from "./txline.js";
import { buildEnvelope, edgeBetween } from "./engine.js";

const BASE = process.env.TXLINE_API_BASE || "https://txline.txodds.com/api";
const JWT_URL = process.env.TXLINE_JWT_URL || "https://txline.txodds.com/auth/guest/start";
export const LIVE_FIXTURE_ID = Number(process.env.TXLINE_FIXTURE_ID || 18257739);

// Pre-match model baseline, frozen from the real de-margined StablePrice
// board for this fixture (captured 2026-07-19T07:40Z, before kickoff).
// While the fixture is still pre-match we re-fit from the current board
// instead, so the baseline tracks the market right up to kickoff.
const FROZEN_BASELINE = { pHome: 0.42088, pDraw: 0.31596, pAway: 0.26309, pOver25: 0.40241 };

let jwt = process.env.TXLINE_JWT || "";
const apiToken = process.env.TXLINE_API_TOKEN || "";

export function liveConfigured() {
  return Boolean(apiToken);
}

async function renewJwt() {
  const r = await fetch(JWT_URL, { method: "POST" });
  if (!r.ok) throw new Error(`guest JWT renewal failed: ${r.status}`);
  jwt = (await r.json()).token;
  return jwt;
}

async function api(path) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!jwt) await renewJwt();
    const r = await fetch(`${BASE}${path}`, {
      headers: { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken },
    });
    if (r.status === 401 || r.status === 403) { jwt = ""; continue; }
    if (!r.ok) throw new Error(`TxLINE ${path} -> ${r.status}`);
    return r.json();
  }
  throw new Error(`TxLINE auth failed for ${path}`);
}

// /scores/updates/{id} serves the COMPLETE match event history, but as a
// one-shot text/event-stream dump (`data: {...}` lines), not JSON — despite
// docs/txline.md's earlier note that it "404s/non-JSONs for this fixture"
// (true in the sense that it isn't directly .json()-parseable, but it does
// work once parsed as SSE). This matters because /scores/snapshot/{id} only
// returns a small rolling window of recent events (~35-40), which can
// silently drop earlier real events — including goals — between polls,
// so "pick the latest event in the snapshot" is not reliable on its own.
async function apiSSE(path) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!jwt) await renewJwt();
    const r = await fetch(`${BASE}${path}`, {
      headers: { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken },
    });
    if (r.status === 401 || r.status === 403) { jwt = ""; continue; }
    if (!r.ok) throw new Error(`TxLINE ${path} -> ${r.status}`);
    const text = await r.text();
    const events = [];
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      try { events.push(JSON.parse(payload)); } catch { /* skip malformed lines */ }
    }
    return events;
  }
  throw new Error(`TxLINE auth failed for ${path}`);
}

// --- baseline ----------------------------------------------------------------
let baselineCache = null; // { lambdas, fittedFrom, at }

function fitFromConsensus(cons, fallback) {
  const b = cons && cons.oneXTwo && cons.totals && cons.totals["2.5"]
    ? { pHome: cons.oneXTwo.home, pDraw: cons.oneXTwo.draw, pAway: cons.oneXTwo.away, pOver25: cons.totals["2.5"].over }
    : fallback;
  const lambdas = fitLambdas(b.pHome, b.pAway, b.pOver25, 2.5, b.pDraw);
  return { lambdas, fittedFrom: b };
}

function baselineFor(phase, prematchConsensus) {
  const fresh = baselineCache && Date.now() - baselineCache.at < 5 * 60 * 1000;
  if (phase === "NS" && prematchConsensus && !fresh) {
    baselineCache = { ...fitFromConsensus(prematchConsensus, FROZEN_BASELINE), at: Date.now() };
  } else if (!baselineCache) {
    baselineCache = { ...fitFromConsensus(null, FROZEN_BASELINE), at: Date.now() };
  }
  return baselineCache;
}

// --- live tick ---------------------------------------------------------------
export async function liveTick() {
  const [scores, odds] = await Promise.all([
    apiSSE(`/scores/updates/${LIVE_FIXTURE_ID}`),
    // asOf pins the snapshot window to "now" — without it the endpoint only
    // covers the current publication batch and is often empty between batches
    api(`/odds/snapshot/${LIVE_FIXTURE_ID}?asOf=${Date.now()}`),
  ]);
  const events = Array.isArray(scores) ? scores : [];
  // The full history is scanned and merged per-field (phase/clock from the
  // latest state-carrying event, Score independently from the latest event
  // that actually carries it, preferring a finalisation record) rather than
  // picking one "latest" event for everything — see mergeScoreEvents' own
  // doc comment for why that single-event approach silently dropped a real,
  // standing goal during today's live final.
  const merged = mergeScoreEvents(events);
  const state = merged ? scoreToState(merged) : {
    fixtureId: LIVE_FIXTURE_ID, phase: "NS", clockSeconds: 0, clockRunning: false,
    goalsHome: 0, goalsAway: 0, redsHome: 0, redsAway: 0, yellowsHome: 0, yellowsAway: 0,
  };
  state.participant1 = process.env.TXLINE_PARTICIPANT1 || "Spain";
  state.participant2 = process.env.TXLINE_PARTICIPANT2 || "Argentina";

  const consensus = oddsToConsensus(Array.isArray(odds) ? odds : []);
  const baseline = baselineFor(state.phase, consensus);

  const model = priceState({
    lambdaHome: baseline.lambdas.lambdaHome,
    lambdaAway: baseline.lambdas.lambdaAway,
    rho: baseline.lambdas.rho || 0,
    u: normalizedTime(state.phase, state.clockSeconds),
    goalsHome: state.goalsHome, goalsAway: state.goalsAway,
    redsHome: state.redsHome, redsAway: state.redsAway,
    totalsLines: [1.5, 2.5, 3.5],
  });

  const envelope = buildEnvelope({ mode: "live", nowMs: Date.now(), ft: undefined, state, model, consensus });
  envelope.baseline = { fittedFrom: baseline.fittedFrom, lambdas: baseline.lambdas };
  envelope.matchEvents = events
    .filter((e) => ["goal", "card"].includes(e.Action))
    .map((e) => ({ action: e.Action, seq: e.Seq, data: e.Data }));
  return envelope;
}

// --- live edge history -------------------------------------------------------
// Rebuilt from TxLINE's own odds history. Score-state history comes from the
// scores event list; between events the official clock is interpolated from
// event timestamps. History is capped to keep the endpoint snappy.
export async function liveEdgeSeries(stepMs = 60_000, maxPoints = 400, sinceMs = 0) {
  const [oddsHistory, scores] = await Promise.all([
    api(`/odds/updates/${LIVE_FIXTURE_ID}`),
    apiSSE(`/scores/updates/${LIVE_FIXTURE_ID}`),
  ]);
  // Walk the full ordered history carrying forward StatusId/Clock and
  // Score independently (same reasoning as mergeScoreEvents: a "comment"
  // event has neither, a "shot" event has Clock but no Score, only
  // specific notable events carry Score) so every sampled point reflects
  // true cumulative state rather than whatever one raw event happened to
  // include — otherwise the chart/CSV can show a goal disappearing at
  // timestamps between the goal event and the next Score-carrying one.
  let carryState = null;
  let carryScore = null;
  let carryFinalised = null;
  const events = [];
  for (const e of (Array.isArray(scores) ? scores : []).slice().sort((a, b) => (a.Ts ?? a.ts ?? 0) - (b.Ts ?? b.ts ?? 0))) {
    if (hasScoreState(e)) carryState = e;
    if ((e.Score ?? e.score) != null) carryScore = e;
    const action = String(e.Action ?? e.action ?? "").toLowerCase();
    const statusId = e.StatusId ?? e.statusId;
    const period = e.Period ?? e.period;
    if (action === "game_finalised" || (statusId === 100 && period === 100)) carryFinalised = e;
    if (!carryState && !carryScore) continue;
    const scoreSource = carryFinalised || carryScore;
    const merged = { ...(carryState || {}), Score: scoreSource ? (scoreSource.Score ?? scoreSource.score) : undefined };
    events.push({ ts: e.Ts ?? e.ts, state: scoreToState(merged) });
  }

  const fullMatch = (Array.isArray(oddsHistory) ? oddsHistory : [])
    .filter((o) => !o.MarketPeriod && ["1X2_PARTICIPANT_RESULT", "OVERUNDER_PARTICIPANT_GOALS"].includes(o.SuperOddsType))
    .sort((a, b) => a.Ts - b.Ts);
  if (!fullMatch.length) return [];
  // A windowed request (sinceMs > 0) narrows the series to recent action —
  // without it, days of pre-match drift compress the in-play story into the
  // last pixels of a chart. Consensus state still warms up from the full
  // history below, so the first windowed point is correct.

  const t0 = fullMatch[0].Ts;
  const t1 = fullMatch[fullMatch.length - 1].Ts;
  const emitStart = Math.max(t0, sinceMs || 0);
  const step = Math.max(stepMs, Math.ceil((t1 - emitStart) / maxPoints));

  const baseline = baselineFor("done", null); // frozen baseline for history
  const out = [];
  let oddsIdx = 0;
  const latestPerMarket = new Map();
  // warm up consensus state across the pre-window history
  while (oddsIdx < fullMatch.length && fullMatch[oddsIdx].Ts < emitStart) {
    const o = fullMatch[oddsIdx++];
    latestPerMarket.set(o.SuperOddsType + "|" + (o.MarketParameters || ""), o);
  }
  for (let ts = emitStart; ts <= t1; ts += step) {
    while (oddsIdx < fullMatch.length && fullMatch[oddsIdx].Ts <= ts) {
      const o = fullMatch[oddsIdx++];
      latestPerMarket.set(o.SuperOddsType + "|" + (o.MarketParameters || ""), o);
    }
    const consensus = oddsToConsensus([...latestPerMarket.values()]);
    if (!consensus.oneXTwo) continue;
    // state as of ts
    let state = null;
    for (const e of events) { if (e.ts <= ts) state = e.state; else break; }
    if (!state) state = { phase: "NS", clockSeconds: 0, goalsHome: 0, goalsAway: 0, redsHome: 0, redsAway: 0 };
    const model = priceState({
      lambdaHome: baseline.lambdas.lambdaHome, lambdaAway: baseline.lambdas.lambdaAway,
      rho: baseline.lambdas.rho || 0,
      u: normalizedTime(state.phase, state.clockSeconds),
      goalsHome: state.goalsHome, goalsAway: state.goalsAway,
      redsHome: state.redsHome, redsAway: state.redsAway,
      totalsLines: [2.5],
    });
    const edge = edgeBetween(model, consensus);
    out.push({
      ts,
      phase: state.phase,
      score: `${state.goalsHome}-${state.goalsAway}`,
      reds: [state.redsHome || 0, state.redsAway || 0],
      model1x2: [model.oneXTwo.home, model.oneXTwo.draw, model.oneXTwo.away].map((x) => Math.round(x * 10000) / 10000),
      consensus1x2: [consensus.oneXTwo.home, consensus.oneXTwo.draw, consensus.oneXTwo.away].map((x) => Math.round(x * 10000) / 10000),
      edgePp1x2: edge.oneXTwo ? [edge.oneXTwo.home.edgePp, edge.oneXTwo.draw.edgePp, edge.oneXTwo.away.edgePp] : null,
    });
  }
  return out;
}

export { isTerminal };
