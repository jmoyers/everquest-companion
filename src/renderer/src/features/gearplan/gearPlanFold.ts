import { useMemo } from 'react'
import type { ItemStatBlock } from '@shared/itemStats'
import type { ClassAbbr } from '@shared/classCombo'
import { ITEM_UPGRADE_BASE, type ItemUpgradeState } from '@shared/itemUpgrade'
import type { GearRow, GearStats } from '@shared/planner/gear'
import { scaleGearStats } from '@shared/planner/gearScale'
import { plannedSockets } from '@shared/planner/gearPlan'
import {
  cellBlock,
  cellDelta,
  equippedRead,
  gearPlanDiff,
  gearPlanTotals,
  weaponFacts,
  type CellDelta,
  type GearPlanDiff,
  type WeaponFacts
} from '@shared/planner/gearPlanTotals'
import type { EquipSlot, PlanSlotId } from '@shared/planner/types'
import { useGearIndex } from '../gear/gearData'
import { usePlannerInventory } from '../planner/plannerInventory'
import { indexDonors, useDonors } from '../planner/plannerData'
import type { GearPlanBoardProps } from './GearPlanBoard'
import type { useGearPlan } from './useGearPlan'
import type { SocketType } from '@shared/planner/types'

// gearplan/gearPlanFold.ts — everything the two panes READ, folded once per change.
//
// SPLIT FROM `GearPlanView.tsx`, which crossed the measured 400-code-line file ceiling when the
// picker became a panel. The seam is the honest one rather than the convenient one: this file
// resolves keys to corpus rows and does arithmetic, the view lays panes out and owns which popover
// is open. Nothing here renders and nothing there computes.
//
// EVERY NUMBER IS SOMEBODY ELSE'S. `cellBlock` and `cellDelta` are `shared/planner/gearPlanTotals`,
// the scaling is phase 0's, and `sumGear` is the character sheet's — this file only decides WHICH
// rows to hand them and caches the answer against the board, the corpus and the dump.

/**
 * WHAT THE CORPUS SAYS A PLANNED ITEM IS. Both axes travel together because R2 asks both of them
 * about the same subject, and splitting them is how the slot half came to be asked of the CELL
 * while the class half was asked of the ITEM — which is the any-cell bug, exactly.
 *
 * `[]` from either is UNKNOWN, never "nothing": an item the gear index has no row for constrains
 * nothing rather than refusing everything (law 1).
 */
export interface ItemFacts {
  classesOf: (key: string) => readonly ClassAbbr[]
  slotsOf: (key: string) => readonly EquipSlot[]
}

/** Everything the two panes read, folded once per change of the board, the corpus or the dump. */
export interface GearPlanFold {
  /** what the corpus says a planned item IS — the two axes R2 judges a donor against */
  facts: ItemFacts
  totals: ReturnType<typeof gearPlanTotals>
  diff: GearPlanDiff | null
  unstated: number
  /** worn exaltations the dump named but the corpus could not place in a socket */
  unresolved: number
  sockets: ReturnType<typeof plannedSockets>
  /** what the dump says is on the body, as a board; `null` when there is no dump */
  equipped: ReturnType<typeof equippedRead>['gearPlan'] | null
  /** the per-cell readers the board hands each card, grouped so the view spreads them once */
  board: Pick<GearPlanBoardProps, 'blockOf' | 'deltaOf' | 'iconOf' | 'weaponOf'>
  /**
   * WHAT A CANDIDATE WOULD CHANGE, while you are still choosing it.
   *
   * The same question the cell answers, asked one step earlier — and against the SAME anchor, the
   * item worn in that cell, so a number in the picker means what the number on the card will mean.
   * Comparing instead against whatever is currently PLANNED there would make the list re-baseline
   * itself every time you picked something, and two candidates would stop being comparable.
   *
   * AT BASE, because a candidate has no planned tier yet — nothing has been decided about merging
   * it. That is the honest reading of "if I put this on as it is", and the cell's own slider is
   * where the rest of the question gets asked.
   */
  candidateDelta: (key: string, cell: PlanSlotId) => CellDelta[] | null
  /** the same, for a weapon's derived ratio — see `WeaponRead` */
  candidateWeapon: (key: string, cell: PlanSlotId) => WeaponRead | null
}

/**
 * A WEAPON AND WHATEVER IT WOULD REPLACE, both at their own tiers.
 *
 * `worn` is `null` for two different-looking reasons that mean the same thing to a reader — no dump,
 * or nothing worn in that cell — and one more that does not: the worn item is not a weapon. All
 * three come out as "no comparison available", and the line then simply states the ratio rather
 * than inventing a baseline to beat.
 */
export interface WeaponRead {
  mine: WeaponFacts
  worn: WeaponFacts | null
}

/** One cell's planned row and worn row, scaled to their own tiers — `cellBlock`'s arithmetic. */
function scaledOf(
  planned: { key: string; state: ItemUpgradeState } | undefined,
  lookup: (key: string) => GearRow | undefined
): GearStats | null {
  if (planned === undefined) return null
  const row = lookup(planned.key)
  return row === undefined ? null : scaleGearStats(row.stats, planned.state, row.voidSynth === true)
}

/** One stat block per filled cell, scaled to that cell's own plus-state. */
function blocksOf(
  gearPlan: ReturnType<typeof useGearPlan>['gearPlan'],
  lookup: (key: string) => GearRow | undefined
): Map<PlanSlotId, ItemStatBlock> {
  const out = new Map<PlanSlotId, ItemStatBlock>()
  for (const [cell, planned] of Object.entries(gearPlan.cells)) {
    if (!planned) continue
    const row = lookup(planned.key)
    if (row) out.set(cell as PlanSlotId, cellBlock(row, planned.state))
  }
  return out
}

export function useGearPlanFold(gearPlan: ReturnType<typeof useGearPlan>['gearPlan']): GearPlanFold {
  const { rows } = useGearIndex()
  const { inventory } = usePlannerInventory()
  const { donors } = useDonors()


  // THE SAME CORPUS, KEYED THE OTHER WAY. `donorOf` answers "what is this one row", which is the
  // corpus keyed the ordinary way; `offersOf` answers "what could an extraction from this ITEM be",
  // which is
  // the dump's question — it names a donor item, and one item can carry several effects.
  //
  // `indexDonors` IS THAT FOLD AND IT ALREADY EXISTED. Its own header states this exact case ("an
  // item with a proc AND a click is TWO rows under one key") and the wish list resolves planned
  // sockets through it; a second hand-rolled `key -> rows` map here would be the drift house law 7
  // is about. Only the projection to (effect, socket) is this file's.
  const offersOf = useMemo(() => {
    const byKey = indexDonors(donors)
    return (key: string): readonly { effect: string; socket: SocketType }[] =>
      byKey.get(key)?.map((d) => ({ effect: d.effect, socket: d.socket })) ?? []
  }, [donors])

  // ONE map for the whole corpus, rebuilt only when the corpus is — six thousand rows keyed once
  // rather than a `find` per cell per render.
  const byKey = useMemo(() => new Map(rows.map((r: GearRow) => [r.key, r])), [rows])
  const lookup = useMemo(() => (key: string): GearRow | undefined => byKey.get(key), [byKey])

  return useMemo(() => {
    const blocks = blocksOf(gearPlan, lookup)
    const totals = gearPlanTotals(gearPlan, lookup)

    // NO DUMP MEANS NO DIFF, never a diff against an empty body: "we cannot see what you are
    // wearing" and "you are wearing nothing" are different statements, and the second would make
    // every number on this tab read as a gain.
    const worn = inventory === null ? null : equippedRead(inventory.hosts, 0, offersOf)
    const diff =
      worn === null
        ? null
        : gearPlanDiff(
            { plan: totals, equipped: gearPlanTotals(worn.gearPlan, lookup) },
            { plan: gearPlan, equipped: worn.gearPlan }
          )

    const facts: ItemFacts = {
      classesOf: (key) => lookup(key)?.classes ?? [],
      slotsOf: (key) => lookup(key)?.slots ?? []
    }

    return {
      // The ones the BOARD hands each card, grouped: the view spreads them in one place, and a
      // fourth per-cell reader is then one line here rather than one more prop at the call site.
      board: {
        blockOf: (cell: PlanSlotId): ItemStatBlock | undefined => blocks.get(cell),
        iconOf: (cell: PlanSlotId): number | undefined => {
          const planned = gearPlan.cells[cell]
          return planned === undefined ? undefined : lookup(planned.key)?.iconId
        },
        // COMPARED AT THE TIERS BOTH SIDES ARE ACTUALLY AT: the plan at its planned `+N`, the worn
        // item at the floor its name stated. Anything else compares a merged item to a base one.
        deltaOf: (cell: PlanSlotId): CellDelta[] | null => {
          const mine = scaledOf(gearPlan.cells[cell], lookup)
          const theirs = worn === null ? null : scaledOf(worn.gearPlan.cells[cell], lookup)
          return mine === null || theirs === null ? null : cellDelta(mine, theirs)
        },
        // THE RATIO IS READ SEPARATELY FROM THE DELTA and not folded into it, because it is not one
        // of `GEAR_STAT_KEYS` — it is a quotient of two of them. Same two scaled vectors, asked a
        // second question.
        weaponOf: (cell: PlanSlotId): WeaponRead | null => {
          const mine = scaledOf(gearPlan.cells[cell], lookup)
          const facts = mine === null ? null : weaponFacts(mine)
          if (facts === null) return null
          const theirs = worn === null ? null : scaledOf(worn.gearPlan.cells[cell], lookup)
          return { mine: facts, worn: theirs === null ? null : weaponFacts(theirs) }
        }
      },
      candidateDelta: (key: string, cell: PlanSlotId): CellDelta[] | null => {
        const mine = scaledOf({ key, state: ITEM_UPGRADE_BASE }, lookup)
        const theirs = worn === null ? null : scaledOf(worn.gearPlan.cells[cell], lookup)
        return mine === null || theirs === null ? null : cellDelta(mine, theirs)
      },
      // AT BASE, for the reason `candidateDelta` is: a candidate has no planned tier yet. Which
      // makes the ratio shown here the FLOOR of what the weapon offers, and the cell's own slider
      // the place the rest of that question gets asked.
      candidateWeapon: (key: string, cell: PlanSlotId): WeaponRead | null => {
        const mine = scaledOf({ key, state: ITEM_UPGRADE_BASE }, lookup)
        const facts = mine === null ? null : weaponFacts(mine)
        if (facts === null) return null
        const theirs = worn === null ? null : scaledOf(worn.gearPlan.cells[cell], lookup)
        return { mine: facts, worn: theirs === null ? null : weaponFacts(theirs) }
      },
      facts,
      totals,
      diff,
      unstated: worn?.unstated ?? 0,
      unresolved: worn?.unresolved ?? 0,
      sockets: plannedSockets(gearPlan),
      equipped: worn?.gearPlan ?? null
    }
  }, [gearPlan, lookup, inventory, offersOf])
}

