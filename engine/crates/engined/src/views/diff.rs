//! THE DIFF, COMPUTED — the engine half of `src/shared/dataServer/viewWindow.ts`.
//!
//! One window state in, the next one in, and the ops that turn the first into the second. The
//! client's `applyDiff` is the CO-CONTRACT and it is the specification here: every op this file
//! emits must be one that file can apply as sent, because that file refuses rather than guesses —
//! an anchor it does not hold, a key it does not hold, a key it already holds are each a dropped
//! op and a debug note. An engine that emitted one of those would be an engine whose window and
//! its client's had silently parted.
//!
//! ── THE THREE OPS, AND WHAT THIS FILE PROMISES ABOUT EACH ──────────────────────────────────────
//!
//! * `drop` — a key that left the window. Emitted FIRST, all of them, before anything else in the
//!   batch, so that every anchor a later `insert` names is a row the client still holds.
//! * `insert` — a key that entered it, anchored `after` the row that will precede it or `before`
//!   the row that will follow it, and with NEITHER anchor exactly when the window is empty at that
//!   point. The anchors are computed against a WORKING COPY of the client's window that this file
//!   advances op by op — the same simulation the client is about to run — because "the row before
//!   it" means the row before it *after the earlier ops applied*, not in either input.
//! * `update` — CHANGED CELLS ONLY, which is rule 2 of the protocol. A cell whose value moved is
//!   sent; a cell that did not is omitted (the client leaves it alone); a cell the row USED to have
//!   and no longer does is sent as an explicit `null` (the client stores the null, so a cleared
//!   cell stays distinguishable from one the view never had).
//!
//! ── REORDERING, AND WHY THE ANSWER IS DROP-AND-REINSERT ────────────────────────────────────────
//!
//! There is no move op in the protocol. A row whose position changed is therefore a drop and an
//! insert, and this file finds the rows that have to move with a GREEDY forward scan rather than a
//! longest-increasing-subsequence: any survivor whose new position is not ahead of the last
//! survivor's is dropped and re-inserted. Greedy is not minimal — an LIS would move fewer rows on
//! an adversarial permutation — and minimal is not the bar: the bar is that the ops are correct and
//! that a window nobody reordered produces none of them, which greedy gives, in one pass, with no
//! allocation per row. The sources this engine serves append and window; a wholesale permutation is
//! what a RESET is for.

use std::collections::BTreeMap;

use protocol::cell::Cell;
use protocol::generated::{
    Cells, DiffOp, DropOp, DropOpOp, InsertOp, InsertOpOp, Row, UpdateOp, UpdateOpOp,
};

/// The ops that turn `held` into `next`, in the order the client must apply them.
///
/// An empty answer means the two windows are identical, which is the caller's signal to send
/// nothing at all — a diff frame with no ops is a frame that says nothing.
#[must_use]
pub fn diff(held: &[Row], next: &[Row]) -> Vec<DiffOp> {
    let wanted: BTreeMap<&str, usize> = next
        .iter()
        .enumerate()
        .map(|(at, row)| (row.key.0.as_str(), at))
        .collect();

    // ---- pass 1: everything that cannot stay where it is -----------------------------------
    //
    // A survivor is a row the next window still holds AND whose position is ahead of the last
    // survivor's. Everything else leaves, and the ops that say so go out first.
    let mut ops: Vec<DiffOp> = Vec::new();
    let mut work: Vec<&Row> = Vec::with_capacity(held.len());
    let mut furthest: Option<usize> = None;
    for row in held {
        let stays = match wanted.get(row.key.0.as_str()) {
            Some(&at) => furthest.is_none_or(|last| at > last),
            None => false,
        };
        if stays {
            furthest = wanted.get(row.key.0.as_str()).copied();
            work.push(row);
        } else {
            ops.push(DiffOp::DropOp(DropOp {
                op: DropOpOp::Drop,
                key: row.key.clone(),
            }));
        }
    }

    // ---- pass 2: walk the next window, inserting and updating in place ----------------------
    //
    // `work` is now a subsequence of `next`, so one forward walk settles both: at every position
    // the working copy either already holds the right key (an update, or nothing) or does not (an
    // insert). The anchors come off `work` as it stands at that moment, which is exactly what the
    // client will be holding when it reaches the op.
    for (at, row) in next.iter().enumerate() {
        if work.get(at).is_some_and(|held| held.key == row.key) {
            if let Some(cells) = changed(&work[at].cells, &row.cells) {
                ops.push(DiffOp::UpdateOp(UpdateOp {
                    op: UpdateOpOp::Update,
                    key: row.key.clone(),
                    cells,
                }));
            }
            continue;
        }
        // NEITHER ANCHOR MEANS THE WINDOW IS EMPTY, and the client reads it that way, so an insert
        // into a non-empty window must always name one. Preferring `after` the row before it keeps
        // an append — which is what a growing window mostly does — anchored on a row that is
        // already settled.
        let (before, after) = if at == 0 {
            (work.first().map(|r| r.key.clone()), None)
        } else {
            (None, work.get(at - 1).map(|r| r.key.clone()))
        };
        ops.push(DiffOp::InsertOp(InsertOp {
            op: InsertOpOp::Insert,
            before,
            after,
            row: row.clone(),
        }));
        work.insert(at.min(work.len()), row);
    }

    ops
}

/// The cells that moved between two states of one row, or `None` when none did.
///
/// A cell present in `next` with a different value is sent; a cell present in `held` and absent
/// from `next` is sent as an explicit null. The two together are what make an omitted cell mean
/// "unchanged" rather than "gone" — the client's `applyUpdate` merges, so there is no other way to
/// say a cell was cleared.
fn changed(held: &Cells, next: &Cells) -> Option<Cells> {
    let mut moved: BTreeMap<String, Cell> = BTreeMap::new();
    for (name, value) in next.iter() {
        if held.get(name) != Some(value) {
            moved.insert(name.clone(), value.clone());
        }
    }
    for name in held.keys() {
        if !next.contains_key(name) {
            moved.insert(name.clone(), Cell::null());
        }
    }
    if moved.is_empty() {
        None
    } else {
        Some(Cells(moved))
    }
}

/// Apply one batch to a window, exactly as `viewWindow.ts applyDiff` does.
///
/// THE ORACLE THIS FILE IS TESTED AGAINST, and it is a PORT rather than a paraphrase: every refusal
/// the client makes — an anchor the window does not hold, a key it does not hold, a key it already
/// holds — is a refusal here too, and it is counted. So a test that drives ops through it proves
/// what the client would do with them rather than what this file wishes it would do, and the one
/// assertion every case makes is that the count is zero.
///
/// TEST-ONLY: the engine never applies a diff, it only computes one. `tests/views.rs` proves the
/// same claim over a real socket by asserting the SHAPES the real binary sends — the anchors, the
/// keys, the changed cells — rather than by carrying a second copy of this.
///
/// Returns the window, and the number of ops that were REFUSED. A correct diff refuses none.
#[cfg(test)]
#[must_use]
pub fn apply(held: &[Row], ops: &[DiffOp]) -> (Vec<Row>, usize) {
    use protocol::generated::RowKey;
    let mut rows: Vec<Row> = held.to_vec();
    let mut refused = 0usize;
    let index_of = |rows: &Vec<Row>, key: &RowKey| rows.iter().position(|r| &r.key == key);
    for op in ops {
        match op {
            DiffOp::InsertOp(insert) => {
                if index_of(&rows, &insert.row.key).is_some() {
                    refused += 1;
                    continue;
                }
                let anchor = insert.before.as_ref().or(insert.after.as_ref());
                match anchor {
                    None => rows.push(insert.row.clone()),
                    Some(key) => match index_of(&rows, key) {
                        None => refused += 1,
                        Some(at) => {
                            let at = if insert.before.is_none() { at + 1 } else { at };
                            rows.insert(at, insert.row.clone());
                        }
                    },
                }
            }
            DiffOp::UpdateOp(update) => match index_of(&rows, &update.key) {
                None => refused += 1,
                Some(at) => {
                    let mut cells = rows[at].cells.0.clone();
                    for (name, value) in update.cells.iter() {
                        cells.insert(name.clone(), value.clone());
                    }
                    rows[at] = Row {
                        key: update.key.clone(),
                        cells: Cells(cells),
                    };
                }
            },
            DiffOp::DropOp(drop) => match index_of(&rows, &drop.key) {
                None => refused += 1,
                Some(at) => {
                    rows.remove(at);
                }
            },
        }
    }
    (rows, refused)
}

#[cfg(test)]
mod tests {
    use super::{apply, diff};
    use protocol::cell::Cell;
    use protocol::generated::{Cells, DiffOp, Row, RowKey};

    fn row(key: &str, cells: &[(&str, Cell)]) -> Row {
        Row {
            key: RowKey(key.to_owned()),
            cells: Cells(
                cells
                    .iter()
                    .map(|(name, value)| ((*name).to_owned(), value.clone()))
                    .collect(),
            ),
        }
    }

    fn plain(keys: &[&str]) -> Vec<Row> {
        keys.iter().map(|k| row(k, &[])).collect()
    }

    /// THE PROPERTY EVERY CASE IS CHECKED FOR: the ops turn the held window into the next one, and
    /// the client refuses none of them.
    fn round_trip(held: &[Row], next: &[Row]) -> Vec<DiffOp> {
        let ops = diff(held, next);
        let (got, refused) = apply(held, &ops);
        assert_eq!(refused, 0, "the client would have refused an op");
        assert_eq!(
            got.iter().map(|r| r.key.0.clone()).collect::<Vec<_>>(),
            next.iter().map(|r| r.key.0.clone()).collect::<Vec<_>>(),
            "the ops did not produce the next window"
        );
        for (a, b) in got.iter().zip(next) {
            assert_eq!(a.cells.0, b.cells.0, "the cells of {} diverged", a.key.0);
        }
        ops
    }

    #[test]
    fn a_window_that_did_not_move_produces_no_ops_at_all() {
        let held = plain(&["a", "b", "c"]);
        assert!(diff(&held, &held).is_empty());
    }

    #[test]
    fn an_insert_at_the_head_names_the_row_it_goes_before() {
        // The loot case: a kill drops a row into a newest-first window.
        let ops = round_trip(&plain(&["b", "c"]), &plain(&["a", "b", "c"]));
        let [DiffOp::InsertOp(insert)] = ops.as_slice() else {
            panic!("one insert, got {ops:?}");
        };
        assert_eq!(insert.before.as_deref().map(String::as_str), Some("b"));
        assert!(insert.after.is_none(), "exactly one anchor");
    }

    #[test]
    fn an_insert_and_the_drop_it_pushes_out_ride_the_same_batch() {
        // A FULL newest-first window: the new row enters at the head and the oldest falls out.
        let ops = round_trip(&plain(&["b", "c", "d"]), &plain(&["a", "b", "c"]));
        assert_eq!(ops.len(), 2, "{ops:?}");
        // The drop goes FIRST — see the module header — so every anchor is a row still held.
        assert!(matches!(ops[0], DiffOp::DropOp(_)));
        assert!(matches!(ops[1], DiffOp::InsertOp(_)));
    }

    #[test]
    fn an_append_names_the_row_it_goes_after() {
        let ops = round_trip(&plain(&["a"]), &plain(&["a", "b"]));
        let [DiffOp::InsertOp(insert)] = ops.as_slice() else {
            panic!("one insert, got {ops:?}");
        };
        assert_eq!(insert.after.as_deref().map(String::as_str), Some("a"));
        assert!(insert.before.is_none());
    }

    #[test]
    fn the_first_row_of_an_empty_window_names_no_anchor_at_all() {
        let ops = round_trip(&[], &plain(&["only"]));
        let [DiffOp::InsertOp(insert)] = ops.as_slice() else {
            panic!("one insert");
        };
        assert!(insert.before.is_none() && insert.after.is_none());
    }

    #[test]
    fn several_inserts_in_one_batch_anchor_on_each_other() {
        // The second insert's anchor is a row the FIRST one put there — which only works because
        // the anchors are computed against a working copy that advances with the batch.
        round_trip(&plain(&["a"]), &plain(&["a", "b", "c", "d"]));
        round_trip(&[], &plain(&["a", "b", "c"]));
        round_trip(&plain(&["c"]), &plain(&["a", "b", "c"]));
    }

    #[test]
    fn an_update_carries_the_cells_that_moved_and_no_others() {
        let held = vec![row(
            "ally:Primitive",
            &[
                ("name", Cell::text("Primitive")),
                ("damage", Cell::int(180_000)),
                ("dps", Cell::float(400.0)),
            ],
        )];
        let next = vec![row(
            "ally:Primitive",
            &[
                ("name", Cell::text("Primitive")),
                ("damage", Cell::int(184_220)),
                ("dps", Cell::float(412.6)),
            ],
        )];
        let ops = round_trip(&held, &next);
        let [DiffOp::UpdateOp(update)] = ops.as_slice() else {
            panic!("one update, got {ops:?}");
        };
        assert_eq!(
            update.cells.len(),
            2,
            "`name` did not move and was not sent"
        );
        assert_eq!(update.cells["damage"], Cell::int(184_220));
        assert_eq!(update.cells["dps"], Cell::float(412.6));
    }

    #[test]
    fn a_cell_the_row_no_longer_has_is_cleared_with_an_explicit_null() {
        let held = vec![row(
            "loot:0",
            &[
                ("item", Cell::text("Bone Chips")),
                ("zone", Cell::text("Oasis")),
            ],
        )];
        let next = vec![row("loot:0", &[("item", Cell::text("Bone Chips"))])];
        let ops = diff(&held, &next);
        let [DiffOp::UpdateOp(update)] = ops.as_slice() else {
            panic!("one update, got {ops:?}");
        };
        assert_eq!(update.cells["zone"], Cell::null());
        // The client STORES the null rather than deleting the key, which is what keeps a cleared
        // cell distinguishable from one the view never had — so the round trip is checked against
        // that, not against the engine's own next window.
        let (got, refused) = apply(&held, &ops);
        assert_eq!(refused, 0);
        assert_eq!(got[0].cells["zone"], Cell::null());
    }

    #[test]
    fn a_row_that_moved_leaves_and_comes_back() {
        // No move op exists. The drop precedes the insert, so the client is never asked to insert a
        // key it already holds.
        let ops = round_trip(&plain(&["a", "b", "c"]), &plain(&["c", "a", "b"]));
        assert!(matches!(ops[0], DiffOp::DropOp(_)), "{ops:?}");
    }

    #[test]
    fn a_key_reused_for_different_contents_is_an_update_rather_than_a_tear() {
        // The rebirth case: the ledger cleared and refilled, so `loot:0` is a different loot. The
        // key is the same, so the honest op is an update of every cell that moved — the client's
        // window ends up right either way, which is the point of checking the round trip.
        let held = vec![row("loot:0", &[("item", Cell::text("Beta Sword"))])];
        let next = vec![row("loot:0", &[("item", Cell::text("Live Sword"))])];
        round_trip(&held, &next);
    }

    #[test]
    fn a_window_that_emptied_drops_every_row_it_had() {
        let ops = round_trip(&plain(&["a", "b"]), &[]);
        assert_eq!(ops.len(), 2);
        assert!(ops.iter().all(|op| matches!(op, DiffOp::DropOp(_))));
    }

    #[test]
    fn a_scramble_still_round_trips_however_unlikely_it_is() {
        // Not a shape any source produces — a wholesale permutation is what a reset is for — but
        // the ops must be applicable whatever two windows are handed over, because a refused op is
        // a client whose window has silently parted from the engine's.
        let held = plain(&["a", "b", "c", "d", "e"]);
        for next in [
            plain(&["e", "d", "c", "b", "a"]),
            plain(&["c", "a", "e"]),
            plain(&["f", "a", "g", "c", "h"]),
            plain(&["b", "a"]),
        ] {
            round_trip(&held, &next);
        }
    }
}
