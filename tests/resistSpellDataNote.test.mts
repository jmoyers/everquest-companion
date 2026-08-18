// "Spell data unavailable" now says WHICH failure it is (JOS-385).
//
// THE DEFECT, in the owner's own words: he restarted the dev build, the Resists card said
// "Spell data unavailable - this needs your EverQuest install's spells_us.txt", and the file was
// exactly where it has always been. One sentence was standing in for two unrelated problems, and
// the one it described was not the one he had.
//
//   'missing'    — nothing at the resolved path. The player's problem, and the PATH is the fix, so
//                  the sentence names the folder that was looked in.
//   'unloadable' — the file is there and no table came back (a worker that failed to start, a
//                  parse error, a cache that came back malformed). OUR problem, and the sentence
//                  says so and points at the error log instead of at the install.
//
// The sentence is built in `src/main/resist/profile.ts` rather than in each surface, because only
// main knows the resolved path and both the mob page and the con card have to say the same thing.
// That module is Electron-free (it takes the status as a dependency), so a node test can read it.

import test from 'node:test'
import assert from 'node:assert/strict'
import { spellDataNote } from '../src/main/resist/profile'

const PATH = 'C:/Games/EverQuest Legends/spells_us.txt'

test('an AVAILABLE table has nothing to say, and says nothing', () => {
  assert.equal(spellDataNote({ state: 'ok', path: PATH }), null)
})

test('MISSING names the path it looked at, and points at the setting that changes it', () => {
  const note = spellDataNote({ state: 'missing', path: PATH })
  assert.ok(note)
  assert.ok(note.includes(PATH), 'the folder the app is actually looking in is the whole fix')
  assert.match(note, /Preferences/, 'and where to change it')
  // It may only blame the install in the case where the install IS the answer.
  assert.match(note, /no spells_us\.txt/)
})

test('UNLOADABLE blames US, not the player, and points at the error log', () => {
  const note = spellDataNote({ state: 'unloadable', path: PATH })
  assert.ok(note)
  assert.match(note, /found but could not be loaded/)
  assert.match(note, /error log/)
  // THE REGRESSION THIS PINS. The old sentence told a player with a perfectly good install to go
  // find their EverQuest folder; this state must never do that again.
  assert.doesNotMatch(note, /Preferences|EverQuest folder/)
  assert.ok(!note.includes(PATH), 'a path is advice, and there is nothing wrong with this one')
})

test('the two states are DIFFERENT sentences, which is the entire ticket item', () => {
  assert.notEqual(
    spellDataNote({ state: 'missing', path: PATH }),
    spellDataNote({ state: 'unloadable', path: PATH })
  )
})

test('and while it is still LOADING the card says that instead of accusing anybody', () => {
  // The table is read on a worker the first time a profile is asked for (JOS-371), so "not yet" is
  // a real state with its own sentence rather than a failure to be reported as one.
  const note = spellDataNote({ state: 'loading', path: PATH })
  assert.ok(note)
  assert.doesNotMatch(note, /unavailable|could not/)
})

test('every sentence obeys the copy rules', () => {
  for (const state of ['missing', 'unloadable', 'loading'] as const) {
    const note = spellDataNote({ state, path: PATH }) ?? ''
    assert.ok(!note.includes('—'), 'no em dashes in copy')
    assert.doesNotMatch(note, /\bIPC\b|worker|cache|null/, 'no bookkeeping of ours in a player’s sentence')
  }
})
