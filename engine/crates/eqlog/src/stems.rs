//! THE TWO ROSTERS `classifyWornOff` ASKS — `CHARM_STEMS` and `CC_STEMS` from
//! `src/main/log/rulesets.ts`, plus the one effect rule the derived charm roster reads.
//!
//! `CHARM_STEMS` is the only pattern in the whole port that JS can express and the `regex` crate
//! cannot: two of its branches carry a NEGATIVE LOOKAHEAD, and both of them are load-bearing rather
//! than decorative — `\bcharm\b(?! of )` is what keeps the two item focus effects (`Naki's Charm of
//! Pernicity`, `Tavee's Charm of Diuturnity`) out of the roster, and `\ballure\b(?! of death)` is
//! what keeps `Allure of Death`, a beneficial necro self-buff, out of it (JOS-250's audit). So the
//! pattern is split: everything without a lookahead stays one alternation, and the two that have
//! one are a match walk plus a `starts_with` on the tail — which is what the lookahead means.

use regex::Regex;
use std::sync::OnceLock;

/// Every `CHARM_STEMS` branch that carries no lookahead, in the TS order.
fn charm_plain() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)beguile|alluring whispers|cajol|dictate|besiege|agacerie|beckon|command of druzzil|dominate|thrall of bones|enslave death|befriend animal|call of karana|tunare.s request|solon.s ((bewitching )?bravura|song of the sirens)",
        )
        .unwrap()
    })
}

fn charm_word() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)(?-u:\b)charm(?-u:\b)").unwrap())
}

fn allure_word() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)(?-u:\b)allure(?-u:\b)").unwrap())
}

/// `CHARM_STEMS.test(name)`.
pub fn charm_stems_test(name: &str) -> bool {
    if charm_plain().is_match(name) {
        return true;
    }
    // A JS alternation with a lookahead succeeds if ANY position satisfies the whole branch, so the
    // walk has to look at every occurrence rather than only the first.
    if charm_word()
        .find_iter(name)
        .any(|m| !starts_with_ci(&name[m.end()..], " of "))
    {
        return true;
    }
    allure_word()
        .find_iter(name)
        .any(|m| !starts_with_ci(&name[m.end()..], " of death"))
}

/// The lookaheads sit inside a `/i` pattern, so ` of Death` satisfies `(?! of death)` exactly as
/// ` of death` does. `lower` must already be lowercase ASCII.
fn starts_with_ci(text: &str, lower: &str) -> bool {
    text.len() >= lower.len()
        && text.as_bytes()[..lower.len()].eq_ignore_ascii_case(lower.as_bytes())
}

/// `CC_STEMS.test(name)` — no lookahead anywhere, so it stays one pattern.
pub fn cc_stems_test(name: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(
            r"(?i)mesmeriz|enthrall|entranc|dazzle|screaming terror|ensnar|immobiliz|suffocat|kelin.s lucid lullaby|pixie strike|sionachie.s dreams",
        )
        .unwrap()
    });
    re.is_match(name)
}

/// Does this wiki effect line classify as `charm`?
///
/// `classifyEffectLine` walks a fourteen-rule table and returns the FIRST rule that matches; the
/// charm rule is the FIRST entry, so `classifyEffectLine(line) === 'charm'` is exactly
/// `/^charm\b/i.test(line.trim())` and the other thirteen rules cannot change the answer. Only the
/// charm class is read here (`derivedCharmRoster`), so only the charm rule is ported.
pub fn classify_effect_line_is_charm(line: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"(?i)^charm(?-u:\b)").unwrap());
    re.is_match(line)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_two_lookaheads_still_refuse_what_they_were_written_for() {
        assert!(charm_stems_test("Charm"));
        assert!(charm_stems_test("Dragon Charm"));
        assert!(!charm_stems_test("Naki's Charm of Pernicity"));
        assert!(!charm_stems_test("Tavee's Charm of Diuturnity"));
        assert!(charm_stems_test("Allure"));
        assert!(!charm_stems_test("Allure of Death"));
        assert!(charm_stems_test("Allure of the Wild"));
    }

    #[test]
    fn the_backtick_and_apostrophe_possessives_both_answer() {
        assert!(charm_stems_test("Tunare`s Request"));
        assert!(charm_stems_test("Tunare's Request"));
        assert!(charm_stems_test("Solon's Bewitching Bravura"));
        assert!(charm_stems_test("Solon's Bravura"));
        assert!(charm_stems_test("Solon's Song of the Sirens"));
    }

    #[test]
    fn cc_stems_answer_the_holds() {
        assert!(cc_stems_test("Mesmerization III"));
        assert!(cc_stems_test("Enthrall"));
        assert!(!cc_stems_test("Largo's Melodic Binding"));
    }
}
