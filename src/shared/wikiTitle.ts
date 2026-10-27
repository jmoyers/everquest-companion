// MediaWiki drops invisible Unicode format characters from a title before it looks a page or a
// file up, so a copy-pasted bidi mark (`npc_an_alligator.png` + U+200E) still shows the picture on
// the wiki. A parser that keeps the mark names a file or page the wiki does not key that way.

/** Zero-width characters, bidi marks and embeddings, word joiners and invisible operators, the BOM. */
const FORMAT_CHARS = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g

/** `s` without the format characters MediaWiki strips from a title, trimmed. */
export function stripFormatChars(s: string): string {
  return s.replace(FORMAT_CHARS, '').trim()
}

/** A file name as the wiki keys it: no `File:`, format characters dropped, spaces and underscores
 *  as one `_`, none at either end, the first letter capital. */
export function wikiFileKey(name: string): string {
  const bare = stripFormatChars(name)
    .replace(/^(File|Image)\s*:/i, '')
    .replace(/[\s_]+/g, '_')
    .replace(/^_|_$/g, '')
  return bare.charAt(0).toUpperCase() + bare.slice(1)
}
