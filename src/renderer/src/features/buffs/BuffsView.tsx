import type { JSX } from 'react'
import { useEffect, useMemo, useState } from 'react'
import {
  Box,
  Chip,
  Collapse,
  FormControlLabel,
  IconButton,
  Paper,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography
} from '@mui/material'
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh'
import ScienceOutlinedIcon from '@mui/icons-material/ScienceOutlined'
import type { ActiveBuff, BuffsDelta, BuffsSnap, MessageOverlay, OverlayVerdict } from '@shared/types'
import { useModule } from '../../lib/useModule'
import { ActiveRow } from './ActiveBuffRow'
import { groupKey, groupLabel } from './format'
import { Tooltip } from '../../lib/Tooltip'
// The durations tables, their search and the allow-list box on every row (JOS-168) — split into
// their own file because this one is at the 400-code-line factoring ceiling.
import { BuffStats } from './BuffStats'
import { useBuffAllow } from './useBuffAllow'

// Stable empty reference so hooks don't churn before hydration.
const EMPTY_BUFFS: BuffsSnap = { active: [], stats: {} }

// The buffs module ships its whole (small) snapshot each flush, so the delta simply
// replaces state — no incremental merge needed.
const applyBuffsDelta = (_state: BuffsSnap, delta: BuffsDelta): BuffsSnap => delta

// Verdict → chip color + label for the overlay audit table (Task #36).
const VERDICT_COLOR: Record<OverlayVerdict, 'success' | 'info' | 'error' | 'default'> = {
  verified: 'success',
  shared: 'info',
  'contradicts-wiki': 'error',
  unknown: 'default'
}
const VERDICT_LABEL: Record<OverlayVerdict, string> = {
  verified: 'verified',
  shared: 'shared',
  'contradicts-wiki': 'contradicts wiki',
  unknown: 'unknown'
}

/**
 * Diagnostics table (read-only): per-message verdicts. Collapsed behind an
 * unobtrusive icon-button — no explanatory prose, just the data.
 */
function OverlayDiagnostics({ overlay }: { overlay: MessageOverlay }): JSX.Element {
  const [open, setOpen] = useState(false)
  const rows = useMemo(
    () => overlay.messages.filter((m) => m.verdict !== 'unknown').slice(0, 200),
    [overlay.messages]
  )
  return (
    <Box>
      <Stack direction="row" alignItems="center" spacing={0.5}>
        <Box sx={{ flexGrow: 1 }} />
        <Tooltip title="Diagnostics">
          <IconButton size="small" onClick={() => setOpen((v) => !v)}>
            <ScienceOutlinedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>
      <Collapse in={open} unmountOnExit>
        <Paper variant="outlined" sx={{ mt: 1, p: 1, maxHeight: 380, overflow: 'auto' }}>
          <Table size="small" sx={{ '& td, & th': { py: 0.4, fontSize: 12 } }}>
            <TableHead>
              <TableRow>
                <TableCell>Message</TableCell>
                <TableCell>role</TableCell>
                <TableCell>verdict</TableCell>
                <TableCell align="right">n</TableCell>
                <TableCell>spell(s) · count</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((m) => (
                <TableRow key={`${m.role}:${m.text}`} hover>
                  <TableCell sx={{ fontFamily: 'monospace', maxWidth: 320 }}>{m.text}</TableCell>
                  <TableCell sx={{ color: 'text.secondary' }}>{m.role}</TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      variant="outlined"
                      color={VERDICT_COLOR[m.verdict]}
                      label={VERDICT_LABEL[m.verdict]}
                      sx={{ height: 16, fontSize: 10, '& .MuiChip-label': { px: 0.5 } }}
                    />
                  </TableCell>
                  <TableCell align="right">{m.total}</TableCell>
                  <TableCell sx={{ color: 'text.secondary', maxWidth: 340 }}>
                    {m.verdict === 'contradicts-wiki' && m.wikiConflict ? (
                      <Tooltip title={`wiki claims: "${m.wikiConflict.wikiText}"`}>
                        <span>
                          {m.spells.map((s) => `${s.spell}:${s.count}`).join(', ')}{' '}
                          <span style={{ opacity: 0.6 }}>(wiki ≠ observed)</span>
                        </span>
                      </Tooltip>
                    ) : (
                      m.spells
                        .slice(0, 8)
                        .map((s) => `${s.spell}:${s.count}`)
                        .join(', ') + (m.spells.length > 8 ? ' …' : '')
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Paper>
      </Collapse>
    </Box>
  )
}

/**
 * THE PERMANENT BUFFS, HIDDEN BY DEFAULT (JOS-215, owner ruling) — the tab's half of the overlay's
 * `showPermanent` switch, and deliberately NOT the same storage.
 *
 * The overlay's answer rides its per-kind `OverlayConfig` because a floating window remembers
 * everything about itself there; a tab's view preference is renderer state and lives where this
 * app's other view preferences live (the loot sort, the boss density) — one localStorage key, read
 * once. Two surfaces, two readings: the window over the game and the page you open to audit the
 * model are looked at for different reasons, and neither should silently re-scope the other.
 *
 * A MISSING KEY IS HIDDEN, which is what makes "absent" and "the default" the same fact.
 */
const SHOW_PERMANENT_KEY = 'eq.buffs.showPermanent'

function readShowPermanent(): boolean {
  return localStorage.getItem(SHOW_PERMANENT_KEY) === '1'
}

/** The section header for Active: the word, and the switch for the buffs that never expire. */
function ActiveHeader({
  permanentCount,
  showPermanent,
  onToggle
}: {
  permanentCount: number
  showPermanent: boolean
  onToggle: () => void
}): JSX.Element {
  return (
    <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5 }}>
      <Typography variant="subtitle2">Active</Typography>
      {/* The chip is absent when there is nothing to reveal — a switch for an empty set would be
          the app inviting you to look at nothing. Its label carries the COUNT, which is the whole
          answer for a user who only wanted to know whether any are up. */}
      {permanentCount > 0 && (
        <Chip
          size="small"
          data-testid="buffs-show-permanent"
          variant={showPermanent ? 'filled' : 'outlined'}
          color={showPermanent ? 'warning' : 'default'}
          onClick={onToggle}
          label={`${permanentCount} permanent`}
          title={
            showPermanent
              ? 'Showing buffs that never expire. Click to hide them.'
              : 'Buffs that never expire are hidden. Click to show them.'
          }
          sx={{ height: 18, fontSize: 11 }}
        />
      )}
    </Stack>
  )
}

/** One entity's live buffs: its label, a count chip, and the row grid. */
function ActiveGroup({
  label,
  buffs,
  now
}: {
  label: string
  buffs: ActiveBuff[]
  now: number
}): JSX.Element {
  return (
    <Box>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5 }}>
        <Typography variant="caption" sx={{ fontWeight: 600 }}>
          {label}
        </Typography>
        <Chip
          size="small"
          variant="outlined"
          label={buffs.length}
          sx={{ height: 16, fontSize: 10, '& .MuiChip-label': { px: 0.5 } }}
        />
      </Stack>
      <Box sx={{ display: 'grid', gap: 1, gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
        {buffs.map((b) => (
          <ActiveRow key={`${b.spell}@${b.self ? 'self' : b.target ?? '?'}`} buff={b} now={now} />
        ))}
      </Box>
    </Box>
  )
}

/**
 * THE MODE SWITCH, AND IT LIVES HERE RATHER THAN IN PREFERENCES (JOS-168, owner amendment
 * 2026-08-16). The 2026-08-14 design put it in Preferences; the owner moved it onto this tab,
 * beside the boxes it gives meaning to — a control that changes what every checkbox on the page
 * MEANS belongs on the page with the checkboxes.
 *
 * It is still a real preference (it is persisted in the settings store and reaches the overlay
 * windows), so only its UI home moved. OFF is the shipped answer and off is invisible: there are
 * NO boxes on the page and both timer windows draw exactly what they always drew. ON is what puts
 * the boxes on every card and durations row (owner ruling 2026-08-17: "opt-in, or no choice").
 */
function AllowModeSwitch({ optIn, onChange }: { optIn: boolean; onChange: (v: boolean) => void }): JSX.Element {
  return (
    <FormControlLabel
      control={
        <Switch
          size="small"
          checked={optIn}
          data-testid="buffs-allow-mode"
          data-opt-in={optIn ? 'true' : 'false'}
          slotProps={{ input: { 'aria-label': 'Only track buffs and debuffs I check' } }}
          onChange={(e) => {
            onChange(e.target.checked)
          }}
        />
      }
      label={
        <Typography variant="caption" color="text.secondary">
          Only track buffs and debuffs I check
        </Typography>
      }
      sx={{ ml: 0 }}
    />
  )
}

export default function BuffsView(): JSX.Element {
  const snap = useModule<BuffsSnap, BuffsDelta>('buffs', applyBuffsDelta) ?? EMPTY_BUFFS
  // Tick once a second so active-buff elapsed/remaining stay live between deltas.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  // HIDDEN BY DEFAULT (JOS-215) — a display filter over the snapshot, never a request to the
  // model. `snap.active` keeps every row; this page just chooses which to draw.
  const [showPermanent, setShowPermanent] = useState(readShowPermanent)
  const permanentCount = useMemo(() => snap.active.filter((b) => b.permanent === true).length, [snap.active])
  const active = useMemo(
    () => (showPermanent ? snap.active : snap.active.filter((b) => b.permanent !== true)),
    [snap.active, showPermanent]
  )
  const minedCount = Object.values(snap.stats).filter((s) => s.n > 0).length
  // THE ALLOW-LIST'S MODE (JOS-168). The verdicts themselves are read by each checkbox from the
  // same one-per-window store, so this page only needs the switch's own half.
  const { prefs: allow, setOptIn } = useBuffAllow(window.eq)

  // PRIORITY layout (Task #35): "Your buffs" (self) FIRST, then one group per bound entity
  // sorted by liveliness/recency (most-recently-refreshed entity first — the current pet
  // naturally tops this). Buff vs debuff is a per-row style (classAccent), not a group.
  const activeGroups = useMemo(() => {
    const byKey = new Map<string, ActiveBuff[]>()
    for (const b of active) {
      const k = groupKey(b)
      const list = byKey.get(k)
      if (list) list.push(b)
      else byKey.set(k, [b])
    }
    const recency = (list: ActiveBuff[]): number => Math.max(...list.map((b) => b.startedTs))
    return [...byKey.entries()]
      .sort((a, b) => {
        if (a[0] === 'self') return -1 // self always first
        if (b[0] === 'self') return 1
        return recency(b[1]) - recency(a[1]) // then most-recent entity first
      })
      .map(([key, list]) => ({
        key,
        buffs: [...list].sort((x, y) => x.startedTs - y.startedTs)
      }))
  }, [active])
  return (
    <Stack spacing={2}>
      <Box>
        <Stack direction="row" alignItems="center" spacing={1}>
          <AutoFixHighIcon color="primary" />
          <Typography variant="h6">Buffs</Typography>
          {/* THE MODEL'S COUNT, not the drawn one (JOS-215): this chip summarizes what the app
              believes is up, and the permanent switch below decides what this page draws. A
              header that shrank when you hid a section would be reporting a preference as a fact. */}
          <Chip
            size="small"
            variant="outlined"
            label={`${snap.active.length} active · ${minedCount} tracked`}
          />
          <Box sx={{ flexGrow: 1 }} />
          {/* THE MODE, at the top of the tab (JOS-168) — what every checkbox below it means. */}
          <AllowModeSwitch optIn={allow.optIn} onChange={setOptIn} />
        </Stack>
      </Box>

      <Box>
        <ActiveHeader
          permanentCount={permanentCount}
          showPermanent={showPermanent}
          onToggle={() => {
            setShowPermanent((v) => {
              const next = !v
              localStorage.setItem(SHOW_PERMANENT_KEY, next ? '1' : '0')
              return next
            })
          }}
        />
        {active.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No active buffs.
          </Typography>
        ) : (
          <Stack spacing={1.5}>
            {activeGroups.map((g) => (
              <ActiveGroup key={g.key} label={groupLabel(g.key)} buffs={g.buffs} now={now} />
            ))}
          </Stack>
        )}
      </Box>

      <BuffStats stats={snap.stats} />

      {snap.overlay && snap.overlay.messages.length > 0 ? (
        <OverlayDiagnostics overlay={snap.overlay} />
      ) : null}
    </Stack>
  )
}
