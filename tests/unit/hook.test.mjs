// SessionStart hook behavior: injects context inside a managed worktree,
// stays silent everywhere else, and (in auto-session mode) assigns each new
// session in a main checkout its own worktree. Never fails a session.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeRepo, tmpDir, git as gitRun } from "../fixtures/helpers.mjs";
import { writeAutoSession } from "../../plugins/git-worktrees/mcp/lib/store.mjs";

const hookPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../plugins/git-worktrees/hooks/scripts/session-start.mjs"
);

function runHook(env, stdin = "{}") {
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
    child.stdin.end(stdin);
    setTimeout(() => child.kill(), 20000).unref();
  });
}

function ctxOf(res) {
  assert.equal(res.code, 0, `hook must not fail: ${res.err}`);
  assert.notEqual(res.out.trim(), "", "expected injected context");
  return JSON.parse(res.out).additionalContext;
}

test("hook injects context when session starts inside a managed worktree", async () => {
  const store = tmpDir();
  const repo = tmpDir();
  makeRepo(repo, { remote: false });
  const wt = join(store, "myrepo", "fix-auth");
  await mkdir(dirname(wt), { recursive: true });
  await gitRun(repo, "worktree", "add", "-b", "zcode/fix-auth", wt, "HEAD");

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

// ---------------------------------------------------------------- auto mode

function autoEnv(store, cwd, session = "sess_abc12345-1111-2222-3333-444455556666") {
  return {
    ZCODE_WORKTREE_STORE_ROOT: store,
    ZCODE_PROJECT_DIR: cwd,
    ZCODE_SESSION_ID: session,
  };
}

test("auto mode off: no worktree created, hook silent in main checkout", async () => {
  const store = tmpDir();
  const repo = tmpDir();
  makeRepo(repo, { remote: false });
  const res = await runHook(autoEnv(store, repo), JSON.stringify({ session_id: "sess_x" }));
  assert.equal(res.code, 0);
  assert.equal(res.out, "");
  assert.equal(existsSync(join(store, repo.split("/").pop())), false);
});

test("auto mode on: new session in main checkout gets a bound worktree", async () => {
  const store = tmpDir();
  await writeAutoSession(store, true);
  const repo = tmpDir();
  makeRepo(repo, { remote: false });

  const res = await runHook(
    autoEnv(store, repo, "sess_f5dd9539-e229-4ed0-b6b0-b88dbb86db35"),
    JSON.stringify({ session_id: "sess_f5dd9539-e229-4ed0-b6b0-b88dbb86db35", source: "startup" })
  );
  const ctx = ctxOf(res);
  assert.match(ctx, /sess-f5dd9539/);
  assert.match(ctx, /READ-ONLY for file edits/);
  assert.match(ctx, /\/worktree:end/);

  // worktree really exists, branch correct, bound in state
  const repoName = (await realpath(repo)).split("/").pop();
  const wtPath = join(store, repoName, "sess-f5dd9539");
  assert.ok(existsSync(wtPath), `worktree created at ${wtPath}`);
  assert.equal(gitRun(wtPath, "branch", "--show-current").trim(), "zcode/sess-f5dd9539");
  const state = JSON.parse(await readFile2(join(store, "state.json")));
  const entry = Object.values(Object.values(state.projects)[0].worktrees)[0];
  assert.equal(entry.session.id, "sess_f5dd9539-e229-4ed0-b6b0-b88dbb86db35");
});

test("auto mode: resume of the same session reuses the worktree (no duplicate)", async () => {
  const store = tmpDir();
  await writeAutoSession(store, true);
  const repo = tmpDir();
  makeRepo(repo, { remote: false });
  const sid = "sess_aa11bb22-cccc-dddd-eeee-ffff00001111";

  await runHook(autoEnv(store, repo, sid), JSON.stringify({ session_id: sid, source: "startup" }));
  const resumed = await runHook(autoEnv(store, repo, sid), JSON.stringify({ session_id: sid, source: "resume" }));
  const ctx = ctxOf(resumed);
  assert.match(ctx, /already has its worktree/);

  const repoName = (await realpath(repo)).split("/").pop();
  const projDir = join(store, repoName);
  assert.deepEqual(await readdir(projDir), ["sess-aa11bb22"], "exactly one session worktree");
});

test("auto mode: different session gets a different worktree", async () => {
  const store = tmpDir();
  await writeAutoSession(store, true);
  const repo = tmpDir();
  makeRepo(repo, { remote: false });

  await runHook(autoEnv(store, repo, "sess_11111111-0000-0000-0000-000000000001"),
    JSON.stringify({ session_id: "sess_11111111-0000-0000-0000-000000000001" }));
  await runHook(autoEnv(store, repo, "sess_22222222-0000-0000-0000-000000000002"),
    JSON.stringify({ session_id: "sess_22222222-0000-0000-0000-000000000002" }));

  const repoName = (await realpath(repo)).split("/").pop();
  const names = (await readdir(join(store, repoName))).sort();
  assert.deepEqual(names, ["sess-11111111", "sess-22222222"]);
});

test("auto mode: non-git directory → silent, nothing created", async () => {
  const store = tmpDir();
  await writeAutoSession(store, true);
  const dir = tmpDir();
  const res = await runHook(autoEnv(store, dir), JSON.stringify({ session_id: "sess_zz" }));
  assert.equal(res.code, 0);
  assert.equal(res.out, "");
});

test("auto mode: unborn repo → failure notice, session unharmed", async () => {
  const store = tmpDir();
  await writeAutoSession(store, true);
  const repo = tmpDir();
  gitRun(repo, "init", "-b", "main");
  const sid = "sess_bb22cc33-0000-0000-0000-000000000003";
  const res = await runHook(autoEnv(store, repo, sid), JSON.stringify({ session_id: sid }));
  assert.equal(res.code, 0);
  const ctx = ctxOf(res);
  assert.match(ctx, /failed/);
  assert.match(ctx, /\/worktree:new/);
});

test("auto mode: hook never breaks on garbage stdin", async () => {
  const store = tmpDir();
  await writeAutoSession(store, true);
  const repo = tmpDir();
  makeRepo(repo, { remote: false });
  const res = await runHook(autoEnv(store, repo), "not json at all{");
  assert.equal(res.code, 0);
});

async function readFile2(p) {
  const { readFile } = await import("node:fs/promises");
  return readFile(p, "utf8");
}
