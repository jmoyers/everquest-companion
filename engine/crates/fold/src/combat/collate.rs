//! `String.prototype.localeCompare` FOR THE COMBAT VIEWS — the name tiebreak a dozen ranked lists in
//! this directory reach for.
//!
//! ── WHY THIS IS NOT `modules::buff_landing::compare_names` ────────────────────────────────────
//!
//! That one exists for SPELL NAMES and states plainly that it IGNORES the "variable" characters — the
//! spaces, apostrophes and backticks — comparing only letters and digits. For a catalog of spell names
//! that never disagreed with ICU, and it is green on all six slices where it is used.
//!
//! It is WRONG HERE, and a golden proved it: the `hate-pets` enemy-healer list ranks `a willowisp`
//! against `Asaka L\`Rei` on equal totals and equal counts, so the name decides. Ignoring the space
//! compares `awillowisp` against `asakalrei` and puts Asaka first; ICU compares the SPACE against `s`
//! and puts the willowisp first, which is what the golden carries. CLDR's root collation is
//! `alternate = non-ignorable` by default: whitespace, punctuation and symbols all carry a PRIMARY
//! weight, below digits, which are below letters.
//!
//! So this is a second spelling of a comparator, which the crate's own rule warns against — and the
//! justification is that it is a comparator for a DIFFERENT REPERTOIRE. Mob names carry spaces and
//! backticks; spell names carry neither in any way that has ever mattered. Changing the other one to
//! match would move the ordering of the buffs and buffTimers family rows, which are pinned green by
//! their own goldens, to fix a list it is not used by.
//!
//! ── THE TABLE IS MEASURED, NOT GUESSED ───────────────────────────────────────────────────────
//!
//! `PRIMARY_ORDER` below is the observed output of sorting that exact character set with
//! `localeCompare` under the host ICU this project ships against. Reproduce it with:
//!
//! ```text
//! [...chars].sort((a, b) => a.localeCompare(b))
//! ```
//!
//! THE STATED LIMIT: a character outside the table sorts AFTER every letter, ordered by codepoint. No
//! name in any of the six slices contains one — the repertoire is ASCII plus the backtick EQ spells
//! `L\`Rei` with and the middle dot the proc-lane marker uses — and a fabricated weight for an unseen
//! character would be a guess dressed as a rule. If one ever appears, this comment is where to look.

use std::cmp::Ordering;

/// The CLDR root primary order for the repertoire these lists actually contain: whitespace, then
/// punctuation, then symbols, then digits, then letters.
const PRIMARY_ORDER: [char; 48] = [
    '\t', ' ', '_', '-', '\u{2013}', '\u{2014}', ',', ';', ':', '!', '?', '.', '\u{00b7}', '\'',
    '\u{2019}', '"', '(', ')', '[', ']', '{', '}', '@', '*', '/', '\\', '&', '#', '%', '`', '^',
    '+', '<', '=', '>', '|', '~', '$', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
];

/// Where the letters begin — every alphabetic character weighs at least this much, so a letter always
/// sorts after every space, mark and digit.
const LETTER_BASE: u32 = PRIMARY_ORDER.len() as u32;

/// …and where an UNKNOWN character begins: after every letter this table can place, ordered by
/// codepoint. See the header's stated limit.
const UNKNOWN_BASE: u32 = LETTER_BASE + 0x0011_0000;

fn primary(c: char) -> u32 {
    if let Some(i) = PRIMARY_ORDER.iter().position(|&x| x == c) {
        return i as u32;
    }
    if c.is_alphabetic() {
        // Case folds away at the primary level; it comes back as the tertiary difference below.
        let lower = c.to_lowercase().next().unwrap_or(c);
        return LETTER_BASE + lower as u32;
    }
    UNKNOWN_BASE + c as u32
}

/// The TERTIARY weight: lowercase before uppercase for the same letter, which is what CLDR root does
/// and what `'a'.localeCompare('A') === -1` reports. Compared left to right across the WHOLE string
/// only after every primary weight has tied — `aB` sorts before `Ab` for exactly that reason.
fn tertiary(c: char) -> u8 {
    u8::from(c.is_uppercase())
}

/// `a.localeCompare(b)` over the names these views rank.
pub fn compare_names(a: &str, b: &str) -> Ordering {
    let pa = a.chars().map(primary);
    let pb = b.chars().map(primary);
    let by_primary = pa.cmp(pb);
    if by_primary != Ordering::Equal {
        return by_primary;
    }
    let ta = a.chars().map(tertiary);
    let tb = b.chars().map(tertiary);
    let by_tertiary = ta.cmp(tb);
    if by_tertiary != Ordering::Equal {
        return by_tertiary;
    }
    // Identical under the collation. Codepoint order is the last resort, so the comparator is a total
    // order and a sort over it is reproducible.
    a.cmp(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// THE GOLDEN THAT FORCED THIS FILE: a space is not ignorable, so it beats a letter.
    #[test]
    fn a_space_sorts_before_a_letter() {
        assert_eq!(compare_names("a willowisp", "Asaka L`Rei"), Ordering::Less);
        assert_eq!(compare_names("a b", "ab"), Ordering::Less);
    }

    /// The measured punctuation order — space before hyphen before backtick.
    #[test]
    fn the_marks_carry_the_measured_primary_order() {
        assert_eq!(compare_names("a b", "a-b"), Ordering::Less);
        assert_eq!(compare_names("a-b", "a`b"), Ordering::Less);
        assert_eq!(compare_names("a1", "ab"), Ordering::Less);
    }

    /// CASE IS TERTIARY: it decides nothing until every primary weight has tied, and then lowercase
    /// wins.
    #[test]
    fn case_is_decided_last_and_lowercase_wins() {
        assert_eq!(compare_names("a", "A"), Ordering::Less);
        assert_eq!(compare_names("Melee", "melee"), Ordering::Greater);
        // `aB` before `Ab`: the primaries tie, and the tertiary run compares position 0 first.
        assert_eq!(compare_names("aB", "Ab"), Ordering::Less);
        // …but a primary difference at position 1 outranks any case difference at position 0.
        assert_eq!(compare_names("Ab", "aa"), Ordering::Greater);
    }

    /// A TOTAL ORDER: equal names compare equal, and nothing else does.
    #[test]
    fn identical_names_compare_equal() {
        assert_eq!(compare_names("Rune", "Rune"), Ordering::Equal);
        assert_ne!(compare_names("Rune", "Rune "), Ordering::Equal);
    }
}
