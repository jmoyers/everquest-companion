// THE PAGE COMES BACK WITH THE TAB (src/renderer/src/lib/navReturn.ts; fork decision, kaltinril
// 2026-08-25). navOrigin.ts returns Back to a VIEW; this slot beside it returns the view to the
// PAGE it was showing, and only when a Back is what brought the view back. Pinned here without
// React: the handshake is three pure calls and every arrival that must NOT restore a page is one
// of them left out.
//
//   1. park + note + take, in that order, hands the page back;
//   2. a park with no Back note is inert - a manual tab switch opens the list;
//   3. a Back note for a DIFFERENT view restores nothing, and is consumed anyway;
//   4. the newest park replaces the last, and parking `null` clears it;
//   5. taking consumes: the second arrival is the list again.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { noteBack, parkReturn, resetNavReturn, takeReturn } from '../src/renderer/src/lib/navReturn'

test('park, Back, take: the view that left a page behind gets it back', () => {
  resetNavReturn()
  parkReturn('mobs', { mob: 'a ghoul' })
  noteBack('mobs')
  assert.deepEqual(takeReturn('mobs'), { mob: 'a ghoul' })
  // Consumed: the next arrival is the browse surface, not the same page twice.
  assert.equal(takeReturn('mobs'), null)
})

test('a park with no Back behind it is inert - a nav-row click opens the list', () => {
  resetNavReturn()
  parkReturn('mobs', { mob: 'a ghoul' })
  assert.equal(takeReturn('mobs'), null)
  // …and it STAYS parked for a Back that comes later in the same journey.
  noteBack('mobs')
  assert.deepEqual(takeReturn('mobs'), { mob: 'a ghoul' })
})

test('a Back to a different view restores nothing here, and the note is spent either way', () => {
  resetNavReturn()
  parkReturn('mobs', { mob: 'a ghoul' })
  noteBack('overview')
  assert.equal(takeReturn('mobs'), null, 'Back went to Overview, not to Mobs')
  assert.equal(takeReturn('mobs'), null, 'one press is one note - it does not linger for the next arrival')
  noteBack('mobs')
  assert.deepEqual(takeReturn('mobs'), { mob: 'a ghoul' }, 'the park itself was untouched')
})

test('the newest park replaces the last, and parking null is "I was showing my list"', () => {
  resetNavReturn()
  parkReturn('mobs', { mob: 'a ghoul' })
  parkReturn('mobs', { mob: 'the zombie' })
  noteBack('mobs')
  assert.deepEqual(takeReturn('mobs'), { mob: 'the zombie' })
  parkReturn('mobs', { mob: 'a ghoul' })
  parkReturn('mobs', null)
  noteBack('mobs')
  assert.equal(takeReturn('mobs'), null, 'a view that left from its list comes back to its list')
})
