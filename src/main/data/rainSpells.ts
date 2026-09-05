// RAIN SPELLS — ONE CAST, THREE WAVES, FOUR HITS AT MOST (JOS-414, widened and measured by JOS-449).
//
// THE ORIGINAL REPORT (JOS-414, GitHub issue 39). A wizard's meter showed `Lava Storm` TWICE in one
// fight's ability breakdown — once as `Lava Storm` and once as `Lava Storm · proc`, the second
// wearing a 6.21 ppm proc rate — and the reporter read it, reasonably, as the same damage counted
// twice.
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
//   Poison Storm      86        311        1x23, 2x55, 3x5                     +0..3s, +3..7s, +7s
//   Gale of Poison    42        141        1x13, 2x25, 3x1                     +1..5s, +4..8s, +7s
//
// 452 first-person rain damage lines. 326 of them land on the cast's FIRST second and 126 on a
// later one — and it is exactly those 126 lines (11,430 of the 41,381 hit points, 27.6%) that the
// cast/proc join filed under a `· proc` lane and counted into the proc ledger as firings.
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
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// JOS-449: THE ROSTER, THE WAVE COUNT AND THE TARGET CAP, FROM THREE INDEPENDENT INSTRUMENTS
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// The owner's ask (2026-08-23, verbatim): *"look closely into how rain spells work, because they
// are odd in EQ"* — and *"you can likely find other rain spells, and then compare to spell text"*.
// So the roster below is not a hand list and not a name stem. It is the AGREEMENT of three sources
// that were read separately, and the disagreements between them are the interesting part.
//
// ── INSTRUMENT 1: THE CAST MESSAGE (JOS-414's derivation, still computed below) ───────────────
//
// A rain's landing sentence often says the damage RAINS DOWN on you:
//
//   Lava Storm     "Your skin blisters as fire rains down from above."
//   Rain of Swords "Your skin shreds as swords rain down from above."
//   Poison Storm   "Your skin blisters as poison rains down on you."
//
// `\brains? down\b` over the DB's two cast messages gives 17 spells (`MESSAGE_RAIN_NAMES`). It is
// word-anchored at both ends on purpose: without the leading `\b` it matches the whole `drain`
// family (`You feel your life force drain away.` — 42 rows, every lifetap in the game).
//
// JOS-414 STATED ITS OWN HONEST LIMIT and it turned out to be exactly right: *"the game has rains
// whose sentence does not use the word (`Sirocco`, `Cascade of Hail` are the candidates)"*. It has
// six, and the messages say why the regex could never have found them:
//
//   Avalanche        "You are entombed in ice."
//   Blizzard         "You are caught in a raging blizzard."
//   Cascade of Hail  "You are pelted by hailstones."
//   Icestrike        "You are pelted by sleet."
//   Pogonip          "You are sheathed in ice crystals."
//   Sirocco          "A blistering wind envelops your body."
//
// ── INSTRUMENT 2: THE WIKI PAGE'S OWN PROSE (JOS-449's sweep) ─────────────────────────────────
//
// Every Targeted AE damage spell in the committed catalog (67 of them) had its cached wikitext
// `description` read — `scripts/sources/cache/spells`, which is committed, so the sweep cost ZERO
// network requests. 23 of the 67 state waves, and each one's sentence is quoted on its row below.
// The prose is the SUPERSET: all 17 of instrument 1 are in it, plus the six above.
//
// EVERY ONE OF THE 23 SAYS THREE. Not one page in the whole cache states a count other than three;
// the two that hedge hedge DOWNWARD (`Torrent of Poison` "1-3 waves" — a wave that connects with
// nothing prints nothing, the same thing the log measured; `Manastorm` "(x3 waves?)" — a question
// instrument 3 answers). So `waves: 3` is a per-spell field carrying a universal fact, spelled per
// row so a future four-wave rain is expressible without a schema argument.
//
// ── INSTRUMENT 3: THE CLIENT'S OWN TABLE (`spells_us.txt`, owner's install, 2026-08-23) ───────
//
// Field 13 is `AEDuration`, in ms: the window a targeted AE keeps pulsing for. It reads **7500 on
// every one of the 23** and on nothing else that a player casts, and 7500 / 2500ms per pulse is
// three waves — the third fully independent statement of the same number. (`Manastorm` has four
// rows in the file under that name; the player's is id 1665, cast 6000 to match its page, and it
// reads 7500. That is what settles the wiki's question mark.)
//
// Field 143 is `aemaxtargets`: **4** on all 23, on 45 of the 46 Targeted AE rows in the catalog,
// and 8 on a PB AE. `shared/aoeSpells.ts` owns what this app does with that number and states the
// default it uses where no client file is in hand.
//
// ── AND THE CAP IS ON HITS, NOT ON TARGETS PER WAVE — WHICH IS THE WHOLE ODDITY ───────────────
//
// Four pages say it in the same words, evidently copied from one another, which makes it community
// folklore rather than a Daybreak statement — but it is folklore that four pages and a fifth page's
// arithmetic agree on:
//
//   "*Note: Rain nukes are limited to 4 hits total. Either you can hit the same mobs 3 times, you
//    can hit 2 mobs twice each, or you can hit 4 mobs once each."
//                              — Avalanche, Blizzard, Cascade of Hail, Pogonip
//
// `Torrent of Poison` corroborates it arithmetically without repeating the sentence: its page says
// "At 1620-2160 damage" over a 540 per-wave magnitude, which is 3x540 to 4x540. Three waves times
// four targets would be 6,480.
//
// So a rain on ONE target lands 3 hits (three waves, under the cap) and a rain on a pack lands 4
// (the cap, whichever way the waves distribute). `shared/aoeSpells.ts aeHits` is that arithmetic,
// and it is why this file exports a wave COUNT rather than a damage multiplier: the multiplier
// depends on how many things you are pointing at.
//
// ── WHAT IS DELIBERATELY OUT, AND WHY EACH ONE IS OUT ─────────────────────────────────────────
//
//   Strike of Thunder — reads `AEDuration 7500` like a rain and its page agrees it IS one, and it
//     is still not in this roster, because the page says exactly what the difference is: "This
//     unusual effect is applied like a rain AOE with three waves, however it does not deal direct
//     damage on each wave, rather it applies a DoT for 3 or 4 ticks." Its only effect line is
//     `Decrease Hitpoints by 125 per tick`, so `spellMetricsAt` already totals it as a DoT;
//     multiplying that total by three would invent damage the page denies.
//   Efreeti Fire — `AEDuration 7500`, no wave prose, and its page says "This AE is cast by
//     [[Ixiblat Fer]] and [[Noble Dojorn]]". No class gains it, so it never reaches a player-facing
//     fold; it is named here so the next sweep does not have to re-derive why the client's 25 rows
//     at 7500 are 23 rains.
//   Circle of Force and the Pillar/Column family — targeted AEs that hit up to four creatures and
//     state no waves ("Targeted AoE / Rain Type spell without waves. Hits up to 4 creatures max.").
//     They belong in the AOE tab at four targets and in the DD tab at one hit, which is what
//     `aoeSpells.ts` gives them for free by asking this file for a wave count and getting none.
//   `Ice Storm` — the ticket asked what became of it. It is in NO source: no catalog row, no
//     cached wiki page, and the only cached description that mentions the words is
//     `Wrath of Ap'Sagor` ("Creates a freezing ice storm..."), which is a nine-second-recast
//     targeted AE with no waves. There is nothing missing to restore.
//
// ── THE MEMBERSHIP RULE THIS FILE APPLIES ─────────────────────────────────────────────────────
//
// `RAIN_PAGES` below is the authority, and it is a REGISTRY rather than a runtime derivation for
// one reason: the sentence it is derived from does not ship. `spells.json` carries a page's slots,
// messages and timings and not its `description`, and adding ~400 kB of prose to the bundle to
// re-derive 23 booleans at startup would be the wrong trade. What keeps a registry honest is the
// audit: `tests/rainSpellWaves.test.mts` re-runs the sweep over the COMMITTED wikitext cache and
// fails when the derivation and this list disagree, so a re-scrape that adds, removes or re-words
// a rain goes red here rather than drifting silently. Instrument 1 is still computed at runtime and
// the same test asserts it stays a SUBSET, so the two can never quietly diverge either.

import spellsJson from './spells.json'
import { applySpellCorrections } from './spellCorrections'
import { applySpellRemovals } from './spellRemovals'
import { spellCanonKey } from '../../shared/spellKey'
import type { SpellDbFile, SpellEntry } from '../../shared/types'

/**
 * The scrape as this app is allowed to read it: rows EQ Legends does not have are gone first
 * (the removals seam — a raw-`spells.json` index in front of it is the standing hazard
 * `tests/spellRemovals.test.mts` greps for), and the corrections overlay is applied to what is
 * left so `raw[i]` and `corrected[i]` stay in INDEX LOCKSTEP.
 */
const RAW: readonly SpellEntry[] = applySpellRemovals((spellsJson as SpellDbFile).spells).spells
const CORRECTED: readonly SpellEntry[] = applySpellCorrections(RAW).spells

/** One registry row: the spell, how many waves it delivers, and the page sentence that says so. */
export interface RainPage {
  name: string
  waves: number
  /** The `description` field of the spell's own wiki page, verbatim, trimmed to the wave clause. */
  quote: string
}

/**
 * THE ROSTER. 23 rows, alphabetical, each quoting its own page (see the header for the sweep).
 *
 * The quotes are the evidence bar `spellCorrectionsList.ts` set for a hand-maintained table: a row
 * that cannot cite its page does not belong here, and a reader re-deciding one of these does not
 * have to go and find the sentence again.
 */
export const RAIN_PAGES: readonly RainPage[] = [
  { name: 'Avalanche', waves: 3, quote: 'Calls down a hailstorm from the sky, causing three waves of 125 damage, up to a maximum of 4 targets hit.' },
  { name: 'Blizzard', waves: 3, quote: 'Calls down a hailstorm from the sky, causing three waves of 490 damage, up to a maximum of 4 targets hit.' },
  { name: 'Cascade of Hail', waves: 3, quote: 'Calls down a hailstorm from the sky, causing three waves of 27 damage, up to a maximum of 4 targets hit.' },
  { name: 'Energy Storm', waves: 3, quote: 'Calls down an energy storm that falls in three waves, causing 96 damage to all creatures in the vicinity of your target.' },
  { name: 'Firestorm', waves: 3, quote: 'Calls down a firestorm in three waves. Each wave causes 28 damage to all creatures in the vicinity of your target.' },
  { name: 'Frost Storm', waves: 3, quote: 'Calls down a frost storm that falls in three waves, causing between 250 damage to all creatures in the vicinity of your target.' },
  { name: 'Gale of Poison', waves: 3, quote: 'Creates a rain of poison, causing three waves of 122 damage to everything in a small radius around your target.' },
  { name: 'Icestrike', waves: 3, quote: 'Calls down a cascade of sleet that falls in three waves, causing 16 damage to all creatures in the vicinity of your target for each wave. Has a potential maximum of 48 cold damage.' },
  { name: 'Lava Storm', waves: 3, quote: 'Calls down a storm of lava that falls in three waves, causing 128 damage to all creatures in the vicinity of your target.' },
  { name: 'Lightning Storm', waves: 3, quote: 'Calls down a lightning storm that falls in three waves. Each wave causes up to 75 damage to all creatures in the vicinity of your target.' },
  // The page hedges with a question mark; the client's own AEDuration 7500 on the player's row
  // (id 1665) answers it. Instrument 1 also has it — its cast line says "mana rains down".
  { name: 'Manastorm', waves: 3, quote: 'Creates a storm of mana around you, causing 675 damage (x3 waves?) to several creatures near your target, and draining their mana.' },
  { name: 'Pogonip', waves: 3, quote: 'Calls down a hailstorm from the sky, causing three waves of 62 damage, up to a maximum of 4 targets hit.' },
  { name: 'Poison Storm', waves: 3, quote: 'Creates a rain of poison, causing three waves of 60 damage to everything in a small radius around your target.' },
  { name: 'Rain of Blades', waves: 3, quote: 'Conjures a rain of blades that assaults all creatures in the vicinity of your target, causing three waves of up to 26 damage each.' },
  { name: 'Rain of Fire', waves: 3, quote: 'Conjures a rain of fire that assaults all creatures in the vicinity of your target, causing three waves of of up to 75 damage each.' },
  { name: 'Rain of Lava', waves: 3, quote: 'Conjures a rain of lava that assaults all creatures in the vicinity of your target, causing three waves of up to 172 damage each.' },
  { name: 'Rain of Spikes', waves: 3, quote: 'Conjures a rain of spikes that assaults all creatures in the vicinity of your target, causing three waves of up to 91 damage each.' },
  { name: 'Rain of Swords', waves: 3, quote: 'Conjures a rain of swords that assaults all creatures in the vicinity of your target, causing three waves of up to 324 damage each.' },
  { name: 'Sirocco', waves: 3, quote: 'Conjures a blistering wind that assaults several creatures in the vicinity of your target, causing three waves of between 630 and @1 damage.' },
  { name: 'Tears of Druzzil', waves: 3, quote: 'Tears of searing magic fall in three waves, causing 600 damage to four creatures in the vicinity of your target.' },
  { name: 'Tears of Prexus', waves: 3, quote: 'Tears of searing ice fall around your target, causing three waves of 690 damage to all creatures in the vicinity of your target.' },
  { name: 'Tears of Solusek', waves: 3, quote: 'Tears of searing flame fall around your target, causing three waves of 645 damage to all creatures in the vicinity of your target.' },
  // "1-3 waves" is the same downward hedge the log measures: a wave that connects with nothing
  // prints nothing. The page's own damage range settles the count — 1620 is 3 x 540.
  { name: 'Torrent of Poison', waves: 3, quote: 'Creates a rain of poison, causing 1-3 waves of 540 damage to 1-4 creatures in a small radius around your target.' }
]

/**
 * The wiki phrasing instrument 1 reads: "… as fire rains down from above.", "… as swords rain
 * down from above.", "… as poison rains down on you."
 *
 * Word-anchored at both ends on purpose. Without the leading `\b` it matches the whole `drain`
 * family (`You feel your life force drain away.` — 42 rows, every lifetap in the game).
 */
const RAIN_MESSAGE_RE = /\brains? down\b/i

const saysRain = (s: SpellEntry): boolean =>
  RAIN_MESSAGE_RE.test(`${s.msgCastOnYou ?? ''} ${s.msgCastOnOther ?? ''}`)

/**
 * INSTRUMENT 1, still derived at runtime: the spells whose own cast message says the damage rains
 * down. A strict SUBSET of `RAIN_PAGES` (the audit test asserts it), kept because it is the one
 * signal that costs nothing and would notice a re-scrape rewriting a message.
 */
export const MESSAGE_RAIN_NAMES: readonly string[] = [
  ...new Set(RAW.filter(saysRain).map((s) => s.name))
].sort()

/** Canonical keys (rank tail stripped, lowercased — law 2) to wave count, for both spellings. */
const RAIN_WAVES: ReadonlyMap<string, number> = (() => {
  const byName = new Map(RAIN_PAGES.map((p) => [p.name, p.waves]))
  const keys = new Map<string, number>()
  const add = (name: string, waves: number): void => {
    keys.set(spellCanonKey(name), waves)
  }
  for (const p of RAIN_PAGES) add(p.name, p.waves)
  // BOTH SPELLINGS, for the reason charmModel.ts states over the same import: a name is a join
  // key, the corrections overlay can rename a row (`Solon's Bravura` -> `Solon's Bewitching
  // Bravura`), and the parser only ever sees the LOG's spelling. Nothing in today's rain family
  // is corrected — this is the invariant kept, not a fix for an observed miss.
  RAW.forEach((s, i) => {
    const waves = byName.get(s.name)
    if (waves === undefined) return
    add(CORRECTED[i]?.name ?? s.name, waves)
  })
  return keys
})()

/** Display names of the roster, sorted — the audit test's subject. */
export const RAIN_SPELL_NAMES: readonly string[] = RAIN_PAGES.map((p) => p.name).sort()

/**
 * HOW MANY WAVES ONE CAST OF THIS SPELL DELIVERS, or 1 for everything that is not a rain.
 *
 * One rather than undefined because every caller multiplies by it, and "not a rain" and "a rain
 * that lands once" are the same arithmetic — the distinction that matters is `isRainSpell`, which
 * is what the proc gate asks.
 *
 * Rank-blind (`spellCanonKey`), because a damage line prints the rank-less name while the cast
 * line may carry the numeral — the same boundary rule every other name join in this engine uses.
 */
export function rainWaves(spell: string): number {
  return RAIN_WAVES.get(spellCanonKey(spell)) ?? 1
}

/** True when a spell delivers its damage in WAVES from one cast. */
export function isRainSpell(spell: string): boolean {
  return RAIN_WAVES.has(spellCanonKey(spell))
}
