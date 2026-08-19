#!/usr/bin/env node
// PreToolUse guard for auto-session mode: when a session has been assigned a
// worktree, block file-edit tools (Write/Edit/ApplyPatch/NotebookEdit) from
// touching the main checkout — the whole point of the mode is isolation.
// Fails open on every error; does nothing when auto mode is off, when the
// session has no assigned worktree, or for tools it does not police (Bash etc.
// are covered by the injected instructions, not by static analysis).
import { readFile, realpath } from "node:fs/promises";
import { resolve as resolvePath, dirname, basename, join } from "node:path";
import { isAbsolute } from "node:path";
import { StateStore } from "../../mcp/lib/state.mjs";
import * as git from "../../mcp/lib/git.mjs";
import { resolveStoreRoot, readAutoSession } from "../../mcp/lib/store.mjs";

const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "ApplyPatch", "NotebookEdit"]);

function readStdin() {
  return new Promise((resolvePromise) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolvePromise(data));
    process.stdin.on("error", () => resolvePromise(""));
    setTimeout(() => resolvePromise(data), 2000).unref?.();
  });
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      continue: false,
      reason,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    })
  );
}

// Canonicalize even when the target does not exist yet (new files are the
// common Write case): resolve the deepest existing ancestor and rejoin the
// rest, so lexical (/var/…) and canonical (/private/var/…) prefixes compare.
async function canonicalize(p) {
  let cur = p;
  const tail = [];
  for (let hops = 0; hops < 64; hops++) {
    try {
      return join(await realpath(cur), ...tail);
    } catch (err) {
      if (err.code !== "ENOENT") return p;
      tail.unshift(basename(cur));
      const parent = dirname(cur);
      if (parent === cur) return p;
      cur = parent;
    }
  }
  return p;
}

async function main() {
  let input = {};
  try {
    input = JSON.parse((await readStdin()).trim() || "{}");
  } catch {
    return;
  }
  if (!EDIT_TOOLS.has(input.tool_name)) return;
  const toolInput = input.tool_input || {};
  const filePath =
    toolInput.file_path ?? toolInput.notebook_path ?? toolInput.path;
  if (typeof filePath !== "string" || filePath.length === 0) return;

  const root = await resolveStoreRoot();
  const auto = await readAutoSession(root);
  if (!auto.enabled) return;

  const sessionId = typeof input.session_id === "string" ? input.session_id : null;
  if (!sessionId) return;

  const cwdRaw =
    process.env.ZCODE_PROJECT_DIR ||
    process.env.CLAUDE_PROJECT_DIR ||
    process.cwd();
  const cwd = await realpath(cwdRaw).catch(() => cwdRaw);

  let repo;
  try {
    repo = await git.resolveMainRepo(cwd);
  } catch {
    return;
  }
  const mainPath = await realpath(repo.mainPath).catch(() => repo.mainPath);

  const store = new StateStore(root);
  await store.load();
  const proj = store.project(mainPath) || store.project(repo.mainPath);
  if (!proj) return;
  const bound = Object.values(proj.worktrees || {}).find(
    (w) => w.session?.id === sessionId
  );
  if (!bound) return; // session works normally (manual /worktree:new sessions are not policed)

  const abs = resolvePath(cwd, filePath); // handles relative and absolute
  const canonical = await canonicalize(abs);
  const inMain =
    canonical === mainPath || canonical.startsWith(mainPath + "/");
  if (!inMain) return; // writes to the session worktree (or anywhere else) are fine

  return deny(
    `Auto session worktrees: the main checkout (${mainPath}) is read-only for this session. ` +
      `Make this edit inside your session worktree instead: ${bound.path} ` +
      `(branch ${bound.branch ?? "unknown"}). To work directly in the main checkout, disable the mode with /worktree:auto off.`
  );
}

main().catch(() => {
  // fail open — never block a tool because the guard itself errored
});
