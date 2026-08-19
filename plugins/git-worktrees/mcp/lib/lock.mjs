// Cross-process + in-process locking for the worktree store.
//
// Why both: tool calls inside one server interleave at every await, and the
// desktop app can run several sessions (each with its own MCP server process)
// against the same store. State is load-modify-save, so unsynchronized writers
// lose updates. The in-process queue serializes one server; the mkdir-based
// lockfile serializes across processes (mkdir is atomic on POSIX and fails with
// EEXIST if someone else got there first).
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const LOCK_POLL_MS = 25;
const LOCK_TIMEOUT_MS = 30_000;
const LOCK_STALE_MS = 120_000;

export class LockManager {
  constructor(lockDir) {
    this.lockDir = lockDir;
    this.queue = Promise.resolve();
  }

  // Serialize within this process, then across processes.
  run(task) {
    const job = this.queue.then(
      () => this.withFileLock(task),
      () => this.withFileLock(task)
    );
    // Keep the chain alive even if a task rejects.
    this.queue = job.then(
      () => undefined,
      () => undefined
    );
    return job;
  }

  async withFileLock(task) {
    const started = Date.now();
    for (;;) {
      await this.breakStale();
      try {
        await mkdir(this.lockDir);
        break;
      } catch (err) {
        if (err.code !== "EEXIST") throw err;
        if (Date.now() - started > LOCK_TIMEOUT_MS) {
          throw new Error(
            `timed out waiting for the worktree store lock (${this.lockDir}); another ZCode session may be stuck — delete that lock directory to force`
          );
        }
        await sleep(LOCK_POLL_MS);
      }
    }
    try {
      await writeFile(join(this.lockDir, "owner"), String(process.pid)).catch(() => {});
      return await task();
    } finally {
      await rm(this.lockDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // A lock held longer than LOCK_STALE_MS means its holder crashed; break it.
  async breakStale() {
    try {
      const st = await stat(this.lockDir);
      if (Date.now() - st.mtimeMs >= LOCK_STALE_MS) {
        await rm(this.lockDir, { recursive: true, force: true }).catch(() => {});
      }
    } catch {
      /* no lock dir */
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
