#!/usr/bin/env node
// Detached auto-session worktree creator. Spawned by session-start.mjs so the
// hook can return instantly on huge repositories; this process does the real
// create (deferred checkout, no lifecycle commands) and cleans the pending
// marker. Failures are logged to <store>/auto-session-errors.log — they must
// never disturb the session.
import { appendFile, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Ops } from "../../mcp/lib/ops.mjs";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
}

async function main() {
  const storeRoot = arg("store");
  const cwd = arg("cwd");
  const sessionId = arg("session");
  const name = arg("name");
  if (!storeRoot || !cwd || !sessionId || !name) process.exit(0);

  const ops = new Ops({
    storeRoot,
    defaultBase: "head",
    lockTimeoutMs: 20_000,
  });
  try {
    await ops.create({
      repoPath: cwd,
      name,
      baseRef: "head",
      sessionId,
      skipLifecycleCommands: true, // SECURITY: no repo-provided commands
      deferCheckout: true, // never block on a huge-repo checkout
    });
  } catch (err) {
    try {
      await appendFile(
        join(storeRoot, "auto-session-errors.log"),
        `${new Date().toISOString()} ${name}: ${String(err?.message || err).slice(0, 300)}\n`
      );
    } catch {
      /* best effort */
    }
  } finally {
    await rm(join(storeRoot, `pending-${sessionId}.json`), { force: true }).catch(() => {});
  }
}

// keep node alive until the detached git populate children finish
main().then(
  () => {},
  () => {}
);
