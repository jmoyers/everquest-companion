//! ============================================================================
//! SEARCHING THE CLIENT'S SPELL TABLE BY TYPE (JOS-507).
//! ============================================================================
//!
//! The in-game Actions/Spells window can search by TYPE: a `tap` search over a SHD/BRD/WIZ combo
//! returns every tap by level, with a Category column reading `Taps` and a Subcategory column
//! reading `Health`, `Duration Tap` or `Power Tap`. Those words are in the player's own client files
//! — `spells_us.txt` files each spell under two integer ids and `dbstr_us.txt` says what the ids are
//! called — so the app can offer the same capability without inventing a vocabulary.
//!
//! ## WHY THE QUERY IS HERE AND NOT IN `fold`
//!
//! `search.rs` (fight search) already made this argument and it holds unchanged: the equivalence
//! oracle compares what a FOLD PUBLISHES, and a query that ranks rows is not part of that claim.
//! `fold::spells_us` and `fold::dbstr` own the two FORMATS; `engined::spells` owns the two FILES;
//! this module owns the QUESTION. Nothing here touches fold state in either direction — the client
//! table is READ-TIME data and ruling 18 keeps it that way, which is why the oracle is untouched by
//! this whole ticket.
//!
//! ## THE NO-BULK-FRAME RULING IS WHAT SHAPES THE ANSWER
//!
//! The standing ruling (`fold::spells_us`'s header, measured 2026-08-25) is that the parsed table —
//! 48,256 entries and 6.13 MiB of JSON on the owner's install, against an 8 MiB frame ceiling — is
//! NEVER served in one reply. So this is a FILTERED, SORTED, WINDOWED question and the window is
//! bounded at the op. The corpus is scanned linearly per call, exactly as fight search is and for
//! the same measured reason: the whole table is in this process's memory, and an index would be
//! complexity bought with nothing.
//!
//! ## AND THE RENDERER NEVER RE-DERIVES ANY OF IT (ruling 4)
//!
//! Rows arrive filtered, sorted and windowed, with their category and subcategory already spelled as
//! WORDS rather than ids — a client that received ids would have to join them against a table it
//! cannot have, which is the munging the ruling forbids. [`Found::categories`] exists for the same
//! reason one layer up: the category vocabulary is DAYBREAK'S and lives only in the player's install,
//! so the app cannot ship a hardcoded list to populate a filter control with. The engine reports
//! which categories the current scope actually contains, and the surface draws exactly those.

use fold::dbstr::CategoryNames;
use fold::spells_us::{ClassLevels, SpellTable, CLASS_ORDER};
use std::collections::BTreeMap;

/// How the caller wants the list ordered.
///
/// TWO MEMBERS AND NO MORE, and the restraint is the point: an unknown sort is `badParams` by the
/// schema's enum rather than by a check here, which is the JOS-478 law ("an unknown filter/sort
/// field is `badParams`, never accept-and-ignore") satisfied structurally.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Sort {
    /// LEVEL DESCENDING — the in-game window's own order, and the default for that reason.
    #[default]
    Level,
    /// Alphabetical, for a reader looking for a name rather than for what is newest.
    Name,
}

/// One question about the client's table.
///
/// EVERY FILTER IS AND-ED, and an absent one filters nothing.
#[derive(Debug, Default)]
pub struct Query<'a> {
    /// A case-insensitive SUBSTRING of the spell's NAME, ITS CATEGORY OR ITS SUBCATEGORY.
    ///
    /// THE THREE FIELDS ARE ONE HAYSTACK, AND THAT IS THE WHOLE TICKET RATHER THAN A CONVENIENCE.
    /// The owner's screenshot is a `tap` search returning `Leech` and `Siphon Strength`, and neither
    /// name contains the substring `tap` — they are there because their CATEGORY is `Taps`. A
    /// name-only filter reproduces the screenshot's first row and loses two thirds of its results,
    /// which is exactly the capability being asked for. This is a MEASURED correction: the test that
    /// proves it was written expecting a name-only match and failed against this corpus.
    ///
    /// It is a substring match rather than the typo-tolerant scorer `search.rs` runs over mob names,
    /// because that corpus is proper nouns a player half-remembers and this one is a vocabulary they
    /// are browsing.
    pub text: Option<&'a str>,
    /// An exact category, spelled as [`Found::categories`] spells it. Case-insensitive, so a value
    /// round-tripped through a URL or a stored preference still matches.
    pub category: Option<&'a str>,
    /// An exact subcategory. Independent of `category` — the client table files nine rows under a
    /// subcategory with no category at all, so this is not a refinement of that filter.
    pub subcategory: Option<&'a str>,
    /// The class columns to scope to, or `None` for every class.
    ///
    /// THIS IS THE COMBO, AND IT IS THE CALLER'S TO NAME. The engine could read the attached world's
    /// combo module instead; it deliberately does not, because that would make a question about a
    /// static client file depend on fold state and cost this module its "testable with no fold in
    /// the room" property. `None` is the surface's show-all toggle.
    pub classes: Option<&'a [usize]>,
    pub sort: Sort,
    /// Where the window starts. Past the end is an empty page, never an error — a client holding a
    /// stale offset while a filter narrows under it is ordinary, not exceptional.
    pub offset: usize,
    /// How many rows the window holds. Bounded by the op before it ever reaches here.
    pub limit: usize,
}

/// One class that can cast a spell, and when it learns it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClassLevel {
    /// The class code, spelled as the app spells it (`SHD`, `BRD`, `WIZ`).
    pub class: &'static str,
    /// The level that class learns it at. Always `1..=254` — a zero is not a row.
    pub level: u8,
}

/// One spell, as the surface draws it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row {
    /// The client's own spelling. The log and `spells_us.txt` outrank the wiki on a spell's name.
    pub name: String,
    /// THE LEVEL THE LIST IS SORTED AND FILED BY: the LOWEST level at which any class in scope
    /// learns this — i.e. the earliest a character with this combo could have it.
    ///
    /// The game's own window has no such question to answer because a character there is one class.
    /// A combo of three needs a single number to sort by, and "the first level you could have it" is
    /// the one a player is asking for; `classes` beside it carries the whole truth, so nothing is
    /// hidden by the choice.
    pub level: u8,
    /// Every in-scope class that can cast it, in the client file's column order.
    pub classes: Vec<ClassLevel>,
    /// The Category column's word, absent when the row files itself under none — or when the string
    /// table could not be read.
    pub category: Option<String>,
    /// The Subcategory column's word.
    pub subcategory: Option<String>,
}

/// A category and the subcategories found under it, for a filter control to draw.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Facet {
    pub name: String,
    /// Alphabetical, and only the ones actually present in this scope.
    pub subcategories: Vec<String>,
}

/// What one query answered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    /// The window — already filtered, already sorted.
    pub rows: Vec<Row>,
    /// How many rows MATCHED, before the window. A surface says `1-20 of 143` off this without ever
    /// holding 143, which is the same bargain `knowledge.search`'s `total` strikes.
    pub total: usize,
    /// The category vocabulary present in this scope. See the module header for why the engine has
    /// to supply this rather than the app shipping a list.
    pub categories: Vec<Facet>,
}

/// Can any class at all cast this? A row nobody can learn is a mob's or an item's copy of a spell,
/// and it is excluded from every answer here — the in-game window lists what a PLAYER can have, and
/// a corpus that included NPC copies would answer a question nobody asked.
fn playable(levels: &ClassLevels) -> bool {
    levels.iter().any(|&l| l > 0)
}

/// The in-scope classes that can cast this, and the lowest level among them. `None` when none can,
/// which is what excludes the row.
fn scoped(levels: &ClassLevels, classes: Option<&[usize]>) -> Option<(u8, Vec<ClassLevel>)> {
    let mut out: Vec<ClassLevel> = Vec::new();
    for (i, &level) in levels.iter().enumerate() {
        if level == 0 {
            continue;
        }
        if let Some(scope) = classes {
            if !scope.contains(&i) {
                continue;
            }
        }
        out.push(ClassLevel {
            class: CLASS_ORDER[i],
            level,
        });
    }
    let lowest = out.iter().map(|c| c.level).min()?;
    Some((lowest, out))
}

/// Case-insensitive equality, for a filter value that may have been round-tripped through a store.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.eq_ignore_ascii_case(b)
}

/// Does the spell's name, category or subcategory contain this (already lower-cased) needle?
///
/// See [`Query::text`] for why all three are one haystack. The needle is lower-cased ONCE by the
/// caller rather than per row — this runs 48,000 times per keystroke's worth of question.
fn matches_text(
    name: &str,
    category: Option<&str>,
    subcategory: Option<&str>,
    needle: &str,
) -> bool {
    if needle.is_empty() {
        return true;
    }
    [Some(name), category, subcategory]
        .into_iter()
        .flatten()
        .any(|field| field.to_lowercase().contains(needle))
}

/// The word an id names, or `None` — for an id nothing claims and for an absent string table alike.
fn word(names: &CategoryNames, id: Option<u32>) -> Option<String> {
    names.get(&id?).cloned()
}

/// Search the client's table.
///
/// ## THE ORDER IS TOTAL, ALWAYS (the JOS-478/484 law)
///
/// Every sort ends in the canon KEY, which is unique by construction because it is what the table is
/// keyed by. That last term is not decoration: the corpus is a `HashMap` and its iteration order is
/// deliberately randomised, so a sort that ended at `level` would return the same query's rows in a
/// different order on every call — the shuffled-window defect the law was written for, in its purest
/// possible form. `level desc` alone would also file every spell learned at the same level in an
/// arbitrary order, and a combo learns a great many spells at the same level.
///
/// ## THE FACETS IGNORE THE FILTER THEY DESCRIBE
///
/// `categories` is computed over the class and text scope but NOT over `category`/`subcategory`.
/// Selecting `Taps` must not collapse the filter control to a list containing only `Taps` — that is
/// a control a user cannot get back out of. It is the standard faceting rule and it is stated here
/// because getting it wrong produces a dead end rather than an error.
#[must_use]
pub fn search(table: &SpellTable, names: &CategoryNames, query: &Query) -> Found {
    // (sort key, row) for everything that matched; the key rides along so the sort never re-derives.
    let mut matched: Vec<(u8, &str, Row)> = Vec::new();
    // The facet accumulator: category -> its subcategories. `BTreeMap`/`BTreeSet` rather than hash
    // sets because the output is alphabetical and sorting at the end would be a second pass over
    // data this already holds in order.
    let mut facets: BTreeMap<String, std::collections::BTreeSet<String>> = BTreeMap::new();
    // Lower-cased ONCE. The corpus is ~48,000 rows and this is the inner loop of a search box.
    let needle = query.text.map(str::to_lowercase);

    for (key, info) in table {
        if !playable(&info.class_levels) {
            continue;
        }
        let Some((level, classes)) = scoped(&info.class_levels, query.classes) else {
            continue;
        };
        // THE WORDS ARE RESOLVED BEFORE THE TEXT FILTER because the text filter reads them — see
        // [`Query::text`]. A `tap` search finds `Leech` through its category, never through its name.
        let category = word(names, info.category);
        let subcategory = word(names, info.subcategory);
        if let Some(needle) = needle.as_deref() {
            if !matches_text(
                &info.name,
                category.as_deref(),
                subcategory.as_deref(),
                needle,
            ) {
                continue;
            }
        }

        // THE FACETS ARE ACCUMULATED HERE — after the class and text scope, BEFORE the category
        // filter. See the doc comment.
        if let Some(cat) = category.as_deref() {
            let entry = facets.entry(cat.to_owned()).or_default();
            if let Some(sub) = subcategory.as_deref() {
                entry.insert(sub.to_owned());
            }
        }

        if let Some(want) = query.category {
            if !category.as_deref().is_some_and(|c| same(c, want)) {
                continue;
            }
        }
        if let Some(want) = query.subcategory {
            if !subcategory.as_deref().is_some_and(|s| same(s, want)) {
                continue;
            }
        }

        matched.push((
            level,
            key.as_str(),
            Row {
                name: info.name.clone(),
                level,
                classes,
                category,
                subcategory,
            },
        ));
    }

    match query.sort {
        // Level DESCENDING, then the key ascending — the in-game window's order, made total.
        Sort::Level => matched.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(b.1))),
        // Alphabetical by the NAME a reader sees, then by key. The name is not guaranteed unique
        // across keys the way the key is, so the second term is load-bearing here too.
        Sort::Name => matched.sort_by(|a, b| {
            a.2.name
                .to_lowercase()
                .cmp(&b.2.name.to_lowercase())
                .then_with(|| a.1.cmp(b.1))
        }),
    }

    let total = matched.len();
    let rows = matched
        .into_iter()
        .skip(query.offset)
        .take(query.limit)
        .map(|(_, _, row)| row)
        .collect();

    Found {
        rows,
        total,
        categories: facets
            .into_iter()
            .map(|(name, subs)| Facet {
                name,
                subcategories: subs.into_iter().collect(),
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fold::spells_us::parse_spells_us;

    const F_ID: usize = 0;
    const F_NAME: usize = 1;
    const F_CLASS_FIRST: usize = 36;
    const F_CATEGORY: usize = 86;
    const F_SUBCATEGORY: usize = 87;

    /// HAND-AUTHORED ROWS ONLY — the client table is Daybreak's file and no slice of it may enter
    /// this repo. The ids and words below are the ones the owner's install carries, transcribed.
    fn row(fields: &[(usize, &str)]) -> String {
        let mut f = vec!["0".to_string(); 173];
        for i in 0..16 {
            f[F_CLASS_FIRST + i] = "255".to_string();
        }
        for (i, v) in fields {
            f[*i] = (*v).to_string();
        }
        f.join("^")
    }

    /// SHD 4, BRD 7, WIZ 11 — the combo from the owner's screenshot.
    fn shd() -> usize {
        4
    }
    fn brd() -> usize {
        7
    }
    fn wiz() -> usize {
        11
    }

    /// A small table shaped like the corner of the real one the screenshot shows.
    fn corpus() -> (SpellTable, CategoryNames) {
        let table = parse_spells_us(
            &[
                // Taps / Health, SHD 1 and NEC 1.
                row(&[
                    (F_ID, "341"),
                    (F_NAME, "Lifetap"),
                    (F_CATEGORY, "114"),
                    (F_SUBCATEGORY, "43"),
                    (F_CLASS_FIRST + 4, "1"),
                    (F_CLASS_FIRST + 10, "1"),
                ]),
                // Taps / Power Tap, SHD 34.
                row(&[
                    (F_ID, "343"),
                    (F_NAME, "Siphon Strength"),
                    (F_CATEGORY, "114"),
                    (F_SUBCATEGORY, "76"),
                    (F_CLASS_FIRST + 4, "34"),
                ]),
                // Taps / Duration Tap, SHD 49.
                row(&[
                    (F_ID, "500"),
                    (F_NAME, "Leech"),
                    (F_CATEGORY, "114"),
                    (F_SUBCATEGORY, "33"),
                    (F_CLASS_FIRST + 4, "49"),
                ]),
                // Direct Damage, WIZ 29 — matches `tap` on NEITHER name nor category.
                row(&[
                    (F_ID, "600"),
                    (F_NAME, "Lightning Bolt"),
                    (F_CATEGORY, "25"),
                    (F_CLASS_FIRST + 11, "29"),
                ]),
                // A CLERIC tap — in the Taps category, but outside the screenshot's combo.
                row(&[
                    (F_ID, "700"),
                    (F_NAME, "Divine Tap"),
                    (F_CATEGORY, "114"),
                    (F_SUBCATEGORY, "43"),
                    (F_CLASS_FIRST + 1, "20"),
                ]),
                // A MOB's copy: no class can cast it, so it is in no answer.
                row(&[
                    (F_ID, "6850"),
                    (F_NAME, "Unholy Tap"),
                    (F_CATEGORY, "114"),
                    (F_SUBCATEGORY, "43"),
                ]),
            ]
            .join("\n"),
        );
        let names: CategoryNames = [
            (114, "Taps"),
            (43, "Health"),
            (33, "Duration Tap"),
            (76, "Power Tap"),
            (25, "Direct Damage"),
        ]
        .into_iter()
        .map(|(id, n)| (id, n.to_string()))
        .collect();
        (table, names)
    }

    fn names_of(found: &Found) -> Vec<&str> {
        found.rows.iter().map(|r| r.name.as_str()).collect()
    }

    fn q<'a>() -> Query<'a> {
        Query {
            limit: 50,
            ..Query::default()
        }
    }

    /// THE OWNER'S SCREENSHOT, REPRODUCED: a `tap` search over SHD/BRD/WIZ returns every tap by
    /// level, with the Category and Subcategory the game prints.
    #[test]
    fn the_owners_tap_search_over_the_screenshots_combo() {
        let (table, names) = corpus();
        let scope = [shd(), brd(), wiz()];
        let found = search(
            &table,
            &names,
            &Query {
                text: Some("tap"),
                classes: Some(&scope),
                ..q()
            },
        );
        // Level DESCENDING, the game's own order. `Divine Tap` is a cleric's and out of scope;
        // `Unholy Tap` is a mob's copy and in no answer at all.
        assert_eq!(names_of(&found), ["Leech", "Siphon Strength", "Lifetap"]);
        // THE POINT OF THE WHOLE TICKET, PINNED: two of those three names do not contain the
        // substring `tap` at all. They are in the list because their CATEGORY is `Taps` — which is
        // what "search by TYPE" means, and what a name-only filter silently loses. This assertion
        // is the one that failed when this module was first written the obvious way.
        for found_by_type in ["Leech", "Siphon Strength"] {
            assert!(
                !found_by_type.to_lowercase().contains("tap"),
                "{found_by_type} is a type match, not a name match"
            );
        }
        assert_eq!(found.total, 3);
        let leech = &found.rows[0];
        assert_eq!(leech.level, 49);
        assert_eq!(leech.category.as_deref(), Some("Taps"));
        assert_eq!(leech.subcategory.as_deref(), Some("Duration Tap"));
        assert_eq!(
            leech.classes,
            [ClassLevel {
                class: "SHD",
                level: 49
            }]
        );
        // …and the three subcategories the screenshot shows, under the one category.
        assert_eq!(found.categories.len(), 1);
        assert_eq!(found.categories[0].name, "Taps");
        assert_eq!(
            found.categories[0].subcategories,
            ["Duration Tap", "Health", "Power Tap"]
        );
    }

    /// `Lifetap` matched a `tap` search on its NAME. This is the other half of the ticket: the same
    /// list reachable by TYPE, with no text at all.
    #[test]
    fn a_category_filter_needs_no_text_at_all() {
        let (table, names) = corpus();
        let scope = [shd(), brd(), wiz()];
        let found = search(
            &table,
            &names,
            &Query {
                category: Some("Taps"),
                classes: Some(&scope),
                ..q()
            },
        );
        assert_eq!(names_of(&found), ["Leech", "Siphon Strength", "Lifetap"]);
        // …and a subcategory narrows it to one.
        let health = search(
            &table,
            &names,
            &Query {
                category: Some("Taps"),
                subcategory: Some("Health"),
                classes: Some(&scope),
                ..q()
            },
        );
        assert_eq!(names_of(&health), ["Lifetap"]);
        // The filter value is case-insensitive, so a stored preference still matches.
        let lowered = search(
            &table,
            &names,
            &Query {
                category: Some("taps"),
                classes: Some(&scope),
                ..q()
            },
        );
        assert_eq!(lowered.total, 3);
    }

    /// THE SHOW-ALL TOGGLE. Dropping the class scope brings the cleric's tap in — and never the
    /// mob's copy, which no class can cast.
    #[test]
    fn no_class_scope_is_every_class_but_still_never_an_npc_copy() {
        let (table, names) = corpus();
        let found = search(
            &table,
            &names,
            &Query {
                category: Some("Taps"),
                ..q()
            },
        );
        assert_eq!(
            names_of(&found),
            ["Leech", "Siphon Strength", "Divine Tap", "Lifetap"]
        );
        assert!(
            !names_of(&found).contains(&"Unholy Tap"),
            "a row no class can cast is a mob's copy and is in no answer"
        );
    }

    /// The facets describe the CLASS AND TEXT scope, never the category filter they populate — a
    /// control that collapsed to the value you just picked is one you cannot get back out of.
    #[test]
    fn the_facets_ignore_the_category_filter_they_describe() {
        let (table, names) = corpus();
        let picked = search(
            &table,
            &names,
            &Query {
                category: Some("Taps"),
                ..q()
            },
        );
        let facets: Vec<&str> = picked.categories.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(
            facets,
            ["Direct Damage", "Taps"],
            "picking Taps must not hide Direct Damage from the control"
        );
        // …but they DO describe the class scope, which is a filter the control does not own.
        let scope = [wiz()];
        let wizard = search(
            &table,
            &names,
            &Query {
                classes: Some(&scope),
                ..q()
            },
        );
        assert_eq!(
            wizard
                .categories
                .iter()
                .map(|f| f.name.as_str())
                .collect::<Vec<_>>(),
            ["Direct Damage"],
            "a wizard-only scope has no taps in it"
        );
    }

    /// THE ORDER IS TOTAL. The corpus is a `HashMap` with randomised iteration, so a sort that
    /// stopped at `level` would answer the same query differently on every call.
    #[test]
    fn the_order_is_stable_across_calls_and_ties_break_by_key() {
        let (table, names) = corpus();
        // Three spells a SHD learns, two of them at the SAME level — the tie the key settles.
        let table = {
            let mut t = table;
            let extra = parse_spells_us(&row(&[
                (F_ID, "800"),
                (F_NAME, "Aardvark Tap"),
                (F_CATEGORY, "114"),
                (F_SUBCATEGORY, "43"),
                (F_CLASS_FIRST + 4, "49"),
            ]));
            t.extend(extra);
            t
        };
        let scope = [shd()];
        let first = search(
            &table,
            &names,
            &Query {
                text: Some("tap"),
                classes: Some(&scope),
                ..q()
            },
        );
        // `Aardvark Tap` and `Leech` are both level 49; `aardvark tap` sorts before `leech`.
        assert_eq!(
            names_of(&first),
            ["Aardvark Tap", "Leech", "Siphon Strength", "Lifetap"]
        );
        for _ in 0..8 {
            let again = search(
                &table,
                &names,
                &Query {
                    text: Some("tap"),
                    classes: Some(&scope),
                    ..q()
                },
            );
            assert_eq!(names_of(&again), names_of(&first), "the order is total");
        }
    }

    #[test]
    fn sorting_by_name_is_alphabetical_and_also_total() {
        let (table, names) = corpus();
        let found = search(
            &table,
            &names,
            &Query {
                category: Some("Taps"),
                sort: Sort::Name,
                ..q()
            },
        );
        assert_eq!(
            names_of(&found),
            ["Divine Tap", "Leech", "Lifetap", "Siphon Strength"]
        );
    }

    /// The window is a window: `total` counts what MATCHED, not what was returned.
    #[test]
    fn the_window_reports_the_whole_match_count_behind_it() {
        let (table, names) = corpus();
        let page = search(
            &table,
            &names,
            &Query {
                category: Some("Taps"),
                offset: 1,
                limit: 2,
                ..Query::default()
            },
        );
        assert_eq!(names_of(&page), ["Siphon Strength", "Divine Tap"]);
        assert_eq!(page.total, 4, "a surface says 2-3 of 4 off this");
        // PAST THE END IS AN EMPTY PAGE, never an error: a client holding a stale offset while a
        // filter narrows under it is ordinary rather than exceptional.
        let past = search(
            &table,
            &names,
            &Query {
                category: Some("Taps"),
                offset: 99,
                limit: 20,
                ..Query::default()
            },
        );
        assert!(past.rows.is_empty());
        assert_eq!(past.total, 4, "…and it still says how many there were");
    }

    /// A spell several in-scope classes learn reports the LOWEST level and names them all.
    #[test]
    fn a_multi_class_row_files_under_the_earliest_level_it_could_be_had() {
        let table = parse_spells_us(&row(&[
            (F_ID, "1"),
            (F_NAME, "Shared Spell"),
            (F_CLASS_FIRST + 4, "40"),
            (F_CLASS_FIRST + 11, "22"),
        ]));
        let scope = [shd(), wiz()];
        let found = search(
            &table,
            &CategoryNames::new(),
            &Query {
                classes: Some(&scope),
                ..q()
            },
        );
        assert_eq!(found.rows[0].level, 22, "the earliest you could have it");
        assert_eq!(
            found.rows[0].classes,
            [
                ClassLevel {
                    class: "SHD",
                    level: 40
                },
                ClassLevel {
                    class: "WIZ",
                    level: 22
                }
            ],
            "…and the whole truth rides beside it, in the file's column order"
        );
        // SCOPED TO ONE CLASS, the same row reports THAT class's level and only that class.
        let one = [shd()];
        let shd_only = search(
            &table,
            &CategoryNames::new(),
            &Query {
                classes: Some(&one),
                ..q()
            },
        );
        assert_eq!(shd_only.rows[0].level, 40);
        assert_eq!(shd_only.rows[0].classes.len(), 1);
    }

    /// AN UNREADABLE STRING TABLE IS A DEGRADED LIST, NOT AN OUTAGE — the rows are still there, with
    /// no words on them, and there are no facets for a control to draw.
    #[test]
    fn with_no_string_table_the_rows_survive_without_their_words() {
        let (table, _) = corpus();
        let found = search(
            &table,
            &CategoryNames::new(),
            &Query {
                text: Some("tap"),
                ..q()
            },
        );
        assert!(!found.rows.is_empty(), "the spells are still found by name");
        assert!(found.rows.iter().all(|r| r.category.is_none()));
        assert!(found.categories.is_empty());
        // …and a category filter therefore matches nothing, rather than everything.
        let filtered = search(
            &table,
            &CategoryNames::new(),
            &Query {
                category: Some("Taps"),
                ..q()
            },
        );
        assert!(filtered.rows.is_empty());
    }

    #[test]
    fn an_empty_text_filter_filters_nothing() {
        let (table, names) = corpus();
        let found = search(
            &table,
            &names,
            &Query {
                text: Some(""),
                ..q()
            },
        );
        assert_eq!(found.total, 5, "every playable row in the corpus");
    }
}
