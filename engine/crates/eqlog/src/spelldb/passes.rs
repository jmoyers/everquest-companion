//! The four load-time passes that run over the scraped entries before any table is derived:
//! removals, derived durations, corrections, placeholder blanking. See `mod.rs` for the chain.

use super::SpellEntry;
use crate::jsstr::js_trim;
use serde::Deserialize;
use std::collections::HashMap;

/// `data/spell-overlay.json`: the projection of the app's removal and correction lists this parser
/// needs. See `mod.rs` for the two mechanisms that keep it from drifting from its source.
#[derive(Deserialize)]
pub struct Sidecar {
    pub removals: Vec<String>,
    pub corrections: Vec<Correction>,
}

#[derive(Deserialize)]
pub struct Correction {
    pub spells: Vec<String>,
    pub field: String,
    pub from: Option<String>,
    pub to: String,
}

const SIDECAR_JSON: &str = include_str!("../../data/spell-overlay.json");

pub fn sidecar() -> Sidecar {
    serde_json::from_str(SIDECAR_JSON).expect("spell-overlay.json is not readable")
}

/// Drop every row named by a removal.
pub fn apply_removals(spells: Vec<SpellEntry>, removals: &[String]) -> Vec<SpellEntry> {
    let wanted: std::collections::HashSet<&str> = removals.iter().map(|s| s.as_str()).collect();
    spells
        .into_iter()
        .filter(|s| !wanted.contains(s.name.as_str()))
        .collect()
}

/// Re-derive `duration_ms` from `duration_text` through the one reader.
pub fn apply_derived_durations(spells: &mut [SpellEntry]) {
    for s in spells.iter_mut() {
        s.duration_ms = parse_duration_ms(s.duration_text.as_deref());
    }
}

/// The name index is built once, before any correction runs, so a `name` correction does not
/// re-index — which matters for a pair of corrections that rename a row another one then patches.
pub fn apply_corrections(spells: &mut [SpellEntry], corrections: &[Correction]) {
    let mut by_name: HashMap<&str, Vec<usize>> = HashMap::new();
    // A borrow of `spells` cannot outlive the mutation below, so the index holds owned names.
    let owned: Vec<String> = spells.iter().map(|s| s.name.clone()).collect();
    for (i, n) in owned.iter().enumerate() {
        by_name.entry(n.as_str()).or_default().push(i);
    }
    for c in corrections {
        for name in &c.spells {
            let Some(all) = by_name.get(name.as_str()) else {
                // A rename that already ran leaves no row under `from`; nothing to write.
                continue;
            };
            // A message correction writes the first row of its name; a name / spellType / classes
            // correction writes all of them.
            let rows: &[usize] =
                if c.field == "name" || c.field == "spellType" || c.field == "classes" {
                    all
                } else {
                    &all[..1]
                };
            for &at in rows {
                let current = field_of(&spells[at], &c.field).map(|s| s.to_string());
                if current.as_deref() == Some(c.to.as_str()) {
                    continue; // satisfied
                }
                let describes = match &c.from {
                    None => current.is_none(),
                    Some(from) => current.as_deref() == Some(from.as_str()),
                };
                if !describes {
                    continue; // stale — the app reports it and its audit suite fails on it
                }
                set_field(&mut spells[at], &c.field, c.to.clone());
            }
        }
    }
}

fn field_of<'a>(s: &'a SpellEntry, field: &str) -> Option<&'a str> {
    match field {
        "name" => Some(s.name.as_str()),
        "spellType" => s.spell_type.as_deref(),
        "classes" => s.classes.as_deref(),
        "msgCastOnYou" => s.msg_cast_on_you.as_deref(),
        "msgCastOnOther" => s.msg_cast_on_other.as_deref(),
        "msgWearsOff" => s.msg_wears_off.as_deref(),
        other => panic!("spell-overlay.json names an unknown field {other}"),
    }
}

fn set_field(s: &mut SpellEntry, field: &str, to: String) {
    match field {
        "name" => s.name = to,
        "spellType" => s.spell_type = Some(to),
        "classes" => s.classes = Some(to),
        "msgCastOnYou" => s.msg_cast_on_you = Some(to),
        "msgCastOnOther" => s.msg_cast_on_other = Some(to),
        "msgWearsOff" => s.msg_wears_off = Some(to),
        other => panic!("spell-overlay.json names an unknown field {other}"),
    }
}

/// Blank the scrape's stub fields so every table reads them as the nothing they are.
pub fn apply_placeholder_messages(spells: &mut [SpellEntry]) {
    for s in spells.iter_mut() {
        if s.msg_cast_on_you.as_deref().is_some_and(is_placeholder) {
            s.msg_cast_on_you = None;
        }
        if s.msg_cast_on_other.as_deref().is_some_and(is_placeholder) {
            s.msg_cast_on_other = None;
        }
        if s.msg_wears_off.as_deref().is_some_and(is_placeholder) {
            s.msg_wears_off = None;
        }
    }
}

/// The subject words a message can consist entirely of, lowercased.
const BARE_SUBJECTS: [&str; 6] = ["you", "your", "someone", "target", "player", "soandso"];

/// A subject with no predicate, or the literal `N/A`.
pub fn is_placeholder(msg: &str) -> bool {
    let text = js_trim(msg);
    if text.to_uppercase() == "N/A" {
        return true;
    }
    // A run of non-alphanumerics collapses to one space; leading and trailing runs fall to the trim.
    let mut words = String::with_capacity(text.len());
    let mut gap = false;
    for c in text.chars() {
        if c.is_ascii_alphanumeric() {
            if gap && !words.is_empty() {
                words.push(' ');
            }
            gap = false;
            words.push(c);
        } else {
            gap = true;
        }
    }
    let words = js_trim(&words).to_lowercase();
    words.is_empty() || BARE_SUBJECTS.contains(&words.as_str())
}

fn unit_ms(n: f64, unit_raw: &str) -> Option<i64> {
    let u = unit_raw.to_lowercase();
    let round = |x: f64| x.round() as i64;
    if matches!(u.as_str(), "h" | "hr" | "hrs" | "hour" | "hours") {
        return Some(round(n * 3_600_000.0));
    }
    if matches!(u.as_str(), "m" | "min" | "mins" | "minute" | "minutes") {
        return Some(round(n * 60_000.0));
    }
    if matches!(u.as_str(), "s" | "sec" | "secs" | "second" | "seconds") {
        return Some(round(n * 1000.0));
    }
    if u == "tick" || u == "ticks" {
        return Some(round(n * 6000.0));
    }
    None
}

fn parse_clock_ms(t: &str) -> Option<i64> {
    use regex::Regex;
    use std::sync::OnceLock;
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"([0-9]+):([0-9]{2})(?::([0-9]{2}))?").unwrap());
    let m = re.captures(t)?;
    let (h, min, s) = match m.get(3) {
        Some(third) => (
            m[1].parse::<i64>().ok()?,
            m[2].parse::<i64>().ok()?,
            third.as_str().parse::<i64>().ok()?,
        ),
        None => (0, m[1].parse::<i64>().ok()?, m[2].parse::<i64>().ok()?),
    };
    let ms = ((h * 60 + min) * 60 + s) * 1000;
    if ms > 0 {
        Some(ms)
    } else {
        None
    }
}

/// The wiki's several duration forms, or `None` for instant/permanent/absent.
pub fn parse_duration_ms(text: Option<&str>) -> Option<i64> {
    use regex::Regex;
    use std::sync::OnceLock;
    let text = text?;
    if text.is_empty() {
        return None;
    }
    let t = text.to_lowercase();
    let t = js_trim(&t);
    if t.is_empty() {
        return None;
    }
    static REFUSE: OnceLock<Regex> = OnceLock::new();
    let refuse = REFUSE.get_or_init(|| {
        Regex::new(
            r"instant|permanent|unlimited|until(?-u:\b)|special|varies|n/a|per tick|per level",
        )
        .unwrap()
    });
    if refuse.is_match(t) {
        return None;
    }
    static COMP: OnceLock<Regex> = OnceLock::new();
    let comp = COMP.get_or_init(|| {
        Regex::new(
            r"([0-9]+(?:\.[0-9]+)?)\s*(hours?|hrs?|hr|minutes?|mins?|min|seconds?|secs?|sec|ticks?|h|m|s)(?-u:\b)",
        )
        .unwrap()
    });
    let mut comps: Vec<i64> = Vec::new();
    for c in comp.captures_iter(t) {
        let n: f64 = c[1].parse().unwrap_or(f64::NAN);
        if let Some(ms) = unit_ms(n, &c[2]) {
            comps.push(ms);
        }
    }
    if comps.is_empty() {
        return parse_clock_ms(t);
    }
    static FORMULA: OnceLock<Regex> = OnceLock::new();
    let formula =
        FORMULA.get_or_init(|| Regex::new(r"(?-u:\b)to(?-u:\b)|@\s*l[0-9]|@l[0-9]").unwrap());
    if formula.is_match(t) {
        return comps.into_iter().max();
    }
    Some(comps.into_iter().sum())
}
