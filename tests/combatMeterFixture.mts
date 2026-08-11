// THE SYNTHETIC METER FIXTURE — one You row, one pet row, and the builders that make more.
//
// It was inline in tests/combatPetNesting.test.mts until JOS-170 gave the damage meter a SECOND
// pure-derivation test file (the headline over the rows), and two files hand-building the same
// two sources is exactly how two tests come to disagree about what a fight looks like. So it is
// here, in a plain `.mts` the runner does not discover as a spec (`npm test` globs `*.test.mts`),
// and both import it.
//
// WHY THE FIXTURE IS SYNTHETIC AT ALL: everything it feeds is a pure derivation over data the
// engine has ALREADY aggregated — the same footing as tests/combatSlayGrouping.test.mts. The
// engine's own attribution is pinned by fixture replay elsewhere; what these files check is that
// a layout and a headline conserve every number it hands over. The shape was checked against a
// real charmed-pet fight first — combatPetNesting.test.mts's header names the session.

import type { SkillView, SourceView } from '../src/shared/combat'

export function skill(name: string, over: Partial<SkillView> = {}): SkillView {
  return { name, total: 0, pct: 0, hits: 0, crits: 0, max: 0, ...over }
}

export function cat(
  category: SourceView['categories'][number]['category'],
  skills: SkillView[]
): SourceView['categories'][number] {
  return {
    category,
    total: skills.reduce((n, s) => n + s.total, 0),
    pct: 100,
    hits: skills.reduce((n, s) => n + s.hits, 0),
    crits: 0,
    critPct: 0,
    max: Math.max(0, ...skills.map((s) => s.max)),
    resists: 0,
    resistPct: 0,
    skills
  }
}

/**
 * A whole SourceView, derived the way the engine derives one (`main/combat/sourceViews.ts`) — the
 * counters summed from the categories and the three percentages taken from those counters. It is
 * fully populated rather than cast-and-hope because the LEVEL-1 FOLD reads every counter on it:
 * a half-built fixture would have let `meterSources` combine fields nothing ever checked.
 *
 * `dps` divides by 60, which is this fixture's stated fight length — the same divisor the engine
 * uses for every source in one segment (`s.total / durationSec`), which is what makes a headline
 * scaled by a damage fraction exact rather than an approximation.
 */
export function source(
  id: string,
  name: string,
  kind: SourceView['kind'],
  categories: SourceView['categories']
): SourceView {
  const total = categories.reduce((n, c) => n + c.total, 0)
  const hits = categories.reduce((n, c) => n + c.hits, 0)
  const crits = categories.reduce((n, c) => n + c.crits, 0)
  const misses = categories.reduce((n, c) => n + c.skills.reduce((m, s) => m + (s.misses ?? 0), 0), 0)
  const swings = hits + misses
  return {
    id,
    name,
    kind,
    total,
    dps: total / SEG_SECONDS,
    pct: 100,
    hits,
    crits,
    critPct: hits ? (crits / hits) * 100 : 0,
    ambiguousHits: 0,
    ambiguousTotal: 0,
    misses,
    hitPct: swings ? (hits / swings) * 100 : 100,
    missBreakdown: { miss: misses, dodge: 0, parry: 0, riposte: 0, block: 0, absorb: 0 },
    resists: 0,
    resistPct: 0,
    skills: categories.flatMap((c) => c.skills),
    categories
  }
}

/** The fixture segment's length, in seconds — every source's rate divides by it. */
export const SEG_SECONDS = 60

export const YOU = source('you', 'You', 'you', [
  cat('melee', [
    skill('Melee', { total: 5000, hits: 100, max: 120, min: 10, misses: 20 }),
    skill('Backstab', { total: 3000, hits: 20, max: 400, min: 50 })
  ]),
  cat('spell', [skill('Ancient Wrath', { total: 1000, hits: 4, max: 300, min: 200 })])
])

/** A summoned pet's random proper name (law: pets are named Vebarn, Garer, …). */
export const PET = source('pet:7', 'Vebarn', 'pet', [
  cat('melee', [skill('Melee', { total: 7000, hits: 210, max: 90, min: 5, misses: 30 })])
])

/** Pet first, because the engine ranks by damage and the pet out-hits you here. */
export const ENTITIES = [PET, YOU]
