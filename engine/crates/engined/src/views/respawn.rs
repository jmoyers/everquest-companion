//! `respawn.watches` — one row per watched mob per zone: when it comes back, and where that number
//! came from.
//!
//! The order is a function of `now` (recently seen first, then unstale, then by remaining time), so
//! no sort over a column can express it. The source publishes the module's own position as the
//! integer field `order` instead, as [`super::timers`] does: the decision stays engine-side and what
//! crosses the wire is its answer.
//!
//! The instant behind that order is the module's own (`RespawnModule::now_ms`), never a fresh clock
//! read. A second clock would order the rows against an instant the model has never seen, and would
//! put a wall-clock read in the serve path.
//!
//! `gapsMs` — the recent measured gaps behind `observedMs` — is not a cell: a `Cell` is a scalar,
//! and joining the list into a string would only make the client split it back apart. The row
//! carries the two numbers the provenance line reads (`observedMs`, `samples`); the gap list stays
//! in `module.snapshot("respawn")`, where the drill-down already reads it.

use protocol::cell::Cell;
use protocol::generated::Cells;

use fold::modules::respawn::{RespawnModule, RespawnRow};

use super::{Field, Order, SourceDef, SourceRow};

/// The registry entry. See [`super::SourceDef`].
pub const WATCHES: SourceDef = SourceDef {
    id: "respawn.watches",
    fields: &[
        "order",
        "key",
        "display",
        "zone",
        "baseTs",
        "basis",
        "source",
        "samples",
        "kills",
        "seenTs",
        "estimateMs",
    ],
    default_sort: &[("order", Order::Asc)],
    tiebreak: ("order", Order::Asc),
    default_limit: super::DEFAULT_LIMIT,
};

/// Build the watch rows, in the module's own order.
///
/// The key is the row's own `id` (`<zone key>::<mob key>`), which the module builds to be stable
/// across ticks and files its history under. A mob watched in two zones is two rows and two clocks,
/// which the compound id says and a bare mob key would not.
#[must_use]
pub fn rows(module: &RespawnModule) -> Vec<SourceRow> {
    module
        .watch_rows(module.now_ms())
        .into_iter()
        .enumerate()
        .map(|(index, row)| {
            let order = i64::try_from(index).unwrap_or(i64::MAX);
            SourceRow {
                cells: cells(&row, order),
                fields: vec![
                    ("order", Field::Int(order)),
                    ("key", Field::Text(row.key.clone())),
                    ("display", Field::Text(row.display.clone())),
                    ("zone", Field::Text(row.zone.clone())),
                    ("baseTs", Field::Int(row.base_ts)),
                    ("basis", Field::Text(row.basis.to_owned())),
                    ("source", Field::Text(row.source.to_owned())),
                    ("samples", Field::Int(row.samples)),
                    ("kills", Field::Int(row.kills)),
                    ("seenTs", row.seen_ts.map_or(Field::Missing, Field::Int)),
                    (
                        "estimateMs",
                        row.estimate_ms.map_or(Field::Missing, Field::Int),
                    ),
                ],
                key: row.id,
            }
        })
        .collect()
}

fn cells(row: &RespawnRow, order: i64) -> Cells {
    let mut cells = std::collections::BTreeMap::new();
    cells.insert("display".to_owned(), Cell::text(&row.display));
    cells.insert("key".to_owned(), Cell::text(&row.key));
    cells.insert("zone".to_owned(), Cell::text(&row.zone));
    cells.insert("baseTs".to_owned(), Cell::int(row.base_ts));
    cells.insert("basis".to_owned(), Cell::text(row.basis));
    cells.insert("source".to_owned(), Cell::text(row.source));
    // `overridden` is the answer rather than the comparison: a client re-deriving it from the
    // `source` word beside it would hold a second copy of a rule that lives here.
    cells.insert("overridden".to_owned(), Cell::flag(row.source == "custom"));
    cells.insert("samples".to_owned(), Cell::int(row.samples));
    cells.insert("kills".to_owned(), Cell::int(row.kills));
    cells.insert(
        "seenTs".to_owned(),
        row.seen_ts.map_or_else(Cell::null, Cell::int),
    );
    cells.insert("seenVia".to_owned(), optional(row.seen_via));
    cells.insert(
        "estimateMs".to_owned(),
        row.estimate_ms.map_or_else(Cell::null, Cell::int),
    );
    cells.insert(
        "observedMs".to_owned(),
        row.observed_ms.map_or_else(Cell::null, Cell::int),
    );
    cells.insert(
        "customMs".to_owned(),
        row.custom_ms.map_or_else(Cell::null, Cell::int),
    );
    cells.insert("wikiText".to_owned(), optional(row.wiki_text.as_deref()));
    cells.insert(
        "wikiMs".to_owned(),
        row.wiki_ms.map_or_else(Cell::null, Cell::int),
    );
    cells.insert("wikiPage".to_owned(), optional(row.wiki_page.as_deref()));
    cells.insert("order".to_owned(), Cell::int(order));
    Cells(cells)
}

fn optional(value: Option<&str>) -> Cell {
    value.map_or_else(Cell::null, Cell::text)
}

#[cfg(test)]
mod tests {
    use super::{rows, WATCHES};
    use crate::views::{cut, validate};
    use protocol::generated::ViewDescriptor;
    use protocol::Cell;

    fn folded(lines: &[&str], prefs: serde_json::Value) -> fold::Fold {
        let mut f = fold::Fold::new(fold::registered(fold::ClusterDeps::default()), i64::MAX);
        f.registry.define("respawn", &prefs);
        for line in lines {
            f.on_primary(
                &fold::event::Event::from_json(line).expect("an event"),
                false,
            );
        }
        f
    }

    const ZONE: &str =
        r#"{"kind":"zone","seq":0,"ts":1787181707000,"raw":"z","zone":"Nagafen's Lair"}"#;
    const DEATH: &str = r#"{"kind":"death","seq":1,"ts":1787181707000,"raw":"d","name":"King Tranix","bySelf":true}"#;

    #[test]
    fn a_watched_mob_becomes_a_row_and_an_unwatched_one_does_not() {
        // Tracking is opt-in per mob, so the define is what puts this mob on a clock.
        let watched = folded(
            &[ZONE, DEATH],
            serde_json::json!({"watches": [{"key": "king tranix", "display": "King Tranix", "customSec": 1080}]}),
        );
        let module = watched.registry.respawn().expect("the respawn module");
        let built = rows(module);
        assert_eq!(built.len(), 1);
        assert_eq!(built[0].cells["display"], Cell::text("King Tranix"));
        assert_eq!(built[0].cells["zone"], Cell::text("Nagafen's Lair"));
        assert_eq!(built[0].cells["customMs"], Cell::int(1_080_000));
        // The user typed the number, so the row says the estimate is theirs as an answer rather
        // than as a comparison the client has to make.
        assert_eq!(built[0].cells["source"], Cell::text("custom"));
        assert_eq!(built[0].cells["overridden"], Cell::flag(true));
        // …and the key is the compound one, because a mob watched in two zones is two clocks.
        assert!(built[0].key.contains("::"), "{}", built[0].key);

        let unwatched = folded(&[ZONE, DEATH], serde_json::json!({"watches": []}));
        assert!(rows(unwatched.registry.respawn().expect("the module")).is_empty());
    }

    #[test]
    fn the_window_is_cut_in_the_modules_own_order() {
        let f = folded(
            &[ZONE, DEATH],
            serde_json::json!({"watches": [{"key": "king tranix", "display": "King Tranix"}]}),
        );
        let built = rows(f.registry.respawn().expect("the module"));
        let view = validate(&ViewDescriptor {
            source: WATCHES.id.to_owned(),
            filter: None,
            sort: Vec::new(),
            window: None,
        })
        .expect("a view");
        let (window, total) = cut(&view, &built);
        assert_eq!(total, i64::try_from(built.len()).unwrap());
        // `order` is 0..n in the served order, which is what makes the sort total without a second
        // unique column.
        for (i, row) in window.iter().enumerate() {
            assert_eq!(row.cells["order"], Cell::int(i64::try_from(i).unwrap()));
        }
    }
}
