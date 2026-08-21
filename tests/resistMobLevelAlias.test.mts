// THE FOLD ASKS THE CATALOG UNDER EVERY SPELLING THE ROSTER STATES (JOS-422).
//
// The owner's own bug, reported 2026-08-19: conning `Innoruuk, the Prince of Hate` showed NO resist
// data on any axis after three weeks of fights — 17 kills, and one afternoon where his poison went
// 8-for-8 hard-resisted, the game screaming poison-immune while the card read "no data".
//
// The mechanism, replay-proven against his real ledger: `MobLevels.levelOf` asked the committed
// catalog with the LOG's spelling and nothing else. The catalog carries `Innoruuk` (level 60); the
// log prints `Innoruuk, the Prince of Hate`. So every row folded `mobLevel: null`, `rowTerm` drops
// a levelless row for want of a `levelMod`, and n=0 renders "no data" — with ~672 of his own
// observations dark. `mobAliases.ts` already stated the two spellings are one creature, and the
// READ side already used it (`ipc/resist.ts rowsForIdentity`); only the fold did not.
//
// These are unit claims about the level ladder, not a golden window: no committed fixture contains
// a Plane of Hate pull, and the two line shapes driven below (a `/con` and a `resisted your` line)
// are the ones the r1 fixture prints verbatim for other mobs, with the god's name in the mob's
// place — the same "inject the one sentence this log lacks" rule the repo already uses.

import test from 'node:test'
import assert from 'node:assert/strict'
import { MobLevels } from '../src/main/resist/world'
import { ResistFold } from '../src/main/resist/fold'
import { parseEvent } from '../src/main/log/parser'
import { installCharacterName, installSpellDb } from '../src/main/log/rulesets'
import { loadSpellDb } from '../src/main/data/spellDb'
import { mobKey } from '../src/shared/mobKey'

/** The roster spelling (the catalog's and the wiki's) and the one every log line uses. */
const CANON = 'Innoruuk'
const LOGGED = 'Innoruuk, the Prince of Hate'

test('A MOB THE CATALOG ONLY KNOWS BY ITS OTHER NAME STILL GETS ITS LEVEL', () => {
  const levels = new MobLevels()
  const fact = levels.levelOf(mobKey(LOGGED), LOGGED)
  // 60, off page `Innoruuk (God)`. Before JOS-422 this was null and every row it stamped was dropped
  // by the estimator.
  assert.deepEqual(fact, { level: 60, lo: 60, hi: 60, from: 'catalog' })
  // …and the canonical spelling is unchanged, which is the point of resolving rather than renaming.
  assert.deepEqual(levels.levelOf(mobKey(CANON), CANON), fact)
})

test('THE BYTE-IDENTICAL HALF: a name the roster never heard of is answered exactly as before', () => {
  const levels = new MobLevels()
  // A catalog hit under its own name still reads its own range, midpoint and all.
  assert.deepEqual(levels.levelOf('a kodiak', 'a kodiak'), {
    level: 15,
    lo: 14,
    hi: 15,
    from: 'catalog',
  })
  // And a name neither the catalog nor the roster carries says nothing rather than guessing
  // (world-model law 1). The negative is cached, so this also proves the cache is not poisoned.
  assert.equal(levels.levelOf('a nonexistent gribbly', 'a nonexistent gribbly'), null)
  assert.equal(levels.levelOf('a nonexistent gribbly', 'a nonexistent gribbly'), null)
})

test('A /con UNDER EITHER SPELLING COVERS BOTH', () => {
  const conned = new MobLevels()
  conned.note(mobKey(CANON), 58)
  // The game just said it, so it beats the catalog — under the name the log will spell it with.
  assert.deepEqual(conned.levelOf(mobKey(LOGGED), LOGGED), {
    level: 58,
    lo: 58,
    hi: 58,
    from: 'con',
  })

  const other = new MobLevels()
  other.note(mobKey(LOGGED), 58)
  assert.equal(other.levelOf(mobKey(CANON), CANON)?.from, 'con')

  // A con of a DIFFERENT creature never reaches this one, alias table or not.
  const stray = new MobLevels()
  stray.note(mobKey('Innoruuk Puppet'), 12)
  assert.equal(stray.levelOf(mobKey(LOGGED), LOGGED)?.level, 60)

  // reset() drops the session's cons and leaves the catalog standing.
  conned.reset()
  assert.equal(conned.levelOf(mobKey(LOGGED), LOGGED)?.from, 'catalog')
})

test('AND THE ROW THE FOLD FILES CARRIES IT — the owner’s three dark weeks, in one pull', () => {
  const db = loadSpellDb()
  installSpellDb(db)
  installCharacterName('Primitive')
  const fold = new ResistFold({ spellDb: db })
  fold.beginSource()
  let seq = 0
  for (const line of [
    '[Tue Aug 11 21:14:02 2026] You have entered Plane of Hate.',
    '[Tue Aug 11 21:14:39 2026] Innoruuk, the Prince of Hate resisted your Chaotic Feedback!',
    '[Tue Aug 11 21:14:47 2026] Innoruuk, the Prince of Hate resisted your Chaotic Feedback!',
  ]) {
    const ev = parseEvent(line, seq++)
    if (ev) fold.onEvent(ev)
  }
  fold.finish()
  const row = fold.rows().find((r) => r.spellKey === 'chaotic feedback')
  assert.ok(row, 'two resist lines are two observations of one (mob, spell)')
  assert.equal(row.mobKey, 'innoruuk, the prince of hate')
  assert.equal(row.resist, 2)
  // THE CLAIM. Null here is the shipped bug: a levelless row is dropped by `rowTerm` and counted
  // as `droppedNoLevel`, which is how a card with hundreds of observations behind it read "no data".
  assert.equal(row.mobLevel, 60)
})
