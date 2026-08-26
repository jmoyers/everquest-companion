//! `src/main/log/parseCombat.ts` — misses, mitigation, resists, the damage battery and heals.
//!
//! Every regex below is its TS twin with three mechanical substitutions and no others: `\d` →
//! `[0-9]`, `\w` → `[0-9A-Za-z_]` and `\s` → the ECMA class (see jsstr.rs). Those three are
//! ASCII-only in JavaScript and Unicode-aware in the `regex` crate, and a mob name with a
//! non-ASCII letter in it is exactly the line that would then part company.

use crate::event::Ev;
use crate::names::norm;
use crate::taxonomy::{damage_category, has_critical, parse_modifiers};
use regex::Regex;

use super::Ctx;

/// Every verb must match BOTH first-person ("You slash") and third-person ("A mob slashes").
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

/// See `AcquireRes`'s note: `Default` is `new`.
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

/// The BASE (first-person) form of every verb `MELEE_VERBS` spells out.
const MELEE_VERB_BASES: [&str; 26] = [
    "hit", "slash", "pierce", "crush", "bash", "kick", "bite", "claw", "gore", "maul", "punch",
    "strike", "slice", "backstab", "slam", "sting", "rend", "smash", "gnaw", "lash", "smite",
    "cleave", "reave", "shoot", "frenzy", "flurry",
];

/// `meleeVerbBase` — un-conjugate, longest suffix rule first, each confirmed against the base set.
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

/// `meleeSkill` — a named class skill gets its own lane; a weapon-in-a-hand verb shares one.
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

/// `dmg()`'s `spec` argument, kept as one value for the reason the TS keeps it as one object
/// literal: these six fields are the damage-shield reading of a line and travel together.
struct Dmg<'a> {
    attacker: &'a str,
    target: &'a str,
    amount: i64,
    dtype: &'a str,
    skill: &'a str,
    crit: bool,
}

/// `dmg()` — the damage-shield shape, which carries no paren modifier and maps its category 1:1.
fn dmg(c: &Ctx, out: &mut Ev, spec: Dmg<'_>) {
    out.begin("damage");
    out.envelope(c.seq, c.ts, c.raw);
    out.s("attacker", spec.attacker);
    out.s("target", spec.target);
    out.i("amount", spec.amount);
    out.s("dtype", spec.dtype);
    out.s("skill", spec.skill);
    out.b("crit", spec.crit);
    out.s("category", damage_category(spec.dtype, &[]));
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
        // `missOutcome`: 3=miss|misses 4=defender 5=3rd-verb 6=YOU 7=base-verb
        // 8=absorbs(possessive) 9=YOUR(self)
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
            // parry|dodge|riposte|block — the base form IS the MissType.
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
            // SELF rune absorb: the branch is the authority — YOUR skin means the swing was at You.
            ("absorb", "You".to_string())
        } else {
            ("absorb", norm(&m[2]))
        };
        out.begin("miss");
        out.envelope(c.seq, c.ts, c.raw);
        out.s("attacker", &attacker);
        out.s("target", &target);
        out.s("mtype", mtype);
        // `missAnnotations`: verb then modifiers, each spread only when present.
        if let Some(v) = r.miss_verb.captures(c.text) {
            out.s("verb", &melee_verb_base(&v[1]));
        }
        if let Some(md) = r.miss_mod.captures(c.text) {
            out.strs("modifiers", &parse_modifiers(Some(&md[1])));
        }
        return true;
    }
    // MISS_RE declined: the safety net for a COMPOUND trailing modifier its single-word tail rejects.
    if let Some(a) = r.skin_absorb_blow.captures(c.text) {
        out.begin("mitigation");
        out.envelope(c.seq, c.ts, c.raw);
        out.s("mtype", "absorbSwing");
        out.s("source", &norm(&a[1]));
        return true;
    }
    false
}

/// Absorption / mitigation — rune grants + absorbed damage-shield ticks.
pub fn classify_mitigation(r: &CombatRes, c: &Ctx, out: &mut Ev) -> bool {
    if c.text.starts_with("You gain a rune for ") {
        if let Some(m) = r.rune_gain.captures(c.text) {
            out.begin("mitigation");
            out.envelope(c.seq, c.ts, c.raw);
            out.s("mtype", "rune");
            out.i("amount", m[1].parse().unwrap_or(0));
            return true;
        }
    }
    if c.text
        .starts_with("YOUR magical skin absorbs the damage of ")
    {
        if let Some(m) = r.skin_absorb_ds.captures(c.text) {
            out.begin("mitigation");
            out.envelope(c.seq, c.ts, c.raw);
            out.s("mtype", "absorbDamageShield");
            out.s("source", &norm(&m[1]));
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
            out.begin("resist");
            out.envelope(c.seq, c.ts, c.raw);
            out.s("caster", &norm(&m[1]));
            out.s("target", "You");
            out.s("spell", crate::jsstr::js_trim(&m[2]));
            out.b("incoming", true);
            return true;
        }
        return false;
    }
    // The possessive-YOUR form FIRST — 712 spell names contain `'s`.
    if let Some(m) = r.resist_yours.captures(text) {
        out.begin("resist");
        out.envelope(c.seq, c.ts, c.raw);
        out.s("caster", "you");
        out.s("target", &norm(&m[1]));
        out.s("spell", crate::jsstr::js_trim(&m[2]));
        out.b("incoming", false);
        return true;
    }
    if let Some(m) = r.resist_caster.captures(text) {
        out.begin("resist");
        out.envelope(c.seq, c.ts, c.raw);
        out.s("caster", &norm(&m[2]));
        out.s("target", &norm(&m[1]));
        out.s("spell", crate::jsstr::js_trim(&m[3]));
        out.b("incoming", false);
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
        out.begin("damage");
        out.envelope(c.seq, c.ts, c.raw);
        out.s("attacker", &norm(&m[1]));
        out.s("target", &norm(&m[2]));
        out.i("amount", m[3].parse().unwrap_or(0));
        out.s("dtype", "spell");
        out.s("dclass", &m[4]);
        out.s("skill", crate::jsstr::js_trim(&m[5]));
        out.b("crit", has_critical(&mods));
        out.s_opt("modifier", modifier);
        out.strs("modifiers", &mods);
        out.s("category", damage_category("spell", &mods));
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
        out.begin("damage");
        out.envelope(c.seq, c.ts, c.raw);
        out.s("attacker", &norm(&m[1]));
        out.s("target", &norm(&m[2]));
        out.i("amount", m[3].parse().unwrap_or(0));
        out.s("dtype", "melee");
        out.s("skill", melee_skill(&verb));
        out.s("verb", &verb);
        out.b("crit", has_critical(&mods));
        out.s_opt("modifier", modifier);
        out.strs("modifiers", &mods);
        out.s("category", damage_category("melee", &mods));
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
        // "from <Spell>" with no "by <caster>" and not "your" — fall through to the caster-less form.
        if let Some(attacker) = attacker {
            let mods = parse_modifiers(modifier);
            out.begin("damage");
            out.envelope(c.seq, c.ts, c.raw);
            out.s("attacker", &attacker);
            out.s("target", &target);
            out.i("amount", amount);
            out.s("dtype", "dot");
            out.s("skill", crate::jsstr::js_trim(&skill));
            out.b("crit", crit);
            out.s_opt("modifier", modifier);
            out.strs("modifiers", &mods);
            out.s("category", "dot");
            return true;
        }
    }
    if let Some(m) = r.dot_nocaster.captures(text) {
        let modifier = m.get(4).map(|g| g.as_str());
        let crit = r.critical.is_match(modifier.unwrap_or(""));
        let mods = parse_modifiers(modifier);
        out.begin("damage");
        out.envelope(c.seq, c.ts, c.raw);
        out.s_or_null("attacker", None);
        out.s("target", &norm(&m[1]));
        out.i("amount", m[2].parse().unwrap_or(0));
        out.s("dtype", "dot");
        out.s("skill", crate::jsstr::js_trim(&m[3]));
        out.b("crit", crit);
        out.s_opt("modifier", modifier);
        out.strs("modifiers", &mods);
        out.s("category", "dot");
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
        out.begin("healUnstated");
        out.envelope(c.seq, c.ts, c.raw);
        out.s("skill", "Mend");
        out.s("target", "You");
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
    out.begin("heal");
    out.envelope(c.seq, c.ts, c.raw);
    out.s("target", &target);
    out.i("amount", m[4].parse().unwrap_or(0));
    // `rawAmount: m[5] ? Number(m[5]) : undefined` — the key is written and then dropped by
    // `JSON.stringify` when the group did not participate.
    out.i_opt("rawAmount", m.get(5).and_then(|g| g.as_str().parse().ok()));
    // `spell: m[6]?.trim() || undefined` — an empty trim is absent, not "".
    let spell = m.get(6).map(|g| crate::jsstr::js_trim(g.as_str()));
    out.s_opt("spell", spell.filter(|s| !s.is_empty()));
    out.s("healer", &healer);
    out.b(
        "crit",
        r.critical.is_match(m.get(7).map_or("", |g| g.as_str())),
    );
    if m.get(3).is_some() {
        out.b("overTime", true);
    }
    true
}
