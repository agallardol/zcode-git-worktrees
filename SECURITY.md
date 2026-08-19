# Security Policy

## Trust model

Git Worktrees runs code on your machine in exactly two places, both by design:

1. **The plugin's own scripts** — a Node MCP server and two hook scripts,
   installed from this repository into ZCode's plugin cache. No network calls,
   no telemetry, no dependencies (supply-chain surface: zero npm packages).
2. **Lifecycle commands you opt into** — `setupCommands` / `preRemoveCommands`
   from your repo's `.zcode/worktree.json`. These run **only on worktrees you
   create explicitly** (`/worktree:new`, the MCP tools). Auto-session creates
   never execute repo-provided commands — opening an untrusted repository must
   never be code execution. `preRemoveCommands` likewise run only for
   worktrees whose setup ran.

Everything else is defensive by construction: names are validated for path and
git-ref safety, worktree paths are guarded against symlink traversal, the state
file is written atomically with 0600 permissions, destructive operations always
snapshot first, and the store is protected by a cross-process lock.

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](
https://github.com/agallardol/zcode-git-worktrees/security/advisories/new)
(not a public issue). You should hear back within 72 hours.
