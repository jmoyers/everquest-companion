import test from 'node:test'
import assert from 'node:assert/strict'
import { ALERT_GROUPS, alertGroupDefs } from '../src/shared/alertGroups'
import type { BuffTimerRow } from '../src/shared/buffTimers'
import { MAX_EARLY_WARN_SEC, breakTriggerKinds, earlyWarnFireAt } from '../src/shared/earlyWarning'
import type { AlertDef, AlertTrigger } from '../src/shared/types'
import { replayAlertLines, replayBuffTimers } from './harness.mts'

// ═════════════════════════════════════════════════════════════════════════════════════════════
// JOS-235 — THE BREAK FAMILY. The offset used to DELETE these alerts; here it is, doing its job.
//
// The defect, in the owner's release testing: `earlyWarnSec: 90` on his breaks-for-Dazzle alert
// neither warned early nor fired at the break. For a def whose trigger IS the ending, the arm was
// filed against a world the same line had already emptied, no row was ever found, and the request
// was dropped in silence. The fix arms such a def from the ROW APPEARING instead, and leaves the
// break line firing it as it always did — minus the one landing whose warning already spoke.
//
// THE ACCEPTANCE MATRIX IS ONE REPRESENTATIVE PER FAMILY (owner, 2026-08-12), and each of them
// takes a different route through the parser and the timer model — which is exactly why one case
// could not have stood for the rest:
//
//   MEZ     Dazzle          cc APPLICATION sentence → a CC HOLD row;  break is `cc {refresh}`
//   ROOT    Immobilize      DB landing message      → a `debuff` row; break is `cc {refresh}`
//   ROOT    Ensnare         cc APPLICATION sentence → a CC HOLD row;  break is `cc {refresh}`
//   SLOW    Shiftless Deeds DB landing message      → a `debuff` row; break is `buffFade`
//   SLOW    Largo's         DB landing message      → a `debuff` row; break is `buffFade`
//   PACIFY  Pacify          DB landing message      → a `buff` row (calmsTarget); break `buffFade`
//   CHARM   Solon's Bravura DB landing message      → a `debuff` row; break is `uncharm`
//
// Two of them run the SHIPPED group defs (`shared/alertGroups.ts`) rather than a def written for
// the test — the broad "Mez / root broke" and the seeded "Charm break" — because the ticket is
// about defs the user actually has.
//
// THE LINES ARE SYNTHESIZED, and every one of them is a shape this repo already states: the
// landing sentences are the committed spells.json `msg_cast_on_other` with the target substituted
// (the same substitution the parser undoes), the CC applications are `classifyCcApply`'s own
// verbs, and `Your <X> spell has worn off of <mob>.` is the universal wear-off sentence quoted in
// shared/alertGroups.ts. tests/earlyWarning.test.mts's real-bytes fixture is still the golden for
// the LANDING half — this file is its break-family sibling, split out because the two together
// overflow the file's factoring ceiling and for no other reason; nothing there was weakened. No
// fixture
// in the tree carries a mez, a root, a slow, a pacify and a charm break together, and the owner's
// ruling for this matrix is a representative per family rather than a fifth extraction.
//
// NOTHING IS FROZEN. Each case reads the duration off the row the model actually built and derives
// its own deadline from it, so a re-scrape that moves a spell's DB floor moves the expectation with
// it (AGENTS.md: frozen numbers rot).
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** The window these synthetic cases live in. Local time, because that is what the parser reads. */
const T0 = new Date(2026, 7, 1, 21, 0, 0)
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** One log line, `sec` seconds into the window, stamped the way EQ stamps them. */
function line(sec: number, text: string): string {
  const d = new Date(T0.getTime() + sec * 1_000)
  const p = (n: number): string => String(n).padStart(2, '0')
  const date = `${DAY_NAMES[d.getDay()]} ${MONTH_NAMES[d.getMonth()]} ${p(d.getDate())}`
  return `[${date} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${String(d.getFullYear())}] ${text}`
}

/** The instant of the landing every case below shares (second 1 — the cast is second 0). */
const LAND_TS = T0.getTime() + 1_000

/** One family's whole case: the three lines, the def under test, and the offset. */
interface Family {
  title: string
  /** The spell as the WEAR-OFF line names it — rank-less, which is what those lines print. */
  spell: string
  mob: string
  cast: string
  landing: string
  sec: number
  trigger: AlertTrigger
}

/** The shipped group def's trigger, by id — the defs a user gets from the groups panel. */
function groupTrigger(groupId: string, defId: string): AlertTrigger {
  const group = ALERT_GROUPS.find((g) => g.id === groupId)
  assert.ok(group, `no shipped alert group ${groupId}`)
  const def = alertGroupDefs(group).find((d) => d.id === defId)
  assert.ok(def, `no shipped def ${defId}`)
  return def.trigger
}

const FAMILIES: Family[] = [
  {
    // THE OWNER'S STORED CASE. `breaks` template (JOS-161): the per-spell mez break.
    title: 'MEZ · Dazzle (the owner`s stored alert)',
    spell: 'Dazzle',
    mob: 'a turmoil toad',
    cast: 'You begin casting Dazzle.',
    landing: 'a turmoil toad has been mesmerized.',
    sec: 90,
    trigger: { type: 'event', kind: 'cc', where: { spell: 'Dazzle', refresh: 'true' } }
  },
  {
    // The same mez, through the BROAD group alert instead — `{kind:'cc', where:{refresh:'true'}}`.
    title: 'MEZ · the shipped "Mez / root broke" group',
    spell: 'Dazzle',
    mob: 'a turmoil toad',
    cast: 'You begin casting Dazzle.',
    landing: 'a turmoil toad has been mesmerized.',
    sec: 90,
    trigger: groupTrigger('cc', 'group:cc:broke')
  },
  {
    // ROOT, and the case that proves the row's KIND is not the discriminator: the landing is a DB
    // message (`buffApply` → a plain debuff row) while the break is still a `cc {refresh}`.
    title: 'ROOT · Immobilize',
    spell: 'Immobilize',
    mob: 'a scareling',
    cast: 'You begin casting Immobilize.',
    landing: 'a scareling adheres to the ground.',
    sec: 30,
    trigger: { type: 'event', kind: 'cc', where: { spell: 'Immobilize', refresh: 'true' } }
  },
  {
    // ROOT, the other half of the roster: an `ensnared` APPLICATION sentence, so this one is a hold.
    title: 'ROOT · Ensnare',
    spell: 'Ensnare',
    mob: 'a wan ghoul knight',
    cast: 'You begin casting Ensnare.',
    landing: 'a wan ghoul knight has been ensnared.',
    sec: 120,
    trigger: { type: 'event', kind: 'cc', where: { spell: 'Ensnare', refresh: 'true' } }
  },
  {
    // SLOW, through the SHIPPED group def, whose matcher is the slow-family regex.
    title: 'SLOW · Shiftless Deeds (the shipped group def)',
    spell: 'Shiftless Deeds',
    mob: 'a froglok ton knight',
    cast: 'You begin casting Shiftless Deeds.',
    landing: 'a froglok ton knight slows down.',
    sec: 45,
    trigger: groupTrigger('slow', 'group:slow:mob')
  },
  {
    // The bard binding song JOS-233 moved INTO that roster — same def, and it must warn too.
    //
    // THE SENTENCE IS `by`, NOT `in`, SINCE JOS-384. The wiki files `bound IN strands` under this
    // song and the shipped game prints `bound BY`; the app-wide corrections overlay now says so
    // (`spellCorrectionsList.ts`), which also makes the sentence SHARED with the level-51 upgrade.
    // The cast line above is what resolves it back to this song — the shared-message machinery
    // doing exactly the job the correction leans on.
    title: 'SLOW · Largo`s Melodic Binding (JOS-233`s new roster member)',
    spell: "Largo's Melodic Binding",
    mob: 'a lesser mummy',
    cast: "You begin casting Largo's Melodic Binding.",
    landing: 'a lesser mummy is bound by strands of solid music.',
    sec: 5,
    trigger: groupTrigger('slow', 'group:slow:mob')
  },
  {
    // PACIFY (JOS-213): a BENEFICIAL spell on an enemy — `kind:'buff'` with `calmsTarget`, which
    // routes it to the debuffs window. The scheduler tracks it like any other row, and this is the
    // test that says so out loud.
    title: 'PACIFY · Pacify',
    spell: 'Pacify',
    mob: 'an icy terror',
    cast: 'You begin casting Pacify.',
    landing: 'an icy terror looks less aggressive.',
    sec: 10,
    trigger: { type: 'event', kind: 'buffFade', where: { spell: 'Pacify' } }
  },
  {
    // CHARM, through the SEEDED charm-break alert. A different EVENT (`uncharm`, JOS-200) reached
    // by the same sentence, and the reason the break kinds are a list rather than one.
    title: 'CHARM · Solon`s Bewitching Bravura (the seeded charm-break alert)',
    spell: "Solon's Bewitching Bravura",
    mob: 'a young shark',
    cast: "You begin casting Solon's Bewitching Bravura.",
    landing: "a young shark's eyes glaze over.",
    sec: 5,
    trigger: groupTrigger('charm', 'charm-break')
  }
]

/** The def under test: the family's own trigger, with or without the offset. */
function familyDef(f: Family, sec?: number): AlertDef {
  return {
    id: `break-${f.spell.toLowerCase()}`,
    name: `${f.spell} broke`,
    enabled: true,
    trigger: f.trigger,
    sound: { packId: 'p', soundId: 's' },
    // Zero, so a single fire is the feature rather than the cooldown hiding a second one.
    cooldownMs: 0,
    ...(sec === undefined ? {} : { earlyWarnSec: sec })
  }
}

/** The wear-off sentence — one shape for all five families; the parser routes it three ways. */
function breakLine(f: Family, sec: number): string {
  return line(sec, `Your ${f.spell} spell has worn off of ${f.mob}.`)
}

/** The row the model builds for this family's landing — the number every expectation derives from. */
function landedRow(f: Family): BuffTimerRow {
  const { rows } = replayBuffTimers([line(0, f.cast), line(1, f.landing)], { until: LAND_TS })
  const row = rows.find((r) => r.targetKey === f.mob.toLowerCase())
  assert.ok(row, `${f.title}: the landing must build a timer row`)
  assert.equal(row.mode, 'countdown', `${f.title}: the model must state an end for it`)
  assert.equal(row.startedTs, LAND_TS)
  return row
}

for (const f of FAMILIES) {
  test(`${f.title}: the warning fires ${String(f.sec)}s early, and the break then says nothing more`, () => {
    const row = landedRow(f)
    const due = earlyWarnFireAt(row, f.sec)
    assert.ok(due != null && due > LAND_TS, 'the warning must be in the future at the landing')
    // The hold runs its full stated course and the wear-off line arrives at the end of it.
    const endSec = 1 + (row.durationMs ?? 0) / 1_000
    const lines = [line(0, f.cast), line(1, f.landing), breakLine(f, endSec)]

    const fires = replayAlertLines(lines, [familyDef(f, f.sec)], T0.getTime() + (endSec + 3) * 1_000)
    assert.equal(fires.length, 1, 'ONE firing for one landing — the warning, not the break as well')
    assert.equal(fires[0].ts, due, 'and it lands at the row`s estimated end minus the offset')
    assert.equal(fires[0].spell, f.spell, 'it says the spell the break line would have named')
    // A PROJECTION, not a log line: this firing is made from the timer model, and says so.
    assert.match(fires[0].matchedText, new RegExp(`^${f.spell.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&')} on `))
    assert.match(fires[0].matchedText, /is about to end$/)
  })

  test(`${f.title}: a break BEFORE the deadline fires AT the break — never silent`, () => {
    const broke = breakLine(f, 3)
    const lines = [line(0, f.cast), line(1, f.landing), broke]
    const fires = replayAlertLines(lines, [familyDef(f, f.sec)], T0.getTime() + 400 * 1_000)
    assert.equal(fires.length, 1, 'the alert must speak exactly once')
    assert.equal(fires[0].ts, T0.getTime() + 3_000, 'at the break, which is what the user needs to hear')
    assert.equal(fires[0].matchedText, broke, 'and it is the real line, not a projection')
  })

  test(`${f.title}: with no offset at all the alert is byte-for-byte today's`, () => {
    const row = landedRow(f)
    const endSec = 1 + (row.durationMs ?? 0) / 1_000
    const to = T0.getTime() + (endSec + 3) * 1_000
    for (const at of [3, endSec]) {
      const broke = breakLine(f, at)
      const fires = replayAlertLines([line(0, f.cast), line(1, f.landing), broke], [familyDef(f)], to)
      assert.equal(fires.length, 1, 'one firing')
      assert.equal(fires[0].ts, T0.getTime() + at * 1_000, 'when the break line arrives, and never before')
      assert.equal(fires[0].matchedText, broke)
    }
  })
}

test('a hold that is re-cast after its warning gets a SECOND warning — one per landing', () => {
  const f = FAMILIES[0]
  const row = landedRow(f)
  const span = (row.durationMs ?? 0) / 1_000
  const relandSec = 1 + span + 1
  const lines = [
    line(0, f.cast),
    line(1, f.landing),
    breakLine(f, 1 + span),
    line(relandSec - 1, f.cast),
    line(relandSec, f.landing),
    breakLine(f, relandSec + span)
  ]
  const fires = replayAlertLines(lines, [familyDef(f, f.sec)], T0.getTime() + (relandSec + span + 3) * 1_000)
  assert.equal(fires.length, 2, 'two landings, two warnings — and neither break spoke on top of one')
  assert.equal(fires[0].ts, LAND_TS + (span - f.sec) * 1_000)
  assert.equal(fires[1].ts, T0.getTime() + (relandSec + span - f.sec) * 1_000)
})

test('the classifier reads a break trigger the way the module`s own matcher does', () => {
  const mez = FAMILIES[0]
  // The `refresh` matcher may be written as a literal or as a `/regex/`, and `matcherAccepts`
  // mirrors `compileFieldMatch` for both. The pin is BEHAVIORAL: the regex form must schedule
  // exactly like the literal one, which can only be true if the two readings agree.
  const regexForm: AlertTrigger = {
    type: 'event',
    kind: 'cc',
    where: { spell: 'Dazzle', refresh: '/^true$/' }
  }
  assert.equal(breakTriggerKinds(regexForm).length, 1)
  assert.deepEqual(breakTriggerKinds(mez.trigger), ['cc'])
  // A LANDING-triggered def is not in this family at all — JOS-216's behavior is untouched.
  assert.deepEqual(breakTriggerKinds({ type: 'event', kind: 'cc' }), [])
  assert.deepEqual(breakTriggerKinds({ type: 'event', kind: 'buffApply', where: { target: 'a scareling' } }), [])
  // Neither is a raw pattern: there is no hypothetical LINE to offer it (shared/earlyWarning.ts).
  assert.deepEqual(breakTriggerKinds({ type: 'raw', regex: 'has worn off of' }), [])
  // And a composite is break-family only when EVERY condition is.
  const wearsOff: AlertTrigger = {
    type: 'any',
    conditions: [
      { type: 'event', kind: 'buffExpired', where: { spell: 'Clarity' } },
      { type: 'event', kind: 'buffWearOff', where: { spell: 'Clarity' } }
    ]
  }
  assert.deepEqual(breakTriggerKinds(wearsOff), ['buffExpired', 'buffWearOff'])
  assert.deepEqual(
    breakTriggerKinds({
      type: 'any',
      conditions: [
        { type: 'event', kind: 'uncharm' },
        { type: 'event', kind: 'buffApply', where: { target: 'a scareling' } }
      ]
    }),
    [],
    'a mixed composite keeps the landing behavior rather than half of each'
  )

  const row = landedRow(mez)
  const endSec = 1 + (row.durationMs ?? 0) / 1_000
  const lines = [line(0, mez.cast), line(1, mez.landing), breakLine(mez, endSec)]
  const fires = replayAlertLines(
    lines,
    [{ ...familyDef(mez, mez.sec), trigger: regexForm }],
    T0.getTime() + (endSec + 3) * 1_000
  )
  assert.equal(fires.length, 1)
  assert.equal(fires[0].ts, earlyWarnFireAt(row, mez.sec))
})

test('an offset longer than the spell warns nothing, and the break still fires', () => {
  const f = FAMILIES[5] // Largo's, 18s in the DB — nothing can warn 120s before that.
  const row = landedRow(f)
  const endSec = 1 + (row.durationMs ?? 0) / 1_000
  const broke = breakLine(f, endSec)
  const fires = replayAlertLines(
    [line(0, f.cast), line(1, f.landing), broke],
    [familyDef(f, MAX_EARLY_WARN_SEC)],
    T0.getTime() + (endSec + 3) * 1_000
  )
  assert.equal(fires.length, 1, 'the alert is never silent')
  assert.equal(fires[0].matchedText, broke, 'and what it reports is the break itself')
})

