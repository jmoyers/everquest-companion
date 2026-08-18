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

Every 10 minutes while the app is open — the "is anyone using it right now" signal. Which moment in those ten minutes it falls on is picked fresh each time the app starts, and every one is nudged a few seconds either way, so that many copies of this app started at the same time do not all call home in the same second — the ten minutes itself never changes. Present on the first of these that follows startup, once per launch: how long reading your log history took, and how smoothly. Reading a log after switching character is deliberately not measured. Every number in the group is a count or a duration; several are ranges rather than exact figures, and which is which is stated field by field below. It also carries how smoothly the app itself was running since the previous one: how late its own timers arrived, how long its reads of your log took, and which of its windows and switches were on. All of it is counts and ranges about this computer - no line of your log, and no part of one, is ever sent. Each group is left out entirely when there is nothing to say (no character attached, or the check was not running).

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
| `startup.newBytesBucket` | bucket index (optional) | How much your log had grown since the app last closed normally — a RANGE (see below), never the amount itself. Sent only when the app knows where it had read to last time; after a first run or a crash it is simply not sent. |
| `startup.stutter.p50Bucket` | bucket index (optional) | While it was reading, the app checks a clock on a fixed beat and notes how late each beat was. This is the TYPICAL lateness, as a range — a reading about the computer, not about anything in the log. |
| `startup.stutter.p95Bucket` | bucket index (optional) | The same measurement at its worse end: the lateness only one beat in twenty exceeded. |
| `startup.stutter.latePct` | whole number (optional) | What share of those beats were late at all, 0–100. |
| `startup.firstMbMs` | whole number (optional) | How long the first megabyte of the read took to arrive — how quickly the machine could hand over the file, nothing about what was in it. Not sent for a log under a megabyte. |
| `live.samples` | whole number (optional) | How many times the app checked its own clock since the last one of these. |
| `live.p95Bucket` | bucket index (optional) | The app sets a timer for a quarter second, over and over, and notes how late each one actually arrived. This is the lateness only one check in twenty exceeded, as a RANGE (see below) - a reading about the computer, never about anything you did. |
| `live.maxBucket` | bucket index (optional) | The worst single one of those, as a range - the moment you would have felt. |
| `live.over100` | whole number (optional) | How many of those checks were more than a tenth of a second late. |
| `live.over500` | whole number (optional) | How many were more than half a second late. |
| `live.coincident` | whole number (optional) | The app runs the same clock check on a second thread that does nothing else. This counts the moments BOTH went late at once - which means the whole computer paused (memory, a driver, a disk), not this app. It is how a freeze can be blamed correctly instead of guessed at. Not sent when that second check was not running. |
| `tail.reads` | whole number (optional) | How many times the app read new lines from your log since the last one of these. |
| `tail.reopens` | whole number (optional) | How many of those had to re-open the file (normally none). |
| `tail.p95Bucket` | bucket index (optional) | How long those reads took, at their worse end - the same ranges as the clock check above, so the two can be compared. The game writes to that same file, so this is how much of its time the app could be taking. |
| `tail.maxBucket` | bucket index (optional) | The slowest single read, as a range. |
| `tail.over100` | whole number (optional) | Reads that took more than a tenth of a second. |
| `tail.over500` | whole number (optional) | Reads that took more than half a second. |
| `tail.deltaBytesBucket` | bucket index (optional) | The biggest single chunk of new log read at once - a RANGE (see below), never the amount itself, and never any part of what was in it. |
| `tail.logSizeBucket` | bucket index (optional) | How big that log is now - a range, never the size itself. |
| `state.overlaysOpen` | whole number (optional) | How many floating meters were open. |
| `state.overlaysLocked` | whole number (optional) | How many of those were locked (click-through). Locking makes Windows route mouse events through this app, so it is the setting most likely to explain a stutter. |
| `state.presenceOn` | true / false (optional) | Whether the app was watching for the game window (needed by auto-hide and the ring). |
| `state.ringOn` | true / false (optional) | Whether the cursor ring was on. |
| `state.freeMemBucket` | bucket index (optional) | How much free memory the computer had, as a RANGE - a machine with none left pauses everything, including the game. |
| `state.workingSetBucket` | bucket index (optional) | How much memory THIS APP was using, as a range. The honesty half of the row above. |

### `sessionEnd`

Once, when the app closes. Present on the first of these that follows startup, once per launch: how long reading your log history took, and how smoothly. Reading a log after switching character is deliberately not measured. Every number in the group is a count or a duration; several are ranges rather than exact figures, and which is which is stated field by field below. It also carries how smoothly the app itself was running since the previous one: how late its own timers arrived, how long its reads of your log took, and which of its windows and switches were on. All of it is counts and ranges about this computer - no line of your log, and no part of one, is ever sent. Each group is left out entirely when there is nothing to say (no character attached, or the check was not running).

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
| `startup.newBytesBucket` | bucket index (optional) | How much your log had grown since the app last closed normally — a RANGE (see below), never the amount itself. Sent only when the app knows where it had read to last time; after a first run or a crash it is simply not sent. |
| `startup.stutter.p50Bucket` | bucket index (optional) | While it was reading, the app checks a clock on a fixed beat and notes how late each beat was. This is the TYPICAL lateness, as a range — a reading about the computer, not about anything in the log. |
| `startup.stutter.p95Bucket` | bucket index (optional) | The same measurement at its worse end: the lateness only one beat in twenty exceeded. |
| `startup.stutter.latePct` | whole number (optional) | What share of those beats were late at all, 0–100. |
| `startup.firstMbMs` | whole number (optional) | How long the first megabyte of the read took to arrive — how quickly the machine could hand over the file, nothing about what was in it. Not sent for a log under a megabyte. |
| `live.samples` | whole number (optional) | How many times the app checked its own clock since the last one of these. |
| `live.p95Bucket` | bucket index (optional) | The app sets a timer for a quarter second, over and over, and notes how late each one actually arrived. This is the lateness only one check in twenty exceeded, as a RANGE (see below) - a reading about the computer, never about anything you did. |
| `live.maxBucket` | bucket index (optional) | The worst single one of those, as a range - the moment you would have felt. |
| `live.over100` | whole number (optional) | How many of those checks were more than a tenth of a second late. |
| `live.over500` | whole number (optional) | How many were more than half a second late. |
| `live.coincident` | whole number (optional) | The app runs the same clock check on a second thread that does nothing else. This counts the moments BOTH went late at once - which means the whole computer paused (memory, a driver, a disk), not this app. It is how a freeze can be blamed correctly instead of guessed at. Not sent when that second check was not running. |
| `tail.reads` | whole number (optional) | How many times the app read new lines from your log since the last one of these. |
| `tail.reopens` | whole number (optional) | How many of those had to re-open the file (normally none). |
| `tail.p95Bucket` | bucket index (optional) | How long those reads took, at their worse end - the same ranges as the clock check above, so the two can be compared. The game writes to that same file, so this is how much of its time the app could be taking. |
| `tail.maxBucket` | bucket index (optional) | The slowest single read, as a range. |
| `tail.over100` | whole number (optional) | Reads that took more than a tenth of a second. |
| `tail.over500` | whole number (optional) | Reads that took more than half a second. |
| `tail.deltaBytesBucket` | bucket index (optional) | The biggest single chunk of new log read at once - a RANGE (see below), never the amount itself, and never any part of what was in it. |
| `tail.logSizeBucket` | bucket index (optional) | How big that log is now - a range, never the size itself. |
| `state.overlaysOpen` | whole number (optional) | How many floating meters were open. |
| `state.overlaysLocked` | whole number (optional) | How many of those were locked (click-through). Locking makes Windows route mouse events through this app, so it is the setting most likely to explain a stutter. |
| `state.presenceOn` | true / false (optional) | Whether the app was watching for the game window (needed by auto-hide and the ring). |
| `state.ringOn` | true / false (optional) | Whether the cursor ring was on. |
| `state.freeMemBucket` | bucket index (optional) | How much free memory the computer had, as a RANGE - a machine with none left pauses everything, including the game. |
| `state.workingSetBucket` | bucket index (optional) | How much memory THIS APP was using, as a range. The honesty half of the row above. |

### `viewDwell`

When you switch away from a tab.

| Field | Values | What it means |
| --- | --- | --- |
| `view` | `overview` · `combat` · `mobs` · `maps` · `bosses` · `posky` · `alerts` · `leveling` · `loot` · `planner` · `buffs` · `timers` · `gear` · `wishlist` · `character` · `preferences` · `triage` | Which tab. A fixed list of tab names. |
| `ms` | whole number | How long it was on screen. |

### `overlayToggle`

When you open or close a floating meter.

| Field | Values | What it means |
| --- | --- | --- |
| `kind` | `fight` · `overall` · `heal-fight` · `heal-overall` · `events` · `toast` · `buffs` · `debuffs` · `xp` · `respawn` · `alertBanner` · `conCard` | Which overlay. |
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
| `overlaysEnabled` | list of `fight` · `overall` · `heal-fight` · `heal-overall` · `events` · `toast` · `buffs` · `debuffs` · `xp` · `respawn` · `alertBanner` · `conCard` | Which floating meters are open. |
| `cursorRing` | true / false | Is the cursor ring on. |
| `autoHide` | true / false | Is overlay auto-hide on. |
| `voiceEngine` | `system` · `kokoro` · `off` | Which speech tier your spoken alerts use — off when no alert is set to speak. |
| `soundPackCount` | whole number | How many sound packs are installed. |
| `updateChannel` | `main` · `stable` | Update channel. |
| `cpuCountBucket` | bucket index | How many processor cores the machine has — a range, never the number. |
| `totalMemBucket` | bucket index | How much memory the machine has — a range, never the number. |
| `gpuVendor` | `nvidia` · `amd` · `intel` · `other` · `unknown` | Who made the graphics chip. Never the model, never a driver version. |
| `gpuCompositing` | `hardware` · `software` · `off` · `unknown` | Whether the app is drawing with the graphics chip or on the processor. |
| `safeMode` | true / false | Is graphics safe mode on for this launch. |
| `displayCountBucket` | bucket index | How many monitors are attached. |
| `primaryScaleBucket` | bucket index | The main monitor’s display scaling (100%, 125%, …). |
| `eqWindowMode` | `fullscreen` · `windowed` · `unknown` | Whether EverQuest is set to fullscreen or windowed — one true/false read out of `eqclient.ini`. Nothing else in that file is read, and nothing from your log. `fullscreen` means the game’s own Fullscreen setting is on, which on the current client is a borderless fullscreen window and not an exclusive display mode. |

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
| `imageCacheReadFailures` | whole number (optional) | Times a picture the app had already saved could not be read back, so it was downloaded again. The picture is still shown. Never which picture, and never where it was kept. |
| `gpuProcessGone` | whole number (optional) | Times the graphics helper the app draws with died and was restarted — usually seen as a flicker. A count, plus the reason code in the error log. |
| `utilityProcessGone` | whole number (optional) | The same for a background helper (sound, network, storage). These come and go normally, so this is a count only and is not treated as an error. |

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
| `view` | `overview` · `combat` · `mobs` · `maps` · `bosses` · `posky` · `alerts` · `leveling` · `loot` · `planner` · `buffs` · `timers` · `gear` · `wishlist` · `character` · `preferences` · `triage` · `unknown` | Which tab was open. A fixed list. |
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

**`startup.newBytesBucket`** — How much the log grew while the app was closed.

| Bucket | Range |
| --- | --- |
| 0 | < 64 KB |
| 1 | 64 KB – 256 KB |
| 2 | 256 KB – 1 MB |
| 3 | 1 MB – 4 MB |
| 4 | 4 MB – 16 MB |
| 5 | 16 MB – 64 MB |
| 6 | 64 MB – 256 MB |
| 7 | ≥ 256 MB |

**`startup.stutter.p50Bucket`** — How late the app’s own clock ran while it read (typical beat).

| Bucket | Range |
| --- | --- |
| 0 | < 2 ms |
| 1 | 2 ms – 5 ms |
| 2 | 5 ms – 10 ms |
| 3 | 10 ms – 25 ms |
| 4 | 25 ms – 50 ms |
| 5 | 50 ms – 100 ms |
| 6 | 100 ms – 250 ms |
| 7 | ≥ 250 ms |

**`startup.stutter.p95Bucket`** — The same, at the worse end (one beat in twenty).

| Bucket | Range |
| --- | --- |
| 0 | < 2 ms |
| 1 | 2 ms – 5 ms |
| 2 | 5 ms – 10 ms |
| 3 | 10 ms – 25 ms |
| 4 | 25 ms – 50 ms |
| 5 | 50 ms – 100 ms |
| 6 | 100 ms – 250 ms |
| 7 | ≥ 250 ms |

**`cpuCountBucket`** — How many processor cores the machine has.

| Bucket | Range |
| --- | --- |
| 0 | 0 – 1 |
| 1 | 2 – 3 |
| 2 | 4 – 5 |
| 3 | 6 – 7 |
| 4 | 8 – 11 |
| 5 | 12 – 15 |
| 6 | 16 – 23 |
| 7 | ≥ 24 |

**`totalMemBucket`** — How much memory the machine has.

| Bucket | Range |
| --- | --- |
| 0 | < 4 GB |
| 1 | 4 GB – 8 GB |
| 2 | 8 GB – 12 GB |
| 3 | 12 GB – 16 GB |
| 4 | 16 GB – 24 GB |
| 5 | 24 GB – 32 GB |
| 6 | 32 GB – 64 GB |
| 7 | ≥ 64 GB |

**`displayCountBucket`** — How many monitors are attached.

| Bucket | Range |
| --- | --- |
| 0 | 0 |
| 1 | 1 |
| 2 | 2 |
| 3 | ≥ 3 |

**`primaryScaleBucket`** — The main monitor’s display scaling.

| Bucket | Range |
| --- | --- |
| 0 | < 100% |
| 1 | 100% – 125% |
| 2 | 125% – 150% |
| 3 | 150% – 175% |
| 4 | 175% – 200% |
| 5 | ≥ 200% |

**`live.p95Bucket · live.maxBucket · tail.p95Bucket · tail.maxBucket`** — How late the app’s own timers ran, and how long its reads of the log took.

| Bucket | Range |
| --- | --- |
| 0 | < 10 ms |
| 1 | 10 ms – 25 ms |
| 2 | 25 ms – 50 ms |
| 3 | 50 ms – 100 ms |
| 4 | 100 ms – 250 ms |
| 5 | 250 ms – 500 ms |
| 6 | 500 ms – 1 s |
| 7 | 1 s – 2.5 s |
| 8 | ≥ 2.5 s |

**`tail.deltaBytesBucket`** — The biggest single chunk of new log read at once.

| Bucket | Range |
| --- | --- |
| 0 | < 64 KB |
| 1 | 64 KB – 256 KB |
| 2 | 256 KB – 1 MB |
| 3 | 1 MB – 4 MB |
| 4 | 4 MB – 16 MB |
| 5 | 16 MB – 64 MB |
| 6 | 64 MB – 256 MB |
| 7 | ≥ 256 MB |

**`state.freeMemBucket`** — How much free memory the computer had.

| Bucket | Range |
| --- | --- |
| 0 | < 0.5 GB |
| 1 | 0.5 GB – 1 GB |
| 2 | 1 GB – 2 GB |
| 3 | 2 GB – 4 GB |
| 4 | 4 GB – 8 GB |
| 5 | ≥ 8 GB |

**`state.workingSetBucket`** — How much memory this app was using.

| Bucket | Range |
| --- | --- |
| 0 | < 200 MB |
| 1 | 200 MB – 400 MB |
| 2 | 400 MB – 800 MB |
| 3 | 800 MB – 1200 MB |
| 4 | 1200 MB – 2000 MB |
| 5 | ≥ 2000 MB |

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
