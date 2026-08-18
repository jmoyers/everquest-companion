// THE GRID AND THE POSTERIOR — how one cell's R and its interval are actually computed (JOS-387,
// split out of resistModel.ts).
//
// Pure. `resistModel.ts` turns rows into likelihood TERMS and this file turns terms into a number
// with an interval; the split is along that seam because the two change for different reasons — the
// terms move when the log or the spell table does, and this file moves when the statistics do.
//
// ── WHY THE POSTERIOR MEDIAN AND NOT THE MAXIMUM (owner review, 2026-08-16) ─────────────────────
//
// The first cut reported the ARGMAX of the shrunk posterior and an interval from the profile
// likelihood. It is right wherever the likelihood has a peak and WRONG wherever it has a PLATEAU,
// which is the shape the game's own formula produces constantly:
//
//   * `P(resist) = rc/200` SATURATES. Once rc reaches 200 every all-or-nothing cast is resisted, so
//     every R above that point predicts the same thing and the likelihood is flat from there to the
//     top of the grid. A cell where the mob resisted EVERYTHING therefore has a plateau, the argmax
//     sits at its LOWEST edge (the first grid point that explains the data), and the row reports the
//     weakest resistance consistent with the evidence as though it were the estimate. MEASURED: a
//     dracoliche's disease read `R 60 (46-600) resistant` off thirty observations that were all
//     resists — the honest reading of which is "somewhere in the hundreds, and nothing you cast on
//     that axis landed".
//   * The mirror case at the bottom (rc <= 0, nothing ever resisted) has the same shape upside down.
//
// The MEDIAN of the posterior lands mid-plateau, which is the middle of what the evidence allows,
// and on a peaked likelihood it sits within a grid step of the old maximum. So the change is
// invisible where the old answer was right and it is the whole fix where it was not.
//
// THE INTERVAL IS NOW THE CENTRAL 95% OF THE SAME POSTERIOR rather than a profile-likelihood cut.
// One distribution produces both numbers, so the point can no longer fall outside its own interval
// (the old code had to clamp it back in), and the two are read against each other honestly.
//
// ── AND SOMETIMES THE MODEL SIMPLY DOES NOT FIT ────────────────────────────────────────────────
//
// `pinned` is the guard the same review asked for, and MEASURING THE CASE MOVED THE TEST. The
// review's diagnosis was "the posterior slid to the grid floor"; the arithmetic says it slides to
// the PHYSICAL floor instead, and stops there because the model can still trade a bad fit for a
// slightly-less-bad one at a negative resistance.
//
// Eye of Veeshan, poison. Bzzazzt (a charmed level-50 spider) throws Deadly Poison at a level-70
// creature: 31 resists, 27 full ticks, 1 landing. `levelMod` alone is +200 at that gap, so the
// model predicts 100% resisted at every R a creature can have — and the best it can do is slide R
// to about -50, where it still predicts a quarter of the casts resisted against the half that were.
// The display clamped that to `R 0 (0-0)` and the tag called it WEAK: a creature that resists half
// of everything thrown at it, reported as the easiest thing on the card.
//
// So the guard is TWO tests, and both are about whether an answer may be printed at all:
//
//   THE GRID RAN OUT — the median is within a step of an edge. The fitter had nowhere further to
//   go, so its answer is a boundary artifact rather than an estimate.
//   THE ANSWER IS UNPHYSICAL OR THE MODEL MISSES — the whole credible interval sits at or below
//   zero (a creature cannot have negative resistance), or the resist count the fit predicts is
//   `RESIDUAL_SIGMAS` standard deviations away from the count the game actually printed. The second
//   is an ordinary goodness-of-fit residual and it is what catches the Eye: no amount of sliding R
//   reconciles 52% resisted with a level term of +200.
//
// The honest output in either case is not a number; it is the resist rate and a sentence saying the
// model could not fit it.

/** Grid search bounds and step for R. Step 2 is the resolution every printed interval carries. */
export const R_MIN = -150
export const R_MAX = 600
export const R_STEP = 2

/** The central credible interval the surfaces print. */
export const CREDIBLE_MASS = 0.95

/**
 * How far the model's own predicted resist count may sit from the observed one before the fit is
 * refused. Four sigma is a one-in-sixteen-thousand event under the model, so it fires on a model
 * that is wrong and never on a cell that was merely unlucky.
 */
export const RESIDUAL_SIGMAS = 4

/** Below this many observations a residual is noise, whatever it looks like. */
export const RESIDUAL_MIN_N = 10

/**
 * AND IT HAS TO BE A BIG MISS, not merely a certain one. MEASURED, and the measurement is why this
 * threshold exists at all: four sigma on a cell with 348 observations is a nine-percent
 * disagreement, and a thunder spirit princess's magic — a perfectly ordinary cell, 348 casts by
 * charmed pets at a spread of levels — trips it. The model is deliberately approximate (the
 * charisma term is not modelled at all, a cell pools several spells, and an npc caster's level
 * comes off a catalog), so a few points of systematic slack is expected everywhere and is not a
 * reason to withhold an answer.
 *
 * What IS a reason is a disagreement no amount of R can close: the Eye of Veeshan predicts a
 * quarter resisted against the half that were. Fifteen points of resist rate separates the two
 * cleanly, and requiring BOTH tests means a large cell needs a large miss and a small cell needs a
 * certain one.
 */
export const RESIDUAL_MIN_RATE_GAP = 0.15

/**
 * A NEGATIVE FIT IS ONLY A FAILURE IF THE CREATURE RESISTS THINGS, and MEASURING THE BASELINE IS
 * WHAT SETTLED THAT. R below zero is how the model spells "nothing you cast is ever refused", and
 * twenty-one cells of the shipped baseline sit there honestly — `a basalt gargoyle`, poison, 0 of
 * 19 — where the right row is `R 0 · should land` and refusing to print one would be absurd.
 *
 * The failure is the OTHER shape: a whole credible interval below zero on a creature that visibly
 * resisted a good share of what was thrown at it, which is the fitter reaching for a resistance the
 * game does not have because some other term of `rc` is wrong. That is the Eye of Veeshan at 52%
 * resisted, and this rate is the line between the two populations.
 */
export const UNPHYSICAL_MIN_RESIST_RATE = 0.15

/** One cell's answer: the posterior median, its central interval, and whether it may be believed. */
export interface GridFit {
  R: number
  lo: number
  hi: number
  /**
   * THE POSTERIOR RAN OUT OF GRID. The median is within one step of an edge, or the interval
   * collapsed to nothing at one. Callers must not print a number or a tag — see `fitPinned`.
   */
  pinned: boolean
}

/** Log density of the posterior at each grid point, in grid order. */
export function posteriorLogs(logDensity: (R: number) => number): { Rs: number[]; logs: number[] } {
  const Rs: number[] = []
  const logs: number[] = []
  for (let R = R_MIN; R <= R_MAX; R += R_STEP) {
    Rs.push(R)
    logs.push(logDensity(R))
  }
  return { Rs, logs }
}

/**
 * The median and the central 95% of a posterior given as log densities on the grid.
 *
 * Normalised by the maximum before exponentiating, which is the standard trick and the only reason
 * a cell with six hundred observations does not underflow to a vector of zeros.
 */
export function gridFit(
  logDensity: (R: number) => number,
  /** How many resists the model predicts at an R. Omitted, the residual test is skipped. */
  predictedResists?: (R: number) => number,
  /** What the game actually printed. Omitted, the residual test is skipped. */
  observed?: { resisted: number; total: number }
): GridFit {
  const { Rs, logs } = posteriorLogs(logDensity)
  let max = -Infinity
  for (const l of logs) if (l > max) max = l
  const weights = logs.map((l) => Math.exp(l - max))
  let total = 0
  for (const w of weights) total += w
  if (!(total > 0) || !Number.isFinite(total)) {
    // Cannot happen with a floored likelihood; answering the middle of the grid beats answering NaN.
    return { R: 0, lo: R_MIN, hi: R_MAX, pinned: true }
  }
  const at = (q: number): number => {
    let acc = 0
    for (let i = 0; i < Rs.length; i++) {
      acc += weights[i]
      if (acc / total >= q) return Rs[i]
    }
    return Rs[Rs.length - 1]
  }
  const tail = (1 - CREDIBLE_MASS) / 2
  const R = at(0.5)
  const lo = at(tail)
  const hi = at(1 - tail)
  const misfit =
    predictedResists !== undefined && observed !== undefined
      ? doesNotFit(predictedResists(R), observed) || unphysical(hi, observed)
      : false
  return { R, lo, hi, pinned: fitPinned(R) || misfit }
}

/** The whole answer is below zero on a creature that demonstrably resists. See the constant. */
export function unphysical(hi: number, observed: { resisted: number; total: number }): boolean {
  if (observed.total < RESIDUAL_MIN_N) return false
  return hi <= 0 && observed.resisted / observed.total >= UNPHYSICAL_MIN_RESIST_RATE
}

/**
 * How many standard deviations the model's predicted resist count sits from the observed one.
 * A binomial normal approximation, floored so a degenerate variance cannot answer Infinity on a
 * cell that matched exactly.
 */
/**
 * BOTH TESTS, and both have to hold: the miss is big (`RESIDUAL_MIN_RATE_GAP` of resist rate) and it
 * is certain (`RESIDUAL_SIGMAS`). Either alone misfires — the first on a thin cell that was merely
 * unlucky, the second on any large cell, where the model's ordinary slack becomes statistically
 * overwhelming without becoming important.
 */
export function doesNotFit(expected: number, observed: { resisted: number; total: number }): boolean {
  if (observed.total < RESIDUAL_MIN_N) return false
  const gap = Math.abs(observed.resisted - expected) / observed.total
  return gap >= RESIDUAL_MIN_RATE_GAP && residualSigmas(expected, observed) > RESIDUAL_SIGMAS
}

export function residualSigmas(expected: number, observed: { resisted: number; total: number }): number {
  if (observed.total < RESIDUAL_MIN_N) return 0
  const p = Math.min(Math.max(expected / observed.total, 1 / observed.total), 1 - 1 / observed.total)
  const sd = Math.sqrt(observed.total * p * (1 - p))
  if (!(sd > 0)) return 0
  return Math.abs(observed.resisted - expected) / sd
}

/** Did the fitter run out of grid? Its answer is then a boundary artifact, not an estimate. */
export function fitPinned(R: number): boolean {
  return R <= R_MIN + R_STEP || R >= R_MAX - R_STEP
}
