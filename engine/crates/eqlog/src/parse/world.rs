//! Consider, deaths, zones, the instance-creation notice, the loot family, item merges, turn-ins,
//! levels, experience and the AA economy.

use crate::event::{Ev, Key, Kind};
use crate::jsstr::js_trim;
use crate::names::{clean_mob, norm};
use regex::Regex;

use super::data::CONSIDER_FACTION_RUNGS;
use super::Ctx;

const YOU_DIED: &str = "You died.";
const AA_POTION_LANDING: &str = "You are filled with the spirit of alternate adventure.";

pub struct WorldRes {
    loot: Regex,
    loot_plain: Regex,
    loot_currency: Regex,
    loot_sold: Regex,
    loot_stored: Regex,
    loot_combine: Regex,
    destroy: Regex,
    zone: Regex,
    pseudo_zone: Regex,
    instance_create: Regex,
    slain_self: Regex,
    slain_by: Regex,
    player_death: Regex,
    mob_died: Regex,
    offer: Regex,
    trade_done: Regex,
    level: Regex,
    exp: Regex,
    aa: Regex,
    aa_spend: Regex,
    aa_ability: Regex,
    aa_improved: Regex,
    item_merge: Regex,
    item_merge_fail: Regex,
    consider: Regex,
    item_tier: Regex,
}

impl Default for WorldRes {
    fn default() -> Self {
        Self::new()
    }
}

impl WorldRes {
    pub fn new() -> Self {
        let s = crate::jsstr::JS_S;
        let rungs = CONSIDER_FACTION_RUNGS
            .iter()
            .map(|(phrase, _)| regex::escape(phrase))
            .collect::<Vec<_>>()
            .join("|");
        WorldRes {
            loot: Regex::new(
                r"^--You have looted (?:([0-9]+) |an? )?(.+?)(?: from (.+?) corpse)?\.--$",
            )
            .unwrap(),
            loot_plain: Regex::new(
                r"^You have looted (?:([0-9]+) |an? )?(.+?)(?: from (.+?) corpse)?\.$",
            )
            .unwrap(),
            loot_currency: Regex::new(
                r"^You looted (?:([0-9]+) |an? )?(.+?) from (.+?) corpse and stored it in your currency\.?$",
            )
            .unwrap(),
            loot_sold: Regex::new(
                r"^You looted (?:([0-9]+) |an? )?(.+?) from (.+?) corpse and sold it for (?:free|[0-9,]+ (?:platinum|gold|silver|copper).*?)\.?$",
            )
            .unwrap(),
            loot_stored: Regex::new(
                r"^You looted (?:([0-9]+) |an? )?(.+?) from (.+?) corpse and stored it in your (Dragon Hoard|tradeskill depot)\.?$",
            )
            .unwrap(),
            loot_combine: Regex::new(
                r"^You looted (?:([0-9]+) |an? )?(.+?) from (.+?) corpse to create (?:an? )?(.+?)\.?$",
            )
            .unwrap(),
            destroy: Regex::new(r"^You successfully destroyed ([0-9]+) (.+?)\.$").unwrap(),
            zone: Regex::new(r"^You have entered (.+?)\.$").unwrap(),
            pseudo_zone: Regex::new(r"(?i)^an area where ").unwrap(),
            instance_create: Regex::new(r"^Player (.+?) creating instance (.+?) ([0-9]+)\.$")
                .unwrap(),
            slain_self: Regex::new(r"^You have slain (.+?)!$").unwrap(),
            slain_by: Regex::new(r"^(.+?) has been slain by (.+?)!$").unwrap(),
            player_death: Regex::new(r"^You have been slain by (.+?)!$").unwrap(),
            mob_died: Regex::new(r"^(.+?) died\.$").unwrap(),
            offer: Regex::new(r"^You offered [0-9,]+ (.+?) to (.+?)\.$").unwrap(),
            trade_done: Regex::new(r"^You complete the trade with (.+?)\.$").unwrap(),
            level: Regex::new(r"^You have gained a level! Welcome to level ([0-9]+)!$").unwrap(),
            exp: Regex::new(r"^You gain (party )?experience!(?: \(([0-9.]+)%\))?$").unwrap(),
            aa: Regex::new(&format!(
                r"^You have gained (an|[0-9]+) ability point(?:\(s\))?!{s}+You now have ([0-9]+) ability point"
            ))
            .unwrap(),
            aa_spend: Regex::new(r" at a cost of ([0-9]+) ability points?\.$").unwrap(),
            aa_ability: Regex::new(
                r#"gained the ability (?:"([^"]+)"|to use (.+?)) at a cost of"#,
            )
            .unwrap(),
            aa_improved: Regex::new(r"^You have improved (.+?) ([0-9]+) at a cost of").unwrap(),
            item_merge: Regex::new(
                r"^You have successfully merged two items together to create a new item: (.+)$",
            )
            .unwrap(),
            item_merge_fail: Regex::new(r"^Your request to merge (.+?) with (.+?) failed\. ")
                .unwrap(),
            consider: Regex::new(&format!(
                r"^(.+?)( - a rare creature -)? ({rungs}) -- (.+?){s}*\(Lvl: ([0-9]+)\)$"
            ))
            .unwrap(),
            item_tier: Regex::new(r" \+([0-9]+)$").unwrap(),
        }
    }
}

/// The shared loot capture layout: optional stack count, item, source, disposition.
fn loot(
    c: &Ctx,
    out: &mut Ev,
    item: &str,
    source: Option<String>,
    disposition: Option<&str>,
    count_str: Option<&str>,
) {
    out.begin(Kind::Loot);
    out.envelope(c.seq, c.ts, c.raw);
    out.s(Key::Item, js_trim(item));
    out.s_opt(Key::Source, source.as_deref());
    if let Some(d) = disposition {
        out.s(Key::Disposition, d);
    }
    if let Some(n) = count_str {
        out.i(Key::Count, n.parse().unwrap_or(0));
    }
}

pub fn classify_consider(r: &WorldRes, c: &Ctx, out: &mut Ev) -> bool {
    if !c.text.contains("(Lvl: ") {
        return false;
    }
    let Some(m) = r.consider.captures(c.text) else {
        return false;
    };
    let Some((_, faction)) = CONSIDER_FACTION_RUNGS.iter().find(|(p, _)| *p == &m[3]) else {
        return false;
    };
    out.begin(Kind::Consider);
    out.envelope(c.seq, c.ts, c.raw);
    out.s(Key::Mob, js_trim(&m[1]));
    out.b(Key::Rare, m.get(2).is_some());
    out.i(Key::Level, m[5].parse().unwrap_or(0));
    out.s(Key::Faction, faction);
    out.s(Key::Difficulty, js_trim(&m[4]));
    true
}

pub fn classify_death(r: &WorldRes, c: &Ctx, out: &mut Ev) -> bool {
    let text = c.text;
    if text == YOU_DIED {
        out.begin(Kind::PlayerDeath);
        out.envelope(c.seq, c.ts, c.raw);
        return true;
    }
    if text.contains("slain") {
        if let Some(pd) = r.player_death.captures(text) {
            out.begin(Kind::PlayerDeath);
            out.envelope(c.seq, c.ts, c.raw);
            out.s(Key::Killer, js_trim(&pd[1]));
            return true;
        }
        if let Some(m) = r.slain_self.captures(text) {
            out.begin(Kind::Death);
            out.envelope(c.seq, c.ts, c.raw);
            out.s(Key::Name, &norm(&m[1]));
            out.b(Key::BySelf, true);
            return true;
        }
        if let Some(m) = r.slain_by.captures(text) {
            out.begin(Kind::Death);
            out.envelope(c.seq, c.ts, c.raw);
            out.s(Key::Name, &norm(&m[1]));
            out.b(Key::BySelf, false);
            out.s(Key::Killer, js_trim(&m[2]));
            return true;
        }
    }
    // The killerless mob death: `bySelf:false` with no killer is the honest shape.
    if text.ends_with(" died.") {
        if let Some(m) = r.mob_died.captures(text) {
            out.begin(Kind::Death);
            out.envelope(c.seq, c.ts, c.raw);
            out.s(Key::Name, &norm(&m[1]));
            out.b(Key::BySelf, false);
            return true;
        }
    }
    false
}

pub fn classify_zone(r: &WorldRes, c: &Ctx, out: &mut Ev) -> bool {
    if !c.text.contains("entered") {
        return false;
    }
    let Some(m) = r.zone.captures(c.text) else {
        return false;
    };
    if r.pseudo_zone.is_match(&m[1]) {
        return false;
    }
    out.begin(Kind::Zone);
    out.envelope(c.seq, c.ts, c.raw);
    out.s(Key::Zone, js_trim(&m[1]));
    true
}

/// `Player <Name> creating instance <Zone> <Id>.`
///
/// The zone line is the only sentence that states a difficulty, and it marks an instance only two
/// ways: an adjective parenthetical (d1-d4) or a `- Solo`/`- Group` suffix (d0). A base-difficulty
/// raid or personal instance prints neither — the zone line is byte-identical to the open-world
/// entry — so this notice is the only evidence that an instance of that zone exists. It is not a
/// statement about your position, and the kills fold that reads it is careful about that.
///
/// The creator and the instance id are captured as evidence even though nothing reads them today;
/// the zone name is all the kills fold asks for.
///
/// The id is the last number, which is what anchoring the trailing digits buys: a zone whose name
/// ends in an ordinal backtracks into the zone capture rather than splitting the name.
pub fn classify_instance_create(r: &WorldRes, c: &Ctx, out: &mut Ev) -> bool {
    if !c.text.starts_with("Player ") {
        return false;
    }
    let Some(m) = r.instance_create.captures(c.text) else {
        return false;
    };
    out.begin(Kind::InstanceCreate);
    out.envelope(c.seq, c.ts, c.raw);
    out.s(Key::Player, js_trim(&m[1]));
    out.s(Key::Zone, js_trim(&m[2]));
    out.i(Key::Instance, m[3].parse().unwrap_or(0));
    true
}

/// Self-loot, the auto-disposition variants, and the destroy (which is the negative).
pub fn classify_loot(r: &WorldRes, c: &Ctx, out: &mut Ev) -> bool {
    let text = c.text;
    if text.starts_with("You successfully destroyed ") {
        if let Some(d) = r.destroy.captures(text) {
            loot(
                c,
                out,
                &d[2],
                None,
                Some("destroyed"),
                d.get(1).map(|g| g.as_str()),
            );
            return true;
        }
    }
    if !text.contains("looted") {
        return false;
    }
    if let Some(m) = r
        .loot
        .captures(text)
        .or_else(|| r.loot_plain.captures(text))
    {
        loot(
            c,
            out,
            &m[2],
            clean_mob(m.get(3).map(|g| g.as_str())),
            None,
            m.get(1).map(|g| g.as_str()),
        );
        return true;
    }
    if let Some(m) = r.loot_currency.captures(text) {
        loot(
            c,
            out,
            &m[2],
            clean_mob(m.get(3).map(|g| g.as_str())),
            Some("currency"),
            m.get(1).map(|g| g.as_str()),
        );
        return true;
    }
    if let Some(m) = r.loot_sold.captures(text) {
        loot(
            c,
            out,
            &m[2],
            clean_mob(m.get(3).map(|g| g.as_str())),
            Some("sold"),
            m.get(1).map(|g| g.as_str()),
        );
        return true;
    }
    if let Some(m) = r.loot_stored.captures(text) {
        let disposition = if &m[4] == "Dragon Hoard" {
            "hoard"
        } else {
            "depot"
        };
        loot(
            c,
            out,
            &m[2],
            clean_mob(m.get(3).map(|g| g.as_str())),
            Some(disposition),
            m.get(1).map(|g| g.as_str()),
        );
        return true;
    }
    if let Some(m) = r.loot_combine.captures(text) {
        loot(
            c,
            out,
            &m[2],
            clean_mob(m.get(3).map(|g| g.as_str())),
            Some("combined"),
            m.get(1).map(|g| g.as_str()),
        );
        // The shared loot fields first, then the one added key.
        out.s(Key::Created, js_trim(&m[4]));
        return true;
    }
    false
}

pub fn classify_item_merge(r: &WorldRes, c: &Ctx, out: &mut Ev) -> bool {
    let text = c.text;
    if !(text.contains("merge") || text.starts_with("The item you are trying to add")) {
        return false;
    }
    if let Some(m) = r.item_merge.captures(text) {
        let item = js_trim(&m[1]).to_string();
        // A ` +N` tail is an item level; a Roman-rank tail is a merged spell scroll and has no tier.
        let tier = r
            .item_tier
            .captures(js_trim(&item))
            .and_then(|t| t[1].parse::<i64>().ok());
        out.begin(Kind::ItemMerge);
        out.envelope(c.seq, c.ts, c.raw);
        out.s(Key::Item, &item);
        out.i_opt(Key::Tier, tier);
        return true;
    }
    if let Some(f) = r.item_merge_fail.captures(text) {
        out.begin(Kind::ItemMergeFailed);
        out.envelope(c.seq, c.ts, c.raw);
        out.s(Key::Reason, "mismatch");
        out.s(Key::Target, js_trim(&f[1]));
        out.s(Key::Component, js_trim(&f[2]));
        return true;
    }
    let reason = match text {
        "The item you are trying to add will not work, this mote is not sufficiently powerful to upgrade this item." => Some("weakMote"),
        "The item you are trying to add will not work, you cannot fuse an item to itself." => Some("selfFuse"),
        "The item you are trying to add will not work, you cannot merge two different types of items." => Some("wrongType"),
        "Request to merge items canceled, both items remain unmodified." => Some("canceled"),
        _ => None,
    };
    match reason {
        Some(reason) => {
            out.begin(Kind::ItemMergeFailed);
            out.envelope(c.seq, c.ts, c.raw);
            out.s(Key::Reason, reason);
            true
        }
        None => false,
    }
}

pub fn classify_turn_in(r: &WorldRes, c: &Ctx, out: &mut Ev) -> bool {
    if c.text.contains("offered") {
        if let Some(m) = r.offer.captures(c.text) {
            out.begin(Kind::Offer);
            out.envelope(c.seq, c.ts, c.raw);
            out.s(Key::Item, js_trim(&m[1]));
            out.s(Key::Npc, js_trim(&m[2]));
            return true;
        }
    }
    if c.text.contains("complete the trade") {
        if let Some(m) = r.trade_done.captures(c.text) {
            out.begin(Kind::Trade);
            out.envelope(c.seq, c.ts, c.raw);
            out.s(Key::Npc, js_trim(&m[1]));
            return true;
        }
    }
    false
}

pub fn classify_level(r: &WorldRes, c: &Ctx, out: &mut Ev) -> bool {
    if !c.text.contains("gained a level") {
        return false;
    }
    let Some(m) = r.level.captures(c.text) else {
        return false;
    };
    out.begin(Kind::Level);
    out.envelope(c.seq, c.ts, c.raw);
    out.i(Key::Level, m[1].parse().unwrap_or(0));
    true
}

/// Experience gains. `pct` is omitted, never 0, when the line stated no percentage.
pub fn classify_exp(r: &WorldRes, c: &Ctx, out: &mut Ev) -> bool {
    if !c.text.starts_with("You gain ") {
        return false;
    }
    let Some(m) = r.exp.captures(c.text) else {
        return false;
    };
    out.begin(Kind::ExpGain);
    out.envelope(c.seq, c.ts, c.raw);
    out.b(Key::Party, m.get(1).is_some());
    if let Some(pct) = m.get(2) {
        out.f(Key::Pct, pct.as_str().parse().unwrap_or(f64::NAN));
    }
    true
}

pub fn classify_aa(r: &WorldRes, c: &Ctx, out: &mut Ev) -> bool {
    if !c.text.contains("ability point") {
        return false;
    }
    if let Some(g) = r.aa.captures(c.text) {
        let amount: i64 = if &g[1] == "an" {
            1
        } else {
            g[1].parse().unwrap_or(0)
        };
        out.begin(Kind::AaGain);
        out.envelope(c.seq, c.ts, c.raw);
        out.i(Key::Amount, amount);
        out.i(Key::NowHave, g[2].parse().unwrap_or(0));
        return true;
    }
    let Some(cost_m) = r.aa_spend.captures(c.text) else {
        return false;
    };
    let cost: i64 = cost_m[1].parse().unwrap_or(0);
    if let Some(imp) = r.aa_improved.captures(c.text) {
        let rank: i64 = imp[2].parse().unwrap_or(0);
        out.begin(Kind::AaSpend);
        out.envelope(c.seq, c.ts, c.raw);
        out.s(Key::Ability, &format!("{} {}", js_trim(&imp[1]), rank));
        out.i(Key::Cost, cost);
        out.i(Key::Rank, rank);
        return true;
    }
    let ability = r
        .aa_ability
        .captures(c.text)
        .and_then(|a| {
            a.get(1)
                .or_else(|| a.get(2))
                .map(|g| g.as_str().to_string())
        })
        .unwrap_or_else(|| "ability".to_string());
    out.begin(Kind::AaSpend);
    out.envelope(c.seq, c.ts, c.raw);
    out.s(Key::Ability, js_trim(&ability));
    out.i(Key::Cost, cost);
    true
}

pub fn classify_aa_potion(c: &Ctx, out: &mut Ev) -> bool {
    if c.text != AA_POTION_LANDING {
        return false;
    }
    out.begin(Kind::AaPotion);
    out.envelope(c.seq, c.ts, c.raw);
    true
}
