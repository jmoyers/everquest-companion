//! `"Sat Aug 01 13:00:28 2026"` → epoch millis, in host local time.
//!
//! The app hands a zone-less string to `Date.parse`, whose legacy-format path is local, so a golden
//! is a fact about the machine that recorded it and this crate must resolve the same wall clock
//! through the same zone.
//!
//! ECMA-262 resolves both DST corner cases at the offset in effect *before* the transition:
//!
//!   * Ambiguous (the hour a fall-back repeats): chrono hands back two offsets, earliest-UTC first,
//!     and the earlier instant is the one reached through the pre-transition offset.
//!   * Skipped (the hour a spring-forward deletes): chrono hands back nothing, so the offset is
//!     read off a local time a day earlier — never two transitions in one day, so that is
//!     unambiguous and is the offset the gap interrupted.
//!
//! Neither branch runs on the acceptance corpus; they are here because a live tail will reach one.

use crate::jsstr::{js_trim, JS_S};
use chrono::{Duration, FixedOffset, LocalResult, NaiveDate, NaiveDateTime, Offset, TimeZone};
use chrono_tz::Tz;
use regex::Regex;
use std::sync::OnceLock;

/// The prefix every engine diagnostic carries, spelled here because this crate is below `engined`
/// and must not depend on it. One string in two places, and both are stderr-only.
const DIAGNOSTIC_PREFIX: &str = "[eqc-engine]";

/// The platform's own answer, or `None`. On Windows the probe is a WinRT call, which Wine does not
/// implement and which is unavailable on some real installs — so a miss is ordinary, not exotic.
#[must_use]
pub fn platform_timezone() -> Option<Tz> {
    iana_time_zone::get_timezone()
        .ok()
        .and_then(|n| n.parse::<Tz>().ok())
}

/// The host's IANA zone, or `UTC` when the platform will not name one. `parity --tz` overrides it.
pub fn host_timezone() -> Tz {
    platform_timezone().unwrap_or(Tz::UTC)
}

/// The zone a log's stamps resolve through: a named zone with history, or a bare offset.
///
/// A NAME OUTRANKS AN OFFSET FOR DST and an offset outranks a name that disagrees with it — see
/// [`resolve_zone`]. `Fixed` has no transitions, so a session spanning one reads an hour off; that
/// is the priced cost of parsing at all on a host that cannot name its zone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Zone {
    /// A zone from the IANA database, with its historical DST rules.
    Iana(Tz),
    /// A constant offset east of UTC, rendered `+HH:MM`/`-HH:MM`.
    Fixed(FixedOffset),
}

impl Zone {
    /// A constant offset stated in minutes east of UTC, or `None` when that is not an offset.
    #[must_use]
    pub fn fixed(minutes: i32) -> Option<Zone> {
        minutes
            .checked_mul(60)
            .and_then(FixedOffset::east_opt)
            .map(Zone::Fixed)
    }

    /// How this zone names itself on the wire: the IANA name, or the signed `+HH:MM` offset.
    #[must_use]
    pub fn name(&self) -> String {
        match self {
            Zone::Iana(tz) => tz.name().to_owned(),
            Zone::Fixed(off) => off.to_string(),
        }
    }

    /// This zone's distance from UTC in minutes east, at one instant — the same number the attach
    /// hint carries, so the two can be compared without either side spelling the arithmetic again.
    #[must_use]
    pub fn offset_min(&self, at: chrono::DateTime<chrono::Utc>) -> i32 {
        let seconds = match self {
            Zone::Iana(tz) => at.with_timezone(tz).offset().fix().local_minus_utc(),
            Zone::Fixed(off) => off.local_minus_utc(),
        };
        seconds / 60
    }

    /// …at an epoch-millis instant, for a caller with no `chrono` of its own.
    #[must_use]
    pub fn offset_min_at_ms(&self, ms: i64) -> i32 {
        chrono::DateTime::from_timestamp_millis(ms).map_or(0, |at| self.offset_min(at))
    }
}

impl From<Tz> for Zone {
    fn from(tz: Tz) -> Self {
        Zone::Iana(tz)
    }
}

/// Where a resolved zone came from — the wire's `clockSource`, and the only way a silent UTC
/// fallback becomes visible.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ZoneSource {
    /// The attach hint's IANA name.
    Host,
    /// This process's own platform probe.
    Platform,
    /// The attach hint's fixed offset — no name was usable.
    Offset,
    /// Nothing answered. The failure this enum exists to make loud.
    Utc,
}

impl ZoneSource {
    /// The wire spelling, which is also what a diagnostic prints.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            ZoneSource::Host => "host",
            ZoneSource::Platform => "platform",
            ZoneSource::Offset => "offset",
            ZoneSource::Utc => "utc",
        }
    }
}

/// What the app knows about its own clock, as the attach carries it. Both halves optional: absent
/// means the engine resolves alone, which is what every non-app client says.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ZoneHint {
    /// An IANA name as the host spells it.
    pub tz: Option<String>,
    /// Minutes EAST of UTC at the instant of the attach.
    pub utc_offset_min: Option<i32>,
}

/// A resolved zone and the evidence it rests on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResolvedZone {
    /// The zone every stamp of this generation parses through.
    pub zone: Zone,
    /// Which rung of [`resolve_zone`]'s order answered.
    pub source: ZoneSource,
}

/// THE AGREEMENT RULE: a hinted offset vetoes a zone NAME that disagrees with it.
///
/// The offset came from the same ICU clock that stamped the log, so it is a measurement of the
/// thing being parsed; a name is a lookup that can be stale, wrong or unmapped. A name with no
/// offset to check against is accepted on trust, because it is still better than UTC.
fn agrees(tz: Tz, utc_offset_min: Option<i32>, now: chrono::DateTime<chrono::Utc>) -> bool {
    let Some(want) = utc_offset_min else {
        return true;
    };
    Zone::Iana(tz).offset_min(now) == want
}

/// Which zone this generation parses through, in the order (a) the host's name, (b) this process's
/// probe, (c) the host's offset, (d) UTC.
///
/// A `utc` answer is the one outcome that is always a defect — every stamp will be read hours away
/// from the wall clock the game wrote it with — so it says so on stderr rather than passing for a
/// choice. `utc` reached because the HINT names UTC is not that case and stays quiet.
#[must_use]
pub fn resolve_zone(hint: &ZoneHint) -> ResolvedZone {
    resolve_zone_at(hint, now_utc(), platform_timezone())
}

/// This process's wall clock. `chrono`'s own `Utc::now` is behind the `clock` feature, which this
/// crate does not take: a parser must not be able to read a clock by accident.
fn now_utc() -> chrono::DateTime<chrono::Utc> {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(0));
    chrono::DateTime::from_timestamp(secs, 0)
        .unwrap_or_else(|| chrono::DateTime::from_timestamp_nanos(0))
}

/// [`resolve_zone`] with both readings of the outside world stated: the instant the agreement rule
/// judges at, and what the platform probe answered. The seam the order is tested through — a test
/// that let the probe answer would assert about the machine it runs on.
#[must_use]
pub fn resolve_zone_at(
    hint: &ZoneHint,
    now: chrono::DateTime<chrono::Utc>,
    platform: Option<Tz>,
) -> ResolvedZone {
    let named = hint
        .tz
        .as_deref()
        .and_then(|n| n.parse::<Tz>().ok())
        .filter(|tz| agrees(*tz, hint.utc_offset_min, now));
    if let Some(tz) = named {
        return ResolvedZone {
            zone: Zone::Iana(tz),
            source: ZoneSource::Host,
        };
    }
    if let Some(tz) = platform.filter(|tz| agrees(*tz, hint.utc_offset_min, now)) {
        return ResolvedZone {
            zone: Zone::Iana(tz),
            source: ZoneSource::Platform,
        };
    }
    if let Some(zone) = hint.utc_offset_min.and_then(Zone::fixed) {
        return ResolvedZone {
            zone,
            source: ZoneSource::Offset,
        };
    }
    eprintln!(
        "{DIAGNOSTIC_PREFIX} no host zone and no platform zone: log stamps will be read as UTC, so \
         every wall-clock answer is off by this machine's offset"
    );
    ResolvedZone {
        zone: Zone::Iana(Tz::UTC),
        source: ZoneSource::Utc,
    }
}

/// The zone one attach's stamps resolve through. Cloneable so a sink can hold the parser's own
/// clock rather than rebuild a second one from its name.
#[derive(Debug, Clone, Copy)]
pub struct Clock {
    zone: Zone,
}

/// A local wall clock read as an instant, at the offset ECMA-262 picks. Generic over the zone so
/// the `Iana` branch keeps its DST rules verbatim and `Fixed` shares the same code path.
fn instant_of<T: TimeZone>(tz: &T, naive: NaiveDateTime) -> i64 {
    match tz.offset_from_local_datetime(&naive) {
        LocalResult::Single(off) => (naive - off.fix()).and_utc().timestamp_millis(),
        // The repeated hour: the earlier of the two offsets is the pre-transition one.
        LocalResult::Ambiguous(before, _after) => {
            (naive - before.fix()).and_utc().timestamp_millis()
        }
        // The skipped hour: read the pre-transition offset off the previous day.
        LocalResult::None => {
            let probe = naive - Duration::hours(24);
            let off = match tz.offset_from_local_datetime(&probe) {
                LocalResult::Single(o) => o.fix(),
                LocalResult::Ambiguous(o, _) => o.fix(),
                LocalResult::None => tz.offset_from_utc_datetime(&naive).fix(),
            };
            (naive - off).and_utc().timestamp_millis()
        }
    }
}

/// A wall-clock reading: the calendar fields an instant shows on one zone, and the inverse of
/// [`Clock::parse_eq_timestamp`]. Fields rather than a formatted string, because a format is a
/// display decision while resolving an instant through the parse zone is this file's job.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Civil {
    /// Calendar year.
    pub year: i32,
    /// Month, 1..=12.
    pub month: u32,
    /// Day of month, 1..=31.
    pub day: u32,
    /// Hour of a 24-hour clock, 0..=23.
    pub hour: u32,
    /// Minute, 0..=59.
    pub minute: u32,
    /// Second, 0..=59.
    pub second: u32,
}

fn stamp_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        // The app's stamp pattern with JS's ASCII `\w`/`\d` and `\s` set spelled out (jsstr.rs).
        Regex::new(&format!(
            r"^[0-9A-Za-z_]{{3}}{s}+([0-9A-Za-z_]{{3}}){s}+([0-9]{{1,2}}){s}+([0-9]{{2}}):([0-9]{{2}}):([0-9]{{2}}){s}+([0-9]{{4}})$",
            s = JS_S
        ))
        .unwrap()
    })
}

/// V8's legacy date parser recognizes month names by their first three letters, case-insensitively.
fn month_of(m: &str) -> Option<u32> {
    const MONTHS: [&str; 12] = [
        "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
    ];
    let lower = m.to_ascii_lowercase();
    MONTHS
        .iter()
        .position(|x| *x == lower)
        .map(|i| i as u32 + 1)
}

impl Clock {
    /// Takes anything that names a zone, so `Clock::new(Tz::…)` and `Clock::new(resolved.zone)` are
    /// the same call.
    pub fn new(zone: impl Into<Zone>) -> Self {
        Clock { zone: zone.into() }
    }

    #[must_use]
    pub fn zone(&self) -> Zone {
        self.zone
    }

    /// Read an epoch-millis instant back as the wall clock it shows on this zone.
    ///
    /// Inverse of `parse_eq_timestamp` everywhere the mapping is one-to-one; a repeated hour reads
    /// back as one of its two spellings and a skipped one never occurs.
    ///
    /// `None` for an instant outside the representable range. A stamp the parser could not read is
    /// 0, and 0 is a real instant (1970), so the caller decides what an unknown timestamp renders
    /// as.
    #[must_use]
    pub fn civil(&self, ms: i64) -> Option<Civil> {
        let utc = chrono::DateTime::from_timestamp_millis(ms)?;
        let local = match self.zone {
            Zone::Iana(tz) => utc.with_timezone(&tz).naive_local(),
            Zone::Fixed(off) => utc.with_timezone(&off).naive_local(),
        };
        Some(Civil {
            year: chrono::Datelike::year(&local),
            month: chrono::Datelike::month(&local),
            day: chrono::Datelike::day(&local),
            hour: chrono::Timelike::hour(&local),
            minute: chrono::Timelike::minute(&local),
            second: chrono::Timelike::second(&local),
        })
    }

    /// A stamp the pattern declines, or a date V8 would call NaN, is 0.
    pub fn parse_eq_timestamp(&self, stamp: &str) -> i64 {
        let t = js_trim(stamp);
        let Some(m) = stamp_re().captures(t) else {
            // The app falls back to a bare `Date.parse` here. Every timestamped line in an EQ log
            // matches the pattern above — the parity comparator reports any that do not — so this
            // answers 0 rather than shipping a partial V8 legacy date grammar.
            let _ = t;
            return 0;
        };
        let Some(month) = month_of(&m[1]) else {
            return 0;
        };
        let day: u32 = m[2].parse().unwrap_or(0);
        let hour: u32 = m[3].parse().unwrap_or(99);
        let min: u32 = m[4].parse().unwrap_or(99);
        let sec: u32 = m[5].parse().unwrap_or(99);
        let year: i32 = m[6].parse().unwrap_or(0);
        let Some(date) = NaiveDate::from_ymd_opt(year, month, day) else {
            return 0;
        };
        let Some(naive) = date.and_hms_opt(hour, min, sec) else {
            return 0;
        };
        match self.zone {
            Zone::Iana(tz) => instant_of(&tz, naive),
            Zone::Fixed(off) => instant_of(&off, naive),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn la() -> Clock {
        Clock::new(chrono_tz::America::Los_Angeles)
    }

    #[test]
    fn reads_the_slice_corpus_shape() {
        // The first line of the patch-week golden: [Wed Aug 19 16:21:47 2026] → 1787181707000.
        assert_eq!(
            la().parse_eq_timestamp("Wed Aug 19 16:21:47 2026"),
            1787181707000
        );
    }

    #[test]
    fn the_wall_clock_reads_back_out_of_the_instant_it_resolved_to() {
        // The round trip through the same zone, on the corpus's own first line.
        let ms = la().parse_eq_timestamp("Wed Aug 19 16:21:47 2026");
        let civil = la().civil(ms).expect("a representable instant");
        assert_eq!(
            (
                civil.year,
                civil.month,
                civil.day,
                civil.hour,
                civil.minute,
                civil.second
            ),
            (2026, 8, 19, 16, 21, 47)
        );
        // …and a UTC clock reads the same instant seven hours later, which is why the zone is a
        // property of the Clock rather than of the caller.
        let utc = Clock::new(chrono_tz::UTC).civil(ms).expect("an instant");
        assert_eq!((utc.day, utc.hour), (19, 23));
    }

    #[test]
    fn a_stamp_that_is_not_one_is_zero() {
        assert_eq!(la().parse_eq_timestamp("not a timestamp"), 0);
        assert_eq!(la().parse_eq_timestamp("Sat Zzz 01 13:00:28 2026"), 0);
    }

    #[test]
    fn the_skipped_hour_reads_at_the_offset_before_the_transition() {
        // 2026-03-08 02:30 does not exist in America/Los_Angeles. ECMA-262 reads it at PST
        // (-08:00), landing on 10:30Z — the same answer V8 gives.
        let ms = la().parse_eq_timestamp("Sun Mar 08 02:30:00 2026");
        assert_eq!(ms, 1772965800000);
    }

    #[test]
    fn the_repeated_hour_reads_at_the_offset_before_the_transition() {
        // 2026-11-01 01:30 happens twice. The rule takes PDT (-07:00) → 08:30Z.
        let ms = la().parse_eq_timestamp("Sun Nov 01 01:30:00 2026");
        assert_eq!(ms, 1793521800000);
    }

    /// A September 2026 instant: PDT is in force in Los Angeles and CEST in Berlin, so every
    /// agreement assertion below is a fact about the zone database rather than about today.
    fn september() -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::from_timestamp(1_789_000_000, 0).expect("a representable instant")
    }

    fn hint(tz: Option<&str>, offset: Option<i32>) -> ZoneHint {
        ZoneHint {
            tz: tz.map(str::to_owned),
            utc_offset_min: offset,
        }
    }

    /// Wine's failure: the probe answers nothing.
    const NO_PROBE: Option<Tz> = None;

    #[test]
    fn the_hosts_name_is_the_first_rung() {
        let resolved = resolve_zone_at(
            &hint(Some("America/Los_Angeles"), Some(-420)),
            september(),
            NO_PROBE,
        );
        assert_eq!(resolved.source, ZoneSource::Host);
        assert_eq!(resolved.zone, Zone::Iana(chrono_tz::America::Los_Angeles));
    }

    #[test]
    fn the_platform_probe_is_the_second() {
        let resolved = resolve_zone_at(
            &hint(None, None),
            september(),
            Some(chrono_tz::America::Los_Angeles),
        );
        assert_eq!(resolved.source, ZoneSource::Platform);
        assert_eq!(resolved.zone, Zone::Iana(chrono_tz::America::Los_Angeles));
    }

    #[test]
    fn a_host_name_that_disagrees_with_the_host_offset_falls_through_to_the_offset() {
        // Berlin is east of UTC in every season, so it can never be -420. The offset is a
        // measurement of the clock that stamped the log and the name is a lookup; the name loses,
        // and so does a platform probe that repeats it.
        let resolved = resolve_zone_at(
            &hint(Some("Europe/Berlin"), Some(-420)),
            september(),
            Some(chrono_tz::Europe::Berlin),
        );
        assert_eq!(resolved.source, ZoneSource::Offset);
        assert_eq!(
            resolved.zone,
            Zone::Fixed(FixedOffset::east_opt(-420 * 60).unwrap())
        );
    }

    #[test]
    fn a_garbage_zone_name_is_skipped() {
        let resolved = resolve_zone_at(
            &hint(Some("Middle/Earth"), Some(-420)),
            september(),
            NO_PROBE,
        );
        assert_eq!(resolved.source, ZoneSource::Offset);
        assert_eq!(resolved.zone.name(), "-07:00");
    }

    #[test]
    fn nothing_usable_is_utc_and_says_so() {
        let resolved = resolve_zone_at(&hint(Some("Middle/Earth"), None), september(), NO_PROBE);
        assert_eq!(resolved.source, ZoneSource::Utc);
        assert_eq!(resolved.zone, Zone::Iana(Tz::UTC));
    }

    #[test]
    fn an_agreeing_probe_outranks_a_bare_offset() {
        // The offset alone would resolve `Fixed(-07:00)`, which has no DST; a probe that agrees with
        // it right now carries the transitions the fold will cross later.
        let resolved = resolve_zone_at(
            &hint(None, Some(-420)),
            september(),
            Some(chrono_tz::America::Los_Angeles),
        );
        assert_eq!(resolved.source, ZoneSource::Platform);
    }

    #[test]
    fn the_live_probe_and_the_live_order_agree_with_each_other() {
        // `resolve_zone` reads the machine; this pins the two entry points to one answer rather
        // than asserting which zone this particular machine is on.
        let hinted = hint(None, None);
        assert_eq!(
            resolve_zone(&hinted).source,
            resolve_zone_at(&hinted, now_utc(), platform_timezone()).source
        );
    }

    #[test]
    fn a_fixed_offset_clock_parses_and_reads_back_the_same_wall_clock() {
        // The same corpus line through -07:00: LA was on PDT that day, so the instant is the LA
        // one, and the round trip through `civil` returns the wall clock it was written with.
        let fixed = Clock::new(Zone::Fixed(FixedOffset::east_opt(-420 * 60).unwrap()));
        let ms = fixed.parse_eq_timestamp("Wed Aug 19 16:21:47 2026");
        assert_eq!(ms, 1787181707000);
        let civil = fixed.civil(ms).expect("a representable instant");
        assert_eq!((civil.day, civil.hour, civil.minute), (19, 16, 21));
    }
}
