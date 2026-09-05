//! `src/main/modules/turnins.ts` — completed NPC trades / quest turn-ins.
//!
//! Offers accumulate per NPC until the matching "complete the trade" line closes the group. A trade
//! with a DIFFERENT npc than the open offer group records nothing and still drops the group, which
//! is the TS's exact shape (its `pendingOffer = null` sits outside the `if`).

use crate::event::Event;
use crate::EqModule;
use serde::Serialize;
use serde_json::{json, Value};

#[derive(Debug, Clone, Serialize)]
pub struct TurnInRow {
    ts: i64,
    npc: String,
    items: Vec<String>,
}

struct PendingOffer {
    npc: String,
    items: Vec<String>,
}

#[derive(Default)]
pub struct TurnInsModule {
    turn_ins: Vec<TurnInRow>,
    pending_offer: Option<PendingOffer>,
    seq: i64,
    /// The announce cursor — see [`crate::announce`]. `pending_offer` is not published state: a
    /// handed-over item is a half-formed group nobody can read until the trade closes it.
    announce: crate::announce::Announce,
}

impl TurnInsModule {
    pub fn new() -> Self {
        Self::default()
    }
}

impl EqModule for TurnInsModule {
    fn id(&self) -> &'static str {
        "turnins"
    }

    fn reset(&mut self) {
        self.turn_ins.clear();
        self.pending_offer = None;
        self.seq = 0;
        self.announce.reset();
    }

    fn on_event(&mut self, ev: &Event, _live: bool) {
        self.seq = ev.seq();
        match ev.kind() {
            // Character rebirth. A half-formed offer group goes with it.
            "epoch" => {
                self.turn_ins.clear();
                self.pending_offer = None;
                self.announce.changed(self.seq);
            }
            // An offer publishes nothing: it opens or extends the pending group, which is not in
            // `snapshot()`. Handing items to an NPC and walking away leaves the ledger as it was.
            "offer" => {
                let npc = ev.str("npc").unwrap_or_default().to_string();
                let item = ev.str("item").unwrap_or_default().to_string();
                match self.pending_offer.as_mut() {
                    Some(open) if open.npc == npc => open.items.push(item),
                    _ => {
                        self.pending_offer = Some(PendingOffer {
                            npc,
                            items: vec![item],
                        })
                    }
                }
            }
            "trade" => {
                let npc = ev.str("npc").unwrap_or_default();
                if let Some(open) = self.pending_offer.take() {
                    if open.npc == npc {
                        self.turn_ins.push(TurnInRow {
                            ts: ev.ts(),
                            npc: open.npc,
                            items: open.items,
                        });
                        self.announce.changed(self.seq);
                    }
                }
            }
            _ => {}
        }
    }

    /// Moves on the trade that CLOSED a group, not on every line that passed by. See `announce`.
    fn published_seq(&self) -> Option<i64> {
        Some(self.announce.cursor())
    }

    fn snapshot(&self) -> Value {
        json!({ "seq": self.seq, "state": self.turn_ins })
    }
}
