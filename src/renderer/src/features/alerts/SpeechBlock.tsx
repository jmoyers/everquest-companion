// SpeechBlock — the alert editor's SPEECH half (docs/plans/voice-alerts.md §4): which audio
// channel this alert uses, what it says, in whose voice, and whether it may be swallowed by the
// cross-alert audio throttle.
//
// Its own file because AlertDialog.tsx is already at the factoring ceiling, and because this
// block is a self-contained sub-form: `useSpeechForm` owns its four fields, `speechFieldsFor`
// turns them back into the def's optional keys, and the component is the rendering. AlertDialog
// composes the three.
//
// THE PREVIEW IS LIVE AND NEEDS NO FIRING. `speechTextFor(def, firing?)` is pure and takes an
// OPTIONAL firing precisely so this line can be resolved while the user types (W1's contract) —
// so the user reads the actual sentence, resolved by the same function the player will run,
// before ever pressing ▶. On a spell mode there is no spell yet, so the preview shows the
// alertName FALLBACK — which is the honest answer: it is exactly what they will hear whenever
// the trigger turns out to name no spell.
//
// WHAT IS DELIBERATELY NOT HERE: rate, volume and the DEFAULT voice. Those are global (the
// Preferences → Voice section); this block only overrides. A per-alert rate would be four
// places to look when one alert sounds wrong.

import { type JSX, useEffect, useState } from 'react'
import {
  Box,
  Button,
  FormControlLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  Typography
} from '@mui/material'
import VolumeUpIcon from '@mui/icons-material/VolumeUp'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import type { AlertAudio, AlertDef, AlertSpeech, SpeechMode } from '@shared/types'
import {
  ALERT_AUDIO_ACTIONS,
  MAX_SPEECH_CHARS,
  SPEECH_MODES,
  speechTextFor
} from '@shared/speechText'
import { tokensIn } from '@shared/alertCaptures'
import { currentVoicePrefs, speak } from '../../lib/speech'
import { useVoiceOptions } from '../../lib/useVoices'
import VoiceSetupLink, { type VoiceSetupNotice } from './VoiceSetupLink'

/** Human labels for the audio-action selector. Keyed off the closed union, never free text. */
const AUDIO_LABELS: Record<AlertAudio, string> = {
  sound: 'Play a sound',
  speech: 'Speak it',
  both: 'Sound, then speak'
}

/** Human labels for the mode picker, in the order SPEECH_MODES declares. */
const MODE_LABELS: Record<SpeechMode, string> = {
  alertName: 'the alert’s name',
  spellName: 'the spell’s name',
  spellFirstWord: 'the spell’s first word',
  custom: 'a phrase I write'
}

/** The sub-form AlertDialog holds and this block renders. */
export interface SpeechForm {
  audio: AlertAudio
  setAudio: (v: AlertAudio) => void
  mode: SpeechMode
  setMode: (v: SpeechMode) => void
  phrase: string
  setPhrase: (v: string) => void
  /** '' = use the global default voice. */
  voiceId: string
  setVoiceId: (v: string) => void
  alwaysPlay: boolean
  setAlwaysPlay: (v: boolean) => void
}

/** The four fields + the opt-out, read off a def (edit) or at their defaults (add). */
function speechDefaults(initial: AlertDef | null): {
  audio: AlertAudio
  mode: SpeechMode
  phrase: string
  voiceId: string
  alwaysPlay: boolean
} {
  const speech = initial?.speech
  return {
    audio: initial?.audio ?? 'sound',
    mode: speech?.mode ?? 'alertName',
    phrase: speech?.phrase ?? '',
    voiceId: speech?.voiceId ?? '',
    alwaysPlay: initial?.alwaysPlay === true
  }
}

/** Hydrate the speech sub-form from `initial` (edit) or its defaults (add), on every open. */
export function useSpeechForm(open: boolean, initial: AlertDef | null): SpeechForm {
  const [audio, setAudio] = useState<AlertAudio>('sound')
  const [mode, setMode] = useState<SpeechMode>('alertName')
  const [phrase, setPhrase] = useState('')
  const [voiceId, setVoiceId] = useState('')
  const [alwaysPlay, setAlwaysPlay] = useState(false)

  useEffect(() => {
    if (!open) return
    const d = speechDefaults(initial)
    setAudio(d.audio)
    setMode(d.mode)
    setPhrase(d.phrase)
    setVoiceId(d.voiceId)
    setAlwaysPlay(d.alwaysPlay)
  }, [open, initial])

  return {
    audio,
    setAudio,
    mode,
    setMode,
    phrase,
    setPhrase,
    voiceId,
    setVoiceId,
    alwaysPlay,
    setAlwaysPlay
  }
}

/**
 * The def keys this block owns. Each is OMITTED at its default, so an alert that never asked to
 * speak saves byte-identically to how it always did — which is what keeps every pre-voice def,
 * every share string and the import de-duplication fingerprint stable.
 */
export function speechFieldsFor(f: SpeechForm): Pick<AlertDef, 'audio' | 'speech' | 'alwaysPlay'> {
  const speech: AlertSpeech = { mode: f.mode }
  const phrase = f.phrase.trim().slice(0, MAX_SPEECH_CHARS)
  if (phrase) speech.phrase = phrase
  if (f.voiceId) speech.voiceId = f.voiceId
  const configured = f.mode !== 'alertName' || speech.phrase !== undefined || speech.voiceId !== undefined
  return {
    ...(f.audio === 'sound' ? {} : { audio: f.audio }),
    ...(configured ? { speech } : {}),
    ...(f.alwaysPlay ? { alwaysPlay: true } : {})
  }
}

/** The resolved sentence this alert will speak, with no firing — W1's editor-preview contract. */
export function previewTextFor(name: string, f: SpeechForm): string | null {
  const fields = speechFieldsFor(f)
  return speechTextFor({ name, ...(fields.speech ? { speech: fields.speech } : {}) }, null)
}

/** Audio-channel selector + the always-play opt-out. Both apply whether or not speech is on. */
function AudioActionRow({ form }: { form: SpeechForm }): JSX.Element {
  return (
    <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
      <Box sx={{ minWidth: 200 }}>
        <Typography variant="caption" color="text.secondary">
          When this fires…
        </Typography>
        <Select
          size="small"
          fullWidth
          data-testid="alert-audio-action"
          value={form.audio}
          onChange={(e) => form.setAudio(e.target.value as AlertAudio)}
        >
          {ALERT_AUDIO_ACTIONS.map((a) => (
            <MenuItem key={a} value={a}>
              {AUDIO_LABELS[a]}
            </MenuItem>
          ))}
        </Select>
      </Box>
      <FormControlLabel
        control={
          <Switch
            size="small"
            data-testid="alert-always-play"
            checked={form.alwaysPlay}
            onChange={(e) => form.setAlwaysPlay(e.target.checked)}
          />
        }
        label={<Typography variant="body2">Always play (skip audio throttle)</Typography>}
      />
    </Stack>
  )
}

/**
 * WHAT `{tokens}` THIS ALERT MAY WRITE, and which ones its pattern does not actually declare
 * (JOS-103).
 *
 * The readable form of control 4 in shared/alertCaptures.ts's threat model: a token resolves ONLY
 * if the def's own pattern declared a matching named group, so the set of values this alert can
 * ever speak is a finite list that can be printed. It matters most for a def that arrived in
 * somebody else's share string — you can see what it is able to say without reading the regex.
 *
 * The unknown-token line is a WARNING, never a save block: an unresolved token renders literally,
 * which is a legible sentence rather than a broken alert, and a user mid-edit should not be
 * stopped from typing `{pl` on the way to `{player}`.
 */
function CaptureHint({ phrase, captureNames }: { phrase: string; captureNames: string[] }): JSX.Element | null {
  const used = tokensIn(phrase)
  const unknown = used.filter((t) => !captureNames.includes(t))
  if (captureNames.length === 0 && unknown.length === 0) return null
  return (
    <Box data-testid="alert-speech-captures">
      {captureNames.length > 0 && (
        <Typography variant="caption" color="text.secondary" display="block">
          {`This alert’s pattern captures: ${captureNames.map((n) => `{${n}}`).join(' ')} - write one in the phrase to speak it.`}
        </Typography>
      )}
      {unknown.length > 0 && (
        <Typography variant="caption" color="warning.main" display="block">
          {`${unknown.map((n) => `{${n}}`).join(' ')} ${unknown.length === 1 ? 'is not' : 'are not'} captured by this alert’s pattern - spoken as written.`}
        </Typography>
      )}
    </Box>
  )
}

/** Mode picker + live preview + (custom only) the capped phrase field. */
function SaysRow({
  name,
  form,
  captureNames
}: {
  name: string
  form: SpeechForm
  captureNames: string[]
}): JSX.Element {
  const preview = previewTextFor(name, form)
  return (
    <Stack spacing={1}>
      <Box>
        <Typography variant="caption" color="text.secondary">
          Say…
        </Typography>
        <Select
          size="small"
          fullWidth
          data-testid="alert-speech-mode"
          value={form.mode}
          onChange={(e) => form.setMode(e.target.value as SpeechMode)}
        >
          {SPEECH_MODES.map((m) => (
            <MenuItem key={m} value={m}>
              {MODE_LABELS[m]}
            </MenuItem>
          ))}
        </Select>
      </Box>

      {form.mode === 'custom' && (
        <>
          <TextField
            size="small"
            label="Phrase"
            data-testid="alert-speech-phrase"
            value={form.phrase}
            onChange={(e) => form.setPhrase(e.target.value)}
            slotProps={{ htmlInput: { maxLength: MAX_SPEECH_CHARS } }}
            helperText={`${String(form.phrase.length)} / ${String(MAX_SPEECH_CHARS)}`}
          />
          <CaptureHint phrase={form.phrase} captureNames={captureNames} />
        </>
      )}

      {/* THE PREVIEW SHOWS TOKENS UNRESOLVED, ON PURPOSE. There is no firing yet, so there is no
          captured value, and substituting a made-up sample would put words in the alert's mouth
          that no log line said (world-model law 1). The literal `{player}` is exactly what the
          user will hear if the capture is ever missing, and `CaptureHint` above is where they
          learn that the pattern really does declare it. */}
      <Typography variant="caption" color="text.secondary" data-testid="alert-speech-preview">
        {preview ? `Speaks: “${preview}”` : 'Speaks nothing - give the alert a name or a phrase.'}
      </Typography>
    </Stack>
  )
}

/** Per-alert voice override + the ▶ that speaks the preview through the real engine. */
function VoiceRow({ name, form }: { name: string; form: SpeechForm }): JSX.Element {
  const prefs = currentVoicePrefs()
  const voices = useVoiceOptions(prefs.engine)
  const preview = previewTextFor(name, form)
  return (
    <Stack direction="row" spacing={1.5} alignItems="flex-end" flexWrap="wrap" useFlexGap>
      <Box sx={{ minWidth: 240, flexGrow: 1 }}>
        <Typography variant="caption" color="text.secondary">
          Voice
        </Typography>
        <Select
          size="small"
          fullWidth
          displayEmpty
          data-testid="alert-speech-voice"
          value={voices.some((v) => v.id === form.voiceId) ? form.voiceId : ''}
          onChange={(e) => form.setVoiceId(e.target.value)}
        >
          <MenuItem value="">Default voice</MenuItem>
          {voices.map((v) => (
            <MenuItem key={v.id} value={v.id}>
              {v.label}
            </MenuItem>
          ))}
        </Select>
      </Box>
      <Button
        size="small"
        startIcon={<PlayArrowIcon />}
        data-testid="alert-speech-test"
        disabled={!preview}
        onClick={() => {
          if (preview) void speak(preview, prefs, { ...(form.voiceId ? { voiceId: form.voiceId } : {}) })
        }}
      >
        Test
      </Button>
    </Stack>
  )
}

/**
 * The block. The speech controls are shown only when the alert actually speaks — a sound-only
 * alert has nothing to say, and offering it a phrase field would be offering dead state — but
 * the audio-action row and the throttle opt-out are always there, because both are true of every
 * alert.
 */
export default function SpeechBlock({
  name,
  form,
  voiceSetup,
  captureNames = []
}: {
  name: string
  form: SpeechForm
  /** Whether there is a voice to speak with, and how to go set one up (VoiceSetupLink.tsx). */
  voiceSetup: VoiceSetupNotice
  /**
   * The named capture groups the alert's CURRENT trigger declares (`captureNamesIn`), recomputed
   * as the user edits the pattern. Empty for the alerts that capture nothing, which is most of
   * them — and then the hint renders nothing at all rather than an empty label.
   */
  captureNames?: string[]
}): JSX.Element {
  const speaks = form.audio !== 'sound'
  return (
    <Box data-testid="alert-speech-block">
      <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mb: 0.5 }}>
        <VolumeUpIcon fontSize="small" sx={{ color: 'text.secondary' }} />
        <Typography variant="caption" color="text.secondary">
          Voice
        </Typography>
      </Stack>
      <Stack spacing={1.5}>
        <AudioActionRow form={form} />
        {/* No master switch to warn about any more (this used to say "spoken alerts are switched
            off in Preferences"): choosing 'Speak it' above IS the switch. The only thing left to
            say is that the chosen tier has nothing to speak with — and it says it with a LINK. */}
        {speaks && <VoiceSetupLink notice={voiceSetup} testId="alert-speech-setup" />}
        {speaks && <SaysRow name={name} form={form} captureNames={captureNames} />}
        {speaks && <VoiceRow name={name} form={form} />}
      </Stack>
    </Box>
  )
}
