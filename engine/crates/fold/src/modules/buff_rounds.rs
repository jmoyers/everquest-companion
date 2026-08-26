//! `src/main/modules/buffRounds.ts` — ONE ANSWER TO "HOW MANY OF THAT NAME ARE HELD, AND WHICH ONE
//! JUST ENDED" (JOS-140, rulings 5 and 7). Pure: no events, no clock of its own.
//!
//! THE PROBLEM, MEASURED. EQ stamps are second-resolution and print no instance identifier, so one
//! AE mez landing on five mobs that share a name is FIVE BYTE-IDENTICAL LINES in one second. The
//! reporter's slice does exactly that nine times over three minutes: nine casts, fifty landings,
//! twenty-one wear-offs, across four distinct names. The old CC half kept one hold per NAME and
//! overwrote its clock on every line, so a round of nine landings became four rows and the first
//! wear-off deleted a row that four more wear-offs then failed to find.
//!
//! THE MODEL. One group per (spell line, entity NAME), holding a LIST of landings, oldest first —
//! one per entity of that name we believe is held — and the UI draws ONE ROW with a COUNT CHIP,
//! because five identical rows with five identical clocks is noise, not information.
//!
//! A ROUND is every landing sharing one log second, and its rule is the only interesting thing
//! here:
//!
//!   a round of N landings on a group already holding M refreshes min(N, M) of them, NEWEST FIRST,
//!   and appends the remaining max(0, N - M).
//!
//! Both halves are the owner's ruling and both are load-bearing. REFRESHING rather than appending
//! keeps a re-mez of five mobs at a count of five instead of ten — the count is what is HELD, not
//! what has ever landed. NEWEST-first refresh, paired with OLDEST-first closing, is what makes the
//! row's clock a prediction of the next wear-off line rather than an average of several.
//!
//! CLOSING IS OLDEST-FIRST, for the same reason and with the same honesty: `Your <S> spell has worn
//! off of <mob>.` names the mob but not WHICH mob of that name, so under a fixed duration the
//! oldest landing is the maximum-likelihood one to have just ended. Nothing else in the log
//! separates them (world-model law 6's non-distinguishables).
//!
//! CLEAN CYCLES (ruling 5) are the whole reason the bookkeeping is this careful. A duration sample
//! may be minted ONLY from a landing that was alone in its round, on a group that was empty when
//! the round opened, and that nothing touched before its wear-off. Everything else — a same-second
//! sibling, a refresh, a wear-off with no hold behind it, a zone/death/gap clear — CONTAMINATES.
//! Measured against the reporter's slice this admits exactly two of fifty-eight cycles (43 s and
//! 44 s), which is the correct yield for a fifteen-minute AE-mez grind: they are the two rounds
//! whose mob name happened to be unique.

/// One landing: an entity of this name we believe is still held, and whether it is measurable.
#[derive(Debug, Clone)]
pub struct Hold {
    /// Event ts the landing (or its most recent refresh) happened. Never a wall clock.
    pub started_ts: i64,
    /// True while this landing is still a candidate for a duration SAMPLE. Set false the moment
    /// anything ambiguous touches it; NEVER set back to true — contamination is one-way, because
    /// the doubt it records does not go away when the next clean-looking line arrives.
    pub clean: bool,
}

/// What `close_oldest` did, so the caller can decide whether a sample was earned.
pub struct Closed {
    /// The span in ms, or `None` when the hold was contaminated (ruling 5: no sample).
    pub sample_ms: Option<i64>,
}

/// The landings of ONE (spell line, entity name) pair.
#[derive(Debug, Clone)]
pub struct HoldGroup {
    /// Oldest first. `len` is the row's count chip.
    holds: Vec<Hold>,
    /// A SINGLETON group is one the model holds an IDENTITY for, not just a name — you, your
    /// summoned pet, your charmed pet (world-model law 4: entities, not names). There can only ever
    /// be one of it, so a later landing is unambiguously a REFRESH of the same thing: the clock
    /// resets and the cycle stays CLEAN, which is what lets a re-cast Swift Like the Wind still
    /// mint one honest full cycle instead of an inflated land-to-fade span.
    ///
    /// A non-singleton group is keyed by a NAME the world can duplicate — a hostile mob, and every
    /// crowd-control hold. There, a later landing is either the same mob re-hit or a second mob of
    /// that name newly hit, no line separates them, and the ambiguity is exactly what ruling 5
    /// refuses to learn from.
    singleton: bool,
    /// The log second the current round belongs to, or -1 before the first landing.
    round_ts: i64,
    /// How many landings of the current round have been consumed (refreshes first, then appends).
    round_used: usize,
    /// How many landings the group held when the current round OPENED — the min(N, M) of the rule.
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

    /// The clock the ROW draws: the oldest landing, i.e. the one the next wear-off will close.
    pub fn oldest_ts(&self) -> i64 {
        self.holds.first().map_or(0, |h| h.started_ts)
    }

    /// A landing at `ts`. `contaminated` lets the caller add reasons of its own (a family that never
    /// narrowed to one spell, two ranks in the cast window) without this module knowing what any of
    /// them are.
    pub fn land(&mut self, ts: i64, contaminated: bool) {
        if self.singleton {
            // One identity, one landing. A re-cast RESETS the clock so the next wear-off measures
            // the fresh cast rather than the sum of the leftover and the new duration, and it stays
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
        // A landing is CLEAN only if it opened a group that was EMPTY and is alone in its round so
        // far. The second half is provisional: a sibling later in the same round retroactively
        // dirties it, which `contaminate_round` does.
        let clean = !contaminated && self.round_start_count == 0 && self.round_used == 0;
        if self.round_used < self.round_start_count {
            // REFRESH, NEWEST FIRST. A re-landing is either the same mob re-hit or a different mob
            // of that name newly hit, and no line separates them, so we take the bounded reading:
            // the row never grows a ghost, and the landing stops being measurable. Newest-first
            // keeps the list sorted while leaving the OLDEST clock — the one the next wear-off will
            // close — where it was.
            let at = self.round_start_count - 1 - self.round_used;
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
    /// mint. A close with nothing to close returns `None` AND contaminates the group: a wear-off
    /// with no hold behind it is proof the model under-counted, which is exactly the state in which
    /// a later span would be measured against the wrong landing.
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

    /// Drop every landing older than `cutoff_ts` — the hygiene sweep's half of the bookkeeping —
    /// and hand the dropped landings BACK, oldest first.
    ///
    /// IT STILL MINTS NOTHING, AND THE RETURN VALUE DOES NOT CHANGE THAT (JOS-180). A cull is not an
    /// observation: nobody saw the hold end, so there is no span to learn from and this method has
    /// no business inventing one. What the caller gets back is the landing itself — a START time and
    /// its `clean` flag — so a break line arriving AFTER the cull can still be matched to the
    /// landing it belongs to and measured through the ordinary rules.
    pub fn drop_expired(&mut self, cutoff_ts: i64) -> Vec<Hold> {
        let mut n = 0;
        while n < self.holds.len() && self.holds[n].started_ts <= cutoff_ts {
            n += 1;
        }
        self.holds.drain(..n).collect()
    }

    /// Shift the clocks of every landing at or before `only_before` forward by `offset_ms` — the
    /// offline PAUSE (JOS-134), and the only place a live clock moves at all. Re-sorts afterwards
    /// because a shifted older landing can legitimately overtake an un-shifted newer one, and the
    /// oldest-first ordering is what `close_oldest` means.
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
            // `Array.prototype.sort` is STABLE in every modern engine and so is `sort_by_key`.
            self.holds.sort_by_key(|h| h.started_ts);
        }
        changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The round rule: five landings in one second on an empty group are five holds and none of
    /// them is clean past the first sibling.
    #[test]
    fn a_round_of_five_is_five_holds_and_nothing_measurable() {
        let mut g = HoldGroup::new(false);
        for _ in 0..5 {
            g.land(1000, false);
        }
        assert_eq!(g.count(), 5);
        assert_eq!(g.oldest_ts(), 1000);
        // Every one of them was contaminated by its siblings, so a wear-off mints nothing.
        assert_eq!(g.close_oldest(9000).expect("a close").sample_ms, None);
    }

    /// …and a re-round of the same size REFRESHES rather than appending: the count is what is held.
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
        // Newest-first refresh leaves the oldest clock alone — until every one of them is taken.
        assert_eq!(g.oldest_ts(), 5000);
    }

    /// A LONE landing on an empty group is the only shape that mints, and a singleton re-cast
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

    /// A close with nothing to close contaminates what arrives afterwards — the model under-counted
    /// and cannot be trusted to measure the next span.
    #[test]
    fn a_wear_off_with_no_hold_behind_it_poisons_the_group() {
        let mut g = HoldGroup::new(false);
        assert!(g.close_oldest(1000).is_none());
        g.land(2000, false);
        // The landing itself is clean (the group was empty and the round is its own)…
        assert_eq!(g.close_oldest(9000).expect("a close").sample_ms, Some(7000));
    }
}
