// PURE ROW SHAPING for the procs surface. No JSX, no MUI — the same MUI-free half that
// `dashboardData.ts` and `copyText.ts` occupy, so the node tests can assert these rows directly
// and both the panel AND the clipboard read the SAME shaping. A second spelling of "what does an
// absent rate look like" is exactly how the pasted block and the panel start disagreeing.
//
// TWO CONSUMERS LIVE HERE (JOS-37 collapsed this file from six):
//   `procListRows`      — the Procs CELL: name · PPM · count, ranked by count.
//   `procAnnotationFor` — the `proc · N ppm` tag a drilled skill row wears. That tag is where
//                         "deeper attribution" went when the analytics sections retired: the
//                         damage breakdown says which of YOUR lanes are procs and at what rate.
//
// HONESTY (the laws this file exists to enforce, AGENTS.md):
//   law 5 — a rate is ABSENT below its sample floor, NEVER 0. An absent rate renders an em dash;
//           `1 proc in a 2-second pull` is not `30 ppm`, and a meter that prints it once prints
//           it forever. The COUNT beside it is always exact — only the division is withheld.
//   law 2 — names are dirty: the is-a-proc index keys folded and displays raw.
//
// THE ACTIVE-TIME FLOOR IS SPELLED LITERALLY HERE. It is decided by
// `src/main/combat/procWindows.ts` (MIN_ACTIVE_SEC) and the renderer cannot import from
// `src/main`. It is used only to WORD the drill tag's hover ("needs at least 10s"), never to
// decide absence — absence is the engine's decision, read off the undefined field. So a drift
// here misstates a sentence; it can never manufacture or suppress a number.

import { formatCpm, formatPpm } from '../../lib/formatRate'
import { ORIGIN_COLOR } from './markerStyle'
import type { ProcsView } from '@shared/combat'
import type { ProcLaneView, ProcOrigin, ProcRateView, ProcSkillTag } from '@shared/procAnalytics'

/** Mirrors `procWindows.MIN_ACTIVE_SEC` — for the hover sentence only (see the header). */
export const MIN_ACTIVE_SEC = 10

/** What an absent rate LOOKS like. An em dash, never '0.0' and never a blank cell: a blank
 *  reads as "nothing to say", and this cell has something to say (see its hover). */
export const ABSENT = '-'

/**
 * The active-time caveat, stated rather than fixed (plan §4.2). `route()` accrues active time
 * BEFORE the incoming/outgoing split, so a pull where you are being beaten on while stunned
 * accrues active seconds you did not swing in. Changing that would move `activeDps`, a shipped
 * number, so the number keeps the meter's meaning and the UI says what it means.
 */
export const ACTIVE_TIME_NOTE = activeTimeNote('proc')

/** The same sentence in whichever unit the lane counts (JOS-438) — `Procs per minute …` for the
 *  three proc origins, `Clicks per minute …` for a held clicky. ONE spelling, one place. */
function activeTimeNote(unit: string): string {
  return (
    `${unit[0].toUpperCase()}${unit.slice(1)}s per minute of ACTIVE combat time - the meter’s own ` +
    'definition: gaps between attributed hits capped at 3s each, incoming damage included.'
  )
}

/** ONE cell of a rate column: what to draw, whether it is an absence, and what the hover says. */
export interface RateCell {
  text: string
  /** true when the sample floor was not met — `text` is then `ABSENT`. */
  absent: boolean
  /** The hover. For an absence it names the floor AND how short this selection is. */
  hint: string
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/**
 * THE SOURCE-WINDOW SENTENCE (2026-08-04). A proc can only fire while the thing that grants it
 * is present, so the engine now divides a lane's ppm by that window when it knows it — and says
 * so here, in the one place a ppm hover is written.
 *
 * The AMBIGUOUS wording is the load-bearing half: when the window is unknown the rate assumes
 * the source was up for the whole selection, which makes it a LOWER BOUND, and a lower bound
 * that does not announce itself is just a wrong number (law 1).
 */
export function sourceNote(rate: ProcRateView): string {
  if (rate.sourceName !== undefined) {
    return ` Per minute of ${rate.sourceName}’s own observed window (${Math.round(rate.sourceSec ?? 0)}s), not of the whole selection - a proc cannot fire while its source is off.`
  }
  if (rate.sourceAmbiguous) {
    return ' Assumes the source was active the whole fight: nothing in the log bounds when this proc’s source came or went, so the window is the whole selection and this rate is a LOWER bound.'
  }
  return ''
}

/**
 * The ppm cell. `ppmActive` is the headline denominator; the engine withholds it (and `ppmWall`)
 * below `MIN_ACTIVE_SEC`, and this renders that withholding rather than papering over it.
 *
 * `activeSec` is the SELECTION's active time, used only to word the absence. The denominator the
 * engine actually divided by rides on the rate itself (`sourceSec`) — see `sourceNote`.
 */
export function ppmCell(rate: ProcRateView, activeSec: number, origin: ProcOrigin = 'spell'): RateCell {
  // A CLICK LANE IS COUNTED IN CLICKS (JOS-438) — the number and its withholding rule are
  // identical, and the unit word is the entire difference the reporter asked for.
  const unit = ORIGIN_UNIT[origin]
  const fmt = origin === 'click' ? formatCpm : formatPpm
  if (rate.ppmActive === undefined) {
    const sec = Math.round(rate.sourceSec ?? activeSec)
    return {
      text: ABSENT,
      absent: true,
      hint:
        `No per-minute rate: that needs at least ${MIN_ACTIVE_SEC}s of active combat time and ` +
        `${rate.sourceName === undefined ? 'this selection' : `${rate.sourceName}’s window`} has ` +
        `${sec}s. ${plural(rate.count, unit)} counted - the count is exact; only the division ` +
        'is withheld.'
    }
  }
  const wall = rate.ppmWall === undefined ? '' : ` (${fmt(rate.ppmWall)} of wall clock)`
  return { text: fmt(rate.ppmActive), absent: false, hint: `${activeTimeNote(unit)}${wall}${sourceNote(rate)}` }
}

// ── THE GLANCEABLE LIST (JOS-37) ────────────────────────────────────────────────────
//
// Three columns and nothing else: name, PPM, count. `ppm` is a plain STRING here rather than a
// `RateCell` because the panel carries no hover at all — the diet's "delete the tooltip and let
// the label earn its keep", applied to a column that already labels itself. The absence is still
// an em dash and never a zero, which is the half of law 5 that actually protects the reader.

/** One row of the Procs cell. */
export interface ProcListRow {
  key: string
  name: string
  /** The label was ambiguous (a shared emote / a shared dispel tier) — the app's `~` treatment.
   *  The COUNT is exact either way; only the name is in doubt. */
  ambiguous: boolean
  origin: ProcOrigin
  count: number
  /** `4.0 ppm`, or ABSENT when the engine withheld the division (law 5). Never '0.0'. */
  ppm: string
}

/** `4.0 ppm` / `0.30 cpm` / `—`. The engine decides absence; this only spells it. */
function ppmText(rate: ProcRateView, origin: ProcOrigin): string {
  if (rate.ppmActive === undefined) return ABSENT
  return origin === 'click' ? formatCpm(rate.ppmActive) : formatPpm(rate.ppmActive)
}

function listRow(l: ProcLaneView): ProcListRow {
  return {
    key: `${l.origin}|${l.name}`,
    name: l.name,
    ambiguous: l.ambiguous === true,
    origin: l.origin,
    count: l.count,
    ppm: ppmText(l.rate, l.origin)
  }
}

/**
 * The proc list for one selection, RANKED BY COUNT (owner: "count-desc"), ties broken by name so
 * the order is stable across ticks.
 *
 * Falls back to the shipped poison-only `strikes` when the engine sent no unified lane list —
 * that payload predates the rate machinery, so those rows have no PPM to state and say so with
 * the same em dash rather than borrowing one.
 */
export function procListRows(p: ProcsView): ProcListRow[] {
  const lanes = p.lanes ?? []
  const rows: ProcListRow[] =
    lanes.length > 0
      ? lanes.map(listRow)
      : p.strikes.map((s) => ({
          key: `poison|${s.name}`,
          name: s.name,
          ambiguous: s.ambiguous === true,
          origin: 'poison',
          count: s.count,
          ppm: ABSENT
        }))
  return rows.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

/**
 * How many procs this selection saw — the ledger's own headline.
 *
 * The unified lane count when the engine sent one (poison Strikes, cast-less spell effects and
 * the two swing-borne AAs — Slay Undead and Finishing Blow — together), else the shipped
 * poison-only count. So the header can never quote a number the list under it does not add up to.
 */
export function procCount(p: ProcsView): number {
  return p.overall?.count ?? p.strikeCount
}

/** Firings of HELD CLICKIES in this selection (JOS-438) — counted apart from the procs above,
 *  because they are not procs and `overall` therefore excludes them. */
export function clickCount(p: ProcsView): number {
  return (p.lanes ?? []).reduce((n, l) => n + (l.origin === 'click' ? l.count : 0), 0)
}

/** Is there proc activity at all? Zero procs ⇒ the card's quiet note and no header readout:
 *  an empty selection must not grow furniture. A selection whose ONLY cast-less firings were
 *  clicks still has something to say, so the clicks count here too. */
export function hasProcActivity(p: ProcsView): boolean {
  return procCount(p) + clickCount(p) > 0
}

/** The card-level readout, in the one spelling the header and the clipboard share. */
export interface ProcSummary {
  /** Every detected proc in this selection. Always exact. */
  count: number
  /** Held-clicky firings, which are NOT in `count` (JOS-438). */
  clicks: number
  /** `3.1 ppm`, absent below the engine's own floor — never '0.0' (law 5). */
  ppm?: string
  /** `12 procs · 3.1 ppm`, or just `12 procs` when the rate was withheld — plus `· 3 clicks`
   *  when the selection had any. */
  header: string
}

/**
 * The header readout, READ from the ProcsView the list itself renders.
 *
 * Nothing is recomputed: `count` is the lanes' own total and `ppm` is the engine's `ppmActive`,
 * withheld below its sample floor and simply omitted here when it is. A selection with procs but
 * too short to divide reads `3 procs` — a count with no rate, which is the honest shape and not
 * a rate of zero.
 */
export function procSummary(p: ProcsView): ProcSummary {
  const count = procCount(p)
  const clicks = clickCount(p)
  const ppmActive = p.overall?.ppmActive
  const ppm = ppmActive === undefined ? undefined : formatPpm(ppmActive)
  // THE CLICKS ARE A SECOND TERM, NOT A SECOND RATE (JOS-438). A count that sums the rows the
  // card lists is what keeps the header honest; a per-minute figure for "how often did I press
  // buttons in this fight" belongs on the lane, where the reader can see WHICH button.
  const procs = ppm === undefined ? plural(count, 'proc') : `${plural(count, 'proc')} · ${ppm}`
  return {
    count,
    clicks,
    ...(ppm === undefined ? {} : { ppm }),
    header: clicks === 0 ? procs : `${procs} · ${plural(clicks, 'click')}`
  }
}

// ── THE DRILL ROWS LEARN THEIR RATE (docs/plans/proc-visibility.md §2) ───────────────

/** What each origin MEANS, said once, so the drill's hover can never soften it into "it's a
 *  proc". The spell sentence is the only INFERENCE in the feature and says so (law 1). */
const ORIGIN_NOTE: Record<ProcOrigin, string> = {
  poison: 'A rogue poison Strike: it printed its landing emote and no cast line, which is the only way a Strike ever appears.',
  spell: 'Detected as a proc by INFERENCE: this spell effect landed with no “You begin casting” line of yours behind it. The log never names what fired it, so this is a co-occurrence, not a source.',
  slay: 'The Slay Undead melee proc, counted from the damage taxonomy - it rides an ordinary weapon swing and prints no spell line of its own.',
  aa: 'An innate AA proc, counted from the “(Finishing Blow)” annotation the game prints on the swing it rode. Its damage stays in the melee lane, where it belongs - a weapon swing is a weapon swing - so the figure here is the damage of the swings that procced, not the damage the proc added. That estimate is the marginal below.',
  click:
    'NOT a proc - an item CLICK. It landed with no “You begin casting” line, exactly as a proc does, and your own inventory dump names an instant click effect of this spell that no weapon in the item database procs. The rate below is how often you pressed it, not how often it fired on its own.'
}

/** The WORD a lane's rate is measured in. A proc rate and a click rate are different claims, and
 *  the unit is where the difference has to show up (JOS-438). */
const ORIGIN_UNIT: Record<ProcOrigin, string> = {
  poison: 'proc', spell: 'proc', slay: 'proc', aa: 'proc', click: 'click'
}

/** A drill row's proc annotation: `proc · 3.1 ppm`, plus the hover that states its basis. */
export interface ProcAnnotation {
  text: string
  hint: string
  /** The lane's hue, resolved here so the tag and the Procs panel's dot read one table
   *  (`markerStyle.ORIGIN_COLOR`) and a `click` tag can never wear the proc magenta. */
  color: string
}

/**
 * The is-a-proc index for one selection, keyed case-insensitively (law 2 — names are dirty, key
 * folded, display raw).
 *
 * The tags are built in MAIN (procViews.ts) against the poison roster and the cast-less
 * detector; this is only the lookup. FIRST tag wins, which pins the engine's lane order
 * (poison, then spell, then slay) rather than letting a later lane silently relabel a row.
 */
export function procTagIndex(tags: readonly ProcSkillTag[] | undefined): ReadonlyMap<string, ProcSkillTag> {
  const m = new Map<string, ProcSkillTag>()
  for (const t of tags ?? []) {
    const k = t.skill.toLowerCase()
    if (!m.has(k)) m.set(k, t)
  }
  return m
}

/**
 * One drill row's annotation, or undefined when the ledger has no lane for that skill — which is
 * the answer for every ordinary melee row and for any spell you cast with your own hands.
 *
 * The rate is the LANE's `ppmActive` and nothing else, so this row and the Procs panel divide the
 * same count by the same seconds. When the engine withheld it (too little active time) the
 * annotation degrades to a bare `proc` and the hover says why: the fact that it IS a proc is
 * still worth stating, and a fabricated rate is not.
 */
export function procAnnotationFor(
  index: ReadonlyMap<string, ProcSkillTag>,
  skill: string
): ProcAnnotation | undefined {
  const t = index.get(skill.toLowerCase())
  if (!t) return undefined
  const unit = ORIGIN_UNIT[t.origin]
  const ppm = ppmCell(t.rate, t.activeSec, t.origin)
  const lane =
    t.lane === t.skill
      ? ''
      : ` Counted in the “${t.lane}” lane: one emote names both Strikes, so the count is exact and the name is not.`
  // The basis names the denominator the engine ACTUALLY divided by — the source's own window
  // when it knows one, the selection otherwise. `ppm.hint` then says which it was and what it
  // assumed; the two sentences are written once, in ppmCell/sourceNote, and read here.
  const sec = Math.round(t.rate.sourceSec ?? t.activeSec)
  const basis = ppm.absent
    ? ''
    : `${plural(t.rate.count, unit)} over ${sec}s of active combat in this selection. `
  return {
    text: ppm.absent ? unit : `${unit} · ${ppm.text}`,
    hint: `${ORIGIN_NOTE[t.origin]}${lane} ${basis}${ppm.hint}`,
    color: ORIGIN_COLOR[t.origin]
  }
}
