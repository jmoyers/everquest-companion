//! `main/log/epochDetector.ts`, ported — the rebirth boundary every character-scoped module reads.
//!
//! A log file can span a wiped pre-launch beta character and the current one. Every
//! character-scoped module drops its whole state on `epoch`, which is what keeps the dead
//! character's loot, kills, turn-ins, levels, AA, item tiers and spell ranks out of the current
//! one's tallies.
//!
//! The event is synthesized downstream rather than parsed, so it appears here and not in the
//! parser's stream.
//!
//! The anchor is the launch date, not a heuristic: the epoch fires once, at the first event whose
//! timestamp is at or after 2026-07-28 00:00 local. It resolves through `Clock::parse_eq_timestamp`
//! over a stamp in the log's own grammar, so the anchor and the timestamps it is compared against
//! cannot drift apart.

use crate::event::Event;
use eqlog::Clock;
use serde_json::json;

/// `epochDetector.ts LAUNCH_MS`, resolved through the same zone the fold's timestamps are.
pub fn launch_ms(clock: &Clock) -> i64 {
    clock.parse_eq_timestamp("Tue Jul 28 00:00:00 2026")
}

/// Stateful, single-character. Feed it every primary event in stream order.
pub struct EpochDetector {
    launch_ms: i64,
    fired: bool,
}

impl EpochDetector {
    pub fn new(launch_ms: i64) -> Self {
        EpochDetector {
            launch_ms,
            fired: false,
        }
    }

    pub fn reset(&mut self) {
        self.fired = false;
    }

    /// The `EpochEvent` to emit, or `None`. Fires at most once per log; an event whose stamp the
    /// parser could not read (`ts` 0) never trips it, which falls out of the comparison.
    pub fn observe(&mut self, ev: &Event) -> Option<Event<'static>> {
        if ev.kind() == "epoch" || self.fired || ev.ts() < self.launch_ms {
            return None;
        }
        self.fired = true;
        Some(Event::from_value(json!({
            "kind": "epoch",
            "reason": "launch",
            "seq": ev.seq(),
            "ts": ev.ts(),
            "raw": ev.raw(),
        })))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(ts: i64) -> Event<'static> {
        Event::from_value(json!({ "kind": "zone", "seq": 1, "ts": ts, "raw": "x" }))
    }

    #[test]
    fn it_fires_once_at_the_first_event_on_or_after_launch() {
        let mut d = EpochDetector::new(100);
        assert!(d.observe(&at(99)).is_none());
        let fired = d.observe(&at(100)).expect("the boundary event");
        assert_eq!(fired.kind(), "epoch");
        assert_eq!(fired.ts(), 100);
        assert!(d.observe(&at(101)).is_none());
        d.reset();
        assert!(d.observe(&at(101)).is_some());
    }

    #[test]
    fn the_anchor_is_local_midnight_on_launch_day() {
        let la = Clock::new(eqlog::Tz::America__Los_Angeles);
        // 2026-07-28 00:00 PDT is 07:00Z.
        assert_eq!(launch_ms(&la), 1785222000000);
        let utc = Clock::new(eqlog::Tz::UTC);
        assert_eq!(launch_ms(&utc), 1785196800000);
    }
}
