//! THE SINGLE PARSE PASS — `src/main/log/parser.ts`.
//!
//! THE CASCADE ORDER BELOW IS SEMANTIC, NOT COSMETIC, and the TS file's header says why for each
//! adjacency: the resist family tests YOUR form before the named-caster form because 712 spell names
//! contain `'s`; the spell-landing emote is matched LAST so it can never shadow a real family; item
//! merges come after loot so an auto-merge-on-pickup stays one 'combined' loot event. NEVER REORDER.
//!
//! The per-family comments over there are the argument for each entry's POSITION and are not
//! repeated here — this file's job is to be checkable against that list at a glance, so it is the
//! list and nothing else.

pub mod acquire;
pub mod casts;
pub mod combat;
pub mod data;
pub mod group;
pub mod session;
pub mod who;
pub mod world;

use crate::event::{Ev, Kind};
use crate::spelldb::SpellDb;
use crate::timestamp::Clock;
use regex::Regex;
use std::sync::Arc;

/// One log line, pre-split — `ClassifyCtx`. `text` is the message with the `[timestamp] ` prefix
/// removed.
pub struct Ctx<'a> {
    pub text: &'a str,
    pub ts: i64,
    pub seq: i64,
    pub raw: &'a str,
}

/// The parser, and everything a parse is a pure function of: the bytes, the spell DB, and the
/// character name (docs/plans/data-server.md ruling 18 — no globals that outlive a parse).
///
/// THE DATABASE IS HELD BY `Arc` RATHER THAN BY VALUE (JOS-478), and that is the whole of that
/// change: a parser still OWNS its view of the catalog and nothing here can mutate it, but two
/// parsers in one process can now be handed the same one. Held by value it could not be, which is
/// what made `engined` rebuild the entire catalog on every attach — 386 ms in a release build, of
/// bytes compiled into the binary. See [`crate::spelldb::shared`] for the argument that a
/// process-wide copy of committed data is not a cache.
pub struct Parser {
    clock: Clock,
    db: Option<Arc<SpellDb>>,
    character: Option<String>,
    line: Regex,
    combat: combat::CombatRes,
    casts: casts::CastRes,
    world: world::WorldRes,
    who: who::WhoRes,
    acquire: acquire::AcquireRes,
    group: group::GroupRes,
    /// Counts stamps that matched `LINE_RE` but not the timestamp pattern — the TS falls back to a
    /// bare `Date.parse` there, and this is how the comparator proves the corpus never needs it.
    pub unparsed_stamps: std::cell::Cell<u64>,
}

impl Parser {
    /// The effective spell DB this parser was built with, if any. Read by the FOLD (JOS-471): the
    /// observedSpellRanks module's catalog probe is `spellDb.byKey`, and it must be the SAME
    /// database the parser is emitting `candidates` out of — two loads is two answers waiting to
    /// disagree after an overlay change.
    pub fn spell_db(&self) -> Option<&SpellDb> {
        // `as_deref` rather than `as_ref`: the `Arc` is how the catalog is HELD, never part of what
        // a caller is handed, so nothing downstream of this crate learns that it is shared.
        self.db.as_deref()
    }

    /// THE CLOCK THIS PARSER STAMPS WITH. Read by the FOLD (JOS-478): `epochDetector`'s launch
    /// anchor is a local-time instant, and it has to be resolved through the SAME zone the events
    /// it is compared against were parsed in — `fold::epoch::launch_ms`'s header is emphatic about
    /// it. Handing over the parser's own is what makes "the same zone" true by construction rather
    /// than by two callers agreeing to pass the same argument.
    pub fn clock(&self) -> &Clock {
        &self.clock
    }

    pub fn new(clock: Clock, db: Option<Arc<SpellDb>>, character: Option<String>) -> Self {
        Parser {
            clock,
            db,
            character,
            // `LINE_RE` — lazy, and a SINGLE optional space between the bracket and the message.
            //
            // THE DOT IS JAVASCRIPT'S (see `jsstr::JS_DOT`), and here that is not pedantry: a chat
            // line carrying a bare CR inside it fails this pattern on the TS side and therefore
            // becomes no event at all. Every OTHER `.` in this crate runs over `text`, which by
            // construction can hold no line terminator once this pattern has matched, so this is the
            // one place the distinction can change an answer.
            line: Regex::new(&format!(
                r"^\[({d}+?)\]{s}?({d}*)$",
                d = crate::jsstr::JS_DOT,
                s = crate::jsstr::JS_S
            ))
            .unwrap(),
            combat: combat::CombatRes::new(),
            casts: casts::CastRes::new(),
            world: world::WorldRes::new(),
            who: who::WhoRes::new(),
            acquire: acquire::AcquireRes::new(),
            group: group::GroupRes::new(),
            unparsed_stamps: std::cell::Cell::new(0),
        }
    }

    /// Parse one raw log line into a canonical event, or `false` if it isn't a timestamped log line.
    /// `seq` is stamped onto the event by the feeder.
    pub fn parse_event(&self, raw: &str, seq: i64, out: &mut Ev) -> bool {
        let Some(pm) = self.line.captures(raw) else {
            return false;
        };
        let ts = self.clock.parse_eq_timestamp(&pm[1]);
        if ts == 0 {
            self.unparsed_stamps.set(self.unparsed_stamps.get() + 1);
        }
        let text_range = pm.get(2).expect("group 2 always participates");
        let c = Ctx {
            text: text_range.as_str(),
            ts,
            seq,
            raw,
        };
        self.classify(&c, out);
        true
    }

    /// The ordered line-shape cascade. Each entry is offered the line and either claims it or
    /// declines. A line matching nothing is `{kind:'unknown'}`.
    fn classify(&self, c: &Ctx, out: &mut Ev) {
        let db = self.db.as_deref();
        let name = self.character.as_deref();
        let claimed = combat::classify_miss(&self.combat, c, out)
            || combat::classify_mitigation(&self.combat, c, out)
            || combat::classify_resist(&self.combat, c, out)
            || combat::classify_damage(&self.combat, c, out)
            || combat::classify_heal(&self.combat, c, out)
            || world::classify_consider(&self.world, c, out)
            || casts::classify_cast_lifecycle(&self.casts, c, out)
            || casts::classify_charm(&self.casts, db, c, out)
            || casts::classify_worn_off(&self.casts, db, c, out)
            || casts::classify_cc_apply(&self.casts, db, c, out)
            || casts::classify_cc_wake(&self.casts, c, out)
            || casts::classify_pet_claim(&self.casts, c, out)
            || casts::classify_pet_say(&self.casts, c, out)
            || casts::classify_pet_leader(&self.casts, name, c, out)
            || casts::classify_ally_pet_leader(&self.casts, name, c, out)
            || world::classify_death(&self.world, c, out)
            || world::classify_zone(&self.world, c, out)
            || session::classify_session_start(c, out)
            || session::classify_camp(c, out)
            || session::classify_output_file(c, out)
            || group::classify_group(&self.group, c, out)
            || world::classify_loot(&self.world, c, out)
            || world::classify_item_merge(&self.world, c, out)
            || acquire::classify_acquire(&self.acquire, c, out)
            || world::classify_turn_in(&self.world, c, out)
            || world::classify_level(&self.world, c, out)
            || world::classify_exp(&self.world, c, out)
            || world::classify_aa(&self.world, c, out)
            || world::classify_aa_potion(c, out)
            || casts::classify_aa_activate(&self.casts, c, out)
            || casts::classify_stance(&self.casts, c, out)
            || casts::classify_spell_gems(&self.casts, c, out)
            || who::classify_self_who(&self.who, name, c, out)
            || who::classify_skill_up(&self.who, c, out)
            || who::classify_special_attack(&self.who, c, out)
            || who::classify_class_unlock(c, out)
            || casts::classify_illusion_fade(c, out)
            || casts::classify_poison_coat(&self.casts, c, out)
            || casts::classify_poison_proc(&self.casts, c, out)
            || casts::classify_db_buff(db, c, out)
            || who::classify_item_activate(&self.who, c, out)
            || casts::classify_spell_emote(&self.casts, c, out);
        if !claimed {
            out.begin(Kind::Unknown);
            out.envelope(c.seq, c.ts, c.raw);
        }
    }
}
