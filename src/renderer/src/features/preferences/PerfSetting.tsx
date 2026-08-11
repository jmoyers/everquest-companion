// PerfSetting — Preferences → Performance (docs/plans/perf-profiling.md P5).
//
// TWO THINGS, and they are deliberately in one section because they answer one question:
//
//   THE HUD SWITCH — off by default. Turning it on puts a live `CPU 12% · 480 MB` chip in the
//   title bar and starts the 2 s sampler in main; turning it off stops it and removes the chip.
//   Nothing about it is subtle, and nothing about it runs while it is off.
//
//   LAST STARTUP — read-only, and recorded on EVERY launch whether the HUD was on or not. This
//   is the half that answers "why was that reload stuttery" AFTER the fact, from inside the app,
//   which is the whole reason the marks are unconditional (plan P4).
//
// STATE, NEVER PROCESS (the repo's UI law): the captions say what the setting does and what the
// numbers mean. Nothing here explains samplers, probes or IPC — the user asked to see how the
// app is behaving, not how it looks at itself.
//
// ONE BORDER: PreferencesView already wraps each item in an outlined Paper, so this renders bare
// Stacks.

import { type JSX, useCallback, useEffect, useState } from 'react'
import { Box, Button, Chip, FormControlLabel, Stack, Switch, Typography } from '@mui/material'
import SpeedIcon from '@mui/icons-material/Speed'
import RestartAltIcon from '@mui/icons-material/RestartAlt'
import { DEV_TOOLS } from '../../devFlags'
import {
  DEFAULT_PERF_HUD_PREFS,
  formatMs,
  type PerfHudPrefs,
  type StartupPhase,
  type StartupProfile
} from '@shared/perf'
import { formatDateTime } from '../../lib/formatDate'
import type { PrefSection } from './PreferencesView'

/** What each phase is called in front of a person. The enum names are the code's vocabulary;
 *  these are the app's. */
const PHASE_LABEL: Record<StartupPhase, string> = {
  storeLoaded: 'Settings loaded',
  dataLoaded: 'Spell + mob knowledge loaded',
  appReady: 'Window system ready',
  protocols: 'Caches + services ready',
  windowCreated: 'Window created',
  tailAttached: 'Log session started',
  replayDone: 'Log history replayed',
  rendererHydrated: 'Interface drawn'
}

/** The switch, hydrated from main and written back on change — the VoiceSetting pattern. The
 *  reply is authoritative (it is what was actually stored), the local set is optimistic so the
 *  toggle never lags an IPC round trip. */
function usePerfHudPrefs(): [PerfHudPrefs, (enabled: boolean) => void] {
  const [prefs, setPrefs] = useState<PerfHudPrefs>(DEFAULT_PERF_HUD_PREFS)

  useEffect(() => {
    let alive = true
    void window.eq.getPerfPrefs().then((stored) => {
      if (alive) setPrefs(stored)
    })
    return () => {
      alive = false
    }
  }, [])

  const setEnabled = useCallback((enabled: boolean) => {
    setPrefs({ enabled })
    void window.eq.setPerfHudEnabled(enabled).then(setPrefs)
  }, [])

  return [prefs, setEnabled]
}

/** One phase's row: its name, a bar proportional to its share of the launch, and its duration. */
function PhaseBar({ label, ms, share }: { label: string; ms: number; share: number }): JSX.Element {
  return (
    <Stack direction="row" alignItems="center" spacing={1}>
      <Typography variant="caption" sx={{ width: 190, flexShrink: 0 }} color="text.secondary">
        {label}
      </Typography>
      <Box sx={{ flexGrow: 1, minWidth: 0, height: 8, bgcolor: 'action.hover', borderRadius: 1 }}>
        <Box
          sx={{
            width: `${String(Math.max(share * 100, share > 0 ? 1 : 0))}%`,
            height: '100%',
            bgcolor: 'primary.main',
            borderRadius: 1
          }}
        />
      </Box>
      <Typography
        variant="caption"
        sx={{ width: 64, textAlign: 'right', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}
      >
        {formatMs(ms)}
      </Typography>
    </Stack>
  )
}

/** The read-only breakdown. Every phase, in boot order, with the total and what the replay cost
 *  in events — the number that makes a duration interpretable. */
function StartupBreakdown({ profile }: { profile: StartupProfile }): JSX.Element {
  const total = Math.max(1, profile.totalMs)
  return (
    <Stack spacing={0.75} data-testid="perf-startup">
      <Typography variant="body2">
        Last startup: <strong>{formatMs(profile.totalMs)}</strong>
        {profile.eventsReplayed === undefined
          ? ''
          : ` · ${profile.eventsReplayed.toLocaleString()} log events replayed`}
      </Typography>
      <Stack spacing={0.5}>
        {profile.phases.map((p) => (
          <PhaseBar
            key={p.phase}
            label={PHASE_LABEL[p.phase]}
            ms={p.durationMs}
            share={p.durationMs / total}
          />
        ))}
      </Stack>
      <Typography variant="caption" color="text.secondary">
        Launched {formatDateTime(profile.startedAt)}
        {profile.version ? ` · version ${profile.version}` : ''}
        {profile.complete ? '' : ' · this launch is still starting up'}
      </Typography>
    </Stack>
  )
}

/**
 * How long a restart may take before the button admits nothing is happening.
 *
 * Under `npm run dev` the restart is the electron-vite WATCHER's to perform (main only asks —
 * src/main/devRestart.ts), and the measured round trip is a ~2 s rebuild plus a fresh launch. Ten
 * seconds is comfortably past that, and the timer only ever fires in the case it exists for: a
 * dev server running WITHOUT `--watch`, where there is no watch hook and the ask goes nowhere.
 * In every working case this process is dead long before it elapses.
 */
const RESTART_STALL_MS = 10_000

/**
 * DEV-ONLY: restart the app (JOS-61; the watcher-aware rewrite is JOS-63).
 *
 * IT LIVES HERE, under the startup breakdown, because that is the readout it exists to refresh:
 * hand-testing startup performance is restart → read the new phases → repeat, and the two halves
 * of that loop belong on one card. (The other candidate was the dev-triage nav row, which is
 * where dev tooling lives — but the triage tab is about the feedback backlog, and a restart
 * button parked in it would be a second, unrelated meaning for that surface.)
 *
 * `DEV_TOOLS` folds to a compile-time literal (src/renderer/src/devFlags.ts, anchored on
 * `import.meta.env.DEV`), so in `electron-vite build` its one call site reads `false && …`,
 * rollup deletes the branch and then this now-unreferenced function with it. A COMPONENT rather
 * than a module-level element for exactly that reason (NavDrawer's note): a top-level `jsx()`
 * call is not something rollup can prove side-effect free and would keep the strings alive,
 * while a function nobody calls is plainly dead. MEASURED on `npm run build` output, not
 * assumed: `Restart app`, `restartApp` and `dev:restart` are all absent from `out/renderer`,
 * which is the shape every packaged build and every e2e launch runs.
 *
 * IT HAS A PENDING STATE NOW, and that is not decoration. JOS-61's click killed the process
 * instantly, so there was nothing to show. The watcher route asks somebody else to rebuild and
 * relaunch us, so for a couple of seconds the correct answer is "waiting" — and if the wait
 * outlives `RESTART_STALL_MS`, the honest answer is that nothing restarted and why. The one
 * thing main cannot detect is whether the dev server was started with `--watch` (the flag never
 * reaches this process), so the button reports the silence rather than pretending to know.
 *
 * The chip, not a tooltip, says what this is (the UI conventions' tooltip diet). Nothing
 * confirms: the whole point is that it is one click, and main's handler refuses outright in a
 * packaged build anyway (src/main/devRestart.ts).
 */
function DevRestartRow(): JSX.Element {
  const [phase, setPhase] = useState<'idle' | 'waiting' | 'stalled' | 'refused'>('idle')
  const [detail, setDetail] = useState<string | undefined>(undefined)

  const restart = useCallback(() => {
    setPhase('waiting')
    setDetail(undefined)
    const stall = setTimeout(() => setPhase('stalled'), RESTART_STALL_MS)
    void window.eq.restartApp().then((result) => {
      // 'relaunched' and 'watcher' both end with this process gone — there is nothing to render
      // for them beyond the waiting state already showing. Only a refusal has to be told.
      if (result.action !== 'refused') return
      clearTimeout(stall)
      setPhase('refused')
      setDetail(result.detail)
    })
  }, [])

  return (
    <Stack spacing={0.5}>
      <Stack direction="row" alignItems="center" spacing={1}>
        <Button
          size="small"
          variant="outlined"
          disabled={phase === 'waiting'}
          startIcon={<RestartAltIcon fontSize="small" />}
          data-testid="pref-dev-restart"
          onClick={restart}
        >
          {phase === 'waiting' ? 'Restarting…' : 'Restart app'}
        </Button>
        <Chip
          size="small"
          label="dev only"
          variant="outlined"
          color="warning"
          sx={{ height: 18, fontSize: 10, '& .MuiChip-label': { px: 0.75 } }}
        />
      </Stack>
      {phase !== 'idle' && (
        <Typography variant="caption" color="text.secondary" data-testid="pref-dev-restart-note">
          {phase === 'waiting' && 'Rebuilding - the dev watcher relaunches the app.'}
          {phase === 'stalled' &&
            'Nothing restarted. This dev server is running without --watch, so restart it from the terminal.'}
          {phase === 'refused' && `Restart refused${detail === undefined ? '' : ` - ${detail}`}.`}
        </Typography>
      )}
    </Stack>
  )
}

/**
 * The Preferences section this card belongs to — its label, icon and search keywords.
 *
 * It lives HERE rather than in PreferencesView (where its four siblings do) because that file
 * sits at the repo's 400-code-line factoring ceiling, and a split is the answer to that rather
 * than a widened threshold. Co-locating it is no loss: the words someone types to find this
 * setting belong with the setting.
 *
 * A SECTION rather than a line under "Updates" for the same reason analytics is one: the switch
 * is one control, but the read-only startup breakdown beside it is a diagnostic surface — the
 * thing you open AFTER a launch felt slow — and that does not belong tucked under something else.
 */
export function perfSection(): PrefSection {
  return {
    id: 'performance',
    label: 'Performance',
    icon: <SpeedIcon fontSize="small" />,
    items: [
      {
        id: 'perf-hud',
        label: 'Performance HUD',
        keywords:
          'performance perf cpu memory ram hud meter monitor lag stutter freeze slow jank fps startup boot launch profile speed diagnostics',
        content: <PerfSetting />
      }
    ]
  }
}

export function PerfSetting(): JSX.Element {
  const [prefs, setEnabled] = usePerfHudPrefs()
  const [profile, setProfile] = useState<StartupProfile | null>(null)

  useEffect(() => {
    let alive = true
    void window.eq.getStartupProfile().then((p) => {
      if (alive) setProfile(p)
    })
    return () => {
      alive = false
    }
  }, [])

  return (
    <Stack spacing={2} data-testid="pref-perf">
      <Stack spacing={0.5}>
        <FormControlLabel
          control={
            <Switch
              size="small"
              data-testid="pref-perf-enabled"
              checked={prefs.enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
          }
          label={<Typography variant="body2">Show CPU and memory in the title bar</Typography>}
        />
        <Typography variant="caption" color="text.secondary">
          {prefs.enabled
            ? 'A live reading sits in the title bar. Click it for a breakdown by process, how far behind the app is running, and the last two minutes. It turns amber or red only when the app is actually being held up - not merely when it is busy.'
            : 'Off. Nothing is measured and nothing is shown. Turn it on if the app ever feels like it is stuttering - a low reading here while the app feels slow says the machine is loaded, not this app.'}
        </Typography>
      </Stack>

      {profile && profile.phases.length > 0 ? (
        <StartupBreakdown profile={profile} />
      ) : (
        <Typography variant="caption" color="text.secondary">
          No startup breakdown recorded yet.
        </Typography>
      )}

      {DEV_TOOLS && <DevRestartRow />}
    </Stack>
  )
}
