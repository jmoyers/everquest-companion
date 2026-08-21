# Security

EQ Legends Companion is a desktop app that reads your EverQuest log file and shows
you what happened. This document is an honest description of what it touches, what
it does not, and how you can verify that the copy you installed is the one we built.

## Reporting a vulnerability

Email **[jmoyers+eqc@gmail.com](mailto:jmoyers+eqc@gmail.com)** — that inbox reaches the
person who maintains this project directly and privately, so a vulnerability can be confirmed
and fixed before anything is public. Put enough to reproduce it in the mail; don't file it in
a public issue.

If you'd rather use GitHub, [private security advisories](https://github.com/jmoyers/everquest-companion/security/advisories/new)
are an optional second channel when they're available on the repo — but the email above is the
one that's always open, so prefer it if you're unsure.

This is a small hobby project maintained by one person. There is no bounty and no
guaranteed response time, but reports are taken seriously and credited unless you
ask otherwise.

## What the app touches

**On your machine**

| Thing                                              | Access                                 |
| -------------------------------------------------- | -------------------------------------- |
| Your EverQuest log file(s)                          | **read-only**, never modified. Uploaded only as an opt-in, previewed, scrubbed slice attached to a bug report you send — see [Feedback reports](#feedback-reports) |
| `%APPDATA%\everquest-companion\`                    | read/write — your settings and progress |
| `%LOCALAPPDATA%\Programs\everquest-companion\`      | the install directory                   |
| Windows registry (`HKCU`, uninstall entry)          | written by the installer only           |

The app installs **per-user**. It never asks for administrator rights, and there is
no UAC prompt at install, update, or uninstall time — the installer is built with
`perMachine: false`, so it has no elevation manifest at all.

Your log file is the only game data it reads, and it is opened read-only. Log
contents are parsed locally, and they leave your machine in exactly one case: you
attach a slice to a feedback report and press Send, having seen it first. The
anonymous usage counts described below carry no log content of any kind — the
schema they are built from has no field that could hold a line of your log.

**Over the network** — all HTTPS. Everything the app does on its own from a
third-party host is a read-only GET:

| Host                                             | Why                                                   |
| ------------------------------------------------ | ----------------------------------------------------- |
| `github.com` / `objects.githubusercontent.com`   | update checks and installer downloads                  |
| `wiki.project1999.com`                           | item lookups + item icons                              |
| `eqlwiki.com`                                    | item lookups + item icons                              |
| `peonping.github.io`, `raw.githubusercontent.com`| the optional sound-pack registry and pack downloads     |

**Hosts that are ours, and only ours.** These are in a dedicated AWS account used for
nothing else, and the whole stack is in this repo under [`infra/`](infra/). There are
exactly three destinations, on two hosts:

| Destination | When |
| --- | --- |
| `pcy0z3xjp9.execute-api.us-east-1.amazonaws.com/v1/feedback` | **only when you press Send in the feedback dialog** — never on a timer, never at startup |
| `pcy0z3xjp9.execute-api.us-east-1.amazonaws.com/v1/telemetry` | anonymous usage counts, in batches on a 60-second timer, unless you turn them off — see [Usage analytics](#usage-analytics) |
| our own S3 bucket (`eqcompanion-logs-*.s3.us-east-1.amazonaws.com`) | only if you attached a log slice to a report you sent |

Both API routes are the same compiled-in constant plus a path, and the same rule
applies to each: **nothing in settings, in the UI, in an environment variable, or on
disk can point them somewhere else.** There is no override mechanism, because an
overridable ingest URL is an exfiltration primitive rather than a convenience. The
upload URL for a log slice comes back from the API, and the main process checks it
against an exact hostname match for that one bucket before a byte moves — a redirected
or substituted URL uploads nothing.

Remote images are fetched only from an exact hostname allowlist
(`wiki.project1999.com`, `eqlwiki.com`), HTTPS only, default port only, no embedded
credentials, and are cached on disk after content sniffing.

## What the app never does

- No account, no login, no credentials, nothing stored that identifies you.
- **No crash dumps, no session recording, no click stream, no free text.** The app
  does send anonymous usage *counts* (see [Usage analytics](#usage-analytics)); the
  schema those counts are built from is a closed list of numbers and fixed enum
  values with no free-text field anywhere in it, so a character name, a zone, a mob,
  an item, a search box, an alert name, a file path or a line of your log has
  nowhere to go — not "we choose not to send it", *there is no field for it*.
- **Nothing about your logs, characters, or gameplay is uploaded**, on a timer or
  otherwise. The one exception is a log slice you deliberately attach to a bug
  report, after reading it.
- It never joins the two things it does send. The anonymous analytics id and the
  feedback install id are separate random values, deliberately non-correlatable, and
  the analytics ingest role cannot read the report table at all.
- It does not write to, inject into, or otherwise touch the EverQuest client.
- It does not run with administrator privileges.
- It does not accept an update feed URL from settings, from the UI, or from any
  file on disk. The update source is compiled in.

## Usage analytics

The app sends **anonymous usage counts** — how long sessions last, which views get
used, which features get touched, whether an update or a voice install succeeded —
so that the person building it can see what works without asking you. It is **on by
default**. Everything below is checkable rather than promised:

- **You are told before anything is sent.** A one-sentence bar appears at the bottom
  of the window the first time you run the app. Until it has appeared, the network
  side does not start at all: the app may fill a local buffer, but the code path that
  transmits is gated on that flag, not merely on the switch.
- **Opting out is total, and immediate.** Press *Opt out* on that bar, or the switch
  in **Preferences → Usage analytics**, and the buffered events are deleted from disk
  **and so is your anonymous id** — not disabled, deleted. Turning it back on later
  mints a brand-new id, which looks like a brand-new install; that is the honest cost
  of having switched off, and it is stated in the app.
- **Every field is enumerable, and enumerated.** [`TELEMETRY.md`](TELEMETRY.md) lists
  every event, every field, and every bucket. It is *generated from the schema* and a
  test fails if the two ever disagree, so it cannot quietly describe a different app
  than the one you installed. Preferences shows the exact JSON waiting to be sent and
  the last batch that actually left.
- **It cannot be joined to a bug report.** The analytics id is a separate random value
  from the feedback install id, on purpose, and the ingest role for analytics has no
  read access to the reports table. We cannot correlate the two, and neither can
  anyone who compromised half of it.
- **There is no raw event store.** The server aggregates each batch into daily
  counters on arrival and keeps nothing per-event. What exists afterwards is sums.

**How long each piece is kept:**

| Data | Kept |
| --- | --- |
| `usage_daily`, `usage_funnel_daily` — the day-by-day counters | **indefinitely**, and they are anonymous by construction: a day, a metric name, a fixed dimension value, and a number. There is no id in these tables and nothing in them can be traced to an install. The counter rows now also carry a **shard number**, which is a random integer drawn per request purely so that concurrent writes stop colliding on one row: it is never derived from your anonymous id, and it says nothing about who sent the count. |
| `analytics_install` — first seen, last seen, days seen, version, channel | one row per anonymous id, kept while the id is in use. **This is the entire per-id footprint of the whole feature**, and deleting the row is the whole deletion path (`analytics wipe --id`). |
| The ingest function's own log | **14 days**, counts only — it never logs an analytics id, and the counters it reports cannot reconstruct a batch. |
| API gateway access logs, which include your source IP | **14 days**, exactly as for feedback below, and never joined to anything. |

**There is a backup, and it is a copy of the same data rather than more of it.** Once a
night the database is copied to a private S3 bucket in the same account — every table,
the same columns, as gzipped JSON — and AWS Backup separately keeps point-in-time copies
of the whole database (one a day for 35 days, one a month for a year). This exists
because a bad migration or a mistyped command can lose data that replication would
faithfully lose with it.

What matters for this section is what a backup **is not**: nothing new is gathered, no
field is added, nothing is derived, and no identifier appears in a copy that was not
already in the table. The bucket blocks all public access, nothing outside the account
can read it, and the one thing that writes to it can only add objects — it cannot read
one back, cannot delete one, and has no internet-facing trigger of any kind. The whole
stack is in this repo under [`infra/`](infra/), including the exact list of columns that
gets copied.

**Asking us to delete it.** Preferences shows your anonymous id; quote it in a
[GitHub issue](https://github.com/jmoyers/everquest-companion/issues) and the install
row goes. The daily counters it contributed to stay, because they are sums with no id
in them — there is no way to attribute them and no way to unpick one id's share, in
either direction. Pressing *Use a new id* in Preferences does the same thing from your
side: the old id is abandoned and never used again.

## Feedback reports

The other thing the app sends is a feedback report, and only when you press Send.
[`README.md`](README.md#feedback) describes what a report contains; this section is
about what happens to it afterwards. Nothing here is a promise about a third party —
the ingest API, the database, and the bucket are ours, in a dedicated AWS account,
and the whole stack is in this repo under [`infra/`](infra/).

**How long each piece is kept:**

| Data | Kept |
| --- | --- |
| The report itself — type, your description, the version block | **indefinitely**. It *is* the bug backlog; deleting it would mean losing the bug. |
| An attached log slice | **90 days**, then the object expires automatically. This is an S3 lifecycle rule on the bucket, not a script we have to remember to run — and versioning is off, so an expired or deleted object is gone rather than shadowed by an old version. |
| Contact details | **The field is gone, not hidden.** Reports have no contact field — anything you want us to have goes in the description, where you can see it. The database column that older reports used has been removed from the schema, and the values it held are destroyed rather than kept: there is nothing left to strip on request, because there is nothing left. |
| API gateway access logs, which include your source IP | **14 days**, then CloudWatch drops them. They exist for one reason: if the public endpoint is ever flooded, there is evidence for two weeks. **Your IP is never written onto a report and the two are never joined** — there is no query that turns an access log line back into "who filed what". |
| Rate-limit counters and duplicate-send keys | Days, not weeks (3 and 7 respectively), then deleted. |

**Asking us to delete something.** The dialog shows a **report id** after a successful
send — keep it. Quote that id in a
[GitHub issue](https://github.com/jmoyers/everquest-companion/issues) (or, if you'd rather it
not be public, email [jmoyers+eqc@gmail.com](mailto:jmoyers+eqc@gmail.com)) and say what you
want removed. Deleting a slice
deletes the object outright and stamps the row so we can tell it was done. The
description itself stays unless you ask for the whole report to go, in which case the
report and its slice both go — that is what the `wipe` path in the triage tool exists
for.

**And here is the part most projects leave you to discover: backups.** Since the database
started being backed up (a nightly copy to a private bucket, plus point-in-time copies of
the whole database), deleting a report removes it from the live database **immediately**
and from the backups **within a bounded window** rather than instantly — because a backup
you can edit is not a backup. Concretely:

| Copy | When a deleted report is gone from it |
| --- | --- |
| The live database | immediately, when you ask |
| The attached log slice in S3 | immediately (the object is deleted outright; that bucket is unversioned on purpose) |
| The nightly copies of the reports table | **within 90 days** — the same window the attached slice already had. Reports are archived under their own storage prefix, separate from the counters, for exactly this reason: it is the only part of the archive that expires, and it expires *because* it is the only part holding anything anyone wrote |
| The whole-database point-in-time copies | **within 12 months**, when the last monthly one carrying it rolls off |

The counters are not on this list because there is nothing in them to delete: they are
anonymous daily sums with no identifier in them, in a backup exactly as in the live
database.

If a 90-day or 12-month window is not acceptable for something you sent, say so in the
request — the practical answer is usually that the report should not have contained it,
and the honest fix is to say what it was so it can be handled deliberately rather than
promised away.

Two things about how the collected data is handled, because they bound the damage a
mistake could do: **a log slice is never pasted into a public GitHub issue** (the repo
is public; an issue gets the description and a summary of what the log showed), and the
public ingest endpoint's database credentials can `INSERT` a report and touch the
counters — nothing more. It cannot read the backlog and it cannot delete anything, so
compromising the public half of the system leaks no reports.

## What a client sends is never trusted

The app scrubs and validates before sending — but an unmodified client is a courtesy,
not an assumption. Two paths exist for hostile input: forged JSON straight to the
public ingest routes, and raw bytes POSTed to a presigned upload URL. Both are handled
at boundaries we control:

- **Text is sanitized at the wire, by the shared validators all three consumers run.**
  Prose fields strip control characters, whole ANSI/VT escape sequences, and invisible
  reordering characters (normalization, like trimming — no word is ever shortened);
  single-line fields reject any control outright; a NUL byte anywhere in a request body
  is refused before parsing. Terminal-escape injection is in the threat model
  explicitly: the triage tools render attacker-controllable text in the operator's
  terminal, so every client string passes one shared sanitizer before display — and
  rows written before the wire rule existed get the same treatment on the way out.
- **The presign policy pins an upload's key, size, and content type — it cannot pin
  content.** So every slice is RE-SCRUBBED with the app's own scrubber when the
  operator downloads it, before it touches disk or screen. For an honest client the
  re-scrub removes zero lines; a non-zero delta is flagged loudly as evidence the
  client-side scrub was bypassed. The S3 object itself is never modified — it is the
  evidence — and `forget` remains the only deletion path.
- **Telemetry has no free-text field to sanitize**, and that claim is tested
  adversarially: a suite poisons every string slot of every event kind and requires
  refusal.

## How updates are verified today

1. The app polls **only** the GitHub Releases of this repository, over HTTPS. The
   feed location is fixed at build time (`electron-builder.yml`); nothing in the
   settings store or the renderer process can point it elsewhere.
2. The feed (`latest.yml` / `main.yml`) carries a **SHA-512** for the installer.
   `electron-updater` streams the download through a digest transform and aborts
   with `ERR_CHECKSUM_MISMATCH` on any mismatch. The same check is applied to
   differential (block-map) downloads and re-applied to an already-staged
   installer before it is ever run.
3. Downgrades are refused (`allowDowngrade = false`), so a re-published or
   rolled-back release cannot walk an installation backwards.
4. Every release also ships **`SHA256SUMS.txt`** so you can verify a manual
   download yourself, independently of GitHub's TLS:

   ```powershell
   certutil -hashfile everquest-companion-Setup.exe SHA256
   ```

   ```sh
   sha256sum -c SHA256SUMS.txt
   ```

## Code signing and the update trust chain

**Release builds are code-signed** ("Joshua Moyers", via Azure Artifact Signing;
CI injects the signing arguments on tagged releases — see `.github/workflows/`).
Two consequences:

1. SmartScreen: signed installers should not warn. If a warning appears while the
   certificate's reputation is new, *More info → Run anyway* — and the signature
   details on the exe are checkable either way (right-click → Properties →
   Digital Signatures).

2. The update path: `electron-updater` verifies more than transport integrity.
   Every download is checked byte-for-byte against the sha512 in the release
   feed, AND (because `publisherName` is set in electron-builder.yml) the
   downloaded installer's Authenticode publisher must match "Joshua Moyers" or
   the update fails with `ERR_UPDATER_INVALID_SIGNATURE` before anything runs.
   A compromised GitHub account alone is therefore no longer sufficient to ship
   a malicious update to existing installs: the attacker would also need the
   Azure signing identity. (Historical note: builds before v0.1.8 were unsigned
   and did not verify publisher identity; they will update to signed builds,
   and from then on the verification applies.)

- **Release-pipeline hardening.** CI publishes only from a pushed `v*` tag;
  only that one job holds a repository-write token (every other path runs read-only);
  all third-party GitHub Actions are pinned to commit SHAs; dependency install
  scripts are disabled (`.npmrc`, `ignore-scripts=true`) so a compromised npm
  package cannot execute code inside the release job.

For out-of-band certainty about a specific download, check it against
`SHA256SUMS.txt` on the release page and against the hash printed in the public
build log for that tag.

## Supply chain

- Dependencies are installed with `npm ci` from a committed lockfile; every entry
  carries a `sha512` integrity hash and resolves to `registry.npmjs.org`.
- `ignore-scripts=true` — no dependency's install hook executes on a developer
  machine or in CI. See `.npmrc`.
- All GitHub Actions are pinned to full commit SHAs, not mutable tags.
- Dependabot watches npm and Actions weekly (`.github/dependabot.yml`).
- The tree currently reports **zero** known vulnerabilities — `npm audit` and
  `npm audit --omit=dev` both say `found 0 vulnerabilities`. See
  [Known dependency advisories](#known-dependency-advisories) for why the plain
  `npm audit` number is the one that matters here.

## Known dependency advisories

**There are none open right now.** This section exists to say how they are judged
when there are, because the default reading of the numbers is wrong for this
project in one specific way.

**`--omit=dev` is not the runtime.** npm and Dependabot classify a package by
which block of `package.json` it sits in, and `electron` sits in
`devDependencies` — that is correct for how it is *installed* (it is not
`require`d from the packaged app's `node_modules`; it *is* the packaged app). The
consequence is that `npm audit --omit=dev` hides every Chromium advisory in the
thing users actually run. So the number quoted above is the plain `npm audit`,
and an electron advisory is treated as a **shipping** vulnerability regardless of
which block it was found in. `vite`, `esbuild`, `electron-builder` and friends
genuinely are build-time only: nothing they contain is copied into the installer.

**Electron is held to the supported line, not to the minimum patch.** Electron
takes Chromium security fixes on the newest three majors only. Pinning to the
exact version an advisory names would park us on a line that has stopped
receiving them, so the target is the current supported major even when that is a
larger jump. Majors are still hand-driven (`.github/dependabot.yml` ignores
`electron` / `electron-builder` majors on purpose) and are verified by building
and packaging, not by reading a changelog: `npm test`, `npm run test:e2e`
against a real boot, and `npm run dist:dir` through to a launchable
`win-unpacked`.

**Unreachable is stated, not assumed.** Where an advisory does not apply, the
reason is written down with the fix rather than used to skip it — for example
`GHSA-7g7r-gx96-252g` (`app-builder-lib`) is an `AppImage` `AppRun` bug, and
`electron-builder.yml` builds exactly one target, Windows `nsis` `x64`. It was
upgraded anyway. "Not reachable" is a note in the commit, not a reason to leave
a version behind.

## Scope

In scope: anything that lets someone else read your data, run code on your machine
through this app, or tamper with an update. Out of scope: SmartScreen warnings on
unsigned builds (known, documented above), and anything requiring an attacker who
already has code execution on your machine.
