// WHAT THIS SPELL REPLACES, AND WHAT REPLACES IT (JOS-391).
//
// The reader for `spellLines.json` (written by `scripts/gen-spell-lines.ts` out of the thirteen
// spell-line research files - that script's header states every artefact it repairs on the way in).
// Bundled by IMPORT, never `readFileSync`, the law spellDb.ts's other data obeys.
//
// ONE QUESTION, ASKED PER CLASS. "Does Healing replace anything" has no answer on its own: the
// same name sits at a different rung for a cleric and a shaman, and a druid's Skin line is not a
// ranger's. So the index is keyed by /who code and the caller supplies the class the row is drawn
// for. A spell no line carries answers `{ null, null, null }` - most of the catalog, and the
// honest shape for it.
//
// A RANK IS NOT A LINE, and this file is the reason that distinction is now a data question rather
// than an argument. `SpellCard.tsx` used to draw "replaces <previous rank>" off the roman-numeral
// tail; the owner removed it (JOS-293) because ranks are orthogonal to upgrade lines on EQL and a
// player rarely drops the older rank. So names are matched WHOLE here - no rank stripping - and
// what a member replaces comes from the research's ordered list and nowhere else.
//
// ── THE ONE RULE THIS FILE OWNS: A REPLACEMENT IS STRICTLY EARLIER ──────────────────────────────
//
// The generator sorts and dedupes; it does not decide what "previous" means. Two members at the
// SAME level do not replace one another, and that is a real shape rather than a defect: the cleric
// Heroism line ends `Heroism@52` and `Heroic Bond@52`, the group version of the same buff, and the
// druid Skin line carries the single-target and group forms side by side. Saying "Heroic Bond
// replaces Heroism" would tell a player to stop memorizing a spell they still want. So `replaces`
// walks BACKWARD to the nearest member at a strictly LOWER level, and `replacedBy` forward to the
// nearest strictly HIGHER one; a same-level neighbour is skipped, not reported.

import linesJson from './spellLines.json'
import type { ClassAbbr } from '../../shared/classCombo'

/** One member: the spell and the level its class gains it at. */
export interface SpellLineMember {
  name: string
  level: number
}

/** One upgrade line, as the committed file carries it. */
export interface SpellLine {
  id: string
  name: string
  category: string
  members: SpellLineMember[]
  /** False for destination/per-item sets (travel, gems, poisons) - see the generator. */
  ladder: boolean
}

interface SpellLinesFile {
  generatedAt: string
  classes: Partial<Record<ClassAbbr, SpellLine[]>>
}

/** What a class's line says about one spell. Every field is null when nothing is known. */
export interface SpellLinePlace {
  /** The member immediately below it, or null (first member, a set, or an unknown spell). */
  replaces: string | null
  /** The member immediately above it. */
  replacedBy: string | null
  /** The line's display name, present whenever the spell was found at all. */
  line: string | null
}

const NOT_IN_A_LINE: SpellLinePlace = { replaces: null, replacedBy: null, line: null }

/** Case- and whitespace-stable key, matching the generator's own fold. */
function nameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Where one member sits: its line and its index in it.
 *
 * EXPORTED SINCE JOS-508, for the spell drilldown — which needs the WHOLE ladder rather than the
 * two neighbours `replacedBy` names. It is the same object the index already holds, handed out
 * rather than rebuilt, so the page's progression and the row's `replaces` clause can never be two
 * readings of the file. `line.members` is the imported JSON: read it, never mutate it.
 */
export interface Placement {
  line: SpellLine
  index: number
}

type ClassIndex = Map<string, Placement>

let index: Map<ClassAbbr, ClassIndex> | null = null

/**
 * Build the (class -> spell key -> placement) index once.
 *
 * FIRST PLACEMENT WINS when a class's own files put one name in two lines. The research's merge
 * verified that every spell is placed exactly once ACROSS agents; within a file the folded wiki
 * duplicates can still land twice, and picking the first in id order is a stable answer rather
 * than a coin flip that changes with the file's ordering.
 */
function buildIndex(): Map<ClassAbbr, ClassIndex> {
  const file = linesJson as SpellLinesFile
  const out = new Map<ClassAbbr, ClassIndex>()
  for (const [code, lines] of Object.entries(file.classes)) {
    const byName: ClassIndex = new Map()
    for (const line of lines ?? []) {
      line.members.forEach((m, i) => {
        const key = nameKey(m.name)
        if (!byName.has(key)) byName.set(key, { line, index: i })
      })
    }
    out.set(code as ClassAbbr, byName)
  }
  return out
}

/** The nearest member below `at` whose level is strictly lower, or null. */
function previousTier(line: SpellLine, at: number): string | null {
  const here = line.members[at].level
  for (let i = at - 1; i >= 0; i--) {
    if (line.members[i].level < here) return line.members[i].name
  }
  return null
}

/** The nearest member above `at` whose level is strictly higher, or null. */
function nextTier(line: SpellLine, at: number): string | null {
  const here = line.members[at].level
  for (let i = at + 1; i < line.members.length; i++) {
    if (line.members[i].level > here) return line.members[i].name
  }
  return null
}

/**
 * WHERE THIS SPELL SITS IN THAT CLASS'S LINE.
 *
 * A non-ladder line (travel destinations, the Imbue gems, the rogue poison tiers) still NAMES
 * itself - the spell really is a member of it - but reports no neighbour, because "Ring of
 * Butcher replaces Ring of Surefall Glade" is a sentence about two different places.
 */
export function replacedBy(spellName: string, cls: ClassAbbr): SpellLinePlace {
  const found = lineContaining(spellName, cls)
  if (!found) return NOT_IN_A_LINE
  const { line, index: at } = found
  if (!line.ladder) return { replaces: null, replacedBy: null, line: line.name }
  return {
    replaces: previousTier(line, at),
    replacedBy: nextTier(line, at),
    line: line.name
  }
}

/**
 * THE LINE THIS CLASS FILES THIS SPELL UNDER, and where in it — or null.
 *
 * `replacedBy` above is this function plus the strictly-earlier rule; the drilldown page (JOS-508)
 * needs the other half, which is every rung rather than the two adjacent ones. Sharing the lazily
 * built index means asking "what does it replace" and "show me the whole ladder" are one lookup
 * into one table, and the FIRST-PLACEMENT-WINS tiebreak above applies to both by construction.
 */
export function lineContaining(spellName: string, cls: ClassAbbr): Placement | null {
  index ??= buildIndex()
  return index.get(cls)?.get(nameKey(spellName)) ?? null
}

/** Every line the file carries for a class, for tests and any future line-browsing surface. */
export function linesForClass(cls: ClassAbbr): readonly SpellLine[] {
  return (linesJson as SpellLinesFile).classes[cls] ?? []
}

/** The stamp the research carries, for provenance. */
export function spellLinesGeneratedAt(): string {
  return (linesJson as SpellLinesFile).generatedAt
}
