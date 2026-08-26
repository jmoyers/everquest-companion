// mobArt.ts — the portrait a hovered pin can show, from art the app already ships.
//
// The only mob art bundled is the raid roster's (bosses.json, 29 targets with an `image`, served
// via the `eqimg://` cache). Everyone else gets no portrait — there is no corpus for ordinary
// mobs, and scraping one would be new wiki traffic, which the repo's rule forbids (AGENTS.md:
// the wiki art ships in the box) and the fork adds none of (kaltinril, 2026-08-16).
//
// THE INDEX IS KEYED ON THE ROSTER ARRAY, NOT CACHED FOREVER. `getBossData()` is PROFILE-keyed —
// a profile switch hands back a different `targets` array — and a module-level `let` built once
// would serve the first profile's portraits to the second for the life of the window. A WeakMap
// on the array itself is the crossZone.ts `HAYSTACKS` idiom: built lazily, once per array, and a
// test's synthetic roster does not leak.
//
// PURE: the roster is an ARGUMENT, not an import. `data/index.ts` reaches `@shared/*` — an alias
// that exists only inside the vite build — so a module that imported it could not run under
// `node --import tsx --test` (tests/mobArt.test.mts drives this one). The one caller with a hover
// (MapMobPins.tsx) hands in `getBossData().targets`; nothing here knows which profile is active.

import type { RaidTarget } from '@shared/types'
import { cachedImageUrl } from '../../lib/imageUrl'

/** Case- and article-insensitive, the raid roster's own matching posture (bossStatus.ts). */
export function foldMobName(name: string): string {
  return name.toLowerCase().replace(/^(a|an|the)\s+/, '')
}

const ART = new WeakMap<readonly RaidTarget[], ReadonlyMap<string, string>>()

/** Folded name (display name AND every `match` spelling) → the raw image URL, per roster array. */
export function portraitIndex(targets: readonly RaidTarget[]): ReadonlyMap<string, string> {
  const cached = ART.get(targets)
  if (cached) return cached
  const m = new Map<string, string>()
  for (const target of targets) {
    if (target.image == null || target.image === '') continue
    for (const name of [target.name, ...target.match]) {
      const key = foldMobName(name)
      if (key !== '' && !m.has(key)) m.set(key, target.image)
    }
  }
  ART.set(targets, m)
  return m
}

/** The `eqimg://` URL for this mob's portrait, or null — which is the answer for all but the 29. */
export function mobPortraitUrl(name: string, targets: readonly RaidTarget[]): string | null {
  const url = portraitIndex(targets).get(foldMobName(name))
  return url == null ? null : cachedImageUrl(url)
}
