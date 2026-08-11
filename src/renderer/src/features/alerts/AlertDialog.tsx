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
import type { AlertDef, SoundPack } from '@shared/types'
import { captureNamesIn } from '@shared/alertCaptures'
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

export default function AlertDialog({
  open,
  initial,
  packs,
  voiceSetup,
  onClose,
  onSave
}: {
  open: boolean
  initial: AlertDef | null
  packs: SoundPack[]
  /** Whether there is a voice to speak with, and how to go set one up (VoiceSetupLink.tsx). */
  voiceSetup: VoiceSetupNotice
  onClose: () => void
  onSave: (def: AlertDef) => void
}): JSX.Element {
  const f = useAlertForm(open, initial, packs)
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
              onChange={f.setSound}
            />
          </Box>

          <VolumeCooldownSection f={f} />

          <Divider />
          {/* Recomputed from the LIVE form, not from `initial`: the user can add `(?<player>…)`
              to the pattern and the token list has to follow them, in the same dialog, before
              they type the phrase that uses it. */}
          <SpeechBlock
            name={f.name}
            form={f.speech}
            voiceSetup={voiceSetup}
            captureNames={captureNamesIn(triggerFromForm(f.mode, f.conditions))}
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
