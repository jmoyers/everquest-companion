// MobPage (Task #64) — the ONE detail surface for a mob, app-wide.
//
// It is the grown-up form of Task #63's MobDetailDialog, which this file replaces. The dialog
// was right about the CONTENT and wrong about the container: two different tabs each opened
// their own modal over their own list, so "the mob you're looking at" was a transient thing you
// dismissed rather than a place you were. Now every surface that names a mob — the events
// overlay's con rows, the Mobs tab's search results and considered strip, the Raid Targets
// roster — routes to this page, and the page is where you ARE until you go back.
//
// WHAT IT ANSWERS, in the order the answers matter:
//   1. DROPS — the wiki's list, which is the DEFINITIVE statement of what this mob can drop.
//      It leads, and it is the reason the page exists ("loot listed out, tooltip style"). Each
//      row is annotated with what YOU have actually pulled off it ("seen by you: 3× · last
//      Aug 1"), because corroboration belongs beside the claim.
//   2. ALSO LOOTED BY YOU — anything your own history has that the page doesn't list. Secondary
//      by construction: it is evidence about one mob on one server, not the drop table.
//   3. QUESTS that name this mob, from the local catalog.
//   4. KILLS — what the kills module knows, when the caller has it.
//   5. RESISTS — what it shrugs off, mined from your logs over the shipped baseline (JOS-382).
//
// HONESTY (law 1) — every section states which of those three things happened: a source said
// something, a source said nothing, or we could not ask. "No wiki page for this mob" and "the
// page lists no loot" are DIFFERENT facts and are never collapsed into "no drops".
//
// ITEM NAMES ARE LIVE — hover for the EQ-style item window, click to drill into the item's own
// loot history. That half lives in MobDropRow.tsx (`DropRow` / `ItemDrillDown`), which explains
// why the loot module is subscribed only once an item is actually clicked.
//
// AND THE TABLE IS READ AGAINST THE ERA THE SERVER IS ON (JOS-377). The wiki's own mob page draws
// an OUT OF ERA pill on each row whose item page is out of era; this page listed them plainly, so
// Cazic Thule offered the seven-item Fear revamp table as loot you could go and get. Out-of-era
// rows now sit behind a "+N out of era" disclosure, in-era and UNKNOWN rows render plainly, and
// nothing is deleted — "the wiki lists it" and "it is not in era" are two facts and both stay
// sayable (law 1). The verdict is the app's ONE era verdict, asked through `./dropEra.ts`.
//
// AN ITEM IS ONE LINE, WHATEVER `+N` IT CAME AS (JOS-196). Both drop sections read ONE fold —
// `seenVariants.foldSeenVariants`, over JOS-66's `itemCountKey` — so your three `1×` rows for a
// base, a `+1` and a `+2` are one `3×` line carrying a perceived rate over YOUR kills, with the
// breakdown one click away. The same key decides section membership: an upgrade of a listed item
// annotates that item's wiki row rather than reappearing under "also looted by you" as a find the
// page failed to mention.

import { type JSX, useEffect, useState } from 'react'
import { Chip, Divider, Paper, Stack, Typography } from '@mui/material'
import type { KillMap, MobEntry, MobKnowledge, MobQuestUse } from '@shared/types'
import { killsFor } from '@shared/kills'
import { CONSIDER_FACTION_COLOR, CONSIDER_FACTION_LABEL, considerDifficultyShort } from '@shared/logEvents'
import { wikiPageUrl } from '@shared/wiki'
import { formatDate, formatDateTime } from '../../lib/formatDate'
import { tierStyle } from '../../lib/tierChip'
import { outOfEraLabel } from './dropEra'
import { ItemDrillDown, type OpenItem } from './MobDropRow'
// The two DROP BLOCKS and the derivation behind them, split out at the 400-line ceiling when the
// era fold landed (JOS-377). `Quiet` comes with them: the honest-empty-state vocabulary belongs to
// the sections that had to invent it, and the quest/kill sections below borrow the one definition.
import { AlsoLootedSection, DropsSection, dropSections, Quiet } from './MobDropsSection'
import { knowledgeFromEntry } from './mobSearch'
// The Resists card (JOS-382). Its own feature directory, not this one, because the con-tooltip
// overlay mounts the very same component - see features/resists/ResistProfile.tsx.
import { ResistProfile } from '../resists/ResistProfile'
import type { MobConsiderContext, MobTarget } from './mobTarget'

/** What the calling surface knew about your kills on this mob, when it knew anything. */
type MobKillFacts = MobTarget['kill']

/**
 * Fetch the mob's knowledge on mount. `seed` is whatever the caller already attached to the row,
 * so the page paints instantly and then refreshes — main's lookup is cache-first and
 * local-first, so the refresh is usually free.
 *
 * `entry` PINS the identity half of the record. A lookup resolves a NAME, and an EQ name can
 * name several pages ("a bandit" is nine mobs in nine zones with nine drop tables); when the
 * user reached this page by clicking a specific catalog row, that row's page/level/zone/drops
 * are what they asked for, and the lookup contributes only what the catalog can't know — your
 * own loot history and the quests that name it. `notFound` is dropped in that case: we are
 * holding the page, so "there is no page" cannot be true.
 */
function useMobKnowledge(
  mob: string,
  seed?: MobKnowledge,
  entry?: MobEntry
): { data: MobKnowledge | null; loading: boolean } {
  const [fetched, setFetched] = useState<MobKnowledge | null>(seed ?? null)
  const [loading, setLoading] = useState(!seed)
  useEffect(() => {
    let alive = true
    setLoading(true)
    void window.eq
      .lookupMob(mob)
      .then((k) => {
        if (alive) setFetched(k)
      })
      .catch(() => {
        /* main never rejects; guard anyway — a null record renders the honest empty states */
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [mob])

  if (!entry) return { data: fetched, loading }
  const pinned = knowledgeFromEntry(entry)
  const data: MobKnowledge = fetched
    ? pinIdentity(fetched, pinned)
    : { ...pinned, name: mob }
  return { data, loading }
}

/**
 * The pin, applied — and the ONE field the pin gives back (JOS-377).
 *
 * `knowledgeFromEntry` is the renderer's mirror of main's `knowledgeFromCatalog` over the identical
 * JSON, and it cannot annotate a drop with its item's era: the 11k-item corpus that states one is
 * main-only (`main/mobDropEra.ts`). So a pinned drop list would overwrite the annotated one with
 * the same names carrying no evidence, and the era fold would answer off the catalog zones alone —
 * which is exactly the witness a REVAMP defeats, i.e. the whole bug.
 *
 * When the lookup resolved THE SAME PAGE the pin names, the two lists are the same list and the
 * fetched one is strictly better informed, so it wins. A different page means the pin is doing its
 * real job (an EQ name can name nine creatures) and the catalog's list is the one asked for.
 */
function pinIdentity(fetched: MobKnowledge, pinned: MobKnowledge): MobKnowledge {
  const data: MobKnowledge = { ...fetched, ...pinned, notFound: undefined }
  if (fetched.page !== undefined && fetched.page === pinned.page && fetched.dropsWiki?.length) {
    data.dropsWiki = fetched.dropsWiki
  }
  return data
}

function StatCard({
  label,
  value,
  hint,
  testId
}: {
  label: string
  value: string
  hint?: string
  /** The two cards a spec reads: Kills (the number JOS-350 was about) and Known drops (JOS-377). */
  testId?: string
}): JSX.Element {
  return (
    <Paper variant="outlined" data-testid={testId} sx={{ p: 1.5, flex: 1, minWidth: 110 }}>
      <Typography variant="h5" sx={{ color: 'primary.main', lineHeight: 1.1 }}>
        {value}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      {hint && (
        <Typography variant="caption" color="text.disabled" display="block">
          {hint}
        </Typography>
      )}
    </Paper>
  )
}

/** The con-coloured headline plus everything the log line already said about identity. */
function MobIdentity({
  mob,
  con,
  kill
}: {
  mob: string
  con?: MobConsiderContext
  kill?: MobKillFacts
}): JSX.Element {
  const factionColor = con ? CONSIDER_FACTION_COLOR[con.faction] : undefined
  const tier = kill && kill.count > 0 ? tierStyle(kill.bestTier) : null
  return (
    <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
      <Typography variant="h6" sx={{ color: factionColor ?? 'text.primary' }}>
        {mob}
      </Typography>
      {con && (
        <Chip
          size="small"
          variant="outlined"
          label={CONSIDER_FACTION_LABEL[con.faction]}
          sx={{ height: 22, color: factionColor, borderColor: factionColor }}
        />
      )}
      {con?.rare && <Chip size="small" color="secondary" label="rare" sx={{ height: 22 }} />}
      {con?.level != null && (
        <Chip size="small" variant="outlined" label={`Lvl ${con.level}`} sx={{ height: 22 }} />
      )}
      {tier && (
        <Chip
          size="small"
          label={tier.label}
          sx={{ height: 22, bgcolor: tier.bg, color: tier.fg, fontWeight: 700 }}
        />
      )}
    </Stack>
  )
}

/** The consider sentence, verbatim — the thing the game actually told you. */
function MobConsiderLine({ con }: { con?: MobConsiderContext }): JSX.Element | null {
  if (!con) return null
  return (
    <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.25, mb: 1.5 }}>
      {considerDifficultyShort(con.difficulty) ?? con.difficulty}
      {con.difficulty && ` - “${con.difficulty}”`}
      {con.zone && ` · ${con.zone}`}
    </Typography>
  )
}

/**
 * The tally the "Known drops" card states (JOS-377).
 *
 * THE HEADLINE NUMBER IS WHAT YOU CAN GO AND GET, because that is the question a drop count is
 * asked. The other number is not deleted, it is stated beside it: 18 was never wrong about the
 * wiki page, it was wrong about this server, and a card that silently said 11 would have replaced
 * one bad answer with a quieter one.
 */
function dropCountHint(outCount: number, page?: string): string | undefined {
  const source = page ? 'from the wiki page' : undefined
  if (outCount === 0) return source
  const era = `${outOfEraLabel(outCount)}, folded`
  return source ? `${source} · ${era}` : era
}

/** The four-up tally strip: what the page lists, what you've seen, kills, considers. */
function MobStats({
  wikiCount,
  outCount,
  seenCount,
  page,
  con,
  kill
}: {
  wikiCount: number
  outCount: number
  seenCount: number
  page?: string
  con?: MobConsiderContext
  kill?: MobKillFacts
}): JSX.Element {
  return (
    <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap sx={{ mb: 2, mt: con ? 0 : 1.5 }}>
      <StatCard
        label="Known drops"
        testId="mob-stat-drops"
        value={String(wikiCount)}
        hint={dropCountHint(outCount, page)}
      />
      <StatCard label="Looted by you" value={String(seenCount)} hint="distinct items" />
      <StatCard
        label="Kills"
        testId="mob-stat-kills"
        value={String(kill?.count ?? 0)}
        hint={kill?.lastTs ? `last ${formatDate(kill.lastTs)}` : undefined}
      />
      {con?.cons != null && <StatCard label="Considered" value={`${con.cons}×`} />}
    </Stack>
  )
}

/** Level/zone as the WIKI states them — a range as often as a number. */
function WikiLevelZone({ zone, levelText }: { zone?: string; levelText?: string }): JSX.Element | null {
  // Deliberately falsiness, not nullishness: an empty string from the page says nothing, so a
  // blank zone AND a blank level renders no line at all (what `zone || levelText` always meant).
  if (!zone && !levelText) return null
  return (
    <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1.5 }}>
      {zone}
      {zone && levelText && ' · '}
      {levelText && `level ${levelText}`}
    </Typography>
  )
}

/** ---- 3. QUESTS ---- */
function QuestsSection({ quests }: { quests: MobQuestUse[] }): JSX.Element {
  return (
    <>
      <Divider sx={{ my: 1.5 }} />
      <Typography variant="subtitle2" gutterBottom>
        Quests that name it
      </Typography>
      {quests.length > 0 ? (
        <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
          {quests.map((q) => (
            <Chip
              key={q.quest}
              size="small"
              variant="outlined"
              color="success"
              label={q.zone ? `${q.quest} · ${q.zone}` : q.quest}
              sx={{ height: 22 }}
            />
          ))}
        </Stack>
      ) : (
        <Quiet>No quest in the local catalog names this mob.</Quiet>
      )}
    </>
  )
}

/** ---- 4. KILLS ---- */
function KillsSection({ kill }: { kill?: MobKillFacts }): JSX.Element {
  return (
    <>
      <Divider sx={{ my: 1.5 }} />
      <Typography variant="subtitle2" gutterBottom>
        Your kills
      </Typography>
      {kill && kill.count > 0 ? (
        <Typography variant="caption" color="text.secondary">
          {kill.count} kill{kill.count === 1 ? '' : 's'} · first {formatDateTime(kill.firstTs)} · last{' '}
          {formatDateTime(kill.lastTs)}
        </Typography>
      ) : (
        <Quiet>Nothing recorded yet for this character.</Quiet>
      )}
    </>
  )
}

/** Attribution for whatever the wiki contributed, when it contributed anything. */
function WikiSourceLine({ wikiUrl }: { wikiUrl?: string }): JSX.Element | null {
  if (!wikiUrl) return null
  return (
    <Typography variant="caption" color="text.disabled" display="block" sx={{ mt: 2 }}>
      Source:{' '}
      <a href={wikiUrl} target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>
        eqlwiki.com
      </a>
    </Typography>
  )
}

/**
 * The mob page. `target` carries everything the calling surface already knew; `kills` is the
 * kills module's join index (`shared/kills.killIndex`), which the page reads for ITSELF.
 *
 * THE KILL COUNT IS THE PAGE'S OWN JOIN NOW (JOS-350). It used to be `target.kill` and nothing
 * else, so a surface that forgot to attach one — the Overview's Target card, its Recent-kills
 * rows, the Sky droppers, the events overlay's deep link — opened this page reading `Kills 0`
 * for a mob the Mobs tab counted correctly. That is a join every caller had to remember, keyed
 * four different inline ways; now there is one, and `killsFor` folds the spawn-generation
 * ` (N)` suffix that the combat-fed names carry and no kill record ever has.
 *
 * `target.kill` SURVIVES as an explicit OVERRIDE, for the one caller that resolves a DIFFERENT
 * identity than this page's name would: the raid roster matches its targets article-insensitively
 * (bossStatus.ts), so it pins the record it matched, exactly as `entry` pins the identity half.
 */
export function MobPage({ target, kills }: { target: MobTarget; kills: KillMap }): JSX.Element {
  const { mob, seed, entry, con } = target
  const kill = target.kill ?? killsFor(kills, mob)
  const { data, loading } = useMobKnowledge(mob, seed, entry)
  const [drill, setDrill] = useState<{ item: string; family: boolean } | null>(null)
  const openItem: OpenItem = (item, family) => {
    setDrill({ item, family: family === true })
  }

  const { wiki, outOfEra, lines, byKey, extra } = dropSections(data)
  const quests = data?.quests ?? []
  const wikiUrl = wikiPageUrl(data?.page)

  return (
    <>
      <MobIdentity mob={mob} con={con} kill={kill} />
      <MobConsiderLine con={con} />
      <MobStats
        wikiCount={wiki.length}
        outCount={outOfEra.length}
        seenCount={lines.length}
        page={data?.page}
        con={con}
        kill={kill}
      />
      <WikiLevelZone zone={data?.zone} levelText={data?.levelText} />
      <DropsSection
        wiki={wiki}
        outOfEra={outOfEra}
        seenByKey={byKey}
        kills={kill?.count}
        data={data}
        loading={loading}
        onOpenItem={openItem}
      />
      <AlsoLootedSection extraSeen={extra} kills={kill?.count} onOpenItem={openItem} />
      <QuestsSection quests={quests} />
      <KillsSection kill={kill} />
      {/* ---- 5. RESISTS ---- what it shrugs off and what it does not, mined from the logs. */}
      <ResistProfile mob={mob} />
      <WikiSourceLine wikiUrl={wikiUrl} />

      {/* One hop deep: the item's own dialog. Mounted only on demand (see ItemDrillDown). */}
      {drill && (
        <ItemDrillDown item={drill.item} family={drill.family} onClose={() => setDrill(null)} />
      )}
    </>
  )
}
