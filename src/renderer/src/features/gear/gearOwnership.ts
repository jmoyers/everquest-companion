// gear/gearOwnership.ts — THE JOIN (JOS-285, phase 4): do I own this, where is it, at what +N.
//
// This is the phase the feature exists for. A wiki tab can tell you a Cloak of Flames has AC 10;
// only this app can tell you there is one on your back at +2 and another in your bank at base.
// Phase 3 left the seam and named it: `row.key` is `itemKey(name)`, which IS `ownershipKey`, which
// IS the loot history's `itemCountKey` (ownership.ts pins all three together). So the join is a
// map lookup and nothing else — no name matching, no normalising, no second opinion about what a
// ` +N` suffix is.
//
// PURE AND NODE-TESTED (`tests/gearOwnership.test.mts`), the `gearFilter.ts` precedent: relative
// value imports, no React, no IPC. Every WORD this feature puts on screen about ownership is
// decided here, so the wording can be pinned without a DOM — and the wording is most of the work.
//
// ---------------------------------------------------------------------------
// FOUR HONESTY RULES, EACH OF THEM A DECISION THIS FILE MAKES ON PURPOSE
// ---------------------------------------------------------------------------
//
// 1. `+N` IS A FACT, NOT A SUMMARY. Phase 1's design decision — a `+2` in the bank and a base copy
//    equipped are two ROWS under one key — survives all the way to the cell. `ownedFacts` groups
//    by (place, +N) and NEVER folds two plus-states into "you have 2". `Equipped · Bank +2` is
//    what the dump said; "2 owned" is a different, worse sentence that no reader can undo. A place
//    with no stated `+N` renders as the bare place name, because an unsuffixed name said NOTHING
//    and printing `+0` would be this file inventing a plus-state (phase 1, `tier` is optional).
//
// 2. AN `(Exaltation)` ROW IS NOT A COPY. The client files a socketed exaltation under the NAME OF
//    THE ITEM IT CAME FROM: `Feet-Slot7  Golden Efreeti Boots (Exaltation)` is a gem socketed into
//    whatever is on your feet, not a pair of boots. Counting those rows as ownership would tell a
//    player they own an item they consumed to make the gem — the owner's own dump has four of
//    them, one of which (Golden Efreeti Boots) he owns in NO other form. So exaltation rows are
//    counted separately and reported as what they are. `heldCountsFromDump` counts them because
//    its question is "how many rows name this"; this file's question is "can you wear one".
//
// 3. "NOT COUNTED" IS NOT "NOT OWNED". The fold inherits `HELD_KEYRING_CATEGORIES`, so an item
//    sitting only on an `Activated` key ring reads as not-owned here — and the exclusion is stated
//    where the join RENDERS, over the player's own file (`uncountedNote`), rather than being left
//    in a module header the player will never see. The roster is not re-decided here and no second
//    one is written: the day `Activated` graduates in `shared/outputs/inventory.ts`, this note
//    stops appearing on its own.
//
// 4. LOOTED-BUT-NOT-IN-THE-DUMP IS ITS OWN ANSWER, AND IT DOES NOT RESTATE THE DUMP'S AGE. The log
//    is a second witness the dump cannot contradict: it says the item passed through your hands.
//    It may have been sold, traded, consumed into an exaltation — or the dump may simply predate
//    it. That last possibility is REAL and it is already answered on screen by the `/outputfile`
//    freshness line (JOS-253/268, `OutputKindLine`), which knows both instants. So the wording
//    here points AT that line and never states an age of its own; two clocks on one surface is how
//    a surface starts disagreeing with itself.

import type { GearRow } from '../../../../shared/planner/gear'
import {
  ownershipForLootName,
  ownershipIndexFrom,
  type OwnershipEntry,
  type OwnershipPlace,
  type OwnershipRow,
  type UncountedKeyRing
} from '../../../../shared/planner/ownership'

// ---- the facts ------------------------------------------------------------------------------

/** One (place, +N) pair the dump states, and how many copies it states there. */
export interface OwnedFact {
  place: OwnershipPlace
  /** the ` +N` the name stated. ABSENT means it stated none — never `+0` (phase 1's rule). */
  tier?: number
  count: number
}

/** Everything this app can say about one candidate item. */
export interface GearOwnership {
  /** the WEARABLE copies, grouped — exaltation rows are not among them (rule 2) */
  facts: readonly OwnedFact[]
  /** how many `<Item> (Exaltation)` rows the dump names — the gem, not the item (rule 2) */
  exaltations: number
  /** the dump names at least one wearable copy */
  owned: boolean
  /** the log says this item was looted at some point this epoch */
  looted: boolean
  /** looted per the log, and the dump names no copy of it — rule 4 */
  lootedNotInDump: boolean
}

/** Nobody's answer: no dump row, no loot line. Shared so every miss is the same object. */
const NOTHING: GearOwnership = {
  facts: [],
  exaltations: 0,
  owned: false,
  looted: false,
  lootedNotInDump: false
}

export type GearOwnershipMap = ReadonlyMap<string, GearOwnership>

/**
 * The order places are read in, and it is the order a player asks in: what is on me, what is on
 * my person, then the three stores, then the keyring, then the token we could not classify.
 */
const PLACE_ORDER: readonly OwnershipPlace[] = [
  'equipped',
  'inventory',
  'bank',
  'sharedBank',
  'personalDepot',
  'keyring',
  'unknown'
]

/** The words for a place. `unknown` is NAMED as unrecognised rather than folded into a neighbour. */
const PLACE_LABEL: Record<OwnershipPlace, string> = {
  equipped: 'Equipped',
  inventory: 'Inventory',
  bank: 'Bank',
  sharedBank: 'Shared bank',
  personalDepot: 'Depot',
  keyring: 'Keyring',
  unknown: 'Unfiled'
}

export function placeLabel(place: OwnershipPlace): string {
  return PLACE_LABEL[place]
}

/**
 * Rows → the (place, +N) facts they state, ordered and deduped. Exaltation rows are EXCLUDED here
 * and counted by `gearOwnershipOf` instead — rule 2.
 *
 * The grouping key joins on `|`, which no member of the closed `OwnershipPlace` union contains.
 * (Not a NUL: this repo has spelled that byte into a source file twice and had to respell it.)
 */
export function ownedFacts(rows: readonly OwnershipRow[]): OwnedFact[] {
  const groups = new Map<string, OwnedFact>()
  for (const row of rows) {
    if (row.exaltation) continue
    const key = `${row.place}|${row.tier === undefined ? '' : String(row.tier)}`
    const seen = groups.get(key)
    if (seen) seen.count += row.count
    else groups.set(key, row.tier === undefined ? { place: row.place, count: row.count } : { place: row.place, tier: row.tier, count: row.count })
  }
  // Place first (the reading order above), then plus-state ascending with "stated nothing" first:
  // the row that says least is the weakest claim and belongs at the front of the sentence.
  return [...groups.values()].sort(
    (a, b) => PLACE_ORDER.indexOf(a.place) - PLACE_ORDER.indexOf(b.place) || (a.tier ?? -1) - (b.tier ?? -1)
  )
}

/** One key's whole answer, from its dump rows and whether the log ever saw it looted. */
export function gearOwnershipOf(rows: readonly OwnershipRow[], looted: boolean): GearOwnership {
  const facts = ownedFacts(rows)
  return {
    facts,
    // eslint-disable-next-line eqc/no-domain-munging -- JOS-459 cutover ledger item 8: OwnershipRow comes from a corpus still bundled in the renderer (mobs/posky/bosses JSON). Moves behind knowledge queries when that surface cuts over.
    exaltations: rows.reduce((n, r) => n + (r.exaltation ? 1 : 0), 0),
    owned: facts.length > 0,
    looted,
    lootedNotInDump: looted && facts.length === 0
  }
}

/**
 * THE MAP THE TABLE READS, keyed by `row.key`.
 *
 * Both inputs go through `shared/planner/ownership.ts`: the dump half through
 * `ownershipIndexFrom`, and the LOG half through `ownershipForLootName`, which is the surface
 * phase 1 wrote for exactly this — it spells the key with the same `itemTierKey` the index is
 * filed under, so a loot line and a dump row land on one key without this file owning a rule.
 *
 * Built ONCE per (dump, loot history) change, never per keystroke and never per row: ownership
 * moves when the player types `/outputfile inventory` or loots something, and nothing else.
 */
export function gearOwnershipMap(
  entries: readonly OwnershipEntry[],
  lootedNames: Iterable<string>
): GearOwnershipMap {
  const index = ownershipIndexFrom(entries)
  const looted = new Set<string>()
  for (const name of lootedNames) looted.add(ownershipForLootName(index, name).key)

  const out = new Map<string, GearOwnership>()
  for (const [key, rows] of index) out.set(key, gearOwnershipOf(rows, looted.has(key)))
  // A looted key the dump never names has no entry above — and it is the whole point of rule 4.
  for (const key of looted) if (!out.has(key)) out.set(key, gearOwnershipOf([], true))
  return out
}

/**
 * One row's answer, or the shared nothing.
 *
 * It takes `{ key }` rather than a whole `GearRow` since JOS-286: a SET CELL asks the same
 * question about an item it holds by key alone (the corpus row may be gone), and the widening
 * keeps that question going through this file instead of tempting a second `map.get` with its own
 * idea of what a miss means.
 */
export function ownershipFor(map: GearOwnershipMap, row: Pick<GearRow, 'key'>): GearOwnership {
  return map.get(row.key) ?? NOTHING
}

// ---- the words ------------------------------------------------------------------------------

/** `Bank +2`, or `Bank` when the name stated no plus, or `Keyring +1 x2` for two of them. */
export function factText(fact: OwnedFact): string {
  const tier = fact.tier === undefined ? '' : ` +${String(fact.tier)}`
  const many = fact.count > 1 ? ` x${String(fact.count)}` : ''
  return `${placeLabel(fact.place)}${tier}${many}`
}

/**
 * THE CELL. `Equipped +5`, `Equipped · Bank +2`, `Exaltation only`, `Looted`, or nothing at all.
 *
 * The precedence is the strength of the claim: a copy you can wear beats a gem made from one,
 * which beats a line in the log. An empty string is a row the app knows nothing about — which is
 * most of a 6,814-row corpus, and a blank cell is what "nothing to say" looks like (the same rule
 * `statText` applies to an absent stat).
 */
export function ownedCellText(o: GearOwnership): string {
  if (o.facts.length > 0) return o.facts.map(factText).join(' · ')
  if (o.exaltations > 0) return 'Exaltation only'
  if (o.looted) return 'Looted'
  return ''
}

/**
 * The full sentence, as the cell's native `title` (no MUI Tooltip anywhere in this table — JOS-143).
 *
 * The looted arm says WHY it might be missing and points at the `/outputfile` line for the age
 * rather than restating one (rule 4). `''` for a row with nothing to say, so no empty tooltip
 * appears on five thousand rows.
 */
export function ownedCellTitle(o: GearOwnership): string {
  const parts: string[] = []
  if (o.facts.length > 0) {
    parts.push(`Your dump names ${o.facts.map(factText).join(', ')}. Each +N is its own copy, never a total.`)
  }
  if (o.exaltations > 0) {
    parts.push(
      o.exaltations === 1
        ? 'One (Exaltation) row names this item - that is the gem socketed into something, not a copy you can wear.'
        : `${String(o.exaltations)} (Exaltation) rows name this item - those are gems socketed into other items, not copies you can wear.`
    )
  }
  if (o.lootedNotInDump) {
    parts.push(
      'The log says you looted this and your dump names no copy: sold, traded, consumed into an exaltation - or the dump was written before you looted it. The line above says when it was written and when this app read it.'
    )
  } else if (o.looted && o.facts.length > 0) {
    parts.push('The log also saw you loot it.')
  }
  return parts.join(' ')
}

// ---- the exclusion (rule 3) -----------------------------------------------------------------

/**
 * The Activated sentence, said over the PLAYER'S OWN FILE — `null` when their dump has no rows in
 * an uncounted category, which is the common case and deserves no chrome at all.
 *
 * It never names a category this app decided to exclude in the abstract: the list arrives from the
 * fold, which read their dump, so the count is theirs and the wording can be specific.
 */
export function uncountedNote(uncounted: readonly UncountedKeyRing[]): string | null {
  if (uncounted.length === 0) return null
  const parts = uncounted.map((u) => `${String(u.rows)} on ${u.category}`)
  return `Not counted: ${parts.join(', ')}. Those key rings are left out until a dump proves whether they hold copies or receipts - so an item only there reads as not owned here, which is not the same as you not having it.`
}
