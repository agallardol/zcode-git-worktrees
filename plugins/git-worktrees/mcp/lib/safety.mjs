// Safety primitives: name validation, symlink-free path creation, disk space checks.
// Every path the plugin writes is derived from a validated name, so validation
// must reject anything that could escape the worktree store or break git refs.
import { lstat, mkdir, statfs } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

// One path segment: ASCII alphanumerics, dots, dashes, underscores. No leading
// dot/dash/underscore (rules out "..", hidden dirs, option-like names), no
// trailing dot, no double dot, no ".lock" suffix, and a hard ".git" ban.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}[A-Za-z0-9_]$|^[A-Za-z0-9]$/;

export const MIN_FREE_BYTES = 500 * 1024 * 1024; // refuse creates below 500 MiB free

export function validateName(name) {
  if (typeof name !== "string") return bad("name must be a string");
  const trimmed = name.trim();
  if (trimmed.length === 0) return bad("name is empty");
  if (trimmed !== name) return bad("name has leading/trailing whitespace");
  if (trimmed.length > 64) return bad("name is longer than 64 characters");
  if (trimmed.toLowerCase() === ".git") return bad('".git" is reserved');
  if (trimmed.includes("..")) return bad('name must not contain ".."');
  if (trimmed.endsWith(".")) return bad("name must not end with a dot");
  if (trimmed.endsWith(".lock")) return bad('name must not end with ".lock"');
  if (!NAME_RE.test(trimmed)) {
    return bad(
      "name must use only ASCII letters, digits, dots, dashes, underscores; " +
        "start with a letter or digit; and contain no spaces, slashes, or unicode"
    );
  }
  return { ok: true, name: trimmed };
}

function bad(error) {
  return { ok: false, error };
}

// Reject names that would collide case-insensitively with an existing sibling
// (macOS APFS is case-insensitive by default: "Foo" and "foo" share a dir).
export async function checkCaseCollision(parentDir, name) {
  let entries;
  try {
    entries = await (await import("node:fs/promises")).readdir(parentDir);
  } catch (err) {
    if (err.code === "ENOENT") return { ok: true };
    throw err;
  }
  const lower = name.toLowerCase();
  const hit = entries.find((e) => e.toLowerCase() === lower && e !== name);
  if (hit) {
    return {
      ok: false,
      error: `a worktree named "${hit}" already exists (names are case-insensitive on this filesystem)`,
    };
  }
  return { ok: true };
}

// mkdir -p that refuses to traverse or create symlinks below `trustedPrefix`.
// Components at/above the trusted prefix (system paths like macOS /var, which
// is itself a symlink) are not inspected; everything below it must be a real
// directory. This blocks planted symlinks inside the worktree store without
// false-positiving on legitimate system paths.
export async function ensureRealDir(path, trustedPrefix = "/") {
  const abs = resolve(path);
  const trusted = resolve(trustedPrefix);
  if (abs !== trusted && !abs.startsWith(trusted + sep)) {
    throw new Error(`path ${abs} is not under trusted prefix ${trusted}`);
  }
  const tail = abs === trusted ? [] : abs.slice(trusted.length + 1).split(sep);
  let current = trusted;
  for (const part of tail) {
    current = current === sep ? sep + part : current + sep + part;
    let st;
    try {
      st = await lstat(current);
    } catch (err) {
      if (err.code === "ENOENT") {
        await mkdir(current, { mode: 0o755 });
        continue;
      }
      throw err;
    }
    if (st.isSymbolicLink()) {
      throw new Error(
        `refusing to operate through symlink path component: ${current}`
      );
    }
    if (!st.isDirectory()) {
      throw new Error(`path component is not a directory: ${current}`);
    }
  }
  return abs;
}

export async function freeBytes(path) {
  try {
    const st = await statfs(path);
    return BigInt(st.bavail) * BigInt(st.bsize);
  } catch {
    return null;
  }
}

// Decide whether it is safe / advisable to materialize `neededBytes` at `path`.
export async function checkFreeSpace(path, neededBytes) {
  const free = await freeBytes(path);
  if (free == null) return { freeBytes: null, level: "ok", message: null };
  if (free < BigInt(MIN_FREE_BYTES)) {
    return {
      freeBytes: free,
      level: "block",
      message: `only ${fmt(free)} free on ${dirname(path)} (minimum ${fmt(
        BigInt(MIN_FREE_BYTES)
      )}); free up disk space first`,
    };
  }
  if (neededBytes != null && free < BigInt(neededBytes)) {
    return {
      freeBytes: free,
      level: "warn",
      message: `only ${fmt(free)} free, new checkout may need about ${fmt(
        BigInt(neededBytes)
      )}`,
    };
  }
  return { freeBytes: free, level: "ok", message: null };
}

export function fmt(bytes) {
  const b = Number(bytes);
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(1)} GiB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(0)} MiB`;
  if (b >= 1024) return `${(b / 1024).toFixed(0)} KiB`;
  return `${b} B`;
}
