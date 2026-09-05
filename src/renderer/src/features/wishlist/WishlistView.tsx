// wishlist/WishlistView.tsx — THE FLAT WISH LIST (JOS-326; the shell it replaces was JOS-324's
// honest placeholder).
//
// WHAT THIS TAB IS. One list of things this character has decided they want, written by hand,
// grouped by where to go and get them. It is FLAT by owner ruling: a wish names an item and
// nothing else — no equipment cell, no socket, no host — and targeting a host item for an
// exaltation is an explicitly later addition. The plan board this ticket removed is what a wish
// list would have turned back into if that ruling were softened.
//
// FOUR CONTROLS AND A ROLLUP:
//   * ADD — one button over the WHOLE corpus, gear rows and donor rows in one result list, each
//     labelled with its kind (WishAdd + wishSearch.ts).
//   * SEARCH — a box over the WISHES themselves. A list you write yourself gets long, and the
//     rollup groups by zone, so "where is that helm on here" is a real question the groups cannot
//     answer.
//   * ERA — the shared `eq.planner.era` toggle, hiding out-of-era wishes from the ROUTE and saying
//     how many. It deliberately does not reach the add control (wishSearch.ts argues why).
//   * REMOVE — per row, and it is the only destructive control on the tab.
//
// THE ROLLUP IS THE OLD FARM DERIVATION, RE-AIMED. `wishFarm.collectWishNeeds` resolves each wish
// against both corpus indices and the progress join; `plannerFarm.groupNeeds` does the zone
// arithmetic unchanged, non-zone headings and all. Nothing about that fold was ever specific to
// exaltation sets.
//
// AND EVERY NAME IS A LINK. `onOpenLoot` is the app's standing idiom (appRouting): a click takes
// the Loot tab over with that item's drill-down, which since JOS-127/JOS-143 states what the
// committed DBs know about where it drops beside what this character has observed. Same contract
// the Exaltations tab's donor names use, so the drill's Back arrow comes home to the right tab.
//
// THE LIST IS ITS OWN SCROLLER (AGENTS.md UI conventions): a wish list grows, and a growing list
// lives in a bounded box rather than growing the page.

import { type JSX, useEffect, useMemo, useState } from 'react'
import { Box, Stack, TextField, Typography } from '@mui/material'
import FavoriteBorderIcon from '@mui/icons-material/FavoriteBorder'
import type { ExaltPlan } from '@shared/planner/types'
import { seedWishes, type WishEntry, type WishList } from '@shared/planner/wishlist'
import { useGearIndex } from '../gear/gearData'
import { useRememberedSearch } from '../gear/useAreaMemory'
import { useBrowseClasses } from '../planner/useBrowseClasses'
import { CURRENT_ERA_LABEL, eraHides, indexDonors, useDonors, useEraOnly } from '../planner/plannerData'
import { groupNeeds, type FarmNeed } from '../planner/plannerFarm'
import { usePlannerProgress } from '../planner/plannerProgress'
import WishAdd from './WishAdd'
import WishGroups, { DoneStrip, WishEraBar } from './WishGroups'
import { collectWishNeeds, indexGear, wishFulfilled, type WishIndices } from './wishFarm'
import { plannedWishes } from './wishSeed'
import { wishFromHit } from './wishSearch'
import { useWishlist } from './useWishlist'

/** The empty state. It names what the tab is FOR, not what it is missing. */
function NoWishes({ searching }: { searching: boolean }): JSX.Element {
  return (
    <Stack alignItems="center" justifyContent="center" spacing={1.5} sx={{ py: 6, color: 'text.secondary' }}>
      <FavoriteBorderIcon sx={{ fontSize: 44, opacity: 0.6 }} />
      <Typography variant="body2" data-testid="wishlist-empty" sx={{ maxWidth: 460, textAlign: 'center' }}>
        {searching
          ? 'No wish on your list matches that.'
          : 'Nothing on your wish list yet. Add an item or an exaltation effect and this becomes a route: where it drops, who camps it, and what is left to merge.'}
      </Typography>
    </Stack>
  )
}

/**
 * THE ONE-TIME SEED, as an effect (wishSeed.ts owns the reasoning and the purity).
 *
 * It waits for BOTH stores — the wish list must have loaded or the flag cannot be trusted, and the
 * plans must have loaded or the seed would import nothing and set the flag anyway. The plans are
 * read HERE and nowhere else in the app now; `usePlans` went with the board.
 */
interface SeedInputs {
  /** the wish list has loaded — until then `seeded` is a guess, not a fact */
  ready: boolean
  seeded: boolean
  index: WishIndices
  progressOf: ProgressOf
  seed: (entries: readonly WishEntry[]) => void
}

function useSeedFromPlans({ ready, seeded, index, progressOf, seed }: SeedInputs): void {
  const [plans, setPlans] = useState<ExaltPlan[] | null>(null)
  useEffect(() => {
    if (!ready || seeded) return
    let alive = true
    void window.eq
      .getExaltPlans()
      .then((loaded) => {
        if (alive) setPlans(loaded)
      })
      .catch(() => {
        /* main never rejects; an unreadable store means nothing to import, not a crash */
        if (alive) setPlans([])
      })
    return () => {
      alive = false
    }
  }, [ready, seeded])

  useEffect(() => {
    if (!ready || seeded || plans === null) return
    seed(seedWishes(plannedWishes(plans, { donors: index.donors, progressOf }), Date.now()))
  }, [ready, seeded, plans, index, progressOf, seed])
}

/** The progress join's one call, named so the seed hook and the fold can both take it. */
type ProgressOf = ReturnType<typeof usePlannerProgress>['of']

/** The three lists the pane draws, folded once per change of anything they read. */
interface WishView {
  /** the route — everything unfulfilled and in era, grouped by zone */
  groups: ReturnType<typeof groupNeeds>
  /** the done strip — fulfilled and not yet dismissed */
  done: FarmNeed[]
  /** how many the era toggle is holding back, and how many are still to find */
  hidden: number
  outstanding: number
}

interface FoldInputs {
  list: WishList
  index: WishIndices
  progressOf: ProgressOf
  eraOnly: boolean
  /** the search box over the WISHES — matched against what the row says, not the corpus's haystack */
  text: string
}

/**
 * WISHES → THE THREE LISTS, in one pure fold.
 *
 * DISMISSED ROWS LEAVE FIRST, before anything else is decided: a wish the user has told the done
 * strip to stop showing must not reappear in the route the moment the progress join changes its
 * mind (a dump that no longer lists a sold item would do exactly that).
 *
 * THEN FULFILLED VS WANTED (`wishFulfilled`, which reads the two kinds' different rules), and only
 * the WANTED half meets the era filter — a fulfilled Velious wish is not a route entry the filter
 * has any business hiding, it is a thing you already have.
 */
function foldWishes({ list, index, progressOf, eraOnly, text }: FoldInputs): WishView {
  const needle = text.trim().toLowerCase()
  const cleared = new Set(list.clearedDone)
  const byKey = new Map(list.entries.map((e) => [e.itemKey, e]))
  const needs = collectWishNeeds(list.entries, index, progressOf).filter((n) => {
    if (cleared.has(n.itemKey)) return false
    // The search runs over what the ROW says — the item's name and what it is wanted for — which
    // is the same haystack the eye is scanning. The corpus's own `searchKey` would be wrong here:
    // a wish the corpus no longer carries has none, and it would silently stop being findable.
    return needle === '' || `${n.name} ${n.effect ?? ''}`.toLowerCase().includes(needle)
  })
  const done: FarmNeed[] = []
  const wanted: FarmNeed[] = []
  for (const need of needs) {
    const entry = byKey.get(need.itemKey)
    if (entry !== undefined && wishFulfilled(entry, need.progress)) done.push(need)
    else wanted.push(need)
  }
  const kept = wanted.filter((n) => !eraHides(n.subject, eraOnly))
  return {
    groups: groupNeeds(kept, { eraOnly }),
    done,
    hidden: wanted.length - kept.length,
    outstanding: wanted.length
  }
}

export interface WishlistViewProps {
  /** deep-link a wish into the Loot tab's item drill-down (App's `openLoot`) */
  onOpenLoot?: (item: string) => void
}

export default function WishlistView({ onOpenLoot }: WishlistViewProps = {}): JSX.Element {
  const wishlist = useWishlist()
  const donorsState = useDonors()
  const gearState = useGearIndex()
  const progress = usePlannerProgress()
  // The SAME class filter the effect browser uses (`eq.planner.classes`) — a wish outside it is
  // chipped, never dropped, which is V2's rule about planned work and a wish is planned work.
  const classes = useBrowseClasses()
  // THE ERA TOGGLE ALREADY SURVIVED (JOS-329 checked rather than assumed): `useEraOnly` is the
  // shared `eq.planner.era` key and has been localStorage-backed since V4, so this tab's half of
  // the ticket was only ever the search box. It is on the SESSION tier — `gear/areaMemory.ts` has
  // the rule, and a wish-list search is the clearest case for it: the list is one you WROTE, so
  // "where is that helm on here" is a question you finish, not a lens you keep.
  const [eraOnly, setEraOnly] = useEraOnly()
  const [text, setText] = useRememberedSearch('eq.wishlist.search')

  const index: WishIndices = useMemo(
    () => ({ donors: indexDonors(donorsState.donors), gear: indexGear(gearState.rows) }),
    [donorsState.donors, gearState.rows]
  )

  useSeedFromPlans({
    ready: wishlist.ready,
    seeded: wishlist.list.seededFromPlans === true,
    index,
    progressOf: progress.of,
    seed: wishlist.seed
  })

  const list = wishlist.list
  const entries = list.entries
  const importedKeys = useMemo(
    // eslint-disable-next-line eqc/no-domain-munging -- JOS-459 cutover ledger item 8: WishEntry comes from a corpus still bundled in the renderer (mobs/posky/bosses JSON). Moves behind knowledge queries when that surface cuts over.
    () => new Set(entries.filter((e) => e.source === 'planImport').map((e) => e.itemKey)),
    [entries]
  )
  const view = useMemo(
    () => foldWishes({ list, index, progressOf: progress.of, eraOnly, text }),
    [list, index, progress, eraOnly, text]
  )
  const wished = useMemo(() => new Set(entries.map((e) => e.itemKey)), [entries])
  const nothing = view.groups.length === 0 && view.done.length === 0

  return (
    <Box
      data-testid="wishlist-view"
      sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
    >
      <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'nowrap', mb: 1.5 }}>
        <WishAdd
          gear={gearState.rows}
          donors={donorsState.donors}
          ready={gearState.ready && donorsState.ready}
          wished={wished}
          onPick={(hit) => wishlist.add(wishFromHit(hit, Date.now()))}
        />
        <TextField
          size="small"
          label="Search your wishes"
          value={text}
          data-testid="wishlist-search"
          onChange={(e) => setText(e.target.value)}
          sx={{ minWidth: 180, flexShrink: 1 }}
        />
        <Box sx={{ flexGrow: 1, minWidth: 8 }} />
        {/* The WHOLE list's length, dismissals and fulfilled rows included — the one number on the
            tab that a Clear must not change, because a dismissal is not a deletion. */}
        <Typography variant="caption" color="text.secondary" data-testid="wishlist-count" sx={{ flexShrink: 0 }}>
          {entries.length} {entries.length === 1 ? 'wish' : 'wishes'}
        </Typography>
      </Stack>

      <WishEraBar
        eraOnly={eraOnly}
        setEraOnly={setEraOnly}
        hidden={view.hidden}
        outstanding={view.outstanding}
      />

      <Box data-testid="wishlist-list" sx={{ flexGrow: 1, minHeight: 0, overflow: 'auto', pr: 0.5 }}>
        <DoneStrip
          rows={view.done}
          onClear={() => wishlist.dismiss(view.done.map((r) => r.itemKey))}
          onOpenLoot={onOpenLoot}
        />
        <WishGroups
          groups={view.groups}
          classes={classes.classes}
          importedKeys={importedKeys}
          onRemove={wishlist.remove}
          onOpenLoot={onOpenLoot}
        />
        {nothing && <NoWishes searching={text.trim() !== ''} />}
        {/* The era filter can empty a NON-empty list, and it must say so rather than letting the
            list read as "you want nothing" (the JOS-67 lesson, in its smallest form). */}
        {!nothing && view.groups.length === 0 && view.outstanding > 0 && (
          <Typography variant="body2" color="text.secondary" data-testid="wishlist-all-out-of-era" sx={{ p: 2 }}>
            Every wish still to find is out of {CURRENT_ERA_LABEL}.
          </Typography>
        )}
      </Box>
    </Box>
  )
}
