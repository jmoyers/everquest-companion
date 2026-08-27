//! `src/main/combat/taxonomy.ts` — the paren-modifier splitter and the damage category, ported.

use crate::jsstr::{is_js_space, js_trim};

/// The three two-word procs, recombined before the remainder is split on whitespace. Order is the
/// TS array's order and is load-bearing: the pull is greedy and runs first.
const TWO_WORD: [&str; 3] = ["Slay Undead", "Finishing Blow", "Crippling Blow"];

/// `parseModifiers("Riposte Critical")` → `["Riposte", "Critical"]`.
pub fn parse_modifiers(modifier: Option<&str>) -> Vec<String> {
    // `if (!modifier) return []` — undefined AND the empty string, which is why this is not a
    // plain `is_none`.
    let Some(modifier) = modifier else {
        return Vec::new();
    };
    if modifier.is_empty() {
        return Vec::new();
    }
    let raw = js_trim(modifier);
    if raw.is_empty() {
        return Vec::new();
    }
    let mut mods: Vec<String> = Vec::new();
    let mut rest = raw.to_string();
    for tw in TWO_WORD {
        if rest.contains(tw) {
            mods.push(tw.to_string());
            // `String.prototype.replace` with a STRING replaces the FIRST occurrence only.
            let replaced = match rest.find(tw) {
                Some(at) => {
                    let mut s = String::with_capacity(rest.len());
                    s.push_str(&rest[..at]);
                    s.push(' ');
                    s.push_str(&rest[at + tw.len()..]);
                    s
                }
                None => rest.clone(),
            };
            rest = js_trim(&replaced).to_string();
        }
    }
    for tok in rest.split(is_js_space) {
        if !tok.is_empty() {
            mods.push(tok.to_string());
        }
    }
    mods
}

pub fn has_critical(mods: &[String]) -> bool {
    mods.iter().any(|m| m.eq_ignore_ascii_case("critical"))
}

/// ELEMENT-GENERIC (JOS-506) so the parser's owned token list and the fold's borrowed one can both
/// ask this without either allocating a list in the other's spelling.
pub fn has_slay_undead<S: AsRef<str>>(mods: &[S]) -> bool {
    mods.iter()
        .any(|m| m.as_ref().eq_ignore_ascii_case("slay undead"))
}

/// A melee swing carrying Slay Undead is its own category; every other dtype maps 1:1.
pub fn damage_category<S: AsRef<str>>(dtype: &str, mods: &[S]) -> &'static str {
    if dtype == "melee" && has_slay_undead(mods) {
        return "slay";
    }
    match dtype {
        "melee" => "melee",
        "spell" => "spell",
        "dot" => "dot",
        "ds" => "ds",
        other => unreachable!("unknown damage type {other}"),
    }
}
