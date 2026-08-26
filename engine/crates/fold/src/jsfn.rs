//! The SHARED helpers the ported modules call, each one a verbatim port of the TS function named
//! in its doc comment. They live together rather than beside their callers because most of them
//! have two callers over there too (`itemBaseName` / `itemTierKey` are one rule split in two;
//! `zoneTier` is read by the parser and by the kills fold), and a second spelling of any of them
//! would be a second answer to a question the app has already decided.
//!
//! EVERY JS-vs-RUST DIVERGENCE HERE GOES THROUGH `eqlog::jsstr`, never re-derived (house rule):
//! `\s` is `JS_S`, `.` is `JS_DOT`, `\b` is `(?-u:\b)` — JavaScript's word boundary is ASCII where
//! the `regex` crate's is Unicode — and `\d` is spelled `[0-9]` because JS's is ASCII-only.

use eqlog::jsstr::{js_trim, JS_DOT, JS_S};
use regex::Regex;
use std::sync::OnceLock;

/// `shared/kills.ts TIER_OPEN_WORLD` — a bare zone name: no instance, so no lockout.
pub const TIER_OPEN_WORLD: i64 = -1;
/// `shared/kills.ts TIER_UNKNOWN` — the log did not state where, or named an instance whose
/// difficulty adjective this app has never decoded.
pub const TIER_UNKNOWN: i64 = -2;

/// `main/log/parseWorld.ts TIER_ADJ`.
fn tier_adj(word: &str) -> Option<i64> {
    match word.to_lowercase().as_str() {
        "awakened" => Some(1),
        "adaptive" => Some(2),
        "fused" => Some(3),
        "refined" => Some(4),
        _ => None,
    }
}

struct ZoneRes {
    strip_suffix: Regex,
    strip_numbered_paren: Regex,
    strip_paren: Regex,
    adjective: Regex,
    instance_suffix: Regex,
}

fn zone_res() -> &'static ZoneRes {
    static RE: OnceLock<ZoneRes> = OnceLock::new();
    RE.get_or_init(|| ZoneRes {
        strip_suffix: Regex::new(&format!(
            r"(?i){s}*-{s}*(?:Solo|Group)(?-u:\b){d}*$",
            s = JS_S,
            d = JS_DOT
        ))
        .unwrap(),
        strip_numbered_paren: Regex::new(&format!(r"{s}+[0-9]+{s}*\([^)]*\){s}*$", s = JS_S))
            .unwrap(),
        strip_paren: Regex::new(&format!(r"{s}+\([^)]*\){s}*$", s = JS_S)).unwrap(),
        adjective: Regex::new(&format!(r"\(([A-Za-z]+)\){s}*$", s = JS_S)).unwrap(),
        instance_suffix: Regex::new(&format!(r"(?i){s}-{s}*(?:Solo|Group)(?-u:\b)", s = JS_S))
            .unwrap(),
    })
}

/// `main/log/parseWorld.ts zoneTier` — the whole of it, because the LAST branch reads `base`.
///
/// Four answers, not five (that file's header carries the ruling): a named difficulty d1..d4, d0
/// for an instance with no adjective, `TIER_OPEN_WORLD` for a bare zone name, and `TIER_UNKNOWN`
/// both for the empty string (the kills module's state before the scan reaches any zone line) and
/// for a parenthetical the table does not know.
pub fn zone_tier(zone: &str) -> (String, i64) {
    let res = zone_res();
    // Three SINGLE replacements, in order: `String.prototype.replace` with a non-global regex
    // touches the first match only, and all three are `$`-anchored so there is only ever one.
    let a = res.strip_suffix.replace(zone, "");
    let b = res.strip_numbered_paren.replace(&a, "");
    let c = res.strip_paren.replace(&b, "");
    let base = js_trim(&c).to_string();
    if let Some(m) = res.adjective.captures(zone) {
        return (base, tier_adj(&m[1]).unwrap_or(TIER_UNKNOWN));
    }
    if res.instance_suffix.is_match(zone) {
        return (base, 0);
    }
    let tier = if base.is_empty() {
        TIER_UNKNOWN
    } else {
        TIER_OPEN_WORLD
    };
    (base, tier)
}

/// `main/log/reducers.ts isCountedKill`'s one test, `/^you\b/i.test(killer)`, spelled out.
///
/// Written by hand rather than as a regex for two reasons: it runs on every death line in the log,
/// and JS's `\b` is ASCII where the crate's is Unicode — so the hand-written form is both the
/// faster and the more exactly faithful of the two.
pub fn starts_with_you_word(killer: &str) -> bool {
    let mut it = killer.chars();
    for want in ['y', 'o', 'u'] {
        match it.next() {
            Some(c) if c.to_ascii_lowercase() == want => {}
            _ => return false,
        }
    }
    match it.next() {
        None => true,
        Some(c) => !(c.is_ascii_alphanumeric() || c == '_'),
    }
}

/// `shared/itemStats.ts itemTierFromName` — `/ \+(\d+)$/` over the TRIMMED name.
///
/// A digit run too long for an `i64` answers `None` where JS would answer a lossy float; that
/// takes 19 digits of item level and no line in any log has printed one.
pub fn item_tier_from_name(name: &str) -> Option<i64> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r" \+([0-9]+)$").unwrap());
    let m = re.captures(js_trim(name))?;
    m[1].parse::<i64>().ok()
}

/// `shared/itemStats.ts itemBaseName` — strip ` +N`, THEN trim.
///
/// The order matters and is not the same as `itemTierFromName`'s (which trims first): a name with
/// a trailing space keeps its suffix here and loses it there. Both are ported exactly as written.
pub fn item_base_name(name: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r" \+[0-9]+$").unwrap());
    js_trim(&re.replace(name, "")).to_string()
}

/// `shared/itemStats.ts itemTierKey`.
pub fn item_tier_key(name: &str) -> String {
    item_base_name(name).to_lowercase()
}

/// `shared/spellSets.ts memoKey` — trim, lowercase, collapse whitespace runs to one space.
pub fn memo_key(spell: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(&format!(r"{s}+", s = JS_S)).unwrap());
    re.replace_all(&js_trim(spell).to_lowercase(), " ")
        .into_owned()
}

/// `shared/outputs/baseline.ts baseName` — the last path segment, either separator.
pub fn base_name(path: &str) -> &str {
    match path.rfind(['/', '\\']) {
        None => path,
        Some(i) => &path[i + 1..],
    }
}

/// What `shared/spellLines.ts parseSpellRank` answers.
pub struct SpellRank {
    pub base: String,
    pub rank: i64,
    pub suffixed: bool,
}

/// `shared/spellLines.ts parseSpellRank` — split a display name into base + rank ordinal.
///
/// `RANK_TAIL_RE` is ` (I|II|…|X)$`, case-INSENSITIVE — deliberately NOT the same regex as
/// `eqlog::names::spell_canon_key`'s, which is the case-SENSITIVE one `parseCommon.ts` spells. The
/// two are separate over there too, and `tests/spellLines.test.mts` pins where they must agree.
pub fn parse_spell_rank(name: &str) -> SpellRank {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"(?i) (I|II|III|IV|V|VI|VII|VIII|IX|X)$").unwrap());
    let trimmed = js_trim(name);
    let Some(m) = re.captures(trimmed) else {
        return SpellRank {
            base: trimmed.to_string(),
            rank: 1,
            suffixed: false,
        };
    };
    let at = m.get(0).expect("whole match").start();
    SpellRank {
        base: js_trim(&trimmed[..at]).to_string(),
        rank: rank_value(&m[1]),
        suffixed: true,
    }
}

/// `shared/spellLines.ts RANK_VALUE` — the closed I–X ladder EQ Legends prints. Anything else is
/// the TS's `?? 1`, which is unreachable behind a regex that only accepts those ten.
fn rank_value(numeral: &str) -> i64 {
    match numeral.to_lowercase().as_str() {
        "i" => 1,
        "ii" => 2,
        "iii" => 3,
        "iv" => 4,
        "v" => 5,
        "vi" => 6,
        "vii" => 7,
        "viii" => 8,
        "ix" => 9,
        "x" => 10,
        _ => 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_zone_line_decodes_four_kinds_of_thing() {
        assert_eq!(zone_tier("The Plane of Hate - Solo 4 (Refined)").1, 4);
        assert_eq!(zone_tier("Nagafen's Lair - Group 3 (Fused)").1, 3);
        assert_eq!(zone_tier("Najena 4 (Refined)").1, 4);
        assert_eq!(zone_tier("The Plane of Sky 1 (Awakened)").1, 1);
        assert_eq!(zone_tier("The Plane of Hate - Solo").1, 0);
        assert_eq!(zone_tier("The Permafrost Caverns - Solo").1, 0);
        assert_eq!(zone_tier("Innothule Swamp").1, TIER_OPEN_WORLD);
        // The kills module's state before the scan reaches any zone line.
        assert_eq!(zone_tier("").1, TIER_UNKNOWN);
        // A parenthetical the table does not know is still unmistakably an INSTANCE.
        assert_eq!(zone_tier("Najena 5 (Sublime)").1, TIER_UNKNOWN);
        assert_eq!(
            zone_tier("The Plane of Hate - Solo 4 (Refined)").0,
            "The Plane of Hate"
        );
    }

    #[test]
    fn the_kill_filter_reads_you_as_a_whole_word() {
        assert!(starts_with_you_word("You"));
        assert!(starts_with_you_word("you"));
        assert!(starts_with_you_word("You`s"));
        assert!(starts_with_you_word("You and Dranix"));
        // `\b` fails where the next character is a word character, so a killer named `Your pet`
        // is NOT the `slain by You` twin the filter drops — the kill stays counted. Faithful.
        assert!(!starts_with_you_word("Your pet"));
        assert!(!starts_with_you_word("Younger kobold"));
        assert!(!starts_with_you_word("a youth"));
    }

    #[test]
    fn the_item_helpers_keep_their_two_different_trim_orders() {
        assert_eq!(item_tier_from_name("Cloak of Flames +4"), Some(4));
        assert_eq!(item_tier_from_name("Cloak of Flames +4 "), Some(4));
        assert_eq!(item_tier_from_name("Cloak of Flames"), None);
        assert_eq!(item_base_name("Cloak of Flames +4"), "Cloak of Flames");
        // …and the trailing space is what keeps the suffix here, exactly as the TS does.
        assert_eq!(item_base_name("Cloak of Flames +4 "), "Cloak of Flames +4");
        assert_eq!(
            item_tier_key("Thelvorn, Blade of Light +5"),
            "thelvorn, blade of light"
        );
    }

    #[test]
    fn the_rank_tail_takes_the_longest_numeral_that_reaches_the_end() {
        let r = parse_spell_rank("Shiftless Deeds III");
        assert_eq!(
            (r.base.as_str(), r.rank, r.suffixed),
            ("Shiftless Deeds", 3, true)
        );
        let r = parse_spell_rank("Lay on Hands IX");
        assert_eq!(
            (r.base.as_str(), r.rank, r.suffixed),
            ("Lay on Hands", 9, true)
        );
        // An UNSUFFIXED name is rank 1 and is not evidence of anything (observedSpellRanks).
        let r = parse_spell_rank("Clarity");
        assert_eq!((r.base.as_str(), r.rank, r.suffixed), ("Clarity", 1, false));
        // A ` +N` item merge falls out here rather than needing a second test at the call site.
        assert!(!parse_spell_rank("Cloak of Flames +4").suffixed);
    }

    #[test]
    fn memo_key_and_base_name_match_their_originals() {
        assert_eq!(memo_key("  Minor   Healing "), "minor healing");
        assert_eq!(base_name("C:\\EQ\\inventory.txt"), "inventory.txt");
        assert_eq!(base_name("inventory.txt"), "inventory.txt");
    }
}
