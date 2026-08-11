// planner/PlannerView.tsx — the EXALTATIONS shell: which set you are editing, for which classes,
// in which mode (design §5.1).
//
// THE TAB IS CALLED EXALTATIONS (owner, 2026-08-06, JOS-42). "Planner" named what the surface does
// for us; "Exaltations" names the game system a player came here about. The rename is a LABEL —
// the `planner` view id, its route, its `eq.planner.*` keys and every `planner-*` testid are
// unchanged, because renaming those would be a refactor with no user on the other end of it.
//
// A SET IS A LOADOUT'S SHOPPING LIST. You keep several — the trio you run now, the trio you are
// building toward — so the toolbar leads with the set switcher, and each set carries its OWN
// target classes (D5). A brand-new set defaults to the combo the app has INFERRED for this
// character, because that is what you are almost certainly planning for; when nothing is inferred
// yet it starts EMPTY rather than guessing a trio (law 1), and an empty trio simply means "no
// class filter" everywhere downstream.
//
// ONE NOWRAP TOOLBAR ROW (the flexWrap law): controls never shrink below their own floor — the
// class filter's is 240px, the mode toggle's is its buttons — and the one thing carrying
// world-supplied text, the set names, is the group allowed to scroll.
//
// THREE MODES, ONE SET: Effects picks what you want, Inventory shows where it all goes over the
// gear you are actually wearing (V7 — it was called Board while it started empty), Farm turns
// what is missing into a route. All three read the SAME selected plan, and the progress join is
// mounted ONCE here and handed to Inventory and Farm — two mounts would subscribe to the inventory,
// the loot module and the observed tiers twice over to compute the identical answer.

import { type JSX, useEffect, useMemo, useState } from 'react'
import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Menu,
  MenuItem,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography
} from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import MoreVertIcon from '@mui/icons-material/MoreVert'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import HelpOutlineIcon from '@mui/icons-material/HelpOutline'
import { CLASS_ABBRS, MAX_COMBO_SLOTS, resolvedClasses, type ClassAbbr } from '@shared/classCombo'
import type { ExaltPlan } from '@shared/planner/types'
import { useComboSnap } from '../profiles/ClassComboData'
import ChipMultiSelect from '../../components/ChipMultiSelect'
import EffectBrowser from './EffectBrowser'
import FarmList from './FarmList'
import PlanBoard from './PlanBoard'
import { boundClasses, detectedOffer } from './plannerClasses'
import type { BrowsePreset } from './plannerPreset'
import RulesExplainer, { useExplainer } from './RulesExplainer'
import { usePlannerProgress, type PlannerProgressApi } from './plannerProgress'
import { usePlans, type PlannerMode, type PlansApi } from './usePlans'

const MODES: { value: PlannerMode; label: string }[] = [
  { value: 'effects', label: 'Effects' },
  { value: 'inventory', label: 'Inventory' },
  { value: 'farm', label: 'Farm' }
]

function RenameDialog({
  plan,
  onClose,
  onSave
}: {
  plan: ExaltPlan | null
  onClose: () => void
  onSave: (name: string) => void
}): JSX.Element {
  const [name, setName] = useState(plan?.name ?? '')
  return (
    <Dialog open={plan !== null} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ pb: 1 }}>Rename set</DialogTitle>
      <DialogContent>
        <TextField
          autoFocus
          fullWidth
          size="small"
          value={name}
          onChange={(e) => setName(e.target.value)}
          sx={{ mt: 1 }}
        />
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button size="small" color="inherit" onClick={onClose}>
          Cancel
        </Button>
        <Button size="small" variant="contained" disabled={name.trim() === ''} onClick={() => onSave(name.trim())}>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  )
}

// ---- the toolbar ---------------------------------------------------------------------

/** The set switcher + its overflow menu. The chip strip is the one group allowed to scroll. */
function SetSwitcher({
  plans,
  onNew,
  onMenu
}: {
  plans: PlansApi
  onNew: () => void
  onMenu: (anchor: HTMLElement) => void
}): JSX.Element {
  return (
    <>
      <Stack direction="row" spacing={0.5} sx={{ minWidth: 0, flexShrink: 1, overflowX: 'auto', py: 0.25 }}>
        {plans.plans.map((p) => (
          <Chip
            key={p.id}
            size="small"
            label={p.name}
            data-testid="planner-set-chip"
            color={plans.selected?.id === p.id ? 'primary' : 'default'}
            variant={plans.selected?.id === p.id ? 'filled' : 'outlined'}
            onClick={() => plans.select(p.id)}
            sx={{ flexShrink: 0 }}
          />
        ))}
      </Stack>
      <Button size="small" startIcon={<AddIcon />} data-testid="planner-new-set" onClick={onNew} sx={{ flexShrink: 0 }}>
        New set
      </Button>
      <IconButton
        size="small"
        disabled={plans.selected === null}
        onClick={(e) => onMenu(e.currentTarget)}
        sx={{ flexShrink: 0 }}
      >
        <MoreVertIcon fontSize="small" />
      </IconButton>
    </>
  )
}

/**
 * The set's target classes — the SAME closed-list multi-select the Sky tracker filters with
 * (planner-v2 V3), inline in the toolbar rather than behind a dialog, because a filter has to
 * LOOK mutable to read as a filter. Capped at MAX_COMBO_SLOTS; empty stays legal and means
 * "no class filter" (law 1), which is what the placeholder says while it is empty.
 *
 * `minWidth` is the control's FLOOR, not its width: it gives space back to the row until it hits
 * that floor, and past that the set-switcher chip strip is the group that scrolls. 240 rather
 * than the Sky bar's 280 because this row also carries the mode toggle: at the 900px minimum
 * window width the content area is 648px, and New set + the overflow menu + the toggle + the
 * gaps already claim ~373 of it. Three three-letter chips and a caret fit in 240 with room over.
 */
function ClassFilter({ plan, plans }: { plan: ExaltPlan; plans: PlansApi }): JSX.Element {
  // NO tooltip on this control (owner, 2026-08-05): a hover box over an input the user TYPES
  // into floats exactly where the dropdown opens and reads as the UI blocking itself. The
  // socketing-semantics explanation this used to carry belongs to the explainer card (W-G),
  // not to a popper racing the option list.
  return (
    <ChipMultiSelect
      options={CLASS_ABBRS}
      value={plan.classes}
      onChange={(classes) => plans.setClasses(plan.id, classes)}
      label="Classes"
      placeholder="All classes"
      max={MAX_COMBO_SLOTS}
      minWidth={240}
      testId="planner-classes"
    />
  )
}

/**
 * THE DISAGREE CHIP (V2) — "detected: PAL ENC MNK — apply".
 *
 * Shown only on a set whose trio the user PINNED, and only while live inference has resolved a
 * different one. It never changes anything on its own: the whole point of the chip idiom here is
 * that the app states what it thinks and the click is the user's. Applying does NOT un-pin the
 * set either — accepting one answer is not handing the filter back to inference.
 */
function DetectedChip({ offer, onApply }: { offer: ClassAbbr[]; onApply: () => void }): JSX.Element {
  return (
    // No popper (JOS-143). This chip renders IMMEDIATELY after ClassFilter on a nowrap row, so its
    // card opened into the same space the chip-select's option list uses — which is the hover box
    // ClassFilter's own comment already refused, arriving one control to the right instead.
    <Chip
      size="small"
      color="warning"
      variant="outlined"
      data-testid="planner-detected-chip"
      title="Use the combo detected from your log"
      label={`detected: ${offer.join(' ')} - apply`}
      onClick={onApply}
      sx={{ flexShrink: 0 }}
    />
  )
}

/**
 * THE ONE NOWRAP ROW. Which set, for which classes, in which mode — plus the permanent `?`, which
 * since JOS-51 is the ONLY way the explainer ever appears (V10): the card no longer opens itself,
 * so the `?` is both the way in and the way back after a dismissal.
 */
function Toolbar({
  plans,
  plan,
  offer,
  onNew,
  onMenu,
  onExplain
}: {
  plans: PlansApi
  plan: ExaltPlan
  /** the detected trio this pinned set disagrees with, or null (V2) */
  offer: ClassAbbr[] | null
  onNew: () => void
  onMenu: (anchor: HTMLElement) => void
  onExplain: () => void
}): JSX.Element {
  return (
    <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'nowrap', mb: 1.5 }}>
      <SetSwitcher plans={plans} onNew={onNew} onMenu={onMenu} />
      <Box sx={{ flexGrow: 1, minWidth: 8 }} />
      <ClassFilter plan={plan} plans={plans} />
      {offer !== null && <DetectedChip offer={offer} onApply={() => plans.adoptClasses(plan.id, offer)} />}
      <ToggleButtonGroup
        exclusive
        size="small"
        value={plans.mode}
        onChange={(_e, v: PlannerMode | null) => {
          if (v !== null) plans.setMode(v)
        }}
        sx={{ flexShrink: 0 }}
      >
        {MODES.map((m) => (
          <ToggleButton key={m.value} value={m.value} data-testid={`planner-mode-${m.value}`} sx={{ px: 1.5 }}>
            {m.label}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
      <IconButton
        size="small"
        aria-label="How exaltation works"
        title="How exaltation works"
        data-testid="planner-explainer-open"
        onClick={onExplain}
        sx={{ flexShrink: 0 }}
      >
        <HelpOutlineIcon fontSize="small" />
      </IconButton>
    </Stack>
  )
}

// ---- empty + not-yet states ----------------------------------------------------------

function NoSets({ onNew }: { onNew: () => void }): JSX.Element {
  return (
    <Stack alignItems="center" justifyContent="center" spacing={1.5} sx={{ height: '100%', color: 'text.secondary' }}>
      <AutoAwesomeIcon sx={{ fontSize: 44, opacity: 0.6 }} />
      <Typography variant="body2">Create a set to start planning.</Typography>
      <Button variant="contained" size="small" startIcon={<AddIcon />} data-testid="planner-new-set-empty" onClick={onNew}>
        New set
      </Button>
    </Stack>
  )
}

/** The three modes over ONE selected set. Split out so the view itself stays a shell. */
function ModePane({
  plan,
  plans,
  progress,
  preset,
  onOpenLoot
}: {
  plan: ExaltPlan
  plans: PlansApi
  progress: PlannerProgressApi
  /** V8 — the socket-of-a-host filter, and the two ends of the trip between the tabs */
  preset: [BrowsePreset | null, (p: BrowsePreset | null) => void]
  onOpenLoot?: (item: string) => void
}): JSX.Element {
  const [browsing, setBrowsing] = preset
  if (plans.mode === 'inventory') {
    return (
      <PlanBoard
        plan={plan}
        progress={progress}
        onSocket={plans.setSocket}
        onHost={plans.setHost}
        onBrowse={(p) => {
          setBrowsing(p)
          plans.setMode('effects')
        }}
        onOpenLoot={onOpenLoot}
      />
    )
  }
  if (plans.mode === 'farm') return <FarmList plan={plan} progress={progress} onOpenLoot={onOpenLoot} />
  return (
    <EffectBrowser
      plan={plan}
      preset={browsing}
      onClearPreset={() => setBrowsing(null)}
      onSocket={plans.setSocket}
      onOpenLoot={onOpenLoot}
    />
  )
}

// ---- the view ------------------------------------------------------------------------

interface Editing {
  rename: ExaltPlan | null
  menu: HTMLElement | null
}

const NO_EDIT: Editing = { rename: null, menu: null }

export interface PlannerViewProps {
  /**
   * Deep-link an item name into the Loot tab's drill-down (App's `openLoot`). Optional so the
   * pane still renders standalone; every donor name in all three modes becomes a link when it
   * is supplied, and stays a pure hover surface when it is not.
   */
  onOpenLoot?: (item: string) => void
}

export default function PlannerView({ onOpenLoot }: PlannerViewProps = {}): JSX.Element {
  const plans = usePlans()
  const combo = useComboSnap()
  const progress = usePlannerProgress()
  const [editing, setEditing] = useState<Editing>(NO_EDIT)
  // V8 — which socket of which host the browser is filtered to, held HERE because the trip
  // crosses two modes: it is set on the Inventory tab and consumed on the Effects tab.
  const [browsing, setBrowsing] = useState<BrowsePreset | null>(null)
  const explainer = useExplainer()
  const selected = plans.selected

  // What the app currently believes this character is running. An unresolved slot contributes
  // nothing, so a half-known combo yields the classes it does know and nothing it doesn't (law 1).
  const current = combo.current
  const detected = useMemo(() => (current === null ? [] : resolvedClasses(current)), [current])

  // A new set defaults to the CURRENTLY INFERRED combo (D5) — and, since V2, keeps FOLLOWING it.
  const newSet = (): void => {
    plans.create(detected)
  }

  // THE BINDING (V2): a set whose trio came from detection tracks detection. Scoped to the
  // SELECTED set on purpose — it is the one whose filter is on screen and whose donor list is
  // about to be read, and rewriting nine unopened sets on every loadout switch would be nine
  // `updatedAt` stamps for edits nobody made. `boundClasses` returns null once they agree, so
  // this settles after one write rather than looping.
  const bound = selected === null ? null : boundClasses(selected, detected)
  const selectedId = selected?.id ?? null
  const { adoptClasses } = plans
  useEffect(() => {
    if (selectedId !== null && bound !== null) adoptClasses(selectedId, bound)
  }, [selectedId, bound, adoptClasses])

  const offer = selected === null ? null : detectedOffer(selected, detected)

  if (!plans.ready) return <Box />
  if (plans.plans.length === 0 || selected === null) return <NoSets onNew={newSet} />

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }} data-testid="planner-view">
      <Toolbar
        plans={plans}
        plan={selected}
        offer={offer}
        onNew={newSet}
        onMenu={(menu) => setEditing({ ...NO_EDIT, menu })}
        onExplain={explainer.show}
      />

      {explainer.open && <RulesExplainer onDismiss={explainer.dismiss} />}

      <ModePane
        plan={selected}
        plans={plans}
        progress={progress}
        preset={[browsing, setBrowsing]}
        onOpenLoot={onOpenLoot}
      />

      <Menu anchorEl={editing.menu} open={editing.menu !== null} onClose={() => setEditing(NO_EDIT)}>
        <MenuItem onClick={() => setEditing({ ...NO_EDIT, rename: selected })}>Rename</MenuItem>
        <MenuItem
          onClick={() => {
            plans.duplicate(selected.id)
            setEditing(NO_EDIT)
          }}
        >
          Duplicate
        </MenuItem>
        <MenuItem
          onClick={() => {
            plans.remove(selected.id)
            setEditing(NO_EDIT)
          }}
        >
          Delete
        </MenuItem>
      </Menu>

      {/* Keyed on the set id so each open starts from THAT set's current values. */}
      <RenameDialog
        key={`rename:${editing.rename?.id ?? 'none'}`}
        plan={editing.rename}
        onClose={() => setEditing(NO_EDIT)}
        onSave={(name) => {
          if (editing.rename) plans.rename(editing.rename.id, name)
          setEditing(NO_EDIT)
        }}
      />
    </Box>
  )
}
