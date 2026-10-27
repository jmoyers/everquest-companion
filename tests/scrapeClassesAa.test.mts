// The Alternate Advancement page's four tables, parsed off the committed cache (no network):
// every AA by name, its table, its classes, whether it is clicked, and the cast its description
// names when that is not the AA's own name (owner ask, 2026-10-17: AAs cast in the log are known).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseAaAbilities, parseAaTable } from '../scripts/sources/classWiki'

const WT = readFileSync(new URL('../scripts/sources/cache/classes/Alternate_Advancement.wikitext', import.meta.url), 'utf8')
const ABBR = new Map(
  [
    ['bard', 'BRD'], ['beastlord', 'BST'], ['berserker', 'BER'], ['cleric', 'CLR'], ['druid', 'DRU'],
    ['enchanter', 'ENC'], ['magician', 'MAG'], ['monk', 'MNK'], ['necromancer', 'NEC'], ['paladin', 'PAL'],
    ['ranger', 'RNG'], ['rogue', 'ROG'], ['shadow knight', 'SHD'], ['shaman', 'SHM'], ['warrior', 'WAR'],
    ['wizard', 'WIZ']
  ] as [string, string][]
)

test('every AA row of the four tables is read, with its table', () => {
  const aas = parseAaTable(WT, ABBR)
  const groups = (g: string): number => [...aas.values()].filter((r) => r.group === g).length
  assert.deepEqual([groups('general'), groups('archetype'), groups('special')], [30, 34, 1])
  // A FLOOR for the class table: editors add class AAs (76 on 2026-10-10, 77 on 2026-10-18), and a
  // parser that stops reading rows still falls under it. Holds on the old cache and a re-scrape alike.
  assert.ok(groups('class') >= 76, `class AAs: ${String(groups('class'))}`)
  assert.deepEqual(aas.get('Heroic Leap'), { group: 'class', classes: ['WAR'], activated: true, levels: [12] })
  assert.deepEqual(aas.get('Origin'), { group: 'general', activated: true, levels: [1] })
  assert.deepEqual(aas.get('Mass Group Buff'), { group: 'archetype', activated: true, levels: [50] })
  assert.equal(aas.get('Adamant Will')?.activated, false)
})

test('an AA whose description casts another name carries that cast', () => {
  const aas = parseAaTable(WT, ABBR)
  const casts = [...aas].filter(([, r]) => r.cast !== undefined).map(([n, r]) => `${n} -> ${r.cast}`)
  assert.deepEqual(casts.sort(), [
    'Bestow Divine Aura -> Bestowed Divine Aura',
    "Companion's Fury -> Frenzied Burnout",
    'Purify Body -> Purification'
  ])
})

test('each rank carries the level its Requirements clause states; a struck-out row carries none', () => {
  // The first eight ranks: the older cache wrote the last two as `?/?`.
  assert.deepEqual(parseAaTable(WT, ABBR).get('Harm Touch')?.levels?.slice(0, 8), [1, 6, 11, 16, 21, 26, 31, 36])
  const wt = [
    '== Class AAs ==', '=== Shadow Knight Class AAs ===', '{| class="wikitable"', '|-',
    '| <s>Struck</s>|| 1 || 9 || <s>Requirements: Level 50.</s> This AA has been removed.', '|-',
    '| Kept || 2 || 3/6 || Passive. Requirements: level 12/30<br>', '|}'
  ].join('\n')
  const aas = parseAaTable(wt, ABBR)
  assert.deepEqual(aas.get('Kept')?.levels, [12, 30])
  assert.equal(aas.get('Struck')?.levels, undefined)
})

test('the class AA tables stop at the Special AAs table', () => {
  assert.equal(parseAaAbilities(WT, ABBR).has('Banestrike'), false)
  assert.equal(parseAaTable(WT, ABBR).get('Banestrike')?.group, 'special')
})
