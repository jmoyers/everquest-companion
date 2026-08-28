//! `<userData>/message-overlay.json` — the user's register, read and written verbatim. The pure
//! half; `engined::state` owns the directory and the disk.
//!
//! The format is inherited, not negotiated: the app writes this file too, and a user who turns the
//! engine off must not lose what their logs have taught this install.
//!
//! ```text
//! {"version":2,"updatedAt":"<ISO8601>","sources":[{"key":…,"messages":[…]}]}
//! ```
//!
//! It is a register, not a snapshot. Counts are stored per source, keyed by the character whose log
//! produced them, so re-folding a log replaces that log's bucket instead of adding to it — a flat
//! pile of counts doubles on every launch. No verdict is stored: a stored verdict is a second
//! opinion waiting to disagree with the derived one.
//!
//! The committed baseline is filed under its own key and deliberately not written back — it is
//! re-seeded from the bundle every launch, so a copy in userData would only be a staler one. It is
//! filtered on the way in and on the way out.
//!
//! Three separate ordering claims: `sources` in insertion order and not sorted (the resist ledger
//! does sort its sources; the difference is inherited from two app writers), `messages` by
//! codepoint on `text`, and `spells` by codepoint on `spell`. Codepoint and never locale, because
//! `localeCompare` answers from ICU and varies with host locale and Node build; Rust's natural
//! `&str` `Ord` is that comparator already.
//!
//! `updatedAt` is the log's clock, never a wall clock, so a re-fold of unchanged bytes writes an
//! unchanged file — which is what lets the write be coalesced at all.

use serde::{Deserialize, Serialize};

use crate::message_overlay::{role_of, OverlayRegister, OverlaySourceCounts, SeedMessage};

/// `overlayPersistence.ts OVERLAY_REGISTER_VERSION`. Anything else reads as empty, including every
/// v1 file in the field, whose counts carry the inflation v2 fixes.
pub const OVERLAY_REGISTER_VERSION: i64 = 2;

/// The persisted file: the register plus its schema version, in the app's key order.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayRegisterFile {
    pub version: i64,
    pub updated_at: String,
    pub sources: Vec<OverlaySourceCounts>,
}

/// One read rule with no tiers: every failure — missing, unparseable, stale-version, wrong shape —
/// answers with no sources. Then the committed baseline's bucket and any source whose `messages` is
/// not an array are filtered out.
///
/// No salvage and no quarantine, unlike the resist ledger: the overlay is a nicety rather than
/// required state, and the active character's log re-mines itself on the next fold.
#[must_use]
pub fn read_register(text: &str) -> Vec<OverlaySourceCounts> {
    let Ok(doc) = serde_json::from_str::<serde_json::Value>(text) else {
        return Vec::new();
    };
    if doc.get("version").and_then(serde_json::Value::as_i64) != Some(OVERLAY_REGISTER_VERSION) {
        return Vec::new();
    }
    let Some(raw) = doc.get("sources").and_then(serde_json::Value::as_array) else {
        return Vec::new();
    };
    raw.iter()
        .filter(|entry| {
            entry.get("key").and_then(serde_json::Value::as_str)
                != Some(crate::message_overlay::BASELINE_SOURCE)
                && entry
                    .get("messages")
                    .is_some_and(serde_json::Value::is_array)
        })
        .filter_map(|entry| serde_json::from_value::<OverlaySourceCounts>(entry.clone()).ok())
        .collect()
}

/// The write rule: the version, the register's own `updatedAt`, and every bucket except the
/// committed baseline's, in the register's own order.
#[must_use]
pub fn register_file_of(register: OverlayRegister) -> OverlayRegisterFile {
    OverlayRegisterFile {
        version: OVERLAY_REGISTER_VERSION,
        updated_at: register.updated_at,
        sources: register
            .sources
            .into_iter()
            .filter(|s| s.key != crate::message_overlay::BASELINE_SOURCE)
            .collect(),
    }
}

/// One persisted bucket as the miner's `merge` wants it: the source key, and the counts filed under
/// it. The key travels with the counts, because merging two origins under one key would leave
/// `begin_source` able to replace only both or neither.
#[must_use]
pub fn seeds_of(sources: Vec<OverlaySourceCounts>) -> Vec<(String, Vec<SeedMessage>)> {
    sources
        .into_iter()
        .map(|source| {
            let counts = source
                .messages
                .into_iter()
                .map(|m| {
                    (
                        m.text,
                        role_of(&m.role),
                        m.spells.into_iter().map(|s| (s.spell, s.count)).collect(),
                    )
                })
                .collect();
            (source.key, counts)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::message_overlay::MessageOverlayMiner;
    use crate::spell_facts::SpellFacts;

    /// A hand-written fixture in the app's exact shape, baseline bucket included.
    const APP_FILE: &str = concat!(
        r#"{"version":2,"updatedAt":"2026-08-19T16:21:54.000Z","sources":["#,
        r#"{"key":"baseline","messages":[{"text":"You feel different.","role":"landing","spells":[{"spell":"Illusion: Gnome","count":9}]}]},"#,
        r#"{"key":"primitive_freeport","messages":["#,
        r#"{"text":"You feel much faster.","role":"landing","spells":[{"spell":"Alacrity","count":3},{"spell":"Swift Like the Wind","count":1}]},"#,
        r#"{"text":"Your Alacrity spell has worn off.","role":"wearsOff","spells":[{"spell":"Alacrity","count":2}]}"#,
        r#"]}]}"#
    );

    fn miner() -> MessageOverlayMiner {
        MessageOverlayMiner::new(SpellFacts::default())
    }

    #[test]
    fn the_apps_own_bytes_read_and_the_baseline_bucket_is_refused() {
        let sources = read_register(APP_FILE);
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].key, "primitive_freeport");
        assert_eq!(sources[0].messages.len(), 2);
        assert_eq!(sources[0].messages[0].role, "landing");
        assert_eq!(sources[0].messages[1].role, "wearsOff");
        assert_eq!(
            sources[0].messages[0].spells[1].spell,
            "Swift Like the Wind"
        );
    }

    #[test]
    fn a_missing_or_corrupt_or_stale_or_misshapen_file_reads_as_empty() {
        assert!(read_register("").is_empty());
        assert!(read_register("{oh no").is_empty());
        assert!(read_register(
            r#"{"version":1,"updatedAt":"x","sources":[{"key":"a","messages":[]}]}"#
        )
        .is_empty());
        assert!(read_register(r#"{"version":2,"updatedAt":"x"}"#).is_empty());
        assert!(read_register(
            r#"{"version":2,"updatedAt":"x","sources":[{"key":"a","messages":{}}]}"#
        )
        .is_empty());
    }

    #[test]
    fn a_seeded_register_is_written_back_byte_for_byte() {
        let mut miner = miner();
        for (key, counts) in seeds_of(read_register(APP_FILE)) {
            miner.merge(&counts, &key);
        }
        // The miner has no observations, only merged counts, and a merge carries no instants, so
        // `updatedAt` is the epoch here. The file writer takes whichever stamp the register states.
        let mut register = miner.register();
        register.updated_at = "2026-08-19T16:21:54.000Z".to_owned();
        let text = serde_json::to_string(&register_file_of(register)).expect("it serializes");
        assert_eq!(
            text,
            concat!(
                r#"{"version":2,"updatedAt":"2026-08-19T16:21:54.000Z","sources":["#,
                r#"{"key":"primitive_freeport","messages":["#,
                r#"{"text":"You feel much faster.","role":"landing","spells":[{"spell":"Alacrity","count":3},{"spell":"Swift Like the Wind","count":1}]},"#,
                r#"{"text":"Your Alacrity spell has worn off.","role":"wearsOff","spells":[{"spell":"Alacrity","count":2}]}"#,
                r#"]}]}"#
            )
        );
    }

    #[test]
    fn messages_and_spells_are_sorted_by_codepoint_and_sources_are_not() {
        let mut miner = miner();
        // Two buckets, merged in an order that is not alphabetical, each holding messages and
        // spells that are not in codepoint order.
        miner.merge(
            &[(
                "zeta".to_owned(),
                "landing",
                vec![("Zephyr".to_owned(), 1), ("Alacrity".to_owned(), 2)],
            )],
            "zzz_source",
        );
        miner.merge(
            &[
                ("beta".to_owned(), "landing", vec![("B".to_owned(), 1)]),
                ("alpha".to_owned(), "landing", vec![("A".to_owned(), 1)]),
            ],
            "aaa_source",
        );
        let register = miner.register();
        // Sources in insertion order: `zzz_source` was merged first and comes first, which is the
        // opposite of what a sort would give.
        let keys: Vec<&str> = register.sources.iter().map(|s| s.key.as_str()).collect();
        assert_eq!(keys, vec!["zzz_source", "aaa_source"]);
        // …and messages sorted, which is the opposite of the order they were merged in.
        let texts: Vec<&str> = register.sources[1]
            .messages
            .iter()
            .map(|m| m.text.as_str())
            .collect();
        assert_eq!(texts, vec!["alpha", "beta"]);
        // …and spells sorted within a message, likewise reversed from the merge order.
        let spells: Vec<&str> = register.sources[0].messages[0]
            .spells
            .iter()
            .map(|s| s.spell.as_str())
            .collect();
        assert_eq!(spells, vec!["Alacrity", "Zephyr"]);
    }

    #[test]
    fn begin_source_makes_a_re_fold_replace_a_seeded_bucket_rather_than_double_it() {
        let mut fresh = miner();
        for (key, counts) in seeds_of(read_register(APP_FILE)) {
            fresh.merge(&counts, &key);
        }
        let seeded = fresh.register();
        let before = seeded.sources[0].messages[0].spells[0].count;
        assert_eq!(before, 3);

        // The cold-launch shape: seed from the file the last run wrote, then fold the same log
        // again. Without `begin_source` the counts double; with it, the bucket is re-stated.
        let mut again = miner();
        for (key, counts) in seeds_of(read_register(APP_FILE)) {
            again.merge(&counts, &key);
        }
        again.begin_source("primitive_freeport");
        // The re-fold re-states three of the same observation.
        for ts in [1i64, 2, 3] {
            again.observe_cast("Alacrity", ts * 10_000);
            again.observe_message("You feel much faster.", ts * 10_000 + 1, "landing");
        }
        let after = again.register();
        let bucket = after
            .sources
            .iter()
            .find(|s| s.key == "primitive_freeport")
            .expect("the re-folded bucket");
        assert_eq!(
            bucket.messages.len(),
            1,
            "the wears-off count was discarded with the bucket, and the log re-states it"
        );
        assert_eq!(bucket.messages[0].spells.len(), 1);
        assert_eq!(bucket.messages[0].spells[0].count, 3, "replaced, not 3 + 3");
    }

    #[test]
    fn the_write_drops_the_baseline_bucket() {
        let mut miner = miner();
        miner.merge(
            &[("x".to_owned(), "landing", vec![("Y".to_owned(), 1)])],
            crate::message_overlay::BASELINE_SOURCE,
        );
        miner.merge(
            &[("x".to_owned(), "landing", vec![("Y".to_owned(), 1)])],
            "mine_freeport",
        );
        let file = register_file_of(miner.register());
        let keys: Vec<&str> = file.sources.iter().map(|s| s.key.as_str()).collect();
        assert_eq!(keys, vec!["mine_freeport"]);
    }
}
