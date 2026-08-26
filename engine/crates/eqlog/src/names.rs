//! The name-normalization helpers of `src/main/log/parseCommon.ts`, ported verbatim.
//!
//! `spellCanonKey`'s memo table is deliberately NOT ported. Over there it is a measured hot-path
//! optimisation (JOS-59) whose header states it is behaviour-identical either way; here it would be
//! a global that outlives a parse, which the cache-transparency law (docs/plans/data-server.md
//! ruling 18) forbids outright.

use crate::jsstr::js_trim;
use regex::Regex;
use std::sync::OnceLock;

/// `norm` — 'you'/'yourself'/'your' fold to the canonical `You`, everything else is trimmed.
pub fn norm(name: &str) -> String {
    let n = js_trim(name);
    let l = n.to_lowercase();
    if l == "you" || l == "yourself" || l == "your" {
        return "You".to_string();
    }
    n.to_string()
}

/// `idKey` — the lowercased identity key. Unicode default case conversion, not ASCII-only.
pub fn id_key(name: &str) -> String {
    let n = js_trim(name).to_lowercase();
    if n == "you" || n == "yourself" || n == "your" {
        return "you".to_string();
    }
    n
}

/// `RANK_TAIL_RE` — a trailing, word-bounded I–X at the END of a name. Case SENSITIVE, exactly as
/// the TS spells it; the DB-side copy in spellDb.ts is the case-insensitive one and is separate.
fn rank_tail() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r" (?:I|II|III|IV|V|VI|VII|VIII|IX|X)$").unwrap())
}

/// `spellCanonKey` — trim, strip a trailing Roman rank, trim, lowercase.
pub fn spell_canon_key(spell: &str) -> String {
    let t = js_trim(spell);
    let stripped = strip_rank_tail(t);
    js_trim(&stripped).to_lowercase()
}

/// The CASE-SENSITIVE rank strip on its own, without the lowercasing `spell_canon_key` adds.
///
/// It exists because `comboEvidence.ts` declares its OWN `RANK_TAIL_RE` — the same case-sensitive
/// pattern — and applies it for DISPLAY: a cast observation's label is `Lay on Hands`, spelled the
/// way the log spelled it, and the golden publishes that label inside every slot's `because`. So
/// the same semantic is needed twice with two different tails on it, and a second spelling of "a
/// trailing Roman numeral" is the thing the ledger law forbids. `js_trim` is deliberately NOT
/// applied here: the TS's display path is `.replace(RE, '').trim()` and the key path trims on both
/// sides, so each caller keeps its own trimming.
pub fn strip_rank_tail(name: &str) -> std::borrow::Cow<'_, str> {
    rank_tail().replace(name, "")
}

/// The DB's own `canonKey` (spellDb.ts) — the same fold with a CASE-INSENSITIVE rank tail. The two
/// are separate functions over there too, with the comment "kept local to avoid a cycle"; keeping
/// them separate here keeps the difference visible instead of merging it away.
pub fn db_canon_key(name: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"(?i) (?:I|II|III|IV|V|VI|VII|VIII|IX|X)$").unwrap());
    let t = js_trim(name);
    let stripped = re.replace(t, "");
    js_trim(&stripped).to_lowercase()
}

/// `spellRank` — THE RANK THE KEY THROWS AWAY (JOS-387): `Scorching Arrow IV` -> 4, a name with no
/// numeral -> 0.
///
/// It reads the SAME trailing token `spell_canon_key` strips, off the same raw display name, and it
/// is deliberately a second function rather than a change to that one: every consumer of the
/// canonical key — the buffs model's cast/fade pairing, the ledger's pooling, the proc analytics —
/// depends on a rank-IV and a rank-0 cast being ONE spell, and only the resist model needs to know
/// that they carry different resist adjusts. So the rank is parsed BEFORE canonising, beside the
/// strip, and the key is untouched.
///
/// CASE-SENSITIVE, because `RANK_TAIL_RE` is: this is `parseCommon.ts`'s regex, not `spellLines.ts`'s
/// case-insensitive twin (`fold::jsfn::parse_spell_rank`). The two are separate over there too, and
/// keeping them separate here keeps the difference visible instead of merging it away.
pub fn spell_rank(spell: &str) -> i64 {
    let m = match rank_tail().find(js_trim(spell)) {
        Some(m) => m.as_str(),
        None => return 0,
    };
    // `RANK_VALUES[m[0].trim()] ?? 0` — the closed I–X ladder EQ Legends prints, and the `?? 0` is
    // unreachable behind a regex that accepts only those ten.
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

/// `cleanMob` — drop a possessive `'s` tail (three apostrophe variants), trim, and answer `None`
/// for what is left of nothing.
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
