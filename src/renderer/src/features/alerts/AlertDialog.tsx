// AlertDialog — the add/EDIT dialog for one alert. Extracted from AlertsView.tsx
// (Wave D factoring); the form's behavior, validation and saved shape are unchanged.
//
// `initial` is null for "add", or an existing def for "edit" (including a seeded
// built-in — no special casing beyond keeping its id stable).
//
// THIS FILE IS THE RENDERING. The form model it drives — which fields exist, how they are
// hydrated from `initial`, and how they turn back into an `AlertDef` — lives in alertForm.ts,
// which is where JOS-122's hydration rule is stated: hydration answers an OPENING, never a prop
// identity, because `packs` is re-listed on every window focus and re-hydrating on it wiped
// whatever the user had typed. Read that header before touching either half.

import { type Dispatch, type JSX, type SetStateAction } from 'react'
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  MenuItem,
  Paper,
  Select,
  Slider,
  Stack,
  TextField,
  Typography
} from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import type { AlertDef, SoundPack } from '@shared/types'
import { captureNamesIn } from '@shared/alertCaptures'
import { autoTokenNamesFor } from '@shared/alertTargets'
import { MAX_EARLY_WARN_SEC, breakTriggerKinds } from '@shared/earlyWarning'
import { blankCondition, type CombineMode, type ConditionDraft } from './conditionDraft'
import {
  type AlertForm,
  type CooldownScope,
  defFromForm,
  formCanSave,
  triggerFromForm,
  useAlertForm
} from './alertForm'
import ConditionEditor from './ConditionEditor'
import SoundPicker from './SoundPicker'
import SpeechBlock from './SpeechBlock'
import BannerBlock from './BannerBlock'
import type { VoiceSetupNotice } from './VoiceSetupLink'

/** "Fire when…" — the single/any/all combine-mode picker plus the same-event caveat. */
function CombineModeSection({
  mode,
  onChange
}: {
  mode: CombineMode
  onChange: (next: CombineMode) => void
}): JSX.Element {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary">
        Fire when…
      </Typography>
      <Select
        size="small"
        fullWidth
        data-testid="alert-combine-mode"
        value={mode}
        onChange={(e) => onChange(e.target.value as CombineMode)}
      >
        <MenuItem value="single">a single condition matches</MenuItem>
        <MenuItem value="any">ANY of these conditions matches (or)</MenuItem>
        <MenuItem value="all">ALL of these match the same event (and)</MenuItem>
      </Select>
      {mode === 'all' && (
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
          “All” requires every condition to match the SAME incoming log event (same-event,
          not a correlation window).
        </Typography>
      )}
    </Box>
  )
}

/** One numbered condition card inside a composite trigger. */
function ConditionRow({
  index,
  draft,
  canRemove,
  onChange,
  onRemove
}: {
  index: number
  draft: ConditionDraft
  canRemove: boolean
  onChange: (next: ConditionDraft) => void
  onRemove: () => void
}): JSX.Element {
  return (
    <Paper variant="outlined" sx={{ p: 1.25, position: 'relative' }}>
      <Stack direction="row" alignItems="center" sx={{ mb: 0.5 }}>
        <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
          Condition {index + 1}
        </Typography>
        <Box sx={{ flexGrow: 1 }} />
        {/* No popper (JOS-143): this button sits on the card's header line, directly above the
            ConditionEditor's three Selects, and a default-placement tooltip opens DOWNWARD — onto
            them. The span outlives it because a disabled button swallows mouse events. */}
        <span title="Remove condition">
          <IconButton
            size="small"
            aria-label="Remove condition"
            color="error"
            disabled={!canRemove}
            onClick={onRemove}
          >
            <DeleteOutlineIcon fontSize="small" />
          </IconButton>
        </span>
      </Stack>
      <ConditionEditor draft={draft} onChange={onChange} />
    </Paper>
  )
}

/** Single mode renders one bare editor; composite modes render the add/remove list. */
function ConditionsSection({
  mode,
  conditions,
  setConditions
}: {
  mode: CombineMode
  conditions: ConditionDraft[]
  setConditions: Dispatch<SetStateAction<ConditionDraft[]>>
}): JSX.Element {
  const setCondition = (i: number, next: ConditionDraft): void =>
    setConditions((prev) => prev.map((c, j) => (j === i ? next : c)))
  const addCondition = (): void => setConditions((prev) => [...prev, blankCondition()])
  const removeCondition = (i: number): void =>
    setConditions((prev) => (prev.length <= 1 ? prev : prev.filter((_, j) => j !== i)))

  if (mode === 'single') {
    return <ConditionEditor draft={conditions[0]} onChange={(next) => setCondition(0, next)} />
  }
  return (
    <Stack spacing={1.5}>
      {conditions.map((c, i) => (
        <ConditionRow
          key={i}
          index={i}
          draft={c}
          canRemove={conditions.length > 1}
          onChange={(next) => setCondition(i, next)}
          onRemove={() => removeCondition(i)}
        />
      ))}
      <Button startIcon={<AddIcon />} size="small" onClick={addCondition} sx={{ alignSelf: 'flex-start' }}>
        Add condition
      </Button>
    </Stack>
  )
}

/** The per-alert volume slider + cooldown field + what that cooldown is counted per. */
function VolumeCooldownSection({ f }: { f: AlertForm }): JSX.Element {
  return (
    <Stack direction="row" spacing={3} alignItems="center" flexWrap="wrap" useFlexGap>
      <Stack sx={{ minWidth: 180 }}>
        <Typography variant="caption" color="text.secondary">
          Volume ({Math.round(f.volume * 100)}%)
        </Typography>
        <Slider
          size="small"
          min={0}
          max={1}
          step={0.05}
          value={f.volume}
          onChange={(_e, v) => f.setVolume(v as number)}
          sx={{ width: 160 }}
        />
      </Stack>
      <TextField
        size="small"
        type="number"
        label="Cooldown (ms)"
        data-testid="alert-cooldown"
        value={f.cooldownMs}
        onChange={(e) => f.setCooldownMs(Math.max(0, Number(e.target.value) || 0))}
        sx={{ width: 140 }}
      />
      {/* Sits against the cooldown field because it only qualifies THAT number. "Per mob" is
          a state ("this alert is quiet per mob"), not a description of how the engine keys a
          map — and the caption below says what changes, never how. */}
      <Stack sx={{ minWidth: 150 }}>
        <Typography variant="caption" color="text.secondary">
          Counted
        </Typography>
        <Select
          size="small"
          value={f.cooldownScope}
          onChange={(e) => f.setCooldownScope(e.target.value as CooldownScope)}
        >
          <MenuItem value="alert">per alert</MenuItem>
          <MenuItem value="target">per mob</MenuItem>
        </Select>
      </Stack>
      {f.cooldownScope === 'target' && (
        <Typography variant="caption" color="text.secondary" sx={{ flexBasis: '100%' }}>
          The first match on each mob always plays; only repeats on that same mob wait out the
          cooldown.
        </Typography>
      )}
    </Stack>
  )
}

/**
 * "Warn N seconds early" (JOS-216) — the offset, in the plainest words the feature has.
 *
 * DELIBERATELY SMALL, and the owner's ruling says why: this is one option add, not a lecture. The
 * caveat that belongs to it — the timing leans on a duration the app is still learning — is the
 * MOUSEOVER, two short sentences, because it is a thing to know once rather than a thing to read on
 * every visit. The one caption below it states what the number changes and nothing else.
 */
/**
 * True when this alert's trigger is an ENDING rather than a landing (JOS-235) — asked of the SAME
 * classifier main schedules by, over the trigger the form would save right now.
 *
 * It changes one caption, and the caption was a lie for exactly these defs: a mez-break alert with
 * an offset does not fire "instead of when it lands" (it never fired on a landing), and the thing
 * a user needs told is the half that is new — an early break still speaks at the break.
 */
function isBreakForm(f: AlertForm): boolean {
  return breakTriggerKinds(triggerFromForm(f.mode, f.conditions)).length > 0
}

function EarlyWarnSection({ f }: { f: AlertForm }): JSX.Element {
  return (
    <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
      <TextField
        size="small"
        type="number"
        label="Warn early (sec)"
        data-testid="alert-early-warn"
        value={f.earlyWarnSec || ''}
        placeholder="0"
        onChange={(e) => f.setEarlyWarnSec(Math.max(0, Number(e.target.value) || 0))}
        slotProps={{ htmlInput: { min: 0, max: MAX_EARLY_WARN_SEC } }}
        sx={{ width: 150 }}
      />
      {/* A NATIVE title, not a popper (JOS-143): this dialog renders Selects, and the rule is that
          no file mounting a dropdown may also mount a hover card that could open over its option
          list. Same spelling the Remove-condition button above already uses. */}
      <span
        title="Timing uses the duration the app has learned for that spell, so it can be off at first. It gets accurate once your logs have been running a while."
        data-testid="alert-early-warn-help"
      >
        <InfoOutlinedIcon fontSize="small" color="disabled" />
      </span>
      {f.earlyWarnSec > 0 && (
        <Typography variant="caption" color="text.secondary" sx={{ flexBasis: '100%' }}>
          {isBreakForm(f)
            ? `Fires ${String(f.earlyWarnSec)}s before it is due to end. If it ends sooner than that, you still hear the alert then.`
            : `Fires ${String(f.earlyWarnSec)}s before it is due to wear off, instead of when it lands.`}
        </Typography>
      )}
    </Stack>
  )
}

export default function AlertDialog({
  open,
  initial,
  packs,
  defaultPackId,
  voiceSetup,
  allAlwaysPlay = false,
  bannerOverlayOn = false,
  onOpenOverlayPrefs,
  onClose,
  onSave
}: {
  open: boolean
  initial: AlertDef | null
  packs: SoundPack[]
  /**
   * The user's default sound pack (JOS-273). A NEW alert opens on it; an EDIT is untouched by it,
   * because the def already states which pack it plays. Optional so a caller without the prefs
   * (and every test that mounts this dialog bare) still compiles onto the shipped default.
   */
  defaultPackId?: string
  /** Whether there is a voice to speak with, and how to go set one up (VoiceSetupLink.tsx). */
  voiceSetup: VoiceSetupNotice
  /**
   * `AlertPrefs.alwaysPlayAll` (JOS-222) — passed straight through to the Speech block, which is
   * the only thing in this dialog the global preference has an opinion about. Optional and false
   * by default for the same reason `onOpenVoicePrefs` is on the view: a caller without the prefs
   * must still compile, and the safe rendering is the editable one.
   */
  allAlwaysPlay?: boolean
  /**
   * Is the ALERT BANNER overlay switched on (JOS-378)? The owner's ruling is that the on-screen
   * controls are visible only while it is, so this decides whether the Banner block renders its
   * three controls or the one quiet line naming the switch. Optional and false by default for
   * `allAlwaysPlay`'s reason: a caller without the state must still compile, and OFF is the
   * shipped default, so false is also the honest guess.
   */
  bannerOverlayOn?: boolean
  /** Navigate to Preferences → Overlays. Absent ⇒ the quiet line renders without a link. */
  onOpenOverlayPrefs?: () => void
  onClose: () => void
  onSave: (def: AlertDef) => void
}): JSX.Element {
  const f = useAlertForm(open, initial, packs, defaultPackId)
  const editing = initial != null

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth data-testid="alert-dialog">
      <DialogTitle>{editing ? `Edit alert - ${initial?.name}` : 'Add alert'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField
            size="small"
            label="Name"
            data-testid="alert-name"
            value={f.name}
            onChange={(e) => f.setName(e.target.value)}
            autoFocus
          />
          <CombineModeSection mode={f.mode} onChange={f.changeMode} />

          <ConditionsSection
            mode={f.mode}
            conditions={f.conditions}
            setConditions={f.setConditions}
          />

          <Divider />
          <Box>
            <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 0.5 }}>
              Sound
            </Typography>
            <SoundPicker
              packs={packs}
              packId={f.packId}
              soundId={f.soundId}
              defaultPackId={defaultPackId}
              onChange={f.setSound}
            />
          </Box>

          <VolumeCooldownSection f={f} />
          <EarlyWarnSection f={f} />

          <Divider />
          {/* Recomputed from the LIVE form, not from `initial`: the user can add `(?<player>…)`
              to the pattern and the token list has to follow them, in the same dialog, before
              they type the phrase that uses it. `autoNames` follows the same live trigger for the
              same reason (JOS-353) — switching a condition's event kind is exactly how a user
              discovers that `{target}` is available here and not there. */}
          <SpeechBlock
            name={f.name}
            form={f.speech}
            voiceSetup={voiceSetup}
            captureNames={captureNamesIn(triggerFromForm(f.mode, f.conditions))}
            autoNames={autoTokenNamesFor(triggerFromForm(f.mode, f.conditions))}
            allAlwaysPlay={allAlwaysPlay}
          />

          {/* THE ON-SCREEN CHANNEL (JOS-378), beside the spoken one because it is the same
              question about a third channel. The placeholder is the NAME being typed above
              (JOS-380), because that is what an empty override prints — one derivation, and not a
              promise two files make separately. */}
          <BannerBlock
            alertName={f.name}
            form={f.banner}
            enabled={bannerOverlayOn}
            onOpenPrefs={onOpenOverlayPrefs}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          data-testid="alert-save"
          disabled={!formCanSave(f)}
          onClick={() => onSave(defFromForm(f, initial))}
        >
          {editing ? 'Save' : 'Add'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
