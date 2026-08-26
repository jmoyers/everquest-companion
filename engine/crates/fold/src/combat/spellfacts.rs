//! THE FOUR SPELL TABLES THE OWNERSHIP MODELS READ — `charmModel.ts`'s module-level tables plus
//! `petNudge.ts`'s summon roster.
//!
//! ── WHY THIS READS `spells.json` AGAIN AND WHY THAT IS NOT A SECOND SOURCE ─────────────────────
//!
//! `eqlog::spelldb` already reads the same committed file, and it is the PARSER's copy: the whole
//! removals → derived-durations → corrections → placeholder chain, because a `buffApply`'s
//! `candidates` list IS that table. `charmModel.ts` deliberately does NOT read that copy — it
//! `import`s `spells.json` directly and builds four tables off the RAW rows:
//!
//!   `CAST_MS_BY_SPELL`      longest `castTimeMs` per rank-folded key — the ARM window.
//!   `DURATION_MS_BY_SPELL`  longest RAW `durationMs` per key — the provisional-bind horizon. Raw
//!                           on purpose: the parser's `applyDerivedDurations` pass REWRITES
//!                           `durationMs` from `durationText`, and this table predates and ignores
//!                           it.
//!   `PET_TARGET_SPELLS`     `targetType === 'Pet'` — JOS-188's pet-only gate.
//!   `CHARM_SPELLS_WITH_OTHER_CAST_MESSAGE` charms whose stated cast-on-other sentence is NOT one
//!                           of the three charm broadcasts, so they can never be what a broadcast
//!                           resolved (the bard's `Solon's Bewitching Bravura`).
//!
//! So this is the SAME read the TS makes, at the same point in the chain, rather than a second
//! opinion about the parser's table. One committed file, two readers, exactly as over there.
//!
//! ── `castTimeMs` IS NOT ON `eqlog::SpellEntry`, AND THAT IS DELIBERATE OVER THERE ───────────────
//!
//! `spelldb/mod.rs`'s header states that its struct carries only "the fields the PARSER's output
//! can depend on", and names `castTimeMs` as one of the eight it leaves out — leaving it out is
//! what makes the claim checkable. Widening that struct to serve this file would delete the claim,
//! so this file declares its own row type with its own fields and the two stay honest.
//!
//! ── STATIC, NOT A CACHE (ruling 18) ─────────────────────────────────────────────────────────────
//!
//! Every table below is a pure function of a COMMITTED FILE and of nothing else — no log bytes, no
//! character, no clock — so a `OnceLock` here is a compile-time constant computed late, not state
//! addressed by anything a fold produced. That is the distinction `names.rs` draws when it refuses
//! to port `spellCanonKey`'s memo: that one memoizes over PARSE INPUT and would outlive a parse.

use eqlog::jsstr::js_trim;
use eqlog::names::spell_canon_key;
use regex::Regex;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

/// One row of `spells.json`, as THIS file's four tables read it. See the header for why it is a
/// second declaration rather than a widening of the parser's.
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

/// The `name` corrections of `SPELL_CORRECTIONS`, as `data/spell-overlay.json` projects them.
///
/// ONLY `name`, and the restriction is measured rather than convenient: a correction can carry six
/// fields and the committed sidecar uses five of them, but the four tables here key on
/// `spellCanonKey(name)` and read `castTimeMs` / `durationMs` / `targetType` / `classes` /
/// `effects` / the RAW `msgCastOnOther`. Of those, `classes` and `spellType` are corrected and
/// neither is read as anything but "does it contain a `*`" (which no correction moves), and
/// `msgCastOnOther` is read from the RAW row by construction — `CHARM_SPELLS_WITH_OTHER_CAST_MESSAGE`
/// takes the message off `raw` and only the NAME off the corrected copy. So `name` is the whole of
/// what `applySpellCorrections` can move here, which is exactly the pair of spellings that file's
/// own comment says had to be entered ("`spells.json` says `Solon's Bravura`, the game prints
/// `Solon's Bewitching Bravura`").
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

/// `longestByKey` — the LONGEST figure any rank of a line carries, keyed by the rank-folded name.
/// Non-positive and absent figures are skipped alike, which is `typeof ms !== 'number' || ms <= 0`.
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

/// `spellEffectClass.ts`'s `summonPet` rule, which is the only effect rule this crate needs.
/// Anchored at the head of the effect line, exactly as the rule table states — the anchor is what
/// keeps `Pet Power Increase` and `Decrease Pet Size by 50%` out of the family.
fn summon_pet_effect(line: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"(?i)^summon (?:pet|spectre pet|skeleton pet)(?-u:\b)").unwrap()
    });
    re.is_match(js_trim(line))
}

/// `spellEffectClass.ts`'s `charm` rule — the same one `eqlog::stems` ports for the parser's own
/// derived roster, reached through that port so the two cannot answer differently.
fn charm_effect(line: &str) -> bool {
    eqlog::stems::classify_effect_line_is_charm(js_trim(line))
}

/// `isPlayerCastable` — the wiki's class column carries a `*` for every player-castable line.
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

    // `CHARM_SPELLS_WITH_OTHER_CAST_MESSAGE`: a line is in it when EVERY rank that states a
    // cast-on-other message states one that is NOT a charm broadcast. ANY rank saying a charm
    // broadcast keeps the whole line eligible — a scrape that lost one rank's message must not
    // disqualify the spell (world-model law 3: a partial oracle answers "unknown", never "no").
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

    // `PET_SUMMON_SPELLS` — `petSummonRoster` over the raw rows AND over the corrected copy, both
    // spellings entered. `targetOnly` is off (103 of the 104 rows are `Self`: a summon is cast on
    // nobody), `castableOnly` stays on (the three NPC-only rows never print a player cast line).
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

    // `derivedCharmRoster` — `charmRoster(db.spells, { castableOnly: false })`, i.e. every row
    // whose effect list charms and that is not `targetType: 'Self'`. Built over the RAW rows plus
    // the corrected names rather than over the parser's EFFECTIVE table, and the two answer
    // identically here: the only load-time pass that could move a member is `applySpellRemovals`,
    // whose two rows (`Invigor`, `Invisibility Versus Undead`) charm nothing, and the one charm a
    // `name` correction renames (`Solon's Bravura` → `Solon's Bewitching Bravura`) is entered under
    // BOTH spellings below and is answered by `CHARM_STEMS` under either in any case.
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

/// `applySpellCorrections(raw).spells[i].name` — the corrected spelling of row `i`, or its own.
///
/// The index is built ONCE before any correction runs (the TS behaviour, which matters for a pair
/// of corrections that rename a row another one then patches), and a `name` correction writes ALL
/// rows of its name — `rowsFor`'s rule for the three whole-row fields.
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

/// The three wiki `msg_cast_on_other` sentences that ARE a charm broadcast (JOS-250): the
/// enchanter ladder, the Druid/Shaman ladder (`Someone blinks.`) and the necromancer charm-undead
/// ladder (`Someone moans.`). The bard's `Someone 's eyes glaze over.` is deliberately absent — it
/// is IMPURE (two charms and two real mezzes share it), which is JOS-200's standing cost.
///
/// MEASURED, owner's whole log 2026-08-12: 456 `has been charmed.` lines, ZERO ` blinks.` and ZERO
/// ` moans.`, and zero of either in every committed fixture. The two added families are therefore
/// STRUCTURALLY covered and not verified against a real line, which is said out loud because the
/// awaiting-sample law asks which.
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

/// How long an UNCORROBORATED bind by `spell` may stand — the spell's own listed duration plus a
/// slack. DERIVED rather than tuned: a charm cannot outlive its own spell.
pub fn provisional_window_ms(spell: &str) -> i64 {
    tables()
        .duration_ms
        .get(&spell_canon_key(spell))
        .copied()
        .unwrap_or(DEFAULT_CHARM_DURATION_MS)
        + DURATION_SLACK_MS
}

/// `isPetOnlySpell` — the game refuses one of these on anything but YOUR OWN pet, which is the
/// whole content of the JOS-188 inference.
pub fn is_pet_only_spell(spell: &str) -> bool {
    tables().pet_target.contains(&spell_canon_key(spell))
}

/// `isCharmSpell` — `getParserConfig().charmSpell`, which is `derivedCharmRoster(db, CHARM_STEMS)`
/// once a spell DB is installed: the effect-derived roster, with the name stems as the fallback for
/// a name the catalog does not carry.
pub fn is_charm_spell(spell: &str) -> bool {
    tables().charm_roster.contains(&spell_canon_key(spell)) || eqlog::stems::charm_stems_test(spell)
}

/// Could a cast of `spell` have printed `<mob> has been charmed.`? The membership test for the
/// THIRD-PARTY join only — your own binds keep using the wider `is_charm_spell`, because that path
/// is gated on `You begin casting`, which nobody else prints.
pub fn is_charm_broadcast_spell(spell: &str) -> bool {
    is_charm_spell(spell)
        && !tables()
            .charm_other_message
            .contains(&spell_canon_key(spell))
}

/// `isCcSpell`. CHARM WINS THE OVERLAP: `Boltran's Agacerie` must never be read as a mez.
///
/// `ccSpell` is `CC_STEMS` itself whether or not a DB is installed — `installSpellDb` derives the
/// charm roster and leaves this one alone, and rulesets.ts calls that refusal "a finding rather
/// than an omission".
pub fn is_cc_spell(spell: &str) -> bool {
    let key = spell_canon_key(spell);
    !is_charm_spell(&key) && eqlog::stems::cc_stems_test(&key)
}

/// `isPetSummonSpell` — as the log spelled it, rank tail and all.
pub fn is_pet_summon_spell(spell: &str) -> bool {
    tables().pet_summon.contains(&spell_canon_key(spell))
}

// ── The charm-model constants, verbatim from charmModel.ts ────────────────────────────────────

/// How long after a cast's nominal completion a broadcast may still be that cast's. EQ log stamps
/// are truncated to whole seconds, so a cast begun at x.9s prints up to a second late; measured max
/// overrun on the real log is +600 ms.
pub const CAST_SLACK_MS: i64 = 1_500;
/// Arm window for a charm/CC spell the DB has no cast time for. 6000 ms is the longest charm cast
/// the DB knows (Allure), so an unknown spell gets the most generous honest window rather than a
/// guess that silently drops real binds.
pub const DEFAULT_CAST_MS: i64 = 6_000;
/// How far a charm's OWN duration may overrun the DB's nominal figure. The wiki's durations are
/// level-scaled headline numbers, so the slack absorbs the scaling rather than the timing.
pub const DURATION_SLACK_MS: i64 = 60_000;
/// Duration for a charm the DB has no figure for — 16 minutes, which is what every charm in the
/// family except Dictate (48 s) and Boltran's Agacerie (7 m) is listed at.
pub const DEFAULT_CHARM_DURATION_MS: i64 = 960_000;
/// How long an unbound charm sighting is remembered so a later `… Master.'` tell can PROMOTE that
/// name as a CHARMED pet. Generous on purpose: the tell is ownership-DEFINITIVE (0 of the 15
/// foreign charms in the log ever produced one), so a long memory costs a handful of names.
pub const PROMOTE_MS: i64 = 600_000;

/// `shared/playerShape.ts isPlayerShapedName` — a single capitalized word with no space in it.
///
/// CAPITALIZATION IS NOT THE DISCRIMINATOR AND THE WORD COUNT IS: the log capitalizes a
/// sentence-initial article (`A fire giant warrior begins singing …`), so the article test and the
/// anchored single-word test are two statements of the same refusal and both are spelled.
pub fn is_player_shaped_name(name: &str) -> bool {
    static ARTICLE: OnceLock<Regex> = OnceLock::new();
    static WORD: OnceLock<Regex> = OnceLock::new();
    let n = js_trim(name);
    if n.is_empty() {
        return false;
    }
    // `\s` is JS's, not Rust's — `jsstr::JS_S` is the catalogue entry for exactly this difference.
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

    /// The arm window tracks the SPELL'S CAST TIME, which is the measurement that overturned the
    /// briefed flat "<= 2s": a flat window would have bound Charm and missed 271 of the owner's 366
    /// real charms.
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

    /// The bard's charm can never be what a charm BROADCAST resolved: its landing sentence is
    /// `Someone 's eyes glaze over.`, shared verbatim with three real mezzes.
    #[test]
    fn the_bards_charm_is_a_charm_but_not_a_broadcast_charm() {
        assert!(is_charm_spell("Solon's Bewitching Bravura"));
        assert!(!is_charm_broadcast_spell("Solon's Bewitching Bravura"));
        assert!(is_charm_broadcast_spell("Allure"));
        assert!(is_charm_broadcast_spell("Cajoling Whispers"));
    }

    /// CHARM WINS THE OVERLAP — `Boltran's Agacerie` is a charm and must never read as a mez.
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
