import { test } from "node:test";
import assert from "node:assert/strict";
import { symlink, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  carryOver,
  parseIncludeFile,
  selectByPatterns,
  globMatch,
} from "../../plugins/git-worktrees/mcp/lib/carryover.mjs";
import { makeRepo, tmpDir, writeRepoFile, git } from "../fixtures/helpers.mjs";

test("parseIncludeFile handles comments, blanks, and rejects parent traversal", () => {
  const { patterns, invalid } = parseIncludeFile(
    "# comment\n\n.env\nconfig/secrets.json\n../outside\n!.env.prod\n"
  );
  assert.deepEqual(patterns, [".env", "config/secrets.json", "!.env.prod"]);
  assert.equal(invalid.length, 1);
  assert.equal(invalid[0].line, "../outside");
});

test("selectByPatterns: basename, anchored, dir, negation, and **/ at root", () => {
  const files = [
    ".env",
    "notes.txt",
    "config/secrets.json",
    "config/sub/deep.key",
    "docs/notes.txt",
    "other/.env",
    "z.txt",
    "x/y/z.txt",
  ];
  assert.deepEqual(selectByPatterns(files, [".env"]), [".env", "other/.env"]);
  assert.deepEqual(selectByPatterns(files, ["/notes.txt"]), ["notes.txt"]);
  assert.deepEqual(selectByPatterns(files, ["config/"]), [
    "config/secrets.json",
    "config/sub/deep.key",
  ]);
  assert.deepEqual(selectByPatterns(files, ["*.txt", "!docs/"]), [
    "notes.txt",
    "x/y/z.txt",
    "z.txt",
  ]);
  assert.deepEqual(selectByPatterns(files, ["config/**"]), [
    "config/secrets.json",
    "config/sub/deep.key",
  ]);
  assert.deepEqual(selectByPatterns(files, ["**/z.txt"]), ["x/y/z.txt", "z.txt"]);
});

test("globMatch basics used by pattern selection", () => {
  assert.equal(globMatch("a/b/c.env", "a/**"), true);
  assert.equal(globMatch("a", "a/**"), false);
  assert.equal(globMatch("x/y/z.txt", "**/z.txt"), true);
  assert.equal(globMatch("z.txt", "**/z.txt"), false); // root match handled via patternMatches
});

test("carryOver: only gitignored matches copied; never overwrites; symlinks never carried", async () => {
  const repo = tmpDir();
  makeRepo(repo, { remote: false });
  writeRepoFile(repo, ".gitignore", ".env\nconfig/\n*.local\n");
  writeRepoFile(repo, ".env", "SECRET=1\n");
  writeRepoFile(repo, "config/secrets.json", '{"k":true}\n');
  writeRepoFile(repo, "notes.local", "note\n");
  writeRepoFile(repo, "README2.md", "tracked content\n");
  await git(repo, "add", "README2.md");
  await git(repo, "commit", "-m", "add tracked file");
  await symlink(".env", join(repo, "link.env")); // symlinked env — must never be carried

  const dest = tmpDir();
  // pre-create a conflicting file to prove no-overwrite
  await writeFile(join(dest, "notes.local"), "existing\n");

  const include = ".env\nconfig/\n*.local\nREADME2.md\nlink.env\n";
  const result = await carryOver(repo, dest, {
    includePatterns: parseIncludeFile(include).patterns,
  });

  assert.ok(result.copied.includes(".env"), `copied: ${result.copied.join(",")}`);
  assert.ok(result.copied.includes("config/secrets.json"));
  // tracked file matched a pattern but is not gitignored → refused by design
  assert.ok(!result.copied.includes("README2.md"));
  assert.ok(result.warnings.some((w) => /gitignored/.test(w)), "refusal warning present");
  // symlink skipped silently by the walker (never a candidate)
  assert.ok(!result.copied.includes("link.env"));
  // pre-existing destination file untouched
  assert.ok(!result.copied.includes("notes.local"));
  assert.ok(result.skipped.some((s) => s.path === "notes.local" && /not overwritten/.test(s.reason)));
  // content actually copied
  assert.equal(await readFile(join(dest, ".env"), "utf8"), "SECRET=1\n");
  assert.equal(await readFile(join(dest, "notes.local"), "utf8"), "existing\n");
});

test("carryOver: explicit copyFiles bypass ignore status but keep safety rules", async () => {
  const repo = tmpDir();
  makeRepo(repo, { remote: false });
  writeRepoFile(repo, "helpers/dev.env", "DEV=1\n"); // tracked (not ignored)
  await git(repo, "add", "-A");
  await git(repo, "commit", "-m", "add helpers");
  await symlink("helpers/dev.env", join(repo, "exp-link"));

  const dest = tmpDir();
  const result = await carryOver(repo, dest, {
    copyFiles: ["helpers/dev.env", "../escape", "/abs", "exp-link"],
  });

  assert.deepEqual(result.copied, ["helpers/dev.env"]);
  assert.equal(result.skipped.filter((s) => /safe relative/.test(s.reason)).length, 2);
  assert.ok(result.skipped.some((s) => s.path === "exp-link" && /symlink/.test(s.reason)));
  assert.equal(await readFile(join(dest, "helpers", "dev.env"), "utf8"), "DEV=1\n");
});

test("carryOver reports missing source files", async () => {
  const repo = tmpDir();
  makeRepo(repo, { remote: false });
  const dest = tmpDir();
  const result = await carryOver(repo, dest, { copyFiles: ["nope.txt"] });
  assert.ok(result.skipped.some((s) => s.path === "nope.txt" && /does not exist/.test(s.reason)));
});
