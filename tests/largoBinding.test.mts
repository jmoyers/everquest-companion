// JOS-384 — A CORRECTION TO THE WIKI IS APP-WIDE, OR IT IS NOTHING.
//
// THE DEFECT, and it is a data one. The scrape files the bard binding line like this:
//
//     Largo's Melodic Binding    Bard 20    "Someone is bound IN strands of solid music."
//     Largo's Assonant Binding   Bard 51    "Someone is bound BY strands of solid music."
//
// EQ Legends prints the `by` sentence for the LEVEL-20 song. Whole-log over the owner's
// `eqlog_Primitive_freeport.txt` (2,013,844 lines, read-only, measured 2026-08-16): the `in` form
// occurs ZERO times, the `by` form 4,152 times, `<T> resisted your Largo's Melodic Binding!` 570
// times and the Assonant resist line 0 — the two shapes interleaved on one six-second SYMPHONIC
// AURA grid while the character is level 21 to 24. A level-21 bard has no level-51 song.
//
// THE PLACE IT IS FIXED IS THE POINT OF THIS TICKET. JOS-382 found the defect from inside the
// resist feature and fixed it there, in a two-name pooling table in `src/main/resist/songIdentity.ts`.
// Owner ruling 2026-08-16: overrides on wiki data are GLOBAL to the app. A module-local one means
// the resist page has decided the catalog is wrong while the buff overlay, the alerts, the timers
// and the landing detection go on reading it as it stands — two answers to one question, and only
// one of them visible to the person reading the corrections file.
//
// SO THIS SUITE PINS THREE THINGS:
//
//   1. THE ROW. `spellCorrectionsList.ts` carries the correction, with its evidence, and the loaded
//      catalog shows it — which also means the sentence is now SHARED with the level-51 song.
//   2. THE LANDING. A low-level bard's `<mob> is bound by strands of solid music.` resolves to
//      MELODIC, through the ordinary shared-message machinery (`buffLanding.ts` case 1: the cast
//      anchor names the spell). Before the correction that landing named nothing at all.
//   3. THE GUARD. No feature module may carry a catalog landing sentence as a code literal. That is
//      what a module-local override LOOKS like, and it is the one shape this ticket exists to
//      prevent coming back — anywhere, not only in the resist tree.
//
// Run: `npm test`.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { parseEvent } from '../src/main/log/parser.ts'
import { installSpellDb } from '../src/main/log/rulesets.ts'
import { loadSpellDb, matchCastOnOtherSuffix } from '../src/main/data/spellDb.ts'
import { applySpellCorrections, SPELL_CORRECTIONS } from '../src/main/data/spellCorrections.ts'
import { BuffsModule } from '../src/main/modules/buffs.ts'
import { BuffTimersModule } from '../src/main/modules/buffTimers.ts'
import { buildTimerRows } from '../src/shared/buffTimers.ts'
import type { SpellDbFile } from '../src/shared/types.ts'
import spellsJson from '../src/main/data/spells.json' with { type: 'json' }

const RAW = (spellsJson as SpellDbFile).spells
const MELODIC = "Largo's Melodic Binding"
const ASSONANT = "Largo's Assonant Binding"
const WIKI = 'Someone is bound in strands of solid music.'
const GAME = 'Someone is bound by strands of solid music.'
/** The sentence as the LOG writes it — a mob name in place of the subject placeholder. */
const LANDING = 'a lesser mummy is bound by strands of solid music.'

// ---------------------------------------------------------------------------------------------
// 1 — THE ROW
// ---------------------------------------------------------------------------------------------

test('the corrections overlay carries the Largo row, with evidence', () => {
  const row = SPELL_CORRECTIONS.find((c) => c.spells.includes(MELODIC) && c.field === 'msgCastOnOther')
  assert.ok(row, 'the correction lives in spellCorrectionsList.ts and nowhere else')
  assert.equal(row.from, WIKI, 'it states the wiki text it replaces, so a re-scrape can retire it')
  assert.equal(row.to, GAME)
  assert.equal(row.attribution, 'cast')
  // The evidence bar wants the MEASUREMENT in the row, not a pointer to a ticket.
  assert.match(row.evidence, /4,152/, 'the landing count')
  assert.match(row.evidence, /570/, 'the resist count that attributes it to the level-20 song')
  assert.match(row.evidence, /ZERO/, 'and rule 1: the wiki form is not a sentence this game prints')
})

test('…and the loaded catalog gives the level-20 song the sentence the game prints', () => {
  const db = loadSpellDb()
  assert.equal(db.byKey.get("largo's melodic binding")?.msgCastOnOther, GAME)
  assert.equal(db.byKey.get("largo's assonant binding")?.msgCastOnOther, GAME, 'ASSONANT KEEPS ITS OWN TEXT')
  assert.equal(
    db.castOnOtherSuffix.get('is bound in strands of solid music.'),
    undefined,
    'and the wiki form owns nothing, because the game has never printed it'
  )
})

test('the correction makes the sentence SHARED, which is the state it has to survive', () => {
  // World-model law 3: EQ prints one sentence per spell FAMILY. Two owners is the ordinary case,
  // not a defect — `messageOverlay` files such a text SHARED (it can never name a spell on its own)
  // and `buffLanding.ts` resolves it from evidence. The next test is that resolution.
  const db = loadSpellDb()
  const hit = matchCastOnOtherSuffix(LANDING, db)
  assert.ok(hit, 'the live sentence must resolve at all')
  assert.equal(hit.target, 'a lesser mummy')
  assert.deepEqual(
    [...new Set(hit.entry.cands.map((c) => c.name))].sort(),
    [ASSONANT, MELODIC],
    'the whole binding line that shares it — and nothing else in the catalog does'
  )
})

// ---------------------------------------------------------------------------------------------
// 2 — THE LANDING: the consumer that gained the fix
// ---------------------------------------------------------------------------------------------

/** An EQ-stamped line at `sec` seconds past 22:58:00 — the real `[Day Mon DD HH:MM:SS YYYY] ` shape. */
function at(sec: number, text: string): string {
  const two = (n: number): string => String(n).padStart(2, '0')
  return `[Sat Aug 09 22:${two(58 + Math.floor(sec / 60))}:${two(sec % 60)} 2026] ${text}`
}

/** The `tests/spellCorrections.test.mts` harness: both modules, wired the way wiring.ts wires them. */
function replay(lines: [number, string][], observeSec: number) {
  const db = loadSpellDb()
  installSpellDb(db)
  const buffs = new BuffsModule(db)
  buffs.reset()
  const timers = new BuffTimersModule(buffs.castAnchors(), buffs.spellStats())
  timers.reset()
  let seq = 0
  for (const [sec, text] of lines) {
    const ev = parseEvent(at(sec, text), seq++)
    if (!ev) continue
    buffs.onEvent(ev)
    timers.onEvent(ev)
  }
  const tick = parseEvent(at(observeSec, 'x'), seq)?.ts ?? 0
  buffs.onTick(tick)
  timers.onTick(tick)
  const b = buffs.snapshot().state
  return { rows: buildTimerRows(b, timers.snapshot().state), active: b.active }
}

test("THE ACCEPTANCE: a low-level bard's binding landing resolves to MELODIC, not to the level-51 song", () => {
  // The aura almost never prints a cast line, but a song a bard STARTS by hand does — and that is
  // the anchor the shared sentence resolves through (`buffLanding.ts` case 1, the named anchor).
  const r = replay(
    [
      [0, `You begin singing ${MELODIC}.`],
      [3, LANDING]
    ],
    10
  )
  const row = r.rows.find((x) => x.targetKey === 'a lesser mummy')
  assert.ok(row, `no row: ${r.rows.map((x) => `${x.name}@${x.target ?? 'self'}`).join(', ') || '(none)'}`)
  assert.equal(row.name, MELODIC, 'the bard`s own song, not the one thirty-one levels above them')
  assert.equal(row.durationMs, 18_000, 'the DB states 3 ticks for the line')
  assert.ok(
    r.active.some((a) => a.spell === MELODIC && a.target === 'a lesser mummy'),
    `no held instance: ${r.active.map((a) => `${a.spell}@${a.target ?? 'self'}`).join(', ') || '(none)'}`
  )
})

test('…and the level-51 song still claims its own landing when IT is the one being sung', () => {
  // The other direction, which is what makes the test above a resolution rather than a preference.
  const r = replay(
    [
      [0, `You begin singing ${ASSONANT}.`],
      [3, LANDING]
    ],
    10
  )
  assert.equal(r.rows.find((x) => x.targetKey === 'a lesser mummy')?.name, ASSONANT)
})

test('an UNANCHORED binding landing still names nobody — a shared sentence is not a licence to guess', () => {
  // JOS-140's gate, unchanged by the correction: a landing emote is a broadcast and names no
  // caster, so without a cast of our own it produces nothing at all. The correction widened the
  // candidate list; it did not lower this bar.
  const r = replay([[3, LANDING]], 10)
  assert.equal(r.rows.find((x) => x.targetKey === 'a lesser mummy'), undefined)
  assert.deepEqual(r.active, [])
})

test('…and with the wiki`s own row the same bard`s landing named NOTHING, which is the defect stated', () => {
  // The correction is the only thing standing between this test and the acceptance above. Without
  // it the `by` sentence has ONE owner, the level-51 song — so the level-20 bard's cast anchor
  // matches no candidate, and `admitLanding` returns null rather than picking the wrong song.
  const bare = applySpellCorrections(
    RAW,
    SPELL_CORRECTIONS.filter((c) => !(c.spells.includes(MELODIC) && c.field === 'msgCastOnOther'))
  ).spells
  assert.equal(bare.find((s) => s.name === MELODIC)?.msgCastOnOther, WIKI, 'the committed scrape still says `in`')
  assert.deepEqual(
    bare.filter((s) => s.msgCastOnOther === GAME).map((s) => s.name),
    [ASSONANT],
    'so the sentence the game prints belonged to a song the reporter could not have cast'
  )
})

// ---------------------------------------------------------------------------------------------
// 3 — THE GUARD: the one place a catalog sentence may be written down
// ---------------------------------------------------------------------------------------------

/**
 * WHERE A CATALOG SENTENCE MAY APPEAR AS A CODE LITERAL, and the line the list is drawn on.
 *
 * THE OVERLAY ITSELF writes sentences down because that is its whole job — it is the file a reader
 * checks when they want to know what we believe the game prints, and the one place a correction
 * can be audited, re-derived or retired.
 *
 * A FAMILY ROSTER is the other legitimate shape and it is NOT the same thing: it names sentences
 * the catalog ALREADY OWNS, verbatim, in order to say which spells belong together — the lull
 * ladder in `spellDb.ts`, the charm broadcasts in `charmModel.ts`. It makes no claim that the
 * catalog is wrong, so it cannot be a correction hiding in a module, and moving it into the
 * overlay would be filing a classification as a defect.
 *
 * EVERYTHING ELSE that hard-codes a landing sentence is a wiki correction wearing a feature
 * module's clothes, which is exactly what JOS-384 undid. Add a corrections row instead of an entry
 * here — an entry here is a decision about the SHAPE of an answer, not a place to put a defect.
 */
const SENTENCE_LITERALS_ALLOWED = new Set([
  // the overlay
  'src/main/data/spellCorrections.ts',
  'src/main/data/spellCorrectionsList.ts',
  'src/main/data/spellCorrectionsSubjects.ts',
  // …and the table it owns, split out under the same rule the list file above follows (JOS-412).
  'src/main/data/spellCorrectionsSubjectsList.ts',
  'src/main/data/spellCorrectionsHealing.ts',
  'src/main/data/spellRemovalsList.ts',
  // family rosters, keyed on sentences the catalog owns as written
  'src/main/data/spellDb.ts',
  'src/main/combat/charmModel.ts'
])

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) sourceFiles(p, out)
    else if (/\.(ts|tsx|mts)$/.test(name)) out.push(p)
  }
  return out
}

/**
 * COMMENTS AND STRINGS IN ONE ALTERNATION, which is the whole trick and the reason this guard needs
 * no parser. The scan runs left to right over the source and every match consumes its own text, so
 * a `//` inside a string is eaten by the STRING branch (the opening quote comes first) and an
 * apostrophe inside a comment is eaten by the COMMENT branch — the two failure modes a naive
 * "strip comments, then find quotes" pass has, and both of them live in this tree: the prose above
 * `parseCasts.ts`'s PET table quotes two DB sentences inside a `//` line.
 *
 * A comment match is discarded; a string match yields its text. Single- and double-quoted branches
 * refuse newlines, so a regex literal carrying a stray quote can misread at worst one line.
 */
const TOKEN =
  /\/\*[\s\S]*?\*\/|\/\/[^\n]*|'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g

/** Every string literal in a source file, comments excluded, escapes resolved. */
function literalsIn(src: string): string[] {
  const out: string[] = []
  for (const m of src.matchAll(TOKEN)) {
    if (m[0].startsWith('/')) continue
    out.push((m[1] ?? m[2] ?? m[3] ?? '').replace(/\\(['"`\\])/g, '$1'))
  }
  return out
}

/**
 * Does this literal END with a sentence the catalog owns? Tails are taken at the boundaries a
 * subject placeholder can sit on — the start, a space, or the possessive quote the scrape writes
 * (`Someone 's head nods.` keys as `'s head nods.`) — so `<mob> is bound by …` is caught as
 * squarely as the bare DB sentence is.
 */
function catalogSentenceIn(text: string, owned: ReadonlySet<string>): string | null {
  for (let i = 0; i < text.length; i++) {
    const prev = i === 0 ? ' ' : text[i - 1]
    if (prev !== ' ' && text[i] !== "'" && text[i] !== '`') continue
    const tail = text.slice(i)
    if (owned.has(tail)) return tail
  }
  return null
}

test('THE GUARD: no feature module writes a catalog landing sentence down', () => {
  const db = loadSpellDb()
  // The suffix table is keyed on exactly the tail a log line carries, which is the shape a module
  // would hard-code. The short ones are dropped: a two-word tail is a phrase, not a sentence.
  const owned = new Set([...db.castOnOtherSuffix.keys()].filter((s) => s.length >= 12))
  assert.ok(owned.size > 500, `the catalog must have landing sentences to police: ${String(owned.size)}`)
  assert.ok(catalogSentenceIn(LANDING, owned), 'the detector must catch the sentence this ticket is about')
  assert.equal(catalogSentenceIn('resist mining is not a sentence', owned), null)

  const root = join(import.meta.dirname, '..', 'src')
  const offenders: string[] = []
  let literals = 0
  for (const file of sourceFiles(root)) {
    const rel = relative(join(import.meta.dirname, '..'), file).split(sep).join('/')
    if (SENTENCE_LITERALS_ALLOWED.has(rel)) continue
    for (const text of literalsIn(readFileSync(file, 'utf8'))) {
      literals++
      if (text.length < 12) continue
      const owns = catalogSentenceIn(text, owned)
      if (owns !== null) offenders.push(`${rel}: ${JSON.stringify(text)} owns ${JSON.stringify(owns)}`)
    }
  }
  // A walk that found nothing would pass vacuously, which is the failure mode a guard test has.
  assert.ok(literals > 10_000, `the walk must actually read the tree: ${String(literals)} literals`)
  assert.deepEqual(
    offenders,
    [],
    'a catalog sentence in a feature module is a wiki correction in the wrong place (JOS-384). ' +
      'Put it in spellCorrectionsList.ts, where every consumer sees it.'
  )
})

test('THE OTHER HALF OF THE GUARD: the resist module names no individual spell', () => {
  // The sentence guard above is a proxy, and this is the shape the thing it is guarding against
  // ACTUALLY had: `SONG_FAMILY_OVERRIDES` carried no sentence at all, only two spell NAMES, keyed
  // exactly as `spellCanonKey` writes them. A module that names one spell has an opinion about
  // that spell which the catalog does not share — which is the definition of a local override,
  // whether it is spelled as a sentence or as a name.
  //
  // TWO-WORD NAMES AND LONGER, because the one-word ones are ordinary English: `Charm`, `Root`,
  // `Fear` and `Calm` are all spells AND all words this fold uses for other things, so demanding
  // it never write them would be policing the language rather than the layering.
  const db = loadSpellDb()
  const named = new Set([...db.byKey.keys()].filter((k) => k.includes(' ') && k.length >= 8))
  assert.ok(named.has("largo's assonant binding"), 'the table this guard exists for must be detectable')

  const root = join(import.meta.dirname, '..', 'src', 'main', 'resist')
  const offenders: string[] = []
  for (const file of sourceFiles(root)) {
    const rel = relative(join(import.meta.dirname, '..'), file).split(sep).join('/')
    for (const text of literalsIn(readFileSync(file, 'utf8'))) {
      if (named.has(text.trim().toLowerCase())) offenders.push(`${rel}: ${JSON.stringify(text)}`)
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'the resist fold decides from spell IDENTITY (the catalog`s class column, its messages, its ' +
      'levels), never from a list of spells it was told about (JOS-384).'
  )
})
