// THE ROUTE ENDS AT THE LEVEL CAP (src/shared/planner/planHorizon.ts `LEVEL_CAP`).
//
// The owner read a level-37 route that ran to 73-78 (2026-09-26). Its own file because
// `progressionPlan.test.mts` is at its line budget; the fixtures are the smallest that can state
// the four claims: no bracket opens past the cap, the last one ends on it, difficulty is judged at
// a level the character can be, and what a display cap cut still has somewhere to land.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConBand } from '../src/shared/conBands'
import type { GearRow } from '../src/shared/planner/gear'
import { LEVEL_CAP, bracketsFrom } from '../src/shared/planner/planHorizon'
import {
  buildProgressionPlan,
  type PlanBracket,
  type PlanCorpora,
  type PlanInputs
} from '../src/shared/planner/progressionPlan'
import { zoneLevelKey, type ZoneLevels } from '../src/shared/planner/zoneLevels'

function con(myLevel: number, mobLevel: number): ConBand {
  const diff = mobLevel - myLevel
  if (diff <= -6) return 'trivial'
  if (diff <= -1) return 'safe'
  if (diff <= 1) return 'even'
  if (diff <= 4) return 'risky'
  return 'deadly'
}

const ZONES: ZoneLevels[] = [
  { zone: 'Lower Guk', low: 35, median: 42, sampled: 80 },
  { zone: 'Plane of Sky', low: 55, median: 63, sampled: 60 }
]
const PROFILES = new Map(ZONES.map((z) => [zoneLevelKey(z.zone), z]))
const MOB_LEVELS = new Map<string, number>([
  ['a frenzied ghoul', 42],
  ['a spiroc lord', 63]
])

function ring(n: number, mob: string, zone: string): GearRow {
  const name = `Band ${String(n).padStart(2, '0')}`
  return {
    key: name.toLowerCase(),
    name,
    searchKey: name.toLowerCase(),
    slots: ['FINGER'],
    classes: ['WAR'],
    races: ['ALL'],
    flags: [],
    quest: false,
    playerCrafted: false,
    stats: { AC: 100 - n },
    effects: [],
    wikiSources: [{ mob, zone }]
  }
}

function corpora(gear: GearRow[]): PlanCorpora {
  return {
    gear,
    profiles: PROFILES,
    mobLevel: (name) => MOB_LEVELS.get(name) ?? null,
    con,
    owned: new Set(),
    wished: new Set(),
    ownedBestBySlot: new Map()
  }
}

function inputs(over: Partial<PlanInputs> = {}): PlanInputs {
  return { level: 37, classes: ['WAR'], role: 'balanced', reach: 'solo', eraOnly: false, ...over }
}

const bounds = (route: PlanBracket[]): string[] => route.map((b) => `${String(b.from)}-${String(b.to)}`)
const GHOUL_DROPS = Array.from({ length: 40 }, (_, i) => ring(i, 'a frenzied ghoul', 'Lower Guk'))
const SKY_DROP = ring(99, 'a spiroc lord', 'Plane of Sky')

test('no bracket opens past the cap, and the last one ends on it', () => {
  assert.equal(LEVEL_CAP, 50)
  const route = buildProgressionPlan(inputs(), corpora([...GHOUL_DROPS, SKY_DROP]))
  // THE OWNER'S SCREEN: level 37, six at a time. It ran 37-42 ... 73-78.
  assert.deepEqual(bounds(route), ['37-42', '43-48', '49-50'])
})

test('a low character\'s horizon reaches the cap: levels 1, 2 and 8 end in the bracket holding 50', () => {
  // The old 36-level backstop ended a level-1 route at 37-42, short of the cap and never `last`.
  for (const level of [1, 2, 8]) {
    const all = bracketsFrom({ level })
    const end = all[all.length - 1]
    assert.equal(end.from <= 50 && end.to === 50, true, `level ${String(level)} ends ${String(end.from)}-${String(end.to)}`)
    assert.equal(end.last, true, `level ${String(level)}: the last bracket gets LAST_BRACKET_ROOM`)
  }
})

test('a character AT the cap has one bracket, their own level', () => {
  const route = buildProgressionPlan(inputs({ level: 50 }), corpora(GHOUL_DROPS))
  assert.deepEqual(bounds(route), ['50-50'])
})

test('difficulty is judged at a level the character can be', () => {
  // A level-63 dropper is deadly at 50 and was `safe` in the 67-72 bracket the route used to draw.
  const solo = buildProgressionPlan(inputs(), corpora([SKY_DROP]))
  assert.equal(solo.some((b) => b.targets.some((t) => t.key === SKY_DROP.key)), false)
  assert.equal(solo.some((b) => b.expZones.some((z) => z.zone === 'Plane of Sky')), false)
})

test('what a display cap cut lands in the last bracket, which has room for it', () => {
  // Forty admitted rings from one zone. Every bracket shows its top eight; the ones the first two
  // cut used to surface in brackets past 50. The last bracket now holds four brackets' worth.
  const route = buildProgressionPlan(inputs(), corpora(GHOUL_DROPS))
  assert.deepEqual(route.map((b) => b.targets.length), [8, 8, 24])
  const seen = new Set(route.flatMap((b) => b.targets.map((t) => t.key)))
  assert.equal(seen.size, 40, 'every ring is somewhere on the route, once')
})

test('the cap is an input, so the day the server raises it is one number', () => {
  const route = buildProgressionPlan(inputs({ level: 49, levelCap: 60 }), corpora(GHOUL_DROPS))
  assert.deepEqual(bounds(route), ['49-54', '55-60'])
  // A level above the stated cap is its own cap rather than an empty route.
  const beyond = buildProgressionPlan(inputs({ level: 52 }), corpora(GHOUL_DROPS))
  assert.deepEqual(bounds(beyond), ['52-52'])
})
