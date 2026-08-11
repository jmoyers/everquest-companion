// MOB DROP VARIANT FOLD (JOS-196) — the mob page's drop lines, and the perceived rate they carry.
//
// THE DEFECT, from two reports: a mob that has dropped you a base item, a `+1` and a `+2` filled
// three lines on its page, each claiming `1×`. `MobLootIndex` is right to file them separately —
// it records what the log said — so the fold belongs at the DISPLAY boundary, on the same
// `itemCountKey` every other counting boundary in this app already uses (JOS-66). These cases pin
// that fold, the ORDER the breakdown opens in, the honest display name, and the rate's
// null-not-zero rule at BOTH ends: the derivation, and the formatter that would otherwise round
// a real 0.0033 per kill down to a flat '0.00'.
//
// Pure units — no UI, no Electron. The renderer modules under test are node-importable by repo
// law (relative value imports); `MobSeenDrop` rows are hand-built in the shape
// `MobLootIndex.drops()` returns them (most-looted first, ties by recency).
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldSeenVariants, perceivedDropRate } from '../src/renderer/src/features/mobs/seenVariants'
import { itemVariantLevel } from '../src/renderer/src/lib/itemName'
import { formatDropsPerKill } from '../src/renderer/src/lib/formatRate'
import type { MobSeenDrop } from '../src/shared/types'

const DAY = 86_400_000
const T = 1_754_000_000_000

function row(item: string, count: number, lastTs: number): MobSeenDrop {
  return { item, count, lastTs }
}

test('itemVariantLevel reads the upgrade tier off the one +N parser', () => {
  assert.equal(itemVariantLevel('Sphinx Claw'), 0)
  assert.equal(itemVariantLevel('Sphinx Claw +1'), 1)
  assert.equal(itemVariantLevel('Bloodstar Pendant +12'), 12)
  // Exactly the non-suffixes normalizeItemName leaves alone — one parser, one answer.
  assert.equal(itemVariantLevel('+5 Ring'), 0)
  assert.equal(itemVariantLevel('Sword +'), 0)
  assert.equal(itemVariantLevel('Sword +1a'), 0)
})

test('a base and its +N variants fold into ONE line with the combined count', () => {
  const groups = foldSeenVariants([
    row('Sphinx Claw', 2, T),
    row('Sphinx Claw +1', 1, T + DAY),
    row('Sphinx Claw +2', 1, T - DAY)
  ])
  assert.equal(groups.length, 1, 'three spellings are one item')
  const g = groups[0]
  assert.equal(g.key, 'sphinx claw')
  assert.equal(g.item, 'Sphinx Claw', "the base row's own spelling names the line")
  assert.equal(g.count, 4, '2 + 1 + 1')
  assert.equal(g.lastTs, T + DAY, 'the latest loot across every variant')
  assert.equal(g.hasVariants, true)
  assert.deepEqual(
    g.variants.map((v) => v.item),
    ['Sphinx Claw', 'Sphinx Claw +1', 'Sphinx Claw +2'],
    'the breakdown opens in upgrade order, not in count order'
  )
})

test('nothing is thrown away: every folded row survives with its own count and date', () => {
  const [g] = foldSeenVariants([row('Sphinx Claw', 2, T), row('Sphinx Claw +1', 1, T + DAY)])
  assert.deepEqual(g.variants[0], { item: 'Sphinx Claw', count: 2, lastTs: T })
  assert.deepEqual(g.variants[1], { item: 'Sphinx Claw +1', count: 1, lastTs: T + DAY })
})

test('an unvarianted item is left exactly as it was, with no affordance to open', () => {
  const [g] = foldSeenVariants([row('Wind Rune Geza', 3, T)])
  assert.equal(g.item, 'Wind Rune Geza')
  assert.equal(g.count, 3)
  assert.equal(g.hasVariants, false, 'no toggle on a line that folded nothing')
  assert.equal(g.variants.length, 1)
})

test('a lone +N still says which one it was: base name on the line, affordance to open it', () => {
  // The line has to read `Sphinx Claw` (it is the row that joins the wiki's `Sphinx Claw`), so
  // the ONLY place the `+1` can be stated is the breakdown — which means it must be offered.
  const [g] = foldSeenVariants([row('Sphinx Claw +1', 1, T)])
  assert.equal(g.item, 'Sphinx Claw', 'derived from the variant when no base was ever looted')
  assert.equal(g.hasVariants, true, 'a single variant row is still hiding something')
  assert.deepEqual(g.variants.map((v) => v.item), ['Sphinx Claw +1'])
})

test('groups sort by the COMBINED count, so a fold cannot be seated below a smaller line', () => {
  const groups = foldSeenVariants([
    row('Bone Chips', 3, T),
    row('Sphinx Claw', 2, T),
    row('Sphinx Claw +1', 2, T + DAY)
  ])
  assert.deepEqual(
    groups.map((g) => [g.item, g.count]),
    [
      ['Sphinx Claw', 4],
      ['Bone Chips', 3]
    ],
    'the 4× fold outranks the 3× row it used to sit under as two 2× rows'
  )
})

test('ties break by recency, and casing never splits an item', () => {
  const groups = foldSeenVariants([
    row('Golden Hilt', 1, T),
    row('golden hilt +1', 1, T + DAY),
    row('Wind Rune Geza', 2, T)
  ])
  // Both lines are 2×; the fold's own `lastTs` (the +1, a day later) breaks the tie, which is
  // the same comparator MobLootIndex.drops() applies to the rows before they were folded.
  assert.deepEqual(groups.map((g) => g.item), ['Golden Hilt', 'Wind Rune Geza'])
  assert.equal(groups[0].count, 2, 'a differently-cased variant lands on the same line')
  assert.equal(groups[0].lastTs, T + DAY)
})

test('an empty history folds to nothing at all', () => {
  assert.deepEqual(foldSeenVariants([]), [])
})

test('the perceived rate is null when there is nothing to divide by - never 0', () => {
  assert.equal(perceivedDropRate(3, 42), 3 / 42)
  assert.equal(perceivedDropRate(3, 0), null, 'no recorded kills is an absence, not a rate of 0')
  assert.equal(perceivedDropRate(3, undefined), null, 'the caller may not know the kill count')
  assert.equal(perceivedDropRate(0, 42), null, 'nothing looted states no rate on this line')
})

test('formatDropsPerKill never rounds a real rate down to nothing', () => {
  // The band that made this formatter necessary: every other rate speller in the file renders
  // these as a flat '0.00'.
  assert.equal(formatDropsPerKill(1 / 300), '1 per 300 kills')
  assert.equal(formatDropsPerKill(3 / 42), '1 per 14 kills')
  assert.equal(formatDropsPerKill(0.25), '1 per 4 kills')
  // At or above one drop per two kills the direct reading is the natural one, and a stacking
  // item is allowed to exceed one per kill (the numerator counts items, not corpses).
  assert.equal(formatDropsPerKill(0.5), '0.50 per kill')
  assert.equal(formatDropsPerKill(1), '1.00 per kill')
  assert.equal(formatDropsPerKill(5 / 3), '1.67 per kill')
  // The inverted form can never say "1 per 1 kills".
  for (let n = 0.001; n < 0.5; n += 0.001) {
    assert.ok(!formatDropsPerKill(n).startsWith('1 per 1 kills'), `n=${n}`)
  }
  assert.equal(formatDropsPerKill(0), '-')
  assert.equal(formatDropsPerKill(Number.NaN), '-')
})
