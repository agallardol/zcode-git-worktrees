// Shared store location + marker resolution for the MCP server and the hooks.
//
// The MCP server receives the configured worktree root via its env (manifest
// userConfig); hooks receive nothing, so the server persists a pointer file at
// the well-known default location and hooks follow it. Explicit env overrides
// (tests) always win and are never persisted.
import { homedir } from "node:os";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export function defaultStoreRoot() {
  return join(homedir(), ".zcode", "worktrees");
}

export function guardedEnv(name) {
  const raw = process.env[name];
  // unsubstituted userConfig placeholders ("${user_config.x}") mean "unset"
  return raw && !raw.includes("${") ? raw : null;
}

export function expandHome(p) {
  if (!p) return p;
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export async function resolveStoreRoot() {
  const override =
    guardedEnv("ZCODE_WORKTREE_STORE_ROOT") || guardedEnv("ZCODE_WORKTREE_ROOT");
  if (override) return expandHome(override);
  const def = defaultStoreRoot();
  try {
    const pointer = JSON.parse(
      await readFile(join(def, "store-location.json"), "utf8")
    );
    if (typeof pointer.storeRoot === "string" && pointer.storeRoot) {
      return pointer.storeRoot;
    }
  } catch {
    /* no pointer → default */
  }
  return def;
}

// Called by the MCP server on startup (never under test overrides) so hooks can
// find a non-default root.
export async function persistStorePointer(root) {
  if (guardedEnv("ZCODE_WORKTREE_STORE_ROOT")) return; // test isolation
  const def = defaultStoreRoot();
  const target = resolve(expandHome(root));
  if (target === resolve(def)) return;
  await mkdir(def, { recursive: true });
  const file = join(def, "store-location.json");
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify({ storeRoot: target }, null, 2) + "\n");
  await rename(tmp, file);
}

// ---- auto-session mode marker (<storeRoot>/auto-session.json) ----

export async function readAutoSession(root) {
  try {
    const parsed = JSON.parse(await readFile(join(root, "auto-session.json"), "utf8"));
    return { enabled: Boolean(parsed.enabled), updatedAt: parsed.updatedAt || null };
  } catch {
    return { enabled: false, updatedAt: null };
  }
}

export async function writeAutoSession(root, enabled) {
  const file = join(root, "auto-session.json");
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(
    tmp,
    JSON.stringify({ enabled: Boolean(enabled), updatedAt: new Date().toISOString() }, null, 2) + "\n"
  );
  await rename(tmp, file);
  return { enabled: Boolean(enabled), path: file };
}
