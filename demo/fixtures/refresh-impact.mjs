// Refreshes the Impact fixture of the smoke test (demo/fixtures/review/impact.json): the callers of what PR #2
// changes, as the language server finds them in a checkout of the PR's head. No model, nothing paid.
//
//   node demo/fixtures/refresh-impact.mjs <checkout of the PR head> [diff in demo/fixtures/review, default pr2.diff]
//
// The bridge (mods/pr-review/lsp_bridge.py) runs in a Herdr home of its own under the temp folder and is stopped at
// the end; the checkout is only read. The result names paths inside the repository only.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = new URL("./review/", import.meta.url), repo = new URL("../../", import.meta.url);
const { splitPatch, hunksOf, diffRows } = await import(new URL("mods/pr-review/pr.js", repo));
const { computeImpact } = await import(new URL("mods/pr-review/impact.js", repo));
const { isInfraFile } = await import(new URL("mods/pr-review/infra.js", repo));
const root = process.argv[2] && resolve(process.argv[2]), diff = process.argv[3] ?? "pr2.diff";
if (!root) { console.error("usage: node demo/fixtures/refresh-impact.mjs <checkout of the PR head> [diff]"); process.exit(2); }

const bridge = fileURLToPath(new URL("mods/pr-review/lsp_bridge.py", repo)), home = mkdtempSync(join(tmpdir(), "impact-home-"));
const env = { ...process.env, HERDR_APP_HOME: home }, py = (...args) => execFileSync("python3", [bridge, ...args], { env, encoding: "utf8" });
// The extensions the bridge has a server for, read from its own table.
const exts = new Set(JSON.parse(execFileSync("python3", ["-c", `import json, sys; sys.path.insert(0, sys.argv[1]); import lsp_bridge; print(json.dumps(sorted(lsp_bridge.EXT)))`, fileURLToPath(new URL("mods/pr-review/", repo))], { encoding: "utf8" })));
const supported = (path) => exts.has(path.split("/").pop().includes(".") ? path.split(".").pop().toLowerCase() : "");
const patch = splitPatch(readFileSync(new URL(diff, here), "utf8")), hunks = hunksOf(patch).map((h) => ({ ...h, rows: diffRows(h.lines) }));
const infraPaths = new Set(patch.filter(isInfraFile).map((f) => f.path)), infra = (p) => infraPaths.has(p) || isInfraFile({ path: p }); // as impact-view.js impactInfra
try {
  let r;
  for (let i = 0; i < 60; i++) { // a cold Java or Rust index answers "starting" first
    r = await computeImpact({ call: async (endpoint, body) => JSON.parse(py("call", endpoint, JSON.stringify({ ...body, trusted: true }))), root, hunks, supported, infra });
    if (r.status !== "starting") break;
    await new Promise((done) => setTimeout(done, 2000));
  }
  if (r.status !== "ok") { console.error(`impact: ${r.status}: ${r.message}`); process.exit(1); }
  const out = diff === "pr2.diff" ? "impact.json" : `impact-${diff.replace(/\.diff$/, "")}.json`;
  writeFileSync(new URL(out, here), `${JSON.stringify(r.model, null, 1)}\n`);
  console.log(`${out}: ${r.model.functions.length} changed, ${r.model.functions.reduce((n, f) => n + f.callers.length, 0)} callers, ${r.model.ms} ms`);
} finally {
  try { py("stop"); } catch { /* not running */ }
  rmSync(home, { recursive: true, force: true });
}
