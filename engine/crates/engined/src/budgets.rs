//! The engine's own performance budgets, judged against the generation that is actually running, so
//! the in-app panel and a bug report state what THIS machine did. `tests/budget.rs` asserts the same
//! ceilings in CI against a synthetic corpus.
//!
//! The op carries the definitions and not just the numbers: these goals are self-measured and never
//! promised, so a reader is owed the ceiling beside the measurement and the caveat beside both.
//!
//! The rows are rendered here rather than in the panel because views arrive render-ready. The two
//! budgets are in different units and each caveat is prose, so serving raw numbers would push all of
//! that into the renderer and make a third budget a renderer change.
//!
//! Everything below is a free function over plain integers, so this module depends on nothing else
//! in this crate and its unit tests are the whole contract.

use protocol::generated::{PerfBudget, PerfBudgetId, PerfBudgetVerdict};

/// The fold-rate floor, in bytes per second — the number `tests/budget.rs` asserts.
///
/// Measured before it was chosen: 8.0 MB folded in 1030 ms (7.8 MB/s, 110,319 events) on an
/// i9-13900KF release build at below-normal priority. The floor is an eighth of that, because a
/// shared CI runner is several times slower and a debug build about an order of magnitude — the
/// regression this floor most wants to catch.
pub const MIN_FOLD_BYTES_PER_SEC: u64 = 1_000_000;

/// The serve-latency ceiling, in microseconds — the number `tests/budget.rs` asserts.
///
/// Read the unit before the number: `foldToFrameUs` is not compute but the whole engine-side path
/// from the fold that produced a change to the frame reaching the outbox, so the ~10 Hz coalescing
/// beat and the tail's poll interval are inside it. The measurement behind it is 56 ms for a one-row
/// diff, a beat rather than work, which makes this a wedge detector rather than a budget.
pub const MAX_SERVE_LATENCY_US: u64 = 2_000_000;

/// The fold-rate row's caveat, and the place the unmet fold-time goal is said out loud.
///
/// A pass here means this build is not broken, which is a much smaller claim than the program's
/// goal, and the row has to say which claim it is making.
const FOLD_NOTE: &str = "The floor is an eighth of the 7.8 MB/s this engine measured on the \
    author's machine, so that a debug build or a wedged scan is what trips it rather than a busy \
    afternoon. It is not the program's goal: folding the owner's 209 MB log in 20 s is the G3 \
    goal and it is NOT met at this release (52.5 s, 3.8 MB/s measured). A pass here says this \
    build is not broken, never that the goal is reached.";

/// The serve-latency row's caveat, carried with the number rather than left in a plan document.
const SERVE_NOTE: &str = "Measured fold-to-outbox, so the engine's ~10 Hz coalescing beat and the \
    tail's poll interval are inside it: 56 ms for a one-row diff is a beat, not work. The ceiling \
    sits two orders of magnitude above anything observed and is a wedge detector rather than a \
    performance budget. There is no compute-only serve measurement in this build.";

/// What one generation measured, in the three readings the budgets need.
///
/// Every field is an `Option` and absent means not yet measured, which is why
/// [`PerfBudgetVerdict::Unmeasured`] exists: a scan still running has no rate, and a session whose
/// every frame was an owed reset has no latency.
#[derive(Debug, Clone, Copy, Default)]
pub struct Readings {
    /// Wall time from the first byte read to the fold landing.
    pub scan_ms: Option<u64>,
    /// Bytes the scan read, up to the mark it landed on.
    pub scan_bytes: Option<u64>,
    /// The worst fold-to-frame latency any source has reported this generation, in microseconds.
    pub worst_serve_us: Option<u64>,
}

/// Every budget this build enforces, judged and rendered, in the order the panel draws them.
///
/// The list is never empty and never short: a budget with nothing to judge yet answers `unmeasured`
/// rather than dropping out, because a panel whose row count changed under it would make "the engine
/// is still starting" look like "this build stopped enforcing that".
#[must_use]
pub fn budgets(readings: &Readings) -> Vec<PerfBudget> {
    vec![fold_rate(readings), serve_latency(readings)]
}

/// The fold-rate row: bytes per second over the scan that built this generation.
fn fold_rate(readings: &Readings) -> PerfBudget {
    let measured = fold_bytes_per_sec(readings);
    PerfBudget {
        id: PerfBudgetId::FoldRate,
        label: "fold rate".to_string(),
        limit: format!("at least {}", rate(MIN_FOLD_BYTES_PER_SEC)),
        measured: measured.map(rate),
        verdict: at_least(measured, MIN_FOLD_BYTES_PER_SEC),
        note: FOLD_NOTE.to_string(),
    }
}

/// The serve-latency row: the worst fold-to-frame time any source has reported this generation.
fn serve_latency(readings: &Readings) -> PerfBudget {
    PerfBudget {
        id: PerfBudgetId::ServeLatency,
        label: "serve latency".to_string(),
        limit: format!("at most {}", took(MAX_SERVE_LATENCY_US)),
        measured: readings.worst_serve_us.map(took),
        verdict: at_most(readings.worst_serve_us, MAX_SERVE_LATENCY_US),
        note: SERVE_NOTE.to_string(),
    }
}

/// Bytes per second over the scan, or `None` while the scan is still running.
///
/// A `scan_ms` of zero is a log small enough to fold inside the clock's resolution, so the rate is
/// reported as if the scan took one millisecond: a fold too fast to time is not a fold that failed.
fn fold_bytes_per_sec(readings: &Readings) -> Option<u64> {
    let (ms, bytes) = (readings.scan_ms?, readings.scan_bytes?);
    Some(bytes.saturating_mul(1_000) / ms.max(1))
}

/// `pass` when the measurement clears the floor, `unmeasured` when there is nothing to judge.
fn at_least(measured: Option<u64>, floor: u64) -> PerfBudgetVerdict {
    match measured {
        None => PerfBudgetVerdict::Unmeasured,
        Some(value) if value >= floor => PerfBudgetVerdict::Pass,
        Some(_) => PerfBudgetVerdict::Fail,
    }
}

/// `pass` when the measurement stays under the ceiling, `unmeasured` when there is nothing to judge.
fn at_most(measured: Option<u64>, ceiling: u64) -> PerfBudgetVerdict {
    match measured {
        None => PerfBudgetVerdict::Unmeasured,
        Some(value) if value <= ceiling => PerfBudgetVerdict::Pass,
        Some(_) => PerfBudgetVerdict::Fail,
    }
}

/// A byte rate a person reads, at a precision that does not throw the measurement away.
///
/// MB/s with one decimal, because these numbers run from a floor of 1.0 to a measured 7.8 and the
/// question is which side of the floor a build landed on; kB/s below a megabyte, because `0.0 MB/s`
/// reads as a measurement nobody took rather than as the bad news it is. Locale is fixed en-US,
/// which is why this is a `format!` and not a locale-aware anything.
fn rate(bytes_per_sec: u64) -> String {
    #[allow(clippy::cast_precision_loss)]
    let per_sec = bytes_per_sec as f64;
    if bytes_per_sec < 1_000_000 {
        format!("{:.0} kB/s", per_sec / 1_000.0)
    } else {
        format!("{:.1} MB/s", per_sec / 1_000_000.0)
    }
}

/// A microsecond count a person reads — `views::meter`'s own scale, on the wire.
///
/// Three bands rather than one format string: cutting a fifty-row window off a fold takes tens of
/// microseconds, so a serve path reporting `0.0 ms` reads as a measurement nobody took, while a
/// two-second ceiling written as `2000000 us` reads as nothing at all.
fn took(us: u64) -> String {
    #[allow(clippy::cast_precision_loss)]
    let micros = us as f64;
    if us < 1_000 {
        format!("{us} us")
    } else if us < 1_000_000 {
        format!("{:.1} ms", micros / 1_000.0)
    } else {
        format!("{:.1} s", micros / 1_000_000.0)
    }
}

#[cfg(test)]
mod tests {
    use super::{budgets, Readings, MAX_SERVE_LATENCY_US, MIN_FOLD_BYTES_PER_SEC};
    use protocol::generated::{PerfBudgetId, PerfBudgetVerdict};

    fn row(readings: &Readings, id: PerfBudgetId) -> protocol::generated::PerfBudget {
        budgets(readings)
            .into_iter()
            .find(|b| b.id == id)
            .expect("every budget is always in the list")
    }

    #[test]
    fn an_engine_that_has_measured_nothing_says_unmeasured_rather_than_passing() {
        // A just-launched engine has no scan and no served frame, and a budget surface that read
        // green there would be green for the whole window somebody is most likely looking at it in.
        let rows = budgets(&Readings::default());
        assert_eq!(rows.len(), 2, "a budget is never omitted");
        for budget in rows {
            assert_eq!(budget.verdict, PerfBudgetVerdict::Unmeasured);
            assert_eq!(budget.measured, None, "absent, never zero");
            assert!(!budget.limit.is_empty(), "the ceiling is stated regardless");
            assert!(!budget.note.is_empty(), "and so is the caveat");
        }
    }

    #[test]
    fn a_fold_at_the_measured_rate_passes_and_says_what_it_did() {
        // The real measurement behind the floor: 8 MB in 1030 ms.
        let readings = Readings {
            scan_ms: Some(1_030),
            scan_bytes: Some(8 * 1024 * 1024),
            worst_serve_us: None,
        };
        let budget = row(&readings, PerfBudgetId::FoldRate);
        assert_eq!(budget.verdict, PerfBudgetVerdict::Pass);
        assert_eq!(budget.measured.as_deref(), Some("8.1 MB/s"));
        assert!(budget.limit.contains("at least"), "{}", budget.limit);
        assert!(budget.limit.contains("1.0 MB/s"), "{}", budget.limit);
    }

    #[test]
    fn a_debug_build_rate_fails_the_floor() {
        // The 0.45 MB/s a debug `cargo test --workspace` measured — the floor working as designed.
        let readings = Readings {
            scan_ms: Some(1_000),
            scan_bytes: Some(450_000),
            worst_serve_us: None,
        };
        let budget = row(&readings, PerfBudgetId::FoldRate);
        assert_eq!(budget.verdict, PerfBudgetVerdict::Fail);
        assert_eq!(budget.measured.as_deref(), Some("450 kB/s"));
    }

    #[test]
    fn the_fold_row_states_the_unmet_g3_goal_rather_than_hiding_behind_a_pass() {
        // A pass on a floor an eighth below the measurement must not read as "the goal is met".
        let readings = Readings {
            scan_ms: Some(1_000),
            scan_bytes: Some(8_000_000),
            worst_serve_us: None,
        };
        let budget = row(&readings, PerfBudgetId::FoldRate);
        assert_eq!(budget.verdict, PerfBudgetVerdict::Pass);
        assert!(budget.note.contains("NOT met"), "{}", budget.note);
        assert!(budget.note.contains("52.5 s"), "{}", budget.note);
    }

    #[test]
    fn a_scan_too_fast_to_time_is_not_a_fold_that_failed() {
        // `scan_ms == 0` is a log small enough to fold inside the clock's resolution.
        let readings = Readings {
            scan_ms: Some(0),
            scan_bytes: Some(4_096),
            worst_serve_us: None,
        };
        let budget = row(&readings, PerfBudgetId::FoldRate);
        assert_eq!(budget.verdict, PerfBudgetVerdict::Pass);
        assert_eq!(budget.measured.as_deref(), Some("4.1 MB/s"));
    }

    #[test]
    fn the_serve_row_passes_the_measured_beat_and_carries_its_caveat() {
        // 56 ms is the measured one-row diff — a coalescing beat, well under a wedge detector.
        let readings = Readings {
            scan_ms: None,
            scan_bytes: None,
            worst_serve_us: Some(56_000),
        };
        let budget = row(&readings, PerfBudgetId::ServeLatency);
        assert_eq!(budget.verdict, PerfBudgetVerdict::Pass);
        assert_eq!(budget.measured.as_deref(), Some("56.0 ms"));
        assert!(budget.limit.contains("2.0 s"), "{}", budget.limit);
        assert!(budget.note.contains("wedge detector"), "{}", budget.note);
    }

    #[test]
    fn a_wedged_serve_path_fails_the_ceiling() {
        let readings = Readings {
            scan_ms: None,
            scan_bytes: None,
            worst_serve_us: Some(MAX_SERVE_LATENCY_US + 1),
        };
        let budget = row(&readings, PerfBudgetId::ServeLatency);
        assert_eq!(budget.verdict, PerfBudgetVerdict::Fail);
        assert_eq!(budget.measured.as_deref(), Some("2.0 s"));
    }

    #[test]
    fn a_measurement_exactly_on_the_limit_passes_on_both_budgets() {
        // The boundary is `at least` and `at most`, so equality passes on both. An off-by-one here
        // would make a CI floor and a served verdict disagree about the same measurement.
        let readings = Readings {
            scan_ms: Some(1_000),
            scan_bytes: Some(MIN_FOLD_BYTES_PER_SEC),
            worst_serve_us: Some(MAX_SERVE_LATENCY_US),
        };
        for budget in budgets(&readings) {
            assert_eq!(budget.verdict, PerfBudgetVerdict::Pass, "{budget:?}");
        }
    }

    #[test]
    fn the_rows_arrive_in_the_order_the_panel_draws_them() {
        // Order is the server's; a renderer that sorted this would be re-deriving.
        let ids: Vec<PerfBudgetId> = budgets(&Readings::default())
            .into_iter()
            .map(|b| b.id)
            .collect();
        assert_eq!(ids, [PerfBudgetId::FoldRate, PerfBudgetId::ServeLatency]);
    }
}
