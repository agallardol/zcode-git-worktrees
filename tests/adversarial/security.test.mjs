// Security regressions: the trust boundary between repo-provided config and
// automatic execution.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, rm, mkdir, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Ops } from "../../plugins/git-worktrees/mcp/lib/ops.mjs";
import { makeRepo, tmpDir, writeRepoFile, git as gitRun } from "../fixtures/helpers.mjs";

const hookPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../plugins/git-worktrees/hooks/scripts/session-start.mjs"
);

function runHook(env, stdin) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [hookPath], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
    child.stdin.end(stdin);
    setTimeout(() => child.kill(), 60000).unref();
  });
}

// The original exploit: opening a repo whose .zcode/worktree.json carries
// malicious setupCommands must NOT execute them (auto-session creates never
// run lifecycle commands).
test("security: auto-session create does NOT execute repo setupCommands (exploit regression)", async () => {
  const store = tmpDir();
  const marker = join(tmpDir(), "pwned-marker"); // marker outside both repo and store
  const repo = tmpDir();
  makeRepo(repo, { remote: false });
  await mkdir(join(repo, ".zcode"), { recursive: true });
  await writeFile(
    join(repo, ".zcode", "worktree.json"),
    JSON.stringify({ setupCommands: [`touch ${marker}`] })
  );

  const sid = "sess_pwnregres-0000-0000-0000-00000000beef";
  const res = await runHook(
    {
      ZCODE_WORKTREE_STORE_ROOT: store,
      ZCODE_PROJECT_DIR: repo,
      ZCODE_WORKTREES_SYNC_AUTO: "1", // deterministic immediate create
    },
    JSON.stringify({ session_id: sid, source: "startup" })
  );
  assert.equal(res.code, 0);
  assert.match(res.out, /being prepared right now/);
  assert.equal(
    existsSync(marker),
    false,
    "setupCommands from the repo MUST NOT run on auto-session create"
  );

  // worktree itself was created; entry records that lifecycle commands were skipped
  const repoName = (await realpath(repo)).split("/").pop();
  const state = JSON.parse(await readFile(join(store, "state.json"), "utf8"));
  const entry = Object.values(Object.values(state.projects)[0].worktrees)[0];
  assert.equal(entry.lifecycleCommandsRan, false);
});

test("security: remove of an auto-origin worktree skips preRemoveCommands", async () => {
  const store = tmpDir();
  const marker = join(tmpDir(), "preremove-marker");
  const repo = tmpDir();
  makeRepo(repo, { remote: false });
  await mkdir(join(repo, ".zcode"), { recursive: true });
  await writeFile(
    join(repo, ".zcode", "worktree.json"),
    JSON.stringify({ preRemoveCommands: [`touch ${marker}`] })
  );

  const ops = new Ops({ storeRoot: store });
  await ops.create({
    repoPath: repo,
    name: "sess-autox1",
    baseRef: "head",
    sessionId: "sess_autox1-0000",
    skipLifecycleCommands: true,
  });
  await ops.remove({ repoPath: repo, name: "sess-autox1" });
  assert.equal(existsSync(marker), false, "preRemoveCommands skipped for auto-origin worktrees");

  // …but they still run for explicitly created worktrees
  const marker2 = marker + "-2";
  await writeFile(
    join(repo, ".zcode", "worktree.json"),
    JSON.stringify({ preRemoveCommands: [`touch ${marker2}`] })
  );
  await ops.create({ repoPath: repo, name: "explicit-one", baseRef: "head" });
  await ops.remove({ repoPath: repo, name: "explicit-one" });
  assert.equal(existsSync(marker2), true, "explicit creates keep running preRemoveCommands");
});

test("security: explicit create still runs setupCommands (documented, user-initiated)", async () => {
  const store = tmpDir();
  const repo = tmpDir();
  makeRepo(repo, { remote: false });
  writeRepoFile(repo, ".zcode/worktree.json", JSON.stringify({
    setupCommands: ["echo ran-setup"],
  }));
  const ops = new Ops({ storeRoot: store });
  const created = await ops.create({ repoPath: repo, name: "with-setup" });
  assert.equal(created.setup.length, 1);
  assert.equal(created.setup[0].ok, true);
});

// Guard must never deny with a redirect to a worktree that no longer exists.
test("security: guard allows edits when the bound worktree vanished out-of-band", async () => {
  const store = tmpDir();
  const repo = tmpDir();
  makeRepo(repo, { remote: false });
  const ops = new Ops({ storeRoot: store });
  const created = await ops.create({
    repoPath: repo,
    name: "sess-vanish1",
    baseRef: "head",
    sessionId: "sess_vanish1-0000",
  });
  // delete the worktree directory WITHOUT going through remove (out-of-band)
  await rm(created.path, { recursive: true, force: true });

  const guardPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../plugins/git-worktrees/hooks/scripts/pre-tool-use.mjs"
  );
  const res = await new Promise((resolve) => {
    const child = spawn(process.execPath, [guardPath], {
      env: { ...process.env, ZCODE_WORKTREE_STORE_ROOT: store, ZCODE_PROJECT_DIR: repo },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", () => resolve(out));
    child.stdin.end(
      JSON.stringify({
        tool_name: "Write",
        tool_input: { file_path: join(repo, "README.md") },
        session_id: "sess_vanish1-0000",
      })
    );
    setTimeout(() => child.kill(), 30000).unref();
  });
  assert.equal(res, "", "no deny when the redirect target is gone");
  gitRun(repo, "worktree", "prune");
});

void readdir;
