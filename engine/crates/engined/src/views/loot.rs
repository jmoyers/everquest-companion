//! `loot.ledger` — THE FIRST PRODUCT VIEW SOURCE (JOS-480).
//!
//! The chronological loot ledger, newest first: the flat table `LootTables.tsx FlatLootTable`
//! draws, served render-ready. It reads the `loot` module's rows through the pull seam
//! (`fold::EqModule::as_loot`) and never through `snapshot()` — see that seam for why.
//!
//! ── WHAT A CELL IS HERE, read off the renderer that draws it ───────────────────────────────────
//!
//! `FlatLootTable`'s header row is `Time · Item · From · Zone`, and `FlatRow` draws, in order: the
//! timestamp through `fmtTime`; the item name, prefixed `N × ` when the line stated a stack size;
//! a disposition chip; a `→ created` caption on a `combined` row; the source; the zone. So the
//! cells are `at`, `item`, `count`, `from`, `zone`, `disposition`, `created` — seven, and each one
//! is a thing the reader can actually see.
//!
//! **THE COUNT IS ITS OWN CELL rather than being composed into `item`, and that is the judgment
//! call worth stating.** `2 × Bone Chips` is literally what the pixel says, so composing it here
//! would be defensible on ruling 4's own words. It is not done because the composed string is
//! LOSSY: every other reader of this row — the drill-down, the grouped table, a future
//! `loot.byItem` source — wants the item's NAME and the stack size as a number, and a client that
//! had to split `"2 × Bone Chips"` back apart would be doing exactly the munging the ruling
//! forbids. Two cells is the honest decomposition; joining them with `×` is a format, in the same
//! class as rounding a percentage for the bar it is drawn in.
//!
//! **AN ABSENT VALUE IS `null`, never `"-"`.** The renderer draws a dash for a loot row that names
//! no source, and a dash is what the pixel says — but a cell of `"-"` cannot be told apart from an
//! item genuinely called `-`, and it would take the diff protocol's explicit-null clear away from
//! this source entirely (an absent cell is UNCHANGED and a null cell is CLEARED; there is no third
//! spelling). The dash stays a display decision about absence, which is what it always was.
//!
//! ── THE TIMESTAMP IS A FIXED PATTERN, not a locale call ────────────────────────────────────────
//!
//! `fmtTime` is `formatDateTime(ts, { month: 'short', day: '2-digit', hour: '2-digit', minute:
//! '2-digit' })` — `toLocaleString` with the runtime's own locale. This engine renders the en-US
//! form of exactly those options (`Aug 19, 04:21 PM`) as a FIXED pattern, and the divergence is
//! deliberate rather than overlooked: a host collation or a host locale anywhere in the serve path
//! makes the engine's answer a property of the machine, and determinism is cacheability (ruling 18
//! law 1) — the same rule that forbids `localeCompare` in the sort. The ZONE is not a locale and
//! is honoured: the instant is resolved through the parser's own clock, which is the zone the log's
//! timestamps were read in, so the string says the wall clock the player's machine would show.

use protocol::cell::Cell;
use protocol::generated::Cells;

use super::{Field, Order, SourceDef, SourceRow};

/// The registry entry. See [`super::SourceDef`].
pub const LEDGER: SourceDef = SourceDef {
    id: "loot.ledger",
    // `seq` is a FIELD WITH NO CELL: the row's position in the append-only ledger, which is what
    // makes the order total (see the module header of `views`). `at` is the opposite of a cell
    // with the same name — the instant, in millis, not the string drawn from it.
    fields: &["at", "seq", "item", "count", "from", "zone", "disposition"],
    // NEWEST FIRST, which is what the flat ledger shows: `filterLootEvents` ends in `.reverse()`.
    // The second term is what makes that exact — EQ stamps to the second, so a corpse yielding
    // three items writes three rows at one instant, and reversing the ledger puts the LAST-folded
    // of them first.
    default_sort: &[("at", Order::Desc), ("seq", Order::Desc)],
    tiebreak: ("seq", Order::Asc),
    default_limit: super::DEFAULT_LIMIT,
};

/// Build every row of the ledger, in the module's own append order.
///
/// THE KEY IS THE ROW'S POSITION — `loot:<n>` — because that is the only identity this ledger has:
/// the module appends and never edits, so a position names one loot for as long as the ledger
/// holds it. A rebirth boundary clears the ledger and positions start again, which is exactly why
/// the module's REVISION counter exists rather than its length: the view is re-cut, and the diff
/// between the old window and the new one says what the client has to do about it.
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

/// The three-letter month names the en-US short form uses. ASCII and fixed — see the module header.
const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// `Aug 19, 04:21 PM` — the en-US rendering of `fmtTime`'s options, through the parser's zone.
///
/// A ts of 0 renders EMPTY, which is `formatDate.ts`'s own rule stated in its header: "a falsy/0 ts
/// renders as empty (unknown timestamp)". A stamp the parser could not read is 0, so this is the
/// one place the two languages have to agree about an unknown instant, and they do.
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
    // 12-hour with a leading zero, exactly as `hour: '2-digit'` renders under `hour12` defaulted
    // for en-US: midnight and noon are 12, not 00.
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

    /// A fold with the twenty modules registered, fed hand-written events. `launch_ms` is
    /// `i64::MAX` so the rebirth boundary never fires and the ledger keeps what it is given — the
    /// same trick `fold`'s own unit tests use.
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
        // ABSENCE IS NULL, not a dash and not a missing key: the diff protocol needs a cell to be
        // able to become null, and the renderer's dash is a display decision about absence.
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
        // The FIELD and the CELL of the same name are different values, which is the distinction
        // the whole view layer turns on: `at` renders as text and sorts as an instant.
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
        // Midnight and noon are 12, never 00 — the one place a 12-hour clock is easy to get wrong.
        let midnight = clock().parse_eq_timestamp("Wed Aug 19 00:05:00 2026");
        assert_eq!(display_time(&clock(), midnight), "Aug 19, 12:05 AM");
        let noon = clock().parse_eq_timestamp("Wed Aug 19 12:05:00 2026");
        assert_eq!(display_time(&clock(), noon), "Aug 19, 12:05 PM");
        // An unknown instant renders empty, which is `formatDate.ts`'s own falsy-ts rule.
        assert_eq!(display_time(&clock(), 0), "");
    }
}
