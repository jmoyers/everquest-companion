// alertGroupsRefused.ts — THE REFUSAL REGISTER: alert sets the owner asked for that the log
// cannot support, kept as documentation so nobody re-derives the same dead end.
//
// Split out of alertGroups.ts, which sat one group away from the 400-code-line factoring
// ceiling. The split is not arbitrary: these entries are the exact inverse of the ones that
// stayed. A group in the catalog carries a trigger, a quoted line and an occurrence count; a
// group HERE carries none of those and never will, because the sentence it would need does not
// exist in 1.4M lines of the real log. They are prose with a shape, and their whole job is to
// answer "why isn't there an alert for X?" once, with the sweep that settled it.
//
// THE RULE THEY EXIST TO ENFORCE (alertGroups.ts header): a group whose line does NOT exist in
// the log ships `verified: false` and is NOT rendered — a guessed regex that never fires is
// worse than an absent feature, because the user believes they are covered. `VERIFIED_ALERT_GROUPS`
// filters these out; `ALERT_GROUPS` still contains them, so a future edit that quietly flips one
// to `verified: true` without a measured line fails tests/alertGroups.test.mts G4.
//
// Each entry's `unverifiedReason` states what WAS swept and what the log printed instead. Adding
// one is cheap and worth it; deleting one is how the same question gets asked a third time.

// TYPE-ONLY, so the pairing does not become a runtime import cycle: alertGroups.ts imports the
// VALUE below, this file imports only the shape, and `import type` is erased at compile time.
import type { AlertGroup } from './alertGroups'

/** The sets that cannot ship, newest last. Concatenated onto ALERT_GROUPS. */
export const REFUSED_ALERT_GROUPS: AlertGroup[] = [
  {
    id: 'feignDeath',
    title: 'Feign death failed',
    subtitle: 'Not available - the log never says a feign failed.',
    verified: false,
    unverifiedReason:
      'Full-log sweep: the ONLY feign-death lines are the success emote "<Name> has fallen to ' +
      'the ground." (103), the spell casts ("Rigamortis begins casting Feign Death."), the ' +
      'interrupt of that spell, and skill-ups ("You have become better at Feign Death!"). ' +
      'There is no failure line at all - no "ruse", no "fooled", no "not successful". A failed ' +
      'feign is invisible in the log (world-model law 6: say what the log cannot say), so any ' +
      'regex here would be a guess that never fires.',
    defs: []
  },
  {
    id: 'petDeath',
    title: 'Pet died',
    subtitle: 'Not available - the log does not mark your pet.',
    verified: false,
    unverifiedReason:
      'Your summoned pet carries a random proper name (Giber, Kibn, Vebann…) and dies with the ' +
      'ordinary "<Name> has been slain by <X>!" line - byte-identical to any other entity\'s ' +
      'death. The " pet" token seen in "A necro neophyte pet has been slain by Kibn!" belongs ' +
      "to OTHER owners' pets, never to yours. Only the world model knows which name is your " +
      'pet (bound by the owner-only "…Master." tell), and an AlertDef cannot express that ' +
      'binding - it matches text, not entities. Needs a derived event before it can ship.',
    defs: []
  },
  {
    // JOS-69. Half of a bundle the owner accepted on condition that it ship ONLY if a real log
    // line evidenced it. It does not, so this is what shipped instead.
    id: 'friendOnline',
    title: 'A friend came online',
    subtitle: 'Not available - the game never announces an arrival.',
    verified: false,
    unverifiedReason:
      'Full-log sweep (eqlog_Primitive_freeport.txt, 1,406,311 lines, 2026-08-06) for every ' +
      'shape an arrival could take - "online", "has come online", "logged in/on/out", "has ' +
      'entered the game", "friend": the friend system prints exactly TWO things and neither is ' +
      'an event. `Friends currently on EverQuest Legends:` (43×) is the /friends command\'s own ' +
      'output - a header, a dashed rule and a /who-style roster row per friend, printed only ' +
      'when you ask, describing the moment you asked. `<name> is now your friend.` (3×) is the ' +
      'confirmation of /friend add. There is no line for a friend logging IN, none for logging ' +
      'OUT, and every other occurrence of the word in the log is players using it in chat. So ' +
      'the only way to know a friend arrived is to poll /friends and diff the rosters, which is ' +
      'a thing the app would be doing, not a thing the log says - and an alert cannot fire on ' +
      'the absence of a line (the feign-death rule above). Ships when a real arrival line does.',
    defs: []
  }
]
