// Store location resolution + auto-session marker (lib/store.mjs).
// resolveStoreRoot() depends on process env and $HOME, so the interesting
// cases run in child processes with isolated environments.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readAutoSession, writeAutoSession } from "../../plugins/git-worktrees/mcp/lib/store.mjs";
import { tmpDir } from "../fixtures/helpers.mjs";

const CODE = `
import { resolveStoreRoot } from "${join(import.meta.dirname, "../../plugins/git-worktrees/mcp/lib/store.mjs")}";
process.stdout.write(await resolveStoreRoot());
`;

function resolveInChild(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", CODE], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("close", () => resolve(out.trim()));
  });
}

test("resolveStoreRoot: env override wins, placeholders ignored", async () => {
  const custom = tmpDir();
  assert.equal(await resolveInChild({ ZCODE_WORKTREE_STORE_ROOT: custom }), custom);
  assert.equal(
    await resolveInChild({ ZCODE_WORKTREE_STORE_ROOT: "${user_config.worktree_root}" }),
    join(await realHome(), ".zcode", "worktrees")
  );
  // ZCODE_WORKTREE_ROOT (manifest userConfig) also honored, ~ expanded
  assert.equal(await resolveInChild({ ZCODE_WORKTREE_ROOT: "~/wt-test" }), join(await realHome(), "wt-test"));
});

test("resolveStoreRoot: pointer file redirects the default root", async () => {
  const fakeHome = tmpDir();
  const custom = tmpDir();
  await mkdir(join(fakeHome, ".zcode", "worktrees"), { recursive: true });
  await writeFile(
    join(fakeHome, ".zcode", "worktrees", "store-location.json"),
    JSON.stringify({ storeRoot: custom })
  );
  assert.equal(
    await resolveInChild({ HOME: fakeHome, ZCODE_WORKTREE_STORE_ROOT: "", ZCODE_WORKTREE_ROOT: "" }),
    custom
  );
});

test("resolveStoreRoot: defaults to ~/.zcode/worktrees without pointer", async () => {
  const fakeHome = tmpDir();
  assert.equal(
    await resolveInChild({ HOME: fakeHome, ZCODE_WORKTREE_STORE_ROOT: "", ZCODE_WORKTREE_ROOT: "" }),
    join(fakeHome, ".zcode", "worktrees")
  );
});

test("auto-session marker: enabled by default, explicit off persists, corrupt fails to default", async () => {
  const root = tmpDir();
  assert.equal((await readAutoSession(root)).enabled, true, "missing marker → default ON");
  assert.equal((await readAutoSession(root)).explicit, false);

  const written = await writeAutoSession(root, true);
  assert.equal(written.enabled, true);
  assert.equal((await readAutoSession(root)).explicit, true);

  await writeAutoSession(root, false);
  const off = await readAutoSession(root);
  assert.equal(off.enabled, false, "explicit opt-out persists");
  assert.equal(off.explicit, true);

  await writeFile(join(root, "auto-session.json"), "garbage{");
  const corrupt = await readAutoSession(root);
  assert.equal(corrupt.enabled, true, "corrupt marker falls back to default (ON)");
  assert.equal(corrupt.explicit, false);
});

async function realHome() {
  const { homedir } = await import("node:os");
  return homedir();
}
