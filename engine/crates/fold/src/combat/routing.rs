//! ATTRIBUTION + ROUTING — where a parsed combat line lands (`src/main/combat/routing.ts`, plus
//! `otherRouting.ts` and `allyRouting.ts`, which are the two doors it offers a line it drops).
//!
//! `classify()` is the pure attribution decision (you / your pet / a group-mate / incoming / not our
//! fight); the `route_*` functions fold the line into the current encounter and the zone aggregate
//! under that decision, refresh the presence axis, and engage what needs engaging. Nothing here
//! decides when a fight OPENS or CLOSES — that is `lifecycle.rs`.
//!
//! ── THE LADDER IS PORTED WHOLE, AND THAT IS THE ONE PLACE A PARTIAL PORT WOULD BE HARMFUL ──────
//!
//! Half a ladder mis-files a pet's damage, which mis-fills `engaged`, which mis-segments the fight.
//! So the three doors are all here: `classify` decides YOUR rows, `route_other_*` records every
//! other combatant the log names, and `route_ally_pet_*` credits somebody else's charm pet. The
//! order is stated and load-bearing — `classify` first, then the record-everything ladder, then the
//! ally model — because each one only ever sees what the one before it declined.
//!
//! ── `classify()` IS NO LONGER THE ADMISSION GATE ───────────────────────────────────────────────
//!
//! Recording used to END here: the last rule was "attacker not you/pet, target not you → ignore", so
//! a name the roster had not admitted fell through it, an empty roster snapshot recorded nobody, and
//! no scope could show what nothing had recorded (2,224 parsed events fell through it in one slice
//! while the reporter's group-mate appeared in ZERO fights). The `Ignore` verdict is now an OFFER
//! rather than a disposal.
//!
//! AND `classify` ITSELF IS UNTOUCHED BY EITHER WIDENING. It is pure, it is called three times per
//! line (the damage, miss and resist probes), and its four membership sets are the ones that decide
//! YOUR rows; a fold that also asked "…and if not, whose is it?" would be paying for the answer
//! three times and mixing two questions in one place. So the roster's remaining jobs are the
//! ENGAGEMENT LICENCE and the Group scope, neither of which can move a number — which is what makes
//! "a wrong roster can hide a row but never corrupt a number" true rather than aspirational.
//!
//! ── WHAT AN `'other'` OR ALLY-PET ROW MAY NOT DO ───────────────────────────────────────────────
//!
//! Both are AGGREGATE-ONLY. Neither opens an encounter, extends one, engages a hostile, refreshes
//! presence, resolves a target into a world instance or bumps the target ledger a fight is NAMED
//! after. Every one of those omissions is the same cautionary tale refusing to come back through a
//! wider door: one friendly in `engaged` merged three of the owner's pulls into a single 214-second
//! segment.

use crate::combat::aggregate::{Agg, DamageEvent, MissFold, MissType, SourceKind, SourceRef};
use crate::combat::ally::AllyBind;
use crate::combat::encounter::{TimelineRaw, ACTIVE_MS};
use crate::combat::healing::{HealInput, HealSourceKind};
use crate::combat::lifecycle::ensure_encounter;
use crate::combat::procdetect::base_lane_name;
use crate::combat::state::EngineState;
use crate::combat::world::Resolved;
use eqlog::names::id_key_ref;
use std::borrow::Cow;

/// How a damage event `A → B` is attributed given the pet-name set.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Attribution {
    OutYou,
    OutPet {
        pet_key: String,
        pet_name: String,
        ambiguous: bool,
    },
    OutMember,
    Incoming,
    Ignore,
}

/// The three outgoing row kinds, as the damage / miss / resist paths name them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OutKind {
    You,
    Pet,
    Member,
}

impl Attribution {
    fn out_kind(&self) -> OutKind {
        match self {
            Attribution::OutYou => OutKind::You,
            Attribution::OutMember => OutKind::Member,
            _ => OutKind::Pet,
        }
    }
}

/// THE ATTRIBUTION DECISION. Everything the combat model books passes through here.
///
/// The rules, decided with the owner:
///   You → pet-name : ALWAYS outgoing to a hostile twin (never dropped as friendly fire).
///   pet-name → You : ALWAYS incoming.
///   pet-name → same-name (A == B) : pet outgoing, but AMBIGUOUS — it could be your pet hitting a
///     hostile twin, or a hostile twin hitting your pet. Attribute to the pet and flag it.
///   pet-name → a KNOWN PLAYER or a group-mate : IGNORE. A pet swinging at a player is not our
///     fight: either the "pet" was never ours, or this is a duel. Booking it would credit us the
///     damage AND enter that player into `engaged` as a hostile, which is exactly how a stranger
///     became the owner's enemy and kept three of his pulls from ever closing.
///   member → other : OUTGOING, as that member's own row.
///   MEMBER → You is IGNORED, not incoming — the incoming meter answers "what is hitting me", which
///     in this game means hostiles, and filing a group-mate's stray damage-shield tick there would
///     put an ally in the enemy list.
///   ANY mob → member is IGNORED, unchanged: incoming-on-members is a real feature and explicitly
///     out of scope — sources first, one wave at a time.
pub fn classify(st: &EngineState, attacker: &str, target: &str) -> Attribution {
    // BORROWED (JOS-506). This function is the busiest identity question in the fold — the damage,
    // miss and resist probes each ask it of every line — and every answer but the `OutPet` one is
    // dropped after a comparison or a set lookup. Only the branch that RETAINS the key pays for it.
    let a_key = id_key_ref(attacker);
    let b_key = id_key_ref(target);
    if a_key == "you" {
        // You → anything (including a pet name, which is then a hostile twin) is outgoing.
        return if b_key == "you" {
            Attribution::Ignore
        } else {
            Attribution::OutYou
        };
    }
    let b_you = b_key == "you";
    if st.pet_names.contains(a_key.as_ref()) {
        if b_you {
            return Attribution::Incoming; // pet-name → You is always incoming
        }
        if st.known_players.contains(b_key.as_ref()) || st.roster.admitted.contains(b_key.as_ref())
        {
            return Attribution::Ignore; // …but never AT a player, nor at a group-mate
        }
        let ambiguous = a_key == b_key; // same-name twin: cannot tell pet from twin
        return Attribution::OutPet {
            pet_key: a_key.into_owned(),
            pet_name: attacker.to_string(),
            ambiguous,
        };
    }
    // A GROUP MEMBER is the attacker. Checked BEFORE the incoming rule so a member's hit ON you is
    // dropped rather than filed as an enemy's; checked AFTER the pet rules so a charmed mob that
    // shares a member's name still attributes as your pet.
    if st.roster.admitted.contains(a_key.as_ref()) {
        if b_you || st.pet_names.contains(b_key.as_ref()) {
            return Attribution::Ignore;
        }
        if st.known_players.contains(b_key.as_ref()) || st.roster.admitted.contains(b_key.as_ref())
        {
            return Attribution::Ignore;
        }
        return Attribution::OutMember;
    }
    if b_you {
        return Attribution::Incoming;
    }
    // Attacker not one of ours, target not you. THIS IS THE LINE THE METER USED TO DROP ON THE
    // FLOOR, and `Ignore` is no longer where it ends.
    Attribution::Ignore
}

/// THE METER ROW for a combatant other than you — a group member or anyone else the log named.
///
/// ONE ID NAMESPACE FOR BOTH, and that is the point rather than an economy: the person you fought
/// beside for ten minutes and then invited into your group must be ONE bar, not one per provenance.
/// `Agg::reid` upgrades the stored kind when the roster catches up; the id never moves, so no total
/// splits.
///
/// KEYED BY NAME, NOT BY INSTANCE — the pet rule deliberately inverted: resolving MINTS a world
/// instance, and a player-shaped instance can be engaged, retired, aged out and counted as hostile
/// presence. The canonical name gives one stable row and touches the world model not at all.
///
/// The NAME prefers the roster's spelling (the one a user has seen in the popover), falls back to the
/// recorded spelling, then to the line's own — world-model law 2 in ladder form.
fn other_source(st: &EngineState, attacker: &str, key: &str, member: bool) -> SourceRef {
    let name = st
        .roster
        .names
        .get(key)
        .map(String::as_str)
        .or_else(|| st.others.name_of(key))
        .unwrap_or(attacker)
        .to_string();
    SourceRef {
        id: format!("member:{key}"),
        name,
        kind: if member {
            SourceKind::Member
        } else {
            SourceKind::Other
        },
    }
}

/// The outgoing meter ROW for an attributed you/pet/member action — the triple the damage, miss and
/// resist paths all need and all resolve identically. A pet is resolved to its pet INSTANCE so twin
/// pets stay distinct.
fn out_source(st: &mut EngineState, attacker: &str, kind: OutKind, ts: i64) -> SourceRef {
    match kind {
        OutKind::You => SourceRef {
            id: "you".to_string(),
            name: "You".to_string(),
            kind: SourceKind::You,
        },
        OutKind::Member => other_source(st, attacker, &id_key_ref(attacker), true),
        OutKind::Pet => {
            let inst = match st.world.pet_instance(attacker) {
                Some(i) => i,
                None => st.resolve(attacker, ts, true),
            };
            SourceRef {
                id: format!("pet:{}", inst.instance_id),
                name: inst.label,
                kind: SourceKind::Pet,
            }
        }
    }
}

/// Engage an instance as a HOSTILE of this encounter — THE ONE DOOR into `engaged`, and therefore
/// the one thing that can veto closure.
///
/// A KNOWN PLAYER never walks through it: `engaged` membership is what closure polls for "is
/// anything still alive in this fight", so a player — who does not die on our schedule and whose
/// every heal used to refresh his own presence — could hold a pull open indefinitely.
///
/// A GROUP MEMBER IS REFUSED FOR EXACTLY THAT REASON, and the rule is load-bearing in a way the
/// known-player one was not: admitting members means the engine now routes damage whose TARGET can
/// be another friendly, and `You → <member>` reaches this function on the ordinary outgoing path. A
/// member's target engages; the member never does.
fn engage_hostile(st: &mut EngineState, inst: &Resolved, ts: i64) {
    if st.is_known_player(&inst.name_key) || st.is_member(&inst.name_key) {
        return;
    }
    let Some(enc) = st.current.as_mut() else {
        return;
    };
    enc.engaged.insert(inst.instance_id.clone());
    enc.engaged_seen.insert(inst.instance_id.clone(), ts);
}

/// RESOLVE THE DEFENDER'S LABEL, AND NOTE THAT THE CALL IS NOT A PURE READ. Every damage-free path
/// over there ends with `const tgtName = enc ? st.defenderLabel(enc, target, ts) : target`, and the
/// label feeds the timeline instant and the processing line. The CALL would not be optional even if
/// nothing read the result: `defenderLabel` resolves through the world model, which retires the name's
/// stale instances and ADOPTS the sighting's casing as the instance display, and that display is what
/// the NEXT `bump_target` freezes into a fight's name. `state.rs` carries the measurement.
///
/// The freshness gate is the caller's `enc ?`, reproduced here as the one condition — WITHOUT a fresh
/// encounter the raw name stands and the world model is not touched at all.
fn note_defender(st: &mut EngineState, target: &str, ts: i64) -> String {
    if st.fresh_encounter_id(ts) {
        st.defender_label(target, ts)
    } else {
        target.to_string()
    }
}

/// Push one instant onto the FRESH encounter's ring, or nothing at all when no fight is open. The
/// gate is the caller's, mirrored here so no path can push into a stale fight.
fn push_fresh_timeline(st: &mut EngineState, ts: i64, rec: TimelineRaw) {
    if let Some(enc) = st.fresh_encounter(ts) {
        EngineState::push_timeline(enc, rec);
    }
}

/// Fold into the open encounter's aggregate and the zone aggregate alike — the pair every routing
/// path writes, and never one without the other.
fn both(st: &mut EngineState, ts: i64, fresh_only: bool, f: impl Fn(&mut Agg)) {
    if fresh_only {
        if let Some(enc) = st.fresh_encounter(ts) {
            f(&mut enc.agg);
        }
    } else if let Some(enc) = st.current.as_mut() {
        f(&mut enc.agg);
    }
    f(&mut st.zone_agg);
}

// ── DAMAGE ────────────────────────────────────────────────────────────────────────────────────

/// Fold one landed damage line, and REPORT THE VERDICT IT REACHED. `None` means the line was
/// ignored before any verdict was needed, which is exactly the case the analytics fold returns early
/// on over there.
pub fn route(st: &mut EngineState, ev: &DamageEvent<'_>) -> Option<Attribution> {
    if ev.amount <= 0 {
        return None;
    }
    let at = classify(st, ev.attacker, ev.target);
    // "YOU HIT IT", FILED ONCE, off the verdict `classify` just reached. Here rather than inside
    // `classify` because that function is PURE and must stay so — it is called by the miss and
    // resist probes as well, and a pure decision that also mutated state would count one swing three
    // times.
    if at == Attribution::OutYou {
        st.note_struck(&id_key_ref(ev.target));
    }
    // BEFORE the ignore gate, and before the outgoing/incoming split: a bound ally pet swinging at
    // YOU classifies as `Incoming` rather than `Ignore`, and that line is the strongest soft-hostile
    // proof there is. Reading the evidence off every line is what keeps the two cases from needing
    // two rules.
    note_ally_pet_evidence(st, ev.attacker, ev.target, ev.ts);
    // …and the same line, read for the other model: something that LANDED DAMAGE ON YOU is a
    // hostile, whatever its name looks like.
    if at == Attribution::Incoming {
        note_other_hostile(st, ev.attacker);
    }
    if at == Attribution::Ignore {
        // THE LINE THE METER USED TO DROP, offered to the two models that read it — the
        // record-everything ladder first, then a THIRD PARTY's charm pet. Both book aggregate-only.
        // Everything neither claims stays dropped exactly as it was.
        if !route_other_damage(st, ev) {
            route_ally_pet_damage(st, ev);
        }
        return Some(at);
    }

    // Twin evidence: You→pet-name, or same-name→same-name, proves a hostile twin co-exists with the
    // pet; ensure the world model has a second instance so the two resolve to distinct identities.
    if at == Attribution::OutYou && st.pet_names.contains(id_key_ref(ev.target).as_ref()) {
        st.world.note_twin_evidence(ev.target, ev.ts);
        st.drain_retirements();
    }
    if matches!(
        &at,
        Attribution::OutPet {
            ambiguous: true,
            ..
        }
    ) {
        st.world.note_twin_evidence(ev.target, ev.ts);
        st.drain_retirements();
    }

    ensure_encounter(st, ev.ts);
    {
        let enc = st.current.as_mut().expect("just ensured");
        // Active-time accrual: add the gap since the previous attributed hit, capped at `ACTIVE_MS`
        // (the standard meter convention — a long lull counts as at most one "active" tick, not the
        // whole idle stretch). The first hit adds 0.
        if let Some(prev) = enc.prev_damage_ts {
            enc.active_ms += (ev.ts - prev).clamp(0, ACTIVE_MS);
        }
        enc.prev_damage_ts = Some(ev.ts);
        enc.last_ts = ev.ts;
    }
    st.last_activity_ts = ev.ts;
    // Zone-session timing: first/last attributed damage in this stay, for the summary's timing.
    if st.zone_start_ts == 0 {
        st.zone_start_ts = ev.ts;
    }
    st.zone_last_ts = ev.ts;

    if at == Attribution::Incoming {
        route_incoming_damage(st, ev);
    } else {
        route_outgoing_damage(st, ev, &at);
    }
    Some(at)
}

/// A hostile (or the pet) hit YOU. Resolve the attacker to an instance so twins are distinct in the
/// incoming list.
fn route_incoming_damage(st: &mut EngineState, ev: &DamageEvent<'_>) {
    let att = st.resolve(ev.attacker, ev.ts, false);
    let (id, name) = (att.instance_id.clone(), att.label.clone());
    both(st, ev.ts, false, |agg| agg.add_inc(&id, &name, ev));
    engage_hostile(st, &att, ev.ts);
    // Timeline: an incoming instant lanes under the ATTACKER's skill (its own row).
    if let Some(enc) = st.current.as_mut() {
        EngineState::push_timeline(
            enc,
            TimelineRaw {
                ts: ev.ts,
                lane: ev.skill.to_string(),
                category: ev.category.to_string(),
                amount: ev.amount,
                crit: ev.crit,
                modifiers: own_mods(ev.modifiers),
                kind: "enemy",
                outcome: None,
                detail: None,
                target: None,
            },
        );
    }
    st.log(
        ev.ts,
        ev.dtype,
        "enemy",
        format!(
            "{name} → You  {}{}  {}",
            ev.amount,
            if ev.crit { "*" } else { "" },
            ev.skill
        ),
    );
}

/// You, your pet or a group member landed a hit.
fn route_outgoing_damage(st: &mut EngineState, ev: &DamageEvent<'_>, at: &Attribution) {
    let src = out_source(st, ev.attacker, at.out_kind(), ev.ts);
    let mut ambiguous = false;
    if let Attribution::OutPet {
        pet_key,
        ambiguous: amb,
        ..
    } = at
    {
        ambiguous = *amb;
        // The pet is trading blows with its target — record that engagement for death case (b).
        st.world
            .note_pet_engagement(ev.attacker, &id_key_ref(ev.target));
        // A pet LANDING a hit is pet-shaped evidence (see the miss and resist twins).
        st.charm.note_pet_evidence(pet_key);
    }
    // NOTE WHAT A MEMBER'S HIT DELIBERATELY DOES NOT DO: it records no pet engagement (a member is
    // not a pet and their kills are not ours to disambiguate) and no charm evidence. The one thing
    // it does beyond its own row is ENGAGE ITS TARGET — which is the whole point, because the mob
    // your group-mate is fighting is the mob you are fighting.

    // POISON-TYPED DAMAGE: the game states the damage TYPE on every typed spell line ("… for 53 points
    // of POISON damage by Asp Venom Strike."), so a poison lane is a fact the log PRINTED, not a
    // name-matched guess. Outgoing only — a mob's poison DoT on you is not a proc of ours — and
    // additive, a second index over damage already counted, so no total moves.
    if ev.dclass == Some("poison") {
        // `base_lane_name`: the LEDGER is about the venom, not the meter row. A cast-less firing's
        // meter lane carries the origin marker and this counter must not inherit it — every other proc
        // counter is keyed on the spell for the same reason.
        let venom = base_lane_name(&ev.skill).to_string();
        both(st, ev.ts, false, |agg| {
            agg.procs.add_poison_damage(&venom, ev.amount)
        });
    }
    // Resolve the target to an instance. For a same-name ambiguous pet hit the target is the HOSTILE
    // twin (`prefer_charmed = false` picks the hostile instance).
    let tgt = st.resolve(ev.target, ev.ts, false);
    let (tid, tname) = (tgt.instance_id.clone(), tgt.label.clone());
    both(st, ev.ts, false, |agg| {
        agg.add_out(&src, ev, ambiguous);
        agg.bump_target(&tid, &tname, ev.amount);
    });
    engage_hostile(st, &tgt, ev.ts);
    // LIVE-name tracking: the current fight is named after whatever you are presently swinging at.
    // Finalize switches to the largest target; until then this drives the live label.
    if let Some(enc) = st.current.as_mut() {
        enc.last_out_target = Some(tname.clone());
        // Timeline: an outgoing instant lanes under the skill/spell name. `target` carries the
        // INSTANCE-RESOLVED defender label — the same value `bump_target` aggregates under, so twins
        // stay distinct — because it drives the tooltip AND the per-mob breakdown, which needs
        // per-event defenders to answer "what did I land on THIS mob".
        EngineState::push_timeline(
            enc,
            TimelineRaw {
                ts: ev.ts,
                lane: ev.skill.to_string(),
                category: ev.category.to_string(),
                amount: ev.amount,
                crit: ev.crit,
                modifiers: own_mods(ev.modifiers),
                kind: src.kind.as_str(),
                outcome: None,
                detail: None,
                target: Some(tname.clone()),
            },
        );
    }
    // THE AMBIGUOUS MARK IS `~` AND IT REPLACES THE CRIT STAR rather than joining it: an ambiguous
    // hit is one the engine could not attribute cleanly, and saying so outranks saying it crit.
    let cat = if ambiguous { "ambiguous" } else { ev.dtype };
    let mark = if ambiguous {
        "~"
    } else if ev.crit {
        "*"
    } else {
        ""
    };
    st.log(
        ev.ts,
        cat,
        src.kind.as_str(),
        format!("{} → {tname}  {}{mark}  {}", src.name, ev.amount, ev.skill),
    );
}

// ── MISS ──────────────────────────────────────────────────────────────────────────────────────

/// THE AVOIDED SWING as the aggregates fold it. `skill` stays `Melee` for every miss — that is the
/// shipped accuracy lane and it does not move — while `verb`/`lane_skill`/`modifiers`/`target` are
/// the additive, amount-free inputs to the round grouper and the modifier tallies. The lane label
/// goes through the SAME two steps a landed swing does: the parser's melee-skill answer, then the
/// log's own statement of which special is live in that verb lane — gated on the attacker being You,
/// because the state line is first-person-only.
pub struct MissLine {
    pub ts: i64,
    pub attacker: String,
    pub target: String,
    pub mtype: MissType,
    pub verb: Option<String>,
    /// The parser's own `meleeSkill(verb)` answer, carried on the event.
    pub verb_skill: Option<String>,
    pub modifiers: Vec<String>,
}

fn miss_fold(st: &EngineState, ev: &MissLine, is_you: bool) -> MissFold {
    let lane_skill = match &ev.verb {
        None => None,
        Some(verb) => {
            let special = if is_you {
                st.specials.lane_skill(Some(verb)).map(str::to_string)
            } else {
                None
            };
            special.or_else(|| ev.verb_skill.clone())
        }
    };
    MissFold {
        mtype: ev.mtype,
        skill: "Melee".to_string(),
        verb: ev.verb.clone(),
        lane_skill,
        modifiers: ev.modifiers.clone(),
        target: ev.target.clone(),
        ts: ev.ts,
    }
}

/// Consume a miss (avoided swing) with the same attribution rules as damage. A zero-amount damage
/// probe is synthesized so `classify` is asked exactly the question it was asked for the landed
/// twin; a melee skill name is not in the miss line, so avoided swings bucket under `Melee`.
pub fn route_miss(st: &mut EngineState, ev: &MissLine) {
    let at = classify(st, &ev.attacker, &ev.target);
    // The same two judgements the damage path reads, off the same lines, for the same reason: an
    // ally pet's swing at a friendly proves the break whether or not it connected.
    note_ally_pet_evidence(st, &ev.attacker, &ev.target, ev.ts);
    if at == Attribution::Ignore {
        // The same two offers the damage path makes, in the same order. NO hostile-evidence read on
        // the incoming side here: the "it hit YOU" rung was measured on LANDED damage, and a swing
        // that connected with nothing is not what was measured.
        let fold = miss_fold(st, ev, false);
        if !route_other_miss(st, ev, &fold) {
            route_ally_pet_miss(st, ev, &fold);
        }
        return;
    }
    let fold = miss_fold(st, ev, at == Attribution::OutYou);
    // PRESENCE: a swing exchanged with an already-engaged mob proves it is still in the fight even
    // though nothing landed — the mob on an incoming miss, the mob we whiffed at on an outgoing one.
    // Liveness only; no damage timing moves.
    let who = if at == Attribution::Incoming {
        ev.attacker.clone()
    } else {
        ev.target.clone()
    };
    st.note_presence(&who, ev.ts);

    if at == Attribution::Incoming {
        let att = st.resolve(&ev.attacker, ev.ts, false);
        let (id, name) = (att.instance_id, att.label);
        both(st, ev.ts, true, |agg| agg.add_inc_miss(&id, &name, &fold));
        // ABSORPTION: an incoming swing absorbed by YOUR rune is also a mitigation instant, and it
        // belongs to the healing ledger. `Incoming` means the defender is YOU (a swing at your pet
        // classifies as `Ignore`), so this can never pick up a pet's or a mob's own rune. It is the
        // SECOND source for the same line family the parser's `absorbSwing` mitigation event covers:
        // whichever regex claims the line, exactly ONE event is emitted, so the two paths can never
        // double-count.
        if ev.mtype == MissType::Absorb {
            both(st, ev.ts, true, |agg| agg.heal.add_absorbed_swing());
        }
        st.log(
            ev.ts,
            "miss",
            "enemy",
            format!("{name} ✕ You ({})", ev.mtype.as_str()),
        );
        return;
    }
    route_outgoing_miss(st, ev, &fold, at.out_kind());
}

/// A miss YOU, your pet or a group member swung.
fn route_outgoing_miss(st: &mut EngineState, ev: &MissLine, fold: &MissFold, kind: OutKind) {
    let src = out_source(st, &ev.attacker, kind, ev.ts);
    // A pet WHIFFING is every bit as much proof it is fighting for us as a landed hit. A MEMBER's
    // whiff proves nothing about charm — they are a player, bound by a group line, not by evidence.
    if kind == OutKind::Pet {
        st.charm.note_pet_evidence(&id_key_ref(&ev.attacker));
    }
    both(st, ev.ts, true, |agg| agg.add_out_miss(&src, fold));
    // Timeline: a miss tick lanes under `Melee` (a hollow mark in the renderer). The defender goes
    // through `defender_label` so it matches the INSTANCE label the damage path writes — a raw name
    // made every whiff at a twin pile onto a phantom bare row.
    let tgt_name = note_defender(st, &ev.target, ev.ts);
    push_fresh_timeline(
        st,
        ev.ts,
        TimelineRaw {
            ts: ev.ts,
            lane: "Melee".to_string(),
            category: "melee".to_string(),
            amount: 0,
            crit: false,
            modifiers: Vec::new(),
            kind: src.kind.as_str(),
            outcome: Some("miss"),
            detail: Some(ev.mtype.as_str().to_string()),
            target: Some(tgt_name.clone()),
        },
    );
    st.log(
        ev.ts,
        "miss",
        src.kind.as_str(),
        format!("{} ✕ {tgt_name} ({})", src.name, ev.mtype.as_str()),
    );
}

// ── RESIST ────────────────────────────────────────────────────────────────────────────────────

pub struct ResistLine {
    pub ts: i64,
    pub caster: String,
    pub target: String,
    pub spell: String,
    pub incoming: bool,
}

/// Whose resisted cast this was, or `None` when it is nobody's business of ours. Separated out
/// because this path never calls `classify` — a resist names a CASTER and a TARGET, not an attacker
/// and a defender — so the same three-way widening has to be stated by hand.
fn resist_caster(st: &EngineState, caster_key: &str) -> Option<OutKind> {
    if caster_key == "you" {
        return Some(OutKind::You);
    }
    if st.pet_names.contains(caster_key) {
        return Some(OutKind::Pet);
    }
    st.is_admitted_member(caster_key).then_some(OutKind::Member)
}

/// Consume a spell RESIST — the caster-side analogue of a miss.
///
/// Resisted detrimental spells are direct spells in the taxonomy, so ALL resists categorize as
/// `spell` (the detrimental axis) and sort into the spell lanes. They carry no amount, so category
/// totals are unaffected; the LANE is the display spell name, so a resist tick lands in the same
/// lane as landed casts of that spell.
pub fn route_resist(st: &mut EngineState, ev: &ResistLine) {
    const CATEGORY: &str = "spell";
    // PRESENCE: a resist names a live caster and a live resister. Refresh whichever side is a
    // HOSTILE we are already engaged with — the caster on an incoming resist (the mob just cast at
    // us), the target on our own resisted cast (the mob is standing there shrugging it off).
    // `note_presence` ignores anything not engaged, so the you/pet side is a no-op, as is the
    // mob-vs-mob shape below UNLESS the resisting mob happens to be one of ours.
    let who = if ev.incoming {
        ev.caster.clone()
    } else {
        ev.target.clone()
    };
    st.note_presence(&who, ev.ts);

    if ev.incoming {
        // You resisted a mob's spell — attribute to the mob (the incoming caster).
        let att = st.resolve(&ev.caster, ev.ts, false);
        let (id, name) = (att.instance_id, att.label);
        let spell = ev.spell.clone();
        both(st, ev.ts, true, |agg| {
            agg.add_inc_resist(&id, &name, &spell, CATEGORY)
        });
        push_fresh_timeline(
            st,
            ev.ts,
            TimelineRaw {
                ts: ev.ts,
                lane: ev.spell.clone(),
                category: CATEGORY.to_string(),
                amount: 0,
                crit: false,
                modifiers: Vec::new(),
                kind: "enemy",
                outcome: Some("resist"),
                detail: Some("resisted".to_string()),
                target: Some("You".to_string()),
            },
        );
        st.log(
            ev.ts,
            "resist",
            "info",
            format!("You resisted {name}'s {}", ev.spell),
        );
        return;
    }

    let Some(kind) = resist_caster(st, &id_key_ref(&ev.caster)) else {
        // A resisted cast by a combatant the log named — the same widening the damage path got,
        // asked of the CASTER because a resist has no attacker/defender pair to classify.
        if route_other_resist(st, ev, CATEGORY) {
            return;
        }
        // A hostile mob's spell resisted by another mob — out of scope for the meter, and SAID SO:
        // a line the engine deliberately refused is exactly what the `dropped` role is for.
        st.log(
            ev.ts,
            "resist",
            "dropped",
            format!("{}'s {} resisted by {}", ev.caster, ev.spell, ev.target),
        );
        return;
    };
    let src = out_source(st, &ev.caster, kind, ev.ts);
    // Same corroboration as the damage/miss twins: a pet whose spell got resisted was casting for
    // us. A member's resisted cast is not charm evidence.
    if kind == OutKind::Pet {
        st.charm.note_pet_evidence(&id_key_ref(&ev.caster));
    }
    let spell = ev.spell.clone();
    both(st, ev.ts, true, |agg| {
        agg.add_out_resist(&src, &spell, CATEGORY)
    });
    // Same instance resolution as the miss and damage paths — a resisted cast at a twin must land on
    // that twin's per-mob row, not a bare-named ghost.
    let tgt_name = note_defender(st, &ev.target, ev.ts);
    push_fresh_timeline(
        st,
        ev.ts,
        TimelineRaw {
            ts: ev.ts,
            lane: ev.spell.clone(),
            category: CATEGORY.to_string(),
            amount: 0,
            crit: false,
            modifiers: Vec::new(),
            kind: src.kind.as_str(),
            outcome: Some("resist"),
            detail: Some("resisted".to_string()),
            target: Some(tgt_name.clone()),
        },
    );
    st.log(
        ev.ts,
        "resist",
        src.kind.as_str(),
        format!("{}'s {} resisted by {tgt_name}", src.name, ev.spell),
    );
}

// ── HEAL ──────────────────────────────────────────────────────────────────────────────────────

pub struct HealLine {
    pub ts: i64,
    pub target: String,
    pub healer: Option<String>,
    pub amount: i64,
    /// Raw/pre-overheal amount, present only on the `for N (M) hit points` lines.
    pub raw_amount: Option<i64>,
    pub spell: Option<String>,
    pub crit: bool,
}

impl HealLine {
    fn input(&self) -> HealInput {
        HealInput {
            amount: self.amount,
            raw_amount: self.raw_amount,
            spell: self.spell.clone(),
            crit: self.crit,
        }
    }
}

/// Consume a heal. Three things matter for combat stats: a heal on an engaged HOSTILE is "enemy
/// healing" (it undoes our damage); a heal on You or one of your pets is incoming healing; and
/// either also folds into the meter-grade HEALING ledger — which is unported, so only the first two
/// are written here. Other heals (party members healing each other, unrelated NPCs) are ignored for
/// aggregation: the log gives no faction for an arbitrary name.
///
/// ZERO-EFFECTIVE heals (`… for 0 (2) hit points …`) are the overheal evidence and belong to that
/// ledger; the `enemy_heal` / `inc_heal` maps keep their original `amount <= 0` gate so their totals
/// AND their healer lists stay byte-identical.
pub fn route_heal(st: &mut EngineState, ev: &HealLine) {
    if ev.amount < 0 {
        return;
    }
    let t_key = id_key_ref(&ev.target);
    let healer_key = ev.healer.as_deref().map(id_key_ref);
    let is_you_tgt = t_key == "you";
    let is_pet_tgt = !is_you_tgt && st.pet_names.contains(t_key.as_ref());

    st.learn_player_key(healer_key.as_deref(), &t_key, is_you_tgt, is_pet_tgt);
    let is_player_tgt = st.player_key.as_deref() == Some(t_key.as_ref());

    // WHAT ONE HEAL LINE PROVES ABOUT WHO IS WHO, read off the same line the meter is about to
    // aggregate. KNOWN-PLAYER evidence, ONE direction only: a heal LANDING ON THE OWNER names its
    // healer as a friendly player, because `<H> healed Primitive for N` cannot come from a mob.
    //
    // THE OTHER DIRECTION WAS TRIED AND MEASURED WRONG. "`You healed <X>` ⇒ X is a player" reads as
    // obvious and is false in this log: the owner keeps his PETS alive by name, so a full replay
    // filed 33 entities as players — `a sprited harpie`, `a fire giant warrior`, and every summoned
    // pet he had ever healed before its first tell. Because a "player" is never a hostile and never
    // a pet's target, that silently deleted 50k+ points of real pet damage, 14,464 of it from one
    // pet hitting another. The honest fix is not to make the claim at all.
    if (is_you_tgt || is_player_tgt) && healer_key.is_some() {
        st.note_player(healer_key.as_deref());
    }
    // PET evidence, the other way round: the owner healing something he is already treating as a pet
    // corroborates a charm bind that is still provisional.
    if healer_key.as_deref() == Some("you") && is_pet_tgt {
        st.charm.note_pet_evidence(&t_key);
    }

    if is_you_tgt || is_pet_tgt || is_player_tgt {
        add_friendly_heal(st, ev, healer_key.as_deref());
        return;
    }
    add_hostile_heal(st, ev, healer_key.as_deref());
}

/// Incoming heal to You (or the player by name) / your pet.
///
/// The `inc_heal` map keeps its original `amount <= 0` gate so its totals AND its healer lists stay
/// byte-identical; the LEDGER takes the zero-effective lines too, because `… for 0 (2) hit points …`
/// is the overheal evidence and belongs to the ledger that reports overheal.
fn add_friendly_heal(st: &mut EngineState, ev: &HealLine, healer_key: Option<&str>) {
    let hk = healer_key.unwrap_or("unknown").to_string();
    let healer_name = ev.healer.clone().unwrap_or_else(|| "Unknown".to_string());
    if ev.amount > 0 {
        both(st, ev.ts, true, |agg| {
            agg.add_inc_heal(&hk, &healer_name, ev.amount)
        });
    }
    // Healing ledger: ranked by HEALER. Row id `you` for self-heals keeps the healing meter's primary
    // row keyed the same way the damage meter's is.
    let kind = if hk == "you" {
        HealSourceKind::You
    } else if st.pet_names.contains(&hk) {
        HealSourceKind::Pet
    } else {
        HealSourceKind::Other
    };
    let id = if hk == "you" {
        "you".to_string()
    } else {
        format!("heal:{hk}")
    };
    let input = ev.input();
    both(st, ev.ts, true, |agg| {
        agg.heal.add_friendly(&id, &healer_name, kind, &input)
    });
}

/// Consume an ANNOUNCED-BUT-UNVALUED heal — `You mend your wounds and heal some damage.`
///
/// It reaches the healing ledger as a COUNT on its own lane and nothing else. Everything the valued
/// path does with an amount is SKIPPED rather than done with a zero: no `inc_heal` (the top-healers
/// list ranks by hit points and this line has none), no proc analytics (a 0-amount "Mend proc" is a
/// fabricated observation), no min/max/overheal.
///
/// NO WORLD-MODEL EVIDENCE IS READ OFF IT EITHER, unlike every other heal line: a heal names two
/// parties and one of them can be filed, but this sentence names NOBODY — not even you, grammatically
/// — so there is nothing to learn and nothing to get wrong.
pub fn route_heal_unstated(st: &mut EngineState, ts: i64, skill: &str) {
    let skill = skill.to_string();
    both(st, ts, true, |agg| agg.heal.add_unstated(&skill));
}

/// One absorption / mitigation line.
pub struct MitigationLine<'a> {
    pub ts: i64,
    /// `rune` · `absorbSwing` · `absorbDamageShield`.
    pub mtype: &'a str,
    pub amount: Option<i64>,
}

/// Consume an ABSORPTION / MITIGATION line — damage PREVENTED, not hit points restored, so it never
/// touches a DAMAGE total. It does reach the HEALING total: the rune counters are folded in as a row
/// classified `absorbed`, while the two count-only families carry no amount and so reach no total at
/// all.
///
/// These lines NEVER open, join or extend an encounter and never move the damage timeline — the same
/// rule miss and resist follow (law 8). A rune ticking while you stand around out of combat belongs to
/// the zone lane and nowhere else.
pub fn route_mitigation(st: &mut EngineState, ev: &MitigationLine) {
    let mtype = ev.mtype.to_string();
    // Defensive: the amount is required by the regex, but keep the ledger clean if a future shape ever
    // omits it — a rune with no amount is a count we cannot value.
    let amount = ev.amount.unwrap_or(0);
    both(st, ev.ts, true, |agg| match mtype.as_str() {
        "rune" => {
            if amount > 0 {
                agg.heal.add_rune(amount);
            }
        }
        "absorbSwing" => agg.heal.add_absorbed_swing(),
        _ => agg.heal.add_absorbed_damage_shield(),
    });
}

/// Heal on a hostile instance we are currently engaged with → enemy healing.
fn add_hostile_heal(st: &mut EngineState, ev: &HealLine, healer_key: Option<&str>) {
    let t_key = id_key_ref(&ev.target);
    // A KNOWN PLAYER is never a hostile, so their heals are never "enemy healing". `engage_hostile`
    // already keeps them out of `engaged`, which makes this unreachable for a player the heal stream
    // identified; it is stated anyway because the two rules answer the same question and must not be
    // able to disagree.
    if st.is_known_player(&t_key) {
        return;
    }
    // …and neither is a GROUP MEMBER. Stated here rather than left to `engage_hostile`'s refusal
    // because the very next line RESOLVES the target, and resolving MINTS a world instance — a
    // friendly must not acquire one just because somebody healed them.
    if st.is_member(&t_key) {
        return;
    }
    let inst = st.resolve(&ev.target, ev.ts, false);
    let engaged = st
        .current
        .as_ref()
        .is_some_and(|e| e.engaged.contains(&inst.instance_id));
    if !engaged {
        return;
    }
    if ev.amount > 0 {
        let (id, name) = (inst.instance_id.clone(), inst.label.clone());
        both(st, ev.ts, false, |agg| {
            agg.add_enemy_heal(&id, &name, ev.amount)
        });
    }
    // Counter-healing ledger, ranked by the HEALER (a mob healing itself is its own row). It takes the
    // zero-effective lines the map above refuses, for the reason the friendly side does.
    let hk = healer_key.unwrap_or("unknown").to_string();
    let healer_name = ev.healer.clone().unwrap_or_else(|| "Unknown".to_string());
    let input = ev.input();
    both(st, ev.ts, false, |agg| {
        agg.heal
            .add_hostile(&format!("heal:{hk}"), &healer_name, &input)
    });
    // PRESENCE: a heal on an engaged hostile proves BOTH ends are still in the fight — the mob
    // receiving it, and (when a second mob cast it) the healer. The real case this came from:
    // `Baron Telyx V`Zher healed Soldier of V`Zher for 175` — the Baron had landed nothing for
    // seconds while healing his friend, and the old damage-only liveness rule had already written
    // him off. Liveness only; enemy healing is an annotation, never damage.
    st.note_presence_id(&inst.instance_id, ev.ts);
    if let Some(name) = ev.healer.clone() {
        st.note_presence(&name, ev.ts);
    }
}

// ── THE RECORD-EVERYTHING LADDER (otherRouting.ts) ────────────────────────────────────────────

/// MAY THIS NAME BE RECORDED AS A COMBATANT OF ITS OWN? — the only place the refusal ladder is
/// spelled out in evaluation order. Cheapest and most authoritative first, so a busy raid log's
/// mob-vs-mob traffic leaves after one or two lookups.
///
/// `target` matters for exactly one thing: A === B. EQ prints self-damage (`Vektik hit Vektik for 6
/// points of magic damage by Lifespike.` — a lifetap resolving on its own caster, 60+ of them in one
/// slice), and a same-name line is the pet model's twin-ambiguity case, not a fight. Booking it would
/// credit somebody for hitting themselves.
fn records_other<'a>(
    st: &mut EngineState,
    attacker: &'a str,
    target: &str,
) -> Option<Cow<'a, str>> {
    let key = id_key_ref(attacker);
    let target_key = id_key_ref(target);
    if key == target_key {
        return None;
    }
    if !recordable_attacker(st, attacker, &key) {
        return None;
    }
    // AND THE OTHER HALF, asked of the DEFENDER. A recorded combatant swinging at you, at your pet,
    // at a group-mate, at anyone the heal stream proved a player, or at another recorded combatant is
    // not a fight this meter models — exactly the rule a group-mate's stray damage-shield tick has
    // always got. Dropped rather than booked, and dropped rather than filed as incoming.
    if st.ally_friendly(&target_key) || st.others.is_recorded(&target_key) {
        return None;
    }
    Some(key)
}

fn recordable_attacker(st: &mut EngineState, attacker: &str, key: &str) -> bool {
    if key.is_empty() || key == "you" || Some(key) == st.player_key.as_deref() {
        return false;
    }
    if st.pet_names.contains(key) || st.ever_pet.contains(key) {
        return false;
    }
    if st.others.is_pet(key) || st.others.is_hostile(key) {
        return false;
    }
    if st.ever_struck.contains(key) || st.charm.ever_charmed(key) {
        return false;
    }
    // Somebody else's charm pet already HAS a row, under the person who charmed it. Two rows for one
    // entity is the "aggregates lie" failure with two names on it.
    if st.ally.bind_of(key).is_some() {
        return false;
    }
    st.others.shaped(attacker, key)
}

/// WHAT ONE INCOMING LINE PROVES ABOUT THE THING THAT THREW IT — read off damage already attributed
/// to `Incoming`, i.e. a line whose target is YOU. It writes to its OWN set and never touches
/// `known_players`, so nothing here can un-file a player and hand a real person back to `engaged`.
/// The worst it can do is hide a row.
fn note_other_hostile(st: &mut EngineState, attacker: &str) {
    let key = id_key_ref(attacker);
    if key.is_empty() || key == "you" || st.is_known_player(&key) {
        return;
    }
    if st.pet_names.contains(key.as_ref()) || st.ever_pet.contains(key.as_ref()) {
        return;
    }
    if !st.others.shaped(attacker, &key) {
        return;
    }
    st.others.note_hostile(&key);
}

fn route_other_damage(st: &mut EngineState, ev: &DamageEvent<'_>) -> bool {
    let Some(key) = records_other(st, ev.attacker, ev.target) else {
        return false;
    };
    st.others.note(&key, ev.attacker);
    let src = other_source(st, ev.attacker, &key, false);
    both(st, ev.ts, true, |agg| agg.add_out(&src, ev, false));
    let tgt_name = note_defender(st, ev.target, ev.ts);
    push_fresh_timeline(st, ev.ts, damage_instant(ev, "other", tgt_name.clone()));
    st.log(
        ev.ts,
        ev.dtype,
        "other",
        format!(
            "{} → {tgt_name}  {}{}  {}",
            src.name,
            ev.amount,
            if ev.crit { "*" } else { "" },
            ev.skill
        ),
    );
    true
}

fn route_other_miss(st: &mut EngineState, ev: &MissLine, fold: &MissFold) -> bool {
    let Some(key) = records_other(st, &ev.attacker, &ev.target) else {
        return false;
    };
    st.others.note(&key, &ev.attacker);
    let src = other_source(st, &ev.attacker, &key, false);
    both(st, ev.ts, true, |agg| agg.add_out_miss(&src, fold));
    let tgt_name = note_defender(st, &ev.target, ev.ts);
    push_fresh_timeline(st, ev.ts, miss_instant(ev, "other", tgt_name.clone()));
    st.log(
        ev.ts,
        "miss",
        "other",
        format!("{} ✕ {tgt_name} ({})", src.name, ev.mtype.as_str()),
    );
    true
}

fn route_other_resist(st: &mut EngineState, ev: &ResistLine, category: &str) -> bool {
    let Some(key) = records_other(st, &ev.caster, &ev.target) else {
        return false;
    };
    st.others.note(&key, &ev.caster);
    let src = other_source(st, &ev.caster, &key, false);
    let spell = ev.spell.clone();
    both(st, ev.ts, true, |agg| {
        agg.add_out_resist(&src, &spell, category)
    });
    let tgt_name = note_defender(st, &ev.target, ev.ts);
    push_fresh_timeline(
        st,
        ev.ts,
        TimelineRaw {
            ts: ev.ts,
            lane: ev.spell.clone(),
            category: category.to_string(),
            amount: 0,
            crit: false,
            modifiers: Vec::new(),
            kind: "other",
            outcome: Some("resist"),
            detail: Some("resisted".to_string()),
            target: Some(tgt_name.clone()),
        },
    );
    st.log(
        ev.ts,
        "resist",
        "other",
        format!("{}'s {} resisted by {tgt_name}", src.name, ev.spell),
    );
    true
}

/// THE RETENTION POINT for a damage line's modifier tokens, named once (JOS-506).
///
/// The record itself borrows the parser's bytes; a timeline instant OUTLIVES the event, so it is
/// here — and only here — that the tokens have to be copied. Three call sites, all of them behind an
/// open-encounter gate, which is why the copy was never the cost the record's own construction was.
fn own_mods(mods: &[&str]) -> Vec<String> {
    mods.iter().map(|s| (*s).to_string()).collect()
}

/// The timeline instant a RECORDED combatant's (or an ally pet's) landed hit leaves.
fn damage_instant(ev: &DamageEvent<'_>, kind: &'static str, target: String) -> TimelineRaw {
    TimelineRaw {
        ts: ev.ts,
        lane: ev.skill.to_string(),
        category: ev.category.to_string(),
        amount: ev.amount,
        crit: ev.crit,
        modifiers: own_mods(ev.modifiers),
        kind,
        outcome: None,
        detail: None,
        target: Some(target),
    }
}

/// …and the avoided-swing twin, which lanes under `Melee` like every other whiff.
fn miss_instant(ev: &MissLine, kind: &'static str, target: String) -> TimelineRaw {
    TimelineRaw {
        ts: ev.ts,
        lane: "Melee".to_string(),
        category: "melee".to_string(),
        amount: 0,
        crit: false,
        modifiers: Vec::new(),
        kind,
        outcome: Some("miss"),
        detail: Some(ev.mtype.as_str().to_string()),
        target: Some(target),
    }
}

// ── SOMEBODY ELSE'S CHARM PET (allyRouting.ts) ────────────────────────────────────────────────

/// THE ALLY PET'S OWN METER ROW. THE ROW ID CARRIES THE CHARMER — `allypet:<charmer>:<pet>` rather
/// than `allypet:<pet>` — because the same mob re-charmed by a different enchanter is a different
/// person's contribution, and one row summing both would be the "aggregates lie" failure with two
/// names on it.
fn ally_pet_source(bind: &AllyBind) -> SourceRef {
    SourceRef {
        id: format!("allypet:{}:{}", bind.charmer_key, bind.name_key),
        // The BROADCAST's spelling, not the damage line's: EQ sentence-cases a leading article, and a
        // row flickering between `a rock golem` and `A rock golem` is world-model law 2's complaint.
        name: format!("Pet ({}) - {}", bind.display, bind.charmer),
        kind: SourceKind::AllyPet,
    }
}

/// WHAT ONE SWING BY A THIRD PARTY'S CHARM PET PROVES — read off every attributed AND every ignored
/// line, before the meter decides what to do with it.
///
/// TWO JUDGEMENTS, both ENDINGS rather than admissions: the SOFT-HOSTILE PROOF (the bound pet swung
/// at a friendly, so the charm is over at this instant — landed or avoided, because the intent is
/// the proof) and TWIN AMBIGUITY (attacker and target share the pet's name, so a second instance is
/// acting and the name's lines cannot be told apart; the bind survives and credits nothing).
///
/// AND A THIRD, WHICH IS NOT A JUDGEMENT: THE PET IS STILL HERE. Every line this sees is the bound
/// name ACTING, which slides its hold. It is done HERE rather than in the two routing paths because
/// this is the one seam that sees a line whatever the meter goes on to do with it: the twin-ambiguous
/// bind books nothing and must still not be reaped for silence.
fn note_ally_pet_evidence(st: &mut EngineState, attacker: &str, target: &str, ts: i64) {
    if st.ally.idle() {
        return;
    }
    let a_key = id_key_ref(attacker);
    if st.ally.bind_of(&a_key).is_none() {
        return;
    }
    st.ally.note_activity(&a_key, ts);
    // The bind is read again for its DISPLAY name and charmer at each of the two endings, because
    // `mark_ambiguous`/`soft_hostile` take `&mut st.ally` and a borrow of the bind cannot span one.
    if a_key == id_key_ref(target) {
        let said = st.ally.mark_ambiguous(&a_key);
        if said {
            if let Some(b) = st.ally.bind_of(&a_key) {
                let (display, charmer) = (b.display.clone(), b.charmer.clone());
                st.log(
                    ts,
                    "charm",
                    "dropped",
                    format!("~ {display}: a second one is active - {charmer}'s pet is unreadable"),
                );
            }
        }
        return;
    }
    if !st.ally_friendly(&id_key_ref(target)) {
        return;
    }
    // `soft_hostile` HANDS BACK THE BIND IT RETIRED, which is exactly what the line needs to name —
    // after the call there is nothing left to look up.
    if let Some(gone) = st.ally.soft_hostile(&a_key) {
        st.log(
            ts,
            "charm",
            "dropped",
            format!(
                "✕ {} turned on {target} - {}'s charm broke",
                gone.display, gone.charmer
            ),
        );
    }
}

/// Book one mob-vs-mob damage line to the ally who owns the attacker. Called only for lines
/// `classify` ignored, and only while the bind is live and unambiguous. See the module header for
/// every side effect it deliberately does not have.
fn route_ally_pet_damage(st: &mut EngineState, ev: &DamageEvent<'_>) {
    if st.ally.idle() {
        return;
    }
    let Some(bind) = st.ally.creditable(&id_key_ref(ev.attacker)) else {
        return;
    };
    let src = ally_pet_source(bind);
    both(st, ev.ts, true, |agg| agg.add_out(&src, ev, false));
    let tgt_name = note_defender(st, ev.target, ev.ts);
    push_fresh_timeline(st, ev.ts, damage_instant(ev, "allyPet", tgt_name.clone()));
    st.log(
        ev.ts,
        ev.dtype,
        "allyPet",
        format!(
            "{} → {tgt_name}  {}{}  {}",
            src.name,
            ev.amount,
            if ev.crit { "*" } else { "" },
            ev.skill
        ),
    );
}

/// The avoided-swing twin, on the same aggregate-only terms. A miss carries no amount, so this can
/// move no total anywhere (law 8).
fn route_ally_pet_miss(st: &mut EngineState, ev: &MissLine, fold: &MissFold) {
    if st.ally.idle() {
        return;
    }
    let Some(bind) = st.ally.creditable(&id_key_ref(&ev.attacker)) else {
        return;
    };
    let src = ally_pet_source(bind);
    both(st, ev.ts, true, |agg| agg.add_out_miss(&src, fold));
    let tgt_name = note_defender(st, &ev.target, ev.ts);
    push_fresh_timeline(st, ev.ts, miss_instant(ev, "allyPet", tgt_name.clone()));
    st.log(
        ev.ts,
        "miss",
        "allyPet",
        format!("{} ✕ {tgt_name} ({})", src.name, ev.mtype.as_str()),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dmg<'a>(attacker: &'a str, target: &'a str, amount: i64, ts: i64) -> DamageEvent<'a> {
        DamageEvent {
            ts,
            attacker,
            target,
            amount,
            dtype: "melee",
            dclass: None,
            skill: "Melee".into(),
            crit: false,
            category: "melee".into(),
            modifiers: &[],
            verb: Some("slash"),
        }
    }

    fn st_with_pet(pet: &str) -> EngineState {
        let mut st = EngineState::new();
        st.set_player_name("Primitive");
        st.world.claim(pet, 0);
        st.note_pet(&id_key_ref(pet));
        st
    }

    /// You → a pet NAME is outgoing to a hostile twin, never dropped as friendly fire.
    #[test]
    fn you_hitting_a_pet_name_is_outgoing() {
        let st = st_with_pet("a fire giant warrior");
        assert_eq!(
            classify(&st, "You", "a fire giant warrior"),
            Attribution::OutYou
        );
    }

    /// A pet hitting a SAME-NAMED target is the pet's, and AMBIGUOUS.
    #[test]
    fn a_same_named_pet_hit_is_the_pets_and_flagged() {
        let st = st_with_pet("a fire giant warrior");
        assert_eq!(
            classify(&st, "a fire giant warrior", "a fire giant warrior"),
            Attribution::OutPet {
                pet_key: "a fire giant warrior".into(),
                pet_name: "a fire giant warrior".into(),
                ambiguous: true,
            }
        );
    }

    /// A pet swinging at a KNOWN PLAYER is not our fight — booking it would credit us the damage AND
    /// enter that player into `engaged` as a hostile.
    #[test]
    fn a_pet_swinging_at_a_player_is_ignored() {
        let mut st = st_with_pet("Vebarn");
        st.note_player(Some("scooba"));
        assert_eq!(classify(&st, "Vebarn", "Scooba"), Attribution::Ignore);
        assert_eq!(
            classify(&st, "Vebarn", "a rock golem"),
            Attribution::OutPet {
                pet_key: "vebarn".into(),
                pet_name: "Vebarn".into(),
                ambiguous: false,
            }
        );
    }

    /// A landed hit opens a fight, engages the target, names the fight and moves BOTH aggregates.
    #[test]
    fn one_landed_hit_opens_engages_and_books() {
        let mut st = EngineState::new();
        st.set_player_name("Primitive");
        route(&mut st, &dmg("You", "a spite golem", 42, 1_000));
        let enc = st.current.as_ref().expect("a fight opened");
        assert_eq!(enc.id, "e1");
        assert_eq!(enc.start_ts, 1_000);
        assert!(enc.engaged.contains("a spite golem#1"));
        assert_eq!(enc.last_out_target.as_deref(), Some("a spite golem"));
        assert_eq!(Agg::sum(&enc.agg.out), 42);
        assert_eq!(Agg::sum(&st.zone_agg.out), 42);
        assert_eq!(st.zone_start_ts, 1_000);
        // …and YOUR OWN SWING is the one signal that files a mob.
        assert!(st.ever_struck.contains("a spite golem"));
    }

    /// ACTIVE TIME IS THE CAPPED GAP: the first hit adds nothing and a long lull adds at most one
    /// tick.
    #[test]
    fn active_time_caps_the_gap_between_hits() {
        let mut st = EngineState::new();
        st.set_player_name("Primitive");
        route(&mut st, &dmg("You", "a bat", 10, 0));
        assert_eq!(st.current.as_ref().expect("open").active_ms, 0);
        route(&mut st, &dmg("You", "a bat", 10, 1_000));
        assert_eq!(st.current.as_ref().expect("open").active_ms, 1_000);
        route(&mut st, &dmg("You", "a bat", 10, 20_000));
        assert_eq!(
            st.current.as_ref().expect("open").active_ms,
            1_000 + ACTIVE_MS
        );
    }

    /// A GROUP MEMBER NEVER ENGAGES, but their TARGET does — the mob your group-mate is fighting is
    /// the mob you are fighting.
    #[test]
    fn a_members_target_engages_and_the_member_never_does() {
        let mut st = EngineState::new();
        st.set_player_name("Primitive");
        st.roster.admitted.insert("dranix".into());
        st.roster.members.insert("dranix".into());
        route(&mut st, &dmg("Dranix", "a spite golem", 30, 1_000));
        let enc = st.current.as_ref().expect("open");
        assert!(enc.engaged.contains("a spite golem#1"));
        assert!(!enc.engaged.iter().any(|id| id.starts_with("dranix")));
        // …and the row is the member's own, keyed by NAME.
        assert!(enc.agg.out.contains_key("member:dranix"));
    }

    /// A mob-vs-mob line NEITHER of your models claims is RECORDED under its own row — and that row
    /// engages nothing and opens nothing.
    #[test]
    fn a_stranger_fighting_a_mob_gets_a_row_and_nothing_else() {
        let mut st = EngineState::new();
        st.set_player_name("Primitive");
        // No fight is open, so the line books to the ZONE lane and nowhere else.
        route(&mut st, &dmg("Scooba", "a spite golem", 25, 1_000));
        assert!(st.current.is_none(), "an 'other' row may not open a fight");
        assert!(st.zone_agg.out.contains_key("member:scooba"));
        assert_eq!(Agg::sum(&st.zone_agg.out), 25);
        // …and the target ledger is untouched, so a fight's NAME stays a fact about what you fought.
        assert!(st.zone_agg.targets.is_empty());
    }

    /// AN ARTICLE-NAMED MOB IS NEVER RECORDED as a combatant of its own — the shape gate.
    #[test]
    fn mob_versus_mob_between_two_article_names_stays_dropped() {
        let mut st = EngineState::new();
        st.set_player_name("Primitive");
        route(
            &mut st,
            &dmg("a fire giant warrior", "a spite golem", 25, 1_000),
        );
        assert!(st.zone_agg.out.is_empty());
    }

    /// SOMETHING YOU HAVE BEEN KILLING IS NEVER RECORDED as a person either, even when its name is
    /// player-shaped — the `ever_struck` rung.
    #[test]
    fn a_proper_named_mob_you_have_struck_never_earns_its_own_row() {
        let mut st = EngineState::new();
        st.set_player_name("Primitive");
        route(&mut st, &dmg("You", "Drelzna", 40, 1_000));
        route(&mut st, &dmg("Drelzna", "a spite golem", 25, 2_000));
        assert!(!st.zone_agg.out.contains_key("member:drelzna"));
    }

    /// A heal on an ENGAGED hostile is enemy healing and refreshes its presence; one on a mob we have
    /// never touched is neither.
    #[test]
    fn enemy_healing_needs_the_target_to_be_engaged() {
        let mut st = EngineState::new();
        st.set_player_name("Primitive");
        route(&mut st, &dmg("You", "a spite golem", 40, 1_000));
        route_heal(
            &mut st,
            &HealLine {
                ts: 2_000,
                target: "a spite golem".into(),
                healer: Some("a spite golem".into()),
                amount: 15,
                raw_amount: None,
                spell: None,
                crit: false,
            },
        );
        let enc = st.current.as_ref().expect("open");
        assert_eq!(Agg::sum_heal(&enc.agg.enemy_heal), 15);
        assert_eq!(
            enc.engaged_seen.get("a spite golem#1").copied(),
            Some(2_000)
        );

        route_heal(
            &mut st,
            &HealLine {
                ts: 3_000,
                target: "a bat".into(),
                healer: Some("a bat".into()),
                amount: 15,
                raw_amount: None,
                spell: None,
                crit: false,
            },
        );
        assert_eq!(
            Agg::sum_heal(&st.current.as_ref().expect("open").agg.enemy_heal),
            15
        );
    }

    /// A MISS neither opens nor extends a fight, and it still counts toward the zone lane.
    #[test]
    fn a_miss_never_opens_a_fight() {
        let mut st = EngineState::new();
        st.set_player_name("Primitive");
        route_miss(
            &mut st,
            &MissLine {
                ts: 1_000,
                attacker: "You".into(),
                target: "a spite golem".into(),
                mtype: MissType::Dodge,
                verb: Some("slash".into()),
                verb_skill: Some("Melee".into()),
                modifiers: Vec::new(),
            },
        );
        assert!(st.current.is_none());
        assert_eq!(st.zone_agg.out.get("you").expect("row").misses, 1);
    }

    /// The SPECIAL-ATTACK lane renames a miss's ROUND lane and never its aggregation lane, and only
    /// for YOUR swings — the state line is first-person-only.
    #[test]
    fn the_special_lane_renames_only_your_round_lane() {
        let mut st = EngineState::new();
        st.set_player_name("Primitive");
        st.specials.note("Dragon Punch");
        let line = MissLine {
            ts: 1_000,
            attacker: "You".into(),
            target: "a spite golem".into(),
            mtype: MissType::Miss,
            verb: Some("strike".into()),
            verb_skill: Some("Strike".into()),
            modifiers: Vec::new(),
        };
        let mine = miss_fold(&st, &line, true);
        assert_eq!(mine.skill, "Melee");
        assert_eq!(mine.lane_skill.as_deref(), Some("Dragon Punch"));
        let theirs = miss_fold(&st, &line, false);
        assert_eq!(theirs.lane_skill.as_deref(), Some("Strike"));
    }
}
