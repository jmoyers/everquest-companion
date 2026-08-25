// WHICH FOCUS EFFECTS THIS CHARACTER HAS ON (JOS-452) — the main-side resolution behind
// `PlannerInventory.focus`.
//
// It is a THREE-WAY JOIN and nothing else, over sources this app already ships:
//
//   the dump      what is on your body and in your focus sockets
//                 (`shared/planner/inventorySlots.ts focusBearers` — read its header for why the
//                  socket INDEX is what says a socketed exaltation is a focus and not a proc)
//   items.json    that item's `Focus Effect:` line, which carries the effect NAME and nothing else
//   spells.json   that effect's own spell page, which carries the percentage and the level cap
//
// The last hop is the one that makes the whole feature cheap: a focus effect IS a spell page, so
// the magnitudes and the level ranges are already committed bytes. The join is the SAME exact,
// rank-preserving, case-folded name join `effectIndex.ts buildSpellFacts` documents — "Improved
// Healing III" must join "Improved Healing III" or miss, because an item's Effect line names the
// exact spell it carries.
//
// WHAT IT REFUSES, all of it law 1:
//   * an item the corpus has never heard of contributes nothing. That is not hypothetical — the
//     owner's most-announced focus item, `Djarn's Amethyst Ring` (19,291 firings in his log), is
//     MISSING from items.json entirely, so the app cannot say what it does and does not guess.
//   * an effect with no spell page contributes nothing (the Minion/Servant pet families, three bard
//     resonance rows).
//   * an effect whose page states a head this app does not apply contributes nothing —
//     `shared/wornFocus.ts FocusKind` names the seven that are read and not applied, and why.
//
// DEDUPED BY EFFECT NAME. Wearing Improved Damage II on an item AND in that item's own exaltation
// socket is one focus effect, not two: they do not stack (the log shows one announcement per cast),
// and `bestWornFocus` would pick between two identical records anyway. Keeping one keeps the spell
// card's "which item answered" a single honest name. The item on your BODY wins over the socketed
// copy, because that is the one a player will look for first.

import { focusBearers } from '../../shared/planner/inventorySlots'
import type { InventoryDump } from '../../shared/outputs/inventory'
import { parseWornFocus, type WornFocus } from '../../shared/wornFocus'
import type { ItemDbEntry, ItemDbFile } from '../itemsDb'
import { itemKey } from '../itemsDb'
import type { SpellDbFile, SpellEntry } from '../../shared/types'
// The two committed corpora, imported RAW. `effectIndex.ts COMMITTED_SPELL_FACTS` imports the spell
// catalog the same way and for the same reason: this is the effect-name-to-page join and the two
// must key identically. electron-vite inlines each module once however many files import it.
//
// AND THIS FILE STAYS ELECTRON-FREE, which is why the session-aware, dump-memoized accessor lives
// next door in `wornFocusCurrent.ts` rather than here: the node runner drives the join below
// against the committed dump (`tests/wornFocus.test.mts`), and one `import { app }` three modules
// deep would take that away. Same split `shared/planner/inventorySlots.ts` already keeps.
import itemsJson from '../data/items.json'
import spellsJson from '../data/spells.json'

/** The effect-name → its own spell page's slot lines lookup. Case-folded, first entry wins. */
export type FocusLinesIndex = ReadonlyMap<string, readonly string[]>

/**
 * `spells.json` → the focus lookup, on the same terms as `buildSpellFacts`: exact case-folded
 * names, ranks NOT stripped, first row of a repeated name wins.
 *
 * Rows with no effect list at all are skipped rather than stored empty, so a miss and a page that
 * states nothing are the same answer to the caller.
 */
export function buildFocusLines(spells: readonly SpellEntry[]): FocusLinesIndex {
  const out = new Map<string, readonly string[]>()
  for (const s of spells) {
    const key = s.name.trim().toLowerCase()
    if (key === '' || out.has(key) || s.effects === undefined || s.effects.length === 0) continue
    out.set(key, s.effects)
  }
  return out
}

/** The display name the card prints for a bearer: the dump's own spelling of an exaltation. */
function bearerLabel(name: string, exaltation: boolean): string {
  return exaltation ? `${name} (Exaltation)` : name
}

/** Every focus effect one item's corpus record states, read into the shared record. */
function focusOfItem(entry: ItemDbEntry, label: string, lines: FocusLinesIndex): WornFocus[] {
  const out: WornFocus[] = []
  for (const effect of entry.stats?.effects ?? []) {
    if (effect.kind !== 'focus') continue
    const page = lines.get(effect.name.trim().toLowerCase())
    if (page === undefined) continue
    const parsed = parseWornFocus(effect.name, label, page)
    if (parsed !== null) out.push(parsed)
  }
  return out
}

/**
 * THE CHARACTER'S FOCUS EFFECTS, from their newest dump. An empty array is the ordinary answer for
 * a character wearing nothing this app can read, and is never an error.
 *
 * Body first, sockets second, so the dedupe above keeps the worn copy — `focusBearers` walks the
 * dump in file order and the client writes an item before its own sockets, which makes that
 * ordering free rather than something this function has to arrange. It is asserted in the tests
 * anyway, because "free" is a property of the other file.
 */
export function wornFocusFor(
  dump: InventoryDump,
  items: ItemDbFile,
  lines: FocusLinesIndex
): WornFocus[] {
  const byEffect = new Map<string, WornFocus>()
  for (const bearer of focusBearers(dump)) {
    const entry = items.items[itemKey(bearer.name)]
    if (entry === undefined) continue
    for (const focus of focusOfItem(entry, bearerLabel(bearer.name, bearer.exaltation), lines)) {
      const key = focus.effect.toLowerCase()
      if (!byEffect.has(key)) byEffect.set(key, focus)
    }
  }
  return [...byEffect.values()]
}

let lines: FocusLinesIndex | null = null

/** The effect-name lookup, built on first use — the corpus cannot change while the process runs. */
export function committedFocusLines(): FocusLinesIndex {
  lines ??= buildFocusLines((spellsJson as unknown as SpellDbFile).spells)
  return lines
}

/** The committed item corpus, cast once, for the one caller that resolves a live dump against it. */
export const COMMITTED_ITEMS = itemsJson as unknown as ItemDbFile
