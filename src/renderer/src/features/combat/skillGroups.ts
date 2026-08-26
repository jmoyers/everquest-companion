// HOW THE FLAT LEVEL-2 LIST COLLAPSES NEAR-DUPLICATE ROWS INTO ONE.
//
// The meter's ability list is "one bar per engine skill" (JOS-113) with exactly two documented
// departures, and both live here so they share one merge, one ranking and one pair of labels:
//   - the Slay Undead aggregate (`groupSlay`, still in dashboardData beside the flatten it
//     belongs to) — one proc seen through four weapons;
//   - the spell-component merge (`groupSpellComponents`, JOS-244) — one spell seen through two
//     of the log's message shapes.
// Neither touches the engine. A group is a PRESENTATION of rows the engine already computed, so
// every total, category rollup and timeline lane is byte-identical either way (law 8); the merged
// rows survive as `children` inside the group's own expansion, one click down and no new nav
// level.
//
// Pure, JSX-free and node-tested. `SkillRow`/`FlatSkill` come back from dashboardData as TYPES
// only, so the import that closes the loop is erased at build time and there is no runtime cycle.

import { parseSpellRank, spellLineKey } from '../../../../shared/spellLines'
import type { DamageCategory } from '@shared/combat'
import type { FlatSkill, SkillRow } from './dashboardData'

/** Rank a level-2 list and re-base every bar pct on its new global max. Every grouping pass ends
 *  here, so a merged row — usually the biggest one — never leaves the list mis-scaled. */
export function rankRows(rows: SkillRow[]): SkillRow[] {
  // eslint-disable-next-line eqc/no-domain-munging -- JOS-459 cutover ledger item 3: no served view source answers this yet, so the renderer still derives SkillRow. Becomes a view descriptor when the source lands.
  const out = [...rows].sort((a, b) => b.total - a.total || b.hits - a.hits || a.name.localeCompare(b.name))
  const max = Math.max(1, ...out.map((r) => r.total))
  return out.map((r) => ({ ...r, pct: (r.total / max) * 100 }))
}

/**
 * Merge sibling rows into ONE group row carrying them as `children`.
 *
 * Aggregation is a plain sum over counts/damage with `max` = the largest single hit across the
 * children and `min` = the smallest LANDED one (0/absent minima are skipped — a resist/miss-only
 * lane carries no amount and must never pull the group minimum to 0). Children keep their own
 * numbers untouched and are ranked among themselves, their bar widths re-based on the LARGEST
 * child so the nested list reads as its own ranking rather than as slivers of the parent's width.
 */
export function mergeGroup(
  members: SkillRow[],
  name: string,
  category: DamageCategory,
  childKind: 'skill' | 'component'
): SkillRow {
  // eslint-disable-next-line eqc/no-domain-munging -- JOS-459 cutover ledger item 3: no served view source answers this yet, so the renderer still derives SkillRow. Becomes a view descriptor when the source lands.
  const children = [...members].sort((a, b) => b.total - a.total || b.hits - a.hits || a.name.localeCompare(b.name))
  // eslint-disable-next-line eqc/no-domain-munging -- JOS-459 cutover ledger item 3: no served view source answers this yet, so the renderer still derives SkillRow. Becomes a view descriptor when the source lands.
  const sum = (pick: (s: FlatSkill) => number): number => children.reduce((n, s) => n + pick(s), 0)
  const minima = children.map((s) => s.min ?? 0).filter((m) => m > 0)
  const childMax = Math.max(1, ...children.map((s) => s.total))
  return {
    name,
    category,
    total: sum((s) => s.total),
    pct: 0,
    hits: sum((s) => s.hits),
    crits: sum((s) => s.crits),
    max: Math.max(0, ...children.map((s) => s.max)),
    min: minima.length > 0 ? Math.min(...minima) : undefined,
    misses: sum((s) => s.misses ?? 0),
    resists: sum((s) => s.resists ?? 0),
    lands: sum((s) => s.lands ?? 0),
    childKind,
    children: children.map((s) => ({ ...s, pct: (s.total / childMax) * 100 }))
  }
}

/**
 * ONE SPELL IS ONE ROW, however many message shapes it printed (JOS-244, user report
 * 01KZSRAYCHF4ZX1PEP4RSPPM07 — "combat parsing is tracking the damage component of dot
 * separately").
 *
 * A DoT that also lands an initial direct hit prints its two halves in two different sentences,
 * and the game spells the SPELL DIFFERENTLY in each. Measured on the reporter's own slice, one
 * cast of one spell:
 *   `You hit <mob> for 55 points of poison damage by Envenomed Bolt.`   → skill "Envenomed Bolt"
 *   `<mob> has taken 419 damage from your Envenomed Bolt VI.`           → skill "Envenomed Bolt VI"
 * The landing sentence DROPS the rank numeral the tick sentence keeps — the same divergence
 * `spellCanonKey` was written for, since a fade/fizzle line drops the rank too — and the taxonomy
 * files the two under different categories, `spell` for the direct hit and `dot` for the ticks.
 * So the flat list grew TWO bars for one button press: "Envenomed Bolt VI" 14,131 and "Envenomed
 * Bolt" 189 in the reporter's biggest fight, with Plague VI 3,925 / Plague 181 beside them. It IS
 * one spell: every `You begin casting Envenomed Bolt VI.` in that slice is followed within two
 * seconds by exactly one landing line, 1:1 across four casts, and then by the tick train.
 *
 * The answer is the `groupSlay` answer one category over — the user reads them as one ability, so
 * the list shows ONE row and the split is one click down.
 *
 * THE KEY IS `spellLineKey` AND NOTHING ELSE — the shared mirror of the parser's own
 * `spellCanonKey` — so "the same spell" means here exactly what it means everywhere else in the
 * repo. Two consequences fall out of that, and they are why no marker handling is needed:
 *   - JOS-167's cast/proc split SURVIVES. A cast-less lane's name ends in the ` · proc` marker,
 *     which is a suffix no rank tail can sit behind, so "Envenomed Bolt · proc" keys apart from
 *     "Envenomed Bolt" and the two lanes the owner asked for stay two lanes.
 *   - Only `spell` and `dot` rows are eligible. A weapon lane is named after a VERB rather than a
 *     spell, and folding one into a spell that happens to share its name would be a lie about a
 *     lane rather than a merge of two descriptions of one cast. `melee`/`slay`/`ds` never enter.
 *
 * The group's NAME prefers a rank-bearing spelling ("Envenomed Bolt VI" over "Envenomed Bolt"):
 * the rank is real information the user pressed a button for, and only one of the two shapes ever
 * carries it. Its CATEGORY — the row's color — is the largest child's, so a DoT with a small
 * direct component reads as a DoT; both halves are stated in the expansion, so the color
 * summarizes rather than claims.
 */
export function groupSpellComponents(rows: SkillRow[]): SkillRow[] {
  const byKey = new Map<string, SkillRow[]>()
  for (const r of rows) {
    if (r.category !== 'spell' && r.category !== 'dot') continue
    if (r.children && r.children.length > 0) continue
    const key = spellLineKey(r.name)
    const prev = byKey.get(key)
    if (prev) prev.push(r)
    else byKey.set(key, [r])
  }
  const merging = [...byKey.values()].filter((m) => m.length > 1)
  if (merging.length === 0) return rows
  const merged = new Set(merging.flat())
  const groups = merging.map((m) => mergeGroup(m, groupSpellName(m), biggest(m).category, 'component'))
  // eslint-disable-next-line eqc/no-domain-munging -- JOS-459 cutover ledger item 3: no served view source answers this yet, so the renderer still derives SkillRow. Becomes a view descriptor when the source lands.
  return rankRows([...rows.filter((r) => !merged.has(r)), ...groups])
}

/** The member a group takes a summarizing property from: the largest, name-tiebroken. */
function biggest(members: SkillRow[]): SkillRow {
  // eslint-disable-next-line eqc/no-domain-munging -- JOS-459 cutover ledger item 3: no served view source answers this yet, so the renderer still derives SkillRow. Becomes a view descriptor when the source lands.
  return [...members].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))[0]
}

/** The display name for a merged spell row: a rank-bearing spelling if any member has one (the
 *  biggest such member wins), else the biggest member's name. Deterministic either way. */
function groupSpellName(members: SkillRow[]): string {
  // eslint-disable-next-line eqc/no-domain-munging -- JOS-459 cutover ledger item 3: no served view source answers this yet, so the renderer still derives SkillRow. Becomes a view descriptor when the source lands.
  const suffixed = members.filter((r) => parseSpellRank(r.name).suffixed)
  return biggest(suffixed.length > 0 ? suffixed : members).name
}

/**
 * A group row's two labels: the count that rides the bar face (` · 2 components`) so the merge is
 * visible without opening it, and the heading over the expansion that holds the parts.
 *
 * The noun is the difference between the two groups. Slay Undead stands for separate ABILITIES —
 * a backstab and a bash really are two things that both procced — while a spell group stands for
 * one cast described twice, which is a COMPONENT and not an ability of its own. A row that stands
 * for nothing but itself gets an empty face and never renders a heading.
 */
export function groupLabels(s: SkillRow): { face: string; heading: string } {
  const n = s.children?.length ?? 0
  const noun = s.childKind === 'component' ? 'component' : 'skill'
  return { face: n > 0 ? ` · ${n} ${noun}s` : '', heading: `By ${noun}` }
}
