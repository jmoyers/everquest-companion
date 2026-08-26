//! `src/main/modules/leveling.ts` — level-ups, AA gains, AA spends and AA-potion quaffs, all four
//! append-only and in log order (the unspent/net-spent math the view does depends on that order).
//!
//! THE POTION IS NOT PERSISTED, deliberately: the quaff is a LOG LINE, so a relaunch replays it
//! and re-derives the charge state exactly.

use crate::event::Event;
use crate::EqModule;
use serde::Serialize;
use serde_json::{json, Value};

#[derive(Debug, Clone, Serialize)]
pub struct LevelRow {
    ts: i64,
    level: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AaGainRow {
    ts: i64,
    amount: i64,
    now_have: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct AaSpendRow {
    ts: i64,
    ability: String,
    cost: i64,
    /// Only the `You have improved X <rank>` shape states one; omitted otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    rank: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AaPotionRow {
    ts: i64,
}

#[derive(Default)]
pub struct LevelingModule {
    levels: Vec<LevelRow>,
    aa_gains: Vec<AaGainRow>,
    aa_spends: Vec<AaSpendRow>,
    aa_potions: Vec<AaPotionRow>,
    seq: i64,
}

impl LevelingModule {
    pub fn new() -> Self {
        Self::default()
    }
}

impl EqModule for LevelingModule {
    fn id(&self) -> &'static str {
        "leveling"
    }

    fn reset(&mut self) {
        self.levels.clear();
        self.aa_gains.clear();
        self.aa_spends.clear();
        self.aa_potions.clear();
        self.seq = 0;
    }

    fn on_event(&mut self, ev: &Event, _live: bool) {
        self.seq = ev.seq();
        match ev.kind() {
            // Character rebirth (Task #49): the prior epoch's levels/AA belong to a dead same-name
            // character, and the AA identity (allocated/unspent/earned) is only true without them.
            "epoch" => {
                self.levels.clear();
                self.aa_gains.clear();
                self.aa_spends.clear();
                self.aa_potions.clear();
            }
            "level" => self.levels.push(LevelRow {
                ts: ev.ts(),
                level: ev.int("level").unwrap_or(0),
            }),
            "aaGain" => self.aa_gains.push(AaGainRow {
                ts: ev.ts(),
                amount: ev.int("amount").unwrap_or(0),
                now_have: ev.int("nowHave").unwrap_or(0),
            }),
            "aaSpend" => self.aa_spends.push(AaSpendRow {
                ts: ev.ts(),
                ability: ev.str("ability").unwrap_or_default().to_string(),
                cost: ev.int("cost").unwrap_or(0),
                rank: ev.int("rank"),
            }),
            "aaPotion" => self.aa_potions.push(AaPotionRow { ts: ev.ts() }),
            _ => {}
        }
    }

    /// THE DIRTY BIT (JOS-487) — the same cursor `snapshot` publishes, without building the
    /// state to read it. See `EqModule::published_seq`.
    fn published_seq(&self) -> Option<i64> {
        Some(self.seq)
    }

    fn snapshot(&self) -> Value {
        json!({
            "seq": self.seq,
            "state": {
                "levels": self.levels,
                "aaGains": self.aa_gains,
                "aaSpends": self.aa_spends,
                "aaPotions": self.aa_potions
            }
        })
    }
}
