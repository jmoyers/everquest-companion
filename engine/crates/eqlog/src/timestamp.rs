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
use chrono::{Duration, LocalResult, NaiveDate, Offset, TimeZone};
use chrono_tz::Tz;
use regex::Regex;
use std::sync::OnceLock;

/// The host's IANA zone, or `UTC` when the platform will not name one. `parity --tz` overrides it.
pub fn host_timezone() -> Tz {
    iana_time_zone::get_timezone()
        .ok()
        .and_then(|n| n.parse::<Tz>().ok())
        .unwrap_or(Tz::UTC)
}

pub struct Clock {
    tz: Tz,
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
    pub fn new(tz: Tz) -> Self {
        Clock { tz }
    }

    pub fn tz(&self) -> Tz {
        self.tz
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
        let local = utc.with_timezone(&self.tz).naive_local();
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
        match self.tz.offset_from_local_datetime(&naive) {
            LocalResult::Single(off) => (naive - off.fix()).and_utc().timestamp_millis(),
            // The repeated hour: the earlier of the two offsets is the pre-transition one.
            LocalResult::Ambiguous(before, _after) => {
                (naive - before.fix()).and_utc().timestamp_millis()
            }
            // The skipped hour: read the pre-transition offset off the previous day.
            LocalResult::None => {
                let probe = naive - Duration::hours(24);
                let off = match self.tz.offset_from_local_datetime(&probe) {
                    LocalResult::Single(o) => o.fix(),
                    LocalResult::Ambiguous(o, _) => o.fix(),
                    LocalResult::None => self.tz.offset_from_utc_datetime(&naive).fix(),
                };
                (naive - off).and_utc().timestamp_millis()
            }
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
}
