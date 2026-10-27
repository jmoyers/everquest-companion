// Plane of Sky quest scraper (scripts/sources/eqlegends.ts). No network: fixture HTML shaped like
// the parsed main page, and a stubbed fetch.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attachItemStats, fetchParsedHtml, parseClasses, parseItemStats } from '../scripts/sources/eqlegends'

const classBlock = (cls: string, quest: string): string =>
  `<div class="mw-heading mw-heading3"><h3>${cls} Tests</h3></div>` +
  '<table><tr><th>Quest</th><th>Quest Giver</th><th>Rune</th><th>Quest Items</th><th>Reward</th></tr>' +
  `<tr><td>${quest}</td><td>Giver</td><td>Wind Rune Meda</td>` +
  '<td><ul><li>Nebulous Sapphire (7-SotS)</li></ul></td><td><a title="Lute">Lute</a></td></tr></table>'
const page = (...blocks: string[]): string => `<div class="mw-parser-output">${blocks.join('')}</div>`

test('every class in the list parses its table off the main page', () => {
  const quests = parseClasses(page(classBlock('Bard', 'Test of Voice'), classBlock('Cleric', 'Test of Faith')), ['Bard', 'Cleric'])
  assert.deepEqual(quests.map((q) => [q.className, q.name]), [['Bard', 'Test of Voice'], ['Cleric', 'Test of Faith']])
})

test('a class that yields no quests stops the scrape, so posky.json is never written without it', () => {
  assert.throws(() => parseClasses(page(classBlock('Bard', 'Test of Voice')), ['Bard', 'Cleric', 'Druid']), /Cleric, Druid/)
})

const parsed = (text: string): Response => new Response(JSON.stringify({ parse: { text } }), { status: 200 })
const statPage = '<div class="mw-parser-output">Lute\nMAGIC ITEM\nSlot: PRIMARY\nDrops From\nnobody</div>'

test('a 5xx is retried after the server-named wait; a 4xx is never retried', async (t) => {
  const replies = [new Response('', { status: 503, headers: { 'retry-after': '1' } }), parsed('<p>ok</p>')]
  const stub = t.mock.method(globalThis, 'fetch', async () => replies.shift() ?? new Response('', { status: 500 }))
  assert.equal(await fetchParsedHtml('Lute'), '<p>ok</p>')
  assert.equal(stub.mock.callCount(), 2)
  stub.mock.mockImplementation(async () => new Response('', { status: 404 }))
  assert.equal(await fetchParsedHtml('Gone'), null)
  assert.equal(stub.mock.callCount(), 3)
})

test('item pages are fetched a second apart and the ones left without stats are reported', async (t) => {
  const at: number[] = []
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    at.push(Date.now())
    return url.includes('Lute') ? parsed(statPage) : new Response('', { status: 404 })
  })
  const warn = t.mock.method(console, 'warn', () => undefined)
  t.mock.method(console, 'log', () => undefined)
  const quest = parseClasses(page(classBlock('Bard', 'Test of Voice')), ['Bard'])
  quest[0].items[0].page = 'Nebulous Sapphire'
  const dir = mkdtempSync(join(tmpdir(), 'posky-render-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  await attachItemStats(quest, { dir })
  assert.ok(at[1] - at[0] >= 990, `gap ${String(at[1] - at[0])} ms`)
  assert.match(quest[0].rewardStats ?? '', /MAGIC ITEM/)
  assert.match(String(warn.mock.calls.at(-1)?.arguments[0]), /without stats.*Nebulous Sapphire/)
})

test('a stat block breaks at every <br>, so a line the template appends keeps its own line', () => {
  const html = '<div class="mw-parser-output"><p>Efreeti Mace</p>\n<p>Class: WAR<br>\nRace: ALL<br><span>DMG Bonus: 15 @ lvl 50</span></p><h2>Drops From</h2></div>'
  assert.equal(parseItemStats(html, 'Efreeti Mace'), 'Class: WAR\nRace: ALL\nDMG Bonus: 15 @ lvl 50')
})
