//! The ingest switch — one canonical event in, one state transition out (`combat/ingest.ts`), plus
//! the three lines that bind one of YOUR pets and the four the ally model reads.
//!
//! Split along the five event families, which are disjoint on `kind`, so the chain is exactly the
//! old switch: each family tries its own cases and reports whether it consumed the event.
//!
//!   ingest_world    epoch · zone · charm · petClaim · allyPetLeader · petSay · uncharm · cc · death
//!   ingest_combat   damage · heal · healUnstated · mitigation · miss · resist
//!   ingest_cast     castBegin · castFizzle · castInterrupted · otherCastBegin · castResumed
//!   ingest_choice   stanceChange · invocationChange · specialAttack
//!   ingest_modifier poisonCoat · poisonDry · poisonProc · buffApply · buffWearOff · aaActivate ·
//!                   playerDeath
//!
//! The proc analytics fold here and must: everything they need is a count or an index over damage
//! the meter already counted, and the encounter event ring is capped, truncated at finalize and
//! absent entirely for a zone session — so "what was on when this fired" is knowable only now.
//! Nothing below calls an `add_*` that moves a damage total (law 8's tripwire).

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
    // The three deadline models age out on the LOG clock, driven from the event stream and from the
    // snapshot — whichever observes the deadline first acts. The nudge sweep is ungated by
    // `hydrating` because a model that can only be armed live sweeps for nothing in a replay.
    st.sweep_charm(ev.ts());
    st.sweep_ally(ev.ts());
    st.pet_nudge.sweep(ev.ts());
    // The blade coats are consulted on the same clock but deliberately NOT from the snapshot: the
    // other three are display timers, this one mutates the fold, and a fold that advanced because
    // the UI polled would make a replay disagree with the live tail.
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

/// Leaving rogue bares the blades — the second of the two boundaries the wiki's Rogue page names
/// ("poisons remain active until class swap or death").
///
/// The whole feature is the GATE on when the class model may be consulted, and the gate is what is
/// reproduced here. Three clauses: there must be something to clear (two field reads, which is all
/// every non-rogue ever pays); a loadout-stating event (`selfWho` / `level`) asks immediately;
/// otherwise at most once per `CLASS_CHECK_MS` of LOG time.
///
/// The consultation itself cannot happen without a combo provider, which this fold does not install
/// — the TS takes the same early return. The throttle stamp is written BEFORE the ask, as over
/// there, so `coat_class_checked_ts` advances on exactly the same events either way.
fn sweep_coat_class(st: &mut EngineState, ev: &Event) {
    if st.coat_utility.is_none() && st.coat_combat.is_empty() {
        return;
    }
    let states_loadout = matches!(ev.kind_of(), Kind::SelfWho | Kind::Level);
    if !states_loadout && ev.ts() - st.coat_class_checked_ts < CLASS_CHECK_MS {
        return;
    }
    st.coat_class_checked_ts = ev.ts();
    // The combo provider is null in this fold, so the TS returns here and so does this.
}

/// The poll period, in LOG milliseconds — never a wall clock, so a replay consults at exactly the
/// instants the live tail did.
///
/// Fifteen minutes because that is the combo interval model's own `WINDOW_FLOOR_MS`: it cannot date
/// a swap finer than that, so a faster poll would only re-ask a question whose answer cannot move.
const CLASS_CHECK_MS: i64 = 15 * 60_000;

fn ingest_world(st: &mut EngineState, ev: &Event) -> bool {
    match ev.kind_of() {
        // Character rebirth — a same-name character was wiped and recreated. The session's fights
        // are deliberately kept; what goes is the beta character's WORLD state: the open fight is
        // finalized and the pet/charm/ally sets cleared, so the boundary is explicit rather than
        // depending on a zone line arriving after login. The special-attack lanes retire with them —
        // "you will now use Dragon Punch" was said to the previous character — and fall back to the
        // parser's generic names.
        Kind::Epoch => {
            finalize_current(st);
            st.pet_names.clear();
            st.world.reset();
            st.charm.reset();
            st.ally.reset();
            // The blade coats go with them, through the SAME door the death rule uses, so the slots
            // and the spans cannot end up disagreeing. A rebirth is a different character; nothing
            // was on these blades.
            clear_coats(st, ev.ts(), CoatClearReason::Epoch);
            // An epoch severs every active-state span: the beta character's stances, coats and buffs
            // are not this character's. Censored, never `observed`, and never a fabricated expiry.
            st.state_timeline.censor_all(ev.ts());
            st.specials.reset();
            true
        }
        Kind::Zone => {
            finalize_current(st);
            // Freeze the just-left stay's aggregate into the capped history before resetting, so its
            // overall meter stays selectable. An empty stay is dropped.
            st.finalize_zone_session(ZoneSessionClose::Zone);
            st.zone = ev.str(Key::Zone).map(str::to_string);
            // The accumulator half of the boundary, shared with the session mark. Everything BELOW
            // this line is what a mark omits, because it states that the ROOM changed.
            st.reset_zone_accumulators();
            // Charm cannot survive a zone and hostile mobs do not follow, so both retire. Summoned
            // class pets persist, so the survivors are what the fast pet-name index is rebuilt from.
            let survivors = st.world.zone(ev.ts());
            st.drain_retirements();
            let keys: Vec<String> = survivors.into_iter().map(|s| s.name_key).collect();
            st.pet_names = keys.iter().cloned().collect();
            st.charm.zone(&keys);
            // Somebody else's charm cannot survive a zone either, and neither can a cast in flight.
            // The friendly set survives — it is about people, not about the room.
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
            // `via: 'petBuff'` never comes off a line: it is `bind_pet_buff_landing` handed to the
            // bus, which delivers it straight back here. Re-binding would be harmless — every route
            // is idempotent — but refusing it makes the seam provably loop-free.
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
            // A `says` line is broadcast and proves nothing about WHOSE pet the speaker is. What it
            // does prove is that the speaker is somebody's pet, which no other rung of the
            // record-everything ladder can establish: EQ spells a summoned pet's name with the same
            // grammar it gives people, so without this a raid's strangers' pets keep rows of their
            // own.
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
            // `Your <charm spell> spell has worn off of <mob>` — only the caster sees this, so it is
            // retroactive proof the bind was ours. Corroborate first (a bind that ends this way was
            // real even if the pet never spoke or swung), then release.
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

/// `<mob> has been charmed.` — the ownership gate. The line is a broadcast and names no caster, so
/// it binds only when it resolved one of the owner's own charm casts. A foreign charm is remembered
/// as an observation, so it stays available to the petClaim promote path but never enters the
/// attribution set.
fn ingest_charm(st: &mut EngineState, ev: &Event) {
    let Some(mob) = ev.str(Key::Mob).map(str::to_string) else {
        return;
    };
    let key = id_key(&mob);
    // Whoever's charm it is, the thing is a MOB — true of both arms below, so a name a charm
    // broadcast has spoken is never a combatant the record-everything ladder keeps a row for.
    st.retract_other(&key, "a charm broadcast named it");
    if st.charm.charm_broadcast(&key, &mob, ev.ts()) == CharmVerdict::Foreign {
        // A charm broadcast that resolved none of YOUR casts, offered to the ally model before it is
        // dropped. The world model is deliberately not told: `world.charm()` marks an instance as a
        // pet of ours — exempt from staleness, out of hostile presence, in the pet set — and an
        // ally's pet is none of those things to us. It may very well be a mob we are killing.
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
    // Your charm wins outright over any ally bind of the same mob — you can charm what somebody
    // else's charm just broke off, and two models calling one entity a pet is the duplicated
    // ownership law 4 forbids.
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

/// The parenthetical a claim's ring line carries, one per route.
///
/// `via` reaches the processing log and nothing else: all three routes are ownership-definitive and
/// the model treats them identically. What differs is what a reader needs in order to know why the
/// engine believes it.
fn claim_note(via: &str) -> &'static str {
    match via {
        "leader" => " (it named you its leader)",
        "petBuff" => " (you cast a pet-only spell on it)",
        // `tell` — the private, unforgeable route, which needs no explaining.
        _ => "",
    }
}

/// A pet identified you as its owner, so the named entity is your pet. Three lines produce this one
/// transition and this function deliberately does not care which — a second binding path is what
/// law 4 forbids.
///
/// Ownership-definitive and pet-only, which is why it also PROMOTES: a name we saw charmed but
/// declined to bind is bound here, and bound as charmed rather than summoned. Otherwise it binds a
/// summoned pet idempotently — a charmed mob sends the tell too, and `world.claim()` leaves an
/// already-charmed instance's kind alone.
fn bind_pet_claim(st: &mut EngineState, name: &str, ts: i64, via: &str) {
    let key = id_key(name);
    // Anything that names itself yours stops being anybody else's. All three claim routes are
    // first-person and ownership-definitive; an ally bind rests on a broadcast, which is weaker by
    // construction, so this override needs no tie-break.
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
    // …and it answers the nudge, whichever route produced it: a bound pet needs no coaching, and a
    // claim inside the grace window means the nudge was never drawn at all.
    st.pet_nudge.note_bound();
    let what = if promote { "charm claim" } else { "pet claim" };
    st.log(
        ts,
        if promote { "charm" } else { "pet" },
        "info",
        format!("⚡ {what} {label} [{id}]{}", claim_note(via)),
    );
    // Single-pet succession: claiming a new summoned pet retires the previous one inside the world
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

/// `<PetName> says, 'My leader is <Player>.'` about somebody else — the strongest ally bind, and the
/// only one that reaches a stranger's summoned pet.
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
    // Your own pet is yours, whatever a broadcast says. `says` is forgeable and the cost of getting
    // this wrong is deleting a real pet's damage, so the refusal is absolute.
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
    // The classification is said out loud: a lifecycle you cannot see is one nobody can report a bug
    // about.
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

/// Crowd control (mez/root, not charm). Evaluate any pending closure at this ts FIRST, so a CC on a
/// fresh pull cannot attach to a stale fight, then mark the CC'd instance engaged and CC-held so the
/// encounter stays open across the mez-and-wait gap. A CC'd instance counts as alive for closure.
///
/// Ownership gate: `<mob> has been mesmerized.` is a broadcast with no caster, so an APPLICATION
/// only counts when it resolved one of the owner's own CC casts. A foreign mez is fully inert — it
/// engages nothing, opens no hold, and does not touch `last_activity_ts`. The REFRESH shape is
/// exempt by construction: it derives from `Your <spell> spell has worn off of <mob>`, which only
/// the caster sees.
fn ingest_cc(st: &mut EngineState, ev: &Event) {
    let refresh = ev.bool(Key::Refresh);
    if !refresh && !st.charm.cc_broadcast(ev.ts()) {
        // A stranger's crowd control is an observation about the room, not an event in our fight,
        // and the refusal is said out loud — a line dropped on purpose is otherwise invisible to a
        // bug report.
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
    // A dead pet is not a pet. Unconditional and BY NAME, unlike the world model's pet-vs-twin
    // disambiguation below, because an ally bind is name-keyed to begin with. Ending it is the safe
    // direction: it risks losing a few seconds of a survivor's damage rather than crediting a
    // stranger with a corpse's.
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
    // model's retirement announcement, which is what makes death and staleness agree.
    st.drain_retirements();
    // Keep the fast pet-name set in lockstep: drop the name only when NO pet instance of it remains.
    if st.world.pet_instance(&name).is_none() {
        st.pet_names.remove(&key);
        st.charm.release(&key);
    }
}

/// The sentence a mitigation line gets in the ring, branching on `mtype` for which of the three
/// prevention shapes it was.
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
        // A heal with no amount cannot enter the proc model — a 0-amount "Mend proc" is a fabricated
        // observation — so it reaches the healing ledger's count lane and nothing else. It never
        // opens, joins or extends an encounter and never moves the damage timeline (law 8).
        Kind::HealUnstated => {
            routing::route_heal_unstated(st, ev.ts(), ev.str(Key::Skill).unwrap_or_default());
            // …and the ring says so rather than printing a 0 that reads like a measurement.
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
        // Damage PREVENTED, not hit points restored: it never touches a damage total, but it does
        // reach the healing total as a rune/absorbed row.
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
                    // `melee_skill(verb)` answer, asked through the parser's port so the two ends
                    // cannot answer differently.
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
            // Your avoided swing is still an ATTEMPT, and the mechanical proc denominator is
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
            // `<mob> resisted your <Charm>!` is the third way an armed cast fails to land. Only our
            // own outgoing resist counts; an incoming one says nothing about what we were casting.
            if !incoming && id_key_ref(&caster) == "you" {
                // A fully-resisted cast landed nothing, so like a fizzle it must not stay in the
                // window to claim the next proc of the same name. `forget` drops only an UNCLAIMED
                // record, which keeps a partially-resisted AoE honest.
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
    // Caster-less other-player DoTs (`attacker: null`) are not our fight, and the raw line is what
    // the ring keeps: there is nothing else to say about a line nobody owns.
    let Some(attacker) = ev.str(Key::Attacker) else {
        st.log(ev.ts(), "other", "dropped", ev.raw().to_owned());
        return;
    };
    eval_closure(st, ev.ts());
    // Built here rather than inside `to_damage_event` so the record can borrow it.
    let modifiers = ev.arr_str(Key::Modifiers);
    let dmg = to_damage_event(st, ev, attacker, &modifiers);
    // The origin verdict names the LANE, so it is reached before `route()` folds the hit — and
    // exactly once, because it CONSUMES the cast claim. Asking twice would take two claims off one
    // cast line and count the second landing as a proc.
    let origin = damage_origin(st, &dmg);
    // The lane a cast-less firing lands in — a fresh record, never a mutation of the one the ledger
    // gets, because `spell_procs` is keyed by the SPELL and its row must stay one lane however many
    // meter rows the spell occupies. The clone copies pointers: every field but `skill` is borrowed.
    let laned = match origin {
        None => None,
        Some(o) => Some(DamageEvent {
            skill: Cow::Owned(lane_name_for(&dmg.skill, o)),
            ..dmg.clone()
        }),
    };
    // Read the active-time clock either side of `route()`: the DIFFERENCE is the capped-gap delta
    // this hit accrued, and a fresh encounter contributes 0 exactly as the routing path does. Only
    // the `before` reading is owned, because `route()` takes the whole state mutably and may replace
    // the encounter under it.
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

/// Where one of your spell effects came from, decided before the line is routed because the answer
/// names the meter LANE it lands in. `None` = the question does not arise: not a spell effect, not
/// yours, or a line the meter drops anyway.
///
/// The two eligibility gates run first and in that order, so only a `dtype: spell` line of the
/// player's ever pays for the extra `classify`.
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

/// Fold one judgement into both ledgers this segment has — the zone aggregate and the FRESH
/// encounter, if any. Every proc counter is written through here, so the two can never disagree
/// about a line and the per-state split is fed from exactly one place.
///
/// `active` is the state timeline's open set, read at the event's own instant and passed (never
/// re-read) into every accumulator, because the point of folding on ingest is that "what was on when
/// this fired" is knowable only now.
///
/// It is borrowed rather than cloned: `state_timeline`, `zone_agg` and `current` are disjoint
/// fields, which the borrow checker allows as long as the freshness question (`fresh_encounter_id`)
/// is asked BEFORE the mutable borrow is taken. `f` is handed `&mut Agg` and `&HashSet`, so it has
/// no way to reach the timeline and mutate the set mid-fold.
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

/// Proc analytics for one attributed damage line. Purely additive — everything below is a count or
/// an index over damage the meter already counted.
///
/// The three judgements, each with its gate:
///   * Outgoing-YOURS only. Proc analytics stay strictly first-person, because the cast-less
///     inference reads `You begin casting`, which only you print.
///   * A SWING is a melee or slay hit (misses are added by the miss path). Slay counts because a
///     Slay Undead proc rides an ordinary swing.
///   * A PROC is a cast-less spell effect. A click is a cast-less firing too, so it folds a lane;
///     what changes is the lane NAME, which `ingest_damage` has already applied.
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
    // The ledger gets the un-split skill: `spell_procs` is keyed by the SPELL, so its row, PPM and
    // drill tag stay one lane however many meter rows the spell occupies.
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

/// A heal with no own cast behind it — the healing half of the same inference. Gated to your own
/// heals (another player's cast-less heal is their proc) and to the two refusals `is_castless_heal`
/// owns: a HoT tick and a Quick Buff burst landing.
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
    // The gate above has already reached `proc`; the held set is what would promote it to a click.
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

/// The engine's internal damage record, with the lane named.
///
/// EQ Legends' upgraded specials print no verb of their own (a Dragon Punch lands as `You strike …`),
/// so the parser can only answer the generic skill. The lane applies the log's own statement of
/// which special is live in that verb's lane. It is a pure RENAME of `skill` — amount, type,
/// category and attribution are untouched, so no damage total moves (law 8's tripwire) — and it is
/// gated on the attacker being You, because the state line is first-person-only.
///
/// The modifier list is the caller's: `arr_str` has to build a list, so it is built once in
/// `ingest_damage`'s frame and this record borrows it, which lets the record itself be pure
/// references.
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
            // The one owned spelling on this path: the lane name is the engine's state, not the
            // event's, so it cannot be borrowed for the event's lifetime.
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
        // aggregates under the right axis. The fallback answers a `'static` taxonomy constant, so
        // neither arm allocates.
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

/// The own-cast lifecycle. Its own family because both of the engine's ownership inferences run off
/// it and must see the same lines: the cast-less proc detector, and the charm/CC/pet-buff ownership
/// model, whose only honest owner signal is the exclusivity of `You begin casting <Spell>.`
fn ingest_cast(st: &mut EngineState, ev: &Event) -> bool {
    match ev.kind_of() {
        Kind::CastBegin => {
            if let Some(spell) = ev.str(Key::Spell) {
                st.recent_casts.note(spell, ev.ts());
                st.charm.note_cast_begin(spell, ev.ts());
            }
            // The third reader of the same exclusivity. A pet summon is knowable from this line and
            // only from this line — the summon itself prints nothing attributable — so a summon with
            // no bind behind it is the one moment the meter can honestly say it is about to miss a
            // pet. Live only: a replayed moment must not be dressed up as the present.
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
                // The same for the nudge: a summon that never resolved summoned nothing. Ungated,
                // because an arm can only exist if something armed it live.
                if is_pet_summon_spell(spell) {
                    st.pet_nudge.note_cast_failed();
                }
            }
            true
        }
        Kind::OtherCastBegin => {
            // The only sentence in this log that says who ELSE is casting what, and therefore the
            // only thing that can name the owner of a caster-less `<mob> has been charmed.`
            // broadcast.
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
        // `You regain your concentration and continue your casting.` — the interrupted cast is back
        // on and will land, so give it back its claim with its ORIGINAL cast ts. Deliberately does
        // not re-arm the charm/CC model: that model's evidence rules are a separate question.
        Kind::CastResumed => {
            st.recent_casts.resume();
            true
        }
        _ => false,
    }
}

/// The character's standing choices — stance, invocation, and the active special attack.
///
/// Its own family because none of the three is an event in a fight: they are what the character has
/// DECIDED to do, persisting across pulls and zones until the game prints a different decision.
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
            // `You will now use Dragon Punch instead of Eagle Strike while attacking.` — the one
            // line that names the special behind an otherwise anonymous `You strike …`. It opens
            // nothing, closes nothing and moves no total; it changes what a later swing is CALLED.
            if let Some(skill) = ev.str(Key::Skill).map(str::to_string) {
                let lane = st.specials.note(&skill);
                // A special outside the verified lane table is still seen and still logged: the line
                // was read and deliberately not acted on.
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

/// coats · procs · dispel landings · Quick Buff · your own death. Everything here is an annotation:
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
            // The pet bind runs FIRST so the three gates below see a world model that already knows
            // whose the buffed entity is. Four disjoint gates over one event, none consuming
            // another's lines: this one binds, the dispel family names a lane on a mob, the
            // proc-buff catalog opens a self-buff span, and the self-landing registry counts a
            // firing.
            if target != "self" {
                bind_pet_buff_landing(st, ev);
            }
            route_dispel_landing(st, ev.ts(), &target, &names);
            route_proc_buff_apply(st, ev.ts(), &target, &names);
            route_self_landing_proc(st, ev.ts(), &target, &names);
        }
        // The rare printed end of a tracked proc buff — the only path that can close a buff span
        // `observed`. It reads `arr_str`, not `candidate_names`: a `buffApply` carries objects
        // because the buffs module needs the duration, while a `buffWearOff` carries plain STRINGS.
        // Reading the wrong one silently answers an empty list, and then this gate never fires.
        Kind::BuffWearOff => {
            let names: Vec<String> = ev
                .arr_str(Key::Candidates)
                .iter()
                .map(|s| s.to_string())
                .collect();
            route_proc_buff_wear_off(st, ev.ts(), &names);
        }
        // The Quick Buff burst: this AA re-applies every memorized buff and prints their LANDINGS
        // only, with no cast line for any of them, so without this stamp each landing reads as a
        // cast-less proc. The activation is the cast evidence, in a different shape.
        Kind::AaActivate => {
            if id_key_ref(ev.str(Key::Name).unwrap_or_default()) == QUICK_BUFF_AA {
                st.quick_buff_ts = ev.ts();
            }
        }
        Kind::PlayerDeath => {
            // Blade coats die with you. The game prints no dry line when it happens: a coat blocked
            // as already-applied before a death lands cleanly after one, and nothing said why.
            // The coat clear runs BEFORE the censor so the spans close through `clear_coats`, which
            // — unlike a bare censor — also stamps the window transition. That stamp discards the
            // boundary minute from the Tier-B purity gate, and a minute in which the player died and
            // four coats ended is the last minute that should be believed clean.
            clear_coats(st, ev.ts(), CoatClearReason::Death);
            st.state_timeline.censor_all(ev.ts());
        }
        _ => {}
    }
}

/// The third pet-binding signal, and the only one that costs the player nothing —
/// `You begin casting Burnout.` … `<Name> goes berserk.`
///
/// 40 spells in the DB are `targetType: Pet` and the game will not let one land on anything but your
/// own pet, while `You begin casting <Spell>.` is printed for the player and nobody else. The pair —
/// own cast, then a landing that resolves it — names your pet as surely as a tell does, and it fires
/// when a summoner buffs the pet they just summoned rather than when they first order it. That
/// matters because single-pet succession is triggered by the successor's own claim, and an UPGRADED
/// summon produces none: both other binding lines require the player to talk to the pet.
///
/// The message is not the gate; the armed own cast is. `goes berserk.` resolves to Burnout / Fury /
/// Rage / Voice of the Berserker and only Burnout is a pet spell, so the candidate list must contain
/// the spell we are mid-cast of.
///
/// Silent precondition: the DB must be able to name the spell. A candidate list comes from the
/// cast-on-other suffix table, so a `targetType: Pet` spell whose scraped third-person message
/// carries some other subject token is in no table and can never be a candidate for its own landing.
/// If a report says a pet stopped being attributed, check the candidate list first.
fn bind_pet_buff_landing(st: &mut EngineState, ev: &Event) {
    let target = ev.str(Key::Target).unwrap_or_default().to_string();
    // The parser emits `target: 'self'` for the msgCastOnYou form; only a named landing can bind.
    if target == "self" || target.is_empty() {
        return;
    }
    let names = ev.candidate_names(Key::Candidates);
    if !st.charm.pet_buff_landing(&names, ev.ts()) {
        return;
    }
    // A landing on YOURSELF is a self-buff the DB mislabels, never a pet: the third-person form can
    // still name you when another player's buff lands on you in the same second. The
    // `unwrap_or_default` is load-bearing: with no player key known yet the comparison is against
    // the empty string, which a whitespace-only target's key also is.
    if id_key_ref(&target).as_ref() == st.player_key.as_deref().unwrap_or_default() {
        return;
    }
    bind_pet_claim(st, &target, ev.ts(), "petBuff");
}
