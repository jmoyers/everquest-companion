//! ============================================================================
//! THE VIEW LAYER — views served for real (JOS-459 phase 3, JOS-480).
//! ============================================================================
//!
//! `view.subscribe` used to acknowledge and hand back an empty window. This module is what makes
//! it a data-bearing op: a SOURCE REGISTRY, descriptor validation, and the diff protocol computed
//! between two states of one client's window.
//!
//! ## THE FOUR RULES (docs/plans/data-server.md, "The subscription diff protocol")
//!
//! 1. **Reset-then-diffs.** Every subscription opens with a full `reset`, and takes another
//!    whenever the world it was describing is replaced. Held here as: a subscription whose window
//!    state is `None` is OWED a reset, and nothing else can be sent to it.
//! 2. **Coalescing, ~10 Hz while live.** A CADENCE, not a per-event push — see [`SERVE_EVERY`] and
//!    `ingest.rs`'s live loop. Everything that happened between two services collapses into one
//!    frame, and an `update` carries only the cells that moved.
//! 3. **Every message carries the epoch**, and a bump means drop-and-take-the-fresh-reset. The
//!    stamp happens inside `world.rs`'s critical section, which is why the serving loop lives
//!    there and not here.
//! 4. **Rows are render-ready** (owner ruling 4). A cell is what the pixel says. This module owns
//!    the query — filter, sort, window — and each SOURCE owns what a row of it looks like.
//!
//! ## WHAT IS A QUERY FIELD AND WHAT IS A CELL — the distinction the whole file turns on
//!
//! A `SortTerm` names `at`; a cell is also called `at`; they are NOT the same value and must not
//! be. The cell is `"Aug 19, 04:21 PM"` because that is what the loot ledger draws. Sorting a
//! column of those strings would order August before April, which is the failure mode ruling 4
//! exists to prevent, one level deeper than the renderer. So every source declares FIELDS — the
//! comparable values a descriptor may name — beside the cells it renders, and the two are looked
//! up separately. A source may publish a field with no cell (`seq`, below) and a cell with no
//! field; neither is an accident.
//!
//! ## WHERE RULING 4 STOPS — NUMBERS, NOT SENTENCES (JOS-487)
//!
//! `loot.ledger` renders its instant as `"Aug 19, 04:21 PM"` because that is what the pixel says,
//! and six sources later that is still the rule — with two named exceptions that are the same
//! exception read twice, and both of them are the APP's own decision rather than a relaxation of
//! the owner's.
//!
//! **A value read against NOW is served as the instant, not as the phrasing.** A timer bar's
//! remaining time changes every frame; serving it as text would mean a diff per visible row per
//! serve beat and it would still be stale between two frames, so the renderer would recompute it
//! anyway. What crosses is `startedTs`, `durationMs` and `mode` — the three numbers the reading is a
//! pure function of. This is the same allowance `FoldProgress.pct` already has ("rounding is a
//! display decision and belongs to whoever is drawing the bar"), and it takes nothing from ruling 4,
//! which is about the renderer never FILTERING, SORTING or AGGREGATING the world — all three of
//! which happen in this file.
//!
//! **A value whose wording is a SHARED derivation is served as its numbers.** The buff row's
//! `~4m 30s`, the resist chip's `R 126 (110-144)`, the respawn row's provenance line: each is built
//! by one function that the tab, the overlay and the hover card all read, so a wire carrying the
//! finished string would be a second copy of a vocabulary that must not drift. `shared/conCard.ts`
//! already made exactly this call for a payload that fetches nothing ("IT CARRIES NUMBERS, NOT
//! SENTENCES"), and the engine keeps it rather than inventing a competing wording.
//!
//! Everything else is rendered here: a date, a name, a count, a decomposed bitfield
//! (`kills.recent`'s three experience flags), a routing answer (`timers.rows`' `surface`), a
//! comparison already made (`respawn.watches`' `overridden`).
//!
//! **AND A CELL IS A SCALAR.** `Cell` is string, number, boolean or null, so a list or an object is
//! not one: a row's candidate spells become its joined `name` plus an `ambiguous` flag, a feed
//! entry's `reward` block becomes prefixed cells, and `respawn.watches` drops the gap array with the
//! reason stated in its own header. Nothing is stringified into a cell for a client to parse back
//! out — that would be the munging the ruling forbids, wearing a scalar's clothes.
//!
//! ## THE SORT IS TOTAL, ALWAYS
//!
//! EQ log timestamps are SECOND-resolution, so a corpse that yields three items writes three lines
//! with the same `ts` — ties are the common case, not the corner (`lootSort.ts` records the same
//! finding app-side). A window whose order is not total shuffles between services, and a shuffled
//! window is a diff full of reorder churn for a list nobody changed. Every sort therefore ends in
//! its source's [`SourceDef::tiebreak`], which is a field the source guarantees is unique.
//!
//! ## THE COST MODEL, stated because a perf program is paying for it
//!
//! Building a source's rows is O(the whole source), and cutting a window out of them is O(that)
//! too. A subscription is serviced only when its source's REVISION moved (a counter the module
//! bumps on any change it could have made) or when it is owed a reset — so an idle session pays
//! nothing at all, and an active one pays once per cadence interval rather than once per event.
//! What that costs in practice is not a guess: [`meter`] measures it and the ingest prints it
//! (owner ruling 19).

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

/// The floor between two services of the same subscription — rule 2's "~10 Hz max while live".
///
/// A CEILING ON FRAME RATE, not a promise of one: nothing is sent when nothing moved. The live
/// tail polls every 400 ms and naps in 25 ms slices, so in practice this bounds the burst case (a
/// busy log) rather than the quiet one, and it is stated as a duration for the same reason the
/// progress cadence is — an events-based rule would fire a hundred times a second on a raid slice
/// and never on a quiet one.
pub const SERVE_EVERY: Duration = Duration::from_millis(100);

/// The window a source hands back when the descriptor states none.
///
/// The schema is explicit that an absent window means "the engine's default for that source" and
/// never `everything`, "because an unbounded window is how a payload budget gets blown".
pub const DEFAULT_LIMIT: i64 = 50;

/// The largest window this engine will cut, whoever asks.
///
/// A CLIENT-CHOSEN NUMBER IS AN UNTRUSTED ONE even from a renderer we wrote: a typo'd `limit` of
/// 10_000_000 would be one allocation of ten million rows on the ingest thread — the thread the
/// fold runs on. Refusing it by name is a better answer than serving it slowly.
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

/// ONE COMPARABLE VALUE OF A ROW — what a `sort` or `filter` term names.
///
/// Deliberately small and deliberately NOT `Cell`: a cell is display text and this is the thing
/// underneath it (see the module header). `Missing` is a value rather than an absence so that
/// ordering is total over a column that is sometimes empty — a loot row folded before the scan
/// reached a zone line honestly has no zone, and it still has to land somewhere in a sort by zone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Field {
    /// A whole number: an instant in epoch millis, a count, an index.
    Int(i64),
    /// Text, compared by CODE POINT and never by locale. `lootSort.ts` uses `localeCompare` app
    /// side; this engine cannot, because a host collation in the serve path is a host-dependent
    /// answer, and determinism is cacheability (ruling 18 law 1). The consequence is stated rather
    /// than hidden: an accented name sorts differently here than the current renderer sorts it.
    Text(String),
    /// The row has no value for this field.
    Missing,
}

impl Field {
    /// Total order over one column: `Missing` first, then numbers, then text.
    ///
    /// The cross-type arms cannot happen for a well-formed source — a field is one type per source
    /// — and are ordered rather than panicking because a serve path is not a place to raise.
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

    /// Does this field equal the value a filter named? A filter is a `Cell` on the wire — the
    /// schema reuses the type — so the comparison crosses the two vocabularies here, once.
    fn matches(&self, wanted: &Cell) -> bool {
        match (self, wanted.as_json()) {
            (Self::Missing, serde_json::Value::Null) => true,
            (Self::Text(text), serde_json::Value::String(s)) => text == s,
            (Self::Int(n), serde_json::Value::Number(number)) => number.as_i64() == Some(*n),
            _ => false,
        }
    }
}

/// ONE ROW OF A SOURCE, before any window is cut: its identity, what it renders as, and what it
/// can be queried by.
pub struct SourceRow {
    /// Stable identity within the view — `loot:9413`. The key lives OUTSIDE the cells so a reset
    /// row and a diff update apply the same way (the schema says so at `Row`).
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

/// WHAT A SOURCE IS, to the registry: a name, the fields it can be queried by, the order it takes
/// when nobody states one, and the tiebreak that makes every order total.
pub struct SourceDef {
    /// The name a descriptor asks for. Not a module id — `loot.ledger` is a VIEW over the `loot`
    /// module, filtered, sorted and windowed, and `module.snapshot` refuses this name on purpose.
    pub id: &'static str,
    /// Every field a `sort` or `filter` term may name. A term naming anything else is `badParams`:
    /// silently ignoring it would hand a client a window it did not ask for and cannot tell apart
    /// from the one it did.
    pub fields: &'static [&'static str],
    /// The order a descriptor with no `sort` gets.
    pub default_sort: &'static [(&'static str, Order)],
    /// Appended to EVERY sort, so the order is total. See the module header. The field named here
    /// must be unique within the source.
    pub tiebreak: (&'static str, Order),
    /// The window a descriptor with no `window` gets, at offset 0.
    pub default_limit: i64,
}

/// EVERY SOURCE THIS BUILD SERVES. The registry exists so that the LIST is a fact the code states
/// rather than a gap a reader infers — an unknown source is `notFound`, which is only answerable
/// because there is a list to be absent from.
///
/// THEY ARE TWO DIFFERENT KINDS OF SOURCE and that is worth knowing before reading any of them.
/// `loot.ledger`, `kills.recent`, `progression.recent` and `eventFeed.recent` APPEND: a row, once
/// written, never changes, so a live window over one produces inserts and drops and never an
/// `update`. `combat.live`, `timers.rows`, `buffs.active` and `respawn.watches` EDIT: the same keys
/// sit in the window while their numbers move, which is what makes `combat.live` the source that
/// exercises the diff protocol's third op against a real fold (JOS-485).
///
/// `eventFeed.recent` USED TO BE ABSENT FROM THIS LIST WITH AN ARGUMENT ATTACHED — its ring could
/// only ever be empty, so "no test could tell a working one from a broken one". JOS-487 registered
/// it having answered the objection rather than dropped it: the projection is a pure function of a
/// ring and `views::event_feed` pins every cell against a hand-built one, so a broken cell fails a
/// test whether or not a fold can produce the entry it mangled. And JOS-486 took the first clause
/// away as well — the loot source's item probe is a real in-process lookup now, so a live loot line
/// puts a row in that ring.
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

/// A VALIDATED DESCRIPTOR — the whole query, with every name resolved against a real source.
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
/// EVERY REFUSAL IS BY NAME. A source that does not exist, a field that does not exist, a
/// direction that is not `asc`/`desc`, a window outside the budget — each says which term was
/// wrong and, where it helps, what the source does carry. The alternative is a client that gets a
/// window it did not ask for and no way to notice.
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
    // THE TIEBREAK IS APPENDED TO EVERY SORT, the client's own included. See the module header:
    // an order that is not total is a window that shuffles, and a shuffled window is diff churn.
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

/// WHERE THE ROWS COME FROM. Implemented over the ingest thread's fold — see
/// `ingest::EventSink::source_rows`.
pub trait Rows {
    /// Every row of one source, in its natural order, or `None` when this fold carries no such
    /// source. `None` is not an error: a counting sink folds no modules at all, and a subscription
    /// over a source it cannot serve gets an honest empty window rather than a refusal it can do
    /// nothing about.
    fn rows(&self, source: &'static SourceDef) -> Option<Vec<SourceRow>>;

    /// The source's change signal — a number that moves whenever the source could have changed.
    /// `None` for a source this fold does not carry.
    fn revision(&self, source: &'static SourceDef) -> Option<u64>;
}

/// A fold that serves no view at all: every window is empty, every revision is zero.
///
/// TEST-ONLY, and that is not a gap — in production the same answer comes from [`Rows`]'s own
/// defaults, because a sink that folds no modules implements neither method. This is the shape
/// `world.rs`'s unit tests hand the serving loop so that the epoch, the generation and the
/// subscription laws can be proven with no fold, no thread and no file in the room.
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
/// Returns the window and the view's TOTAL — how many rows survived the filter, ignoring the
/// window, which is what a `1–50 of 1834` line reads off.
///
/// THE SORT IS STABLE AND THE TIEBREAK MAKES IT TOTAL, so the same rows and the same descriptor
/// produce the same window every time. That is not a nicety: the diff between two window states IS
/// the wire protocol, so an unstable order would send reorder ops for a view nobody touched.
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
        // THE STAND-IN KEEPS MOVING, WHICH IS THE REGISTRY WORKING. `combat.live` was this test's
        // unserved source until JOS-485 served it; `eventFeed.recent` was until JOS-487 did. What is
        // left is `combat.encounters` — named in the cutover ledger, arriving with the drill-down —
        // and the day that is served this line moves again rather than the assertion weakening.
        let error = validate(&descriptor("combat.encounters"))
            .err()
            .expect("a refusal");
        assert!(matches!(error.code, ErrorCode::NotFound));
        assert!(error.message.contains("loot.ledger"), "{}", error.message);
        assert!(error.message.contains("combat.live"), "{}", error.message);
        assert!(error.message.contains("timers.rows"), "{}", error.message);
        // …and `loot` — the MODULE id — is not a source either. The two vocabularies are separate
        // on purpose, and confusing them has to be told rather than guessed at.
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

        // THE FIXTURE'S OWN FILTER IS THE CASE WORTH PINNING. The plan doc's worked example filters
        // `{"session":"current"}`, and `loot.ledger` carries no such field: the honest answer is to
        // say so rather than to serve every row and let the client believe it filtered.
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

        // Newest first, with the tiebreak resolving the two rows that share an instant — the
        // LATER-folded one wins, which is the reverse the flat ledger draws.
        let view = validate(&descriptor("loot.ledger")).expect("a view");
        let (window, total) = cut(&view, &rows);
        assert_eq!(keys(&window), ["loot:3", "loot:2", "loot:1", "loot:0"]);
        assert_eq!(total, 4);

        // A filter shrinks the TOTAL as well as the window: it is the view's size, not the
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

        // …and an explicit null filters FOR the rows that have none.
        let mut d = descriptor("loot.ledger");
        d.filter = Some(ViewFilter(std::collections::BTreeMap::from([(
            "zone".to_owned(),
            Cell::null(),
        )])));
        let view = validate(&d).expect("a view");
        assert_eq!(keys(&cut(&view, &rows).0), ["loot:1"]);
    }
}
