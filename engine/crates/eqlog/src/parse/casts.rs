//! The cast lifecycle, charm and crowd control, buff fades, pet ownership, stances, gems, the
//! illusion click-off, rogue poisons, the DB-gated buff events, and — matched last of all —
//! spell-landing emotes.

use crate::event::{Ev, Key, Kind};
use crate::names::{id_key, norm};
use crate::spelldb::SpellDb;
use crate::stems::cc_stems_test;
use regex::Regex;
use std::collections::HashMap;

use super::data::{POISON_BY_COAT_MSG, POISON_DRY_MSG, POISON_PROCS};
use super::Ctx;

/// The six exact sentences a pet speaks out loud, in order.
const PET_SAY_LINES: [(&str, &str); 6] = [
    ("follow", "Following you, Master."),
    ("regroup", "Now regrouping, master."),
    ("calm", "Sorry, Master... calming down."),
    (
        "hold",
        "Now holding, Master.  I will not start new attacks until ordered.",
    ),
    ("comply", "As you wish, oh great one."),
    (
        "illegalTarget",
        "I beg forgiveness, Master.  That is not a legal target.",
    ),
];

const CAST_RESUMED_LINE: &str = "You regain your concentration and continue your casting.";

pub struct CastRes {
    charm: Regex,
    uncharm: Regex,
    cc_apply: Regex,
    cc_wake: Regex,
    pet_claim: Regex,
    pet_say: Regex,
    pet_leader: Regex,
    cast_begin: Regex,
    other_cast_begin: Regex,
    cast_fizzle: Regex,
    cast_interrupt: Regex,
    buff_fade_pet: Regex,
    buff_fade_self: Regex,
    aa_activate: Regex,
    stance: Regex,
    invocation: Regex,
    memorize_begin: Regex,
    memorize_done: Regex,
    forget: Regex,
    spell_set: Regex,
    emote_self: Regex,
    emote_pet: Regex,
    coat_other_named: Regex,
    coat_other_generic: Regex,
    article: Regex,
    single_word_name: Regex,
    /// Last word of every proc emote to the emotes that end with it.
    proc_by_last_word: HashMap<&'static str, Vec<usize>>,
    say_kind_by_text: HashMap<&'static str, &'static str>,
}

impl Default for CastRes {
    fn default() -> Self {
        Self::new()
    }
}

impl CastRes {
    pub fn new() -> Self {
        let s = crate::jsstr::JS_S;
        let six = PET_SAY_LINES
            .iter()
            .map(|(_, sentence)| regex::escape(sentence))
            .collect::<Vec<_>>()
            .join("|");
        let mut proc_by_last_word: HashMap<&'static str, Vec<usize>> = HashMap::new();
        for (i, p) in POISON_PROCS.iter().enumerate() {
            let w = match p.suffix.rfind(' ') {
                Some(at) => &p.suffix[at + 1..],
                None => p.suffix,
            };
            proc_by_last_word.entry(w).or_default().push(i);
        }
        CastRes {
            charm: Regex::new(r"^(.+?) has been charmed\.$").unwrap(),
            uncharm: Regex::new(r"^Your (.+?) spell has worn off of (.+?)\.$").unwrap(),
            cc_apply: Regex::new(r"^(.+?) has been (mesmerized|enthralled|entranced|ensnared)\.$")
                .unwrap(),
            cc_wake: Regex::new(r"^(.+?) has been awakened by (.+?)\.$").unwrap(),
            pet_claim: Regex::new(
                r"^(.+?) told you, '(?:Attacking .+ Master|I am unable to wake .+?, Master)\.'$",
            )
            .unwrap(),
            pet_say: Regex::new(&format!(r"^(.+?) says, '({six})'$")).unwrap(),
            pet_leader: Regex::new(r"^(.+?) says, 'My leader is (.+?)\.'$").unwrap(),
            cast_begin: Regex::new(r"^You begin (casting|singing) (.+?)\.$").unwrap(),
            other_cast_begin: Regex::new(r"^(.+?) begins (?:casting|singing) (.+?)\.$").unwrap(),
            cast_fizzle: Regex::new(r"^Your (.+?) spell fizzles!$").unwrap(),
            cast_interrupt: Regex::new(r"^Your (.+?) spell is interrupted\.$").unwrap(),
            buff_fade_pet: Regex::new(r"^Your pet's (.+?) spell has worn off\.$").unwrap(),
            buff_fade_self: Regex::new(r"^Your (.+?) spell has worn off\.$").unwrap(),
            aa_activate: Regex::new(r"^You activate (.+?)\.$").unwrap(),
            stance: Regex::new(r"^You assume an? (.+?) stance\.$").unwrap(),
            invocation: Regex::new(r"^You begin reciting the (.+?) invocation\.$").unwrap(),
            memorize_begin: Regex::new(r"^Beginning to memorize (.+?)\.\.\.$").unwrap(),
            memorize_done: Regex::new(r"^You have finished memorizing (.+?)\.$").unwrap(),
            forget: Regex::new(r"^You forget (.+?)\.$").unwrap(),
            spell_set: Regex::new(r"^Spell set (.+?) (saved|loaded|deleted)\.$").unwrap(),
            emote_self: Regex::new(r"^You (?:feel|look|sense|seem)(?-u:\b)[^.]*\.$").unwrap(),
            emote_pet: Regex::new(
                r"^([A-Z][A-Za-z'`]*(?: [A-Za-z'`]+)*) (?:feels|looks|seems)(?-u:\b)[^.]*\.$",
            )
            .unwrap(),
            coat_other_named: Regex::new(r"^(.+?) coats their blades in (.+?)!$").unwrap(),
            coat_other_generic: Regex::new(&format!(r"^(.+?){s}?coats their blades in poison\.$"))
                .unwrap(),
            article: Regex::new(&format!(r"(?i)^(?:a|an|the){s}")).unwrap(),
            single_word_name: Regex::new(r"^[A-Z][A-Za-z`']*$").unwrap(),
            proc_by_last_word,
            say_kind_by_text: PET_SAY_LINES.iter().map(|(k, s)| (*s, *k)).collect(),
        }
    }
}

/// `You begin casting|singing <Spell>.` — the player's own cast, with the verb kept.
fn own_cast_begin(r: &CastRes, c: &Ctx, out: &mut Ev) -> bool {
    let Some(m) = r.cast_begin.captures(c.text) else {
        return false;
    };
    out.begin(Kind::CastBegin);
    out.envelope(c.seq, c.ts, c.raw);
    out.s(Key::Spell, crate::jsstr::js_trim(&m[2]));
    // Absent rather than false for a cast.
    if &m[1] == "singing" {
        out.b(Key::Sung, true);
    }
    true
}

pub fn classify_cast_lifecycle(r: &CastRes, c: &Ctx, out: &mut Ev) -> bool {
    let text = c.text;
    if text.starts_with("You begin ") && own_cast_begin(r, c, out) {
        return true;
    }
    if text.contains(" begins casting ") || text.contains(" begins singing ") {
        if let Some(m) = r.other_cast_begin.captures(text) {
            if id_key(&m[1]) != "you" {
                out.begin(Kind::OtherCastBegin);
                out.envelope(c.seq, c.ts, c.raw);
                out.s(Key::Caster, &norm(&m[1]));
                out.s(Key::Spell, crate::jsstr::js_trim(&m[2]));
                return true;
            }
        }
    }
    if text.contains("spell fizzles!") {
        if let Some(m) = r.cast_fizzle.captures(text) {
            out.begin(Kind::CastFizzle);
            out.envelope(c.seq, c.ts, c.raw);
            out.s(Key::Spell, crate::jsstr::js_trim(&m[1]));
            return true;
        }
    }
    if text.contains("spell is interrupted.") {
        if let Some(m) = r.cast_interrupt.captures(text) {
            out.begin(Kind::CastInterrupted);
            out.envelope(c.seq, c.ts, c.raw);
            out.s(Key::Spell, crate::jsstr::js_trim(&m[1]));
            return true;
        }
    }
    if text == CAST_RESUMED_LINE {
        out.begin(Kind::CastResumed);
        out.envelope(c.seq, c.ts, c.raw);
        return true;
    }
    false
}

/// Charm application, with the DB-gated candidate list.
pub fn classify_charm(r: &CastRes, db: Option<&SpellDb>, c: &Ctx, out: &mut Ev) -> bool {
    if c.text.contains("has been charmed") {
        let Some(m) = r.charm.captures(c.text) else {
            return false;
        };
        let cands = db.and_then(|db| db.match_cast_on_other(c.text));
        out.begin(Kind::Charm);
        out.envelope(c.seq, c.ts, c.raw);
        out.s(Key::Mob, &norm(&m[1]));
        if let Some((entry, _)) = cands {
            let db = db.expect("a hit implies a db");
            out.cands_nd(
                Key::Candidates,
                entry
                    .cands
                    .iter()
                    .map(|&i| (db.entry(i).name.clone(), db.entry(i).duration_ms)),
            );
        }
        return true;
    }
    classify_non_enchanter_charm(db, c, out)
}

/// `<mob> blinks.` / `<mob> moans.` — admitted only when the DB's candidate list is entirely
/// charm-family, so a future scrape shrinks the rule rather than misfiling.
fn classify_non_enchanter_charm(db: Option<&SpellDb>, c: &Ctx, out: &mut Ev) -> bool {
    if !c.text.ends_with(" blinks.") && !c.text.ends_with(" moans.") {
        return false;
    }
    let Some(db) = db else { return false };
    let Some((entry, target)) = db.match_cast_on_other(c.text) else {
        return false;
    };
    if entry.cands.is_empty()
        || !entry
            .cands
            .iter()
            .all(|&i| db.is_charm_spell(&db.entry(i).name))
    {
        return false;
    }
    out.begin(Kind::Charm);
    out.envelope(c.seq, c.ts, c.raw);
    out.s(Key::Mob, &norm(&target));
    out.cands_nd(
        Key::Candidates,
        entry
            .cands
            .iter()
            .map(|&i| (db.entry(i).name.clone(), db.entry(i).duration_ms)),
    );
    true
}

/// "worn off" — uncharm, CC refresh or named-target fade, else the targetless self/pet fade.
pub fn classify_worn_off(r: &CastRes, db: Option<&SpellDb>, c: &Ctx, out: &mut Ev) -> bool {
    let text = c.text;
    if text.contains("worn off of") {
        let Some(m) = r.uncharm.captures(text) else {
            return false;
        };
        let is_charm = match db {
            Some(db) => db.is_charm_spell(&m[1]),
            // With no DB installed, the charm test is the stem roster itself.
            None => crate::stems::charm_stems_test(&m[1]),
        };
        if is_charm {
            out.begin(Kind::Uncharm);
            out.envelope(c.seq, c.ts, c.raw);
            out.s(Key::Mob, &norm(&m[2]));
            out.s(Key::Spell, crate::jsstr::js_trim(&m[1]));
            return true;
        }
        if cc_stems_test(&m[1]) {
            out.begin(Kind::Cc);
            out.envelope(c.seq, c.ts, c.raw);
            out.s(Key::Mob, &norm(&m[2]));
            out.s(Key::Spell, crate::jsstr::js_trim(&m[1]));
            out.b(Key::Refresh, true);
            return true;
        }
        out.begin(Kind::BuffFade);
        out.envelope(c.seq, c.ts, c.raw);
        out.s(Key::Spell, crate::jsstr::js_trim(&m[1]));
        out.s(Key::Target, &norm(&m[2]));
        return true;
    } else if text.contains("worn off.") {
        if let Some(m) = r.buff_fade_pet.captures(text) {
            out.begin(Kind::BuffFade);
            out.envelope(c.seq, c.ts, c.raw);
            out.s(Key::Spell, crate::jsstr::js_trim(&m[1]));
            out.s(Key::Target, "pet");
            return true;
        }
        if let Some(m) = r.buff_fade_self.captures(text) {
            out.begin(Kind::BuffFade);
            out.envelope(c.seq, c.ts, c.raw);
            out.s(Key::Spell, crate::jsstr::js_trim(&m[1]));
            return true;
        }
    }
    false
}

/// Crowd-control application (mez/root, not charm), with the DB-gated candidate list.
pub fn classify_cc_apply(r: &CastRes, db: Option<&SpellDb>, c: &Ctx, out: &mut Ev) -> bool {
    if !c.text.contains("has been ") {
        return false;
    }
    let Some(m) = r.cc_apply.captures(c.text) else {
        return false;
    };
    let hit = db.and_then(|db| db.match_cast_on_other(c.text));
    out.begin(Kind::Cc);
    out.envelope(c.seq, c.ts, c.raw);
    out.s(Key::Mob, &norm(&m[1]));
    out.s(Key::Verb, &m[2]);
    if let Some((entry, _)) = hit {
        let db = db.expect("a hit implies a db");
        out.cands_nd(
            Key::Candidates,
            entry
                .cands
                .iter()
                .map(|&i| (db.entry(i).name.clone(), db.entry(i).duration_ms)),
        );
    }
    true
}

pub fn classify_cc_wake(r: &CastRes, c: &Ctx, out: &mut Ev) -> bool {
    if !c.text.contains(" has been awakened by ") {
        return false;
    }
    let Some(m) = r.cc_wake.captures(c.text) else {
        return false;
    };
    out.begin(Kind::CcWake);
    out.envelope(c.seq, c.ts, c.raw);
    out.s(Key::Mob, &norm(&m[1]));
    out.s(Key::By, &norm(&m[2]));
    true
}

pub fn classify_pet_claim(r: &CastRes, c: &Ctx, out: &mut Ev) -> bool {
    if !c.text.contains(" told you, '") {
        return false;
    }
    let Some(m) = r.pet_claim.captures(c.text) else {
        return false;
    };
    out.begin(Kind::PetClaim);
    out.envelope(c.seq, c.ts, c.raw);
    out.s(Key::Name, &norm(&m[1]));
    out.s(Key::Via, "tell");
    true
}

pub fn classify_pet_say(r: &CastRes, c: &Ctx, out: &mut Ev) -> bool {
    if !c.text.contains(" says, '") {
        return false;
    }
    let Some(m) = r.pet_say.captures(c.text) else {
        return false;
    };
    let Some(say) = r.say_kind_by_text.get(&m[2]) else {
        return false;
    };
    out.begin(Kind::PetSay);
    out.envelope(c.seq, c.ts, c.raw);
    out.s(Key::Name, &norm(&m[1]));
    out.s(Key::Say, say);
    true
}

/// `<Name> says, 'My leader is <You>.'` — the `/pet who leader` answer, which binds.
pub fn classify_pet_leader(r: &CastRes, character: Option<&str>, c: &Ctx, out: &mut Ev) -> bool {
    let Some(self_name) = character.filter(|s| !s.is_empty()) else {
        return false;
    };
    if !c.text.contains(" says, 'My leader is ") {
        return false;
    }
    let Some(m) = r.pet_leader.captures(c.text) else {
        return false;
    };
    if m[2].to_lowercase() != crate::jsstr::js_trim(self_name).to_lowercase() {
        return false;
    }
    out.begin(Kind::PetClaim);
    out.envelope(c.seq, c.ts, c.raw);
    out.s(Key::Name, &norm(&m[1]));
    out.s(Key::Via, "leader");
    true
}

/// The same answer about somebody else; must run after `classify_pet_leader`.
pub fn classify_ally_pet_leader(
    r: &CastRes,
    character: Option<&str>,
    c: &Ctx,
    out: &mut Ev,
) -> bool {
    let Some(self_name) = character.filter(|s| !s.is_empty()) else {
        return false;
    };
    if !c.text.contains(" says, 'My leader is ") {
        return false;
    }
    let Some(m) = r.pet_leader.captures(c.text) else {
        return false;
    };
    let owner = &m[2];
    if owner.to_lowercase() == crate::jsstr::js_trim(self_name).to_lowercase() {
        return false;
    }
    if !is_player_shaped_name(r, owner) {
        return false;
    }
    out.begin(Kind::AllyPetLeader);
    out.envelope(c.seq, c.ts, c.raw);
    out.s(Key::Pet, &norm(&m[1]));
    out.s(Key::Owner, &norm(owner));
    true
}

/// A leading article is the mob marker; a player is one capitalized word.
fn is_player_shaped_name(r: &CastRes, name: &str) -> bool {
    let n = crate::jsstr::js_trim(name);
    if n.is_empty() {
        return false;
    }
    if r.article.is_match(n) {
        return false;
    }
    r.single_word_name.is_match(n)
}

pub fn classify_aa_activate(r: &CastRes, c: &Ctx, out: &mut Ev) -> bool {
    if !c.text.starts_with("You activate ") {
        return false;
    }
    let Some(m) = r.aa_activate.captures(c.text) else {
        return false;
    };
    out.begin(Kind::AaActivate);
    out.envelope(c.seq, c.ts, c.raw);
    out.s(Key::Name, crate::jsstr::js_trim(&m[1]));
    true
}

pub fn classify_stance(r: &CastRes, c: &Ctx, out: &mut Ev) -> bool {
    if c.text.starts_with("You assume ") {
        if let Some(m) = r.stance.captures(c.text) {
            out.begin(Kind::StanceChange);
            out.envelope(c.seq, c.ts, c.raw);
            out.s(Key::Stance, &crate::jsstr::js_trim(&m[1]).to_lowercase());
            return true;
        }
    }
    if c.text.starts_with("You begin reciting ") {
        if let Some(m) = r.invocation.captures(c.text) {
            out.begin(Kind::InvocationChange);
            out.envelope(c.seq, c.ts, c.raw);
            out.s(
                Key::Invocation,
                &crate::jsstr::js_trim(&m[1]).to_lowercase(),
            );
            return true;
        }
    }
    false
}

/// The memorize / forget / spell-set family. Each of the four prefixes returns, match or not.
pub fn classify_spell_gems(r: &CastRes, c: &Ctx, out: &mut Ev) -> bool {
    let text = c.text;
    if text.starts_with("You forget ") {
        let Some(m) = r.forget.captures(text) else {
            return false;
        };
        out.begin(Kind::SpellForget);
        out.envelope(c.seq, c.ts, c.raw);
        out.s(Key::Spell, crate::jsstr::js_trim(&m[1]));
        return true;
    }
    if text.starts_with("You have finished memorizing ") {
        let Some(m) = r.memorize_done.captures(text) else {
            return false;
        };
        out.begin(Kind::SpellMemorize);
        out.envelope(c.seq, c.ts, c.raw);
        out.s(Key::Spell, crate::jsstr::js_trim(&m[1]));
        out.b(Key::Done, true);
        return true;
    }
    if text.starts_with("Beginning to memorize ") {
        let Some(m) = r.memorize_begin.captures(text) else {
            return false;
        };
        out.begin(Kind::SpellMemorize);
        out.envelope(c.seq, c.ts, c.raw);
        out.s(Key::Spell, crate::jsstr::js_trim(&m[1]));
        out.b(Key::Done, false);
        return true;
    }
    if text.starts_with("Spell set ") {
        if let Some(m) = r.spell_set.captures(text) {
            out.begin(Kind::SpellSet);
            out.envelope(c.seq, c.ts, c.raw);
            out.s(Key::Set, crate::jsstr::js_trim(&m[1]));
            out.s(Key::Action, &m[2]);
            return true;
        }
    }
    false
}

pub fn classify_illusion_fade(c: &Ctx, out: &mut Ev) -> bool {
    if c.text != "Your illusion fades." {
        return false;
    }
    out.begin(Kind::IllusionFade);
    out.envelope(c.seq, c.ts, c.raw);
    out.s(Key::Target, "self");
    true
}

/// Rogue poisons, coat half: first- and third-person.
pub fn classify_poison_coat(r: &CastRes, c: &Ctx, out: &mut Ev) -> bool {
    let text = c.text;
    if text.starts_with("You coat your blades ") && text.ends_with('.') {
        // An unknown coat line is still a coat — say so, decline to name the poison.
        let p = POISON_BY_COAT_MSG.iter().find(|(msg, _, _)| *msg == text);
        out.begin(Kind::PoisonCoat);
        out.envelope(c.seq, c.ts, c.raw);
        match p {
            Some((_, name, group)) => {
                out.s(Key::Poison, name);
                out.s(Key::Group, group);
            }
            None => {
                out.s(Key::Poison, "unknown");
                out.s(Key::Group, "unknown");
            }
        }
        out.s(Key::Who, "you");
        return true;
    }
    if text.contains("coats their blades in ") {
        if let Some(m) = r.coat_other_named.captures(text) {
            let probe = format!("You coat your blades in {}.", crate::jsstr::js_trim(&m[2]));
            let p = POISON_BY_COAT_MSG.iter().find(|(msg, _, _)| *msg == probe);
            out.begin(Kind::PoisonCoat);
            out.envelope(c.seq, c.ts, c.raw);
            out.s(Key::Poison, p.map_or("unknown", |(_, name, _)| name));
            out.s(Key::Group, p.map_or("unknown", |(_, _, group)| group));
            out.s(Key::Who, &norm(&m[1]));
            return true;
        }
        if let Some(m) = r.coat_other_generic.captures(text) {
            out.begin(Kind::PoisonCoat);
            out.envelope(c.seq, c.ts, c.raw);
            out.s(Key::Poison, "unknown");
            out.s(Key::Group, "unknown");
            out.s(Key::Who, &norm(&m[1]));
            return true;
        }
    }
    false
}

/// The proc emote's target (the text before the suffix), or None when this proc doesn't match.
fn poison_proc_target(text: &str, suffix: &str) -> Option<String> {
    let tail = if suffix.starts_with("'s") {
        suffix.to_string()
    } else {
        format!(" {suffix}")
    };
    if !text.ends_with(&tail) || text.len() <= tail.len() {
        return None;
    }
    let t = crate::jsstr::js_trim(&text[..text.len() - tail.len()]);
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

/// Rogue poisons, dry + Strike-proc half.
pub fn classify_poison_proc(r: &CastRes, c: &Ctx, out: &mut Ev) -> bool {
    let text = c.text;
    if let Some((_, group)) = POISON_DRY_MSG.iter().find(|(msg, _)| *msg == text) {
        out.begin(Kind::PoisonDry);
        out.envelope(c.seq, c.ts, c.raw);
        out.s(Key::Group, group);
        return true;
    }
    if !(text.ends_with('!') || text.ends_with('.')) {
        return false;
    }
    let last_word = match text.rfind(' ') {
        Some(at) => &text[at + 1..],
        None => text,
    };
    let Some(cands) = r.proc_by_last_word.get(last_word) else {
        return false;
    };
    for &i in cands {
        let p = &POISON_PROCS[i];
        if let Some(target) = poison_proc_target(text, p.suffix) {
            out.begin(Kind::PoisonProc);
            out.envelope(c.seq, c.ts, c.raw);
            out.s(Key::Strike, p.strikes[0]);
            out.strs(
                Key::Candidates,
                &p.strikes.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
            );
            out.s(Key::Effect, p.effect);
            out.s(Key::Target, &norm(&target));
            return true;
        }
    }
    false
}

/// `spell`, `illusion` and `durationMs` come from the first candidate.
fn buff_apply_event(db: &SpellDb, c: &Ctx, out: &mut Ev, target: &str, cands: &[usize]) {
    let first = db.entry(cands[0]);
    out.begin(Kind::BuffApply);
    out.envelope(c.seq, c.ts, c.raw);
    out.s(Key::Target, target);
    out.s(Key::Spell, &first.name);
    out.b(Key::Illusion, first.illusion);
    out.i_or_null(Key::DurationMs, first.duration_ms);
    out.cands_ndi(
        Key::Candidates,
        cands.iter().map(|&i| {
            let s = db.entry(i);
            (s.name.clone(), s.duration_ms, s.illusion)
        }),
    );
}

/// Message-driven buff events — DB-gated, additive. With no DB these never fire.
pub fn classify_db_buff(db: Option<&SpellDb>, c: &Ctx, out: &mut Ev) -> bool {
    let Some(db) = db else { return false };
    if let Some(cands) = db.cast_on_you(c.text) {
        if !cands.is_empty() {
            let cands = cands.to_vec();
            buff_apply_event(db, c, out, "self", &cands);
            return true;
        }
    }
    if let Some(worn) = db.wears_off(c.text) {
        if !worn.is_empty() {
            out.begin(Kind::BuffWearOff);
            out.envelope(c.seq, c.ts, c.raw);
            out.s(Key::Spell, &db.entry(worn[0]).name);
            out.strs(
                Key::Candidates,
                &worn
                    .iter()
                    .map(|&i| db.entry(i).name.clone())
                    .collect::<Vec<_>>(),
            );
            out.s(Key::Target, "self");
            return true;
        }
    }
    if let Some((entry, target)) = db.match_cast_on_other(c.text) {
        let cands = entry.cands.clone();
        buff_apply_event(db, c, out, &norm(&target), &cands);
        return true;
    }
    false
}

/// Spell-landing emotes — matched last so they never shadow a real family.
pub fn classify_spell_emote(r: &CastRes, c: &Ctx, out: &mut Ev) -> bool {
    if c.text.starts_with("You ") {
        if r.emote_self.is_match(c.text) {
            out.begin(Kind::SpellEmote);
            out.envelope(c.seq, c.ts, c.raw);
            out.s(Key::Subject, "self");
            out.s(Key::Text, c.text);
            return true;
        }
        return false;
    }
    let Some(m) = r.emote_pet.captures(c.text) else {
        return false;
    };
    if id_key(&m[1]) == "you" {
        return false;
    }
    out.begin(Kind::SpellEmote);
    out.envelope(c.seq, c.ts, c.raw);
    out.s(Key::Subject, &norm(&m[1]));
    out.s(Key::Text, c.text);
    true
}
