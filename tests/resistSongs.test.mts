// BARD SONG PULSES: the reconstruction, and the four rules it obeys (JOS-382).
//
// TWO HALVES, and the split is the point.
//
// THE FIXTURE HALF comes first, because it is what shipped wrong. `r2-song-pulses.log` is six
// consecutive SYMPHONIC AURA pulses out of the owner's log, and there is no cast line in it at
// all: on EQ Legends a bard's songs re-pulse every six seconds by themselves, so the first cut of
// this feature — which decided "is this a song" from `You begin singing` — flagged nothing, joined
// no landing emote to anything, and filed 400 Largo's resists with ZERO landings beside them. A
// spell that is 100% resisted by construction drags magic toward "nearly immune" on every mob a
// bard ever sang at. These tests assert the exact land and resist counts per mob, so that cannot
// come back.
//
// THE RULES HALF drives `SongPulses` directly, and HAS to: those rules are the fallback for a song
// with no usable landing sentence, and the owner's log has no window that exercises interpolation
// (five `You begin singing` lines in two million, all one song, one twenty-second window, no
// resist or landing near them). Inventing one would be authoring a shape no log has printed, so
// what is asserted is the RULES, in the units the rules are stated in.
//
// The bias direction is what makes the rules safe, and it is asserted too: nothing is extrapolated
// past the edges of a run, and a restart inside a gap forfeits the interpolation before it. Both
// under-count, which biases R upward - toward "more resistant", the direction whose cost is being
// told to use a different spell rather than being told a hard mob is easy.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SONG_PULSE_MS,
  SONG_RUN_GAP_MS,
  SongPulses,
  type SongPulse
} from '../src/main/resist/songs'
import { isSongSpell, resolveSongEmote } from '../src/main/resist/songIdentity'
import { parseEvent } from '../src/main/log/parser'
import { installCharacterName, installSpellDb } from '../src/main/log/rulesets'
import { applyOverlayCorrections, loadSpellDb } from '../src/main/data/spellDb'
import { BASELINE_SOURCE, MessageOverlayMiner } from '../src/main/data/messageOverlay'
import baselineJson from '../src/main/data/messageOverlay.baseline.json'
import type { MessageOverlay } from '../src/shared/buffTypes'
import { ResistFold } from '../src/main/resist/fold'
import type { ResistRow } from '../src/shared/resistTypes'

/** The app's own effective catalog: the wiki rows plus the overlay's learned landing corrections. */
function appSpellDb(): ReturnType<typeof loadSpellDb> {
  const db = loadSpellDb()
  const miner = new MessageOverlayMiner(db.byKey)
  miner.merge((baselineJson as unknown as MessageOverlay).counts, BASELINE_SOURCE)
  applyOverlayCorrections(db, miner.deriveLandingCorrections())
  installSpellDb(db)
  installCharacterName('Primitive')
  return db
}

function foldFixture(name: string): ResistRow[] {
  const db = appSpellDb()
  const fold = new ResistFold({ spellDb: db })
  fold.beginSource()
  let seq = 0
  for (const line of readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8').split(/\r?\n/)) {
    if (!line) continue
    const ev = parseEvent(line, seq++)
    if (ev) fold.onEvent(ev)
  }
  fold.finish()
  return fold.rows()
}

const song = (rows: readonly ResistRow[], mob: string, spell: string): ResistRow | undefined =>
  rows.find((r) => r.mobKey === mob && r.spellKey === spell && r.family === 'song')

// ---------------------------------------------------------------------------------------------
// THE FIXTURE HALF

test('A SONG IS A SONG WITHOUT A BEGIN LINE, and the aura never prints one', () => {
  const rows = foldFixture('r2-song-pulses.log')
  // Six pulses, no `You begin singing` anywhere in the window.
  const largo = rows.filter((r) => r.spellKey === "largo's melodic binding")
  assert.ok(largo.length > 0, 'the song was recognised from spell identity alone')
  for (const row of largo) assert.equal(row.family, 'song', 'and never filed as an ordinary cast')
})

test('a song with a known landing sentence has an EXACT denominator: lands + resists', () => {
  const rows = foldFixture('r2-song-pulses.log')
  // Hand-read off the fixture, pulse by pulse, at 16:29:32 / :38 / :44 / :50 / :56 / 16:30:02.
  const soldier = song(rows, "soldier of v'zher", "largo's melodic binding")
  assert.ok(soldier)
  assert.equal(soldier.land, 4)
  assert.equal(soldier.resist, 2)

  const baron = song(rows, "baron telyx v'zher", "largo's melodic binding")
  assert.ok(baron)
  assert.equal(baron.land, 3)
  assert.equal(baron.resist, 3)
})

test('THE DEFECT THIS FIXTURE EXISTS FOR: no song row is resist-only', () => {
  const rows = foldFixture('r2-song-pulses.log')
  const songs = rows.filter((r) => r.family === 'song')
  assert.ok(songs.length >= 4)
  const blind = songs.filter((r) => r.resist > 0 && r.land === 0)
  assert.deepEqual(blind, [], 'a song whose landings we cannot see has no denominator at all')
})

test('the catalog files the landing sentence under the wrong family member, and the APP corrects it', () => {
  // The scrape: Melodic (Bard 20) says "bound IN strands", Assonant (Bard 51) says "bound BY".
  // The log: "bound BY strands" 4,152 times, "resisted your Largo's Melodic Binding" 570 times,
  // interleaved on one six-second grid, cast by a level 21-24 character.
  //
  // JOS-384 moved that correction OUT of this module and into the app-wide overlay, so what this
  // test now pins is that the resist fold reads the corrected catalog rather than carrying a
  // private copy of the answer — the whole point of the factoring. `tests/largoBinding.test.mts`
  // owns the correction itself and the guard that keeps it the only copy.
  const db = appSpellDb()
  assert.equal(
    db.byKey.get("largo's melodic binding")?.msgCastOnOther,
    'Someone is bound by strands of solid music.',
    'the level-20 song owns the sentence the game prints, through the shared corrections overlay'
  )
  // Both halves therefore land on ONE row, which is the only way the song has a denominator.
  const rows = foldFixture('r2-song-pulses.log')
  assert.equal(rows.filter((r) => r.spellKey === "largo's assonant binding").length, 0)
  assert.ok(rows.some((r) => r.spellKey === "largo's melodic binding" && r.family === 'song'))
})

test('ONE SENTENCE CAN BE TWO SONGS, and the log says which', () => {
  // `<mob> winces.` is the catalog's landing message for Denon's Disruptive Discord (Bard 18) AND
  // Chords of Dissonance (Bard 2). Pooling them would smear a -100 resist adjust into a spell with
  // none, so the model resolves against what the log NAMED - which here is Denon's, eight times.
  const rows = foldFixture('r3-song-shared-message.log')
  const named = rows.filter((r) => r.family === 'song')
  assert.ok(named.length > 0)
  for (const row of named) assert.equal(row.spellKey, "denon's disruptive discord")
  const theurgist = song(rows, 'a necro theurgist', "denon's disruptive discord")
  assert.ok(theurgist)
  assert.equal(theurgist.land, 4)
  assert.equal(theurgist.resist, 2)
})

test('a song is decided by the class column, not by a begin line', () => {
  const db = appSpellDb()
  assert.equal(isSongSpell(db, "largo's melodic binding"), true)
  assert.equal(isSongSpell(db, "denon's disruptive discord"), true)
  assert.equal(isSongSpell(db, 'chords of dissonance'), true)
  // Shared with another class, or not a bard spell at all: rolls once per cast like anything else.
  assert.equal(isSongSpell(db, 'chaos flux'), false)
  assert.equal(isSongSpell(db, 'mesmerization'), false)
  assert.equal(isSongSpell(db, 'not a spell at all'), false)
})

test('an emote nothing can separate is REFUSED rather than guessed at', () => {
  const db = appSpellDb()
  const both = ["Denon's Disruptive Discord", 'Chords of Dissonance']
  assert.equal(resolveSongEmote(db, both, []), null, 'two songs, nothing named: refuse')
  assert.equal(resolveSongEmote(db, both, ["denon's disruptive discord"]), "denon's disruptive discord")
  assert.equal(resolveSongEmote(db, both, ['chords of dissonance']), 'chords of dissonance')
  // One candidate needs no resolving, and a non-song emote is not this function's business.
  assert.equal(resolveSongEmote(db, ["Largo's Assonant Binding"], []), "largo's assonant binding")
  assert.equal(resolveSongEmote(db, ['Chaos Flux'], []), null)
})

test('JOS-384: the LEVEL separates the two Largo songs before the log has named either', () => {
  // The corrected catalog gives ONE sentence two owners, so the emote arrives with two candidates
  // and the module has to separate them from evidence. `named` is the stronger evidence and is a
  // running tally, so it is empty for every pulse before the first resist line — 35 landings on
  // the owner's log. The catalog's own class column covers exactly that window.
  const db = appSpellDb()
  const both = ["Largo's Assonant Binding", "Largo's Melodic Binding"]
  assert.equal(resolveSongEmote(db, both, []), null, 'no level, nothing named: refuse')
  assert.equal(
    resolveSongEmote(db, both, [], 24),
    "largo's melodic binding",
    'a level-24 bard has the level-20 song and cannot have the level-51 one'
  )
  assert.equal(resolveSongEmote(db, both, [], 51), null, 'a level-51 bard has BOTH, so refuse again')
  assert.equal(
    resolveSongEmote(db, both, ["largo's assonant binding"], 51),
    "largo's assonant binding",
    'and `named` is what decides it for them'
  )
  // The empty-narrowing guard: a level BELOW every candidate discards the narrowing whole rather
  // than throwing the observation away, and resolution falls back to what the log named.
  assert.equal(resolveSongEmote(db, ["Largo's Assonant Binding"], [], 5), "largo's assonant binding")
})

// ---------------------------------------------------------------------------------------------
// THE RULES HALF - the fallback for a song with no usable landing sentence.

function collect(): { pulses: SongPulse[]; songs: SongPulses } {
  const pulses: SongPulse[] = []
  const songs = new SongPulses((p) => pulses.push(p))
  return { pulses, songs }
}

const at = (pulses: readonly SongPulse[]): number[] => pulses.map((p) => p.ts)

test('RULE 1: a pulse the log printed something for is witnessed, once', () => {
  const { pulses, songs } = collect()
  songs.witness('lullaby', 1000, 'a kodiak')
  // Everything inside a second of the first line is the SAME pulse: a point-blank song that
  // resists on three mobs prints three lines for one roll each, at one instant.
  songs.witness('lullaby', 1400, 'a young kodiak')
  songs.witness('lullaby', 1900, null)
  songs.flush()
  assert.equal(pulses.length, 1)
  assert.equal(pulses[0].witnessed, true)
  assert.deepEqual([...pulses[0].resisted].sort(), ['a kodiak', 'a young kodiak'])
})

test('RULE 2: interior pulses between two witnesses under 30 s apart are counted', () => {
  const { pulses, songs } = collect()
  songs.witness('lullaby', 0, 'a kodiak')
  songs.witness('lullaby', 4 * SONG_PULSE_MS, 'a kodiak')
  songs.flush()
  // Two witnessed pulses 24 s apart: the three at 6, 12 and 18 s demonstrably happened.
  assert.deepEqual(at(pulses), [0, SONG_PULSE_MS, 2 * SONG_PULSE_MS, 3 * SONG_PULSE_MS, 4 * SONG_PULSE_MS])
  assert.deepEqual(
    pulses.map((p) => p.witnessed),
    [true, false, false, false, true]
  )
  // An interpolated pulse names nobody: the log said nothing about it, so it resisted nobody.
  for (const p of pulses) {
    if (!p.witnessed) assert.equal(p.resisted.size, 0)
  }
})

test('RULE 2: a gap wider than 30 s is TWO runs, and nothing spans it', () => {
  const { pulses, songs } = collect()
  songs.witness('lullaby', 0, 'a kodiak')
  songs.witness('lullaby', SONG_RUN_GAP_MS + SONG_PULSE_MS, 'a kodiak')
  songs.flush()
  // The song may simply have stopped. Extrapolating across the gap is the one way this
  // reconstruction could OVER-count, so it does not.
  assert.deepEqual(at(pulses), [0, SONG_RUN_GAP_MS + SONG_PULSE_MS])
})

test('RULE 2: nothing is extrapolated before the first or after the last witness', () => {
  const { pulses, songs } = collect()
  songs.witness('lullaby', 60_000, 'a kodiak')
  songs.flush()
  // One witness is one pulse. The edges of a run are exactly where "it might have stopped" lives.
  assert.deepEqual(at(pulses), [60_000])
})

test('RULE 2: a restart inside the gap re-anchors, and drops what came before it', () => {
  const { pulses, songs } = collect()
  songs.witness('lullaby', 0, 'a kodiak')
  // `You begin singing Kelin's Lucid Lullaby.` at 15 s: whatever ran before it, this run began
  // here, so the pulses at 6 and 12 s are forfeited and only the one at 18 s is interpolated.
  songs.noteSing('lullaby', 15_000)
  songs.witness('lullaby', 4 * SONG_PULSE_MS, 'a kodiak')
  songs.flush()
  assert.deepEqual(at(pulses), [0, 3 * SONG_PULSE_MS, 4 * SONG_PULSE_MS])
})

test('two songs twist independently - a bard runs four at once', () => {
  const { pulses, songs } = collect()
  songs.witness('lullaby', 0, 'a kodiak')
  songs.witness('chords', 3000, 'a kodiak')
  songs.witness('lullaby', 2 * SONG_PULSE_MS, 'a kodiak')
  songs.flush()
  const lullaby = pulses.filter((p) => p.spellKey === 'lullaby')
  const chords = pulses.filter((p) => p.spellKey === 'chords')
  // Starting another song does NOT end the previous one, so one song's run must never close
  // another's - which is exactly why "still singing" cannot be read off the cast lines.
  assert.deepEqual(at(lullaby), [0, SONG_PULSE_MS, 2 * SONG_PULSE_MS])
  assert.deepEqual(at(chords), [3000])
})

test('SETTLE closes a pulse without ending its run; FLUSH ends both', () => {
  const settled = collect()
  settled.songs.witness('lullaby', 0, 'a kodiak')
  // The live tail's heartbeat, one second later: the pulse can gain no more witnesses and is
  // decided, but the bard is mid-rotation and the run is still open.
  settled.songs.settle(2000)
  assert.deepEqual(at(settled.pulses), [0])
  settled.songs.witness('lullaby', 2 * SONG_PULSE_MS, 'a kodiak')
  settled.songs.settle(2 * SONG_PULSE_MS + 2000)
  assert.deepEqual(at(settled.pulses), [0, SONG_PULSE_MS, 2 * SONG_PULSE_MS], 'the run survived the tick')

  const flushed = collect()
  flushed.songs.witness('lullaby', 0, 'a kodiak')
  flushed.songs.flush()
  flushed.songs.witness('lullaby', 2 * SONG_PULSE_MS, 'a kodiak')
  flushed.songs.flush()
  // A zone change is a real discontinuity: the run ended, so no interpolation crosses it.
  assert.deepEqual(at(flushed.pulses), [0, 2 * SONG_PULSE_MS])
})

test('THE AURA HEARTBEAT beats six-second arithmetic where the log printed one', () => {
  const { pulses, songs } = collect()
  // `Your feet move faster.` prints once per pulse, 6,966 times in the owner's log, whether or not
  // anything was in range. Those are instants the log STATED; stepping 6 s at a time from the last
  // witness is arithmetic that drifts as soon as the server's tick does.
  songs.witness('lullaby', 0, 'a kodiak')
  songs.noteHeartbeat(6_100)
  songs.noteHeartbeat(12_150)
  songs.witness('lullaby', 18_200, 'a kodiak')
  songs.flush()
  assert.deepEqual(at(pulses), [0, 6_100, 12_150, 18_200])

  // With no heartbeat in the gap the arithmetic is the fallback, unchanged.
  const bare = collect()
  bare.songs.witness('lullaby', 0, 'a kodiak')
  bare.songs.witness('lullaby', 3 * SONG_PULSE_MS, 'a kodiak')
  bare.songs.flush()
  assert.deepEqual(at(bare.pulses), [0, SONG_PULSE_MS, 2 * SONG_PULSE_MS, 3 * SONG_PULSE_MS])
})

test('the pulse interval is the measured one, and the run gap is the stated one', () => {
  // Guarded because both numbers are MEASUREMENTS, not preferences: consecutive song resists on
  // one mob in the owner's log are 6, 12, 18 and 24 s apart. Changing either changes what the
  // reconstruction claims, and should be a measurement too.
  assert.equal(SONG_PULSE_MS, 6_000)
  assert.equal(SONG_RUN_GAP_MS, 30_000)
})
