// JOS-377 — A MOB'S DROP LIST, READ AGAINST THE ERA THE SERVER IS ON.
//
// THE OWNER REPORT (2026-08-15): the Cazic Thule mob page listed eighteen drops and seven of them
// are the Fear/Hate revamp table - loot that is not in this game. The item corpus already knew
// (every one of those pages carries a `{{FearHateRevamp Era}}` or `{{Velious Era}}` banner, both
// OUT keys in the wiki's own register) and the mob-loot surfaces never asked it.
//
// WHAT THIS SUITE PINS, end to end over the COMMITTED data rather than over a mock:
//   1. the ANNOTATION (`main/mobDropEra.ts`) - the item corpus's era banner and drop zones, put
//      onto the drops of a catalog record, and onto the drops of a WIKI-FALLBACK parse.
//   2. the FOLD (`renderer/features/mobs/dropEra.ts`) - which of those rows a surface shows, and
//      which the "+N out of era" disclosure holds.
// Both halves import the SHIPPED modules over the SHIPPED corpus, so a re-scrape that changes the
// wiki's mind turns this red instead of the app quietly lying again.
//
// THE VERDICT IS NEVER RE-DECIDED HERE. Nothing in this file names an era rule; it asserts what
// `layeredVerdict` (via `donorEra`) answers when handed the evidence the annotation attached.
// `tests/plannerEra.test.mts` is where the rule itself is pinned.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { annotateDrop, annotateDropEras } from '../src/main/mobDropEra'
import { knowledgeFromCatalog, localMobEntry } from '../src/main/mobLookupLocal'
import { parseMobWikitext } from '../src/main/mobLookupParse'
import { dropEraSubject, outOfEraLabel, splitDropsByEra } from '../src/renderer/src/features/mobs/dropEra'
import { donorEra } from '../src/renderer/src/features/planner/plannerData'
import { eraBadge } from '../src/shared/planner/era'
import type { MobDrop, MobKnowledge } from '../src/shared/types'

/** The seven the owner photographed, spelled exactly as the catalog spells them. */
const REVAMP_TABLE = [
  'Bile Etched Obsidian Choker',
  'Brain of Cazic Thule',
  'Cloak of the Fearsome',
  'Eye of Cazic Thule',
  'Halo of the Enlightened',
  'Pauldrons of Ferocity',
  'Robe of Inspiration'
]

/** The committed catalog's Cazic Thule, as `lookupMob` builds it before the annotation. */
function cazicThule(): MobKnowledge {
  const entry = localMobEntry('Cazic Thule')
  assert.ok(entry, 'the committed mob catalog must still hold Cazic Thule')
  assert.equal(entry.page, 'Cazic Thule (God)')
  return knowledgeFromCatalog('Cazic Thule', entry)
}

function names(drops: readonly MobDrop[]): string[] {
  return drops.map((d) => d.item)
}

test('E1: the annotation carries the item page era banner onto the revamp table', () => {
  const annotated = annotateDropEras(cazicThule())
  const byName = new Map((annotated.dropsWiki ?? []).map((d) => [d.item, d]))
  for (const name of REVAMP_TABLE) {
    const drop = byName.get(name)
    assert.ok(drop, `${name} must still be one of Cazic Thule's catalog drops`)
    // The TOKEN, verbatim - the annotation states what the page says and reaches no verdict.
    assert.ok(drop.eraTag !== undefined && drop.eraTag !== '', `${name} must carry its era banner`)
    // …and the wiki's own register is what calls that token out. `Template:PageEra`, mirrored.
    assert.equal(eraBadge(drop.eraTag), 'out', `${name}'s banner is an OUT key on the wiki`)
  }
})

test('E2: Cazic Thule shows eleven drops and folds exactly the seven away', () => {
  const { shown, out } = splitDropsByEra(annotateDropEras(cazicThule()).dropsWiki ?? [])
  assert.equal(shown.length + out.length, 18, 'no drop may be deleted - both facts stay sayable')
  assert.deepEqual(names(out).sort(), [...REVAMP_TABLE].sort())
  assert.equal(shown.length, 11)
  assert.equal(outOfEraLabel(out.length), '+7 out of era')
  // The page's own order survives the split on both sides (a fold, not a sort).
  assert.deepEqual(names(out), REVAMP_TABLE)
})

test('E3: a classic drop is in era and is never chipped', () => {
  const annotated = annotateDropEras(cazicThule())
  const amulet = (annotated.dropsWiki ?? []).find((d) => d.item === 'Amulet of Necropotence')
  assert.ok(amulet)
  assert.equal(donorEra(dropEraSubject(amulet)).verdict, 'in-era')
})

test('E4: a drop whose page states no era is NOT hidden', () => {
  // Blood Fire is the owner's own example: the corpus gives it no era banner at all. JOS-377's
  // brief expected `unknown` for it; MEASURED against the shipped join it reads IN-ERA, because
  // layer 1 speaks first and every mob the catalog says drops it lives in Plane of Fear, which
  // `shared/zones.ts` calls classic. Both verdicts render the row PLAINLY, which is the claim the
  // brief was making, so the fold is unchanged - what moves is only which chip (none, vs `era?`).
  const annotated = annotateDropEras(cazicThule())
  const bloodFire = (annotated.dropsWiki ?? []).find((d) => d.item === 'Blood Fire')
  assert.ok(bloodFire)
  assert.equal(bloodFire.eraTag, undefined, 'its item page carries no era banner')
  assert.notEqual(donorEra(dropEraSubject(bloodFire)).verdict, 'out-of-era')
  const { shown } = splitDropsByEra([bloodFire])
  assert.equal(shown.length, 1, 'no verdict is never a reason to hide what the wiki listed')
})

test('E5: an item the corpus does not hold is left alone and renders plainly', () => {
  const invented: MobDrop = { item: 'A Thing No Wiki Page Describes' }
  assert.deepEqual(annotateDrop(invented), invented, 'absent evidence is added, never invented')
  assert.deepEqual(dropEraSubject(invented), { key: 'a thing no wiki page describes' })
  assert.equal(donorEra(dropEraSubject(invented)).verdict, 'unknown')
  assert.equal(splitDropsByEra([invented]).out.length, 0)
})

/**
 * THE WIKI-FALLBACK PATH. A mob the committed catalog does not have is answered by parsing the
 * live page's wikitext (`parseMobWikitext`), and that list must be annotated by the same seam.
 *
 * The WRAPPER is shape 1 from `tests/mobCatalogWindows.test.mts` - a verbatim real eqlwiki
 * `{{Namedmobpage}}` with `drare`/`ddb` spans. The ITEM NAMES are the real ones off the Cazic
 * Thule page, so the fixture asks the same question of the other path.
 */
const WT_FALLBACK = `{{Classic Era}}{{Namedmobpage

| name              = Cazic Thule
| level             = 65

| zone              = [[Plane of Fear]]

| known_loot =

<ul><li>  {{:Amulet of Necropotence}}   <span class='drare'>(Rare)</span> <span class='ddb'>[Overall: 5.5%]</span>
</li><li> {{:Eye of Cazic Thule}}       <span class='drare'>(Ultra Rare)</span>
</li><li> {{:Robe of Inspiration}}      <span class='drare'>(Ultra Rare)</span>
</li></ul>

| related_quests =

* None

}}
`

test('E6: the wiki-fallback parse is annotated the same way', () => {
  const facts = parseMobWikitext(WT_FALLBACK)
  assert.equal(facts.dropsWiki?.length, 3, 'the fixture must still parse as three drops')
  const annotated = annotateDropEras({ name: 'Cazic Thule', cached: false, ...facts })
  const { shown, out } = splitDropsByEra(annotated.dropsWiki ?? [])
  assert.deepEqual(names(out), ['Eye of Cazic Thule', 'Robe of Inspiration'])
  assert.deepEqual(names(shown), ['Amulet of Necropotence'])
  // The rarity the fallback path alone can state rides through the annotation untouched.
  assert.equal(out[0].rarity, 'Ultra Rare')
})

test('E7: an unannotated record still renders - every drop, plainly', () => {
  // What an OLDER build's persistent cache hands back: `dropsWiki` with neither era field. The
  // fields are optional for exactly this reason, and the catalog's zones still answer for most of
  // it - what a stale record cannot know is the BANNER, which is the revamp witness.
  const stale: MobDrop[] = REVAMP_TABLE.map((item) => ({ item }))
  const { shown, out } = splitDropsByEra(stale)
  assert.equal(shown.length + out.length, REVAMP_TABLE.length, 'nothing is dropped on the floor')
  for (const drop of shown) assert.equal(drop.eraTag, undefined)
})
