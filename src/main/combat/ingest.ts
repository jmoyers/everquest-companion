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
import {
  evalClosure,
  ensureEncounter,
  finalizeCurrent,
  finalizeZoneSession,
  resetZoneAccumulators
} from './lifecycle'
import { route, routeHeal, routeHealUnstated, routeMiss, routeMitigation, routeResist, verdict } from './routing'
import { SEC_ANALYTICS, SEC_DISPATCH } from './foldProbe'
import {
  applyStance,
  clearCoats,
  routeCoat,
  routeDispelLanding,
  routeDry,
  routeProc,
  routeProcBuffApply,
  routeProcBuffWearOff,
  routeSelfLandingProc
} from './procRouting'
// LEAVING ROGUE BARES THE BLADES (JOS-305) — its own module, because the whole feature is the
// GATE on when the class model may be consulted, and that reasoning does not belong in a switch.
import { sweepCoatClass } from './coatClass'
import {
  QUICK_BUFF_AA,
  castlessKind,
  isCastlessHeal,
  laneNameFor,
  procEligibleDamage,
  type SpellOrigin
} from './procDetect'
// SOMEBODY ELSE'S CHARM PET (JOS-250) — its own module, for the reason its header states: it is
// one feature whose four ingest handlers and two routing paths would otherwise push both this file
// and routing.ts past the measured 400-line ceiling.
import { ingestAllyPetLeader, ingestForeignCharm, ingestOtherCastBegin } from './allyRouting'
// …and its sibling: the three lines that bind one of YOUR pets, extracted VERBATIM by the same
// split (petClaims.ts). Two ownership features, two modules, one dispatch switch.
import { bindPetBuffLanding, ingestPetClaim } from './petClaims'
// …and the coaching nudge that exists BECAUSE those three routes are all there are (JOS-258).
import { isPetSummonSpell } from './petNudge'
import { CC_HOLD_MS } from './encounter'
import { type Agg, type DamageEvent } from './aggregate'
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
  // WHOEVER'S CHARM IT IS, THE THING IS A MOB (JOS-430). Stated before the ownership branch because
  // it is true of both arms: a name a charm broadcast has ever spoken is not a combatant the
  // record-everything ladder may keep its own row for. `st.notePet` below would say it for YOUR
  // charm; a stranger's would otherwise leave the row standing beside the ally-pet one.
  st.retractOther(key, 'a charm broadcast named it')
  if (st.charm.charmBroadcast(key, ev.mob, ev.ts) === 'foreign') {
    ingestForeignCharm(st, ev, key)
    return
  }
  // YOUR charm wins outright over any ally bind of the same mob. It can happen — you charm what
  // somebody else's charm just broke off — and two models both calling one entity a pet is exactly
  // the duplicated-ownership shape law 4 is a scar from.
  st.ally.release(key)
  const inst = st.world.charm(ev.mob, ev.ts)
  st.notePet(key)
  st.log(ev.ts, 'charm', 'info', `⚡ charmed ${st.world.label(inst)} [${inst.instanceId}]`)
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
  // A DEAD PET IS NOT A PET (JOS-250). Unconditional and by NAME, unlike the world model's
  // careful pet-vs-twin disambiguation below: an ally bind is name-keyed to begin with, so if the
  // log says something of that name died, the honest reading is that the bind is over. Erring
  // toward ending it is the safe direction here — the failure it prevents is crediting a stranger
  // with a corpse's damage, and the failure it risks is losing a few seconds of a survivor's.
  const goneAlly = st.ally.release(key)
  if (goneAlly) st.log(ev.ts, 'charm', 'dropped', `✕ ${goneAlly.display} died - ${goneAlly.charmer}'s pet is gone`)
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
      // …and the ally binds with them: they describe people standing beside a character that is
      // not this one. The friendly set goes too, because `reset()` is a whole-model wipe.
      st.ally.reset()
      // …and the BLADE COATS go with them (JOS-305). This case used to censor the coat SPANS on
      // the line below and leave `coatUtility` / `coatCombat` standing — the identical
      // slot-versus-span disagreement the death rule was written to cure, rebuilt one boundary
      // over. A rebirth is a different character; nothing was on these blades. Same shared door,
      // so the two can never drift apart again.
      clearCoats(st, ev.ts, 'epoch')
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
      // The accumulator half of the boundary is shared with the SESSION MARK now (JOS-322) — see
      // `resetZoneAccumulators`. Everything BELOW this line is the part a mark deliberately omits.
      resetZoneAccumulators(st)
      // Charm cannot survive a zone transition, and hostile mobs don't follow —
      // both are retired. SUMMONED class pets DO persist across zones (real-log
      // verified), so world.zone() returns the survivors (summoned pets only) and we
      // rebuild the fast pet-name set from them — which keeps a summoned pet fully
      // attributable after zoning while dropping stale charmed/hostile names.
      const survivors = st.world.zone(ev.ts)
      st.petNames = new Set(survivors.map((i) => i.nameKey))
      st.charm.zone(survivors.map((i) => i.nameKey))
      // Somebody else's charm cannot survive a zone either, and neither can a cast in flight.
      // The friendly SET survives (allyCharms.zone) — it is about people, not about the room.
      st.ally.zone()
      st.log(ev.ts, 'zone', 'info', `▸ entered ${ev.zone}`)
      return true
    }
    case 'charm':
      ingestCharm(st, ev)
      return true
    case 'petClaim':
      ingestPetClaim(st, ev)
      return true
    case 'allyPetLeader':
      // The speaker just named somebody its leader, which settles what it is whether or not the
      // ally model goes on to bind it (JOS-430).
      st.retractOther(idKey(ev.pet), `named ${ev.owner} its leader`)
      ingestAllyPetLeader(st, ev)
      return true
    case 'petSay':
      // THE ENGINE CONSUMES `petSay` AGAIN, for one job and a different one (JOS-430). JOS-49 cut
      // the question these six sentences used to answer — "is this one YOURS?" — and the note below
      // still holds: a `says` line is broadcast and proves nothing about whose pet the speaker is.
      // What it DOES prove is that the speaker is SOMEBODY's pet, which is exactly the fact the
      // record-everything ladder cannot get any other way: EQ spells a summoned pet's name with the
      // same grammar it gives people, so without this the strangers' pets in a raid keep rows of
      // their own. Measured on the owner's whole log: it settles 8 names no other rung reaches.
      st.retractOther(idKey(ev.name), `said a pet sentence (${ev.say})`)
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
 *     ticks are cast-detached by construction), and neither is a RAIN spell (its later waves
 *     are cast-detached the same way — JOS-414). Those two gates are what keep this inference
 *     honest.
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
  if (!procEligibleDamage(ev.dtype, ev.skill)) return null
  if (idKey(ev.attacker) !== 'you') return null
  if (verdict(st, ev).kind !== 'out-you') return null
  // The cast ledger answers cast-or-not; the held-clicky set is what turns a `proc` verdict into
  // a `click` one (JOS-438). Empty set ⇒ identity, so this line changes nothing without a dump.
  return castlessKind(st.recentCasts.origin(ev.skill, ev.ts), ev.skill, st.heldClickies)
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
  // A CLICK IS A CAST-LESS FIRING TOO (JOS-438), so it still folds a lane — `procDamage` and the
  // Tier-B windows keep counting the damage an item effect delivered, which is what they are for.
  // What changes is the LANE it lands in, and `foldDamageAnalytics` carries the marker there.
  return { mine: true, swing, proc: origin === 'proc' || origin === 'click' }
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
    if (a.proc) {
      agg.procs.addSpellProc({
        spell: ev.skill, side: 'damage', amount: ev.amount, active,
        ...(f.origin === 'click' ? { click: true as const } : {})
      })
    }
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
  // The gate above has already reached `proc`; the held set is what promotes it (JOS-438). A
  // clicky heal (Stein of Moggok's Light Healing) is the same shape as the damage side.
  const click = castlessKind('proc', spell, st.heldClickies) === 'click'
  const p = st.probe
  if (p) p.enter(SEC_ANALYTICS)
  foldBoth(st, ev.ts, (agg, active) => {
    agg.procs.addSpellProc({ spell, side: 'heal', amount: ev.amount, active, ...(click ? { click: true as const } : {}) })
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
      // …AND THE THIRD READER OF THE SAME EXCLUSIVITY (JOS-258). A pet SUMMON is knowable from
      // this line and only from this line — the summon itself prints nothing the log can attribute
      // — so a summon with no bind behind it is the one moment the meter can honestly say it is
      // about to miss a pet. LIVE ONLY: a summon from four hours ago is not news, and the whole
      // point of `hydrating` is that a replayed moment must not be dressed up as the present.
      if (!st.hydrating && isPetSummonSpell(ev.spell)) st.petNudge.noteSummonCast(ev.ts)
      return true
    case 'castFizzle':
    case 'castInterrupted':
      // A cast that resolved to nothing explains no landing (JOS-167), so its record goes —
      // otherwise it sits in the window waiting to claim the next PROC of the same name as if
      // it were the cast. An interrupt can still RECOVER, which is what `castResumed` is for.
      st.recentCasts.forget(ev.spell)
      st.charm.noteCastFailed(ev.spell, ev.ts)
      // The same argument, for the nudge: a summon that never resolved summoned nothing, and a
      // nudge about a pet that does not exist is exactly the staleness the ruling forbids.
      if (isPetSummonSpell(ev.spell)) st.petNudge.noteCastFailed()
      return true
    case 'otherCastBegin':
      // THE LINE COMBAT NEVER INGESTED (JOS-250 — allyRouting.ts). The only sentence in this log
      // that says who ELSE is casting what, and therefore the only thing that can name the owner
      // of a caster-less `<mob> has been charmed.` broadcast.
      ingestOtherCastBegin(st, ev)
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
      // The SAME landing stream also carries the tracked proc-buff spans (§3.2), and — JOS-246 —
      // the procs whose ONLY printed evidence IS a landing. Three disjoint curated gates over one
      // event: DISPEL_FAMILY names a lane on a mob, PROC_BUFF_CATALOG opens a self-buff span, and
      // SELF_LANDING_PROCS counts a firing. None can consume another's lines.
      routeProcBuffApply(st, ev.ts, ev.target, names)
      routeSelfLandingProc(st, ev.ts, ev.target, names)
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
      // BLADE COATS DIE WITH YOU (corrected 2026-08-04). eqlwiki's Rogue page states poisons
      // "remain active until class swap or death", and the log corroborates it without ever
      // printing a dry line for it: `Your Paralytic Poison spell did not take hold. (Blocked by
      // Neurotoxic Poison.)` at 20:01:47 Aug 03, then — after `You have been slain by a rock
      // golem!` at 21:01:40 — the SAME Paralytic coat lands cleanly at 21:15:23. Something
      // removed Neurotoxic in between and no line said so.
      //
      // FIRST, and through the shared door (JOS-305). The coat clear runs BEFORE `censorAll`
      // below so the coat spans close through `clearCoats`, which — unlike a bare censor — also
      // STAMPS the window transition the way `routeDry` does. That stamp is what discards the
      // boundary minute from the Tier-B purity gate, and a minute in which the player died and
      // four coats ended is the last minute that should be believed clean. `censorAll` then
      // finds the coat groups already closed and severs everything else.
      //
      // The wiki's OTHER clearer, a class swap, is no longer a stated gap: coatClass.ts models it.
      clearCoats(st, ev.ts, 'death')
      // A boundary that SEVERS every span. The end is unknowable, so it is 'censored' — never
      // 'observed', and never a fabricated expiry (law 1).
      st.stateTimeline.censorAll(ev.ts)
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
  // The ally binds age out on the same log clock (JOS-250) — a charm cannot outlive its own
  // spell, so the hold is a certainty rather than a heuristic and needs no evidence to fire.
  st.sweepAlly(ev.ts)
  // …and the pet nudge times out on it too (JOS-258), from here and from snapshot(now), for the
  // reason the other two do: whichever observes the deadline first should be the one that acts.
  st.petNudge.sweep(ev.ts)
  // …and the BLADE COATS are consulted against the class model on the same log clock (JOS-305):
  // a character who stopped being a rogue no longer has poison on their blades, and no line says
  // so. Deliberately NOT in snapshot(now) beside the three above — those are display timers, this
  // one MUTATES the fold, and a fold that advanced because the UI polled would make a replay
  // disagree with the live tail. Guarded on two field reads for every non-rogue in the world; the
  // gate that keeps it cheap for a rogue too is coatClass.ts's whole subject.
  sweepCoatClass(st, ev)
  if (ingestWorld(st, ev)) return
  if (ingestCombat(st, ev)) return
  if (ingestCast(st, ev)) return
  if (ingestChoice(st, ev)) return
  ingestModifier(st, ev)
}
