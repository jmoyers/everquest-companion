//! THE RESIST LEDGER: per-source buckets of POOLED observations, and the key they pool by
//! (`src/main/resist/ledger.ts`, `src/shared/resistDecay.ts`).
//!
//! ── A RE-FOLD REPLACES A SOURCE'S BUCKET, IT NEVER ADDS TO IT (JOS-231) ─────────────────────────
//!
//! Learned the expensive way on the message overlay: seeding a fold from its own persisted output
//! doubled every count on every cold launch. The app re-reads the whole log at startup, so
//! idempotence cannot be a discipline the caller remembers — it has to be structural.
//! `begin_source(key)` DISCARDS the bucket before its log is folded again, and a bucket for a
//! character you are not folding is knowledge nothing can re-derive, so it survives untouched.
//!
//! ── AND A BUCKET HOLDS COUNTS, NEVER VERDICTS ──────────────────────────────────────────────────
//!
//! There is no R, no interval and no "immune" anywhere in this file. A stored verdict is a second
//! opinion waiting to disagree with the derived one, and every one of them would have to be
//! recomputed when a patch moves a spell's resist adjust.
//!
//! ── THE POOLING KEY IS EVERY TERM OF `rc` EXCEPT R ITSELF ───────────────────────────────────────
//!
//! `row_key` is what the golden's two integers are counted over, so every term in it is
//! load-bearing to the bar — a single wrong `mobLevel` or ISO week splits or merges a row and the
//! count moves. Three of its terms carry an argument rather than being obvious:
//!
//!   THE RANK AND THE INVOCATION ARE IN IT (JOS-387), because both are resist adjust: a rank is -15
//!   each and overchannel is -150 plus -15 per non-hybrid caster class, so two casts of the same
//!   spell at different ranks — or one in overchannel and one out of it — rolled against different
//!   numbers and may not be pooled.
//!
//!   THE CLASS COUNT IS IN IT ONLY WHERE IT MATTERS. It contributes to `rc` only when overchannel
//!   was up, so keying on it unconditionally would split every ordinary row on a value that changes
//!   nothing about them. A size decision made once, here, rather than a special case scattered
//!   through the estimator.
//!
//!   THE WEEK IS IN IT (JOS-397), and it is the one term that is not about `rc` at all. It is about
//!   AGE: a row POOLS counts, so a row that spanned March and this evening would have no age and no
//!   honest weight to give. Weekly rather than daily because a 21-day half-life cannot use a finer
//!   resolution and a day bucket would multiply the ledger by seven to say the same thing.
//!
//! ── AND THE WEEK KEY IS COMPUTED IN UTC, WHICH IS WHY `--tz` CANNOT MOVE IT ─────────────────────
//!
//! `isoWeekKey` is arithmetic on the epoch instant: `weekStart` divides by the week, and the year
//! comes from `getUTCFullYear` of the week's Thursday. The zone reaches this fold only through the
//! TIMESTAMP the parser resolved (`eqlog::Clock`), never through the week arithmetic itself — so
//! the port needs no local-time machinery, and a golden recorded under one zone re-checks under the
//! same one for the same reason the event stream does.
//!
//! ISO'S OWN YEAR RULE is ported rather than approximated: the week belongs to the year containing
//! its THURSDAY, which is why the last days of December can read `2027-W01`. The string is a ledger
//! KEY — compared for equality across builds — and a numbering that drifted between two readings
//! would silently re-pool a cell.

use crate::jsmap::JsMap;
use std::collections::HashMap;

/// `shared/resistTypes.ts MAX_DISTINCT_DAMAGE_VALUES`.
pub const MAX_DISTINCT_DAMAGE_VALUES: usize = 32;

const DAY_MS: i64 = 86_400_000;
const WEEK_MS: i64 = 7 * DAY_MS;
/// 1970-01-01 was a THURSDAY, so the Monday that opens epoch week zero is three days earlier. This
/// offset is the whole of the ISO week arithmetic; everything else is division.
const EPOCH_MONDAY: i64 = -3 * DAY_MS;

/// `resistDecay.ts weekStart` — Monday 00:00 UTC of the week containing `ts`. `Math.floor` on a
/// negative quotient is `div_euclid`, not truncation, and the two part company before 1970.
pub fn week_start(ts: i64) -> i64 {
    (ts - EPOCH_MONDAY).div_euclid(WEEK_MS) * WEEK_MS + EPOCH_MONDAY
}

/// `resistDecay.ts isoWeekKey` — the ISO-8601 week the instant falls in, as `2026-W33`.
pub fn iso_week_key(ts: i64) -> String {
    let monday = week_start(ts);
    // `new Date(monday + 3 days).getUTCFullYear()`.
    let year = civil_year_of(monday + 3 * DAY_MS);
    let week = round_half_up((monday - week_start(jan_4_utc(year))) as f64 / WEEK_MS as f64) + 1;
    format!("{year}-W{week:02}")
}

/// `Math.round` — half goes UP (toward +infinity), unlike Rust's `f64::round`, which goes away from
/// zero. The two only differ on a negative half, which this arithmetic cannot produce; spelled out
/// anyway because the difference is exactly the kind that hides for a year.
fn round_half_up(v: f64) -> i64 {
    (v + 0.5).floor() as i64
}

/// `Date.UTC(year, 0, 4)` — January 4th, the day ISO guarantees is in week 1.
fn jan_4_utc(year: i64) -> i64 {
    days_from_civil(year, 1, 4) * DAY_MS
}

/// `getUTCFullYear` — the proleptic Gregorian year an epoch instant falls in.
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

/// `resistDecay.ts laterWeek` — a STRING compare, and it is exact rather than approximate:
/// `YYYY-Www` is zero-padded and fixed-width, so its lexicographic order IS its chronological order,
/// ISO's year-boundary rule included (`2027-W01` sorts after `2026-W52`).
pub fn later_week(a: Option<&str>, b: Option<&str>) -> Option<String> {
    match (a, b) {
        (None, b) => b.map(str::to_string),
        (a, None) => a.map(str::to_string),
        (Some(a), Some(b)) => Some(if a >= b { a.to_string() } else { b.to_string() }),
    }
}

/// `ResistCasterKind`.
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

/// `ResistFamily`.
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

/// `ledger.ts RowSpec` — everything a row is keyed BY, plus the two things that ride along for the
/// UI and are deliberately NOT in the key (`zone`, and the catalog range beside the midpoint).
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

/// `ledger.ts rowKey`, term for term and separator for separator.
///
/// The separator is a PRINTABLE byte, deliberately: AGENTS.md's rule about raw control bytes in
/// source exists because one makes git classify the file as binary and blame, diff and grep go
/// dark. No EQ mob or spell name has ever contained a pipe, so it costs nothing.
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

/// `ledger.ts ResistRow` — the spec plus what accretes onto it.
#[derive(Debug, Clone)]
pub struct ResistRow {
    pub spec: RowSpec,
    pub resist: i64,
    pub land: i64,
    /// The damage histogram, keyed by the number the line printed (`String(amount)`).
    pub dmg: HashMap<String, i64>,
    /// The row gave up on the histogram — see `add_damage`.
    pub variable: bool,
    pub first_ts: i64,
    pub last_ts: i64,
}

/// One bucket, accreting. A `JsMap` because `rows()` publishes the map in a stated order over
/// there; here nothing but the COUNT of it is published, and the insertion order is kept anyway so
/// that a later ticket which does publish the rows finds the order already right.
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

    /// THE NEWEST WEEK THIS BUCKET HOLDS, maintained as rows arrive rather than scanned for: the
    /// read side asks for it on every card draw (it is the instant every row's age is measured
    /// against), and the alternative is a pass over four thousand rows per draw to re-derive a
    /// maximum the writer already knew.
    pub fn newest_week(&self) -> Option<&str> {
        self.newest.as_deref()
    }

    pub fn rows(&self) -> impl Iterator<Item = &ResistRow> {
        self.by_key.values()
    }

    /// THE SERIALIZATION ORDER — `ResistBucket.rows()` over there, which sorts by the pooling key
    /// before it hands the array out, and says why: *"sorted for a byte-stable serialization: a
    /// re-run on unchanged input must diff to nothing."*
    ///
    /// It is a SECOND reader rather than a change to [`ResistBucket::rows`] because the two orders
    /// answer different questions and both are load-bearing. `rows()` is insertion order, which is
    /// what the fold and the counts walk; this is key order, which is what goes on disk and what
    /// the write's coalescing fingerprint is taken over. Sorting the live map would have made every
    /// insert O(n log n) to buy a property only the writer needs.
    #[must_use]
    pub fn rows_in_key_order(&self) -> Vec<&ResistRow> {
        let mut out: Vec<(&str, &ResistRow)> = self.by_key.iter().collect();
        out.sort_by(|a, b| a.0.cmp(b.0));
        out.into_iter().map(|(_, row)| row).collect()
    }

    /// SEED ONE PERSISTED ROW — `ResistBucket.seed`, one row at a time.
    ///
    /// Filed under its OWN pooling key, which is what makes a seed idempotent with a fold: a row
    /// the log is about to re-derive lands on the same key and is replaced rather than added to.
    /// The newest week moves with it, exactly as `seed` over there moves it, because the read side
    /// measures every row's age against that maximum and a seeded bucket that under-reported it
    /// would age its own rows from the wrong instant.
    pub fn seed_row(&mut self, row: ResistRow) {
        self.newest = later_week(self.newest.as_deref(), row.spec.week.as_deref());
        self.by_key.insert(row_key(&row.spec), row);
    }

    /// `ResistBucket.row` — get or mint the row this spec pools into, widening its span.
    ///
    /// A MINTED ROW IS A ROW EVEN IF NOTHING IS THEN COUNTED ON IT, and that is not a quirk to tidy:
    /// `onSpellDamage` mints the row before `onDotTick` decides the tick is a repeat, so the ledger
    /// carries all-zero rows and the golden's `rows` integer counts them.
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

/// `ResistBucket.addDamage` — record one damage number.
///
/// PAST THE CAP THE ROW GIVES UP ON THE HISTOGRAM: a spell whose damage genuinely varies carries no
/// partial information anyway (the estimator can only read "message or no message" off it), and an
/// unbounded map is a disk-size bug with a long tail. `variable` says the give-up happened, so a
/// later reader can tell it from a spell that simply has not been cast much.
///
/// A free function rather than a method because the caller is already holding the row: over there
/// the bucket and the row are two references into the same graph, and here the borrow says so.
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

/// `ResistLedgerStore` — every bucket, keyed by source.
///
/// WHAT THE BENCH CONSTRUCTS, and therefore what the golden was recorded through: `memorySeam()`
/// over a private store with NOTHING seeded. The shipped `resistBaseline.json` is not loaded, and
/// `beginSource` is called exactly once, by `reset()`, with the module's constructed default key
/// `'log'`. So the ledger these counts are taken over is one bucket wide.
#[derive(Debug, Default)]
pub struct ResistLedgerStore {
    buckets: JsMap<ResistBucket>,
}

impl ResistLedgerStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Discard a source's bucket before its log is folded again. THE idempotence seam.
    pub fn begin_source(&mut self, key: &str) {
        self.buckets.insert(key.to_string(), ResistBucket::new());
    }

    /// EVERY SOURCE KEY, SORTED ASCENDING — `ResistLedgerStore.keys()`, which sorts for the same
    /// reason `rows()` does: this is the order the file's `sources` array is written in, and a
    /// stable order is what lets an unchanged ledger fingerprint to the same bytes twice.
    #[must_use]
    pub fn source_keys(&self) -> Vec<&str> {
        let mut keys: Vec<&str> = self.buckets.keys().collect();
        keys.sort_unstable();
        keys
    }

    /// One bucket, read-only. `None` for a source this store has never held — which is the honest
    /// answer rather than an empty bucket, because minting one on a READ would make the store grow
    /// every time somebody asked about a character it has never seen.
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

    /// The newest week ANY bucket holds: the instant every row's age is measured against.
    pub fn newest_week(&self) -> Option<String> {
        let mut best: Option<String> = None;
        for bucket in self.buckets.values() {
            best = later_week(best.as_deref(), bucket.newest_week());
        }
        best
    }

    /// `memorySeam().counts()` — the module's whole published surface: how many pooled rows the
    /// ledger holds, and how many distinct creatures they are about.
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
        // The zone and the catalog range ride the row and are NOT in the key.
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
