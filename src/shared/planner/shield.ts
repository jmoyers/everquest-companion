// planner/shield.ts — DOES THIS ROW READ AS A SHIELD? One rule, shared, because two processes ask.
//
// The corpus states no item-type field, so the answer is a heuristic over what the page DOES
// state, and it says so: a SECONDARY-slot item whose name speaks one of the shield words, or whose
// `Skill:` line reads SHIELD. The slot gate is what keeps a "Shield of…" cloak or a held tome out;
// the word list is what a miss or a false positive gets corrected in. The skill read goes through
// `normalizeSkillToken` — the same fold every other `Skill:` comparison uses — so editor residue on
// the page cannot slip past it.
//
// IT LIVED IN `renderer/features/gear/gearFilter.ts` from 2026-08-15 (fork decision, kaltinril:
// *filter by shields specifically*) and moved here on 2026-08-25 when the gear INDEX started
// answering it at build (`GearRow.shield`, data-server ruling 4): main cannot import a renderer
// feature, and the search word the index folds in and the Weapon-type pick the filter applies must
// be one rule. gearFilter.ts re-exports it, so the filter's test path is unchanged.
//
// MEASURED AGAINST THE PLAN BRANCH'S OTHER SHIELD PREDICATE (2026-08-25, `roleWeights.isShieldLike`:
// slots exactly [SECONDARY], no weapon skill, an AC stated): this rule accepts 130 of the 6,814
// rows, that one 147, and they agree on 120. The ten only THIS rule keeps include seven real
// shields the corpus places in BACK+SECONDARY (Lodizal Shell Shield, Aegis of Life, Shield of the
// Immaculate…), a buckler stating no AC and a shield stating a Piercing skill — real shields the
// slot-and-AC shape misses, which is why the two were not folded into one. The 27 only THAT rule
// keeps are ten "Guard"/"Barrier" shields this word list does not know and seventeen curios with
// an AC (a lute, a stein, a sandal). Neither is perfect; this one errs toward what a player calls
// a shield, and its one known false positive is a Stave of Shielding.

import type { GearRow } from './gear'
import { normalizeSkillToken } from './weaponType'

/** The name spellings that read as a shield. A closed list, so a false positive is one word away. */
const SHIELD_WORDS = ['shield', 'buckler', 'aegis', 'targe', 'bulwark'] as const

export function isShieldLike(row: Pick<GearRow, 'slots' | 'name' | 'skill'>): boolean {
  if (!row.slots.includes('SECONDARY')) return false
  const name = row.name.toLowerCase()
  if (SHIELD_WORDS.some((w) => name.includes(w))) return true
  return normalizeSkillToken(row.skill ?? '') === 'SHIELD'
}
