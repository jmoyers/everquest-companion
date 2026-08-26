//! THE ALLY-CHARM MODEL (JOS-250) — whose pet is that, when it is not yours?
//!
//! ── THE QUESTION, AND WHY THE ANSWER USED TO BE "NOBODY'S" ─────────────────────────────────────
//!
//! `<mob> has been charmed.` names no caster (`charm.rs` carries the whole argument), so the
//! ownership gate bound it only when it resolved one of the OWNER's own casts and dropped every
//! other one on the floor. That is still right for YOUR rows — and it also meant a group-mate's
//! enchanter contributed literally nothing to the meter, which is the report this model answers.
//!
//! The line that closes the gap has been parsed since JOS-140 and was never ingested by combat:
//! `<Name> begins casting <charm spell>.` MEASURED, owner's whole log 2026-08-12, re-derived
//! through the SHIPPED roster and the SHIPPED arm window: 456 charm broadcasts — 441 resolve one of
//! the owner's own casts, 15 resolve a NAMED third party's, 0 resolve nothing, 0 resolve both. A
//! perfect split, with no heuristic in it.
//!
//! ── BINDING — TWO PATHS, BOTH OF WHICH NAME BOTH ENDS ──────────────────────────────────────────
//!
//!   1. CAST + BROADCAST JOIN. A charm-family cast by a PLAYER-SHAPED name arms a window of that
//!      spell's own cast time plus the same slack your casts get; a caster-less broadcast landing
//!      inside exactly ONE armed window binds that mob to that caster.
//!   2. LEADER SAY. `<PetName> says, 'My leader is <Player>.'` binds outright — the only line in
//!      the game that names both the pet and its owner, and the only one that reaches a stranger's
//!      SUMMONED pet.
//!
//! THE CASTER GATE IS THE WHOLE DEFENCE OF PATH 1: mobs cast charm songs at you (`A fire giant
//! warrior begins singing Solon's Bewitching Bravura.`), so a rule reading the SHAPE of the line
//! without the shape of the NAME would file a fire giant as a charmer.
//!
//! ── WHAT THE PET IS DECIDES HOW IT ENDS (JOS-270, owner ruling 2026-08-13) ─────────────────────
//!
//! THE LIFECYCLE KEYS ON THE EVIDENCE, NEVER ON WHICH LINE BOUND IT (the owner, in as many words).
//! `/pet who leader` is answered by a CHARM pet as readily as by a summoned one, so `via` is not the
//! discriminant. `kind` is, and `bind_by_leader` derives it from two signals plus a default:
//!
//!   CHARM EVIDENCE FOR THIS PET   any charm broadcast has ever named it (`ever_charmed`, ours or a
//!                                 stranger's). Keyed by the PET, so it outranks. ⇒ `Charm`.
//!   SUMMON EVIDENCE FOR THIS OWNER  this ally was seen casting a pet summon at or before the say.
//!                                 Weaker on purpose: keyed by the PERSON, so it cannot say WHICH
//!                                 of their creatures is talking. ⇒ `Summon`.
//!   NEITHER                       ⇒ `Charm`, THE SAFER DEFAULT: wrongly keeping the break rule
//!                                 loses some damage, wrongly dropping it can credit a re-hostile
//!                                 mob to a player, and the owner ruled the second worse.
//!
//! A `Summon` bind is exempt from exactly two of the four endings and nothing else: NO SOFT-HOSTILE
//! BREAK (there is no charm to break — measured on a report where the rule fired on a PURE NAME
//! COLLISION and ate 29 percent of the pet's damage), and NO HOLD CLOCK (the charm hold is derived
//! from a SPELL's listed duration and there is no spell here).
//!
//! ── UNBINDING — FOUR ENDS, EVERY ONE A LINE THE LOG PRINTS ─────────────────────────────────────
//!
//!   SOFT-HOSTILE PROOF  the bound pet SWINGS AT A FRIENDLY. A charmed mob does not attack its
//!                       charmer's side. LANDED OR NOT: in the Scooba episode the first swing at
//!                       the charmer is two seconds after the broadcast and the first LANDED punch
//!                       twenty-eight; the intent is the proof, and refusing the miss would have
//!                       credited a stranger twenty-six seconds of a pet that had already turned.
//!                       `Charm` binds only.
//!   PET DEATH           the ordinary death line for the bound name.
//!   RE-CHARM            a new broadcast/cast-join — by the same charmer it RESTATES, by a
//!                       different one it REBINDS.
//!   SILENCE             the bound name has not acted for a whole window. `Charm` binds only.
//!
//! SILENCE USED TO BE HOLD EXPIRY — a clock started at the bind and run to the spell's LISTED
//! duration, on the argument that a charm cannot outlive its spell. THAT ARGUMENT IS WRONG ABOUT THE
//! REAL GAME (owner ruling 2026-08-13, JOS-270): AAs and focus effects extend a charm well past the
//! DB figure, so a fixed clock cuts a still-live charm loose and under-attributes exactly the way
//! this feature exists to stop. SO THE HOLD SLIDES ON EVIDENCE — every line the bound name acts on
//! re-bases it — and the sweep reaps a pet that STOPPED APPEARING rather than one that outlived a
//! wiki number. THE MIRROR: a CONFIRMED own charm never auto-expires at all (evidence ends it, never
//! a clock); this brings the ally binds to the same philosophy while keeping the one job the clock
//! was always really doing, which is reaping a pet that vanished.
//!
//! NOTHING IS RETRO-UNCREDITED: damage booked before a proof stays booked. The pet really was
//! charmed then, and a meter that changes numbers it has already shown is worse than a late ending.
//!
//! ── REFUSALS — THE SHAPES WHERE THE HONEST ANSWER IS NOTHING ───────────────────────────────────
//!
//!   SAME-NAMED TWIN   an attacker whose name equals its target's name IS the ambiguity. The
//!                     canonical fixture is the rock-golem episode, whose very first line after the
//!                     broadcast is `A rock golem pierces a rock golem for 102 points`.
//!   MULTI-CASTER TIE  two charmers armed over one broadcast. Measured exactly once in the whole
//!                     log. Refuse; a coin flip credited to a named person is worse than silence.
//!   BARD CHARM        `Solon's Bewitching Bravura` prints a different sentence and can never be the
//!                     cast a broadcast resolved (`is_charm_broadcast_spell`).
//!   NON-PLAYER CASTER the caster gate above.
//!
//! PURE + CLOCK-INJECTED, exactly like `charm.rs`.

use crate::combat::spellfacts::{
    arm_window_ms, is_charm_broadcast_spell, is_pet_summon_spell, is_player_shaped_name,
    provisional_window_ms, DEFAULT_CHARM_DURATION_MS, DURATION_SLACK_MS,
};
use crate::jsmap::JsMap;
use eqlog::names::spell_canon_key;
use std::collections::{HashMap, HashSet};

/// WHAT THE EVIDENCE SAYS THIS CREATURE IS, and therefore which endings apply to it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AllyKind {
    Charm,
    Summon,
}

/// Which line bound it. The processing line reads it; it is NOT the lifecycle discriminant.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AllyVia {
    Cast,
    Leader,
}

/// `Number.POSITIVE_INFINITY`, as a log clock can hold it — a `Summon` bind has NO clock at all,
/// and every arithmetic site below saturates rather than wrapping, which is what makes
/// `note_activity`'s `ts + windowMs` the no-op arithmetic identity the TS gets for free.
const NO_CLOCK: i64 = i64::MAX;

/// One live third-party charm bind.
#[derive(Debug, Clone)]
pub struct AllyBind {
    pub name_key: String,
    /// The pet's display name as the CHARM BROADCAST spelled it (lowercase article, world-model law
    /// 2) — never the sentence-cased spelling a damage line happens to carry.
    pub display: String,
    pub charmer_key: String,
    pub charmer: String,
    pub bound_ts: i64,
    /// HOW LONG THIS NAME MAY BE QUIET and still plausibly be bound, slid forward by
    /// `note_activity` on every line the name acts on. `NO_CLOCK` when `kind` is `Summon`, so both
    /// "no clock" and "still fighting" need no second code path.
    pub hold_until: i64,
    /// THE WINDOW `hold_until` IS SLID BY. Held on the bind rather than recomputed because the
    /// spell that explains a bind is knowable only at the moment it is made.
    pub window_ms: i64,
    /// A second instance of this NAME has acted unbound, so its mob-vs-mob lines are unattributable.
    /// STICKY for the life of the bind: the twin does not announce its departure either, so "it got
    /// better" is not a thing this log can say.
    pub ambiguous: bool,
    pub via: AllyVia,
    pub kind: AllyKind,
}

/// What a caster-less `<mob> has been charmed.` broadcast means for a THIRD PARTY.
pub enum AllyVerdict {
    /// Bound (or re-bound / restated) to a named charmer.
    Bind(AllyBind),
    /// Evidence exists but is unusable, and the reason is worth printing.
    Refuse(String),
    /// No third-party cast is armed at all — this model has nothing to say about the line.
    None,
}

/// A bind whose hold has run out, for the caller's processing line.
#[derive(Debug, Clone)]
pub struct AllyExpiry {
    pub name_key: String,
    pub display: String,
    pub charmer: String,
}

/// One `<Name> begins casting <Spell>.` line, as the ally model asks about it.
pub struct AllyCastLine<'a> {
    pub caster: &'a str,
    pub caster_key: &'a str,
    pub spell: &'a str,
    pub ts: i64,
    /// `EngineState::ally_caster_allowed` — the behavioural half of the caster gate.
    pub allowed: bool,
}

/// One `<PetName> says, 'My leader is <Player>.'` line about somebody else.
pub struct AllyLeaderLine<'a> {
    pub pet_key: &'a str,
    pub pet: &'a str,
    pub owner: &'a str,
    pub owner_key: &'a str,
    pub ts: i64,
    /// `CharmModel::ever_charmed(pet_key)` — THE CHARM-EVIDENCE HALF of the lifecycle question, and
    /// the caller's to answer for the same reason `allowed` is: the fact lives in the other charm
    /// model and this one does not reach across for it.
    pub ever_charmed: bool,
}

#[derive(Debug, Clone)]
struct AllyArm {
    charmer_key: String,
    charmer: String,
    spell_key: String,
    ts: i64,
    until: i64,
}

#[derive(Default)]
pub struct AllyCharms {
    /// Third-party charm casts in flight, KEYED BY CASTER rather than the single slot your own
    /// model uses: you cast one spell at a time, but a zone can hold three enchanters, and
    /// collapsing them would make every one of their broadcasts look like the last caster's.
    arms: JsMap<AllyArm>,
    /// nameKey → the live bind. Insertion-ordered because `bound_names` and `sweep` publish it.
    binds: JsMap<AllyBind>,
    /// Player-shaped names seen CASTING (any spell) plus every charmer this model has bound for.
    /// THE FRIENDLY SET FOR SOFT-HOSTILE PROOF AND NOTHING ELSE — never consulted for attribution,
    /// never merged into `known_players`, and it cannot move a point of YOUR damage. Its job is to
    /// stop a stranger's DPS being inflated with the damage their ex-pet is doing TO THEIR OWN
    /// GROUP, measured all over this corpus.
    friendlies: HashSet<String>,
    /// casterKey → ts this ally was last seen CASTING A PET SUMMON. The summon half of the
    /// lifecycle question, and deliberately the weaker half: no summon line ever names the pet it
    /// makes, so it can say "this ally has a summoned pet", never "THIS is it".
    ///
    /// SURVIVES A ZONE, like `friendlies` and unlike the binds: a summoned pet walks through the
    /// door with its owner, so the sighting is still true on the other side.
    summons: HashMap<String, i64>,
}

impl AllyCharms {
    pub fn new() -> Self {
        AllyCharms::default()
    }

    pub fn reset(&mut self) {
        self.arms.clear();
        self.binds.clear();
        self.friendlies.clear();
        self.summons.clear();
    }

    /// `<Name> begins casting <Spell>.` — remember a player-shaped caster, and arm the join when the
    /// spell is one that could have printed the charm broadcast.
    pub fn note_cast(&mut self, c: &AllyCastLine) {
        if !c.allowed || !is_player_shaped_name(c.caster) {
            return;
        }
        self.friendlies.insert(c.caster_key.to_string());
        // THE SUMMON SIGHTING (JOS-270), recorded BEFORE the charm-arm return so a summon is never
        // missed by falling through a test about a different spell family. It arms NOTHING — no
        // bind can come of it — and is read only when a leader say later asks what kind of creature
        // it is looking at.
        if is_pet_summon_spell(c.spell) {
            self.summons.insert(c.caster_key.to_string(), c.ts);
        }
        if !is_charm_broadcast_spell(c.spell) {
            return;
        }
        self.arms.insert(
            c.caster_key.to_string(),
            AllyArm {
                charmer_key: c.caster_key.to_string(),
                charmer: c.caster.to_string(),
                spell_key: spell_canon_key(c.spell),
                ts: c.ts,
                until: c.ts + arm_window_ms(c.spell),
            },
        );
    }

    /// A rostered group-mate is a friendly whatever their name looks like.
    pub fn note_friendly(&mut self, name_key: &str) {
        self.friendlies.insert(name_key.to_string());
    }

    /// `<mob> has been charmed.` that the OWNER's model already declined. CONSUMES the winning arm,
    /// for `charm_broadcast`'s reason: every charm spell in the DB is single-target, so one cast
    /// explains exactly one broadcast.
    pub fn broadcast(&mut self, name_key: &str, display: &str, ts: i64) -> AllyVerdict {
        self.prune_arms(ts);
        // THE LINE ITSELF IS CHARM EVIDENCE ABOUT THIS NAME, whatever it resolves to (JOS-270). If a
        // live bind of that name is wearing the summon lifecycle, the log has just contradicted it
        // and the charm endings come back. ONE DIRECTION ONLY, and it is the safe one: this can ADD
        // the break rule and the hold clock, never remove them.
        if let Some(live) = self.binds.get_mut(name_key) {
            if live.kind == AllyKind::Summon {
                live.kind = AllyKind::Charm;
                live.window_ms = DEFAULT_CHARM_DURATION_MS + DURATION_SLACK_MS;
                live.hold_until = ts.saturating_add(live.window_ms);
            }
        }
        let live: Vec<AllyArm> = self
            .arms
            .values()
            .filter(|a| ts >= a.ts && ts <= a.until)
            .cloned()
            .collect();
        if live.is_empty() {
            return AllyVerdict::None;
        }
        let casters: HashSet<&str> = live.iter().map(|a| a.charmer_key.as_str()).collect();
        if casters.len() > 1 {
            let n = casters.len();
            // Consume them ALL: a tie says none of these casts is explained by anything else
            // either, and leaving them armed would hand the NEXT broadcast to a spent cast.
            for a in &live {
                self.arms.remove(&a.charmer_key);
            }
            self.binds.remove(name_key);
            return AllyVerdict::Refuse(format!(
                "{n} casters armed - cannot tell whose charm this is"
            ));
        }
        let arm = live[live.len() - 1].clone();
        self.arms.remove(&arm.charmer_key);
        let prev = self.binds.get(name_key);
        let same = prev.is_some_and(|p| p.charmer_key == arm.charmer_key);
        let window_ms = provisional_window_ms(&arm.spell_key);
        let bind = AllyBind {
            name_key: name_key.to_string(),
            display: display.to_string(),
            charmer_key: arm.charmer_key.clone(),
            charmer: arm.charmer.clone(),
            bound_ts: if same {
                prev.expect("same").bound_ts
            } else {
                ts
            },
            window_ms,
            hold_until: ts.saturating_add(window_ms),
            // A RE-CHARM BY THE SAME CHARMER DOES NOT CLEAR AMBIGUITY. The twin that made the name
            // unreadable is still standing there, and neither its death nor a zone prints anything
            // this model could read as "you may resume".
            ambiguous: same && prev.expect("same").ambiguous,
            via: AllyVia::Cast,
            // A charm broadcast made this bind, so the creature is a charmed mob by construction —
            // there is no evidence question to ask here.
            kind: AllyKind::Charm,
        };
        self.binds.insert(name_key.to_string(), bind.clone());
        self.friendlies.insert(arm.charmer_key);
        AllyVerdict::Bind(bind)
    }

    /// `<PetName> says, 'My leader is <Player>.'` — the strongest ally bind there is, and the only
    /// one that reaches a stranger's SUMMONED pet.
    ///
    /// AND IT IS WHERE THE LIFECYCLE QUESTION IS ANSWERED, because it is the only bind whose
    /// creature the line does not state.
    pub fn bind_by_leader(&mut self, l: &AllyLeaderLine) -> AllyBind {
        let kind = self.classify(l);
        // A leader say names no spell, so a charm-class one gets the default charm duration — the
        // 16-minute figure every charm but two is listed at. A summon-class one gets no clock.
        let window_ms = if kind == AllyKind::Summon {
            NO_CLOCK
        } else {
            DEFAULT_CHARM_DURATION_MS + DURATION_SLACK_MS
        };
        let prev = self.binds.get(l.pet_key);
        let same = prev.is_some_and(|p| p.charmer_key == l.owner_key);
        let bind = AllyBind {
            name_key: l.pet_key.to_string(),
            display: l.pet.to_string(),
            charmer_key: l.owner_key.to_string(),
            charmer: l.owner.to_string(),
            bound_ts: match prev {
                Some(p) if same => p.bound_ts,
                _ => l.ts,
            },
            window_ms,
            hold_until: l.ts.saturating_add(window_ms),
            ambiguous: match prev {
                Some(p) if same => p.ambiguous,
                _ => false,
            },
            via: AllyVia::Leader,
            kind,
        };
        self.binds.insert(l.pet_key.to_string(), bind.clone());
        self.friendlies.insert(l.owner_key.to_string());
        bind
    }

    /// WHAT KIND OF CREATURE A LEADER SAY IS ABOUT — three rungs, strongest first.
    ///
    ///   1. CHARM EVIDENCE FOR THIS PET — a broadcast has named it. Keyed by the PET, so it wins.
    ///   2. SUMMON EVIDENCE FOR THIS OWNER — seen casting a pet summon at or before this say. Keyed
    ///      by the PERSON, so it is asked only when rung 1 is silent; a cast AFTER the say cannot
    ///      explain a pet that is already talking, hence the `<=`.
    ///   3. NEITHER ⇒ `Charm`, the safer default.
    fn classify(&self, l: &AllyLeaderLine) -> AllyKind {
        if l.ever_charmed {
            return AllyKind::Charm;
        }
        match self.summons.get(l.owner_key) {
            Some(&at) if at <= l.ts => AllyKind::Summon,
            _ => AllyKind::Charm,
        }
    }

    /// The live bind for a name, or none.
    pub fn bind_of(&self, name_key: &str) -> Option<&AllyBind> {
        self.binds.get(name_key)
    }

    /// THE BOUND NAME JUST ACTED — slide its hold. A pet that is still swinging has not stopped
    /// being a pet, whatever a spell database says its charm was listed at.
    ///
    /// IT SLIDES ON APPEARANCE, NOT ON CREDIT, and the difference is the AMBIGUOUS bind: a twin has
    /// made the name unreadable so the model books nothing from it, but the name is demonstrably
    /// still acting (that is *why* it is unreadable) and reaping it for silence would be false.
    pub fn note_activity(&mut self, name_key: &str, ts: i64) {
        let Some(b) = self.binds.get_mut(name_key) else {
            return;
        };
        let next = ts.saturating_add(b.window_ms);
        if next > b.hold_until {
            b.hold_until = next;
        }
    }

    /// The bind a line may be CREDITED to: live and unambiguous.
    pub fn creditable(&self, name_key: &str) -> Option<&AllyBind> {
        self.binds.get(name_key).filter(|b| !b.ambiguous)
    }

    /// True when `name_key` is on the friendly side of an ally charm — a caster we have seen, or a
    /// charmer we have bound for. NEVER an attribution test.
    pub fn is_friendly(&self, name_key: &str) -> bool {
        self.friendlies.contains(name_key)
    }

    /// True while no bind is live (lets the caller skip the per-line work entirely).
    pub fn idle(&self) -> bool {
        self.binds.is_empty()
    }

    /// THE TWIN REFUSAL. Sticky — see `AllyBind::ambiguous`.
    pub fn mark_ambiguous(&mut self, name_key: &str) -> bool {
        let Some(b) = self.binds.get_mut(name_key) else {
            return false;
        };
        if b.ambiguous {
            return false;
        }
        b.ambiguous = true;
        true
    }

    /// Drop a bind unconditionally — death, a zone, your own charm taking the same mob, a pet claim.
    /// Every one of these ends BOTH kinds: a dead pet is not a pet whoever owned it, and a name that
    /// has become yours cannot also be somebody else's.
    ///
    /// THE SOFT-HOSTILE PROOF DOES NOT COME THROUGH HERE — it is the one ending that depends on
    /// which creature this is.
    pub fn release(&mut self, name_key: &str) -> Option<AllyBind> {
        let b = self.binds.get(name_key).cloned();
        if b.is_some() {
            self.binds.remove(name_key);
        }
        b
    }

    /// THE SOFT-HOSTILE PROOF, APPLIED — the bound pet has swung at a friendly. Returns the bind it
    /// ended, or `None` when the swing proves nothing.
    ///
    /// IT PROVES NOTHING ABOUT A `Summon` BIND. A charmed mob turning on its charmer's side is a
    /// charm ending; a summoned pet swinging at a name that happens to be on the friendly list is a
    /// NAME COLLISION — which is exactly what one report printed (the ally's pet hit `a wan ghoul
    /// knight`, the name of the reporter's OWN charm pet) and exactly what cost 29 percent of that
    /// pet's damage.
    ///
    /// IT READS `kind`, NEVER `via`: a charm pet answers `/pet who leader` too.
    pub fn soft_hostile(&mut self, name_key: &str) -> Option<AllyBind> {
        let b = self.binds.get(name_key)?;
        if b.kind == AllyKind::Summon {
            return None;
        }
        let b = b.clone();
        self.binds.remove(name_key);
        Some(b)
    }

    /// Charm cannot survive a zone, and neither can an arm. The FRIENDLY set is kept — it is about
    /// PEOPLE, and a person does not stop being one because you walked through a door — and so is
    /// the SUMMON SIGHTING, because the pet really did walk through with its owner.
    pub fn zone(&mut self) {
        self.arms.clear();
        self.binds.clear();
    }

    /// Binds whose pet has GONE SILENT for a whole window as of `now`. Removing them is this call's
    /// side effect. A `Summon` bind's `hold_until` is `NO_CLOCK` and is never in the answer.
    pub fn sweep(&mut self, now: i64) -> Vec<AllyExpiry> {
        let out: Vec<AllyExpiry> = self
            .binds
            .values()
            .filter(|b| b.hold_until <= now)
            .map(|b| AllyExpiry {
                name_key: b.name_key.clone(),
                display: b.display.clone(),
                charmer: b.charmer.clone(),
            })
            .collect();
        for e in &out {
            self.binds.remove(&e.name_key);
        }
        out
    }

    /// Display names of the live ally pets, newest last.
    pub fn bound_names(&self) -> Vec<String> {
        self.binds.values().map(|b| b.display.clone()).collect()
    }

    fn prune_arms(&mut self, now: i64) {
        let stale: Vec<String> = self
            .arms
            .iter()
            .filter(|(_, a)| a.until < now)
            .map(|(k, _)| k.to_string())
            .collect();
        for k in stale {
            self.arms.remove(&k);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cast<'a>(caster: &'a str, key: &'a str, spell: &'a str, ts: i64) -> AllyCastLine<'a> {
        AllyCastLine {
            caster,
            caster_key: key,
            spell,
            ts,
            allowed: true,
        }
    }

    /// A NON-PLAYER-SHAPED caster never arms the join — the log holds `A fire giant warrior begins
    /// singing Solon's Bewitching Bravura.`, and a rule without the name shape files a fire giant as
    /// a charmer.
    #[test]
    fn a_mob_shaped_caster_never_arms_the_join() {
        let mut a = AllyCharms::new();
        a.note_cast(&cast(
            "a fire giant warrior",
            "a fire giant warrior",
            "Allure",
            0,
        ));
        assert!(matches!(
            a.broadcast("a rock golem", "a rock golem", 1_000),
            AllyVerdict::None
        ));
    }

    #[test]
    fn one_armed_player_caster_binds_the_broadcast_to_them() {
        let mut a = AllyCharms::new();
        a.note_cast(&cast("Scooba", "scooba", "Allure", 0));
        let AllyVerdict::Bind(b) = a.broadcast("a rock golem", "a rock golem", 3_000) else {
            panic!("expected a bind");
        };
        assert_eq!(b.charmer, "Scooba");
        assert_eq!(b.kind, AllyKind::Charm);
        assert!(a.is_friendly("scooba"));
    }

    /// TWO CASTERS ARMED OVER ONE BROADCAST is refused, and every one of their arms is consumed so
    /// the NEXT broadcast cannot ride a spent cast in.
    #[test]
    fn a_two_caster_tie_is_refused_and_spends_both_arms() {
        let mut a = AllyCharms::new();
        a.note_cast(&cast("Paladrial", "paladrial", "Cajoling Whispers III", 0));
        a.note_cast(&cast("Satya", "satya", "Cajoling Whispers III", 0));
        assert!(matches!(
            a.broadcast("a lava duct crawler", "a lava duct crawler", 3_000),
            AllyVerdict::Refuse(_)
        ));
        assert!(matches!(
            a.broadcast("a lava duct crawler", "a lava duct crawler", 3_000),
            AllyVerdict::None
        ));
    }

    /// The bard's charm can never be the cast a broadcast resolved.
    #[test]
    fn a_bard_charm_does_not_arm_the_join() {
        let mut a = AllyCharms::new();
        a.note_cast(&cast("Enzee", "enzee", "Solon's Bewitching Bravura", 0));
        assert!(matches!(
            a.broadcast("a rock golem", "a rock golem", 1_000),
            AllyVerdict::None
        ));
        // …but the caster is still remembered as a friendly, which is the other half of noteCast.
        assert!(a.is_friendly("enzee"));
    }

    /// THE HOLD SLIDES ON EVIDENCE — a pet still swinging keeps its row past the DB's figure.
    #[test]
    fn activity_slides_the_hold_and_silence_reaps_it() {
        let mut a = AllyCharms::new();
        a.note_cast(&cast("Scooba", "scooba", "Allure", 0));
        a.broadcast("a rock golem", "a rock golem", 3_000);
        let window = provisional_window_ms("Allure");
        a.note_activity("a rock golem", window);
        assert!(a.sweep(3_000 + window).is_empty());
        assert_eq!(a.sweep(window + window).len(), 1);
    }

    /// A SUMMON bind has no clock and no break rule; a CHARM bind has both.
    #[test]
    fn a_summon_bind_is_exempt_from_the_clock_and_the_break() {
        let mut a = AllyCharms::new();
        a.note_cast(&cast("Wemby", "wemby", "Kintaz's Animation", 0));
        a.bind_by_leader(&AllyLeaderLine {
            pet_key: "gasarn",
            pet: "Gasarn",
            owner: "Wemby",
            owner_key: "wemby",
            ts: 1_000,
            ever_charmed: false,
        });
        assert_eq!(a.bind_of("gasarn").expect("bound").kind, AllyKind::Summon);
        assert!(a.soft_hostile("gasarn").is_none());
        assert!(a.sweep(i64::MAX - 1).is_empty());
    }

    /// CHARM EVIDENCE FOR THE PET OUTRANKS SUMMON EVIDENCE FOR THE OWNER.
    #[test]
    fn a_pet_a_broadcast_has_named_is_a_charm_bind_even_beside_a_summon_sighting() {
        let mut a = AllyCharms::new();
        a.note_cast(&cast("Wemby", "wemby", "Kintaz's Animation", 0));
        let b = a.bind_by_leader(&AllyLeaderLine {
            pet_key: "a rock golem",
            pet: "a rock golem",
            owner: "Wemby",
            owner_key: "wemby",
            ts: 1_000,
            ever_charmed: true,
        });
        assert_eq!(b.kind, AllyKind::Charm);
        assert!(a.soft_hostile("a rock golem").is_some());
    }

    /// A LATER BROADCAST CONTRADICTS A SUMMON LIFECYCLE, one direction only.
    #[test]
    fn a_broadcast_upgrades_a_summon_bind_to_the_charm_lifecycle() {
        let mut a = AllyCharms::new();
        a.note_cast(&cast("Wemby", "wemby", "Kintaz's Animation", 0));
        a.bind_by_leader(&AllyLeaderLine {
            pet_key: "a rock golem",
            pet: "a rock golem",
            owner: "Wemby",
            owner_key: "wemby",
            ts: 1_000,
            ever_charmed: false,
        });
        // No arm is live, so this resolves to nothing — and still moves the lifecycle.
        a.broadcast("a rock golem", "a rock golem", 2_000);
        assert_eq!(
            a.bind_of("a rock golem").expect("bound").kind,
            AllyKind::Charm
        );
    }

    /// THE TWIN REFUSAL is sticky, and a re-charm by the same charmer does not clear it.
    #[test]
    fn ambiguity_survives_a_recharm_by_the_same_charmer() {
        let mut a = AllyCharms::new();
        a.note_cast(&cast("Scooba", "scooba", "Allure", 0));
        a.broadcast("a rock golem", "a rock golem", 3_000);
        assert!(a.mark_ambiguous("a rock golem"));
        assert!(!a.mark_ambiguous("a rock golem"));
        assert!(a.creditable("a rock golem").is_none());
        a.note_cast(&cast("Scooba", "scooba", "Allure", 10_000));
        a.broadcast("a rock golem", "a rock golem", 13_000);
        assert!(a.creditable("a rock golem").is_none());
    }
}
