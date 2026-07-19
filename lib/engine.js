// Replay engine: deterministic clock → match state → model + consensus + edge.
//
// Replay state is a pure function of wall-clock time: every serverless
// invocation, every client, and every reconnect computes the same tick for the
// same instant. That is what makes the published feed continuous and
// intervention-free without a long-lived process (see docs/architecture.md).

import fs from "fs";
import { priceState } from "./model.js";
import { normalizedTime, oddsToConsensus, scoreToState, probToPrice, isTerminal } from "./txline.js";

const fixture = JSON.parse(
  fs.readFileSync(new URL("../fixtures/replay-fixture.json", import.meta.url), "utf8")
);

export const meta = fixture.meta;

/** Fixture-seconds elapsed at wall-clock nowMs (loops over the fixture). */
export function fixtureTime(nowMs) {
  const { anchorEpochMs, speed, durationSec } = fixture.meta;
  const elapsed = Math.max(0, nowMs - anchorEpochMs) * speed / 1000;
  return elapsed % durationSec;
}

/** Which loop iteration we are on (for display: "replay #N"). */
export function loopCount(nowMs) {
  const { anchorEpochMs, speed, durationSec } = fixture.meta;
  const elapsed = Math.max(0, nowMs - anchorEpochMs) * speed / 1000;
  return Math.floor(elapsed / durationSec);
}

function lastAt(arr, ft) {
  // binary search: last element with t <= ft
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].t <= ft) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** Match state at fixture time ft, from the TxLINE-shaped score events. */
export function stateAt(ft) {
  const idx = lastAt(fixture.scoreEvents, ft);
  const payload = fixture.scoreEvents[Math.max(0, idx)].payload;
  const state = scoreToState(payload);
  // The stored events only capture state changes; the clock advances between
  // them. Recompute clock from segment boundaries.
  const { kickoffSec, segments } = fixture.meta;
  if (ft < kickoffSec) { state.phase = "NS"; state.clockSeconds = 0; }
  else if (ft < segments.HT_START) { state.phase = "H1"; state.clockSeconds = ft - kickoffSec; }
  else if (ft < segments.H2_START) { state.phase = "HT"; state.clockSeconds = segments.H1_LEN; }
  else if (ft < segments.FULLTIME) { state.phase = "H2"; state.clockSeconds = 45 * 60 + (ft - segments.H2_START); }
  else { state.phase = "END"; state.clockSeconds = 45 * 60 + segments.H2_LEN; }
  state.clockRunning = state.phase === "H1" || state.phase === "H2";
  return state;
}

/** Consensus (from the fixture's odds ticks) as of fixture time ft. */
export function consensusAt(ft) {
  // collect the latest tick per market at or before ft
  const latest = new Map();
  for (const tick of fixture.oddsTicks) {
    if (tick.t > ft) break;
    const key = tick.payload.SuperOddsType + "|" + (tick.payload.MarketParameters || "");
    latest.set(key, tick.payload);
  }
  return oddsToConsensus([...latest.values()]);
}

/** Model prices for a match state, using the fixture's calibrated baseline. */
export function modelFor(state) {
  const { fairLambdas } = fixture.meta.baseline;
  return priceState({
    lambdaHome: fairLambdas.lambdaHome,
    lambdaAway: fairLambdas.lambdaAway,
    rho: fairLambdas.rho || 0,
    u: normalizedTime(state.phase, state.clockSeconds),
    goalsHome: state.goalsHome, goalsAway: state.goalsAway,
    redsHome: state.redsHome, redsAway: state.redsAway,
    totalsLines: fixture.meta.totalsLines,
  });
}

export function edgeBetween(model, consensus) {
  const edge = { oneXTwo: null, totals: {} };
  if (consensus.oneXTwo) {
    edge.oneXTwo = {};
    for (const k of ["home", "draw", "away"]) {
      const pm = model.oneXTwo[k];
      const pc = consensus.oneXTwo[k];
      edge.oneXTwo[k] = {
        model: round4(pm),
        consensus: round4(pc),
        edgePp: round4((pm - pc) * 100),
        // EV of backing this outcome at the consensus (de-margined) price
        ev: round4(pm / pc - 1),
      };
    }
  }
  for (const [line, cons] of Object.entries(consensus.totals || {})) {
    const m = model.totals[line];
    if (!m) continue;
    edge.totals[line] = {
      over: { model: round4(m.over), consensus: round4(cons.over), edgePp: round4((m.over - cons.over) * 100), ev: round4(m.over / cons.over - 1) },
    };
  }
  return edge;
}

const round4 = (x) => Math.round(x * 10000) / 10000;

function fmtClock(state) {
  if (state.phase === "NS") return "0:00";
  const m = Math.floor(state.clockSeconds / 60), s = Math.floor(state.clockSeconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** One full published tick (unsigned envelope) at wall-clock nowMs. */
export function replayTick(nowMs) {
  const ft = fixtureTime(nowMs);
  const state = stateAt(ft);
  const model = modelFor(state);
  const consensus = consensusAt(ft);
  return buildEnvelope({ mode: "replay", nowMs, ft, state, model, consensus });
}

export function buildEnvelope({ mode, nowMs, ft, state, model, consensus }) {
  return {
    v: 1,
    producer: "fairline",
    mode,
    dataSource: mode === "replay"
      ? { kind: "synthetic-fixture", label: meta.label, fixtureId: meta.fixtureId, loop: loopCount(nowMs) }
      : { kind: "txline-mainnet", fixtureId: state.fixtureId, delayNote: "free-tier StablePrice, 60s batch delay" },
    publishedAt: nowMs,
    fixtureTimeSec: ft === undefined ? null : Math.round(ft * 10) / 10,
    match: {
      participant1: mode === "replay" ? meta.participant1 : state.participant1,
      participant2: mode === "replay" ? meta.participant2 : state.participant2,
      phase: state.phase,
      clock: fmtClock(state),
      score: { home: state.goalsHome, away: state.goalsAway },
      redCards: { home: state.redsHome, away: state.redsAway },
      yellowCards: { home: state.yellowsHome, away: state.yellowsAway },
    },
    model: {
      name: "in-play Poisson, time-decay intensity, card-adjusted",
      remaining: { lambdaHome: round4(model.remaining.lambdaHome), lambdaAway: round4(model.remaining.lambdaAway) },
      oneXTwo: {
        probs: { home: round4(model.oneXTwo.home), draw: round4(model.oneXTwo.draw), away: round4(model.oneXTwo.away) },
        fairPrices: { home: probToPrice(model.oneXTwo.home), draw: probToPrice(model.oneXTwo.draw), away: probToPrice(model.oneXTwo.away) },
      },
      totals: Object.fromEntries(Object.entries(model.totals).map(([L, t]) => [L, { over: round4(t.over), under: round4(t.under), fairPriceOver: probToPrice(t.over) }])),
    },
    consensus: {
      source: "TXLineStablePriceDemargined",
      oneXTwo: consensus.oneXTwo ? { home: round4(consensus.oneXTwo.home), draw: round4(consensus.oneXTwo.draw), away: round4(consensus.oneXTwo.away) } : null,
      totals: Object.fromEntries(Object.entries(consensus.totals || {}).map(([L, t]) => [L, { over: round4(t.over), under: round4(t.under) }])),
    },
    edge: edgeBetween(model, consensusOrEmpty(consensus)),
    terminal: isTerminal(state.phase),
  };
}

const consensusOrEmpty = (c) => c || { oneXTwo: null, totals: {} };

/**
 * Deterministic edge history for the replay fixture from kickoff up to
 * fixture time toFt. This is the "persisted" edge log: because the replay is
 * a pure function of time, the log is recomputable exactly — the storage seam
 * for a live deployment is documented in docs/architecture.md.
 */
export function edgeSeries(toFt, stepSec = 30) {
  const out = [];
  const start = 0;
  const end = Math.min(toFt, fixture.meta.durationSec);
  for (let ft = start; ft <= end; ft += stepSec) {
    const state = stateAt(ft);
    const model = modelFor(state);
    const consensus = consensusAt(ft);
    const edge = edgeBetween(model, consensusOrEmpty(consensus));
    out.push({
      fixtureTimeSec: ft,
      phase: state.phase,
      clock: fmtClock(state),
      score: `${state.goalsHome}-${state.goalsAway}`,
      reds: [state.redsHome, state.redsAway],
      model1x2: [round4(model.oneXTwo.home), round4(model.oneXTwo.draw), round4(model.oneXTwo.away)],
      consensus1x2: consensus.oneXTwo ? [round4(consensus.oneXTwo.home), round4(consensus.oneXTwo.draw), round4(consensus.oneXTwo.away)] : null,
      edgePp1x2: edge.oneXTwo ? [edge.oneXTwo.home.edgePp, edge.oneXTwo.draw.edgePp, edge.oneXTwo.away.edgePp] : null,
    });
  }
  return out;
}
