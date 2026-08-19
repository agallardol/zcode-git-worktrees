// All git interaction. execFile only — never a shell — so repo paths with
// spaces, quotes, or unicode are always safe. Timeouts guard against hung
// remotes (e.g. unreachable origin during a fetch).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

const execFileP = promisify(execFile);
export const GIT_TIMEOUT_MS = 30_000;
export const FETCH_TIMEOUT_MS = 20_000;
export class GitError extends Error {
  constructor(message, { stderr = "", code = null } = {}) {
    super(message);
    this.name = "GitError";
    this.stderr = stderr.trim();
    this.gitCode = code;
  }
}

async function git(args, { cwd, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  try {
    const { stdout } = await execFileP("git", args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
        LC_ALL: "C",
      },
    });
    return stdout;
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : "";
    throw new GitError(
      `git ${args[0]} failed: ${firstLine(stderr) || err.message}`,
      { stderr, code: err.code }
    );
  }
}

function firstLine(s) {
  return (s || "").split("\n").find((l) => l.trim().length > 0) || "";
}

// Resolve the "main" repository for any directory inside a git repo, even when
// the directory is itself a linked worktree (uses the common git dir). For bare
// repositories the bare dir itself is the "main" anchor.
export async function resolveMainRepo(cwd) {
  let commonDir;
  let topLevel = null;
  try {
    const out = await git(
      ["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"],
      { cwd }
    );
    const [commonDirRaw, topLevelRaw] = out.trim().split("\n");
    commonDir = commonDirRaw?.trim();
    topLevel = topLevelRaw?.trim() || null;
  } catch (err) {
    // --show-toplevel fails inside bare repos; retry with common dir only.
    try {
      const out = await git(
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        { cwd }
      );
      commonDir = out.trim();
    } catch {
      throw new GitError(
        `not a git repository: ${cwd} (${firstLine(err.stderr) || err.message})`
      );
    }
  }
  if (!commonDir) throw new GitError(`could not resolve git common dir for ${cwd}`);
  let mainPath;
  const parent = dirname(commonDir);
  if (
    commonDir.endsWith(".git") &&
    commonDir !== cwd &&
    (await refExistsFile(join(parent, ".git"), commonDir))
  ) {
    mainPath = parent; // normal repo: commonDir sits at <mainRepo>/.git
  } else if (topLevel && topLevel !== commonDir) {
    // linked worktree of a bare repo — anchor on the bare repo
    mainPath = commonDir;
  } else if (topLevel) {
    // bare repo cwd: toplevel absent; fall through to commonDir
    mainPath = topLevel;
  } else {
    mainPath = commonDir; // bare repo itself
  }
  return { mainPath, commonDir, currentWorktree: topLevel || null };
}

// True when <parent>/.git exists and its "gitdir:" content (linked worktree
// gitfile) or its realpath points at `commonDir`.
async function refExistsFile(gitfilePath, commonDir) {
  try {
    const st = await stat(gitfilePath);
    if (st.isDirectory()) {
      const a = await realpath(gitfilePath).catch(() => null);
      const b = await realpath(commonDir).catch(() => null);
      return a != null && a === b;
    }
    if (st.isFile()) {
      const content = await readFile(gitfilePath, "utf8");
      const m = content.match(/gitdir:\s*(\S+)/);
      return m ? m[1] === commonDir : false;
    }
    return false;
  } catch {
    return false;
  }
}

export async function listWorktrees(mainRepo) {
  const out = await git(["worktree", "list", "--porcelain"], { cwd: mainRepo });
  const entries = [];
  let cur = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur) entries.push(cur);
      cur = { path: line.slice("worktree ".length).trim() };
    } else if (!cur) {
      continue;
    } else if (line.startsWith("HEAD ")) {
      cur.head = line.slice(5).trim();
    } else if (line.startsWith("branch ")) {
      cur.branch = line.slice("branch ".length).trim();
    } else if (line.startsWith("detached")) {
      cur.detached = true;
    } else if (line.startsWith("bare")) {
      cur.bare = true;
    } else if (line.startsWith("locked")) {
      cur.locked = line.slice("locked".length).trim() || "locked";
    }
  }
  if (cur) entries.push(cur);
  return entries; // first entry is the main worktree per git docs
}

export async function hasCommits(repo) {
  try {
    await git(["rev-parse", "--verify", "HEAD"], { cwd: repo });
    return true;
  } catch {
    return false;
  }
}

export async function currentBranch(repo) {
  try {
    return await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo });
  } catch {
    return null;
  }
}

export async function originUrl(mainRepo) {
  try {
    const url = await git(["remote", "get-url", "origin"], { cwd: mainRepo });
    return url.trim() || null;
  } catch {
    return null;
  }
}

// Parse `git status --porcelain=v1 -b` into branch + dirty counters.
export async function statusSummary(repo) {
  const out = await git(["status", "--porcelain=v1", "-b", "--untracked-files=all"], {
    cwd: repo,
  });
  const lines = out.split("\n");
  const info = {
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
  };
  const header = lines[0] || "";
  if (header.startsWith("## ")) {
    const body = header.slice(3).trim();
    if (body.startsWith("HEAD detached at ")) {
      info.detached = true;
      info.detachedAt = body.slice("HEAD detached at ".length).trim();
    } else if (body === "No branch") {
      info.detached = true;
    } else {
      const dotIdx = body.indexOf("...");
      if (dotIdx >= 0) {
        info.branch = body.slice(0, dotIdx);
        const rest = body.slice(dotIdx + 3);
        const bracket = rest.indexOf(" [");
        info.upstream = bracket >= 0 ? rest.slice(0, bracket) : rest;
        const m = rest.match(/\[ahead (\d+)(?:, )?(?:behind (\d+))?\]|\[behind (\d+)\]/);
        if (m) {
          info.ahead = m[1] ? Number(m[1]) : 0;
          info.behind = m[2] ? Number(m[2]) : m[3] ? Number(m[3]) : 0;
        }
      } else {
        info.branch = body;
      }
    }
  }
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const x = line[0];
    const y = line[1];
    if (x === "?") info.untracked++;
    else {
      if (x !== " ") info.staged++;
      if (y !== " ") info.unstaged++;
    }
  }
  info.dirty = info.staged + info.unstaged + info.untracked;
  return info;
}

// Commits on `branch` not present on its upstream / origin counterpart.
// Returns {hasRemote, unpushed} — with no remote at all, unpushed counts
// commits since the worktree's base commit.
export async function unpushedCount(mainRepo, branch, baseCommit) {
  if (await refExists(mainRepo, `refs/heads/${branch}`)) {
    const cnt = await revListCount(mainRepo, `${branch}@{upstream}..${branch}`).catch(
      () => null
    );
    if (cnt != null) return { hasRemote: true, unpushed: cnt };
  }
  const originRef = await resolveRef(mainRepo, `origin/${branch}`).catch(() => null);
  if (originRef) {
    return {
      hasRemote: true,
      unpushed: await revListCount(mainRepo, `origin/${branch}..${branch}`),
    };
  }
  if (!baseCommit) return { hasRemote: false, unpushed: null };
  return {
    hasRemote: false,
    unpushed: await revListCount(mainRepo, `${baseCommit}..${branch}`),
  };
}

export async function revListCount(repo, range) {
  const out = await git(["rev-list", "--count", range], { cwd: repo });
  return Number(out.trim());
}

export async function resolveRef(repo, ref) {
  const out = await git(["rev-parse", "--verify", `${ref}^{commit}`], { cwd: repo });
  return out.trim();
}

export async function refExists(repo, ref) {
  try {
    await git(["rev-parse", "--verify", "--quiet", ref], { cwd: repo });
    return true;
  } catch {
    return false;
  }
}

// Fetch origin if we have never fetched, or FETCH_HEAD is older than maxAgeMs.
// Failures are returned, not thrown — callers fall back to local refs offline.
export async function fetchIfStale(mainRepo, maxAgeMs = 24 * 3600 * 1000) {
  const url = await originUrl(mainRepo);
  if (!url) return { attempted: false, reason: "no origin remote" };
  let stale = true;
  try {
    const commonDir = (await resolveMainRepo(mainRepo)).commonDir;
    const fetchHead = join(commonDir, "FETCH_HEAD");
    const st = await stat(fetchHead);
    if (Date.now() - st.mtimeMs < maxAgeMs) stale = false;
  } catch {
    // no FETCH_HEAD yet → stale
  }
  if (!stale) return { attempted: false, reason: "fresh" };
  try {
    await git(["fetch", "origin", "--prune"], {
      cwd: mainRepo,
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    return { attempted: true, ok: true };
  } catch (err) {
    return { attempted: true, ok: false, error: err.message };
  }
}

// Resolve the requested base ("fresh" | "head" | ref) to a concrete commit.
export async function resolveBase(mainRepo, base) {
  const warnings = [];
  if (base === "head") {
    return { commit: await resolveRef(mainRepo, "HEAD"), baseRef: "HEAD", warnings };
  }
  if (base === "fresh") {
    const fetchInfo = await fetchIfStale(mainRepo);
    if (fetchInfo.attempted && !fetchInfo.ok) {
      warnings.push(
        `could not fetch origin (${fetchInfo.error}); using last-known remote refs if present (they may be stale)`
      );
    }
    for (const ref of ["origin/HEAD", "origin/main", "origin/master"]) {
      try {
        return { commit: await resolveRef(mainRepo, ref), baseRef: ref, warnings };
      } catch {
        /* try next */
      }
    }
    if (!fetchInfo.attempted) {
      warnings.push("no origin remote; basing new worktree on local HEAD");
    } else if (fetchInfo.ok) {
      warnings.push("origin/HEAD, origin/main and origin/master not found; basing on local HEAD");
    }
    return { commit: await resolveRef(mainRepo, "HEAD"), baseRef: "HEAD", warnings };
  }
  // explicit ref (branch, tag, commit, or origin/...)
  try {
    return { commit: await resolveRef(mainRepo, base), baseRef: base, warnings };
  } catch (err) {
    throw new GitError(
      `base ref "${base}" not found in repository (tried as branch/tag/commit)`,
      { stderr: err.stderr }
    );
  }
}

export async function branchExists(mainRepo, branch) {
  return refExists(mainRepo, `refs/heads/${branch}`);
}

export async function worktreeAt(mainRepo, path) {
  const list = await listWorktrees(mainRepo);
  return list.find((w) => w.path === path) || null;
}

export async function createWorktree(mainRepo, path, branch, baseCommit, { noCheckout = false } = {}) {
  const args = ["worktree", "add", "-b", branch];
  if (noCheckout) args.push("--no-checkout");
  args.push(path, baseCommit);
  try {
    await git(args, { cwd: mainRepo });
  } catch (err) {
    const stderr = err.stderr || "";
    if (/already checked out at|is used by worktree/i.test(stderr)) {
      throw new GitError(
        `branch "${branch}" is already checked out in another worktree. ` +
          `Git allows a branch in only one worktree at a time — pick a different name, ` +
          `or remove the other worktree first (see /worktree).`,
        { stderr }
      );
    }
    if (/already exists/i.test(stderr) && /branch/i.test(stderr)) {
      throw new GitError(
        `branch "${branch}" already exists. Choose a different worktree name, or pass ` +
          `baseRef explicitly to base a new branch elsewhere.`,
        { stderr }
      );
    }
    if (/already exists and is not an empty directory|already registered/i.test(stderr)) {
      throw new GitError(
        `worktree path already exists or is registered: ${path}`,
        { stderr }
      );
    }
    throw err;
  }
}

export async function removeWorktree(mainRepo, path, { force = false } = {}) {
  const args = ["worktree", "remove"];
  if (force) args.push("--force");
  args.push(path);
  try {
    await git(args, { cwd: mainRepo });
  } catch (err) {
    const stderr = err.stderr || "";
    if (/contains modified or untracked files|dirty/i.test(stderr)) {
      throw new GitError(
        `worktree has uncommitted changes; pass force:true to remove anyway ` +
          `(a snapshot is always taken first)`,
        { stderr }
      );
    }
    if (/is locked/i.test(stderr)) {
      throw new GitError(
        `worktree is locked (likely in use by a running agent); pass force:true to unlock and remove`,
        { stderr }
      );
    }
    if (/validation failed/i.test(stderr)) {
      throw new GitError(
        `worktree directory no longer matches git metadata; run prune or pass force:true`,
        { stderr }
      );
    }
    throw err;
  }
}

export async function pruneWorktrees(mainRepo) {
  await git(["worktree", "prune"], { cwd: mainRepo });
}

export async function lockWorktree(mainRepo, path, reason) {
  const args = ["worktree", "lock"];
  if (reason) args.push("--reason", reason);
  args.push(path);
  await git(args, { cwd: mainRepo });
}

export async function unlockWorktree(mainRepo, path) {
  await git(["worktree", "unlock", path], { cwd: mainRepo });
}

export async function deleteBranch(mainRepo, branch, { force = false } = {}) {
  const finalArgs = ["branch", force ? "-D" : "-d", branch];
  try {
    await git(finalArgs, { cwd: mainRepo });
  } catch (err) {
    const stderr = err.stderr || "";
    if (/not fully merged/i.test(stderr)) {
      throw new GitError(
        `branch "${branch}" has commits that are not merged anywhere; ` +
          `use force:true to delete it anyway`,
        { stderr }
      );
    }
    throw err;
  }
}

export async function branchMergedInto(mainRepo, branch, intoRef) {
  try {
    await git(["merge-base", "--is-ancestor", branch, intoRef], { cwd: mainRepo });
    return true;
  } catch {
    return false;
  }
}

// Diff of all tracked changes (staged + unstaged) relative to HEAD.
export async function trackedDiff(worktree) {
  return git(["diff", "HEAD"], { cwd: worktree });
}

// Untracked files (respecting .gitignore), NUL-separated.
export async function untrackedFiles(worktree) {
  const out = await git(["ls-files", "--others", "--exclude-standard", "-z"], {
    cwd: worktree,
  });
  return out.split("\0").filter(Boolean);
}

export async function applyPatch(worktree, patchPath) {
  try {
    await git(["apply", "--3way", patchPath], { cwd: worktree });
  } catch (err) {
    throw new GitError(
      `could not apply changes onto this base (likely conflicts); the snapshot patch is at ${patchPath}`,
      { stderr: err.stderr }
    );
  }
}

// Rough size of a directory in bytes via du (kilobyte blocks). Best-effort.
export async function dirSize(path) {
  try {
    const out = await execFileP("du", ["-sk", path], {
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
    const kb = Number((out.stdout || "").split("\t")[0]);
    return Number.isFinite(kb) ? kb * 1024 : null;
  } catch {
    return null;
  }
}

// Rough "how much space will a new checkout need" estimate: twice the size of
// the git object store + working tree of the main checkout, floor 1 GiB advice.
export async function estimateCheckoutNeed(mainRepo) {
  const size = await dirSize(mainRepo);
  if (size == null) return null;
  return Math.max(2 * size, 512 * 1024 * 1024);
}

export async function headCommit(worktree) {
  try {
    return (await git(["rev-parse", "HEAD"], { cwd: worktree })).trim();
  } catch {
    return null;
  }
}

export async function commitLog(worktree, limit = 5) {
  try {
    const out = await git(
      ["log", "--oneline", "--no-decorate", `-n`, String(limit)],
      { cwd: worktree }
    );
    return out.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

export async function readFileIfExists(path, encoding = "utf8") {
  try {
    return await readFile(path, encoding);
  } catch {
    return null;
  }
}
