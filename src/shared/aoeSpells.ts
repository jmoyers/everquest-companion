// WHAT AN AREA SPELL IS WORTH WHEN IT CATCHES EVERYTHING IT CAN (JOS-449, owner ask 2026-08-23).
//
// The owner's ask, verbatim: *"lets include rain spells in DD by default. lets also have a separate
// AOE tab that assumes max target count."* Two tabs because there are two real questions, and one
// table cannot answer both: the DD tab is what a spell does to the mob you are fighting, and the
// AOE tab is what it does to the pack you just pulled. A rain is the spell that makes the gap
// obvious — `Frost Storm` is 1,536 damage on one mob and 2,048 on four.
//
// This file is the small pure core both readings share. It holds no roster and no catalog: the wave
// count comes from `src/main/data/rainSpells.ts` (which carries the whole research) and rides the
// wire on the unlock row, and the per-spell cap comes from the player's own client file where he
// has one. What lives here is the SHAPE TEST, the DEFAULT, the ARITHMETIC and the WORDS — the four
// things the model and the panel must not each have an opinion about.
//
// ── HOW MANY TIMES A CAST LANDS, AND WHY IT IS NOT `waves x targets` ──────────────────────────
//
// A rain is capped on HITS, not on targets per wave. Four wiki pages say it in the same sentence
// (`rainSpells.ts` quotes it and names them): "Rain nukes are limited to 4 hits total. Either you
// can hit the same mobs 3 times, you can hit 2 mobs twice each, or you can hit 4 mobs once each."
// `Torrent of Poison`'s page corroborates it arithmetically — "At 1620-2160 damage" over a 540
// per-wave magnitude is 3x540 to 4x540, where three waves on four targets would be 6,480.
//
// So `aeHits` is `min(waves x targets, cap)` and the two readings differ only in what `targets` is:
//
//   DD tab   waves 3, targets 1, cap 4  ->  3 hits   (the cap is not reached)
//   AOE tab  waves 3, targets 4, cap 4  ->  4 hits   (the cap is the whole answer)
//   a plain targeted AE, AOE tab: waves 1, targets 4, cap 4 -> 4 hits
//   a plain targeted AE, DD tab:  waves 1, targets 1, cap 4 -> 1 hit, which is today's figure
//
// The last line is the compatibility property worth stating: a non-rain read at one target is
// `min(1, cap)` = 1, so every figure this app printed before JOS-449 is unchanged by construction.
//
// ── THE CAP, AND WHERE THE FOUR COMES FROM ────────────────────────────────────────────────────
//
// MEASURED on the owner's install (`spells_us.txt` field 143, `aemaxtargets`, 2026-08-23): 4 on all
// 23 rains, 4 on 45 of the 46 Targeted AE rows in the committed catalog, and 8 on a PB AE. The
// client is therefore the authority WHERE IT IS IN HAND, per spell, and it reaches this arithmetic
// the way every other client fact does (`SpellResistInfo` -> `ClientHpFacts` -> the unlock row).
//
// `DEFAULT_AE_MAX_TARGETS` is what answers for a reader with no EverQuest install, which includes
// every unit test over the committed corpus. It is 4 because that is what the wiki states in prose
// for the family this ticket is about ("a maximum of 4 targets hit") and what the client states for
// 45 of 46 targeted AEs. IT IS AN ASSUMPTION AND THE SURFACE SAYS SO — `aoeAssumptionLabel` below
// is the marker, and the owner's ruling was that the assumption must be visible rather than silent.
//
// Pure, node-tested (tests/aoeSpells.test.mts), no imports at all.

/**
 * THE TARGET TYPES THAT MEAN "MORE THAN ONE THING GETS HIT", lowercased for a case-blind test.
 *
 * Read off the committed catalog's own `target_type` strings rather than invented: over the 434
 * damage spells the DB carries, the shapes are `Targeted AE` (67), `PB AE` (52), `PBAOE` (2) and
 * `AE` (1). The last two are spelling drift on two pages and one NPC row, and they are listed
 * rather than folded by a regex for the anchor reason `spellEffectClass.ts` gives: a pattern like
 * `/ae/` also matches nothing else today and would match the first target type somebody adds with
 * those two letters in it.
 *
 * NOT IN THE SET, deliberately: `Line of Sight`, `Bolt`, `Undead`, `Summoned`, `Animal`, `Plant`
 * and the two `Uber …` rows. Some of them can strike more than one creature in flight, none of
 * them states a target count anywhere, and a tab whose whole premise is a stated maximum has no
 * honest figure to print for them.
 */
export const AE_TARGET_TYPES: ReadonlySet<string> = new Set(['targeted ae', 'pb ae', 'pbaoe', 'ae'])

/** True when the catalog's `target_type` for a spell is one of the area shapes. */
export function isAeTargetType(targetType: string | undefined): boolean {
  return targetType !== undefined && AE_TARGET_TYPES.has(targetType.trim().toLowerCase())
}

/**
 * The target count assumed for an area spell whose own cap is not known. See the header: measured
 * as the client's answer for 45 of 46 targeted AEs, and stated by the wiki in prose for the rains.
 */
export const DEFAULT_AE_MAX_TARGETS = 4

/** A spell's own cap where a source stated a positive one, the default otherwise. */
export function aeMaxTargets(stated: number | null | undefined): number {
  return typeof stated === 'number' && Number.isFinite(stated) && stated > 0
    ? Math.trunc(stated)
    : DEFAULT_AE_MAX_TARGETS
}

/**
 * HOW MANY TIMES ONE CAST'S MAGNITUDE LANDS: `min(waves x targets, cap)`.
 *
 * Never below 1 — a spell always lands once — and every argument is floored to a whole number,
 * because a fraction of a hit is not a thing the game does and a rounding decision here would be
 * invisible three layers up in a dps column.
 */
export function aeHits(waves: number, targets: number, cap: number): number {
  const w = Math.max(1, Math.trunc(waves))
  const t = Math.max(1, Math.trunc(targets))
  const c = Math.max(1, Math.trunc(cap))
  return Math.max(1, Math.min(w * t, c))
}

/**
 * THE VISIBLE ASSUMPTION (owner ruling: the AOE tab's figures assume max target count and the
 * assumption must be stated on the surface, quietly, once).
 *
 * It is COMPUTED FROM THE ROWS IN FORCE rather than printing the default, because the default is
 * not always what the table used: a reader with a client install gets each spell's own cap, and a
 * marker reading `x4 targets` over a PB AE figured at eight would be a caption that lies. One
 * count gives `x4 targets`; a mixed table gives the range it actually spans.
 *
 * An EMPTY table still answers, with the default — the marker sits on the tab surface rather than
 * inside the table, so it has to say something even when there is nothing to say it about.
 *
 * No em dashes: this is player copy.
 */
export function aoeAssumptionLabel(targetCounts: readonly number[]): string {
  const counts = targetCounts.filter((n) => Number.isFinite(n) && n > 0)
  if (counts.length === 0) return `x${String(DEFAULT_AE_MAX_TARGETS)} targets`
  const lo = Math.min(...counts)
  const hi = Math.max(...counts)
  return lo === hi ? `x${String(lo)} targets` : `x${String(lo)} to x${String(hi)} targets`
}

/** The longer sentence behind the marker, for its tooltip. Stated once, beside the words. */
export const AOE_ASSUMPTION_TITLE =
  'Figures assume every target the spell can hit. Four unless your client states the spell its own cap. A rain is capped at four hits in total across its three waves, so a pack takes four and one mob takes three.'
