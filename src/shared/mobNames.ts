// mobNames.ts — IS THIS A COMMON SPAWN OR A NAMED ONE, from the name alone.
//
// `a skeleton` / `an orc pawn` — the game's own convention for a COMMON spawn is the leading
// article, and the named mobs go without one (`skeleton Lrodd`, `the ghoul lord`, `Asaka L`Rei`).
// The catalog carries no rarity field, so the article is the one signal the data itself states.
// Case-insensitive because the wiki capitalizes some articles (`A Chokidai Growler`); anchored and
// followed by whitespace so `Anaconda` and `Arisen Thaumaturgist` are not commons. A proper noun that
// happens to start with a bare `A ` word (`A Druid`) reads as a common — the rule is the article,
// and the data states nothing that could tell those apart.
//
// SHARED by the Maps tab's pin roster (commons are not listed) and the Recommended tab's target rows
// (a common's bare name can mean nine pages, so it gets no link). One fold, so the two surfaces
// cannot disagree about what a common is. Pure, no imports, node-tested by `tests/mobNames.test.mts`.

const COMMON_NAME_RE = /^(a|an)\s/i

/** True for an articled name — a common spawn, by the convention above. */
export function isCommonMob(name: string): boolean {
  return COMMON_NAME_RE.test(name)
}
