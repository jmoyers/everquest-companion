//! Charm / crowd-control ownership: which `<mob> has been charmed.` broadcast is OURS.
//!
//! Charm and mez broadcasts are zone-wide and name no caster, so binding one unconditionally adopts
//! a stranger's pet. `You begin casting <Spell>.` prints for the player alone, so an own cast ARMS
//! the model and a broadcast inside the arm is ours.
//!
//! Two windows are the spell's own numbers rather than tuned constants. The arm is the spell's cast
//! time plus a slack, because the observed broadcast delay tracks cast time (Charm, a 2400 ms cast,
//! lands 0-3 s later; Allure, 6000 ms, 2-5 s). The demotion horizon is the charm's own duration,
//! because a charmed pet routinely stands idle for minutes between orders.
//!
//! Pure and clock-injected: no wall clock, no engine state, no I/O. Every method takes the log
//! timestamp it is reasoning at, so a replay and a live tail behave identically.

use crate::combat::spellfacts::{
    arm_window_ms, is_cc_spell, is_charm_spell, is_pet_only_spell, provisional_window_ms,
    PROMOTE_MS,
};
use eqlog::names::spell_canon_key;
use std::collections::{HashMap, HashSet};

/// What a `<mob> has been charmed.` broadcast means for US.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CharmVerdict {
    Own,
    Foreign,
}

/// A provisional bind that has aged out and must be unbound.
#[derive(Debug, Clone)]
pub struct CharmDemotion {
    pub name_key: String,
    pub display: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ArmKind {
    Charm,
    Cc,
    PetBuff,
}

#[derive(Debug, Clone)]
struct Arm {
    kind: ArmKind,
    spell_key: String,
    ts: i64,
    until: i64,
}

#[derive(Debug, Clone)]
struct Provisional {
    until: i64,
    display: String,
}

#[derive(Default)]
pub struct CharmModel {
    /// The single pending own cast. You cast one spell at a time, so this is not a map.
    arm: Option<Arm>,
    /// nameKey → binds awaiting corroboration. Insertion order is the sweep's report order.
    provisional: Vec<(String, Provisional)>,
    /// nameKey of binds proven ours. Never auto-expires.
    confirmed: HashSet<String>,
    /// nameKey → ts of a charm broadcast we did NOT bind, for the PROMOTE path.
    observed: HashMap<String, i64>,
    /// Every nameKey a charm broadcast has ever named, ours or not. A name the zone has seen
    /// charmed is a mob whatever else it looks like. Session-scoped and never pruned.
    seen_charmed: HashSet<String>,
}

impl CharmModel {
    pub fn new() -> Self {
        CharmModel::default()
    }

    pub fn reset(&mut self) {
        self.arm = None;
        self.provisional.clear();
        self.confirmed.clear();
        self.observed.clear();
        self.seen_charmed.clear();
    }

    /// True if a charm broadcast has ever named this entity (ours or a stranger's).
    pub fn ever_charmed(&self, name_key: &str) -> bool {
        self.seen_charmed.contains(name_key)
    }

    /// `You begin casting <Spell>.` — arms the model, or clears a stale arm when the player moves
    /// on to an unrelated spell.
    pub fn note_cast_begin(&mut self, spell: &str, ts: i64) {
        let kind = if is_charm_spell(spell) {
            ArmKind::Charm
        } else if is_cc_spell(spell) {
            ArmKind::Cc
        } else if is_pet_only_spell(spell) {
            ArmKind::PetBuff
        } else {
            self.arm = None;
            return;
        };
        self.arm = Some(Arm {
            kind,
            spell_key: spell_canon_key(spell),
            ts,
            until: ts + arm_window_ms(spell),
        });
    }

    /// `Your <Spell> spell fizzles!` / `is interrupted.` / `<mob> resisted your <Spell>!` — the
    /// armed cast did not land, so nothing it might have resolved is ours. Only the ARMED spell
    /// disarms.
    pub fn note_cast_failed(&mut self, spell: &str, ts: i64) {
        let key = spell_canon_key(spell);
        if self
            .arm
            .as_ref()
            .is_some_and(|a| a.spell_key == key && ts >= a.ts)
        {
            self.arm = None;
        }
    }

    /// `<mob> has been charmed.` — is it ours? Consumes the arm on a hit: every charm spell in the
    /// DB is single-target, so a second broadcast in the same window is somebody else's.
    pub fn charm_broadcast(&mut self, name_key: &str, display: &str, ts: i64) -> CharmVerdict {
        self.seen_charmed.insert(name_key.to_string());
        if self.confirmed.contains(name_key) || self.provisional_has(name_key) {
            return CharmVerdict::Own;
        }
        let hit = match &self.arm {
            Some(a) if a.kind == ArmKind::Charm && ts >= a.ts && ts <= a.until => {
                Some(a.spell_key.clone())
            }
            _ => None,
        };
        if let Some(spell_key) = hit {
            self.arm = None;
            let until = ts + provisional_window_ms(&spell_key);
            self.provisional.push((
                name_key.to_string(),
                Provisional {
                    until,
                    display: display.to_string(),
                },
            ));
            return CharmVerdict::Own;
        }
        self.observed.insert(name_key.to_string(), ts);
        CharmVerdict::Foreign
    }

    /// `<mob> has been mesmerized./enthralled./entranced./ensnared.` — is it ours? Does NOT consume
    /// the arm: one AE mez prints one broadcast per mob it lands on, and one cast must gate them all.
    pub fn cc_broadcast(&self, ts: i64) -> bool {
        self.arm
            .as_ref()
            .is_some_and(|a| a.kind == ArmKind::Cc && ts >= a.ts && ts <= a.until)
    }

    /// A NAMED buff landing (`<Name> goes berserk.`) — was it YOUR pet-only spell resolving?
    ///
    /// The message is not the gate: one landing message resolves to several spells and most are
    /// ordinary buffs, so the armed cast must be AMONG the candidates. Consumes the arm on a hit —
    /// one cast is one bind.
    ///
    /// The candidate list comes from the spell DB, so a pet-only spell whose third-person message
    /// the suffix table cannot key is in no candidate list and its pet never binds.
    pub fn pet_buff_landing(&mut self, spell_names: &[String], ts: i64) -> bool {
        let Some(a) = &self.arm else { return false };
        if a.kind != ArmKind::PetBuff || ts < a.ts || ts > a.until {
            return false;
        }
        if !spell_names
            .iter()
            .any(|k| spell_canon_key(k) == a.spell_key)
        {
            return false;
        }
        self.arm = None;
        true
    }

    /// Pet-shaped evidence for `name_key`: its own outgoing damage or miss, its resisted cast, its
    /// `… Master.` tell, the owner healing it, or YOUR charm spell wearing off it. Promotes a
    /// provisional bind to confirmed.
    pub fn note_pet_evidence(&mut self, name_key: &str) {
        self.take_provisional(name_key);
        self.confirmed.insert(name_key.to_string());
        self.observed.remove(name_key);
    }

    /// A `<Name> told you, '… Master.'` tell arrived for a name we saw charmed but declined to
    /// bind. The tell is ownership-definitive and pet-only, so this promotes the name — as a
    /// CHARMED pet, never a summoned one. Returns true when the caller should bind it as a charm.
    pub fn claim_is_charmed(&mut self, name_key: &str, ts: i64) -> bool {
        let Some(&seen) = self.observed.get(name_key) else {
            return false;
        };
        if ts - seen > PROMOTE_MS {
            return false;
        }
        self.observed.remove(name_key);
        self.confirmed.insert(name_key.to_string());
        true
    }

    /// Forget a name entirely (death, un-charm, left behind on a zone).
    pub fn release(&mut self, name_key: &str) {
        self.take_provisional(name_key);
        self.confirmed.remove(name_key);
        self.observed.remove(name_key);
    }

    /// Charm cannot survive a zone. Keep only the pets that actually walked through with you (the
    /// summoned survivors the world model hands back) and drop every pending arm and sighting.
    pub fn zone(&mut self, survivor_keys: &[String]) {
        self.arm = None;
        self.provisional.clear();
        self.observed.clear();
        let keep: HashSet<&str> = survivor_keys.iter().map(String::as_str).collect();
        self.confirmed.retain(|k| keep.contains(k.as_str()));
    }

    /// True when the model has nothing that could expire — lets the caller skip the sweep.
    pub fn idle(&self) -> bool {
        self.provisional.is_empty()
    }

    /// Provisional binds whose corroboration window has closed as of `now`. Removing them from the
    /// model is this call's side effect; unbinding them in the world is the caller's.
    pub fn sweep(&mut self, now: i64) -> Vec<CharmDemotion> {
        let mut out = Vec::new();
        for (name_key, v) in &self.provisional {
            if v.until > now {
                continue;
            }
            out.push(CharmDemotion {
                name_key: name_key.clone(),
                display: v.display.clone(),
            });
        }
        self.provisional.retain(|(_, v)| v.until > now);
        out
    }

    fn provisional_has(&self, name_key: &str) -> bool {
        self.provisional.iter().any(|(k, _)| k == name_key)
    }

    fn take_provisional(&mut self, name_key: &str) -> bool {
        let before = self.provisional.len();
        self.provisional.retain(|(k, _)| k != name_key);
        before != self.provisional.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The arm window is the spell's own cast time: `Charm` is a 2400 ms cast, so a broadcast three
    /// seconds later is still ours and one at four is not.
    #[test]
    fn a_broadcast_binds_only_inside_the_spells_own_arm_window() {
        let mut m = CharmModel::new();
        m.note_cast_begin("Charm", 0);
        assert_eq!(
            m.charm_broadcast("a rock golem", "a rock golem", 3_000),
            CharmVerdict::Own
        );

        let mut m = CharmModel::new();
        m.note_cast_begin("Charm", 0);
        assert_eq!(
            m.charm_broadcast("a rock golem", "a rock golem", 4_000),
            CharmVerdict::Foreign
        );
    }

    /// Charm consumes the arm (single-target); CC does not (one AE mez prints one line per mob).
    #[test]
    fn charm_consumes_the_arm_and_cc_does_not() {
        let mut m = CharmModel::new();
        m.note_cast_begin("Charm", 0);
        assert_eq!(m.charm_broadcast("a", "a", 1_000), CharmVerdict::Own);
        assert_eq!(m.charm_broadcast("b", "b", 1_000), CharmVerdict::Foreign);

        let mut m = CharmModel::new();
        m.note_cast_begin("Mesmerization VI", 0);
        assert!(m.cc_broadcast(1_000));
        assert!(m.cc_broadcast(1_000));
    }

    /// A cast that resolved to nothing cannot be what a broadcast resolved, but only the ARMED
    /// spell disarms.
    #[test]
    fn only_the_armed_spells_failure_disarms() {
        let mut m = CharmModel::new();
        m.note_cast_begin("Charm", 0);
        m.note_cast_failed("Beguile", 500);
        assert_eq!(m.charm_broadcast("a", "a", 1_000), CharmVerdict::Own);

        let mut m = CharmModel::new();
        m.note_cast_begin("Charm", 0);
        m.note_cast_failed("Charm", 500);
        assert_eq!(m.charm_broadcast("a", "a", 1_000), CharmVerdict::Foreign);
    }

    /// An unrelated cast clears a stale arm — you cast one spell at a time.
    #[test]
    fn an_unrelated_cast_clears_the_arm() {
        let mut m = CharmModel::new();
        m.note_cast_begin("Charm", 0);
        m.note_cast_begin("Minor Healing", 100);
        assert_eq!(m.charm_broadcast("a", "a", 500), CharmVerdict::Foreign);
    }

    /// The demotion horizon is the spell's own duration, and evidence ends the wait early.
    #[test]
    fn an_uncorroborated_bind_demotes_at_its_spells_duration_and_evidence_stops_it() {
        let mut m = CharmModel::new();
        m.note_cast_begin("Charm", 0);
        m.charm_broadcast("a rock golem", "a rock golem", 1_000);
        let horizon = 1_000 + provisional_window_ms("Charm");
        assert!(m.sweep(horizon - 1).is_empty());
        let out = m.sweep(horizon);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].name_key, "a rock golem");

        let mut m = CharmModel::new();
        m.note_cast_begin("Charm", 0);
        m.charm_broadcast("a rock golem", "a rock golem", 1_000);
        m.note_pet_evidence("a rock golem");
        assert!(m.idle());
        assert!(m.sweep(horizon + 1_000_000).is_empty());
    }

    /// A foreign broadcast is remembered, and a later Master tell promotes it inside PROMOTE_MS.
    #[test]
    fn a_foreign_sighting_is_promotable_by_the_tell_for_ten_minutes() {
        let mut m = CharmModel::new();
        m.charm_broadcast("a rock golem", "a rock golem", 0);
        assert!(m.ever_charmed("a rock golem"));
        assert!(!m.claim_is_charmed("a rock golem", PROMOTE_MS + 1));

        let mut m = CharmModel::new();
        m.charm_broadcast("a rock golem", "a rock golem", 0);
        assert!(m.claim_is_charmed("a rock golem", PROMOTE_MS));
        // …and only once.
        assert!(!m.claim_is_charmed("a rock golem", PROMOTE_MS));
    }

    /// A zone keeps only the pets that walked through with you.
    #[test]
    fn a_zone_keeps_only_the_survivors() {
        let mut m = CharmModel::new();
        m.note_pet_evidence("vebarn");
        m.note_pet_evidence("a rock golem");
        m.zone(&["vebarn".to_string()]);
        assert!(m.confirmed.contains("vebarn"));
        assert!(!m.confirmed.contains("a rock golem"));
    }
}
