// Shared number formatting for the DPS meter + overlay (Task #54). One source of truth so
// the main view, drill-down, segment list, tooltips, and the floating overlay all render rates
// and totals identically.
//
// Per the user's spec (AGENTS.md "Formatting"):
//   - RATES render as '21.7k dps' / '2.3M dps' — the WORD 'dps' after the number, k thousands,
//     M millions (this REPLACES every '/s' occurrence).
//   - TOTALS keep k/M scaling but carry NO unit word ('21.7k', '2.3M').

/** k/M-scaled magnitude with no unit word (used for damage TOTALS + as the number part of a rate). */
export function formatNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k'
  return String(Math.round(n))
}

/** A DPS rate: the k/M-scaled number followed by the word 'dps', e.g. '21.7k dps', '2.3M dps'. */
export function formatRate(n: number): string {
  return `${formatNum(n)} dps`
}

/** A HEALING rate (Task #59), same shape as formatRate with the word 'hps': '1.2k hps'. Lives
 *  here so the healing overlays never grow a second, divergent number formatter. */
export function formatHealRate(n: number): string {
  return `${formatNum(n)} hps`
}

/**
 * SMALL rates — the leveling analytics ones (levels/hr, kills/hr) — are a DIFFERENT number
 * shape from the combat ones, and deliberately do NOT go through `formatNum`.
 *
 * `formatNum` is built for damage: it k/M-scales above a thousand and ROUNDS TO AN INTEGER
 * below it (`formatNum(1.42) === '1'`). A levels-per-hour rate lives almost entirely in the
 * 0–10 band, so routing it through that would render every honest 1.42 as a flat '1' — the
 * whole quantity, silently destroyed. So: two decimals under 10, one under 100, integer above
 * (a three-digit kills/hr needs no fraction, and a rate that large only comes from a very
 * short window anyway). They still live HERE rather than in the leveling feature, because the
 * "ONE source" rule (AGENTS.md, Formatting) is about the file, not about the algorithm.
 */
function formatSmall(n: number): string {
  if (!Number.isFinite(n)) return '-'
  const v = Math.abs(n)
  if (v >= 100) return n.toFixed(0)
  if (v >= 10) return n.toFixed(1)
  return n.toFixed(2)
}

/** A LEVELS-per-hour rate: '1.42 lvl/hr', '0.35 lvl/hr', '124 lvl/hr'. "Levels of progress",
 *  never experience points — the log states a level-bar percentage and nothing else. */
export function formatLevelRate(n: number): string {
  return `${formatSmall(n)} lvl/hr`
}

/** A KILLS-per-hour rate: '38.5 kills/hr', '0.75 kills/hr', '240 kills/hr'. */
export function formatKillRate(n: number): string {
  return `${formatSmall(n)} kills/hr`
}

/**
 * A DROPS-per-hour rate (JOS-78): '3.20 drops/hr', '0.35 drops/hr', '124 drops/hr'. Small-number
 * shaped like its leveling siblings — a farming rate lives in the 0–50 band and `formatNum` would
 * render an honest 3.2 as a flat '3'.
 *
 * The word is 'drops' whatever the item is: the number counts stack sizes (a `2 Bone Chips` line
 * is two), so "motes per hour" is this rate on a mote's row and needs no second spelling.
 */
export function formatDropRate(n: number): string {
  return `${formatSmall(n)} drops/hr`
}

/**
 * A PERCEIVED DROP RATE over your own kills of one mob (JOS-196): '1 per 14 kills',
 * '2.50 per kill'.
 *
 * TWO SPELLINGS, and the reason is that `formatSmall` would destroy this quantity in the band it
 * mostly lives in. A rare drop off a mob you have killed three hundred times is 0.0033 per kill,
 * which every other rate formatter in this file renders as a flat '0.00' — the null-not-zero rule
 * (JOS-78) broken by the FORMATTER rather than by the derivation, which is the harder version to
 * notice. So below one drop per two kills the number is inverted and stated as "1 per N kills",
 * which is also how a player says it out loud; at or above that, the drops-per-kill number reads
 * naturally and is stated directly (a stacking item legitimately exceeds one per kill — the
 * numerator counts items, not corpses).
 *
 * The 0.5 threshold is where the inverted form stops being able to say something silly: any rate
 * below it inverts to 2 or more, so "1 per 1 kills" is unrepresentable.
 */
export function formatDropsPerKill(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '-'
  if (n >= 0.5) return `${formatSmall(n)} per kill`
  return `1 per ${Math.round(1 / n).toLocaleString()} kills`
}

/** AA COMPLETIONS per hour: '2.40 AA/hr'. Gain lines — what the AA bar did, which the
 *  item-shop potion cannot change (it multiplies points, never experience). */
export function formatAaRate(n: number): string {
  return `${formatSmall(n)} AA/hr`
}

/** ABILITY POINTS per hour: '4.80 pts/hr'. Σ of the amounts the gain lines stated, so a
 *  potion's doubling is already inside the number. Deliberately a DIFFERENT word from the
 *  rate above — the two diverge exactly when a bottle is running, and that is the point. */
export function formatPointRate(n: number): string {
  return `${formatSmall(n)} pts/hr`
}

/**
 * A PROCS-PER-MINUTE rate (proc analytics): '4.12 ppm', '0.35 ppm', '210 ppm'. The word after
 * the number, exactly like `dps` and `hps`, and deliberately NOT '/min' — the Task #54 sweep
 * removed every '/s' from the app and a '/min' would reintroduce the same spelling by another
 * name.
 *
 * Small-number shaped (`formatSmall`), never `formatNum`: a proc rate lives in the 0–20 band
 * and `formatNum` rounds to an integer below a thousand, so an honest 4.12 ppm would render as
 * a flat '4'. Same reasoning as the leveling rates above.
 */
export function formatPpm(n: number): string {
  return `${formatSmall(n)} ppm`
}

/**
 * A CLICKS-PER-MINUTE rate (JOS-438): '0.30 cpm'. The same number shape as `formatPpm` and a
 * DIFFERENT WORD, because that word is the whole of the reported defect — the app was printing
 * `ppm`, which the reporter read (correctly) as "procs per minute", over two abilities they were
 * pressing by hand. `cpm` reads the same way for the thing it actually is.
 */
export function formatCpm(n: number): string {
  return `${formatSmall(n)} cpm`
}

/**
 * Procs per 100 logged swing attempts: '3.52/100'. The only MECHANICALLY correct figure for a
 * chance-on-hit proc — it has none of active time's ambiguity — so it sits beside the ppm
 * headline rather than replacing it. The caller appends the word 'swings' where there is room;
 * the number's own spelling is this one everywhere.
 */
export function formatPer100(n: number): string {
  return `${formatSmall(n)}/100`
}
