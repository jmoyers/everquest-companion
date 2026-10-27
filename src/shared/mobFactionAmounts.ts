// mobFactionAmounts.ts — `MobEntry.factionAmounts`, one short string per entry of `factions`.
//
// What each faction bullet of a mob page states about the hit (owner, 2026-10-20: the Gaps tab flags
// a listed faction whose amount the log contradicts). Strings, not objects, because mobs.json is
// inlined into the bundle: objects cost about 1.2 MB, these a tenth of that.
//   "-100", "10"   one amount, signed as the page writes it; negative lowers, otherwise raises
//   "-30..-10"     a range, min..max
//   "-", "+"       no amount stated: lowers, raises
//   trailing "?"   the page marks the amount a guess: "-30..-10?", "10?"

/** One faction bullet, decoded. `min`/`max` are signed and come together. */
export interface MobFactionHit {
  side: 'lowers' | 'raises'
  min?: number
  max?: number
  /** the page marks the amount a guess: `(-10?)`, `(unconfirmed)`, `unverified` */
  unconfirmed?: true
}

const AMOUNT_RE = /^(-?\d+)(?:\.\.(-?\d+))?$/

/** The string a hit is stored as. */
export function encodeFactionAmount(hit: MobFactionHit): string {
  const guess = hit.unconfirmed ? '?' : ''
  if (hit.min === undefined || hit.max === undefined) return (hit.side === 'lowers' ? '-' : '+') + guess
  return (hit.min === hit.max ? String(hit.min) : `${hit.min}..${hit.max}`) + guess
}

/** A stored string read back; an unreadable one is a hit of unstated size the way its sign points. */
export function decodeFactionAmount(s: string): MobFactionHit {
  const unconfirmed = s.endsWith('?')
  const body = unconfirmed ? s.slice(0, -1) : s
  const flag = unconfirmed ? { unconfirmed: true as const } : {}
  const m = AMOUNT_RE.exec(body)
  if (m === null) return { side: body.startsWith('-') ? 'lowers' : 'raises', ...flag }
  const min = Number(m[1])
  const max = m[2] === undefined ? min : Number(m[2])
  return { side: min < 0 ? 'lowers' : 'raises', min, max, ...flag }
}
