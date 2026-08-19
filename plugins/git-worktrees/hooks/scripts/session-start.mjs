#!/usr/bin/env node
// SessionStart hook. Two jobs, both best-effort (a hook must never break a
// session):
//
// 1. If the session starts INSIDE a managed worktree → inject its context
//    (name, task, rules, read-only main checkout).
// 2. If auto-session mode is enabled and the session starts in a repo's main
//    checkout → assign that session its own worktree (bound by session id, so
//    resumes return to it) and inject usage instructions.
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { StateStore } from "../../mcp/lib/state.mjs";
import { Ops } from "../../mcp/lib/ops.mjs";
import * as git from "../../mcp/lib/git.mjs";
import { resolveStoreRoot, readAutoSession } from "../../mcp/lib/store.mjs";

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

function emitContext(lines) {
  process.stdout.write(JSON.stringify({ additionalContext: lines.join("\n") }));
}

async function main() {
  const raw = await readStdin();
  let input = {};
  try {
    input = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    input = {};
  }
  const sessionId = typeof input.session_id === "string" ? input.session_id : null;

  const cwdRaw =
    process.env.ZCODE_PROJECT_DIR ||
    process.env.CLAUDE_PROJECT_DIR ||
    process.cwd();
  const cwd = await realpath(cwdRaw).catch(() => cwdRaw);

  const root = await resolveStoreRoot();
  const store = new StateStore(root);
  await store.load();

  // 1) session opened inside a managed worktree
  let found = null;
  let project = null;
  scan: // eslint-disable-line no-labels
  for (const proj of Object.values(store.state.projects || {})) {
    for (const entry of Object.values(proj.worktrees || {})) {
      const candidates = [entry.path, await realpath(entry.path).catch(() => null)];
      for (const rawPath of candidates) {
        const p = (rawPath || "").replace(/\/+$/, "");
        if (p && (cwd === p || cwd.startsWith(p + "/"))) {
          found = entry;
          project = proj;
          break scan;
        }
      }
    }
  }
  if (found) {
    const lines = [
      `[git-worktrees] This session is running inside the managed git worktree "${found.name}".`,
      `- Worktree path: ${found.path}`,
      `- Branch: ${found.branch ?? "unknown"} (base: ${found.base ?? "unknown"})`,
    ];
    if (project?.mainPath) lines.push(`- Main checkout (READ-ONLY for this session): ${project.mainPath}`);
    if (found.task) lines.push(`- Task: ${found.task}`);
    if (found.agent) {
      lines.push(
        `- An agent task was registered at ${found.agent.startedAt}; if it already finished, clear it via the worktrees_set_task tool with clearAgent.`
      );
    }
    lines.push(
      "",
      "Rules:",
      "1. Make all edits and run all commands inside this worktree. Never modify, commit, or push in the main checkout.",
      "2. Commit work on this worktree's branch.",
      "3. When the task is done, report a summary; removal/cleanup happens through /worktree:remove (uncommitted work is snapshotted first)."
    );
    return emitContext(lines);
  }

  // 2) auto-session mode: assign a worktree to a fresh session in a main checkout
  const auto = await readAutoSession(root);
  if (!auto.enabled) return;
  if (!sessionId) return;

  let repo;
  try {
    repo = await git.resolveMainRepo(cwd);
  } catch {
    return; // not a git repository → normal session
  }
  const mainPath = await realpath(repo.mainPath).catch(() => repo.mainPath);

  const proj = store.project(mainPath);
  const bound = proj
    ? Object.values(proj.worktrees || {}).find((w) => w.session?.id === sessionId)
    : null;

  if (bound) {
    try {
      await realpath(bound.path);
      return emitContext([
        `[git-worktrees] Auto session worktrees are enabled; this session already has its worktree.`,
        `- Worktree path: ${bound.path}`,
        `- Branch: ${bound.branch ?? "unknown"}`,
        `- Do all work there: absolute paths for file tools, \`git -C "${bound.path}"\` or \`cd\` for commands.`,
        `- The main checkout at ${mainPath} is READ-ONLY for file edits in this mode.`,
        `- Finish with /worktree:end (commit + remove) or /worktree:remove ${bound.name}.`,
      ]);
    } catch {
      /* bound worktree vanished → create a replacement below */
    }
  }

  const ops = new Ops({ storeRoot: root, defaultBase: "head" });
  const suffix = sessionId
    .replace(/^sess_/, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase()
    .slice(0, 8);
  const baseName = `sess-${suffix || Date.now().toString(36).slice(0, 6)}`;

  let created = null;
  let lastError = null;
  for (const name of [baseName, `${baseName}-2`]) {
    try {
      created = await ops.create({
        repoPath: cwd,
        name,
        baseRef: "head", // start where the user is; no network fetch at session start
        sessionId,
      });
      break;
    } catch (err) {
      lastError = err;
      if (!/already exists/i.test(String(err?.message || ""))) break;
    }
  }

  if (!created) {
    return emitContext([
      `[git-worktrees] Auto session worktrees are enabled but assigning one failed: ${String(lastError?.message || lastError).slice(0, 200)}`,
      `Continue working normally, or create one manually with /worktree:new <name>. Disable with /worktree:auto off.`,
    ]);
  }

  return emitContext([
    `[git-worktrees] Auto session worktrees are enabled — this session has been assigned its own isolated git worktree.`,
    `- Worktree path: ${created.path}`,
    `- Branch: ${created.branch} (based on the main checkout's current HEAD)`,
    ``,
    `How to work now:`,
    `1. Use ABSOLUTE paths under ${created.path} for all file reads/edits/writes.`,
    `2. Run commands with \`git -C "${created.path}"\` or \`cd "${created.path}"\` first.`,
    `3. Commit your work on ${created.branch} as you go.`,
    `4. The main checkout at ${mainPath} is READ-ONLY for file edits in this mode (enforced) — including commands: never modify, commit, or push there.`,
    `5. When the task is done: /worktree:end commits everything and removes the worktree (branch is kept). /worktree:auto off disables this mode.`,
  ]);
}

main().catch(() => {
  // Hooks must never break the session.
});
