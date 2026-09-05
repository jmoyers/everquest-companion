//! The observed-message overlay, seeded with the committed baseline and nothing else.
//!
//! A parser needs it because each verified landing line is registered as a spell's
//! `msg_cast_on_you`, which is what turns that line into a `buffApply` rather than an `unknown`.
//!
//! Only the baseline is seeded: the user's own mined overlay lives in userData, and a golden
//! recorded against a machine-local file would not be a fact about the log. So there is one bucket,
//! no observation and no persistence; the mining half is downstream of the parser.
//!
//! The tie-break is codepoint order because `localeCompare` answers from ICU and can differ between
//! hosts. Rust's natural `Ord` on `&str` is UTF-8 bytewise, which is exactly codepoint order, so it
//! is the comparator.

use super::SpellDb;
use crate::names::db_canon_key;
use serde::Deserialize;
use std::collections::HashMap;

const BASELINE_JSON: &str =
    include_str!("../../../../../src/main/data/messageOverlay.baseline.json");

#[derive(Deserialize)]
struct BaselineFile {
    messages: Vec<BaselineMessage>,
}

#[derive(Deserialize)]
struct BaselineMessage {
    text: String,
    role: String,
    spells: Vec<BaselineSpell>,
}

#[derive(Deserialize)]
struct BaselineSpell {
    spell: String,
    count: i64,
}

/// One accumulated message: the text, its role, and per-canonical-spell counts in insertion order.
struct Record {
    text: String,
    role: String,
    by_spell: Vec<(String, String, i64)>, // (canonical key, display, count)
}

#[derive(PartialEq, Eq, Clone, Copy)]
enum Verdict {
    Contradicts,
    Verified,
    Shared,
    Unknown,
}

impl Verdict {
    fn rank(self) -> u8 {
        match self {
            Verdict::Contradicts => 0,
            Verdict::Verified => 1,
            Verdict::Shared => 2,
            Verdict::Unknown => 3,
        }
    }
}

/// Minimum observations before a message earns a non-UNKNOWN verdict.
const MIN_OBSERVATIONS: i64 = 2;

/// The landing corrections, as `(message text, spell display, contradicted spell)`. Each text
/// appears at most once, so the order cannot change what the corrections produce; it is still the
/// app's sorted order so a reader diffing the two sides sees the same sequence.
pub fn derive_landing_corrections(db: &SpellDb) -> Vec<(String, String, Option<String>)> {
    let file: BaselineFile =
        serde_json::from_str(BASELINE_JSON).expect("messageOverlay.baseline.json is not readable");

    // Merge and aggregate are the same accumulation with a single source, so it is done once.
    let mut order: Vec<Record> = Vec::new();
    let mut at: HashMap<String, usize> = HashMap::new();
    for m in &file.messages {
        let idx = match at.get(&m.text) {
            Some(&i) => i,
            None => {
                at.insert(m.text.clone(), order.len());
                order.push(Record {
                    text: m.text.clone(),
                    role: m.role.clone(),
                    by_spell: Vec::new(),
                });
                order.len() - 1
            }
        };
        let rec = &mut order[idx];
        for sp in &m.spells {
            let key = db_canon_key(&sp.spell);
            match rec.by_spell.iter_mut().find(|e| e.0 == key) {
                Some(e) => e.2 += sp.count,
                None => rec.by_spell.push((key, sp.spell.clone(), sp.count)),
            }
        }
    }

    struct Built {
        text: String,
        role: String,
        verdict: Verdict,
        top_spell: String,
        conflict_spell: Option<String>,
        total: i64,
    }
    let mut messages: Vec<Built> = Vec::with_capacity(order.len());
    for rec in &order {
        let mut spells: Vec<(&str, i64)> = rec
            .by_spell
            .iter()
            .map(|(_, display, count)| (display.as_str(), *count))
            .collect();
        spells.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
        let total: i64 = spells.iter().map(|s| s.1).sum();
        let (verdict, conflict_spell) = verdict_for(db, rec, total);
        messages.push(Built {
            text: rec.text.clone(),
            role: rec.role.clone(),
            verdict,
            top_spell: spells.first().map(|s| s.0.to_string()).unwrap_or_default(),
            conflict_spell,
            total,
        });
    }
    messages.sort_by(|a, b| {
        a.verdict
            .rank()
            .cmp(&b.verdict.rank())
            .then_with(|| b.total.cmp(&a.total))
            .then_with(|| a.text.as_str().cmp(b.text.as_str()))
    });

    let mut out = Vec::new();
    for m in &messages {
        if m.role != "landing" {
            continue;
        }
        if looks_cast_on_other(db, &m.text) {
            continue;
        }
        match m.verdict {
            Verdict::Verified => out.push((m.text.clone(), m.top_spell.clone(), None)),
            Verdict::Contradicts => {
                if let Some(conflict) = &m.conflict_spell {
                    out.push((m.text.clone(), m.top_spell.clone(), Some(conflict.clone())));
                }
            }
            _ => {}
        }
    }
    out
}

/// Reads the first spell off the unsorted insertion order, which only matters when there is one
/// spell — the only branch that reaches it.
fn verdict_for(db: &SpellDb, rec: &Record, total: i64) -> (Verdict, Option<String>) {
    if rec.by_spell.len() >= 2 {
        return (Verdict::Shared, None);
    }
    if total < MIN_OBSERVATIONS {
        return (Verdict::Unknown, None);
    }
    let Some((_, display, _)) = rec.by_spell.first() else {
        return (Verdict::Verified, None);
    };
    let Some(db_spell) = db.by_key_get(&db_canon_key(display)) else {
        return (Verdict::Verified, None);
    };
    if rec.role == "landing" {
        let you = db_spell.msg_cast_on_you.clone();
        if you.as_deref() == Some(rec.text.as_str()) {
            return (Verdict::Verified, None);
        }
        let other_suffix = db_spell
            .msg_cast_on_other
            .as_deref()
            .and_then(super::cast_on_other_suffix);
        if let Some(suffix) = other_suffix {
            if message_matches_other_suffix(&rec.text, &suffix) {
                return (Verdict::Verified, None);
            }
        }
        return match you {
            Some(_) => (Verdict::Contradicts, Some(display.clone())),
            None => (Verdict::Verified, None),
        };
    }
    // The wears-off role.
    if let Some(wiki) = &db_spell.msg_wears_off {
        if wiki != &rec.text {
            return (Verdict::Contradicts, Some(display.clone()));
        }
    }
    (Verdict::Verified, None)
}

/// The same tail test the DB's own matcher makes.
fn message_matches_other_suffix(text: &str, suffix: &str) -> bool {
    let tail = if suffix.starts_with("'s") {
        suffix.to_string()
    } else {
        format!(" {suffix}")
    };
    text.ends_with(&tail) && text.len() > tail.len()
}

/// True when a line ends with any cast-on-other suffix, in which case registering it as a
/// self-landing message would fire a self `buffApply` for a debuff on a mob.
fn looks_cast_on_other(db: &SpellDb, text: &str) -> bool {
    for s in db.by_key_values() {
        let Some(msg) = s.msg_cast_on_other.as_deref() else {
            continue;
        };
        if let Some(suffix) = super::cast_on_other_suffix(msg) {
            if message_matches_other_suffix(text, &suffix) {
                return true;
            }
        }
    }
    false
}
