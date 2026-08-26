// ============================================================================
// EngineLootLedger — THE FIRST PRODUCT SURFACE ON `useView` (JOS-484, phase 3).
// ============================================================================
//
// The loot ledger, drawn from the Rust engine's `loot.ledger` view instead of from this process's
// fold. It is the cutover ledger's item 5 made concrete: `useModule` → `useView`, one surface, behind
// the data-source toggle `LootView` puts above it.
//
// ── WHAT IS AND IS NOT HAPPENING HERE ─────────────────────────────────────────────────────────
//
// The whole component is one subscription and one table. There is no filter, no sort, no grouping
// and no reduction anywhere in this file, and that absence is the point rather than a simplification
// — owner ruling 4: "views arrive filtered, sorted, windowed, render-ready". The rows arrive in the
// order the engine cut them and are drawn in that order; the cells arrive as the prose they are
// drawn as. The one `slice` in the table below is the VIEWPORT window (which rows are mounted), the
// same one the app-fed ledger has always done, and it selects rather than derives.
//
// ── THE DESCRIPTOR, AND WHY ITS WINDOW IS FIXED ───────────────────────────────────────────────
//
// `{source: 'loot.ledger', sort: [['at','desc']], window: {offset: 0, limit: 50}}` — the descriptor
// the plan names. THE LEDGER DOES NOT PAGE, and this is the honest statement of that rather than a
// gap: `LootLedgerBody` is VIRTUALIZED, not paginated — `useWindowedRows` mounts the rows that
// intersect the viewport of a container whose scroll height is the whole list, and there is no page
// control, no offset state and no next button anywhere on this tab. So there is no paging to wire a
// protocol window to. What this surface serves is the newest 50, said out loud in its caption
// (`… of N`, from the view's own `total`), which is a smaller ledger than the app's and visibly so.
//
// The upgrade, when a surface wants it, is to move `offset` into state and re-subscribe per page —
// acceptable for v1 by the ticket, and cheap here because `useView` already treats a changed
// descriptor as a new query. It is not built speculatively (the plan's own rule about the resume
// protocol, applied one level up).
//
// ── THE STATES, IN THE COMPONENT'S OWN IDIOM ──────────────────────────────────────────────────
//
// `useView` hands back `loading`, `error` and `rows: null`, and this file draws each with the same
// `Alert severity=…` vocabulary `LootNotices` uses for the app-fed ledger's states-not-errors — a
// second visual language for the same three conditions would make the two modes look different for
// reasons that are not about the data. RECONNECTING is not a fourth state and does not need to be:
// an epoch bump or a dropped connection puts this view back into `loading` by the client's own epoch
// law, and a connection that dies outright takes the whole toggle away (the provider drops the
// client from the context), so this component simply unmounts.

import { type JSX, useMemo, useRef } from 'react'
import { Alert, Box, Stack, Typography } from '@mui/material'
import type { ItemKnowledge } from '@shared/types'
import type { Row, ViewDescriptor } from '@shared/dataServer/protocol.generated'
import type { EngineClient } from '@shared/dataServer/client'
import { useViewFrom } from '../../lib/useView'
import { useWindowedRows } from '../../lib/useWindowedRows'
import { itemCountKey } from '../../lib/itemName'
import { EngineLootTable } from './LootTables'
import { LootSourceToggle, type LootSource } from './LootChrome'
import { ROW_HEIGHT } from './lootRows'

/** How many rows the served window holds. See the header for why it is a constant and not state. */
const WINDOW_LIMIT = 50

/**
 * The query, as one value.
 *
 * MODULE SCOPE, not a `useMemo`: it names no props, so a fresh object per render would be pure
 * churn — and `useView` keys its subscription on a serialization of the descriptor precisely so an
 * inline object cannot cause a resubscribe loop. Writing it here makes that impossible instead of
 * merely handled.
 */
const LEDGER: ViewDescriptor = {
  source: 'loot.ledger',
  // ── BOTH TERMS, AND THE SECOND ONE IS LOAD-BEARING ─────────────────────────────────────────
  //
  // The plan's own worked example spells this sort `[["at","desc"]]`, and MEASURED on this ticket
  // that descriptor draws a DIFFERENT LEDGER from the app's. EQ stamps to the second, so a corpse
  // yielding three items writes three rows at one instant; the flat table shows them in the reverse
  // of the order they were folded (`filterLootEvents` ends in `.reverse()`), which is `seq` DESC.
  // A sort naming only `at` does not stop there — every sort ends in the source's TIEBREAK, and
  // `loot.ledger`'s tiebreak is `seq` ASC — so the one-term form orders each second's rows
  // backwards. It is a total order and it is not this list's order.
  //
  // The engine's own default sort for this source is `at` desc then `seq` desc, i.e. exactly this;
  // omitting `sort` entirely would also be correct. It is spelled out because a descriptor is the
  // one place a reader can see what a list is ordered by, and because "the default happens to be
  // right" is not a thing the next person can check without opening a Rust file.
  sort: [
    ['at', 'desc'],
    ['seq', 'desc']
  ],
  window: { offset: 0, limit: WINDOW_LIMIT }
}

export interface EngineLootLedgerProps {
  client: EngineClient
  /** The app's own item-knowledge join, by counting key — see `EngineFlatRow`'s header for why the
   *  badges are still drawn here and when they stop being the renderer's business. */
  knowledgeByKey: Map<string, ItemKnowledge>
  onSelect: (item: string) => void
  source: LootSource
  setSource: (v: LootSource) => void
}

/** The knowledge join's key for one served row. The NAME is the engine's; normalizing it is app
 *  knowledge (`itemCountKey`, the `+N` counting rule), which is why it happens here and not in the
 *  table. It derives no domain value — it is a map key. */
function knowledgeKey(row: Row): string {
  const item = row.cells.item
  return itemCountKey(typeof item === 'string' ? item : '')
}

/** What the ledger is showing, in the caption's own voice. `total` is the view's, not a count of
 *  what arrived — the window is 50 and the ledger is usually longer. */
function EngineSummary({ shown, total }: { shown: number; total: number }): JSX.Element {
  return (
    <Typography variant="body2" color="text.secondary" data-testid="loot-summary">
      {shown.toLocaleString()} loot events served of {total.toLocaleString()} · newest first, from
      the engine&apos;s <code>loot.ledger</code> view · rows are rendered exactly as served
    </Typography>
  )
}

export function EngineLootLedger({
  client,
  knowledgeByKey,
  onSelect,
  source,
  setSource
}: EngineLootLedgerProps): JSX.Element {
  const view = useViewFrom(client, LEDGER)
  const scrollRef = useRef<HTMLDivElement>(null)
  // `rows: null` is "no window state held" (before the first reset, and after an epoch bump dropped
  // one). It is NOT an empty result — that is `rows: []` — so the two are kept apart here exactly as
  // the hook keeps them apart.
  const rows = useMemo<readonly Row[]>(() => view.rows ?? [], [view.rows])
  const win = useWindowedRows({ count: rows.length, rowHeight: ROW_HEIGHT, scrollRef })

  return (
    // The same testid the app-fed ledger carries: this is one list with two sources, and the
    // navigation every spec and every deep link already does must land on it either way.
    <Stack spacing={2} data-testid="loot-list" sx={{ height: '100%', minHeight: 0 }}>
      <LootSourceToggle source={source} setSource={setSource} />
      {view.error !== null && (
        <Alert severity="error" data-testid="loot-engine-error">
          The engine refused this view: {view.error.code} - {view.error.message}
        </Alert>
      )}
      {view.loading && view.error === null && (
        <Alert severity="info" data-testid="loot-engine-loading">
          Waiting for the engine&apos;s ledger. A fresh world (a character switch, an engine restart)
          takes a full fold before the first rows land.
        </Alert>
      )}
      {!view.loading && view.error === null && <EngineSummary shown={rows.length} total={view.total} />}
      {/* The app-fed body's container, prop for prop (`LootLedgerBody`) — same overflow, same
          `minHeight: 0`, same contained overscroll — so the two modes scroll identically and a
          comparison of what is on screen is a comparison of the ledgers. */}
      <Box
        ref={scrollRef}
        data-testid="loot-scroll"
        sx={{ flexGrow: 1, minHeight: 0, overflow: 'auto', overscrollBehavior: 'contain' }}
      >
        <EngineLootTable
          rows={rows}
          win={win}
          knowledgeByKey={knowledgeByKey}
          keyOf={knowledgeKey}
          onSelect={onSelect}
        />
      </Box>
    </Stack>
  )
}
