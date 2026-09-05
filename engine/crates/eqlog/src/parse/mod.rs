//! The single parse pass.
//!
//! The cascade order below is semantic, not cosmetic: the resist family tests your own form before
//! the named-caster form because 712 spell names contain `'s`; the spell-landing emote is matched
//! last so it can never shadow a real family; item merges come after loot so an auto-merge on
//! pickup stays one combined loot event. Never reorder.

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

/// One log line, pre-split. `text` is the message with the `[timestamp] ` prefix removed.
pub struct Ctx<'a> {
    pub text: &'a str,
    pub ts: i64,
    pub seq: i64,
    pub raw: &'a str,
}

/// The parser, and everything a parse is a pure function of: the bytes, the spell DB, and the
/// character name. No globals outlive a parse.
///
/// The database is held by `Arc` rather than by value so two parsers in one process can be handed
/// the same one; held by value, every attach rebuilt the catalog at 386 ms in a release build.
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
    /// Stamps that matched the line pattern but not the timestamp pattern. The app falls back to a
    /// bare `Date.parse` there, and this is how the comparator proves the corpus never needs it.
    pub unparsed_stamps: std::cell::Cell<u64>,
}

impl Parser {
    /// The effective spell DB this parser was built with. The fold's catalog probe must be the same
    /// database the parser emits `candidates` out of; two loads is two answers waiting to disagree
    /// after an overlay change.
    pub fn spell_db(&self) -> Option<&SpellDb> {
        // `as_deref` rather than `as_ref`: the `Arc` is how the catalog is held, never part of what
        // a caller is handed, so nothing downstream of this crate learns that it is shared.
        self.db.as_deref()
    }

    /// The clock this parser stamps with. The fold's epoch launch anchor is a local-time instant
    /// and must resolve through the same zone the events were parsed in; handing over the parser's
    /// own clock makes that true by construction rather than by two callers agreeing.
    pub fn clock(&self) -> &Clock {
        &self.clock
    }

    pub fn new(clock: Clock, db: Option<Arc<SpellDb>>, character: Option<String>) -> Self {
        Parser {
            clock,
            db,
            character,
            // Lazy, with a single optional space between the bracket and the message. The dot is
            // JavaScript's (`jsstr::JS_DOT`), which matters here and nowhere else in the crate: a
            // chat line carrying a bare CR must fail this pattern and become no event at all.
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
    /// declines; a line matching nothing is `unknown`.
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
            || world::classify_instance_create(&self.world, c, out)
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
