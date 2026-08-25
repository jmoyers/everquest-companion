// WHAT BINDS ONE OF *YOUR* PETS — the three lines that say an entity is yours, and the single
// state transition all three go through.
//
//   the private `… Master.` TELL             unforgeable, but only ever sent by an ORDERED pet (JOS-47)
//   the public /pet who leader ANSWER        the on-demand way out of that blind spot (JOS-52)
//   your own pet-only BUFF landing           the one that costs the player nothing (JOS-188)
//
// EXTRACTED FROM ingest.ts VERBATIM (JOS-250), because that file grew a second ownership feature
// and the measured 400-line ceiling is a split rather than a ratchet (eslint.config.mjs). Nothing
// here changed in the move except its address; its sibling is allyRouting.ts, which answers the
// same question about somebody ELSE's pet and shares not one line of code with it — on purpose,
// because they are opposite claims about ownership and law 4 is a scar from a shared path.

import { idKey } from '../log/parser'
import type { EngineState } from './state'
import type { PetClaimEvent } from '../../shared/logEvents'

/** How a pet came to be bound. Only the debug line reads it — every route below is the same
 *  state transition, on purpose (a second retirement path is what law 4 is a scar from).
 *
 *  IT IS THE EVENT'S OWN UNION NOW (JOS-454): `petBuff` used to be a local extension because this
 *  route produced no event, and it produces one now. */
type ClaimVia = PetClaimEvent['via']

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
  // Anything that names itself YOURS stops being anybody else's (JOS-250). All three claim routes
  // are ownership-definitive and first-person; an ally bind rests on a broadcast, which is weaker
  // by construction, so this direction of the override needs no tie-break.
  st.ally.release(key)
  const promote = !st.world.petInstance(name) && st.charm.claimIsCharmed(key, ts)
  const inst = promote ? st.world.charm(name, ts) : st.world.claim(name, ts)
  st.notePet(key)
  // The claim is also the corroboration a provisional charm bind was waiting for.
  st.charm.notePetEvidence(key)
  // …and it is the ANSWER to the JOS-258 nudge, whichever of the three routes produced it. A bound
  // pet needs no coaching, so the nudge dismisses EARLY here — and one that arrives inside the
  // grace window means it was never drawn at all. All three routes go through this function, which
  // is the whole reason there is one place to say this.
  st.petNudge.noteBound()
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

/**
 * A parsed claim, bound. …EXCEPT THE ONE THIS ENGINE ITSELF EMITTED (JOS-454).
 *
 * `via:'petBuff'` never comes off a line: it is `bindPetBuffLanding` below, handed to the bus so
 * the four models outside this directory learn the pet, and the bus delivers it straight back
 * here. Re-binding would be harmless — every route is idempotent and repeated tells are routine —
 * but it would print a second debug line for a transition that happened once, and it is the guard
 * that makes the seam PROVABLY loop-free rather than incidentally so. The buffs module keeps
 * exactly this discipline around `buffExpired` (bus.ts's own note: "no feedback loop is possible:
 * buffs, the only producer, ignores `buffExpired`"), and the refusal lives HERE, beside the
 * emitter, so the two can never be moved apart.
 */
export function ingestPetClaim(st: EngineState, ev: PetClaimEvent): void {
  if (ev.via === 'petBuff') return
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
 * AND THE RUNG HAS A SILENT PRECONDITION: THE DB MUST BE ABLE TO NAME THE SPELL (JOS-349).
 *
 * The candidate test above is the whole gate, and a landing's candidates come from the spell DB's
 * cast-on-other SUFFIX table — which is keyed on what follows the wiki's `Someone ` subject and
 * nothing else. So a `targetType: Pet` spell whose scraped third-person message carries some OTHER
 * subject token is in no table, can never be a candidate for its OWN landing, and this rung cannot
 * fire for it however correct the arm is. Nothing here is wrong when that happens; the two halves
 * simply never meet, and from the outside it looks exactly like JOS-188 before the fix.
 *
 * MEASURED (report 01M00ACVVFDRVWBXRDCFPHESNZ, a shaman whose re-summoned pet `Zarober` stopped
 * being attributed): his slice holds the pair four seconds apart — `You begin casting Tiny
 * Companion.` then `Zarober shrinks.` — and no tell and no leader say anywhere in 6,544 lines.
 * `Tiny Companion` is one of THREE spells that write ` shrinks.` and the only pet-only one, and the
 * scrape gave it `Target shrinks.`, so it was absent from the candidate list its own landing
 * produces. Replayed before the fix: `petDisplayNames() === []` and 142 pet lines attributed to
 * nobody. The fix is a data row, not a rule change — `spellCorrectionsSubjects.ts`, THE PET-BINDING
 * HALF — because the rule was right and the evidence it reads was missing a word.
 *
 * SIX MORE PET-ONLY SPELLS ARE STILL IN THAT STATE (40 are `targetType: Pet`, 33 key a suffix).
 * They are named in that file and they wait for a log that prints the pair; a pattern is not a
 * measurement. If a report says a pet stopped being attributed, CHECK THE CANDIDATE LIST FIRST —
 * there is no time limit on a summoned pet and no rule here that drops one, so an absent bind is
 * almost always a bind that never happened.
 *
 * WHAT IT DOES NOT FIX, stated rather than papered over: a player who casts no pet-only buff
 * still has a pet the log cannot bind until they order it (JOS-49's accepted blind spot). Report
 * 01KZN569YA6T751QCJW99P1ZCA is that case — its pet buffs (`Spirit of the Puma`, `Spiritual
 * Brawn`, `Inner Fire`) are not `targetType: Pet`, so this rung produces zero binds there and
 * its three `told you, 'Attacking … Master.'` tells remain the only evidence in it. Same root
 * cause, different half: the answer for them is still to order it once.
 *
 * IT USED TO BE THE COMBAT MODEL'S BIND ONLY, AND SINCE JOS-454 IT IS NOT. The paragraph that
 * stood here said the rung produced no event — the arm is per-stream state and `parseEvent` is
 * per-line — so `modules/buffs.ts`'s pet slot, and the PROGRESSION module's kill credit, and the
 * roster, and the resist fold all went on waiting for the tell. It named the two ways out and
 * ruled on them: "either a derived-event seam the session feeds to both, or a second arm in the
 * buffs module — and a second arm is precisely the duplicated retirement path law 4 is a scar
 * from". This is the seam, and the measurement that finally bought it:
 *
 * THE OWNER'S 2026-08-23 PLANE OF HATE SESSION (JOS-454). `You begin casting Cackling Bones.` at
 * 13:42:27 summons the necromancer pet `Vibartik`; `Augment Death` (targetType Pet) lands on him
 * at 13:42:43 and this rung binds him IN THE ENGINE on the spot. His first `… Master.'` tell does
 * not arrive until 14:37:53 — fifty-five minutes later — and the ProgressionModule, which knows
 * only the tell and the charm broadcast, spent those fifty-five minutes filing his four kills
 * (13:49:08, 13:52:46, 13:59:48, 14:03:34) as `witnessTs`, somebody else's. The Leveling tab's
 * range panel read `4 kills by others seen` over a window in which the meter beside it had the
 * pet bound the whole time. Replayed through both models side by side, that is exactly the gap:
 * ENGINE PETS -> Vibartik at 13:42:43, progression silent until the tell.
 *
 * SO THE BIND EMITS. The event is `petClaim{via:'petBuff'}` on `bus.emitDerived` (Task #47's
 * queue — delivered after the primary landing has finished reaching every listener, never
 * inline), and every model that already understands a `petClaim` learns the pet with no new
 * field, no new kind and no second arm anywhere. The ARM AND THE GATE ARE UNTOUCHED: the
 * ownership evidence is still `charm.petBuffLanding` — your own cast, in its own window, with the
 * landing's candidates containing the spell you were casting — so nothing about WHICH names bind
 * has moved, only who gets told. That matters for the ticket's other half: the fix credits the
 * owner's own summoned pet, and cannot credit a nearby NPC's kills, because a nearby NPC never
 * resolves a cast the player made.
 *
 * IT EMITS ONLY WHEN IT ACTUALLY BINDS, and it emits AFTER the bind, so the engine's own state is
 * already correct when the derived event is queued. No emitter (every test, every script) ⇒ the
 * bind is exactly what it was before this ticket. It takes the whole LANDING rather than three of
 * its fields, so the derived event can be stamped with its primary's `seq` — a derived event that
 * invented its own sequence number would sort against the stream it came out of.
 *
 * LIVENESS IS `st.hydrating`, NOT A THREADED FLAG. The buffs module carries a `curLive` because it
 * derives from a TIMER as well as from the stream; this rung derives only from the line in hand,
 * and the engine already maintains the same fact — `ingestOne` clears `hydrating` on the first
 * live event and `setLive()` clears it at the handoff. So a replayed bind stays `live:false` and
 * never reaches the alert layer as news, with no second copy of the flag to drift.
 */
export function bindPetBuffLanding(
  st: EngineState,
  ev: { seq: number; ts: number; target: string },
  spellNames: readonly string[]
): void {
  const { ts, target } = ev
  if (!st.charm.petBuffLanding(spellNames, ts)) return
  // A landing on YOURSELF is a self-buff the DB mislabels, never a pet (the parser emits
  // target 'self' for the msgCastOnYou form, but the third-person form can still name you when
  // another player's buff lands on you in the same second).
  if (target === '' || idKey(target) === st.playerKey) return
  bindPetClaim(st, target, ts, 'petBuff')
  st.emitDerived?.(
    {
      kind: 'petClaim',
      seq: ev.seq,
      ts,
      // A synthesized human-readable line, in the shape the recent-fires panel and the event feed
      // render — the same thing `emitBuffExpired` writes, and for the same reason: no log line
      // says this, so the app has to say it in its own words rather than quote one it never saw.
      raw: `${target} answered your pet-only spell.`,
      name: target,
      via: 'petBuff'
    },
    !st.hydrating
  )
}
