// acquireEvents.ts — the ACQUISITION half of the log-event surface: the shapes that carry an
// item or a coin to the player WITHOUT a corpse in the sentence.
//
// Split out of logEvents.ts, which is long past its factoring ceiling (the considerFaction
// precedent, JOS-128). Every name here is re-exported from `@shared/logEvents`, so no importer
// moved and no import path changed.
//
// WHY THESE EXIST (JOS-144, characterize-first). A full-log sweep of the owner's live log
// (eqlog_Primitive_freeport.txt, 1,450,916 lines, read-only 2026-08-09) asked one question of
// every line: does an item or currency reach the player here, and does the parser see it? The
// `looted` family answered for 6,216 lines and was CORRECT on every one — right disposition,
// clean item, clean source. Five families answered YES and were `{kind:'unknown'}`:
//
//     4,502  You receive <coins> from the corpse.            coin off a corpse   -> 'coin'
//       356  You purchased <n> <item> from <npc> for <coins>. merchant buy       -> 'purchase'
//        89  You received <coins> from that item.             destroy payout     -> 'coin'
//        38  <item> has been placed in your inventory!        marketplace claim  -> 'itemReceived'
//        12  You receive <coins> from <npc> for the <item>(s). merchant sell     -> 'coin'
//         3  You have fashioned the items together …          tradeskill combine -> 'itemReceived'
//         2  Your inventory is full. <item> … overflow items! overflow delivery  -> 'itemReceived'
//         1  You receive <coins> .                            NPC coin gift      -> 'coin'
//
// (The last shape is from eqlog_Primtive_halas.txt, Jul 21 — the tutorial banker handing over
// 5 gold. One occurrence in the tree, and OBSERVED rather than imagined, which is the whole
// bar the awaiting-sample law sets.)
//
// COIN IS NOT SUMMED HERE. `Coins` states the denominations the LINE stated and nothing else:
// no total, no conversion. EQ's platinum/gold/silver/copper ladder is not printed anywhere in
// the log, so a total would be a number this repo cannot source (law 1). A consumer that needs
// one declares the rate itself, in the open.

// TYPE-ONLY import of the base envelope from the module that re-exports this one. A type-only
// cycle is erased by the compiler (and by tsx's transform), so nothing circular exists at
// runtime — the same trick that lets the split-out alert/spell sections extend shared bases.
import type { LogEventBase } from './logEvents'

/**
 * The four EQ denominations, each present ONLY when the line named it. `You receive 4 silver
 * from the corpse.` is `{ silver: 4 }` — not `{ platinum: 0, gold: 0, silver: 4, copper: 0 }`,
 * because "the line did not say" and "you got none" are different facts (law 1).
 */
export interface Coins {
  platinum?: number
  gold?: number
  silver?: number
  copper?: number
}

/**
 * Where the coin came from — the clause the line ends with, never an inference:
 *   'corpse'   `You receive 5 gold, 5 silver and 8 copper from the corpse.` — coin loot. The
 *              line names NO mob (unlike every item loot line), so neither does the event.
 *   'item'     `You received 1 gold, 2 silver and 9 copper from that item.` — the payout for a
 *              destroy, printed one second after `You successfully destroyed 1 <item>.`
 *   'vendor'   `You receive 9 gold 9 silver 4 copper from Klok Sasz for the Ringmail Neckguard(s).`
 *              — you sold something. Carries `npc` and `item`.
 *   'unstated' `You receive 5 gold .` — coin arrived and the line said nothing about why.
 */
export type CoinSource = 'corpse' | 'item' | 'vendor' | 'unstated'

/** Currency reaching the player. See CoinSource for the four sentences that produce it. */
export interface CoinEvent extends LogEventBase {
  kind: 'coin'
  source: CoinSource
  coins: Coins
  /** 'vendor' only: who paid you. */
  npc?: string
  /** 'vendor' only: what you sold. The client's `(s)` plural suffix is stripped. */
  item?: string
}

/**
 * How an item arrived when no corpse was involved:
 *   'inventory'  `<item> has been placed in your inventory!` — the marketplace/claim delivery,
 *                and the ONLY straight-to-inventory shape the log prints. All 38 in the owner's
 *                log are shop goods (Bottle of Alternate Adventure ×34, Spacious Rucksack ×2,
 *                Weapon Ornamentation Token, Race Unlock Token) — including the bottle whose
 *                LANDING already has its own kind (`aaPotion`), so the pair now reads
 *                delivery → quaff.
 *   'overflow'   `Your inventory is full. <item> has been added to your overflow items! …` —
 *                the same delivery when there is nowhere to put it. It still reached you.
 *   'fashioned'  `You have fashioned the items together to create something new: <item>.` — a
 *                tradeskill combine. Distinct from `itemMerge`, which is the +N upgrade line.
 */
export type ItemReceivedVia = 'inventory' | 'overflow' | 'fashioned'

/** An item reaching the player outside the loot family. */
export interface ItemReceivedEvent extends LogEventBase {
  kind: 'itemReceived'
  item: string
  via: ItemReceivedVia
}

/**
 * `You purchased 1 Spell: Cancel Magic from Xinari Anara for  1 gold 7 copper.` — an item in
 * and coin out, in one sentence. TWO spacing quirks are real and tolerated: the price clause is
 * introduced by a DOUBLE space, and a free item prints `… from Dougina for .` with no price at
 * all (both measured; the free form is the tutorial's `Package for Old Doug`, whose name also
 * happens to contain " for " and so pins the lazy captures).
 */
export interface PurchaseEvent extends LogEventBase {
  kind: 'purchase'
  item: string
  /** The stack size the line stated. Always present — every observed line names one. */
  count: number
  npc: string
  /** What you paid. EMPTY when the line named no price (the free form above). */
  price: Coins
}
