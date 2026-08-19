---
name: worktrees
description: Create and manage git worktrees for parallel, isolated work on one repository — multiple tasks at once without stashing or switching branches, risky experiments, PR review checkouts. Use when the user wants to work on several things at once, isolate a task, mentions worktrees or parallel branches/tasks/agents, or wants to review a PR without changing their checkout.
when_to_use: The user wants parallel or isolated work on a repo: "work on X while I keep Y running", "use a worktree", "isolate this experiment", "review this PR in a separate checkout", "run these 3 tasks in parallel".
license: MIT
---

# Git worktrees for ZCode

Worktrees give every task its own directory + branch sharing one git object store — parallel agents or humans can work on the same repo without stashing, branch switching, or stepping on each other.

**Always use the MCP tools** (`mcp__git-worktrees__*`), never raw `git worktree` commands — the tools add validation, safety checks, snapshots, and state tracking that raw git lacks.

## Tools

| Tool | Use |
|---|---|
| `worktrees_create` `{name?, baseRef?, task?, carryDirty?}` | Create worktree at `<store>/<project>/<name>`, branch `zcode/<name>`, base `fresh` (origin/HEAD) by default |
| `worktrees_list` | All worktrees: branch, dirty, locked, agent, size, activity |
| `worktrees_status` `{name}` | Detail: diff stat, unpushed, snapshots |
| `worktrees_remove` `{name, force?, deleteBranch?}` | Safe removal; snapshots uncommitted work first; branch kept by default |
| `worktrees_cleanup` `{dryRun?, maxAgeDays?, maxCount?}` | Retention sweep (dry-run by default) |
| `worktrees_prune` | Sync git + state after manual deletion |
| `worktrees_snapshot` `{name}` | Snapshot uncommitted work on demand |
| `worktrees_set_task` `{name, task?, agentId?, clearAgent?}` | Link a running agent to its worktree (locks it) |
| `worktrees_auto_session` `{enabled?}` | Get/toggle auto-session mode (each new session in a main checkout gets its own worktree) |

Slash commands `/worktree`, `/worktree:new`, `/worktree:list`, `/worktree:status`, `/worktree:remove`, `/worktree:cleanup`, `/worktree:pr`, `/worktree:end`, `/worktree:auto` drive the same tools with the full UX.

## Auto-session mode (on by default)

Every NEW session started in a repo's main checkout is assigned its own worktree (branch `zcode/sess-<id>`, based on current HEAD). Resuming a session returns to its worktree; edits to the main checkout are blocked (PreToolUse guard) and redirected to the session worktree; `/worktree:end` commits everything and removes the worktree. Since sessions there run with cwd still in the main checkout, agents must use absolute paths into the worktree and `git -C` — the injected SessionStart context explains this. Escape hatches: `/worktree:auto off` (machine-wide) or per-repo `.zcode/worktree.json` `{"autoSession": false}`.

## Core flows

**New isolated task** → `worktrees_create` (optional `task`), then either tell the user to open the returned path in ZCode (File → Open Folder), or spawn a background agent that works inside it (all its commands `cd` there or use `git -C <path>`; register it via `worktrees_set_task` with `agentId`, and `clearAgent: true` when it finishes).

**Safety model** (never bypass, never hand-roll):
- Removal refuses dirty worktrees, running agents, and unmerged-branch deletion unless `force` — and always snapshots uncommitted work to `<store>/snapshots/…` first.
- Branches are kept on removal by default; they are the safety net for commits.
- Cleanup only removes idle, clean, unlocked worktrees beyond age/count limits.

**Repo config** (optional, read from the main checkout): `.worktreeinclude` (gitignore-style patterns; only files that are also gitignored are carried into new worktrees — `.env` etc.) and `.zcode/worktree.json` (`copyFiles`, `setupCommands`, `preRemoveCommands`).

## Working inside a worktree

When a session starts inside a managed worktree, a SessionStart hook injects its context. Rules for any agent working in one: all edits and commands stay inside the worktree; the main checkout is read-only; commit on the worktree's branch; removal/cleanup is the user's call via the tools.

See `references/workflows.md` for orchestration patterns (parallel agents, best-of-N experiments, PR review) and `references/edge-cases.md` for the full edge-case behavior (offline, one-branch-per-worktree, detached HEAD, missing directories, disk space).
