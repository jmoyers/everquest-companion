/**
 * Spell-database scraper (Task #34, effect list added JOS-251).
 *
 * Enumerates every wiki page that embeds `Template:Spellpage` (MediaWiki
 * list=embeddedin, paged) and parses each page's wikitext template fields into a
 * SpellEntry, writing the committed catalog to src/main/data/spells.json.
 *
 *   npm run scrape:spells
 *
 * The catalog is the PRIOR/TRUTH for buff durations and — crucially — the source of
 * the exact chat messages a spell prints when it lands (msg_cast_on_you /
 * msg_cast_on_other) or fades (msg_wears_off). Those messages let the parser emit
 * PRECISE, message-driven buffApply/buffWearOff events (see src/main/data/spellDb.ts),
 * which is how self buffs cast via Quick Buff bursts (no "You begin casting" line)
 * finally become visible.
 *
 * SINCE JOS-251 IT ALSO CAPTURES THE PAGE'S NUMBERED EFFECT LIST (`{{SpellSlotRow}}`) and the
 * bard pages' `Enhanced by instrument?` row. That list is the only place the wiki states what a
 * spell DOES — "Charm (up to L37)", "Mesmerize (2/55)", "Decrease Attack Speed by 30%" — and
 * capturing it is what lets the charm/mez rosters be DERIVED (src/main/data/spellEffectClass.ts)
 * instead of guessed from name stems. The guessing shipped four bugs in a row (JOS-84, 200, 225,
 * and the JOS-250 audit's three missing druid charms and four false positives).
 *
 * ── THE WIKI IS SMALL AND COMMUNITY-RUN, SO THIS SCRIPT IS BUILT AROUND NOT HITTING IT ────────
 *
 * THREE MECHANISMS, and they compose:
 *
 *   1. BATCHED CONTENT. Wikitext comes back 50 pages per request
 *      (`prop=revisions&rvprop=content&rvslots=main&pageids=<50>`), the shape scrape-items.ts
 *      measured — so a full cold re-scrape of ~1,960 pages is ~40 requests, not ~1,960. BATCH is
 *      pinned at 50 and never raised blind: >50 ids returns HTTP 200 with ZERO pages and no
 *      warning (AGENTS.md, measured).
 *   2. A REVISION-KEYED CACHE. Every page's wikitext is cached per page under
 *      `sources/cache/spells/<pageid>.wikitext` (committed — the whole tree is ~2 MB and it is
 *      what makes a re-run free) BESIDE an `index.json` recording the REVID that produced each
 *      file. A cheap `rvprop=ids` pass (also 50 at a time) asks the wiki what the current revids
 *      are, and only pages whose revid MOVED are re-fetched. So a re-run against an unchanged
 *      wiki fetches no content at all and writes a byte-identical spells.json — the ticket's
 *      "a full re-scrape is a no-op diff" acceptance, enforced by mechanism rather than by luck.
 *   3. A THROTTLE AND AN HONEST NAME. `THROTTLE_MS` (750) between every request, sequential —
 *      never concurrent — and a `User-Agent` that says who we are and links the repo.
 *
 * RESUMABLE: the cache file and the index entry are written per BATCH, so a run killed halfway
 * resumes from what it already has. Nothing is ever written before a complete response, so a
 * half-received batch can never look cached.
 *
 * AND THE FILE IT WRITES IS PRISTINE. Everything we know that the wiki does not lives in the
 * separable overlays beside the loader (spellCorrections.ts, spellEffectClass.ts), never in here —
 * this script rewrites spells.json wholesale, so a hand-edit into it is lost on the next run and
 * the diff of that run stops being readable.
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import type { SpellDbFile, SpellEntry } from '../src/shared/types'
// The one reader of the wiki's duration strings, shared with the LOADER (JOS-189) so a form this
// script cannot read at scrape time is still understood when the committed file is loaded.
import { parseDurationMs } from '../src/shared/spellDuration'
import { isMain } from './sources/isMain'
import { cachePath, indexedPages, readIndex, writeIndex } from './sources/spellCache'
import type { CacheIndex, WikiPage } from './sources/spellCache'

const API = 'https://eqlwiki.com/api.php'
const UA = 'everquest-companion/0.1 (+https://github.com/jmoyers/everquest-companion) spell catalog'

/** Milliseconds between HTTP requests. Sequential, never concurrent. */
const THROTTLE_MS = 1000
/** Pageids per query. MEASURED ceiling — 51 returns 200 OK with zero pages (AGENTS.md). */
const BATCH = 50
/** The scrape schema this script writes (SpellDbFile.schema). */
const SCHEMA = 3

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_PATH = resolve(HERE, '../src/main/data/spells.json')

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** How many HTTP requests this run made — reported at the end so the cost is never invisible. */
let requests = 0

/** ONE throttled, honestly-identified GET. Every request in this file goes through it. */
async function api<T>(params: Record<string, string>): Promise<T> {
  if (requests > 0) await sleep(THROTTLE_MS)
  requests++
  const q = new URLSearchParams({ format: 'json', formatversion: '2', ...params })
  const res = await fetch(`${API}?${q}`, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`${params.action ?? 'query'} failed: ${res.status}`)
  return (await res.json()) as T
}

/** Enumerate all page titles embedding Template:Spellpage, following eicontinue. */
async function listSpellPages(): Promise<WikiPage[]> {
  const out: WikiPage[] = []
  let eicontinue: string | undefined
  for (let page = 0; page < 200; page++) {
    const json = await api<{
      query?: { embeddedin?: WikiPage[] }
      continue?: { eicontinue?: string }
    }>({
      action: 'query',
      list: 'embeddedin',
      eititle: 'Template:Spellpage',
      einamespace: '0', // main namespace only (real spell pages, not template docs)
      eilimit: '500',
      ...(eicontinue ? { eicontinue } : {})
    })
    for (const p of json.query?.embeddedin ?? []) out.push(p)
    eicontinue = json.continue?.eicontinue
    if (!eicontinue) break
  }
  // Sorted so a batch always covers the same slice of pages across runs — the property that makes
  // a killed run resume instead of re-fetching a different 50.
  return out.sort((a, b) => a.pageid - b.pageid)
}

// ---- the revision-keyed cache: sources/spellCache.ts --------------------------------------------

interface RevPage {
  pageid?: number
  title: string
  missing?: boolean
  revisions?: { revid?: number; slots?: { main?: { content?: string } } }[]
}

/** Current revid per pageid, 50 at a time — the cheap question that avoids the expensive one. */
async function fetchRevIds(pages: WikiPage[]): Promise<Map<number, number>> {
  const out = new Map<number, number>()
  for (let i = 0; i < pages.length; i += BATCH) {
    const slice = pages.slice(i, i + BATCH)
    const j = await api<{ query?: { pages?: RevPage[] } }>({
      action: 'query',
      prop: 'revisions',
      rvprop: 'ids',
      pageids: slice.map((p) => p.pageid).join('|')
    })
    for (const p of j.query?.pages ?? []) {
      const revid = p.revisions?.[0]?.revid
      if (p.pageid != null && revid != null) out.set(p.pageid, revid)
    }
  }
  return out
}

/**
 * Fetch the wikitext of `stale`, 50 pages per request, writing each page's cache file and its
 * revid as every batch completes (so a killed run keeps what it already paid for).
 *
 * Returns the pageids the wiki gave us nothing for — reported, never silently dropped.
 */
async function fetchStaleContent(stale: WikiPage[], idx: CacheIndex): Promise<number[]> {
  const failures: number[] = []
  for (let i = 0; i < stale.length; i += BATCH) {
    const slice = stale.slice(i, i + BATCH)
    const j = await api<{ query?: { pages?: RevPage[] } }>({
      action: 'query',
      prop: 'revisions',
      rvprop: 'ids|content',
      rvslots: 'main',
      pageids: slice.map((p) => p.pageid).join('|')
    })
    const seen = writeBatch(j.query?.pages ?? [], idx)
    for (const p of slice) if (!seen.has(p.pageid)) failures.push(p.pageid)
    // Persist per batch: this is what "resumable" means here.
    idx.updatedAt = new Date().toISOString()
    writeIndex(idx)
    const done = Math.min(i + BATCH, stale.length)
    if (done % 100 < BATCH || done === stale.length) {
      console.log(`  fetched ${done}/${stale.length} stale pages`)
    }
  }
  return failures
}

/** Write one batch's wikitext to the cache and record its revids. Returns the pageids written. */
function writeBatch(pages: RevPage[], idx: CacheIndex): Set<number> {
  const seen = new Set<number>()
  mkdirSync(dirname(cachePath(0)), { recursive: true })
  for (const p of pages) {
    const rev = p.revisions?.[0]
    if (p.pageid == null || rev?.revid == null) continue
    const content = rev.slots?.main?.content
    if (content == null) continue
    writeFileSync(cachePath(p.pageid), content)
    idx.revs[String(p.pageid)] = rev.revid
    seen.add(p.pageid)
  }
  return seen
}

/**
 * Pull `| field = value` assignments out of a Template:Spellpage wikitext block. Values
 * run to the next top-level `| field =` or the template's closing `}}`. We slice the
 * Spellpage block first so nested tables/templates (SpellWhereTable, SpellSlotRow) inside
 * a field value don't get mistaken for template fields.
 */
export function parseSpellpageFields(wikitext: string): Record<string, string> {
  const start = wikitext.indexOf('{{Spellpage')
  if (start < 0) return {}
  const block = wikitext.slice(start, templateBlockEnd(wikitext, start))

  const fields: Record<string, string> = {}
  const marks = fieldMarks(block)
  for (let i = 0; i < marks.length; i++) {
    const cur = marks[i]
    const last = i + 1 === marks.length
    let val = block.slice(cur.valStart, last ? block.length : marks[i + 1].at)
    // Only the LAST field's value runs into the template's own closing `}}` (was:
    // `msg_wears_off = Your illusion fades. }}`); any other field's trailing `}}` closes a
    // template inside the value (`{{Era | Kunark}}`) and stays.
    if (last) val = val.replace(/\}\}\s*$/, '')
    fields[cur.name.toLowerCase()] = val.trim()
  }
  return fields
}

/**
 * Every direct Spellpage field: a `|name =` (or `||name =`) at template depth 1 and outside
 * `[[ ]]`, wherever it sits — on its own line or several to a line
 * (`{{Spellpage||spellname=…|classes=…}}`). `at` is the pipe, `valStart` just past the `=`.
 */
function fieldMarks(block: string): { name: string; at: number; valStart: number }[] {
  const marks: { name: string; at: number; valStart: number }[] = []
  const depth = { tpl: 0, link: 0 }
  for (let i = 0; i < block.length; i++) {
    const m = block[i] === '|' && depth.tpl === 1 && depth.link === 0 ? /^\|+\s*([a-zA-Z_0-9]+)\s*=/.exec(block.slice(i, i + 80)) : null
    if (m) {
      marks.push({ name: m[1], at: i, valStart: i + m[0].length })
      i += m[0].length - 1
    } else {
      i += bracketStep(block.slice(i, i + 2), depth)
    }
  }
  return marks
}

/** Track `{{ }}` / `[[ ]]` nesting; returns 1 when `two` was a bracket pair to skip past. */
function bracketStep(two: string, depth: { tpl: number; link: number }): number {
  if (two === '{{') depth.tpl++
  else if (two === '}}') depth.tpl--
  else if (two === '[[') depth.link++
  else if (two === ']]') depth.link = Math.max(0, depth.link - 1)
  else return 0
  return 1
}

/**
 * Index just past the `}}` that closes the template opening at `start`, by brace depth.
 * Falls back to the end of the text when the template is never closed.
 */
function templateBlockEnd(text: string, start: number): number {
  let depth = 0
  for (let i = start; i < text.length - 1; i++) {
    if (text[i] === '{' && text[i + 1] === '{') {
      depth++
      i++
    } else if (text[i] === '}' && text[i + 1] === '}') {
      depth--
      i++
      if (depth === 0) return i + 1
    }
  }
  return text.length
}

/** Strip wiki markup from a short field value → plain text. */
function clean(v: string | undefined): string | undefined {
  if (v == null) return undefined
  let s = v
  s = s.replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1') // [[Page|Label]] → Label
  s = s.replace(/\[\[([^\]]*)\]\]/g, '$1') // [[Page]] → Page
  s = s.replace(/'''?/g, '') // bold/italic
  s = s.replace(/<[^>]+>/g, ' ') // html tags
  s = s.replace(/\{\{:\s*([^}|]+?)\s*\}\}/g, '$1') // {{:Page}} transclusion → Page
  s = s.replace(/\{\{[^}]*\}\}/g, ' ') // stray templates
  s = s.replace(/\s+/g, ' ').trim()
  return s || undefined
}

// ---- the effect list (JOS-251) ----------------------------------------------------------------

/** What one page's slot table says: the effect rows in order, plus the bard instrument row. */
export interface SlotTable {
  effects: string[]
  instrument?: string
}

/**
 * Read the `| slots =` field's `{{SpellSlotRow}}` / `{{SpellSlotRowSmart}}` rows.
 *
 * A row is `{{SpellSlotRow | <slot> | <text> }}`, where `<slot>` is the effect's ordinal (1..12,
 * or a literal `?` on the seven rows nobody has confirmed) — except on bard pages, where ONE row
 * uses the slot column as a label: `{{SpellSlotRowSmart | Enhanced by instrument? | '''Yes''' }}`.
 * That row is not an effect and goes to its own field.
 *
 * SPLIT ON BRACE DEPTH, NEVER ON `|`. The `Smart` variant carries a trailing
 * `| simple = {{#ifeq:{{{Table|0}}}|0|0|1}}` whose parser-function body is FULL of pipes, and a
 * link inside an effect ("[[Yaulp]] becomes better here") can carry one too. Counting `{{`/`}}`
 * pairs handles the triple-brace `{{{Table|0}}}` correctly: `{{{` opens exactly one counted pair
 * and `}}}` closes it, so the depths stay balanced.
 *
 * Named parameters (`simple = …`) are dropped — the row's meaning is entirely positional.
 */
export function parseSlotRows(slots: string | undefined): SlotTable {
  const out: SlotTable = { effects: [] }
  if (!slots) return out
  const rowRe = /\{\{\s*SpellSlotRow[A-Za-z]*\s*\|/gi
  let m: RegExpExecArray | null
  while ((m = rowRe.exec(slots)) !== null) {
    const end = templateBlockEnd(slots, m.index)
    // Interior = everything between the opening `{{` and the closing `}}` — WHEN there is one.
    // THE LAST ROW OF A PAGE USUALLY HAS NONE, and that is not a wiki defect: `parseSpellpageFields`
    // strips one trailing `}}` off every field value (it belongs to the Spellpage template, and
    // leaving it in used to put `}}` inside a wears-off message), which for `slots` removes the
    // closer of its final row. Slicing `end - 2` unconditionally ate the last two characters of
    // exactly one effect per page — "Charm up to level 25" came out as "Charm up to level", which
    // is a roster that still classifies and a level cap that silently vanished.
    const closed = slots.slice(end - 2, end) === '}}'
    const interior = slots.slice(m.index + 2, closed ? end - 2 : end)
    const parts = splitTopLevel(interior)
    // parts[0] is the template name; the two positional params follow it.
    const positional = parts.slice(1).filter((p) => !/^[A-Za-z_][A-Za-z_0-9]*\s*=/.test(p))
    const slot = positional[0]?.trim() ?? ''
    const text = clean(positional[1])
    if (!text) continue
    if (/^enhanced by instrument\b/i.test(slot)) out.instrument = text
    else out.effects.push(text)
    rowRe.lastIndex = end
  }
  return out
}

/** Split a template's interior on `|` at brace depth 0. */
function splitTopLevel(interior: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < interior.length; i++) {
    if (interior[i] === '{' && interior[i + 1] === '{') {
      depth++
      i++
    } else if (interior[i] === '}' && interior[i + 1] === '}') {
      depth--
      i++
    } else if (interior[i] === '[' && interior[i + 1] === '[') {
      depth++
      i++
    } else if (interior[i] === ']' && interior[i + 1] === ']') {
      depth--
      i++
    } else if (interior[i] === '|' && depth === 0) {
      parts.push(interior.slice(start, i))
      start = i + 1
    }
  }
  parts.push(interior.slice(start))
  return parts
}

// THE DURATION READER LIVES IN src/shared/spellDuration.ts (JOS-189). It used to live here, and
// that is why a form it could not read became a permanent null in the committed catalog: its only
// caller ran at SCRAPE time. The loader now fills those nulls through the SAME function, so the two
// can never disagree about what a wiki duration string means.

/** A page-title disambiguator, never part of the spell's name: `Spell:`/`Effect:`/`Song:` prefixes
 *  (the game names no song `Song: …`; the three such pages duplicate pages titled plainly), a
 *  `(Spell)`/`(Effect)` suffix, a glued `Test` (`Burst of FlameTest`). */
export function stripTitleDecoration(title: string): string {
  return title
    .replace(/^(Spell|Effect|Song)\s*:\s*/i, '')
    .replace(/\s*\((Spell|Effect)\)$/i, '')
    .replace(/(?<=[a-z])Test$/, '')
    .trim()
}

const foldName = (s: string): string => s.toLowerCase().replace(/[`’]/g, "'").replace(/\s+/g, ' ').trim()

/**
 * The spell's name. The PAGE TITLE wins: `|spellname` is often copy-pasted from a sibling page
 * (57458 'Healing Water' says 'Greater Healing'), which made the real spell vanish under a
 * duplicate, and the class tables agree with the title. When the two differ only by a title
 * decoration, case or a backtick, the `|spellname` spelling is kept. `disagrees` marks a real
 * conflict, for the run to print.
 */
export function spellName(title: string, spellname: string | undefined): { name: string; disagrees: boolean } {
  const fromTitle = stripTitleDecoration(title)
  if (!spellname) return { name: fromTitle, disagrees: false }
  const stated = stripTitleDecoration(spellname)
  if (foldName(fromTitle) === foldName(stated)) return { name: stated, disagrees: false }
  return { name: fromTitle, disagrees: true }
}

export function parseSpell(title: string, fields: Record<string, string>): SpellEntry {
  const name = spellName(title, clean(fields.spellname)).name
  const durationText = clean(fields.duration)
  const castRaw = clean(fields.casting_time)
  // `casting_time = Instant` (song/proc pages) is a stated zero, not an absent field.
  const castSec = castRaw && /^instant$/i.test(castRaw) ? 0 : castRaw ? parseFloat(castRaw) : NaN
  // Schema 3: the re-use timer, read exactly the way casting_time is. The template writes
  // `recast_time = 1.50 sec`; a page that omits the field stays absent, never 0.
  const recastRaw = clean(fields.recast_time)
  const recastSec = recastRaw ? parseFloat(recastRaw) : NaN
  const manaRaw = clean(fields.mana)
  const mana = manaRaw && /^\d+$/.test(manaRaw) ? Number(manaRaw) : undefined
  // Illusion detection: the effects/slots/description/other text mentioning "Illusion".
  const effectsBlob = [fields.slots, fields.description, fields.effects, fields.other, fields.spellname]
    .filter(Boolean)
    .join(' ')
  const illusion = /illusion/i.test(effectsBlob)
  const slotTable = parseSlotRows(fields.slots)

  return {
    name,
    durationText,
    durationMs: parseDurationMs(durationText),
    castTimeMs: Number.isFinite(castSec) ? Math.round(castSec * 1000) : undefined,
    ...(Number.isFinite(recastSec) ? { recastMs: Math.round(recastSec * 1000) } : {}),
    targetType: clean(fields.target_type),
    spellType: clean(fields.spell_type),
    classes: clean(fields.classes),
    msgCastOnYou: clean(fields.msg_cast_on_you),
    msgCastOnOther: clean(fields.msg_cast_on_other),
    msgWearsOff: clean(fields.msg_wears_off),
    illusion,
    mana,
    // Absent rather than empty: a page with no slot table said nothing, and `[]` would read as
    // "the wiki says this spell does nothing".
    ...(slotTable.effects.length ? { effects: slotTable.effects } : {}),
    ...(slotTable.instrument ? { instrumentEnhanced: slotTable.instrument } : {})
  }
}

/**
 * THE TIMESTAMP IS THE LAST THING THAT CAN BREAK IDEMPOTENCE, and it did.
 *
 * The ticket's acceptance is "a full re-scrape is a no-op diff when the wiki has not changed", and
 * a `scrapedAt` stamped unconditionally makes that impossible: every re-run rewrites one line, the
 * committed file goes dirty, and the ONE signal that would tell a reviewer the wiki moved is
 * drowned by a signal that fires every time. So the stamp is kept when the spell list this run
 * produced is identical to the one already committed — it dates the DATA, not the invocation.
 *
 * Returns the previous stamp when nothing moved, `undefined` when something did (or when there is
 * no previous file to compare against).
 */
function previousScrapedAt(spells: readonly SpellEntry[]): string | undefined {
  if (!existsSync(OUT_PATH)) return undefined
  try {
    const prev = JSON.parse(readFileSync(OUT_PATH, 'utf8')) as SpellDbFile
    if (prev.schema !== SCHEMA) return undefined
    return JSON.stringify(prev.spells) === JSON.stringify(spells) ? prev.scrapedAt : undefined
  } catch {
    return undefined
  }
}

/** A page the wiki has marked for deletion is not a spell, whatever template it embeds
 *  (51190 `Kurrat's Magician Epic Guide` carries a Spellpage for Summon Orb). */
const DELETE_MARK = /\{\{\s*Delete\b/i

/** PHASE 3: every page parsed from the cache, with each page that yielded nothing, is marked for
 *  deletion, or whose title overrode a different `|spellname`, named for the run log. */
function parseCachedPages(pages: WikiPage[]): {
  spells: SpellEntry[]
  missing: number[]
  noFields: string[]
  deleted: string[]
  nameConflicts: string[]
} {
  const out = {
    spells: [] as SpellEntry[],
    missing: [] as number[],
    noFields: [] as string[],
    deleted: [] as string[],
    nameConflicts: [] as string[]
  }
  let done = 0
  for (const p of pages) {
    const file = cachePath(p.pageid)
    if (!existsSync(file)) {
      out.missing.push(p.pageid)
      continue
    }
    const wikitext = readFileSync(file, 'utf8')
    if (DELETE_MARK.test(wikitext)) {
      out.deleted.push(`${p.pageid} ${p.title}`)
      continue
    }
    const fields = parseSpellpageFields(wikitext)
    if (Object.keys(fields).length) out.spells.push(parseSpell(p.title, fields))
    else if (wikitext.includes('{{Spellpage')) out.noFields.push(`${p.pageid} ${p.title}`)
    const stated = clean(fields.spellname)
    if (spellName(p.title, stated).disagrees) out.nameConflicts.push(`${p.pageid} '${p.title}' (spellname '${stated}')`)
    if (++done % 100 === 0) console.log(`  parsed ${done}/${pages.length}`)
  }
  return out
}

/** PHASES 1 and 2: which cached pages the wiki has moved past, and their fresh text. */
async function refreshCache(pages: WikiPage[], idx: CacheIndex): Promise<{ hits: number; stale: WikiPage[]; failures: number[] }> {
  // PHASE 1 — what has changed? One cheap `rvprop=ids` question per 50 pages.
  console.log(`Checking revisions (${Math.ceil(pages.length / BATCH)} batches of ${BATCH})…`)
  const live = await fetchRevIds(pages)
  const stale = pages.filter((p) => {
    const known = idx.revs[String(p.pageid)]
    const now = live.get(p.pageid)
    // No revid from the wiki ⇒ trust the cache if we have one, re-fetch if we do not.
    if (now == null) return !existsSync(cachePath(p.pageid))
    return known !== now || !existsSync(cachePath(p.pageid))
  })
  const hits = pages.length - stale.length
  console.log(`  cache hits: ${hits}/${pages.length}; ${stale.length} to fetch`)

  // PHASE 2 — fetch only those, 50 at a time, writing per batch so a kill is resumable.
  const failures = stale.length ? await fetchStaleContent(stale, idx) : []
  return { hits, stale, failures }
}

async function main(): Promise<void> {
  const t0 = Date.now()
  // `--offline` re-parses the committed cache and sends the wiki nothing: the way to re-derive
  // spells.json after a parser change (owner, 2026-10-10). It needs the titles a real run records.
  const offline = process.argv.includes('--offline')
  const idx = readIndex()
  console.log(offline ? 'Reading the cache index (offline, no requests)…' : 'Enumerating Template:Spellpage pages…')
  const pages = offline ? indexedPages(idx) : await listSpellPages()
  console.log(`Found ${pages.length} spell pages.`)

  const { hits, stale, failures } = offline
    ? { hits: pages.length, stale: [] as WikiPage[], failures: [] as number[] }
    : await refreshCache(pages, idx)

  // PHASE 3 — parse every page from the cache. The wiki is not consulted here at all, so the
  // committed JSON is a pure function of the committed cache: same cache ⇒ byte-identical file.
  const { spells, missing, noFields, deleted, nameConflicts } = parseCachedPages(pages)
  // Titles beside revids, so a later re-parse has the name source offline too.
  idx.titles = Object.fromEntries(pages.map((p) => [String(p.pageid), p.title]))
  writeIndex(idx)

  // By NAME, over a list already in PAGEID order — and `Array.prototype.sort` has been required to
  // be stable since ES2019, so the handful of names the wiki carries twice (era/rank duplicates
  // like the two `Solon's Bravura` rows) land in a fixed, reproducible order rather than whatever
  // the enumeration happened to return. That matters beyond tidiness: spellCorrections.ts's
  // message corrections write the FIRST row of a name.
  spells.sort((a, b) => a.name.localeCompare(b.name))
  const withDur = spells.filter((s) => s.durationMs != null).length
  const withCastMsg = spells.filter((s) => Boolean(s.msgCastOnYou) || Boolean(s.msgCastOnOther)).length
  const withWearsOff = spells.filter((s) => s.msgWearsOff).length
  const illusions = spells.filter((s) => s.illusion).length
  const withEffects = spells.filter((s) => s.effects?.length).length
  const withInstrument = spells.filter((s) => s.instrumentEnhanced).length

  const out: SpellDbFile = {
    scrapedAt: previousScrapedAt(spells) ?? new Date().toISOString(),
    schema: SCHEMA,
    count: spells.length,
    withEffects,
    spells
  }
  mkdirSync(dirname(OUT_PATH), { recursive: true })
  writeFileSync(OUT_PATH, JSON.stringify(out, null, 2))

  console.log(`\nWrote ${spells.length} spells → ${OUT_PATH}`)
  console.log(
    `  durations: ${withDur} (${((withDur / spells.length) * 100).toFixed(0)}%)  ` +
      `cast-msg: ${withCastMsg} (${((withCastMsg / spells.length) * 100).toFixed(0)}%)  ` +
      `wears-off: ${withWearsOff} (${((withWearsOff / spells.length) * 100).toFixed(0)}%)  ` +
      `illusion: ${illusions}`
  )
  console.log(
    `  effects: ${withEffects} (${((withEffects / spells.length) * 100).toFixed(0)}%)  ` +
      `instrument-flag: ${withInstrument}`
  )
  console.log(
    `  requests: ${requests}  cache hits: ${hits}  fetched: ${stale.length - failures.length}  ` +
      `wall: ${((Date.now() - t0) / 1000).toFixed(1)}s`
  )
  if (failures.length) console.log(`  FETCH FAILURES (no revision returned): ${failures.join(', ')}`)
  if (missing.length) console.log(`  NOT IN CACHE (skipped): ${missing.join(', ')}`)
  if (noFields.length) console.log(`  SPELLPAGE WITH NO FIELDS READ (skipped): ${noFields.join('; ')}`)
  if (deleted.length) console.log(`  MARKED {{Delete}} (skipped): ${deleted.join('; ')}`)
  for (const c of nameConflicts) console.log(`  title wins over a different |spellname: ${c}`)
}

if (isMain(import.meta.url)) void main()
