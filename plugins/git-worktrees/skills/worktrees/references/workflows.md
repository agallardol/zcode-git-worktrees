# Worktree orchestration patterns

## One task, one worktree, one background agent

```
/worktree:new fix-auth "Refactor the login flow to use the new session API"
```

The command creates the worktree (locked, task recorded) and spawns a background agent that works entirely inside it. The main session stays free; when the agent finishes, its summary is relayed and the lock is cleared. Repeat for as many parallel tasks as needed — each is a separate directory + branch, so agents never conflict.

## Best-of-N experiment (Cursor-style tournament)

Create N worktrees, one per approach/model prompt, give each the same task, then compare `worktrees_status` output (diff stats, commits) and keep the winner:

1. `worktrees_create` ×N with distinct names (`exp-a`, `exp-b`, …)
2. Spawn one background agent per worktree with the same task
3. When all finish, compare, then `worktrees_remove` the losers (branches kept by default — nothing is lost)

## PR review checkout

`/worktree:pr 1234` (or call `worktrees_create` with `baseRef` = the commit from `git fetch origin pull/1234/head`). Review, commit fixes, push the branch, then remove the worktree.

## Risky refactor / migration

`worktrees_create` + `carryDirty: true` when the user has uncommitted local changes they want carried into the experiment. Snapshot first (`worktrees_snapshot`) if the changes are precious.

## Housekeeping rhythm

- `/worktree` — glance at everything (sizes, activity, agents)
- `/worktree:cleanup` — dry-run, review, apply (reclaims disk)
- `/worktree:pr` — after deleting worktree directories manually
