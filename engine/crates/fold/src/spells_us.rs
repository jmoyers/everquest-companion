//! `src/main/resist/spellsUsParse.ts` — the CLIENT's spell table, parsed (boundary verdict 7,
//! JOS-497 item 3).
//!
//! PURE OVER A STRING, exactly as the TypeScript is: no file, no thread, no state. `overlay_file.rs`
//! and `modules/resist/ledger_file.rs` are the same shape and are here for the same reason — the
//! FORMAT is fold vocabulary and the IO belongs to whoever owns a directory (`engined::spells`).
//!
//! ── WHERE THE DATA COMES FROM, AND WHY NOTHING DERIVED FROM IT IS EVER COMMITTED ───────────────
//!
//! The wiki-scraped `spells.json` this repo ships knows what a spell's MESSAGES are and nothing
//! about how it is RESISTED — no resist type, no resist adjust. The client install has both:
//! `<eqRoot>/spells_us.txt`, 38 MB, caret delimited, ~74k rows including the Legends-only 74xxx ids
//! no wiki has. It is Daybreak's file. The player's own copy is read at runtime and neither it nor
//! anything derived from it is redistributed — which is also why the resist ledger stores
//! OBSERVATIONS rather than conclusions. Every test below is driven by hand-authored rows.
//!
//! ── THE RULING THAT SHAPES THIS FILE: NO BULK FRAME, EVER ──────────────────────────────────────
//!
//! The tempting reading of verdict 7 — the engine parses the table and SERVES it — is closed, and
//! it was closed by MEASUREMENT (integrator, 2026-08-25): the owner's own parsed table is 48,252
//! entries and 6.13 MiB of JSON against an 8 MiB frame ceiling, on one machine, against a table
//! that grows with every client patch. A single reply at 77% of a hard limit is a design with a
//! date on it. So this process parses the file INTERNALLY, for its own joins, and consumers ask
//! per-spell questions.
//!
//! ── THE FIELD MAP, transcribed rather than re-derived ──────────────────────────────────────────
//!
//! Every index below was verified app-side against the owner's install and the measurements are
//! written into `spellsUsParse.ts`'s header — including the two traps: FIELD 10 IS THE RECAST AND
//! FIELD 9 IS NOT (9 is the recovery time and disagrees with 10 on 14,535 of 33,952 castable rows),
//! and an effect slot is `slot | effectId | base | limit | CALC | MAX` rather than `… | max | calc`
//! (Tashani's `2|50|-10|0|101|23`: calc 101 is "base + level/2, capped" and 23 is the cap; read the
//! other way the formula code would be 23, which is not a formula). Re-deriving those here would be
//! a second opinion about a file neither implementation may ship a copy of.
//!
//! ── AND THE JAVASCRIPT SEMANTICS ARE THE HARD PART, NOT THE FIELD MAP ──────────────────────────
//!
//! This is a port of a parser whose every scalar goes through `Number(x)` and `Number(x) || 0`, and
//! whose row filter is `f.length < 172` — NOT 173, so a row with exactly 172 fields passes and then
//! reads `undefined` for its slots. Those are not bugs to fix on the way across; they are the
//! behaviour the app has shipped, and a port that "corrected" them would disagree with the app on
//! real rows. [`js_number`] is where the arithmetic half lives and it carries its own argument.

use eqlog::jsstr::js_trim;
use eqlog::names::spell_canon_key;
use std::collections::HashMap;

// ── the field map (`spellsUsParse.ts`, index for index) ────────────────────────────────────────

const F_ID: usize = 0;
const F_NAME: usize = 1;
const F_CAST_MS: usize = 8;
const F_RECAST_MS: usize = 10;
const F_DURATION_FORMULA: usize = 11;
const F_DURATION: usize = 12;
const F_MANA: usize = 14;
const F_RESIST_TYPE: usize = 29;
const F_TARGET_TYPE: usize = 30;
const F_CLASS_FIRST: usize = 36;
const F_CLASS_COUNT: usize = 16;
/// The bard's index among the sixteen class-level fields (WAR CLR PAL RNG SHD DRU MNK BRD …).
const CLASS_BARD: usize = 7;
const F_RESIST_ADJ: usize = 78;
const F_AE_MAX_TARGETS: usize = 143;
const F_SLOTS: usize = 172;

const EFFECT_HITPOINTS: f64 = 0.0;
const EFFECT_CHARM: f64 = 22.0;
const EFFECT_MEZ: f64 = 31.0;
const EFFECT_ALL_RESISTS: f64 = 111.0;

/// A resist-debuff slot has to be worth something to count. Solon's Bewitching Bravura carries a
/// one-point magic-resist rider on slot 2 and is a CHARM, not a malo; opening an 11-minute debuff
/// window for one point of resist would file every charmed mob's later observations under a
/// condition that never mattered. Five is comfortably below the weakest real member of the family
/// (Tashani, 23) and comfortably above every rider seen in the file.
const MIN_DEBUFF_MAGNITUDE: f64 = 5.0;

// ── the shapes (`shared/resistTypes.ts`) ───────────────────────────────────────────────────────

/// The five axes the game prints. `shared/resistTypes.ts ResistAxis`, plus the `all` a tash/malo
/// debuff slot carries — which is a SLOT's axis and never a spell's, so the two are one enum here
/// with the extra member rather than two types that would have to be converted at every join.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Axis {
    Magic,
    Fire,
    Cold,
    Poison,
    Disease,
    /// Only a debuff SLOT is ever this — the tash and malo family, effect 111.
    All,
}

impl Axis {
    /// The word every surface prints. NO ACRONYMS, EVER (owner ruling 2026-08-16): `MR`/`FR`/`CR`
    /// appear nowhere, so the word is the only spelling this enum offers.
    #[must_use]
    pub fn word(self) -> &'static str {
        match self {
            Axis::Magic => "magic",
            Axis::Fire => "fire",
            Axis::Cold => "cold",
            Axis::Poison => "poison",
            Axis::Disease => "disease",
            Axis::All => "all",
        }
    }
}

/// `axisFromResistType`. Everything unlisted — 0 unresistable, 6 chromatic, 7 prismatic, 8
/// physical, 9 corruption — is `None` rather than guessed at, and the estimator skips a spell with
/// no axis. A chromatic spell resists against the LOWEST of the five and a prismatic against an
/// average; neither is a column the ledger can pool under (world-model law 1).
#[must_use]
pub fn axis_from_resist_type(resist_type: f64) -> Option<Axis> {
    match resist_type as i64 {
        1 => Some(Axis::Magic),
        2 => Some(Axis::Fire),
        3 => Some(Axis::Cold),
        4 => Some(Axis::Poison),
        5 => Some(Axis::Disease),
        _ => None,
    }
}

/// `ResistDebuffSlot`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DebuffSlot {
    pub axis: Axis,
    pub base: f64,
    pub calc: f64,
    pub max: f64,
}

/// `SpellHpSlot`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HpSlot {
    pub base: f64,
    pub max: f64,
    pub calc: f64,
    /// A question of the ROW rather than of the slot — does this spell have a duration at all. It
    /// is written onto each slot because that is where the reader needs it: a hitpoint slot on a
    /// duration spell is a DoT/HoT/regen line landing every tick, and on an instant spell it is the
    /// whole hit.
    pub per_tick: bool,
}

/// The `hpSlot` the resist estimator reads — effect 0 ALONE, deliberately. It answers one question
/// (is this spell's damage a fixed number) and widening it would change what the ledger, the fold
/// and the con card read, for no gain: neither a heal-over-time nor a bard pulse is a spell the
/// estimator fits a resist from.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DamageSlot {
    pub base: f64,
    pub max: f64,
    pub calc: f64,
}

/// `hpDuration` — the buff-duration formula and its cap, present only on a spell that has one.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HpDuration {
    pub formula: f64,
    pub value: f64,
}

/// `SpellResistInfo` — one row of the parsed table.
///
/// THE OPTIONALS ARE ABSENT-MEANS-NOTHING, each for a measured reason written at its producer: a 0
/// recast is the file saying there is no re-use timer, a 0 `aemaxtargets` is what 71,864 of ~74k
/// rows read, and a 0 mana is what every bard song says.
#[derive(Debug, Clone, PartialEq)]
pub struct SpellInfo {
    pub axis: Option<Axis>,
    pub resist_adj: f64,
    pub cast_ms: f64,
    pub recast_ms: Option<f64>,
    pub ae_max_targets: Option<f64>,
    pub mana: Option<f64>,
    pub target_type: f64,
    pub damage_slot: Option<DamageSlot>,
    pub hp: Vec<HpSlot>,
    pub hp_duration: Option<HpDuration>,
    pub debuff_slots: Vec<DebuffSlot>,
    pub level_cap: Option<f64>,
    pub song: bool,
}

/// The whole parsed table, keyed by `spellCanonKey(name)`.
pub type SpellTable = HashMap<String, SpellInfo>;

// ── the JavaScript arithmetic this parser is written in ────────────────────────────────────────

/// `Number(x)` FOR A STRING, and it is not `str::parse` with a different name.
///
/// Every scalar in `spellsUsParse.ts` goes through this, so a port that used Rust's parser would
/// disagree with the app on inputs the file really contains — and disagree SILENTLY, because both
/// sides would produce a number. The four differences that matter, each of which the app's own
/// behaviour depends on:
///
///   * **The empty string is `0`, not an error.** `Number('')` is 0, so a row with an empty id
///     field passes `Number.isFinite` and is KEPT. Rust's `"".parse::<f64>()` is an error, which
///     would have silently dropped those rows.
///   * **Whitespace is trimmed first**, using the ECMA set (`js_trim`) rather than Unicode
///     `White_Space` — the two disagree in both directions and `jsstr.rs` names the cases.
///   * **`Infinity` is a literal** and a leading `+` is allowed. `f64::from_str` accepts `inf` and
///     `infinity` case-insensitively and rejects `Infinity`… it does not, in fact, agree on either
///     spelling's set, so the arm is written out.
///   * **Radix prefixes are numbers.** `Number('0x1f')` is 31; `"0x1f".parse::<f64>()` is an error.
///     No sign is allowed on a prefixed literal — `Number('-0x10')` is `NaN`.
///
/// Anything else is `NaN`, which is what `Number` answers and what every caller here is written
/// against: `Number.isFinite` rejects it, and `|| 0` turns it into zero.
#[must_use]
pub fn js_number(text: &str) -> f64 {
    let t = js_trim(text);
    if t.is_empty() {
        return 0.0;
    }
    // The radix literals, which take no sign.
    if let Some(rest) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        return radix(rest, 16);
    }
    if let Some(rest) = t.strip_prefix("0o").or_else(|| t.strip_prefix("0O")) {
        return radix(rest, 8);
    }
    if let Some(rest) = t.strip_prefix("0b").or_else(|| t.strip_prefix("0B")) {
        return radix(rest, 2);
    }
    // `Infinity`, with an optional sign. Spelled exactly — JS does not accept `inf` or `INFINITY`.
    let (sign, body) = match t.strip_prefix('-') {
        Some(rest) => (-1.0, rest),
        None => (1.0, t.strip_prefix('+').unwrap_or(t)),
    };
    if body == "Infinity" {
        return sign * f64::INFINITY;
    }
    // THE DECIMAL ARM, GUARDED RATHER THAN DELEGATED. Rust's `f64::from_str` accepts spellings JS
    // does not (`inf`, `NaN`, `1_0` is rejected by both but `infinity` is not), so the body is
    // required to look like a JS decimal literal before it is handed over. What both accept in the
    // middle — digits, one dot, an `e` exponent — is identical, which is why delegating the
    // ARITHMETIC is safe once the SPELLING has been checked.
    if !is_js_decimal(body) {
        return f64::NAN;
    }
    body.parse::<f64>().map(|v| sign * v).unwrap_or(f64::NAN)
}

/// Does this look like a JS `StrDecimalLiteral` body (no sign — the caller took it)?
///
/// Requires at least one digit, allows at most one `.`, and allows one `e`/`E` exponent with an
/// optional sign and at least one digit after it. Deliberately strict: everything it lets through
/// is a spelling Rust's own parser agrees with.
fn is_js_decimal(body: &str) -> bool {
    let (mantissa, exponent) = match body.split_once(['e', 'E']) {
        Some((m, e)) => (m, Some(e)),
        None => (body, None),
    };
    let mut digits = 0usize;
    let mut dots = 0usize;
    for c in mantissa.chars() {
        if c.is_ascii_digit() {
            digits += 1;
        } else if c == '.' {
            dots += 1;
        } else {
            return false;
        }
    }
    if digits == 0 || dots > 1 {
        return false;
    }
    match exponent {
        None => true,
        Some(e) => {
            let e = e
                .strip_prefix('-')
                .or_else(|| e.strip_prefix('+'))
                .unwrap_or(e);
            !e.is_empty() && e.chars().all(|c| c.is_ascii_digit())
        }
    }
}

/// One radix literal's digits, or `NaN` when it has none or has a bad one — `Number`'s answer.
fn radix(digits: &str, base: u32) -> f64 {
    if digits.is_empty() {
        return f64::NAN;
    }
    let mut out = 0.0f64;
    for c in digits.chars() {
        match c.to_digit(base) {
            Some(d) => out = out * f64::from(base) + f64::from(d),
            None => return f64::NAN,
        }
    }
    out
}

/// `Number(x) || 0` — the idiom `rowInfo` uses for every scalar it stores.
///
/// It is NOT `unwrap_or(0.0)`: JS `||` is falsiness, so `NaN`, `0` and `-0` all become `0`, and the
/// last of those is the one a naive port drops. `-0.0` and `0.0` compare equal in Rust so the
/// branch below catches it, and the returned zero is a positive one exactly as JS's is.
#[must_use]
fn js_number_or_zero(text: Option<&str>) -> f64 {
    let v = js_number(text.unwrap_or(""));
    if v == 0.0 || v.is_nan() {
        0.0
    } else {
        v
    }
}

// ── the parse ──────────────────────────────────────────────────────────────────────────────────

/// One effect slot, as the row spells it.
#[derive(Debug, Clone, Copy)]
struct Slot {
    effect: f64,
    base: f64,
    calc: f64,
    max: f64,
}

/// `parseSlots`. NOTE THE MISSING `|| 0`: the TypeScript reads a slot's numbers with a bare
/// `Number(...)`, so a malformed slot field yields `NaN` and the NaN flows into the comparisons
/// below. That is the shipped behaviour and it is reproduced rather than tidied — `NaN >= 0` is
/// false and `NaN < 5` is false, which between them decide whether a slot becomes a debuff window.
fn parse_slots(field: Option<&str>) -> Vec<Slot> {
    // `if (!field) return []` — an ABSENT field, which a 172-field row really has (see
    // [`parse_spells_us`]), and also an empty one, because `''` is falsy over there.
    let Some(field) = field else {
        return Vec::new();
    };
    if field.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    // `.trim()` before the split is what absorbs a CRLF file's trailing `\r`: nothing else in this
    // parser strips one, and on a CRLF row the `\r` lands on the LAST field, which is this one.
    for chunk in js_trim(field).split('$') {
        if chunk.is_empty() {
            continue;
        }
        let p: Vec<&str> = chunk.split('|').collect();
        if p.len() < 6 {
            continue;
        }
        out.push(Slot {
            effect: js_number(p[1]),
            base: js_number(p[2]),
            calc: js_number(p[4]),
            max: js_number(p[5]),
        });
    }
    out
}

/// `RESIST_EFFECTS` plus the `all` arm — a slot's axis, or `None` when the slot is not a resist
/// debuff at all.
fn slot_axis(effect: f64) -> Option<Axis> {
    if effect == EFFECT_ALL_RESISTS {
        return Some(Axis::All);
    }
    match effect as i64 {
        46 => Some(Axis::Fire),
        47 => Some(Axis::Cold),
        48 => Some(Axis::Poison),
        49 => Some(Axis::Disease),
        50 => Some(Axis::Magic),
        _ => None,
    }
}

/// `debuffSlots`.
fn debuff_slots(slots: &[Slot]) -> Vec<DebuffSlot> {
    let mut out = Vec::new();
    for s in slots {
        let Some(axis) = slot_axis(s.effect) else {
            continue;
        };
        // Only DECREASES; a spell that RAISES a resist is a buff and never opens a window here.
        if s.base >= 0.0 {
            continue;
        }
        let magnitude = s.base.abs().max(s.max.abs());
        if magnitude < MIN_DEBUFF_MAGNITUDE {
            continue;
        }
        out.push(DebuffSlot {
            axis,
            base: s.base,
            calc: s.calc,
            max: s.max,
        });
    }
    out
}

/// `levelCapOf` — the cap the game enforces regardless of rc, and ONLY from the PRIMARY slot.
///
/// Chaos Flux carries a stun rider capped at 55; being above it costs the STUN, not the nuke, so a
/// rider's cap must never make a whole spell "always resisted" (world-model law 6 — say what the
/// log cannot say, and this one it does not say at all).
fn level_cap_of(slots: &[Slot]) -> Option<f64> {
    let first = slots.first()?;
    if first.effect != EFFECT_CHARM && first.effect != EFFECT_MEZ {
        return None;
    }
    (first.max > 0.0).then_some(first.max)
}

/// `hpSlotOf` — the FIRST effect-0 slot. See [`DamageSlot`] for why it is effect 0 alone.
fn damage_slot_of(slots: &[Slot]) -> Option<DamageSlot> {
    slots
        .iter()
        .find(|s| s.effect == EFFECT_HITPOINTS)
        .map(|s| DamageSlot {
            base: s.base,
            max: s.max,
            calc: s.calc,
        })
}

/// `hpSlotsOf` — EVERY hitpoint slot in file order.
///
/// The effect set is `HP_EFFECTS`: 0 (the damage slot), 100 (heal over time — Ethereal Cleansing's
/// `1|100|10|0|103|100` against a page reading `Increase Hitpoints by 10 per tick`) and 334 (the
/// bard's pulsing hitpoint effect — Chords of Dissonance's `334|-2|109|0` against a page reading
/// `Decrease Hitpoints by 2 per tick`). Five wiki pages name a 334 slot's magnitude as a hitpoint
/// change and nothing else on those rows states one.
fn hp_slots_of(slots: &[Slot], per_tick: bool) -> Vec<HpSlot> {
    slots
        .iter()
        .filter(|s| s.effect == EFFECT_HITPOINTS || s.effect == 100.0 || s.effect == 334.0)
        .map(|s| HpSlot {
            base: s.base,
            max: s.max,
            calc: s.calc,
            per_tick,
        })
        .collect()
}

/// `classLevels` — whether ANY class can cast this, and whether only the bard can.
///
/// A valid level is `1..=254`: `>= 255` is the file's "cannot use" and `<= 0` is nothing. Note the
/// bound is on the NUMBER rather than on an integer, exactly as the TypeScript's is — a
/// non-integral value in that column would pass, which no real row has and both sides agree on.
fn class_levels(f: &[&str]) -> (bool, bool) {
    let mut any = false;
    let mut non_bard = false;
    let mut bard = false;
    for i in 0..F_CLASS_COUNT {
        let v = js_number(f.get(F_CLASS_FIRST + i).copied().unwrap_or(""));
        if !v.is_finite() || v >= 255.0 || v <= 0.0 {
            continue;
        }
        any = true;
        if i == CLASS_BARD {
            bard = true;
        } else {
            non_bard = true;
        }
    }
    (any, bard && !non_bard)
}

/// A field, as `f[i]` reads over there: `undefined` past the end, which `Number` reads as `NaN` and
/// `Number(x) || 0` reads as 0.
fn field<'a>(f: &[&'a str], i: usize) -> Option<&'a str> {
    f.get(i).copied()
}

/// `rowInfo` — one row's whole answer.
fn row_info(f: &[&str]) -> SpellInfo {
    let slots = parse_slots(field(f, F_SLOTS));
    let (_any, bard_only) = class_levels(f);
    let recast_ms = js_number_or_zero(field(f, F_RECAST_MS));
    let ae = js_number_or_zero(field(f, F_AE_MAX_TARGETS));
    let mana = js_number_or_zero(field(f, F_MANA));
    // `Number(f[11]) || 0`, and the whole `hpDuration` branch turns on it being non-zero.
    let formula = js_number_or_zero(field(f, F_DURATION_FORMULA));
    let hp = hp_slots_of(&slots, formula != 0.0);
    SpellInfo {
        // NOT `|| 0`: the resist type goes into `axisFromResistType` as `Number(...)` alone, and an
        // unparseable one is NaN, which matches no arm and is therefore `None` — the same answer a
        // chromatic spell gets, and the right one.
        axis: axis_from_resist_type(js_number(field(f, F_RESIST_TYPE).unwrap_or(""))),
        resist_adj: js_number_or_zero(field(f, F_RESIST_ADJ)),
        cast_ms: js_number_or_zero(field(f, F_CAST_MS)),
        recast_ms: (recast_ms > 0.0).then_some(recast_ms),
        ae_max_targets: (ae > 0.0).then_some(ae),
        mana: (mana > 0.0).then_some(mana),
        target_type: js_number_or_zero(field(f, F_TARGET_TYPE)),
        damage_slot: damage_slot_of(&slots),
        // `hpDuration` IS WRITTEN ONLY WHEN BOTH HOLD — there is at least one hitpoint slot AND the
        // row has a duration formula. The TypeScript nests the second test inside the first, so a
        // formula on a row with no hitpoint slot writes nothing, and this reproduces that shape
        // rather than the shorter one that would also write it.
        hp_duration: (!hp.is_empty() && formula != 0.0).then(|| HpDuration {
            formula,
            value: js_number_or_zero(field(f, F_DURATION)),
        }),
        hp,
        debuff_slots: debuff_slots(&slots),
        level_cap: level_cap_of(&slots),
        song: bard_only,
    }
}

/// Parse the whole file.
///
/// ── THE FOUR FILTERS, IN ORDER, AND WHY EACH IS SPELLED THE WAY IT IS ──────────────────────────
///
///   * `if (!line) continue` — an EMPTY line only. A blank-looking line of spaces is not skipped
///     here and falls out at the field-count test instead.
///   * `f.length < F_SLOTS` — **172, NOT 173.** A row with exactly 172 fields PASSES and then reads
///     `undefined` for its slots, which [`parse_slots`] answers with no slots at all. Tightening
///     this to 173 would drop rows the app keeps.
///   * `!name` — the empty string only. A whitespace-only name survives here and is caught by the
///     next test, because `spellCanonKey` trims it to nothing.
///   * `Number.isFinite(Number(f[0]))` — an id that is not a number. Note `''` is `0`, which is
///     finite, so a row with an EMPTY id is kept.
///
/// ── AND THE DEDUPE, WHICH IS THE ONE PIECE OF JUDGEMENT IN THE FILE ────────────────────────────
///
/// Ranked spells (`Scorching Arrow` I..IV) and NPC copies of a player spell all fold onto one key
/// via `spellCanonKey`, so FILE ORDER decides — with one override: a row NO class can cast is a
/// mob's or an item's copy and loses to a row a player can actually learn. First-wins otherwise.
#[must_use]
pub fn parse_spells_us(text: &str) -> SpellTable {
    let mut table: SpellTable = HashMap::new();
    // `playable` per key, beside the table — the TypeScript's `seen` map, whose only extra content
    // is that flag.
    let mut playable_by_key: HashMap<String, bool> = HashMap::new();
    for line in text.split('\n') {
        if line.is_empty() {
            continue;
        }
        let f: Vec<&str> = line.split('^').collect();
        if f.len() < F_SLOTS {
            continue;
        }
        let Some(name) = field(&f, F_NAME) else {
            continue;
        };
        if name.is_empty() {
            continue;
        }
        if !js_number(field(&f, F_ID).unwrap_or("")).is_finite() {
            continue;
        }
        let key = spell_canon_key(name);
        if key.is_empty() {
            continue;
        }
        let (playable, _bard_only) = class_levels(&f);
        if let Some(&held) = playable_by_key.get(&key) {
            // `prefer(existing, playable)` — replace only when the incumbent is unplayable and the
            // newcomer is not.
            if held || !playable {
                continue;
            }
        }
        table.insert(key.clone(), row_info(&f));
        playable_by_key.insert(key, playable);
    }
    table
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A row of 173 caret-delimited fields, with the class columns defaulted to `255` (cannot use)
    /// exactly as `tests/spellsUsParse.test.mts`'s own `row()` helper defaults them.
    ///
    /// THE ROWS BELOW ARE HAND-AUTHORED, and that is a rule rather than a convenience: the client
    /// table is Daybreak's file and neither it nor any slice of it may enter this repo. The numbers
    /// are the ones the app-side suite transcribed from the owner's install and pinned there, so
    /// this suite and that one are making the same claim about the same bytes.
    fn row(fields: &[(usize, &str)]) -> String {
        let mut f = vec!["0".to_string(); 173];
        for i in 0..F_CLASS_COUNT {
            f[F_CLASS_FIRST + i] = "255".to_string();
        }
        for (i, v) in fields {
            f[*i] = (*v).to_string();
        }
        f.join("^")
    }

    fn one(fields: &[(usize, &str)]) -> SpellInfo {
        let table = parse_spells_us(&row(fields));
        assert_eq!(table.len(), 1, "the row parsed to exactly one entry");
        table.into_values().next().expect("the one entry")
    }

    // ── the JavaScript arithmetic ─────────────────────────────────────────────────────────────

    #[test]
    fn js_number_is_javascripts_number_and_not_rusts_parser() {
        // THE FOUR DIFFERENCES THAT MATTER, each of which the app's shipped behaviour depends on.
        assert_eq!(
            js_number(""),
            0.0,
            "the empty string is zero, never an error"
        );
        assert_eq!(
            js_number("   "),
            0.0,
            "…and so is whitespace, trimmed first"
        );
        assert_eq!(js_number("  12  "), 12.0);
        assert_eq!(js_number("0x1f"), 31.0, "a radix prefix is a number");
        assert!(js_number("-0x10").is_nan(), "…and takes no sign");
        assert_eq!(js_number("1e3"), 1000.0);
        assert_eq!(js_number("+7"), 7.0);
        assert_eq!(js_number("-1.5"), -1.5);
        assert_eq!(js_number("Infinity"), f64::INFINITY);
        assert_eq!(js_number("-Infinity"), f64::NEG_INFINITY);
        // …AND THE SPELLINGS RUST ACCEPTS AND JAVASCRIPT DOES NOT. Delegating to `f64::from_str`
        // without the spelling guard would make every one of these a number.
        for spelled in [
            "inf", "infinity", "INFINITY", "NaN", "nan", "abc", "1.2.3", "1e", ".",
        ] {
            assert!(js_number(spelled).is_nan(), "Number({spelled:?}) is NaN");
        }
    }

    #[test]
    fn the_or_zero_idiom_is_falsiness_and_not_a_default() {
        assert_eq!(js_number_or_zero(Some("abc")), 0.0, "NaN falls to zero");
        assert_eq!(
            js_number_or_zero(None),
            0.0,
            "an absent field falls to zero"
        );
        assert_eq!(
            js_number_or_zero(Some("-0")),
            0.0,
            "…and so does negative zero"
        );
        assert!(
            js_number_or_zero(Some("-0")).is_sign_positive(),
            "the zero it falls to is a positive one, as JavaScript's is"
        );
        assert_eq!(js_number_or_zero(Some("1500")), 1500.0);
    }

    // ── the field map ─────────────────────────────────────────────────────────────────────────

    /// Tashani (id 677) — the row that settled the slot layout. `2|50|-10|0|101|23`: calc 101 is
    /// "base + level/2, capped" and 23 is the cap. Read the other way round the formula code would
    /// be 23, which is not a formula.
    #[test]
    fn tashani_is_a_magic_debuff_with_a_cap_of_twenty_three() {
        let info = one(&[
            (F_ID, "677"),
            (F_NAME, "Tashani"),
            (F_RESIST_TYPE, "1"),
            (F_SLOTS, "2|50|-10|0|101|23"),
            (F_CLASS_FIRST + 13, "16"),
        ]);
        assert_eq!(info.axis, Some(Axis::Magic));
        assert_eq!(info.debuff_slots.len(), 1);
        let d = info.debuff_slots[0];
        assert_eq!(d.axis, Axis::Magic);
        assert_eq!((d.base, d.calc, d.max), (-10.0, 101.0, 23.0));
        assert!(!info.song, "an enchanter row is not a song");
    }

    /// Malaisement — the `all resists` family, effect 111, which is a SLOT axis and never a
    /// spell's.
    #[test]
    fn the_tash_and_malo_family_carries_the_all_axis() {
        let info = one(&[
            (F_ID, "111"),
            (F_NAME, "Malaisement"),
            (F_SLOTS, "1|111|-20|0|101|40"),
            (F_CLASS_FIRST + 10, "44"),
        ]);
        assert_eq!(info.debuff_slots.len(), 1);
        assert_eq!(info.debuff_slots[0].axis, Axis::All);
        assert_eq!(info.debuff_slots[0].max, 40.0);
    }

    /// A one-point rider is NOT a debuff window — Solon's Bewitching Bravura's whole argument.
    #[test]
    fn a_rider_below_the_magnitude_floor_opens_no_window() {
        let info = one(&[
            (F_ID, "1"),
            (F_NAME, "Solon's Bewitching Bravura"),
            (F_SLOTS, "1|22|1|0|100|50$2|50|-1|0|100|1"),
        ]);
        assert!(info.debuff_slots.is_empty());
    }

    /// …and a slot that RAISES a resist is a buff, whatever its magnitude.
    #[test]
    fn a_resist_buff_is_never_a_debuff_window() {
        let info = one(&[
            (F_ID, "2"),
            (F_NAME, "Resist Fire"),
            (F_SLOTS, "1|46|40|0|100|40"),
        ]);
        assert!(info.debuff_slots.is_empty());
    }

    /// Mesmerization (`1|31|2|0|100|55`) — the level cap, from the PRIMARY slot.
    #[test]
    fn a_mez_carries_its_level_cap_off_the_first_slot() {
        let info = one(&[
            (F_ID, "307"),
            (F_NAME, "Mesmerization"),
            (F_SLOTS, "1|31|2|0|100|55"),
        ]);
        assert_eq!(info.level_cap, Some(55.0));
    }

    /// Chaos Flux — a STUN rider capped at 55 on a later slot. Being above it costs the stun, not
    /// the nuke, so the cap must not reach the whole spell.
    #[test]
    fn a_riders_cap_never_becomes_the_spells_cap() {
        let info = one(&[
            (F_ID, "350"),
            (F_NAME, "Chaos Flux"),
            (F_SLOTS, "1|50|-20|0|101|30$2|31|2|0|100|55"),
        ]);
        assert_eq!(info.level_cap, None, "slot 2's cap is not the spell's");
        assert_eq!(
            info.debuff_slots.len(),
            1,
            "…and slot 1 is still a real window"
        );
    }

    /// FIELD 10 IS THE RECAST AND FIELD 9 IS NOT. Field 9 is settable here for exactly the reason
    /// the app-side suite makes it settable: to prove the parser does not read it.
    #[test]
    fn the_recast_is_field_ten_and_field_nine_is_ignored() {
        let info = one(&[
            (F_ID, "4093"),
            (F_NAME, "Odium"),
            (9, "1500"),
            (F_RECAST_MS, "6000"),
        ]);
        assert_eq!(info.recast_ms, Some(6000.0));
    }

    /// A ZERO RECAST IS AN ABSENCE, not a zero — Complete Heal reads `9 = 1500, 10 = 0`.
    #[test]
    fn a_zero_in_an_absent_means_nothing_column_is_an_absence() {
        let info = one(&[
            (F_ID, "1292"),
            (F_NAME, "Complete Heal"),
            (9, "1500"),
            (F_RECAST_MS, "0"),
            (F_AE_MAX_TARGETS, "0"),
            (F_MANA, "350"),
        ]);
        assert_eq!(info.recast_ms, None);
        assert_eq!(info.ae_max_targets, None);
        assert_eq!(info.mana, Some(350.0), "…while a positive one is carried");
    }

    /// Odium: duration formula 7 with a cap of 5, and a per-tick hitpoint slot.
    #[test]
    fn a_duration_row_marks_its_hitpoint_slots_per_tick() {
        let info = one(&[
            (F_ID, "4093"),
            (F_NAME, "Odium"),
            (F_DURATION_FORMULA, "7"),
            (F_DURATION, "5"),
            (F_SLOTS, "2|0|-217|0|103|325"),
        ]);
        assert_eq!(info.hp.len(), 1);
        assert!(info.hp[0].per_tick);
        assert_eq!(
            info.hp_duration,
            Some(HpDuration {
                formula: 7.0,
                value: 5.0
            })
        );
        // …and the estimator's own slot is the same effect-0 line, unmarked.
        assert_eq!(
            info.damage_slot,
            Some(DamageSlot {
                base: -217.0,
                max: 325.0,
                calc: 103.0
            })
        );
    }

    /// Bolt of Karana's shape: formula 0, so the hitpoint slot is the whole hit and there is no
    /// `hpDuration` at all.
    #[test]
    fn an_instant_row_has_no_duration_and_its_slot_is_not_per_tick() {
        let info = one(&[
            (F_ID, "3"),
            (F_NAME, "Bolt of Karana"),
            (F_DURATION_FORMULA, "0"),
            (F_SLOTS, "1|0|-200|0|100|200"),
        ]);
        assert_eq!(info.hp.len(), 1);
        assert!(!info.hp[0].per_tick);
        assert_eq!(info.hp_duration, None);
    }

    /// A FORMULA WITH NO HITPOINT SLOT WRITES NO DURATION — the nesting in `rowInfo`, which a
    /// flattened port would get wrong.
    #[test]
    fn a_duration_on_a_row_with_no_hitpoint_slot_writes_nothing() {
        let info = one(&[
            (F_ID, "4"),
            (F_NAME, "Clarity"),
            (F_DURATION_FORMULA, "7"),
            (F_DURATION, "50"),
            (F_SLOTS, "1|15|10|0|100|10"),
        ]);
        assert!(info.hp.is_empty());
        assert_eq!(info.hp_duration, None);
    }

    /// Ethereal Cleansing (effect 100) and Chords of Dissonance (effect 334) — the two hitpoint
    /// effects that are NOT effect 0, so they reach `hp` and never `damage_slot`.
    #[test]
    fn the_two_other_hitpoint_effects_reach_hp_but_not_the_damage_slot() {
        let hot = one(&[
            (F_ID, "3683"),
            (F_NAME, "Ethereal Cleansing"),
            (F_DURATION_FORMULA, "3"),
            (F_SLOTS, "1|100|10|0|103|100"),
        ]);
        assert_eq!(hot.hp.len(), 1);
        assert_eq!(hot.hp[0].base, 10.0);
        assert_eq!(
            hot.damage_slot, None,
            "effect 100 is not the estimator's slot"
        );

        let song = one(&[
            (F_ID, "703"),
            (F_NAME, "Chords of Dissonance"),
            (F_DURATION_FORMULA, "3"),
            (F_SLOTS, "1|334|-2|0|109|0"),
            (F_CLASS_FIRST + CLASS_BARD, "5"),
        ]);
        assert_eq!(song.hp.len(), 1);
        assert_eq!(song.hp[0].base, -2.0);
        assert_eq!(song.damage_slot, None);
        assert!(song.song, "a bard-only row is a song");
    }

    /// A row castable by the bard AND somebody else is not a song.
    #[test]
    fn bard_only_means_only_the_bard() {
        let info = one(&[
            (F_ID, "5"),
            (F_NAME, "Shared Thing"),
            (F_CLASS_FIRST + CLASS_BARD, "5"),
            (F_CLASS_FIRST + 5, "12"),
        ]);
        assert!(!info.song);
    }

    /// The class-level window is `1..=254`: 255 is "cannot use" and 0 is nothing.
    #[test]
    fn the_class_level_window_excludes_both_ends() {
        for level in ["255", "0", "256"] {
            let table = parse_spells_us(&row(&[
                (F_ID, "6"),
                (F_NAME, "Unlearnable"),
                (F_CLASS_FIRST + 5, level),
            ]));
            assert_eq!(table.len(), 1);
            // Unplayable rows still parse — they simply LOSE a key contest to a playable row.
            assert!(!table.values().next().expect("one").song);
        }
    }

    // ── the row filters ───────────────────────────────────────────────────────────────────────

    #[test]
    fn a_row_with_exactly_one_hundred_and_seventy_two_fields_is_kept() {
        // `f.length < 172`, NOT `< 173`. The row passes and then reads `undefined` for its slots,
        // which is no slots at all rather than a panic. Tightening the bound would drop rows the
        // app keeps, which is why this is pinned rather than commented.
        let mut f = vec!["0".to_string(); 172];
        f[F_NAME] = "Short Row".to_string();
        for i in 0..F_CLASS_COUNT {
            f[F_CLASS_FIRST + i] = "255".to_string();
        }
        let table = parse_spells_us(&f.join("^"));
        assert_eq!(table.len(), 1);
        let info = table.into_values().next().expect("one");
        assert!(info.hp.is_empty());
        assert!(info.debuff_slots.is_empty());
        assert_eq!(info.level_cap, None);
    }

    #[test]
    fn a_row_one_field_shorter_than_that_is_dropped() {
        let f = vec!["0".to_string(); 171];
        assert!(parse_spells_us(&f.join("^")).is_empty());
    }

    #[test]
    fn an_empty_id_is_finite_and_therefore_kept() {
        // `Number('')` is 0, which is finite. A port that used `str::parse` would have dropped
        // these rows silently.
        let table = parse_spells_us(&row(&[(F_ID, ""), (F_NAME, "No Id")]));
        assert_eq!(table.len(), 1);
    }

    #[test]
    fn a_non_numeric_id_is_dropped_and_an_empty_name_is_too() {
        assert!(parse_spells_us(&row(&[(F_ID, "abc"), (F_NAME, "Bad Id")])).is_empty());
        assert!(parse_spells_us(&row(&[(F_ID, "1"), (F_NAME, "")])).is_empty());
        // A WHITESPACE-ONLY NAME survives the `!name` test and dies at the key test, because
        // `spellCanonKey` trims it to nothing. Two different filters, one outcome.
        assert!(parse_spells_us(&row(&[(F_ID, "1"), (F_NAME, "   ")])).is_empty());
    }

    #[test]
    fn empty_lines_are_skipped_and_a_crlf_file_still_parses_its_slots() {
        // NOTHING STRIPS `\r`. On a CRLF file the carriage return lands on the LAST field, which is
        // the slots, and `parse_slots`'s own trim is what absorbs it — so the slot survives.
        let text = format!(
            "\n{}\r\n\n",
            row(&[
                (F_ID, "7"),
                (F_NAME, "Crlf Spell"),
                (F_SLOTS, "1|31|2|0|100|55")
            ])
        );
        let table = parse_spells_us(&text);
        assert_eq!(table.len(), 1);
        assert_eq!(table.values().next().expect("one").level_cap, Some(55.0));
    }

    // ── the dedupe ────────────────────────────────────────────────────────────────────────────

    #[test]
    fn ranks_fold_onto_one_key_and_the_first_row_wins() {
        let text = format!(
            "{}\n{}",
            row(&[
                (F_ID, "74042"),
                (F_NAME, "Scorching Arrow I"),
                (F_RESIST_ADJ, "10"),
                (F_CLASS_FIRST + 3, "20")
            ]),
            row(&[
                (F_ID, "74045"),
                (F_NAME, "Scorching Arrow IV"),
                (F_RESIST_ADJ, "40"),
                (F_CLASS_FIRST + 3, "50")
            ])
        );
        let table = parse_spells_us(&text);
        assert_eq!(table.len(), 1, "the rank tail folds both onto one key");
        assert_eq!(
            table["scorching arrow"].resist_adj, 10.0,
            "file order decides, and the first row wins"
        );
    }

    #[test]
    fn an_npc_copy_loses_to_the_row_a_player_can_learn() {
        // THE ONE OVERRIDE on first-wins: a row NO class can cast is a mob's or an item's copy.
        // Chaos Flux (350) and its NPC copy (6850) are the measured pair.
        let text = format!(
            "{}\n{}",
            row(&[(F_ID, "6850"), (F_NAME, "Chaos Flux"), (F_RESIST_ADJ, "99")]),
            row(&[
                (F_ID, "350"),
                (F_NAME, "Chaos Flux"),
                (F_RESIST_ADJ, "-20"),
                (F_CLASS_FIRST + 11, "39")
            ])
        );
        let table = parse_spells_us(&text);
        assert_eq!(table.len(), 1);
        assert_eq!(
            table["chaos flux"].resist_adj, -20.0,
            "the playable row replaces the unplayable one"
        );
    }

    #[test]
    fn a_playable_row_is_never_replaced_by_a_later_one() {
        let text = format!(
            "{}\n{}",
            row(&[
                (F_ID, "350"),
                (F_NAME, "Chaos Flux"),
                (F_RESIST_ADJ, "-20"),
                (F_CLASS_FIRST + 11, "39")
            ]),
            row(&[(F_ID, "6850"), (F_NAME, "Chaos Flux"), (F_RESIST_ADJ, "99")])
        );
        assert_eq!(parse_spells_us(&text)["chaos flux"].resist_adj, -20.0);
        // …not even by another playable one.
        let two_playable = format!(
            "{}\n{}",
            row(&[
                (F_ID, "1"),
                (F_NAME, "Twice"),
                (F_RESIST_ADJ, "1"),
                (F_CLASS_FIRST + 11, "39")
            ]),
            row(&[
                (F_ID, "2"),
                (F_NAME, "Twice"),
                (F_RESIST_ADJ, "2"),
                (F_CLASS_FIRST + 11, "40")
            ])
        );
        assert_eq!(parse_spells_us(&two_playable)["twice"].resist_adj, 1.0);
    }

    // ── the axis map ──────────────────────────────────────────────────────────────────────────

    #[test]
    fn the_five_axes_map_and_everything_else_is_refused() {
        assert_eq!(axis_from_resist_type(1.0), Some(Axis::Magic));
        assert_eq!(axis_from_resist_type(2.0), Some(Axis::Fire));
        assert_eq!(axis_from_resist_type(3.0), Some(Axis::Cold));
        assert_eq!(axis_from_resist_type(4.0), Some(Axis::Poison));
        assert_eq!(axis_from_resist_type(5.0), Some(Axis::Disease));
        // 0 unresistable, 6 chromatic, 7 prismatic, 8 physical, 9 corruption — REFUSED rather than
        // guessed at, because none of them is a column the ledger can pool under.
        for t in [0.0, 6.0, 7.0, 8.0, 9.0, -1.0] {
            assert_eq!(axis_from_resist_type(t), None, "resist type {t}");
        }
        assert_eq!(axis_from_resist_type(f64::NAN), None, "an unparseable type");
    }
}
