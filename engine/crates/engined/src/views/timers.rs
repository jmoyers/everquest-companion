//! `timers.rows` — THE TWO FLOATING TIMER WINDOWS, served (JOS-487).
//!
//! One source for both of them, exactly as there is one projection for both of them over there: the
//! owner asked for two windows he can place and enable separately, NOT for two models. Which window
//! a row belongs to is a CELL and a FIELD (`surface`), so a subscription filters
//! `{"surface":"debuffs"}` and gets the debuffs window's rows, filtered, sorted and windowed.
//!
//! The rows themselves come from `fold::modules::buff_timer_rows` — the port of
//! `src/shared/buffTimers.ts` — which folds `buffs.active` together with `buffTimers.holds`/`.ends`.
//! Everything below is the CELL layer over it.
//!
//! ── THE TWO ORDERS ARE BOTH FIELDS, AND THAT IS THE WHOLE TRICK ────────────────────────────────
//!
//! The renderer draws these rows in one of two orders and NEITHER is a sort by a column. The
//! grouped order is "self rows first, then one block per target, blocks ordered by their soonest
//! row"; the flat order is `compareRows` over everything, which ranks countdowns ahead of count-ups
//! ahead of permanents before it compares any instant. A view layer that sorts by named fields
//! cannot express either — so the source PUBLISHES BOTH as integer fields (`order`, `flat`), each
//! the row's index in that order, computed once per serve pass by the projection that owns the
//! rule. The client names the order it wants and never re-sorts, which is ruling 4 kept rather than
//! bent: the decision stayed engine-side, and what crossed the wire is its answer.
//!
//! Both are UNIQUE within the view, so either makes the sort total on its own; `order` is the
//! tiebreak because it is the projection's own.
//!
//! ── THE CLOCK IS THE RENDERER'S, AND THAT IS NOT A HOLE IN RULING 4 ────────────────────────────
//!
//! There is no `remaining` cell and there is not going to be one. A countdown row reads a different
//! number every frame; serving it as text would mean a diff for every visible row at the serve
//! cadence — a frame storm for a window of eight bars — and it would STILL be stale between two
//! frames, so the renderer would have to compute it anyway. What crosses is `startedTs`,
//! `durationMs` and `mode`: the three numbers `timerReading` is a pure function of, which is exactly
//! what the overlay already ticks against at 1 Hz. Reading a stored instant against the current one
//! is not domain work — it is the same class as `FoldProgress.pct` leaving its rounding to whoever
//! draws the bar — and the rule ruling 4 states is that the renderer never FILTERS, SORTS or
//! AGGREGATES the world, all three of which happened above this line.
//!
//! `endsAt` IS SERVED THOUGH, and it is the one derived instant that belongs here: it is a fact
//! about the row rather than about now (`startedTs + durationMs`), it is what the early-warning
//! offset is computed from, and it is the field a client sorts by when it wants "what breaks next"
//! without knowing this file's ranking rules.

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
    // THE PROJECTION'S OWN ORDER — self rows, then target blocks. A descriptor that states nothing
    // gets what the buffs window opens on.
    default_sort: &[("order", Order::Asc)],
    tiebreak: ("order", Order::Asc),
    // SMALLER THAN THE HOUSE DEFAULT, and the number is the surface's rather than a guess: these
    // are floating windows over a running game and nobody has fifty buffs. A client that wants more
    // asks for more, up to `MAX_LIMIT`.
    default_limit: 100,
};

/// Build every timer row, in the projection's grouped order.
///
/// THE KEY IS THE PROJECTION'S OWN `id` — `self|self|clarity`, `cc|a sand giant|mesmerization` —
/// which is already built to be stable across ticks so that keys and selectors do not churn. That
/// is exactly what a diff needs, and inventing a second identity here would be a second thing that
/// can disagree about whether two frames describe the same bar.
#[must_use]
pub fn rows(buffs: &BuffsModule, timers: &BuffTimersModule) -> Vec<SourceRow> {
    let active = buffs.active_buffs();
    let holds = timers.holds();
    let built = build_timer_rows(&active, &holds, timers.ends());

    // The FLAT order, as a lookup from row id to position. Computed once for the whole source
    // rather than per row: the flat order is a sort of the same rows, so it costs one more sort of
    // a list that is already in memory.
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
    // THE RANK CHIP, not the raw cast name. `castName` is only ever shown as the DIFFERENCE between
    // the two spellings — `rowRankLabel`'s two refusals decide whether there is one — so serving the
    // whole string would hand the client a decision it would then have to make with a function it
    // does not have.
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

/// What a descriptor may name. `candidates` IS ABSENT FROM BOTH SETS, and that is a decision rather
/// than an omission: a `Cell` is a scalar, so a list of candidate spells cannot be one — and it does
/// not need to be, because the row's `name` is already those names joined the way the bar draws
/// them (`Mesmerize / Mesmerization`) and `ambiguous` is the flag the `~` chip reads. The
/// per-candidate list is what the ALLOW-LIST filter asks about, and that filter is a window
/// preference applied to a window's own rows rather than a query.
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

    /// A fold with the twenty modules registered, fed hand-written events. `launch_ms` is
    /// `i64::MAX` so the rebirth boundary never fires — `views::loot`'s own trick.
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
    /// target, which is the ONE shape JOS-118 admits.
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
        // TWO ORDERS OVER ONE ROW SET, which is the whole reason both are fields. Whether the fold
        // opened instances for these landings is not this test's subject — what it pins is that the
        // source cuts windows in the order the descriptor names, and that both names resolve.
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
        // Both orders are TOTAL — every key appears exactly once in each.
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
        // `candidates` is the trap worth pinning: it is a real property of a row and deliberately
        // neither a cell nor a field, because a `Cell` is a scalar. Saying so is the answer.
        let mut d = descriptor(Vec::new(), None);
        d.sort = vec![SortTerm(["candidates".to_owned(), "asc".to_owned()])];
        let error = validate(&d).err().expect("a refusal");
        assert!(error.message.contains("candidates"), "{}", error.message);
        assert!(error.message.contains("endsAt"), "{}", error.message);
    }
}
