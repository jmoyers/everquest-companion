// GOLDEN-WINDOW LOOT TESTS — W19/W19b/W20/W21 (Task #47): Dragon Hoard / tradeskill
// depot / combine-upgrade dispositions + stacked loot counts.
//
// METHODOLOGY (same as goldenWindows.test.mts / locurrencyWindows.test.mts): real log
// spans were READ LINE-BY-LINE and extracted verbatim (trimmed to loot+zone lines) via
// tests/extract-loot-fixtures.mjs into tests/fixtures/. Each window replays through the
// REAL parser + LootModule; held counts are asserted through computeHeldCounts — the
// SAME function useProgress uses in production, so the asserted rule IS the shipping rule.
//
// What the windows pin:
//   W19  (Jul 30 22:36–23:06, raw 598500–609900): `… and stored it in your Dragon Hoard`
//        (NO trailing period) → disposition:'hoard', bank-type storage — COUNTS as held.
//   W19b (Aug  1 00:27–00:28, raw 793350–793410): `… stored it in your tradeskill depot`
//        → disposition:'depot' (held), alongside hoard/currency/sold/dashed rows in one
//        9-line span — the whole disposition family side by side.
//   W20  (Jul 19 08:48–09:39, raw 2560–15115): `You looted <item> … to create a <item> +N`
//        → disposition:'combined' + `created`. The looted copy merged with a held copy
//        into the upgrade, so combines are NET-ZERO for held counts (the counting key
//        strips ` +N`, so consumed and created share one key).
//   W21  (Jul 20 19:01–20:34, raw 151440–169545): stacked counts — dashed
//        `--You have looted 2 Bone Chips …--` (kept, counts 2) and sold
//        `You looted 2 Phosphorous Powder … and sold it …` (the old regex swallowed the
//        digits into the item name, minting a bogus "2 Phosphorous Powder" counting key).
//   W33  (Aug  4 21:35–21:37, raw 1315000–1315060, JOS-401): the DESTROY — `You successfully
//        destroyed <N> <Item>.` → disposition:'destroyed', which SUBTRACTS. Three Prayers of
//        Life off Lord Nagafen and one destroyed (held 2); a `Blight, Hammer of the Scourge
//        +1` looted and destroyed on the same counting key; and two destroys of things the
//        window never saw arrive, which floor at 0 instead of going negative.
//   W34  (Aug 12 00:36–00:38, raw 1608330–1608460, JOS-401): destroy meets the stack rule —
//        a `2 Bone Chips` stack, two singles and one auto-SOLD copy (never held) followed by
//        two destroys, all on one counting key inside one zone.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseEvent } from '../src/main/log/parser'
import { LootModule } from '../src/main/modules/loot'
import { computeHeldCounts } from '../src/renderer/src/features/posky/heldCounts'
import type { LootEvent } from '../src/shared/types'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, 'fixtures')

function readFixture(name: string): string[] {
  return readFileSync(join(FIXTURES, name), 'utf8').split(/\r?\n/).filter((l) => l.length > 0)
}

/** Replay raw lines through the real parser + LootModule; return the loot snapshot rows. */
function replayLoot(lines: string[]): LootEvent[] {
  const mod = new LootModule()
  mod.reset()
  let seq = 0
  for (const raw of lines) {
    const ev = parseEvent(raw, seq++)
    if (ev) mod.onEvent(ev)
  }
  return mod.snapshot().state
}

test('W19 Dragon Hoard: stored loots parse as hoard with clean items/sources and count as held', () => {
  const rows = replayLoot(readFixture('w19-hoard.log'))

  // Hand-verified hoard rows in the window (11 total).
  const hoard = rows.filter((r) => r.disposition === 'hoard')
  assert.equal(hoard.length, 11, 'eleven Dragon Hoard loots in the window')

  // The "an" article strips cleanly on a +N item.
  const umbral = rows.find((r) => r.item === 'Umbral Platemail Gauntlets +1')
  assert.ok(umbral, 'Umbral Platemail Gauntlets +1 parsed')
  assert.equal(umbral!.disposition, 'hoard')
  assert.equal(umbral!.source, 'a turmoil toad')

  const bracelet = rows.find((r) => r.item === 'Vermiculated Bracelet +1')
  assert.ok(bracelet && bracelet.disposition === 'hoard' && bracelet.source === 'a decrepit warder')

  // Held counts: hoard is bank-type storage — HELD. Two Blighted Gloves hoard rows → 2;
  // the +N pair (Woven Shadow Gauntlets / +1) folds onto one counting key → 2.
  const held = computeHeldCounts(rows)
  assert.equal(held['blighted gloves'], 2, 'both hoarded Blighted Gloves are held')
  assert.equal(held['woven shadow gauntlets'], 2, 'hoarded base + +1 fold onto one held key')
  // Sold rows in the same window still never count.
  assert.equal(held['fire emerald'] ?? 0, 0, 'auto-sold gems are not held')
  // Ordinary dashed loot in the window is untouched.
  const axe = rows.find((r) => r.item === 'Fluxbladed Axe')
  assert.ok(axe && axe.disposition === undefined, 'dashed kept loot carries no disposition')
  assert.equal(held['fluxbladed axe'], 1)
})

test('W19b tradeskill depot: the whole disposition family side by side in one span', () => {
  const rows = replayLoot(readFixture('w19b-depot.log'))
  assert.equal(rows.length, 9, 'every line in the span is a loot row')

  const blood = rows.find((r) => r.item === 'Griffenne Blood')
  assert.ok(blood, 'Griffenne Blood parsed')
  assert.equal(blood!.disposition, 'depot', 'tradeskill depot → depot')
  assert.equal(blood!.source, 'a soul carrier')

  // Same-span coverage of every other disposition (hand-verified):
  const masks = rows.filter((r) => r.item === "Jester's Mask")
  assert.equal(masks.length, 2, 'two hoarded Jester\'s Masks')
  assert.ok(masks.every((r) => r.disposition === 'hoard' && r.source === 'Keeper of Souls'))
  const azia = rows.find((r) => r.item === 'Wind Rune Azia')
  assert.ok(azia && azia.disposition === 'currency', 'currency rune still parses')
  const stein = rows.find((r) => r.item === 'Stein of Flowing Ichor')
  assert.ok(stein && stein.disposition === 'sold', 'sold-for-free still parses')

  // Held: depot + hoard + currency + dashed count; sold does not.
  const held = computeHeldCounts(rows)
  assert.equal(held['griffenne blood'], 1, 'depot-stored item is held')
  assert.equal(held["jester's mask"], 2)
  assert.equal(held['wind rune azia'], 1)
  assert.equal(held['avian key'], 1)
  assert.equal(held['stein of flowing ichor'] ?? 0, 0)
})

test('W20 combine upgrades: consumed→created parses with `created` and nets zero held', () => {
  const rows = replayLoot(readFixture('w20-combine.log'))

  const combined = rows.filter((r) => r.disposition === 'combined')
  assert.equal(combined.length, 11, 'eleven combine loots in the window')

  // Every combine carries the created upgrade, always `<same base> +N`.
  for (const r of combined) {
    assert.ok(r.created, `${r.item} carries its created item`)
    assert.ok(r.created!.startsWith(r.item), 'created is the same base item')
    assert.match(r.created!, / \+\d+$/, 'created ends in +N')
  }

  // The "an" article strips on BOTH sides of the combine.
  const band = combined.find((r) => r.item === 'Antiqued Silver Band')
  assert.ok(band, 'Antiqued Silver Band combine parsed')
  assert.equal(band!.created, 'Antiqued Silver Band +3')

  // Same-second double combine (09:17:54) → two independent rows.
  const robes = combined.filter((r) => r.item === "Thaumaturgist's Robe")
  assert.equal(robes.length, 3, 'three robe combines (incl. the double-combine second)')
  assert.ok(robes.every((r) => r.created === "Thaumaturgist's Robe +2"))

  // HELD SEMANTICS: a combine merges the looted copy with an already-held copy into the
  // upgrade — net-zero on the (+N-stripped) counting key.
  const held = computeHeldCounts(rows)
  assert.equal(held["thaumaturgist's robe"] ?? 0, 0, 'combine-only item is not over-counted')
  // A dashed KEPT claymore precedes two claymore combines — held stays exactly 1.
  assert.equal(held['bone bladed claymore'], 1, 'held copy stays counted; combines add nothing')
  // A dashed kept `+1` bracer + two bracer combines → still exactly 1 on the folded key.
  assert.equal(held['pristine studded leather bracer'], 1)
  // Ordinary kept loot in the window is unaffected.
  assert.equal(held['mote of infinitesimal potential'], 7)
})

test('W21 stacked counts: the digits are a stack size, not part of the item name', () => {
  const rows = replayLoot(readFixture('w21-stacked.log'))

  // No row ever captures the count into the item name (the old cosmetic defect).
  assert.ok(rows.every((r) => !/^\d/.test(r.item)), 'no item name starts with a digit')

  // Dashed kept stacks: four `2 Bone Chips` + two singular `a Bone Chips` (hand-verified).
  const chips = rows.filter((r) => r.item === 'Bone Chips')
  assert.equal(chips.length, 6, 'six Bone Chips loot rows')
  assert.equal(chips.filter((r) => r.count === 2).length, 4, 'four are 2-stacks')
  assert.ok(chips.every((r) => r.disposition === undefined), 'dashed stacks are ordinary kept loot')

  // Sold stacks: `2 Phosphorous Powder` is Phosphorous Powder ×2, disposition sold.
  const powder = rows.find((r) => r.item === 'Phosphorous Powder')
  assert.ok(powder, 'Phosphorous Powder parsed with a clean name')
  assert.equal(powder!.count, 2)
  assert.equal(powder!.disposition, 'sold')
  const silks = rows.filter((r) => r.item === 'Spider Silk')
  assert.deepEqual(silks.map((r) => r.count).sort(), [2, 2, 4], 'silk stacks keep their sizes')
  assert.ok(silks.every((r) => r.zone === 'The Ruins of Old Guk 2 (Adaptive)'), 'zone carries onto rows')

  // Held: kept stacks add their stack size (4×2 + 2×1 = 10); sold stacks add nothing.
  const held = computeHeldCounts(rows)
  assert.equal(held['bone chips'], 10, 'stacked kept loots count their stack size')
  assert.equal(held['phosphorous powder'] ?? 0, 0, 'sold stacks never count')
  assert.equal(held['spider silk'] ?? 0, 0)
})

// ---- W33 / W34: the destroy, which is the one row on this lane that subtracts (JOS-401) -------

test('W33 destroy: the line parses as a loot row that SUBTRACTS, with no mob in it', () => {
  const rows = replayLoot(readFixture('w33-destroy.log'))

  const destroyed = rows.filter((r) => r.disposition === 'destroyed')
  assert.equal(destroyed.length, 4, 'four destroy lines in the window')
  for (const r of destroyed) {
    assert.equal(r.source, undefined, 'a destroy names no corpse - it happened in your bags')
    assert.equal(r.count, 1, 'the count is always stated, even when it is one')
    assert.ok(!/^\d/.test(r.item), 'the count never leaks into the item name')
  }
  // The ` +N` suffix is kept VERBATIM on the row, exactly as the loot family keeps it; the fold
  // below is where it meets the base name.
  const blight = destroyed.find((r) => r.item === 'Blight, Hammer of the Scourge +1')
  assert.ok(blight, 'the +N suffix survives onto the row')
  // The zone rides along like it does on every other loot row - the destroy happened somewhere.
  assert.ok(rows.every((r) => r.zone === undefined), 'this window opens before any zone line')

  const held = computeHeldCounts(rows)
  assert.equal(held['prayers of life'], 2, 'three looted, one destroyed')
  assert.equal(held['blight, hammer of the scourge'], 0, 'looted and destroyed on ONE counting key')
  // A DESTROY CAN ONLY TAKE WHAT THE LOG SAW YOU HOLDING. Both of these were carried in from
  // before this window, so the key floors at 0 rather than going negative and eating the next one.
  assert.equal(held['backpack'] ?? 0, 0, 'a destroy with no loot behind it floors at 0')
  assert.equal(held['diamond dust'] ?? 0, 0)
  // Untouched neighbours in the same window.
  assert.equal(held['red dragon scales'], 1)
  assert.equal(held['torn, burnt book'], 1)
})

test('W34 destroy meets the stack rule: kept stacks add, sold never counted, destroys subtract', () => {
  const rows = replayLoot(readFixture('w34-destroy-stacks.log'))

  const chips = rows.filter((r) => r.item === 'Bone Chips')
  assert.equal(chips.length, 6, 'four loot rows (one of them sold) and two destroys')
  assert.equal(chips.filter((r) => r.count === 2).length, 1, 'one dashed 2-stack')
  assert.equal(chips.filter((r) => r.disposition === 'sold').length, 1, 'one auto-vendored copy')
  const gone = chips.filter((r) => r.disposition === 'destroyed')
  assert.equal(gone.length, 2)
  assert.ok(gone.every((r) => r.zone === 'The Southern Plains of Karana 2 (Adaptive)'))

  // 2 + 1 + 1 kept, the sold copy never held, then two destroyed.
  const held = computeHeldCounts(rows)
  assert.equal(held['bone chips'], 2, 'four held minus two destroyed')
})

test('the floor is applied PER ROW, so a later loot is a fresh copy and owes an old destroy nothing', () => {
  // Synthetic on purpose, and the header says why the shape is real: it is W33's floor case with
  // one more loot after it. The claim is about the ORDER of the arithmetic, which no single real
  // window in this log happens to spell out, and the rows are the exact shape the parser emits.
  const rows: LootEvent[] = [
    { ts: 1, item: 'Bone Chips' },
    { ts: 2, item: 'Bone Chips', disposition: 'destroyed', count: 3 },
    { ts: 3, item: 'Bone Chips', count: 2 }
  ]
  assert.equal(computeHeldCounts(rows)['bone chips'], 2, 'floor at the destroy, then count forward')
  // max(0, 1 - 3 + 2) would read 0 here, which would silently eat a copy the player just farmed.
})
