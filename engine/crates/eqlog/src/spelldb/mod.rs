//! THE SPELL DATABASE THE PARSER'S OUTPUT DEPENDS ON — `src/main/data/spellDb.ts`, ported.
//!
//! `classifyDbBuff`, `classifyCharm` and `classifyCcApply` all read it, and the `candidates` list a
//! `buffApply` carries IS the table, so a phase-1 golden cannot be matched without reproducing the
//! load path exactly. The TS pipeline is:
//!
//!   spells.json → REMOVALS → era join → derived DURATIONS → CORRECTIONS → PLACEHOLDER blanking
//!               → buildSpellDb → overlay corrections mined from the COMMITTED baseline
//!
//! THE COMMITTED JSON IS READ, NOT COPIED. `spells.json` and `messageOverlay.baseline.json` are
//! `include_str!`d straight out of `src/main/data/`, so there is exactly one copy of each and a
//! re-scrape reaches both readers at once.
//!
//! THE ERA JOIN IS THE ONE PASS THAT IS NOT HERE, and skipping it is a statement rather than an
//! omission: `applySpellEra` writes exactly one field, `outOfEra`, which no table below indexes and
//! no classifier reads. It changes the boot line and the level panel and nothing in the event
//! stream. (Its position in the chain is documented as free for the same reason — spellEra.ts's own
//! header says it "writes a field none of the passes around it reads".)
//!
//! THE TWO OVERLAY LISTS ARE A SIDECAR, and that is the one genuine duplication in this crate.
//! `SPELL_REMOVALS` and `SPELL_CORRECTIONS` are TypeScript arrays; nothing here can import them, so
//! `scripts/gen-engine-spell-overlay.mts` projects the fields this parser needs into
//! `data/spell-overlay.json` beside this file. The drift guard is not a promise, it is a
//! mechanism, and there are two of them: `npm run oracle:rust-parser` regenerates the sidecar and
//! refuses to run when the committed copy is stale, and — the real one — a list that moved without
//! the sidecar moves the TS goldens, so byte-identity fails on the very next check.

mod overlay;
mod passes;

pub use overlay::derive_landing_corrections;

use crate::names::db_canon_key;
use serde::Deserialize;
use std::collections::HashMap;

/// One row of `spells.json` — the fields the PARSER's output can depend on, and no others. The
/// scrape carries eight more (`castTimeMs`, `recastMs`, `mana`, `instrumentEnhanced`, …) that no
/// classifier and no table below reads; leaving them out of the struct is what makes that claim
/// checkable rather than stated.
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

/// One cast-on-other suffix, precompiled — `SuffixEntry` in spellDb.ts.
///
/// `index` is the entry's position in the insertion-ordered suffix table and is the ONLY thing that
/// decides precedence when a line ends with two known suffixes.
#[derive(Debug, Clone)]
pub struct SuffixEntry {
    pub tail: String,
    pub index: usize,
    pub cands: Vec<usize>,
}

pub struct SpellDb {
    pub spells: Vec<SpellEntry>,
    /// canonical name → first entry with it. Insertion-ordered, because `looksCastOnOther` walks it.
    by_key: HashMap<String, usize>,
    by_key_order: Vec<usize>,
    cast_on_you: HashMap<String, Vec<usize>>,
    wears_off: HashMap<String, Vec<usize>>,
    cast_on_other_by_last_word: HashMap<String, Vec<SuffixEntry>>,
    cast_on_other_unkeyed: Vec<SuffixEntry>,
    /// The derived charm roster (`charmRoster(db.spells, { castableOnly: false })`), keyed by
    /// `spellCanonKey`. Installed alongside the DB by `installSpellDb`.
    charm_keys: std::collections::HashSet<String>,
}

impl SpellDb {
    pub fn entry(&self, i: usize) -> &SpellEntry {
        &self.spells[i]
    }

    pub fn cast_on_you(&self, text: &str) -> Option<&[usize]> {
        self.cast_on_you.get(text).map(|v| v.as_slice())
    }

    /// Every key `by_key` carries — i.e. `db.byKey.keys()`.
    ///
    /// It exists for ONE consumer outside this crate: `wiring.ts` hands the observedSpellRanks
    /// module `knownSpell: (key) => spellDb.byKey.has(key)`, which is what tells a merged spell
    /// scroll from a merged item whose name happens to end in a roman numeral. Exposed as the KEYS
    /// rather than as a `has()` so a fold can take an owned set and borrow nothing from the parser.
    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.by_key.keys().map(String::as_str)
    }

    pub fn wears_off(&self, text: &str) -> Option<&[usize]> {
        self.wears_off.get(text).map(|v| v.as_slice())
    }

    /// True when the derived roster (or, for a name the catalog does not carry, `CHARM_STEMS`)
    /// calls this spell a charm — `derivedCharmRoster` in rulesets.ts.
    pub fn is_charm_spell(&self, name: &str) -> bool {
        self.charm_keys
            .contains(&crate::names::spell_canon_key(name))
            || crate::stems::charm_stems_test(name)
    }

    /// `matchCastOnOtherSuffix` — one bucket lookup, then table order within it, then the
    /// (measured-empty) unkeyable list merged in by index.
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

/// `firstSuffixMatch` — the two rejections are as load-bearing as the match.
fn first_suffix_match<'a>(
    text: &str,
    list: &'a [SuffixEntry],
) -> Option<(&'a SuffixEntry, String)> {
    for entry in list {
        if text.ends_with(&entry.tail) && text.len() > entry.tail.len() {
            let target = crate::jsstr::js_trim(&text[..text.len() - entry.tail.len()]);
            // `target.length <= 60` is a JS length: UTF-16 code units, not bytes and not chars.
            if !target.is_empty() && target.encode_utf16().count() <= 60 {
                return Some((entry, target.to_string()));
            }
        }
    }
    None
}

/// `castOnOtherSuffix(msg)` — strip the wiki's "Someone" subject, keeping a possessive tail.
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

/// What a log line must END WITH for a suffix to match — `matchTail`.
fn match_tail(suffix: &str) -> String {
    if suffix.starts_with("'s") {
        suffix.to_string()
    } else {
        format!(" {suffix}")
    }
}

/// `lastWordKey` — see spellDb.ts for the proof that bucketing by it cannot lose a match.
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

/// THE PROCESS'S ONE SPELL DATABASE (JOS-478).
///
/// WHY THIS EXISTS. [`load`] is a pure function of committed bytes and takes 386 ms in a release
/// build (~5 s in a debug one), and until this ticket every caller that wanted the catalog built
/// its own: the engine rebuilt it on EVERY ATTACH because `Parser` owned its `SpellDb` by value and
/// `SpellDb` was neither `Clone` nor shareable, and the fold's resist module built a SECOND one
/// behind its own lazy table. Two full builds per attach, of the identical bytes, for a table
/// nothing can mutate. `engined`'s README measured it and named it for the integrator; this is the
/// close.
///
/// IT IS NOT A CACHE, AND RULING 18 IS NOT BENT BY IT. The law forbids memoizing an ANSWER keyed by
/// anything but a fold's own inputs. Nothing here is keyed by a fold's input at all: `spells.json`
/// and the overlay sidecar are `include_str!`'d into the binary, so this is the same category as
/// this crate's `OnceLock` regexes and `fold::modules::resist::catalog`'s committed tables — a
/// compile-once constant that is merely computed late. A second `Parser` in the same process cannot
/// observe it as different from the first, because there is nothing that could make it different.
///
/// A CALLER THAT NEEDS ITS OWN STILL HAS [`load`], which is untouched and still hands back an owned
/// database. Nothing in this crate calls it except this function.
pub fn shared() -> std::sync::Arc<SpellDb> {
    static DB: std::sync::OnceLock<std::sync::Arc<SpellDb>> = std::sync::OnceLock::new();
    std::sync::Arc::clone(DB.get_or_init(|| std::sync::Arc::new(load())))
}

/// `loadSpellDb()` + `installSpellDb()`: the whole chain, once.
pub fn load() -> SpellDb {
    let file: SpellDbFile = serde_json::from_str(SPELLS_JSON).expect("spells.json is not readable");
    let sidecar = passes::sidecar();
    // REMOVALS FIRST: what the game does not have at all.
    let mut spells = passes::apply_removals(file.spells, &sidecar.removals);
    // (the era join goes here in the TS — see the module header for why it is absent)
    passes::apply_derived_durations(&mut spells);
    passes::apply_corrections(&mut spells, &sidecar.corrections);
    passes::apply_placeholder_messages(&mut spells);
    let mut db = build(spells);
    let corrections = overlay::derive_landing_corrections(&db);
    apply_overlay_corrections(&mut db, &corrections);
    db
}

/// `buildSpellDb` — the four tables plus the last-word index over the fourth.
fn build(spells: Vec<SpellEntry>) -> SpellDb {
    let mut by_key: HashMap<String, usize> = HashMap::new();
    let mut by_key_order: Vec<usize> = Vec::new();
    let mut cast_on_you: HashMap<String, Vec<usize>> = HashMap::new();
    let mut wears_off: HashMap<String, Vec<usize>> = HashMap::new();
    // Insertion-ordered, because the entry's POSITION in this table is its precedence.
    let mut suffix_order: Vec<(String, Vec<usize>)> = Vec::new();
    let mut suffix_at: HashMap<String, usize> = HashMap::new();

    for (i, s) in spells.iter().enumerate() {
        let key = db_canon_key(&s.name);
        // `if (!byKey.has(key)) byKey.set(key, s)` — the FIRST row per canonical name wins.
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

/// `pushCandidate` — de-dupe rank variants of the same base spell, keeping the first.
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

/// `charmRoster(db.spells, { castableOnly: false })` — `spellEffectClass.ts`'s anchored read of the
/// wiki's own effect list. `targetOnly` stays at its default, so `targetType: 'Self'` rows are out.
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

/// `applyOverlayCorrections` — the effective DB (spells.json + overlay, overlay WINS).
fn apply_overlay_corrections(db: &mut SpellDb, corrections: &[(String, String, Option<String>)]) {
    for (text, spell_name, contradicts) in corrections {
        let Some(&idx) = db.by_key.get(&db_canon_key(spell_name)) else {
            continue;
        };
        // A cast-on-YOU landing message is a beneficial-buff signal; a "correction" pointing at a
        // Detrimental spell is a mining false positive and never overrides the DB.
        if db.spells[idx].spell_type.as_deref() == Some("Detrimental") {
            continue;
        }
        // The TS states three branches; two of them WRITE THE SAME THING for different reasons —
        // a wiki CONTRADICTION overrides the message's candidates, and a message the DB never had
        // fills the gap. Merged here because clippy refuses two identical arms, and named so the
        // two reasons survive the merge.
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
    /// `db.byKey`, in insertion order — `looksCastOnOther` walks it, and so does the FOLD, which
    /// projects the whole table into an owned per-line record at construction rather than borrowing
    /// the parser (JOS-476: `wiring.ts` hands `spellDb` to the buffs module, and everything that
    /// module asks of it is a lookup on this map).
    pub fn by_key_values(&self) -> impl Iterator<Item = &SpellEntry> {
        self.by_key_order.iter().map(move |&i| &self.spells[i])
    }

    pub fn by_key_get(&self, key: &str) -> Option<&SpellEntry> {
        self.by_key.get(key).map(|&i| &self.spells[i])
    }

    /// `db.byKey` as (canonical key, entry) PAIRS, for a consumer outside this crate.
    ///
    /// The one caller is the resist fold, which asks three questions of a named spell — is it a
    /// song, does the catalog know its landing sentence, is it a resist debuff — and projects the
    /// answers into an owned table at construction, so nothing in a fold borrows the parser.
    /// Handing out the pairs rather than a `has()`/`get()` is what lets the projection be built in
    /// one pass; the key is `db_canon_key`'s, which is the spelling a lookup has to be made with.
    pub fn by_key_entries(&self) -> impl Iterator<Item = (&str, &SpellEntry)> {
        self.by_key
            .iter()
            .map(move |(k, &i)| (k.as_str(), &self.spells[i]))
    }
}
