//! WHAT THE TAILED CHARACTER WAS DOING WHEN A CAST WENT OFF (`src/main/resist/castState.ts`,
//! JOS-387).
//!
//! Two EQ Legends mechanics move a cast's resist adjust and neither is a property of the spell: the
//! upgrade RANK the log prints on the cast line, and the INVOCATION the character is currently
//! reciting. Every row records both.
//!
//! ── THE INVOCATION IS A STATE, AND IT IS NEVER ASSUMED ──────────────────────────────────────────
//!
//! Nine mutually-exclusive invocations, one line when you commit to one, and the state holds until
//! another is recited. So the answer has THREE values, not two:
//!
//!   `None`         NOTHING HAS STATED IT. Before the log's first invocation line there is no honest
//!                  answer, and a character who logged in already overchannelling prints nothing at
//!                  all — an app that guessed `false` would model a -150 offset as absent on every
//!                  cast of the session. The estimator counts those observations and refuses to
//!                  weigh them.
//!   `Some(true)`   the last one recited was overchannel.
//!   `Some(false)`  it was one of the other eight.
//!
//! A RELOG CARRIES IT AND WE CANNOT SEE THAT, which is why nothing resets this on a zone line or a
//! session boundary: the character keeps the invocation across a camp, and forgetting it would throw
//! away a fact the log DID state in favour of one it never will. Only starting a new SOURCE resets
//! it, because that is a different log being folded from its own beginning.
//!
//! ── AND A PROC IS NOT A CAST SPELL ──────────────────────────────────────────────────────────────
//!
//! The wiki's -150 is on CAST spells, and the log has no field that says "this was a proc". What it
//! has is the CAST LINE: a proc prints none. MEASURED on the owner's log — 19,874 Smiting Strike
//! hits against 0 `You begin casting Smiting Strike` — so joining an armed cast IS the test for "a
//! cast spell", and an observation that joins none answers `false`.

use super::catalog::caster_class_count;
use super::ledger::CasterKind;
use eqlog::names::spell_canon_key;
use std::collections::{HashMap, HashSet};

/// The invocation name (lowercased by the parser) that carries the -150 resist adjust.
pub const OVERCHANNEL_INVOCATION: &str = "overchannel";

/// How long after a `You begin casting` a landing sentence may still be claimed by it. The JOS-382
/// brief says `castMs + 2.5 s`, which needs the client table; this is the repo's own measured
/// substitute — `buffAnchors.ts OWN_CAST_WINDOW_MS`, the constant the buffs model already uses for
/// exactly this join, and comfortably above the longest cast plus its slack.
pub const CAST_JOIN_MS: i64 = 10_000;

/// How many casts can be in flight at once before the oldest stop being reachable.
const MAX_ARMED: usize = 16;

/// ONE CAST IN FLIGHT, and everything an outcome line may read off it.
#[derive(Debug, Clone)]
pub struct Armed {
    pub spell_key: String,
    pub display: String,
    pub ts: i64,
    pub kind: CasterKind,
    pub level: Option<i64>,
    /// The upgrade rank the cast line printed, 0 when it printed none.
    pub rank: i64,
    /// The invocation state AT THE MOMENT OF THE CAST, which is the moment that decides the roll.
    pub overchannel: Option<bool>,
    /// Mobs this cast has already printed a DAMAGE line for. ONE CAST IS ONE ROLL, and a spell that
    /// both damages and emotes prints both for it — so the emote must not also be counted.
    ///
    /// MEASURED, and the reason this is a set on the CAST rather than a cancel on the emote: the
    /// game prints the damage FIRST, every time. A cancel-forward rule (an emote's landing,
    /// withdrawn when damage follows) therefore never fires, and the fixture that caught it had
    /// seven casts, seven damage lines and seven spurious landings on top. Both directions are
    /// covered now, because a DoT's first tick can land either side of its emote.
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

    /// The index of the most recent armed cast this line can belong to, WITHOUT consuming it.
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

    /// The armed cast an outcome may read its rank and invocation off — THIS CASTER's, never
    /// another's. `peek_at` matches on the spell alone (its own reader only wants to mark a mob as
    /// damaged), and a charmed pet throwing the same spell as you must not inherit your rank.
    pub fn owned_by(&self, kind: CasterKind, spell_key: &str, ts: i64) -> Option<&Armed> {
        let cast = &self.casts[self.peek_at(spell_key, ts)?];
        (cast.kind == kind).then_some(cast)
    }

    /// The most recent armed cast this landing sentence can belong to, CONSUMED.
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

/// `castState.ts CastState`.
#[derive(Debug, Default)]
pub struct CastState {
    overchannel_on: Option<bool>,
    classes: i64,
    /// SONG SPELL KEY -> the last upgrade rank seen for it. Songs are the one family whose
    /// observations do not come through an armed cast (under the Symphonic Aura there is no cast
    /// line at all), so a pulse's rank has to be remembered from whichever line last printed one.
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
    /// the rest is not, and the surfaces say so.
    pub fn caster_classes(&self) -> i64 {
        self.classes
    }

    /// THE INVOCATION AS ONE OBSERVATION SAW IT. `armed` is the cast it joined, or `None` when it
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
        // …and it is GONE, so the same sentence cannot claim it twice.
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
