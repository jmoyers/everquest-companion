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
// THE WINDOW CHANGES WHAT IT IS TALKING ABOUT AT THE CAP, AND SAYS SO.
//
// Every levels number is built on stated level-bar percentages, and at max level the game stops
// stating them (`atCap`). A window whose two headline rows were permanently em-dashed would be a
// window a capped character closes — so both rows switch to the AA read together: the rate becomes
// AA/hr and the projection becomes the inferred wait for the next completion. The row LABELS
// change with them ('XP' → 'AA', 'Next level' → 'Next AA'), because a number that quietly means
// something else is worse than no number.
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
import { formatAaRate, formatDropRate, formatLevelRate } from '../lib/formatRate'

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
const AA_RATE_TITLE = 'AA completions per hour of active time - the read that keeps working at the cap.'

/** The PACE row: levels per hour, or AA per hour once the level bar stops being stated. */
function paceRow(stats: RangeStats, capped: boolean): XpOverlayRow {
  const r = split(capped ? rate(stats.aaPerHourActive, formatAaRate) : rate(stats.levelsPerHourActive, formatLevelRate))
  return {
    id: 'xp',
    row: 'xp',
    label: capped ? 'AA' : 'XP',
    value: r.value,
    unit: r.unit || (capped ? 'AA/hr' : 'lvl/hr'),
    detail: '',
    title: capped ? AA_RATE_TITLE : XP_TITLE,
    inferred: false
  }
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
  if (xpRowVisible('xp', visible)) rows.push(paceRow(stats, capped))
  if (xpRowVisible('eta', visible)) rows.push(etaRow(snap, stats, capped))
  if (xpRowVisible('motes', visible)) rows.push(...moteRows(loot, slice, stats))
  return { rows, span: activeSpanText(stats.activeMs), level: currentLevel(snap), atCap: capped }
}
