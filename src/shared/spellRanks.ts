// spellRanks.ts — the OBSERVED spell rank transport, and the one sentence two surfaces print
// from it (JOS-446).
//
// WHAT THIS FILE IS. The shape of the `observedSpellRanks` module's snapshot/delta plus the two
// pure readers over it — which row answers for a display name, and what a rank chip says. It
// lives in shared/ for the reason every module transport does: main folds it, the preload types
// it, and the renderer draws it, so there is ONE definition rather than three that agree today.
// The FOLD is src/main/modules/observedSpellRanks.ts, and its header carries the evidence rules.
//
// KEYED BY THE LINE, NEVER BY THE RANK. `spellLineKey` (the shared mirror of the parser's
// `spellCanonKey`) is the join — "Shiftless Deeds IV" and "Shiftless Deeds" are one row, which is
// exactly what a chip beside a DB name needs, since the catalog spells ~1,800 of its ~1,900 lines
// with no numeral at all (shared/spellLines.ts states the measurement).

import { parseSpellRank, romanRank, spellLineKey } from './spellLines'

/** The module id, so the fold and the renderer subscription cannot disagree about the string. */
export const OBSERVED_SPELL_RANKS_MODULE_ID = 'observedSpellRanks'

/** One spell LINE and the highest rank of it this character has been observed to hold. */
export interface ObservedSpellRankRow {
  /** `spellLineKey(name)` — lowercased, roman-numeral tail stripped. */
  key: string
  /** RAW base display name, tail stripped, as the evidence spelled it ("Shiftless Deeds"). */
  name: string
  /** HIGHEST rank observed by ANY witness, 1..10. */
  rank: number
  /**
   * Highest rank proven by a MERGE line — the moment of levelling. Absent when this character
   * has never been watched merging a scroll of this line, which is the normal state for a spell
   * ranked up before the log existed.
   */
  mergedRank?: number
  /**
   * Highest rank proven by a CAST (a cast-begin or a resist naming your spell) — possession
   * rather than the moment of acquisition. Absent when the line has never been cast at a rank.
   */
  castRank?: number
  /** How many rank-suffixed merge lines we watched land on this line. */
  merges: number
  firstAt: number
  lastAt: number
}

/** kills-style map transport: the full map hydrates, the changed rows are the delta. */
export type ObservedSpellRanksSnap = Record<string, ObservedSpellRankRow>
export interface ObservedSpellRanksDelta {
  changed: ObservedSpellRanksSnap
}

/** Merge a delta's changed rows over a held map. The ONE fold both windows would ever write. */
export function applyObservedSpellRanks(
  state: ObservedSpellRanksSnap,
  delta: ObservedSpellRanksDelta
): ObservedSpellRanksSnap {
  return { ...state, ...delta.changed }
}

/**
 * The row answering for a display name, rank suffix or not, or undefined when nothing has been
 * observed. Undefined means UNKNOWN — never rank 1 (world-model law 1: an absent row is the
 * honest encoding of "no witness", and every spell in the game reads as rank 1 by default).
 */
export function observedRankRow(
  snap: ObservedSpellRanksSnap | null | undefined,
  name: string
): ObservedSpellRankRow | undefined {
  return snap?.[spellLineKey(name)]
}

/**
 * What the rank chip says: `yours: III`, or null when there is nothing observed to say.
 *
 * ONE FUNCTION FOR BOTH SURFACES (the unlock row and the spell card), because the two draw the
 * same claim in two different vocabularies — a MUI Chip and the hover card's MUI-free pill — and
 * a second copy of the wording is a second wording.
 *
 * A rank-1 observation is NOT drawn. Every spell in the game starts at rank 1, so "yours: I"
 * restates the default and would put a chip on rows that say nothing; the chip exists to report
 * an UPGRADE. The row is still kept by the fold (it is real evidence, and the next merge raises
 * it) — this is a display rule, not a modelling one.
 */
export function observedRankLabel(
  snap: ObservedSpellRanksSnap | null | undefined,
  name: string
): string | null {
  const row = observedRankRow(snap, name)
  if (!row || row.rank <= 1) return null
  return `yours: ${romanRank(row.rank)}`
}

/**
 * The rank a display name itself carries, when it carries one. Used by the surfaces to avoid
 * drawing `yours: III` beside a name that already reads `… III`: the chip is an addition to what
 * the name says, and beside a suffixed name at the same rank it is a repetition.
 */
export function nameStatesRank(name: string, row: ObservedSpellRankRow): boolean {
  const parsed = parseSpellRank(name)
  return parsed.suffixed && parsed.rank >= row.rank
}
