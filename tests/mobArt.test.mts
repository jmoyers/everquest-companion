// MAPS — the hovered pin's portrait (src/renderer/src/features/maps/mobArt.ts): which bundled
// boss art a mob name resolves to, and that the index is built ONCE PER ROSTER ARRAY.
//
// Two claims. THE FOLD is the raid roster's own matching posture — case- and article-insensitive,
// over the display name AND every `match` spelling — so the pin card and the boss card agree about
// who has a face. THE CACHE is keyed on the array `getBossData()` hands back, which is
// profile-keyed: a module-level "built once" would serve the first profile's art to the second for
// the life of the window. A WeakMap on the array (crossZone.ts's HAYSTACKS idiom) rebuilds exactly
// when the roster is a different object, and not otherwise.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { RaidTarget } from '../src/shared/types'
import { foldMobName, mobPortraitUrl, portraitIndex } from '../src/renderer/src/features/maps/mobArt'

const ROSTER: RaidTarget[] = [
  { name: 'Lord Nagafen', category: 'Dragons', match: ['Lord Nagafen'], image: 'https://wiki.example/nagafen.png' },
  { name: 'The Avatar of Fear', category: 'Gods', match: ['Cazic Thule', 'Avatar of Fear'], image: 'https://wiki.example/ct.png' },
  { name: 'Faceless One', category: 'Gods', match: ['Faceless One'] }
]

test('the fold: lowercase, leading article stripped, whole-word only', () => {
  assert.equal(foldMobName('The Avatar of Fear'), 'avatar of fear')
  assert.equal(foldMobName('A Skeleton'), 'skeleton')
  assert.equal(foldMobName('an orc pawn'), 'orc pawn')
  assert.equal(foldMobName('Anaconda'), 'anaconda', 'the article must be a whole word')
})

test('a name reaches the art by its display name OR any match spelling; no image ⇒ no entry', () => {
  const index = portraitIndex(ROSTER)
  assert.equal(index.get('lord nagafen'), 'https://wiki.example/nagafen.png')
  assert.equal(index.get('cazic thule'), 'https://wiki.example/ct.png', 'a `match` spelling')
  assert.equal(index.get('avatar of fear'), 'https://wiki.example/ct.png', 'the folded display name')
  assert.equal(index.has('faceless one'), false, 'a target without an image is not a portrait')
})

test('mobPortraitUrl wraps the hit in the permanent image cache and answers null for everyone else', () => {
  assert.equal(
    mobPortraitUrl('the avatar of fear', ROSTER),
    `eqimg://url/${encodeURIComponent('https://wiki.example/ct.png')}`
  )
  assert.equal(mobPortraitUrl('a skeleton', ROSTER), null)
  assert.equal(mobPortraitUrl('Faceless One', ROSTER), null)
})

test('the index is built once per roster ARRAY — same array, same map; a new array, a new map', () => {
  const first = portraitIndex(ROSTER)
  assert.equal(portraitIndex(ROSTER), first, 'identity: the cache hit')
  // A different profile hands back a different array with different art — and gets its own index,
  // which the old module-level cache would have refused to build.
  const other: RaidTarget[] = [
    { name: 'Lord Nagafen', category: 'Dragons', match: ['Lord Nagafen'], image: 'https://wiki.example/other.png' }
  ]
  const second = portraitIndex(other)
  assert.notEqual(second, first)
  assert.equal(second.get('lord nagafen'), 'https://wiki.example/other.png')
  assert.equal(first.get('lord nagafen'), 'https://wiki.example/nagafen.png', 'the first is untouched')
})
