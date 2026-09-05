//! THE LOG CLOCK: which zone a generation parses stamps through, and how far it disagrees with this
//! machine's.
//!
//! An EverQuest stamp is a zone-less local wall clock, so a fold that resolves the wrong zone moves
//! every event by a whole number of hours — and the fight lifecycle, the buff heartbeat and every
//! timer compare the log's clock against this process's. The zone is resolved once per attach
//! (`eqlog::resolve_zone`) and the disagreement is measured on the live tail, where the newest line
//! is seconds old by construction and the subtraction therefore means something.

use protocol::generated::{ClockHint, PerfSnapshotResultClockSource};

use crate::spawn::DIAGNOSTIC_PREFIX;

/// How far a live tail's newest line may sit from this machine's clock before the engine says so.
///
/// Half an hour is above every honest cause — a paused game, a slow disk, a laggy zone — and below
/// the smallest real zone error, which is a whole hour. The reading is SIGNED, because an
/// east-of-UTC host fails in the mirror direction with stamps in the future.
pub const SKEW_ALARM_MS: i64 = 30 * 60 * 1000;

/// The attach's clock hint in the parser's vocabulary. An absent hint is an empty one: the engine
/// resolves alone, which is what every non-app client says.
///
/// The offset narrows to `i32` because a zone offset is minutes and the wire's `integer` is not; a
/// value that will not fit is DROPPED rather than truncated into a plausible-looking one.
pub fn zone_hint(clock: Option<&ClockHint>) -> eqlog::ZoneHint {
    let Some(clock) = clock else {
        return eqlog::ZoneHint::default();
    };
    eqlog::ZoneHint {
        tz: clock.tz.clone(),
        utc_offset_min: clock.utc_offset_min.and_then(|m| i32::try_from(m).ok()),
    }
}

/// The parser's own vocabulary for where a zone came from, onto the wire's. An exhaustive `match`
/// rather than the two string spellings: a rung added on one side must stop the build.
pub fn clock_source(source: eqlog::ZoneSource) -> PerfSnapshotResultClockSource {
    match source {
        eqlog::ZoneSource::Host => PerfSnapshotResultClockSource::Host,
        eqlog::ZoneSource::Platform => PerfSnapshotResultClockSource::Platform,
        eqlog::ZoneSource::Offset => PerfSnapshotResultClockSource::Offset,
        eqlog::ZoneSource::Utc => PerfSnapshotResultClockSource::Utc,
    }
}

/// Resolve this attach's zone and state it on the world, before the first stamp is parsed. A losing
/// turn's statement is rejected inside `report_clock`, like every other `report_*`.
pub fn resolve_and_report(
    world: &crate::world::World,
    generation: u64,
    hint: &eqlog::ZoneHint,
) -> eqlog::ResolvedZone {
    let resolved = eqlog::resolve_zone(hint);
    world.report_clock(generation, resolved);
    resolved
}

/// The skew a live tail's newest line reads, and the one diagnostic a generation may print about it.
///
/// `None` when the tail has folded no stamped line. The scan is never asked: the age of a line from
/// last Tuesday is a fact about when somebody played, not about a clock. Past [`SKEW_ALARM_MS`] it
/// says so ONCE — a resolved zone does not change under a fold, so a second line is the same line.
pub fn skew_of(
    last_ts: Option<i64>,
    resolved: &eqlog::ResolvedZone,
    said: &mut bool,
) -> Option<i64> {
    let skew = crate::ingest::wall_clock_ms() - last_ts?;
    if !*said && skew.abs() >= SKEW_ALARM_MS {
        *said = true;
        eprintln!(
            "{DIAGNOSTIC_PREFIX} the log's clock disagrees with this machine's by {} minutes: \
             stamps are parsed through {} (source {}), so fights, buffs and timers will be wrong",
            skew / 60_000,
            resolved.zone.name(),
            resolved.source.as_str()
        );
    }
    Some(skew)
}
