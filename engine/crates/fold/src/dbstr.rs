//! The client's string table (`<eqRoot>/dbstr_us.txt`), parsed — the words behind the category ids
//! `spells_us.txt` stores.
//!
//! Pure over a string, exactly as [`crate::spells_us`] is: no file, no thread, no state. The format
//! is fold vocabulary; the IO belongs to whoever owns the directory (`engined::spells`).
//!
//! `spells_us.txt` stores a spell's category and subcategory as integer ids only — field 86 is the
//! category and field 87 the subcategory. Every `dbstr_us.txt` row is `id^type^string^flag^`, and
//! `type` partitions the file into unrelated namespaces (races, tooltips, achievements, …). Type 5
//! is the spell-category namespace: small and closed, 179 rows on a current install, ids 1..=179,
//! no duplicates, and no caret or carriage return inside a name. Every id appearing in field 86 or
//! 87 is named by type 5, so a reader never has to invent a word.
//!
//! Both files are read at runtime from the player's own install and neither is ever redistributed,
//! which is why every test below is driven by hand-authored rows.
//!
//! Unlike [`crate::spells_us`] this is not a port of a shipped TypeScript parser, so it parses in
//! ordinary Rust rather than through `js_number`: there is no second implementation to agree with.

use std::collections::HashMap;

/// The `type` column that partitions `dbstr_us.txt` into namespaces. Type 5 is the spell-category
/// vocabulary — the words the in-game Actions/Spells window prints in its Category and Subcategory
/// columns.
const SPELL_CATEGORY_TYPE: &str = "5";

/// The narrowest row this parser will read: `id^type^string`. Real rows carry five fields, but
/// nothing reads past the third, so the bound is stated at the need rather than at the file's
/// observed width — a client patch that appends a column must not empty this table.
const MIN_FIELDS: usize = 3;

/// Category id → the word the game prints for it.
pub type CategoryNames = HashMap<u32, String>;

/// Parse `dbstr_us.txt`, keeping only the spell-category namespace.
///
/// The filters, in order: a trailing `\r` is stripped from the line (it lands on the last column
/// today, but a name is both a display string and a join key); an empty line, a row with fewer than
/// [`MIN_FIELDS`] fields, a `type` other than [`SPELL_CATEGORY_TYPE`], a non-`u32` id and an empty
/// name are all skipped rather than guessed at. Filtering by type is why a 9.4 MB table becomes a
/// map of 179 entries.
///
/// First-wins on a repeated id, matching [`crate::spells_us::parse_spells_us`]. No install carries
/// a duplicate today; the rule exists so that a patch introducing one gives a stable answer rather
/// than a build-order-dependent one.
#[must_use]
pub fn parse_spell_categories(text: &str) -> CategoryNames {
    let mut out: CategoryNames = HashMap::new();
    for line in text.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.is_empty() {
            continue;
        }
        let f: Vec<&str> = line.split('^').collect();
        if f.len() < MIN_FIELDS {
            continue;
        }
        if f[1] != SPELL_CATEGORY_TYPE {
            continue;
        }
        let Ok(id) = f[0].parse::<u32>() else {
            continue;
        };
        if f[2].is_empty() {
            continue;
        }
        out.entry(id).or_insert_with(|| f[2].to_owned());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Hand-authored rows, and that is a rule: `dbstr_us.txt` is Daybreak's file and no slice of it
    /// may enter this repo. The ids and words below are transcribed from a real install.
    fn row(id: &str, ty: &str, text: &str) -> String {
        format!("{id}^{ty}^{text}^0^")
    }

    #[test]
    fn the_three_words_the_owners_screenshot_shows_are_read() {
        // The in-game vocabulary this was verified against, and the ids that carry it.
        let text = [
            row("114", "5", "Taps"),
            row("43", "5", "Health"),
            row("33", "5", "Duration Tap"),
            row("76", "5", "Power Tap"),
        ]
        .join("\n");
        let names = parse_spell_categories(&text);
        assert_eq!(names.len(), 4);
        assert_eq!(names[&114], "Taps");
        assert_eq!(names[&43], "Health");
        assert_eq!(names[&33], "Duration Tap");
        assert_eq!(names[&76], "Power Tap");
    }

    #[test]
    fn every_other_namespace_is_dropped() {
        // Why this is a filter and not a map: the real file is 9.4 MB and 72,927 rows, of which 179
        // are type 5. Keeping the rest would hold tooltips, race names and achievement text in
        // memory forever to answer a question about spell categories.
        let text = [
            row("114", "5", "Taps"),
            row("114", "6", "A tooltip that happens to share an id"),
            row("11", "10", "UNKNOWN RACE"),
        ]
        .join("\n");
        let names = parse_spell_categories(&text);
        assert_eq!(names.len(), 1, "only the spell-category namespace survives");
        assert_eq!(names[&114], "Taps");
    }

    #[test]
    fn a_malformed_row_is_skipped_rather_than_guessed_at() {
        let text = [
            row("", "5", "No Id"),
            row("abc", "5", "Not A Number"),
            row("7", "5", ""),
            "7^5".to_string(),
            String::new(),
            row("114", "5", "Taps"),
        ]
        .join("\n");
        let names = parse_spell_categories(&text);
        // An empty name is refused too: it renders as a blank Category column, which reads to a
        // player as a defect rather than as the absence it is.
        assert_eq!(names.len(), 1);
        assert_eq!(names[&114], "Taps");
    }

    #[test]
    fn a_crlf_file_does_not_carry_the_carriage_return_into_a_name() {
        // Today the `\r` lands on the trailing flag column and never reaches a name; this pins the
        // defence over the shape a patch dropping those columns would produce.
        let names = parse_spell_categories("114^5^Taps\r\n43^5^Health\r\n");
        assert_eq!(names[&114], "Taps");
        assert_eq!(names[&43], "Health");
        // …and the same row with the columns the real file has, where the CR was never a hazard.
        let padded = parse_spell_categories("114^5^Taps^0^\r\n");
        assert_eq!(padded[&114], "Taps");
    }

    #[test]
    fn a_repeated_id_keeps_the_first_word() {
        let text = [row("114", "5", "Taps"), row("114", "5", "Something Else")].join("\n");
        assert_eq!(parse_spell_categories(&text)[&114], "Taps");
    }

    #[test]
    fn an_empty_table_is_an_empty_map_and_not_a_panic() {
        assert!(parse_spell_categories("").is_empty());
        assert!(parse_spell_categories("\n\n\n").is_empty());
    }
}
