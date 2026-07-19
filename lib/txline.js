// TxLINE payload handling — the single ingestion seam shared by live mode and
// replay mode. Everything downstream of these functions is identical for real
// and recorded/synthetic data; that is the point of the architecture.
//
// Payload shapes follow the TxLINE OpenAPI spec (docs.yaml):
//  - odds:   { FixtureId, Ts, Bookmaker, SuperOddsType, MarketParameters,
//              PriceNames: [...], Prices: [thousandths...], Pct: [...] }
//  - scores: { FixtureId, GameState, StatusId/statusId (numeric), Clock,
//              Score { Participant1/2 -> period -> {Goals, RedCards, ...} },
//              Data { Action, Goal, Minutes, Participant, RedCard, ... } }
//  Note: `GameState` is a coarse/stale string field (observed stuck at
//  "scheduled" for the entire real 2026 World Cup Final feed, fixture
//  18257739, well past kickoff and into half-time) — it is NOT a reliable
//  phase signal. `StatusId` is the real one.

// Soccer phase ids we price. Regulation only: the World Cup final can go to
// extra time, in which case the engine keeps pricing with u capped (documented
// limitation in docs/model.md).
export const PHASES = {
  NS: "pre-match",
  H1: "first half",
  HT: "half-time",
  H2: "second half",
  ET1: "extra time 1",
  HTET: "ET break",
  ET2: "extra time 2",
  WET: "awaiting ET",
  WPE: "awaiting pens",
  PE: "penalties",
  END: "full time",
  FET: "after extra time",
  FPE: "after penalties",
};

export const REGULATION_SECONDS = 90 * 60;

/**
 * Normalized elapsed match time u in [0,1] from a phase + clock.
 * Stoppage time compresses into the phase boundary (H1 clock can exceed 45:00;
 * we cap u at 0.5 during H1 so a long first half never prices as second-half
 * time). During breaks the clock holds at the boundary.
 */
export function normalizedTime(phase, clockSeconds) {
  switch (phase) {
    case "NS": return 0;
    case "H1": return Math.min(clockSeconds / REGULATION_SECONDS, 0.5);
    case "HT": return 0.5;
    case "H2": return Math.min(Math.max(clockSeconds / REGULATION_SECONDS, 0.5), 1);
    // Extra time: regulation model is exhausted; keep a sliver of remaining
    // time so prices stay live rather than frozen (documented approximation).
    case "WET": case "HTET": return 0.97;
    case "ET1": case "ET2": return 0.98;
    case "WPE": case "PE": return 0.995;
    case "END": case "FET": case "FPE": return 1;
    default: return 0;
  }
}

export function isTerminal(phase) {
  return phase === "END" || phase === "FET" || phase === "FPE";
}

// TxLINE StatusId codes, empirically confirmed against the real 2026 World
// Cup Final feed (fixture 18257739): 1 = not started, 2 = ball in play
// (BOTH halves share this code — there is no separate "second half" status;
// `clockSeconds`, a continuous whole-match counter that does not reset at
// half-time, is what actually discriminates H1 from H2, consistent with how
// normalizedTime() already treats clockSeconds as continuous 0..5400ish),
// 3 = half-time break. Codes beyond regulation (extra time/penalties/full
// time) are not confirmed against real data — matches the existing
// "regulation only" limitation documented above rather than guessing.
function phaseFromStatusId(statusId, clockSeconds) {
  switch (statusId) {
    case 1: return "NS";
    case 2: return clockSeconds < REGULATION_SECONDS / 2 ? "H1" : "H2";
    case 3: return "HT";
    default: return null;
  }
}

/**
 * Reduce a TxLINE scores payload (snapshot item or stream event) to the flat
 * match state the model prices. Accepts both PascalCase (snapshot) and
 * camelCase (stream) field spellings, which both occur in the wild.
 */
export function scoreToState(payload) {
  const g = (obj, ...names) => {
    for (const n of names) if (obj && obj[n] !== undefined) return obj[n];
    return undefined;
  };
  const statusId = g(payload, "StatusId", "statusId");
  const clock = g(payload, "Clock", "clock") || {};
  const clockSeconds = clock.Seconds ?? clock.seconds ?? 0;
  const phase = phaseFromStatusId(statusId, clockSeconds) ?? normalizePhase(g(payload, "GameState", "gameState"));
  const score = g(payload, "Score", "score") || {};
  const p1 = g(score, "Participant1", "participant1") || {};
  const p2 = g(score, "Participant2", "participant2") || {};
  const p1Total = g(p1, "Total", "total") || {};
  const p2Total = g(p2, "Total", "total") || {};
  return {
    fixtureId: g(payload, "FixtureId", "fixtureId"),
    phase,
    clockSeconds,
    clockRunning: clock.Running ?? clock.running ?? false,
    goalsHome: p1Total.Goals ?? p1Total.goals ?? 0,
    goalsAway: p2Total.Goals ?? p2Total.goals ?? 0,
    redsHome: p1Total.RedCards ?? p1Total.redCards ?? 0,
    redsAway: p2Total.RedCards ?? p2Total.redCards ?? 0,
    yellowsHome: p1Total.YellowCards ?? p1Total.yellowCards ?? 0,
    yellowsAway: p2Total.YellowCards ?? p2Total.yellowCards ?? 0,
    cornersHome: p1Total.Corners ?? p1Total.corners ?? 0,
    cornersAway: p2Total.Corners ?? p2Total.corners ?? 0,
    seq: g(payload, "Seq", "seq"),
    ts: g(payload, "Ts", "ts"),
  };
}

const PHASE_ALIASES = {
  "scheduled": "NS", "not started": "NS", "1": "NS",
  "playing": "H1", "in play": "H1",
  "finished": "END", "ended": "END",
};

export function normalizePhase(raw) {
  if (!raw) return "NS";
  const s = String(raw);
  if (PHASES[s]) return s;
  const alias = PHASE_ALIASES[s.toLowerCase()];
  return alias || "NS";
}

/**
 * Extract consensus probabilities from a set of TxLINE odds payloads for one
 * fixture. Prefers the published de-margined Pct fields; falls back to
 * proportional de-margining of Prices where Pct is "NA" (quarter lines).
 * Returns { oneXTwo: {home,draw,away}, totals: {line: {over,under}}, asOfTs }.
 */
export function oddsToConsensus(oddsPayloads) {
  const out = { oneXTwo: null, totals: {}, asOfTs: 0 };
  for (const o of oddsPayloads || []) {
    // Full-match markets only: period-scoped markets (e.g. MarketPeriod
    // "half=1") are published alongside and must not pollute the consensus.
    if (o.MarketPeriod) continue;
    const ts = o.Ts ?? o.ts ?? 0;
    out.asOfTs = Math.max(out.asOfTs, ts);
    const probs = extractProbs(o);
    if (!probs) continue;
    if (o.SuperOddsType === "1X2_PARTICIPANT_RESULT") {
      out.oneXTwo = { home: probs[0], draw: probs[1], away: probs[2] };
    } else if (o.SuperOddsType === "OVERUNDER_PARTICIPANT_GOALS") {
      const m = /line=([0-9.]+)/.exec(o.MarketParameters || "");
      if (m) out.totals[m[1]] = { over: probs[0], under: probs[1] };
    }
  }
  return out;
}

function extractProbs(o) {
  const pct = o.Pct;
  if (Array.isArray(pct) && pct.every((x) => x !== "NA" && x !== null && x !== undefined)) {
    const probs = pct.map((x) => parseFloat(x) / 100);
    if (probs.every((p) => p > 0 && p < 1)) return probs;
  }
  const prices = o.Prices;
  if (Array.isArray(prices) && prices.length && prices.every((x) => x > 1000)) {
    const raw = prices.map((x) => 1000 / x);
    const sum = raw.reduce((a, b) => a + b, 0);
    return raw.map((r) => r / sum);
  }
  return null;
}

/** Decimal odds (thousandths, TxLINE price units) from a probability. */
export function probToPrice(p) {
  if (!p || p <= 0) return null;
  return Math.round(1000 / p);
}
