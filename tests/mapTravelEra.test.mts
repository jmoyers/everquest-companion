// The Maps tab's "Current era only" switch (src/renderer/src/features/maps/useMapData.ts).
//
// Two surfaces show it - the Closest-port card and Where to level - and the card's hook stays
// mounted above the tabs. Each used to copy the stored value into its own state, so flipping the
// switch in one left the other on the old value until restart. Pinned here: one live value, every
// subscriber told, and the stored key unchanged (absent = on).

import test from 'node:test'
import assert from 'node:assert/strict'

const store = new Map<string, string>()
;(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k)
}

const { TRAVEL_ERA_KEY, loadTravelEra, saveTravelEra, subscribeTravelEra } = await import(
  '../src/renderer/src/features/maps/useMapData'
)

test('a change from one surface reaches every subscriber, and the key keeps its meaning', () => {
  assert.equal(loadTravelEra(), true, 'absent key = on')
  let told = 0
  const stop = subscribeTravelEra(() => told++)
  saveTravelEra(false)
  assert.equal(told, 1)
  assert.equal(loadTravelEra(), false)
  assert.equal(store.get(TRAVEL_ERA_KEY), '0')
  saveTravelEra(true)
  assert.equal(told, 2)
  assert.equal(store.has(TRAVEL_ERA_KEY), false, 'on is stored as no key at all')
  stop()
  saveTravelEra(false)
  assert.equal(told, 2, 'an unsubscribed surface is not told')
  saveTravelEra(true)
})
