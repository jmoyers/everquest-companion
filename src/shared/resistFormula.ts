// THE GAME'S OWN RESIST FORMULA, forward (JOS-382; split out of resistModel.ts by JOS-385).
//
// Pure, and DEPENDENCY-FREE except for the axis vocabulary. Everything here is a statement about
// what the SERVER does with a roll; nothing here fits anything. The estimator that inverts it lives
// next door in `resistModel.ts`, and the split is along that seam rather than along file size: this
// half can be read, checked against Torven's tables and argued about without knowing what a profile
// likelihood is, and the other half changes when our statistics change rather than when the game
// does.
//
// (The proximate cause was JOS-385 pushing resistModel.ts past the repo's 400-code-line ceiling.
// The rule there is SPLIT, never ratchet — and a file that had grown two subjects was the reason it
// crossed at all.)
//
// ---------------------------------------------------------------------------------------------
// THE MODEL, in one block (Torven's data analysis + Prathun's leaked pseudocode, as reproduced in
// EQEmu's `Mob::ResistSpell`; Legends runs the Live client/server, so this is the model until the
// log contradicts it — and section 3 of docs/plans/resist-mining.md is the measurement that says it
// does not):
//
//     d        = mobLevel - casterLevel, clamped to >= -9;  d >= 21 => the mob is IMMUNE
//     levelMod = sign(d) * d^2 / 2
//     rc       = R[axis] + levelMod + spell.resistAdj - debuff
//     roll     = 1..200, uniform
//
//   ALL-OR-NOTHING (mez, root, snare, slow, charm, DoTs, debuffs, and every bard song pulse):
//     lands iff roll > rc.                       P(resist) = rc/200
//   DIRECT DAMAGE:
//     roll > rc            -> full damage        P(full)   = (200 - rc)/200
//     roll <= rc/3         -> the resist MESSAGE P(resist) = rc/600
//     in between           -> a SILENT partial, `100 - 150*(rc-roll)/rc` percent of full
//
// So rc >= 200 means nothing all-or-nothing can ever land, and rc >= 600 means even a nuke is
// immune — which is why lures carry -300/-1000 resist adjusts.

import type { ResistAxis, ResistBenchmark, ResistGuidance, ResistTag } from './resistTypes'

/** A mob this many levels above the caster is immune, whatever its resist stat is. */
export const IMMUNE_LEVEL_GAP = 21
/** What `levelMod` reports for that case: large enough that no R can rescue the roll. */
export const IMMUNE_LEVEL_MOD = 1000

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

/**
 * `levelMod = sign(d) * d^2 / 2`, d clamped at -9 below and answering IMMUNE at +21.
 * Integer arithmetic, because the server's is.
 */
export function levelMod(casterLevel: number, mobLevel: number): number {
  const raw = mobLevel - casterLevel
  if (raw >= IMMUNE_LEVEL_GAP) return IMMUNE_LEVEL_MOD
  const d = raw < -9 ? -9 : raw
  const mag = Math.trunc((d * d) / 2)
  return d < 0 ? -mag : mag
}

/**
 * A SPELL WITH A RESIST ADJUST BELOW THIS CANNOT BE RESISTED, so watching it land says nothing
 * about the mob (JOS-385, defect 2's sibling — the owner found both on one card).
 *
 * `rc = R + levelMod + resistAdj`, and a resist needs `roll <= rc` out of 1..200. At -250 the mob
 * would need R above about 250 before a single roll could catch it, which is past the top of the
 * tag scale — so a proc's 87 unresisted casts are not 87 pieces of evidence that the mob is weak,
 * they are one sentence: "R is not enormous". Its likelihood is flat across almost the whole grid.
 *
 * -100 IS THE LINE, and it is drawn where the log's own spells fall rather than at a round number
 * that happens to be tidy. This app's procs run -150 (Divine Might Strike), -200 (Lifetap Strike)
 * and -250 (Smiting Strike); lures run -300 to -1000; ordinary nukes and every all-or-nothing
 * spell run 0. Nothing in the owner's two-million-line log sits between -100 and -150, so the
 * threshold separates the two populations without cutting through either.
 *
 * WHAT IT CHANGES IS WHAT IS SHOWN, NOT WHAT IS FITTED. Those observations still enter the
 * likelihood — "R is not enormous" is true and worth having — but they no longer inflate the count
 * a player reads, no longer suppress the low-samples caveat, and no longer head the evidence list.
 * A card that said `n=83` off 83 casts that could never have been resisted was overstating what it
 * knew by an order of magnitude.
 */
export const INFORMATIVE_RESIST_ADJ = -100

/**
 * Could this spell have been resisted at all? See `INFORMATIVE_RESIST_ADJ`.
 *
 * IT TAKES THE SPELL'S OWN ADJUST AND NOT THE EFFECTIVE ONE, which is a deliberate line rather
 * than an oversight now that JOS-387 has given a cast an upgrade rank and an invocation. An
 * overchannel cast of an ordinary nuke computes to -150 effective, which would fall the wrong side
 * of this threshold and quietly retire most of a player's evidence — and it would be the wrong
 * verdict anyway, because whether a roll could have caught the cast depends on R and the level gap
 * too (`rc = R + levelMod + adj`), not on the adjust alone. This threshold is a cheap, spell-level
 * statement about the -150/-200/-250 procs and the -300/-1000 lures, whose casts can never be
 * resisted at ANY R this scale reaches, and it stays exactly that.
 */
export function isInformativeSpell(resistAdj: number): boolean {
  return resistAdj > INFORMATIVE_RESIST_ADJ
}

// ── THE TWO LEGENDS TERMS THE FIRST CUT DID NOT MODEL (JOS-387) ─────────────────────────────────

/**
 * SPELL UPGRADE RANKS ARE RESIST ADJUST, -15 A RANK, UNIFORMLY. The rank is the Roman numeral the
 * log prints on the cast line: `Scorching Arrow IV` is rank 4 and therefore -60 on top of the
 * spell's own adjust, and a Siphon Life at -215 reads -260 at rank III. (EQ Legends spell-upgrade
 * system; eqltools.com/learn/spell-upgrades and everquestlegends-wiki.wiki/guides/spell-upgrades.)
 *
 * Our ledger keys rows by `spellCanonKey`, which STRIPS the numeral so a cast can be joined to the
 * fade and fizzle lines that never print it — so before JOS-387 every ranked cast in the ledger was
 * modelled at the base adjust, and 7,959 of the owner's 25,621 casts carry a rank.
 */
export const RANK_RESIST_ADJ = -15

/**
 * THE OVERCHANNEL INVOCATION, verbatim from the Legends wiki (Stances & Invocations, cached in
 * `scripts/sources/cache/classes/Stances_Invocations.wikitext`): "Cast spells have a -150 resist
 * adjust plus another -15 for every non-hybrid caster class at a cost of 10% of the mana cost in
 * endurance."
 *
 * It is an INVOCATION, so it is mutually exclusive with the other eight and holds until another one
 * is recited — the state machine, not a per-cast buff.
 */
export const OVERCHANNEL_RESIST_ADJ = -150
export const OVERCHANNEL_PER_CASTER_CLASS = -15

/**
 * THE NON-HYBRID CASTER CLASSES, which is what "every non-hybrid caster class" counts.
 *
 * These seven are exactly the roster the committed class catalog files under the `empowering`
 * invocation (`src/main/data/classes.json`), which is the game's own "pure caster" grouping — the
 * hybrids (PAL, RNG, SHD, BST) and the Bard are admitted to `overchannel` and to `inversion` but
 * never to `empowering`. Spelled out here rather than read out of the catalog because this is an
 * arithmetic constant in a pure module, and a data file that gains a tenth invocation must not
 * silently change what a resist estimate means.
 */
export const PURE_CASTER_CLASSES: readonly string[] = ['CLR', 'DRU', 'ENC', 'MAG', 'NEC', 'SHM', 'WIZ']

const PURE_CASTER_SET: ReadonlySet<string> = new Set(PURE_CASTER_CLASSES)

/** How many of a `/who` row's class codes are non-hybrid casters. Unknown loadout answers 0. */
export function casterClassCount(classes: readonly string[] | undefined): number {
  if (!classes) return 0
  let n = 0
  for (const c of classes) {
    if (PURE_CASTER_SET.has(c.trim().toUpperCase())) n += 1
  }
  return n
}

/** What one cast's rank and invocation are worth on top of the spell's own adjust. */
export function castAdjustBonus(input: {
  rank?: number
  overchannel?: boolean | null
  casterClasses?: number
}): number {
  const rank = input.rank ?? 0
  const over = input.overchannel === true
  return (
    RANK_RESIST_ADJ * rank +
    (over ? OVERCHANNEL_RESIST_ADJ + OVERCHANNEL_PER_CASTER_CLASS * (input.casterClasses ?? 0) : 0)
  )
}

/** The resist adjust a cast actually rolled against: the spell's own, plus its rank and invocation. */
export function effectiveResistAdj(
  resistAdj: number,
  cast: { rank?: number; overchannel?: boolean | null; casterClasses?: number }
): number {
  return resistAdj + castAdjustBonus(cast)
}

/** Torven's typical NPC resist for an axis at a level. The prior, and nothing else. */
export function priorResist(axis: ResistAxis, mobLevel: number | null): number {
  if (axis === 'poison' || axis === 'disease') return 15
  return (mobLevel ?? 40) >= 25 ? 35 : 25
}

/** P(the all-or-nothing spell is resisted) at this rc. Songs use this too. */
export function pResistAon(rc: number): number {
  return clamp(rc, 0, 200) / 200
}

/** P(the game prints the resist message) for a damage spell at this rc. */
export function pResistMessage(rc: number): number {
  return clamp(rc, 0, 600) / 600
}

/** P(full, unreduced damage) at this rc. */
export function pFullDamage(rc: number): number {
  return (200 - clamp(rc, 0, 200)) / 200
}

/**
 * The whole model, forward. `kind: 'aon'` covers every all-or-nothing spell and every song pulse;
 * `kind: 'dd'` covers direct damage. Shipped tested but not yet surfaced — the con-tooltip
 * follow-up is what consumes it.
 */
export function predict(input: {
  R: number
  casterLevel: number
  mobLevel: number
  resistAdj: number
  debuff?: number
  kind: 'aon' | 'dd'
  /** The upgrade rank the log printed on the cast line. -15 each (JOS-387). */
  rank?: number
  /** Was the overchannel invocation up? -150, plus -15 per non-hybrid caster class. */
  overchannel?: boolean | null
  /** The caster's non-hybrid caster classes. 0 when the loadout is unknown. */
  casterClasses?: number
}): { pLand: number; pFull?: number; pResistMsg: number; expectedDmgFrac?: number } {
  const lm = levelMod(input.casterLevel, input.mobLevel)
  if (lm === IMMUNE_LEVEL_MOD) {
    return input.kind === 'aon'
      ? { pLand: 0, pResistMsg: 1 }
      : { pLand: 0, pFull: 0, pResistMsg: 1, expectedDmgFrac: 0 }
  }
  const rc = input.R + lm + effectiveResistAdj(input.resistAdj, input) - (input.debuff ?? 0)
  if (input.kind === 'aon') {
    const pr = pResistAon(rc)
    return { pLand: 1 - pr, pResistMsg: pr }
  }
  const full = pFullDamage(rc)
  const msg = pResistMessage(rc)
  return {
    pLand: 1 - msg,
    pFull: full,
    pResistMsg: msg,
    expectedDmgFrac: expectedDamageFraction(rc),
  }
}

/**
 * Mean fraction of full damage a cast delivers at this rc, averaged over the 200 rolls. The
 * resist message is a 0; a partial delivers `1 - 1.5*(rc-roll)/rc`.
 */
export function expectedDamageFraction(rc: number): number {
  if (rc <= 0) return 1
  let sum = 0
  for (let roll = 1; roll <= 200; roll++) {
    if (roll > rc) {
      sum += 1
      continue
    }
    const frac = 1 - (1.5 * (rc - roll)) / rc
    if (frac > 0) sum += frac
  }
  return sum / 200
}

// ── THE TAG IS A BENCHMARK, NOT AN R BAND (owner ruling, 2026-08-16 — JOS-387) ──────────────────
//
// The tag has to answer the question the player actually asks: WILL IT LAND IF I CAST IT. The first
// cut answered a different one — it banded R itself (weak / normal / resistant / very resistant /
// nearly immune) — and an R band is a fact about the creature that a player still has to do
// arithmetic on, because the same R is trivial at level 50 and hopeless at level 20.
//
// So the tag is evaluated AT THE VIEWER'S LEVEL, for the simplest spell there is: rank 0, resist
// adjust 0, all-or-nothing, no debuffs. `rc0 = R + levelMod(L, mobLevel)` and `pPlain` is the
// chance that spell lands. The second number is the same spell with the OVERCHANNEL invocation up,
// which is the one thing a player can do about a resistant mob without changing spell or level.
//
// THREE BANDS, READ TWO WAYS (owner ruling, 2026-08-16). Each band has a SCANNABLE WORD for the
// chip and the row label, and a GUIDANCE SENTENCE under it saying what to do about it:
//
//   normal / weak     should land                          pPlain >= 60%
//   resistant         needs overchannel                    pPlain < 60%, pOver >= 60%
//   very resistant    may not land even with overchannel   pOver < 60%
//
// `weak` is the one distinction still drawn on R itself (`WEAK_BELOW`) rather than on the
// benchmark: inside the top band, "this creature has essentially no resistance" is a different and
// more durable fact than "this lands at your level", and a player planning ahead wants it.
//
// THE LEVEL TERM ALONE CAN PUT A MOB IN THE TOP BAND, and that is correct and intended rather than
// a symptom: the player level cap is 50 and Sky runs to 70, so a twenty-level gap is +200 of `rc`
// before the creature's own resistance is counted at all — which is precisely why the owner's
// tashed, maloed, overchannelled slows still fail on the Eye of Veeshan.
//
// AND THE TWO PERCENTAGES ARE ALWAYS PRINTED BESIDE THE BAND, because the band is a summary and the
// numbers are what a player scales their own case from: a rank-10 spell is another -150 on top of
// overchannel, and tash or malo is another 40 to 60 off `rc`. The band answers the common case; the
// numbers let a reader answer theirs.
//
// pOver USES THE FLAT -150 and never the per-caster-class bonus, deliberately: the extra -15s
// depend on the READER's loadout, and a tag that moved when a groupmate read the same card over
// somebody's shoulder would be a worse benchmark than one that is uniformly a little pessimistic.
// The class bonus is real and it is modelled where it belongs — in the ESTIMATE of R, off the
// observations that were actually made in overchannel.

/** The one threshold all three bands are drawn at. Owner's number. */
export const BENCHMARK_LANDS_AT = 0.6

/** Under this R the top band says `weak` rather than `normal`. The one band drawn on R itself. */
export const WEAK_BELOW = 10

/** The band from the two probabilities. The boundary belongs to the more optimistic band. */
export function benchmarkGuidance(pPlain: number, pOver: number): ResistGuidance {
  if (pPlain >= BENCHMARK_LANDS_AT) return 'should land'
  return pOver >= BENCHMARK_LANDS_AT ? 'needs overchannel' : 'may not land even with overchannel'
}

/** The scannable word for a band. `weak` splits the top band on R; the others are the band. */
export function benchmarkTag(R: number, guidance: ResistGuidance): ResistTag {
  if (guidance === 'needs overchannel') return 'resistant'
  if (guidance === 'may not land even with overchannel') return 'very resistant'
  return R < WEAK_BELOW ? 'weak' : 'normal'
}

/**
 * The benchmark for one R, at the viewer's level against this mob.
 *
 * `viewerLevel` null (or `mobLevel` null) means an even-level reading, which is exactly the reading
 * the old R bands used and the only one available when nothing states a level.
 */
export function resistBenchmark(
  R: number,
  viewerLevel: number | null,
  mobLevel: number | null
): ResistBenchmark {
  const atMobLevel = viewerLevel === null || mobLevel === null
  const level = atMobLevel ? (mobLevel ?? 0) : viewerLevel
  const lm = mobLevel === null || viewerLevel === null ? 0 : levelMod(viewerLevel, mobLevel)
  const rc0 = R + lm
  const pPlain = pFullDamage(rc0)
  const pOver = pFullDamage(rc0 + OVERCHANNEL_RESIST_ADJ)
  const guidance = benchmarkGuidance(pPlain, pOver)
  return { level, mobLevel, atMobLevel, pPlain, pOver, guidance, tag: benchmarkTag(R, guidance) }
}
