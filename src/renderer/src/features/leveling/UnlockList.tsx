// UnlockList — the rows of the "New at this level" panel (docs/plans/levelup-whats-new.md §2).
//
// ONE ROW SHAPE FOR BOTH LISTS. A spell and a discipline answer the same question ("what did this
// level give me") and differ only in what hangs off the name: a spell wears the class chips and a
// hover card built from the DB's own fields; a skill/disc/innate wears a KIND chip and, when the
// wiki contradicts itself about it, an honesty chip quoting the contradiction verbatim.
//
// THE HONESTY CHIP IS NOT DECORATION (law 1). Thirteen discipline rows — BER 2, MNK 10, RNG 1 —
// are stated with levels by their own class page and struck through by the central Disciplines
// page, which says only Rogue poison disciplines are on Legends. Both are the wiki's words. The
// row is drawn AND labeled, never silently shown and never silently dropped; the label's tooltip
// is the disputing sentence itself, copied out of classes.json.
//
// NEITHER FIXED-HEIGHT NOR WINDOWED ANY MORE (JOS-289 — this is the surface the owner NAMED as
// cramped). It was a 120px box with its own `overflow: auto` and `useWindowedRows` behind it: four
// and a half rows of a list that routinely has a dozen, read through a slot, in front of a panel
// whose whole job is "what did this level give me". Both halves are gone, and the second half is
// MEASURED rather than asserted: over all 560 three-class loadouts × 65 levels the longest list
// this join can produce is 41 rows (skills, BRD/MNK/SHD at 1; spells peak at 39, CLR/DRU/WIZ at
// 29), with p95 = 12 spells / 3 skills. That is not the row count `useWindowedRows` exists for —
// the loot ledger's thousands are — so the hook came off rather than being pointed at a container
// with no height to window against. `ROW_H` stays: uniform rows are what make the list scannable.
//
// THE SPELL NAME CARRIES THE FULL CARD (JOS-293, integrated here by JOS-289). This file used to
// draw its own five-field hover out of the four `UnlockSpell` fields the unlock join happens to
// carry. `SpellTooltip` (lib/SpellCard) asks MAIN for the whole record on open — the effect list
// in the wiki's own words, the derived rosters, the rank, the sentences the game prints — so the
// readout answers "should I memorize this" instead of restating the row.
//
// AND THE ROW NOW ANSWERS THE QUESTION WITHOUT THE HOVER (JOS-391). A list of names and class
// chips told a player WHAT unlocked and nothing about whether it was worth the trip to the vendor.
// Four statements were added, and each of them is a fact this app already holds:
//
//   the figures     `dmg 143 · dps 48 · 2.1 dmg/mana`, read off the wiki's own effect lines
//                   (shared/spellMetrics.ts) at the level the spell becomes yours
//   already yours   a class in YOUR loadout bought this six levels ago (shared/levelUnlocks.ts)
//   replaces        the rung below it in that class's upgrade line (the shipped research)
//   memorized       whether the spell it replaces is in your bar right now, and which of your
//                   saved sets would put it back (the spellSets module)
//
// A ROW GROWS A SECOND LINE ONLY WHEN IT HAS SOMETHING TO SAY. `ROW_H` still governs the name
// line, so a list of bare skill rows keeps exactly the rhythm JOS-289 kept it for; a spell with
// figures gets a quiet second line beneath its name rather than a wider first one, because the
// left column is narrow at the app's minimum width and the name is what a reader scans.
//
// NO CAVEATS PER ROW (AGENTS.md, the tooltip and caveat diet). The word `directional` is said ONCE
// in the panel header and nowhere else; no row footnotes where its number came from.
//
// AND THE ERA VERDICT IS DRAWN THE WAY THE MOB PAGE DRAWS IT (JOS-393). eqlwiki badges a link to
// `Sloths Healing` — `{{Kunark Era}}`, `Shaman - Level 50+` — out of era, and this list offered it
// to a level-50 shaman as a spell newly his. Two treatments, one rule:
//   A LEVEL LIST folds them behind a `+N out of era` disclosure — `outOfEraLabel`, the mob page's
//   own phrase, IMPORTED rather than re-typed so the two surfaces cannot drift — because a level
//   list answers "what is new for me now" and an unopened expansion is not part of that answer.
//   A SEARCH RESULT is shown plainly with an `out of era` chip, because a search answers the
//   question the player typed and hiding the row would answer a different one.
// A spell the era sidecar has no verdict for wears nothing and is folded nowhere: silence is not a
// verdict (law 1), and the drops list made the same call for the same reason.

import { type JSX, useState } from 'react'
import { Box, Chip, Collapse, Stack, Typography } from '@mui/material'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import type { ClassAbbr } from '@shared/classCombo'
import { ownershipPhrase, replacesEntries, replacesPhrase, type UnlockRow } from '@shared/levelUnlocks'
import { spellMetricsParts } from '@shared/spellMetrics'
import { memorizedClause, type SpellSetsSnap } from '@shared/spellSets'
import { classLevelLabel } from '@shared/unlockSearch'
import { Tooltip } from '../../lib/Tooltip'
import { SpellTooltip } from '../../lib/SpellCard'
// ONE PHRASE FOR "+N out of era", owned by the surface that first drew it (JOS-377) and imported
// here the way `CurrentMobCard` imports it — a second copy would be a second wording.
import { outOfEraLabel } from '../mobs/dropEra'

/** Row height in px — fixed, which is what keeps a scanned list on a rhythm. */
const ROW_H = 26

const KIND_LABEL: Record<UnlockRow['kind'], string> = {
  spell: 'spell',
  skill: 'skill',
  disc: 'disc',
  innate: 'innate'
}

const KIND_COLOR: Record<UnlockRow['kind'], string> = {
  spell: '#6fb3d2',
  skill: '#5fbf72',
  disc: '#b07fd0',
  innate: '#d9b25f'
}

/**
 * The class chips: FILLED for a class we know is in the loadout, outlined for a candidate.
 *
 * A SEARCH ROW'S CHIPS CARRY THE LEVEL (JOS-392, `row.levels`) — `CLR 24 · PAL 30` said as chips,
 * because that row is drawn at no level and a bare `CLR` would be a fact withheld. A LEVEL row's
 * chips stay bare: the level is stated once, for the whole panel, by the stepper.
 */
function ClassChips({
  row,
  resolved
}: {
  row: UnlockRow
  resolved: ReadonlySet<string>
}): JSX.Element {
  const chips: { cls: ClassAbbr; label: string }[] =
    row.levels === undefined
      ? row.classes.map((c) => ({ cls: c, label: c }))
      : row.levels.map((p) => ({ cls: p.cls, label: classLevelLabel(p) }))
  return (
    <>
      {chips.map((c) => (
        <Chip
          key={c.cls}
          size="small"
          label={c.label}
          data-testid="unlock-class-chip"
          data-class={c.cls}
          variant={resolved.has(c.cls) ? 'filled' : 'outlined'}
          color="secondary"
          sx={{ height: 17, fontSize: 10, '& .MuiChip-label': { px: 0.6 } }}
        />
      ))}
    </>
  )
}

/** One clause of the detail line. `dim` is for the ones that are context rather than the answer. */
function Note({ text, testid, dim }: { text: string; testid: string; dim?: boolean }): JSX.Element {
  return (
    <NoteLine testid={testid} dim={dim}>
      {text}
    </NoteLine>
  )
}

/** The same clause, when part of it is a hover target rather than a string (see `NoteSpell`). */
function NoteLine({
  children,
  testid,
  dim
}: {
  children: React.ReactNode
  testid: string
  dim?: boolean
}): JSX.Element {
  return (
    <Typography
      variant="caption"
      data-testid={testid}
      sx={{ fontSize: 10.5, color: dim === true ? 'text.disabled' : 'text.secondary' }}
      noWrap
    >
      {children}
    </Typography>
  )
}

/**
 * A spell NAME inside a note, as a hover target (JOS-392, owner addition).
 *
 * The `replaces` and `memorized` clauses both name a spell that is not this row's — the rung below
 * it, and where that rung currently sits — and a player choosing whether to buy the upgrade wants
 * to read BOTH cards without leaving the panel. So the name inside the sentence gets the same
 * `SpellTooltip` the row's own name has. The rest of the sentence stays plain text: `(CLR)` is a
 * class and `is memorized now` is a state, and neither is a thing to open.
 */
function NoteSpell({ name }: { name: string }): JSX.Element {
  return (
    <SpellTooltip name={name} placement="top">
      <Box component="span" data-testid="unlock-note-spell" sx={{ textDecoration: 'underline dotted', cursor: 'help' }}>
        {name}
      </Box>
    </SpellTooltip>
  )
}

/**
 * `replaces Minor Healing (CLR)`, with the replaced NAME hoverable.
 *
 * The sentence is `shared/levelUnlocks.ts`'s (`replacesEntries` — the same list `replacesPhrase`
 * joins), so the words here and the words a test pins cannot drift; this only decides which span
 * of it opens a card.
 */
function ReplacesNote({ row }: { row: UnlockRow }): JSX.Element | null {
  const entries = replacesEntries(row)
  if (entries.length === 0) return null
  return (
    <NoteLine testid="unlock-replaces" dim>
      replaces{' '}
      {entries.map((e, i) => (
        <Box component="span" key={`${e.name}|${e.cls}`}>
          {i > 0 && ', '}
          <NoteSpell name={e.name} /> ({e.cls})
        </Box>
      ))}
    </NoteLine>
  )
}

/**
 * Where the spell THIS row replaces currently lives, or null.
 *
 * The replaced spell is the one this row's own classes retire — a trio row can carry two, and the
 * first is the one the note is about, because the alternative is a sentence that names two bars.
 */
function MemorizedNote({ row, sets }: { row: UnlockRow; sets: SpellSetsSnap }): JSX.Element | null {
  const mine = (row.spell?.replaces ?? []).find((r) => row.classes.includes(r.cls))
  const clause = mine === undefined ? null : memorizedClause(sets, mine.name)
  if (mine === undefined || clause === null) return null
  return (
    <NoteLine testid="unlock-memorized" dim>
      <NoteSpell name={mine.name} />
      {clause}
    </NoteLine>
  )
}

/**
 * THE SECOND LINE: figures, ownership, what it replaces, and where that replaced spell is.
 *
 * The order is the order a buying decision reads in — what it does, whether you already have it,
 * what it retires, and whether the thing it retires is loaded right now. Returns null when the row
 * has none of them, and the row stays exactly the height JOS-289 gave it.
 *
 * THE MEMORIZED CLAUSE HANGS OFF THE REPLACED SPELL, not this one — you cannot have memorized a
 * spell you unlock at this level. It appears only when the log has WATCHED that spell go into a
 * gem (shared/spellSets.ts rule 1: presence only, never a claim of absence), so a fresh log says
 * nothing here rather than telling a player their bar is empty.
 */
function RowDetail({
  row,
  resolved,
  sets
}: {
  row: UnlockRow
  resolved: ReadonlySet<string>
  sets: SpellSetsSnap
}): JSX.Element | null {
  const metrics = row.spell?.metrics
  const figures = metrics === undefined ? [] : spellMetricsParts(metrics)
  const owned = ownershipPhrase(row, resolved)
  const replaces = <ReplacesNote row={row} />
  const memorized = <MemorizedNote row={row} sets={sets} />
  if (figures.length === 0 && owned === null && replacesPhrase(row) === null) return null
  return (
    <Stack
      direction="row"
      spacing={0.75}
      alignItems="center"
      flexWrap="wrap"
      useFlexGap
      data-testid="unlock-detail"
      sx={{ pl: 0.25, mt: -0.5, mb: 0.25, minWidth: 0 }}
    >
      {figures.length > 0 && <Note text={figures.join(' · ')} testid="unlock-figures" />}
      {owned !== null && <Note text={owned} testid="unlock-already-yours" />}
      {replaces}
      {memorized}
    </Stack>
  )
}

function Row({
  row,
  resolved,
  sets
}: {
  row: UnlockRow
  resolved: ReadonlySet<string>
  sets: SpellSetsSnap
}): JSX.Element {
  const name =
    row.kind === 'spell' ? (
      <SpellTooltip name={row.name}>
        <Typography variant="caption" data-testid="unlock-spell-name" sx={{ fontWeight: 600 }} noWrap>
          {row.name}
        </Typography>
      </SpellTooltip>
    ) : (
      <Typography variant="caption" sx={{ fontWeight: 600 }} noWrap>
        {row.name}
      </Typography>
    )
  return (
    <Box data-testid="unlock-row" data-kind={row.kind} sx={{ minWidth: 0 }}>
    <Stack
      direction="row"
      spacing={0.75}
      alignItems="center"
      sx={{ height: ROW_H, minWidth: 0 }}
    >
      {row.kind !== 'spell' && (
        <Chip
          size="small"
          label={KIND_LABEL[row.kind]}
          sx={{
            height: 17,
            fontSize: 10,
            bgcolor: `${KIND_COLOR[row.kind]}22`,
            color: KIND_COLOR[row.kind],
            '& .MuiChip-label': { px: 0.6 }
          }}
        />
      )}
      <Box sx={{ minWidth: 0, flexShrink: 1 }}>{name}</Box>
      <Box sx={{ flexGrow: 1 }} />
      {row.dispute && (
        <Tooltip title={row.dispute}>
          <Chip
            size="small"
            label="disputed"
            data-testid="unlock-disputed"
            color="warning"
            variant="outlined"
            sx={{ height: 17, fontSize: 10, '& .MuiChip-label': { px: 0.6 } }}
          />
        </Tooltip>
      )}
      {/* THE ERA CHIP — the item card's own label and colour (`PlannerChips.EraChip`'s warning
          outline), on the rows that are drawn rather than folded: every search result, and the
          level rows once the disclosure has been opened. */}
      {row.spell?.outOfEra === true && (
        <Tooltip title="The wiki marks this spell's page out of era: it belongs to an expansion this server has not opened.">
          <Chip
            size="small"
            label="out of era"
            data-testid="unlock-out-of-era"
            color="warning"
            variant="outlined"
            sx={{ height: 17, fontSize: 10, '& .MuiChip-label': { px: 0.6 } }}
          />
        </Tooltip>
      )}
      <ClassChips row={row} resolved={resolved} />
    </Stack>
      <RowDetail row={row} resolved={resolved} sets={sets} />
    </Box>
  )
}

/**
 * THE DISCLOSURE (JOS-393) — `+N out of era`, and the rows behind it.
 *
 * `MobDropsSection.OutOfEraDrops`'s shape, deliberately: same phrase, same one-click cost, same
 * chevron, because a player who has learned what that line means on a mob page has learned it here
 * too. A DISCLOSURE AND NOT A DELETION — the wiki states these spells at this level and that stays
 * sayable; what stops happening is a level list quietly promising a trip to the vendor.
 *
 * Nothing folded ⇒ nothing drawn, never an empty disclosure.
 */
function OutOfEraRows({
  rows,
  resolved,
  sets
}: {
  rows: UnlockRow[]
  resolved: ReadonlySet<string>
  sets: SpellSetsSnap
}): JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (rows.length === 0) return null
  return (
    <Box>
      <Stack
        direction="row"
        alignItems="center"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') setOpen(!open)
        }}
        data-testid="unlock-era-toggle"
        sx={{
          display: 'inline-flex',
          cursor: 'pointer',
          color: 'text.secondary',
          '&:hover': { color: 'primary.main' }
        }}
      >
        <Typography variant="caption" sx={{ fontSize: 10.5 }}>
          {outOfEraLabel(rows.length)}
        </Typography>
        <ExpandMoreIcon
          fontSize="inherit"
          sx={{ transition: 'transform 120ms', transform: open ? 'rotate(180deg)' : undefined }}
        />
      </Stack>
      <Collapse in={open} unmountOnExit>
        {rows.map((r) => (
          <Row key={`${r.kind}:${r.name}`} row={r} resolved={resolved} sets={sets} />
        ))}
      </Collapse>
    </Box>
  )
}

/**
 * One titled list, AS TALL AS ITS ROWS. `empty` is the sentence to print when there is nothing —
 * for BER/MNK/WAR the spells list is legitimately empty at EVERY level (they have no
 * Template:Spellpage spells at all), so an empty list is a stated fact here, never an error.
 */
export function UnlockList({
  title,
  rows,
  resolved,
  empty,
  sets,
  count,
  outOfEra = []
}: {
  title: string
  rows: UnlockRow[]
  resolved: ReadonlySet<string>
  empty: string
  /** The live gem/spell-set state, for the "is what this replaces loaded right now" clause. */
  sets: SpellSetsSnap
  /**
   * What the heading counts, when that is not the number of rows drawn — the search results are
   * CAPPED (JOS-392), and a heading that counted the mounted rows would quietly restate the cap as
   * the answer. Absent everywhere else, where the two numbers are the same by construction.
   */
  count?: number
  /**
   * Rows the wiki badges OUT OF ERA, folded behind the disclosure (JOS-393). Absent on every list
   * that has no such rows — the search results, where the chip does the same job in place, and the
   * skills list, which the era join says nothing about.
   *
   * The heading counts the SHOWN rows; the disclosure counts its own. Two numbers because they are
   * two claims, and a heading of `Spells (4)` over three visible rows would be neither.
   */
  outOfEra?: UnlockRow[]
}): JSX.Element {
  return (
    <Box sx={{ flex: 1, minWidth: 0 }} data-testid="unlock-list">
      <Typography variant="caption" color="text.secondary" sx={{ mb: 0.25 }}>
        {title} ({count ?? rows.length})
      </Typography>
      <Box>
        {/* THE DISJUNCTION MATTERS (the mob page's own): a level whose every spell is out of era
            has spells, so the empty sentence must not claim otherwise — the disclosure is what it
            has to say. */}
        {rows.length === 0 && outOfEra.length === 0 ? (
          <Typography variant="caption" color="text.disabled">
            {empty}
          </Typography>
        ) : (
          rows.map((r) => <Row key={`${r.kind}:${r.name}`} row={r} resolved={resolved} sets={sets} />)
        )}
        <OutOfEraRows rows={outOfEra} resolved={resolved} sets={sets} />
      </Box>
    </Box>
  )
}
