// zonePorts.ts — EVERY WAY A PORT LANDS YOU IN A ZONE, derived from the two committed corpora.
//
// The other half of the owner's ask (kaltinril 2026-09-11: *"show the closest druid, wizard, boat,
// or item port"*). `shared/zoneTravel.ts` answers what the MAP says you can walk or sail to; this
// answers which zones a PORT reaches, and the surface joins the two.
//
// ── THREE WITNESSES, ALL ALREADY HERE ─────────────────────────────────────────────────────────
//
//   DRUID AND WIZARD SPELLS. `spells.json` states the destination in the effect line itself -
//   `Teleport to 478,1427,-48 in commons` - and the class and level in `classes`
//   (`* Druid - Level 29`). 152 port effects in the corpus (see DESTINATION); the ones that matter are the
//   player-castable ones.
//
//   ITEM PORTS, which the owner named specifically ("the cazic thule potion port"). An item's
//   CLICK effect is a spell by name - `10 dose potion of the bone field` clicks `Field of Bone
//   Port` - so the item table joins straight onto the spell table above and needs no rule of its
//   own. This is the same join `GearRow.effects` already makes for every other click.
//
//   THE BOATS ARE NOT HERE. They are stated by the map files and belong to `zoneTravel.ts`, which
//   is the honest split: a boat is a seam you walk onto, not a spell anybody casts.
//
// ── WHAT IS DELIBERATELY EXCLUDED ─────────────────────────────────────────────────────────────
//
// NPC-ONLY SPELLS. `BurningTouch2` teleports to `burningwood` and its class line reads "This spell
// is cast by NPCs only" - it is a mob's ability, not travel, and offering it would be a lie about
// what the player can do.
//
// EVACUATES AND GATES THAT NAME NO ZONE. A spell whose effect states no destination states no
// destination (law 1); `Gate` sends you to your bind point, which is a fact about the player and
// not about any zone, so no row here can carry it.
//
// Derived ONCE and memoized, the `levelUnlocks.ts` arrangement: the corpora are committed and
// cannot change while the app runs, so there is no invalidation to get wrong.

import spellsJson from './data/spells.json'
import { applySpellRemovals } from './data/spellRemovals'
import itemsJson from './data/items.json'
import { resolveZone, type PortVia, type ZonePort } from '../shared/zoneTravel'
// The scrape's own row type, rather than a local restatement of it: this module reads four of its
// fields and a private interface would be a second place to keep them right.
import type { SpellEntry } from '../shared/buffTypes'
import type { SpellResistTable } from '../shared/resistTypes'
import { spellCanonKey } from '../shared/spellKey'
import type { ZoneShort } from '../shared/maps'

/**
 * `Teleport to 478,1427,-48 in commons` and `Teleport to in Cazic Thule` — coords optional — and
 * the three other ways the wiki states a zone port (owner report 2026-09-12: The Feerrott showed no
 * druid port, while the game offers Ring of Feerrott). Census of the corpus: 50 `Teleport to`,
 * 42 `Teleport group to` (every druid ring and circle), 34 `Translocate to`, 15 `Evacuate to`,
 * 11 `Evacuate group to`. All five land you in a named zone; only the first was being read. The
 * in-zone evacs (`Teleports your group to a safe location`) name no zone and stay out.
 *
 * THE TRAILING PERIOD IS OPTIONAL because the corpus is inconsistent about it: `Alter Plane:
 * Hate` states `in Plane of Hate.` and its twin `Alter Plane: Sky` states `in Plane of Air`
 * (owner report 2026-09-23: the Plane of Hate showed no port, while a level-46 wizard has one).
 */
const DESTINATION = /^(?:Teleport|Translocate|Evacuate)(?: group)? to (?:[-0-9., ]+ )?in (.+?)\.?$/i

/** `* Druid - Level 29` — the only two classes that carry travel, and the level it opens at. */
const CASTER = /\b(Druid|Wizard)\b[^0-9]*?Level\s*(\d+)/i

/** A mob's ability is not travel. Measured: the corpus states this verbatim on the NPC rows. */
const NPC_ONLY = /cast by NPCs only/i

/** The destination a teleport effect states, folded onto the catalog, or null. */
function destinationOf(spell: SpellEntry): { zone: ZoneShort; zoneName: string } | null {
  for (const effect of spell.effects ?? []) {
    const stated = DESTINATION.exec(effect)
    if (stated === null) continue
    // The corpus spells destinations both ways - the stem `commons` and the display name
    // `Cazic Thule` - and `resolveZone` is the one door that takes either.
    const entry = resolveZone(stated[1].trim())
    if (entry !== null) return { zone: entry.short, zoneName: entry.name }
  }
  return null
}

/**
 * Every spell row the corpus holds, THROUGH THE REMOVALS SEAM.
 *
 * A removal states that no player in EQ Legends can learn the spell, and this module's whole
 * output is a list of casts to offer the player - so it is squarely what the seam governs. The
 * exemptions beside it (`effectIndex`, `wornFocusIndex`) are the opposite case and say so: they
 * DESCRIBE an item's effect line rather than offering anybody a cast. `tests/spellRemovals.test.mts`
 * is the guard that caught this the first time it was written without the seam.
 */
function spellRows(): SpellEntry[] {
  const file = spellsJson as unknown as { spells?: SpellEntry[] }
  return applySpellRemovals(file.spells ?? []).spells
}

/** The castable ports, keyed by spell name so the item join below can reach them. */
function castablePorts(): Map<string, ZonePort> {
  const out = new Map<string, ZonePort>()
  for (const spell of spellRows()) {
    const name = spell.name
    if (name === undefined || NPC_ONLY.test(spell.classes ?? '')) continue
    const where = destinationOf(spell)
    if (where === null) continue
    const caster = CASTER.exec(spell.classes ?? '')
    const group = /group/i.test(spell.targetType ?? '')
    if (caster === null) {
      // A destination with no player class line is the ITEM half's spell: kept under its name so
      // the item table can find it, and never offered as something anybody can cast.
      out.set(name.toLowerCase(), { ...where, via: 'item', spell: name, group })
      continue
    }
    const via: PortVia = caster[1].toLowerCase() === 'druid' ? 'druid' : 'wizard'
    out.set(name.toLowerCase(), { ...where, via, spell: name, level: Number(caster[2]), group })
  }
  return out
}

interface RawItemEffect {
  kind?: string
  name?: string
}

/**
 * ITEM PORTS: every item whose CLICK effect is one of the spells above.
 *
 * The item corpus is the witness for WHICH item, the spell corpus for WHERE IT GOES, and neither
 * has to know about the other — the click's name is the join. An item clicking a spell nothing
 * states a destination for contributes nothing, which is the ordinary case for the hundreds of
 * other clicks in the corpus.
 */
function itemPorts(castable: ReadonlyMap<string, ZonePort>): ZonePort[] {
  const out: ZonePort[] = []
  const seen = new Set<string>()
  const items = (
    itemsJson as unknown as {
      items: Record<string, { page?: string; stats?: { effects?: RawItemEffect[] } }>
    }
  ).items
  for (const [key, entry] of Object.entries(items)) {
    for (const effect of entry.stats?.effects ?? []) {
      if (effect.kind !== 'click' || effect.name === undefined) continue
      const port = castable.get(effect.name.toLowerCase())
      if (port === undefined) continue
      // One row per (item, destination): the dose variants of a potion are different items and the
      // reader wants the one he owns named, but the same item twice is noise.
      const dedupe = `${key}|${port.zone}`
      if (seen.has(dedupe)) continue
      seen.add(dedupe)
      // The PAGE TITLE, not the corpus key: the key is lowercased for joining and the reader
      // wants the item's own name, which is also what `KnownItemTooltip` looks itself up by.
      out.push({ ...port, via: 'item', spell: effect.name, item: entry.page ?? key, level: undefined })
    }
  }
  return out
}

let CACHE: ZonePort[] | null = null

/**
 * EVERY PORT THE TWO CORPORA STATE, computed once.
 *
 * The `item` rows of `castablePorts` are dropped from the result: a port spell with no player
 * class line is only reachable through the item that clicks it, and `itemPorts` has already
 * emitted a row per such item. Keeping the bare spell too would offer the reader a cast he cannot
 * make.
 */
export function zonePorts(): ZonePort[] {
  if (CACHE !== null) return CACHE
  const castable = castablePorts()
  const out: ZonePort[] = []
  for (const port of castable.values()) if (port.via !== 'item') out.push(port)
  for (const port of itemPorts(castable)) out.push(port)
  CACHE = out
  return out
}

/**
 * ONLY WHAT THIS CLIENT CAN CAST (owner ruling 2026-09-12: "we don't want things that do not
 * relate to EQL"). The wiki keeps a classic-EverQuest page beside the Legends page for a spell
 * Legends renamed - `Cazic Gate` 24 beside `Cazic Temple Gate` 23, `Translocate: Cazic` beside
 * `Translocate: Cazic Temple`, both 44 - and the table read off the wiki listed both, so the
 * wizard chip to Cazic-Thule read six levels for three spells. The client's own spell file is the
 * authority on what exists: with the table loaded, a port whose spell it does not carry is not
 * offered. With no table (no install on this machine) nothing is dropped, because nothing can be
 * checked. The key is `spellCanonKey`, the same fold the icon lookup uses.
 *
 * AN ITEM PORT PASSES ON THE ITEM, NOT ON THE SPELL'S NAME. The wiki's item pages name a click by
 * the classic spell (Crazy Cleric Greaves: "Ring of Misty") while the client calls the spell
 * "Ring of Misty Thicket"; every one of the 16 item ports failed the name check on the owner's
 * install, and the items are real. What an item port claims is that clicking the item lands you
 * somewhere, which is true of the item whatever the wiki called its spell.
 */
export function portsInClient(ports: readonly ZonePort[], table: SpellResistTable | null): ZonePort[] {
  if (table === null) return [...ports]
  return ports.filter((p) => p.via === 'item' || table[spellCanonKey(p.spell)] !== undefined)
}

/** The ports that land in one zone, cheapest caster level first, items last. */
export function portsTo(zone: ZoneShort): ZonePort[] {
  return zonePorts()
    .filter((p) => p.zone === zone)
    .sort((a, b) => (a.level ?? 99) - (b.level ?? 99))
}
