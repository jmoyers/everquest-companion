// The buff-INSTANCE store of the buffs model (see buffs.ts for the model's contract).
//
// A buff INSTANCE is a pair (spell LINE, targetEntity) keyed by (spellKey, entityKey). This
// module owns the three live collections — the single pending cast, the landed-and-open
// casts awaiting their fade, and the currently-active instances — plus every mutation of
// them: landing, message-driven application, fade pairing (the duration sample), and the
// CENSORING paths (death / zone / log hole / hygiene / entity retirement) and the offline
// PAUSE — which is not a censor at all but the one place a live clock is rewound (JOS-134).
//
// It knows nothing about log events: BuffsModule translates events into these calls. It
// reads learned per-spell knowledge from SpellStats and the pet bindings from PetEntities,
// and reports a RESOLVED expiry back through the `onExpired` callback it is constructed
// with (Task #47's derived buffExpired) — the module stamps and emits that.
//
// ─────────────────────────────────────────────────────────────────────────────
// AN INSTANCE IS A MULTISET OF LANDINGS (JOS-140 ruling 7). What used to be one `landedTs` per
// (spell, entity) is now a {@link HoldGroup}: one landing per entity of that display name we
// believe is holding the spell, oldest first, with the clean-cycle bookkeeping that decides
// whether a span may be learned from. The same object serves the crowd-control holds, which is
// what makes "one instance model" true rather than aspirational — buffRounds.ts states the round
// rule, the refresh-newest rule and the close-oldest rule once, and both halves obey it.
//
// WHOSE CAST IT IS rides on the record too (`caster`), because the learner is keyed on
// (line, caster): a duration is a fact about the caster's AAs, focus items and rank.

import type { ActiveBuff } from '../../shared/types'
import type { EntityDisposition } from '../combat/entityRules'
import { idKey } from '../log/parser'
import { SELF_CASTER } from '../../shared/buffTrust'
import { HoldGroup } from './buffRounds'
import {
  instanceEntityKey,
  instanceKey,
  instanceSpellKey,
  LAND_TIMEOUT_MS,
  MAX_SAMPLE_MS,
  SELF_KEY,
  spellKey,
  type DurationSample,
  type OpenCast,
  type Pending
} from './buffsShapes'
import type { PetEntities } from './buffsEntities'
import type { SpellStats } from './buffsStats'
import { buildActive, type ActiveSpec } from './buffsView'
import {
  deathBoundSpan,
  deathCensorsActive,
  deathCensorsOpen,
  hygieneCap,
  landingIsPermanent,
  landingSpec,
  openLeftBehindOnZone,
  reapOrphanedOpen,
  reprojectSpec,
  unwitnessedCullCap
} from './buffsInstanceRules'

/** Everything a LANDING states about itself, as one argument (max-params is 4 in this repo). */
export interface LandingSpec {
  target: string
  ts: number
  illusion: boolean
  durationMs: number | null
  /** 'self' or an allowlisted external — the learner's second key (JOS-140 ruling 4). */
  caster?: string
  /**
   * The spell LINE key this instance is identified by, when it differs from what the row is
   * NAMED. A family row is named for every candidate and keyed on one of them — see
   * `instanceSpellKey`.
   */
  lineKey?: string
  /**
   * The RANKED text the cast line spelled, when a named anchor resolved this landing and it is not
   * simply the spell's own name (JOS-238). DISPLAY ONLY — the identity is `spell`.
   */
  castName?: string
  /**
   * The spells this landing sentence could be, when it is a FAMILY the anchor could not narrow
   * (a Quick Buff burst names no spell). Present ⇒ the row shows the ~ chip and mints nothing.
   */
  candidates?: string[]
  /** ts from which the Permanent Illusion AA is owned, when it is. */
  permanentIllusionOwnedTs?: number
}

export class BuffInstances {
  /** The single cast currently in flight (You begin …), or null. */
  pending: Pending | null = null
  /** Landed casts awaiting their fade, keyed by INSTANCE key (spell, entity) — Task #35. */
  open = new Map<string, OpenCast>()
  /** Currently-active buff instances, keyed by INSTANCE key (spell, entity) — Task #35. */
  active = new Map<string, ActiveBuff>()
  /** Set whenever state changed since the last flush. */
  dirty = false

  constructor(
    private readonly stats: SpellStats,
    private readonly pets: PetEntities,
    /** Report a RESOLVED expiry (spell + target display) so the module can emit it. */
    private readonly onExpired: (spell: string, target: string) => void
  ) {}

  reset(): void {
    this.pending = null
    this.open = new Map()
    this.active = new Map()
    this.dirty = false
  }

  /** True when any active instance is of this spell key (the ambiguous-apply tiebreak). */
  hasActiveSpell(key: string): boolean {
    for (const ik of this.active.keys()) if (instanceSpellKey(ik) === key) return true
    return false
  }

  /**
   * ILLUSION EXCLUSIVITY (Task #36, the user's rule): only ONE illusion can be active on a
   * given entity at a time (Permanent Illusion AA or not). Removes every illusion-flagged
   * active + open instance bound to `entityKey` EXCEPT the one being applied now (`keepKey`).
   * A new illusion apply on an entity replaces any prior illusion on that entity — applies
   * to self AND pet (a pet illusion like Boon-on-pet replaces a prior pet illusion).
   */
  clearIllusionsOn(entityKey: string, keepKey: string): void {
    for (const ik of [...this.active.keys()]) {
      if (ik === keepKey) continue
      if (instanceEntityKey(ik) !== entityKey) continue
      if (this.stats.isIllusion(instanceSpellKey(ik))) {
        this.active.delete(ik)
        this.open.delete(ik)
        this.dirty = true
      }
    }
  }

  /** Remove the (single) illusion-flagged SELF active — the `Your illusion fades.` handler. */
  clearSelfIllusion(): void {
    for (const [ik, a] of [...this.active]) {
      if (!a.self) continue
      if (this.stats.isIllusion(instanceSpellKey(ik))) {
        this.active.delete(ik)
        this.open.delete(ik)
        this.dirty = true
        // DERIVED buffExpired (Task #47): the raw `Your illusion fades.` line names no spell,
        // but we've RESOLVED it to the one active self illusion — emit that resolved spell so
        // an alert `where:{spell:'Illusion: Wood Elf'}` can fire on the player-side click-off.
        this.onExpired(a.spell, 'self')
      }
    }
  }

  /**
   * A cast nothing confirmed within the landing window never landed, so its record is DROPPED
   * (JOS-118). It opens nothing on the way out — see `beginCast` for why a cast is not evidence.
   */
  dropUnconfirmedPending(now: number): void {
    if (this.pending && now - this.pending.beganTs >= LAND_TIMEOUT_MS) {
      this.pending = null
    }
  }

  /**
   * Stage a new cast in flight. A CAST OPENS NOTHING — no instance, no open cast, no row
   * (JOS-118, owner: "we should drop provisional all together. i dont want to complicate the
   * model").
   *
   * This used to show the cast OPTIMISTICALLY the instant it began: a `provisional` ActiveBuff
   * bound to `inferCastDisposition`'s guess at the target — for a debuff, `entityKeyFor('hostile')`,
   * i.e. the pet's last CC'd mob or an `unknown-hostile` bucket. It was retracted only by a fizzle
   * or an interrupt. A RESIST is neither, so a resisted debuff left a bar on screen naming a mob
   * the log never said it landed on — the JOS-118 defect. Fifteen seconds later
   * `maybeLandPendingByTime` PROMOTED that same guess to a solid row and an `open` cast that could
   * pair with an unrelated later fade into a duration sample, so the cast path could also poison
   * the mined statistics the JOS-114/117 clean-sample rule exists to protect.
   *
   * The rule is now uniform across buffs, debuffs and CC alike: an instance opens ONLY from a line
   * that CONFIRMS the landing, keyed to the entity that line NAMES (`applyMessageBuff`, or the CC
   * half's `cc` broadcast in modules/buffTimers.ts). No landing line ⇒ no row and no sample, which
   * makes a resist correct by construction: there was never anything to retract.
   *
   * The pending record itself STAYS. It is the cast-in-flight bookkeeping the landing side hangs
   * off — `applyMessageBuff` consumes it, a fizzle/interrupt clears it — and the ANCHOR the
   * attribution gate reads lives beside it in `modules/buffAnchors.ts`. What went is the DISPLAY,
   * not the attribution machinery.
   */
  beginCast(spell: string, key: string, ts: number): void {
    this.pending = { spell, key, beganTs: ts }
  }

  /** A fizzle/interrupt of `key` clears the pending cast. It never opened anything to retract. */
  clearPendingCast(key: string): void {
    if (this.pending?.key !== key) return
    this.pending = null
  }

  /**
   * Infer the target disposition of a cast at LAND time from the current entity state, a
   * LEARNED landing emote (Task #33), and the spell's class. A learned self-emote proves a
   * SELF cast even while a pet is live. A debuff → the inferred hostile fight target. Else
   * the live pet, else self.
   */
  inferCastDisposition(key: string, emoteSubjectKey?: string): EntityDisposition {
    const pets = this.pets
    if (emoteSubjectKey === SELF_KEY) return 'self'
    if (emoteSubjectKey && emoteSubjectKey !== SELF_KEY) {
      if (pets.charmedKey && emoteSubjectKey === pets.charmedKey) return 'charmed'
      if (pets.summonedKey && emoteSubjectKey === pets.summonedKey) return 'summoned'
      return pets.summonedKey ? 'summoned' : 'charmed'
    }
    if (this.stats.classOf(key) === 'debuff') return 'hostile'
    if (pets.charmedKey) return 'charmed'
    if (pets.summonedKey) return 'summoned'
    return 'self'
  }

  /**
   * Apply a buff from an EXACT chat MESSAGE match (Task #34/#35). Confident, immediate,
   * non-provisional, messageDriven. `target` is 'self' for a cast-on-you / self-heal line,
   * else the named target (pet/player/mob) — bound to THAT entity's key.
   *
   * A REPEAT LANDING IS A ROUND, NOT AN OVERWRITE (JOS-140). It goes to the instance's
   * {@link HoldGroup}, which decides whether it refreshes the newest landing or opens another —
   * so two mobs of one name slowed in the same second are a count of two, and a re-slow of one
   * of them is a refresh rather than a third row.
   */
  applyMessageBuff(spell: string, spec: LandingSpec): void {
    const { target, ts, illusion, durationMs } = spec
    const key = spec.lineKey ?? spellKey(spell)
    // WHAT A LANDING MUST STATE TO OPEN A ROW — a duration, an illusion flag, or (JOS-215) the
    // spell DB's own word that it never expires.
    //
    // The third arm is the reported defect (01KZS7FZEAC0Q0T76ZJRS32DSR: "the buff window omits self
    // buffs"). A permanent buff has no duration BECAUSE it is permanent, so the first two arms
    // refused 57 of the 62 permanent spells outright — they printed their landing sentence, the
    // parser emitted a perfectly good `buffApply`, and this line dropped it on the floor. The
    // remaining five are the illusion-flagged permanents, which got in through the middle arm and
    // were then mis-modelled as count-up rows the 90-minute cull retired (see `landingIsPermanent`).
    //
    // `isPermanent` reads `durationText`, never the null `durationMs` beside it — buffsStats.ts
    // carries the measurement that says why those are not the same question.
    if (durationMs == null && !illusion && !this.stats.isPermanent(key)) return
    // A SELF apply of a DETRIMENTAL spell is an incoming debuff a MOB cast on the player —
    // not the player's own buff. Skip it (the bar shows only the player's beneficial buffs).
    const self = target === 'self'
    if (self && this.stats.classOf(key) === 'debuff') return
    this.stats.everFaded.add(key)
    this.stats.touchLastSeen(key, ts)
    if (this.pending?.key === key) this.pending = null

    const { disp, eKey, caster, permanent } = this.bindTo(key, spec)
    const iKey = instanceKey(key, eKey)
    const record = this.openRecord(iKey, {
      spell,
      castName: spec.castName,
      spellKey: key,
      entityKey: eKey,
      caster,
      disp
    })
    // A FAMILY never mints (we do not know which spell it was), so its landings open contaminated.
    record.group.land(ts, spec.candidates !== undefined)
    // A permanent self illusion has no expiry to pair with, so it keeps no open record at all.
    if (permanent) this.open.delete(iKey)
    this.active.set(iKey, this.build(landingSpec(spec.candidates, { key, eKey, disp, caster, permanent, record, ts })))
    // ILLUSION EXCLUSIVITY (Task #36): a new illusion apply on this entity replaces any
    // prior illusion active on it (self OR pet). Only one illusion per entity at a time.
    if (illusion) this.clearIllusionsOn(eKey, iKey)
    this.dirty = true
  }

  /**
   * WHERE a landing binds: the entity it names, that entity's disposition, whose cast it is, and
   * whether it is PERMANENT — the spell's own `Permanent` duration, or a self illusion under the
   * Permanent Illusion AA (`landingIsPermanent` holds both arms). Also the one side effect worth
   * naming — the target's display CASING is remembered here, so the row's chip reads "Cazic-Thule"
   * and not the lowercased key (Task #35).
   */
  private bindTo(
    key: string,
    spec: LandingSpec
  ): { self: boolean; disp: EntityDisposition; eKey: string; caster: string; permanent: boolean } {
    const { target } = spec
    const self = target === 'self'
    const eKey = self ? SELF_KEY : idKey(target)
    if (!self) this.pets.namedEntityDisplay.set(eKey, target)
    return {
      self,
      disp: self ? 'self' : this.pets.dispForNamedTarget(target),
      eKey,
      caster: spec.caster ?? SELF_CASTER,
      permanent: landingIsPermanent(self, this.stats.isPermanent(key), spec)
    }
  }

  /**
   * The open record this landing belongs to, created on first sight — or recreated when the CASTER
   * changed, because a different caster's durations are a different learner key and pooling one
   * cycle across the two would be the thing ruling 4 forbids.
   */
  private openRecord(iKey: string, id: Omit<OpenCast, 'group'>): OpenCast {
    const existing = this.open.get(iKey)
    if (existing?.caster === id.caster) {
      existing.spell = id.spell
      // The NEWEST landing's word on what was cast, including "nothing extra" — a re-land through
      // a Quick Buff burst names no rank, and keeping the previous cast's would attribute a rank
      // to a landing that never stated one.
      existing.castName = id.castName
      existing.disp = id.disp
      return existing
    }
    // SINGLETON unless the entity is a plain HOSTILE: you, your summoned pet and your charmed pet
    // are identities this model tracks (law 4), so a re-cast on one of them is unambiguously a
    // refresh. A mob is only ever a NAME, and the world hands out that name more than once.
    const record: OpenCast = { ...id, group: new HoldGroup(id.disp !== 'hostile') }
    this.open.set(iKey, record)
    return record
  }

  /**
   * AUTHORITATIVE removal (Task #34): a msg_wears_off proves the SELF instance expired NOW.
   * Pairs a duration sample if the self open cast exists, then clears that instance.
   */
  private removeAuthoritative(key: string, entityKey: string, ts: number): void {
    const iKey = instanceKey(key, entityKey)
    const spell =
      this.active.get(iKey)?.spell ?? this.stats.sampleSpellName(key, this.open.get(iKey)?.caster) ?? key
    this.stats.everFaded.add(key)
    this.recordFade(key, entityKey, spell, ts)
    // DERIVED buffExpired (Task #47): the wear-off is now RESOLVED to `spell` on `entityKey`.
    // Alerts match this reliable, unambiguous kind instead of the raw ambiguous buffWearOff.
    this.onExpired(spell, this.pets.targetDisplayFor(entityKey))
  }

  /**
   * SHARED wears-off resolution (Task #45). A wears-off line whose message maps to MULTIPLE
   * candidate spells (haste/strength/armor families) removes whichever matching ACTIVE self
   * buff(s) exist — resolve against the active set, don't guess a single spell:
   *   • exactly ONE candidate active → remove it (the common case; EQ stacking keeps one
   *     member of a family up at a time);
   *   • MULTIPLE candidates active → remove ALL of them (they honestly share this message);
   *   • NONE active → no-op (nothing to remove — don't fabricate a fade sample).
   * Each removal is AUTHORITATIVE (pairs a duration sample + clears the instance).
   */
  removeSharedWearOff(candidateNames: string[], entityKey: string, ts: number): void {
    const cands = new Set(candidateNames.map(spellKey))
    // Find the candidates that actually have an ACTIVE instance on this entity.
    const matched: string[] = []
    for (const ik of this.active.keys()) {
      if (instanceEntityKey(ik) !== entityKey) continue
      const k = instanceSpellKey(ik)
      if (cands.has(k) && !matched.includes(k)) matched.push(k)
    }
    for (const k of matched) this.removeAuthoritative(k, entityKey, ts)
    // NONE active → intentional no-op: a wears-off for a buff we never tracked (e.g. cast by
    // someone else, or already swept) must not create a phantom fade sample.
  }

  /**
   * Pair a fade with its own open landed instance (a duration sample) and clear the active.
   *
   * A SAMPLE IS MINTED ONLY FROM AN EXACT (spell, entity, CASTER) CHAIN (JOS-118, extended by
   * JOS-140 ruling 4): our own cast (or an allowlisted external's), landing on THAT entity,
   * wearing off THAT entity. Only ONE caster's modifiers — AAs, focus effects — shape a duration
   * anyone is entitled to learn from, and another caster's identical spell carries completely
   * different ones. A fade that cannot be matched to its own exact instance mints NOTHING.
   *
   * WHICH LANDING DOES IT CLOSE? The OLDEST (ruling 7). `Your <S> spell has worn off of <mob>.`
   * names the mob but not which mob of that name, so under a fixed duration the oldest landing is
   * the maximum-likelihood one to have just ended — and pairing newest-first instead produced, on
   * the reporter's own bytes, spans from 42 s to 119 s out of the same lines. The row survives
   * with one fewer on its count chip; only an empty group clears it.
   *
   * CLOSURE stays honest in the other direction too: the fade proves THIS entity's copy is gone,
   * so nothing on any other entity is touched — a still-live slow on mob A survives mob B's
   * wear-off.
   */
  recordFade(key: string, entityKey: string, spell: string, fadeTs: number): void {
    this.stats.touchLastSeen(key, fadeTs)
    const iKey = instanceKey(key, entityKey)
    const open: OpenCast | undefined = this.open.get(iKey)
    if (open !== undefined) {
      const closed = open.group.closeOldest(fadeTs)
      // CENSOR a sample whose land→fade window crossed an offline gap (world-model law 5).
      // The fade itself is still authoritative — the instance clears exactly as it always
      // did — but the SPAN is not a duration: it contains an absence whose length we know
      // only to within the reconnect window. Contributing it would poison the per-spell
      // recency-weighted MAX with a value that is guaranteed too large.
      const sample = closed?.sampleMs
      if (open.spannedGap !== true && sample != null && sample > 0 && sample <= MAX_SAMPLE_MS) {
        // NEVER CENSORED on this path (JOS-180): the wake line is a CROWD-CONTROL annotation and
        // there is no sentence in the log that says a beneficial buff or a debuff ended early.
        this.addSample(key, open.caster, spell, { ms: sample, ts: fadeTs })
      }
      if (open.group.empty) this.open.delete(iKey)
      else {
        this.restat(iKey, open)
        this.dirty = true
        return
      }
    }
    this.active.delete(iKey)
    this.dirty = true
  }

  /** Re-project one live instance after its group changed (count / oldest clock moved). */
  private restat(iKey: string, open: OpenCast): void {
    const prev = this.active.get(iKey)
    if (!prev) return
    const { spellKey: key, entityKey, caster, group } = open
    this.active.set(
      iKey,
      this.build(reprojectSpec(prev, { key, entityKey, caster, startedTs: group.oldestTs, count: group.count }))
    )
  }

  private addSample(key: string, caster: string, spell: string, sample: DurationSample): void {
    this.stats.pushSample(key, caster, spell, sample)
    // Restat every live instance of this spell (they share the per-(line, caster) stats).
    for (const [ik, a] of [...this.active]) {
      if (instanceSpellKey(ik) !== key) continue
      const count = this.open.get(ik)?.group.count ?? a.count ?? 1
      const at = { key, entityKey: instanceEntityKey(ik), startedTs: a.startedTs, caster: a.caster ?? SELF_CASTER, count }
      this.active.set(ik, this.build(reprojectSpec(a, at)))
    }
    this.dirty = true
  }

  /**
   * OFFLINE GAP — the buff-timer PAUSE, and the asymmetry that is the whole of JOS-134.
   *
   * YOUR BUFFS PAUSE. Buff timers do NOT run while the character is out of the world; the game
   * saves each buff's REMAINING duration and resumes it at login. So a beneficial instance that
   * survives a gap has its clock shifted forward by the absence, or every countdown reads as
   * long-expired and the hygiene sweep retires a buff that is still up.
   *
   * MEASURED, not assumed (world-model law 1 — the game's semantics were verified before
   * being encoded). Real log, Swift Like the Wind (DB duration 16 min):
   *   land        Fri Jul 31 00:51:59   (`You feel much faster.`)
   *   camp        Fri Jul 31 01:05:43   (+ the five countdown ticks to 01:06:07)
   *   login       Fri Jul 31 14:49:15   (`Welcome to EverQuest Legends!`)
   *   wears off   Fri Jul 31 14:50:28   (`Your speed returns to normal.`)
   * Wall-clock elapsed is 13h58m29s; the measured absence is 13h43m08s; the difference is
   * 15m21s — which matches this character's observed online duration for that spell (two
   * clean same-evening pairs: 15m13s and 15m09s) to within the camp's own ~30s fuzz. And the
   * post-login remainder is 1m13s, exactly the 16-minute timer's leftover after 14m14s of
   * online time. If timers RAN while offline the buff would have expired unobserved around
   * 01:08 and that wears-off line could never have printed at all.
   *
   * DEBUFFS DO NOT PAUSE, AND THAT IS DELIBERATE (owner's design, 2026-08-09; JOS-140 leaves it
   * standing as the one sanctioned divergence between the two halves of one model). What EQ
   * pauses is your CHARACTER; the world it stands in keeps running. A slow you landed on a mob is
   * a timer in the world, not a timer on you, so it keeps burning down while you are gone and its
   * `startedTs` is left exactly where it was. A debuff that outlives the absence therefore reads
   * correctly the moment you are back, and one that did not is swept by the ordinary hygiene
   * pass on its own unshifted clock — no special case, no second opinion. (Nothing else is
   * needed at the boundary either: the `You have entered <zone>.` line lands 0-1 lines after
   * every Welcome in the real log and runs the existing law-4 censor, which is what leaves
   * hostiles and charmed pets behind on a login exactly as on any other zone.)
   *
   * `fromTs` is the last instant the character is KNOWN to have been in the world. Only
   * instances that predate it are shifted: anything raised after it was raised on THIS side of
   * the absence and has nothing to be compensated for.
   *
   * This is DISPLAY ONLY. `startedTs` feeds the countdown and the sort order and nothing else
   * (it is never rendered as a wall clock), and the wears-off line stays the authority on when a
   * buff actually ended. EVERY open cast the gap passes over — buff and debuff alike — is
   * flagged `spannedGap` so its span never becomes a mined duration sample; see the field's own
   * doc in buffsShapes.ts for the two separate reasons the two halves are both refused.
   */
  onOfflinePause(fromTs: number, offlineMs: number): void {
    if (offlineMs <= 0) return
    let changed = false
    for (const [ik, o] of this.open) {
      if (o.group.oldestTs > fromTs) continue
      if (this.pauseOne(ik, o, fromTs, offlineMs)) changed = true
    }
    for (const [ik, a] of this.active) {
      // An active with no open record behind it (a permanent illusion) has no group to shift.
      if (a.cls === 'debuff' || a.startedTs > fromTs || this.open.has(ik)) continue
      this.active.set(ik, { ...a, startedTs: a.startedTs + offlineMs })
      changed = true
    }
    // A cast in flight when the character left the world never completed — the camp (or the
    // crash) took it. Shifting it would resurrect a cast that produced no landing message.
    if (this.pending) {
      this.pending = null
      changed = true
    }
    if (changed) this.dirty = true
  }

  /**
   * One open record across an absence: ALWAYS censored as a sample (both halves, for the two
   * separate reasons buffsShapes.ts states), and shifted ONLY if it is a buff. Returns whether
   * anything changed.
   */
  private pauseOne(ik: string, o: OpenCast, fromTs: number, offlineMs: number): boolean {
    let changed = false
    if (o.spannedGap !== true) {
      o.spannedGap = true
      changed = true
    }
    // The learner is censored either way; only the CLOCK is asymmetric.
    if (this.stats.classOf(o.spellKey) !== 'debuff' && o.group.shiftBy(offlineMs, fromTs)) {
      this.restat(ik, o)
      changed = true
    }
    return changed
  }

  /** Session-gap clear (Task #33, finding #5): wipe live actives/opens/pending. */
  clearForGap(): void {
    const changed = this.active.size > 0 || this.open.size > 0 || this.pending != null
    this.active.clear()
    this.open.clear()
    this.pending = null
    if (changed) this.dirty = true
  }

  /**
   * Drop every instance whose clock predates `ts` — the UNEXPLAINED-hole resolution (JOS-134).
   *
   * A log hole that no login ever explains means we lost the thread rather than that the
   * character left, and the old blanket wipe is still the honest answer for what was standing
   * when it opened. It is SCOPED rather than blanket because the ruling arrives AFTER the hole
   * did — it waits for in-world evidence (JOS-262), and that evidence can be a cast — and
   * anything raised on this side of the hole is evidence from this side of it: the hole says
   * nothing at all about a buff that landed after it.
   */
  dropPredating(ts: number): void {
    let changed = false
    for (const [ik, a] of [...this.active]) {
      if (a.startedTs > ts) continue
      this.active.delete(ik)
      changed = true
    }
    for (const [ik, o] of [...this.open]) {
      if (o.group.oldestTs > ts) continue
      this.open.delete(ik)
      changed = true
    }
    if (this.pending != null && this.pending.beganTs <= ts) {
      this.pending = null
      changed = true
    }
    if (changed) this.dirty = true
  }

  /**
   * Hygiene sweep (Task #33, finding #6): retire any active past its per-spell cap.
   *
   * `heldBeforeTs` is the last-known-online instant of a log hole whose explanation has not
   * arrived yet (0 when there is none). A BUFF older than it is exempt for the length of that
   * wait, and the exemption is the point of it: if the hole turns out to be a logout, that
   * buff's clock is about to be rewound by the absence, and judging it against a `now` from the
   * far side would retire — a beat before the pause lands — exactly the buff the pause exists to
   * keep. DEBUFFS get no exemption; their clocks never stop, so the cap means what it always did.
   *
   * THE HOLD IS A BUFF RULE, NOT A SELF-BUFF RULE, and JOS-149 leaves it that way on purpose.
   * The unwitnessed-expiry cull now reaches NON-SELF buff rows (see `unwitnessedCullCap`), and
   * those clocks are shifted by the pause exactly as a self buff's are — so the cull that judges
   * them has to wait for the same answer the countdown is waiting for, or it would cull across an
   * absence the pause was about to undo.
   */
  sweepHygiene(now: number, heldBeforeTs = 0): void {
    // CALLED ONCE PER EVENT (buffs.ts onEvent), so its cost is paid 1.4M times on a full replay.
    // It used to SPREAD the active map into a fresh array first — 1.4M throwaway arrays, and the
    // copy bought nothing: deleting the entry a Map iteration is currently standing on is
    // well-defined in JS, and this loop deletes nothing else. Everything the loop reads is
    // unchanged (JOS-59).
    let changed = false
    for (const [ik, a] of this.active) {
      if (a.permanent) continue
      if (heldBeforeTs > 0 && a.cls !== 'debuff' && a.startedTs <= heldBeforeTs) continue
      const dbMs = this.stats.dbDurationFor(instanceSpellKey(ik))
      // THE LONG STOP goes first, because it is the one that means "we lost the thread" — and it
      // is the only one that takes the PAIRING RECORD with it.
      //
      // A MULTISET RETIRES ONE LANDING AT A TIME (JOS-140): five mobs mezzed in one round age out
      // one after another, and the row keeps whichever landings are still inside the cap.
      const longCap = hygieneCap(a, dbMs)
      if (now - a.startedTs > longCap) {
        if (this.retireExpired(ik, now - longCap)) changed = true
        continue
      }
      // THE UNWITNESSED-EXPIRY CULL TAKES THE ROW AND LEAVES THE PAIRING RECORD (JOS-156).
      //
      // The owner's ruling is about a BAR SQUATTING AT 0s: a Tashania cast eleven seconds before
      // he died must not sit there for the eleven minutes its DB row states. That is what this
      // line does — the row is gone at `unwitnessedCullCap`, 15 s past a learned duration or 60 s
      // past a DB floor.
      //
      // IT DOES NOT DELETE THE OPEN CAST, and that half is deliberate. MEASURED before it was
      // written: with the record deleted too, twenty consecutive real-length Shiftless Deeds IV
      // cycles (234 s each, against a 150 s DB row) mint ZERO samples and the estimate stays
      // pinned to the DB floor forever — because the first cycle that would teach the true
      // duration is the first one culled, and the learner can never ratchet past DB + 60 s. The
      // bar would then draw 150 s for a 237 s slow, go overdue at 150 s, and be culled on every
      // cast, permanently. THE ONE-LINE REVERT if the owner overrules the refinement is
      // `this.open.delete(ik)` beside the delete below; four tests fail when you add it, three of
      // them cut from the owner's own bytes.
      //
      // It costs nothing where the ruling actually bites: when the line is never coming — you
      // died, the pet despawned — nothing ever pairs with the surviving record and the long stop
      // above collects it minting nothing, exactly as before. `unwitnessedCullCap` governs what is
      // SHOWN; `hygieneCap` governs what is REMEMBERED.
      //
      // The one thing given up against the old tight-cap path: a row whose landings straddle the
      // timeout leaves whole rather than shedding the overdue ones and staying up on a smaller
      // count. The long stop still sheds one at a time, and a group's landings are same-second
      // rounds or refreshes of one another, so straddling the timeout is not a shape the round
      // rule produces.
      if (now - a.startedTs > unwitnessedCullCap(a) && this.active.delete(ik)) changed = true
    }
    // …AND THE RECORDS THE CULL ABOVE LEFT BEHIND (JOS-203). The loop above can only ever reach a
    // record through its active row, so before this the open cast of a culled row had no reaper at
    // all. It is NOT part of `changed`: nothing in the snapshot describes an open record, so a reap
    // must not push a delta. `buffsInstanceRules.ts` states the schedule and the defect.
    reapOrphanedOpen(this.open, this.active, (k) => this.stats.dbDurationFor(k), now)
    if (changed) this.dirty = true
  }

  /** The long-stop path: shed the landings older than `cutoffTs`, and drop the record when empty. */
  private retireExpired(ik: string, cutoffTs: number): boolean {
    const open = this.open.get(ik)
    if (open) {
      open.group.dropExpired(cutoffTs)
      if (!open.group.empty) {
        this.restat(ik, open)
        return true
      }
      this.open.delete(ik)
    }
    return this.active.delete(ik)
  }

  /** playerDeath strips SELF buffs: censor open SELF casts + clear their actives. */
  onPlayerDeath(): void {
    let changed = false
    for (const [ik, o] of [...this.open]) {
      if (o.entityKey === SELF_KEY) {
        this.open.delete(ik)
        changed = true
      }
    }
    for (const [ik, a] of [...this.active]) {
      if (a.self) {
        this.active.delete(ik)
        changed = true
      }
    }
    if (this.pending) {
      // A pending self cast is abandoned (death interrupts it). A debuff/pet cast survives.
      const disp = this.inferCastDisposition(this.pending.key, this.pending.emoteSubjectKey)
      if (disp === 'self') {
        this.pending = null
        changed = true
      }
    }
    if (changed) this.dirty = true
  }

  /**
   * A MOB OF THIS NAME DIED — the death censor, and since JOS-156 the ONE path every death
   * SHAPE reaches. `modules/buffs.ts onDeath` calls it for `You have slain <X>!`, for
   * `<X> has been slain by <Y>!` whoever Y is, and for the killerless `<X> died.` alike; the
   * separate question of whether the ENTITY behind the name is retired stays there.
   *
   * IT CLOSES ONE LANDING, NOT THE ROW (JOS-140 ruling 7). A group is a multiset of same-named
   * mobs we believe are holding the spell, and one death is evidence about ONE of them. The
   * OLDEST is closed for the identical reason a wear-off closes the oldest — the line names the
   * mob but not WHICH mob of that name, so under a fixed duration the oldest is the
   * maximum-likelihood one to have just ended. The row survives with one fewer on its count chip;
   * only an empty group removes it. This used to be `retireEntity(key, {hostileOnly:true})`,
   * which deleted the whole row, so killing one of four slowed mobs cleared all four.
   *
   * AND IT MINTS NO CYCLE. A land-to-death span is not a duration — the spell was cut short by the
   * corpse, not observed running out — so `closeOldest`'s sample is discarded here exactly as it
   * always was and `addSample` is never reached down the clean-cycle path. `contaminateAll` is the
   * separate half — it is about the landings that SURVIVE the close, which are now landings of a
   * group that has lost track of which mob is which, and it is buffRounds.ts ruling 5's own
   * sentence (a death contaminates) written where the death happens rather than left as an
   * accident of how rounds are counted.
   *
   * ─────────────────────────────────────────────────────────────────────────────
   * WHAT IT DOES MINT, SINCE JOS-379, IS A LOWER BOUND — and the distinction above is exactly why
   * it may. The span is not a duration; it is a PROOF THE DURATION IS AT LEAST THIS LONG, because
   * no wear-off ever printed between the landing and the corpse. A landing that is still in this
   * group has by construction not been closed by a wear-off — that is what `recordFade` does to
   * one — so the absence is read off the model's own bookkeeping rather than searched for. Every
   * rail that keeps "at least" honest (the witnessed channel, the one-landing rule, the same-name
   * cap, the absolute cap, the offline-gap refusal) is stated on `deathBoundSpan`, and the bound is
   * pushed through the SAME `addSample` a cycle uses so every live bar of that line re-reads it.
   *
   * IT IS THE OPEN RECORD, NOT THE ROW, THAT IS MEASURED — which is what makes the unwitnessed
   * cull harmless here. JOS-156 deliberately leaves the open cast standing when it retires an
   * overdue row, and JOS-203 retires that record on the FLOOR's schedule (3× the DB base); so a
   * mob that dies after its bar was culled is still measured against the landing it belongs to,
   * with no second memory to build. A zone forgets it (`onZone`), and the death itself CONSUMES it
   * — the landing is closed on the way out, so one corpse can only ever teach once.
   *
   * An ACTIVE with no open record behind it has no group to count down and no landing to close,
   * so it clears outright.
   */
  onEntityDeath(entityKey: string, ts: number): void {
    let changed = false
    for (const [ik, o] of [...this.open]) {
      if (this.censorOpenOnDeath(ik, o, entityKey, ts)) changed = true
    }
    for (const [ik, a] of [...this.active]) {
      if (this.open.has(ik) || !deathCensorsActive(a, instanceEntityKey(ik), entityKey)) continue
      this.active.delete(ik)
      changed = true
    }
    if (changed) this.dirty = true
  }

  /**
   * One open record against one corpse: MEASURE it (the JOS-379 lower bound, when every rail on
   * `deathBoundSpan` holds), then close its oldest landing and contaminate what is left. Returns
   * whether this record was the death's business at all.
   *
   * THE BOUND IS READ BEFORE THE CLOSE, because the close is what consumes the landing it measures,
   * and MINTED before it too: `addSample` only re-projects rows that already exist, so a row this
   * death is about to delete is re-read and then deleted, which costs nothing and keeps the mint
   * beside the reasoning that earned it.
   */
  private censorOpenOnDeath(ik: string, o: OpenCast, entityKey: string, ts: number): boolean {
    const isDebuff = this.stats.classOf(o.spellKey) === 'debuff'
    if (!deathCensorsOpen(o, entityKey, isDebuff)) return false
    // NEVER off the `unknown-hostile` bucket `deathCensorsOpen` also sweeps: that row's target is
    // an INFERENCE, and a span measured against a mob the log never named is not evidence (law 1).
    const ms = isDebuff && o.entityKey === entityKey ? deathBoundSpan(o, entityKey, ts, this.stats) : null
    if (ms != null) this.addSample(o.spellKey, o.caster, o.spell, { ms, ts, deathBound: true })
    o.group.contaminateAll()
    o.group.closeOldest(ts)
    if (!o.group.empty) this.restat(ik, o)
    else if (this.open.delete(ik)) this.active.delete(ik)
    return true
  }

  /**
   * Retire an ENTITY (Task #35, generalized — NO pet-specific branches). Censors every open
   * cast + active instance bound to `entityKey`, buff and debuff alike. Used on uncharm /
   * summoned-pet death / broken-charm death / zone-left-behind / single-pet succession — the pet
   * is just the entity currently claimed. Buffs on other players / arbitrary entities are
   * censored the same way.
   *
   * The plain-mob death no longer comes here (JOS-156): a death is about one mob of a name, not
   * about an identity, so it goes to `onEntityDeath` above.
   */
  retireEntity(entityKey: string): void {
    let changed = false
    for (const [ik, o] of [...this.open]) {
      if (o.entityKey === entityKey) {
        this.open.delete(ik)
        changed = true
      }
    }
    for (const ik of [...this.active.keys()]) {
      if (instanceEntityKey(ik) === entityKey) {
        this.active.delete(ik)
        changed = true
      }
    }
    // Clear the entity from pet state if it was a pet (charmed / broken-charm / summoned).
    this.pets.retireSlots(entityKey)
    if (changed) this.dirty = true
  }

  /**
   * ZONE (the user's rule): the player keeps self buffs; a SUMMONED pet follows and keeps
   * its buffs; a CHARMED pet is LEFT BEHIND (retire + censor); hostile mobs are left behind
   * (censor open debuffs). Uses the SHARED isLeftBehindOnZone rule.
   */
  onZone(): void {
    let changed = false
    for (const [ik, o] of [...this.open]) {
      if (openLeftBehindOnZone(o)) {
        this.open.delete(ik)
        changed = true
      }
    }
    for (const [ik, a] of [...this.active]) {
      const leftBehind =
        a.cls === 'debuff' || a.disposition === 'charmed' || a.disposition === 'hostile'
      if (leftBehind) {
        this.active.delete(ik)
        changed = true
      }
    }
    if (this.pets.clearOnZone()) changed = true
    if (this.pending) {
      const disp = this.inferCastDisposition(this.pending.key, this.pending.emoteSubjectKey)
      if (disp === 'charmed' || disp === 'hostile') {
        this.pending = null
        changed = true
      }
    }
    if (changed) this.dirty = true
  }

  /** Project one instance into its UI row against the current stats + pet identities. */
  private build(spec: ActiveSpec): ActiveBuff {
    return buildActive(spec, this.stats, this.pets)
  }
}
