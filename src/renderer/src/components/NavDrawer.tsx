import type { JSX } from 'react'
import { Box, Chip, Divider, Drawer, List, ListItemButton, ListItemIcon, ListItemText } from '@mui/material'
import SettingsIcon from '@mui/icons-material/Settings'
import ShieldMoonIcon from '@mui/icons-material/ShieldMoon'
import BarChartIcon from '@mui/icons-material/BarChart'
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong'
import TrendingUpIcon from '@mui/icons-material/TrendingUp'
import EmojiEventsIcon from '@mui/icons-material/EmojiEvents'
import NotificationsActiveIcon from '@mui/icons-material/NotificationsActive'
import ChatIcon from '@mui/icons-material/Chat'
import TimerIcon from '@mui/icons-material/Timer'
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh'
import PetsIcon from '@mui/icons-material/Pets'
import MapIcon from '@mui/icons-material/Map'
import SpaceDashboardIcon from '@mui/icons-material/SpaceDashboard'
import CheckroomIcon from '@mui/icons-material/Checkroom'
import FeedbackIcon from '@mui/icons-material/Feedback'
// Dev-only, and its import goes with it: MUI's icon packages declare `sideEffects: false`, so
// an icon whose only use sits inside a `false &&` branch is tree-shaken out with the branch.
import RuleFolderIcon from '@mui/icons-material/RuleFolder'
import UpdateChip from './UpdateChip'
import { OWNER_TOOLS } from '../devFlags'
import type { PrefsRouting } from '../appRouting'
import { GEAR_AREA_VIEWS, VIEW_LABELS, loadGearTab, type View } from '../appViews'

export const DRAWER_WIDTH = 220

/** A row is a view + an icon. The LABEL is not a field: it comes from `VIEW_LABELS`, the one
 *  place a tab is named, because a drill's Back button now says those names too (navOrigin.ts). */
interface NavRow {
  view: View
  icon: JSX.Element
  /** trailing state chip, when a row has one to state */
  badge?: JSX.Element
  /**
   * ONE ROW, SEVERAL VIEWS (JOS-324). A row whose destination is an AREA rather than a single
   * view lists every view drawn inside it here, and reads `selected` while ANY of them is up —
   * so the drawer keeps agreeing with the screen when the in-area tab bar moves you sideways.
   * Absent ⇒ the ordinary rule, and the ordinary rule is still the one nearly every row follows.
   */
  area?: readonly View[]
  /**
   * Which view the row OPENS, when that is not simply `view`. The gear row opens the area at the
   * tab you last stood on (appViews.ts `loadGearTab`) — a function rather than a value because
   * that answer is read from localStorage at CLICK time, not at module load.
   */
  opens?: () => View
}

/* State, not process: this tab is newer than the rest, and the chip says exactly how much.
 * "beta" replaced "in dev" for the release-hardening pass (owner directive 2026-08-13): Timers,
 * Buffs and Exaltations graduated with no chip at all, and Gear — the youngest tab — wears the
 * one remaining caveat. Since JOS-324 that row is the whole gear AREA, and the chip stays on it:
 * two of the four tabs behind it are younger than the chip was, and one of them is a placeholder.
 * A chip comes OFF by deleting the badge from its row, never by softening the word. */
const BETA = (
  <Chip
    size="small"
    label="beta"
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
//
// AND ONE ROW IS NOT ONE VIEW ANY MORE (JOS-324, owner ruling 2026-08-13). The drawer's old law —
// exactly one row per view, no exceptions — held right up until three of the rows turned out to be
// three faces of a single question: what should I be wearing (Gear), what am I farming for
// (Exaltations) and what am I wearing right now (the dev-only Character sheet). Two of them sat
// consecutively here and the third hung off the bottom behind a flag, and nothing in a vertical
// list said any of them had anything to do with the others. They are now ONE row — Gear — over an
// in-area tab bar (components/GearAreaTabs.tsx) that also carries the fourth face the list had no
// room to grow, a Wish list. The row reads `selected` while any of the four is on screen, and it
// opens the one you last used. The law that survives is the one that mattered: a row is a
// DESTINATION, and clicking it takes you somewhere real.
const ROWS: NavRow[] = [
  { view: 'overview', icon: <SpaceDashboardIcon /> },
  { view: 'combat', icon: <BarChartIcon /> },
  { view: 'mobs', icon: <PetsIcon /> },
  { view: 'loot', icon: <ReceiptLongIcon /> },
  // THE GEAR AREA follows Loot for the same reason Loot follows Mobs: it is the far side of one
  // question — what drops it, what did I get, and then what should I wear, farm for and want. It
  // reads the same committed corpus and links back into the same Loot drill-down. The row keeps
  // Gear's icon, Gear's testid (`nav-gear`) and Gear's beta chip; the tabs behind it are named by
  // `VIEW_LABELS`, the one place any of this app's tabs is named.
  {
    view: 'gear',
    icon: <CheckroomIcon />,
    badge: BETA,
    area: GEAR_AREA_VIEWS,
    opens: loadGearTab
  },
  { view: 'maps', icon: <MapIcon /> },
  { view: 'bosses', icon: <EmojiEventsIcon /> },
  { view: 'posky', icon: <ShieldMoonIcon /> },
  { view: 'alerts', icon: <NotificationsActiveIcon /> },
  // Chat sits beside Alerts: both are the log's WORDS rather than its numbers — one you subscribe
  // to as rules, the other you read as a feed.
  { view: 'chat', icon: <ChatIcon /> },
  { view: 'leveling', icon: <TrendingUpIcon /> },
  { view: 'buffs', icon: <AutoFixHighIcon /> },
  // Respawn clocks (JOS-194) sit beside Buffs because both tabs are the same shape of answer —
  // a list of things counting down — and a player checking one is usually checking the other.
  { view: 'timers', icon: <TimerIcon /> }
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
      selected={row.area ? row.area.includes(view) : view === row.view}
      onClick={() => onSelect(row.opens ? row.opens() : row.view)}
    >
      <ListItemIcon>{row.icon}</ListItemIcon>
      <ListItemText primary={VIEW_LABELS[row.view]} />
      {row.badge}
    </ListItemButton>
  )
}

/**
 * The permanent left nav: one row per destination — usually a view, and since JOS-324 once an
 * AREA of four (see `ROWS`) — with Preferences bottom-aligned and the ambient update chip beneath
 * it.
 *
 * Frameless: the drawer is a normal in-flow child (no fixed OS bar above it), so it fills
 * the space under the title bar — `position: relative` + `height: 100%` keeps it inside
 * the flex row.
 */
export default function NavDrawer({
  view,
  onSelect,
  onSendFeedback,
  prefs
}: {
  view: View
  onSelect: (v: View) => void
  /** Opens the feedback DIALOG (Task #65). Feedback is not a view — appViews.ts is untouched —
   *  so this row carries a callback instead of a `View`, and never shows a selected state. */
  onSendFeedback: () => void
  /** The Preferences SECTION router (JOS-254), for the patch-notes icon beside the version
   *  number in the chip below. A section is not a view, so it cannot travel through `onSelect`
   *  — and the drawer names its own destination the way `BottomStrips` does in App.tsx rather
   *  than taking one opaque callback per section a future row might want. */
  prefs: PrefsRouting
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
        {/* UNRELEASED (JOS-45) USED TO HAVE A ROW HERE, and JOS-324 moved it INTO the gear area:
            the character sheet is now the area's last TAB, gated by the same `UNRELEASED` flag in
            the same way (appViews.ts drops `character` from `KNOWN_VIEWS` in a build without it,
            and `GEAR_AREA_VIEWS` is derived from that list, so the tab is absent from the bar and
            the view is absent from the bundle). The gate itself is untouched and still measured —
            `tests/e2e/character-sheet.e2e.mts` now asserts the TAB is absent in a production-shaped
            build, which is a stronger reading than the old row check because the bar it looks at is
            demonstrably mounted at the time. JOS-327 graduates it by deleting the flag. */}
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
            ignoring it just means apply-on-quit does the work silently.
            That muted line is also where the app states the version you are
            running, so it carries the patch-notes icon (JOS-254). */}
        <UpdateChip onWhatsNew={() => prefs.openSection('whatsnew')} />
      </Box>
    </Drawer>
  )
}
