import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { StateStore } from "../../plugins/git-worktrees/mcp/lib/state.mjs";
import { tmpDir } from "../fixtures/helpers.mjs";

test("load starts empty when state file missing", async () => {
  const root = tmpDir();
  const store = new StateStore(root);
  const state = await store.load();
  assert.deepEqual(state.projects, {});
});

test("load quarantines corrupt state and self-heals", async () => {
  const root = tmpDir();
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "state.json"), "{ not json !!!");
  const store = new StateStore(root);
  const state = await store.load();
  assert.deepEqual(state.projects, {});
  const { readdir } = await import("node:fs/promises");
  const list = await readdir(root);
  assert.ok(list.some((f) => f.startsWith("state.json.corrupt-")), "corrupt file quarantined");
});

test("save is atomic and roundtrips", async () => {
  const root = tmpDir();
  const store = new StateStore(root);
  await store.load();
  store.ensureProject("/repo/a", { originUrl: "git@host:a" });
  store.recordWorktree("/repo/a", {
    name: "task1",
    path: join(root, "a", "task1"),
    branch: "zcode/task1",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    snapshots: [],
  });
  await store.save();
  const store2 = new StateStore(root);
  await store2.load();
  assert.equal(store2.worktree("/repo/a", "task1").branch, "zcode/task1");
  // no temp files left behind
  const list = await readdir(root);
  assert.deepEqual(list.filter((f) => f.includes(".tmp-")), []);
});

test("slugFor disambiguates same-basename repos", async () => {
  const root = tmpDir();
  const store = new StateStore(root);
  await store.load();
  store.ensureProject("/x/one/app");
  assert.equal(store.slugFor("/x/one/app"), "app");
  assert.match(store.slugFor("/x/two/app"), /^app-[0-9a-f]{8}$/);
  // stable across calls
  assert.equal(store.slugFor("/x/two/app"), store.slugFor("/x/two/app"));
});

test("reconcileProject adopts foreign worktrees under the store and drops vanished ones", async () => {
  const root = tmpDir();
  const store = new StateStore(root);
  await store.load();
  const proj = store.ensureProject("/repo/main");
  const slug = proj.slug;
  const present = join(root, slug, "present");
  const vanished = join(root, slug, "gone");
  store.recordWorktree("/repo/main", {
    name: "gone",
    path: vanished,
    branch: "zcode/gone",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    snapshots: [],
  });
  const gitList = [
    { path: "/repo/main", branch: "refs/heads/main" },
    { path: present, branch: "refs/heads/zcode/present", locked: "agent" },
  ];
  const report = await store.reconcileProject("/repo/main", gitList, { storeRoot: root });
  assert.deepEqual(report.dropped, ["gone"]);
  assert.deepEqual(report.adopted, ["present"]);
  const adopted = store.worktree("/repo/main", "present");
  assert.equal(adopted.branch, "zcode/present");
  assert.equal(adopted.locked, true);
  assert.equal(adopted.adopted, true);
  assert.equal(store.worktree("/repo/main", "gone"), null);
});

test("reconcileProject ignores worktrees outside the store", async () => {
  const root = tmpDir();
  const store = new StateStore(root);
  await store.load();
  store.ensureProject("/repo/main");
  const report = await store.reconcileProject(
    "/repo/main",
    [
      { path: "/repo/main" },
      { path: "/elsewhere/manual-wt", branch: "refs/heads/feat" },
    ],
    { storeRoot: root }
  );
  assert.deepEqual(report.adopted, []);
});

test("dropDeadProjects removes entries whose repo dir vanished", async () => {
  const root = tmpDir();
  const alive = tmpDir();
  const store = new StateStore(root);
  await store.load();
  store.ensureProject(alive);
  store.ensureProject("/definitely/missing/repo");
  await store.dropDeadProjects();
  assert.ok(store.project(alive));
  assert.equal(store.project("/definitely/missing/repo"), null);
});

test("findEntryByPath matches the worktree and nested directories", async () => {
  const root = tmpDir();
  const store = new StateStore(root);
  await store.load();
  store.ensureProject("/repo/main");
  const wtPath = join(root, "main", "task1");
  store.recordWorktree("/repo/main", {
    name: "task1",
    path: wtPath,
    branch: "zcode/task1",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    snapshots: [],
  });
  assert.equal(store.findEntryByPath(wtPath)?.entry.name, "task1");
  assert.equal(store.findEntryByPath(join(wtPath, "src", "deep"))?.entry.name, "task1");
  // prefix-but-not-boundary must not match
  assert.equal(store.findEntryByPath(wtPath + "-suffix"), null);
  assert.equal(store.findEntryByPath("/unrelated"), null);
});

test("removedHistory is capped", async () => {
  const root = tmpDir();
  const store = new StateStore(root);
  await store.load();
  const proj = store.ensureProject("/repo/main");
  proj.removedHistory = Array.from({ length: 60 }, (_, i) => ({ name: `w${i}` }));
  proj.removedHistory = proj.removedHistory.slice(-49);
  proj.removedHistory.push({ name: "newest" });
  assert.equal(proj.removedHistory.length, 50);
  assert.equal(proj.removedHistory[49].name, "newest");
});
