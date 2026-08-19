#!/usr/bin/env node
// SessionStart hook: when the session starts inside a managed worktree, inject
// context so the agent knows where it is and what the rules are. Silent (exit 0,
// no output) everywhere else. Never fails the session: all errors are swallowed.
import { readFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(""));
    setTimeout(() => resolve(data), 3000).unref?.();
  });
}

function expandHome(p) {
  if (!p) return p;
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

async function main() {
  await readStdin(); // hook input JSON (unused; cwd comes from env) — drain it

  const root = expandHome(
    process.env.ZCODE_WORKTREE_STORE_ROOT ||
      process.env.ZCODE_WORKTREE_ROOT ||
      join(homedir(), ".zcode", "worktrees")
  );
  const cwdRaw =
    process.env.ZCODE_PROJECT_DIR ||
    process.env.CLAUDE_PROJECT_DIR ||
    process.cwd();
  // Compare canonical paths: git and the store use realpath'd locations, while
  // the session cwd may contain symlinks (e.g. macOS /var → /private/var).
  const cwd = await realpath(cwdRaw).catch(() => cwdRaw);
  const normalized = (p) => (p || "").replace(/\/+$/, "");

  let state;
  try {
    const raw = await readFile(join(root, "state.json"), "utf8");
    state = JSON.parse(raw);
  } catch {
    return; // no store / corrupt → nothing to inject
  }

  let found = null;
  let project = null;
  scan: // eslint-disable-line no-labels
  for (const proj of Object.values(state.projects || {})) {
    for (const entry of Object.values(proj.worktrees || {})) {
      // Compare against both the recorded path and its canonical form (state
      // paths and session cwd may differ by symlinks).
      const candidates = [entry.path, await realpath(entry.path).catch(() => null)];
      for (const raw of candidates) {
        const p = normalized(raw || "");
        if (p && (cwd === p || cwd.startsWith(p + "/"))) {
          found = entry;
          project = proj;
          break scan;
        }
      }
    }
  }
  if (!found) return; // regular session → silent

  const lines = [
    `[git-worktrees] This session is running inside the managed git worktree "${found.name}".`,
    `- Worktree path: ${found.path}`,
    `- Branch: ${found.branch ?? "unknown"} (base: ${found.base ?? "unknown"})`,
  ];
  if (project?.mainPath) {
    lines.push(`- Main checkout (READ-ONLY for this session): ${project.mainPath}`);
  }
  if (found.task) lines.push(`- Task: ${found.task}`);
  if (found.agent) {
    lines.push(`- An agent task was registered at ${found.agent.startedAt}; if it already finished, this session may clear it via the worktrees_set_task tool with clearAgent.`);
  }
  lines.push(
    "",
    "Rules:",
    "1. Make all edits and run all commands inside this worktree. Never modify, commit, or push in the main checkout.",
    "2. Commit work on this worktree's branch.",
    "3. When the task is done, report a summary; removal/cleanup happens through /worktree:remove (uncommitted work is snapshotted first)."
  );

  process.stdout.write(JSON.stringify({ additionalContext: lines.join("\n") }));
}

main().catch(() => {
  // Hooks must never break the session.
});
