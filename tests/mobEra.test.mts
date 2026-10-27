// Unit tests for src/shared/mobEra.ts: a mob is out of era exactly when the data build flagged it
// (`outOfEra: true`) and the player's own log never met it (`shared/metInLog.ts`, owner ruling
// 2026-10-17); its raw banner decides nothing here. Synthetic fixtures; every test that fills the
// log's evidence empties it again.

import test from 'node:test'
import assert from 'node:assert/strict'
import type { MobEntry } from '../src/shared/mobTypes'
import { mobOutOfEra } from '../src/shared/mobEra'
import { setMet } from '../src/shared/metInLog'

type Row = Pick<MobEntry, 'name' | 'page' | 'eraTag' | 'outOfEra'>

const tagged = (eraTag: string, outOfEra?: true, name = 'a revamp fiend'): Row =>
  outOfEra === undefined ? { name, page: name, eraTag } : { name, page: name, eraTag, outOfEra }

test('a mob flagged outOfEra is out; an unflagged one is in, whatever its banner', () => {
  assert.equal(mobOutOfEra(tagged('FearHateRevamp', true)), true)
  assert.equal(mobOutOfEra(tagged('Classic')), false)
  assert.equal(mobOutOfEra(tagged('Hate')), false)
  assert.equal(mobOutOfEra(tagged('Velious')), false, 'a banner alone hides nothing (a cave bat)')
  assert.equal(mobOutOfEra({ name: 'a cave bat' }), false, 'no flag is in era')
})

test('a flagged mob the log met is in era, by its name or by its page; an unmet one stays out', () => {
  const fiend: Row = { name: 'A Revamp Fiend', page: 'A Revamp Fiend (Hate)', outOfEra: true }
  try {
    setMet('mobs', ['a revamp fiend'])
    assert.equal(mobOutOfEra(fiend), false, 'met by name: the log outranks the flag')
    assert.equal(mobOutOfEra(tagged('FearHateRevamp', true, 'a revamp lieutenant')), true, 'not met: out')
    setMet('mobs', ['a revamp fiend (hate)'])
    assert.equal(mobOutOfEra({ name: 'a fiend', page: 'A Revamp Fiend (Hate)', outOfEra: true }), false, 'by page')
  } finally {
    setMet('mobs', [])
  }
  assert.equal(mobOutOfEra(fiend), true, 'with the evidence gone the flag decides again')
})
