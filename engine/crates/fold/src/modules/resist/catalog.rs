//! The three committed catalogs the resist fold consults, and the fourth it refuses.
//!
//! It never reads the client's `spells_us.txt`: everything a row records is something the log
//! printed, so the ledger means something without a file this project may not redistribute, and a
//! patch that retunes a spell costs a re-estimate rather than a re-fold. What it does consult:
//!
//!   * `mobs.json` — a creature's level when no `/con` has stated one, and, as a side effect, "the
//!     catalog has heard of this name", which admits a proper-named NPC as caster and as target.
//!   * `bosses.json` — the one place this tree states that two spellings are one creature.
//!   * the wiki spell catalog (`eqlog::spelldb`) — three facts and no more: is the spell a song, is
//!     a landing sentence known for it, is it a resist debuff.
//!
//! The `OnceLock`s memoize no fold answer: `include_str!` puts the catalog bytes in the binary and
//! each table is a pure function of those bytes, so a second `Fold` in the process cannot observe
//! one as different. The spell facts are projected out and the database handle dropped, which is
//! what keeps a fold from borrowing anything the parser owns; `spelldb::shared()` is the same
//! handle `eqlog::parser_for` installs, so the 386 ms build is paid once for both readers.

use eqlog::jsstr::JS_S;
use eqlog::names::spell_canon_key;
use regex::Regex;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::OnceLock;

use super::mob_key;

const MOBS_JSON: &str = include_str!("../../../../../../src/renderer/src/data/eqlegends/mobs.json");
const BOSSES_JSON: &str =
    include_str!("../../../../../../src/renderer/src/data/eqlegends/bosses.json");

/// One row of `mobs.json`, cut down to what the resist fold reads. The scrape carries `zones`,
/// `drops` and `loc` too; naming only these three is the claim that none of them is consulted.
#[derive(Debug, Deserialize)]
struct MobRow {
    page: String,
    name: String,
    #[serde(default)]
    level: Option<String>,
}

#[derive(Deserialize)]
struct MobFile {
    #[serde(default)]
    mobs: Vec<MobRow>,
}

/// Keyed by the page's `|name` (the in-game spelling a `/con` prints) first, then by the wiki page
/// title, which only fills gaps — so a real mob's own name can never be displaced by another page's
/// title. Both passes key through `mob_key`, which folds casing and the three apostrophe glyphs.
///
/// The stored value is the `level` free text and nothing else: the inner `Option` answers "what
/// level", the outer one answers "have you heard of this name".
fn mob_levels() -> &'static HashMap<String, Option<String>> {
    static T: OnceLock<HashMap<String, Option<String>>> = OnceLock::new();
    T.get_or_init(|| {
        let file: MobFile = serde_json::from_str(MOBS_JSON).expect("mobs.json is not readable");
        let mut by_name: HashMap<String, Option<String>> = HashMap::new();
        for m in &file.mobs {
            let key = mob_key(&m.name);
            if !key.is_empty() {
                by_name.entry(key).or_insert_with(|| m.level.clone());
            }
        }
        for m in &file.mobs {
            let key = mob_key(&m.page);
            if !key.is_empty() {
                by_name.entry(key).or_insert_with(|| m.level.clone());
            }
        }
        by_name
    })
}

/// The catalog's row for a mob, or `None` when it has none. The inner `Option<&str>` is the row's
/// free-text `level`, which is itself frequently absent.
pub fn local_mob_entry(name: &str) -> Option<Option<&'static str>> {
    mob_levels().get(&mob_key(name)).map(|lvl| lvl.as_deref())
}

/// True when the committed catalog has heard of this name at all.
pub fn catalog_knows(name: &str) -> bool {
    mob_levels().contains_key(&mob_key(name))
}

#[derive(Debug, Deserialize)]
struct BossTarget {
    name: String,
    #[serde(default, rename = "match")]
    matches: Vec<String>,
}

#[derive(Deserialize)]
struct BossFile {
    #[serde(default)]
    targets: Vec<BossTarget>,
}

/// One creature and every spelling the roster states for it.
#[derive(Debug, Clone)]
pub struct MobIdentity {
    /// The name to ask the catalog with: the roster's own `name`, never what a surface displays.
    pub canonical: String,
    /// Every `mob_key` the creature answers to, canonical key first.
    pub keys: Vec<String>,
    /// The roster stated more than one spelling for this creature.
    pub aliased: bool,
}

/// A target whose `name` and every `match` collapse to one key is not indexed at all, so every
/// unaliased name gets the trivial identity and runs the ordinary path.
fn alias_index() -> &'static HashMap<String, MobIdentity> {
    static T: OnceLock<HashMap<String, MobIdentity>> = OnceLock::new();
    T.get_or_init(|| {
        let file: BossFile =
            serde_json::from_str(BOSSES_JSON).expect("bosses.json is not readable");
        let mut out: HashMap<String, MobIdentity> = HashMap::new();
        for t in &file.targets {
            let mut keys: Vec<String> = Vec::new();
            for spelling in std::iter::once(&t.name).chain(t.matches.iter()) {
                let k = mob_key(spelling);
                if !k.is_empty() && !keys.contains(&k) {
                    keys.push(k);
                }
            }
            if keys.len() < 2 {
                continue;
            }
            let id = MobIdentity {
                canonical: t.name.clone(),
                keys: keys.clone(),
                aliased: true,
            };
            // A key claimed by two targets keeps the first: silently merging two creatures on a
            // later scrape is not something this boundary should be able to do by accident.
            for k in keys {
                out.entry(k).or_insert_with(|| id.clone());
            }
        }
        out
    })
}

/// Any spelling to the one identity the roster states, or to itself when the roster has never
/// heard of it.
pub fn resolve_mob_identity(name: &str) -> MobIdentity {
    let key = mob_key(name);
    if let Some(known) = alias_index().get(&key) {
        return known.clone();
    }
    MobIdentity {
        canonical: name.to_string(),
        keys: if key.is_empty() {
            Vec::new()
        } else {
            vec![key]
        },
        aliased: false,
    }
}

/// The three facts the fold projects out of the wiki spell catalog.
#[derive(Debug, Clone, Default)]
pub struct SpellFacts {
    /// The Bard is the only class the catalog says can learn it. "Only" is load-bearing: a handful
    /// of lines are shared with other classes and those roll once per cast like anything else.
    pub song: bool,
    /// The catalog knows a cast-on-other sentence, so every pulse that lands prints one and the
    /// denominator is exact — lands plus resists, with nothing reconstructed.
    pub landing: bool,
    /// The level the catalog says a bard learns this at, or `None` when it names no class.
    pub learned_at: Option<i64>,
    /// An effect line that opens with `Decrease <axis> Resist`. Anchored, because a stem match
    /// would find "Resist" inside a spell name.
    pub resist_debuff: bool,
}

fn spell_facts_table() -> &'static HashMap<String, SpellFacts> {
    static T: OnceLock<HashMap<String, SpellFacts>> = OnceLock::new();
    T.get_or_init(|| {
        let db = eqlog::spelldb::shared();
        let mut out = HashMap::new();
        for (key, entry) in db.by_key_entries() {
            let levels = parse_spell_class_levels(entry.classes.as_deref());
            let resist_debuff = entry
                .effects
                .as_deref()
                .unwrap_or(&[])
                .iter()
                .any(|line| resist_debuff_line().is_match(eqlog::jsstr::js_trim(line)));
            out.insert(
                key.to_string(),
                SpellFacts {
                    song: !levels.is_empty() && levels.iter().all(|&(cls, _)| cls == "BRD"),
                    landing: entry
                        .msg_cast_on_other
                        .as_deref()
                        .is_some_and(|m| !m.is_empty()),
                    // Levels are lowest-per-class and sorted ascending, so the first row is the
                    // level a bard gets the line at.
                    learned_at: levels.first().map(|(_, lvl)| *lvl),
                    resist_debuff,
                },
            );
        }
        out
    })
}

fn resist_debuff_line() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(&format!(
            r"(?i)^Decrease{s}+(?:Magic|Fire|Cold|Poison|Disease|All){s}+Resists?(?-u:\b)",
            s = JS_S
        ))
        .unwrap()
    })
}

/// The facts for a spell name.
///
/// The two key spellings are deliberately different: the table is built under the spell db's own
/// canon key (case-insensitive rank tail) and the query uses `spell_canon_key` (case-sensitive).
/// Merging them would be a third answer to a question already decided twice.
pub fn facts_for_key(spell_key: &str) -> SpellFacts {
    spell_facts_table()
        .get(spell_key)
        .cloned()
        .unwrap_or_default()
}

/// Asked with a display name, so it canonicalizes first.
pub fn is_resist_debuff(display: &str) -> bool {
    facts_for_key(&spell_canon_key(display)).resist_debuff
}

/// The per-class entry levels off a wiki `classes` blob: lowest per class, sorted by level then
/// class code. Neither caller can see the tie order; the sort is kept so this stays the same
/// function as the app's rather than a subset of it.
fn parse_spell_class_levels(classes: Option<&str>) -> Vec<(&'static str, i64)> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(&format!(
            r"\*{s}*([A-Za-z][A-Za-z ]*?){s}*-{s}*Level{s}*([0-9]+)",
            s = JS_S
        ))
        .unwrap()
    });
    let Some(classes) = classes else {
        return Vec::new();
    };
    let mut best: Vec<(&'static str, i64)> = Vec::new();
    for m in re.captures_iter(classes) {
        let Some(cls) = abbr_by_name(&eqlog::jsstr::js_trim(&m[1]).to_lowercase()) else {
            continue;
        };
        let Ok(level) = m[2].parse::<i64>() else {
            continue;
        };
        match best.iter_mut().find(|(c, _)| *c == cls) {
            Some(slot) => {
                if level < slot.1 {
                    slot.1 = level;
                }
            }
            None => best.push((cls, level)),
        }
    }
    best.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(b.0)));
    best
}

/// The wiki class name to the `/who` code, both spellings of Shadow Knight included.
fn abbr_by_name(name: &str) -> Option<&'static str> {
    Some(match name {
        "bard" => "BRD",
        "beastlord" => "BST",
        "berserker" => "BER",
        "cleric" => "CLR",
        "druid" => "DRU",
        "enchanter" => "ENC",
        "magician" => "MAG",
        "monk" => "MNK",
        "necromancer" => "NEC",
        "paladin" => "PAL",
        "ranger" => "RNG",
        "rogue" => "ROG",
        "shadow knight" | "shadowknight" => "SHD",
        "shaman" => "SHM",
        "warrior" => "WAR",
        "wizard" => "WIZ",
        _ => return None,
    })
}

/// How many of a `/who` row's class codes are non-hybrid casters: the `-15`-each half of the
/// overchannel adjust. An unknown loadout answers 0, the honest floor.
///
/// The seven are the game's own "pure caster" grouping, spelled out rather than read out of a data
/// file so a catalog change cannot silently move what a resist estimate means.
pub fn caster_class_count(classes: &[String]) -> i64 {
    classes
        .iter()
        .filter(|c| {
            matches!(
                eqlog::jsstr::js_trim(c).to_uppercase().as_str(),
                "CLR" | "DRU" | "ENC" | "MAG" | "NEC" | "SHM" | "WIZ"
            )
        })
        .count() as i64
}

/// The catalog's `level` is free text scraped off a wiki page: "39", "39 - 43", "45-50". Two
/// numbers is a range, one is a level, anything else says nothing and is refused rather than
/// guessed at.
pub fn parse_catalog_level(text: Option<&str>) -> Option<(i64, i64)> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"[0-9]+").unwrap());
    let text = text?;
    let nums: Vec<&str> = re.find_iter(text).map(|m| m.as_str()).take(2).collect();
    if nums.is_empty() {
        return None;
    }
    // A digit run too long for an `i64` would fail the `hi > 200` test anyway; refusing it here is
    // the same verdict by a shorter road.
    let lo = nums[0].parse::<i64>().ok()?;
    let hi = if nums.len() > 1 {
        nums[1].parse::<i64>().ok()?
    } else {
        lo
    };
    if lo <= 0 || hi < lo || hi > 200 {
        return None;
    }
    Some((lo, hi))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_catalog_level_text_is_read_or_refused_and_never_guessed() {
        assert_eq!(parse_catalog_level(Some("39")), Some((39, 39)));
        assert_eq!(parse_catalog_level(Some("39 - 43")), Some((39, 43)));
        assert_eq!(parse_catalog_level(Some("45-50")), Some((45, 50)));
        assert_eq!(parse_catalog_level(Some("unknown")), None);
        assert_eq!(parse_catalog_level(None), None);
        // hi < lo, and a level above 200, are both refusals rather than repairs.
        assert_eq!(parse_catalog_level(Some("50-45")), None);
        assert_eq!(parse_catalog_level(Some("0")), None);
        assert_eq!(parse_catalog_level(Some("300")), None);
    }

    #[test]
    fn the_roster_states_which_spellings_are_one_creature() {
        let id = resolve_mob_identity("Innoruuk, the Prince of Hate");
        assert!(id.aliased, "the roster names both spellings");
        assert!(id.keys.contains(&"innoruuk".to_string()));
        let plain = resolve_mob_identity("a giant rat");
        assert!(!plain.aliased);
        assert_eq!(plain.keys, vec!["a giant rat".to_string()]);
        assert_eq!(plain.canonical, "a giant rat");
    }

    #[test]
    fn the_committed_mob_catalog_answers_by_either_spelling() {
        // The page's `|name` is the spelling a `/con` prints; the folded key finds it any casing.
        assert!(catalog_knows("a Alchemist`s Acolyte"));
        assert!(catalog_knows("A ALCHEMIST'S ACOLYTE"));
        assert!(!catalog_knows("Dranix"));
    }

    #[test]
    fn the_caster_class_count_admits_only_the_seven_pure_casters() {
        let who: Vec<String> = ["PAL", "ENC", "SHM"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(caster_class_count(&who), 2);
        assert_eq!(caster_class_count(&[]), 0);
        assert_eq!(caster_class_count(&[" wiz ".to_string()]), 1);
    }
}
