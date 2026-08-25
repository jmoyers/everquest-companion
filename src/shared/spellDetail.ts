// spellDetail.ts — WHAT ONE SPELL IS, as the committed sources state it, and the PURE selection
// of which of those facts a card may draw (JOS-293).
//
// Two halves, both here so main (which builds the record), the preload bridge (which types it) and
// the renderer (which draws it) compile against ONE definition:
//
//   1. `SpellDetail` — the record main answers `spells:detail` with. Every field is OPTIONAL for a
//      reason: it mirrors `SpellEntry` (shared/buffTypes.ts), whose fields are absent exactly when
//      the wiki page omitted them. Nothing here is ever filled in with a default, a zero or a dash.
//   2. `spellStatRows` / `spellLineageLine` — the fact SELECTION. A row exists if and only if a
//      source stated the field behind it (world-model law 1). This is the half worth unit-testing,
//      which is why it is a pure function over the record rather than JSX inside the card.
//
// THE LINEAGE BOUNDARY IS PART OF THE MODEL, NOT AN OVERSIGHT (the DATA-FIRST half of JOS-293).
// A rank line is enumerated by the sources that NAME its ranks, and that is all it is:
//   * the committed spell DB carries 121 rank-suffixed rows across 72 lines (Rune I-V, Burnout
//     I-IV, the poison ladders, the AA passives). For the other ~1,800 spells it holds ONE row,
//     which is why `Celestial Remedy III` has no DB sibling to point at even though the game
//     plainly has one.
//   * the LOG names every rank you have actually cast (`AlertsSnap.spellLastCast`, which is
//     rank-preserving on purpose) — 36 distinct suffixed names in the owner's own log.
// So `members` is a list of ranks SOMEBODY NAMED, each labelled with who named it, and `replaces`
// is the highest of them below the one you are looking at. There is deliberately NO "rank 3 of 5":
// no source in this repo states how many ranks a line has, so a denominator would be invented.
// See the report on JOS-293 for the cross-line half (overwrite/stacking), which the committed data
// does not state at all.

import type { SpellMetrics } from './spellMetrics'
import type { FocusKind } from './wornFocus'

/** One worn focus effect that lifted one side of a spell's figures (JOS-452). */
export interface SpellDetailFocus {
  side: FocusKind
  /** the effect's own name, verbatim ("Improved Damage II") */
  effect: string
  /** the item wearing it, as the character's dump named it */
  item: string
  /** the resolved percent: the middle of the focus's band, after the level rule */
  pct: number
}

/** A rank of one line, and which source named it. */
export interface SpellRankMember {
  /** display name exactly as its source spells it ("Lay on Hands IX"). */
  name: string
  /** 1..10. A name with no roman numeral is rank 1. */
  rank: number
  /** `db` = the committed spell DB has a row; `log` = you have cast it; `both` = both. */
  source: 'db' | 'log' | 'both'
}

/** What the rank in a spell's own name, joined with the ranks a source names, adds up to. */
export interface SpellLineage {
  /** the rank ordinal of the name that was asked for. */
  rank: number
  /** false when that name carries no roman numeral (an implicit rank 1). */
  suffixed: boolean
  /** the line's base name, numeral stripped. */
  base: string
  /** every rank a source names, ascending, deduped by display name. */
  members: SpellRankMember[]
  /** the highest member BELOW `rank`, when a source names one. Absent otherwise. */
  replaces?: string
}

/**
 * One spell, as the committed sources state it. Absent field = the source said nothing.
 *
 * `found: false` is its own answer and is not the same as an empty record: it means no row of the
 * spell DB carries that name, so the card says that rather than drawing a blank window.
 */
export interface SpellDetail {
  /** the name that was asked for, verbatim. */
  queried: string
  /** the DB's own display name for the line. Absent when nothing was found. */
  name?: string
  found: boolean
  /** the wiki's own duration words ("24 Sec", "Permanent"), never a re-spelling of them. */
  durationText?: string
  castTimeMs?: number
  /**
   * The wiki's `recast_time` in ms (JOS-444). The card prints it WHENEVER a source states one, not
   * only when it is long enough to earn a word on a dense unlock row: the card is the place a
   * player goes to ask what a spell costs him, and "how soon can I do that again" is one of the
   * four numbers that answers it. Absent when the page omits it, like every other field here.
   */
  recastMs?: number
  mana?: number
  targetType?: string
  spellType?: string
  /** the two-word disposition spellDb.ts folds `spellType` into. 'unknown' is a real answer. */
  nature: 'beneficial' | 'detrimental' | 'unknown'
  illusion: boolean
  /** the bard pages' "Enhanced by instrument?" row, verbatim. */
  instrumentEnhanced?: string
  /** the wiki's numbered effect list, VERBATIM and in page order (SpellEntry.effects). */
  effects?: string[]
  /**
   * WHAT IT IS WORTH (JOS-392, owner addition) — the SAME figures the unlock row prints, read by
   * the SAME reader (`shared/spellMetrics.ts`) in MAIN, off the effect list above.
   *
   * The card and the row must never disagree about a number, and the way to guarantee that is one
   * reader running once per record rather than a renderer re-reading the effect strings it happens
   * to have. It also makes the figures reachable where no row exists: hovering the spell a row
   * SAYS IT REPLACES opens that spell's card, which is the whole point of the comparison.
   */
  metrics?: SpellMetrics
  /**
   * The level `metrics` were read at — the lowest level any class gains the line, the same rule the
   * unlock dataset uses. Stated because a ramp's numbers mean nothing without it.
   */
  metricsLevel?: number
  /**
   * THE SAME FIGURES AT THE RANK YOU HAVE BEEN OBSERVED HOLDING (JOS-447), or absent when the log
   * has never watched this line above base.
   *
   * The card states BOTH because it has the room the table does not: `metrics` is the spell as the
   * catalog describes it and this is the spell as you own it, and a player deciding whether to
   * spend motes needs to see the two side by side. Read by the SAME `spellMetricsAt` in the same
   * pass, so the two lines cannot be two derivations that agree today.
   *
   * DAMAGE IS THE ONLY AXIS THAT MOVES in v1 - shared/spellScale.ts's header carries the fit and
   * the direction of the error on the rest.
   */
  metricsAtRank?: SpellMetrics
  /** The rank `metricsAtRank` was read at, 2..10. Absent whenever `metricsAtRank` is. */
  metricsRank?: number
  /**
   * THE SAME FIGURES WITH YOUR GEAR ON (JOS-452), or absent when nothing you are wearing carries a
   * focus effect this spell qualifies for.
   *
   * A THIRD line rather than a replacement, for `metricsAtRank`'s reason: `metrics` is the spell as
   * the catalog describes it, `metricsAtRank` is the spell as you OWN it, and this is the spell as
   * you CAST it. Read at the rank when there is one, so the card's last line is always its most
   * complete one. The same `spellMetricsAt` in the same pass, so the three cannot drift.
   */
  metricsWithFocus?: SpellMetrics
  /**
   * WHICH ITEM ANSWERED (the owner's ask, verbatim in the brief: the card states which item did
   * this). One entry per side that had a focus on it - `Improved Damage II (Polished Mithril Mask
   * (Exaltation)) +11%` is what the card has to be able to say, and it says it from these fields
   * rather than from a sentence main pre-composed.
   *
   * Absent exactly when `metricsWithFocus` is.
   */
  focusSources?: SpellDetailFocus[]
  /** per-class entry levels for the LINE (never for the rank - the DB has no per-rank levels). */
  classLevels: { cls: string; level: number }[]
  msgCastOnYou?: string
  msgCastOnOther?: string
  msgWearsOff?: string
  /**
   * What `spellEffectClass.ts` reads off the effect list — the DERIVED rosters ('charm', 'slow',
   * 'mez' …). Ids rather than a union so a rule added over there cannot fail to compile here; the
   * label map below falls back to the id, so a new class shows up as itself instead of vanishing.
   */
  effectClasses: string[]
  /** null when the name carries no numeral AND no source names any other rank of its line. */
  lineage: SpellLineage | null
  /**
   * THE WIKI BADGES THIS SPELL'S PAGE OUT OF ERA (JOS-393) — `true` or absent, never `false`, the
   * law `SpellEntry.outOfEra` states in full.
   *
   * It rides the record so the card wears the same chip the item card wears, wherever the card is
   * opened from: a folded level row, a search result, or the name inside a `replaces` clause — that
   * last one being the case no list can cover, since the spell a row says it replaces has no row of
   * its own on screen.
   */
  outOfEra?: boolean
}

/** One drawn row of the card's stat block. */
export interface SpellStatRow {
  /** stable key + testid suffix. */
  id: string
  label: string
  value: string
}

/** Seconds, one decimal, the way the wiki writes casting_time. */
function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}

/**
 * The stat block, in the order a spell window reads: what it is, who it hits, what it costs, how
 * long it lasts.
 *
 * EVERY ROW IS CONDITIONAL, and that is the whole function (law 1). A spell whose page states no
 * mana gets no mana row - not a `0`, not a `-`. `mana: 0` is a STATED zero (every bard song) and
 * does get one, which is why the test is `!== undefined` rather than truthiness.
 */
export function spellStatRows(d: SpellDetail): SpellStatRow[] {
  const rows: SpellStatRow[] = []
  if (d.spellType !== undefined) rows.push({ id: 'type', label: 'Type', value: d.spellType })
  if (d.targetType !== undefined) rows.push({ id: 'target', label: 'Target', value: d.targetType })
  if (d.castTimeMs !== undefined) rows.push({ id: 'cast', label: 'Cast', value: seconds(d.castTimeMs) })
  // Beside the cast, because the two are one sentence: the cycle is the first plus the second.
  if (d.recastMs !== undefined) rows.push({ id: 'recast', label: 'Recast', value: seconds(d.recastMs) })
  if (d.mana !== undefined) rows.push({ id: 'mana', label: 'Mana', value: String(d.mana) })
  if (d.durationText !== undefined) rows.push({ id: 'duration', label: 'Duration', value: d.durationText })
  if (d.instrumentEnhanced !== undefined) {
    rows.push({ id: 'instrument', label: 'Instrument', value: d.instrumentEnhanced })
  }
  return rows
}

/**
 * TRUE when the stat rows above describe the LINE's row rather than the rank you asked about.
 *
 * The committed DB carries a row per RANK for 121 spells and a single row per LINE for the other
 * ~1,800, so `Celestial Remedy III` is answered by `Celestial Remedy`'s mana, cast time and
 * duration. That is the best any source states - and it is a different claim from "these are rank
 * III's numbers", so the card is required to say which one it is showing. The same rule the
 * suggestion row already follows for class levels, applied to every field.
 */
export function spellFactsAreForLine(d: SpellDetail): boolean {
  if (!d.found || d.name === undefined) return false
  return d.name.trim().toLowerCase() !== d.queried.trim().toLowerCase()
}

/** The class-level line ("CLR 19 · PAL 30"), or null when the DB places the line in no class. */
export function spellClassLine(d: SpellDetail): string | null {
  if (d.classLevels.length === 0) return null
  return d.classLevels.map((c) => `${c.cls} ${String(c.level)}`).join(' · ')
}

/**
 * The words for a derived effect class. A class this map does not name renders as its own id,
 * because an unlabelled fact is still a fact and silently dropping one is how a roster goes stale
 * without anybody noticing.
 */
const EFFECT_CLASS_LABEL: Record<string, string> = {
  charm: 'charm',
  summonPet: 'summons a pet',
  mez: 'mesmerize',
  root: 'root',
  snare: 'snare',
  slow: 'slow',
  haste: 'haste',
  fear: 'fear',
  stun: 'stun',
  blind: 'blind',
  pacify: 'pacify',
  memblur: 'memory blur',
  invisibility: 'invisibility',
  feignDeath: 'feign death',
  healOverTime: 'heals over time'
}

/** The derived-roster words, in the order main listed them. Empty when nothing was derived. */
export function spellEffectClassLabels(d: SpellDetail): string[] {
  return d.effectClasses.map((c) => EFFECT_CLASS_LABEL[c] ?? c)
}

/**
 * WHAT YOUR GEAR DID TO THIS SPELL, one line per side (JOS-452). Empty when nothing you wear
 * qualifies, which is when the card draws no gear block at all.
 *
 * The percentage first because it is the answer, then the effect, then the ITEM - which is the
 * owner's ask and the reason this block exists: the readout's marker says a number and the card is
 * where you find out which piece of gear is producing it. The middle dot is the separator the rest
 * of the app already uses, and there are no em dashes anywhere near a player.
 */
export function spellFocusLines(d: SpellDetail): string[] {
  return (d.focusSources ?? []).map(
    (f) => `worn +${String(Math.round(f.pct))}% ${f.side} · ${f.effect} · ${f.item}`
  )
}

/**
 * THE LINEAGE SENTENCE, or null when no source states one.
 *
 * Three shapes, and never a fourth:
 *   * a numeral in the name and a lower rank somebody names ⇒ "Rank III · replaces Lay on Hands II"
 *   * a numeral and nothing below it              ⇒ "Rank III"
 *   * no numeral at all                           ⇒ null (the card draws no lineage block)
 * The MEMBERS are listed separately (`spellLineageMembers`) with their sources attached, so the
 * sentence never has to imply where a rank came from.
 */
export function spellLineageLine(d: SpellDetail): string | null {
  const lin = d.lineage
  if (!lin?.suffixed) return null
  const rank = `Rank ${romanOf(lin.rank)}`
  return lin.replaces === undefined ? rank : `${rank} · replaces ${lin.replaces}`
}

/** Ordinal → the numeral the game prints. Only 1..10 exist (shared/spellLines.ts RANK_VALUE). */
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X']
function romanOf(rank: number): string {
  return ROMAN[rank - 1] ?? String(rank)
}

/**
 * How a member reads on the card: its name, tagged when the ONLY thing naming it is your own log.
 *
 * A rank the DB carries needs no tag - it is the same source as every other fact on the card. A
 * rank that exists only because you cast it is a different claim ("this rank is real because you
 * used it"), and the card says which.
 */
export function spellLineageMembers(d: SpellDetail): string[] {
  const lin = d.lineage
  if (!lin) return []
  return lin.members.map((m) => (m.source === 'log' ? `${m.name} (your log)` : m.name))
}
