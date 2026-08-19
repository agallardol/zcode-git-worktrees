---
description: Check or toggle automatic per-session worktrees (on by default)
argument-hint: on|off
---

Check or toggle auto-session worktree mode. Argument: `$ARGUMENTS` is `on`, `off`, or empty.

1. Call `mcp__git-worktrees__worktrees_auto_session` with `{enabled: true}` (on), `{enabled: false}` (off), or no arguments (status).
2. Report the state in one line, then this short explanation:
   - The mode is **on by default**: every *new* session started in a repository's main checkout gets its own isolated worktree (branch `zcode/sess-…`, based on the current HEAD — no fetch). Resuming a session returns to the same worktree. File edits to the main checkout are blocked and redirected to the session worktree.
   - **Off** (machine-wide): new sessions run normally; existing session worktrees stay until removed.
   - **Per-repo override** beats the machine setting: `.zcode/worktree.json` with `{"autoSession": false}` keeps a repo normal even when the mode is on, and `true` opts a repo in even when it is off.
   - Finishing work in a session worktree: `/worktree:end` (commit + remove).
3. If the argument was empty, just report the status and the escape hatches — do not change anything.

Do not modify the marker file directly — the tool owns it.
