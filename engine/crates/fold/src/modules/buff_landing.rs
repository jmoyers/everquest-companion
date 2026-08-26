//! `src/main/modules/buffLanding.ts` — THE GATE: what, if anything, does a landing sentence entitle
//! the model to draw (JOS-140, rulings 2 and 3)?
//!
//! FOUR CASES, IN ORDER:
//!
//!   1. A NAMED ANCHOR wins. `You begin casting <S>.` names the spell AND the rank, so a candidate
//!      with one of those inside the window resolves outright — to THAT CANDIDATE'S DB NAME
//!      (JOS-238). The rank the landing line never carries is kept beside it as `cast_name`; what
//!      it is no longer allowed to be is the spell's IDENTITY.
//!   2. SEVERAL of your own casts sharing one sentence resolve to the MOST RECENT. Not a coin flip
//!      between you and a stranger — every candidate here is yours.
//!   3. A QUICK BUFF BURST admits the landing as yours but names NO spell (owner amendment,
//!      2026-08-09, from live testing: the AA applies many spells at once with no cast line of their
//!      own, so a rule demanding one per spell would refuse the player's own buffs). Two narrowings
//!      then apply, in order, and NEITHER admits anything — the burst already did: a candidate you
//!      have EVER cast, then a candidate you already have UP. Failing both, the row stays a FAMILY
//!      and states a duration only when every candidate agrees on one and on its nature. A family
//!      mints nothing into the learner, ever.
//!   4. Nothing else. An unanchored landing produces NOTHING — the Focus Death case, where one
//!      sentence is six spells and the player cast none of them.
//!
//! WHY THE IDENTITY IS THE DB NAME AND NOT THE CAST LINE'S. The anchor and the candidate were
//! matched under `spellKey` — rank-stripped and case-folded — so the two strings are the same spell
//! by construction and differ only in how the log wrote it down. The DB name is the string every
//! OTHER surface states (the catalog, a `where.spell` matcher, the wear-off sentence's own candidate
//! list); the ranked one is the string only this single cast line ever carried. Before JOS-238 the
//! ranked text travelled the whole way down — into the instance's display name, the learner's
//! display, and the derived `buffExpired` — so a suggested wear-off alert, which pins the bare
//! catalog name, could never match a spell cast at rank II or above.

use crate::modules::buff_anchors::CastAnchors;
use crate::modules::buffs_shapes::spell_key;
use crate::spell_facts::{Nature, SpellFacts};

/// A candidate spell carried by an ambiguous landing message.
#[derive(Debug, Clone)]
pub struct Candidate {
    pub name: String,
    pub duration_ms: Option<i64>,
    pub illusion: bool,
}

/// What the gate admitted.
pub struct AdmittedLanding {
    pub spell: String,
    pub duration_ms: Option<i64>,
    pub illusion: bool,
    pub caster: String,
    /// The RANKED display name exactly as the cast line spelled it, when a NAMED anchor resolved
    /// this landing and it says something the DB name does not. Absent when the anchor named no
    /// spell, when the landing stayed a family, and when the cast line already spelled the DB name —
    /// an equal string is not a second fact.
    pub cast_name: Option<String>,
    /// The LINE this instance is identified by, when it differs from the display name.
    pub line_key: Option<String>,
    /// Present only for a family row — every spell the sentence could be.
    pub candidates: Option<Vec<String>>,
}

/// `shared/buffTimers.ts statedDuration` — the one number every candidate agrees on, or nothing.
pub fn stated_duration(candidates: &[Candidate]) -> Option<i64> {
    let first = candidates.first()?.duration_ms?;
    candidates
        .iter()
        .all(|c| c.duration_ms == Some(first))
        .then_some(first)
}

fn resolved(cand: &Candidate, caster: &str, cast: Option<&str>) -> AdmittedLanding {
    AdmittedLanding {
        spell: cand.name.clone(),
        duration_ms: cand.duration_ms,
        illusion: cand.illusion,
        caster: caster.to_string(),
        cast_name: cast
            .filter(|c| *c != cand.name.as_str())
            .map(str::to_string),
        line_key: Some(spell_key(&cand.name)),
        candidates: None,
    }
}

/// Cases 1 and 2: the candidate with a NAMED anchor in window, MOST RECENTLY CAST first.
///
/// The recency tiebreak reads `last_cast_ts` — the self-only ever-cast map — rather than the
/// anchor's own ts, exactly as the TS does.
fn named_landing(cands: &[Candidate], ts: i64, anchors: &CastAnchors) -> Option<AdmittedLanding> {
    let mut best: Option<AdmittedLanding> = None;
    let mut best_ts = -1i64;
    for c in cands {
        let Some(at) = anchors.named_anchor_for(&c.name, ts) else {
            continue;
        };
        let t = anchors.last_cast_ts(&c.name).unwrap_or(-1);
        if t <= best_ts {
            continue;
        }
        best = Some(resolved(c, &at.caster, at.display.as_deref()));
        best_ts = t;
    }
    best
}

/// Burst narrowing (a): the candidate you have EVER cast, most recent first.
fn ever_cast_landing(
    cands: &[Candidate],
    caster: &str,
    anchors: &CastAnchors,
) -> Option<AdmittedLanding> {
    let mut best: Option<&Candidate> = None;
    let mut best_ts = -1i64;
    for c in cands {
        let Some(t) = anchors.last_cast_ts(&c.name) else {
            continue;
        };
        if t <= best_ts {
            continue;
        }
        best = Some(c);
        best_ts = t;
    }
    best.map(|c| resolved(c, caster, None))
}

/// Burst narrowing (b): the candidate you already have up (EQ stacking keeps one per family).
fn active_landing(
    cands: &[Candidate],
    caster: &str,
    has_active_spell: &dyn Fn(&str) -> bool,
) -> Option<AdmittedLanding> {
    cands
        .iter()
        .find(|c| has_active_spell(&spell_key(&c.name)))
        .map(|c| resolved(c, caster, None))
}

/// A landing the burst admits but nobody can narrow — the shape the reporter of JOS-136 hit.
///
/// MEASURED: their Quick Buff lands eleven spells in one second, and `is resistant to magic.` is
/// `Resist Magic`, `Group Resist Magic` AND `Resistance to Magic` in the committed DB. The old
/// resolver returned nothing for exactly this and the bar simply did not exist — which is a worse
/// answer than a family row whenever the ambiguity does not reach a claim.
///
/// So a family is admitted only when it does not: every candidate must agree on NATURE (or the row
/// could not choose a window) and `stated_duration` must find one number they all state. Disagree on
/// either and the answer is still nothing, because a row that picked one of them would be the coin
/// flip JOS-84 forbids — which is what happens to that particular sentence, where the third
/// candidate states 60 minutes against the other two's 36.
fn family_landing(
    cands: &[Candidate],
    caster: &str,
    facts: &SpellFacts,
) -> Option<AdmittedLanding> {
    let nature_of = |c: &Candidate| {
        facts
            .get(&spell_key(&c.name))
            .map_or(Nature::Unknown, |s| s.nature)
    };
    let first = nature_of(&cands[0]);
    if cands.iter().any(|c| nature_of(c) != first) {
        return None;
    }
    let duration_ms = stated_duration(cands)?;
    // `[...new Set(names)].sort(localeCompare)` — the de-dupe keeps the FIRST spelling of each name
    // and the sort is over the deduped list.
    let mut names: Vec<String> = Vec::new();
    for c in cands {
        if !names.iter().any(|n| n == &c.name) {
            names.push(c.name.clone());
        }
    }
    names.sort_by(|a, b| compare_names(a, b));
    Some(AdmittedLanding {
        spell: names.join(" / "),
        duration_ms: Some(duration_ms),
        illusion: cands.iter().all(|c| c.illusion),
        caster: caster.to_string(),
        cast_name: None,
        // Keyed on the alphabetically first candidate's LINE — a stable pick, and a safe one only
        // because the family was admitted on unanimous nature and one agreed duration, so every
        // question the key answers has the same answer whichever member it names.
        line_key: Some(spell_key(&names[0])),
        candidates: Some(names),
    })
}

/// `String.prototype.localeCompare` over SPELL NAMES, which are the ASCII strings spells.json holds.
///
/// IT IS NOT `byCodepoint` AND MUST NOT BE. `messageOverlay.ts` moved its own tie-break to codepoint
/// order on the argument that ICU's answer is host-dependent — and that argument was made about a
/// comparator whose result reaches PARSER OUTPUT. This one orders the members of a family row, which
/// is snapshot content. Ported as the case-insensitive-then-case-sensitive ordering ICU's default
/// collation gives for the ASCII letters, digits, spaces and apostrophes that spell every name in
/// the catalog, so that `Group Resist Magic` sorts before `Resist Magic` and `resist magic` sorts
/// beside it rather than after every capitalized name. The goldens are what check the claim.
pub fn compare_names(a: &str, b: &str) -> std::cmp::Ordering {
    let folded = collate_key(a).cmp(&collate_key(b));
    if folded != std::cmp::Ordering::Equal {
        return folded;
    }
    a.cmp(b)
}

/// The primary collation weight: letters and digits compared case-insensitively, and everything else
/// (spaces, apostrophes, backticks, punctuation) IGNORED — which is what ICU's default strength does
/// with the "variable" characters an EQ spell name can contain.
fn collate_key(s: &str) -> Vec<char> {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// THE GATE. See this file's header for the four cases, in order.
pub fn admit_landing(
    cands: &[Candidate],
    ts: i64,
    anchors: &CastAnchors,
    facts: &SpellFacts,
    has_active_spell: &dyn Fn(&str) -> bool,
) -> Option<AdmittedLanding> {
    if cands.is_empty() {
        return None;
    }
    if let Some(named) = named_landing(cands, ts, anchors) {
        return Some(named);
    }
    // The spell-less self anchor. `attribute` reports `unnamed` for every candidate under a burst,
    // so asking with the first one is asking about the burst.
    let burst = anchors.attribute(&cands[0].name, ts)?;
    if !burst.unnamed {
        return None;
    }
    if cands.len() == 1 {
        return Some(resolved(&cands[0], &burst.caster, None));
    }
    ever_cast_landing(cands, &burst.caster, anchors)
        .or_else(|| active_landing(cands, &burst.caster, has_active_spell))
        .or_else(|| family_landing(cands, &burst.caster, facts))
}
