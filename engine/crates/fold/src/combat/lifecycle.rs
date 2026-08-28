//! Encounter + zone-session lifecycle and the summary projections it produces: what opens a fight,
//! what closes one and on what evidence, and what a finalized fight or zone session freezes into.
//! The routing modules decide WHERE a line lands; this decides WHEN a segment begins and ends.
//!
//! The `max(1, …)` in every denominator is the definition, not a guard. A one-line fight has a span
//! of zero, and both its wall DPS and its active DPS are DEFINED to be its total rather than an
//! infinity — the floor is visible in the goldens, so guarding against the division some other way
//! changes recorded numbers.
//!
//! `activeSec` is `min(dur, activeMs / 1000)`: a fight cannot be active for longer than it lasted.

use crate::combat::aggregate::Agg;
use crate::combat::encounter::{
    encounter_name, Encounter, StanceRaw, ACTIVE_MS, FALLBACK_IDLE_MS, LINGER_MS, PRESENCE_GONE_MS,
    SLOW_SAMPLE_CAP, TIMELINE_HISTORY_CAP,
};
use crate::combat::poisons::is_slow_capable;
use crate::combat::state::EngineState;
use serde::Serialize;

/// One row of the snapshot's `segments` array.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentSummary {
    pub id: String,
    pub kind: &'static str,
    pub name: String,
    /// The zone this segment happened in (raw display name). Absent — never null — for a session
    /// that started mid-zone, which is a question the log genuinely cannot answer.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zone: Option<String>,
    pub duration_sec: f64,
    pub total: i64,
    pub dps: f64,
    /// Active combat time (capped-gap sum) in seconds; never greater than `duration_sec`.
    pub active_sec: f64,
    /// `total / active_sec` — active-time DPS.
    pub active_dps: f64,
    pub start_ts: i64,
    pub active: bool,
    /// Healing received by hostile instances during this segment (an annotation, not a total).
    pub enemy_heal_total: i64,
}

/// One row of the snapshot's `zoneSessions` array.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZoneSessionSummary {
    /// `zone` for the live session, else `zs<n>` for a finalized one.
    pub id: String,
    pub zone: String,
    /// Absent on the live entry, which has not ended at all.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub closed_by: Option<&'static str>,
    /// Epoch ms of the first attributed damage in this stay (0 if none / live-unstarted).
    pub start_ts: i64,
    /// Epoch ms of the last attributed damage; 0 for the still-live session.
    pub end_ts: i64,
    pub total: i64,
    pub dps: f64,
    pub live: bool,
}

/// Lazily open a fight. Closure is decided by `eval_closure`, which `ingest_event` runs BEFORE
/// routing, so this only ever has to mint one.
///
/// It guarantees `st.current.is_some()` on return rather than handing back a borrow: every caller
/// goes on to touch other fields of the state, which a returned `&mut Encounter` would lock.
pub fn ensure_encounter(st: &mut EngineState, ts: i64) {
    if st.current.is_some() {
        return;
    }
    st.seq += 1;
    let id = format!("e{}", st.seq);
    let mut enc = Encounter::new(id, st.zone.clone(), ts);
    // Seed the timeline's pinned rows with whatever stance/invocation is already active, so a fight
    // inherits the standing modifiers.
    if let Some(m) = &st.stance {
        enc.stance_spans.push(StanceRaw {
            group: "stance",
            name: m.name.clone(),
            start: ts,
            end: None,
        });
    }
    if let Some(m) = &st.invocation {
        enc.stance_spans.push(StanceRaw {
            group: "invocation",
            name: m.name.clone(),
            start: ts,
            end: None,
        });
    }
    // Freeze the coats as they stand at engage: "could this pull have been slowed?" is a question
    // about THIS instant, and re-reading at render would re-label past fights after a poison swap.
    enc.coat_at_engage = st.coat_utility.clone();
    enc.combat_at_engage = st.coat_combat.clone();
    st.current = Some(enc);
}

/// Is every engaged hostile instance gone? Two standards, because the evidence differs:
///
///   RETIRED (dead/zoned) → gone immediately. The death line is the evidence, and `LINGER_MS` in
///     `eval_closure` still covers its trailing damage.
///   LIVE → gone only after `PRESENCE_GONE_MS` with no presence evidence at all. Counting only
///     damage here makes a mob that is merely missing or casting look dead within the linger.
///
/// A live charmed pet is never a mob we are killing, so it is excluded — a pet never dies and would
/// pin every charm-grind encounter open forever.
fn hostile_presence(st: &EngineState, enc: &Encounter, now: i64) -> (usize, bool) {
    let mut hostiles = 0;
    let mut all_gone = true;
    for id in &enc.engaged {
        if st.world.is_live_pet(id) {
            continue;
        }
        hostiles += 1;
        let seen = enc.engaged_seen.get(id).copied().unwrap_or(enc.last_ts);
        let gone = st.world.is_retired(id) || now - seen >= PRESENCE_GONE_MS;
        if !gone {
            all_gone = false;
            break;
        }
    }
    (hostiles, all_gone)
}

/// Evaluate deferred closure of the current encounter as of `now`. Encounters can close purely from
/// time passing, so this runs at the top of each damage/CC ingest AND (live only) from the snapshot.
/// Finalization always stamps the encounter's own `last_ts` — a damage timestamp — never `now`, so
/// startTs/lastTs/duration reflect the real fight rather than the eval moment.
///
/// The CC hold is a veto on ONE path, not on closure. It vetoes only the death-close, because that
/// is the judgement it informs ("is this engaged instance still alive?"); the fallback asks whether
/// anything at all has happened, and a CC application or refresh stamps `last_activity_ts`, so an
/// actively refreshed mez still holds the fight open.
///
/// A hold only ever speaks for an engaged hostile. Two entities are excluded because they cannot
/// answer its question: a RETIRED instance (handled at the retirement site — the stamp is gone) and
/// a LIVE PET of ours. A charmed pet can share a name with the mobs being killed, so a wear-off line
/// otherwise resolves to the pet and pins the fight open for the whole hold.
pub fn eval_closure(st: &mut EngineState, now: i64) {
    let Some(enc) = &st.current else { return };

    let since_damage = now - enc.last_ts;
    let since_activity = now - st.last_activity_ts;

    // Fallback: no damage and no CC for the idle window (mob fled / deaggroed). Evaluated FIRST, so
    // it is reachable regardless of any outstanding hold.
    if since_activity >= FALLBACK_IDLE_MS {
        finalize_current(st);
        return;
    }

    // CC-hold: any engaged instance still under an unexpired hold vetoes the death-close, except one
    // of your own live pets.
    for (id, &until) in enc.cc_active_until.iter() {
        if until > now && !st.world.is_live_pet(id) {
            return;
        }
    }

    let (hostiles, all_gone) = hostile_presence(st, enc, now);

    // Death-close: every engaged hostile is dead or gone and the linger has elapsed.
    if all_gone && hostiles > 0 && since_damage >= LINGER_MS {
        finalize_current(st);
    }
}

/// Freeze the open fight into history. A no-op when nothing is open.
pub fn finalize_current(st: &mut EngineState) {
    let Some(mut enc) = st.current.take() else {
        return;
    };
    // Close any open stance/invocation spans at the fight's end, BEFORE the drop rule below, so a
    // dropped shell's spans are closed on the way out too.
    let last_ts = enc.last_ts;
    for s in &mut enc.stance_spans {
        if s.end.is_none() {
            s.end = Some(last_ts);
        }
    }
    // Drop empty encounters: a CC application or a lone miss can open one that never accrues
    // attributed damage, and a 0-damage shell must not pollute the history or the session picker.
    if enc.agg.is_empty() {
        return;
    }
    // Rolling time-to-slow. A pull qualifies only when a slow-capable utility coat was on AT ENGAGE;
    // otherwise it would deflate the denominator with pulls that could never land one. A qualifying
    // pull that never slowed is pushed as `None` — counted as a miss, never averaged in as a zero.
    if enc
        .coat_at_engage
        .as_ref()
        .is_some_and(|c| is_slow_capable(&c.poison))
    {
        let first = enc.agg.procs.first_slow_ts;
        st.slow_samples.push(if first > 0 {
            Some((first - enc.start_ts).max(0))
        } else {
            None
        });
        if st.slow_samples.len() > SLOW_SAMPLE_CAP {
            st.slow_samples.remove(0);
        }
    }
    st.zone_finalized_ms += (enc.last_ts - enc.start_ts).max(0);
    st.zone_active_ms += enc.active_ms;
    // Compute the immutable summary once, now that the encounter is frozen. A finalized fight's
    // summary never uses `now`, so 0 is a safe sentinel.
    enc.summary = Some(enc_summary(&enc, "fight", 0));
    st.history.push(enc);
    // Timeline memory bound: keep the event ring only for the most recent `TIMELINE_HISTORY_CAP`
    // finalized encounters. The aggregate and the summary are untouched — only the raw per-event
    // ring is released, and the view says so by returning no timeline for that fight.
    if st.history.len() > TIMELINE_HISTORY_CAP {
        let drop_idx = st.history.len() - 1 - TIMELINE_HISTORY_CAP;
        st.history[drop_idx].events.clear();
    }
}

/// The whole-stay row that `snapshot()` appends to `segments` after the fights.
pub fn zone_summary(st: &EngineState) -> SegmentSummary {
    let total = Agg::sum(&st.zone_agg.out);
    let dur = zone_duration_sec(st);
    let active_sec = f64::min(dur, zone_active_sec(st));
    SegmentSummary {
        id: "zone".to_string(),
        kind: "zone",
        name: format!("{} - overall", st.zone.as_deref().unwrap_or("Session")),
        zone: st.zone.clone(),
        duration_sec: dur,
        total,
        dps: total as f64 / dur,
        active_sec,
        active_dps: total as f64 / f64::max(1.0, active_sec),
        start_ts: 0,
        active: false,
        enemy_heal_total: Agg::sum_heal(&st.zone_agg.enemy_heal),
    }
}

/// One fight's summary. `kind` is `current` for the open one and `fight` for a finalized one, and it
/// decides both the NAMING mode and whether `active` can be true at all.
pub fn enc_summary(e: &Encounter, kind: &'static str, now: i64) -> SegmentSummary {
    let total = Agg::sum(&e.agg.out);
    let dur = f64::max(1.0, (e.last_ts - e.start_ts) as f64 / 1000.0);
    let active_sec = f64::min(dur, e.active_ms as f64 / 1000.0);
    SegmentSummary {
        id: e.id.clone(),
        kind,
        name: encounter_name(e, kind == "current"),
        // The fight-search haystack is name + zone, so a fight carries where it happened. Stamped at
        // open from the same field a zone session is named from, so the two cannot disagree.
        zone: e.zone.clone(),
        duration_sec: dur,
        total,
        dps: total as f64 / dur,
        active_sec,
        active_dps: total as f64 / f64::max(1.0, active_sec),
        start_ts: e.start_ts,
        active: kind == "current" && now - e.last_ts < ACTIVE_MS,
        enemy_heal_total: Agg::sum_heal(&e.agg.enemy_heal),
    }
}

/// The live zone stay's wall span in seconds, floored at 1. The open encounter's span rides on top
/// of the finalized total.
pub fn zone_duration_sec(st: &EngineState) -> f64 {
    let cur = st.current.as_ref().map_or(0, |e| e.last_ts - e.start_ts);
    f64::max(1.0, (st.zone_finalized_ms + cur) as f64 / 1000.0)
}

/// The live zone stay's active seconds — finalized encounters' `active_ms` plus the open one's.
pub fn zone_active_sec(st: &EngineState) -> f64 {
    let cur = st.current.as_ref().map_or(0, |e| e.active_ms);
    (st.zone_active_ms + cur) as f64 / 1000.0
}

/// The zone-session list for the snapshot: the LIVE session first (id `zone`), then the finalized
/// history NEWEST-FIRST. The live entry's timing and total are computed fresh; the finalized ones
/// reuse what was frozen at finalize, because their aggregates are immutable.
pub fn zone_session_summaries(st: &EngineState) -> Vec<ZoneSessionSummary> {
    let live_total = Agg::sum(&st.zone_agg.out);
    let live_dur = zone_duration_sec(st);
    let mut out = vec![ZoneSessionSummary {
        id: "zone".to_string(),
        zone: st.zone.clone().unwrap_or_else(|| "Session".to_string()),
        closed_by: None,
        start_ts: st.zone_start_ts,
        end_ts: 0,
        total: live_total,
        dps: live_total as f64 / live_dur,
        live: true,
    }];
    for s in st.zone_history.iter().rev() {
        let total = Agg::sum(&s.agg.out);
        let dur_sec = f64::max(1.0, s.finalized_ms as f64 / 1000.0);
        out.push(ZoneSessionSummary {
            id: s.id.clone(),
            zone: s.zone.clone(),
            closed_by: Some(s.closed_by.as_str()),
            start_ts: s.start_ts,
            end_ts: s.last_ts,
            total,
            dps: total as f64 / dur_sec,
            live: false,
        });
    }
    out
}

/// The finalized fight summaries a snapshot serializes, newest-first and capped. Only the current
/// encounter is recomputed per call; finalized summaries are memoized. The current encounter is
/// always included regardless of the cap, and the zone summary is appended by the caller.
pub fn collect_segments(st: &EngineState, now: i64, max_segments: usize) -> Vec<SegmentSummary> {
    let mut segments = Vec::new();
    if let Some(cur) = &st.current {
        segments.push(enc_summary(cur, "current", now));
    }
    let stop = st.history.len().saturating_sub(max_segments);
    for i in (stop..st.history.len()).rev() {
        let e = &st.history[i];
        segments.push(match &e.summary {
            Some(s) => s.clone(),
            None => enc_summary(e, "fight", now),
        });
    }
    segments
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::combat::aggregate::{DamageEvent, SourceKind, SourceRef};

    fn hit(amount: i64) -> DamageEvent<'static> {
        DamageEvent {
            ts: 0,
            attacker: "You",
            target: "a bat",
            amount,
            dtype: "melee",
            dclass: None,
            skill: "Melee".into(),
            crit: false,
            category: "melee".into(),
            modifiers: &[],
            verb: None,
        }
    }

    fn you() -> SourceRef {
        SourceRef {
            id: "you".into(),
            name: "You".into(),
            kind: SourceKind::You,
        }
    }

    /// The one-second floor is the definition: a one-line fight's DPS is its total, not an infinity.
    #[test]
    fn a_zero_span_fight_reports_its_total_as_its_dps() {
        let mut e = Encounter::new("e1".into(), None, 1_000);
        e.agg.add_out(&you(), &hit(8_574), false);
        e.agg.bump_target("a bat#1", "a bat", 8_574);
        let s = enc_summary(&e, "fight", 0);
        assert_eq!(s.duration_sec, 1.0);
        assert_eq!(s.dps, 8_574.0);
        assert_eq!(s.active_dps, 8_574.0);
        assert_eq!(s.active_sec, 0.0);
    }

    /// An empty encounter is dropped: a mez that landed on a mob somebody else killed leaves no
    /// 0-damage shell in the history.
    #[test]
    fn an_encounter_that_accrued_nothing_is_dropped_at_finalize() {
        let mut st = EngineState::new();
        ensure_encounter(&mut st, 1_000);
        finalize_current(&mut st);
        assert!(st.history.is_empty());
        assert_eq!(st.zone_finalized_ms, 0);
    }

    /// …and one that accrued anything at all is KEPT, with its wall span folded into the stay.
    #[test]
    fn a_fight_that_landed_a_hit_is_frozen_with_its_span() {
        let mut st = EngineState::new();
        ensure_encounter(&mut st, 1_000);
        {
            let enc = st.current.as_mut().expect("open");
            enc.agg.add_out(&you(), &hit(100), false);
            enc.last_ts = 5_000;
            enc.active_ms = 2_000;
        }
        finalize_current(&mut st);
        assert_eq!(st.history.len(), 1);
        assert_eq!(st.zone_finalized_ms, 4_000);
        assert_eq!(st.zone_active_ms, 2_000);
        assert!(st.history[0].summary.is_some());
    }

    /// The fallback is reachable through a hold: one unrefreshed mez may not pin a fight open past
    /// the idle window of total silence.
    #[test]
    fn a_stale_cc_hold_does_not_defeat_the_idle_fallback() {
        let mut st = EngineState::new();
        ensure_encounter(&mut st, 0);
        {
            let enc = st.current.as_mut().expect("open");
            enc.agg.add_out(&you(), &hit(10), false);
            enc.engaged.insert("a bat#1".into());
            enc.cc_active_until.insert("a bat#1".into(), 120_000);
        }
        st.last_activity_ts = 0;
        eval_closure(&mut st, FALLBACK_IDLE_MS);
        assert!(
            st.current.is_none(),
            "the fallback must reach past the hold"
        );
    }

    /// …and an unexpired hold does veto the death-close, which is the judgement it informs.
    #[test]
    fn a_live_cc_hold_vetoes_the_death_close() {
        let mut st = EngineState::new();
        ensure_encounter(&mut st, 0);
        {
            let enc = st.current.as_mut().expect("open");
            enc.agg.add_out(&you(), &hit(10), false);
            enc.engaged.insert("a bat#1".into());
            enc.engaged_seen.insert("a bat#1".into(), 0);
            enc.cc_active_until.insert("a bat#1".into(), 120_000);
        }
        st.last_activity_ts = 30_000;
        // The mob is unseen past PRESENCE_GONE_MS and the linger has elapsed, so only the hold is
        // holding this open.
        eval_closure(&mut st, 30_000);
        assert!(st.current.is_some());
    }

    /// The live zone stay counts the OPEN fight's span, so a stay does not appear to stop while a
    /// fight is running.
    #[test]
    fn the_live_stay_includes_the_open_fights_span() {
        let mut st = EngineState::new();
        st.zone_finalized_ms = 4_000;
        ensure_encounter(&mut st, 10_000);
        st.current.as_mut().expect("open").last_ts = 16_000;
        assert_eq!(zone_duration_sec(&st), 10.0);
    }

    /// The segment cap is a payload bound: the current fight is included regardless of it.
    #[test]
    fn the_cap_never_hides_the_open_fight() {
        let mut st = EngineState::new();
        for _ in 0..3 {
            ensure_encounter(&mut st, 0);
            st.current
                .as_mut()
                .expect("open")
                .agg
                .add_out(&you(), &hit(1), false);
            finalize_current(&mut st);
        }
        ensure_encounter(&mut st, 1_000);
        let segs = collect_segments(&st, 1_000, 1);
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[0].kind, "current");
        assert_eq!(segs[1].id, "e3");
    }
}
