//! `progression.recent` — THE THINGS THAT ADVANCED, newest first (JOS-487).
//!
//! Two of the `progression` module's columns read as one list: the level dings (`levelTs` /
//! `levelValue`) and the AA gains (`aaGainTs` / `aaGainAmount`). Both are UNCAPPED in the module,
//! deliberately — "the chart needs every ding" — so this is the one source in the registry whose
//! underlying collection grows without bound, which is exactly what a windowed view is for.
//!
//! ── THE ONE SOURCE WHOSE CELLS ARE NOT READ OFF A COMPONENT, AND IT SAYS SO ────────────────────
//!
//! Every other source in this registry was built by opening the file that draws it and listing what
//! it prints. This one cannot be: the Leveling surfaces draw these two columns as CHARTS and stat
//! panels rather than as a table, and the AA ledger beside them is a different aggregation again
//! (`shared/aaLedger.ts`, grouped by ability). So the cells here are argued from the MODULE's own
//! vocabulary — an instant, which of the two things happened, and the number that changed — and
//! that is a weaker source of truth than a renderer, which is why it is named here rather than left
//! for somebody to discover when the cutover finds a column missing. What the source is honestly
//! FOR is the thing both surfaces are built on top of and neither exposes: a chronological feed of
//! progress, windowed, which is what a client asking for `progression.recent` means.
//!
//! ── THE INSTANT IS RENDERED, UNLIKE `kills.recent`'s ───────────────────────────────────────────
//!
//! And the difference is what the two lists are about. A recent KILL is read against now ("three
//! minutes ago") so its cell is the instant and the phrasing is the caller's; a level ding is a
//! DATED event you scroll back through, so its cell is the same fixed en-US pattern `loot.ledger`
//! renders — resolved through the parser's own clock, never a host locale (ruling 18 law 1). The
//! comparable instant is the `at` FIELD, which is the field-versus-cell split this layer turns on.

use protocol::cell::Cell;
use protocol::generated::Cells;

use fold::modules::progression::ProgressionModule;

use super::{Field, Order, SourceDef, SourceRow};

/// The registry entry. See [`super::SourceDef`].
pub const RECENT: SourceDef = SourceDef {
    id: "progression.recent",
    fields: &["at", "seq", "kind", "value"],
    default_sort: &[("at", Order::Desc), ("seq", Order::Desc)],
    tiebreak: ("seq", Order::Asc),
    default_limit: super::DEFAULT_LIMIT,
};

/// One entry, before it is a row.
struct Advance {
    ts: i64,
    /// `"level"` or `"aa"`.
    kind: &'static str,
    /// The level reached, or the AA points gained.
    value: i64,
}

/// Build every advance the fold has recorded, in `(kind, fold order)` order.
///
/// THE KEY IS `<kind>:<position>` AND THE TWO COLUMNS ARE KEYED SEPARATELY, which is what keeps a
/// key stable: the two are appended independently, so a single interleaved counter would renumber
/// every AA gain the next time a level landed between two of them, and a diff would say every row
/// changed when nothing did.
#[must_use]
pub fn rows(module: &ProgressionModule, clock: &eqlog::Clock) -> Vec<SourceRow> {
    let mut out: Vec<SourceRow> = Vec::new();
    let mut seq: i64 = 0;
    let levels = module.levels().map(|(ts, value)| Advance {
        ts,
        kind: "level",
        value,
    });
    let aa = module.aa_gains().map(|(ts, value)| Advance {
        ts,
        kind: "aa",
        value,
    });
    for (index, advance) in levels.enumerate() {
        out.push(row(&advance, index, seq, clock));
        seq += 1;
    }
    for (index, advance) in aa.enumerate() {
        out.push(row(&advance, index, seq, clock));
        seq += 1;
    }
    out
}

fn row(advance: &Advance, index: usize, seq: i64, clock: &eqlog::Clock) -> SourceRow {
    let mut cells = std::collections::BTreeMap::new();
    cells.insert(
        "at".to_owned(),
        Cell::text(super::loot::display_time(clock, advance.ts)),
    );
    cells.insert("kind".to_owned(), Cell::text(advance.kind));
    cells.insert("value".to_owned(), Cell::int(advance.value));
    // THE COMPOSED LINE, and it is composed HERE rather than left to the client for the reason the
    // other sources' sentences are NOT: there is no shared derivation for it app-side to disagree
    // with. `+1 AA` and `+3 AA` are the same sentence, which is why the number is beside it too.
    cells.insert(
        "label".to_owned(),
        Cell::text(match advance.kind {
            "level" => format!("Level {}", advance.value),
            _ => format!("+{} AA", advance.value),
        }),
    );
    SourceRow {
        key: format!("{}:{index}", advance.kind),
        cells: Cells(cells),
        fields: vec![
            ("at", Field::Int(advance.ts)),
            ("seq", Field::Int(seq)),
            ("kind", Field::Text(advance.kind.to_owned())),
            ("value", Field::Int(advance.value)),
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::{rows, RECENT};
    use crate::views::{cut, validate};
    use protocol::generated::{ViewDescriptor, ViewFilter};
    use protocol::Cell;

    fn clock() -> eqlog::Clock {
        eqlog::Clock::new(eqlog::Tz::America__Los_Angeles)
    }

    fn folded(lines: &[&str]) -> fold::Fold {
        let mut f = fold::Fold::new(fold::registered(fold::ClusterDeps::default()), i64::MAX);
        for line in lines {
            f.on_primary(
                &fold::event::Event::from_json(line).expect("an event"),
                false,
            );
        }
        f
    }

    const DING: &str = r#"{"kind":"level","seq":0,"ts":1787181707000,"raw":"d","level":52}"#;
    const AA: &str = r#"{"kind":"aaGain","seq":1,"ts":1787181767000,"raw":"a","amount":2}"#;

    fn built(f: &fold::Fold) -> Vec<crate::views::SourceRow> {
        rows(f.registry.progression().expect("the module"), &clock())
    }

    fn view(filter: Option<ViewFilter>) -> crate::views::View {
        validate(&ViewDescriptor {
            source: RECENT.id.to_owned(),
            filter,
            sort: Vec::new(),
            window: None,
        })
        .expect("a view")
    }

    #[test]
    fn both_columns_read_as_one_newest_first_list() {
        let f = folded(&[DING, AA]);
        let rows = built(&f);
        let (window, total) = cut(&view(None), &rows);
        assert_eq!(total, 2);
        // The AA gain is a minute later, so it leads.
        assert_eq!(
            window.iter().map(|r| r.key.0.as_str()).collect::<Vec<_>>(),
            ["aa:0", "level:0"]
        );
        assert_eq!(window[0].cells["label"], Cell::text("+2 AA"));
        assert_eq!(window[1].cells["label"], Cell::text("Level 52"));
        // The instant is DRAWN, and the comparable one is the field underneath it.
        assert_eq!(window[1].cells["at"], Cell::text("Aug 19, 04:21 PM"));
    }

    #[test]
    fn one_kind_can_be_asked_for_on_its_own() {
        let f = folded(&[DING, AA]);
        let rows = built(&f);
        let filtered = view(Some(ViewFilter(std::collections::BTreeMap::from([(
            "kind".to_owned(),
            Cell::text("level"),
        )]))));
        let (window, total) = cut(&filtered, &rows);
        assert_eq!(total, 1);
        assert_eq!(window[0].cells["value"], Cell::int(52));
    }

    #[test]
    fn the_two_columns_are_keyed_separately_so_a_key_survives_an_interleaving() {
        // A LEVEL LANDING BETWEEN TWO AA GAINS MUST NOT RENUMBER THEM. One interleaved counter
        // would, and a diff would then report every row changed when nothing did.
        let f = folded(&[AA, DING]);
        let rows = built(&f);
        let keys: Vec<&str> = rows.iter().map(|r| r.key.as_str()).collect();
        assert_eq!(keys, ["level:0", "aa:0"]);
    }
}
