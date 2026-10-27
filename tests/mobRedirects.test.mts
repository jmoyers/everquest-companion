// Wiki redirects kept as a mob's other names (owner, 2026-10-18: "Hoptor Thaggelum" redirects to
// "The Ghoul Lord" and was unknown on Gaps). Fixtures only, no network.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyItemOtherNames, applyOtherNames, applySpellOtherNames, redirectTarget, redirectsOf, withItemRedirectAliases, type NamedItem, type NamedMob, type NamedSpell } from '../scripts/sources/mobRedirects'
import { itemKey } from '../src/main/itemsDb'
import { allRedirects } from '../scripts/scrape-mob-redirects'

test('a redirect page names its target; any other page names none', () => {
  assert.equal(redirectTarget('#REDIRECT [[The Ghoul Lord]]'), 'The Ghoul Lord')
  assert.equal(redirectTarget('#redirect [[Lower_Guk#Bosses|the lord]]\n[[Category:x]]'), 'Lower Guk')
  assert.equal(redirectTarget('{{Namedmobpage\n|name = a bat\n}}'), null)
})

test("a mob keeps the redirects that land on its page, minus re-cased copies of its own names", () => {
  const mobs: NamedMob[] = [
    { page: 'The Ghoul Lord', name: 'the ghoul lord (Hoptor Thaggelum)' },
    { page: 'A bat', name: 'a bat', otherNames: ['Stale'] }
  ]
  applyOtherNames(mobs, [
    { from: 'Hoptor Thaggelum', to: 'The Ghoul Lord' },
    { from: 'Ghoul Lord', to: 'The Ghoul Lord' },
    { from: 'THE GHOUL LORD', to: 'The Ghoul Lord' },
    { from: 'Lower Guk Bosses', to: 'Lower Guk' }
  ])
  assert.deepEqual(mobs[0].otherNames, ['Ghoul Lord', 'Hoptor Thaggelum'])
  assert.equal(mobs[1].otherNames, undefined)
  assert.deepEqual(redirectsOf(mobs), [
    { from: 'Ghoul Lord', to: 'The Ghoul Lord' },
    { from: 'Hoptor Thaggelum', to: 'The Ghoul Lord' }
  ])
})

test('the collector joins the redirect pages to their targets by page id, 500 a request', async () => {
  const asked: Record<string, string>[] = []
  const answers = [
    { query: { allpages: [{ pageid: 1, title: 'A' }] }, continue: { apcontinue: 'M' } },
    { query: { allpages: [{ pageid: 2, title: 'N' }] } },
    { query: { allredirects: [{ fromid: 1, title: 'B' }, { fromid: 2, title: 'O' }, { fromid: 9, title: 'X' }] } }
  ]
  const get = (async (params: Record<string, string>) => {
    asked.push(params)
    return answers[asked.length - 1]
  }) as Parameters<typeof allRedirects>[0]
  assert.deepEqual(await allRedirects(get), [{ from: 'A', to: 'B' }, { from: 'N', to: 'O' }])
  assert.deepEqual(asked.map((q) => [q.list, q.apcontinue ?? q.arcontinue ?? '']), [['allpages', ''], ['allpages', 'M'], ['allredirects', '']])
  assert.equal(asked[0].apfilterredir, 'redirects')
})

test("AN ITEM KEEPS THE REDIRECTS THAT LAND ON ITS PAGE, ON EVERY KEY OF THE PAGE, LESS NAMES THAT ARE ITEMS OF THEIR OWN (OWNER, 2026-10-22: HALFLING BLOOD)", () => {
  const vial: NamedItem = { page: 'Vial of Halfling Blood' }
  const items: Record<string, NamedItem> = { 'vial of halfling blood': vial, 'halfling vial': vial, 'rusty mace': { page: 'Rusty Mace', otherNames: ['Stale'] } }
  applyItemOtherNames(items, [
    { from: 'Halfling Blood', to: 'Vial of Halfling Blood' },
    // The target differs in case from the page: still the page.
    { from: 'Blood of a Halfling', to: 'vial of Halfling Blood' },
    // A name that is an item of its own stays that item.
    { from: 'Halfling Vial', to: 'Vial of Halfling Blood' },
    { from: 'Nektulos Forest', to: 'Nektulos' }
  ], itemKey)
  assert.deepEqual(items['vial of halfling blood'].otherNames, ['Blood of a Halfling', 'Halfling Blood'])
  assert.deepEqual(items['halfling vial'].otherNames, ['Blood of a Halfling', 'Halfling Blood'])
  assert.equal(items['rusty mace'].otherNames, undefined)
})

test('A SPELL KEEPS THE REDIRECTS THAT LAND ON ITS PAGE, LESS ANY SPELL OF ITS OWN', () => {
  const spells: NamedSpell[] = [{ name: 'Enchant Gold' }, { name: 'Clarity II' }, { name: 'Clarity' }]
  applySpellOtherNames(spells, [
    { from: 'Enchant: Gold', to: 'Enchant Gold' },
    { from: 'Clarity 2', to: 'Clarity II' },
    { from: 'Clarity', to: 'Clarity II' }
  ])
  assert.deepEqual(spells.map((s) => s.otherNames), [['Enchant: Gold'], ['Clarity 2'], undefined])
})

test("EVERY REDIRECT THAT LANDS ON AN ITEM PAGE IS A DROP ALIAS; THE DROP-LIST PAGES' OWN ALIASES STAY", () => {
  const items: Record<string, NamedItem> = { 'vial of halfling blood': { page: 'Vial of Halfling Blood' }, 'wooden heart': { page: 'Wooden Heart' }, 'halfling blood': { page: 'Halfling Blood' } }
  const out = withItemRedirectAliases({ 'A Wooden Heart': 'Wooden Heart' }, items, [
    { from: 'Blood Vial', to: 'Vial of Halfling Blood' },
    { from: 'A Wooden Heart', to: 'Something Else' },
    // An item of its own is never an alias of another.
    { from: 'Halfling Blood', to: 'Vial of Halfling Blood' },
    { from: 'Nektulos Forest', to: 'Nektulos' }
  ], itemKey)
  assert.deepEqual(out, { 'A Wooden Heart': 'Wooden Heart', 'Blood Vial': 'Vial of Halfling Blood' })
})
