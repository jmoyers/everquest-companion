//! `src/main/modules/kills.ts` plus the pure core it reuses from `src/main/log/reducers.ts`
//! (`isCountedKill`, `recordKill`) and `src/shared/kills.ts` (`killTotals`).
//!
//! The four scalars are derived, never incremented: `tiers` is the record and `kill_totals` folds
//! it after every write, so `bestTier` and `lastTs` cannot describe two different kills.
//!
//! The credit join carries `progression.ts`'s exact semantics: an experience line claims BACKWARD
//! inside `KILL_EXP_JOIN_MS`, a claim CONSUMES the line, and every death line consumes — including
//! the ones this module does not count. An unclaimed older line is replaced rather than kept: a
//! stale line handed to a later kill is a fabricated attribution.
//!
//! The tier is the zone you were standing in. `zone.unwrap_or("")` is a real answer rather than a
//! fallback: a kill folded before the first `You have entered` may not claim d0, and
//! `zone_tier("")` is `TIER_UNKNOWN` for exactly that.
//!
//! A bare zone name is not always the open world — a base-difficulty raid or personal instance
//! prints the same bare `You have entered <zone>.` line the open world does. So this module
//! remembers the creating-instance notice, and it lives here rather than in `zone_tier`, which is a
//! pure fold of a NAME shared with other readers. Four properties keep the memory honest: it is
//! EVIDENCE, not proximity (a later bare re-entry with no fresh notice still stamps d0); it
//! overrides `TIER_OPEN_WORLD` and nothing else (d1-d4 and the suffixed d0 already state an
//! instance, and `TIER_UNKNOWN` stays unknown — law 1); it expires, checked at use so nothing has
//! to sweep; and it is character-scoped, cleared by the epoch alongside the KillMap.

use crate::event::Event;
use crate::jsfn::{starts_with_you_word, zone_id_key, zone_tier, TIER_OPEN_WORLD, TIER_UNKNOWN};
use crate::jsmap::JsMap;
use crate::EqModule;
use eqlog::names::id_key;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;

/// `shared/kills.ts KILLS_SHAPE_VERSION`.
const KILLS_SHAPE_VERSION: i64 = 5;

/// `shared/kills.ts KILL_EXP_JOIN_MS` — how far back a kill line may reach for the exp line that
/// credits it. Measured at 0–1 s; 2.5 s is slack over the observed spread, not a hunt.
const KILL_EXP_JOIN_MS: i64 = 2500;

/// How long a remembered creating-instance notice keeps answering for its zone.
///
/// Seven days is the weekly lockout period — the longest span over which the answer could still
/// matter. It is a bound on a memory, not a measurement: the game states nothing about when an
/// instance dies. Generous in the direction that costs least, since an expired notice just returns
/// the kill to the open world.
const INSTANCE_NOTICE_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KillTierRun {
    count: i64,
    first_ts: i64,
    last_ts: i64,
    credited: i64,
    last_credited_ts: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KillInfo {
    count: i64,
    best_tier: i64,
    first_ts: i64,
    last_ts: i64,
    credited: i64,
    display: String,
    tiers: JsMap<KillTierRun>,
}

#[derive(Default)]
pub struct KillsModule {
    kills: JsMap<KillInfo>,
    zone: Option<String>,
    seq: i64,
    /// The experience line the next kill line may claim — the timestamp is all this module needs.
    pending_exp_ts: Option<i64>,
    /// The instance memory — `zoneIdKey` of a zone seen to have an instance created, against the
    /// timestamp of the most recent such notice.
    ///
    /// A plain `HashMap` rather than a [`JsMap`]: nothing publishes it, so no iteration order of it
    /// is observable. The ordered map is only right where a `values()` walk reaches a snapshot.
    instances: HashMap<String, i64>,
    /// The announce cursor — see [`crate::announce`]. Only a recorded kill and a rebirth change the
    /// KillMap, which is the whole of `snapshot()`; the other four arms mutate state nobody reads.
    announce: crate::announce::Announce,
}

impl KillsModule {
    pub fn new() -> Self {
        Self::default()
    }

    /// The experience line this kill line claims, if any. Claiming CONSUMES it.
    fn take_exp(&mut self, ts: i64) -> bool {
        match self.pending_exp_ts.take() {
            Some(at) => ts >= at && ts - at <= KILL_EXP_JOIN_MS,
            None => false,
        }
    }

    /// Is there a live creating-instance notice for this zone at `ts`?
    ///
    /// Reading rather than consuming, unlike [`Self::take_exp`] beside it: an experience line
    /// credits exactly one kill, while one instance holds a whole evening's clear. The window has
    /// the same shape as the credit join's, so a notice can never reach a kill that preceded it.
    fn inside_a_remembered_instance(&self, zone: &str, ts: i64) -> bool {
        match self.instances.get(&zone_id_key(zone)) {
            Some(&at) => ts >= at && ts - at <= INSTANCE_NOTICE_TTL_MS,
            None => false,
        }
    }
}

/// `shared/kills.ts killTotals` — the five scalars, folded from the per-tier runs.
///
/// `bestTier` seeds at the floor of the key ordering, not at 0: a record whose only runs are
/// open-world has no difficulty to report, and seeding 0 would claim a base-instance clear it never
/// made. Iteration order cannot move any of these (a max, a min, two sums).
fn kill_totals(tiers: &JsMap<KillTierRun>) -> (i64, i64, i64, i64, i64) {
    let mut count = 0;
    let mut best_tier = TIER_UNKNOWN;
    let mut first_ts = 0;
    let mut last_ts = 0;
    let mut credited = 0;
    for (key, run) in tiers.iter() {
        if run.count <= 0 {
            continue;
        }
        count += run.count;
        best_tier = best_tier.max(key.parse::<i64>().unwrap_or(0));
        first_ts = if first_ts != 0 {
            first_ts.min(run.first_ts)
        } else {
            run.first_ts
        };
        last_ts = last_ts.max(run.last_ts);
        credited += run.credited;
    }
    (count, best_tier, first_ts, last_ts, credited)
}

/// `main/log/reducers.ts recordKill`, in place.
fn record_kill(
    kills: &mut JsMap<KillInfo>,
    key: &str,
    display: &str,
    tier: i64,
    ts: i64,
    credited: bool,
) {
    if !kills.contains_key(key) {
        kills.insert(
            key.to_string(),
            KillInfo {
                count: 0,
                best_tier: 0,
                first_ts: 0,
                last_ts: 0,
                credited: 0,
                display: display.to_string(),
                tiers: JsMap::new(),
            },
        );
    }
    let k = kills.get_mut(key).expect("just inserted");
    let tier_key = tier.to_string();
    if !k.tiers.contains_key(&tier_key) {
        k.tiers.insert(
            tier_key.clone(),
            KillTierRun {
                count: 0,
                first_ts: ts,
                last_ts: ts,
                credited: 0,
                last_credited_ts: 0,
            },
        );
    }
    let run = k.tiers.get_mut(&tier_key).expect("just inserted");
    run.count += 1;
    run.first_ts = run.first_ts.min(ts);
    run.last_ts = run.last_ts.max(ts);
    if credited {
        run.credited += 1;
        // A max, not an assignment: a replay is chronological, but a fold must not depend on it.
        run.last_credited_ts = run.last_credited_ts.max(ts);
    }
    let (count, best_tier, first_ts, last_ts, cred) = kill_totals(&k.tiers);
    k.count = count;
    k.best_tier = best_tier;
    k.first_ts = first_ts;
    k.last_ts = last_ts;
    k.credited = cred;
}

impl EqModule for KillsModule {
    fn id(&self) -> &'static str {
        "kills"
    }

    fn reset(&mut self) {
        self.kills.clear();
        self.zone = None;
        self.seq = 0;
        self.pending_exp_ts = None;
        self.instances.clear();
        self.announce.reset();
    }

    fn on_event(&mut self, ev: &Event, _live: bool) {
        self.seq = ev.seq();
        match ev.kind() {
            "epoch" => {
                // Character rebirth: the KillMap belongs to the dead character, and so do the
                // instances it stood in — a notice names a player, and that player is gone.
                self.kills.clear();
                self.pending_exp_ts = None;
                self.instances.clear();
                self.announce.changed(self.seq);
                return;
            }
            "zone" => {
                self.zone = ev.str("zone").map(str::to_string);
                return;
            }
            "instanceCreate" => {
                if let Some(zone) = ev.str("zone") {
                    // A max, not an assignment: a replay is chronological, but a fold must not
                    // depend on it, and a late older notice must not un-refresh the entry.
                    let at = self.instances.entry(zone_id_key(zone)).or_insert(ev.ts());
                    *at = (*at).max(ev.ts());
                }
                return;
            }
            "expGain" => {
                self.pending_exp_ts = Some(ev.ts());
                return;
            }
            "death" => {}
            _ => return,
        }
        // Consumed BEFORE the counted filter, as progression.ts does: the line belongs to the kill
        // it precedes whoever landed the blow, and leaving it pending would hand your experience to
        // the next mob that dies near you.
        let credited = self.take_exp(ev.ts());
        if !is_counted_kill(ev) {
            return;
        }
        let zone = self.zone.as_deref().unwrap_or("");
        let mut tier = zone_tier(zone).1;
        // The narrow override — see the header. Only this one answer moves.
        if tier == TIER_OPEN_WORLD && self.inside_a_remembered_instance(zone, ev.ts()) {
            tier = 0;
        }
        // Key by the canonical lowercase name so the two casings EQ emits for one mob fold into a
        // single entry; keep the raw name for display.
        let name = ev.str("name").unwrap_or_default();
        record_kill(
            &mut self.kills,
            &id_key(name),
            name,
            tier,
            ev.ts(),
            credited,
        );
        self.announce.changed(self.seq);
    }

    /// Moves on a counted kill, or a rebirth. See the `announce` field.
    fn published_seq(&self) -> Option<i64> {
        Some(self.announce.cursor())
    }

    fn snapshot(&self) -> Value {
        json!({
            "seq": self.seq,
            "state": { "v": KILLS_SHAPE_VERSION, "mobs": self.kills }
        })
    }
}

/// `main/log/reducers.ts isCountedKill` — self-slain always counts; slain-by counts only when the
/// killer isn't you.
fn is_counted_kill(ev: &Event) -> bool {
    if ev.bool("bySelf") {
        return true;
    }
    match ev.str("killer") {
        // An empty killer string is falsy in the TS and does not disqualify.
        Some(killer) if !killer.is_empty() => !starts_with_you_word(killer),
        _ => true,
    }
}
