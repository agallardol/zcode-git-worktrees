---
description: Git worktree dashboard — overview of all worktrees for this repository
---

Show the git worktree dashboard for the current repository.

1. Call the `mcp__git-worktrees__worktrees_list` tool (no arguments needed — it operates on the current directory).
2. Render the result as a compact markdown table with columns: **Name**, **Branch**, **Status** (dirty count, locked, agent, MISSING), **Last activity**, **Size**. Highlight the row for the worktree the session is currently inside, if any (compare the session's working directory against each `path`).
3. Below the table, print the store location and free disk space, then these hints:
   - `/worktree:new <name> [task description]` — create a worktree (auto-named if omitted; spawns a background agent when a task is given)
   - `/worktree:status <name>` · `/worktree:remove <name>` · `/worktree:cleanup` · `/worktree:pr <number>`
4. If `worktrees` is empty, say so in one friendly line and suggest `/worktree:new <name>` with a one-sentence explanation of what worktrees are good for (parallel isolated tasks on one repo).

Do not run raw git commands for this — the tool output is complete.
