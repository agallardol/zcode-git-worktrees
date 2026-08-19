---
description: Create a new git worktree, optionally spawning a background agent task on it
argument-hint: [name] [task description...]
---

Create a new git worktree for this repository, and optionally start a background agent task on it.

Parse `$ARGUMENTS`:
- If empty: create with an auto-generated friendly name.
- If the first word looks like a name (letters/digits/dots/dashes/underscores, no spaces): use it as the name and treat the remaining words as the task description.
- Otherwise: treat all of `$ARGUMENTS` as the task description and let the name auto-generate.

**Step 1 — create.** Call `mcp__git-worktrees__worktrees_create` with `{name?, task?}` (omit `name` when auto-generating). Do not pass `baseRef` or `carryDirty` unless the user explicitly asked for them. If the tool returns `isError`, show its message and stop — do not fall back to raw git commands.

**Step 2 — report.** Show a compact panel:
- name, branch, base (short commit), worktree path on its own line (make it easy to copy)
- files carried over (if any), setup command results (if any), warnings (if any)
- the line: `Open in ZCode: File → Open Folder → <path>`

**Step 3 — background agent (only if a task description was given).** Spawn a background agent with the Agent tool (`subagent_type: "general-purpose"`, `run_in_background: true`) using exactly this prompt template (replace the bracketed values, keep the rules):

---
You are working on an isolated git worktree.

- Worktree path: <path> (branch <branch>)
- Main checkout (READ-ONLY for you): <main repo path>
- Task: <task description>

Rules:
1. Do ALL work inside the worktree: run every command with `git -C "<path>"` or `cd "<path>"` first. Never modify, commit, or push in the main checkout.
2. Make frequent small commits on the worktree's branch as you complete steps.
3. Do not push or open pull requests unless the task explicitly says so.
4. When finished, output a short summary: what changed (files + commits), anything left to do, and how to verify.
---

**Step 4 — register the agent.** Call `mcp__git-worktrees__worktrees_set_task` with `{name, agentId: <id from the Agent result>, task: <task>}` so status and cleanup know an agent is active. Then tell the user, in one line each: the agent is running in the background on that worktree; they can keep working here; they'll be notified when it finishes; `/worktree` shows live status.

When the background agent later completes and you are resumed: call `worktrees_set_task` with `{name, clearAgent: true}`, then relay the agent's summary and suggest `/worktree:status <name>` and next steps (open the worktree, or `/worktree:remove <name>` when done).
