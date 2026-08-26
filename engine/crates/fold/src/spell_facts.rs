//! `src/main/data/spellDb.ts`, as the FOLD reads it — the per-line facts the buffs model asks the
//! spell catalog for, projected into an owned table at construction.
//!
//! WHY A PROJECTION RATHER THAN A BORROW. `eqlog` owns the catalog because the PARSER's output
//! depends on it (the `candidates` list a `buffApply` carries IS that table). This crate could hold
//! a `&SpellDb` instead — but the 2a scaffold's own rule is that nothing in `fold` borrows the
//! parser, which is what lets a `Fold` outlive, precede or be moved independently of the `Parser`
//! that fed it. Everything the buffs model asks of the DB is a lookup on `db.byKey` for one of six
//! scalar facts, so the whole dependency is ~1,900 small rows copied once.
//!
//! THE TWO DERIVED FACTS ARE DERIVED HERE, at projection time, because both are pure functions of a
//! row and neither can therefore disagree with itself later:
//!
//!   * NATURE — `spellNature(spellType)`, the fold of the DB's 33-value `spellType` vocabulary onto
//!     beneficial / detrimental / unknown. It is the ONE answer to "is this a good thing or a bad
//!     thing" (JOS-140 ruling 8), and the owner's ruling is that buff-vs-debuff comes from here and
//!     from nowhere else — never from the shape of the target. The defect that named the ruling:
//!     `Resist Magic` is spellType `Resist Buff`, which matched neither of the two string literals
//!     the buffs model used to test, so a friendly resist buff landing on somebody the model was not
//!     currently holding as a pet tallied 'hostile' and walked onto the DEBUFFS overlay.
//!   * CALMS TARGET — `spellCalmsTarget(entry)`, the second and orthogonal question (JOS-213): does
//!     the beneficial thing this spell does happen to an ENEMY? Pacify, Soothe, Calm, Lull. The
//!     roster is DERIVED from the three landing sentences spells.json groups the family by, not
//!     typed, so a re-scrape that adds a rank joins it for free.
//!
//! `by_key` IS KEYED BY THE DB'S OWN `canonKey` — the CASE-INSENSITIVE rank tail
//! (`eqlog::names::db_canon_key`) — and is looked up with keys the modules built through
//! `spellCanonKey`, whose rank tail is case-SENSITIVE. The two are deliberately separate functions
//! over there as well; keeping the asymmetry is what makes a lookup here answer exactly what the
//! lookup there answers.

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

/// `BENEFICIAL_TYPES` — the counts beside each are the committed spells.json's, kept because they
/// are what makes the table auditable rather than a list somebody wrote down.
const BENEFICIAL_TYPES: &[&str] = &[
    "Beneficial",              // 1079
    "Statistic Buff",          // 34
    "Resist Buff",             // 11
    "Pet",                     // 9 — the pet SUMMONS; a friendly cast either way
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
    "Proc Buff",               // 1 — Spirit of the Puma, the reported case
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

/// One catalog row, reduced to what the fold reads. Anything not here is a field the buffs model
/// demonstrably never asks about, and leaving it out is what makes that claim checkable.
#[derive(Debug, Clone)]
pub struct SpellRow {
    /// The DB's own spelling — the IDENTITY a resolved landing carries (JOS-238).
    pub name: String,
    pub duration_ms: Option<i64>,
    /// Read VERBATIM and only ever compared against `"Permanent"`. `durationMs == null` alone is
    /// NOT the same question: 453 Self rows carry a null duration and most of them are instant
    /// nukes, while the 62 permanents state the word.
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

/// The projected catalog. An EMPTY one is exactly the TS's absent `db?`: every read is a lookup
/// that answers nothing, which is what `db?.byKey.get(k)` does with no DB at all — so the fold has
/// one code path where the TS has an optional, and no behaviour rides on the difference.
#[derive(Debug, Clone, Default)]
pub struct SpellFacts {
    by_key: HashMap<String, SpellRow>,
}

impl SpellFacts {
    /// Project `db.byKey` — the FIRST row per canonical name, which is what `buildSpellDb` keeps.
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

/// `messageOverlay.ts messageMatchesOtherSuffix` — the same tail test `eqlog`'s own matcher makes,
/// ported a second time because the MINER asks it of a line the DB never matched. (The eqlog copy
/// is private to the baseline-only overlay pass; this is the fold's, and the two are pinned to each
/// other by the goldens.)
pub fn message_matches_other_suffix(text: &str, suffix: &str) -> bool {
    let tail = if suffix.starts_with("'s") {
        suffix.to_string()
    } else {
        format!(" {suffix}")
    };
    text.ends_with(&tail) && text.len() > tail.len()
}

/// `buffsShapes.ts looksLandingMessage` — is an un-catalogued line plausibly a SELF spell-landing
/// flavor message the DB missed (Task #36)?
///
/// It must be ABOUT THE CASTER (contain "you"/"your"), a short sentence ending in a period, with no
/// digits (damage/heal lines carry numbers), no chat/tell/`by`/`from` markers, and not a
/// casting-system or UI line. That deliberately excludes third-person mob-subject lines ("a
/// revenant staggers.", "…spell is interrupted.") — combat spam that would poison the overlay with
/// coincidental burst pairings. Symbol of Pinzarn's real "The symbol of Pinzarn flashes before your
/// eyes." passes, because it names "your eyes"; a mob effect line does not.
///
/// Deliberately permissive: the miner's unambiguous-anchor and repeat-count rules reject
/// coincidental pairings, so a false candidate never earns a VERIFIED verdict.
///
/// `text.length` IS UTF-16 UNITS over there, and the two bounds below are a length test — so this
/// counts them, rather than bytes.
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

/// `/\byou\b|\byour\b/i`, spelled as the TWO alternatives it is over there rather than as one
/// factored group — a factored `(?:you|your)\b` asks the engine's alternation preference a question
/// this one never has to.
fn you_word() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"(?i)(?-u:\b)you(?-u:\b)|(?-u:\b)your(?-u:\b)").unwrap())
}

/// `CASTING_SYSTEM_RE` — casting-system / UI feedback lines that are SELF-directed in shape but are
/// never a spell-landing emote. They recur across every spell, so they are pure noise, and they are
/// rejected so a coincidental burst pairing cannot verify them.
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

/// `hasNonLandingMarker` — the chat/combat/system markers that disqualify an otherwise
/// landing-SHAPED line.
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

    /// The two shapes the mining rule exists to tell apart, verbatim from the TS header.
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

    /// The suffix tail test refuses a line that IS the suffix, which is what stops a bare wiki
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
