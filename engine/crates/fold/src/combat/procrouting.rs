//! Proc / modifier ledger routing plus the stance-and-invocation pair
//! (`src/main/combat/procRouting.ts`).
//!
//! Everything here is annotation, never damage: a coat, a rogue-poison Strike, a dispel landing, a
//! stance commit. None of it opens, extends or closes an encounter; each attaches to the fight in
//! progress only while that fight is fresh, and always to the zone aggregate.
//!
//! Every state change stamps both minute ledgers, which is what makes the Tier-B purity gate
//! implementable — the minute a state changed in is discarded from that state's comparison. Both
//! ledgers, so a finalized zone session inherits the stamps frozen.

use crate::combat::encounter::{CoatSlot, MarkerRaw};
use crate::combat::poisons::{coat_line_key, is_dispel_family, SLOW_STRIKE};
use crate::combat::procbuffs::proc_buff_in_candidates;
use crate::combat::procdetect::{self_landing_proc_in, CastVerdict, ProcSide, SpellProcFold};
use crate::combat::state::EngineState;
use crate::combat::statetimeline::{state_key_of, EdgeEvidence, OpenState, StateKind};
use eqlog::names::id_key;

/// The two exclusivity-group prefixes the coat slots write spans under. One list, so a clear cannot
/// strip a slot family whose spans it forgot to close.
const COAT_GROUP_PREFIXES: [&str; 2] = ["coat:utility", "coat:combat:"];

/// Open a span on the session state timeline AND stamp the commit into the minute-window ledgers.
fn commit_state(
    st: &mut EngineState,
    kind: StateKind,
    key: &str,
    name: &str,
    ts: i64,
    group: Option<String>,
) {
    let group = group.unwrap_or_else(|| state_key_of(kind, key));
    st.state_timeline.note_state(&OpenState {
        kind,
        key,
        name,
        ts,
        group: Some(group.clone()),
    });
    note_state_transition(st, &group, ts);
}

/// Stamp a transition into both minute ledgers. Written against the fields directly because the
/// active set and the two aggregates are three fields of one state object, and the borrow checker
/// will not lend the first while the second is written.
fn note_state_transition(st: &mut EngineState, group: &str, ts: i64) {
    let active = &st.state_timeline.active;
    st.zone_agg.windows.note_transition(ts, group, active);
    if let Some(enc) = st.current.as_mut() {
        if ts - enc.last_ts <= crate::combat::encounter::FALLBACK_IDLE_MS {
            enc.agg.windows.note_transition(ts, group, active);
        }
    }
}

/// Close a span from a printed line, with the same window stamp — an end is a transition too.
fn end_state(st: &mut EngineState, kind: StateKind, key: &str, ts: i64, evidence: EdgeEvidence) {
    st.state_timeline.close_state(kind, key, ts, evidence);
    note_state_transition(st, &state_key_of(kind, key), ts);
}

/// One blade-coat line.
pub struct CoatLine<'a> {
    pub ts: i64,
    pub poison: &'a str,
    /// `utility`, `combat`, or `unknown` when the line named no family.
    pub group: &'a str,
    pub who: &'a str,
}

/// Apply a blade coat. Only your own coats move state — a third-person coat line is another player's
/// blades. A utility coat replaces the one utility slot; a combat venom replaces whatever is on its
/// own line and stacks with the other lines. An `unknown` poison is recorded in the segment's coat
/// list but never placed in a slot, because we cannot claim what is on the blades.
///
/// The stack is keyed on the venom's LINE, not its name: per the wiki an upgrade venom replaces its
/// predecessor (Cobra replaces Asp, Blood Draw replaces Blood Siphon), so a name-keyed stack would
/// show more simultaneous venoms than the game allows.
pub fn route_coat(st: &mut EngineState, ev: &CoatLine) {
    if id_key(ev.who) != "you" {
        // Somebody else's blades: nothing models a stranger's poison, but the line is worth showing
        // to a person scanning the processing log.
        st.log(
            ev.ts,
            "poison",
            "info",
            format!("☠ {} coated their blades", ev.who),
        );
        return;
    }
    let slot = CoatSlot {
        poison: ev.poison.to_string(),
        since_ts: ev.ts,
    };
    if ev.group == "utility" {
        st.coat_utility = Some(slot);
    } else if ev.group == "combat" {
        let line = coat_line_key(ev.poison);
        st.coat_combat.retain(|c| coat_line_key(&c.poison) != line);
        st.coat_combat.push(slot);
    }
    // A coat is not combat: it never opens or extends an encounter. It attaches to an in-progress
    // fight (the same freshness rule a miss uses) and always to the zone aggregate.
    let mark = crate::combat::aggregate::CoatMark {
        poison: ev.poison.to_string(),
        ts: ev.ts,
    };
    let label = if ev.poison == "unknown" {
        "poison"
    } else {
        ev.poison
    };
    if let Some(enc) = st.fresh_encounter(ev.ts) {
        enc.agg.procs.coats.push(mark.clone());
        EngineState::push_marker(
            enc,
            MarkerRaw {
                ts: ev.ts,
                kind: "coat",
                label: label.to_string(),
                detail: Some(format!("{} coat", ev.group)),
            },
        );
    }
    st.zone_agg.procs.coats.push(mark);
    // An `unknown` poison opens no span: a span keyed on a name the line refused to give would be an
    // invention. The utility slot is one exclusive group; each combat venom line is its own group,
    // because venoms on different lines stack (confirmed in the real log).
    if ev.poison != "unknown" && ev.group != "unknown" {
        let group = if ev.group == "utility" {
            "coat:utility".to_string()
        } else {
            format!("coat:combat:{}", coat_line_key(ev.poison))
        };
        let key = id_key(ev.poison);
        let name = ev.poison.to_string();
        commit_state(st, StateKind::Coat, &key, &name, ev.ts, Some(group));
    }
    let group = if ev.group == "unknown" {
        String::new()
    } else {
        format!(" ({})", ev.group)
    };
    st.log(ev.ts, "poison", "info", format!("☠ coated: {label}{group}"));
}

/// A coat wore off or was replaced. The line names no poison, only which family dried:
///   utility — unambiguous, there is only ever one; its span ends `observed`.
///   combat  — the log cannot say which venom of a stack expired, so the whole stack is cleared and
///             every span closes `inferred`, under-claiming rather than inventing an observed end.
pub fn route_dry(st: &mut EngineState, group: &str, ts: i64) {
    let utility = group == "utility";
    if utility {
        st.coat_utility = None;
    } else {
        st.coat_combat.clear();
    }
    let prefix = if utility {
        "coat:utility"
    } else {
        "coat:combat:"
    };
    let evidence = if utility {
        EdgeEvidence::Observed
    } else {
        EdgeEvidence::Inferred
    };
    st.state_timeline.close_group_prefix(prefix, ts, evidence);
    note_state_transition(st, prefix, ts);
    st.log(ts, "poison", "info", format!("☠ {group} coat dried"));
}

/// Strip every blade coat, both families, and end their open spans at `ts`.
///
/// One door for every clearer, so the slots and the spans cannot disagree.
///
/// The edges are `censored`, never `observed` or `inferred`: no line printed an end, so all we know
/// is that our knowledge stops here, and `censored` never renders as an end time.
///
/// It stamps the window transition like a dry line does — a boundary that silently ended four coats
/// is not a minute the purity gate should believe was clean.
///
/// Returns whether anything was cleared.
pub fn clear_coats(st: &mut EngineState, ts: i64, reason: CoatClearReason) -> bool {
    if st.coat_utility.is_none() && st.coat_combat.is_empty() {
        return false;
    }
    st.coat_utility = None;
    st.coat_combat.clear();
    for prefix in COAT_GROUP_PREFIXES {
        st.state_timeline
            .close_group_prefix(prefix, ts, EdgeEvidence::Censored);
        note_state_transition(st, prefix, ts);
    }
    // Coats come back only when a new coat line is folded. No clear writes a coat observation, which
    // keeps this one-directional against the class model that triggers it — a coat is ROG evidence,
    // so a clear feeding back into the inference would be a loop.
    st.log(
        ts,
        "poison",
        "info",
        format!("☠ blades bare - {}", reason.note()),
    );
    true
}

/// Why a set of blades went bare without the game printing a line, one sentence each.
///
/// `ClassSwap` is unreachable in this fold — the coat/class sweep returns before it can fire, since
/// this crate wires no combo provider — and is spelled anyway so the reason table stays a table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoatClearReason {
    Death,
    ClassSwap,
    Epoch,
}

impl CoatClearReason {
    fn note(self) -> &'static str {
        match self {
            Self::Death => "your death stripped every coat",
            Self::ClassSwap => "the loadout no longer contains ROG",
            // The backtick is deliberate: the sentence matches the app's own spelling verbatim so a
            // bug report quoting it is findable in either tree.
            Self::Epoch => "a character rebirth - the coats were the previous character`s",
        }
    }
}

/// A tracked proc buff landed on you. Gated to the catalog, like the dispel family.
///
/// A re-apply supersedes its own span with `inferred`, because the game printed a new landing and
/// not an end. Buffs are re-applied far more often than they are seen to fade, so nearly every span
/// ends in an inference and the model must say so rather than fabricate an expiry.
pub fn route_proc_buff_apply(st: &mut EngineState, ts: i64, target: &str, candidates: &[String]) {
    if target != "self" {
        return;
    }
    let Some(def) = proc_buff_in_candidates(candidates) else {
        return;
    };
    let key = id_key(def.name);
    commit_state(st, StateKind::Buff, &key, def.name, ts, None);
}

/// A tracked proc buff's own wears-off line — the rare case where the end is printed, so the span
/// closes `observed`.
pub fn route_proc_buff_wear_off(st: &mut EngineState, ts: i64, candidates: &[String]) {
    let Some(def) = proc_buff_in_candidates(candidates) else {
        return;
    };
    let key = id_key(def.name);
    end_state(st, StateKind::Buff, &key, ts, EdgeEvidence::Observed);
}

/// A proc whose only printed evidence is this landing.
///
/// A third gate over the same landing stream, disjoint from the other two by intent and not by
/// short-circuit: the dispel family names a lane on a mob, the proc-buff catalog opens a self-buff
/// span, this counts a firing. A spell in two of them yields two true statements about one line.
///
/// It pays the same cast join every other proc pays, so the registry cannot grow a castable spell
/// and start reporting the caster's own casts as procs.
pub fn route_self_landing_proc(st: &mut EngineState, ts: i64, target: &str, candidates: &[String]) {
    if target != "self" {
        return;
    }
    let Some(def) = self_landing_proc_in(candidates) else {
        return;
    };
    if st.recent_casts.origin(def.name, ts) != CastVerdict::Proc {
        return;
    }
    // Annotation, never damage: a landing opens no encounter and extends none. It folds into the
    // fight in progress only while that fight is fresh, and always into the zone aggregate.
    let fold = SpellProcFold {
        spell: def.name,
        side: ProcSide::Landing,
        amount: None,
        active: &st.state_timeline.active,
        click: false,
    };
    st.zone_agg.procs.add_spell_proc(&fold);
    if let Some(enc) = st.current.as_mut() {
        if ts - enc.last_ts <= crate::combat::encounter::FALLBACK_IDLE_MS {
            enc.agg.procs.add_spell_proc(&fold);
        }
    }
}

/// One rogue-poison Strike landing.
pub struct ProcLine<'a> {
    pub ts: i64,
    pub strike: &'a str,
    pub candidates: Vec<String>,
    pub target: &'a str,
    pub effect: &'a str,
}

/// A rogue-poison Strike landed on something.
///
/// The emote names no caster, so this is never claimed as "your" proc on its own. It is counted
/// against the fight it lands in, and the slow timing is reported only for pulls that opened with a
/// slow-capable coat on.
///
/// A proc opens no encounter — it is not damage — but it is presence evidence: a mob that just got
/// slowed is still in the fight.
///
/// A proc on you is an incoming mob effect, and a proc on anything we are not fighting is somebody
/// else's blades; neither is ours to count.
pub fn route_proc(st: &mut EngineState, ev: &ProcLine) {
    let is_slow = ev.effect == "slow";
    let key = id_key(ev.target);
    if key == "you" || !st.is_engaged_hostile(&key) {
        return;
    }
    let ambiguous = ev.candidates.len() > 1;
    let label = if ambiguous {
        ev.candidates.join(" / ")
    } else {
        ev.strike.to_string()
    };
    let target = ev.target.to_string();
    let fresh = st.fresh_encounter_id(ev.ts);
    if fresh {
        if let Some(enc) = st.fresh_encounter(ev.ts) {
            enc.agg.procs.add_strike(&label, ambiguous, ev.ts, is_slow);
            if is_slow {
                EngineState::push_marker(
                    enc,
                    MarkerRaw {
                        ts: ev.ts,
                        kind: "slow",
                        label: SLOW_STRIKE.to_string(),
                        detail: Some(target.clone()),
                    },
                );
            }
        }
        st.note_presence(&target, ev.ts);
    }
    st.zone_agg
        .procs
        .add_strike(&label, ambiguous, ev.ts, is_slow);
    st.log(ev.ts, "poison", "you", format!("☠ {label} → {target}"));
}

/// Count a dispel landing on an engaged hostile.
///
/// Two load-bearing gates: the curated family (the raw landing stream is far too broad — one lifetap
/// message alone resolves to 36 candidate spells) and engagement (the ledger describes this fight,
/// not every dispel in earshot). Candidates go into the label verbatim, since each message tier is
/// shared by 2–3 spells: the count is exact, the name stays uncertain.
pub fn route_dispel_landing(st: &mut EngineState, ts: i64, target: &str, candidates: &[String]) {
    if target == "self" || candidates.is_empty() {
        return;
    }
    if !candidates.iter().all(|c| is_dispel_family(c)) {
        return;
    }
    let key = id_key(target);
    if key == "you" || !st.is_engaged_hostile(&key) {
        return;
    }
    let label = candidates.join(" / ");
    if let Some(enc) = st.fresh_encounter(ts) {
        enc.agg.procs.add_dispel(&label);
    }
    st.zone_agg.procs.add_dispel(&label);
}

/// Apply a stance/invocation change. Updates the current pair and, if an encounter is open, closes
/// the prior span at this ts and opens a new one for the timeline's pinned rows.
///
/// The no-op re-assert returns early, and that is load-bearing rather than an optimisation: stances
/// are mutually exclusive and the game never prints a "your stance ends" line, so a commit is what
/// ends the previous span. Without the guard a re-assert would accrue a zero-width span and move the
/// stance's start to a moment nothing happened at.
pub fn apply_stance(st: &mut EngineState, group: &'static str, name: &str, ts: i64) {
    let is_stance = group == "stance";
    let cur = if is_stance {
        &st.stance
    } else {
        &st.invocation
    };
    if cur.as_ref().is_some_and(|m| m.name == name) {
        return;
    }
    let m = crate::combat::state::Modifier {
        name: name.to_string(),
        ts,
    };
    if is_stance {
        st.stance = Some(m);
    } else {
        st.invocation = Some(m);
    }
    // The session span sits alongside, never instead of, the encounter's own span list below, which
    // feeds the shipped timeline view. Two lists, one writer.
    let kind = if is_stance {
        StateKind::Stance
    } else {
        StateKind::Invocation
    };
    let key = id_key(name);
    commit_state(st, kind, &key, name, ts, Some(group.to_string()));
    // `current`, not `fresh_encounter`: a standing choice belongs to whatever fight is open, stale
    // or not.
    if let Some(enc) = st.current.as_mut() {
        if let Some(prev) = enc
            .stance_spans
            .iter_mut()
            .rev()
            .find(|s| s.group == group && s.end.is_none())
        {
            prev.end = Some(ts);
        }
        enc.stance_spans.push(crate::combat::encounter::StanceRaw {
            group,
            name: name.to_string(),
            start: ts,
            end: None,
        });
        // The span drives the timeline's pinned rows, the marker drives the DPS curve's ticks. Both,
        // because they answer different questions: what was on, versus when it changed.
        EngineState::push_marker(
            enc,
            MarkerRaw {
                ts,
                kind: if is_stance { "stance" } else { "invocation" },
                label: name.to_string(),
                detail: None,
            },
        );
        if is_stance {
            enc.agg.procs.stance_switches += 1;
        } else {
            enc.agg.procs.invocation_switches += 1;
        }
    }
    if is_stance {
        st.zone_agg.procs.stance_switches += 1;
    } else {
        st.zone_agg.procs.invocation_switches += 1;
    }
}
