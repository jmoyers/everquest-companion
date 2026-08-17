// buffs module (Task #19; latency+coverage Task #30; ENTITY-AWARE Task #32; message-driven
// Task #33/#34; 'pet' DE-SPECIALIZED Task #35).
//
// A log-mined buff/debuff-duration model AND a small who/what/when simulation of which
// ENTITY each buff is bound to. All state is derived from events.
//
// THIS FILE is the EqModule surface: it turns log events into calls on the three
// collaborators the model is factored into, and builds the snapshot/delta the UI reads.
//   • buffsInstances.ts — the live (spell, entity) instances: pending / open / active,
//     and every mutation + censoring path over them.
//   • buffsStats.ts     — per-SPELL learned knowledge: duration samples, class, recency, DB.
//   • buffsEntities.ts  — the pet/charm/target identity slots (the who/what).
//   • buffsSession.ts   — the last-seen clock and the LOG-HOLE question: did the character log
//     out (their buffs freeze) or did we lose the thread (their buffs are stale)?
//   • buffsView.ts / buffsShapes.ts — the ActiveBuff projection and the shared constants.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE TASK #35 MODEL (read this before touching anything). A buff INSTANCE is a pair
//   (spell, targetEntity)
// keyed by (spellKey, entityKey) where entityKey is 'self' or a canonical entity-name key.
// The SAME spell can be active on the player AND on the pet AND on a mob simultaneously —
// three independent instances, three independent timers. There is NO special 'pet' class:
//
//   • "pet" is NOT exceptional in the data model. A buff cast on the pet is just a buff
//     bound to the pet's entity key, exactly like a buff on any other entity. The only
//     place "pet" matters is the UI's PRIORITY: show self buffs first, then per-entity
//     groups (the current pet naturally tops that list).
//   • buff vs DEBUFF is a SPELL property: from the DB's spellType (Beneficial vs
//     Detrimental). For a spell absent from the DB we fall back to the plurality of its
//     observed fade-target dispositions. This is what kills the old "class flip" wart
//     (Tashani/Shiftless toggling between pet↔debuff as fades landed on different targets).
//
// A buff binds to the entity the landing MESSAGE named (buffApply carries the target). If
// the pet's name appears in that message, it binds to the pet like anyone else — no
// pet-specific plumbing. A possessive `Your pet's <S> spell has worn off.` fade resolves
// against the CURRENT pet entity's key at fade time.
//
// ─────────────────────────────────────────────────────────────────────────────
// ENTITY LIFECYCLE (generalized, Task #35). The module tracks a tiny entity state
// (charm/petClaim/uncharm/death/zone/single-pet-succession) — conceptually parallel to the
// combat WorldModel, SHARING its pure rules via combat/entityRules.ts. Retiring an entity
// CENSORS every buff instance bound to its key — there are no pet-specific branches; the
// pet is simply the entity currently claimed. Buffs on OTHER players / arbitrary entities
// fall out for free: they're bound to their entity and censored when that entity is retired
// (e.g. left behind on a zone).
//
// CENSORING (the reason the entity model exists): an open cast whose bound entity is retired
// before the fade can NEVER be observed fading → it is DROPPED with no duration sample,
// instead of pairing with a much-later unrelated fade to yield a bogus multi-hour duration.
//
// ─────────────────────────────────────────────────────────────────────────────
// A TRACKED INSTANCE EXISTS ONLY ONCE THE SPELL LANDS ON A NAMED TARGET (JOS-118).
// ONE rule, applied to buffs, debuffs and crowd control alike — mez and slow ARE debuffs, and
// buffs land on individuals too, so none of them is a special case:
//
//   An instance opens ONLY on a line that CONFIRMS the landing, and is keyed to the entity that
//   line NAMES. Never a cast, never an inferred or "current" target, never a resist.
//
// Each shape has a real `who` in the log, and the model uses it rather than inferring one:
//   • DEBUFF ON A MOB    `<mob> slows down.` / `has been mesmerized.` / `has been ensnared.`
//                        → buffApply/cc carries that mob. A RESIST prints no landing line at
//                          all, so there is nothing to open — the JOS-118 defect, fixed by
//                          construction rather than by detecting the resist.
//   • BUFF ON A PERSON   a self landing (`msg_cast_on_you`) → you; a landing that NAMES a group
//                        member → that member, never "me by default".
//   • CC                 a subset of debuffs, same rule. The `cc` broadcast IS the landing, and
//                        `modules/buffTimers.ts` opens its per-mob hold from `ev.mob`.
//
// HONEST LIMIT, stated rather than papered over: where EQ surfaces no landing line, NOTHING is
// tracked. A buff you cast on another player is tracked only if the log actually names them
// landing it. Silence stays silence — the same answer a resist gets.
//
// WHAT A CAST STILL DOES. `castBegin` records a PENDING cast and an ANCHOR (modules/buffAnchors.ts);
// that is the CAST-ANCHORED ATTRIBUTION machinery (JOS-89's ownership gate, JOS-84's candidate
// narrowing, JOS-140's ruling 2). What a cast no longer does is DISPLAY anything — see
// BuffInstances.beginCast for the defect the old optimistic `provisional` row caused and why the
// owner cut it whole ("we should drop provisional all together. i dont want to complicate the
// model").
//
// MINING MODEL:
//   castBegin(S)   → S becomes the PENDING cast (replaces prior pending) and stamps the anchor.
//   otherCastBegin(caster,S) → an anchor ONLY for an allowlisted external (default: nobody).
//   aaActivate(Quick Buff)   → a self anchor that names a WINDOW rather than a spell.
//   castFizzle(S) / castInterrupted(S) → clears pending S and its anchor.
//   buffApply(S,target) → the landing. Opens the instance on `target` and adds a landing to its
//                    round group, whose land→fade span is the duration sample. Gated on the anchor.
//   buffFade(S,target?) → an active instance of S expired on `target`; closes the OLDEST landing
//                    → duration sample when that landing was a clean cycle.
//   playerDeath    → strips ALL self buffs; censors open SELF casts.
//
// A pending cast nobody confirmed within 15s is DROPPED, not landed: no row, and no open cast,
// so it can never pair into a duration sample (the JOS-114/117 clean-sample rule). Landed ts is
// the LANDING line's ts — the cast-BEGIN approximation went with the optimistic row.
//
// ─────────────────────────────────────────────────────────────────────────────
// JOS-140 UNIFIED THE TWO HALVES. `modules/buffTimers.ts` (the per-target crowd-control holds) is
// still a separate EqModule — the overlay hydrates it by id and the JOS-134 pause asymmetry is
// stated there — but it is no longer a separate MODEL: it folds through THIS module's
// `CastAnchors` and mints into THIS module's `SpellStats`, and both halves keep their landings in
// the same `HoldGroup` shape from modules/buffRounds.ts. One attribution rule, one learner, one
// count-and-close rule.

import type { EqModule } from './types'
import type { LogEvent, BuffExpiredEvent } from '../../shared/logEvents'
import type { BuffsDelta, BuffsSnap, MessageOverlay } from '../../shared/types'
import { idKey } from '../log/parser'
import type { SpellDb } from '../data/spellDb'
import { OverlayMining } from './buffsMining'
import type { OverlayRegister, OverlaySeed } from '../data/messageOverlay'
import { charmedPetDiesOnDeathLine } from '../combat/entityRules'
import type { BuffTrustPrefs } from '../../shared/buffTrust'
import { admitLanding, type LandingContext } from './buffLanding'
import { BuffInstances } from './buffsInstances'
import { CastAnchors } from './buffAnchors'
import { PetEntities } from './buffsEntities'
import { SpellStats } from './buffsStats'
import { SessionFrame } from './buffsSession'
import {
  EMOTE_MIN_OBSERVATIONS,
  EMOTE_WINDOW_MS,
  PERMANENT_ILLUSION,
  QUICK_BUFF,
  SELF_KEY,
  spellKey
} from './buffsShapes'

/** One member of the LogEvent union, selected by its `kind` tag. */
type Ev<K extends LogEvent['kind']> = Extract<LogEvent, { kind: K }>

export class BuffsModule implements EqModule<BuffsSnap, BuffsDelta> {
  readonly id = 'buffs'
  private seq = 0

  /** Per-SPELL learned knowledge (samples / class / recency / the DB). */
  private readonly stats: SpellStats
  /** The pet/charm/target identity slots (the who/what). */
  private readonly pets = new PetEntities()
  /** The live (spell, entity) instances + every mutation over them. */
  private readonly inst: BuffInstances

  /** ts from which the Permanent Illusion AA is owned (self illusions become permanent). */
  private permanentIllusionOwnedTs?: number
  /**
   * CAST-ANCHORED ATTRIBUTION (JOS-140 ruling 2), and the ONE copy of it. The crowd-control half
   * folds through this same object (pipeline wiring hands it over), so the two halves of the model
   * cannot end up with two ideas of whose spell just landed — which is precisely how they drifted
   * apart before this ticket.
   */
  private readonly anchors = new CastAnchors()

  // ── emote learning (Task #33): recognize real landing-emote TEXTS ──
  private emoteTextCount = new Map<string, number>()

  /** Last-seen clock + the log-hole question (Task #33, finding #5; deferred by JOS-134). */
  private readonly frame = new SessionFrame()

  /**
   * The observed-message overlay (Task #36) — which lines the miner is fed and the cache over
   * what it builds, both in `buffsMining.ts`. Mines (message, spell) associations from the log to
   * VERIFY / flag-SHARED / flag-CONTRADICTS-WIKI the cast messages, augmenting spells.json with
   * what we actually observe. Seeded warm with the committed baseline + the persisted user
   * overlay at construction.
   */
  private readonly mining: OverlayMining

  /**
   * DERIVED-event emitter (Task #47). When the module RESOLVES a wear-off against the live
   * active set (self message wears-off, illusion fade, or a targeted pet/entity fade), it
   * synthesizes a `buffExpired { spell: RESOLVED, target }` event and hands it back to the
   * bus through this callback so the alerts module can match ONE reliable kind for both the
   * "wore off you" and "wore off your pet/target" sides. Optional — tests and the DB-mining
   * script construct the module without an emitter (they capture emissions differently).
   * `live` is threaded through from the primary event so a replayed wear-off stays live:false.
   */
  private emitDerived?: (ev: LogEvent, live: boolean) => void
  /** The (seq, ts, live) of the primary event currently being folded — used to stamp derived events. */
  private curSeq = 0
  private curTs = 0
  private curLive = false

  constructor(
    db?: SpellDb,
    seedOverlays?: readonly OverlaySeed[],
    emitDerived?: (ev: LogEvent, live: boolean) => void
  ) {
    this.stats = new SpellStats(db)
    this.inst = new BuffInstances(this.stats, this.pets, (spell, target) => {
      this.emitBuffExpired(spell, target)
    })
    this.emitDerived = emitDerived
    this.mining = new OverlayMining(db, seedOverlays)
  }

  /** Install/replace the derived-event emitter after construction (index.ts wires the bus). */
  setDerivedEmitter(fn: (ev: LogEvent, live: boolean) => void): void {
    this.emitDerived = fn
  }

  /**
   * THE SHARED HALVES (JOS-140 ruling 1). The crowd-control module folds the same events into the
   * same learner through the same attribution gate — it is handed these rather than building its
   * own, because two copies of an estimator and two copies of an ownership rule is the state this
   * ticket exists to end.
   */
  spellStats(): SpellStats {
    return this.stats
  }

  castAnchors(): CastAnchors {
    return this.anchors
  }

  /** The externals allowlist (Preferences). Default is empty — you and nobody else. */
  setTrust(prefs: BuffTrustPrefs): void {
    this.anchors.setTrust(prefs)
  }

  /**
   * Synthesize a RESOLVED `buffExpired` derived event (Task #47) onto the bus. `target` is
   * 'self' for a player-side expiry, else the bound entity's display name. Stamped with the
   * primary event's seq/ts/live so it slots into the stream coherently and alerts respects the
   * replay gate. No-op without an emitter (tests/scripts).
   */
  private emitBuffExpired(spell: string, target: string): void {
    if (!this.emitDerived) return
    const who = target === 'self' ? 'you' : target
    const ev: BuffExpiredEvent = {
      kind: 'buffExpired',
      seq: this.curSeq,
      ts: this.curTs,
      // A synthesized human-readable line — this is what the alert's recent-fires panel shows.
      raw: `${spell} wore off ${who}.`,
      spell,
      target
    }
    this.emitDerived(ev, this.curLive)
  }

  /** Serialize the current learned overlay (the served/audit view). */
  overlaySnapshot(): MessageOverlay {
    return this.mining.build()
  }

  /**
   * The overlay REGISTER — per-source counts, for debounced persistence (session.ts, index.ts).
   * Deliberately not `overlaySnapshot()`: what gets written must be attributable to the log that
   * produced it, or the next launch's fold adds its own output back on top (JOS-231).
   */
  overlayRegister(): OverlayRegister {
    return this.mining.register()
  }

  /**
   * A NEW LOG IS ABOUT TO BE FOLDED FROM ITS FIRST BYTE (JOS-231). Mining is game knowledge and
   * survives `reset()` on purpose — a spell's cast messages are the same for every character —
   * but the counts THIS log accounts for are about to be re-stated in full, so its bucket is
   * discarded rather than added to. Called from `session.resetWorldFor`, before the scan.
   */
  beginOverlaySource(key: string): void {
    this.mining.beginSource(key)
  }

  reset(): void {
    this.seq = 0
    this.inst.reset()
    this.stats.reset()
    this.emoteTextCount = new Map()
    this.frame.reset()
    this.permanentIllusionOwnedTs = undefined
    this.anchors.reset()
    this.pets.reset()
  }

  onEvent(ev: LogEvent, live = false): void {
    this.seq = ev.seq
    // A DERIVED buffExpired (Task #47) is our OWN synthesized event — never fold it (that
    // would be a feedback loop). It exists purely for the alerts module to match.
    if (ev.kind === 'buffExpired') return
    // Character rebirth (Task #49): a same-name character was wiped/recreated. Clear ALL LIVE
    // state — actives, open casts, pending, and the entity (pet/charm) bindings — via the
    // same path a 30-min session gap uses. What we KEEP is deliberate: mined durations
    // (samples/stats), the everFaded/class/dispTally maps, learned landing-emote recognition,
    // and the observed-message overlay are GAME-KNOWLEDGE, not character state — a spell's
    // duration and its cast messages are identical across a rebirth, so re-learning them from
    // zero would needlessly cold-start the model. Only the live who/what/when clears.
    if (ev.kind === 'epoch') {
      this.frame.closeHole()
      this.clearAllForGap()
      return
    }
    // OFFLINE GAP (login/logout): the character was out of the world, and EQ PAUSES buff
    // timers while it is — verified against the real log, see BuffInstances.onOfflinePause for
    // the evidence lines and for why DEBUFF clocks are pointedly NOT paused. This is also the
    // event that ANSWERS an open log hole (JOS-134): the hole asked "did the character leave?",
    // and a derived gap is the log saying yes.
    //
    // It is a DERIVED event (sessionDetector.ts), so the bus drains it immediately after its
    // `sessionStart` has finished reaching every listener — and therefore BEFORE the
    // `You have entered <zone>.` line that follows every login (verified for all 20 logins in
    // the real log: the zone line is 0–1 lines after the Welcome). That ordering is fine and
    // deliberate: this shift only moves clocks, and the zone event that lands next runs the
    // EXISTING law-4 censor, which is what leaves charmed pets and hostiles behind on a login
    // exactly as it does on any other zone. We add no second opinion about that here.
    //
    // `lastEventTs` is NOT advanced: the gap restates the Welcome's instant, which the
    // Welcome itself already recorded as a primary event.
    if (ev.kind === 'offlineGap') {
      this.frame.closeHole()
      this.inst.onOfflinePause(ev.fromTs, ev.toTs - ev.fromTs)
      // A logout despawns your pet, so the bindings go even though the buffs on YOU stay. The
      // instances bound to those entities are censored by the zone line that follows the login.
      this.pets.clearForGap()
      return
    }
    // Record the primary event's identity so any buffExpired we synthesize while folding it is
    // stamped with the right seq/ts/live (alerts respects the replay gate via `live`).
    this.curSeq = ev.seq
    this.curTs = ev.ts
    this.curLive = live
    this.holeRuling(this.frame.observe(ev))
    this.inst.dropUnconfirmedPending(ev.ts)
    this.inst.sweepHygiene(ev.ts, this.frame.heldBeforeTs)

    // Observed-message overlay mining (Task #36): feed the anchor cast + any candidate
    // message line so the miner accretes (message, spell) associations across replay + live.
    this.mining.observe(ev)

    this.dispatch(ev)
  }

  /**
   * Route the event to its handler. The three groups are disjoint by `kind` (a switch over a
   * discriminated union), so the split is purely a factoring of one long switch.
   */
  private dispatch(ev: LogEvent): void {
    if (this.dispatchCast(ev)) return
    if (this.dispatchBuff(ev)) return
    this.dispatchEntity(ev)
  }

  /** Cast lifecycle + activated AA. Returns true when the event was handled. */
  private dispatchCast(ev: LogEvent): boolean {
    switch (ev.kind) {
      case 'castBegin':
        this.onCastBegin(ev)
        return true
      case 'spellEmote':
        this.onSpellEmote(ev)
        return true
      case 'otherCastBegin':
        // `<Name> begins casting <S>.` — an anchor ONLY for a caster on the externals allowlist
        // (default: nobody). `CastAnchors` enforces that; the event itself is folded either way so
        // the refusal lives in one place.
        this.anchors.noteOtherCast(ev.caster, ev.spell, ev.ts)
        return true
      case 'castFizzle':
      case 'castInterrupted':
        this.inst.clearPendingCast(spellKey(ev.spell))
        this.anchors.clearCast(ev.spell)
        return true
      case 'aaActivate':
        // `You activate Quick Buff.` is a SELF anchor that names no spell — a window, not a name
        // (owner amendment, 2026-08-09). It applies many spells at once with no cast line of their
        // own, so a rule that demanded one per spell would refuse the player's own buffs.
        if (idKey(ev.name) === QUICK_BUFF) this.anchors.noteQuickBuff(ev.ts)
        return true
      case 'aaSpend':
        this.onAaSpend(ev)
        return true
      default:
        return false
    }
  }

  /** Buff application / expiry. Returns true when the event was handled. */
  private dispatchBuff(ev: LogEvent): boolean {
    switch (ev.kind) {
      case 'buffApply':
        this.onBuffApply(ev)
        return true
      case 'buffWearOff':
        this.onBuffWearOff(ev)
        return true
      case 'illusionFade':
        // `Your illusion fades.` (Task #36): the player's active illusion clicked/wore off.
        // Only one illusion is ever active on self, so this removes whichever illusion self
        // buff is active — no spell name needed (the line is 27-way-ambiguous by design).
        this.inst.clearSelfIllusion()
        return true
      case 'heal':
        this.onHeal(ev)
        return true
      case 'buffFade':
        this.onBuffFade(ev)
        return true
      case 'playerDeath':
        this.inst.onPlayerDeath()
        return true
      default:
        return false
    }
  }

  /** Entity lifecycle (the who/what state). */
  private dispatchEntity(ev: LogEvent): void {
    switch (ev.kind) {
      case 'charm':
        this.onCharm(ev)
        break
      case 'petClaim':
        this.onPetClaim(ev)
        break
      case 'uncharm':
        this.onUncharm(ev)
        break
      case 'cc':
        this.pets.petTargetKey = idKey(ev.mob)
        this.pets.petTargetDisplay = ev.mob
        break
      case 'death':
        this.onDeath(ev)
        break
      case 'zone':
        this.inst.onZone()
        break
      default:
        break
    }
  }

  private onCastBegin(ev: Ev<'castBegin'>): void {
    const key = spellKey(ev.spell)
    this.anchors.noteSelfCast(ev.spell, ev.ts)
    this.stats.touchLastSeen(key, ev.ts)
    this.inst.beginCast(ev.spell, key, ev.ts)
  }

  private onSpellEmote(ev: Ev<'spellEmote'>): void {
    const p = this.inst.pending
    if (p && ev.ts - p.beganTs <= EMOTE_WINDOW_MS && ev.ts >= p.beganTs && !p.emoteSubjectKey) {
      const n = (this.emoteTextCount.get(ev.text) ?? 0) + 1
      this.emoteTextCount.set(ev.text, n)
      if (n >= EMOTE_MIN_OBSERVATIONS) {
        p.emoteSubjectKey = ev.subject === 'self' ? SELF_KEY : idKey(ev.subject)
      }
    }
  }

  private onAaSpend(ev: Ev<'aaSpend'>): void {
    if (this.permanentIllusionOwnedTs == null && idKey(ev.ability) === PERMANENT_ILLUSION) {
      this.permanentIllusionOwnedTs = ev.ts
    }
  }

  private onBuffApply(ev: Ev<'buffApply'>): void {
    // CAST-ANCHORED ATTRIBUTION (JOS-140 ruling 2/3, extending Task #45's own-cast gate). A
    // landing emote is a BROADCAST and names no caster, so without an anchor a stranger's buff
    // binds as ours. `admitLanding` is the whole gate; a null answer means the landing produces
    // nothing at all, which is the honest answer and the one three field reports asked for.
    const landing = admitLanding(ev.candidates, ev.ts, this.landingContext())
    if (!landing) return
    this.inst.applyMessageBuff(landing.spell, {
      target: ev.target,
      ts: ev.ts,
      illusion: landing.illusion,
      durationMs: landing.durationMs,
      caster: landing.caster,
      // DISPLAY ONLY (JOS-238): the rank the cast line spelled. `landing.spell` is the identity.
      ...(landing.castName ? { castName: landing.castName } : {}),
      ...(landing.lineKey ? { lineKey: landing.lineKey } : {}),
      ...(landing.candidates ? { candidates: landing.candidates } : {}),
      permanentIllusionOwnedTs: this.permanentIllusionOwnedTs
    })
  }

  private onBuffWearOff(ev: Ev<'buffWearOff'>): void {
    // Authoritative, message-driven expiry. The wears-off emote prints to the buff
    // HOLDER (the player), so it clears the SELF instance of this spell (Task #34/#35).
    // MANY spells share a wears-off message (Task #45): resolve against the ACTIVE self
    // set. EQ stacking keeps at most one candidate of a family active, so exactly one
    // matches the common case; if several somehow match, remove ALL (they share the
    // line — be honest). None active → no-op. Removing by only the first candidate (the
    // old code) MISSED the actually-active buff (e.g. self Quickness/Swift never cleared
    // because the first candidate "Aanya's Quickening" was never the active one).
    this.inst.removeSharedWearOff(ev.candidates, SELF_KEY, ev.ts)
  }

  private onHeal(ev: Ev<'heal'>): void {
    // A HoT TICK IS NOT A LANDING (JOS-280, the JOS-118 law one lane over). `You healed <X> over
    // time for N by <Spell>.` is printed once per tick by an ALREADY-LANDED heal-over-time, and it
    // is cast-detached by construction — buffFanOut.ts:88 refuses the same event for the same
    // reason. Without this guard every tick re-entered the landing path on the rank-STRIPPED name:
    // the clock restarted every 6 s (the reported "timer bar resets in combat"), `openRecord`
    // overwrote `castName` with undefined so the rank chip died, a tick arriving after the
    // wear-off resurrected a phantom bar, and every tick→fade span was minted as a duration
    // sample (a 5 s median for a 41 s spell). Only the DIRECT heal line — the Quick Buff burst's
    // `You healed Primitive … by Symbol of Pinzarn.`, W7's admission arm — opens anything here.
    if (ev.overTime === true) return
    const db = this.stats.db
    if (db && ev.spell && idKey(ev.healer ?? '') === 'you') {
      const key = spellKey(ev.spell)
      const dbSpell = db.byKey.get(key)
      if (dbSpell?.durationMs != null) {
        this.inst.applyMessageBuff(dbSpell.name, {
          target: 'self',
          ts: ev.ts,
          illusion: dbSpell.illusion,
          durationMs: dbSpell.durationMs,
          permanentIllusionOwnedTs: this.permanentIllusionOwnedTs
        })
      }
    }
  }

  private onBuffFade(ev: Ev<'buffFade'>): void {
    const key = spellKey(ev.spell)
    this.stats.everFaded.add(key)
    // THE WEAR-OFF CHANNEL IS WITNESSED HERE, AND ONLY FOR THE TARGET-NAMED SENTENCE (JOS-379).
    //
    // `Your <X> spell has worn off of <target>.` is the ONE line that proves this spell announces
    // its own end on somebody who is not you — which is the only thing that lets a later SILENCE
    // over a corpse mean anything (buffsStats.ts `wearOffWitnessed` states why, and
    // `buffsInstanceRules.ts deathBoundSpan` is what reads it). The targetless shapes are a
    // different channel entirely: `classifyWornOff` emits them with no target at all for a self
    // buff and with the literal `'pet'` for `Your pet's <X> spell has worn off.`, so the named
    // form is exactly "a target that is not the possessive". A mob cannot be called `pet` — the
    // possessive form never carries a name — so the two can not collide.
    if (ev.target != null && ev.target !== 'pet') this.stats.witnessWearOffChannel(key)
    // Resolve the fade's target entity. A possessive 'pet' form resolves against the
    // CURRENT pet entity's key; a named mob → that mob's key; targetless → self.
    // (The fade's DISPOSITION used to be tallied here as a fallback CLASSIFIER for a spell the DB
    // did not type. JOS-140 ruling 8 deletes that: buff-vs-debuff comes from the spell's nature
    // and never from the shape of the target — see buffsStats.ts `classOf`.)
    const { entityKey } = this.pets.fadeTargetEntity(ev.target)
    // A FADE IS NOT A LANDING (JOS-118). This used to retro-land the pending cast so the
    // land→fade span became a duration sample, which is unsound whenever the fade belongs to an
    // EARLIER instance of the same spell: tests/fixtures/e2e-deep-link.log casts Pacify at
    // 20:31:25 and prints `Your Pacify spell has worn off of a fire giant warrior.` two seconds
    // later — a different mob's older cast — which minted a 2-second Pacify sample. The pending
    // cast is simply dropped; only a confirmed landing opens the instance a fade can pair with.
    this.inst.clearPendingCast(key)
    this.inst.recordFade(key, entityKey, ev.spell, ev.ts)
    // DERIVED buffExpired (Task #47): buffFade already carries a RESOLVED spell + target
    // (the possessive/named-target worn-off shapes name both). Synthesize the unified
    // resolved event so ONE alert kind covers a fade on your pet/target as well as the
    // self message wears-off above — the "helps you with both by default" the user asked for.
    this.emitBuffExpired(ev.spell, this.pets.buffFadeTargetDisplay(ev.target, entityKey))
  }

  private onCharm(ev: Ev<'charm'>): void {
    const newKey = idKey(ev.mob)
    // DISPOSITION, NOT IDENTITY (Task #37): re-charming the SAME name after a charm break
    // (with no intervening death/zone of that name) is the SAME entity — its buffs are
    // still active on it and it must NOT trigger single-pet succession against itself.
    // A break→re-charm cycle is the common case (seconds apart) and preserves everything.
    const sameAsBroken = this.pets.brokenCharmKey === newKey
    const sameAsCharmed = this.pets.charmedKey === newKey
    if (!sameAsBroken && !sameAsCharmed) {
      // SINGLE-PET INVARIANT: charming a DIFFERENT entity retires the prior pet(s) —
      // including a broken-charm entity that we never re-charmed (you moved on to a new
      // mob, so the old one really is left behind).
      if (this.pets.charmedKey) this.inst.retireEntity(this.pets.charmedKey)
      if (this.pets.brokenCharmKey) this.inst.retireEntity(this.pets.brokenCharmKey)
      if (this.pets.summonedKey) this.inst.retireEntity(this.pets.summonedKey)
      this.pets.petTargetKey = undefined
      this.pets.petTargetDisplay = undefined
    }
    // Re-bind (or bind) the charmed entity. If this reconnects a broken charm, its buff
    // instances were never censored, so they remain active on it.
    this.pets.charmedKey = newKey
    this.pets.charmedDisplay = ev.mob
    this.pets.brokenCharmKey = undefined
    this.pets.brokenCharmDisplay = undefined
  }

  private onPetClaim(ev: Ev<'petClaim'>): void {
    const key = idKey(ev.name)
    const pets = this.pets
    if (key !== pets.charmedKey && key !== pets.summonedKey && key !== pets.brokenCharmKey) {
      // Single-pet succession: claiming a DIFFERENT pet retires the prior pet(s), including
      // a broken-charm entity you never re-charmed (Task #37) — you've moved to a new pet.
      if (pets.summonedKey) this.inst.retireEntity(pets.summonedKey)
      if (pets.charmedKey) this.inst.retireEntity(pets.charmedKey)
      if (pets.brokenCharmKey) this.inst.retireEntity(pets.brokenCharmKey)
      pets.summonedKey = key
      pets.summonedDisplay = ev.name
    }
  }

  private onUncharm(ev: Ev<'uncharm'>): void {
    // CHARM BREAK = DISPOSITION CHANGE, NOT RETIREMENT (Task #37). The mob KEEPS its
    // identity and every buff instance — it's simply hostile-capable now until you
    // re-charm it (the common break→re-charm cycle, seconds apart). We do NOT censor or
    // retire here (the old code called retireEntity, which RESET the pet's buffs — the
    // user-reported bug). Move it to the broken-charm slot so a re-charm of the SAME name
    // reconnects to it with buffs intact; a death or zone of that name in the meantime
    // retires it via the existing paths (making the next charm a genuinely new entity).
    if (this.pets.charmedKey === idKey(ev.mob)) {
      this.pets.brokenCharmKey = this.pets.charmedKey
      this.pets.brokenCharmDisplay = this.pets.charmedDisplay
      this.pets.charmedKey = undefined
      this.pets.charmedDisplay = undefined
    }
  }

  /**
   * A DEATH IS TWO QUESTIONS, AND THEY HAVE DIFFERENT ANSWERS (JOS-156).
   *
   * The first is "did something of that name just die?", and the log answers it the same way in
   * all three shapes — `You have slain <X>!`, `<X> has been slain by <Y>!` for any Y, and the
   * killerless `<X> died.` — because `parseWorld` unified them into one `death` event naming the
   * DEAD one. So the debuff censor runs unconditionally, on `ev.name` and never on the killer.
   * (The killer is a name too, and in the owner's Plane of Sky bee fight it was the SAME name:
   * `Bzzazzt has been slain by Bzzazzt!` is a charmed bee killing its twin.)
   *
   * The second is "is the ENTITY behind that name retired?", which is about identity and is the
   * only place the pet bindings get a vote. That is what used to swallow the first question
   * whole: a death naming the charmed pet went into the conservative never-censor-a-live-pet
   * branch and nothing at all happened — not even to the slow on the corpse.
   */
  private onDeath(ev: Ev<'death'>): void {
    const key = idKey(ev.name)
    const pets = this.pets
    this.inst.onEntityDeath(key, ev.ts)
    if (this.deathRetiresEntity(ev, key)) this.inst.retireEntity(key)
    if (key === pets.petTargetKey) {
      pets.petTargetKey = undefined
      pets.petTargetDisplay = undefined
    }
  }

  /** Whether this death retires the ENTITY (its identity + every buff on it), not just its debuffs. */
  private deathRetiresEntity(ev: Ev<'death'>, key: string): boolean {
    const pets = this.pets
    const killerIsYou = ev.bySelf || idKey(ev.killer ?? '') === 'you'
    if (key === pets.summonedKey) return !killerIsYou
    if (key === pets.charmedKey) {
      const killerSameName = !ev.bySelf && ev.killer != null && idKey(ev.killer) === key
      return charmedPetDiesOnDeathLine({ killerIsYou, killerSameName })
    }
    // A death naming the broken-charm entity (Task #37): the ex-pet is now a hostile mob you're
    // likely killing, so THIS death genuinely retires it — censoring its buffs so the next charm
    // of that name binds a fresh entity (rule #3). It's fully retired now, not conservatively
    // kept: charm no longer protects it (the twin-ambiguity that made us keep a LIVE charmed pet
    // doesn't apply once the charm has broken).
    return key === pets.brokenCharmKey
  }

  /**
   * A log hole that no login ever explained (SessionFrame has the whole argument). We lost the
   * thread rather than the character having left, so what was standing when it opened goes, and
   * the pet bindings with it — the same blanket clear this used to do the moment a hole appeared.
   * `null` is the ordinary case: no hole, or one still waiting for its answer.
   */
  private holeRuling(unexplainedBefore: number | null): void {
    if (unexplainedBefore === null) return
    this.inst.dropPredating(unexplainedBefore)
    this.pets.clearForGap()
  }

  /**
   * The wall-clock heartbeat. It NO LONGER RULES ON AN OPEN HOLE (JOS-262): the hole is a
   * question about the LOG, and only the log's own next line can answer it — see SessionFrame's
   * header for the measured case (start the app while the game is still loading and the tick
   * used to wipe the previous session's buffs seconds before the `Welcome` that would have
   * paused them). What the tick still does is age the model: unconfirmed casts and the hygiene
   * sweep, the latter still holding whatever an open absence protects.
   */
  onTick(nowMs: number): void {
    this.inst.dropUnconfirmedPending(nowMs)
    this.inst.sweepHygiene(nowMs, this.frame.heldBeforeTs)
  }

  /** The gate's dependencies, bound once — see modules/buffLanding.ts for the rule itself. */
  private landingContext(): LandingContext {
    return {
      anchors: this.anchors,
      ...(this.stats.db ? { db: this.stats.db } : {}),
      hasActiveSpell: (lineKey: string) => this.inst.hasActiveSpell(lineKey)
    }
  }

  /** Session-gap clear (Task #33, finding #5): wipe live actives/opens/pending + pets. */
  private clearAllForGap(): void {
    this.inst.clearForGap()
    this.pets.clearForGap()
  }

  private buildSnap(): BuffsSnap {
    return {
      active: [...this.inst.active.values()].sort((a, b) => a.startedTs - b.startedTs),
      stats: this.stats.buildStats(),
      overlay: this.mining.build()
    }
  }

  snapshot(): { seq: number; state: BuffsSnap } {
    return { seq: this.seq, state: this.buildSnap() }
  }

  flushDelta(): { seq: number; delta: BuffsDelta } | null {
    if (!this.inst.dirty) return null
    this.inst.dirty = false
    return { seq: this.seq, delta: this.buildSnap() }
  }
}
