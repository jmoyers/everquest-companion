//! `combat.live` — THE DAMAGE METER, SERVED (JOS-485).
//!
//! The ranked source list that IS level 1 of every damage meter in the product, cut off the fold's
//! own combat engine and pushed at the serve cadence. It is the first source whose rows CHANGE
//! rather than merely arrive — `loot.ledger` appends and never edits, so a live window over it can
//! only insert and drop — which makes this the source that finally exercises the diff protocol's
//! `update` op end to end, against a real fold, with changed cells only.
//!
//! ── WHAT A CELL IS HERE, READ OFF THE COMPONENTS THAT DRAW IT ──────────────────────────────────
//!
//! TWO surfaces draw this row and they are deliberately separate bundles: the Combat tab's
//! `features/combat/EntityRow.tsx` (MUI) and the floating overlay's `overlay/meterBars.tsx`
//! `SourceLines` (MUI-free, its own renderer entry). Between them a level-1 bar prints, in order:
//! the RANK, the NAME, a one-word KIND tag, a `~` ambiguity badge, a hit-rate badge, a resist-rate
//! badge, and at the right end the TOTAL, the RATE and a crit percentage. The bar's own fill is a
//! PCT. Those are the cells, and each one is a thing the reader can actually see.
//!
//! **THE RATE AND THE TOTAL ARE TWO CELLS, not the one string the bar prints.** `EntityRow` draws
//! `21.7k · 21.7k dps · 34% crit` and the overlay draws `21.7k dps · 21.7k`; the ORDER differs
//! between the two surfaces and the separator is a display choice, so composing them here would
//! serve one surface and break the other. That is `loot.ledger`'s stack-size argument at full
//! strength: two cells is the honest decomposition, joining them is a format.
//!
//! **THE KIND IS A FACT AND THE TAG IS THE WORD, and both are cells.** `kind` is the engine's
//! attribution (`you`, `pet`, `member`, `allyPet`, `other`, `enemy`) and it decides the bar's
//! COLOUR, which is presentation and stays the renderer's. `tag` is the one word printed after the
//! name — and it is not the kind: `member` prints `group`, `allyPet` prints `ally`, and `you` and
//! `enemy` print NOTHING because the direction filter has already said which of the two the reader
//! is looking at. That mapping is currently written out by hand in BOTH bundles (`EntityRow`'s
//! `KIND_TAG` and `meterBars`' `KIND_SUFFIX`, each with a comment telling the other to stay in
//! step), which is exactly the kind of thing ruling 4 moves server-side.
//!
//! **A BADGE THAT IS NOT SHOWN IS `null`, never an empty string or a zero.** The hit rate is drawn
//! only where swings were avoided (a 100% row would be furniture), the resist rate only where a
//! spell was resisted, the crit percentage only at 1% or more, and the `~` badge only where a hit
//! was name-ambiguous. Each of those gates is a real statement about the row, so the absence is the
//! answer and `null` is how the diff protocol spells one — an absent cell is UNCHANGED and a null
//! cell is CLEARED, and there is no third spelling.
//!
//! **`pct` IS A NUMBER AND EVERY OTHER MAGNITUDE IS A STRING.** The bar's fill is
//! `width: max(2, pct)%` — a CSS length, so the number IS what the pixel says. The damage figures
//! are not: `formatNum` k/M-scales them (`21.7k`, `2.3M`) and that string is the whole of what
//! anybody sees, so it is rendered here for the same reason `loot.ledger`'s timestamp is.
//!
//! ── WHAT THIS SOURCE DELIBERATELY IS NOT ──────────────────────────────────────────────────────
//!
//! **OUTGOING ONLY, and named rather than forgotten.** `SegmentView` carries `entities` (what you
//! and yours dealt) beside `incoming` (what was dealt to you), and the same components draw both —
//! `missLead` has an `enemy` arm for exactly that. They are not folded into one source here
//! because a meter is a RANKING and a ranking that interleaves two directions is not one: the
//! window's default order would put a hard-hitting mob among your group, and a client that forgot a
//! direction filter would get a list nobody drew. The incoming meter is its own source when the
//! surface that needs it arrives, on the same terms `eventFeed.recent` is deferred in
//! `views/mod.rs`.
//!
//! **LEVEL 1 ONLY.** A bar drills into that source's ability lanes, and those are a different row
//! shape with a different key space (`melee|Slash`) behind a client-held selection. A view is a
//! window over a collection; a drill is a second query, and it gets a second source.

use protocol::cell::Cell;
use protocol::generated::Cells;
use serde_json::Value;

use super::{Field, Order, SourceDef, SourceRow};

/// The registry entry. See [`super::SourceDef`].
pub const LIVE: SourceDef = SourceDef {
    id: "combat.live",
    // `id` is a FIELD WITH NO CELL — the row's KEY already is it, and a cell repeating the key
    // would be a second copy of one identity. It is declared because the tiebreak must name a
    // field, and it is the only value on the row guaranteed unique within a segment.
    fields: &["rank", "name", "kind", "total", "id"],
    // THE METER'S OWN RANKING. `sourceViews` ends in `sort((a, b) => b.total - a.total)`, so this
    // is the order the fold already put the rows in and the order every surface draws.
    //
    // THERE IS DELIBERATELY NO `dps` FIELD, and the reason is arithmetic rather than taste: every
    // row of one segment divides the same `durationSec`, so a sort by dps IS the sort by total. A
    // second name for one order is a way for a client to believe it asked for something.
    default_sort: &[("total", Order::Desc)],
    tiebreak: ("id", Order::Asc),
    default_limit: super::DEFAULT_LIMIT,
};

/// Build every row of the meter, in the fold's own ranked order.
///
/// `selected` is the `selected` half of a combat snapshot — one `SegmentView` as JSON, or `null`
/// when the selection resolves to no fight at all, which is the honest answer for a session that
/// has not fought yet. Reading it as JSON rather than as a struct is not a shortcut: `SourceView`'s
/// fields are private to `fold::combat::views` and its serialization IS its published contract —
/// the same contract the app's renderer reads — so taking the published shape is taking the one
/// answer rather than a second opinion about it.
#[must_use]
pub fn rows(selected: &Value) -> Vec<SourceRow> {
    let Some(entities) = selected.get("entities").and_then(Value::as_array) else {
        return Vec::new();
    };
    entities
        .iter()
        .enumerate()
        .map(|(index, e)| row(index, e))
        .collect()
}

fn row(index: usize, e: &Value) -> SourceRow {
    let id = str_of(e, "id");
    let name = str_of(e, "name");
    let kind = str_of(e, "kind");
    let total = int_of(e, "total");
    // THE RANK IS THE METER'S, NOT THE WINDOW'S. `MeterRows` and `SourceLines` both pass
    // `rank={i + 1}` over the fold's already-ranked array, so this number is a property of the
    // source and a client that sorts by name does not renumber the meter.
    let rank = i64::try_from(index).unwrap_or(i64::MAX).saturating_add(1);

    let mut cells = std::collections::BTreeMap::new();
    cells.insert("rank".to_owned(), Cell::int(rank));
    cells.insert("name".to_owned(), Cell::text(name));
    cells.insert("kind".to_owned(), Cell::text(kind));
    cells.insert(
        "tag".to_owned(),
        kind_tag(kind).map_or(Cell::null(), Cell::text),
    );
    cells.insert("pct".to_owned(), Cell::float(float_of(e, "pct")));
    cells.insert(
        "total".to_owned(),
        Cell::text(format_num(int_to_f64(total))),
    );
    cells.insert(
        "dps".to_owned(),
        Cell::text(format_rate(float_of(e, "dps"))),
    );
    // The three conditional badges. Each gate is the renderer's own, restated here rather than
    // guessed at, and each absence is a `null` because the diff protocol needs a cell it can clear.
    cells.insert(
        "crit".to_owned(),
        gated(
            float_of(e, "critPct") >= 1.0,
            &format!("{}% crit", js_round(float_of(e, "critPct"))),
        ),
    );
    cells.insert(
        "hit".to_owned(),
        gated(
            int_of(e, "misses") > 0,
            &format!("{}% hit", js_round(float_of(e, "hitPct"))),
        ),
    );
    cells.insert(
        "resist".to_owned(),
        gated(
            int_of(e, "resists") > 0,
            &format!("{}% resist", js_round(float_of(e, "resistPct"))),
        ),
    );
    // THE `~` BADGE COUNTS HITS AND SAYS SO. The tooltip behind it composes a whole sentence
    // (`3 hits (1.2k dmg) are name-ambiguous…`) and that sentence is a Combat-tab-only affordance
    // the overlay has none of — JOS-358 removed every hover from those bars. The COUNT is what the
    // badge stands for on both surfaces, so the count is the cell.
    let ambiguous = int_of(e, "ambiguousHits");
    cells.insert(
        "ambiguous".to_owned(),
        if ambiguous > 0 {
            Cell::int(ambiguous)
        } else {
            Cell::null()
        },
    );

    SourceRow {
        key: id.to_owned(),
        cells: Cells(cells),
        fields: vec![
            ("rank", Field::Int(rank)),
            ("name", Field::Text(name.to_owned())),
            ("kind", Field::Text(kind.to_owned())),
            ("total", Field::Int(total)),
            ("id", Field::Text(id.to_owned())),
        ],
    }
}

/// The ONE WORD printed after a bar's name, or `None` for a row that gets none.
///
/// `EntityRow.tsx`'s `KIND_TAG` and `meterBars.tsx`'s `KIND_SUFFIX`, which are the same map written
/// twice because the two bundles cannot share a module. `you` and `enemy` are absent from both, and
/// deliberately: the direction filter has already said which of the two the reader is looking at,
/// and a row tagged `you` in your own damage list is noise. `other` is emphatically NOT `player` —
/// EQ spells a summoned pet's name with the same grammar it gives people, so the word must not pick
/// one (JOS-430).
fn kind_tag(kind: &str) -> Option<&'static str> {
    match kind {
        "pet" => Some("pet"),
        "member" => Some("group"),
        "allyPet" => Some("ally"),
        "other" => Some("other"),
        _ => None,
    }
}

fn gated(shown: bool, text: &str) -> Cell {
    if shown {
        Cell::text(text)
    } else {
        Cell::null()
    }
}

/// `src/renderer/src/lib/formatRate.ts formatNum` — k/M-scaled magnitude with no unit word.
///
/// The app's ONE spelling of a damage figure, and the reason it is re-spelled here rather than left
/// to the client is ruling 4: `21.7k` is what the pixel says, and a client that had to scale and
/// round it would be doing the munging the ruling forbids.
fn format_num(n: f64) -> String {
    if n >= 1_000_000.0 {
        return format!("{}M", to_fixed(n / 1_000_000.0, 2));
    }
    if n >= 1_000.0 {
        return format!("{}k", to_fixed(n / 1_000.0, 1));
    }
    js_round(n).to_string()
}

/// `formatRate` — the k/M-scaled number followed by the WORD `dps`.
///
/// The word rather than `/s`: Task #54 removed every `/s` in the app and this is the spelling that
/// replaced them.
fn format_rate(n: f64) -> String {
    format!("{} dps", format_num(n))
}

/// `Number.prototype.toFixed`, and it is written out rather than left to `{:.*}` because the two
/// ROUND TIES IN OPPOSITE DIRECTIONS.
///
/// ECMA-262 says: pick the integer `n` for which `n / 10^f - x` is closest to zero, and **if two are
/// equally close, pick the LARGER**. Rust's float formatting rounds half to EVEN. They agree on
/// every value that is not an exact tie and disagree on every value that is — and exact ties are not
/// exotic here, because a damage total is an integer over 1000: `1250` renders `1.3k` in the app and
/// `1.2k` through `{:.1}`. A meter one tenth apart between the app and the engine is a parity
/// failure with a very boring cause, so it is closed here rather than discovered later.
///
/// **`x` IS THE `f64`, NOT THE DECIMAL SOMEBODY TYPED, and that is the second half of the rule.**
/// `21.65` is not 21.65 — the nearest double is 21.6499999999999985…, which is NOT a tie and rounds
/// DOWN in both languages. So the arithmetic shortcut (`floor(v * 10 + 0.5)`) is wrong twice over:
/// the multiply itself rounds 21.6499999…×10 up to exactly 216.5 and manufactures a tie that the
/// value never had. What this does instead is take the EXACT decimal expansion of the double —
/// which is what `{:.*}` at high precision prints — and round the digit string, half up. That is the
/// spec's own procedure with no floating-point step left in it.
fn to_fixed(v: f64, digits: usize) -> String {
    if !v.is_finite() {
        return format!("{v}");
    }
    // FAR MORE DIGITS THAN THE ANSWER NEEDS, because the only thing they are for is telling a true
    // tie from a value that merely looks like one. Two doubles differ by at least one ulp — ~1e-14
    // absolute in the band a k/M-scaled figure lives in — so twenty-five extra places settle it
    // with room to spare.
    let exact = format!("{:.*}", digits + 25, v.abs());
    let (whole, frac) = exact.split_once('.').unwrap_or((exact.as_str(), ""));
    let (keep, rest) = frac.split_at(digits.min(frac.len()));
    let mut out: Vec<u8> = whole.bytes().chain(keep.bytes()).collect();
    // FIRST DROPPED DIGIT >= 5 ROUNDS UP, which covers both halves of the rule at once: above the
    // tie rounds up because it is nearer, and ON the tie rounds up because the spec says larger.
    if rest.as_bytes().first().is_some_and(|d| *d >= b'5') {
        let mut at = out.len();
        loop {
            if at == 0 {
                out.insert(0, b'1');
                break;
            }
            at -= 1;
            if out[at] == b'9' {
                out[at] = b'0';
            } else {
                out[at] += 1;
                break;
            }
        }
    }
    let sign = if v < 0.0 { "-" } else { "" };
    let text = String::from_utf8(out).unwrap_or_default();
    let point = text.len().saturating_sub(digits);
    if digits == 0 {
        format!("{sign}{text}")
    } else {
        format!("{sign}{}.{}", &text[..point], &text[point..])
    }
}

/// `Math.round` — ROUND HALF UP, which is not `f64::round` (round half away from zero). They differ
/// only for negatives; a percentage here is never one, and the distinction is spelled out so a
/// later reader does not "simplify" it. Stated the same way in `fold::combat`'s `js_round`.
fn js_round(v: f64) -> i64 {
    #[allow(clippy::cast_possible_truncation)]
    let n = (v + 0.5).floor() as i64;
    n
}

fn str_of<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn int_of(value: &Value, key: &str) -> i64 {
    value.get(key).and_then(Value::as_i64).unwrap_or_default()
}

fn float_of(value: &Value, key: &str) -> f64 {
    value.get(key).and_then(Value::as_f64).unwrap_or_default()
}

#[allow(clippy::cast_precision_loss)]
fn int_to_f64(n: i64) -> f64 {
    n as f64
}

#[cfg(test)]
mod tests {
    use super::{format_num, format_rate, rows, to_fixed, LIVE};
    use crate::views::{cut, validate, Field};
    use protocol::generated::ViewDescriptor;
    use serde_json::json;

    /// One `SegmentView`, stated with only the fields the row builder reads. The real one carries
    /// twenty more; this suite is about the CELLS, and the engine's own integration suite is what
    /// holds them against a fold.
    fn selected(entities: serde_json::Value) -> serde_json::Value {
        json!({ "id": "e1", "kind": "fight", "name": "a sand giant", "entities": entities })
    }

    fn entity(
        id: &str,
        name: &str,
        kind: &str,
        total: i64,
        dps: f64,
        pct: f64,
    ) -> serde_json::Value {
        json!({
            "id": id, "name": name, "kind": kind, "total": total, "dps": dps, "pct": pct,
            "hits": 10, "crits": 0, "critPct": 0.0, "ambiguousHits": 0, "ambiguousTotal": 0,
            "misses": 0, "hitPct": 100.0, "resists": 0, "resistPct": 0.0
        })
    }

    #[test]
    fn a_row_carries_what_a_level_one_bar_prints() {
        let built = rows(&selected(json!([entity(
            "you", "You", "you", 21_712, 723.7, 100.0
        )])));
        assert_eq!(built.len(), 1);
        let cells = &built[0].cells;
        assert_eq!(built[0].key, "you", "the key is the source's own id");
        assert_eq!(cells["rank"], protocol::Cell::int(1));
        assert_eq!(cells["name"], protocol::Cell::text("You"));
        assert_eq!(cells["kind"], protocol::Cell::text("you"));
        // `you` gets no word after its name on either surface.
        assert_eq!(cells["tag"], protocol::Cell::null());
        assert_eq!(cells["total"], protocol::Cell::text("21.7k"));
        // Under a thousand `formatNum` is `String(Math.round(n))` — an integer, no unit scaling,
        // and the word `dps` after it.
        assert_eq!(cells["dps"], protocol::Cell::text("724 dps"));
        // A badge whose gate is shut is NULL, not an empty string and not a zero.
        assert_eq!(cells["crit"], protocol::Cell::null());
        assert_eq!(cells["hit"], protocol::Cell::null());
        assert_eq!(cells["resist"], protocol::Cell::null());
        assert_eq!(cells["ambiguous"], protocol::Cell::null());
    }

    #[test]
    fn the_one_word_after_a_name_is_the_renderers_word_and_not_the_kind() {
        // `member` prints `group` and `allyPet` prints `ally` — the two spellings that made this a
        // cell rather than a client-side map. `enemy` prints nothing, like `you`.
        let built = rows(&selected(json!([
            entity("pet:3", "Gybrush", "pet", 900, 30.0, 40.0),
            entity("member:rowel", "Rowel", "member", 800, 26.6, 35.0),
            entity("ally:vex", "Vex's pet", "allyPet", 700, 23.3, 30.0),
            entity("other:kez", "Kez", "other", 600, 20.0, 26.0),
            entity("enemy:giant", "a sand giant", "enemy", 500, 16.6, 22.0),
        ])));
        let tags: Vec<protocol::Cell> = built.iter().map(|r| r.cells["tag"].clone()).collect();
        assert_eq!(
            tags,
            [
                protocol::Cell::text("pet"),
                protocol::Cell::text("group"),
                protocol::Cell::text("ally"),
                protocol::Cell::text("other"),
                protocol::Cell::null(),
            ]
        );
    }

    #[test]
    fn a_badge_appears_exactly_where_its_gate_says_it_does() {
        let mut e = entity("you", "You", "you", 21_712, 723.7, 100.0);
        e["critPct"] = json!(34.4);
        e["misses"] = json!(7);
        e["hitPct"] = json!(58.82);
        e["resists"] = json!(2);
        e["resistPct"] = json!(16.6);
        e["ambiguousHits"] = json!(3);
        let built = rows(&selected(json!([e.clone()])));
        let cells = &built[0].cells;
        assert_eq!(cells["crit"], protocol::Cell::text("34% crit"));
        assert_eq!(cells["hit"], protocol::Cell::text("59% hit"));
        assert_eq!(cells["resist"], protocol::Cell::text("17% resist"));
        assert_eq!(cells["ambiguous"], protocol::Cell::int(3));

        // …and the crit gate is `>= 1`, not `> 0`: a row with a third of a percent shows nothing,
        // which is `EntityRow`'s own rule and the one place a rounded `0% crit` could have crept in.
        e["critPct"] = json!(0.4);
        let built = rows(&selected(json!([e])));
        assert_eq!(built[0].cells["crit"], protocol::Cell::null());
    }

    #[test]
    fn the_rank_is_the_folds_order_and_a_client_sort_does_not_renumber_it() {
        let built = rows(&selected(json!([
            entity("you", "You", "you", 900, 30.0, 100.0),
            entity("pet:3", "Gybrush", "pet", 100, 3.3, 11.0),
        ])));
        let mut d = ViewDescriptor {
            source: LIVE.id.to_owned(),
            filter: None,
            sort: Vec::new(),
            window: None,
        };
        // The default order is the meter's: total desc.
        let view = validate(&d).expect("a view");
        let (window, total) = cut(&view, &built);
        assert_eq!(
            window.iter().map(|r| r.key.0.as_str()).collect::<Vec<_>>(),
            ["you", "pet:3"]
        );
        assert_eq!(total, 2);

        // …and asking for it by NAME reorders the window while every row keeps the rank the meter
        // gave it. A cell that moved with the window would be a second, disagreeing ranking.
        d.sort = vec![protocol::generated::SortTerm([
            "name".to_owned(),
            "asc".to_owned(),
        ])];
        let view = validate(&d).expect("a view");
        let (window, _) = cut(&view, &built);
        assert_eq!(
            window.iter().map(|r| r.key.0.as_str()).collect::<Vec<_>>(),
            ["pet:3", "you"]
        );
        assert_eq!(window[0].cells["rank"], protocol::Cell::int(2));
    }

    #[test]
    fn a_selection_that_resolved_to_nothing_is_an_empty_window_rather_than_a_panic() {
        // `selected: null` is what a session with no fights publishes, and the UI draws a quiet
        // "no fights yet" over it. A view has to be able to say the same thing.
        assert!(rows(&serde_json::Value::Null).is_empty());
        assert!(rows(&json!({ "id": "zone", "kind": "zone" })).is_empty());
    }

    #[test]
    fn the_total_is_the_apps_own_spelling_of_a_damage_figure() {
        assert_eq!(format_num(0.0), "0");
        assert_eq!(format_num(999.0), "999");
        assert_eq!(format_num(1_000.0), "1.0k");
        assert_eq!(format_num(21_712.0), "21.7k");
        assert_eq!(format_num(2_300_000.0), "2.30M");
        assert_eq!(format_rate(723.7), "724 dps");
        assert_eq!(format_rate(21_712.0), "21.7k dps");
    }

    #[test]
    fn a_tie_rounds_the_way_javascript_rounds_it() {
        // THE CASE THAT SEPARATES THE TWO LANGUAGES. `1250 / 1000` is exactly 1.25, so it is a true
        // tie: `toFixed(1)` answers "1.3" (larger n wins) and Rust's `{:.1}` answers "1.2" (half to
        // even). A meter one tenth apart between the app and the engine is a parity failure with a
        // very boring cause, and this is the pin that keeps it from happening.
        assert_eq!(to_fixed(1.25, 1), "1.3");
        assert_eq!(format_num(1_250.0), "1.3k");
        assert_eq!(to_fixed(1.125, 2), "1.13");
        assert_eq!(to_fixed(8.25, 1), "8.3");
        // …and a value that only LOOKS like a tie is not one, which is the trap the arithmetic
        // shortcut falls into: the nearest double to 21.65 is 21.64999999999999857…, so the app
        // answers 21.6 — and so does this, because it rounds the exact expansion rather than a
        // product that has already been rounded up to 216.5.
        assert_eq!(to_fixed(21.65, 1), "21.6");
        assert_eq!(format_num(21_650.0), "21.6k");
        assert_eq!(to_fixed(1.45, 1), "1.4", "1.45 is really 1.4499999…");
        assert_eq!(to_fixed(1.35, 1), "1.4", "1.35 is really 1.3500000…88");
        // The carry, all the way out of the number it started in.
        assert_eq!(to_fixed(9.99, 1), "10.0");
        assert_eq!(format_num(999_999.0), "1000.0k");
    }

    #[test]
    fn the_field_and_the_cell_of_one_name_are_different_values() {
        // The distinction the whole view layer turns on, restated for this source: `total` renders
        // as `21.7k` and sorts as 21,712. Sorting a column of `21.7k` strings would put 9 after 2.
        let built = rows(&selected(json!([entity(
            "you", "You", "you", 21_712, 723.7, 100.0
        )])));
        assert_eq!(built[0].cells["total"], protocol::Cell::text("21.7k"));
        assert_eq!(
            built[0]
                .fields
                .iter()
                .find(|(f, _)| *f == "total")
                .map(|(_, v)| v),
            Some(&Field::Int(21_712))
        );
    }
}
