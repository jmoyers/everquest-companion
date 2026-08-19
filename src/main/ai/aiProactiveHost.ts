// Live-only proactive tips. Subscribes after modules fold. Never runs in replay.

import type { WebContents } from 'electron'
import type { LogEvent } from '../../shared/logEvents'
import { IPC } from '../../shared/ipc'
import { bus, characterModule, combat } from '../pipeline'
import { getMainWindow, getOverlayWindow } from '../windows'
import { settingsStore } from '../store'
import { mobsInZone, spellsGained } from './aiKnowledge'
import { getLoadoutSummary } from './aiPlayerState'
import { AI_PROACTIVE_SHIPPED } from '../../shared/aiSlash'
import { proactiveTip } from './aiProactive'

const QUIET_MS = 10 * 60 * 1000
const lastLevelByZone = new Map<string, number>()
const lastHookAt = new Map<string, number>()

function proactiveOn(): boolean {
  if (!AI_PROACTIVE_SHIPPED) return false
  return settingsStore.get('aiConfig')?.proactive === true
}

function currentLevel(): number | null {
  const lv = characterModule.snapshot().state.level?.level
  return typeof lv === 'number' && Number.isFinite(lv) ? lv : null
}

function pushTip(text: string): void {
  const payload = { text }
  const send = (wc: WebContents | undefined): void => {
    if (!wc || wc.isDestroyed()) return
    wc.send(IPC.aiProactive, payload)
  }
  send(getMainWindow()?.webContents)
  const overlay = getOverlayWindow('ai')
  send(overlay && !overlay.isDestroyed() ? overlay.webContents : undefined)
}

function quietKey(hook: string, zone: string | null): string {
  return `${hook}:${(zone ?? '').toLowerCase()}`
}

function recently(hook: string, zone: string | null, now: number): boolean {
  const prev = lastHookAt.get(quietKey(hook, zone))
  return prev != null && now - prev < QUIET_MS
}

function markHook(hook: string, zone: string | null, now: number): void {
  lastHookAt.set(quietKey(hook, zone), now)
}

function loadoutBits(): { classes: string[]; inferred: boolean } {
  const raw = getLoadoutSummary()
  const classes = Array.isArray(raw.classes) ? (raw.classes as string[]) : []
  return { classes, inferred: raw.inferred === true }
}

export function considerProactive(ev: LogEvent, live: boolean): void {
  if (!live || !proactiveOn()) return
  const snap = combat.snapshot(Date.now(), { maxSegments: 4 })
  if (snap.hydrating || snap.inCombat) return
  const zone = characterModule.snapshot().state.zone ?? (ev.kind === 'zone' ? ev.zone : null)
  const now = Date.now()
  if (ev.kind === 'zone') {
    onZone(ev.zone, now)
    return
  }
  if (ev.kind === 'level') {
    if (recently('level', zone, now)) return
    const { classes, inferred } = loadoutBits()
    const cur = ev.level
    const last = cur - 1
    const text = proactiveTip({
      enabled: true,
      inCombat: false,
      hook: 'level',
      zone,
      classes,
      inferred,
      currentLevel: cur,
      lastLevelHere: last,
      spells: spellsGained(classes, last, cur),
      mobs: []
    })
    if (text) {
      markHook('level', zone, now)
      pushTip(text)
    }
  }
}

function onZone(zone: string, now: number): void {
  const key = zone.toLowerCase()
  const cur = currentLevel()
  const last = lastLevelByZone.get(key) ?? null
  if (cur != null) lastLevelByZone.set(key, cur)
  if (recently('zone', zone, now)) return
  const { classes, inferred } = loadoutBits()
  const text = proactiveTip({
    enabled: true,
    inCombat: false,
    hook: 'zone',
    zone,
    classes,
    inferred,
    currentLevel: cur,
    lastLevelHere: last,
    spells: last != null && cur != null ? spellsGained(classes, last, cur) : [],
    mobs: mobsInZone(zone).map((m) => m.name)
  })
  if (text) {
    markHook('zone', zone, now)
    pushTip(text)
  }
}

export function startAiProactive(): void {
  bus.subscribe(considerProactive)
}
