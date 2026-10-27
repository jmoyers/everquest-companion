//! A debuff landed by a weapon or item proc reaches the debuff tracker (upstream issue #69), and
//! only under the opt-in. EQ prints nothing when an item procs, so the landing sentence has no cast
//! line and used to be dropped on purpose. With the switch on, the app's `buffTrust.define` names
//! the combat effects of the items the inventory dump says are held, and a landing on a mob YOU
//! just hit in melee whose sentence names exactly one of them is yours.
//!
//! The reporter's case verbatim: an Orb of Tishan procs Tashania, whose landing sentence is shared
//! by eight enchanter spells in the committed DB, so the family rule alone could never draw it.

use fold::event::Event;
use fold::{registered, ClusterDeps, Fold};
use serde_json::{json, Value};

const MOB: &str = "a Kunark goblin";

/// The swing and the landing, one second apart, as the parser writes them. The candidates' durations
/// are the committed DB's (Tashan's 13 min and Tashina's 10 min disagree with the 11 min of the
/// other three), which is why no family rule could ever draw this sentence on its own.
fn lines() -> [String; 2] {
    [
        format!(
            r#"{{"kind":"damage","seq":0,"ts":2000,"raw":"d","attacker":"You","target":"{MOB}","amount":31,"dtype":"melee","skill":"Melee","crit":false}}"#
        ),
        format!(
            r#"{{"kind":"buffApply","seq":1,"ts":3000,"raw":"a","target":"{MOB}","spell":"Tashania","illusion":false,"durationMs":660000,"candidates":[{{"name":"Tashan","durationMs":780000,"illusion":false}},{{"name":"Tashani","durationMs":660000,"illusion":false}},{{"name":"Tashania","durationMs":660000,"illusion":false}},{{"name":"Tashanian","durationMs":660000,"illusion":false}},{{"name":"Tashina","durationMs":600000,"illusion":false}}]}}"#
        ),
    ]
}

/// Fold the two lines under one `buffTrust` payload (or none) and answer the buffs module's
/// active rows.
fn active_under(trust: Option<Value>) -> Value {
    let [swing, landing] = lines();
    active_after(trust, &[swing, landing])
}

/// The same, over any lines.
fn active_after(trust: Option<Value>, lines: &[String]) -> Value {
    let mut fold = Fold::new(registered(ClusterDeps::default()), 1000);
    if let Some(payload) = trust {
        assert!(
            fold.registry.define("buffTrust", &payload),
            "buffs answers to buffTrust"
        );
    }
    for line in lines {
        fold.on_primary(&Event::from_json(line).expect("a JSON object"), false);
    }
    let snaps = fold.registry.snapshots();
    snaps["modules"]
        .as_array()
        .expect("modules")
        .iter()
        .find(|m| m["id"] == "buffs")
        .expect("the buffs module")["snapshot"]["state"]["active"]
        .clone()
}

#[test]
fn a_held_procs_landing_on_a_mob_you_are_hitting_opens_a_row_under_the_opt_in() {
    // The shipped default: no switch, nothing held, and a cast-less landing produces nothing.
    assert_eq!(active_under(None), json!([]));
    // The switch without the item is nothing, and the item without the switch is nothing.
    assert_eq!(
        active_under(Some(
            json!({ "externals": [], "procDebuffs": true, "procSpells": [] })
        )),
        json!([])
    );
    assert_eq!(
        active_under(Some(
            json!({ "externals": [], "procDebuffs": false, "procSpells": ["Tashania"] })
        )),
        json!([])
    );
    // Both: the one candidate the held item names is the row, on the mob, as yours.
    let active = active_under(Some(
        json!({ "externals": [], "procDebuffs": true, "procSpells": ["Tashania"] }),
    ));
    assert_eq!(active.as_array().map(Vec::len), Some(1), "{active}");
    assert_eq!(active[0]["spell"], "Tashania", "{active}");
    assert_eq!(active[0]["self"], false, "{active}");
    assert_eq!(active[0]["startedTs"], 3000, "{active}");
}

/// The landing prints BEFORE its swing's line, and the swing may be a miss: both measured over the
/// owner's log. A landing-first pair in one second, or across one second boundary, draws the row;
/// a swing three seconds later does not.
#[test]
fn a_landing_that_prints_before_its_swing_is_held_for_it_and_a_miss_is_a_swing() {
    let armed =
        || Some(json!({ "externals": [], "procDebuffs": true, "procSpells": ["Tashania"] }));
    let [swing, landing] = lines();
    let miss = format!(
        r#"{{"kind":"miss","seq":0,"ts":3000,"raw":"m","attacker":"You","target":"{MOB}","mtype":"miss"}}"#
    );
    // Landing first, then the swing's own line in the same second.
    let active = active_after(
        armed(),
        &[
            landing.clone(),
            swing.replace(r#""ts":2000"#, r#""ts":3000"#),
        ],
    );
    assert_eq!(active.as_array().map(Vec::len), Some(1), "{active}");
    assert_eq!(active[0]["spell"], "Tashania", "{active}");
    // Landing first, then its swing stamped one second later: the second boundary fell between
    // them (`[..:47] a Kunark goblin glances nervously.` then `[..:48] You hit a Kunark goblin`).
    let active = active_after(
        armed(),
        &[
            landing.clone(),
            swing.replace(r#""ts":2000"#, r#""ts":4000"#),
        ],
    );
    assert_eq!(active.as_array().map(Vec::len), Some(1), "{active}");
    assert_eq!(active[0]["startedTs"], 3000, "{active}");
    // A miss is a swing.
    let active = active_after(armed(), &[landing.clone(), miss]);
    assert_eq!(active.as_array().map(Vec::len), Some(1), "{active}");
    // A swing three seconds after the landing is another round: nothing.
    let active = active_after(
        armed(),
        &[landing, swing.replace(r#""ts":2000"#, r#""ts":6000"#)],
    );
    assert_eq!(active, json!([]));
}

#[test]
fn two_held_procs_sharing_one_sentence_are_a_coin_flip_and_are_refused() {
    let active = active_under(Some(
        json!({ "externals": [], "procDebuffs": true, "procSpells": ["Tashania", "Tashani"] }),
    ));
    assert_eq!(active, json!([]));
}
