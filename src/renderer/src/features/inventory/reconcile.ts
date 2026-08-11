import type { CountSource, PoskyQuest } from '@shared/types'
import { itemCountKey } from '../../lib/itemName'
import { questKey } from '../posky/keys'

export interface InventoryRow {
  key: string
  name: string
  /** times looted (from the log) */
  log: number
  /** count in the inventory export */
  inv: number
  /** base held per the active count source, before turn-ins */
  base: number
  /**
   * What the turn-ins ACTUALLY took off this row, which is `base - net` and not the gross
   * `required x times` (JOS-141). Zero when the dump answered this row: a dump already reflects
   * every turn-in, so nothing was taken off it. The rule is argued on `netCount` below.
   */
  consumed: number
  /** net available after turn-ins. Always `base - consumed`. */
  net: number
  /** names of the quests whose turn-ins consumed this item, a quest run twice reading "… x2".
   *  Empty whenever `consumed` is 0, so it never blames a quest for a subtraction that did not
   *  happen. */
  consumedBy: string[]
}

export interface ReconcileInput {
  /** loot counts keyed by lowercased item name */
  log: Record<string, number>
  /** inventory-export counts keyed by lowercased item name */
  inv: Record<string, number>
  /** display names keyed by lowercased item name (from loot events) */
  lootNames: Record<string, string>
  countSource: CountSource
  /**
   * HOW MANY TIMES each quest has been turned in, all time (JOS-131) — quest key → count. A Sky
   * quest can be run again, so this is a count and not a completed-set: a quest handed in twice
   * ate its items twice. Absent/0 means never turned in.
   */
  turnIns: Record<string, number>
  quests: PoskyQuest[]
}

export interface ReconcileResult {
  rows: InventoryRow[]
  /** net held counts (base minus turn-in consumption), keyed lowercased */
  net: Record<string, number>
}

/**
 * Re-key the inventory-export counts onto the normalized counting key so a
 * `Sphinx Claw +1` in the export pools with a base `Sphinx Claw` (Task #42). The
 * `log` map arrives already normalized (useProgress.logCounts), but the raw
 * inventory export names do not, so fold them here (summing collisions).
 *
 * `nameByKey` is filled in place — display names are claimed first-writer-wins, and
 * the call order in `reconcile` (loot names, then export names, then quest item
 * names) is what decides which spelling the user sees.
 */
function foldInventoryByKey(
  inv: Record<string, number>,
  nameByKey: Record<string, string>
): Record<string, number> {
  const invByKey: Record<string, number> = {}
  for (const [rawK, n] of Object.entries(inv)) {
    const k = itemCountKey(rawK)
    invByKey[k] = (invByKey[k] ?? 0) + n
    nameByKey[k] ??= rawK
  }
  return invByKey
}

/**
 * Base held count per key, per the active count source.
 *
 * ============================================================================
 * A DUMP ADDS, IT NEVER SUBTRACTS (JOS-141, owner ruling 2026-08-09).
 * ============================================================================
 *
 * JOS-128 made a loaded dump the BASELINE: it reset the model to what the dump said and let the
 * log accumulate from the generation instant forward. Field-testing Plane of Sky the same day
 * killed it. An `/outputfile inventory` dump only covers WHAT WAS OPEN WHEN IT WAS GENERATED —
 * the bank only if the bank window was up, the hoard likewise (the JOS-132 spike measured this,
 * and shared/outputs/baseline.ts carries the evidence) — and the file never says which storages
 * it spoke for. A reset reads all that silence as zero, so a routine reload made banked Sky items
 * disappear from quests the player was actually ready to hand in.
 *
 * So the combination is FULLY ADDITIVE again, and this is the whole rule:
 *   'log'       all-time looted. Never consults the dump.
 *   'inventory' the dump, exactly as written. Never consults the log.
 *   'both'      `max(log, dump)` per item — whichever source can vouch for more copies.
 *
 * A maximum rather than a sum because the two sources OVERLAP: an item you looted and still have
 * is in both, and adding them would double it. Max is the additive answer for overlapping
 * witnesses — each source is a lower bound on what you hold, and the count is the best lower
 * bound anyone can prove.
 *
 * THE ACCEPTED COST, stated rather than hidden (report P1EY74): a deletion is INVISIBLE. Destroy
 * an item in game and no count goes down, because the log records the loot and never records the
 * destruction (there is no such line — world-model law 6), and a dump that omits it cannot be
 * told apart from a dump that never looked. The owner weighed that against banked items vanishing
 * and chose this one: a count that is too high is a wrong number the user can see and reason
 * about, and a count that is too low is work the user redoes for nothing.
 */
function baseCounts(
  log: Record<string, number>,
  invByKey: Record<string, number>,
  countSource: CountSource
): Record<string, number> {
  const base: Record<string, number> = {}
  for (const k of new Set([...Object.keys(log), ...Object.keys(invByKey)])) {
    const l = log[k] ?? 0
    const i = invByKey[k] ?? 0
    base[k] = countSource === 'log' ? l : countSource === 'inventory' ? i : Math.max(l, i)
  }
  return base
}

/**
 * What the turn-ins ate: counts per item key, plus the quest names that ate it.
 *
 * A quest turned in N times consumed N of everything it requires (JOS-131) — that is the whole
 * mechanism behind "hand it in and the quest drops back to 0/5, ready to farm again". The
 * `consumedBy` caption says the count too, so a row reading `-10 Sphinx Claw` can be traced to
 * one quest run twice rather than looking like a bug.
 */
function questConsumption(
  quests: PoskyQuest[],
  turnIns: Record<string, number>
): { consumed: Record<string, number>; consumedBy: Record<string, string[]> } {
  const consumed: Record<string, number> = {}
  const consumedBy: Record<string, string[]> = {}
  for (const q of quests) {
    const times = turnIns[questKey(q)] ?? 0
    if (times <= 0) continue
    for (const it of q.items) {
      const k = itemCountKey(it.name)
      const need = it.count > 0 ? it.count : 1
      consumed[k] = (consumed[k] ?? 0) + need * times
      ;(consumedBy[k] ??= []).push(times > 1 ? `${q.name} x${String(times)}` : q.name)
    }
  }
  return { consumed, consumedBy }
}

/**
 * The game's own spelling for every Sky quest item, keyed by counting key — the display name of
 * LAST resort before the export's key, and the reason a dump-only row reads `Ivory Sky Diamond`
 * rather than `ivory sky diamond` (JOS-160).
 *
 * AN EXPORT KEY IS A KEY, NOT A SPELLING. `heldCountsFromDump` lowercases every name it folds
 * (shared/outputs/inventory.ts — the key is documented as the raw name LOWERCASED), so the
 * `nameByKey[k] ??= rawK` fallback below was never showing "the export spelling" it reads like: it
 * was showing a lookup key with the capitals rubbed off. That went unnoticed while inventory-only
 * rows were an opt-in tail nobody could search; JOS-160 puts one in a search result and on the item
 * page's breadcrumb, where a lowercased name is simply wrong.
 *
 * It sits BELOW loot names (a loot line carries the game's spelling verbatim, and it is the
 * spelling of the copy this character actually handled) and ABOVE the export key. Scope is
 * deliberately the Sky quest set and nothing wider: it is the data this module already receives,
 * and the committed 11.2k item DB lives in main, behind an exact-name IPC — inventing a renderer
 * copy of it to case-correct a table cell is not a trade this ticket makes.
 */
function questItemNames(quests: PoskyQuest[]): Record<string, string> {
  const names: Record<string, string> = {}
  for (const q of quests) {
    for (const it of q.items) names[itemCountKey(it.name)] ??= it.name
  }
  return names
}

/**
 * ============================================================================
 * THE TURN-IN WINDOW, RE-DECIDED UNDER ADDITIVE SEMANTICS (JOS-141).
 * ============================================================================
 *
 * JOS-131 subtracted only the turn-ins made SINCE the dump was generated, whenever the count
 * source read a dump. That window was a consequence of JOS-128's reset and nothing else: a base of
 * `dump + loot since the dump` already had every pre-dump turn-in taken out of it, so subtracting
 * them again would eat the copy you refarmed afterwards. With the reset gone the window has no
 * argument left, and the generation instant it needed is no longer consulted anywhere.
 *
 * THE WINDOW MOVES FROM TIME TO SOURCE, and JOS-131's own argument is what moves it:
 *
 *   THE LOG is a record of what you have ever LOOTED. It still contains every item any turn-in
 *   ever ate, because nothing removes a line from it. So a log-derived count owes EVERY turn-in,
 *   all time. This is the default count source and the one the Sky refarm story runs on: loot the
 *   claws, hand them in, the count drops back, and the next claw you farm shows.
 *
 *   THE DUMP is an observation of what you are HOLDING. Anything a turn-in ate is already not in
 *   it, whenever that turn-in happened, because the file was written after all of them. So a
 *   dump-derived count owes NOTHING. Subtracting there is double-subtraction, and it fails in the
 *   exact direction this ticket exists to stop: items the player still owns, quietly gone.
 *
 * So each witness is discounted on its own terms and the sources combine as they always do:
 *
 *   'log'        max(0, log - consumed)
 *   'inventory'  dump, untouched
 *   'both'       max(dump, max(0, log - consumed))
 *
 * WHY DISCOUNT-THEN-MAX RATHER THAN MAX-THEN-DISCOUNT: the second is not monotone in your own
 * loot. With a dump of 5, a quest that ate 2 and a log of 4, `max(4,5) - 2` reads 3; loot one more
 * claw and the log wins the max, so the same expression reads 3 again but a further one drops the
 * answer BELOW where it sat. A count that falls when you loot something is indefensible on a
 * screen whose whole job is "how close am I". Discounting first cannot do that: each witness is
 * monotone, and a maximum of monotone witnesses is monotone.
 *
 * The row's `consumed` is therefore what the turn-ins ACTUALLY took off this row (`base - net`),
 * not the gross `required x times`. Those differ exactly when a witness had less than the
 * turn-ins ate, or when the dump floor rescued the row, and reporting the gross figure there
 * would describe a subtraction that did not happen. `net === base - consumed` always.
 */
function netCount(
  countSource: CountSource,
  log: number,
  inv: number,
  consumed: number
): number {
  const fromLog = Math.max(0, log - consumed)
  if (countSource === 'log') return fromLog
  if (countSource === 'inventory') return inv
  return Math.max(inv, fromLog)
}

/** Everything the row build reads, gathered so it travels as one argument. */
interface RowInputs {
  log: Record<string, number>
  invByKey: Record<string, number>
  base: Record<string, number>
  consumed: Record<string, number>
  consumedBy: Record<string, string[]>
  nameByKey: Record<string, string>
  countSource: CountSource
}

/** Apply `netCount` per key and emit the table rows, sorted by what you actually hold. */
function buildRows(x: RowInputs): ReconcileResult {
  const net: Record<string, number> = {}
  const rows: InventoryRow[] = []
  for (const k of new Set([...Object.keys(x.base), ...Object.keys(x.consumed)])) {
    const l = x.log[k] ?? 0
    const i = x.invByKey[k] ?? 0
    const b = x.base[k] ?? 0
    const n = netCount(x.countSource, l, i, x.consumed[k] ?? 0)
    // What the turn-ins actually cost this row. Zero under a dump-reading source the dump itself
    // answered, which is the whole point of the rule above.
    const spent = b - n
    net[k] = n
    // A ROW EXISTS WHENEVER ANY WITNESS VOUCHES FOR THE ITEM (JOS-160), not when the ACTIVE
    // source's base happens to be non-zero.
    //
    // The old test was `b === 0 && spent === 0`, and under the default count source `log` that
    // silently DELETED every item known only to the dump: base is 0 because `log` never consults
    // the export, so the row never reached `rows` at all. The Loot page is the only consumer of
    // `rows`, and its "in inventory only" tail filters them — so a reporter's three Ivory Sky
    // Diamonds, sitting in his `/outputfile inventory` and counted by the Sky tracker, could not be
    // found on the Loot page under any toggle. Two surfaces, one reconcile, opposite answers.
    //
    // `net` IS UNTOUCHED BY THIS — it is written on the line above, before the skip, so the map the
    // quest counting reads is byte-identical whatever this test says. That is exactly why the Sky
    // tracker was right while the Loot page was blind, and it is the regression gate the test pins.
    // What changes is only which rows the TABLE can see, and each row already reports its witnesses
    // separately (`log`, `inv`, `base`, `net`), so a `log`-source row for a dump-only item reads
    // `log: 0, inv: 3, net: 0` — every number honest to its own source.
    if (l === 0 && i === 0 && spent === 0) continue
    rows.push({
      key: k,
      name: x.nameByKey[k] ?? k,
      log: l,
      inv: i,
      base: b,
      consumed: spent,
      net: n,
      consumedBy: spent > 0 ? (x.consumedBy[k] ?? []) : []
    })
  }
  rows.sort((a, b) => b.net - a.net || a.name.localeCompare(b.name))
  return { rows, net }
}

/**
 * Reconcile held items from the loot log and the inventory export, then subtract
 * everything consumed by the quest turn-ins — so a drop that was handed in for one quest no
 * longer counts toward another quest that needs it, and a quest handed in twice has eaten its
 * items twice.
 */
export function reconcile(input: ReconcileInput): ReconcileResult {
  const { log, inv, lootNames, countSource, quests } = input

  // Display-name precedence, highest first: what a loot line called it, then what the quest data
  // calls it, then the export's lowercased key (JOS-160 — see questItemNames).
  const nameByKey: Record<string, string> = { ...questItemNames(quests), ...lootNames }
  const invByKey = foldInventoryByKey(inv, nameByKey)
  const base = baseCounts(log, invByKey, countSource)
  const { consumed, consumedBy } = questConsumption(quests, input.turnIns)

  return buildRows({ log, invByKey, base, consumed, consumedBy, nameByKey, countSource })
}
