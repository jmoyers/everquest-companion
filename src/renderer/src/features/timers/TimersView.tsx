// THE TIMERS TAB — respawn clocks started by death messages (JOS-194).
//
// Two panels, and the second one is why the feature is usable on the first kill of a fresh
// install rather than after a configuration session:
//
//   LEFT   the live clocks. One row per watched mob that has died, counting down.
//   RIGHT  what you just killed. Every mob whose death this fold has seen recently, each with a
//          one-click Watch. Clicking it does not merely arm the FUTURE — the module already holds
//          the death, so the clock starts from the kill you already made. That is the whole
//          discoverability story: kill something, look at this tab, click Watch, see a clock.
//
// The number in the box beside a watched mob is rung 1 of the ladder — your own respawn, in
// seconds — and it outranks everything, including what this app learned. A player camping a spot
// knows more about it than the wiki and more than a handful of gaps.

import { useState, type JSX } from 'react'
import {
  Box,
  Button,
  Checkbox,
  Chip,
  Divider,
  FormControlLabel,
  IconButton,
  Stack,
  TextField,
  Typography
} from '@mui/material'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline'
import {
  RESPAWN_CUSTOM_MAX_SEC,
  RESPAWN_CUSTOM_MIN_SEC,
  type RespawnCandidate,
  type RespawnPrefs,
  type RespawnSnap
} from '@shared/respawn'
import Tooltip from '../../lib/Tooltip'
import { fmtDuration } from '../buffs/format'
import { RespawnRowBar } from './RespawnRowBar'
import { useRespawnSnap, useSecondsClock, useSetRespawnPrefs } from './useRespawn'

/** Add or update one watch, leaving the rest of the list alone. */
function withWatch(prefs: RespawnPrefs, key: string, display: string, customSec?: number): RespawnPrefs {
  const rest = prefs.watches.filter((w) => w.key !== key)
  const entry = customSec === undefined ? { key, display } : { key, display, customSec }
  return { ...prefs, watches: [...rest, entry] }
}

function withoutWatch(prefs: RespawnPrefs, key: string): RespawnPrefs {
  return { ...prefs, watches: prefs.watches.filter((w) => w.key !== key) }
}

function CandidateRow({
  cand,
  prefs,
  onSet
}: {
  cand: RespawnCandidate
  prefs: RespawnPrefs
  onSet: (next: RespawnPrefs) => void
}): JSX.Element {
  const explicit = prefs.watches.find((w) => w.key === cand.key)
  return (
    <Stack
      direction="row"
      spacing={1}
      alignItems="center"
      data-testid="respawn-candidate"
      data-respawn-mob={cand.key}
      sx={{ py: 0.5 }}
    >
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="body2" noWrap>
          {cand.display}
        </Typography>
        <Typography variant="caption" color="text.secondary" noWrap>
          {cand.zone.length > 0 ? cand.zone : 'unknown zone'} · {cand.kills} kill
          {cand.kills === 1 ? '' : 's'}
          {cand.wikiText !== undefined ? ` · wiki: ${cand.wikiText}` : ''}
        </Typography>
      </Box>
      {explicit ? (
        <Tooltip title="Stop watching this mob">
          <IconButton
            size="small"
            data-testid="respawn-unwatch"
            onClick={() => {
              onSet(withoutWatch(prefs, cand.key))
            }}
          >
            <DeleteOutlineIcon fontSize="inherit" />
          </IconButton>
        </Tooltip>
      ) : (
        <Button
          size="small"
          variant="outlined"
          data-testid="respawn-watch"
          onClick={() => {
            onSet(withWatch(prefs, cand.key, cand.display))
          }}
        >
          {cand.watched ? 'Pin' : 'Watch'}
        </Button>
      )}
    </Stack>
  )
}

function WatchEditorRow({
  watch,
  prefs,
  onSet
}: {
  watch: { key: string; display: string; customSec?: number }
  prefs: RespawnPrefs
  onSet: (next: RespawnPrefs) => void
}): JSX.Element {
  const [draft, setDraft] = useState(watch.customSec === undefined ? '' : String(watch.customSec))
  return (
    <Stack direction="row" spacing={1} alignItems="center" data-testid="respawn-watch-row" sx={{ py: 0.5 }}>
      <Typography variant="body2" sx={{ flex: 1, minWidth: 0 }} noWrap>
        {watch.display}
      </Typography>
      <TextField
        size="small"
        label="seconds"
        value={draft}
        data-testid="respawn-custom"
        sx={{ width: 110 }}
        onChange={(e) => {
          setDraft(e.target.value)
        }}
        onBlur={() => {
          const n = Number(draft.trim())
          const ok = Number.isFinite(n) && n >= RESPAWN_CUSTOM_MIN_SEC && n <= RESPAWN_CUSTOM_MAX_SEC
          // An unreadable or out-of-range entry CLEARS the custom number rather than keeping a
          // half-typed one: the ladder then falls back to your kills, which is a real answer.
          onSet(withWatch(prefs, watch.key, watch.display, ok ? Math.round(n) : undefined))
        }}
      />
      <IconButton
        size="small"
        onClick={() => {
          onSet(withoutWatch(prefs, watch.key))
        }}
      >
        <DeleteOutlineIcon fontSize="inherit" />
      </IconButton>
    </Stack>
  )
}

function ClocksPanel({ snap, nowMs }: { snap: RespawnSnap; nowMs: number }): JSX.Element {
  if (snap.rows.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary" data-testid="respawn-empty" sx={{ py: 2 }}>
        No clocks running. Kill something, then click Watch beside it on the right - the clock
        starts from the kill you already made.
      </Typography>
    )
  }
  return (
    <Stack spacing={0.75} data-testid="respawn-rows">
      {snap.rows.map((row) => (
        <RespawnRowBar key={row.id} row={row} nowMs={nowMs} />
      ))}
    </Stack>
  )
}

export default function TimersView(): JSX.Element {
  const snap = useRespawnSnap()
  const nowMs = useSecondsClock()
  const setPrefs = useSetRespawnPrefs()
  const prefs = snap.prefs

  return (
    <Box sx={{ p: 2, height: '100%', overflow: 'auto' }} data-testid="timers-view">
      <Stack direction="row" spacing={1} alignItems="baseline" sx={{ mb: 0.5 }}>
        <Typography variant="h6">Respawn clocks</Typography>
        {snap.zone.length > 0 && <Chip size="small" label={snap.zone} variant="outlined" />}
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2, maxWidth: 760 }}>
        A clock starts when the log prints a death message. The number on it comes from your own
        kills - the shortest gap between two deaths of that mob in one continuous stay in the zone,
        which is an upper bound on the real respawn and tightens as you camp. The wiki is only the
        default before you have a gap of your own, and a floor underneath the ones you do have. A
        clock reaching zero means the estimate elapsed, never that the mob is standing there.
      </Typography>

      <Stack direction={{ xs: 'column', md: 'row' }} spacing={3} alignItems="flex-start">
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            Running
          </Typography>
          <ClocksPanel snap={snap} nowMs={nowMs} />
        </Box>

        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            Recently killed
          </Typography>
          {snap.recent.length === 0 ? (
            <Typography variant="body2" color="text.secondary" data-testid="respawn-recent-empty">
              Nothing has died yet in this log.
            </Typography>
          ) : (
            <Stack data-testid="respawn-recent" divider={<Divider flexItem />}>
              {snap.recent.map((c) => (
                <CandidateRow key={`${c.zone}::${c.key}`} cand={c} prefs={prefs} onSet={setPrefs} />
              ))}
            </Stack>
          )}

          <Divider sx={{ my: 2 }} />
          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            Your watches
          </Typography>
          <FormControlLabel
            control={
              <Checkbox
                size="small"
                checked={prefs.autoWiki}
                data-testid="respawn-auto-wiki"
                onChange={(e) => {
                  setPrefs({ ...prefs, autoWiki: e.target.checked })
                }}
              />
            }
            label={
              <Typography variant="body2">
                Also clock anything the wiki states a respawn for
              </Typography>
            }
          />
          {prefs.watches.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              None yet. A watch you add here is pinned to the top of the list and can carry your own
              number, which outranks everything the app worked out.
            </Typography>
          ) : (
            <Stack divider={<Divider flexItem />}>
              {prefs.watches.map((w) => (
                <WatchEditorRow key={w.key} watch={w} prefs={prefs} onSet={setPrefs} />
              ))}
            </Stack>
          )}
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
            Custom respawns run from {fmtDuration(RESPAWN_CUSTOM_MIN_SEC * 1000)} to{' '}
            {fmtDuration(RESPAWN_CUSTOM_MAX_SEC * 1000)}. Leave the box empty to go back to what
            your kills say.
          </Typography>
        </Box>
      </Stack>
    </Box>
  )
}
