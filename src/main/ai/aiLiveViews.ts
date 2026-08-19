// Compact live-state views for AI tools. Electron-free. Callers pass already-folded
// snapshots; this file never invents a fight, buff, or drop.

const LOOT_CAP = 12
const ZONE_MOB_CAP = 12
const TIMER_CAP = 12
const BUFF_CAP = 24

export interface FightBits {
  hydrating: boolean
  inCombat: boolean
  zone?: string
  currentTarget?: { name: string; others: number }
  selected: {
    kind: string
    name: string
    durationSec: number
    outTotal: number
    outDps: number
    inTotal: number
    entities: { kind: string; name: string; total: number; dps: number }[]
  } | null
}

export interface BuffBit {
  spell: string
  self: boolean
  cls: string
  target?: string
  inferredTarget?: boolean
  startedTs: number
  overlayDurationMs?: number | null
}

export interface TimerBit {
  name: string
  watched: boolean
  due: boolean
  remainingMs?: number
  seen: boolean
}

export interface LootBit {
  ts: number
  item: string
  source?: string
  zone?: string
}

export interface ItemHint {
  name: string
  quest: boolean
  lore: boolean
  summary?: string
}

function fightBlock(bits: FightBits): Record<string, unknown> | null {
  const sel = bits.selected
  if (!sel) return null
  const you = sel.entities.find((e) => e.kind === 'you')
  const petTotal = sel.entities.filter((e) => e.kind === 'pet').reduce((n, e) => n + e.total, 0)
  return {
    name: sel.name,
    kind: sel.kind,
    durationSec: sel.durationSec,
    youTotal: you?.total ?? 0,
    youDps: you?.dps ?? 0,
    petTotal,
    outTotal: sel.outTotal,
    outDps: sel.outDps,
    inTotal: sel.inTotal
  }
}

export function compactFight(bits: FightBits): Record<string, unknown> {
  if (bits.hydrating) {
    return { hydrating: true, note: 'Still reading the log. Do not treat a fight as live.' }
  }
  return {
    hydrating: false,
    inCombat: bits.inCombat,
    zone: bits.zone ?? null,
    currentTarget: bits.currentTarget?.name ?? null,
    others: bits.currentTarget?.others ?? 0,
    fight: fightBlock(bits),
    note: bits.inCombat
      ? 'Live pull. currentTarget is the mob in front of you.'
      : 'No open pull. fight is the last fight if one exists, never a zone total.'
  }
}

export function compactBuffs(buffs: readonly BuffBit[], nowMs: number): Record<string, unknown> {
  const rows = buffs.slice(0, BUFF_CAP).map((b) => {
    const remainingMs =
      b.overlayDurationMs != null ? Math.max(0, b.startedTs + b.overlayDurationMs - nowMs) : null
    return {
      spell: b.spell,
      on: b.self ? 'you' : (b.target ?? 'other'),
      cls: b.cls,
      inferredTarget: b.inferredTarget === true,
      remainingMs,
      note: remainingMs == null ? 'No stated duration - elapsed only.' : undefined
    }
  })
  return {
    count: buffs.length,
    buffs: rows,
    note: rows.length === 0 ? 'No active buffs the log has landed for this character.' : undefined
  }
}

export function compactZone(
  zone: string | null,
  mobs: readonly { name: string; level?: string; drops: string[] }[],
  timers: readonly TimerBit[]
): Record<string, unknown> {
  if (!zone) {
    return { zone: null, note: 'Zone unknown. A You have entered line has not been seen.' }
  }
  return {
    zone,
    mobs: mobs.slice(0, ZONE_MOB_CAP).map((m) => ({
      name: m.name,
      level: m.level,
      drops: m.drops.slice(0, 4)
    })),
    timers: timers.slice(0, TIMER_CAP).map((t) => ({
      name: t.name,
      watched: t.watched,
      state: t.seen ? 'up' : t.due ? 'due' : 'counting',
      remainingMs: t.remainingMs,
      note: t.due ? 'Due - the clock ran out. Not a claim the mob is standing there.' : undefined
    }))
  }
}

export function compactLoot(
  rows: readonly LootBit[],
  lookup: (name: string) => ItemHint | undefined
): Record<string, unknown> {
  const recent = rows.slice(-LOOT_CAP).reverse()
  if (recent.length === 0) {
    return { items: [], note: 'No loot lines in this character epoch.' }
  }
  return {
    items: recent.map((r) => {
      const hit = lookup(r.item)
      return {
        item: r.item,
        source: r.source ?? null,
        zone: r.zone ?? null,
        quest: hit?.quest ?? false,
        lore: hit?.lore ?? false,
        summary: hit?.summary,
        known: Boolean(hit)
      }
    })
  }
}
