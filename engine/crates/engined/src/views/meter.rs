//! The engine measures its own serve path. Two things are counted:
//!
//! * Fold-to-frame latency, per source — from the instant the ingest folded the event that moved
//!   the source to the instant the frame describing it reached the connection's outbox. A frame
//!   with no fold behind it (the fresh reset a just-opened subscription is owed) carries no
//!   latency; a number invented there would be the age of the session.
//! * Diff size, per subscription — ops per frame and bytes on the wire, from the frame's own
//!   serialization. That costs one extra `serde_json::to_string` per frame actually sent, over a
//!   payload bounded by `views::MAX_LIMIT` rows, at most ten times a second.
//!
//! The numbers leave by three readers with deliberately different verbs: [`Meter::take_report`]
//! drains its cadence flag so a stderr line is not printed twice, [`Meter::take_window`] drains only
//! the windowed extreme, and [`Meter::peek`] touches nothing. A reader that reset the counters would
//! make the numbers depend on who asked last — two panels open at once would each see half a
//! session — and would rob the stderr line of the interval it was about to print.

use std::collections::{BTreeMap, VecDeque};
use std::time::{Duration, Instant};

/// The floor between two summary lines. Long enough that a live session's stderr stays readable,
/// short enough that a run worth watching says something while you are watching it.
pub const REPORT_EVERY: Duration = Duration::from_secs(10);

/// The nominal interval between two [`Timeline`] samples.
///
/// Equal to [`REPORT_EVERY`] so a stderr line and a timeline moment describe the same window, but a
/// separate constant: they answer to two different readers and either could change alone.
pub const TIMELINE_CADENCE: Duration = Duration::from_secs(10);

/// How many moments the ring holds before it overwrites — its horizon.
///
/// Thirty samples at [`TIMELINE_CADENCE`] is five minutes, the window a person can remember doing
/// something in. The bound is the design: an engine up for a week must cost what one up for a minute
/// costs, so history that ages out is dropped rather than summarised into a subtler accumulator.
pub const TIMELINE_CAPACITY: usize = 30;

/// Which kind of frame was served.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameKind {
    /// A full window — a subscription's first, or the one a landed fold owes it.
    Reset,
    /// A coalesced batch of ops.
    Diff,
}

/// What one source's serve path has cost so far, in this generation.
#[derive(Debug, Default, Clone, Copy)]
struct SourceStats {
    resets: u64,
    diffs: u64,
    rows: u64,
    ops: u64,
    bytes: u64,
    widest: usize,
    /// Frames that had a fold instant behind them, and what they took.
    timed: u64,
    latency_total: Duration,
    latency_worst: Duration,
    /// The worst timed frame since the last timeline sample, drained by [`Meter::take_window`].
    ///
    /// The one field the ring cannot derive: frames and bytes are cumulative, so a window's figure
    /// is one subtraction, but a maximum is not invertible — a cumulative worst says nothing about
    /// which window set it. `Option` rather than zero: a window whose every frame was an owed reset
    /// has no latency, and a `0` would claim the serve path was instantaneous.
    win_worst: Option<Duration>,
}

/// One source's counters, read rather than drained — what [`Meter::peek`] answers with.
///
/// Not the generated type, on purpose: `views/` knows nothing about the protocol, so the meter
/// counts and the op table serializes. The mapping lives in `world.rs`.
///
/// The two latencies are `Option`s because a frame with no fold instant behind it is counted but not
/// timed; a zero would claim the serve path is instantaneous.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SourceMeter {
    /// The source's name, as the registry spells it.
    pub source: &'static str,
    /// `resets + diffs` — frames actually sent.
    pub frames: u64,
    pub resets: u64,
    pub diffs: u64,
    /// Rows carried by the resets.
    pub rows: u64,
    /// Ops carried by the diffs.
    pub ops: u64,
    /// Payload bytes sent, from the frames' own serialization.
    pub bytes: u64,
    /// The largest single frame.
    pub widest: usize,
    /// How many frames had a fold instant behind them — the denominator of `latency_mean_us`.
    pub timed: u64,
    /// Mean fold-to-frame latency in microseconds, or `None` when nothing was timed.
    pub latency_mean_us: Option<u64>,
    /// Worst fold-to-frame latency in microseconds, or `None` when nothing was timed.
    pub latency_max_us: Option<u64>,
}

/// The engine's own serve-path counters. One per attach — a new fold is a new world, and a
/// measurement of the last one is not a measurement of this one.
pub struct Meter {
    sources: BTreeMap<&'static str, SourceStats>,
    /// When the last summary line was printed, or `None` when none has been.
    said: Option<Instant>,
    /// Whether anything has been counted since that line.
    fresh: bool,
}

impl Default for Meter {
    fn default() -> Self {
        Self::new()
    }
}

impl Meter {
    /// A fresh set of counters.
    #[must_use]
    pub fn new() -> Self {
        Self {
            sources: BTreeMap::new(),
            said: None,
            fresh: false,
        }
    }

    /// Count one frame that was actually sent.
    ///
    /// `since` is the instant the fold produced what this frame reports, or `None` when the frame
    /// is not reporting a fold at all.
    pub fn frame(
        &mut self,
        source: &'static str,
        kind: FrameKind,
        rows: usize,
        ops: usize,
        bytes: usize,
        since: Option<Instant>,
    ) {
        let stats = self.sources.entry(source).or_default();
        match kind {
            FrameKind::Reset => stats.resets += 1,
            FrameKind::Diff => stats.diffs += 1,
        }
        stats.rows += rows as u64;
        stats.ops += ops as u64;
        stats.bytes += bytes as u64;
        stats.widest = stats.widest.max(bytes);
        if let Some(folded_at) = since {
            let took = folded_at.elapsed();
            stats.timed += 1;
            stats.latency_total += took;
            stats.latency_worst = stats.latency_worst.max(took);
            stats.win_worst = Some(stats.win_worst.map_or(took, |worst| worst.max(took)));
        }
        self.fresh = true;
    }

    /// The ring's reading: cumulative totals, and the windowed extreme drained.
    ///
    /// `frames` and `bytes` stay cumulative because [`Timeline`] subtracts its own previous reading,
    /// so the serve path pays nothing for them; `worst_us` is drained because a maximum cannot be
    /// recovered by subtraction. One caller only, on the thread that owns the meter — a second
    /// reader would silently take the first one's window.
    ///
    /// It does not touch the cadence flag, so a timeline sample can never steal the interval a
    /// summary line was about to print.
    pub fn take_window(&mut self) -> MeterWindow {
        let mut window = MeterWindow::default();
        for stats in self.sources.values_mut() {
            window.frames += stats.resets + stats.diffs;
            window.bytes += stats.bytes;
            if let Some(worst) = stats.win_worst.take() {
                let worst = micros(worst);
                window.worst_us = Some(window.worst_us.map_or(worst, |seen| seen.max(worst)));
            }
        }
        window
    }

    /// The summary lines owed right now, or nothing.
    ///
    /// `force` prints whatever there is regardless of the cadence — what a landing fold does, so
    /// the first frames of a generation are always reported.
    pub fn take_report(&mut self, force: bool) -> Vec<String> {
        if !self.fresh {
            return Vec::new();
        }
        let due = force || self.said.is_none_or(|last| last.elapsed() >= REPORT_EVERY);
        if !due {
            return Vec::new();
        }
        self.said = Some(Instant::now());
        self.fresh = false;
        self.sources
            .iter()
            .map(|(source, stats)| line(source, stats))
            .collect()
    }

    /// Every source's counters, and nothing is reset — the `perf.snapshot` reader.
    ///
    /// `&self` is the type stating the property: it cannot drain the cadence flag, zero a total, or
    /// change what the next stderr line says. Ordered by source name so a redrawing panel's rows
    /// hold still.
    ///
    /// A source that has never served a frame is absent rather than a row of zeros.
    #[must_use]
    pub fn peek(&self) -> Vec<SourceMeter> {
        self.sources
            .iter()
            .map(|(source, stats)| SourceMeter {
                source,
                frames: stats.resets + stats.diffs,
                resets: stats.resets,
                diffs: stats.diffs,
                rows: stats.rows,
                ops: stats.ops,
                bytes: stats.bytes,
                widest: stats.widest,
                timed: stats.timed,
                latency_mean_us: mean_us(stats),
                latency_max_us: (stats.timed > 0).then(|| micros(stats.latency_worst)),
            })
            .collect()
    }
}

/// What [`Meter::take_window`] hands the ring: two cumulative counters and one drained extreme. The
/// mixed posture is the point — read the field docs.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MeterWindow {
    /// Frames sent across every source since this generation began — cumulative.
    pub frames: u64,
    /// Payload bytes sent across every source since this generation began — cumulative.
    pub bytes: u64,
    /// The worst fold-to-frame latency in microseconds since the last call — drained, and `None`
    /// when no frame in that span had a fold behind it.
    pub worst_us: Option<u64>,
}

/// One sampled window of the serve path — the ring's element.
///
/// Every figure is an interval, never a running total: `perf.snapshot` answers the cumulative
/// question better, and a history exists to say that this ten seconds cost four times what the last
/// ten did.
///
/// Not the generated type, for the reason [`SourceMeter`] is not.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Moment {
    /// Process uptime in milliseconds when this window closed.
    pub at_ms: u64,
    /// How long the window actually covered — measured, never assumed to be the cadence.
    pub span_ms: u64,
    /// Frames sent during the window, across every source.
    pub frames: u64,
    /// What those frames weighed, across every source.
    pub bytes: u64,
    /// The worst timed frame in the window, or `None` when none of them had a fold behind it.
    pub worst_us: Option<u64>,
}

/// The bounded history behind `perf.timeline` — a fixed-capacity ring, oldest first.
///
/// The bound is the feature: [`TIMELINE_CAPACITY`] moments, and the oldest is dropped rather than
/// folded into a summary, so an engine up for a week costs what one up for a minute costs.
///
/// It reads a clock it is given, never one it takes. Every method takes process uptime in
/// milliseconds from its caller: the engine does not read a wall clock to answer a performance
/// question, and a process-relative stamp says nothing about when or where a person plays.
///
/// A quiet window is recorded as a quiet window. Skipping empty samples would compress a lull into
/// no space and make the busy moments either side of it look adjacent.
#[derive(Debug, Default)]
pub struct Timeline {
    moments: VecDeque<Moment>,
    /// Uptime at the close of the last sample, or `None` until the first tick opens the first
    /// window. The first tick establishes a baseline and pushes nothing — a first moment measured
    /// from process start would report the boot as a serve window.
    since_ms: Option<u64>,
    /// The cumulative counters as of the last sample, so a window is one subtraction.
    frames: u64,
    bytes: u64,
}

impl Timeline {
    /// An empty ring.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Offer the ring a tick. It samples only when a whole [`TIMELINE_CADENCE`] has passed.
    ///
    /// Called on the serve beat, far more often than it samples; the cadence check lives here rather
    /// than at the call site so the ring's horizon cannot be changed from the ingest loop.
    ///
    /// `at_ms` must be monotonic (it is process uptime). A backwards tick is treated as a
    /// zero-length window rather than trusted, because an instrument that can print a negative
    /// duration is one nobody believes afterwards.
    pub fn tick(&mut self, at_ms: u64, meter: &mut Meter) {
        let Some(since) = self.since_ms else {
            // The first tick opens the window and takes the baseline. `take_window` is called for
            // its drain: anything timed before the ring existed belongs to no window.
            let opening = meter.take_window();
            self.since_ms = Some(at_ms);
            self.frames = opening.frames;
            self.bytes = opening.bytes;
            return;
        };
        let span_ms = at_ms.saturating_sub(since);
        if span_ms < millis(TIMELINE_CADENCE) {
            return;
        }
        let window = meter.take_window();
        self.push(Moment {
            at_ms,
            span_ms,
            frames: window.frames.saturating_sub(self.frames),
            bytes: window.bytes.saturating_sub(self.bytes),
            worst_us: window.worst_us,
        });
        self.since_ms = Some(at_ms);
        self.frames = window.frames;
        self.bytes = window.bytes;
    }

    /// Add one moment, dropping the oldest when the ring is full.
    fn push(&mut self, moment: Moment) {
        if self.moments.len() == TIMELINE_CAPACITY {
            self.moments.pop_front();
        }
        self.moments.push_back(moment);
    }

    /// The ring as it stands, oldest first, and nothing is reset — `perf.timeline`'s reader.
    ///
    /// `&self` states the property, as [`Meter::peek`] does: two panels open at once must see the
    /// same history.
    #[must_use]
    pub fn peek(&self) -> Vec<Moment> {
        self.moments.iter().copied().collect()
    }
}

/// A duration as whole milliseconds, saturating rather than wrapping.
fn millis(d: Duration) -> u64 {
    u64::try_from(d.as_millis()).unwrap_or(u64::MAX)
}

/// The mean of the timed frames, in microseconds, or `None` when none were timed.
///
/// Divides the total duration rather than a sum of rounded microseconds: rounding once, at the end,
/// is the only order that keeps a sub-microsecond serve path from accumulating into a lie.
fn mean_us(stats: &SourceStats) -> Option<u64> {
    if stats.timed == 0 {
        return None;
    }
    let divisor = u32::try_from(stats.timed).unwrap_or(u32::MAX);
    Some(micros(stats.latency_total / divisor))
}

/// A duration as whole microseconds, saturating rather than wrapping: an `as` cast that could
/// silently report an absurd figure has no place in an instrument.
fn micros(d: Duration) -> u64 {
    u64::try_from(d.as_micros()).unwrap_or(u64::MAX)
}

/// One source's line. Cumulative for the generation, so two lines read as a progression rather
/// than as two disconnected samples.
fn line(source: &str, stats: &SourceStats) -> String {
    let frames = stats.resets + stats.diffs;
    let mean = if stats.timed == 0 {
        String::from("n/a")
    } else {
        took(stats.latency_total / u32::try_from(stats.timed).unwrap_or(u32::MAX))
    };
    format!(
        "views: {source} {frames} frames ({} reset / {} diff), {} rows, {} ops, {} B (widest {} B); \
         fold->frame mean {mean} max {} over {}",
        stats.resets,
        stats.diffs,
        stats.rows,
        stats.ops,
        stats.bytes,
        stats.widest,
        took(stats.latency_worst),
        stats.timed,
    )
}

/// A duration a person reads, at a precision that does not throw the measurement away.
///
/// Microseconds under a millisecond: cutting a fifty-row window takes tens of microseconds, and
/// `0.0 ms` reads as a measurement nobody took rather than as the good news it is.
fn took(d: Duration) -> String {
    let ms = d.as_secs_f64() * 1000.0;
    if ms < 1.0 {
        format!("{} us", d.as_micros())
    } else {
        format!("{ms:.1} ms")
    }
}

#[cfg(test)]
mod tests {
    use super::{FrameKind, Meter, Timeline, REPORT_EVERY, TIMELINE_CAPACITY};
    use std::time::Instant;

    /// Ten seconds — [`super::TIMELINE_CADENCE`] in the unit the ring's clock is in.
    const CADENCE_MS: u64 = 10_000;

    /// Serve one frame of `bytes`, timed or not. The ring's tests care about counts, not sources.
    fn served(meter: &mut Meter, bytes: usize, timed: bool) {
        meter.frame(
            "loot.ledger",
            FrameKind::Diff,
            0,
            1,
            bytes,
            timed.then(Instant::now),
        );
    }

    #[test]
    fn the_first_tick_opens_a_window_rather_than_reporting_the_boot_as_one() {
        // A first moment measured from process start would report launch time as a serve window.
        let mut meter = Meter::new();
        let mut ring = Timeline::new();
        served(&mut meter, 400, true);
        ring.tick(30_000, &mut meter);
        assert!(ring.peek().is_empty(), "the baseline is not a moment");
        ring.tick(30_000 + CADENCE_MS, &mut meter);
        let [moment] = ring.peek().try_into().expect("one moment");
        assert_eq!(moment.at_ms, 40_000);
        assert_eq!(moment.span_ms, CADENCE_MS);
        assert_eq!(moment.frames, 0, "the frame belonged to the baseline");
        assert_eq!(moment.worst_us, None, "and so did its timing");
    }

    #[test]
    fn a_moment_reports_the_interval_and_not_a_running_total() {
        // Two busy windows in a row must read as two equal windows, not as one and then two.
        let mut meter = Meter::new();
        let mut ring = Timeline::new();
        ring.tick(0, &mut meter);
        served(&mut meter, 100, false);
        served(&mut meter, 100, false);
        ring.tick(CADENCE_MS, &mut meter);
        served(&mut meter, 100, false);
        served(&mut meter, 100, false);
        ring.tick(CADENCE_MS * 2, &mut meter);
        let moments = ring.peek();
        assert_eq!(moments.len(), 2);
        assert_eq!((moments[0].frames, moments[0].bytes), (2, 200));
        assert_eq!(
            (moments[1].frames, moments[1].bytes),
            (2, 200),
            "the second window is 2 frames, not the cumulative 4"
        );
        // …and the cumulative view is untouched: the ring reads the meter, it does not spend it.
        assert_eq!(meter.peek()[0].frames, 4);
    }

    #[test]
    fn a_quiet_window_is_recorded_as_a_quiet_window() {
        let mut meter = Meter::new();
        let mut ring = Timeline::new();
        ring.tick(0, &mut meter);
        ring.tick(CADENCE_MS, &mut meter);
        ring.tick(CADENCE_MS * 2, &mut meter);
        let moments = ring.peek();
        assert_eq!(moments.len(), 2, "silence is two moments, not none");
        assert!(moments.iter().all(|m| m.frames == 0 && m.bytes == 0));
    }

    #[test]
    fn the_windowed_worst_is_this_windows_worst_and_not_the_generations() {
        // A busy window followed by an untimed one must not inherit the first one's peak.
        let mut meter = Meter::new();
        let mut ring = Timeline::new();
        ring.tick(0, &mut meter);
        served(&mut meter, 100, true);
        ring.tick(CADENCE_MS, &mut meter);
        served(&mut meter, 100, false);
        ring.tick(CADENCE_MS * 2, &mut meter);
        let moments = ring.peek();
        assert!(moments[0].worst_us.is_some(), "a timed frame was served");
        assert_eq!(
            moments[1].worst_us, None,
            "an untimed window reports absent, never the last window's peak and never zero"
        );
        // …while the generation's cumulative worst is still there for `perf.snapshot` to serve.
        assert!(meter.peek()[0].latency_max_us.is_some());
    }

    #[test]
    fn the_cadence_holds_a_tick_back_and_the_span_is_measured_rather_than_assumed() {
        let mut meter = Meter::new();
        let mut ring = Timeline::new();
        ring.tick(0, &mut meter);
        ring.tick(CADENCE_MS - 1, &mut meter);
        assert!(ring.peek().is_empty(), "one millisecond short is not due");
        // A busy thread takes its sample late, and the moment says so rather than claiming the
        // nominal cadence, which would turn a stall into a shorter-looking window.
        ring.tick(CADENCE_MS * 3, &mut meter);
        let [moment] = ring.peek().try_into().expect("one moment");
        assert_eq!(moment.span_ms, CADENCE_MS * 3);
    }

    #[test]
    fn the_ring_is_bounded_and_drops_the_oldest() {
        // An engine up for a week costs what one up for a minute costs.
        let mut meter = Meter::new();
        let mut ring = Timeline::new();
        ring.tick(0, &mut meter);
        for beat in 1..=(TIMELINE_CAPACITY as u64 + 20) {
            served(&mut meter, 10, false);
            ring.tick(beat * CADENCE_MS, &mut meter);
        }
        let moments = ring.peek();
        assert_eq!(moments.len(), TIMELINE_CAPACITY, "the horizon is fixed");
        assert_eq!(
            moments[0].at_ms,
            21 * CADENCE_MS,
            "oldest first, and the first twenty aged out"
        );
        assert!(
            moments.windows(2).all(|w| w[0].at_ms < w[1].at_ms),
            "oldest first is an ordering the server owes, not one a caller sorts for"
        );
    }

    #[test]
    fn peeking_the_ring_resets_nothing() {
        let mut meter = Meter::new();
        let mut ring = Timeline::new();
        ring.tick(0, &mut meter);
        served(&mut meter, 100, true);
        ring.tick(CADENCE_MS, &mut meter);
        assert_eq!(ring.peek(), ring.peek(), "two panels see the same history");
    }

    #[test]
    fn a_clock_that_went_backwards_is_a_zero_window_rather_than_a_negative_one() {
        // Uptime is monotonic, so this cannot happen; it is pinned rather than assumed because an
        // instrument that could print a negative duration is one nobody believes afterwards.
        let mut meter = Meter::new();
        let mut ring = Timeline::new();
        ring.tick(CADENCE_MS * 5, &mut meter);
        ring.tick(0, &mut meter);
        assert!(ring.peek().is_empty(), "a backwards tick samples nothing");
    }

    #[test]
    fn draining_the_window_leaves_the_stderr_line_and_the_cumulative_counters_alone() {
        // The drains are independent: a timeline sample must not steal the interval a summary was
        // owed.
        let mut meter = Meter::new();
        served(&mut meter, 100, true);
        let window = meter.take_window();
        assert_eq!(window.frames, 1);
        assert!(window.worst_us.is_some());
        assert!(
            meter.take_window().worst_us.is_none(),
            "the extreme is drained"
        );
        assert_eq!(meter.take_window().frames, 1, "the counters are not");
        assert_eq!(
            meter.take_report(true).len(),
            1,
            "and the line is still owed"
        );
    }

    #[test]
    fn a_meter_that_counted_nothing_says_nothing() {
        let mut meter = Meter::new();
        assert!(meter.take_report(true).is_empty());
    }

    #[test]
    fn the_line_carries_both_measurements_the_ruling_names() {
        let mut meter = Meter::new();
        meter.frame(
            "loot.ledger",
            FrameKind::Reset,
            50,
            0,
            4096,
            Some(Instant::now()),
        );
        meter.frame(
            "loot.ledger",
            FrameKind::Diff,
            0,
            2,
            310,
            Some(Instant::now()),
        );
        let [line] = meter.take_report(true).try_into().expect("one source");
        assert!(line.contains("loot.ledger"), "{line}");
        assert!(line.contains("2 frames (1 reset / 1 diff)"), "{line}");
        assert!(line.contains("2 ops"), "{line}");
        assert!(line.contains("widest 4096 B"), "{line}");
        assert!(line.contains("fold->frame"), "{line}");
    }

    #[test]
    fn a_frame_with_no_fold_behind_it_is_counted_but_not_timed() {
        // The fresh reset a just-opened subscription is owed on an idle session: timing it against
        // the last event would report the age of the session as a serve latency.
        let mut meter = Meter::new();
        meter.frame("loot.ledger", FrameKind::Reset, 3, 0, 200, None);
        let [line] = meter.take_report(true).try_into().expect("one source");
        assert!(line.contains("mean n/a"), "{line}");
        assert!(line.contains("over 0"), "{line}");
    }

    #[test]
    fn the_cadence_holds_the_second_line_back_and_a_forced_one_gets_through() {
        let mut meter = Meter::new();
        meter.frame("loot.ledger", FrameKind::Diff, 0, 1, 100, None);
        assert_eq!(meter.take_report(false).len(), 1, "the first line is due");
        meter.frame("loot.ledger", FrameKind::Diff, 0, 1, 100, None);
        assert!(
            meter.take_report(false).is_empty(),
            "the cadence is {REPORT_EVERY:?} and no time has passed"
        );
        assert_eq!(
            meter.take_report(true).len(),
            1,
            "a forced line gets through"
        );
        // …and a forced line with nothing new behind it still says nothing.
        assert!(meter.take_report(true).is_empty());
    }

    #[test]
    fn a_meter_that_counted_nothing_peeks_at_nothing() {
        // Not a row of zeros: a source nobody subscribed to has no serve path to report.
        assert!(Meter::new().peek().is_empty());
    }

    #[test]
    fn peek_carries_both_measurements_the_ruling_names() {
        let mut meter = Meter::new();
        meter.frame(
            "loot.ledger",
            FrameKind::Reset,
            50,
            0,
            4096,
            Some(Instant::now()),
        );
        meter.frame(
            "loot.ledger",
            FrameKind::Diff,
            0,
            2,
            310,
            Some(Instant::now()),
        );
        let [row] = meter.peek().try_into().expect("one source");
        assert_eq!(row.source, "loot.ledger");
        assert_eq!(row.frames, 2);
        assert_eq!(row.resets, 1);
        assert_eq!(row.diffs, 1);
        assert_eq!(row.rows, 50);
        assert_eq!(row.ops, 2);
        assert_eq!(row.bytes, 4406);
        assert_eq!(row.widest, 4096);
        assert_eq!(row.timed, 2);
        assert!(row.latency_mean_us.is_some());
        assert!(row.latency_max_us.is_some());
        assert!(row.latency_max_us >= row.latency_mean_us);
    }

    #[test]
    fn a_source_whose_frames_had_no_fold_behind_them_reports_no_latency_rather_than_zero() {
        // The wire half of `a_frame_with_no_fold_behind_it_is_counted_but_not_timed`: the op must
        // say absent, never 0.
        let mut meter = Meter::new();
        meter.frame("loot.ledger", FrameKind::Reset, 3, 0, 200, None);
        let [row] = meter.peek().try_into().expect("one source");
        assert_eq!(row.frames, 1);
        assert_eq!(row.timed, 0);
        assert_eq!(row.latency_mean_us, None);
        assert_eq!(row.latency_max_us, None);
    }

    #[test]
    fn peeking_resets_nothing_and_steals_no_line() {
        // A polling panel must not zero the counters under the stderr report, nor make the next
        // poll's numbers depend on how recently the last one happened.
        let mut meter = Meter::new();
        meter.frame("loot.ledger", FrameKind::Diff, 0, 1, 100, None);
        let first = meter.peek();
        let again = meter.peek();
        assert_eq!(first, again, "two peeks in a row see the same session");
        assert_eq!(first[0].frames, 1);
        // …and the line the meter owed is still owed.
        assert_eq!(meter.take_report(true).len(), 1);
        // …and the peek after a drained report still carries the whole generation, because only the
        // cadence flag was drained.
        assert_eq!(meter.peek()[0].frames, 1);
    }

    #[test]
    fn peek_orders_sources_by_name_so_a_redrawing_panel_holds_still() {
        let mut meter = Meter::new();
        meter.frame("zone.roster", FrameKind::Diff, 0, 1, 10, None);
        meter.frame("loot.ledger", FrameKind::Diff, 0, 1, 10, None);
        let names: Vec<&str> = meter.peek().iter().map(|r| r.source).collect();
        assert_eq!(names, ["loot.ledger", "zone.roster"]);
    }
}
