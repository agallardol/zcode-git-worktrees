// High-level worktree operations shared by the MCP server (and tests).
// Everything flows through ctx(): resolve repo → load+reconcile state → act.
import { lstat, readFile, rm, cp, mkdir, realpath, writeFile, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname, join } from "node:path";
import * as git from "./git.mjs";
import { StateStore } from "./state.mjs";
import {
  checkCaseCollision,
  checkFreeSpace,
  ensureRealDir,
  validateName,
  fmt,
} from "./safety.mjs";
import { friendlyName } from "./names.mjs";
import { carryOver, parseIncludeFile } from "./carryover.mjs";
import { takeSnapshot } from "./snapshot.mjs";
import { LockManager } from "./lock.mjs";
import { readAutoSession, writeAutoSession } from "./store.mjs";

const execFileP = promisify(execFile);
const SETUP_TIMEOUT_MS = 10 * 60_000;

export class OpsError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "OpsError";
    this.details = details;
  }
}

async function pathExists(p) {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfExists(p) {
  try {
    return JSON.parse(await readFile(p, "utf8"));
  } catch {
    return null;
  }
}

export class Ops {
  constructor({
    storeRoot,
    defaultBase = "fresh",
    maxAgeDays = 14,
    maxCount = 15,
  } = {}) {
    this.storeRoot = storeRoot;
    this.defaultBase = defaultBase;
    this.maxAgeDays = maxAgeDays;
    this.maxCount = maxCount;
  }

  snapshotsRoot(slug) {
    return join(this._canonRoot || this.storeRoot, "snapshots", slug);
  }

  // The canonical (symlink-resolved) store root; created on first use. Worktree
  // paths are always built below it so the symlink guard has a clean boundary.
  async ensureStoreRoot() {
    if (!this._canonRoot) {
      await mkdir(this.storeRoot, { recursive: true, mode: 0o755 });
      this._canonRoot = await realpath(this.storeRoot);
    }
    return this._canonRoot;
  }

  // Every public operation runs under the store lock: state is
  // load-modify-save, and both intra-process interleaving and multiple MCP
  // server processes (one per session) would otherwise lose updates.
  async withLock(fn) {
    if (!this._lock) {
      const root = await this.ensureStoreRoot();
      this._lock = new LockManager(join(root, ".lock"));
    }
    return this._lock.run(fn);
  }

  async ctx(repoPath) {
    const cwd = repoPath || process.cwd();
    const resolved = await git.resolveMainRepo(cwd); // throws outside a repo
    const canonRoot = await this.ensureStoreRoot();
    const store = new StateStore(this.storeRoot);
    await store.load();
    await store.dropDeadProjects();
    const gitList = await git.listWorktrees(resolved.mainPath);
    const originUrl = await git.originUrl(resolved.mainPath);
    const project = store.ensureProject(resolved.mainPath, { originUrl });
    // Reconcile against the canonical root: worktree paths recorded by create()
    // are canonical, and on macOS the lexical tmp path (/var/…) differs from
    // the canonical one (/private/var/…) — comparing mixed forms breaks adoption.
    const reconcile = await store.reconcileProject(resolved.mainPath, gitList, {
      storeRoot: canonRoot,
    });
    await store.save();
    return { cwd, ...resolved, canonRoot, store, project, gitList, originUrl, reconcile };
  }

  findEntry(ctx, name) {
    const entry = ctx.store.worktree(ctx.mainPath, name);
    if (!entry) {
      const names = Object.keys(ctx.project.worktrees);
      throw new OpsError(
        `no managed worktree named "${name}" in this repository` +
          (names.length ? ` (known: ${names.join(", ")})` : " (none created yet — use /worktree:new)"),
        { knownNames: names }
      );
    }
    return entry;
  }

  // ---- project config (.zcode/worktree.json + .worktreeinclude) ----

  async projectConfig(ctx) {
    const cfg = (await readJsonIfExists(join(ctx.mainPath, ".zcode", "worktree.json"))) || {};
    const bad = [];
    for (const key of ["copyFiles", "setupCommands", "preRemoveCommands"]) {
      if (cfg[key] != null && !Array.isArray(cfg[key])) {
        bad.push(key);
        cfg[key] = [];
      } else {
        cfg[key] = (cfg[key] || []).filter((x) => typeof x === "string");
      }
    }
    const includeRaw = await git.readFileIfExists(join(ctx.mainPath, ".worktreeinclude"));
    const include = includeRaw == null ? { patterns: [], invalid: [] } : parseIncludeFile(includeRaw);
    return { config: cfg, include, configWarnings: bad.map((k) => `${k} must be an array of strings — ignored`) };
  }

  async runCommands(commands, cwd, { label }) {
    const results = [];
    for (const command of commands) {
      try {
        const { stdout, stderr } = await execFileP(command, {
          cwd,
          shell: true, // setupCommands are shell one-liners by design (user-authored in their repo)
          timeout: SETUP_TIMEOUT_MS,
          maxBuffer: 16 * 1024 * 1024,
          env: { ...process.env, ZCODE_WORKTREE_PATH: cwd },
        });
        results.push({ command, ok: true, output: tail(stdout + stderr) });
      } catch (err) {
        results.push({
          command,
          ok: false,
          output: tail((err.stdout || "") + (err.stderr || "") + err.message),
        });
        break; // stop at first failure; worktree is kept, failure surfaced
      }
    }
    return results;
  }

  // Best-effort activity timestamp: mtime of the worktree's HEAD file inside
  // the common git dir (touched on checkouts/commits in that worktree).
  async activityAt(entry) {
    try {
      const gitfile = await readFile(join(entry.path, ".git"), "utf8");
      const m = gitfile.match(/gitdir:\s*(\S+)/);
      if (!m) return entry.lastActivityAt || entry.createdAt;
      const headPath = join(m[1], "HEAD");
      const st = await lstat(headPath);
      const candidate = new Date(st.mtimeMs).toISOString();
      const recorded = entry.lastActivityAt || entry.createdAt;
      return candidate > recorded ? candidate : recorded;
    } catch {
      return entry.lastActivityAt || entry.createdAt;
    }
  }

  async enrichEntry(entry, ctx) {
    const exists = await pathExists(entry.path);
    const [status, size] = await Promise.all([
      exists ? git.statusSummary(entry.path).catch(() => null) : null,
      exists ? git.dirSize(entry.path) : null,
    ]);
    const lastActivityAt = await this.activityAt(entry);
    return {
      name: entry.name,
      path: entry.path,
      branch: entry.branch,
      base: entry.base,
      baseCommit: entry.baseCommit,
      task: entry.task || null,
      agent: entry.agent || null,
      session: entry.session || null,
      locked: Boolean(entry.locked),
      lockedByUs: Boolean(entry.lockedByUs),
      createdAt: entry.createdAt,
      lastActivityAt,
      exists,
      sizeBytes: size,
      dirty: status ? status.staged + status.unstaged + status.untracked : null,
      staged: status?.staged ?? null,
      unstaged: status?.unstaged ?? null,
      untracked: status?.untracked ?? null,
      ahead: status?.ahead ?? null,
      behind: status?.behind ?? null,
      snapshots: (entry.snapshots || []).length,
      adopted: Boolean(entry.adopted),
    };
  }

  // ---- tools (public methods lock; internal cross-calls use the _ variants
  // to stay reentrant — nesting public calls would deadlock on the queue) ----

  async list(args = {}) {
    return this.withLock(() => this._list(args));
  }

  async create(args = {}) {
    return this.withLock(() => this._create(args));
  }

  async status(args = {}) {
    return this.withLock(() => this._status(args));
  }

  async remove(args = {}) {
    return this.withLock(() => this._remove(args));
  }

  async cleanup(args = {}) {
    return this.withLock(() => this._cleanup(args));
  }

  async prune(args = {}) {
    return this.withLock(() => this._prune(args));
  }

  async snapshot(args = {}) {
    return this.withLock(() => this._snapshot(args));
  }

  async setTask(args = {}) {
    return this.withLock(() => this._setTask(args));
  }

  async autoSession(args = {}) {
    return this.withLock(() => this._autoSession(args));
  }

  // Get/set the auto-session mode marker. When enabled, the SessionStart hook
  // gives each new session in a repo's main checkout its own worktree.
  async _autoSession({ enabled } = {}) {
    const root = await this.ensureStoreRoot();
    if (enabled === undefined) {
      const current = await readAutoSession(root);
      return {
        ...current,
        path: join(root, "auto-session.json"),
        summary: `auto session worktrees are ${current.enabled ? "ENABLED" : "disabled"}`,
      };
    }
    const result = await writeAutoSession(root, enabled);
    return {
      ...result,
      summary: enabled
        ? "auto session worktrees ENABLED — new sessions in a repo's main checkout get their own worktree (current sessions unaffected; /worktree:auto off disables)"
        : "auto session worktrees disabled — new sessions run normally in the main checkout",
    };
  }

  async _list({ repoPath } = {}) {
    const ctx = await this.ctx(repoPath);
    const entries = await Promise.all(
      Object.values(ctx.project.worktrees).map((e) => this.enrichEntry(e, ctx))
    );
    entries.sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : -1));
    const mainStatus = await git.statusSummary(ctx.mainPath).catch(() => null);
    let freeBytes = null;
    try {
      const { freeBytes: f } = await checkFreeSpace(this.storeRoot, null);
      freeBytes = f == null ? null : Number(f);
    } catch {
      /* statfs unavailable */
    }
    return {
      project: {
        mainPath: ctx.mainPath,
        slug: ctx.project.slug,
        originUrl: ctx.originUrl,
        branch: mainStatus?.branch || null,
        dirty: mainStatus ? mainStatus.staged + mainStatus.unstaged + mainStatus.untracked : null,
      },
      storeRoot: this.storeRoot,
      worktrees: entries,
      freeBytes,
      reconciled: ctx.reconcile,
      summary: renderList(entries),
    };
  }

  async _create({ repoPath, name, baseRef, task, carryDirty, sessionId } = {}) {
    const ctx = await this.ctx(repoPath);

    if (!(await git.hasCommits(ctx.mainPath))) {
      throw new OpsError(
        "repository has no commits yet — make an initial commit before creating worktrees"
      );
    }

    // name
    let validated = null;
    if (name != null) {
      validated = validateName(name);
      if (!validated.ok) throw new OpsError(`invalid worktree name: ${validated.error}`);
    } else {
      const taken = new Set([
        ...Object.keys(ctx.project.worktrees),
        ...ctx.gitList.map((w) => basename(w.path)),
      ]);
      validated = { ok: true, name: friendlyName(taken) };
    }
    const finalName = validated.name;

    // Paths + symlink guard first: they produce the friendliest errors for
    // collisions (case-insensitive twins, existing worktrees).
    const canonRoot = await this.ensureStoreRoot();
    const projectDir = join(canonRoot, ctx.project.slug);
    await ensureRealDir(projectDir, canonRoot);
    const collision = await checkCaseCollision(projectDir, finalName);
    if (!collision.ok) throw new OpsError(collision.error);
    const wtPath = join(projectDir, finalName);
    // Guard the FULL path: a symlink planted at the final component would let
    // git write through it into arbitrary locations.
    await ensureRealDir(wtPath, canonRoot);
    if (ctx.gitList.some((w) => basename(w.path) === finalName)) {
      throw new OpsError(`a worktree named "${finalName}" already exists in this repository`);
    }

    // Branch checks up front for precise errors.
    const branch = `zcode/${finalName}`;
    if (await git.branchExists(ctx.mainPath, branch)) {
      throw new OpsError(
        `branch "${branch}" already exists — pick another name, or remove the worktree using it (see /worktree)`
      );
    }

    // base
    const base = baseRef ?? this.defaultBase;
    let resolvedBase;
    try {
      resolvedBase = await git.resolveBase(ctx.mainPath, base);
    } catch (err) {
      if (/not a valid commit|unknown revision/i.test(err.message) && base === "head") {
        throw new OpsError("could not resolve HEAD — does the repository have any commits?");
      }
      throw err;
    }

    // free space
    const need = await git.estimateCheckoutNeed(ctx.mainPath);
    const space = await checkFreeSpace(projectDir, need);
    if (space.level === "block") throw new OpsError(space.message);

    // create (rolling back the branch if git fails halfway — a failed
    // `worktree add` can leave a freshly created branch behind)
    try {
      await git.createWorktree(ctx.mainPath, wtPath, branch, resolvedBase.commit);
    } catch (err) {
      if (await git.branchExists(ctx.mainPath, branch)) {
        await git.deleteBranch(ctx.mainPath, branch, { force: true }).catch(() => {});
      }
      throw err;
    }

    const warnings = [...resolvedBase.warnings];
    if (space.level === "warn") warnings.push(space.message);

    // carry-over (.worktreeinclude + copyFiles)
    const { config, include, configWarnings } = await this.projectConfig(ctx);
    warnings.push(...configWarnings);
    if (include.invalid.length > 0) {
      warnings.push(
        `${include.invalid.length} invalid .worktreeinclude line(s) skipped: ` +
          include.invalid.map((i) => `"${i.line}" (${i.reason})`).join(", ")
      );
    }
    const carry = await carryOver(ctx.mainPath, wtPath, {
      includePatterns: include.patterns,
      copyFiles: config.copyFiles,
    });

    // optional: bring uncommitted changes from the current checkout
    let carryDirtyResult = null;
    const srcWorktree = ctx.currentWorktree || ctx.mainPath;
    if (carryDirty) {
      carryDirtyResult = await this.carryDirtyChanges(srcWorktree, wtPath, warnings);
    } else {
      const srcStatus = await git.statusSummary(srcWorktree).catch(() => null);
      if (srcStatus && srcStatus.dirty > 0) {
        warnings.push(
          `current checkout has ${srcStatus.dirty} uncommitted change(s); they were NOT carried over (pass carryDirty:true to include them)`
        );
      }
    }

    // setup commands
    const setupResults = config.setupCommands.length
      ? await this.runCommands(config.setupCommands, wtPath, { label: "setup" })
      : [];
    const setupFailed = setupResults.some((r) => !r.ok);
    if (setupFailed) {
      warnings.push(
        "a setup command failed — worktree was created and kept; fix the issue in the worktree or adjust .zcode/worktree.json"
      );
    }

    // lock while an agent task will run
    let lockedByUs = false;
    if (task) {
      await git.lockWorktree(ctx.mainPath, wtPath, "zcode-worktrees: agent task").catch(() => {});
      lockedByUs = true;
    }

    const now = new Date().toISOString();
    const entry = ctx.store.recordWorktree(ctx.mainPath, {
      name: finalName,
      path: wtPath,
      branch,
      base: base === "fresh" || base === "head" ? resolvedBase.baseRef || base : base,
      baseCommit: resolvedBase.commit,
      createdAt: now,
      lastActivityAt: now,
      task: task || null,
      agent: null,
      session: sessionId
        ? { id: sessionId, startedAt: now }
        : null,
      locked: lockedByUs,
      lockedByUs,
      snapshots: [],
    });
    await ctx.store.save();

    return {
      name: entry.name,
      path: entry.path,
      branch: entry.branch,
      base: entry.base,
      baseCommit: entry.baseCommit,
      task: entry.task,
      locked: lockedByUs,
      carryOver: carry,
      carryDirty: carryDirtyResult,
      setup: setupResults,
      warnings,
      freeBytes: space.freeBytes == null ? null : Number(space.freeBytes),
      nextSteps: [
        `Open it in ZCode: File → Open Folder → ${entry.path}`,
        task
          ? "A background agent task can now be spawned on this worktree (the /worktree:new command does this automatically)."
          : "Run a task here from this session: /worktree:new <name> \"task description\"",
        "Finish with /worktree:remove " + entry.name + " (uncommitted work is snapshotted first)",
      ],
      summary:
        `created worktree "${entry.name}" at ${entry.path}\n` +
        `branch ${entry.branch} from ${entry.base || "base"} (${entry.baseCommit?.slice(0, 8) ?? "?"})` +
        (carry.copied.length ? `\ncarried over: ${carry.copied.join(", ")}` : "") +
        (warnings.length ? `\nwarnings: ${warnings.join("; ")}` : ""),
    };
  }

  async carryDirtyChanges(src, dest, warnings) {
    const result = { patchApplied: false, untrackedCopied: [], warnings: [] };
    const patch = await git.trackedDiff(src).catch(() => "");
    if (patch.trim()) {
      const tmp = join(dest, ".zcode-carry-dirty.patch");
      await writeFile(tmp, patch, "utf8");
      try {
        await git.applyPatch(dest, tmp);
        result.patchApplied = true;
      } catch (err) {
        result.warnings.push(
          `uncommitted tracked changes could not be applied to the new base (${err.message}) — they remain only in the source checkout`
        );
      } finally {
        await rm(tmp, { force: true });
      }
    }
    for (const rel of await git.untrackedFiles(src)) {
      const srcFile = join(src, rel);
      let st;
      try {
        st = await lstat(srcFile);
      } catch {
        continue;
      }
      if (st.isSymbolicLink() || !st.isFile()) continue;
      const dstFile = join(dest, rel);
      try {
        await lstat(dstFile);
        continue; // never overwrite
      } catch {
        /* copy below */
      }
      await mkdir(dirname(dstFile), { recursive: true });
      await cp(srcFile, dstFile, { force: false });
      result.untrackedCopied.push(rel);
    }
    warnings.push(...result.warnings);
    return result;
  }

  async _status({ repoPath, name } = {}) {
    if (name == null) throw new OpsError("name is required (see /worktree for known names)");
    const ctx = await this.ctx(repoPath);
    const entry = this.findEntry(ctx, name);
    const base = await this.enrichEntry(entry, ctx);
    let diffStat = null;
    let log = [];
    let unpushed = null;
    if (base.exists) {
      try {
        const statOut = await execFileP(
          "git",
          ["diff", "HEAD", "--stat", "--untracked-files=no"],
          { cwd: entry.path, maxBuffer: 4 * 1024 * 1024 }
        );
        diffStat = tail(statOut.stdout, 20);
      } catch {
        /* unborn or unreadable */
      }
      log = await git.commitLog(entry.path, 5);
      if (entry.branch) {
        unpushed = await git
          .unpushedCount(ctx.mainPath, entry.branch, entry.baseCommit)
          .catch(() => null);
      }
    }
    const snapshotRoot = this.snapshotsRoot(ctx.project.slug);
    let snapshots = [];
    try {
      snapshots = (await readdir(snapshotRoot))
        .filter((d) => d.startsWith(`${entry.name}-`))
        .sort()
        .reverse();
    } catch {
      /* none */
    }
    return {
      ...base,
      diffStat,
      recentCommits: log,
      unpushed,
      snapshotDirs: snapshots,
      summary:
        `worktree "${base.name}" — ${base.exists ? base.path : "MISSING directory"}\n` +
        `branch: ${base.branch ?? "?"}${base.locked ? " (locked)" : ""}  dirty: ${base.dirty ?? "?"}  size: ${base.sizeBytes ? fmt(base.sizeBytes) : "?"}\n` +
        (base.task ? `task: ${base.task}\n` : "") +
        (unpushed ? `unpushed commits: ${unpushed.unpushed ?? "?"}${unpushed.hasRemote ? "" : " (no remote)"}\n` : "") +
        (diffStat ? `uncommitted changes:\n${diffStat}` : ""),
    };
  }

  async _remove({ repoPath, name, force = false, deleteBranch = false } = {}) {
    if (name == null) throw new OpsError("name is required");
    const ctx = await this.ctx(repoPath);
    const entry = this.findEntry(ctx, name);

    if (ctx.gitList.length > 0 && ctx.gitList[0].path === entry.path) {
      throw new OpsError("refusing to remove the main checkout of the repository");
    }

    const exists = await pathExists(entry.path);
    const status = exists ? await git.statusSummary(entry.path).catch(() => null) : null;
    const dirty = status ? status.dirty : 0;

    if (entry.agent && !force) {
      throw new OpsError(
        `worktree "${name}" has a running agent task (started ${entry.agent.startedAt}); pass force:true to remove anyway`
      );
    }
    if (dirty > 0 && !force) {
      throw new OpsError(
        `worktree "${name}" has ${dirty} uncommitted change(s); pass force:true to remove anyway ` +
          "(a snapshot is always taken before removal)"
      );
    }

    const { config } = await this.projectConfig(ctx);
    if (config.preRemoveCommands.length) {
      if (exists) {
        const results = await this.runCommands(config.preRemoveCommands, entry.path, {
          label: "preRemove",
        });
        const failed = results.find((r) => !r.ok);
        if (failed && !force) {
          throw new OpsError(
            `pre-remove command failed (${failed.command}); removal aborted. Output:\n${failed.output}`
          );
        }
      }
    }

    // Snapshot before any destructive step (cheap no-op when clean).
    let snapshot = null;
    if (exists && dirty > 0) {
      snapshot = await takeSnapshot(entry.path, this.snapshotsRoot(ctx.project.slug), {
        name: entry.name,
        reason: "remove",
      });
    }

    // Unlock (only if we own the lock) so git allows removal.
    if (entry.locked) {
      if (entry.lockedByUs || force) {
        await git.unlockWorktree(ctx.mainPath, entry.path).catch(() => {});
      }
    }

    const sizeBytes = exists ? await git.dirSize(entry.path) : null;
    try {
      await git.removeWorktree(ctx.mainPath, entry.path, { force });
    } catch (err) {
      if (/no longer matches|validation failed/i.test(err.message)) {
        await git.pruneWorktrees(ctx.mainPath);
        await rm(entry.path, { recursive: true, force: true }).catch(() => {});
      } else {
        throw err;
      }
    }
    if (exists) await rm(entry.path, { recursive: true, force: true }).catch(() => {});

    // Branch handling — branches are the safety net for commits.
    let branchAction = "kept";
    if (deleteBranch && entry.branch) {
      const stillThere = await git.branchExists(ctx.mainPath, entry.branch);
      if (!stillThere) {
        branchAction = "already gone";
      } else {
        const merged =
          (await git.branchMergedInto(ctx.mainPath, entry.branch, "HEAD")) ||
          (await git
            .resolveRef(ctx.mainPath, "origin/HEAD")
            .then((c) => git.branchMergedInto(ctx.mainPath, entry.branch, c))
            .catch(() => false));
        if (!merged && !force) {
          branchAction = "kept (branch has unmerged commits; pass force:true to delete it)";
        } else {
          try {
            await git.deleteBranch(ctx.mainPath, entry.branch, { force: !merged });
            branchAction = "deleted";
          } catch (err) {
            branchAction = `kept (${err.message})`;
          }
        }
      }
    }

    ctx.store.dropWorktree(ctx.mainPath, name);
    const proj = ctx.store.project(ctx.mainPath);
    proj.removedHistory = (proj.removedHistory || []).slice(-49);
    proj.removedHistory.push({
      name,
      path: entry.path,
      branch: entry.branch,
      removedAt: new Date().toISOString(),
      snapshot: snapshot ? snapshot.dir : null,
      branchAction,
    });
    await ctx.store.save();

    return {
      removed: name,
      path: entry.path,
      branch: entry.branch,
      branchAction,
      snapshot: snapshot
        ? { dir: snapshot.dir, untrackedCount: snapshot.untrackedCount, hasPatch: snapshot.hasPatch }
        : null,
      reclaimedBytes: sizeBytes,
      warnings: [],
      summary:
        `removed worktree "${name}"` +
        (sizeBytes ? ` (reclaimed ~${fmt(sizeBytes)})` : "") +
        `\nbranch ${entry.branch}: ${branchAction}` +
        (snapshot ? `\nsnapshot of uncommitted work: ${snapshot.dir}` : ""),
    };
  }

  async _cleanup({ repoPath, dryRun = true, maxAgeDays, maxCount } = {}) {
    const ctx = await this.ctx(repoPath);
    const ageDays = maxAgeDays ?? this.maxAgeDays;
    const count = maxCount ?? this.maxCount;

    const enriched = [];
    for (const entry of Object.values(ctx.project.worktrees)) {
      enriched.push({ entry, info: await this.enrichEntry(entry, ctx) });
    }

    // Metadata hygiene: entries whose directory vanished entirely.
    const removedMetadata = [];
    for (const { entry, info } of enriched) {
      if (!info.exists && !ctx.gitList.some((w) => w.path === entry.path)) {
        removedMetadata.push(entry.name);
        ctx.store.dropWorktree(ctx.mainPath, entry.name);
      }
    }
    if (removedMetadata.length) await ctx.store.save();
    await git.pruneWorktrees(ctx.mainPath).catch(() => {});

    const live = enriched.filter((e) => !removedMetadata.includes(e.entry.name));
    live.sort((a, b) => (a.info.lastActivityAt < b.info.lastActivityAt ? 1 : -1));

    const now = Date.now();
    const skipped = [];
    const eligible = [];
    live.forEach((e, i) => {
      const reason = skipReason(e.info, i, count, ageDays, now);
      if (reason) skipped.push({ name: e.info.name, reason });
      else eligible.push(e);
    });

    if (dryRun) {
      return {
        dryRun: true,
        wouldRemove: eligible.map((e) => ({
          name: e.info.name,
          path: e.entry.path,
          sizeBytes: e.info.sizeBytes,
          lastActivityAt: e.info.lastActivityAt,
        })),
        skipped,
        removedMetadata,
        reclaimableBytes: sumBytes(eligible.map((e) => e.info.sizeBytes)),
        summary:
          `cleanup dry-run: ${eligible.length} worktree(s) eligible` +
          (removedMetadata.length ? `, ${removedMetadata.length} stale metadata entr(ies) dropped` : "") +
          `. Re-run with dryRun:false to apply.`,
      };
    }

    const removed = [];
    let reclaimedBytes = 0;
    for (const e of eligible) {
      try {
        const res = await this._remove({
          repoPath: ctx.mainPath,
          name: e.info.name,
          force: true, // eligibility already verified it is clean & idle
          deleteBranch: false, // keep branches; they are the safety net
        });
        removed.push({ name: e.info.name, branchAction: res.branchAction, snapshot: res.snapshot });
        reclaimedBytes += res.reclaimedBytes || 0;
      } catch (err) {
        skipped.push({ name: e.info.name, reason: `removal failed: ${err.message}` });
      }
    }
    return {
      dryRun: false,
      removed,
      skipped,
      removedMetadata,
      reclaimedBytes,
      summary:
        `cleanup removed ${removed.length} worktree(s)` +
        (reclaimedBytes ? `, reclaimed ~${fmt(reclaimedBytes)}` : "") +
        (skipped.length ? `; skipped ${skipped.length}` : ""),
    };
  }

  async _prune({ repoPath } = {}) {
    const ctx = await this.ctx(repoPath);
    const before = ctx.gitList.map((w) => w.path);
    await git.pruneWorktrees(ctx.mainPath);
    const after = await git.listWorktrees(ctx.mainPath);
    const dropped = before.filter((p) => !after.some((w) => w.path === p));
    // Drop state entries git forgot about.
    const droppedState = [];
    for (const [name, entry] of Object.entries(ctx.project.worktrees)) {
      if (!after.some((w) => w.path === entry.path)) {
        ctx.store.dropWorktree(ctx.mainPath, name);
        droppedState.push(name);
      }
    }
    if (droppedState.length) await ctx.store.save();
    return {
      gitPruned: dropped,
      stateDropped: droppedState,
      remaining: after.length,
      summary:
        `pruned ${dropped.length} stale git worktree record(s)` +
        (droppedState.length ? ` and ${droppedState.length} state entr(ies)` : ""),
    };
  }

  async _snapshot({ repoPath, name } = {}) {
    if (name == null) throw new OpsError("name is required");
    const ctx = await this.ctx(repoPath);
    const entry = this.findEntry(ctx, name);
    if (!(await pathExists(entry.path))) {
      throw new OpsError(`worktree directory is missing: ${entry.path} (run /worktree:cleanup)`);
    }
    const snap = await takeSnapshot(entry.path, this.snapshotsRoot(ctx.project.slug), {
      name: entry.name,
      reason: "manual",
    });
    entry.snapshots = entry.snapshots || [];
    entry.snapshots.push({ dir: snap.dir, createdAt: snap.meta.createdAt, reason: "manual" });
    entry.lastActivityAt = new Date().toISOString();
    await ctx.store.save();
    return {
      ...snap,
      summary:
        `snapshot saved: ${snap.dir}\n` +
        `${snap.hasPatch ? "tracked changes → changes.patch; " : ""}${snap.untrackedCount} untracked file(s) captured`,
    };
  }

  async _setTask({ repoPath, name, task, agentId, sessionId, clearAgent = false } = {}) {
    if (name == null) throw new OpsError("name is required");
    const ctx = await this.ctx(repoPath);
    const entry = this.findEntry(ctx, name);

    if (task !== undefined) entry.task = task;
    if (agentId != null) {
      entry.agent = {
        agentId,
        sessionId: sessionId || null,
        startedAt: new Date().toISOString(),
      };
      if (!entry.locked) {
        await git.lockWorktree(ctx.mainPath, entry.path, "zcode-worktrees: agent task").catch(() => {});
        entry.locked = true;
        entry.lockedByUs = true;
      }
    }
    if (clearAgent) {
      entry.agent = null;
      if (entry.lockedByUs) {
        await git.unlockWorktree(ctx.mainPath, entry.path).catch(() => {});
        entry.locked = false;
        entry.lockedByUs = false;
      }
    }
    entry.lastActivityAt = new Date().toISOString();
    await ctx.store.save();
    return {
      name: entry.name,
      task: entry.task || null,
      agent: entry.agent || null,
      locked: Boolean(entry.locked),
      summary: `updated worktree "${entry.name}": task=${entry.task ? "set" : "unset"}, agent=${entry.agent ? entry.agent.agentId : "none"}`,
    };
  }
}

function skipReason(info, index, maxCount, maxAgeDays, now) {
  if (info.dirty > 0) return "has uncommitted changes";
  if (info.locked) return "locked";
  if (info.agent) return "agent task running";
  const ageMs = now - Date.parse(info.lastActivityAt);
  if (Number.isFinite(ageMs) && ageMs > maxAgeDays * 24 * 3600 * 1000) {
    return null; // eligible by age
  }
  if (index >= maxCount) return null; // eligible by count cap
  return `active (last activity ${info.lastActivityAt})`;
}

function sumBytes(values) {
  return values.reduce((acc, v) => acc + (v || 0), 0);
}

function tail(text, maxLines = 15) {
  const lines = (text || "").trim().split("\n");
  if (lines.length <= maxLines) return lines.join("\n");
  return `[…${lines.length - maxLines} more line(s)]\n` + lines.slice(-maxLines).join("\n");
}

function renderList(entries) {
  if (entries.length === 0) return "no managed worktrees yet — create one with /worktree:new <name>";
  const rows = entries.map((e) => {
    const flags = [
      e.exists ? null : "MISSING",
      e.dirty ? `dirty(${e.dirty})` : null,
      e.locked ? "locked" : null,
      e.agent ? "agent" : null,
    ].filter(Boolean);
    return `- ${e.name} [${e.branch ?? "?"}]${flags.length ? ` ${flags.map((f) => `· ${f}`).join(" ")}` : ""} — ${e.path}`;
  });
  return rows.join("\n");
}
