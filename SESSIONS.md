# Sessions, memory and grouping

How this build relates to your real Claude Desktop install. Extracted from the README
when that was rewritten for a general audience; the content is unchanged, and it is the
evidence base for [issue #3](https://github.com/mkornreich/llm-desktop-electron/issues/3).

Applies to the **desktop build** only. The standalone proxy has nothing to do with any
of this.

## Update: the session store is now SHARED, not copied

Everything below this section describes the **old** one-way copy, and is kept because the
evidence in it still stands. What changed (issue #3):

`user-data/claude-code-sessions` is now a **symlink** to
`~/Library/Application Support/Claude/claude-code-sessions`. There is one directory, so a
session created or renamed in either app is immediately the other's. Nothing is copied,
nothing merges, nothing goes stale.

**Why the copy had to go.** One-way meant sessions created *here* had nowhere to go, so the
two stores drifted apart in both directions. When this was changed the split was 13 sessions
only in the real install, 64 only in this build, and 15 present in both with different
contents — so a naive symlink would have abandoned 64 sessions. `scripts/merge-sessions.mjs`
took the union first (newest `lastActivityAt` wins, ties to the real install), backing both
trees up to `user-data/claude-code-sessions.premerge`. It wrote 67 files and brought the
shared store to 506.

**Verified in both directions**, at the filesystem level: a file written under
`user-data/claude-code-sessions/` appears at the real install path, and one written at the
real install path appears under `user-data/`. The app relaunched clean afterwards —
`isLoggedOut: false`, `my-access] loaded`.

**Two consequences, both accepted deliberately:**

1. This build now **writes into the real install's data**. That was previously a stated
   safety property and no longer holds for this one directory; everything else in
   `user-data/` is still private.
2. **Deletion is global.** `isArchived` is `0` across every session file on both sides, so
   the UI removes a session by deleting its file — and there is now one file, not two.

**Local Storage is deliberately still a copy**, not a share, and cannot be made one: LevelDB
allows a single process at a time, and both databases hold an exclusive `fcntl(F_WRLCK)` on
their `LOCK` file while their app runs (verified with `F_GETLK`). Point both apps at one
directory and the second to start cannot open its UI state at all — a native binding does not
help, because it takes the same lock on the same inode. Reads are unaffected, so the only
shapes available there are pull-before-launch and push-after-quit.

---

## Which model actually answered a session

A session's stored `model` is the identity the **client selected**. In OpenAI mode that is never
what answered, and six distinct things were collapsed into that one field:

| Dimension | Example | What it decides |
|---|---|---|
| session-selected model | `claude-opus-4-8` | what the picker showed |
| capability identity | `claude-opus-4-8[1m]` | the context window |
| wire model | `claude-opus-4-8` | what arrived on `/v1/messages` |
| resolved upstream model | `gpt-5.6-sol` | what actually answered |
| API surface | `responses` | which translation ran |
| route | `main`, `safety:block` | which policy applied |

So "which model wrote this?" could not be answered after the fact, and neither could "was this
session Anthropic or OpenAI?" — the transcript looks identical either way. Three sessions in this
repository's own history were misattributed while investigating exactly that.

### Keyed by the session id the client already sends

The client identifies its session on every request:

```
x-claude-code-session-id: 0bfac150-a1d5-4253-86c7-2236cb2f8768
anthropic-beta: claude-code-20250219,context-1m-2025-08-07,…,effort-2025-11-24
```

Captured from the real client against a header-logging server. The proxy had been discarding both.
The `anthropic-beta` list is the client's **own** account of the capabilities it negotiated, which is
stronger evidence than what the launcher configured — those can disagree, and when they do the
negotiated one is what set the window. They are recorded separately for that reason.

A prompt-cache hash is **not** session identity: it collides across forks and changes within a
session. It is never used as one.

### A sidecar, not the session files

`user-data/claude-code-sessions` is a **symlink** to the real Claude Desktop install's store, so both
applications read and write the same files. Adding fields there means betting that two proprietary
apps preserve unknown keys through a round trip — untested here, and proving it needs an isolated
fixture copy and a run of both apps, not an experiment against the live shared store. So
`provenance/` is **authoritative** and nothing is mirrored into session JSON.

```bash
node scripts/lib/provenance.mjs                 # every session: what answered, and when it changed
node scripts/lib/provenance.mjs <cli-session-id> # one session's full epoch history
```

Records are **append-only**. Creation provenance is immutable; every later change appends an epoch,
because rewriting a session's provider to "current" would erase the fact that half of it was
answered by something else. A write only happens when something actually changed, so a session with
thousands of turns holds one epoch, not thousands. The list is bounded at 200 and truncation is
recorded, so a shortened history never reads as a complete one.

A **cross-provider resume** — the same session answered by Anthropic and then OpenAI, or the reverse
— is logged loudly by the proxy and flagged in the settings window. It matters twice: the earlier
turns are not attributable to the current provider, and a model id persisted under one provider is
meaningless under the other.

### What is not covered

**Anthropic mode records nothing.** The proxy is the only component that sees a session id, and in
Anthropic mode it does not run. Recording there would mean adding work to the disclaimer helper's
Anthropic path, which is deliberately a byte-for-byte passthrough. So an absent record means "no
OpenAI turns were served", not "this session was Anthropic" — the settings window says so rather
than implying the stronger claim.

**No automatic model remapping.** Resuming an OpenAI-era session in Anthropic mode carries a
persisted `gpt-*` id that Anthropic will reject. Rewriting it would mean writing to the shared
session store, which is exactly what this design refuses to do. The mismatch is surfaced instead.

## Sessions and memory

### Memory and config — already shared, nothing to sync

The agent in this build reads the **same** `~/.claude` as Claude Desktop and the
`claude` CLI, so your memory files, `MEMORY.md` indexes, project `CLAUDE.md`s,
settings and session transcripts are all already visible to it. This is not
configured anywhere — it falls out of how the config dir resolves:

```js
process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude")
```

Verified rather than assumed, two ways:

- Every child process of this build runs with `HOME=$HOME` and **no**
  `CLAUDE_CONFIG_DIR` override, so it resolves `$HOME/.claude`.
- A session created *inside this build* wrote its transcript to
  `~/.claude/projects/<slug>/<cliSessionId>.jsonl` — the shared location, not
  anywhere under `user-data/`.

The MCP connectors come along too: a captured request carried all **214** tools,
Asana/Slack/Notion/calendar servers included (`PROXY_DUMP_TOOLS=1` — see
`openai-proxy/README.md`).

### Sessions — copied in on every launch

Sessions are the one thing that *isn't* shared, because they live in the profile
and this build runs on an isolated `--user-data-dir`. So `run.sh` syncs them
before Electron starts:

```
~/Library/Application Support/Claude/claude-code-sessions/<user>/<org>/local_*.json
  ->  user-data/claude-code-sessions/<user>/<org>/
```

Each `local_<uuid>.json` holds one session's metadata — `sessionId`,
`cliSessionId`, `cwd`, `title`, `isArchived`, `model`, `effort`,
`permissionMode`, `enabledMcpTools`. There is **no group field**: the sidebar
derives grouping from `cwd`, so copying these files brings sessions across with
their titles *and* their grouping intact.

The copy is `rsync -a --update` with no `--delete`, which makes it one-way and
additive. Tested by planting two things before a launch and checking both
survived:

| Planted | After sync |
|---|---|
| a session that exists only in this build | kept |
| a file edited to be *newer* here than the source | edit kept, not overwritten |
| all 378 Claude Desktop sessions | **0 missing**, 15 build-only sessions retained |

Toggle it in the **`.sync`** dot file (`SYNC_CLAUDE_SESSIONS=0` to launch without
syncing). If Claude Desktop is running, the launcher warns: a session it happens
to be writing at that instant can copy incompletely, and relaunching picks up the
final version.

### Grouping — settled, at the fourth attempt

Grouping is **local**, it lives in `dframe-store`, and it is merged both ways by
`scripts/sync-grouping.mjs` (`SYNC_CLAUDE_GROUPING=1`, on by default).

| where | what it holds | role |
|---|---|---|
| `dframe-store` → `state.customGroupsByScope` | per scope: `groups` (`cg-<uuid>` + name), `assignments` (session → group), `order` | **the authority** — this is what the sidebar reads |
| `dframe-store` → `state.groupByByMode` | `{"code":"custom"}` | without it the groups exist but nothing groups by them |
| `LSS-persisted.dframe-group-scopes` | the same model | **legacy mirror**, regenerated by the app |
| `GET …/user_settings` → `customGroupAssignments` | `{}` | empty; not the source |

**Four answers, three of them wrong. Recorded because each was reached by reasoning that looked
sound at the time.**

1. *"Grouping is server-side"* — from grepping for `sgrp_` and finding nothing. Right shape of
   answer for the wrong reason: `sgrp_` is the desktop bundle's *notification* format and never
   appears in either profile.
2. *"Grouping is local in Local Storage"* — from finding `dframe-group-scopes` and `cg-` ids
   there. Dismissed as a cache.
3. *"Server-side, confirmed by the network capture"* — `--net-log-capture-mode=Everything` showed
   `user_settings` returning `groupByByMode`, `customGroups`, `customGroupAssignments` and
   `customGroupOrder`, so the local key was written off as a mirror of it and
   `SYNC_CLAUDE_UI_STATE` was defaulted to 0 on the grounds that grouping could not be synced
   locally at all. The capture was real; the inference was not. `customGroupAssignments` is `{}`
   for this account **while the sidebar is fully grouped**, and the two apps disagreed with each
   other about membership — which a shared server store cannot produce. An empty server field and
   a populated sidebar means the sidebar is not reading the server field.
4. *"Local, in `LSS-persisted.dframe-group-scopes`"* — merging into that key verified fine, then
   **the app undid it**: launch, and the same key came back with a fresh timestamp, a new `tabId`
   and the merge gone. Measured at that moment the two keys disagreed *inside one profile* — the
   mirror held 7 groups, `customGroupsByScope` held 8.

What settled it was watching a write get reverted, and then diffing the two candidate keys within
a single profile. Merging `customGroupsByScope` survives a relaunch.

**The divergence, measured on the authoritative key.** The mirror made this look like 8 groups
against 7; on the store both profiles already had all 8 and the real gap was membership:

| | groups | assignments |
|---|---|---|
| real install | 8 | 69 |
| this build | 8 | 61 |
| only on one side | — | 10 real-only, **2 build-only** |
| union (what the merge writes) | 8 | 71 |

The 2 build-only assignments are why a one-way copy was the wrong tool: either direction loses
real work. Verified after merging and relaunching — this build went 61 → 71 and *kept* them,
gaining 4 sessions in `App Analysis`, 4 in `Prod Routines…`, and the 2 that made `email quality`
appear at all (it had 0 members here, so it did not render).

**Deletions do not propagate.** "Absent on one side" cannot be distinguished from "not yet added
there", and there is no per-entry deletion clock, so the merge is additive: delete a group in one
app and the next merge restores it from the other.

**Two hazards around `Local Storage`, both hit while investigating this:**

- **It holds auth state.** Deleting it produced `401`s and `Bootstrap API fetch failed` until a
  known-good copy was restored. An earlier note here claimed login was unaffected because
  authentication lives in Cookies — that was wrong.
- **Never restore a LevelDB backup from a profile that was not closed cleanly.** A backup taken
  after the app was killed with `pkill` left startup hanging in window setup, with renderers
  reporting *"Terminating current process after 15 seconds with no connection"*. The copy had
  captured a torn write. Recovery is to copy in a good `Local Storage`, not to delete it.

### Are the migrated sessions grouped correctly?

Grouping has exactly two sources, and neither is extra local state to copy:

- **Server-side.** A group id has the form `sgrp_…` (`/^sgrp_[A-Za-z0-9_-]{1,64}$/`),
  and in the local bundle it appears *only* in desktop-notification plumbing. The
  string `sgrp_` occurs **zero** times anywhere in either profile — Local Storage,
  IndexedDB, Session Storage, the sessions dir. So the web app owns grouping and it
  follows the account, not the machine.
- **`cwd` in the session file.** Everything the sidebar can group local sessions by
  travels inside `local_<uuid>.json`.

Verified by diffing every migrated session against its source on the fields that can
drive grouping, ordering and labelling — `cwd`, `originCwd`, `title`, `titleSource`,
`isArchived`, `worktreePath`, `worktreeName`, `branch`, `sourceBranch`, timestamps,
`model`, `effort`:

```
migrated sessions checked : 379
  grouping fields identical: 374
  missing from build       : 0
  field drift              : 5   (lastActivityAt / lastFocusedAt only)
distinct cwd values        : 4   (the repo + 3 worktrees)
```

The 5 drifted sessions differ **only** in `lastActivityAt`/`lastFocusedAt` — focus
timestamps, not grouping keys. Two causes, both correct: sessions opened in *this*
build are newer here and `--update` deliberately keeps them, and sessions Claude
Desktop touches *after* launch are picked up by the next launch. That is inherent to
copy-on-open.

One group points at `…/.claude/worktrees/musing-chandrasekhar-f2b1fd`, which no
longer exists on disk. The real app has the same dangling `cwd`, so both behave the
same; the sync did not cause it.

`[detectedProjects] done: 0 total projects` in the log is unrelated to session
grouping — that scan looks for **editor** workspace databases (VS Code, Cursor, Zed)
and logged `state.vscdb not found`. It feeds the recent-projects feature.
