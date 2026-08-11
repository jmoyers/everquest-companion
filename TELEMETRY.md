# What this app measures

<!-- GENERATED FILE — do not edit by hand.
     Rendered from src/shared/telemetry.ts by `npm run gen:telemetry-doc`.
     tests/telemetryDoc.test.mts fails if this file and the schema disagree. -->

EQ Legends Companion can send anonymous usage counts so the person building it can see
which parts are used and which parts break. It is **on by default**, you are asked about
it the first time you run the app, and you can turn it off at any time in
**Preferences → Usage analytics** — where you can also read the exact events waiting to be
sent, as JSON.

**This build does send.** The counts on this page go to one address, run by the person who
builds this app, in an account used for nothing else — the address is compiled in, and
nothing in your settings, in the app, or on disk can point it somewhere else. Nothing is
sent before the notice on your first run has appeared, and turning this off deletes
everything waiting to be sent **and** your anonymous id, straight away. Preferences shows
you the last batch that actually left, in full.

## What can never be collected

Not "what we choose not to collect" — what the schema has no room for:

- your character names, your server, your guild, anyone you play with
- zone, mob, spell, item or quest names
- anything you typed: chat, tells, search boxes, alert names, feedback text
- any line of your log
- any path on your machine — where the app is installed, where your log lives, your
  account name
- your IP address, your machine name, your account — there is no account

Almost every field on this page is a number, or one value from a fixed list printed here,
so there is simply nowhere for any of that to go.

**One event is different, and it is worth reading about.** `errorReport` sends the
technical details of a failure: what kind of error it was, a **redacted** version of its
message, and where in the app’s own program files it happened. It exists because an error
report nobody can act on is not worth sending. The redaction runs on your machine **and**
again on arrival — every file path, everything in quotes and every long number in the
message is replaced first, and a message that arrives unredacted is thrown away rather than
cleaned up. The file names it sends are the app’s own (they always begin `out/`), never a
location on your disk. Nothing about your game reaches it: the only thing it says about
your log is what KINDS of line the app had just read, from the fixed list of kinds.

## What identifies a send

One random id (`analyticsId`), generated on your machine, stored in your settings file, and
deliberately **different from** the id a feedback report uses — the two cannot be joined.
You can replace it at any time from Preferences; doing so also throws away everything
waiting to be sent, and the new id looks like a brand-new install.

| Field | Values |
| --- | --- |
| `analyticsId` | a random UUID, replaceable from Preferences |
| `appVersion` | the app version, e.g. `0.2.0` |
| `channel` | `prod` · `dev` |
| `platform` | `win32` · `darwin` · `linux` · `other` |
| `tzOffsetBucket` | your UTC offset in whole hours (-12 to 14) |

Events are held on your machine (at most 500 of them, oldest dropped first) and would
be sent in batches, not one by one. Schema version: 1.

## Events

### `sessionStart`

Once, when the app finishes starting up.

| Field | Values | What it means |
| --- | --- | --- |
| `coldStartMsBucket` | bucket index | How long the app took to become usable. |

### `sessionHeartbeat`

Every 5 minutes while the app is open — the "is anyone using it right now" signal. Present on the first of these that follows startup, once per launch: how long reading your log history took, and how smoothly. Reading a log after switching character is deliberately not measured.

| Field | Values | What it means |
| --- | --- | --- |
| `uptimeMs` | whole number | How long this session has been running. |
| `linesParsed` | whole number (optional) | How many log lines were read since the last one of these. A count of lines only — no line, and no part of one, is ever sent. Starting the app re-reads your log history, so those lines are counted again each launch. |
| `startup.replayMs` | whole number (optional) | How long the app took to read your log history when it started. |
| `startup.eventsReplayed` | whole number | How many log lines that was. A count only — no line, and no part of one, is sent. |
| `startup.dutyPct` | whole number | What share of that time was spent working rather than deliberately pausing, 0–100. |
| `startup.maxBlockMs` | whole number | The longest single moment the app was unresponsive while reading. |
| `startup.blocksOver50` | whole number | How many of those moments were longer than 50 ms. |
| `startup.logSizeBucket` | bucket index | How big the log it read is — a RANGE (see below), never the size itself. |

### `sessionEnd`

Once, when the app closes. Present on the first of these that follows startup, once per launch: how long reading your log history took, and how smoothly. Reading a log after switching character is deliberately not measured.

| Field | Values | What it means |
| --- | --- | --- |
| `durationMs` | whole number | How long the session lasted. |
| `viewsVisited` | whole number | How many different tabs were opened. |
| `linesParsed` | whole number (optional) | How many log lines were read since the last one of these. A count of lines only — no line, and no part of one, is ever sent. Starting the app re-reads your log history, so those lines are counted again each launch. |
| `startup.replayMs` | whole number (optional) | How long the app took to read your log history when it started. |
| `startup.eventsReplayed` | whole number | How many log lines that was. A count only — no line, and no part of one, is sent. |
| `startup.dutyPct` | whole number | What share of that time was spent working rather than deliberately pausing, 0–100. |
| `startup.maxBlockMs` | whole number | The longest single moment the app was unresponsive while reading. |
| `startup.blocksOver50` | whole number | How many of those moments were longer than 50 ms. |
| `startup.logSizeBucket` | bucket index | How big the log it read is — a RANGE (see below), never the size itself. |

### `viewDwell`

When you switch away from a tab.

| Field | Values | What it means |
| --- | --- | --- |
| `view` | `overview` · `combat` · `mobs` · `maps` · `bosses` · `posky` · `alerts` · `leveling` · `loot` · `planner` · `buffs` · `timers` · `preferences` · `triage` | Which tab. A fixed list of tab names. |
| `ms` | whole number | How long it was on screen. |

### `overlayToggle`

When you open or close a floating meter.

| Field | Values | What it means |
| --- | --- | --- |
| `kind` | `fight` · `overall` · `heal-fight` · `heal-overall` · `events` · `toast` · `buffs` · `debuffs` · `xp` · `respawn` | Which overlay. |
| `open` | true / false | Opened or closed. |

### `featureUse`

When you use one of the listed features.

| Field | Values | What it means |
| --- | --- | --- |
| `feature` | `mapOpen` · `mapSearch` · `rangeSelect` · `comboCorrection` · `feedbackOpen` · `alertGroupAdd` · `drillPet` · `copyView` · `speechPreview` · `procAnalyticsOpen` · `questFavorite` · `lootFilter` · `profileSwitch` | Which one. A fixed list. |
| `count` | whole number | How many times, since the last batch. |

### `alertFired`

A rollup of how many alerts fired — never which alert, and never its text.

| Field | Values | What it means |
| --- | --- | --- |
| `count` | whole number | Alerts fired. |
| `spokenCount` | whole number | How many of those were spoken aloud. |

### `setupSnapshot`

Once per session: what a typical install looks like.

| Field | Values | What it means |
| --- | --- | --- |
| `charCountBucket` | bucket index | How many character logs the app can see. |
| `logSizeBucket` | bucket index | How big the log it reads is. |
| `alertCountBucket` | bucket index | How many alerts you keep. |
| `overlaysEnabled` | list of `fight` · `overall` · `heal-fight` · `heal-overall` · `events` · `toast` · `buffs` · `debuffs` · `xp` · `respawn` | Which floating meters are open. |
| `cursorRing` | true / false | Is the cursor ring on. |
| `autoHide` | true / false | Is overlay auto-hide on. |
| `voiceEngine` | `system` · `kokoro` · `off` | Which speech tier your spoken alerts use — off when no alert is set to speak. |
| `soundPackCount` | whole number | How many sound packs are installed. |
| `updateChannel` | `main` · `stable` | Update channel. |

### `funnelStep`

When you reach a step of one of the three flows listed below.

| Field | Values | What it means |
| --- | --- | --- |
| `funnel` | `first-run` · `voice-install` · `feedback` | Which flow. |
| `step` | a step of that flow (below) | Which step it reached. |
| `outcome` | `ok` · `failed` · `queued` (optional) | How it ended. |
| `failureClass` | `network` · `checksum` · `disk` · `timeout` · `other` (optional) | A coarse category when it failed. Never an error message. |

### `healthCounters`

With each session report (every few minutes, and at close): counts of things that went wrong since the last one. Sent even when they are all zero. Counts only, never messages.

| Field | Values | What it means |
| --- | --- | --- |
| `rendererCrashes` | whole number | Window crashes. The main window only. |
| `mainErrorLogLines` | whole number | Lines written to the local error log. Errors only — warnings are not counted. |
| `parserStalls` | whole number | Times log reading stalled. Not currently measured — always 0. |
| `presenceRestarts` | whole number | Times the game-window watcher restarted. |
| `speechFailures` | whole number | Times an utterance failed to speak. Downloaded voices only. |
| `imageFetchFailures` | whole number (optional) | Times an item icon or portrait could not be downloaded, usually because the wiki was unreachable. The picture is hidden and the app carries on. Never which picture. |
| `suppressedErrorLines` | whole number (optional) | The same error line repeating: after the first few, further copies are counted here instead of being written to the local error log again. A count only. |

### `updateOutcome`

When an app update is checked for, downloaded, or applied.

| Field | Values | What it means |
| --- | --- | --- |
| `step` | `check` · `download` · `apply` | Which step. |
| `ok` | true / false | Did it succeed. |
| `failureClass` | `network` · `checksum` · `disk` · `timeout` · `other` (optional) | A coarse category when it failed. |

### `errorReport`

When the app hits an error: the technical details of the failure, so it can be fixed. Never your log contents, never your chat, and never a name from the game. The same error happening again in one session adds to a count instead of sending a second copy.

| Field | Values | What it means |
| --- | --- | --- |
| `errorName` | e.g. `TypeError` | What kind of error it was. |
| `code` | e.g. `ENOENT` (optional) | The short machine-readable code, when the error has one. |
| `redactedMessage` | redacted text, at most 200 characters | The error message with the revealing parts replaced before it is stored: any file path becomes `<path>`, anything in quotes becomes `<str>`, and any long number becomes `<n>`. The replacement runs on your machine AND again on arrival, and a message that is not already redacted is thrown away rather than cleaned up. |
| `frames` | at most 10 × (file, line, column, function) | Where in the app it happened. Files are named relative to the app’s own program files (they always begin `out/`) — the folder the app is installed in, and therefore your account name, is cut off before the value exists. |
| `frameOrigin` | `thrown` · `capture` | Whether the places listed above are where the error was thrown, or where the app noticed it. Some failures arrive with no trace of their own, and the app records its own position instead so two different failures do not look like one. |
| `externalFrames` | at most 5 × (module, line, column, function) | The same thing for code that is not ours: the name of the Node built-in, the Electron script, or the open-source package involved — `node:fs`, `node_modules/chokidar`. The name only, cut at the package: the folder it is installed in never survives. |
| `componentPath` | at most 8 names joined with > | For an error in the app’s own interface, which of the app’s screen components it came through — the names in this app’s source code, and nothing from the game. |
| `fingerprint` | 16 hex characters | A hash used to group identical errors together. |
| `breadcrumbs` | at most 10 × (kind, offset) | What KINDS of log line the app had just read — `damage`, `loot`, `zone` and so on, from a fixed list — and how long before the error each was. The kind only: not the line, not who or what was in it. |
| `view` | `overview` · `combat` · `mobs` · `maps` · `bosses` · `posky` · `alerts` · `leveling` · `loot` · `planner` · `buffs` · `timers` · `preferences` · `triage` · `unknown` | Which tab was open. A fixed list. |
| `sessionAgeBucket` | bucket index | How long the app had been running. |
| `mode` | `live` · `replay` | Was it reading your log history, or following it live. |
| `count` | whole number | How many times this same error happened since the last report. It stops at a hundred per error per run of the app: something that goes wrong over and over reports itself a hundred times and then goes quiet, so one repeating fault cannot bury everything else. |

### `optOut`

Once, when you turn usage analytics off. It is the last thing this app ever sends, and it exists so opt-outs can be counted rather than guessed at. Everything else waiting to be sent is thrown away rather than sent with it, it is never retried if you are offline, and nothing further is ever sent.

**This event has no fields at all.** It says only that it happened, alongside the
five facts every send carries (above).

### `optIn`

Once, when you turn usage analytics back on. The counterpart to the notice above, under the new random id. It carries nothing either.

**This event has no fields at all.** It says only that it happened, alongside the
five facts every send carries (above).

## Flows

A `funnelStep` event says which step of one of these you reached — nothing else.

**`first-run`** — `installed` → `logDetected` → `firstParse` → `firstNonOverviewView` → `firstOverlayEnabled`

**`voice-install`** — `engineSelected` → `downloadStarted` → `downloadCompleted` → `firstUtterance`

**`feedback`** — `dialogOpened` → `sendPressed` → `sendFinished`

## Buckets

Where a raw number would say too much about one person, the app sends a RANGE instead.
These are the exact ranges, taken from the schema:

**`coldStartMsBucket`** — How long the app took to start.

| Bucket | Range |
| --- | --- |
| 0 | < 1 s |
| 1 | 1 s – 2.5 s |
| 2 | 2.5 s – 5 s |
| 3 | 5 s – 10 s |
| 4 | 10 s – 20 s |
| 5 | ≥ 20 s |

**`charCountBucket`** — How many character logs the app can see.

| Bucket | Range |
| --- | --- |
| 0 | 0 |
| 1 | 1 |
| 2 | 2 |
| 3 | 3 – 4 |
| 4 | 5 – 8 |
| 5 | ≥ 9 |

**`logSizeBucket`** — Size of the log file being read.

| Bucket | Range |
| --- | --- |
| 0 | < 1 MB |
| 1 | 1 MB – 10 MB |
| 2 | 10 MB – 100 MB |
| 3 | 100 MB – 512 MB |
| 4 | 512 MB – 2 GB |
| 5 | ≥ 2 GB |

**`alertCountBucket`** — How many alerts are configured.

| Bucket | Range |
| --- | --- |
| 0 | 0 |
| 1 | 1 – 4 |
| 2 | 5 – 9 |
| 3 | 10 – 24 |
| 4 | 25 – 49 |
| 5 | ≥ 50 |

**`sessionAgeBucket`** — How long the app had been running when an error happened.

| Bucket | Range |
| --- | --- |
| 0 | < 60 s |
| 1 | 60 s – 300 s |
| 2 | 300 s – 1800 s |
| 3 | 1800 s – 7200 s |
| 4 | ≥ 7200 s |

## Turning it off

**Preferences → Usage analytics** has one switch. Turning it off stops collection, throws
away everything currently held on your machine, and discards the random id — all
immediately. Nothing is kept to be sent later. Turning it back on starts from empty, with a
new id, which counts as a brand-new install.

**One last thing is sent when you turn it off, and this is it:** a single notice saying the
switch was turned off, so opt-outs can be counted rather than guessed at. It carries no
measurements at all, only the five facts at the top of this page that every send carries.
Everything else waiting to be sent is thrown away rather than sent with it, and nothing
further is ever sent. If your machine is offline at that moment the notice is simply lost;
it is never retried, because keeping something to send later is exactly what turning this
off is supposed to stop. Turning it back on sends the matching notice under the new id.
