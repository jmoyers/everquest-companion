// gear/GearCompareCard.tsx — HOVER AN ITEM AND SEE TWO CARDS: the item, and what you wear instead
// (JOS-338, restructured and REPAIRED by JOS-344).
//
// THE ONE DOOR. Every compare card this app draws comes through `GearRowCompare` below — the gear
// table's rows and, since JOS-344, the Exaltations browser's donor names — and that wrapper always
// passes the safe mode: the `SkyItemCard` pattern (JOS-181), for the same reason. "These cards
// cannot eat a click, and cannot open where a human will not see them" has to be a property of ONE
// file rather than of whoever edits `GearTable` or `EffectRows` next. `tests/gearCompare.test.mts`
// derives both halves from the tree.
//
// ---------------------------------------------------------------------------
// THE JOS-344 BUG, MEASURED BEFORE IT WAS FIXED — READ THIS BEFORE TOUCHING THE MODIFIERS
// ---------------------------------------------------------------------------
//
// The owner's report was that hovering a gear row showed NOTHING. It was not "nothing": the card
// was in the DOM, fully rendered, with the right words in it — and drawn 3 pixels from the right
// edge of a 1268px window, 99% of it past the glass. The e2e that shipped it only ever asked
// whether the node existed and what it said, which is exactly how an off-screen card ships.
//
// THE MEASUREMENT (headless run, default window, the Thelvorn row):
//     viewport            1268 × 848
//     the anchored <tr>   left 237 → right 1251      (the row is the FULL WIDTH of the table)
//     the popper          translate(1251px, 255px), 356 wide → right edge 1607
//     the card itself     left 1265 → right 1520      ⇒ 3px of it inside the window
//
// THE MECHANISM, and it is one inverted pair of axis names. Popper's `preventOverflow` calls the
// axis it slides along the MAIN one, and `getMainAxisFromPlacement` returns `'x'` for `top`/
// `bottom` placements and `'y'` for everything else. So for the `right-start` card JOS-338 wrote:
//   * `mainAxis` is the VERTICAL axis, and it was left ENABLED — the opposite of guarantee 1,
//   * `altAxis` is the HORIZONTAL one, and it was DISABLED — which switched off the only thing
//     that could have pulled the card back on screen,
//   * `flip` was off, so it could not escape left either.
// The old header says the reverse of both in prose ("for a right-placed popper the ALT axis is the
// vertical one"); the prose was wrong, the code did what the prose said rather than what it meant,
// and the anchor — a full-width `<TableRow>` whose right edge IS the window's right edge — turned
// that into a card nobody could see. All three are stated as source-regex pins in
// tests/gearCompare.test.mts now, so the next edit that flips one turns a unit test red.
//
// ---------------------------------------------------------------------------
// THE ANCHORING LAW THAT REPLACES IT (JOS-344) — three guarantees, all structural
// ---------------------------------------------------------------------------
//
//   1. IT CANNOT OPEN UPWARD, AND IT IS ANCHORED TO AN EDGE THAT IS ALWAYS ON SCREEN.
//      `bottom-start` — which is JOS-181's own click-through placement, arrived at there for this
//      same shape of defect — puts the pair's TOP-LEFT corner at the anchor's BOTTOM-LEFT corner.
//      For a bottom-placed popper `mainAxis` is the HORIZONTAL axis and `altAxis` the vertical, so
//      `{ mainAxis: true, altAxis: false }` now reads the way the words sound: the pair is CLAMPED
//      sideways to stay inside the window, and may never be moved vertically at all. With `flip`
//      off as well, the pair's top edge is ALWAYS its anchor's bottom edge — always below the row,
//      therefore always below the toolbar above the list. That is the JOS-127/JOS-143 guarantee,
//      and it is now a fact about the geometry rather than a hope about the axis names.
//
//      THE BRIEF ASKED FOR THE NAME CELL OR THE POINTER AS THE ANCHOR; this is neither, and the
//      reason is worth writing down. What made the card invisible was the row's RIGHT edge, and
//      `bottom-start` does not read it — it reads the row's LEFT edge, which is the name cell's
//      left edge, one pixel for one pixel, with no DOM coupling between this file and the table's
//      cell structure and no virtual-anchor plumbing to keep in step with two host surfaces. The
//      donor rows get the identical treatment for free: their anchor is the NAME itself.
//
//      THE PRICE, unchanged from JOS-181 and stated honestly: a pair anchored on a row near the
//      window's BOTTOM is clipped by the bottom edge rather than flipping above its row. That is
//      the trade this app has already made twice, and it is why every list on these cards is
//      capped (`MAX_STATS`, `MAX_DELTAS`) — the pair is short enough that the clipping costs a
//      line or two, where a flip would cost the toolbar.
//
//   2. IT HOLDS NO POINTER EVENTS. `disableInteractive` already leaves MUI's popper at
//      `pointer-events: none`; it is written out as well, because a library default is somebody
//      else's decision and this one IS the defect. It is also what makes the JOS-143 regression
//      test meaningful: `document.elementFromPoint` skips a pointer-events-none node, so the
//      toolbar, the wish heart (JOS-335), the name's Loot link and — since JOS-344 — the donor
//      row's Add button all still answer for their own centres with the pair open.
//
//   3. IT CLOSES ON POINTERDOWN, ANYWHERE, IN THE CAPTURE PHASE — so the pair is gone before the
//      Select the user just aimed at opens its own option list over the same band.
//
// Plus the SpellCard leave discipline (JOS-293): `enterDelay` so dragging the pointer across thirty
// dense rows opens nothing, and a short `leaveDelay` so it goes with the pointer.
//
// ---------------------------------------------------------------------------
// WHY IT IS TWO CARDS AND NOT ONE (owner ruling 2026-08-13, JOS-344)
// ---------------------------------------------------------------------------
//
// JOS-338 drew ONE card with an equipped PANEL stacked inside it, and the owner ruled the other
// way: the hovered ITEM on the left, the CURRENTLY EQUIPPED on the right, side by side. The
// argument is the reading — a comparison read top-to-bottom is a list, a comparison read
// left-to-right is a comparison — and the layout is what makes the distinct treatment mean
// something: two surfaces, two accents, two borders, and no chance of mistaking what you HAVE for
// what you are READING ABOUT. The right card keeps everything the panel carried, including the
// dump freshness line, because that line is a claim about the right card's contents and nowhere
// else. When the first read has not settled there is NO right card — "we have not looked yet" is
// not an empty comparison (law 1).
//
// THE DRAWING IS `hoverCards.tsx`'s VOCABULARY — the same palette, `CardSection` and `MoreLine`
// that the mob card and the spell card use, so the hover cards in this app read as one family.
// What it deliberately does NOT reuse is `KnownItemTooltip`'s BODY: that card fetches
// `ItemKnowledge` over IPC to draw an EQ-style item window, and this one needs the numeric vector
// instead — both halves of a comparison have to be in one vocabulary or the delta is a guess. The
// renderer already holds the whole corpus (`useGearIndex`), so both sides are `GearRow`s joined by
// `itemKey`, the comparison costs ZERO IPC calls per hover on either surface, and the plus-state
// the table is simulating is already baked into the row this card is handed.
//
// EVERY WORD IS `gearCompare.ts`'s (pure, node-tested). This file owns where a line goes.

import { type JSX, type ReactElement, useCallback, useEffect, useState } from 'react'
import type { GearRow } from '@shared/planner/gear'
import { scaleGearRow } from '@shared/planner/gearScale'
import { ITEM_MAX_TIER } from '@shared/itemStats'
import { percentLabel } from '@shared/itemUpgrade'
import { outputKind } from '@shared/outputs/kinds'
import { CARD_LABEL, CARD_MONO, CARD_TEXT, LABEL_STYLE, MoreLine, TEXT_STYLE } from '../../lib/hoverCards'
import { Tooltip } from '../../lib/Tooltip'
import {
  arrowText,
  compareDirection,
  compareStats,
  dumpFreshnessText,
  equippedCells,
  equippedState,
  hostText,
  statPairText,
  type EquippedCell,
  type StatCompare
} from './gearCompare'
import type { GearCompareData } from './gearData'

/** How many of the item's own stats the left card lists before collapsing to "+N more". */
const MAX_STATS = 10
/** …and how many CHANGES one equipped cell lists — 12 since the swap lines (each entry is shorter
 *  than the sentence form was, so the cap buys more stats for the same clipping budget). */
const MAX_DELTAS = 12

/** The hovered item's accent — the item green every card in this family gives an item name. */
const ITEM_ACCENT = '#5fe08a'
/**
 * THE DISTINCT TREATMENT the ticket asks for, and the reason the pair is legible at a glance: the
 * equipped card wears its own colour, its own tinted surface and its own border. Amber rather than
 * another green for exactly that reason — the two cards of this pair are the one place in the app
 * where two item names mean opposite things.
 */
const EQUIPPED_ACCENT = '#e0b76a'

/** Each card's ceiling. Two of them plus the gap is the pair's natural width (~690px). */
const CARD_MAX_WIDTH = 340

/**
 * THE PAIR IS ONE ROW THAT NEVER WRAPS AND NEVER OUTGROWS THE WINDOW.
 *
 * `nowrap` is the layout the owner asked for — item left, equipped right — so it is stated rather
 * than left to the default. The `maxWidth` is the second half of guarantee 1: `preventOverflow`
 * can only slide a popper that FITS, and a pair wider than the window would be clamped to the left
 * edge and still hang off the right. Below ~700px of window the two cards shrink together
 * (`flex: 1 1 auto` with `minWidth: 0` on each) instead of one of them leaving the screen.
 */
const PAIR_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'row',
  flexWrap: 'nowrap',
  alignItems: 'flex-start',
  gap: 8,
  maxWidth: 'calc(100vw - 24px)'
}

/** One card's surface. Same geometry both sides; only the accent and the tint differ. */
function cardSurface(accent: string, tint: string): React.CSSProperties {
  return {
    flex: '1 1 auto',
    minWidth: 0,
    maxWidth: CARD_MAX_WIDTH,
    background: tint,
    border: `1px solid ${accent}`,
    borderRadius: 6,
    padding: 8,
    fontFamily: CARD_MONO,
    color: CARD_TEXT,
    boxShadow: '0 6px 20px rgba(0,0,0,0.6)'
  }
}

const ITEM_SURFACE = cardSurface(ITEM_ACCENT, 'rgba(15,16,23,0.98)')
const EQUIPPED_SURFACE = cardSurface(EQUIPPED_ACCENT, 'rgba(28,23,14,0.98)')

/** The command, from the registry that owns its spelling — never re-typed into a literal. */
const INVENTORY_COMMAND = outputKind('inventory').command

/**
 * WHAT THE TABLE IS SIMULATING, said on the card too (JOS-284's slider).
 *
 * The row this card is handed is the SCALED one, so at a non-base plus-state the item card states
 * numbers no copy in the world has yet — and the equipped card beside it is a real object off a
 * real dump. A comparison between a simulation and a fact has to say which is which; at base there
 * is nothing to say and the line is absent, which is also the whole of the Exaltations browser's
 * case (it hands this card `ITEM_UPGRADE_BASE` and simulates nothing).
 */
function SimulatedLine({ data }: { data: GearCompareData }): JSX.Element | null {
  const { full, fraction } = data.state
  if (full === 0) return null
  const denominator = full >= ITEM_MAX_TIER ? 0 : 2 ** full
  return (
    <div style={{ ...LABEL_STYLE, marginTop: 2 }} data-testid="gear-compare-simulated">
      simulated at Tier {full}
      {denominator > 0 && ` · ${String(fraction)}/${String(denominator)}`} · {percentLabel(data.state)}
    </div>
  )
}

/** The hovered item's own numbers, in the corpus's key order. Absent keys draw nothing (law 1). */
function ItemStats({ row }: { row: GearRow }): JSX.Element | null {
  // `compareStats(…, null)` states every key the page states and nothing else, so the `flatMap` is
  // the compiler's proof rather than a filter: an entry with no `item` cannot reach `statPairText`.
  const stated = compareStats(row.stats, null).flatMap((s) => (s.item === undefined ? [] : [statPairText(s.key, s.item)]))
  if (stated.length === 0) return null
  return (
    <>
      <div style={{ ...TEXT_STYLE, marginTop: 3 }} data-testid="gear-compare-stats">
        {stated.slice(0, MAX_STATS).join(' · ')}
      </div>
      <MoreLine total={stated.length} shown={MAX_STATS} />
    </>
  )
}

/** The swap's two verdict colors — semantic, not accents: green is what equipping the hovered item
 *  GAINS you, red what it COSTS you. Distinct from the two card accents on purpose; the card
 *  borders say whose card it is, these say which way a number moves. */
const GAIN_COLOR = '#6ee89a'
const LOSS_COLOR = '#e8776a'

/**
 * THE SWAP, GROUPED (fork, kaltinril 2026-09-05, replacing the sentence form): one green line of
 * what this item gains you, one red line of what it costs, each entry `KEY worn→this` with both
 * numbers kept (`arrowText`). Two wrapping lines rather than a row per stat, so a twenty-stat mask
 * costs the height his prose already cost — the bottom-anchored card's clipping budget is the
 * binding constraint (the header's guarantee-1 price).
 */
function SwapLines({ changes }: { changes: StatCompare[] }): JSX.Element {
  const shown = changes.slice(0, MAX_DELTAS)
  const groups = [
    { word: 'gain', color: GAIN_COLOR, entries: shown.filter((c) => compareDirection(c) === 'gain') },
    { word: 'lose', color: LOSS_COLOR, entries: shown.filter((c) => compareDirection(c) === 'loss') }
  ]
  return (
    <div data-testid="gear-compare-delta">
      {groups.map(({ word, color, entries }) =>
        entries.length === 0 ? null : (
          <div key={word} style={LABEL_STYLE}>
            {word}: <span style={{ color }}>{entries.map(arrowText).join(' · ')}</span>
          </div>
        )
      )}
    </div>
  )
}

/**
 * ONE PLACE THIS ITEM WOULD GO, and what is in it. One of these per cell, STACKED inside the right
 * card — an earring is two answers and the pair stays two cards.
 *
 * THREE ANSWERS, AND THEY ARE THREE DIFFERENT STATEMENTS (law 1). The dump names a copy and the
 * corpus knows its numbers ⇒ the name and the changes. The dump names a copy the corpus has no page
 * for ⇒ the name, and the card says the numbers are missing rather than drawing an empty delta
 * line. The dump names nothing ⇒ that place is EMPTY, which is a fact the client's own file states
 * (gearCompare.ts, decision 2) and the best news a gear planner can give you.
 */
function EquippedRow({ cell, row, data }: { cell: EquippedCell; row: GearRow; data: GearCompareData }): JSX.Element {
  const host = cell.host
  const worn = host === null ? undefined : data.byKey.get(host.key)
  // The worn copy is scaled at ITS OWN `+N` before the subtraction — comparing a candidate against
  // a base-tier reading of something you have already merged five times is the wrong answer, and
  // `equippedState` is where the fraction the dump does not state is priced (gearCompare.ts).
  const changes =
    host === null || worn === undefined ? [] : compareStats(row.stats, scaleGearRow(worn, equippedState(host)).stats)
  return (
    <div
      style={{ marginTop: 3 }}
      data-testid="gear-compare-slot"
      data-cell={cell.cell}
      data-equipped={host === null ? undefined : host.key}
    >
      <div style={TEXT_STYLE}>
        <span style={{ color: CARD_LABEL }}>{cell.label}: </span>
        {host === null ? (
          <span style={{ color: CARD_LABEL }} data-testid="gear-compare-empty">
            nothing equipped
          </span>
        ) : (
          <span style={{ color: EQUIPPED_ACCENT }} data-testid="gear-compare-equipped-name">
            {hostText(host)}
          </span>
        )}
      </div>
      {host !== null && worn === undefined && (
        <div style={LABEL_STYLE}>the item database has no numbers for that one</div>
      )}
      {changes.length > 0 && (
        <>
          <SwapLines changes={changes} />
          <MoreLine total={changes.length} shown={MAX_DELTAS} />
        </>
      )}
    </div>
  )
}

/** The left card: the thing the pointer is on. */
export function GearCompareCard({ row, data }: { row: GearRow; data: GearCompareData }): JSX.Element {
  return (
    <div data-testid="gear-compare-card" data-item-key={row.key} style={ITEM_SURFACE}>
      <div style={{ color: ITEM_ACCENT, fontSize: 12, fontWeight: 700 }}>{row.name}</div>
      <div style={LABEL_STYLE}>
        {row.slots.join(' ')}
        {row.classes.length > 0 && ` · ${row.classes.length >= 16 ? 'ALL' : row.classes.join(' ')}`}
      </div>
      <SimulatedLine data={data} />
      <ItemStats row={row} />
    </div>
  )
}

/**
 * The right card, or the reason there is none.
 *
 * NO DUMP IS NOT AN EMPTY BODY (the ticket's own rule, and law 1's): "you are wearing nothing there"
 * and "this app has never seen your inventory" are different sentences, and only the second one has
 * a fix the player can type. Before the first read settles the pair is ONE card — a card that
 * flashed the command hint at somebody who exported an hour ago would be the JOS-253 failure again.
 *
 * THE FRESHNESS LINE LIVES HERE, not on the item card, and that is the JOS-344 layout saying
 * something true: the age is a property of the claim this card makes and of nothing on the other
 * one.
 */
export function EquippedCompareCard({ row, data }: { row: GearRow; data: GearCompareData }): JSX.Element | null {
  if (!data.ready) return null
  const cells = data.hasDump ? equippedCells(data.equipped, row.slots) : []
  return (
    <div data-testid="gear-compare-equipped-card" style={EQUIPPED_SURFACE}>
      <div style={{ color: EQUIPPED_ACCENT, fontSize: 12, fontWeight: 700 }}>Currently equipped</div>
      {data.hasDump ? (
        cells.map((cell) => <EquippedRow key={cell.cell} cell={cell} row={row} data={data} />)
      ) : (
        <div style={{ ...TEXT_STYLE, marginTop: 3 }} data-testid="gear-compare-nodump">
          No inventory dump for this character yet. Type <span style={{ color: EQUIPPED_ACCENT }}>{INVENTORY_COMMAND}</span> in
          game and this card fills itself.
        </div>
      )}
      <div style={{ ...LABEL_STYLE, marginTop: 4 }} data-testid="gear-compare-freshness">
        {dumpFreshnessText(data.exportedAt)}
      </div>
    </div>
  )
}

/**
 * THE PAIR — the item, and what you wear instead of it, in that x-order.
 *
 * Exported for any surface that draws the comparison somewhere other than this tooltip, and it is
 * what `GearRowCompare` hands MUI as the tooltip's `title`.
 */
export function GearComparePair({ row, data }: { row: GearRow; data: GearCompareData }): JSX.Element {
  return (
    <div data-testid="gear-compare-pair" style={PAIR_STYLE}>
      <GearCompareCard row={row} data={data} />
      <EquippedCompareCard row={row} data={data} />
    </div>
  )
}

/**
 * The popper modifiers behind guarantee 1 — read the MEASUREMENT block in the header before
 * touching either of them, because the axis names do not mean what they sound like.
 *
 * For a `bottom`-based placement popper's `mainAxis` is the HORIZONTAL one and `altAxis` the
 * vertical (`getMainAxisFromPlacement` returns `'x'` for top/bottom and `'y'` for left/right). So
 * this pair of options says, in order: SLIDE SIDEWAYS to stay on screen, NEVER move vertically —
 * and `flip: false` says it may not jump above its anchor either. The 8px padding keeps a clamped
 * pair off the glass rather than flush against it.
 */
const CLAMP_SIDEWAYS_NEVER_UPWARD = [
  { name: 'flip', enabled: false },
  { name: 'preventOverflow', options: { mainAxis: true, altAxis: false, padding: 8 } }
]

/**
 * The chrome, hoisted to module scope — the JOS-206 finding, which `MOB_CARD_SLOT_PROPS` states in
 * full: a fresh `slotProps` with a nested `sx` per render is real reconciliation cost across a list
 * of anchors, and this card hangs off EVERY mounted row of a windowed 6,766-row table.
 *
 * The tooltip contributes no padding, no background and no width cap — the pair draws its own two
 * surfaces and states its own ceiling. The popper's `pointerEvents: 'none'` is guarantee 2, written
 * out rather than inherited from `disableInteractive`.
 */
const COMPARE_SLOT_PROPS = {
  popper: { modifiers: CLAMP_SIDEWAYS_NEVER_UPWARD, sx: { pointerEvents: 'none' } },
  tooltip: { sx: { p: 0, bgcolor: 'transparent', maxWidth: 'none' } }
} as const

/**
 * Guarantee 3: the pair is gone on the first pointerdown ANYWHERE, capture phase — before the
 * control the user aimed at opens its own list. Controlled state is the only way to say that, so
 * this card is controlled and MUI's own hover lifecycle drives `onOpen`/`onClose` as usual.
 */
function useCloseOnPointerDown(): { open: boolean; onOpen: () => void; onClose: () => void } {
  const [open, setOpen] = useState(false)
  const onClose = useCallback(() => {
    setOpen(false)
  }, [])
  const onOpen = useCallback(() => {
    setOpen(true)
  }, [])
  useEffect(() => {
    if (!open) return
    window.addEventListener('pointerdown', onClose, true)
    return () => {
      window.removeEventListener('pointerdown', onClose, true)
    }
  }, [open, onClose])
  return { open, onOpen, onClose }
}

export interface GearRowCompareProps {
  row: GearRow
  data: GearCompareData
  /**
   * THE ANCHOR, and since JOS-344 there are two shapes of it: the gear table's whole `<TableRow>`,
   * and the Exaltations browser's donor NAME. Only its bottom-LEFT corner is read (see guarantee
   * 1), so a full-width row and a 120px name behave identically — both open the pair under the
   * name the pointer is on.
   */
  children: ReactElement
}

/**
 * Hover an item → the comparison pair. The ONE door (see the header).
 *
 * `enterDelay` is longer than the spell card's 250ms on purpose: the anchors here are dense list
 * rows, so a pointer crossing the list on its way to the scrollbar passes over a dozen of them and
 * must open none. `enterNextDelay` keeps that true after the first pair has opened.
 */
export function GearRowCompare({ row, data, children }: GearRowCompareProps): JSX.Element {
  const controlled = useCloseOnPointerDown()
  return (
    <Tooltip
      {...controlled}
      title={<GearComparePair row={row} data={data} />}
      placement="bottom-start"
      disableInteractive
      enterDelay={350}
      enterNextDelay={350}
      leaveDelay={60}
      slotProps={COMPARE_SLOT_PROPS}
    >
      {children}
    </Tooltip>
  )
}
