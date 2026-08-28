// THE READOUT'S STATE AND ITS THREE FOLDS — everything `BestSpellsPanel` knows, and nothing about
// how it looks (JOS-511).
//
// Its own file for the reason `BestSpellsRows.tsx` is one: the panel reached the measured
// `max-lines` ceiling and the rule here is to SPLIT rather than ratchet (AGENTS.md). This is the
// natural seam — six pieces of session state, three folds over them, and the handlers those folds
// are read through; the panel next door is left as composition. Nothing is re-decided here, and
// every comment travelled with the line it was written for.
//
// THE MEMOS ARE THE POINT OF KEEPING THEM TOGETHER (JOS-511 item 2). `columns` is a prop on every
// row of whichever table is drawn and `onSort` reaches every header cell, so their identities are
// what decide whether ~30 memoized rows re-render on a keystroke. That is a property of this whole
// block at once, and it is easier to review on one screen than scattered through the JSX.

import { useCallback, useMemo, useState } from 'react'
import {
  TAB_ORDER,
  bestSpellsAt,
  defaultSorts,
  tabColumns,
  type BestSpellColumn,
  type BestSpellSort,
  type BestSpells,
  type BestSpellTab
} from '@shared/bestSpells'
import { searchBestSpells, EMPTY_BEST_SPELL_SEARCH } from '@shared/bestSpellsSearch'
import { tokenizeSpellQuery } from '@shared/spellSearch'
import type { ObservedSpellRanksSnap } from '@shared/spellRanks'
import { useWornFocus } from '../../lib/useWornFocus'
import { useObservedSpellRanks } from '../../lib/useObservedSpellRanks'
import { useCurrentComboClasses, useLevelUnlocks } from './useLevelUnlocks'
import { ALL_TYPES } from './BestSpellsCatalogue'
import { useSpellCatalogue } from './useSpellCatalogue'
import type { ViewedLevel } from './viewedLevel'

/** How many rows are drawn before the disclosure. The owner's suggestion, and it fits the column. */
export const TOP_N = 10

export interface Readout {
  level: number
  best: BestSpells
  tab: BestSpellTab
  setPicked: (t: BestSpellTab) => void
  results: ReturnType<typeof searchBestSpells>
  loadout: ReadonlySet<string>
  columns: readonly BestSpellColumn[]
  sort: BestSpellSort
  ranks: ObservedSpellRanksSnap | null
  simulate: number
  setSimulate: (n: number) => void
  query: string
  setQuery: (q: string) => void
  searching: boolean
  category: string
  setCategory: (c: string) => void
  filtering: boolean
  scoped: boolean
  setScoped: (b: boolean) => void
  catalogue: ReturnType<typeof useSpellCatalogue>
  onSort: (s: BestSpellSort) => void
  onLevel: (n: number | null) => void
  onOpenTypes: () => void
}

export function useReadout(viewed: ViewedLevel): Readout {
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
  // THE TYPE FILTER (JOS-507). `ALL_TYPES` is the default and the disengaged state: while it holds,
  // nothing below asks the engine anything and the two bodies above are byte for byte what they were
  // before this control existed — which is also what keeps the readout's existing e2e family, whose
  // steps derive their target spell at runtime, looking at the same rows.
  const [category, setCategory] = useState<string>(ALL_TYPES)
  // Scoped to the loadout by default, with the show-all toggle the catalogue body draws.
  const [scoped, setScoped] = useState(true)
  // …AND THE CONTROL ASKS ONCE IT IS OPENED. The facets that populate it are the engine's, so the
  // first open is what fetches them; until then a panel nobody has touched issues no request at all.
  const [touched, setTouched] = useState(false)
  const filtering = category !== ALL_TYPES
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
  // THE COLUMNS, ONCE PER TAB (JOS-511 item 2). `tabColumns` builds a fresh array, and it was
  // called twice per render — once for the results body and once inside `TabTable` — so every row
  // of whichever table was drawn took a changed `columns` prop on every keystroke, every level step
  // and every module push. One memo, one array, both bodies.
  const columns = useMemo(() => tabColumns(tab), [tab])
  // THE THREE HANDLERS THE ROWS AND THE HEADERS TAKE, STABLE. Each was an inline arrow, so each was
  // a fresh function on every render of the panel — and `onSort` reaches every header cell of the
  // table while `onLevel` reaches the stepper in the header line.
  const onSort = useCallback(
    (next: BestSpellSort) => {
      setSorts((prev) => ({ ...prev, [tab]: next }))
    },
    [tab]
  )
  const onLevel = useCallback(
    (n: number | null) => {
      viewed.pick(n)
    },
    [viewed]
  )
  const onOpenTypes = useCallback(() => {
    setTouched(true)
  }, [])
  // THE CLIENT TABLE'S OWN ANSWER (JOS-507). Asked only once the control has been opened or a type
  // is picked, and the engine does the whole filter/sort/window — nothing here re-derives a row.
  // The text box feeds it too, so `tap` means the same thing to both bodies: the engine matches a
  // name, a category OR a subcategory, which is why `Leech` is a tap.
  const catalogue = useSpellCatalogue(
    {
      text: query.trim(),
      category: filtering ? category : null,
      subcategory: null,
      // EMPTY IS EVERY CLASS on the wire — the show-all toggle, and the reading the schema states.
      classes: scoped ? best.classes : [],
      // Enough to fill the column without a second page; the engine clamps and echoes what it used.
      limit: TOP_N * 5
    },
    touched || filtering
  )
  return {
    level, best, tab, setPicked, results, loadout, columns, sort: sorts[tab], ranks,
    simulate, setSimulate, query, setQuery, searching, category, setCategory, filtering,
    scoped, setScoped, catalogue, onSort, onLevel, onOpenTypes
  }
}
