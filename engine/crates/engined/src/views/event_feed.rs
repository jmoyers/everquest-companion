//! `eventFeed.recent` — the events overlay's ring.
//!
//! The row is the module's own `FeedEvent`, read field by field rather than through `snapshot()`'s
//! JSON. Unlike the app's `FeedEvent` there is no `reward` block: the quest source is not on the
//! bus at all, and a cell for a block nothing fills would be a column that is null forever.
//!
//! `FeedEvent.con` is an object, so it becomes prefixed cells (`conFaction`, `conLevel`, …) rather
//! than a JSON string a client would have to parse. A nested cell is also not a thing the diff
//! protocol can update — `UpdateOp` carries changed cells, so a nested object would be re-sent whole
//! every time one number inside it moved.

use protocol::cell::Cell;
use protocol::generated::Cells;

use fold::modules::event_feed::{EventFeedModule, FeedEvent};

use super::{Field, Order, SourceDef, SourceRow};

/// The registry entry. See [`super::SourceDef`].
pub const RECENT: SourceDef = SourceDef {
    id: "eventFeed.recent",
    fields: &["at", "seq", "kind", "title"],
    // Newest first — the overlay stores the ring oldest-last and reverses it to draw.
    default_sort: &[("at", Order::Desc), ("seq", Order::Desc)],
    tiebreak: ("seq", Order::Asc),
    default_limit: super::DEFAULT_LIMIT,
};

/// Build a row per feed entry, in the ring's own order.
#[must_use]
pub fn rows(module: &EventFeedModule) -> Vec<SourceRow> {
    rows_of(module.ring())
}

/// The projection itself, over a ring rather than over a module, so it can be tested directly.
///
/// The key is the entry's own minted `id` (`f1`, `f2`, …), so two identical lines a second apart
/// are two rows. A ring position would not do: the feed drops from the front at a hundred, so a
/// position names a different event after the hundred-and-first.
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
    // Absent and false are the same answer for `rare`, and only for `rare`: the parser writes the
    // flag only when the infix was on the line, so no con block and a con block without it both
    // mean not rare.
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
        // An entry with no con block says null for each of its cells rather than dropping them: a
        // diff needs a cell to be able to become null.
        assert_eq!(built[0].cells["conFaction"], Cell::null());
        assert_eq!(built[0].cells["conLevel"], Cell::null());
        // …and is not rare rather than unknown, which is this source's one absent-equals-false.
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
        // The feed admits nothing historical, which is what stops a startup replay spamming the
        // overlay with hours-old events.
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
