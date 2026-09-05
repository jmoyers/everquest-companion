# AI Assistant (Module 7 deepening)

Status: IMPLEMENTATION. Branch `feat/ai-improvements`.
Constrained by AGENTS.md: local knowledge, overlay kinds append-only, store
readers default on a missing key, no em dashes in player copy, messages over
inference, the lint ratchet only shrinks.

This is a deepening of the existing assistant, not a second product. The player
already has an AI tab. This work makes it honest about *this* character, useful
over the game, and quiet unless asked to speak up.

## 0. What the player gets

You can ask the companion about items, spells, this fight, this zone, your
buffs, and what you just looted. Answers come from the game data already in the
app and from your own log - not from EverQuest Live, not from P99, and not from
a live wiki fetch. If it has not seen your bags, it tells you to type
`/outputfile inventory` in game instead of guessing. An optional overlay shows
the last answer over the game. Alert ideas need your Save click. Tips that pop up while you
zone are **not in this PR** (A16).

## 1. Decisions

| # | Decision | Why | Tradeoff |
|---|---|---|---|
| A1 | Local committed DBs only (`items.json`, `spells.json`, mob catalog). The assistant never calls `lookupItem` / `lookupMob` (those fall through to the wiki). | A first-party helper that phones a volunteer wiki is a reliability and etiquette failure. The app already ships the catalogs. | Answers stop at what the scrape committed. Missing wiki pages stay missing until the next data refresh, not until a live fetch. |
| A2 | OpenRouter API key only. Subscription auth stays thrown until a real proxy exists. Short allowlist of models; unknown stored slugs degrade to `deepseek/deepseek-chat`. | One billed path, one failure mode, no fake "logged in" state. | Players who wanted a cookie login wait. That is cheaper than shipping a stub that looks like it works. |
| A3 | `draft_alert` proposes an `AlertDef`. `ai:saveDraftAlert` is the only write. The chat shows Save / Dismiss / Open in Alerts. | Alerts are shareable and fire in live play. Auto-saving a model-written regex is a foot-gun. | One extra click. That click is the product. |
| A4 | Recap is parsed fields only (combat, zone, loot, AA). No `raw`, no say/tell. 5 minutes / 80 lines. | `LogEvent.raw` can carry quoted chat. The scrub law exists because this repo is public. | The model cannot quote a tell. That is law 6, not a missing feature. |
| A5 | Inventory and spellbook are **not** dumped into the system prompt. The model calls `get_output`. | Prompt size and privacy. A bag dump is huge and stale the moment you loot. | The model must tool-call. We keep tools on follow-ups (4 rounds). |
| A6 | `get_output` returns `empty`, `updatedAt`, `stale` (older than 20 minutes), and a `note`. Empty → tell them the exact `/outputfile` command. Stale → say the list may not match what they are wearing. Never invent bags. | Last night's dump looking like "now" is a confident wrong answer. 20 minutes is long enough for a sit-down, short enough to catch a session gap. | A player who vendors for 25 minutes gets a stale flag even if bags did not change. Prefer that over a silent lie. |
| A7 | Overlay kind `'ai'` is appended **last** in `OVERLAY_KINDS` (before the strip kinds that `OVERLAY_LABEL_ORDER` pins). Default off. Last answer + stream + ask. Locked = last answer only. MUI-free. Markdown rendered. | Overlay infra already solves transparency, bounds, click-through. A tab clone over the game is unreadable in a fight. | No status strip, no dump coach, no chips in the overlay. The tab keeps those. |
| A8 | One shared thread: `localStorage` key `eq.ai.messages` (same origin). Persist role, text, unsaved drafts, mention names. Cap 40. | Views unmount on tab switch (JOS-90). Draft cards that die on reload teach the player the assistant is forgetful. | localStorage is not a sync protocol. Two windows writing at once last-write-wins. One send at a time is the accepted limit. |
| A9 | Spend/model bar on tab and overlay: `$0.015` and `DeepSeek V4 Flash`. Spend is OpenRouter `auth/key` usage for this API key, refreshed on mount and after a send, never on a timer. Unknown spend is `-`. | Players should see cost and which brain is answering. Polling OpenRouter every few seconds would look careless and spend quota. | The dollar figure is **key lifetime usage**, not "this chat." We do not invent per-prompt accounting OpenRouter does not give us for free. |
| A10 | Named tool hint (`items`, `spells`, `mobs`, `loadout`, `aa`). Never "Looking it up." | A generic gerund is a lie when we know which tool fired. | One word, not a tutorial. |
| A11 | Proactive is **off by default**. Preferences toggle and `/proactive` / `/proactive off` write the same `aiConfig.proactive` flag. Absent key = off (no schema bump: same pattern as a new overlay kind arriving OFF). | A helper that talks while you play will be uninstalled if it is chatty on a fresh install. Opt-in is the professionalism. | People who never open Settings never see it. The chat command is the discoverability path. |
| A12 | Proactive does **not** call the model on every log line. A small hook list (zone enter, ding, dump landing) builds a **computed** sentence from folded facts + the spell DB. Quiet during a live pull. Dedup per `(hook, zone)`. | Reviewable rules, no surprise bill, no main-thread LLM stall mid-parse. The owner's Sebilis example is a level-delta + loadout + spell DB join, which the log can actually support. | Tips are less "clever" than a free-form model. That is the point: we would rather be boring and true. |
| A13 | Proactive tips write one assistant row into the shared thread so the overlay last-answer shows them. | Overlay is where you are looking while zoned. A second toast species would fight celebration toasts and alerts. | A tip replaces the last answer until you ask something else. Acceptable for an opt-in coach. |
| A14 | No quoted chat in, no wiki scrape, no auto-save, no subscription stub, no voice in this PR. | Each is a product and a threat-model of its own. Shipping them in the first review looks unfinished. | Follow-up PRs. Voice must not fight the alert speech engine (D5). |
| A15 | Picker is eight pinned slugs, two per tier: Free, Good, Better, Best. Default stays `deepseek/deepseek-chat`. Free cards that train on prompts (Poolside, Liquid) are not listed. Catalog is not live-fetched. | A short list is reviewable. Default is the tool loop we already run. Free is $0 with rate limits and churn - Settings and the PR say so, and link [openrouter.ai/collections/free-models](https://openrouter.ai/collections/free-models). | A pinned `:free` slug can vanish. We fail with one sentence and keep `resolveAiModel` degrading unknown stored ids to DeepSeek Chat. |
| A16 | Proactive UI is **parked this PR**. `AI_PROACTIVE_SHIPPED` is false, so the host never fires even if a store still has the flag. Preferences has no checkbox. `/proactive` answers a parked sentence and does not flip the flag. Plumbing stays (`aiProactive.ts`, host, inbox). | Catalog-name zone tips are not what a player needs. Shipping them would look unfinished. Next pass should name key drops and named enemies. | Dogfooders who already typed `/proactive` go quiet after this build. That is the point. |

### Why these eight models

| Tier | Slug | Seat |
|---|---|---|
| Free | `nvidia/nemotron-3.5-lightning:free` | Tools, high on OpenRouter's free collection, NVIDIA open weights. |
| Free | `openai/gpt-oss-20b:free` | Tools, Apache-2.0, not a train-on-your-chats card. |
| Good | `deepseek/deepseek-chat` | App default. Cheap paid. Known tool loop. |
| Good | `deepseek/deepseek-v4-flash-0731` | Same house, faster flash. |
| Better | `google/gemini-3.7-flash` | Daily driver, strong tools. |
| Better | `google/gemini-3.6-flash` | Sibling so Better is not one SKU. |
| Best | `anthropic/claude-sonnet-4.6` | Careful "do not invent" answers. |
| Best | `x-ai/grok-4.6` | Second flagship, different vendor. |

`openrouter.ai` may be opened only at `/keys` and `/collections/free-models` (path-scoped, same rule as github.com).

## 2. Tools

The model calls these. Sources are folded state or committed JSON.

| Tool | Source | Will not invent |
|---|---|---|
| `search_items` | `items.json` via `itemsDb` | Live wiki stats |
| `search_spells` | corrected spell DB + `spellSearch` | Rank as identity |
| `search_mobs` | local mob catalog | Wiki fallback |
| `get_output` | dump file + mtime | Bag contents when empty/stale |
| `get_loadout` | combo snapshot | A `/who` the log does not have (labels inferred) |
| `get_aa` | AA ledger | Community prices |
| `get_fight` | combat snapshot | A live meter while `hydrating` |
| `get_zone` | zone + catalog mobs + watched clocks | A spawn from a due clock |
| `get_buffs` | buffs snapshot | Duration the DB does not state |
| `get_recent_loot` | loot module + item DB join | Quest use for an unknown name |
| `draft_alert` | `aiDraftAlert` | A saved def |

Retired mock names stay in `RETIRED_TOOL_NAMES` so they cannot return by accident.

## 3. Overlay and persist

Kind `'ai'`. Chrome matches the event log (lock, bg alpha, text scale). Streaming tokens paint even when the question was asked in the tab (`ai:chunk` fans out to main + this overlay). Markdown is `AiOverlayMarkdown.tsx` (ReactMarkdown + remark-gfm, no MUI).

Persist key `eq.ai.messages`. Parser degrades junk to `[]`. Draft cards persist until Save or Dismiss. Mentions re-link after reload.

## 4. Proactive (parked)

Plumbing is in the tree. The product is not. `AI_PROACTIVE_SHIPPED === false`.

**Next pass (need-to-know, not a catalog dump):** key item drops, named enemies in the zone, vendor spells after a ding if that is still true. Same gates as A12 (live only, quiet in combat, no model per log line).

**This PR:** `/proactive` returns `AI_PROACTIVE_PARKED`. No checkbox. No overlay spam.

## 5. Store and IPC

- `aiConfig`: existing blob. Additive optional `proactive?: boolean`. Absent = off. No migration (new-kind-arrives-OFF precedent).
- Overlay config `overlays.ai` uses the ordinary overlay defaults (closed).
- IPC: existing `ai:*` plus `ai:usageGet` and `ai:proactive` (push a tip text to main + overlay).
- Overlay kind appended last in `OVERLAY_KINDS`.

## 6. Tests (laws, not line counts)

| File | Law |
|---|---|
| `tests/aiKnowledge.test.mts` | Local search hits committed JSON; retired mocks gone; new tools named |
| `tests/aiDumpView.test.mts` | Empty dump names the command; stale after 20 min |
| `tests/aiChatPersist.test.mts` | Drafts + mentions survive; spend format `$0.015`; model label strips `[Good]` |
| `tests/aiOverlay.test.mts` | MUI-free overlay; eqOverlay not `window.eq`; markdown renderer; usage IPC |
| `tests/aiProactive.test.mts` | Engine pins for the next pass; `AI_PROACTIVE_SHIPPED` is false |
| `tests/copyNoEmDash.test.mts` | Player strings |

PR gate: `npm run typecheck`, `npm run lint` (no ratchet widen), `npm test`.

## 7. Out of scope

Voice (D5). Live wiki or eqlbuilds fetch. Auto-save alerts. Quoted chat in the prompt. Subscription auth. Restyle. Player-facing proactive tips (A16). `AGENTS.md`. `releaseNotes.ts` (written at tag). `resources/wiki-images/` (item art, not a manual).
