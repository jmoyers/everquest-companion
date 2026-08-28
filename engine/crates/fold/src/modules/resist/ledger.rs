//! The resist ledger: per-source buckets of pooled observations, and the key they pool by.
//!
//! A re-fold replaces a source's bucket, it never adds to it. The app re-reads the whole log at
//! startup, so idempotence has to be structural rather than a discipline the caller remembers:
//! `begin_source(key)` discards the bucket before its log is folded again. A bucket for a character
//! you are not folding is knowledge nothing can re-derive, so it survives untouched.
//!
//! A bucket holds counts, never verdicts. No R, no interval, no "immune" — a stored verdict is a
//! second opinion waiting to disagree with the derived one when a patch moves a resist adjust.
//!
//! The pooling key is every term of `rc` except R itself, plus the week. Rank and invocation are
//! resist adjust (-15 per rank; -150 for overchannel plus -15 per non-hybrid caster class), so
//! casts that rolled against different numbers may not be pooled. The class count is keyed on only
//! when overchannel was up, since that is the only time it moves `rc`. The week is about age, not
//! `rc`: a row pools counts, so one spanning March and this evening would have no honest weight.
//! Weekly because a 21-day half-life cannot use a finer resolution.
//!
//! The week key is UTC arithmetic on the epoch instant, so `--tz` cannot move it — the zone reaches
//! this fold only through the timestamp the parser resolved. ISO's year rule is ported rather than
//! approximated (the week belongs to the year containing its Thursday, so late December can read
//! `2027-W01`): the string is a key compared across builds, and drifting numbering would re-pool a
//! cell.

use crate::jsmap::JsMap;
use std::collections::HashMap;

pub const MAX_DISTINCT_DAMAGE_VALUES: usize = 32;

const DAY_MS: i64 = 86_400_000;
const WEEK_MS: i64 = 7 * DAY_MS;
/// 1970-01-01 was a Thursday, so the Monday opening epoch week zero is three days earlier. This
/// offset is the whole of the ISO week arithmetic; everything else is division.
const EPOCH_MONDAY: i64 = -3 * DAY_MS;

/// Monday 00:00 UTC of the week containing `ts`. `div_euclid` rather than truncation, which is what
/// the app's `Math.floor` does; the two part company before 1970.
pub fn week_start(ts: i64) -> i64 {
    (ts - EPOCH_MONDAY).div_euclid(WEEK_MS) * WEEK_MS + EPOCH_MONDAY
}

/// The ISO-8601 week the instant falls in, as `2026-W33`.
pub fn iso_week_key(ts: i64) -> String {
    let monday = week_start(ts);
    // The year of the week's Thursday, which is ISO's own rule.
    let year = civil_year_of(monday + 3 * DAY_MS);
    let week = round_half_up((monday - week_start(jan_4_utc(year))) as f64 / WEEK_MS as f64) + 1;
    format!("{year}-W{week:02}")
}

/// JS `Math.round`: half goes up, unlike Rust's `f64::round`, which goes away from zero. They only
/// differ on a negative half, which this arithmetic cannot produce.
fn round_half_up(v: f64) -> i64 {
    (v + 0.5).floor() as i64
}

/// January 4th, the day ISO guarantees is in week 1.
fn jan_4_utc(year: i64) -> i64 {
    days_from_civil(year, 1, 4) * DAY_MS
}

/// The proleptic Gregorian year an epoch instant falls in.
fn civil_year_of(ms: i64) -> i64 {
    let days = ms.div_euclid(DAY_MS);
    // Howard Hinnant's `civil_from_days`, reduced to the year it answers.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    if mp >= 10 {
        y + 1
    } else {
        y
    }
}

/// Howard Hinnant's `days_from_civil`, the inverse of the above.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// A string compare, and it is exact: `YYYY-Www` is zero-padded and fixed-width, so lexicographic
/// order is chronological order, ISO's year-boundary rule included.
pub fn later_week(a: Option<&str>, b: Option<&str>) -> Option<String> {
    match (a, b) {
        (None, b) => b.map(str::to_string),
        (a, None) => a.map(str::to_string),
        (Some(a), Some(b)) => Some(if a >= b { a.to_string() } else { b.to_string() }),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CasterKind {
    SelfCast,
    Pc,
    Npc,
}

impl CasterKind {
    pub fn as_str(self) -> &'static str {
        match self {
            CasterKind::SelfCast => "self",
            CasterKind::Pc => "pc",
            CasterKind::Npc => "npc",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Family {
    Cast,
    Song,
}

impl Family {
    pub fn as_str(self) -> &'static str {
        match self {
            Family::Cast => "cast",
            Family::Song => "song",
        }
    }
}

/// Everything a row is keyed by, plus the two things that ride along for the UI and are
/// deliberately not in the key: `zone`, and the catalog range beside the midpoint.
#[derive(Debug, Clone)]
pub struct RowSpec {
    pub mob_key: String,
    pub zone: Option<String>,
    pub spell_key: String,
    pub family: Family,
    pub caster_kind: CasterKind,
    pub caster_level: Option<i64>,
    pub mob_level: Option<i64>,
    pub mob_level_lo: Option<i64>,
    pub mob_level_hi: Option<i64>,
    pub debuffs: String,
    pub rank: i64,
    pub overchannel: Option<bool>,
    pub caster_classes: Option<i64>,
    pub week: Option<String>,
}

/// The pooling key, term for term and separator for separator with the app's `rowKey`.
///
/// The separator is a printable byte on purpose: a raw control byte makes git classify the file as
/// binary. No EQ mob or spell name contains a pipe, so it costs nothing.
pub fn row_key(row: &RowSpec) -> String {
    let num = |v: Option<i64>| v.map(|n| n.to_string()).unwrap_or_default();
    let oc = match row.overchannel {
        None => "?",
        Some(true) => "oc",
        Some(false) => "-",
    };
    let classes = if row.overchannel == Some(true) {
        row.caster_classes.unwrap_or(0).to_string()
    } else {
        String::new()
    };
    [
        row.mob_key.as_str(),
        row.spell_key.as_str(),
        row.family.as_str(),
        row.caster_kind.as_str(),
        &num(row.caster_level),
        &num(row.mob_level),
        row.debuffs.as_str(),
        &row.rank.to_string(),
        oc,
        &classes,
        row.week.as_deref().unwrap_or(""),
    ]
    .join("|")
}

/// The spec plus what accretes onto it.
#[derive(Debug, Clone)]
pub struct ResistRow {
    pub spec: RowSpec,
    pub resist: i64,
    pub land: i64,
    /// The damage histogram, keyed by the decimal number the line printed.
    pub dmg: HashMap<String, i64>,
    /// The row gave up on the histogram — see `add_damage`.
    pub variable: bool,
    pub first_ts: i64,
    pub last_ts: i64,
}

/// One bucket, accreting. A `JsMap` so insertion order is kept: only the count is published today,
/// but the app publishes the rows in that order and this must be able to.
#[derive(Debug, Default)]
pub struct ResistBucket {
    by_key: JsMap<ResistRow>,
    newest: Option<String>,
}

impl ResistBucket {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.by_key.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_key.is_empty()
    }

    /// The newest week this bucket holds — the instant every row's age is measured against.
    /// Maintained as rows arrive rather than scanned for, because the read side asks on every card
    /// draw and the scan is a pass over thousands of rows to re-derive what the writer knew.
    pub fn newest_week(&self) -> Option<&str> {
        self.newest.as_deref()
    }

    pub fn rows(&self) -> impl Iterator<Item = &ResistRow> {
        self.by_key.values()
    }

    /// The serialization order: sorted by pooling key so a re-run on unchanged input diffs to
    /// nothing. A second reader rather than a change to [`ResistBucket::rows`] because insertion
    /// order is what the fold walks and key order is only what the writer needs.
    #[must_use]
    pub fn rows_in_key_order(&self) -> Vec<&ResistRow> {
        let mut out: Vec<(&str, &ResistRow)> = self.by_key.iter().collect();
        out.sort_by(|a, b| a.0.cmp(b.0));
        out.into_iter().map(|(_, row)| row).collect()
    }

    /// Seed one persisted row, filed under its own pooling key — which is what makes a seed
    /// idempotent with a fold: a row the log re-derives lands on the same key and replaces it. The
    /// newest week moves with it, or a seeded bucket would age its rows from the wrong instant.
    pub fn seed_row(&mut self, row: ResistRow) {
        self.newest = later_week(self.newest.as_deref(), row.spec.week.as_deref());
        self.by_key.insert(row_key(&row.spec), row);
    }

    /// Get or mint the row this spec pools into, widening its span.
    ///
    /// A minted row is a row even if nothing is then counted on it, and that is not a quirk to
    /// tidy: damage mints the row before the tick handler decides the tick is a repeat, so the
    /// ledger carries all-zero rows and the golden's `rows` integer counts them.
    pub fn row(&mut self, spec: RowSpec, ts: i64) -> &mut ResistRow {
        self.newest = later_week(self.newest.as_deref(), spec.week.as_deref());
        let key = row_key(&spec);
        if !self.by_key.contains_key(&key) {
            self.by_key.insert(
                key.clone(),
                ResistRow {
                    spec,
                    resist: 0,
                    land: 0,
                    dmg: HashMap::new(),
                    variable: false,
                    first_ts: ts,
                    last_ts: ts,
                },
            );
        }
        let row = self.by_key.get_mut(&key).expect("just inserted");
        if ts < row.first_ts {
            row.first_ts = ts;
        }
        if ts > row.last_ts {
            row.last_ts = ts;
        }
        row
    }
}

/// Record one damage number.
///
/// Past the cap the row gives up on the histogram: a spell whose damage genuinely varies carries no
/// partial information anyway, and an unbounded map is a disk-size bug with a long tail.
/// `variable` says the give-up happened, so a reader can tell it from a rarely-cast spell.
///
/// A free function rather than a method because the caller is already holding the row.
pub fn add_damage(row: &mut ResistRow, amount: i64) {
    let key = amount.to_string();
    if row.variable {
        row.land += 1;
        return;
    }
    if !row.dmg.contains_key(&key) && row.dmg.len() >= MAX_DISTINCT_DAMAGE_VALUES {
        row.variable = true;
        for count in row.dmg.values() {
            row.land += count;
        }
        row.dmg.clear();
        row.land += 1;
        return;
    }
    *row.dmg.entry(key).or_insert(0) += 1;
}

/// Every bucket, keyed by source.
///
/// The bench constructs a private store with nothing seeded and one `begin_source` call under the
/// default key, so the ledger the goldens are counted over is one bucket wide.
#[derive(Debug, Default)]
pub struct ResistLedgerStore {
    buckets: JsMap<ResistBucket>,
}

impl ResistLedgerStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Discard a source's bucket before its log is folded again. The idempotence seam.
    pub fn begin_source(&mut self, key: &str) {
        self.buckets.insert(key.to_string(), ResistBucket::new());
    }

    /// Every source key, ascending: the order the file's `sources` array is written in, so an
    /// unchanged ledger fingerprints to the same bytes twice.
    #[must_use]
    pub fn source_keys(&self) -> Vec<&str> {
        let mut keys: Vec<&str> = self.buckets.keys().collect();
        keys.sort_unstable();
        keys
    }

    /// One bucket, read-only. `None` rather than an empty bucket for a source never held, so the
    /// store does not grow every time somebody asks about a character it has never seen.
    #[must_use]
    pub fn bucket(&self, key: &str) -> Option<&ResistBucket> {
        self.buckets.get(key)
    }

    pub fn bucket_mut(&mut self, key: &str) -> &mut ResistBucket {
        if !self.buckets.contains_key(key) {
            self.buckets.insert(key.to_string(), ResistBucket::new());
        }
        self.buckets.get_mut(key).expect("just inserted")
    }

    /// The newest week any bucket holds: the instant every row's age is measured against.
    pub fn newest_week(&self) -> Option<String> {
        let mut best: Option<String> = None;
        for bucket in self.buckets.values() {
            best = later_week(best.as_deref(), bucket.newest_week());
        }
        best
    }

    /// The module's whole published surface: how many pooled rows the ledger holds, and how many
    /// distinct creatures they are about.
    pub fn counts(&self) -> (usize, usize) {
        let mut rows = 0usize;
        let mut mobs: std::collections::HashSet<&str> = std::collections::HashSet::new();
        for bucket in self.buckets.values() {
            rows += bucket.len();
            for row in bucket.rows() {
                mobs.insert(row.spec.mob_key.as_str());
            }
        }
        (rows, mobs.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_iso_week_belongs_to_the_year_containing_its_thursday() {
        // 2026-08-19 is a Wednesday in ISO week 34.
        assert_eq!(iso_week_key(1_787_184_000_000), "2026-W34");
        // 1970-01-01 was a Thursday, so epoch week zero is 1970-W01.
        assert_eq!(iso_week_key(0), "1970-W01");
        // The year-boundary rule: 2019-12-30 (a Monday) is already 2020-W01.
        assert_eq!(iso_week_key(1_577_664_000_000), "2020-W01");
        // …and 2021-01-01 (a Friday) is still 2020-W53.
        assert_eq!(iso_week_key(1_609_459_200_000), "2020-W53");
        // Zero-padded to two digits, because the string is compared lexicographically.
        assert_eq!(iso_week_key(1_704_672_000_000), "2024-W02");
    }

    #[test]
    fn the_later_week_is_a_string_compare_and_absent_loses() {
        assert_eq!(
            later_week(None, Some("2026-W01")).as_deref(),
            Some("2026-W01")
        );
        assert_eq!(
            later_week(Some("2026-W01"), None).as_deref(),
            Some("2026-W01")
        );
        assert_eq!(later_week(None, None), None);
        assert_eq!(
            later_week(Some("2026-W52"), Some("2027-W01")).as_deref(),
            Some("2027-W01")
        );
    }

    #[test]
    fn the_histogram_gives_up_past_the_cap_and_folds_what_it_had_into_lands() {
        let mut row = ResistRow {
            spec: RowSpec {
                mob_key: "a rat".into(),
                zone: None,
                spell_key: "shock of frost".into(),
                family: Family::Cast,
                caster_kind: CasterKind::SelfCast,
                caster_level: None,
                mob_level: None,
                mob_level_lo: None,
                mob_level_hi: None,
                debuffs: String::new(),
                rank: 0,
                overchannel: Some(false),
                caster_classes: None,
                week: Some("2026-W34".into()),
            },
            resist: 0,
            land: 0,
            dmg: HashMap::new(),
            variable: false,
            first_ts: 0,
            last_ts: 0,
        };
        for n in 0..MAX_DISTINCT_DAMAGE_VALUES as i64 {
            add_damage(&mut row, n);
        }
        assert_eq!(row.dmg.len(), MAX_DISTINCT_DAMAGE_VALUES);
        assert!(!row.variable);
        add_damage(&mut row, 999);
        assert!(row.variable);
        assert!(row.dmg.is_empty());
        // The 32 it had, plus the one that broke the cap.
        assert_eq!(row.land, MAX_DISTINCT_DAMAGE_VALUES as i64 + 1);
        add_damage(&mut row, 1);
        assert_eq!(row.land, MAX_DISTINCT_DAMAGE_VALUES as i64 + 2);
    }

    #[test]
    fn the_row_key_states_the_class_count_only_where_it_changes_rc() {
        let base = RowSpec {
            mob_key: "a rat".into(),
            zone: Some("Innothule Swamp".into()),
            spell_key: "malosi".into(),
            family: Family::Cast,
            caster_kind: CasterKind::SelfCast,
            caster_level: Some(51),
            mob_level: Some(20),
            mob_level_lo: Some(18),
            mob_level_hi: Some(22),
            debuffs: String::new(),
            rank: 0,
            overchannel: Some(false),
            caster_classes: Some(3),
            week: Some("2026-W34".into()),
        };
        // The zone and the catalog range ride the row and are not in the key.
        assert_eq!(
            row_key(&base),
            "a rat|malosi|cast|self|51|20||0|-||2026-W34"
        );
        let oc = RowSpec {
            overchannel: Some(true),
            ..base.clone()
        };
        assert_eq!(
            row_key(&oc),
            "a rat|malosi|cast|self|51|20||0|oc|3|2026-W34"
        );
        let unknown = RowSpec {
            overchannel: None,
            caster_level: None,
            mob_level: None,
            ..base
        };
        // Three empties in a row: the two unknown levels and the empty debuff list.
        assert_eq!(row_key(&unknown), "a rat|malosi|cast|self||||0|?||2026-W34");
    }
}
