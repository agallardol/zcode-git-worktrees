// Carry-over of gitignored local files (.env & friends) into new worktrees.
//
// Two sources:
//  1. `.worktreeinclude` at the repo root — gitignore-style patterns. A file is
//     copied only if it matches a pattern AND is confirmed gitignored via
//     `git check-ignore` (safe by construction: tracked files are never
//     duplicated — same rule as Claude Code / Codex `.worktreeinclude`).
//  2. `copyFiles` in `.zcode/worktree.json` — explicit relative paths, copied
//     regardless of ignore status (explicit user intent).
//
// Symlinks are never followed or copied; existing destination files are never
// overwritten.
import { spawn } from "node:child_process";
import { lstat, readdir, cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

const WALK_ENTRY_LIMIT = 20_000;
const DEFAULT_SKIP_DIRS = [".git", "node_modules"];

export function parseIncludeFile(content) {
  const patterns = [];
  const invalid = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line || line.startsWith("#")) continue;
    if (line.includes("..")) {
      invalid.push({ line, reason: "parent-relative patterns are not allowed" });
      continue;
    }
    patterns.push(line);
  }
  return { patterns, invalid };
}

// glob supporting * (within segment), ? (within segment), ** (any segments).
export function globMatch(text, glob) {
  const parts = glob.split("**");
  const rxSource = parts
    .map((part) =>
      part
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]")
    )
    .join(".*");
  return new RegExp(`^${rxSource}$`).test(text);
}

// Does `relPath` (posix-separated, repo-relative) match one gitignore-style
// `pattern`? Handles anchored patterns, path patterns, basename patterns, and
// leading "**/" (which also matches at the root per gitignore semantics).
function patternMatches(relPath, pattern) {
  const segs = relPath.split("/");
  const name = segs[segs.length - 1];

  if (pattern.includes("/")) {
    const anchored = pattern.startsWith("/");
    const body = anchored ? pattern.slice(1) : pattern;
    if (globMatch(relPath, body)) return true;
    // gitignore: "**/foo" matches "foo" at any depth including the root
    if (body.startsWith("**/") && globMatch(relPath, body.slice(3))) return true;
    if (!anchored) {
      // "config/env*" matches "deep/config/env.local"
      for (let i = 1; i < segs.length; i++) {
        if (globMatch(segs.slice(i).join("/"), body)) return true;
      }
    }
    return false;
  }
  // basename pattern: match the file, or any ancestor directory segment
  return segs.some((s) => globMatch(s, pattern)) || globMatch(name, pattern);
}

// Select files matching the include patterns (positives minus negations).
export function selectByPatterns(files, patterns) {
  const matched = new Set();
  const excluded = new Set();
  for (const rawPattern of patterns) {
    const negate = rawPattern.startsWith("!");
    const pattern = negate ? rawPattern.slice(1) : rawPattern;
    const dirOnly = pattern.endsWith("/");
    const body = dirOnly ? pattern.slice(0, -1) : pattern;
    const target = negate ? excluded : matched;
    for (const f of files) {
      if (patternMatches(f, body)) {
        target.add(f);
      } else if (dirOnly) {
        // dir-only pattern: files under a matching directory path
        const segs = f.split("/");
        for (let i = 1; i < segs.length; i++) {
          if (patternMatches(segs.slice(0, i).join("/"), body)) {
            target.add(f);
            break;
          }
        }
      }
    }
  }
  return [...matched].filter((f) => !excluded.has(f)).sort();
}

export async function walkRepo(root, { skipDirs = DEFAULT_SKIP_DIRS } = {}) {
  const files = [];
  let entries = 0;
  async function walk(dir, rel) {
    let list;
    try {
      list = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of list) {
      if (++entries > WALK_ENTRY_LIMIT) return;
      if (ent.name === ".git") continue;
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      const full = join(dir, ent.name);
      let st;
      try {
        st = await lstat(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        if (skipDirs.includes(ent.name)) continue;
        await walk(full, relPath);
      } else if (ent.isFile()) {
        files.push(relPath);
      }
    }
  }
  await walk(root, "");
  return files;
}

// `git check-ignore --stdin`, fed safely via spawn (execFile has no stdin).
async function checkIgnore(cwd, paths) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "git",
      ["check-ignore", "--stdin", "--"],
      { cwd }
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      // exit 0: some paths ignored; exit 1: none ignored; 128: error
      if (code === 0 || code === 1) resolve(new Set(out.split("\n").filter(Boolean)));
      else reject(new Error(`git check-ignore failed: ${err.trim()}`));
    });
    child.stdin.on("error", () => {}); // EPIPE if git exits early
    child.stdin.end(paths.join("\n") + "\n");
  });
}

export async function carryOver(
  mainRepo,
  destWorktree,
  { includePatterns = [], copyFiles = [] } = {}
) {
  const result = { copied: [], skipped: [], warnings: [] };
  const walked = await walkRepo(mainRepo);

  let candidates = [];
  if (includePatterns.length > 0 && walked.length > 0) {
    const preFilter = selectByPatterns(walked, includePatterns);
    if (preFilter.length > 0) {
      try {
        const ignored = await checkIgnore(mainRepo, preFilter);
        candidates = preFilter.filter((f) => ignored.has(f));
        const refused = preFilter.length - candidates.length;
        if (refused > 0) {
          result.warnings.push(
            `${refused} matched file(s) skipped: .worktreeinclude only carries files that are gitignored (tracked files are never duplicated)`
          );
        }
      } catch {
        result.warnings.push(
          "could not run git check-ignore; no .worktreeinclude files were carried over"
        );
      }
    }
  }

  // Explicit copyFiles bypass the ignore filter but keep every safety rule.
  const all = [...candidates];
  for (const rel of copyFiles) {
    if (typeof rel !== "string" || rel.includes("..") || rel.startsWith("/")) {
      result.skipped.push({ path: String(rel), reason: "not a safe relative path" });
      continue;
    }
    if (!all.includes(rel)) all.push(rel);
  }

  for (const rel of all) {
    const src = join(mainRepo, rel);
    const dst = join(destWorktree, rel);
    let st;
    try {
      st = await lstat(src);
    } catch {
      result.skipped.push({ path: rel, reason: "does not exist in main checkout" });
      continue;
    }
    if (st.isSymbolicLink()) {
      result.skipped.push({ path: rel, reason: "symlinks are never carried over" });
      continue;
    }
    if (!st.isFile()) {
      result.skipped.push({ path: rel, reason: "not a regular file" });
      continue;
    }
    try {
      await lstat(dst);
      result.skipped.push({
        path: rel,
        reason: "already exists in worktree (not overwritten)",
      });
      continue;
    } catch {
      /* destination free — proceed */
    }
    try {
      await mkdir(dirname(dst), { recursive: true });
      await cp(src, dst, { force: false, preserveTimestamps: true });
      result.copied.push(rel);
    } catch (err) {
      result.skipped.push({ path: rel, reason: `copy failed: ${err.message}` });
    }
  }
  return result;
}
