//! An auto-sold loot carries its sale price (parse/world.rs `loot_sold`). Kept out of `lib.rs`'s
//! unit tests, which sit at the engine's 400-line bar once every branch's parser tests are merged.

use eqlog::event::Ev;
use eqlog::{Clock, Parser, Tz};

fn parse_one(p: &Parser, raw: &str) -> String {
    let mut ev = Ev::new();
    assert!(p.parse_event(raw, 0, &mut ev), "line was not timestamped");
    ev.finish().to_string()
}

fn bare() -> Parser {
    Parser::new(
        Clock::new(Tz::America__Los_Angeles),
        None,
        Some("Primitive".to_string()),
    )
}

/// An auto-sold loot is income: the price rides the loot as `price`, in the coin shape a
/// purchase uses, so the sale is no longer a sentence whose money nothing could read.
#[test]
fn an_auto_sold_loot_carries_its_sale_price() {
    let p = bare();
    let cases = [
        ("a Rat Eye from a pack rat's corpse and sold it for 1 gold, 7 silver and 9 copper.",
         r#""item":"Rat Eye","source":"a pack rat","disposition":"sold","price":{"gold":1,"silver":7,"copper":9}}"#),
        ("2 Bone Chips from a decaying skeleton's corpse and sold it for 8 copper.",
         r#""disposition":"sold","count":2,"price":{"copper":8}}"#),
        ("a Fine Steel Sword from an orc centurion's corpse and sold it for 1,203 platinum and 4 gold.",
         r#""disposition":"sold","price":{"platinum":1203,"gold":4}}"#),
        ("a Shin Greaves +2 from Reward Chest and sold it for free.",
         r#""source":"Reward Chest","disposition":"sold","price":{}}"#),
    ];
    for (line, tail) in cases {
        let out = parse_one(&p, &format!("[Wed Aug 19 16:21:47 2026] You looted {line}"));
        assert!(out.ends_with(tail), "{out}");
    }
}
