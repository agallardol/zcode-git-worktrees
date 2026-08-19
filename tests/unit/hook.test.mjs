// SessionStart hook behavior: injects context inside a managed worktree,
// stays silent everywhere else, never fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeRepo, tmpDir, git } from "../fixtures/helpers.mjs";

const hookPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../plugins/git-worktrees/hooks/scripts/session-start.mjs"
);

function runHook(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookPath], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
    child.stdin.end("{}");
    setTimeout(() => child.kill(), 5000).unref();
  });
}

test("hook injects context when session starts inside a managed worktree", async () => {
  const store = tmpDir();
  const repo = tmpDir();
  makeRepo(repo, { remote: false });
  const wt = join(store, "myrepo", "fix-auth");
  await mkdir(dirname(wt), { recursive: true });
  await git(repo, "worktree", "add", "-b", "zcode/fix-auth", wt, "HEAD");

  await writeFile(
    join(store, "state.json"),
    JSON.stringify({
      version: 1,
      projects: {
        [repo]: {
          slug: "myrepo",
          mainPath: repo,
          worktrees: {
            "fix-auth": {
              name: "fix-auth",
              path: wt,
              branch: "zcode/fix-auth",
              base: "HEAD",
              task: "Refactor login",
              createdAt: new Date().toISOString(),
            },
          },
        },
      },
    })
  );

  const res = await runHook({ ZCODE_WORKTREE_STORE_ROOT: store, ZCODE_PROJECT_DIR: wt });
  assert.equal(res.code, 0, `stderr: ${res.err}`);
  const payload = JSON.parse(res.out);
  assert.match(payload.additionalContext, /fix-auth/);
  assert.match(payload.additionalContext, /Refactor login/);
  assert.match(payload.additionalContext, /READ-ONLY/);
  assert.match(payload.additionalContext, new RegExp(repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("hook is silent for the main checkout and unrelated dirs", async () => {
  const store = tmpDir();
  const repo = tmpDir();
  makeRepo(repo, { remote: false });
  const main = await runHook({ ZCODE_WORKTREE_STORE_ROOT: store, ZCODE_PROJECT_DIR: repo });
  assert.equal(main.code, 0);
  assert.equal(main.out, "");

  const elsewhere = await runHook({ ZCODE_WORKTREE_STORE_ROOT: store, ZCODE_PROJECT_DIR: tmpDir() });
  assert.equal(elsewhere.code, 0);
  assert.equal(elsewhere.out, "");
});

test("hook survives missing/corrupt state", async () => {
  const store = tmpDir();
  await mkdir(store, { recursive: true });
  await writeFile(join(store, "state.json"), "garbage{");
  const res = await runHook({ ZCODE_WORKTREE_STORE_ROOT: store, ZCODE_PROJECT_DIR: store });
  assert.equal(res.code, 0);
  assert.equal(res.out, "");
});

test("hook matches nested paths inside the worktree", async () => {
  const store = tmpDir();
  const repo = tmpDir();
  const wt = join(store, "proj", "task9");
  await writeFile(
    join(store, "state.json"),
    JSON.stringify({
      version: 1,
      projects: {
        [repo]: { slug: "proj", mainPath: repo, worktrees: { task9: { name: "task9", path: wt, branch: "zcode/task9" } } },
      },
    })
  );
  const res = await runHook({
    ZCODE_WORKTREE_STORE_ROOT: store,
    ZCODE_PROJECT_DIR: join(wt, "src", "deep"),
  });
  assert.equal(res.code, 0);
  const payload = JSON.parse(res.out);
  assert.match(payload.additionalContext, /task9/);
});
