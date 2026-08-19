---
description: Retention sweep — remove idle worktrees, prune stale metadata
argument-hint: [--apply]
---

Run the worktree retention sweep for this repository.

1. Call `mcp__git-worktrees__worktrees_cleanup` with `{dryRun: true}` (always, even if `--apply` was passed — show the plan first).
2. Present the dry-run plan: worktrees that would be removed (name, size, last activity), worktrees skipped with reasons, and reclaimable space. Note that dirty, locked, or agent-active worktrees are never touched.
3. If nothing is eligible, say so and stop.
4. If `--apply` was in `$ARGUMENTS`, apply immediately: call again with `{dryRun: false}` and report the result. Otherwise ask the user (AskUserQuestion): "Apply cleanup and reclaim ~X?" → yes → call with `{dryRun: false}`; no → stop.
5. Report reclaimed space and any snapshot directories created.
