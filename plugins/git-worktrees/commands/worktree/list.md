---
description: List git worktrees with branch, dirty state, size and activity
---

List the git worktrees of the current repository.

Call `mcp__git-worktrees__worktrees_list` and render a markdown table: **Name**, **Branch**, **Dirty**, **Locked/Agent**, **Last activity**, **Size**. Include the main checkout row from `project` (branch + dirty count) and note the store root and free space from the result. If a worktree shows `exists: false`, flag it as MISSING and suggest `/worktree:cleanup`.
