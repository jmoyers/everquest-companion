//! THE PROC / MODIFIER LEDGER ROUTING plus the stance-and-invocation pair
//! (`src/main/combat/procRouting.ts`).
//!
//! Everything here is ANNOTATION, never damage: a coat, a rogue-poison Strike, a dispel landing, a
//! stance commit. None of it opens, extends or closes an encounter (world-model law 8's rule for
//! misses applies to all of them); each attaches to the fight in progress only while that fight is
//! FRESH, and always to the zone aggregate.
//!
//! ── EVERY STATE CHANGE STAMPS THE MINUTE LEDGER, AND THAT IS NOT BOOKKEEPING ──────────────────
//!
//! The window stamp is what makes the Tier-B purity gate implementable: the minute a state changed in
//! is DISCARDED from that state's comparison, because the boundary carries the reuse timer, the
//! re-buff burst and the mid-window re-target — precisely the confound. BOTH ledgers are stamped (the
//! fresh encounter's and the zone's) for the same reason every other proc counter is: a finalized zone
//! session must inherit it frozen.

use crate::combat::encounter::{CoatSlot, MarkerRaw};
use crate::combat::poisons::{coat_line_key, is_dispel_family, SLOW_STRIKE};
use crate::combat::procbuffs::proc_buff_in_candidates;
use crate::combat::procdetect::{self_landing_proc_in, CastVerdict, ProcSide, SpellProcFold};
use crate::combat::state::EngineState;
use crate::combat::statetimeline::{state_key_of, EdgeEvidence, OpenState, StateKind};
use eqlog::names::id_key;

/// The two exclusivity-group prefixes the coat slots write spans under. ONE list, so a clear can never
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

/// Stamp a transition into both minute ledgers. Destructured rather than routed through `&mut self`
/// methods because the ACTIVE SET and the two aggregates are three different fields of one state
/// object and Rust will not lend the first while the second is being written.
fn note_state_transition(st: &mut EngineState, group: &str, ts: i64) {
    let active = &st.state_timeline.active;
    st.zone_agg.windows.note_transition(ts, group, active);
    if let Some(enc) = st.current.as_mut() {
        if ts - enc.last_ts <= crate::combat::encounter::FALLBACK_IDLE_MS {
            enc.agg.windows.note_transition(ts, group, active);
        }
    }
}

/// Close a span from a printed line, with the same window stamp — an END is a transition too.
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

/// Apply a blade coat. ONLY your own coats move state — a third-person coat line is another player's
/// blades and is dropped. A UTILITY coat replaces the one utility slot; a COMBAT venom replaces
/// whatever is on ITS OWN LINE and stacks with the other lines. An `unknown` poison is recorded in the
/// segment's coat list (the blades demonstrably got re-coated) but never placed in a slot — we cannot
/// claim what is on them.
///
/// THE LINE, NOT THE NAME. The stack used to be keyed on the venom's NAME, which is right for a
/// re-coat of the same venom and wrong for an upgrade: the wiki says Cobra Venom "replaces" Asp Venom
/// and Blood Draw Venom "replaces" Blood Siphon Venom, so a name-keyed stack would have shown FOUR or
/// FIVE simultaneous venoms where the game allows three. Nothing in the owner's log exercises it —
/// this character is level 45 and both upgrades are level 46 — so the rule comes from the wiki, and
/// the log neither confirms nor contradicts it.
pub fn route_coat(st: &mut EngineState, ev: &CoatLine) {
    if id_key(ev.who) != "you" {
        // SOMEBODY ELSE'S BLADES. Nothing here models a stranger's poison, and the line is kept
        // anyway: it is the sort of thing a person scanning the processing log wants to see went by.
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
    // ACTIVE-STATE SPAN. An `unknown` poison opens NO span: the blades demonstrably got re-coated, but
    // the line refused to name what is on them, and a span keyed on a name we do not have would be an
    // invention. The utility slot is one exclusive group; each combat venom LINE is its own group,
    // because venoms on different lines STACK (wiki, Rogue page — and the real log proves it: three
    // venoms coated eighteen minutes before a utility coat were all still proccing afterwards).
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

/// A coat wore off / was replaced. The line names no poison, only which FAMILY dried:
///   utility — unambiguous, there is only ever one; clear it, and its span ends `observed`.
///   combat  — the log CANNOT say which venom of a stack expired (law 6). We clear the whole stack
///             rather than pick one and close every span `inferred`: under-claiming what is coated is
///             honest, while claiming an observed end for a venom the line never named is not.
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

/// STRIP EVERY BLADE COAT, BOTH FAMILIES, AND END THEIR OPEN SPANS AT `ts`.
///
/// ONE DOOR FOR EVERY CLEARER, which is the whole reason this is a function and not three inline pairs
/// of assignments. Before it, DEATH cleared the slots in the ingest switch while EPOCH censored the
/// spans and left the slots standing — the same slot/span disagreement the death rule was written to
/// cure, rebuilt one case over.
///
/// `censored`, NEVER `observed` OR `inferred` (law 1). No line printed an end for these spans: a death
/// severs them at a known instant we did not see the poison leave, and a class swap is not even dated.
/// `censored` is precisely "our knowledge stops here", and it never renders as an end time.
///
/// IT STAMPS THE WINDOW TRANSITION, exactly as a dry line does: a boundary that silently ended four
/// coats is the last minute the purity gate should believe was clean.
///
/// Returns whether anything was actually cleared. Cheap on bare blades: two field reads and a return.
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
    // COATS COME BACK ONLY WHEN A NEW COAT LINE IS FOLDED. Nothing here re-arms anything and no clear
    // writes a coat observation anywhere, which is what keeps this one-directional against the class
    // model that triggers it (a coat is ROG evidence at weight 3, so a clear that fed the inference
    // back would be a loop).
    st.log(
        ts,
        "poison",
        "info",
        format!("☠ blades bare - {}", reason.note()),
    );
    true
}

/// WHY A SET OF BLADES WENT BARE WITHOUT THE GAME PRINTING A LINE — `CoatClearReason`, and its one
/// sentence each.
///
/// THE THIRD ARM IS UNREACHABLE IN THIS FOLD AND IS STATED ANYWAY. `ClassSwap` is the coat/class
/// sweep's boundary, and that sweep returns before it can ever fire here — this crate wires no combo
/// provider, so it has nothing to ask (`ingest::sweep_coat_class`). Spelling the variant is what
/// keeps the reason table a table rather than a pair plus a gap somebody has to notice.
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
            // A BACKTICK, not an apostrophe, and it is the app's own spelling rather than a typo
            // reproduced: the sentence is copied verbatim so a bug report quoting one line is
            // findable in either tree.
            Self::Epoch => "a character rebirth - the coats were the previous character`s",
        }
    }
}

/// A tracked PROC BUFF landed on you. Gated to the catalog — the same discipline the dispel family
/// applies, and for the same reason.
///
/// A re-apply SUPERSEDES its own span with `inferred` — the game printed a new landing, not an end.
/// That is not a rounding detail: in the real log `Instrument of Nife` lands 97 times and fades exactly
/// ONCE, so almost every one of its spans ends in an inference and the model has to SAY so rather than
/// fabricate an expiry.
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

/// A tracked proc buff's OWN wears-off line — the rare case where the end is PRINTED, so the span
/// closes `observed`.
pub fn route_proc_buff_wear_off(st: &mut EngineState, ts: i64, candidates: &[String]) {
    let Some(def) = proc_buff_in_candidates(candidates) else {
        return;
    };
    let key = id_key(def.name);
    end_state(st, StateKind::Buff, &key, ts, EdgeEvidence::Observed);
}

/// A PROC WHOSE ONLY PRINTED EVIDENCE IS THIS LANDING.
///
/// A THIRD disjoint gate over the same landing stream, and it consumes nothing the other two want: the
/// dispel family names a lane on a MOB, the proc-buff catalog opens a SELF-BUFF SPAN, and this one
/// counts a FIRING. A spell could in principle sit in two of them; none short-circuits the others, so
/// that would be two true statements about one line rather than a conflict.
///
/// IT PAYS THE SAME CAST JOIN EVERY OTHER PROC PAYS. Nothing in the registry is player-castable today,
/// so the gate never fires on the shipped entry — it is here so the registry cannot grow a castable
/// spell and start reporting the caster's own casts as procs.
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
    // ANNOTATION, NEVER DAMAGE: a landing opens no encounter and extends none. It folds into the fight
    // in progress only while that fight is FRESH, and always into the zone aggregate — the same two
    // ledgers, in the same order, the analytics fold writes.
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
/// ATTRIBUTION, HONESTLY: the emote names no caster, so this is never claimed as "your" proc on its
/// own. It is counted against the fight it lands in, and the SLOW timing is only reported for pulls
/// that opened with a slow-capable coat on — which is the closest the log lets anyone get to "my
/// poison did that".
///
/// A proc never OPENS an encounter (it is not damage), but it IS presence evidence: a mob that just got
/// slowed is emphatically still in the fight.
///
/// A proc on YOU is an incoming mob effect, not our poison. Nor is a proc on anything we are not
/// fighting: the log has a `Hakon blinks, looking confused!` — another PLAYER taking a Concussive
/// Strike from somebody else's blades — and counting that as a proc of ours would be a claim the line
/// does not support.
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

/// Count a DISPEL landing on an engaged hostile.
///
/// TWO gates, both load-bearing: the CURATED FAMILY (the raw landing stream is far too broad to
/// tabulate — one lifetap message alone resolves to 36 candidate spells) and ENGAGED (the ledger
/// describes THIS fight, not every dispel in earshot). The candidates go into the label verbatim: each
/// tier is shared by 2–3 spells (law 3), so the count is exact while the name stays honestly uncertain.
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

/// Apply a stance/invocation change. Updates the current pair and, if an encounter is open, closes the
/// prior span at this ts and opens a new one for the timeline's pinned rows.
///
/// THE NO-OP RE-ASSERT RETURNS EARLY, and it is load-bearing rather than an optimisation: the nine
/// stances (and the nine invocations) are mutually exclusive, so a commit ENDS the previous span — the
/// game prints no "your stance ends" line, ever — and without this guard a re-assert of the stance you
/// are already in would accrue a zero-width span and move `stanceTs` to a moment nothing happened at.
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
    // SESSION SPAN, alongside — never instead of — the encounter's own span list below: that list feeds
    // the shipped timeline view and sits inside the byte-identical regression surface. Two lists, one
    // writer.
    let kind = if is_stance {
        StateKind::Stance
    } else {
        StateKind::Invocation
    };
    let key = id_key(name);
    commit_state(st, kind, &key, name, ts, Some(group.to_string()));
    // Reflect the change on the OPEN encounter's span list (if any) — `current`, not `fresh_encounter`:
    // a standing choice belongs to whatever fight is open, stale or not.
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
        // The same commit is ALSO a point annotation (the chart draws a tick at it) and a counter on
        // the segment's proc ledger. The span drives the timeline's pinned rows; the marker drives the
        // DPS curve's ticks. Both, because they answer different questions — "what was on" versus
        // "when did it change".
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
