// xpRows.ts — the PURE shaping behind the XP overlay (JOS-195): a progression snapshot, this
// character's loot, and one slice, turned into the exact strings that window prints.
//
// No React, no MUI, no `window.eqOverlay`. VALUE imports are RELATIVE, never `@shared/*` — that
// alias exists only inside the vite build and the node runner would not resolve it — so
// tests/xpOverlay.test.mts drives every rule here under plain tsx. Same constraint
// aaPaceRows.ts / rangeStatsRows.ts / overviewLevelingData.ts already document.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// IT DERIVES NOTHING OF ITS OWN. Every number below already exists somewhere:
//
//   the pace      `rangeStats` (shared/progressionStats.ts) — the drag-select panel's own query
//   the slice     `resolveSlice` (shared/timeslice.ts) — the Leveling tab's own control, JOS-130
//   the level ETA `levelEta` (shared/levelEta.ts) — the Overview card's own four gates
//   the AA read   `aaEta` (shared/aaPace.ts) — JOS-36/11, the read that survives the cap
//   the motes     `moteRates` → `windowItemRows` (shared/lootRates.ts) — JOS-78's own rate
//
// So a number in this window and the same number on the Leveling tab cannot disagree: there is
// one arithmetic and this file only chooses the words. That is the whole point of the ticket's
// "fed from the same selectors the Leveling tab uses".
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// AA IS A SECOND PACE, NOT A CONSOLATION PRIZE FOR THE CAP (JOS-202).
//
// The first cut swapped the pace row's SUBJECT at the cap: levels while the bar was stated, AA once
// it was not. That is the wrong shape, because the two are not alternatives — a character in their
// forties is filling a level bar and an AA bar at the same time, and the owner wants both read at a
// glance. So the pace checklist entry draws ONE ROW PER MEASURE THE LOG STATES, exactly as the
// motes entry draws one row per tier observed:
//
//   'xp'  levels of progress per hour — while the game is still stating a level-bar percentage.
//   'aa'  AA completions per hour, with the ability points they paid riding as the row's detail.
//
// WHEN EACH ONE IS THERE, and why:
//   · the levels row goes away AT THE CAP (`atCap`) and only there — every levels number is built
//     on stated percentages, and at max level the game stops stating them. A permanent em-dash is
//     a row a capped character closes the window over.
//   · the AA row appears whenever the SLICE HOLDS A COMPLETION — which is `aaRateText`'s own rule
//     on the Leveling tab ("a character earning no AA is told nothing about AA", law 1), quoted
//     rather than re-decided here — and unconditionally at the cap, where it is the only pace read
//     left and a window with no pace row at all would be worse than one reading 0.00.
//
// The two rates are the same denominator (active time, stated once under the rows), so they read
// against each other, and the AA pair (completions · points) is printed together for the reason the
// Leveling tab prints it together: they are equal until an item-shop bottle is running and diverge
// while one is, and that divergence is the whole reading.
//
// The PROJECTION row still switches: 'Next level' while there is a bar to finish, 'Next AA' once
// there is not. It is one row and one question ("what lands next"), and at the cap the level half
// of it has no answer at all.
//
// THE AA WAIT IS INFERRED AND WEARS THE WORD (`AA_EST`). The log carries no AA-experience line
// anywhere — there is no bar position to sum — so it is projected from the rhythm of recent
// completions. The level ETA is a different kind of claim (a sum of stated percentages divided by
// a measured pace) and does not wear it; both are still `~`.

import type { LootEvent, ProgressionSnap } from '@shared/types'
import type { RangeStats } from '@shared/progressionStats'
import type { Timeslice } from '@shared/timeslice'
import { rangeStats } from '../../../shared/progressionStats'
import { ETA_ABSURD_MS, ETA_BLOCKED_TITLE, atCap, currentLevel, levelEta } from '../../../shared/levelEta'
import { aaEta } from '../../../shared/aaPace'
import { moteRates, xpRowVisible, type XpRowId } from '../../../shared/xpOverlay'
import { AA_EST, AA_ETA_BLOCKED_TITLE, aaEtaValue } from '../features/leveling/aaPaceRows'
import { NONE, activeSpanText } from '../features/leveling/rangeStatsRows'
import { fmtDuration } from '../features/leveling/levelChartGeometry'
import { formatAaRate, formatDropRate, formatLevelRate, formatPointRate } from '../lib/formatRate'

/** One printed row: a label, a number, its unit, and a dim trailing detail. */
export interface XpOverlayRow {
  /** stable id — the React key and the e2e's handle (`xp-row-<id>`). */
  id: string
  /** which checklist entry switches this row off (shared/xpOverlay.ts). */
  row: XpRowId
  label: string
  /** the number itself, or the em-dash. Never '0' for something unknown. */
  value: string
  /** small suffix on the value's baseline; '' when the value stands alone. */
  unit: string
  /** dim trailing context — 'to 44', '12×'. '' when there is none. */
  detail: string
  /** One clause: what this row measures, or why it cannot be measured. */
  title: string
  /** true ⇒ the row wears `AA_EST`. Only ever the AA wait — see the header. */
  inferred: boolean
}

export interface XpOverlayView {
  rows: XpOverlayRow[]
  /**
   * 'over 42m active' — ONE span for the whole window, stated once rather than repeated on every
   * row (the WindowDropsPanel rule). A rate that never stated its span lets one drop in five
   * minutes read as a confident 12/hr.
   */
  span: string
  /** The level the log last reported, or null (the header chip is omitted). */
  level: number | null
  /** The slice gained experience the log stated no percentage for — this window speaks AA. */
  atCap: boolean
}

/** '1.42 lvl/hr' → `{ value: '1.42', unit: 'lvl/hr' }`; '—' → `{ value: '—', unit: '' }`. The
 *  aaPaceRows split, applied to the same rate vocabulary. */
function split(s: string): { value: string; unit: string } {
  const i = s.indexOf(' ')
  return i < 0 ? { value: s, unit: '' } : { value: s.slice(0, i), unit: s.slice(i + 1) }
}

/** A rate, or the em-dash. Null is "the log did not state it", never zero. */
function rate(n: number | null, fmt: (v: number) => string): string {
  return n == null ? NONE : fmt(n)
}

const XP_TITLE =
  'Levels of progress per hour of active time. The log states a percentage of the current level bar, never experience points.'
const AA_RATE_TITLE =
  'AA completions per hour of active time, and the ability points they paid - the read that keeps working at the cap.'

/** The LEVELS pace. Drawn while the game is still stating a level-bar percentage; see the header
 *  for why it is absent at the cap rather than an em-dash. */
function levelsRow(stats: RangeStats): XpOverlayRow {
  const r = split(rate(stats.levelsPerHourActive, formatLevelRate))
  return {
    id: 'xp',
    row: 'xp',
    label: 'XP',
    value: r.value,
    unit: r.unit || 'lvl/hr',
    detail: '',
    title: XP_TITLE,
    inferred: false
  }
}

/**
 * The AA pace — completions per hour, with the points those completions paid as the row's detail.
 *
 * BOTH NUMBERS ARE THE LEVELING TAB'S (`aaPerHourActive` / `aaPointsPerHourActive`, the pair
 * `aaRateText` prints in one chip), in the tab's own spellings. Nothing is divided here.
 * The detail is empty rather than an em-dash when the slice has no active time to divide by: a
 * dim trailing '-' beside a value that is already an em-dash says the same nothing twice.
 */
function aaRow(stats: RangeStats): XpOverlayRow {
  const r = split(rate(stats.aaPerHourActive, formatAaRate))
  return {
    id: 'aa',
    row: 'xp',
    label: 'AA',
    value: r.value,
    unit: r.unit || 'AA/hr',
    detail: stats.aaPointsPerHourActive == null ? '' : formatPointRate(stats.aaPointsPerHourActive),
    title: AA_RATE_TITLE,
    inferred: false
  }
}

/**
 * The PACE rows — one per measure the log is stating (JOS-202). The order is levels then AA: the
 * bar you are watching first, the bar you are also filling second, and at the cap only the second
 * one exists.
 */
function paceRows(stats: RangeStats, capped: boolean): XpOverlayRow[] {
  const rows: XpOverlayRow[] = []
  if (!capped) rows.push(levelsRow(stats))
  // The Leveling tab's rule (`aaRateText`) for a window holding no completion at all: say nothing
  // about AA rather than print a row of em-dashes. At the cap it is the only pace read there is.
  if (capped || stats.aaGainEvents > 0) rows.push(aaRow(stats))
  return rows
}

/** The AA half of the projection row — inferred, and labelled so (see the header). */
function aaWaitRow(snap: ProgressionSnap, stats: RangeStats): XpOverlayRow {
  const n = snap.aaGainTs.length
  // The anchor is the LOG'S last completion measured against the LOG'S clock — `aaGainTs` is one
  // of the snapshot's uncapped columns, so its tail is always the real last one, and `lastTs` is
  // never `Date.now()` (this window is read while alt-tabbed out of a game that is not running).
  const eta = aaEta(stats, n > 0 ? snap.aaGainTs[n - 1] : null, snap, snap.lastTs)
  const value = aaEtaValue(eta)
  return {
    id: 'eta',
    row: 'eta',
    label: 'Next AA',
    value: value ?? NONE,
    unit: '',
    detail: value === null ? '' : AA_EST,
    title: eta.blocked === null ? 'Projected from the rhythm of recent completions.' : AA_ETA_BLOCKED_TITLE[eta.blocked],
    inferred: true
  }
}

/**
 * The PROJECTION row: time to the next level, or (at cap) the wait for the next AA.
 *
 * A blocked estimate is an em-dash WITH ITS REASON on hover — never a number, and never a silence:
 * on a window this small "why is that blank" is the question a blank invites, and the reason is one
 * clause (`ETA_BLOCKED_TITLE`, shared with the Overview card so the two refuse in the same words).
 */
function etaRow(snap: ProgressionSnap, stats: RangeStats, capped: boolean): XpOverlayRow {
  if (capped) return aaWaitRow(snap, stats)
  const eta = levelEta(snap, stats)
  if (eta.blocked !== null) {
    return {
      id: 'eta',
      row: 'eta',
      label: 'Next level',
      value: NONE,
      unit: '',
      detail: '',
      title: ETA_BLOCKED_TITLE[eta.blocked],
      inferred: false
    }
  }
  // Past a day the estimate is a HORIZON rather than a duration — the Overview card's own rule,
  // spelled for a two-column row instead of a sentence.
  const absurd = eta.ms > ETA_ABSURD_MS
  return {
    id: 'eta',
    row: 'eta',
    label: 'Next level',
    value: absurd ? '>1 day' : `~${fmtDuration(eta.ms)}`,
    unit: '',
    detail: `to ${eta.toLevel}`,
    title:
      `${Math.round(eta.progress * 100)}% of level ${eta.toLevel - 1} stated since your last level-up, ` +
      `projected at this stretch's pace.`,
    inferred: false
  }
}

/**
 * The MOTE rows — one per type observed, most-looted first.
 *
 * THE ORDER IS THE OBSERVATION (shared/xpOverlay.ts states the whole argument): nothing in this
 * repo ranks the ten tiers, so the row at the top is the one that dropped most and never the one
 * anything here thinks is best.
 *
 * A slice with no mote gets ONE row saying so rather than nothing at all: a silently missing
 * section reads as a broken window, and "none here" is a measurement over a span the caption
 * beside it already states.
 */
function moteRows(loot: readonly LootEvent[], slice: Timeslice, stats: RangeStats): XpOverlayRow[] {
  const rows = moteRates({
    events: loot,
    t0: slice.range.t0,
    t1: slice.range.t1,
    // BOTH halves of the slice (JOS-130). `activeMs` is already the zone's own active time when
    // the slice carries a zone, so counting every zone's drops against it would put a rate under
    // a denominator it was never measured over.
    activeMs: stats.activeMs,
    zoneKey: slice.zoneKey
  })
  if (rows.length === 0) {
    return [
      {
        id: 'motes-none',
        row: 'motes',
        label: 'Motes',
        value: NONE,
        unit: '',
        detail: 'none here',
        title: `No upgrade mote has dropped in ${slice.caption}.`,
        inferred: false
      }
    ]
  }
  return rows.map((m) => {
    const r = split(rate(m.perHourActive, formatDropRate))
    return {
      id: `mote-${m.key}`,
      row: 'motes' as const,
      label: m.tier,
      value: r.value,
      unit: r.unit || 'drops/hr',
      detail: `${m.drops.toLocaleString()}×`,
      title: `${m.item} - ${m.drops.toLocaleString()} looted in ${slice.caption}.`,
      inferred: false
    }
  })
}

export interface XpRowsArgs {
  snap: ProgressionSnap
  /** Every loot event this character has, oldest first (the `loot` module's snapshot). */
  loot: readonly LootEvent[]
  /** The slice in force — range, zone filter and wording, travelling as one object. */
  slice: Timeslice
  /** The user's row checklist. `undefined` ⇒ every row (shared/xpOverlay.ts). */
  visible: XpRowId[] | undefined
}

/**
 * The whole window, from one snapshot and one slice. EXACTLY ONE `rangeStats` call: the pace row,
 * the projection and the motes' denominator all read the same object, so nothing on screen can be
 * measured over a different stretch than the caption claims.
 */
export function xpOverlayView(args: XpRowsArgs): XpOverlayView {
  const { snap, loot, slice, visible } = args
  const stats = rangeStats({ snap, range: slice.range, zoneKey: slice.zoneKey })
  const capped = atCap(stats)
  const rows: XpOverlayRow[] = []
  if (xpRowVisible('xp', visible)) rows.push(...paceRows(stats, capped))
  if (xpRowVisible('eta', visible)) rows.push(etaRow(snap, stats, capped))
  if (xpRowVisible('motes', visible)) rows.push(...moteRows(loot, slice, stats))
  return { rows, span: activeSpanText(stats.activeMs), level: currentLevel(snap), atCap: capped }
}
