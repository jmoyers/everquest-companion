// EVERYTHING THE ENGINE DOES WITH A COMBATANT THE LOG NAMED AND NO STRONGER MODEL CLAIMED
// (JOS-430 — the owner's 2026-08-20 ruling: "Everyone" means ANY fight the log can see).
//
// The refusal ladder is `otherCombatants.ts` (pure state, no routing); this is its seam into the
// fold — the gate, the row it books, and the one evidence hook. Same shape and the same file split
// as `allyRouting.ts` one door over, and for the same two reasons: it is one feature, and
// `routing.ts` is at its measured line ceiling.
//
// `classify()` IS NOT TOUCHED, exactly as JOS-250 states for the ally model and for the same
// reason: it is pure, it is called three times per line by the damage / miss / resist probes, and
// its four membership sets are the ones that decide YOUR rows. Every line this file can claim
// already arrives as `'ignore'`, which is the hook, so nothing about your own attribution can move.
// The three `route*` functions therefore RETURN A BOOLEAN — "I took it" — and the caller offers a
// line it declines to the ally-pet model beneath, one door at a time and in a stated order.
//
// THE DISCIPLINE, WHICH IS THE WHOLE REASON THIS IS NOT JUST A WIDER `classify()`:
// an `'other'` row is AGGREGATE-ONLY. It never opens an encounter, never extends one, never engages
// a hostile, never refreshes presence, never resolves a target into a world instance and never
// bumps the target ledger a fight is NAMED after. Every one of those omissions is Task #65's
// cautionary tale (one friendly in `engaged` merged three of the owner's pulls into a single
// 214-second segment) refusing to come back through a wider door — and it is the same contract
// `routeAllyPetDamage` already keeps, so the two features cannot drift.
//
// A ROSTER MEMBER IS DELIBERATELY NOT ROUTED HERE. `out-member` still goes through the ordinary
// outgoing path, where the member's TARGET engages, because "the mob your group-mate is fighting is
// the mob you are fighting" is a licence the ROSTER grants and a stranger has not been granted. The
// roster therefore still decides something real; what it no longer decides is whether the damage is
// recorded at all (shared/roster.ts's header states the before/after).

import { idKey } from '../log/parser'
import { SEC_AGGREGATE } from './foldProbe'
import type { DamageEvent, MissFold, SourceRef } from './aggregate'
import type { EngineState } from './state'
import type { MissEvent } from '../../shared/logEvents'
import type { DamageCategory } from '../../shared/combat'

/**
 * THE METER ROW for a combatant other than you — a group member or, since JOS-430, anyone else the
 * log named.
 *
 * ONE ID NAMESPACE FOR BOTH, and that is the point rather than an economy: the person you fought
 * beside for ten minutes and then invited into your group must be ONE bar, not one bar per
 * provenance. `Agg.reid` upgrades the stored kind from `'other'` to `'member'` when the roster
 * catches up; the id never moves, so no total splits and no drill goes stale.
 *
 * KEYED BY NAME, NOT BY INSTANCE — the pet rule deliberately inverted, for the reason
 * `routing.outSource` has always stated: `world.resolve()` MINTS a world instance, and a
 * player-shaped instance can be engaged, retired, aged out and counted as hostile presence. The
 * canonical name gives one stable row and touches the world model not at all.
 *
 * The NAME prefers the roster's spelling (it is the one a user has seen in the popover) and falls
 * back to the recorded spelling, then to the line's own — world-model law 2 in ladder form.
 */
export function otherSource(st: EngineState, attacker: string, key: string, member: boolean): SourceRef {
  const name = st.roster().nameOf(key) ?? st.others.nameOf(key) ?? attacker
  return { id: `member:${key}`, name, kind: member ? 'member' : 'other' }
}

/**
 * MAY THIS NAME BE RECORDED AS A COMBATANT OF ITS OWN? — the gate `classify()` consults, and the
 * only place the refusal ladder is spelled out in evaluation order.
 *
 * Cheapest and most authoritative first: the sets that are simple membership tests come before the
 * cached name-shape test, so a busy raid log's mob-vs-mob traffic leaves after one or two lookups.
 * `otherCombatants.ts` carries the ARGUMENT for each rung and the measurements behind the two that
 * are not simply borrowed from an existing guard.
 *
 * `targetKey` matters for exactly one thing: A === B. EQ prints self-damage (`Vektik hit Vektik for
 * 6 points of magic damage by Lifespike.` — a lifetap on its own caster, 60+ of them in the JOS-243
 * slice), and a same-name line is the pet model's twin-ambiguity case, not a fight. Booking it
 * would credit somebody for hitting themselves.
 */
export function recordsOther(st: EngineState, attacker: string, target: string): string | null {
  const key = idKey(attacker)
  const targetKey = idKey(target)
  // EQ prints self-damage (`Vektik hit Vektik for 6 points of magic damage by Lifespike.` — a
  // lifetap resolving on its own caster, 60+ of them in the JOS-243 slice). A same-name line is the
  // pet model's twin-ambiguity case, not a fight, and booking it would credit somebody for hitting
  // themselves.
  if (key === targetKey) return null
  if (!recordableAttacker(st, attacker, key)) return null
  // AND THE OTHER HALF, asked of the DEFENDER. A recorded combatant swinging at you, at your pet,
  // at a group-mate, at anyone the heal stream proved a player or at another recorded combatant is
  // not a fight this meter models — exactly the rule `memberAttacker` has always applied to a
  // group-mate's stray damage-shield tick or duel swing. Dropped rather than booked, and dropped
  // rather than filed as incoming: the incoming meter answers "what is hitting me", which in this
  // game means hostiles.
  if (st.allyFriendly(targetKey) || st.others.isRecorded(targetKey)) return null
  return key
}

/** The ATTACKER half of the ladder — split out because the two halves ask about different people
 *  and together they outgrow the measured complexity ceiling. Ordered cheapest-and-most-
 *  authoritative first, so a busy raid log's mob-vs-mob traffic leaves after one or two lookups. */
function recordableAttacker(st: EngineState, attacker: string, key: string): boolean {
  if (key === '' || key === 'you' || key === st.playerKey) return false
  if (st.petNames.has(key) || st.everPet.has(key)) return false
  if (st.others.isPet(key) || st.others.isHostile(key)) return false
  if (st.everStruck.has(key) || st.charm.everCharmed(key)) return false
  // Somebody else's charm pet already HAS a row, under the person who charmed it (JOS-250). Two
  // rows for one entity is the "aggregates lie" failure with two names on it.
  if (st.ally.bindOf(key) !== undefined) return false
  return st.others.shaped(attacker, key)
}

/**
 * WHAT ONE INCOMING LINE PROVES ABOUT THE THING THAT THREW IT — read off the damage the meter has
 * already attributed to `incoming`, i.e. a line whose target is YOU.
 *
 * See `OtherCombatants.hostiles` for why this rung exists, why it is "hit YOU" and not "hit
 * anything of ours", and for both measurements (24 names on the owner's whole log, all of them real
 * single-word-named mobs; the wider version marked 59 real players).
 *
 * It writes to its OWN set and never touches `knownPlayers`, so world-model law 4's warning is
 * respected in the way that matters: nothing here can un-file a player and hand a real person back
 * to the `engaged` set. The worst it can do is hide a row.
 */
export function noteOtherHostile(st: EngineState, attacker: string): void {
  const key = idKey(attacker)
  if (key === '' || key === 'you' || st.isKnownPlayer(key)) return
  if (st.petNames.has(key) || st.everPet.has(key)) return
  if (!st.others.shaped(attacker, key)) return
  st.others.noteHostile(key)
}

/** Fold one recorded combatant's landed hit, or decline the line. Aggregate-only — see the header
 *  for every side effect this deliberately does not have. */
export function routeOtherDamage(st: EngineState, ev: DamageEvent): boolean {
  const key = recordsOther(st, ev.attacker, ev.target)
  if (key === null) return false
  st.others.note(key, ev.attacker)
  const src = otherSource(st, ev.attacker, key, false)
  const enc = st.freshEncounter(ev.ts)
  const p = st.probe
  if (p) p.enter(SEC_AGGREGATE)
  enc?.agg.addOut(src, ev)
  st.zoneAgg.addOut(src, ev)
  if (p) p.leave()
  const tgtName = enc ? st.defenderLabel(enc, ev.target, ev.ts) : ev.target
  if (enc) st.pushTimeline(enc, {
    ts: ev.ts, lane: ev.skill, category: ev.category, amount: ev.amount,
    crit: ev.crit, modifiers: ev.modifiers, kind: 'other', target: tgtName
  })
  st.log(ev.ts, ev.dtype, 'other', `${src.name} → ${tgtName}  ${ev.amount}${ev.crit ? '*' : ''}  ${ev.skill}`)
  return true
}

/** The avoided-swing twin — the recorded combatant's own hit%, on the same aggregate-only terms.
 *  A miss carries no amount, so this can move no total anywhere (world-model law 8). */
export function routeOtherMiss(st: EngineState, ev: MissEvent, fold: MissFold): boolean {
  const key = recordsOther(st, ev.attacker, ev.target)
  if (key === null) return false
  st.others.note(key, ev.attacker)
  const src = otherSource(st, ev.attacker, key, false)
  const enc = st.freshEncounter(ev.ts)
  const p = st.probe
  if (p) p.enter(SEC_AGGREGATE)
  enc?.agg.addOutMiss(src, fold)
  st.zoneAgg.addOutMiss(src, fold)
  if (p) p.leave()
  const tgtName = enc ? st.defenderLabel(enc, ev.target, ev.ts) : ev.target
  if (enc) st.pushTimeline(enc, {
    ts: ev.ts, lane: 'Melee', category: 'melee', amount: 0, crit: false, kind: 'other',
    outcome: 'miss', detail: ev.mtype, target: tgtName
  })
  st.log(ev.ts, 'miss', 'other', `${src.name} ✕ ${tgtName} (${ev.mtype})`)
  return true
}

/** …and the resisted-cast twin. Resists carry no amount either, so the same law-8 argument holds;
 *  what it buys is a resist RATE on the row, which is half of what a spell-caster's bar means. */
export function routeOtherResist(
  st: EngineState,
  cast: { ts: number; caster: string; target: string; spell: string; category: DamageCategory }
): boolean {
  const key = recordsOther(st, cast.caster, cast.target)
  if (key === null) return false
  st.others.note(key, cast.caster)
  const src = otherSource(st, cast.caster, key, false)
  const enc = st.freshEncounter(cast.ts)
  const p = st.probe
  if (p) p.enter(SEC_AGGREGATE)
  enc?.agg.addOutResist(src, cast.spell, cast.category)
  st.zoneAgg.addOutResist(src, cast.spell, cast.category)
  if (p) p.leave()
  const tgtName = enc ? st.defenderLabel(enc, cast.target, cast.ts) : cast.target
  if (enc) st.pushTimeline(enc, {
    ts: cast.ts, lane: cast.spell, category: cast.category, amount: 0, crit: false, kind: 'other',
    outcome: 'resist', detail: 'resisted', target: tgtName
  })
  st.log(cast.ts, 'resist', 'other', `${src.name}'s ${cast.spell} resisted by ${tgtName}`)
  return true
}
