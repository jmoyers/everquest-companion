// skyMobIslands.ts — WHERE A SKY MOB IS, when the item it drops is somewhere else (JOS-415).
//
// THE DEFECT, reported 5DZGYM (1.4.0), verbatim: "Protector of Sky is listed as Island 7, its
// island 2." It is real, and it is not a typo in any of our data — every input is telling the
// truth and the JOIN is what lies.
//
// The derivation both Sky surfaces share (`questKillTargets` here in the Quests tab, `skyTargets`
// in the Targets tab) attributes to a MOB the islands of the ITEMS that mob is the kill target
// for. That reading is right for eight of the nine bosses because a boss's drops are stated on the
// boss's own island. It is wrong the moment ONE item can come from two places:
//
//   * `Gem of Invigoration` — the Warrior Test of Smash's second item — is stated by the posky
//     scrape as `(7-Trash)`, and its own wiki item page agrees: "Can drop off any trash on island
//     7 (SotS)". So `where: 'Island 7'` is CORRECT about the item.
//   * The mob catalog (`mobs.json`, from the mob page's `known_loot`) lists Gem of Invigoration in
//     Protector of Sky's drops, which is also correct: the eqlwiki page for Protector of Sky
//     carries it. So resolving that item to Protector of Sky is CORRECT about the dropper.
//   * But the eqlwiki page for Protector of Sky opens "Location: 2nd Island", the Rogue Test of
//     Thievery page writes the same item as "(Protector of Sky - Island 2 Boss)", posky's own two
//     PoS rows (Azarack Skin / Azarack Blood) say `Island 2`, and `bosses.json` files the raid
//     target as "Plane of Sky - Island 2". Protector of Sky is on island 2, five ways.
//
// So the app was sending a player to island 7 to kill a mob that lives on island 2, from three
// facts none of which is wrong. Gem of Invigoration drops in BOTH places; the island belongs to
// the mob, and the item's `where` is only the mob's island by coincidence.
//
// WHY AN OVERLAY AND NOT A DATA EDIT. `posky.json` and `mobs.json` are SCRAPES rewritten wholesale
// by `npm run scrape:posky` / `scrape:mobs`, so a hand-edit into either is undone by the next run
// and makes that run's diff unreadable — the standing arrangement `spellCorrections.ts` states for
// the spell DB, applied here. Neither file is wrong anyway: there is nothing in them to correct.
//
// WHY NOT READ `bosses.json` INSTEAD. It does state an island for all eleven Sky raid targets, and
// it agrees with the derivation everywhere it overlaps. But its strings are a DIFFERENT vocabulary
// ("Plane of Sky - Island 1.5" for Noble Dojorn, "Efreeti Cycle (Island 4)" for Overseer of Air),
// and `islandOf`'s `\d+` would read `Island 1.5` as `Island 1` — inventing a precision the source
// does not have, on rows nobody reported and nobody has checked. This table therefore carries the
// ONE row that was verified, and `tests/skyMobIslands.test.mts` proves the other twenty-odd Sky
// mobs' islands are byte-identical with the overlay in place.
//
// THE ENTRY STATES WHAT IT REPLACES, the `SpellCorrection` idempotence rule: `derived` is what the
// join produces today. If a re-scrape moves the item's `where`, or the catalog drops the item from
// Protector of Sky, the derivation stops saying `Island 7` and the audit test fails rather than
// letting a correction that has quietly stopped describing anything look like coverage.

/** One mob whose OWN island the committed data states, and whose derived island disagrees. */
export interface SkyMobIsland {
  /** The wiki page — mob identity everywhere in this feature, never the display name. */
  page: string
  /** Where the mob IS, normalized the way `islandOf` normalizes ("Island 2"). */
  island: string
  /** What the item-derived join produces today, so a re-scrape that moves it fails the audit. */
  derived: readonly string[]
  /** Why this row is here and how it was checked, in one line. */
  evidence: string
}

export const SKY_MOB_ISLANDS: readonly SkyMobIsland[] = [
  {
    page: 'Protector of Sky',
    island: 'Island 2',
    derived: ['Island 7'],
    evidence:
      'eqlwiki Protector of Sky states "Location: 2nd Island"; the Rogue Test of Thievery page ' +
      'writes its Gem of Invigoration as "(Protector of Sky - Island 2 Boss)"; posky\'s own two ' +
      'PoS rows (Azarack Skin, Azarack Blood) say Island 2; bosses.json says "Plane of Sky - ' +
      'Island 2". The derived Island 7 comes from Gem of Invigoration, which its item page calls ' +
      'a drop off "any trash on island 7 (SotS)" - true about the item, not about this mob.'
  }
]

const BY_PAGE: ReadonlyMap<string, SkyMobIsland> = new Map(SKY_MOB_ISLANDS.map((e) => [e.page, e]))

/** The overlay row for a mob page, or undefined. Exported for the audit test. */
export function skyMobIslandFor(page: string): SkyMobIsland | undefined {
  return BY_PAGE.get(page)
}

/**
 * The islands to SHOW for one mob: the overlay's answer where it has one, the item-derived list
 * otherwise.
 *
 * A REPLACEMENT, NOT A UNION. "Protector of Sky · Islands 2, 7" would be two answers to a question
 * with one answer — the mob is on island 2, and island 7 is where the same item also drops off
 * somebody else's trash. The item's own `where` is untouched and still reads verbatim on the
 * item's hover card (`itemDropFacts`), which is the surface that is actually about the item.
 */
export function mobIslands(page: string, derived: readonly string[]): string[] {
  const hit = BY_PAGE.get(page)
  return hit ? [hit.island] : [...derived]
}
