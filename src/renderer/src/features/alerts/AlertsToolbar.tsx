// AlertsToolbar — the global controls strip above the alert list: volume + mute,
// the search box, the sound-pack registry browser, share copy/import, and "Reset to defaults".
// Extracted from AlertsView.tsx (Wave D factoring).

import type { JSX } from 'react'
import {
  Box,
  Button,
  FormControlLabel,
  IconButton,
  InputAdornment,
  Paper,
  Slider,
  Stack,
  Switch,
  TextField,
  Typography
} from '@mui/material'
import ClearIcon from '@mui/icons-material/Clear'
import SearchIcon from '@mui/icons-material/Search'
import RestartAltIcon from '@mui/icons-material/RestartAlt'
import VolumeUpIcon from '@mui/icons-material/VolumeUp'
import VolumeOffIcon from '@mui/icons-material/VolumeOff'
import LibraryMusicIcon from '@mui/icons-material/LibraryMusic'
import AudioFileIcon from '@mui/icons-material/AudioFile'
import IosShareIcon from '@mui/icons-material/IosShare'
import FileUploadIcon from '@mui/icons-material/FileUpload'
import type { AlertPrefs } from '@shared/types'
import { Tooltip } from '../../lib/Tooltip'

/**
 * The global volume + mute pair. Split out of the toolbar body so the strip's own function
 * stays inside the factoring ceiling as buttons are added beside it — the controls, their
 * drag/commit split and their layout are unchanged.
 */
function VolumeControls({
  prefs,
  onPrefsDrag,
  onPrefsCommit
}: {
  prefs: AlertPrefs
  onPrefsDrag: (next: AlertPrefs) => void
  onPrefsCommit: (next: AlertPrefs) => void
}): JSX.Element {
  return (
    <>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 240 }}>
        {prefs.muted ? <VolumeOffIcon color="disabled" /> : <VolumeUpIcon color="primary" />}
        <Typography variant="body2" sx={{ width: 90 }}>
          Global volume
        </Typography>
        <Slider
          size="small"
          min={0}
          max={1}
          step={0.05}
          value={prefs.globalVolume}
          onChange={(_e, v) => onPrefsDrag({ ...prefs, globalVolume: v as number })}
          onChangeCommitted={(_e, v) => onPrefsCommit({ ...prefs, globalVolume: v as number })}
          sx={{ width: 140 }}
        />
        <Typography variant="caption" color="text.secondary" sx={{ width: 34 }}>
          {Math.round(prefs.globalVolume * 100)}%
        </Typography>
      </Stack>
      <FormControlLabel
        control={
          <Switch
            checked={prefs.muted}
            onChange={(e) => onPrefsCommit({ ...prefs, muted: e.target.checked })}
          />
        }
        label="Mute all"
      />
    </>
  )
}

/**
 * THE SEARCH BOX (JOS-178). What it searches is alertSearch.ts's business; what it owes the user
 * is that the placeholder NAMES the wide match set, because nobody guesses that the note or the
 * spoken phrase is searchable. No tooltip: the UI conventions forbid one on an input anyway, and
 * a placeholder that says the answer needs no second voice.
 */
function AlertSearchField({
  query,
  onQuery
}: {
  query: string
  onQuery: (q: string) => void
}): JSX.Element {
  return (
    <TextField
      size="small"
      data-testid="alerts-search"
      placeholder="Search name, spell, trigger, sound, phrase, note"
      value={query}
      onChange={(e) => onQuery(e.target.value)}
      sx={{ minWidth: 280, flexGrow: 1, maxWidth: 420 }}
      slotProps={{
        input: {
          startAdornment: (
            <InputAdornment position="start">
              <SearchIcon fontSize="small" />
            </InputAdornment>
          ),
          endAdornment:
            query === '' ? null : (
              <InputAdornment position="end">
                <IconButton
                  size="small"
                  aria-label="Clear the search"
                  data-testid="alerts-search-clear"
                  onClick={() => onQuery('')}
                >
                  <ClearIcon fontSize="small" />
                </IconButton>
              </InputAdornment>
            )
        }
      }}
    />
  )
}

export default function AlertsToolbar({
  prefs,
  onPrefsDrag,
  onPrefsCommit,
  search,
  hasAlerts,
  onOpenPacks,
  onOpenMySounds,
  onCopyAll,
  onOpenImport,
  onReset
}: {
  prefs: AlertPrefs
  /** Local-only update while the volume slider is dragged. */
  onPrefsDrag: (next: AlertPrefs) => void
  /** Persisted update (slider release, mute toggle). */
  onPrefsCommit: (next: AlertPrefs) => void
  /** The list filter's own state (JOS-178) — the box lives here, the matching lives elsewhere. */
  search: { query: string; setQuery: (q: string) => void }
  hasAlerts: boolean
  onOpenPacks: () => void
  /** Open the user's own imported sounds (JOS-68) — beside the registry browser. */
  onOpenMySounds: () => void
  onCopyAll: () => void
  onOpenImport: () => void
  onReset: () => void
}): JSX.Element {
  return (
    <Paper variant="outlined" sx={{ p: 1.5 }}>
      <Stack direction="row" spacing={3} alignItems="center" flexWrap="wrap" useFlexGap>
        <VolumeControls
          prefs={prefs}
          onPrefsDrag={onPrefsDrag}
          onPrefsCommit={onPrefsCommit}
        />
        <Box sx={{ flexGrow: 1 }} />
        <AlertSearchField query={search.query} onQuery={search.setQuery} />
        <Button
          startIcon={<LibraryMusicIcon />}
          variant="outlined"
          size="small"
          onClick={onOpenPacks}
        >
          Sound packs…
        </Button>
        <Button
          startIcon={<AudioFileIcon />}
          variant="outlined"
          size="small"
          data-testid="alerts-my-sounds"
          onClick={onOpenMySounds}
        >
          My sounds…
        </Button>
        <Tooltip title="Copy every alert as one share string">
          <span>
            <Button
              startIcon={<IosShareIcon />}
              variant="outlined"
              size="small"
              disabled={!hasAlerts}
              onClick={onCopyAll}
            >
              Copy all
            </Button>
          </span>
        </Tooltip>
        <Button
          startIcon={<FileUploadIcon />}
          variant="outlined"
          size="small"
          onClick={onOpenImport}
        >
          Import…
        </Button>
        <Button
          startIcon={<RestartAltIcon />}
          variant="outlined"
          size="small"
          color="warning"
          onClick={onReset}
        >
          Reset to defaults
        </Button>
      </Stack>
    </Paper>
  )
}
