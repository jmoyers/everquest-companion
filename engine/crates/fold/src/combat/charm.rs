//! THE CHARM / CROWD-CONTROL OWNERSHIP MODEL — `src/main/combat/charmModel.ts`.
//!
//! ── WHY IT EXISTS: THE TWO LINES THAT BIND A PET NAME NOBODY ───────────────────────────────────
//!
//! `<mob> has been charmed.` and `<mob> has been mesmerized.` are BROADCASTS — the spell DB records
//! them as `Someone has been charmed.` / `Someone has been mesmerized.`, i.e. the wiki's
//! `msg_cast_on_other` — so every player in the zone sees them and NONE of them names a caster. The
//! engine used to bind every charm broadcast into the attribution set unconditionally and open a
//! 120-second CC hold on every mez broadcast, which meant another enchanter's pet became YOUR pet
//! and another enchanter's mez pinned YOUR fight open.
//!
//! MEASURED on the real log (2026-08-04): 381 charm broadcasts — 366 the owner cast, 15 cast by ten
//! OTHER players; 2,899 CC broadcasts — 2,797 correlate with an own cast, 102 do not. One foreign
//! block (the player Scooba's Allure VII pets) put 91 hits / 10,016 points of a stranger's pet
//! damage on the owner's meter in seven minutes, entered the PLAYER Scooba into `engaged` as a
//! hostile, booked his self-heals as enemy healing, and — because his presence kept refreshing —
//! merged three separate pulls into one 214-second segment.
//!
//! ── THE RULE: A BROADCAST BINDS ONLY WHEN IT RESOLVES ONE OF THE OWNER'S OWN CASTS ─────────────
//!
//! `You begin casting <Spell>.` is printed for the player and NOBODY else. So an own cast of a
//! charm/CC spell ARMS the model for that spell's own cast time plus a slack, and a broadcast inside
//! the arm is ours.
//!
//! THE ARM WINDOW IS PER-SPELL, NOT A FLAT CONSTANT, and the measurement overturned the briefed
//! "<= 2s". Delta from `You begin casting X.` to the broadcast, whole log: Charm (2400 ms cast) 0–3
//! s over 95 samples, Beguile (3500) 1–4 over 53, Cajoling Whispers (5500) 1–6 over 59, Allure
//! (6000) 2–5 over 159. The delta tracks the SPELL'S CAST TIME. A flat 2-second window would have
//! bound Charm and missed 271 of the 366 real owner charms; `castTimeMs + CAST_SLACK_MS` binds
//! 366/366 and 0/15 foreign — a perfect split with no other evidence needed.
//!
//! ── THE STATE TABLE ────────────────────────────────────────────────────────────────────────────
//!
//! One entry per mob name key; the ARM is global, because you cast one spell at a time.
//!
//!   —             own castBegin of a charm/cc/pet-only spell   armed        window = cast+slack
//!   armed         own castBegin of ANY other spell             —            one cast at a time
//!   armed         own fizzle / interrupt / resist OF THE SAME  —            the cast failed
//!   armed:charm   `<mob> has been charmed.` in the window      provisional  CONSUMES the arm
//!                                                                           (charm is single-target)
//!   armed:cc      `<mob> has been mesmerized.` in the window   (allowed)    does NOT consume: one
//!                                                                           AE mez prints one line
//!                                                                           per mob
//!   armed:petBuff a named landing of THAT spell in the window  (bind)       CONSUMES the arm
//!   —             a charm broadcast with no arm                observed     inert; remembered for
//!                                                                           PROMOTE_MS
//!   provisional   pet-shaped evidence                          confirmed    ownership proven
//!   provisional   the charm's OWN DURATION elapses, silent     —            DEMOTED (unbound)
//!   observed      `<mob> told you, '… Master.'` in PROMOTE_MS  confirmed    PROMOTED as CHARMED
//!   any           death / zone / uncharm                       —            released
//!
//! THE DEMOTION HORIZON IS THE SPELL'S DURATION, NOT A TUNED TIMEOUT, and the 60-second version was
//! measured wrong: it deleted 35,956 points of the Plane of Sky pet Bzzazzt's damage, because a
//! charmed pet routinely stands idle for minutes between orders (bound 01:02:56, first swing
//! 01:05:01). Sixty seconds measured "how fast does corroboration usually arrive", which is a
//! different question from "when can this bind no longer be real".
//!
//! Two briefed rules were overturned outright: requiring the Master TELL alone would have demoted
//! 162 genuine pets (44%), because the tell only fires when the pet is ORDERED; and "never bind a
//! name the owner damaged within the window" addresses no failure the arm gate does not already
//! close — 15 of the 366 real owner charms charm a mob the owner was mid-melee with.
//!
//! PURE + CLOCK-INJECTED: no wall clock, no engine state, no I/O. Every method takes the log
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
    /// EVERY nameKey a charm broadcast has ever named, ours or not. Session-scoped and never pruned
    /// (a handful of names). This is `everCharmed`: a name the zone has seen charmed is a MOB
    /// whatever else it looks like — which is what stops the owner healing his own charmed pet from
    /// filing that pet as a player.
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
    /// armed cast did not land, so nothing it might have "resolved" is ours. Only the ARMED spell
    /// disarms: an unrelated fizzle mid-window is somebody else's problem.
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

    /// `<mob> has been charmed.` — is it ours? CONSUMES the arm on a hit, because every charm spell
    /// in the DB is `targetType: Single`: one cast produces exactly one charmed mob, so a SECOND
    /// broadcast in the same window is somebody else's and must not ride our cast in.
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
    /// the arm: one `Mesmerization VI` prints one broadcast PER MOB it lands on (the real log has
    /// two in the same second from a single cast), so an AE mez must gate them all.
    pub fn cc_broadcast(&self, ts: i64) -> bool {
        self.arm
            .as_ref()
            .is_some_and(|a| a.kind == ArmKind::Cc && ts >= a.ts && ts <= a.until)
    }

    /// A NAMED buff landing (`<Name> goes berserk.`) — was it YOUR pet-only spell resolving?
    /// (JOS-188.)
    ///
    /// The MESSAGE is not the gate: `goes berserk.` resolves to Burnout / Fury / Rage / Voice of the
    /// Berserker and three of those four are ordinary buffs, so the armed cast must be AMONG the
    /// candidates. That is `charm_broadcast`'s test one field stricter, and for the same reason.
    /// CONSUMES the arm on a hit, for charm's reason — a Quick Buff burst prints eleven landings in
    /// one second, and one cast is one bind.
    ///
    /// The candidate list comes FROM THE DB, which makes this only as good as the scrape (JOS-349):
    /// a pet-only spell whose third-person message carries a subject token the suffix table cannot
    /// key is in no candidate list, so this returns false forever and the pet is never bound
    /// (measured on `Tiny Companion`, `Target shrinks.`, which cost a reporter his whole pet). The
    /// rule is right; the DB row was not.
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
    /// bind. The tell is ownership-definitive and pet-only, so this PROMOTES — and it promotes the
    /// name as a CHARMED pet, never a summoned one (a claim from a name EVER seen charmed re-arms
    /// the charmed set, never the permanent one). Returns true when the caller should bind it as a
    /// charm.
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

    /// The window is the SPELL'S OWN cast time — the measurement that overturned the briefed flat
    /// 2 s. `Charm` is a 2400 ms cast, so a broadcast three seconds later is still ours and one at
    /// four is not.
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

    /// CHARM CONSUMES THE ARM (single-target), CC DOES NOT (one AE mez prints one line per mob).
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

    /// A cast that resolved to nothing cannot be what a broadcast resolved — but only the ARMED
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

    /// An UNRELATED cast clears a stale arm — you cast one spell at a time.
    #[test]
    fn an_unrelated_cast_clears_the_arm() {
        let mut m = CharmModel::new();
        m.note_cast_begin("Charm", 0);
        m.note_cast_begin("Minor Healing", 100);
        assert_eq!(m.charm_broadcast("a", "a", 500), CharmVerdict::Foreign);
    }

    /// The demotion horizon is the SPELL'S OWN DURATION, and evidence ends the wait early.
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

    /// A foreign broadcast is REMEMBERED, and a later Master tell promotes it — inside PROMOTE_MS.
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
