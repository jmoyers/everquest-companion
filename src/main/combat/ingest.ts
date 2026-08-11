// THE INGEST SWITCH — one canonical LogEvent in, one state transition out. Extracted
// verbatim from engine.ts and split along the three event FAMILIES the original switch
// already grouped its cases into:
//
//   ingestWorld    — epoch / zone / charm / petClaim / uncharm / cc / death: the
//                    entity and segmentation lifecycle.
//   ingestCombat   — damage / heal / healUnstated / mitigation / miss / resist: the meter itself.
//   ingestCast     — castBegin / fizzle / interrupt / resume: the own-cast lifecycle both
//                    ownership inferences (cast-less procs, charm/CC binding) run off.
//   ingestChoice   — stance / invocation / active special attack: the character's STANDING
//                    choices, which persist across pulls and zones until the game prints a
//                    different one. Not events in a fight; they change what a swing MEANS.
//   ingestModifier — coats / procs / dispel landings / Quick Buff / your own death: annotations.
//
// The families are disjoint on `ev.kind`, so the chain is exactly the old switch: each tries
// its own cases and reports whether it consumed the event. Any other kind is ignored.

import { idKey } from '../log/parser'
import { damageCategory } from './taxonomy'
import { evalClosure, ensureEncounter, finalizeCurrent, finalizeZoneSession } from './lifecycle'
import { route, routeHeal, routeHealUnstated, routeMiss, routeMitigation, routeResist, verdict } from './routing'
import { SEC_ANALYTICS, SEC_DISPATCH } from './foldProbe'
import {
  applyStance,
  routeCoat,
  routeDispelLanding,
  routeDry,
  routeProc,
  routeProcBuffApply,
  routeProcBuffWearOff
} from './procRouting'
import {
  QUICK_BUFF_AA,
  isCastlessHeal,
  laneNameFor,
  procEligibleDamage,
  type SpellOrigin
} from './procDetect'
import { CC_HOLD_MS } from './encounter'
import { Agg, type DamageEvent } from './aggregate'
import type { WindowFold } from './procWindows'
import type { EngineState } from './state'
import type { Attribution } from './routing'
import type {
  CcEvent,
  CharmEvent,
  DamageEventE,
  DeathEvent,
  HealEvent,
  LogEvent,
  MissEvent,
  MitigationEvent,
  PetClaimEvent,
  SpecialAttackEvent
} from '../../shared/logEvents'

/**
 * Crowd control (mez/root, not charm). Evaluate any pending closure at this
 * ts first (a CC on a fresh pull shouldn't attach to a stale fight), then
 * mark the CC'd instance engaged + CC-held so the encounter stays OPEN across
 * the mez-and-wait gap. A CC'd instance counts as "alive" for closure.
 *
 * OWNERSHIP GATE (Task #65). `<mob> has been mesmerized.` is a BROADCAST with no caster
 * (charmModel.ts has the measurements), so an APPLICATION only counts when it resolved one of
 * the owner's own CC casts. A foreign mez is fully INERT here — it does not engage the mob, it
 * does not open a hold, and it does not touch `lastActivityTs`; a stranger's crowd control is
 * an observation about the room, not an event in our fight. The REFRESH shape is exempt by
 * construction: it is derived from `Your <spell> spell has worn off of <mob>`, which only the
 * caster sees and which names us as that caster.
 */
function ingestCc(st: EngineState, ev: CcEvent): void {
  if (!ev.refresh && !st.charm.ccBroadcast(ev.ts)) {
    st.log(ev.ts, 'cc', 'dropped', `✜ CC on ${ev.mob} - not ours (no own cast to resolve)`)
    return
  }
  evalClosure(st, ev.ts)
  const inst = st.world.resolve(ev.mob, ev.ts)
  if (inst.instanceId === 'you') return
  const enc = ensureEncounter(st, ev.ts)
  enc.engaged.add(inst.instanceId)
  enc.engagedSeen.set(inst.instanceId, ev.ts)
  enc.ccActiveUntil.set(inst.instanceId, ev.ts + CC_HOLD_MS)
  st.lastActivityTs = ev.ts
  const tag = ev.refresh ? 'refresh' : 'applied'
  st.log(ev.ts, 'cc', 'info', `✜ CC ${tag}: ${st.world.label(inst)}${ev.spell ? ` (${ev.spell})` : ''}`)
}

/**
 * `<mob> has been charmed.` — THE OWNERSHIP GATE (Task #65). The line is a BROADCAST and names
 * no caster, so it binds ONLY when it resolved one of the owner's own charm casts
 * (charmModel.ts holds the state table and the whole-log measurement). A foreign charm is
 * remembered as an observation — nothing else — so it stays available to the petClaim PROMOTE
 * path and never enters the attribution set.
 */
function ingestCharm(st: EngineState, ev: CharmEvent): void {
  const key = idKey(ev.mob)
  if (st.charm.charmBroadcast(key, ev.mob, ev.ts) === 'foreign') {
    st.log(ev.ts, 'charm', 'dropped', `⚡ ${ev.mob} charmed by someone else - not your pet`)
    return
  }
  const inst = st.world.charm(ev.mob, ev.ts)
  st.notePet(key)
  st.log(ev.ts, 'charm', 'info', `⚡ charmed ${st.world.label(inst)} [${inst.instanceId}]`)
}

/** How a pet came to be bound. Only the debug line reads it — every route below is the same
 *  state transition, on purpose (a second retirement path is what law 4 is a scar from). */
type ClaimVia = PetClaimEvent['via'] | 'petBuff'

const CLAIM_NOTE: Record<ClaimVia, string> = {
  tell: '',
  leader: ' (it named you its leader)',
  petBuff: ' (you cast a pet-only spell on it)'
}

/**
 * A pet identified you as its owner, so the named entity is your pet. THREE lines produce this
 * one transition, and this function deliberately does not care which — `via` reaches the debug
 * line and nothing else:
 *
 *   via 'tell'    `<Name> told you, '… Master.'` — private, unforgeable, but only ever sent by a
 *                 pet you have ORDERED.
 *   via 'leader'  `<Name> says, 'My leader is <You>.'` — the `/pet who leader` answer (JOS-52),
 *                 the on-demand way out of that blind spot. Broadcast, so the parser has already
 *                 refused every one of these that named anyone but the tailed character; by the
 *                 time it arrives here it is the same fact the tell states.
 *   via 'petBuff' a named landing that resolved YOUR OWN cast of a `targetType: Pet` spell
 *                 (JOS-188 — bindPetBuffLanding below). The one route that needs nothing of the
 *                 player but the buff they were casting anyway.
 *
 * Ownership-DEFINITIVE and pet-only, which is why it also PROMOTES: a name we saw charmed but
 * declined to bind (no own cast behind the broadcast) is bound HERE, and bound as CHARMED rather
 * than summoned — AGENTS.md's rule that a claim from a name ever seen charmed re-arms the
 * charmed set, never the permanent one.
 *
 * Otherwise it binds a SUMMONED pet (idempotent; a charmed mob sends the tell too — the real log
 * shows both — and world.claim() leaves an already-charmed instance's petKind alone, so a
 * charmed pet is never reclassified as summoned). It adds the name to the ATTRIBUTION set only.
 */
function bindPetClaim(st: EngineState, name: string, ts: number, via: ClaimVia): void {
  const key = idKey(name)
  const promote = !st.world.petInstance(name) && st.charm.claimIsCharmed(key, ts)
  const inst = promote ? st.world.charm(name, ts) : st.world.claim(name, ts)
  st.notePet(key)
  // The claim is also the corroboration a provisional charm bind was waiting for.
  st.charm.notePetEvidence(key)
  const what = promote ? 'charm claim' : 'pet claim'
  st.log(ts, promote ? 'charm' : 'pet', 'info', `⚡ ${what} ${st.world.label(inst)} [${inst.instanceId}]${CLAIM_NOTE[via]}`)
  // SINGLE-PET SUCCESSION (JOS-54): claiming a NEW summoned pet retires the previous one inside
  // the world model, and the name index has to follow it out or routing would go on admitting
  // the retired pet's swings as yours. Same two-line follow-through death already does — the
  // world model decides, `petNames` and the charm model are told.
  for (const gone of st.syncPetNames()) {
    st.charm.release(gone)
    st.log(ts, 'pet', 'info', `✕ ${gone} retired - one pet at a time; ${name} is yours now`)
  }
}

function ingestPetClaim(st: EngineState, ev: PetClaimEvent): void {
  bindPetClaim(st, ev.name, ev.ts, ev.via)
}

/**
 * THE UPGRADED PET (JOS-188) — `You begin casting Burnout.` … `<Name> goes berserk.`
 *
 * The reported defect: a magician upgraded a level-10 water elemental to a level-14 one and the
 * new pet never appeared in the meter; relogging did not help. Nothing was broken. The JOS-54
 * succession law never RAN, because succession is triggered by the successor's own claim and an
 * upgraded summon produces none: `world.claim()` binds a NAME, the new pet has a different one,
 * and the only two binding lines the app had both require the player to TALK to the pet. The
 * reporter's 30-minute slice holds 2,446 lines, two pets and ZERO tells — replayed through this
 * engine before the fix it ends with `petDisplayNames() === []` and one row, You. The successor
 * landed 89 hits / 3,385 points into nobody's column; the predecessor's 187 / 5,698 sat frozen
 * in a row that had stopped growing, which is exactly what "they stop showing up" describes.
 *
 * THE THIRD BINDING SIGNAL, and the first that costs the player nothing. 40 spells in the DB are
 * `targetType: Pet` (charmModel.ts PET_TARGET_SPELLS) and the game will not let one land on
 * anything but your own pet; `You begin casting <Spell>.` is printed for the player and NOBODY
 * else. So the pair — own cast, then a landing that resolves it — names your pet as surely as
 * the tell does, and it fires at the moment a summoner buffs the pet they just summoned rather
 * than at the moment they first order it.
 *
 * MEASURED, owner's whole log (1,557,569 lines): 19 binds, 14 distinct names, and every one of
 * the 14 is a name a `… Master.'` tell ALSO bound — no name is bound by this rule alone, and no
 * bind contradicts one. In all 14 this arrives FIRST, by 81 s to 2,528 s, and the damage those
 * pets landed in the gaps is 1,865 hits / 27,088 points the meter throws away today (Giber
 * alone: 947 hits / 11,636 points over 42 minutes). On the reporter's slice it binds Jabektik at
 * 11:26:40, ten seconds before its first swing.
 *
 * THE MESSAGE IS NOT THE GATE — the armed own cast is. `goes berserk.` resolves to
 * Burnout / Fury / Rage / Voice of the Berserker and only Burnout is a pet spell, so the
 * candidate list must contain the spell we are mid-cast of. That is `charmBroadcast`'s test with
 * one more field, and for the same reason: a caster-less line is ours only when it resolved one
 * of our own casts.
 *
 * WHAT IT DOES NOT FIX, stated rather than papered over: a player who casts no pet-only buff
 * still has a pet the log cannot bind until they order it (JOS-49's accepted blind spot). Report
 * 01KZN569YA6T751QCJW99P1ZCA is that case — its pet buffs (`Spirit of the Puma`, `Spiritual
 * Brawn`, `Inner Fire`) are not `targetType: Pet`, so this rung produces zero binds there and
 * its three `told you, 'Attacking … Master.'` tells remain the only evidence in it. Same root
 * cause, different half: the answer for them is still to order it once.
 *
 * AND IT IS THE COMBAT MODEL'S BIND ONLY. `modules/buffs.ts` runs its own entity-level pet
 * succession off the `petClaim` LOG EVENT (AGENTS.md law 4: two models, different reach, by
 * measurement rather than oversight), and this rung produces no such event — it is a state
 * transition inside the engine, not a line the parser can emit, because the arm is per-stream
 * state and `parseEvent` is per-line. So the buff module's pet slot still waits for the tell,
 * exactly as it did before this ticket: no worse, not yet better. Making it better means either
 * a derived-event seam the session feeds to both, or a second arm in the buffs module — and a
 * second arm is precisely the duplicated retirement path law 4 is a scar from, so it does not
 * get built on the way past without its own measurement.
 */
function bindPetBuffLanding(st: EngineState, ts: number, target: string, spellNames: readonly string[]): void {
  if (!st.charm.petBuffLanding(spellNames, ts)) return
  // A landing on YOURSELF is a self-buff the DB mislabels, never a pet (the parser emits
  // target 'self' for the msgCastOnYou form, but the third-person form can still name you when
  // another player's buff lands on you in the same second).
  if (target === '' || idKey(target) === st.playerKey) return
  bindPetClaim(st, target, ts, 'petBuff')
}

// THE ENGINE NO LONGER CONSUMES `petSay` (JOS-49). The six pet-voiced public sentences used to
// NOMINATE — pairing one with "…and it is fighting your target" was what let the meter ask about
// an entity after three hits instead of twenty. The owner cut the question outright ("if you just
// have to pet attack once, this is a lot of work we can get wrong"), and a `says` line is
// broadcast: it proves the speaker is SOMEBODY's pet and nothing whatever about whose, so with
// the question gone there is nothing here for it to do.
//
// The event still PARSES and still reaches the alerts module (shared/logEventKinds.ts lists it in
// the trigger vocabulary, so a user can alert on their pet answering), and shared/logScrub.ts
// keeps its carve-out so fixtures go on carrying the lines verbatim.
//
// ONE say line does have a binding job, and it is NOT a `petSay` (JOS-52): `<Name> says, 'My
// leader is <You>.'`, the /pet who leader answer, names its owner out loud, which is exactly what
// these six do not. It parses straight to `petClaim` with `via: 'leader'` and lands in
// ingestPetClaim above — the same path the private tell takes, on purpose.

function ingestDeath(st: EngineState, ev: DeathEvent): void {
  const key = idKey(ev.name)
  const killerKey = ev.bySelf ? 'you' : ev.killer ? idKey(ev.killer) : undefined
  const res = st.world.death(ev.name, ev.ts, killerKey)
  // Keep the fast pet-name set in lockstep: only drop the name from the
  // set when NO pet instance of it remains live.
  if (!st.world.petInstance(ev.name)) {
    st.petNames.delete(key)
    st.charm.release(key)
  }
  // The retired instance stays in `engaged` (so an in-fight heal on the corpse
  // still counts) — closure consults world.isRetired(), not set membership.
  // The dead instance's CC hold is cleared by the world model's own retirement hook
  // (EngineState's `world.onRetire`, JOS-176) — this used to be a delete right here, which
  // meant DEATH was the only retirement that cleaned up after itself and staleness was not.
  const petNote = res.wasPet ? ' (pet)' : ''
  const ambNote = res.ambiguous ? ' ~ambiguous' : ''
  st.log(ev.ts, 'death', 'info', `☠ ${ev.name} died${petNote}${ambNote} - ${res.reason}`)
}

/** epoch / zone / charm / petClaim / uncharm / cc / death. Returns true if consumed. */
function ingestWorld(st: EngineState, ev: LogEvent): boolean {
  switch (ev.kind) {
    case 'epoch': {
      // Character rebirth (Task #49): a same-name character was wiped/recreated. The DPS
      // meter is session-scoped (the user's live encounter history + the zone aggregate,
      // reset on every zone line already), so we deliberately KEEP it — a rebirth is not a
      // reason to lose the current session's fights. But the beta character's charmed/pet
      // world state is stale, so finalize any open fight and clear the pet sets as a cheap
      // safety (a zone line after the rebirth login would clear it anyway; this makes the
      // boundary explicit and independent of that ordering).
      finalizeCurrent(st)
      st.petNames = new Set()
      st.world.reset()
      st.charm.reset()
      // An epoch severs every active-state span: the beta character's stances, coats and buffs
      // are not this character's. CENSORED, never 'observed' (proc-analytics §3.1 boundaries).
      st.stateTimeline.censorAll(ev.ts)
      // …and the same reasoning retires the special-attack lanes: "you will now use Dragon
      // Punch" was said to the PREVIOUS character. The lanes fall back to the parser's generic
      // names until this character's own state line says otherwise (never a carried-over guess).
      st.specials.reset()
      return true
    }
    case 'zone': {
      finalizeCurrent(st)
      // Freeze the just-left zone's aggregate into the capped history (Task #54) BEFORE
      // resetting, so its overall meter stays selectable. A zone session with no attributed
      // damage is dropped (nothing to show), matching the empty-encounter drop rule.
      finalizeZoneSession(st)
      st.zone = ev.zone
      st.zoneAgg = new Agg()
      st.zoneFinalizedMs = 0
      st.zoneActiveMs = 0
      st.zoneStartTs = 0
      st.zoneLastTs = 0
      // Charm cannot survive a zone transition, and hostile mobs don't follow —
      // both are retired. SUMMONED class pets DO persist across zones (real-log
      // verified), so world.zone() returns the survivors (summoned pets only) and we
      // rebuild the fast pet-name set from them — which keeps a summoned pet fully
      // attributable after zoning while dropping stale charmed/hostile names.
      const survivors = st.world.zone(ev.ts)
      st.petNames = new Set(survivors.map((i) => i.nameKey))
      st.charm.zone(survivors.map((i) => i.nameKey))
      st.log(ev.ts, 'zone', 'info', `▸ entered ${ev.zone}`)
      return true
    }
    case 'charm':
      ingestCharm(st, ev)
      return true
    case 'petClaim':
      ingestPetClaim(st, ev)
      return true
    case 'uncharm': {
      // `Your <charm spell> spell has worn off of <mob>` — only the CASTER sees this, so it is
      // also retroactive proof the bind was ours. Corroborate first (a bind that ends this way
      // was real even if the pet never spoke or swung), then release.
      const key = idKey(ev.mob)
      st.charm.notePetEvidence(key)
      st.world.uncharm(ev.mob, ev.ts)
      st.petNames.delete(key)
      st.charm.release(key)
      st.log(ev.ts, 'uncharm', 'info', `✕ charm broke: ${ev.mob}`)
      return true
    }
    case 'cc':
      ingestCc(st, ev)
      return true
    case 'death':
      ingestDeath(st, ev)
      return true
    default:
      return false
  }
}

/** The engine's internal damage record for a canonical `damage` LogEvent (attacker already
 *  proven non-null by the caller). */
function toDamageEvent(ev: DamageEventE, attacker: string): DamageEvent {
  const modifiers = ev.modifiers ?? []
  return {
    ts: ev.ts, attacker, target: ev.target, amount: ev.amount,
    dtype: ev.dtype, dclass: ev.dclass, skill: ev.skill, verb: ev.verb, crit: ev.crit, modifier: ev.modifier,
    // Prefer the parse-time category; derive as a fallback so pre-#51 events (or
    // any path that omits it) still aggregate under the right axis.
    category: ev.category ?? damageCategory(ev.dtype, modifiers),
    modifiers
  }
}

/** The classification-ring line for an absorption/mitigation event. */
function mitigationLine(ev: MitigationEvent): string {
  if (ev.mtype === 'rune') return `⛊ rune +${ev.amount} absorption`
  if (ev.mtype === 'absorbSwing') return `⛊ absorbed ${ev.source ?? '?'}'s blow`
  return `⛊ absorbed ${ev.source ?? '?'}'s damage shield`
}

/**
 * PROC ANALYTICS for one attributed damage line (docs/plans/proc-analytics.md §4).
 *
 * PURELY ADDITIVE, and it must stay that way: everything below is a COUNT or an INDEX over
 * damage the meter already counted. Nothing here calls an `add*` that moves a damage total,
 * so every total stays byte-identical (law 8's tripwire).
 *
 * `activeDeltaMs` is the ENGINE'S OWN per-hit active-time accrual, measured by the caller as
 * the difference route() just made to `Encounter.activeMs` — not a re-derivation. That is what
 * "reuse the active-time definition verbatim" means here: the two can never drift, because
 * there is only one computation.
 *
 * The three judgements, each with its gate:
 *   - OUTGOING-YOURS only. A pet's damage is not your swing and not your proc.
 *   - SWING = a melee or slay HIT (misses are added by the miss path). Slay counts because a
 *     Slay Undead proc rides an ordinary swing — it IS a swing.
 *   - PROC = a `dtype: 'spell'` line with no own cast behind it. `dot` is never eligible (its
 *     ticks are cast-detached by construction), which is the one gate that keeps this
 *     inference honest.
 */
interface DamageAnalytics {
  /** Attributed to YOU (not a pet, not incoming). */
  mine: boolean
  /** 1 when this was one of your logged swing attempts. */
  swing: number
  /** A cast-less spell effect of yours. */
  proc: boolean
}

/**
 * WHERE ONE OF YOUR SPELL EFFECTS CAME FROM (JOS-167), decided BEFORE the line is routed
 * because the answer names the meter LANE it lands in.
 *
 * It CONSUMES the cast claim (see procDetect's header), so it must be asked exactly once per
 * damage line, in log order. `null` = the question does not arise: not a spell effect, not
 * yours, or a line the meter drops anyway.
 *
 * The attribution is re-derived here rather than taken from `route()`'s return (JOS-59's
 * sharing) for the plain reason that the lane name has to exist before `route()` is called. The
 * two eligibility gates run FIRST and in that order, so only a `dtype: 'spell'` line of the
 * player's ever pays for the extra `classify` — a few hundredths of the fold's damage lines.
 */
function damageOrigin(st: EngineState, ev: DamageEvent): SpellOrigin | null {
  if (ev.amount <= 0) return null
  if (!procEligibleDamage(ev.dtype)) return null
  if (idKey(ev.attacker) !== 'you') return null
  if (verdict(st, ev).kind !== 'out-you') return null
  return st.recentCasts.origin(ev.skill, ev.ts)
}

/**
 * The three judgements, separated from the accumulation so each stays readable. `null` means
 * "the meter ignored this line", in which case the ledgers must ignore it too.
 *
 * `at` is the verdict `route()` ALREADY reached for this line (JOS-59). It used to be
 * re-derived here, which cost a second pair of `idKey` calls, a second roster pull and a second
 * result object per damage line for a decision that cannot have changed in between — nothing on
 * the routing path writes `petNames`, `knownPlayers` or the roster.
 *
 * `origin` is likewise ALREADY decided (`damageOrigin`, above) and is never recomputed: asking
 * twice would take two claims off one cast line and count the second landing as a proc.
 */
function damageAnalytics(ev: DamageEvent, at: Attribution, origin: SpellOrigin | null): DamageAnalytics | null {
  if (ev.amount <= 0) return null
  if (at.kind === 'ignore') return null
  // A GROUP MEMBER's hit is not yours, exactly like a pet's: it is not your swing, not your
  // proc, and not your active time. Proc analytics stay strictly first-person (the cast-less
  // proc inference reads `You begin casting`, which only you print), so the member falls into
  // the same `mine: false` branch the pet does and moves no proc counter.
  if (at.kind !== 'out-you') return { mine: false, swing: 0, proc: false }
  const swing = ev.category === 'melee' || ev.category === 'slay' ? 1 : 0
  return { mine: true, swing, proc: origin === 'proc' }
}

/**
 * Fold one judgement into BOTH ledgers this segment has — the zone aggregate and the fresh
 * encounter, if any. Every proc counter is written through here so the two can never disagree
 * about a line, and so the per-state split below is fed from exactly one place.
 *
 * `active` is the state timeline's O(1) open set, read at the event's own instant. It is passed
 * (not re-read) into every accumulator, because the whole point of folding on ingest is that
 * "what was on when this fired" is knowable only now.
 */
function foldBoth(st: EngineState, ts: number, fold: (agg: Agg, active: ReadonlySet<string>) => void): void {
  const active = st.stateTimeline.active
  const enc = st.freshEncounter(ts)
  fold(st.zoneAgg, active)
  if (enc) fold(enc.agg, active)
}

/** Everything the analytics fold needs about one already-routed damage line. An args object
 *  because the four values arrive from three different steps of `ingestDamage` and a positional
 *  fifth parameter would blow `max-params`. */
interface DamageFold {
  /** The line as the LEDGER sees it: `skill` is the SPELL, never the split lane name, so the
   *  proc ledger keeps keying on the spell and its join to the meter rows is unchanged. */
  ev: DamageEvent
  /** The engine's own per-hit active-time accrual, measured by the caller. */
  activeDeltaMs: number
  at: Attribution
  /** `damageOrigin`'s already-consumed verdict; `null` when the question did not arise. */
  origin: SpellOrigin | null
}

function foldDamageAnalytics(st: EngineState, f: DamageFold): void {
  const { ev, activeDeltaMs, at } = f
  const a = damageAnalytics(ev, at, f.origin)
  if (!a) return
  const p = st.probe
  if (p) p.enter(SEC_ANALYTICS)
  const fold: WindowFold = {
    ts: ev.ts,
    activeDeltaMs,
    outDamage: a.mine ? ev.amount : 0,
    procDamage: a.proc ? ev.amount : 0,
    swings: a.swing
  }
  foldBoth(st, ev.ts, (agg, active) => {
    agg.windows.fold(fold, active)
    agg.procs.addActiveMs(activeDeltaMs, active)
    if (a.swing) agg.procs.addSwing(active)
    if (a.proc) agg.procs.addSpellProc({ spell: ev.skill, amount: ev.amount, isHeal: false, active })
  })
  if (p) p.leave()
}

/** A heal with no own cast behind it — the healing half of the same inference (`Lifetap
 *  Strike`, 1,814 procs / 52,861 hit points restored, zero casts, in the real log). Gated to
 *  YOUR OWN heals: another player's cast-less heal is their proc, not yours — and to
 *  `isCastlessHeal`, which additionally refuses HoT ticks and Quick Buff bursts (see the two
 *  sweeps in procDetect's header). */
function foldHealAnalytics(st: EngineState, ev: HealEvent): void {
  const spell = ev.spell
  if (!spell || idKey(ev.healer ?? '') !== 'you') return
  if (!isCastlessHeal(st.recentCasts, { spell, ts: ev.ts, overTime: ev.overTime === true, quickBuffTs: st.quickBuffTs })) return
  const p = st.probe
  if (p) p.enter(SEC_ANALYTICS)
  foldBoth(st, ev.ts, (agg, active) => {
    agg.procs.addSpellProc({ spell, amount: ev.amount, isHeal: true, active })
  })
  if (p) p.leave()
}

/** YOUR avoided swing. It is still a swing ATTEMPT, and the mechanical proc denominator is
 *  attempts — a proc that cannot fire on a miss still had the chance to. */
function foldMissAnalytics(st: EngineState, ev: MissEvent): void {
  if (idKey(ev.attacker) !== 'you') return
  const p = st.probe
  if (p) p.enter(SEC_ANALYTICS)
  foldBoth(st, ev.ts, (agg, active) => {
    agg.windows.fold({ ts: ev.ts, swings: 1 }, active)
    agg.procs.addSwing(active)
  })
  if (p) p.leave()
}

/**
 * NAME THE LANE — the one place a special attack's damage stops being anonymous.
 *
 * EQ Legends' upgraded specials print no verb of their own (a Dragon Punch lands as `You strike
 * …`), so the parser can only ever answer "Melee" for them. This applies the log's OWN statement
 * of which special is live in that verb's lane (specialAttacks.ts holds the state and the
 * evidence). It is a pure RENAME of `skill`: the amount, the type, the category and the
 * attribution are untouched, so every damage total stays byte-identical (law 8's tripwire).
 *
 * Gated on the attacker being YOU. The state line is first-person-only, so nothing is known
 * about anyone else's specials, and a mob's `strikes` must stay generic melee.
 *
 * Returns the SAME object when nothing changes — a fresh copy otherwise, never a mutation: the
 * canonical LogEvent is shared with every other module on the bus and the engine does not own it.
 */
function nameSpecialLane(st: EngineState, ev: DamageEvent): DamageEvent {
  if (idKey(ev.attacker) !== 'you') return ev
  const lane = st.specials.laneSkill(ev.verb)
  return lane === undefined || lane === ev.skill ? ev : { ...ev, skill: lane }
}

/** One canonical `damage` line: route it, then index it. */
function ingestDamage(st: EngineState, ev: DamageEventE): void {
  // Caster-less other-player DoTs (attacker:null) are not our fight.
  if (ev.attacker === null) {
    st.log(ev.ts, 'other', 'dropped', ev.raw)
    return
  }
  // Close any pending encounter at this ts BEFORE routing, so attributed damage
  // after a closure starts a fresh encounter rather than reviving the old one.
  evalClosure(st, ev.ts)
  const dmgEv = nameSpecialLane(st, toDamageEvent(ev, ev.attacker))
  // WHERE IT CAME FROM, BEFORE IT IS FILED (JOS-167). The verdict names the lane, so it has to
  // be reached before route() folds the hit — and it is reached exactly once, here.
  const origin = damageOrigin(st, dmgEv)
  // The lane a cast-less firing lands in. A fresh object, never a mutation: the canonical
  // LogEvent is shared with every other module on the bus (same rule nameSpecialLane states).
  const laned = origin === null ? dmgEv : { ...dmgEv, skill: laneNameFor(dmgEv.skill, origin) }
  // Read the engine's active-time clock either side of route(): the DIFFERENCE is the exact
  // capped-gap delta it accrued for this hit. A fresh encounter (route() opened one)
  // contributes 0, which is precisely what routing.ts does for a first hit.
  const encBefore = st.current
  const activeBefore = encBefore?.activeMs ?? 0
  const at = route(st, laned)
  if (at === null) return
  const delta = st.current === encBefore ? (st.current?.activeMs ?? 0) - activeBefore : 0
  // The LEDGER gets the un-split event: `agg.procs.spellProcs` is keyed by the SPELL, so the
  // ledger row, its PPM and its `proc · N ppm` tag stay one lane however many meter rows the
  // spell now occupies.
  foldDamageAnalytics(st, { ev: dmgEv, activeDeltaMs: delta, at, origin })
}

/** damage / heal / healUnstated / mitigation / miss / resist. Returns true if consumed. */
function ingestCombat(st: EngineState, ev: LogEvent): boolean {
  switch (ev.kind) {
    case 'damage':
      ingestDamage(st, ev)
      return true
    case 'heal':
      routeHeal(st, ev)
      foldHealAnalytics(st, ev)
      st.log(ev.ts, 'heal', 'info', `+ ${ev.healer ?? '?'} → ${ev.target} ${ev.amount}${ev.spell ? ` (${ev.spell})` : ''}`)
      return true
    case 'healUnstated':
      // No analytics fold: a heal with no amount cannot enter the proc model, and the processing
      // log says so out loud rather than printing a 0 that reads like a measurement (JOS-86).
      routeHealUnstated(st, ev)
      st.log(ev.ts, 'heal', 'info', `+ ${ev.target} ${ev.skill} (amount not stated)`)
      return true
    case 'mitigation':
      routeMitigation(st, ev)
      st.log(ev.ts, 'mitigation', 'info', mitigationLine(ev))
      return true
    case 'miss':
      routeMiss(st, ev)
      foldMissAnalytics(st, ev)
      return true
    case 'resist':
      // `<mob> resisted your <Charm>!` is the third way an armed cast fails to land (Task #65).
      // Only OUR OWN outgoing resist counts; an incoming one (we shrugged off a mob's spell)
      // says nothing about what we were casting.
      if (!ev.incoming && idKey(ev.caster) === 'you') {
        // A fully-resisted cast landed NOTHING, so like a fizzle it must not stay in the window
        // to claim the next proc of the same name (JOS-167). `forget` drops only an UNCLAIMED
        // record, which is what keeps a partially-resisted AoE honest: if a target of the same
        // firing already took damage, the cast is spent and the rest of that instant still joins.
        st.recentCasts.forget(ev.spell)
        st.charm.noteCastFailed(ev.spell, ev.ts)
      }
      routeResist(st, ev)
      return true
    default:
      return false
  }
}

/**
 * THE OWN-CAST LIFECYCLE — begin / fizzle / interrupt / resume. Its own family because BOTH of
 * the engine's ownership inferences run off it, and they must see the same lines:
 *   - the cast-less PROC detector (proc-analytics §4.1): a spell effect with no cast behind it
 *     is a proc, and only the PLAYER prints `You begin casting <Spell>.` — a mob's or another
 *     player's cast is never in this map.
 *   - the CHARM/CC ownership model (Task #65): that same exclusivity is the only honest owner
 *     signal behind the caster-less `<mob> has been charmed./mesmerized.` broadcasts. A
 *     charm/CC cast ARMS the model for that spell's own cast time; any other cast clears a
 *     stale arm; a fizzle or interrupt of the armed spell disarms it, because a cast that
 *     never resolved cannot be what a broadcast resolved.
 * Returns true if consumed.
 */
function ingestCast(st: EngineState, ev: LogEvent): boolean {
  switch (ev.kind) {
    case 'castBegin':
      st.recentCasts.note(ev.spell, ev.ts)
      st.charm.noteCastBegin(ev.spell, ev.ts)
      return true
    case 'castFizzle':
    case 'castInterrupted':
      // A cast that resolved to nothing explains no landing (JOS-167), so its record goes —
      // otherwise it sits in the window waiting to claim the next PROC of the same name as if
      // it were the cast. An interrupt can still RECOVER, which is what `castResumed` is for.
      st.recentCasts.forget(ev.spell)
      st.charm.noteCastFailed(ev.spell, ev.ts)
      return true
    case 'castResumed':
      // `You regain your concentration and continue your casting.` — the interrupted cast is
      // back on and will land, so give it back its claim. Deliberately does NOT re-arm the
      // charm/CC model: that model's own evidence rules are a separate question and were not
      // measured here (charmModel.ts holds them).
      st.recentCasts.resume()
      return true
    default:
      return false
  }
}

/**
 * `You will now use Dragon Punch instead of Eagle Strike while attacking.` — the ONE line that
 * names the special behind an otherwise anonymous `You strike …`. It opens nothing, closes
 * nothing, and moves no total; it changes what a later swing is CALLED (specialAttacks.ts).
 */
function ingestSpecialAttack(st: EngineState, ev: SpecialAttackEvent): void {
  const lane = st.specials.note(ev)
  // A special outside the verified lane table (Smite, Backstab, Frenzy — which print their own
  // verb and need no attribution; Slam — whose evidence refuses the claim, see specialAttacks.ts)
  // is still SEEN and still logged. Saying so is the honest report: the line was read and
  // deliberately not acted on.
  const note = lane === undefined ? ' (no verb lane - label unchanged)' : ` (${lane} lane)`
  const from = ev.replaces === undefined ? '' : ` instead of ${ev.replaces}`
  st.log(ev.ts, 'special', 'info', `▸ special attack: ${ev.skill}${from}${note}`)
}

/**
 * THE CHARACTER'S STANDING CHOICES — stance, invocation, and the active special attack.
 *
 * Its own family (rather than three more cases in ingestModifier) because the three answer the
 * same question and none of them is an event in a fight: they are what the character has DECIDED
 * to do, persisting across pulls and zones until the game prints a different decision. The
 * annotations in ingestModifier below, by contrast, all describe something that just HAPPENED.
 * Returns true if consumed.
 */
function ingestChoice(st: EngineState, ev: LogEvent): boolean {
  switch (ev.kind) {
    case 'stanceChange':
      applyStance(st, 'stance', ev.stance, ev.ts)
      st.log(ev.ts, 'stance', 'info', `▸ stance: ${ev.stance}`)
      return true
    case 'invocationChange':
      applyStance(st, 'invocation', ev.invocation, ev.ts)
      st.log(ev.ts, 'invocation', 'info', `▸ invocation: ${ev.invocation}`)
      return true
    case 'specialAttack':
      ingestSpecialAttack(st, ev)
      return true
    default:
      return false
  }
}

/** coats / procs / dispel landings / Quick Buff / your own death. */
function ingestModifier(st: EngineState, ev: LogEvent): void {
  switch (ev.kind) {
    case 'poisonCoat':
      routeCoat(st, ev)
      return
    case 'poisonDry':
      routeDry(st, ev)
      return
    case 'poisonProc':
      routeProc(st, ev)
      return
    case 'buffApply': {
      // DISPEL LANDINGS on the mobs we are fighting (Task #64) — the "counts of spells (like
      // the dispel variants and such)" ledger. Message-driven and gated to DISPEL_FAMILY; it
      // names NO caster, and the view labels it accordingly.
      const names = ev.candidates.map((c) => c.name)
      // …and the SAME stream is where an unordered pet finally names itself (JOS-188). Runs
      // FIRST so the two curated gates below see a world model that already knows whose the
      // buffed entity is. A third disjoint gate over one event, and the only one that binds.
      if (ev.target !== 'self') bindPetBuffLanding(st, ev.ts, ev.target, names)
      routeDispelLanding(st, ev.ts, ev.target, names)
      // The SAME landing stream also carries the tracked proc-buff spans (§3.2). Two disjoint
      // curated gates over one event: DISPEL_FAMILY names a lane on a mob, PROC_BUFF_CATALOG
      // opens a self-buff span. Neither can consume the other's lines.
      routeProcBuffApply(st, ev.ts, ev.target, names)
      return
    }
    case 'buffWearOff':
      // The rare PRINTED end of a tracked proc buff — the only path that can close a buff span
      // 'observed'. In the real log this fires once against 97 landings, which is exactly why
      // EdgeEvidence exists.
      routeProcBuffWearOff(st, ev.ts, ev.candidates)
      return
    case 'aaActivate':
      // THE QUICK BUFF BURST (procDetect's second gate). This AA re-applies every memorized
      // buff and prints their LANDINGS ONLY — no `You begin casting` for any of them — so
      // without this line 254 buff landings in the real log read as cast-less procs. Recording
      // the activation is the whole fix: the burst is cast evidence in a different shape.
      if (idKey(ev.name) === QUICK_BUFF_AA) st.quickBuffTs = ev.ts
      return
    case 'playerDeath':
      // A boundary that SEVERS every span. The end is unknowable, so it is 'censored' — never
      // 'observed', and never a fabricated expiry (law 1).
      st.stateTimeline.censorAll(ev.ts)
      // BLADE COATS DIE WITH YOU (corrected 2026-08-04). eqlwiki's Rogue page states poisons
      // "remain active until class swap or death", and the log corroborates it without ever
      // printing a dry line for it: `Your Paralytic Poison spell did not take hold. (Blocked by
      // Neurotoxic Poison.)` at 20:01:47 Aug 03, then — after `You have been slain by a rock
      // golem!` at 21:01:40 — the SAME Paralytic coat lands cleanly at 21:15:23. Something
      // removed Neurotoxic in between and no line said so. Until this, the slot state and the
      // span timeline disagreed at exactly this instant: censorAll ended the coat spans while
      // `coatUtility` kept naming a poison the corpse no longer had, which made the header show
      // a dead coat and `slowExpected` true for pulls that could not slow.
      // NOT modeled, and stated rather than guessed: the wiki's other clearer, a CLASS SWAP.
      // The combat engine sees no loadout signal, so a swap leaves the coats standing.
      st.coatUtility = undefined
      st.coatCombat = []
      return
    default:
      return
  }
}

/**
 * Fold one canonical LogEvent into the state machine. The engine consumes
 * damage/charm/uncharm/death/zone directly (the old internal parse call path is
 * gone). heal/miss are parse-only for now — logged to the classification ring
 * for visibility, but not aggregated. Any other kind is ignored.
 *
 * `live` drives the classification ring (recording): historical replay events
 * mutate state silently; live events are also ring-logged.
 */
export function ingestEvent(st: EngineState, ev: LogEvent, live: boolean): void {
  const p = st.probe
  if (!p) {
    ingestOne(st, ev, live)
    return
  }
  // The whole body is a separate function so this bracket can be unconditional: `enter`/`leave`
  // must balance on every path, and the chain below returns from five different places.
  p.enter(SEC_DISPATCH)
  ingestOne(st, ev, live)
  p.leave()
}

function ingestOne(st: EngineState, ev: LogEvent, live: boolean): void {
  if (live) {
    st.recording = true
    st.hydrating = false
  }
  // Charm binds age out on the LOG clock (charmModel PROVISIONAL_MS), so the demotion is
  // driven from the event stream and from snapshot(now) — whichever observes the deadline
  // first. Guarded on an empty-map read, so the ordinary line costs nothing.
  st.sweepCharm(ev.ts)
  if (ingestWorld(st, ev)) return
  if (ingestCombat(st, ev)) return
  if (ingestCast(st, ev)) return
  if (ingestChoice(st, ev)) return
  ingestModifier(st, ev)
}
