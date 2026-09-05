//! `src/main/data/spellDb.ts`, as the fold reads it — the per-line facts the buffs model asks the
//! spell catalog for, projected into an owned table at construction.
//!
//! A projection rather than a borrow, because nothing in `fold` borrows the parser: that is what
//! lets a `Fold` outlive, precede or be moved independently of the `Parser` that fed it. The whole
//! dependency is ~1,900 small rows copied once.
//!
//! Three facts are derived here, at projection time, because all are pure functions of a row and so
//! cannot disagree with themselves later:
//!
//!   * nature — the fold of the DB's `spellType` vocabulary onto beneficial / detrimental /
//!     unknown. It is the one answer to "buff or debuff", which never comes from the shape of the
//!     target.
//!   * calms target — the orthogonal question: does this spell's beneficial effect happen to an
//!     enemy (Pacify, Soothe, Calm, Lull)? Derived from the landing sentences rather than typed, so
//!     a re-scrape that adds a rank joins the family for free.
//!   * duration category — which rate an upgrade tier grows this spell's duration at, read off the
//!     effect list rather than the type column.
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

/// Which of the upgrade system's duration-growth categories a spell belongs to.
///
/// Read off what the effect list says the spell DOES, because the type column answers
/// `Beneficial`/`Detrimental` for 1,795 of the 2,006 committed rows and cannot separate a DoT from
/// a slow.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DurationCategory {
    DotHot,
    Buff,
    Debuff,
    CrowdControl,
    ProcBuff,
    /// The page listed no effect beyond a counter, so it never said what the spell does.
    Unstated,
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

/// The type column's own word for an over-time spell. A subset of what [`hp_per_tick`] finds over
/// the committed catalog, kept because it is the wiki's own statement rather than our reading.
const DOT_HOT_TYPES: &[&str] = &["Damage Over Time", "Heal Over Time", "Regen"];

/// A hit-point change per tick — the one effect line separating a DoT or HoT from a debuff or buff.
/// Mana and endurance regen are deliberately not it: a mana regen line is a buff.
fn hp_per_tick() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(
            r"(?i)^(increase|decrease) (current )?(hit ?points|hitpoints)\b.*\bper tick\b",
        )
        .unwrap()
    })
}

/// The hold effects, anchored at the head of the wiki's effect sentence the same way the app's
/// effect classifier anchors its rules — so `Add Melee Proc: Stunning Strike` is not a stun.
fn cc_effect_head() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(r"(?i)^(charm|mesmerize|root|fear|stun|blind|pacify|memory blur)\b")
            .unwrap()
    })
}

/// Counter bookkeeping (`Increase Curse Counter by 8`) states a cure requirement, never a mechanic.
fn counter_line() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"(?i)^increase [a-z]+ counter by\b").unwrap())
}

/// Place a spell in a duration-growth category. Most specific evidence first, and a row the wiki
/// never described falls to `Unstated` rather than to its nature — the two rates differ, so an
/// undescribed spell must not be assumed into the faster-growing one.
///
/// Crowd control takes the UNION of the effect heads and the name rosters: both readings round to
/// the same conservative rate here, so the union costs nothing and needs no ruling between them.
fn category_of(
    name: &str,
    spell_type: Option<&str>,
    nature: Nature,
    effects: &[String],
) -> DurationCategory {
    if spell_type == Some("Proc Buff") {
        return DurationCategory::ProcBuff;
    }
    if spell_type.is_some_and(|t| DOT_HOT_TYPES.contains(&t))
        || effects.iter().any(|e| hp_per_tick().is_match(e))
    {
        return DurationCategory::DotHot;
    }
    if effects.iter().any(|e| cc_effect_head().is_match(e))
        || eqlog::stems::cc_stems_test(name)
        || eqlog::stems::charm_stems_test(name)
    {
        return DurationCategory::CrowdControl;
    }
    if effects.iter().all(|e| counter_line().is_match(e)) {
        return DurationCategory::Unstated;
    }
    match nature {
        Nature::Detrimental => DurationCategory::Debuff,
        _ => DurationCategory::Buff,
    }
}

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
    /// Which rate this spell's duration grows at per upgrade tier — see [`category_of`].
    pub category: DurationCategory,
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
            let nature = nature_of(s.spell_type.as_deref());
            by_key.insert(
                db_canon_key(&s.name),
                SpellRow {
                    name: s.name.clone(),
                    duration_ms: s.duration_ms,
                    duration_text: s.duration_text.clone(),
                    illusion: s.illusion,
                    nature,
                    category: category_of(
                        &s.name,
                        s.spell_type.as_deref(),
                        nature,
                        s.effects.as_deref().unwrap_or(&[]),
                    ),
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

    /// The category is read off the effect list, so a DoT filed as `Detrimental` is still a DoT and
    /// a mana-regen buff is never a HoT.
    #[test]
    fn a_duration_category_is_what_the_effect_list_says() {
        let dot = |e: &[&str]| {
            category_of(
                "Heat Blood",
                Some("Detrimental"),
                Nature::Detrimental,
                &e.iter().map(|x| x.to_string()).collect::<Vec<_>>(),
            )
        };
        assert_eq!(
            dot(&["Decrease Hitpoints by 17 per tick"]),
            DurationCategory::DotHot
        );
        assert_eq!(
            dot(&["Decrease Attack Speed by 30%"]),
            DurationCategory::Debuff
        );
        // Counter bookkeeping alone never said what the spell does.
        assert_eq!(
            dot(&["Increase Curse Counter by 8"]),
            DurationCategory::Unstated
        );
        assert_eq!(dot(&[]), DurationCategory::Unstated);
        // A mana regen line is a buff, not a HoT.
        assert_eq!(
            category_of(
                "Clarity",
                Some("Beneficial"),
                Nature::Beneficial,
                &["Increase Mana by 4 per tick (L29) to 7 per tick (L60)".to_string()]
            ),
            DurationCategory::Buff
        );
        // The hold heads are anchored: a melee proc named for a stun is not a stun.
        assert_eq!(
            category_of(
                "Blessing of Steel",
                Some("Beneficial"),
                Nature::Beneficial,
                &["Add Melee Proc: Stunning Strike".to_string()]
            ),
            DurationCategory::Buff
        );
        assert_eq!(
            category_of(
                "Engulfing Roots",
                Some("Detrimental"),
                Nature::Detrimental,
                &["Root".to_string()]
            ),
            DurationCategory::CrowdControl
        );
    }

    /// The membership over the COMMITTED catalog, pinned so a re-scrape that re-files a spell moves
    /// a number here rather than a bar in front of a player.
    #[test]
    fn the_committed_catalog_falls_into_known_category_counts() {
        let facts = SpellFacts::project(&eqlog::spelldb::shared());
        let mut counts = std::collections::BTreeMap::new();
        for row in facts.by_key.values() {
            if row.duration_ms.unwrap_or(0) > 0 {
                *counts.entry(format!("{:?}", row.category)).or_insert(0) += 1;
            }
        }
        assert_eq!(
            counts
                .iter()
                .map(|(k, v)| (k.as_str(), *v))
                .collect::<Vec<_>>(),
            vec![
                ("Buff", 486),
                ("CrowdControl", 90),
                ("Debuff", 123),
                ("DotHot", 193),
                ("ProcBuff", 1),
                ("Unstated", 3),
            ]
        );
        // The reported spell: its page lists a curse counter and no damage line, so the catalog
        // never says it ticks and it takes the conservative rate rather than a debuff's.
        assert_eq!(
            facts.get(&db_canon_key("Odium")).map(|r| r.category),
            Some(DurationCategory::Unstated)
        );
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
