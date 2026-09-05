//! The four statements about the character — its own `/who` row, a skill tick, the active special
//! attack, and a primary-class unlock — plus the item-activation line.

use crate::event::{Ev, Key, Kind};
use crate::jsstr::js_trim;
use regex::Regex;

use super::Ctx;

const CLASS_UNLOCK_PREFIX: &str = "You have completed achievement: Primary Class Unlock - ";

pub struct WhoRes {
    who_row: Regex,
    who_zone_shortname: Regex,
    corpse_suffix: Regex,
    skill_up: Regex,
    special_attack: Regex,
    item_activate: Regex,
}

impl Default for WhoRes {
    fn default() -> Self {
        Self::new()
    }
}

impl WhoRes {
    pub fn new() -> Self {
        let s = crate::jsstr::JS_S;
        WhoRes {
            who_row: Regex::new(&format!(
                r"^{s}*(?:\* RIP \*{s}*)?(?:AFK{s}+)?\[([0-9]+) ([A-Z]{{3}}(?:/[A-Z]{{3}})*)\] (.+?)(?: \(([^)]*)\))?(?: <([^>]*)>)?{s}+ZONE: (.+?){s}*$"
            ))
            .unwrap(),
            who_zone_shortname: Regex::new(&format!(r"{s}*\([a-z0-9_]+\)$")).unwrap(),
            corpse_suffix: Regex::new(r"['`\u{2019}]s corpse$").unwrap(),
            skill_up: Regex::new(r"^You have become better at (.+?)!(?: \(([0-9]+)\))?$").unwrap(),
            special_attack: Regex::new(
                r"^You will now use (.+?)(?: instead of (.+?))? while (auto )?attacking\.$",
            )
            .unwrap(),
            item_activate: Regex::new(
                r"^Your (.+?) (shimmers briefly|feels alive with power)\.$",
            )
            .unwrap(),
        }
    }
}

/// The character's own `/who` row. The self-name check is the whole guard.
pub fn classify_self_who(r: &WhoRes, character: Option<&str>, c: &Ctx, out: &mut Ev) -> bool {
    let Some(self_name) = character.filter(|s| !s.is_empty()) else {
        return false;
    };
    if !c.text.contains("ZONE: ") {
        return false;
    }
    let Some(m) = r.who_row.captures(c.text) else {
        return false;
    };
    let name = r.corpse_suffix.replace(js_trim(&m[3]), "").to_string();
    if name.to_lowercase() != js_trim(self_name).to_lowercase() {
        return false;
    }
    out.begin(Kind::SelfWho);
    out.envelope(c.seq, c.ts, c.raw);
    out.i(Key::Level, m[1].parse().unwrap_or(0));
    out.strs(
        Key::Classes,
        &m[2].split('/').map(|s| s.to_string()).collect::<Vec<_>>(),
    );
    let race = m
        .get(4)
        .map_or(String::new(), |g| js_trim(g.as_str()).to_string());
    if !race.is_empty() {
        out.s(Key::Race, &race);
    }
    let zone = js_trim(&r.who_zone_shortname.replace(&m[6], "")).to_string();
    if !zone.is_empty() {
        out.s(Key::Zone, &zone);
    }
    true
}

/// Skill ticks. The skill string is kept exactly as the client prints it.
pub fn classify_skill_up(r: &WhoRes, c: &Ctx, out: &mut Ev) -> bool {
    if !c.text.starts_with("You have become better at ") {
        return false;
    }
    let Some(m) = r.skill_up.captures(c.text) else {
        return false;
    };
    out.begin(Kind::SkillUp);
    out.envelope(c.seq, c.ts, c.raw);
    out.s(Key::Skill, js_trim(&m[1]));
    if let Some(v) = m.get(2) {
        out.i(Key::Value, v.as_str().parse().unwrap_or(0));
    }
    true
}

/// The active special attack. A blank skill is refused rather than emitted.
pub fn classify_special_attack(r: &WhoRes, c: &Ctx, out: &mut Ev) -> bool {
    if !c.text.starts_with("You will now use ") {
        return false;
    }
    let Some(m) = r.special_attack.captures(c.text) else {
        return false;
    };
    let skill = js_trim(&m[1]).to_string();
    if skill.is_empty() {
        return false;
    }
    out.begin(Kind::SpecialAttack);
    out.envelope(c.seq, c.ts, c.raw);
    out.s(Key::Skill, &skill);
    out.b(Key::AutoAttack, m.get(3).is_some());
    let replaces = m.get(2).map(|g| js_trim(g.as_str())).unwrap_or("");
    if !replaces.is_empty() {
        out.s(Key::Replaces, replaces);
    }
    true
}

/// A class unlocked: self only, and anchored at the start of the message.
pub fn classify_class_unlock(c: &Ctx, out: &mut Ev) -> bool {
    if c.text.as_bytes().first() != Some(&b'Y') || !c.text.starts_with(CLASS_UNLOCK_PREFIX) {
        return false;
    }
    let class_name = js_trim(&c.text[CLASS_UNLOCK_PREFIX.len()..]);
    if class_name.is_empty() {
        return false;
    }
    out.begin(Kind::ClassUnlock);
    out.envelope(c.seq, c.ts, c.raw);
    out.s(Key::ClassName, class_name);
    true
}

/// An item cast something: `Your <item> shimmers briefly.` / `… feels alive with power.`
pub fn classify_item_activate(r: &WhoRes, c: &Ctx, out: &mut Ev) -> bool {
    if !c.text.starts_with("Your ") {
        return false;
    }
    let Some(m) = r.item_activate.captures(c.text) else {
        return false;
    };
    let item = js_trim(&m[1]).to_string();
    if item.is_empty() {
        return false;
    }
    out.begin(Kind::ItemActivate);
    out.envelope(c.seq, c.ts, c.raw);
    out.s(Key::Item, &item);
    out.s(
        Key::Effect,
        if &m[2] == "shimmers briefly" {
            "shimmer"
        } else {
            "alive"
        },
    );
    true
}
