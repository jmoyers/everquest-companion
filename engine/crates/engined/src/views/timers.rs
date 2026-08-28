//! `timers.rows` — one source for both floating timer windows, as there is one projection for both:
//! two windows placed and enabled separately, not two models. Which window a row belongs to is the
//! `surface` cell and field, so a subscription filters `{"surface":"debuffs"}` for that window's
//! rows.
//!
//! The rows come from `fold::modules::buff_timer_rows`; everything here is the cell layer over it.
//!
//! The renderer draws these rows in one of two orders and neither is a sort by a column — the
//! grouped order blocks by target, the flat order ranks countdowns ahead of count-ups ahead of
//! permanents before comparing any instant. So the source publishes both as integer fields (`order`,
//! `flat`), each the row's index in that order, computed once per serve pass by the projection that
//! owns the rule. Both are unique within the view, so either makes the sort total on its own;
//! `order` is the tiebreak because it is the projection's.
//!
//! There is no `remaining` cell. A countdown reads a different number every frame, so serving it as
//! text would mean a diff per visible row per serve beat and would still be stale between two
//! frames. What crosses is `startedTs`, `durationMs` and `mode` — the three numbers the reading is a
//! pure function of, and what the overlay already ticks against.
//!
//! `endsAt` is served: it is a fact about the row (`startedTs + durationMs`) rather than about now,
//! it is what the early-warning offset is computed from, and it is what a client sorts by for "what
//! breaks next" without knowing this file's ranking rules.

use protocol::cell::Cell;
use protocol::generated::Cells;

use fold::modules::buff_timer_rows::{
    build_timer_rows, order_timer_rows, row_rank_label, timer_ends_at, timer_row_surface,
    BuffTimerRow,
};
use fold::modules::buff_timers::BuffTimersModule;
use fold::modules::buffs::BuffsModule;

use super::{Field, Order, SourceDef, SourceRow};

/// The registry entry. See [`super::SourceDef`].
pub const ROWS: SourceDef = SourceDef {
    id: "timers.rows",
    fields: &[
        "order",
        "flat",
        "surface",
        "kind",
        "group",
        "mode",
        "name",
        "target",
        "targetKey",
        "startedTs",
        "endsAt",
        "caster",
    ],
    // The projection's own order — self rows, then target blocks.
    default_sort: &[("order", Order::Asc)],
    tiebreak: ("order", Order::Asc),
    // The surface's own number rather than the house default: these are floating windows over a
    // running game and nobody has fifty buffs. A client that wants more asks, up to `MAX_LIMIT`.
    default_limit: 100,
};

/// Build every timer row, in the projection's grouped order.
///
/// The key is the projection's own `id` (`self|self|clarity`), already built to be stable across
/// ticks. Inventing a second identity here would be a second thing that can disagree about whether
/// two frames describe the same bar.
#[must_use]
pub fn rows(buffs: &BuffsModule, timers: &BuffTimersModule) -> Vec<SourceRow> {
    let active = buffs.active_buffs();
    let holds = timers.holds();
    let built = build_timer_rows(&active, &holds, timers.ends());

    // The flat order as a lookup from row id to position, computed once for the whole source: it is
    // one more sort of a list already in memory.
    let flat: std::collections::HashMap<String, i64> = order_timer_rows(&built, false)
        .iter()
        .enumerate()
        .map(|(i, r)| (r.id.clone(), i64::try_from(i).unwrap_or(i64::MAX)))
        .collect();

    built
        .iter()
        .enumerate()
        .map(|(index, row)| {
            let order = i64::try_from(index).unwrap_or(i64::MAX);
            let flat_at = flat.get(&row.id).copied().unwrap_or(order);
            SourceRow {
                key: row.id.clone(),
                cells: cells(row, order, flat_at),
                fields: fields(row, order, flat_at),
            }
        })
        .collect()
}

/// What the bar draws.
fn cells(row: &BuffTimerRow, order: i64, flat: i64) -> Cells {
    let mut cells = std::collections::BTreeMap::new();
    cells.insert("name".to_owned(), Cell::text(&row.name));
    // The rank chip, not the raw cast name: `castName` is only ever shown as the difference between
    // the two spellings, and `row_rank_label` is the function that decides whether there is one.
    cells.insert(
        "rank".to_owned(),
        row_rank_label(&row.name, row.cast_name.as_deref()).map_or_else(Cell::null, Cell::text),
    );
    cells.insert("kind".to_owned(), Cell::text(row.kind.as_str()));
    cells.insert(
        "surface".to_owned(),
        Cell::text(timer_row_surface(row).as_str()),
    );
    cells.insert("group".to_owned(), Cell::text(row.group.as_str()));
    cells.insert("mode".to_owned(), Cell::text(row.mode.as_str()));
    cells.insert("ambiguous".to_owned(), Cell::flag(row.ambiguous));
    cells.insert("calmsTarget".to_owned(), Cell::flag(row.calms_target));
    cells.insert("inferredTarget".to_owned(), Cell::flag(row.inferred_target));
    cells.insert("startedTs".to_owned(), Cell::int(row.started_ts));
    cells.insert(
        "durationMs".to_owned(),
        row.duration_ms.map_or_else(Cell::null, Cell::int),
    );
    cells.insert(
        "endsAt".to_owned(),
        timer_ends_at(row).map_or_else(Cell::null, Cell::int),
    );
    cells.insert("target".to_owned(), optional(row.target.as_deref()));
    cells.insert("targetKey".to_owned(), optional(row.target_key.as_deref()));
    cells.insert(
        "count".to_owned(),
        row.count.map_or_else(Cell::null, Cell::int),
    );
    cells.insert("caster".to_owned(), optional(row.caster.as_deref()));
    cells.insert("order".to_owned(), Cell::int(order));
    cells.insert("flat".to_owned(), Cell::int(flat));
    Cells(cells)
}

/// What a descriptor may name. `candidates` is absent from both the cells and the fields by
/// decision: a `Cell` is a scalar, and the row's `name` is already those names joined the way the
/// bar draws them while `ambiguous` is the flag the `~` chip reads. The per-candidate list is what
/// the allow-list filter asks about, and that is a window preference rather than a query.
fn fields(row: &BuffTimerRow, order: i64, flat: i64) -> Vec<(&'static str, Field)> {
    vec![
        ("order", Field::Int(order)),
        ("flat", Field::Int(flat)),
        (
            "surface",
            Field::Text(timer_row_surface(row).as_str().to_owned()),
        ),
        ("kind", Field::Text(row.kind.as_str().to_owned())),
        ("group", Field::Text(row.group.as_str().to_owned())),
        ("mode", Field::Text(row.mode.as_str().to_owned())),
        ("name", Field::Text(row.name.clone())),
        ("target", text_or_missing(row.target.as_deref())),
        ("targetKey", text_or_missing(row.target_key.as_deref())),
        ("startedTs", Field::Int(row.started_ts)),
        (
            "endsAt",
            timer_ends_at(row).map_or(Field::Missing, Field::Int),
        ),
        ("caster", text_or_missing(row.caster.as_deref())),
    ]
}

fn optional(value: Option<&str>) -> Cell {
    value.map_or_else(Cell::null, Cell::text)
}

fn text_or_missing(value: Option<&str>) -> Field {
    value.map_or(Field::Missing, |v| Field::Text(v.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::{rows, ROWS};
    use crate::views::{cut, validate};
    use protocol::generated::{SortTerm, ViewDescriptor, ViewFilter};
    use protocol::Cell;

    /// A fold fed hand-written events. `launch_ms` is `i64::MAX` so the rebirth boundary never
    /// fires.
    fn folded(lines: &[&str]) -> fold::Fold {
        let mut f = fold::Fold::new(fold::registered(fold::ClusterDeps::default()), i64::MAX);
        for line in lines {
            f.on_primary(
                &fold::event::Event::from_json(line).expect("an event"),
                true,
            );
        }
        f
    }

    fn built(f: &fold::Fold) -> Vec<crate::views::SourceRow> {
        rows(
            f.registry.buffs().expect("the buffs module"),
            f.registry.buff_timers().expect("the buffTimers module"),
        )
    }

    fn descriptor(sort: Vec<SortTerm>, filter: Option<ViewFilter>) -> ViewDescriptor {
        ViewDescriptor {
            source: ROWS.id.to_owned(),
            filter,
            sort,
            window: None,
        }
    }

    /// A landing the model can open an instance from: a `buffLanded` naming the spell and the
    /// target, which is the one shape the model admits.
    fn landing(seq: i64, ts: i64, spell: &str, target: Option<&str>) -> String {
        match target {
            None => format!(
                r#"{{"kind":"buffLanded","seq":{seq},"ts":{ts},"raw":"l","spell":"{spell}","self":true}}"#
            ),
            Some(t) => format!(
                r#"{{"kind":"buffLanded","seq":{seq},"ts":{ts},"raw":"l","spell":"{spell}","target":"{t}"}}"#
            ),
        }
    }

    #[test]
    fn the_source_serves_the_projections_order_and_names_the_flat_one_beside_it() {
        // Two orders over one row set: what this pins is that the source cuts windows in the order
        // the descriptor names and that both names resolve.
        let f = folded(&[&landing(0, 1_000, "Clarity", None)]);
        let source = built(&f);

        let grouped = validate(&descriptor(Vec::new(), None)).expect("a view");
        let flat = validate(&descriptor(
            vec![SortTerm(["flat".to_owned(), "asc".to_owned()])],
            None,
        ))
        .expect("a view");
        let (a, total_a) = cut(&grouped, &source);
        let (b, total_b) = cut(&flat, &source);
        assert_eq!(total_a, total_b, "the same rows, two orders");
        assert_eq!(a.len(), b.len());
        // Both orders are total — every key appears exactly once in each.
        let keys = |w: &[protocol::generated::Row]| {
            let mut k: Vec<String> = w.iter().map(|r| r.key.0.clone()).collect();
            k.sort();
            k
        };
        assert_eq!(keys(&a), keys(&b));
    }

    #[test]
    fn the_surface_is_a_field_so_one_window_asks_for_its_own_rows() {
        let f = folded(&[&landing(0, 1_000, "Clarity", None)]);
        let source = built(&f);
        for surface in ["buffs", "debuffs"] {
            let view = validate(&descriptor(
                Vec::new(),
                Some(ViewFilter(std::collections::BTreeMap::from([(
                    "surface".to_owned(),
                    Cell::text(surface),
                )]))),
            ))
            .expect("a view");
            let (window, total) = cut(&view, &source);
            assert_eq!(window.len(), usize::try_from(total).unwrap());
            for row in &window {
                assert_eq!(row.cells["surface"], Cell::text(surface));
            }
        }
        // …and the two partitions add up to the whole source, which is what makes it one model
        // rather than two.
        let all = validate(&descriptor(Vec::new(), None)).expect("a view");
        let (_, whole) = cut(&all, &source);
        let count = |s: &str| {
            let v = validate(&descriptor(
                Vec::new(),
                Some(ViewFilter(std::collections::BTreeMap::from([(
                    "surface".to_owned(),
                    Cell::text(s),
                )]))),
            ))
            .expect("a view");
            cut(&v, &source).1
        };
        assert_eq!(count("buffs") + count("debuffs"), whole);
    }

    #[test]
    fn a_field_the_source_does_not_carry_is_refused_by_name() {
        // `candidates` is a real property of a row and deliberately neither a cell nor a field,
        // because a `Cell` is a scalar.
        let mut d = descriptor(Vec::new(), None);
        d.sort = vec![SortTerm(["candidates".to_owned(), "asc".to_owned()])];
        let error = validate(&d).err().expect("a refusal");
        assert!(error.message.contains("candidates"), "{}", error.message);
        assert!(error.message.contains("endsAt"), "{}", error.message);
    }
}
