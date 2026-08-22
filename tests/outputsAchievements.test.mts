// ============================================================================
// THE `/outputfile achievements` KIND (JOS-429) — the format, characterized, then pinned.
// ============================================================================
//
// The fixture `tests/fixtures/Primitive_freeport-Achievements.txt` is the owner's REAL dump,
// exported on 2026-08-20 and committed verbatim (1,884 lines, 64,539 bytes). It contains
// achievement names, requirement sentences and a one-letter status per row — no chat, no
// third-party anything — so the scrub law has nothing to drop here, exactly as with the inventory
// dump beside it. The file IS the evidence, and trimming it would weaken every count below.
//
// THE NUMBERS IN THIS FILE WERE MEASURED BEFORE THE PARSER EXISTED (the ticket's investigation-first
// directive, and the awaiting-sample law's actual procedure): read the real file, write the shape
// down, THEN write the reader. shared/outputs/achievements.ts's header carries the characterization
// in prose; this is the same characterization as assertions, so a client that changes the format
// fails here rather than quietly parsing to nothing.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CLASS_UNLOCK_CATEGORY,
  CLASS_UNLOCK_PREFIX,
  classUnlockClaims,
  parseAchievementsDump
} from '../src/shared/outputs/achievements'
import { OUTPUT_KINDS, isOutputFileName, outputKind, parseOutput } from '../src/main/outputs/kinds'

const FIXTURES = join(import.meta.dirname, 'fixtures')
const REAL = readFileSync(join(FIXTURES, 'Primitive_freeport-Achievements.txt'), 'utf8')

// ---------------------------------------------------------------------------
// THE FILE ITSELF — the raw facts the header claims, asserted against the bytes.
// ---------------------------------------------------------------------------

test('the real dump is CRLF ASCII with no BOM', () => {
  assert.equal(REAL.startsWith('﻿'), false, 'no BOM')
  assert.equal((REAL.match(/\r\n/g) ?? []).length, 1884, 'CRLF-terminated lines')
  assert.equal((REAL.match(/(?<!\r)\n/g) ?? []).length, 0, 'no bare LF anywhere')
  // eslint-disable-next-line no-control-regex -- asserting the ASCII range IS the claim here.
  assert.equal(/[^\u0000-~]/.test(REAL), false, 'pure ASCII')
})

test('every row is C or I, and the indent columns are empty', () => {
  const statuses = new Set<string>()
  let components = 0
  for (const line of REAL.split('\r\n')) {
    if (line === '') continue
    const f = line.split('\t')
    if (f.length === 1) continue
    statuses.add(f[0])
    assert.ok(f.length <= 4, `no row is deeper than 4 fields: ${line}`)
    if (f.length >= 3) {
      components++
      assert.equal(f[1], '', `the indent column is empty: ${line}`)
      assert.notEqual(f[2], '', `the name column is not: ${line}`)
    }
    if (f.length === 4) assert.match(f[3], /^\d+\/\d+$/, `the counter column: ${line}`)
  }
  assert.deepEqual([...statuses].sort(), ['C', 'I'], 'only two status values exist')
  assert.equal(components, 1357, 'component rows')
})

// ---------------------------------------------------------------------------
// THE PARSER over the real file.
// ---------------------------------------------------------------------------

const DUMP = parseAchievementsDump(REAL)

test('the parser reads every row of the real dump', () => {
  // 501 achievements + 1,357 components = 1,858 rows; the other 26 lines are category headers.
  assert.equal(DUMP.rows.length, 1858)
  assert.equal(DUMP.rows.filter((r) => r.component === undefined).length, 501, 'achievements')
  assert.equal(DUMP.rows.filter((r) => r.component !== undefined).length, 1357, 'components')
  assert.equal(DUMP.rows.filter((r) => r.status === 'complete').length, 520, 'C rows')
  assert.equal(DUMP.rows.filter((r) => r.status === 'incomplete').length, 1338, 'I rows')
  assert.equal(new Set(DUMP.rows.map((r) => r.category)).size, 26, 'categories')
})

test('the counter column is carried verbatim, and only where the file has one', () => {
  const withProgress = DUMP.rows.filter((r) => r.progress !== undefined)
  assert.equal(withProgress.length, 106)
  assert.deepEqual(
    [...new Set(withProgress.map((r) => r.category))].sort(),
    ['Slayer: Conquest', 'Slayer: Skill', 'Slayer: Special'],
    'only the Slayer categories carry a counter'
  )
  const gnolls = DUMP.rows.find((r) => r.component === 'Gnolls')
  assert.equal(gnolls?.progress, '2/5000')
})

test('the tree is resolved onto each row', () => {
  const first = DUMP.rows[0]
  assert.deepEqual(first, {
    category: 'Untapped Potential: Races',
    achievement: 'Race Unlock - Barbarian',
    status: 'incomplete'
  })
  const second = DUMP.rows[1]
  assert.equal(second.category, 'Untapped Potential: Races')
  assert.equal(second.achievement, 'Race Unlock - Barbarian')
  assert.equal(second.component, 'Get maximum faction with Rogues of the White Rose.')
})

test('a malformed line is dropped, never half-read', () => {
  const dump = parseAchievementsDump(
    [
      'A Category',
      'X\tbogus status',
      'C\tGood Achievement',
      'C\t\tGood Component',
      'C\tnot empty\tbad indent',
      'C\t\t\t\t\ttoo deep',
      'C\t\t', // empty name
      'C\t' // empty achievement name
    ].join('\r\n')
  )
  assert.deepEqual(dump.rows, [
    { category: 'A Category', achievement: 'Good Achievement', status: 'complete' },
    {
      category: 'A Category',
      achievement: 'Good Achievement',
      component: 'Good Component',
      status: 'complete'
    }
  ])
})

test('a component before any achievement has no parent, so it is dropped', () => {
  const dump = parseAchievementsDump(['A Category', 'C\t\tOrphan'].join('\r\n'))
  assert.deepEqual(dump.rows, [])
})

test('LF-only text still reads (a dump through a text tool keeps working)', () => {
  const lf = parseAchievementsDump(REAL.replace(/\r\n/g, '\n'))
  assert.deepEqual(lf.rows, DUMP.rows)
})

// ---------------------------------------------------------------------------
// THE SKY PROJECTION — the only thing that leaves the module.
// ---------------------------------------------------------------------------

const CLAIMS = classUnlockClaims(DUMP)

test('the class-unlock category holds one Obtain row per Sky quest', () => {
  const obtain = DUMP.rows.filter(
    (r) => r.category === CLASS_UNLOCK_CATEGORY && r.component?.startsWith('Obtain ') === true
  )
  // The join's whole basis: 95 Obtain rows, and the Sky quest set is 95 quests
  // (tests/achievementInference.test.mts pins the other side of that equality).
  assert.equal(obtain.length, 95)
  assert.equal(
    DUMP.rows.filter(
      (r) => r.category === CLASS_UNLOCK_CATEGORY && r.component === undefined
    ).length,
    16,
    'sixteen classes'
  )
  for (const r of obtain) assert.ok(r.achievement.startsWith(CLASS_UNLOCK_PREFIX))
})

test('the owner’s dump vouches for the rewards it marks C, and only those', () => {
  assert.equal(CLAIMS.length, 48, 'earned class-unlock rewards on the owner’s real dump')
  assert.ok(
    CLAIMS.some((c) => c.className === 'Bard' && c.item === 'Mask of Song'),
    'trailing period stripped'
  )
  assert.ok(
    CLAIMS.some((c) => c.className === 'Berserker' && c.item === 'Molten Coil'),
    'a row with no trailing period reads the same'
  )
  assert.ok(
    CLAIMS.some((c) => c.className === 'Shadowknight'),
    'the class name is the GAME’s spelling, kept verbatim'
  )
  // One-directional: nothing the player has NOT obtained is in the record at all.
  assert.equal(
    CLAIMS.some((c) => c.item === 'Skycleaver'),
    false,
    'an I row is not a claim'
  )
})

test('the boilerplate components are never claims, but they decide the grant (JOS-441)', () => {
  // Every class-unlock achievement carries two sentences that are not Obtain rows, and on a real
  // dump they can be COMPLETE: the owner is a Paladin, so that achievement's "will autocomplete if
  // you chose to confirm your Primary Class as a Paladin" row is C. It credits no quest.
  const paladin = DUMP.rows.filter((r) => r.achievement === 'Primary Class Unlock - Paladin')
  const autocomplete = paladin.find((r) => r.component?.startsWith('This achievement will') === true)
  assert.equal(autocomplete?.status, 'complete', 'the autocomplete row is C for the class we play')
  assert.equal(
    paladin.filter((r) => r.component?.startsWith('Obtain ') === true).length,
    4,
    'four Sky quests'
  )
  assert.equal(
    CLAIMS.filter((c) => c.className === 'Paladin').length,
    4,
    'four claims — the boilerplate C row added none'
  )
  assert.equal(
    CLAIMS.some((c) => c.item.startsWith('This achievement')),
    false
  )
  // What it DOES add, since JOS-441: the `grant` every claim of that class then carries. The row is
  // not a claim and never was; it is the file's own statement of which question the claims answer.
  assert.deepEqual(
    [...new Set(CLAIMS.filter((c) => c.className === 'Paladin').map((c) => c.grant))],
    ['confirm']
  )
})

test('the ACHIEVEMENT row’s own status is never read', () => {
  // The trap this rules out: `Primary Class Unlock - Paladin` is C while its "can be bypassed
  // using a Primary Class Unlock Token" component is I — the achievement completed by a route that
  // has nothing to do with the quests. Reading the parent would credit every quest of that class.
  const paladin = DUMP.rows.find(
    (r) => r.achievement === 'Primary Class Unlock - Paladin' && r.component === undefined
  )
  assert.equal(paladin?.status, 'complete')
  const bypass = DUMP.rows.find(
    (r) =>
      r.achievement === 'Primary Class Unlock - Paladin' &&
      r.component?.startsWith('This achievement can be bypassed') === true
  )
  assert.equal(bypass?.status, 'incomplete', 'a C parent over an I child — the parent proves nothing')
  // And the reader agrees where it costs something: sixteen achievements, three of them C
  // (Races/Classes/Deity each have one), and the claim count is decided entirely by components.
  const completeParents = DUMP.rows.filter(
    (r) => r.category === CLASS_UNLOCK_CATEGORY && r.component === undefined && r.status === 'complete'
  )
  assert.equal(completeParents.length, 1, 'exactly one class-unlock achievement is complete')
  assert.ok(CLAIMS.length > 4, 'yet claims come from fifteen other classes too')
})

test('a dump with nothing to say about Sky changes nothing', () => {
  const dump = parseAchievementsDump(
    ['EverQuest: Raids', 'C\tConqueror of Kedge Keep', 'C\t\tPhinigel Autropos'].join('\r\n')
  )
  assert.equal(dump.rows.length, 2, 'it still parses')
  assert.deepEqual(classUnlockClaims(dump), [], 'and vouches for nothing')
})

// ---------------------------------------------------------------------------
// THE REGISTRY — the kind has graduated, and the graduation is what makes it parse.
// ---------------------------------------------------------------------------

test('the achievements kind is supported, with a verified filename suffix', () => {
  const def = outputKind('achievements')
  assert.equal(def.status, 'supported')
  assert.equal(def.fileKindVerified, true, 'measured: Primitive_freeport-Achievements.txt')
  assert.equal(def.command, '/outputfile achievements')
  assert.ok(isOutputFileName(def, 'Primitive_freeport-Achievements.txt'))
  assert.ok(isOutputFileName(def, 'primitive_freeport-achievements.txt'), 'case-insensitive')
  assert.equal(isOutputFileName(def, 'Primitive_freeport-Inventory.txt'), false)
})

test('parseOutput routes the achievements kind to the real parser', () => {
  const res = parseOutput('achievements', REAL)
  assert.equal(res.ok, true)
  assert.ok(res.ok && res.data.kind === 'achievements')
  assert.equal(res.ok && res.data.kind === 'achievements' && res.data.dump.rows.length, 1858)
})

test('the kinds that have NOT graduated still refuse in a typed way', () => {
  const waiting = OUTPUT_KINDS.filter((k) => k.status === 'awaiting-sample')
  assert.equal(waiting.length, 5, 'inventory and achievements are the graduated pair')
  for (const def of waiting) {
    assert.equal(def.fileKindVerified, false, `${def.id} has no observed file`)
    const res = parseOutput(def.id, 'anything at all')
    assert.equal(res.ok, false)
    assert.equal(res.ok === false && res.reason, 'unsupported')
  }
})
