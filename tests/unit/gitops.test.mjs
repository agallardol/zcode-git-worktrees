// Lib-level git operations against fixture repos (no MCP involved).
import { test } from "node:test";
import assert from "node:assert/strict";
import { stat, realpath } from "node:fs/promises";
import { join } from "node:path";
import * as git from "../../plugins/git-worktrees/mcp/lib/git.mjs";
import { makeRepo, tmpDir, writeRepoFile, git as gitRun } from "../fixtures/helpers.mjs";

test("resolveMainRepo from main checkout and from a linked worktree agree", async () => {
  const repo = tmpDir();
  makeRepo(repo, { remote: false });
  const canon = await realpath(repo); // git canonicalizes through /var → /private/var
  const fromMain = await git.resolveMainRepo(repo);
  assert.equal(fromMain.mainPath, canon);

  const wt = join(tmpDir(), "linked");
  await gitRun(repo, "worktree", "add", "-b", "zcode/x", wt);
  const fromWt = await git.resolveMainRepo(wt);
  assert.equal(fromWt.mainPath, canon, "linked worktree resolves to main repo");
  assert.equal(fromWt.currentWorktree, await realpath(wt));
});

test("resolveMainRepo handles bare repos and their worktrees", async () => {
  const src = tmpDir();
  makeRepo(src, { remote: false });
  const bare = `${tmpDir()}-bare.git`;
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["clone", "--bare", "--quiet", src, bare]);
  const fromBare = await git.resolveMainRepo(bare);
  assert.equal(fromBare.mainPath, await realpath(bare));

  const wt = join(tmpDir(), "bare-wt");
  execFileSync("git", ["-C", bare, "worktree", "add", "-b", "zcode/b", wt]);
  const fromWt = await git.resolveMainRepo(wt);
  assert.equal(fromWt.mainPath, await realpath(bare), "worktree of bare repo anchors on the bare repo");
});

test("resolveMainRepo throws outside a git repository", async () => {
  const empty = tmpDir();
  await assert.rejects(git.resolveMainRepo(empty), /not a git repository/);
});

test("listWorktrees parses porcelain including locked + detached", async () => {
  const repo = tmpDir();
  makeRepo(repo, { remote: false });
  const wt = join(tmpDir(), "locked-wt");
  await gitRun(repo, "worktree", "add", "-b", "zcode/l", wt);
  await gitRun(repo, "worktree", "lock", "--reason", "testing", wt);

  const list = await git.listWorktrees(repo);
  assert.equal(list.length, 2);
  assert.equal(list[0].path, await realpath(repo)); // main first
  const wtCanon = await realpath(wt);
  const locked = list.find((w) => w.path === wtCanon);
  assert.equal(locked.branch, "refs/heads/zcode/l");
  assert.equal(locked.locked, "testing");

  // detached worktree
  const detached = join(tmpDir(), "detached-wt");
  await gitRun(repo, "worktree", "add", "--detach", detached, "HEAD~1");
  const list2 = await git.listWorktrees(repo);
  const detCanon = await realpath(detached);
  const det = list2.find((w) => w.path === detCanon);
  assert.equal(det.detached, true);
  assert.equal(det.branch, undefined);
});

test("statusSummary parses branch, ahead/behind, dirty counters", async () => {
  const repo = tmpDir();
  makeRepo(repo, { remote: true });
  writeRepoFile(repo, "README.md", "# modified, unstaged\n"); // tracked → unstaged
  writeRepoFile(repo, "staged.txt", "staged\n");
  await gitRun(repo, "add", "staged.txt");
  writeRepoFile(repo, "untracked-new.txt", "untracked\n");
  const info = await git.statusSummary(repo);
  assert.equal(info.branch, "main");
  assert.equal(info.upstream, "origin/main");
  assert.equal(info.ahead, 0);
  assert.equal(info.staged, 1);
  assert.equal(info.unstaged, 1);
  assert.equal(info.untracked, 1);
  assert.equal(info.dirty, 3);
});

test("unpushedCount: 0 after push, N after local commits", async () => {
  const repo = tmpDir();
  makeRepo(repo, { remote: true });
  assert.equal((await git.unpushedCount(repo, "main", null)).unpushed, 0);
  writeRepoFile(repo, "more.txt", "more\n");
  await gitRun(repo, "add", "-A");
  await gitRun(repo, "commit", "-m", "local only");
  const res = await git.unpushedCount(repo, "main", null);
  assert.equal(res.hasRemote, true);
  assert.equal(res.unpushed, 1);
});

test("unpushedCount without any remote counts from base commit", async () => {
  const repo = tmpDir();
  makeRepo(repo, { remote: false, commits: 1 });
  const base = await git.resolveRef(repo, "HEAD");
  const wt = join(tmpDir(), "no-remote-wt");
  await gitRun(repo, "worktree", "add", "-b", "zcode/nr", wt);
  writeRepoFile(wt, "f.txt", "f\n");
  await gitRun(wt, "add", "-A");
  await gitRun(wt, "commit", "-m", "wt commit");
  const res = await git.unpushedCount(repo, "zcode/nr", base);
  assert.equal(res.hasRemote, false);
  assert.equal(res.unpushed, 1);
  const noBase = await git.unpushedCount(repo, "zcode/nr", null);
  assert.equal(noBase.unpushed, null);
});

test("fetchIfStale is a no-op without origin, survives unreachable origin", async () => {
  const noOrigin = tmpDir();
  makeRepo(noOrigin, { remote: false });
  assert.equal((await git.fetchIfStale(noOrigin)).attempted, false);

  const repo = tmpDir();
  makeRepo(repo, { remote: true });
  await gitRun(repo, "remote", "set-url", "origin", "/definitely/not/a/repo.git");
  const res = await git.fetchIfStale(repo);
  assert.equal(res.attempted, true);
  assert.equal(res.ok, false);
});

test("resolveBase fresh → origin/HEAD; head → local HEAD; explicit ref; bad ref throws", async () => {
  const repo = tmpDir();
  makeRepo(repo, { remote: true });
  const fresh = await git.resolveBase(repo, "fresh");
  assert.match(fresh.baseRef, /^origin\//);
  const head = await git.resolveBase(repo, "head");
  assert.equal(head.baseRef, "HEAD");
  const explicit = await git.resolveBase(repo, "HEAD~1");
  assert.ok(/^[0-9a-f]{40}$/.test(explicit.commit));
  await assert.rejects(git.resolveBase(repo, "no-such-ref"), /not found/);
});

test("resolveBase fresh with unreachable origin: cached origin/HEAD still preferred, warning given", async () => {
  const repo = tmpDir();
  makeRepo(repo, { remote: true });
  // create FETCH_HEAD while the origin is still reachable (push does not), then
  // break the remote and age FETCH_HEAD past the staleness window
  await gitRun(repo, "fetch", "origin");
  await gitRun(repo, "remote", "set-url", "origin", "/definitely/not/a/repo.git");
  const { utimes } = await import("node:fs/promises");
  const commonDir = (await git.resolveMainRepo(repo)).commonDir;
  const old = new Date(Date.now() - 48 * 3600 * 1000);
  await utimes(join(commonDir, "FETCH_HEAD"), old, old);
  const res = await git.resolveBase(repo, "fresh");
  // cached remote ref wins over blind HEAD fallback
  assert.equal(res.baseRef, "origin/HEAD");
  assert.ok(res.warnings.some((w) => /could not fetch/.test(w)));
});

test("resolveBase fresh with unreachable origin and no cached refs falls back to HEAD", async () => {
  const repo = tmpDir();
  makeRepo(repo, { remote: false });
  await gitRun(repo, "remote", "add", "origin", "/definitely/not/a/repo.git");
  const res = await git.resolveBase(repo, "fresh");
  assert.equal(res.baseRef, "HEAD");
  assert.ok(res.warnings.some((w) => /could not fetch/.test(w)));
});

test("resolveBase fresh with no origin warns", async () => {
  const repo = tmpDir();
  makeRepo(repo, { remote: false });
  const res = await git.resolveBase(repo, "fresh");
  assert.equal(res.baseRef, "HEAD");
  assert.ok(res.warnings.some((w) => /no origin/.test(w)));
});

test("createWorktree maps one-branch-per-worktree errors to guidance", async () => {
  const repo = tmpDir();
  makeRepo(repo, { remote: false });
  const wtA = join(tmpDir(), "a");
  await gitRun(repo, "worktree", "add", "-b", "zcode/shared", wtA, "HEAD");
  const wtB = join(tmpDir(), "b");
  const head = await git.resolveRef(repo, "HEAD");
  await assert.rejects(
    git.createWorktree(repo, wtB, "zcode/shared", head),
    /already checked out|already exists|used by worktree/i
  );
});

test("dirSize and estimateCheckoutNeed return positive numbers", async () => {
  const repo = tmpDir();
  makeRepo(repo, { remote: false });
  const size = await git.dirSize(repo);
  assert.ok(size > 0);
  const need = await git.estimateCheckoutNeed(repo);
  assert.ok(need >= 512 * 1024 * 1024);
});

test("state file and store dirs have safe permissions", async () => {
  // smoke: stat works; perms asserted in adversarial suite via Ops.save()
  const repo = tmpDir();
  makeRepo(repo, { remote: false });
  const st = await stat(repo);
  assert.ok(st.isDirectory());
});
