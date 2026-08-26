//! `buffs.active` — THE BUFFS TAB'S LIST (JOS-487).
//!
//! The other reader of the buff model, and deliberately a SECOND source rather than a filter over
//! [`super::timers`]: the tab and the bars draw different things from the same instances. The bars
//! draw a clock; the tab draws what the MODEL KNOWS about a buff — the estimator's number, the
//! quartiles behind it, how many observations there are and where the number came from — which is
//! why `ActiveBuff` carries `estimatedMs`/`durationSource` beside `overlayDurationMs`, and why
//! `BuffTimerRow` deliberately carries no `source` at all (JOS-379). Folding them into one source
//! would mean serving every reader the union.
//!
//! ── WHAT A CELL IS HERE ────────────────────────────────────────────────────────────────────────
//!
//! The row's own fields, as numbers and as the enum words the model spells them with. It is the
//! `ConCardChip` decision applied one surface over, and for its reason: the sentences a buff row
//! prints (`~4m 30s`, `n=12`, `at least`) are built by derivations the tab, the bars and the
//! hover card all read, so a wire carrying finished strings would be a second copy of a vocabulary
//! that must not drift. What the engine owes — and what it does above this line — is which rows,
//! in which order, windowed.
//!
//! `candidates` is not a cell for the reason [`super::timers`] gives at length: a `Cell` is a
//! scalar. `ambiguous` is the flag the `~` chip reads and `spell` is already the joined family.

use protocol::cell::Cell;
use protocol::generated::Cells;

use fold::modules::buffs::BuffsModule;
use fold::modules::buffs_view::ActiveBuff;

use super::{Field, Order, SourceDef, SourceRow};

/// The registry entry. See [`super::SourceDef`].
pub const ACTIVE: SourceDef = SourceDef {
    id: "buffs.active",
    fields: &[
        "key",
        "spell",
        "cls",
        "self",
        "target",
        "startedTs",
        "n",
        "permanent",
        "caster",
    ],
    // OLDEST FIRST, which is the order the module publishes them in and the order the tab lists
    // them: a buff you have had running all night sits above the one you just cast.
    default_sort: &[("startedTs", Order::Asc)],
    tiebreak: ("key", Order::Asc),
    default_limit: 100,
};

/// Build a row per live instance.
///
/// THE KEY IS THE MODEL'S OWN INSTANCE KEY — `<spellKey>|<entityKey>` — handed over by
/// `BuffsModule::active_instances` rather than rebuilt from the projected fields. See that method.
#[must_use]
pub fn rows(module: &BuffsModule) -> Vec<SourceRow> {
    module
        .active_instances()
        .into_iter()
        .map(|(key, b)| SourceRow {
            cells: cells(&b),
            fields: vec![
                ("key", Field::Text(key.clone())),
                ("spell", Field::Text(b.spell.clone())),
                ("cls", Field::Text(word(&b.cls))),
                // A BOOLEAN IS NOT A `Field`, so `self` is filtered as the word the cell carries.
                // The alternative — a numeric 0/1 — would make `{"self":true}` a refusal and
                // `{"self":1}` a query nobody would guess.
                ("self", Field::Text(yes_no(b.is_self))),
                ("target", text_or_missing(b.target.as_deref())),
                ("startedTs", Field::Int(b.started_ts)),
                ("n", Field::Int(b.n)),
                ("permanent", Field::Text(yes_no(b.permanent == Some(true)))),
                ("caster", text_or_missing(b.caster.as_deref())),
            ],
            key,
        })
        .collect()
}

fn cells(b: &ActiveBuff) -> Cells {
    let mut cells = std::collections::BTreeMap::new();
    cells.insert("spell".to_owned(), Cell::text(&b.spell));
    cells.insert("castName".to_owned(), optional(b.cast_name.as_deref()));
    cells.insert("cls".to_owned(), Cell::text(word(&b.cls)));
    cells.insert("self".to_owned(), Cell::flag(b.is_self));
    cells.insert(
        "disposition".to_owned(),
        b.disposition
            .as_ref()
            .map_or_else(Cell::null, |d| Cell::text(word(d))),
    );
    cells.insert("target".to_owned(), optional(b.target.as_deref()));
    cells.insert(
        "inferredTarget".to_owned(),
        Cell::flag(b.inferred_target == Some(true)),
    );
    cells.insert("startedTs".to_owned(), Cell::int(b.started_ts));
    cells.insert(
        "estimatedMs".to_owned(),
        b.estimated_ms.map_or_else(Cell::null, Cell::int),
    );
    cells.insert("p25".to_owned(), b.p25.map_or_else(Cell::null, Cell::float));
    cells.insert("p75".to_owned(), b.p75.map_or_else(Cell::null, Cell::float));
    cells.insert("n".to_owned(), Cell::int(b.n));
    cells.insert(
        "durationSource".to_owned(),
        b.duration_source
            .as_ref()
            .map_or_else(Cell::null, |s| Cell::text(word(s))),
    );
    cells.insert(
        "permanent".to_owned(),
        Cell::flag(b.permanent == Some(true)),
    );
    cells.insert("permanentSource".to_owned(), optional(b.permanent_source));
    cells.insert(
        "messageDriven".to_owned(),
        Cell::flag(b.message_driven == Some(true)),
    );
    cells.insert("ambiguous".to_owned(), Cell::flag(b.candidates.is_some()));
    cells.insert(
        "count".to_owned(),
        b.count.map_or_else(Cell::null, Cell::int),
    );
    cells.insert("caster".to_owned(), optional(b.caster.as_deref()));
    cells.insert(
        "calmsTarget".to_owned(),
        Cell::flag(b.calms_target == Some(true)),
    );
    Cells(cells)
}

/// One of the model's own enum words, read through the SAME serde spelling the module publishes.
///
/// Not a hand-written match: the wire word for `deathBound` is decided by a `rename_all` attribute
/// in `buffs_shapes.rs`, and a second spelling here would be a place for the two to part company
/// the next time a variant is added.
pub(super) fn word<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}

/// A boolean as a queryable word — see the `self` field above.
pub(super) fn yes_no(value: bool) -> String {
    if value { "true" } else { "false" }.to_owned()
}

fn optional(value: Option<&str>) -> Cell {
    value.map_or_else(Cell::null, Cell::text)
}

fn text_or_missing(value: Option<&str>) -> Field {
    value.map_or(Field::Missing, |v| Field::Text(v.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::{word, yes_no, ACTIVE};
    use crate::views::validate;
    use protocol::generated::{SortTerm, ViewDescriptor};

    #[test]
    fn the_enum_words_are_the_models_own_spelling() {
        use fold::modules::buffs_shapes::{BuffClass, Disposition, EstimatorSource};
        assert_eq!(word(&BuffClass::Debuff), "debuff");
        // The two that a hand-written match would most easily get wrong.
        assert_eq!(word(&EstimatorSource::DeathBound), "deathBound");
        assert_eq!(word(&Disposition::Zelf), "self");
        assert_eq!(yes_no(true), "true");
    }

    #[test]
    fn the_source_is_registered_and_its_terms_resolve() {
        let view = validate(&ViewDescriptor {
            source: ACTIVE.id.to_owned(),
            filter: None,
            sort: vec![SortTerm(["spell".to_owned(), "asc".to_owned()])],
            window: None,
        })
        .expect("a view");
        assert_eq!(view.sort.last(), Some(&ACTIVE.tiebreak));
    }
}
