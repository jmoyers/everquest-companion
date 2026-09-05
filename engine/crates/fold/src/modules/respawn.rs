//! `src/main/modules/respawn.ts` plus the pure vocabulary it publishes through
//! (`shared/respawn.ts`) and the committed wiki floor it numbers rows from
//! (`shared/respawnWiki.ts` / `data/respawns.json`) — DEATH LINES IN, LIVE COUNTDOWNS OUT.
//!
//! The fold owns three things the pure code cannot:
//!
//!   1. The ZONE STAY. A death→death gap is a respawn sample only if you never left the zone
//!      between the two deaths. `zone_since` is the timestamp of the `You have entered` line that
//!      started the current stay, and a gap qualifies when the EARLIER death also falls inside it.
//!      A zone line ends the stay even when it names the same zone — you left and came back. That
//!      same zone scopes the display, deliberately one piece of state serving both jobs, so no
//!      second tracker can disagree with the one deciding whether a gap counts.
//!   2. The LRU. A long replay walks past thousands of distinct mob names, so the history is capped
//!      at `MAX_HISTORY` and evicted by last death. The map is re-inserted on every death, so
//!      iteration order IS LRU order.
//!   3. Its own revision number. Three inputs advance no log seq — the watch list edited over IPC,
//!      a zone line and a confirmed sighting — so reporting the last event's `seq` would let a
//!      reader's `d.seq <= knownSeq` dedupe swallow the push that carries them.
//!
//! The 60-second floor is measured, not chosen: across the 394 respawns the committed floor states
//! a duration for, the shortest is 78 s and the median is 22 minutes. Two deaths of one name inside
//! a minute are two mobs dying in one pull, and the sample is refused outright rather than recorded
//! and left for a wiki floor to lift — most mobs in the dungeons this targets have no wiki floor.
//!
//! No wall clock is read here, ever: one is handed in by `on_tick`, the live tail's heartbeat,
//! which a historical fold never calls. `construction_now_ms` is seeded at construction and again
//! at `reset()`, where the TS reads `Date.now()`. Because nothing advances it during a historical
//! fold it survives into `snapshot()`, so a recorder pins it to an instant derived from the log —
//! the only way the pin means the same thing on both sides.

use crate::event::Event;
use crate::jsmap::JsMap;
use crate::EqModule;
use eqlog::names::id_key;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// `shared/respawn.ts RESPAWN_SHAPE_VERSION`.
const RESPAWN_SHAPE_VERSION: i64 = 4;
/// The shortest death→death gap this module will read as a spawn cycle (header).
const MIN_GAP_MS: i64 = 60_000;
/// Distinct (zone, mob) pairs the history keeps before evicting the least recently killed.
const MAX_HISTORY: usize = 800;
/// How often a continuing sighting re-publishes. A fight prints several lines a second and every
/// one names the mob, so recording a sighting is free but pushing it is not.
const SEEN_REFRESH_MS: i64 = 5_000;
const RESPAWN_MAX_ROWS: usize = 60;
const RESPAWN_MAX_RECENT: usize = 40;
/// The working the Running entry prints — the last six qualifying gaps.
const RESPAWN_MAX_GAPS: usize = 6;
/// Beyond this a sighting has gone stale and a clock has stopped meaning anything.
const RESPAWN_LINGER_MS: i64 = 30 * 60 * 1000;

/// One row of `data/respawns.json`. `seconds` is absent on roughly a fifth of the rows: the grammar
/// is a whitelist, so anything it cannot fully consume ("Triggered", "6-8 hours", "?") keeps its
/// verbatim text and states no number. A half-read duration would put a fabricated number on a
/// countdown.
#[derive(Debug, Clone, Deserialize)]
struct WikiRespawn {
    key: String,
    page: String,
    text: String,
    #[serde(default)]
    seconds: Option<i64>,
}

#[derive(Deserialize)]
struct WikiRespawnData {
    rows: Vec<WikiRespawn>,
}

/// Read straight out of `src/main/data/`: exactly one copy of the committed floor, so a re-scrape
/// reaches both readers at once.
const RESPAWNS_JSON: &str = include_str!("../../../../../src/main/data/respawns.json");

fn wiki() -> &'static std::collections::HashMap<String, WikiRespawn> {
    static WIKI: std::sync::OnceLock<std::collections::HashMap<String, WikiRespawn>> =
        std::sync::OnceLock::new();
    WIKI.get_or_init(|| {
        let data: WikiRespawnData =
            serde_json::from_str(RESPAWNS_JSON).expect("respawns.json is not readable");
        data.rows.into_iter().map(|r| (r.key.clone(), r)).collect()
    })
}

/// One live respawn clock. Every optional field is absent rather than null when the fold has
/// nothing to say — the published shape came through `JSON.stringify`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RespawnRow {
    /// `<zone key>::<mob key>` — stable across ticks, and the same id the fold keys history by.
    pub id: String,
    /// Canonical mob key.
    pub key: String,
    /// The name the row draws.
    pub display: String,
    /// The zone the clock is for. A mob is watched per zone.
    pub zone: String,
    /// The instant the clock counts from — a death, or a sighting.
    pub base_ts: i64,
    /// Which of those two it was: `death` or `sighting`.
    pub basis: &'static str,
    /// Where the estimate came from: `custom`, `observed`, `wiki` or `none`.
    pub source: &'static str,
    /// How many gaps the estimate was learned from.
    pub samples: i64,
    /// Kills recorded for this mob in this zone.
    pub kills: i64,
    /// When it was last SEEN alive, if it has been.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seen_ts: Option<i64>,
    /// How it was seen: `combat`, `consider`, `hold` or `spell`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seen_via: Option<&'static str>,
    /// The respawn this row is counting toward.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimate_ms: Option<i64>,
    /// What the log itself has measured.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observed_ms: Option<i64>,
    /// The recent gaps behind `observed_ms`, newest first.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gaps_ms: Option<Vec<i64>>,
    /// The number the user typed, when they typed one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_ms: Option<i64>,
    /// What the committed wiki data says, verbatim.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wiki_text: Option<String>,
    /// The same, in milliseconds, when it could be read as a duration.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wiki_ms: Option<i64>,
    /// The wiki page the text came from.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wiki_page: Option<String>,
}

/// A mob you recently killed, offered in the view as a one-click watch.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RespawnCandidate {
    key: String,
    display: String,
    zone: String,
    last_ts: i64,
    kills: i64,
    watched: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    wiki_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    wiki_ms: Option<i64>,
}

/// One mob the user has chosen to watch, and the number they chose for it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RespawnWatchPref {
    /// Canonical (lowercased) mob name — what a death line's name canonicalizes to.
    pub key: String,
    /// The name as the log printed it, for display.
    pub display: String,
    /// The user's own respawn, in SECONDS. Rung 1; absent means "use what you learn".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_sec: Option<i64>,
}

/// `DEFAULT_RESPAWN_PREFS` is an empty list and that is the shipped default: tracking is opt-in per
/// mob, so a caller that passes nothing gets a module that clocks nothing.
#[derive(Debug, Clone, Default, Serialize)]
pub struct RespawnPrefs {
    pub watches: Vec<RespawnWatchPref>,
}

impl RespawnPrefs {
    /// Read a pushed `respawn.define` payload — `{ watches: [...] }`, as the store holds it.
    ///
    /// It normalizes as `shared/respawn.ts normalizeRespawnPrefs` does, because an engine that
    /// trusted the wire would be a third place with its own idea of what a watch is. The key is
    /// lowercased and capped, a watch with no key or a duplicate key is dropped, an out-of-range
    /// `customSec` is dropped (reading as "use what you learn", never as zero), and the list is
    /// capped.
    ///
    /// `None` for a payload that is not an object, which leaves the previous set standing — the
    /// honest outcome for app knowledge that arrived malformed.
    pub fn read(payload: &Value) -> Option<RespawnPrefs> {
        /// `RESPAWN_MAX_WATCHES`.
        const MAX_WATCHES: usize = 200;
        /// `MAX` on a stored key or display, in chars.
        const MAX_NAME: usize = 64;
        /// `RESPAWN_CUSTOM_MIN_SEC` / `RESPAWN_CUSTOM_MAX_SEC`.
        const MIN_SEC: i64 = 1;
        const MAX_SEC: i64 = 7 * 24 * 3600;

        let obj = payload.as_object()?;
        let mut watches: Vec<RespawnWatchPref> = Vec::new();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        for w in obj
            .get("watches")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let key: String = w
                .get("key")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_lowercase()
                .chars()
                .take(MAX_NAME)
                .collect();
            if key.is_empty() || !seen.insert(key.clone()) {
                continue;
            }
            let display: String = w
                .get("display")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .chars()
                .take(MAX_NAME)
                .collect();
            let custom_sec = w
                .get("customSec")
                .and_then(Value::as_f64)
                .map(f64::round)
                .filter(|s| s.is_finite())
                .map(|s| s as i64)
                .filter(|s| (MIN_SEC..=MAX_SEC).contains(s));
            watches.push(RespawnWatchPref {
                display: if display.is_empty() {
                    key.clone()
                } else {
                    display
                },
                key,
                custom_sec,
            });
            if watches.len() >= MAX_WATCHES {
                break;
            }
        }
        Some(RespawnPrefs { watches })
    }
}

/// What the fold knows about one mob in one zone.
#[derive(Debug, Clone)]
struct MobHistory {
    key: String,
    display: String,
    zone: String,
    /// The most recent death, ms.
    last_ts: i64,
    /// The smallest qualifying gap seen — an upper bound on the respawn, never the respawn.
    min_gap_ms: Option<i64>,
    /// How many qualifying gaps back `min_gap_ms`.
    samples: i64,
    /// The gaps themselves, oldest first, capped at `RESPAWN_MAX_GAPS`. Kept beside `samples` and
    /// `min_gap_ms` rather than replacing them: those two are computed over EVERY qualifying gap
    /// and must not start describing only the last few.
    gaps: Vec<i64>,
    /// Deaths counted, qualifying or not.
    kills: i64,
    /// The last event that named this mob while the fold stood in this zone. Never a death.
    seen_ts: Option<i64>,
    seen_via: Option<&'static str>,
    /// The last `seen_ts` a delta actually carried — see `SEEN_REFRESH_MS`.
    seen_pub_ts: Option<i64>,
    /// A sighting the user confirmed as the spawn. Competes with `last_ts` for the clock's base and
    /// the LATER one wins, which is why a death needs no code to undo it.
    confirmed_ts: Option<i64>,
}

/// The clock's base for one history entry: the death, or a later confirmed sighting.
fn base_of(h: &MobHistory) -> i64 {
    match h.confirmed_ts {
        Some(c) if c > h.last_ts => c,
        _ => h.last_ts,
    }
}

/// `resolveRespawn` — the estimate ladder. Rung 2 is FLOORED by rung 3 rather than averaged with it
/// (the smallest gap you measured is an upper bound, so the wiki lifting it is a correction); rung
/// 1 is never floored, because the user is looking at the spawn and the wiki describes another
/// server.
fn resolve_respawn(
    custom_ms: Option<i64>,
    observed_ms: Option<i64>,
    samples: i64,
    wiki_ms: Option<i64>,
) -> (Option<i64>, &'static str) {
    if let Some(c) = custom_ms {
        if c > 0 {
            return (Some(c), "custom");
        }
    }
    if let Some(o) = observed_ms {
        if o > 0 && samples > 0 {
            let floored = match wiki_ms {
                Some(w) => o.max(w),
                None => o,
            };
            return (Some(floored), "observed");
        }
    }
    if let Some(w) = wiki_ms {
        if w > 0 {
            return (Some(w), "wiki");
        }
    }
    (None, "none")
}

/// The names a typed event states, and which family stated them. The groups ARE the four
/// `RespawnSeenVia` values, so the factoring and the vocabulary agree.
fn seen_names_of<'e>(ev: &'e Event<'_>) -> Option<(Vec<Option<&'e str>>, &'static str)> {
    // Somebody swung at it, or it swung at somebody. `attacker` is null on caster-less DoT lines.
    match ev.kind() {
        "damage" | "miss" => {
            return Some((vec![ev.str("attacker"), ev.str("target")], "combat"));
        }
        "heal" => return Some((vec![ev.str("healer"), ev.str("target")], "combat")),
        "consider" => return Some((vec![ev.str("mob")], "consider")),
        // A mez / root / charm landed on it, broke on it, or wore off it.
        "cc" | "ccWake" | "charm" | "uncharm" => return Some((vec![ev.str("mob")], "hold")),
        // A spell named it — as a resister, as a caster, or as the thing something landed on.
        "resist" => return Some((vec![ev.str("caster"), ev.str("target")], "spell")),
        "otherCastBegin" => return Some((vec![ev.str("caster")], "spell")),
        "buffApply" | "poisonProc" => return Some((vec![ev.str("target")], "spell")),
        _ => {}
    }
    None
}

/// `main/log/reducers.ts isCountedKill` — self-slain always counts; slain-by counts only when the
/// killer isn't you. `kills.rs` carries the same port privately.
fn is_counted_kill(ev: &Event) -> bool {
    if ev.bool("bySelf") {
        return true;
    }
    match ev.str("killer") {
        Some(killer) if !killer.is_empty() => !crate::jsfn::starts_with_you_word(killer),
        _ => true,
    }
}

pub struct RespawnModule {
    history: JsMap<MobHistory>,
    zone: String,
    /// When the current continuous stay in `zone` began. Zero before any zone line, and a zero
    /// start qualifies nothing — a stay that never began is not a stay.
    zone_since: i64,
    prefs: RespawnPrefs,
    /// The module's own revision — see the header. Never a LogEvent seq.
    rev: i64,
    /// The pinned construction instant (see the header). Re-read at `reset()` to the same value,
    /// because the fold advances no clock.
    construction_now_ms: i64,
    now_ms: i64,
    /// The watch list as a lookup. Not a micro-optimization: every damage and miss line asks this
    /// two questions, and a linear scan of up to 200 entries per name would be tens of millions of
    /// string comparisons before the app finished starting.
    watch_index: std::collections::HashMap<String, RespawnWatchPref>,
}

impl RespawnModule {
    pub fn new(construction_now_ms: i64, prefs: RespawnPrefs) -> Self {
        let mut m = RespawnModule {
            history: JsMap::new(),
            zone: String::new(),
            zone_since: 0,
            prefs,
            rev: 0,
            construction_now_ms,
            now_ms: construction_now_ms,
            watch_index: std::collections::HashMap::new(),
        };
        m.reindex_watches();
        m
    }

    fn reindex_watches(&mut self) {
        self.watch_index = self
            .prefs
            .watches
            .iter()
            .map(|w| (w.key.clone(), w.clone()))
            .collect();
    }

    /// Is this mob watched? `None` for every mob, until the player says otherwise.
    ///
    /// The watch list is the only admission rule. EQ's names are duplicated across zones and spawn
    /// points, so a clock nobody asked for is a clock about a mob the app cannot identify. The wiki
    /// still numbers a watched row and still floors it; it does not decide that a row exists.
    fn watch_of(&self, key: &str) -> Option<Option<i64>> {
        let explicit = self.watch_index.get(key)?;
        Some(explicit.custom_sec.map(|s| s * 1000))
    }

    /// The log named something. Mark it seen if — and only if — it is a mob the user watches AND
    /// this fold has a clock for it in the zone it is standing in.
    ///
    /// Both guards matter: an unwatched name is dropped before it costs anything, which is what
    /// makes running this over every combat line acceptable, and the entry is looked up under the
    /// CURRENT zone's id, so a sighting can only light a row for where you are standing.
    fn mark_seen(&mut self, name: Option<&str>, via: &'static str, ts: i64) {
        let Some(name) = name else { return };
        if name.is_empty() {
            return;
        }
        let key = id_key(name);
        if self.watch_of(&key).is_none() {
            return;
        }
        let id = format!("{}::{}", id_key(&self.zone), key);
        let Some(h) = self.history.get_mut(&id) else {
            return;
        };
        let base = base_of(h);
        // A mention from before the clock started is not a sighting of the spawn it is about, so
        // the transition is judged against the BASE rather than the previous `seen_ts`.
        let was_seen = h.seen_ts.is_some_and(|s| s > base);
        if h.seen_ts.is_some_and(|s| ts < s) {
            return;
        }
        h.seen_ts = Some(ts);
        h.seen_via = Some(via);
        if was_seen && ts - h.seen_pub_ts.unwrap_or(0) < SEEN_REFRESH_MS {
            return;
        }
        h.seen_pub_ts = Some(ts);
        self.rev += 1;
    }

    /// "That sighting was the spawn — start the clock there", `respawn.ts confirmSighting` line
    /// for line.
    ///
    /// The one thing a sighting may never do on its own. Everything else here records evidence; this
    /// MOVES a clock, so only a person can ask for it, which is why it arrives as a pushed command
    /// rather than out of an event and is the third input advancing `rev` with no log seq.
    ///
    /// `id` is the row's own id, which is how the surfaces name a row and how this fold keys its
    /// history — one identifier, no second addressing scheme to keep in step.
    ///
    /// Two refusals, both about the row rather than about the world: `false` when the id names no
    /// entry, and `false` when the entry is not CURRENTLY seen — the same test [`Self::row_for`]
    /// uses to let a row open in the seen state, so a click can only confirm a sighting the screen
    /// was drawing. Nothing needs to undo a confirmation either: the base is the later of
    /// `confirmed_ts` and `last_ts` ([`base_of`]), so the next death wins by arithmetic.
    pub fn confirm_sighting(&mut self, id: &str) -> bool {
        let Some(h) = self.history.get_mut(id) else {
            return false;
        };
        let base = base_of(h);
        let Some(seen) = h.seen_ts.filter(|s| *s > base) else {
            return false;
        };
        h.confirmed_ts = Some(seen);
        // The revision moves: a confirmation advances no log seq, so a reader deduping on `seq`
        // would swallow the very push that carries it.
        self.rev += 1;
        true
    }

    fn record_death(&mut self, key: &str, display: &str, ts: i64) {
        let id = format!("{}::{}", id_key(&self.zone), key);
        let mut h = match self.history.get(&id) {
            Some(prior) => {
                let mut h = prior.clone();
                // Re-insert so the map's iteration order is LRU order (oldest first).
                self.history.remove(&id);
                let gap = ts - h.last_ts;
                if self.zone_since > 0 && h.last_ts >= self.zone_since && gap >= MIN_GAP_MS {
                    h.min_gap_ms = Some(match h.min_gap_ms {
                        Some(m) => m.min(gap),
                        None => gap,
                    });
                    h.samples += 1;
                    // Oldest first here and reversed on the way out, so the cap drops the oldest
                    // rather than the freshest evidence.
                    h.gaps.push(gap);
                    if h.gaps.len() > RESPAWN_MAX_GAPS {
                        h.gaps.remove(0);
                    }
                }
                h
            }
            None => MobHistory {
                key: key.to_string(),
                display: display.to_string(),
                zone: self.zone.clone(),
                last_ts: 0,
                min_gap_ms: None,
                samples: 0,
                gaps: Vec::new(),
                kills: 0,
                seen_ts: None,
                seen_via: None,
                seen_pub_ts: None,
                confirmed_ts: None,
            },
        };
        h.last_ts = ts;
        h.kills += 1;
        h.display = display.to_string();
        self.history.insert(id, h);
        while self.history.len() > MAX_HISTORY {
            let Some(oldest) = self.history.keys().next().map(str::to_string) else {
                break;
            };
            self.history.remove(&oldest);
        }
        self.rev += 1;
    }

    /// One history entry as a row, or `None` when the mob is not watched — the only reason this
    /// returns `None`. It never sweeps stale rows, and it takes no clock: nothing it computes
    /// depends on `now`.
    fn row_for(&self, h: &MobHistory) -> Option<RespawnRow> {
        let custom_ms = self.watch_of(&h.key)?;
        let wiki_row = wiki().get(&h.key);
        let wiki_ms = wiki_row.and_then(|w| w.seconds).map(|s| s * 1000);
        let (estimate_ms, source) = resolve_respawn(custom_ms, h.min_gap_ms, h.samples, wiki_ms);
        let base = base_of(h);
        let mut row = RespawnRow {
            id: format!("{}::{}", id_key(&h.zone), h.key),
            key: h.key.clone(),
            display: h.display.clone(),
            zone: h.zone.clone(),
            base_ts: base,
            basis: if base == h.last_ts {
                "death"
            } else {
                "sighting"
            },
            source,
            samples: h.samples,
            kills: h.kills,
            seen_ts: None,
            seen_via: None,
            estimate_ms,
            observed_ms: h.min_gap_ms,
            gaps_ms: None,
            custom_ms,
            wiki_text: wiki_row.map(|w| w.text.clone()),
            wiki_ms,
            // The page those words came from, so the edit modal can link to it: quoting a source
            // the reader cannot open is half a provenance.
            wiki_page: wiki_row.map(|w| w.page.clone()),
        };
        // A mention from the fight that KILLED the mob is not a sighting of the spawn that follows,
        // so a row must never open in the seen state.
        if h.seen_ts.is_some_and(|s| s > base) {
            row.seen_ts = h.seen_ts;
            row.seen_via = h.seen_via;
        }
        // Newest first on the wire, and a COPY, so a reader holding a snapshot never sees the fold
        // mutate it.
        if !h.gaps.is_empty() {
            let mut out = h.gaps.clone();
            out.reverse();
            row.gaps_ms = Some(out);
        }
        Some(row)
    }

    /// `orderRespawnRows` — SEEN first, then live clocks by soonest due, then the ones with no
    /// estimate, and STALE last. Ties break on display name so the list never shuffles under a
    /// re-render.
    ///
    /// Seen outranks every countdown because it is a different KIND of fact: every other row is an
    /// estimate of when something might happen, and a seen row is the log saying it already has.
    /// Stale sinks for the mirror reason — a row whose estimate elapsed hours ago still reads
    /// `remainingMs: 0`, and would otherwise sit on top of the clock running in front of you.
    fn order_rows(rows: &mut [RespawnRow], now_ms: i64) {
        /// The fields of `respawnReading` the ordering asks about. `fraction`/`due`/`overdueMs` are
        /// display-only and no caller of this function reads them.
        fn reading(row: &RespawnRow, now_ms: i64) -> (bool, i64, bool, Option<i64>) {
            let elapsed = (now_ms - row.base_ts).max(0);
            let ago = match row.seen_ts {
                Some(s) if s > row.base_ts => {
                    let ago = (now_ms - s).max(0);
                    if ago <= RESPAWN_LINGER_MS {
                        Some(ago)
                    } else {
                        None
                    }
                }
                _ => None,
            };
            let seen = ago.is_some();
            match row.estimate_ms {
                Some(est) if est > 0 => {
                    let left = est - elapsed;
                    (
                        seen,
                        ago.unwrap_or(0),
                        !seen && -left > RESPAWN_LINGER_MS,
                        Some(left.max(0)),
                    )
                }
                // No estimate to elapse, so the elapsed time is what goes stale.
                _ => (
                    seen,
                    ago.unwrap_or(0),
                    !seen && elapsed > RESPAWN_LINGER_MS,
                    None,
                ),
            }
        }
        rows.sort_by(|a, b| {
            let (sa, agoa, stalea, lefta) = reading(a, now_ms);
            let (sb, agob, staleb, leftb) = reading(b, now_ms);
            sb.cmp(&sa)
                .then_with(|| {
                    if sa && sb {
                        agoa.cmp(&agob)
                    } else {
                        std::cmp::Ordering::Equal
                    }
                })
                .then_with(|| stalea.cmp(&staleb))
                .then_with(|| lefta.unwrap_or(i64::MAX).cmp(&leftb.unwrap_or(i64::MAX)))
                .then_with(|| a.display.cmp(&b.display))
        });
    }

    fn build(&self, now_ms: i64) -> Value {
        let (rows, recent) = self.collect(now_ms);
        json!({
            "v": RESPAWN_SHAPE_VERSION,
            "zone": self.zone,
            "rows": rows,
            "recent": recent,
            "prefs": self.prefs,
        })
    }

    /// The watch-row pull seam — the rows the Timers surface draws, in the order it draws them,
    /// typed rather than serialized.
    ///
    /// It goes through [`Self::collect`] rather than re-walking the history, at the cost of a
    /// candidate list this caller throws away, so there is no second opinion about which mobs are
    /// on a clock.
    #[must_use]
    pub fn watch_rows(&self, now_ms: i64) -> Vec<RespawnRow> {
        self.collect(now_ms).0
    }

    /// The ordering clock this module was last advanced to — the log's own `ts` while folding, and
    /// the wall clock once a live tail is ticking it. The view layer needs it because respawn order
    /// is a function of `now`, and a SECOND clock would order the rows against an instant the
    /// module has never seen.
    #[must_use]
    pub fn now_ms(&self) -> i64 {
        self.now_ms
    }

    /// The change signal — the private revision counter this module publishes as its `seq`, because
    /// a watch advances no log seq.
    #[must_use]
    pub fn revision(&self) -> i64 {
        self.rev
    }

    /// The rows and the candidates, walked once. Both halves of [`Self::build`].
    fn collect(&self, now_ms: i64) -> (Vec<RespawnRow>, Vec<RespawnCandidate>) {
        let mut rows: Vec<RespawnRow> = Vec::new();
        let mut recent: Vec<RespawnCandidate> = Vec::new();
        // The map iterates oldest-first (LRU order), so sort for "most recent". `sort_by` is stable
        // and so is `Array.prototype.sort`, which keeps ties in LRU order on both sides.
        let mut entries: Vec<&MobHistory> = self.history.values().collect();
        entries.sort_by_key(|h| std::cmp::Reverse(h.last_ts));
        for h in entries {
            if let Some(row) = self.row_for(h) {
                if rows.len() < RESPAWN_MAX_ROWS {
                    rows.push(row);
                }
            }
            if recent.len() < RESPAWN_MAX_RECENT {
                let wiki_row = wiki().get(&h.key);
                recent.push(RespawnCandidate {
                    key: h.key.clone(),
                    display: h.display.clone(),
                    zone: h.zone.clone(),
                    last_ts: h.last_ts,
                    kills: h.kills,
                    watched: self.watch_of(&h.key).is_some(),
                    wiki_text: wiki_row.map(|w| w.text.clone()),
                    wiki_ms: wiki_row.and_then(|w| w.seconds).map(|s| s * 1000),
                });
            }
        }
        Self::order_rows(&mut rows, now_ms);
        (rows, recent)
    }
}

impl EqModule for RespawnModule {
    fn id(&self) -> &'static str {
        "respawn"
    }

    fn reset(&mut self) {
        self.history.clear();
        self.zone = String::new();
        self.zone_since = 0;
        // Re-read the "wall clock", which here is the pinned construction instant — see the
        // header. Over there this line is `Date.now()`.
        self.now_ms = self.construction_now_ms;
        self.rev += 1;
    }

    fn on_event(&mut self, ev: &Event, _live: bool) {
        match ev.kind() {
            "epoch" => {
                // A character rebirth invalidates the live clocks and takes the learned gaps with
                // them, because the gaps are recomputed by the same fold replaying past this line:
                // nothing is lost that the log still states. Only knowledge the log CANNOT restate
                // persists across an epoch.
                self.history.clear();
                self.rev += 1;
            }
            "zone" => {
                self.zone = ev.str("zone").unwrap_or_default().to_string();
                self.zone_since = ev.ts();
                // The revision moves, because the zone is part of what the screen shows: without
                // this both surfaces keep drawing the old zone's clocks while the log stays quiet.
                self.rev += 1;
            }
            "death" => {
                if is_counted_kill(ev) {
                    let name = ev.str("name").unwrap_or_default();
                    self.record_death(&id_key(name), name, ev.ts());
                }
            }
            _ => {
                // Everything else is possible evidence that a watched mob is up. A death is checked
                // first and returns, so a corpse can never mark its own row seen.
                if let Some((names, via)) = seen_names_of(ev) {
                    let ts = ev.ts();
                    let owned: Vec<Option<String>> =
                        names.into_iter().map(|n| n.map(str::to_string)).collect();
                    for name in owned {
                        self.mark_seen(name.as_deref(), via, ts);
                    }
                }
            }
        }
    }

    /// `respawn.ts onTick` — one assignment and, deliberately, nothing else.
    ///
    /// It publishes nothing and the revision does NOT move. The set of rows changes only when a
    /// death, a watch edit, a zone line or a sighting changes it, and each already bumps `rev`; the
    /// clock only buys the ORDER `build` publishes in. Bumping on a heartbeat would republish once
    /// a second forever for a world nobody touched.
    ///
    /// Never called on a historical fold, so the clock stays the pinned construction instant (see
    /// the header). A live world gets today's reading once a second.
    fn on_tick(&mut self, now_ms: i64, _rows: &[crate::modules::buff_timer_rows::BuffTimerRow]) {
        self.now_ms = now_ms;
    }

    /// The same cursor `snapshot` publishes, without building the state to read it.
    fn published_seq(&self) -> Option<i64> {
        Some(self.rev)
    }

    fn snapshot(&self) -> Value {
        json!({ "seq": self.rev, "state": self.build(self.now_ms) })
    }

    fn as_defines(&mut self) -> Option<&mut dyn crate::Defines> {
        Some(self)
    }

    /// The view pull seam. See `EqModule::as_respawn`.
    fn as_respawn(&self) -> Option<&RespawnModule> {
        Some(self)
    }

    /// The write seam — the one above, by `&mut`. See `EqModule::as_respawn_mut` for why they are
    /// two methods.
    fn as_respawn_mut(&mut self) -> Option<&mut RespawnModule> {
        Some(self)
    }
}

impl crate::Defines for RespawnModule {
    fn family(&self) -> &'static str {
        "respawn"
    }

    /// `respawnModule.setPrefs(next)` — the watch list, replaced whole.
    ///
    /// The revision must move: a watch advances no log seq, so a renderer deduping on `seq` would
    /// drop the very push that carries it. Pushing it out promptly is the serve layer's job — a
    /// revision that moved is what makes the next cadence tick re-cut the window.
    fn define(&mut self, payload: &Value) {
        let Some(prefs) = RespawnPrefs::read(payload) else {
            return;
        };
        self.prefs = prefs;
        self.reindex_watches();
        self.rev += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::{RespawnModule, RespawnPrefs, RespawnRow, RespawnWatchPref};
    use crate::event::Event;
    use crate::EqModule;

    /// The zone line the stay begins with. Every timestamp below is derived from this one, so the
    /// arithmetic in the assertions reads instead of being a set of magic epochs.
    const T_ZONE: i64 = 1_787_181_000_000;
    /// The kill that starts the clock — a minute into the stay.
    const T_DEATH: i64 = T_ZONE + 60_000;
    /// The line that names the mob again, two minutes after it died. It moves no clock on its own.
    const T_SEEN: i64 = T_DEATH + 120_000;
    /// Ten seconds later — where the ordering clock stands while the assertions read rows.
    const NOW: i64 = T_SEEN + 10_000;

    /// The user's own number, so the estimate ladder answers `custom` and the countdown is a round
    /// minute.
    const CUSTOM_SEC: i64 = 60;

    fn watching_the_knight() -> RespawnPrefs {
        RespawnPrefs {
            watches: vec![RespawnWatchPref {
                key: "a vis ghoul knight".to_owned(),
                display: "a vis ghoul knight".to_owned(),
                custom_sec: Some(CUSTOM_SEC),
            }],
        }
    }

    fn ev(json: &str) -> Event<'static> {
        Event::from_json(json).expect("a JSON object")
    }

    fn zone(ts: i64) -> String {
        format!(r#"{{"kind":"zone","seq":0,"ts":{ts},"raw":"z","zone":"The Ruins of Old Guk"}}"#)
    }

    fn death(seq: i64, ts: i64) -> String {
        format!(
            r#"{{"kind":"death","seq":{seq},"ts":{ts},"raw":"d","name":"a vis ghoul knight","bySelf":true}}"#
        )
    }

    /// `<Mob> hits YOU for N points of damage.` — the shape the e2e plays.
    fn hits_you(seq: i64, ts: i64) -> String {
        format!(
            r#"{{"kind":"damage","seq":{seq},"ts":{ts},"raw":"h","attacker":"a vis ghoul knight","target":"You","amount":106}}"#
        )
    }

    /// A module standing in Old Guk, one kill deep, with the mob seen alive since.
    fn seen_after_a_kill() -> RespawnModule {
        let mut m = RespawnModule::new(NOW, watching_the_knight());
        m.on_event(&ev(&zone(T_ZONE)), false);
        m.on_event(&ev(&death(1, T_DEATH)), false);
        m.on_event(&ev(&hits_you(2, T_SEEN)), true);
        m
    }

    fn only_row(m: &RespawnModule) -> RespawnRow {
        let mut rows = m.watch_rows(NOW);
        assert_eq!(rows.len(), 1, "the watch list has exactly one mob in it");
        rows.remove(0)
    }

    #[test]
    fn confirming_a_sighting_re_bases_the_clock_and_says_that_is_what_happened() {
        // The app never does this by itself: the fixture lit the row with a combat line naming a
        // watched mob and the clock did not move, and this call is the person confirming it.
        let mut m = seen_after_a_kill();

        let before = only_row(&m);
        assert_eq!(before.basis, "death", "evidence alone touches no clock");
        assert_eq!(before.base_ts, T_DEATH);
        assert_eq!(before.seen_ts, Some(T_SEEN));
        let rev_before = m.revision();

        assert!(m.confirm_sighting(&before.id));

        let after = only_row(&m);
        assert!(
            m.revision() > rev_before,
            "a confirmation must advance the module revision too — it advances no log seq"
        );
        assert_eq!(
            after.base_ts, T_SEEN,
            "the clock now counts from the sighting"
        );
        assert_eq!(after.basis, "sighting");
        // The row leaves the seen state, because the evidence is now AT the base rather than after
        // it. Fresh evidence will mark it again, which is correct: it is up.
        assert_eq!(after.seen_ts, None);
        assert_eq!(after.seen_via, None);
        // A confirmation is not a death and never a gap sample, so the ladder learned nothing.
        assert_eq!(after.samples, 0);
        assert_eq!(after.kills, 1);
        assert_eq!(after.estimate_ms, Some(CUSTOM_SEC * 1000));
        assert_eq!(after.source, "custom");
    }

    #[test]
    fn a_kill_of_the_seen_mob_resumes_the_normal_death_driven_clock() {
        // The later of (death, confirmation) wins by arithmetic, so the next kill takes the base
        // back with no code anywhere that undoes a confirmation.
        let mut m = seen_after_a_kill();
        let id = only_row(&m).id;
        assert!(m.confirm_sighting(&id));
        assert_eq!(only_row(&m).basis, "sighting");

        let t_second_death = T_DEATH + 420_000;
        m.on_event(&ev(&death(3, t_second_death)), true);

        let row = only_row(&m);
        assert_eq!(row.basis, "death");
        assert_eq!(row.base_ts, t_second_death);
        assert_eq!(row.kills, 2);
        assert_eq!(row.seen_ts, None);
        // The gap is measured between the two deaths, never from the confirmation.
        assert_eq!(row.samples, 1);
        assert_eq!(row.observed_ms, Some(420_000));
    }

    #[test]
    fn a_confirmation_with_nothing_to_confirm_is_refused_rather_than_invented() {
        // Neither refusal may move a clock, and neither may move the revision — a push carrying no
        // change would make every dedupe downstream a lie.
        let mut m = RespawnModule::new(NOW, watching_the_knight());
        m.on_event(&ev(&zone(T_ZONE)), false);
        m.on_event(&ev(&death(1, T_DEATH)), false);

        let row = only_row(&m);
        let rev = m.revision();
        assert!(
            !m.confirm_sighting(&row.id),
            "the row is due, but nothing has been seen"
        );
        assert!(!m.confirm_sighting("no such row"));
        assert_eq!(m.revision(), rev, "a refusal publishes nothing");
        assert_eq!(only_row(&m).basis, "death");
    }
}
