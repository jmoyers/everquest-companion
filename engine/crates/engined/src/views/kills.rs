//! `kills.recent` — the rows the Overview's recent-kills card draws: what you killed, when, where,
//! and what the experience line beside it said.
//!
//! Named for the surface rather than for the module, which is this registry's one exception. It
//! reads `progression`, not `kills`: the `kills` module is a lifetime tally keyed by mob with no
//! recent list at all, while the recent-kills ring lives beside `progression`'s columns because a
//! kill and the experience line that follows it are joined at fold time and only that module sees
//! both.
//!
//! `ProgressionKill.expFlag` is a bitfield (`1` no percentage stated, `2` party experience) and
//! absent is a third state — no experience line at all. The row decomposes it into three booleans
//! and a number so the card draws without arithmetic.

use protocol::cell::Cell;
use protocol::generated::Cells;

use fold::modules::progression::{ProgressionKill, ProgressionModule};

use super::{Field, Order, SourceDef, SourceRow};

/// `expFlag & 1` — the experience line stated no percentage.
const EXP_UNSTATED: i64 = 1;
/// `expFlag & 2` — it was party experience.
const EXP_PARTY: i64 = 2;

/// The registry entry. See [`super::SourceDef`].
pub const RECENT: SourceDef = SourceDef {
    id: "kills.recent",
    fields: &["at", "seq", "name", "zone", "pet", "expPct"],
    // Newest first, which is what the card draws.
    default_sort: &[("at", Order::Desc), ("seq", Order::Desc)],
    tiebreak: ("seq", Order::Asc),
    // The card's own cap rather than the house default: the ring holds fifty and the card draws
    // twenty-five, so the house default would be payload nobody asked for.
    default_limit: 25,
};

/// Build every row of the ring, in the module's own append order.
///
/// The key is the ring position (`kill:<n>`). The ring drops from the front at fifty, so a position
/// names a different kill after the fifty-first — the module's revision counter is what handles
/// that, by re-cutting the view and diffing. The kill's `ts` cannot be the key: it is
/// second-resolution and routinely repeats.
#[must_use]
pub fn rows(module: &ProgressionModule) -> Vec<SourceRow> {
    module
        .recent_kills()
        .iter()
        .enumerate()
        .map(|(index, kill)| {
            let seq = i64::try_from(index).unwrap_or(i64::MAX);
            SourceRow {
                key: format!("kill:{index}"),
                cells: cells(kill),
                fields: vec![
                    ("at", Field::Int(kill.ts)),
                    ("seq", Field::Int(seq)),
                    ("name", Field::Text(kill.name.clone())),
                    // A zone the fold never learned is `Missing`, not an empty string: the module
                    // writes `''` before the first zone line, and unknown has to be a place in the
                    // order rather than a name that sorts before every real zone.
                    (
                        "zone",
                        if kill.zone.is_empty() {
                            Field::Missing
                        } else {
                            Field::Text(kill.zone.clone())
                        },
                    ),
                    ("pet", Field::Text(super::buffs::yes_no(kill.credit == 1))),
                    ("expPct", kill.exp_pct.map_or(Field::Missing, exp_field)),
                ],
            }
        })
        .collect()
}

/// A percentage as a comparable value, in milli-percent: [`Field`] compares integers, and rounding
/// to whole percent would put `0.9` and `0.1` in the same place in a column that is all fractions.
fn exp_field(pct: f64) -> Field {
    #[expect(
        clippy::cast_possible_truncation,
        reason = "a log-stated percentage times 1000; the parser's own range is 0..100"
    )]
    Field::Int((pct * 1000.0) as i64)
}

fn cells(kill: &ProgressionKill) -> Cells {
    let mut cells = std::collections::BTreeMap::new();
    cells.insert("at".to_owned(), Cell::int(kill.ts));
    cells.insert("name".to_owned(), Cell::text(&kill.name));
    // An unknown zone is null, never `''`: the module writes an empty string into its column, but
    // on the wire an absent value has a spelling.
    cells.insert(
        "zone".to_owned(),
        if kill.zone.is_empty() {
            Cell::null()
        } else {
            Cell::text(&kill.zone)
        },
    );
    // `credit` is `0` for your killing blow and `1` for a bound pet's; the boolean is the question
    // the card's pet chip asks.
    cells.insert("pet".to_owned(), Cell::flag(kill.credit == 1));
    // The three states of the experience line, kept apart: `expLine` false means there was none at
    // all, which is a different sentence from a line that stated no number.
    let flag = kill.exp_flag;
    cells.insert("expLine".to_owned(), Cell::flag(flag.is_some()));
    cells.insert(
        "expStated".to_owned(),
        Cell::flag(flag.is_some_and(|f| f & EXP_UNSTATED == 0)),
    );
    cells.insert(
        "expParty".to_owned(),
        Cell::flag(flag.is_some_and(|f| f & EXP_PARTY != 0)),
    );
    cells.insert(
        "expPct".to_owned(),
        kill.exp_pct.map_or_else(Cell::null, Cell::float),
    );
    Cells(cells)
}

#[cfg(test)]
mod tests {
    use super::{rows, RECENT};
    use crate::views::{cut, validate};
    use protocol::generated::ViewDescriptor;
    use protocol::Cell;

    fn folded(lines: &[&str]) -> fold::Fold {
        let mut f = fold::Fold::new(fold::registered(fold::ClusterDeps::default()), i64::MAX);
        for line in lines {
            f.on_primary(
                &fold::event::Event::from_json(line).expect("an event"),
                false,
            );
        }
        f
    }

    const ZONE: &str =
        r#"{"kind":"zone","seq":0,"ts":1787181707000,"raw":"z","zone":"Nagafen's Lair"}"#;
    /// An experience line, then the kill it belongs to — the order the game writes them in.
    const EXP: &str = r#"{"kind":"expGain","seq":1,"ts":1787181707000,"raw":"e","pct":1.5}"#;
    const KILL: &str = r#"{"kind":"death","seq":2,"ts":1787181707000,"raw":"d","name":"a fire giant warlord","bySelf":true}"#;
    const BARE_KILL: &str = r#"{"kind":"death","seq":3,"ts":1787181767000,"raw":"d","name":"a lava guardian","bySelf":true}"#;

    fn built(f: &fold::Fold) -> Vec<crate::views::SourceRow> {
        rows(f.registry.progression().expect("the progression module"))
    }

    #[test]
    fn a_row_carries_what_the_card_draws_and_the_bitfield_never_reaches_it() {
        let f = folded(&[ZONE, EXP, KILL]);
        let built = built(&f);
        assert_eq!(built.len(), 1);
        let cells = &built[0].cells;
        assert_eq!(cells["name"], Cell::text("a fire giant warlord"));
        assert_eq!(cells["zone"], Cell::text("Nagafen's Lair"));
        assert_eq!(cells["pet"], Cell::flag(false));
        assert_eq!(cells["expLine"], Cell::flag(true));
        assert_eq!(cells["expStated"], Cell::flag(true));
        assert_eq!(cells["expParty"], Cell::flag(false));
        assert_eq!(cells["expPct"], Cell::float(1.5));
        // The bitfield itself is not on the wire; the three flags already say what it says.
        assert!(!cells.0.contains_key("expFlag"));
    }

    #[test]
    fn a_kill_with_no_experience_line_says_so_rather_than_saying_zero() {
        let f = folded(&[ZONE, EXP, KILL, BARE_KILL]);
        let built = built(&f);
        let bare = built
            .iter()
            .find(|r| r.key == "kill:1")
            .expect("the second kill");
        assert_eq!(bare.cells["expLine"], Cell::flag(false));
        assert_eq!(bare.cells["expPct"], Cell::null());
        // …and `expStated` is false too: nothing stated a percentage because nothing stated
        // anything.
        assert_eq!(bare.cells["expStated"], Cell::flag(false));
    }

    #[test]
    fn the_default_window_is_newest_first() {
        let f = folded(&[ZONE, EXP, KILL, BARE_KILL]);
        let built = built(&f);
        let view = validate(&ViewDescriptor {
            source: RECENT.id.to_owned(),
            filter: None,
            sort: Vec::new(),
            window: None,
        })
        .expect("a view");
        let (window, total) = cut(&view, &built);
        assert_eq!(total, 2);
        assert_eq!(
            window.iter().map(|r| r.key.0.as_str()).collect::<Vec<_>>(),
            ["kill:1", "kill:0"]
        );
    }
}
