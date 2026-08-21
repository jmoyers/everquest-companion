// buffTimers.ts — the CROWD-CONTROL half of the buffs/debuffs timer overlay (JOS-89), and since
// JOS-140 a half of ONE model rather than a second one.
//
// Design record: docs/plans/buff-timer-overlay.md. The honesty law + the projection live in
// shared/buffTimers.ts; this module owns only the state that law needs and the buffs model
// does not already hold.
//
// WHY A SEPARATE MODULE, AND WHY IT IS THIS SMALL. `modules/buffs.ts` already tracks buff
// INSTANCES per (spell line, entity) — including debuffs on named mobs — with cast-anchored
// attribution, candidate resolution, death/zone/charm censoring and the DB duration prior. The
// overlay reads all of that straight off `BuffsSnap.active` rather than folding a second copy of
// it, because a second fold of the same events is exactly the two-models-with-different-reach scar
// world-model law 4 is made of.
//
// What `buffs.ts` demonstrably does NOT hold is the mez itself. `<mob> has been mesmerized.` is
// claimed by `classifyCcApply`, which sits above the DB matcher in the cascade, so it never
// becomes a `buffApply` and never becomes an instance — `BuffsModule.dispatchEntity` uses the
// event to note the current hostile target and nothing more. That is the whole gap, and this
// module is the whole fix: per-target holds, keyed by mob, so ONE AE mez landing on four enemies
// is four named rows with four independent clocks. (Measured in tests/fixtures/w10-cazic-slow.log:
// one `You begin casting Mesmerization III.` prints two `has been mesmerized.` lines in the same
// second, and later three.)
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT JOS-140 CHANGED, AND WHY THE TICKET EXISTED (measured in JOS-126's investigation).
//
// This module used to be DB-STATED BY DESIGN and said so: a mez counted down from whatever
// spells.json states and nothing could ever teach it otherwise. That is what the field report is
// about. The committed DB has ONE row for the Mesmerization line (24 s, the base rank's) and ZERO
// rows at rank VI or above — the scrape is classic-EQ data that does not know the Legends
// re-tiering — while a 0.14.0 enchanter's Mesmerization VII really runs 42-47 s. So the bar hit
// zero at 24 s and sat there overdue for another twenty seconds, on every cast, forever. The root
// cause was not a broken learner: there was no learner on this path at all.
//
// There is one now, and it is not a second one. Three objects are HANDED to this module by
// `modules/buffs.ts` through the wiring, and every one of them was previously duplicated here:
//   • `CastAnchors` — the attribution gate. Two copies of a cast history is how the two halves
//     drifted; there is one.
//   • `SpellStats` — the learner. Holds mint into it and read `estimateFor(line, caster)` back out,
//     which is the SAME max(DB floor, recent observed max) the buff rows have used since JOS-117.
//   • `HoldGroup` (modules/buffRounds.ts) — the count-and-close rule. The old code kept ONE hold
//     per mob NAME and overwrote its clock, so a round of nine landings became four rows and five
//     wear-offs matched nothing. Now a name holds a multiset and the row carries a count chip.
//
// MEASURED YIELD on the reporter's own bytes (report 01KZJHXJVAA7FNRDW83CTAYSF8, 761 lines): fifty
// landings, twenty-one wear-offs, and exactly TWO clean cycles — 43 s and 44 s, the two rounds
// whose mob name happened to be unique. Fed to the estimator that reads 44 s where it read 24 s,
// and it climbs toward the reporter's own 46 s as unique-name cycles accumulate. Fifty-six cycles
// are refused, which is the point.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT JOS-180 CHANGED: THE LEARNER COULD ONLY EVER LEARN THROUGH A LIVE ROW, AND THE ROW DIES.
//
// `closeOne` is the only mint on this path and it is reachable only through a hold that is still
// standing; the hygiene cull retires a hold at estimate + grace (15 s once the estimate is
// 'observed', JOS-149/156). Those two facts together are a RATCHET IN THE WRONG DIRECTION: the
// moment break-shortened cycles drag the learned number below the true duration, every full-length
// hold is culled before its wear-off arrives, the wear-off closes nothing, and no observation that
// could correct the number can ever be made again.
//
// Measured on the owner's own bytes, Sun Aug 09 2026: Dazzle IV on a turmoil toad landed 22:45:14
// and wore off 22:47:30 — 136 s, the first witnessed full-duration Dazzle cycle in a 1.5M-line log.
// The bar said 100 s (five early breaks, the longest a 115 s reading the sixth had already evicted),
// so the row died at 22:47:09 and the wear-off 21 s later taught nothing.
//
// THE FIX IS IN THREE PIECES AND ONLY THE MIDDLE ONE IS HERE:
//   1. the LATE-JOIN MEMORY ({@link LateJoin}) — a culled landing stays measurable on a DB-floor
//      schedule, so a break line that arrives after the row is gone still mints, through the same
//      cleanliness rules. The ROW cull itself is UNTOUCHED and stays law.
//   2. the WAKE ANNOTATION (`censorWake`, {@link WAKE_CENSOR_MS}) — `<mob> has been awakened by
//      <name>.` marks the sample its wear-off just minted as a broken cycle.
//   3. the SPLIT WINDOW (buffsStats.ts `observedWindowMaxFor`) — where a censored sample is kept as
//      a lower bound but can no longer evict a full-length one. The rule is written there.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT JOS-410 CHANGED: A MEZ CAN BE ENDED BY ANOTHER MEZ, AND THE GAME SAYS SO ONLY ONCE.
//
// One report (01M0B6KS9CFPPQ9WG6V8S9R5T1, 1.5.0) held two defects, and they are the two halves of
// the same sequence — re-mez a held mob with a DIFFERENT mez-line spell:
//   • THE OLD HOLD NEVER ENDED. EQ prints no wear-off, no `awakened`, nothing at all when one mez
//     overwrites another, so the previous hold counted down to zero and squatted there until the
//     unwitnessed cull. The landing sentence is the only evidence there is, and it was unused:
//     {@link BuffTimersModule.retireOverwritten} is what reads it now.
//   • THE NEW ONE WAS NEVER NAMED. Both casts sit inside `OWN_CAST_WINDOW_MS` of the second
//     landing, so both anchored and the row became a FAMILY that agreed on no duration and
//     therefore counted UP. {@link BuffTimersModule.nearestCast} narrows it the way the buffs half
//     (`buffLanding.ts namedLanding`) always has.
// Both are pinned in tests/mezOverwrite.test.mts, which reproduces the reporter's sequence first.

import type { CcVerb, LogEvent } from '../../shared/logEvents'
import type { BuffTimersDelta, BuffTimersSnap, CcEnd, CcHold } from '../../shared/buffTimers'
import type { EstimatorSource } from '../../shared/buffTypes'
import { statedDuration } from '../../shared/buffTimers'
import { SELF_CASTER } from '../../shared/buffTrust'
import { idKey } from '../log/parseCommon'
import { CastAnchors, type Attribution } from './buffAnchors'
import { HoldGroup } from './buffRounds'
import { learningRecordCapMs, MAX_SAMPLE_MS, SESSION_GAP_MS, spellKey, unwitnessedTimeoutMs } from './buffsShapes'
import { SpellStats } from './buffsStats'
import type { EqModule } from './types'

/**
 * How long an END is remembered. It exists so the PROJECTION can retire a matching `ActiveBuff`
 * the buffs model never clears (shared/buffTimers.ts `endedByCc` states why that correction lives
 * there), and so the overlay can flash a drop — both of which are seconds-scale concerns. It is
 * not a history.
 */
export const CC_END_MEMORY_MS = 60_000

/**
 * Slack past an ESTIMATED duration before a hold is dropped for lack of a break line.
 *
 * IT IS MEASURED FROM THE NUMBER THE BAR IS DRAWING, not from the DB row (JOS-126 A6). With the DB
 * row's 24 s this expired a Mesmerization VII hold at 54 s while its real wear-off landed at 42-47
 * — inside the grace by seven seconds, and outside it on a slower round. The grace has to follow
 * the estimate or it retires the very holds the learner needs to close.
 *
 * The number itself now follows the estimate's QUALITY too (`unwitnessedTimeoutMs`, JOS-140): a
 * learned duration gets 15 s and a DB floor gets 60 s. The flat 30 s this used to be sat between
 * the two and was wrong at both ends. Exported still, as the number the fixture tests reason about.
 *
 * JOS-156 collapsed the DB branch from "its own duration again, min 60 s" to a flat 60 s, so a CC
 * hold now leaves on the same schedule as every other row that is not yours. The reasoning, the
 * owner's ruling and the accepted cost are stated once in buffsShapes.ts.
 */
export const CC_END_GRACE_MS = 30_000

/**
 * How close to a mint a `<mob> has been awakened by <name>.` line must land to be talking about it
 * (JOS-180).
 *
 * ONE SECOND, because EQ stamps are second-resolution and the pair is always inside one stamp.
 * MEASURED over the owner's whole log: of 1,518 wake lines, 1,472 share the exact second of that
 * mob's own wear-off, and in all 1,472 the wear-off comes FIRST (1,462 of them on the very next
 * line). The one wake 27 s from a wear-off belongs to a different cycle of the same mob name, and
 * 45 more have no wear-off within 30 s at all — a hold somebody else was maintaining. Anything
 * tighter than a second cannot be expressed by the log; anything looser starts claiming the
 * previous cycle.
 */
export const WAKE_CENSOR_MS = 1_000

/**
 * The bound on a hold whose duration NOBODY states. It is the LONGEST stated CC duration in the
 * committed spells.json — 660 s, Ensnare — rather than a number somebody liked: past the longest
 * hold the game's own data describes, the absence of a break line is evidence we lost the thread,
 * not evidence the mob is still held. `tests/buffTimers.test.mts` re-derives it from spells.json
 * against the parser's own `ccSpell` roster on every run, so a future scrape that adds a longer
 * member fails the suite instead of silently truncating somebody's timer.
 */
export const CC_UNKNOWN_CAP_MS = 660_000

/**
 * THE HOLDS A CORPSE CANNOT BE ABOUT (JOS-228) — the three landing verbs whose hold ANY damage
 * breaks.
 *
 * A mesmerized mob cannot be killed while it is mesmerized: the first point of damage wakes it,
 * and the log SAYS SO before the corpse ever appears. Measured on the owner's whole log for
 * {@link WAKE_CENSOR_MS}: of 1,518 `<mob> has been awakened by <name>.` lines, 1,472 share the
 * exact second of that mob's own `Your <S> spell has worn off of <mob>.` — and in all 1,472 the
 * wear-off comes FIRST. So a mez that is killed is a mez whose BREAK line closed the landing
 * already, and a death line arriving while the hold still stands is, by construction, about
 * ANOTHER mob of that name.
 *
 * `ensnared` is deliberately not a member and is the reason this is a set rather than "every CC
 * hold": a snare is a movement debuff that does nothing to stop you killing what it is on, so a
 * corpse genuinely is that hold ending. Charm is the same story from the other side — a charmed
 * pet dies as often as anything else — and reaches this module with no verb at all.
 */
const DAMAGE_BREAKS: ReadonlySet<CcVerb> = new Set<CcVerb>(['mesmerized', 'enthralled', 'entranced'])

/** A candidate spell as the `cc` (or `charm`) broadcast carries it. */
interface CcCandidate {
  name: string
  durationMs: number | null
}

/** What the anchors made of one landing: the spell, whose it is, and what it can be learned from. */
interface CcIdentity {
  resolved: CcCandidate | null
  /** The rank-stripped LINE, or '' for a family the anchors could not narrow. */
  lineKey: string
  /** The RANKED display name from the cast line. Empty alongside an empty `lineKey`. */
  display: string
  caster: string
  /** Two ranks of this line were in flight at once, so no sample may be minted (ruling 5). */
  rankChanged: boolean
}

/**
 * The landings of one (spell line, mob name), plus the bookkeeping the snapshot does not carry.
 *
 * ONE OF THESE IS ONE ROW. Its `group` holds a landing per mob of that name we believe is held —
 * `group.count` is the count chip, `group.oldestTs` is the clock the row draws (the landing the
 * next anonymous wear-off will close).
 */
interface Held {
  /** Canonical key: the mob's `idKey` plus the spell line, so two spells on one mob are two rows. */
  key: string
  /** Canonical mob key (idKey) — the entity half of the identity. */
  entityKey: string
  /** The mob's display name, raw from the log (world-model law 2). */
  target: string
  /** The rank-stripped spell LINE, when the anchor resolved one. Empty for a family row. */
  lineKey: string
  /** The RANKED display name from the cast line, when one resolved. */
  spell?: string
  candidates: string[]
  /** Whose cast: 'self' or an allowlisted external. */
  caster: string
  durationMs: number | null
  source?: EstimatorSource
  /**
   * True when the landing sentence was one of {@link DAMAGE_BREAKS} — i.e. a hold whose mob cannot
   * be damaged without waking it, so no death line may close a landing of this row.
   */
  mez: boolean
  group: HoldGroup
}

/**
 * A CULLED LANDING THE MODEL STILL REMEMBERS — the late-join memory (JOS-180).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TRAP IT EXISTS TO BREAK, measured on the owner's bytes 2026-08-09. A CC duration sample can
 * only be minted through `closeOne`, which is reachable only through a LIVE hold; and a hold is
 * culled at estimate + grace (15 s once the estimate is 'observed'). So the instant a run of
 * break-shortened cycles drags the learned number below the real duration, every full-length hold
 * is culled BEFORE its wear-off arrives, the wear-off closes nothing, and the estimate can never
 * climb back out. Dazzle IV: real duration 136 s, learned 100 s from breaks, hold culled at 115 s,
 * the first witnessed full cycle in the whole log destroyed 21 s later by its own bar.
 *
 * WHAT THIS IS AND — LOUDLY — WHAT IT IS NOT. It is a MEMORY, not a hold. The ROW still dies on
 * schedule: JOS-149/156's anti-squatting rule is the owner's ruling from live testing and is
 * untouched here, so nothing on screen comes back, no `ends` entry is invented, and the projection
 * sees exactly what it saw before. All that survives the cull is the landing's START TIME and its
 * `clean` flag, held privately, so that if the break line does eventually arrive it can be measured
 * against the landing it belongs to. A cull remains not-evidence; a wear-off remains evidence.
 *
 * THE JOIN WINDOW IS DB-FLOOR-SCALE, and that is the point. Remembering for the CULLED schedule
 * would be circular — that schedule is the underestimate. The floor `spells.json` states is the one
 * number in the system a bad observation cannot drag down, so the memory is measured from THAT row.
 * JOS-203 settled how far: `learningRecordCapMs` — 3× the DB base (for Dazzle, 3 × 96 s = 288 s,
 * against a real wear-off at 136 s), which is the owner's ruling that a learning record retires on
 * the FLOOR's scale and never on the display grace. It used to be `dbFloor + 60 s` (156 s for
 * Dazzle), which is the display number wearing a learner's hat. With no DB row there is no floor
 * and the live hold was already governed by {@link CC_UNKNOWN_CAP_MS}, so the memory simply matches
 * it. It is never SHORTER than the schedule the live row had, or the memory would expire before the
 * thing it remembers.
 *
 * THE BUFFS HALF NOW RETIRES ITS OWN RECORDS ON THIS RULE TOO (`buffsInstanceRules.ts
 * reapOrphanedOpen`), which is the symmetry JOS-203 asked for: that half had the memory — the open
 * cast a late wear-off pairs against — and no reaper at all.
 */
interface LateJoin {
  /** Canonical mob key — the entity half; the map key pairs it with `lineKey`. */
  entityKey: string
  lineKey: string
  caster: string
  /** The RANKED display name, for the sample's label. */
  spell: string
  /** When the landing happened. The span a late break measures is `breakTs - startedTs`. */
  startedTs: number
  /** The last event ts at which this memory may still be joined. */
  joinableUntil: number
}

/** One sample this module just minted, kept only long enough for a wake line to annotate it. */
interface RecentMint {
  entityKey: string
  lineKey: string
  caster: string
  /** The ts the sample was closed at — {@link SpellStats.censorSampleAt}'s join key. */
  ts: number
}

/** Write the estimator's answer onto a hold. The absent `source` is deleted, never set to
 *  undefined, so the snapshot's optional field stays absent rather than explicitly nothing. */
function setDuration(held: Held, est: { ms: number | null; source?: EstimatorSource }): void {
  held.durationMs = est.ms
  if (est.source) held.source = est.source
  else delete held.source
}

export class BuffTimersModule
  implements EqModule<BuffTimersSnap, BuffTimersDelta>
{
  readonly id = 'buffTimers'

  private holds = new Map<string, Held>()
  private ends: CcEnd[] = []
  /** Culled landings a late break line may still be measured against — see {@link LateJoin}. */
  private culled = new Map<string, LateJoin>()
  /** Samples minted within the last {@link WAKE_CENSOR_MS}, awaiting a possible wake annotation. */
  private recentMints: RecentMint[] = []
  private lastEventTs = 0
  private dirty = false

  /**
   * OUR OWN REVISION, NOT THE LAST EVENT'S seq (JOS-87). `useModule` dedupes with
   * `if (d.seq <= knownSeq) return`, so a revision counter only works when the state moves ONLY
   * when an event moves it — and this module's does not: `onTick` expires holds on a log that is
   * idle, which is precisely when someone is watching a mez run out. A delta that advanced no
   * log seq would be dropped as a duplicate and the row would sit on screen forever.
   */
  private rev = 0

  /**
   * The SHARED halves (JOS-140 ruling 1). Both default to private instances so a test or a script
   * can construct this module alone, but production hands over the buffs module's own — see the
   * header. Sharing them is what makes "one model" true: the same anchor admits a mez and a slow,
   * and the same learner holds both their durations.
   */
  constructor(
    private readonly anchors: CastAnchors = new CastAnchors(),
    private readonly stats: SpellStats = new SpellStats()
  ) {}

  reset(): void {
    this.holds = new Map()
    this.ends = []
    this.culled = new Map()
    this.recentMints = []
    this.lastEventTs = 0
    this.rev = 0
    this.dirty = false
  }

  onEvent(ev: LogEvent): void {
    // A 30-minute event-time hole is past any hold this module can carry (the same boundary the
    // buffs model uses), and a character epoch is a different character entirely.
    if (ev.kind === 'epoch') {
      this.clearAll()
      return
    }
    // AN OFFLINE GAP CHANGES NOTHING HERE, AND THAT IS THE DESIGN (JOS-134, owner 2026-08-09;
    // re-affirmed by JOS-140 as the ONE sanctioned divergence between the two halves of one model).
    //
    // `modules/buffs.ts` folds this event to PAUSE your beneficial buffs: EQ freezes them with
    // your character, so their timers stop while you are out of the world. Everything this module
    // holds is the other kind — a mez, a root, an ensnare, on somebody else — and the world those
    // mobs stand in does not stop when you camp. A hold keeps burning down in world time, so its
    // landings are left exactly where they are and the ordinary `sweep` retires them on schedule,
    // offline or not.
    //
    // This is an EXPLICIT no-op rather than an absent case for exactly one reason: the asymmetry
    // looks like an oversight from inside this file, and the next reader to notice that the buffs
    // model pauses and this one does not should find the answer here instead of "fixing" it. The
    // early return also keeps the derived event out of `lastEventTs`, which the primary
    // `sessionStart` it restates has already recorded.
    if (ev.kind === 'offlineGap') return
    if (this.lastEventTs > 0 && ev.ts - this.lastEventTs >= SESSION_GAP_MS) this.clearAll()
    this.lastEventTs = ev.ts
    this.sweep(ev.ts)
    this.dispatch(ev)
  }

  private dispatch(ev: LogEvent): void {
    switch (ev.kind) {
      case 'cc':
        if (ev.refresh === true) this.end(idKey(ev.mob), ev.ts, ev.spell)
        else this.apply(ev.mob, ev.ts, ev.verb, ev.candidates)
        break
      case 'charm':
        // CHARM IS A DETRIMENTAL HOLD, IN THE SAME SHAPE AS A MEZ (JOS-140, owner amendment
        // 2026-08-09). `<mob> has been charmed.` is claimed by `classifyCharm` above the CC
        // classifier, so before this it opened nothing anywhere and there was no charm countdown
        // at all — for an enchanter, charm-break timing is the whole game. It is the same call,
        // the same anchor gate, the same learner: charm durations vary wildly, which is exactly
        // what the max-over-window estimator and the clean-cycle refusal are for.
        //
        // WHAT IT IS NOT is a claim about the entity's DISPOSITION. The charmed mob is your pet
        // and simultaneously carries this detrimental hold, so it legitimately appears in BOTH
        // windows — a Tashani and a charm bar under DEBUFFS, a pet haste under BUFFS, one name.
        // Nothing routes by target (shared/buffTimers.ts `timerRowSurface` reads the row's kind,
        // and the kind reads the spell's nature). JOS-213 added ONE more question and it is a
        // question about the spell too — does it CALM its target — so the pet haste above is still
        // a buff, on the buffs window, on a mob's name. Routing it by the target instead is the
        // cut of JOS-213 that two committed goldens rejected; the header of `timerRowSurface`
        // names them.
        this.apply(ev.mob, ev.ts, undefined, ev.candidates)
        break
      case 'ccWake':
        // THE BREAK ANNOTATION (JOS-180). It ENDS NOTHING — the wear-off line that precedes it in
        // the same second already did, and closing a second landing here would delete a hold on
        // another mob of that name. All it does is go back and mark the sample that wear-off just
        // minted as CENSORED, so a run of broken mezzes cannot evict the full-length cycle the
        // learner is waiting for. See shared/logEvents.ts CcWakeEvent for the measurement.
        this.censorWake(idKey(ev.mob), ev.ts)
        break
      case 'uncharm':
        // Charm and CC break through the SAME sentence family; a charm break on a mob we were
        // also holding is that hold ending too. The line NAMES the charm spell, so it closes that
        // line's hold and leaves a mez on the same mob alone.
        this.end(idKey(ev.mob), ev.ts, ev.spell)
        break
      case 'death':
        // EVERY death shape, on the name that DIED and never on the killer (JOS-156). The
        // parser already unified `You have slain <X>!`, `<X> has been slain by <Y>!` and the
        // killerless `<X> died.` into one event, so there is nothing to branch on here.
        this.onMobDeath(idKey(ev.name), ev.ts)
        break
      case 'zone':
        // You left them behind (world-model law 4's censor).
        this.clearHolds()
        break
      default:
        break
    }
  }

  /**
   * A fresh `<mob> has been mesmerized|enthralled|entranced|ensnared.`
   *
   * THE ANCHOR GATE (JOS-140 ruling 2, JOS-89's original rule generalized). The sentence is a
   * BROADCAST and names no caster, so a hold is opened only when a cast line anchors it — the
   * player's own, or an allowlisted external's. This is the identical ruling `combat/ingest.ts
   * ingestCc` already makes for the encounter model ("a stranger's crowd control is an observation
   * about the room, not an event in our fight"). Without it a crowded zone fills this overlay with
   * other enchanters' work.
   *
   * THE NARROWING is JOS-84's law: the parser hands over every spell the sentence could be, and
   * the MODEL resolves against the anchors. Exactly one anchored candidate ⇒ that spell, by its
   * RANKED name (the cast line is the only line in the family that carries a rank, which is why
   * the row can print `Mesmerization VII` where the log's own landing and wear-off lines cannot).
   * More than one, or none ⇒ the row stays a FAMILY and states a duration only if every candidate
   * agrees on one.
   */
  private apply(mob: string, ts: number, verb?: CcVerb, candidates?: CcCandidate[]): void {
    const cands = candidates ?? []
    // No DB (so no candidates at all) means we cannot tell our own mez from a stranger's, and the
    // honest answer to "whose is it?" is not to guess. No anchored cast means the same thing.
    // (A Quick Buff burst is deliberately NOT an anchor here: it names no spell, and every member
    // of the crowd-control roster is a targeted cast with a cast line of its own.)
    const own = cands.filter((c) => this.anchors.namedAnchorFor(c.name, ts) != null)
    if (own.length === 0) return
    const id = this.resolveCc(own, ts)
    // A FRESH LANDING RETIRES THE MEMORY OF THE OLD ONE (JOS-180). Whatever that mob was holding
    // before, this line proves it is holding this now, and the next break sentence on this name
    // belongs to the live hold rather than to a landing the cull already gave up on.
    if (id.lineKey !== '') this.culled.delete(`${idKey(mob)}|${id.lineKey}`)
    const held = this.ensureHold(mob, id, cands, own)
    // The row remembers the strongest thing any of its landings said (`mez` never goes back to
    // false): if one sentence in this family stated a hold damage breaks, a corpse cannot be it.
    if (verb != null && DAMAGE_BREAKS.has(verb)) {
      held.mez = true
      // …and a RESOLVED one says the mob's OTHER mez just ended (JOS-410). Only resolved: a family
      // row cannot name the line it would be overwriting, and "some mez landed" is not evidence
      // that a different one did.
      if (id.lineKey !== '') this.retireOverwritten(held, ts)
    }

    // The Buffs TAB lists every line the model has knowledge about, and a mez is now one of them —
    // JOS-126's reporter could not see the learned number anywhere, because the CC path never
    // touched the learner at all.
    if (id.lineKey !== '') {
      this.stats.everFaded.add(id.lineKey)
      this.stats.touchLastSeen(id.lineKey, ts)
      // …AND THE RANK THIS CAST NAMED IS THE TAB'S TOO (JOS-411). The hold has always taken its
      // ranked name from the anchored cast; the tab's stats record used to keep whatever rank was
      // equipped the first time a cycle happened to close, so an upgraded Mesmerization still read
      // `VI` there. `noteDisplayName` is the same write a mint does — see
      // `buffsStats.ts preferredDisplayName` for which spelling wins — and it is done HERE because
      // the cast line is the only line in a mez's family that carries the numeral at all, and a
      // broken cycle mints nothing to carry it.
      this.stats.noteDisplayName(id.lineKey, id.caster, id.display)
      held.spell = id.display
    }

    // THE DURATION the bar draws. Resolved ⇒ the shared estimator, keyed on (line, caster): the DB
    // row is the FLOOR and this caster's own clean observations extend it. Unresolved ⇒ the DB
    // agreement rule alone, because there is no line to look a learned value up under.
    setDuration(held, id.lineKey !== '' ? this.stats.estimateFor(id.lineKey, id.caster) : { ms: statedDuration(own) })

    // A FAMILY, or a cast window holding two ranks of one line, can never say what it measured.
    held.group.land(ts, id.lineKey === '' || id.rankChanged)
    this.dirty = true
    this.rev += 1
  }

  /**
   * Which spell (and whose) this landing is, from the anchored candidates. ONE anchored candidate
   * resolves it outright; several are narrowed by {@link nearestCast}, and only a genuine tie
   * leaves an empty `lineKey` — this file's spelling of "a family, not a name", the honest
   * do-not-know JOS-84 requires.
   */
  private resolveCc(own: readonly CcCandidate[], ts: number): CcIdentity {
    const pick = this.nearestCast(own, ts)
    if (!pick) return { resolved: null, lineKey: '', display: '', caster: SELF_CASTER, rankChanged: false }
    return {
      resolved: pick.cand,
      lineKey: spellKey(pick.cand.name),
      display: pick.anchor.display ?? pick.cand.name,
      caster: pick.anchor.caster,
      rankChanged: pick.anchor.rankChanged
    }
  }

  /**
   * THE NEAREST COMPLETED CAST WINS (JOS-410, report 01M0B6KS9CFPPQ9WG6V8S9R5T1).
   *
   * THE DEFECT IT FIXES. Mez a mob with `Mesmerize` and re-mez it with `Dazzle` eight seconds
   * later and BOTH casts sit inside `OWN_CAST_WINDOW_MS` of the second `<mob> has been mesmerized.`
   * — so both candidates anchor, this used to give up on the spot, and the row the reporter got was
   * a two-candidate FAMILY (`Dazzle / Mesmerize`) whose members state 96 s and 24 s. They disagree,
   * `statedDuration` therefore states nothing, and the bar rendered as elapsed time COUNTING UP
   * while the Dazzle he had just cast was never tracked as Dazzle at all.
   *
   * WHY RECENCY IS EVIDENCE HERE AND NOT A COIN FLIP. Casting is SERIAL: the game will not begin a
   * second cast while one is in flight, and a cast that dies (fizzle, interrupt) retracts its own
   * anchor (`CastAnchors.clearCast`). So the newest anchor at or before a landing is the cast that
   * just COMPLETED, and every older one in the window is a cast whose own landing sentence has
   * already been printed. That is a fact about the log's ordering rather than a preference between
   * two spells — which is exactly the bar JOS-84 sets for narrowing a shared sentence.
   *
   * IT IS ALSO THE RULE THE OTHER HALF OF THIS MODEL HAS ALWAYS USED: `buffLanding.ts
   * namedLanding` picks the most recently cast of several anchored candidates and has since
   * JOS-140. The CC half was the outlier, and a family row was the whole cost of the divergence.
   *
   * A TIE STAYS A FAMILY. Two DIFFERENT spells anchored at the same ts means the log printed both
   * cast lines in one second, which recency cannot separate — the honest answer is the one this
   * file already had. (It should be impossible for two distinct completed casts; it is cheap to
   * say so rather than to pick alphabetically.)
   */
  private nearestCast(
    own: readonly CcCandidate[],
    ts: number
  ): { cand: CcCandidate; anchor: Attribution } | null {
    let best: { cand: CcCandidate; anchor: Attribution } | null = null
    let tied = false
    for (const cand of own) {
      const anchor = this.anchors.namedAnchorFor(cand.name, ts)
      if (anchor == null) continue
      if (best == null || anchor.ts > best.anchor.ts) {
        best = { cand, anchor }
        tied = false
      } else if (anchor.ts === best.anchor.ts) {
        tied = true
      }
    }
    return tied ? null : best
  }

  /**
   * A NEW MEZ ON A MOB RETIRES THE OLD ONE (JOS-410, owner ruling 2026-08-19).
   *
   * THE DEFECT, reported verbatim: *"Once Mesmerize is overwritten the debuff window still tracks
   * it."* EQ prints NOTHING when one mez-line spell replaces another on the same mob — no wear-off,
   * no `awakened`, no notice of any kind — so the old hold counted its stated duration down to zero
   * and then squatted there until the unwitnessed-expiry cull got to it a minute later. The landing
   * sentence itself is the only evidence the game gives, and it is enough: a mob holds ONE mez, so a
   * mez-verb landing that resolved to a different line is that mob's previous mez ending.
   *
   * THE VERB IS THE GATE, and it is {@link DAMAGE_BREAKS} — the same set, for the same reason, as
   * JOS-228's death ruling. Those three sentences describe a hold the game maintains exclusively;
   * `ensnared` does not (a rooted mob can be mezzed, and a mezzed mob can be rooted), and charm
   * reaches this module with no verb at all, so neither is touched from either side.
   *
   * IT CLOSES ONE LANDING AND CONTAMINATES THE REST, exactly as a death does to a snare row
   * (JOS-140 ruling 7, restated at {@link onMobDeath}): a name is a name, so an overwrite on `a
   * spiroc banisher` cannot say WHICH of the three we hold was re-mezzed. Oldest-first is the
   * likeliest one twice over here — it is the closest to expiring, which is the one a chain-mezzer
   * re-mezzes on purpose.
   *
   * NOTHING IS LEARNED FROM IT. The whole group is contaminated before the close, so the shortened
   * span mints no duration sample, and the late-join memory of that line on that mob goes too — a
   * wear-off arriving afterwards is about a hold that is no longer there. This is JOS-228's
   * `contaminateAll` heritage: the fix is about DISPLAY, and a span cut short by an overwrite was
   * never a duration.
   *
   * AND IT RECORDS NO `CcEnd`, like a death and unlike a break line. The ends ledger exists to
   * retire an `ActiveBuff` the buffs model never clears, and a hold carrying a mez VERB can never
   * have one: `classifyCcApply` claims those four sentences ABOVE the DB matcher, so they become
   * `cc` events and never `buffApply`. There is nothing on the other side to correct.
   */
  private retireOverwritten(landed: Held, ts: number): void {
    for (const [key, held] of [...this.holds]) {
      if (held === landed || held.entityKey !== landed.entityKey || !held.mez) continue
      held.group.contaminateAll()
      held.group.closeOldest(ts)
      this.culled.delete(`${held.entityKey}|${held.lineKey}`)
      if (held.group.empty) this.holds.delete(key)
    }
  }

  /** The (mob, line) hold this landing belongs to, created on first sight. */
  private ensureHold(
    mob: string,
    id: CcIdentity,
    cands: readonly CcCandidate[],
    own: readonly CcCandidate[]
  ): Held {
    const shown = cands.map((c) => c.name).sort((a, b) => a.localeCompare(b))
    const key = `${idKey(mob)}|${id.lineKey || shown.join('+').toLowerCase()}`
    const existing = this.holds.get(key)
    if (existing) {
      existing.target = mob
      existing.caster = id.caster
      return existing
    }
    const held: Held = {
      key,
      entityKey: idKey(mob),
      target: mob,
      lineKey: id.lineKey,
      candidates: id.resolved ? shown : own.map((c) => c.name).sort((a, b) => a.localeCompare(b)),
      caster: id.caster,
      durationMs: null,
      mez: false,
      // NEVER a singleton: a mob is a NAME the world hands out more than once, and separating
      // two of them is one of world-model law 6's documented non-distinguishables.
      group: new HoldGroup(false)
    }
    this.holds.set(key, held)
    return held
  }

  /**
   * A BREAK LINE said one of these ended — a mez/root wear-off, or a charm break.
   *
   * It closes the OLDEST landing of that (mob, spell) — see buffRounds.ts for why oldest-first is
   * the only honest choice — and MINTS a duration sample when that landing was a clean cycle. The
   * row survives with one fewer on its count chip; only an empty group removes it.
   *
   * A DEATH NO LONGER COMES HERE (JOS-228). It is not a break line at all: it names a mob that
   * stopped existing rather than a hold that ended, and everything a corpse is allowed to do to
   * this model is stated in {@link onMobDeath}.
   */
  private end(entityKey: string, ts: number, spell?: string): void {
    const line = spell != null ? spellKey(spell) : null
    const closedAny = this.closeLive(entityKey, line, ts)
    // THE LATE JOIN (JOS-180). Only when NOTHING live was closed — a live hold is always the
    // better answer, and preferring it is what keeps this from ever competing with the ordinary
    // path. Only for a break line that NAMES its spell, because a landing has to be identified
    // to be measured.
    if (!closedAny && line != null) this.lateJoin(entityKey, line, ts)
    // Recorded even when we held nothing: that is a real CC break, and the projection uses it to
    // retire an ActiveBuff the buffs model does not clear (see shared/buffTimers.ts `endedByCc`),
    // which can exist without a hold beside it.
    this.ends.push({ key: entityKey, ts, ...(spell != null ? { spell } : {}) })
    this.dirty = true
    this.rev += 1
  }

  /**
   * A MOB OF THIS NAME DIED — and the honest answer to "which one?" is a per-hold ruling (JOS-228).
   *
   * THE DEFECT, owner-reported and urgent: mez one mob, kill the one standing next to it that
   * happens to share its name, and the mez bar vanished — at the exact moment a chain-mezzing
   * player needs it. The name is all the log gives, so the death line and the hold line are
   * indistinguishable strings, and this module closed a landing on the strength of that alone.
   *
   * WHAT DECIDES IT IS THE LANDING VERB ({@link DAMAGE_BREAKS}), which is evidence rather than
   * taste: a mesmerized mob cannot be damaged without waking up, and the wake prints its own
   * wear-off FIRST, so a death arriving while a mez hold still stands is about another mob of
   * that name. A snare or a charm has no such protection and a corpse genuinely does end it, so
   * those keep the count-chip rule exactly as JOS-140 ruling 7 wrote it: ONE landing closes, the
   * oldest, and only an empty group removes the row.
   *
   * TWO THINGS A DEATH STILL DOES TO A MEZ ROW, both unchanged rulings:
   *   • IT CONTAMINATES THE WHOLE GROUP (JOS-156, buffRounds.ts ruling 5). A same-named death
   *     means the group has lost track of which mob of that name is which, so nothing standing in
   *     it may ever be minted as a duration sample. This fix is about DISPLAY, never about
   *     learning — a land-to-death span was never a duration and still is not one.
   *   • IT FORGETS THE CULLED MEMORIES (JOS-180's late join) for that name, for the same reason.
   *
   * AND IT RECORDS NO `CcEnd`. An end with no spell on it matches EVERY `ActiveBuff` on that
   * entity in the projection (shared/buffTimers.ts `endedByCc`), so a death that closed a snare
   * used to blank the slow row the buffs model had deliberately kept standing at one fewer on its
   * own count chip — one model overruling the other about a fact the other had already settled
   * correctly (`buffsInstances.ts onEntityDeath`). The buffs half censors deaths itself; this half
   * has nothing to add.
   */
  private onMobDeath(entityKey: string, ts: number): void {
    let changed = false
    for (const [key, held] of [...this.holds]) {
      if (held.entityKey !== entityKey) continue
      held.group.contaminateAll()
      if (held.mez) continue
      held.group.closeOldest(ts)
      if (held.group.empty) this.holds.delete(key)
      changed = true
    }
    this.forgetCulled(entityKey)
    if (changed) {
      this.dirty = true
      this.rev += 1
    }
  }

  /**
   * Close the LIVE holds this ending applies to. Returns whether it found any — which is what
   * decides between the ordinary path and the late join.
   */
  private closeLive(entityKey: string, line: string | null, ts: number): boolean {
    let closedAny = false
    for (const [key, held] of [...this.holds]) {
      if (held.entityKey !== entityKey) continue
      // A named break line closes only the matching LINE; an anonymous one (a charm break with no
      // spell on it) closes every hold on that mob.
      if (line != null && held.lineKey !== '' && held.lineKey !== line) continue
      this.closeOne(held, ts)
      closedAny = true
      if (held.group.empty) this.holds.delete(key)
      this.dirty = true
      this.rev += 1
    }
    return closedAny
  }

  /**
   * Close this hold's OLDEST landing, minting a sample when that landing was a clean cycle. Only a
   * break line reaches here since JOS-228, so the caller no longer has to say whether the ending
   * was one a duration may be learned from — a death takes {@link onMobDeath} instead, and what it
   * does to this group's measurability is stated there.
   */
  private closeOne(held: Held, ts: number): void {
    const closed = held.group.closeOldest(ts)
    const sample = closed?.sampleMs
    if (sample == null || sample <= 0 || sample > MAX_SAMPLE_MS) return
    this.mintSample(
      { entityKey: held.entityKey, lineKey: held.lineKey, caster: held.caster, ts },
      held.spell ?? held.candidates[0] ?? held.lineKey,
      sample
    )
  }

  /**
   * Record one duration sample and re-read every bar it could move.
   *
   * The mint is REMEMBERED for {@link WAKE_CENSOR_MS} (`recentMints`) so the wake line that follows
   * a break — always afterwards, always in the same second — can find the sample it explains. That
   * is the only reason this is a method rather than two lines inside `closeOne`: the late-join path
   * mints too, and both have to be annotatable or the censoring would depend on which route the
   * sample took.
   */
  private mintSample(at: RecentMint, display: string, sampleMs: number): void {
    this.stats.pushSample(at.lineKey, at.caster, display, { ms: sampleMs, ts: at.ts })
    this.recentMints.push(at)
    // Re-read the estimate for every live hold of this line: a sample that just beat the DB floor
    // must move the bars that are still counting, not only the next cast's.
    this.restatLine(at.lineKey, at.caster)
  }

  /**
   * A break line for a mob whose hold the cull already took — measure it against the landing this
   * module still remembers (JOS-180; the ruling and the join window are on {@link LateJoin}).
   *
   * IT MINTS THROUGH THE SAME CLEANLINESS RULES and adds none of its own: only a landing that was
   * `clean` when it was culled is ever remembered, so a family that never narrowed, a round of two,
   * a refresh, a rank change and a contaminated group are all refused here exactly as they are on
   * the live path. The memory is CONSUMED whether or not the span turns out to be usable — a second
   * break sentence for the same landing is not a second observation of it.
   */
  private lateJoin(entityKey: string, lineKey: string, ts: number): void {
    const key = `${entityKey}|${lineKey}`
    const mem = this.culled.get(key)
    if (!mem) return
    this.culled.delete(key)
    if (ts > mem.joinableUntil) return
    const span = ts - mem.startedTs
    if (span <= 0 || span > MAX_SAMPLE_MS) return
    this.mintSample({ entityKey, lineKey, caster: mem.caster, ts }, mem.spell, span)
  }

  /** Every remembered landing on one mob is forgotten (a death, and nothing else calls it). */
  private forgetCulled(entityKey: string): void {
    for (const [key, mem] of this.culled) {
      if (mem.entityKey === entityKey) this.culled.delete(key)
    }
  }

  /**
   * `<mob> has been awakened by <name>.` — mark whatever this mob's break just minted as censored.
   *
   * Nothing is closed and nothing is displayed differently: the estimate is a MAX over both sample
   * windows, so the number does not move today. What moves is tomorrow — a censored sample can no
   * longer evict a full-length one (buffsStats.ts `observedWindowMaxFor` states the rule).
   */
  private censorWake(entityKey: string, ts: number): void {
    for (const m of this.recentMints) {
      if (m.entityKey !== entityKey || ts - m.ts > WAKE_CENSOR_MS || ts < m.ts) continue
      if (!this.stats.censorSampleAt(m.lineKey, m.caster, m.ts)) continue
      this.restatLine(m.lineKey, m.caster)
      this.dirty = true
      this.rev += 1
    }
  }

  /** Re-read the estimator for every live hold of one (line, caster) after a sample landed. */
  private restatLine(lineKey: string, caster: string): void {
    if (lineKey === '') return
    const est = this.stats.estimateFor(lineKey, caster)
    for (const held of this.holds.values()) {
      if (held.lineKey === lineKey && held.caster === caster) setDuration(held, est)
    }
  }

  /** Drop landings nothing ended and ends nobody needs any more. */
  private sweep(nowMs: number): void {
    for (const [key, held] of this.holds) {
      // THE UNWITNESSED-EXPIRY CULL. A hold whose countdown ran out and whose break line never
      // arrived — you died, you zoned, the mob wandered off — is dropped rather than left
      // squatting at 0s. It mints nothing and records no end, because nothing was observed.
      const life =
        held.durationMs != null ? held.durationMs + unwitnessedTimeoutMs(held.source) : CC_UNKNOWN_CAP_MS
      const dropped = held.group.dropExpired(nowMs - life)
      if (dropped.length > 0) {
        this.remember(held, dropped, life)
        this.dirty = true
        this.rev += 1
      }
      if (held.group.empty) this.holds.delete(key)
    }
    this.sweepMemories(nowMs)
    if (this.ends.length > 0) {
      const keep = this.ends.filter((e) => nowMs - e.ts <= CC_END_MEMORY_MS)
      if (keep.length !== this.ends.length) {
        this.ends = keep
        this.dirty = true
        this.rev += 1
      }
    }
  }

  /**
   * File the CLEAN landings a cull just dropped, so a break line arriving late can still find them.
   *
   * Only clean ones: a contaminated landing could not have minted on the live path either, and
   * remembering it would be a second, laxer set of rules for the same question. `lineKey` is
   * necessarily non-empty for a clean landing — `apply` contaminates every family row — so the
   * memory can always be keyed by (entity, line).
   */
  private remember(held: Held, dropped: readonly { startedTs: number; clean: boolean }[], liveLifeMs: number): void {
    const dbMs = this.stats.dbDurationFor(held.lineKey)
    // The LEARNING-RECORD schedule (JOS-203): 3× the DB floor, never shorter than the one the row
    // actually had. Same rule, same function, as the buffs half's orphaned open record — see
    // buffsShapes.ts `learningRecordCapMs` and {@link LateJoin}.
    const window = Math.max(liveLifeMs, learningRecordCapMs(dbMs, CC_UNKNOWN_CAP_MS))
    for (const h of dropped) {
      if (!h.clean) continue
      this.culled.set(`${held.entityKey}|${held.lineKey}`, {
        entityKey: held.entityKey,
        lineKey: held.lineKey,
        caster: held.caster,
        spell: held.spell ?? held.candidates[0] ?? held.lineKey,
        startedTs: h.startedTs,
        joinableUntil: h.startedTs + window
      })
    }
  }

  /** Retire memories past their join window, and mints too old for a wake line to be about. */
  private sweepMemories(nowMs: number): void {
    for (const [key, mem] of this.culled) {
      if (nowMs > mem.joinableUntil) this.culled.delete(key)
    }
    if (this.recentMints.length > 0) {
      this.recentMints = this.recentMints.filter((m) => nowMs - m.ts <= WAKE_CENSOR_MS)
    }
  }

  private clearHolds(): void {
    // The memories go with them: a zone is world-model law 4's censor, and a landing you left
    // behind is one whose break line you will never see (JOS-180 changes what a cull remembers,
    // never what a censor forgets).
    this.culled = new Map()
    if (this.holds.size === 0) return
    this.holds = new Map()
    this.dirty = true
    this.rev += 1
  }

  private clearAll(): void {
    const had = this.holds.size > 0 || this.ends.length > 0
    this.holds = new Map()
    this.ends = []
    this.culled = new Map()
    this.recentMints = []
    if (had) {
      this.dirty = true
      this.rev += 1
    }
  }

  /** The wall-clock heartbeat: a hold expires while the log is idle, which is exactly when a
   *  player is staring at the bar waiting for it. */
  onTick(nowMs: number): void {
    this.sweep(nowMs)
  }

  private buildSnap(): BuffTimersSnap {
    const holds: CcHold[] = []
    for (const h of this.holds.values()) {
      if (h.group.empty) continue
      holds.push({
        key: h.entityKey,
        target: h.target,
        startedTs: h.group.oldestTs,
        ...(h.spell != null ? { spell: h.spell } : {}),
        candidates: h.candidates,
        durationMs: h.durationMs,
        ...(h.source ? { source: h.source } : {}),
        ...(h.group.count > 1 ? { count: h.group.count } : {}),
        ...(h.caster !== SELF_CASTER ? { caster: h.caster } : {})
      })
    }
    holds.sort((a, b) => a.startedTs - b.startedTs)
    return { holds, ends: [...this.ends] }
  }

  snapshot(): { seq: number; state: BuffTimersSnap } {
    return { seq: this.rev, state: this.buildSnap() }
  }

  flushDelta(): { seq: number; delta: BuffTimersDelta } | null {
    if (!this.dirty) return null
    this.dirty = false
    return { seq: this.rev, delta: this.buildSnap() }
  }
}
