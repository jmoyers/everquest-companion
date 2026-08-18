// gear/gearData.ts — the candidate index in the renderer: fetched once, widened, and the two
// pieces of state the Gear tab keeps beside it (the global plus-state, and the class combo).
//
// ONE FETCH PER WINDOW, the `plannerData.ts` precedent and for the same reasons: `items.json` is
// 8.6 MB and stays in MAIN, the gear index is built there once and arrives over ONE IPC call, and
// the corpus is committed data that cannot change while the app runs. The promise is cached too,
// so two mounts in the same frame share one round trip.
//
// THE PAYLOAD IS VERSIONED, AND A VERSION WE DO NOT KNOW IS REFUSED (gear.ts states the contract).
// A renderer that met a `GEAR_INDEX_VERSION` from the future would be drawing a vector whose keys
// or units mean something else — so it draws nothing and says so, which is the only honest
// failure. In practice both halves ship together; this is what makes that assumption checkable.
//
// THE SEARCH KEY IS WIDENED HERE, ONCE PER DATA CHANGE. The index's own `searchKey` is the item
// NAME (gear.ts, pinned by tests/gearIndex.test.mts) because that is the only haystack a shared
// index can commit to. A player searching this table means "Improved Healing" as often as they
// mean "Blade of Light", so the table's copy folds the effect names in — the exact widening
// `plannerData.toRow` performs for donor rows, computed once here rather than per keystroke per
// row (the standing search law).

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ClassAbbr } from '@shared/classCombo'
import { resolvedClasses } from '@shared/classCombo'
import type { ItemUpgradeState } from '@shared/itemUpgrade'
import { GEAR_INDEX_VERSION, type GearBuildStats, type GearRow } from '@shared/planner/gear'
import { NO_OWNERSHIP, type OwnershipPayload } from '@shared/planner/ownership'
import { isAcquisition } from '@shared/lootDisposition'
import { useLootHistory } from '../loot/useLootHistory'
import { useComboSnap } from '../profiles/ClassComboData'
// JOS-338: the caller `features/planner/plannerInventory.ts` has been asking for since JOS-326 —
// see `useGearCompare` for why this channel and not the ownership payload beside it.
import { usePlannerInventory } from '../planner/plannerInventory'
import { outputUpdatedMillis } from '../../lib/outputFreshness'
import { equippedIndex, type EquippedIndex } from './gearCompare'
// ONE era verdict for the whole app: the exaltation browser's, reached through the same three
// witnesses (mob catalog ∪ the page's own drop list ∪ the era banner). A `GearRow` carries `key`,
// `wikiSources` and `eraTag`, which is exactly what an `EraSubject` is — so this is a call, never
// a second copy of the rule.
import { eraChip, eraHides, type EraChipInfo } from '../planner/plannerData'
import { sourceIndex } from '../planner/sourceIndex'
import { sameClasses } from '../planner/plannerClasses'
import { gearOwnershipMap, ownershipFor, type GearOwnershipMap } from './gearOwnership'
// JOS-329: the two pieces of state below survive a tab switch now — see each one's own comment.
import { sanitizeGearClasses, sanitizeUpgrade } from './areaMemory'
import { useRemembered } from './useAreaMemory'

// ---- the fetch ----------------------------------------------------------------------

/** The effect text a search should reach: the name, and the parenthetical the wiki wrote after it. */
function effectHaystack(row: GearRow): string {
  return row.effects.map((e) => `${e.name} ${e.detail ?? ''}`).join(' ')
}

/** The index row with the table's own, wider search key. Same type — only the haystack grew. */
function toRow(row: GearRow): GearRow {
  return { ...row, searchKey: `${row.name} ${effectHaystack(row)}`.toLowerCase() }
}

export interface GearIndexState {
  rows: GearRow[]
  /** false until the first fetch settles */
  ready: boolean
  /** the corpus's own `scrapedAt` — WHEN the data is from */
  scrapedAt: string | null
  stats: GearBuildStats | null
  /** the payload stated a version this build does not know — nothing is drawn */
  refused: boolean
}

const EMPTY: GearIndexState = { rows: [], ready: false, scrapedAt: null, stats: null, refused: false }

let CACHE: GearIndexState | null = null
let INFLIGHT: Promise<GearIndexState> | null = null

async function fetchIndex(): Promise<GearIndexState> {
  const payload = await window.eq.gearIndex()
  CACHE =
    payload.version === GEAR_INDEX_VERSION
      ? {
          rows: payload.rows.map(toRow),
          ready: true,
          scrapedAt: payload.scrapedAt,
          stats: payload.stats,
          refused: false
        }
      : { ...EMPTY, ready: true, refused: true }
  return CACHE
}

/** The whole index, fetched at most once per window. */
export function useGearIndex(): GearIndexState {
  const [state, setState] = useState<GearIndexState>(() => CACHE ?? EMPTY)

  useEffect(() => {
    if (CACHE !== null) return
    let alive = true
    INFLIGHT ??= fetchIndex()
    void INFLIGHT.then((next) => {
      if (alive) setState(next)
    }).catch(() => {
      /* main never rejects; an empty index renders the honest empty state */
      if (alive) setState({ ...EMPTY, ready: true })
    })
    return () => {
      alive = false
    }
  }, [])

  // Warm the mob-catalog inversion AFTER mount, not on the render path: the first row to ask the
  // era join for a source would otherwise pay the whole ~33k-link build inside a paint (the
  // EffectBrowser precedent).
  useEffect(() => {
    sourceIndex()
  }, [])

  return state
}

/** The era verdict as the pure filter model wants it — a stable identity, so the memo can key on it. */
export function useEraHidden(): { eraHidden: (row: GearRow) => boolean } {
  return useMemo(() => ({ eraHidden: (row: GearRow) => eraHides(row, true) }), [])
}

// ---- the ownership join (JOS-285, phase 4) --------------------------------------------

/**
 * WHAT THIS CHARACTER OWNS, joined to the corpus by `row.key`.
 *
 * TWO WITNESSES, TWO CADENCES, ONE MAP. The dump crosses IPC and is re-asked ONLY on
 * `inventory:autoReloaded` (the plannerInventory precedent — main is the one thing that knows
 * which dump belongs to the active character, so the answer is re-asked rather than patched from
 * the push). The loot history is already in this window as a module snapshot and moves with every
 * kill. Both feed ONE memo, so the join is rebuilt when either witness moves and NEVER on a
 * keystroke, a sort, or a drag of the plus-state slider — ownership does not depend on any of
 * those, and a 6,814-row table would re-join on all three.
 *
 * MAIN MEMOIZES ITS HALF ON THE FILE'S IDENTITY (ipc/planner.ts), so re-asking is a stat and not
 * a re-fold. The two caches answer different questions: main's says "the dump has not moved",
 * this one says "neither witness has moved".
 */
export interface GearOwnershipState {
  /** the join, or `null` when this character has never written a dump AND has looted nothing */
  map: GearOwnershipMap | null
  /** the dump's provenance — the path/mtime the payload arrived with, for the freshness line */
  payload: OwnershipPayload
  /** when THIS WINDOW last read the payload (epoch ms), or null before the first read settles */
  readAt: number | null
}

export function useGearOwnership(): GearOwnershipState {
  const [payload, setPayload] = useState<OwnershipPayload>(NO_OWNERSHIP)
  const [readAt, setReadAt] = useState<number | null>(null)
  const history = useLootHistory()

  const read = useCallback((alive: () => boolean) => {
    void window.eq
      .gearOwnership()
      .then((next) => {
        if (!alive()) return
        setPayload(next)
        setReadAt(Date.now())
      })
      .catch(() => {
        /* main never rejects; no dump is an empty payload, not a failure to render */
        if (alive()) setReadAt(Date.now())
      })
  }, [])

  useEffect(() => {
    let alive = true
    const live = (): boolean => alive
    read(live)
    const off = window.eq.onInventoryReload(() => read(live))
    return () => {
      alive = false
      off()
    }
  }, [read])

  // The loot names, deduped before the join so a thousand `Bone Chips` lines cost one key.
  //
  // DESTROYS ARE NOT NAMES HERE (JOS-401, the census). This set answers "does this character OWN
  // one", so a line saying an item left the bags must not be the reason the app says it is owned.
  // It costs nothing in the ordinary case — an item you looted and then destroyed one of is still
  // in the set through its own loot rows — and it is only decisive for an item this log has seen
  // exclusively as a destroy, which is exactly the one the Owned column must not claim.
  const lootedNames = useMemo(
    () => [...new Set(history.filter(isAcquisition).map((e) => e.item))],
    [history]
  )

  const map = useMemo(() => {
    if (payload.entries.length === 0 && lootedNames.length === 0) return null
    return gearOwnershipMap(payload.entries, lootedNames)
  }, [payload.entries, lootedNames])

  return { map, payload, readAt }
}

// ---- the comparison join (JOS-338) ------------------------------------------------------

/**
 * WHAT THE HOVER CARD IS HANDED: what you are WEARING, the corpus by key, and when you exported.
 *
 * THE SEAM IS `plannerInventory`, AND IT IS THE ONE THIS FEATURE WANTED. Two channels could have
 * answered "what is in that slot": this one, and `gearOwnership`'s payload, whose `OwnershipRow`
 * carries an equipped row's `slot` too. The ownership payload is keyed BY ITEM (itemKey → rows), so
 * reading it by slot means inverting the whole index in the renderer — and it stops at the SLOT,
 * deliberately ("cell assignment is `equippedHosts`' job and is not repeated here"), which is
 * exactly the half this card needs: two ears are two comparisons. `plannerInventory` already
 * answers in CELLS, already carries `itemKey` (main's definition, applied in the handler) and
 * already carries the dump's mtime for the freshness line, so it is one call and no new rule.
 *
 * AND IT WAS CALLER-LESS. `features/planner/plannerInventory.ts` has said in writing since JOS-326
 * that its whole channel — the hook, `IPC.plannerInventory`, the handler and the preload method —
 * had no reader left and wanted either a caller or a four-file retirement. This is the caller.
 *
 * COST: one IPC per mount and one per `inventory:autoReloaded`, which is one parse of a ~300-line
 * file in main (the handler declines to cache on purpose — its header says why). Nothing here is
 * per row, per keystroke or per slider tick: the two maps are memos over data that moves only when
 * the corpus arrives or the player re-exports.
 */
export interface GearCompareData {
  /** cell → the item worn in it, from the newest dump; empty when there is no dump */
  equipped: EquippedIndex
  /** the whole corpus by `itemKey`, so a WORN item's numbers are read in the same vocabulary */
  byKey: ReadonlyMap<string, GearRow>
  /** the dump's own mtime in epoch ms — when the PLAYER exported. Absent when they never have */
  exportedAt: number | undefined
  /** this character has a dump at all. `false` is the run-the-command hint, never "wearing nothing" */
  hasDump: boolean
  /** false until the first read settles — the card draws neither half rather than guessing */
  ready: boolean
  /** the plus-state the TABLE is simulating, so the card can admit that its item half is one */
  state: ItemUpgradeState
}

export function useGearCompare(rows: readonly GearRow[], state: ItemUpgradeState): GearCompareData {
  const { inventory, ready } = usePlannerInventory()
  // Keyed on the ARRAY identity, which `useGearIndex` holds stable for the life of the window (the
  // fetch is cached), so this 6,766-entry map is built once per window and never per hover.
  const byKey = useMemo(() => new Map(rows.map((row) => [row.key, row])), [rows])
  const equipped = useMemo(() => equippedIndex(inventory?.hosts ?? []), [inventory])
  // ONE OBJECT, MEMOIZED, because `GearLine` is `memo`'d and this is one of its props: a fresh
  // literal per render would defeat the memo on every keystroke of the search box, across a whole
  // screenful of rows (the `handlers` object in GearTable.tsx is the same bargain).
  return useMemo(
    () => ({
      equipped,
      byKey,
      exportedAt: outputUpdatedMillis(inventory?.loadedAt),
      hasDump: inventory !== null,
      ready,
      state
    }),
    [equipped, byKey, inventory, ready, state]
  )
}

/**
 * The owned filter as the pure model wants it — the same injected-predicate shape `useEraHidden`
 * returns, and stable while the join is, so `filterGearRows`' memo can key on it.
 */
export function useOwnedOrLooted(map: GearOwnershipMap | null): { ownedOrLooted: (row: GearRow) => boolean } {
  return useMemo(
    () => ({
      ownedOrLooted: (row: GearRow): boolean => {
        if (map === null) return false
        const o = ownershipFor(map, row)
        // An exaltation counts: it is proof a copy passed through this character's hands, which is
        // exactly what the checkbox asks (gearOwnership.ts, rule 2).
        return o.owned || o.looted || o.exaltations > 0
      }
    }),
    [map]
  )
}

/** The one chip the era join draws on a gear row, or null when it is in-era and has nothing to say. */
export function gearEraChip(row: GearRow): EraChipInfo | null {
  return eraChip(row)
}

// ---- the global plus-state ------------------------------------------------------------

/**
 * THE UPGRADE SIMULATION'S STATE — AND THE ONE DESIGN DECISION IN IT, NOW REVERSED BY THE OWNER.
 *
 * THE OLD LAW (JOS-284, and it stood until 2026-08-13): IT IS NOT PERSISTED. Every other planner
 * preference is remembered machine-side (`eq.planner.*`) because every other one is a way of
 * READING the corpus. This one changes what the corpus SAYS — at `+5` the table states numbers no
 * item in your bags has — so a tab that silently reopened at +5 would be lying quietly, and the lie
 * would be invisible precisely because the slider is the thing you stopped looking at. It reset to
 * base on every mount, which is the state the data is actually in.
 *
 * THE OWNER RULING OF 2026-08-13 (JOS-329) OVERRIDES THAT LAW. The report named the slider in the
 * same breath as the filters and the sort — *we're losing everything right now* — and the slider
 * was losing its position on every tab switch along with them, which is the half of the old law
 * nobody had priced: the argument above is about what a NEW SESSION should open on, and it was
 * being paid for by a control that also forgot itself when you glanced at the Loot tab.
 *
 * THE OLD ARGUMENT IS ANSWERED, NOT MERELY OUTVOTED, and it is worth writing down which premise
 * failed: **the lie was never quiet.** `UpgradeSlider` renders a permanent label saying exactly what
 * is being simulated, in the item window's own words — `Tier 2  3/4  +27.5%` — and it is on screen
 * from the first paint of every mount (`gear-upgrade-label`, which the e2e reads). A restored
 * plus-state ANNOUNCES itself. What the old law was really defending against was state you could
 * not see, and this control is the opposite of that; the two remaining ways to be at a non-base
 * plus without knowing are both closed already, because hiding the control via the JOS-297 filters
 * picker puts the corpus back at base (`GearView`'s `visible.has('upgrade')` clamp) and the value
 * is validated back to a legal state on every read.
 *
 * SO IT JOINS THE REST OF THE FORM, on the RESTART tier (`areaMemory.ts` states the split and
 * `sanitizeUpgrade` states the validation, which is `normalizeUpgradeState` and never a second
 * opinion).
 */
export function useUpgradeState(): {
  state: ItemUpgradeState
  /** the value the CONTROL echoes — see GearView on why the table reads a deferred copy */
  set: (next: ItemUpgradeState) => void
} {
  const [state, set] = useRemembered<ItemUpgradeState>('eq.gear.upgrade', sanitizeUpgrade)
  return { state, set }
}

// ---- the class combo -------------------------------------------------------------------

/**
 * THE CLASS FILTER, AND ITS PROVENANCE (V2's rule, `plannerClasses.ts` — a trio is a FILTER and
 * never a rule).
 *
 * `detected` is the default: the table reads for whatever the app currently believes this
 * character is running, and a loadout switch rewrites it silently and correctly, because nobody
 * has said otherwise yet. The moment the user edits the selection it PINS (`user`), and detection
 * may never overwrite it again — it can only offer, which is what `detectedOffer` is for on the
 * exaltation board and what the toolbar's "detected: …" chip does here.
 *
 * WHAT IT DOES TO THE TABLE CHANGED ON 2026-08-13 (owner ruling, JOS-302). It used to enforce
 * nothing: a row outside the filter was hidden only while a companion "Usable by these" toggle was
 * on, and a row shown despite a mismatch was CHIPPED rather than removed. The owner overruled that
 * for THIS surface — the picks now NARROW the corpus, the toggle is gone and so is the chip. The
 * provenance rule above is untouched, and so is the planner build pane's own mismatch chip, which
 * is a different surface answering a different question (`gearFilter.ts GearFilters.classes`).
 *
 * ONE CONSEQUENCE WORTH SAYING OUT LOUD, because this hook is what causes it: `detected` is the
 * default, so an untouched Gear tab opens NARROWED to the classes the app infers you are running.
 * That is the reading a gear planner wants, and it is visible in three places at once — the chips
 * in the picker, the "N of 6,814 items" count line, and `GearView.emptyText` when it goes to zero.
 *
 * AND SINCE JOS-329 THE PIN SURVIVES THE TAB SWITCH THAT USED TO ERASE IT. `pinned` was `useState`,
 * so every visit to another module handed the filter back to detection — silently, and looking
 * exactly like the app changing its mind about your loadout. It is on the RESTART tier now
 * (`eq.gear.classes`), and the THREE-VALUED shape is what needed the care: `null` is FOLLOWING and
 * an empty list is PINNED TO NOTHING, which are different statements and are stored differently
 * (the key is absent for the first). `sanitizeGearClasses` owns that distinction and the closed
 * allowlist; this hook only decides what to write.
 *
 * IT IS DELIBERATELY *NOT* SHARED WITH `eq.planner.classes`, the Exaltations browser's own trio.
 * Two surfaces, two questions: the browse filter is "who am I collecting exaltations for" and this
 * one is "who am I reading the gear table for", and JOS-302 made this one NARROW the corpus while
 * that one still only lights chips. Folding them onto one key would make a click on either tab
 * silently re-filter the other.
 */
export interface GearClasses {
  /** the classes the filter is reading for */
  classes: ClassAbbr[]
  /** what the app currently infers, whether or not the filter follows it */
  detected: ClassAbbr[]
  /** true while the filter is following detection */
  following: boolean
  /** the detected trio, when it is worth offering (pinned, resolved, and different) */
  offer: ClassAbbr[] | null
  /** the user picking classes by hand — this PINS the filter */
  set: (next: ClassAbbr[]) => void
  /** take the detected trio and stay pinned to it (the offer chip) */
  adopt: () => void
}

export function useGearClasses(): GearClasses {
  const combo = useComboSnap()
  const current = combo.current
  // An unresolved slot contributes nothing, so a half-known combo yields the classes it does know
  // and nothing it does not (law 1) — the same read PlannerView makes.
  const detected = useMemo(() => (current === null ? [] : resolvedClasses(current)), [current])
  const [pinned, setPinned] = useRemembered<ClassAbbr[] | null>('eq.gear.classes', sanitizeGearClasses)

  const set = useCallback(
    (next: ClassAbbr[]) => {
      setPinned(next)
    },
    [setPinned]
  )
  // ADOPTING THE OFFER PINS, and always did: taking today's detection is accepting one answer, not
  // handing the filter back to inference forever (the `useBrowseClasses.adopt` rule, stated there).
  const adopt = useCallback(() => {
    setPinned(detected)
  }, [detected, setPinned])

  const classes = pinned ?? detected
  const offer = pinned !== null && detected.length > 0 && !sameClasses(pinned, detected) ? detected : null
  return { classes, detected, following: pinned === null, offer, set, adopt }
}
