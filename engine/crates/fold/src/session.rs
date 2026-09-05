//! `main/log/sessionDetector.ts`, ported — the `offlineGap` derived event. `progression` publishes
//! each gap's instants verbatim and `roster` marks members stale across one.
//!
//! The anchor is evidence, not a window: `fromTs` is the newest event that could only have been
//! printed because this character was standing in the world, never merely the newest typed event.
//! The client receives channel noise and other players' fully-typed combat for seconds before
//! `Welcome to EverQuest Legends!`, so a "newest typed event" anchor reads a 58-minute absence as
//! two seconds. A stranger's kill proves the client is connected; only a line about you proves the
//! character is in the world.
//!
//! The cost is stated rather than hidden: `fromTs` is a lower bound, so a gap never under-states an
//! absence and over-states it by the trailing run of lines that name nobody (measured worst case:
//! an AFK park, 56 minutes).
//!
//! Nothing here reads a wall clock, so a replay reconstructs every historical gap exactly as the
//! live tail would.

use crate::event::Event;
use eqlog::names::id_key;
use serde_json::json;

/// Minimum absence worth reporting. Below this a relog is a blip — real logs show sub-minute
/// relogs measuring 30-34 s, which is the noise this suppresses.
pub const OFFLINE_GAP_MIN_MS: i64 = 60_000;

/// How close a non-aborted `campStart` must sit to `fromTs` for the logout to count as camped. A
/// camp takes ~30 s; 60 s is the comfortable read of "these two describe the same logout".
pub const CAMP_PAIRING_MS: i64 = 60_000;

/// The first-person families: the log prints no third-person twin of any of these, so the sentence
/// can only be about the tailed character. `petClaim` is here because both of its shapes name you;
/// the ally form is its own kind and deliberately absent.
const FIRST_PERSON_KINDS: &[&str] = &[
    "sessionStart",
    "zone",
    "loot",
    "coin",
    "itemReceived",
    "purchase",
    "offer",
    "trade",
    "level",
    "expGain",
    "aaGain",
    "aaSpend",
    "aaPotion",
    "aaActivate",
    "castBegin",
    "castFizzle",
    "castInterrupted",
    "castResumed",
    "buffFade",
    "buffWearOff",
    "illusionFade",
    "playerDeath",
    "healUnstated",
    "mitigation",
    "campStart",
    "campAbort",
    "outputFile",
    "selfWho",
    "skillUp",
    "specialAttack",
    "classUnlock",
    "itemActivate",
    "itemMerge",
    "itemMergeFailed",
    "consider",
    "stanceChange",
    "invocationChange",
    "petClaim",
];

/// `isYou` — every casing canonicalizes here. An absent field is not you.
fn is_you(name: Option<&str>) -> bool {
    match name {
        Some(n) => id_key(n) == "you",
        None => false,
    }
}

/// The combat families exist for everyone: only a line that names you is evidence.
fn combat_names_you(ev: &Event) -> bool {
    match ev.kind() {
        "damage" | "miss" => is_you(ev.str("attacker")) || is_you(ev.str("target")),
        "heal" => is_you(ev.str("healer")) || is_you(ev.str("target")),
        // The incoming form (`You resist <mob>'s <Spell>!`) names you as the resister.
        "resist" => ev.bool("incoming") || is_you(ev.str("caster")) || is_you(ev.str("target")),
        // `You have slain <X>!`. The other two shapes are somebody else's kill (or nobody's).
        "death" => ev.bool("bySelf"),
        _ => false,
    }
}

/// Families with a self form and a broadcast form; only the self form is about you.
fn self_form_of(ev: &Event) -> bool {
    match ev.kind() {
        // A `msg_cast_on_you` match. A named target is the third-person broadcast, which every
        // player in earshot receives — including one who is not in the world yet.
        "buffApply" => ev.str("target") == Some("self"),
        "spellEmote" => ev.str("subject") == Some("self"),
        // `name` is absent for exactly the two self shapes.
        "group" => matches!(ev.str("change"), Some("selfJoin") | Some("selfLeave")),
        _ => false,
    }
}

/// `inWorldEvidence` — could this line only have been printed because the tailed character was
/// standing in the world? Stricter than "did the parser type this line"; see the header.
pub fn in_world_evidence(ev: &Event) -> bool {
    FIRST_PERSON_KINDS.contains(&ev.kind()) || combat_names_you(ev) || self_form_of(ev)
}

/// Stateful, single-character. Feed it every event in stream order, exactly as the bus does.
#[derive(Default)]
pub struct SessionDetector {
    /// The anchor: the newest instant the character is known to have been in the world, or 0.
    evidence_ts: i64,
    /// ts of the most recent `campStart` that has not been abandoned, or 0.
    camp_ts: i64,
}

impl SessionDetector {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn reset(&mut self) {
        self.evidence_ts = 0;
        self.camp_ts = 0;
    }

    /// One event. Returns the `offlineGap` to emit at a `sessionStart` whose implied absence
    /// exceeds `OFFLINE_GAP_MIN_MS`, else `None`.
    ///
    /// Derived events are ignored: an `offlineGap` is this detector's own output, and an
    /// `epoch`/`buffExpired` restates a primary event whose timestamp is already recorded.
    pub fn observe(&mut self, ev: &Event) -> Option<Event<'static>> {
        if matches!(ev.kind(), "offlineGap" | "epoch" | "buffExpired") {
            return None;
        }
        // An unparseable timestamp (0) can neither anchor a gap nor advance the anchor.
        if ev.ts() <= 0 {
            return None;
        }
        if ev.kind() == "campStart" {
            self.camp_ts = ev.ts();
        }
        // The game states the cancellation outright — an abandoned camp is not a logout.
        if ev.kind() == "campAbort" {
            self.camp_ts = 0;
        }
        // The gap is built before the Welcome advances the anchor: it is measured against the
        // previous session, and it is also the login that ended the absence.
        let gap = if ev.kind() == "sessionStart" {
            self.build_gap(ev.ts(), ev.seq(), ev.raw())
        } else {
            None
        };
        if in_world_evidence(ev) {
            self.evidence_ts = ev.ts();
        }
        gap
    }

    /// The gap implied by a login at `to_ts`, or `None`. A log whose first login has shown no
    /// in-world evidence yet has no observed "before", and inventing one out of the preamble is
    /// exactly the mistake this file exists to avoid.
    fn build_gap(&self, to_ts: i64, seq: i64, raw: &str) -> Option<Event<'static>> {
        let from_ts = self.evidence_ts;
        if from_ts <= 0 || to_ts - from_ts <= OFFLINE_GAP_MIN_MS {
            return None;
        }
        let camped = self.camp_ts > 0 && (from_ts - self.camp_ts).abs() <= CAMP_PAIRING_MS;
        Some(Event::from_value(json!({
            "kind": "offlineGap",
            "seq": seq,
            "ts": to_ts,
            "raw": raw,
            "fromTs": from_ts,
            "toTs": to_ts,
            "camped": camped,
        })))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(json: &str) -> Event<'static> {
        Event::from_json(json).expect("an object")
    }

    /// The reconnect preamble is the whole reason the anchor is evidence rather than a window: a
    /// stranger's kill two seconds before the Welcome must not shrink a 13-hour absence.
    #[test]
    fn a_strangers_kill_in_the_preamble_does_not_anchor_the_gap() {
        let mut d = SessionDetector::new();
        d.observe(&ev(
            r#"{"kind":"expGain","seq":0,"ts":1000,"raw":"x","party":false}"#,
        ));
        d.observe(&ev(
            r#"{"kind":"death","seq":1,"ts":900000,"raw":"d","name":"a mob","bySelf":false,"killer":"Dyson"}"#,
        ));
        let gap = d
            .observe(&ev(
                r#"{"kind":"sessionStart","seq":2,"ts":900002,"raw":"w"}"#,
            ))
            .expect("a gap");
        assert_eq!(gap.int("fromTs"), Some(1000));
        assert_eq!(gap.int("toTs"), Some(900002));
        assert!(!gap.bool("camped"));
    }

    /// A relog under the floor is a blip, and the first login of a log has no observed "before".
    #[test]
    fn a_blip_and_a_first_login_report_nothing() {
        let mut d = SessionDetector::new();
        assert!(d
            .observe(&ev(
                r#"{"kind":"sessionStart","seq":0,"ts":5000,"raw":"w"}"#
            ))
            .is_none());
        assert!(d
            .observe(&ev(
                r#"{"kind":"sessionStart","seq":1,"ts":6000,"raw":"w"}"#
            ))
            .is_none());
    }

    /// A camp within the pairing window makes the logout camped; an abort withdraws it.
    #[test]
    fn a_camp_beside_the_anchor_marks_the_logout_camped() {
        let mut d = SessionDetector::new();
        d.observe(&ev(r#"{"kind":"campStart","seq":0,"ts":1000,"raw":"c"}"#));
        let gap = d
            .observe(&ev(
                r#"{"kind":"sessionStart","seq":1,"ts":200000,"raw":"w"}"#,
            ))
            .expect("a gap");
        // campStart is itself in-world evidence, so it is the anchor — the ordinary camp.
        assert_eq!(gap.int("fromTs"), Some(1000));
        assert!(gap.bool("camped"));

        let mut d = SessionDetector::new();
        d.observe(&ev(r#"{"kind":"campStart","seq":0,"ts":1000,"raw":"c"}"#));
        d.observe(&ev(r#"{"kind":"campAbort","seq":1,"ts":1010,"raw":"a"}"#));
        let gap = d
            .observe(&ev(
                r#"{"kind":"sessionStart","seq":2,"ts":200000,"raw":"w"}"#,
            ))
            .expect("a gap");
        assert!(!gap.bool("camped"));
    }

    /// A third-person buff landing is a broadcast everyone in earshot receives; the self form is
    /// the only one that says where you are.
    #[test]
    fn only_the_self_form_of_a_landing_is_evidence() {
        let self_land = ev(r#"{"kind":"buffApply","seq":0,"ts":1,"raw":"b","target":"self"}"#);
        let other = ev(r#"{"kind":"buffApply","seq":0,"ts":1,"raw":"b","target":"Dranix"}"#);
        assert!(in_world_evidence(&self_land));
        assert!(!in_world_evidence(&other));
    }
}
