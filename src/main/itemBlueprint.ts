// itemBlueprint.ts — an Item Page Blueprint saved with its placeholders unfilled (owner, 2026-10-24:
// eight new Nektropos Castle pages dropped from `Mob_Name`, served `Quest_Name` and fit
// `Slot: PRIMARY / SECONDARY / RANGE / AMMO / ANY ...` with every stat `+?`). Its placeholders are no
// facts: the page states nothing yet, so it is no item record (itemLookupParse.ts) and the Gaps tab
// offers the page's draft, as for an item the wiki lacks.

const PLACEHOLDER = /\b(?:Mob_Name|Quest_Name|Effect_Name|Zone_Name)\b/
const EVERY_SLOT = /Slot:\s*PRIMARY \/ SECONDARY \/ RANGE \/ AMMO/

export function isUnfilledItemBlueprint(wikitext: string): boolean {
  return PLACEHOLDER.test(wikitext) || EVERY_SLOT.test(wikitext)
}
