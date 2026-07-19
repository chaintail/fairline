// Generates the committed synthetic replay fixture (fixtures/replay-fixture.json).
//
// The fixture is honest about what it is: a deterministic, seeded simulation of
// a TxLINE-shaped match feed — score events shaped like TxLINE Scores payloads
// and a consensus odds path shaped like TxLINE StablePrice (de-margined)
// payloads. The consensus path is produced by a *market simulator*: the same
// Poisson family as the FairLine model but with slightly different parameters,
// a reaction lag after events, and small seeded noise. Edge measured against it
// demonstrates the engine's mechanics, not real-world alpha (see docs/model.md).
//
// Run: npm run generate:fixture  (output is committed; identical on every run)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { priceState, fitLambdas } from "../lib/model.js";
import { normalizedTime, probToPrice } from "../lib/txline.js";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "replay-fixture.json");

// --- deterministic PRNG -----------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260719);
const gauss = () => {
  // Box-Muller
  const u1 = Math.max(rand(), 1e-9), u2 = rand();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
};

// --- fixture constants ------------------------------------------------------
const FIXTURE_ID = 90000001;
const HOME = "Azuria";
const AWAY = "Ferrona";

// Pre-match consensus baseline (deliberately close to a realistic World Cup
// final board: home slight favorite, total around 2.3 goals).
const PRE = { pHome: 0.42, pDraw: 0.317, pAway: 0.263, pOver25: 0.40 };
// pDraw participates in the fit via the Dixon-Coles rho (see lib/model.js).

// Segments in fixture-seconds. One "fixture second" replays as 1/SPEED real
// seconds. Timeline: pre-match lobby, H1 45+2, half-time break, H2 45+4.
const PREMATCH = 180;
const H1_LEN = 47 * 60;
const HT_LEN = 300;
const H2_LEN = 49 * 60;
const KICKOFF = PREMATCH;
const HT_START = KICKOFF + H1_LEN;
const H2_START = HT_START + HT_LEN;
const FULLTIME = H2_START + H2_LEN;
const DURATION = FULLTIME + 60; // linger on the final whistle before looping

// Match script. clockMin = official match minute; t = fixture-seconds.
// H2 official clock resumes at 45:00 regardless of H1 stoppage.
const clockToT = (min) =>
  min <= 47 ? KICKOFF + min * 60 : H2_START + (min - 45) * 60;

const EVENTS = [
  { min: 12, type: "yellow", side: 2 },
  { min: 23, type: "goal", side: 1 },
  { min: 34, type: "corner", side: 1 },
  { min: 38, type: "yellow", side: 1 },
  { min: 52, type: "goal", side: 2 },
  { min: 61, type: "yellow", side: 2 },
  { min: 66, type: "corner", side: 2 },
  { min: 71, type: "goal", side: 1 },
  { min: 78, type: "red", side: 2 },
  { min: 87, type: "goal", side: 1 },
].map((e) => ({ ...e, t: clockToT(e.min) }));

// --- calibrate model + market baselines ------------------------------------
const fair = fitLambdas(PRE.pHome, PRE.pAway, PRE.pOver25, 2.5, PRE.pDraw);
// The simulated market prices with slightly different parameters than the
// model (overrates the favorite, underrates totals a touch).
const market = {
  lambdaHome: fair.lambdaHome * 1.045,
  lambdaAway: fair.lambdaAway * 0.965,
  rho: (fair.rho || 0) * 0.8,
};

console.log("fair lambdas", fair, "market lambdas", market);

// --- walk the timeline ------------------------------------------------------
const TOTALS_LINES = [1.5, 2.5, 3.5];

function phaseAt(t) {
  if (t < KICKOFF) return "NS";
  if (t < HT_START) return "H1";
  if (t < H2_START) return "HT";
  if (t < FULLTIME) return "H2";
  return "END";
}
function clockSecondsAt(t) {
  if (t < KICKOFF) return 0;
  if (t < HT_START) return t - KICKOFF;
  if (t < H2_START) return H1_LEN;
  if (t < FULLTIME) return 45 * 60 + (t - H2_START);
  return 45 * 60 + H2_LEN;
}
function stateAt(t) {
  const s = { goalsHome: 0, goalsAway: 0, redsHome: 0, redsAway: 0, yellowsHome: 0, yellowsAway: 0, cornersHome: 0, cornersAway: 0 };
  for (const e of EVENTS) {
    if (e.t > t) break;
    if (e.type === "goal") e.side === 1 ? s.goalsHome++ : s.goalsAway++;
    if (e.type === "red") e.side === 1 ? s.redsHome++ : s.redsAway++;
    if (e.type === "yellow") e.side === 1 ? s.yellowsHome++ : s.yellowsAway++;
    if (e.type === "corner") e.side === 1 ? s.cornersHome++ : s.cornersAway++;
  }
  return s;
}

// TxLINE-shaped score payload for a moment in fixture time.
let seq = 0;
function scorePayload(t, action, data) {
  const s = stateAt(t);
  const sideScore = (goals, yellows, reds, corners) => ({
    Total: { Goals: goals, YellowCards: yellows, RedCards: reds, Corners: corners },
  });
  return {
    t,
    payload: {
      FixtureId: FIXTURE_ID,
      GameState: phaseAt(t) === "NS" ? "scheduled" : phaseAt(t) === "END" ? "finished" : "playing",
      StatusSoccerId: phaseAt(t),
      IsTeam: true,
      Participant1IsHome: true,
      Clock: { running: phaseAt(t) === "H1" || phaseAt(t) === "H2", seconds: clockSecondsAt(t) },
      Score: {
        Participant1: sideScore(s.goalsHome, s.yellowsHome, s.redsHome, s.cornersHome),
        Participant2: sideScore(s.goalsAway, s.yellowsAway, s.redsAway, s.cornersAway),
      },
      Action: action,
      Data: data,
      Seq: seq++,
    },
  };
}

const scoreEvents = [];
scoreEvents.push(scorePayload(0, "coverage_update", {}));
scoreEvents.push(scorePayload(KICKOFF, "status_change", { Type: "kickoff" }));
for (const e of EVENTS) {
  const minutes = e.min;
  if (e.type === "goal") scoreEvents.push(scorePayload(e.t, "goal", { Action: "goal", Goal: true, Participant: e.side, Minutes: minutes, GoalType: "Regular" }));
  if (e.type === "yellow") scoreEvents.push(scorePayload(e.t, "card", { Action: "card", YellowCard: true, Participant: e.side, Minutes: minutes, Color: "yellow" }));
  if (e.type === "red") scoreEvents.push(scorePayload(e.t, "card", { Action: "card", RedCard: true, Participant: e.side, Minutes: minutes, Color: "red" }));
  if (e.type === "corner") scoreEvents.push(scorePayload(e.t, "corner", { Action: "corner", Corner: true, Participant: e.side, Minutes: minutes }));
}
scoreEvents.push(scorePayload(HT_START, "status_change", { Type: "halftime" }));
scoreEvents.push(scorePayload(H2_START, "status_change", { Type: "second_half" }));
scoreEvents.push(scorePayload(FULLTIME, "status_change", { Type: "fulltime" }));
scoreEvents.sort((a, b) => a.t - b.t);

// --- consensus odds path ----------------------------------------------------
// Market simulator: converges toward its own fair value with a reaction lag
// after state changes, plus small OU noise, all seeded.
const TICK = 20;         // fixture-seconds between odds ticks
const TAU = 45;          // reaction lag (fixture-seconds)
const NOISE = 0.0035;    // per-tick prob noise scale

function marketTarget(t) {
  const s = stateAt(t);
  const priced = priceState({
    lambdaHome: market.lambdaHome, lambdaAway: market.lambdaAway,
    rho: market.rho,
    u: normalizedTime(phaseAt(t), clockSecondsAt(t)),
    goalsHome: s.goalsHome, goalsAway: s.goalsAway,
    redsHome: s.redsHome, redsAway: s.redsAway,
    totalsLines: TOTALS_LINES,
  });
  return { priced, total: s.goalsHome + s.goalsAway };
}

let current = null;
const oddsTicks = [];
let msgN = 0;
for (let t = 0; t <= DURATION - 60; t += TICK) {
  const { priced, total } = marketTarget(t);
  const target = {
    oneXTwo: [priced.oneXTwo.home, priced.oneXTwo.draw, priced.oneXTwo.away],
    totals: Object.fromEntries(TOTALS_LINES.map((L) => [L, [priced.totals[L].over, priced.totals[L].under]])),
  };
  if (!current) current = JSON.parse(JSON.stringify(target));
  const alpha = 1 - Math.exp(-TICK / TAU);
  const step = (cur, tgt) => {
    const noisy = cur.map((c, i) => {
      let v = c + (tgt[i] - c) * alpha + gauss() * NOISE;
      return Math.min(0.995, Math.max(0.005, v));
    });
    const sum = noisy.reduce((a, b) => a + b, 0);
    return noisy.map((v) => v / sum);
  };
  current.oneXTwo = step(current.oneXTwo, target.oneXTwo);
  for (const L of TOTALS_LINES) current.totals[L] = step(current.totals[L], target.totals[L]);

  const mk = (superType, names, probs, params) => ({
    t,
    payload: {
      FixtureId: FIXTURE_ID,
      MessageId: `synthetic:${String(msgN++).padStart(6, "0")}-10021-stab`,
      Ts: t * 1000,
      Bookmaker: "TXLineStablePriceDemargined",
      BookmakerId: 10021,
      SuperOddsType: superType,
      GameState: phaseAt(t) === "NS" ? null : "playing",
      InRunning: t >= KICKOFF,
      MarketParameters: params || null,
      MarketPeriod: null,
      PriceNames: names,
      Prices: probs.map(probToPrice),
      Pct: probs.map((p) => (p * 100).toFixed(3)),
    },
  });
  oddsTicks.push(mk("1X2_PARTICIPANT_RESULT", ["part1", "draw", "part2"], current.oneXTwo));
  for (const L of TOTALS_LINES) {
    if (total > L) continue; // settled line: market pulls it, like real books
    oddsTicks.push(mk("OVERUNDER_PARTICIPANT_GOALS", ["over", "under"], current.totals[L], `line=${L}`));
  }
}

// --- write ------------------------------------------------------------------
const fixture = {
  meta: {
    label: "SYNTHETIC FIXTURE — deterministic replay",
    note: "Seeded simulation of a TxLINE-shaped feed (StablePrice de-margined consensus + soccer scores). Not real match data. Generated by scripts/generate-fixture.mjs; identical on every run.",
    seed: 20260719,
    fixtureId: FIXTURE_ID,
    competition: "Exhibition Final (synthetic)",
    participant1: HOME,
    participant2: AWAY,
    participant1IsHome: true,
    speed: 12,
    anchorEpochMs: 1784400000000,
    durationSec: DURATION,
    kickoffSec: KICKOFF,
    segments: { PREMATCH, H1_LEN, HT_LEN, H2_LEN, HT_START, H2_START, FULLTIME },
    totalsLines: TOTALS_LINES,
    baseline: { consensus: PRE, fairLambdas: fair, marketLambdas: market },
  },
  scoreEvents,
  oddsTicks,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(fixture));
console.log("wrote", OUT, "scoreEvents:", scoreEvents.length, "oddsTicks:", oddsTicks.length, "duration:", DURATION, "s @ speed", fixture.meta.speed);
