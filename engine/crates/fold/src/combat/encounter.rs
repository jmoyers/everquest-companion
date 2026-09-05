//! Encounter / zone-session record types, the segmentation constants and the encounter naming rule.
//! Pure data shapes and numbers; nothing here reads or mutates engine state.
//!
//! Closure is decided on two independent axes, and conflating them splits a multi-mob pull:
//!
//!   TIMING (damage only) — `LINGER_MS` runs against the encounter's last ATTRIBUTED DAMAGE, and a
//!     fight finalizes at that ts, never at the eval moment. Nothing else may touch this clock.
//!   PRESENCE (any evidence) — whether an engaged instance is still in the fight, refreshed by any
//!     observation of it. Presence never opens or extends an encounter; it only vetoes closing one.
//!
//! `PRESENCE_GONE_MS` is 4x `LINGER_MS` because real fights go quiet for many seconds at a time
//! (miss streaks, cast phases, a stun), and a fled mob still closes at `FALLBACK_IDLE_MS`.
//! `CC_HOLD_MS` exceeds `FALLBACK_IDLE_MS` so an actively refreshed mez holds a fight open; the hold
//! vetoes only the death-close, never closure as such.
//!
//! `ZONE_HISTORY_CAP` is borrowed, not chosen: a session mark mints an entry here too, and the marks
//! are bounded by `shared/sessionSegments.MAX_SESSION_MARKS`. Two rings at two depths would let the
//! loot picker offer a session the meter had already dropped.

use crate::combat::aggregate::Agg;
use crate::jsmap::JsMap;
use serde::Serialize;
use std::collections::HashSet;

/// One coated poison and when it went on.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoatSlot {
    /// DB spell name, or `unknown` when the line refused to name it.
    pub poison: String,
    /// Epoch ms of the coat line.
    pub since_ts: i64,
}

/// Internal raw timeline record (absolute ts; converted to relative at snapshot).
#[derive(Debug, Clone)]
pub struct TimelineRaw {
    pub ts: i64,
    pub lane: String,
    pub category: String,
    pub amount: i64,
    pub crit: bool,
    pub modifiers: Vec<String>,
    pub kind: &'static str,
    /// `miss` / `resist` for avoided and resisted instants; `None` = a landed hit.
    pub outcome: Option<&'static str>,
    /// Miss subtype (dodge/parry/…) or `resisted`, for the tooltip.
    pub detail: Option<String>,
    /// Target/defender name, for the tooltip.
    pub target: Option<String>,
}

/// Internal raw timeline MARKER (absolute ts; converted to relative at snapshot).
#[derive(Debug, Clone)]
pub struct MarkerRaw {
    pub ts: i64,
    pub kind: &'static str,
    pub label: String,
    pub detail: Option<String>,
}

/// Internal raw stance/invocation span (absolute ts). `end` is `None` while active.
#[derive(Debug, Clone)]
pub struct StanceRaw {
    pub group: &'static str,
    pub name: String,
    pub start: i64,
    pub end: Option<i64>,
}

/// Why a zone session stopped accruing. `Zone` — a zone line (or the epoch boundary). `Mark` — the
/// user pressed "New session".
///
/// It is the merge-back eligibility test, which is why it is recorded rather than inferred: a split
/// the USER made is reversible, a boundary the WORLD made is not. A historical fold refuses marks,
/// so it only ever writes `Zone`; the variant is spelled anyway because `closedBy` serializes it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ZoneSessionClose {
    Zone,
    Mark,
}

impl ZoneSessionClose {
    pub fn as_str(self) -> &'static str {
        match self {
            ZoneSessionClose::Zone => "zone",
            ZoneSessionClose::Mark => "mark",
        }
    }
}

/// A finalized zone session: the live zone aggregate frozen at a zone line into a capped ring, so a
/// past zone's overall meter stays selectable.
#[derive(Debug)]
pub struct ZoneSession {
    pub id: String,
    pub zone: String,
    pub agg: Agg,
    pub closed_by: ZoneSessionClose,
    /// First/last attributed-damage ts. 0 means the session saw none — and those are dropped.
    pub start_ts: i64,
    pub last_ts: i64,
    /// Sum of finalized-encounter wall durations (ms) — the DPS denominator.
    pub finalized_ms: i64,
    /// Sum of finalized-encounter `active_ms`.
    pub active_ms: i64,
}

/// One in-progress or finalized FIGHT.
#[derive(Debug)]
pub struct Encounter {
    pub id: String,
    /// The zone this fight happened in, stamped at open. Absent — never null — for a session that
    /// started mid-zone.
    pub zone: Option<String>,
    pub start_ts: i64,
    pub last_ts: i64,
    pub agg: Agg,
    /// Instance ids engaged as hostiles. The one thing that can veto closure.
    pub engaged: HashSet<String>,
    /// instanceId → ts of the last evidence this instance is still in the fight. The presence axis:
    /// misses, resists, CC and heals refresh it as well as damage, because a mob that whiffs for
    /// eight seconds is still here. It drives only the "gone" staleness in `eval_closure` and never
    /// feeds firstHit/lastHit/DPS/activeMs.
    pub engaged_seen: JsMap<i64>,
    /// Active-combat time accumulator (ms): on each attributed damage hit we add
    /// `min(ts - prev_damage_ts, ACTIVE_MS)`. The first hit adds 0.
    pub active_ms: i64,
    /// ts of the previous attributed damage hit, for the `active_ms` delta.
    pub prev_damage_ts: Option<i64>,
    /// instanceId → epoch-ms until which this engaged instance is CC-held. A CC'd instance counts as
    /// alive, so a mez-and-wait keeps the encounter open regardless of damage gaps.
    pub cc_active_until: JsMap<i64>,
    /// Display name of the most recent outgoing-damage target — the LIVE encounter name tracks
    /// whatever you are currently swinging at. On finalize the name switches to the largest target.
    pub last_out_target: Option<String>,
    /// The finalized fight's memoized summary, computed once at finalize because the aggregate is
    /// immutable thereafter. Recomputing it per history entry per snapshot dominated snapshot cost.
    pub summary: Option<crate::combat::lifecycle::SegmentSummary>,
    /// Per-encounter timeline event ring (absolute ts), capped drop-oldest at `TIMELINE_CAP`.
    /// Retained only for the most recent `TIMELINE_HISTORY_CAP` finalized encounters.
    pub events: Vec<TimelineRaw>,
    /// True count of every instant ever pushed, including ones the cap evicted. The only way a
    /// consumer can tell "the ring is full" from "the fight was that long", since `events.len()`
    /// saturates. No aggregate, total or attribution reads it.
    pub events_total: i64,
    /// Stance/invocation spans that overlapped this encounter (absolute ts). Deliberately not the
    /// session state timeline: this list feeds the timeline view. Two lists, one writer.
    pub stance_spans: Vec<StanceRaw>,
    /// Point annotations on this fight's clock: stance/invocation commits, blade coats, slow
    /// landings. Never downsampled and never counted from; the cap is purely a memory bound.
    pub markers: Vec<MarkerRaw>,
    /// The utility blade coat on at open and the combat venoms alongside it, snapshotted here
    /// because "could this pull have been slowed?" is a question about the moment of ENGAGE —
    /// re-reading today's coat at render would re-label every past fight after a poison swap.
    pub coat_at_engage: Option<CoatSlot>,
    pub combat_at_engage: Vec<CoatSlot>,
}

impl Encounter {
    pub fn new(id: String, zone: Option<String>, ts: i64) -> Encounter {
        Encounter {
            id,
            zone,
            start_ts: ts,
            last_ts: ts,
            agg: Agg::new(),
            engaged: HashSet::new(),
            engaged_seen: JsMap::new(),
            active_ms: 0,
            prev_damage_ts: None,
            cc_active_until: JsMap::new(),
            last_out_target: None,
            summary: None,
            events: Vec::new(),
            events_total: 0,
            stance_spans: Vec::new(),
            markers: Vec::new(),
            coat_at_engage: None,
            combat_at_engage: Vec::new(),
        }
    }
}

pub const LINGER_MS: i64 = 5_000;
pub const PRESENCE_GONE_MS: i64 = 20_000;
pub const FALLBACK_IDLE_MS: i64 = 60_000;
pub const CC_HOLD_MS: i64 = 120_000;
/// Per-hit active-time cap AND the "in combat" freshness window.
pub const ACTIVE_MS: i64 = 3_000;
pub const ZONE_HISTORY_CAP: usize = 24;
/// How many classified lines the live processing log holds. A display buffer: nothing keys, counts
/// or attributes off it, and a snapshot serializes at most the newest 150.
pub const RECENT_CAP: usize = 300;
/// How many recent qualifying pulls (a slow-capable coat on at engage) the rolling time-to-slow ring
/// keeps. Small on purpose: it answers "how is my poison doing right now".
pub const SLOW_SAMPLE_CAP: usize = 25;

/// Per-encounter timeline ring bound. Sized above the densest fight measured in the owner's full log
/// (5,259 instants once misses and resists joined the ring) so nothing is dropped in practice; an
/// overflow is DECLARED rather than silent, via `events_total` and the view's `truncated` flag.
pub const TIMELINE_CAP: usize = 8_000;
/// How many finalized encounters keep their event ring after finalize. Older ones drop the ring, so
/// the whole-session RSS delta stays bounded across thousands of fights.
pub const TIMELINE_HISTORY_CAP: usize = 60;
/// Max events serialized into a single timeline view; above this the engine downsamples with a uniform
/// stride and flags it.
pub const TIMELINE_BUDGET: usize = 2_000;
/// Per-encounter marker ring. Markers are point annotations, never downsampled (uniform-striding a
/// sparse series just deletes it) and never counted from. A pure memory bound.
pub const MARKER_CAP: usize = 1_000;

/// The name of an encounter. Two modes:
///
///   `live = false` — named after the largest target. The log has no HP, so "most damage absorbed"
///     is a labeled proxy for "the thing we were killing" (world-model law 6).
///   `live = true` — named after whatever you are presently swinging at, so a live pull is labeled
///     by the mob in front of you rather than by whichever twin ends up taking the most damage.
///
/// Both keep the `+N` suffix counting the other distinct engaged targets.
///
/// The sort must be STABLE: two targets that absorbed exactly the same damage are named in the order
/// they were first struck, and `sort_unstable_by` would silently pick a different winner on a tie.
pub fn encounter_name(e: &Encounter, live: bool) -> String {
    let targets: Vec<&crate::combat::aggregate::NamedTotal> = e.agg.targets.values().collect();
    if targets.is_empty() {
        return "Combat".to_string();
    }
    let others = targets.len() - 1;
    let suffix = if others > 0 {
        format!(" +{others}")
    } else {
        String::new()
    };
    if live {
        if let Some(name) = &e.last_out_target {
            return format!("{name}{suffix}");
        }
    }
    let mut ranked = targets;
    ranked.sort_by_key(|t| std::cmp::Reverse(t.amount));
    format!("{}{}", ranked[0].name, suffix)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn enc_with(targets: &[(&str, i64)]) -> Encounter {
        let mut e = Encounter::new("e1".into(), None, 0);
        for (name, amount) in targets {
            e.agg.bump_target(name, name, *amount);
        }
        e
    }

    /// A fight with no target at all is `Combat`.
    #[test]
    fn a_fight_that_struck_nothing_is_called_combat() {
        assert_eq!(
            encounter_name(&Encounter::new("e1".into(), None, 0), false),
            "Combat"
        );
    }

    /// A finalized fight is named after the largest target and counts the others.
    #[test]
    fn a_finalized_fight_is_named_after_the_largest_target() {
        let e = enc_with(&[("a bat", 100), ("a spite golem", 500), ("a rat", 20)]);
        assert_eq!(encounter_name(&e, false), "a spite golem +2");
    }

    /// A tie keeps the order the targets were first struck in — the stable-sort property.
    #[test]
    fn a_tie_is_broken_by_which_target_was_struck_first() {
        let e = enc_with(&[("a bat", 100), ("a spite golem", 100)]);
        assert_eq!(encounter_name(&e, false), "a bat +1");
        let e = enc_with(&[("a spite golem", 100), ("a bat", 100)]);
        assert_eq!(encounter_name(&e, false), "a spite golem +1");
    }

    /// A live fight is named after what you are swinging at, falling back to the largest target
    /// until something outgoing has landed.
    #[test]
    fn a_live_fight_is_named_after_the_current_target() {
        let mut e = enc_with(&[("a bat", 100), ("a spite golem", 500)]);
        assert_eq!(encounter_name(&e, true), "a spite golem +1");
        e.last_out_target = Some("a bat".into());
        assert_eq!(encounter_name(&e, true), "a bat +1");
        // …and the finalized name is unmoved by it.
        assert_eq!(encounter_name(&e, false), "a spite golem +1");
    }
}
