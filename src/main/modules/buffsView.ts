// The ActiveBuff PROJECTION for the buffs model (see buffs.ts): turn one live buff
// instance — (spell line, entity, caster) plus how it got there — into the row the UI renders.
// Pure: it reads the learned per-spell stats and the current pet identities and writes
// nothing, so every caller in the instance store shares one definition of what a row says.

import type { ActiveBuff, BuffClass } from '../../shared/types'
import type { EntityDisposition } from '../combat/entityRules'
import { SELF_CASTER } from '../../shared/buffTrust'
import { SELF_KEY } from './buffsShapes'
import type { PetEntities } from './buffsEntities'
import type { SpellStats } from './buffsStats'

/** Everything that identifies the instance being projected, plus how it was established. */
export interface ActiveSpec {
  spell: string
  key: string
  entityKey: string
  startedTs: number
  dispOverride?: EntityDisposition
  /** 'self' or an allowlisted external — the second half of the learner's key (JOS-140). */
  caster?: string
  /** How many entities of that display name are holding it (JOS-140 ruling 7). */
  count?: number
  /** Present when the landing sentence stayed a FAMILY (a Quick Buff burst cannot narrow one). */
  candidates?: string[]
  opts?: { messageDriven?: boolean; permanent?: boolean }
}

/**
 * Target label + inference. Self: none. Otherwise the bound entity's display name; a
 * debuff whose target was inferred (no confirmed message) is flagged inferredTarget.
 */
function resolveTargetLabel(
  a: { entityKey: string; cls: BuffClass; self: boolean; disp?: EntityDisposition; messageDriven: boolean },
  pets: PetEntities
): { target: string | undefined; inferredTarget: boolean } {
  const { entityKey, cls, disp } = a
  if (a.self) return { target: undefined, inferredTarget: false }
  // A LANDING LINE NAMED THIS ENTITY (JOS-118), so the target is STATED, not inferred — even
  // when it happens to also be the mob we believe the pet is fighting (the `petTargetKey` arm
  // below used to flag exactly that coincidence as an inference and label a named mob
  // "(inferred)"). Since JOS-118 this is the only way an instance is ever opened.
  if (a.messageDriven) return { target: pets.entityDisplayFor(entityKey), inferredTarget: false }
  // Self-keyed debuff = an inferred, not-yet-named hostile target.
  if (cls === 'debuff' && entityKey === SELF_KEY) {
    return { target: pets.petTargetDisplay, inferredTarget: true }
  }
  if (disp === 'summoned' && pets.summonedKey === entityKey) {
    return { target: pets.summonedDisplay, inferredTarget: false }
  }
  if (disp === 'charmed' && pets.charmedKey === entityKey) {
    return { target: pets.charmedDisplay, inferredTarget: false }
  }
  if (entityKey === pets.petTargetKey) {
    return { target: pets.petTargetDisplay, inferredTarget: cls === 'debuff' }
  }
  if (entityKey === 'unknown-hostile') return { target: undefined, inferredTarget: true }
  // A cast-timing-inferred debuff target (no confirming message) is a best guess.
  return { target: pets.entityDisplayFor(entityKey), inferredTarget: cls === 'debuff' && !a.messageDriven }
}

/**
 * THE OVERLAY's countdown duration (JOS-117, ruling 6), computed here where the samples + DB live
 * and carried on the ActiveBuff so the pure shared projection never reaches into main. It is the
 * SAME estimator the Buffs tab uses — max(DB floor, recent observed max) — so a click-off/dispel
 * that minted a too-short sample no longer becomes the overlay's number (JOS-114's most-recent-
 * sample rule did exactly that: an early-terminated cast trusted as "most recent" showed Swift at
 * ~28m for a 33:36 buff), and a focus/AA-extended duration is honoured on BOTH surfaces. A
 * permanent buff never counts down; a spell with no floor and no sample carries no number (the
 * overlay counts up).
 *
 * It is read PER CASTER (JOS-140 ruling 4): an allowlisted external's buff counts down from THEIR
 * observed durations, never from yours, because the AAs and focus items behind the number are
 * theirs.
 */
function overlayDurationOf(
  key: string,
  permanent: boolean,
  stats: SpellStats,
  caster: string
): { overlayDurationMs: number | null; overlaySource?: 'db' | 'observed' } {
  if (permanent) return { overlayDurationMs: null }
  const est = stats.estimateFor(key, caster)
  if (est.ms != null && est.source) return { overlayDurationMs: est.ms, overlaySource: est.source }
  return { overlayDurationMs: null }
}

/** The row's duration/estimate fields, from the per-(line, caster) mined stats + the DB prior. */
function durationFields(
  key: string,
  permanent: boolean,
  stats: SpellStats,
  caster: string
): {
  estimatedMs: number | null
  p25: number | null
  p75: number | null
  n: number
  durationSource?: 'db' | 'observed'
  overlayDurationMs: number | null
  overlaySource?: 'db' | 'observed'
} {
  const st = stats.statFor(key, caster)
  const est = stats.estimateFor(key, caster)
  const overlay = overlayDurationOf(key, permanent, stats, caster)
  return {
    estimatedMs: permanent ? null : est.ms,
    p25: st?.p25 ?? null,
    p75: st?.p75 ?? null,
    n: st?.n ?? 0,
    ...(est.source && !permanent ? { durationSource: est.source } : {}),
    overlayDurationMs: overlay.overlayDurationMs,
    ...(overlay.overlaySource ? { overlaySource: overlay.overlaySource } : {})
  }
}

/**
 * The fields a row only carries when it has something to say. Absent for the ordinary case, so a
 * snapshot only grows where the ambiguity is real: a count chip on every row would be noise, and
 * a `caster` on every row would suggest the model doubts who cast your own buffs.
 */
function optionalFields(
  spec: ActiveSpec,
  at: { inferredTarget: boolean; permanent: boolean; messageDriven: boolean; caster: string }
): Partial<ActiveBuff> {
  const count = spec.count ?? 1
  return {
    ...(at.inferredTarget ? { inferredTarget: true } : {}),
    ...(at.permanent ? { permanent: true } : {}),
    ...(at.messageDriven ? { messageDriven: true } : {}),
    ...(count > 1 ? { count } : {}),
    ...(at.caster !== SELF_CASTER ? { caster: at.caster } : {}),
    ...(spec.candidates ? { candidates: [...spec.candidates] } : {})
  }
}

export function buildActive(spec: ActiveSpec, stats: SpellStats, pets: PetEntities): ActiveBuff {
  const { spell, key, entityKey, startedTs, dispOverride, opts } = spec
  const caster = spec.caster ?? SELF_CASTER
  const cls = stats.classOf(key)
  const disp: EntityDisposition | undefined = dispOverride
  // A DEBUFF is never the player's own buff, even if cast-timing bound it to the self key
  // before its class was known (no DB, first cast): a debuff on 'self' really means "an
  // inferred hostile target we couldn't name yet" (Task #35). Present it as non-self.
  const self = entityKey === SELF_KEY && cls !== 'debuff'
  const messageDriven = opts?.messageDriven === true
  const { target, inferredTarget } = resolveTargetLabel({ entityKey, cls, self, disp, messageDriven }, pets)
  const permanent = opts?.permanent === true
  const d = durationFields(key, permanent, stats, caster)
  return {
    spell,
    cls,
    self,
    disposition: disp,
    startedTs,
    estimatedMs: d.estimatedMs,
    p25: d.p25,
    p75: d.p75,
    n: d.n,
    target,
    ...(d.durationSource ? { durationSource: d.durationSource } : {}),
    overlayDurationMs: d.overlayDurationMs,
    ...(d.overlaySource ? { overlaySource: d.overlaySource } : {}),
    ...optionalFields(spec, { inferredTarget, permanent, messageDriven, caster })
  }
}
