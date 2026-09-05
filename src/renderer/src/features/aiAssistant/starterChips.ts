import type { AiFollowUp, AiLiveStatus } from '@shared/aiChat'

function recapHasLoot(recap: readonly string[]): boolean {
  return recap.some((line) => /You looted /i.test(line))
}

/** Empty-state prompts derived from live status, never a branded splash. */
export function starterChipsFor(status: AiLiveStatus): AiFollowUp[] {
  const out: AiFollowUp[] = [
    { id: 'happened', label: 'What just happened?', prompt: 'What just happened?' }
  ]
  if (status.zone) {
    out.push({
      id: 'zone-drops',
      label: `Drops in ${status.zone}`,
      prompt: `What drops in ${status.zone}?`
    })
  }
  if (recapHasLoot(status.recap)) {
    out.push({
      id: 'loot',
      label: 'What did I just loot?',
      prompt: 'What did I just loot?'
    })
  }
  out.push({
    id: 'buffs',
    label: "What's on me?",
    prompt: 'What buffs are on me right now?'
  })
  out.push({
    id: 'fight',
    label: 'This fight',
    prompt: 'How is this fight going?'
  })
  return out.slice(0, 4)
}
