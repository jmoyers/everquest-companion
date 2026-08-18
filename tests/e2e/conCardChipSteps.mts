// THE RESIST-CHIP STEPS of the con-card spec (JOS-386, extended by JOS-387), living next door
// because con-card.e2e.mts sits AT the repo max-lines budget and the rule here is to SPLIT, never
// ratchet (drill.mts set the precedent; combatSteps.mts and dropSteps.mts followed it). The spec
// still owns the ORDER and the launch.
//
// THE TWO CLAIMS, and they need two different creatures, which is the whole reason this pair exists:
//
//   THE CUT. `a loathling lich` is level 51 and four of its five axes are ordinary at a level-50
//   caster's own level — magic R 48, fire R 36, cold R 16, disease R 76, all of which land more
//   than 60% of the time and none of which is worth a line of window over a running game. Under
//   JOS-386's R bands disease read `resistant` and drew a chip; the benchmark going viewer-relative
//   (JOS-387) is what moved it. A creature whose numbers are ordinary AT YOUR LEVEL is the case the
//   cut exists for, and the step asserts the cut rather than a count of survivors — see its own
//   comment for the day the owner's continued play made that distinction load-bearing.
//
//   THE CHIP. `a thunder spirit princess` is level 53 and reads magic R 154 and fire R 148 in the
//   committed baseline — 21% and 24% to land a plain cast, 96% and 99% with the overchannel
//   invocation up. That is the case the three-band vocabulary exists for, and its chip has to carry
//   all three parts in the owner's own order: the scannable WORD, the guidance SENTENCE under it,
//   and BOTH percentages under that.
//
// EVERY NUMBER ABOVE IS OFF THE COMMITTED BASELINE, so these are exact on a machine with EverQuest
// installed and the spec's own `{ spells: true }` carve-out covers the machine without one.

import type { Page } from 'playwright-core'
import { check, countOf, note, settle } from './appHarness.mjs'

const CARD = '[data-testid="con-card"]'
const AXES = ['magic', 'fire', 'cold', 'poison', 'disease'] as const

export const NOTABLE = 'A thunder spirit princess'
export const NOTABLE_CON = `${NOTABLE} scowls at you, ready to attack -- what would you like your tombstone to say? (Lvl: 53)`

function cardText(page: Page): Promise<string> {
  return page.evaluate(
    (sel) => (document.querySelector(sel) as HTMLElement | null)?.innerText.replace(/\s+/g, ' ').trim() ?? '',
    CARD
  )
}

function textOf(page: Page, sel: string): Promise<string> {
  return page.evaluate(
    (s) => (document.querySelector(s) as HTMLElement | null)?.innerText.replace(/\s+/g, ' ').trim() ?? '',
    sel
  )
}

async function shownAxes(card: Page): Promise<string[]> {
  const shown: string[] = []
  for (const axis of AXES) {
    if ((await countOf(card, `[data-testid="con-chip-${axis}"]`)) === 1) shown.push(axis)
  }
  return shown
}

/** True when this machine has no client spell table, which is a supported configuration. */
async function degraded(card: Page, text: string): Promise<boolean> {
  if (!/spells_us\.txt/.test(text)) return false
  check(
    '…and the card SAYS the spell data is missing rather than implying the mob is unknown',
    /Resists need your EverQuest install/.test(text),
    text.slice(0, 200)
  )
  check(
    '…and says it looked rather than drawing nothing',
    (await countOf(card, '[data-testid="con-card-no-resists"]')) === 1,
    text.slice(0, 200)
  )
  return true
}

/**
 * ONLY WHAT IT RESISTS (owner ruling, 2026-08-16 — the second one that day), asserted as the RULE
 * rather than as a fixed axis list: no ordinary axis survives, every survivor wears one of the two
 * words that change what you cast, and a card with nothing to flag says it looked.
 *
 * IT RUNS AFTER `stepResistantChip`, and that ordering is a finding rather than a preference: the
 * card arrives in TWO passes and the client's 38 MB `spells_us.txt` is read on a worker, so the
 * first pass of a launch genuinely has no resist table behind it. This step's whole claim is an
 * ABSENCE of chips, which a table that had not landed yet would satisfy for the wrong reason — so
 * the step that WAITS for a chip to appear has to have run first. (Until JOS-390 the waiting was
 * done by the drops step, which the same ticket deleted along with the drops.)
 */
export async function stepNotableChips(card: Page): Promise<void> {
  const text = await cardText(card)
  if (await degraded(card, text)) {
    note('no client spell data on this machine - the resist block took its stated degraded branch')
    return
  }
  const shown = await shownAxes(card)
  // THE RULE, NOT A ROSTER — and the difference stopped being academic on 2026-08-17 (JOS-397's
  // re-mine). This step used to assert that the lich has NO chip at all, off numbers measured when
  // the baseline was frozen; the owner kept playing, sixteen more poison observations landed on the
  // same creature, and its poison moved from R 66 over 27 casts to R 106 over 43 — genuinely
  // `resistant` at a level-50 viewer, and genuinely worth the chip it now draws. A spec pinned to
  // one creature's numbers is a hostage to whether the owner went back to Guk. So what is asserted
  // is the CUT itself: every chip that survives is one of the two words that change what you cast,
  // and an empty card says it looked.
  if (shown.length === 0) {
    check('…and a card with nothing to flag SAYS it looked, with the count it looked at', /no notable resists · n=\d+/.test(text), text.slice(0, 200))
  } else {
    for (const axis of shown) {
      const word = await textOf(card, `[data-testid="con-chip-tag-${axis}"]`)
      check(
        `the ${axis} chip survived on one of the words that change what you cast`,
        /^(resistant|very resistant)|^resists \d+% of casts/.test(word),
        word
      )
    }
  }
  // No weak/normal axis, and no "no data" chip: the two things this ruling removed.
  check('a `weak` or `normal` axis is not on the card at all', !/\b(weak|normal)\b/.test(text), text.slice(0, 240))
  check('and no chip says "no data" — an empty axis leaves rather than shrugging', !/no data/i.test(text), text.slice(0, 240))
  // NO ACRONYMS, EVER (the first ruling of 2026-08-16) — the whole reason the words are the labels.
  check('no acronym reaches the card', !/\b(MR|FR|CR|DR|PR)\b/.test(text), text.slice(0, 200))
  // Whatever the machine has, a chip either reports its answer or is not there — never the
  // withheld "not enough data" the owner overruled on 2026-08-16.
  check('and no chip withholds an answer it has', !/not enough data/i.test(text), text.slice(0, 200))
}

/**
 * A creature that really is resistant, and the three parts of its chip (JOS-387).
 *
 * AND SINCE JOS-390 IT IS ALSO THE SPEC'S WAIT FOR MAIN'S SECOND PASS. The client spell table is
 * read once per launch on a worker thread and the chips are re-sent when it lands, so this step
 * SETTLES on a chip appearing rather than reading once — which is both what makes its own three
 * assertions stable and what lets `stepNotableChips` read an empty card as an answer. The settle
 * ends early on the degraded branch: a machine with no EverQuest says so on the card, and waiting
 * for a chip that can never arrive there would burn a timeout to reach a `note`.
 */
export async function stepResistantChip(
  card: Page,
  con: (line: string, expect: string) => Promise<string>
): Promise<void> {
  const name = await con(NOTABLE_CON, NOTABLE).catch(() => '')
  if (!check(`conning a resistant creature draws its card (${name})`, name === NOTABLE, name)) return
  const text = await settle(
    () => cardText(card),
    (t) => /spells_us\.txt/.test(t) || /\bR \d+ \(\d+-\d+\)/.test(t),
    { timeoutMs: 30_000 }
  ).catch(() => cardText(card))
  if (/spells_us\.txt/.test(text)) {
    note('no client spell data on this machine - the chip’s three parts cannot be asserted here')
    return
  }
  const shown = await shownAxes(card)
  check('the card keeps ONLY the axes this creature resists', shown.join(',') === 'magic,fire', shown.join(',') || '(none)')
  if (shown.length === 0) return
  const word = await textOf(card, `[data-testid="con-chip-tag-${shown[0]}"]`)
  check('the chip is labelled with the scannable WORD', /^(resistant|very resistant)/.test(word), word)
  const guidance = await textOf(card, `[data-testid="con-chip-guidance-${shown[0]}"]`)
  check(
    '…with the guidance sentence under it',
    ['needs overchannel', 'may not land even with overchannel'].includes(guidance),
    guidance
  )
  const bench = await textOf(card, `[data-testid="con-chip-bench-${shown[0]}"]`)
  check('…and BOTH percentages under that', /^lands \d+% · with overchannel \d+%$/.test(bench), bench)
  check('…and the number and its interval and its count are still on the chip', /R \d+ \(\d+-\d+\) n=\d+/.test(text), text.slice(0, 240))
}

