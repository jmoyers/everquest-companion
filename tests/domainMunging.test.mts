// ============================================================================
// THE NO-MUNGING LAW'S OWN AUDIT (owner ruling 4, JOS-501).
// ============================================================================
//
// `eslint.domainMunging.mjs` is a lint rule and therefore already runs on every build — what it
// CANNOT check about itself is the thing this file checks: that its two hand-written registries
// still describe the tree they claim to describe, and that the exemptions it granted are the
// exemptions somebody argued for.
//
// A lint rule's blind spot is silent by construction. If a carve-out names a file that has been
// renamed, the carve-out simply stops matching and the rule quietly starts (or stops) firing on a
// whole family with nothing red anywhere. That is the same failure mode the breadcrumb ring had for
// a whole release (`tests/breadcrumbVocabulary.test.mts`), and the answer is the same: re-derive the
// original and compare.
//
// THE EXEMPTION CEILING IS THE OTHER HALF, and it is this file's most load-bearing assertion. The
// rule's exemptions are inline and reasoned, but nothing about an inline comment stops the next
// person adding a fortieth one. The count below is a RATCHET IN THE REPO'S OWN SENSE — it may only
// ever shrink, and shrinking it is what "the cutover ledger closed another item" looks like from
// here.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DOMAIN_MODULES,
  MUNGERS,
  NOT_DOMAIN_MODULES,
  NOT_DOMAIN_TYPES
} from '../eslint.domainMunging.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * THE EXEMPTIONS GRANTED WHEN THE LAW LANDED.
 *
 * MEASURED: 89 sites across 45 files reported by the rule against the tree as JOS-501 found it,
 * carried by 83 directives — six fewer than the sites, because a directive covers a LINE and this
 * codebase chains (`state.levels.filter(…).sort(…)` is one line and two violations). Every one
 * names its cutover-ledger item: item 3 for a list with no served view source yet, item 8 for a
 * corpus still bundled in the renderer by JOS-499's honest call.
 *
 * IT MAY ONLY GO DOWN. This is not a budget for new debt; it is a record of what the boundary cost
 * on the day it was drawn, and the whole point of drawing it.
 */
const EXEMPTIONS_WHEN_THE_LAW_LANDED = 83

/** Every `.ts`/`.tsx` file under the renderer. */
function rendererFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (/\.tsx?$/.test(entry.name)) out.push(p)
    }
  }
  walk(join(ROOT, 'src', 'renderer'))
  return out
}

test('the carve-out names files that EXIST — a stale entry is a silent blind spot', () => {
  // A renamed or deleted module leaves an entry that matches nothing, and the rule then starts
  // firing on a family somebody had decided was not domain data — or, worse, a domain module gets
  // renamed INTO the shape of a carve-out and the law goes quiet over it. Neither is visible
  // without this.
  const missing = NOT_DOMAIN_MODULES.filter((m) => !existsSync(join(ROOT, m)))
  assert.deepEqual(missing, [], 'a ruling-4 carve-out names a file that is not there any more')
})

test('the domain roots exist too, and the two lists do not contradict each other', () => {
  for (const root of DOMAIN_MODULES) {
    assert.ok(existsSync(join(ROOT, root)), `${root} is where domain types are supposed to live`)
  }
  // Every carve-out must sit UNDER a domain root — otherwise it is excluding something the rule was
  // never going to include, which means somebody misread one of the two lists.
  for (const m of NOT_DOMAIN_MODULES) {
    assert.ok(
      DOMAIN_MODULES.some((root) => m.startsWith(root)),
      `${m} is carved out of a domain root it does not belong to — one of the two lists is wrong`
    )
  }
})

test('the carved-out TYPE still lives in the module the carve-out assumes', () => {
  // `RespawnWatchPref` is excluded BY NAME because it shares a file with real respawn rows. If it
  // moves, the exclusion silently stops applying and a user preference starts being called domain
  // data — which would put an exemption on a line that never needed one.
  const respawn = readFileSync(join(ROOT, 'src', 'shared', 'respawn.ts'), 'utf8')
  for (const name of NOT_DOMAIN_TYPES) {
    assert.ok(
      respawn.includes(`interface ${name}`) || respawn.includes(`type ${name}`),
      `${name} is carved out by name but is no longer declared in shared/respawn.ts`
    )
  }
})

test('the rule watches exactly the four verbs the ruling names', () => {
  // `.slice` and `.map` are deliberately absent — the rule's header argues both at length, and the
  // argument is the sort of thing that gets quietly re-litigated by somebody adding one.
  assert.deepEqual([...MUNGERS].sort(), ['filter', 'flatMap', 'reduce', 'sort'])
  assert.equal(MUNGERS.has('slice'), false, 'windowing for a scroll box is render geometry')
  assert.equal(MUNGERS.has('map'), false, 'a projection is what a renderer is FOR')
})

test('EVERY EXEMPTION SAYS WHY, and names a ticket', () => {
  const bare: string[] = []
  for (const file of rendererFiles()) {
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (!line.includes('eqc/no-domain-munging')) return
      const said = line.split(' -- ')[1]?.trim() ?? ''
      // A ticket id or a real sentence. Both are acceptable; neither being present is not.
      if (said.length < 12 || !/JOS-\d+|because|still|no served/i.test(said)) {
        bare.push(`${file.slice(ROOT.length + 1)}:${String(i + 1)}`)
      }
    })
  }
  assert.deepEqual(bare, [], 'a ruling-4 exemption with no stated reason — zero silent exemptions')
})

test('THE EXEMPTION COUNT ONLY EVER SHRINKS', () => {
  let n = 0
  for (const file of rendererFiles()) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (line.includes('eslint-disable-next-line eqc/no-domain-munging')) n++
    }
  }
  assert.ok(
    n <= EXEMPTIONS_WHEN_THE_LAW_LANDED,
    `ruling 4 has ${String(n)} exemptions and landed with ${String(EXEMPTIONS_WHEN_THE_LAW_LANDED)}. ` +
      'This number may only go DOWN. A new site that needs one is a surface that should have asked ' +
      'the engine for a view instead — and if it genuinely cannot yet, lower this constant in the ' +
      'same change that raises the count, deliberately, with the argument in the commit message.'
  )
  // …and when it shrinks, the constant comes with it, or the ratchet stops meaning anything.
  assert.equal(
    n,
    EXEMPTIONS_WHEN_THE_LAW_LANDED,
    'exemptions were removed without lowering EXEMPTIONS_WHEN_THE_LAW_LANDED — do both, so the ' +
      'next reader sees the real ceiling rather than a stale one'
  )
})
