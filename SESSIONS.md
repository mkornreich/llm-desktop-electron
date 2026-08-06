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

### Grouping — settled

Grouping is **server-side**, and there is nothing to sync. Captured with
`--net-log-capture-mode=Everything`, `GET /api/claude_code/organizations/{org}/user_settings`
returns the entire sidebar store:

```json
{"state":{"groupByByMode":{"code":"custom"},
          "customGroups":[{"id":"cg-1b717816-…","name":"App Analysis"}, … 7 groups …],
          "customGroupAssignments":{},
          "customGroupOrder":{},
          "pinnedOrder":[],"recentsTypeFilter":"all","recentsStatusFilter":"active"},
 "version":1}
```

Because it follows the account, both apps see identical grouping the moment they are logged in.
`LSS-persisted.dframe-group-scopes` in Local Storage is only a **local mirror** of this.

**Why the sidebar nonetheless looks ungrouped: `customGroupAssignments` is `{}`.** The mode is
`custom` and seven groups are defined, but no session is assigned to any of them — server-side,
for both apps. So there is no sync bug to fix here; the assignments simply are not set. They are
made in the UI, and nothing this launcher does can substitute for that.

Two corrections this produced, both recorded because the reasoning was wrong twice:

- The first answer, "grouping is server-side", was reached by grepping for `sgrp_` and finding
  nothing. Right conclusion, wrong evidence — `sgrp_` is the desktop bundle's *notification*
  format and never appears in either profile.
- The second answer, "grouping is local in Local Storage", came from finding
  `dframe-group-scopes` and `cg-` ids there. Wrong: that is a cache of the server store.

The network capture is what settled it, because it shows the authoritative source rather than a
copy of it. `SYNC_CLAUDE_UI_STATE` still exists for replacing this build's UI state deliberately, but it now
defaults to **0** — it cannot help grouping and it does overwrite composer drafts.

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
