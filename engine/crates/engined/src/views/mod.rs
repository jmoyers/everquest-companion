//! The view layer: a source registry, descriptor validation, and the window one subscription is
//! served from.
//!
//! The subscription diff protocol, as held here:
//! 1. Reset-then-diffs. A subscription whose window state is `None` is owed a reset, and nothing
//!    else may be sent to it.
//! 2. Coalescing at a cadence, not a push per event — see [`SERVE_EVERY`].
//! 3. Every message carries the epoch; the stamp happens inside `world.rs`'s critical section,
//!    which is why the serving loop lives there and not here.
//! 4. Rows are render-ready. This module owns the query — filter, sort, window — and each source
//!    owns what a row of it looks like.
//!
//! A query field and a cell are different values even under the same name: the cell is what the
//! pixel says (`"Aug 19, 04:21 PM"`), the field is the comparable value underneath it. Sources
//! declare both and the two are looked up separately; a field with no cell, or a cell with no
//! field, is intended.
//!
//! Two things cross as numbers rather than as their wording: a value read against now
//! (`startedTs`, `durationMs`, `mode`), because text would be stale between two frames and the
//! renderer would recompute it anyway; and a value whose phrasing is a derivation several surfaces
//! share, so the wire carries no second copy of that vocabulary. A `Cell` is a scalar, and nothing
//! is stringified into one for a client to parse back out.
//!
//! Every sort ends in its source's [`SourceDef::tiebreak`] so the order is total. EQ log timestamps
//! are second-resolution, so ties are the common case rather than the corner, and a window whose
//! order is not total shuffles between services — reorder churn for a list nobody changed.
//!
//! A subscription is serviced only when its source's revision moved or when it is owed a reset, so
//! an idle session pays nothing; building a source's rows and cutting a window are each O(the whole
//! source), and [`meter`] measures what that costs.

pub mod buffs;
pub mod combat;
pub mod diff;
pub mod event_feed;
pub mod kills;
pub mod loot;
pub mod meter;
pub mod progression;
pub mod respawn;
pub mod timers;

use std::time::Duration;

use protocol::cell::Cell;
use protocol::generated::{Cells, ErrorCode, Row, RowKey, ViewDescriptor};

pub use diff::diff;
pub use meter::{
    FrameKind, Meter, Moment, SourceMeter, Timeline, TIMELINE_CADENCE, TIMELINE_CAPACITY,
};

/// The floor between two services of the same subscription — rule 2's ~10 Hz ceiling.
///
/// A ceiling on frame rate, not a promise of one: nothing is sent when nothing moved. Stated as a
/// duration because an events-based rule would fire a hundred times a second on a raid slice and
/// never on a quiet one.
pub const SERVE_EVERY: Duration = Duration::from_millis(100);

/// The window a source hands back when the descriptor states none. An absent window means the
/// engine's default for that source and never `everything`, which is how a payload budget gets
/// blown.
pub const DEFAULT_LIMIT: i64 = 50;

/// The largest window this engine will cut, whoever asks.
///
/// A client-chosen number is untrusted even from a renderer we wrote: a typo'd `limit` of
/// 10_000_000 would allocate ten million rows on the ingest thread, the one the fold runs on.
pub const MAX_LIMIT: i64 = 1_000;

/// Which way a sort term runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Order {
    /// Smallest first; a missing value first.
    Asc,
    /// Largest first; a missing value last.
    Desc,
}

impl Order {
    /// The wire spelling — the second element of a `SortTerm`.
    fn parse(word: &str) -> Option<Self> {
        match word {
            "asc" => Some(Self::Asc),
            "desc" => Some(Self::Desc),
            _ => None,
        }
    }
}

/// One comparable value of a row — what a `sort` or `filter` term names.
///
/// Deliberately not `Cell`: a cell is display text and this is the value underneath it. `Missing`
/// is a value rather than an absence so ordering stays total over a sometimes-empty column.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Field {
    /// A whole number: an instant in epoch millis, a count, an index.
    Int(i64),
    /// Text, compared by code point and never by locale: a host collation in the serve path is a
    /// host-dependent answer, and determinism is cacheability. The consequence is stated rather
    /// than hidden — an accented name sorts differently here than the app's `localeCompare` sorts
    /// it.
    Text(String),
    /// The row has no value for this field.
    Missing,
}

impl Field {
    /// Total order over one column: `Missing` first, then numbers, then text.
    ///
    /// The cross-type arms cannot happen for a well-formed source and are ordered rather than
    /// panicking, because a serve path is not a place to raise.
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        use std::cmp::Ordering;
        match (self, other) {
            (Self::Missing, Self::Missing) => Ordering::Equal,
            (Self::Missing, _) => Ordering::Less,
            (_, Self::Missing) => Ordering::Greater,
            (Self::Int(a), Self::Int(b)) => a.cmp(b),
            (Self::Text(a), Self::Text(b)) => a.cmp(b),
            (Self::Int(_), Self::Text(_)) => Ordering::Less,
            (Self::Text(_), Self::Int(_)) => Ordering::Greater,
        }
    }

    /// Does this field equal the value a filter named? A filter is a `Cell` on the wire, so the
    /// comparison crosses the two vocabularies here, once.
    fn matches(&self, wanted: &Cell) -> bool {
        match (self, wanted.as_json()) {
            (Self::Missing, serde_json::Value::Null) => true,
            (Self::Text(text), serde_json::Value::String(s)) => text == s,
            (Self::Int(n), serde_json::Value::Number(number)) => number.as_i64() == Some(*n),
            _ => false,
        }
    }
}

/// One row of a source before any window is cut: its identity, what it renders as, and what it can
/// be queried by.
pub struct SourceRow {
    /// Stable identity within the view — `loot:9413`. The key lives outside the cells so a reset
    /// row and a diff update apply the same way.
    pub key: String,
    /// The render-ready cells, exactly as the client will draw them.
    pub cells: Cells,
    /// The comparable values a descriptor may name. Small enough that a linear lookup beats a map.
    pub fields: Vec<(&'static str, Field)>,
}

impl SourceRow {
    fn field(&self, name: &str) -> &Field {
        self.fields
            .iter()
            .find(|(id, _)| *id == name)
            .map_or(&Field::Missing, |(_, value)| value)
    }

    fn row(&self) -> Row {
        Row {
            key: RowKey(self.key.clone()),
            cells: self.cells.clone(),
        }
    }
}

/// What a source is to the registry: a name, the fields it can be queried by, the order it takes
/// when nobody states one, and the tiebreak that makes every order total.
pub struct SourceDef {
    /// The name a descriptor asks for. Not a module id — `loot.ledger` is a view over the `loot`
    /// module, filtered, sorted and windowed, and `module.snapshot` refuses this name.
    pub id: &'static str,
    /// Every field a `sort` or `filter` term may name. A term naming anything else is `badParams`:
    /// ignoring it silently would hand a client a window it cannot tell apart from the one it
    /// asked for.
    pub fields: &'static [&'static str],
    /// The order a descriptor with no `sort` gets.
    pub default_sort: &'static [(&'static str, Order)],
    /// Appended to every sort, so the order is total. The field named here must be unique within
    /// the source.
    pub tiebreak: (&'static str, Order),
    /// The window a descriptor with no `window` gets, at offset 0.
    pub default_limit: i64,
}

/// Every source this build serves. An unknown source is `notFound`, which is only answerable
/// because there is a list to be absent from.
///
/// Two kinds. `loot.ledger`, `kills.recent`, `progression.recent` and `eventFeed.recent` append: a
/// row, once written, never changes, so a live window over one produces inserts and drops and never
/// an `update`. `combat.live`, `timers.rows`, `buffs.active` and `respawn.watches` edit — the same
/// keys sit in the window while their numbers move.
pub const SOURCES: &[SourceDef] = &[
    loot::LEDGER,
    combat::LIVE,
    buffs::ACTIVE,
    timers::ROWS,
    respawn::WATCHES,
    kills::RECENT,
    progression::RECENT,
    event_feed::RECENT,
];

/// The source by that name, or `None`.
#[must_use]
pub fn source(id: &str) -> Option<&'static SourceDef> {
    SOURCES.iter().find(|s| s.id == id)
}

/// A validated descriptor — the whole query, with every name resolved against a real source.
///
/// Nothing downstream re-checks anything: if one of these exists, its source is registered, its
/// terms name real fields, and its window is inside the budget.
pub struct View {
    /// The source it reads.
    pub source: &'static SourceDef,
    /// Field-name to value, ANDed.
    pub filter: Vec<(&'static str, Cell)>,
    /// The sort terms, defaulted if the descriptor stated none, with the tiebreak appended.
    pub sort: Vec<(&'static str, Order)>,
    /// How many rows to skip.
    pub offset: usize,
    /// How many rows to take.
    pub limit: usize,
}

/// Why a descriptor was refused, in the protocol's own terms.
#[derive(Debug)]
pub struct ViewError {
    /// The code the client branches on.
    pub code: ErrorCode,
    /// The sentence a bug report carries.
    pub message: String,
}

impl ViewError {
    fn not_found(source: &str) -> Self {
        Self {
            code: ErrorCode::NotFound,
            message: format!(
                "this engine serves no view source named {source:?}; it serves {}",
                SOURCES.iter().map(|s| s.id).collect::<Vec<_>>().join(", ")
            ),
        }
    }

    fn bad(message: String) -> Self {
        Self {
            code: ErrorCode::BadParams,
            message,
        }
    }
}

/// Resolve one descriptor against the registry.
///
/// Every refusal is by name: which term was wrong and, where it helps, what the source does carry.
/// The alternative is a client that gets a window it did not ask for and no way to notice.
///
/// # Errors
/// [`ViewError::not_found`] for an unregistered source; `badParams` for everything else.
pub fn validate(descriptor: &ViewDescriptor) -> Result<View, ViewError> {
    let source =
        source(&descriptor.source).ok_or_else(|| ViewError::not_found(&descriptor.source))?;

    let field_of =
        |name: &str| -> Option<&'static str> { source.fields.iter().copied().find(|f| *f == name) };
    let known = || source.fields.join(", ");

    let mut filter = Vec::new();
    for (name, value) in descriptor.filter.iter().flat_map(|f| f.iter()) {
        let field = field_of(name).ok_or_else(|| {
            ViewError::bad(format!(
                "{} carries no field named {name:?} to filter on; it carries {}",
                source.id,
                known()
            ))
        })?;
        filter.push((field, value.clone()));
    }

    let mut sort: Vec<(&'static str, Order)> = Vec::new();
    for term in &descriptor.sort {
        let [name, direction] = &**term;
        let field = field_of(name).ok_or_else(|| {
            ViewError::bad(format!(
                "{} carries no field named {name:?} to sort by; it carries {}",
                source.id,
                known()
            ))
        })?;
        let order = Order::parse(direction).ok_or_else(|| {
            ViewError::bad(format!(
                "a sort direction is \"asc\" or \"desc\", never {direction:?}"
            ))
        })?;
        sort.push((field, order));
    }
    if sort.is_empty() {
        sort.extend_from_slice(source.default_sort);
    }
    // Appended to every sort, the client's own included: an order that is not total is a window
    // that shuffles, and a shuffled window is diff churn.
    sort.push(source.tiebreak);

    let (offset, limit) = match &descriptor.window {
        None => (0, source.default_limit),
        Some(window) => (window.offset, window.limit),
    };
    if offset < 0 {
        return Err(ViewError::bad(format!(
            "a window offset counts rows from the start of the view and cannot be {offset}"
        )));
    }
    if limit <= 0 {
        return Err(ViewError::bad(format!(
            "a window limit is how many rows to send and cannot be {limit}"
        )));
    }
    if limit > MAX_LIMIT {
        return Err(ViewError::bad(format!(
            "a window of {limit} rows is over this engine's budget of {MAX_LIMIT}"
        )));
    }

    Ok(View {
        source,
        filter,
        sort,
        offset: usize::try_from(offset).unwrap_or(usize::MAX),
        limit: usize::try_from(limit).unwrap_or(0),
    })
}

/// One source's rows, built once and cut for every subscription that reads it.
pub struct Prepared {
    /// Which source these are.
    pub source: &'static str,
    /// The change signal they were built at.
    pub revision: u64,
    /// Every row of the source, in its natural order.
    pub rows: Vec<SourceRow>,
}

/// Where the rows come from — implemented over the ingest thread's fold.
pub trait Rows {
    /// Every row of one source, in its natural order, or `None` when this fold carries no such
    /// source. `None` is not an error: a counting sink folds no modules at all, and a subscription
    /// over a source it cannot serve gets an empty window rather than a refusal it can do nothing
    /// about.
    fn rows(&self, source: &'static SourceDef) -> Option<Vec<SourceRow>>;

    /// The source's change signal — a number that moves whenever the source could have changed.
    /// `None` for a source this fold does not carry.
    fn revision(&self, source: &'static SourceDef) -> Option<u64>;
}

/// A fold that serves no view at all: every window is empty, every revision is zero.
///
/// Test-only; in production the same answer comes from [`Rows`]'s own defaults. `world.rs`'s unit
/// tests hand this to the serving loop so the epoch, the generation and the subscription laws can
/// be proven with no fold, no thread and no file.
#[cfg(test)]
pub struct NoRows;

#[cfg(test)]
impl Rows for NoRows {
    fn rows(&self, _source: &'static SourceDef) -> Option<Vec<SourceRow>> {
        None
    }
    fn revision(&self, _source: &'static SourceDef) -> Option<u64> {
        None
    }
}

/// Cut one window out of a source's rows: filter, sort, then slice.
///
/// Returns the window and the view's total — how many rows survived the filter, ignoring the
/// window, which is what a `1–50 of 1834` line reads off.
///
/// The sort is stable and the tiebreak makes it total, so the same rows and the same descriptor
/// produce the same window every time; the diff between two window states is the wire protocol, so
/// an unstable order would send reorder ops for a view nobody touched.
#[must_use]
pub fn cut(view: &View, rows: &[SourceRow]) -> (Vec<Row>, i64) {
    let mut kept: Vec<&SourceRow> = rows
        .iter()
        .filter(|row| {
            view.filter
                .iter()
                .all(|(field, wanted)| row.field(field).matches(wanted))
        })
        .collect();

    kept.sort_by(|a, b| {
        for (field, order) in &view.sort {
            let ordering = a.field(field).cmp(b.field(field));
            let ordering = match order {
                Order::Asc => ordering,
                Order::Desc => ordering.reverse(),
            };
            if ordering != std::cmp::Ordering::Equal {
                return ordering;
            }
        }
        std::cmp::Ordering::Equal
    });

    let total = i64::try_from(kept.len()).unwrap_or(i64::MAX);
    let window = kept
        .into_iter()
        .skip(view.offset)
        .take(view.limit)
        .map(SourceRow::row)
        .collect();
    (window, total)
}

#[cfg(test)]
mod tests {
    use super::{cut, source, validate, Cell, Field, Order, SourceRow, MAX_LIMIT};
    use protocol::generated::{Cells, ErrorCode, SortTerm, ViewDescriptor, ViewFilter, ViewWindow};

    fn descriptor(source: &str) -> ViewDescriptor {
        ViewDescriptor {
            source: source.to_owned(),
            filter: None,
            sort: Vec::new(),
            window: None,
        }
    }

    fn term(field: &str, direction: &str) -> SortTerm {
        SortTerm([field.to_owned(), direction.to_owned()])
    }

    fn row(key: &str, at: i64, seq: i64, item: &str, zone: Option<&str>) -> SourceRow {
        SourceRow {
            key: key.to_owned(),
            cells: Cells(std::collections::BTreeMap::from([(
                "item".to_owned(),
                Cell::text(item),
            )])),
            fields: vec![
                ("at", Field::Int(at)),
                ("seq", Field::Int(seq)),
                ("item", Field::Text(item.to_owned())),
                (
                    "zone",
                    zone.map_or(Field::Missing, |z| Field::Text(z.to_owned())),
                ),
            ],
        }
    }

    fn keys(rows: &[protocol::generated::Row]) -> Vec<String> {
        rows.iter().map(|r| r.key.0.clone()).collect()
    }

    #[test]
    fn an_unregistered_source_is_not_found_and_the_answer_names_what_is_served() {
        // `combat.encounters` is the stand-in unserved source; when it is served, move this name
        // rather than weaken the assertion.
        let error = validate(&descriptor("combat.encounters"))
            .err()
            .expect("a refusal");
        assert!(matches!(error.code, ErrorCode::NotFound));
        assert!(error.message.contains("loot.ledger"), "{}", error.message);
        assert!(error.message.contains("combat.live"), "{}", error.message);
        assert!(error.message.contains("timers.rows"), "{}", error.message);
        // A module id is not a source name either.
        assert!(matches!(
            validate(&descriptor("loot")).err().expect("a refusal").code,
            ErrorCode::NotFound
        ));
    }

    #[test]
    fn a_descriptor_with_nothing_in_it_takes_the_sources_own_order_and_window() {
        let view = validate(&descriptor("loot.ledger")).expect("a view");
        let expected = source("loot.ledger").expect("the source");
        assert_eq!(view.offset, 0);
        assert_eq!(view.limit, usize::try_from(expected.default_limit).unwrap());
        // The default order, and the tiebreak underneath it.
        assert_eq!(view.sort.first(), Some(&("at", Order::Desc)));
        assert_eq!(view.sort.last(), Some(&expected.tiebreak));
    }

    #[test]
    fn a_stated_sort_keeps_its_own_terms_and_still_ends_in_the_tiebreak() {
        let mut d = descriptor("loot.ledger");
        d.sort = vec![term("item", "asc")];
        let view = validate(&d).expect("a view");
        assert_eq!(view.sort[0], ("item", Order::Asc));
        assert_eq!(view.sort.last(), Some(&("seq", Order::Asc)));
    }

    #[test]
    fn a_term_naming_a_field_the_source_does_not_carry_is_refused_by_name() {
        let mut d = descriptor("loot.ledger");
        d.sort = vec![term("dps", "desc")];
        let error = validate(&d).err().expect("a refusal");
        assert!(matches!(error.code, ErrorCode::BadParams));
        assert!(error.message.contains("dps"), "{}", error.message);

        let mut d = descriptor("loot.ledger");
        d.sort = vec![term("at", "sideways")];
        assert!(validate(&d).is_err());

        // A filter naming an absent field is refused rather than served unfiltered, which would let
        // the client believe it filtered.
        let mut d = descriptor("loot.ledger");
        d.filter = Some(ViewFilter(std::collections::BTreeMap::from([(
            "session".to_owned(),
            Cell::text("current"),
        )])));
        let error = validate(&d).err().expect("a refusal");
        assert!(matches!(error.code, ErrorCode::BadParams));
        assert!(error.message.contains("session"), "{}", error.message);
    }

    #[test]
    fn a_window_outside_the_budget_is_refused_rather_than_served_slowly() {
        for window in [
            ViewWindow {
                offset: -1,
                limit: 10,
            },
            ViewWindow {
                offset: 0,
                limit: 0,
            },
            ViewWindow {
                offset: 0,
                limit: MAX_LIMIT + 1,
            },
        ] {
            let mut d = descriptor("loot.ledger");
            d.window = Some(window);
            assert!(matches!(
                validate(&d).err().expect("a refusal").code,
                ErrorCode::BadParams
            ));
        }
    }

    #[test]
    fn the_window_is_filtered_then_sorted_then_sliced_and_total_ignores_the_slice() {
        let rows = vec![
            row("loot:0", 100, 0, "Bone Chips", Some("Innothule Swamp")),
            row("loot:1", 100, 1, "Cloak of Flames", Some("Nagafen's Lair")),
            row(
                "loot:2",
                200,
                2,
                "Golden Efreeti Boots",
                Some("Nagafen's Lair"),
            ),
            row("loot:3", 300, 3, "Rusty Dagger", None),
        ];

        // Newest first, with the tiebreak resolving the two rows that share an instant: the
        // later-folded one wins.
        let view = validate(&descriptor("loot.ledger")).expect("a view");
        let (window, total) = cut(&view, &rows);
        assert_eq!(keys(&window), ["loot:3", "loot:2", "loot:1", "loot:0"]);
        assert_eq!(total, 4);

        // A filter shrinks the total as well as the window: it is the view's size, not the
        // source's.
        let mut d = descriptor("loot.ledger");
        d.filter = Some(ViewFilter(std::collections::BTreeMap::from([(
            "zone".to_owned(),
            Cell::text("Nagafen's Lair"),
        )])));
        let view = validate(&d).expect("a view");
        let (window, total) = cut(&view, &rows);
        assert_eq!(keys(&window), ["loot:2", "loot:1"]);
        assert_eq!(total, 2);

        // …and a window slices without changing it.
        let mut d = descriptor("loot.ledger");
        d.window = Some(ViewWindow {
            offset: 1,
            limit: 2,
        });
        let view = validate(&d).expect("a view");
        let (window, total) = cut(&view, &rows);
        assert_eq!(keys(&window), ["loot:2", "loot:1"]);
        assert_eq!(total, 4, "total ignores the window");
    }

    #[test]
    fn a_missing_value_is_a_place_in_the_order_rather_than_an_absence() {
        let rows = vec![
            row("loot:0", 1, 0, "a", Some("Oasis")),
            row("loot:1", 2, 1, "b", None),
        ];
        let mut d = descriptor("loot.ledger");
        d.sort = vec![term("zone", "asc")];
        let view = validate(&d).expect("a view");
        assert_eq!(keys(&cut(&view, &rows).0), ["loot:1", "loot:0"]);

        // …and an explicit null filters for the rows that have none.
        let mut d = descriptor("loot.ledger");
        d.filter = Some(ViewFilter(std::collections::BTreeMap::from([(
            "zone".to_owned(),
            Cell::null(),
        )])));
        let view = validate(&d).expect("a view");
        assert_eq!(keys(&cut(&view, &rows).0), ["loot:1"]);
    }
}
