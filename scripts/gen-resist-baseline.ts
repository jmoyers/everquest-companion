// Generate the COMMITTED resist baseline (JOS-382).
//
// Replays one or more real logs through the parser and `ResistFold` — the SAME class the running
// app folds a user's log with, so what ships and what a player mines cannot drift — and writes the
// pooled observations to `src/main/data/resistBaseline.json`.
//
// WHY A BASELINE SHIPS AT ALL. The engine needs observations before it can say anything, and a
// fresh install has none: the mob page would be five "not enough data" rows for weeks. One
// player's four weeks in this log is ~50k attributable outcomes across 865 (mob, axis) cells,
// which is enough to answer "should I nuke fire or cold on a lava guardian" on day one.
//
// WHAT IS IN IT, AND WHAT IS DELIBERATELY NOT. Observations only — mob names, spell names and
// counts. No character names, no zones' chat, no verdicts. It records what the log printed and
// nothing this app concluded from it, exactly as `messageOverlay.baseline.json` does, because a
// stored conclusion is a second opinion waiting to disagree with the derived one and because a
// patch that retunes a spell must cost a re-estimate rather than a re-mine.
//
// AND NOTHING DERIVED FROM `spells_us.txt` IS IN IT. The fold never reads the client file, so this
// artifact is table-independent: it is the player's own log, not Daybreak's data.
//
// Run: `npm run gen:resist-baseline` (dev machine only; the log is never committed).
// Optionally pass log paths: `npm run gen:resist-baseline -- <path> [<path>...]`.
//
// ── `--compare`: THE MEASUREMENT THAT SET A DEFAULT (JOS-385) ────────────────────────────────────
//
// `npm run gen:resist-baseline -- --compare` writes NOTHING. It folds the same logs and then asks
// one question the owner posed and only real data can answer: does a charmed pet or an NPC caster
// get resisted DIFFERENTLY from a player, by the same creature, on the same axis?
//
// It matters because the answer decides a shipped default. If pets are tuned soft — resisted far
// less than players are — then counting their casts drags a mob's number toward "easy" on exactly
// the axis a player finds hard, and the honest thing is to ship the family OFF. If they are not,
// the family is ordinary evidence and shipping it off throws away the best-populated cells in the
// ledger (an NPC caster's level is KNOWN, where another player's never is).
//
// RAW RESIST RATES CANNOT SETTLE IT, which is why this mode exists at all rather than a grep. The
// worry case in the owner's log — a fire giant warrior, fire, players 56% resisted against NPC
// casters 18% — is a ~level-50 charmed mob throwing Lava Breath beside a level-24 player's arrows,
// and most of that gap is the level term. So both sides go through the SAME estimator, which
// removes levelMod and resistAdj, and the comparison is of R against R with intervals attached.
//
// THE CELLS IT PRINTS are every (mob, axis) where both populations put at least
// `COMPARE_MIN_OBSERVATIONS` observations INTO THE FIT (not merely into the ledger — a row with no
// caster level or a spell whose landings we cannot see is not evidence either side can use). A
// cell is FLAGGED when the two 95% intervals do not overlap, which is the same disjointness test
// the patch detector uses one file over: it is the only statement of the form "these two really do
// disagree" that the evidence can support.

import { createReadStream, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseEvent } from '../src/main/log/parser'
import { installCharacterName, installSpellDb } from '../src/main/log/rulesets'
import { loadSpellDb } from '../src/main/data/spellDb'
import { ResistFold } from '../src/main/resist/fold'
import { repoolAtWeek, rowTotal } from '../src/main/resist/ledger'
import { isoWeekKey } from '../src/shared/resistDecay'
import { parseSpellsUs } from '../src/main/resist/spellsUsParse'
import { estimate, fullDamageRefs, unobservableSpells } from '../src/shared/resistModel'
import {
  BASELINE_SOURCE_KEY,
  RESIST_AXES,
  RESIST_LEDGER_SCHEMA,
  type ResistAxis,
  type ResistFit,
  type ResistLedger,
  type ResistRow,
  type SpellResistTable,
} from '../src/shared/resistTypes'
import { resistBenchmark } from '../src/shared/resistFormula'

const DEFAULT_LOG =
  'C:/Users/Public/Daybreak Game Company/Installed Games/EverQuest Legends/Logs/eqlog_Primitive_freeport.txt'
const DEFAULT_SPELLS_US =
  'C:/Users/Public/Daybreak Game Company/Installed Games/EverQuest Legends/spells_us.txt'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '..', 'src', 'main', 'data', 'resistBaseline.json')

/**
 * A row has to carry this many observations to ship. Below it the estimator's prior dominates
 * anyway, so the row costs bytes and says nothing — and the user's own log will overwrite the
 * cell within an evening of play.
 */
const MIN_ROW_OBSERVATIONS = Number(process.env.EQ_RESIST_MIN_ROW ?? '5')

/**
 * PINNED, not `new Date()`. A re-run on an unchanged log must diff to nothing, so the only thing
 * in this file that is allowed to move is an observation (the same rule
 * `gen-message-overlay.ts` follows, and the one `tests/foldDeterminism.test.mts` exists to keep).
 */
const FROZEN_AT = '2026-08-16T00:00:00.000Z'

/**
 * EVERY BASELINE ROW CARRIES THE WEEK OF `frozenAt` (JOS-397), and the fold's own week buckets are
 * re-pooled onto it before anything else happens.
 *
 * The file is a SNAPSHOT, not a diary. Its rows have carried `firstTs: 0` since JOS-382 for the
 * reason the block below states — one player's itinerary is not a fact about a creature — and the
 * decay ages the whole file from `frozenAt` for the same reason: what a reader needs to know is how
 * stale the SHIPPED DATA is relative to their own play, not which Tuesday in July a particular cast
 * happened on.
 *
 * MEASURED, and this is why the re-pool is not optional: the owner's log spans four weeks, so
 * leaving the fold's buckets alone splits every cell into up to four rows, and the
 * `MIN_ROW_OBSERVATIONS` floor below then drops the pieces that a whole cell would have cleared. A
 * smaller file that knows less is the opposite of the trade this ticket is making.
 */
const BASELINE_WEEK = isoWeekKey(Date.parse(FROZEN_AT))

async function foldLog(fold: ResistFold, path: string): Promise<number> {
  let seq = 0
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line) continue
    const ev = parseEvent(line, seq++)
    if (ev) fold.onEvent(ev)
  }
  return seq
}

function spellsUsMtime(): number | null {
  try {
    return Math.round(statSync(process.env.EQ_SPELLS_US ?? DEFAULT_SPELLS_US).mtimeMs)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- `--compare` (JOS-385)

/** Both sides need this much evidence IN THE FIT before their disagreement means anything. */
const COMPARE_MIN_OBSERVATIONS = 20

/** The axes the owner's pet-tuning worry names. Magic is excluded: nothing about it was in doubt. */
const WORRY_AXES: readonly ResistAxis[] = ['fire', 'cold', 'poison', 'disease']

/** How far BELOW the player number an npc number has to sit before it is the worry rather than noise. */
const WORRY_GAP = 30

/** The share of flagged cells that has to show the worry before the family ships OFF. */
const WORRY_SHARE = 1 / 3

interface CompareCell {
  mobKey: string
  axis: ResistAxis
  pc: ResistFit
  npc: ResistFit
  /** The 95% intervals do not overlap: the two populations really do disagree here. */
  flagged: boolean
  /** Flagged, on a worry axis, and the npc number is `WORRY_GAP` or more BELOW the player one. */
  worry: boolean
}

const disjoint = (a: ResistFit, b: ResistFit): boolean => a.hi < b.lo || b.hi < a.lo

/** The level this mob's rows were filed under. The rows already carry it; the mode wins. */
function mobLevelOf(rows: readonly ResistRow[]): number | null {
  const counts = new Map<number, number>()
  for (const row of rows) {
    if (row.mobLevel === null) continue
    counts.set(row.mobLevel, (counts.get(row.mobLevel) ?? 0) + rowTotal(row))
  }
  let best: number | null = null
  let bestCount = 0
  for (const [level, count] of counts) {
    if (count > bestCount) {
      bestCount = count
      best = level
    }
  }
  return best
}

/**
 * One (mob, axis) cell measured twice, or null when either side is too thin.
 *
 * BOTH SIDES GO THROUGH THE SAME `estimate()` with the same options, which is the whole point:
 * levelMod and resistAdj come out identically, the prior is the same prior, and what is left is
 * the comparison the raw rates could not make.
 */
function compareCell(
  rows: readonly ResistRow[],
  spells: SpellResistTable,
  axis: ResistAxis,
  blind: ReadonlySet<string>
): { pc: ResistFit; npc: ResistFit } | null {
  const opts = { axis, mobLevel: mobLevelOf(rows), unobservable: blind, includeNpcCasters: true }
  const pc = estimate(rows.filter((r) => r.casterKind !== 'npc'), spells, opts)
  if (pc.n < COMPARE_MIN_OBSERVATIONS) return null
  const npc = estimate(rows.filter((r) => r.casterKind === 'npc'), spells, opts)
  if (npc.n < COMPARE_MIN_OBSERVATIONS) return null
  return {
    pc: { R: pc.R, lo: pc.lo, hi: pc.hi, n: pc.n },
    npc: { R: npc.R, lo: npc.lo, hi: npc.hi, n: npc.n },
  }
}

function compareCells(rows: readonly ResistRow[], spells: SpellResistTable): CompareCell[] {
  const blind = unobservableSpells(rows)
  const byMob = new Map<string, ResistRow[]>()
  for (const row of rows) {
    const list = byMob.get(row.mobKey)
    if (list) list.push(row)
    else byMob.set(row.mobKey, [row])
  }
  const out: CompareCell[] = []
  for (const [mobKey, mobRows] of byMob) {
    for (const axis of RESIST_AXES) {
      const fits = compareCell(mobRows, spells, axis, blind)
      if (!fits) continue
      const flagged = disjoint(fits.pc, fits.npc)
      out.push({
        mobKey,
        axis,
        ...fits,
        flagged,
        worry: flagged && WORRY_AXES.includes(axis) && fits.npc.R <= fits.pc.R - WORRY_GAP,
      })
    }
  }
  return out.sort((a, b) => (a.mobKey === b.mobKey ? a.axis.localeCompare(b.axis) : a.mobKey.localeCompare(b.mobKey)))
}

const pad = (s: string, w: number): string => (s.length >= w ? s : s + ' '.repeat(w - s.length))
const fit = (f: ResistFit): string => `${String(f.R)} [${String(f.lo)},${String(f.hi)}]`

/** The table, and the decision rule applied to it out loud. Prints; writes nothing. */
function reportCompare(cells: CompareCell[]): void {
  const cols = [34, 9, 7, 18, 7, 18, 8]
  const head = ['mob', 'axis', 'n_pc', 'R_pc [lo,hi]', 'n_npc', 'R_npc [lo,hi]', 'verdict']
  console.log(head.map((h, i) => pad(h, cols[i])).join(''))
  console.log(cols.map((w) => '-'.repeat(w - 1) + ' ').join(''))
  for (const c of cells) {
    const verdict = c.worry ? 'WORRY' : c.flagged ? 'differs' : ''
    const cellRow = [
      c.mobKey,
      c.axis,
      String(c.pc.n),
      fit(c.pc),
      String(c.npc.n),
      fit(c.npc),
      verdict,
    ]
    console.log(cellRow.map((v, i) => pad(v, cols[i])).join(''))
  }
  const flagged = cells.filter((c) => c.flagged)
  const worry = cells.filter((c) => c.worry)
  const share = flagged.length === 0 ? 0 : worry.length / flagged.length
  console.log('')
  console.log(
    `[compare] ${String(cells.length)} comparable cells (both sides >= ${String(COMPARE_MIN_OBSERVATIONS)} ` +
      `observations in the fit), ${String(flagged.length)} with disjoint intervals.`
  )
  console.log(
    `[compare] Of those, ${String(worry.length)} show the owner's worry (fire/cold/poison/disease, ` +
      `R_npc at least ${String(WORRY_GAP)} below R_pc) = ${(share * 100).toFixed(1)}%.`
  )
  console.log(
    `[compare] DECISION RULE: over ${String(Math.round(WORRY_SHARE * 100))}% => ship includeNpcCasters OFF. ` +
      `Measured: ${share > WORRY_SHARE ? 'OFF' : 'ON'}.`
  )
}

// ---------------------------------------------------------------- `--cells` and the invocation
//                                                                   census (JOS-387)

/**
 * WHAT THE INVOCATION TRACKING ACTUALLY SAW, printed on every mine.
 *
 * Two numbers the ticket asks for by name, and they are the honest audit of a state machine that
 * cannot be tested against ground truth: how much of your own evidence was gathered with the
 * overchannel invocation up, and how much of it predates the log's first invocation line and is
 * therefore counted but never weighed.
 */
function reportInvocations(rows: readonly ResistRow[]): void {
  const tally = { on: 0, off: 0, unknown: 0 }
  let ranked = 0
  const ranks = new Map<number, number>()
  for (const row of rows) {
    const total = rowTotal(row)
    if (row.rank > 0) {
      ranked += total
      ranks.set(row.rank, (ranks.get(row.rank) ?? 0) + total)
    }
    if (row.casterKind !== 'self') continue
    if (row.overchannel === null) tally.unknown += total
    else if (row.overchannel) tally.on += total
    else tally.off += total
  }
  const self = tally.on + tally.off + tally.unknown
  console.log(
    `[invocations] self observations ${String(self)}: ${String(tally.on)} in overchannel, ` +
      `${String(tally.off)} out of it, ${String(tally.unknown)} before the log's first invocation line.`
  )
  const spread = [...ranks.entries()].sort((a, b) => a[0] - b[0]).map(([r, n]) => `${String(r)}:${String(n)}`)
  console.log(`[ranks] ${String(ranked)} observations carry an upgrade rank (rank:observations ${spread.join(' ')})`)
}

/** The cells the ticket and the owner review name, so a before/after is one command. */
const REPORT_CELLS: readonly { mob: string; axis: ResistAxis }[] = [
  { mob: 'a thunder spirit princess', axis: 'magic' },
  { mob: 'a thunder spirit princess', axis: 'fire' },
  { mob: 'lord nagafen', axis: 'magic' },
  { mob: 'eye of veeshan', axis: 'poison' },
  { mob: 'eye of veeshan', axis: 'magic' },
  { mob: 'a dracoliche', axis: 'disease' },
  { mob: 'a dracoliche', axis: 'poison' },
]

/** The viewer the report benchmarks at: the owner's own level. */
const REPORT_VIEWER_LEVEL = 50

function reportCells(rows: readonly ResistRow[], spells: SpellResistTable): void {
  const blind = unobservableSpells(rows)
  const refs = fullDamageRefs(rows)
  for (const { mob, axis } of REPORT_CELLS) {
    const mobRows = rows.filter((r) => r.mobKey === mob)
    const mobLevel = mobLevelOf(mobRows)
    const est = estimate(mobRows, spells, { axis, mobLevel, unobservable: blind, modes: refs })
    const b = resistBenchmark(Math.max(0, est.R), REPORT_VIEWER_LEVEL, mobLevel)
    const tag = est.pinned
      ? `DOES NOT FIT (${String(est.empirical.resisted)}/${String(est.empirical.total)} resisted)`
      : est.resistsAlmostEverything
        ? 'may not land even with overchannel (hard rule)'
        : b.tag
    console.log(
      `${mob} / ${axis}: R ${String(Math.max(0, est.R))} (${String(Math.max(0, est.lo))}-${String(Math.max(0, est.hi))}) ` +
        `n=${String(est.nInformative)} informative / ${String(est.n)} total, mobLevel ${String(mobLevel)} -> ${tag} ` +
        `· lands ${String(Math.round(b.pPlain * 100))}% · with overchannel ${String(Math.round(b.pOver * 100))}%` +
        (est.npcOnly ? ' · from pets and other creatures only' : '') +
        (est.droppedNoLevel > 0 ? ` · ${String(est.droppedNoLevel)} dropped for no caster level` : '') +
        (est.droppedUnknownInvocation > 0
          ? ` · ${String(est.droppedUnknownInvocation)} dropped for unknown invocation`
          : '') +
        (est.droppedUnobservable > 0 ? ` · ${String(est.droppedUnobservable)} dropped as unobservable` : '')
    )
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const compare = args.includes('--compare')
  const cells = args.includes('--cells')
  const logs = args.filter((a) => !a.startsWith('-'))
  const paths = logs.length > 0 ? logs : [DEFAULT_LOG]

  installSpellDb(loadSpellDb())
  // The self `/who` row is keyed on the tailed character's name; without it a level is never read
  // off one, and every early observation would carry a null caster level.
  installCharacterName('Primitive')

  const fold = new ResistFold({ spellDb: loadSpellDb() })
  const all: ResistRow[] = []
  let lines = 0
  for (const path of paths) {
    fold.beginSource()
    lines += await foldLog(fold, path)
    fold.finish()
    all.push(...fold.rows())
  }
  // RE-POOL FIRST, FILTER SECOND. See `BASELINE_WEEK`: the floor is a statement about how much a
  // CELL has been observed, and applying it to week-sized fragments would throw away cells that
  // clear it several times over. `--compare` and `--cells` below keep the week-split rows, because
  // those two modes are reading the owner's live ledger rather than the snapshot that ships.
  const pooled = repoolAtWeek(all, BASELINE_WEEK)
  const kept = pooled.filter((row) => rowTotal(row) >= MIN_ROW_OBSERVATIONS)
  // THE MEASUREMENT BEHIND THE RE-POOL, printed on every mine so the decision stays checkable
  // rather than remembered: how much of this log the week buckets would have cost the shipped file.
  const unpooled = all.filter((row) => rowTotal(row) >= MIN_ROW_OBSERVATIONS)
  const obs = (rows: readonly ResistRow[]): number => rows.reduce((a, r) => a + rowTotal(r), 0)
  console.log(
    `[weeks] ${String(all.length)} week-split rows -> ${String(pooled.length)} pooled at ` +
      `${BASELINE_WEEK}. Past the ${String(MIN_ROW_OBSERVATIONS)}-observation floor: ` +
      `${String(kept.length)} rows / ${String(obs(kept))} observations pooled, against ` +
      `${String(unpooled.length)} rows / ${String(obs(unpooled))} observations unpooled`
  )

  if (compare || cells) {
    // The CLIENT's table, read straight rather than through the app's worker + cache: this is a dev
    // script on the dev machine, and 38 MB read once is cheaper than the plumbing.
    const spellsPath = process.env.EQ_SPELLS_US ?? DEFAULT_SPELLS_US
    const spells = parseSpellsUs(readFileSync(spellsPath, 'utf8'))
    console.log(`[${compare ? 'compare' : 'cells'}] ${String(lines)} lines -> ${String(all.length)} rows, spell table ${spellsPath}`)
    reportInvocations(all)
    if (compare) reportCompare(compareCells(all, spells))
    else reportCells(all, spells)
    return
  }

  // ZONES AND TIMESTAMPS ARE DROPPED. A baseline row states what a mob does; which zone this
  // player fought it in and at what hour on what evening are his itinerary, not facts about the
  // creature, and nothing downstream reads either. Same argument as the message overlay's
  // "no chat, no character name": the file records observations, and an observation is a count.
  //
  // AND SO IS THE WEEK, for a different reason and with no loss (JOS-397): every row of this file
  // carries the SAME week (see `BASELINE_WEEK`), so writing it four thousand times is 80 kB to say
  // a thing `frozenAt` already says once. `ResistLedgerStore.seed` fills it back in from that stamp
  // as the file is read, which is also what makes the shipped baseline age against a user's own log
  // rather than against a date nobody recorded.
  const rows = kept
    .map(({ zone: _zone, source: _source, week: _week, ...row }) => ({ ...row, firstTs: 0, lastTs: 0 }))
    .sort((a, b) =>
      a.mobKey === b.mobKey
        ? a.spellKey === b.spellKey
          ? a.family.localeCompare(b.family)
          : a.spellKey.localeCompare(b.spellKey)
        : a.mobKey.localeCompare(b.mobKey)
    )

  reportInvocations(all)

  const mtime = spellsUsMtime()
  const ledger: ResistLedger = {
    schema: RESIST_LEDGER_SCHEMA,
    frozenAt: FROZEN_AT,
    ...(mtime === null ? {} : { spellsUsMtime: mtime }),
    sources: [{ key: BASELINE_SOURCE_KEY, rows }],
  }
  const json = JSON.stringify(ledger) + '\n'
  writeFileSync(OUT, json, 'utf8')

  const mobs = new Set(rows.map((r) => r.mobKey)).size
  const observations = rows.reduce((a, r) => a + rowTotal(r), 0)
  console.log(
    `[gen-resist-baseline] ${String(lines)} lines -> ${String(rows.length)} rows ` +
      `(>= ${String(MIN_ROW_OBSERVATIONS)} observations each), ${String(mobs)} mobs, ` +
      `${String(observations)} observations, ${(json.length / 1024).toFixed(0)} kB -> ${OUT}`
  )
}

void main()
