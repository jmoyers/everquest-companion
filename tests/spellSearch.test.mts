// SUGGEST-DIALOG SEARCH + SECTIONS (docs/plans/suggest-dialog-redesign.md §1/§2/§4).
//
// The redesign's claim is that ONE box answers every question a player asks about an alert —
// by name, by the spell's own message text, by level, by class, by type — with no invented
// effect taxonomy anywhere. That claim is a pure function (`shared/spellSearch.ts`), so it gets
// a truth table rather than a screenshot.
//
// Four proofs:
//   (S1) THE TOKENIZER: every token form, and what an unparseable one degrades to.
//   (S2) THE MATCHER'S TRUTH TABLE: each form against a hand-built row, AND-composed — plus
//        THE HEADLINE CASE, run against the REAL spell DB: "slow" finds Weakening Strike
//        through its landing emote (`'s limbs move slower!`) and nothing else knows that.
//   (S3) THE CATALOG BUILD: `searchText` really is name + ranks + the three messages,
//        lowercased, for every row main ships.
//   (S4) THE SECTIONS + THE ROW BUDGET: the partition is total and disjoint, "From your
//        fights" holds exactly the observed rows, and MAX_ROWS is a cap on the WHOLE dialog.
//   (S5) THE APOSTROPHE FOLD (JOS-342): the reported query, the reverse direction, and the
//        exhaustive property over every apostrophe-bearing row the app ships.
//   (S6) THE ORDER-FREE BARE GRAMMAR (JOS-392): a class word, a `27-28` band, the two-word join,
//        the SCOPING of a level to the classes, and the one ambiguity the widening creates.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadSpellDb, buildSpellCatalog, searchTextFor } from '../src/main/data/spellDb'
import {
  SPELL_SECTIONS,
  filterSpells,
  foldApostrophes,
  groupSpellSections,
  isPoisonSpell,
  matchesSpellQuery,
  sectionFor,
  tokenizeSpellQuery,
  type SearchableSpell
} from '../src/shared/spellSearch'
import {
  MAX_ROWS,
  buildSuggestResults,
  filterAlertGroups
} from '../src/renderer/src/features/alerts/resultSections'
import { VERIFIED_ALERT_GROUPS } from '../src/shared/alertGroups'
import type { SpellCatalogEntry } from '../src/shared/types'

/** A hand-built catalog row. `searchText` is spelled out so each case says what it tests. */
function row(over: Partial<SpellCatalogEntry> & { name: string }): SpellCatalogEntry {
  return {
    key: over.name.toLowerCase(),
    illusion: false,
    templates: { wearsOff: false, fade: false, lands: false },
    usageCount: 0,
    searchText: over.name.toLowerCase(),
    ...over
  }
}

/** Does this row survive this query? The whole matcher in one call. */
function hit(entry: SearchableSpell, query: string): boolean {
  return matchesSpellQuery(entry, tokenizeSpellQuery(query))
}

// ─────────────────────────────────────────────────────────────────────────────
// (S1) THE TOKENIZER.

test('S1 the tokenizer: five forms, whitespace-split, and what a typo degrades to', () => {
  assert.deepEqual(tokenizeSpellQuery('   '), [], 'an empty query filters nothing')
  assert.deepEqual(
    tokenizeSpellQuery('slow  level:25').map((t) => t.kind),
    ['text', 'level'],
    'runs of whitespace split once'
  )
  assert.deepEqual(tokenizeSpellQuery('level:20-30')[0], { kind: 'level', raw: 'level:20-30', lo: 20, hi: 30 })
  assert.deepEqual(
    tokenizeSpellQuery('level:30-20')[0],
    { kind: 'level', raw: 'level:30-20', lo: 20, hi: 30 },
    'a backwards range is the same range — the user meant the span'
  )
  assert.deepEqual(tokenizeSpellQuery('lvl:9')[0], { kind: 'level', raw: 'lvl:9', lo: 9, hi: 9 })
  assert.deepEqual(tokenizeSpellQuery('class:Shaman')[0], { kind: 'class', raw: 'class:Shaman', cls: 'SHM' })
  assert.deepEqual(tokenizeSpellQuery('class:shm')[0], { kind: 'class', raw: 'class:shm', cls: 'SHM' })
  assert.deepEqual(tokenizeSpellQuery('type:poison')[0], { kind: 'facet', raw: 'type:poison', facet: 'poison' })
  assert.deepEqual(tokenizeSpellQuery('25')[0], { kind: 'number', raw: '25', text: '25', n: 25 })

  // A token that names something we do not know is NULLED, not dropped: it must narrow the
  // result set to zero rather than silently widen it to everything.
  assert.deepEqual(tokenizeSpellQuery('class:jedi')[0], { kind: 'class', raw: 'class:jedi', cls: null })
  assert.deepEqual(tokenizeSpellQuery('type:slow')[0], { kind: 'facet', raw: 'type:slow', facet: null })
  // A HALF-TYPED prefix is text (the list holds still while you finish the word), and a
  // malformed level is text too — "level:abc" is nobody's level.
  assert.equal(tokenizeSpellQuery('level:')[0].kind, 'text')
  assert.equal(tokenizeSpellQuery('level:abc')[0].kind, 'text')
})

// ─────────────────────────────────────────────────────────────────────────────
// (S2) THE MATCHER.

test('S2 the matcher truth table: every form, AND-composed', () => {
  const clarity = row({
    name: 'Clarity',
    key: 'clarity',
    spellType: 'Beneficial',
    usageCount: 3,
    classLevels: [{ cls: 'ENC', level: 34 }],
    rankNames: ['Clarity', 'Clarity II'],
    searchText: 'clarity clarity ii a cool breeze slips through your mind. the cool breeze fades.'
  })

  // TEXT — name, rank name, and (the point of the redesign) the MESSAGE text.
  assert.equal(hit(clarity, 'clar'), true)
  assert.equal(hit(clarity, 'clarity ii'), true, 'a rank name is in the surface')
  assert.equal(hit(clarity, 'breeze'), true, 'found by its landing message alone')
  assert.equal(hit(clarity, 'CLARITY'), true, 'case-insensitive')
  assert.equal(hit(clarity, 'wolf'), false)

  // AND — every token must match; one miss kills the row.
  assert.equal(hit(clarity, 'breeze mind'), true)
  assert.equal(hit(clarity, 'breeze wolf'), false)

  // LEVEL, as a point and as a range.
  assert.equal(hit(clarity, 'level:34'), true)
  assert.equal(hit(clarity, 'level:33'), false)
  assert.equal(hit(clarity, 'level:30-40'), true)
  assert.equal(hit(clarity, 'level:1-33'), false)

  // CLASS, both spellings, and the unknown one.
  assert.equal(hit(clarity, 'class:enc'), true)
  assert.equal(hit(clarity, 'class:enchanter'), true)
  assert.equal(hit(clarity, 'class:shm'), false)
  assert.equal(hit(clarity, 'class:jedi'), false, 'an unknown class matches nothing')

  // TYPE facets — the five the data can answer.
  assert.equal(hit(clarity, 'type:buff'), true)
  assert.equal(hit(clarity, 'type:debuff'), false)
  assert.equal(hit(clarity, 'type:seen'), true, 'usageCount > 0')
  assert.equal(hit(row({ name: 'x' }), 'type:seen'), false)
  assert.equal(hit(clarity, 'type:illusion'), false)
  assert.equal(hit(row({ name: 'x', illusion: true }), 'type:illusion'), true)
  assert.equal(hit(clarity, 'type:nonsense'), false, 'an unknown facet matches nothing')

  // A BARE NUMBER is deliberately OR: a level, or the digits in the text.
  assert.equal(hit(clarity, '34'), true, 'matches the class level')
  assert.equal(hit(row({ name: 'Bind Sight 2', searchText: 'bind sight 2' }), '2'), true, 'matches the name')
  assert.equal(hit(clarity, '99'), false)

  // Composition across FORMS, which is what a real query looks like.
  assert.equal(hit(clarity, 'breeze class:enc level:30-40 type:buff'), true)
  assert.equal(hit(clarity, 'breeze class:enc level:1-10'), false)

  // An empty query matches everything (the unfiltered list).
  assert.equal(hit(clarity, ''), true)
})

test('S2b THE HEADLINE CASE: "slow" finds Weakening Strike by its landing emote', () => {
  // Built from the REAL DB row through the REAL builder — nothing here is hand-typed, so the
  // claim is about the shipped data, not about this test's imagination.
  const db = loadSpellDb()
  const ws = db.spells.find((s) => s.name === 'Weakening Strike')
  assert.ok(ws, 'the rogue slow Strike must still be in the spell DB')
  const entry = row({
    name: ws.name,
    spellType: ws.spellType,
    searchText: searchTextFor(ws, [ws.name])
  })

  // Its NAME contains no "slow" at all — the emote is the only reason this matches, which is
  // the whole argument for putting message text in the search surface (§1).
  assert.equal(ws.name.toLowerCase().includes('slow'), false)
  assert.equal(hit(entry, 'slow'), true, "'s limbs move slower! carries it")
  assert.equal(hit(entry, 'limbs'), true)
  assert.equal(hit(entry, 'type:poison'), true, 'a Strike is a poison by the poisons.ts roster')
  assert.equal(isPoisonSpell(entry), true)

  // And the same trick over the REAL catalog: "slow" reaches spells whose names never say it.
  const catalog = buildSpellCatalog(db, new Map())
  const named = filterSpells(catalog.entries, tokenizeSpellQuery('slow'))
  const byMessageOnly = named.filter((e) => !e.name.toLowerCase().includes('slow'))
  assert.ok(byMessageOnly.length >= 5, 'the message text is doing real work over the shipped DB')
  assert.ok(
    byMessageOnly.some((e) => e.name === 'Languid Pace'),
    'the enchanter slow is found by "You slow down." — never by its name'
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// (S3) THE CATALOG BUILD.

test('S3 every catalog row carries a lowercase searchText of name + ranks + the three messages', () => {
  const db = loadSpellDb()
  const catalog = buildSpellCatalog(db, new Map())
  assert.ok(catalog.entries.length > 1000, 'the catalog is the real one')
  // …and APOSTROPHE-FOLDED (JOS-342), which is why every `includes` here folds its needle: the
  // surface holds `aanyas animation`, not `aanya's animation`, and the query folds to meet it.
  for (const e of catalog.entries) {
    assert.equal(e.searchText, e.searchText.toLowerCase(), `${e.name}: searchText must be lowercased`)
    assert.ok(
      e.searchText.includes(foldApostrophes(e.name.toLowerCase())),
      `${e.name}: its own name must be in it`
    )
    for (const rank of e.rankNames ?? []) {
      assert.ok(
        e.searchText.includes(foldApostrophes(rank.toLowerCase())),
        `${e.name}: rank ${rank} must be in it`
      )
    }
  }

  // The three message texts, on a spell that has all three.
  const clarity = catalog.entries.find((e) => e.key === 'clarity')
  assert.ok(clarity)
  const spell = db.byKey.get('clarity')
  assert.ok(spell?.msgCastOnYou && spell.msgWearsOff)
  assert.ok(clarity.searchText.includes(foldApostrophes(spell.msgCastOnYou.toLowerCase())))
  assert.ok(clarity.searchText.includes(foldApostrophes(spell.msgWearsOff.toLowerCase())))

  // A spell the DB gives no messages at all still gets a surface — its name.
  const bare = catalog.entries.find(
    (e) => (db.byKey.get(e.key)?.msgCastOnYou ?? '') === '' && (db.byKey.get(e.key)?.msgWearsOff ?? '') === ''
  )
  if (bare) assert.ok(bare.searchText.length > 0)
})

// ─────────────────────────────────────────────────────────────────────────────
// (S4) SECTIONS + THE ROW BUDGET.

test('S4 the four spell sections partition the catalog: total, disjoint, and honestly named', () => {
  const catalog = buildSpellCatalog(loadSpellDb(), new Map())
  const grouped = groupSpellSections(catalog.entries)
  const sum = SPELL_SECTIONS.reduce((n, s) => n + grouped[s].length, 0)
  assert.equal(sum, catalog.entries.length, 'every row lands in exactly one section')
  for (const s of SPELL_SECTIONS) assert.ok(grouped[s].length > 0, `${s} is not empty in the real DB`)

  // The classifier's precedence, stated: a poison coat is Beneficial and an illusion is too,
  // and neither is usefully called "a buff".
  assert.equal(sectionFor(row({ name: 'Asp Venom', spellType: 'Beneficial' })), 'poisons')
  assert.equal(sectionFor(row({ name: 'x', illusion: true, spellType: 'Beneficial' })), 'illusions')
  assert.equal(sectionFor(row({ name: 'x', spellType: 'Detrimental' })), 'debuffs')
  assert.equal(sectionFor(row({ name: 'x', spellType: 'Beneficial' })), 'buffs')

  // The whole rogue roster is in the Poisons section, by NAME, straight from poisons.ts.
  assert.equal(grouped.poisons.length, 20, 'the 15 utility + 5 combat poisons')
})

test('S4b "From your fights" is exactly the observed rows, and MAX_ROWS caps the WHOLE dialog', () => {
  const entries: SpellCatalogEntry[] = []
  for (let i = 0; i < 150; i++) {
    entries.push(row({ name: `Seen ${i}`, key: `seen ${i}`, spellType: 'Beneficial', usageCount: 1 }))
  }
  for (let i = 0; i < 300; i++) {
    entries.push(row({ name: `Unseen ${i}`, key: `unseen ${i}`, spellType: 'Beneficial' }))
  }
  for (let i = 0; i < 40; i++) {
    entries.push(row({ name: `Bad ${i}`, key: `bad ${i}`, spellType: 'Detrimental' }))
  }

  const all = buildSuggestResults(entries, [])
  assert.equal(all.matched, 490)
  assert.equal(all.fights.total, 150, 'observed rows, and only those')
  assert.equal(all.fights.rows.length, 150)
  const shown = all.fights.rows.length + all.sections.reduce((n, s) => n + s.rows.length, 0)
  assert.equal(shown, MAX_ROWS, 'the budget is spent across sections, never per section')
  const buffs = all.sections.find((s) => s.id === 'buffs')
  assert.equal(buffs?.total, 300, 'the section still reports what it MATCHED…')
  assert.equal(buffs?.rows.length, 50, '…while mounting only what the budget allowed')
  assert.equal(all.sections.find((s) => s.id === 'debuffs')?.rows.length, 0, 'the budget ran out')

  // A COLLAPSED section mounts nothing and hands its budget on — which is what lets a user who
  // folded "From your fights" actually see the debuffs behind it.
  const folded = buildSuggestResults(entries, [], new Set(['fights', 'buffs']))
  assert.equal(folded.fights.rows.length, 0)
  assert.equal(folded.fights.total, 150, 'a folded section still says how much it is hiding')
  assert.equal(folded.sections.find((s) => s.id === 'debuffs')?.rows.length, 40)

  // And the query narrows every section at once.
  const narrowed = buildSuggestResults(entries, tokenizeSpellQuery('type:debuff'))
  assert.equal(narrowed.matched, 40)
  assert.equal(narrowed.fights.total, 0)
  assert.equal(narrowed.sections.find((s) => s.id === 'debuffs')?.total, 40)
})

test('S4c the ready-made sets answer TEXT queries and decline spell-only ones', () => {
  const all = filterAlertGroups(VERIFIED_ALERT_GROUPS, tokenizeSpellQuery(''))
  assert.equal(all.length, VERIFIED_ALERT_GROUPS.length, 'no query ⇒ every set')

  const slow = filterAlertGroups(VERIFIED_ALERT_GROUPS, tokenizeSpellQuery('slow'))
  assert.ok(
    slow.some((g) => g.title.toLowerCase().includes('slow')),
    'the rogue-slow set is reachable by typing what it is'
  )
  assert.equal(filterAlertGroups(VERIFIED_ALERT_GROUPS, tokenizeSpellQuery('zzzz')).length, 0)

  // `level:` / `class:` / `type:` are statements about SPELLS. A set that matched one by
  // accident would be a wrong answer, so the section stands down instead. `27-28` joined that
  // list when JOS-392 made a bare band a token: it is the same statement in a shorter spelling.
  for (const q of ['level:25', 'class:shm', 'type:buff', 'slow level:25', '27-28']) {
    assert.equal(filterAlertGroups(VERIFIED_ALERT_GROUPS, tokenizeSpellQuery(q)).length, 0, q)
  }

  // A BARE CLASS WORD IS NOT ONE OF THEM, and this is the case that proved it (JOS-392): the
  // shipped `You died` set quotes a line carrying the word `magician`, so a rule that read the
  // whole token as spell-only would have made a set unreachable by a word printed on it.
  const died = filterAlertGroups(VERIFIED_ALERT_GROUPS, tokenizeSpellQuery('magician'))
  assert.ok(died.length > 0, 'a class WORD still reaches a set whose own words carry it')
  assert.equal(
    filterAlertGroups(VERIFIED_ALERT_GROUPS, tokenizeSpellQuery('class:mag')).length,
    0,
    'the DECLARED spelling is a statement about spells and still stands the section down'
  )

  // THE PROPERTY BEHIND BOTH, checked over the shipped sets rather than assumed: every word a set
  // is reachable by is one this grammar reads as text or as a class word with a text half. A future
  // set quoting a bare NUMBER fails here, which is the moment to decide what its query should mean.
  for (const g of VERIFIED_ALERT_GROUPS) {
    const words = [g.title, g.subtitle, ...g.defs.map((d) => `${d.name} ${d.line}`)].join(' ').toLowerCase()
    for (const w of words.split(/[^a-z0-9]+/).filter((x) => x !== '')) {
      assert.ok(
        filterAlertGroups(VERIFIED_ALERT_GROUPS, tokenizeSpellQuery(w)).some((x) => x.id === g.id),
        `the set "${g.title}" carries the word "${w}" but is not reachable by typing it`
      )
    }
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// (S5) THE APOSTROPHE FOLD (JOS-342).
//
// The user types the possessive they SAY; the wiki spells it however the scrape found it. Both
// sides are folded through `foldApostrophes` — the surface once in main (`searchTextFor`), the
// query once per keystroke (`parseToken`) — and these say the meeting really happens, in both
// directions, over the REAL catalog rather than over a hand-built row.
//
// The fold's third consumer is guarded next door: `POISON_EMOTES` is folded too, because four of
// the ten Strike emotes carry an apostrophe and `searchText` no longer does. S2b (`isPoisonSpell`
// on Weakening Strike) and S4 (`grouped.poisons.length === 20`) fail if that half is ever missed.

/** Every name the REAL catalog reaches for this query. */
function found(entries: readonly SpellCatalogEntry[], query: string): string[] {
  return filterSpells(entries, tokenizeSpellQuery(query)).map((e) => e.name)
}

test('S5 THE REPORTED CASE: Snails Healing answers to the possessive the owner typed', () => {
  // THE REPORT (owner, 2026-08-13): the row was invisible in suggested alerts. Nothing was
  // missing — the DB and the game log both spell it apostrophe-free, and the owner typed what he
  // says. `snails healing` does not contain `snail's`, and the matcher is a substring test.
  const db = loadSpellDb()
  const spell = db.byKey.get('snails healing')
  assert.ok(spell, 'the shaman heal-over-time at 14 must still be in the DB')
  assert.equal(spell.name, 'Snails Healing', "the DB's own spelling carries no apostrophe")
  assert.equal(spell.spellType, 'Heal Over Time')

  const entries = buildSpellCatalog(db, new Map()).entries
  for (const query of [
    'snails healing', // as the DB and the game spell it
    "snail's healing", // as the owner typed it
    "snail's", // …and half-typed, which is what a live search box sees first
    'snails',
    'snail’s healing' // the curly apostrophe a phone or Word substitutes while you type
  ]) {
    assert.ok(found(entries, query).includes('Snails Healing'), `"${query}" must reach it`)
  }
})

test('S5b …and the OTHER direction: an apostrophe in the DB, omitted by the user', () => {
  // The larger population, and the one the report did not mention. Measured over the committed
  // spells.json: 167 of 1,928 names carry an apostrophe-ish character — 149 the ASCII `'`, 22 the
  // BACKTICK the wiki uses as a stand-in — 136 of them as a `'s` possessive, plus 349 message
  // fields. Every one is a string a user may reasonably type without the punctuation.
  const entries = buildSpellCatalog(loadSpellDb(), new Map()).entries
  const cases: readonly (readonly [string, string])[] = [
    ['aanyas animation', "Aanya's Animation"], // the DB's apostrophe, dropped by the user
    ["aanya's animation", "Aanya's Animation"], // …and spelled the DB's way
    ['aanya’s animation', "Aanya's Animation"], // …and with the keyboard's curly one
    ['atols spectral shackles', 'Atol`s Spectral Shackles'], // the wiki's BACKTICK possessive
    ["atol's spectral shackles", 'Atol`s Spectral Shackles'] // …reached by the apostrophe instead
  ]
  for (const [typed, want] of cases) {
    assert.ok(found(entries, typed).includes(want), `"${typed}" must reach ${want}`)
  }
})

test('S5c EXHAUSTIVE: every apostrophe-bearing row the app ships is findable BOTH ways', () => {
  // A PROPERTY, not a count — a count would rot on the next re-scrape while this holds for whatever
  // the scrape ships. The bound below only says the population is real (164 catalog lines today,
  // from the 167 DB names; the difference is rank siblings folding onto one line).
  const entries = buildSpellCatalog(loadSpellDb(), new Map()).entries
  let population = 0
  for (const e of entries) {
    if (!/['‘’ʼ`]/.test(e.name)) continue
    population += 1
    assert.equal(
      matchesSpellQuery(e, tokenizeSpellQuery(e.name)),
      true,
      `${e.name}: must be found by the name as the DB spells it`
    )
    assert.equal(
      matchesSpellQuery(e, tokenizeSpellQuery(foldApostrophes(e.name))),
      true,
      `${e.name}: must be found by the same name without the punctuation`
    )
  }
  assert.ok(population > 100, `the apostrophe population is real (${String(population)} catalog rows)`)
})

test('S5d the fold deletes, and never touches the echo the user sees', () => {
  // DELETED, not replaced by a space: `aanya's` and `aanyas` have to land on the SAME characters.
  assert.equal(foldApostrophes("aanya's"), 'aanyas')
  assert.equal(foldApostrophes('atol`s'), 'atols')
  assert.equal(foldApostrophes('aanya’s ‘x’ ʼy'), 'aanyas x y')
  // The acute accent is a diacritic, not punctuation, and is deliberately outside the class.
  assert.equal(foldApostrophes('café ´'), 'café ´')

  // `raw` is what the UI echoes back as a chip. A search box that silently re-spelled somebody's
  // query would be lying about what it searched for.
  const [token] = tokenizeSpellQuery("snail's")
  assert.deepEqual(token, { kind: 'text', raw: "snail's", text: 'snails' })
})

// ─────────────────────────────────────────────────────────────────────────────
// (S6) THE ORDER-FREE BARE GRAMMAR (JOS-392).
//
// The owner's ask was `27-28 cleric shaman`, typed however it comes out of your head. These are the
// pins the ticket named, plus the two things the widening had to be careful about: a two-word class
// name arriving as two tokens, and a class WORD that is also a word inside spell names.

/** A spell placed for several classes at several levels — the shape the scoping rule is about. */
const CROSS_CLASS = row({
  name: 'Superior Healing',
  key: 'superior healing',
  spellType: 'Beneficial',
  classLevels: [
    { cls: 'CLR', level: 27 },
    { cls: 'SHM', level: 34 },
    { cls: 'PAL', level: 45 }
  ],
  searchText: 'superior healing you feel much better.'
})

test('S6 the bare tokens: a class word, a band, and the two-word join', () => {
  assert.deepEqual(tokenizeSpellQuery('cleric')[0], { kind: 'class', raw: 'cleric', cls: 'CLR', text: 'cleric' })
  assert.deepEqual(tokenizeSpellQuery('clr')[0], { kind: 'class', raw: 'clr', cls: 'CLR', text: 'clr' })
  assert.deepEqual(tokenizeSpellQuery('27-28')[0], { kind: 'level', raw: '27-28', lo: 27, hi: 28 })
  // The en dash a phone substitutes, and the `..` half the tools beside the game use.
  assert.deepEqual(tokenizeSpellQuery('27–28')[0], { kind: 'level', raw: '27–28', lo: 27, hi: 28 })
  assert.deepEqual(tokenizeSpellQuery('27..28')[0], { kind: 'level', raw: '27..28', lo: 27, hi: 28 })
  // A bare number is NOT a range and keeps its old meaning: a level or the digits in the text.
  assert.equal(tokenizeSpellQuery('27')[0].kind, 'number')

  // TWO WORDS, ONE CLASS — joined only because the PAIR names a class and neither half does.
  assert.deepEqual(tokenizeSpellQuery('shadow knight')[0], {
    kind: 'class',
    raw: 'shadow knight',
    cls: 'SHD',
    text: 'shadow knight'
  })
  assert.deepEqual(tokenizeSpellQuery('beast lord').map((t) => t.kind), ['class'])
  // …and the join is never greedy: two class words in a row stay two tokens, and two text words
  // that do not name a class together stay two text tokens.
  assert.deepEqual(tokenizeSpellQuery('clr shm').map((t) => t.kind), ['class', 'class'])
  assert.deepEqual(tokenizeSpellQuery('shadow step').map((t) => t.kind), ['text', 'text'])
})

test('S6b ORDER-FREE, AND-across-kinds, OR-within: the owner query and its permutations', () => {
  // THE ASK: cleric OR shaman, at 27..28. Superior Healing is CLR 27, so it is in.
  assert.equal(hit(CROSS_CLASS, '27-28 cleric shaman'), true)
  assert.equal(hit(CROSS_CLASS, 'shaman 27-28 cleric'), true, 'order changes nothing')
  assert.equal(hit(CROSS_CLASS, 'cleric shaman 27-28'), true)

  // THE LEVEL IS SCOPED TO THE CLASSES. `shaman 27-28` asks what a SHAMAN gets at 27..28 — and the
  // shaman gets this at 34, so it is out even though a cleric gets it inside the band.
  assert.equal(hit(CROSS_CLASS, 'shaman 27-28'), false)
  assert.equal(hit(CROSS_CLASS, 'shaman 30-40'), true)
  // Without a class, the band asks about anybody.
  assert.equal(hit(CROSS_CLASS, '27-28'), true)
  assert.equal(hit(CROSS_CLASS, '46-50'), false)

  // A BARE NUMBER is scoped the same way, and keeps its text half.
  assert.equal(hit(CROSS_CLASS, 'cleric 27'), true)
  assert.equal(hit(CROSS_CLASS, 'cleric 34'), false, 'the SHAMAN gets it at 34, not the cleric')
  assert.equal(hit(CROSS_CLASS, 'shaman 34'), true)

  // TEXT AND CLASS COMPOSE (`heal 20-25` is the ticket's own pin, said here on this row).
  assert.equal(hit(CROSS_CLASS, 'heal 20-30'), true)
  assert.equal(hit(CROSS_CLASS, 'heal 46-50'), false)
  assert.equal(hit(CROSS_CLASS, 'wolf cleric'), false)

  // The old prefixed spellings keep working, and mix freely with the bare ones.
  assert.equal(hit(CROSS_CLASS, 'class:clr 27-28'), true)
  assert.equal(hit(CROSS_CLASS, 'cleric level:27'), true)
  assert.equal(hit(CROSS_CLASS, 'cleric type:buff'), true)
  assert.equal(hit(CROSS_CLASS, 'cleric type:debuff'), false)
})

test('S6c a bare class word KEEPS ITS TEXT HALF, which is what keeps names findable', () => {
  // THE AMBIGUITY THE WIDENING CREATES, and the resolution. `war` is a class code AND a word inside
  // real spell names; a rule reading it as ONLY a facet would make this row unreachable by the name
  // printed on it — and WAR has no spells at all, so it would be unreachable full stop.
  const drums = row({ name: 'Drums of War', key: 'drums of war', searchText: 'drums of war' })
  assert.equal(hit(drums, 'drums of war'), true, 'a spell is always findable by its own name')
  assert.equal(hit(drums, 'war'), true)
  // …and the narrow spelling is still there for a user who means the class and only the class.
  assert.equal(hit(drums, 'class:war'), false)
  // The text half never widens a query that a class ALSO satisfies: a cleric spell whose words do
  // not say "cleric" is still in, and a row that is neither is still out.
  assert.equal(hit(CROSS_CLASS, 'cleric'), true)
  assert.equal(hit(drums, 'cleric'), false)
  // An unknown CLASS is still zero — the prefix is a declaration, and a typo must not widen.
  assert.equal(hit(CROSS_CLASS, 'class:jedi'), false)
})

test('S6d the REAL catalog answers the owner query, and every hit is a cleric or shaman at 27-28', () => {
  const entries = buildSpellCatalog(loadSpellDb(), new Map()).entries
  const hits = filterSpells(entries, tokenizeSpellQuery('27-28 cleric shaman'))
  assert.ok(hits.length > 5, `the shipped catalog answers the owner query (${String(hits.length)} rows)`)
  for (const e of hits) {
    const ok = (e.classLevels ?? []).some(
      (c) => (c.cls === 'CLR' || c.cls === 'SHM') && c.level >= 27 && c.level <= 28
    )
    assert.ok(ok, `${e.name}: every row must be a CLR/SHM row inside the band`)
  }
  // The permutation returns the same set — order-free means order-free over the real data too.
  const flipped = filterSpells(entries, tokenizeSpellQuery('shaman 27-28 cleric')).map((e) => e.name)
  assert.deepEqual(hits.map((e) => e.name), flipped)

  // A NAME still finds its spell, with no class or level said at all.
  assert.ok(
    filterSpells(entries, tokenizeSpellQuery('Complete Heal')).some((e) => e.name === 'Complete Heal'),
    'a spell name is still a spell name'
  )
  // `shadow knight 30-32`, the two-word pin, over the shipped rows.
  for (const e of filterSpells(entries, tokenizeSpellQuery('shadow knight 30-32'))) {
    assert.ok(
      (e.classLevels ?? []).some((c) => c.cls === 'SHD' && c.level >= 30 && c.level <= 32),
      `${e.name}: a two-word class name must scope like a one-word one`
    )
  }
})
