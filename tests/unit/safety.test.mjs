import { test } from "node:test";
import assert from "node:assert/strict";
import { symlink, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  validateName,
  ensureRealDir,
  checkCaseCollision,
  checkFreeSpace,
} from "../../plugins/git-worktrees/mcp/lib/safety.mjs";
import { globMatch } from "../../plugins/git-worktrees/mcp/lib/carryover.mjs";
import { tmpDir } from "../fixtures/helpers.mjs";

const ACCEPT = ["a", "fix-auth", "Fix_Auth.2", "pr-1234", "z", "a-b_c.d", "x1"];
const REJECT = [
  ["", "empty"],
  ["   ", "whitespace"],
  [" foo", "leading space"],
  ["foo ", "trailing space"],
  ["../evil", "traversal"],
  ["..", "dots only"],
  [".", "dot"],
  ["...", "dots"],
  [".git", "git dir"],
  [".GIT", "git dir upper"],
  ["a/b", "slash"],
  ["a\\b", "backslash"],
  ["foo..bar", "double dot"],
  ["foo.", "trailing dot"],
  [".foo", "leading dot"],
  ["-foo", "leading dash"],
  ["_foo", "leading underscore"],
  ["foo.lock", "lock suffix"],
  ["foo~bar", "tilde"],
  ["foo^bar", "caret"],
  ["foo:bar", "colon"],
  ["foo bar", "space inside"],
  ["über", "unicode"],
  ["emoji-😀", "emoji"],
  ["a".repeat(65), "too long"],
];

test("validateName accepts safe names", () => {
  for (const name of ACCEPT) {
    const res = validateName(name);
    assert.equal(res.ok, true, `expected accept: ${name}`);
    assert.equal(res.name, name.trim() === name ? name : name.trim());
  }
});

test("validateName rejects unsafe names", () => {
  for (const [name, why] of REJECT) {
    const res = validateName(name);
    assert.equal(res.ok, false, `expected reject (${why}): ${JSON.stringify(name)}`);
    assert.ok(res.error.length > 0);
  }
});

test("validateName rejects non-strings", () => {
  assert.equal(validateName(null).ok, false);
  assert.equal(validateName(42).ok, false);
  assert.equal(validateName({}).ok, false);
  assert.equal(validateName(["a"]).ok, false);
});

test("ensureRealDir creates nested dirs below a trusted prefix", async () => {
  const base = tmpDir();
  const target = join(base, "a", "b", "c");
  await ensureRealDir(target, base);
  const { stat } = await import("node:fs/promises");
  assert.equal((await stat(target)).isDirectory(), true);
});

test("ensureRealDir refuses symlinked components below the trusted prefix", async () => {
  const base = tmpDir();
  await mkdir(join(base, "real"));
  await symlink(join(base, "real"), join(base, "link"));
  await assert.rejects(ensureRealDir(join(base, "link", "sub"), base), /symlink/);
});

test("ensureRealDir refuses symlink at final component too", async () => {
  const base = tmpDir();
  await mkdir(join(base, "elsewhere"), { recursive: true });
  await ensureRealDir(join(base, "parent"), base);
  await symlink(join(base, "elsewhere"), join(base, "parent", "trap"));
  await assert.rejects(ensureRealDir(join(base, "parent", "trap", "x"), base), /symlink/);
});

test("ensureRealDir rejects paths outside the trusted prefix", async () => {
  const base = tmpDir();
  await assert.rejects(ensureRealDir(join(base, "..", "escape"), base), /trusted prefix/);
});

test("checkCaseCollision detects case-insensitive siblings", async () => {
  const base = tmpDir();
  await mkdir(join(base, "foo"));
  // exact same name is not this function's concern (existence checks catch it)
  assert.equal((await checkCaseCollision(base, "foo")).ok, true);
  assert.equal((await checkCaseCollision(base, "FOO")).ok, false);
  assert.equal((await checkCaseCollision(base, "bar")).ok, true);
  // missing parent dir → no collision
  assert.equal((await checkCaseCollision(join(base, "nope"), "x")).ok, true);
});

test("checkFreeSpace reports ok and warn levels", async () => {
  const base = tmpDir();
  const ok = await checkFreeSpace(base, 1024);
  assert.equal(ok.level, "ok");
  const warn = await checkFreeSpace(base, 2n ** 62n);
  assert.equal(warn.level, "warn");
  assert.ok(warn.message.includes("free"));
});

test("globMatch is a pure glob (basename semantics live in pattern matching)", () => {
  assert.equal(globMatch(".env", ".env"), true);
  assert.equal(globMatch("foo.txt", "*.txt"), true);
  assert.equal(globMatch("foo.txtX", "*.txt"), false);
  assert.equal(globMatch("a/b.env", "*.env"), false); // '*' stays within a segment
  assert.equal(globMatch("deep/dir/x", "deep/**"), true);
  assert.equal(globMatch("deep/x", "deep/**"), true);
  assert.equal(globMatch("other/x", "deep/**"), false);
  assert.equal(globMatch("foo?bar", "foo?bar"), true); // '?' in glob matches the literal '?'
  assert.equal(globMatch("fooXbar", "foo?bar"), true);
  assert.equal(globMatch("foo/bar", "foo?bar"), false); // '?' never matches '/'
});
