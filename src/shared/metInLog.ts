// metInLog.ts — WHAT THE PLAYER'S OWN LOG SHOWS THEY MET (owner ruling, 2026-10-17: the log
// outranks an era banner, "I've seen it drop so it can't be out of era"). One blanket rule, no
// per-name list: a mob killed, conned or looted from, an item looted, a zone entered is in era for
// this player whatever a wiki banner says. The wiki rules still decide everything the log has not
// met. Filled at runtime from the engine's own modules (renderer `lib/useMetInLog`); empty until
// then and in tests unless a test fills it, so without evidence every verdict is the wiki's.
//
// Module state rather than a React context because the era predicates are pure shared functions
// that many surfaces call; `metVersion()` moves on every real change, so a memo or a cache over an
// era verdict that includes it recomputes. Pure, relative imports: the node test runner loads it.

import { mobKey } from './mobKey'
import { zoneKey } from './zones'

export type MetKind = 'mobs' | 'items' | 'zones'

const met: Record<MetKind, Set<string>> = { mobs: new Set(), items: new Set(), zones: new Set() }
let version = 0

/** Each kind joined its own way: a mob by `mobKey`, a zone by `zoneKey` (every tier is the place),
 *  an item lowercased with its ` +N` tier dropped (the item database's own key). */
function keyOf(kind: MetKind, name: string): string {
  if (kind === 'mobs') return mobKey(name)
  if (kind === 'zones') return zoneKey(name)
  return name.replace(/\s\+\d+$/, '').trim().toLowerCase()
}

/** Replace one kind's evidence; the version moves only when the set really changed. */
export function setMet(kind: MetKind, names: Iterable<string>): void {
  const next = new Set<string>()
  for (const n of names) {
    const k = keyOf(kind, n)
    if (k) next.add(k)
  }
  const cur = met[kind]
  if (next.size === cur.size && [...next].every((k) => cur.has(k))) return
  met[kind] = next
  version++
}

/** Did the player's log meet this name? */
export function wasMet(kind: MetKind, name: string): boolean {
  return met[kind].has(keyOf(kind, name))
}

/** Moves whenever the evidence changes: key any memo or cache over an era verdict by it. */
export function metVersion(): number {
  return version
}
