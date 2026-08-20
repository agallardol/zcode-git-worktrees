# Git Worktrees for ZCode

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-130%20passing-brightgreen.svg)](#tests)
![ZCode](https://img.shields.io/badge/ZCode-%E2%89%A5%203.8.1-6E56CF.svg)

Every thread gets its own worktree — **automatically**. Git Worktrees gives
each new [ZCode](https://z.ai) thread an isolated checkout of your repo, so
tasks run in parallel without stashing, branch juggling, or overwriting each
other. Start chatting; you are already isolated.

```
/worktree:new fix-auth "Refactor the login flow"   ← worktree + background agent
/worktree                                          ← dashboard: branches, sizes, agents
/worktree:end fix-auth                             ← commit everything, remove cleanly
```

**Why you'll want it**

- **Zero setup.** Auto-session mode (on by default) hands every new thread its
  own worktree the moment it starts — and resuming a thread returns to the
  same one. No commands needed, ever.
- **Never lose work.** Removal of dirty worktrees, running agents, or unmerged
  branches is refused without `force` — and even then, uncommitted changes are
  snapshotted first (tracked diff + untracked files) to a restorable directory.
  Branches are kept by default.
- **Your environment travels with you.** `.env` and friends (anything
  gitignored and listed in `.worktreeinclude`) are carried into new worktrees;
  `setupCommands` (`pnpm install`, `docker compose up -d`) run automatically.
- **It stays out of your way.** Worktrees live in a central store
  (`~/.zcode/worktrees`), your repos stay pristine, and a retention sweep
  keeps disk usage bounded. Nothing is ever deleted silently.

## Install

1. In ZCode Desktop, open **Settings → Plugin Management** and click **Add marketplace**.
2. Paste the repo — a GitHub `owner/repo` slug or a full Git URL both work:

   ```
   agallardol/zcode-git-worktrees
   ```

3. Install **Git Worktrees** from the catalog.
4. Open any git repo and start a thread — you're already isolated. Type `/worktree` for the dashboard.

**Requirements**: ZCode ≥ 3.8.1, `node` ≥ 18 on PATH, `git`.

**If `/worktree` doesn't appear**: run `node --version` in a terminal (the MCP
server needs `node`), confirm the plugin is enabled under Installed, and restart
ZCode if you installed it while the app was open.

## The commands

| Command | What it does |
|---|---|
| `/worktree` | Dashboard — branch, dirty state, size, activity, running agents |
| `/worktree:new [name] [task…]` | Create a worktree (friendly auto-name if omitted); with a task, spawns a **background agent** that works inside it |
| `/worktree:status <name>` | Diff stat, unpushed commits, snapshots |
| `/worktree:remove <name>` | Safe removal — snapshots uncommitted work first |
| `/worktree:cleanup` | Retention sweep (dry-run first; skips anything dirty/locked/active) |
| `/worktree:pr <number\|url>` | Check out a GitHub PR into a review worktree |
| `/worktree:end [name]` | End-of-task: commit everything with a real message, remove, keep branch |
| `/worktree:auto` | Per-session automatic worktrees — see below |

Behind them: nine MCP tools (`worktrees_create`, `worktrees_list`,
`worktrees_status`, `worktrees_remove`, `worktrees_cleanup`, `worktrees_prune`,
`worktrees_snapshot`, `worktrees_set_task`, `worktrees_auto_session`), a
model-facing skill, and hooks — so the agent can use worktrees on its own when
you ask for parallel or isolated work.

## Auto-session worktrees (on by default)

Every new session in a repo's main checkout gets its own worktree
(`zcode/sess-…`); resuming returns to the same one, and file edits to the main
checkout are blocked and redirected to the session worktree. Toggle it in
**Settings → Plugins → Git Worktrees** or with `/worktree:auto` (most recent
change wins). A repo can always opt out:

```json
// .zcode/worktree.json in the repo
{ "autoSession": false }
```

## Repo-side configuration (optional)

`.worktreeinclude` — gitignore-style patterns; only files that are *also*
gitignored are carried into new worktrees (tracked files are never duplicated):

```
.env
config/secrets.json
```

`.zcode/worktree.json` — explicit files, lifecycle hooks, and the auto-session
override:

```json
{
  "autoSession": true,
  "copyFiles": [".env.local"],
  "setupCommands": ["pnpm install"],
  "preRemoveCommands": ["docker compose down"]
}
```

Plugin settings (Settings → Plugins → Git Worktrees): worktree root, default
base (`fresh` = origin/HEAD with offline fallback, or `head`), max age days
(14), max worktrees per project (15).

## Safety model

- **Nothing escapes the store** — names validated for path and git-ref safety
  (traversal, `.lock`, case-twin, unicode tricks all rejected), full paths
  guarded against symlinks, store paths canonicalized; a failed
  `git worktree add` rolls back its branch.
- **Concurrency-safe** — mutations serialized by an in-process queue plus a
  cross-process lockfile; parallel creates never lose state.
- **Self-healing** — corrupt state quarantined and rebuilt, worktrees re-adopted
  from git, out-of-band deletions reconciled by `prune`/`cleanup`.
- **No execution from untrusted repos** — `setupCommands` / `preRemoveCommands`
  run **only on worktrees you create explicitly**. Auto-session creates never
  execute repo-provided commands: opening a cloned repo is never code
  execution. Every git call goes through `execFile`; the only shell execution
  is lifecycle commands you opted into.

Compared to the tools that inspired it: PR-number checkouts and
`.worktreeinclude` semantics come from Claude Code, snapshot-before-delete and
the central store from Codex, bounded retention from Cursor/Codex — plus
background-agent task orchestration and hard edit isolation, which none of
them expose to plugins.

## Tests

```sh
npm test   # 130 tests: 81 unit (validators, state, carry-over, hooks, edit guard)
           #        + 13 integration (real MCP stdio JSON-RPC + protocol edges)
           #        + 36 adversarial & security (hostile names, races, corrupt
           #           state, out-of-band damage, exploit regressions)

CI runs the suite on macOS and Linux (Node 20 and 22).
```

The suites run entirely against local fixtures — no network, no model calls.

## Notes & limitations

- Auto-session isolation is *soft for commands, hard for edits*: Write/Edit
  tools are blocked against the main checkout by a PreToolUse guard; Bash is
  guided by injected context, not statically policed.
- ZCode has no session-end event, so nothing is auto-committed or deleted at
  exit — `/worktree:end` is the explicit finish line, and the retention sweep
  collects what's left idle.
- One-session lag on Settings changes for auto-session (hooks read a marker the
  MCP server syncs at session start).

## License

[MIT](LICENSE) © Alfredo Gallardo
