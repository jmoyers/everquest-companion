// WHEN A SERVED CHARACTER LIST IS AN ANSWER (JOS-498, owner ruling 21 / decision sheet 1a).
//
// `src/main/dataServer/logsRows.ts` is the whole of what `serveLogs.ts` DECIDES about a `logs.list`
// reply, split out so it can be driven with no socket, no Electron and no Rust binary — the same
// split `readShim.ts` keeps from `serveShim.ts`, for the same reason: the awkward cases are the
// point, and they are impossible to stage against a real engine.
//
// WHAT THE AWKWARD CASES ARE. A reply that passed the protocol's own result guard can still not be
// an ANSWER: the engine may be enumerating the folder the app has just been pointed away from, or it
// may be reporting that the directory refused IT. Both take the fallback path — which for THIS
// channel is a real answer rather than an empty shape, because `listCharacters()` survived the
// deletion release precisely so launch-time character choice works before any engine exists.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { projectCharacterList } from '../src/main/dataServer/logsRows'
import type { LogsListResult } from '../src/shared/dataServer/protocol.generated'

const DIR = 'C:\\EverQuest Legends\\Logs'

function reply(over: Partial<LogsListResult> = {}): LogsListResult {
  return {
    dir: DIR,
    readable: 'ok',
    characters: [
      {
        name: 'Primitive',
        server: 'freeport',
        logPath: `${DIR}\\eqlog_Primitive_freeport.txt`,
        lastPlayed: 1_787_181_707_000
      }
    ],
    ...over
  }
}

test('a served list becomes the app’s own CharacterRef, field for field', () => {
  const rows = projectCharacterList(DIR, reply())
  assert.deepEqual(rows, [
    {
      name: 'Primitive',
      server: 'freeport',
      logPath: `${DIR}\\eqlog_Primitive_freeport.txt`,
      lastPlayed: 1_787_181_707_000
    }
  ])
})

test('ABSENT lastPlayed STAYS ABSENT — the key is not even present, let alone zero', () => {
  // The engine omits it when it could not stat the file, and `CharacterRef` makes it optional for
  // the identical reason: a zero would draw "last played 1970" beside a real character name. Writing
  // `lastPlayed: undefined` would be worse than either, because `'lastPlayed' in ref` is a question
  // a later reader may reasonably ask.
  const rows = projectCharacterList(
    DIR,
    reply({
      characters: [
        { name: 'Ghost', server: 'freeport', logPath: `${DIR}\\eqlog_Ghost_freeport.txt` }
      ]
    })
  )
  assert.ok(rows)
  assert.equal('lastPlayed' in rows[0], false)
  assert.deepEqual(Object.keys(rows[0]).sort(), ['logPath', 'name', 'server'])
})

test('THE DIRECTORY ECHO IS THE STALENESS TEST — another install’s answer is not an answer', () => {
  // `logs.setDir` is asynchronous and so is this query, so there is a window in which the engine is
  // still enumerating the folder the app has just been pointed AWAY from. Its reply would be a
  // picker full of another install's characters, and it would look perfect.
  assert.equal(projectCharacterList('D:\\Second Install\\Logs', reply()), null)
  // Compared EXACTLY. Both ends come from the same `eqLogsDir()` call in the same process, so any
  // difference at all is one that matters — a tolerant compare would be this function deciding two
  // paths are the same install without being able to know it.
  assert.equal(projectCharacterList(DIR.toLowerCase(), reply()), null)
})

test('A MISSING FOLDER IS AN ANSWER, and so is an install nobody has typed /log on in', () => {
  // Two silences that are NOT fallbacks. There is no such folder, so there are no characters and the
  // app's own read would say the identical thing one syscall later; and `ok` with no rows is the
  // install whose empty picker is the CORRECT picker, the one the empty state's advice hangs on.
  assert.deepEqual(projectCharacterList(DIR, reply({ readable: 'missing', characters: [] })), [])
  assert.deepEqual(projectCharacterList(DIR, reply({ characters: [] })), [])
})

test('AN UNREADABLE FOLDER IS NOT AN ANSWER — this process looks for itself', () => {
  // The engine reporting that the directory refused IT: a permission, a share violation, a
  // disconnected mount. None of those is necessarily true of this process a moment later, so the
  // honest response is the app's own read rather than an empty picker over a folder that may be
  // perfectly readable from here. This is the one verdict that falls back, and the two above are why
  // it cannot simply be "anything that is not ok".
  assert.equal(projectCharacterList(DIR, reply({ readable: 'unreadable', characters: [] })), null)
})

test('the served ORDER is passed through untouched — the engine sorted it', () => {
  // Most-recently-written first is the ENGINE's rule now (`engined/src/logs.rs`), and TitleBar's
  // "Characters - most recently played" subheader is what states it to a person. A projection that
  // re-sorted would be the app deciding it knew better about mtimes it never read — and would put a
  // second opinion between two implementations that have to agree.
  const rows = projectCharacterList(
    DIR,
    reply({
      characters: [
        { name: 'Newest', server: 'freeport', logPath: 'c', lastPlayed: 3 },
        { name: 'Middle', server: 'freeport', logPath: 'b', lastPlayed: 2 },
        { name: 'Oldest', server: 'freeport', logPath: 'a', lastPlayed: 1 }
      ]
    })
  )
  assert.deepEqual(rows?.map((c) => c.name), ['Newest', 'Middle', 'Oldest'])
})
