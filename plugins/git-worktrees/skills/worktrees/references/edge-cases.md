# Edge-case behavior (authoritative)

All of this is enforced by the tools — do not reimplement it with raw git.

## Creation
- **Not a git repo / no commits**: clear error; commit something first.
- **Base `fresh` offline or no origin**: falls back to local HEAD with a warning in the result.
- **Name collisions**: existing branch, existing worktree, or case-insensitive filesystem twin (Foo vs foo) → precise error with the next best action.
- **One-branch-per-worktree**: if `zcode/<name>` is checked out elsewhere, the error explains the git rule and suggests a different name.
- **Disk space**: refuses below 500 MiB free; warns when the checkout likely won't fit.
- **Symlinked store paths**: refused (no worktree ever lands outside the real store).
- **`carryDirty` conflicts**: patch applies with `--3way`; on conflict the changes remain in the source checkout and a warning is returned.
- **Setup command failure**: worktree is kept; failure and output tail are surfaced.

## Removal & cleanup
- Dirty worktree, running agent, foreign lock, or unmerged branch deletion → refused without `force`; `force` still snapshots first (tracked diff + untracked files under `<store>/snapshots/<project>/<name>-<timestamp>/`, restorable with `git apply`).
- Main checkout can never be removed through the tools.
- `preRemoveCommands` failure aborts removal (unless `force`).
- Cleanup skips dirty/locked/agent-active worktrees unconditionally; branches kept.

## State resilience
- `state.json` corrupted → quarantined as `state.json.corrupt-<ts>`, rebuilt.
- Worktree directories deleted out-of-band → flagged MISSING by list; `worktrees_prune` / `cleanup` reconcile git + state.
- Worktrees under the store that predate state (created manually) are adopted automatically.
- Projects whose main repo disappeared are dropped from state.

## Sessions
- Sessions are bound to directories, not branches: opening a worktree as a ZCode project is the way to work inside it interactively; background agents work in it via `cd`/`git -C`.
- The SessionStart hook injects worktree context (name, task, read-only main checkout rule) when a session starts inside a managed worktree; it is silent elsewhere.
