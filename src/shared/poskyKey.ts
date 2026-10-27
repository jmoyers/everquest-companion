// poskyKey — the ONE spelling of a Plane of Sky quest's identity, `Class::Name`.
//
// It lived in the renderer (features/posky/keys.ts, which now re-exports it) until the item
// lookup in main needed to stamp the same key onto each Sky quest use it hands the renderer, so
// the item page can deep-link to the quest (appRouting `openQuest`, which PoskyView matches
// against this exact string). Two spellings of one key would be a drift waiting to happen.

import type { PoskyQuest } from './types'

export function questKey(q: Pick<PoskyQuest, 'className' | 'name'>): string {
  return `${q.className}::${q.name}`
}
