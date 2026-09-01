//! One answer to "how many of that name are held, and which one just ended". Pure: no events, no
//! clock of its own.
//!
//! EQ stamps are second-resolution and print no instance identifier, so one AE mez landing on five
//! mobs that share a name is five byte-identical lines in one second. So: one group per (spell
//! line, entity NAME) holding a LIST of landings, oldest first, drawn as ONE row with a count chip.
//!
//! A ROUND is every landing sharing one log second, and its rule is:
//!
//!   a round of N landings on a group already holding M refreshes min(N, M) of them, NEWEST FIRST,
//!   and appends the remaining max(0, N - M).
//!
//! Refreshing rather than appending keeps the count at what is HELD rather than what has ever
//! landed. Newest-first refresh paired with OLDEST-first closing makes the row's clock a prediction
//! of the next wear-off line: `Your <S> spell has worn off of <mob>.` names the mob but not WHICH
//! mob of that name, so under a fixed duration the oldest landing is the maximum-likelihood one to
//! have just ended, and nothing else in the log separates them.
//!
//! Clean cycles are what the bookkeeping is for. A duration sample may be minted only from a
//! landing alone in its round, on a group that was empty when the round opened, that nothing
//! touched before its wear-off. A same-second sibling, a refresh, a wear-off with no hold behind
//! it, a zone/death/gap clear all contaminate.

/// One landing: an entity of this name we believe is still held, and whether it is measurable.
#[derive(Debug, Clone)]
pub struct Hold {
    /// Event ts the landing (or its most recent refresh) happened. Never a wall clock.
    pub started_ts: i64,
    /// True while this landing is still a candidate for a duration SAMPLE. Contamination is
    /// one-way: never set back to true, because the doubt it records does not expire.
    pub clean: bool,
}

/// What `close_oldest` did, so the caller can decide whether a sample was earned.
pub struct Closed {
    /// The span in ms, or `None` when the hold was contaminated.
    pub sample_ms: Option<i64>,
}

/// The landings of ONE (spell line, entity name) pair.
#[derive(Debug, Clone)]
pub struct HoldGroup {
    /// Oldest first. `len` is the row's count chip.
    holds: Vec<Hold>,
    /// A SINGLETON group is one the model holds an IDENTITY for rather than a name — you, your
    /// summoned pet, your charmed pet. There can only be one of it, so a later landing is
    /// unambiguously a refresh: the clock resets and the cycle stays clean.
    ///
    /// A non-singleton group is keyed by a name the world can duplicate — a hostile mob, and every
    /// crowd-control hold. There a later landing is either the same mob re-hit or a second mob of
    /// that name newly hit, no line separates them, and that ambiguity is refused as evidence.
    singleton: bool,
    /// The log second the current round belongs to, or -1 before the first landing.
    round_ts: i64,
    /// How many landings of the current round have been consumed (refreshes first, then appends).
    round_used: usize,
    /// How many landings the group held when the current round OPENED — the min(N, M) of the rule.
    /// A close or a cull sharing the round's second shrinks `holds` under it, so it is a snapshot
    /// the refresh path must clamp rather than a live count.
    round_start_count: usize,
}

impl HoldGroup {
    pub fn new(singleton: bool) -> Self {
        HoldGroup {
            holds: Vec::new(),
            singleton,
            round_ts: -1,
            round_used: 0,
            round_start_count: 0,
        }
    }

    pub fn count(&self) -> usize {
        self.holds.len()
    }

    pub fn is_empty(&self) -> bool {
        self.holds.is_empty()
    }

    /// The clock the row draws: the oldest landing, the one the next wear-off will close.
    pub fn oldest_ts(&self) -> i64 {
        self.holds.first().map_or(0, |h| h.started_ts)
    }

    /// A landing at `ts`. `contaminated` lets the caller add reasons of its own (a family that never
    /// narrowed to one spell, two ranks in the cast window) without this module knowing what any of
    /// them are.
    pub fn land(&mut self, ts: i64, contaminated: bool) {
        if self.singleton {
            // One identity, one landing. A re-cast resets the clock so the next wear-off measures
            // the fresh cast rather than the leftover plus the new duration, and it stays
            // measurable because there is nothing to confuse it with.
            match self.holds.first_mut() {
                Some(hold) => {
                    hold.started_ts = ts;
                    hold.clean = !contaminated;
                }
                None => self.holds.push(Hold {
                    started_ts: ts,
                    clean: !contaminated,
                }),
            }
            return;
        }
        if ts != self.round_ts {
            self.round_ts = ts;
            self.round_used = 0;
            self.round_start_count = self.holds.len();
        }
        // Clean only if it opened an EMPTY group and is alone in its round so far. The second half
        // is provisional: a later sibling in the same round retroactively dirties it.
        // The gate stays on the UNCLAMPED snapshot: a group that has lost holds is not an empty one.
        let clean = !contaminated && self.round_start_count == 0 && self.round_used == 0;
        // Only what is still held can be refreshed. A round that lost landings out from under it
        // degrades to appending, and `round_used` grows with every append so a refresh can never
        // target one of them.
        let refreshable = self.round_start_count.min(self.holds.len());
        if self.round_used < refreshable {
            // Refresh, newest first: the row never grows a ghost, the landing stops being
            // measurable, and the OLDEST clock — the one the next wear-off closes — stays put.
            let at = refreshable - 1 - self.round_used;
            self.holds[at].started_ts = ts;
            self.holds[at].clean = false;
        } else {
            if self.round_used > 0 {
                self.contaminate_round();
            }
            self.holds.push(Hold {
                started_ts: ts,
                clean,
            });
        }
        self.round_used += 1;
    }

    /// Every landing of the current round loses its clean flag — a round of two is two mobs.
    fn contaminate_round(&mut self) {
        let round_ts = self.round_ts;
        for h in &mut self.holds {
            if h.started_ts == round_ts {
                h.clean = false;
            }
        }
    }

    /// A line said one of these ended. Closes the OLDEST and reports whether it was clean enough to
    /// mint. A close with nothing to close returns `None` and contaminates the group: a wear-off
    /// with no hold behind it is proof the model under-counted.
    pub fn close_oldest(&mut self, ts: i64) -> Option<Closed> {
        if self.holds.is_empty() {
            self.contaminate_all();
            return None;
        }
        let hold = self.holds.remove(0);
        let span = ts - hold.started_ts;
        Some(Closed {
            sample_ms: (hold.clean && span > 0).then_some(span),
        })
    }

    /// Every landing stops being measurable (a zone, a death, a gap, a rule the caller enforces).
    pub fn contaminate_all(&mut self) {
        for h in &mut self.holds {
            h.clean = false;
        }
    }

    /// Drop every landing older than `cutoff_ts` and hand the dropped landings back, oldest first.
    ///
    /// It mints nothing, and the return value does not change that: a cull is not an observation,
    /// so there is no span to learn from. The caller gets the landing's start time and `clean` flag
    /// so a break line arriving AFTER the cull can still be matched to it and measured normally.
    pub fn drop_expired(&mut self, cutoff_ts: i64) -> Vec<Hold> {
        let mut n = 0;
        while n < self.holds.len() && self.holds[n].started_ts <= cutoff_ts {
            n += 1;
        }
        self.holds.drain(..n).collect()
    }

    /// Shift the clocks of every landing at or before `only_before` forward by `offset_ms` — the
    /// offline pause, and the only place a live clock moves at all. Re-sorts afterwards because a
    /// shifted older landing can overtake an un-shifted newer one, and the oldest-first ordering is
    /// what `close_oldest` means.
    pub fn shift_by(&mut self, offset_ms: i64, only_before: i64) -> bool {
        let mut changed = false;
        for h in &mut self.holds {
            if h.started_ts > only_before {
                continue;
            }
            h.started_ts += offset_ms;
            changed = true;
        }
        if changed {
            // A STABLE sort: two landings sharing a ts keep the order they were seen in.
            self.holds.sort_by_key(|h| h.started_ts);
        }
        changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Five landings in one second on an empty group are five holds, none of them clean.
    #[test]
    fn a_round_of_five_is_five_holds_and_nothing_measurable() {
        let mut g = HoldGroup::new(false);
        for _ in 0..5 {
            g.land(1000, false);
        }
        assert_eq!(g.count(), 5);
        assert_eq!(g.oldest_ts(), 1000);
        // Contaminated by their siblings, so a wear-off mints nothing.
        assert_eq!(g.close_oldest(9000).expect("a close").sample_ms, None);
    }

    /// A re-round of the same size refreshes rather than appending: the count is what is held.
    #[test]
    fn a_second_round_refreshes_instead_of_growing_the_count() {
        let mut g = HoldGroup::new(false);
        for _ in 0..3 {
            g.land(1000, false);
        }
        for _ in 0..3 {
            g.land(5000, false);
        }
        assert_eq!(g.count(), 3);
        // Newest-first refresh leaves the oldest clock alone until every one is taken.
        assert_eq!(g.oldest_ts(), 5000);
    }

    /// A lone landing on an empty group is the only shape that mints, and a singleton re-cast
    /// stays measurable because there is nothing to confuse it with.
    #[test]
    fn only_a_lone_landing_mints_and_a_singleton_recast_still_does() {
        let mut g = HoldGroup::new(false);
        g.land(1000, false);
        assert_eq!(
            g.close_oldest(45_000).expect("a close").sample_ms,
            Some(44_000)
        );

        let mut s = HoldGroup::new(true);
        s.land(1000, false);
        s.land(20_000, false);
        assert_eq!(s.count(), 1);
        assert_eq!(
            s.close_oldest(60_000).expect("a close").sample_ms,
            Some(40_000)
        );
    }

    /// A wear-off sharing the round's second shrinks the group under the round's snapshot. The
    /// landing that follows appends what is left rather than indexing a hold that is gone.
    #[test]
    fn a_round_that_loses_holds_mid_round_appends_instead_of_indexing_past_the_end() {
        let mut g = HoldGroup::new(false);
        for _ in 0..3 {
            g.land(1000, false);
        }
        // Opens a round snapshotting three, and takes the newest as its first refresh.
        g.land(5000, false);
        g.close_oldest(5000);
        g.close_oldest(5000);
        assert_eq!(g.count(), 1);

        g.land(5000, false);
        assert_eq!(g.count(), 2);
        assert_eq!(g.oldest_ts(), 5000);
        // Degrading to an append is still a round of siblings, so nothing measurable survives.
        assert_eq!(g.close_oldest(9000).expect("a close").sample_ms, None);
    }

    /// A close with nothing to close contaminates the group.
    #[test]
    fn a_wear_off_with_no_hold_behind_it_poisons_the_group() {
        let mut g = HoldGroup::new(false);
        assert!(g.close_oldest(1000).is_none());
        g.land(2000, false);
        // The landing itself is clean: the group was empty and the round is its own.
        assert_eq!(g.close_oldest(9000).expect("a close").sample_ms, Some(7000));
    }
}
