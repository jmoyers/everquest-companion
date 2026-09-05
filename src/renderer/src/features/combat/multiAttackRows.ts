// Pure, renderer-side derivations for the MULTI-ATTACK panel (JOS-37; the engine half is still
// docs/plans/attack-round-stats.md). No JSX, no MUI — a RELATIVE value import surface like
// procRows.ts and dashboardData.ts, so node tests can exercise it without the renderer's
// `@shared` alias.
//
// WHAT CHANGED, AND WHY (owner, 2026-08-06): the shipped "Rounds" readout was correct and
// unreadable — a rounds denominator, a swings-per-round split (`74 · 99 · 11 · 2`), a
// multi-percent, an `inferred` chip, riposte given/taken, rampage taken, an exclusion tally and
// a modifier list, all in one dense block. The owner's ask is the question underneath it: for
// each attack type that can multi-attack, HOW OFTEN did it double, triple, flurry.
//
// So the MATH is untouched — the engine still groups by (source, verb, target, second), still
// collapses cross-target fan-out, still splits reuse-timer lanes from dual-wieldable weapon
// verbs — and only the READING changes:
//   * one row per attack type, `24% doubled · 3% tripled` over that lane's own rounds;
//   * the denominator stays on screen, in ROUNDS, because every percentage here is over rounds
//     and a rate whose exposure is off screen is a lie (law 11's spirit);
//   * ONE marker, `est.`, on the lanes where dual wield makes a same-second second swing
//     ambiguous. That is the whole stated-vs-inferred tier, spent on a single word, per the
//     TOOLTIP AND CAVEAT DIET — the old panel spent four sentences of hover on it.
// Riposte, rampage, exclusions and the modifier tallies are NOT multi-attack and are gone from
// this view; they remain on the wire (`SourceRoundsView`) for anything that wants them.

import type { RoundLaneView, SourceRoundsView } from '@shared/combat'

/** One attack type's multi-attack reading. */
export interface MultiAttackRow {
  verb: string
  label: string
  /** Attack rounds counted for this lane — the denominator every percentage below is over. */
  rounds: number
  /** Rounds that landed exactly 2 swings, as a percentage of `rounds`. */
  doubledPct: number
  /** Exactly 3 swings. */
  tripledPct: number
  /** 4 or more swings (the engine's last bucket). 0 for almost every lane, and a 0 never draws. */
  quadPct: number
  /**
   * The lane may only be read in AGGREGATE: it is a dual-wieldable weapon verb, so a
   * same-second second swing may be an off-hand rather than a double attack. The row's single
   * `est.` marker, and the only honesty tier this view spends ink on.
   */
  estimated: boolean
  /** Bar fill: this lane's rounds as a percentage of the biggest lane's. */
  pct: number
  /** `24% doubled · 3% tripled` — the run as it is printed, so the panel and any paste agree. */
  text: string
}

/** `24% doubled · 3% tripled` — buckets that never fired are simply absent, never `0%`. */
function multiText(row: Omit<MultiAttackRow, 'text'>): string {
  const parts: string[] = []
  if (row.doubledPct > 0) parts.push(`${Math.round(row.doubledPct)}% doubled`)
  if (row.tripledPct > 0) parts.push(`${Math.round(row.tripledPct)}% tripled`)
  if (row.quadPct > 0) parts.push(`${Math.round(row.quadPct)}% quad+`)
  return parts.length === 0 ? 'never multi-attacked' : parts.join(' · ')
}

/** `buckets[i]` is "rounds with exactly i+1 swings"; the LAST bucket is 4-or-more. */
function bucketPct(l: RoundLaneView, i: number): number {
  if (l.rounds <= 0) return 0
  return ((l.buckets[i] ?? 0) / l.rounds) * 100
}

/**
 * One row per attack type, in the engine's own order (rounds desc). A lane that never opened a
 * round is dropped: `0 rounds` has no percentage to state and a row of dashes is furniture.
 */
export function multiAttackRows(r: SourceRoundsView): MultiAttackRow[] {
  // eslint-disable-next-line eqc/no-domain-munging -- JOS-459 cutover ledger item 3: no served view source answers this yet, so the renderer still derives RoundLaneView. Becomes a view descriptor when the source lands.
  const lanes = r.lanes.filter((l) => l.rounds > 0)
  const max = Math.max(1, ...lanes.map((l) => l.rounds))
  return lanes.map((l) => {
    const base = {
      verb: l.verb,
      label: l.label,
      rounds: l.rounds,
      doubledPct: bucketPct(l, 1),
      tripledPct: bucketPct(l, 2),
      quadPct: bucketPct(l, 3),
      estimated: l.confidence === 'aggregate',
      pct: (l.rounds / max) * 100
    }
    return { ...base, text: multiText(base) }
  })
}

/**
 * FLURRY, once, for the whole source — not per lane, because the engine counts it from the
 * `(Flurry)` annotation and the log never says which verb a flurried swing belonged to (law 6:
 * say what the log cannot say). Null when nothing flurried, so a character without the AA never
 * draws the line at all.
 */
export function flurryText(r: SourceRoundsView): string | null {
  if (r.flurries <= 0) return null
  return `flurry ×${r.flurries} · ${r.flurryPct.toFixed(1)}% of rounds`
}
