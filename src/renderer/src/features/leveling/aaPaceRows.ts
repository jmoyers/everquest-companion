// aaPaceRows.ts — the PURE shaping behind AaPacePanel: an `AaPace` (the answer
// `shared/aaPace.ts` computed) turned into the exact strings the panel prints. No React, no
// MUI, and only TYPE imports from `@shared`, so tests/aaPace.test.mts drives it under tsx —
// the same constraint rangeStatsRows.ts / zoneBands.ts document.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: which numbers are MEASURED and which are MODELLED is
// visible on the panel, not buried in a doc. Two of the four tiles are counts the game printed;
// two are a model over them. So every shaped value carries an `inferred` flag — and the CHIP the
// panel draws from it is the whole disclosure (AGENTS.md tooltip diet: one word beats a
// paragraph). The hover sentences here name what a tile measures, never how it might be wrong.

import type { AaEta, AaEtaBlocked, AaPace, AaPotionState } from '@shared/aaPace'
import type { RangeStats } from '@shared/progressionStats'
import { AA_POTION_CHARGES } from '../../../../shared/aaPace'
import { NONE, aaRateText, activeSpanText } from './rangeStatsRows'
import { fmtDuration } from './levelChartGeometry'
import { formatAaRate, formatPointRate } from '../../lib/formatRate'

/** One tile: a big number, the words under it, whether it is a model, and the hover sentence. */
export interface AaPaceTile {
  /** stable id — the render key and the e2e's handle (`leveling-aa-tile-<id>`). */
  id: 'rate' | 'points' | 'eta' | 'potion'
  value: string
  /** small suffix on the value's baseline; '' when the value stands alone. */
  unit: string
  label: string
  /** true ⇒ the panel chips it `inferred`. The two rate tiles are never inferred. */
  inferred: boolean
  /** One clause: what this tile measures. Never a caveat — the `inferred` chip carries that. */
  title: string
}

/** '2.40 AA/hr' → `{ value: '2.40', unit: 'AA/hr' }`; '—' → `{ value: '—', unit: '' }`. */
function split(s: string): { value: string; unit: string } {
  const i = s.indexOf(' ')
  return i < 0 ? { value: s, unit: '' } : { value: s.slice(0, i), unit: s.slice(i + 1) }
}

/** A rate, or the em-dash. Null means "no active time in the window", never "zero AA". */
function rate(n: number | null, fmt: (v: number) => string): string {
  return n == null ? NONE : fmt(n)
}

const RATE_TITLE = 'AA completions per hour of active time.'

const POINTS_TITLE = 'Ability points per hour of active time.'

/** The reason there is no estimate — one clause per `AaEtaBlocked`. Exported since JOS-195: the
 *  XP overlay refuses the same estimate for the same two reasons and must say the same words. */
export const AA_ETA_BLOCKED_TITLE: Record<AaEtaBlocked, string> = {
  'no-pace': 'Fewer than two AA completions here, so there is no gap to project forward.',
  stale: 'The last completion is far older than this window’s rhythm between them.'
}

/** The estimate's tooltip: the two numbers it is made of, nothing else. */
function etaTitle(meanIntervalMs: number, samples: number, sinceLastMs: number, overdue: boolean): string {
  const base = `Mean gap over ${samples} completions (${fmtDuration(meanIntervalMs)}), minus the ${fmtDuration(sinceLastMs)} already waited.`
  return overdue ? `${base} Already past that gap.` : base
}

/**
 * The WAIT, as a bare value: 'due', or '~12m'. Null when the estimate is blocked.
 *
 * Exported since JOS-195, because the XP overlay prints the same wait in a two-column row and a
 * second spelling of `'~' + fmtDuration(ms)` is exactly how two surfaces come to round the same
 * estimate differently. The REASON for a refusal stays with the surfaces that have room for it
 * (`etaTile` below, and `aaNextText`'s deliberate silence); this is only the number.
 */
export function aaEtaValue(eta: AaEta): string | null {
  if (eta.blocked !== null) return null
  return eta.overdue ? 'due' : `~${fmtDuration(eta.ms)}`
}

function etaTile(eta: AaPace['eta']): AaPaceTile {
  if (eta.blocked !== null) {
    return {
      id: 'eta',
      value: NONE,
      unit: '',
      label: 'to next AA',
      inferred: true,
      title: AA_ETA_BLOCKED_TITLE[eta.blocked]
    }
  }
  return {
    id: 'eta',
    value: aaEtaValue(eta) ?? NONE,
    unit: '',
    label: 'to next AA',
    inferred: true,
    title: etaTitle(eta.meanIntervalMs, eta.samples, eta.sinceLastMs, eta.overdue)
  }
}

/** The potion tile's tooltip: the rule, and what this bottle has paid so far. */
export function potionTitle(potion: AaPotionState): string {
  const paid = potion.burnedPoints.length > 0 ? ` Paid so far: ${potion.burnedPoints.join(', ')}.` : ''
  return `Each completion since the quaff burns a charge.${paid}`
}

/** The potion tile, or none at all — a character who has never quaffed one is told nothing. */
function potionTile(potion: AaPotionState): AaPaceTile[] {
  if (potion.activations === 0) return []
  return [
    {
      id: 'potion',
      value: String(potion.charges),
      unit: `of ${String(AA_POTION_CHARGES)}`,
      label: 'potion charges',
      inferred: true,
      title: potionTitle(potion)
    }
  ]
}

/**
 * The tile row: AA/hr · points/hr · next AA · potion charges. Three tiles is the floor (the
 * rates and the estimate always have an answer, even if it is an em-dash with a reason) and
 * four the cap, which is exactly what one row holds at every width this panel is given.
 */
export function aaPaceTiles(pace: AaPace): AaPaceTile[] {
  const r = split(rate(pace.perHourActive, formatAaRate))
  const p = split(rate(pace.pointsPerHourActive, formatPointRate))
  return [
    { id: 'rate', value: r.value, unit: r.unit || 'AA/hr', label: 'this window', inferred: false, title: RATE_TITLE },
    {
      id: 'points',
      value: p.value,
      unit: p.unit || 'pts/hr',
      label: 'points earned',
      inferred: false,
      title: POINTS_TITLE
    },
    etaTile(pace.eta),
    ...potionTile(pace.potion)
  ]
}

/**
 * The panel's one-line summary of the window: what was counted and how much play it is over, so
 * a rate reading 0.00 cannot be mistaken for a bug — and so a rate over a scale the character
 * barely played states its own sample size. Counts and a span, never rates: the tiles above own
 * those, and `activeSpanText` is the range panel's own wording rather than a second one (JOS-75).
 */
export function aaPaceCaption(pace: AaPace): string {
  const span = activeSpanText(pace.activeMs)
  const n = pace.events
  if (n === 0) return `no AA completions ${span}`
  return `${n} completion${n === 1 ? '' : 's'} · ${pace.points} point${pace.points === 1 ? '' : 's'} · ${span}`
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// THE COMPACT READ — the same numbers on a surface that has one line, not a tile row
// ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * The one word an INFERRED number wears on a caption line.
 *
 * The tiles above can afford a chip; a line under a glance card cannot, and the UI conventions
 * are explicit that when stated-vs-inferred genuinely matters, one word beats a caveat. This is
 * that word.
 */
export const AA_EST = 'est.'

/**
 * 'next in ~12m est.' / 'next due est.', or NULL when the window states no rhythm to project
 * from.
 *
 * Absent, never an em-dash with a reason attached: on a compact line a refusal would spend more
 * words explaining itself than the answer would have taken, and `etaTile` above already carries
 * the refusal and its reason for the surface that has room for it.
 */
export function aaNextText(eta: AaEta): string | null {
  if (eta.blocked !== null) return null
  return eta.overdue ? `next due ${AA_EST}` : `next in ~${fmtDuration(eta.ms)} ${AA_EST}`
}

/**
 * The whole AA pace read in one line: '2.40 AA/hr · 4.80 pts/hr · next in ~12m est.'.
 *
 * The rates are `aaRateText`'s — the Leveling tab's own spelling of them, reused rather than
 * re-worded, so the glance and the tab can never describe the same hour differently. Null when
 * the window holds no completion at all: a character earning no AA is told nothing about AA
 * (law 1), never a row of em-dashes.
 *
 * THE RATES LEAD AND THE ESTIMATE TRAILS, so the two rates stay ADJACENT. They are printed
 * together on purpose — they are equal until an item-shop bottle is running and diverge while
 * one is, and that divergence is the entire reading; an estimate wedged between them would
 * break the comparison the pair exists to offer.
 */
export function aaPaceLine(stats: RangeStats, eta: AaEta): string | null {
  const rates = aaRateText(stats)
  if (rates === null) return null
  const next = aaNextText(eta)
  return next === null ? rates : `${rates} · ${next}`
}

/**
 * The potion chip's own line: how many bottles the log has seen, and where this one stands.
 * Null when the character has never quaffed one — no potion word appears anywhere then.
 */
export function potionText(potion: AaPotionState): string | null {
  if (potion.activations === 0) return null
  if (potion.charges === 0) return `no potion charges left · ${potion.activations} quaffed`
  return `${potion.charges} of ${AA_POTION_CHARGES} charges · ${potion.activations} quaffed`
}
