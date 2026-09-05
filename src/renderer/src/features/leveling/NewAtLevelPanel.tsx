// "New at this level" — what a level gave (or will give) THIS loadout
// (docs/plans/levelup-whats-new.md §0, §2). The panel the level-up toast links to.
//
// IT IS BROWSABLE, NOT JUST HISTORICAL. The stepper defaults to the character's current level —
// the question you have the instant you ding — but stepping it answers "what do I get at 30?"
// without waiting for 30. Same data, same join, no second code path.
//
// THE COMBO IS JOINED AT READ (law 10) and never guessed at (law 1). Chips are FILLED for the
// classes the module has actually resolved and OUTLINED for candidates of a slot it has only
// narrowed; when any slot is unresolved the header says `~ambiguous` and the lists are honestly
// an upper bound — the classes you might be running, not the ones you are.
//
// A LOADOUT WITH NO SPELLS IS NOT AN ERROR. BER, MNK and WAR have zero Template:Spellpage spells
// (measured, wave O1): their spells list is empty at every level and says so in words, while the
// skills list carries everything they actually gain.
//
// AND THE WAY OUT IS ON SCREEN WHETHER OR NOT THE LOADOUT IS KNOWN (JOS-192, trigger report
// 01KZP6SDZJK6BPEWA4Z0MF5ANG). This panel pointed at the fix ONLY in its loadout-UNKNOWN state —
// so a reporter looking at three classes they had stopped playing was shown the wrong answer
// confidently and offered nothing. It now wears the same PROVENANCE chip the Profiles panel and
// the character header use, and that chip's `inferred` tooltip names the two moves that correct
// it. `inferred` is a claim about evidence, and a surface that never says so is asking to be
// believed.
//
// THE POINTER IS A TOOLTIP AND NOT A LINE, and it stays one for the reason it was CHOSEN rather
// than the reason it was forced. The forcing is gone: this panel used to be the last child of a
// `height: 100%` stack whose middle child was the scroller, so every pixel it took came out of the
// charts — one caption line here once pushed the timeslice control under the panel above it at the
// app's minimum width, and leveling.e2e.mts hit-tests exactly that. Since JOS-289 the page scrolls
// and the height budget is not zero. The tooltip stays anyway: this is a chip's provenance, which
// is what the tooltip diet is FOR.
//
// AND WHAT THIS SERVER HAS NOT OPENED IS NOT NEW AT THIS LEVEL (JOS-393). The spell list folds the
// rows eqlwiki badges out of era behind a `+N out of era` disclosure — the drops precedent, the same
// phrase — so a level-50 shaman is no longer told `Sloths Healing` (`{{Kunark Era}}`) is his. The
// SEARCH below is untouched by the fold and marks those rows instead: a search is a question the
// player asked, and the honest answer to it includes the spell and says what it is.
//
// AND THE LISTS BELOW ARE AS TALL AS THEY NEED TO BE (JOS-289). `UnlockList` was a 120px windowed
// porthole — the surface the owner named as cramped — and is now plain rows at their honest
// height, with the full `SpellTooltip` card behind every spell name.
//
// A TOAST'S DEEP LINK NOW LANDS ON THIS PANEL RATHER THAN NEAR IT (JOS-330). The two consequences
// of the layout above met here: the page is one tall scroller and this panel is the BOTTOM of the
// left column, so a link that mounted the tab and set the level left the reader at the top of a
// screen of charts with the answer a screen and a half below the fold. `useFocusLanding` (its own
// file, and its header carries the reasoning) scrolls this Paper fully into the app's one scroller
// and pulses its edge for two seconds on arrival — on EVERY link, including a repeat of the same
// level, and on no plain tab switch at all.

import { type JSX, useMemo, useState } from 'react'
import { Box, Paper, Stack, Typography, Chip } from '@mui/material'
import { comboClassSet, unlocksAtLevel } from '@shared/levelUnlocks'
import { tokenizeSpellQuery } from '@shared/spellSearch'
import { EMPTY_UNLOCK_SEARCH, searchUnlockSpells } from '@shared/unlockSearch'
import { Tooltip } from '../../lib/Tooltip'
import { useObservedSpellRanks } from '../../lib/useObservedSpellRanks'
import { ProvenanceChip } from '../profiles/ClassComboChips'
import { useComboSnap } from '../profiles/ClassComboData'
import { UnlockList } from './UnlockList'
import { UnlockSearchField, UnlockSearchResultsList } from './NewAtLevelSearch'
import { LANDING_PULSE_SX, useFocusLanding } from './useFocusLanding'
import { useCurrentComboClasses, useLevelUnlocks } from './useLevelUnlocks'
import { useSpellSets } from './useSpellSets'
// THE LEVEL IS THE TAB'S SINCE JOS-445, not this panel's: the best-spells readout in the other
// column reads the same number. The STEPPER became shared too (owner ask 2026-08-23) — one
// component, two placements, both handles on the same lifted state (`LevelStepper.tsx`).
import { clampLevel, type ViewedLevel } from './viewedLevel'
import { LevelStepper } from './LevelStepper'

/** The loadout the lists were computed over, as chips — the panel's whole provenance line. */
function ComboChips({
  classes,
  resolved,
  ambiguous
}: {
  classes: string[]
  resolved: ReadonlySet<string>
  ambiguous: boolean
}): JSX.Element {
  return (
    <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap>
      {classes.map((c) => (
        <Chip
          key={c}
          size="small"
          label={c}
          data-testid="new-at-level-combo-chip"
          color="secondary"
          variant={resolved.has(c) ? 'filled' : 'outlined'}
          sx={{ height: 18, fontSize: 10 }}
        />
      ))}
      {ambiguous && (
        <Tooltip title="Covers every class your loadout could still be.">
          <Chip
            size="small"
            label="~ambiguous"
            data-testid="new-at-level-ambiguous"
            variant="outlined"
            sx={{ height: 18, fontSize: 10 }}
          />
        </Tooltip>
      )}
    </Stack>
  )
}

export interface NewAtLevelPanelProps {
  /** the character's CURRENT level (latest reported, never max) — the stepper's default */
  currentLevel: number | null
  /**
   * THE TAB'S viewed level (JOS-445) — the number, what the reader picked, and the setter, as one
   * object because the three only mean anything together. The stepper below writes it and the
   * best-spells readout in the other column reads it.
   */
  viewed: ViewedLevel
  /** a level-up toast's deep link asked for this level, or null */
  focusLevel: number | null
  /** bumps per link, so asking for the same level twice arrives twice (the nonce contract) */
  focusNonce: number
  onFocusConsumed: () => void
}

export function NewAtLevelPanel({
  currentLevel,
  viewed,
  focusLevel,
  focusNonce,
  onFocusConsumed
}: NewAtLevelPanelProps): JSX.Element {
  const { level, picked, pick: onPick } = viewed
  const data = useLevelUnlocks()
  const combo = useCurrentComboClasses()
  // The live spell bar (JOS-391) — read here rather than inside the row so one subscription
  // serves both lists, and so a list with no spell rows costs nothing.
  const sets = useSpellSets()
  // Which rank of each line you have been observed to hold (JOS-446), subscribed here for the
  // same reason `sets` is: one subscription for every list this panel draws.
  const ranks = useObservedSpellRanks()
  // The same OPEN interval `useCurrentComboClasses` reduces to strings — kept whole here for the
  // one thing the strings drop: where the loadout came from.
  const current = useComboSnap().current
  // THE SEARCH (JOS-392). An empty box is the level view, byte for byte — the state below is the
  // only thing that switches the body, and nothing about the level view reads it.
  const [query, setQuery] = useState('')
  const searching = query.trim() !== ''

  // THE DEEP LINK (appRouting `openLeveling`), and the whole arrival lives in `useFocusLanding`.
  // Keyed on the NONCE and consumed the moment it is applied, so returning to this tab later does
  // not re-jump to a level the user has stepped off — and so the same level asked for twice
  // arrives twice. The hook adds the two halves JOS-330 was about: it SCROLLS the panel into the
  // app's one scroller (this panel is the bottom of the left column since JOS-300, so a link that
  // only switched tabs left the reader looking at charts) and LIGHTS it briefly on arrival. Read
  // that file for why the scroll rides React's commits rather than `requestAnimationFrame`.
  const landing = useFocusLanding(focusLevel !== null, focusNonce, () => {
    if (focusLevel !== null) onPick(clampLevel(focusLevel))
    onFocusConsumed()
  })

  // THE LEVEL JOIN, MEMOIZED (JOS-511 item 2). It folds the unlock dataset for the loadout at this
  // level and it ran on every render of this panel — a keystroke in the search box below, a
  // progression push two components up, a pointer move on the charts. Its three inputs are the
  // dataset (a module-level cached pull), the combo (memoized by `useCurrentComboClasses`) and a
  // number, so the fold now runs exactly when one of those moves. Its IDENTITY matters as much as
  // its cost: `unlocks.spells` and `unlocks.skills` are the arrays the two lists take, and fresh
  // arrays are what would defeat the row memo below them.
  const unlocks = useMemo(() => unlocksAtLevel(data, combo, level), [data, combo, level])
  // Memoized for its IDENTITY as much as its cost: it is a dependency of the search below, and
  // `comboClassesOf` already hands back one object per combo snapshot.
  const classes = useMemo(() => comboClassSet(combo), [combo])
  // The resolved set, ONCE PER COMBO. A fresh `Set` per render is a changed prop on every row of
  // both lists and on every search result — the single loudest defeater of the row memo, because
  // it is the prop every one of them takes.
  const resolved = useMemo(() => new Set<string>(combo.resolved), [combo])
  const known = classes.length > 0

  // THE FILTER runs over the ~1,450 already-cached rows, so it is memoized on the query and the
  // loadout rather than deferred: there is no IPC on this path and nothing to debounce. An empty
  // box computes nothing at all — the level view must cost exactly what it cost before.
  const results = useMemo(
    () =>
      searching
        ? searchUnlockSpells(data.spells, tokenizeSpellQuery(query), { classes, currentLevel })
        : EMPTY_UNLOCK_SEARCH,
    [searching, data.spells, query, classes, currentLevel]
  )

  return (
    // `position: relative` is the pulse's anchor and nothing else; `data-highlighted` states the
    // landing in the DOM so a spec can assert the CUE rather than a colour (tests/e2e/toast.e2e).
    // It is always present, "false" included, because "this panel is not lit" is also a claim.
    <Paper
      variant="outlined"
      ref={landing.ref}
      sx={{ p: 1.5, flex: '0 0 auto', position: 'relative' }}
      data-testid="new-at-level"
      data-highlighted={landing.seq === null ? 'false' : 'true'}
    >
      {/* THE ARRIVAL PULSE, keyed on the nonce so a repeat link restarts it (see useFocusLanding).
          A sibling of the content rather than a style on the Paper, and inert to the pointer. */}
      {landing.seq !== null && <Box key={landing.seq} aria-hidden sx={LANDING_PULSE_SX} />}
      <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 0.75 }}>
        <Typography variant="subtitle2">New at this level</Typography>
        <LevelStepper level={level} onChange={(n) => onPick(n)} dimmed={searching} testidPrefix="new-at-level" />
        {/* ONE QUIET WORD, ONCE (JOS-391, AGENTS.md's caveat diet). The row figures are base
            values with no crits, focus or AA in them; that is a property of the whole panel,
            said here in a word rather than footnoted on twelve rows. The per-second figures DO
            carry the re-use timer now (JOS-444) - they are sustained numbers, not cast-window
            ones - which is a change in the arithmetic and not in what this word covers. */}
        <Typography variant="caption" color="text.disabled" data-testid="new-at-level-directional">
          directional
        </Typography>
        {picked !== null && currentLevel !== null && picked !== currentLevel && (
          <Chip
            size="small"
            label={`back to ${String(currentLevel)}`}
            variant="outlined"
            onClick={() => onPick(null)}
            sx={{ height: 18, fontSize: 10 }}
          />
        )}
        <Box sx={{ flexGrow: 1 }} />
        <ComboChips classes={classes} resolved={resolved} ambiguous={combo.ambiguous} />
        {known && current && <ProvenanceChip interval={current} />}
      </Stack>

      <UnlockSearchField query={query} onChange={setQuery} />

      {/* THE SEARCH ANSWERS WHETHER OR NOT THE LOADOUT IS KNOWN. The level lists are a claim about
          YOUR trio and say so when there is no trio; a search is a question about the game, and a
          player who has not typed `/who` yet can still ask where Complete Heal sits. */}
      {searching ? (
        <UnlockSearchResultsList results={results} resolved={resolved} sets={sets} ranks={ranks} />
      ) : known ? (
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
          <UnlockList
            title="Spells"
            rows={unlocks.spells}
            outOfEra={unlocks.outOfEraSpells}
            resolved={resolved}
            sets={sets}
            ranks={ranks}
            empty={`no new spells at level ${String(level)} for this loadout`}
          />
          <UnlockList
            title="Skills, disciplines & innates"
            rows={unlocks.skills}
            resolved={resolved}
            sets={sets}
            ranks={ranks}
            empty={`no new skills at level ${String(level)} for this loadout`}
          />
        </Stack>
      ) : (
        <Typography variant="caption" color="text.secondary" data-testid="new-at-level-unknown">
          Your class loadout isn&apos;t known yet - a <code>/who</code> on yourself, or a correction on the
          Profile tab, and this fills in.
        </Typography>
      )}

    </Paper>
  )
}
