//! The spell database the parser's output depends on. The `candidates` list a `buffApply` carries
//! is this table, so a golden cannot be matched without reproducing the load path exactly:
//!
//!   spells.json → removals → derived durations → corrections → placeholder blanking → build
//!               → overlay corrections mined from the committed baseline
//!
//! The committed JSON is `include_str!`d out of the app's own data directory, so there is exactly
//! one copy and a re-scrape reaches both readers at once.
//!
//! The era join is the one app pass absent here, and skipping it is a statement rather than an
//! omission: it writes exactly one field, which no table below indexes and no classifier reads.
//!
//! The two overlay lists are a sidecar, the one genuine duplication in this crate: they are
//! TypeScript arrays nothing here can import, so a generator projects the fields this parser needs
//! into `data/spell-overlay.json`. Two mechanisms guard the drift — the oracle regenerates the
//! sidecar and refuses to run when the committed copy is stale, and a list that moved without the
//! sidecar moves the app's goldens, so byte identity fails on the next check.

mod overlay;
mod passes;

pub use overlay::derive_landing_corrections;

use crate::names::db_canon_key;
use serde::Deserialize;
use std::collections::HashMap;

/// One row of `spells.json`: the fields the parser's output can depend on, and no others. The
/// scrape carries eight more that no classifier and no table below reads; leaving them out of the
/// struct is what makes that claim checkable rather than stated.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpellEntry {
    pub name: String,
    #[serde(default)]
    pub duration_text: Option<String>,
    #[serde(default)]
    pub duration_ms: Option<i64>,
    #[serde(default)]
    pub target_type: Option<String>,
    #[serde(default)]
    pub spell_type: Option<String>,
    #[serde(default)]
    pub classes: Option<String>,
    #[serde(default)]
    pub msg_cast_on_you: Option<String>,
    #[serde(default)]
    pub msg_cast_on_other: Option<String>,
    #[serde(default)]
    pub msg_wears_off: Option<String>,
    pub illusion: bool,
    #[serde(default)]
    pub effects: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct SpellDbFile {
    spells: Vec<SpellEntry>,
}

/// One cast-on-other suffix, precompiled. `index` is the entry's position in the insertion-ordered
/// suffix table and is the only thing that decides precedence when a line ends with two known
/// suffixes.
#[derive(Debug, Clone)]
pub struct SuffixEntry {
    pub tail: String,
    pub index: usize,
    pub cands: Vec<usize>,
}

pub struct SpellDb {
    pub spells: Vec<SpellEntry>,
    /// Canonical name to the first entry with it. Insertion order is kept because a reader walks it.
    by_key: HashMap<String, usize>,
    by_key_order: Vec<usize>,
    cast_on_you: HashMap<String, Vec<usize>>,
    wears_off: HashMap<String, Vec<usize>>,
    cast_on_other_by_last_word: HashMap<String, Vec<SuffixEntry>>,
    cast_on_other_unkeyed: Vec<SuffixEntry>,
    /// The derived charm roster, keyed by `spell_canon_key`.
    charm_keys: std::collections::HashSet<String>,
}

impl SpellDb {
    pub fn entry(&self, i: usize) -> &SpellEntry {
        &self.spells[i]
    }

    pub fn cast_on_you(&self, text: &str) -> Option<&[usize]> {
        self.cast_on_you.get(text).map(|v| v.as_slice())
    }

    /// Every canonical key the database carries. Exposed as the keys rather than as a `has()` so a
    /// fold can take an owned set and borrow nothing from the parser.
    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.by_key.keys().map(String::as_str)
    }

    pub fn wears_off(&self, text: &str) -> Option<&[usize]> {
        self.wears_off.get(text).map(|v| v.as_slice())
    }

    /// True when the derived roster — or, for a name the catalog does not carry, the stem roster —
    /// calls this spell a charm.
    pub fn is_charm_spell(&self, name: &str) -> bool {
        self.charm_keys
            .contains(&crate::names::spell_canon_key(name))
            || crate::stems::charm_stems_test(name)
    }

    /// One bucket lookup, then table order within it, then the (measured-empty) unkeyable list
    /// merged in by index.
    pub fn match_cast_on_other<'a>(&'a self, text: &str) -> Option<(&'a SuffixEntry, String)> {
        let last_word = match text.rfind(' ') {
            Some(at) => &text[at + 1..],
            None => text,
        };
        let bucket = self
            .cast_on_other_by_last_word
            .get(last_word)
            .map(|v| v.as_slice())
            .unwrap_or(&[]);
        let keyed = first_suffix_match(text, bucket);
        let unkeyed = if self.cast_on_other_unkeyed.is_empty() {
            None
        } else {
            first_suffix_match(text, &self.cast_on_other_unkeyed)
        };
        match (keyed, unkeyed) {
            (k, None) => k,
            (None, u) => u,
            (Some(k), Some(u)) => {
                if u.0.index < k.0.index {
                    Some(u)
                } else {
                    Some(k)
                }
            }
        }
    }
}

/// The two rejections are as load-bearing as the match.
fn first_suffix_match<'a>(
    text: &str,
    list: &'a [SuffixEntry],
) -> Option<(&'a SuffixEntry, String)> {
    for entry in list {
        if text.ends_with(&entry.tail) && text.len() > entry.tail.len() {
            let target = crate::jsstr::js_trim(&text[..text.len() - entry.tail.len()]);
            // The 60-character cap is a JS length: UTF-16 code units, not bytes and not chars.
            if !target.is_empty() && target.encode_utf16().count() <= 60 {
                return Some((entry, target.to_string()));
            }
        }
    }
    None
}

/// Strip the wiki's "Someone" subject, keeping a possessive tail.
pub fn cast_on_other_suffix(msg: &str) -> Option<String> {
    use regex::Regex;
    use std::sync::OnceLock;
    static SPACED: OnceLock<Regex> = OnceLock::new();
    static POSS: OnceLock<Regex> = OnceLock::new();
    static LEAD: OnceLock<Regex> = OnceLock::new();
    let s = crate::jsstr::JS_S;
    let spaced = SPACED
        .get_or_init(|| Regex::new(&format!(r"(?i)^Someone{s}+'s(?-u:\b)(.*)$", s = s)).unwrap());
    let poss = POSS.get_or_init(|| Regex::new(r"(?i)^Someone's(?-u:\b)(.*)$").unwrap());
    let lead = LEAD.get_or_init(|| Regex::new(&format!(r"(?i)^Someone{s}+(.*)$", s = s)).unwrap());
    let m = crate::jsstr::js_trim(msg);
    if let Some(c) = spaced.captures(m) {
        return Some(crate::jsstr::js_trim(&format!("'s{}", &c[1])).to_string());
    }
    if let Some(c) = poss.captures(m) {
        return Some(crate::jsstr::js_trim(&format!("'s{}", &c[1])).to_string());
    }
    if let Some(c) = lead.captures(m) {
        return Some(crate::jsstr::js_trim(&c[1]).to_string());
    }
    None
}

/// What a log line must end with for a suffix to match.
fn match_tail(suffix: &str) -> String {
    if suffix.starts_with("'s") {
        suffix.to_string()
    } else {
        format!(" {suffix}")
    }
}

/// The bucket key for a suffix: its last word, or nothing for a bare possessive tail.
fn last_word_key(suffix: &str) -> Option<String> {
    match suffix.rfind(' ') {
        Some(at) => Some(suffix[at + 1..].to_string()),
        None => {
            if suffix.starts_with("'s") {
                None
            } else {
                Some(suffix.to_string())
            }
        }
    }
}

const SPELLS_JSON: &str = include_str!("../../../../../src/main/data/spells.json");

/// The process's one spell database. [`load`] is a pure function of committed bytes and costs
/// 386 ms in a release build, so every caller that wanted the catalog used to pay for its own.
///
/// Not a cache: nothing here is keyed by a fold's input at all, since `spells.json` and the overlay
/// sidecar are `include_str!`'d into the binary. A second `Parser` in the same process cannot
/// observe this as different from the first. A caller that needs its own still has [`load`].
pub fn shared() -> std::sync::Arc<SpellDb> {
    static DB: std::sync::OnceLock<std::sync::Arc<SpellDb>> = std::sync::OnceLock::new();
    std::sync::Arc::clone(DB.get_or_init(|| std::sync::Arc::new(load())))
}

/// The whole load chain, once.
pub fn load() -> SpellDb {
    let file: SpellDbFile = serde_json::from_str(SPELLS_JSON).expect("spells.json is not readable");
    let sidecar = passes::sidecar();
    // Removals first: what the game does not have at all.
    let mut spells = passes::apply_removals(file.spells, &sidecar.removals);
    passes::apply_derived_durations(&mut spells);
    passes::apply_corrections(&mut spells, &sidecar.corrections);
    passes::apply_placeholder_messages(&mut spells);
    let mut db = build(spells);
    let corrections = overlay::derive_landing_corrections(&db);
    apply_overlay_corrections(&mut db, &corrections);
    db
}

/// The four tables, plus the last-word index over the fourth.
fn build(spells: Vec<SpellEntry>) -> SpellDb {
    let mut by_key: HashMap<String, usize> = HashMap::new();
    let mut by_key_order: Vec<usize> = Vec::new();
    let mut cast_on_you: HashMap<String, Vec<usize>> = HashMap::new();
    let mut wears_off: HashMap<String, Vec<usize>> = HashMap::new();
    // Insertion-ordered, because an entry's position in this table is its precedence.
    let mut suffix_order: Vec<(String, Vec<usize>)> = Vec::new();
    let mut suffix_at: HashMap<String, usize> = HashMap::new();

    for (i, s) in spells.iter().enumerate() {
        let key = db_canon_key(&s.name);
        // The first row per canonical name wins.
        if let std::collections::hash_map::Entry::Vacant(slot) = by_key.entry(key) {
            slot.insert(i);
            by_key_order.push(i);
        }
        if let Some(msg) = s.msg_cast_on_you.as_deref() {
            push_candidate_map(&mut cast_on_you, msg, i, &spells);
        }
        if let Some(msg) = s.msg_wears_off.as_deref() {
            push_candidate_map(&mut wears_off, msg, i, &spells);
        }
        if let Some(msg) = s.msg_cast_on_other.as_deref() {
            if let Some(suf) = cast_on_other_suffix(msg) {
                match suffix_at.get(&suf) {
                    Some(&at) => push_candidate_vec(&mut suffix_order[at].1, i, &spells),
                    None => {
                        suffix_at.insert(suf.clone(), suffix_order.len());
                        suffix_order.push((suf, vec![i]));
                    }
                }
            }
        }
    }

    let mut cast_on_other_by_last_word: HashMap<String, Vec<SuffixEntry>> = HashMap::new();
    let mut cast_on_other_unkeyed: Vec<SuffixEntry> = Vec::new();
    for (index, (suffix, cands)) in suffix_order.into_iter().enumerate() {
        let entry = SuffixEntry {
            tail: match_tail(&suffix),
            index,
            cands,
        };
        match last_word_key(&suffix) {
            None => cast_on_other_unkeyed.push(entry),
            Some(key) => cast_on_other_by_last_word
                .entry(key)
                .or_default()
                .push(entry),
        }
    }

    let charm_keys = charm_roster(&spells);
    SpellDb {
        spells,
        by_key,
        by_key_order,
        cast_on_you,
        wears_off,
        cast_on_other_by_last_word,
        cast_on_other_unkeyed,
        charm_keys,
    }
}

/// De-dupe rank variants of the same base spell, keeping the first.
fn push_candidate_map(
    map: &mut HashMap<String, Vec<usize>>,
    msg: &str,
    i: usize,
    spells: &[SpellEntry],
) {
    match map.get_mut(msg) {
        None => {
            map.insert(msg.to_string(), vec![i]);
        }
        Some(list) => push_candidate_vec(list, i, spells),
    }
}

fn push_candidate_vec(list: &mut Vec<usize>, i: usize, spells: &[SpellEntry]) {
    let key = db_canon_key(&spells[i].name);
    if !list.iter().any(|&e| db_canon_key(&spells[e].name) == key) {
        list.push(i);
    }
}

/// An anchored read of the wiki's own effect list. `targetType: 'Self'` rows are excluded.
fn charm_roster(spells: &[SpellEntry]) -> std::collections::HashSet<String> {
    let mut out = std::collections::HashSet::new();
    for s in spells {
        let charms =
            s.effects.as_deref().unwrap_or(&[]).iter().any(|line| {
                crate::stems::classify_effect_line_is_charm(crate::jsstr::js_trim(line))
            });
        if !charms {
            continue;
        }
        if s.target_type.as_deref() == Some("Self") {
            continue;
        }
        out.insert(crate::names::spell_canon_key(&s.name));
    }
    out
}

/// The effective DB: spells.json plus the overlay, with the overlay winning.
fn apply_overlay_corrections(db: &mut SpellDb, corrections: &[(String, String, Option<String>)]) {
    for (text, spell_name, contradicts) in corrections {
        let Some(&idx) = db.by_key.get(&db_canon_key(spell_name)) else {
            continue;
        };
        // A cast-on-you landing message is a beneficial-buff signal, so a correction pointing at a
        // Detrimental spell is a mining false positive and never overrides the DB.
        if db.spells[idx].spell_type.as_deref() == Some("Detrimental") {
            continue;
        }
        // One write, two reasons: a wiki contradiction overrides the message's candidates, and a
        // message the DB never had fills the gap.
        let existing = db.cast_on_you.get(text).cloned();
        if contradicts.is_some() || existing.is_none() {
            db.cast_on_you.insert(text.clone(), vec![idx]);
        } else {
            // The DB maps this text to other spells too — add ours as a candidate.
            let key = db_canon_key(&db.spells[idx].name);
            let list = db.cast_on_you.get_mut(text).expect("checked above");
            let already = list
                .iter()
                .any(|&e| db_canon_key(&db.spells[e].name) == key);
            if !already {
                list.push(idx);
            }
        }
    }
}

impl SpellDb {
    /// The keyed entries in insertion order. The fold walks this and projects the whole table into
    /// an owned record at construction, rather than borrowing the parser.
    pub fn by_key_values(&self) -> impl Iterator<Item = &SpellEntry> {
        self.by_key_order.iter().map(move |&i| &self.spells[i])
    }

    pub fn by_key_get(&self, key: &str) -> Option<&SpellEntry> {
        self.by_key.get(key).map(|&i| &self.spells[i])
    }

    /// The keyed entries as (canonical key, entry) pairs. Handing out the pairs rather than a
    /// `has()`/`get()` is what lets the resist fold build its projection in one pass; the key is
    /// `db_canon_key`'s, which is the spelling a lookup has to be made with.
    pub fn by_key_entries(&self) -> impl Iterator<Item = (&str, &SpellEntry)> {
        self.by_key
            .iter()
            .map(move |(k, &i)| (k.as_str(), &self.spells[i]))
    }
}
