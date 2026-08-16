// mobArt.ts — the portrait a hovered pin can show, from art the app already ships.
//
// The only mob art bundled is the raid roster's (bosses.json, 29 targets with an `image`, served
// via the `eqimg://` cache). Everyone else gets no portrait — there is no corpus for ordinary
// mobs, and scraping one is wiki traffic this app does not generate (owner rule, 2026-08-16).

import { getBossData } from '../../data'
import { cachedImageUrl } from '../../lib/imageUrl'

/** Case- and article-insensitive, the raid roster's own matching posture (bossStatus.ts). */
function foldName(name: string): string {
  return name.toLowerCase().replace(/^(a|an|the)\s+/, '')
}

let ART: Map<string, string> | null = null

function artIndex(): Map<string, string> {
  if (ART) return ART
  const m = new Map<string, string>()
  for (const target of getBossData().targets) {
    if (target.image == null || target.image === '') continue
    for (const name of [target.name, ...target.match]) {
      const key = foldName(name)
      if (key !== '' && !m.has(key)) m.set(key, target.image)
    }
  }
  ART = m
  return m
}

/** The `eqimg://` URL for this mob's portrait, or null — which is the answer for all but the 29. */
export function mobPortraitUrl(name: string): string | null {
  const url = artIndex().get(foldName(name))
  return url == null ? null : cachedImageUrl(url)
}
