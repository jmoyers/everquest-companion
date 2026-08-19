// Computed proactive tips. Electron-free. Off and in-combat are silent.
// The model is not called; the sentence is joined from folded facts + the spell DB.

const SPELLS_PER_CLASS = 4

export interface ProactiveInput {
  enabled: boolean
  inCombat: boolean
  hook: 'zone' | 'level' | 'dump'
  zone: string | null
  classes: string[]
  inferred: boolean
  currentLevel: number | null
  lastLevelHere: number | null
  spells: { cls: string; names: string[] }[]
  mobs: string[]
}

export function classList(classes: readonly string[], inferred: boolean): string {
  const names = classes.slice(0, 3).join(', ')
  if (!names) return inferred ? 'your inferred loadout' : 'your loadout'
  return inferred ? `${names} (inferred)` : names
}

export function proactiveTip(input: ProactiveInput): string | null {
  if (!input.enabled || input.inCombat) return null
  if (input.hook === 'zone') return zoneTip(input)
  if (input.hook === 'level') return levelTip(input)
  if (input.hook === 'dump') {
    return 'Bags updated. Ask again if you wanted a wearing or spellbook answer.'
  }
  return null
}

function zoneTip(input: ProactiveInput): string | null {
  if (!input.zone) return null
  const gained = levelsGained(input)
  if (gained >= 1) {
    const who = classList(input.classes, input.inferred)
    const spells = spellClause(input.spells)
    return `You just entered ${input.zone}. You have gained ${String(gained)} level${gained === 1 ? '' : 's'} since you were last here, so pick up spells for ${who}${spells}.`
  }
  return zonePrimer(input)
}

function levelsGained(input: ProactiveInput): number {
  if (input.currentLevel == null || input.lastLevelHere == null) return 0
  return input.currentLevel - input.lastLevelHere
}

function zonePrimer(input: ProactiveInput): string | null {
  if (!input.zone) return null
  const names = input.mobs.slice(0, 5)
  if (names.length === 0) return null
  return `You just entered ${input.zone}. Catalog names here: ${names.join(', ')}.`
}

function levelTip(input: ProactiveInput): string | null {
  if (input.currentLevel == null) return null
  const who = classList(input.classes, input.inferred)
  const spells = spellClause(input.spells)
  return `You reached level ${String(input.currentLevel)}. New spells for ${who}${spells}.`
}

function spellClause(spells: readonly { cls: string; names: string[] }[]): string {
  const bits: string[] = []
  for (const row of spells) {
    const names = row.names.slice(0, SPELLS_PER_CLASS)
    if (names.length === 0) continue
    bits.push(`${row.cls}: ${names.join(', ')}`)
  }
  if (bits.length === 0) return ''
  return ` - ${bits.join('; ')}`
}
