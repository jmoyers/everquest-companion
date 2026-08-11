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
// NOTHING IS CLOCKED UNTIL YOU SAY SO (owner ruling, 2026-08-10 — argued in shared/respawn.ts).
// The right-hand panel is therefore the ONLY way a row ever appears on the left, which makes the
// two panels a single flow rather than a list and its settings: the empty state on the left points
// at the panel on the right, and the panel on the right is a list of things that have actually
// died rather than a catalog to go shopping in.
//
// AND THE PAGE IS SCOPED TO ONE ZONE (same ruling). The scope switch at the top defaults to the
// zone the fold is in and the whole page obeys it — clocks AND recently-killed — because "what can
// I do about this right now" is a question about where you are standing. All zones is one click
// away and is what you want when you are setting up a camp you are not in yet; the counts on the
// switch say how much is hiding either way, so the default never silently swallows anything.
//
// The number in the box beside a watched mob is rung 1 of the ladder — your own respawn, in
// seconds — and it outranks everything, including what this app learned. A player camping a spot
// knows more about it than the wiki and more than a handful of gaps.

import { useState, type JSX } from 'react'
import {
  Box,
  Button,
  Chip,
  Divider,
  IconButton,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography
} from '@mui/material'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline'
import {
  RESPAWN_CUSTOM_MAX_SEC,
  RESPAWN_CUSTOM_MIN_SEC,
  respawnInZone,
  type RespawnCandidate,
  type RespawnPrefs,
  type RespawnRow
} from '@shared/respawn'
import Tooltip from '../../lib/Tooltip'
import { fmtDuration } from '../buffs/format'
import { RespawnRowBar } from './RespawnRowBar'
import { useRespawnSnap, useSecondsClock, useSetRespawnPrefs } from './useRespawn'

/** Which zone the page is showing. Component state: a view mode, not a preference. */
type Scope = 'zone' | 'all'

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
      {/* `watched` is the MODULE's answer, not a second one worked out here from the same
          snapshot's prefs — one fact, one owner. */}
      {cand.watched ? (
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
          Watch
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

function ClocksPanel({
  rows,
  nowMs,
  elsewhere,
  zoneName
}: {
  rows: RespawnRow[]
  nowMs: number
  /** How many clocks the scope is hiding. Stated, never silently dropped. */
  elsewhere: number
  zoneName: string
}): JSX.Element {
  if (rows.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary" data-testid="respawn-empty" sx={{ py: 2 }}>
        {elsewhere > 0
          ? `No clocks running in ${zoneName}. ${elsewhere} ${elsewhere === 1 ? 'is' : 'are'} running in other zones - switch to All zones to see them.`
          : 'No clocks running. Kill something, then click Watch beside it on the right - the clock starts from the kill you already made.'}
      </Typography>
    )
  }
  return (
    <Stack spacing={0.75} data-testid="respawn-rows">
      {rows.map((row) => (
        <RespawnRowBar key={row.id} row={row} nowMs={nowMs} />
      ))}
    </Stack>
  )
}

/** The scope switch, and the counts that say what each side is holding. */
function ScopeSwitch({
  scope,
  onScope,
  zoneName,
  here,
  total
}: {
  scope: Scope
  onScope: (s: Scope) => void
  zoneName: string
  here: number
  total: number
}): JSX.Element {
  return (
    <ToggleButtonGroup
      size="small"
      exclusive
      data-testid="respawn-scope"
      value={scope}
      onChange={(_e, v: Scope | null) => {
        // MUI hands back null when the pressed button was already selected; a scope must always
        // have a value, so that click is a no-op rather than an unscoped page.
        if (v !== null) onScope(v)
      }}
    >
      <ToggleButton data-testid="respawn-scope-zone" value="zone">
        {zoneName} ({here})
      </ToggleButton>
      <ToggleButton data-testid="respawn-scope-all" value="all">
        All zones ({total})
      </ToggleButton>
    </ToggleButtonGroup>
  )
}

export default function TimersView(): JSX.Element {
  const snap = useRespawnSnap()
  const nowMs = useSecondsClock()
  const setPrefs = useSetRespawnPrefs()
  const prefs = snap.prefs
  const [scope, setScope] = useState<Scope>('zone')

  // The zone name as the switch and the empty states say it. The fold has no zone before the log
  // states one, and "this zone" is then a claim it cannot make.
  const zoneName = snap.zone.length > 0 ? snap.zone : 'Unknown zone'
  const hereRows = respawnInZone(snap.rows, snap.zone)
  const hereRecent = respawnInZone(snap.recent, snap.zone)
  const rows = scope === 'zone' ? hereRows : snap.rows
  const recent = scope === 'zone' ? hereRecent : snap.recent

  return (
    <Box sx={{ p: 2, height: '100%', overflow: 'auto' }} data-testid="timers-view">
      <Stack direction="row" spacing={1} alignItems="baseline" sx={{ mb: 0.5 }}>
        <Typography variant="h6">Respawn clocks</Typography>
        {snap.zone.length > 0 && <Chip size="small" label={snap.zone} variant="outlined" />}
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2, maxWidth: 760 }}>
        A clock starts when the log prints a death message, for the mobs you have asked to watch -
        nothing is tracked until you click Watch. The number on it comes from your own kills - the
        shortest gap between two deaths of that mob in one continuous stay in the zone, which is an
        upper bound on the real respawn and tightens as you camp. The wiki is only the default
        before you have a gap of your own, and a floor underneath the ones you do have. A clock
        reaching zero means the estimate elapsed, never that the mob is standing there.
      </Typography>

      <Box sx={{ mb: 2 }}>
        <ScopeSwitch
          scope={scope}
          onScope={setScope}
          zoneName={zoneName}
          here={hereRows.length}
          total={snap.rows.length}
        />
      </Box>

      <Stack direction={{ xs: 'column', md: 'row' }} spacing={3} alignItems="flex-start">
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            Running
          </Typography>
          <ClocksPanel
            rows={rows}
            nowMs={nowMs}
            elsewhere={scope === 'zone' ? snap.rows.length - hereRows.length : 0}
            zoneName={zoneName}
          />
        </Box>

        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            Recently killed
          </Typography>
          {recent.length === 0 ? (
            <Typography variant="body2" color="text.secondary" data-testid="respawn-recent-empty">
              {scope === 'zone' && snap.recent.length > 0
                ? `Nothing has died in ${zoneName} yet. Switch to All zones for what you killed elsewhere.`
                : 'Nothing has died yet in this log.'}
            </Typography>
          ) : (
            <Stack data-testid="respawn-recent" divider={<Divider flexItem />}>
              {recent.map((c) => (
                <CandidateRow key={`${c.zone}::${c.key}`} cand={c} prefs={prefs} onSet={setPrefs} />
              ))}
            </Stack>
          )}

          <Divider sx={{ my: 2 }} />
          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            Your watches
          </Typography>
          {prefs.watches.length === 0 ? (
            <Typography variant="body2" color="text.secondary" data-testid="respawn-watches-empty">
              None yet. A mob you watch here is the only kind that gets a clock, and it can carry
              your own number, which outranks everything the app worked out.
            </Typography>
          ) : (
            <Stack divider={<Divider flexItem />}>
              {prefs.watches.map((w) => (
                <WatchEditorRow key={w.key} watch={w} prefs={prefs} onSet={setPrefs} />
              ))}
            </Stack>
          )}
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
            A watch follows the MOB NAME, so it clocks that name in every zone you kill it in - the
            list above shows the zone you are in unless you ask for all of them. Custom respawns run
            from {fmtDuration(RESPAWN_CUSTOM_MIN_SEC * 1000)} to{' '}
            {fmtDuration(RESPAWN_CUSTOM_MAX_SEC * 1000)}. Leave the box empty to go back to what
            your kills say.
          </Typography>
        </Box>
      </Stack>
    </Box>
  )
}
