// PreferencesView — the app's single settings surface (Task #55).
//
// Replaces the old SettingsDialog (EQ install folder) and the drawer's update-channel
// selector: everything app-level lives here, reached from the drawer's bottom-aligned
// "Preferences" item, the title-bar gear, and the fresh-machine empty state.
//
// Layout: a [section rail | content] split, where the rail is a TRUE SWITCHER — one
// section is mounted at a time. (It was originally a scroll-spy page: every section
// rendered at once and the rail called scrollIntoView. Inside the app's overflow:auto
// content area the scroll barely moved and `active` never followed, so the rail read
// as dead and the tab as one endless column. That machinery is gone.)
//
// A DEEP LINK LANDS VISIBLY. `section` switches the rail silently, which is the wrong
// ending for a sentence the user clicked somewhere else ("Set up in Preferences", the
// telemetry notice's details link): the page arrives and nothing says which of these cards
// was the answer. The landed section's cards PULSE on arrival and settle — that lives in
// ./PrefSectionBlock.tsx, together with the card it decorates.
//
// SEARCH IS AN EXPLICIT MODE, not the default rendering. The field sits at the top of
// the content column so it lines up with the cards it filters; it echoes instantly from
// local state and filters a DEFERRED copy (AGENTS.md search pattern). While the query is
// non-empty the content column shows matches from EVERY section, each still under its
// section overline so a hit always carries its context; section labels match too, so
// typing "updates" pulls that whole section in. The rail keeps listing every section,
// dims the ones with no matches, and clicking any row exits search mode back to that
// section.
//
// Sections:
//   Game     — EverQuest install-folder discovery/override (effective path + how it
//             resolved + a folder picker + character-log validation). Lives in
//             ./EqFolderSetting.tsx, like Updates does — this file only names it.
//   Appearance — how big things are drawn and how see-through the floating windows are (JOS-123,
//             JOS-405, JOS-407, named and reshaped by JOS-408). TWO items: `In-app text size`, the
//             main window's zoom as an A− / A+ over the five-stop ladder, applied on the press; and
//             `Overlays`, ONE card carrying a single `Independent per overlay` switch and then
//             EITHER two shared steppers (text size, transparency) OR the twelve per-overlay rows —
//             never both, because a control that is on screen while it governs nothing is the
//             pattern the owner's 2026-08-17 review threw out. Second in the rail on purpose. Lives
//             in ./TextSizeSetting.tsx (descriptor and the in-app card) plus
//             ./OverlaysAppearanceSetting.tsx; the section id is still `textsize`, because it is
//             what the rail testid, the deep link and the e2e steps address it by. The steppers and
//             sliders on the overlays themselves are unchanged and write the same values — this is
//             where a player who pinned their meters can reach them at all.
//   Combat   — the meters' two shaping choices: WHOSE damage they show (You / Group / Everyone,
//             default Everyone since JOS-229 — JOS-115 moved it here off every combat surface,
//             JOS-229 changed which way it opens) and where the
//             pet's damage sits. Lives in ./CombatSection.tsx, descriptor and all.
//   Overlays — when the floating meters get out of the way: hide them while EverQuest isn't
//             running (on by default) and/or while it isn't the window you're in (off).
//             Lives in ./OverlayAutoHideSetting.tsx. Plus the celebration toast's controls — and
//             the opt-in drag magnetism (JOS-217, ./OverlaySnapSetting.tsx), which is HELD OUT of
//             this release and therefore not built into the section at all (JOS-359).
//   Graphics — the two compatibility switches for a machine whose graphics driver dislikes what
//             this app draws: software rendering (next launch) and solid, non-transparent
//             overlays (next overlay open). Lives in ./GraphicsSetting.tsx, descriptor and all.
//   Cursor ring — the opt-in white halo that follows the mouse over the EQ window (off by
//             default; size + thickness). Lives in ./CursorRingSetting.tsx.
//   Voice    — spoken alerts (docs/plans/voice-alerts.md §2): engine tier, default voice +
//             preview, speed and volume. There is no master switch — an alert's own output is
//             what makes it speak (schema v8). Lives in ./VoiceSetting.tsx.
//   Profiles — export your GLOBAL settings as a paste-safe share string / file, and import
//             someone else's ADDITIVELY (see src/shared/profiles.ts for the data model).
//   Updates — app version, last-checked time, a manual check, background download
//             progress, and the "Relaunch to update" action when one is waiting.
//             Lives in ./UpdateSetting.tsx; this file only names it in the table.
//   What's new — the browsable release history, newest first, with everything since this
//             install last read it marked new. A reading surface with no controls, which is why
//             it is a section rather than a line under Updates (the same argument Performance
//             and Usage analytics make). Lives in ../whatsnew/WhatsNewPanel.tsx, descriptor and
//             all; the Version row above links straight to it.
//   Usage analytics — the anonymous-counts switch, the rotatable id, and the payload
//             viewer that makes the privacy claim checkable. ./TelemetrySetting.tsx.
//   Performance — the title-bar CPU/memory HUD switch (off by default) and the read-only
//             breakdown of how long this launch's startup took, phase by phase.
//             Lives in ./PerfSetting.tsx.
//   Feedback — the second entry point into the feedback DIALOG (the first is the nav
//             drawer's footer). Feedback is not a view, so this section only opens it.
//   Thanks   — whose pictures these are (JOS-198). The app SHIPS ~3.75 MB of item icons and boss
//             portraits copied from two volunteer-run wikis; this is where it says so, links
//             them, and states the consequence a user cares about (they are on your machine, and
//             drawing them asks nobody for anything). Lives in ./ThanksSetting.tsx, descriptor
//             and all. Last in the rail on purpose — see the table.

import { type JSX, useCallback, useDeferredValue, useMemo, useState } from 'react'
import { Box, List, ListItemButton, ListItemText, TextField, Typography } from '@mui/material'
import SearchIcon from '@mui/icons-material/Search'
import SportsEsportsIcon from '@mui/icons-material/SportsEsports'
import SystemUpdateAltIcon from '@mui/icons-material/SystemUpdateAlt'
import RecordVoiceOverIcon from '@mui/icons-material/RecordVoiceOver'
import IosShareIcon from '@mui/icons-material/IosShare'
import FeedbackIcon from '@mui/icons-material/Feedback'
import PrivacyTipIcon from '@mui/icons-material/PrivacyTip'
import LayersIcon from '@mui/icons-material/Layers'
import { ExportSettingsSetting, ImportSettingsSetting } from '../profiles/ProfileSharing'
import { ClassComboSetting } from '../profiles/ClassComboPanel'
import { UpdateSetting, VersionSetting, useUpdateStatus } from './UpdateSetting'
import type { UpdateStatus } from '@shared/types'
import { EqFolderSetting } from './EqFolderSetting'
// Combat: whose damage the meters show (JOS-115) + where the pet's sits. Its own file with its own
// descriptor, same ceiling and same answer as PerfSetting and GraphicsSetting.
import { combatSection } from './CombatSection'
import { FeedbackSetting, type OpenFeedback } from './FeedbackSetting'
import { VoiceSetting } from './VoiceSetting'
import { OverlayAutoHideSetting } from './OverlayAutoHideSetting'
import { OverlaySnapSetting } from './OverlaySnapSetting'
// The release hold this card is behind (JOS-359). Imported for the FLAG, not for geometry.
import { SNAP_RELEASE_HOLD } from '@shared/overlaySnap'
import { ToastSetting } from './ToastSetting'
import { AlertBannerSetting } from './AlertBannerSetting'
import { ConCardSetting } from './ConCardSetting'
// Cursor ring: another descriptor that lives beside its own card, same ceiling, same answer.
import { cursorRingSection } from './CursorRingSetting'
import { TelemetrySetting } from './TelemetrySetting'
// Performance is the one section whose DESCRIPTOR lives with its card rather than here: this
// file sits at the 400-code-line factoring ceiling, and the section's own file is the honest
// place for the label, icon and search keywords that name it. See ./PerfSetting.tsx.
import { perfSection } from './PerfSetting'
// Same arrangement, same reason: the two graphics-compatibility switches name their own section
// beside the card that renders them. See ./GraphicsSetting.tsx.
import { graphicsSection } from './GraphicsSetting'
// Same arrangement (JOS-140): the buff externals allowlist names its own section beside the card
// that renders it. See ./BuffTrustSetting.tsx.
import { buffTrustSection } from './BuffTrustSetting'
// Same arrangement again (JOS-123): the Appearance section names itself beside the card that
// renders its first item. See ./TextSizeSetting.tsx.
import { appearanceSection } from './TextSizeSetting'
// Same arrangement again (JOS-139): what the X does — the app keeps running in the tray, or it
// quits — names its own section beside the card that renders it. See ./CloseToTraySetting.tsx.
import { windowSection } from './CloseToTraySetting'
// Same arrangement again (JOS-73): the release-notes panel names its own section beside the card
// that renders it. See features/whatsnew/WhatsNewPanel.tsx for why the notes are a SECTION.
import { whatsNewSection } from '../whatsnew/WhatsNewPanel'
// Same arrangement again (JOS-198): the credit for the bundled wiki art names its own section
// beside the card that renders it. See ./ThanksSetting.tsx for why it is a section at all.
import { thanksSection } from './ThanksSetting'
// The section CARD and the arrival pulse live together in their own file — same ceiling, same
// answer as PerfSetting's descriptor: split, don't widen the threshold.
import PrefSectionBlock, { FILL_COLUMN_SX, FILL_ROOT_SX, FILL_ROW_SX, paneFills, useLandedSection } from './PrefSectionBlock'
// THE HYDRATION GATE (JOS-340) — one batched read of everything this pane paints from main, and
// nothing renders until it lands. Read that file's header before touching any card's state.
import { PrefsGate, usePrefsSeed } from './prefsHydration'
import { normalizeQuery } from '../../lib/search'

// ------------------------------------------------------------------- the view

export interface PrefItem {
  id: string
  label: string
  /** Extra searchable words that aren't shown in the label. */
  keywords?: string
  content: JSX.Element
}

/** Exported so a section whose descriptor lives with its own card (./PerfSetting.tsx) names the
 *  same shape. TYPE-ONLY in both directions, so the import cycle it forms is erased at compile
 *  time and no module ever waits on the other. */
export interface PrefSection {
  id: string
  label: string
  icon: JSX.Element
  items: PrefItem[]
  /**
   * This section CLAIMS the pane's remaining height instead of sizing to its content (JOS-76).
   *
   * One section is a reading surface rather than a stack of controls (What's new), and its own
   * scroll box belongs at the bottom of the window rather than 420px down it. Opt-in, because the
   * chain of `flexGrow`/`minHeight:0` it turns on would stretch every OTHER section's cards too —
   * see ./PrefSectionBlock.tsx. Honoured only outside search mode, where exactly one section is
   * on screen and "the remaining height" is a thing that exists.
   */
  fill?: boolean
}

const RAIL_WIDTH = 168

/**
 * Spoken alerts (docs/plans/voice-alerts.md §2). Its own factory rather than a literal inside
 * `buildSections` only because that function is at the 100-code-line ceiling; nothing about
 * this section is special, and it depends on none of buildSections' inputs.
 */
function voiceSection(): PrefSection {
  return {
    id: 'voice',
    label: 'Voice',
    icon: <RecordVoiceOverIcon fontSize="small" />,
    items: [
      {
        id: 'voice-alerts',
        label: 'Spoken alerts',
        keywords:
          'voice speech speak tts talk say spoken narrate announce engine kokoro sapi rate speed volume alert sound',
        content: <VoiceSetting />
      }
    ]
  }
}

/**
 * The drag magnetism card (JOS-217), or nothing at all while the feature is HELD OUT of the
 * release (JOS-359 — `SNAP_RELEASE_HOLD` carries the ruling and is the one line that lifts it).
 *
 * A card whose switch the store would ignore is worse than no card, which is why the hold reaches
 * up here and not only into the normalizer: the item is not built, so it is not in the pane, not
 * in the search index, and not a control a user can be told is broken.
 */
function snapItems(): PrefItem[] {
  if (SNAP_RELEASE_HOLD) return []
  return [
    {
      id: 'overlay-snap',
      label: 'Snap overlays while dragging',
      keywords:
        'snap snapping magnet align alignment grid edge edges side abut stack line up lined tidy position drag move overlay overlays meter meters screen monitor match matching sizes equal',
      content: <OverlaySnapSetting />
    }
  ]
}

/**
 * The floating overlays' own rules: when they get out of the way, whether a drag snaps them into
 * line (JOS-217, held out of this release — see `snapItems`), and the celebration toast. Its own
 * factory for the same reason `voiceSection` is one — `buildSections` sits against the
 * 100-code-line ceiling — and, like that one, it depends on none of buildSections' inputs.
 */
function overlaysSection(): PrefSection {
  return {
    id: 'overlays',
    label: 'Overlays',
    icon: <LayersIcon fontSize="small" />,
    items: [
      {
        id: 'overlay-autohide',
        label: 'Hide overlays automatically',
        keywords:
          'overlay overlays meter meters hide auto autohide show running focus focused unfocused alt tab background desktop game closed floating',
        content: <OverlayAutoHideSetting />
      },
      ...snapItems(),
      {
        id: 'toast',
        label: 'Celebration toasts',
        keywords:
          'toast toasts celebrate celebration boss kill raid target defeated quest complete sky plane of sky notification popup card sound silent position move top',
        content: <ToastSetting />
      },
      {
        id: 'alert-banner',
        label: 'Alert banner',
        keywords:
          'alert alerts banner on screen onscreen text overlay big large popup message discord hear miss show display warning countdown colour color position move lines hold seconds',
        content: <AlertBannerSetting />
      },
      {
        id: 'con-card',
        label: 'Mob card on con',
        // Written for the person who saw a card appear over their game and came here to find out
        // what it was: this kind ships ON, so the search terms have to include what they SAW (a
        // card, a popup, resists, drops) as well as what it is called.
        keywords:
          'con consider mob card popup tooltip creature resists resist chips drops loot level zone respawn faction overlay top centre center hide auto hide seconds close',
        content: <ConCardSetting />
      }
    ]
  }
}

/**
 * Usage analytics (docs/plans/usage-analytics.md). Its own factory for the same reason the two
 * above are — `buildSections` sits against the 100-code-line ceiling.
 *
 * It is a SECTION rather than a line inside another one because of what it contains: the switch
 * is one control, but the payload viewer beside it is the whole privacy claim made checkable,
 * and that does not belong tucked under "Updates".
 */
function analyticsSection(): PrefSection {
  return {
    id: 'analytics',
    label: 'Usage analytics',
    icon: <PrivacyTipIcon fontSize="small" />,
    items: [
      {
        id: 'telemetry',
        label: 'Anonymous usage counts',
        keywords:
          'telemetry analytics usage privacy tracking opt out optout data collect anonymous id rotate payload send stats metrics',
        content: <TelemetrySetting />
      }
    ]
  }
}

/** What `buildSections` needs from the view. An OBJECT rather than four positional parameters:
 *  the repo's `max-params` ceiling is 4 and the fourth argument was the one that would have hit
 *  it, but the real reason is that "version" and "the way to the release notes" are two halves of
 *  one row and read better named. */
interface SectionInputs {
  version: string
  status: UpdateStatus
  onSendFeedback: OpenFeedback
  /** Rail switch to the What's new section — the Version row's link (JOS-73). */
  onWhatsNew: () => void
}

/** The whole settings table, in render order. Rebuilt only when its inputs change. */
function buildSections({ version, status, onSendFeedback, onWhatsNew }: SectionInputs): PrefSection[] {
  return [
    {
      id: 'game',
      label: 'Game',
      icon: <SportsEsportsIcon fontSize="small" />,
      items: [
        {
          id: 'eq-folder',
          label: 'EverQuest install folder',
          keywords: 'path directory logs eqlog character detect override install location',
          content: <EqFolderSetting />
        }
      ]
    },
    // SECOND IN THE RAIL, ahead of everything about the game (JOS-123). A person who opens
    // Preferences because they can barely read the app has to find this one, and the rail is
    // itself drawn at the size they are complaining about.
    appearanceSection(),
    combatSection(),
    overlaysSection(),
    // Right after the overlays, because the promise this switch makes is about them: closing the
    // window keeps them running (JOS-139).
    windowSection(),
    graphicsSection(),
    buffTrustSection(),
    cursorRingSection(),
    voiceSection(),
    {
      id: 'profiles',
      label: 'Profiles',
      icon: <IosShareIcon fontSize="small" />,
      items: [
        {
          id: 'export-settings',
          label: 'Export your settings',
          keywords: 'share export copy backup string bundle profile send give clipboard file',
          content: <ExportSettingsSetting />
        },
        {
          id: 'import-settings',
          label: 'Import settings',
          keywords: 'share import paste restore string bundle profile receive add merge file',
          content: <ImportSettingsSetting />
        },
        {
          id: 'class-combo',
          // JOS-87: "history" was the whole label, and the setting's first job is now the
          // OVERRIDE — a user arrives here because the app named the wrong classes, and the
          // words they search for are the ones they would use about that ("wrong", "fix",
          // "manual", "override"), not the ones the feature is built out of.
          label: 'Your classes (loadout)',
          keywords:
            'class combo loadout classes swap paladin rogue berserker who correction slot ' +
            'override manual set fix wrong incorrect change detect autodetect history',
          content: <ClassComboSetting />
        }
      ]
    },
    {
      id: 'updates',
      label: 'Updates',
      icon: <SystemUpdateAltIcon fontSize="small" />,
      items: [
        {
          id: 'version',
          label: 'Version',
          keywords: 'about build release app version',
          content: <VersionSetting version={version} onWhatsNew={onWhatsNew} />
        },
        {
          id: 'app-updates',
          label: 'App updates',
          keywords: 'update upgrade check relaunch restart install download automatic release',
          content: <UpdateSetting status={status} version={version} />
        }
      ]
    },
    // Directly under Updates, which is where a person who just read the version number is
    // standing when they wonder what it changed (JOS-73).
    whatsNewSection(),
    analyticsSection(),
    perfSection(),
    {
      id: 'feedback',
      label: 'Feedback',
      icon: <FeedbackIcon fontSize="small" />,
      items: [
        {
          id: 'send-feedback',
          label: 'Send feedback',
          keywords: 'feedback bug report problem crash issue feature request idea suggest contact support log',
          content: <FeedbackSetting onSend={onSendFeedback} />
        }
      ]
    },
    // LAST in the rail, and that is where a credit belongs: it is the thing you go looking for
    // rather than the thing you land on. Never above the controls a user opened Preferences to
    // change (JOS-198).
    thanksSection()
  ]
}

// Lowercased search keys, recomputed only when the section set changes — the
// per-keystroke filter is then a plain substring test.
function sectionKeys(sections: PrefSection[]): Record<string, string> {
  const m: Record<string, string> = {}
  for (const s of sections) {
    for (const i of s.items) m[`${s.id}/${i.id}`] = `${i.label} ${i.keywords ?? ''}`.toLowerCase()
  }
  return m
}

function filterSections(
  sections: PrefSection[],
  keys: Record<string, string>,
  q: string
): PrefSection[] {
  if (!q) return sections
  return sections
    .map((s) => {
      // A section-label match keeps the whole section (typing "updates" is a jump).
      if (s.label.toLowerCase().includes(q)) return s
      return { ...s, items: s.items.filter((i) => keys[`${s.id}/${i.id}`]?.includes(q)) }
    })
    .filter((s) => s.items.length > 0)
}

/**
 * Left rail: one row per section, ALWAYS all of them — it is the switcher, so it can
 * never shrink out from under the user's pointer. `active` is null while searching
 * (there is no single active section in that mode, so nothing is highlighted), and
 * `unmatched` holds the sections the current query found nothing in — those rows dim
 * to say so. They stay clickable on purpose: a query that matches nothing would
 * otherwise disable every row and strand the user in search mode.
 */
function SectionRail({
  sections,
  active,
  unmatched,
  onPick
}: {
  sections: PrefSection[]
  active: string | null
  unmatched: ReadonlySet<string>
  onPick: (id: string) => void
}): JSX.Element {
  return (
    // The rail scrolls WITHIN the split rather than growing the page: thirteen rows (JOS-198
    // added Thanks) outgrow a short window, and a rail that stretches the document makes the
    // whole page scroll — the exact thing the whats-new pane's "the LIST scrolls, never the
    // page" contract forbids. minHeight: 0 is what lets a flex child shrink below its content.
    <List dense disablePadding sx={{ width: RAIL_WIDTH, flexShrink: 0, minHeight: 0, overflowY: 'auto' }}>
      {sections.map((s) => {
        const dim = unmatched.has(s.id)
        return (
          <ListItemButton
            key={s.id}
            dense
            data-testid={`prefs-rail-${s.id}`}
            selected={active === s.id}
            aria-disabled={dim}
            onClick={() => onPick(s.id)}
            sx={{ borderRadius: 1, gap: 1, opacity: dim ? 0.38 : 1 }}
          >
            <Box sx={{ display: 'flex', color: 'text.secondary' }}>{s.icon}</Box>
            <ListItemText slotProps={{ primary: { variant: 'body2' } }} primary={s.label} />
          </ListItemButton>
        )
      })}
    </List>
  )
}

/** The search field, sized to the content column so it aligns with the cards it filters. */
function PrefSearch({
  query,
  onQuery
}: {
  query: string
  onQuery: (q: string) => void
}): JSX.Element {
  return (
    <TextField
      size="small"
      fullWidth
      data-testid="prefs-search"
      placeholder="Search preferences…"
      value={query}
      onChange={(e) => onQuery(e.target.value)}
      slotProps={{
        input: {
          startAdornment: <SearchIcon fontSize="small" sx={{ mr: 0.75, color: 'text.secondary' }} />
        }
      }}
    />
  )
}

/**
 * The pane, INSIDE the hydration gate — every card below this point may assume its value is
 * already known (JOS-340). Split from the exported component so the gate can be the thing that
 * decides whether this function runs at all: hooks cannot be conditional, and `usePrefsSeed` has
 * to be able to say "there is a snapshot" without a null check in thirteen places.
 */
function PreferencesPane({
  onSendFeedback,
  section
}: {
  onSendFeedback: OpenFeedback
  section: string | null
}): JSX.Element {
  const [query, setQuery] = useState('')
  const deferred = useDeferredValue(query)
  const [active, setActive] = useState(section ?? 'game')
  const landed = useLandedSection(section)
  // Both out of the gate's snapshot now. The version used to start as the EMPTY STRING and fill
  // in, so the Updates section opened on a Version row with no version on it.
  const version = usePrefsSeed().version
  const status = useUpdateStatus()

  // A rail click is always an exit from search mode into that one section.
  const pick = useCallback((id: string): void => {
    setQuery('')
    setActive(id)
  }, [])

  // The Version row's "What's new" link (JOS-73) IS a rail click, so it goes through the same
  // door rather than inventing a second way to switch sections. Memoized because it is an input
  // to the section table below.
  const openWhatsNew = useCallback(() => {
    pick('whatsnew')
  }, [pick])

  const sections = useMemo(
    () => buildSections({ version, status, onSendFeedback, onWhatsNew: openWhatsNew }),
    [version, status, onSendFeedback, openWhatsNew]
  )
  const keys = useMemo(() => sectionKeys(sections), [sections])
  const q = normalizeQuery(deferred)
  const searching = q !== ''
  const matches = useMemo(() => filterSections(sections, keys, q), [sections, keys, q])

  // Rail rows to dim: only meaningful while searching, empty otherwise.
  const unmatched = useMemo(() => {
    if (!searching) return new Set<string>()
    const hit = new Set(matches.map((s) => s.id))
    return new Set(sections.filter((s) => !hit.has(s.id)).map((s) => s.id))
  }, [searching, matches, sections])

  const shown = searching ? matches : sections.filter((s) => s.id === active)
  const fills = paneFills(searching, shown)

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, ...(fills ? FILL_ROOT_SX : {}) }}>
      <Typography variant="h6" sx={{ fontWeight: 700 }}>
        Preferences
      </Typography>

      <Box sx={{ display: 'flex', gap: 3, alignItems: 'flex-start', ...(fills ? FILL_ROW_SX : {}) }}>
        <SectionRail
          sections={sections}
          active={searching ? null : active}
          unmatched={unmatched}
          onPick={pick}
        />

        <Box
          sx={{
            flexGrow: 1,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 2.5,
            ...(fills ? FILL_COLUMN_SX : {})
          }}
        >
          <PrefSearch query={query} onQuery={setQuery} />

          {searching && matches.length === 0 && (
            <Typography variant="body2" color="text.secondary">
              No preferences match “{query.trim()}”.
            </Typography>
          )}
          {shown.map((s) => (
            <PrefSectionBlock key={s.id} section={s} landed={s.id === landed} />
          ))}
        </Box>
      </Box>
    </Box>
  )
}

/**
 * THE PANE, GATED (JOS-340).
 *
 * A control never paints a value it does not know, and every card in here reads a store that
 * lives in MAIN over a promise-only bridge — so the honest arrangement is that NOTHING in the
 * pane renders until one batched read has landed. See ./prefsHydration.tsx for why this is a
 * gate rather than a synchronous preload snapshot, and why the wait is invisible after the first
 * time: the snapshot is cached for the renderer's life, so every later rail click and every trip
 * back to this tab paints the right value on its first frame with no wait at all.
 *
 * The gate wraps the WHOLE pane, heading and rail included, rather than only the content column.
 * A rail that appeared a frame before its cards would be a second, smaller version of the same
 * jump — and there is nothing to look at in an empty pane anyway.
 */
export default function PreferencesView({
  onSendFeedback,
  section = null
}: {
  onSendFeedback: OpenFeedback
  /** A deep link's landing section, or null for the usual one. App KEYS this component on it,
   *  so an arriving link paints its section on the first frame and needs no effect here. */
  section?: string | null
}): JSX.Element {
  return (
    <PrefsGate>
      <PreferencesPane onSendFeedback={onSendFeedback} section={section} />
    </PrefsGate>
  )
}
