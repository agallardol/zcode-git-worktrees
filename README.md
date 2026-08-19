# git-worktrees — Git Worktree Support for ZCode

A ZCode plugin that brings Claude Code / Codex-grade git worktree support to ZCode:
create isolated checkouts for parallel tasks, carry gitignored files (`.env`) into
them, run background agents inside them, and remove them safely with snapshots —
never silently losing work.

```
/worktree                       → dashboard (branches, dirty state, sizes, agents)
/worktree:new [name] [task…]    → create (+ optional background agent on it)
/worktree:list · /worktree:status <name>
/worktree:remove <name> [--force] [--delete-branch]
/worktree:cleanup [--apply]     → retention sweep (dry-run first)
/worktree:pr <number|url>       → check out a GitHub PR into a worktree
```

## Architecture

```
plugins/git-worktrees/
├── .zcode-plugin/plugin.json     # manifest: commands, skill, hook, MCP server, userConfig
├── commands/                     # 7 slash commands driving the MCP tools
├── skills/worktrees/             # model-facing skill (when/how to use worktrees)
├── hooks/scripts/session-start.mjs   # injects worktree context when a session starts inside one
└── mcp/
    ├── server.mjs                # zero-dependency MCP stdio server (JSON-RPC 2.0)
    └── lib/
        ├── ops.mjs               # high-level operations (create/list/status/remove/cleanup/…)
        ├── git.mjs               # execFile-only git plumbing (never a shell)
        ├── state.mjs             # self-healing registry at <store>/state.json
        ├── safety.mjs            # name validation, symlink guards, disk-space checks
        ├── carryover.mjs         # .worktreeinclude + copyFiles (only gitignored files carried)
        ├── snapshot.mjs          # diff + untracked capture before destructive ops
        ├── lock.mjs              # in-process + cross-process store lock (mkdir lockfile)
        └── names.mjs             # friendly auto-names (adjective-animal)
```

**Store layout** (central, repos stay pristine):

```
~/.zcode/worktrees/
├── state.json                 # registry (0600, atomic writes, self-healing)
├── <project-slug>/<name>/     # one worktree per task, branch zcode/<name>
├── snapshots/<project>/<name>-<timestamp>/   # changes.patch + untracked/**
└── .lock/                     # cross-process mutation lock
```

## MCP tools

| Tool | Purpose |
|---|---|
| `worktrees_create` `{name?, baseRef?, task?, carryDirty?}` | Base `fresh` (origin/HEAD, offline → local HEAD + warning), `head`, or explicit ref. Carries `.worktreeinclude` files (only if gitignored — tracked files are never duplicated), runs `setupCommands`, optionally copies uncommitted changes. Locks while a task/agent runs. |
| `worktrees_list` / `worktrees_status` | Branch, dirty breakdown, ahead/behind, unpushed, size, activity (state + git HEAD mtime), snapshots, agent |
| `worktrees_remove` `{name, force?, deleteBranch?}` | Refuses dirty / agent-active / unmerged-branch deletion without `force`; always snapshots first; branch kept by default |
| `worktrees_cleanup` `{dryRun?, maxAgeDays?, maxCount?}` | Never touches dirty/locked/agent-active worktrees; dry-run by default |
| `worktrees_prune` | Reconciles git + state after out-of-band deletion |
| `worktrees_snapshot` `{name}` | On-demand capture of uncommitted work |
| `worktrees_set_task` `{name, task?, agentId?, clearAgent?}` | Links background agents to worktrees (locks/unlocks) |

## Safety model

- **Never silent loss**: dirty removal requires `force` and always snapshots
  (tracked diff → `changes.patch`, untracked → `untracked/**`); branches are kept
  by default; unmerged branches are never deleted without `force`.
- **Never escapes the store**: names validated (path-safe + git-ref-safe, no
  traversal/case-twin/unicode tricks), full worktree path guarded against
  symlinks, store paths canonicalized; failed `worktree add` rolls back its branch.
- **Concurrency-safe**: all mutations serialized by an in-process queue plus a
  cross-process mkdir lockfile with stale-lock breaking.
- **Self-healing state**: corrupt `state.json` quarantined + rebuilt; worktrees
  re-adopted by scanning git; dead projects dropped; manual deletions reconciled
  by `prune`/`cleanup`.

## Repo-side configuration (optional)

`.worktreeinclude` (gitignore-style patterns — only files that are *also*
gitignored are carried into new worktrees) and `.zcode/worktree.json`:

```json
{
  "copyFiles": [".env.local"],
  "setupCommands": ["pnpm install"],
  "preRemoveCommands": ["docker compose down"]
}
```

Plugin settings (Settings → Plugins → Git Worktrees): worktree root, default
base, max age days (14), max worktrees per project (15).

## Install / update / uninstall

Installed from the local marketplace in this repo (registered via the ZCode
Protocol `plugins/marketplace/add`):

```sh
HELPER="/Applications/ZCode.app/Contents/Frameworks/ZCode Helper.app/Contents/MacOS/ZCode Helper"
ENGINE="/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs"

# add marketplace + install (or use the desktop UI: Settings → Plugins → +)
echo '{"id":1,"method":"plugins/marketplace/add","params":{"source":"'"$PWD"'","workspace":{"workspacePath":"'"$PWD"'","workspaceKey":"'"$PWD"'"}}}' \
  | ELECTRON_RUN_AS_NODE=1 "$HELPER" "$ENGINE" app-server
echo '{"id":1,"method":"plugins/install","params":{"pluginName":"git-worktrees","marketplace":"zcode-local","workspace":{"workspacePath":"'"$PWD"'","workspaceKey":"'"$PWD"'"}}}' \
  | ELECTRON_RUN_AS_NODE=1 "$HELPER" "$ENGINE" app-server
```

The app **copies** the plugin into `~/.zcode/cli/plugins/cache/zcode-local/…` at
install time — after editing the plugin here, re-run `plugins/marketplace/update`
(method `plugins/marketplace/update`) or reinstall to sync the cache.
Uninstall: `plugins/uninstall` or disable with `/plugins disable git-worktrees@zcode-local`.

## Tests

```sh
npm test                 # 91 tests total
npm run test:unit        # 52 — validators, state, carry-over, snapshots, git ops, hook
npm run test:integration #  9 — MCP server over real stdio JSON-RPC + protocol edge cases
npm run test:adversarial # 30 — hostile names, races, corrupt state, out-of-band damage
```

Adversarial highlights: 8 parallel creates across separate processes (no lost
updates), parallel removes (exactly one wins), symlink redirection attempts,
corrupted-then-rebuilt state, manually deleted directories, case-insensitive
collisions, unborn/detached/bare repos, unreachable remotes, preRemove
failures, and removal refusals for dirty/agent-active/main-checkout targets.

Verified end-to-end in live headless ZCode sessions (GLM): create + list +
`.worktreeinclude` carry-over, SessionStart context injection inside a worktree,
and forced dirty removal with snapshot + branch retention.

## Requirements

- ZCode ≥ 3.8.1 (plugin system with MCP servers + hooks)
- `node` ≥ 18 on PATH (the MCP server is launched with `node`)
- `git` ≥ 2.28 (`git init -b` used by fixtures; plugin itself needs standard worktree support)
