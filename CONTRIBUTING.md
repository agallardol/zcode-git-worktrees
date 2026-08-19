# Contributing

Thanks for improving Git Worktrees for ZCode.

## Development setup

```sh
git clone https://github.com/agallardol/zcode-git-worktrees
cd zcode-git-worktrees
npm test
```

That's the whole setup — the plugin is **zero-dependency Node** (≥ 18) and the
test suite runs against local throwaway git fixtures: no network, no model
calls, no secrets.

## Layout

| Path | What |
|---|---|
| `plugins/git-worktrees/mcp/lib/` | Core: `ops.mjs` (operations), `git.mjs` (execFile-only plumbing), `state.mjs`, `safety.mjs`, `carryover.mjs`, `snapshot.mjs`, `lock.mjs`, `store.mjs` |
| `plugins/git-worktrees/mcp/server.mjs` | MCP stdio server (JSON-RPC 2.0) |
| `plugins/git-worktrees/hooks/scripts/` | SessionStart (auto-session) + PreToolUse (edit guard) |
| `plugins/git-worktrees/commands/` | Slash commands |
| `tests/{unit,integration,adversarial}/` | 129 tests; adversarial is the fun one |

## Ground rules

- **Safety invariants win over features.** Never-delete-uncommitted-work,
  no-escape-from-store, and no-auto-execution-of-repo-commands are enforced by
  tests; if your change touches them, extend the tests first.
- Match the existing style: ES modules, `execFile` (never `shell` outside
  `runCommands`), `async`/`await`, no new runtime dependencies.
- Add tests for every behavior change. `npm test` must stay green
  (CI runs it on macOS and Linux, Node 20 and 22).

## Trying your changes in ZCode

The app copies plugins into its cache at install time, so after editing:

```sh
# re-install from your local checkout (ZCode Protocol):
HELPER="/Applications/ZCode.app/Contents/Frameworks/ZCode Helper.app/Contents/MacOS/ZCode Helper"
ENGINE="/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs"
WSP='{"workspacePath":"'"$PWD"'","workspaceKey":"'"$PWD"'"}'
echo '{"id":1,"method":"plugins/marketplace/update","params":{"marketplace":"zcode-git-worktrees","workspace":'"$WSP"'}}' \
  | ELECTRON_RUN_AS_NODE=1 "$HELPER" "$ENGINE" app-server
```

(or bump the version in `marketplace.json` and reinstall from the UI).

## Releasing

1. Bump the version in `marketplace.json`, `plugins/git-worktrees/.zcode-plugin/plugin.json`,
   `package.json`, and `VERSION` in `mcp/server.mjs`.
2. `npm test`, merge to `main`, tag `vX.Y.Z`, push, `gh release create`.
