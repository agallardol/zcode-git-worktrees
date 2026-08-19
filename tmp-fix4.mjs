import { readFileSync, writeFileSync } from "node:fs";
let o = readFileSync("plugins/git-worktrees/mcp/lib/ops.mjs", "utf8");
const broken = String.raw`["-c", \`git -C \\\${wtPath} reset -q --hard && rm -f \\\${wtPath}/.zcode-checkout-pending\`]`;
const fixed = '["-c", `git -C "${wtPath}" reset -q --hard && rm -f "${wtPath}/.zcode-checkout-pending"`]';
if (!o.includes(broken)) { console.error("broken line not found"); process.exit(1); }
o = o.replace(broken, fixed);
writeFileSync("plugins/git-worktrees/mcp/lib/ops.mjs", o);
console.log("interpolation fixed");
