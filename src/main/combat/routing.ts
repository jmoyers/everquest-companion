// ATTRIBUTION + ROUTING — where a parsed combat line lands. Extracted verbatim from
// engine.ts.
//
// `classify()` is the pure attribution decision (you / your pet / incoming / not our
// fight); the route* functions fold the line into the current encounter and the zone
// aggregate under that decision, refresh the presence axis, and push the timeline instant.
// Nothing here decides when a fight OPENS or CLOSES — that is lifecycle.ts.

import { idKey } from '../log/parser'
import { meleeSkill } from '../log/parseCombat'
import { SEC_AGGREGATE, SEC_CLASSIFY } from './foldProbe'
import { ensureEncounter } from './lifecycle'
import { baseLaneName } from './procDetect'
// SOMEBODY ELSE'S CHARM PET (JOS-250). Its own module because it is its own feature: the three
// calls below are the only places it touches this file, and every one of them sits on a line the
// meter was already dropping. See allyRouting.ts for what it may and may not do.
import { noteAllyPetEvidence, routeAllyPetDamage, routeAllyPetMiss } from './allyRouting'
// EVERY OTHER COMBATANT THE LOG NAMES (JOS-430). Same relationship as allyRouting above: the three
// route* calls below sit on lines this file was already dropping, plus the ONE gate `classify()`
// asks and the ONE evidence hook the incoming path feeds. Nothing your rows read is touched.
import {
  noteOtherHostile,
  otherSource,
  routeOtherDamage,
  routeOtherMiss,
  routeOtherResist
} from './otherRouting'
import { ACTIVE_MS, type Encounter } from './encounter'
import type { DamageEvent, MissFold, SourceRef } from './aggregate'
import type { HealAccum, HealInput } from './healing'
import type { EngineState } from './state'
import type {
  HealEvent,
  HealUnstatedEvent,
  MissEvent,
  MissType,
  MitigationEvent,
  ResistEvent
} from '../../shared/logEvents'
import type { DamageCategory, HealSourceKind, SourceKind } from '../../shared/combat'

/** How a damage event `A → B` is attributed given the pet-name set. */
export type Attribution =
  | { kind: 'out-you' }
  | { kind: 'out-pet'; petKey: string; petName: string; ambiguous: boolean }
  | { kind: 'out-member'; memberKey: string; memberName: string }
  | { kind: 'incoming' }
  | { kind: 'ignore' }

/**
 * THE ATTRIBUTION DECISION. Everything the combat model books passes through here, which is why
 * the reported "my group-mate is missing from the meter" bug was a one-line decision rather than a
 * parse failure: a slice replay proved every damage-shaped line parses (0 unmatched shapes) and
 * the group member still appeared in ZERO fights, because the last rule here used to be
 * "attacker not you/pet, target not you → ignore" and 2,224 parsed events fell through it
 * (docs/plans/group-model.md §3.5).
 *
 * IT IS NO LONGER THE ADMISSION GATE, AND THAT IS THE JOS-430 CHANGE (owner ruling 2026-08-20:
 * "Everyone" means ANY fight the log can see). Recording used to end here: a name the roster had
 * not admitted fell through the last rule, so an empty roster snapshot recorded nobody and no scope
 * could show what nothing had recorded. The `'ignore'` verdict is now an OFFER rather than a
 * disposal — `route()` hands the line to the record-everything ladder (otherRouting.ts) and then to
 * the ally-pet model before dropping it, exactly as JOS-250 did before it.
 *
 * THIS FUNCTION IS DELIBERATELY UNTOUCHED BY EITHER FEATURE. It is pure, it is called three times
 * per line (the damage, miss and resist probes), and its four membership sets are the ones that
 * decide YOUR rows; a fold that also asked "…and if not, whose is it?" would be paying for the
 * answer three times and mixing two questions in one place. So the roster's remaining jobs are the
 * ENGAGEMENT LICENCE below and the Group scope, neither of which can move a number — which is what
 * finally makes the group-model doc's promise ("a wrong roster can hide a row but never corrupt a
 * number") true rather than aspirational.
 *
 * `petNames` is a Set of canonical (lowercased) keys for ALL of your live pets, charmed AND
 * summoned: both attribute identically (as "your pet"), so this function never needs to know
 * which kind it is.
 *
 * Rules (decided with the user):
 *   You → pet-name : ALWAYS outgoing to a hostile twin (never dropped as FF).
 *   pet-name → You : ALWAYS incoming.
 *   pet-name → same-name (A==B, pet) : pet outgoing, but AMBIGUOUS
 *     (could be your pet hitting a hostile twin, or a hostile twin hitting your
 *      pet) — attribute to the pet and flag it.
 *   pet-name → other : pet outgoing (existing rule).
 *   You → other : outgoing.  other → You : incoming.  else ignore.
 *   pet-name → a KNOWN PLAYER : IGNORE (Task #65) — see below.
 *   member → other : OUTGOING, as that member's own row (the group model).
 *
 * `knownPlayers` (optional; empty by default so every existing caller is unchanged) is the
 * set of name keys proven to be players. A pet swinging at a PLAYER is not our fight: either
 * the "pet" was never ours, or this is a duel. Booking it would credit us the damage AND — via
 * routeOutgoingDamage — enter that player into `engaged` as a hostile, which is exactly how a
 * stranger became the owner's enemy and kept three of his pulls from ever closing.
 *
 * `members` (likewise empty by default) is the roster's ADMISSION set — every name that has
 * been in your group since the last epoch or self-leave. It widens the gate and NOTHING ELSE:
 * a member is still not a hostile (engageHostile refuses them), still not a presence signal,
 * and still not a target we track. Two things it deliberately does not do:
 *
 *   MEMBER → You is IGNORED, not incoming. The incoming meter answers "what is hitting me",
 *   which in this game means hostiles; a group-mate's stray damage-shield tick or duel swing is
 *   not that, and filing it as incoming would put an ally in the enemy list.
 *
 *   ANY mob → member is IGNORED, unchanged. Incoming-on-members ("what is hitting my group") is
 *   a real feature and is explicitly out of scope here — sources first, one wave at a time.
 */
export function classify(
  ev: DamageEvent,
  petNames: ReadonlySet<string>,
  knownPlayers: ReadonlySet<string> = new Set(),
  members: ReadonlySet<string> = new Set()
): Attribution {
  const aKey = idKey(ev.attacker)
  const bKey = idKey(ev.target)
  if (aKey === 'you') {
    // You → anything (including a pet name = a hostile twin) is outgoing.
    return bKey === 'you' ? { kind: 'ignore' } : { kind: 'out-you' }
  }
  const sides = { aKey, bKey, bYou: bKey === 'you', petNames, knownPlayers, members }
  if (petNames.has(aKey)) return petAttacker(ev, sides)
  // A GROUP MEMBER is the attacker. Checked before the incoming rule so a member's hit ON you
  // is dropped rather than filed as an enemy's; checked after the pet rules so a charmed mob
  // that shares a member's name (it cannot, but the ordering states the precedence) still
  // attributes as your pet.
  if (members.has(aKey)) return memberAttacker(ev, sides)
  if (sides.bYou) return { kind: 'incoming' }
  // Attacker not one of ours, target not you. THIS IS THE LINE THE METER USED TO DROP ON THE FLOOR,
  // and `'ignore'` is no longer where it ends: `route()` offers it to the record-everything ladder
  // (JOS-430) and then to the ally-pet model (JOS-250) before anything is actually discarded.
  return { kind: 'ignore' }
}

/**
 * `classify` AS THE ENGINE ASKS IT — the pure decision above, fed the live membership sets off the
 * state object, and charged to the bench's `classify` section when a probe is attached
 * (foldProbe.ts). Every caller inside the engine goes through here, so the attribution row in the
 * sub-table is the whole of the engine's attribution cost and not a sample of it.
 */
export function verdict(st: EngineState, ev: DamageEvent): Attribution {
  const p = st.probe
  if (!p) return classify(ev, st.petNames, st.knownPlayers, st.roster().admitted)
  p.enter(SEC_CLASSIFY)
  const at = classify(ev, st.petNames, st.knownPlayers, st.roster().admitted)
  p.leave()
  return at
}

/** The two name keys plus the three membership sets — the shared argument of the two branches
 *  above, so neither has to re-derive what the other already knows. */
interface Sides {
  aKey: string
  bKey: string
  bYou: boolean
  petNames: ReadonlySet<string>
  knownPlayers: ReadonlySet<string>
  members: ReadonlySet<string>
}

/** YOUR PET is the attacker. */
function petAttacker(ev: DamageEvent, s: Sides): Attribution {
  if (s.bYou) return { kind: 'incoming' } // pet-name → You is always incoming
  if (s.knownPlayers.has(s.bKey)) return { kind: 'ignore' } // …but never AT a player
  if (s.members.has(s.bKey)) return { kind: 'ignore' } // …nor at a group-mate
  const ambiguous = s.aKey === s.bKey // same-name twin: can't tell pet from twin
  return { kind: 'out-pet', petKey: s.aKey, petName: ev.attacker, ambiguous }
}

/** A GROUP MEMBER is the attacker. Every friendly target is dropped rather than booked: a
 *  member's damage on you, on your pet or on another member is not a fight we model. */
function memberAttacker(ev: DamageEvent, s: Sides): Attribution {
  if (s.bYou || s.petNames.has(s.bKey)) return { kind: 'ignore' }
  if (s.knownPlayers.has(s.bKey) || s.members.has(s.bKey)) return { kind: 'ignore' }
  return { kind: 'out-member', memberKey: s.aKey, memberName: ev.attacker }
}

/** The three outgoing row kinds, as the damage / miss / resist paths name them. */
type OutKind = 'you' | 'pet' | 'member'

/** Which outgoing row an attribution writes to. */
function outKind(at: Attribution): OutKind {
  return at.kind === 'out-you' ? 'you' : at.kind === 'out-member' ? 'member' : 'pet'
}

/**
 * The outgoing meter ROW for an attributed you/pet/member action — the (aggregate id, display
 * name, kind) triple the damage, miss and resist paths all need and all resolved
 * identically. A pet is resolved to its pet INSTANCE so twin pets stay distinct.
 *
 * A GROUP MEMBER IS KEYED BY NAME, NOT BY INSTANCE — the argument, and the `member:<key>` id it
 * produces, now live in `otherRouting.otherSource`, because a group member and a combatant the
 * roster has not learned yet share exactly one row and must therefore share exactly one row
 * builder.
 */
function outSource(st: EngineState, attacker: string, kind: OutKind, ts: number): SourceRef {
  if (kind === 'you') return { id: 'you', name: 'You', kind: 'you' satisfies SourceKind }
  if (kind === 'member') return otherSource(st, attacker, idKey(attacker), true)
  const petInst = st.world.petInstance(attacker) ?? st.world.resolve(attacker, ts, true)
  return { id: `pet:${petInst.instanceId}`, name: st.world.label(petInst), kind: 'pet' }
}

/**
 * Engage an instance as a HOSTILE of this encounter — the one door into `enc.engaged`, and
 * therefore the one thing that can veto closure (see lifecycle.hostilePresence).
 *
 * A KNOWN PLAYER never walks through it (Task #65). `engaged` membership is what
 * `hostilePresence` polls for "is anything still alive in this fight", so a player — who does
 * not die on our schedule and whose every heal used to refresh his own presence — could hold a
 * pull open indefinitely. Measured: one such entry merged three of the owner's pulls into a
 * single 214-second segment.
 *
 * A GROUP MEMBER IS REFUSED FOR EXACTLY THAT REASON (docs/plans/group-model.md §3.5), and the
 * rule is load-bearing in a way the known-player one was not: admitting members means the
 * engine now routes damage whose TARGET can be another friendly, and `You → <member>` reaches
 * this function on the ordinary outgoing path. A member's target engages; the member never
 * does. The 214-second merged pull is the cautionary tale, and this is the door it came through.
 */
function engageHostile(st: EngineState, enc: Encounter, inst: { instanceId: string; nameKey: string }, ts: number): void {
  if (st.isKnownPlayer(inst.nameKey) || st.isMember(inst.nameKey)) return
  enc.engaged.add(inst.instanceId)
  enc.engagedSeen.set(inst.instanceId, ts)
}

/** A hostile (or the pet) hit YOU. Resolve the attacker to an instance so twins are
 *  distinct in the incoming list, and lane the instant under the attacker's skill. */
function routeIncomingDamage(st: EngineState, enc: Encounter, ev: DamageEvent): void {
  const attInst = st.world.resolve(ev.attacker, ev.ts)
  const id = attInst.instanceId
  const name = st.world.label(attInst)
  const p = st.probe
  if (p) p.enter(SEC_AGGREGATE)
  enc.agg.addInc(id, name, ev)
  st.zoneAgg.addInc(id, name, ev)
  if (p) p.leave()
  engageHostile(st, enc, attInst, ev.ts)
  // Timeline: an incoming instant lanes under the attacker's skill (its own row).
  st.pushTimeline(enc, {
    ts: ev.ts, lane: ev.skill, category: ev.category, amount: ev.amount,
    crit: ev.crit, modifiers: ev.modifiers, kind: 'enemy'
  })
  st.log(ev.ts, ev.dtype, 'enemy', `${name} → You  ${ev.amount}${ev.crit ? '*' : ''}  ${ev.skill}`)
}

/** You, your pet or a group member landed a hit. */
function routeOutgoingDamage(st: EngineState, enc: Encounter, ev: DamageEvent, at: Attribution): void {
  const src = outSource(st, ev.attacker, outKind(at), ev.ts)
  if (at.kind === 'out-pet') {
    // The pet is trading blows with its target — record that engagement for the
    // death-disambiguation rule (case 2b).
    st.world.notePetEngagement(ev.attacker, idKey(ev.target))
    // A pet LANDING a hit is pet-shaped evidence (see the routeMiss/routeResist twins).
    st.charm.notePetEvidence(at.petKey)
  }
  // NOTE what a MEMBER's hit deliberately does not do: it records no pet engagement (a member
  // is not a pet and their kills are not ours to disambiguate) and no charm evidence. The one
  // thing it does beyond its own row is engage its TARGET — which is the whole point, because
  // the mob your group-mate is fighting is the mob you are fighting.
  const ambiguous = at.kind === 'out-pet' && at.ambiguous
  // POISON-TYPED DAMAGE (Task #64): the game states the damage TYPE on every typed spell
  // line ("… for 53 points of POISON damage by Asp Venom Strike."), so a poison lane is a
  // fact the log printed, not a name-matched guess. Outgoing only — a mob's poison DoT on
  // you is not a proc of ours. Additive: this is a second index over damage already counted,
  // so no total moves.
  const p = st.probe
  if (ev.dclass === 'poison') {
    if (p) p.enter(SEC_AGGREGATE)
    // `baseLaneName`: the LEDGER is about the venom, not the meter row. A cast-less firing's
    // meter lane carries JOS-167's origin marker and this counter must not inherit it — every
    // other proc counter (`spellProcs`, `strikes`) is keyed on the spell for the same reason.
    const venom = baseLaneName(ev.skill)
    enc.agg.procs.addPoisonDamage(venom, ev.amount)
    st.zoneAgg.procs.addPoisonDamage(venom, ev.amount)
    if (p) p.leave()
  }
  // Resolve the target to an instance. For a same-name ambiguous pet hit the
  // target is the HOSTILE twin (preferCharmed=false picks the hostile instance).
  const tgtInst = st.world.resolve(ev.target, ev.ts)
  const tgtId = tgtInst.instanceId
  const tgtName = st.world.label(tgtInst)
  if (p) p.enter(SEC_AGGREGATE)
  enc.agg.addOut(src, ev, ambiguous)
  enc.agg.bumpTarget(tgtId, tgtName, ev.amount)
  st.zoneAgg.addOut(src, ev, ambiguous)
  st.zoneAgg.bumpTarget(tgtId, tgtName, ev.amount)
  if (p) p.leave()
  engageHostile(st, enc, tgtInst, ev.ts)
  // LIVE-name tracking (Task #54): the current fight is named after whatever you're
  // presently swinging at (most recent outgoing target). Finalize switches to the
  // largest target (encounterName()); until then this drives the live label.
  enc.lastOutTarget = tgtName
  // Timeline: an outgoing instant lanes under the skill/spell name. `target` carries the
  // INSTANCE-RESOLVED defender label (same value bumpTarget aggregates under, so twins stay
  // distinct) — it drives the tooltip AND the dashboard's per-mob breakdown, which needs
  // per-event defenders to answer "what did I land on THIS mob". Miss/resist ticks already
  // carried it; damage ticks did not, which made per-mob damage underivable renderer-side.
  st.pushTimeline(enc, {
    ts: ev.ts, lane: ev.skill, category: ev.category, amount: ev.amount,
    crit: ev.crit, modifiers: ev.modifiers, kind: src.kind, target: tgtName
  })
  const cat = ambiguous ? 'ambiguous' : ev.dtype
  const mark = ambiguous ? '~' : ev.crit ? '*' : ''
  st.log(ev.ts, cat, src.kind, `${src.name} → ${tgtName}  ${ev.amount}${mark}  ${ev.skill}`)
}


/**
 * "YOU HIT IT", FILED ONCE, off the verdict `classify()` just reached (JOS-48).
 *
 * Here rather than inside `classify()` because classify is PURE and must stay so — it is called
 * by the miss and resist probes as well, and a pure decision that also mutated state would count
 * one swing three times. This is the composition step: one call per attributed line, at the
 * single admission point, reading the same verdict the meter acts on.
 *
 * You do not attack the things that are on your side, so an entity YOU have damaged can never be
 * minted a player by a later heal line. `EngineState.everStruck` is that refusal; see notePlayer
 * for the mob lifetap that made it necessary and for the charmed raid ally that kept it narrow.
 *
 * IT USED TO DO MORE. Until JOS-49 this function also fed the "<Name> — your pet?" candidate
 * detector — every branch of the switch was either evidence for a question or a disqualifier
 * against one. The owner cut the question ("if you just have to pet attack once, this is a lot
 * of work we can get wrong"), and the only branch that was ever about something else is this one.
 */
function noteStruckEvidence(st: EngineState, ev: DamageEvent, at: Attribution): void {
  if (at.kind === 'out-you') st.noteStruck(idKey(ev.target))
}

/**
 * Fold one landed damage line, and REPORT THE VERDICT IT REACHED (JOS-59).
 *
 * The verdict used to be computed twice per damage line: once here, and again inside
 * `damageAnalytics` a few statements later in ingest.ts — two `idKey` pairs, two roster pulls and
 * two result objects for one decision that cannot have changed in between (nothing on this path
 * writes `petNames`, `knownPlayers` or the roster). Returning it is what lets the analytics fold
 * reuse it; `null` means the line was ignored, which is exactly the case the analytics fold
 * already returned early on.
 */
export function route(st: EngineState, ev: DamageEvent): Attribution | null {
  if (ev.amount <= 0) return null
  const at = verdict(st, ev)
  noteStruckEvidence(st, ev, at)
  // BEFORE the ignore gate, and before the outgoing/incoming split: a bound ally pet swinging at
  // YOU classifies as 'incoming' rather than 'ignore', and that line is the strongest soft-hostile
  // proof there is (JOS-250). Reading the evidence off every line is what keeps the two cases from
  // needing two rules.
  noteAllyPetEvidence(st, ev.attacker, ev.target, ev.ts)
  // …and the same line, read for the other model: something that LANDED DAMAGE ON YOU is a hostile,
  // whatever its name looks like (JOS-430, otherRouting.noteOtherHostile carries the measurement).
  if (at.kind === 'incoming') noteOtherHostile(st, ev.attacker)
  if (at.kind === 'ignore') {
    // THE LINE THE METER USED TO DROP, offered to the two models that read it (JOS-430 first, then
    // JOS-250): a combatant the log named hitting something that is not on our side, and then a
    // THIRD PARTY's charm pet while its bind is live and unambiguous. Both book aggregate-only —
    // see otherRouting.ts for every side effect they deliberately do not have, and why. Everything
    // neither claims stays dropped exactly as it was.
    if (!routeOtherDamage(st, ev)) routeAllyPetDamage(st, ev)
    return at
  }

  // Twin evidence: You→pet-name or same-name→same-name proves a hostile twin
  // co-exists with the pet; ensure the world model has a second instance so the
  // pet and the hostile twin resolve to distinct identities.
  if (at.kind === 'out-you' && st.petNames.has(idKey(ev.target))) {
    st.world.noteTwinEvidence(ev.target, ev.ts)
  }
  if (at.kind === 'out-pet' && at.ambiguous) {
    st.world.noteTwinEvidence(ev.target, ev.ts)
  }

  const enc = ensureEncounter(st, ev.ts)
  // Active-time accrual: add the gap since the previous attributed hit, capped at
  // ACTIVE_MS (standard meter convention — a long lull between hits counts as at
  // most one "active" tick, not the whole idle stretch). First hit adds 0.
  if (enc.prevDamageTs !== undefined) {
    enc.activeMs += Math.min(Math.max(0, ev.ts - enc.prevDamageTs), ACTIVE_MS)
  }
  enc.prevDamageTs = ev.ts
  enc.lastTs = ev.ts
  st.lastActivityTs = ev.ts
  // Zone-session timing (Task #54): first/last attributed damage in this zone session, for the
  // zone-session summary's disambiguation timing (start clock + relative age + span).
  if (st.zoneStartTs === 0) st.zoneStartTs = ev.ts
  st.zoneLastTs = ev.ts

  if (at.kind === 'incoming') {
    routeIncomingDamage(st, enc, ev)
    return at
  }
  routeOutgoingDamage(st, enc, ev, at)
  return at
}

/**
 * THE AVOIDED SWING as the aggregates fold it. `skill` stays 'Melee' for every miss — that is
 * the shipped accuracy lane and it does not move — while `verb`/`laneSkill`/`modifiers`/`target`
 * are the additive, amount-free inputs to the round grouper and the modifier tallies
 * (docs/plans/attack-round-stats.md). The lane label goes through the SAME two steps a landed
 * swing does: the parser's `meleeSkill(verb)`, then the log's own statement of which special is
 * live in that verb lane — gated on the attacker being You, because the state line is
 * first-person-only (specialAttacks.ts).
 */
function missFold(st: EngineState, ev: MissEvent, isYou: boolean): MissFold {
  const verb = ev.verb
  const laneSkill =
    verb === undefined ? undefined : (isYou ? st.specials.laneSkill(verb) : undefined) ?? meleeSkill(verb)
  return {
    mtype: ev.mtype,
    skill: 'Melee',
    ts: ev.ts,
    target: ev.target,
    ...(verb !== undefined ? { verb } : {}),
    ...(laneSkill !== undefined ? { laneSkill } : {}),
    modifiers: ev.modifiers ?? []
  }
}

/** A miss YOU, your pet or a group member swung. */
function routeOutgoingMiss(
  st: EngineState,
  enc: Encounter | null,
  probe: { ts: number; attacker: string; target: string; mtype: MissType; fold: MissFold },
  kind: OutKind
): void {
  const src = outSource(st, probe.attacker, kind, probe.ts)
  // A pet WHIFFING is every bit as much proof it is fighting for us as a landed hit
  // (charmModel.ts corroboration — see routeOutgoingDamage's twin). A MEMBER's whiff proves
  // nothing about charm — they are a player, bound by a group line, not by evidence.
  if (kind === 'pet') st.charm.notePetEvidence(idKey(probe.attacker))
  const p = st.probe
  if (p) p.enter(SEC_AGGREGATE)
  enc?.agg.addOutMiss(src, probe.fold)
  st.zoneAgg.addOutMiss(src, probe.fold)
  if (p) p.leave()
  // Timeline: a miss tick lanes under "Melee" (hollow/red mark in the renderer). The
  // defender goes through defenderLabel() so it matches the INSTANCE label the damage
  // path writes — a raw name made every whiff at a twin pile onto a phantom bare row.
  const tgtName = enc ? st.defenderLabel(enc, probe.target, probe.ts) : probe.target
  if (enc) st.pushTimeline(enc, {
    ts: probe.ts, lane: 'Melee', category: 'melee', amount: 0, crit: false, kind: src.kind,
    outcome: 'miss', detail: probe.mtype, target: tgtName
  })
  st.log(probe.ts, 'miss', src.kind, `${src.name} ✕ ${tgtName} (${probe.mtype})`)
}

/**
 * Consume a miss (avoided swing) with the same attribution rules as damage.
 * We synthesize a zero-amount DamageEvent to reuse classify(); a melee skill
 * name isn't in the miss line, so avoided swings bucket under a "Melee" skill.
 */
export function routeMiss(st: EngineState, ev: MissEvent): void {
  const { ts, attacker, target, mtype } = ev
  const probe: DamageEvent = {
    ts, attacker, target, amount: 0, dtype: 'melee', skill: 'Melee', crit: false,
    category: 'melee', modifiers: []
  }
  const at = verdict(st, probe)
  // Same two judgements the damage path reads, off the same lines, for the same reason: an ally
  // pet's swing at a friendly proves the break whether or not it connected (JOS-250).
  noteAllyPetEvidence(st, attacker, target, ts)
  if (at.kind === 'ignore') {
    // The same two offers the damage path makes, in the same order. NO hostile-evidence read on
    // the incoming side here: the "it hit YOU" rung was measured on LANDED damage
    // (otherCombatants.ts), and a swing that connected with nothing is not what was measured.
    const fold = missFold(st, ev, false)
    if (!routeOtherMiss(st, ev, fold)) routeAllyPetMiss(st, ev, fold)
    return
  }
  const fold = missFold(st, ev, at.kind === 'out-you')
  // A miss doesn't open or extend an encounter (closure is death/CC/fallback driven),
  // but it attaches to the in-progress fight if one is fresh (so hit% is per-fight).
  // Otherwise it still counts toward the zone aggregate.
  const enc = st.freshEncounter(ts)
  // PRESENCE (Task #55): a swing exchanged with an already-engaged mob proves it's
  // still in the fight even though nothing landed — the mob on an incoming miss, the
  // mob we whiffed at on an outgoing one. Liveness only; no damage timing moves.
  st.notePresence(at.kind === 'incoming' ? attacker : target, ts)

  if (at.kind === 'incoming') {
    const attInst = st.world.resolve(attacker, ts)
    const id = attInst.instanceId
    const name = st.world.label(attInst)
    const p = st.probe
    if (p) p.enter(SEC_AGGREGATE)
    enc?.agg.addIncMiss(id, name, fold)
    st.zoneAgg.addIncMiss(id, name, fold)
    if (p) p.leave()
    // ABSORPTION (Task #59): an incoming swing absorbed by YOUR rune is also a mitigation
    // instant. `incoming` means the defender is YOU (a swing at your pet classifies as
    // 'ignore'), so this can't pick up a pet's or a mob's own rune. It is the SECOND source
    // for the same line family the parser's 'absorbSwing' mitigation event covers: whichever
    // of MISS_RE / SKIN_ABSORB_BLOW_RE claims the line, exactly ONE event is emitted, so the
    // two paths can never double-count — and the count survives the pending MISS_RE fix.
    if (mtype === 'absorb') {
      enc?.agg.heal.addAbsorbedSwing()
      st.zoneAgg.heal.addAbsorbedSwing()
    }
    st.log(ts, 'miss', 'enemy', `${name} ✕ You (${mtype})`)
    return
  }
  routeOutgoingMiss(st, enc, { ts, attacker, target, mtype, fold }, outKind(at))
}

/** YOUR (or your pet's, or a group member's) detrimental spell was resisted. */
function routeOutgoingResist(
  st: EngineState,
  enc: Encounter | null,
  cast: { ts: number; caster: string; target: string; spell: string; category: DamageCategory },
  kind: OutKind
): void {
  const src = outSource(st, cast.caster, kind, cast.ts)
  // Same corroboration as the damage/miss twins: a pet whose spell got resisted was casting
  // for us. A member's resisted cast is not charm evidence (see routeOutgoingMiss).
  if (kind === 'pet') st.charm.notePetEvidence(idKey(cast.caster))
  const p = st.probe
  if (p) p.enter(SEC_AGGREGATE)
  enc?.agg.addOutResist(src, cast.spell, cast.category)
  st.zoneAgg.addOutResist(src, cast.spell, cast.category)
  if (p) p.leave()
  // Same instance resolution as the miss/damage paths (see defenderLabel) — a resisted
  // cast at a twin must land on that twin's per-mob row, not a bare-named ghost.
  const tgtName = enc ? st.defenderLabel(enc, cast.target, cast.ts) : cast.target
  if (enc) st.pushTimeline(enc, {
    ts: cast.ts, lane: cast.spell, category: cast.category, amount: 0, crit: false, kind: src.kind,
    outcome: 'resist', detail: 'resisted', target: tgtName
  })
  st.log(cast.ts, 'resist', src.kind, `${src.name}'s ${cast.spell} resisted by ${tgtName}`)
}

/**
 * Consume a spell RESIST (Task #51 v2) — the caster-side analogue of a miss. Attribution:
 *   caster='you'  → outgoing 'you'.
 *   caster=<name> that resolves to one of our pets → outgoing pet.
 *   incoming (You resisted a mob's spell) → incoming, attributed to the mob (the caster).
 *   any other caster (a hostile mob's spell resisted by another mob) → IGNORED, mirroring
 *     classify()'s rule that non-you/pet attackers are out of scope for the meter.
 * The resisted spell is rank-normalized (spellCanonKey) ONLY for the lane display we keep;
 * we lane by the DISPLAY spell name so the resist tick lands in the same lane as landed
 * casts of that spell. Resists carry no damage → damage totals are untouched (tripwire).
 */
export function routeResist(st: EngineState, ev: ResistEvent): void {
  const { ts, caster, target, spell, incoming } = ev
  // Resisted detrimental spells are direct spells in the taxonomy (no melee/ds). A DoT
  // that's resisted is rare; we categorize all resists as 'spell' (the detrimental axis)
  // so they sort into the spell lanes — they carry no amount, so category totals are
  // unaffected. The lane is the display spell name.
  const category: DamageCategory = 'spell'
  // Attach to the in-progress fight if fresh (per-fight resist rate), else zone only —
  // mirrors routeMiss. A resist does not open/extend/close an encounter.
  const enc = st.freshEncounter(ts)
  // PRESENCE (Task #55): a resist names a live caster and a live resister. Refresh
  // whichever side is a HOSTILE we're already engaged with — the caster on an incoming
  // resist (the mob just cast at us), the target on our own resisted cast (the mob is
  // standing there shrugging it off). notePresence ignores anything not engaged, so the
  // you/pet side is a no-op — as is the third-party (mob-vs-mob) shape below, UNLESS
  // the resisting mob happens to be one of ours, in which case its presence is real
  // evidence even though the resist itself is dropped from the stats. Liveness only;
  // no damage timing moves.
  st.notePresence(incoming ? caster : target, ts)

  if (incoming) {
    // You resisted a mob's spell — attribute to the mob (incoming caster).
    const attInst = st.world.resolve(caster, ts)
    const id = attInst.instanceId
    const name = st.world.label(attInst)
    const p = st.probe
    if (p) p.enter(SEC_AGGREGATE)
    enc?.agg.addIncResist(id, name, spell, category)
    st.zoneAgg.addIncResist(id, name, spell, category)
    if (p) p.leave()
    if (enc) st.pushTimeline(enc, {
      ts, lane: spell, category, amount: 0, crit: false, kind: 'enemy',
      outcome: 'resist', detail: 'resisted', target: 'You'
    })
    st.log(ts, 'resist', 'info', `You resisted ${name}'s ${spell}`)
    return
  }

  const kind = resistCaster(st, idKey(caster))
  if (kind === null) {
    // A resisted cast by a combatant the log named — the same widening the damage path got
    // (JOS-430), asked of the CASTER because a resist has no attacker/defender pair to classify.
    if (routeOtherResist(st, { ts, caster, target, spell, category })) return
    // A hostile mob's spell resisted by another mob — out of scope for the meter.
    st.log(ts, 'resist', 'dropped', `${caster}'s ${spell} resisted by ${target}`)
    return
  }
  routeOutgoingResist(st, enc, { ts, caster, target, spell, category }, kind)
}

/**
 * Whose resisted cast this was, or null when it is nobody's business of ours. Separated out
 * because this path never calls classify() — a resist names a CASTER and a TARGET, not an
 * attacker and a defender — so the same three-way widening has to be stated by hand.
 */
function resistCaster(st: EngineState, casterKey: string): OutKind | null {
  if (casterKey === 'you') return 'you'
  if (st.petNames.has(casterKey)) return 'pet'
  return st.isAdmittedMember(casterKey) ? 'member' : null
}

/** One heal line, already keyed and attributed — the shared argument of both heal folds. */
interface HealRouting {
  ts: number
  target: string
  healerKey: string | null
  healerName: string | null
  heal: HealInput
}

/** Incoming heal to You (or the player by name) / your pet. */
function addFriendlyHeal(st: EngineState, r: HealRouting): void {
  const enc = st.freshEncounter(r.ts)
  const hk = r.healerKey ?? 'unknown'
  const healerName = r.healerName ?? 'Unknown'
  const p = st.probe
  if (p) p.enter(SEC_AGGREGATE)
  if (r.heal.amount > 0) {
    enc?.agg.addIncHeal(hk, healerName, r.heal.amount)
    st.zoneAgg.addIncHeal(hk, healerName, r.heal.amount)
  }
  // Healing ledger: rank by HEALER. Row id 'you' for self-heals keeps the healing meter's
  // primary row keyed the same way the damage meter's is.
  const kind: HealSourceKind =
    hk === 'you' ? 'you' : st.petNames.has(hk) ? 'pet' : 'other'
  const id = hk === 'you' ? 'you' : `heal:${hk}`
  enc?.agg.heal.addFriendly(id, healerName, kind, r.heal)
  st.zoneAgg.heal.addFriendly(id, healerName, kind, r.heal)
  if (p) p.leave()
}

/** Heal on a hostile instance we're currently engaged with → enemy healing. */
function addHostileHeal(st: EngineState, r: HealRouting): void {
  // A KNOWN PLAYER is never a hostile, so their heals are never "enemy healing" (Task #65).
  // engageHostile() already keeps them out of `engaged`, which makes this unreachable for a
  // player the heal stream identified; it is stated anyway because the two rules answer the
  // same question and must not be able to disagree.
  const tKey = idKey(r.target)
  if (st.isKnownPlayer(tKey)) return
  // …and neither is a GROUP MEMBER. Stated here rather than left to engageHostile's refusal
  // (which already makes the `engaged` test below fail) because the very next line RESOLVES the
  // target, and resolving mints a world instance — a friendly must not acquire one just because
  // somebody healed them.
  if (st.isMember(tKey)) return
  const inst = st.world.resolve(r.target, r.ts)
  const enc = st.current
  if (enc?.engaged.has(inst.instanceId)) {
    const p = st.probe
    if (p) p.enter(SEC_AGGREGATE)
    if (r.heal.amount > 0) {
      enc.agg.addEnemyHeal(inst.instanceId, st.world.label(inst), r.heal.amount)
      st.zoneAgg.addEnemyHeal(inst.instanceId, st.world.label(inst), r.heal.amount)
    }
    // Counter-healing ledger, ranked by the HEALER (a mob healing itself is its own row).
    const hk = r.healerKey ?? 'unknown'
    const healerName = r.healerName ?? 'Unknown'
    enc.agg.heal.addHostile(`heal:${hk}`, healerName, r.heal)
    st.zoneAgg.heal.addHostile(`heal:${hk}`, healerName, r.heal)
    if (p) p.leave()
    // PRESENCE (Task #55): a heal on an engaged hostile proves BOTH ends are still in
    // the fight — the mob receiving it, and (when a second mob cast it) the healer. The
    // real case this came from: "Baron Telyx V`Zher healed Soldier of V`Zher for 175" —
    // the Baron had landed nothing for seconds while healing his friend, and the old
    // damage-only liveness rule had already written him off. Liveness only; no damage
    // timing moves (enemy healing is an annotation, never damage).
    st.notePresenceId(enc, inst.instanceId, r.ts)
    if (r.healerName) st.notePresence(r.healerName, r.ts)
  }
}

/**
 * WHAT ONE HEAL LINE PROVES ABOUT WHO IS WHO (Task #65) — read off the same line the meter is
 * about to aggregate, before any of the routing decisions consume it.
 *
 * KNOWN-PLAYER evidence, ONE direction only: a heal LANDING ON THE OWNER names its healer as a
 * friendly player. `<H> healed Primitive for N` cannot come from a mob.
 *
 * THE OTHER DIRECTION WAS TRIED AND MEASURED WRONG. "`You healed <X>` ⇒ X is a player" reads as
 * obvious and is false in this log: the owner keeps his PETS alive by name, so a full replay
 * filed 33 entities as players — `a sprited harpie`, `a fire giant warrior`, `an ice giant
 * priest`, and every summoned pet he had ever healed before its first `… Master.` tell (Garer,
 * Vebarn, Xeneker, …). Because a "player" is never a hostile and never a pet's target, that
 * silently deleted 50k+ points of real pet damage, 14,464 of it from one pet hitting another.
 * EngineState.notePlayer keeps the belt (it refuses anything that is or ever was a pet), but
 * the honest fix is not to make the claim at all.
 *
 * PET evidence, the other way round: the owner healing something he is already treating as a
 * pet corroborates a charm bind that is still provisional (charmModel.ts).
 */
function noteHealEvidence(
  st: EngineState,
  f: { healerKey: string | null; tKey: string; isYouTgt: boolean; isPetTgt: boolean; isPlayerTgt: boolean }
): void {
  if ((f.isYouTgt || f.isPlayerTgt) && f.healerKey !== null) st.notePlayer(f.healerKey)
  if (f.healerKey === 'you' && f.isPetTgt) st.charm.notePetEvidence(f.tKey)
}

/**
 * Consume a heal. Three things matter for combat stats:
 *   - target is an engaged HOSTILE instance → count as "enemy healing" (it undoes
 *     our damage; effective-DPS context per encounter + zone).
 *   - target is You or one of your pets → count as incoming healing (with top
 *     healers).
 *   - EITHER of those also folds into the meter-grade HEALING ledger (Task #59):
 *     per healer, per spell, with crit / min / max / derived overheal.
 * Other heals (party members healing each other, unrelated NPCs) are ignored for
 * aggregation — the log gives no faction for an arbitrary name.
 *
 * ZERO-EFFECTIVE heals (`… for 0 (2) hit points …`, 1,857 in the real log) are the overheal
 * evidence, so the healing ledger takes them; the pre-existing `enemyHeal`/`incHeal` maps keep
 * their original `amount <= 0` gate so their totals AND their healer lists stay byte-identical.
 */
export function routeHeal(st: EngineState, ev: HealEvent): void {
  const { ts, target, amount } = ev
  if (amount < 0) return
  const healerName = ev.healer ?? null
  const heal: HealInput = { amount, rawAmount: ev.rawAmount, spell: ev.spell, crit: ev.crit }
  const tKey = idKey(target)
  const healerKey = healerName !== null ? idKey(healerName) : null
  const isYouTgt = tKey === 'you'
  const isPetTgt = !isYouTgt && st.petNames.has(tKey)

  st.learnPlayerKey(healerKey, tKey, isYouTgt, isPetTgt)
  const isPlayerTgt = st.playerKey !== undefined && tKey === st.playerKey

  noteHealEvidence(st, { healerKey, tKey, isYouTgt, isPetTgt, isPlayerTgt })

  const r: HealRouting = { ts, target, healerKey, healerName, heal }
  if (isYouTgt || isPetTgt || isPlayerTgt) {
    addFriendlyHeal(st, r)
    return
  }
  addHostileHeal(st, r)
}

/**
 * Consume an ANNOUNCED-BUT-UNVALUED heal (JOS-86) — `You mend your wounds and heal some damage.`
 *
 * It reaches the healing ledger as a COUNT on its own lane and nothing else. Everything
 * `routeHeal` does with an amount is skipped rather than done with a zero: no `addIncHeal` (the
 * top-healers list ranks by hit points and this line has none), no proc analytics (a 0-amount
 * "Mend proc" is a fabricated observation), no min/max/overheal.
 *
 * NO WORLD-MODEL EVIDENCE IS READ OFF IT EITHER, unlike every other heal line. `noteHealEvidence`
 * exists because a heal names two parties and one of them can be filed; this sentence names
 * NOBODY — not even you, grammatically — so there is nothing to learn and nothing to get wrong.
 *
 * It never opens, joins or extends an encounter and never moves the damage timeline — the same
 * rule mitigation, miss and resist follow (AGENTS.md world-model law 8). A Mend used while you
 * stand around out of combat belongs to the zone lane and nowhere else.
 */
export function routeHealUnstated(st: EngineState, ev: HealUnstatedEvent): void {
  const enc = st.freshEncounter(ev.ts)
  const p = st.probe
  if (p) p.enter(SEC_AGGREGATE)
  enc?.agg.heal.addUnstated(ev.skill)
  st.zoneAgg.heal.addUnstated(ev.skill)
  if (p) p.leave()
}

/**
 * Consume an ABSORPTION / MITIGATION line (Task #59) — damage prevented, not hit points
 * restored, so it never touches a DAMAGE total. It does reach the HEALING total: buildHealingView
 * folds the rune counters in as a row classified 'absorbed' (the two count-only families carry
 * no amount and so reach no total at all). Folded into the current encounter (when one is open
 * and still fresh) and the zone aggregate, exactly like an incoming heal.
 *
 * These lines NEVER open, join or extend an encounter and never move the damage timeline —
 * the same rule miss/resist follow (AGENTS.md world-model law 8). A rune ticking while you
 * stand around out of combat belongs to the zone lane and nowhere else.
 */
export function routeMitigation(st: EngineState, ev: MitigationEvent): void {
  const enc = st.freshEncounter(ev.ts)
  const p = st.probe
  if (p) p.enter(SEC_AGGREGATE)
  const apply = (a: { heal: HealAccum }): void => {
    if (ev.mtype === 'rune') {
      // Defensive: the amount is required by the regex, but keep the ledger clean if a future
      // shape ever omits it — a rune with no amount is a count we cannot value.
      if (ev.amount != null && ev.amount > 0) a.heal.addRune(ev.amount)
    } else if (ev.mtype === 'absorbSwing') a.heal.addAbsorbedSwing()
    else a.heal.addAbsorbedDamageShield()
  }
  if (enc) apply(enc.agg)
  apply(st.zoneAgg)
  if (p) p.leave()
}
