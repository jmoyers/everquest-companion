// buffsInstanceRules.ts — the PURE rules the buff-instance store applies, lifted out of
// buffsInstances.ts (which is at the 400-code-line factoring ceiling).
//
// Nothing here holds state or reads a clock. Each function answers ONE question the store asks
// while censoring, retiring or projecting an instance, and each one is a rule a reader is likely
// to want on its own: whether a retirement covers this instance, whether a zone leaves it behind,
// how long it may live unclosed, and what a fresh landing projects to.

import type { ActiveBuff } from '../../shared/types'
import { isLeftBehindOnZone, type EntityDisposition } from '../combat/entityRules'
import { hygieneCapMs, unwitnessedTimeoutMs, type OpenCast } from './buffsShapes'
import type { ActiveSpec } from './buffsView'

/**
 * THE DEATH CENSOR'S REACH (JOS-156). A mob died — which of the things we are holding did it take
 * with it? The answer is "anything that was on an ENEMY", and it takes TWO tests to say that,
 * because neither one alone covers the log:
 *
 *   • the SPELL'S CLASS. This is the half the ticket needed. The owner's charm pet and the bees it
 *     was killing all answered to "Bzzazzt", so a slow landed on one of the bees was filed with
 *     `disp: 'charmed'` — the name matched the live pet — even though the spell on it is
 *     detrimental. A disposition test alone let that row outlive four deaths.
 *   • the RECORD'S DISPOSITION. This is the half that was already there, and dropping it costs
 *     real ground: the PACIFY family (Calm, Lull, Pacify) is `Beneficial` in the committed
 *     spells.json and is cast at enemies, so it is a `cls: 'buff'` standing on a hostile. MEASURED
 *     over the full 1.47M-line log: reading class alone left those open records behind, and they
 *     later paired with a wear-off into duration samples the old code refused (Calm 33 → 35,
 *     Lull 3 → 4).
 *
 * So the reach is the UNION, applied identically to open records and active rows — which is the
 * other half of the fix, since before JOS-156 the two halves tested different things and a row
 * could be censored on one side and left standing on the other.
 *
 * `unknown-hostile` is swept alongside the named key because its inferred target is exactly the
 * mob that just died.
 */
export function deathCensorsOpen(o: OpenCast, entityKey: string, isDebuff: boolean): boolean {
  if (!isDebuff && o.disp !== 'hostile') return false
  return o.entityKey === entityKey || o.entityKey === 'unknown-hostile'
}

/** …and the same union for an ACTIVE row. Nothing friendly can be on the thing you just killed. */
export function deathCensorsActive(a: ActiveBuff, aKey: string, entityKey: string): boolean {
  if (a.cls !== 'debuff' && a.disposition !== 'hostile') return false
  return aKey === entityKey || aKey === 'unknown-hostile' || a.inferredTarget === true
}

/**
 * ZONE (the user's rule): the player keeps self buffs; a SUMMONED pet follows and keeps
 * its buffs; a CHARMED pet is LEFT BEHIND (retire + censor); hostile mobs are left behind
 * (censor open debuffs). Uses the SHARED isLeftBehindOnZone rule.
 */
export function openLeftBehindOnZone(o: OpenCast): boolean {
  if (o.disp === 'self') return false
  if (o.disp === 'summoned') return isLeftBehindOnZone('summoned') // false
  if (o.disp === 'charmed') return isLeftBehindOnZone('charmed') // true
  return true // hostile → left behind
}

/** The long-stop retirement every instance has had since Task #33: 90 minutes, or twice what we
 *  know about the spell, whichever is longer. It answers "we lost the thread", not "it expired". */
export function hygieneCap(a: ActiveBuff, dbMs: number | null): number {
  return Math.max(hygieneCapMs(a.p75, a.n), dbMs != null ? 2 * dbMs : 0)
}

/**
 * THE UNWITNESSED-EXPIRY CULL (JOS-140, widened by JOS-149, unified by JOS-156).
 *
 * The owner's first case: slow a boss, then die. The wear-off line prints to a character who is
 * not there to receive it, so it never arrives and the bar squats at 0s — for ninety minutes,
 * under the hygiene cap alone. A row whose countdown ran out and whose close was never witnessed
 * is culled after its own timeout instead. It mints NOTHING: an absence of evidence is not a
 * measurement, and `sweepHygiene` has never called `addSample`.
 *
 * ONE LINE DECIDES WHO IS EXEMPT, AND IT IS `self`, NOT `cls`. JOS-140 exempted the whole buffs
 * window, on the argument that a wears-off line for a buff of yours is printed to YOU and that a
 * beneficial clock is PAUSED by an absence, so an overdue buff is more often a paused timer than
 * a lost line. Both halves of that are true of a SELF buff and neither is true of a buff on
 * somebody else. The pet fade line resolves against the CURRENT pet, so a row bound to a pet that
 * despawned can never be named by any later line; a buff on an ally prints nothing to you at all.
 * The owner's screenshot (JOS-149) is a pair of Focus Death rows at 0s on two long-dead pets,
 * which no amount of waiting could ever close, and which the startup replay raised again on every
 * launch.
 *
 * So: SELF buffs are exempt — Infinity means "no cull", leaving the hygiene cap as their only
 * long-stop, exactly as before. EVERY OTHER ROW, debuff and non-self buff alike, is culled at its
 * countdown plus `unwitnessedTimeoutMs` — 15 s for a learned duration, 60 s for a DB floor.
 *
 * THERE USED TO BE A SECOND BRANCH HERE and JOS-156 deleted it: a debuff waited its DURATION AGAIN
 * (floored at 60 s), to preserve the learner's one chance at a late correction. buffsShapes.ts
 * carries the whole argument and the owner's ruling against it; the short form is that Tashania's
 * DB row is eleven minutes, so the branch parked the owner's bar at 0s for eleven minutes after he
 * died mid-cast, and a wear-off nobody can witness was never going to arrive to correct anything.
 *
 * A row with no number at all is counting UP, has nothing to be overdue against, and keeps the
 * hygiene cap. Nothing here reads a clock, so the cull is judged on the SAME `startedTs` the
 * countdown draws — which is what makes it respect the JOS-134 offline pause automatically: the
 * pause shifts that field, and the sweep's own hold (`heldBeforeTs`) covers every buff row,
 * self or not, for as long as a log hole is unexplained.
 */
export function unwitnessedCullCap(a: ActiveBuff): number {
  if (a.cls !== 'debuff' && a.self) return Number.POSITIVE_INFINITY
  const dur = a.overlayDurationMs
  // No number at all ⇒ the row is counting UP and has nothing to be overdue against.
  if (dur == null || dur <= 0) return Number.POSITIVE_INFINITY
  return dur + unwitnessedTimeoutMs(a.overlaySource)
}

/** Where a fresh landing sits: its identity, whose it is, and the record it just joined. */
export interface LandingPlacement {
  key: string
  eKey: string
  disp: EntityDisposition
  caster: string
  permanent: boolean
  record: OpenCast
  ts: number
}

/**
 * The projection spec for a fresh landing. A permanent illusion has no group behind it, so it
 * reports the landing instant and a count of one; everything else reports the group's OLDEST
 * landing (the clock the next wear-off will close) and its size (the count chip).
 */
export function landingSpec(candidates: string[] | undefined, at: LandingPlacement): ActiveSpec {
  return {
    spell: at.record.spell,
    key: at.key,
    entityKey: at.eKey,
    startedTs: at.permanent ? at.ts : at.record.group.oldestTs,
    dispOverride: at.disp,
    caster: at.caster,
    count: at.permanent ? 1 : at.record.group.count,
    ...(candidates ? { candidates } : {}),
    opts: { messageDriven: true, permanent: at.permanent }
  }
}

/**
 * Permanent Illusion AA (Task #34): a SELF illusion cast at or after the AA was owned never
 * expires, so it is shown with no countdown and pairs no duration sample.
 */
export function isPermanentIllusion(
  self: boolean,
  illusion: boolean,
  ts: number,
  ownedTs: number | undefined
): boolean {
  return self && illusion && ownedTs != null && ts >= ownedTs
}
