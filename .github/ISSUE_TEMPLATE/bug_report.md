---
name: Bug report
about: Something broke or behaved unsafely
labels: bug
---

**What happened** — command/tool, expected vs actual:

**Worktree state at the time** (output of `/worktree` or `worktrees_list`):

**Environment** — ZCode version, OS, `node --version`, `git --version`:

**Logs that help** — `~/.zcode/cli/log/zcode-<date>.jsonl` entries mentioning
`hook.run` or `git-worktrees` (redact paths you care about):

- Did you lose any work? (If yes, say so loudly — snapshots may exist under
  `~/.zcode/worktrees/snapshots/`.)
