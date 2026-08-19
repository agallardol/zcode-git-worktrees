---
description: Detailed status of one git worktree
argument-hint: <name>
---

Show detailed status of a git worktree.

The argument is `$ARGUMENTS` (the worktree name). If it is empty, call `mcp__git-worktrees__worktrees_list` and show the available names, then ask which one (AskUserQuestion with the names as options if there are several).

Call `mcp__git-worktrees__worktrees_status` with `{name}` and present: branch/base, task and agent state, dirty breakdown (staged/unstaged/untracked), unpushed commits, size, last activity, recent commits, diff stat for uncommitted changes, and snapshot list. If unpushed commits exist, remind the user that `/worktree:remove` keeps the branch by default.
