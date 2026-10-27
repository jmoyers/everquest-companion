// A page's not-Legends and deletion notices (owner, 2026-10-22: A Rotting Citizen opens
// `{{delete}}{{DNE}}{{Namedmobpage`).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pageNotices } from '../src/shared/pageNotices'

test('A PAGE NAMES ITS DNE AND DELETE NOTICES, A REASON KEPT, EACH ONCE; COMMENTS AND OTHER TEMPLATES ARE NONE', () => {
  assert.deepEqual(pageNotices('{{delete}}{{DNE}}{{Namedmobpage\n| name = a rotting citizen\n}}'), ['delete', 'DNE'])
  assert.deepEqual(pageNotices('{{Delete|No longer in game}}\n{{Itempage}}'), ['delete: No longer in game'])
  assert.deepEqual(pageNotices('{{ dne }} {{DNE}}'), ['DNE'])
  assert.equal(pageNotices('{{Velious Era}}{{Namedmobpage}}'), undefined)
  assert.equal(pageNotices('<!-- {{delete}} -->{{Namedmobpage}}'), undefined)
  // A template whose name only starts with the word is another template.
  assert.equal(pageNotices('{{Deleted items}}{{DNEX}}'), undefined)
})

test('A MOB PAGE AND AN ITEM PAGE CARRY THEIR NOTICES INTO THE CATALOG RECORD; A PAGE WITHOUT ONE GAINS NO FIELD', async () => {
  const { parseMobPage } = await import('../scripts/sources/mobPage')
  const { toEntry } = await import('../scripts/scrape-items')
  const mob = '{{delete}}{{DNE}}{{Namedmobpage\n| name = a rotting citizen\n| level = 7\n| zone = [[Nektulos Forest]]\n}}'
  assert.deepEqual((parseMobPage('A Rotting Citizen', mob) as { notices?: string[] } | null)?.notices, ['delete', 'DNE'])
  assert.equal('notices' in (parseMobPage('A bat', '{{Namedmobpage\n| name = a bat\n| level = 1\n}}') ?? {}), false)
  const item = '{{Delete|No longer in game}}\n<onlyinclude>{{Itempage\n|lucy_img_ID = 635\n|statsblock = MAGIC ITEM<br>\n}}</onlyinclude>'
  assert.deepEqual((toEntry('Old Thing', item) as { notices?: string[] } | null)?.notices, ['delete: No longer in game'])
})
