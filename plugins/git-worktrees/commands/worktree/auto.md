---
description: Toggle automatic per-session worktrees
argument-hint: on|off
---

Toggle or check auto-session worktree mode. Argument: `$ARGUMENTS` is `on`, `off`, or empty.

1. Call `mcp__git-worktrees__worktrees_auto_session` with `{enabled: true}` (on), `{enabled: false}` (off), or no arguments (status).
2. Report the new state in one line, then this short explanation:
   - **On**: every *new* session started in a repository's main checkout gets its own isolated worktree (branch `zcode/sess-…`, based on the current HEAD — no fetch). Resuming a session returns to the same worktree. File edits to the main checkout are blocked in favor of the session worktree. Current sessions are unaffected.
   - **Off**: sessions run normally in the main checkout; existing session worktrees stay until removed.
   - Finishing work in a session worktree: `/worktree:end` (commit + remove).
3. If the argument was empty and the mode is off, ask (AskUserQuestion) whether to enable it; if on, ask whether to disable.

Do not modify the marker file directly — the tool owns it.
