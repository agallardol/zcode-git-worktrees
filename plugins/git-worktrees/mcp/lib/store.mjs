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
//
// Sources of truth and precedence ("the most recent deliberate change wins"):
//  - Settings UI (userConfig) → MCP server env → reconcileAutoSession() syncs
//    the marker at every server start; lastUiValue tracks what was last synced
//    so a later /worktree:auto command stays sticky until the UI value
//    actually changes.
//  - /worktree:auto (worktrees_auto_session tool) writes source:"command".
//  - Per-repo override (.zcode/worktree.json "autoSession") is evaluated by
//    the hooks and beats both.
//
// Default is ENABLED: a missing or corrupt marker means ON (fail-open to the
// documented default), and the server writes the marker even for `true` so
// hooks can rely on its presence after the first session.

export const DEFAULT_AUTO_SESSION = true;

export async function readAutoSession(root) {
  try {
    const parsed = JSON.parse(await readFile(join(root, "auto-session.json"), "utf8"));
    if (parsed && typeof parsed.enabled === "boolean") {
      return {
        enabled: parsed.enabled,
        source: parsed.source || null,
        updatedAt: parsed.updatedAt || null,
        explicit: true,
      };
    }
  } catch {
    /* missing or corrupt → default */
  }
  return { enabled: DEFAULT_AUTO_SESSION, source: null, updatedAt: null, explicit: false };
}

// Raw parsed marker (null when missing/corrupt) — used by the sync logic,
// which needs source/lastUiValue, not just the effective state.
export async function readAutoSessionRaw(root) {
  try {
    const parsed = JSON.parse(await readFile(join(root, "auto-session.json"), "utf8"));
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    /* missing or corrupt */
  }
  return null;
}

export async function writeAutoSessionMarker(root, marker) {
  const file = join(root, "auto-session.json");
  await mkdir(root, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(marker, null, 2) + "\n");
  await rename(tmp, file);
  return { enabled: marker.enabled, path: file };
}

// Decide the new marker given the UI-provided value (env) and the current
// marker. Returns the marker to write, or the same object when nothing
// changes. envValue null (no userConfig signal — e.g. older app, tests)
// never touches the marker.
export function reconcileAutoSession(marker, envValue) {
  if (envValue !== true && envValue !== false) return marker;
  const now = new Date().toISOString();
  if (!marker || typeof marker !== "object") {
    return { enabled: envValue, source: "ui", lastUiValue: envValue, updatedAt: now };
  }
  if (marker.lastUiValue !== true && marker.lastUiValue !== false) {
    // Legacy marker without a UI baseline (pre-0.4.0): keep its enabled value
    // as the deliberate state, record the current UI value as the baseline.
    return { ...marker, lastUiValue: envValue };
  }
  if (marker.lastUiValue !== envValue) {
    // The UI value changed since the last sync → the UI is the newest
    // deliberate change; adopt it.
    return { enabled: envValue, source: "ui", lastUiValue: envValue, updatedAt: now };
  }
  return marker; // UI unchanged → a command-written value stays sticky
}

export async function writeAutoSession(root, enabled) {
  const prev = await readAutoSessionRaw(root);
  return writeAutoSessionMarker(root, {
    enabled: Boolean(enabled),
    source: "command",
    lastUiValue: prev?.lastUiValue,
    updatedAt: new Date().toISOString(),
  });
}
