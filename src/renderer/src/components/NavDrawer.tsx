import type { JSX } from 'react'
import { Box, Chip, Divider, Drawer, List, ListItemButton, ListItemIcon, ListItemText } from '@mui/material'
import SettingsIcon from '@mui/icons-material/Settings'
import ShieldMoonIcon from '@mui/icons-material/ShieldMoon'
import BarChartIcon from '@mui/icons-material/BarChart'
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong'
import TrendingUpIcon from '@mui/icons-material/TrendingUp'
import EmojiEventsIcon from '@mui/icons-material/EmojiEvents'
import NotificationsActiveIcon from '@mui/icons-material/NotificationsActive'
import TimerIcon from '@mui/icons-material/Timer'
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh'
import PetsIcon from '@mui/icons-material/Pets'
import MapIcon from '@mui/icons-material/Map'
import SpaceDashboardIcon from '@mui/icons-material/SpaceDashboard'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import FeedbackIcon from '@mui/icons-material/Feedback'
// Dev-only, and its import goes with it: MUI's icon packages declare `sideEffects: false`, so
// an icon whose only use sits inside a `false &&` branch is tree-shaken out with the branch.
import RuleFolderIcon from '@mui/icons-material/RuleFolder'
// Unreleased-only, and stripped with its branch for the same reason (JOS-45).
import AccountBoxIcon from '@mui/icons-material/AccountBox'
import UpdateChip from './UpdateChip'
import { OWNER_TOOLS, UNRELEASED } from '../devFlags'
import { VIEW_LABELS, type View } from '../appViews'

export const DRAWER_WIDTH = 220

/** A row is a view + an icon. The LABEL is not a field: it comes from `VIEW_LABELS`, the one
 *  place a tab is named, because a drill's Back button now says those names too (navOrigin.ts). */
interface NavRow {
  view: View
  icon: JSX.Element
  /** trailing state chip, when a row has one to state */
  badge?: JSX.Element
}

/* State, not process: this tab is unfinished, and the chip says so. */
const IN_DEV = (
  <Chip
    size="small"
    label="in dev"
    variant="outlined"
    sx={{ height: 18, fontSize: 10, color: 'text.secondary', '& .MuiChip-label': { px: 0.75 } }}
  />
)

// Row ORDER is the nav's order. Overview leads: it is the at-a-glance landing surface.
//
// LOOT SITS BESIDE MOBS (owner decision, 2026-08-04) and everything else keeps its place. The
// two tabs answer halves of one question — what drops it, and what did I get — and they link
// into each other constantly (a mob page's drop rows open an item, the Overview's drop rows open
// the loot detail). Loot's old home at the bottom of the list put five unrelated tabs between
// them.
const ROWS: NavRow[] = [
  { view: 'overview', icon: <SpaceDashboardIcon /> },
  { view: 'combat', icon: <BarChartIcon /> },
  { view: 'mobs', icon: <PetsIcon /> },
  { view: 'loot', icon: <ReceiptLongIcon /> },
  // EXALTATIONS follows Loot for the same reason Loot follows Mobs: it is the third face of one
  // question — what drops it, what did I get, and what am I still farming for. (Its LABEL lives
  // in `VIEW_LABELS`; JOS-42 renamed the tab there, which is also where Back reads it from.)
  { view: 'planner', icon: <AutoAwesomeIcon />, badge: IN_DEV },
  { view: 'maps', icon: <MapIcon /> },
  { view: 'bosses', icon: <EmojiEventsIcon /> },
  { view: 'posky', icon: <ShieldMoonIcon /> },
  { view: 'alerts', icon: <NotificationsActiveIcon /> },
  { view: 'leveling', icon: <TrendingUpIcon /> },
  { view: 'buffs', icon: <AutoFixHighIcon />, badge: IN_DEV },
  // Respawn clocks (JOS-194) sit beside Buffs because both tabs are the same shape of answer —
  // a list of things counting down — and a player checking one is usually checking the other.
  { view: 'timers', icon: <TimerIcon />, badge: IN_DEV }
]

/** Bottom-aligned, outside ROWS — it is not a feature view and never moves. */
const PREFERENCES: NavRow = { view: 'preferences', icon: <SettingsIcon /> }

/** One nav row. `data-testid="nav-<view>"` is the stable handle the e2e clicks. */
function NavRowButton({
  row,
  view,
  onSelect
}: {
  row: NavRow
  view: View
  onSelect: (v: View) => void
}): JSX.Element {
  return (
    <ListItemButton
      data-testid={`nav-${row.view}`}
      selected={view === row.view}
      onClick={() => onSelect(row.view)}
    >
      <ListItemIcon>{row.icon}</ListItemIcon>
      <ListItemText primary={VIEW_LABELS[row.view]} />
      {row.badge}
    </ListItemButton>
  )
}

/**
 * The permanent left nav: one row per view, Preferences bottom-aligned with the ambient
 * update chip beneath it.
 *
 * Frameless: the drawer is a normal in-flow child (no fixed OS bar above it), so it fills
 * the space under the title bar — `position: relative` + `height: 100%` keeps it inside
 * the flex row.
 */
export default function NavDrawer({
  view,
  onSelect,
  onSendFeedback
}: {
  view: View
  onSelect: (v: View) => void
  /** Opens the feedback DIALOG (Task #65). Feedback is not a view — appViews.ts is untouched —
   *  so this row carries a callback instead of a `View`, and never shows a selected state. */
  onSendFeedback: () => void
}): JSX.Element {
  return (
    <Drawer
      variant="permanent"
      sx={{
        width: DRAWER_WIDTH,
        flexShrink: 0,
        '& .MuiDrawer-paper': {
          width: DRAWER_WIDTH,
          boxSizing: 'border-box',
          position: 'relative',
          height: '100%',
          borderTop: 'none'
        }
      }}
    >
      <List>
        {ROWS.map((row) => (
          <NavRowButton key={row.view} row={row} view={view} onSelect={onSelect} />
        ))}
        {/* UNRELEASED (JOS-45): the character sheet has landed on main but has not passed the
            owner's review gate, so it is reachable in a dev build and STRIPPED from every
            packaged build. Same mechanism and same in-branch construction as the triage row
            below; `tests/e2e/character-sheet.e2e.mts` asserts `nav-character` is ABSENT in a
            production-shaped build. It graduates by moving into ROWS and deleting this block. */}
        {UNRELEASED && (
          <NavRowButton
            row={{
              view: 'character',
              icon: <AccountBoxIcon />,
              badge: (
                <Chip
                  size="small"
                  label="unreleased"
                  variant="outlined"
                  color="warning"
                  sx={{ height: 18, fontSize: 10, '& .MuiChip-label': { px: 0.75 } }}
                />
              )
            }}
            view={view}
            onSelect={onSelect}
          />
        )}
        {/* OWNER-ONLY: the feedback-triage tab. `OWNER_TOOLS` (JOS-72) is `DEV_TOOLS` AND the
            `EQ_OWNER_TOOLS=1` opt-in, so this row is absent from a fresh checkout's `npm run
            dev` as well as from every build — the tab reads the owner's AWS backlog, and a
            self-compiled copy of this public repo used to show it. `DEV_TOOLS` is still the
            left-hand term, so in `electron-vite build` this reads `false && …` and rollup
            deletes the branch: the row, its label, its chip and its icon are not in the shipped
            bundle at all. Built INSIDE the branch rather than hoisted to a module const on
            purpose: a top-level `jsx()` call is not something rollup can prove is side-effect
            free, and it would keep the strings alive. The e2e suite asserts `nav-triage` is
            ABSENT in a production-shaped build. */}
        {OWNER_TOOLS && (
          <NavRowButton
            row={{
              view: 'triage',
              icon: <RuleFolderIcon />,
              badge: (
                <Chip
                  size="small"
                  label="owner only"
                  variant="outlined"
                  color="warning"
                  sx={{ height: 18, fontSize: 10, '& .MuiChip-label': { px: 0.75 } }}
                />
              )
            }}
            view={view}
            onSelect={onSelect}
          />
        )}
      </List>

      {/* Bottom-aligned Preferences (Task #55) — replaces the old update-channel block. */}
      <Box sx={{ mt: 'auto' }}>
        <Divider />
        <List disablePadding>
          {/* Send feedback (Task #65): a dialog, so it is a plain action row — no `selected`
              state to own, because nothing in the nav stays "on" while it is open. */}
          <ListItemButton data-testid="nav-feedback" onClick={onSendFeedback}>
            <ListItemIcon>
              <FeedbackIcon />
            </ListItemIcon>
            <ListItemText primary="Send feedback" />
          </ListItemButton>
          <NavRowButton row={PREFERENCES} view={view} onSelect={onSelect} />
        </List>
        {/* …and directly beneath it, the AMBIENT update affordance (Task #60):
            a gold "Restart to update" chip when a build is downloaded and
            staged, otherwise a muted "checked 2h ago" line. Never a nag —
            ignoring it just means apply-on-quit does the work silently. */}
        <UpdateChip />
      </Box>
    </Drawer>
  )
}
