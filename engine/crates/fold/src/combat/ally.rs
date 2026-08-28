//! The ally-charm model: whose pet is that, when it is not yours?
//!
//! `<mob> has been charmed.` names no caster, so a third party's charm binds only on evidence that
//! names both ends — a charm-family cast by a player-shaped name arming a window that exactly one
//! caster-less broadcast falls inside, or `<PetName> says, 'My leader is <Player>.'`. The caster
//! gate is the defence of the first: mobs cast charm songs at you (`A fire giant warrior begins
//! singing Solon's Bewitching Bravura.`), so the shape of the NAME is required too.
//!
//! The lifecycle keys on `kind`, never on which line bound it — a charm pet answers `/pet who
//! leader` as readily as a summoned one. A `Summon` bind is exempt from the soft-hostile break (no
//! charm to break) and from the hold clock (no spell to derive one from); `Charm` is the default
//! when neither evidence exists, because wrongly dropping the break rule can credit a re-hostile
//! mob to a player.
//!
//! Four endings, each a line the log prints: the bound pet swings at a friendly (landed or not — the
//! intent is the proof), pet death, a re-charm, and silence for a whole window. The hold SLIDES on
//! evidence rather than expiring at the spell's listed duration, because AAs and focus effects
//! extend a charm well past the DB figure. Nothing is retro-uncredited: damage booked before a proof
//! stays booked.
//!
//! Refused, because the honest answer is nothing: an attacker whose name equals its target's, two
//! charmers armed over one broadcast, a bard charm (a different sentence, never the cast a broadcast
//! resolved), a non-player-shaped caster.
//!
//! Pure + clock-injected, like `charm.rs`.

use crate::combat::spellfacts::{
    arm_window_ms, is_charm_broadcast_spell, is_pet_summon_spell, is_player_shaped_name,
    provisional_window_ms, DEFAULT_CHARM_DURATION_MS, DURATION_SLACK_MS,
};
use crate::jsmap::JsMap;
use eqlog::names::spell_canon_key;
use std::collections::{HashMap, HashSet};

/// What the evidence says this creature is, and therefore which endings apply to it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AllyKind {
    Charm,
    Summon,
}

/// Which line bound it. The processing line reads it; it is not the lifecycle discriminant.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AllyVia {
    Cast,
    Leader,
}

/// `Number.POSITIVE_INFINITY` as a log clock can hold it — a `Summon` bind has no clock at all.
/// Every arithmetic site below saturates rather than wrapping, which is what makes
/// `note_activity`'s `ts + window_ms` the no-op the TS gets for free.
const NO_CLOCK: i64 = i64::MAX;

/// One live third-party charm bind.
#[derive(Debug, Clone)]
pub struct AllyBind {
    pub name_key: String,
    /// The pet's display name as the charm broadcast spelled it (lowercase article, world-model law
    /// 2) — never the sentence-cased spelling a damage line happens to carry.
    pub display: String,
    pub charmer_key: String,
    pub charmer: String,
    pub bound_ts: i64,
    /// How long this name may be quiet and still plausibly be bound, slid forward by `note_activity`
    /// on every line the name acts on. `NO_CLOCK` when `kind` is `Summon`, so "no clock" and "still
    /// fighting" need no second code path.
    pub hold_until: i64,
    /// The window `hold_until` is slid by. Held on the bind rather than recomputed, because the
    /// spell that explains a bind is knowable only at the moment it is made.
    pub window_ms: i64,
    /// A second instance of this name has acted unbound, so its mob-vs-mob lines are unattributable.
    /// Sticky for the life of the bind: the twin does not announce its departure either.
    pub ambiguous: bool,
    pub via: AllyVia,
    pub kind: AllyKind,
}

/// What a caster-less `<mob> has been charmed.` broadcast means for a third party.
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
    /// `CharmModel::ever_charmed(pet_key)` — the charm-evidence half of the lifecycle question. The
    /// caller answers it because the fact lives in the other charm model, which this one never
    /// reaches across for.
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
    /// Third-party charm casts in flight, keyed by caster rather than the single slot your own model
    /// uses: a zone can hold three enchanters, and collapsing them would make every one of their
    /// broadcasts look like the last caster's.
    arms: JsMap<AllyArm>,
    /// nameKey → the live bind. Insertion-ordered because `bound_names` and `sweep` publish it.
    binds: JsMap<AllyBind>,
    /// Player-shaped names seen casting (any spell) plus every charmer this model has bound for.
    /// For the soft-hostile proof and nothing else — never attribution, never merged into
    /// `known_players`. Its job is to stop a stranger's DPS being inflated with the damage their
    /// ex-pet is doing to their own group.
    friendlies: HashSet<String>,
    /// casterKey → ts this ally was last seen casting a pet summon. The weaker half of the lifecycle
    /// question on purpose: no summon line names the pet it makes, so it can say "this ally has a
    /// summoned pet", never "this is it".
    ///
    /// Survives a zone, like `friendlies` and unlike the binds: a summoned pet walks through the
    /// door with its owner.
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
        // Recorded before the charm-arm return so a summon is never missed by falling through a
        // test about a different spell family. It arms nothing; only a later leader say reads it.
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

    /// `<mob> has been charmed.` that the owner's model already declined. Consumes the winning arm:
    /// every charm spell in the DB is single-target, so one cast explains exactly one broadcast.
    pub fn broadcast(&mut self, name_key: &str, display: &str, ts: i64) -> AllyVerdict {
        self.prune_arms(ts);
        // The line itself is charm evidence about this name, whatever it resolves to: a live bind
        // wearing the summon lifecycle has just been contradicted. One direction only, and it is the
        // safe one — this can add the break rule and the hold clock, never remove them.
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
            // Consume them all: a tie says none of these casts is explained by anything else
            // either, and leaving them armed would hand the next broadcast to a spent cast.
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
            // A re-charm by the same charmer does not clear ambiguity: the twin that made the name
            // unreadable is still standing there, and nothing the log prints says otherwise.
            ambiguous: same && prev.expect("same").ambiguous,
            via: AllyVia::Cast,
            // A charm broadcast made this bind, so the creature is a charmed mob by construction.
            kind: AllyKind::Charm,
        };
        self.binds.insert(name_key.to_string(), bind.clone());
        self.friendlies.insert(arm.charmer_key);
        AllyVerdict::Bind(bind)
    }

    /// `<PetName> says, 'My leader is <Player>.'` — the strongest ally bind, and the only one that
    /// reaches a stranger's summoned pet. It is also where the lifecycle question is answered,
    /// because it is the only bind whose creature the line does not state.
    pub fn bind_by_leader(&mut self, l: &AllyLeaderLine) -> AllyBind {
        let kind = self.classify(l);
        // A leader say names no spell, so a charm-class bind gets the default charm duration (the
        // 16-minute figure every charm but two is listed at). A summon-class one gets no clock.
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

    /// What kind of creature a leader say is about — three rungs, strongest first.
    ///
    ///   1. Charm evidence for this PET: a broadcast has named it. Keyed by the pet, so it wins.
    ///   2. Summon evidence for this OWNER: seen casting a pet summon at or before the say. Keyed by
    ///      the person, so it is asked only when rung 1 is silent; a cast after the say cannot
    ///      explain a pet already talking, hence the `<=`.
    ///   3. Neither ⇒ `Charm`, the safer default.
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

    /// The bound name just acted — slide its hold. A pet still swinging has not stopped being a pet,
    /// whatever a spell database lists its charm at.
    ///
    /// It slides on APPEARANCE, not on credit: an ambiguous bind books nothing, but the name is
    /// demonstrably still acting, and reaping it for silence would be false.
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
    /// charmer we have bound for. Never an attribution test.
    pub fn is_friendly(&self, name_key: &str) -> bool {
        self.friendlies.contains(name_key)
    }

    /// True while no bind is live (lets the caller skip the per-line work entirely).
    pub fn idle(&self) -> bool {
        self.binds.is_empty()
    }

    /// The twin refusal. Sticky — see `AllyBind::ambiguous`.
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
    /// Every one of these ends both kinds: a dead pet is not a pet whoever owned it, and a name that
    /// has become yours cannot also be somebody else's.
    ///
    /// The soft-hostile proof does not come through here: it is the one ending that depends on which
    /// creature this is.
    pub fn release(&mut self, name_key: &str) -> Option<AllyBind> {
        let b = self.binds.get(name_key).cloned();
        if b.is_some() {
            self.binds.remove(name_key);
        }
        b
    }

    /// The soft-hostile proof, applied — the bound pet has swung at a friendly. Returns the bind it
    /// ended, or `None` when the swing proves nothing.
    ///
    /// It proves nothing about a `Summon` bind: a summoned pet swinging at a name that happens to be
    /// on the friendly list is a name collision, not a charm ending.
    ///
    /// It reads `kind`, never `via`: a charm pet answers `/pet who leader` too.
    pub fn soft_hostile(&mut self, name_key: &str) -> Option<AllyBind> {
        let b = self.binds.get(name_key)?;
        if b.kind == AllyKind::Summon {
            return None;
        }
        let b = b.clone();
        self.binds.remove(name_key);
        Some(b)
    }

    /// Charm cannot survive a zone, and neither can an arm. The friendly set and the summon sighting
    /// are kept: they are about people, and a summoned pet walks through the door with its owner.
    pub fn zone(&mut self) {
        self.arms.clear();
        self.binds.clear();
    }

    /// Binds whose pet has gone silent for a whole window as of `now`; removing them is this call's
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

    /// A non-player-shaped caster never arms the join: the log holds `A fire giant warrior begins
    /// singing Solon's Bewitching Bravura.`, which a rule without the name shape would file as a
    /// charm.
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

    /// Two casters armed over one broadcast is refused, and both arms are consumed so the next
    /// broadcast cannot ride a spent cast in.
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
        // …but the caster is still remembered as a friendly, the other half of `note_cast`.
        assert!(a.is_friendly("enzee"));
    }

    /// The hold slides on evidence: a pet still swinging keeps its row past the DB's figure.
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

    /// A `Summon` bind has no clock and no break rule; a `Charm` bind has both.
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

    /// Charm evidence for the pet outranks summon evidence for the owner.
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

    /// A later broadcast contradicts a summon lifecycle, one direction only.
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

    /// The twin refusal is sticky, and a re-charm by the same charmer does not clear it.
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
