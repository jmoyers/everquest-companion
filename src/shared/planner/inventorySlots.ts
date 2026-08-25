// planner/inventorySlots.ts — WHAT YOU ARE ACTUALLY WEARING, in the planner's own slot vocabulary
// (V7, docs/plans/planner-v2.md).
//
// Two closed sets that describe the same eighteen places on a character and agree about almost
// none of the spellings, because they come from different worlds: `EQUIP_LOCATIONS`
// (shared/outputs/inventory.ts) is what the CLIENT writes into a `/outputfile inventory` dump,
// and `EquipSlot` (./types.ts) is normalized from WIKI tokens. `Fingers` vs `FINGER`, `Any Slot`
// with no wiki counterpart at all.
//
// SO THE JOIN IS A HAND-AUTHORED TABLE (law 12: cross-source renames are knowledge, never fuzzy),
// and the outputs model asked for exactly this in writing when it declined to reconcile the two
// itself. Every one of the twenty client tokens is listed below — the eighteen that name a wiki
// slot, and the two that deliberately name none:
//
//   * `Any Slot` is the client's spelling for a slot-agnostic equipment slot. It is a real place
//     to wear something and it is not one of the eighteen, so it maps to no SLOT rather than to a
//     guess about which slot the wearer meant. JOS-104 gave it what it was always missing — a
//     CELL: `ANY_CELL_LOCATIONS` below routes it to `ANY_CELLS`, and this table still says null,
//     because "names no equip slot" is exactly what is true about it.
//   * `Held` is the same story from the other side: the wiki's PRIMARY/SECONDARY split does not
//     exist in that token, and picking one would be inventing which hand. It gets no cell either —
//     an any-cell would be a lie about where the thing is worn.
//
// AND THE DUMP IS WHERE WE LEARNED HOW MANY OF EACH YOU WEAR (JOS-67, and JOS-104 after it).
// `Ear`, `Wrist` and `Fingers` each print TWICE at top level in the committed 295-line dump —
// which is the game itself stating the pair rule that `PLAN_SLOTS` encodes — and so does
// `Any Slot`, which is the game stating that there are two of those too. The table below is
// unchanged in kind: a client token names a SLOT (or honestly names none), and how many cells
// exist is types.ts's answer, not this table's.
//
// PURE: types plus a fold, no fs and no Electron, so both tsconfigs see it and the node runner
// drives it against the real 295-line dump (`tests/plannerInventory.test.mts`).

import {
  parseItemName,
  PRIMARY_ITEM_SECTION,
  walkEntries,
  type InventoryDump,
  type InventoryEntry
} from '../outputs/inventory'
import type { EquipLocationToken } from '../outputs/inventory'
import { ANY_CELLS, cellsForSlot, type EquipSlot, type PlanSlotId } from './types'
import type { WornFocus } from '../wornFocus'

/**
 * The table. Keys are every member of `EQUIP_LOCATIONS`; a `null` value is a token that names no
 * wiki slot and MUST stay unmapped — see the header. `Record` over the token union rather than a
 * loose map, so a client token added to the outputs model turns this file red instead of silently
 * dropping a slot out of the planner.
 */
export const SLOT_OF_LOCATION: Record<EquipLocationToken, EquipSlot | null> = {
  'Any Slot': null,
  Held: null,
  Ammo: 'AMMO',
  Arms: 'ARMS',
  Back: 'BACK',
  Chest: 'CHEST',
  Ear: 'EAR',
  Face: 'FACE',
  Feet: 'FEET',
  Fingers: 'FINGER',
  Hands: 'HANDS',
  Head: 'HEAD',
  Legs: 'LEGS',
  Neck: 'NECK',
  Primary: 'PRIMARY',
  Range: 'RANGE',
  Secondary: 'SECONDARY',
  Shoulders: 'SHOULDERS',
  Waist: 'WAIST',
  Wrist: 'WRIST'
}

/** One equipped item, in planner terms. */
export interface InventoryHost {
  /** the CELL it fills — the second ear/wrist/ring lands in the pair's second cell (JOS-67) */
  slot: PlanSlotId
  /** the item's own name — ` +N`, `*` and ` (Exaltation)` already split off */
  name: string
  /** the ` +N` merge tier the dump stated; absent means the name carried none, NOT tier 0 */
  tier?: number
}

/**
 * An equipped item joined to the planner's item key — what MAIN serves, because `itemKey` is
 * main's definition (itemsDb.ts) and this module must stay dependency-free.
 */
export interface PlannerInventoryHost extends InventoryHost {
  /** `itemKey(name)` — joins the donor corpus and the host picker */
  key: string
}

/** The answer to "what is this character wearing", with the dump it was read from. */
export interface PlannerInventory {
  /** the dump file that was read — the instructions card names it once it exists */
  path: string
  /** the file's mtime: WHEN THE PLAYER dumped, never when we read it */
  loadedAt: string
  hosts: PlannerInventoryHost[]
  /**
   * THE FOCUS EFFECTS THIS GEAR PUTS IN FORCE (JOS-452), resolved main-side against the committed
   * item corpus and the committed spell catalog. Absent means nothing worn carries one this app can
   * read, which is the answer for most characters and for every dump-less one.
   *
   * It rides HERE rather than on a channel of its own because it is the same fact this payload
   * already answers - what is on your body right now - and because the renderer's re-read on
   * `inventory:autoReloaded` is exactly when it needs to be recomputed. Deleting the whole overlay
   * is deleting this field and the module it names.
   */
  focus?: WornFocus[]
}

/**
 * The client tokens that name an ANY CELL rather than an equip slot (JOS-104). A set of one, and a
 * set rather than an `if` so a second such token — the day the client grows one — is a row added
 * here beside the table, not a condition buried in a function.
 */
export const ANY_CELL_LOCATIONS: ReadonlySet<EquipLocationToken> = new Set<EquipLocationToken>([
  'Any Slot'
])

/**
 * The planner CELLS a row of the dump's Location table could fill, in board order — empty for
 * anything that is not a top-level equipped item with something in it.
 *
 * `path` empty ⇒ top level: a `-Slot<n>` child is a bag's contents or a socketed exaltation, and
 * neither is the thing being worn in that slot. An `Any Slot` row offers BOTH any-cells and the
 * caller takes the first free one, exactly as it does for the second ear.
 */
function cellsForLocation(entry: InventoryEntry): readonly PlanSlotId[] {
  // Only the `Location` table says what is WORN (JOS-185): the dump can carry other item-shaped
  // tables, they all feed held counts, and none of them is the character's body.
  if (entry.section !== PRIMARY_ITEM_SECTION) return []
  if (entry.path.length > 0 || entry.empty) return []
  if (entry.place.kind !== 'equip') return []
  if (ANY_CELL_LOCATIONS.has(entry.place.token)) return ANY_CELLS
  const slot: EquipSlot | null = SLOT_OF_LOCATION[entry.place.token]
  return slot === null ? [] : cellsForSlot(slot)
}

/**
 * The dump → what is equipped, one entry per planner CELL.
 *
 * `Ear`, `Wrist`, `Fingers` and `Any Slot` each appear TWICE at top level, because the character
 * wears two of each. This used to keep the FIRST of each and say so in writing: the plan could only
 * hold one cell per slot type, so the second ring had nowhere to go. JOS-67 gave the paired three
 * their second cell (types.ts `PLAN_SLOTS`), so both rows are now taken, IN THE ORDER THE CLIENT
 * WROTE THEM — the dump still has no column saying which ring is left, and the cells are numbered
 * 1 and 2 rather than named, precisely so the app is not claiming to know.
 *
 * `Any Slot` used to map to no cell at all and contribute nothing, which is the whole of what a
 * v0.12.0 player reported as "missing 2x any slots" (JOS-104). It now takes `ANY_CELLS` on the
 * same terms: two rows, two cells, file order, numbered rather than named.
 *
 * A THIRD row for a place the game only gives two of is still DROPPED — the honest answer to a
 * dump we cannot place, and the reason `filled` gates every take rather than only the pairs.
 */
/**
 * THE SOCKET INDEX A FOCUS EXALTATION SITS IN (JOS-452), and it is MEASURED rather than assumed.
 *
 * A socketed exaltation row is named after the DONOR ITEM (`Face-Slot7  Polished Mithril Mask
 * (Exaltation)`), never after the effect, so the socket NUMBER is the only thing saying WHICH of the
 * donor's effects was moved. Across both of the owner's dumps the numbering is consistent and it
 * matches the planner's own unlock order (`rules.ts` R1: focus +1, click +2, worn +3, proc +4):
 *
 *   -Slot2  ornamentation (cosmetic)          -Slot7  FOCUS
 *   -Slot8  click                             -Slot9  worn            -Slot10  proc
 *
 * Checked donor by donor against `items.json`: SoulFire / Bladestopper / Golem Metal Wand / Boots of
 * the Long Road all sit in Slot8 and all carry a `click` row; Shield of the Stalwart Seas sits in
 * Slot9 with a `worn` row; Ghoulbane and Arydryidriyorn sit in Slot10 with `combat` rows; and every
 * one of the eleven Slot7 rows across the two dumps is an item whose only effect is a `focus`.
 *
 * IT IS SPELLED AS A CONSTANT RATHER THAN "ANY SOCKET" ON PURPOSE. Reading a donor's focus row out
 * of whichever socket it happens to occupy would credit the player with a focus effect from an item
 * socketed for its proc - the exact class of silent over-claim law 1 refuses.
 */
export const FOCUS_SOCKET_INDEX = 7

/** An item whose focus effect is IN FORCE: worn on the body, or socketed in a focus slot. */
export interface FocusBearer {
  /** the item's own name, ` +N` / `*` / ` (Exaltation)` already split off - the corpus join key */
  name: string
  /** true when the effect arrives through an exaltation socket rather than the item on your body */
  exaltation: boolean
}

/**
 * EVERYTHING WEARING A FOCUS EFFECT ON THIS CHARACTER: the equipped items themselves, plus whatever
 * sits in their focus sockets.
 *
 * The socket half is not an extra - it is where the owner's entire damage focus lives. His live dump
 * wears `Triumphant Mask +3` on the face, which has no focus of its own, over a `Polished Mithril
 * Mask (Exaltation)` in `Face-Slot7`, which is Improved Damage II. A reader that walked only
 * `equippedHosts` would report that he has no damage focus at all.
 *
 * ONE LEVEL DEEP AND EQUIPPED ONLY. A `-Slot7` under a BAG (`General 6-Slot4-Slot7`) is an
 * exaltation socketed into an item in a bag, which is not being worn; the `place.kind` test and the
 * single-element path together refuse both it and the bag's own contents. `Any Slot` counts, and
 * has to: the owner wears two of his items there.
 *
 * NO CELL AND NO PAIRING. Unlike `equippedHosts` this answers a question about the CHARACTER rather
 * than about a board, so a third ring in a dump we cannot place is still a focus effect the player
 * has on, and nothing here drops a row for having nowhere to draw it.
 */
export function focusBearers(dump: InventoryDump): FocusBearer[] {
  const out: FocusBearer[] = []
  for (const entry of walkEntries(dump.items)) {
    if (entry.section !== PRIMARY_ITEM_SECTION || entry.empty) continue
    if (entry.place.kind !== 'equip') continue
    const worn = entry.path.length === 0
    const socketed = entry.path.length === 1 && entry.path[0] === FOCUS_SOCKET_INDEX
    if (!worn && !socketed) continue
    out.push({ name: parseItemName(entry.name).base, exaltation: socketed })
  }
  return out
}

export function equippedHosts(dump: InventoryDump): InventoryHost[] {
  const out: InventoryHost[] = []
  const filled = new Set<PlanSlotId>()
  for (const entry of walkEntries(dump.items)) {
    const cell = cellsForLocation(entry).find((c) => !filled.has(c))
    if (cell === undefined) continue
    filled.add(cell)
    const parsed = parseItemName(entry.name)
    const host: InventoryHost = { slot: cell, name: parsed.base }
    if (parsed.tier !== undefined) host.tier = parsed.tier
    out.push(host)
  }
  return out
}
