/**
 * PURE quest-page wikitext parser (no network) — the parsing half of
 * `scripts/scrape-quests.ts`. Kept in its own module so it can be unit-tested against
 * verbatim wikitext excerpts (tests/questPageParse.test.mts) without hitting the wiki.
 *
 * Shape of an eqlwiki quest page (probed 2026-08-02 against the live wiki):
 *
 *   {{Classic Era}}
 *   [[File:npc_beur_tenlah.png|frame|Beur Tenlah]]
 *   {| class="questTopTable"
 *   ! ''' Start Zone: '''
 *   | [[Freeport|East Freeport]]
 *   |-
 *   ! ''' Quest Giver: '''
 *   | [[Beur Tenlah]]
 *   |-  … Minimum Level / Classes / Related Zones / Related NPCs
 *   |}
 *
 *   == Reward ==
 *   <ul><li>  {{:Used Merchants Gloves}}   ← a `{{:Name}}` transclusion IS an item box
 *   </li></ul>
 *
 *   == Walkthrough ==
 *   …'''Bring him some [[Dwarven Ale]].'''…   ← turn-in items live in the prose
 *   {{YouGainExperience}}                     ← (or {{exp}}) exp reward marker
 *
 * The Walkthrough's links are a mix of items, NPCs and zones, so the caller supplies an
 * `isItem(title)` predicate (built from the wiki's item-page title set) — that filter is
 * what turns prose links into a trustworthy required-item list.
 */

/** The `{| class="questTopTable"` header block, verbatim label → value cells. */
export interface QuestTopTable {
  startZone?: string
  giver?: string
  minLevel?: number
  /** raw "Minimum Level" cell when it carries prose ("15 (lowest guard is 30)") */
  minLevelText?: string
  classes: string[]
  relatedZones: string[]
  relatedNpcs: string[]
}

export interface ParsedQuestPage extends QuestTopTable {
  /** wiki page title (also the quest's display name) */
  page: string
  /** reward item names (transclusion boxes + item links inside the Reward section) */
  rewards: string[]
  /** item names referenced by the page body (turn-ins/collectibles), minus rewards */
  requiredItems: string[]
  /** page carries a {{YouGainExperience}} / {{exp}} marker */
  expReward: boolean
  /** true when the page is a disambiguation hub, not a quest */
  disambiguation: boolean
  /** true when the page has a questTopTable header block */
  hasTopTable: boolean
  /** true when a page without a header pulls in other pages' sections ({{#lsth:...}}) */
  sectionHub: boolean
}

const TOP_TABLE_RE = /\{\|[^\n]*questTopTable[^\n]*\n([\s\S]*?)\n\|\}/i
const NAMESPACED = /^(file|image|category|template|help|user|special|talk|media|mediawiki)\s*:/i
/** `{{:UNKNOWN}}`-style boxes an editor left where the item is not yet known. */
const PLACEHOLDER = /^(unknown|none|n\/?a|tbd)$/i

/** [[Page|Label]] → Label, [[Page]] → Page, then drop templates/html/quotes. */
export function stripMarkup(v: string): string {
  return v
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/\{\{[^{}]*\}\}/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/'''?/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Every `[[Target]]` / `[[Target|Label]]` TARGET in `text` (namespaced links skipped). */
export function linkTargets(text: string): string[] {
  const out: string[] = []
  const re = /\[\[\s*([^\]|#<>{}]+?)\s*(?:\|[^\]]*)?\]\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const t = m[1].replace(/_/g, ' ').trim()
    if (!t || NAMESPACED.test(t)) continue
    out.push(t)
  }
  return out
}

/** Every `{{:Page}}` main-namespace transclusion target — on quest pages these are item boxes. */
export function transclusionTargets(text: string): string[] {
  const out: string[] = []
  const re = /\{\{:\s*([^}|\n]+?)\s*(?:\|[^}]*)?\}\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const t = m[1].replace(/_/g, ' ').trim()
    if (t && !NAMESPACED.test(t) && !PLACEHOLDER.test(t)) out.push(t)
  }
  return out
}

/** Positional params of every `{{Gear Set|A|B|...}}` (a quest's armor-set reward list). */
export function gearSetItems(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/\{\{\s*gear set\s*\|([^{}]*)\}\}/gi)) {
    for (const p of m[1].split('|')) if (p.trim() && !p.includes('=')) out.push(p.trim())
  }
  return out
}

/** A page name's lookup key: case-folded, `_` read as a space (as MediaWiki does). */
export function titleKey(name: string): string {
  return name.toLowerCase().replace(/[\s_]+/g, ' ').trim()
}

/** Case-insensitive de-dupe that keeps first-seen order and spelling. */
export function dedupe(names: Iterable<string>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const n of names) {
    const k = titleKey(n)
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(n.replace(/\s+/g, ' ').trim())
  }
  return out
}

/** Split a table cell into names: prefer link labels, else comma-separated plain text. */
function cellList(raw: string): string[] {
  const links = [...raw.matchAll(/\[\[\s*([^\]|#]+?)\s*(?:\|\s*([^\]]*?)\s*)?\]\]/g)].map((m) =>
    (m[2] || m[1]).trim()
  )
  const parts = links.length
    ? links
    : stripMarkup(raw)
        .split(/,|\band\b/)
        .map((s) => s.trim())
  return dedupe(parts.filter((s) => s && !/^none$/i.test(s) && !/^n\/?a$/i.test(s)))
}

function cellText(raw: string): string | undefined {
  const s = stripMarkup(raw)
  if (!s || /^none$/i.test(s) || /^n\/?a$/i.test(s)) return undefined
  return s
}

/**
 * Parse the `questTopTable` header block into its labelled fields. Rows are
 * `! ''' Label: '''` followed by `| value` lines (a value may span several lines).
 * Returns null when the page has no such table.
 */
/**
 * The table body's `! ''' Label: '''` / `| value` rows, as lowercased label → value. A label
 * that repeats within one row joins its values with ", "; `|-` (a new row) clears the label,
 * so a stray value line can never attach to the previous row's label.
 */
function topTableFields(body: string): Record<string, string> {
  const fields: Record<string, string> = {}
  let label: string | null = null
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith('|-')) {
      label = null
      continue
    }
    if (line.startsWith('!')) {
      const key = stripMarkup(line.replace(/^!+/, ''))
        .replace(/:\s*$/, '')
        .trim()
        .toLowerCase()
      label = key || null
      continue
    }
    if (line.startsWith('|') && label) {
      const val = line.replace(/^\|+/, '').trim()
      fields[label] = fields[label] ? `${fields[label]}, ${val}` : val
    }
  }
  return fields
}

export function parseTopTable(wikitext: string): QuestTopTable | null {
  const m = TOP_TABLE_RE.exec(wikitext)
  if (!m) return null
  const fields = topTableFields(m[1])

  /** First field whose label CONTAINS one of `wants`, in the order given; '' when none. */
  const pick = (...wants: string[]): string => {
    for (const want of wants) {
      for (const [k, v] of Object.entries(fields)) if (k.includes(want)) return v
    }
    return ''
  }
  // Not a bare 'level' fallback: that reads 'Recommended Level' as a minimum.
  const minText = cellText(pick('minimum level', 'min level'))
  const minNum = minText ? Number(/(\d+)/.exec(minText)?.[1]) : NaN

  return {
    startZone: cellText(pick('start zone')),
    giver: cellText(pick('quest giver', 'giver')),
    minLevel: Number.isFinite(minNum) ? minNum : undefined,
    minLevelText: minText && !/^\d+$/.test(minText) ? minText : undefined,
    classes: cellList(pick('classes')),
    relatedZones: cellList(pick('related zones')),
    relatedNpcs: cellList(pick('related npcs', 'related npc'))
  }
}

export interface WikiSection {
  heading: string
  text: string
}

/** Split wikitext into its lead and `== Heading ==` sections (any depth). */
export function splitSections(wikitext: string): { lead: string; sections: WikiSection[] } {
  const lines = wikitext.split('\n')
  const sections: WikiSection[] = []
  const lead: string[] = []
  let cur: WikiSection | null = null
  for (const line of lines) {
    // A template may follow the closing == on the same line (`== Checklist =={{CheckboxList}}`).
    const h = /^\s*={2,6}\s*(.+?)\s*={2,6}\s*((?:\{\{[^{}]*\}\}\s*)*)$/.exec(line)
    if (h) {
      cur = { heading: h[1].trim(), text: h[2] ? h[2] + '\n' : '' }
      sections.push(cur)
      continue
    }
    if (cur) cur.text += line + '\n'
    else lead.push(line)
  }
  return { lead: lead.join('\n'), sections }
}

// 'Reward', 'Possible Rewards', 'Additional Rewards'; a mixed 'Rewards and Walkthrough'
// section names its turn-ins in prose, so it reads as body.
const REWARD_HEADING = /^(?!.*\bwalkthrough\b).*\brewards?\b/i
const EXP_MARKER = /\{\{\s*(yougainexperience|exp|experience)\s*\}\}|you gain experience/i

function isSectionHub(top: QuestTopTable | null, wikitext: string): boolean {
  return top === null && /\{\{\s*#lsth\s*:/i.test(wikitext)
}

/**
 * Parse one quest page. `isItem(title)` decides whether a prose link names an item page
 * (built from the wiki's item-title set); without it every link would be kept, dragging
 * in NPCs and zones.
 */
export function parseQuestPage(
  page: string,
  wikitext: string,
  isItem: (title: string) => boolean = () => false
): ParsedQuestPage {
  const top = parseTopTable(wikitext)
  const withoutTable = wikitext.replace(TOP_TABLE_RE, '\n')
  const { lead, sections } = splitSections(withoutTable)

  const rewardText = sections
    .filter((s) => REWARD_HEADING.test(s.heading))
    .map((s) => s.text)
    .join('\n')
  const bodyText = [lead, ...sections.filter((s) => !REWARD_HEADING.test(s.heading)).map((s) => s.text)].join('\n')

  // Rewards: a `{{:Name}}` box is always an item; a plain link only counts when the
  // title is a known item page (Reward sections also link factions, zones and coin).
  // Gear Set is only ever a reward list, read page-wide since it can sit under a sub-heading.
  const rewards = dedupe([
    ...transclusionTargets(rewardText),
    ...linkTargets(rewardText).filter(isItem),
    ...gearSetItems(wikitext).filter(isItem)
  ])
  const rewardKeys = new Set(rewards.map(titleKey))

  // Required/turn-in items: item references anywhere OUTSIDE the Reward section. Unlike the
  // Reward section (which only ever holds item boxes), the body transcludes mob/zone boxes
  // too, so BOTH links and transclusions go through the item filter here.
  const requiredItems = dedupe([
    ...transclusionTargets(bodyText).filter(isItem),
    ...linkTargets(bodyText).filter(isItem)
  ]).filter((n) => !rewardKeys.has(titleKey(n)))

  return {
    page,
    startZone: top?.startZone,
    giver: top?.giver,
    minLevel: top?.minLevel,
    minLevelText: top?.minLevelText,
    classes: top?.classes ?? [],
    relatedZones: top?.relatedZones ?? [],
    relatedNpcs: top?.relatedNpcs ?? [],
    rewards,
    requiredItems,
    expReward: EXP_MARKER.test(wikitext),
    disambiguation: /\{\{\s*disambig/i.test(wikitext),
    hasTopTable: top !== null,
    sectionHub: isSectionHub(top, wikitext)
  }
}

/** A parse is "empty" when it yielded nothing worth committing (logged, never dropped silently). */
export function isEmptyParse(q: ParsedQuestPage): boolean {
  return (
    !q.hasTopTable &&
    q.rewards.length === 0 &&
    q.requiredItems.length === 0 &&
    !q.giver &&
    !q.startZone
  )
}
