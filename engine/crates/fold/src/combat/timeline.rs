//! The per-fight timeline view (`segmentViews.ts buildTimeline`).
//!
//! Converts the encounter's absolute-ts event ring into ms-since-start, downsamples with a uniform
//! stride when over budget, and derives the Y-axis lanes plus the pinned stance/invocation spans.
//! Read-only over the encounter, so asking for a timeline cannot move a point of damage.
//!
//! Truncation is declared, never silent. The ring holds only the most recent instants of a longer
//! fight, so `raw_count` is the ring occupancy — the population the stride samples — while
//! `total_count` carries the fight's true instant count. The two are never folded together: scaling
//! by `total/kept` would extrapolate the discarded prefix from the retained tail.
//!
//! Markers are never downsampled. They are sparse by construction, and drawing one in five would be
//! worse than drawing none.

use crate::combat::encounter::{encounter_name, TimelineRaw, TIMELINE_BUDGET};
use crate::combat::state::EngineState;
use crate::jsmap::JsMap;
use serde::Serialize;

/// The stable UI ordering of the damage taxonomy.
const CATEGORY_ORDER: [&str; 5] = ["melee", "slay", "spell", "dot", "ds"];

fn category_rank(c: &str) -> usize {
    CATEGORY_ORDER
        .iter()
        .position(|&x| x == c)
        .unwrap_or(usize::MAX)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineEvent {
    t: i64,
    lane: String,
    category: String,
    amount: i64,
    crit: bool,
    /// Absent when the line carried none, so a plain landed hit keeps its exact prior shape.
    #[serde(skip_serializing_if = "Option::is_none")]
    modifiers: Option<Vec<String>>,
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    outcome: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    target: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineLane {
    lane: String,
    category: String,
    total: i64,
    kind: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StanceSpanView {
    group: &'static str,
    name: String,
    start: i64,
    end: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineMarker {
    t: i64,
    kind: &'static str,
    label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineView {
    id: String,
    name: String,
    start_ts: i64,
    duration_ms: i64,
    lanes: Vec<TimelineLane>,
    events: Vec<TimelineEvent>,
    stance_spans: Vec<StanceSpanView>,
    markers: Vec<TimelineMarker>,
    downsampled: bool,
    raw_count: i64,
    total_count: i64,
    truncated: bool,
}

/// One ring record → one serialized timeline instant (absolute ts → ms-since-start).
fn timeline_event(r: &TimelineRaw, start: i64) -> TimelineEvent {
    TimelineEvent {
        t: (r.ts - start).max(0),
        lane: r.lane.clone(),
        category: r.category.clone(),
        amount: r.amount,
        crit: r.crit,
        modifiers: (!r.modifiers.is_empty()).then(|| r.modifiers.clone()),
        kind: r.kind,
        // A plain `hit` outcome is never serialized. The ring does not write one today; the filter
        // is the shape's rule, not an observation about the corpus.
        outcome: r.outcome.filter(|&o| o != "hit"),
        detail: r.detail.clone().filter(|d| !d.is_empty()),
        target: r.target.clone().filter(|t| !t.is_empty()),
    }
}

/// Walk the ring once, aggregating every event into its lane while emitting only the stride-sampled
/// ones — so lane totals and ordering stay accurate under downsampling.
fn collect_timeline(
    raw: &[TimelineRaw],
    start: i64,
    stride: usize,
) -> (Vec<TimelineEvent>, Vec<TimelineLane>) {
    let mut events = Vec::new();
    let mut lane_agg: JsMap<TimelineLane> = JsMap::new();
    for (i, r) in raw.iter().enumerate() {
        if !lane_agg.contains_key(&r.lane) {
            lane_agg.insert(
                r.lane.clone(),
                TimelineLane {
                    lane: r.lane.clone(),
                    category: r.category.clone(),
                    total: 0,
                    kind: r.kind,
                },
            );
        }
        lane_agg.get_mut(&r.lane).expect("just inserted").total += r.amount;
        if i % stride != 0 {
            continue;
        }
        events.push(timeline_event(r, start));
    }
    let mut lanes: Vec<TimelineLane> = lane_agg.into_values();
    lanes.sort_by(|a, b| {
        category_rank(&a.category)
            .cmp(&category_rank(&b.category))
            .then(b.total.cmp(&a.total))
    });
    (events, lanes)
}

/// Build the selected encounter's timeline view. `None` for the zone selection, for an id that
/// resolves to nothing, and for an encounter whose event ring the history cap evicted — there the
/// answer is "no timeline available", never an empty one reading as "this fight had no instants".
pub fn build_timeline(st: &EngineState, id: &str, now: i64) -> Option<TimelineView> {
    if id == "zone" {
        return None;
    }
    let is_current = st.current.as_ref().is_some_and(|c| c.id == id);
    let e = match &st.current {
        Some(cur) if cur.id == id => Some(cur),
        _ => st.history.iter().find(|h| h.id == id),
    }?;
    if e.events.is_empty() && !is_current {
        return None;
    }
    let start = e.start_ts;
    let end_ts = if is_current {
        e.last_ts.max(now)
    } else {
        e.last_ts
    };
    let duration_ms = (end_ts - start).max(1);
    let raw_count = e.events.len();
    let total_count = (raw_count as i64).max(e.events_total);
    let truncated = total_count > raw_count as i64;
    // Uniform stride keeps the temporal shape while capping the payload on a dense fight.
    let stride = if raw_count > TIMELINE_BUDGET {
        raw_count.div_ceil(TIMELINE_BUDGET)
    } else {
        1
    };
    let (events, lanes) = collect_timeline(&e.events, start, stride);
    Some(TimelineView {
        id: e.id.clone(),
        name: encounter_name(e, is_current),
        start_ts: start,
        duration_ms,
        lanes,
        events,
        stance_spans: e
            .stance_spans
            .iter()
            .map(|s| StanceSpanView {
                group: s.group,
                name: s.name.clone(),
                start: (s.start - start).max(0),
                end: (s.end.unwrap_or(end_ts) - start).max(0),
            })
            .collect(),
        markers: e
            .markers
            .iter()
            .map(|m| TimelineMarker {
                t: (m.ts - start).max(0),
                kind: m.kind,
                label: m.label.clone(),
                detail: m.detail.clone().filter(|d| !d.is_empty()),
            })
            .collect(),
        downsampled: stride > 1,
        raw_count: raw_count as i64,
        total_count,
        truncated,
    })
}
