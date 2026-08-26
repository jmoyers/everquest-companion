//! `src/main/modules/comboLevels.ts` — READING THE CHARACTER'S LEVEL, for the interval builder.
//!
//! EQ Legends states your level in exactly TWO places: a `Welcome to level N!` ding and your own
//! `/who` row's bracket. Everything here is about reconciling them.
//!
//! THE ONE FACT IT ALL RESTS ON: the displayed level is the MINIMUM over the loadout's class
//! levels. Two consequences, pulling in opposite directions — inside ONE loadout the number only
//! ever RISES (classes gain levels and never lose them), so a level that goes backwards is proof of
//! a swap; ACROSS a swap it can fall by forty, which is why `level_drop_boundaries` treats a
//! non-increasing ding as the loudest swap signal in the log.
//!
//! `level_at`'s TWO LOOPS SHARE ONE `at`, and that is the JOS-239 fix. They used to run one after
//! the other with the `/who` pass writing unconditionally, so a row's level won over every ding
//! after it however old the row was: a level 50 from a Jul 31 row landed on top of the Aug 06 ding
//! to level 11 and reported the wizard interval as `levels 11-50` — an impossible span under
//! min-of-loadout, manufactured by the READER rather than observed. A row at the SAME instant as a
//! ding still wins: it states the bracket outright.

use super::ClassAbbr;

/// A `/who` row, reduced to what interval construction needs.
#[derive(Debug, Clone)]
pub struct WhoRow {
    pub ts: i64,
    pub seq: i64,
    pub classes: Vec<ClassAbbr>,
    /// The bracketed level — min over the loadout, so it is the interval's level too.
    pub level: i64,
}

/// A `You have gained a level!` ding.
#[derive(Debug, Clone, Copy)]
pub struct LevelPoint {
    pub ts: i64,
    pub level: i64,
}

/// Everything that ever STATES a level, which is the whole input to this file.
pub struct LevelStatements<'a> {
    pub levels: &'a [LevelPoint],
    pub who_rows: &'a [WhoRow],
}

/// The level in force at `ts` — the LATEST statement at or before it, from either source.
pub fn level_at(input: &LevelStatements, ts: i64) -> Option<i64> {
    let mut level: Option<i64> = None;
    let mut at = i64::MIN;
    for p in input.levels {
        if p.ts <= ts && p.ts >= at {
            level = Some(p.level);
            at = p.ts;
        }
    }
    for r in input.who_rows {
        if r.ts <= ts && r.ts >= at {
            level = Some(r.level);
            at = r.ts;
        }
    }
    level
}

/// Every level STATED inside `[from, end)`. `from` is INCLUSIVE for the range (a ding that opens an
/// interval is that interval's level) and the regression test asks for the half-open form instead,
/// which is why it is a parameter rather than a convention.
fn stated_in(input: &LevelStatements, from: i64, end: Option<i64>, inclusive: bool) -> Vec<i64> {
    let inside = |ts: i64| -> bool {
        (if inclusive { ts >= from } else { ts > from }) && end.is_none_or(|e| ts < e)
    };
    let mut out: Vec<i64> = input
        .levels
        .iter()
        .filter(|p| inside(p.ts))
        .map(|p| p.level)
        .collect();
    out.extend(
        input
            .who_rows
            .iter()
            .filter(|r| inside(r.ts))
            .map(|r| r.level),
    );
    out
}

/// Levels observed inside a slice, for the interval's honest level range.
pub fn level_range(
    input: &LevelStatements,
    start_at: i64,
    end: Option<i64>,
) -> (Option<i64>, Option<i64>) {
    let mut inside = stated_in(input, start_at, end, true);
    if let Some(in_force) = level_at(input, start_at) {
        inside.push(in_force);
    }
    if inside.is_empty() {
        return (None, None);
    }
    (inside.iter().copied().min(), inside.iter().copied().max())
}

/// A LEVEL SPAN ONE LOADOUT CANNOT PRODUCE (JOS-239). Inside a fixed loadout the minimum only ever
/// goes UP, so a level observed inside the interval that is BELOW the level in force when it opened
/// is proof a swap happened in there that no detector cut.
///
/// Stated as a REGRESSION rather than as a width, because a width is not evidence of anything:
/// `levels 24-50` is a legitimate month of grinding, and `levels 11-50` is impossible ONLY because
/// the 11 came after the 50. The interval keeps carrying the honest hull; this is the fact the hull
/// cannot express.
pub fn level_regressed_inside(input: &LevelStatements, start_at: i64, end: Option<i64>) -> bool {
    let Some(in_force) = level_at(input, start_at) else {
        return false;
    };
    stated_in(input, start_at, end, false)
        .into_iter()
        .any(|level| level < in_force)
}
