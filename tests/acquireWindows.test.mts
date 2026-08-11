// ACQUISITION TESTS (JOS-144) — every way an item or a coin reaches the player.
//
// METHODOLOGY. The ticket asked the question from the DATA end, not the parser end: sweep the
// owner's live log for every line shape in which an item or currency arrives, then diff that
// inventory against what the cascade actually claims. The sweep (read-only, 2026-08-09,
// eqlog_Primitive_freeport.txt, 1,450,916 lines, plus both eqlog_Primitive_halas.txt siblings,
// the 22 .triage slices and all 100 committed fixtures) found:
//
//   MATCHED, and correct on every line
//     6,216  the `looted` family — dashed keep, sold, hoard, depot, currency, combined. Every
//            disposition matched its clause, every item and source came out clean, no stack
//            count was ever swallowed into an item name, and motes arrive only through the
//            dashed form the family already owns. ZERO wrong dispositions.
//       276  `You have successfully merged two items together …` (itemMerge)
//
//   UNMATCHED — an item or coin arrives and the cascade said `{kind:'unknown'}`
//     4,502  You receive <coins> from the corpse.
//       356  You purchased <n> <item> from <npc> for <coins>.
//        89  You received <coins> from that item.
//        38  <item> has been placed in your inventory!
//        12  You receive <coins> from <npc> for the <item>(s).
//         3  You have fashioned the items together to create something new: <item>.
//         2  Your inventory is full. <item> … added to your overflow items! …
//         1  You receive <coins> .                      (eqlog_Primtive_halas.txt, Jul 21)
//
//   CORRECTLY DECLINED — the sentence is a REFUSAL, nothing reached anybody
//        33  You cannot loot this item no room in your inventory.
//         5  There are no open slots for the held item in your inventory.
//         1  You are too far away to loot that corpse.
//
// The unmatched families are now `coin` / `purchase` / `itemReceived` (src/shared/acquireEvents.ts,
// src/main/log/parseAcquire.ts). The full-log regression gate ran the identical 1,450,000-line
// prefix with the new classifier out and in: all 46 pre-existing kinds byte-identical, `unknown`
// down by exactly 5,002, and no line moved between any two existing kinds.
//
// WHAT THIS FILE ASSERTS. Two committed fixtures already carry three of the families in the
// owner's real bytes, so those are ordinary golden windows. The families no fixture holds are
// pinned by their VERBATIM shapes, quoted from the sweep with the date and log named on each —
// the same "state the provenance in the header" rule the injected-line precedent (JOS-48) set.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseEvent } from '../src/main/log/parser'
import type { CoinEvent, Coins, ItemReceivedEvent, LogEvent, PurchaseEvent } from '../src/shared/logEvents'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, 'fixtures')

function readFixture(name: string): string[] {
  return readFileSync(join(FIXTURES, name), 'utf8').split(/\r?\n/).filter((l) => l.length > 0)
}

function replay(lines: string[]): LogEvent[] {
  const out: LogEvent[] = []
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev) out.push(ev)
  }
  return out
}

/** Parse ONE line. The timestamp is part of the shape, so every quoted line carries its real one. */
function one(raw: string): LogEvent {
  const ev = parseEvent(raw, 1)
  assert.ok(ev, `line did not parse at all: ${raw}`)
  return ev
}

function coins(evs: LogEvent[]): CoinEvent[] {
  return evs.filter((e): e is CoinEvent => e.kind === 'coin')
}

/** Sum a denomination across events, counting ONLY the events that stated it. */
function sum(cs: CoinEvent[], denom: keyof Coins): number {
  return cs.reduce((n, c) => n + (c.coins[denom] ?? 0), 0)
}
function stated(cs: CoinEvent[], denom: keyof Coins): number {
  return cs.filter((c) => c.coins[denom] !== undefined).length
}

test('A1 corpse coin: the whole coin-loot window parses, and an unstated denomination stays unstated', () => {
  // w38-proc-ppm.log is a committed combat window that happens to carry 15 coin-loot lines — the
  // ordinary case, in the owner's real bytes, with every separator style the corpse form uses
  // ("N gold, N silver and N copper", "N silver and N copper", "N platinum, N silver and N copper").
  const cs = coins(replay(readFixture('w38-proc-ppm.log')))
  assert.equal(cs.length, 15)
  assert.ok(cs.every((c) => c.source === 'corpse'))
  // No corpse coin line names a mob — so neither does the event (law 1: the line did not say).
  assert.ok(cs.every((c) => c.npc === undefined && c.item === undefined))

  // Hand-read totals over the window.
  assert.equal(sum(cs, 'platinum'), 31)
  assert.equal(sum(cs, 'gold'), 65)
  assert.equal(sum(cs, 'silver'), 90)
  assert.equal(sum(cs, 'copper'), 49)

  // …and the honesty half: a denomination the line never named is ABSENT, not zero. 5 of the 15
  // lines name no platinum, 4 name no gold, 1 names no silver, and every one names copper.
  assert.equal(stated(cs, 'platinum'), 10)
  assert.equal(stated(cs, 'gold'), 11)
  assert.equal(stated(cs, 'silver'), 14)
  assert.equal(stated(cs, 'copper'), 15)
})

test('A2 destroy payout: `from that item` is its own source, in past tense', () => {
  // w32-item-merge-failures.log carries the two payouts the client prints one second after
  // `You successfully destroyed 1 <item>.` — the only family that says "received", not "receive".
  const cs = coins(replay(readFixture('w32-item-merge-failures.log')))
  assert.equal(cs.length, 2)
  assert.ok(cs.every((c) => c.source === 'item'))
  assert.equal(sum(cs, 'platinum'), 1)
  assert.equal(sum(cs, 'gold'), 13)
  assert.equal(sum(cs, 'silver'), 12)
  assert.equal(sum(cs, 'copper'), 8)
  // The four-denomination line, exactly as written.
  assert.deepEqual(
    cs.find((c) => c.coins.platinum !== undefined)?.coins,
    { platinum: 1, gold: 5, silver: 7, copper: 1 }
  )
})

test('A3 purchase: the FREE form has an empty price and an item name containing " for "', () => {
  // w30-item-merge-run.log carries the one purchase in the committed tree, and it is the awkward
  // one: no price at all (`… from Key Master for .`), which is exactly the shape a greedy capture
  // would turn into a fabricated price.
  const buys = replay(readFixture('w30-item-merge-run.log')).filter(
    (e): e is PurchaseEvent => e.kind === 'purchase'
  )
  assert.equal(buys.length, 1)
  assert.equal(buys[0].item, "Efreeti's Key")
  assert.equal(buys[0].npc, 'Key Master')
  assert.equal(buys[0].count, 1)
  assert.deepEqual(buys[0].price, {})
})

test('A4 the loot family is untouched: every disposition in the depot window still reads the same', () => {
  // The tripwire for the new classifier's cascade position. w19b-depot.log is nine lines holding
  // the whole disposition family side by side; if `classifyAcquire` ever reached a loot sentence
  // first, one of these would change kind.
  const evs = replay(readFixture('w19b-depot.log'))
  const tally = new Map<string, number>()
  for (const e of evs) {
    if (e.kind !== 'loot') continue
    const d = e.disposition ?? 'kept'
    tally.set(d, (tally.get(d) ?? 0) + 1)
  }
  assert.deepEqual([...tally].sort(), [['currency', 2], ['depot', 1], ['hoard', 3], ['kept', 2], ['sold', 1]])
  // …and nothing in that window was claimed by the new family.
  assert.equal(
    evs.filter((e) => e.kind === 'coin' || e.kind === 'purchase' || e.kind === 'itemReceived').length,
    0
  )
})

// ---------------------------------------------------------------------------------------------
// SHAPES WITH NO COMMITTED FIXTURE. Each line below is VERBATIM from the sweep, with the log and
// date it came from. They carry item, NPC and vendor names only — no third party's words — and
// they exist here because the committed fixtures do not hold these families at all.
// ---------------------------------------------------------------------------------------------

test('A5 merchant sale: coin in, and the client (s) plural is not part of the item name', () => {
  // eqlog_Primitive_freeport.txt, Jul 19 / Jul 28. Note the SPACE-separated denominations — the
  // corpse form uses commas and "and", this one uses neither.
  const a = one('[Sun Jul 19 18:32:18 2026] You receive 9 gold 9 silver 4 copper from Klok Sasz for the Ringmail Neckguard(s).')
  assert.equal(a.kind, 'coin')
  assert.deepEqual(a, {
    kind: 'coin', seq: 1, ts: a.ts, raw: a.raw,
    source: 'vendor', coins: { gold: 9, silver: 9, copper: 4 }, npc: 'Klok Sasz', item: 'Ringmail Neckguard'
  })
  // …and an item name full of colons, which a lazier capture would cut in half.
  const b = one('[Tue Jul 28 17:22:39 2026] You receive 9 silver 4 copper from Atvo Siro for the Spell: Illusion: High Elf(s).')
  assert.equal(b.kind === 'coin' ? b.item : undefined, 'Spell: Illusion: High Elf')
  assert.equal(b.kind === 'coin' ? b.npc : undefined, 'Atvo Siro')
})

test('A6 unstated coin: the tutorial banker hands over gold and the line explains nothing', () => {
  // eqlog_Primtive_halas.txt, Tue Jul 21 16:49:13 — one occurrence in the whole tree, straight
  // after `You say, 'Hail, Dar Banker Zlopps'`. Trailing space before the period is REAL.
  const ev = one('[Tue Jul 21 16:49:13 2026] You receive 5 gold .')
  assert.equal(ev.kind, 'coin')
  assert.equal(ev.kind === 'coin' ? ev.source : undefined, 'unstated')
  assert.deepEqual(ev.kind === 'coin' ? ev.coins : undefined, { gold: 5 })
})

test('A7 straight to inventory: the marketplace delivery, including the overflow twin', () => {
  // eqlog_Primitive_freeport.txt, Aug 1 / Jul 31. All 38 deliveries in the log are shop goods;
  // the Bottle of Alternate Adventure is the one whose LANDING already has a kind (`aaPotion`),
  // so the pair now reads delivery -> quaff.
  const a = one('[Sat Aug 01 02:18:30 2026] Weapon Ornamentation Token has been placed in your inventory!') as ItemReceivedEvent
  assert.deepEqual(a, {
    kind: 'itemReceived', seq: 1, ts: a.ts, raw: a.raw, item: 'Weapon Ornamentation Token', via: 'inventory'
  })
  const b = one('[Fri Jul 31 17:12:24 2026] Your inventory is full. Bottle of Alternate Adventure has been added to your overflow items! Type /itemoverflow to view them.') as ItemReceivedEvent
  assert.deepEqual(b, {
    kind: 'itemReceived', seq: 1, ts: b.ts, raw: b.raw, item: 'Bottle of Alternate Adventure', via: 'overflow'
  })
  assert.equal(a.via, 'inventory')
  assert.equal(b.via, 'overflow')
})

test('A8 tradeskill: `fashioned the items together` is an item arriving, and is not an itemMerge', () => {
  // eqlog_Primitive_freeport.txt, Sun Aug 09 12:03:26. Three in the log (Full Gem Bag, Gem
  // Encrusted Casket, Coin of Tash). `itemMerge` is the OTHER sentence — "successfully merged two
  // items together to create a new item: <X>" — and carries a tier; this one carries none.
  const ev = one('[Sun Aug 09 12:03:26 2026] You have fashioned the items together to create something new: Full Gem Bag.')
  assert.deepEqual(ev, {
    kind: 'itemReceived', seq: 1, ts: ev.ts, raw: ev.raw, item: 'Full Gem Bag', via: 'fashioned'
  })
})

test('A9 priced purchases: the double space before the price, colons in the name, a stack of 100', () => {
  // eqlog_Primitive_freeport.txt, Jul 28 / Aug 6. The price clause is introduced by TWO spaces —
  // that is the client's, not a transcription slip.
  const a = one('[Tue Jul 28 17:21:30 2026] You purchased 1 Spell: Illusion: High Elf from Atvo Siro for  2 gold 9 silver 5 copper.')
  assert.deepEqual(a, {
    kind: 'purchase', seq: 1, ts: a.ts, raw: a.raw,
    item: 'Spell: Illusion: High Elf', count: 1, npc: 'Atvo Siro', price: { gold: 2, silver: 9, copper: 5 }
  })
  const b = one('[Thu Aug 06 12:25:39 2026] You purchased 100 Malachite from Pietro Drast for  5 platinum 4 gold.')
  assert.equal(b.kind === 'purchase' ? b.count : undefined, 100)
  assert.deepEqual(b.kind === 'purchase' ? b.price : undefined, { platinum: 5, gold: 4 })
  // The item name that contains " from " and the NPC name that follows it — the pair that pins
  // both lazy captures. Free, so the price is empty.
  const c = one('[Tue Jul 28 12:25:39 2026] You purchased 1 Package for Old Doug from Dougina for .')
  assert.equal(c.kind === 'purchase' ? c.item : undefined, 'Package for Old Doug')
  assert.equal(c.kind === 'purchase' ? c.npc : undefined, 'Dougina')
  assert.deepEqual(c.kind === 'purchase' ? c.price : undefined, {})
})

test('A10 refusals stay unknown: a sentence about NOT getting something is not an acquisition', () => {
  // All three verbatim from eqlog_Primitive_freeport.txt (33 / 5 / 1 occurrences). They are the
  // reason the inventory matcher tests for a trailing "!" and not merely the word "inventory".
  for (const raw of [
    '[Wed Jul 29 21:32:05 2026] You cannot loot this item no room in your inventory.',
    '[Sat Aug 01 01:15:33 2026] There are no open slots for the held item in your inventory.',
    '[Thu Aug 06 23:30:58 2026] You are too far away to loot that corpse.',
    '[Mon Jul 20 19:19:34 2026] You have not received any tells, so you cannot reply.'
  ]) {
    assert.equal(one(raw).kind, 'unknown', raw)
  }
})

test('A11 the chat guard: a stranger quoting the delivery sentence never mints an item', () => {
  // ADVERSARIAL CONTROLS, not log lines — no such line exists in any log here, which is precisely
  // why they are written down. The delivery matcher is the one shape in this family whose SUBJECT
  // is free text at the start of the line, so a quoted copy would otherwise arrive as an item
  // named "Bob says, 'A Sword of Truth". Two independent stops, both exercised:
  //   the ordinary quoted form ends `inventory!'`, so the suffix gate never fires at all;
  //   a form contrived to end exactly at the suffix is stopped by the repo's chat marker (`, '`).
  const quoted = one("[Sat Aug 01 02:18:30 2026] Bob says, 'A Sword of Truth has been placed in your inventory!'")
  assert.equal(quoted.kind, 'unknown')
  const contrived = one("[Sat Aug 01 02:18:30 2026] Bob says, 'mine' and A Sword of Truth has been placed in your inventory!")
  assert.equal(contrived.kind, 'unknown')
})

test('A12 a coin clause must be nothing BUT denominations', () => {
  // The looseness of the unstated form (A6) is bounded by proving the whole capture is coin
  // tokens and separators. Both controls below are adversarial rather than observed: the log has
  // no non-coin `You receive …` sentence today, and this is what keeps a future one out.
  assert.equal(one('[Tue Jul 21 16:49:13 2026] You receive a strange sensation.').kind, 'unknown')
  assert.equal(one('[Tue Jul 21 16:49:13 2026] You receive 5 gold and a warm feeling.').kind, 'unknown')
})

test('A13 every acquisition kind carries the raw line and the parsed timestamp', () => {
  // The generic envelope contract, checked once across the three new kinds so a future field
  // rename cannot quietly drop provenance.
  const raws = [
    '[Sun Jul 19 18:32:18 2026] You receive 9 gold 9 silver 4 copper from Klok Sasz for the Ringmail Neckguard(s).',
    '[Sat Aug 01 02:18:30 2026] Weapon Ornamentation Token has been placed in your inventory!',
    '[Thu Aug 06 12:25:39 2026] You purchased 100 Malachite from Pietro Drast for  5 platinum 4 gold.'
  ]
  for (const raw of raws) {
    const ev = one(raw)
    assert.notEqual(ev.kind, 'unknown', raw)
    assert.equal(ev.raw, raw)
    assert.ok(ev.ts > 0, raw)
  }
})
