// zoneLinks.ts — which map a `to_…` connection label opens, or null when it must stay a label.
//
// The map files already state where every zone line LEADS (`to_East_Commonlands` — 584 of a
// 9,945-label sample carry the prefix, §2.4) and the viewer already classifies them
// (labelLayout.ts `labelKind`). This module owns the one step that was missing: the words after
// `to` → the hand-authored zone table → a stem the click can open.
//
// MEASURED (this machine's default map set, 2026-08-16): of 274 `to_` labels, 219 resolve
// (79.9%) through `zoneShortName` once the `to ` prefix and any trailing parenthetical
// (`to_Hills_of_Shade (click rubble)`) are stripped. The other 55 are later-era zones the table
// deliberately refuses, in-city sub-labels (`to Enchanter Guild`) and multi-zone prose
// (`to Butcherblock/Ocean of Tears/Qeynos`) — every one of them stays a PLAIN label rather than
// becoming a guessed link (world-model law 1: never silently guess).
//
// RELATIVE value imports, the repo-wide rule for node-tested pure modules (mobPins.ts:38).

import type { ZoneShort } from '@shared/maps'
import { zoneShortName } from '../../../../shared/zones'
import { labelKind } from './labelLayout'

/** The word `labelKind` anchored on; stripping it is safe once the kind says `connection`. */
const TO_PREFIX_RE = /^to\s+/i
/** Trailing prose for the traveller (`(click rubble)`, `(Sol B)`), never part of a zone name. */
const TRAILING_PAREN_RE = /\s*\([^)]*\)\s*$/

/**
 * The map stem a connection label names, or null when the label must stay inert.
 *
 * `installed` follows crossZone.ts's convention: EMPTY means "the pack listing has not answered
 * yet", never "nothing is installed" — so an empty set gates nothing.
 */
export function connectionTarget(
  display: string,
  installed: ReadonlySet<ZoneShort>
): ZoneShort | null {
  if (labelKind(display) !== 'connection') return null
  let name = display.replace(TO_PREFIX_RE, '')
  while (TRAILING_PAREN_RE.test(name)) name = name.replace(TRAILING_PAREN_RE, '')
  const stem = zoneShortName(name)
  if (stem == null) return null
  return installed.size === 0 || installed.has(stem) ? stem : null
}
