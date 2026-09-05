//! The keys. Three folds, each with exactly one definition.
//!
//! A name is a JOIN KEY, which is why these live here rather than at each use site: the committed
//! item DB, the quest index, the posky index and the runtime overlay must key an item the same way
//! four times, or a lookup answers for one spelling and not another.

/// Strip a trailing ` +N` item-level suffix, then trim.
///
/// `Cloak of Flames +4` and `Cloak of Flames` are one item to every counting boundary (law 2), and
/// the wiki has a page for exactly one of them.
///
/// The rule is ` \+\d+$` spelled as a scan — a trailing run of ASCII digits preceded by ` +` —
/// which avoids a regex dependency in a crate whose whole job is map reads.
#[must_use]
pub fn item_base_name(name: &str) -> String {
    let stripped = strip_plus_suffix(name);
    stripped.trim().to_owned()
}

/// The ` +N` suffix, removed if it is there.
fn strip_plus_suffix(name: &str) -> &str {
    let digits: usize = name.chars().rev().take_while(char::is_ascii_digit).count();
    if digits == 0 {
        return name;
    }
    let head = &name[..name.len() - digits];
    head.strip_suffix(" +").map_or(name, |kept| kept)
}

/// The canonical item key, for the committed DB, the overlay and every index built over either.
/// Strip the ` +N` suffix and fold case: loot lines and wiki titles disagree about casing constantly.
#[must_use]
pub fn item_key(name: &str) -> String {
    item_base_name(name).to_lowercase()
}

/// The DISPLAY name a lookup answers with. Identical to [`item_base_name`] and named separately
/// because the two say different things: one is a key, the other is what the card prints.
#[must_use]
pub fn normalize_item_name(name: &str) -> String {
    item_base_name(name)
}

/// The quest index's key: [`normalize_item_name`] through the rename overlay, lowercased.
///
/// The app's item-rename table is empty today, so no overlay is ported here. An empty Rust copy
/// would be a silent SECOND opinion the day somebody adds a row over there, so the absence is
/// CHECKED instead: `tests/knowledgeCorpus.test.mts` fails if `ITEM_RENAMES` becomes non-empty while
/// this crate has no way to read it.
#[must_use]
pub fn quest_item_key(name: &str) -> String {
    normalize_item_name(name).to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::{item_base_name, item_key, quest_item_key};

    #[test]
    fn the_item_level_suffix_is_stripped_and_nothing_else_is() {
        assert_eq!(item_base_name("Cloak of Flames +4"), "Cloak of Flames");
        assert_eq!(item_base_name("  Cloak of Flames  "), "Cloak of Flames");
        // Not a suffix: no space-plus, no digits, or digits that are part of the name.
        assert_eq!(item_base_name("Cloak of Flames+4"), "Cloak of Flames+4");
        assert_eq!(
            item_base_name("Bag of Sewn Evil-Eye"),
            "Bag of Sewn Evil-Eye"
        );
        assert_eq!(
            item_base_name("Journeyman's Boots 2"),
            "Journeyman's Boots 2"
        );
        assert_eq!(item_base_name("+4"), "+4");
    }

    #[test]
    fn the_key_folds_case_and_the_suffix_together() {
        assert_eq!(item_key("Cloak of Flames +4"), "cloak of flames");
        assert_eq!(item_key("CLOAK OF FLAMES"), "cloak of flames");
        assert_eq!(quest_item_key("Guard Bracelet"), "guard bracelet");
    }
}
