// SHIP THE SPELL-LINE RESEARCH AS BUNDLED DATA (JOS-391).
//
// `docs/research/spell-lines/` is 2.3 MB of thirteen agents' work: per class, the upgrade LINES
// (ordered members), the standalone spells, the stacking conflicts with source URLs, the open
// questions. Its README names the intended consumer and this is it - the Leveling row that says
// `replaces Minor Healing (Cleric)`.
//
// WHAT CROSSES: the id, the name, the category and the ordered members. Nothing else. The stacking
// tables, the sources, the notes and the open questions stay in docs/ where a human reads them; a
// lookup that only walks a member list has no use for a P99 URL and the main bundle should not
// carry one. 1.5 MB of research becomes ~70 KB of data.
//
// IMPORTED, NEVER `readFileSync`'d - the same law spellDb.ts's other data obeys, and for the same
// reason: electron-vite inlines a JSON import at build time, while a path-relative read misses in
// `out/main/`. `src/main/data/spellLineLookup.ts` does the importing.
//
// ── FOUR THINGS THE RESEARCH DOES NOT GUARANTEE, EACH FIXED HERE AND MEASURED ───────────────────
//
// The research files were written by thirteen independent agents against a shared brief, and their
// merge verified COVERAGE (every spell placed exactly once) rather than the shape of each list.
// Four artefacts survive that check and would each become a wrong sentence on a player's screen:
//
//   1. MEMBERS OUT OF LEVEL ORDER. Two lines carry one out-of-place member each (shaman
//      `Summon Companion@40` after `Frenzied Spirit@45`; wizard `Thunderbold@54` after
//      `Pillar of Flame@57`). "The previous member" is only meaningful in level order, so every
//      member list is SORTED here - which is also what the README already claims about them.
//   2. CASE-VARIANT AND DUPLICATE TWINS. `Invisibility versus Animals@8` is followed by
//      `Invisibility Versus Animals@9`, `Skin Like Wood@1` appears twice, `Greater Healing` twice
//      at 29 and 34. These are the wiki's own duplicate pages, folded and flagged by the research.
//      Left in, a row would say a spell replaces ITSELF. Deduped by canonical name, first wins.
//   3. SPELLS EQ LEGENDS DOES NOT HAVE (`inDb: false` - 13 members, 11 of them rogue poisons and
//      two wizard familiars). This is `spellRemovals.ts`'s rule, pointing at a different surface:
//      JOS-337 was filed because unlock cards sent the owner to a vendor for spells the game does
//      not carry. Naming one as the thing you just replaced is the same defect. Dropped.
//   4. LINES THAT ARE SETS, NOT LADDERS. `Ring of Karana`, `Ring of Butcher`, `Ring of Toxxulia`
//      are filed as one "line" and are DESTINATIONS - Ring of Butcher replaces nothing. Same for
//      the wizard Gates/Portals/Translocates/Evacuates, the druid Circles/Zephyrs/Succors, the
//      thirteen `Imbue <gem>` spells (all at level 29, one per gem) and the rogue poison tiers.
//      Those categories are marked `ladder: false` and the lookup declines to name a replacement
//      from them. The category names are the research's own words, listed below verbatim.
//
// A fifth artefact needs no fix here because the LOOKUP handles it locally: a line legitimately
// holds two members at the SAME level (`Heroism@52` and its group twin `Heroic Bond@52`), and
// same-level neighbours never replace one another.
//
// Run: `npm run gen:spell-lines`. Deterministic - same inputs, byte-identical output - so a
// re-run that changes the file means the research changed.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classAbbrForDisplayName } from '../src/shared/spellLevels'
import type { ClassAbbr } from '../src/shared/classCombo'

const HERE = dirname(fileURLToPath(import.meta.url))
const RESEARCH = join(HERE, '..', 'docs', 'research', 'spell-lines')
const OUT = join(HERE, '..', 'src', 'main', 'data', 'spellLines.json')

/**
 * The categories whose members are DESTINATIONS or per-item variants rather than tiers, verbatim
 * as the research files spell them (135 distinct category strings exist across the thirteen files
 * - each agent invented its own vocabulary - so this is an explicit list, not a pattern).
 *
 * Each was read before it was listed: every line under these categories was printed with its
 * members and none of them is an upgrade sequence. `tradeskill-summon` is the two Imbue Gem lines
 * (13 and 12 spells, all at level 29); `poison-*` is the rogue tiers, where the members do
 * different things and 11 of 20 are not on Legends at all; the rest are travel.
 */
const SET_CATEGORIES: ReadonlySet<string> = new Set([
  'teleport',
  'transport-self-teleport',
  'transport-group-teleport',
  'transport-translocate',
  'transport-evacuate',
  'evacuation',
  'tradeskill-summon',
  'poison-utility',
  'poison-combat'
])

interface ResearchMember {
  name: string
  level: number
  inDb?: boolean
}

interface ResearchLine {
  id: string
  name: string
  category?: string
  members?: ResearchMember[]
}

interface ResearchFile {
  class?: string
  lines?: ResearchLine[]
}

/** One member as the lookup needs it: a name and the level the class gains it at. */
export interface SpellLineMember {
  name: string
  level: number
}

/** One upgrade line for one class. */
export interface SpellLine {
  id: string
  name: string
  category: string
  /** Ascending by level, deduped, DB-present only. */
  members: SpellLineMember[]
  /**
   * False when the members are alternatives rather than tiers (travel destinations, gems,
   * poisons) - the lookup names the line but refuses to call any member a replacement.
   */
  ladder: boolean
}

/** The committed file. */
export interface SpellLinesFile {
  generatedAt: string
  /** Keyed by /who class code. */
  classes: Partial<Record<ClassAbbr, SpellLine[]>>
}

/** Case- and whitespace-stable key for "the same spell", so the twins fold. */
function nameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** Sort by level, dedupe by name (first wins), drop what EQ Legends does not have. */
function membersOf(line: ResearchLine): SpellLineMember[] {
  const present = (line.members ?? []).filter((m) => m.inDb !== false && Number.isFinite(m.level))
  const sorted = [...present].sort((a, b) => a.level - b.level)
  const seen = new Set<string>()
  const out: SpellLineMember[] = []
  for (const m of sorted) {
    const key = nameKey(m.name)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ name: m.name.trim(), level: m.level })
  }
  return out
}

/** One research file -> the lines this class contributes, in id order. */
function linesOf(file: ResearchFile): SpellLine[] {
  const out: SpellLine[] = []
  for (const line of file.lines ?? []) {
    const members = membersOf(line)
    if (members.length === 0) continue
    const category = line.category ?? ''
    out.push({
      id: line.id,
      name: line.name,
      category,
      members,
      ladder: !SET_CATEGORIES.has(category.toLowerCase())
    })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

function build(): { file: SpellLinesFile; stats: string[] } {
  const classes: SpellLinesFile['classes'] = {}
  const stats: string[] = []
  const names = readdirSync(RESEARCH)
    .filter((f) => f.startsWith('lines-') && f !== 'lines-merged.json')
    .sort()
  for (const name of names) {
    const raw = JSON.parse(readFileSync(join(RESEARCH, name), 'utf8')) as ResearchFile
    const cls = raw.class === undefined ? undefined : classAbbrForDisplayName(raw.class)
    if (!cls) {
      stats.push(`SKIPPED ${name}: class "${String(raw.class)}" is not a /who code`)
      continue
    }
    const lines = linesOf(raw)
    classes[cls] = lines
    const members = lines.reduce((n, l) => n + l.members.length, 0)
    const ladders = lines.filter((l) => l.ladder).length
    stats.push(
      `${cls}  ${String(lines.length).padStart(3)} lines (${String(ladders)} ladders)  ` +
        `${String(members).padStart(4)} members`
    )
  }
  // A FIXED STAMP, not `new Date()`: the output must be byte-identical across runs so a diff means
  // the research moved. The date the research was produced is the honest thing to stamp.
  return { file: { generatedAt: '2026-08-13', classes }, stats }
}

const { file, stats } = build()
writeFileSync(OUT, `${JSON.stringify(file, null, 1)}\n`, 'utf8')
for (const s of stats) console.log(s)
console.log(`wrote ${OUT}`)
