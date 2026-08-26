//! `src/main/modules/progression.ts` — the range-queryable time series behind the leveling
//! analytics. Experience, CREDITED kills, WITNESSED kills, loot (an activity signal), the zone
//! timeline, the offline intervals and a mirror of the tiny level/AA series, folded into ONE
//! columnar snapshot so `shared/progressionStats.rangeStats` has a single input.
//!
//! WHY IT IS NOT PART OF `leveling`. Two reasons, and both are about the CONTRACT rather than the
//! code: `LevelingSnap` is deliberately UNCAPPED (the AA identity needs the whole history, and 81
//! levels over six days is nothing) while this series grows at ~1.7k rows/day and MUST be capped —
//! folding a drop-oldest ring into a snapshot whose contract is "everything, forever" is a semantic
//! trap. And keeping `leveling` byte-untouched keeps its swap-series golden tests an unmodified
//! regression gate. It duplicates ~220 level/AA rows on purpose and duplicates no DERIVATION.
//!
//! KILL CREDIT. `killTs` holds only kills the log attributes to YOU: your own killing blow, plus a
//! BOUND PET's. Measured post-epoch: 2999 self + 1111 bound-pet = 4110 credited against 4157
//! experience lines in the same span (98.9%) — a strong correlation, never an identity (a
//! group-mate's killing blow still pays party exp; grey kills pay nothing). The 954 THIRD-PARTY
//! kills go to `witnessTs` and enter no rate, so a busy zone cannot silently inflate your farming.
//!
//! PET BINDING mirrors the combat engine, with the ONE distinction a world-model-less module can
//! still make: SUMMONED pets persist across zones, CHARMED pets do not. Claims and charms are kept
//! in two sets and a zone line clears only the charmed one. A charmed mob ALSO sends the pet-claim
//! tell, so a claim for a name already charmed re-arms the charm instead of being promoted — one
//! tell from a charmed mob would otherwise credit its kills to you forever, in every zone.
//!
//! THE EXPERIENCE JOIN LOOKS BACKWARD, and the direction is MEASURED rather than assumed. Full-log
//! sweep (1.11M lines): 4909 experience lines, 5988 slain lines; for 4887 of the 4909 the nearest
//! slain line is the one AFTER it, at a gap of 0 s (4856) or 1 s (25). Not one experience line in
//! the log follows its kill inside 4 s. So a kill takes the most recent UNCLAIMED line within
//! `KILL_EXP_JOIN_MS` before it, the claim CONSUMES the line, and EVERY kill line consumes —
//! witnessed ones included, because letting a group-mate's party experience survive would hand it
//! to your own next kill seconds later. A kill with no line in its window carries no exp AT ALL,
//! which the UI states as such and never as 0% (law 1).
//!
//! OFFLINE INTERVALS are the one column that is not a log line but a DERIVED absence — the
//! `offlineGap` events `fold::session` synthesizes. Folded VERBATIM: no merging, no inference, and
//! deliberately not applied to anything else here. `rangeStats` is the single place that decides
//! what a logout means for idle time, active time and every rate, which is what keeps a range query
//! over a snapshot with no offline intervals byte-identical to what it always was.
//!
//! THE PENDING-DELTA TWIN IS ABSENT, and that is phase 3's line rather than a simplification. Over
//! there every push writes the live column AND a pending slice (`push1(live, pending, v)`), plus
//! `zoneCloseEnd` / `dropFront` / `recentKillsDrop`, which exist ONLY so `flushDelta` can describe
//! an increment. `flush_delta` is defaulted in this crate (see `lib.rs`'s header), no caller reads
//! it, and every field of the published snapshot comes off the live columns. `dropped` and
//! `windowStart` ARE published and are kept in full.

use crate::event::Event;
use crate::jsfn::starts_with_you_word;
use crate::EqModule;
use eqlog::names::id_key;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashSet;

/// DROP-OLDEST CAPS — a retention FLOOR, not a hard length (see `TRIM_BATCH`). At these caps the
/// columnar payload is ~124k numbers + ~4k short strings, covering ~24 days of this user's play.
/// Deliberately NOT downsampled or bucketed: a mixed-resolution store makes every range query lie
/// about its own precision. Nothing is persisted — the store is rebuilt from the log every launch.
const EXP_CAP: usize = 40_000;
const KILL_CAP: usize = 40_000;
const WITNESS_CAP: usize = 20_000;
const LOOT_CAP: usize = 20_000;
/// Zone bands are the cheapest and most valuable column (~344 intervals / 6 days ⇒ ~70 days).
const ZONE_CAP: usize = 4_000;
/// Capped like the zone bands and for the same reason, but rarer by orders of magnitude — this
/// covers years and exists only so no column here can grow without a stated bound.
const OFFLINE_CAP: usize = 4_000;
/// The named recent-kills ring, capped by COUNT rather than by the column policy: it is a display
/// feed for a card that renders 25 rows, so 50 is one screenful of headroom.
const RECENT_KILL_CAP: usize = 50;

/// How much slack a full column is allowed before it is trimmed back to its cap. Trimming the
/// front of a 40k array costs a full memmove, so trimming on EVERY sample past the cap would make
/// a long historical replay O(samples x cap) — quadratic against a replay budget of "a full 68 MB
/// log in seconds". The consequence, and the reason the caps are a retention FLOOR: a column can
/// transiently hold up to this many entries MORE than its cap. It never holds fewer.
const TRIM_BATCH: usize = 1024;

/// `shared/kills.ts KILL_EXP_JOIN_MS` — how far BACK a kill may reach for its experience line.
const KILL_EXP_JOIN_MS: i64 = 2500;

/// A named row for a credited kill — a DISPLAY duplicate; no statistic reads it.
///
/// PUBLIC SINCE JOS-487: `kills.recent` is a view over this ring, and a view reads the module's own
/// rows rather than a re-serialization of them.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressionKill {
    /// When, on the log's own clock.
    pub ts: i64,
    /// The mob's RAW display name — what the deep link into the Mobs surface is built from.
    pub name: String,
    /// `0` for your own killing blow, `1` for a bound pet's.
    pub credit: i64,
    /// RAW zone name, or `''` before the first zone line — the same "unknown, never fabricated"
    /// rule the -1 zone index states in the column.
    pub zone: String,
    /// Bitfield: `1` the exp line stated no percentage, `2` it was party exp. ABSENT means there
    /// was no exp line at all, which is a different sentence from "an exp line that said nothing".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exp_flag: Option<i64>,
    /// The percentage the line stated, when it stated one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exp_pct: Option<f64>,
}

/// An experience line waiting to be claimed by the kill line that follows it.
#[derive(Clone, Copy)]
struct PendingExp {
    ts: i64,
    pct: Option<f64>,
    party: bool,
}

/// `ProgressionSnap` — the published columns, index-aligned in groups.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Snap {
    exp_ts: Vec<i64>,
    exp_pct: Vec<f64>,
    exp_flag: Vec<i64>,
    kill_ts: Vec<i64>,
    kill_zone: Vec<i64>,
    kill_credit: Vec<i64>,
    witness_ts: Vec<i64>,
    recent_kills: Vec<ProgressionKill>,
    loot_ts: Vec<i64>,
    zone_start: Vec<i64>,
    zone_end: Vec<i64>,
    zone_name: Vec<String>,
    offline_start: Vec<i64>,
    offline_end: Vec<i64>,
    offline_camped: Vec<i64>,
    level_ts: Vec<i64>,
    level_value: Vec<i64>,
    aa_gain_ts: Vec<i64>,
    aa_gain_amount: Vec<i64>,
    last_ts: i64,
    window_start: i64,
    dropped: i64,
}

/// Cumulative drops per capped column — feeds `windowStart`.
#[derive(Default)]
struct DropFront {
    exp: i64,
    kill: i64,
    witness: i64,
    loot: i64,
    zone: i64,
    offline: i64,
}

#[derive(Default)]
pub struct ProgressionModule {
    s: Snap,
    seq: i64,
    dropped_by: DropFront,
    /// SUMMONED pets (pet-claim tells, never charmed). They follow you through a zone line.
    claimed: HashSet<String>,
    /// Pets bound RIGHT NOW by charm. Charm cannot survive a zone transition (law 4).
    charmed: HashSet<String>,
    /// Every name ever charmed this epoch — a charmed mob tells you it is your pet too, and that
    /// claim must never promote it to a zone-surviving summoned pet.
    ever_charmed: HashSet<String>,
    pending_exp: Option<PendingExp>,
}

/// Drop-oldest across parallel columns that must stay index-aligned. Returns how many leading
/// entries went (0 while the column is still inside `cap + TRIM_BATCH`).
///
/// The TS takes the columns as one array of arrays; Rust's borrow checker will not hand out several
/// `&mut` fields through one slice, so the LENGTH decision is made once here and each caller
/// applies the same `drop` to its own columns. Same arithmetic, same answer.
fn cap_drop(cap: usize, len: usize) -> usize {
    if len < cap + TRIM_BATCH {
        0
    } else {
        len - cap
    }
}

impl ProgressionModule {
    pub fn new() -> Self {
        Self::default()
    }

    /// THE RECENT-KILLS PULL SEAM (JOS-487) — the ring the Overview's kill feed draws, OLDEST FIRST
    /// as the module keeps it. The view reverses it; a module that reversed for a view would be a
    /// module with an opinion about who is reading.
    #[must_use]
    pub fn recent_kills(&self) -> &[ProgressionKill] {
        &self.s.recent_kills
    }

    /// THE LEVEL COLUMN — `(ts, level)` pairs, in fold order. UNCAPPED, because the chart needs
    /// every ding; ~5k rows a year including the AA column beside it.
    pub fn levels(&self) -> impl Iterator<Item = (i64, i64)> + '_ {
        self.s
            .level_ts
            .iter()
            .copied()
            .zip(self.s.level_value.iter().copied())
    }

    /// THE AA COLUMN — `(ts, amount)` pairs, in fold order.
    pub fn aa_gains(&self) -> impl Iterator<Item = (i64, i64)> + '_ {
        self.s
            .aa_gain_ts
            .iter()
            .copied()
            .zip(self.s.aa_gain_amount.iter().copied())
    }

    /// THE CHANGE SIGNAL. This module has no revision counter — its published `seq` is the last
    /// event it folded — so, like `buffs`, it over-reports and never under-reports. See that
    /// module's `revision` for the argument and for what it costs.
    #[must_use]
    pub fn revision(&self) -> i64 {
        self.seq
    }

    /// A pet addressed you as master. For a name never seen charmed this is the only binding
    /// signal a random-named SUMMONED pet ever gets, and summoned pets follow you across zones —
    /// so it binds permanently. For a name we HAVE seen charmed it is a charmed mob re-stating a
    /// relationship a zone line ends, so it re-arms the charmed set instead.
    fn on_claim(&mut self, key: String) {
        if self.ever_charmed.contains(&key) {
            self.charmed.insert(key);
        } else {
            self.claimed.insert(key);
        }
    }

    fn push_exp(&mut self, ts: i64, pct: Option<f64>, party: bool) {
        // pct UNDEFINED (the line stated none) is stored as -1 plus flag bit 1 — never 0.
        let flag = i64::from(pct.is_none()) | if party { 2 } else { 0 };
        self.s.exp_ts.push(ts);
        self.s.exp_pct.push(pct.unwrap_or(-1.0));
        self.s.exp_flag.push(flag);
        // Offer it to the kill line that follows. An UNCLAIMED older line is simply REPLACED: two
        // experience lines with no kill between them means the first one's kill never printed, and
        // handing a stale line to a later kill would be a fabricated attribution.
        self.pending_exp = Some(PendingExp { ts, pct, party });
        self.trim();
    }

    /// The experience line this kill line claims, or `None`. Claiming CONSUMES it.
    fn take_exp(&mut self, ts: i64) -> Option<PendingExp> {
        let p = self.pending_exp.take()?;
        if ts < p.ts || ts - p.ts > KILL_EXP_JOIN_MS {
            return None;
        }
        Some(p)
    }

    /// Self kill / bound-pet kill (credited) vs everybody else's (witnessed).
    fn on_death(&mut self, ev: &Event) {
        let ts = ev.ts();
        let exp = self.take_exp(ts);
        let name = ev.str("name").unwrap_or_default().to_string();
        if ev.bool("bySelf") {
            self.push_kill(ts, 0, &name, exp);
            return;
        }
        // `X has been slain by You` is the third-person twin of the self shape — counting it would
        // double every one of your own kills (`reducers.ts isCountedKill`, same rule).
        let killer = ev.str("killer").unwrap_or_default();
        if killer.is_empty() || starts_with_you_word(killer) {
            return;
        }
        let k = id_key(killer);
        if self.claimed.contains(&k) || self.charmed.contains(&k) {
            self.push_kill(ts, 1, &name, exp);
            return;
        }
        self.s.witness_ts.push(ts);
        self.trim();
    }

    fn push_kill(&mut self, ts: i64, credit: i64, name: &str, exp: Option<PendingExp>) {
        // -1 before the first zone line: unknown zone, never a fabricated one.
        let zone = self.s.zone_start.len() as i64 - 1;
        self.s.kill_ts.push(ts);
        self.s.kill_zone.push(zone);
        self.s.kill_credit.push(credit);
        self.push_kill_row(ts, credit, name, exp);
        self.trim();
    }

    fn push_kill_row(&mut self, ts: i64, credit: i64, name: &str, exp: Option<PendingExp>) {
        let mut row = ProgressionKill {
            ts,
            name: name.to_string(),
            credit,
            zone: self.s.zone_name.last().cloned().unwrap_or_default(),
            exp_flag: None,
            exp_pct: None,
        };
        if let Some(e) = exp {
            row.exp_flag = Some(i64::from(e.pct.is_none()) | if e.party { 2 } else { 0 });
            row.exp_pct = e.pct;
        }
        self.s.recent_kills.push(row);
        // Drop-oldest by COUNT, exactly (a 50-entry splice is free — no TRIM_BATCH slack needed),
        // and deliberately NOT through `note_drop`: this ring's churn must not move `dropped`.
        if self.s.recent_kills.len() > RECENT_KILL_CAP {
            let over = self.s.recent_kills.len() - RECENT_KILL_CAP;
            self.s.recent_kills.drain(0..over);
        }
    }

    /// A derived absence: the character was OUT OF THE WORLD between two known instants. Both
    /// edges arrive stated (the detector emits the gap at the login line that ENDED it), so this is
    /// a plain append — there is no open-ended offline interval. Non-positive spans are dropped
    /// rather than stored: an interval that covers no time is not evidence of anything.
    ///
    /// NOTE WHAT IS *NOT* DONE HERE: no zone interval is closed and no idle bookkeeping happens.
    /// The columns stay a record of what the log said.
    fn push_offline(&mut self, from_ts: i64, to_ts: i64, camped: bool) {
        if to_ts <= from_ts {
            return;
        }
        self.s.offline_start.push(from_ts);
        self.s.offline_end.push(to_ts);
        self.s.offline_camped.push(i64::from(camped));
        self.trim();
    }

    /// Close the open interval at the new zone's start, then open the next one.
    fn on_zone(&mut self, ts: i64, zone: &str) {
        let n = self.s.zone_start.len();
        if n > 0 && self.s.zone_end[n - 1] == 0 {
            self.s.zone_end[n - 1] = ts;
        }
        self.s.zone_start.push(ts);
        self.s.zone_end.push(0);
        self.s.zone_name.push(zone.to_string());
        // Charm cannot survive a zone transition; a SUMMONED pet does (law 4).
        self.charmed.clear();
        self.trim();
    }

    /// Enforce every cap, then re-derive the retention floor.
    fn trim(&mut self) {
        let n = cap_drop(EXP_CAP, self.s.exp_ts.len());
        if n > 0 {
            self.s.exp_ts.drain(0..n);
            self.s.exp_pct.drain(0..n);
            self.s.exp_flag.drain(0..n);
            self.dropped_by.exp += n as i64;
            self.s.dropped += n as i64;
        }
        let n = cap_drop(KILL_CAP, self.s.kill_ts.len());
        if n > 0 {
            self.s.kill_ts.drain(0..n);
            self.s.kill_zone.drain(0..n);
            self.s.kill_credit.drain(0..n);
            self.dropped_by.kill += n as i64;
            self.s.dropped += n as i64;
        }
        let n = cap_drop(WITNESS_CAP, self.s.witness_ts.len());
        if n > 0 {
            self.s.witness_ts.drain(0..n);
            self.dropped_by.witness += n as i64;
            self.s.dropped += n as i64;
        }
        let n = cap_drop(LOOT_CAP, self.s.loot_ts.len());
        if n > 0 {
            self.s.loot_ts.drain(0..n);
            self.dropped_by.loot += n as i64;
            self.s.dropped += n as i64;
        }
        let n = cap_drop(ZONE_CAP, self.s.zone_start.len());
        if n > 0 {
            self.s.zone_start.drain(0..n);
            self.s.zone_end.drain(0..n);
            self.s.zone_name.drain(0..n);
            // `killZone` is an index into `zoneName`, so a front-drop shifts every one of them; a
            // kill whose zone aged out becomes -1 (unknown), never a WRONG zone. `rangeStats`
            // attributes by TIMESTAMP regardless, so this can only affect a consumer that trusts
            // the index.
            let drop = n as i64;
            for z in &mut self.s.kill_zone {
                *z = (*z - drop).max(-1);
            }
            self.dropped_by.zone += drop;
            self.s.dropped += drop;
        }
        let n = cap_drop(OFFLINE_CAP, self.s.offline_start.len());
        if n > 0 {
            self.s.offline_start.drain(0..n);
            self.s.offline_end.drain(0..n);
            self.s.offline_camped.drain(0..n);
            self.dropped_by.offline += n as i64;
            self.s.dropped += n as i64;
        }
        self.recompute_window();
    }

    /// The retention floor: 0 while nothing has aged out, else the MAX first-timestamp across the
    /// columns that HAVE dropped — before that instant the record is partial and any rate over it
    /// would silently under-count. `clipped` is exactly "the selection reaches below this".
    fn recompute_window(&mut self) {
        let mut w = 0;
        let pairs: [(i64, Option<i64>); 6] = [
            (self.dropped_by.exp, self.s.exp_ts.first().copied()),
            (self.dropped_by.kill, self.s.kill_ts.first().copied()),
            (self.dropped_by.witness, self.s.witness_ts.first().copied()),
            (self.dropped_by.loot, self.s.loot_ts.first().copied()),
            (self.dropped_by.zone, self.s.zone_start.first().copied()),
            (
                self.dropped_by.offline,
                self.s.offline_start.first().copied(),
            ),
        ];
        for (dropped, first) in pairs {
            if dropped > 0 {
                if let Some(f) = first {
                    w = w.max(f);
                }
            }
        }
        self.s.window_start = w;
    }

    fn clear(&mut self) {
        self.s = Snap::default();
        self.dropped_by = DropFront::default();
        self.claimed.clear();
        self.charmed.clear();
        self.ever_charmed.clear();
        self.pending_exp = None;
    }

    fn fold(&mut self, ev: &Event) {
        match ev.kind() {
            "expGain" => self.push_exp(ev.ts(), ev.f64("pct"), ev.bool("party")),
            "death" => self.on_death(ev),
            "zone" => self.on_zone(ev.ts(), ev.str("zone").unwrap_or_default()),
            "offlineGap" => self.push_offline(
                ev.int("fromTs").unwrap_or(0),
                ev.int("toTs").unwrap_or(0),
                ev.bool("camped"),
            ),
            "loot" => {
                // A DESTROY COUNTS HERE, and the column's own name is the argument (JOS-401):
                // `lootTs` is timestamps ONLY, an ACTIVITY signal for the idle heuristic and the
                // zone bands — never a drop count, and nothing downstream reads it as one.
                // Emptying your bags is you at the keyboard, so excluding it would manufacture idle
                // time out of real play.
                self.s.loot_ts.push(ev.ts());
                self.trim();
            }
            "level" => {
                // UNCAPPED (with aaGain): ~5k rows/year, and the chart needs every ding.
                self.s.level_ts.push(ev.ts());
                self.s.level_value.push(ev.int("level").unwrap_or(0));
            }
            "aaGain" => {
                self.s.aa_gain_ts.push(ev.ts());
                self.s.aa_gain_amount.push(ev.int("amount").unwrap_or(0));
            }
            "petClaim" => self.on_claim(id_key(ev.str("name").unwrap_or_default())),
            "charm" => {
                let key = id_key(ev.str("mob").unwrap_or_default());
                self.charmed.insert(key.clone());
                self.ever_charmed.insert(key);
            }
            "uncharm" => {
                self.charmed
                    .remove(&id_key(ev.str("mob").unwrap_or_default()));
            }
            _ => {}
        }
    }
}

impl EqModule for ProgressionModule {
    fn id(&self) -> &'static str {
        "progression"
    }

    fn reset(&mut self) {
        self.clear();
        self.seq = 0;
    }

    fn on_event(&mut self, ev: &Event, _live: bool) {
        self.seq = ev.seq();
        // Character rebirth (Task #49): everything before the boundary belongs to a dead same-name
        // character and would contaminate every rate. Note the early return — `lastTs` is NOT
        // advanced by the boundary event itself.
        if ev.kind() == "epoch" {
            self.clear();
            return;
        }
        if ev.ts() > self.s.last_ts {
            self.s.last_ts = ev.ts();
        }
        self.fold(ev);
    }

    /// THE DIRTY BIT (JOS-487) — the same cursor `snapshot` publishes, without building the
    /// state to read it. See `EqModule::published_seq`.
    fn published_seq(&self) -> Option<i64> {
        Some(self.seq)
    }

    fn snapshot(&self) -> Value {
        json!({ "seq": self.seq, "state": self.s })
    }

    /// THE VIEW PULL SEAM (JOS-487). See `EqModule::as_progression`.
    fn as_progression(&self) -> Option<&ProgressionModule> {
        Some(self)
    }
}
