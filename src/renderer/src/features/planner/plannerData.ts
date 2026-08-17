// planner/plannerData.ts — the donor corpus in the renderer: fetched once, filtered, folded.
//
// WHY A MODULE-SCOPE CACHE. `items.json` is 7.14 MB and stays in MAIN (design D1); the
// effect-bearing subset arrives over ONE IPC call as a few hundred KB of `PlannerDonor` rows.
// That call is made at most once per window: the corpus is committed data, it cannot change while
// the app runs, and re-fetching it every time the tab is opened would be hundreds of KB of
// structured-clone for an identical answer. The promise is cached too, so two mounts in the same
// frame share one round trip.
//
// FILTERING IS PURE AND RENDER-BOUND. ~1.6k rows, a linear scan, sub-millisecond — the standing
// search law (AGENTS.md "UI conventions"): the input echoes instantly, the FILTER runs on a
// deferred value (EffectBrowser owns the `useDeferredValue`), and the lowercase `searchKey` is
// computed ONCE per data change here rather than per keystroke per row.

import { useCallback, useEffect, useState } from 'react'
import type { ClassAbbr } from '@shared/classCombo'
import type { EquipSlot, PlannerDonor, SocketType } from '@shared/planner/types'
// RELATIVE value import (the mobSearch house law): the era join is reached under the node
// runner through `plannerFarm`, where the vite-only `@shared` alias does not resolve.
import {
  CURRENT_ERA,
  ERA_LABEL,
  eraBadgeOverrides,
  eraFromTag,
  eraRank,
  layeredVerdict,
  zoneEra,
  type Era,
  type EraDerivation,
  type EraVerdict
} from '../../../../shared/planner/era'
import { classesMismatch } from './plannerClasses'
import { defaultAxis, isAxisFor, type GroupAxis } from './plannerGroups'
import { sourcesFor } from './sourceIndex'

/** A donor row with its search haystack precomputed. `searchKey` is never displayed. */
export interface DonorRow extends PlannerDonor {
  searchKey: string
}

/** Whether a donor can be used by the set's target classes. `unknown` is not a pass and not a
 *  fail — the page simply did not state a class list, and the row says so (law 1). */
export type ClassFit = 'fits' | 'unknown' | 'no'

export interface DonorFilters {
  socket: SocketType
  /** raw search text — the caller passes the DEFERRED value */
  text: string
  /** `null` = every slot */
  slot: EquipSlot | null
  /** "usable by the trio", ON by default */
  trioOnly: boolean
}

/**
 * The two PERSISTED, machine-side toggles the browser applies on top of `DonorFilters`. They live
 * apart from it because they are remembered across sessions (`eq.planner.*`) and shared with Farm
 * mode, while the filters above are this mount's own state. Passed as one object so the filter
 * keeps four parameters (the measured `max-params` ceiling).
 */
export interface DonorView {
  /** hide donors whose only known sources are outside `CURRENT_ERA`. Default ON. */
  eraOnly: boolean
  /** show donors with NO equipment slot — the R2 escape hatch. Default OFF. */
  nonEquip: boolean
}

export const DEFAULT_VIEW: DonorView = { eraOnly: true, nonEquip: false }

export const DEFAULT_FILTERS: DonorFilters = {
  // Proc leads: it is the effect players plan around, and the one whose +4 extraction cost makes
  // the farm rollup worth having.
  socket: 'proc',
  text: '',
  slot: null,
  trioOnly: true
}

// ---- the fetch ----------------------------------------------------------------------

function toRow(d: PlannerDonor): DonorRow {
  return { ...d, searchKey: `${d.name} ${d.effect} ${d.detail ?? ''}`.toLowerCase() }
}

let CACHE: DonorRow[] | null = null
let INFLIGHT: Promise<DonorRow[]> | null = null

/** One fetch per window — the corpus is compiled-in bytes, so a second call cannot differ. */
async function fetchDonors(): Promise<DonorRow[]> {
  const rows = await window.eq.plannerDonors()
  CACHE = rows.map(toRow)
  return CACHE
}

export interface DonorsState {
  donors: DonorRow[]
  /** false until the first fetch settles */
  ready: boolean
}

export function useDonors(): DonorsState {
  const [donors, setDonors] = useState<DonorRow[]>(() => CACHE ?? [])
  const [ready, setReady] = useState(CACHE !== null)

  useEffect(() => {
    if (CACHE !== null) return
    let alive = true
    INFLIGHT ??= fetchDonors()
    void INFLIGHT.then((rows) => {
      if (!alive) return
      setDonors(rows)
      setReady(true)
    }).catch(() => {
      /* main never rejects; an empty corpus renders the honest empty state */
      if (alive) setReady(true)
    })
    return () => {
      alive = false
    }
  }, [])

  return { donors, ready }
}

/**
 * `donorKey → every row that key carries`. An item with a proc AND a click is TWO rows under one
 * key, so the planned effect picks the row — Board and Farm both resolve a `PlanSocket` this way.
 */
export function indexDonors(rows: readonly DonorRow[]): Map<string, DonorRow[]> {
  const index = new Map<string, DonorRow[]>()
  for (const row of rows) {
    const list = index.get(row.key)
    if (list) list.push(row)
    else index.set(row.key, [row])
  }
  return index
}

/** The row a planned socket refers to, or null when the corpus does not carry that pair. */
export function donorFor(
  index: ReadonlyMap<string, DonorRow[]>,
  donorKey: string,
  effect: string
): DonorRow | null {
  return index.get(donorKey)?.find((d) => d.effect === effect) ?? null
}

// ---- era scoping --------------------------------------------------------------------

/**
 * WHERE THIS DONOR LIVES, IN EXPANSION TERMS (shared/planner/era.ts owns both tables).
 *
 * The committed corpus is scraped from a wiki that documents every expansion, so more than half
 * of the proc donors drop in Kunark or Velious zones that this server has not opened. Planning
 * around them is not planning — it is a shopping list for a game that isn't running yet.
 *
 * THREE WITNESSES, FOLDED HERE BECAUSE THIS IS WHERE ALL THREE ARE IN HAND:
 *   1. the MOB CATALOG's zones for this key (`sourceIndex`, the renderer's own inversion of
 *      `|known_loot`), and
 *   2. the zones the ITEM PAGE named (`wikiSources`, from `|dropsfrom`) — main serves them
 *      verbatim precisely so the union happens once, here. Either one placing the donor in a
 *      reachable zone settles it.
 *   3. the page's own `{{X Era}}` banner (`eraTag`), consulted ONLY when neither zone list
 *      resolved to anything. That is what finally answers for quest rewards, crafted goods, and
 *      the donors the catalog never links.
 *
 * A donor none of the three place stays `unknown` — the row is visible and says so, because "we
 * don't know where this comes from" must never be dressed up as "it's out of era".
 */
export interface DonorEra {
  verdict: EraVerdict
  /** the era the chip names: the LATEST among its source zones, else the tag's. Null when silent. */
  era: Era | null
  /** which witness produced the verdict — the chip's tooltip must not claim a zone we never saw.
   *  `derived` is LAYER 3 (JOS-333): no witness spoke about this page, and something it stated it
   *  is MADE of, or awarded by, is itself out of era. It names no expansion on purpose. */
  by: 'zone' | 'tag' | 'derived' | null
}

/**
 * What the era join needs from a donor. A LOOSE shape rather than `DonorRow` because a plan can
 * name a (key, effect) pair the corpus has no row for — Board and Farm pass `{ key }` alone then,
 * and the answer degrades to the catalog's zones, which is exactly the evidence available.
 */
export type EraSubject = Pick<PlannerDonor, 'key'> &
  Partial<Pick<PlannerDonor, 'wikiSources' | 'eraTag'>> & {
    /** LAYER 3, built into the GEAR index at corpus-build time (`main/planner/eraDerive.ts`). Donor
     *  and wishlist subjects simply do not carry it, and absent is exactly "no derivation". */
    eraDerived?: EraDerivation
    /**
     * MORE LAYER-1 ZONES, already extracted (JOS-377). Same witness, second spelling: a mob drop
     * arrives from main carrying the zones its ITEM PAGE named (`MobDrop.eraZones`) rather than the
     * `{mob, zone}` rows a `PlannerDonor` carries, because a drop row has no use for the mob half
     * and shipping it would be IPC weight nothing reads. Folded into the same union below, so this
     * adds EVIDENCE and no rule: the verdict is still `layeredVerdict`'s, unchanged.
     */
    zones?: readonly string[]
  }

// Release order AND the display spellings come from era.ts (`eraRank`, `ERA_LABEL`) — the planner
// never re-states which expansion came first, nor how one is spelled.

/** The era the app is currently scoped to, spelled for a tooltip. */
export const CURRENT_ERA_LABEL = ERA_LABEL[CURRENT_ERA]

// Built on demand and kept for the window's life: every input is immutable committed data. The
// identity is the EVIDENCE, not just the key — the same key reaches this function with a corpus
// row (zones + tag) or as a bare `{ key }`, and those two are entitled to different answers.
const ERA_CACHE = new Map<string, DonorEra>()

/** The LATEST expansion any of these zones claims, or null when none of them resolves. */
function latestZoneEra(zones: readonly string[]): Era | null {
  let era: Era | null = null
  for (const zone of zones) {
    const z = zoneEra(zone)
    if (z !== null && (era === null || eraRank(z) > eraRank(era))) era = z
  }
  return era
}

/** Catalog zones ∪ the zones the item page named. One list, deduped, order irrelevant to a fold. */
function eraZones(subject: EraSubject): string[] {
  const catalog = sourcesFor(subject.key).flatMap((s) => s.zones)
  const page = (subject.wikiSources ?? []).flatMap((s) => (s.zone === undefined ? [] : [s.zone]))
  return [...new Set([...catalog, ...page, ...(subject.zones ?? [])])]
}

/**
 * THE CACHE KEY — the EVIDENCE, not just the key (the same subject arrives with a corpus row and as
 * a bare `{ key }`, and those two are entitled to different answers).
 *
 * The separator is SPELLED (`\u0000`), never written as a raw byte. It WAS a raw byte from the day this
 * cache was added until JOS-333: git classified the whole module as binary, so diff, blame and grep
 * went dark on it — the exact failure AGENTS.md records twice already (JOS-133, JOS-150). Same
 * runtime value either way, so there was never a reason to emit the byte.
 */
function eraCacheKey(subject: EraSubject): string {
  const derived = subject.eraDerived
  return [
    subject.key,
    subject.eraTag ?? '',
    String(subject.wikiSources?.length ?? 0),
    // SPELLED OUT, not counted, unlike the row above it: `zones` is the channel a MOB DROP arrives
    // on (JOS-377), and the same item key reaches this cache from the planner carrying none, so a
    // count would let a zone-less subject read a zone-backed answer straight off the cache.
    (subject.zones ?? []).join(','),
    derived === undefined ? '' : `${derived.basis}:${derived.target}`
  ].join('\u0000')
}

/**
 * THE LAYER 1-2 ANSWER: zones first, the page's own banner into their silence, and the JOS-298
 * override on top. Split out from `donorEra` so layer 3 can sit beside it as a peer rather than as
 * one more branch inside a function that was already at the measured complexity ceiling.
 *
 * THE CHIP MUST NAME THE WITNESS THE VERDICT USED (JOS-298). When the page's own `Out of Era` badge
 * overruled the zones, the zone is no longer the reason for anything, and reporting it would put
 * "Classic" on a chip whose verdict is out-of-era — the loudest possible version of the bug that
 * wave fixed. So the tag is both the era and the witness in that case, and the era is frequently
 * `null` there on purpose: `FearHateRevamp` names no expansion, and the chip's honest reading of
 * that is "out of era", not a guessed one.
 */
function statedEra(subject: EraSubject, zones: readonly string[]): DonorEra {
  const fromZone = latestZoneEra(zones)
  const fromTag = subject.eraTag === undefined ? null : eraFromTag(subject.eraTag)
  const overruled = eraBadgeOverrides(subject.eraTag, CURRENT_ERA)
  const era = overruled ? fromTag : (fromZone ?? fromTag)
  return {
    verdict: layeredVerdict(zones, subject.eraTag),
    era,
    by: overruled ? 'tag' : fromZone !== null ? 'zone' : era === null ? null : 'tag'
  }
}

export function donorEra(subject: EraSubject): DonorEra {
  const id = eraCacheKey(subject)
  const hit = ERA_CACHE.get(id)
  if (hit) return hit
  const stated = statedEra(subject, eraZones(subject))
  // LAYER 3 SPEAKS INTO SILENCE — and, for exactly one edge, over it.
  //
  // JOS-333 shipped this as "unknown is the only verdict layer 3 may touch", which made it a rule
  // that could only ever HIDE rows. JOS-341 added the two things that break that symmetry, and both
  // are the wiki's own predicate reaching a page our item corpus does not hold:
  //   * an edge may now point IN, because an armour-set page filed under `Classic Era` is a claim
  //     and not an absence — and while `era?` hides (73ad7ec9), refusing to read it is a decision
  //     to hide gear the wiki says is right here.
  //   * a DEFINITIVE edge (`drop-mob`) outranks the zones, the way the page's own out-of-era banner
  //     has since JOS-298: a revamped zone keeps its name while its contents change, so the mob is
  //     the witness and `Plane of Hate` is not.
  // The era stays `null` either way: the edge names an expansion often enough, but what we know is
  // whether the way you GET this thing is open, not which expansion the thing itself belongs to.
  const derived = subject.eraDerived
  const speaks = derived !== undefined && (derived.definitive === true || stated.verdict === 'unknown')
  const value: DonorEra = speaks ? { verdict: derived.verdict, era: null, by: 'derived' } : stated
  ERA_CACHE.set(id, value)
  return value
}

/**
 * The ERA GROUPING AXIS's reader: which expansion places this donor, or null when nothing does.
 * A module-level function so the browser's grouping memo has a stable identity to depend on, and
 * the one seam through which `plannerGroups` touches the era join at all — it never re-decides a
 * verdict, it reads this one.
 */
export function donorEraOf(donor: DonorRow): Era | null {
  return donorEra(donor).era
}

/** The era chip's whole content, or null when the donor is in-era and there is nothing to say. */
export interface EraChipInfo {
  /** what the chip reads: an expansion name, `out of era`, or `era?` */
  label: string
  /** the `era?` case — chipped quietly, because it is a fact about our tables, not about the item */
  unknown: boolean
  /** why it says that, naming the witness — a banner is not a drop zone and must not pose as one */
  tooltip: string
}

const UNKNOWN_TOOLTIP = 'Nothing in our data states an era for this donor.'

/**
 * WHY A DERIVED VERDICT SAYS WHAT IT SAYS — one sentence per edge kind, naming the target.
 *
 * Each one is written to be checkable against the wiki page in one glance, which is the whole point
 * of a derived answer: the player can see the pill we are mirroring. The two BADGE edges say "the
 * wiki marks" because that is literally the wiki's own predicate; the two ZONE edges say where,
 * because that claim is ours (`shared/zones.ts`) and must not pose as the wiki's.
 */
function derivedReason(d: EraDerivation | undefined): string {
  if (d === undefined) return UNKNOWN_TOOLTIP
  if (d.basis === 'component') return `Its recipe needs ${d.target}, which the wiki marks out of era (${d.detail}).`
  if (d.basis === 'yield') return `Its recipe yields ${d.target}, which the wiki marks out of era (${d.detail}).`
  if (d.basis === 'quest') return `It is only awarded by ${d.target}, a quest that starts in ${d.detail}.`
  if (d.basis === 'drop-mob') return `Every mob that drops it is out of era on the wiki: ${d.detail}.`
  if (d.basis === 'page') {
    return d.verdict === 'in-era'
      ? `Its notes name ${d.target}, which the wiki files as ${d.detail}, in era.`
      : `Its notes name ${d.target}, which the wiki marks out of era (${d.detail}).`
  }
  return `Its recipe needs ${d.target}, which only drops in ${d.detail}.`
}

/**
 * The one chip the era join draws.
 *   out-of-era → the expansion's name ("Velious") — shown only while the filter is OFF
 *   unknown    → `era?` — nothing states an era, and we will not guess one
 *   in-era     → null, the normal case, which needs no decoration
 */
export function eraChip(subject: EraSubject): EraChipInfo | null {
  const { verdict, era, by } = donorEra(subject)
  if (verdict === 'in-era') return null
  if (verdict === 'unknown') return { label: 'era?', unknown: true, tooltip: UNKNOWN_TOOLTIP }
  const label = era === null ? 'out of era' : ERA_LABEL[era]
  return {
    label,
    unknown: false,
    // The banner tooltip quotes the token VERBATIM rather than the label: half the out-of-era
    // banners ("FearHateRevamp", "EpicQuests") name no expansion, so the label there is the
    // generic "out of era" and repeating it would explain nothing. A DERIVED verdict names the
    // edge instead, because the page itself says nothing and "out of era" with no reason attached
    // is the one thing this chip must never be.
    tooltip:
      by === 'derived'
        ? derivedReason(subject.eraDerived)
        : by === 'tag'
          ? `Its wiki page is banner-tagged ${subject.eraTag ?? label}, which the wiki marks out of era.`
          : `This donor's sources are in ${label}.`
  }
}

/**
 * Does the current-era filter hide this donor?
 *
 * TWO VERDICTS HIDE NOW (owner ruling 2026-08-13, the era? escalation): a POSITIVE out-of-era, and
 * UNCERTAINTY. The old rule — only a positive verdict hides — treated era? as innocent-until-
 * placed, and the owner's spot checks kept finding that bucket full of gear the wiki itself badges
 * out of era through pages our corpus does not hold (armor sets, quest hubs — JOS-333's measured
 * remainder: 824 era? rows pointing at 152 non-item pages). Until the respectful metadata fetch
 * folds those targets in (the follow-up ticket), a question mark under a filter called "Current
 * era" is a leak, not a courtesy: the filter's promise is "what you can get", and "we cannot say"
 * fails that promise the same way "no" does. The chip still says era? on every surface the row IS
 * shown (filter off), so nothing is dressed up as a verdict — the row is hidden for lacking one.
 */
export function eraHides(subject: EraSubject, eraOnly: boolean): boolean {
  if (!eraOnly) return false
  const verdict = donorEra(subject).verdict
  return verdict === 'out-of-era' || verdict === 'unknown'
}

const ERA_KEY = 'eq.planner.era'

/**
 * The "Current era" toggle, DEFAULT ON, persisted machine-side like every other planner UI pref.
 * Effects and Farm each read it on mount; they are never on screen at the same time, so one
 * localStorage-backed value is the whole synchronisation story.
 */
export function useEraOnly(): [boolean, (v: boolean) => void] {
  const [on, setOn] = useState(() => localStorage.getItem(ERA_KEY) !== '0')
  const set = useCallback((v: boolean) => {
    localStorage.setItem(ERA_KEY, v ? '1' : '0')
    setOn(v)
  }, [])
  return [on, set]
}

// ---- the equippability rule (R2) ----------------------------------------------------

const NONEQUIP_KEY = 'eq.planner.nonequip'

/**
 * NO EQUIPMENT SLOT ⇒ NO LEGAL DONATION. This is R2, not a heuristic: an exaltation may only be
 * socketed into an item that SHARES the donor's equipment slot, so a donor the wiki gives no slot
 * shares a slot with nothing and can never be the source of one.
 *
 * RE-MEASURED over the committed corpus (2026-08-06, JOS-67, `buildPlannerIndex`): 280 of 1,462
 * donor rows are slotless — 213 of the 799 click rows (the potion mass: "10 Dose Blood of the Wolf"
 * and its nine hundred cousins) and 67 of the 444 proc rows (poisons and weapon coatings, which are
 * consumed rather than worn). Zero focus and zero worn rows are slotless, which is itself the
 * tell: those two effect families only ever appear on things you wear.
 *
 * SO THE DEFAULT FILTER DROPS THEM — and the toggle below is the escape hatch, because an empty
 * slot list is "the page stated none" (law 1), which is USUALLY a consumable and occasionally a
 * wiki gap. The rows are shown chipped `no slot` rather than silently trusted or silently lost.
 *
 * TWO OF THEM WERE THE THIRD THING — a SCRAPE gap — and a user found one before we did (JOS-67,
 * feedback 01KZCGXY8WC6YCD8W44W7EAS5H: the Golem Metal Wand's click, invisible here because its
 * page states "Primary Secondary" on a line the parser cannot key). Those are filed in the curated
 * layer now (`src/main/itemsResearch.ts`, the `slots` table) and arrive with slots like any other
 * donor, which is why the count above moved 282 → 280. The escape hatch stays: it is the only way
 * a fourth one is ever visible before someone files it.
 */
export function isNonEquippable(donor: Pick<PlannerDonor, 'slots'>): boolean {
  return donor.slots.length === 0
}

/**
 * The "non-equippable" toggle, DEFAULT OFF, persisted machine-side beside the era key. Absent
 * value means off — the opposite default to the era toggle, and deliberately so: era hides things
 * you cannot reach YET, this hides things the rules say can never donate at all.
 */
export function useNonEquip(): [boolean, (v: boolean) => void] {
  const [on, setOn] = useState(() => localStorage.getItem(NONEQUIP_KEY) === '1')
  const set = useCallback((v: boolean) => {
    localStorage.setItem(NONEQUIP_KEY, v ? '1' : '0')
    setOn(v)
  }, [])
  return [on, set]
}

// ---- the filter model ---------------------------------------------------------------

/**
 * R2's class half, as a three-valued answer. An empty `planClasses` (a set with no trio picked)
 * asks for NO class filter — it is not a claim that zero classes are wanted.
 *
 * The `no` case is `plannerClasses.classesMismatch` and nothing else: the browser filter and the
 * Board's mismatch chip (V2) are the same question asked at two moments, and one rule is what
 * stops a donor being hidden here and unmarked there.
 */
export function classFit(donor: PlannerDonor, planClasses: readonly ClassAbbr[]): ClassFit {
  if (planClasses.length === 0) return 'fits'
  if (donor.classes.length === 0) return 'unknown'
  return classesMismatch(donor.classes, planClasses) ? 'no' : 'fits'
}

/**
 * The browser's filter: equippability, then socket type, then slot, then trio compatibility, then
 * era, then the text match.
 *
 * `trioOnly` keeps UNKNOWN rows. Hiding a donor whose page never stated a class list would be the
 * planner asserting a fact the wiki declined to state; the row is shown and chipped instead. The
 * SLOT half is different in kind and that is why it is filtered by default: an absent slot is not
 * an unknown the user can resolve by squinting at it, it is R2 saying no.
 */
export function filterDonors(
  rows: readonly DonorRow[],
  filters: DonorFilters,
  planClasses: readonly ClassAbbr[],
  view: DonorView = DEFAULT_VIEW
): DonorRow[] {
  const needle = filters.text.trim().toLowerCase()
  return rows.filter((d) => {
    if (!view.nonEquip && isNonEquippable(d)) return false
    if (d.socket !== filters.socket) return false
    if (filters.slot !== null && !d.slots.includes(filters.slot)) return false
    if (filters.trioOnly && classFit(d, planClasses) === 'no') return false
    if (eraHides(d, view.eraOnly)) return false
    return needle === '' || d.searchKey.includes(needle)
  })
}

/**
 * WHAT THE TWO VIEW TOGGLES ARE HOLDING BACK, for an empty list to be honest about (JOS-67).
 *
 * The era filter and the non-equippable filter are the two that can empty a search NOBODY typed
 * wrong — they are on/off by default rather than by choice, and neither is visible in the row area
 * where the answer is missing. A player searched for a real, legal click effect that the slot
 * filter was hiding and read "No effects match these filters", which is true and useless.
 *
 * So: run the SAME filter with BOTH toggles wide open, then count how many of the rows that
 * survived each ACTIVE toggle is rejecting. Counted per toggle rather than as one total because
 * the two mean different things — era is "not on this server yet", no-slot is "R2 says never" —
 * and a row both of them reject is counted by both, deliberately: each number answers "what is
 * this control holding back", and releasing only one of the two would indeed still hide it.
 * (The alternative — "what would releasing this one reveal" — reports ZERO for exactly that row,
 * which is how a doubly-hidden answer would slip back into a silent empty list.)
 *
 * Only ever called when the visible list is EMPTY, so it costs one linear scan of ~1.5k rows plus
 * two predicate passes, at the moment there is nothing else to draw.
 */
export interface HiddenByView {
  /** rows the current-era filter is holding back (0 when it is already off) */
  era: number
  /** rows the no-slot filter is holding back (0 when it is already showing them) */
  nonEquip: number
}

export function hiddenByView(
  rows: readonly DonorRow[],
  filters: DonorFilters,
  planClasses: readonly ClassAbbr[],
  view: DonorView
): HiddenByView {
  const open: DonorView = { eraOnly: false, nonEquip: true }
  const candidates = filterDonors(rows, filters, planClasses, open)
  return {
    era: view.eraOnly ? candidates.filter((d) => eraHides(d, true)).length : 0,
    nonEquip: view.nonEquip ? 0 : candidates.filter((d) => isNonEquippable(d)).length
  }
}

// ---- the grouping axis (V4) ---------------------------------------------------------
//
// The FOLD itself lives in `plannerGroups.ts` (pure, node-tested); what lives here is the same
// thing every other browser preference does — the persisted choice, in the `eq.planner.*` idiom
// beside the era and non-equippable toggles.

const GROUP_KEY = 'eq.planner.groupBy'

function storedAxis(socket: SocketType): GroupAxis {
  const stored = localStorage.getItem(`${GROUP_KEY}.${socket}`)
  return stored !== null && isAxisFor(socket, stored) ? stored : defaultAxis(socket)
}

/**
 * The group-by choice, REMEMBERED PER SOCKET TAB (V4). Per socket because the tabs ask different
 * questions: Focus opens on families ("the best Improved Healing"), Proc on effects, and a user who
 * groups the Proc tab by slot has said nothing about how they want to read Focus.
 *
 * An axis stored under a socket that no longer offers it (a rename, or `family` read back on a
 * non-focus tab) falls back to that socket's default rather than rendering an axis the model
 * cannot serve.
 */
export function useGroupBy(socket: SocketType): [GroupAxis, (v: GroupAxis) => void] {
  const [axis, setAxis] = useState<GroupAxis>(() => storedAxis(socket))
  // The tab switch is what re-reads storage: one hook follows the socket, so switching to Focus
  // lands on families and switching back lands on whatever that tab was left grouped by.
  useEffect(() => {
    setAxis(storedAxis(socket))
  }, [socket])
  const set = useCallback(
    (v: GroupAxis) => {
      localStorage.setItem(`${GROUP_KEY}.${socket}`, v)
      setAxis(v)
    },
    [socket]
  )
  return [axis, set]
}
