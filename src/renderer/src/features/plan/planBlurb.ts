// planBlurb.ts — THE ONE PARAGRAPH UNDER THE PICKERS THAT SAYS WHAT "GEARING FOR" LOOKS FOR.
//
// Owner ask, 2026-08-22: *"a little section at the top explaining what 'gearing for' targets
// based on the selection ... just above the level suggestions, all the way across the tab but
// below the drop down selections"*. The pickers' hover already carries the long version
// (`PlanView.tsx ROLE_HINT`); this is the short one a reader sees without hovering, and it changes
// with the pick so the tab never shows a build's route under another build's explanation.
//
// TWO SENTENCES, TWO LAYERS (the weights file's own shape): what the FOCUS weighs and which weapon
// shape it takes, then what the picked CLASSES can actually use — the class gate of
// `roleWeights.ts` restated in the player's words, because "your Berserker and Warrior have no mana
// bar, so INT scores nothing" is the sentence that explains why a 10 INT glove stopped appearing.
//
// Pure and node-tested (tests/planBlurb.test.mts): relative value imports, no React.

import type { ClassAbbr } from '../../../../shared/classCombo'
import { CLASS_FACTS, type GearRole, type ManaStat } from '../../../../shared/planner/roleWeights'

/** What each focus weighs, and the weapon shape it takes — one reading per `GearRole`, a `Record` so a new role is a type error here. */
const FOCUS_BLURB: Record<GearRole, string> = {
  balanced:
    'Balanced weighs a little of everything: AC, hit points and saves first, then whatever else an item states. The middle answer when you have no build in mind; any weapon in either hand.',
  tank:
    'Tank weighs staying alive: AC and hit points far above anything else, HP regen for the downtime, and barely a glance at the weapon. Takes only shield-shaped offhands.',
  healer:
    'Healer weighs the mana to keep healing: your casting stat, the mana pool and both regens, with enough AC and hit points to survive being looked at. Any weapon.',
  dps:
    "DPS (any) weighs melee damage with no opinion about weapon shape: the weapon's damage per delay first, then ATK, STR, DEX and any haste you do not already have. Any weapon in either hand.",
  dps1h:
    "1H DPS weighs melee damage: the weapon's damage per delay first, then ATK, STR, DEX and any haste you do not already have. Takes only one-handers in the main hand.",
  dps2h:
    "2H DPS weighs melee damage: the weapon's damage per delay first, then ATK, STR, DEX and any haste you do not already have, with the damage bonus counted higher because a two-hander's grows with its delay. Takes only two-handers and never offers an offhand.",
  dualwield:
    "Dual wield weighs melee damage: the weapon's damage per delay first, then ATK, STR, DEX and any haste you do not already have. Takes only one-handers, in both hands.",
  range:
    "Ranged weighs fighting from the range slot: DEX first (the accuracy stat for bows and throwing), then the weapon's damage per delay, ATK, STR and haste. STR still counts - it feeds attack for every attack type - it just ranks below DEX here, where for a melee build it ranks above. Takes only bows and throwing weapons in the range slot; both hands stay open.",
  dd:
    'Caster DD weighs burst: your casting stat and the mana pool you walk in with, regen second, CHA only if you charm or mez. Any weapon.',
  dot:
    'Caster DoT weighs long fights: your casting stat and mana regen above the raw pool, CHA only if you charm or mez. Any weapon.'
}

/** `['BER', 'WAR']` → "BER and WAR"; one class is itself; three read "BER, WAR and MNK". */
function listOf(classes: readonly ClassAbbr[]): string {
  if (classes.length === 1) return classes[0]
  return `${classes.slice(0, -1).join(', ')} and ${classes[classes.length - 1]}`
}

/**
 * THE CLASS SENTENCE — the gate in the player's words. Empty means no trio picked, which the gate
 * reads as unknown (law 1) and the sentence says so rather than pretending a pick was made.
 */
function classSentence(classes: readonly ClassAbbr[]): string {
  if (classes.length === 0) return 'No class picked, so every stat an item states counts.'
  const mana = new Set<ManaStat>()
  let backstab = false
  for (const abbr of classes) {
    const facts = CLASS_FACTS[abbr]
    if (facts.manaStat !== null) mana.add(facts.manaStat)
    backstab ||= facts.backstab
  }
  const who = listOf(classes)
  const manaPart =
    mana.size === 0
      ? `${who}: no mana bar, so INT, WIS and mana score nothing`
      : `${who}: mana reads ${[...mana].sort().join(' and ')}${mana.size === 1 ? `, so ${mana.has('INT') ? 'WIS' : 'INT'} scores nothing` : ''}`
  return `${manaPart}${backstab ? '; backstab counts' : ''}.`
}

/** The paragraph: the focus, then the class gate. */
export function planBlurb(role: GearRole, classes: readonly ClassAbbr[]): string {
  return `${FOCUS_BLURB[role]} ${classSentence(classes)}`
}
