// posky/dumpBlindItems.ts — THE QUEST ITEMS NO `/outputfile inventory` CAN EVER SEE (JOS-409).
//
// A Wind Rune is looted straight into the CURRENCY TAB, and the game does not put currency-tab
// items in an inventory dump. That is a GAME FACT and this repo already states it, in the place a
// game fact belongs: `shared/outputs/kinds.ts`, as the last of the `/outputfile inventory` steps —
// the one step "that cannot be fixed by typing anything". Everything here is that same fact, said
// on the two surfaces where a player meets its consequence.
//
// WHY IT NEEDS SAYING AT ALL, and why a fix did not remove the need. JOS-409 fixed the arithmetic
// that was zeroing runes the log HAD seen. It cannot fix the case underneath it: for a rune, the
// log is the ONLY witness there is, so a rune looted before this log begins — a fresh install, a
// deleted log, a character epoch, a log the player rotated — reads 0 and no amount of dumping will
// ever raise it. Three 1.5.0 reporters tried exactly that (`I tried re-exporting my inventory file.
// It doesn't work`, feedback 01M0CVBWRBXZ3DVDY7CMXQ7SXE), because nothing on screen said the file
// they were re-exporting could not answer. A zero has to explain itself, and it has to point at the
// one control that CAN answer: the per-item hand statement (JOS-186's pencil), which is already the
// app's standing answer for an acquisition no witness saw.
//
// THE PREDICATE IS `isCurrencyItem`, borrowed rather than re-spelled. sharedItems.ts has matched
// the currency prefix since Task #44 for the contention map, and a second copy of "what counts as
// currency" is exactly the kind of drift that outlives whoever wrote it.

import { isCurrencyItem } from './sharedItems'

/**
 * Is this quest item one the inventory dump structurally cannot report?
 *
 * Today that is precisely the currency tab, i.e. the Wind Runes, on the same normalized-prefix
 * match the shared-items map uses. Kept as its own named question rather than as a bare call to
 * `isCurrencyItem` because the two ask different things of the same predicate: that one asks "does
 * this item carry a contention signal", this one asks "can the export see it", and the day a second
 * dump-blind storage turns up they stop agreeing.
 */
export function isDumpBlindItem(name: string): boolean {
  return isCurrencyItem(name)
}

/**
 * The caveat on an item ROW, for a hover (JOS-143: no poppers on this tab — a native `title` has no
 * hit area at all).
 *
 * It says the game fact, says what follows from it for this number, and ends on the control that
 * fixes it — in that order, because a player reading it is looking at a count they believe is wrong
 * and the last sentence is the one they act on. Plain dashes, per JOS-106.
 */
export const DUMP_BLIND_ITEM_NOTE =
  'Wind Runes sit in the currency tab, and the game never puts currency-tab items in an /outputfile inventory dump - re-exporting cannot help. Only the looted log can see one, so a rune you already hold reads 0 here if it dropped before this log began. Use the pencil to state how many you hold.'

/**
 * The same fact on the READY tab, where the consequence is a quest that is MISSING rather than a
 * number that is low — so the sentence has to start from the absence the player is staring at.
 *
 * Drawn only while the count source actually reads the export (`countsFromInventory`): under `log`
 * the dump is not consulted for anything and its blindness explains nothing at all.
 */
export const DUMP_BLIND_READY_NOTE =
  'Wind Runes are never in an /outputfile inventory dump - the game leaves currency-tab items out, so only the looted log can count one. If a quest is missing here because its rune reads 0, expand it and state the rune count by hand.'
