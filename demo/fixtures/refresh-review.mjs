// Refreshes the review fixtures of the smoke test (mods/pr-review/test_smoke.mjs) from a folder of analysis and
// findings files, as a Herdr home or a test run wrote them:
//
//   node demo/fixtures/refresh-review.mjs <folder with *.json>
//
// Every *.json of the folder is copied into demo/fixtures/review, scrubbed for a public repository: mail addresses
// become "member", local paths (/Users/…, /home/…, /private/…, /var/folders/…) "/tmp/x", the user's name "user". The
// diffs here (pr1.diff, pr2.diff) are scrubbed already, which changed some hunk ids; an analysis names the ids of the
// diff it read, so each of its hunks gets the id of the hunk at the same place (file, then order) in the diff here,
// and that id is replaced in every file copied. Files of demo/fixtures/review that are not in the folder stay. Last,
// check.py's leak scan runs over demo/fixtures/review; a leak left fails the script (exit 1) and names it.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";

const here = new URL("./review/", import.meta.url), repo = new URL("../../", import.meta.url);
const { splitPatch, hunksOf } = await import(new URL("mods/pr-review/pr.js", repo));
const src = process.argv[2];
if (!src) { console.error("usage: node demo/fixtures/refresh-review.mjs <folder with *.json>"); process.exit(2); }

const user = userInfo().username;
const scrub = (text) => text
  .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, (m, at, all) => (all.slice(Math.max(0, at - 4), at) === "git@" ? m : "member"))
  .replace(/(?:\/Users|\/home|\/private|\/var\/folders)\/[^\s"'\\`)]*/g, "/tmp/x")
  .replaceAll(user, "user");

// The diff's hunks by file, in order: {path: [id, …]}.
const byFile = (diff) => hunksOf(splitPatch(readFileSync(new URL(diff, here), "utf8"))).reduce((m, h) => ({ ...m, [h.path]: [...(m[h.path] ?? []), h.id] }), {});
const diffs = { 1: byFile("pr1.diff"), 2: byFile("pr2.diff") };

const files = readdirSync(src).filter((f) => f.endsWith(".json")).sort();
const texts = Object.fromEntries(files.map((f) => [f, scrub(readFileSync(`${src}/${f}`, "utf8"))]));
const ids = new Map(); // the analysis' hunk id → the id of the same hunk in the scrubbed diff
for (const [f, text] of Object.entries(texts)) {
  const doc = JSON.parse(text), pr = /\/pull\/(\d+)/.exec(doc?.source ?? "")?.[1], diff = diffs[pr];
  if (!Array.isArray(doc?.hunks) || !diff) continue;
  const seen = {};
  for (const h of doc.hunks) {
    const path = String(h.id).replace(/:[^:]*$/, ""), k = (seen[path] = (seen[path] ?? -1) + 1), id = diff[path]?.[k];
    if (!id) throw new Error(`${f}: hunk ${h.id} has no counterpart in pr${pr}.diff`);
    if (id !== h.id) ids.set(h.id, id);
  }
}
for (const [f, text] of Object.entries(texts)) {
  let out = text;
  for (const [from, to] of ids) out = out.replaceAll(from, to);
  writeFileSync(new URL(f, here), out);
}
console.log(`copied ${files.length} files, ${ids.size} hunk ids moved to the scrubbed diffs`);

// check.py's leak scan over the folder (the same patterns the repo check uses).
const scan = `import sys, glob, os
sys.path.insert(0, ".github/scripts"); import check
bad = [f"{f}:{n}: {h}" for f in sorted(glob.glob("demo/fixtures/review/*")) for n, line in enumerate(open(f, encoding="utf-8").read().splitlines(), 1) for h in check.leaks(line)]
print("\\n".join(bad)); sys.exit(1 if bad else 0)`;
try { execFileSync("python3", ["-c", scan], { cwd: repo, stdio: "inherit" }); console.log("leak scan: none"); }
catch { console.error("leak scan: the lines above leak; fix the scrub rules"); process.exit(1); }
