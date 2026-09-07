import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SourceView } from '../src/shared/combat'
import {
  SELF_METER_NAME_KEY,
  selfMeterLabel,
  withSelfLabel
} from '../src/renderer/src/features/combat/selfMeterLabel'

/** A SourceView is large; the label logic only reads `kind` and `name`, so a cast is honest here. */
const row = (kind: string, name: string): SourceView => ({ kind, name } as unknown as SourceView)

test('the key is the documented localStorage key', () => {
  assert.equal(SELF_METER_NAME_KEY, 'eq.combat.selfMeterName')
})

test('selfMeterLabel: name + on ⇒ "<name> (You)"; every other combination ⇒ null', () => {
  assert.equal(selfMeterLabel('Primitive', true), 'Primitive (You)')
  assert.equal(selfMeterLabel('  Drammin  ', true), 'Drammin (You)')
  assert.equal(selfMeterLabel('Primitive', false), null)
  assert.equal(selfMeterLabel(null, true), null)
  assert.equal(selfMeterLabel(undefined, true), null)
  assert.equal(selfMeterLabel('', true), null)
  assert.equal(selfMeterLabel('   ', true), null)
})

test('withSelfLabel: null label ⇒ the SAME array reference back', () => {
  const rows = [row('you', 'You'), row('enemy', 'a rat')]
  assert.equal(withSelfLabel(rows, null), rows)
})

test('withSelfLabel: no self row ⇒ the SAME array reference back', () => {
  const rows = [row('enemy', 'a rat'), row('member', 'Ally')]
  assert.equal(withSelfLabel(rows, 'Primitive (You)'), rows)
})

test('withSelfLabel: relabels only the self row, leaves the rest untouched', () => {
  const rows = [row('you', 'You'), row('pet', 'Gerp'), row('member', 'Ally')]
  const out = withSelfLabel(rows, 'Primitive (You)')
  assert.notEqual(out, rows)
  assert.equal(out[0].name, 'Primitive (You)')
  assert.equal(out[0].kind, 'you')
  assert.equal(out[1].name, 'Gerp')
  assert.equal(out[2], rows[2], 'non-self rows are the same objects')
})
