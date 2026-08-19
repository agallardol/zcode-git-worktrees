---
description: Commit a session worktree's work and remove it (end-of-task flow)
argument-hint: [name]
---

End-of-task flow: commit everything in a worktree, then remove it cleanly. Argument: `$ARGUMENTS` = optional worktree name.

**1. Pick the target.** If a name was given, use it. Otherwise call `mcp__git-worktrees__worktrees_list` and prefer the worktree whose `session.id` matches this session or whose `path` matches the current directory; if neither applies and several exist, ask which one.

**2. Commit the work.** Using `git -C <worktree-path>`:
- `git status --porcelain` to see what's there. If there is anything uncommitted (staged, unstaged, or untracked):
  - `git add -A`, then review the diff (`git diff --cached --stat` and skim key files)
  - write a clear, conventional commit message yourself summarizing what was done and why (not a placeholder)
  - `git commit -m "<message>"`
- If nothing to commit, skip straight to step 3.
- Never amend or rewrite existing commits; never push unless the user explicitly asked.

**3. Remove the worktree.** Call `mcp__git-worktrees__worktrees_remove` with `{name}` — after the commit it is clean, so no force is needed. The branch is kept by default (that is the safety net).

**4. Report.** One line each: commit hash + subject (or "nothing to commit"), branch name kept and how to view it (`git log <branch>`), and — if the user asked to push — the exact `git push origin <branch>` command instead of running it. If auto-session mode is on, note the next session gets a fresh worktree.
