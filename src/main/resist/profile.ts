// The read side: a mob's resist card, and one axis's evidence drilldown (JOS-382).
//
// DERIVED ON DEMAND, ALWAYS. Nothing here is cached and nothing is stored: the ledger holds
// counts, and every number this file produces is a function of those counts plus the client's
// spell table. That is what makes a game patch — or simply the user playing for an evening —
// change the answer with no migration, no invalidation and no stale second opinion.
//
// TWO PRESENTATION DECISIONS LIVE HERE RATHER THAN IN THE MODEL, because they are about what a
// person should be shown and not about what is true:
//
//   R IS CLAMPED AT ZERO FOR DISPLAY. The estimator's grid runs down to -150 because rc does, and
//   a mob nothing has ever been resisted by fits anywhere below zero equally well. "R -150" is
//   noise on a card; "R 0" is the same statement in the reader's units. The INTERVAL is clamped
//   the same way and the underlying estimate is left alone.
//
//   EVERY CELL WITH AN OBSERVATION GETS ITS ANSWER (owner ruling, 2026-08-16, replacing this
//   file's original n >= 5 floor): the tag, the number, the interval and the count, at n = 1 the
//   same as at n = 600 — the interval simply comes out wide, which IS the honest display. Only the
//   empty cell has no tag, and the surfaces draw that as "no data". Five axes are always five rows
//   in the same order, because "we have not seen fire cast on this" and "fire is fine" are
//   different statements and a missing row says neither.

import { mobKey } from '../../shared/mobKey'
import {
  RESIST_AXES,
  type MobResistAxis,
  type MobResistCell,
  type MobResistProfile,
  type ResistAxis,
  type ResistAxisBenchmark,
  type ResistEstimate,
  type ResistRow,
  type SpellResistTable,
} from '../../shared/resistTypes'
import { estimate, hasAnswer } from '../../shared/resistModel'
import type { DamageRef } from '../../shared/resistDamage'
import { resistBenchmark } from '../../shared/resistFormula'
import { BASELINE_SOURCE_KEY } from '../../shared/resistTypes'
import type { MobLevelFact } from './world'
import type { SpellTableState } from './spellTable'

/**
 * WHY THE TABLE IS NOT THERE, in the reader's words (JOS-385).
 *
 * TWO STATES, BECAUSE THEY ARE TWO PROBLEMS. Until this ticket both said "this needs your
 * EverQuest install's spells_us.txt", which is true advice for one of them and an accusation for
 * the other: the owner hit the second after a dev restart, with the file exactly where it has
 * always been, and the app told him to go find his EverQuest folder.
 *
 * THE SENTENCE IS BUILT HERE, in main, rather than in each surface. The mob page and the con card
 * both have to say it, the con card is a self-contained payload that fetches nothing, and only
 * main knows the resolved path — so a renderer-side copy would either lack the fact or be a second
 * wording of it. (The card's numbers still cross the wire AS numbers, which is the opposite rule
 * for the opposite reason: those have a shared derivation and this does not.)
 *
 * COPY RULES: no acronyms, no em dashes, and it says what is true and what to do about it.
 */
export function spellDataNote(status: { state: SpellTableState; path: string }): string | null {
  if (status.state === 'ok') return null
  if (status.state === 'missing') {
    return `Spell data unavailable - there is no spells_us.txt at ${status.path}. Point the app at your EverQuest folder in Preferences.`
  }
  if (status.state === 'unloadable') {
    return 'Spell data unavailable - spells_us.txt was found but could not be loaded. The error log has the details.'
  }
  return 'Reading your EverQuest spell data...'
}

export interface ProfileDeps {
  /**
   * Every row anyone has filed about this creature, each tagged with its source. Takes the DISPLAY
   * NAME rather than a key, because one creature can have more than one name: the wiki page says
   * `Cazic Thule` and every line the game prints says `Cazic-Thule`, and the caller is the half
   * that knows the verified alias roster (world-model law 12).
   */
  rowsFor: (display: string) => ResistRow[]
  /** The client's spell table, or null when `spells_us.txt` could not be read. */
  spells: () => SpellResistTable | null
  /** The mob's level: a `/con` this session beats the catalog beats nothing. */
  levelOf: (key: string, display: string) => MobLevelFact | null
  /**
   * THE VIEWER'S OWN LEVEL, which is what makes the tag advice rather than trivia (JOS-387). It is
   * the character module's `currentLevel` statement — a ding or the character's own `/who` row,
   * whichever is later — and null when neither has been seen, where the benchmark falls back to an
   * even-level reading and says so.
   */
  viewerLevel: () => number | null
  /**
   * Spells whose landings are not observable, decided over the WHOLE ledger rather than over one
   * mob's rows (resistModel.ts `unobservableSpells` states why the scope matters).
   */
  unobservable: () => ReadonlySet<string>
  /**
   * The full-damage reference per (spell, caster level), decided over the WHOLE ledger for the same
   * reason `unobservable` is (`shared/resistDamage.ts` states it): a mob with four hits of a nuke
   * cannot establish what that nuke hits for, and does not have to.
   */
  damageModes: () => ReadonlyMap<string, DamageRef>
  frozenAt: () => string | null
  /**
   * Whether charmed pets and NPC casters weigh in the numbers (JOS-385). READ AT ESTIMATE TIME,
   * which is why it is a function on the deps rather than a field on a row: the ledger folds those
   * rows unconditionally and flipping the preference re-draws every card with no re-fold.
   */
  includeNpcCasters: () => boolean
  /** Why the client's spell table is unavailable, when it is. See `spellDataNote`. */
  spellStatus: () => { state: SpellTableState; path: string }
  /**
   * The newest week anything in the LEDGER was observed in: the instant every row's age is measured
   * against (`shared/resistDecay.ts`). Whole-ledger and not per-mob, or a creature nobody has
   * fought in months would report itself as freshly observed.
   */
  newestWeek: () => string | undefined
}

/** Display clamp. See the header: the model may go below zero; a card may not. */
function clampFit(est: ResistEstimate): ResistEstimate {
  return {
    ...est,
    R: Math.max(0, est.R),
    lo: Math.max(0, est.lo),
    hi: Math.max(0, est.hi),
    baselineFit: est.baselineFit
      ? { ...est.baselineFit, R: Math.max(0, est.baselineFit.R), lo: Math.max(0, est.baselineFit.lo), hi: Math.max(0, est.baselineFit.hi) }
      : null,
    userFit: est.userFit
      ? { ...est.userFit, R: Math.max(0, est.userFit.R), lo: Math.max(0, est.userFit.lo), hi: Math.max(0, est.userFit.hi) }
      : null,
  }
}

/** Everything the five axis fits share, resolved once per profile rather than five times. */
interface AxisCtx {
  mobLevel: number | null
  /** The level the benchmark is evaluated at: the tailed character's, or null when unknown. */
  viewerLevel: number | null
  unobservable: ReadonlySet<string>
  modes: ReadonlyMap<string, DamageRef>
  includeNpcCasters: boolean
  /** The ledger-wide age reference every row's decay is measured against (JOS-397). */
  newestWeek: string | undefined
}

/**
 * THE BENCHMARK FOR ONE AXIS: the answer at the estimate, and the same answer at each end of the
 * interval so a surface can print the uncertainty in landing chances rather than in R.
 *
 * THE HARD DATA RULE OVERRIDES THE TAG AND NOTHING ELSE (owner review, 2026-08-16). When a cell
 * with real evidence was resisted at least nine times in ten, the word is `very resistant` whatever
 * the fitter produced — but the two percentages beside it stay the model's own, because they are
 * the model's claim and quietly rewriting them would hide the disagreement rather than report it.
 * A surface that sees a forced tag beside a cheerful percentage is seeing something real.
 */
function axisBenchmark(est: ResistEstimate, ctx: AxisCtx): ResistAxisBenchmark {
  const at = (R: number): ReturnType<typeof resistBenchmark> =>
    resistBenchmark(R, ctx.viewerLevel, ctx.mobLevel)
  const main = at(est.R)
  const forced = est.resistsAlmostEverything
  return {
    ...main,
    // BOTH HALVES MOVE TOGETHER: the word and the sentence are one band read two ways, and a chip
    // that said `resistant · may not land even with overchannel` would be two answers on one line.
    tag: forced ? 'very resistant' : main.tag,
    guidance: forced ? 'may not land even with overchannel' : main.guidance,
    atLo: at(est.lo),
    atHi: at(est.hi),
  }
}

function axisRow(
  rows: readonly ResistRow[],
  spells: SpellResistTable,
  axis: ResistAxis,
  ctx: AxisCtx
): MobResistAxis {
  const est = clampFit(
    estimate(rows, spells, {
      axis,
      mobLevel: ctx.mobLevel,
      unobservable: ctx.unobservable,
      modes: ctx.modes,
      includeNpcCasters: ctx.includeNpcCasters,
      newestWeek: ctx.newestWeek,
    })
  )
  // A PINNED FIT PRINTS NO NUMBER AND NO TAG (owner review, 2026-08-16). The posterior slid to an
  // edge of the grid, which means no R this game can express explains what was observed — and the
  // display used to clamp that to `R 0` and call it `weak`, on a creature that resisted half of
  // everything thrown at it. The estimate still travels, because the row prints the OBSERVATIONS
  // instead (`est.empirical`), and the drilldown is unchanged.
  const bench = hasAnswer(est.n) && !est.pinned ? axisBenchmark(est, ctx) : null
  return {
    axis,
    estimate: est,
    tag: bench?.tag ?? null,
    benchmark: bench,
    n: est.n,
    nInformative: est.nInformative,
  }
}

/** The Resists card for one mob. Always five axis rows, always in `RESIST_AXES` order. */
export function mobResistProfile(displayName: string, deps: ProfileDeps): MobResistProfile {
  const key = mobKey(displayName)
  const spells = deps.spells()
  const rows = deps.rowsFor(displayName)
  const fact = deps.levelOf(key, displayName)
  const level = fact ? { lo: fact.lo, hi: fact.hi, from: fact.from } : null
  const ctx: AxisCtx = {
    mobLevel: fact?.level ?? null,
    viewerLevel: deps.viewerLevel(),
    unobservable: deps.unobservable(),
    modes: deps.damageModes(),
    includeNpcCasters: deps.includeNpcCasters(),
    newestWeek: deps.newestWeek(),
  }
  const axes = spells
    ? RESIST_AXES.map((axis) => axisRow(rows, spells, axis, ctx))
    : RESIST_AXES.map(
        (axis) =>
          ({ axis, estimate: null, tag: null, benchmark: null, n: 0, nInformative: 0 }) satisfies MobResistAxis
      )
  return {
    mobKey: key,
    displayName,
    level,
    axes,
    spellDataAvailable: spells !== null,
    spellDataNote: spells !== null ? null : spellDataNote(deps.spellStatus()),
    baselineFrozenAt: deps.frozenAt(),
  }
}

/**
 * One axis's evidence. The rows are returned as they were filed — the renderer shows per-spell
 * lines built by the estimator, and this is what a future export or a bug report would carry.
 */
export function mobResistCell(
  displayName: string,
  axis: ResistAxis,
  deps: ProfileDeps
): MobResistCell | null {
  const spells = deps.spells()
  if (!spells) return null
  const key = mobKey(displayName)
  const rows = deps.rowsFor(displayName)
  const fact = deps.levelOf(key, displayName)
  const est = clampFit(
    estimate(rows, spells, {
      axis,
      mobLevel: fact?.level ?? null,
      unobservable: deps.unobservable(),
      modes: deps.damageModes(),
      includeNpcCasters: deps.includeNpcCasters(),
      newestWeek: deps.newestWeek(),
    })
  )
  const keep = rows.filter((r) => spells[r.spellKey]?.axis === axis)
  return { mobKey: key, axis, estimate: est, rows: keep }
}

/** What the profile builder needs from the ledger, spelled once. */
export const BASELINE_KEY = BASELINE_SOURCE_KEY
