//! `src/main/modules/kills.ts` plus the pure core it reuses from `src/main/log/reducers.ts`
//! (`isCountedKill`, `recordKill`) and `src/shared/kills.ts` (`killTotals`).
//!
//! THE FOUR SCALARS ARE DERIVED, NEVER INCREMENTED. `tiers` is the record; `kill_totals` folds it
//! after every write. That is what keeps `bestTier` and `lastTs` from describing two different
//! kills — the misattribution the per-tier shape replaced (shared/kills.ts's header carries it).
//!
//! THE CREDIT JOIN, with `progression.ts`'s exact semantics: an experience line claims BACKWARD
//! inside `KILL_EXP_JOIN_MS`, a claim CONSUMES the line so it can never credit two kills, and
//! EVERY death line consumes — including the ones this module does not count. An unclaimed older
//! line is replaced rather than kept, because handing a stale line to a later kill would be a
//! fabricated attribution.
//!
//! THE TIER IS THE ZONE YOU WERE STANDING IN, and `zoneTier` answers with four kinds of thing
//! (JOS-166). `zone.unwrap_or("")` is a REAL ANSWER rather than a fallback: a kill folded before
//! the first `You have entered` states nothing about where it happened and is not permitted to
//! claim d0 — `zone_tier("")` is `TIER_UNKNOWN` for exactly that.

use crate::event::Event;
use crate::jsfn::{starts_with_you_word, zone_tier, TIER_UNKNOWN};
use crate::jsmap::JsMap;
use crate::EqModule;
use eqlog::names::id_key;
use serde::Serialize;
use serde_json::{json, Value};

/// `shared/kills.ts KILLS_SHAPE_VERSION`.
const KILLS_SHAPE_VERSION: i64 = 5;

/// `shared/kills.ts KILL_EXP_JOIN_MS` — how far back a kill line may reach for the exp line that
/// credits it. Measured at 0–1 s; 2.5 s is slack over the observed spread, not a hunt.
const KILL_EXP_JOIN_MS: i64 = 2500;

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
}

/// `shared/kills.ts killTotals` — the five scalars, folded from the per-tier runs.
///
/// `bestTier` seeds at the FLOOR of the key ordering, not at 0: a record whose only runs are
/// open-world has no difficulty to report, and seeding 0 would have it claim a base-instance clear
/// it never made. Iteration order cannot move any of these (a max, a min, two sums).
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
    }

    fn on_event(&mut self, ev: &Event, _live: bool) {
        self.seq = ev.seq();
        match ev.kind() {
            "epoch" => {
                // Character rebirth (Task #49): the KillMap belongs to the dead beta character.
                self.kills.clear();
                self.pending_exp_ts = None;
                return;
            }
            "zone" => {
                self.zone = ev.str("zone").map(str::to_string);
                return;
            }
            "expGain" => {
                self.pending_exp_ts = Some(ev.ts());
                return;
            }
            "death" => {}
            _ => return,
        }
        // Consumed BEFORE the counted filter, exactly as progression.ts does it: the line belongs
        // to the kill it precedes whoever landed the blow, and letting a dropped `slain by You`
        // twin leave it pending would hand your experience to the next mob that dies near you.
        let credited = self.take_exp(ev.ts());
        if !is_counted_kill(ev) {
            return;
        }
        let tier = zone_tier(self.zone.as_deref().unwrap_or("")).1;
        // Key by the canonical lowercase name so the two casings EQ emits for the same mob fold
        // into one entry; keep the raw name for display.
        let name = ev.str("name").unwrap_or_default();
        record_kill(
            &mut self.kills,
            &id_key(name),
            name,
            tier,
            ev.ts(),
            credited,
        );
    }

    /// THE DIRTY BIT (JOS-487) — the same cursor `snapshot` publishes, without building the
    /// state to read it. See `EqModule::published_seq`.
    fn published_seq(&self) -> Option<i64> {
        Some(self.seq)
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
        // `ev.killer &&` — an EMPTY killer string is falsy in the TS and does not disqualify.
        Some(killer) if !killer.is_empty() => !starts_with_you_word(killer),
        _ => true,
    }
}
