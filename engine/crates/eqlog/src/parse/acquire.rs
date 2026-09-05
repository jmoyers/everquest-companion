//! Every sentence in which an item or a coin reaches the player without a corpse in it.

use crate::event::{Ev, Key, Kind};
use crate::jsstr::js_trim;
use regex::Regex;

use super::Ctx;

/// The chat marker: the guard on the one shape here that starts with free text.
const CHAT_QUOTE_MARKER: &str = ", '";

pub struct AcquireRes {
    coin_token: Regex,
    coin_separators: Regex,
    coin_corpse: Regex,
    coin_item: Regex,
    coin_vendor: Regex,
    coin_bare: Regex,
    purchase: Regex,
    item_inventory: Regex,
    item_overflow: Regex,
    item_fashioned: Regex,
}

impl Default for AcquireRes {
    fn default() -> Self {
        Self::new()
    }
}

impl AcquireRes {
    pub fn new() -> Self {
        let s = crate::jsstr::JS_S;
        AcquireRes {
            coin_token: Regex::new(r"([0-9][0-9,]*) (platinum|gold|silver|copper)").unwrap(),
            coin_separators: Regex::new(&format!(
                r"^[{sc},]*(?:and[{sc},]*)*$",
                sc = crate::jsstr::JS_S_INNER
            ))
            .unwrap(),
            coin_corpse: Regex::new(r"^You receive (.+?) from the corpse\.$").unwrap(),
            coin_item: Regex::new(r"^You received (.+?) from that item\.$").unwrap(),
            coin_vendor: Regex::new(r"^You receive (.+?) from (.+?) for the (.+)\(s\)\.$").unwrap(),
            coin_bare: Regex::new(&format!(r"^You received? (.+?){s}*\.$")).unwrap(),
            purchase: Regex::new(r"^You purchased ([0-9]+) (.+?) from (.+?) for (.*)\.$").unwrap(),
            item_inventory: Regex::new(r"^(.+?) has been placed in your inventory!$").unwrap(),
            item_overflow: Regex::new(
                r"^Your inventory is full\. (.+?) has been added to your overflow items!",
            )
            .unwrap(),
            item_fashioned: Regex::new(
                r"^You have fashioned the items together to create something new: (.+?)\.$",
            )
            .unwrap(),
        }
    }
}

/// Take every `<digits> <denomination>` pair in order, then prove the clause held nothing else.
/// That proof is what lets the callers anchor loosely.
fn parse_coins(r: &AcquireRes, clause: &str) -> Option<Vec<(&'static str, i64)>> {
    let mut coins: Vec<(&'static str, i64)> = Vec::new();
    let mut rest = String::new();
    let mut last = 0usize;
    let mut found = 0usize;
    for m in r.coin_token.captures_iter(clause) {
        let whole = m.get(0).expect("group 0");
        rest.push_str(&clause[last..whole.start()]);
        last = whole.end();
        let amount: i64 = m[1].replace(',', "").parse().ok()?;
        let denom: &'static str = match &m[2] {
            "platinum" => "platinum",
            "gold" => "gold",
            "silver" => "silver",
            _ => "copper",
        };
        // A denomination stated twice would be a shape nobody has seen; refuse rather than pick.
        if coins.iter().any(|(d, _)| *d == denom) {
            return None;
        }
        coins.push((denom, amount));
        found += 1;
    }
    if found == 0 {
        return None;
    }
    rest.push_str(&clause[last..]);
    if r.coin_separators.is_match(&rest) {
        Some(coins)
    } else {
        None
    }
}

/// The four coin sentences, tried in the order their anchors get looser.
fn classify_coin(r: &AcquireRes, c: &Ctx, out: &mut Ev) -> bool {
    if let Some(m) = r.coin_corpse.captures(c.text) {
        if let Some(coins) = parse_coins(r, &m[1]) {
            out.begin(Kind::Coin);
            out.envelope(c.seq, c.ts, c.raw);
            out.s(Key::Source, "corpse");
            out.coins(Key::Coins, &coins);
            return true;
        }
    }
    if let Some(m) = r.coin_item.captures(c.text) {
        if let Some(coins) = parse_coins(r, &m[1]) {
            out.begin(Kind::Coin);
            out.envelope(c.seq, c.ts, c.raw);
            out.s(Key::Source, "item");
            out.coins(Key::Coins, &coins);
            return true;
        }
    }
    if let Some(m) = r.coin_vendor.captures(c.text) {
        if let Some(coins) = parse_coins(r, &m[1]) {
            out.begin(Kind::Coin);
            out.envelope(c.seq, c.ts, c.raw);
            out.s(Key::Source, "vendor");
            out.coins(Key::Coins, &coins);
            out.s(Key::Npc, js_trim(&m[2]));
            out.s(Key::Item, js_trim(&m[3]));
            return true;
        }
    }
    if let Some(m) = r.coin_bare.captures(c.text) {
        if let Some(coins) = parse_coins(r, &m[1]) {
            out.begin(Kind::Coin);
            out.envelope(c.seq, c.ts, c.raw);
            out.s(Key::Source, "unstated");
            out.coins(Key::Coins, &coins);
            return true;
        }
    }
    false
}

/// The merchant buy. An empty price clause is the free form and is honest as `{}`.
fn classify_purchase(r: &AcquireRes, c: &Ctx, out: &mut Ev) -> bool {
    let Some(m) = r.purchase.captures(c.text) else {
        return false;
    };
    let clause = js_trim(&m[4]).to_string();
    let price = if clause.is_empty() {
        Some(Vec::new())
    } else {
        parse_coins(r, &clause)
    };
    let Some(price) = price else { return false };
    out.begin(Kind::Purchase);
    out.envelope(c.seq, c.ts, c.raw);
    out.s(Key::Item, js_trim(&m[2]));
    out.i(Key::Count, m[1].parse().unwrap_or(0));
    out.s(Key::Npc, js_trim(&m[3]));
    out.coins(Key::Price, &price);
    true
}

/// The three corpse-less item arrivals.
fn classify_item_arrival(r: &AcquireRes, c: &Ctx, out: &mut Ev) -> bool {
    let text = c.text;
    if text.starts_with("You have fashioned ") {
        let Some(m) = r.item_fashioned.captures(text) else {
            return false;
        };
        item_received(c, out, js_trim(&m[1]), "fashioned");
        return true;
    }
    if text.starts_with("Your inventory is full. ") {
        let Some(m) = r.item_overflow.captures(text) else {
            return false;
        };
        item_received(c, out, js_trim(&m[1]), "overflow");
        return true;
    }
    if text.ends_with(" has been placed in your inventory!") && !text.contains(CHAT_QUOTE_MARKER) {
        let Some(m) = r.item_inventory.captures(text) else {
            return false;
        };
        item_received(c, out, js_trim(&m[1]), "inventory");
        return true;
    }
    false
}

fn item_received(c: &Ctx, out: &mut Ev, item: &str, via: &str) {
    out.begin(Kind::ItemReceived);
    out.envelope(c.seq, c.ts, c.raw);
    out.s(Key::Item, item);
    out.s(Key::Via, via);
}

/// Every way an item or a coin reaches you that does not name a corpse. One cheap gate per family.
pub fn classify_acquire(r: &AcquireRes, c: &Ctx, out: &mut Ev) -> bool {
    if c.text.starts_with("You rece") {
        return classify_coin(r, c, out);
    }
    if c.text.starts_with("You purchased ") {
        return classify_purchase(r, c, out);
    }
    classify_item_arrival(r, c, out)
}
