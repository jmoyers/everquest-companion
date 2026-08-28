// Compact recap lines for the AI prompt. Parsed fields only - never `raw`
// (raw includes the timestamp prefix and can carry quoted chat).

import type { LogEvent } from '../../shared/logEvents'

export const AI_RECAP_KINDS = new Set([
  'damage',
  'heal',
  'healUnstated',
  'miss',
  'resist',
  'mitigation',
  'death',
  'zone',
  'loot',
  'level',
  'aaGain',
  'aaSpend'
])

export const AI_RECAP_CAP = 80

function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString()
}

function line(ts: number, body: string): string {
  return `[${clock(ts)}] ${body}`
}

function formatCombat(ev: LogEvent): string | null {
  switch (ev.kind) {
    case 'damage':
      return line(ev.ts, `${ev.attacker ?? 'Someone'} hit ${ev.target} for ${ev.amount} (${ev.skill}).`)
    case 'heal':
      return line(ev.ts, `${ev.healer ?? 'Someone'} healed ${ev.target} for ${ev.amount}${ev.spell ? ` by ${ev.spell}` : ''}.`)
    case 'healUnstated':
      return line(ev.ts, 'You mended wounds (no amount stated).')
    case 'miss':
      return line(ev.ts, `${ev.attacker} ${ev.mtype} vs ${ev.target}.`)
    case 'resist':
      return line(ev.ts, `${ev.target} resisted ${ev.caster}'s ${ev.spell}.`)
    case 'mitigation':
      return line(ev.ts, `Mitigation (${ev.mtype}${ev.amount != null ? `, ${String(ev.amount)}` : ''}).`)
    default:
      return null
  }
}

function formatWorld(ev: LogEvent): string | null {
  switch (ev.kind) {
    case 'zone':
      return line(ev.ts, `You have entered ${ev.zone}.`)
    case 'death':
      return line(ev.ts, ev.bySelf ? `You have slain ${ev.name}.` : `${ev.name} died.`)
    case 'loot':
      return line(ev.ts, `You looted ${ev.item}${ev.source ? ` from ${ev.source}` : ''}.`)
    case 'level':
      return line(ev.ts, `You reached level ${ev.level}.`)
    case 'aaGain':
      return line(ev.ts, `You gained ${ev.amount} AA (now ${ev.nowHave}).`)
    case 'aaSpend':
      return line(ev.ts, `You bought ${ev.ability} for ${ev.cost} AA.`)
    default:
      return null
  }
}

function formatOne(ev: LogEvent): string | null {
  return formatCombat(ev) ?? formatWorld(ev)
}

export function isRecapEvent(ev: LogEvent): boolean {
  return AI_RECAP_KINDS.has(ev.kind)
}

/** Newest last. Count-capped; the caller already applied the time window. */
export function formatRecap(events: readonly LogEvent[]): string[] {
  const lines: string[] = []
  for (const ev of events) {
    const text = formatOne(ev)
    if (text) lines.push(text)
  }
  return lines.length <= AI_RECAP_CAP ? lines : lines.slice(-AI_RECAP_CAP)
}

/** Keep recap kinds inside the time window and count cap. Chat-like kinds drop. */
export function retainRecap(
  existing: readonly LogEvent[],
  next: LogEvent,
  windowMs: number,
  cap: number
): LogEvent[] {
  if (!isRecapEvent(next)) return [...existing]
  const newestTs = Math.max(next.ts, ...existing.map((e) => e.ts), 0)
  const kept = [...existing, next].filter((e) => newestTs - e.ts <= windowMs)
  return kept.length <= cap ? kept : kept.slice(-cap)
}

const NO_WORLD = 'Engine has no world yet.'

/** Snapshot-shaped recap. Null or hydrating combat never invents a fight. */
export function recapFromServed(input: {
  combat: { hydrating: boolean; inCombat?: boolean; zone?: string; selected?: { name?: string } | null } | null
  loot: unknown
  buffs: unknown
  character: unknown
}): string[] {
  if (!input.combat || input.combat.hydrating) return [NO_WORLD]
  const lines: string[] = []
  const zone = input.combat.zone
  if (typeof zone === 'string' && zone.length > 0) lines.push(`Zone: ${zone}.`)
  const fightName = input.combat.selected?.name
  if (input.combat.inCombat && typeof fightName === 'string' && fightName.length > 0) {
    lines.push(`Live fight: ${fightName}.`)
  } else {
    lines.push('No open pull.')
  }
  if (input.loot != null) lines.push('Loot snapshot is present.')
  if (input.buffs != null) lines.push('Buff snapshot is present.')
  if (input.character != null) lines.push('Character snapshot is present.')
  return lines.length > 0 ? lines : [NO_WORLD]
}

