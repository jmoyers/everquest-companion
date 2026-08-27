//! THE CLIENT'S STRING TABLE, PARSED — the half of `spells_us.txt` that is not in `spells_us.txt`
//! (JOS-507).
//!
//! PURE OVER A STRING, exactly as [`crate::spells_us`] is: no file, no thread, no state. The FORMAT
//! is fold vocabulary and the IO belongs to whoever owns a directory (`engined::spells`) — the same
//! split `overlay_file.rs` and `modules/resist/ledger_file.rs` make, and for the same reason.
//!
//! ── WHY THIS FILE EXISTS AT ALL ────────────────────────────────────────────────────────────────
//!
//! `spells_us.txt` stores a spell's category and subcategory as INTEGER IDS and nothing else — field
//! 86 of Lifetap's row is `114`, not `Taps`. The words the game prints live one file over, in
//! `<eqRoot>/dbstr_us.txt`, which is the client's general-purpose string table: every row is
//! `id^type^string^flag^`, and `type` partitions it into unrelated namespaces (races, tooltips,
//! achievements, …). TYPE 5 IS THE SPELL-CATEGORY NAMESPACE, and it is small and closed: 179 rows on
//! the owner's install, ids 1..=179, no duplicates, no caret and no carriage return inside any name.
//!
//! THE MAPPING IS THEREFORE DERIVABLE FROM THE PLAYER'S OWN FILES, which is the finding that let
//! JOS-507 proceed rather than stop for a design call. Both files sit in the same install directory,
//! both are read at runtime from the player's own copy, and NEITHER IS EVER REDISTRIBUTED — the same
//! rule `spells_us.rs` states, for the same reason, which is why every test below is driven by
//! hand-authored rows.
//!
//! ── VERIFIED, NOT ASSUMED (integrator measurement against the owner's install, 2026-08-26) ──────
//!
//! Field 86 is the category and field 87 the subcategory, and the evidence is the owner's own
//! screenshot vocabulary reproduced exactly: `Lifetap` reads `86 = 114, 87 = 43`, which this table
//! names `Taps` and `Health`; `Siphon Strength` reads `87 = 76`, which is `Power Tap`; and the
//! subcategories under `Taps` across the whole file are `Health`, `Duration Tap`, `Power Tap`,
//! `Health/Mana` and `Create Item` — the first three being the three the screenshot shows. Field 86
//! carries 64 distinct ids and field 87 carries 162, and EVERY ONE OF THEM IS NAMED BY THIS TABLE:
//! there is no id in either column that type 5 cannot spell, so a reader never has to invent a word.
//!
//! ── AND THIS IS NOT A PORT, WHICH IS WHY IT IS NOT WRITTEN IN JAVASCRIPT ARITHMETIC ─────────────
//!
//! [`crate::spells_us`] goes through [`crate::spells_us::js_number`] for every scalar because it is a
//! port of a shipped TypeScript parser and must agree with it on inputs the file really contains. No
//! TypeScript ever read `dbstr_us.txt`, so there is no second implementation to agree with and no
//! shipped behaviour to reproduce. This file therefore parses in ordinary Rust and says so, rather
//! than borrowing an idiom whose whole justification is a compatibility claim it cannot make.

use std::collections::HashMap;

/// The `type` column that partitions `dbstr_us.txt` into namespaces. Type 5 is the spell-category
/// vocabulary — the words the in-game Actions/Spells window prints in its Category and Subcategory
/// columns.
const SPELL_CATEGORY_TYPE: &str = "5";

/// The narrowest row this parser will read: `id^type^string`. Real rows carry five fields (a trailing
/// flag and an empty tail), but nothing below reads past the third, so the bound is stated where the
/// need is rather than at the file's observed width — a client patch that appends a sixth column must
/// not empty this table.
const MIN_FIELDS: usize = 3;

/// Category id → the word the game prints for it.
pub type CategoryNames = HashMap<u32, String>;

/// Parse `dbstr_us.txt`, keeping only the spell-category namespace.
///
/// ── THE FILTERS, IN ORDER ──────────────────────────────────────────────────────────────────────
///
///   * a trailing `\r` is stripped from the LINE. On the owner's install it lands on the fifth field
///     and could never reach a name, so this is a cheap defence rather than a fix for an observed
///     defect — but a client patch that drops the trailing columns would put the carriage return on
///     the name itself, and a name is a display string and a join key.
///   * an empty line is skipped.
///   * fewer than [`MIN_FIELDS`] fields is skipped — there is no id, type and string to read.
///   * a `type` that is not [`SPELL_CATEGORY_TYPE`] is skipped. This is the whole reason the table is
///     9.4 MB and this map has 179 entries in it.
///   * an id that is not a `u32` is skipped rather than guessed at, and so is an EMPTY name: a
///     category whose word is the empty string would render as a blank column that reads as a bug.
///
/// FIRST-WINS on a repeated id, which is the same direction [`crate::spells_us::parse_spells_us`]
/// resolves its own key contests. Measured: the owner's install has no duplicate id within type 5 at
/// all, so the rule decides nothing today and exists so that a patch which introduces one produces a
/// stable answer instead of a build-order-dependent one.
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

    /// HAND-AUTHORED ROWS, and that is a rule rather than a convenience: `dbstr_us.txt` is
    /// Daybreak's file and no slice of it may enter this repo. The ids and words below are the ones
    /// the owner's install carries for the categories the JOS-507 screenshot shows, transcribed.
    fn row(id: &str, ty: &str, text: &str) -> String {
        format!("{id}^{ty}^{text}^0^")
    }

    #[test]
    fn the_three_words_the_owners_screenshot_shows_are_read() {
        // `Taps` / `Health` / `Duration Tap` / `Power Tap` is the in-game vocabulary this ticket was
        // verified against, and these are the ids that carry it.
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
        // THE WHOLE REASON THIS IS A FILTER AND NOT A MAP. The real file is 9.4 MB and 72,927 rows,
        // of which 179 are type 5; a parser that kept the rest would hold tooltips, race names and
        // achievement text in memory forever to answer a question about spell categories.
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
        // AN EMPTY NAME IS REFUSED TOO: it would render as a blank Category column, which reads to a
        // player as a defect rather than as the absence it is.
        assert_eq!(names.len(), 1);
        assert_eq!(names[&114], "Taps");
    }

    #[test]
    fn a_crlf_file_does_not_carry_the_carriage_return_into_a_name() {
        // On the owner's install the `\r` lands on the trailing flag column and never reaches a
        // name. This pins the defence anyway, over the shape a patch dropping those columns would
        // produce — because a name here is both a display string and a join key.
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
