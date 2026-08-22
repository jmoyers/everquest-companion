import { type JSX, useEffect, useRef, useState } from 'react'
import { Box, Checkbox, Chip, Divider, ListItemText, ListSubheader, Menu, MenuItem, Select, Typography } from '@mui/material'
import CircleIcon from '@mui/icons-material/Circle'
import MinimizeIcon from '@mui/icons-material/Remove'
import CropSquareIcon from '@mui/icons-material/CropSquare'
import FilterNoneIcon from '@mui/icons-material/FilterNone'
import CloseIcon from '@mui/icons-material/Close'
import PictureInPictureAltIcon from '@mui/icons-material/PictureInPictureAlt'
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown'
import type { CharacterRef, OverlayKind } from '@shared/types'
import type { CloseToTrayPrefs } from '@shared/closeToTray'
import { OVERLAY_KINDS } from '@shared/types'
// The ONE kind-label map (JOS-405). This menu's wording is what it says, because this menu is
// where a user meets the window in the first place.
import { OVERLAY_KIND_LABEL } from '@shared/overlayLabels'
import { track } from '../lib/telemetry'
import PerfChip from './PerfChip'
import { isDragSurfaceDoubleClick } from './titleBarDrag'

/**
 * Frameless window title bar (Task #23). Replaces BOTH the OS chrome and the old
 * in-app AppBar/Toolbar. It is the app's single top bar:
 *   [brand]  ······(drag)······  [live dot] [character selector]  | min max close
 *
 * The whole bar is a drag region (`-webkit-app-region: drag`) so the user can move
 * the window; every interactive child (the selector, the window buttons) opts back
 * out with `no-drag`. Double-clicking the empty drag region toggles maximize — on
 * Windows the OS gives us that natively for `drag` regions, but we also wire an
 * explicit handler so behavior is deterministic across platforms and covers the
 * brand text.
 */

const BAR_HEIGHT = 40 // px — compact, matches the old `Toolbar variant="dense"`.

function lastPlayed(ms?: number): string {
  if (!ms) return ''
  const secs = Math.max(0, (Date.now() - ms) / 1000)
  if (secs < 90) return 'just now'
  const mins = secs / 60
  if (mins < 90) return `${Math.round(mins)}m ago`
  const hrs = mins / 60
  if (hrs < 36) return `${Math.round(hrs)}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

// A single Discord/VS-Code-style caption button: 46px-wide hover target, icon
// centered, subtle hover fill; the close button hovers red.
function CaptionButton({
  onClick,
  label,
  danger,
  children
}: {
  onClick: () => void
  label: string
  danger?: boolean
  children: React.ReactNode
}): JSX.Element {
  return (
    <Box
      component="button"
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      sx={{
        WebkitAppRegion: 'no-drag',
        width: 46,
        height: BAR_HEIGHT,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        p: 0,
        border: 'none',
        background: 'transparent',
        color: 'text.secondary',
        cursor: 'pointer',
        outline: 'none',
        transition: 'background-color 120ms, color 120ms',
        '& svg': { fontSize: 18 },
        '&:hover': {
          backgroundColor: danger ? 'error.main' : 'rgba(255,255,255,0.08)',
          color: danger ? '#fff' : 'text.primary'
        }
      }}
    >
      {children}
    </Box>
  )
}

/**
 * THE MENU, as a table: `[kind, primary, secondary]` in display order.
 *
 * It was nine hand-written `<MenuItem>`s differing only in those three strings, which is how it
 * crossed the 100-line function cap when JOS-194 added the ninth. The rows below carry the history
 * each one used to carry inline:
 *
 *   fight / overall            Task #52, two kinds in Task #54 — the damage meters.
 *   heal-fight / heal-overall  Task #59 — siblings of the damage pair, same per-kind machinery
 *                              (persisted config, position, lock, drill) and the same fight vs
 *                              zone-session selection semantics.
 *   events                     Task #59 — a NON-meter kind on the same per-kind machinery.
 *   buffs / debuffs            JOS-89, split in two by JOS-119. TWO rows because they are two
 *                              windows, separately enabled and separately placed, so "what is on
 *                              me" and "what is on them" can live in different corners.
 *   xp                         JOS-195 — the progress read.
 *   respawn                    JOS-194 — the respawn clocks, and the window this feature is
 *                              actually read in: the Timers tab is where you choose what to clock.
 *
 *   conCard                    JOS-383 — the card that appears when you `/con` a creature.
 *
 * Every kind from `buffs` through `respawn` ships DEFAULT OFF and this menu is the ONLY way to meet
 * it; `conCard` is the exception in both directions — it ships ON, so this row is how you turn it
 * OFF without going through Preferences. The 'toast' kind is deliberately absent: it is a notifier,
 * not a window a user places.
 */
// THE NAMES COME FROM shared/overlayLabels.ts (JOS-405); only the DESCRIPTIONS live here. There
// used to be two label maps in this repo — this menu and shareMerge.ts — and they disagreed about
// two windows, so an imported settings bundle offered to change something whose name appeared
// nowhere in the menu you open to find it. The descriptions stay because they are this menu's own
// job: a row here has to say what the window is FOR, and nowhere else needs that sentence.
const OVERLAY_MENU_ROWS: readonly (readonly [OverlayKind, string])[] = [
  ['fight', 'Current fight + fight selector'],
  ['overall', 'Zone total + zone selector'],
  ['heal-fight', 'Healing + absorption, current fight'],
  ['heal-overall', 'Healing + absorption, zone total'],
  ['events', 'Alerts, notable loot, quest completions'],
  ['buffs', 'Buffs you have running, with timers'],
  ['debuffs', 'Debuffs and mez you are holding, per target'],
  ['xp', 'XP per hour, next level, motes per hour'],
  ['respawn', 'Countdowns started by your own kills'],
  // JOS-383, and the first row here for a kind that ships ON. It is in this menu on the owner's
  // instruction (2026-08-16, the JOS-139 mirroring precedent): a window that appears by itself
  // needs its off switch within reach of the place you are already looking when you want it gone.
  // The 'toast' kind stays absent for its own stated reason — nobody places a celebration strip.
  ['conCard', 'Resists, drops and level when you con']
]

/**
 * The close-to-tray preference as this bar sees it: read once at mount, then kept current by main's
 * push - which fires for the Preferences switch, the tray icon's checkbox, the popover's buttons,
 * AND this row's own write (main echoes the renderer's set back to it, so the switch in Preferences
 * and this checkbox move together without either knowing the other exists). `null` until the first
 * read answers, so the row can render nothing it does not know (the JOS-340 law, in menu form).
 */
function useCloseToTrayMirror(): [CloseToTrayPrefs | null, (patch: Partial<CloseToTrayPrefs>) => void] {
  const [prefs, setPrefs] = useState<CloseToTrayPrefs | null>(null)
  useEffect(() => {
    let alive = true
    void window.eq.getCloseToTray().then((p) => {
      if (alive) setPrefs(p)
    })
    const off = window.eq.onCloseToTray(setPrefs)
    return () => {
      alive = false
      off()
    }
  }, [])
  const update = (patch: Partial<CloseToTrayPrefs>): void => {
    void window.eq.setCloseToTray(patch).then(setPrefs)
  }
  return [prefs, update]
}

/**
 * Floating DPS overlay menu (Task #52; two kinds in Task #54). A compact menu toggles the
 * overlay windows independently; the button is active-tinted when ANY is open so the user
 * knows an overlay is live even off-screen / behind the game. The menu anchor is local
 * state — nothing outside this button cares whether the menu is showing.
 */
function OverlayMenu({ overlayState }: { overlayState: Record<OverlayKind, boolean> }): JSX.Element {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const anyOverlayOpen = Object.values(overlayState).some(Boolean)
  const [tray, setTray] = useCloseToTrayMirror()

  /**
   * Toggle one overlay and record WHICH and WHETHER (usage-analytics §2 `overlayToggle`) — the
   * "which meters do people actually keep open" signal. The tracked `open` is main's ANSWER,
   * never the optimistic guess: the toggle IPC resolves to the resulting state, so a toggle
   * that failed to open a window cannot be counted as one that did.
   */
  const toggle = (kind: OverlayKind): void => {
    void window.eq.toggleOverlay(kind).then((open) => {
      track({ t: 'overlayToggle', kind, open })
    })
  }

  return (
    <Box data-no-drag sx={{ WebkitAppRegion: 'no-drag', display: 'flex', alignItems: 'center' }}>
      {/* NO POPPER (JOS-143). This is a dropdown TRIGGER — `aria-haspopup`, a caret, and a Menu
          anchored on it — and the tooltip's default placement is `bottom`, i.e. the exact
          rectangle the Menu opens into. A MUI tooltip takes pointer events, so the hover that
          preceded the click laid the explanation over the list being aimed at. The words are a
          native `title` now, beside the `aria-label` that was already carrying the name. */}
      <Box
        component="button"
        type="button"
        ref={btnRef}
        aria-label="Floating DPS overlays"
        title="Floating DPS overlays"
        aria-haspopup="true"
        aria-expanded={anchor != null}
        onClick={() => setAnchor(btnRef.current)}
        sx={{
          WebkitAppRegion: 'no-drag',
          display: 'flex',
          alignItems: 'center',
          gap: 0.25,
          height: 26,
          px: 1,
          borderRadius: 1,
          border: '1px solid',
          borderColor: anyOverlayOpen ? 'primary.main' : 'divider',
          bgcolor: anyOverlayOpen ? 'rgba(217,178,95,0.14)' : 'transparent',
          color: anyOverlayOpen ? 'primary.main' : 'text.secondary',
          cursor: 'pointer',
          outline: 'none',
          transition: 'background-color 120ms, color 120ms, border-color 120ms',
          '& svg': { fontSize: 16 },
          '&:hover': { bgcolor: 'rgba(255,255,255,0.08)', color: 'text.primary' }
        }}
      >
        <PictureInPictureAltIcon />
        <Typography variant="caption" sx={{ fontWeight: 600 }}>
          Overlay
        </Typography>
        <ArrowDropDownIcon />
      </Box>
      <Menu
        anchorEl={anchor}
        open={anchor != null}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        {OVERLAY_MENU_ROWS.map(([kind, secondary]) => (
          <MenuItem dense key={kind} data-testid={`overlay-menu-${kind}`} onClick={() => { toggle(kind) }}>
            <Checkbox size="small" edge="start" checked={overlayState[kind]} tabIndex={-1} disableRipple />
            <ListItemText primary={OVERLAY_KIND_LABEL[kind]} secondary={secondary} />
          </MenuItem>
        ))}
        <Divider />
        {/* THE THIRD MIRROR of "what the X does" (JOS-139; owner, 2026-08-16: "add a mirror to this
            preference in the overlay dropdown menu"). It sits in THIS menu because it is the
            overlays' promise: closing the window keeps them running. Same store, same value as the
            Preferences switch and the tray icon's checkbox - main pushes every change to all three,
            so none of them can be a stale answer. Disabled only until the first read lands, which
            is before anyone can open this menu. */}
        <MenuItem
          dense
          data-testid="overlay-menu-close-to-tray"
          disabled={tray === null}
          onClick={() => {
            if (tray) setTray({ enabled: !tray.enabled })
          }}
        >
          <Checkbox size="small" edge="start" checked={tray?.enabled === true} tabIndex={-1} disableRipple />
          <ListItemText
            primary="Keep running in the tray when the window closes"
            secondary="Overlays stay up; the tray icon brings the window back"
          />
        </MenuItem>
      </Menu>
    </Box>
  )
}

/** The character picker (or a "no log" chip when nothing was discovered). */
function CharacterPicker({
  character,
  characters,
  onSelectCharacter
}: {
  character: CharacterRef | null
  characters: CharacterRef[]
  onSelectCharacter: (logPath: string) => void
}): JSX.Element {
  return (
    <Box data-no-drag sx={{ WebkitAppRegion: 'no-drag', display: 'flex', alignItems: 'center', pr: 1 }}>
      {characters.length > 0 ? (
        <Select
          size="small"
          variant="standard"
          disableUnderline
          value={character?.logPath ?? ''}
          onChange={(e) => onSelectCharacter(e.target.value)}
          sx={{ minWidth: 200, fontSize: 14 }}
          renderValue={(v) => {
            const c = characters.find((x) => x.logPath === v)
            return c ? `${c.name} · ${c.server}` : 'Select character'
          }}
        >
          <ListSubheader>Characters - most recently played</ListSubheader>
          {characters.map((c) => (
            <MenuItem key={c.logPath} value={c.logPath}>
              <Box>
                <Typography variant="body2">
                  {c.name} · {c.server}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  last played {lastPlayed(c.lastPlayed)}
                </Typography>
              </Box>
            </MenuItem>
          ))}
        </Select>
      ) : (
        <Chip size="small" color="warning" label="No log detected" variant="outlined" />
      )}
    </Box>
  )
}

/** Minimize / maximize / close, far right. */
function WindowControls({ maximized }: { maximized: boolean }): JSX.Element {
  return (
    <Box data-no-drag sx={{ WebkitAppRegion: 'no-drag', display: 'flex', alignItems: 'stretch' }}>
      <CaptionButton label="Minimize" onClick={() => window.eq.minimizeWindow()}>
        <MinimizeIcon />
      </CaptionButton>
      <CaptionButton label={maximized ? 'Restore' : 'Maximize'} onClick={() => window.eq.toggleMaximizeWindow()}>
        {maximized ? <FilterNoneIcon sx={{ transform: 'scaleX(-1)' }} /> : <CropSquareIcon />}
      </CaptionButton>
      <CaptionButton label="Close" danger onClick={() => window.eq.closeWindow()}>
        <CloseIcon />
      </CaptionButton>
    </Box>
  )
}

export interface TitleBarProps {
  live: boolean
  character: CharacterRef | null
  characters: CharacterRef[]
  onSelectCharacter: (logPath: string) => void
}

export default function TitleBar({
  live,
  character,
  characters,
  onSelectCharacter
}: TitleBarProps): JSX.Element {
  const [maximized, setMaximized] = useState(false)
  // Per-kind overlay open-state (Task #52; kinds in Task #54/#59): reflected on the compact
  // Overlay menu, kept in sync with pushes so it updates if an overlay closes itself. Seeded
  // from OVERLAY_KINDS so adding a kind needs no edit here.
  const [overlayState, setOverlayState] = useState<Record<OverlayKind, boolean>>(
    () => Object.fromEntries(OVERLAY_KINDS.map((k) => [k, false])) as Record<OverlayKind, boolean>
  )

  useEffect(() => window.eq.onWindowMaximized(setMaximized), [])
  useEffect(() => {
    void window.eq.getOverlayState().then(setOverlayState)
    return window.eq.onOverlayState(({ kind, open }) =>
      setOverlayState((s) => ({ ...s, [kind]: open }))
    )
  }, [])

  // Double-click on the drag region toggles maximize (native-ish behavior). WHICH clicks count is
  // `isDragSurfaceDoubleClick` — read its header before touching this. The short version (JOS-204):
  // this handler sees REACT-tree events, so every portal rendered from this bar (the overlay Menu,
  // the character Select's dropdown, any Popover/Tooltip/Dialog) bubbles into it while sitting
  // under <body> in the DOM, where the old `closest('[data-no-drag]')` guard could never see it.
  // Rapidly checking and unchecking an overlay maximized the window as a result.
  const onDoubleClick = (e: React.MouseEvent): void => {
    if (!isDragSurfaceDoubleClick(e.currentTarget, e.target as Element)) return
    window.eq.toggleMaximizeWindow()
  }

  return (
    <Box
      // The e2e spec asks this element whether the open menu is inside it. That question IS the
      // defect above, so the handle it needs is part of the fix.
      data-testid="title-bar"
      onDoubleClick={onDoubleClick}
      sx={{
        WebkitAppRegion: 'drag',
        flexShrink: 0,
        height: BAR_HEIGHT,
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        pl: 2,
        borderBottom: 1,
        borderColor: 'divider',
        bgcolor: 'background.paper',
        userSelect: 'none'
      }}
    >
      <Typography variant="subtitle2" sx={{ color: 'primary.main', fontWeight: 700, whiteSpace: 'nowrap' }}>
        EQ Legends Companion
      </Typography>

      {/* Drag spacer between brand and the right-hand controls. */}
      <Box sx={{ flexGrow: 1 }} />

      {/* The live dot. It means exactly "a module delta has arrived since the last rebuild" — see
          JOS-432's characterization, which is why it can be dark on a perfectly healthy app whose
          log is simply quiet. The testid is how `log-switch-nudge.e2e.mts` asserts that a switch
          taken from the nudge really did light it on the new character's next line. */}
      {live && <CircleIcon data-testid="live-dot" sx={{ fontSize: 12, color: 'success.main' }} />}

      {/* The performance HUD (docs/plans/perf-profiling.md P3). Renders NOTHING at all unless
          the user turned it on in Preferences → Performance — no placeholder, no reserved slot,
          and no cost: main creates no timer and pushes no sample while it is off. */}
      <PerfChip />

      <OverlayMenu overlayState={overlayState} />

      {/* Interactive controls opt out of the drag region. */}
      <CharacterPicker
        character={character}
        characters={characters}
        onSelectCharacter={onSelectCharacter}
      />

      <WindowControls maximized={maximized} />
    </Box>
  )
}
