// gear/gearCompare.ts — THE COMPARISON (JOS-338): this item, against what is on your body right
// now, in the slots this item would go in.
//
// WHAT THE TAB WAS MISSING. Phase 4 (JOS-285) taught the table to say whether you OWN a candidate;
// it never said what the candidate would REPLACE. "AC 20" is a fact about an item and no help at
// all until it is read beside the 32 already on your chest — and this app is the only thing that
// can put the two numbers side by side, because one of them comes from the player's own
// `/outputfile inventory` dump.
//
// PURE AND NODE-TESTED (`tests/gearCompare.test.mts`), the `gearOwnership.ts` precedent, and for
// the same two reasons: relative value imports so the node runner can drive it with no bundler,
// and every WORD this feature puts on screen decided here rather than inside a component. The card
// (`GearCompareCard.tsx`) owns where a line goes; this file owns what it says.
//
// ---------------------------------------------------------------------------
// THE THREE DECISIONS THIS FILE MAKES
// ---------------------------------------------------------------------------
//
// 1. THE JOIN IS CELL-BY-CELL, NOT SLOT-BY-SLOT. An item states SLOTS (`EquipSlot`, the wiki
//    vocabulary — 'EAR'); a character has CELLS (`PlanSlotId` — 'EAR' and 'EAR2', JOS-67), and the
//    dump is the witness that says there are two of them. So an earring is compared against BOTH
//    ears and a one-hander that states PRIMARY and SECONDARY is compared against both hands. The
//    cells come from `cellsForSlot`, which is the planner's own answer to "where does a FINGER item
//    go" — never a second table here (law 12: cross-source renames are knowledge, and that one is
//    already written down in shared/planner/inventorySlots.ts).
//
//    DEDUPED, IN THE ITEM'S OWN SLOT ORDER. A corpus row may state a slot twice, and two different
//    slots can never share a cell, so one `Set` over the cells is the whole of the dedupe. The order
//    is the ITEM's (PRIMARY before SECONDARY because its page says so) rather than the board's,
//    because the card is read as a sentence about this item.
//
// 2. AN EMPTY CELL IS AN ANSWER, NOT A GAP. The client prints every equipment location it has,
//    filled or not (`Ammo  Empty` is a real line in the committed 295-line dump), and
//    `equippedHosts` drops the empty ones — so a cell with no host is the dump SAYING that place is
//    bare. The card draws it as "nothing equipped", which is the most useful thing a gear planner
//    can tell you: that upgrade costs you nothing. What it never does is draw that sentence when
//    there is NO dump — that is "we cannot see your body", a different statement, and the card
//    answers it with the command instead (law 1).
//
// 3. THE ANY-CELLS ARE NOT COMPARED, AND THAT IS A DECISION RATHER THAN AN OVERSIGHT. A character
//    has two `Any Slot` places (JOS-104) and the owner's own dump wears two CHEST items in them. A
//    cell that constrains no slot is not "the slot this item occupies", so including it would put a
//    breastplate under a hovered RING as if it were the thing being replaced. `cellsForSlot`
//    already declines to return them, so this file inherits the refusal rather than restating it.
//    The cost is honest and stated here: an any-slot item is invisible to this card.
//
// ---------------------------------------------------------------------------
// AND THE COMPARISON ITSELF IS LAW 1, TWICE
// ---------------------------------------------------------------------------
//
// An absent stat means the page STATED none, never zero (`GearStats`), so a delta against an absent
// value is not a number: `HASTE 41% vs —` is what this file writes, and the parenthesised delta
// appears only where BOTH sides stated the key. The second half is the equipped copy's ` +N`: the
// dump states the tier and nothing about the exp banked toward the next one, so the worn item is
// scaled at `{full: tier, fraction: 0}` — a FLOOR on what it reads, and `equippedState` says so in
// one place rather than at each call site.

import { GEAR_STAT_KEYS, type GearStatKey, type GearStats } from '../../../../shared/planner/gear'
import type { PlannerInventoryHost } from '../../../../shared/planner/inventorySlots'
import { cellsForSlot, planSlotLabel, type EquipSlot, type PlanSlotId } from '../../../../shared/planner/types'
import { upgradeStateForTier, type ItemUpgradeState } from '../../../../shared/itemUpgrade'
import { outputAgeLabel } from '../../lib/outputFreshness'
import { statText } from './gearColumns'

// ---- what is worn where ----------------------------------------------------------------------

/** cell → the item the dump names in it. A cell that is absent is a cell the dump says is bare. */
export type EquippedIndex = ReadonlyMap<PlanSlotId, PlannerInventoryHost>

/**
 * The dump's hosts, keyed by the cell they fill.
 *
 * `equippedHosts` already assigns one host per cell (it is what decides which earring is the second
 * one, in the client's own file order), so the FIRST writer of a cell wins here and a second would
 * be a dump this app cannot place — the same "drop it" answer `equippedHosts` gives a third ring.
 */
export function equippedIndex(hosts: readonly PlannerInventoryHost[]): EquippedIndex {
  const out = new Map<PlanSlotId, PlannerInventoryHost>()
  for (const host of hosts) if (!out.has(host.slot)) out.set(host.slot, host)
  return out
}

/** One place this item could go, and what is in it right now. */
export interface EquippedCell {
  cell: PlanSlotId
  /** `planSlotLabel` — `FINGER 1` / `FINGER 2`, `PRIMARY`. The card never spells a cell itself. */
  label: string
  /** what the dump names there; `null` is the dump saying that place is empty (decision 2) */
  host: PlannerInventoryHost | null
}

/**
 * Every cell this item's slots occupy, deduped, in the item's own slot order — see decision 1.
 *
 * The index being EMPTY is not the same question as an item having no slots: a character with no
 * dump has an empty index, and the caller (which knows whether a dump exists at all) is what turns
 * that into either "nothing equipped there" or the command hint.
 */
export function equippedCells(index: EquippedIndex, slots: readonly EquipSlot[]): EquippedCell[] {
  const seen = new Set<PlanSlotId>()
  const out: EquippedCell[] = []
  for (const slot of slots) {
    for (const cell of cellsForSlot(slot)) {
      if (seen.has(cell)) continue
      seen.add(cell)
      out.push({ cell, label: planSlotLabel(cell), host: index.get(cell) ?? null })
    }
  }
  return out
}

/**
 * The plus-state a worn copy reads at — the tier its name states, and NO banked fraction.
 *
 * The dump prints ` +5` and stops; the `x / y` half of the item window's row is not in the file. So
 * this is a FLOOR on what the equipped item actually reads, which is the safe direction for a
 * comparison whose point is "is the candidate better": it can understate the thing you already own,
 * never overstate it.
 *
 * THE READING ITSELF MOVED (JOS-416): `shared/itemUpgrade.ts upgradeStateForTier` is now the one
 * place that turns a dump's ` +N` into a state, because the Character sheet's gear sum reads the
 * same suffix and two spellings of it would be two answers. This stays as the GEAR tab's name for
 * it — the host shape is the planner's — and is byte-identical to what it did before.
 */
export function equippedState(host: PlannerInventoryHost): ItemUpgradeState {
  return upgradeStateForTier(host.tier)
}

// ---- the numbers -------------------------------------------------------------------------------

/** One stat key, as each side states it (or does not), and the difference where both did. */
export interface StatCompare {
  key: GearStatKey
  /** the hovered item's value — absent when its page states the key not at all */
  item?: number
  /** the worn item's value at its own `+N` — absent when its page states none, or none is worn */
  equipped?: number
  /** `item - equipped`, present ONLY when both sides stated the key (law 1) */
  delta?: number
}

/**
 * The comparison, in the corpus's own key order (`GEAR_STAT_KEYS`, which is the order the table
 * draws its columns in — so the card and the row cannot disagree about what comes first).
 *
 * A key is included when EITHER side states it. Two rules cut the noise, and both are about what a
 * hover card is for:
 *   * a key both sides state at the SAME value is left out — nothing changes, and a card listing
 *     twelve identical numbers buries the two that moved;
 *   * …but only when there IS an equipped side. `compareStats(stats, null)` is how the card draws
 *     the item's own stat list, and there every stated key survives.
 */
export function compareStats(item: GearStats, equipped: GearStats | null): StatCompare[] {
  const out: StatCompare[] = []
  for (const key of GEAR_STAT_KEYS) {
    const mine = item[key]
    const theirs = equipped === null ? undefined : equipped[key]
    if (mine === undefined && theirs === undefined) continue
    if (mine !== undefined && theirs !== undefined) {
      if (mine === theirs) continue
      out.push({ key, item: mine, equipped: theirs, delta: mine - theirs })
      continue
    }
    if (mine === undefined) out.push({ key, equipped: theirs })
    else out.push({ key, item: mine })
  }
  return out
}

/** `AC 20`, `HASTE 41%` — one stated stat, in the table's own spelling (`statText`). */
export function statPairText(key: GearStatKey, value: number): string {
  return `${key.replace(/_/g, ' ')} ${statText(value, key)}`
}

/**
 * One comparison line: `AC 20 vs 32 (-12)`, or `HASTE 41% vs none` where one side said nothing.
 *
 * `none` IS THE WORD, not a dash and not a zero. It means exactly what a blank cell means in the
 * table — that page states no such line — and it is spelled out because a comparison is read as a
 * sentence: "41% vs none" cannot be misread the way "41% vs -" can. A signed delta is appended only
 * when the subtraction is defined; see the header's law-1 paragraph.
 */
export function compareText(entry: StatCompare): string {
  const label = entry.key.replace(/_/g, ' ')
  const mine = entry.item === undefined ? 'none' : statText(entry.item, entry.key)
  const theirs = entry.equipped === undefined ? 'none' : statText(entry.equipped, entry.key)
  if (entry.delta === undefined) return `${label} ${mine} vs ${theirs}`
  const sign = entry.delta > 0 ? '+' : ''
  return `${label} ${mine} vs ${theirs} (${sign}${statText(entry.delta, entry.key)})`
}

/** `Thelvorn, Blade of Light +5` — the worn copy as the dump names it, tier and all. */
export function hostText(host: PlannerInventoryHost): string {
  return host.tier === undefined ? host.name : `${host.name} +${String(host.tier)}`
}

// ---- when the dump is from -----------------------------------------------------------------

/**
 * THE FRESHNESS LINE (JOS-253's truth, through its own author).
 *
 * `outputAgeLabel` is the ONE place this app spells the age of an `/outputfile` dump, and this card
 * calls it rather than formatting a second copy — the same reason `gearOwnership.ts` refuses to
 * state an age at all. What the card adds is which clock it is: the dump's own mtime, which is when
 * the PLAYER exported, never when this app read it.
 *
 * WHY THE CARD MAY STATE AN AGE WHEN THE OWNED COLUMN MAY NOT (gearOwnership.ts, rule 4). That rule
 * is about two clocks on ONE surface disagreeing, and the surfaces here are not one: the count line
 * is behind the card, out of the reader's eye, and a floating card that says "what you are wearing"
 * without saying how old that claim is would be the exact failure JOS-253 was filed for. So the card
 * states the EXPORT instant and only that; the read instant stays the count line's business, and
 * both come from the same file's mtime.
 */
export function dumpFreshnessText(exportedAt: number | undefined, now?: number): string {
  return `your inventory dump · ${outputAgeLabel(exportedAt, now)}`
}
