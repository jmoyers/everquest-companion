import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AI_RECAP_CAP, formatRecap, retainRecap } from '../src/main/ai/aiRecap'
import type { LogEvent } from '../src/shared/logEvents'

const T0 = Date.parse('2026-08-01T12:00:00')

function zone(seq: number, ts: number, name: string): LogEvent {
  return { kind: 'zone', zone: name, ts, seq, raw: 'ignored chat' }
}

function dmg(seq: number, ts: number, amount: number): LogEvent {
  return {
    kind: 'damage',
    attacker: 'You',
    target: 'a goblin',
    amount,
    dtype: 'melee',
    skill: 'Melee',
    crit: false,
    ts,
    seq,
    raw: 'ignored'
  }
}

test('retainRecap drops chat-like kinds and keeps zone/damage', () => {
  const chat = { kind: 'tell', ts: T0, seq: 1, raw: 'hi' } as unknown as LogEvent
  let held: LogEvent[] = []
  held = retainRecap(held, chat, 5 * 60_000, AI_RECAP_CAP)
  assert.equal(held.length, 0)
  held = retainRecap(held, zone(2, T0, 'The Plane of Sky'), 5 * 60_000, AI_RECAP_CAP)
  held = retainRecap(held, dmg(3, T0 + 1000, 40), 5 * 60_000, AI_RECAP_CAP)
  assert.equal(held.length, 2)
  const recap = formatRecap(held).join('\n')
  assert.ok(recap.includes('The Plane of Sky'))
  assert.ok(recap.includes('40'))
  assert.ok(!recap.includes('ignored chat'))
})

test('retainRecap culls events older than the window', () => {
  const windowMs = 5 * 60_000
  let held: LogEvent[] = []
  held = retainRecap(held, zone(1, T0, 'Old Zone'), windowMs, AI_RECAP_CAP)
  held = retainRecap(held, dmg(2, T0 + windowMs + 1, 9), windowMs, AI_RECAP_CAP)
  assert.equal(held.length, 1)
  assert.equal(held[0].kind, 'damage')
})

test('retainRecap count-caps at AI_RECAP_CAP', () => {
  let held: LogEvent[] = []
  for (let i = 0; i < AI_RECAP_CAP + 5; i++) {
    held = retainRecap(held, dmg(i + 1, T0 + i, i), 5 * 60_000, AI_RECAP_CAP)
  }
  assert.equal(held.length, AI_RECAP_CAP)
  assert.equal(held[0].kind === 'damage' ? held[0].amount : -1, 5)
})
