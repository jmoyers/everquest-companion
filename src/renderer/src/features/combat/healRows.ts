// HEALING ROWS — THE one builder every healing meter calls, and every word it prints.
//
// It is to the healing meter exactly what `petRows.meterPanel` is to the damage meter (owner
// ruling, 2026-08-04, generalized by P1/P2 of docs/plans/combat-overlay-parity.md): the Combat
// tab's Healing dimension and the two floating heal overlays render from THIS function, so a
// second answer to "what is my sustain" has nowhere left to live. Before P2 the panel had no
// healing at all and the overlay had all of it — the divergence was total rather than subtle.
//
// MUI-FREE AND JSX-FREE ON PURPOSE. The overlay is its own renderer entry (overlay.html) with no
// theme and no component library, so a shared abstraction has to be plain TS to be importable
// from both bundles. Colors, bar chrome and crumbs stay in each surface; the LEVELS, the
// RANKING and the WORDS are here.
//
// THE STRINGS ARE PART OF THE SHARED SEAM, not a convenience. Every honesty rule the healing UI
// keeps — "absorption is GRANTED, not consumed", "a rune has no overheal and one is never
// invented for it", "overheal is a FLOOR summed only from the lines that carried the raw
// amount" — is a sentence, and two surfaces phrasing them differently is exactly how one of
// them ends up saying something the log cannot support. One phrasing, two renderers.
//
// HOW DEEP THE DRILL GOES, AND WHY IT STOPS THERE. The model has exactly two levels:
//   1  the ranked HEALERS of you and your pets (`HealingView.healers`)
//   2  ONE healer's flat lane list (`HealSourceView.spells`) — heal spells and the absorption
//      lane together, ranked by amount, told apart by `classification`.
// There is no third level and this file invents none. `HealSpellView` has no children: a heal
// line names a spell and an amount, and per-target or per-tick splits are not in the log at all
// (HoT ticks are byte-identical to direct heals — see the model header in shared/combat.ts).
// The damage meter's extra depth comes from a category rollup healing simply does not have.

import type {
  HealSourceView,
  HealSpellView,
  HealingView,
  MitigationView
} from '@shared/combat'
import { formatNum as fmt, formatHealRate } from '../../lib/formatRate'

/** The one honest line about the assumption, surfaced on hover (never as a caption). */
export const ABSORB_NOTE =
  'The log records absorption GRANTED, not consumed - counted here as effective sustain.'

/** The same service for the other thing the log will not say (JOS-86). It is the WHOLE reason
 *  an 'unstated' lane exists, so it is never abbreviated at either surface. */
export const UNSTATED_NOTE =
  'The log announces this heal without an amount, so it is counted but never added to any total.'

/**
 * The lane's tag, in the user's words rather than ours (JOS-106).
 *
 * It read 'unvalued' at the row and 'amount not stated' in the bar, and a v0.12.0 user filed the
 * by-design label as a BUG within a day (report 01KZGFH4QDTVG7XNW4G24TZYR4). Both words describe
 * what the app did to the number; neither says the game never printed one. This says the plain
 * thing, short enough to sit inline beside the lane name like `·absorbed` does.
 */
export const UNSTATED_AMOUNT = 'no amount'

const pct = (n: number): string => `${Math.round(n)}%`

/** `{min} - {max}`, collapsed to a single figure when every tick was the same size. */
export function healRange(min: number | undefined, max: number): string {
  const lo = min ?? 0
  return lo !== max ? `${fmt(lo)} - ${fmt(max)}` : fmt(max)
}

/** The absorption lane, told apart by its CLASSIFICATION — never by where it sits in the list. */
export function isAbsorbLane(r: { classification: string }): boolean {
  return r.classification === 'absorbed'
}

/** An amount-less heal lane (Mend). Same rule: the CLASSIFICATION identifies it, never the name
 *  — a lane called 'Mend' with a real number would be a different thing entirely. */
export function isUnstatedLane(r: { classification: string }): boolean {
  return r.classification === 'unstated'
}

/** True when the amount-less absorption families have anything to say. */
export function hasAbsorbCounts(mit: MitigationView | null | undefined): boolean {
  return !!mit && (mit.absorbedSwings > 0 || mit.absorbedDamageShields > 0)
}

/**
 * The mark that stands where a number would go when the log never printed one (JOS-86).
 *
 * It exists because `fmt(0)` is the string '0', and on an 'unstated' lane 0 is not the amount —
 * it is the ABSENCE of one. A bar whose right end reads "0" says Mend healed you for nothing,
 * which is the single wrong reading this whole classification was added to prevent.
 */
export const NO_AMOUNT_MARK = '-'

/** What goes at the RIGHT end of a LANE bar. One answer, so the panel and the overlay cannot
 *  disagree about which lanes have a number. */
export function laneAmount(s: HealSpellView): string {
  return isUnstatedLane(s) ? NO_AMOUNT_MARK : fmt(s.total)
}

/** What goes at the right end of a HEALER row: its rate and its total — unless the row has no
 *  valued sustain at all and exists only to carry unvalued lanes, in which case "0/s · 0" would
 *  be the same wrong reading one level up. */
export function healerAmount(h: HealSourceView): string {
  if (h.total === 0 && h.unstatedCount > 0) return NO_AMOUNT_MARK
  return `${formatHealRate(h.hps)} · ${fmt(h.total)}`
}

/** Overheal as a share of RAW healing. 0 when nothing was recorded — never NaN, never invented. */
function overhealPct(total: number, overheal: number): number {
  return total + overheal > 0 ? (overheal / (total + overheal)) * 100 : 0
}

/**
 * The per-lane stat run, embedded INSIDE the bar after the name — the same form the damage
 * meters use (`12% miss · 3 - 145dmg`), carrying the stats healing actually has:
 *   `18% over · 4 - 472`
 * Density comes from carrying FEWER stats, never from compressing labels. The row TOTAL is not
 * here — it owns the right end of the bar. Full, labeled figures live in the hover title.
 */
export function spellStat(s: HealSpellView): string {
  // An absorption lane has no overheal and no crits by construction — showing "0% over" would
  // imply the log measured something it never records.
  if (isAbsorbLane(s)) return `${s.count}x · ${healRange(s.min, s.max)} granted`
  // …and an unstated lane has no NUMBER at all. `healRange` would print "0" here, which is the
  // one reading the log cannot support, so the count is the whole stat run. The reason sits one
  // element to the left, in the `·no amount` tag both surfaces render from UNSTATED_AMOUNT —
  // saying it twice on one row is what made the old wording read as an error message.
  if (isUnstatedLane(s)) return `${s.count}x`
  const parts: string[] = []
  if (s.overheal > 0) parts.push(`${pct(overhealPct(s.total, s.overheal))} over`)
  parts.push(healRange(s.min, s.max))
  return parts.join(' · ')
}

/** One lane's full, labeled figures — the hover title behind the terse stat run above. */
export function spellTitle(s: HealSpellView): string {
  if (isAbsorbLane(s)) {
    return `${s.name} (absorbed) - ${fmt(s.total)} absorption granted over ${s.count} runes · range ${healRange(s.min, s.max)}. ${ABSORB_NOTE}`
  }
  // No average, no range, no "0 effective" — every one of those would be a figure derived from a
  // number the game never printed. The count and the reason are the whole truth available.
  if (isUnstatedLane(s)) {
    return `${s.name} (${UNSTATED_AMOUNT}) - used ${s.count}x. ${UNSTATED_NOTE}`
  }
  const bits = [
    `${fmt(s.total)} effective`,
    `${s.count} ticks`,
    `avg ${fmt(Math.round(s.total / Math.max(1, s.count)))}`
  ]
  if (s.crits > 0) bits.push(`${s.crits} crits (${pct((s.crits / Math.max(1, s.count)) * 100)})`)
  if (s.overheal > 0) {
    bits.push(`${fmt(s.overheal)} overheal (${pct(overhealPct(s.total, s.overheal))} of raw)`)
    if (s.fullOverheal > 0) bits.push(`${s.fullOverheal} landed on a full health bar`)
  } else {
    bits.push('no overheal recorded')
  }
  bits.push((s.min ?? 0) !== s.max ? `range ${healRange(s.min, s.max)}` : `always ${fmt(s.max)}`)
  const note = s.name === 'Unspecified' ? ' - the log named no spell on these lines' : ''
  return `${s.name}${note} - ${bits.join(' · ')}`
}

/**
 * A healer row's stat run. A row can be MIXED (your own row carries both your heals and your
 * rune absorption), so the stats describe its RESTORED half and the absorbed share is called out
 * separately — never averaged in as if it were a heal (world-model law 5).
 */
export function healerStat(h: HealSourceView): string {
  const parts = h.count > 0 ? [`${h.count}x`] : []
  if (h.crits > 0) parts.push(`${pct(h.critPct)} crit`)
  if (h.overheal > 0) parts.push(`${pct(h.overhealPct)} over`)
  if (h.absorbedTotal > 0) parts.push(`${fmt(h.absorbedTotal)} absorbed`)
  // Stated as a COUNT with its own word, never merged into the `Nx` above — that figure is the
  // denominator of every rate beside it. Without this a row whose only sustain was Mend reads as
  // a bare "You" with nothing after it, which is how the report that started JOS-86 read.
  if (h.unstatedCount > 0) parts.push(`${h.unstatedCount}x ${UNSTATED_AMOUNT}`)
  return parts.join(' · ')
}

/** One healer's full, labeled figures — and the one place the absorption assumption is stated. */
export function healerTitle(h: HealSourceView): string {
  const restored = h.total - h.absorbedTotal
  const bits = [`${fmt(restored)} restored`, `${h.count} heals`]
  if (h.crits > 0) bits.push(`${h.crits} crits (${pct(h.critPct)})`)
  if (h.overheal > 0) {
    bits.push(`${fmt(h.overheal)} overheal (${pct(h.overhealPct)} of raw)`)
    if (h.fullOverheal > 0) bits.push(`${h.fullOverheal} fully wasted`)
  } else if (h.count > 0) {
    bits.push('no overheal recorded')
  }
  if (h.count > 0) {
    bits.push((h.min ?? 0) !== h.max ? `range ${healRange(h.min, h.max)}` : `always ${fmt(h.max)}`)
  }
  if (h.absorbedTotal > 0) bits.push(`+ ${fmt(h.absorbedTotal)} absorbed. ${ABSORB_NOTE}`)
  if (h.unstatedCount > 0) bits.push(`+ ${h.unstatedCount} unvalued. ${UNSTATED_NOTE}`)
  return `${h.name} - ${bits.join(' · ')}`
}

/** The headline rate's hover title: the restored/absorbed split when there is one. */
export function healTotalTitle(healing: HealingView | undefined): string {
  if (!healing) return ''
  return healing.absorbedTotal > 0
    ? `${fmt(healing.total)} total · ${fmt(healing.restoredTotal)} restored + ${fmt(healing.absorbedTotal)} absorbed. ${ABSORB_NOTE}`
    : `${fmt(healing.total)} healing restored`
}

/**
 * WHAT ONE HEALING METER IS SHOWING — the whole answer, for every surface that shows one.
 *
 * Level 1 is the ranked healer list plus the two things that ride under it: the COUNT-ONLY
 * absorption families (no amount exists in the log, so they are never a bar and enter no total)
 * and the counter-healing annotation (healing that landed on mobs you were engaged with — an
 * annotation on your damage, not part of your sustain, so it never enters the ranking).
 *
 * Level 2 is ONE healer's flat lane list. That is the bottom (see the header).
 *
 * A drill id that resolves to nothing — a healer from a past fight, a 'heal:<key>' the current
 * segment never saw — yields LEVEL 1 for this render. The caller's stored value is never
 * touched, so the drill re-applies the moment that healer is back. Same rule, same words, as
 * `petRows.meterPanel`.
 */
export type HealPanel =
  | {
      level: 1
      /** every healer in the segment, ranked — no caller caps this list. */
      healers: HealSourceView[]
      /** true when the segment has a healing model but nothing to rank in it. */
      empty: boolean
      mitigation: MitigationView | null
      /** counter-healing: the total and the healers behind it, for the one honest line. */
      enemy: { total: number; healers: HealSourceView[] }
    }
  | {
      level: 2
      subject: HealSourceView
      /** ONE flat ranked list: heal lanes and the absorption lane together, biggest first. */
      rows: HealSpellView[]
    }

/**
 * THE ROW BUILDER. Both healing meters call exactly this, with exactly their own drill id: the
 * Combat tab passes `drill.kind === 'entity' ? drill.entityId : null`, the overlays pass their
 * persisted `drill?.entityId ?? null`. Everything downstream — the levels, what rides under
 * level 1, the stale-id fallback — is decided here, once.
 *
 * EVERY healer comes back. The overlay used to pass a row budget (top 5 / top 10) and cap this
 * list; that budget was retired on 2026-08-05 and its scroll pane replaced it, so there is no
 * caller left that wants fewer rows than exist.
 */
export function healPanel(healing: HealingView | undefined, entityId: string | null): HealPanel {
  const healers = healing?.healers ?? []
  const subject = entityId === null ? undefined : healers.find((h) => h.id === entityId)
  if (subject) return { level: 2, subject, rows: subject.spells }
  return {
    level: 1,
    healers,
    empty: healers.length === 0,
    mitigation: healing?.mitigation ?? null,
    enemy: { total: healing?.enemyTotal ?? 0, healers: healing?.enemyHealers ?? [] }
  }
}
