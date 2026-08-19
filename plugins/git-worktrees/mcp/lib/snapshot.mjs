// Snapshots: capture everything uncommitted in a worktree (tracked diff +
// untracked files) before destructive operations, so nothing is ever silently
// lost. Snapshot dirs are self-describing via meta.json and restorable with
// `git apply` + file copies.
import { cp, lstat, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as git from "./git.mjs";

export async function takeSnapshot(worktreePath, snapshotsRoot, { name, reason = "manual" } = {}) {
  const ts = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 23); // 2026-08-19_09-15-30-123 — millisecond precision avoids collisions
  const dir = join(snapshotsRoot, `${name}-${ts}`);
  await mkdir(join(dir, "untracked"), { recursive: true });

  const [patch, untracked, head, branch] = await Promise.all([
    git.trackedDiff(worktreePath).catch(() => ""),
    git.untrackedFiles(worktreePath),
    git.headCommit(worktreePath),
    git.currentBranch(worktreePath),
  ]);

  let patchPath = null;
  if (patch.trim().length > 0) {
    patchPath = join(dir, "changes.patch");
    await writeFile(patchPath, patch, "utf8");
  }

  const copiedUntracked = [];
  for (const rel of untracked) {
    const src = join(worktreePath, rel);
    let st;
    try {
      st = await lstat(src);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue; // links are recorded, not copied
    if (!st.isFile()) continue;
    const dst = join(dir, "untracked", rel);
    await mkdir(dirname(dst), { recursive: true });
    await cp(src, dst, { force: false });
    copiedUntracked.push(rel);
  }

  const meta = {
    plugin: "git-worktrees",
    version: 1,
    worktree: worktreePath,
    name,
    reason,
    branch,
    headCommit: head,
    createdAt: new Date().toISOString(),
    patch: patchPath ? "changes.patch" : null,
    untracked: copiedUntracked,
    restoreHint:
      "From the worktree at the same commit: run " +
      "`git apply <snapshot>/changes.patch` and copy files from <snapshot>/untracked/.",
  };
  await writeFile(join(dir, "meta.json"), JSON.stringify(meta, null, 2) + "\n", "utf8");

  return {
    dir,
    reason,
    hasPatch: patchPath != null,
    untrackedCount: copiedUntracked.length,
    meta,
  };
}

// Is there anything uncommitted worth snapshotting?
export async function hasUncommittedChanges(worktreePath) {
  const info = await git.statusSummary(worktreePath);
  return info.dirty > 0;
}
