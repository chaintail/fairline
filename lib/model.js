// FairLine in-play pricing model.
//
// Core idea: at any point in a soccer match, the remaining goals for each team
// are modeled as independent Poisson variables. The pre-match goal intensities
// (lambdas) are calibrated to the pre-match consensus (1X2 + one total line),
// then decayed over the match clock with a time-varying scoring-intensity
// profile. Current score and card state shift the distribution; the final
// outcome distribution is the convolution of "goals so far" with "goals to
// come". See docs/model.md for the math and constants.

const MAX_GOALS = 12; // truncation for remaining-goal distributions

// ---------------------------------------------------------------------------
// Poisson helpers

export function poissonPmf(lambda, k) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let logp = -lambda + k * Math.log(lambda);
  for (let i = 2; i <= k; i++) logp -= Math.log(i);
  return Math.exp(logp);
}

export function poissonDist(lambda, maxK = MAX_GOALS) {
  const d = new Array(maxK + 1);
  let sum = 0;
  for (let k = 0; k <= maxK; k++) {
    d[k] = poissonPmf(lambda, k);
    sum += d[k];
  }
  // renormalize truncation remainder into the tail bucket
  d[maxK] += Math.max(0, 1 - sum);
  return d;
}

// ---------------------------------------------------------------------------
// Scoring-intensity profile over normalized match time u in [0,1].
//
// Empirically goals arrive more frequently late in matches (fatigue, risk
// taking). We use a linear ramp xi(u) = (1 + RAMP*u) normalized so that
// integral_0^1 xi(u) du = 1. remainingWeight(u) is the fraction of total
// expected goals still to come at time u.

const RAMP = 0.7;

export function remainingWeight(u) {
  const clamped = Math.min(1, Math.max(0, u));
  const total = 1 + RAMP / 2;
  const remaining = (1 - clamped) + (RAMP / 2) * (1 - clamped * clamped);
  return remaining / total;
}

// ---------------------------------------------------------------------------
// Card adjustments: a red card suppresses the short-handed team's intensity
// and boosts the opponent's for the remainder (constants from published
// in-play modeling literature; see docs/model.md).

const RED_SELF = 0.67;
const RED_OPP = 1.12;

export function cardMultipliers(redsFor, redsAgainst) {
  return Math.pow(RED_SELF, redsFor) * Math.pow(RED_OPP, redsAgainst);
}

// ---------------------------------------------------------------------------
// Match-state pricing

/**
 * Price a match state.
 * @param {object} s
 *   s.lambdaHome / s.lambdaAway  pre-match full-match intensities
 *   s.u                           normalized elapsed match time [0,1]
 *   s.goalsHome / s.goalsAway     current score
 *   s.redsHome / s.redsAway       red-card counts
 *   s.totalsLines                 e.g. [1.5, 2.5, 3.5] (evaluated on full-match totals)
 * @returns {object} probabilities and fair odds per market
 */
export function priceState(s) {
  const w = remainingWeight(s.u);
  const lamH = s.lambdaHome * w * cardMultipliers(s.redsHome || 0, s.redsAway || 0);
  const lamA = s.lambdaAway * w * cardMultipliers(s.redsAway || 0, s.redsHome || 0);
  const rho = s.rho || 0;

  const dh = poissonDist(lamH);
  const da = poissonDist(lamA);

  // Dixon-Coles low-score dependence: reweight the joint at final scores
  // 0-0/1-0/0-1/1-1, then renormalize. A no-op once the match has moved past
  // those scores, so the in-play application decays naturally.
  const tau = (fh, fa) => {
    if (rho === 0) return 1;
    if (fh === 0 && fa === 0) return 1 - lamH * lamA * rho;
    if (fh === 1 && fa === 0) return 1 + lamA * rho;
    if (fh === 0 && fa === 1) return 1 + lamH * rho;
    if (fh === 1 && fa === 1) return 1 - rho;
    return 1;
  };

  let pHome = 0, pDraw = 0, pAway = 0, mass = 0;
  const totalDist = new Array(2 * MAX_GOALS + 1).fill(0);
  for (let h = 0; h <= MAX_GOALS; h++) {
    for (let a = 0; a <= MAX_GOALS; a++) {
      const finalH = s.goalsHome + h;
      const finalA = s.goalsAway + a;
      const p = dh[h] * da[a] * Math.max(0, tau(finalH, finalA));
      mass += p;
      if (finalH > finalA) pHome += p;
      else if (finalH === finalA) pDraw += p;
      else pAway += p;
      totalDist[h + a] += p;
    }
  }
  if (mass > 0 && Math.abs(mass - 1) > 1e-12) {
    pHome /= mass; pDraw /= mass; pAway /= mass;
    for (let r = 0; r < totalDist.length; r++) totalDist[r] /= mass;
  }

  const currentTotal = s.goalsHome + s.goalsAway;
  const totals = {};
  for (const line of s.totalsLines || [2.5]) {
    let pOver = 0;
    for (let r = 0; r < totalDist.length; r++) {
      if (currentTotal + r > line) pOver += totalDist[r];
    }
    totals[line] = { over: pOver, under: 1 - pOver };
  }

  return {
    remaining: { lambdaHome: lamH, lambdaAway: lamA },
    oneXTwo: { home: pHome, draw: pDraw, away: pAway },
    totals,
  };
}

export function toFairOdds(p) {
  if (p <= 0) return null;
  return Math.round((1 / p) * 1000); // thousandths, matching TxLINE price units
}

// ---------------------------------------------------------------------------
// Baseline calibration: fit (lambdaHome, lambdaAway) to pre-match consensus
// P(home), P(away) and P(total > line). 2-D search over total goals mu and
// decomposition share; nested bisection is plenty at this smoothness.

export function fitLambdas(pHomeTarget, pAwayTarget, pOverTarget, line = 2.5, pDrawTarget = null) {
  // When a draw target is supplied, fit the Dixon-Coles rho too; the plain
  // independent-Poisson family cannot hit all four probabilities at once (it
  // systematically underprices draws) — see docs/model.md.
  const fitRho = pDrawTarget != null;
  let best = null;
  let muLo = 0.5, muHi = 6, shareLo = 0.05, shareHi = 0.95, rhoLo = -0.35, rhoHi = 0.35;
  for (let round = 0; round < 4; round++) {
    const muStep = (muHi - muLo) / 20;
    const shareStep = (shareHi - shareLo) / 20;
    const rhoStep = fitRho ? (rhoHi - rhoLo) / 10 : 1;
    let localBest = null;
    for (let mu = muLo; mu <= muHi; mu += muStep) {
      for (let share = shareLo; share <= shareHi; share += shareStep) {
        for (let rho = fitRho ? rhoLo : 0; rho <= (fitRho ? rhoHi : 0); rho += rhoStep) {
          const lamH = mu * share;
          const lamA = mu * (1 - share);
          const priced = priceState({
            lambdaHome: lamH, lambdaAway: lamA, u: 0, rho,
            goalsHome: 0, goalsAway: 0, redsHome: 0, redsAway: 0,
            totalsLines: [line],
          });
          let err =
            Math.pow(priced.oneXTwo.home - pHomeTarget, 2) +
            Math.pow(priced.oneXTwo.away - pAwayTarget, 2) +
            Math.pow(priced.totals[line].over - pOverTarget, 2);
          if (fitRho) err += Math.pow(priced.oneXTwo.draw - pDrawTarget, 2);
          if (!localBest || err < localBest.err) localBest = { err, lamH, lamA, mu, share, rho };
        }
      }
    }
    best = localBest;
    muLo = Math.max(0.2, localBest.mu - muStep);
    muHi = localBest.mu + muStep;
    shareLo = Math.max(0.01, localBest.share - shareStep);
    shareHi = Math.min(0.99, localBest.share + shareStep);
    if (fitRho) { rhoLo = Math.max(-0.9, localBest.rho - rhoStep); rhoHi = Math.min(0.9, localBest.rho + rhoStep); }
  }
  return { lambdaHome: best.lamH, lambdaAway: best.lamA, rho: best.rho, fitError: best.err };
}
