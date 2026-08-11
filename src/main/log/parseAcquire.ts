// The ACQUISITION family of the parse cascade (see parser.ts for the ordered list): every
// sentence in which an item or a coin reaches the player WITHOUT a corpse in it.
//
// The loot family (parseWorld.ts) owns the corpse sentences and, measured over the owner's
// whole live log, owns them correctly — 6,216 lines, right disposition on every one. This
// module is what that sweep found NEXT TO them: 5,003 lines of coin and 401 lines of item
// arrival that the cascade had been dropping into `{kind:'unknown'}`. Provenance, counts and
// the per-shape reasoning live on the event types in shared/acquireEvents.ts; the regexes and
// their traps live here.
//
// ONE CLASSIFIER, not three. The cascade runs per line, so each entry costs a probe on every
// line of a 1.4M-line replay; `classifyAcquire` pays a single cheap prefix/suffix gate and only
// then splits by family.

import type { Coins, LogEvent } from '../../shared/logEvents'
import type { ClassifyCtx } from './parseCommon'

// ----- coin -----

/**
 * ONE coin scanner for THREE different separator conventions, all of them real:
 *   corpse/destroy  `1 platinum, 4 gold, 7 silver and 4 copper`   (commas + "and")
 *   vendor sale     `9 gold 9 silver 4 copper`                    (spaces only)
 *   purchase price  `2 platinum 8 gold 3 copper`                  (spaces only, after a
 *                                                                  DOUBLE space)
 * Rather than encode three grammars, the scanner takes every `<digits> <denomination>` pair in
 * order and then PROVES the clause held nothing else: `rest` is what survives removing the
 * pairs, and anything beyond separators (`,`, `and`, whitespace) makes the whole clause decline.
 * That proof is what lets the caller anchor loosely — `You receive <anything> .` cannot be
 * claimed by a sentence that merely starts the same way.
 */
const COIN_TOKEN_RE = /(\d[\d,]*) (platinum|gold|silver|copper)/g
const COIN_SEPARATORS_RE = /^[\s,]*(?:and[\s,]*)*$/

function parseCoins(clause: string): Coins | null {
  const coins: Coins = {}
  let rest = ''
  let last = 0
  let found = 0
  for (const m of clause.matchAll(COIN_TOKEN_RE)) {
    const at = m.index
    rest += clause.slice(last, at)
    last = at + m[0].length
    const amount = Number(m[1].replace(/,/g, ''))
    const denom = m[2] as keyof Coins
    // A denomination stated twice would be a shape nobody has seen; refuse rather than pick.
    if (!Number.isFinite(amount) || coins[denom] !== undefined) return null
    coins[denom] = amount
    found++
  }
  if (found === 0) return null
  rest += clause.slice(last)
  return COIN_SEPARATORS_RE.test(rest) ? coins : null
}

// `You receive 5 gold, 5 silver and 8 copper from the corpse.` — coin loot. The line names no
// mob, so the event names none either.
const COIN_CORPSE_RE = /^You receive (.+?) from the corpse\.$/
// `You received 1 gold, 2 silver and 9 copper from that item.` — the destroy payout. Note the
// PAST tense: this family is the only one that says "received".
const COIN_ITEM_RE = /^You received (.+?) from that item\.$/
// `You receive 9 gold 9 silver 4 copper from Klok Sasz for the Ringmail Neckguard(s).` — a
// merchant paying you. The `(s)` is the client's own plural marker and is not part of the name.
const COIN_VENDOR_RE = /^You receive (.+?) from (.+?) for the (.+)\(s\)\.$/
// `You receive 5 gold .` — coin with no explanation at all, trailing space and all. The loosest
// shape in the file, which is why it is tried LAST and why parseCoins must prove the whole
// capture is denominations: without that proof this pattern would claim any `You receive …`
// sentence the game ever adds.
const COIN_BARE_RE = /^You received? (.+?)\s*\.$/

// ----- item arrival -----

// `Spacious Rucksack has been placed in your inventory!` — the subject is FREE TEXT at the start
// of the line, which is the one genuinely dangerous shape in this module: a chat line quoting
// the sentence would be claimed with the speaker's name glued onto the item. The guard is the
// repo's own chat marker (`, '` — the same one tests/fixture-scrub.mjs drops all quoted speech
// by): a line carrying it is somebody talking, never the client announcing a delivery.
const ITEM_INVENTORY_RE = /^(.+?) has been placed in your inventory!$/
const CHAT_QUOTE_MARKER = ", '"
// `Your inventory is full. Bottle of Alternate Adventure has been added to your overflow items!
//  Type /itemoverflow to view them.` — anchored at both ends on client text, so no guard needed.
const ITEM_OVERFLOW_RE = /^Your inventory is full\. (.+?) has been added to your overflow items!/
// `You have fashioned the items together to create something new: Coin of Tash.`
const ITEM_FASHIONED_RE = /^You have fashioned the items together to create something new: (.+?)\.$/

// ----- purchase -----

// `You purchased 1 Spell: Cancel Magic from Xinari Anara for  1 gold 7 copper.`
// Both captures are LAZY so an item name containing " from " (the tutorial's `Package for Old
// Doug`) and an NPC name containing " for " cannot swallow their delimiters. The price capture
// is greedy and may be EMPTY — the free form prints `… for .`.
const PURCHASE_RE = /^You purchased (\d+) (.+?) from (.+?) for (.*)\.$/

/**
 * The four coin sentences, tried in the order their anchors get looser. The last one
 * (`You receive <coins> .`) would claim anything that starts the same way, so every branch
 * requires parseCoins to PROVE the clause held nothing but denominations before it returns.
 */
function classifyCoin({ text, ts, seq, raw }: ClassifyCtx): LogEvent | null {
  const corpse = COIN_CORPSE_RE.exec(text)
  const corpseCoins = corpse ? parseCoins(corpse[1]) : null
  if (corpseCoins) return { kind: 'coin', seq, ts, raw, source: 'corpse', coins: corpseCoins }

  const item = COIN_ITEM_RE.exec(text)
  const itemCoins = item ? parseCoins(item[1]) : null
  if (itemCoins) return { kind: 'coin', seq, ts, raw, source: 'item', coins: itemCoins }

  const vendor = COIN_VENDOR_RE.exec(text)
  const vendorCoins = vendor ? parseCoins(vendor[1]) : null
  if (vendor && vendorCoins) {
    return { kind: 'coin', seq, ts, raw, source: 'vendor', coins: vendorCoins, npc: vendor[2].trim(), item: vendor[3].trim() }
  }

  const bare = COIN_BARE_RE.exec(text)
  const bareCoins = bare ? parseCoins(bare[1]) : null
  if (bareCoins) return { kind: 'coin', seq, ts, raw, source: 'unstated', coins: bareCoins }
  return null
}

/** The merchant buy. An EMPTY price clause is the free form and is honest as `{}`. */
function classifyPurchase({ text, ts, seq, raw }: ClassifyCtx): LogEvent | null {
  const m = PURCHASE_RE.exec(text)
  if (!m) return null
  // A NON-empty clause that does not parse as denominations is a shape nobody has seen, so the
  // line declines rather than inventing a price of nothing.
  const clause = m[4].trim()
  const price = clause === '' ? {} : parseCoins(clause)
  if (!price) return null
  return { kind: 'purchase', seq, ts, raw, item: m[2].trim(), count: Number(m[1]), npc: m[3].trim(), price }
}

/** The three corpse-less item arrivals. */
function classifyItemArrival({ text, ts, seq, raw }: ClassifyCtx): LogEvent | null {
  if (text.startsWith('You have fashioned ')) {
    const m = ITEM_FASHIONED_RE.exec(text)
    return m ? { kind: 'itemReceived', seq, ts, raw, item: m[1].trim(), via: 'fashioned' } : null
  }
  if (text.startsWith('Your inventory is full. ')) {
    const m = ITEM_OVERFLOW_RE.exec(text)
    return m ? { kind: 'itemReceived', seq, ts, raw, item: m[1].trim(), via: 'overflow' } : null
  }
  if (text.endsWith(' has been placed in your inventory!') && !text.includes(CHAT_QUOTE_MARKER)) {
    const m = ITEM_INVENTORY_RE.exec(text)
    return m ? { kind: 'itemReceived', seq, ts, raw, item: m[1].trim(), via: 'inventory' } : null
  }
  return null
}

/**
 * Every way an item or a coin reaches you that does not name a corpse.
 *
 * CASCADE POSITION (parser.ts): immediately after the loot/item-merge families, whose sentences
 * it must never be offered ahead of. It cannot shadow anything anyway — a full-log replay
 * MEASURED every line this claims as `{kind:'unknown'}` beforehand, and the kind histogram for
 * all 46 pre-existing kinds is byte-identical across the change (tests/acquireWindows.test.mts
 * pins the shapes; the sweep is recorded in the JOS-144 report).
 *
 * ONE cheap gate per family, so a 1.4M-line replay pays three string compares on the lines that
 * are none of these — which is all but 5,002 of them.
 */
export function classifyAcquire(c: ClassifyCtx): LogEvent | null {
  const { text } = c
  if (text.startsWith('You rece')) return classifyCoin(c)
  if (text.startsWith('You purchased ')) return classifyPurchase(c)
  return classifyItemArrival(c)
}
