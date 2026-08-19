// Persistent worktree registry: <storeRoot>/state.json
//
// The state file is an index, never the source of truth — git itself is. On
// every load it self-heals (corrupt file → quarantined + fresh state), and
// `reconcileProject` cross-checks recorded entries against
// `git worktree list --porcelain`, adopting managed-looking worktrees that are
// missing from state and flagging recorded ones whose directory vanished.
import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
  rm,
} from "node:fs/promises";
import { basename, join } from "node:path";

const STATE_VERSION = 1;

export function emptyState() {
  return { version: STATE_VERSION, projects: {} };
}

export class StateStore {
  constructor(storeRoot) {
    this.storeRoot = storeRoot;
    this.file = join(storeRoot, "state.json");
    this.state = emptyState();
  }

  async load() {
    let raw;
    try {
      raw = await readFile(this.file, "utf8");
    } catch {
      this.state = emptyState();
      return this.state;
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.projects) {
        this.state = { version: STATE_VERSION, projects: parsed.projects };
      } else {
        throw new Error("unexpected state shape");
      }
    } catch {
      // Quarantine the corrupt file rather than deleting user data.
      const quarantine = `${this.file}.corrupt-${Date.now()}`;
      try {
        await rename(this.file, quarantine);
      } catch {
        /* best effort */
      }
      this.state = emptyState();
    }
    return this.state;
  }

  async save() {
    await mkdir(this.storeRoot, { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(this.state, null, 2) + "\n", {
      mode: 0o600,
    });
    await rename(tmp, this.file);
  }

  project(mainPath) {
    return this.state.projects[mainPath] || null;
  }

  // Stable, filesystem-safe slug for a repo. Collisions between different repos
  // with the same basename get a short path-hash suffix.
  slugFor(mainPath) {
    const base = sanitizeSlug(basename(mainPath)) || "repo";
    const takenBy = Object.entries(this.state.projects).find(
      ([p, proj]) => proj.slug === base && p !== mainPath
    );
    if (!takenBy) return base;
    const hash = createHash("sha256")
      .update(mainPath)
      .digest("hex")
      .slice(0, 8);
    return `${base}-${hash}`;
  }

  ensureProject(mainPath, { originUrl = null } = {}) {
    let proj = this.state.projects[mainPath];
    if (!proj) {
      proj = {
        slug: this.slugFor(mainPath),
        mainPath,
        originUrl,
        addedAt: new Date().toISOString(),
        worktrees: {},
      };
      this.state.projects[mainPath] = proj;
    }
    if (originUrl && !proj.originUrl) proj.originUrl = originUrl;
    return proj;
  }

  worktree(mainPath, name) {
    return this.state.projects[mainPath]?.worktrees?.[name] || null;
  }

  recordWorktree(mainPath, entry) {
    const proj = this.ensureProject(mainPath);
    proj.worktrees[entry.name] = entry;
    return entry;
  }

  dropWorktree(mainPath, name) {
    const proj = this.state.projects[mainPath];
    if (proj && proj.worktrees[name]) {
      const removed = proj.worktrees[name];
      delete proj.worktrees[name];
      return removed;
    }
    return null;
  }

  // Drop projects whose main repo directory no longer exists, so a stale
  // entry never shadows a future repo created at the same path.
  async dropDeadProjects() {
    for (const mainPath of Object.keys(this.state.projects)) {
      try {
        await stat(mainPath);
      } catch (err) {
        if (err.code === "ENOENT") delete this.state.projects[mainPath];
      }
    }
  }

  // Bring recorded entries in sync with git reality:
  //  - entries whose worktree vanished from `git worktree list` AND whose
  //    directory is gone are dropped (git prune got there first)
  //  - git worktrees living under <storeRoot>/<slug>/ but absent from state
  //    are adopted (state was lost/reset, or another machine process created it)
  // Returns a report of what changed.
  async reconcileProject(mainPath, gitWorktrees, { storeRoot }) {
    const report = { dropped: [], adopted: [] };
    const proj = this.state.projects[mainPath];
    const slug = proj?.slug;
    if (proj) {
      const gitPaths = new Set(gitWorktrees.map((w) => w.path));
      for (const [name, entry] of Object.entries(proj.worktrees)) {
        const inGit = gitPaths.has(entry.path);
        if (!inGit) {
          // Distinguish "git knows it but state stale" is impossible here;
          // git forgot it → drop from state (directory handled by prune).
          report.dropped.push(name);
          delete proj.worktrees[name];
        } else {
          entry.locked = Boolean(
            gitWorktrees.find((w) => w.path === entry.path)?.locked
          );
          entry.lastActivityAt = entry.lastActivityAt || entry.createdAt;
        }
      }
    }
    if (slug) {
      const projDir = join(storeRoot, slug);
      const prefix = projDir + "/";
      for (const w of gitWorktrees) {
        if (!w.path.startsWith(prefix)) continue;
        const name = w.path.slice(prefix.length).split("/")[0];
        if (!name || name.includes("/")) continue;
        if (!this.worktree(mainPath, name)) {
          const branch = w.branch ? w.branch.replace(/^refs\/heads\//, "") : null;
          this.recordWorktree(mainPath, {
            name,
            path: w.path,
            branch,
            base: null,
            baseCommit: null,
            createdAt: new Date().toISOString(),
            lastActivityAt: new Date().toISOString(),
            task: null,
            agent: null,
            locked: Boolean(w.locked),
            lockedByUs: false,
            snapshots: [],
            adopted: true,
          });
          report.adopted.push(name);
        }
      }
    }
    return report;
  }

  // Find the worktree entry containing `dir` (for the SessionStart hook and
  // status calls made from inside a worktree).
  findEntryByPath(dir) {
    for (const proj of Object.values(this.state.projects)) {
      for (const entry of Object.values(proj.worktrees)) {
        if (dir === entry.path || dir.startsWith(entry.path + "/")) {
          return { project: proj, entry };
        }
      }
    }
    return null;
  }

  async destroyStore() {
    await rm(this.storeRoot, { recursive: true, force: true });
  }
}

export function sanitizeSlug(name) {
  return name.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[-.]+|[-.]+$/g, "") || null;
}
