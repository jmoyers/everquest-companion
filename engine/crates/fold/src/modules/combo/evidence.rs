//! `src/main/modules/comboEvidence.ts` + `src/main/data/spellClasses.ts` — EVIDENCE INTAKE.
//!
//! PURE: one event in, at most one `ClassObservation` out, plus the two committed tables it looks
//! classes up in. No state; the module shell owns the ring.
//!
//! THE TABLES ARE NOT INTERCHANGEABLE, and that is the most load-bearing rule in this file. Wave 2
//! measured that `Frenzy`, `Smite` and `Feign Death` are BOTH client skill names AND
//! Template:Spellpage spell names with DIFFERENT class sets (Frenzy: a BER skill, a SHM/BST spell;
//! Feign Death: a MNK skill, a NEC/SHD spell) — so a `skillUp` resolves against classes.json
//! `skills` and ONLY that, and a `castBegin` resolves against spells.json (then classes.json
//! `abilities`) and ONLY that. Unioning them would hand MNK's Feign Death skill-ups to NEC and SHD
//! and quietly destroy the one signal that dates the Aug 2 swap.
//!
//! THERE IS NO CLICKY SUPPRESSION, and its absence is the JOS-79 fix rather than an omission. Wave
//! 3 read `Your <item> shimmers briefly.` as "an item just cast the spell on the next line" and
//! dropped any `castBegin` within 2.5 s after one. MEASURED whole-log (1,433,047 lines): that
//! reading is WRONG and was throwing away 7,452 of the player's 16,857 own casts (44.2%). All five
//! items that print the line are FOCUS items — a focus effect is WORN and announces itself when it
//! modifies a spell YOU are casting; none of them casts anything. Djarn's ring precedes 7,033 casts
//! spanning the player's whole spellbook, which no single item effect can be, and two of the five
//! fire thousands of times with a cast within 2.5 s on only 2.0% of them. The cost was total for
//! one class: WIZ had ZERO observations in the whole log, because this player's wizard nukes are
//! cast under Spell Haste II. What rejects a genuine stray item cast is the admission ranking in
//! `score.rs`, not an intake rule.
//!
//! `itemActivate` stays a parsed event and is simply not evidence about the player's classes, in
//! either direction. A self-announcing clicky would need its own observed sample first (the
//! awaiting-sample law).
//!
//! ── THE SPELL → CLASS TABLE ────────────────────────────────────────────────────────────────────
//!
//! NO SCRAPE IS INVOLVED. `spells.json` already carries a `classes` field on every spell, straight
//! from the wiki's Template:Spellpage, collapsed by the scrape to one line:
//! `"* Beastlord - Level 1 (Autogranted) * Cleric - Level 1 …"`. So this is a PURE PARSE of
//! committed data. It is keyed by `spellCanonKey` because casts print a Roman rank that fades and
//! fizzles drop, and two spells that canonicalize to the same key UNION their class sets — union is
//! the CONSERVATIVE direction (it widens the candidate set, never narrows it), so a rank-strip
//! collision can only make an inference less certain, never wrong.
//!
//! THE ROWS ARE READ THROUGH THE SAME REMOVALS+CORRECTIONS PIPELINE the parser's DB is built from,
//! and that matters twice over: a spell EQ Legends does not have places nobody, and a row the
//! scrape MISNAMED is a row no cast can ever reach (`You begin singing Solon's Bewitching Bravura
//! IX.` folded to a key the wiki's `Solon's Bravura` never produced, and a bard's own signature
//! song contributed nothing). `eqlog::spelldb::load()` applies removals then corrections in exactly
//! that order, so this reads the finished `db.spells` rather than re-running the chain.
//!
//! MEASURED COVERAGE, and it is a hard "say what the log cannot say" boundary: BER, MNK and WAR
//! have LITERALLY ZERO spells and ROG has nine. Three of sixteen classes are invisible to cast
//! evidence entirely; skill-ups, stances and poison coats are the only way to see them.

use super::{as_class_abbr, ClassAbbr};
use crate::event::Event;
use eqlog::jsstr::JS_S;
use eqlog::names::{spell_canon_key, strip_rank_tail};
use regex::Regex;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

/// Source weights (§ 4.2). `who` is absent on purpose: a `/who` row is not scored, it OVERRIDES.
/// The ordering encodes how much each family can LIE — a poison coat is ROG by game design, a
/// stance/skill is class-gated by the client, an invocation is class-gated but three of the nine
/// span twelve classes and the wiki contradicts itself on two rows, and a cast is the weakest of
/// all (items cast, charmed pets cast, volume overwhelms truth).
fn source_weight(source: &str) -> f64 {
    match source {
        "who" => 0.0,
        "poisonCoat" => 3.0,
        "stance" => 2.5,
        "skillUp" => 2.5,
        "invocation" => 1.5,
        _ => 1.0, // 'cast'
    }
}

/// One atomic piece of evidence, before it is folded into a slot.
#[derive(Debug, Clone)]
pub struct ClassObservation {
    pub ts: i64,
    pub seq: i64,
    pub source: &'static str,
    /// display key: `Frenzy`, `berserker`, `Mesmerization`.
    pub label: String,
    /// Classes consistent with this observation. Exactly one ⇒ exclusive ⇒ decisive.
    pub candidates: Vec<ClassAbbr>,
    /// Source weight, precomputed so scoring is a pure sum.
    pub weight: f64,
}

// ───────────────────────────────────────────────────────────── the committed class tables

#[derive(Deserialize)]
struct ClassesJson {
    stances: HashMap<String, Vec<String>>,
    invocations: HashMap<String, Vec<String>>,
    skills: HashMap<String, Vec<String>>,
    /// Abilities that are NOT Template:Spellpage pages — `Lay on Hands`, `Holy Steed`,
    /// `Harm Touch`, 76 of them. They print an ordinary `You begin casting …` line, so without this
    /// table the 441 Lay on Hands casts in the real log (the strongest PAL signal there is) resolve
    /// to nothing.
    abilities: HashMap<String, Vec<String>>,
}

const CLASSES_JSON: &str = include_str!("../../../../../../src/main/data/classes.json");

struct Tables {
    stances: HashMap<String, Vec<ClassAbbr>>,
    invocations: HashMap<String, Vec<ClassAbbr>>,
    skills: HashMap<String, Vec<ClassAbbr>>,
    /// Keyed by `spellCanonKey`, because casts carry a Roman rank the table does not.
    abilities: HashMap<String, Vec<ClassAbbr>>,
    /// `Object.keys(classesJson.stances).length > 0` — DATA AVAILABILITY, not health. classes.json
    /// ships as an empty STUB before the scrape runs (the keep-the-tree-buildable rule), and an
    /// empty stance table would silently turn every inference into an unknown slot.
    ready: bool,
}

/// `classes.json` list → the closed `ClassAbbr` set. An unknown code is DROPPED, never coerced.
fn abbrs(list: &[String]) -> Vec<ClassAbbr> {
    list.iter().filter_map(|s| as_class_abbr(s)).collect()
}

fn tables() -> &'static Tables {
    static T: OnceLock<Tables> = OnceLock::new();
    T.get_or_init(|| {
        let raw: ClassesJson =
            serde_json::from_str(CLASSES_JSON).expect("classes.json is not readable");
        let conv = |m: &HashMap<String, Vec<String>>| -> HashMap<String, Vec<ClassAbbr>> {
            m.iter().map(|(k, v)| (k.clone(), abbrs(v))).collect()
        };
        Tables {
            ready: !raw.stances.is_empty(),
            stances: conv(&raw.stances),
            invocations: conv(&raw.invocations),
            skills: conv(&raw.skills),
            abilities: raw
                .abilities
                .iter()
                .map(|(k, v)| (spell_canon_key(k), abbrs(v)))
                .collect(),
        }
    })
}

/// `TABLES_READY` — see `Tables::ready`.
pub fn tables_ready() -> bool {
    tables().ready
}

// ───────────────────────────────────────────────────────────── the spell → class index

/// Wiki class name → `/who` code. The wiki spells the Shadow Knight BOTH ways across its own spell
/// pages ("Shadow Knight" 75x, "Shadowknight" 15x in the committed DB); both canonicalize to SHD.
fn abbr_by_wiki_name(name: &str) -> Option<ClassAbbr> {
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

/// `/\*\s*([A-Za-z][A-Za-z ]*?)\s*-\s*Level\s*\d+/g`, with JS's `\s` set and ASCII `\d` spelled
/// out (jsstr.rs). Each bullet is `* <Class> - Level <n>` with an optional trailing note; anything
/// that does not match that shape — the NPC-only and "No eligible class" strings — yields an empty
/// list rather than a guess.
fn class_bullet() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(&format!(
            r"\*{s}*([A-Za-z][A-Za-z ]*?){s}*-{s}*Level{s}*[0-9]+",
            s = JS_S
        ))
        .unwrap()
    })
}

/// `parseSpellClassString` — one `classes` field → the classes it names, deduped and sorted.
pub fn parse_spell_class_string(classes: Option<&str>) -> Vec<ClassAbbr> {
    let Some(classes) = classes else {
        return Vec::new();
    };
    let mut found: Vec<ClassAbbr> = Vec::new();
    for c in class_bullet().captures_iter(classes) {
        let name = eqlog::jsstr::js_trim(&c[1]).to_lowercase();
        if let Some(abbr) = abbr_by_wiki_name(&name) {
            if !found.contains(&abbr) {
                found.push(abbr);
            }
        }
    }
    found.sort_unstable();
    found
}

/// `spellClasses.ts INDEX` — canon key → the classes that can cast it, built ONCE from the DB the
/// parser already loaded (removals and corrections applied; see the header).
pub type SpellClassIndex = HashMap<String, Vec<ClassAbbr>>;

pub fn spell_class_index(db: &eqlog::spelldb::SpellDb) -> SpellClassIndex {
    let mut index: HashMap<String, HashSet<ClassAbbr>> = HashMap::new();
    for spell in &db.spells {
        let classes = parse_spell_class_string(spell.classes.as_deref());
        if classes.is_empty() {
            continue;
        }
        let set = index.entry(spell_canon_key(&spell.name)).or_default();
        for abbr in classes {
            set.insert(abbr);
        }
    }
    // `classesForSpell` sorts on the way out, so the stored form is sorted once instead.
    index
        .into_iter()
        .map(|(k, v)| {
            let mut out: Vec<ClassAbbr> = v.into_iter().collect();
            out.sort_unstable();
            (k, out)
        })
        .collect()
}

// ───────────────────────────────────────────────────────────── intake

/// The classes that can cast `spell`. spells.json FIRST (it is the authority on anything that has a
/// spell page, and its class list is per-rank-family), then the ability table. NEVER a union: where
/// both know a name they agree, and where they disagree the spell page wins.
fn cast_candidates(index: &SpellClassIndex, spell: &str) -> Vec<ClassAbbr> {
    let key = spell_canon_key(spell);
    if let Some(from_db) = index.get(&key) {
        if !from_db.is_empty() {
            return from_db.clone();
        }
    }
    tables().abilities.get(&key).cloned().unwrap_or_default()
}

/// One observation, or `None` when the event says nothing about class.
fn make(
    ev: &Event,
    source: &'static str,
    label: String,
    candidates: Vec<ClassAbbr>,
) -> Option<ClassObservation> {
    if candidates.is_empty() {
        return None;
    }
    // `[...new Set(candidates)].sort()` — dedupe in first-seen order, then sort.
    let mut deduped: Vec<ClassAbbr> = Vec::with_capacity(candidates.len());
    for c in candidates {
        if !deduped.contains(&c) {
            deduped.push(c);
        }
    }
    deduped.sort_unstable();
    Some(ClassObservation {
        ts: ev.ts(),
        seq: ev.seq(),
        source,
        label,
        candidates: deduped,
        weight: source_weight(source),
    })
}

/// `ev.classes.filter(isClassAbbr)` — the `/who` row's own three-letter codes.
pub fn who_classes(ev: &Event) -> Vec<ClassAbbr> {
    ev.arr_str("classes")
        .into_iter()
        .filter_map(|s| as_class_abbr(s))
        .collect()
}

/// Turn one event into class evidence. CONTEXT-FREE — every input it needs is on the event, which
/// is what keeps it pure (and what the header's measurement bought back: the one piece of context
/// it used to take turned out to say nothing).
pub fn class_observation(index: &SpellClassIndex, ev: &Event) -> Option<ClassObservation> {
    match ev.kind() {
        "selfWho" => make(ev, "who", "who".to_string(), who_classes(ev)),
        "stanceChange" => {
            let stance = ev.str("stance").unwrap_or_default().to_string();
            let cands = tables().stances.get(&stance).cloned().unwrap_or_default();
            make(ev, "stance", stance, cands)
        }
        "invocationChange" => {
            let inv = ev.str("invocation").unwrap_or_default().to_string();
            let cands = tables().invocations.get(&inv).cloned().unwrap_or_default();
            make(ev, "invocation", inv, cands)
        }
        "skillUp" => {
            // `skills` ONLY — see the header. An unlisted skill (every `Specialize <school>`, which
            // the wiki carries as one "Specialization" row) yields nothing rather than a guess.
            let skill = ev.str("skill").unwrap_or_default().to_string();
            let cands = tables().skills.get(&skill).cloned().unwrap_or_default();
            make(ev, "skillUp", skill, cands)
        }
        "poisonCoat" => {
            // eqlwiki Disciplines: "only Rogue poison disciplines are on Legends". Somebody ELSE's
            // blades (the third-person shapes) say nothing about this character.
            if ev.str("who") != Some("you") {
                return None;
            }
            make(
                ev,
                "poisonCoat",
                ev.str("poison").unwrap_or_default().to_string(),
                vec!["ROG"],
            )
        }
        "castBegin" => {
            let spell = ev.str("spell").unwrap_or_default();
            // The DISPLAY label strips the Roman rank and trims — `spellCanonKey` does the same and
            // lowercases, which is why the two are separate calls (see `strip_rank_tail`).
            let label = eqlog::jsstr::js_trim(&strip_rank_tail(spell)).to_string();
            let cands = cast_candidates(index, spell);
            make(ev, "cast", label, cands)
        }
        _ => None,
    }
}
