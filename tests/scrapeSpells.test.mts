// Spell scraper page reader (scripts/scrape-spells.ts) on shapes found in the committed spell
// cache. Fixtures are trimmed copies of the pages named; nothing touches the network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSpell, parseSpellpageFields, spellName } from '../scripts/scrape-spells'

test('a doubled-pipe field is its own field, not the tail of the one before (50178 Harmshield)', () => {
  const wt = '{{Spellpage\n| spellname = Harmshield\n| msg_wears_off = Your invulnerability fades.\n|| where_to_obtain = Necromancer Spell Vendors\n}}'
  const f = parseSpellpageFields(wt)
  assert.equal(f.msg_wears_off, 'Your invulnerability fades.')
  assert.equal(f.where_to_obtain, 'Necromancer Spell Vendors')
})

test('fields written on one line are all read (56858 Mass Imbue Sapphire, 58213 Brass Resonance 14)', () => {
  const sapphire = parseSpellpageFields('{{Spellpage||spellname=Mass Imbue Sapphire|classes=* [[Cleric]] - Level 29|mana = 600}}')
  assert.equal(sapphire.spellname, 'Mass Imbue Sapphire')
  assert.equal(sapphire.classes, '* [[Cleric]] - Level 29')
  assert.equal(sapphire.mana, '600')
  const brass = parseSpellpageFields('{{Spellpage\n| spellname = Brass Resonance 14| spellicon = C\n| mana = 10\n}}')
  assert.equal(brass.spellname, 'Brass Resonance 14')
  assert.equal(brass.spellicon, 'C')
})

test('only the last field loses the template close; a value ending in its own template keeps it', () => {
  const wt = '{{Spellpage\n| spellname = Spirit of Wolf\n| classes =\n* [[Ranger]] - Level 52 {{Era | Kunark}}\n| msg_wears_off = The spirit of wolf leaves you. }}\n[[Category:Spells]]'
  const f = parseSpellpageFields(wt)
  assert.equal(f.classes, '* [[Ranger]] - Level 52 {{Era | Kunark}}')
  assert.equal(f.msg_wears_off, 'The spirit of wolf leaves you.')
  assert.equal(parseSpell('Spirit of Wolf', f).classes, '* Ranger - Level 52')
})

test('a summon slot row keeps the item its transclusion names', () => {
  const wt = '{{Spellpage\n| spellname = Summon Food\n| slots =\n{{SpellSlotRowSmart | 1 | Summon Item: {{:Summoned: Black Bread}} | simple = {{#ifeq:{{{Table|0}}}|0|0|1}} }}\n| mana = 5\n}}'
  assert.deepEqual(parseSpell('Summon Food', parseSpellpageFields(wt)).effects, ['Summon Item: Summoned: Black Bread'])
})

test('the page title names the spell unless it differs from |spellname only by a decoration', () => {
  assert.deepEqual(spellName('Healing Water', 'Greater Healing'), { name: 'Healing Water', disagrees: true })
  assert.deepEqual(spellName('Malaisement', 'Malisement'), { name: 'Malaisement', disagrees: true })
  assert.deepEqual(spellName('Greenmist (Spell)', 'Greenmist'), { name: 'Greenmist', disagrees: false })
  assert.deepEqual(spellName('Spell:Tears of Prexus', 'Tears of Prexus'), { name: 'Tears of Prexus', disagrees: false })
  assert.deepEqual(spellName('Effect: Flamesong', 'Flamesong'), { name: 'Flamesong', disagrees: false })
  assert.deepEqual(spellName('Song: Melody of Ervaj', 'Song: Melody of Ervaj'), { name: 'Melody of Ervaj', disagrees: false })
  assert.deepEqual(spellName('Burst of FlameTest', 'Burst of Flame'), { name: 'Burst of Flame', disagrees: false })
  assert.deepEqual(spellName("Tigir's Insects", 'Tigir`s Insects'), { name: 'Tigir`s Insects', disagrees: false })
  assert.deepEqual(spellName('Skin like Diamond', 'Skin Like Diamond'), { name: 'Skin Like Diamond', disagrees: false })
  assert.deepEqual(spellName('Bryrym', undefined), { name: 'Bryrym', disagrees: false })
})

test('casting_time = Instant reads as a zero cast time, not an absent one', () => {
  const f = parseSpellpageFields('{{Spellpage\n| spellname = Brass Resonance 14\n| casting_time = Instant\n| mana = 0\n}}')
  assert.equal(parseSpell('Brass Resonance 14', f).castTimeMs, 0)
  const g = parseSpellpageFields('{{Spellpage\n| spellname = Healing\n| casting_time = 2.5\n| mana = 10\n}}')
  assert.equal(parseSpell('Healing', g).castTimeMs, 2500)
})
