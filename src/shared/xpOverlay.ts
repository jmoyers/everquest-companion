// xpOverlay.ts — WHAT THE XP OVERLAY IS ALLOWED TO SHOW, and the one derivation it owns (JOS-195).
//
// The overlay's numbers are not new: the pace comes from `rangeStats`, the projection from
// `levelEta`, the AA read from `aaPace`, the drop rates from `lootRates.windowItemRows`, and the
// stretch they all cover from `timeslice`. Everything in this file is therefore either (a) the
// small amount of NEW knowledge — which items are motes, and which rows a user has switched off —
// or (b) a filter over an existing answer. Nothing here divides anything by anything.
//
// Pure: no React, no DOM, no Electron, no clock read. The one VALUE import is relative
// (`./lootRates`) — the repo-wide rule that lets tests/xpOverlay.test.mts import this straight
// under tsx.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// THE CONFIGURABILITY IS A ROW CHECKLIST AND NOTHING ELSE (owner scope, JOS-195). There is no
// widget builder here and no per-row arithmetic option: a user may hide a row they do not read,
// and that is the whole of it. So the persisted shape is a LIST OF IDS from a closed union, it is
// rebuilt field by field on the way into the store (`normalizeXpRows`), and ABSENT means "all of
// them" rather than "none" — a store written before this shipped must not come back empty.

import type { LootEvent } from './types'
import { windowItemRows } from './lootRates'

/**
 * The rows this window can draw, in the order it draws them.
 *
 *   'xp'    — the progress rate. Levels of progress per hour of active time, or — once the level
 *             bar stops being stated — AA per hour, which is the read that survives the cap
 *             (JOS-36/11; shared/aaPace.ts states why those are two different measurements).
 *   'eta'   — what is next: time to the level, or (at cap) the inferred wait for the next AA.
 *   'motes' — motes per hour, one line per mote type seen in the slice.
 *
 * A CLOSED UNION, because it is persisted: a stored id this build does not know is dropped rather
 * than rendered, and a future row cannot be turned on by a hand-edited store.
 */
export const XP_ROW_IDS = ['xp', 'eta', 'motes'] as const
export type XpRowId = (typeof XP_ROW_IDS)[number]

/**
 * The stored row list, rebuilt from whatever the renderer (or a hand-edited store) supplied.
 *
 * `undefined` is the DEFAULT and means every row — it is what an install that has never touched
 * the checklist has, and it is deliberately distinct from `[]`, which is a user who switched all
 * three off and is entitled to their empty window. Unknown ids are dropped, duplicates collapse,
 * and the order is this file's rather than the caller's so the window cannot be re-ordered by a
 * patch.
 */
export function normalizeXpRows(raw: unknown): XpRowId[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const want = new Set(raw.filter((v): v is string => typeof v === 'string'))
  return XP_ROW_IDS.filter((id) => want.has(id))
}

/** Is this row on? Absent list ⇒ yes (see `normalizeXpRows`). */
export function xpRowVisible(id: XpRowId, rows: XpRowId[] | undefined): boolean {
  return rows === undefined || rows.includes(id)
}

/** The list `rows` becomes when `id` is toggled — the checklist's one operation. */
export function toggleXpRow(id: XpRowId, rows: XpRowId[] | undefined): XpRowId[] {
  const on = xpRowVisible(id, rows)
  const base = rows ?? [...XP_ROW_IDS]
  return on ? base.filter((r) => r !== id) : XP_ROW_IDS.filter((r) => r === id || base.includes(r))
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// MOTES
// ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * THE MOTE FAMILY, ANCHORED — and it is the same matcher the mote ALERT already ships
 * (`shared/alertGroups.ts`, group `motes`), quoted rather than re-derived.
 *
 * Every mote the committed items catalog knows is `Mote of <tier> Potential` (10 entries:
 * Infinitesimal, Minor, Lesser, Potential, Major, Greater, Superior, Grand, Ascendant, Infinite)
 * and the reference log printed seven of them. Anchoring the FAMILY covers the three the log has
 * not shown yet, which is the whole reason not to list the tiers.
 *
 * A prefix test rather than a regex: the string is an ITEM NAME out of a parsed loot event, and a
 * pattern over a name from the world is a door this file has no reason to open.
 */
const MOTE_PREFIX = 'Mote of '
const MOTE_SUFFIX = ' Potential'

/** Is this loot item one of the upgrade motes? */
export function isMote(item: string): boolean {
  return item.startsWith(MOTE_PREFIX)
}

/**
 * The TIER word, for a row that has already said it is about motes: `Mote of Lesser Potential` →
 * `Lesser`. Display shortening only — the full name rides along on every row so the hover still
 * says exactly what the log said (law 2: canonicalize at boundaries, display raw).
 *
 * `Mote of Potential` keeps its one word: the suffix is stripped only when something precedes it,
 * so the tierless member of the family cannot be shortened to nothing.
 */
export function moteTier(item: string): string {
  if (!isMote(item)) return item
  const rest = item.slice(MOTE_PREFIX.length)
  return rest.endsWith(MOTE_SUFFIX) && rest.length > MOTE_SUFFIX.length
    ? rest.slice(0, rest.length - MOTE_SUFFIX.length)
    : rest
}

/** One mote type observed in the slice. */
export interface MoteRateRow {
  /** `windowItemRows`' own key (lowercased item name) — the React key. */
  key: string
  /** RAW item name, first-seen casing. The hover text. */
  item: string
  /** The tier word the row prints (`moteTier`). */
  tier: string
  /** Σ stack sizes inside the slice — the same quantity the loot ledger's group count states. */
  drops: number
  /** Per hour of the slice's ACTIVE time. Null when it has none (lootRates rule 3). */
  perHourActive: number | null
}

export interface MoteRatesArgs {
  /** The whole loot history — filtered here, exactly as `windowItemRows` expects. */
  events: readonly LootEvent[]
  /** The slice's instants, half-open at the top. */
  t0: number
  t1: number
  /** The slice's ACTIVE ms — `RangeStats.activeMs`, the denominator every rate beside this one
   *  already divides by. Passed in rather than re-derived (windowScope.ts's rule). */
  activeMs: number
  /** The slice's zone restriction (a `shared/zones.zoneKey` fold), or null for every zone. */
  zoneKey?: string | null
}

/**
 * Motes per hour, by type, for one slice.
 *
 * THE ORDER IS THE OBSERVATION AND NEVER A RANKING. `windowItemRows` already sorts drops
 * descending, then most recent, then name, and this only filters that list — so the tier at the
 * top is the one you looted most, not the one anything here believes is best. NOTHING IN THIS REPO
 * RANKS THE TEN TIERS (the alert group says so at length: neither the catalog nor the log states
 * which adjective outranks which), and a per-tier weighting would be an invented fact.
 *
 * Splitting BY TYPE is not a ranking either — it is the ticket's ask, and the reason the alert
 * deliberately does not split is a different question (which drop deserves the louder sound).
 * Counting them apart states what the log stated; ordering them by worth would not.
 */
export function moteRates(args: MoteRatesArgs): MoteRateRow[] {
  return windowItemRows(args)
    .filter((r) => isMote(r.item))
    .map((r) => ({
      key: r.key,
      item: r.item,
      tier: moteTier(r.item),
      drops: r.drops,
      perHourActive: r.dropsPerHourActive
    }))
}
