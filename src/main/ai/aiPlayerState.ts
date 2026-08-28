// Live character facts for AI tools. Served engine snapshots only - no wiki.
import { computeAAAccounting } from '../../shared/aa'
import { intervalConfidence, resolvedClasses } from '../../shared/classCombo'
import { loadoutUncertain } from '../../shared/comboIndex'
import type { AiDumpStatus, AiLiveStatus } from '../../shared/aiChat'
import type { CombatSnapshot } from '../../shared/combat'
import { outputKind, type OutputKindId } from '../../shared/outputs/kinds'
import { dumpLiveFrom, loadoutLiveFromSummary } from './aiMentions'
import { dumpHonesty, type DumpHonesty } from './aiDumpView'
import { compactBuffs, compactFight, compactLoot, compactZone, type BuffBit, type LootBit, type TimerBit } from './aiLiveViews'
import { recapFromServed } from './aiRecap'
import { mobsInZone, searchItems } from './aiKnowledge'
import { serveCombatSnapshot, serveModuleSnapshot } from '../dataServer/serveShim'
import { outputStatus } from '../outputs'
import { getActiveCharacter } from '../session'
import { respawnReading } from '../../shared/respawn'
import { readFileSync } from 'fs'

const STATUS_DUMPS = ['inventory', 'spellbook'] as const

const DUMP_CAP = 8000
const OUTPUT_KINDS: readonly OutputKindId[] = [
  'inventory',
  'spellbook',
  'factions',
  'guild',
  'raid',
  'achievements'
]

function isOutputKind(v: string): v is OutputKindId {
  return (OUTPUT_KINDS as readonly string[]).includes(v)
}

function clipDump(text: string): string {
  return text.length > DUMP_CAP ? `${text.slice(0, DUMP_CAP)}\n[truncated]` : text
}

function readDumpFile(path: string): string {
  try {
    return clipDump(readFileSync(path, 'utf8'))
  } catch {
    return ''
  }
}

function emptyCombat(): CombatSnapshot {
  return {
    selectedId: '',
    selected: null,
    segments: [],
    inCombat: false,
    recent: [],
    stance: {},
    poison: { coat: { combat: [] }, slow: { pulls: 0, landed: 0, noLand: 0, window: 0 } },
    zoneSessions: [],
    hydrating: true,
    roster: { members: [], seen: false, lastSignalTs: 0 }
  }
}

export async function buildAiRecap(): Promise<string[]> {
  const combat = await serveCombatSnapshot({}, emptyCombat)
  const [loot, buffs, character] = await Promise.all([
    serveModuleSnapshot('loot'),
    serveModuleSnapshot('buffs'),
    serveModuleSnapshot('character')
  ])
  return recapFromServed({
    combat,
    loot: loot?.state ?? null,
    buffs: buffs?.state ?? null,
    character: character?.state ?? null
  })
}

export function getOutputDump(kind: string): DumpHonesty {
  const command = isOutputKind(kind) ? outputKind(kind).command : `/outputfile ${kind}`
  const active = getActiveCharacter()
  const status = isOutputKind(kind)
    ? outputStatus(kind, { name: active?.name, server: active?.server })
    : { path: null, updatedAt: null }
  const updatedAtMs = status.updatedAt ? Date.parse(status.updatedAt) : null
  const text = !status.path || !status.updatedAt ? '' : readDumpFile(status.path)
  return dumpHonesty({
    kind,
    command,
    text,
    updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : null,
    nowMs: Date.now()
  })
}

export async function getFightSummary(): Promise<Record<string, unknown>> {
  const snap = await serveCombatSnapshot({}, emptyCombat)
  const sel = snap.selected
  return compactFight({
    hydrating: snap.hydrating,
    inCombat: snap.inCombat,
    zone: snap.zone,
    currentTarget: snap.currentTarget
      ? { name: snap.currentTarget.name, others: snap.currentTarget.others }
      : undefined,
    selected: sel
      ? {
          kind: sel.kind,
          name: sel.name,
          durationSec: sel.durationSec,
          outTotal: sel.outTotal,
          outDps: sel.outDps,
          inTotal: sel.inTotal,
          entities: sel.entities.map((e) => ({ kind: e.kind, name: e.name, total: e.total, dps: e.dps }))
        }
      : null
  })
}

function asBuffs(state: unknown): BuffBit[] {
  if (!state || typeof state !== 'object') return []
  const active = (state as { active?: unknown }).active
  if (!Array.isArray(active)) return []
  const out: BuffBit[] = []
  for (const row of active) {
    if (!row || typeof row !== 'object') continue
    const b = row as Record<string, unknown>
    if (typeof b.spell !== 'string') continue
    out.push({
      spell: b.spell,
      self: b.self === true,
      cls: typeof b.cls === 'string' ? b.cls : '',
      target: typeof b.target === 'string' ? b.target : undefined,
      inferredTarget: b.inferredTarget === true,
      startedTs: typeof b.startedTs === 'number' ? b.startedTs : 0,
      overlayDurationMs: typeof b.overlayDurationMs === 'number' ? b.overlayDurationMs : null
    })
  }
  return out
}

export async function getBuffsSummary(): Promise<Record<string, unknown>> {
  const snap = await serveModuleSnapshot('buffs')
  return compactBuffs(asBuffs(snap?.state), Date.now())
}

function asLoot(state: unknown): LootBit[] {
  const rows = Array.isArray(state) ? state : (state as { rows?: unknown })?.rows
  if (!Array.isArray(rows)) return []
  const out: LootBit[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    if (typeof r.item !== 'string') continue
    out.push({
      ts: typeof r.ts === 'number' ? r.ts : 0,
      item: r.item,
      source: typeof r.source === 'string' ? r.source : undefined,
      zone: typeof r.zone === 'string' ? r.zone : undefined
    })
  }
  return out
}

function asTimers(state: unknown, zone: string | null, now: number): TimerBit[] {
  if (!state || typeof state !== 'object') return []
  const rows = (state as { rows?: unknown }).rows
  if (!Array.isArray(rows)) return []
  const z = zone?.toLowerCase()
  const out: TimerBit[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const r = row as { zone?: string; display?: string }
    if (z && r.zone?.toLowerCase() !== z) continue
    const reading = respawnReading(row as Parameters<typeof respawnReading>[0], now)
    out.push({
      name: r.display ?? '',
      watched: true,
      due: reading.due,
      remainingMs: reading.remainingMs,
      seen: reading.seen
    })
  }
  return out
}

export async function getZoneSummary(): Promise<Record<string, unknown>> {
  const char = await serveModuleSnapshot('character')
  const zone =
    char && typeof char.state === 'object' && char.state && 'zone' in char.state
      ? ((char.state as { zone?: string }).zone ?? null)
      : null
  const now = Date.now()
  const respawn = await serveModuleSnapshot('respawn')
  const timers = respawn ? asTimers(respawn.state, zone, now) : []
  return compactZone(zone, mobsInZone(zone ?? ''), timers)
}

export async function getRecentLoot(): Promise<Record<string, unknown>> {
  const snap = await serveModuleSnapshot('loot')
  return compactLoot(asLoot(snap?.state), (name) => {
    const hit = searchItems(name)[0]
    if (hit?.name.toLowerCase() !== name.toLowerCase()) return undefined
    return { name: hit.name, quest: hit.quest, lore: hit.lore, summary: hit.summary }
  })
}

export async function getLoadoutSummary(): Promise<Record<string, unknown>> {
  const snap = await serveModuleSnapshot('combo')
  if (!snap || !snap.state || typeof snap.state !== 'object') {
    return { inferred: true, classes: [] }
  }
  const st = snap.state as {
    ready?: boolean
    current?: {
      slots: { candidates: string[]; confidence: number; provenance: string }[]
      levelLo?: number
      levelHi?: number
    } | null
  }
  const cur = st.current
  if (!st.ready) return { ready: false }
  if (!cur) return { ready: true, loadout: null }
  const resolved = resolvedClasses(cur as Parameters<typeof resolvedClasses>[0])
  const inferred = cur.slots.every((s) => s.provenance === 'inferred')
  return {
    ready: true,
    classes: resolved,
    slots: cur.slots.map((s) => ({
      candidates: s.candidates,
      confidence: s.confidence,
      provenance: s.provenance
    })),
    uncertain: loadoutUncertain(cur as Parameters<typeof loadoutUncertain>[0]),
    inferred,
    confidence: intervalConfidence(cur as Parameters<typeof intervalConfidence>[0]),
    levelLo: cur.levelLo,
    levelHi: cur.levelHi,
    note: inferred
      ? 'This loadout is inferred from combat evidence, not a /who row. Say so.'
      : 'A /who row or a user correction stated this loadout.'
  }
}

export async function getLiveStatus(): Promise<AiLiveStatus> {
  const char = await serveModuleSnapshot('character')
  const zone =
    char && typeof char.state === 'object' && char.state && 'zone' in char.state
      ? ((char.state as { zone?: string }).zone ?? null)
      : null
  return {
    zone,
    loadout: loadoutLiveFromSummary(await getLoadoutSummary()),
    dumps: STATUS_DUMPS.map(liveDump),
    recap: await buildAiRecap()
  }
}

function liveDump(kind: (typeof STATUS_DUMPS)[number]): AiDumpStatus {
  const dump = getOutputDump(kind)
  const active = getActiveCharacter()
  const status = outputStatus(kind, { name: active?.name, server: active?.server })
  return dumpLiveFrom(kind, outputKind(kind).command, dump.text, status.updatedAt)
}

export async function getAaSummary(): Promise<Record<string, unknown>> {
  const snap = await serveModuleSnapshot('progression')
  const state = snap?.state as { aaGains?: unknown[]; aaSpends?: { ability: string; cost: number; rank?: number }[] } | undefined
  const aaGains = Array.isArray(state?.aaGains) ? state.aaGains : []
  const aaSpends = Array.isArray(state?.aaSpends) ? state.aaSpends : []
  const acct = computeAAAccounting(
    aaGains as Parameters<typeof computeAAAccounting>[0],
    aaSpends as Parameters<typeof computeAAAccounting>[1]
  )
  const latest = new Map<string, { ability: string; cost: number; rank?: number }>()
  for (const s of aaSpends) {
    if (s.cost <= 0) continue
    latest.set(s.ability, { ability: s.ability, cost: s.cost, rank: s.rank })
  }
  const bought = [...latest.values()].slice(-24)
  return {
    allocated: acct.allocated,
    unspent: acct.unspent,
    earned: acct.earned,
    boughtCount: acct.boughtCount,
    recentPurchases: bought
  }
}
