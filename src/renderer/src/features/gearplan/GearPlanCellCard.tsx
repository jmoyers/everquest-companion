// gearplan/GearPlanCellCard.tsx — ONE CELL of the board: what is planned there, at what merge
// level, with what in its sockets.
//
// `GearSetCells.tsx`'s cell and `PlanCell.tsx`'s socket lines, in one card — which is the whole
// feature. Neither retired surface could draw this: a gear set had an item and a `+N` and no
// sockets, and a plan cell had four sockets whose unlock tier it read off the INVENTORY DUMP,
// because the item under it was somebody else's document.
//
// ALL FOUR SOCKETS ARE DRAWN ONCE THE CELL HAS AN ITEM, filled or not — `PlanCell`'s V8 ruling,
// revived in its words: "the empty ones are the point, exactly as they are in the game's own item
// window." A cell with NO item draws none, from the same file: "four empty rows on twenty-three
// untouched cells would be noise, not an invitation."
//
// AND A LOCKED SOCKET IS NOT A CONTROL. It says the tier that would unlock it (`+3 to unlock`) and
// offers nothing to click — `SocketChip`'s `onBrowse === null` arm. What is new is where that tier
// comes from: `unlockedSockets` reads the cell's own PLANNED plus-state, so raising it lights
// sockets up. That coupling is why the item and its exaltations are one document.
//
// ---------------------------------------------------------------------------------------------
// IT IS A `DashCard`, NOT A HAND-BUILT PAPER (house law 7: one component, every surface).
//
// The design library describes exactly one card shape for the whole app — outlined paper, 10px
// padding, a dense uppercase title left and a free-form status slot right — and `DashCard` in
// combatShared.tsx IS that shape, both sizing modes included. Rebuilding it here with the same
// `sx` values would be the second implementation that law exists to forbid, and it would drift the
// first time the card gains a state.
//
// FILL, NEVER CONTENT-SIZED, and that is the library's sizing law rather than a preference: "a
// card that sizes itself to its content steals the whole box from its shrinkable siblings". The
// cell takes the height its grid track gives it and its body scrolls; the board owns the floor.
//
// THE SOCKET LINES ARE STAT LABELS, in the library's micro type (9px, 0.06em, uppercase, disabled
// ink) with the value opposite at caption size — the pairing the meter bars' expanded readout
// uses. A locked socket's reason is INLINE rather than hidden in a tooltip: it is load-bearing (it
// is the entire explanation of why there is nothing to click), and the hover diet says
// load-bearing text has to exist somewhere permanent.
//
// ---------------------------------------------------------------------------------------------
// A PLANNED EFFECT WEARS THE APP'S SPELL CARD ON HOVER, AND THIS FILE USED TO FORBID IT.
//
// The rule here read: "the DONOR stays in a native `title` - no MUI popper, because a card in a
// grid opens one straight over its neighbours." That was over-applied. The no-popper law is about
// a popper COVERING A CONTROL you are trying to use - it names a table row and a combobox's own
// bar - and the app already hangs `SpellTooltip` off spell names on four surfaces, including rows
// in lists. A grid neighbour is not a control you are mid-gesture with; it is scenery, and the card
// is non-interactive and leaves the moment the pointer does.
//
// What the old rule was RIGHT about is that a socket line reading `Affliction Haste II` tells you
// nothing about what that does, and "go open the picker and expand the row" is a bad answer to a
// question you have while looking straight at it. So: the EFFECT TEXT carries the spell card, and
// the PENCIL keeps a native `title` naming the donor. Two different elements, so the two hovers
// cannot fire at once, and no information that used to be here has left.
//
// THE CELL IS NOT ITSELF A CONTROL, so the things inside it may be. The design library's rule is
// "a click target inside a click target is what got the loot table's favourite star deleted" — a
// table ROW is the control there, and nothing inside it may also be clickable. A card is not a
// row: it opens nothing on click, so its item name, its four socket lines and its tier slider are
// each free to be the control they look like.
//
// EVERY CONTROL HANGS OFF ONE `on` PROP, so the view owns which popover is open and this card stays
// a pure render with no popover state of its own — twenty-three cards each holding an anchor is
// twenty-three ways for two popovers to be open at once.

import { memo, type JSX } from 'react'
import { Box, Link, Stack, Typography } from '@mui/material'
import EditIcon from '@mui/icons-material/EditOutlined'
import FavoriteBorderIcon from '@mui/icons-material/FavoriteBorder'
import type { ItemUpgradeState } from '@shared/itemUpgrade'
import GearPlanTierSlider from './GearPlanTierSlider'
import type { ItemStatBlock } from '@shared/itemStats'
import { unlockedSockets, type GearPlanCell } from '@shared/planner/gearPlan'
import { cellStatLine, type CellDelta } from '@shared/planner/gearPlanTotals'
import GearPlanDeltaLine from './GearPlanDeltaLine'
import GearPlanRatioLine from './GearPlanRatioLine'
import type { WeaponRead } from './gearPlanFold'

import { extractionTier } from '@shared/planner/rules'
import { SpellTooltip } from '../../lib/SpellCard'
import { SOCKET_TYPES, planSlotLabel, type PlanSlotId, type SocketType } from '@shared/planner/types'
import { DashCard, QuietNote } from '../combat/combatShared'
import ItemIcon from '../../lib/ItemIcon'

/** The library's micro STAT LABEL: 9px, 0.06em, uppercase, disabled ink. */
const STAT_LABEL = {
  fontSize: 9,
  lineHeight: 1.4,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'text.disabled'
} as const

/** Everything this card can ask the board to do. One object, so adding a control widens one prop. */
export interface GearPlanCellHandlers {
  /** aim the right column's item picker at this cell */
  pickItem: (cell: PlanSlotId) => void
  /** aim the right column's exaltation picker at one socket of this cell */
  pickSocket: (cell: PlanSlotId, socket: SocketType) => void
  /** move this cell's planned merge tier */
  setState: (cell: PlanSlotId, state: ItemUpgradeState) => void
  /** empty the cell entirely */
  clear: (cell: PlanSlotId) => void
  /** put this cell's item and every donor it plans on the wish list */
  wish: (cell: PlanSlotId) => void
}

export interface GearPlanCellCardProps {
  cell: PlanSlotId
  /** what is planned here; `null` is a cell nothing has been planned into */
  planned: GearPlanCell | null
  /**
   * The planned item's stat block at its own plus-state, or `undefined` when the corpus has no row
   * for it. Computed by the view (one gear-index lookup per cell) rather than here, so this card
   * takes no data hook and stays a pure render.
   */
  block?: ItemStatBlock
  delta: CellDelta[] | null
  /** a weapon's ratio and what it would replace; `null` when this cell holds no weapon */
  weapon: WeaponRead | null
  /** the corpus's icon for the planned item; absent draws the empty frame, so cells line up */
  iconId?: number
  on: GearPlanCellHandlers
}

/** `+4`, or `+4 · 3 banked`. Gold and tabular — it is the card's one status value. */
function TierValue({ planned }: { planned: GearPlanCell }): JSX.Element {
  const banked = planned.state.fraction > 0 ? ` · ${String(planned.state.fraction)} banked` : ''
  return (
    <Typography
      variant="caption"
      sx={{ color: 'primary.main', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}
    >
      {`+${String(planned.state.full)}${banked}`}
    </Typography>
  )
}

/**
 * The socket's right-hand text, wearing the spell card ONLY when it names an effect.
 *
 * An empty socket reads `-` and a locked one reads `+3 to unlock`; hanging a spell card off either
 * would be a popper promising an explanation of a dash. `SpellCard` also fetches per name on mount,
 * so wrapping the other two would be a lookup for a string that is not a spell.
 */
function SocketText({ effect, children }: { effect?: string; children: JSX.Element }): JSX.Element {
  if (effect === undefined) return children
  // `right` is `SpellTooltip`'s own default and the placement it calls right for a dense row; MUI
  // flips it to `left` when the board's last column has no room, so the card never leaves the page.
  return <SpellTooltip name={effect}>{children}</SpellTooltip>
}

/** One socket line: what is planned in it, or the tier that would let you plan one. */
function SocketLine({
  socket,
  planned,
  unlocked,
  onPick
}: {
  socket: SocketType
  planned: GearPlanCell
  unlocked: boolean
  /** `null` when the tier has not unlocked this socket — an unreachable socket is NOT a control */
  onPick: (() => void) | null
}): JSX.Element {
  const inSocket = planned.sockets[socket]
  // An unlocked socket with nothing in it is ABSENT and renders the app's `-` (house law 2). A
  // locked one is not absent, it is out of reach, and says what would reach it.
  const detail =
    inSocket !== undefined
      ? inSocket.effect
      : unlocked
        ? '-'
        : `+${String(extractionTier(socket))} to unlock`
  return (
    <Stack
      direction="row"
      justifyContent="space-between"
      alignItems="baseline"
      sx={{ gap: 1 }}
      data-testid={`gearplan-socket-${socket}`}
    >
      <Typography sx={{ ...STAT_LABEL, flexShrink: 0 }}>{socket}</Typography>
      {onPick === null ? (
        // A socket the tier no longer unlocks KEEPS whatever is planned in it (lowering a slider
        // must not delete a pick), so it can still be a filled socket - and it still explains what
        // it holds, even though it is no longer a control.
        <SocketText effect={inSocket?.effect}>
          <Typography
            variant="caption"
            color="text.disabled"
            noWrap
            sx={{ minWidth: 0, textAlign: 'right' }}
          >
            {detail}
          </Typography>
        </SocketText>
      ) : (
        <Link
          component="button"
          type="button"
          underline="hover"
          variant="caption"
          // THE PENCIL IS THE AFFORDANCE, and it was missing: an unlocked-but-empty socket read as
          // a bare `-` with no sign that it was a control at all. The design library's own words
          // are "a hoverable thing has to look hoverable before it is hovered" - it says that about
          // the tooltip cursor, and the same argument is why the icon is here rather than a hover
          // state. 18px is the library's in-a-row icon size; it inherits secondary ink and lifts to
          // primary on hover, which is its rule for a caption icon.
          color={inSocket === undefined ? 'text.disabled' : 'text.primary'}
          onClick={() => onPick()}
          sx={{ minWidth: 0, textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, minWidth: 0 }}>
            {/* THE CARD HANGS HERE and not on the `Link`, so that hovering the pencil does not open
                it. Two hovers on one element would race; on two elements they simply differ. */}
            <SocketText effect={inSocket?.effect}>
              <Box
                component="span"
                data-testid={`gearplan-socket-effect-${socket}`}
                sx={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}
              >
                {detail}
              </Box>
            </SocketText>
            {/* The donor rides here, on the control, phrased as what the control DOES - which is
                the tooltip diet's own rule ("naming a control, one clause"). It is also the only
                place on the board that names the item an exaltation came out of. */}
            <Box
              component="span"
              // A `title` ATTRIBUTE on a wrapper, not `titleAccess` on the icon: `titleAccess`
              // renders a `<title>` ELEMENT inside the svg, which becomes part of the row's text
              // content - it turned a cell's readout into "focus-Choose an exaltation for this
              // focus socket…". The wrapper keeps the hover and leaves the text alone. It is a
              // sibling of the tooltipped span rather than an ancestor, so the two never both fire.
              title={
                inSocket === undefined
                  ? `Choose an exaltation for this ${socket} socket`
                  : `Change this exaltation - currently from ${inSocket.donorName}`
              }
              sx={{ display: 'inline-flex', flexShrink: 0 }}
            >
              <EditIcon
                sx={{
                  fontSize: 18,
                  color: 'text.secondary',
                  '.MuiLink-root:hover &': { color: 'primary.main' }
                }}
              />
            </Box>
          </Box>
        </Link>
      )}
    </Stack>
  )
}

/**
 * WHAT THIS CELL WOULD CHANGE — or, with nothing to compare against, what its item simply IS.
 *
 * THE DELTA IS THE ANSWER WHENEVER THERE IS ONE. A planner already knows roughly what a helm does;
 * the question a board is asked is "is this better than what I have on", and a list of twelve
 * absolute numbers makes the reader do that subtraction twenty-three times. `compareStats` drops
 * every key that did not move, so what is left is exactly the part worth reading.
 *
 * `null` IS NOT AN EMPTY LIST. `null` means there was nothing to compare to (no dump, or that cell
 * is empty on the body) and the absolute stats are the honest fallback; `[]` means the comparison
 * RAN and nothing moved, which is a real answer and gets said out loud.
 */
function CellStats({ block, delta }: { block?: ItemStatBlock; delta: CellDelta[] | null }): JSX.Element {
  if (block === undefined) {
    return (
      <Box data-testid="gearplan-item-unknown">
        <QuietNote>not in the item database</QuietNote>
      </Box>
    )
  }
  if (delta !== null) {
    if (delta.length === 0) return <QuietNote>same as what you have on</QuietNote>
    return <GearPlanDeltaLine delta={delta} testId="gearplan-stat-delta" />
  }
  const rows = cellStatLine(block)
  if (rows.length === 0) return <QuietNote>no stats stated</QuietNote>
  return (
    <Typography
      variant="caption"
      color="text.secondary"
      sx={{ display: 'block', fontVariantNumeric: 'tabular-nums' }}
    >
      {rows.map((r) => `${r.label} ${r.value}`).join(' · ')}
    </Typography>
  )
}

/** The name (the item picker's door), the wish control, and the one destructive control. */
function CellHeader({
  cell,
  planned,
  iconId,
  on
}: {
  cell: PlanSlotId
  planned: GearPlanCell
  iconId?: number
  on: GearPlanCellHandlers
}): JSX.Element {
  return (
          <Stack direction="row" alignItems="center" sx={{ gap: 0.75 }}>
      <Stack
        direction="row"
        alignItems="center"
        sx={{ gap: 0.75, minWidth: 0, flexShrink: 1 }}
        data-testid="gearplan-item-identity"
      >
        {/* The Character tab's treatment, 20px for a dense card rather than its 28px armoury cell.
            The frame draws even with no icon, so a cell whose item the corpus has no art for keeps
            its name on the same left edge as its neighbours. */}
        <ItemIcon iconId={iconId} size={20} filled />
        <Link
          component="button"
          type="button"
          underline="hover"
          variant="body2"
          color="text.primary"
          data-testid="gearplan-item-name"
          onClick={() => on.pickItem(cell)}
          sx={{ lineHeight: 1.4, minWidth: 0, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis' }}
        >
          {planned.name}
        </Link>
      </Stack>
      <Box sx={{ flexGrow: 1, minWidth: 4 }} />
      {/* WISH, then CLEAR — and a NATIVE title, not a popper of any kind. House law 8: a card in a
          grid opens a popper straight over its neighbours, and `tests/tooltipCursor.test.mts`
          enforces that only `lib/Tooltip.tsx` may import MUI's. An icon-only control still needs an
          accessible name, so `aria-label` carries it and `title` shows it — the library's own rule:
          "an icon-only control carries an aria-label that says what it does, because that is also
          its accessible name". */}
      <Link
        component="button"
        type="button"
        underline="none"
        sx={{ flexShrink: 0, display: 'inline-flex', color: 'text.secondary', '&:hover': { color: 'primary.main' } }}
        data-testid="gearplan-wish-cell"
        aria-label="Add this cell to the wish list"
        title="Add this item and its planned exaltations to your wish list"
        onClick={() => on.wish(cell)}
      >
        <FavoriteBorderIcon sx={{ fontSize: 18 }} />
      </Link>
      {/* The one destructive control on the board, and it is a word rather than an icon: a
          20px glyph in a 260px card is a guess about what it does. */}
      <Link
        component="button"
        type="button"
        underline="hover"
        sx={{ ...STAT_LABEL, flexShrink: 0 }}
        data-testid="gearplan-clear-cell"
        onClick={() => on.clear(cell)}
      >
        clear
      </Link>
    </Stack>
  )
}

/**
 * THE FILLED ARM, split out because the card crossed the measured 100-code-line function ceiling
 * the moment it grew controls — `PlanCell.tsx` was split out of `PlanBoard` for exactly this and
 * named the seam in advance. The empty arm stays inline: it is one control.
 */
function PlannedBody({
  cell,
  planned,
  block,
  delta,
  weapon,
  iconId,
  on
}: {
  cell: PlanSlotId
  planned: GearPlanCell
  block?: ItemStatBlock
  delta: CellDelta[] | null
  weapon: WeaponRead | null
  iconId?: number
  on: GearPlanCellHandlers
}): JSX.Element {
  const unlocked = unlockedSockets(planned.state)
  return (
    <>
        <>
          <CellHeader cell={cell} planned={planned} iconId={iconId} on={on} />
          <CellStats block={block} delta={delta} />
          {/* ITS OWN LINE, UNDER THE DELTA. A weapon's ratio is the number the tier slider directly
              below it moves, so it sits between what the item is and the control that changes it. */}
          {weapon !== null && (
            <GearPlanRatioLine mine={weapon.mine} worn={weapon.worn} testId="gearplan-ratio" />
          )}


          <Box sx={{ mt: 0.5 }}>
            <GearPlanTierSlider state={planned.state} onChange={(next) => on.setState(cell, next)} />
          </Box>

          <Box sx={{ mt: 0.5 }}>
            {SOCKET_TYPES.map((socket) => (
              <SocketLine
                key={socket}
                socket={socket}
                planned={planned}
                unlocked={unlocked.includes(socket)}
                onPick={
                  unlocked.includes(socket)
                    ? () => {
                        on.pickSocket(cell, socket)
                      }
                    : null
                }
              />
            ))}
          </Box>
        </>
    </>
  )
}

function GearPlanCellCard({
  cell,
  planned,
  block,
  delta,
  weapon,
  iconId,
  on
}: GearPlanCellCardProps): JSX.Element {
  return (
    <DashCard
      fill
      title={planSlotLabel(cell)}
      right={planned === null ? undefined : <TierValue planned={planned} />}
      testId={`gearplan-cell-${cell}`}
    >
      {planned === null ? (
        // An EMPTY cell is one control and nothing else. Four socket rows and a tier slider on
        // twenty-three untouched cells would be noise, not an invitation (PlanCell's own ruling).
        <Link
          component="button"
          type="button"
          underline="hover"
          variant="body2"
          color="text.disabled"
          data-testid="gearplan-add-item"
          onClick={() => on.pickItem(cell)}
          sx={{ alignSelf: 'flex-start' }}
        >
          nothing planned
        </Link>
      ) : (
        <PlannedBody
          cell={cell}
          planned={planned}
          block={block}
          delta={delta}
          weapon={weapon}
          iconId={iconId}
          on={on}
        />
      )}
    </DashCard>
  )
}

export default memo(GearPlanCellCard)
