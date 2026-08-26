//! `eventFeed.recent` — THE EVENTS OVERLAY'S RING (JOS-487).
//!
//! ── IT WAS UNREGISTERED FOR TWO REASONS AND TWO TICKETS TOOK THEM AWAY SEPARATELY ──────────────
//!
//! `views::mod`'s header used to say that a view over the event feed "could only ever serve an empty
//! window and no test could tell a working one from a broken one". Both clauses were true when they
//! were written and neither is now.
//!
//! The SECOND clause is what this file answers: the projection is a pure function of a ring, so it
//! is exercised against a hand-built one below, and a broken cell fails a test whether or not any
//! fold can produce the entry it mangled. That was the whole of the argument for registering the
//! source even while the ring was empty — a client subscribing during the cutover is then told
//! **nothing here yet** rather than **no such surface**, which are different things for a renderer
//! to be told.
//!
//! The FIRST clause went with JOS-486, in the same wave and not by this ticket: the feed's loot
//! source admits a row only through an injected item probe, and that probe is a real in-process
//! lookup now. A live loot line puts a row in this ring.
//!
//! ── THE ROW IS THE MODULE'S OWN STRUCT ─────────────────────────────────────────────────────────
//!
//! `FeedEvent`, read field by field rather than through `snapshot()`'s JSON — the pull-seam rule the
//! whole view layer keeps. What the fold does NOT carry is worth naming, because the app's own
//! `FeedEvent` does: there is no `reward` block here (the quest source arrives out of band from the
//! renderer and is not on the bus at all), so this source publishes no reward cells. A cell for a
//! block nothing fills would be a column that is null forever.
//!
//! ── THE CON BLOCK IS FLATTENED, BECAUSE A `Cell` IS A SCALAR ───────────────────────────────────
//!
//! `FeedEvent.con` is an object. It becomes prefixed cells (`conFaction`, `conLevel`, …) rather
//! than a JSON string: a client that had to `JSON.parse` a cell would be doing the munging ruling 4
//! forbids, and a nested cell is not a thing the diff protocol can update — `UpdateOp` carries
//! CHANGED CELLS, so a nested object would be re-sent whole every time one number inside it moved.

use protocol::cell::Cell;
use protocol::generated::Cells;

use fold::modules::event_feed::{EventFeedModule, FeedEvent};

use super::{Field, Order, SourceDef, SourceRow};

/// The registry entry. See [`super::SourceDef`].
pub const RECENT: SourceDef = SourceDef {
    id: "eventFeed.recent",
    fields: &["at", "seq", "kind", "title"],
    // NEWEST FIRST — the overlay stores the ring oldest-last and reverses it to draw.
    default_sort: &[("at", Order::Desc), ("seq", Order::Desc)],
    tiebreak: ("seq", Order::Asc),
    default_limit: super::DEFAULT_LIMIT,
};

/// Build a row per feed entry, in the ring's own order.
#[must_use]
pub fn rows(module: &EventFeedModule) -> Vec<SourceRow> {
    rows_of(module.ring())
}

/// The projection itself, over a ring rather than over a module.
///
/// SPLIT OUT SO IT CAN BE TESTED, and that split is this file's whole answer to the objection that
/// kept the source unregistered — see the header. It takes the ring directly and pins every cell.
///
/// THE KEY IS THE ENTRY'S OWN `id`, which the feed mints per entry (`f1`, `f2`, …) precisely so that
/// two identical lines a second apart are two rows. Falling back to the position would be wrong for
/// this ring in a way it is not for the loot ledger: the feed drops from the FRONT at a hundred, so
/// a position names a different event after the hundred-and-first.
#[must_use]
pub fn rows_of(ring: &[FeedEvent]) -> Vec<SourceRow> {
    ring.iter()
        .enumerate()
        .map(|(index, entry)| {
            let seq = i64::try_from(index).unwrap_or(i64::MAX);
            SourceRow {
                key: entry.id.clone(),
                cells: cells(entry),
                fields: vec![
                    ("at", Field::Int(entry.ts)),
                    ("seq", Field::Int(seq)),
                    ("kind", Field::Text(entry.kind.to_owned())),
                    ("title", Field::Text(entry.title.clone())),
                ],
            }
        })
        .collect()
}

fn cells(entry: &FeedEvent) -> Cells {
    let con = entry.con.as_ref();
    let mut cells = std::collections::BTreeMap::new();
    cells.insert("at".to_owned(), Cell::int(entry.ts));
    cells.insert("kind".to_owned(), Cell::text(entry.kind));
    cells.insert("title".to_owned(), Cell::text(&entry.title));
    cells.insert("detail".to_owned(), optional(entry.detail.as_deref()));
    cells.insert("page".to_owned(), optional(entry.page.as_deref()));
    cells.insert(
        "conFaction".to_owned(),
        optional(con.map(|c| c.faction.as_str())),
    );
    cells.insert(
        "conDifficulty".to_owned(),
        optional(con.map(|c| c.difficulty.as_str())),
    );
    cells.insert(
        "conLevel".to_owned(),
        con.and_then(|c| c.level).map_or_else(Cell::null, Cell::int),
    );
    // ABSENT AND FALSE ARE THE SAME ANSWER HERE, and only here: `rare` is a flag the parser writes
    // only when the infix was on the line, so "no con block at all" and "a con block with no rare
    // flag" both mean this creature is not rare. A cell of `null` would make a renderer branch on a
    // distinction that carries no information.
    cells.insert(
        "conRare".to_owned(),
        Cell::flag(con.is_some_and(|c| c.rare)),
    );
    Cells(cells)
}

fn optional(value: Option<&str>) -> Cell {
    value.map_or_else(Cell::null, Cell::text)
}

#[cfg(test)]
mod tests {
    use super::{rows, rows_of, RECENT};
    use crate::views::{cut, validate, SourceRow};
    use fold::modules::event_feed::{FeedConsider, FeedEvent};
    use protocol::generated::ViewDescriptor;
    use protocol::Cell;

    fn a_quest() -> FeedEvent {
        FeedEvent {
            id: "f1".to_owned(),
            kind: "quest",
            ts: 1_787_181_707_000,
            title: "Coldain Ring 3".to_owned(),
            detail: Some("Handed in to Corflunk".to_owned()),
            page: Some("Coldain_Ring_War".to_owned()),
            con: None,
        }
    }

    fn a_con() -> FeedEvent {
        FeedEvent {
            id: "f2".to_owned(),
            kind: "con",
            ts: 1_787_181_767_000,
            title: "a fire giant warlord".to_owned(),
            detail: None,
            page: None,
            con: Some(FeedConsider {
                faction: "threateningly".to_owned(),
                level: Some(52),
                rare: true,
                difficulty: "looks like quite a gamble".to_owned(),
            }),
        }
    }

    fn projected(ring: &[FeedEvent]) -> Vec<SourceRow> {
        rows_of(ring)
    }

    #[test]
    fn the_con_block_is_flattened_into_scalars() {
        let built = projected(&[a_quest(), a_con()]);
        assert_eq!(built[0].key, "f1", "the entry's own minted id");
        assert_eq!(
            built[0].cells["detail"],
            Cell::text("Handed in to Corflunk")
        );
        assert_eq!(built[1].cells["conFaction"], Cell::text("threateningly"));
        assert_eq!(built[1].cells["conLevel"], Cell::int(52));
        assert_eq!(built[1].cells["conRare"], Cell::flag(true));
        assert_eq!(
            built[1].cells["conDifficulty"],
            Cell::text("looks like quite a gamble")
        );
        // An entry with no con block says NULL for each of its cells rather than dropping them: a
        // diff needs a cell to be able to become null.
        assert_eq!(built[0].cells["conFaction"], Cell::null());
        assert_eq!(built[0].cells["conLevel"], Cell::null());
        // …and is not RARE rather than unknown, which is this source's one absent-equals-false.
        assert_eq!(built[0].cells["conRare"], Cell::flag(false));
        // A row that carries neither detail nor page says so as null too.
        assert_eq!(built[1].cells["detail"], Cell::null());
        assert_eq!(built[1].cells["page"], Cell::null());
    }

    #[test]
    fn the_default_window_is_newest_first() {
        let built = projected(&[a_quest(), a_con()]);
        let view = validate(&ViewDescriptor {
            source: RECENT.id.to_owned(),
            filter: None,
            sort: Vec::new(),
            window: None,
        })
        .expect("a view");
        let (window, total) = cut(&view, &built);
        assert_eq!(total, 2);
        assert_eq!(
            window.iter().map(|r| r.key.0.as_str()).collect::<Vec<_>>(),
            ["f2", "f1"]
        );
    }

    #[test]
    fn a_historical_fold_serves_an_empty_window_and_that_is_the_hydration_rule() {
        // THE MODULE'S OWN LAW, PINNED FROM THIS SIDE: the feed admits nothing historical, so a
        // whole registry fed a zone, a loot and a consider line with `live: false` still leaves this
        // ring empty. That is the silent baseline the app's celebration rule asks for, and it is
        // what stops a startup replay spamming the overlay with hours-old events.
        let mut f = fold::Fold::new(fold::registered(fold::ClusterDeps::default()), i64::MAX);
        for line in [
            r#"{"kind":"zone","seq":0,"ts":1787181707000,"raw":"z","zone":"Nagafen's Lair"}"#,
            r#"{"kind":"loot","seq":1,"ts":1787181707000,"raw":"l","item":"Cloak of Flames","source":"a fire giant warlord"}"#,
            r#"{"kind":"consider","seq":2,"ts":1787181717000,"raw":"c","mob":"a fire giant warlord","level":52,"faction":"threateningly","difficulty":"even"}"#,
        ] {
            f.on_primary(
                &fold::event::Event::from_json(line).expect("an event"),
                false,
            );
        }
        let module = f.registry.event_feed().expect("the eventFeed module");
        assert!(rows(module).is_empty());
    }
}
