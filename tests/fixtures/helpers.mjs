// Shared fixture builders for all test suites. Everything runs in tmp dirs;
// repos get deterministic identities and (optionally) a local bare "origin".
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    ...opts,
  });
}

export function git(cwd, ...args) {
  return run("git", args, { cwd });
}

export function tmpDir(prefix = "zcode-wt-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function writeRepoFile(dir, rel, content) {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  return p;
}

export function makeRepo(dir, { commits = 2, remote = true, files = null } = {}) {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test User");
  const contents =
    files || { "README.md": "# test\n", "src/app.js": "console.log(1);\n" };
  for (const [rel, content] of Object.entries(contents)) {
    writeRepoFile(dir, rel, content);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "initial commit");
  for (let i = 2; i <= commits; i++) {
    writeFileSync(join(dir, "README.md"), `# test v${i}\n`);
    git(dir, "add", "-A");
    git(dir, "commit", "-m", `commit ${i}`);
  }
  if (remote) {
    const origin = `${dir}-origin.git`;
    run("git", ["clone", "--bare", "--quiet", dir, origin]);
    git(dir, "remote", "add", "origin", origin);
    git(dir, "push", "-u", "origin", "main");
    git(dir, "remote", "set-head", "origin", "-a");
  }
  return dir;
}

// Fresh Ops instance pointed at a fresh store.
export async function freshOps() {
  const storeRoot = tmpDir("zcode-wt-store-");
  const { Ops } = await import(
    "../../plugins/git-worktrees/mcp/lib/ops.mjs"
  );
  return { ops: new Ops({ storeRoot, defaultBase: "fresh", maxAgeDays: 14, maxCount: 15 }), storeRoot };
}
