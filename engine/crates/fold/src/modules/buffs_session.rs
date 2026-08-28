//! The buffs model's SESSION FRAME: the last instant the character was seen in the log, and the
//! log-hole state machine built on it.
//!
//! It holds one question. A break in the event stream arrived — did the character LEAVE, or did we
//! lose the thread? A logout freezes every buff with the character and hands it back at login; a
//! lost thread means whatever we believed was standing is stale.
//!
//! It waits, because the hole is always observed BEFORE the thing that explains it: every login
//! prints a reconnect preamble first, so ruling on the spot wipes the model a beat before the
//! derived gap arrives to pause it.
//!
//! What it waits for is EVIDENCE, not a clock. A timer would rule on a hole the log had not finished
//! explaining, and the first event after a hole is not evidence of anything — a preamble line, or
//! another player's kill arriving while your character is still being placed, says the client is
//! connected and nothing about you. So a hole is unexplained only when `in_world_evidence` — a line
//! that could only have been printed for THIS character — arrives with no login in between. That is
//! one predicate, shared with the offline-gap detector, so the two cannot disagree about what being
//! in the world means.
//!
//! The hold is wider than the hole:
//!
//!   the HOLD (60 s, the detector's emit floor) — every absence a pause can be reported for.
//!     `held_before_ts` exempts the pre-absence rows from the hygiene sweep for its duration.
//!   the HOLE (30 min) — an absence long enough that, unexplained, it means we lost the thread.
//!     Only a hole ever DROPS anything.
//!
//! Starting the hold at the hole instead would leave the 1–30 minute band unprotected: a 20-minute
//! relog reaches the hygiene sweep at the login line with no hold in place, and the gap that would
//! have rewound the clocks is drained one event later — culling the row the pause exists for.

use crate::event::Event;
use crate::modules::buffs_shapes::SESSION_GAP_MS;
use crate::session::{in_world_evidence, OFFLINE_GAP_MIN_MS};

#[derive(Default)]
pub struct SessionFrame {
    /// ts of the newest primary event folded so far (0 before the first).
    last_event_ts: i64,
    /// Last instant seen before an OPEN absence, or 0 when there is none.
    from_ts: i64,
    /// True when the open absence is past the log-HOLE boundary, so ruling it drops rows.
    is_hole: bool,
    /// True once a login turned up for the open absence: the pause is on its way.
    explained: bool,
}

impl SessionFrame {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn reset(&mut self) {
        self.last_event_ts = 0;
        self.close_hole();
    }

    /// The last-known-online instant of an OPEN absence, or 0. A BUFF older than this is exempt from
    /// the hygiene sweep while the absence is unresolved: if it turns out to be a logout, that
    /// buff's clock is about to be rewound, and judging it against a `now` from the far side would
    /// retire the very buff the pause protects, a beat before the pause lands.
    pub fn held_before_ts(&self) -> i64 {
        self.from_ts
    }

    /// A login (or a character rebirth) settled the question: close the hole with no casualties.
    pub fn close_hole(&mut self) {
        self.from_ts = 0;
        self.is_hole = false;
        self.explained = false;
    }

    /// Fold one primary event. Returns the last-known-online instant of a hole that has JUST been
    /// ruled unexplained — the caller drops what predates it — or `None`.
    pub fn observe(&mut self, ev: &Event) -> Option<i64> {
        // Open first, then rule: a hole is always revealed BY the event on its far side, so the same
        // event has to be able to open it and answer it. A login on the far side of a long camp
        // explains the hole it just opened; in-world evidence on the far side of one is a character
        // who was there with no login line, which is the lost-thread ruling.
        self.open_absence(ev);
        let ruling = self.rule(ev);
        self.last_event_ts = ev.ts();
        ruling
    }

    /// Rule on the OPEN absence, if this event says anything about it. A login EXPLAINS it, and the
    /// hold stays up until the gap that follows closes it, or the sweep on this very event would
    /// judge the rows the pause is about to rewind. In-world evidence with no login RULES it,
    /// dropping what predates a hole and merely releasing the hold for a shorter absence, which was
    /// a lull in play rather than a lost thread. Anything else leaves the question open.
    fn rule(&mut self, ev: &Event) -> Option<i64> {
        if self.from_ts == 0 {
            return None;
        }
        if ev.kind() == "sessionStart" {
            self.explained = true;
            return None;
        }
        if !in_world_evidence(ev) {
            return None;
        }
        let from = self.from_ts;
        let unexplained_hole = self.is_hole && !self.explained;
        self.close_hole();
        unexplained_hole.then_some(from)
    }

    /// Open an absence when this event follows a quiet stretch worth pausing for.
    fn open_absence(&mut self, ev: &Event) {
        if self.last_event_ts <= 0 {
            return;
        }
        let quiet_ms = ev.ts() - self.last_event_ts;
        if quiet_ms < OFFLINE_GAP_MIN_MS {
            return;
        }
        // A second quiet stretch before the first was resolved is the SAME unresolved absence: keep
        // the oldest known-online instant (it is what the pre-absence rows are held against) and let
        // either stretch make it a hole.
        if self.from_ts == 0 {
            self.from_ts = self.last_event_ts;
        }
        if quiet_ms >= SESSION_GAP_MS {
            self.is_hole = true;
        }
    }
}
