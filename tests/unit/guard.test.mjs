// PreToolUse edit guard (auto-session mode): denies file-edit tools targeting
// the main checkout when the session has an assigned worktree; allows
// everything else; fails open.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeRepo, tmpDir, writeRepoFile, git as gitRun } from "../fixtures/helpers.mjs";
import { writeAutoSession } from "../../plugins/git-worktrees/mcp/lib/store.mjs";

const guardPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../plugins/git-worktrees/hooks/scripts/pre-tool-use.mjs"
);

function runGuard(env, payload) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [guardPath], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.end(JSON.stringify(payload));
    setTimeout(() => child.kill(), 45000).unref();
  });
}

async function setupBound({ auto = true } = {}) {
  // auto: true|false writes an explicit marker; null/undefined leaves the default
  const store = tmpDir();
  if (auto === true || auto === false) await writeAutoSession(store, auto);
  const repo = tmpDir();
  makeRepo(repo, { remote: false });
  // create + bind a session worktree through the real Ops path
  const { Ops } = await import("../../plugins/git-worktrees/mcp/lib/ops.mjs");
  const ops = new Ops({ storeRoot: store, defaultBase: "head" });
  const created = await ops.create({
    repoPath: repo,
    name: "sess-abc12345",
    baseRef: "head",
    sessionId: "sess_abc12345-0000-0000-0000-000000000001",
  });
  return {
    store,
    repo,
    worktree: created.path,
    env: {
      ZCODE_WORKTREE_STORE_ROOT: store,
      ZCODE_PROJECT_DIR: repo,
    },
    sessionId: "sess_abc12345-0000-0000-0000-000000000001",
  };
}

test("guard denies Write into the main checkout for a bound session", async () => {
  const s = await setupBound();
  const res = await runGuard(s.env, {
    tool_name: "Write",
    tool_input: { file_path: join(s.repo, "src", "new-file.js"), content: "x" },
    session_id: s.sessionId,
  });
  assert.equal(res.code, 0);
  const decision = JSON.parse(res.out);
  assert.equal(decision.continue, false);
  assert.equal(decision.hookSpecificOutput.permissionDecision, "deny");
  assert.match(decision.reason, /read-only/);
  assert.match(decision.reason, /sess-abc12345/);
});

test("guard denies relative paths resolved against the session cwd", async () => {
  const s = await setupBound();
  const res = await runGuard(s.env, {
    tool_name: "Edit",
    tool_input: { file_path: "README.md", old_string: "a", new_string: "b" },
    session_id: s.sessionId,
  });
  const decision = JSON.parse(res.out);
  assert.equal(decision.continue, false);
});

test("guard allows writes inside the session worktree and elsewhere", async () => {
  const s = await setupBound();
  const inWorktree = await runGuard(s.env, {
    tool_name: "Write",
    tool_input: { file_path: join(s.worktree, "src", "ok.js"), content: "x" },
    session_id: s.sessionId,
  });
  assert.equal(inWorktree.out, "", "worktree write allowed (no output)");

  const elsewhere = await runGuard(s.env, {
    tool_name: "Write",
    tool_input: { file_path: join(tmpDir(), "unrelated.txt"), content: "x" },
    session_id: s.sessionId,
  });
  assert.equal(elsewhere.out, "", "write outside the repo allowed");
});

test("guard allows everything when auto mode is off", async () => {
  const s = await setupBound({ auto: false });
  const res = await runGuard(s.env, {
    tool_name: "Write",
    tool_input: { file_path: join(s.repo, "README.md"), content: "x" },
    session_id: s.sessionId,
  });
  assert.equal(res.out, "");
});

test("guard ignores unbound sessions and non-edit tools", async () => {
  const s = await setupBound();
  const unbound = await runGuard(s.env, {
    tool_name: "Write",
    tool_input: { file_path: join(s.repo, "README.md"), content: "x" },
    session_id: "sess_someOTHERsession-0000",
  });
  assert.equal(unbound.out, "", "unbound session allowed");

  const bash = await runGuard(s.env, {
    tool_name: "Bash",
    tool_input: { command: "echo hi" },
    session_id: s.sessionId,
  });
  assert.equal(bash.out, "", "Bash not policed");

  const read = await runGuard(s.env, {
    tool_name: "Read",
    tool_input: { file_path: join(s.repo, "README.md") },
    session_id: s.sessionId,
  });
  assert.equal(read.out, "", "Read always allowed");
});

test("guard fails open on missing/invalid input", async () => {
  const s = await setupBound();
  const noInput = await runGuard(s.env, "garbage{");
  assert.equal(noInput.code, 0);
  assert.equal(noInput.out, "");
  const noPath = await runGuard(s.env, { tool_name: "Write", tool_input: {} });
  assert.equal(noPath.out, "");
});

test("guard: dirty-session integration — deny decision names the redirect target", async () => {
  const s = await setupBound();
  writeRepoFile(s.worktree, "wip.txt", "work\n");
  const res = await runGuard(s.env, {
    tool_name: "ApplyPatch",
    tool_input: { file_path: join(s.repo, "wip.txt") },
    session_id: s.sessionId,
  });
  const decision = JSON.parse(res.out);
  assert.match(decision.reason, new RegExp(s.worktree.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("guard honors per-repo override off (machine default on)", async () => {
  const s = await setupBound({ auto: null }); // no marker → default ON
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(join(s.repo, ".zcode"), { recursive: true });
  await writeFile(join(s.repo, ".zcode", "worktree.json"), JSON.stringify({ autoSession: false }));
  const res = await runGuard(s.env, {
    tool_name: "Write",
    tool_input: { file_path: join(s.repo, "README.md"), content: "x" },
    session_id: s.sessionId,
  });
  assert.equal(res.out, "", "repo override off → guard inactive");
});

test("guard active with machine default (no marker) for bound session", async () => {
  const s = await setupBound({ auto: null }); // default ON
  const res = await runGuard(s.env, {
    tool_name: "Write",
    tool_input: { file_path: join(s.repo, "README.md"), content: "x" },
    session_id: s.sessionId,
  });
  const decision = JSON.parse(res.out);
  assert.equal(decision.continue, false, "default-on polices bound sessions");
});
