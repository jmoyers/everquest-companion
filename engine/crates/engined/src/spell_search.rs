//! Searching the client's spell table by TYPE, the way the in-game Actions/Spells window does:
//! `spells_us.txt` files each spell under two integer ids and `dbstr_us.txt` says what those ids are
//! called, so the app can offer the same capability without inventing a vocabulary.
//!
//! The query lives here and not in `fold`: `fold::spells_us` and `fold::dbstr` own the two formats,
//! `engined::spells` owns the two files, and this module owns the question. Nothing here touches
//! fold state in either direction, so the equivalence oracle is untouched by any of it.
//!
//! The parsed table is never served in one reply, so this is a filtered, sorted, windowed question
//! with the window bounded at the op. The corpus is scanned linearly per call — the whole table is
//! already in this process's memory, and an index would be complexity bought with nothing.
//!
//! The renderer re-derives none of it: rows arrive filtered, sorted and windowed with their category
//! and subcategory spelled as words rather than ids. [`Found::categories`] exists for the same
//! reason — the category vocabulary lives only in the player's install, so the app cannot ship a
//! hardcoded list to populate a filter control with.

use fold::dbstr::CategoryNames;
use fold::spells_us::{ClassLevels, SpellTable, CLASS_ORDER};
use std::collections::BTreeMap;

/// How the caller wants the list ordered.
///
/// Two members and no more: an unknown sort is `badParams` by the schema's enum rather than by a
/// check here, which satisfies "never accept-and-ignore" structurally.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Sort {
    /// Level descending — the in-game window's own order, and the default for that reason.
    #[default]
    Level,
    /// Alphabetical, for a reader looking for a name rather than for what is newest.
    Name,
}

/// One question about the client's table. Every filter is AND-ed, and an absent one filters nothing.
#[derive(Debug, Default)]
pub struct Query<'a> {
    /// A case-insensitive substring of the spell's name, its category or its subcategory.
    ///
    /// The three fields are one haystack, and that is the capability rather than a convenience: a
    /// `tap` search returns `Leech` and `Siphon Strength`, whose names contain no `tap` — they are
    /// there because their category is `Taps`.
    ///
    /// A substring match rather than the typo-tolerant scorer `search.rs` runs over mob names,
    /// because that corpus is proper nouns a player half-remembers and this one is a vocabulary
    /// they are browsing.
    pub text: Option<&'a str>,
    /// An exact category, spelled as [`Found::categories`] spells it. Case-insensitive, so a value
    /// round-tripped through a URL or a stored preference still matches.
    pub category: Option<&'a str>,
    /// An exact subcategory. Independent of `category` — the client table files nine rows under a
    /// subcategory with no category at all, so this is not a refinement of that filter.
    pub subcategory: Option<&'a str>,
    /// The class columns to scope to, or `None` for every class.
    ///
    /// This is the combo, and it is the caller's to name rather than read off the attached world's
    /// combo module: that would make a question about a static client file depend on fold state.
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
    /// The level the list is sorted and filed by: the lowest level at which any class in scope
    /// learns this — the earliest a character with this combo could have it. `classes` beside it
    /// carries the whole truth, so nothing is hidden by the choice.
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
    /// How many rows matched, before the window. A surface says `1-20 of 143` off this without ever
    /// holding 143.
    pub total: usize,
    /// The category vocabulary present in this scope. See the module header for why the engine has
    /// to supply this rather than the app shipping a list.
    pub categories: Vec<Facet>,
}

/// Can any class at all cast this? A row nobody can learn is a mob's or an item's copy of a spell,
/// and it is excluded from every answer here: the in-game window lists what a player can have.
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
/// See [`Query::text`] for why all three are one haystack. The needle is lower-cased once by the
/// caller rather than per row — this runs ~48,000 times per keystroke's worth of question.
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
/// The order is total: every sort ends in the canon key, which is unique because it is what the
/// table is keyed by. That term is load-bearing — the corpus is a `HashMap` with randomised
/// iteration, so a sort ending at `level` would order the same query's rows differently every call.
///
/// The facets ignore the filter they describe: `categories` is computed over the class and text
/// scope but not over `category`/`subcategory`, because a control that collapsed to the value you
/// just picked is one you cannot get back out of.
#[must_use]
pub fn search(table: &SpellTable, names: &CategoryNames, query: &Query) -> Found {
    // (sort key, row) for everything that matched; the key rides along so the sort never re-derives.
    let mut matched: Vec<(u8, &str, Row)> = Vec::new();
    // The facet accumulator: category -> its subcategories. `BTreeMap`/`BTreeSet` rather than hash
    // sets because the output is alphabetical and sorting at the end would be a second pass over
    // data this already holds in order.
    let mut facets: BTreeMap<String, std::collections::BTreeSet<String>> = BTreeMap::new();
    // Lower-cased once: the corpus is ~48,000 rows and this is the inner loop of a search box.
    let needle = query.text.map(str::to_lowercase);

    for (key, info) in table {
        if !playable(&info.class_levels) {
            continue;
        }
        let Some((level, classes)) = scoped(&info.class_levels, query.classes) else {
            continue;
        };
        // The words are resolved before the text filter because the text filter reads them: a `tap`
        // search finds `Leech` through its category, never through its name.
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

        // The facets are accumulated after the class and text scope and BEFORE the category filter.
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
        // Level descending, then the key ascending — the in-game window's order, made total.
        Sort::Level => matched.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(b.1))),
        // Alphabetical by the name a reader sees, then by key: names are not unique across keys, so
        // the second term is load-bearing here too.
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

    /// Hand-authored rows only — the client table is Daybreak's file and no slice of it may enter
    /// this repo. The ids and words below are transcribed from a real install.
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

    /// The class column indexes: SHD 4, BRD 7, WIZ 11.
    fn shd() -> usize {
        4
    }
    fn brd() -> usize {
        7
    }
    fn wiz() -> usize {
        11
    }

    /// A small table shaped like a corner of the real one.
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
                // Direct Damage, WIZ 29 — matches `tap` on neither name nor category.
                row(&[
                    (F_ID, "600"),
                    (F_NAME, "Lightning Bolt"),
                    (F_CATEGORY, "25"),
                    (F_CLASS_FIRST + 11, "29"),
                ]),
                // A cleric tap — in the Taps category, but outside the SHD/BRD/WIZ combo.
                row(&[
                    (F_ID, "700"),
                    (F_NAME, "Divine Tap"),
                    (F_CATEGORY, "114"),
                    (F_SUBCATEGORY, "43"),
                    (F_CLASS_FIRST + 1, "20"),
                ]),
                // A mob's copy: no class can cast it, so it is in no answer.
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

    /// A `tap` search over SHD/BRD/WIZ returns every tap by level, with the Category and
    /// Subcategory the game prints.
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
        // Level descending, the game's own order. `Divine Tap` is a cleric's and out of scope;
        // `Unholy Tap` is a mob's copy and in no answer at all.
        assert_eq!(names_of(&found), ["Leech", "Siphon Strength", "Lifetap"]);
        // Two of those three names do not contain the substring `tap` at all. They are in the list
        // because their category is `Taps`, which is what "search by type" means and what a
        // name-only filter silently loses.
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
        // …and the three subcategories present, under the one category.
        assert_eq!(found.categories.len(), 1);
        assert_eq!(found.categories[0].name, "Taps");
        assert_eq!(
            found.categories[0].subcategories,
            ["Duration Tap", "Health", "Power Tap"]
        );
    }

    /// The same list is reachable by type, with no text at all.
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

    /// The show-all toggle: dropping the class scope brings the cleric's tap in, and never the
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

    /// The facets describe the class and text scope, never the category filter they populate — a
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
        // …but they do describe the class scope, which is a filter the control does not own.
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

    /// The order is total. The corpus is a `HashMap` with randomised iteration, so a sort that
    /// stopped at `level` would answer the same query differently on every call.
    #[test]
    fn the_order_is_stable_across_calls_and_ties_break_by_key() {
        let (table, names) = corpus();
        // Two of these are at the same level — the tie the key settles.
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

    /// `total` counts what matched, not what was returned.
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
        // Past the end is an empty page, never an error: a client holding a stale offset while a
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

    /// A spell several in-scope classes learn reports the lowest level and names them all.
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
        // Scoped to one class, the same row reports that class's level and only that class.
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

    /// An unreadable string table is a degraded list, not an outage: the rows are still there with
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
