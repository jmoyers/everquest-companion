//! `main/log/epochDetector.ts`, ported — the ONE derived event this cluster's nine modules read.
//!
//! WHY A PHASE-2 CRATE HAS TO CARRY IT. Every character-scoped module here handles
//! `ev.kind === 'epoch'` by dropping its whole state: the owner's log file is shared with a WIPED
//! pre-launch beta character (that file's header tells the story), and the boundary is what keeps
//! the dead character's loot, kills, turn-ins, levels, AA, item tiers and spell ranks out of the
//! current one's tallies. The `early-leveling` slice spans Jul 19 → Jul 28 and therefore CROSSES
//! it: a fold that never synthesized the event would publish the beta character's history and
//! diverge from the golden on six modules at once.
//!
//! IT IS NOT IN THE PHASE-1 ARTIFACT, and that is correct rather than an oversight —
//! `goldenOracle.mts` excludes `buffExpired`, `epoch` and `offlineGap` from the events NDJSON on
//! the grounds that the PARSER does not produce them. They are synthesized downstream and handed
//! back through `bus.emitDerived`. So phase 2 is where they have to appear, and this is the first
//! of them.
//!
//! THE ANCHOR IS THE LAUNCH DATE, NOT A HEURISTIC (Task #50, the owner's correction). The epoch
//! fires ONCE, at the first event whose timestamp is at/after 2026-07-28 00:00 LOCAL. Local is
//! deliberate on both sides: the TS derives it with `new Date(2026, 6, 28, …)` and compares it
//! against timestamps `Date.parse` read in the same zone, so the comparison is zone-consistent on
//! any machine. Here the anchor goes through `Clock::parse_eq_timestamp` — the parser's OWN
//! function, over a stamp in the log's own grammar — so the anchor and the timestamps it is
//! compared against cannot drift apart by construction.
//!
//! THE OTHER TWO DERIVED KINDS ARE DELIBERATELY ABSENT, and the reason is checkable rather than
//! hopeful. `buffExpired` (buffs) and `offlineGap` (the session detector) both stamp themselves
//! with the CURRENT primary event's `seq` and `ts` — `this.curSeq`/`this.curTs` and the `seq`/
//! `toTs` arguments respectively — and none of this cluster's nine modules reads either kind for
//! anything else. The only state they could touch is the `seq` every module assigns from every
//! event, and that is a value they carry over unchanged. So omitting them cannot move a published
//! snapshot in cluster 2a. A module that reads either kind (buffs, buffTimers, alerts — 2c) must
//! bring its producer with it; the README says so beside the checklist.

use crate::event::Event;
use eqlog::Clock;
use serde_json::json;

/// `epochDetector.ts LAUNCH_MS`, resolved through the same zone the fold's timestamps are.
pub fn launch_ms(clock: &Clock) -> i64 {
    clock.parse_eq_timestamp("Tue Jul 28 00:00:00 2026")
}

/// Stateful, single-character. Feed it every PRIMARY event in stream order.
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
        // 2026-07-28 00:00 PDT is 07:00Z — the zone the goldens were recorded in.
        assert_eq!(launch_ms(&la), 1785222000000);
        let utc = Clock::new(eqlog::Tz::UTC);
        assert_eq!(launch_ms(&utc), 1785196800000);
    }
}
