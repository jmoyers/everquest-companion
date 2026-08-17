// EXALTATION PLANNER — the donor index, asserted against the REAL committed corpus
// (src/main/data/items.json, 11,247 records / 11,351 keys as of the 2026-08-03 scrape).
//
// This is the file that decides whether the Planner has anything to show: the pane is a browser
// over `buildPlannerDonors`, so "the Proc tab is empty" and "every Improved Healing donor
// vanished" are both failures of THIS function, and both are invisible in a hand-written fixture.
// So it runs the SHIPPED builder over the SHIPPED bytes. No Electron (effectIndex.ts is
// Electron-free on purpose — the mobSearch precedent), nothing skips.
//
// Assertions are FLOORS and IDENTITIES, never today's counts (AGENTS.md "frozen numbers rot" —
// the wiki gains item pages and a rescrape must be able to grow this file without turning the
// suite red). The floors sit under what the 2026-08-05 build measured:
//
//     click 803 · proc 446 · focus 119 · worn 100   = 1,468 donor rows
//     from 1,510 effect-bearing pages of 11,161 (190 alias keys skipped, 49 socketless
//     `Effect:` rows excluded, 3 duplicate-page rows collapsed, 40 pages excluded by V9)
//
// The V9 exclusion (`Summoned:` + the curated layer) is what re-based those from the 2026-08-04
// build's 1,508: it took 39 summoned rows and one GM-event row off the donor list permanently, so
// the floors below moved down with it rather than sitting a hair above the measurement. JOS-25
// then swept the corpus's GM-event prose properly and the exclusion measured 45 pages — the extra
// five are effect-bearing GM-event items, and the floors already sat under them. JOS-64 admitted
// the three GM-ONLY pages on the owner's ruling and it measured 47 (two of the three carry a click
// illusion); the floors still sit under that.
//
// The identities are the interesting half: one row per (key, effect, socket) with NO duplicates,
// and every slot token canonical. Both are properties the UI depends on and neither is a count.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import itemsJson from '../src/main/data/items.json'
import type { ItemDbFile } from '../src/main/itemsDb'
import {
  PLANNER_SEARCH_LIMIT,
  buildPlannerDonors,
  buildPlannerIndex,
  buildSpellFacts,
  searchPlannerItems
} from '../src/main/planner/effectIndex'
import { effectOneLiner } from '../src/shared/planner/effectText'
import { EQUIP_SLOTS, SOCKET_TYPES } from '../src/shared/planner/types'
import { eraFromTag, layeredVerdict, zoneEra } from '../src/shared/planner/era'
import { isClassAbbr } from '../src/shared/classCombo'
import {
  ITEMS_RESEARCH,
  isUnfarmable,
  knowledgeWithResearch,
  type ItemResearchFile
} from '../src/main/itemsResearch'

const file = itemsJson as unknown as ItemDbFile
const index = buildPlannerIndex(file)
const donors = index.donors

/** Per-socket floors — under the measured build, so a growing corpus stays green. */
const FLOORS = { proc: 400, click: 760, focus: 100, worn: 90 } as const

const bySocket = (socket: string): number => donors.filter((d) => d.socket === socket).length

test('the corpus yields a populated donor index (per-socket floors)', () => {
  const measured = Object.fromEntries(SOCKET_TYPES.map((s) => [s, bySocket(s)]))
  // Printed because this is the number the planner's usefulness IS — a wave that halves it
  // should be able to see that it did.
  console.log('planner donors', { total: donors.length, ...measured, stats: index.stats })
  for (const [socket, floor] of Object.entries(FLOORS)) {
    assert.ok(
      bySocket(socket) >= floor,
      `only ${bySocket(socket)} ${socket} donors — expected >= ${floor}`
    )
  }
  // D2: the wiki spells procs `Combat Effect:`, so `kind:'proc'` is 0 in the corpus and every
  // proc row here arrives via the combat→proc fold. A zero here means that fold broke.
  assert.ok(bySocket('proc') > 0, 'no proc donors at all — the combat→proc fold (D2) is broken')
  assert.equal(buildPlannerDonors(file).length, donors.length, 'both entry points must agree')
})

test('(key, effect, socket) is a ROW IDENTITY — alias keys and duplicate pages collapse', () => {
  // Two ways one item can be read twice: its `|itemname` alias key (196 of them), and a second
  // wiki page for the same item ("10 Dose Ethiras Poison Antidote" without the apostrophe, the
  // four elemental Holgresh Mojo Stick pages, a guide page whose |itemname is an item). Either
  // would render the same donor twice in the browser and make "which row did I plan" ambiguous.
  const seen = new Set<string>()
  const dupes: string[] = []
  for (const d of donors) {
    const id = [d.key, d.effect, d.socket].join(' :: ')
    if (seen.has(id)) dupes.push(id)
    seen.add(id)
  }
  assert.deepEqual(dupes, [], `duplicate donor rows: ${dupes.slice(0, 5).join(', ')}`)
  assert.ok(index.stats.aliasKeys > 0, 'the corpus is expected to carry |itemname alias keys')
  assert.ok(index.stats.pages >= 11_000, `only ${index.stats.pages} pages walked`)
})

test('every emitted token is canonical — slots, classes, sockets, tiers', () => {
  const slots = new Set<string>(EQUIP_SLOTS)
  const sockets = new Set<string>(SOCKET_TYPES)
  for (const d of donors) {
    for (const s of d.slots) assert.ok(slots.has(s), `${d.name}: non-canonical slot ${s}`)
    for (const c of d.classes) assert.ok(isClassAbbr(c), `${d.name}: non-canonical class ${c}`)
    assert.ok(sockets.has(d.socket), `${d.name}: unknown socket ${d.socket}`)
    assert.ok([1, 2, 3, 4].includes(d.tierRequired), `${d.name}: bad tier ${d.tierRequired}`)
    assert.ok(d.key.length > 0 && d.name.length > 0, 'every row must be identifiable')
    assert.equal(typeof d.hasteLocked, 'boolean')
  }
  // Law 1's tripwire: an unrecognized slot spelling must turn this red, never be dropped quietly.
  assert.deepEqual(index.stats.unknownSlotTokens, [], 'unknown slot tokens in the corpus')
})

test('V6: most donor rows can say what their effect DOES, and a miss says nothing at all', () => {
  // THE JOIN IS THE FEATURE. A browser row used to read "Nullify Undead" and stop, so every row
  // was a wiki trip; the one-liner is the committed spell DB joined by case-folded effect name at
  // index build. MEASURED 2026-08-05: 1,469 of 1,560 effect rows match (94.2%). A FLOOR, not the
  // number — a rescrape of either corpus moves it, and the browser degrades gracefully if it
  // falls, but a collapse means the join broke rather than that the wiki changed.
  const said = donors.filter((d) => effectOneLiner(d) !== '')
  console.log('planner effect one-liners', {
    joined: index.stats.spellJoined,
    of: donors.length,
    pct: ((100 * said.length) / donors.length).toFixed(1)
  })
  assert.ok(said.length * 2 > donors.length, `only ${said.length} of ${donors.length} rows say anything`)
  assert.equal(index.stats.spellJoined, said.length, 'the stat must count the rows the UI can describe')

  // A MISS IS SILENT. No placeholder, no partial guess: a row the spell DB never named carries
  // none of the three fields, so the renderer draws nothing rather than "unknown" (law 1).
  for (const d of donors) {
    if (effectOneLiner(d) !== '') continue
    assert.equal(d.spellType, undefined)
    assert.equal(d.spellTarget, undefined)
    assert.equal(d.spellDuration, undefined)
  }

  // …and the join is EXACT, ranks included: an item's `Effect:` line names the spell it carries,
  // so folding "Improved Healing I" onto "Improved Healing III" would state the wrong duration.
  const facts = buildSpellFacts([
    { name: 'Improved Healing III', durationMs: null, illusion: false, spellType: 'Beneficial' },
    { name: 'Improved Healing III', durationMs: null, illusion: false, spellType: 'Detrimental' }
  ])
  assert.equal(facts.get('improved healing i'), undefined, 'ranks must not fold together')
  assert.equal(facts.get('improved healing iii')?.spellType, 'Beneficial', 'first page wins')
})

test('R2 has real work to do: a large slotless minority can never legally donate', () => {
  // WHY THIS IS PINNED IN THE CORPUS TEST. The effect browser's default filter drops donors with
  // no equipment slot, because R2 only lets an exaltation move between items that SHARE a slot —
  // so a donor with none shares a slot with nothing. That filter is only defensible if the corpus
  // really does carry a mass of slotless rows (it is the potion aisle) AND they really are a
  // minority (a filter that hid most of the planner would be a bug, not a rule).
  //
  // RE-MEASURED 2026-08-06 (JOS-67): 280 of 1,462 rows — click 213/799, proc 67/444, focus 0/119,
  // worn 0/100. Two of the click rows left the slotless mass this ticket, and neither was a
  // consumable: the Golem Metal Wand and the Azarack Skin Wristwraps state their slot on a line
  // the scrape cannot key, so the curated layer now files it (`itemsResearch.ts` `slots`) and they
  // arrive equipped like every other donor. Floors and identities only below; a rescrape may move
  // every one of those numbers.
  const slotless = donors.filter((d) => d.slots.length === 0)
  const per = Object.fromEntries(
    SOCKET_TYPES.map((s) => [s, slotless.filter((d) => d.socket === s).length])
  )
  console.log('planner slotless donors', { total: slotless.length, ...per })

  assert.ok(slotless.length >= 150, `only ${slotless.length} slotless donors — the filter would be pointless`)
  assert.ok(
    slotless.length * 2 < donors.length,
    `${slotless.length} of ${donors.length} rows are slotless — a default filter must never hide the majority`
  )
  // The shape of the mass, as an IDENTITY rather than a count: the consumable sockets carry it.
  // Focus and worn effects only ever appear on things you wear, and if that ever stops being true
  // the browser's default is hiding real worn/focus donors and this test is the one that says so.
  assert.equal(per.focus, 0, 'a slotless FOCUS donor appeared — re-check the default filter')
  assert.equal(per.worn, 0, 'a slotless WORN donor appeared — re-check the default filter')
})

test('R1 holds per socket: the extraction tier comes from the rules, not from here', () => {
  const tiers = new Map<string, Set<number>>()
  for (const d of donors) {
    const set = tiers.get(d.socket) ?? new Set<number>()
    set.add(d.tierRequired)
    tiers.set(d.socket, set)
  }
  // One tier per socket type, and the four are the unlock thresholds: focus +1 … proc +4.
  assert.deepEqual([...(tiers.get('focus') ?? [])], [1])
  assert.deepEqual([...(tiers.get('click') ?? [])], [2])
  assert.deepEqual([...(tiers.get('worn') ?? [])], [3])
  assert.deepEqual([...(tiers.get('proc') ?? [])], [4])
})

test('the anchor row: Improved Healing is a FOCUS donor extractable at +1', () => {
  // A named row rather than a shape check — floors can be met by garbage. Improved Healing is the
  // focus family every healer plans around; the corpus states it on 30+ pages.
  const healing = donors.filter((d) => /^Improved Healing/i.test(d.effect))
  assert.ok(healing.length > 0, 'no Improved Healing donors at all')
  for (const d of healing) {
    assert.equal(d.socket, 'focus', `${d.name} carries ${d.effect} as ${d.socket}, expected focus`)
    assert.equal(d.tierRequired, 1)
    assert.equal(d.hasteLocked, false)
  }
  // R3's other half, on the same principle: haste effects are FLAGGED, never dropped.
  assert.ok(donors.some((d) => d.hasteLocked), 'no haste-locked donors — R3 is not being applied')
})

test('donors carry the item page’s OWN drop sources (`|dropsfrom`)', () => {
  const withWiki = donors.filter((d) => (d.wikiSources?.length ?? 0) > 0)
  const withZone = withWiki.filter((d) => d.wikiSources?.some((s) => s.zone !== undefined))
  console.log('planner wikiSources', { rows: withWiki.length, withZone: withZone.length })

  // FLOORS under the 2026-08-04 build (804 rows carry sources, 796 of them naming a zone) —
  // this is the second witness to "where does this drop", beside the renderer's mob-catalog
  // inversion, and a parser change that silently stops reading the field must turn this red.
  assert.ok(withWiki.length >= 700, `only ${withWiki.length} donors carry wikiSources`)
  assert.ok(withZone.length >= 700, `only ${withZone.length} name a zone`)

  for (const d of withWiki) {
    for (const s of d.wikiSources ?? []) {
      assert.ok(s.mob.length > 0, `${d.name}: an unnamed drop source`)
      // Absent means UNKNOWN; an empty string would render as a zone chip with no zone in it.
      assert.ok(s.zone === undefined || s.zone.length > 0, `${d.name}: empty zone string`)
      assert.doesNotMatch(s.mob, /\[\[|\{\{|<\w/, `${d.name}: unstripped markup in "${s.mob}"`)
    }
  }
  // Mob-only entries are real (8 rows): a page that lists mobs under no heading states a mob and
  // no zone, and that is kept rather than dropped.
  assert.ok(
    withWiki.some((d) => d.wikiSources?.some((s) => s.zone === undefined)),
    'no zone-less wiki sources at all — the mob-only shape stopped parsing'
  )
})

test('the Coldain anchor: a Velious donor the mob catalog cannot place', () => {
  // The owner saw the Coldain Velium weapons as era-unknown. MEASURED against the scrape cache:
  // eight of the nine carry NO `|dropsfrom` at all (they are VENDOR SOLD — their provenance sits
  // in `|soldby`, unparsed), and exactly one states a source. That one is the anchor, because it
  // is the shape the whole task is for: a wiki-stated zone that resolves to VELIOUS.
  const sword = donors.find((d) => d.key === 'coldain velium short sword')
  assert.ok(sword, 'Coldain Velium Short Sword is no longer a donor')
  assert.deepEqual(
    sword.wikiSources?.map((s) => s.zone),
    ['Eastern Wastes'],
    'the sword must still name its zone'
  )
  assert.equal(zoneEra('Eastern Wastes'), 'velious')

  // …and the general form: donors whose only stated zone is Velious content exist in numbers.
  const velious = donors.filter(
    (d) => (d.wikiSources?.length ?? 0) > 0 && d.wikiSources?.every((s) => s.zone !== undefined && zoneEra(s.zone) === 'velious')
  )
  assert.ok(velious.length >= 50, `only ${velious.length} donors are Velious-only by wiki source`)
})

test('donors carry the page-top era banner (`eraTag`) — the last-resort witness', () => {
  const tagged = donors.filter((d) => d.eraTag !== undefined)
  const mapped = tagged.filter((d) => eraFromTag(d.eraTag ?? '') !== null)
  const tokens = [...new Set(tagged.map((d) => d.eraTag ?? ''))].sort()
  console.log('planner eraTag', { rows: tagged.length, mapped: mapped.length, tokens })

  // FLOOR under the 2026-08-04 build (1,258 of 1,508 donor rows carry a banner). A parser change
  // that silently stops reading the template must turn this red, not quietly drop 700 donors back
  // into `era?`.
  assert.ok(tagged.length >= 1_000, `only ${tagged.length} donors carry an eraTag`)

  // The table has to actually cover what the corpus says. A NEW token appearing in a rescrape is
  // allowed (it reads as `null` = unknown, which is honest) — the table going stale wholesale is
  // not, so this is a ratio floor rather than a set identity.
  const covered = (100 * mapped.length) / tagged.length
  assert.ok(covered >= 95, `eraFromTag maps only ${covered.toFixed(1)}% of tagged donors`)

  for (const d of tagged) {
    assert.doesNotMatch(d.eraTag ?? '', /[{}|]|\bEra\b/, `${d.name}: raw markup in eraTag "${d.eraTag ?? ''}"`)
    assert.equal(d.eraTag, (d.eraTag ?? '').trim(), `${d.name}: untrimmed eraTag`)
  }
})

test('the Coldain anchor, layer 2: no zone anywhere, but the page says Velious', () => {
  // The sibling of the `|dropsfrom` anchor above, and the case the banner layer exists for: eight
  // of the nine Coldain Velium weapons are VENDOR SOLD, so neither the mob catalog nor the item
  // page places them — before the banner they read `era?` and stayed in a classic-era player's
  // farm list forever. The page opens `{{Velious Era}}`, and that is now enough to say so.
  const sword = donors.find((d) => d.key === 'coldain velium long sword')
  assert.ok(sword, 'Coldain Velium Long Sword is no longer a donor')
  assert.equal(sword.wikiSources, undefined, 'the long sword states no drop source')
  assert.equal(sword.eraTag, 'Velious')
  assert.equal(eraFromTag(sword.eraTag), 'velious')
  // The whole family agrees — this is a set of pages, not one lucky row.
  const coldain = donors.filter((d) => d.key.startsWith('coldain velium'))
  assert.ok(coldain.length >= 5, `only ${coldain.length} Coldain Velium donors`)
  for (const d of coldain) assert.equal(d.eraTag, 'Velious', d.name)

  // WITHOUT a zone the layered verdict is the banner's — and SINCE JOS-298 so is the verdict WITH
  // one: `{{Velious Era}}` is an out-of-era badge the wiki renders in red, and a drop zone cannot
  // refute a claim about which content the server has opened. (It used to read `in-era` here, on
  // the zone-wins doctrine; `tests/plannerEra.test.mts` carries the inversion and its evidence.)
  assert.equal(layeredVerdict([], sword.eraTag), 'out-of-era')
  assert.equal(layeredVerdict(['Lower Guk'], sword.eraTag), 'out-of-era')
})

test('THE EPIC PIN: a dropperless epic reward is out-of-era on a classic server (V1)', () => {
  // The row the era fix exists for. Ragebringer is a quest turn-in: no `|dropsfrom`, no catalog
  // dropper (pinned in tests/plannerEra.test.mts against the mob catalog), so the page's own
  // `{{Epics Era}}` banner is the ONLY witness the planner has. While `Epics` mapped to classic it
  // rendered CLEAN with the era filter ON — a level-46 rogue epic offered as farmable loot on a
  // server whose epic chains do not exist (owner, 2026-08-05).
  for (const key of ['ragebringer', 'spear of fate']) {
    const row = donors.find((d) => d.key === key)
    assert.ok(row, `${key} is no longer a donor`)
    assert.equal(row.quest, true, `${key} must still read as a quest reward`)
    assert.equal(row.eraTag, 'Epics', `${key} must still carry the epic banner`)
    assert.equal(row.wikiSources, undefined, `${key} states no drop source — the pin needs that`)
    assert.equal(layeredVerdict([], row.eraTag), 'out-of-era', key)
  }
  // The tag is the whole family's evidence, not two lucky pages: every epic-bannered donor that
  // names no zone anywhere reads out-of-era today.
  const epics = donors.filter((d) => /^epic/i.test(d.eraTag ?? ''))
  assert.ok(epics.length >= 20, `only ${epics.length} epic-bannered donors`)
  assert.equal(eraFromTag('Epics'), 'kunark')
})

test('V9: summoned and GM-handed-out items are dropped from the DONOR index, and only from it', () => {
  // R7 (owner-observed, unverified — docs/plans/exaltation-planner.md §1) plus the curated layer.
  // MEASURED 2026-08-06 (JOS-25): 45 effect-bearing pages excluded — 39 `Summoned:` rows (focus
  // 24, click 10, worn 4, proc 1) and the six effect-bearing entries of the layer's ten-item
  // GM-event table. The other four GM-event items carry no effect at all, so they were never
  // donors to lose. JOS-64's ruling (GM-ONLY is as unfarmable as GM-event) then admitted three
  // more pages and the exclusion measured 47: Da Oogly Stick and Stone of Gnoming each carry a
  // click illusion, Gnome Sandwich carries nothing.
  // `tests/itemsResearchLayer.test.mts` is what pins the tables themselves.
  console.log('planner exclusions', { excludedPages: index.stats.excludedPages })
  assert.ok(index.stats.excludedPages >= 30, `only ${index.stats.excludedPages} pages excluded`)

  const summonedDonors = donors.filter((d) => /^summoned:/i.test(d.name))
  assert.deepEqual(summonedDonors.map((d) => d.name), [], 'a summoned item is offering an effect')

  // …and they are STILL items: a summoned item is a real thing to look up and a legal host to
  // search for. Excluding it from the donor list is a statement about donation, nothing else.
  const summonedItems = index.items.filter((i) => /^summoned:/i.test(i.name))
  assert.ok(summonedItems.length >= 50, `only ${summonedItems.length} summoned rows in the item index`)
  assert.ok(searchPlannerItems(index.items, 'summoned:').length > 0, 'summoned items stopped being searchable')

  // The committed layer's own entries, whatever they are today: each must be excluded from donors,
  // present as an item, and carry its provenance (an entry with no source reads like scraped fact).
  const flagged = Object.entries(ITEMS_RESEARCH).filter(([, r]) => r.summoned === true || isUnfarmable(r))
  assert.ok(flagged.length > 0, 'the curated layer seeds no exclusions at all')
  for (const [key, entry] of flagged) {
    assert.ok(entry.source.length > 0, `${key}: a curated entry with no source`)
    assert.match(entry.checkedAt, /^\d{4}-\d{2}-\d{2}/, `${key}: no checkedAt date`)
    assert.equal(donors.find((d) => d.key === key), undefined, `${key} is still a donor`)
    assert.ok(index.items.some((i) => i.key === key), `${key} fell out of the item index entirely`)
  }
})

test('the additive layer merges OVER the wiki record, and drives the exclusion from a fixture', () => {
  // Driven by a fixture rather than by the committed layer: the exclusion path has to hold for
  // whatever gets curated next, not just for today's seed.
  const fixture = {
    scrapedAt: '2026-08-05T00:00:00.000Z',
    source: 'fixture',
    count: 4,
    items: {
      ghoulbane: { page: 'Ghoulbane', stats: { effects: [{ kind: 'click', name: 'Nullify Undead', detail: 'Must Equip' }], slot: 'PRIMARY' } },
      'summoned: waterstone': { page: 'Summoned: Waterstone', stats: { effects: [{ kind: 'click', name: 'Enduring Breath', detail: 'Any Slot' }], slot: 'PRIMARY' } },
      'gm sword': { page: 'GM Sword', stats: { effects: [{ kind: 'worn', name: 'Regeneration', detail: 'Worn' }], slot: 'PRIMARY' } },
      'gm wand': { page: 'GM Wand', stats: { effects: [{ kind: 'click', name: 'Gate', detail: 'Any Slot' }], slot: 'PRIMARY' } }
    }
  } as unknown as ItemDbFile
  // Both GM provenances, because `excludedDonor` reads the layer's `isUnfarmable` verdict rather
  // than one named flag (JOS-64) — a fixture that only ever exercised `gmEvent` would go green
  // against a consumer that had forgotten the other half.
  const research: ItemResearchFile = {
    'gm sword': { gmEvent: true, source: 'fixture', checkedAt: '2026-08-05' },
    'gm wand': { gmOnly: true, source: 'fixture', checkedAt: '2026-08-06' }
  }

  const built = buildPlannerIndex(fixture, research)
  assert.deepEqual(built.donors.map((d) => d.key), ['ghoulbane'], 'exactly the un-excluded item donates')
  assert.equal(built.stats.excludedPages, 3, 'every exclusion must be COUNTED, never silently dropped')
  // All four stay searchable — the item index is not the donor index.
  assert.deepEqual(built.items.map((i) => i.key).sort(), ['ghoulbane', 'gm sword', 'gm wand', 'summoned: waterstone'])

  // With no layer at all the name prefix still fires and the curated ones no longer do: the two
  // witnesses are independent.
  const bare = buildPlannerIndex(fixture, {})
  assert.deepEqual(bare.donors.map((d) => d.key).sort(), ['ghoulbane', 'gm sword', 'gm wand'])

  // The merge itself: the scrape's own defaults are restored FIRST (law 1 — `quest` is false
  // because the record omits it, not because the layer said so), the curated entry rides beside
  // them, and an unresearched item carries no `research` field rather than an empty one.
  const merged = knowledgeWithResearch(fixture.items['gm sword'], research)
  assert.equal(merged.name, 'GM Sword')
  assert.equal(merged.quest, false)
  assert.deepEqual(merged.research, research['gm sword'])
  assert.equal(knowledgeWithResearch(fixture.items.ghoulbane, research).research, undefined)
})

test('host search: substring, prefix-first, shortest-first, capped', () => {
  const hits = searchPlannerItems(index.items, 'ghoulbane')
  assert.ok(hits.length > 0, 'Ghoulbane must be findable')
  assert.equal(hits[0].name.toLowerCase(), 'ghoulbane')

  // Prefix beats mid-name, and the plain item beats its longer neighbours.
  const cloaks = searchPlannerItems(index.items, 'cloak of')
  assert.ok(cloaks.length > 1)
  assert.ok(
    cloaks[0].name.toLowerCase().startsWith('cloak of'),
    `prefix hit expected first, got ${cloaks[0].name}`
  )
  const prefixRun = cloaks.findIndex((h) => !h.name.toLowerCase().startsWith('cloak of'))
  assert.ok(prefixRun === -1 || prefixRun > 0, 'prefix hits must come before mid-name hits')

  // Capped, case-insensitive, and empty means empty (the UI shows its browse list instead).
  assert.ok(searchPlannerItems(index.items, 'a').length <= PLANNER_SEARCH_LIMIT)
  assert.deepEqual(searchPlannerItems(index.items, '   '), [])
  assert.deepEqual(
    searchPlannerItems(index.items, 'GHOULBANE')[0],
    searchPlannerItems(index.items, 'ghoulbane')[0]
  )

  // The host picker searches EVERY item, not just effect-bearing ones — a plain sword is a
  // perfectly good host — and one row per item key.
  assert.ok(index.items.length > donors.length, 'the item index must cover the whole corpus')
  assert.equal(new Set(index.items.map((i) => i.key)).size, index.items.length, 'one row per key')
})

// ---- narrowing to one equipment slot ---------------------------------------------------------
//
// The gear plan board asks this question about ONE cell. It used to narrow the ANSWER, in the
// renderer, which silently defeated the fifty-hit cap: the cap had already chosen its fifty from
// the whole corpus. These tests hold the fix to the property that actually matters — the cap and
// the narrowing happen in the right ORDER — and they do it against the real corpus, because the
// bug was only visible at eleven thousand rows.

test('a slotted search narrows BEFORE the cap - every hit is one the caller can use', () => {
  const rings = searchPlannerItems(index.items, '', PLANNER_SEARCH_LIMIT, 'FINGER')
  assert.ok(rings.length > 0, 'the corpus states finger items')
  for (const hit of rings) {
    assert.ok(hit.slots.includes('FINGER'), `${hit.name} came back for FINGER without stating it`)
  }

  // THE REGRESSION ITSELF, measured rather than described. "ri" over the whole corpus fills the cap
  // with fifty rows ranked corpus-wide; keeping only the rings out of THOSE is what the renderer
  // used to do, and it is strictly worse than asking main for fifty rings.
  const corpusWide = searchPlannerItems(index.items, 'ri')
  const keptAfterwards = corpusWide.filter((h) => h.slots.includes('FINGER')).length
  const narrowedFirst = searchPlannerItems(index.items, 'ri', PLANNER_SEARCH_LIMIT, 'FINGER').length
  assert.ok(
    narrowedFirst >= keptAfterwards,
    `narrowing first offered ${narrowedFirst}, filtering afterwards offered ${keptAfterwards}`
  )
})

test('an empty query answers ONLY with a slot - the minimum`s reason, in the model', () => {
  // No slot: the haystack is the whole corpus and an unfiltered list of it says nothing. This is
  // the rule `MIN_QUERY` exists to state, and it is unchanged for every caller without a cell.
  assert.deepEqual(searchPlannerItems(index.items, ''), [])
  assert.deepEqual(searchPlannerItems(index.items, '   '), [])

  // With a slot the set is CLOSED, so the list is itself the answer to "what can go here".
  for (const slot of EQUIP_SLOTS) {
    const hits = searchPlannerItems(index.items, '', PLANNER_SEARCH_LIMIT, slot)
    assert.ok(hits.length <= PLANNER_SEARCH_LIMIT, `${slot} came back over the cap`)
    for (const hit of hits) assert.ok(hit.slots.includes(slot), `${slot} offered ${hit.name}`)
  }
  // …and at least one real slot actually fills, so the loop above is not vacuously true.
  assert.ok(searchPlannerItems(index.items, '', PLANNER_SEARCH_LIMIT, 'HEAD').length > 0)
})

test('a slot narrows the query rather than replacing it - both constraints hold at once', () => {
  const hits = searchPlannerItems(index.items, 'of', PLANNER_SEARCH_LIMIT, 'HEAD')
  assert.ok(hits.length > 0, 'the corpus states head items with "of" in the name')
  for (const hit of hits) {
    assert.ok(hit.slots.includes('HEAD'), `${hit.name} is not a head item`)
    assert.ok(hit.name.toLowerCase().includes('of'), `${hit.name} does not match the query`)
  }
})
