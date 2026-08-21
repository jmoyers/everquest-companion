// ============================================================================
// releaseNotes — what changed, release by release, and who has not read it yet (JOS-73).
// ============================================================================
//
// THE NOTES ARE COMMITTED SOURCE, not a fetch. Three reasons, in order of weight:
//
//   1. The app must be able to say what changed while offline, in a game session, with no
//      network and no GitHub. A release note that needs a request is a release note that is
//      sometimes absent, which is worse than none at all.
//   2. The bundler INLINES this module into the renderer exactly the way it inlines spells.json
//      and the mob catalog, so the notes ship with the build that they describe. A build can
//      never show a newer release's notes, and never lose its own.
//   3. It is reviewable in the diff that ships it. The owner reads the sentence in the pull
//      request, not on a web page afterwards.
//
// THE STORE KEY IS A VERSION, NOT A BOOLEAN. `lastSeenNotesVersion` (src/main/store.ts) holds
// the newest release whose notes this install has been SHOWN. That is what makes the A→D case
// work without bookkeeping: somebody who was on 0.6.3 and lands on 0.8.0 has TWO releases of
// news, and the panel marks both, because "new" is a comparison and not a flag somebody had to
// remember to set per release.
//
// AND AN ABSENT KEY MEANS A FRESH INSTALL, WHICH HAS NO NEWS. Nothing is marked, and the teaser
// strip never appears — a person who installed the app twenty minutes ago did not live through
// any of these changes, and telling them "Updated to v0.8.0" on their first launch would be a
// small lie in the first sentence the app ever says to them. The panel is still there to browse;
// it is history, and history is available to everyone.
//
// WHY THE STAMP IS THE NEWEST NOTE VERSION AND NOT `app.getVersion()`. package.json carries
// `0.1.0` forever — CI stamps the real version FROM THE TAG and never commits it (AGENTS.md,
// Shipping), so `app.getVersion()` reads 0.1.0 on every dev run. Stamping that would make every
// release look new on every launch in dev, and comparing against it would blank the whole
// feature there. The newest entry in this list IS the running version in every published build
// (the release job refuses a tag with no entry — scripts/check-release-notes.mjs), so reading it
// from the data is both honest and testable from a checkout.
//
// VOICE: player-centric and plain. What YOU can now do, or what stopped being wrong. Not wave
// names, not module names, not ticket ids. `kind` is the only structure — the panel groups by it
// into "New" / "Fixed" / "Changed" sub-headers, and a release whose entries carry no kind (the
// one-line historical headlines below) renders as a bare line with no sub-header at all.
//
// A NEW SURFACE EARNS EXTRA BULLETS — AT MOST FIVE (JOS-80, owner direction). The rule to apply
// when writing a release's notes, including the per-release draft cut at tag time:
//
//   * A FIX, A CHANGE, A NEW OPTION → ONE bullet. "What changed" is the whole answer. A player
//     reading "Maps render north correctly" needs nothing more, and explaining why north matters
//     would be padding.
//   * A NEW TAB, OR A MAJOR NEW SURFACE (a new mode on a tab, a new window, a way of working that
//     did not exist) → TWO TO FIVE bullets, never more than five. One says what it is; the others
//     say why it was built — the problem, in the player's terms and from before the thing existed
//     — and what they can now do with it. Nobody has any idea why a tab they have never seen is
//     there, and the one line that names it cannot tell them.
//
// IT IS PLAIN BULLETS IN THE SAME LIST, and that is the whole mechanism (owner ruling, 2026-08-07,
// which reversed a `detail` sub-paragraph field this ticket started out building). No extra field,
// no second rendering, no card, no header: an introduction is simply a change that took a few more
// lines to state. The renderer never learns that some bullets are special, so there is no way for
// the panel to become shouty and no shape for a future author to misuse.
//
//   * WHEN IN DOUBT, LEAVE IT OUT. The contrast is the signal: if most changes carried three
//     bullets the introductions would stop standing out. A release that was a rollup of fixes gets
//     no "why" at all — inventing one for a batch of repairs is the failure this rule prevents.
//
// A bullet NEVER restates its neighbour, never names a file, a module or a wave, and never
// explains how the app works internally (state, never process — the UI conventions).

/** Which sub-header an entry sits under. Absent ⇒ the entry is a bullet under no sub-header. */
export type ReleaseEntryKind = 'new' | 'fixed' | 'changed'

/** One bullet of a release's notes. */
export interface ReleaseEntry {
  readonly kind?: ReleaseEntryKind
  readonly text: string
  /**
   * THIS ONE CAME FROM A PLAYER (JOS-76, owner direction).
   *
   * Set only where a user report actually generated the work — the panel renders a small
   * "player report" chip on the bullet, and any release carrying one gets a single plain thanks
   * line under its header. NOBODY IS EVER NAMED: reports arrive with an install id and, when the
   * reporter chose to leave one, a contact — none of which belongs on a screen every other user
   * can read. The thanks is collective on purpose.
   *
   * THE BAR IS TRACEABILITY, NOT PLAUSIBILITY. A flag is set here only when the commit that did
   * the work cites a report (a report id, "the YouTube report", "Mac/CrossOver user report").
   * Owner-found defects are NOT tagged even though they were also "reported" — thanking the
   * community for the owner's own bug reports would make the chip mean nothing. When the trail is
   * unclear, the entry ships untagged: an unearned thanks costs more than a missing one.
   */
  readonly fromReport?: boolean
}

/** One release. `date` is an ISO calendar date (YYYY-MM-DD), rendered through the app's own
 *  local-date formatter — never parsed for arithmetic. */
export interface ReleaseNote {
  readonly version: string
  readonly date: string
  readonly entries: readonly ReleaseEntry[]
}

/**
 * Every release, NEWEST FIRST — the order the panel renders and the order every derivation
 * below assumes (`releaseNotesProblems` pins it, so the assumption is checked rather than
 * trusted).
 *
 * EVERY RELEASE IS BULLETS (JOS-76). The backfilled ones shipped first as single comma-separated
 * sentences, which is how "four things happened" gets read as one thing: a bullet per change is
 * the whole difference between a list somebody scans and a paragraph somebody skips. Each
 * historical release is split only as far as its own tag range honestly supports — two to four
 * bullets where the range holds that many player-facing changes, one where it holds one. Nothing
 * is invented to reach a count.
 *
 * …and a release that INTRODUCED a surface spends a few more of them on it (JOS-80 — see the
 * header's voice section for the cap and the rule). Four introductions carry that treatment
 * today: the What's new panel and the "This week" lockout view in 0.9.0, and, backfilled where
 * the tag range supports honest prose, the exaltation planner and the celebration cards in
 * 0.4.0 — plus in-app feedback in 0.3.0, which is the one judgment call in the set.
 *
 * The releases before 0.7.0 carry no `kind`. They are backfilled from the tag dates and the
 * commits in each tag's range, and sorting them into New/Fixed/Changed after the fact would be
 * guessing at a distinction nobody drew at the time — so they render as plain bullets, which is
 * an honest shape rather than a degraded one.
 *
 * v0.3.3 is deliberately ABSENT: its tag points at the same commit as v0.3.2, so there is
 * nothing it changed. The comparison is by version, not by row, so an install stamped 0.3.3
 * still sees exactly the releases above it.
 */
export const RELEASE_NOTES: readonly ReleaseNote[] = [
  {
    version: '1.6.0',
    date: '2026-08-19',
    entries: [
      {
        kind: 'new',
        text: 'Plane of Sky has a Targets tab: every mob you still need to kill, deduplicated across your open quests, with the items each one drops and doors to the quests that need them. Built on a community pull request - thank you.',
        fromReport: true
      },
      {
        kind: 'new',
        text: 'The Targets list reads in walk order - grouped by island, lowest first, with mobs whose island the drop data does not state grouped honestly at the bottom. A "first time only" box (on by default) keeps quests you have already handed in off the list; untick it when you are refarming.'
      },
      {
        kind: 'fixed',
        text: 'Plane of Sky counts: a wind rune looted into your currency tab now counts, even after you have handed that quest in before. The inventory export never lists currency-tab items, and a turn-in was being charged against both your export and your log at once - so refarmed runes read zero. Rune rows now also say when an item can never appear in the export, and point at the hand-count pencil.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'Overwriting one mez with another - Dazzle over Mesmerization - now retires the old bar and tracks the new spell under its own name and duration. Before, the old bar squatted at zero and a nameless bar counted up underneath it.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'The Buffs tab shows the rank you actually cast. Levelling Mesmerization to X no longer leaves the Debuffs list saying VI forever.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'The shaman Curse now reaches the debuff tracker - its landing message lost a word in the wiki import, so the tracker never recognized it. The registry now audits every spell for that defect class at build time, and the sweep repaired 41 more rows. A community contributor found the mechanism - thank you.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'Pacify, Reoccurring Amnesia and the rest of the lull and memory-blur families - 18 spells - are debuffs now, not buffs, and reach the debuff overlay.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'Rain spells parse by their real mechanics: a fixed number of waves per cast, counted once as spell damage. Lava Storm and its sixteen cousins no longer split into a phantom proc row with an invented procs-per-minute.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'The Character tab reads every worn item at its own +N upgrade level, through the same scaling the Gear tab already used. A Cloak of Flames +5 now shows +41% haste, AC 15 and HP 75 instead of the base values - and every other scaled stat moved with it.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'Data corrections: North and South Kaladim maps were swapped; Protector of Sky is on island 2, not 7; the Scintillating Bracer of Protection is the Shimmering Bracer; and Leach is the level 9 necromancer spell it always was.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'Mobs whose full title differs from their catalog name - Innoruuk, the Prince of Hate - now fold their resist history correctly, so the con card shows what your past fights learned instead of "nothing seen yet". A restart re-reads your whole log, so the history lights up on its own.'
      },
      {
        kind: 'fixed',
        text: 'The auto-hide overlays no longer flicker when you alt-tab back into EverQuest. They also stop being real hide/show at all: they fade to invisible and back, so there is no stale frame to strobe - and no z-order churn over the game.'
      },
      {
        kind: 'changed',
        text: 'Clicking a mob card or a celebration toast raises the Companion without hiding your overlays - using an overlay is not leaving the game. Alt-tabbing into the Companion yourself still hides them, as before.'
      },
      {
        kind: 'changed',
        text: 'When security software on your PC blocks the update check, the app now says exactly that and retries on the next check - instead of blaming the download and backing off for hours. Sound pack downloads that hit a busy download host now wait politely and resume, rather than failing after three fast tries.'
      },
      {
        kind: 'changed',
        text: 'Under the hood: learned resist data survives a full disk and a torn file, and crash reports name which helper process died instead of arriving blank.'
      }
    ]
  },
  {
    version: '1.5.0',
    date: '2026-08-17',
    entries: [
      {
        kind: 'new',
        text: 'Preferences has an Appearance section. In-app text size steps with A- / A+. Below it, the overlays: one text size and one transparency for all of them, or turn on Independent per overlay and set each window - the meters, the buffs and debuffs, XP, respawn, the event log, the celebration toasts, the alert banner and the mob card - on its own row. Every overlay\'s own A- / A+ and background slider still work and stay in step with the page, and the toasts, banner and mob card get a transparency slider for the first time. Whatever sizes and transparency you have today are exactly what you have after the update.',
        fromReport: true
      },
      {
        kind: 'changed',
        text: 'The mob card, the celebration toasts and the alert banner grow with their text size: at 200% the mob card is the same card, twice as big, instead of the same width with the text crammed into it. Its resist chips wrap into rows when there is not room for them across, rather than squeezing.'
      },
      {
        kind: 'fixed',
        text: 'Plane of Sky counts after an inventory export: handing a quest in after the export now lowers the count and the Cleanup row, the same way destroying an item does. Before, an item the export had seen stayed counted until you exported again.',
        fromReport: true
      }
    ]
  },
  {
    version: '1.4.0',
    date: '2026-08-17',
    entries: [
      {
        kind: 'new',
        text: 'The buff and debuff windows can track only what you choose. On the Buffs tab, turn on Only track buffs and debuffs I check: a checkbox appears on every buff and debuff card and on every row of the durations tables, which you can search - and the windows draw only what you have checked. Off, and everything shows as before.',
        fromReport: true
      },
      {
        kind: 'changed',
        text: 'Destroying an item in the game now counts. The log records the destroy, so Plane of Sky and inventory counts go down by what you destroyed - and the Cleanup tab no longer needs a button for it. Cleanup is also live from your log and inventory export like every other Sky tab, is laid out as a table, and the reward names open the item card on hover.'
      },
      {
        kind: 'changed',
        text: 'Wherever you pick classes - Gear, the Planner, your loadout - the choices read Warrior and Shadow Knight rather than WAR and SHD.'
      }
    ]
  },
  {
    version: '1.3.0',
    date: '2026-08-16',
    entries: [
      {
        kind: 'new',
        text: 'Every mob’s page now shows what it resists, mined from your own game log over a shipped baseline: magic, fire, cold, poison and disease, each with a plain verdict - should land, needs overchannel, or may not land even with overchannel - the chance with and without overchannel at your level, and how much evidence stands behind it. Your own casts outweigh the shipped data, and recent casts outweigh old ones.'
      },
      {
        kind: 'new',
        text: 'Every cast is read for what it had going for it - the spell’s own resist adjust, its upgrade rank, overchannel, and any tash, malo or scent on the target - so a resist under overchannel counts for more than one without.'
      },
      {
        kind: 'new',
        text: '/con a creature and a small card appears at the top of the screen with its name, level and only the resists that would change what you cast. Click it to open the mob’s page, or the X to dismiss it. It stays a few seconds, is on by default, and Preferences, Overlays turns it off.',
        fromReport: true
      },
      {
        kind: 'new',
        text: 'Plane of Sky has a Cleanup tab: the quest items you could destroy because every quest that needs them has been turned in, with the quantity, where they sit, and the turn-in and reward you would give up by destroying them. Mark a stack destroyed and the counts follow.'
      },
      {
        kind: 'new',
        text: 'New at this level now says what each spell is worth - damage and healing, per second and per point of mana - whether another of your classes already has it, which spell in your repertoire it replaces (hover the name to compare), and whether that spell is memorized right now and in which named spell set.'
      },
      {
        kind: 'new',
        text: 'Search spells from the same panel: type a name, a class, a level or a range in any order - 27-28 cleric shaman - and the matches list the level every class gets them, with the same figures.'
      },
      {
        kind: 'fixed',
        text: 'Spells that are not yet in era on this server, Sloths Healing at 50 among them, no longer appear as new at a level; they fold under an out-of-era line, and search and the spell card mark them.'
      },
      {
        kind: 'fixed',
        text: 'Spells whose damage the wiki page leaves out - Odium and a dozen more - now show it, read from the game’s own spell data.'
      }
    ]
  },
  {
    version: '1.2.0',
    date: '2026-08-16',
    entries: [
      {
        kind: 'new',
        text: 'Closing the window can keep the companion running in the system tray - your timers, alerts and overlays carry on, and the window is out of the taskbar and out of Alt-Tab. It is off until you turn it on: Preferences, Window, or the row at the foot of the title bar’s Overlay menu.',
        fromReport: true
      },
      {
        kind: 'new',
        text: 'With it on, click the tray icon to bring the window back, or right-click it to quit. The first time a close hides the window, a small card above the tray icon says so and offers Quit now, Always quit instead, or Got it.'
      },
      {
        kind: 'fixed',
        text: 'A locked overlay whose controls came out while the Alt-Tab switcher was open no longer stays that way: it lets go and returns to click-through by itself once your pointer has left it.'
      },
      {
        kind: 'fixed',
        text: 'The Alert banner switch in Preferences opens showing your real setting instead of flashing off and then on.'
      },
      {
        kind: 'changed',
        text: 'Overlays show no hover tooltips anywhere, the title bar included, and a locked overlay’s title bar keeps its height when the unlock pin appears.'
      },
      {
        kind: 'changed',
        text: 'The preferences gear has left the window title bar - Preferences lives in the left navigation.'
      }
    ]
  },
  {
    version: '1.1.0',
    date: '2026-08-16',
    entries: [
      {
        kind: 'new',
        text: 'A new Alert banner overlay puts your alerts on screen as large text - for the moments a voice line is lost under Discord. It is off until you turn it on in Preferences, Overlays; then each alert gets a Show on screen switch and an optional on-screen wording of its own (the alert name is used until you write one). Early-warning alerts count down on the banner.',
        fromReport: true
      },
      {
        kind: 'changed',
        text: 'A debuff on a mob learns its real length from the corpse: when the mob dies with your slow or debuff still on it and no wear-off ever printed, the timer knows it lasted at least that long, says "at least" on the bar, and warns you later next time instead of guessing early off the spell list.'
      },
      {
        kind: 'changed',
        text: 'A mob page and the current-mob card fold out-of-era loot away - Cazic Thule stops offering the Fear revamp table - with a small "out of era" disclosure if you want to see it anyway.'
      },
      {
        kind: 'fixed',
        text: 'A raid-target defeat celebrated exactly once: alerts fired by the app itself (raid target defeated, quest complete) were quietly playing twice, and they no longer also put a banner line beside the celebration card unless you ask.'
      }
    ]
  },
  {
    version: '1.0.1',
    date: '2026-08-15',
    entries: [
      {
        kind: 'fixed',
        text: 'The cursor ring lines up with the pointer under Windows display scaling and on multi-monitor setups, and it stays on the monitor the game is on - it no longer shows up offset when the pointer crosses to a second screen.',
        fromReport: true
      }
    ]
  },
  {
    version: '1.0.0',
    date: '2026-08-15',
    entries: [
      {
        kind: 'new',
        text: 'A Performance setting, on by default, has the companion yield the CPU to EverQuest: every companion window runs at below-normal priority, so a busy moment on this side is never a fair fight with the game for a frame. Preferences, Performance, if you ever want it off.'
      },
      {
        kind: 'new',
        text: 'A bug report now carries a ten-minute performance timeline - how late the companion ran, how long each read of your log took, and what was open at the time - shown in the report preview before it goes, so "it hitched" can actually be diagnosed.'
      },
      {
        kind: 'changed',
        text: 'The log is read through one open handle in small bounded slices instead of being reopened up to twice a second and read in one gulp - less contention with the game writing the same file, and less for antivirus to look at again.'
      },
      {
        kind: 'changed',
        text: 'The natural voice speaks from a single core. It used to take every core for a second per new phrase and finish no sooner; a new phrase now arrives just as fast and leaves the rest of the machine to the game.'
      },
      {
        kind: 'changed',
        text: 'Overlays re-assert "always on top" only when Windows has actually taken it away, not on every show and hide - fewer window-order changes over the game.'
      },
      {
        kind: 'changed',
        text: 'Anonymous usage counts gain a few bucketed machine facts (cores, memory, graphics vendor, displays, the game display mode) and per-session smoothness numbers - still nothing from your log, still nothing typed. What this app measures lists every field.'
      },
      {
        kind: 'fixed',
        text: 'A name with an accented or non-Latin character can no longer be garbled when the first read of your history happens to split it across a read boundary.'
      }
    ]
  },
  {
    version: '0.28.0',
    date: '2026-08-14',
    entries: [
      {
        kind: 'new',
        text: 'The meter card grows a Mitigation tab on the incoming side: how often you block, dodge, parry, and riposte - counts and rates over the swings actually aimed at you - with your riposte damage broken out inside your melee total. Damage breakdown stays the first thing you see.',
        fromReport: true
      },
      {
        kind: 'new',
        text: 'Alert phrases can name the mob a spell landed on or faded from: write {target} in a custom phrase and the name is filled in for you - no pattern to write. Suggested fade and break alerts say it by default, and the phrase editor lists the words each alert can fill.',
        fromReport: true
      },
      {
        kind: 'new',
        text: 'A Plane of Sky item count can be stated by hand - a pencil on the quest panel Have cell - and correcting the count is what clears a stuck Ready entry. A by-hand chip states the number came from you, and one click takes it back.',
        fromReport: true
      },
      {
        kind: 'new',
        text: 'A fourth Sky counting mode, rebaseline: load an inventory dump and older loot evidence is set aside - the dump is the floor, and only what the log says after it moves the numbers.',
        fromReport: true
      },
      {
        kind: 'new',
        text: 'Heal-over-time spells raise alerts now: a new trigger fires on the heal itself, so it works for every rank of the spell, and beneficial spells landing on you have their own template too.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'Slugs Healing had no log sentences on record, so no trigger could ever fire for it and no timer could learn it - the shaman heal ladder speaks its real sentences now.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'Several alerts firing in the same instant all sound now: distinct voice lines each play once instead of the first alert muting the rest - four song resists in one pulse are four spoken facts. Identical sounds still fold into one.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'A loot alert no longer silently discards a pattern typed without a field: the editor names its fields and refuses to save half a condition.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'A re-summoned pet whose only introduction is its own buff landing binds again - and a summoned pet never times out: it ends when it dies, is dismissed, or you swap loadouts.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'The Combat tab and the Mobs tab agree on kill counts: a mob opened from a fight card no longer reads zero kills.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'Disrupting Shot reads level 20 without a disputed flag - confirmed in play.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'An update check interrupted by the machine going to sleep retries on wake instead of counting as a failure - and a check that did fail says so instead of looking like success.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'Under Wine or Crossover the app no longer forces the one graphics path Wine cannot draw, so the window renders instead of coming up blank. Still unsupported - but no longer broken by default.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'The spoken-phrase entry on an alert row says what it is now - Edit spoken phrase - and opens every time you pick it, not just the first.'
      },
      {
        kind: 'changed',
        text: 'Overlay bars no longer pop tooltips over the game. The window title bar keeps its hints, and a tooltip never lingers after your mouse leaves the window.'
      },
      {
        kind: 'changed',
        text: 'Alerts play a sound or speak - the combined sound-plus-voice option is gone. An alert that used it speaks if it has a phrase and plays its sound otherwise; nothing else about your alerts changed.'
      },
      {
        kind: 'changed',
        text: 'The spoken voice is one setting now: change it in Preferences and every spoken alert changes with it. Alerts no longer keep the voice they happened to be created with.'
      }
    ]
  },
  {
    version: '0.27.0',
    date: '2026-08-13',
    entries: [
      {
        kind: 'new',
        text: 'Exaltations, Gear and your character now live in one place: a single Gear entry in the sidebar with four tabs - gear search, exaltation search, your wish list, and Character.'
      },
      {
        kind: 'new',
        text: 'The Wish list is new: a flat list of the gear and exaltations you are going after, added or removed with one click from either search tab or from the list itself. It groups wishes by the zone that feeds them, with merge costs for exaltations and an also-drops-in line beside each.'
      },
      {
        kind: 'new',
        text: 'The wish list marks wishes done on its own: when your inventory dump or your loot history shows one fulfilled, it moves to a done strip - there is no box to tick. Anything you had planned on the old exaltation board was imported once, labeled as an import, and deletable.'
      },
      {
        kind: 'new',
        text: 'The Character tab shows your worn gear as your dump states it - every slot at its upgrade level with any socketed exaltations - plus a searchable ledger of everything you carry: bags, bank, depot, key rings, each place its own lane.'
      },
      {
        kind: 'new',
        text: 'Hover a gear search row and a card compares that item against what you are wearing, cell by cell, differences computed, with the age of your inventory dump stated right on the card.'
      },
      {
        kind: 'new',
        text: 'Effective HP is a gear column now - raw HP plus stamina, no soft cap - pickable and sortable like Ratio, and the upgrade slider re-ranks it.'
      },
      {
        kind: 'new',
        text: 'Bug reports can carry your inventory dump, on by default and shown before anything is sent - so a quest item the app does not recognize becomes answerable from the report itself.'
      },
      {
        kind: 'new',
        text: "Clicking a level-up toast now lands you on the New-at-this-level panel itself - scrolled into view and lit - and the toast says so, with a See-what's-new button naming the level."
      },
      {
        kind: 'changed',
        text: 'The era filter now hides gear the record cannot place in the current era instead of showing it with a question mark, and the verdicts the wiki keeps on armor-set, quest and monster pages now count: an item whose only mold, awarding quest or dropper is out of era reads out of era, with the reason named in its chip.'
      },
      {
        kind: 'changed',
        text: 'Class picks on the gear table now remove non-matching rows instead of tagging them, slots are a multi-select, weapon types - and one-handed versus two-handed - are filters of their own, and the stat-threshold boxes are gone: sorting covers that. The item name column is wider, the stat columns smaller.'
      },
      {
        kind: 'changed',
        text: 'The tier and elapsed/active choices are one setting shared by the app and the XP overlay - flip either side and both move - and Leveling opens on this tier and elapsed time. Both toggles explain themselves on hover.'
      },
      {
        kind: 'changed',
        text: 'The leveling charts scale their axes properly at short windows: headroom above the curve instead of a line against the frame, your level and the next as the level chart range, a quieter zone strip, and axis labels that no longer stretch.'
      },
      {
        kind: 'changed',
        text: 'The scope bar above the charts is one row of controls with one caption line beneath it, and the New-at-this-level panel fills the space beside Recent progress instead of hanging below everything.'
      },
      {
        kind: 'changed',
        text: 'Invigor - a classic-era spell the game does not have - no longer appears in the unlock list or alert suggestions, and the removal is recorded so a wiki edit cannot bring it back unnoticed.'
      },
      {
        kind: 'fixed',
        text: 'Gear-area filters, sorts, searches and the upgrade slider now survive drilling into an item and switching modules; the structural picks survive a restart, and what you typed lasts the session.'
      },
      {
        kind: 'fixed',
        text: 'Rogue poison coats now clear when you die and when your loadout stops being a rogue, instead of surviving untouched from your last rogue session.'
      },
      {
        kind: 'fixed',
        text: 'Preferences show your real settings from the first painted frame - no more toggles flickering from a default onto your stored value.'
      },
      {
        kind: 'fixed',
        text: "Typing snail's finds Snails Healing. Possessive spellings match every spell name now, in both directions - and a handful of blank wiki message stubs stopped masquerading as trigger sentences."
      },
      {
        kind: 'fixed',
        text: 'A re-announced level can no longer draw your progress emptying. When the game restates the level you already hold, the curve refuses the span instead of inventing a descent.'
      },
      {
        kind: 'changed',
        text: 'The favorite star column left the loot ledger. Item stars still work where they earn their keep - the Plane of Sky quest tables - and starred items still travel in share bundles.'
      }
    ]
  },
  {
    version: '0.26.0',
    date: '2026-08-13',
    entries: [
      {
        kind: 'fixed',
        text: "A group-mate's summoned pet joins the meter. When its owner runs /pet who leader once, the pet gets its own row - Pet (Name) with the owner's name - and its damage stops falling on the floor. Charm pets are untouched: they still bind off the charm itself and still end when it breaks.",
        fromReport: true
      },
      {
        kind: 'fixed',
        text: "An ally's pet row no longer expires on a clock. It used to vanish after the spell's listed duration even mid-fight - wrong for every AA-extended charm and meaningless for a summon. The row now lives as long as the pet keeps appearing in the log, and only death, zoning, or the log's own break evidence ends it.",
        fromReport: true
      },
      {
        kind: 'changed',
        text: "Feedback log slices now keep the one mechanical line where a pet names its leader, even when the leader is a group-mate. It is the sentence that proves whose pet is whose, the same name already appears in every combat line of the slice, and player chat stays scrubbed exactly as before."
      },
      {
        kind: 'new',
        text: 'Pick your default sound pack once, and it sticks. A star in the sound-pack browser makes any installed pack the default for new and suggested alerts, and deleting a shipped pack now means deleted - the app stops quietly re-downloading it at the next start. Nothing goes silently mute: sounds from a removed pack play through your default with a caption saying so.',
        fromReport: true
      }
    ]
  },
  {
    version: '0.25.0',
    date: '2026-08-13',
    entries: [
      {
        kind: 'fixed',
        text: 'The loot ledger renders everything you scroll to. Opening an item and coming back used to freeze the list at its first screenful - the scrollbar moved, the rows did not - and the dead scroll space above and below the list is gone with it.',
        fromReport: true
      },
      {
        kind: 'new',
        text: 'The loot summary states its rate both ways - per hour of active time and per hour of elapsed time, side by side, each naming the span it measured. A long regen break stops inflating your motes-per-hour without a word of explanation.',
        fromReport: true
      },
      {
        kind: 'new',
        text: 'The Plane of Sky tab reads your /outputfile inventory dump by itself the moment the file changes - the reload button is gone because there is nothing left to press. A quiet line under the count-source picker says when the dump was written and when it was read, and turns warning-colored only when your copy is provably stale.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'A spell alert survives ranking up. Resist and cast alerts matched the exact name, so an alert on Elemental Maelstrom went silent the day you unlocked II. Every rank of the spell now matches, in both directions.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'Buffs from last night survive a slow login. The app no longer guesses what counts as logging in from a 30-second window - it reads the log lines only an in-world character can produce - so long loading screens, crowded character selects, and starting the app mid-load stop wiping the buff bar.',
        fromReport: true
      },
      {
        kind: 'new',
        text: 'Summon a pet and never order it, and the meter cannot see it - the game prints nothing that ties the pet to you. The meter now says so once, quietly, on its own overlay: order it once or type /pet who leader. The sentence times out by itself and does not nag.',
        fromReport: true
      },
      {
        kind: 'new',
        text: 'Patch notes are one click from the version number - the icon beside it opens What is new, and the panel carries a link to every release on GitHub.',
        fromReport: true
      },
      {
        kind: 'new',
        text: 'The DPS-over-time legend answers clicks: hide any line, the scale re-fits what is drawn, and the choice sticks between sessions. Hidden entries stay in the legend, dimmed, so the way back is where the way in was.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'A full disk no longer makes the app thrash - the small local telemetry file writes atomically, cleans up after a failed attempt, and backs off instead of retrying every event.'
      },
      {
        kind: 'fixed',
        text: 'A cached wiki image that fails to read from disk heals itself - evicted and re-fetched - instead of logging an error and showing a blank.'
      },
      {
        kind: 'changed',
        text: 'The app phones home a fifth as often: usage counters leave in one batch every five minutes instead of every minute, and the idle pulse is every ten. Nothing new is collected - the batches are just bigger and rarer.'
      }
    ]
  },
  {
    version: '0.24.0',
    date: '2026-08-12',
    entries: [
      {
        kind: 'new',
        text: "A group-mate's charm pet now shows on the meter as its own row - Pet (Name) with the charmer's name - credited from the moment the charm lands to the moment the log proves it broke, and never a second longer. The instant an ex-pet swings at anyone friendly, even a miss, it stops counting. Your own rows are untouched by any of it.",
        fromReport: true
      },
      {
        kind: 'fixed',
        text: "Every charm in the game now binds, counts down, and speaks when it breaks - the druid and shaman animal charms (Befriend Animal, Call of Karana, Tunare's Request) were silent before, and Tunare's Request runs almost three hours. Solon's Song of the Sirens breaks as the charm it is, not a mez.",
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'Vengeance of the Wild opens a debuff row like any other dot - the wiki wrote its landing line in a shape the catalog missed.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'Blessing of the Theurgist counts in the Procs list - a proc whose only trace is its own sentence, with no damage or heal line, is now a kind of proc the meter understands.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'A dot with an initial hit no longer splits into two meter bars - one spell, one bar, with the landing and tick components one click down.',
        fromReport: true
      },
      {
        kind: 'new',
        text: 'Hover any "active time" or per-hour label and it tells you exactly what the clock counts: gaps over five minutes with no experience, kill, or loot line pause it - not an AFK check, not combat time.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'When a downloaded natural voice cannot load, the app now says so - in the voice picker and on the alert - instead of silently speaking in the default system voice. The usual fix (the Microsoft Visual C++ runtime) is named right there.',
        fromReport: true
      },
      {
        kind: 'new',
        text: 'The window remembers its size, position, and maximized state across restarts - and a launch with a monitor unplugged fits the screen you have without forgetting the layout you chose.',
        fromReport: true
      }
    ]
  },
  {
    version: '0.23.0',
    date: '2026-08-12',
    entries: [
      {
        kind: 'fixed',
        text: 'Killing a mob that shares a name with your mezzed mob no longer wipes the mez timer. A mezzed mob can never be the corpse, so the bar and its count survive the adds dying around it.'
      },
      {
        kind: 'fixed',
        text: "Largo's binding songs no longer trip the mez-break alert - they announce as the slows they are, and every real mez break and charm break still speaks.",
        fromReport: true
      },
      {
        kind: 'new',
        text: 'Alerts can warn you early: set Warn early (sec) on an alert and it speaks before the tracked debuff drops - on wear-off alerts too, where it arms when the debuff lands and counts back from the bar on screen. A debuff that breaks before the warning still speaks at the break.',
        fromReport: true
      },
      {
        kind: 'new',
        text: 'An Always play switch in the Alerts toolbar lets every alert skip the audio throttle - each alert\'s own setting greys out while the global one is in charge.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: "Alerts made from the catalog now fire when you cast a ranked spell - Swift Like the Wind IV counts as Swift Like The Wind, with the rank shown as a small chip beside the buff's name."
      },
      {
        kind: 'fixed',
        text: 'When three clean casts agree your buff runs shorter than the wiki says, the app now believes its own stopwatch - Alacrity, Tashina and friends stop promising minutes they never deliver.',
        fromReport: true
      },
      {
        kind: 'new',
        text: 'Permanent self-buffs - Yaulp, the shielding lines, blade coats, Lich and the wolf forms - can now appear in the buff window behind a new show-permanent switch, off by default. The forms also stopped quietly vanishing from the list after 90 minutes.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'Pacify and the calm line now time on the debuff overlay with the other mob timers, instead of posing as one of your own buffs.',
        fromReport: true
      },
      {
        kind: 'changed',
        text: 'The damage meter now opens on Everyone. Group tracking from the log is imperfect and the meter should just show numbers - a Group choice you made on purpose is kept.',
        fromReport: true
      },
      {
        kind: 'changed',
        text: 'Your combat drilldown survives switching fights - drill into a source on one fight, flip to another and back, and you are still where you left off. Only changing direction starts you over.'
      },
      {
        kind: 'fixed',
        text: 'Raid targets stopped double-listing a class trio you swapped away from and back to - one loadout, one section, however many stretches it took - and Defeated only now follows the This week view instead of always answering for all time.'
      },
      {
        kind: 'fixed',
        text: 'The raid board no longer invents a class trio you never played: a swap the log dates is honored, and a stretch the app cannot untangle says Mixed loadouts instead of guessing.'
      },
      {
        kind: 'changed',
        text: 'The fast-start switch from 0.22.0 is retired. Fleet numbers showed machines read the log quickly without it, and it taxed every future improvement - startup reads your history in full again.'
      },
      {
        kind: 'fixed',
        text: 'The spell-message counts in the log no longer double on every launch, and a failed update check now explains itself instead of showing a raw parse error.',
        fromReport: true
      }
    ]
  },
  {
    version: '0.22.0',
    date: '2026-08-11',
    entries: [
      {
        kind: 'new',
        text: 'A new Performance switch in Preferences: Start faster by remembering your log. Turned on, the app checkpoints what it has already read, so a morning start resumes in about a second instead of re-reading your whole history - and it continuously proves the remembered state matches a full read, falling back to one at the first hint of doubt. Off by default while it earns its keep.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'A fight can no longer be split in two by startup timing. Reading your history could close an open fight against the wrong clock if the meter was glanced at mid-read - so two launches could disagree about your fight list. Fixed for every launch, switch on or off.'
      },
      {
        kind: 'fixed',
        text: 'In the exaltations planner, the item you narrowed to now survives switching between proc, worn, focus and click.'
      },
      {
        kind: 'new',
        text: 'The planner can start from the item side now: search any worn item and browse just the effects compatible with it.'
      }
    ]
  },
  {
    version: '0.21.0',
    date: '2026-08-11',
    entries: [
      {
        kind: 'new',
        text: 'A new Timers tab: respawn clocks built from your own kills. Watch a mob from Recently killed and the clock starts from the kill you already made - your measured gaps drive the estimate, and the wiki value is only a default under them.',
        fromReport: true
      },
      {
        kind: 'new',
        text: 'The clocks are honest about what they know: a mob the log names reads UP instead of a stale countdown, a long-quiet estimate says due long ago instead of counting forever, and nothing is tracked until you ask. Hover a row for the mob\'s drops, your own gaps, and the wiki\'s word on it.'
      },
      {
        kind: 'new',
        text: 'Every clock is yours to overrule: an edit control shows the evidence - all your gaps, the wiki time, a link to the page - then takes entries like 44m 30s, marks the row as overridden, and reverts to the calculated value on request. A floating Respawn overlay carries the clocks over the game, scoped to the zone you are in.'
      },
      {
        kind: 'fixed',
        text: 'Doing /who now corrects your level and classes everywhere, immediately - the app no longer believes an abandoned loadout\'s last level forever, and each surface says where its answer came from and how fresh it is.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'A buff or debuff bar you dismiss stays dismissed without touching what the app has learned - and duration learning now waits long enough to catch buffs your AAs have extended well past the wiki\'s number.',
        fromReport: true
      },
      {
        kind: 'new',
        text: 'The XP overlay shows AA per hour while you level, beside your level pace - not only at the cap.'
      },
      {
        kind: 'changed',
        text: 'Plane of Sky search answers instantly now, even with the whole list showing - and it finds bosses and islands too, so typing Gorgalosk or Island 7 narrows exactly like picking them would.'
      },
      {
        kind: 'fixed',
        text: 'The Maps tab holds its ground while it loads - nothing shifts when the map image arrives - and Castle Mistmoore\'s map opens when you zone in, now that the app understands the game\'s own name for it.'
      },
      {
        kind: 'fixed',
        text: 'Rapidly toggling overlays from the title-bar menu no longer maximizes the window.'
      }
    ]
  },
  {
    version: '0.20.0',
    date: '2026-08-10',
    entries: [
      {
        kind: 'fixed',
        text: 'A bard\'s Solon\'s Bewitching Bravura is read as the charm it is, so the charm-break alert finally goes off when your charm lets go. Any charm can have an alert of its own now too - pick the spell by name and hear which one broke.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'Alt-tab out of EverQuest and you stay where you went - the overlays no longer drag you back into the game as they hide.',
        fromReport: true
      },
      {
        kind: 'changed',
        text: '"Hide overlays when you\'re not in EverQuest" now counts this app too, so the meters get out of the way while you browse the Companion - and the cursor ring rests here as well, since your pointer is not over the game. Clicking an overlay itself still keeps them up.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'A press of the mouse\'s back button goes back a page inside the app - from an item description to the page that opened it. It only listens while the Companion is the focused window, so a back button bound in game stays the game\'s.',
        fromReport: true
      }
    ]
  },
  {
    version: '0.19.0',
    date: '2026-08-10',
    entries: [
      {
        kind: 'fixed',
        text: 'With the cursor ring off, the app never touches your cursor - cursor tools like YoloMouse get the pointer to themselves, and toggling the ring takes effect immediately.',
        fromReport: true
      },
      {
        kind: 'new',
        text: 'All 780 item icons and boss portraits now ship inside the app - instant on a fresh install, there with the internet off. They come from two volunteer-run wikis, credited and linked on the new Thanks page in Preferences.'
      },
      {
        kind: 'new',
        text: 'A floating XP overlay: experience per hour, time to level (AA pace at max), and motes per hour by tier, with the Leveling tab\'s own time-slice picker and a checkbox per row. Turn it on from the Overlay menu.',
        fromReport: true
      },
      {
        kind: 'changed',
        text: 'A creature page counts an item once across its +N upgrades - one line with the real total and your observed rate, like "1 per 14 kills" - and expands to each variant on click.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'The Plane of Sky list keeps your place - starring, favoriting, or a drop landing no longer collapses it - and a remembered "Show all" button loads everything in one click.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'An overlay never goes missing with the monitor it was on: windows always land on a screen that exists, and your saved spot is restored when the monitor comes back.',
        fromReport: true
      },
      {
        kind: 'changed',
        text: 'Finding your EverQuest folder no longer launches Windows command-line tools - the app asks Windows directly, about twenty times faster, and looks far less like malware to antivirus. The installer dropped its most suspicious-looking trick too.'
      },
      {
        kind: 'fixed',
        text: 'The "Add an alert" suggestion rows stop printing on top of themselves - crowded rows wrap to a second line instead.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'A pet-only buff like Burnout now marks the pet as yours the moment it lands - so an upgraded pet shows in the meter without being ordered first.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'Items in the Dragon\'s Hoard and other storage tabs now count - the app reads every table the inventory dump contains. Worn gear still comes from your equipment alone.',
        fromReport: true
      },
      {
        kind: 'new',
        text: 'The /outputfile line gained a How: which windows to open (Bank, Dragon\'s Hoard, Tradeskill Depot) before typing it so the dump is complete - and a note that currency-tab items never dump at all.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'Spirit of the Puma and 86 other spells whose wiki durations are written like "60s" or "6:00:00" get their timer bars - those spellings read correctly now. Sicken corrects from 1:00 to its real 1:24.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'All four Tuyen\'s chants get their own bars - a disease landing no longer draws as a resisted frost.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'Dooming Darkness, Cascading Darkness and Sha\'s Lethargy turn up on the debuff window - three more landing lines the wiki words differently than the game, corrected.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'The app no longer starts a hidden PowerShell to watch for EverQuest - it asks Windows directly. Antivirus stops objecting, and overlay auto-hide now works on machines where the old helper could never start.'
      },
      {
        kind: 'fixed',
        text: 'No fault may report itself more than a hundred times a session - after that it says so once and goes quiet. The install that reported one problem seven million times in a day is the reason.'
      },
      {
        kind: 'fixed',
        text: 'The full item card is back when hovering a Plane of Sky item - it opens downward and clicks pass straight through it, so the filter dropdowns keep every click.'
      }
    ]
  },
  {
    version: '0.18.0',
    date: '2026-08-10',
    entries: [
      {
        kind: 'new',
        text: 'Search your alerts by anything you remember - name, spell, trigger, sound, spoken phrase, or note. The box narrows what you see, never what fires.'
      },
      {
        kind: 'fixed',
        text: 'Hovering a Plane of Sky item names the mobs that drop it again, with level and zone - since 0.15.0 the hover had answered with the island alone.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'Forty-four spells the wiki describes with a placeholder subject - Odium, Tangling Weeds, the ward and blessing lines, the healing echoes - now open timer bars when they land.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'A mez that outlives its estimate still teaches the timer: late wear-offs are learned instead of thrown away, and broken mezzes can no longer drag the learned duration below the truth.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'A boss pull starts when you pull the boss - a mez hold ends when its mob dies or leaves, and is never claimed by your own charmed pet.'
      }
    ]
  },
  {
    version: '0.17.0',
    date: '2026-08-09',
    entries: [
      {
        kind: 'fixed',
        text: 'Base difficulty is a real clear now. Killing a boss in a base instance greens its D0 rung like any other difficulty, and killing one out in the open world - where there is no lockout to take - greens nothing and no longer reads as a D0 you already spent.'
      },
      {
        kind: 'changed',
        text: 'The raid card ends in its ladder: the Locked line under it is gone, resting on a green rung tells you the day that clear landed, and the corner chip says the tier and nothing else.'
      },
      {
        kind: 'fixed',
        text: 'The raid-kill celebration card names the kill you just made: the difficulty of the instance that boss died in, and which instance it was, instead of the highest difficulty you have ever beaten it at and the zone off the roster. Clear a boss at d1 on Sunday and the card says d1, however many times you beat it at d4. The boss cards still badge your best.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'Drilled into your own damage, the total above the bars answers the pet setting the moment you change it. Fold your pet into your damage and the line covers you both; move it out and the line is yours alone. It used to keep the combined number until you picked another fight, so the figure at the top described one thing while the rows under it described another.'
      },
      {
        kind: 'fixed',
        text: 'Monk strikes get a bar of their own instead of disappearing into Melee. Tiger Claw, Eagle Strike, Dragon Punch and Tail Rake all land as a plain strike, and the game names the one you use only once, at the level-up - so a log that started after that line lumped every strike in with your weapon swings forever. They now read Strike on their own row, and still carry the real ability name whenever your log did catch that line.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'A spell you cast and a weapon proc that fires the same effect stop sharing one row. Your casts keep the spell name; the firings that arrive with no casting line of yours get their own row, marked proc - so a cleric whose weapon procs Banish Undead can read the proc rate straight off the meter instead of putting the spell away for a fight to measure it. Casting the same spell over and over no longer hides every proc behind it either, and a cast that fizzled or was interrupted for good stops claiming the next proc as its own.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'Two bard songs the wiki words wrongly now answer to what the game actually prints: Sionachie\'s Dreams lands on your timers and offers its alerts, and the level-39 charm-song page the wiki calls Solon\'s Bravura is known by the name your log sings, Solon\'s Bewitching Bravura. Both hold like the mez they are - and a new per-song mez-break alert can name exactly which song just shattered.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'Searching the Loot page now finds items you own but never looted - anything your inventory export knows about turns up by name, spelled the way the game spells it, and its page states how many you hold beside how many times you looted it. The Loot page and the Plane of Sky view can no longer disagree about whether you have an item.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'Restart the app with a buff or debuff overlay open and it comes back holding what is actually running. A long hold that survived the restart - a charm, an Ensnare, anything still ticking - used to appear in the app and never in the floating window, which sat on whatever it happened to catch while the log was still being read. Both windows now refill the moment that read finishes, and no spell is announced as dropped just because the window asked again.'
      },
      {
        kind: 'fixed',
        text: 'Overlay auto-hide and the cursor ring keep working for a whole session on machines where they used to go quietly dead a second after launch. The little watcher behind them asked Windows a process question that some machines - ones with damaged performance counters, or security software that blocks process listings - answer wrongly for programs that are plainly running, and it read that wrong answer as its cue to shut down. It now asks the system directly, so the overlays hide when you leave the game and the ring only ever draws over it.'
      },
      {
        kind: 'fixed',
        text: 'Forty-seven community sound packs are back in the browser. The safety check on pack sources was stricter than the real world: one longtime creator\'s account name and two packs\' plain spelling of their folder were being refused as unsafe, so their packs silently never appeared. The check now accepts what actually exists while refusing everything it was built to refuse.'
      }
    ]
  },
  {
    version: '0.16.0',
    date: '2026-08-09',
    entries: [
      {
        kind: 'new',
        text: 'A Classes tab on the Plane of Sky view tracks every class unlock: your Sky turn-ins count toward each class, the closest to done sit on top, stars pin the ones you are chasing, and a class the log declared unlocked says so - the achievement line outranks any tally. Click a class to jump to its quests, filtered to just that class.'
      },
      {
        kind: 'new',
        text: 'Every raid boss on the This week view carries its difficulty ladder: a rung turns green when your credited kill this reset week proves that clear, the base rung outlines instead of filling when the log cannot name it, and the Bosses view remembers which tab you left it on.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'Thirty-five spell messages the game words differently than the wiki are corrected - Drifting Death and the swarm family, root, stuns, runes and more now land and wear off on your timers exactly as the game prints them.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'Allure finally opens its charm countdown - the wiki carried no landing text for it at all, so an enchanter charm never started a clock. Charm breaks were always seen; now the whole hold is.'
      },
      {
        kind: 'fixed',
        text: 'The Leveling page stops piling its panels on top of each other in narrower windows - the bands stack and scroll instead, and nothing covers anything.',
        fromReport: true
      },
      {
        kind: 'changed',
        text: 'The Ready tab starts on first-time turn-ins: quests you have never handed in before, with a box to bring your refarms back into the list.'
      },
      {
        kind: 'fixed',
        text: 'The cursor ring stays centered on your pointer at every text size - the app window zoom no longer leans on the ring.'
      },
      {
        kind: 'fixed',
        text: 'A mob that dies takes its debuff bars with it no matter who landed the kill - your charm pet, a damage-over-time, or another player - even when the killer and the killed share a name.'
      },
      {
        kind: 'fixed',
        text: 'A debuff whose end you never saw - you died, you zoned, the fight dissolved - leaves within a minute of running out instead of squatting at 0s for its whole stated duration again.'
      },
      {
        kind: 'changed',
        text: 'The meter overlays put the total where the numbers live: the all figure sits on the You row inside the panel, and the title bar spends its room on the fight name - ten more characters of mob before anything truncates.'
      }
    ]
  },
  {
    version: '0.15.0',
    date: '2026-08-09',
    entries: [
      {
        kind: 'new',
        text: 'Text too small to read? Preferences - Text size scales the whole app window, from 90% up to 150%, and it stays that way the next time you open it. Your floating overlays keep their own size control.',
        fromReport: true
      },
      {
        kind: 'new',
        text: 'The cursor ring can be any color you want. Preferences - Cursor ring has a color picker beside the size and thickness sliders, and the ring changes as you pick. It starts white, exactly as it was.',
        fromReport: true
      },
      {
        kind: 'new',
        text: 'The Plane of Sky tab filters by island and by boss, right beside the class filter - pick Island 7 and see only what is left to do there. Your picks stick around like the other filters.',
        fromReport: true
      },
      {
        kind: 'new',
        text: 'Loot and leveling can answer for a slice of time, not just all of it: pick Session, Zone, Zone + Session or a custom range and the tables, rates and drop panels all agree on the answer. All time stays the default.',
        fromReport: true
      },
      {
        kind: 'new',
        text: 'Sky quests can be farmed again: handing one in spends the items and the quest starts counting from zero, with a badge remembering how many times you have turned it in. The hide box now reads Hide quests I have every item for, which is what it always meant to say.',
        fromReport: true
      },
      {
        kind: 'new',
        text: 'A second Sky hide box, Hide quests I have turned in, tucks away everything you consider done - independent of the every-item box, so once-and-done farmers and refarmers each get their view.'
      },
      {
        kind: 'fixed',
        text: 'Most recently looted on the Sky tab means exactly that now: a starred quest no longer squats above the loot you just made. Stars still pin every other sort order.'
      },
      {
        kind: 'new',
        text: 'A Ready tab on the Sky view lists every quest you can turn in right now - it fills as last items land, empties as you hand them in, and ignores the hide boxes so your walk-the-islands list is always the whole list.'
      },
      {
        kind: 'new',
        text: 'Map search now answers from every zone, mobs included: look for a name anywhere, the result says which zone it means, and picking it takes you to that map - to the exact spot when the wiki states one.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'The add-alert editor keeps your work when you switch away from the app and back - the name, trigger, cooldown and spoken phrase all survive, and an alert you were editing no longer snaps back to how it was saved.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'The Loot page sort control can always be clicked - the item cards that used to open over the toolbar are gone, and the page carries far fewer hover cards overall.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'Pinned overlays scroll again: the wheel and the scrollbar both work along the right edge of a pinned meter, while clicks everywhere else still pass through to the game.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'Cazic-Thule and Innoruuk keep their loot: the gods the log spells differently than the wiki now land on one page, with your drops and the wiki table together no matter how you got there.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'Mez, charm and slow timers learn your real durations: cast, let it run, and the bar uses what your log measured instead of a book number - upgraded ranks included, and each row now names the rank you cast. Charm itself finally has a countdown.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'The overlays stopped guessing: a friendly spell on a groupmate or your pet never lands on the debuffs window, phantom buffs no longer appear on pets from spells someone else cast, and a bar that expired unseen quietly leaves instead of squatting at 0s.',
        fromReport: true
      },
      {
        kind: 'new',
        text: 'The debuffs window puts whatever runs out soonest at the top, in one list across all your targets; a footer button groups by target instead if that is how you read it. Quick Buff casts are tracked too, and a charmed pet shows its buffs and its debuffs each in the right window.'
      },
      {
        kind: 'fixed',
        text: 'Camp out and your buff timers wait with you: the countdowns pick up where they left off when you log back in, instead of expiring while you were gone. Debuffs you landed keep burning down in world time, because the world does not log out with you.'
      }
    ]
  },
  {
    version: '0.14.0',
    date: '2026-08-08',
    entries: [
      {
        kind: 'new',
        text: 'Two new overlays track buffs and debuffs with live timers - one window for what is on you, one for what you have landed on your targets, each enabled and placed separately. Both start off; turn them on from the Overlay menu.',
        fromReport: true
      },
      {
        kind: 'new',
        text: 'Chain-mez or slow across a whole pull and each target shows its own named countdown; when a spell breaks, wears off, or the mob dies, its bar goes with it. Only your own casts are tracked, and a resist shows nothing.',
        fromReport: true
      },
      {
        kind: 'new',
        text: 'The countdowns learn from your log: the app uses the durations your casts actually run - your AAs and focus effects included - and never invents a number it has not seen or the spell data does not state.'
      },
      {
        kind: 'new',
        text: "Alerts can speak what the log said: name a capture in your pattern and use it in the spoken text - 'Puma on {player}' says who it landed on. Spirit of the Puma is back in the suggested list too.",
        fromReport: true
      },
      {
        kind: 'changed',
        text: 'The combat meters are one surface now: Overview, the Combat tab and the overlay share the same clickable bars, and clicking an ability that has stats (crit, double and triple attack, misses) opens them right under its bar.'
      },
      {
        kind: 'changed',
        text: 'The You / Group / Everyone choice moved to Preferences - Combat (default: Group), the meters remember where you drilled when you switch tabs, and the scope word sits as a quiet watermark at the bottom of each overlay instead of crowding the title bar.'
      },
      {
        kind: 'changed',
        text: 'Turning usage analytics off now sends one final anonymous notice so opt-outs can be counted honestly; nothing further is ever sent after it.'
      },
      {
        kind: 'fixed',
        text: 'Playing through Wine on Linux: the app now recognises it at startup and draws the compatible way on its own, so windows stop coming up blank and a celebration card stops sticking to the screen as a black box. Preferences - Graphics says so when it happens, and either half can be turned back off.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'Security: the sound-pack installer is hardened against a path traversal in pack names and registry source fields, and malformed registry entries are dropped on fetch and on cache read. Reported by an outside review; no user data was ever at risk in normal use.'
      },
      {
        kind: 'fixed',
        text: 'A raid boss finished by a damage-over-time now counts as your kill, and Phinigel Autropos joined the raid targets.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: "Iksar monks' Tail Rake shows up in the combat breakdown, in Dragon Punch's seat.",
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'The exaltation planner has the two Any slots, filled from your inventory dump, and a planned exaltation shows what it does on hover.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'Finding your EverQuest install no longer re-scans every launch: the found path is remembered, and a slow or offline network drive can no longer stall startup.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'The cursor ring no longer twitches on clicks.'
      }
    ]
  },
  {
    version: '0.13.0',
    date: '2026-08-08',
    entries: [
      {
        kind: 'new',
        text: "The map you pick stays picked - it survives switching tabs and restarting, and the toolbar says whether the map is following you or pinned. 'Current zone' snaps back to where your character is and follows from there.",
        fromReport: true
      },
      {
        kind: 'new',
        text: 'Paste a /loc into the Maps toolbar and a crosshair lands on that spot. It stays - per zone, across tabs and restarts - until you replace it or clear it.',
        fromReport: true
      },
      {
        kind: 'changed',
        text: 'When something breaks, the app now reports the technical details of the failure - the error, where in the app it happened, and what kinds of log line it had just read - so bugs get diagnosed instead of guessed at. Never your log contents, your chat, or any name from the game: the message is redacted on your machine and checked again on arrival. The usage-analytics switch still turns all of it off.'
      }
    ]
  },
  {
    version: '0.12.0',
    date: '2026-08-08',
    entries: [
      {
        kind: 'changed',
        text: 'Anonymous usage reporting (if you have it on) now includes error counts - how many errors happened, never what they said - so a buggy release gets noticed and fixed faster.'
      }
    ]
  },
  {
    version: '0.11.1',
    date: '2026-08-07',
    entries: [
      {
        kind: 'fixed',
        text: "The combat log no longer jumps to the bottom while you're reading: scroll up and your place holds; scroll back to the bottom and it follows new lines again.",
        fromReport: true
      }
    ]
  },
  {
    version: '0.11.0',
    date: '2026-08-07',
    entries: [
      {
        kind: 'new',
        text: 'Set your loadout classes yourself when autodetection guesses wrong: the Profiles panel shows which classes are in effect and where that answer came from, and one click hands it back to auto.',
        fromReport: true
      },
      {
        kind: 'new',
        text: 'Bow damage gets its own Ranged bar beside Melee, so a stance-switching ranger can compare bow and dual-wield numbers within a fight.',
        fromReport: true
      },
      {
        kind: 'new',
        text: 'The Loot window can sort by last looted.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: "Pointing the app at your logs works wherever they are: you can pick the log file itself, the folder card names the exact folder logs are read from, and a folder the app can't read says so instead of claiming you have no logs.",
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'Alerts created from Suggested actually fire - a landing message shared by several spells now matches whichever of them you cast, and the alert speaks the right spell name.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: "Bard crowd-control breaks are detected across the whole song ladder, not just the level-20 song - and a mez break is announced as a mez break, not a charm break.",
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'Group members show up in the meters even when your group formed before the app was running: your own group buff landing on them is believed, once the log has shown party experience.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: "Dying to a damage-over-time now counts as dying: buffs clear and the death alert fires even when the log names no killer.",
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'Monk Mend appears in the healing breakdown - counted every time, and tagged "no amount" because the game never says how much it healed.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'The celebration overlay introduces itself the first time it appears - named, with a close button, and a way to turn it off right on the card.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: "The Sky tab's Hide completed choice sticks across tab switches and restarts.",
        fromReport: true
      }
    ]
  },
  {
    version: '0.10.0',
    date: '2026-08-07',
    entries: [
      {
        kind: 'new',
        text: "Every item's detail now shows where it drops for you: each zone with your observed drops, your drops per hour of active time there, and how long you actually farmed.",
        fromReport: true
      },
      {
        kind: 'new',
        text: 'The leveling tab highlights what has been dropping in your selected time window - motes and farm targets float to the top - and clicking an item jumps to its detail.',
        fromReport: true
      },
      {
        kind: 'new',
        text: 'Comparing farming spots used to mean notes and guesswork; now Befallen versus Plane of Hate is two clicks.'
      },
      {
        kind: 'fixed',
        text: 'Cleave has its own row in the damage breakdown instead of hiding inside Melee.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'Smite has its own row too - the skill swings split out from the Smiting Strike spell.'
      },
      {
        kind: 'fixed',
        text: 'Loadout detection believes the swap you are playing: wizard casts under a haste focus were invisible, and a new swap could hide behind an older one. Your current classes now show within the half hour.'
      }
    ]
  },
  {
    version: '0.9.0',
    date: '2026-08-07',
    entries: [
      {
        kind: 'new',
        text: 'Raid targets: a "This week" view lists the lockouts you are holding right now, one row per difficulty.'
      },
      {
        kind: 'new',
        text: 'Lockouts are per difficulty and they all reset on Tuesday, which is easy to lose track of when one target has four tiers you killed on different nights.'
      },
      {
        kind: 'new',
        text: 'Each row names the kill that locked it and counts down to the reset, so what is still worth going after is a glance rather than an argument.'
      },
      {
        kind: 'new',
        text: 'My sounds: import your own audio files from the alerts toolbar and use them for any alert.',
        fromReport: true
      },
      {
        kind: 'new',
        text: 'The exp graph has a timescale picker - and the whole leveling dashboard follows it: rates, AA pace and zone stats all read the window you chose.'
      },
      {
        kind: 'new',
        text: "What's new: this panel - every release, newest first, with a strip along the bottom the first time you launch after an update."
      },
      {
        kind: 'new',
        text: 'The app updates itself quietly in the background, so releases were arriving with nothing to say they had - no way to know what was different, or that a fix was there because somebody asked for it.'
      },
      {
        kind: 'new',
        text: 'Everything that landed since the version you were last on is marked new, and the changes that came from a player report are tagged as such.'
      },
      {
        kind: 'fixed',
        text: 'A kill or gain landing at the exact edge of a selected range was drawn on the chart but missing from the totals.'
      }
    ]
  },
  {
    version: '0.8.0',
    date: '2026-08-07',
    entries: [
      {
        kind: 'new',
        text: 'Suggested alerts for slows wearing off, mote drops, and receiving tells.',
        fromReport: true
      },
      {
        kind: 'new',
        text: 'The exaltation planner has ear, wrist and finger slots - plan two ring effects at once.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'Maps render north correctly (north and south were mirrored).',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'Plane of Sky items on your Equipment keyring now count as owned.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'Items whose wiki pages hide their slot (like the Golem Metal Wand) can donate their effects, and an empty planner result now says which filters are hiding rows.',
        fromReport: true
      },
      { text: 'The log engine is faster again.' }
    ]
  },
  {
    version: '0.7.0',
    date: '2026-08-07',
    entries: [
      {
        kind: 'changed',
        text: 'The meter no longer asks “your pet?” - order your pet once (/pet attack) or use /pet who leader and it is yours from that moment; re-summoning retires the old pet.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'Raid mobs that lifetap are never misfiled as players, so your pet’s damage against them counts.',
        fromReport: true
      },
      {
        kind: 'fixed',
        text: 'Loading no longer pegs a CPU core, and the overlays and cursor ring stay out of the way (and off your mouse) until parsing finishes.'
      },
      { kind: 'fixed', text: 'Switching characters no longer replays old alerts and celebrations.' },
      {
        kind: 'fixed',
        text: 'The game-folder setting works pointed at the install folder, the Logs folder, or a log file.',
        fromReport: true
      },
      {
        kind: 'changed',
        text: 'The exaltation teaching card opens from the ? button instead of appearing on its own.'
      }
    ]
  },
  {
    version: '0.6.3',
    date: '2026-08-06',
    entries: [
      { text: 'The planner tab is called Exaltations.' },
      { text: 'Back returns you where you came from, from every drill in the app.' },
      { text: 'Every /outputfile export says which command to type and how old your last one is.' },
      {
        text: 'Two graphics switches for a card that dislikes the overlays: software rendering, and solid instead of transparent overlays.',
        fromReport: true
      }
    ]
  },
  {
    version: '0.6.2',
    date: '2026-08-05',
    entries: [
      { text: 'Your group appears in the meters, with a scope you choose.' },
      { text: 'Overlay text can be sized, and every overlay follows the same setting.' },
      { text: 'The Maps sidebar becomes one search box over mobs, labels and zones.' },
      { text: 'The planner gains a card that teaches exaltation, and fills its Inventory tab from your own dump.' }
    ]
  },
  {
    version: '0.6.1',
    date: '2026-08-05',
    entries: [
      {
        text: 'Closing the app really closes it - a failed teardown could leave it running with no window, and block the next launch.',
        fromReport: true
      }
    ]
  },
  {
    version: '0.6.0',
    date: '2026-08-05',
    entries: [
      { text: 'Attack-round stats, honest about what the log states and what it infers.' },
      {
        text: 'Picking your EverQuest folder attaches right away - and so does typing /log on, without a restart.',
        fromReport: true
      },
      { text: 'The installer runs under Wine and CrossOver instead of dead-ending.', fromReport: true }
    ]
  },
  {
    version: '0.5.0',
    date: '2026-08-05',
    entries: [
      {
        text: 'Monk special attacks get their real names - Dragon Punch and Flying Kick stop being counted as anonymous swings.',
        fromReport: true
      },
      { text: 'Your /outputfile dumps are read the moment you write them.' },
      { text: 'AA purchases read as ladders per ability instead of a flat list of lines.' }
    ]
  },
  {
    version: '0.4.0',
    date: '2026-08-05',
    entries: [
      { text: 'The exaltation planner arrives: plan sets over a class-filtered effect browser.' },
      {
        text: 'Working out which exaltation combinations are even legal, and then what the donor items would cost you to farm, was a job for a spreadsheet and a lot of wiki tabs.'
      },
      {
        text: 'Pick your classes, browse every effect you could transfer, fill a socket, and see which zones drop the pieces you are still missing.'
      },
      { text: 'Celebration cards appear over EverQuest when a raid target dies or a Sky quest completes.' },
      {
        text: 'Those moments are the payoff for a long night, and the app used to note them quietly in a list you would find later.'
      },
      {
        text: 'A card names what you just did, fades on its own, and takes you to the tab with the details if you click it.'
      },
      { text: 'Healing joins the meters, in the panel and in a floating overlay of its own.' },
      { text: 'Only kills credited to you celebrate - a boss a stranger killed nearby no longer does.' }
    ]
  },
  {
    version: '0.3.5',
    date: '2026-08-04',
    entries: [
      { text: 'Maps gain a zone pane that says what lives there, pinned where the wiki says.' },
      { text: 'Overview tiles link where you would click - a drop opens its item, a fight opens the meter.' },
      { text: 'Kill records go per instance tier, so a d4 badge no longer stands under a d0 loadout.' }
    ]
  },
  {
    version: '0.3.4',
    date: '2026-08-04',
    entries: [{ text: 'A stranger’s charmed pet no longer turns up in your damage meter.' }]
  },
  {
    version: '0.3.2',
    date: '2026-08-04',
    entries: [{ text: 'The app’s source code is public, under FSL-1.1-MIT.' }]
  },
  {
    version: '0.3.1',
    date: '2026-08-04',
    entries: [
      { text: 'Reading your log history no longer blocks the app while it loads.' },
      { text: 'The pet setting stops folding your pet permanently into your own row.' }
    ]
  },
  {
    version: '0.3.0',
    date: '2026-08-04',
    entries: [
      { text: 'Alerts learn to speak, in a system voice or a downloadable natural one.' },
      { text: 'A cursor ring finds your mouse over the EverQuest window.' },
      { text: 'Poison and slow alerts arrive, and the suggestion dialog becomes one search.' },
      { text: 'You can send feedback, with a scrubbed log window attached, from inside the app.' },
      {
        text: 'When something looked wrong there was nowhere to say so, and a problem nobody can see is a problem nobody fixes.'
      },
      {
        text: 'The attached window carries combat, casts and loot - never chat, and never anyone else’s words - so a defect can be diagnosed from what actually happened instead of from a description of it.'
      }
    ]
  },
  {
    version: '0.2.1',
    date: '2026-08-03',
    entries: [{ text: 'Copy on the combat meter puts the numbers on your clipboard again.' }]
  },
  {
    version: '0.2.0',
    date: '2026-08-03',
    entries: [
      { text: 'The first stable release.' },
      { text: 'An Overview landing tab: live DPS, current mob, zone, leveling pace and recent drops.' },
      { text: 'A Maps tab with zone search, label declutter and floor slicing.' },
      { text: 'Proc analytics, class-loadout inference, and leveling stats over a range you drag out.' }
    ]
  }
]

// ---------------------------------------------------------------- versions

interface ParsedVersion {
  readonly major: number
  readonly minor: number
  readonly patch: number
  /** The `-rc.1` half of a prerelease tag, or '' for a plain release. */
  readonly pre: string
}

/**
 * `v0.8.0` / `0.8.0` / `0.8.0-main.3` → its parts. Anything unparseable reads as 0.0.0, which
 * sorts below every real release — the safe direction: an unreadable stored value makes
 * everything look new rather than silently hiding a release.
 */
export function parseVersion(value: string): ParsedVersion {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(value.trim())
  if (!m) return { major: 0, minor: 0, patch: 0, pre: '' }
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? '' }
}

/**
 * Semver ordering, enough of it: numeric triple first, then semver's own rule that a release
 * outranks its own prereleases (`0.8.0` > `0.8.0-main.3`). The prerelease tail itself is
 * compared as text, which is not the full spec — it is right for the only prerelease shapes this
 * repo has ever tagged (`-main.N`, `-sign.N`) and it is never the deciding factor for anything
 * the user sees, because every entry above is a plain release.
 */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (x.major !== y.major) return x.major < y.major ? -1 : 1
  if (x.minor !== y.minor) return x.minor < y.minor ? -1 : 1
  if (x.patch !== y.patch) return x.patch < y.patch ? -1 : 1
  if (x.pre === y.pre) return 0
  if (x.pre === '') return 1
  if (y.pre === '') return -1
  return x.pre < y.pre ? -1 : 1
}

/** The newest release these notes describe — the value an install is stamped with once it has
 *  been shown them. See the header for why this, and not `app.getVersion()`. */
export function latestReleaseVersion(notes: readonly ReleaseNote[] = RELEASE_NOTES): string {
  return notes[0]?.version ?? '0.0.0'
}

/** Does `version` (a tag name is fine — the leading `v` and any prerelease tail are ignored)
 *  have an entry? The release job's gate; see scripts/check-release-notes.mjs. */
export function hasReleaseNote(
  version: string,
  notes: readonly ReleaseNote[] = RELEASE_NOTES
): boolean {
  const want = parseVersion(version)
  return notes.some((n) => {
    const got = parseVersion(n.version)
    return got.major === want.major && got.minor === want.minor && got.patch === want.patch
  })
}

/** Does this release carry any player-reported entry? — whether it gets a thanks line (JOS-76). */
export function hasReportedEntry(note: ReleaseNote): boolean {
  return note.entries.some((e) => e.fromReport === true)
}

// ---------------------------------------------------------------- the state

/** What the teaser strip and the What's new panel both render from. */
export interface WhatsNewState {
  /** No stored last-seen version: a fresh install, which has no news. */
  readonly fresh: boolean
  /** Every release newer than the stored last-seen version, NEWEST FIRST. Marked "new" in the
   *  panel — all of them, which is the A→D case: 0.6.3 → 0.8.0 marks 0.7.0 and 0.8.0. */
  readonly newVersions: readonly string[]
  /** The one version the teaser strip names, or null for no teaser. The NEWEST — one line
   *  saying where you landed, never a list of everything you missed. */
  readonly teaserVersion: string | null
}

/**
 * The whole derivation, and it is a pure function of two values so it can be unit-tested and
 * driven by hand (the DEV variant control writes the store key and nothing else).
 *
 * `lastSeen` is whatever the store held: a version string, or null/undefined/'' for absent.
 */
export function whatsNewState(
  lastSeen: string | null | undefined,
  notes: readonly ReleaseNote[] = RELEASE_NOTES
): WhatsNewState {
  if (typeof lastSeen !== 'string' || lastSeen.trim() === '') {
    return { fresh: true, newVersions: [], teaserVersion: null }
  }
  const newVersions = notes
    .filter((n) => compareVersions(n.version, lastSeen) > 0)
    .map((n) => n.version)
  return { fresh: false, newVersions, teaserVersion: newVersions[0] ?? null }
}

/**
 * The three states the DEV variant control can put an install into (JOS-73's hand-test brief).
 * Pure and derived from the notes themselves, so the buttons never name a version that has been
 * deleted from the list:
 *
 *   'fresh'    — no stored key at all. No teaser, nothing marked.
 *   'previous' — stamped at the release before the newest. One release of news.
 *   'several'  — stamped several back, which is the A→D case the marking exists for.
 *
 * The fourth variant, "reset to real", is not here: it restores the value this session STARTED
 * with, which is a fact about the running app and not about the data.
 */
export type WhatsNewVariant = 'fresh' | 'previous' | 'several'

/** How far back 'several' reaches. Five releases in, so the marking has to hold a list. */
const SEVERAL_BACK = 4

export function variantLastSeen(
  variant: WhatsNewVariant,
  notes: readonly ReleaseNote[] = RELEASE_NOTES
): string | null {
  if (variant === 'fresh' || notes.length === 0) return null
  const idx = variant === 'previous' ? 1 : SEVERAL_BACK
  return notes[Math.min(idx, notes.length - 1)]?.version ?? null
}

// ---------------------------------------------------------------- validity

const VERSION_RE = /^\d+\.\d+\.\d+$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const KINDS: readonly string[] = ['new', 'fixed', 'changed']

/**
 * Everything wrong with a notes list, as sentences — [] means it is sound.
 *
 * A function rather than a test body because it has TWO callers that must agree: the unit suite
 * (tests/releaseNotes.test.mts) and the release job's gate (scripts/check-release-notes.mjs).
 * A tag that ships is a tag whose notes passed the same check the suite runs.
 */
export function releaseNotesProblems(notes: readonly ReleaseNote[] = RELEASE_NOTES): string[] {
  const problems: string[] = []
  if (notes.length === 0) problems.push('the notes list is empty')
  notes.forEach((n, i) => {
    if (!VERSION_RE.test(n.version)) problems.push(`${n.version}: not a plain MAJOR.MINOR.PATCH version`)
    if (!DATE_RE.test(n.date)) problems.push(`${n.version}: date "${n.date}" is not YYYY-MM-DD`)
    if (n.entries.length === 0) problems.push(`${n.version}: no entries`)
    for (const e of n.entries) {
      if (e.text.trim() === '') problems.push(`${n.version}: an entry has no text`)
      if (e.kind !== undefined && !KINDS.includes(e.kind)) problems.push(`${n.version}: unknown kind "${e.kind}"`)
      // `fromReport: false` is not a third state — an untagged entry is simply absent, and a
      // stored `false` would read as "we checked and it wasn't a report", which is a claim this
      // file has no way to make. Present means true.
      if (e.fromReport !== undefined && !e.fromReport) {
        problems.push(`${n.version}: fromReport is a flag - set it to true or leave it out`)
      }
    }
    const prev = notes[i - 1]
    if (prev && compareVersions(prev.version, n.version) <= 0) {
      problems.push(`${n.version} must sort strictly below ${prev.version} - the list is newest first`)
    }
  })
  return problems
}
