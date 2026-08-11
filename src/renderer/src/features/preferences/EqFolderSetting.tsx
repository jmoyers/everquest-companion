// EqFolderSetting — the Preferences "Game" section's one card: the EverQuest install folder.
//
// Moved out of PreferencesView.tsx unchanged, for the same reason UpdateSetting.tsx already
// lives beside it: that file is the settings TABLE plus the rail/search shell, and a section's
// actual UI belongs next to it, not inside it. Behaviour, copy and markup are byte-identical to
// what was there before — this is a factoring move, nothing else.
//
// The effective path, a chip saying how it resolved, the folder picker + auto-detection reset,
// and validation feedback (how many character logs are under <root>\Logs). Changes apply live —
// main re-lists characters, re-tails if the active log moved, and pushes eqconfig:changed, which
// we listen to so this stays correct no matter who changed it.

import { type JSX, useCallback, useEffect, useState } from 'react'
import { Alert, Box, Button, Chip, Stack, Typography } from '@mui/material'
import FolderOpenIcon from '@mui/icons-material/FolderOpen'
import DescriptionIcon from '@mui/icons-material/Description'
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh'
import type { EqConfig } from '@shared/types'

const SOURCE_CHIP: Record<EqConfig['source'], { label: string; color: 'success' | 'info' | 'warning' }> = {
  manual: { label: 'manual', color: 'info' },
  auto: { label: 'auto-detected', color: 'success' },
  default: { label: 'default (unverified)', color: 'warning' }
}

/** One labelled monospace path row. */
function PathRow({
  label,
  path,
  testId
}: {
  label: string
  path: string | undefined
  testId: string
}): JSX.Element {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      <Typography
        variant="body2"
        data-testid={testId}
        sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}
        title={path}
      >
        {path ?? '-'}
      </Typography>
    </Box>
  )
}

/**
 * The effective paths, plus a chip saying how the install root resolved. Set off by a
 * background fill, NOT a border: the item card around it is the one border level in this
 * view (no boxes in boxes).
 *
 * BOTH paths are shown, and the second one is the point (JOS-82). The card used to print
 * the install ROOT alone, while what the user picks is normalized — pick `…\EverQuest
 * Legends\Logs` and the row snaps to its PARENT. To the person who just chose a folder
 * that reads as the app quietly refusing the change ("Wont let me change the Everquest
 * Legends folder"), because the string on screen is not the string they picked and nothing
 * says why. Naming the folder the app actually READS makes the pick visible, and it is the
 * line that matters anyway — it is where the `eqlog_*.txt` files have to be.
 */
function EqFolderPath({ config }: { config: EqConfig | null }): JSX.Element {
  const chip = config ? SOURCE_CHIP[config.source] : null
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 1,
        flexWrap: 'wrap',
        p: 1.25,
        borderRadius: 1,
        bgcolor: 'action.hover'
      }}
    >
      <Stack spacing={0.75} sx={{ minWidth: 0, flexGrow: 1 }}>
        <PathRow label="Install folder" path={config?.root} testId="eq-folder-path" />
        <PathRow label="Reading logs from" path={config?.logsDir} testId="eq-folder-logs-path" />
      </Stack>
      {chip && <Chip size="small" label={chip.label} color={chip.color} variant="outlined" />}
    </Box>
  )
}

/**
 * Validation feedback for the folder the app is really reading. Nothing is claimed until the
 * config has actually arrived, so a fresh mount shows no verdict rather than a momentary
 * "no logs found" that is only true because we haven't looked.
 *
 * FOUR VERDICTS, NOT TWO (JOS-82). `characterCount === 0` used to print one sentence — go turn
 * `/log on` — for three different situations, one of which is "Windows would not let me list
 * that folder at all". Telling someone who is staring at their logs in Explorer to enable
 * logging is a silent wrong answer of exactly the kind JOS-53 was about; `config.readable`
 * carries the difference so each case gets advice that can actually work.
 */
function EqFolderCheck({ config }: { config: EqConfig | null }): JSX.Element | null {
  if (!config) return null
  // variant="standard": a tonal fill, no border ring — same no-boxes-in-boxes rule.
  if (config.readable === 'unreadable') {
    return (
      <Alert severity="error" variant="standard" data-testid="eq-folder-check">
        This folder could not be read ({config.readError ?? 'unknown error'}). Its files may be
        blocked by permissions or security software, or it may be a broken shortcut. Try
        choosing one of the log files directly.
      </Alert>
    )
  }
  if (config.readable === 'missing') {
    return (
      <Alert severity="warning" variant="standard" data-testid="eq-folder-check">
        This folder doesn&apos;t exist. Pick the folder your <code>eqlog_*.txt</code> files are
        in - or pick one of the files itself.
      </Alert>
    )
  }
  const found = config.characterCount
  return found > 0 ? (
    <Alert severity="success" variant="standard" data-testid="eq-folder-check">
      Found {found} character log{found === 1 ? '' : 's'} in this folder.
    </Alert>
  ) : (
    <Alert severity="warning" variant="standard" data-testid="eq-folder-check">
      No character logs (eqlog_*.txt) found here. Make sure EverQuest logging is enabled
      (/log on), then pick the folder those files are in - or pick one of the files itself.
    </Alert>
  )
}

export function EqFolderSetting(): JSX.Element {
  const [config, setConfig] = useState<EqConfig | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.eq.getEqConfig().then(setConfig)
    return window.eq.onEqConfigChanged(setConfig)
  }, [])

  const pick = useCallback(async () => {
    setBusy(true)
    try {
      const res = await window.eq.pickEqDir()
      setConfig(res.config)
    } finally {
      setBusy(false)
    }
  }, [])

  /**
   * THE OTHER DIALOG (JOS-82). Windows' folder picker lists only folders, and a real EQ
   * `Logs` directory has no subfolders — so someone hunting for the `eqlog_*.txt` this very
   * card names is shown an empty pane and concludes the app cannot see their files. Main
   * normalizes a picked FILE to the same {root, logsDir} a picked folder gives, so this is
   * the identical flow through a dialog that can actually display them.
   */
  const pickFile = useCallback(async () => {
    setBusy(true)
    try {
      const res = await window.eq.pickEqLogFile()
      setConfig(res.config)
    } finally {
      setBusy(false)
    }
  }, [])

  const reset = useCallback(async () => {
    setBusy(true)
    try {
      setConfig(await window.eq.resetEqDir())
    } finally {
      setBusy(false)
    }
  }, [])

  return (
    <Stack spacing={1.5}>
      <EqFolderPath config={config} />

      <EqFolderCheck config={config} />

      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
        <Button
          variant="contained"
          size="small"
          startIcon={<FolderOpenIcon />}
          onClick={() => void pick()}
          disabled={busy}
        >
          Choose folder…
        </Button>
        {/* The label is the whole explanation, per the caveat diet: a person who could not
            find their files in the folder dialog reads "Choose log file…" and knows what to
            press. No tooltip, no footnote about how the OS dialog works. */}
        <Button
          variant="outlined"
          size="small"
          startIcon={<DescriptionIcon />}
          onClick={() => void pickFile()}
          disabled={busy}
          data-testid="eq-folder-pick-file"
        >
          Choose log file…
        </Button>
        <Button
          variant="outlined"
          size="small"
          startIcon={<AutoFixHighIcon />}
          onClick={() => void reset()}
          disabled={busy || !config?.overridden}
        >
          Use auto-detection
        </Button>
      </Stack>
    </Stack>
  )
}
