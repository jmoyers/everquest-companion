// MAPS — the keyboard door on a pin or a linked label (src/renderer/src/features/maps/
// mapPinChrome.tsx). A `role="button"` span activates on Enter and Space and on nothing else; an
// inert glyph gets NO handler, so the tab order and the key both say the same thing about what a
// glyph does. Pure key arithmetic — no React, no DOM — so this suite never skips.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isActivationKey, onActivateKey } from '../src/renderer/src/features/maps/mapPinChrome'

test('Enter and Space activate; every other key is left to the page', () => {
  assert.equal(isActivationKey('Enter'), true)
  assert.equal(isActivationKey(' '), true)
  assert.equal(isActivationKey('Tab'), false, 'Tab must keep moving focus')
  assert.equal(isActivationKey('Escape'), false)
  assert.equal(isActivationKey('a'), false)
})

test('the handler fires on an activation key and swallows its default; an inert glyph has no handler', () => {
  let fired = 0
  let prevented = 0
  const handler = onActivateKey(() => {
    fired += 1
  })
  assert.ok(handler)
  const press = (key: string): void => {
    handler({ key, preventDefault: () => { prevented += 1 } } as never)
  }
  press(' ')
  press('Enter')
  assert.equal(fired, 2)
  assert.equal(prevented, 2, 'Space would scroll the content area; Enter does nothing a user asked for')
  press('Tab')
  assert.equal(fired, 2, 'a non-activation key neither fires nor is swallowed')
  assert.equal(prevented, 2)
  assert.equal(onActivateKey(null), undefined)
  assert.equal(onActivateKey(undefined), undefined)
})
