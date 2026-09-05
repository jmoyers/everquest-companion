//! Attribution + routing — where a parsed combat line lands (`src/main/combat/routing.ts`, plus
//! `otherRouting.ts` and `allyRouting.ts`, the two doors it offers a line it drops).
//!
//! `classify()` is the pure attribution decision (you / your pet / a group-mate / incoming / not our
//! fight); the `route_*` functions fold the line into the current encounter and the zone aggregate
//! under that verdict, refresh the presence axis, and engage what needs engaging. Nothing here
//! decides when a fight opens or closes — that is `lifecycle.rs`.
//!
//! The three doors are asked in a fixed order and each sees only what the one before it declined:
//! `classify` decides YOUR rows, `route_other_*` records every other combatant the log names, and
//! `route_ally_pet_*` credits somebody else's charm pet. Half a ladder mis-files a pet's damage,
//! which mis-fills `engaged`, which mis-segments the fight.
//!
//! `classify` is pure and is asked three times per line (the damage, miss and resist probes), so it
//! never also asks "…and if not, whose is it?" — an `Ignore` verdict is an OFFER to the two models
//! below, not a disposal. That leaves the roster with the engagement licence and the Group scope,
//! neither of which can move a number, which is what makes "a wrong roster can hide a row but never
//! corrupt a number" true rather than aspirational.
//!
//! An `other` or ally-pet row is AGGREGATE-ONLY: it opens no encounter, extends none, engages no
//! hostile, refreshes no presence, resolves no world instance and bumps no target ledger. One
//! friendly in `engaged` is enough to merge three pulls into a single segment.

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

/// The attribution decision. Everything the combat model books passes through here.
///
///   You → pet-name : always outgoing to a hostile twin, never dropped as friendly fire.
///   pet-name → You : always incoming.
///   pet-name → same-name (A == B) : pet outgoing, but AMBIGUOUS — it could be your pet hitting a
///     hostile twin or a hostile twin hitting your pet. Attribute to the pet and flag it.
///   pet-name → a known player or a group-mate : IGNORE. Either the "pet" was never ours or this is
///     a duel; booking it would credit us the damage and enter that player into `engaged` as a
///     hostile, which keeps pulls from ever closing.
///   member → other : outgoing, as that member's own row.
///   member → You : IGNORED, not incoming — the incoming meter answers "what is hitting me", which
///     in this game means hostiles.
///   any mob → member : IGNORED. Incoming-on-members is a real feature and out of scope.
pub fn classify(st: &EngineState, attacker: &str, target: &str) -> Attribution {
    // Borrowed: this is the busiest identity question in the fold, and every answer but `OutPet` is
    // dropped after a comparison or a set lookup. Only the branch that retains the key pays for it.
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
    // A group member is the attacker. Checked before the incoming rule so a member's hit on you is
    // dropped rather than filed as an enemy's; checked after the pet rules so a charmed mob that
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
    // Attacker not one of ours, target not you — offered to the two models below, not disposed of.
    Attribution::Ignore
}

/// The meter row for a combatant other than you — a group member or anyone else the log named.
///
/// One id namespace for both: the person you fought beside for ten minutes and then invited into
/// your group must be ONE bar, not one per provenance. `Agg::reid` upgrades the stored kind when the
/// roster catches up; the id never moves, so no total splits.
///
/// Keyed by NAME, not by instance — the pet rule deliberately inverted: resolving mints a world
/// instance, and a player-shaped instance can be engaged, retired, aged out and counted as hostile
/// presence. The canonical name gives one stable row and touches the world model not at all.
///
/// The name prefers the roster's spelling (the one a user has seen in the popover), then the
/// recorded spelling, then the line's own — world-model law 2 in ladder form.
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

/// The outgoing meter row for an attributed you/pet/member action — the triple the damage, miss and
/// resist paths all need and all resolve identically. A pet resolves to its pet INSTANCE so twin
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

/// Engage an instance as a hostile of this encounter — the one door into `engaged`, and therefore
/// the one thing that can veto closure.
///
/// Neither a known player nor a group member walks through it. `engaged` membership is what closure
/// polls for "is anything still alive in this fight", so a friendly — who does not die on our
/// schedule — would hold a pull open indefinitely. Members reach this function on the ordinary
/// outgoing path via `You → <member>`: a member's TARGET engages, the member never does.
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

/// Resolve the defender's label. The CALL is not optional even where nothing reads the result:
/// `defender_label` resolves through the world model, which retires stale instances and adopts the
/// sighting's casing as the instance display — and that display is what the next `bump_target`
/// freezes into a fight's name.
///
/// Without a fresh encounter the raw name stands and the world model is not touched at all.
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

/// Fold one landed damage line and report the verdict it reached. `None` means the line was ignored
/// before any verdict was needed, which is where the analytics fold returns early.
pub fn route(st: &mut EngineState, ev: &DamageEvent<'_>) -> Option<Attribution> {
    if ev.amount <= 0 {
        return None;
    }
    let at = classify(st, ev.attacker, ev.target);
    // "You hit it", filed once, off the verdict `classify` just reached — here rather than inside
    // `classify`, which is pure and asked by the miss and resist probes too, so a decision that also
    // mutated state would count one swing three times.
    if at == Attribution::OutYou {
        st.note_struck(&id_key_ref(ev.target));
    }
    // Before the ignore gate and the outgoing/incoming split: a bound ally pet swinging at YOU
    // classifies as `Incoming` rather than `Ignore`, and that line is the strongest soft-hostile
    // proof there is.
    note_ally_pet_evidence(st, ev.attacker, ev.target, ev.ts);
    // …and the same line for the other model: something that landed damage on you is a hostile,
    // whatever its name looks like.
    if at == Attribution::Incoming {
        note_other_hostile(st, ev.attacker);
    }
    if at == Attribution::Ignore {
        // Offered to the two models that read it — the record-everything ladder first, then a third
        // party's charm pet. Both book aggregate-only; what neither claims stays dropped.
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
        // Active-time accrual: the gap since the previous attributed hit, capped at `ACTIVE_MS`, so
        // a long lull counts as at most one active tick. The first hit adds 0.
        if let Some(prev) = enc.prev_damage_ts {
            enc.active_ms += (ev.ts - prev).clamp(0, ACTIVE_MS);
        }
        enc.prev_damage_ts = Some(ev.ts);
        enc.last_ts = ev.ts;
    }
    st.last_activity_ts = ev.ts;
    // Zone-session timing: first/last attributed damage in this stay.
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
    // An incoming instant lanes under the attacker's skill, so it gets its own row.
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
    // A member's hit records no pet engagement and no charm evidence: a member is not a pet. The one
    // thing it does beyond its own row is engage its TARGET, because the mob your group-mate is
    // fighting is the mob you are fighting.

    // The game states the damage type on every typed spell line ("… for 53 points of POISON damage
    // by Asp Venom Strike."), so a poison lane is a fact the log printed, not a name-matched guess.
    // Outgoing only, and additive — a second index over damage already counted, so no total moves.
    if ev.dclass == Some("poison") {
        // The ledger is about the venom, not the meter row: a cast-less firing's meter lane carries
        // the origin marker and this counter must not inherit it.
        let venom = base_lane_name(&ev.skill).to_string();
        both(st, ev.ts, false, |agg| {
            agg.procs.add_poison_damage(&venom, ev.amount)
        });
    }
    // Resolve the target to an instance. For a same-name ambiguous pet hit the target is the hostile
    // twin (`prefer_charmed = false` picks it).
    let tgt = st.resolve(ev.target, ev.ts, false);
    let (tid, tname) = (tgt.instance_id.clone(), tgt.label.clone());
    both(st, ev.ts, false, |agg| {
        agg.add_out(&src, ev, ambiguous);
        agg.bump_target(&tid, &tname, ev.amount);
    });
    engage_hostile(st, &tgt, ev.ts);
    // The live fight is named after whatever you are presently swinging at; finalize switches to the
    // largest target.
    if let Some(enc) = st.current.as_mut() {
        enc.last_out_target = Some(tname.clone());
        // An outgoing instant lanes under the skill/spell name, and `target` carries the
        // instance-resolved defender label — the same value `bump_target` aggregates under, so the
        // per-mob breakdown can answer "what did I land on THIS mob".
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
    // The ambiguous mark `~` replaces the crit star rather than joining it: "could not attribute
    // cleanly" outranks "it crit".
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

/// The avoided swing as the aggregates fold it. `skill` stays `Melee` for every miss — that is the
/// accuracy lane — while `verb`/`lane_skill`/`modifiers`/`target` are the amount-free inputs to the
/// round grouper and the modifier tallies. The lane label goes through the same two steps a landed
/// swing does: the parser's melee-skill answer, then the log's statement of which special is live in
/// that verb lane, gated on the attacker being You because the state line is first-person-only.
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
    // An ally pet's swing at a friendly proves the break whether or not it connected.
    note_ally_pet_evidence(st, &ev.attacker, &ev.target, ev.ts);
    if at == Attribution::Ignore {
        // The same two offers the damage path makes, in the same order. No hostile-evidence read on
        // the incoming side: that rung was measured on landed damage, and a swing that connected
        // with nothing is not what was measured.
        let fold = miss_fold(st, ev, false);
        if !route_other_miss(st, ev, &fold) {
            route_ally_pet_miss(st, ev, &fold);
        }
        return;
    }
    let fold = miss_fold(st, ev, at == Attribution::OutYou);
    // Presence: a swing exchanged with an already-engaged mob proves it is still in the fight even
    // though nothing landed. Liveness only; no damage timing moves.
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
        // An incoming swing absorbed by YOUR rune is a mitigation instant and belongs to the healing
        // ledger. `Incoming` means the defender is you (a swing at your pet classifies as `Ignore`),
        // so this can never pick up a pet's or a mob's own rune. The parser emits exactly one event
        // per line whichever regex claims it, so this and `absorbSwing` cannot double-count.
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
    // A pet whiffing is as much proof it is fighting for us as a landed hit. A member's whiff proves
    // nothing about charm: they are bound by a group line, not by evidence.
    if kind == OutKind::Pet {
        st.charm.note_pet_evidence(&id_key_ref(&ev.attacker));
    }
    both(st, ev.ts, true, |agg| agg.add_out_miss(&src, fold));
    // A miss tick lanes under `Melee`. The defender goes through `defender_label` so it matches the
    // instance label the damage path writes; a raw name piles every whiff at a twin onto a bare row.
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

pub struct ResistLine {
    pub ts: i64,
    pub caster: String,
    pub target: String,
    pub spell: String,
    pub incoming: bool,
}

/// Whose resisted cast this was, or `None` when it is none of ours. Separate from `classify`
/// because a resist names a CASTER and a TARGET, not an attacker and a defender.
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
/// Resisted detrimental spells are direct spells in the taxonomy, so every resist categorizes as
/// `spell` and sorts into the spell lanes. They carry no amount, so category totals are unaffected;
/// the lane is the display spell name, so a resist tick lands beside landed casts of that spell.
pub fn route_resist(st: &mut EngineState, ev: &ResistLine) {
    const CATEGORY: &str = "spell";
    // Presence: refresh whichever side is a hostile we are already engaged with — the caster on an
    // incoming resist, the target on our own resisted cast. `note_presence` ignores anything not
    // engaged, so the you/pet side is a no-op.
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
        // A resisted cast by a combatant the log named — the record-everything ladder, asked of the
        // CASTER because a resist has no attacker/defender pair to classify.
        if route_other_resist(st, ev, CATEGORY) {
            return;
        }
        // A hostile mob's spell resisted by another mob is out of scope, and said so: a line the
        // engine deliberately refused is what the `dropped` role is for.
        st.log(
            ev.ts,
            "resist",
            "dropped",
            format!("{}'s {} resisted by {}", ev.caster, ev.spell, ev.target),
        );
        return;
    };
    let src = out_source(st, &ev.caster, kind, ev.ts);
    // A pet whose spell got resisted was casting for us. A member's resisted cast is not charm
    // evidence.
    if kind == OutKind::Pet {
        st.charm.note_pet_evidence(&id_key_ref(&ev.caster));
    }
    let spell = ev.spell.clone();
    both(st, ev.ts, true, |agg| {
        agg.add_out_resist(&src, &spell, CATEGORY)
    });
    // Same instance resolution as the miss and damage paths: a resisted cast at a twin lands on that
    // twin's per-mob row, not on a bare-named ghost.
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

/// Consume a heal. A heal on an engaged HOSTILE is enemy healing (it undoes our damage); a heal on
/// You or one of your pets is incoming healing; both also fold into the healing ledger. Other heals
/// are ignored for aggregation: the log gives no faction for an arbitrary name.
///
/// Zero-effective heals (`… for 0 (2) hit points …`) are the overheal evidence and belong to the
/// ledger; the `enemy_heal` / `inc_heal` maps keep their `amount <= 0` gate.
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

    // Known-player evidence, ONE direction only: a heal landing on the owner names its healer as a
    // friendly player. The other direction — "`You healed <X>` ⇒ X is a player" — is false in this
    // log, because a player heals their own PETS by name, and a "player" is never a hostile and
    // never a pet's target, so the claim silently deletes real pet damage.
    if (is_you_tgt || is_player_tgt) && healer_key.is_some() {
        st.note_player(healer_key.as_deref());
    }
    // Pet evidence, the other way round: the owner healing something already treated as a pet
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

/// Incoming heal to You (or the player by name) / your pet. The `inc_heal` map keeps its
/// `amount <= 0` gate; the ledger takes the zero-effective lines too, because they are the overheal
/// evidence.
fn add_friendly_heal(st: &mut EngineState, ev: &HealLine, healer_key: Option<&str>) {
    let hk = healer_key.unwrap_or("unknown").to_string();
    let healer_name = ev.healer.clone().unwrap_or_else(|| "Unknown".to_string());
    if ev.amount > 0 {
        both(st, ev.ts, true, |agg| {
            agg.add_inc_heal(&hk, &healer_name, ev.amount)
        });
    }
    // Healing ledger: ranked by HEALER. Row id `you` for self-heals keys the healing meter's primary
    // row the same way the damage meter's is.
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

/// Consume an announced-but-unvalued heal — `You mend your wounds and heal some damage.`
///
/// It reaches the healing ledger as a COUNT on its own lane and nothing else. Everything the valued
/// path does with an amount is skipped rather than done with a zero: no `inc_heal`, no proc
/// analytics (a 0-amount "Mend proc" is a fabricated observation), no min/max/overheal.
///
/// No world-model evidence is read off it either, unlike every other heal line: the sentence names
/// nobody, so there is nothing to learn and nothing to get wrong.
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

/// Consume an absorption / mitigation line — damage PREVENTED, not hit points restored, so it never
/// touches a damage total. It does reach the healing total: rune counters fold in as a row
/// classified `absorbed`, while the two count-only families carry no amount and reach no total.
///
/// These lines never open, join or extend an encounter and never move the damage timeline, the same
/// rule miss and resist follow (law 8). A rune ticking out of combat belongs to the zone lane only.
pub fn route_mitigation(st: &mut EngineState, ev: &MitigationLine) {
    let mtype = ev.mtype.to_string();
    // The amount is required by the regex; a rune with no amount is a count we cannot value.
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
    // A known player is never a hostile, so their heals are never enemy healing. Stated here as well
    // as in `engage_hostile` so the two rules cannot disagree.
    if st.is_known_player(&t_key) {
        return;
    }
    // …and neither is a group member. Stated here rather than left to `engage_hostile`'s refusal
    // because the next line RESOLVES the target, and resolving mints a world instance — a friendly
    // must not acquire one just because somebody healed them.
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
    // Counter-healing ledger, ranked by the HEALER (a mob healing itself is its own row). It takes
    // the zero-effective lines the map above refuses, for the reason the friendly side does.
    let hk = healer_key.unwrap_or("unknown").to_string();
    let healer_name = ev.healer.clone().unwrap_or_else(|| "Unknown".to_string());
    let input = ev.input();
    both(st, ev.ts, false, |agg| {
        agg.heal
            .add_hostile(&format!("heal:{hk}"), &healer_name, &input)
    });
    // A heal on an engaged hostile proves BOTH ends are still in the fight — the mob receiving it,
    // and (when a second mob cast it) the healer, who may have landed nothing for seconds while
    // healing. Liveness only; enemy healing is an annotation, never damage.
    st.note_presence_id(&inst.instance_id, ev.ts);
    if let Some(name) = ev.healer.clone() {
        st.note_presence(&name, ev.ts);
    }
}

/// May this name be recorded as a combatant of its own? The refusal ladder in evaluation order,
/// cheapest and most authoritative first, so a busy raid log's mob-vs-mob traffic leaves after one
/// or two lookups.
///
/// `target` matters for exactly one thing: A == B. EQ prints self-damage (`Vektik hit Vektik for 6
/// points of magic damage by Lifespike.` — a lifetap resolving on its own caster), and a same-name
/// line is the pet model's twin-ambiguity case, not a fight.
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
    // The other half, asked of the DEFENDER. A recorded combatant swinging at you, at your pet, at a
    // group-mate, at anyone the heal stream proved a player, or at another recorded combatant is not
    // a fight this meter models. Dropped rather than booked, and never filed as incoming.
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
    // Somebody else's charm pet already has a row, under the person who charmed it. Two rows for one
    // entity is the "aggregates lie" failure with two names on it.
    if st.ally.bind_of(key).is_some() {
        return false;
    }
    st.others.shaped(attacker, key)
}

/// What one incoming line proves about the thing that threw it — read off damage already attributed
/// to `Incoming`, i.e. a line whose target is YOU. It writes its own set and never touches
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

/// The retention point for a damage line's modifier tokens. The record borrows the parser's bytes; a
/// timeline instant outlives the event, so this is the only place the tokens are copied.
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

/// The ally pet's own meter row. The row id carries the CHARMER — `allypet:<charmer>:<pet>` — because
/// the same mob re-charmed by a different enchanter is a different person's contribution, and one
/// row summing both would be the "aggregates lie" failure with two names on it.
fn ally_pet_source(bind: &AllyBind) -> SourceRef {
    SourceRef {
        id: format!("allypet:{}:{}", bind.charmer_key, bind.name_key),
        // The broadcast's spelling, not the damage line's: EQ sentence-cases a leading article, and
        // a row flickering between `a rock golem` and `A rock golem` is world-model law 2's
        // complaint.
        name: format!("Pet ({}) - {}", bind.display, bind.charmer),
        kind: SourceKind::AllyPet,
    }
}

/// What one swing by a third party's charm pet proves — read off every attributed and every ignored
/// line, before the meter decides what to do with it.
///
/// Two judgements, both ENDINGS rather than admissions: the soft-hostile proof (the bound pet swung
/// at a friendly, landed or avoided, because the intent is the proof) and twin ambiguity (attacker
/// and target share the pet's name, so the bind survives and credits nothing).
///
/// And a third that is not a judgement: the pet is still here, so its hold slides. Done here rather
/// than in the two routing paths because this is the one seam that sees a line whatever the meter
/// does with it — a twin-ambiguous bind books nothing and must still not be reaped for silence.
fn note_ally_pet_evidence(st: &mut EngineState, attacker: &str, target: &str, ts: i64) {
    if st.ally.idle() {
        return;
    }
    let a_key = id_key_ref(attacker);
    if st.ally.bind_of(&a_key).is_none() {
        return;
    }
    st.ally.note_activity(&a_key, ts);
    // The bind is read again for its display name and charmer at each ending, because
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
    // `soft_hostile` hands back the bind it retired, which is what the line needs to name: after the
    // call there is nothing left to look up.
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

/// The avoided-swing twin, on the same aggregate-only terms. A miss carries no amount, so it can
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

    /// You → a pet name is outgoing to a hostile twin, never dropped as friendly fire.
    #[test]
    fn you_hitting_a_pet_name_is_outgoing() {
        let st = st_with_pet("a fire giant warrior");
        assert_eq!(
            classify(&st, "You", "a fire giant warrior"),
            Attribution::OutYou
        );
    }

    /// A pet hitting a same-named target is the pet's, and ambiguous.
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

    /// A pet swinging at a known player is not our fight — booking it would credit us the damage and
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
        // …and your own swing is the one signal that files a mob.
        assert!(st.ever_struck.contains("a spite golem"));
    }

    /// Active time is the capped gap: the first hit adds nothing and a long lull adds at most one
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

    /// A group member never engages, but their target does — the mob your group-mate is fighting is
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
        // …and the row is the member's own, keyed by name.
        assert!(enc.agg.out.contains_key("member:dranix"));
    }

    /// A mob-vs-mob line neither of your models claims is recorded under its own row — and that row
    /// engages nothing and opens nothing.
    #[test]
    fn a_stranger_fighting_a_mob_gets_a_row_and_nothing_else() {
        let mut st = EngineState::new();
        st.set_player_name("Primitive");
        // No fight is open, so the line books to the zone lane and nowhere else.
        route(&mut st, &dmg("Scooba", "a spite golem", 25, 1_000));
        assert!(st.current.is_none(), "an 'other' row may not open a fight");
        assert!(st.zone_agg.out.contains_key("member:scooba"));
        assert_eq!(Agg::sum(&st.zone_agg.out), 25);
        // …and the target ledger is untouched, so a fight's name stays a fact about what you fought.
        assert!(st.zone_agg.targets.is_empty());
    }

    /// An article-named mob is never recorded as a combatant of its own — the shape gate.
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

    /// Something you have been killing is never recorded as a person either, even when its name is
    /// player-shaped — the `ever_struck` rung.
    #[test]
    fn a_proper_named_mob_you_have_struck_never_earns_its_own_row() {
        let mut st = EngineState::new();
        st.set_player_name("Primitive");
        route(&mut st, &dmg("You", "Drelzna", 40, 1_000));
        route(&mut st, &dmg("Drelzna", "a spite golem", 25, 2_000));
        assert!(!st.zone_agg.out.contains_key("member:drelzna"));
    }

    /// A heal on an engaged hostile is enemy healing and refreshes its presence; one on a mob we
    /// have never touched is neither.
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

    /// A miss neither opens nor extends a fight, and it still counts toward the zone lane.
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

    /// The special-attack lane renames a miss's ROUND lane and never its aggregation lane, and only
    /// for your swings — the state line is first-person-only.
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
