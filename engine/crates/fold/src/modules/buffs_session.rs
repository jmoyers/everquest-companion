//! `src/main/modules/buffsSession.ts` — the buffs model's SESSION FRAME: the last instant the
//! character was seen in the log, and the LOG-HOLE state machine built on it.
//!
//! It holds exactly one question: a break in the event stream arrived — did the character LEAVE, or
//! did we lose the thread? The two answers are not close together. A logout FREEZES every buff with
//! the character and hands it back at login; a lost thread means whatever we believed was standing
//! is stale and belongs in the bin.
//!
//! ── WHY IT WAITS (JOS-134) ─────────────────────────────────────────────────────────────────────
//!
//! A hole used to be read as a logout on the spot and every live instance cleared. The trouble is
//! one of ORDER: the hole is always observed BEFORE the thing that explains it. Every login prints a
//! reconnect preamble first, so the first post-absence event tripped the hole, the wipe ran, and the
//! derived `offlineGap` that measured the absence arrived moments later to pause a model with
//! nothing left in it. The buff EQ had frozen with your character read as expired the instant you
//! logged back in.
//!
//! ── WHAT IT WAITS FOR IS EVIDENCE, NOT A CLOCK (JOS-262, owner ruling 2026-08-12) ──────────────
//!
//! The wait used to be a window of event time borrowed from the detector's reconnect window, and
//! both halves of that were measured wrong. The timer ruled on a hole the log had not finished
//! explaining — start the app while the game is still loading and the 1 s heartbeat runs the window
//! out against WALL time and wipes the previous session's buffs seconds before the `Welcome` that
//! would have paused them. And the first event after a hole is not evidence of anything: a preamble
//! line, or another player's kill arriving while your character is still being placed, says the
//! client is connected and nothing at all about you.
//!
//! So a hole is UNEXPLAINED only when `in_world_evidence` — a line that could only have been printed
//! for THIS character — arrives with no login in between. ONE PREDICATE, shared with the offline-gap
//! detector (`crate::session`), so the two can never disagree about what being in the world means.
//!
//! ── AND THE HOLD IS WIDER THAN THE HOLE ────────────────────────────────────────────────────────
//!
//!   the HOLD (60 s, the detector's emit floor) — every absence a pause can be reported for.
//!     `held_before_ts` exempts the pre-absence rows from the hygiene sweep for its duration.
//!   the HOLE (30 min) — an absence long enough that, unexplained, it means we lost the thread.
//!     Only a hole ever DROPS anything.
//!
//! The hold used to start at the hole, which left the whole 1–30 minute band unprotected: a
//! 20-minute relog reaches the hygiene sweep at the `Welcome` with no hold in place, and the derived
//! gap that would have rewound the clocks is drained one event LATER — so a pet or ally row past its
//! 60 s unwitnessed grace was culled a beat before the pause could save it. The row the user loses
//! is the one the pause exists for.

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
    /// the hygiene sweep for as long as the absence is unresolved: if it turns out to be a logout,
    /// that buff's clock is about to be rewound, and judging it against a `now` from the far side
    /// would retire — a beat before the pause lands — the very buff the pause protects.
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
        // OPEN FIRST, THEN RULE, and the order is load-bearing in both directions. A hole is always
        // revealed BY the event on its far side, so the same event has to be able to open it and
        // answer it: a login on the far side of a 13-hour camp explains the hole it just opened, and
        // a `You gain experience!` on the far side of one is a character who was in the world with no
        // login line — we lost the thread, and that is the ruling.
        self.open_absence(ev);
        let ruling = self.rule(ev);
        self.last_event_ts = ev.ts();
        ruling
    }

    /// Rule on the OPEN absence, if this event says anything about it. A login EXPLAINS it (and the
    /// hold stays up until the gap that follows closes it, or the sweep on this very event would
    /// judge the rows the pause is about to rewind); in-world evidence with no login RULES it —
    /// dropping what predates a HOLE and merely releasing the hold for a shorter absence, which was
    /// a lull in play rather than a lost thread; anything else leaves the question open.
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
