// What's new (src/shared/releaseNotes.ts) — JOS-73.
//
// TWO CLAIMS ARE UNDER TEST AND THEY ARE DIFFERENT KINDS OF CLAIM.
//
//   THE DATA. `RELEASE_NOTES` is hand-written and grows by one entry per release forever, which
//   makes it exactly the sort of file that acquires a duplicate version, a date typed in the
//   wrong order, or a row inserted in the wrong place — none of which would throw, and all of
//   which would quietly break the ordering every derivation below assumes. `releaseNotesProblems`
//   is the shape check, and it is the SAME function the release job runs
//   (scripts/check-release-notes.mjs), so a tag that ships is a tag whose notes passed this.
//
//   THE DERIVATION. "Which releases are new to this install" is a pure function of one stored
//   string, and every state it can be in is reachable here in a line: the fresh install that must
//   see nothing, the one-release upgrade, and the A→D case — 0.6.3 landing on 0.8.0 marks BOTH
//   0.7.0 and 0.8.0, which is the whole reason the key stores a version instead of a boolean.
//
// No Electron, no store file, no renderer: shared/releaseNotes.ts is a zero-import pure module,
// so this suite is as cheap and as unskippable as graphicsPrefs/overlayLayout.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RELEASE_NOTES,
  compareVersions,
  hasReleaseNote,
  hasReportedEntry,
  latestReleaseVersion,
  parseVersion,
  releaseNotesProblems,
  variantLastSeen,
  whatsNewState,
  type ReleaseNote
} from '../src/shared/releaseNotes'

// A small fixture list so the derivation tests do not move every time a release ships.
const NOTES: readonly ReleaseNote[] = [
  { version: '0.8.0', date: '2026-08-07', entries: [{ kind: 'new', text: 'Eight.' }] },
  { version: '0.7.0', date: '2026-08-07', entries: [{ kind: 'fixed', text: 'Seven.' }] },
  { version: '0.6.3', date: '2026-08-06', entries: [{ text: 'Six three.' }] },
  { version: '0.6.2', date: '2026-08-05', entries: [{ text: 'Six two.' }] },
  { version: '0.6.1', date: '2026-08-05', entries: [{ text: 'Six one.' }] }
]

// ---------------------------------------------------------------- the data

test('the committed notes are sound: ordering, versions, dates, entries', () => {
  assert.deepEqual(releaseNotesProblems(), [], 'src/shared/releaseNotes.ts has problems')
})

test('the newest note is the head of the list, and that is what an install gets stamped with', () => {
  assert.equal(latestReleaseVersion(), RELEASE_NOTES[0]!.version)
  // The stamp must be a real release, or the next launch would find everything newer than a
  // version that never shipped.
  assert.ok(hasReleaseNote(latestReleaseVersion()))
})

test('releaseNotesProblems CATCHES the mistakes this file will actually acquire', () => {
  const bad = (notes: ReleaseNote[]): string => releaseNotesProblems(notes).join(' | ')

  // Out of order — a row pasted at the bottom instead of the top.
  assert.match(
    bad([
      { version: '0.7.0', date: '2026-08-07', entries: [{ text: 'a' }] },
      { version: '0.8.0', date: '2026-08-07', entries: [{ text: 'b' }] }
    ]),
    /newest first/
  )
  // A duplicated version — "strictly below" is what rejects it.
  assert.match(
    bad([
      { version: '0.8.0', date: '2026-08-07', entries: [{ text: 'a' }] },
      { version: '0.8.0', date: '2026-08-07', entries: [{ text: 'b' }] }
    ]),
    /strictly below/
  )
  // A date in the wrong format, an empty release, an empty line, an invented kind.
  assert.match(bad([{ version: '0.8.0', date: '08/07/2026', entries: [{ text: 'a' }] }]), /YYYY-MM-DD/)
  assert.match(bad([{ version: '0.8.0', date: '2026-08-07', entries: [] }]), /no entries/)
  assert.match(bad([{ version: '0.8.0', date: '2026-08-07', entries: [{ text: '  ' }] }]), /no text/)
  assert.match(
    bad([
      {
        version: '0.8.0',
        date: '2026-08-07',
        entries: [{ kind: 'improved' as 'new', text: 'a' }]
      }
    ]),
    /unknown kind/
  )
  // fromReport is a FLAG: present means true. A stored `false` would read as "we checked and it
  // wasn't a report", which is a claim this file has no way to make.
  assert.match(
    bad([
      {
        version: '0.8.0',
        date: '2026-08-07',
        entries: [{ text: 'a', fromReport: false }]
      }
    ]),
    /fromReport is a flag/
  )
  assert.match(bad([]), /empty/)
})

// ------------------------------------------------------------------ bullets

// "No bullet carries three features" is NOT testable by counting commas, and the attempt is
// recorded here because it looked testable and is not: the first version of this suite rejected
// "Suggested alerts for slows wearing off, mote drops, and receiving tells", which is ONE feature
// listing the three things it watches, and would have equally rejected "the install folder, the
// Logs folder, or a log file" — one setting, three inputs. A comma is not evidence of a packed
// list, and a test that says it is teaches the next author to write worse sentences to satisfy it.
//
// What IS decidable is the COUNT: the defect this ticket fixed was a release with four changes in
// its tag range shipping as one bullet, and a release's bullet count is a fact. That is what the
// test below pins, and the prose stays a review question.

/**
 * The releases that INTRODUCED a surface (JOS-80), and how many bullets each introduction spends.
 *
 * They are listed here rather than derived because "is this an introduction" is an editorial
 * judgment the data deliberately does not encode — the owner's ruling was plain bullets in the
 * same list, no flag, no second rendering, so nothing in `ReleaseEntry` marks one. The count is
 * still a fact, and the CAP is the part worth defending: at most five bullets, or the contrast
 * that makes an introduction stand out is gone and the panel is a wall of prose.
 */
const INTRODUCTIONS: readonly { version: string; bullets: number }[] = [
  // 0.9.0: the What's new panel (3) and the "This week" lockout view (3).
  { version: '0.9.0', bullets: 3 },
  // 0.4.0: the exaltation planner (3) and the celebration cards (3).
  { version: '0.4.0', bullets: 3 },
  // 0.3.0: in-app feedback (3).
  { version: '0.3.0', bullets: 3 }
]

/** The cap the owner set: an introduction may spend at most five bullets on itself. */
const MAX_INTRODUCTION_BULLETS = 5

test('an introduction stays under the five-bullet cap', () => {
  for (const i of INTRODUCTIONS) {
    assert.ok(
      i.bullets >= 2 && i.bullets <= MAX_INTRODUCTION_BULLETS,
      `v${i.version}'s introduction spends ${String(i.bullets)} bullets — the rule is 2 to ${String(MAX_INTRODUCTION_BULLETS)}`
    )
  }
})

test('a release states one change per bullet, and multi-change releases have several', () => {
  const counts = new Map(RELEASE_NOTES.map((n) => [n.version, n.entries.length]))
  // The two releases authored with full per-change detail keep it…
  assert.equal(counts.get('0.8.0'), 6)
  assert.equal(counts.get('0.7.0'), 6)
  // …the ordinary backfilled releases stay at one bullet per change…
  for (const v of ['0.6.3', '0.6.2', '0.6.0', '0.5.0', '0.3.5', '0.3.1', '0.2.0']) {
    const n = counts.get(v) ?? 0
    assert.ok(n >= 2 && n <= 4, `v${v} should be 2-4 bullets, got ${String(n)}`)
  }
  // …and the releases that introduced a surface are LARGER, by exactly the extra bullets those
  // introductions spend. Pinned as totals so a surface's prose cannot quietly grow unbounded.
  assert.equal(counts.get('0.9.0'), 9, 'five changes, two of them introductions worth 3 bullets each')
  assert.equal(counts.get('0.4.0'), 8, 'four changes, two of them introductions worth 3 bullets each')
  assert.equal(counts.get('0.3.0'), 6, 'four changes, one of them an introduction worth 3 bullets')
  // Releases that genuinely did one thing stay at one bullet — padding them would be inventing.
  for (const v of ['0.6.1', '0.3.4', '0.3.2', '0.2.1']) {
    assert.equal(counts.get(v), 1, `v${v} did one thing and should say so once`)
  }
})

// A BULLET IS SHORT (owner, 2026-09-03). Three sentences at most — the outcome, optionally why it
// was wrong, optionally what changed — and a character ceiling so three sentences cannot become
// three paragraphs. Applied from 1.16.0 on: the older entries were written before the rule and
// are history, not a template (the file header states the shape).
const SHORT_NOTES_FROM = '1.16.0'
const MAX_NOTE_SENTENCES = 3
const MAX_NOTE_CHARS = 320

function sentencesOf(text: string): number {
  return (text.match(/[.!?](\s|$)/g) ?? []).length
}

test('a release note bullet is short: three sentences and 320 characters at most, from 1.16.0 on', () => {
  const governed = RELEASE_NOTES.filter((n) => compareVersions(n.version, SHORT_NOTES_FROM) >= 0)
  assert.ok(governed.length >= 1, 'the rule governs at least the release that introduced it')
  for (const note of governed) {
    for (const entry of note.entries) {
      const sentences = sentencesOf(entry.text)
      assert.ok(
        sentences <= MAX_NOTE_SENTENCES,
        `v${note.version}: ${String(sentences)} sentences in one bullet — outcome, cause, change; a second visible thing is a second bullet: "${entry.text.slice(0, 60)}…"`
      )
      assert.ok(
        entry.text.length <= MAX_NOTE_CHARS,
        `v${note.version}: ${String(entry.text.length)} characters in one bullet (ceiling ${String(MAX_NOTE_CHARS)}): "${entry.text.slice(0, 60)}…"`
      )
    }
  }
})

// ------------------------------------------------------------------- thanks

test('THANKS IS EARNED: only tagged entries carry the flag, and only tagged releases thank', () => {
  const tagged = new Map(
    RELEASE_NOTES.map((n) => [n.version, n.entries.filter((e) => e.fromReport === true).length])
  )
  // The releases whose work traceably came from player reports (each cited in the commit that
  // did it — a report id, "the YouTube report", "Mac/CrossOver user report").
  assert.equal(tagged.get('0.8.0'), 5)
  assert.equal(tagged.get('0.7.0'), 3)
  assert.equal(tagged.get('0.6.3'), 1)
  assert.equal(tagged.get('0.6.1'), 1)
  assert.equal(tagged.get('0.6.0'), 2)
  assert.equal(tagged.get('0.5.0'), 1)
  // …and everything else is UNTAGGED. An unearned thanks costs more than a missing one, so the
  // releases whose defects the owner found himself (0.3.4's charm broadcast) do not claim one.
  for (const v of ['0.6.2', '0.4.0', '0.3.5', '0.3.4', '0.3.2', '0.3.1', '0.3.0', '0.2.1', '0.2.0']) {
    assert.equal(tagged.get(v), 0, `v${v} has no traceable report behind it and must not thank`)
  }
})

test('hasReportedEntry decides the thanks line, and agrees with the entries', () => {
  for (const n of RELEASE_NOTES) {
    assert.equal(
      hasReportedEntry(n),
      n.entries.some((e) => e.fromReport === true),
      `v${n.version}`
    )
  }
  assert.equal(hasReportedEntry(RELEASE_NOTES.find((n) => n.version === '0.8.0')!), true)
  assert.equal(hasReportedEntry(RELEASE_NOTES.find((n) => n.version === '0.2.0')!), false)
})

test('NOBODY IS EVER NAMED — no entry carries a report id, a handle or a contact', () => {
  for (const n of RELEASE_NOTES) {
    for (const e of n.entries) {
      assert.ok(!/\b01[0-9A-HJKMNP-TV-Z]{24}\b/.test(e.text), `v${n.version} carries a report ULID`)
      assert.ok(!/[\w.+-]+@[\w-]+\.\w+/.test(e.text), `v${n.version} carries an email address`)
      assert.ok(!/thanks to \w/i.test(e.text), `v${n.version} thanks somebody by name in a bullet`)
    }
  }
})

// ---------------------------------------------------------------- versions

test('version comparison orders the triple, and a release outranks its own prereleases', () => {
  assert.equal(compareVersions('0.8.0', '0.7.0'), 1)
  assert.equal(compareVersions('0.6.3', '0.6.10'), -1, 'patch is numeric, not lexical')
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1, 'minor is numeric, not lexical')
  assert.equal(compareVersions('0.8.0', '0.8.0'), 0)
  assert.equal(compareVersions('v0.8.0', '0.8.0'), 0, 'a tag name and a version are the same value')
  assert.equal(compareVersions('0.8.0', '0.8.0-main.3'), 1)
  assert.equal(compareVersions('0.8.0-main.3', '0.8.0'), -1)
  // Unparseable reads as 0.0.0 — the SAFE direction: a junk stored value makes every release
  // look new rather than silently hiding one.
  assert.deepEqual(parseVersion('nonsense'), { major: 0, minor: 0, patch: 0, pre: '' })
  assert.equal(compareVersions('0.2.0', 'nonsense'), 1)
})

test('hasReleaseNote answers a TAG, prerelease tail and leading v included', () => {
  assert.ok(hasReleaseNote('v0.8.0', NOTES))
  assert.ok(hasReleaseNote('0.8.0-main.7', NOTES), 'a prerelease of a release that has notes')
  assert.ok(!hasReleaseNote('v0.9.0', NOTES), 'a version with no entry is the CI gate firing')
})

// ---------------------------------------------------------------- the state

test('A FRESH INSTALL HAS NO NEWS — no teaser, nothing marked', () => {
  for (const absent of [null, undefined, '', '   ']) {
    const s = whatsNewState(absent, NOTES)
    assert.equal(s.fresh, true)
    assert.deepEqual(s.newVersions, [])
    assert.equal(s.teaserVersion, null, 'a person who installed today did not live through 0.8.0')
  }
})

test('a one-release upgrade marks one release and names it', () => {
  const s = whatsNewState('0.7.0', NOTES)
  assert.equal(s.fresh, false)
  assert.deepEqual(s.newVersions, ['0.8.0'])
  assert.equal(s.teaserVersion, '0.8.0')
})

test('A→D: 0.6.3 landing on 0.8.0 marks BOTH 0.7.0 and 0.8.0, and the teaser names only the newest', () => {
  const s = whatsNewState('0.6.3', NOTES)
  assert.deepEqual(s.newVersions, ['0.8.0', '0.7.0'], 'newest first, everything since last seen')
  assert.equal(s.teaserVersion, '0.8.0', 'one line about where you landed, not a list of what you missed')
})

test('an install already on the newest release has nothing new and no teaser', () => {
  const s = whatsNewState('0.8.0', NOTES)
  assert.equal(s.fresh, false, 'dismissed is NOT the same state as never-installed')
  assert.deepEqual(s.newVersions, [])
  assert.equal(s.teaserVersion, null)
})

test('a store from a NEWER build (downgrade) claims no news rather than inventing some', () => {
  const s = whatsNewState('9.9.9', NOTES)
  assert.deepEqual(s.newVersions, [])
  assert.equal(s.teaserVersion, null)
})

// ------------------------------------------------------------ dev variants

test('the DEV variant control drives exactly the three states, from the notes themselves', () => {
  assert.equal(variantLastSeen('fresh', NOTES), null)
  assert.equal(variantLastSeen('previous', NOTES), '0.7.0')
  assert.equal(variantLastSeen('several', NOTES), '0.6.1')

  // …and each one lands the state it is named for.
  assert.deepEqual(whatsNewState(variantLastSeen('fresh', NOTES), NOTES).newVersions, [])
  assert.deepEqual(whatsNewState(variantLastSeen('previous', NOTES), NOTES).newVersions, ['0.8.0'])
  assert.deepEqual(whatsNewState(variantLastSeen('several', NOTES), NOTES).newVersions, [
    '0.8.0',
    '0.7.0',
    '0.6.3',
    '0.6.2'
  ])
})

test('the variants never name a version off the end of a short list', () => {
  const one: readonly ReleaseNote[] = [NOTES[0]!]
  assert.equal(variantLastSeen('previous', one), '0.8.0')
  assert.equal(variantLastSeen('several', one), '0.8.0')
  assert.equal(variantLastSeen('previous', []), null)
  assert.equal(variantLastSeen('several', []), null)
})
