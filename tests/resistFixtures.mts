// The estimator's synthetic world, shared by the two suites that drive it (JOS-387 split
// tests/resistModel.test.mts at the repo's line ceiling).
//
// BEING THE SERVER FOR A MOMENT is what these fixtures are for: `playAon` and `playDd` simulate the
// Live formula for a known R and report exactly what the log would have printed, so a test can feed
// those counts back through `estimate()` and ask whether the number it hands back contains the
// number it was generated from. The random stream is a fixed-seed linear congruential generator, so
// a failure is reproducible and a regression cannot hide behind "it was unlucky".

import type { ResistRow, SpellResistTable } from '../src/shared/resistTypes'

export const FULL_DAMAGE = 150

/** One fixed-damage nuke, one all-or-nothing hold, one lure, one proc, one mez, one malo. */
export const SPELLS: SpellResistTable = {
  'test nuke': {
    axis: 'magic',
    resistAdj: 0,
    castMs: 3000,
    targetType: 5,
    hpSlot: { base: -110, max: FULL_DAMAGE, calc: 103 }
  },
  'test lure': {
    axis: 'fire',
    resistAdj: -200,
    castMs: 3000,
    targetType: 5,
    hpSlot: { base: -110, max: FULL_DAMAGE, calc: 103 }
  },
  'test hold': { axis: 'magic', resistAdj: 0, castMs: 3000, targetType: 5 },
  'test proc': { axis: 'magic', resistAdj: -250, castMs: 0, targetType: 5 },
  'test hold b': { axis: 'magic', resistAdj: 0, castMs: 3000, targetType: 5 },
  'test mez': { axis: 'magic', resistAdj: 0, castMs: 3000, targetType: 8, levelCap: 55 },
  'test malo': {
    axis: null,
    resistAdj: 0,
    castMs: 3000,
    targetType: 5,
    debuffSlots: [{ axis: 'all', base: -20, calc: 101, max: 40 }]
  }
}

/**
 * Every test hands `estimate()` ONE cell's rows. The evidence-symmetry guard is a whole-ledger
 * verdict (resistModel.ts `unobservableSpells`), and a single simulated cell where a mob genuinely
 * resisted every cast looks exactly like a spell we cannot see land. So the tests that are about
 * the MODEL say what the wider ledger knows — that these spells do land elsewhere — and the guard
 * gets its own tests, which say the opposite on purpose.
 */
export const LANDS_ELSEWHERE: ReadonlySet<string> = new Set<string>()

/** A fixed-seed generator: the same failure twice, or it is not a test. */
export function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

const roll = (next: () => number): number => 1 + Math.floor(next() * 200)

export function blank(spec: Partial<ResistRow> & Pick<ResistRow, 'spellKey' | 'family'>): ResistRow {
  return {
    mobKey: 'a test mob',
    casterKind: 'self',
    casterLevel: 50,
    mobLevel: 50,
    debuffs: '',
    rank: 0,
    overchannel: false,
    resist: 0,
    land: 0,
    dmg: {},
    firstTs: 0,
    lastTs: 0,
    ...spec
  }
}

/** Play `n` all-or-nothing casts at this rc and report what the log would have shown. */
export function playAon(
  R: number,
  offset: number,
  n: number,
  next: () => number
): { resist: number; land: number } {
  const rc = R + offset
  let resist = 0
  for (let i = 0; i < n; i++) {
    if (roll(next) <= rc) resist++
  }
  return { resist, land: n - resist }
}

/** Play `n` fixed-damage casts at this rc: the resist message, a silent partial, or full damage. */
export function playDd(
  R: number,
  offset: number,
  n: number,
  next: () => number
): { resist: number; dmg: Record<string, number> } {
  const rc = R + offset
  let resist = 0
  const dmg: Record<string, number> = {}
  for (let i = 0; i < n; i++) {
    const r = roll(next)
    if (r > rc) {
      dmg[String(FULL_DAMAGE)] = (dmg[String(FULL_DAMAGE)] ?? 0) + 1
      continue
    }
    const resisted = (150 * (rc - r)) / rc
    if (resisted >= 100) {
      resist++
      continue
    }
    const value = Math.max(1, Math.floor((FULL_DAMAGE * (100 - resisted)) / 100))
    dmg[String(value)] = (dmg[String(value)] ?? 0) + 1
  }
  return { resist, dmg }
}
