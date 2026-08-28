//! The announce cursor — a module's dirty bit, and the number that decides whether a renderer
//! re-fetches.
//!
//! A module announces a cursor that moves only when what `snapshot()` publishes actually changed.
//! Each owning module calls [`Announce::changed`] from exactly the arms that mutate published
//! state, epoch and reset arms included, because clearing a ledger is a change a panel must see.
//!
//! It is seq-valued rather than a plain counter because clients compare it against the `seq` they
//! took off a snapshot (`if (c.seq <= knownSeq) return`). A counter restarting at 1 would sit below
//! that log-line seq forever, so every announce after the first hydrate would be dropped and the
//! panel would freeze. Under-announcing is the one failure direction that is not allowed.
//!
//! So [`Announce::changed`] takes the fold position and moves the cursor to `max(cursor, seq) + 1`.
//! That is strictly monotone, so newest-wins coalescing still works, and always above the fold
//! position the change happened at, so no update can be lost — the worst case is one wasted
//! re-fetch on a hydrate that raced the change it was already carrying. It is also what lets a
//! change with no event behind it (a heartbeat, a `*.define`) announce at all.
//!
//! It is not state: nothing here is in any `snapshot()`, so no golden can see it.

/// One module's announce cursor. See the module header for why it is seq-valued.
#[derive(Debug, Default, Clone, Copy)]
pub struct Announce {
    cursor: i64,
}

impl Announce {
    /// The published state just changed, at fold position `seq`.
    ///
    /// `seq` is the module's own `seq` field; for a change with no event behind it, that is simply
    /// the last position the module folded to. Either way the cursor lands strictly above it.
    pub fn changed(&mut self, seq: i64) {
        self.cursor = self.cursor.max(seq) + 1;
    }

    /// What [`crate::EqModule::published_seq`] answers.
    #[must_use]
    pub fn cursor(&self) -> i64 {
        self.cursor
    }

    /// A new world. Zeroed alongside the module's own `seq`; a fresh attach builds a fresh
    /// `Serving`, so the new world's first beat announces every module regardless.
    pub fn reset(&mut self) {
        self.cursor = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::Announce;

    /// The properties the header rests on, stated as arithmetic.
    #[test]
    fn the_cursor_moves_only_when_told_and_always_past_the_fold_position() {
        let mut a = Announce::default();
        assert_eq!(a.cursor(), 0);
        // A thousand events folded with nothing to say move it not at all.
        assert_eq!(a.cursor(), 0);
        // A change at fold position 1000 lands above any snapshot seq a client could be holding
        // from before it.
        a.changed(1000);
        assert!(a.cursor() > 1000, "{}", a.cursor());
        // Two changes at the same position (a derived event carries its primary's seq) still move.
        let one = a.cursor();
        a.changed(1000);
        assert!(a.cursor() > one);
        // A change with no event behind it — the heartbeat case — moves the cursor even though the
        // fold position has not advanced since the last one.
        let two = a.cursor();
        a.changed(1000);
        assert!(a.cursor() > two);
        // And a much later event pulls the cursor back into seq space rather than crawling.
        a.changed(50_000);
        assert_eq!(a.cursor(), 50_001);
        a.reset();
        assert_eq!(a.cursor(), 0);
    }
}
