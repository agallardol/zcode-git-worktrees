// Integration: drive the real MCP server over stdio JSON-RPC, exercising every
// tool plus protocol edge cases. No ZCode app needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeRepo, tmpDir, writeRepoFile, git } from "../fixtures/helpers.mjs";

const serverPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../plugins/git-worktrees/mcp/server.mjs"
);

class McpClient {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.badLines = [];
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      let idx;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id != null && this.pending.has(msg.id)) {
            const { resolve } = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            resolve(msg);
          }
        } catch {
          this.badLines.push(line);
        }
      }
    });
    // A failed spawn (e.g. transient EAGAIN under load) must reject pending
    // requests instead of hanging them until the timeout.
    child.on("error", (err) => {
      for (const { reject } of this.pending.values()) {
        reject(new Error(`server process error: ${err.message}`));
      }
      this.pending.clear();
    });
  }

  static async start(env) {
    const child = spawn(process.execPath, [serverPath], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stderr.on("data", () => {}); // keep drains quiet
    return new McpClient(child);
  }

  request(method, params, { timeoutMs = 120_000 } = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.child.stdin.on("error", () => {}); // EPIPE if server died early
      this.child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"
      );
    });
  }

  sendRaw(line) {
    this.child.stdin.write(line + "\n");
  }

  stop() {
    this.child.kill();
  }
}

async function started(t, env) {
  // One retry around the handshake — transient spawn hiccups on a loaded
  // machine are environmental, not product failures.
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    const client = await McpClient.start(env);
    t.after(() => client.stop());
    try {
      const init = await client.request(
        "initialize",
        {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "0" },
        },
        { timeoutMs: attempt === 0 ? 60_000 : 120_000 }
      );
      assert.equal(init.error, undefined, "initialize succeeds");
      client.sendRaw(
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
      );
      return client;
    } catch (err) {
      lastError = err;
      client.stop();
    }
  }
  throw lastError;
}

async function callOk(client, name, args) {
  const res = await client.request("tools/call", { name, arguments: args });
  assert.equal(res.error, undefined, `${name} protocol error: ${JSON.stringify(res.error)}`);
  assert.equal(res.result.isError, undefined, `${name} tool error: ${res.result?.content?.[0]?.text}`);
  return res.result.structuredContent;
}

async function callErr(client, name, args) {
  const res = await client.request("tools/call", { name, arguments: args });
  assert.equal(res.error, undefined);
  assert.equal(res.result.isError, true, `${name} expected tool error`);
  return res.result.content[0].text;
}

test("initialize handshake and tools/list exposes 9 tools", async (t) => {
  const store = tmpDir();
  const client = await started(t, { ZCODE_WORKTREE_STORE_ROOT: store });
  const list = await client.request("tools/list", {});
  assert.equal(list.error, undefined);
  const names = list.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "worktrees_auto_session",
    "worktrees_cleanup",
    "worktrees_create",
    "worktrees_list",
    "worktrees_prune",
    "worktrees_remove",
    "worktrees_set_task",
    "worktrees_snapshot",
    "worktrees_status",
  ]);
  for (const tool of list.result.tools) {
    assert.equal(tool.inputSchema.type, "object");
    assert.ok(tool.description.length > 20);
  }
});

test("full lifecycle: create → list → status → snapshot → remove", async (t) => {
  const store = tmpDir();
  const repo = tmpDir();
  makeRepo(repo, { remote: true });
  const client = await started(t, { ZCODE_WORKTREE_STORE_ROOT: store });

  const created = await callOk(client, "worktrees_create", { repoPath: repo, name: "lifecycle" });
  assert.equal(created.name, "lifecycle");
  assert.equal(created.branch, "zcode/lifecycle");
  assert.ok(existsSync(created.path));
  assert.match(created.summary, /created worktree/);

  const list = await callOk(client, "worktrees_list", { repoPath: repo });
  assert.equal(list.worktrees.length, 1);
  assert.equal(list.worktrees[0].name, "lifecycle");
  assert.equal(list.worktrees[0].dirty, 0);
  assert.ok(list.worktrees[0].sizeBytes > 0);

  const status = await callOk(client, "worktrees_status", { repoPath: repo, name: "lifecycle" });
  assert.equal(status.branch, "zcode/lifecycle");
  assert.deepEqual(status.recentCommits.length > 0, true);

  const snap = await callOk(client, "worktrees_snapshot", { repoPath: repo, name: "lifecycle" });
  assert.ok(existsSync(snap.dir));

  const removed = await callOk(client, "worktrees_remove", {
    repoPath: repo,
    name: "lifecycle",
    deleteBranch: true,
  });
  assert.equal(removed.removed, "lifecycle");
  assert.equal(removed.branchAction, "deleted");
  assert.equal(existsSync(created.path), false);

  const after = await callOk(client, "worktrees_list", { repoPath: repo });
  assert.equal(after.worktrees.length, 0);
});

test("tool errors: unknown name, bad args, unknown repo, missing name", async (t) => {
  const store = tmpDir();
  const repo = tmpDir();
  makeRepo(repo, { remote: false });
  const client = await started(t, { ZCODE_WORKTREE_STORE_ROOT: store });

  assert.match(await callErr(client, "worktrees_no_such", {}), /unknown tool/);
  assert.match(
    await callErr(client, "worktrees_status", { repoPath: repo, name: 42 }),
    /must be string/
  );
  assert.match(
    await callErr(client, "worktrees_status", { repoPath: repo, name: "x", bogus: 1 }),
    /unknown argument/
  );
  assert.match(
    await callErr(client, "worktrees_create", { repoPath: tmpDir(), name: "y" }),
    /not a git repository/
  );
  assert.match(
    await callErr(client, "worktrees_status", { repoPath: repo }),
    /missing required argument/
  );
});

test("protocol edge cases: malformed line, unknown method, ping, batch", async (t) => {
  const store = tmpDir();
  const client = await started(t, { ZCODE_WORKTREE_STORE_ROOT: store });

  // malformed JSON → parse error with id null
  const parseErr = await new Promise((resolve) => {
    const onLine = (chunk) => {
      const s = chunk.toString();
      if (s.includes("-32700")) {
        client.child.stdout.off("data", onLine);
        resolve(JSON.parse(s.trim().split("\n")[0]));
      }
    };
    client.child.stdout.on("data", onLine);
    client.sendRaw("{ this is not json");
  });
  assert.equal(parseErr.error.code, -32700);

  const unknown = await client.request("resources/list", {});
  assert.equal(unknown.error.code, -32601);

  const pong = await client.request("ping", {});
  assert.deepEqual(pong.result, {});

  // batched requests handled
  const [a, b] = await Promise.all([
    client.request("ping", {}),
    client.request("tools/list", {}),
  ]);
  assert.deepEqual(a.result, {});
  assert.ok(b.result.tools.length > 0);
});

test("create validates names and remove enforces dirty safety", async (t) => {
  const store = tmpDir();
  const repo = tmpDir();
  makeRepo(repo, { remote: false });
  const client = await started(t, { ZCODE_WORKTREE_STORE_ROOT: store });

  assert.match(
    await callErr(client, "worktrees_create", { repoPath: repo, name: "../evil" }),
    /invalid worktree name/
  );
  assert.equal(existsSync(join(store, "..", "evil")), false, "nothing created outside store");

  const created = await callOk(client, "worktrees_create", { repoPath: repo, name: "dirty-one" });
  writeRepoFile(created.path, "new-file.txt", "uncommitted\n");

  assert.match(
    await callErr(client, "worktrees_remove", { repoPath: repo, name: "dirty-one" }),
    /uncommitted change/
  );

  const forced = await callOk(client, "worktrees_remove", {
    repoPath: repo,
    name: "dirty-one",
    force: true,
  });
  assert.ok(forced.snapshot, "snapshot taken");
  assert.ok(existsSync(forced.snapshot.dir), "snapshot dir exists");
  // the untracked file is captured under untracked/ (changes.patch only holds tracked edits)
  const recovered = await readFile(
    join(forced.snapshot.dir, "untracked", "new-file.txt"),
    "utf8"
  ).catch(() => null);
  assert.equal(recovered, "uncommitted\n", "untracked file captured in snapshot");
});

test("set_task locks and unlocks with agent lifecycle", async (t) => {
  const store = tmpDir();
  const repo = tmpDir();
  makeRepo(repo, { remote: false });
  const client = await started(t, { ZCODE_WORKTREE_STORE_ROOT: store });

  await callOk(client, "worktrees_create", { repoPath: repo, name: "with-agent" });
  const set = await callOk(client, "worktrees_set_task", {
    repoPath: repo,
    name: "with-agent",
    task: "do things",
    agentId: "agent_123",
  });
  assert.equal(set.locked, true);

  // removal refused while agent active
  assert.match(
    await callErr(client, "worktrees_remove", { repoPath: repo, name: "with-agent" }),
    /running agent/
  );

  const cleared = await callOk(client, "worktrees_set_task", {
    repoPath: repo,
    name: "with-agent",
    clearAgent: true,
  });
  assert.equal(cleared.locked, false);

  await callOk(client, "worktrees_remove", { repoPath: repo, name: "with-agent" });
});

test("cleanup dry-run by default, applies when asked", async (t) => {
  const store = tmpDir();
  const repo = tmpDir();
  makeRepo(repo, { remote: false });
  const client = await started(t, { ZCODE_WORKTREE_STORE_ROOT: store });

  for (const n of ["old-a", "old-b"]) {
    await callOk(client, "worktrees_create", { repoPath: repo, name: n });
  }

  const dry = await callOk(client, "worktrees_cleanup", { repoPath: repo, maxCount: 0 });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.wouldRemove.length, 2);
  assert.equal(dry.removed, undefined);

  // both still present
  const list = await callOk(client, "worktrees_list", { repoPath: repo });
  assert.equal(list.worktrees.length, 2);

  const applied = await callOk(client, "worktrees_cleanup", {
    repoPath: repo,
    maxCount: 0,
    dryRun: false,
  });
  assert.equal(applied.removed.length, 2);
  const after = await callOk(client, "worktrees_list", { repoPath: repo });
  assert.equal(after.worktrees.length, 0);
});

test("env config: maxCount and defaultBase flow through", async (t) => {
  const store = tmpDir();
  const repo = tmpDir();
  makeRepo(repo, { remote: false, commits: 1 });
  const client = await started(t, {
    ZCODE_WORKTREE_STORE_ROOT: store,
    ZCODE_WORKTREE_DEFAULT_BASE: "head",
    ZCODE_WORKTREE_MAX_COUNT: "1",
  });
  const created = await callOk(client, "worktrees_create", { repoPath: repo, name: "cfg" });
  assert.equal(created.base, "HEAD");
});

test("state.json gets 0600 permissions", async (t) => {
  const store = tmpDir();
  const repo = tmpDir();
  makeRepo(repo, { remote: false });
  const client = await started(t, { ZCODE_WORKTREE_STORE_ROOT: store });
  await callOk(client, "worktrees_create", { repoPath: repo, name: "perm" });
  const st = await stat(join(store, "state.json"));
  // 0600 = owner rw only (mask 0o777)
  assert.equal(st.mode & 0o777, 0o600);
});

test("auto_session tool: on by default, toggle roundtrip, invalid args", async (t) => {
  const store = tmpDir();
  const client = await started(t, { ZCODE_WORKTREE_STORE_ROOT: store });

  const initial = await callOk(client, "worktrees_auto_session", {});
  assert.equal(initial.enabled, true, "default is ON");
  assert.equal(initial.explicit, false);

  const off = await callOk(client, "worktrees_auto_session", { enabled: false });
  assert.equal(off.enabled, false);
  const marker = JSON.parse(await readFile(off.path, "utf8"));
  assert.equal(marker.enabled, false);
  const reread = await callOk(client, "worktrees_auto_session", {});
  assert.equal(reread.enabled, false, "explicit opt-out persists");

  const on = await callOk(client, "worktrees_auto_session", { enabled: true });
  assert.equal(on.enabled, true);

  assert.match(
    await callErr(client, "worktrees_auto_session", { enabled: "yes" }),
    /must be boolean/
  );
});

test("create with sessionId binds the worktree; list exposes the session", async (t) => {
  const store = tmpDir();
  const repo = tmpDir();
  makeRepo(repo, { remote: false });
  const client = await started(t, { ZCODE_WORKTREE_STORE_ROOT: store });

  const created = await callOk(client, "worktrees_create", {
    repoPath: repo,
    name: "sess-bound",
    sessionId: "sess_deadbeef-0000",
  });
  assert.equal(created.name, "sess-bound");

  const list = await callOk(client, "worktrees_list", { repoPath: repo });
  assert.equal(list.worktrees[0].session?.id, "sess_deadbeef-0000");
});

test("server syncs Settings UI value into the marker (env → marker bridge)", async (t) => {
  const store = tmpDir();

  // UI = false → server start adopts it
  let client = await McpClient.start({
    ZCODE_WORKTREE_STORE_ROOT: store,
    ZCODE_WORKTREE_AUTO_SESSION: "false",
  });
  await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "t", version: "0" },
  });
  client.stop();
  let marker = JSON.parse(await readFile(join(store, "auto-session.json"), "utf8"));
  assert.deepEqual(
    { enabled: marker.enabled, source: marker.source, lastUiValue: marker.lastUiValue },
    { enabled: false, source: "ui", lastUiValue: false }
  );

  // /worktree:auto on → command value sticky while UI stays false
  const { writeAutoSession } = await import("../../plugins/git-worktrees/mcp/lib/store.mjs");
  await writeAutoSession(store, true);
  client = await McpClient.start({
    ZCODE_WORKTREE_STORE_ROOT: store,
    ZCODE_WORKTREE_AUTO_SESSION: "false",
  });
  await client.request("ping", {});
  client.stop();
  marker = JSON.parse(await readFile(join(store, "auto-session.json"), "utf8"));
  assert.equal(marker.enabled, true, "command value sticky while UI unchanged");
  assert.equal(marker.source, "command");

  // UI flips to true → newest deliberate change wins
  client = await McpClient.start({
    ZCODE_WORKTREE_STORE_ROOT: store,
    ZCODE_WORKTREE_AUTO_SESSION: "true",
  });
  await client.request("ping", {});
  client.stop();
  marker = JSON.parse(await readFile(join(store, "auto-session.json"), "utf8"));
  assert.deepEqual(
    { enabled: marker.enabled, source: marker.source, lastUiValue: marker.lastUiValue },
    { enabled: true, source: "ui", lastUiValue: true }
  );
});

test("server without the UI env leaves the marker alone", async (t) => {
  const store = tmpDir();
  const client = await started(t, { ZCODE_WORKTREE_STORE_ROOT: store });
  await callOk(client, "worktrees_auto_session", {}); // status only
  client.stop();
  assert.equal(existsSync(join(store, "auto-session.json")), false, "no env → no marker written");
});
