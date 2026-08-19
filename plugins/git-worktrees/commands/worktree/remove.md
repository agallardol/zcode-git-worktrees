---
description: Safely remove a git worktree (snapshots uncommitted work first)
argument-hint: <name> [--force] [--delete-branch]
---

Remove a git worktree safely. Argument: `$ARGUMENTS` = `<name>` optionally followed by `--force` and/or `--delete-branch`.

1. If no name given: call `mcp__git-worktrees__worktrees_list`, show names, and ask which one.
2. Call `mcp__git-worktrees__worktrees_remove` with `{name}` first (no force). This is the safe attempt.
3. If the tool errors because the worktree is **dirty** or has a **running agent**: use AskUserQuestion with the worktree's actual numbers in the question, offering exactly these choices:
   - "Snapshot & remove" → retry with `{name, force: true}` (a snapshot of uncommitted work is always taken first — say so)
   - "Keep it" → do nothing
   If it errors because the branch has unmerged commits and the user asked for `--delete-branch`: offer "Delete branch anyway" (retry with `force: true`) or "Keep branch" (retry with `deleteBranch: false`).
4. Report the outcome: path removed, reclaimed size, branch action (kept/deleted), and the snapshot directory if one was created (with a one-line note that it can be restored via `git apply <snapshot>/changes.patch`).
5. If `--delete-branch` was passed, include it in the first call as `deleteBranch: true`.

Never run `git worktree remove`, `rm -rf`, or `git branch -D` directly — the tool enforces the safety checks.
