// devFeedbackKeys.mts — WHERE A DEV-STACK ATTACHMENT LANDS, per kind.
//
// SPLIT OUT OF dev-feedback-server.mts FOR FILE MASS, NOT FOR SCOPE (JOS-441) — that file sits at
// the measured 400-code-line ceiling and the third attachment needed a table it had no room for.
// Nothing about the dev stack's FIDELITY rule moved with it: these keys are still byte-for-byte
// what `infra/lambda/submit.ts` computes, and the whole point of the dev stack is that a client
// cannot tell the two apart.
//
// THREE PREFIXES, ONE TABLE. When there were two kinds the server carried an `isLog` ternary in
// three places; at three kinds that is nine branches that must agree. The table below is the same
// three facts stated once — the S3 key, the upload-URL token suffix, and the on-disk file name —
// so a fourth attachment is a row rather than another round of ternaries.

/** Which attachment a presign is for. */
export type AttachmentKind = 'log' | 'inventory' | 'achievements'

/** UTC date partition, exactly as the Lambda partitions. */
export function datePrefix(now: number): string {
  const d = new Date(now)
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${d.getUTCFullYear()}/${mm}/${dd}`
}

export function logObjectKey(reportId: string, now: number): string {
  return `logs/${datePrefix(now)}/${reportId}.log.gz`
}

/** The inventory dump's key (JOS-296) — its own top-level prefix. */
export function inventoryObjectKey(reportId: string, now: number): string {
  return `inventory/${datePrefix(now)}/${reportId}.txt.gz`
}

/** The achievements dump's key (JOS-441) — again its own, on the same argument. */
export function achievementsObjectKey(reportId: string, now: number): string {
  return `achievements/${datePrefix(now)}/${reportId}.txt.gz`
}

/**
 * The three per-kind facts. `token` is the URL segment the upload leg looks a presign up by —
 * empty for the slice, so the URL shape every client and test already knows is untouched and each
 * new leg is simply one more entry in the same map.
 */
export const ATTACHMENT_KINDS: Record<
  AttachmentKind,
  { key: (reportId: string, now: number) => string; token: string; file: string }
> = {
  log: { key: logObjectKey, token: '', file: '.log.gz' },
  inventory: { key: inventoryObjectKey, token: '.inventory', file: '.inventory.txt.gz' },
  achievements: {
    key: achievementsObjectKey,
    token: '.achievements',
    file: '.achievements.txt.gz',
  },
}

/** Strip a token's kind suffix back to the reportId the row is filed under. */
export function reportIdOfToken(token: string): string {
  return token.replace(/\.(inventory|achievements)$/, '')
}
