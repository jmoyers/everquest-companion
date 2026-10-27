//! A group member you have struck is still a group member: the strike ban on the ally-caster gate
//! yields to the live roster, and only the live roster. The game lets you land damage on a
//! group-mate only while one of you is charmed, so three ripostes on a mob-charmed shadowknight
//! (2026-09-14) must not refuse every `My leader is …` bind he sends for the rest of the log.
//! Gone from the group, the ban is back; a charm broadcast against the name is never bent.

use fold::combat::aggregate::DamageEvent;
use fold::combat::routing::route;
use fold::combat::state::EngineState;

fn melee<'a>(attacker: &'a str, target: &'a str, ts: i64) -> DamageEvent<'a> {
    DamageEvent {
        ts,
        attacker,
        target,
        amount: 110,
        dtype: "melee",
        dclass: None,
        skill: "Melee".into(),
        crit: true,
        category: "melee".into(),
        modifiers: &["Riposte"],
        verb: Some("slash"),
    }
}

#[test]
fn a_member_you_struck_may_still_lead_a_pet_until_they_leave() {
    let mut st = EngineState::new();
    st.set_player_name("Primitive");
    route(&mut st, &melee("You", "Malkil", 1_000));
    assert!(
        !st.ally_caster_allowed("malkil"),
        "a hit you landed refuses the target as an ally caster"
    );
    st.roster.members.insert("malkil".into());
    assert!(
        st.ally_caster_allowed("malkil"),
        "…unless the target is on the roster right now"
    );
    st.roster.members.remove("malkil");
    assert!(
        !st.ally_caster_allowed("malkil"),
        "the live roster, not history: gone from the group, the ban is back"
    );
}

#[test]
fn a_charm_broadcast_is_not_bent_by_the_roster() {
    let mut st = EngineState::new();
    st.charm.charm_broadcast("malkil", "malkil", 0);
    st.roster.members.insert("malkil".into());
    assert!(!st.ally_caster_allowed("malkil"));
}
