// mobFaction.ts — the wiki mob page's `|factions` field: the factions a kill of this mob lowers.
//
// `{{Namedmobpage}}` lists them as bullets, most with the hit beside them
// (`* [[Merchants of Kaladim]] <span class='profac'>(-30)</span>`), some bare (`* [[DeepPockets]]`)
// or with a guess (`(-?)`). A page that knows of none says `* None`; one that has not been worked
// out says `* Unknown` or leaves the field empty. A bullet marked `oppfac` is a faction the kill
// RAISES, which the field occasionally carries (14 pages of 7,926, measured 2026-10-05).
// The span class is not reliable (`oppfac` with `(-10)`), so a stated number decides by its sign.
// About 60 pages name factions without a link (`* Guards of Qeynos <span ...>(-10)</span>`).

import { templateField } from '../../src/main/itemLookupParse'

/** Bullets that are notes or headings, not a faction's name. */
const NOT_A_FACTION = /^(?:none|unknown|need|information|kos\b|for\b|\?)/i

/** Whether the bullet's faction is lowered: by its number's sign when it states one. A `(-0)`
 *  is a listed hit of unstated size (55 Velketor pages), not no hit (owner, 2026-10-10). */
function lowers(line: string): boolean {
  const n = /\(\s*([+-]?\d+)\s*\)/.exec(line)
  if (n !== null) return n[1].startsWith('-')
  return !line.includes('oppfac') && !/\+\s*$/.test(line)
}

/** The faction a bullet names: its link's label, else the bullet's text before any `(` or `<`. */
function bulletName(line: string): string {
  const link = /\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/.exec(line)
  if (link !== null) return link[1].trim()
  const text = /^\s*\*+\s*'*([^(<'*]*)/.exec(line)?.[1].replace(/\s*-\s*$/, '').trim() ?? ''
  return NOT_A_FACTION.test(text) ? '' : text
}

/**
 * Every faction the page says a kill moves, lowered or raised: the `|factions` and
 * `|opposing_factions` bullets, as the page names them. The Gaps tab checks a kill's faction
 * lines against these (owner ask, 2026-10-18).
 */
export function factionNames(wikitext: string): string[] {
  const names: string[] = []
  for (const field of ['factions', 'opposing_factions']) {
    for (const line of (templateField(wikitext, field) ?? '').split('\n')) {
      const name = bulletName(line)
      if (name !== '' && !names.includes(name)) names.push(name)
    }
  }
  return names
}

/** The factions a kill lowers, as the page names them; none when it states none or does not know. */
export function factionHits(wikitext: string): string[] {
  const raw = templateField(wikitext, 'factions') ?? ''
  const hits: string[] = []
  for (const line of raw.split('\n')) {
    const name = bulletName(line)
    if (name !== '' && lowers(line) && !hits.includes(name)) hits.push(name)
  }
  return hits
}
