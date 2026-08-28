//! `src/main/data/spellDb.ts`, as the fold reads it — the per-line facts the buffs model asks the
//! spell catalog for, projected into an owned table at construction.
//!
//! A projection rather than a borrow, because nothing in `fold` borrows the parser: that is what
//! lets a `Fold` outlive, precede or be moved independently of the `Parser` that fed it. The whole
//! dependency is ~1,900 small rows copied once.
//!
//! Two facts are derived here, at projection time, because both are pure functions of a row and so
//! cannot disagree with themselves later:
//!
//!   * nature — the fold of the DB's `spellType` vocabulary onto beneficial / detrimental /
//!     unknown. It is the one answer to "buff or debuff", which never comes from the shape of the
//!     target.
//!   * calms target — the orthogonal question: does this spell's beneficial effect happen to an
//!     enemy (Pacify, Soothe, Calm, Lull)? Derived from the landing sentences rather than typed, so
//!     a re-scrape that adds a rank joins the family for free.
//!
//! `by_key` is keyed by the DB's own `canonKey` (case-insensitive rank tail) and looked up with
//! keys the modules built through `spellCanonKey` (case-sensitive rank tail). The two are separate
//! functions over there as well, and keeping the asymmetry is what makes a lookup here answer
//! exactly what the lookup there answers.

use eqlog::names::db_canon_key;
use eqlog::spelldb::{cast_on_other_suffix, SpellDb};
use std::collections::HashMap;
use std::sync::OnceLock;

/// `SpellNature` — what `spellNature` folds `spellType` onto.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Nature {
    Beneficial,
    Detrimental,
    Unknown,
}

/// `BENEFICIAL_TYPES`. The counts beside each are the committed spells.json's, kept so the table is
/// auditable rather than a list somebody wrote down.
const BENEFICIAL_TYPES: &[&str] = &[
    "Beneficial",              // 1079
    "Statistic Buff",          // 34
    "Resist Buff",             // 11
    "Pet",                     // 9 — the pet summons; a friendly cast either way
    "Utility Beneficial",      // 6
    "Heal",                    // 6
    "Heal Over Time",          // 6
    "Pet Buff",                // 6
    "Pet Heal",                // 5
    "Haste",                   // 3
    "Cure",                    // 3
    "Movement Buff",           // 3
    "Remove Curse",            // 2
    "Vision",                  // 2
    "Summon Item",             // 2
    "Beneficial (Group only)", // 1
    "Invisibility",            // 1
    "Buff",                    // 1
    "Proc Buff",               // 1 — Spirit of the Puma
    "Regen",                   // 1
    "Damage Shield",           // 1 — cast on you/your pet, not on the mob
    "Block",                   // 1
];

/// `DETRIMENTAL_TYPES`.
const DETRIMENTAL_TYPES: &[&str] = &[
    "Detrimental",         // 713
    "Direct Damage",       // 8
    "Damage Over Time",    // 4
    "Utility Detrimental", // 2 — Cancel Magic, Flash of Light
    "Curse",               // 2
    "Slow",                // 2
    "Stun",                // 1
    "Root",                // 1
    "Statistic Debuff",    // 1
    "DD",                  // 1
];

/// `CALM_LANDING_MESSAGES` — the three sentences the calm roster is derived from. Nothing else in
/// the committed DB prints any of them, which is why the family is enumerable rather than typed.
const CALM_LANDING_MESSAGES: &[&str] = &[
    "Someone looks less aggressive.",
    "Someone calms down.",
    "Someone looks friendly.",
];

fn nature_of(spell_type: Option<&str>) -> Nature {
    let Some(t) = spell_type else {
        return Nature::Unknown;
    };
    if BENEFICIAL_TYPES.contains(&t) {
        Nature::Beneficial
    } else if DETRIMENTAL_TYPES.contains(&t) {
        Nature::Detrimental
    } else {
        Nature::Unknown
    }
}

/// One catalog row, reduced to what the fold reads. Anything absent is a field the buffs model
/// never asks about, and leaving it out is what makes that claim checkable.
#[derive(Debug, Clone)]
pub struct SpellRow {
    /// The DB's own spelling — the identity a resolved landing carries.
    pub name: String,
    pub duration_ms: Option<i64>,
    /// Read verbatim and only ever compared against `"Permanent"`. `duration_ms == None` is not the
    /// same question: hundreds of rows carry a null duration and are instant nukes, while the
    /// permanents state the word.
    pub duration_text: Option<String>,
    pub illusion: bool,
    pub nature: Nature,
    pub calms_target: bool,
    pub msg_cast_on_you: Option<String>,
    /// `castOnOtherSuffix(msgCastOnOther)`, precomputed — the only form the miner's verdict rule
    /// ever uses it in.
    pub msg_cast_on_other_suffix: Option<String>,
    pub msg_wears_off: Option<String>,
}

/// The projected catalog. An empty one is exactly the TS's absent `db?`: every read answers
/// nothing, so the fold has one code path where the TS has an optional.
#[derive(Debug, Clone, Default)]
pub struct SpellFacts {
    by_key: HashMap<String, SpellRow>,
}

impl SpellFacts {
    /// Project `db.byKey` — the first row per canonical name, which is what `buildSpellDb` keeps.
    pub fn project(db: &SpellDb) -> Self {
        let mut by_key = HashMap::new();
        for s in db.by_key_values() {
            by_key.insert(
                db_canon_key(&s.name),
                SpellRow {
                    name: s.name.clone(),
                    duration_ms: s.duration_ms,
                    duration_text: s.duration_text.clone(),
                    illusion: s.illusion,
                    nature: nature_of(s.spell_type.as_deref()),
                    calms_target: s
                        .msg_cast_on_other
                        .as_deref()
                        .is_some_and(|m| CALM_LANDING_MESSAGES.contains(&m)),
                    msg_cast_on_you: s.msg_cast_on_you.clone(),
                    msg_cast_on_other_suffix: s
                        .msg_cast_on_other
                        .as_deref()
                        .and_then(cast_on_other_suffix),
                    msg_wears_off: s.msg_wears_off.clone(),
                },
            );
        }
        SpellFacts { by_key }
    }

    /// `db.byKey.get(key)`.
    pub fn get(&self, key: &str) -> Option<&SpellRow> {
        self.by_key.get(key)
    }

    pub fn is_empty(&self) -> bool {
        self.by_key.is_empty()
    }
}

/// `messageOverlay.ts messageMatchesOtherSuffix` — the same tail test `eqlog`'s matcher makes,
/// ported a second time because the miner asks it of a line the DB never matched. The two copies
/// are pinned to each other by the goldens.
pub fn message_matches_other_suffix(text: &str, suffix: &str) -> bool {
    let tail = if suffix.starts_with("'s") {
        suffix.to_string()
    } else {
        format!(" {suffix}")
    };
    text.ends_with(&tail) && text.len() > tail.len()
}

/// `buffsShapes.ts looksLandingMessage` — is an un-catalogued line plausibly a self spell-landing
/// flavor message the DB missed?
///
/// It must be about the caster (contain "you"/"your"), a short sentence ending in a period, with no
/// digits (damage and heal lines carry numbers), no chat/tell/`by`/`from` markers, and not a
/// casting-system or UI line. That excludes third-person mob-subject lines, which are combat spam
/// that would poison the overlay with coincidental burst pairings.
///
/// Deliberately permissive: the miner's unambiguous-anchor and repeat-count rules reject
/// coincidental pairings, so a false candidate never earns a verified verdict.
///
/// The length bounds count UTF-16 units rather than bytes, because `text.length` does.
pub fn looks_landing_message(text: &str) -> bool {
    let len = text.encode_utf16().count();
    if !(6..=90).contains(&len) {
        return false;
    }
    if !text.ends_with('.') {
        return false;
    }
    if text.bytes().any(|b| b.is_ascii_digit()) {
        return false;
    }
    if !you_word().is_match(text) {
        return false;
    }
    !has_non_landing_marker(text)
}

/// `/\byou\b|\byour\b/i`, spelled as the two alternatives it is over there: a factored
/// `(?:you|your)\b` would depend on the engine's alternation preference.
fn you_word() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"(?i)(?-u:\b)you(?-u:\b)|(?-u:\b)your(?-u:\b)").unwrap())
}

/// Casting-system and UI feedback lines that are self-directed in shape but never a spell-landing
/// emote. They recur across every spell, so a coincidental burst pairing could otherwise verify
/// them.
fn casting_system() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(concat!(
            r"(?i)can't use that command|regain your concentration|change your invocation",
            r"|begin reciting|cannot see your target|Auto attack|mend your wounds",
            r"|shimmers briefly|feels alive with power|begins casting|begin singing|You must",
            r"|Insufficient|You do not|not ready yet|too far|out of range|You have entered",
            r"|received any tells|cannot reply|mostly successful|has been overwritten",
            r"|You forget |memoriz|You can(not| ?'?t)|Your target|Your spell|Your .* spell",
            r"|You have finished|Beginning to|You are (?:no longer|now)|not enough",
            r"|you cannot reply"
        ))
        .unwrap()
    })
}

/// `hasNonLandingMarker` — the chat, combat and system markers that disqualify an otherwise
/// landing-shaped line.
fn has_non_landing_marker(text: &str) -> bool {
    if text.contains("' told you") || text.contains(" tells ") || text.contains(" says") {
        return true;
    }
    if text.contains(" by ") || text.contains(" from ") {
        return true;
    }
    // Combat cast spam.
    if text.contains(" spell ") || text.contains("attention") {
        return true;
    }
    casting_system().is_match(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The two shapes the mining rule exists to tell apart.
    #[test]
    fn a_landing_message_is_about_you_and_carries_no_numbers() {
        assert!(looks_landing_message(
            "The symbol of Pinzarn flashes before your eyes."
        ));
        assert!(looks_landing_message("You feel much faster."));
        // A mob-subject line names nobody — combat spam, refused.
        assert!(!looks_landing_message("A revenant staggers."));
        // Numbers are damage/heal lines.
        assert!(!looks_landing_message(
            "You have taken 12 points of damage."
        ));
        // No terminal period, and too short.
        assert!(!looks_landing_message("You feel much faster"));
        assert!(!looks_landing_message("You."));
        // The casting-system family.
        assert!(!looks_landing_message("Your spell is interrupted."));
        assert!(!looks_landing_message("You have entered the wastes."));
        // A `by`/`from` marker is a combat sentence however it is dressed.
        assert!(!looks_landing_message("You are healed by your pet."));
    }

    /// The suffix tail test refuses a line that is only the suffix, which stops a bare wiki
    /// sentence from being read as a named-target landing.
    #[test]
    fn the_other_suffix_test_needs_something_in_front_of_the_tail() {
        assert!(message_matches_other_suffix(
            "A goblin looks less aggressive.",
            "looks less aggressive."
        ));
        assert!(!message_matches_other_suffix(
            "looks less aggressive.",
            "looks less aggressive."
        ));
        assert!(message_matches_other_suffix(
            "A goblin's eyes glow.",
            "'s eyes glow."
        ));
    }
}
