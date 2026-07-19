import { test } from "node:test";
import assert from "node:assert/strict";
import { poissonPmf, poissonDist, remainingWeight, priceState, fitLambdas, cardMultipliers } from "../lib/model.js";

test("poisson pmf sums to ~1 and matches known values", () => {
  const d = poissonDist(1.5);
  const sum = d.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, "distribution sums to 1 (with tail bucket)");
  assert.ok(Math.abs(poissonPmf(1.5, 0) - Math.exp(-1.5)) < 1e-12);
  assert.ok(Math.abs(poissonPmf(2, 2) - (Math.exp(-2) * 4 / 2)) < 1e-12);
});

test("remainingWeight is 1 at kickoff, 0 at full time, monotone decreasing", () => {
  assert.equal(remainingWeight(0), 1);
  assert.ok(remainingWeight(1) < 1e-12);
  let prev = 1.0001;
  for (let u = 0; u <= 1; u += 0.05) {
    const w = remainingWeight(u);
    assert.ok(w < prev, `monotone at u=${u}`);
    prev = w;
  }
});

test("late-game goals are worth more: less time remains than linear", () => {
  // with a rising intensity profile, at u=0.5 less than half the expected
  // goals should remain? No — MORE goals come late, so at u=0.5 remaining
  // weight must be >= (1-u) is false; it should be > 0.5 * something...
  // Correct property: remainingWeight(0.5) < 0.5 would mean most goals come
  // early. With RAMP>0 most goals come late: remainingWeight(0.5) > 0.5...
  const w = remainingWeight(0.5);
  assert.ok(w > 0.5, `rising intensity: more than half the goals come after half-time (w=${w})`);
});

test("probabilities respond to state the right way", () => {
  const base = { lambdaHome: 1.3, lambdaAway: 1.0, u: 0.5, goalsHome: 0, goalsAway: 0, redsHome: 0, redsAway: 0, totalsLines: [2.5] };
  const level = priceState(base);
  const homeUp = priceState({ ...base, goalsHome: 1 });
  assert.ok(homeUp.oneXTwo.home > level.oneXTwo.home + 0.15, "a goal jumps the scorer's win prob");
  const lateLevel = priceState({ ...base, u: 0.9 });
  assert.ok(lateLevel.oneXTwo.draw > level.oneXTwo.draw, "draw prob rises late at level score");
  const redAway = priceState({ ...base, redsAway: 1 });
  assert.ok(redAway.oneXTwo.home > level.oneXTwo.home, "opponent red card helps home");
  const sum = level.oneXTwo.home + level.oneXTwo.draw + level.oneXTwo.away;
  assert.ok(Math.abs(sum - 1) < 1e-9, "1X2 sums to 1");
});

test("totals: over prob falls as time passes at constant score", () => {
  const base = { lambdaHome: 1.3, lambdaAway: 1.0, goalsHome: 0, goalsAway: 0, redsHome: 0, redsAway: 0, totalsLines: [2.5] };
  const early = priceState({ ...base, u: 0.1 });
  const late = priceState({ ...base, u: 0.8 });
  assert.ok(late.totals[2.5].over < early.totals[2.5].over);
});

test("settled total line prices to certainty", () => {
  const s = priceState({ lambdaHome: 1.3, lambdaAway: 1.0, u: 0.9, goalsHome: 2, goalsAway: 1, redsHome: 0, redsAway: 0, totalsLines: [2.5] });
  assert.ok(Math.abs(s.totals[2.5].over - 1) < 1e-9, "3 goals scored: over 2.5 is settled");
});

test("card multipliers compose", () => {
  assert.equal(cardMultipliers(0, 0), 1);
  assert.ok(cardMultipliers(1, 0) < 1);
  assert.ok(cardMultipliers(0, 1) > 1);
});

test("Dixon-Coles fit hits all four pre-match targets", () => {
  // real pre-match board shape: independent Poisson alone underprices the
  // draw here by ~3pp; with rho fitted, all four probs land within 0.5pp.
  const target = { pHome: 0.42088, pDraw: 0.31596, pAway: 0.26309, pOver25: 0.40241 };
  const fit = fitLambdas(target.pHome, target.pAway, target.pOver25, 2.5, target.pDraw);
  const priced = priceState({ lambdaHome: fit.lambdaHome, lambdaAway: fit.lambdaAway, rho: fit.rho, u: 0, goalsHome: 0, goalsAway: 0, redsHome: 0, redsAway: 0, totalsLines: [2.5] });
  assert.ok(Math.abs(priced.oneXTwo.home - target.pHome) < 0.005, `home ${priced.oneXTwo.home}`);
  assert.ok(Math.abs(priced.oneXTwo.draw - target.pDraw) < 0.005, `draw ${priced.oneXTwo.draw}`);
  assert.ok(Math.abs(priced.oneXTwo.away - target.pAway) < 0.005, `away ${priced.oneXTwo.away}`);
  assert.ok(Math.abs(priced.totals[2.5].over - target.pOver25) < 0.01, `over ${priced.totals[2.5].over}`);
  assert.ok(fit.rho !== 0, "rho was actually fitted");
});

test("rho decays to a no-op once the score has moved on", () => {
  const base = { lambdaHome: 1.3, lambdaAway: 1.0, u: 0.6, goalsHome: 2, goalsAway: 1, redsHome: 0, redsAway: 0, totalsLines: [2.5] };
  const flat = priceState({ ...base, rho: 0 });
  const dc = priceState({ ...base, rho: 0.15 });
  assert.ok(Math.abs(flat.oneXTwo.home - dc.oneXTwo.home) < 1e-9, "DC correction inert at 2-1");
});

test("fitLambdas recovers a known baseline round-trip", () => {
  const truth = { lambdaHome: 1.4, lambdaAway: 0.9 };
  const priced = priceState({ ...truth, u: 0, goalsHome: 0, goalsAway: 0, redsHome: 0, redsAway: 0, totalsLines: [2.5] });
  const fit = fitLambdas(priced.oneXTwo.home, priced.oneXTwo.away, priced.totals[2.5].over, 2.5);
  assert.ok(Math.abs(fit.lambdaHome - truth.lambdaHome) < 0.05, `lambdaHome ${fit.lambdaHome}`);
  assert.ok(Math.abs(fit.lambdaAway - truth.lambdaAway) < 0.05, `lambdaAway ${fit.lambdaAway}`);
});
