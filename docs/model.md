# The FairLine pricing model

The model prices a soccer match at any in-play moment from four inputs: the
pre-match consensus board, the clock, the score, and the card state. It is
deliberately a *transparent* model — every step below is implemented in
`lib/model.js` in ~200 lines and unit-tested.

## 1. Remaining goals are Poisson

At time `u ∈ [0,1]` (normalized match time) with score `(gH, gA)`, the goals
each team scores **in the remainder** are modeled as independent Poisson
variables:

```
H_rem ~ Poisson(λH · R(u) · cardsH)      A_rem ~ Poisson(λA · R(u) · cardsA)
```

- `λH, λA` — full-match intensities, calibrated pre-match (§3).
- `R(u)` — the fraction of expected goals still to come (§2).
- `cards*` — red-card multipliers (§4).

The final-score distribution is the current score plus the convolution of the
two remaining-goal distributions (truncated at 12, tail folded). 1X2 and totals
probabilities are exact sums over that grid — no simulation, fully
deterministic, ~10⁴ multiplications per tick.

## 2. Time profile: goals arrive faster late

Scoring intensity is not flat: goals arrive more frequently as matches age
(fatigue, chasing, risk-taking). We use a linear ramp

```
ξ(u) ∝ 1 + 0.7u,  normalized so ∫₀¹ ξ = 1
R(u) = ∫ᵤ¹ ξ(s) ds  →  R(0)=1, R(0.5)≈0.53, R(1)=0
```

so at half-time ~53% of expected goals are still to come, matching the
well-documented empirical skew toward second-half goals. Half-time and other
breaks hold `u` constant; stoppage time is clamped into its half so a long
first half never prices as second-half time (`lib/txline.js normalizedTime`).

## 3. Baseline calibration — the model starts where the market starts

`fitLambdas()` inverts the pre-match de-margined consensus into model
parameters: it searches `(μ = λH+λA, share = λH/μ, ρ)` (coarse-to-fine grid)
to match **four** targets: P(home), P(draw), P(away), P(over 2.5).

`ρ` is the **Dixon-Coles low-score correction** — independent Poissons
systematically underprice draws (by ~3pp on a typical even board). The DC
adjustment reweights the joint at final scores 0-0, 1-0, 0-1, 1-1:

```
τ(0,0) = 1 − λH λA ρ    τ(1,0) = 1 + λA ρ
τ(0,1) = 1 + λH ρ       τ(1,1) = 1 − ρ
```

(then renormalizes). With ρ fitted, the pre-match board is reproduced to
within a few hundredths of a probability point — so **at kickoff the model
agrees with the market by construction**, and every point of in-play edge
comes from *how* each side reprices events, not from a baked-in disagreement.

In-play, τ applies to *final* scores, so once the match moves past 1-1 the
correction is inert (tested). This is a documented approximation: the classic
DC formulation is a pre-match device; applying it through the remaining-goal
joint is standard practice for in-play engines of this class.

During extra time the regulation model is exhausted; `u` is clamped near 1 and
prices freeze toward the terminal distribution (documented limitation — a
production engine would carry a dedicated ET/penalties model).

## 4. Red cards

A red card multiplies the short-handed team's remaining intensity by **0.67**
and the opponent's by **1.12** — round figures consistent with the published
in-play literature (10-man teams score ~⅓ less; opponents gain ~10%). Yellow
cards are tracked and displayed but do not move the model.

## 5. Edge

Against the de-margined consensus probabilities `q`:

- **edge (pp)** = `(p_model − q) × 100` per outcome
- **EV @ consensus** = `p_model / q − 1` — the expected value of backing the
  outcome at the consensus's fair (margin-free) price.

Both are published per tick and logged. On the synthetic fixture the
"consensus" is a simulated market (lagged, perturbed-parameter copy of the
model — `scripts/generate-fixture.mjs`), so edge there demonstrates the
*mechanics* (instant repricing vs market convergence after goals/cards), not
predictive skill. Live-mode edge is real but measured on a 60s-delayed feed.

## What we'd do with more time

- Dedicated extra-time/penalties model (the Final can go there).
- Score-state-dependent intensities (trailing teams push; leading teams shell).
- Bivariate/Karlis-Ntzoufras structures instead of DC-corrected independence.
- Calibration from odds history rather than a single pre-match snapshot.
