//! `loot.ledger` — the chronological loot ledger, newest first, as the flat table draws it. Rows
//! come through the `loot` module's pull seam (`fold::EqModule::as_loot`), never through
//! `snapshot()`.
//!
//! The cells are `at`, `item`, `count`, `from`, `zone`, `disposition`, `created` — one per thing the
//! reader can see.
//!
//! The count is its own cell rather than composed into `item`. `2 × Bone Chips` is what the pixel
//! says, but the composed string is lossy: every other reader of this row wants the name and the
//! stack size separately, and splitting it back apart client-side is the munging the layer exists to
//! prevent.
//!
//! An absent value is `null`, never `"-"`. The renderer's dash is a display decision about absence;
//! a cell of `"-"` could not be told apart from an item genuinely called `-`, and it would cost this
//! source the diff protocol's explicit-null clear.
//!
//! The timestamp is a fixed en-US pattern (`Aug 19, 04:21 PM`) rather than a locale call: a host
//! locale anywhere in the serve path makes the answer a property of the machine, and determinism is
//! cacheability — the same rule that forbids `localeCompare` in the sort. The time ZONE is not a
//! locale and is honoured, through the parser's own clock, so the string says the wall clock the
//! player's machine would show.

use protocol::cell::Cell;
use protocol::generated::Cells;

use super::{Field, Order, SourceDef, SourceRow};

/// The registry entry. See [`super::SourceDef`].
pub const LEDGER: SourceDef = SourceDef {
    id: "loot.ledger",
    // `seq` is a field with no cell: the row's position in the append-only ledger, which is what
    // makes the order total. The `at` field is the instant in millis, not the string drawn from it.
    fields: &["at", "seq", "item", "count", "from", "zone", "disposition"],
    // Newest first, which is what the flat ledger shows. The second term is what makes that exact:
    // EQ stamps to the second, so a corpse yielding three items writes three rows at one instant,
    // and reversing the ledger puts the last-folded of them first.
    default_sort: &[("at", Order::Desc), ("seq", Order::Desc)],
    tiebreak: ("seq", Order::Asc),
    default_limit: super::DEFAULT_LIMIT,
};

/// Build every row of the ledger, in the module's own append order.
///
/// The key is the row's position (`loot:<n>`), the only identity this ledger has: the module appends
/// and never edits, so a position names one loot for as long as the ledger holds it. A rebirth
/// boundary clears the ledger and positions start again — the module's revision counter is what
/// handles that, by re-cutting the view and diffing.
#[must_use]
pub fn rows(module: &fold::modules::loot::LootModule, clock: &eqlog::Clock) -> Vec<SourceRow> {
    module
        .rows()
        .iter()
        .enumerate()
        .map(|(index, row)| {
            let at = row.ts();
            let seq = i64::try_from(index).unwrap_or(i64::MAX);
            let mut cells = std::collections::BTreeMap::new();
            cells.insert("at".to_owned(), Cell::text(display_time(clock, at)));
            cells.insert("item".to_owned(), Cell::text(row.item()));
            cells.insert(
                "count".to_owned(),
                row.count().map_or(Cell::null(), Cell::int),
            );
            cells.insert("from".to_owned(), optional(row.source()));
            cells.insert("zone".to_owned(), optional(row.zone()));
            cells.insert("disposition".to_owned(), optional(row.disposition()));
            cells.insert("created".to_owned(), optional(row.created()));
            SourceRow {
                key: format!("loot:{index}"),
                cells: Cells(cells),
                fields: vec![
                    ("at", Field::Int(at)),
                    ("seq", Field::Int(seq)),
                    ("item", Field::Text(row.item().to_owned())),
                    ("count", row.count().map_or(Field::Missing, Field::Int)),
                    ("from", text_or_missing(row.source())),
                    ("zone", text_or_missing(row.zone())),
                    ("disposition", text_or_missing(row.disposition())),
                ],
            }
        })
        .collect()
}

fn optional(value: Option<&str>) -> Cell {
    value.map_or_else(Cell::null, Cell::text)
}

fn text_or_missing(value: Option<&str>) -> Field {
    value.map_or(Field::Missing, |v| Field::Text(v.to_owned()))
}

/// The three-letter month names the en-US short form uses. ASCII and fixed, never a locale call.
const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// `Aug 19, 04:21 PM` — the en-US rendering of `fmtTime`'s options, through the parser's zone.
///
/// A ts of 0 renders empty, matching `formatDate.ts`: a falsy ts is an unknown timestamp, and a
/// stamp the parser could not read is 0.
pub(super) fn display_time(clock: &eqlog::Clock, ms: i64) -> String {
    if ms == 0 {
        return String::new();
    }
    let Some(t) = clock.civil(ms) else {
        return String::new();
    };
    let month = MONTHS
        .get(usize::try_from(t.month).unwrap_or(0).saturating_sub(1))
        .copied()
        .unwrap_or("???");
    // 12-hour with a leading zero, as `hour: '2-digit'` renders for en-US: midnight and noon are
    // 12, not 00.
    let meridiem = if t.hour < 12 { "AM" } else { "PM" };
    let hour12 = match t.hour % 12 {
        0 => 12,
        h => h,
    };
    format!(
        "{month} {day:02}, {hour12:02}:{minute:02} {meridiem}",
        day = t.day,
        minute = t.minute
    )
}

#[cfg(test)]
mod tests {
    use super::{display_time, rows, LEDGER};
    use crate::views::{cut, validate, Field};
    use fold::event::Event;
    use fold::{ClusterDeps, Fold};
    use protocol::generated::ViewDescriptor;

    fn clock() -> eqlog::Clock {
        eqlog::Clock::new(eqlog::Tz::America__Los_Angeles)
    }

    /// A fold fed hand-written events. `launch_ms` is `i64::MAX` so the rebirth boundary never
    /// fires and the ledger keeps what it is given.
    fn folded(lines: &[&str]) -> Fold {
        let mut fold = Fold::new(fold::registered(ClusterDeps::default()), i64::MAX);
        for line in lines {
            fold.on_primary(&Event::from_json(line).expect("an event"), false);
        }
        fold
    }

    const A_ZONE: &str =
        r#"{"kind":"zone","seq":0,"ts":1787181707000,"raw":"z","zone":"Nagafen's Lair"}"#;
    const A_LOOT: &str = r#"{"kind":"loot","seq":1,"ts":1787181707000,"raw":"l","item":"Cloak of Flames","source":"a fire giant warlord"}"#;
    const A_STACK: &str =
        r#"{"kind":"loot","seq":2,"ts":1787181767000,"raw":"l","item":"Bone Chips","count":2}"#;

    #[test]
    fn a_row_carries_what_the_flat_ledger_draws() {
        let fold = folded(&[A_ZONE, A_LOOT]);
        let built = rows(fold.registry.loot().expect("the loot module"), &clock());
        assert_eq!(built.len(), 1);
        let cells = &built[0].cells;
        assert_eq!(built[0].key, "loot:0");
        assert_eq!(cells["at"], protocol::Cell::text("Aug 19, 04:21 PM"));
        assert_eq!(cells["item"], protocol::Cell::text("Cloak of Flames"));
        assert_eq!(cells["from"], protocol::Cell::text("a fire giant warlord"));
        assert_eq!(cells["zone"], protocol::Cell::text("Nagafen's Lair"));
        // Absence is null, not a dash and not a missing key: the diff protocol needs a cell to be
        // able to become null.
        assert_eq!(cells["count"], protocol::Cell::null());
        assert_eq!(cells["disposition"], protocol::Cell::null());
        assert_eq!(cells["created"], protocol::Cell::null());
    }

    #[test]
    fn the_stack_size_is_a_number_beside_the_name_rather_than_inside_it() {
        let fold = folded(&[A_ZONE, A_LOOT, A_STACK]);
        let built = rows(fold.registry.loot().expect("the loot module"), &clock());
        assert_eq!(built[1].cells["item"], protocol::Cell::text("Bone Chips"));
        assert_eq!(built[1].cells["count"], protocol::Cell::int(2));
        // The field and the cell of the same name are different values: `at` renders as text and
        // sorts as an instant.
        assert_eq!(
            built[1]
                .fields
                .iter()
                .find(|(f, _)| *f == "at")
                .map(|(_, v)| v),
            Some(&Field::Int(1_787_181_767_000))
        );
    }

    #[test]
    fn the_default_order_is_the_reverse_of_the_ledger() {
        let fold = folded(&[A_ZONE, A_LOOT, A_STACK]);
        let built = rows(fold.registry.loot().expect("the loot module"), &clock());
        let view = validate(&ViewDescriptor {
            source: LEDGER.id.to_owned(),
            filter: None,
            sort: Vec::new(),
            window: None,
        })
        .expect("a view");
        let (window, total) = cut(&view, &built);
        assert_eq!(total, 2);
        assert_eq!(
            window.iter().map(|r| r.key.0.as_str()).collect::<Vec<_>>(),
            ["loot:1", "loot:0"]
        );
    }

    #[test]
    fn the_displayed_time_is_the_wall_clock_the_players_machine_would_show() {
        // The corpus's own first line, in the zone the goldens were recorded under.
        assert_eq!(
            display_time(&clock(), 1_787_181_707_000),
            "Aug 19, 04:21 PM"
        );
        // Midnight and noon are 12, never 00.
        let midnight = clock().parse_eq_timestamp("Wed Aug 19 00:05:00 2026");
        assert_eq!(display_time(&clock(), midnight), "Aug 19, 12:05 AM");
        let noon = clock().parse_eq_timestamp("Wed Aug 19 12:05:00 2026");
        assert_eq!(display_time(&clock(), noon), "Aug 19, 12:05 PM");
        // An unknown instant renders empty, matching `formatDate.ts`'s falsy-ts rule.
        assert_eq!(display_time(&clock(), 0), "");
    }
}
