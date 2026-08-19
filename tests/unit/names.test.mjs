import { test } from "node:test";
import assert from "node:assert/strict";
import { friendlyName, WORD_LISTS } from "../../plugins/git-worktrees/mcp/lib/names.mjs";

test("friendlyName produces adjective-animal names", () => {
  for (let i = 0; i < 50; i++) {
    const name = friendlyName();
    assert.match(name, /^[a-z]+-[a-z]+$/);
  }
});

test("friendlyName avoids taken names", () => {
  const generated = new Set(Array.from({ length: 200 }, () => friendlyName()));
  const one = [...generated][0];
  const next = friendlyName(new Set([one]));
  assert.notEqual(next, one);
});

test("friendlyName falls back when the pool is exhausted", () => {
  const all = new Set();
  for (const a of WORD_LISTS.adjectives) {
    for (const b of WORD_LISTS.animals) all.add(`${a}-${b}`);
  }
  const name = friendlyName(all);
  assert.match(name, /^worktree-[0-9a-f]{6}$/);
});

