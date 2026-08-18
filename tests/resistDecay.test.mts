// RECENT EVIDENCE WEIGHS MORE — the arithmetic, and what it does to a real fit (JOS-397).
//
// Two claims, and they are different in kind. The first is that the week bucketing and the decay
// curve are what `shared/resistDecay.ts` says they are: a three-week-old observation counts half, a
// very old one counts the floor and never zero, and a paused log does not decay itself. The second
// is the one that matters to a player — that a mob RETUNED mid-log is followed by the estimate
// within about three weeks of new evidence, which is the whole reason the curve is on the terms at
// all. That one is played out against synthetic rolls, the same way every other claim in this
// feature is: be the server for a moment, print what it would have printed, and ask the estimator.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  RESIST_HALF_LIFE_DAYS,
  RESIST_WEIGHT_FLOOR,
  decayWeight,
  isoWeekKey,
  laterWeek,
  newestWeekOf,
  weekAgeDays,
  weekStart,
  weekStartOfKey,
} from '../src/shared/resistDecay'
import { estimate } from '../src/shared/resistModel'
import { LANDS_ELSEWHERE, SPELLS, blank, playAon, rng } from './resistFixtures.mts'

const DAY = 86_400_000
/** A Wednesday: 2026-08-12T00:00:00Z. Picked deliberately mid-week, so the snapping is visible. */
const WED = Date.UTC(2026, 7, 12)

test('the week bucket is the ISO week, in UTC, and it snaps to Monday', () => {
  // 2026-08-12 is a Wednesday; its week opens on Monday the 10th.
  assert.equal(weekStart(WED), Date.UTC(2026, 7, 10))
  // Every hour of that week answers the same key, which is what makes it a bucket.
  assert.equal(isoWeekKey(WED), isoWeekKey(Date.UTC(2026, 7, 10)))
  assert.equal(isoWeekKey(WED), isoWeekKey(Date.UTC(2026, 7, 16, 23, 59)))
  assert.notEqual(isoWeekKey(WED), isoWeekKey(Date.UTC(2026, 7, 17)))
  // And the key round-trips: the string names the Monday it was folded from.
  assert.equal(weekStartOfKey(isoWeekKey(WED)), Date.UTC(2026, 7, 10))
  assert.equal(weekStartOfKey('not a week'), null)
  assert.equal(weekStartOfKey('2026-W99'), null)
})

test("ISO'S OWN YEAR RULE, because the key is written to disk and compared across builds", () => {
  // 2027-01-01 is a Friday, so its week belongs to 2026 and is that year's week 53.
  assert.equal(isoWeekKey(Date.UTC(2027, 0, 1)), '2026-W53')
  // 2026-01-01 is a Thursday: its own week is week 1 of 2026, and it takes the tail of 2025 with it.
  assert.equal(isoWeekKey(Date.UTC(2026, 0, 1)), '2026-W01')
  assert.equal(isoWeekKey(Date.UTC(2025, 11, 29)), '2026-W01')
  // The format is fixed-width and zero-padded, which is what makes the string compare exact.
  assert.equal(laterWeek('2026-W52', '2027-W01'), '2027-W01')
  assert.equal(laterWeek('2026-W09', '2026-W10'), '2026-W10')
  assert.equal(laterWeek(undefined, '2026-W10'), '2026-W10')
  assert.equal(laterWeek('2026-W10', undefined), '2026-W10')
  assert.equal(laterWeek(undefined, undefined), undefined)
})

test('A THREE-WEEK-OLD ROW WEIGHS HALF, and a very old one weighs the floor (JOS-397)', () => {
  const now = isoWeekKey(WED)
  const weeksAgo = (n: number): string => isoWeekKey(WED - n * 7 * DAY)

  assert.equal(RESIST_HALF_LIFE_DAYS, 21)
  assert.equal(RESIST_WEIGHT_FLOOR, 0.15)

  // This week is undiscounted whatever hour it was observed at - both ends snap to their Monday.
  assert.equal(decayWeight(now, now), 1)
  assert.equal(weekAgeDays(now, now), 0)

  // Three weeks IS the half-life, so it is exactly a half. Not approximately.
  assert.equal(weekAgeDays(weeksAgo(3), now), 21)
  assert.equal(decayWeight(weeksAgo(3), now), 0.5)
  assert.equal(decayWeight(weeksAgo(6), now), 0.25)
  // One week is a third of a half-life.
  assert.ok(Math.abs(decayWeight(weeksAgo(1), now) - Math.pow(0.5, 1 / 3)) < 1e-12)

  // AND HISTORY NEVER VANISHES. Past about eight weeks the curve is under the floor and the floor
  // is what is paid, forever - a creature you fought last spring still knows something.
  assert.equal(decayWeight(weeksAgo(9), now), RESIST_WEIGHT_FLOOR)
  assert.equal(decayWeight(weeksAgo(200), now), RESIST_WEIGHT_FLOOR)

  // Nothing ages backwards, and a row with no week on it is not evidence to discount.
  assert.equal(decayWeight(weeksAgo(-3), now), 1)
  assert.equal(decayWeight(undefined, now), 1)
  assert.equal(decayWeight(now, undefined), 1)
})

test('the newest week is the reference, and it is the ledger-wide one', () => {
  assert.equal(newestWeekOf([{ week: '2026-W30' }, { week: '2026-W33' }, { week: '2026-W31' }]), '2026-W33')
  assert.equal(newestWeekOf([{}, {}]), undefined)
  assert.equal(newestWeekOf([]), undefined)
})

test('A PAUSED LOG DOES NOT DECAY ITSELF: age is measured from the newest observation', () => {
  const old = isoWeekKey(Date.UTC(2026, 0, 7))
  const rows = [blank({ spellKey: 'test hold', family: 'cast', week: old, resist: 20, land: 20 })]
  // Every row is from January, and January is also the newest thing the ledger holds - so nothing
  // is discounted, and the answer is the answer it would have had the week it was gathered.
  const paused = estimate(rows, SPELLS, { axis: 'magic', mobLevel: 50, unobservable: LANDS_ELSEWHERE })
  const fresh = estimate(
    [blank({ spellKey: 'test hold', family: 'cast', week: '2026-W33', resist: 20, land: 20 })],
    SPELLS,
    { axis: 'magic', mobLevel: 50, unobservable: LANDS_ELSEWHERE, newestWeek: '2026-W33' }
  )
  assert.equal(paused.R, fresh.R)
  assert.equal(paused.hi - paused.lo, fresh.hi - fresh.lo)
})

test('DECAY WIDENS AN OLD-ONLY CELL, and that is the honest half of the trade', () => {
  const rows = (week: string): ReturnType<typeof blank>[] => [
    blank({ spellKey: 'test hold', family: 'cast', week, resist: 30, land: 30 }),
  ]
  const opts = { axis: 'magic' as const, mobLevel: 50, unobservable: LANDS_ELSEWHERE, newestWeek: '2026-W33' }
  const now = estimate(rows('2026-W33'), SPELLS, opts)
  const stale = estimate(rows('2026-W20'), SPELLS, opts)

  // The POINT barely moves - the evidence still says the same thing, it just says it less loudly.
  assert.ok(Math.abs(stale.R - now.R) <= 4, `R moved ${String(stale.R - now.R)}`)
  // The INTERVAL widens, because thirteen weeks old is worth the floor and the floor is 15% of a
  // cell. Wide is what "we learned this a season ago" looks like when it is said honestly.
  assert.ok(stale.hi - stale.lo > (now.hi - now.lo) * 1.5, `${String(stale.hi - stale.lo)} vs ${String(now.hi - now.lo)}`)
  // And the COUNTS are untouched: `n` is what a player could count themselves, decayed or not.
  assert.equal(stale.n, now.n)
  assert.equal(stale.nInformative, now.nInformative)
  assert.equal(stale.empirical.total, now.empirical.total)
})

test('A RETUNED MOB IS FOLLOWED WITHIN ABOUT THREE WEEKS OF DATA (the ticket acceptance)', () => {
  // BE THE SERVER, TWICE. Eight weeks of evidence against a mob whose magic resistance was 20, then
  // three weeks against the same mob after a patch put it at 160. Equal volume per week, so nothing
  // about this is the new data simply outnumbering the old.
  const next = rng(97)
  const rows = []
  for (let w = 11; w >= 4; w--) {
    const { resist, land } = playAon(20, 0, 40, next)
    rows.push(blank({ spellKey: 'test hold', family: 'cast', week: weekKey(w), resist, land }))
  }
  for (let w = 3; w >= 1; w--) {
    const { resist, land } = playAon(160, 0, 40, next)
    rows.push(blank({ spellKey: 'test hold', family: 'cast', week: weekKey(w), resist, land }))
  }
  const opts = { axis: 'magic' as const, mobLevel: 50, unobservable: LANDS_ELSEWHERE, newestWeek: weekKey(0) }
  const decayed = estimate(rows, SPELLS, opts)
  // Undecayed, the same rows are eight weeks of 20 against three of 160 and the pooled answer sits
  // nearer the old truth than the new one. This is the defect the ticket describes.
  const flat = estimate(
    rows.map((r) => ({ ...r, week: weekKey(0) })),
    SPELLS,
    opts
  )
  assert.ok(flat.R < 90, `flat fit should still be dragged low, got ${String(flat.R)}`)
  assert.ok(decayed.R > flat.R + 20, `decay should follow the retune: ${String(decayed.R)} vs ${String(flat.R)}`)
  // It does not LEAP to the new truth either, and it should not: the floor keeps eight weeks of
  // contrary evidence in the room, which is what stops one bad evening rewriting a cell.
  assert.ok(decayed.R < 160, `and it stays short of the new truth, got ${String(decayed.R)}`)
})

/** `n` weeks before the reference week. The reference is `weekKey(0)`. */
function weekKey(weeksAgo: number): string {
  return isoWeekKey(WED - weeksAgo * 7 * DAY)
}
