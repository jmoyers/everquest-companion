// BEST AT THIS LEVEL — the Leveling tab's right-hand efficiency readout (JOS-445).
//
// "New at this level" says what a level GAVE you. This says what to cast: of everything the loadout
// already owns, ranked at the level being viewed. The arithmetic is all in `shared/bestSpells.ts`
// (pure, node-tested); this file decides only how it is drawn.
//
// FOUR TABLES BEHIND FOUR TABS (JOS-448, owner ask 2026-08-22: "i want a section for dots/section
// for dd/section for heal/section for hot - tabs is probably the right metaphor in the panel").
//
// This column is a third of the row at `lg` with a 260px floor at the app's own minimum width, so
// seven numeric columns is ~30px each and reads as nothing. `SIDE_COLUMNS` splits them four and four
// (mana in both, because "what does it cost" is the same question either way) and the four tabs are
// two per side, so a tab always draws its side's four.
//
// THE STACK BECAME A PICKER, and that is the trade the owner named. Two sections drawn at once was
// right when there were two: the page is the scroller here (JOS-289) so vertical space was the cheap
// axis, and nothing was hidden behind a click. Four sections of up to ten rows each is a column of
// eighty rows, which is a scroll rather than a readout. Tabs spend one click to buy back the height,
// and the count on every label means the tabs you are NOT looking at still tell you whether there is
// anything in them.
//
// EACH TAB KEEPS ITS OWN SORT, which is what makes "best DD by dps AND best HoT by hps" a default
// state rather than a thing to set up, and what makes flipping to `dmg/mana` on the DoT table not
// disturb the DD one. The SELECTION itself is deliberately NOT persisted: a glance away and back
// should show the readout's default answer, not the last question somebody asked it.
//
// IT IS NOT GATED ON THE CHARTS, and that is the placement rule (owner, 2026-08-22: the readout
// belongs on the right side of the panel). Its neighbour below, `LedgerColumn`, is every panel that
// reads a SCOPE and therefore needs a chartable log; this one needs no log at all beyond the
// loadout, exactly like `NewAtLevelPanel`. A fresh character with two dings still wants to know
// which nuke is his best. So the right column exists whenever EITHER is drawable and this sits at
// the top of it.
//
// THE LEVEL IS THE TAB'S, NOT THIS PANEL'S. `LevelingView` owns the viewed level and hands the same
// number to this panel and to the stepper inside `NewAtLevelPanel` — one control, two readouts. Two
// steppers would be two levels on one screen and no way to tell which one a table is about.
//
// NO INNER SCROLLER (JOS-289, and `leveling.e2e` measures it): the top ten are drawn and the rest
// sit behind a `+N more` disclosure, the same one-click shape the out-of-era rows use. A porthole
// in a column that has no height to give is exactly what that ticket removed.
//
// ERA: `outOfEraLabel`, IMPORTED from the mob page the way `UnlockList` imports it — a second copy
// would be a second wording. Positive verdicts fold; silence is not a verdict and stays in place.
//
// AND A FIFTH TAB POINTS AT A PACK (JOS-449, owner ask 2026-08-23: "lets also have a separate AOE
// tab that assumes max target count"). The model builds it as a SECOND fold at each spell's max
// target count (`shared/bestSpells.ts` says why that is not a filter), so nothing here changes but
// the tab list and ONE marker: the assumption is drawn beside `directional`, on the AOE tab only,
// in the model's own words. The panel never computes the number it prints - a table that mixed a
// four-target cap with an eight-target one would otherwise be captioned with a number it did not
// use.
//
// AND IT SEARCHES THE WHOLE GAME NOW (JOS-450, owner ask 2026-08-23: "want search, same as the
// level spells" and "i want to be able to search for things outside my class to compare"). One box
// under the tabs, and while there is anything in it the ranked table gives way to RESULTS - the
// same headers, the same widths, the same two-line rows, so a druid heal can be held beside a
// wizard's own and read straight down one column. The rows and the matcher are both somebody else's
// (`BestSpellsRows.tsx`, `shared/bestSpellsSearch.ts` over `shared/spellSearch.ts`'s grammar); what
// this file decides is only that the box sits under the tabs and that the query is what switches
// the body. Rows outside the loadout are never added to the ranked tabs - they exist only under a
// query, because a tab answers "what should I cast" and a spell you cannot cast is not an answer.
//
// AND THE ROWS ARE AT THEIR MOTE RANK (JOS-447). Every figure here is read at
// `max(observed rank, simulated rank)`: the observed half is JOS-446's map, already subscribed for
// the `yours: VIII` chip that marks those rows, and the simulated half is `SpellRankSlider` under
// the tabs. The panel therefore answers two questions with one table - what my real spellbook does
// today, and what it would do if a candidate were levelled - which is the owner's ask read
// literally. The arithmetic is `shared/spellScale.ts`'s, fitted to his own log.

import { type JSX, useMemo, useState } from 'react'
import {
  Box,
  Chip,
  Paper,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tabs,
  Typography
} from '@mui/material'
import {
  TAB_LABEL,
  TAB_ORDER,
  bestSpellsAt,
  defaultSorts,
  tabColumns,
  type BestSpellColumn,
  type BestSpellRow,
  type BestSpellSort,
  type BestSpells,
  type BestSpellTab,
  type BestSpellsTable
} from '@shared/bestSpells'
import { searchBestSpells, EMPTY_BEST_SPELL_SEARCH } from '@shared/bestSpellsSearch'
import { tokenizeSpellQuery } from '@shared/spellSearch'
import { AOE_ASSUMPTION_TITLE } from '@shared/aoeSpells'
import { WORN_FOCUS_TITLE } from '@shared/wornFocus'
import { useWornFocus } from '../../lib/useWornFocus'
import { Tooltip } from '../../lib/Tooltip'
import { outOfEraLabel } from '../mobs/dropEra'
import { useCurrentComboClasses, useLevelUnlocks } from './useLevelUnlocks'
import { comboClassSet } from '@shared/levelUnlocks'
// The table primitives, shared with the search results next door (JOS-450) so a result and a
// ranked row are the same row — and, one component further in, the `yours: III` chip the unlock
// list draws (JOS-446): one wording, one tooltip.
import { CELL_SX, HeadCell, SpellRow, widthOf } from './BestSpellsRows'
import { BestSpellsResults, BestSpellsSearchField } from './BestSpellsSearch'
import { useObservedSpellRanks } from '../../lib/useObservedSpellRanks'
import type { ObservedSpellRanksSnap } from '@shared/spellRanks'
import { LevelStepper } from './LevelStepper'
import type { ViewedLevel } from './viewedLevel'
import SpellRankSlider from './SpellRankSlider'

/** How many rows are drawn before the disclosure. The owner's suggestion, and it fits the column. */
const TOP_N = 10

// THE COLUMN WIDTHS AND THE TWO-LINE ROW moved to `BestSpellsRows.tsx` with JOS-450, unchanged and
// with their measurements attached; the paragraph below is the measurement they came out of and it
// stays here, where the 260px floor is the panel's own problem.
//
// THE `over Ns` COLUMN IS NOT DRAWN, AND THE MEASUREMENT IS WHY (JOS-448, the ticket's one design
// note: a fifth narrow column on the DoT/HoT tabs "if it fits the 260px floor").
//
// It does not fit, and the four widths above are not a taste. MEASURED in the running app (a probe
// in the leveling e2e reading each header's own `scrollWidth` plus its cell padding, sort arrow
// included): `dps` needs 54px, `dmg` 60px, `mana` 65px and `dmg/mana` 93px, which is 272px of
// table. At the app's own minimum width the right column is 260px, the Paper's `p: 1.5` takes 24 of
// it, and the ~234px left over is what those percentages divide - so at the floor the four headers
// are ALREADY 38px past what they ask for, and the unequal shares above are a decision about which
// one clips first rather than spare room. A fifth column holding `over` and a `126s` value is
// another ~37px, taken from columns that have none to give.
//
// So the window stays on the ROW, where it already is: `SpellTooltip` prints the whole
// `spellMetricsParts` line for the spell under the cursor, `over 24s` included, and the tab label
// itself already says that every row in the table ticks. Widening the panel is not a fix available
// here: the 260px floor is the app's own minimum, and a readout that only reads at `lg` is wrong on
// exactly the machine it is wrong on.

/** A one-click disclosure over rows the section is not showing by default. */
function RowDisclosure({
  label,
  testid,
  rows,
  columns,
  ranks
}: {
  label: string
  testid: string
  rows: readonly BestSpellRow[]
  columns: readonly BestSpellColumn[]
  ranks: ObservedSpellRanksSnap | null
}): JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (rows.length === 0) return null
  return (
    <>
      <TableRow>
        <TableCell colSpan={columns.length} sx={{ ...CELL_SX, py: 0 }}>
          <Box
            role="button"
            tabIndex={0}
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') setOpen(!open)
            }}
            data-testid={testid}
            sx={{ cursor: 'pointer', color: 'text.secondary', '&:hover': { color: 'primary.main' } }}
          >
            <Typography variant="caption" sx={{ fontSize: 10 }}>
              {label}
            </Typography>
          </Box>
        </TableCell>
      </TableRow>
      {open && rows.map((r) => <SpellRow key={r.name} row={r} columns={columns} ranks={ranks} />)}
    </>
  )
}

/**
 * ONE TAB'S TABLE. Empty is STATED rather than blank: a wizard has no healing tabs at all and a
 * warrior has none of the four, and both are honest answers rather than a panel that failed to load.
 *
 * The tab is a data attribute rather than the old `data-side` because the tab is now the unit the
 * sort, the columns and the model all key on - one vocabulary, end to end.
 */
function TabTable({
  tab,
  data,
  sort,
  onSort,
  ranks
}: {
  tab: BestSpellTab
  data: BestSpellsTable
  sort: BestSpellSort
  onSort: (s: BestSpellSort) => void
  ranks: ObservedSpellRanksSnap | null
}): JSX.Element {
  const columns = tabColumns(tab)
  const top = data.shown.slice(0, TOP_N)
  const rest = data.shown.slice(TOP_N)
  return (
    <Box
      data-testid="best-spells-section"
      data-tab={tab}
      data-count={String(data.shown.length)}
      data-sort={sort.column}
      data-desc={String(sort.desc)}
    >
      {data.shown.length === 0 && data.outOfEra.length === 0 ? (
        <Typography variant="caption" color="text.disabled" display="block" data-testid="best-spells-empty">
          nothing this loadout owns yet
        </Typography>
      ) : (
        <Table size="small" sx={{ tableLayout: 'fixed' }}>
          <TableHead>
            <TableRow>
              {columns.map((c) => (
                <HeadCell key={c} column={c} width={widthOf(tab, c)} sort={sort} onSort={onSort} />
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {top.map((r) => (
              <SpellRow key={r.name} row={r} columns={columns} ranks={ranks} />
            ))}
            <RowDisclosure
              label={`+${String(rest.length)} more`}
              testid="best-spells-more"
              rows={rest}
              columns={columns}
              ranks={ranks}
            />
            <RowDisclosure
              label={outOfEraLabel(data.outOfEra.length)}
              testid="best-spells-era-toggle"
              rows={data.outOfEra}
              columns={columns}
              ranks={ranks}
            />
          </TableBody>
        </Table>
      )}
    </Box>
  )
}

/**
 * ONE QUIET WORD BESIDE `directional`, with the long sentence behind it (the caveat diet).
 *
 * Two markers wear this shape now - the AOE tab's target assumption (JOS-449) and the worn-focus
 * percentage (JOS-452) - and a third would too. Null text draws nothing at all, which is how a
 * marker stays off a tab it has nothing to say about.
 */
function QuietMarker({
  testid,
  title,
  text
}: {
  testid: string
  title: string
  text: string | null
}): JSX.Element | null {
  if (text === null) return null
  return (
    <Tooltip title={title}>
      <Typography
        variant="caption"
        color="text.disabled"
        data-testid={testid}
        sx={{ textDecoration: 'underline dotted', cursor: 'help' }}
      >
        {text}
      </Typography>
    </Tooltip>
  )
}

/**
 * THE HEADER LINE: what the readout is, which level it is reading, and the markers it wears.
 *
 * Its own component only for the line budget (AGENTS.md's ceiling is split, never ratcheted) — the
 * panel below grew a search box and a second body with JOS-450. Nothing here is re-decided.
 */
function ReadoutHeader({
  best,
  tab,
  level,
  onLevel
}: {
  best: BestSpells
  tab: BestSpellTab
  level: number
  onLevel: (next: number | null) => void
}): JSX.Element {
  return (
    <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 0.5 }}>
      <Typography variant="subtitle2">Best at</Typography>
      {/* THE SAME ARROWS THE UNLOCK PANEL HAS (owner ask 2026-08-23) — a second handle on the ONE
          lifted level, so stepping here re-ranks this table and moves the panel next door in the
          same click. The stepper's own value line replaces the level the title used to state. */}
      <LevelStepper level={level} onChange={onLevel} testidPrefix="best-spells-level" />
      {/* THE SAME ONE QUIET WORD the panel below says, for the same reason: these are base
          figures with no crits, AA or resist in them (recast IS in them since JOS-444, and worn
          FOCUS since JOS-452, which draws its own marker beside this one when it applied).
          Said once per surface, never on a row (AGENTS.md, the caveat diet). */}
      <Typography variant="caption" color="text.disabled" data-testid="best-spells-directional">
        directional
      </Typography>
      {/* THE AOE TAB'S ASSUMPTION, MADE VISIBLE (JOS-449, owner ruling: the figures assume max
          target count and the surface must say so). It is drawn only on the tab it governs, so
          the other four keep the one-caveat diet the line above holds them to, and the words are
          the model's (`aoeAssumptionLabel`) so a mixed table cannot be captioned with a number it
          did not use. */}
      {tab === 'aoe' && (
        <QuietMarker testid="best-spells-aoe-assumption" title={AOE_ASSUMPTION_TITLE} text={best.aoeTargets} />
      )}
      {/* THE WORN FOCUS, MADE VISIBLE (JOS-452, owner ask: the multiply must be visible). Drawn
          only when the tab in front of you really used one, and in the MODEL's own words
          (`wornFocusLabel`) so a table where two rows were focused by different amounts is
          captioned with the range it used rather than one row's number. */}
      <QuietMarker
        testid="best-spells-worn-focus"
        title={WORN_FOCUS_TITLE}
        text={best.tabs[tab].wornFocus}
      />
      <Box sx={{ flexGrow: 1 }} />
      {best.ambiguous && (
        <Tooltip title="Covers every class your loadout could still be.">
          <Chip
            size="small"
            label="~ambiguous"
            data-testid="best-spells-ambiguous"
            variant="outlined"
            sx={{ height: 18, fontSize: 10 }}
          />
        </Tooltip>
      )}
    </Stack>
  )
}

/**
 * THE FIVE TABS. `fullWidth` rather than `scrollable`: labels this short divide 260px without a
 * scroller, and a scroller would put an answer behind a gesture nobody expects in a panel this
 * small. The label carries its count so an empty tab says so before it is opened.
 *
 * JOS-449 made it FIVE, so the horizontal padding comes off (`px: 0.25`) and the font drops a
 * notch: at the 260px floor five labels of the shape `DoT (6)` need every pixel, and the `no inner
 * scroller` check in the leveling e2e is what holds the trade honest.
 *
 * THE COUNTS STAY THE RANKED TABLES' (JOS-450), even while a search is live. They are a claim about
 * what this loadout owns, which does not change because somebody typed a question — and a tab is
 * still what a result is READ as, so the labels have to keep saying what each tab is about.
 */
function TabBar({
  best,
  tab,
  onPick
}: {
  best: BestSpells
  tab: BestSpellTab
  onPick: (next: BestSpellTab) => void
}): JSX.Element {
  return (
    <Tabs
      value={tab}
      onChange={(_e, next: BestSpellTab) => onPick(next)}
      variant="fullWidth"
      data-testid="best-spells-tabs"
      sx={{ minHeight: 28, mb: 0.5, '& .MuiTabs-indicator': { height: 2 } }}
    >
      {TAB_ORDER.map((t) => (
        <Tab
          key={t}
          value={t}
          data-testid="best-spells-tab"
          data-tab={t}
          data-count={String(best.tabs[t].shown.length)}
          label={`${TAB_LABEL[t]} (${String(best.tabs[t].shown.length)})`}
          sx={{ minHeight: 28, minWidth: 0, px: 0.25, py: 0.25, fontSize: 10, textTransform: 'none' }}
        />
      ))}
    </Tabs>
  )
}

export interface BestSpellsPanelProps {
  /**
   * The tab's viewed level, WHOLE — the same lifted state the unlock panel steps (viewedLevel.ts).
   * The owner asked for the arrows on this table too (2026-08-23), so the panel needs the setter
   * and not just the number; both steppers are handles on the one state and can never disagree.
   */
  viewed: ViewedLevel
}

/**
 * WILL THERE BE A READOUT? Asked one layer up, by the column that HOLDS it.
 *
 * The `chartedOf` arrangement in LevelingView, for the same reason: two placements read one gate.
 * The right column exists when this panel or the ledger below it is drawable, and a column band
 * with nothing in it is a layout the tab's own e2e measures (`columnsInfo` counts the bands). The
 * test is `comboClassSet(...).length > 0` and it is the SAME test the panel applies to itself —
 * `bestSpellsAt` returns exactly that set as `classes`.
 */
export function useBestSpellsVisible(): boolean {
  const combo = useCurrentComboClasses()
  return comboClassSet(combo).length > 0
}

/**
 * THE PANEL. Null when the loadout is unknown, and that is the one gate: every row here is a claim
 * about spells YOU own, and there is no honest version of it over sixteen candidate classes. The
 * panel below already teaches the two ways to fix that (a `/who`, or a Profile correction), so
 * repeating the sentence in the column beside it would be the same instruction twice.
 */
export function BestSpellsPanel({ viewed }: BestSpellsPanelProps): JSX.Element | null {
  const { level } = viewed
  const data = useLevelUnlocks()
  const combo = useCurrentComboClasses()
  // JOS-446's observed ranks, one subscription for the whole panel (the NewAtLevelPanel arrangement).
  const ranks = useObservedSpellRanks()
  // JOS-452's worn focus, one subscription for the whole panel (the `ranks` arrangement). An empty
  // list is the ordinary answer for a character with no dump, and it changes no figure.
  const focus = useWornFocus()
  const [sorts, setSorts] = useState(defaultSorts)
  const [picked, setPicked] = useState<BestSpellTab | null>(null)
  // THE SIMULATE SLIDER'S STATE, session-only and owned here (JOS-447 — SpellRankSlider's header
  // says why it is not persisted). 0 is base, which is where every mount opens.
  const [simulate, setSimulate] = useState(0)
  // THE SEARCH (JOS-450). An empty box is the ranked readout, byte for byte — this state is the only
  // thing that switches the body, and nothing about the tables reads it.
  const [query, setQuery] = useState('')
  const searching = query.trim() !== ''
  // Re-ranked by the LEVEL, the SORT and the RANKS, and by nothing else — the whole readout is one
  // pure call over an already-cached dataset, so stepping the level or the slider costs one fold of
  // ~1,450 rows. All four tables are built every time on purpose: the tab labels carry counts, so
  // the tabs you are not looking at are part of what the panel says.
  const best = useMemo(
    () => bestSpellsAt(data, combo, level, { sorts, observed: ranks, simulate, focus }),
    [data, combo, level, sorts, ranks, simulate, focus]
  )
  // UNTIL SOMEBODY PICKS, THE PANEL PICKS THE FIRST TAB THAT HAS ANYTHING IN IT. `dd` is the owner's
  // first-named tab and the right default for the caster this readout was written for, but a cleric
  // has no DD table at all and opening him on an empty one would be the panel failing to answer a
  // question it can answer. Derived at render rather than in an effect, so it follows the level.
  const tab = picked ?? TAB_ORDER.find((t) => best.tabs[t].shown.length > 0) ?? 'dd'
  // THE WHOLE-CATALOG FOLD (JOS-450), over the SAME already-cached ~1,450 rows and asking main
  // nothing per keystroke. Memoized on the panel state it reads rather than debounced: there is no
  // IPC on this path. An empty box computes nothing at all - the ranked readout must cost exactly
  // what it cost before the box existed.
  const results = useMemo(
    () =>
      searching
        ? searchBestSpells(data, tokenizeSpellQuery(query), {
            classes: best.classes,
            level,
            tab,
            sort: sorts[tab],
            observed: ranks,
            simulate,
            // JOS-452 — the results wear the same gear the ranked table does, because the marker
            // over them is drawn once in the header above BOTH bodies.
            focus
          })
        : EMPTY_BEST_SPELL_SEARCH,
    [searching, data, query, best.classes, level, tab, sorts, ranks, simulate, focus]
  )
  // The loadout set the result chips are filled against: a class you could be running, at a glance.
  const loadout = useMemo(() => new Set<string>(best.classes), [best.classes])
  if (best.classes.length === 0) return null
  return (
    <Paper
      variant="outlined"
      sx={{ p: 1.5 }}
      data-testid="best-spells"
      data-level={String(level)}
      data-simulate={String(simulate)}
      data-searching={String(searching)}
    >
      <ReadoutHeader best={best} tab={tab} level={level} onLevel={(n) => viewed.pick(n)} />
      <TabBar best={best} tab={tab} onPick={setPicked} />
      {/* THE BOX SITS UNDER THE TABS AND OVER THE SLIDER (JOS-450). Under the tabs because the tab
          is what a result is read AS - the reader picks the question first and then types the
          spell; over the slider because the slider governs both bodies equally and reads as part of
          the table either way. */}
      <BestSpellsSearchField query={query} onChange={setQuery} />
      <SpellRankSlider rank={simulate} onChange={setSimulate} />
      {/* KEYED BY THE TAB so the two disclosures inside reset when the table changes: `+7 more` left
          open on the DD table is not a statement about the DoT table underneath it. */}
      {searching ? (
        <BestSpellsResults
          results={results}
          tab={tab}
          columns={tabColumns(tab)}
          sort={sorts[tab]}
          onSort={(next) => setSorts((prev) => ({ ...prev, [tab]: next }))}
          ranks={ranks}
          loadout={loadout}
        />
      ) : (
        <TabTable
          key={tab}
          tab={tab}
          data={best.tabs[tab]}
          sort={sorts[tab]}
          onSort={(next) => setSorts((prev) => ({ ...prev, [tab]: next }))}
          ranks={ranks}
        />
      )}
    </Paper>
  )
}
