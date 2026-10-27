//! A DoT tick on the player outlives the fight that cast it. `You have taken 53 damage from Swarm
//! of Pain by a spiroc revolter.` keeps printing after the caster died, and once the fight has
//! closed such a tick must not open another: it would resolve the dead caster to a fresh instance
//! and engage it, a phantom fight against `a spiroc revolter#2`.

use fold::combat::{CombatEngine, SnapshotOpts};
use fold::event::Event;
use serde_json::{json, Value};

const MOB: &str = "a spiroc revolter";

fn tick(seq: i64, ts: i64) -> String {
    format!(
        r#"{{"kind":"damage","seq":{seq},"ts":{ts},"raw":"You have taken 53 damage from Swarm of Pain by {MOB}.","attacker":"{MOB}","target":"You","amount":53,"dtype":"dot","skill":"Swarm of Pain","crit":false,"category":"dot"}}"#
    )
}

fn fold(lines: &[String]) -> Value {
    let mut e = CombatEngine::new();
    e.set_player_name("Primitive");
    for line in lines {
        e.on_event(&Event::from_json(line).expect("a JSON object"), false, None);
    }
    let last = lines.len() as i64;
    e.snapshot(last, &SnapshotOpts::full(), None)
}

/// Every segment that is a fight, open or closed: the zone session is not one.
fn fights(snap: &Value) -> Vec<Value> {
    snap["segments"]
        .as_array()
        .expect("segments")
        .iter()
        .filter(|s| s["kind"] != json!("zone"))
        .cloned()
        .collect()
}

fn the_fight_and_its_ticks(late_tick: Option<i64>) -> Vec<String> {
    let mut lines = vec![
        r#"{"kind":"zone","seq":0,"ts":0,"raw":"z","zone":"Najena"}"#.to_string(),
        format!(
            r#"{{"kind":"damage","seq":1,"ts":1000,"raw":"d","attacker":"You","target":"{MOB}","amount":500,"dtype":"melee","skill":"Melee","crit":false}}"#
        ),
        tick(2, 1500),
        format!(r#"{{"kind":"death","seq":3,"ts":2000,"raw":"d","name":"{MOB}","bySelf":true}}"#),
    ];
    lines.extend(late_tick.map(|ts| tick(4, ts)));
    lines
}

#[test]
fn a_tick_inside_the_fight_is_booked_and_one_after_it_closed_opens_nothing() {
    // The fight alone: one fight, and the tick inside it is part of it.
    let base = fights(&fold(&the_fight_and_its_ticks(None)));
    assert_eq!(base.len(), 1, "{base:?}");
    // The caster's last tick lands well past the linger: still the one fight, unchanged.
    let after = fights(&fold(&the_fight_and_its_ticks(Some(14_000))));
    assert_eq!(after.len(), 1, "a phantom fight opened: {after:?}");
    assert_eq!(after[0]["startTs"], json!(1000), "{after:?}");
    assert_eq!(after[0]["total"], base[0]["total"], "{after:?}");
}
