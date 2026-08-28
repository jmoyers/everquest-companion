//! `String.prototype.localeCompare` for the combat views — the name tiebreak the ranked lists in
//! this directory reach for.
//!
//! A second comparator beside `modules::buff_landing::compare_names` because the repertoire differs:
//! that one ignores the variable characters (spaces, apostrophes, backticks), which spell names never
//! carry meaningfully and mob names do. CLDR root collation is `alternate = non-ignorable`, so
//! whitespace, punctuation and symbols each carry a primary weight, below digits, below letters —
//! which is what decides a tie like `a willowisp` against `Asaka L\`Rei`.
//!
//! `PRIMARY_ORDER` below is the observed output of sorting that character set with `localeCompare`
//! under the host ICU this project ships against. Reproduce it with:
//!
//! ```text
//! [...chars].sort((a, b) => a.localeCompare(b))
//! ```
//!
//! Stated limit: a character outside the table sorts after every letter, ordered by codepoint. The
//! repertoire seen so far is ASCII plus the backtick and the proc-lane marker's middle dot, and a
//! fabricated weight for an unseen character would be a guess dressed as a rule.

use std::cmp::Ordering;

/// The CLDR root primary order for the repertoire these lists actually contain: whitespace, then
/// punctuation, then symbols, then digits, then letters.
const PRIMARY_ORDER: [char; 48] = [
    '\t', ' ', '_', '-', '\u{2013}', '\u{2014}', ',', ';', ':', '!', '?', '.', '\u{00b7}', '\'',
    '\u{2019}', '"', '(', ')', '[', ']', '{', '}', '@', '*', '/', '\\', '&', '#', '%', '`', '^',
    '+', '<', '=', '>', '|', '~', '$', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
];

/// Where the letters begin, so a letter always sorts after every space, mark and digit.
const LETTER_BASE: u32 = PRIMARY_ORDER.len() as u32;

/// …and where an unknown character begins: after every letter, ordered by codepoint.
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

/// The tertiary weight: lowercase before uppercase for the same letter, as CLDR root does. Compared
/// left to right across the whole string only after every primary weight has tied, which is why `aB`
/// sorts before `Ab`.
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
    // Identical under the collation: codepoint order is the last resort, so the comparator is a
    // total order and a sort over it is reproducible.
    a.cmp(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A space is not ignorable, so it beats a letter.
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

    /// Case is tertiary: it decides nothing until every primary weight ties, and then lowercase wins.
    #[test]
    fn case_is_decided_last_and_lowercase_wins() {
        assert_eq!(compare_names("a", "A"), Ordering::Less);
        assert_eq!(compare_names("Melee", "melee"), Ordering::Greater);
        // `aB` before `Ab`: the primaries tie, and the tertiary run compares position 0 first.
        assert_eq!(compare_names("aB", "Ab"), Ordering::Less);
        // …but a primary difference at position 1 outranks any case difference at position 0.
        assert_eq!(compare_names("Ab", "aa"), Ordering::Greater);
    }

    /// A total order: equal names compare equal, and nothing else does.
    #[test]
    fn identical_names_compare_equal() {
        assert_eq!(compare_names("Rune", "Rune"), Ordering::Equal);
        assert_ne!(compare_names("Rune", "Rune "), Ordering::Equal);
    }
}
