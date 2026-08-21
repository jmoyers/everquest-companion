// RAIN SPELLS — ONE CAST, SEVERAL WAVES, AND NOT A PROC IN SIGHT (JOS-414, GitHub issue 39).
//
// THE REPORT. A wizard's meter showed `Lava Storm` TWICE in one fight's ability breakdown — once
// as `Lava Storm` and once as `Lava Storm · proc`, the second wearing a 6.21 ppm proc rate — and
// the reporter read it, reasonably, as the same damage counted twice.
//
// WHAT A RAIN IS, and it is the owner's ruling as well as the game's mechanic: a rain spell is
// ONE cast that delivers a FIXED NUMBER OF WAVES. Every wave is direct spell damage; each wave
// strikes every target inside the radius (so one wave can print several lines, one per target).
// It is not a DoT — the ticks are waves of the one cast, not a duration effect — and it is not a
// proc: no item, buff or AA in this game fires a rain.
//
// ── MEASURED ON THE OWNER'S OWN LOG (read-only sweep, 2026-08-19) ────────────────────────────
//
// He casts two of them, and both reproduce the report first-person:
//
//   spell            casts  landing lines  waves per cast (distinct seconds)   wave offsets
//   Poison Storm      86        311        1×23, 2×55, 3×5                     +0..3s, +3..7s, +7s
//   Gale of Poison    42        141        1×13, 2×25, 3×1                     +1..5s, +4..8s, +7s
//
// 452 first-person rain damage lines. 326 of them land on the cast's FIRST second and 126 on a
// later one — and it is exactly those 126 lines (11,430 of the 41,381 hit points, 27.6%) that the
// cast/proc join files under a `· proc` lane and counts into the proc ledger as firings.
//
// Third parties' rains in the same log land the same way: `Lava Storm` 19:32:23 / :26 / :29 for
// 605 + 605 + 488 (Kreljnok, Wed Aug 05), `Firestorm` 20:25:07 / :09 / :13 (Eklipz, Tue Jul 28).
// Three waves is the ceiling anywhere in 2.1M lines; a wave that connects with nothing prints
// nothing, which is why 1- and 2-wave casts are the common shapes and why the FIXED count is a
// property of the spell rather than something to enforce against the log.
//
// EVERY WAVE ARRIVES INSIDE THE PROC WINDOW (max observed offset +8s, PROC_CAST_WINDOW_MS is 12s),
// so the window was never the problem — the ONE-INSTANT claim rule in `RecentCasts.origin` was.
// See procDetect.ts's header for the rule and for why it is right for everything that is not a
// rain.
//
// ── THE ROSTER IS DERIVED FROM THE WIKI'S OWN SENTENCE, NOT FROM NAMES ───────────────────────
//
// Same discipline as spellEffectClass.ts: match what the wiki WROTE about the mechanic, anchored,
// never a stem of the spell's NAME (`storm` would sweep up `Manastorm`'s cousins and miss every
// `Tears of …`; `rain` as a substring matches `drain`, and the DB has 42 drains that say so).
//
// A rain's landing sentence says the damage RAINS DOWN on you:
//
//   Lava Storm     "Your skin blisters as fire rains down from above."
//   Rain of Swords "Your skin shreds as swords rain down from above."
//   Poison Storm   "Your skin blisters as poison rains down on you."
//
// `\brains? down\b` over the DB's two cast messages gives exactly 17 spells, every one of them a
// Targeted-AE direct-damage nuke from the three rain-casting classes, and nothing else in the
// 1,928-row catalog matches. `tests/rainSpellWaves.test.mts` pins the membership so a re-scrape
// that widens or narrows it fails loudly.
//
// HONEST LIMIT, stated rather than papered over: the game has rains whose sentence does not use
// the word (`Sirocco`, `Cascade of Hail` are the candidates), and the owner's log contains no
// first-person cast of either, so nothing here can say whether they wave. They stay OUT until a
// log shows the shape — the awaiting-sample law. Their cost while out is the reported defect on
// those two names only; their cost if guessed in would be a silently-wrong roster nobody read.

import spellsJson from '../data/spells.json'
import { applySpellCorrections } from '../data/spellCorrections'
import { applySpellRemovals } from '../data/spellRemovals'
import { spellCanonKey } from '../log/parseCommon'
import type { SpellDbFile, SpellEntry } from '../../shared/types'

/**
 * The scrape as this app is allowed to read it: rows EQ Legends does not have are gone first
 * (the removals seam — a raw-`spells.json` index in front of it is the standing hazard
 * `tests/spellRemovals.test.mts` greps for), and the corrections overlay is applied to what is
 * left so `raw[i]` and `corrected[i]` stay in INDEX LOCKSTEP.
 */
const RAW: readonly SpellEntry[] = applySpellRemovals((spellsJson as SpellDbFile).spells).spells
const CORRECTED: readonly SpellEntry[] = applySpellCorrections(RAW).spells

/**
 * The wiki phrasing that IS the mechanic: "… as fire rains down from above.", "… as swords rain
 * down from above.", "… as poison rains down on you."
 *
 * Word-anchored at both ends on purpose. Without the leading `\b` it matches the whole `drain`
 * family (`You feel your life force drain away.` — 42 rows, every lifetap in the game).
 */
const RAIN_MESSAGE_RE = /\brains? down\b/i

const saysRain = (s: SpellEntry): boolean =>
  RAIN_MESSAGE_RE.test(`${s.msgCastOnYou ?? ''} ${s.msgCastOnOther ?? ''}`)

/** Canonical keys (rank tail stripped, lowercased — law 2) of every rain the DB names. */
const RAIN_KEYS: ReadonlySet<string> = (() => {
  const keys = new Set<string>()
  // BOTH SPELLINGS, for the reason charmModel.ts states over the same import: a name is a join
  // key, the corrections overlay can rename a row (`Solon's Bravura` → `Solon's Bewitching
  // Bravura`), and the parser only ever sees the LOG's spelling. Nothing in today's rain family
  // is corrected — this is the invariant kept, not a fix for an observed miss.
  RAW.forEach((s, i) => {
    if (!saysRain(s)) return
    keys.add(spellCanonKey(s.name))
    keys.add(spellCanonKey(CORRECTED[i]?.name ?? s.name))
  })
  return keys
})()

/** Display names of the derived roster, sorted — the audit test's subject. */
export const RAIN_SPELL_NAMES: readonly string[] = [
  ...new Set(RAW.filter(saysRain).map((s) => s.name))
].sort()

/**
 * True when a spell delivers its damage in WAVES from one cast.
 *
 * Rank-blind (`spellCanonKey`), because a damage line prints the rank-less name while the cast
 * line may carry the numeral — the same boundary rule every other name join in this engine uses.
 */
export function isRainSpell(spell: string): boolean {
  return RAIN_KEYS.has(spellCanonKey(spell))
}
