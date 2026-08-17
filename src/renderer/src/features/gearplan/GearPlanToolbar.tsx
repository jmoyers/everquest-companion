// gearplan/GearPlanToolbar.tsx — the board's three whole-plan actions.
//
// A CONTROL BAR, which the design library defines precisely: "an outlined Paper at
// rgba(255,255,255,0.015) - a hair lighter than the page, so it reads as chrome rather than as a
// card". That is the whole reason this is not a `DashCard`: the cards below own the page's borders
// and a third card up here would compete with them.
//
// ---------------------------------------------------------------------------------------------
// WHY THE LOAD IS A MENU AND NOT A CONFIRM DIALOG.
//
// Loading what you are wearing over a board you have worked on is destructive and this app has no
// undo, so the user has to get a say — but house law 6 is "never interrupt play... never modals",
// and a yes/no dialog would also be asking the wrong question. There are TWO useful answers here,
// not one: top up the empty cells, or start over from your body. A menu offers both, states what
// each costs IN THE OPTION, and is the shape the library already documents for exactly this
// ("where a picker's options need explaining, the explanation goes in the options - a secondary
// line per row"). The destructive row NAMES THE NUMBER it would discard before it runs, which is
// the warning; a dialog would have said the same sentence with an extra click around it.
//
// THE SAFE ROW IS FIRST and is the one a stray Return lands on. The destructive row sits second,
// carries the count, and takes the app's adverse hue rather than `error.main` — the library scopes
// red to "close-hover and real failure", and discarding work you asked to discard is neither.
//
// CLEAR THE BOARD IS THE SAME SHAPE FOR THE SAME REASON, with one row instead of two. It has only
// one meaning, so its menu is a CONFIRM — and a one-row menu is still the right container, because
// what makes the load's destructive row safe is not the menu, it is that the row NAMES THE NUMBER
// before it runs. A bare button would discard twenty cells on one click with no undo anywhere in
// this app; a dialog would say the same sentence with a modal around it, which law 6 forbids.
//
// AND EVERY CONTROL DISAPPEARS WHEN IT CANNOT ACT. No dump means nothing to load from; an empty
// board means nothing to wish for and nothing to clear. That is law 9 read correctly: `text.disabled` is for what you
// genuinely cannot click, and a control with no possible effect is better absent than greyed —
// "a control that only makes sense in one mode is rendered only in that mode".
//
// ---------------------------------------------------------------------------------------------
// AND "CANNOT ACT" INCLUDES "CANNOT ACT CORRECTLY YET", which is the bug this paragraph exists to
// stop coming back.
//
// A load reads the worn exaltations through the DONOR CORPUS, and that corpus arrives over IPC
// after the first render. Run a load in the gap and every socket loads EMPTY — not with an error,
// just empty, which is a perfectly legal state for a cell to be in. Worse, the cells are now
// filled, so `fill` will never revisit them: the damage is silent, permanent, and looks exactly
// like the game having no exaltations to report.
//
// So the control is ABSENT until the corpus it depends on is in hand, on the same rule as the
// other two: a load that cannot read sockets is not a slower load, it is a lossy one.

import { type JSX, useState, type MouseEvent } from 'react'
import { Box, Button, Menu, MenuItem, Paper, Stack, Typography } from '@mui/material'
import FavoriteBorderIcon from '@mui/icons-material/FavoriteBorder'
import InventoryIcon from '@mui/icons-material/Inventory2Outlined'
import DeleteSweepIcon from '@mui/icons-material/DeleteSweepOutlined'
import type { LoadMode } from '@shared/planner/gearPlan'

/** KIND_COLOR.enemy — the app's adverse hue, and deliberately not `error.main` (see the header). */
const ADVERSE = '#cf6679'

export interface GearPlanToolbarProps {
  /** how many cells the board fills — 0 hides the wish control */
  assigned: number
  /** how many worn cells a `replace` would overwrite; `null` = there is no dump to load from */
  overwrites: number | null
  /**
   * whether the donor corpus a load resolves worn exaltations through has arrived.
   *
   * `false` HIDES the load entirely rather than letting it run and lose them — see the header. It
   * is the corpus's readiness and not the dump's, because the dump is already in `overwrites`.
   */
  canLoad: boolean
  onLoad: (mode: LoadMode) => void
  /** empty every planned cell — the surface confirms, this just obeys */
  onClearAll: () => void
  onWish: () => void
  /** how many rows the wish control just wrote, for the one line that says it happened */
  wished: number | null
}


/** The load's two answers, each stating what it costs in its own row. */
function LoadMenu({
  anchor,
  overwrites,
  onClose,
  onRun
}: {
  anchor: HTMLElement | null
  overwrites: number
  onClose: () => void
  onRun: (mode: LoadMode) => void
}): JSX.Element {
  return (
    <Menu anchorEl={anchor} open={anchor !== null} onClose={onClose}>
      <MenuItem data-testid="gearplan-load-fill" onClick={() => onRun('fill')}>
        <Box>
          <Typography variant="body2">Fill the empty cells only</Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
            Leaves everything you have already planned exactly as it is.
          </Typography>
        </Box>
      </MenuItem>
      <MenuItem data-testid="gearplan-load-replace" onClick={() => onRun('replace')}>
        <Box>
          <Typography variant="body2">Replace everything</Typography>
          <Typography variant="caption" sx={{ display: 'block', color: ADVERSE }}>
            {overwrites === 0
              ? 'Nothing planned would be discarded.'
              : `Discards ${String(overwrites)} ${overwrites === 1 ? 'cell' : 'cells'} you have planned. This cannot be undone.`}
          </Typography>
        </Box>
      </MenuItem>
    </Menu>
  )
}

/**
 * ONE ROW, AND IT IS THE WARNING. It states the count in the same words and the same hue the load's
 * destructive row uses, because it is the same act — and there is nowhere in this app to undo it
 * from.
 */
function ClearMenu({
  anchor,
  assigned,
  onClose,
  onWipe
}: {
  anchor: HTMLElement | null
  assigned: number
  onClose: () => void
  onWipe: () => void
}): JSX.Element {
  return (
    <Menu anchorEl={anchor} open={anchor !== null} onClose={onClose}>
      <MenuItem data-testid="gearplan-clear-all-confirm" onClick={onWipe}>
        <Box>
          <Typography variant="body2">
            {`Discard ${String(assigned)} planned ${assigned === 1 ? 'cell' : 'cells'}`}
          </Typography>
          <Typography variant="caption" sx={{ display: 'block', color: ADVERSE }}>
            This empties the whole board and cannot be undone.
          </Typography>
        </Box>
      </MenuItem>
    </Menu>
  )
}

export default function GearPlanToolbar({
  assigned,
  overwrites,
  canLoad,
  onLoad,
  onClearAll,
  onWish,
  wished
}: GearPlanToolbarProps): JSX.Element | null {
  // WHICH menu, not just where: two anchors that can each be non-null is a state where both are
  // open at once, and one field cannot reach it.
  const [menu, setMenu] = useState<{ kind: 'load' | 'clear'; el: HTMLElement } | null>(null)
  // One name for "a load is offerable at all", used by the button and by the menu it opens.
  const loadable = overwrites !== null && canLoad
  if (!loadable && assigned === 0) return null

  const close = (): void => {
    setMenu(null)
  }
  const run = (mode: LoadMode): void => {
    close()
    onLoad(mode)
  }
  const wipe = (): void => {
    close()
    onClearAll()
  }

  return (
    <Paper
      variant="outlined"
      data-testid="gearplan-toolbar"
      sx={{ bgcolor: 'rgba(255,255,255,0.015)', px: 1.25, py: 0.75, flexShrink: 0 }}
    >
      <Stack direction="row" spacing={2} alignItems="center" sx={{ flexWrap: 'nowrap' }}>
        {/* THE THREE ACTIONS AS DATA. Same button, three labels, three `when`s - written out three
            times it is three near-identical blocks and a complexity score this repo's ceiling
            rejects; as a list the SHAPE is stated once and only the differences are visible. */}
        {[
          {
            when: loadable,
            label: 'Load what you are wearing',
            testId: 'gearplan-load',
            icon: <InventoryIcon sx={{ fontSize: 18 }} />,
            act: (el: HTMLElement) => setMenu({ kind: 'load', el })
          },
          {
            when: assigned > 0,
            label: 'Add this plan to my wish list',
            testId: 'gearplan-wish-all',
            icon: <FavoriteBorderIcon sx={{ fontSize: 18 }} />,
            act: onWish
          },
          {
            when: assigned > 0,
            label: 'Clear the board',
            testId: 'gearplan-clear-all',
            icon: <DeleteSweepIcon sx={{ fontSize: 18 }} />,
            act: (el: HTMLElement) => setMenu({ kind: 'clear', el })
          }
        ]
          .filter((a) => a.when)
          .map((a) => (
            <Button
              key={a.testId}
              size="small"
              startIcon={a.icon}
              data-testid={a.testId}
              onClick={(e: MouseEvent<HTMLButtonElement>) => a.act(e.currentTarget)}
              sx={{ textTransform: 'none', color: 'text.secondary' }}
            >
              {a.label}
            </Button>
          ))}
        <Box sx={{ flexGrow: 1, minWidth: 4 }} />
        {/* One quiet line, stated once and never a toast: law 6 again, and the wish list itself is
            where the rows actually are. */}
        {wished !== null && (
          <Typography variant="caption" color="text.disabled" data-testid="gearplan-wished" noWrap>
            {wished === 0
              ? 'Everything on this plan was already on your wish list.'
              : `Added ${String(wished)} to your wish list.`}
          </Typography>
        )}
      </Stack>

      <LoadMenu anchor={menu?.kind === 'load' ? menu.el : null} overwrites={overwrites ?? 0} onClose={close} onRun={run} />

      <ClearMenu anchor={menu?.kind === 'clear' ? menu.el : null} assigned={assigned} onClose={close} onWipe={wipe} />
    </Paper>
  )
}
