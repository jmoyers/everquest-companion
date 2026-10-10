//! The landing gate: what, if anything, does a landing sentence entitle the model to draw?
//!
//! Five cases, in order.
//!
//!   1. A named anchor wins. `You begin casting <S>.` names the spell and the rank, so a candidate
//!      with one in window resolves to THAT CANDIDATE'S DB NAME. The rank is kept beside it as
//!      `cast_name`; what it may not be is the spell's identity.
//!   2. Several of your own casts sharing one sentence resolve to the most recent.
//!      2b. A weapon or item PROC (upstream issue #69, opt-in): no cast line exists, so the anchor is
//!      your own melee hit on the target inside the proc window, and the spell is the ONE candidate
//!      some item you hold procs. Two held procs sharing a sentence is a coin flip and is refused,
//!      exactly as case 3's family refuses a duration its members do not agree on.
//!   3. A Quick Buff burst admits the landing as yours but names no spell — the AA applies many
//!      spells at once with no cast line of their own. Two narrowings then apply, and neither
//!      admits anything the burst has not already: a candidate you have ever cast, then one you
//!      already have up. Failing both the row stays a FAMILY, stating a duration only when every
//!      candidate agrees on one and on its nature. A family mints nothing into the learner.
//!   4. Nothing else. An unanchored landing produces nothing.
//!
//! The identity is the DB name and not the cast line's: the anchor and the candidate were matched
//! under `spell_key`, so they are the same spell by construction and differ only in how the log
//! wrote it down — and the DB name is the string every other surface states.

use crate::event::{Event, Key};
use crate::modules::buff_anchors::CastAnchors;
use crate::modules::buffs_shapes::{spell_key, SELF_CASTER};
use crate::spell_facts::{Nature, SpellFacts};

/// A candidate spell carried by an ambiguous landing message.
#[derive(Debug, Clone)]
pub struct Candidate {
    pub name: String,
    pub duration_ms: Option<i64>,
    pub illusion: bool,
}

/// The `buffApply` candidate shape. Here rather than in buffs.rs because the shape is this
/// file's type, and because buffs.rs sits at the factoring bar.
pub fn candidates_of(ev: &Event) -> Vec<Candidate> {
    ev.candidates(Key::Candidates)
        .into_iter()
        .map(|(name, duration_ms, illusion)| Candidate {
            name,
            duration_ms,
            illusion,
        })
        .collect()
}

/// The `buffWearOff` candidate shape — plain names.
pub fn wear_off_candidates(ev: &Event) -> Vec<String> {
    ev.arr_str(Key::Candidates)
        .into_iter()
        .map(str::to_string)
        .collect()
}

/// What the gate admitted.
pub struct AdmittedLanding {
    pub spell: String,
    pub duration_ms: Option<i64>,
    pub illusion: bool,
    pub caster: String,
    /// The ranked display name as the cast line spelled it, when a named anchor resolved this
    /// landing and it says something the DB name does not. An equal string is not a second fact.
    pub cast_name: Option<String>,
    /// The LINE this instance is identified by, when it differs from the display name.
    pub line_key: Option<String>,
    /// Present only for a family row — every spell the sentence could be.
    pub candidates: Option<Vec<String>>,
}

/// The one duration every candidate agrees on, or nothing.
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

/// Cases 1 and 2: the candidate with a named anchor in window, most recently cast first. The
/// recency tiebreak reads `last_cast_ts` — the self-only ever-cast map — not the anchor's own ts.
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

/// Case 2b: the one candidate the proc gate vouches for. `target` is the landing's subject as the
/// event spelled it; the anchors key it the way they keyed your swing.
fn proc_landing(
    cands: &[Candidate],
    target: &str,
    ts: i64,
    anchors: &CastAnchors,
) -> Option<AdmittedLanding> {
    let mut vouched = cands
        .iter()
        .filter(|c| anchors.proc_evidence(&c.name, target, ts));
    let one = vouched.next()?;
    if vouched.next().is_some() {
        return None;
    }
    Some(resolved(one, SELF_CASTER, None))
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

/// A landing the burst admits but nobody can narrow: draw the family rather than nothing, but only
/// while the ambiguity does not reach a claim. Every candidate must agree on NATURE (or the row
/// could not choose a window) and on one stated duration. Disagree on either and the answer is
/// nothing, because picking one of them would be a coin flip — which is what happens to `is
/// resistant to magic.`, three spells in the committed DB whose durations do not agree.
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
    // The de-dupe keeps the FIRST spelling of each name; the sort is over the deduped list.
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
        // Keyed on the alphabetically first candidate's LINE — safe only because the family was
        // admitted on unanimous nature and one agreed duration, so every question the key answers
        // has the same answer whichever member it names.
        line_key: Some(spell_key(&names[0])),
        candidates: Some(names),
    })
}

/// Locale-style ordering over spell names, which are the ASCII strings spells.json holds — NOT
/// codepoint order, which would sort every capitalized name ahead of every lowercase one. Spelled
/// out as the case-insensitive-then-case-sensitive ordering ICU's default collation gives for the
/// letters, digits, spaces and apostrophes an EQ spell name can contain; the goldens check it.
pub fn compare_names(a: &str, b: &str) -> std::cmp::Ordering {
    let folded = collate_key(a).cmp(&collate_key(b));
    if folded != std::cmp::Ordering::Equal {
        return folded;
    }
    a.cmp(b)
}

/// The primary collation weight: letters and digits compared case-insensitively, everything else
/// ignored — what ICU's default strength does with the "variable" characters.
fn collate_key(s: &str) -> Vec<char> {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// The gate. See this file's header for the five cases, in order.
pub fn admit_landing(
    cands: &[Candidate],
    target: &str,
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
    if let Some(proc) = proc_landing(cands, target, ts, anchors) {
        return Some(proc);
    }
    // `attribute` reports `unnamed` for every candidate under a burst, so asking with the first one
    // is asking about the burst.
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
