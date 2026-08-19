import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { takeSnapshot } from "../../plugins/git-worktrees/mcp/lib/snapshot.mjs";
import * as git from "../../plugins/git-worktrees/mcp/lib/git.mjs";
import { makeRepo, tmpDir, writeRepoFile, git as gitRun } from "../fixtures/helpers.mjs";

async function dirtyWorktree() {
  const repo = tmpDir();
  makeRepo(repo, { remote: false });
  writeRepoFile(repo, "src/app.js", "console.log(2); // modified\n");
  writeRepoFile(repo, "notes/new-note.md", "untracked\n");
  await gitRun(repo, "add", "src/app.js"); // staged change
  return repo;
}

test("takeSnapshot captures tracked diff and untracked files", async () => {
  const wt = await dirtyWorktree();
  const snapsRoot = tmpDir();
  const snap = await takeSnapshot(wt, snapsRoot, { name: "test-wt", reason: "remove" });

  assert.ok(snap.hasPatch, "patch captured");
  const patch = await readFile(join(snap.dir, "changes.patch"), "utf8");
  assert.match(patch, /console\.log\(2\)/);

  assert.equal(snap.untrackedCount, 1);
  const note = await readFile(join(snap.dir, "untracked", "notes", "new-note.md"), "utf8");
  assert.equal(note, "untracked\n");

  const meta = JSON.parse(await readFile(join(snap.dir, "meta.json"), "utf8"));
  assert.equal(meta.name, "test-wt");
  assert.equal(meta.reason, "remove");
  assert.ok(meta.headCommit);
  assert.match(meta.restoreHint, /git apply/);
});

test("snapshot patch applies cleanly onto a fresh checkout of the same commit", async () => {
  const wt = await dirtyWorktree();
  const snapsRoot = tmpDir();
  const snap = await takeSnapshot(wt, snapsRoot, { name: "test-wt" });

  // fresh worktree at the same commit (no uncommitted changes)
  const fresh = join(tmpDir(), "fresh");
  await gitRun(wt, "worktree", "add", "--detach", fresh, "HEAD");
  await gitRun(fresh, "apply", join(snap.dir, "changes.patch"));
  const content = await readFile(join(fresh, "src/app.js"), "utf8");
  assert.equal(content, "console.log(2); // modified\n");
});

test("two snapshots in quick succession do not collide", async () => {
  const wt = await dirtyWorktree();
  const snapsRoot = tmpDir();
  const a = await takeSnapshot(wt, snapsRoot, { name: "same" });
  const b = await takeSnapshot(wt, snapsRoot, { name: "same" });
  assert.notEqual(a.dir, b.dir);
});

test("clean worktree produces empty-but-valid snapshot", async () => {
  const repo = tmpDir();
  makeRepo(repo, { remote: false });
  const snap = await takeSnapshot(repo, tmpDir(), { name: "clean" });
  assert.equal(snap.hasPatch, false);
  assert.equal(snap.untrackedCount, 0);
});

test("git helpers: statusSummary and untrackedFiles agree on dirty state", async () => {
  const wt = await dirtyWorktree();
  const info = await git.statusSummary(wt);
  assert.equal(info.staged, 1);
  assert.equal(info.untracked, 1);
  assert.equal(info.unstaged, 0);
  const untracked = await git.untrackedFiles(wt);
  assert.deepEqual(untracked, ["notes/new-note.md"]);
});
