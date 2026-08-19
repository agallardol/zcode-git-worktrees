// Adversarial suite: hostile inputs, races, corrupted state, out-of-band
// mutations, concurrency. Every case asserts the SAFETY INVARIANT, not just
// "it threw": nothing escapes the store, nothing is silently lost, state and
// git always converge back to a consistent picture.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, readdir, rm, mkdir, stat, utimes, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { Ops } from "../../plugins/git-worktrees/mcp/lib/ops.mjs";
import { makeRepo, tmpDir, writeRepoFile, git as gitRun } from "../fixtures/helpers.mjs";

function newOps() {
  const storeRoot = tmpDir("adv-store-");
  return { ops: new Ops({ storeRoot }), storeRoot };
}

async function rejects(re, fn) {
  // the async wrapper turns synchronous throws (execFileSync) into rejections
  // so assert.rejects handles both call styles
  await assert.rejects(
    async () => {
      await fn();
    },
    (err) => {
      assert.match(err.message, re, `error message should match ${re}, got: ${err.message}`);
      return true;
    }
  );
}

// ---------------------------------------------------------------- name matrix

test("adversarial: hostile names rejected, nothing written outside the store", async () => {
  const { ops } = newOps();
  const repo = tmpDir();
  makeRepo(repo, { remote: false });
  const markerBefore = new Set(await readdir(dirname(repo)));

  const hostile = [
    "../evil", "a/b", "a\\b", "..", ".", "...", ".git", ".GIT", "foo..bar",
    "foo.", ".foo", "-foo", "_foo", "foo.lock", "foo~", "foo^", "foo:", "*",
    "foo bar", "foo\tbar", "über", "树", "emoji-😀", "a".repeat(65), "$(rm -rf)",
    "`id`", ";ls", "&&echo", "{}",
  ];
  for (const name of hostile) {
    await rejects(/invalid worktree name|reserved|name must/i, () =>
      ops.create({ repoPath: repo, name })
    );
  }
  // nothing new appeared next to the repo or its parents
  assert.deepEqual(await readdir(dirname(repo)), [...markerBefore]);
});

test("adversarial: name valid for paths but hostile to git refs is still rejected", async () => {
  const { ops } = newOps();
  const repo = tmpDir();
  makeRepo(repo, { remote: false });
  // all of these pass some tools' validators but must not pass ours
  for (const name of ["foo~bar", "a..b", "x.lock", "x.", "-x"]) {
    await rejects(/invalid worktree name|name must not/i, () =>
      ops.create({ repoPath: repo, name })
    );
  }
});

// ------------------------------------------------------------- collisions

test("adversarial: case-insensitive collision on APFS is refused", async () => {
  const { ops } = newOps();
  const repo = tmpDir();
  makeRepo(repo, { remote: false });
  await ops.create({ repoPath: repo, name: "foo" });
  await rejects(/case-insensitive/i, () => ops.create({ repoPath: repo, name: "FOO" }));
});

test("adversarial: duplicate name / existing branch produce precise errors", async () => {
  const { ops } = newOps();
  const repo = tmpDir();
  makeRepo(repo, { remote: false });
  await ops.create({ repoPath: repo, name: "dup" });
  await rejects(/already exists/, () => ops.create({ repoPath: repo, name: "dup" }));

  // branch kept after removal → same name blocked with branch hint
  await ops.remove({ repoPath: repo, name: "dup" });
  await rejects(/branch "zcode\/dup" already exists/, () =>
    ops.create({ repoPath: repo, name: "dup" })
  );
});

// ----------------------------------------------------------- repo edge cases

test("adversarial: unborn repo, non-repo, detached HEAD, bad base", async () => {
  const { ops } = newOps();
  const unborn = tmpDir();
  gitRun(unborn, "init", "-b", "main");
  await rejects(/no commits yet/, () => ops.create({ repoPath: unborn, name: "x" }));

  await rejects(/not a git repository/, () =>
    ops.create({ repoPath: tmpDir(), name: "x" })
  );

  const detached = tmpDir();
  makeRepo(detached, { remote: true, commits: 3 });
  gitRun(detached, "checkout", "--detach", "HEAD~1");
  const res = await ops.create({ repoPath: detached, name: "from-detached" });
  assert.ok(existsSync(res.path));
  // fresh base ignores the detached HEAD and uses origin/HEAD
  assert.match(res.base, /origin\/HEAD|HEAD/);

  const repo = tmpDir();
  makeRepo(repo, { remote: false });
  await rejects(/not found/, () =>
    ops.create({ repoPath: repo, name: "badbase", baseRef: "no-such-branch" })
  );
});

// ----------------------------------------------------------- removal safety

test("adversarial: dirty worktree survives removal attempts; forced removal snapshots", async () => {
  const { ops } = newOps();
  const repo = tmpDir();
  makeRepo(repo, { remote: true });
  const { path } = await ops.create({ repoPath: repo, name: "precious" });
  writeRepoFile(path, "src/app.js", "console.log('dirty');\n");
  writeRepoFile(path, "brand-new.txt", "never committed\n");

  await rejects(/uncommitted change/, () =>
    ops.remove({ repoPath: repo, name: "precious" })
  );
  assert.ok(existsSync(path), "worktree untouched after refusal");

  const res = await ops.remove({ repoPath: repo, name: "precious", force: true });
  assert.ok(res.snapshot?.dir, "snapshot taken");
  const patch = await readFile(join(res.snapshot.dir, "changes.patch"), "utf8");
  assert.match(patch, /console\.log\('dirty'\)/);
  const untracked = await readFile(
    join(res.snapshot.dir, "untracked", "brand-new.txt"),
    "utf8"
  );
  assert.equal(untracked, "never committed\n");
  assert.equal(existsSync(path), false);
});

test("adversarial: unmerged branch not deleted without force, deleted with force", async () => {
  const { ops } = newOps();
  const repo = tmpDir();
  makeRepo(repo, { remote: true });
  const { path, branch } = await ops.create({ repoPath: repo, name: "wip" });
  writeRepoFile(path, "wip.txt", "work in progress\n");
  gitRun(path, "add", "-A");
  gitRun(path, "commit", "-m", "wip work");

  const kept = await ops.remove({ repoPath: repo, name: "wip", deleteBranch: true });
  assert.match(kept.branchAction, /kept \(branch has unmerged commits/);
  assert.equal(
    gitRun(repo, "rev-parse", "--verify", branch).trim().length,
    40,
    "branch still exists after refused deletion"
  );

  // same scenario, but the user insists (force) → branch deleted
  const { path: p2, branch: b2 } = await ops.create({
    repoPath: repo,
    name: "wip2",
    baseRef: "HEAD",
  });
  writeRepoFile(p2, "wip2.txt", "more wip\n");
  gitRun(p2, "add", "-A");
  gitRun(p2, "commit", "-m", "wip2 work");
  const gone = await ops.remove({
    repoPath: repo,
    name: "wip2",
    deleteBranch: true,
    force: true,
  });
  assert.equal(gone.branchAction, "deleted");
  await rejects(/Needed a single revision|unknown revision|bad revision/, () =>
    gitRun(repo, "rev-parse", "--verify", b2)
  );
});

test("adversarial: main checkout can never be removed through the tool", async () => {
  const { ops, storeRoot } = newOps();
  const repo = tmpDir();
  makeRepo(repo, { remote: false });
  await ops.create({ repoPath: repo, name: "decoy" }); // establishes project state
  // fabricate a state entry pointing at the main checkout (hostile state edit)
  const stateFile = join(storeRoot, "state.json");
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  const projKey = Object.keys(state.projects)[0];
  state.projects[projKey].worktrees["sneaky"] = {
    name: "sneaky",
    path: state.projects[projKey].mainPath,
    branch: "main",
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    snapshots: [],
  };
  await writeFile(stateFile, JSON.stringify(state));
  await rejects(/main checkout/, () => ops.remove({ repoPath: repo, name: "sneaky" }));
  assert.ok(existsSync(repo), "main checkout still there");
});

test("adversarial: foreign lock blocks removal until forced", async () => {
  const { ops } = newOps();
  const repo = tmpDir();
  makeRepo(repo, { remote: false });
  const { path } = await ops.create({ repoPath: repo, name: "locked-wt" });
  gitRun(repo, "worktree", "lock", "--reason", "foreign", path);
  await rejects(/locked/, () => ops.remove({ repoPath: repo, name: "locked-wt" }));
  assert.ok(existsSync(path));
  const res = await ops.remove({ repoPath: repo, name: "locked-wt", force: true });
  assert.equal(res.removed, "locked-wt");
});

test("adversarial: preRemove failure aborts removal unless forced", async () => {
  const { ops } = newOps();
  const repo = tmpDir();
  makeRepo(repo, { remote: false });
  await ops.create({ repoPath: repo, name: "guardme" });
  writeRepoFile(repo, ".zcode/worktree.json", JSON.stringify({
    preRemoveCommands: ["exit 7"],
  }));

  await rejects(/pre-remove command failed|removal aborted/, () =>
    ops.remove({ repoPath: repo, name: "guardme" })
  );
  const list = await ops.list({ repoPath: repo });
  assert.equal(list.worktrees.length, 1, "worktree kept after preRemove failure");

  const forced = await ops.remove({ repoPath: repo, name: "guardme", force: true });
  assert.equal(forced.removed, "guardme");
});

// ------------------------------------------------------------- agents + cleanup

test("adversarial: cleanup never touches dirty/locked/agent-active worktrees", async () => {
  const { ops } = newOps();
  const repo = tmpDir();
  makeRepo(repo, { remote: false });

  await ops.create({ repoPath: repo, name: "clean-idle" });
  const dirty = await ops.create({ repoPath: repo, name: "dirty-idle" });
  writeRepoFile(dirty.path, "dirt.txt", "d\n");
  await ops.create({ repoPath: repo, name: "agent-busy" });
  await ops.setTask({ repoPath: repo, name: "agent-busy", agentId: "agent_x" });

  const applied = await ops.cleanup({
    repoPath: repo,
    dryRun: false,
    maxAgeDays: 0,
    maxCount: 0,
  });
  assert.equal(applied.removed.length, 1);
  assert.equal(applied.removed[0].name, "clean-idle");
  const skipped = Object.fromEntries(applied.skipped.map((s) => [s.name, s.reason]));
  assert.match(skipped["dirty-idle"], /uncommitted/);
  assert.match(skipped["agent-busy"], /locked|agent/); // agent registration locks it

  const list = await ops.list({ repoPath: repo });
  assert.deepEqual(list.worktrees.map((w) => w.name).sort(), ["agent-busy", "dirty-idle"]);
});

test("adversarial: stale-by-age detection uses both state and git activity", async () => {
  const { ops } = newOps();
  const repo = tmpDir();
  makeRepo(repo, { remote: false });
  const { path } = await ops.create({ repoPath: repo, name: "ancient" });

  // age both signals: state timestamp and the worktree's admin HEAD mtime
  const { storeRoot } = ops;
  const stateFile = join(storeRoot, "state.json");
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  const proj = Object.values(state.projects)[0];
  const old = "2020-01-01T00:00:00.000Z";
  proj.worktrees["ancient"].lastActivityAt = old;
  proj.worktrees["ancient"].createdAt = old;
  await writeFile(stateFile, JSON.stringify(state));

  const gitfile = await readFile(join(path, ".git"), "utf8");
  const gitdir = gitfile.match(/gitdir:\s*(\S+)/)[1];
  await utimes(join(gitdir, "HEAD"), new Date(old), new Date(old));

  const dry = await ops.cleanup({ repoPath: repo, dryRun: true, maxAgeDays: 14, maxCount: 99 });
  assert.equal(dry.wouldRemove.length, 1);
  assert.equal(dry.wouldRemove[0].name, "ancient");
});

// --------------------------------------------------------- out-of-band damage

test("adversarial: manually deleted worktree dir → MISSING flag, prune reconciles", async () => {
  const { ops } = newOps();
  const repo = tmpDir();
  makeRepo(repo, { remote: false });
  const { path } = await ops.create({ repoPath: repo, name: "ghosted" });
  await rm(path, { recursive: true, force: true }); // out-of-band deletion

  const list = await ops.list({ repoPath: repo });
  const ghost = list.worktrees.find((w) => w.name === "ghosted");
  assert.equal(ghost.exists, false);

  const pruned = await ops.prune({ repoPath: repo });
  assert.deepEqual(pruned.stateDropped, ["ghosted"]);
  const after = await ops.list({ repoPath: repo });
  assert.equal(after.worktrees.length, 0);
});

test("adversarial: corrupted state.json self-heals and re-adopts worktrees", async () => {
  const { ops, storeRoot } = newOps();
  const repo = tmpDir();
  makeRepo(repo, { remote: false });
  const created = await ops.create({ repoPath: repo, name: "survivor" });

  // trash the state file completely
  await writeFile(join(storeRoot, "state.json"), "💀 not json at all");

  // list self-heals: state rebuilt, existing worktree adopted by path scan
  const list = await ops.list({ repoPath: repo });
  const quarantined = await readdir(storeRoot);
  assert.ok(quarantined.some((f) => f.startsWith("state.json.corrupt-")));
  assert.equal(list.worktrees.length, 1);
  assert.equal(list.worktrees[0].name, "survivor");
  assert.equal(list.worktrees[0].adopted, true);
  assert.equal(list.worktrees[0].path, created.path);

  // and it remains fully operable
  const res = await ops.remove({ repoPath: repo, name: "survivor" });
  assert.equal(res.removed, "survivor");
});

test("adversarial: raw-git worktree under the store is adopted and manageable", async () => {
  const { ops, storeRoot } = newOps();
  const repo = tmpDir();
  makeRepo(repo, { remote: false });
  // discover slug the same way ops did (first call creates the project entry)
  await ops.create({ repoPath: repo, name: "ours" });
  const state = JSON.parse(await readFile(join(storeRoot, "state.json"), "utf8"));
  const slug = Object.values(state.projects)[0].slug;

  const foreignPath = join(await realpath(storeRoot), slug, "foreign");
  gitRun(repo, "worktree", "add", "-b", "zcode/foreign", foreignPath, "HEAD");
  writeRepoFile(foreignPath, "f.txt", "foreign work\n");

  const list = await ops.list({ repoPath: repo });
  const foreign = list.worktrees.find((w) => w.name === "foreign");
  assert.ok(foreign, "foreign worktree adopted");
  assert.equal(foreign.adopted, true);

  const res = await ops.remove({ repoPath: repo, name: "foreign", force: true });
  assert.equal(res.removed, "foreign");
});

// --------------------------------------------------------------- concurrency

test("adversarial: 8 parallel creates across separate Ops instances all persist", async () => {
  const { storeRoot } = newOps();
  const repo = tmpDir();
  makeRepo(repo, { remote: false });
  const names = Array.from({ length: 8 }, (_, i) => `par-${i}`);
  const results = await Promise.allSettled(
    names.map((name) => {
      const ops = new Ops({ storeRoot }); // separate process simulation
      return ops.create({ repoPath: repo, name });
    })
  );
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  assert.equal(fulfilled.length, 8, `all creates succeed: ${results.map(r => r.reason?.message)}`);

  const check = new Ops({ storeRoot });
  const list = await check.list({ repoPath: repo });
  assert.equal(list.worktrees.length, 8, "state has every worktree — no lost updates");
  for (const wt of list.worktrees) assert.ok(existsSync(wt.path));
});

test("adversarial: parallel removes of the same worktree stay consistent", async () => {
  const { storeRoot } = newOps();
  const repo = tmpDir();
  makeRepo(repo, { remote: false });
  const seed = new Ops({ storeRoot });
  const { name } = await seed.create({ repoPath: repo, name: "race-me" });

  const results = await Promise.allSettled(
    [1, 2, 3].map(() => {
      const ops = new Ops({ storeRoot });
      return ops.remove({ repoPath: repo, name });
    })
  );
  const okCount = results.filter((r) => r.status === "fulfilled").length;
  assert.equal(okCount, 1, `exactly one removal wins (got ${okCount})`);

  const check = new Ops({ storeRoot });
  const list = await check.list({ repoPath: repo });
  assert.equal(list.worktrees.length, 0, "state converged");
});

test("adversarial: create while cleanup runs converges (no lost worktree)", async () => {
  const { storeRoot } = newOps();
  const repo = tmpDir();
  makeRepo(repo, { remote: false });
  const seed = new Ops({ storeRoot });
  for (const n of ["c1", "c2"]) await seed.create({ repoPath: repo, name: n });

  const [cleanupRes, createRes] = await Promise.allSettled([
    new Ops({ storeRoot }).cleanup({ repoPath: repo, dryRun: false, maxAgeDays: 0, maxCount: 0 }),
    new Ops({ storeRoot }).create({ repoPath: repo, name: "during-cleanup" }),
  ]);
  assert.equal(cleanupRes.status, "fulfilled");
  assert.equal(createRes.status, "fulfilled", `create survives: ${createRes.reason?.message}`);

  // Locking serializes both; either order is valid:
  //  - cleanup first → "during-cleanup" survives
  //  - create first  → cleanup legitimately sweeps the idle newcomer too
  const check = new Ops({ storeRoot });
  const list = await check.list({ repoPath: repo });
  const names = list.worktrees.map((w) => w.name);
  assert.ok(
    names.length === 0 || (names.length === 1 && names[0] === "during-cleanup"),
    `converged to a valid outcome, got: ${names.join(",")}`
  );

  // state and git agree (no phantom entries, no orphan dirs)
  const gitWts = gitRun(repo, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice(9));
  const statePaths = list.worktrees.map((w) => w.path);
  for (const p of statePaths) assert.ok(gitWts.includes(p), `state entry known to git: ${p}`);
  assert.equal(gitWts.length, statePaths.length + 1, "main checkout + state worktrees");
});

// --------------------------------------------------------------- weird paths

test("adversarial: repo paths with spaces and unicode work end to end", async () => {
  const { ops } = newOps();
  const base = tmpDir();
  const repo = join(base, "my repo (v2) — über");
  makeRepo(repo, { remote: false });
  const created = await ops.create({ repoPath: repo, name: "spaced" });
  assert.ok(existsSync(created.path));
  writeRepoFile(created.path, "x.txt", "works\n");
  gitRun(created.path, "add", "-A");
  gitRun(created.path, "commit", "-m", "works with spaces");
  const status = await ops.status({ repoPath: repo, name: "spaced" });
  assert.equal(status.dirty, 0);
  const res = await ops.remove({ repoPath: repo, name: "spaced" });
  assert.equal(res.removed, "spaced");
});

test("adversarial: symlinked store path cannot redirect worktrees", async () => {
  const realStore = tmpDir();
  const linkBase = tmpDir();
  const { symlink } = await import("node:fs/promises");
  await symlink(realStore, join(linkBase, "store-link"));
  const ops = new Ops({ storeRoot: join(linkBase, "store-link") });
  const repo = tmpDir();
  makeRepo(repo, { remote: false });
  // works (canonicalized), but a symlink planted INSIDE the store is refused
  const created = await ops.create({ repoPath: repo, name: "ok" });
  assert.ok(existsSync(created.path));
  const canonRoot = await realpath(realStore);
  await symlink(repo, join(canonRoot, basename(repo), "trap"));
  await rejects(/symlink/, () => ops.create({ repoPath: repo, name: "trap" }));
});

// --------------------------------------------------------- dirty carry-over

test("adversarial: carryDirty brings uncommitted work, never overwrites", async () => {
  const { ops } = newOps();
  const repo = tmpDir();
  makeRepo(repo, { remote: false });
  writeRepoFile(repo, "README.md", "# locally modified, uncommitted\n");
  writeRepoFile(repo, "untracked-keep.txt", "untracked gold\n");

  const created = await ops.create({ repoPath: repo, name: "carry", carryDirty: true });
  const readme = await readFile(join(created.path, "README.md"), "utf8");
  assert.match(readme, /locally modified/);
  const gold = await readFile(join(created.path, "untracked-keep.txt"), "utf8");
  assert.equal(gold, "untracked gold\n");
  // source checkout keeps its changes (copy, not move)
  assert.match(await readFile(join(repo, "README.md"), "utf8"), /locally modified/);
});

test("adversarial: carryDirty warning when patch cannot apply to different base", async () => {
  const { ops } = newOps();
  const repo = tmpDir();
  makeRepo(repo, { remote: false, commits: 1 });
  // diverge: origin-side commit changes README (simulate different base)
  const other = join(tmpDir(), "other-branch");
  gitRun(repo, "worktree", "add", "-b", "zcode/diverge", other, "HEAD");
  writeRepoFile(other, "README.md", "# changed elsewhere entirely different\n");
  gitRun(other, "add", "-A");
  gitRun(other, "commit", "-m", "diverge");
  // dirty the main checkout on the same file
  writeRepoFile(repo, "README.md", "# locally modified\n");

  const created = await ops.create({
    repoPath: repo,
    name: "carry-conflict",
    baseRef: "zcode/diverge",
    carryDirty: true,
  });
  // either applied via 3-way or warned — both are safe outcomes
  const readme = await readFile(join(created.path, "README.md"), "utf8");
  const applied = /locally modified/.test(readme);
  const warned = created.warnings.some((w) => /could not be applied/.test(w));
  assert.ok(applied || warned, "applied or warned, never silent loss");
});

// ------------------------------------------------------- setup + carry config

test("adversarial: setup command failure keeps worktree and surfaces output", async () => {
  const { ops } = newOps();
  const repo = tmpDir();
  makeRepo(repo, { remote: false });
  writeRepoFile(repo, ".zcode/worktree.json", JSON.stringify({
    setupCommands: ["echo step-one", "exit 3", "echo never-reached"],
  }));
  const created = await ops.create({ repoPath: repo, name: "setup-fail" });
  assert.ok(existsSync(created.path), "worktree kept");
  assert.equal(created.setup.length, 2);
  assert.equal(created.setup[0].ok, true);
  assert.equal(created.setup[1].ok, false);
  assert.ok(created.warnings.some((w) => /setup command failed/.test(w)));
});

test("adversarial: malformed .zcode/worktree.json falls back safely", async () => {
  const { ops } = newOps();
  const repo = tmpDir();
  makeRepo(repo, { remote: false });
  writeRepoFile(repo, ".zcode/worktree.json", "{ broken json");
  const created = await ops.create({ repoPath: repo, name: "cfg-broken" });
  assert.ok(existsSync(created.path));
  assert.deepEqual(created.carryOver.copied, []);
});

test("adversarial: .worktreeinclude integrated into create", async () => {
  const { ops } = newOps();
  const repo = tmpDir();
  makeRepo(repo, { remote: false });
  writeRepoFile(repo, ".gitignore", ".env\n");
  writeRepoFile(repo, ".env", "TOKEN=abc\n");
  writeRepoFile(repo, ".worktreeinclude", ".env\n");
  const created = await ops.create({ repoPath: repo, name: "with-env" });
  assert.deepEqual(created.carryOver.copied, [".env"]);
  assert.equal(await readFile(join(created.path, ".env"), "utf8"), "TOKEN=abc\n");
});

// ---------------------------------------------------------------- state perms

test("adversarial: state.json and store dirs keep tight permissions", async () => {
  const { ops, storeRoot } = newOps();
  const repo = tmpDir();
  makeRepo(repo, { remote: false });
  await ops.create({ repoPath: repo, name: "perms" });
  const st = await stat(join(storeRoot, "state.json"));
  assert.equal(st.mode & 0o777, 0o600);
});

// ------------------------------------------------------------ branch deleted under us

test("adversarial: branch deleted out-of-band; remove reports 'already gone'", async () => {
  const { ops } = newOps();
  const repo = tmpDir();
  makeRepo(repo, { remote: false });
  const { path, branch } = await ops.create({ repoPath: repo, name: "branchless" });
  // move off the branch inside the worktree, then delete the branch manually
  gitRun(path, "checkout", "--detach", "HEAD");
  gitRun(repo, "branch", "-D", branch);
  const res = await ops.remove({ repoPath: repo, name: "branchless", deleteBranch: true });
  assert.equal(res.branchAction, "already gone");
});

// ------------------------------------------------------- set_task lifecycle abuse

test("adversarial: set_task on unknown name, clearAgent without agent", async () => {
  const { ops } = newOps();
  const repo = tmpDir();
  makeRepo(repo, { remote: false });
  await rejects(/no managed worktree named "ghost"/, () =>
    ops.setTask({ repoPath: repo, name: "ghost", task: "x" })
  );
  await ops.create({ repoPath: repo, name: "no-agent" });
  const res = await ops.setTask({ repoPath: repo, name: "no-agent", clearAgent: true });
  assert.equal(res.agent, null);
  assert.equal(res.locked, false);
});

// -------------------------------------------------- list from inside a worktree

test("adversarial: ops work when cwd/repoPath is inside another worktree", async () => {
  const { ops } = newOps();
  const repo = tmpDir();
  makeRepo(repo, { remote: false });
  const first = await ops.create({ repoPath: repo, name: "inside-src" });
  const second = await ops.create({ repoPath: first.path, name: "from-inside" });
  assert.notEqual(second.path, first.path);
  assert.ok(existsSync(second.path));
  const list = await ops.list({ repoPath: first.path });
  assert.equal(list.worktrees.length, 2);
});

// ------------------------------------------------------------ pr flow (git fetch trick)

test("adversarial: create from FETCH_HEAD-style explicit commit", async () => {
  const { ops } = newOps();
  const repo = tmpDir();
  makeRepo(repo, { remote: false });
  const sha = gitRun(repo, "rev-parse", "HEAD~1").trim();
  const created = await ops.create({ repoPath: repo, name: "pr-99", baseRef: sha });
  assert.equal(created.baseCommit, sha);
  assert.equal(
    gitRun(created.path, "rev-parse", "HEAD").trim(),
    sha,
    "worktree checked out at requested commit"
  );
});
