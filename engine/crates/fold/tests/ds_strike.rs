//! A damage shield answering a swing is not YOU striking the swinger: a "ds" line files nothing
//! in `ever_struck`, so one thorns tick on a mob-charmed group-mate cannot refuse that player's
//! `My leader is …` binds forever. A hit you chose still refuses.

use fold::combat::aggregate::DamageEvent;
use fold::combat::routing::route;
use fold::combat::state::EngineState;

fn dmg<'a>(attacker: &'a str, target: &'a str, dtype: &'a str, ts: i64) -> DamageEvent<'a> {
    DamageEvent {
        ts,
        attacker,
        target,
        amount: 5,
        dtype,
        dclass: None,
        skill: if dtype == "ds" { "thorns" } else { "Melee" }.into(),
        crit: false,
        category: "melee".into(),
        modifiers: &[],
        verb: Some("slash"),
    }
}

#[test]
fn a_damage_shield_tick_does_not_file_the_target_as_struck() {
    let mut st = EngineState::new();
    st.set_player_name("Primitive");
    route(&mut st, &dmg("You", "Malkil", "ds", 1_000));
    assert!(
        st.ally_caster_allowed("malkil"),
        "a ds tick is the defender's buff answering a swing, not a chosen strike"
    );
    route(&mut st, &dmg("You", "Malkil", "melee", 2_000));
    assert!(
        !st.ally_caster_allowed("malkil"),
        "a hit you chose still refuses the target as an ally caster"
    );
}
