//! THE INGEST SWITCH — one canonical event in, one state transition out (`combat/ingest.ts`), plus
//! the three lines that bind one of YOUR pets (`petClaims.ts`) and the four the ally model reads
//! (`allyRouting.ts`).
//!
//! Over there the switch is split along the five event FAMILIES it already grouped its cases into,
//! and the split is kept here so a reader can see at a glance which family a kind belongs to and
//! which families are not ported yet:
//!
//!   ingest_world    epoch · zone · charm · petClaim · allyPetLeader · petSay · uncharm · cc · death
//!   ingest_combat   damage · heal · healUnstated · mitigation · miss · resist
//!   ingest_cast     castBegin · castFizzle · castInterrupted · otherCastBegin · castResumed
//!   ingest_choice   stanceChange · invocationChange · specialAttack
//!   ingest_modifier poisonCoat · poisonDry · poisonProc · buffApply · buffWearOff · aaActivate ·
//!                   playerDeath
//!
//! The families are disjoint on `kind`, so the chain is exactly the old switch: each tries its own
//! cases and reports whether it consumed the event.
//!
//! ── THE PROC ANALYTICS ARE FOLDED HERE, AND THEY MUST BE ──────────────────────────────────────
//!
//! Everything the analytics need is a COUNT or an INDEX over damage the meter already counted, and
//! every one of them is folded on INGEST rather than derived later. That is not an optimisation: the
//! encounter event ring is capped, truncated at finalize and absent ENTIRELY for a zone session, so
//! "what was on when this fired" and "how many swings happened while it was on" are knowable ONLY
//! now. Nothing below calls an `add_*` that moves a damage total, so every total stays byte-identical
//! (law 8's tripwire).
//!
//! ── TWO SEAMS THE GOLDEN'S CONSTRUCTION LEAVES UNWIRED, AND WHAT EACH ABSENCE MEANS ───────────
//!
//! `foldArm.mts construct()` calls `setRoster`, `reset()` and `setPlayerName` — and NOT `setCombo`,
//! `setDerivedEmitter` or `setHeldClickies`. Each absence is a DOCUMENTED BEHAVIOUR rather than a gap:
//!
//!   * NO COMBO PROVIDER ⇒ `sweepCoatClass` consults a model that answers nothing, so the class-swap
//!     coat clear never fires. The gate itself is what the TS file is about, and with no provider the
//!     TS takes exactly the same early return this fold does — so the sweep is stated here and does
//!     nothing, which is what it does over there too.
//!   * NO HELD-CLICKY SET ⇒ `castless_kind` is the identity function and not one lane name moves. A
//!     `· click` lane cannot occur in any of the six slices, and the goldens agree.

use crate::combat::aggregate::{DamageEvent, MissType};
use crate::combat::ally::{AllyCastLine, AllyKind, AllyLeaderLine, AllyVerdict};
use crate::combat::charm::CharmVerdict;
use crate::combat::encounter::{ZoneSessionClose, CC_HOLD_MS};
use crate::combat::lifecycle::{ensure_encounter, eval_closure, finalize_current};
use crate::combat::procdetect::{
    castless_kind, is_castless_heal, lane_name_for, proc_eligible_damage, HealProcInput, ProcSide,
    SpellOrigin, SpellProcFold, QUICK_BUFF_AA,
};
use crate::combat::procrouting::{
    apply_stance, clear_coats, route_coat, route_dispel_landing, route_dry, route_proc,
    route_proc_buff_apply, route_proc_buff_wear_off, route_self_landing_proc, CoatClearReason,
    CoatLine, ProcLine,
};
use crate::combat::procwindows::WindowFold;
use crate::combat::routing::{self, Attribution, HealLine, MissLine, MitigationLine, ResistLine};
use crate::combat::spellfacts::is_pet_summon_spell;
use crate::combat::state::EngineState;
use crate::event::{Event, Key, Kind};
use eqlog::names::{id_key, id_key_ref};
use std::borrow::Cow;

/// Fold one canonical event into the state machine.
pub fn ingest_event(st: &mut EngineState, ev: &Event) {
    // Charm binds age out on the LOG clock, so the demotion is driven from the event stream and
    // from the snapshot — whichever observes the deadline first. Guarded on an emptiness read, so
    // the ordinary line costs nothing.
    st.sweep_charm(ev.ts());
    // The ally binds age out on the same log clock: a charm cannot outlive its own spell, so the
    // hold is a certainty rather than a heuristic and needs no evidence to fire.
    st.sweep_ally(ev.ts());
    // …and the pet nudge times out on it too, from here and from the snapshot, for the reason the
    // other two do: whichever observes the deadline first should be the one that acts. UNGATED by
    // `hydrating`, exactly as the TS leaves it — a model that can only be ARMED live is a model a
    // historical fold sweeps for nothing, and stating the sweep here keeps the two callers identical.
    st.pet_nudge.sweep(ev.ts());
    // …and the BLADE COATS are consulted against the class model on the same log clock. Deliberately
    // NOT in the snapshot beside the two above — those are display timers, this one MUTATES the fold,
    // and a fold that advanced because the UI polled would make a replay disagree with the live tail.
    sweep_coat_class(st, ev);
    if ingest_world(st, ev) {
        return;
    }
    if ingest_combat(st, ev) {
        return;
    }
    if ingest_cast(st, ev) {
        return;
    }
    if ingest_choice(st, ev) {
        return;
    }
    ingest_modifier(st, ev);
}

/// LEAVING ROGUE BARES THE BLADES (`combat/coatClass.ts`) — the second of the two boundaries the
/// wiki's Rogue page names ("poisons remain active until class swap or death"), and the one the app
/// could not see until that file existed.
///
/// THE WHOLE FEATURE IS THE GATE ON WHEN THE CLASS MODEL MAY BE CONSULTED, and the gate is what is
/// reproduced here. Its three clauses: there must be SOMETHING TO CLEAR (two field reads, which is all
/// every non-rogue in the world ever pays); a LOADOUT-STATING EVENT (`selfWho` / `level`) asks
/// immediately; otherwise at most once per `CLASS_CHECK_MS` of LOG time.
///
/// THE CONSULTATION ITSELF CANNOT HAPPEN IN THIS FOLD, and that is a property of the golden's
/// construction rather than of the rule: `foldArm.mts` never calls `setCombo`, so `comboProvider()`
/// answers null and the TS returns right there. The gate is ported anyway — including the throttle
/// stamp, which the TS writes BEFORE it asks — so the one thing that IS observable (`coat_class_checked_ts`
/// advancing on exactly the events the TS advances it on) agrees, and a later shift that wires a combo
/// provider inherits a gate rather than having to rediscover it.
fn sweep_coat_class(st: &mut EngineState, ev: &Event) {
    if st.coat_utility.is_none() && st.coat_combat.is_empty() {
        return;
    }
    let states_loadout = matches!(ev.kind_of(), Kind::SelfWho | Kind::Level);
    if !states_loadout && ev.ts() - st.coat_class_checked_ts < CLASS_CHECK_MS {
        return;
    }
    st.coat_class_checked_ts = ev.ts();
    // `st.comboProvider()` — null in this fold, so the TS returns here and so does this.
}

/// THE POLL PERIOD, in LOG milliseconds — never a wall clock, so a replay consults at exactly the
/// instants the live tail did.
///
/// Fifteen minutes because that is the combo interval model's own `WINDOW_FLOOR_MS`: it refuses to
/// bisect a span below it, so it CANNOT date a swap finer than fifteen minutes and a faster poll could
/// only re-ask a question whose answer is not allowed to have moved.
const CLASS_CHECK_MS: i64 = 15 * 60_000;

// ── WORLD ─────────────────────────────────────────────────────────────────────────────────────

fn ingest_world(st: &mut EngineState, ev: &Event) -> bool {
    match ev.kind_of() {
        // CHARACTER REBIRTH — a same-name character was wiped and recreated. The DPS meter is
        // session-scoped (the live encounter history and the zone aggregate, already reset on every
        // zone line), so we deliberately KEEP it: a rebirth is not a reason to lose the current
        // session's fights. What goes is the beta character's WORLD state — the open fight is
        // finalized and the pet/charm/ally sets are cleared as a cheap safety. A zone line after the
        // rebirth login would clear them anyway; doing it here makes the boundary explicit and
        // independent of that ordering.
        //
        // …and the SPECIAL-ATTACK LANES retire with them: "you will now use Dragon Punch" was said to
        // the PREVIOUS character. The lanes fall back to the parser's generic names until this
        // character's own state line says otherwise, never a carried-over guess.
        Kind::Epoch => {
            finalize_current(st);
            st.pet_names.clear();
            st.world.reset();
            st.charm.reset();
            st.ally.reset();
            // …and the BLADE COATS go with them. This case used to censor the coat SPANS below and
            // leave the slots standing — the identical slot-versus-span disagreement the death rule was
            // written to cure, rebuilt one boundary over. A rebirth is a DIFFERENT CHARACTER; nothing
            // was on these blades. Same shared door, so the two can never drift apart again.
            clear_coats(st, ev.ts(), CoatClearReason::Epoch);
            // An epoch severs every active-state span: the beta character's stances, coats and buffs are
            // not this character's. CENSORED, never `observed`, and never a fabricated expiry.
            st.state_timeline.censor_all(ev.ts());
            st.specials.reset();
            true
        }
        Kind::Zone => {
            finalize_current(st);
            // Freeze the just-left stay's aggregate into the capped history BEFORE resetting, so its
            // overall meter stays selectable. A stay with no attributed damage is dropped, matching
            // the empty-encounter drop rule.
            st.finalize_zone_session(ZoneSessionClose::Zone);
            st.zone = ev.str(Key::Zone).map(str::to_string);
            // The accumulator half of the boundary — shared with the session mark. Everything BELOW
            // this line is the part a mark deliberately omits, because it is a statement about the
            // ROOM changing and a mark makes no such statement.
            st.reset_zone_accumulators();
            // Charm cannot survive a zone transition and hostile mobs do not follow, so both are
            // retired. SUMMONED class pets DO persist (real-log verified), so the survivors are
            // exactly what the fast pet-name index is rebuilt from — which keeps a summoned pet
            // fully attributable after zoning while dropping stale charmed and hostile names.
            let survivors = st.world.zone(ev.ts());
            st.drain_retirements();
            let keys: Vec<String> = survivors.into_iter().map(|s| s.name_key).collect();
            st.pet_names = keys.iter().cloned().collect();
            st.charm.zone(&keys);
            // Somebody else's charm cannot survive a zone either, and neither can a cast in flight.
            // The friendly SET survives — it is about people, not about the room.
            st.ally.zone();
            let zone = ev.str(Key::Zone).unwrap_or_default().to_owned();
            st.log(ev.ts(), "zone", "info", format!("▸ entered {zone}"));
            true
        }
        Kind::Charm => {
            ingest_charm(st, ev);
            true
        }
        Kind::PetClaim => {
            // …INCLUDING THE ONE THIS ENGINE ITSELF DERIVES. `via: 'petBuff'` never comes off a line:
            // it is `bind_pet_buff_landing` handed to the bus, and the bus delivers it straight back
            // here. Re-binding would be harmless — every route is idempotent — but the refusal is
            // what makes the seam PROVABLY loop-free rather than incidentally so, and it lives beside
            // the emitter so the two can never be moved apart. This fold installs no emitter (the
            // golden's construction does not), so the kind cannot arrive; the guard is stated because
            // its absence is a property of the construction and not of the rule.
            if ev.str(Key::Via) != Some("petBuff") {
                if let Some(name) = ev.str(Key::Name).map(str::to_string) {
                    let via = ev.str(Key::Via).unwrap_or("tell").to_owned();
                    bind_pet_claim(st, &name, ev.ts(), &via);
                }
            }
            true
        }
        Kind::AllyPetLeader => {
            // The speaker just named somebody its leader, which settles what it IS whether or not
            // the ally model goes on to bind it.
            if let Some(pet) = ev.str(Key::Pet) {
                let why = format!(
                    "named {} its leader",
                    ev.str(Key::Owner).unwrap_or_default()
                );
                st.retract_other(&id_key(pet), &why);
            }
            ingest_ally_pet_leader(st, ev);
            true
        }
        Kind::PetSay => {
            // A `says` line is BROADCAST and proves nothing about whose pet the speaker is — that is
            // JOS-49's ruling and it stands. What it DOES prove is that the speaker is SOMEBODY's
            // pet, which is exactly the fact the record-everything ladder cannot get any other way:
            // EQ spells a summoned pet's name with the same grammar it gives people, so without this
            // the strangers' pets in a raid keep rows of their own. Measured on the owner's whole
            // log: it settles 8 names no other rung reaches.
            if let Some(name) = ev.str(Key::Name) {
                let why = format!(
                    "said a pet sentence ({})",
                    ev.str(Key::Say).unwrap_or_default()
                );
                st.retract_other(&id_key(name), &why);
            }
            true
        }
        Kind::Uncharm => {
            // `Your <charm spell> spell has worn off of <mob>` — only the CASTER sees this, so it is
            // also retroactive proof the bind was ours. Corroborate FIRST (a bind that ends this way
            // was real even if the pet never spoke or swung), then release.
            if let Some(mob) = ev.str(Key::Mob).map(str::to_string) {
                let key = id_key(&mob);
                st.charm.note_pet_evidence(&key);
                st.world.uncharm(&mob, ev.ts());
                st.drain_retirements();
                st.pet_names.remove(&key);
                st.charm.release(&key);
                st.log(ev.ts(), "uncharm", "info", format!("✕ charm broke: {mob}"));
            }
            true
        }
        Kind::Cc => {
            ingest_cc(st, ev);
            true
        }
        Kind::Death => {
            ingest_death(st, ev);
            true
        }
        _ => false,
    }
}

/// `<mob> has been charmed.` — THE OWNERSHIP GATE. The line is a BROADCAST and names no caster, so it
/// binds ONLY when it resolved one of the owner's own charm casts. A foreign charm is remembered as
/// an observation — nothing else — so it stays available to the petClaim PROMOTE path and never
/// enters the attribution set.
fn ingest_charm(st: &mut EngineState, ev: &Event) {
    let Some(mob) = ev.str(Key::Mob).map(str::to_string) else {
        return;
    };
    let key = id_key(&mob);
    // WHOEVER'S CHARM IT IS, THE THING IS A MOB. Stated before the ownership branch because it is
    // true of both arms: a name a charm broadcast has ever spoken is not a combatant the
    // record-everything ladder may keep its own row for.
    st.retract_other(&key, "a charm broadcast named it");
    if st.charm.charm_broadcast(&key, &mob, ev.ts()) == CharmVerdict::Foreign {
        // A charm broadcast that resolved none of YOUR casts, offered to the ally model before it is
        // dropped. THE WORLD MODEL IS DELIBERATELY NOT TOLD: `world.charm()` marks an instance as a
        // pet of YOURS — it exempts the instance from staleness, keeps it out of hostile presence and
        // puts it in the pet set. An ally's pet is none of those things to us; it is a mob that
        // happens to be fighting for somebody else, and it may very well be a mob we are killing.
        // THE VERDICT IS SAID EITHER WAY, and the three sentences are the whole of what the ally
        // model does that a person can otherwise only infer from a row appearing or not appearing.
        let text = match st.ally.broadcast(&key, &mob, ev.ts()) {
            AllyVerdict::Bind(bind) => {
                let note = if bind.ambiguous {
                    " (a same-named twin is active - crediting nothing)"
                } else {
                    ""
                };
                let line = format!(
                    "⚡ {mob} charmed by {} - crediting its damage to them{note}",
                    bind.charmer
                );
                st.log(ev.ts(), "charm", "info", line);
                return;
            }
            AllyVerdict::Refuse(reason) => {
                format!("⚡ {mob} charmed by someone else - {reason}")
            }
            AllyVerdict::None => format!("⚡ {mob} charmed by someone else - not your pet"),
        };
        st.log(ev.ts(), "charm", "dropped", text);
        return;
    }
    // YOUR charm wins outright over any ally bind of the same mob. It can happen — you charm what
    // somebody else's charm just broke off — and two models both calling one entity a pet is exactly
    // the duplicated-ownership shape law 4 is a scar from.
    st.ally.release(&key);
    let inst = st.world.charm(&mob, ev.ts());
    let (label, id) = (inst.label.clone(), inst.instance_id.clone());
    st.drain_retirements();
    st.note_pet(&key);
    st.log(
        ev.ts(),
        "charm",
        "info",
        format!("⚡ charmed {label} [{id}]"),
    );
}

/// The parenthetical a claim's ring line carries — `CLAIM_NOTE`, one per route.
///
/// `via` REACHES THE PROCESSING LOG AND NOTHING ELSE. The three routes are ownership-definitive in
/// exactly the same way and the model treats them identically; what differs is what a person reading
/// the log needs in order to know WHY the engine believes it, which is the whole reason a note
/// exists.
fn claim_note(via: &str) -> &'static str {
    match via {
        "leader" => " (it named you its leader)",
        "petBuff" => " (you cast a pet-only spell on it)",
        // `tell` — the private, unforgeable route, and the one that needs no explaining.
        _ => "",
    }
}

/// A pet identified you as its owner, so the named entity is your pet. THREE lines produce this ONE
/// transition and this function deliberately does not care which — a second retirement path is what
/// law 4 is a scar from.
///
/// Ownership-DEFINITIVE and pet-only, which is why it also PROMOTES: a name we saw charmed but
/// declined to bind (no own cast behind the broadcast) is bound HERE, and bound as CHARMED rather
/// than summoned. Otherwise it binds a SUMMONED pet, idempotently — a charmed mob sends the tell too,
/// and `world.claim()` leaves an already-charmed instance's kind alone, so a charmed pet is never
/// reclassified as summoned.
fn bind_pet_claim(st: &mut EngineState, name: &str, ts: i64, via: &str) {
    let key = id_key(name);
    // Anything that names itself YOURS stops being anybody else's. All three claim routes are
    // ownership-definitive and first-person; an ally bind rests on a broadcast, which is weaker by
    // construction, so this direction of the override needs no tie-break.
    st.ally.release(&key);
    let promote = st.world.pet_instance(name).is_none() && st.charm.claim_is_charmed(&key, ts);
    let inst = if promote {
        st.world.charm(name, ts)
    } else {
        st.world.claim(name, ts)
    };
    let (label, id) = (inst.label.clone(), inst.instance_id.clone());
    st.drain_retirements();
    st.note_pet(&key);
    // The claim is also the corroboration a provisional charm bind was waiting for.
    st.charm.note_pet_evidence(&key);
    // …and it is the ANSWER to the JOS-258 nudge, whichever of the three routes produced it. A bound
    // pet needs no coaching, so the nudge dismisses EARLY here — and one that arrives inside the
    // grace window means it was never drawn at all. All three routes go through this function, which
    // is the whole reason there is one place to say this.
    st.pet_nudge.note_bound();
    let what = if promote { "charm claim" } else { "pet claim" };
    st.log(
        ts,
        if promote { "charm" } else { "pet" },
        "info",
        format!("⚡ {what} {label} [{id}]{}", claim_note(via)),
    );
    // SINGLE-PET SUCCESSION: claiming a NEW summoned pet retires the previous one inside the world
    // model, and the name index has to follow it out or routing would go on admitting the retired
    // pet's swings as yours. The world model decides; the index and the charm model are told.
    for gone in st.sync_pet_names() {
        st.charm.release(&gone);
        st.log(
            ts,
            "pet",
            "info",
            format!("✕ {gone} retired - one pet at a time; {name} is yours now"),
        );
    }
}

/// `<PetName> says, 'My leader is <Player>.'` about SOMEBODY ELSE — the strongest ally bind, and the
/// only one that reaches a stranger's SUMMONED pet.
fn ingest_ally_pet_leader(st: &mut EngineState, ev: &Event) {
    let (Some(pet), Some(owner)) = (ev.str(Key::Pet), ev.str(Key::Owner)) else {
        return;
    };
    let (pet, owner) = (pet.to_string(), owner.to_string());
    let owner_key = id_key(&owner);
    let pet_key = id_key(&pet);
    if !st.ally_caster_allowed(&owner_key) {
        return;
    }
    // Your own pet is yours, whatever a broadcast says about it. `says` is forgeable, and the cost of
    // getting this wrong is deleting a real pet's damage — so the refusal is absolute and stated here
    // rather than left to the ordering.
    if st.pet_names.contains(&pet_key) || st.ever_pet.contains(&pet_key) {
        return;
    }
    let ever_charmed = st.charm.ever_charmed(&pet_key);
    let bind = st.ally.bind_by_leader(&AllyLeaderLine {
        pet_key: &pet_key,
        pet: &pet,
        owner: &owner,
        owner_key: &owner_key,
        ts: ev.ts(),
        ever_charmed,
    });
    // THE CLASSIFICATION IS SAID, because a lifecycle you cannot see is a lifecycle nobody can
    // report a bug about — the two words are the whole difference between "it broke" and "it kept
    // earning" eighteen minutes later.
    let shape = if bind.kind == AllyKind::Summon {
        "summoned pet"
    } else {
        "charmed"
    };
    st.log(
        ev.ts(),
        "charm",
        "info",
        format!(
            "⚡ {pet} named {} its leader ({shape}) - crediting its damage to them",
            bind.charmer
        ),
    );
}

/// Crowd control (mez/root, not charm). Evaluate any pending closure at this ts FIRST (a CC on a
/// fresh pull must not attach to a stale fight), then mark the CC'd instance engaged and CC-held so
/// the encounter stays OPEN across the mez-and-wait gap. A CC'd instance counts as "alive" for
/// closure.
///
/// OWNERSHIP GATE: `<mob> has been mesmerized.` is a BROADCAST with no caster, so an APPLICATION only
/// counts when it resolved one of the owner's own CC casts. A foreign mez is fully INERT — it does
/// not engage the mob, it does not open a hold, and it does not touch `last_activity_ts`; a
/// stranger's crowd control is an observation about the room, not an event in our fight. The REFRESH
/// shape is exempt by construction: it is derived from `Your <spell> spell has worn off of <mob>`,
/// which only the caster sees and which names us as that caster.
fn ingest_cc(st: &mut EngineState, ev: &Event) {
    let refresh = ev.bool(Key::Refresh);
    if !refresh && !st.charm.cc_broadcast(ev.ts()) {
        // A stranger's crowd control is an observation about the room, not an event in our fight —
        // and the refusal is SAID, because a line the engine dropped on purpose is the half a bug
        // report can never see any other way.
        let mob = ev.str(Key::Mob).unwrap_or_default().to_owned();
        st.log(
            ev.ts(),
            "cc",
            "dropped",
            format!("✜ CC on {mob} - not ours (no own cast to resolve)"),
        );
        return;
    }
    let Some(mob) = ev.str(Key::Mob).map(str::to_string) else {
        return;
    };
    eval_closure(st, ev.ts());
    let inst = st.resolve(&mob, ev.ts(), false);
    if inst.instance_id == "you" {
        return;
    }
    let label = inst.label.clone();
    ensure_encounter(st, ev.ts());
    let enc = st.current.as_mut().expect("just ensured");
    enc.engaged.insert(inst.instance_id.clone());
    enc.engaged_seen.insert(inst.instance_id.clone(), ev.ts());
    enc.cc_active_until
        .insert(inst.instance_id, ev.ts() + CC_HOLD_MS);
    st.last_activity_ts = ev.ts();
    let tag = if refresh { "refresh" } else { "applied" };
    let spell = match ev.str(Key::Spell) {
        Some(s) => format!(" ({s})"),
        None => String::new(),
    };
    st.log(ev.ts(), "cc", "info", format!("✜ CC {tag}: {label}{spell}"));
}

fn ingest_death(st: &mut EngineState, ev: &Event) {
    let Some(name) = ev.str(Key::Name).map(str::to_string) else {
        return;
    };
    let key = id_key(&name);
    // A DEAD PET IS NOT A PET. Unconditional and BY NAME, unlike the world model's careful
    // pet-vs-twin disambiguation below: an ally bind is name-keyed to begin with, so if the log says
    // something of that name died, the honest reading is that the bind is over. Erring toward ending
    // it is the safe direction — the failure it prevents is crediting a stranger with a corpse's
    // damage, and the failure it risks is losing a few seconds of a survivor's.
    if let Some(gone) = st.ally.release(&key) {
        st.log(
            ev.ts(),
            "charm",
            "dropped",
            format!("✕ {} died - {}'s pet is gone", gone.display, gone.charmer),
        );
    }
    let killer_key = if ev.bool(Key::BySelf) {
        Some("you".to_string())
    } else {
        ev.str(Key::Killer).map(id_key)
    };
    let res = st.world.death(&name, ev.ts(), killer_key.as_deref());
    let pet_note = if res.was_pet { " (pet)" } else { "" };
    let amb_note = if res.ambiguous { " ~ambiguous" } else { "" };
    st.log(
        ev.ts(),
        "death",
        "info",
        format!("☠ {name} died{pet_note}{amb_note} - {}", res.reason),
    );
    // The retired instance stays in `engaged` — so an in-fight heal on the corpse still counts —
    // because closure consults `is_retired`, not set membership. Its CC hold is cleared by the world
    // model's own retirement announcement, which is what makes DEATH and STALENESS agree; this used
    // to be a delete right here, and staleness was the path that did not clean up after itself.
    st.drain_retirements();
    // Keep the fast pet-name set in lockstep: drop the name only when NO pet instance of it remains.
    if st.world.pet_instance(&name).is_none() {
        st.pet_names.remove(&key);
        st.charm.release(&key);
    }
}

// ── COMBAT ────────────────────────────────────────────────────────────────────────────────────

/// The sentence a mitigation line gets in the ring — `mitigationLine`, verbatim, and the ONE branch
/// on `mtype` that decides which of the three prevention shapes it was.
fn mitigation_line(ev: &Event) -> String {
    let source = ev.str(Key::Source).unwrap_or("?");
    match ev.str(Key::Mtype) {
        Some("rune") => format!("⛊ rune +{} absorption", ev.int(Key::Amount).unwrap_or(0)),
        Some("absorbSwing") => format!("⛊ absorbed {source}'s blow"),
        _ => format!("⛊ absorbed {source}'s damage shield"),
    }
}

fn ingest_combat(st: &mut EngineState, ev: &Event) -> bool {
    match ev.kind_of() {
        Kind::Damage => {
            ingest_damage(st, ev);
            true
        }
        Kind::Heal => {
            let line = HealLine {
                ts: ev.ts(),
                target: ev.str(Key::Target).unwrap_or_default().to_string(),
                healer: ev.str(Key::Healer).map(str::to_string),
                amount: ev.int(Key::Amount).unwrap_or(0),
                raw_amount: ev.int(Key::RawAmount),
                spell: ev.str(Key::Spell).map(str::to_string),
                crit: ev.bool(Key::Crit),
            };
            routing::route_heal(st, &line);
            fold_heal_analytics(st, &line, ev.bool(Key::OverTime));
            let spell = match &line.spell {
                Some(s) => format!(" ({s})"),
                None => String::new(),
            };
            st.log(
                line.ts,
                "heal",
                "info",
                format!(
                    "+ {} → {} {}{spell}",
                    line.healer.as_deref().unwrap_or("?"),
                    line.target,
                    line.amount
                ),
            );
            true
        }
        // A heal with NO AMOUNT cannot enter the proc model — a 0-amount "Mend proc" is a fabricated
        // observation — so it reaches the healing ledger's own count-lane and nothing else. It never
        // opens, joins or extends an encounter and never moves the damage timeline (law 8).
        Kind::HealUnstated => {
            routing::route_heal_unstated(st, ev.ts(), ev.str(Key::Skill).unwrap_or_default());
            // …and the ring SAYS SO out loud rather than printing a 0 that reads like a measurement.
            let (target, skill) = (
                ev.str(Key::Target).unwrap_or_default().to_owned(),
                ev.str(Key::Skill).unwrap_or_default().to_owned(),
            );
            st.log(
                ev.ts(),
                "heal",
                "info",
                format!("+ {target} {skill} (amount not stated)"),
            );
            true
        }
        // Damage PREVENTED, not hit points restored, so it never touches a DAMAGE total. It does reach
        // the HEALING total as a rune/absorbed row.
        Kind::Mitigation => {
            routing::route_mitigation(
                st,
                &MitigationLine {
                    ts: ev.ts(),
                    mtype: ev.str(Key::Mtype).unwrap_or_default(),
                    amount: ev.int(Key::Amount),
                },
            );
            st.log(ev.ts(), "mitigation", "info", mitigation_line(ev));
            true
        }
        Kind::Miss => {
            let Some(mtype) = ev.str(Key::Mtype).and_then(MissType::parse) else {
                return true;
            };
            let attacker = ev.str(Key::Attacker).unwrap_or_default().to_string();
            routing::route_miss(
                st,
                &MissLine {
                    ts: ev.ts(),
                    attacker: attacker.clone(),
                    target: ev.str(Key::Target).unwrap_or_default().to_string(),
                    mtype,
                    verb: ev.str(Key::Verb).map(str::to_string),
                    // A miss line names no skill, so the round lane's floor is the parser's own
                    // `meleeSkill(verb)` answer, reached through the parser's own port so the two
                    // ends cannot answer differently.
                    verb_skill: ev
                        .str(Key::Verb)
                        .map(|v| eqlog::parse::combat::melee_skill(v).to_string()),
                    modifiers: ev
                        .arr_str(Key::Modifiers)
                        .iter()
                        .map(|s| s.to_string())
                        .collect(),
                },
            );
            // YOUR avoided swing is still a swing ATTEMPT, and the mechanical proc denominator is
            // attempts — a proc that cannot fire on a miss still had the chance to.
            if id_key_ref(&attacker) == "you" {
                fold_both(st, ev.ts(), |agg, active| {
                    agg.windows.fold(
                        &WindowFold {
                            ts: ev.ts(),
                            swings: 1,
                            ..WindowFold::default()
                        },
                        active,
                    );
                    agg.procs.add_swing(active);
                });
            }
            true
        }
        Kind::Resist => {
            let caster = ev.str(Key::Caster).unwrap_or_default().to_string();
            let spell = ev.str(Key::Spell).unwrap_or_default().to_string();
            let incoming = ev.bool(Key::Incoming);
            // `<mob> resisted your <Charm>!` is the third way an armed cast fails to land. Only OUR
            // OWN outgoing resist counts; an incoming one — we shrugged off a mob's spell — says
            // nothing about what we were casting.
            if !incoming && id_key_ref(&caster) == "you" {
                // A FULLY-RESISTED cast landed NOTHING, so like a fizzle it must not stay in the window
                // to claim the next proc of the same name. `forget` drops only an UNCLAIMED record,
                // which is what keeps a partially-resisted AoE honest: if a target of the same firing
                // already took damage, the cast is spent and the rest of that instant still joins.
                st.recent_casts.forget(&spell);
                st.charm.note_cast_failed(&spell, ev.ts());
            }
            routing::route_resist(
                st,
                &ResistLine {
                    ts: ev.ts(),
                    caster,
                    target: ev.str(Key::Target).unwrap_or_default().to_string(),
                    spell,
                    incoming,
                },
            );
            true
        }
        _ => false,
    }
}

/// One canonical `damage` line: close any pending encounter at this ts BEFORE routing, so attributed
/// damage after a closure starts a fresh encounter rather than reviving the old one.
fn ingest_damage(st: &mut EngineState, ev: &Event) {
    // Caster-less other-player DoTs (`attacker: null`) are not our fight — and the RAW LINE is what
    // the ring keeps for one, because there is nothing else to say about a line nobody owns.
    let Some(attacker) = ev.str(Key::Attacker) else {
        st.log(ev.ts(), "other", "dropped", ev.raw().to_owned());
        return;
    };
    eval_closure(st, ev.ts());
    // Built here rather than inside `to_damage_event` so the record can BORROW it — see that
    // function's header.
    let modifiers = ev.arr_str(Key::Modifiers);
    let dmg = to_damage_event(st, ev, attacker, &modifiers);
    // WHERE IT CAME FROM, BEFORE IT IS FILED. The verdict names the LANE, so it has to be reached
    // before `route()` folds the hit — and it is reached exactly once, here, because it CONSUMES the
    // cast claim (asking twice would take two claims off one cast line and count the second landing as
    // a proc).
    let origin = damage_origin(st, &dmg);
    // The lane a cast-less firing lands in. A fresh record, never a mutation of the one the ledger
    // gets: `spell_procs` is keyed by the SPELL, so the ledger row, its PPM and its tag stay ONE lane
    // however many meter rows the spell now occupies.
    //
    // THE CLONE IS NOW FREE (JOS-506) and the record is still fresh. Every field but `skill` and
    // `category` is a reference and `category` is borrowed on this path, so `dmg.clone()` copies
    // pointers rather than re-allocating eight strings and a list — which is what it did on every
    // cast-less firing in the log before this.
    let laned = match origin {
        None => None,
        Some(o) => Some(DamageEvent {
            skill: Cow::Owned(lane_name_for(&dmg.skill, o)),
            ..dmg.clone()
        }),
    };
    // Read the engine's active-time clock either side of `route()`: the DIFFERENCE is the exact
    // capped-gap delta it accrued for this hit. A fresh encounter (one `route()` opened) contributes
    // 0, which is precisely what the routing path does for a first hit.
    //
    // ONE CLONE, AND ONLY THE ONE THAT HAS TO CROSS THE `&mut` (JOS-506). The `before` reading is
    // owned because `route()` takes the whole state mutably and may replace the encounter under it;
    // the `after` reading has no such problem and used to clone anyway, which cost a second heap
    // allocation on EVERY damage line in the log to answer a question that is a string COMPARE.
    let enc_before = st.current.as_ref().map(|e| e.id.clone());
    let active_before = st.current.as_ref().map_or(0, |e| e.active_ms);
    let Some(at) = routing::route(st, laned.as_ref().unwrap_or(&dmg)) else {
        return;
    };
    let same_encounter = st.current.as_ref().map(|e| e.id.as_str()) == enc_before.as_deref();
    let delta = if same_encounter {
        st.current.as_ref().map_or(0, |e| e.active_ms) - active_before
    } else {
        0
    };
    fold_damage_analytics(st, &dmg, delta, &at, origin);
}

/// WHERE ONE OF YOUR SPELL EFFECTS CAME FROM, decided BEFORE the line is routed because the answer
/// names the meter LANE it lands in. `None` = the question does not arise: not a spell effect, not
/// yours, or a line the meter drops anyway.
///
/// The two eligibility gates run FIRST and in that order, so only a `dtype: spell` line of the
/// player's ever pays for the extra `classify` — a few hundredths of the fold's damage lines.
fn damage_origin(st: &mut EngineState, ev: &DamageEvent) -> Option<SpellOrigin> {
    if ev.amount <= 0 {
        return None;
    }
    if !proc_eligible_damage(ev.dtype, &ev.skill) {
        return None;
    }
    if id_key_ref(ev.attacker) != "you" {
        return None;
    }
    if routing::classify(st, ev.attacker, ev.target) != Attribution::OutYou {
        return None;
    }
    // The cast ledger answers cast-or-not; the held-clicky set is what turns a `proc` verdict into a
    // `click` one. Empty set ⇒ identity, so this line changes nothing without a dump.
    let verdict = st.recent_casts.origin(&ev.skill, ev.ts);
    Some(castless_kind(verdict, &ev.skill, &st.held_clickies))
}

/// Fold one judgement into BOTH ledgers this segment has — the zone aggregate and the FRESH
/// encounter, if any. Every proc counter is written through here so the two can never disagree about a
/// line, and so the per-state split is fed from exactly one place.
///
/// `active` is the state timeline's O(1) open set, read at the event's own instant and PASSED (never
/// re-read) into every accumulator, because the whole point of folding on ingest is that "what was on
/// when this fired" is knowable only now.
///
/// IT IS BORROWED, NOT CLONED (JOS-506). The clone was here because `fresh_encounter` takes `&mut
/// self` and the set is a third field of the same state object — but `state_timeline`, `zone_agg` and
/// `current` are DISJOINT FIELDS, and the borrow checker allows exactly that split as long as the
/// freshness question is asked BEFORE the mutable borrow is taken. `fresh_encounter_id` is that
/// question, already spelled once in `state.rs` beside `fresh_encounter` itself, so this reads the
/// rule rather than restating it.
///
/// The semantics are untouched and cannot drift: `f` is handed `&mut Agg` and `&HashSet`, so it has
/// no way to reach the timeline and mutate the set mid-fold — which is the one thing the clone was
/// protecting against, and the type system was already protecting against it. What the clone
/// actually cost was a fresh hash table plus one heap allocation PER OPEN SPAN, on every damage
/// line, every avoided swing and every cast-less heal in the log.
fn fold_both(
    st: &mut EngineState,
    ts: i64,
    f: impl Fn(&mut crate::combat::aggregate::Agg, &std::collections::HashSet<String>),
) {
    let fresh = st.fresh_encounter_id(ts);
    f(&mut st.zone_agg, &st.state_timeline.active);
    if fresh {
        let active = &st.state_timeline.active;
        if let Some(enc) = st.current.as_mut() {
            f(&mut enc.agg, active);
        }
    }
}

/// PROC ANALYTICS for one attributed damage line. PURELY ADDITIVE — everything below is a COUNT or an
/// INDEX over damage the meter already counted.
///
/// The three judgements, each with its gate:
///   * OUTGOING-YOURS only. A pet's damage is not your swing and not your proc, and neither is a group
///     member's: proc analytics stay strictly first-person because the cast-less inference reads `You
///     begin casting`, which only you print.
///   * SWING = a melee or slay HIT (misses are added by the miss path). Slay counts because a Slay
///     Undead proc rides an ordinary swing — it IS a swing.
///   * PROC = a cast-less spell effect. A CLICK is a cast-less firing too, so it still folds a lane —
///     what changes is the LANE NAME, which `ingest_damage` has already applied.
fn fold_damage_analytics(
    st: &mut EngineState,
    ev: &DamageEvent,
    active_delta_ms: i64,
    at: &Attribution,
    origin: Option<SpellOrigin>,
) {
    if ev.amount <= 0 || *at == Attribution::Ignore {
        return;
    }
    let mine = *at == Attribution::OutYou;
    let swing = mine && (ev.category == "melee" || ev.category == "slay");
    let proc = mine && matches!(origin, Some(SpellOrigin::Proc) | Some(SpellOrigin::Click));
    let click = origin == Some(SpellOrigin::Click);
    let fold = WindowFold {
        ts: ev.ts,
        active_delta_ms,
        out_damage: if mine { ev.amount } else { 0 },
        proc_damage: if proc { ev.amount } else { 0 },
        swings: i64::from(swing),
    };
    // The LEDGER gets the UN-SPLIT skill: `spell_procs` is keyed by the SPELL, so the ledger row, its
    // PPM and its drill tag stay one lane however many meter rows the spell now occupies.
    let spell = ev.skill.clone();
    fold_both(st, ev.ts, |agg, active| {
        agg.windows.fold(&fold, active);
        agg.procs.add_active_ms(active_delta_ms, active);
        if swing {
            agg.procs.add_swing(active);
        }
        if proc {
            agg.procs.add_spell_proc(&SpellProcFold {
                spell: &spell,
                side: ProcSide::Damage,
                amount: Some(ev.amount),
                active,
                click,
            });
        }
    });
}

/// A heal with no own cast behind it — the healing half of the same inference (`Lifetap Strike`: 1,814
/// procs and 52,861 hit points restored, zero casts, in the real log). Gated to YOUR OWN heals —
/// another player's cast-less heal is their proc, not yours — and to the two refusals `is_castless_heal`
/// owns (a HoT tick and a Quick Buff burst landing).
fn fold_heal_analytics(st: &mut EngineState, ev: &HealLine, over_time: bool) {
    let Some(spell) = ev.spell.clone() else {
        return;
    };
    if id_key_ref(ev.healer.as_deref().unwrap_or("")) != "you" {
        return;
    }
    let quick_buff_ts = st.quick_buff_ts;
    if !is_castless_heal(
        &mut st.recent_casts,
        &HealProcInput {
            spell: &spell,
            ts: ev.ts,
            over_time,
            quick_buff_ts,
        },
    ) {
        return;
    }
    // The gate above has already reached `proc`; the held set is what would promote it. A clicky heal
    // is the same shape as the damage side.
    let click = castless_kind(
        crate::combat::procdetect::CastVerdict::Proc,
        &spell,
        &st.held_clickies,
    ) == SpellOrigin::Click;
    let amount = ev.amount;
    fold_both(st, ev.ts, |agg, active| {
        agg.procs.add_spell_proc(&SpellProcFold {
            spell: &spell,
            side: ProcSide::Heal,
            amount: Some(amount),
            active,
            click,
        });
    });
}

/// The engine's internal damage record, with the lane NAMED.
///
/// EQ Legends' upgraded specials print no verb of their own (a Dragon Punch lands as `You strike …`),
/// so the parser can only ever answer the generic skill for them. `name_special_lane` applies the
/// log's OWN statement of which special is live in that verb's lane. It is a pure RENAME of `skill`:
/// the amount, the type, the category and the attribution are untouched, so every damage total stays
/// byte-identical (law 8's tripwire). Gated on the attacker being YOU, because the state line is
/// first-person-only and a mob's `strikes` must stay generic melee.
/// THE MODIFIER LIST IS THE CALLER'S (JOS-506). `arr_str` has to build a list — the payload stores
/// the tokens as a run rather than as a slice — so it is built ONCE, in `ingest_damage`'s frame, and
/// the record borrows it. That is what lets the record itself be pure references: a `Vec<&str>` over
/// no modifiers (which is the overwhelming majority of lines) allocates nothing at all, where the
/// `Vec<String>` this replaces allocated a string per token AND a list to hold them.
fn to_damage_event<'a>(
    st: &EngineState,
    ev: &'a Event,
    attacker: &'a str,
    modifiers: &'a [&'a str],
) -> DamageEvent<'a> {
    let verb = ev.str(Key::Verb);
    let mut skill = Cow::Borrowed(ev.str(Key::Skill).unwrap_or_default());
    if id_key_ref(attacker) == "you" {
        if let Some(lane) = st.specials.lane_skill(verb) {
            // The one owned spelling on this path, and it has to be: the lane name is the ENGINE's
            // state, not the event's, so it cannot be borrowed for the event's lifetime.
            skill = Cow::Owned(lane.to_string());
        }
    }
    let dtype = ev.str(Key::Dtype).unwrap_or_default();
    DamageEvent {
        ts: ev.ts(),
        attacker,
        target: ev.str(Key::Target).unwrap_or_default(),
        amount: ev.int(Key::Amount).unwrap_or(0),
        // Prefer the parse-time category; derive as a fallback so any path that omits it still
        // aggregates under the right axis. The fallback answers with a `'static` taxonomy constant,
        // so neither arm allocates.
        category: match ev.str(Key::Category) {
            Some(c) => Cow::Borrowed(c),
            None => Cow::Borrowed(eqlog::taxonomy::damage_category(dtype, modifiers)),
        },
        dtype,
        dclass: ev.str(Key::Dclass),
        skill,
        crit: ev.bool(Key::Crit),
        modifiers,
        verb,
    }
}

// ── CAST ──────────────────────────────────────────────────────────────────────────────────────

/// THE OWN-CAST LIFECYCLE. Its own family because BOTH of the engine's ownership inferences run off
/// it and they must see the same lines: the cast-less PROC detector (unported — see the module
/// header) and the CHARM/CC/pet-buff ownership model, whose only honest owner signal is the
/// exclusivity of `You begin casting <Spell>.`
fn ingest_cast(st: &mut EngineState, ev: &Event) -> bool {
    match ev.kind_of() {
        Kind::CastBegin => {
            if let Some(spell) = ev.str(Key::Spell) {
                st.recent_casts.note(spell, ev.ts());
                st.charm.note_cast_begin(spell, ev.ts());
            }
            // …AND THE THIRD READER OF THE SAME EXCLUSIVITY (JOS-258). A pet SUMMON is knowable from
            // this line and only from this line — the summon itself prints nothing the log can
            // attribute — so a summon with no bind behind it is the one moment the meter can honestly
            // say it is about to miss a pet. LIVE ONLY: a summon from four hours ago is not news, and
            // the whole point of `hydrating` is that a replayed moment must not be dressed up as the
            // present. A historical fold therefore never arms it, which is why every golden's
            // `petNudge` is absent and why the oracle cannot see this line at all.
            if !st.hydrating {
                if let Some(spell) = ev.str(Key::Spell) {
                    if is_pet_summon_spell(spell) {
                        st.pet_nudge.note_summon_cast(ev.ts());
                    }
                }
            }
            true
        }
        Kind::CastFizzle | Kind::CastInterrupted => {
            // A cast that resolved to nothing explains no landing, and nothing it might have
            // "resolved" is ours. An interrupt can still RECOVER, which is what `castResumed` is for.
            if let Some(spell) = ev.str(Key::Spell) {
                st.recent_casts.forget(spell);
                st.charm.note_cast_failed(spell, ev.ts());
                // The same argument, for the nudge: a summon that never resolved summoned nothing,
                // and a nudge about a pet that does not exist is the staleness the ruling forbids.
                // UNGATED, like the TS: an arm can only exist if something armed it live.
                if is_pet_summon_spell(spell) {
                    st.pet_nudge.note_cast_failed();
                }
            }
            true
        }
        Kind::OtherCastBegin => {
            // THE LINE COMBAT NEVER INGESTED — the only sentence in this log that says who ELSE is
            // casting what, and therefore the only thing that can name the owner of a caster-less
            // `<mob> has been charmed.` broadcast.
            let (Some(caster), Some(spell)) = (ev.str(Key::Caster), ev.str(Key::Spell)) else {
                return true;
            };
            let caster_key = id_key(caster);
            let allowed = st.ally_caster_allowed(&caster_key);
            st.ally.note_cast(&AllyCastLine {
                caster,
                caster_key: &caster_key,
                spell,
                ts: ev.ts(),
                allowed,
            });
            true
        }
        // `You regain your concentration and continue your casting.` — the interrupted cast is back on
        // and will land, so give it back its claim, with its ORIGINAL cast ts. DELIBERATELY does not
        // re-arm the charm/CC model: that model's own evidence rules are a separate question and were
        // not measured here.
        Kind::CastResumed => {
            st.recent_casts.resume();
            true
        }
        _ => false,
    }
}

// ── CHOICE ────────────────────────────────────────────────────────────────────────────────────

/// THE CHARACTER'S STANDING CHOICES — stance, invocation, and the active special attack.
///
/// Its own family rather than three more cases beside the annotations, because the three answer the
/// same question and none of them is an event in a fight: they are what the character has DECIDED to
/// do, persisting across pulls and zones until the game prints a different decision.
fn ingest_choice(st: &mut EngineState, ev: &Event) -> bool {
    match ev.kind_of() {
        Kind::StanceChange => {
            if let Some(name) = ev.str(Key::Stance).map(str::to_string) {
                apply_stance(st, "stance", &name, ev.ts());
                st.log(ev.ts(), "stance", "info", format!("▸ stance: {name}"));
            }
            true
        }
        Kind::InvocationChange => {
            if let Some(name) = ev.str(Key::Invocation).map(str::to_string) {
                apply_stance(st, "invocation", &name, ev.ts());
                st.log(
                    ev.ts(),
                    "invocation",
                    "info",
                    format!("▸ invocation: {name}"),
                );
            }
            true
        }
        Kind::SpecialAttack => {
            // `You will now use Dragon Punch instead of Eagle Strike while attacking.` — the ONE line
            // that names the special behind an otherwise anonymous `You strike …`. It opens nothing,
            // closes nothing, and moves no total; it changes what a later swing is CALLED.
            if let Some(skill) = ev.str(Key::Skill).map(str::to_string) {
                let lane = st.specials.note(&skill);
                // A special OUTSIDE the verified lane table is still SEEN and still logged. Saying so
                // is the honest report: the line was read and deliberately not acted on.
                let note = match lane {
                    None => " (no verb lane - label unchanged)".to_owned(),
                    Some(l) => format!(" ({l} lane)"),
                };
                let from = match ev.str(Key::Replaces) {
                    Some(r) => format!(" instead of {r}"),
                    None => String::new(),
                };
                st.log(
                    ev.ts(),
                    "special",
                    "info",
                    format!("▸ special attack: {skill}{from}{note}"),
                );
            }
            true
        }
        _ => false,
    }
}

// ── MODIFIER ──────────────────────────────────────────────────────────────────────────────────

/// coats · procs · dispel landings · Quick Buff · your own death. Everything here is an ANNOTATION:
/// none of it opens, extends or closes an encounter.
fn ingest_modifier(st: &mut EngineState, ev: &Event) {
    match ev.kind_of() {
        Kind::PoisonCoat => route_coat(
            st,
            &CoatLine {
                ts: ev.ts(),
                poison: ev.str(Key::Poison).unwrap_or("unknown"),
                group: ev.str(Key::Group).unwrap_or("unknown"),
                who: ev.str(Key::Who).unwrap_or_default(),
            },
        ),
        Kind::PoisonDry => route_dry(st, ev.str(Key::Group).unwrap_or_default(), ev.ts()),
        Kind::PoisonProc => route_proc(
            st,
            &ProcLine {
                ts: ev.ts(),
                strike: ev.str(Key::Strike).unwrap_or_default(),
                candidates: ev
                    .arr_str(Key::Candidates)
                    .iter()
                    .map(|s| s.to_string())
                    .collect(),
                target: ev.str(Key::Target).unwrap_or_default(),
                effect: ev.str(Key::Effect).unwrap_or_default(),
            },
        ),
        Kind::BuffApply => {
            let names = ev.candidate_names(Key::Candidates);
            let target = ev.str(Key::Target).unwrap_or_default().to_string();
            // THE PET BIND RUNS FIRST so the three curated gates below see a world model that already
            // knows whose the buffed entity is. FOUR disjoint gates over ONE event, and not one of
            // them consumes another's lines: this one BINDS, the dispel family names a lane on a MOB,
            // the proc-buff catalog opens a SELF-BUFF SPAN, and the self-landing registry counts a
            // FIRING.
            if target != "self" {
                bind_pet_buff_landing(st, ev);
            }
            route_dispel_landing(st, ev.ts(), &target, &names);
            route_proc_buff_apply(st, ev.ts(), &target, &names);
            route_self_landing_proc(st, ev.ts(), &target, &names);
        }
        // The rare PRINTED end of a tracked proc buff — the only path that can close a buff span
        // `observed`. In the real log this fires ONCE against 97 landings, which is exactly why edge
        // evidence exists at all.
        // `arr_str`, NOT `candidate_names`: the two events spell their candidate list differently and
        // the difference is load-bearing. A `buffApply` carries OBJECTS (`{name, durationMs, illusion}`)
        // because the buffs module needs the duration; a `buffWearOff` carries plain STRINGS, because a
        // fade line has nothing else to say. Reading the wrong one silently answers an empty list, and
        // an empty list means this gate NEVER fires — which leaves every tracked buff span open to be
        // superseded or censored later instead of ending `observed` where the game printed an end.
        Kind::BuffWearOff => {
            let names: Vec<String> = ev
                .arr_str(Key::Candidates)
                .iter()
                .map(|s| s.to_string())
                .collect();
            route_proc_buff_wear_off(st, ev.ts(), &names);
        }
        // THE QUICK BUFF BURST. This AA re-applies every memorized buff and prints their LANDINGS
        // ONLY — no cast line for any of them — so without this stamp 254 buff landings in the real
        // log read as cast-less procs. Recording the activation is the whole fix: the burst is cast
        // evidence in a different shape.
        Kind::AaActivate => {
            if id_key_ref(ev.str(Key::Name).unwrap_or_default()) == QUICK_BUFF_AA {
                st.quick_buff_ts = ev.ts();
            }
        }
        Kind::PlayerDeath => {
            // BLADE COATS DIE WITH YOU. The wiki's Rogue page states poisons "remain active until
            // class swap or death", and the log corroborates it without ever printing a dry line:
            // `Your Paralytic Poison spell did not take hold. (Blocked by Neurotoxic Poison.)` at
            // 20:01:47, then — after `You have been slain by a rock golem!` at 21:01:40 — the SAME
            // Paralytic coat lands cleanly at 21:15:23. Something removed Neurotoxic in between and no
            // line said so.
            //
            // FIRST, and through the shared door: the coat clear runs BEFORE the censor below so the
            // coat spans close through `clear_coats`, which — unlike a bare censor — also STAMPS the
            // window transition. That stamp is what discards the boundary minute from the Tier-B
            // purity gate, and a minute in which the player died and four coats ended is the last
            // minute that should be believed clean. The censor then finds the coat groups already
            // closed and severs everything else.
            clear_coats(st, ev.ts(), CoatClearReason::Death);
            st.state_timeline.censor_all(ev.ts());
        }
        _ => {}
    }
}

/// THE UPGRADED PET (JOS-188) — `You begin casting Burnout.` … `<Name> goes berserk.`
///
/// The reported defect: a magician upgraded a level-10 water elemental to a level-14 one and the new
/// pet never appeared in the meter. Nothing was broken. The single-pet succession law never RAN,
/// because succession is triggered by the successor's own claim and an upgraded summon produces none:
/// the two binding lines the app had both require the player to TALK to the pet, and the reporter's
/// 30-minute slice holds 2,446 lines, two pets and ZERO tells.
///
/// THE THIRD BINDING SIGNAL, and the first that costs the player nothing. 40 spells in the DB are
/// `targetType: Pet` and the game will not let one land on anything but your own pet;
/// `You begin casting <Spell>.` is printed for the player and NOBODY else. So the pair — own cast,
/// then a landing that resolves it — names your pet as surely as the tell does, and it fires when a
/// summoner buffs the pet they just summoned rather than when they first order it.
///
/// MEASURED on the owner's whole log: 19 binds, 14 distinct names, every one of the 14 also bound by
/// a `… Master.'` tell — no name bound by this rule alone, no bind contradicting one — and in all 14
/// this arrives FIRST, by 81 s to 2,528 s, covering 1,865 hits / 27,088 points the meter used to
/// throw away.
///
/// THE MESSAGE IS NOT THE GATE — THE ARMED OWN CAST IS. `goes berserk.` resolves to Burnout / Fury /
/// Rage / Voice of the Berserker and only Burnout is a pet spell, so the candidate list must contain
/// the spell we are mid-cast of.
///
/// AND THE RUNG HAS A SILENT PRECONDITION: THE DB MUST BE ABLE TO NAME THE SPELL (JOS-349). A
/// candidate list comes from the cast-on-other SUFFIX table, so a `targetType: Pet` spell whose
/// scraped third-person message carries some OTHER subject token is in no table and can never be a
/// candidate for its OWN landing. Six pet-only spells are still in that state. If a report says a pet
/// stopped being attributed, CHECK THE CANDIDATE LIST FIRST — there is no time limit on a summoned
/// pet and no rule here that drops one, so an absent bind is almost always a bind that never happened.
fn bind_pet_buff_landing(st: &mut EngineState, ev: &Event) {
    let target = ev.str(Key::Target).unwrap_or_default().to_string();
    // The parser emits `target: 'self'` for the msgCastOnYou form; only a NAMED landing can bind.
    if target == "self" || target.is_empty() {
        return;
    }
    let names = ev.candidate_names(Key::Candidates);
    if !st.charm.pet_buff_landing(&names, ev.ts()) {
        return;
    }
    // A landing on YOURSELF is a self-buff the DB mislabels, never a pet — the third-person form can
    // still name you when another player's buff lands on you in the same second.
    // The `unwrap_or_default` is load-bearing and is kept verbatim: with no player key known yet the
    // comparison is against the EMPTY string, which a whitespace-only target's key also is.
    if id_key_ref(&target).as_ref() == st.player_key.as_deref().unwrap_or_default() {
        return;
    }
    bind_pet_claim(st, &target, ev.ts(), "petBuff");
}
