//! The proc gate's SWINGS, and the landings that print before them (upstream issue #69).
//!
//! Measured over the owner's log (2,98M lines, 2026-09-25): a proc's landing sentence prints
//! BEFORE its own swing's line — 5,769 of 5,769 `You hit <mob> … by Puma Maw.` lines are followed,
//! never preceded, by `<mob> is rent by a savage maw.` — and a proc fires on a MISS as readily as
//! on a hit (185 of those landings had only miss lines in window). So a gate that only read hits,
//! and only hits already folded, refused about one landing in six. Two answers, both here:
//!
//!   * a swing is a melee hit, a miss, or the damage line of a held proc itself (`You hit <mob>
//!     for N points of fire damage by Firestrike.` — attacker you, dtype spell, the proc's name);
//!   * a landing the gate refused is HELD, if the gate could ever vouch for one of its candidates,
//!     and replayed when your swing at that mob arrives inside `SAME_SECOND_MS`. A held landing
//!     nobody swings at is dropped after `HOLD_MS`; nothing is drawn for it, as before.
//!
//! Owned data, not events: the fold's `Event` borrows the parser's buffer for one delivery, so the
//! hold keeps the target, the instant and the candidates — everything `apply_landing` asks for.

use crate::event::{Event, Key, Kind};
use crate::modules::buff_anchors::CastAnchors;
use crate::modules::buff_landing::Candidate;
use eqlog::names::id_key;

/// A swing may follow its proc's landing by this much and still be the same swing. EQ stamps to
/// the second; the slack is one second boundary.
pub const SAME_SECOND_MS: i64 = 1_000;

/// How long a held landing waits for a swing before it is forgotten.
pub const HOLD_MS: i64 = 2_000;

/// One landing the gate refused, kept for the swing that may explain it.
#[derive(Debug, Clone)]
pub struct PendingLanding {
    pub target: String,
    pub ts: i64,
    pub cands: Vec<Candidate>,
}

#[derive(Debug, Default)]
pub struct ProcStash {
    pending: Vec<PendingLanding>,
}

impl ProcStash {
    /// Hold a refused landing — only when the gate is on and some candidate is a held proc, so an
    /// ordinary stranger's buff costs nothing and is never replayed. Landings past `HOLD_MS` go
    /// first: a fight of procs and no swing lines (a pet's, a group-mate's) would otherwise grow
    /// the stash for as long as you never swing.
    pub fn hold(&mut self, target: &str, ts: i64, cands: &[Candidate], anchors: &CastAnchors) {
        if !anchors.proc_possible(cands.iter().map(|c| c.name.as_str())) {
            return;
        }
        self.pending.retain(|p| ts - p.ts <= HOLD_MS);
        self.pending.push(PendingLanding {
            target: target.to_string(),
            ts,
            cands: cands.to_vec(),
        });
    }

    /// A line that may be a swing of yours: note it as the gate's evidence and hand back the held
    /// landings on that target inside the same second. Anything else answers an empty list.
    pub fn note_swing(&mut self, anchors: &mut CastAnchors, ev: &Event) -> Vec<PendingLanding> {
        let Some(target) = swing_target(anchors, ev) else {
            return Vec::new();
        };
        let ts = ev.ts();
        anchors.note_melee(target, ts);
        let key = id_key(target);
        let (hit, keep): (Vec<_>, Vec<_>) = std::mem::take(&mut self.pending)
            .into_iter()
            .filter(|p| ts - p.ts <= HOLD_MS)
            .partition(|p| ts >= p.ts && ts - p.ts <= SAME_SECOND_MS && id_key(&p.target) == key);
        self.pending = keep;
        hit
    }

    /// Forget every held landing: log state, cleared with the module's.
    pub fn clear(&mut self) {
        self.pending.clear();
    }

    #[cfg(test)]
    fn held(&self) -> usize {
        self.pending.len()
    }
}

/// The target of a swing YOU made, or nothing when this line is not one.
fn swing_target<'a>(anchors: &CastAnchors, ev: &'a Event) -> Option<&'a str> {
    if id_key(ev.str(Key::Attacker).unwrap_or_default()) != "you" {
        return None;
    }
    let swing = match ev.kind_of() {
        Kind::Miss => true,
        Kind::Damage => match ev.str(Key::Dtype) {
            Some("melee") => true,
            Some("spell") => anchors.is_held_proc(ev.str(Key::Skill).unwrap_or_default()),
            _ => false,
        },
        _ => false,
    };
    if swing {
        ev.str(Key::Target)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn armed() -> CastAnchors {
        let mut a = CastAnchors::new();
        a.set_proc_trust(true, ["Tashania".to_string()]);
        a
    }

    fn cands() -> Vec<Candidate> {
        ["Tashani", "Tashania"]
            .iter()
            .map(|n| Candidate {
                name: (*n).to_string(),
                duration_ms: Some(660_000),
                illusion: false,
            })
            .collect()
    }

    fn ev(json: &str) -> Event<'static> {
        Event::from_json(json).expect("a JSON object")
    }

    /// The three swing shapes note the target; a mob's swing at you and a DS tick do not.
    #[test]
    fn a_hit_a_miss_and_a_held_procs_own_damage_line_are_swings() {
        let mut a = armed();
        let mut s = ProcStash::default();
        for line in [
            r#"{"kind":"damage","seq":0,"ts":1000,"raw":"d","attacker":"You","target":"a rat","amount":3,"dtype":"melee","skill":"Melee","crit":false}"#,
            r#"{"kind":"miss","seq":1,"ts":2000,"raw":"m","attacker":"You","target":"a bat","mtype":"miss"}"#,
            r#"{"kind":"damage","seq":2,"ts":3000,"raw":"d","attacker":"You","target":"a cat","amount":40,"dtype":"spell","skill":"Tashania","crit":false}"#,
        ] {
            s.note_swing(&mut a, &ev(line));
        }
        assert!(a.proc_evidence("Tashania", "a rat", 1000));
        assert!(a.proc_evidence("Tashania", "a bat", 2000));
        assert!(a.proc_evidence("Tashania", "a cat", 3000));
        for line in [
            r#"{"kind":"damage","seq":3,"ts":4000,"raw":"d","attacker":"a dog","target":"You","amount":3,"dtype":"melee","skill":"Melee","crit":false}"#,
            r#"{"kind":"damage","seq":4,"ts":4000,"raw":"d","attacker":"You","target":"a dog","amount":3,"dtype":"ds","skill":"Thorns","crit":false}"#,
            r#"{"kind":"damage","seq":5,"ts":4000,"raw":"d","attacker":"You","target":"a dog","amount":3,"dtype":"spell","skill":"Anarchy","crit":false}"#,
        ] {
            s.note_swing(&mut a, &ev(line));
        }
        assert!(!a.proc_evidence("Tashania", "a dog", 4000));
    }

    /// A held landing comes back on the swing of its own second, on that mob, and only then.
    #[test]
    fn a_held_landing_replays_on_the_swing_that_follows_it_in_the_same_second() {
        let mut a = armed();
        let mut s = ProcStash::default();
        s.hold("a Kunark goblin", 5000, &cands(), &a);
        s.hold("a froglok", 5000, &cands(), &a);
        assert_eq!(s.held(), 2);
        let out = s.note_swing(
            &mut a,
            &ev(r#"{"kind":"miss","seq":0,"ts":5000,"raw":"m","attacker":"You","target":"A Kunark Goblin","mtype":"miss"}"#),
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].target, "a Kunark goblin");
        assert_eq!(out[0].cands.len(), 2);
        assert_eq!(s.held(), 1, "the froglok's is still waiting");
        // Past the hold, a swing forgets it rather than replaying it.
        let late = s.note_swing(
            &mut a,
            &ev(r#"{"kind":"miss","seq":1,"ts":8000,"raw":"m","attacker":"You","target":"a froglok","mtype":"miss"}"#),
        );
        assert!(late.is_empty());
        assert_eq!(s.held(), 0);
    }

    /// Holding prunes what is past `HOLD_MS`, so landings with no swing of yours between them do
    /// not pile up; `clear` forgets the rest.
    #[test]
    fn holding_forgets_stale_landings_and_clear_forgets_them_all() {
        let a = armed();
        let mut s = ProcStash::default();
        for ts in [1000, 2000, 3000] {
            s.hold("a Kunark goblin", ts, &cands(), &a);
        }
        assert_eq!(s.held(), 3);
        s.hold("a Kunark goblin", 3000 + HOLD_MS, &cands(), &a);
        assert_eq!(s.held(), 2, "1000 and 2000 are past the hold at 5000");
        s.clear();
        assert_eq!(s.held(), 0);
    }

    /// Nothing is held that the gate could never vouch for: the switch off, or no held candidate.
    #[test]
    fn a_landing_the_gate_could_never_vouch_for_is_not_held() {
        let mut s = ProcStash::default();
        s.hold("a rat", 1000, &cands(), &CastAnchors::new());
        assert_eq!(s.held(), 0);
        let mut other = CastAnchors::new();
        other.set_proc_trust(true, ["Malaise".to_string()]);
        s.hold("a rat", 1000, &cands(), &other);
        assert_eq!(s.held(), 0);
    }
}
