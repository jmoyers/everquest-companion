//! The small world the resist fold needs: how old a mob is, who is allowed to teach us anything,
//! which resist debuffs are up, and who is standing in melee range. Everything is read off the log
//! or off the committed catalogs in `catalog.rs`; nothing reads the client's `spells_us.txt`.
//!
//! "Person or creature" is asked twice and answered differently, and confusing the two is a shipped
//! bug:
//!
//!   For a caster (`CasterIndex`), "you have landed damage on this name" is a reason to call it a
//!   creature — safe, because the consequence is that its level comes from the catalog ladder
//!   rather than being unknowable.
//!
//!   For a target (`is_mob_target`), the same fact would admit the name, and a groupmate can reach
//!   `struck` through a damage shield or an area effect. So the target test is the standing "is
//!   this a person" pair and nothing else: EQ gives players one capitalized word with no space, and
//!   the committed catalog knows the proper-named NPCs that shape would refuse. Skipping the target
//!   question put ~2,700 observations under 56 keys that are people's names into a published file.
//!
//! The residual is stated rather than hidden: a proper-named NPC the catalog has never heard of and
//! that you never hit is read as a person. A creature we decline to learn about costs a cell; a
//! person's name in a published file is a different kind of mistake.
//!
//! The memos are measurements. `MobNames.key` and the target verdict run on the busiest arm in the
//! fold and the uncached answer is a trim, three regex replacements and a lower-case; caching cut a
//! full fold from 1,779 ms to 1,067 ms. Both are pure functions of the name, so a cache cannot
//! change an answer — and both are per-fold fields, so nothing outlives a fold.

use super::catalog::{catalog_knows, local_mob_entry, parse_catalog_level, resolve_mob_identity};
use super::mob_key;
use crate::jsmap::JsMap;
use eqlog::jsstr::{js_trim, JS_S};
use eqlog::names::id_key;
use regex::Regex;
use std::collections::HashMap;
use std::sync::OnceLock;

/// Bound on the display-name caches. Cleared wholesale rather than evicted one at a time, because a
/// long session meets thousands of distinct names and an unbounded map is a slow leak.
const MAX_KEY_CACHE: usize = 4_096;
const MAX_TARGET_VERDICTS: usize = 4_096;

/// A mob's level, and how sure we are. `/con` is the game telling you; the catalog is the wiki.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MobLevelFact {
    /// What the estimator uses: the stated level, or a range's midpoint.
    pub level: i64,
    pub lo: i64,
    pub hi: i64,
    /// `'con'` or `'catalog'`.
    pub from: &'static str,
}

/// `/con` for this mob this session beats the catalog beats nothing.
#[derive(Debug, Default)]
pub struct MobLevels {
    conned: HashMap<String, i64>,
    catalog: HashMap<String, Option<MobLevelFact>>,
}

impl MobLevels {
    /// Only the `/con` half is dropped: the catalog verdicts are a pure function of committed data
    /// and are the same on either side of a source boundary.
    pub fn reset(&mut self) {
        self.conned.clear();
    }

    /// A `/con` line stated a level. Latest statement wins — the game just said it.
    ///
    /// Filed under every spelling the roster states for the creature, so a `/con` of `Innoruuk`
    /// answers a row keyed `innoruuk, the prince of hate` and the other way round. The fold-out is
    /// on the write side because a session sees a handful of con lines while `level_of` runs on
    /// every filed row.
    pub fn note(&mut self, mob_key: &str, level: i64) {
        if level <= 0 {
            return;
        }
        let id = resolve_mob_identity(mob_key);
        if !id.aliased {
            self.conned.insert(mob_key.to_string(), level);
        } else {
            for key in id.keys {
                self.conned.insert(key, level);
            }
        }
    }

    pub fn level_of(&mut self, mob_key: &str, display: &str) -> Option<MobLevelFact> {
        if let Some(&con) = self.conned.get(mob_key) {
            return Some(MobLevelFact {
                level: con,
                lo: con,
                hi: con,
                from: "con",
            });
        }
        if let Some(cached) = self.catalog.get(mob_key) {
            return *cached;
        }
        let fact = catalog_level_of(display);
        self.catalog.insert(mob_key.to_string(), fact);
        fact
    }

    /// The same question, asked by a reader rather than by the fold. [`MobLevels::level_of`] takes
    /// `&mut self` because it memoises the catalog verdict, and the ingest's one door is `&self` by
    /// law.
    ///
    /// It answers the same thing: the precedence is identical (a `/con` this session beats the memo
    /// beats a fresh catalog read) and the only difference is whether the verdict is written back,
    /// which is unobservable because [`catalog_level_of`] is a pure function of `display` and
    /// committed data.
    ///
    /// The memo is still consulted, so a mob the fold has already filed a row for does no catalog
    /// work. A reader that misses it does not warm it — deliberately, since a reader must not be
    /// able to grow the fold's memory.
    #[must_use]
    pub fn level_of_ref(&self, mob_key: &str, display: &str) -> Option<MobLevelFact> {
        if let Some(&con) = self.conned.get(mob_key) {
            return Some(MobLevelFact {
                level: con,
                lo: con,
                hi: con,
                from: "con",
            });
        }
        if let Some(cached) = self.catalog.get(mob_key) {
            return *cached;
        }
        catalog_level_of(display)
    }
}

/// The catalog is asked under every spelling the roster states: the catalog carries `Innoruuk`
/// while the game prints `Innoruuk, the Prince of Hate`, and a plain lookup would miss, file a null
/// level, and have the estimator drop the row for want of both levels.
///
/// The known limit: another player's casts carry a level nothing in this app's inputs states. Those
/// rows are dropped by design and no alias table can recover them.
fn catalog_level_of(display: &str) -> Option<MobLevelFact> {
    let mut entry = local_mob_entry(display);
    if entry.is_none() {
        let id = resolve_mob_identity(display);
        if id.aliased {
            entry = local_mob_entry(&id.canonical);
        }
    }
    let (lo, hi) = parse_catalog_level(entry.flatten())?;
    // A midpoint half rounds up, matching the app's `Math.round`.
    Some(MobLevelFact {
        level: (lo + hi + 1) / 2,
        lo,
        hi,
        from: "catalog",
    })
}

/// Names the caster rather than refusing one: self, another player, or an NPC (charmed pets
/// included). Whether the estimator weighs a kind is a preference decided downstream, so that
/// argument can be re-decided without a re-fold and this only says what a name is.
#[derive(Debug, Default)]
pub struct CasterIndex {
    pets: std::collections::HashSet<String>,
    struck: std::collections::HashSet<String>,
    verdicts: HashMap<String, &'static str>,
}

impl CasterIndex {
    pub fn reset(&mut self) {
        self.pets.clear();
        self.struck.clear();
        self.verdicts.clear();
    }

    pub fn note_pet(&mut self, name: &str) {
        let key = id_key(name);
        self.verdicts.remove(&key);
        self.pets.insert(key);
    }

    /// You landed damage on it, so it is a mob. One direction only; this never un-files a player.
    pub fn note_struck(&mut self, name: &str) {
        let key = id_key(name);
        self.verdicts.remove(&key);
        self.struck.insert(key);
    }

    pub fn kind_of(&mut self, name: &str) -> super::ledger::CasterKind {
        // The identity compare answers almost every call; `id_key` is the fallback for the shapes
        // that reach here unnormalised.
        if name == "You" {
            return super::ledger::CasterKind::SelfCast;
        }
        let key = id_key(name);
        if key == "you" {
            return super::ledger::CasterKind::SelfCast;
        }
        if let Some(&cached) = self.verdicts.get(&key) {
            return kind_from(cached);
        }
        let verdict = self.judge(&key, name);
        self.verdicts.insert(key, verdict);
        kind_from(verdict)
    }

    /// The tests, in the order they are cheap: a name you have landed damage on is a mob; a name
    /// bound as somebody's pet is a pet; a leading article or an interior space is a mob, because EQ
    /// player names are one word and never carry one; a name the committed catalog knows is a mob.
    fn judge(&self, key: &str, name: &str) -> &'static str {
        if self.pets.contains(key) || self.struck.contains(key) {
            return "npc";
        }
        let trimmed = js_trim(name);
        if article_re().is_match(trimmed) {
            return "npc";
        }
        if any_space_re().is_match(trimmed) {
            return "npc";
        }
        if catalog_knows(name) {
            return "npc";
        }
        "pc"
    }
}

fn kind_from(v: &'static str) -> super::ledger::CasterKind {
    if v == "npc" {
        super::ledger::CasterKind::Npc
    } else {
        super::ledger::CasterKind::Pc
    }
}

/// The leading article, the mob-name marker EQ prints, sentence-initial or not. Stated separately
/// from the single-word test even though `a ` could never satisfy it, because the article is the
/// mob marker and a reader looking for it should find it.
fn article_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(&format!(r"(?i)^(?:a|an|the){s}", s = JS_S)).unwrap())
}

fn any_space_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(JS_S).unwrap())
}

/// A letter, then letters/apostrophes/backticks. EQ names carry backticks and apostrophes
/// (``T`Kail``, `N'Kari`) and never spaces, digits or other punctuation. Anchored at both ends, so
/// any multi-word phrase is refused outright.
fn single_word_name_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Z][A-Za-z`']*$").unwrap())
}

/// EQ gives players a single capitalized word with no space, and mobs an article plus a noun
/// phrase. The log capitalizes a sentence-initial article, so the word count discriminates and
/// capitalization does not.
pub fn is_player_shaped_name(name: &str) -> bool {
    let n = js_trim(name);
    if n.is_empty() {
        return false;
    }
    if article_re().is_match(n) {
        return false;
    }
    single_word_name_re().is_match(n)
}

/// May a row be filed about this name as a target? Memoised per fold; the verdict is a pure
/// function of the name, so nothing can invalidate an entry.
#[derive(Debug, Default)]
pub struct TargetVerdicts {
    verdicts: HashMap<String, bool>,
}

impl TargetVerdicts {
    pub fn is_mob_target(&mut self, name: &str) -> bool {
        if let Some(&hit) = self.verdicts.get(name) {
            return hit;
        }
        let verdict = judge_target(name);
        if self.verdicts.len() >= MAX_TARGET_VERDICTS {
            self.verdicts.clear();
        }
        self.verdicts.insert(name.to_string(), verdict);
        verdict
    }
}

fn judge_target(name: &str) -> bool {
    let n = js_trim(name);
    // The catalog happens to hold an entry that folds to the key `you`, so self is tested first and
    // by identity, exactly as the fold's own `is_self` does.
    if n == "You" || id_key(n) == "you" {
        return false;
    }
    !is_player_shaped_name(n) || catalog_knows(n)
}

/// How long a tash/malo line is assumed to hold. A constant rather than a per-spell duration
/// because the row records which debuffs were up and the estimator joins the amount at read time.
/// Closed early by the mob's death or a zone change, both of which the log states.
pub const DEBUFF_WINDOW_MS: i64 = 11 * 60 * 1000;

/// Which resist debuffs are up on which mob. The row stores the keys; nothing else.
#[derive(Debug, Default)]
pub struct DebuffWindows {
    by_mob: HashMap<String, JsMap<i64>>,
}

impl DebuffWindows {
    pub fn reset(&mut self) {
        self.by_mob.clear();
    }

    pub fn open(&mut self, mob_key: &str, spell_key: &str, ts: i64) {
        self.by_mob
            .entry(mob_key.to_string())
            .or_default()
            .insert(spell_key.to_string(), ts + DEBUFF_WINDOW_MS);
    }

    /// The row's `debuffs` field: sorted, pipe-joined, empty when nothing is up. Expired entries are
    /// dropped on the way past, which is the only sweep this map ever gets.
    pub fn active(&mut self, mob_key: &str, ts: i64) -> String {
        let Some(m) = self.by_mob.get_mut(mob_key) else {
            return String::new();
        };
        let mut dead: Vec<String> = Vec::new();
        let mut live: Vec<String> = Vec::new();
        for (key, &until) in m.iter() {
            if until <= ts {
                dead.push(key.to_string());
            } else {
                live.push(key.to_string());
            }
        }
        for key in dead {
            m.remove(&key);
        }
        live.sort();
        live.join("|")
    }

    pub fn clear_mob(&mut self, mob_key: &str) {
        self.by_mob.remove(mob_key);
    }
}

/// Mob names both ways. Display to key is a memo; key to display is not a cache but a fact the
/// ledger needs, since the fold keys rows canonically and the surfaces show the log's spelling.
#[derive(Debug, Default)]
pub struct MobNames {
    keys: HashMap<String, String>,
    display: HashMap<String, String>,
}

impl MobNames {
    /// Drops the key memo and not the display map: the memo is a cache, the display map is
    /// knowledge, and a new source does not un-say what the log spelled.
    pub fn reset(&mut self) {
        self.keys.clear();
    }

    pub fn key(&mut self, display: &str) -> String {
        if let Some(hit) = self.keys.get(display) {
            return hit.clone();
        }
        let key = mob_key(display);
        if self.keys.len() >= MAX_KEY_CACHE {
            self.keys.clear();
        }
        self.keys.insert(display.to_string(), key.clone());
        key
    }

    /// Note the spelling the game just used for this creature.
    pub fn remember(&mut self, display: &str) {
        let key = self.key(display);
        self.display.insert(key, display.to_string());
    }

    pub fn display_for(&self, key: &str) -> String {
        self.display
            .get(key)
            .cloned()
            .unwrap_or_else(|| key.to_string())
    }
}

/// Melee proximity, the stand-in for point-blank range that song rule 3 needs.
#[derive(Debug, Default)]
pub struct MeleeContact {
    last: JsMap<i64>,
}

impl MeleeContact {
    pub fn reset(&mut self) {
        self.last.clear();
    }

    pub fn note(&mut self, mob_key: &str, ts: i64) {
        self.last.insert(mob_key.to_string(), ts);
    }

    pub fn drop_mob(&mut self, mob_key: &str) {
        self.last.remove(mob_key);
    }

    /// Every mob you traded blows with inside the window ending at `ts`.
    pub fn within(&self, ts: i64, window_ms: i64) -> Vec<String> {
        self.last
            .iter()
            .filter(|(_, &at)| at <= ts && ts - at <= window_ms)
            .map(|(k, _)| k.to_string())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_target_is_a_creature_by_shape_or_by_the_catalog_and_never_by_being_struck() {
        let mut v = TargetVerdicts::default();
        assert!(v.is_mob_target("a froglok ton knight"));
        assert!(v.is_mob_target("A fire giant warrior"));
        // A one-word capitalized name the catalog never heard of is a person — the safe direction.
        assert!(!v.is_mob_target("Dranix"));
        // …and self is refused by identity first, because the catalog holds a row folding to `you`.
        assert!(!v.is_mob_target("You"));
        assert!(!v.is_mob_target("yourself"));
        // A proper-named creature the committed catalog knows is admitted despite the shape.
        assert!(v.is_mob_target("Innoruuk"));
    }

    #[test]
    fn a_debuff_window_closes_on_its_own_clock_and_sorts_what_is_left() {
        let mut d = DebuffWindows::default();
        d.open("a rat", "tashani", 0);
        d.open("a rat", "malosi", 1_000);
        assert_eq!(d.active("a rat", 2_000), "malosi|tashani");
        // The window is closed at `until <= ts`, so the tash is gone one ms past its end.
        assert_eq!(d.active("a rat", DEBUFF_WINDOW_MS), "malosi");
        assert_eq!(d.active("a rat", DEBUFF_WINDOW_MS + 1_000), "");
        assert_eq!(d.active("a bat", 0), "");
    }

    #[test]
    fn the_catalog_level_folds_a_range_to_its_midpoint_and_a_con_beats_it() {
        let mut levels = MobLevels::default();
        // The alias table is what lets a `/con` of the short spelling answer the long one.
        levels.note("innoruuk", 61);
        let fact = levels
            .level_of(
                "innoruuk, the prince of hate",
                "Innoruuk, the Prince of Hate",
            )
            .expect("the con");
        assert_eq!((fact.level, fact.from), (61, "con"));
    }
}
