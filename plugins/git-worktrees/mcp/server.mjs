#!/usr/bin/env node
// MCP stdio server for the git-worktrees ZCode plugin.
// Zero-dependency: newline-delimited JSON-RPC 2.0 over stdin/stdout per the
// MCP stdio transport. Tool logic lives in ./lib/ops.mjs.
import { createInterface } from "node:readline";
import { join } from "node:path";
import { Ops, OpsError } from "./lib/ops.mjs";
import { GitError } from "./lib/git.mjs";
import {
  resolveStoreRoot,
  persistStorePointer,
  readAutoSessionRaw,
  writeAutoSessionMarker,
  reconcileAutoSession,
} from "./lib/store.mjs";

const VERSION = "0.5.1";
const SERVER_NAME = "git-worktrees";

// ---- configuration from environment (manifest injects userConfig) ----------

function env(name, fallback) {
  const raw = process.env[name];
  // The app may leave unsubstituted placeholders when a userConfig value is
  // unset; treat those and empty strings as "not provided".
  if (!raw || raw.includes("${")) return fallback;
  return raw;
}

const storeRoot = await resolveStoreRoot();
// Hooks can't see this server's env — leave a pointer so they find the same
// store (skipped under test overrides).
await persistStorePointer(storeRoot).catch(() => {});

// Bridge the Settings UI to the hooks: the manifest injects the userConfig
// boolean auto_session as ZCODE_WORKTREE_AUTO_SESSION, and the server syncs it
// into the marker file the hooks read (see reconcileAutoSession for the
// precedence rules). Absent/unparseable env (older app, tests) → no sync.
const autoSessionEnvRaw = env("ZCODE_WORKTREE_AUTO_SESSION", null);
if (autoSessionEnvRaw === "true" || autoSessionEnvRaw === "false") {
  const autoSessionEnv = autoSessionEnvRaw === "true";
  try {
    const marker = await readAutoSessionRaw(storeRoot);
    const next = reconcileAutoSession(marker, autoSessionEnv);
    if (next && next !== marker) {
      await writeAutoSessionMarker(storeRoot, next);
    }
  } catch {
    // syncing is best-effort; hooks fall back to the marker/default
  }
}
const defaultBase = (() => {
  const v = env("ZCODE_WORKTREE_DEFAULT_BASE", "fresh").toLowerCase();
  return v === "head" ? "head" : "fresh";
})();
const maxAgeDays = Number(env("ZCODE_WORKTREE_MAX_AGE_DAYS", "14")) || 14;
const maxCount = Number(env("ZCODE_WORKTREE_MAX_COUNT", "15")) || 15;

const ops = new Ops({ storeRoot, defaultBase, maxAgeDays, maxCount });

// ---- tool table ------------------------------------------------------------

const TOOLS = [
  {
    name: "worktrees_list",
    description:
      "List all managed git worktrees for the current repository with status: branch, base, dirty counts, lock, agent task, size, activity, snapshots. Use for any worktree overview or before create/remove decisions.",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: {
          type: "string",
          description: "Repository path (defaults to the current working directory).",
        },
      },
    },
    handler: (args) => ops.list(args),
  },
  {
    name: "worktrees_create",
    description:
      "Create an isolated git worktree for a new task or experiment. Branch is zcode/<name>, based on origin/HEAD by default (falls back to local HEAD when offline). Carries over .worktreeinclude / copyFiles (gitignored files like .env), runs setupCommands from .zcode/worktree.json. Returns the worktree path plus next steps. Omit name for a friendly auto-generated one.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Worktree name (ASCII letters/digits/._- ). Omit to auto-generate." },
        baseRef: {
          type: "string",
          description: '"fresh" (origin/HEAD), "head" (main checkout HEAD), or a branch/tag/commit.',
        },
        task: { type: "string", description: "Optional task description; the worktree is locked while a task runs." },
        carryDirty: {
          type: "boolean",
          description: "Also copy the current checkout's uncommitted changes into the new worktree.",
        },
        sessionId: {
          type: "string",
          description: "Bind the worktree to a ZCode session id (used by auto-session mode; resumes return to it).",
        },
        repoPath: { type: "string", description: "Repository path (defaults to cwd)." },
      },
    },
    handler: (args) => ops.create(args),
  },
  {
    name: "worktrees_status",
    description:
      "Detailed status of one worktree: dirty state, diff stat, recent commits, unpushed count, size, snapshots, agent task.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Worktree name." },
        repoPath: { type: "string", description: "Repository path (defaults to cwd)." },
      },
      required: ["name"],
    },
    handler: (args) => ops.status(args),
  },
  {
    name: "worktrees_remove",
    description:
      "Remove a worktree safely. Refuses dirty worktrees, running agent tasks, or unmerged-branch deletion unless force is set; always snapshots uncommitted changes first. Branch is kept by default (pass deleteBranch to delete it).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Worktree name." },
        force: { type: "boolean", description: "Override dirty/lock/agent safety checks (snapshot still taken)." },
        deleteBranch: { type: "boolean", description: "Also delete branch zcode/<name> (merged branches only, unless force)." },
        repoPath: { type: "string", description: "Repository path (defaults to cwd)." },
      },
      required: ["name"],
    },
    handler: (args) => ops.remove(args),
  },
  {
    name: "worktrees_cleanup",
    description:
      "Retention sweep for managed worktrees: removes idle, clean worktrees older than max age or beyond the count cap. Dirty, locked, or agent-active worktrees are never touched. Defaults to dry-run; pass dryRun:false to apply.",
    inputSchema: {
      type: "object",
      properties: {
        dryRun: { type: "boolean", description: "Preview only (default true)." },
        maxAgeDays: { type: "number", description: "Override max idle age." },
        maxCount: { type: "number", description: "Override max kept worktrees." },
        repoPath: { type: "string", description: "Repository path (defaults to cwd)." },
      },
    },
    handler: (args) => ops.cleanup(args),
  },
  {
    name: "worktrees_prune",
    description:
      "Run git worktree prune for this repository and drop state entries for worktrees git no longer knows (e.g. directories deleted manually).",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: { type: "string", description: "Repository path (defaults to cwd)." },
      },
    },
    handler: (args) => ops.prune(args),
  },
  {
    name: "worktrees_snapshot",
    description:
      "Snapshot a worktree's uncommitted work (tracked diff + untracked files) to the snapshots directory. Safety net before risky operations.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Worktree name." },
        repoPath: { type: "string", description: "Repository path (defaults to cwd)." },
      },
      required: ["name"],
    },
    handler: (args) => ops.snapshot(args),
  },
  {
    name: "worktrees_set_task",
    description:
      "Attach or update a task/agent association on a worktree. Setting agentId locks the worktree; clearAgent unlocks it (use when a background agent finishes).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Worktree name." },
        task: { type: "string", description: "Task description (omit to leave unchanged)." },
        agentId: { type: "string", description: "Agent handling the task, if one is running." },
        sessionId: { type: "string", description: "Session that spawned the agent." },
        clearAgent: { type: "boolean", description: "Mark the agent as finished and unlock." },
        repoPath: { type: "string", description: "Repository path (defaults to cwd)." },
      },
      required: ["name"],
    },
    handler: (args) => ops.setTask(args),
  },
  {
    name: "worktrees_auto_session",
    description:
      "Get or toggle auto-session mode (on by default; also configurable in Settings → Plugins → Git Worktrees). Every new session started in a repository's main checkout gets its own worktree (branch zcode/sess-<id>, based on current HEAD); resuming returns to the same worktree, and file edits to the main checkout are blocked in favor of the session worktree. UI changes are synced by the server at session start; the most recent deliberate change (Settings or this tool) wins. Per-repo override: .zcode/worktree.json {\"autoSession\": false}.",
    inputSchema: {
      type: "object",
      properties: {
        enabled: {
          type: "boolean",
          description: "Omit to read the current state; true/false to enable/disable.",
        },
      },
    },
    handler: (args) => ops.autoSession(args),
  },
];

// ---- argument validation (manual, with precise messages) -------------------

function validateArgs(tool, args) {
  if (args == null) return { ok: true, value: {} };
  if (typeof args !== "object" || Array.isArray(args)) {
    return { ok: false, error: "arguments must be a JSON object" };
  }
  const schema = tool.inputSchema;
  const allowed = new Set(Object.keys(schema.properties || {}));
  const unknown = Object.keys(args).filter((k) => !allowed.has(k));
  if (unknown.length > 0) {
    return { ok: false, error: `unknown argument(s): ${unknown.join(", ")}` };
  }
  for (const [key, spec] of Object.entries(schema.properties || {})) {
    const value = args[key];
    if (value === undefined) {
      if ((schema.required || []).includes(key)) {
        return { ok: false, error: `missing required argument: ${key}` };
      }
      continue;
    }
    const expected = spec.type;
    const actual = Array.isArray(value) ? "array" : typeof value;
    if (expected === "number" && actual === "number" && !Number.isFinite(value)) {
      return { ok: false, error: `argument "${key}" must be a finite number` };
    }
    if (expected !== actual) {
      return { ok: false, error: `argument "${key}" must be ${expected}, got ${actual}` };
    }
  }
  return { ok: true, value: args };
}

// ---- JSON-RPC plumbing ------------------------------------------------------

const PROTOCOL_VERSION = "2025-06-18";
const MAX_TEXT_CHARS = 200_000;

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function reply(id, result, error) {
  if (error) send({ jsonrpc: "2.0", id, error });
  else send({ jsonrpc: "2.0", id, result });
}

async function handleRequest(msg) {
  const { id, method, params } = msg;
  try {
    if (method === "initialize") {
      return reply(id, {
        protocolVersion:
          params?.protocolVersion && /^\d{4}-\d{2}-\d{2}$/.test(params.protocolVersion)
            ? params.protocolVersion
            : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: VERSION },
        instructions:
          "Git worktree management: create isolated checkouts for parallel tasks, list/status them, remove with snapshots of uncommitted work, and run retention cleanup. Prefer the slash commands (/worktree, /worktree:new, …) for interactive flows.",
      });
    }
    if (method === "ping") return reply(id, {});
    if (method === "tools/list") {
      return reply(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      });
    }
    if (method === "tools/call") {
      const toolName = params?.name;
      const tool = TOOLS.find((t) => t.name === toolName);
      if (!tool) {
        return reply(id, {
          content: [{ type: "text", text: `unknown tool: ${toolName}` }],
          isError: true,
        });
      }
      const validated = validateArgs(tool, params.arguments);
      if (!validated.ok) {
        return reply(id, {
          content: [{ type: "text", text: `invalid arguments for ${toolName}: ${validated.error}` }],
          isError: true,
        });
      }
      try {
        const result = await tool.handler(validated.value);
        const text =
          (result?.summary ? result.summary + "\n\n" : "") +
          JSON.stringify(result, null, 2);
        return reply(id, {
          content: [
            { type: "text", text: text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) + "\n[…truncated]" : text },
          ],
          structuredContent: result,
        });
      } catch (err) {
        return reply(id, {
          content: [{ type: "text", text: userMessage(err) }],
          isError: true,
        });
      }
    }
    return reply(id, null, {
      code: -32601,
      message: `method not found: ${method}`,
    });
  } catch (err) {
    return reply(id, null, { code: -32603, message: `internal error: ${err.message}` });
  }
}

function userMessage(err) {
  if (err instanceof OpsError) return err.message;
  if (err instanceof GitError) return err.message;
  return `${err.message}${err.stack && process.env.ZCODE_WORKTREES_DEBUG ? "\n" + err.stack : ""}`;
}

// ---- main loop --------------------------------------------------------------

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    // Parse error: respond with id null only if we can't extract any id.
    send({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "parse error" },
    });
    return;
  }
  if (Array.isArray(msg)) {
    for (const item of msg) processMessage(item);
    return;
  }
  processMessage(msg);
});

function processMessage(msg) {
  if (msg == null || typeof msg !== "object") return;
  if (msg.jsonrpc !== "2.0") {
    if (msg.id != null) reply(msg.id, null, { code: -32600, message: "invalid request" });
    return;
  }
  if (msg.id == null) return; // notification (initialized, cancelled, …) — ignore
  void handleRequest(msg).catch((err) => {
    reply(msg.id, null, { code: -32603, message: `internal error: ${err.message}` });
  });
}

rl.on("close", () => {
  // stdin closed — the host is shutting us down.
  process.exit(0);
});

process.stderr.write(
  `[${SERVER_NAME}] mcp server ready (store: ${storeRoot}, base: ${defaultBase})\n`
);
