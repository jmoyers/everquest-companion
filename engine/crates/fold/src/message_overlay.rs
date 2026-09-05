//! `src/main/data/messageOverlay.ts` — the observed-message overlay, mined as the log folds.
//!
//! As the buffs model folds the log, every player cast (`observe_cast`) and every candidate message
//! line (`observe_message`) is fed here. The overlay counts the association between a message and
//! the spell being cast when it appeared, keyed by (messageText, spellKey), and derives a
//! per-message verdict:
//!
//!   verified         — the message consistently follows exactly one spell (n >= 2), so seeing it
//!                      proves that spell landed.
//!   shared           — the message follows several spells ("You feel different." for every
//!                      illusion), so it cannot name one on its own; resolution needs cast history.
//!   contradicts-wiki — the observed pairing differs from spells.json's `msg_*`. The wiki is
//!                      known-wrong in places: Symbol of Pinzarn's real landing route is a heal
//!                      line, not its listed message.
//!   unknown          — too few observations to judge.
//!
//! A message is associated with a cast only when exactly one distinct spell was cast in the window.
//! During a buff burst or heavy combat several casts share it and no message can honestly be
//! attributed to any of them, so the observation is skipped.
//!
//! Every count is filed under the source that produced it, one bucket per origin: `merge` files an
//! import under its key, `begin_source(key)` discards that key's bucket and points subsequent
//! observations at it, and `build` sums the buckets. That is what makes a re-fold replace a log's
//! contribution instead of adding to it — a flat pile doubles the counts on every cold launch.
//!
//! Which bucket this fold writes into is unobservable in the snapshot: `build()` aggregates every
//! bucket, and only `register()` — the persistence view, which no snapshot carries — tells them
//! apart.
//!
//! Sorting is by codepoint order everywhere, never `localeCompare`, whose ICU answer varies with
//! host locale and Node build. Rust's natural `Ord` on `&str` is UTF-8 bytewise, which is exactly
//! codepoint order, so the comparator is the language's.

use crate::jsmap::JsMap;
use crate::spell_facts::{message_matches_other_suffix, SpellFacts};
use eqlog::names::db_canon_key;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Overlay schema version — bump to invalidate a stale on-disk snapshot.
pub const OVERLAY_VERSION: i64 = 1;

/// `OverlayCounts` — what a seed carries: a message's text, its role, and per-spell counts. A
/// verdict is never imported; it is derived, every time, from the summed buckets.
pub type SeedMessage = (String, &'static str, Vec<(String, i64)>);

/// The bucket observations land in when nobody named a source.
pub const DEFAULT_SOURCE: &str = "log";

/// The bucket the committed baseline's counts are filed under. Never a character id — a real one is
/// `<Name>@<server>`.
pub const BASELINE_SOURCE: &str = "baseline";

/// How long after a cast a message line is attributed to it. Mirrors the landing window.
const ASSOCIATION_WINDOW_MS: i64 = 6_000;

/// Minimum observations before a message earns a verdict other than unknown.
const MIN_OBSERVATIONS: i64 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum Verdict {
    #[serde(rename = "contradicts-wiki")]
    Contradicts,
    Verified,
    Shared,
    Unknown,
}

impl Verdict {
    /// Densest / most-informative first: contradictions, then verified, then shared, then unknown.
    fn rank(self) -> u8 {
        match self {
            Verdict::Contradicts => 0,
            Verdict::Verified => 1,
            Verdict::Shared => 2,
            Verdict::Unknown => 3,
        }
    }
}

/// A pending cast the overlay may still associate messages with.
struct RecentCast {
    spell_key: String,
    spell_display: String,
    ts: i64,
}

/// Accumulated per-message association counts. `by_spell` is keyed by canonical spell key, and its
/// insertion order is load-bearing: `verdict_for` reads the first entry unsorted and `aggregate`
/// walks it.
#[derive(Clone)]
struct MessageRecord {
    text: String,
    role: &'static str,
    by_spell: JsMap<SpellCount>,
}

#[derive(Clone)]
struct SpellCount {
    display: String,
    count: i64,
}

/// One message as `build()` publishes it. `wikiConflict` is omitted rather than null for all but
/// the contradictions.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OverlayMessage {
    text: String,
    role: &'static str,
    verdict: Verdict,
    spells: Vec<PublishedSpell>,
    total: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    wiki_conflict: Option<WikiConflict>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PublishedSpell {
    spell: String,
    count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WikiConflict {
    spell: String,
    wiki_text: String,
}

// The persistence view: `register()` and the shapes it answers in. `build()` publishes the served
// overlay — every bucket summed, every verdict derived, no source key — while `register()`
// publishes raw counts filed under the source that produced them, with no verdict. The key is the
// only thing that lets `begin_source` replace a bucket instead of adding to it. A stored verdict
// would be a second opinion waiting to disagree with the derived one, and would need recomputing
// whenever the catalog moved.

/// One message's raw counts, as the register files them.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OverlayMessageCounts {
    pub text: String,
    /// `'landing' | 'wearsOff'`. A `String` rather than the `&'static str` the miner holds because
    /// this shape also reads the app's file, and a borrowed lifetime cannot come off one.
    pub role: String,
    pub spells: Vec<OverlaySpellCount>,
}

/// One spell's count under a message. The display name, never the canon key: the key is derivable
/// from the name and not the reverse, so the file keeps the one that carries more (`add_counts`
/// re-canonicalizes on the way back in).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OverlaySpellCount {
    pub spell: String,
    pub count: i64,
}

/// One source's bucket — `OverlaySourceCounts`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OverlaySourceCounts {
    /// Which origin produced these counts: a character id, or the committed baseline's key.
    pub key: String,
    pub messages: Vec<OverlayMessageCounts>,
}

/// The whole register: every bucket, plus the log instant the miner has observed through.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayRegister {
    pub updated_at: String,
    pub sources: Vec<OverlaySourceCounts>,
}

/// The mining accumulator + verdict derivation. Dependency-free and pure over its inputs, so it
/// runs identically in a replay-only generator script and in the live module.
pub struct MessageOverlayMiner {
    /// sourceKey → (messageText → record). Insertion order is merge order then fold order, and
    /// every serialization sorts, so two runs over the same inputs produce identical output.
    sources: JsMap<JsMap<MessageRecord>>,
    /// Which bucket `observe_message` writes into — the log currently being folded.
    current: String,
    /// The most-recent cast(s) still inside the association window (newest last).
    recent_casts: Vec<RecentCast>,
    /// The newest log instant this miner has observed, and the overlay's `updatedAt`. Never a wall
    /// clock: it is a statement about the observations the overlay is made of, so two folds of the
    /// same bytes agree. Zero before the first observation — a merged baseline carries counts and
    /// no instants, so it does not move this.
    last_observed_ts: i64,
    /// The catalog, for contradiction detection only. An empty one is the TS's absent `db?.byKey`.
    facts: SpellFacts,
}

impl MessageOverlayMiner {
    pub fn new(facts: SpellFacts) -> Self {
        MessageOverlayMiner {
            sources: JsMap::new(),
            current: DEFAULT_SOURCE.to_string(),
            recent_casts: Vec::new(),
            last_observed_ts: 0,
            facts,
        }
    }

    fn bucket(&mut self, key: &str) -> &mut JsMap<MessageRecord> {
        if !self.sources.contains_key(key) {
            self.sources.insert(key.to_string(), JsMap::new());
        }
        self.sources.get_mut(key).expect("just inserted")
    }

    /// Start folding `key`'s log from the first byte. Whatever this source contributed before is
    /// discarded, because the fold that follows is about to state it again. Re-inserting keeps the
    /// existing key's position, so re-folding a seeded source does not reorder the register.
    pub fn begin_source(&mut self, key: &str) {
        self.sources.insert(key.to_string(), JsMap::new());
        self.current = key.to_string();
        self.recent_casts.clear();
    }

    /// Merge imported counts into one bucket, additive within that bucket. `source_key` is what
    /// `begin_source` needs in order to replace them when that origin is folded again — merging the
    /// baseline and a persisted character under one key would put the fold's own output back in the
    /// pile it is seeded from, and the counts would double.
    pub fn merge(&mut self, counts: &[SeedMessage], source_key: &str) {
        let into = self.bucket(source_key);
        for (text, role, spells) in counts {
            if !into.contains_key(text) {
                into.insert(
                    text.clone(),
                    MessageRecord {
                        text: text.clone(),
                        role,
                        by_spell: JsMap::new(),
                    },
                );
            }
            let rec = into.get_mut(text).expect("just inserted");
            add_counts(rec, spells);
        }
    }

    /// Record that the player began casting a spell (the association anchor).
    pub fn observe_cast(&mut self, spell_display: &str, ts: i64) {
        self.expire(ts);
        if ts > self.last_observed_ts {
            self.last_observed_ts = ts;
        }
        self.recent_casts.push(RecentCast {
            spell_key: db_canon_key(spell_display),
            spell_display: spell_display.to_string(),
            ts,
        });
    }

    /// Record a candidate message line and associate it with the recent cast, but only when the
    /// anchor is unambiguous: exactly one distinct spell cast in the window (a recast counts as
    /// one).
    pub fn observe_message(&mut self, text: &str, ts: i64, role: &'static str) {
        self.expire(ts);
        if ts > self.last_observed_ts {
            self.last_observed_ts = ts;
        }
        if self.recent_casts.is_empty() {
            return;
        }
        let first = &self.recent_casts[0].spell_key;
        if self.recent_casts.iter().any(|c| &c.spell_key != first) {
            return;
        }
        let cast = self.recent_casts.last().expect("non-empty");
        let (cast_key, cast_display) = (cast.spell_key.clone(), cast.spell_display.clone());
        let current = self.current.clone();
        let into = self.bucket(&current);
        if !into.contains_key(text) {
            into.insert(
                text.to_string(),
                MessageRecord {
                    text: text.to_string(),
                    role,
                    by_spell: JsMap::new(),
                },
            );
        }
        let rec = into.get_mut(text).expect("just inserted");
        match rec.by_spell.get_mut(&cast_key) {
            Some(s) => s.count += 1,
            None => rec.by_spell.insert(
                cast_key,
                SpellCount {
                    display: cast_display,
                    count: 1,
                },
            ),
        }
    }

    /// Drop casts that have aged out of the association window.
    fn expire(&mut self, now: i64) {
        if self.recent_casts.is_empty() {
            return;
        }
        self.recent_casts
            .retain(|c| now - c.ts <= ASSOCIATION_WINDOW_MS);
    }

    /// Every bucket's counts, sorted — what persistence writes and re-seeds from.
    ///
    /// Three separate ordering claims: `sources` in insertion order and deliberately unsorted,
    /// `messages` by codepoint on `text`, `spells` by codepoint on `spell`.
    ///
    /// `updatedAt` is the log's clock — see [`MessageOverlayMiner::last_observed_ts`].
    #[must_use]
    pub fn register(&self) -> OverlayRegister {
        let mut sources = Vec::with_capacity(self.sources.len());
        for (key, bucket) in self.sources.iter() {
            let mut messages: Vec<OverlayMessageCounts> = bucket
                .values()
                .map(|rec| {
                    let mut spells: Vec<OverlaySpellCount> = rec
                        .by_spell
                        .values()
                        .map(|s| OverlaySpellCount {
                            spell: s.display.clone(),
                            count: s.count,
                        })
                        .collect();
                    spells.sort_by(|a, b| a.spell.as_str().cmp(b.spell.as_str()));
                    OverlayMessageCounts {
                        text: rec.text.clone(),
                        role: rec.role.to_owned(),
                        spells,
                    }
                })
                .collect();
            messages.sort_by(|a, b| a.text.as_str().cmp(b.text.as_str()));
            sources.push(OverlaySourceCounts {
                key: key.to_owned(),
                messages,
            });
        }
        OverlayRegister {
            updated_at: iso_utc(self.last_observed_ts),
            sources,
        }
    }

    /// All buckets summed into one accumulator — the view every verdict is derived from.
    fn aggregate(&self) -> Vec<MessageRecord> {
        let mut out: JsMap<MessageRecord> = JsMap::new();
        for bucket in self.sources.values() {
            for rec in bucket.values() {
                if !out.contains_key(&rec.text) {
                    out.insert(
                        rec.text.clone(),
                        MessageRecord {
                            text: rec.text.clone(),
                            role: rec.role,
                            by_spell: JsMap::new(),
                        },
                    );
                }
                let agg = out.get_mut(&rec.text).expect("just inserted");
                let counts: Vec<(String, i64)> = rec
                    .by_spell
                    .values()
                    .map(|s| (s.display.clone(), s.count))
                    .collect();
                add_counts(agg, &counts);
            }
        }
        out.values().cloned().collect()
    }

    /// Derive a message's verdict from its per-spell counts + the DB (for contradictions).
    fn verdict_for(&self, rec: &MessageRecord, total: i64) -> (Verdict, Option<WikiConflict>) {
        if rec.by_spell.len() >= 2 {
            return (Verdict::Shared, None);
        }
        if total < MIN_OBSERVATIONS {
            return (Verdict::Unknown, None);
        }
        // Exactly one spell, seen >= 2x: verified, unless it contradicts the wiki's `msg_*`.
        let Some(only) = rec.by_spell.values().next() else {
            return (Verdict::Verified, None);
        };
        let Some(db_spell) = self.facts.get(&db_canon_key(&only.display)) else {
            return (Verdict::Verified, None);
        };
        if rec.role == "landing" {
            // A landing line can be the self form (`msg_cast_on_you`) or the on-other form (the
            // wiki's "Someone <suffix>", the log naming the target). Matching either is consistent
            // with the wiki; only a line matching neither, while the spell was unambiguously the
            // anchor, is a genuine wiki inaccuracy.
            if db_spell.msg_cast_on_you.as_deref() == Some(rec.text.as_str()) {
                return (Verdict::Verified, None);
            }
            if let Some(suffix) = &db_spell.msg_cast_on_other_suffix {
                if message_matches_other_suffix(&rec.text, suffix) {
                    return (Verdict::Verified, None);
                }
            }
            // The DB has a self message and a different self-shaped line was observed: a
            // contradiction. No self message at all: a newly verified landing message, a variation
            // the wiki omits.
            return match &db_spell.msg_cast_on_you {
                Some(you) => (
                    Verdict::Contradicts,
                    Some(WikiConflict {
                        spell: only.display.clone(),
                        wiki_text: you.clone(),
                    }),
                ),
                None => (Verdict::Verified, None),
            };
        }
        // The wears-off role.
        if let Some(wiki) = &db_spell.msg_wears_off {
            if wiki != &rec.text {
                return (
                    Verdict::Contradicts,
                    Some(WikiConflict {
                        spell: only.display.clone(),
                        wiki_text: wiki.clone(),
                    }),
                );
            }
        }
        (Verdict::Verified, None)
    }

    /// Build the served overlay from the current accumulator.
    pub fn build(&self) -> Value {
        let mut messages: Vec<OverlayMessage> = Vec::new();
        let (mut verified, mut shared, mut contradictions, mut unknown) = (0i64, 0i64, 0i64, 0i64);
        for rec in self.aggregate() {
            let mut spells: Vec<PublishedSpell> = rec
                .by_spell
                .values()
                .map(|s| PublishedSpell {
                    spell: s.display.clone(),
                    count: s.count,
                })
                .collect();
            // `b.count - a.count || byCodepoint(a.spell, b.spell)`.
            spells.sort_by(|a, b| {
                b.count
                    .cmp(&a.count)
                    .then_with(|| a.spell.as_str().cmp(b.spell.as_str()))
            });
            let total: i64 = spells.iter().map(|s| s.count).sum();
            let (verdict, wiki_conflict) = self.verdict_for(&rec, total);
            match verdict {
                Verdict::Verified => verified += 1,
                Verdict::Shared => shared += 1,
                Verdict::Contradicts => contradictions += 1,
                Verdict::Unknown => unknown += 1,
            }
            messages.push(OverlayMessage {
                text: rec.text.clone(),
                role: rec.role,
                verdict,
                spells,
                total,
                wiki_conflict,
            });
        }
        messages.sort_by(|a, b| {
            a.verdict
                .rank()
                .cmp(&b.verdict.rank())
                .then_with(|| b.total.cmp(&a.total))
                .then_with(|| a.text.as_str().cmp(b.text.as_str()))
        });
        json!({
            "version": OVERLAY_VERSION,
            // The log's clock, not the machine's — see `last_observed_ts`. The parity harness
            // strips this field from both sides, so it exists for the consumer, not for the bar.
            "updatedAt": iso_utc(self.last_observed_ts),
            "messages": messages,
            "stats": { "verified": verified, "shared": shared, "contradictions": contradictions, "unknown": unknown },
        })
    }
}

/// Add per-spell counts into a record, keyed canonically. The one place counts are combined:
/// imports (`merge`) and the cross-bucket sum (`aggregate`) share it so they cannot drift.
fn add_counts(rec: &mut MessageRecord, spells: &[(String, i64)]) {
    for (spell, count) in spells {
        let key = db_canon_key(spell);
        match rec.by_spell.get_mut(&key) {
            Some(cur) => cur.count += count,
            None => rec.by_spell.insert(
                key,
                SpellCount {
                    display: spell.clone(),
                    count: *count,
                },
            ),
        }
    }
}

/// `new Date(ms).toISOString()` — UTC, always three fractional digits, always the `Z` suffix.
///
/// Written out rather than pulling in a date crate: this direction needs no zone database and no
/// table, so twenty-four characters would not be worth a dependency.
///
/// The civil-from-days algorithm is Howard Hinnant's. Days are floored rather than truncated so a
/// pre-epoch instant is still correct.
fn iso_utc(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    let (y, m, d) = civil_from_days(days);
    let (h, min, s, milli) = (
        rem / 3_600_000,
        rem / 60_000 % 60,
        rem / 1000 % 60,
        rem % 1000,
    );
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{min:02}:{s:02}.{milli:03}Z")
}

/// Days since 1970-01-01 → (year, month, day), Gregorian.
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// The committed baseline, `include_str!`d: one copy of the file in the repo, two readers, and a
/// re-generation reaches both at once. The baseline alone is what the parity harness seeds, because
/// the user's own mined overlay lives in userData and a golden recorded against a machine-local
/// file would not be a fact about the log.
const BASELINE_JSON: &str = include_str!("../../../../src/main/data/messageOverlay.baseline.json");

/// Parse the committed baseline into `merge`'s argument shape.
pub fn baseline_counts() -> Vec<SeedMessage> {
    #[derive(serde::Deserialize)]
    struct File {
        messages: Vec<Msg>,
    }
    #[derive(serde::Deserialize)]
    struct Msg {
        text: String,
        role: String,
        spells: Vec<Sp>,
    }
    #[derive(serde::Deserialize)]
    struct Sp {
        spell: String,
        count: i64,
    }
    let file: File =
        serde_json::from_str(BASELINE_JSON).expect("messageOverlay.baseline.json is not readable");
    file.messages
        .into_iter()
        .map(|m| {
            (
                m.text,
                role_of(&m.role),
                m.spells.into_iter().map(|s| (s.spell, s.count)).collect(),
            )
        })
        .collect()
}

/// The role vocabulary is closed at two values; anything else in the file would be a shape the
/// serializer could not round-trip, so it is named rather than passed through. The user register
/// reads through this too, so there is one answer to what an unknown role means.
pub(crate) fn role_of(role: &str) -> &'static str {
    match role {
        "wearsOff" => "wearsOff",
        _ => "landing",
    }
}

/// `buffsMining.ts messageTextOf` — strip the `[timestamp] ` prefix from a raw line.
pub fn message_text_of(raw: &str) -> &str {
    match raw.find("] ") {
        Some(i) => &raw[i + 2..],
        None => raw,
    }
}
