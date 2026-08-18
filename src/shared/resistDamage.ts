// WHAT A DAMAGE HISTOGRAM MEANS — full, partial, or unreadable (JOS-385, defect 2; refined by
// JOS-387).
//
// Pure, and split from resistModel.ts for the reason resistFormula.ts was: this is one subject
// (how to read the numbers the log printed) and the file next door is another (the likelihood over
// them), and the pair was over the repo's 400-code-line ceiling.
//
// ── THE DEFECT THIS FILE EXISTS TO FIX ──────────────────────────────────────────────────────────
//
// A direct-damage row's evidence is "how many casts landed for FULL damage and how many were
// silently reduced", and the first cut answered it with the histogram's LARGEST value: the max was
// full, everything below it was a partial. That is wrong on Live, and the owner found it on a
// thunder spirit princess.
//
// Live SPELL-DAMAGE FOCUS effects roll a RANDOM bonus per cast — the item says "increase spell
// damage by up to 34%" and the roll is uniform inside that band. So the largest value the log ever
// printed is a FOCUSED roll, not the spell's full damage, and every ordinary unfocused full hit
// sits below it and was being read as a partial. MEASURED on the owner's log, Discordant Mind's
// non-crit damage across all mobs: hundreds of hits at exactly 394 — the base — and then a spread
// of hits from 441 up to 528, which is 394 x 1.12 through 394 x 1.34. Against the princess
// specifically the row read "5 partial" where three of those five were 453, 471, 476 and 524: full
// hits with a focus roll on them.
//
// ── THE FIX, AND WHY THE BASE OF THE UPPER CLUSTER ──────────────────────────────────────────────
//
// JOS-385 answered "which value is full damage" with the MODE of the (spell, casterLevel)
// histogram pooled over every mob, and required the mode to hold `MODE_MIN_SHARE` of the
// histogram or the spell was read as variable at that level. That is right whenever the focus is
// off or weak, and it FAILS EXACTLY WHERE THE OWNER PLAYS: at caster level 50 his focus item is
// on, so Discordant Mind's base 394 holds 23 of 379 hits (6%) while the focused rolls spread
// across 441-528 in bins of ten and twenty. The mode rule then declined to name a reference at
// all, the level fell back to variable damage, and the three real princess partials (80, 165 and
// 168 against a base of 394) were thrown away with it.
//
// So the reference is THE BASE OF THE UPPER CLUSTER (owner, 2026-08-16), and the cluster is the
// FOCUS BAND the item defines: a base value v can be focused up to `FOCUS_BAND_TOP` x v and no
// further, so every full hit of the spell lies in `[v, FOCUS_BAND_TOP*v]` and every partial lies
// below v. A value v is the base of that cluster when BOTH:
//
//   1. its band holds at least `BAND_MIN_SHARE` of the (spell, level) histogram — the cluster is
//      the bulk of what the spell printed, which is what makes it the full-damage cluster rather
//      than a lump of partials; and
//   2. NOTHING INSIDE THE BAND WAS PRINTED MORE OFTEN THAN v ITSELF. The base is the one value the
//      spell can print with no roll on top of it, so it is the tallest bar in its own band by
//      construction, while each focused value gets a slice of one roll's range.
//
// The largest such v wins, and where none exists the level is read as VARIABLE damage.
//
// CONDITION 2 IS WHAT THE TICKET'S FIRST DRAFT OF THIS RULE LACKED, and the measurement is why it
// is here. "The largest v whose band covers 60%" alone answers 458 for Discordant Mind at 50 — the
// focus band is so much of that histogram that a window opened anywhere inside it still covers
// two thirds — and 458 is not a number the game ever computes. Anchoring on the tallest bar of the
// window is what picks 394 out of the same data (its band covers 84%, the most of any anchor, and
// its 23 hits beat the tallest focused bin's 22). It is also what keeps the answer at 239 rather
// than 228 for Scorching Arrow at 48, where a wider low window covers marginally more of the
// histogram by swallowing three partials.
//
// POOLED OVER EVERY MOB, deliberately, and keyed by CASTER LEVEL. What a spell hits for is a fact
// about the spell and the caster, never about the target — a mob with four observations cannot
// establish its own reference and does not have to, because the same nuke has hundreds of hits
// elsewhere in the ledger. The level is in the key because a spell's damage genuinely moves with
// it: Scorching Arrow reads 214 at level 46, 233 at 47 and 239 from 48 up, which are the game's
// own tiers and not noise.
//
// ── AND WHEN THE HISTOGRAM CANNOT SAY ───────────────────────────────────────────────────────────
//
// With no qualifying v the spell is treated as VARIABLE at that level: resist-or-not, no partial
// information at all. That is the existing law in resistModel.ts's header applied to a new case —
// misclassifying a fixed spell as variable merely throws information away, while the reverse reads
// ordinary low rolls as resistance and invents a resistant mob out of a damage range.

import type { ResistRow, SpellResistInfo } from './resistTypes'

/**
 * A hit at or above this fraction of the reference is FULL damage.
 *
 * Three percent of slack rather than an exact compare, because the server rounds and a focus can
 * only ever push a hit UP: the band this admits below the reference is narrower than the smallest
 * partial the formula can produce (a partial is at least 1.5 x (rc - roll) / rc off the top, and
 * the resist message takes over before it gets close to 3%).
 */
export const FULL_AT_LEAST = 0.97

/**
 * The top of the FOCUS BAND, as a multiple of the base: Live spell-damage focus effects roll a
 * bonus of up to 34%, so a full hit never exceeds this and a value above it is a different base.
 * One percent of headroom over 1.34 for the server's own rounding.
 */
export const FOCUS_BAND_TOP = 1.35

/**
 * The share of a (spell, level) histogram the focus band has to hold before the value anchoring it
 * is believed as the spell's full damage. Under it, the histogram is not describing one number.
 */
export const BAND_MIN_SHARE = 0.6

/**
 * A SPELL THAT NEVER PRODUCES A PARTIAL IS NOT A PARTIAL-CAPABLE SPELL, and the ledger says which
 * is which (JOS-387, found by the pinned-fit guard rather than by reasoning).
 *
 * The direct-damage model has three outcomes — full, silently reduced, and the resist message — and
 * at any rc that produces resists it also produces a great many partials. A DoT and a proc do not
 * work that way: they land or they are refused, and when they land they deal their number. Reading
 * one as direct damage asks the fitter to explain zero partials beside a 75% resist rate, which no
 * rc can do, and the answer comes out incoherent in both directions at once.
 *
 * MEASURED on the shipped baseline: of 207 (spell, caster level) histograms with 20 or more hits,
 * 50 carry essentially no partials — and they are exactly the DoTs (poison, deadly poison, sicken,
 * choking, tainted breath, strong disease) and the procs (every `… Strike`, puma maw). The 157 with
 * partials are the ordinary nukes, and their partial share runs 14% to 20%, nowhere near this line.
 * The case that found it: a thunder spirit princess's magic is 262 resists and 86 hits of Choking,
 * all at exactly 20, which reads as an all-or-nothing spell resisted three quarters of the time and
 * as an impossibility under direct damage.
 */
export const PARTIAL_FREE_AT = 0.02

/** Below this many hits, "no partials" is not a fact about the spell. */
export const PARTIAL_FREE_MIN_HITS = 20

/** What the ledger knows about one (spell, caster level)'s damage. */
export interface DamageRef {
  /** Full damage: the base of the upper cluster. */
  value: number
  /** This spell lands or is refused; its damage lines are LANDINGS. See `PARTIAL_FREE_AT`. */
  allOrNothing: boolean
}

/** The pooling key: a spell's damage is a fact about the spell and the caster, never the target. */
export function damageRefKey(spellKey: string, casterLevel: number | null): string {
  return `${spellKey}|${casterLevel ?? ''}`
}

/** value -> count, for one (spell, caster level). */
type Histogram = Map<number, number>

/**
 * The base of the upper cluster in one histogram, or undefined when nothing qualifies. See the
 * header for the two conditions and the measurement behind the second one.
 */
export function clusterBase(hist: Histogram): number | undefined {
  const values = [...hist.keys()].sort((a, b) => b - a)
  let total = 0
  for (const count of hist.values()) total += count
  if (total === 0) return undefined
  for (const v of values) {
    const own = hist.get(v) ?? 0
    const top = v * FOCUS_BAND_TOP
    let inBand = 0
    let outranked = false
    for (const [w, count] of hist) {
      if (w < v || w > top) continue
      inBand += count
      // Equal counts leave v standing: the base is the value the anchor is being tested for, and a
      // focused bin that merely ties it has not out-argued it.
      if (count > own) outranked = true
    }
    if (!outranked && inBand / total >= BAND_MIN_SHARE) return v
  }
  return undefined
}

/**
 * The full-damage reference per (spell, casterLevel), over every row handed in.
 *
 * PASS IT THE WHOLE LEDGER — `src/main/ipc/resist.ts` does, once per app run, exactly as it does
 * for the blindness verdict. Scoped to one mob it would answer from a handful of hits and would
 * find a cluster in what is really a partial band.
 */
export function fullDamageRefs(rows: readonly ResistRow[]): Map<string, DamageRef> {
  const hist = new Map<string, Histogram>()
  for (const row of rows) {
    const key = damageRefKey(row.spellKey, row.casterLevel)
    let h = hist.get(key)
    if (!h) {
      h = new Map()
      hist.set(key, h)
    }
    for (const [value, count] of Object.entries(row.dmg)) {
      const v = Number(value)
      h.set(v, (h.get(v) ?? 0) + count)
    }
  }
  const out = new Map<string, DamageRef>()
  for (const [key, h] of hist) {
    const value = clusterBase(h)
    if (value === undefined) continue
    out.set(key, { value, allOrNothing: partialFree(h, value) })
  }
  return out
}

/** Does this pooled histogram carry partials at all? See `PARTIAL_FREE_AT`. */
function partialFree(hist: Histogram, value: number): boolean {
  const floor = value * FULL_AT_LEAST
  let hits = 0
  let partial = 0
  for (const [v, count] of hist) {
    hits += count
    if (v < floor) partial += count
  }
  if (hits < PARTIAL_FREE_MIN_HITS) return false
  return partial / hits <= PARTIAL_FREE_AT
}

/** One row's damage, split against the reference. `full` counts focused hits too. */
export function splitDamage(row: ResistRow, ref: number | undefined): { total: number; full: number; partial: number } {
  let total = 0
  let full = 0
  if (ref === undefined) {
    for (const count of Object.values(row.dmg)) total += count
    return { total, full: 0, partial: 0 }
  }
  const floor = ref * FULL_AT_LEAST
  for (const [value, count] of Object.entries(row.dmg)) {
    total += count
    if (Number(value) >= floor) full += count
  }
  return { total, full, partial: total - full }
}

/**
 * Which likelihood a row's damage belongs to.
 *
 * `aon`    the spell lands or is refused and its hits are landings — a DoT or a proc. See
 *          `PARTIAL_FREE_AT` for how the ledger recognises one and why it matters.
 * `ddFix`  a partial-capable nuke with a known full-damage reference: full, partial and resist are
 *          three distinguishable outcomes and the cell is pinned from both sides.
 * `ddVar`  no partial information at all. THREE WAYS TO GET HERE, each a different thing the app
 *          does not know: the row gave up on its own histogram (`variable`, past
 *          MAX_DISTINCT_DAMAGE_VALUES), the client's spell data shows no hitpoint slot, or the
 *          pooled histogram has no focus band tall enough to anchor a reference.
 */
export function damageKind(row: ResistRow, info: SpellResistInfo, ref: DamageRef | undefined): 'aon' | 'ddFix' | 'ddVar' {
  if (row.variable) return 'ddVar'
  if (!info.hpSlot) return 'ddVar'
  if (ref === undefined) return 'ddVar'
  return ref.allOrNothing ? 'aon' : 'ddFix'
}
