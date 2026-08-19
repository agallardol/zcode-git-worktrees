---
description: Check out a GitHub pull request into a new worktree
argument-hint: <pr-number | pr-url>
---

Check out a GitHub pull request into an isolated worktree for review or continued work. Argument: `$ARGUMENTS` = PR number or URL (strip the number from a URL). Quote `#` in shells.

1. If no argument: ask for the PR number.
2. Verify `gh` is available (`command -v gh`). If it is, optionally enrich the panel with `gh pr view <n> --json title,author,headRefName,baseRefName` (best-effort — skip silently on failure). Do not require `gh`.
3. Fetch the PR head ref: run `git fetch origin pull/<n>/head` (this works for both same-repo and fork PRs on GitHub). If it fails, show the error and stop.
4. Resolve the fetched commit: `git rev-parse FETCH_HEAD`.
5. Call `mcp__git-worktrees__worktrees_create` with `{name: "pr-<n>", baseRef: <FETCH_HEAD commit>}`. If that name already exists, show the existing worktree path instead of creating a duplicate.
6. Report: PR number/title (if known), worktree path, branch `zcode/pr-<n>`, and `Open in ZCode: File → Open Folder → <path>`. Mention `/worktree:remove pr-<n>` when done reviewing.
