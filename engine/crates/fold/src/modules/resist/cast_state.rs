//! What the tailed character was doing when a cast went off.
//!
//! Two EQ Legends mechanics move a cast's resist adjust and neither is a property of the spell: the
//! upgrade rank printed on the cast line, and the invocation being recited. Every row records both.
//!
//! The invocation is one of nine mutually exclusive states, tri-valued and never assumed: `None`
//! means no line has stated one, which is where a character who logged in already overchannelling
//! stays. Nothing resets it on a zone or session boundary — it survives a relog and the log will
//! not restate it; only a new source resets it.
//!
//! A proc is not a cast spell and the log has no field that says so, so joining an armed cast is
//! the test. Measured on the owner's log: 19,874 Smiting Strike hits against 0 cast lines.

use super::catalog::caster_class_count;
use super::ledger::CasterKind;
use eqlog::names::spell_canon_key;
use std::collections::{HashMap, HashSet};

/// The invocation name (lowercased by the parser) that carries the -150 resist adjust.
pub const OVERCHANNEL_INVOCATION: &str = "overchannel";

/// How long after a `You begin casting` a landing sentence may still be claimed by it. Comfortably
/// above the longest cast plus its slack; the buffs model uses the same window for the same join.
pub const CAST_JOIN_MS: i64 = 10_000;

/// How many casts can be in flight at once before the oldest stop being reachable.
const MAX_ARMED: usize = 16;

/// One cast in flight, and everything an outcome line may read off it.
#[derive(Debug, Clone)]
pub struct Armed {
    pub spell_key: String,
    pub display: String,
    pub ts: i64,
    pub kind: CasterKind,
    pub level: Option<i64>,
    /// The upgrade rank the cast line printed, 0 when it printed none.
    pub rank: i64,
    /// The invocation state at the moment of the cast, which is the moment that decides the roll.
    pub overchannel: Option<bool>,
    /// Mobs this cast has already printed a damage line for. One cast is one roll, so a spell that
    /// both damages and emotes must not have the emote counted too.
    ///
    /// A set on the cast rather than a cancel on the emote because the game prints the damage
    /// first, every time — a cancel-forward rule would never fire. A DoT's first tick can land
    /// either side of its emote, so both directions are covered.
    pub damaged: HashSet<String>,
}

/// The casts currently in flight. Bounded: only the last handful can still be in window.
#[derive(Debug, Default)]
pub struct ArmedCasts {
    casts: Vec<Armed>,
}

impl ArmedCasts {
    pub fn reset(&mut self) {
        self.casts.clear();
    }

    pub fn arm(&mut self, cast: Armed) {
        self.casts.push(cast);
        if self.casts.len() > MAX_ARMED {
            self.casts.drain(0..self.casts.len() - MAX_ARMED);
        }
    }

    /// A fizzle or an interrupt: a cast that never happened is not a resist.
    pub fn disarm(&mut self, spell_key: &str) {
        self.casts.retain(|a| a.spell_key != spell_key);
    }

    /// The index of the most recent armed cast this line can belong to, without consuming it.
    pub fn peek_at(&self, spell_key: &str, ts: i64) -> Option<usize> {
        for i in (0..self.casts.len()).rev() {
            let cast = &self.casts[i];
            if cast.spell_key != spell_key {
                continue;
            }
            if ts < cast.ts || ts - cast.ts > CAST_JOIN_MS {
                continue;
            }
            return Some(i);
        }
        None
    }

    pub fn note_damaged(&mut self, i: usize, mob_key: String) {
        self.casts[i].damaged.insert(mob_key);
    }

    /// The armed cast an outcome may read its rank and invocation off — this caster's, never
    /// another's: a charmed pet throwing the same spell as you must not inherit your rank.
    /// `peek_at` matches on the spell alone, because its own reader only marks a mob as damaged.
    pub fn owned_by(&self, kind: CasterKind, spell_key: &str, ts: i64) -> Option<&Armed> {
        let cast = &self.casts[self.peek_at(spell_key, ts)?];
        (cast.kind == kind).then_some(cast)
    }

    /// The most recent armed cast this landing sentence can belong to, consumed.
    pub fn take(&mut self, ts: i64, candidates: Option<&[String]>) -> Option<Armed> {
        let keys: Option<HashSet<String>> = candidates.map(|c| {
            c.iter()
                .map(|name| spell_canon_key(name))
                .collect::<HashSet<String>>()
        });
        for i in (0..self.casts.len()).rev() {
            let cast = &self.casts[i];
            if ts < cast.ts || ts - cast.ts > CAST_JOIN_MS {
                continue;
            }
            if let Some(keys) = &keys {
                if !keys.contains(&cast.spell_key) {
                    continue;
                }
            }
            return Some(self.casts.remove(i));
        }
        None
    }
}

#[derive(Debug, Default)]
pub struct CastState {
    overchannel_on: Option<bool>,
    classes: i64,
    /// Song spell key to the last upgrade rank seen for it. Songs are the one family whose
    /// observations do not come through an armed cast — under the Symphonic Aura there is no cast
    /// line at all — so a pulse's rank is remembered from whichever line last printed one.
    song_ranks: HashMap<String, i64>,
}

impl CastState {
    pub fn reset(&mut self) {
        self.overchannel_on = None;
        self.classes = 0;
        self.song_ranks.clear();
    }

    /// `You begin reciting the <name> invocation.` The nine are mutually exclusive.
    pub fn note_invocation(&mut self, invocation: &str) {
        self.overchannel_on = Some(invocation == OVERCHANNEL_INVOCATION);
    }

    /// The character's own `/who` row: the only line in the game that states the loadout.
    pub fn note_classes(&mut self, classes: &[String]) {
        self.classes = caster_class_count(classes);
    }

    pub fn note_song_rank(&mut self, spell_key: &str, rank: i64) {
        if rank > 0 {
            self.song_ranks.insert(spell_key.to_string(), rank);
        }
    }

    pub fn song_rank(&self, spell_key: &str) -> i64 {
        self.song_ranks.get(spell_key).copied().unwrap_or(0)
    }

    /// The state to arm a fresh cast of your own with — the moment that decides the roll.
    pub fn overchannel(&self) -> Option<bool> {
        self.overchannel_on
    }

    /// How many non-hybrid caster classes the character runs: the -15-each half of the overchannel
    /// adjust. Zero until a `/who` row is seen, which is the honest floor — the -150 is certain and
    /// the rest is not.
    pub fn caster_classes(&self) -> i64 {
        self.classes
    }

    /// The invocation as one observation saw it. `armed` is the cast it joined, or `None` when it
    /// joined none: another caster's invocation is unknowable, and an observation with no cast
    /// behind it is a proc.
    pub fn invocation_for(&self, kind: CasterKind, armed: Option<Option<bool>>) -> Option<bool> {
        if kind != CasterKind::SelfCast {
            return None;
        }
        match armed {
            Some(oc) => oc,
            None => Some(false),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn armed(spell: &str, ts: i64, kind: CasterKind) -> Armed {
        Armed {
            spell_key: spell.to_string(),
            display: spell.to_string(),
            ts,
            kind,
            level: None,
            rank: 0,
            overchannel: None,
            damaged: HashSet::new(),
        }
    }

    #[test]
    fn an_outcome_reads_only_its_own_casters_armed_cast() {
        let mut casts = ArmedCasts::default();
        casts.arm(armed("shock of frost", 0, CasterKind::SelfCast));
        assert!(casts
            .owned_by(CasterKind::SelfCast, "shock of frost", 1_000)
            .is_some());
        // A charmed pet throwing the same spell must not inherit your rank.
        assert!(casts
            .owned_by(CasterKind::Npc, "shock of frost", 1_000)
            .is_none());
        // Past the join window, and before the cast, nothing is claimable.
        assert!(casts
            .owned_by(CasterKind::SelfCast, "shock of frost", CAST_JOIN_MS + 1)
            .is_none());
        casts.disarm("shock of frost");
        assert!(casts
            .owned_by(CasterKind::SelfCast, "shock of frost", 1)
            .is_none());
    }

    #[test]
    fn a_landing_sentence_consumes_the_cast_a_candidate_names() {
        let mut casts = ArmedCasts::default();
        casts.arm(armed("clarity", 0, CasterKind::SelfCast));
        casts.arm(armed("malosi", 1, CasterKind::SelfCast));
        let names = vec!["Clarity II".to_string()];
        let took = casts.take(2, Some(&names)).expect("the clarity");
        assert_eq!(took.spell_key, "clarity");
        // …and it is gone, so the same sentence cannot claim it twice.
        assert!(casts.take(2, Some(&names)).is_none());
        // With no candidate list at all the newest in-window cast is taken.
        assert_eq!(casts.take(2, None).expect("the malosi").spell_key, "malosi");
    }

    #[test]
    fn an_observation_with_no_cast_behind_it_is_a_proc_and_a_strangers_is_unknowable() {
        let mut state = CastState::default();
        assert_eq!(
            state.invocation_for(CasterKind::SelfCast, None),
            Some(false)
        );
        assert_eq!(
            state.invocation_for(CasterKind::SelfCast, Some(Some(true))),
            Some(true)
        );
        assert_eq!(state.invocation_for(CasterKind::Pc, Some(Some(true))), None);
        assert_eq!(state.invocation_for(CasterKind::Npc, None), None);
        // Nothing has stated the invocation until a line does.
        assert_eq!(state.overchannel(), None);
        state.note_invocation("empowering");
        assert_eq!(state.overchannel(), Some(false));
        state.note_invocation(OVERCHANNEL_INVOCATION);
        assert_eq!(state.overchannel(), Some(true));
    }
}
