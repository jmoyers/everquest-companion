//! The four spell tables the ownership models read (`charmModel.ts` plus `petNudge.ts`'s summon
//! roster), built off the RAW rows of the committed `spells.json`:
//!
//!   cast times     longest `castTimeMs` per rank-folded key — the arm window.
//!   durations      longest raw `durationMs` per key — the provisional-bind horizon. Raw on purpose:
//!                  the parser's derived-durations pass rewrites the field and this table ignores it.
//!   pet targets    `targetType === 'Pet'` — the pet-only gate.
//!   charm messages charms whose cast-on-other sentence is not a charm broadcast, so they can never
//!                  be what a broadcast resolved.
//!
//! Reading the committed file rather than `eqlog::spelldb`'s effective table is what the TS does at
//! the same point in the chain: one file, two readers. `castTimeMs` is deliberately absent from
//! `eqlog::SpellEntry`, which carries only the fields the parser's output may depend on, so this
//! file declares its own row type rather than widening that one.
//!
//! Every table is a pure function of a committed file — no log bytes, no character, no clock — so
//! the `OnceLock`s here are compile-time constants computed late, not cached fold state.

use eqlog::jsstr::js_trim;
use eqlog::names::spell_canon_key;
use regex::Regex;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

/// One row of `spells.json`, as this file's four tables read it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Row {
    name: String,
    #[serde(default)]
    duration_ms: Option<i64>,
    #[serde(default)]
    cast_time_ms: Option<i64>,
    #[serde(default)]
    target_type: Option<String>,
    #[serde(default)]
    classes: Option<String>,
    #[serde(default)]
    msg_cast_on_other: Option<String>,
    #[serde(default)]
    effects: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct File {
    spells: Vec<Row>,
}

const SPELLS_JSON: &str = include_str!("../../../../../src/main/data/spells.json");
const OVERLAY_JSON: &str = include_str!("../../../eqlog/data/spell-overlay.json");

/// The `name` corrections of the spell overlay, as `data/spell-overlay.json` projects them.
///
/// Only `name`: of the fields these tables read, the corrected ones are never read in a way a
/// correction can move, and `msgCastOnOther` is taken off the raw row by construction. So `name` is
/// the whole of what a correction changes here (the DB says `Solon's Bravura`, the game prints
/// `Solon's Bewitching Bravura`).
#[derive(Deserialize)]
struct Sidecar {
    corrections: Vec<Correction>,
}

#[derive(Deserialize)]
struct Correction {
    spells: Vec<String>,
    field: String,
    to: String,
}

struct Tables {
    cast_ms: HashMap<String, i64>,
    duration_ms: HashMap<String, i64>,
    pet_target: HashSet<String>,
    charm_other_message: HashSet<String>,
    pet_summon: HashSet<String>,
    charm_roster: HashSet<String>,
}

fn tables() -> &'static Tables {
    static T: OnceLock<Tables> = OnceLock::new();
    T.get_or_init(build)
}

/// The longest figure any rank of a line carries, keyed by the rank-folded name. Non-positive and
/// absent figures are skipped alike.
fn longest_by_key(rows: &[Row], pick: fn(&Row) -> Option<i64>) -> HashMap<String, i64> {
    let mut m: HashMap<String, i64> = HashMap::new();
    for s in rows {
        let Some(ms) = pick(s) else { continue };
        if ms <= 0 {
            continue;
        }
        let key = spell_canon_key(&s.name);
        let slot = m.entry(key).or_insert(ms);
        if ms > *slot {
            *slot = ms;
        }
    }
    m
}

/// `spellEffectClass.ts`'s `summonPet` rule. Anchored at the head of the effect line, which is what
/// keeps `Pet Power Increase` and `Decrease Pet Size by 50%` out of the family.
fn summon_pet_effect(line: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"(?i)^summon (?:pet|spectre pet|skeleton pet)(?-u:\b)").unwrap()
    });
    re.is_match(js_trim(line))
}

/// The charm effect rule, reached through `eqlog::stems`'s port so this and the parser's own derived
/// roster cannot answer differently.
fn charm_effect(line: &str) -> bool {
    eqlog::stems::classify_effect_line_is_charm(js_trim(line))
}

/// The wiki's class column carries a `*` for every player-castable line.
fn player_castable(s: &Row) -> bool {
    s.classes.as_deref().unwrap_or("").contains('*')
}

fn build() -> Tables {
    let file: File = serde_json::from_str(SPELLS_JSON).expect("spells.json is not readable");
    let raw = file.spells;
    let corrected_names = corrected_names(&raw);

    let cast_ms = longest_by_key(&raw, |s| s.cast_time_ms);
    let duration_ms = longest_by_key(&raw, |s| s.duration_ms);

    let mut pet_target = HashSet::new();
    for s in &raw {
        if s.target_type.as_deref() == Some("Pet") {
            pet_target.insert(spell_canon_key(&s.name));
        }
    }

    // A line is a non-broadcast charm when EVERY rank stating a cast-on-other message states one
    // that is not a charm broadcast. Any rank saying a broadcast keeps the whole line eligible, so a
    // scrape that lost one rank's message cannot disqualify the spell.
    let mut stated: Vec<(String, bool)> = Vec::new();
    let mut at: HashMap<String, usize> = HashMap::new();
    for (i, s) in raw.iter().enumerate() {
        let Some(msg) = s.msg_cast_on_other.as_deref() else {
            continue;
        };
        if msg.is_empty() {
            continue;
        }
        let only_other = !CHARM_MESSAGES.contains(&msg);
        for name in [s.name.as_str(), corrected_names[i].as_str()] {
            let key = spell_canon_key(name);
            match at.get(&key) {
                Some(&slot) => stated[slot].1 = stated[slot].1 && only_other,
                None => {
                    at.insert(key.clone(), stated.len());
                    stated.push((key, only_other));
                }
            }
        }
    }
    let charm_other_message: HashSet<String> = stated
        .into_iter()
        .filter(|(_, only_other)| *only_other)
        .map(|(k, _)| k)
        .collect();

    // The pet-summon roster, both spellings entered. No target filter — a summon is cast on nobody,
    // so nearly every row is `Self` — but player-castable only, since NPC rows print no cast line.
    let mut pet_summon = HashSet::new();
    for (i, s) in raw.iter().enumerate() {
        let has = s
            .effects
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .any(|l| summon_pet_effect(l));
        if !has || !player_castable(s) {
            continue;
        }
        pet_summon.insert(spell_canon_key(&s.name));
        pet_summon.insert(spell_canon_key(&corrected_names[i]));
    }

    // The derived charm roster: every row whose effect list charms and that is not `Self`-targeted,
    // player-castable or not. Built over the raw rows plus the corrected names, which answers
    // identically to the parser's effective table — no removed row charms, and the one renamed charm
    // is entered under both spellings.
    let mut charm_roster = HashSet::new();
    for (i, s) in raw.iter().enumerate() {
        let charms = s
            .effects
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .any(|l| charm_effect(l));
        if !charms || s.target_type.as_deref() == Some("Self") {
            continue;
        }
        charm_roster.insert(spell_canon_key(&s.name));
        charm_roster.insert(spell_canon_key(&corrected_names[i]));
    }

    Tables {
        cast_ms,
        duration_ms,
        pet_target,
        charm_other_message,
        pet_summon,
        charm_roster,
    }
}

/// The corrected spelling of row `i`, or its own.
///
/// The name index is built once, before any correction runs, which matters when one correction
/// renames a row another then patches. A `name` correction writes every row of its name.
fn corrected_names(raw: &[Row]) -> Vec<String> {
    let mut out: Vec<String> = raw.iter().map(|s| s.name.clone()).collect();
    let sidecar: Sidecar =
        serde_json::from_str(OVERLAY_JSON).expect("spell-overlay.json is not readable");
    let mut by_name: HashMap<&str, Vec<usize>> = HashMap::new();
    for (i, s) in raw.iter().enumerate() {
        by_name.entry(s.name.as_str()).or_default().push(i);
    }
    for c in &sidecar.corrections {
        if c.field != "name" {
            continue;
        }
        for name in &c.spells {
            let Some(rows) = by_name.get(name.as_str()) else {
                continue;
            };
            for &i in rows {
                out[i] = c.to.clone();
            }
        }
    }
    out
}

/// The three wiki `msg_cast_on_other` sentences that ARE a charm broadcast: the enchanter ladder,
/// the Druid/Shaman ladder (`blinks.`) and the necromancer charm-undead ladder (`moans.`). The
/// bard's `'s eyes glaze over.` is deliberately absent — two charms and two real mezzes share it.
///
/// Only the enchanter sentence has been seen in a real log; the other two are covered structurally
/// and remain unverified against a live line.
const CHARM_MESSAGES: [&str; 3] = [
    "Someone has been charmed.",
    "Someone blinks.",
    "Someone moans.",
];

/// The arm window for one own cast of `spell`, in ms after the `You begin casting` line.
pub fn arm_window_ms(spell: &str) -> i64 {
    tables()
        .cast_ms
        .get(&spell_canon_key(spell))
        .copied()
        .unwrap_or(DEFAULT_CAST_MS)
        + CAST_SLACK_MS
}

/// How long an uncorroborated bind by `spell` may stand: the spell's own listed duration plus a
/// slack. Derived rather than tuned, because a charm cannot outlive its own spell.
pub fn provisional_window_ms(spell: &str) -> i64 {
    tables()
        .duration_ms
        .get(&spell_canon_key(spell))
        .copied()
        .unwrap_or(DEFAULT_CHARM_DURATION_MS)
        + DURATION_SLACK_MS
}

/// The game refuses one of these on anything but your own pet, which is the whole content of the
/// pet-only inference.
pub fn is_pet_only_spell(spell: &str) -> bool {
    tables().pet_target.contains(&spell_canon_key(spell))
}

/// The effect-derived charm roster, with the name stems as the fallback for a name the catalog does
/// not carry.
pub fn is_charm_spell(spell: &str) -> bool {
    tables().charm_roster.contains(&spell_canon_key(spell)) || eqlog::stems::charm_stems_test(spell)
}

/// Could a cast of `spell` have printed `<mob> has been charmed.`? For the third-party join only:
/// your own binds use the wider `is_charm_spell`, since that path is gated on `You begin casting`,
/// which nobody else prints.
pub fn is_charm_broadcast_spell(spell: &str) -> bool {
    is_charm_spell(spell)
        && !tables()
            .charm_other_message
            .contains(&spell_canon_key(spell))
}

/// Charm wins the overlap: a spell that charms must never read as a mez. The CC side stays the name
/// stems whether or not a DB is installed — installing one derives the charm roster and leaves this
/// test alone.
pub fn is_cc_spell(spell: &str) -> bool {
    let key = spell_canon_key(spell);
    !is_charm_spell(&key) && eqlog::stems::cc_stems_test(&key)
}

/// Pet-summon membership, as the log spelled it — rank tail and all.
pub fn is_pet_summon_spell(spell: &str) -> bool {
    tables().pet_summon.contains(&spell_canon_key(spell))
}

/// How long after a cast's nominal completion a broadcast may still be that cast's. EQ log stamps
/// truncate to whole seconds, so a cast begun at x.9s prints up to a second late; the measured max
/// overrun on the real log is +600 ms.
pub const CAST_SLACK_MS: i64 = 1_500;
/// Arm window for a charm/CC spell the DB has no cast time for: the longest charm cast the DB knows,
/// so an unknown spell gets the most generous honest window rather than one that drops real binds.
pub const DEFAULT_CAST_MS: i64 = 6_000;
/// How far a charm's own duration may overrun the DB's nominal figure. The wiki's durations are
/// level-scaled headline numbers, so this slack absorbs the scaling rather than the timing.
pub const DURATION_SLACK_MS: i64 = 60_000;
/// Duration for a charm the DB has no figure for — 16 minutes, which is what all but two charms in
/// the family are listed at.
pub const DEFAULT_CHARM_DURATION_MS: i64 = 960_000;
/// How long an unbound charm sighting is remembered so a later `… Master.'` tell can promote that
/// name to a charmed pet. Generous because the tell is ownership-definitive — no foreign charm in
/// the log has ever produced one — so a long memory costs only a handful of names.
pub const PROMOTE_MS: i64 = 600_000;

/// A single capitalized word with no space in it.
///
/// The word count is the discriminator, not the capitalization: the log capitalizes a
/// sentence-initial article (`A fire giant warrior begins singing …`), so the article test and the
/// anchored single-word test are two statements of one refusal.
pub fn is_player_shaped_name(name: &str) -> bool {
    static ARTICLE: OnceLock<Regex> = OnceLock::new();
    static WORD: OnceLock<Regex> = OnceLock::new();
    let n = js_trim(name);
    if n.is_empty() {
        return false;
    }
    // JS's `\s`, not Rust's; the two differ and `jsstr::JS_S` is the JS spelling.
    let article = ARTICLE
        .get_or_init(|| Regex::new(&format!(r"(?i)^(?:a|an|the){}", eqlog::jsstr::JS_S)).unwrap());
    if article.is_match(n) {
        return false;
    }
    let word = WORD.get_or_init(|| Regex::new(r"^[A-Z][A-Za-z`']*$").unwrap());
    word.is_match(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The arm window tracks the spell's own cast time; a flat window would miss most real charms.
    #[test]
    fn the_arm_window_is_the_spells_own_cast_time_plus_the_slack() {
        assert_eq!(arm_window_ms("Charm"), 2_400 + CAST_SLACK_MS);
        assert_eq!(
            arm_window_ms("Cajoling Whispers III"),
            5_500 + CAST_SLACK_MS
        );
        // A name the DB has no cast time for gets the most generous honest window.
        assert_eq!(
            arm_window_ms("Not A Spell At All"),
            DEFAULT_CAST_MS + CAST_SLACK_MS
        );
    }

    /// The bard's charm can never be what a charm broadcast resolved: its landing sentence is
    /// `Someone 's eyes glaze over.`, shared verbatim with real mezzes.
    #[test]
    fn the_bards_charm_is_a_charm_but_not_a_broadcast_charm() {
        assert!(is_charm_spell("Solon's Bewitching Bravura"));
        assert!(!is_charm_broadcast_spell("Solon's Bewitching Bravura"));
        assert!(is_charm_broadcast_spell("Allure"));
        assert!(is_charm_broadcast_spell("Cajoling Whispers"));
    }

    /// Charm wins the overlap — `Boltran's Agacerie` is a charm and must never read as a mez.
    #[test]
    fn charm_wins_the_cc_overlap() {
        assert!(is_cc_spell("Mesmerization VI"));
        assert!(!is_cc_spell("Boltran's Agacerie"));
        assert!(!is_cc_spell("Charm"));
    }

    #[test]
    fn the_pet_only_and_pet_summon_rosters_answer_their_own_families() {
        assert!(is_pet_only_spell("Burnout III"));
        assert!(!is_pet_only_spell("Charm"));
        assert!(is_pet_summon_spell("Kintaz's Animation"));
        assert!(!is_pet_summon_spell("Burnout III"));
    }

    /// A single capitalized word passes; every article-led mob name is refused, capitalized or not.
    #[test]
    fn the_player_shape_refuses_every_article_led_name() {
        assert!(is_player_shaped_name("Scooba"));
        assert!(is_player_shaped_name("T`Kail"));
        assert!(!is_player_shaped_name("a fire giant warrior"));
        assert!(!is_player_shaped_name("A fire giant warrior"));
        assert!(!is_player_shaped_name("The Hand of Veeshan"));
        assert!(!is_player_shaped_name(""));
    }
}
