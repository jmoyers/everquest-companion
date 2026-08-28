//! Name normalization: the canonical `You` fold, identity keys, and spell canon keys.
//!
//! The app's `spellCanonKey` memo table is deliberately not ported — it is behaviour-identical
//! either way, and here it would be a global outliving a parse.

use crate::jsstr::js_trim;
use regex::Regex;
use std::sync::OnceLock;

/// 'you'/'yourself'/'your' fold to the canonical `You`; everything else is trimmed.
pub fn norm(name: &str) -> String {
    let n = js_trim(name);
    let l = n.to_lowercase();
    if l == "you" || l == "yourself" || l == "your" {
        return "You".to_string();
    }
    n.to_string()
}

/// The lowercased identity key. Unicode default case conversion, not ASCII-only.
///
/// The owned spelling, for call sites that retain the key. A site that only compares or looks up
/// should reach for [`id_key_ref`]; this is that function plus the copy.
pub fn id_key(name: &str) -> String {
    id_key_ref(name).into_owned()
}

/// The identity key, borrowed where the name is already its own key. The fold asks this several
/// times per damage line and throws almost every answer away after one comparison, so the
/// allocation was the whole cost.
///
/// The fast path is exact rather than approximate: `to_lowercase` is Unicode default case
/// conversion, whose only non-per-character rule is the Greek final sigma, so for a string that is
/// all ASCII with no `A`–`Z` lowercasing is the identity and the trimmed slice is the key.
/// Everything else falls through to the same `to_lowercase` the owned spelling runs.
///
/// The `you`/`yourself`/`your` fold answers with a `'static` slice, so it allocates nothing either.
pub fn id_key_ref(name: &str) -> std::borrow::Cow<'_, str> {
    use std::borrow::Cow;
    let n = js_trim(name);
    if n.bytes().all(|b| b.is_ascii() && !b.is_ascii_uppercase()) {
        // Already lowercase, so `to_lowercase` would have handed back these same bytes.
        return match n {
            "yourself" | "your" => Cow::Borrowed("you"),
            _ => Cow::Borrowed(n),
        };
    }
    let l = n.to_lowercase();
    if l == "you" || l == "yourself" || l == "your" {
        return Cow::Borrowed("you");
    }
    Cow::Owned(l)
}

/// A trailing, word-bounded I–X at the end of a name. Case sensitive; the DB-side copy
/// ([`db_canon_key`]) is the case-insensitive one and stays separate.
fn rank_tail() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r" (?:I|II|III|IV|V|VI|VII|VIII|IX|X)$").unwrap())
}

/// Trim, strip a trailing Roman rank, trim, lowercase.
pub fn spell_canon_key(spell: &str) -> String {
    let t = js_trim(spell);
    let stripped = strip_rank_tail(t);
    js_trim(&stripped).to_lowercase()
}

/// The case-sensitive rank strip on its own, without the lowercasing [`spell_canon_key`] adds: the
/// display path needs the same "a trailing Roman numeral" semantic without the fold. `js_trim` is
/// deliberately not applied — the two callers trim differently, so each keeps its own trimming.
pub fn strip_rank_tail(name: &str) -> std::borrow::Cow<'_, str> {
    rank_tail().replace(name, "")
}

/// The spell DB's own key: the same fold with a case-insensitive rank tail. Separate from
/// [`spell_canon_key`] so the difference stays visible instead of being merged away.
pub fn db_canon_key(name: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"(?i) (?:I|II|III|IV|V|VI|VII|VIII|IX|X)$").unwrap());
    let t = js_trim(name);
    let stripped = re.replace(t, "");
    js_trim(&stripped).to_lowercase()
}

/// The rank the key throws away: `Scorching Arrow IV` -> 4, a name with no numeral -> 0.
///
/// A second function rather than a change to [`spell_canon_key`], because every consumer of the
/// canonical key depends on a rank-IV and a rank-0 cast being one spell and only the resist model
/// needs to know they carry different resist adjusts. Case-sensitive, unlike the
/// `fold::jsfn::parse_spell_rank` twin.
pub fn spell_rank(spell: &str) -> i64 {
    let m = match rank_tail().find(js_trim(spell)) {
        Some(m) => m.as_str(),
        None => return 0,
    };
    // The closed I–X ladder EQ Legends prints; the fallback is unreachable behind a regex that
    // accepts only those ten.
    match js_trim(m) {
        "I" => 1,
        "II" => 2,
        "III" => 3,
        "IV" => 4,
        "V" => 5,
        "VI" => 6,
        "VII" => 7,
        "VIII" => 8,
        "IX" => 9,
        "X" => 10,
        _ => 0,
    }
}

/// Drop a possessive `'s` tail (three apostrophe variants), trim, and answer `None` for what is
/// left of nothing.
pub fn clean_mob(s: Option<&str>) -> Option<String> {
    let s = s?;
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"(?i)['`\u{2019}]s$").unwrap());
    let cut = re.replace(s, "");
    let out = js_trim(&cut);
    if out.is_empty() {
        None
    } else {
        Some(out.to_string())
    }
}

#[cfg(test)]
mod id_key_tests {
    use super::{id_key, id_key_ref};
    use std::borrow::Cow;

    /// The names the fold asks about plus the fast path's edges: the three self-words in both
    /// cases, an uppercase name, a name needing a trim, and two non-ASCII spellings whose
    /// lowercasing is not byte-wise (Turkish dotted capital I, Greek capital sigma).
    const CASES: &[&str] = &[
        "you",
        "You",
        "YOU",
        "your",
        "Your",
        "yourself",
        "Yourself",
        "a large rat",
        "A Large Rat",
        "  Primitive  ",
        "Innoruuk`s Chosen",
        "",
        "   ",
        "İstanbul",
        "ΣΟΦΟΣ",
        "Straße",
    ];

    /// The borrowed spelling is the owned one. Stated as an identity over every case rather than a
    /// table of expected strings, which would let the two drift and still pass.
    #[test]
    fn the_borrowed_key_is_the_owned_key() {
        for name in CASES {
            assert_eq!(
                id_key_ref(name).as_ref(),
                id_key(name).as_str(),
                "id_key_ref disagreed with id_key on {name:?}"
            );
        }
    }

    /// …and it is a borrow where the point was to avoid the allocation, so an edit that turns the
    /// fast path into a copy fails here rather than regressing silently.
    #[test]
    fn an_already_lowercase_name_allocates_nothing() {
        assert!(matches!(id_key_ref("a large rat"), Cow::Borrowed(_)));
        assert!(matches!(id_key_ref("you"), Cow::Borrowed(_)));
        // The self-word rewrite answers with a 'static slice, so it does not allocate either.
        assert!(matches!(id_key_ref("yourself"), Cow::Borrowed(_)));
        assert_eq!(id_key_ref("yourself"), "you");
        // An uppercase name is the case that genuinely has to build a new string.
        assert!(matches!(id_key_ref("A Large Rat"), Cow::Owned(_)));
    }
}
