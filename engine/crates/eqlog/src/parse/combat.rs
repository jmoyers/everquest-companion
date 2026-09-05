//! Misses, mitigation, resists, the damage battery and heals.
//!
//! Every regex below is its app twin with three mechanical substitutions and no others: `\d` →
//! `[0-9]`, `\w` → `[0-9A-Za-z_]` and `\s` → the ECMA class (see jsstr.rs). Those three are
//! ASCII-only in JavaScript and Unicode-aware in the `regex` crate, and a mob name with a
//! non-ASCII letter is exactly the line that would part company.

use crate::event::{Ev, Key, Kind};
use crate::names::norm;
use crate::taxonomy::{damage_category, has_critical, parse_modifiers};
use regex::Regex;

use super::Ctx;

/// Every verb must match both first-person ("You slash") and third-person ("A mob slashes").
const MELEE_VERBS: &str = "hit(?:s)?|slash(?:es)?|pierce(?:s)?|crush(?:es)?|bash(?:es)?|kick(?:s)?|bite(?:s)?|claw(?:s)?|gore(?:s)?|maul(?:s)?|punch(?:es)?|strike(?:s)?|slice(?:s)?|backstab(?:s)?|slam(?:s)?|sting(?:s)?|rend(?:s)?|smash(?:es)?|gnaw(?:s)?|lash(?:es)?|smite(?:s)?|cleave(?:s)?|reave(?:s)?|shoot(?:s)?|frenzies on|frenzy on|flurries|flurry";

pub struct CombatRes {
    melee: Regex,
    melee_verb: Regex,
    spell: Regex,
    ds: Regex,
    ds_inc: Regex,
    dot: Regex,
    dot_nocaster: Regex,
    heal: Regex,
    mend: Regex,
    rune_gain: Regex,
    skin_absorb_blow: Regex,
    skin_absorb_ds: Regex,
    miss: Regex,
    miss_verb: Regex,
    miss_mod: Regex,
    resist_yours: Regex,
    resist_caster: Regex,
    resist_incoming: Regex,
    your_prefix: Regex,
    dot_by: Regex,
    critical: Regex,
    reflexive: Regex,
    ds_owner_poss: Regex,
}

impl Default for CombatRes {
    fn default() -> Self {
        Self::new()
    }
}

impl CombatRes {
    pub fn new() -> Self {
        CombatRes {
            melee: Regex::new(&format!(
                r"^(.+?) (?:{MELEE_VERBS}) (.+?) for ([0-9]+) points? of damage\.(?: \((.+?)\))?$"
            ))
            .unwrap(),
            melee_verb: Regex::new(&format!(r" ({MELEE_VERBS}) ")).unwrap(),
            spell: Regex::new(
                r"^(.+?) (?:hits?) (.+?) for ([0-9]+) points of ([0-9A-Za-z_-]+) damage by (.+?)\.(?: \((.+?)\))?$",
            )
            .unwrap(),
            ds: Regex::new(
                r"^(.+?) is [0-9A-Za-z_]+ by (YOUR|.+?'s) (.+?) for ([0-9]+) points? of non-melee damage\.$",
            )
            .unwrap(),
            ds_inc: Regex::new(
                r"^YOU are [0-9A-Za-z_]+ by (.+?)'s (.+?) for ([0-9]+) points? of non-melee damage!$",
            )
            .unwrap(),
            dot: Regex::new(r"^(.+?) has taken ([0-9]+) damage from (.+?)\.(?: \((.+?)\))?$")
                .unwrap(),
            dot_nocaster: Regex::new(
                r"^(.+?) has taken ([0-9]+) damage by (.+?)\.(?: \((.+?)\))?$",
            )
            .unwrap(),
            heal: Regex::new(
                r"^(.+?) healed (.+?)( over time)? for ([0-9]+)(?: \(([0-9]+)\))? hit points?(?: by (.+?))?\.(?: \(([A-Za-z][A-Za-z ]*)\))?$",
            )
            .unwrap(),
            mend: Regex::new(r"^You mend your wounds and heal some damage\.$").unwrap(),
            rune_gain: Regex::new(r"^You gain a rune for ([0-9]+) points? of absorption\.$")
                .unwrap(),
            skin_absorb_blow: Regex::new(
                r"^(.+?) tr(?:y|ies) to [0-9A-Za-z_]+ (?:on )?YOU, but YOUR magical skin absorbs the blow!(?: \([A-Za-z ]+\))?$",
            )
            .unwrap(),
            skin_absorb_ds: Regex::new(
                r"^YOUR magical skin absorbs the damage of (.+?)'s .+\.$",
            )
            .unwrap(),
            miss: Regex::new(
                concat!(
                    r"^(.+?) tr(?:y|ies) to [0-9A-Za-z_]+ (?:on )?(.+?), but ",
                    r"(?:(miss|misses)",
                    r"|(.+?) (parries|dodges|ripostes|blocks)",
                    r"|(YOU) (parry|dodge|riposte|block)",
                    r"|.+?'s magical skin (absorbs) the blow",
                    r"|(YOUR) magical skin absorbs the blow)",
                    r"!(?: \([A-Za-z]+\))?$"
                ),
            )
            .unwrap(),
            miss_verb: Regex::new(r" tr(?:y|ies) to ([0-9A-Za-z_]+)").unwrap(),
            miss_mod: Regex::new(r" \(([A-Za-z]+)\)$").unwrap(),
            resist_yours: Regex::new(r"^(.+?) resisted your (.+?)!$").unwrap(),
            resist_caster: Regex::new(r"^(.+?) resisted (.+?)'s (.+?)!$").unwrap(),
            resist_incoming: Regex::new(r"^You resist(?:ed)? (.+?)'s (.+?)!$").unwrap(),
            your_prefix: Regex::new(r"(?i)^your ").unwrap(),
            dot_by: Regex::new(r" by (.+)$").unwrap(),
            critical: Regex::new(r"(?i)critical").unwrap(),
            reflexive: Regex::new(r"(?i)^(itself|himself|herself|themselves)$").unwrap(),
            ds_owner_poss: Regex::new(r"'s$").unwrap(),
        }
    }
}

/// The base (first-person) form of every verb `MELEE_VERBS` spells out.
const MELEE_VERB_BASES: [&str; 26] = [
    "hit", "slash", "pierce", "crush", "bash", "kick", "bite", "claw", "gore", "maul", "punch",
    "strike", "slice", "backstab", "slam", "sting", "rend", "smash", "gnaw", "lash", "smite",
    "cleave", "reave", "shoot", "frenzy", "flurry",
];

/// Un-conjugate: longest suffix rule first, each confirmed against the base set.
pub fn melee_verb_base(verb: &str) -> String {
    let v = verb.to_lowercase();
    if v.starts_with("frenz") {
        return "frenzy".to_string();
    }
    if v.starts_with("flurr") {
        return "flurry".to_string();
    }
    if MELEE_VERB_BASES.contains(&v.as_str()) {
        return v;
    }
    if let Some(stem) = v.strip_suffix("es") {
        if MELEE_VERB_BASES.contains(&stem) {
            return stem.to_string();
        }
    }
    if let Some(stem) = v.strip_suffix('s') {
        if MELEE_VERB_BASES.contains(&stem) {
            return stem.to_string();
        }
    }
    v
}

/// A named class skill gets its own lane; a weapon-in-a-hand verb shares one.
pub fn melee_skill(verb: &str) -> &'static str {
    let v = verb.to_lowercase();
    if v.starts_with("backstab") {
        return "Backstab";
    }
    if v.starts_with("bash") {
        return "Bash";
    }
    if v.starts_with("kick") {
        return "Kick";
    }
    if v.starts_with("cleav") {
        return "Cleave";
    }
    if v.starts_with("smite") {
        return "Smite";
    }
    if v.starts_with("shoot") {
        return "Ranged";
    }
    if v.starts_with("strike") {
        return "Strike";
    }
    if v.starts_with("frenz") {
        return "Frenzy";
    }
    if v.starts_with("flurr") {
        return "Flurry";
    }
    "Melee"
}

/// The damage-shield reading of a line: six fields that travel together.
struct Dmg<'a> {
    attacker: &'a str,
    target: &'a str,
    amount: i64,
    dtype: &'a str,
    skill: &'a str,
    crit: bool,
}

/// The damage-shield shape, which carries no paren modifier and maps its category 1:1.
fn dmg(c: &Ctx, out: &mut Ev, spec: Dmg<'_>) {
    out.begin(Kind::Damage);
    out.envelope(c.seq, c.ts, c.raw);
    out.s(Key::Attacker, spec.attacker);
    out.s(Key::Target, spec.target);
    out.i(Key::Amount, spec.amount);
    out.s(Key::Dtype, spec.dtype);
    out.s(Key::Skill, spec.skill);
    out.b(Key::Crit, spec.crit);
    // The empty list needs an element type because `damage_category` is element-generic.
    out.s(Key::Category, damage_category(spec.dtype, &[] as &[&str]));
}

/// Misses / avoided swings (by far the most common combat line).
pub fn classify_miss(r: &CombatRes, c: &Ctx, out: &mut Ev) -> bool {
    if !(c.text.contains(", but ")
        && (c.text.starts_with("You try to ") || c.text.contains(" tries to ")))
    {
        return false;
    }
    if let Some(m) = r.miss.captures(c.text) {
        let attacker = norm(&m[1]);
        // Group map: 3=miss|misses 4=defender 5=3rd-verb 6=YOU 7=base-verb 8=absorbs(possessive)
        // 9=YOUR(self)
        let (mtype, target): (&str, String) = if m.get(3).is_some() {
            ("miss", norm(&m[2]))
        } else if let Some(v) = m.get(5) {
            let t = match v.as_str() {
                "parries" => "parry",
                "dodges" => "dodge",
                "ripostes" => "riposte",
                _ => "block",
            };
            (t, norm(&m[4]))
        } else if let Some(v) = m.get(7) {
            // The base form is the miss type.
            (
                match v.as_str() {
                    "parry" => "parry",
                    "dodge" => "dodge",
                    "riposte" => "riposte",
                    _ => "block",
                },
                "You".to_string(),
            )
        } else if m.get(9).is_some() {
            // Self rune absorb: YOUR skin means the swing was aimed at you.
            ("absorb", "You".to_string())
        } else {
            ("absorb", norm(&m[2]))
        };
        out.begin(Kind::Miss);
        out.envelope(c.seq, c.ts, c.raw);
        out.s(Key::Attacker, &attacker);
        out.s(Key::Target, &target);
        out.s(Key::Mtype, mtype);
        // Verb then modifiers, each written only when present.
        if let Some(v) = r.miss_verb.captures(c.text) {
            out.s(Key::Verb, &melee_verb_base(&v[1]));
        }
        if let Some(md) = r.miss_mod.captures(c.text) {
            out.strs(Key::Modifiers, &parse_modifiers(Some(&md[1])));
        }
        return true;
    }
    // The miss pattern declined: the safety net for a compound trailing modifier its single-word
    // tail rejects.
    if let Some(a) = r.skin_absorb_blow.captures(c.text) {
        out.begin(Kind::Mitigation);
        out.envelope(c.seq, c.ts, c.raw);
        out.s(Key::Mtype, "absorbSwing");
        out.s(Key::Source, &norm(&a[1]));
        return true;
    }
    false
}

/// Absorption / mitigation — rune grants + absorbed damage-shield ticks.
pub fn classify_mitigation(r: &CombatRes, c: &Ctx, out: &mut Ev) -> bool {
    if c.text.starts_with("You gain a rune for ") {
        if let Some(m) = r.rune_gain.captures(c.text) {
            out.begin(Kind::Mitigation);
            out.envelope(c.seq, c.ts, c.raw);
            out.s(Key::Mtype, "rune");
            out.i(Key::Amount, m[1].parse().unwrap_or(0));
            return true;
        }
    }
    if c.text
        .starts_with("YOUR magical skin absorbs the damage of ")
    {
        if let Some(m) = r.skin_absorb_ds.captures(c.text) {
            out.begin(Kind::Mitigation);
            out.envelope(c.seq, c.ts, c.raw);
            out.s(Key::Mtype, "absorbDamageShield");
            out.s(Key::Source, &norm(&m[1]));
            return true;
        }
    }
    false
}

/// Spell resists — the caster-side "miss".
pub fn classify_resist(r: &CombatRes, c: &Ctx, out: &mut Ev) -> bool {
    let text = c.text;
    if !(text.contains("resist") && !text.contains("points of") && text.ends_with('!')) {
        return false;
    }
    if text.starts_with("You resist") {
        if let Some(m) = r.resist_incoming.captures(text) {
            out.begin(Kind::Resist);
            out.envelope(c.seq, c.ts, c.raw);
            out.s(Key::Caster, &norm(&m[1]));
            out.s(Key::Target, "You");
            out.s(Key::Spell, crate::jsstr::js_trim(&m[2]));
            out.b(Key::Incoming, true);
            return true;
        }
        return false;
    }
    // The possessive-YOUR form first: 712 spell names contain `'s`.
    if let Some(m) = r.resist_yours.captures(text) {
        out.begin(Kind::Resist);
        out.envelope(c.seq, c.ts, c.raw);
        out.s(Key::Caster, "you");
        out.s(Key::Target, &norm(&m[1]));
        out.s(Key::Spell, crate::jsstr::js_trim(&m[2]));
        out.b(Key::Incoming, false);
        return true;
    }
    if let Some(m) = r.resist_caster.captures(text) {
        out.begin(Kind::Resist);
        out.envelope(c.seq, c.ts, c.raw);
        out.s(Key::Caster, &norm(&m[2]));
        out.s(Key::Target, &norm(&m[1]));
        out.s(Key::Spell, crate::jsstr::js_trim(&m[3]));
        out.b(Key::Incoming, false);
        return true;
    }
    false
}

/// The "points of damage" half of the battery: damage shield, spell nuke, melee.
fn points_damage(r: &CombatRes, c: &Ctx, out: &mut Ev) -> bool {
    let text = c.text;
    if let Some(m) = r.ds.captures(text) {
        let owner = if &m[2] == "YOUR" {
            "You".to_string()
        } else {
            norm(&r.ds_owner_poss.replace(&m[2], ""))
        };
        dmg(
            c,
            out,
            Dmg {
                attacker: &owner,
                target: &norm(&m[1]),
                amount: m[4].parse().unwrap_or(0),
                dtype: "ds",
                skill: crate::jsstr::js_trim(&m[3]),
                crit: false,
            },
        );
        return true;
    }
    if let Some(m) = r.ds_inc.captures(text) {
        dmg(
            c,
            out,
            Dmg {
                attacker: &norm(&m[1]),
                target: "You",
                amount: m[3].parse().unwrap_or(0),
                dtype: "ds",
                skill: crate::jsstr::js_trim(&m[2]),
                crit: false,
            },
        );
        return true;
    }
    if let Some(m) = r.spell.captures(text) {
        let modifier = m.get(6).map(|g| g.as_str());
        let mods = parse_modifiers(modifier);
        out.begin(Kind::Damage);
        out.envelope(c.seq, c.ts, c.raw);
        out.s(Key::Attacker, &norm(&m[1]));
        out.s(Key::Target, &norm(&m[2]));
        out.i(Key::Amount, m[3].parse().unwrap_or(0));
        out.s(Key::Dtype, "spell");
        out.s(Key::Dclass, &m[4]);
        out.s(Key::Skill, crate::jsstr::js_trim(&m[5]));
        out.b(Key::Crit, has_critical(&mods));
        out.s_opt(Key::Modifier, modifier);
        out.strs(Key::Modifiers, &mods);
        out.s(Key::Category, damage_category("spell", &mods));
        return true;
    }
    if let Some(m) = r.melee.captures(text) {
        let modifier = m.get(4).map(|g| g.as_str());
        let mods = parse_modifiers(modifier);
        let verb = melee_verb_base(
            r.melee_verb
                .captures(text)
                .map(|v| v[1].to_string())
                .unwrap_or_else(|| "hit".to_string())
                .as_str(),
        );
        out.begin(Kind::Damage);
        out.envelope(c.seq, c.ts, c.raw);
        out.s(Key::Attacker, &norm(&m[1]));
        out.s(Key::Target, &norm(&m[2]));
        out.i(Key::Amount, m[3].parse().unwrap_or(0));
        out.s(Key::Dtype, "melee");
        out.s(Key::Skill, melee_skill(&verb));
        out.s(Key::Verb, &verb);
        out.b(Key::Crit, has_critical(&mods));
        out.s_opt(Key::Modifier, modifier);
        out.strs(Key::Modifiers, &mods);
        out.s(Key::Category, damage_category("melee", &mods));
        return true;
    }
    false
}

/// The "has taken N damage" half: DoTs, with and without a caster.
fn taken_damage(r: &CombatRes, c: &Ctx, out: &mut Ev) -> bool {
    let text = c.text;
    if let Some(m) = r.dot.captures(text) {
        let target = norm(&m[1]);
        let amount: i64 = m[2].parse().unwrap_or(0);
        let rest = &m[3];
        let modifier = m.get(4).map(|g| g.as_str());
        let crit = r.critical.is_match(modifier.unwrap_or(""));
        let mut attacker: Option<String> = None;
        let mut skill: String = rest.to_string();
        if r.your_prefix.is_match(rest) {
            attacker = Some("You".to_string());
            skill = r.your_prefix.replace(rest, "").to_string();
        } else if let Some(by) = r.dot_by.captures(rest) {
            attacker = Some(norm(&by[1]));
            let at = by.get(0).expect("group 0").start();
            skill = rest[..at].to_string();
        }
        // "from <Spell>" with no "by <caster>" and not "your" falls through to the caster-less form.
        if let Some(attacker) = attacker {
            let mods = parse_modifiers(modifier);
            out.begin(Kind::Damage);
            out.envelope(c.seq, c.ts, c.raw);
            out.s(Key::Attacker, &attacker);
            out.s(Key::Target, &target);
            out.i(Key::Amount, amount);
            out.s(Key::Dtype, "dot");
            out.s(Key::Skill, crate::jsstr::js_trim(&skill));
            out.b(Key::Crit, crit);
            out.s_opt(Key::Modifier, modifier);
            out.strs(Key::Modifiers, &mods);
            out.s(Key::Category, "dot");
            return true;
        }
    }
    if let Some(m) = r.dot_nocaster.captures(text) {
        let modifier = m.get(4).map(|g| g.as_str());
        let crit = r.critical.is_match(modifier.unwrap_or(""));
        let mods = parse_modifiers(modifier);
        out.begin(Kind::Damage);
        out.envelope(c.seq, c.ts, c.raw);
        out.s_or_null(Key::Attacker, None);
        out.s(Key::Target, &norm(&m[1]));
        out.i(Key::Amount, m[2].parse().unwrap_or(0));
        out.s(Key::Dtype, "dot");
        out.s(Key::Skill, crate::jsstr::js_trim(&m[3]));
        out.b(Key::Crit, crit);
        out.s_opt(Key::Modifier, modifier);
        out.strs(Key::Modifiers, &mods);
        out.s(Key::Category, "dot");
        return true;
    }
    false
}

/// Damage: melee / spell / dot / damage-shield, behind the shared substring gates.
pub fn classify_damage(r: &CombatRes, c: &Ctx, out: &mut Ev) -> bool {
    let has_points = c.text.contains("points of") || c.text.contains("point of");
    let has_taken = c.text.contains("has taken");
    if has_points && points_damage(r, c, out) {
        return true;
    }
    if has_taken && taken_damage(r, c, out) {
        return true;
    }
    false
}

/// Heals, plus the one heal family that states no amount.
pub fn classify_heal(r: &CombatRes, c: &Ctx, out: &mut Ev) -> bool {
    if c.text.starts_with("You mend") && r.mend.is_match(c.text) {
        out.begin(Kind::HealUnstated);
        out.envelope(c.seq, c.ts, c.raw);
        out.s(Key::Skill, "Mend");
        out.s(Key::Target, "You");
        return true;
    }
    if !c.text.contains(" healed ") {
        return false;
    }
    let Some(m) = r.heal.captures(c.text) else {
        return false;
    };
    let healer = norm(&m[1]);
    let t_raw = crate::jsstr::js_trim(&m[2]);
    let reflexive = r.reflexive.is_match(t_raw);
    let target = if reflexive {
        healer.clone()
    } else {
        norm(t_raw)
    };
    out.begin(Kind::Heal);
    out.envelope(c.seq, c.ts, c.raw);
    out.s(Key::Target, &target);
    out.i(Key::Amount, m[4].parse().unwrap_or(0));
    // Absent, not zero, when the group did not participate.
    out.i_opt(
        Key::RawAmount,
        m.get(5).and_then(|g| g.as_str().parse().ok()),
    );
    // An empty trim is absent, not "".
    let spell = m.get(6).map(|g| crate::jsstr::js_trim(g.as_str()));
    out.s_opt(Key::Spell, spell.filter(|s| !s.is_empty()));
    out.s(Key::Healer, &healer);
    out.b(
        Key::Crit,
        r.critical.is_match(m.get(7).map_or("", |g| g.as_str())),
    );
    if m.get(3).is_some() {
        out.b(Key::OverTime, true);
    }
    true
}
