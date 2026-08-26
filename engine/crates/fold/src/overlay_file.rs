//! `<userData>/message-overlay.json` — THE USER'S REGISTER, READ AND WRITTEN VERBATIM (JOS-496
//! item 3, boundary verdict 4 / cutover ledger item 6). The pure half; `engined::state` owns the
//! directory and the disk.
//!
//! It mirrors `src/main/data/overlayPersistence.ts` and the `register()` half of
//! `src/main/data/messageOverlay.ts`. The format is inherited, not negotiated — the app writes this
//! file today, the engine writes it under the flag, and a user who turns the flag off must not lose
//! what their logs have taught this install:
//!
//! ```text
//! {"version":2,"updatedAt":"<ISO8601>","sources":[{"key":…,"messages":[…]}]}
//! ```
//!
//! ── IT IS A REGISTER, NOT A SNAPSHOT, AND VERSION 2 IS WHY (JOS-231) ───────────────────────────
//!
//! Version 1 was the SERVED view — counts and verdicts together — and seeding the next launch's
//! miner from it fed the fold its own previous output. The app re-mines the whole log every launch,
//! so every count the log accounted for doubled per launch: MEASURED 22 → 44 → 88. The file stores
//! counts PER SOURCE now, keyed by the character whose log produced them, so re-folding a log
//! REPLACES that log's bucket instead of adding to it. No verdict is stored at all — a stored
//! verdict is a second opinion waiting to disagree with the derived one.
//!
//! The committed baseline is filed under its own key and deliberately NOT written back: it is
//! re-seeded from the bundle on every launch, and copying 400 kB of it into userData would only
//! create a second, staler copy. It is filtered on the way in AND on the way out.
//!
//! ── THREE ORDERING CLAIMS, AND THEY ARE NOT THE SAME CLAIM ─────────────────────────────────────
//!
//!   * `sources` is in INSERTION order and is NOT sorted — `register()` walks `this.sources`, a JS
//!     `Map`, and a `Map` iterates in insertion order. That differs from the resist ledger, which
//!     DOES sort its sources, and the difference is inherited rather than chosen: two files, two
//!     app writers, and matching each one is the whole job.
//!   * `messages` within a bucket is sorted by CODEPOINT on `text`.
//!   * `spells` within a message is sorted by CODEPOINT on `spell`.
//!
//! Codepoint, not locale. `String.prototype.localeCompare` answers from ICU — its order is a
//! function of the host's locale and of the ICU data the Node build shipped with — so the TS was
//! moved off it explicitly "because the engine this ordering will one day be checked against
//! compares Rust `str`s — UTF-8 bytewise, which is exactly codepoint order". Rust's natural `Ord`
//! on `&str` IS that comparator, so nothing is ported here; the claim is simply relied upon, and
//! `message_overlay.rs`'s header is where it is written down.
//!
//! ── `updatedAt` IS THE LOG'S CLOCK ─────────────────────────────────────────────────────────────
//!
//! `new Date(this.lastObservedTs).toISOString()`, never `new Date()`. That was a wall-clock read
//! inside a published fold, found by folding identical bytes twice and diffing (JOS-208): two runs
//! milliseconds apart disagreed on every fixture over a field describing neither. Here it comes off
//! [`crate::message_overlay::MessageOverlayMiner::register`], which reads the miner's own newest
//! observed instant, so a re-fold of unchanged bytes writes an unchanged file — which is also what
//! lets the write be coalesced at all.

use serde::{Deserialize, Serialize};

use crate::message_overlay::{role_of, OverlayRegister, OverlaySourceCounts, SeedMessage};

/// `overlayPersistence.ts OVERLAY_REGISTER_VERSION`. Anything else reads as EMPTY — including
/// every v1 file in the field, whose counts carry exactly the inflation v2 fixes.
pub const OVERLAY_REGISTER_VERSION: i64 = 2;

/// The persisted file: the register plus its schema version, in the app's key order.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayRegisterFile {
    pub version: i64,
    pub updated_at: String,
    pub sources: Vec<OverlaySourceCounts>,
}

/// THE READ RULE, and it is ONE rule with no tiers: `loadUserSources` wraps the whole read in a
/// `try` and answers `[]` for every failure — missing, unparseable, stale-version, wrong shape.
/// Then it filters out the committed baseline's bucket and any source whose `messages` is not an
/// array.
///
/// NO SALVAGE AND NO QUARANTINE, and unlike the resist ledger that is not a residual — the app has
/// none either. The overlay is a nicety, not required state, and the active character's log
/// re-mines itself honestly on the next fold.
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

/// THE WRITE RULE — `overlayFile(register)`: the version, the register's own `updatedAt`, and every
/// bucket EXCEPT the committed baseline's, in the register's own order.
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

/// One persisted bucket as the miner's `merge` wants it: the source key, and the counts filed
/// under it. THE KEY TRAVELS WITH THE COUNTS — merging two origins under one key is the JOS-231
/// defect, because `begin_source` could then only replace both or neither.
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

    /// A hand-written fixture in the app's EXACT shape, baseline bucket included.
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
        // The miner has no OBSERVATIONS, only merged counts — and a merge carries counts and no
        // instants, so `updatedAt` is the epoch here. The register the app persists carries its own
        // stamp; the file writer below takes whichever the register states.
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
        // Two buckets, merged in an order that is NOT alphabetical, each holding messages and
        // spells that are NOT in codepoint order.
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
        // SOURCES IN INSERTION ORDER — `zzz_source` was merged first and comes first, which is the
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

        // THE COLD-LAUNCH SHAPE, and the whole of JOS-231: seed from the file the last run wrote,
        // then fold the same log again. Without `begin_source` the counts DOUBLE (22 → 44 → 88 was
        // the measurement); with it, the bucket is discarded and re-stated.
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
