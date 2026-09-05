//! The perf answers' folds: this engine's own measurements onto the wire's generated shapes.
//!
//! No state, no lock, no clock. `world.rs` reads its state once and does this arithmetic outside the
//! critical section, so a diagnostic is never formatted while a connection waits.
//!
//! Two enums generated from two schema definitions are mapped by an exhaustive `match` rather than
//! by their string spellings: a member added on one side and not the other must stop the build
//! rather than be quietly mapped to the wrong thing.

use std::collections::BTreeMap;

use protocol::generated::{
    HealthResultStatus, PerfMoment, PerfServeSource, PerfSnapshotResultStatus,
};

use crate::views;

/// The health status onto the perf answer's own five members.
pub fn perf_status(status: HealthResultStatus) -> PerfSnapshotResultStatus {
    match status {
        HealthResultStatus::Starting => PerfSnapshotResultStatus::Starting,
        HealthResultStatus::Attaching => PerfSnapshotResultStatus::Attaching,
        HealthResultStatus::Folding => PerfSnapshotResultStatus::Folding,
        HealthResultStatus::Live => PerfSnapshotResultStatus::Live,
        HealthResultStatus::Idle => PerfSnapshotResultStatus::Idle,
    }
}

/// A counter onto the wire's `integer`. Saturating rather than wrapping: a byte count this app can
/// produce does not reach 2^63, and an `as` cast that could silently report a negative one has no
/// place in an instrument.
pub fn clamp_i64(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

/// One ring entry on the wire — five field assignments and no arithmetic. The ring did the
/// subtraction that makes each figure an interval, where the counters live; this is the mapping
/// onto the generated type, which is the one thing `views/` may not know about.
pub fn moment_row(moment: &views::Moment) -> PerfMoment {
    PerfMoment {
        at_ms: clamp_i64(moment.at_ms),
        span_ms: clamp_i64(moment.span_ms),
        frames: clamp_i64(moment.frames),
        payload_weight: clamp_i64(moment.bytes),
        fold_to_frame_us_max: moment.worst_us.map(clamp_i64),
    }
}

/// The union of what has served and what is being watched, ordered by source name.
///
/// Two different reasons put a source in the list. It has served frames — a cost, which belongs
/// whether or not anybody is still subscribed, because the generation's bill does not disappear
/// when a window closes. Or somebody is subscribed to it right now and it has served nothing yet,
/// which is a subscription waiting for its first frame: omitting it would make "opened and nothing
/// came" indistinguishable from "never opened".
///
/// A source in neither set is absent — no rows of zeros for a source this session has never had
/// anything to do with.
pub fn serve_rows(
    served: &[views::SourceMeter],
    watched: &BTreeMap<&'static str, i64>,
) -> Vec<PerfServeSource> {
    let mut rows: BTreeMap<&'static str, PerfServeSource> = BTreeMap::new();
    for source in served {
        rows.insert(
            source.source,
            PerfServeSource {
                source: source.source.to_owned(),
                frames: clamp_i64(source.frames),
                resets: clamp_i64(source.resets),
                diffs: clamp_i64(source.diffs),
                rows: clamp_i64(source.rows),
                payload_weight: clamp_i64(source.bytes),
                widest_payload_weight: clamp_i64(source.widest as u64),
                fold_to_frame_us_mean: source.latency_mean_us.map(clamp_i64),
                fold_to_frame_us_max: source.latency_max_us.map(clamp_i64),
                // Filled below, from the world's own count — a source that has served frames and
                // has since been unsubscribed honestly has zero.
                subscribers: 0,
            },
        );
    }
    for (source, count) in watched {
        rows.entry(source)
            .or_insert_with(|| empty_serve_row(source))
            .subscribers = *count;
    }
    rows.into_values().collect()
}

/// A source somebody is subscribed to that has served nothing yet. Every counter is a real zero —
/// no frame has been sent — and the two latencies are absent, because nothing was timed.
fn empty_serve_row(source: &str) -> PerfServeSource {
    PerfServeSource {
        source: source.to_owned(),
        frames: 0,
        resets: 0,
        diffs: 0,
        rows: 0,
        payload_weight: 0,
        widest_payload_weight: 0,
        fold_to_frame_us_mean: None,
        fold_to_frame_us_max: None,
        subscribers: 0,
    }
}
