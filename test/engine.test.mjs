import { test } from "node:test";
import assert from "node:assert/strict";
import { fixtureTime, stateAt, consensusAt, replayTick, edgeSeries, meta } from "../lib/engine.js";
import { signEnvelope, verifyEnvelope, canonicalize } from "../lib/sign.js";
import { scoreToState, oddsToConsensus, normalizedTime } from "../lib/txline.js";
import crypto from "crypto";

test("replay is deterministic: same instant, same tick", () => {
  const t = meta.anchorEpochMs + 123456789;
  const a = replayTick(t);
  const b = replayTick(t);
  assert.deepEqual(a, b);
});

test("fixture time loops over the duration", () => {
  const t0 = meta.anchorEpochMs;
  const oneLoopMs = (meta.durationSec / meta.speed) * 1000;
  assert.ok(Math.abs(fixtureTime(t0 + oneLoopMs) - fixtureTime(t0)) < 0.05);
});

test("score state follows the script (goal at 23' -> 1-0)", () => {
  const before = stateAt(meta.kickoffSec + 22 * 60);
  const after = stateAt(meta.kickoffSec + 24 * 60);
  assert.equal(before.goalsHome, 0);
  assert.equal(after.goalsHome, 1);
  assert.equal(after.goalsAway, 0);
});

test("consensus exists and is a probability simplex", () => {
  const c = consensusAt(meta.kickoffSec + 10 * 60);
  assert.ok(c.oneXTwo);
  const sum = c.oneXTwo.home + c.oneXTwo.draw + c.oneXTwo.away;
  assert.ok(Math.abs(sum - 1) < 0.02, `sum=${sum}`);
});

test("model reprices a goal faster than the lagged consensus", () => {
  // 30 fixture-seconds after the 23' goal the model has fully repriced but
  // the simulated market (tau=45s) is still converging -> home edge positive.
  const ftGoal = meta.kickoffSec + 23 * 60;
  const tick = replayTick(meta.anchorEpochMs + ((ftGoal + 30) / meta.speed) * 1000);
  assert.equal(tick.match.score.home, 1);
  assert.ok(tick.edge.oneXTwo.home.edgePp > 0.5, `home edge after goal: ${tick.edge.oneXTwo.home.edgePp}pp`);
});

test("edge series covers kickoff to now and is bounded", () => {
  const rows = edgeSeries(meta.segments.FULLTIME, 60);
  assert.ok(rows.length > 80);
  for (const r of rows) {
    if (!r.edgePp1x2) continue;
    for (const e of r.edgePp1x2) assert.ok(Math.abs(e) < 40, `edge sane: ${e}`);
  }
});

test("settled totals lines carry no consensus or edge", () => {
  // at 2-1 (3 goals), lines 1.5 and 2.5 are settled: model may price them
  // (certainty) but consensus/edge must be absent
  const ftAfterThird = meta.segments.H2_START + 27 * 60; // 72' — score 2-1
  const tick = replayTick(meta.anchorEpochMs + (ftAfterThird / meta.speed) * 1000);
  assert.equal(tick.match.score.home + tick.match.score.away, 3);
  assert.ok(!("1.5" in tick.consensus.totals), "no consensus on settled 1.5");
  assert.ok(!("1.5" in tick.edge.totals), "no edge on settled 1.5");
  assert.ok(!("2.5" in tick.edge.totals), "no edge on settled 2.5");
  assert.ok("3.5" in tick.edge.totals, "live 3.5 line still has edge");
});

test("envelope signing round-trips and tamper is detected", () => {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  process.env.FAIRLINE_SIGNING_KEY = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  const tick = replayTick(meta.anchorEpochMs + 1000_000);
  const signed = signEnvelope(tick);
  assert.ok(signed.signature?.value, "envelope is signed");
  assert.equal(verifyEnvelope(signed).valid, true);
  const tampered = JSON.parse(JSON.stringify(signed));
  tampered.model.oneXTwo.probs.home += 0.01;
  assert.equal(verifyEnvelope(tampered).valid, false, "tampered envelope fails");
});

test("canonicalization is key-order independent", () => {
  assert.equal(canonicalize({ b: 1, a: [{ d: 2, c: 3 }] }), canonicalize({ a: [{ c: 3, d: 2 }], b: 1 }));
});

test("txline score payload reduction (real StatusId shape, both clock spellings)", () => {
  // Real TxLINE snapshot shape (verified against the 2026 World Cup Final
  // feed, fixture 18257739): StatusId is numeric, not a phase string, and
  // Clock's own keys are PascalCase (Running/Seconds).
  const pascal = { FixtureId: 1, StatusId: 4, Clock: { Running: true, Seconds: 3000 }, Score: { Participant1: { Total: { Goals: 2, RedCards: 0, YellowCards: 1, Corners: 3 } }, Participant2: { Total: { Goals: 1, RedCards: 1, YellowCards: 2, Corners: 1 } } } };
  const s = scoreToState(pascal);
  assert.equal(s.goalsHome, 2);
  assert.equal(s.redsAway, 1);
  // StatusId 4 = second half (confirmed against the real fixture's actual
  // second-half kickoff event).
  assert.equal(s.phase, "H2");
  assert.ok(normalizedTime(s.phase, s.clockSeconds) > 0.5);

  const camel = { fixtureId: 1, statusId: 2, clock: { running: true, seconds: 1200 }, score: { participant1: { total: { goals: 0, redCards: 0 } }, participant2: { total: { goals: 0, redCards: 0 } } } };
  const c = scoreToState(camel);
  assert.equal(c.phase, "H1", "StatusId 2 = first half");
  assert.equal(c.clockRunning, true);

  const halftime = { FixtureId: 1, StatusId: 3, Clock: null, Score: {} };
  assert.equal(scoreToState(halftime).phase, "HT");

  const notStarted = { FixtureId: 1, StatusId: 1, GameState: "scheduled", Clock: { Running: false, Seconds: 0 } };
  assert.equal(scoreToState(notStarted).phase, "NS");
});

test("odds reduction: period markets excluded, NA prices de-margined", () => {
  const c = oddsToConsensus([
    { SuperOddsType: "1X2_PARTICIPANT_RESULT", Ts: 2, PriceNames: ["part1", "draw", "part2"], Prices: [2376, 3165, 3801], Pct: ["42.088", "31.596", "26.309"] },
    { SuperOddsType: "1X2_PARTICIPANT_RESULT", Ts: 3, MarketPeriod: "half=1", PriceNames: ["part1", "draw", "part2"], Prices: [3000, 2000, 5000], Pct: ["NA", "NA", "NA"] },
    { SuperOddsType: "OVERUNDER_PARTICIPANT_GOALS", Ts: 2, MarketParameters: "line=2.25", PriceNames: ["over", "under"], Prices: [2137, 1879], Pct: ["NA", "NA"] },
  ]);
  assert.ok(Math.abs(c.oneXTwo.home - 0.42088) < 1e-6, "uses published Pct, ignores half market");
  const ou = c.totals["2.25"];
  assert.ok(Math.abs(ou.over + ou.under - 1) < 1e-9, "NA line de-margined proportionally");
});
