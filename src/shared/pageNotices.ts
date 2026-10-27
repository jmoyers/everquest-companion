// pageNotices.ts — the notices a wiki page opens with that say its subject may not be in Legends:
// `{{DNE}}` ("NOTLEGENDS! The article contains non-Legends content") and `{{delete}}` ("This article
// is being considered for deletion"), with the deletion's reason when it gives one
// (`{{Delete|No longer in game}}`). A mob or item the player's log met is proof it exists, so its
// page is work to do (owner, 2026-10-22: "if we've seen a mob, we need to go update to remove this
// text"). Measured on the caches, 2026-10-22: no other notice template is used for this; mob pages 23
// `{{DNE}}` and 39 `{{delete}}`, item pages 28 and 284 pages in all.
//
// Kept byte-identical on every branch that reads it (WORKFLOW.md, shared code across branches).

/** `DNE`, `delete`, or `delete: <reason>`, in page order, each once. */
export type PageNotice = string

const NOTICE = /\{\{\s*(DNE|delete)\s*(?:\|([^{}]*))?\}\}/gi

/** A page's notices, or undefined when it carries none. Comments and nowiki text are not the page's. */
export function pageNotices(wikitext: string): PageNotice[] | undefined {
  const text = wikitext.replace(/<!--[\s\S]*?-->/g, '').replace(/<nowiki>[\s\S]*?<\/nowiki>/gi, '')
  const out: PageNotice[] = []
  for (const m of text.matchAll(NOTICE)) {
    const kind = m[1].toUpperCase() === 'DNE' ? 'DNE' : 'delete'
    const reason = kind === 'delete' ? (m[2] ?? '').replace(/\s+/g, ' ').trim() : ''
    const notice = reason === '' ? kind : `${kind}: ${reason}`
    if (!out.includes(notice)) out.push(notice)
  }
  return out.length > 0 ? out : undefined
}
