// JOS-178 golden tests: FIND AN ALERT BY ANYTHING YOU REMEMBER ABOUT IT.
//
// The owner's ask (2026-08-09): alerts become searchable locally, with a deliberately WIDE match
// set — the name, the spell the trigger watches, the trigger's kind, the sound pack, the sound,
// the spoken phrase, and the note.
//
// WHAT IS PINNED HERE, and why it is a unit test rather than a spec:
//
//  1. EVERY FACET, ONE TEST EACH. A facet that silently stops being searched is invisible in the
//     app — the box simply finds less — so each one gets a query that ISOLATES it: a word that
//     appears in that facet and nowhere else in the corpus. "The phrase is searchable" is then a
//     failing assertion rather than a thing somebody notices in a month.
//  2. THE SEARCH IS THE HOUSE ONE. `shared/fuzzy.ts` is the scorer behind fight search, the Mobs
//     tab and the map/zone pickers, so typo tolerance and the every-token-must-match exclusion
//     rule come for free — and are pinned here, because "we reused the tokenizer" is exactly the
//     kind of claim that decays into a hand-rolled substring test.
//  3. FILTER, NEVER RANK. The alerts list is the STORED ARRAY, so a filtered list must be that same
//     sequence with rows removed. Re-sorting by score would make the filtered view a different list
//     than the one the rows came out of — rows jumping under a keystroke and settling somewhere
//     else when the box clears.
//  4. CLEARING RESTORES THE LIST — as IDENTITY, not as an equal-looking rebuild.
//
// The wiring — where the box lives, what the list renders, and that the query is deferred — is
// SOURCE-PINNED at the bottom and driven for real in tests/e2e/alerts-search.e2e.mts. So is the
// ABSENCE of the drag-to-reorder experiment JOS-179 removed: it never shipped, and the search
// plumbing is simpler for not having to suspend it.
//
// Run: `npm test`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  alertFacets,
  alertHaystack,
  filterAlerts,
  indexPacks,
  matchesAlert
} from '../src/renderer/src/features/alerts/alertSearch'
import { tokenize } from '../src/shared/fuzzy'
import type { AlertDef, SoundPack } from '../src/shared/types'

const src = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8')

// ── the corpus ────────────────────────────────────────────────────────────────────────
//
// Shaped like the real thing: the seeded charm-break def (event kind, a provenance note), a
// spell-scoped `where` trigger that also speaks, an app signal, a `raw` pattern for a family with
// no typed event (the Puma case, JOS-103), and a composite. One def points at a pack that is not
// installed, which is the ordinary state of a shared alert.

const PACKS: SoundPack[] = [
  {
    id: 'alan-rickman',
    name: 'Alan Rickman',
    source: 'bundled',
    sounds: {
      'charm-break': { file: 'charm.wav', label: 'I find myself requiring your attention' },
      'boss-defeat': { file: 'boss.wav', label: 'The matter is settled' }
    }
  },
  {
    id: 'peon',
    name: 'Warcraft Peon',
    source: 'user',
    sounds: { 'work-work': { file: 'ww.wav', label: 'Work work' } }
  }
]

const CHARM: AlertDef = {
  id: 'a1',
  name: 'Charm break',
  enabled: true,
  trigger: { type: 'event', kind: 'uncharm' },
  sound: { packId: 'alan-rickman', soundId: 'charm-break' },
  note: 'Seeded default - fires when a charm spell wears off (you lose your pet).'
}

const HASTE: AlertDef = {
  id: 'a2',
  name: 'Haste faded',
  enabled: true,
  trigger: { type: 'event', kind: 'buffExpired', where: { spell: 'Swift Like the Wind' } },
  sound: { packId: 'peon', soundId: 'work-work' },
  audio: 'speech',
  speech: { mode: 'custom', phrase: 'your quickness is gone' }
}

const BOSS: AlertDef = {
  id: 'a3',
  name: 'Raid target defeated',
  enabled: true,
  trigger: { type: 'app', signal: 'bossDefeat' },
  sound: { packId: 'alan-rickman', soundId: 'boss-defeat' }
}

const PUMA: AlertDef = {
  id: 'a4',
  name: 'Puma growl',
  enabled: false,
  trigger: { type: 'raw', regex: 'growls with the spirit of the wilderness' },
  // A pack this user does not have — a shared def, or a pack they removed.
  sound: { packId: 'nightfall-horns', soundId: 'reveille' }
}

const MEZ: AlertDef = {
  id: 'a5',
  name: 'Hold broke',
  enabled: true,
  trigger: {
    type: 'any',
    conditions: [
      { type: 'event', kind: 'cc', where: { spell: 'Mesmerization', refresh: 'true' } },
      { type: 'event', kind: 'buffWearOff' }
    ]
  },
  sound: { packId: 'peon', soundId: 'work-work' }
}

const ALERTS: AlertDef[] = [CHARM, HASTE, BOSS, PUMA, MEZ]

/** Ids the box would leave on screen for `q`. */
const found = (q: string, list: readonly AlertDef[] = ALERTS): string[] =>
  filterAlerts(list, PACKS, q).map((d) => d.id)

// ── 1. every facet ────────────────────────────────────────────────────────────────────

test('the NAME is searchable', () => {
  assert.deepEqual(found('haste'), ['a2'])
  assert.deepEqual(found('raid'), ['a3'])
})

test('the TRIGGER SPELL is searchable — the `where.spell` a row only shows in its badge', () => {
  // "Swift Like the Wind" lives nowhere but that matcher, and this alert is named "Haste faded".
  assert.deepEqual(found('swift'), ['a2'])
  // …including inside a composite condition, which is where a mez alert keeps its spell (JOS-161).
  assert.deepEqual(found('mesmerization'), ['a5'])
})

test('the TRIGGER KIND / event is searchable, composites and app signals included', () => {
  assert.deepEqual(found('buffExpired'), ['a2'])
  assert.deepEqual(found('bossDefeat'), ['a3'])
  // The shape word too: only the composite renders `any(`.
  assert.deepEqual(found('any'), ['a5'])
  // And a `raw` trigger's own pattern text, which is the only thing some families have.
  assert.deepEqual(found('wilderness'), ['a4'])
})

test('the SOUND PACK is searchable by display name and by id', () => {
  assert.deepEqual(found('rickman'), ['a1', 'a3'])
  assert.deepEqual(found('peon'), ['a2', 'a5'])
})

test('the SOUND is searchable by id and by the pack’s own label', () => {
  assert.deepEqual(found('reveille'), ['a4'], 'the id, even when the pack is not installed')
  assert.deepEqual(found('settled'), ['a3'], 'the label the sound picker shows')
})

test('the SPEECH PHRASE is searchable', () => {
  // The alert is named "Haste faded"; nothing but the spoken phrase says "quickness".
  assert.deepEqual(found('quickness'), ['a2'])
})

test('the NOTE is searchable', () => {
  assert.deepEqual(found('seeded'), ['a1'])
})

test('a def whose pack is missing still searches, and never throws', () => {
  const facets = alertFacets(PUMA, indexPacks(PACKS))
  assert.ok(facets.includes('nightfall-horns'), 'the id survives even with no pack behind it')
  assert.equal(
    facets.some((f) => f === ''),
    false,
    'an absent pack name is dropped, never carried as an empty facet'
  )
  assert.deepEqual(found('nightfall'), ['a4'])
})

test('every facet the header promises is in the haystack, by construction', () => {
  const facets = alertFacets(HASTE, indexPacks(PACKS))
  assert.deepEqual(facets, [
    'Haste faded',
    'event:buffExpired {spell=Swift Like the Wind}',
    'peon',
    'Warcraft Peon',
    'work-work',
    'Work work',
    'your quickness is gone'
  ])
  // The badge is the ROW's own string, not a second opinion assembled here (see alertSearch.ts).
  assert.ok(facets[1].includes('{spell=Swift Like the Wind}'))
})

// ── 2. the search is the house one ────────────────────────────────────────────────────

test('matching is case-insensitive in both directions', () => {
  assert.deepEqual(found('CHARM BREAK'), ['a1'])
  assert.deepEqual(found('rIcKmAn'), ['a1', 'a3'])
})

test('the house tokenizer’s typo tolerance is inherited, not re-invented', () => {
  assert.deepEqual(found('mesmerizaton'), ['a5'], 'one deletion')
  assert.deepEqual(found('wildreness'), ['a4'], 'one transposition')
})

test('a prefix finds the token it starts, so half a word is enough', () => {
  assert.deepEqual(found('mesmer'), ['a5'])
  assert.deepEqual(found('defeat'), ['a3'], 'inside `bossDefeat`, which tokenizes as one word')
})

test('EVERY query token must match — two words narrow, they never widen', () => {
  assert.deepEqual(found('rickman charm'), ['a1'], 'a3 has the pack but not the word')
  assert.deepEqual(found('charm zzzzzzz'), [], 'one unanswerable token excludes the record')
})

test('punctuation is noise — the query and the haystack tokenize the same way', () => {
  assert.deepEqual(found('{spell=swift}'), ['a2'])
  assert.deepEqual(found('work-work'), ['a2', 'a5'])
})

// ── 3. filter, never rank ─────────────────────────────────────────────────────────────

test('a filtered list is the STORED order with rows removed, never a ranking', () => {
  assert.deepEqual(found('peon'), ['a2', 'a5'])
  // The same two alerts, the stored array the other way round: the answer follows the list.
  assert.deepEqual(found('peon', [MEZ, BOSS, HASTE]), ['a5', 'a2'])
  // An exact name hit does not climb over a note hit — position is the list's business.
  assert.deepEqual(found('charm', [HASTE, CHARM]), ['a1'])
})

// ── 4. clearing restores the list ─────────────────────────────────────────────────────

test('an empty query answers with the SAME array — clearing the box is identity, not a rebuild', () => {
  assert.equal(filterAlerts(ALERTS, PACKS, ''), ALERTS)
  assert.equal(filterAlerts(ALERTS, PACKS, '   '), ALERTS)
  assert.equal(filterAlerts(ALERTS, PACKS, '///'), ALERTS, 'a query with no tokens says nothing')
  assert.equal(matchesAlert([], alertHaystack(CHARM, indexPacks(PACKS))), true)
})

test('a query nothing answers leaves an empty list, not the full one', () => {
  assert.deepEqual(found('vorpal'), [])
})

test('the haystack is tokens, computed from the facets — the hook may cache it per list change', () => {
  const hay = alertHaystack(CHARM, indexPacks(PACKS))
  assert.deepEqual(hay, tokenize(alertFacets(CHARM, indexPacks(PACKS)).join(' ')))
  assert.ok(hay.includes('uncharm') && hay.includes('rickman') && hay.includes('seeded'))
})

// ── 5. SOURCE PINS: the wiring, and the reorder that is not there ─────────────────────
//
// JOS-175/JOS-177 shipped a drag-to-reorder gesture that JOS-178 then had to SUSPEND, because a
// drop position in a list with holes in it names no gap in the stored order. JOS-179 removed the
// gesture instead (owner ruling, 2026-08-09 — it never shipped, 0.18.0 was untagged), and with it
// went the whole of that argument: there is no `canReorder`, no greyed grip, and nothing for a
// filter to withdraw. The list order is the STORED ARRAY and always was.
//
// This is pinned rather than assumed because the parts came back out of five files and a channel,
// and a half-removal is exactly the shape that leaves a dead grip on a row or a live IPC door on
// main. Named strings and paths only — a bare /drag/ sweep would catch the volume slider.

test('SOURCE PIN: the reorder experiment is gone — no module, no gesture, no channel', () => {
  const gone = [
    'shared/alertOrder.ts',
    'renderer/src/features/alerts/useAlertReorder.ts',
    'renderer/src/features/alerts/dropTarget.ts'
  ]
  for (const rel of gone) {
    assert.equal(
      existsSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url))),
      false,
      `${rel} was deleted with the feature`
    )
  }

  const ipc = src('shared/ipc.ts')
  assert.equal(/reorderAlerts|alerts:reorder/.test(ipc), false, 'the channel is not declared')
  assert.equal(
    /reorderAlerts/.test(src('preload/index.ts')),
    false,
    'the preload offers no door to it'
  )
  assert.equal(
    /reorderAlerts|applyAlertOrder/.test(src('main/store.ts')),
    false,
    'main stores the array it is given, with no re-ordering accessor'
  )

  const list = src('renderer/src/features/alerts/AlertList.tsx')
  assert.equal(/alert-reorder-grip|draggable|DropIndicator/.test(list), false, 'no row affordance')
  assert.equal(
    /onReorder/.test(src('renderer/src/features/alerts/AlertsView.tsx')),
    false,
    'and nothing wired behind one'
  )
})

test('SOURCE PIN: `filtering` survives, and its ONE job is what an empty list says', () => {
  const list = src('renderer/src/features/alerts/AlertList.tsx')
  assert.match(list, /filtering: boolean/, 'the list still knows whether it is narrowed')
  assert.match(
    list,
    /filtering\s*\n?\s*\?\s*'No alerts match that search\.'/,
    'because "nothing matches" and "you have no alerts yet" are two different sentences'
  )
})

test('SOURCE PIN: the box is in the toolbar and the narrowed list is what renders', () => {
  const toolbar = src('renderer/src/features/alerts/AlertsToolbar.tsx')
  assert.match(toolbar, /data-testid="alerts-search"/, 'the handle the e2e types into')
  assert.match(toolbar, /data-testid="alerts-search-clear"/, '…and the one that empties it')

  const view = src('renderer/src/features/alerts/AlertsView.tsx')
  assert.match(view, /useAlertFilter\(alerts, sortedPacks\)/)
  assert.match(view, /alerts=\{filter\.visible\}/, 'the list renders the narrowed set')
  assert.match(view, /filtering=\{filter\.filtering\}/, '…and knows that it is narrowed')
})

test('SOURCE PIN: the box searches a DEFERRED query, the house search pattern', () => {
  const hook = src('renderer/src/features/alerts/useAlertFilter.ts')
  assert.match(hook, /useDeferredValue\(query\)/, 'typing never waits on the list')
  assert.match(hook, /tokenize\(deferred\)/, '…and `filtering` reads the same deferred answer')
  assert.match(
    hook,
    /const haystacks = useMemo\(/,
    'the haystacks are built per list change, never per keystroke'
  )
})
