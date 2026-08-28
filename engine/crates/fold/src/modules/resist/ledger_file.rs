//! `<userData>/resist-ledger.json` — the app's own file, read and written verbatim. The pure half:
//! this module knows the shape and the rules and touches no disk, because a full disk and a
//! half-written file are not states a test can arrange. `engined::state` knows the directory.
//!
//! The format is inherited, not negotiated: `{"version":3,"sources":[{"key":…,"rows":[…]}]}`. Both
//! implementations must be able to hold the same file, so a user who turns the engine flag off does
//! not lose a ledger. Two consequences:
//!
//!   * `version` is written first. The app's truncation salvage reads the version off the head of a
//!     file with no parseable JSON left, so a serializer that put `sources` first would disable it.
//!     Field order here is declaration order, so the declaration below is that guarantee.
//!   * Rows carry the app's `camelCase` spelling, with the same three fields written as `null`
//!     rather than omitted and the same six omitted rather than `null`.
//!
//! Key order within a row is not claimed by the app either; this module writes one fixed order so
//! that an unchanged ledger fingerprints to the same bytes twice, which is what the coalescing
//! write needs.
//!
//! Named residual: the app's three read tiers past "it parsed" — whole-object salvage, truncation
//! salvage, and a quarantine that renames the unreadable bytes — are not ported. A file that will
//! not parse reads as empty and the bytes are left where they are. A torn file costs this run's
//! seed for the folded character, but it also holds other characters' buckets, which nothing can
//! re-derive.

use std::collections::HashMap;

use serde::ser::SerializeMap;
use serde::{Deserialize, Serialize, Serializer};

use super::ledger::{CasterKind, Family, ResistBucket, ResistLedgerStore, ResistRow, RowSpec};

/// A file of any other version reads as empty: discarded, not migrated, because the honest upgrade
/// is the re-fold the app performs from the log on every launch anyway.
pub const RESIST_LEDGER_VERSION: i64 = 3;

/// The bucket the shipped baseline is filed under. Rejected on read and dropped on write both: the
/// baseline is re-seeded from the bundle every launch, so a copy in userData would double-count on
/// read and be a staler duplicate on write.
pub const BASELINE_SOURCE_KEY: &str = "baseline";

/// One character's bucket as it sits in the file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LedgerSource {
    pub key: String,
    pub rows: Vec<ResistRowFile>,
}

/// The file itself. `version` first — see the module header for why that is load-bearing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserLedgerFile {
    pub version: i64,
    pub sources: Vec<LedgerSource>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FamilyFile {
    Cast,
    Song,
}

/// `self` is a Rust keyword, hence the rename rather than a variant spelled as the JSON spells it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CasterKindFile {
    #[serde(rename = "self")]
    SelfCast,
    Pc,
    Npc,
}

/// One pooled cell, in the app's spelling. The `serde` attributes below are the module header's
/// null-versus-absent rule, field by field.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResistRowFile {
    pub mob_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zone: Option<String>,
    pub spell_key: String,
    pub family: FamilyFile,
    pub caster_kind: CasterKindFile,
    /// `number | null` — written as `null`, never omitted.
    #[serde(default)]
    pub caster_level: Option<i64>,
    /// `number | null` — written as `null`, never omitted.
    #[serde(default)]
    pub mob_level: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mob_level_lo: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mob_level_hi: Option<i64>,
    pub debuffs: String,
    pub rank: i64,
    /// `boolean | null` — written as `null`, never omitted. `null` is "not known" and is never
    /// assumed to be `false`; the row key spells the three states apart.
    #[serde(default)]
    pub overchannel: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caster_classes: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub week: Option<String>,
    pub resist: i64,
    pub land: i64,
    pub dmg: Histogram,
    /// Present only when the row gave up on the histogram; `Some(false)` is not a shape either
    /// implementation writes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variable: Option<bool>,
    pub first_ts: i64,
    pub last_ts: i64,
}

/// The damage histogram, keyed by the decimal number the log printed.
///
/// It serializes in numeric-ascending key order, which is what a JavaScript object does with
/// canonical array-index keys and what a `BTreeMap` gets wrong the moment a ledger holds both `"9"`
/// and `"10"`. The order must be a function of the histogram's content rather than of a hash
/// iteration order, because the coalescing fingerprint is taken over it.
///
/// A key that is not a canonical index sorts after every key that is, by its string — unreachable
/// for damage numbers, but it makes the order total rather than nearly total.
#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
#[serde(transparent)]
pub struct Histogram(pub HashMap<String, i64>);

impl Serialize for Histogram {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut keys: Vec<&String> = self.0.keys().collect();
        keys.sort_by(|a, b| index_of(a).cmp(&index_of(b)).then_with(|| a.cmp(b)));
        let mut map = s.serialize_map(Some(keys.len()))?;
        for key in keys {
            map.serialize_entry(key, &self.0[key])?;
        }
        map.end()
    }
}

/// A JS "array index" key as a sortable value: `Some(n)` for a canonical non-negative decimal,
/// `None` for everything else, and `None` sorts last because `Option`'s own `Ord` puts it there.
fn index_of(key: &str) -> Option<u64> {
    if key.len() > 1 && key.starts_with('0') {
        // "007" is not the canonical spelling of 7, so JS files it as an ordinary string key.
        return None;
    }
    key.parse::<u64>().ok()
}

impl ResistRowFile {
    /// One in-memory row, as it goes on disk.
    #[must_use]
    pub fn of(row: &ResistRow) -> Self {
        let spec = &row.spec;
        ResistRowFile {
            mob_key: spec.mob_key.clone(),
            zone: spec.zone.clone(),
            spell_key: spec.spell_key.clone(),
            family: match spec.family {
                Family::Cast => FamilyFile::Cast,
                Family::Song => FamilyFile::Song,
            },
            caster_kind: match spec.caster_kind {
                CasterKind::SelfCast => CasterKindFile::SelfCast,
                CasterKind::Pc => CasterKindFile::Pc,
                CasterKind::Npc => CasterKindFile::Npc,
            },
            caster_level: spec.caster_level,
            mob_level: spec.mob_level,
            mob_level_lo: spec.mob_level_lo,
            mob_level_hi: spec.mob_level_hi,
            debuffs: spec.debuffs.clone(),
            rank: spec.rank,
            overchannel: spec.overchannel,
            caster_classes: spec.caster_classes,
            week: spec.week.clone(),
            resist: row.resist,
            land: row.land,
            dmg: Histogram(row.dmg.clone()),
            variable: if row.variable { Some(true) } else { None },
            first_ts: row.first_ts,
            last_ts: row.last_ts,
        }
    }

    /// …and back. Total, with no failure case: every field is either required by the deserializer
    /// or optional in the app's own type, so a row that parsed is a row that folds.
    #[must_use]
    pub fn into_row(self) -> ResistRow {
        ResistRow {
            spec: RowSpec {
                mob_key: self.mob_key,
                zone: self.zone,
                spell_key: self.spell_key,
                family: match self.family {
                    FamilyFile::Cast => Family::Cast,
                    FamilyFile::Song => Family::Song,
                },
                caster_kind: match self.caster_kind {
                    CasterKindFile::SelfCast => CasterKind::SelfCast,
                    CasterKindFile::Pc => CasterKind::Pc,
                    CasterKindFile::Npc => CasterKind::Npc,
                },
                caster_level: self.caster_level,
                mob_level: self.mob_level,
                mob_level_lo: self.mob_level_lo,
                mob_level_hi: self.mob_level_hi,
                debuffs: self.debuffs,
                rank: self.rank,
                overchannel: self.overchannel,
                caster_classes: self.caster_classes,
                week: self.week,
            },
            resist: self.resist,
            land: self.land,
            dmg: self.dmg.0,
            variable: self.variable == Some(true),
            first_ts: self.first_ts,
            last_ts: self.last_ts,
        }
    }
}

/// What a read of the file produced, and anything about it worth a line on the diagnostics stream.
#[derive(Debug, Default)]
pub struct LedgerLoad {
    pub sources: Vec<LedgerSource>,
    /// One sentence for stderr. Absent means an ordinary read with nothing to say.
    pub notice: Option<String>,
}

/// The read rules, in order. Every one answers with buckets rather than an error: this never fails.
///
///   1. Not valid JSON: empty. (The app's three salvage tiers are the named residual above.)
///   2. Wrong version: empty, and silent — a planned discard, not an incident.
///   3. A source is usable iff its `key` is a string that is not `baseline` and its `rows` is an
///      array.
///
/// A source whose rows will not parse is dropped whole. A bucket is the right unit: buckets are
/// independent and each is re-derivable by re-folding that character's log, whereas a half bucket
/// is an under-count that looks exactly like a fact.
#[must_use]
pub fn read_ledger(text: &str) -> LedgerLoad {
    let Ok(doc) = serde_json::from_str::<serde_json::Value>(text) else {
        return LedgerLoad {
            sources: Vec::new(),
            notice: Some("resist-ledger.json is not valid JSON; starting empty".to_owned()),
        };
    };
    if doc.get("version").and_then(serde_json::Value::as_i64) != Some(RESIST_LEDGER_VERSION) {
        return LedgerLoad::default();
    }
    let Some(raw) = doc.get("sources").and_then(serde_json::Value::as_array) else {
        return LedgerLoad::default();
    };
    let mut sources = Vec::new();
    let mut dropped = 0usize;
    for entry in raw {
        let key = entry.get("key").and_then(serde_json::Value::as_str);
        let Some(key) = key else { continue };
        if key == BASELINE_SOURCE_KEY {
            continue;
        }
        if !entry.get("rows").is_some_and(serde_json::Value::is_array) {
            continue;
        }
        match serde_json::from_value::<LedgerSource>(entry.clone()) {
            Ok(source) => sources.push(source),
            Err(_) => dropped += 1,
        }
    }
    let notice = (dropped > 0).then(|| {
        format!("resist-ledger.json: {dropped} character bucket(s) held rows this build cannot read and were dropped")
    });
    LedgerLoad { sources, notice }
}

/// The write rules:
///
///   * the shipped baseline's bucket is never written,
///   * a bucket with no rows is never written (an empty `{key, rows: []}` claims nothing),
///   * source keys ascending, rows within a bucket by pooling key ascending — byte-stable, so an
///     unchanged ledger serializes to the same bytes twice and the coalescing write can decline.
#[must_use]
pub fn ledger_file_of(store: &ResistLedgerStore) -> UserLedgerFile {
    let mut sources = Vec::new();
    for key in store.source_keys() {
        if key == BASELINE_SOURCE_KEY {
            continue;
        }
        let Some(bucket) = store.bucket(key) else {
            continue;
        };
        if bucket.is_empty() {
            continue;
        }
        sources.push(LedgerSource {
            key: key.to_owned(),
            rows: bucket
                .rows_in_key_order()
                .into_iter()
                .map(ResistRowFile::of)
                .collect(),
        });
    }
    UserLedgerFile {
        version: RESIST_LEDGER_VERSION,
        sources,
    }
}

/// Seed a store from what a read found. `read_ledger` has already rejected the baseline, so this
/// does not re-check for it.
///
/// It does not call `begin_source`: seeding puts every persisted bucket back, and the fold's own
/// source is discarded afterwards by the one call that names it. Doing both here would either
/// discard a bucket before it was seeded or seed a bucket the fold is about to double.
pub fn seed_store(store: &mut ResistLedgerStore, sources: &[LedgerSource]) {
    for source in sources {
        let bucket: &mut ResistBucket = store.bucket_mut(&source.key);
        for row in &source.rows {
            bucket.seed_row(row.clone().into_row());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A hand-written fixture in the app's exact shape, so every format claim is checked against
    /// these bytes rather than against another serializer.
    const APP_FILE: &str = concat!(
        r#"{"version":3,"sources":["#,
        r#"{"key":"baseline","rows":[{"mobKey":"a rat","spellKey":"shock of frost","family":"cast","casterKind":"self","casterLevel":null,"mobLevel":null,"debuffs":"","rank":0,"overchannel":false,"resist":9,"land":9,"dmg":{},"firstTs":0,"lastTs":0}]},"#,
        r#"{"key":"primitive_freeport","rows":["#,
        r#"{"mobKey":"a rat","zone":"Innothule Swamp","spellKey":"malosi","family":"cast","casterKind":"self","casterLevel":51,"mobLevel":20,"mobLevelLo":18,"mobLevelHi":22,"debuffs":"","rank":2,"overchannel":true,"casterClasses":3,"week":"2026-W34","resist":4,"land":7,"dmg":{"9":2,"10":5},"firstTs":1000,"lastTs":2000},"#,
        r#"{"mobKey":"a bat","spellKey":"chant of frost","family":"song","casterKind":"npc","casterLevel":null,"mobLevel":null,"debuffs":"","rank":0,"overchannel":null,"week":"2026-W34","resist":1,"land":0,"dmg":{},"variable":true,"firstTs":5,"lastTs":6}"#,
        r#"]}]}"#
    );

    fn primitive(load: &LedgerLoad) -> &LedgerSource {
        load.sources
            .iter()
            .find(|s| s.key == "primitive_freeport")
            .expect("the user's own bucket")
    }

    #[test]
    fn the_apps_own_bytes_read_and_the_baseline_bucket_is_refused() {
        let load = read_ledger(APP_FILE);
        assert!(load.notice.is_none(), "an ordinary read says nothing");
        // One source: `baseline` was rejected on read.
        assert_eq!(load.sources.len(), 1);
        let src = primitive(&load);
        assert_eq!(src.rows.len(), 2);
        assert_eq!(src.rows[0].mob_key, "a rat");
        assert_eq!(src.rows[0].zone.as_deref(), Some("Innothule Swamp"));
        assert_eq!(src.rows[0].caster_kind, CasterKindFile::SelfCast);
        assert_eq!(src.rows[0].overchannel, Some(true));
        assert_eq!(src.rows[0].caster_classes, Some(3));
        assert_eq!(src.rows[0].dmg.0.get("10"), Some(&5));
        assert_eq!(src.rows[1].family, FamilyFile::Song);
        assert_eq!(src.rows[1].caster_kind, CasterKindFile::Npc);
        assert_eq!(src.rows[1].overchannel, None);
        assert_eq!(src.rows[1].variable, Some(true));
    }

    #[test]
    fn a_row_survives_the_round_trip_through_the_fold_shape_byte_for_byte() {
        let load = read_ledger(APP_FILE);
        let row = primitive(&load).rows[0].clone();
        let before = serde_json::to_string(&row).expect("a row serializes");
        let after = serde_json::to_string(&ResistRowFile::of(&row.into_row()))
            .expect("the round-tripped row serializes");
        assert_eq!(before, after);
        // …and the bytes are the app's own: `null` for the three nullable fields, absent for the
        // optional ones the row does not carry.
        assert_eq!(
            before,
            r#"{"mobKey":"a rat","zone":"Innothule Swamp","spellKey":"malosi","family":"cast","casterKind":"self","casterLevel":51,"mobLevel":20,"mobLevelLo":18,"mobLevelHi":22,"debuffs":"","rank":2,"overchannel":true,"casterClasses":3,"week":"2026-W34","resist":4,"land":7,"dmg":{"9":2,"10":5},"firstTs":1000,"lastTs":2000}"#
        );
    }

    #[test]
    fn the_histogram_writes_in_numeric_order_not_lexicographic() {
        let mut dmg = HashMap::new();
        for n in [10, 9, 100, 2] {
            dmg.insert(n.to_string(), 1i64);
        }
        let text = serde_json::to_string(&Histogram(dmg)).expect("a histogram serializes");
        assert_eq!(text, r#"{"2":1,"9":1,"10":1,"100":1}"#);
    }

    #[test]
    fn a_missing_or_corrupt_or_stale_file_reads_as_empty() {
        assert!(read_ledger("").sources.is_empty());
        assert!(read_ledger("{\"version\":3,\"sources\":[")
            .sources
            .is_empty());
        assert!(read_ledger("{\"version\":3,\"sources\":[").notice.is_some());
        // A version this build does not speak: empty, and silent — a planned discard.
        let stale = read_ledger(r#"{"version":2,"sources":[{"key":"a","rows":[]}]}"#);
        assert!(stale.sources.is_empty());
        assert!(stale.notice.is_none());
        // Parsed, ours, but the source is not a shape we can seed from.
        assert!(
            read_ledger(r#"{"version":3,"sources":[{"key":"a","rows":{}}]}"#)
                .sources
                .is_empty()
        );
    }

    #[test]
    fn a_bucket_whose_rows_will_not_parse_is_dropped_whole_and_says_so() {
        let load = read_ledger(
            r#"{"version":3,"sources":[{"key":"a","rows":[{"mobKey":"x"}]},{"key":"b","rows":[]}]}"#,
        );
        assert_eq!(load.sources.len(), 1);
        assert_eq!(load.sources[0].key, "b");
        assert!(load.notice.is_some());
    }

    #[test]
    fn the_write_drops_the_baseline_and_the_empties_and_sorts_both_levels() {
        let load = read_ledger(APP_FILE);
        let mut store = ResistLedgerStore::new();
        seed_store(&mut store, &load.sources);
        // A baseline bucket and an empty bucket, both deliberate: neither may be written.
        seed_store(
            &mut store,
            &[LedgerSource {
                key: BASELINE_SOURCE_KEY.to_owned(),
                rows: vec![primitive(&load).rows[0].clone()],
            }],
        );
        store.bucket_mut("zzz_empty");
        // …and a second real bucket whose key sorts BEFORE the first, so the sort is proven to
        // reorder rather than merely to preserve.
        seed_store(
            &mut store,
            &[LedgerSource {
                key: "aardvark_bertox".to_owned(),
                rows: vec![primitive(&load).rows[1].clone()],
            }],
        );

        let file = ledger_file_of(&store);
        assert_eq!(file.version, 3);
        let keys: Vec<&str> = file.sources.iter().map(|s| s.key.as_str()).collect();
        assert_eq!(keys, vec!["aardvark_bertox", "primitive_freeport"]);
        // Rows by pooling key ascending, which reverses the order the fixture listed them in.
        let rows = &file.sources[1].rows;
        assert_eq!(rows[0].mob_key, "a bat");
        assert_eq!(rows[1].mob_key, "a rat");

        // `version` first — the app's truncation salvage reads it off the head of a file it cannot
        // parse, so this is a compatibility assertion and not a cosmetic one.
        let text = serde_json::to_string(&file).expect("the file serializes");
        assert!(
            text.starts_with(r#"{"version":3,"sources":[{"key":"#),
            "{text}"
        );
    }

    #[test]
    fn seeding_the_same_bucket_twice_replaces_its_rows_rather_than_doubling_them() {
        let load = read_ledger(APP_FILE);
        let mut store = ResistLedgerStore::new();
        seed_store(&mut store, &load.sources);
        let (rows_once, _) = store.counts();
        // A second seed of the same bytes, which is the shape a cold launch has. Rows are keyed by
        // their pooling key, so they land on themselves.
        seed_store(&mut store, &load.sources);
        assert_eq!(store.counts().0, rows_once);
        assert_eq!(rows_once, 2);
    }

    #[test]
    fn begin_source_discards_the_seeded_bucket_so_a_re_fold_replaces_it() {
        let load = read_ledger(APP_FILE);
        let mut store = ResistLedgerStore::new();
        seed_store(&mut store, &load.sources);
        assert_eq!(store.counts().0, 2);
        // The character about to be folded has its bucket discarded before a byte is read, because
        // the fold is about to state that bucket's whole content again.
        store.begin_source("primitive_freeport");
        assert_eq!(store.counts().0, 0);
        // …and a bucket for a character we are NOT folding is untouched, because nothing can
        // re-derive it.
        seed_store(
            &mut store,
            &[LedgerSource {
                key: "other_bertox".to_owned(),
                rows: vec![primitive(&load).rows[0].clone()],
            }],
        );
        store.begin_source("primitive_freeport");
        assert_eq!(store.counts().0, 1);
    }
}
