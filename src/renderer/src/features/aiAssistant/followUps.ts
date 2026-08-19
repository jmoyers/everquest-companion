import type { AiFollowUp, AiLiveStatus, AiMentions } from '@shared/aiChat'

const ALERT_FOLLOW: AiFollowUp = {
  id: 'alert',
  label: 'Alert me when charm breaks',
  prompt: 'Alert me when charm breaks'
}

function aboutAlert(prompt: string): boolean {
  return /\balert\b/i.test(prompt)
}

/** 2-3 chips after an AI reply. Pure so the node suite can pin the table. */
export function followUpsFor(
  prompt: string,
  mentions: AiMentions | undefined,
  status: AiLiveStatus | null
): AiFollowUp[] {
  const out: AiFollowUp[] = []
  const item = mentions?.items[0]
  if (item) {
    out.push({
      id: 'wearing',
      label: 'Am I wearing this?',
      prompt: `Am I wearing ${item}?`
    })
    out.push({
      id: 'drops',
      label: 'Who drops it?',
      prompt: `Who drops ${item}?`
    })
  }
  if (status?.zone) {
    out.push({
      id: 'kill',
      label: 'What is worth killing here?',
      prompt: `What is worth killing in ${status.zone}?`
    })
  }
  if (!aboutAlert(prompt) && out.length < 3) out.push(ALERT_FOLLOW)
  return out.slice(0, 3)
}
