// Live character facts for AI tools. Thin wrappers over modules already folded
// on the log. Local snapshots only - no wiki.

import { computeAAAccounting } from '../../shared/aa'
import { intervalConfidence, resolvedClasses } from '../../shared/classCombo'
import { loadoutUncertain } from '../../shared/comboIndex'
import type { AiDumpStatus, AiLiveStatus } from '../../shared/aiChat'
import { outputKind, type OutputKindId } from '../../shared/outputs/kinds'
import { dumpLiveFrom, loadoutLiveFromSummary } from './aiMentions'
import { dumpHonesty, type DumpHonesty } from './aiDumpView'
import { compactBuffs, compactFight, compactLoot, compactZone } from './aiLiveViews'
import { mobsInZone, searchItems } from './aiKnowledge'
import {
  aiContext,
  buffsModule,
  characterModule,
  combat,
  comboModule,
  levelingModule,
  lootModule,
  respawnModule
} from '../pipeline'
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

function dumpBody(kind: string, path: string | null, updatedAt: string | null): string {
  if (!isOutputKind(kind)) return ''
  const fromCtx = clipDump(aiContext.getExports()[kind] ?? '')
  if (fromCtx) return fromCtx
  if (!path || !updatedAt) return ''
  return readDumpFile(path)
}

export function getOutputDump(kind: string): DumpHonesty {
  const command = isOutputKind(kind) ? outputKind(kind).command : `/outputfile ${kind}`
  const active = getActiveCharacter()
  const status = isOutputKind(kind)
    ? outputStatus(kind, { name: active?.name, server: active?.server })
    : { path: null, updatedAt: null }
  const updatedAtMs = status.updatedAt ? Date.parse(status.updatedAt) : null
  return dumpHonesty({
    kind,
    command,
    text: dumpBody(kind, status.path, status.updatedAt),
    updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : null,
    nowMs: Date.now()
  })
}

export function getFightSummary(): Record<string, unknown> {
  const snap = combat.snapshot(Date.now(), { maxSegments: 8 })
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

export function getBuffsSummary(): Record<string, unknown> {
  const active = buffsModule.snapshot().state.active
  return compactBuffs(
    active.map((b) => ({
      spell: b.spell,
      self: b.self,
      cls: b.cls,
      target: b.target,
      inferredTarget: b.inferredTarget,
      startedTs: b.startedTs,
      overlayDurationMs: b.overlayDurationMs
    })),
    Date.now()
  )
}

export function getZoneSummary(): Record<string, unknown> {
  const zone = characterModule.snapshot().state.zone ?? null
  const now = Date.now()
  const timers = respawnModule
    .snapshot()
    .state.rows.filter((r) => r.zone.toLowerCase() === zone?.toLowerCase())
    .map((r) => {
      const reading = respawnReading(r, now)
      return {
        name: r.display,
        watched: true,
        due: reading.due,
        remainingMs: reading.remainingMs,
        seen: reading.seen
      }
    })
  return compactZone(zone, mobsInZone(zone ?? ''), timers)
}

export function getRecentLoot(): Record<string, unknown> {
  return compactLoot(lootModule.snapshot().state, (name) => {
    const hit = searchItems(name)[0]
    if (hit?.name.toLowerCase() !== name.toLowerCase()) return undefined
    return { name: hit.name, quest: hit.quest, lore: hit.lore, summary: hit.summary }
  })
}

export function getLoadoutSummary(): Record<string, unknown> {
  const snap = comboModule.snapshot().state
  const cur = snap.current
  if (!snap.ready) return { ready: false }
  if (!cur) return { ready: true, loadout: null }
  const resolved = resolvedClasses(cur)
  const inferred = cur.slots.every((s) => s.provenance === 'inferred')
  return {
    ready: true,
    classes: resolved,
    slots: cur.slots.map((s) => ({
      candidates: s.candidates,
      confidence: s.confidence,
      provenance: s.provenance
    })),
    uncertain: loadoutUncertain(cur),
    inferred,
    confidence: intervalConfidence(cur),
    levelLo: cur.levelLo,
    levelHi: cur.levelHi,
    note: inferred
      ? 'This loadout is inferred from combat evidence, not a /who row. Say so.'
      : 'A /who row or a user correction stated this loadout.'
  }
}

export function getLiveStatus(): AiLiveStatus {
  const zone = characterModule.snapshot().state.zone ?? null
  return {
    zone,
    loadout: loadoutLiveFromSummary(getLoadoutSummary()),
    dumps: STATUS_DUMPS.map(liveDump),
    recap: aiContext.getRecap()
  }
}

function liveDump(kind: (typeof STATUS_DUMPS)[number]): AiDumpStatus {
  const dump = getOutputDump(kind)
  const active = getActiveCharacter()
  const status = outputStatus(kind, { name: active?.name, server: active?.server })
  return dumpLiveFrom(kind, outputKind(kind).command, dump.text, status.updatedAt)
}

export function getAaSummary(): Record<string, unknown> {
  const state = levelingModule.snapshot().state
  const acct = computeAAAccounting(state.aaGains, state.aaSpends)
  const latest = new Map<string, { ability: string; cost: number; rank?: number }>()
  for (const s of state.aaSpends) {
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
