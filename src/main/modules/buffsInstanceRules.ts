// buffsInstanceRules.ts — the PURE rules the buff-instance store applies, lifted out of
// buffsInstances.ts (which is at the 400-code-line factoring ceiling).
//
// Nothing here holds state or reads a clock. Each function answers ONE question the store asks
// while censoring, retiring or projecting an instance, and each one is a rule a reader is likely
// to want on its own: whether a retirement covers this instance, whether a zone leaves it behind,
// how long it may live unclosed, and what a fresh landing projects to.

import type { ActiveBuff } from '../../shared/types'
import { isLeftBehindOnZone, type EntityDisposition } from '../combat/entityRules'
import {
  HYGIENE_ABSOLUTE_MS,
  hygieneCapMs,
  learningRecordCapMs,
  unwitnessedTimeoutMs,
  type OpenCast
} from './buffsShapes'
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
 * A NAME THE WORLD HANDS OUT MORE THAN ONCE — the leading article, which is how EQ spells
 * "one of these" (`a rock golem`, `an elemental warrior`) as against an identity (`Cazic-Thule`,
 * `Lord Nagafen`, `Dread`, `magus rokyl`). Read off the canonical KEY, which is already
 * lowercased at the boundary (world-model law 2).
 *
 * The distinction is JOS-228's precedent, applied to a different question: there, whether a corpse
 * may close a hold; here, whether a corpse may MEASURE one.
 */
export function isArticleNamed(entityKey: string): boolean {
  return /^(?:a|an|the) /.test(entityKey)
}

/** How much longer than the current estimate an ARTICLE-named mob's bound may claim. */
export const DEATH_BOUND_MAX_ESTIMATE_MULTIPLE = 2
/** The absolute ceiling on any bound, as a multiple of the spell database's own duration. */
export const DEATH_BOUND_MAX_DB_MULTIPLE = 3

/**
 * The three questions the bound asks of the LEARNER, as the narrowest interface that answers them
 * — `SpellStats` satisfies it structurally, and this file stays the dependency-free rules half.
 */
export interface DeathBoundStats {
  /** The number the row is currently counting down from, under this record's own caster key. */
  estimateFor(key: string, caster: string): { ms: number | null }
  /** What the spell database states for the line, or null when it states nothing. */
  dbDurationFor(key: string): number | null
  /** Has THIS log ever printed a target-named wear-off for the line? */
  hasWearOffChannel(key: string): boolean
}

/**
 * THE DEATH LOWER BOUND (JOS-379, owner ruling 2026-08-15) — the span a corpse is allowed to
 * teach, or null when it teaches nothing. Pure: the store supplies the facts, this decides.
 *
 * THE OBSERVATION THE LEARNER USED TO THROW AWAY. A debuffed mob that DIES with no wear-off since
 * its landing proves the debuff lasted AT LEAST landing→corpse. `buffsInstances.onEntityDeath` has
 * always discarded that span structurally, on the correct reasoning that it is not a DURATION — and
 * that reasoning stays correct. What it misses is that a MAX estimator does not need a duration: a
 * lower bound lifts the floor toward the truth and can never lift it past, so long as the wear-off
 * line is reliable when it does happen. Measured on the owner's log the night before the report:
 * five Togor's Insects cycles on rock golems, every one of them ended by its own wear-off sentence
 * at 2:20-2:29. The line is reliable. It simply never gets the chance on a raid mob.
 *
 * WHAT THE REPORT COST WITHOUT IT (owner, 2026-08-15, Plane of Fear). `a dracoliche` was slowed at
 * 22:38:54 and slain at 22:42:02 with no wear-off in between — 3:08 of proof — while the app drew
 * the classic-era database's 2:30 and the early-warning alert announced the slow had worn off at
 * 22:41:19, with the slow visibly still on the mob. Twenty-seven landings on that night's bosses
 * produced not one clean cycle, so nothing could ever lift the floor.
 *
 * THE FIVE RAILS, each of which refuses rather than guesses:
 *
 *  1. THE CHANNEL MUST BE WITNESSED. Silence is evidence only about a spell this log has actually
 *     heard speak — `SpellStats.wearOffWitnessed`, learned at runtime from the target-named
 *     wear-off sentence. Without it, "no wear-off printed" is a fact about the spell's messages
 *     and not about its duration. This is the awaiting-sample law applied to a bound.
 *  2. ONE LANDING ONLY. A corpse names a mob but never WHICH mob of that name, so with two
 *     landings in the group the log does not say which one just died — and a wear-off may already
 *     have closed the other. (The owner's rule admits a proper-named mob outright; this is the
 *     same rule for it, because an identity can never legitimately hold two landings — a re-cast
 *     REFRESHES the single hold, buffRounds.ts — so the check costs a proper name nothing and
 *     covers the impossible case honestly rather than assuming it away.)
 *  3. IT MUST BEAT THE CURRENT ESTIMATE. A bound below what the app already draws is true and
 *     useless; pushing it would only add noise to the window.
 *  4. THE SAME-NAME CAP. For an ARTICLE-named mob the span may not exceed
 *     {@link DEATH_BOUND_MAX_ESTIMATE_MULTIPLE}× the current estimate: `a rock golem` that dies
 *     six minutes after a slow landed is far more likely to be a DIFFERENT golem than a slow that
 *     ran four times its stated length. A proper name has no twin and takes no such cap — that is
 *     the whole content of JOS-228's identity distinction.
 *  5. THE ABSOLUTE CAP. No bound may exceed {@link DEATH_BOUND_MAX_DB_MULTIPLE}× what the spell
 *     database states, ever. A missed wear-off (a line that printed while the app was not
 *     looking) must not be able to teach nonsense, and a factor of the FLOOR is the one bound a
 *     bad observation cannot itself drag upward — the same argument `learningRecordCapMs` makes.
 *     With no database row there is nothing to multiply and the bound is refused outright; that
 *     is a stated limit, not an oversight.
 *
 * AND AN OFFLINE GAP REFUSES IT (world-model law 5's censor, the shape `OpenCast.spannedGap`
 * already states): the wear-off sentence only exists while you are logged in, so across an absence
 * "no wear-off printed" stops being a claim about the world at all.
 *
 * THE CASTER IS NOT RE-CHECKED and does not need to be: an instance opens only from a landing line
 * the attribution gate admitted (`modules/buffLanding.ts`, `shared/buffTrust.ts`), so a record that
 * exists at all is your own cast or an allowlisted external's — and the estimate it is measured
 * against is read under that same caster's learner key, never the pooled one.
 */
export function deathBoundSpan(
  o: OpenCast,
  entityKey: string,
  deathTs: number,
  stats: DeathBoundStats
): number | null {
  const dbMs = stats.dbDurationFor(o.spellKey)
  if (!stats.hasWearOffChannel(o.spellKey) || o.spannedGap === true) return null
  if (o.group.count !== 1 || dbMs == null || dbMs <= 0) return null
  const span = deathTs - o.group.oldestTs
  const estimateMs = stats.estimateFor(o.spellKey, o.caster).ms
  if (span <= 0 || estimateMs == null || span <= estimateMs) return null
  if (isArticleNamed(entityKey) && span > DEATH_BOUND_MAX_ESTIMATE_MULTIPLE * estimateMs) return null
  return span <= DEATH_BOUND_MAX_DB_MULTIPLE * dbMs ? span : null
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

/**
 * THE ORPHANED-RECORD REAPER (JOS-203) — the buffs half's half of the retention rule.
 *
 * THE DEFECT IT FIXES, characterized on the running model: `sweepHygiene` iterates the ACTIVE map,
 * and its unwitnessed cull deletes the active row while deliberately KEEPING the open record
 * (JOS-156's refinement — the record is what lets a late wear-off still mint a sample, and deleting
 * it pinned the estimate to the DB floor forever). But the long stop that would eventually collect
 * that record is inside the same active loop, so once the cull ran there was NO REAPER AT ALL: the
 * record sat in `open` for the life of the process. Two things follow, and both were measured. The
 * map grows without bound. And the next landing of that spell on a same-named mob calls
 * `openRecord`, finds the stale record, and lands into its stale {@link OpenCast.group} — so the
 * row draws the ANCIENT landing's clock (the group's oldest) with the old count chip, which is
 * instantly overdue and is culled again before the player can read it.
 *
 * IT REAPS ONLY ORPHANS — a record with no active row behind it. A record that still has one is
 * governed by the sweep exactly as before, so no live row's life changes by a millisecond, and the
 * anti-squatting cull, the hygiene long stop and the offline hold are all untouched.
 *
 * THE SCHEDULE IS THE SHARED ONE: `learningRecordCapMs` — 3× the DB base, or the 90-minute long
 * stop when the DB states nothing to multiply. The CC half's late-join memory retires on the same
 * rule (`modules/buffTimers.ts remember`), which is the symmetry the ticket asked for.
 *
 * IT MINTS NOTHING AND SAYS NOTHING. A reap is not an observation (`dropExpired` hands the landing
 * back and this discards it), and nothing in either snapshot describes an open record — so the
 * caller does not mark the model dirty for it, and no delta is pushed for a bar nobody can see.
 */
export function reapOrphanedOpen(
  open: Map<string, OpenCast>,
  active: ReadonlyMap<string, unknown>,
  dbDurationFor: (spellKey: string) => number | null,
  now: number
): void {
  for (const [ik, o] of open) {
    if (active.has(ik)) continue
    o.group.dropExpired(now - learningRecordCapMs(dbDurationFor(o.spellKey), HYGIENE_ABSOLUTE_MS))
    if (o.group.empty) open.delete(ik)
  }
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
    // DISPLAY ONLY (JOS-238) — the rank the cast line spelled, when it said one.
    ...(at.record.castName != null ? { castName: at.record.castName } : {}),
    ...(candidates ? { candidates } : {}),
    opts: { messageDriven: true, permanent: at.permanent }
  }
}

/**
 * THE SPEC FOR RE-PROJECTING A ROW THAT IS ALREADY LIVE: everything the instance IS, carried
 * forward from the row being replaced, with only the coordinates a re-projection restates
 * (`at`) supplied by the caller.
 *
 * IT EXISTS BECAUSE THE STORE RE-PROJECTS FROM TWO PLACES THAT MUST NOT DRIFT — `restat` (the
 * hold group moved: a landing closed, or another mob of that name joined it) and `addSample` (a
 * fresh duration changed what every live instance of that line counts down from). Both used to
 * hand-copy the same seven fields, and a display fact added to one and not the other is precisely
 * the shape of the defect JOS-238 fixed one level up: a row that says a different thing depending
 * on which internal event last touched it. There is one copy now, and `castName` — the ranked text
 * of the cast line, which a re-projection must not silently drop — is carried here.
 */
export function reprojectSpec(
  a: ActiveBuff,
  at: { key: string; entityKey: string; startedTs: number; caster: string; count: number }
): ActiveSpec {
  return {
    spell: a.spell,
    ...at,
    dispOverride: a.disposition,
    ...(a.castName != null ? { castName: a.castName } : {}),
    ...(a.candidates ? { candidates: [...a.candidates] } : {}),
    opts: { messageDriven: a.messageDriven, permanent: a.permanent }
  }
}

/**
 * The landing's own claims, as the store already holds them — a structural subset of
 * `buffsInstances.ts LandingSpec`, spelled here rather than imported so this file stays the
 * dependency-free RULES half (importing the store back would close a cycle).
 */
export interface PermanenceClaims {
  illusion: boolean
  ts: number
  /** ts from which the Permanent Illusion AA is owned, when it is. */
  permanentIllusionOwnedTs?: number
}

/**
 * DOES THIS LANDING NEVER EXPIRE (JOS-215, generalizing Task #34's `isPermanentIllusion`).
 *
 * TWO INDEPENDENT REASONS, both of which mean "no countdown, no duration sample, and no hygiene
 * retirement":
 *
 *   1. THE SPELL ITSELF (JOS-215). The wiki states `Permanent` — Yaulp, the Shielding ladder, the
 *      rogue blade coats, 62 rows in all, every one of them Self. The buff simply has no timer.
 *   2. THE PERMANENT ILLUSION AA (Task #34). A SELF illusion cast at or after the AA was owned
 *      never expires, whatever the spell's own duration says.
 *
 * BOTH ARE GATED ON `self`, AND THAT IS NOT AN ACCIDENT of the AA rule leaking into the new one.
 * All 62 permanent rows are `targetType: Self`, so a permanent landing on somebody else is a shape
 * the game does not print; if a re-scrape ever produces one, the honest answer is a normal count-up
 * row rather than an unkillable bar on an entity this model may lose track of. The 90-minute
 * hygiene long stop is the only thing that retires a row nothing else can, and exempting a NON-self
 * instance from it is how a bar ends up standing on a corpse forever.
 *
 * THE FIVE ILLUSION PERMANENTS TAKE ARM 1, NOT ARM 2 (JOS-215, and this is the second half of the
 * ticket). Lich, Call of Bones, Wolf Form, Greater Wolf Form and Form of the Great Wolf are the
 * intersection: `durationText: Permanent` AND illusion-flagged. Before this they were the only
 * permanents the model admitted at all — the old guard let an illusion through without a duration —
 * but they were permanent only if the AA had been PURCHASED, so without it they opened as ordinary
 * count-up rows and the 90-minute hygiene cap retired a form the player was still wearing. Reading
 * the spell's own duration first makes the AA irrelevant to them, which is what the game does.
 */
export function landingIsPermanent(self: boolean, dbPermanent: boolean, at: PermanenceClaims): boolean {
  if (!self) return false
  if (dbPermanent) return true
  const owned = at.permanentIllusionOwnedTs
  return at.illusion && owned != null && at.ts >= owned
}
