// data-diff.mts — what a data re-derive changed, record by record and field by field, so a data
// commit is reviewed by this summary and not by a one-line JSON diff (owner, 2026-10-10).
//
//   npx tsx scripts/data-diff.mts [<git ref>] [<file> ...]
//
// Compares the working tree against <ref> (default HEAD) for the wiki-derived files below, or the
// files named. Reads git and the working tree only; dev time, never the app.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_FILES = [
  'src/main/data/items.json',
  'src/main/data/spells.json',
  'src/main/data/spellLines.json',
  'src/main/data/respawns.json',
  'src/renderer/src/data/eqlegends/mobs.json',
  'src/renderer/src/data/eqlegends/quests.json',
  'src/renderer/src/data/eqlegends/mobFactions.json',
  'src/renderer/src/data/eqlegends/mobRaces.json'
]

type Rec = Record<string, unknown>
type Coll = Map<string, unknown>

const isRec = (x: unknown): x is Rec => x !== null && typeof x === 'object' && !Array.isArray(x)
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const sample = (xs: string[], n: number): string =>
  xs.slice(0, n).join(' | ') + (xs.length > n ? ` … +${String(xs.length - n)}` : '')

/** A record's key: its name, page, key or id; a scalar is its own key. */
function keyOf(x: unknown): string {
  const k = isRec(x) ? (x.name ?? x.page ?? x.key ?? x.id) : x
  return typeof k === 'string' || typeof k === 'number' ? String(k) : JSON.stringify(x)
}

/** The file's record collection: its first top-level array (keyed by `keyOf`, duplicates
 *  numbered) or object of records (keyed as written). */
function collection(doc: unknown): Coll {
  const out: Coll = new Map()
  if (!isRec(doc)) return out
  const seen = new Map<string, number>()
  for (const v of Object.values(doc)) {
    if (Array.isArray(v)) {
      for (const x of v) {
        const k = keyOf(x)
        const n = (seen.get(k) ?? 0) + 1
        seen.set(k, n)
        out.set(n === 1 ? k : `${k} #${String(n)}`, x)
      }
      return out
    }
    if (isRec(v)) {
      for (const [k, x] of Object.entries(v)) out.set(k, x)
      return out
    }
  }
  return out
}

function kind(f: string, a: Rec, b: Rec): string {
  if (!(f in b)) return `${f}:lost`
  if (!(f in a)) return `${f}:gained`
  return `${f}:changed`
}

/** The fields that differ between two versions of one record. */
function fieldChanges(a: unknown, b: unknown): string[] {
  if (!isRec(a) || !isRec(b)) return ['<value>']
  const out: string[] = []
  for (const f of new Set([...Object.keys(a), ...Object.keys(b)])) if (!same(a[f], b[f])) out.push(kind(f, a, b))
  return out
}

function report(file: string, before: Coll, after: Coll): void {
  const removed = [...before.keys()].filter((k) => !after.has(k))
  const added = [...after.keys()].filter((k) => !before.has(k))
  const tally = new Map<string, string[]>()
  let changed = 0
  for (const [k, a] of before) {
    if (!after.has(k) || same(a, after.get(k))) continue
    changed++
    for (const f of fieldChanges(a, after.get(k))) tally.set(f, [...(tally.get(f) ?? []), k])
  }
  console.log(
    `\n${file}: ${String(before.size)} -> ${String(after.size)}  removed ${String(removed.length)}  ` +
      `added ${String(added.length)}  changed ${String(changed)}`
  )
  if (removed.length) console.log(`  removed: ${sample(removed, 8)}`)
  if (added.length) console.log(`  added: ${sample(added, 8)}`)
  const byCount = [...tally].sort((x, y) => y[1].length - x[1].length).slice(0, 15)
  for (const [f, keys] of byCount) console.log(`  ${f.padEnd(28)} ${String(keys.length).padStart(5)}  e.g. ${sample(keys, 3)}`)
}

function committed(ref: string, file: string): unknown {
  try {
    return JSON.parse(execFileSync('git', ['show', `${ref}:${file}`], { cwd: ROOT, maxBuffer: 1 << 28, encoding: 'utf8' }))
  } catch {
    return null
  }
}

const [ref = 'HEAD', ...files] = process.argv.slice(2)
for (const file of files.length ? files : DEFAULT_FILES) {
  const now: unknown = JSON.parse(readFileSync(join(ROOT, file), 'utf8'))
  report(file, collection(committed(ref, file)), collection(now))
}
