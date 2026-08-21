// zones.ts — the ONE shared zone-knowledge artifact (map viewer wave 1B, docs/plans/map-viewer.md §5).
//
// Two independent naming authorities have to be joined here and neither can be computed from the
// other:
//
//   1. The LOG says a long name: `You have entered The Eastern Plains of Karana.`
//   2. The MAP FILES on disk are named by SHORT stem: `<eqRoot>\maps\eastkarana.txt`.
//   3. The MOB CATALOG (`renderer/src/data/eqlegends/mobs.json`, scraped from the wiki) uses a
//      THIRD spelling again: `Eastern Plains of Karana`, `Eastern Karana`, `East Karana` — all
//      three, in different rows, for one place.
//
// MEASURED (map-viewer.md §5.1, re-derived here 2026-08-03 against the live 86.6 MB log): naive
// normalization — lowercase, strip non-letters — resolves **7 of the 51** distinct zone names the
// log has printed. The misses are not near-misses: `The Plane of Sky` -> `airplane`,
// `Nagafen's Lair` -> `soldungb`, `North Freeport` -> `freportn`. THERE IS NO ALGORITHM HERE.
// So the table is hand-authored, committed, and tested.
//
// PROVENANCE OF EVERY ROW (what "verified" means below):
//   - `short` was checked to exist as `<stem>.txt` in the real map corpus — `<eqRoot>\maps`
//     (192 files / 133 stems) and `<eqRoot>\maps\brewall` (1,708 files / 580 stems). Rows whose
//     stem exists ONLY in the brewall pack are marked `// brewall only` — they still render (the
//     viewer merges per-layer across packs, §6.3), they just aren't in the game's own set.
//   - `name` for the 51 observed zones is the log's own spelling, verbatim. For the rest it is
//     seeded from eqlwiki.com/Zone_short_names (a Live-EQ table: it omits every EQL-new zone and
//     spells several zones the Live way) and corroborated against the catalog's zone strings.
//     A name EQL never prints is inert — `zoneShortName` just never sees it — so an
//     unconfirmed-but-plausible row costs nothing and a WRONG one costs a wrong map. When in
//     doubt the row was left OUT (see the TODOs at the bottom).
//   - `mobCatalogNames` was verified row by row by intersecting the mobs the log recorded SLAIN
//     inside that zone against the catalog rows carrying the candidate spelling. Evidence is
//     quoted beside each one. Nothing went in on a hunch.
//
// DELIBERATELY NOT IN THE TABLE: ambiguous long names. The catalog says `Freeport`, `Kaladim`,
// `Neriak`, `Qeynos` — each of which is 2-3 different map files. Resolving them would be a
// guess, so they resolve to `null` and the viewer shows its zone picker (world-model law 1).
//
// SINCE 2026-08-04 the table carries a THIRD kind of knowledge: `era`, the expansion each zone
// shipped in. It is here rather than on an item because no item in the scraped corpus states an
// era, while the wiki documents Kunark and Velious wholesale — so the only way to know that a
// Primal Velium Warsword is unreachable in EQ Legends today is to know that Sleeper's Tomb is a
// Velious zone. Same rules as every other column: hand-authored, per row, `undefined` when there
// is no honest claim to make. `src/shared/planner/era.ts` is the only consumer.
//
// This module is PURE: no Node, no Electron, no renderer. Both main and the renderer import it.

import type { ZoneShort } from './maps'

/**
 * Which EverQuest expansion a zone came from. THE ONLY PLACE ERA IS KNOWN.
 *
 * WHY IT LIVES HERE and not on an item: nothing in the scraped item corpus carries an era. The
 * wiki documents Kunark and Velious content wholesale (Kael Drakkel alone is 343 catalog mobs),
 * so a planner that ranked effects by the item DB alone happily proposed ten Primal Velium
 * weapons out of Sleeper's Tomb — content EQ Legends has not opened. Era is therefore derived
 * from ZONE PROVENANCE: where the donor drops is the only evidence there is.
 *
 * Hand-authored per row, like everything else in this table (world-model law 12): the expansion
 * a zone SHIPPED in is a fact about EverQuest's history, not a string rule. `undefined` means
 * "no era claim" — either the zone postdates the three eras (Luclin's Bazaar/Nexus, PoP's
 * Knowledge/Guild Lobby) or it is EQL-new content (New Sebilis Expedition) with no historic
 * expansion to point at. An unannotated zone reads as UNKNOWN downstream, never as out-of-era.
 *
 * Consumed by `src/shared/planner/era.ts`; nothing else in the app reads it yet.
 */
export type ZoneEra = 'classic' | 'kunark' | 'velious'

/** One zone: what the log calls it, what its map file is called, and who else spells it how. */
export interface ZoneEntry {
  /** The map-file stem, lowercase. Exists as `<pack>\<short>.txt` for at least one pack. */
  short: ZoneShort
  /** Canonical display name — the EQL long name, as the log spells it where we have seen it. */
  name: string
  /**
   * Other long names that resolve here: the Live-EQ spelling, historic names, the catalog's.
   * Matched after the same `zoneKey` fold as `name`, so an alias that folds onto `name` is
   * redundant and is NOT listed (`Neriak Commons` folds onto `Neriak - Commons` already).
   */
  aliases?: string[]
  /**
   * Mob-catalog zone spellings that the `zoneKey` fold CANNOT reach from this zone's own name —
   * i.e. where the two sources use a different NAME, not a different spelling. See
   * `catalogZonesFor`. Present only where the mapping was verified against real data.
   */
  mobCatalogNames?: string[]
  /**
   * The expansion this zone shipped in. Absent = deliberately no claim (see `ZoneEra`); it is
   * NEVER a shorthand for "classic".
   */
  era?: ZoneEra
}

// ---- the fold ------------------------------------------------------------------------------
//
// THIS IS A MIRROR, ON PURPOSE. `src/renderer/src/features/mobs/mobZone.ts` shipped the identical
// fold first (Task #64) for the "what lives in this zone" join, and its header carries the full
// evidence for each rule. The two folds MUST NOT be able to disagree — a zone that resolves to a
// map here but to zero mobs there (or vice versa) would be a silent, invisible inconsistency —
// so the rules are duplicated verbatim and `tests/zones.test.mts` asserts parity against the real
// mobZone implementation on real log zone names.
//
// It is a mirror rather than an import because the dependency direction only works one way:
// `src/shared` may not import from `src/renderer`, and the renderer's copy is deliberately
// standalone (mobZone.ts:20-24). If a rule ever changes, change BOTH files and the parity test
// will catch it if you don't. The tier strips ultimately trace to `zoneTier()` in
// `src/main/log/parseWorld.ts`, which stays where it is (map-viewer.md §5.3 blocker 1).

/** ` - Solo` / ` - Group 2` and everything after it — instance selection, never part of a name. */
const SOLO_GROUP_RE = /\s*-\s*(Solo|Group)\b.*$/i
/** A trailing tier parenthetical, with or without the instance ordinal: ` 4 (Refined)`. */
const TIER_ORDINAL_RE = /\s+\d+\s*\([^)]*\)\s*$/
/** A bare trailing parenthetical: ` (Awakened)`, and the catalog's ` (Pre-Revamp)` / ` (37)`. */
const TIER_PAREN_RE = /\s+\([^)]*\)\s*$/
/** Runs of whitespace and hyphens, collapsed to one space. */
const SEPARATORS_RE = /[\s-]+/g
/** The one leading article EQ zone names use. */
const LEADING_ARTICLE_RE = /^the /

/**
 * Canonical key for a zone name, from ANY of the three sources. Case-insensitive, instance noise
 * stripped, leading article folded, separators normalized. Never throws; a nullish/blank name
 * folds to `''`.
 */
export function zoneKey(zone: string | undefined | null): string {
  return (zone ?? '')
    .replace(SOLO_GROUP_RE, '')
    .replace(TIER_ORDINAL_RE, '')
    .replace(TIER_PAREN_RE, '')
    .toLowerCase()
    .replace(SEPARATORS_RE, ' ')
    .trim()
    .replace(LEADING_ARTICLE_RE, '')
    .trim()
}

// ---- the table -----------------------------------------------------------------------------

/**
 * Long zone name -> map stem. HAND-AUTHORED and COMMITTED (map-viewer.md §5.2).
 *
 * Section 1 is the 51 distinct zone names the live log has actually printed; every one of them
 * resolves except the EQL-new tutorial (see the TODO below). Sections 2-4 extend toward the map
 * corpus with the classic / Kunark / Velious zones an EQL log could plausibly print next.
 */
export const ZONES: readonly ZoneEntry[] = [
  // --- 1. OBSERVED IN THE LIVE LOG (50 of the 51 canonical names resolve) ---
  // Every zone here is `era: 'classic'` except the EQL-new expedition, which claims no era: these
  // are the launch-1999 world (Antonica / Faydwer / Odus) plus the three original planes. Paineel,
  // The Hole, The Warrens and Stonebrunt Mountains arrived in the Erudite-heretic patch late in
  // 1999, still months before The Ruins of Kunark, so they are classic too.
  { short: 'befallen', name: 'Befallen', era: 'classic' },
  { short: 'blackburrow', name: 'Blackburrow', era: 'classic' }, // brewall only
  { short: 'butcher', name: 'Butcherblock Mountains', mobCatalogNames: ['BBM'], era: 'classic' },
  { short: 'ecommons', name: 'East Commonlands', mobCatalogNames: ['EC'], era: 'classic' },
  { short: 'freporte', name: 'East Freeport', mobCatalogNames: ['EFP'], era: 'classic' },
  { short: 'erudsxing', name: "Erud's Crossing", era: 'classic' },
  { short: 'erudnext', name: 'Erudin', era: 'classic' },
  { short: 'erudnint', name: 'Erudin Palace', era: 'classic' },
  { short: 'everfrost', name: 'Everfrost Peaks', era: 'classic' },
  { short: 'grobb', name: 'Grobb', era: 'classic' },
  { short: 'highpass', name: 'Highpass Hold', era: 'classic' },
  { short: 'innothule', name: 'Innothule Swamp', era: 'classic' },
  { short: 'kithicor', name: 'Kithicor Forest', era: 'classic' },
  { short: 'soldungb', name: "Nagafen's Lair", era: 'classic' }, // brewall only
  { short: 'najena', name: 'Najena', era: 'classic' },
  { short: 'nektulos', name: 'Nektulos Forest', era: 'classic' },
  { short: 'neriakb', name: 'Neriak - Commons', era: 'classic' },
  { short: 'neriaka', name: 'Neriak - Foreign Quarter', era: 'classic' },
  // EQL-new; DEFAULT SET ONLY. No era: it is not a 1999-2000 expansion zone, it is content EQ
  // Legends invented — and the player has walked it, so calling it out-of-era would be a lie.
  { short: 'newsebexp', name: 'New Sebilis Expedition' },
  { short: 'freportn', name: 'North Freeport', era: 'classic' },
  // KALADIM'S STEMS RUN THE OTHER WAY, AND BOTH SOURCES SAY SO (JOS-415, reported 8AX84S:
  // "When I zone into or manually select South Kaladim the North Kaladim map loads and visa
  // versa"). The `a`/`b` suffixes read like `north`/`south` and the seed table was taken on that
  // reading; the corpus refutes it twice over. (1) The game's OWN maps carry their zone lines as
  // labels: `kaladima_1.txt` holds `to_Butcherblock_Mountains` + two `to_North_Kaladim`, so
  // kaladima is the half that touches Butcherblock and neighbours North — i.e. SOUTH Kaladim;
  // `kaladimb_1.txt` holds two `to_South_Kaladim` and no outside exit at all, i.e. NORTH.
  // (2) The NPC rosters agree independently: brewall's `kaladima_1` labels King Kazon
  // Stormhammer, Tumpy Irontoe, Canloe Nusback, Beno Targnarle, Guard Dinler — every one of
  // which the mob catalog files under `South Kaladim` (51 rows); brewall's `kaladimb_1` labels
  // Busey Nehart, Tempia Lauley, Gunlok Jure, Priestess Ghalea, the Everhot and Norkhitter
  // families — all catalog `North Kaladim` (54 rows). Pinned by tests/zones.test.mts.
  { short: 'kaladimb', name: 'North Kaladim', era: 'classic' },
  { short: 'qeynos2', name: 'North Qeynos', era: 'classic' },
  { short: 'oggok', name: 'Oggok', era: 'classic' },
  { short: 'paineel', name: 'Paineel', era: 'classic' },
  // Two log names, ONE place: `Permafrost Keep` is the open zone (ice goblins, King Thex`Ka IV),
  // `The Permafrost Caverns - Solo N` its instance (ice giants, Lady Vox) — and entering the Keep
  // logs the achievement "The Permafrost Caverns Traveler". eqlwiki's table says
  // `Permafrost Keep | permafrost`; brewall's permafrost_1 labels carry both Lady Vox and the ice
  // goblins. Catalog spells the whole zone `Permafrost` (36 rows incl. Lady Vox, King Thex`Ka IV).
  {
    short: 'permafrost',
    name: 'Permafrost Keep',
    aliases: ['The Permafrost Caverns'],
    mobCatalogNames: ['Permafrost'],
    era: 'classic'
  },
  { short: 'qeytoqrg', name: 'Qeynos Hills', era: 'classic' },
  // The other half of the JOS-415 swap — evidence beside `North Kaladim` above.
  { short: 'kaladima', name: 'South Kaladim', era: 'classic' },
  { short: 'qeynos', name: 'South Qeynos', era: 'classic' },
  // Guk is TWO zones and the log names them separately (see the header note under DEVIATIONS in
  // tests). Upper: the log's `The City of Guk` killed froglok ton/gaz knights + froglok sentries;
  // catalog `Upper Guk` (51 rows) carries exactly those names, and brewall's guktop_1 labels are
  // froglok. Lower: `The Ruins of Old Guk` killed zol/wan/dar ghoul knights + a frenzied ghoul;
  // catalog `Lower Guk` (63 rows) and gukbottom_1's labels match.
  {
    short: 'guktop',
    name: 'The City of Guk',
    aliases: ['Upper Guk'],
    mobCatalogNames: ['Upper Guk'],
    era: 'classic'
  },
  {
    short: 'eastkarana',
    name: 'The Eastern Plains of Karana',
    aliases: ['East Karana', 'Eastern Karana'],
    // Catalog uses all three; only `Eastern Plains of Karana` (79 rows) folds onto the log name.
    mobCatalogNames: ['East Karana', 'Eastern Karana', 'Eastern Karana (37)'],
    era: 'classic'
  },
  { short: 'feerrott', name: 'The Feerrott', era: 'classic' },
  // eqlwiki's zone table: `Infected Paw | paw`. The log's Splitpaw kills (a Tesch Mas / Rosch Mas /
  // Lteth Mal Gnoll) are catalog `Splitpaw Lair` rows verbatim; brewall paw_1 labels `Splitpaw_Jail`.
  {
    short: 'paw',
    name: 'The Lair of the Splitpaw',
    aliases: ['Splitpaw Lair', 'Infected Paw'],
    mobCatalogNames: ['Splitpaw Lair', 'Infected Paw'],
    era: 'classic'
  },
  { short: 'lavastorm', name: 'The Lavastorm Mountains', era: 'classic' },
  {
    short: 'nro',
    name: 'The Northern Desert of Ro',
    aliases: ['North Ro'],
    mobCatalogNames: ['North Ro'],
    era: 'classic'
  },
  {
    short: 'northkarana',
    name: 'The Northern Plains of Karana',
    aliases: ['North Karana', 'Northern Karana'],
    // `Northern Plains of Karana` is 4 rows; `Northern Karana` alone is 54 more of the same zone.
    mobCatalogNames: ['North Karana', 'Northern Karana', 'Northern Karana (35)'],
    era: 'classic'
  },
  { short: 'oasis', name: 'The Oasis of Marr', era: 'classic' },
  { short: 'oot', name: 'The Ocean of Tears', era: 'classic' },
  { short: 'fearplane', name: 'The Plane of Fear', era: 'classic' },
  { short: 'hateplane', name: 'The Plane of Hate', era: 'classic' }, // brewall only (hateplaneb is the revamp)
  { short: 'airplane', name: 'The Plane of Sky', era: 'classic' },
  { short: 'rathemtn', name: 'The Rathe Mountains', aliases: ['Mountains of Rathe'], era: 'classic' },
  {
    short: 'gukbottom',
    name: 'The Ruins of Old Guk',
    aliases: ['Lower Guk'],
    mobCatalogNames: ['Lower Guk'],
    era: 'classic'
  },
  // The log's Old Paineel kills (a rock golem, an elemental warrior, a ratman warrior, Slizik the
  // Mighty) are catalog `The Hole` rows verbatim; brewall hole_1 labels Elemental_Striker + a
  // ratman_inhabitant. eqlwiki: `The Ruins of Old Paineel | hole`.
  {
    short: 'hole',
    name: 'The Ruins of Old Paineel',
    aliases: ['The Hole'],
    mobCatalogNames: ['The Hole'],
    era: 'classic'
  }, // brewall only
  {
    short: 'sro',
    name: 'The Southern Desert of Ro',
    aliases: ['South Ro'],
    mobCatalogNames: ['South Ro', 'Southern Ro'],
    era: 'classic'
  },
  {
    short: 'southkarana',
    name: 'The Southern Plains of Karana',
    aliases: ['South Karana', 'Southern Karana'],
    // `Southern Plains of Karana` is ONE row; `Southern Karana` is 53 more of the same zone.
    mobCatalogNames: ['South Karana', 'Southern Karana'],
    era: 'classic'
  },
  { short: 'soltemple', name: 'The Temple of Solusek Ro', era: 'classic' },
  { short: 'tox', name: 'Toxxulia Forest', era: 'classic' }, // classic stem; `toxxulia` is the Live revamp
  { short: 'commons', name: 'West Commonlands', mobCatalogNames: ['WC'], era: 'classic' },
  { short: 'freportw', name: 'West Freeport', mobCatalogNames: ['WFP'], era: 'classic' },

  // --- 2. CLASSIC, not yet observed. Names from eqlwiki's table, corroborated by the catalog. ---
  // Four rows in this section carry NO era on purpose — they are not classic zones at all, they
  // are Live-EQ hub zones that came with Luclin (Bazaar, Nexus) and Planes of Power (Guild Lobby,
  // and the Barter Hall which is later still). They sit in the table because the map corpus has
  // their stems, not because EQL can reach them; claiming an era for them would invent history.
  { short: 'akanon', name: "Ak'Anon", era: 'classic' },
  { short: 'arena', name: 'The Arena', era: 'classic' },
  { short: 'barter', name: 'The Barter Hall' },
  { short: 'bazaar', name: 'The Bazaar' },
  { short: 'cauldron', name: "Dagnor's Cauldron", era: 'classic' },
  { short: 'cazicthule', name: 'Cazic-Thule', era: 'classic' },
  { short: 'crushbone', name: 'Clan Crushbone', aliases: ['Crushbone'], era: 'classic' },
  { short: 'felwithea', name: 'North Felwithe', aliases: ['Northern Felwithe'], era: 'classic' },
  { short: 'felwitheb', name: 'South Felwithe', aliases: ['Southern Felwithe'], era: 'classic' },
  { short: 'gfaydark', name: 'The Greater Faydark', era: 'classic' },
  { short: 'guildlobby', name: 'The Guild Lobby' },
  { short: 'halas', name: 'Halas', era: 'classic' },
  { short: 'highkeep', name: 'High Keep', aliases: ['HighKeep'], era: 'classic' },
  { short: 'kedge', name: 'Kedge Keep', era: 'classic' },
  { short: 'kerraridge', name: 'Kerra Isle', aliases: ['Kerra Island'], era: 'classic' },
  { short: 'lakerathe', name: 'Lake Rathetear', aliases: ['Lake Rathe'], era: 'classic' },
  { short: 'lfaydark', name: 'The Lesser Faydark', era: 'classic' },
  { short: 'beholder', name: 'Gorge of King Xorbb', aliases: ["Beholder's Maze"], era: 'classic' },
  { short: 'misty', name: 'Misty Thicket', era: 'classic' }, // classic stem; `mistythicket` is the Live revamp
  // The in-game zone line says `The Castle of Mistmoore`; wiki and catalog say `Mistmoore Castle`.
  {
    short: 'mistmoore',
    name: 'Castle Mistmoore',
    aliases: ['Mistmoore Castle', 'The Castle of Mistmoore'],
    era: 'classic'
  },
  { short: 'neriakc', name: 'Neriak - Third Gate', era: 'classic' },
  { short: 'neriakd', name: 'Neriak Palace', era: 'classic' }, // brewall only
  { short: 'nexus', name: 'The Nexus' },
  { short: 'poknowledge', name: 'Plane of Knowledge' },
  { short: 'qcat', name: 'Qeynos Catacombs', aliases: ['Qeynos Aqueducts'], era: 'classic' },
  { short: 'qrg', name: 'Surefall Glade', era: 'classic' },
  { short: 'rivervale', name: 'Rivervale', era: 'classic' },
  // Catalog spells this place three ways: `RunnyEye Citadel` (36 rows) and `Runnyeye Citadel` (4)
  // both fold onto the alias; a bare `Runnyeye` (6 rows, incl. the goblin warlord line) reaches
  // neither the name nor the alias, so it is stated as knowledge rather than left to a matcher.
  {
    short: 'runnyeye',
    name: 'Clan RunnyEye',
    aliases: ['Runnyeye Citadel'],
    mobCatalogNames: ['Runnyeye'],
    era: 'classic'
  }, // brewall only
  { short: 'soldunga', name: "Solusek's Eye", era: 'classic' }, // brewall only
  { short: 'steamfont', name: 'Steamfont Mountains', era: 'classic' }, // classic stem; `steamfontmts` is the revamp
  // Stonebrunt + The Warrens are NOT original-1999 EQ: both arrived in the January 2001
  // patch (Velious era), and the owner confirmed their loot reads out-of-era in EQL
  // (2026-08-04 — Stonebrunt drops surfacing in the planner were the report). Bucketed
  // 'velious' as "post-classic"; re-examine if EQL ever gates them separately.
  { short: 'stonebrunt', name: 'Stonebrunt Mountains', era: 'velious' },
  { short: 'unrest', name: 'The Estate of Unrest', aliases: ['Unrest'], era: 'classic' }, // brewall only
  { short: 'warrens', name: 'The Warrens', era: 'velious' }, // brewall only; Jan-2001 patch, see stonebrunt
  {
    short: 'qey2hh1',
    name: 'The Western Plains of Karana',
    aliases: ['West Karana', 'Western Karana'],
    era: 'classic'
  },

  // --- 3. KUNARK. Stems are brewall-only except where marked; names corroborated by the catalog. ---
  // The whole section is `era: 'kunark'` — this IS the Kunark landmass (plus its two Iksar
  // outposts), one expansion, April 2000. The catalog documents it wholesale (1,464 mob-zone
  // links across these rows) even though EQ Legends has not opened it: exactly why the field
  // exists.
  { short: 'burningwood', name: 'The Burning Wood', aliases: ['Burning Woods'], era: 'kunark' }, // in default set
  { short: 'cabeast', name: 'Cabilis East', aliases: ['East Cabilis'], era: 'kunark' }, // in default set
  { short: 'cabwest', name: 'Cabilis West', aliases: ['West Cabilis'], era: 'kunark' }, // in default set
  { short: 'chardok', name: 'Chardok', era: 'kunark' },
  { short: 'charasis', name: 'Howling Stones', era: 'kunark' },
  { short: 'citymist', name: 'City of Mist', era: 'kunark' },
  // Catalog says `Crypt of Dalnir` (26 rows) and a bare `Dalnir` (3 rows, the Diseased Wolf line);
  // the short form reaches the zone's own name through no fold, so it is stated here.
  { short: 'dalnir', name: 'Crypt of Dalnir', mobCatalogNames: ['Dalnir'], era: 'kunark' },
  { short: 'dreadlands', name: 'The Dreadlands', era: 'kunark' }, // in default set
  { short: 'droga', name: 'Temple of Droga', era: 'kunark' },
  { short: 'emeraldjungle', name: 'The Emerald Jungle', era: 'kunark' }, // in default set
  { short: 'fieldofbone', name: 'The Field of Bone', era: 'kunark' }, // in default set
  { short: 'firiona', name: 'Firiona Vie', era: 'kunark' }, // in default set
  { short: 'frontiermtns', name: 'Frontier Mountains', era: 'kunark' },
  { short: 'kaesora', name: 'Kaesora', era: 'kunark' },
  { short: 'karnor', name: "Karnor's Castle", era: 'kunark' },
  { short: 'kurn', name: "Kurn's Tower", era: 'kunark' },
  // ADDED with the era layer (wave 3E): the one Kunark zone the table had missed, and the single
  // largest catalog gap at 82 mobs — the Goblins/Sarnak lake between Field of Bone and Cabilis.
  // Its stem is eqlwiki's Zone_short_names spelling, seeded like the rest of this section; unlike
  // the 2026-08-03 rows it could NOT be checked against a real maps folder (the authoring machine
  // has no EQ install), so if it is ever wrong the cost is a missing map, never a wrong one.
  { short: 'lakeofillomen', name: 'Lake of Ill Omen', era: 'kunark' },
  { short: 'nurga', name: 'Mines of Nurga', era: 'kunark' },
  { short: 'overthere', name: 'The Overthere', era: 'kunark' }, // in default set
  { short: 'sebilis', name: 'Old Sebilis', era: 'kunark' },
  { short: 'skyfire', name: 'Skyfire Mountains', era: 'kunark' },
  { short: 'swampofnohope', name: 'The Swamp of No Hope', era: 'kunark' }, // in default set
  { short: 'timorous', name: 'Timorous Deep', era: 'kunark' }, // in default set
  { short: 'trakanon', name: "Trakanon's Teeth", era: 'kunark' },
  { short: 'veeshan', name: "Veeshan's Peak", era: 'kunark' },
  { short: 'warslikswood', name: "Warslik's Woods", aliases: ['Warsliks Woods'], era: 'kunark' },

  // --- 4. VELIOUS. Stems are brewall-only except where marked. ---
  // All `era: 'velious'` (December 2000; 1,679 mob-zone links). Sleeper's Tomb is the row that
  // started this: its warders drop the eight Primal Velium weapons the planner was recommending
  // to a level-50 classic character. Plane of Growth and Plane of Mischief are Velious planes,
  // NOT classic ones — only Fear, Hate and Sky are classic.
  { short: 'cobaltscar', name: 'Cobalt Scar', era: 'velious' }, // in default set
  { short: 'crystal', name: 'Crystal Caverns', era: 'velious' },
  { short: 'eastwastes', name: 'Eastern Wastes', era: 'velious' },
  { short: 'frozenshadow', name: 'Tower of Frozen Shadow', era: 'velious' },
  { short: 'greatdivide', name: 'The Great Divide', era: 'velious' }, // in default set
  { short: 'growthplane', name: 'Plane of Growth', era: 'velious' },
  { short: 'iceclad', name: 'Iceclad Ocean', era: 'velious' },
  { short: 'kael', name: 'Kael Drakkel', era: 'velious' }, // in default set
  { short: 'mischiefplane', name: 'Plane of Mischief', era: 'velious' },
  { short: 'necropolis', name: 'Dragon Necropolis', era: 'velious' },
  { short: 'sirens', name: "Siren's Grotto", era: 'velious' },
  { short: 'skyshrine', name: 'Skyshrine', era: 'velious' },
  { short: 'sleeper', name: "Sleeper's Tomb", era: 'velious' },
  { short: 'templeveeshan', name: 'Temple of Veeshan', era: 'velious' },
  { short: 'thurgadina', name: 'Thurgadin', era: 'velious' }, // in default set
  { short: 'thurgadinb', name: 'Icewell Keep', era: 'velious' }, // in default set
  { short: 'velketor', name: "Velketor's Labyrinth", era: 'velious' },
  { short: 'wakening', name: 'The Wakening Land', aliases: ['Wakening Lands'], era: 'velious' },
  { short: 'westwastes', name: 'Western Wastes', era: 'velious' }
]

// TODO(zone table) — candidates deliberately LEFT OUT because they could not be verified:
//   - `EverQuest Legends Tutorial`: the one observed log zone with no stem. It is EQL-new content
//     (NPCs Doug / Dougina / "a rambunctious pet"), NOT Gloomingdeep, so `tutorial` / `tutoriala` /
//     `tutorialb` would all be a guess. Resolves to null -> the viewer's zone picker.
//   - `aviak` (Aviak Village), `erudsxing2` (Marauder's Mire), `nektropos`, `cshome` (Sunset Home):
//     on eqlwiki's table but with NO file in either pack, so nothing to point at.
//   - `oldkaesoraa`: in the default set, no long name in any source. EQL-new or a variant of Kaesora.
//   - The Live-EQ revamp stems the classic rows deliberately shadow — `northro`/`southro`,
//     `commonlands`, `freeporteast`/`freeportwest`/`freeport*`, `kithforest`, `befallenb`,
//     `oceanoftears`, `innothuleb`, `highpasskeep`, `hateplaneb`, `toxxulia`, `mistythicket`,
//     `steamfontmts`. Adding them would collide on `zoneKey` with the classic zone of the same
//     name; if EQL ever ships a revamp, that is a `variants` decision, not an alias.
//   - The Luclin+ stems in the default set (`sharvahl`, `paludal`, `dawnshroud`, `acrylia`,
//     `tenebrous`, `shadowhaven`, `hollowshade`, `echo`, `mesa`, `steppes`, `sunderock`,
//     `toskirakk`, `crystallos`, `discord`, `abysmal`, `ashengate`, `icefall`, `stonehive`,
//     `harbingers`, `hillsofshade`, `crescent`, `alkabormare`, `potranquility`, `guildhall`,
//     `neighborhood`, `oldkaesoraa`): EQ Legends is classic-era, so these names cannot appear in
//     its log. Left out on purpose rather than padded in.
//   - Catalog spellings that are AMBIGUOUS, so no `mobCatalogNames` row claims them: `Freeport`,
//     `Kaladim`, `Neriak`, `Qeynos`, `Felwithe`, `Various`, `Various Zones`,
//     `Most starting zones`, `West Freeport OR East Freeport`.
//   - Catalog spellings that are DIRT, not names, so nothing claims them either (re-measured
//     2026-08-04 across all 192 distinct catalog zone strings; 33 stay unresolved, carrying 86 of
//     the 8,214 mob-zone links between them): wiki table cells whose links ran together
//     (`Everfrost PeaksLake Rathetear`, `DreadlandsEmerald JungleCity of Mist`,
//     `Western Plains of KaranaNorthern Plains of Karana`, `Burning WoodsEmerald Jungle`),
//     multi-zone prose (`Kithicor Forest Misty Thicket`, `Greater Faydark. Lesser Faydark`,
//     `Neriak Commons. Neriak Third Gate`, `various (Qeynos Hills)`, `Various Starter Zones`),
//     hedges (`also in Chardok?`, `West Cabilis?`, `Warsliks?`, `Field of Bone?`), a stray
//     full stop (`Lake of Ill Omen.`) and a city inside a zone (`Kelethin (Greater Faydark)`).
//     Splitting a concatenation on capital letters, or stripping a `?`, would be a matcher
//     inventing a fact the wiki never stated — law 12. They resolve to null and stay unknown.

// ---- lookup --------------------------------------------------------------------------------

/**
 * `zoneKey` -> entry, over `name` AND every alias. Built LAZILY on first lookup, never at module
 * load (the mobSearch.ts posture): a session that never opens the map viewer pays nothing.
 * The table is immutable, so the index lives for the process's lifetime.
 */
let INDEX: Map<string, ZoneEntry> | null = null

function index(): Map<string, ZoneEntry> {
  if (INDEX) return INDEX
  const m = new Map<string, ZoneEntry>()
  for (const entry of ZONES) {
    for (const long of [entry.name, ...(entry.aliases ?? [])]) {
      const key = zoneKey(long)
      // First writer wins. `tests/zones.test.mts` proves there is never a second one, so this is
      // a belt-and-braces guard, not a policy.
      if (key !== '' && !m.has(key)) m.set(key, entry)
    }
  }
  INDEX = m
  return m
}

/**
 * The table row for a RAW zone name — pass `CharacterSnap.zone` unmodified, instance suffix and
 * all; folding is this function's job. `null` when the zone is not in the table.
 */
export function zoneEntryFor(raw: string | undefined | null): ZoneEntry | null {
  const key = zoneKey(raw)
  if (key === '') return null
  return index().get(key) ?? null
}

/**
 * Resolve a zone name to its map-file stem. Accepts a raw long name (`The Plane of Sky 1
 * (Awakened)`) or an alias.
 *
 * Returns `null` when unknown — the caller shows the manual zone picker rather than guessing
 * (world-model law 1: never silently guess), and should log the miss once so the table's gaps
 * turn up in `errors.log` instead of a user complaint (map-viewer.md §5.3).
 */
export function zoneShortName(raw: string | undefined | null): ZoneShort | null {
  return zoneEntryFor(raw)?.short ?? null
}

/**
 * The mob catalog's spellings for a log zone that its own name does NOT fold onto — the
 * knowledge half of the join `mobsInZone` cannot do with a string rule
 * (`renderer/src/features/mobs/mobZone.ts`, "WHAT IT DELIBERATELY DOES NOT DO").
 *
 * Returns `[]` for an unknown zone AND for the common case where the fold already suffices
 * (`Befallen`, `The Feerrott`) — in both cases there is nothing to add. A consumer therefore
 * UNIONS this with its own `zoneKey` match rather than replacing it:
 *
 *     const extra = catalogZonesFor(raw)
 *     rows = catalog.filter((m) => m.zones?.some((z) => zoneKey(z) === key || extra.includes(z)))
 *
 * Comparing with `zoneKey` on both sides is also safe and slightly wider (it folds the catalog's
 * ` (35)` / ` (37)` page-disambiguation suffixes onto their base spelling).
 */
export function catalogZonesFor(raw: string | undefined | null): string[] {
  const names = zoneEntryFor(raw)?.mobCatalogNames
  return names ? [...names] : []
}

/**
 * The OTHER DIRECTION of the same knowledge: a MOB-CATALOG zone spelling -> its map stem.
 *
 * `zoneEntryFor` indexes `name` + `aliases`, which is the right corpus for a name the LOG printed.
 * The catalog is a third naming authority and spells nine zones in ways neither of those reaches
 * (`EC`, `Lower Guk`, `The Hole`, `Dalnir`, …) — exactly the set `mobCatalogNames` already records
 * for the forward direction. Reading them the other way turns "which zone is this mob in?" into
 * "which map do I open", which is what the Maps tab's cross-zone search needs (JOS-135).
 *
 * A SECOND INDEX rather than widening `zoneEntryFor`, because the two questions have different
 * corpora and only one of them should admit catalog spellings: a log line saying `EC` is not
 * something this app has ever seen, and quietly teaching the log-side fold a wiki abbreviation
 * would widen an inlet nothing asked for. MEASURED 2026-08-09 over the committed catalog's 192
 * distinct zone strings: `zoneEntryFor` alone resolves 151, this resolves 160, and no
 * `mobCatalogNames` entry collides with another zone's own name or alias (pinned by
 * tests/zones.test.mts).
 *
 * The 32 that stay `null` are the ones the table deliberately refuses (see the TODO above): the
 * ambiguous city names (`Freeport`, `Qeynos`, `Neriak`, `Kaladim`, `Felwithe`), the placeholders
 * (`Various`), and the wiki table cells whose links ran together. Null means the caller states the
 * zone as the wiki spells it and offers no map, never a nearest guess (world-model law 1).
 */
let CATALOG_INDEX: Map<string, ZoneEntry> | null = null

function catalogIndex(): Map<string, ZoneEntry> {
  if (CATALOG_INDEX) return CATALOG_INDEX
  // Seeded from the log-side index so a name/alias always wins over a catalog spelling; the
  // collision test proves there is never a contest, so this is order-as-documentation.
  const m = new Map(index())
  for (const entry of ZONES) {
    for (const catalogName of entry.mobCatalogNames ?? []) {
      const key = zoneKey(catalogName)
      if (key !== '' && !m.has(key)) m.set(key, entry)
    }
  }
  CATALOG_INDEX = m
  return m
}

export function zoneShortNameFromCatalog(name: string | undefined | null): ZoneShort | null {
  const key = zoneKey(name)
  if (key === '') return null
  return catalogIndex().get(key)?.short ?? null
}
