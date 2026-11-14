// Run: node test_pr.mjs
import assert from "node:assert/strict";
import { diffRows, buildPrompt, nextChange, splitPatch, selection, lineLabel, anchorRow, buildReview, hunksOf, budget,
  mapReview, suspectComment, fileRows, fileTree, reviewRequest, stepKey, lowValue, lineKey, rangeOf, codeOf, isStale } from "./pr.js";

const rows = diffRows(["@@ -1,3 +1,3 @@", " a", "-b", "+B", " c", "@@ -10,2 +10,2 @@", " x", "+y"]);
assert.deepEqual(rows[3], { kind: "+", number: 2, n: 2, text: "B" });
assert.deepEqual(rows[2], { kind: "-", number: 2, o: 2, text: "b" });
assert.deepEqual([rows[1].o, rows[1].n, rows[4].o, rows[4].n], [1, 1, 3, 3]);
assert.equal(rows[7].number, 11);

const p = buildPrompt({ pr: { number: 7, title: "Fix" }, file: "a.js", anchor: { ...selection(rows, 2), hunk: "-b" }, question: " Why? " });
assert.equal(p, "PR #7 \"Fix\": question about `a.js` line 2 (old, removed).\n\n```diff\n-b\n```\n\nWhy?");
assert.equal(buildPrompt({ base: "origin/main", question: "Fine?" }), "Branch diff against origin/main: question.\n\nFine?");
assert.equal(buildPrompt({ base: "origin/main", question: "Fine?", lang: "German" }), "Branch diff against origin/main: question.\n\nFine?\n\nAnswer in German.");
assert.equal(buildPrompt({ base: "b", question: "?", lang: "English" }).includes("Answer in"), false);
assert.equal(buildPrompt({ pr: { number: 7, title: "Fix", url: "https://github.com/o/r/pull/7" }, question: "?" }), "PR #7 \"Fix\" (https://github.com/o/r/pull/7): question.\n\n?");

// gh pr diff: one entry per file, new name (old one when deleted), counts only from hunks.
const patch = splitPatch(["diff --git a/a b.js b/a b.js", "index 1..2 100644", "--- a/a b.js", "+++ b/a b.js", "@@ -1,2 +1,2 @@", "-x", "+y", "+--- not a header",
  "diff --git a/gone.txt b/gone.txt", "deleted file mode 100644", "--- a/gone.txt", "+++ /dev/null", "@@ -1 +0,0 @@", "-bye",
  "diff --git a/img.png b/img.png", "Binary files a/img.png and b/img.png differ", ""].join("\n"));
assert.deepEqual(patch.map((f) => [f.path, f.add, f.del, f.binary]), [["a b.js", 2, 1, false], ["gone.txt", 0, 1, false], ["img.png", 0, 0, true]]);
assert.equal(patch[0].lines[3], "@@ -1,2 +1,2 @@");
// A range: new-side numbers, context stops at the hunk header, removed-only ranges use old numbers.
const r2 = diffRows(["@@ -1,5 +1,5 @@", " a", " b", "-c", "+C", "+D", " e", " f", " g", " h", "@@ -20 +20 @@", " z"]);
const sel = selection(r2, 5, 3);
assert.deepEqual([sel.start, sel.end, sel.old], [3, 4, false]);
assert.equal(sel.hunk, "@@ -1,5 +1,5 @@\n a\n b\n-c\n+C\n+D\n e\n f\n g");
assert.equal(lineLabel(sel), "lines 3–4");
const gone = selection(r2, 3);
assert.equal(lineLabel(gone), "line 3 (old, removed)");
assert.equal(anchorRow(r2, gone), 3);
assert.equal(anchorRow(r2, sel), 5);
assert.equal(anchorRow(r2, { end: 99, old: false }), -1);
// STALE: a selection records its lines' text; the same lines changed after a push mark it, unknown ones never do.
assert.equal(sel.code, "C\nD");
assert.equal(gone.code, "c");
assert.equal(codeOf(r2, { start: 19, end: 20, old: false }), undefined, "line 19 is not in the rows");
const pushed = diffRows(["@@ -1,5 +1,5 @@", " a", " b", "-c", "+C", "+E", " e"]);
const mine = { ...sel, head: "h1" };
assert.equal(isStale(mine, "h2", codeOf(pushed, mine)), true, "line 4 reads E now");
assert.equal(isStale(mine, "h2", codeOf(r2, mine)), false, "same lines after a push");
assert.equal(isStale(mine, "h1", codeOf(pushed, mine)), false, "same head");
assert.equal(isStale({ ...mine, head: null }, "h2", codeOf(pushed, mine)), true, "head unknown then: the text decides");
assert.equal(isStale({ ...mine, code: undefined }, "h2", "x"), false, "an old comment without a record");
assert.equal(isStale(mine, "h2", undefined), false, "its lines are not in the diff now");

const review = buildReview({ pr: { number: 7, title: "Fix" }, comments: [{ file: "a.js", ...gone, hunk: "-c", text: "Why removed?" }, { file: "b.js", text: " Name? " }] });
assert.equal(review, "PR #7 \"Fix\": code review with 2 points. Work through the points one by one: answer questions, make the requested changes. At the end, say briefly per point what you did." +
  "\n\n1. `a.js` line 3 (old, removed)\n```diff\n-c\n```\nWhy removed?\n\n2. `b.js`\nName?");

// Hunk ids ignore the @@ numbers (a moved hunk keeps its id), duplicates get a suffix; aliases map back.
const hk = hunksOf(splitPatch(["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1 +1 @@", "-a", "+b", "@@ -9 +9 @@", "-a", "+b", "@@ -20 +20 @@", "+new"].join("\n")));
const moved = hunksOf(splitPatch(["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -5 +5 @@", "-a", "+b"].join("\n")));
assert.deepEqual(hk.map((h) => h.alias), ["h1", "h2", "h3"]);
assert.equal(moved[0].id, hk[0].id);
assert.equal(hk[1].id, hk[0].id + "#2");
// j/k: starts of change blocks, from no selection too.
assert.equal(nextChange(r2, null, 1), 3);
assert.equal(nextChange(r2, 3, 1), -1);
assert.equal(nextChange(rows, 3, 1), 7);
assert.equal(nextChange(rows, 7, -1), 2);
assert.equal(nextChange(rows, null, -1), 7);

// Over budget: later hunks are cut, a smaller one after a big one still fits.
const big = { path: "x", alias: "h1", lines: ["+" + "a".repeat(50)] }, small = { path: "y", alias: "h2", lines: ["+b"] };
assert.deepEqual(budget([small, big, small], 30), { sent: [small, small], cut: ["h1"] });

// ---- review layout
// File status from the patch header.
const st = splitPatch(["diff --git a/n.js b/n.js", "new file mode 100644", "--- /dev/null", "+++ b/n.js", "@@ -0,0 +1 @@", "+x",
  "diff --git a/o.js b/p.js", "similarity index 90%", "rename from o.js", "rename to p.js", "--- a/o.js", "+++ b/p.js", "@@ -1 +1 @@", "-a", "+b"].join("\n"));
assert.deepEqual(st.map((f) => [f.path, f.status, f.from]), [["n.js", "added", undefined], ["p.js", "renamed", "o.js"]]);

// Risk order: high, medium, low, skim, then reading order; aliases map to ids, unknown ones are dropped; questions
// and flows capped at 3; suggestions from the steps (and an older analysis's suspects) land on rows,
// a line the hunk lacks snaps to its first change (approx).
const rh = hunksOf(splitPatch(["diff --git a/a.js b/a.js", "--- a/a.js", "+++ b/a.js", "@@ -10,3 +10,3 @@", " ctx", "-old", "+new", " end",
  "diff --git a/b.test.js b/b.test.js", "--- a/b.test.js", "+++ b/b.test.js", "@@ -1 +1,2 @@", " t", "+t2"].join("\n")));
const fl0 = { function: "f", at: "a.js:11", inputs: [], output: null, trace: Array.from({ length: 20 }, (_, i) => ({ path: "a.js", line: i, values: "x = 1" })) };
const rv = mapReview({ title: "T", steps: [
  { title: "tests", risk: "skim", reading_order: 5, check_questions: ["q"], hunks: ["h2"] },
  { title: "logic", risk: "low", reading_order: 1, why_it_matters: "w", explanation: "e", check_questions: ["1", "2", "3", "4"], hunks: ["h1", "h9"],
    flows: [fl0, fl0, fl0, fl0], suggestions: [{ hunk: "h1", side: "new", line: 11, severity: "high", text: "boom" }, { hunk: "h1", side: "new", line: 99, severity: "medium", text: "far" }] },
  { title: "sec", risk: "high", reading_order: 3, hunks: [] },
  { title: "logic2", risk: "high", reading_order: 2, hunks: [] },
  { title: "old", category: "tests", risk: "high", hunks: [] },
  { title: "odd", risk: "??", hunks: [] }],
  suspects: [{ hunk: "h1", side: "old", line: 11, severity: "low", reason: "gone" }, { hunk: "h7", side: "new", line: 1, severity: "high", reason: "x" }],
  asks: [{ text: "a", coverage: "extra", hunks: ["h2"] }, { text: "b", coverage: "?", hunks: [] }] }, rh);
assert.deepEqual(rv.steps.map((s) => s.title), ["logic2", "sec", "odd", "logic", "tests", "old"]);
assert.deepEqual(rv.steps.map((s) => s.risk), ["high", "high", "medium", "low", "skim", "skim"]);
const lg = rv.steps[3];
assert.deepEqual([lg.hunks, lg.questions.length, lg.why, lg.text, lg.order, lg.flows.length, lg.flows[0].trace.length], [[rh[0].id], 3, "w", "e", 1, 3, 12]);
assert.deepEqual(rv.suspects.map((s) => [s.line, s.old, s.approx, s.severity, s.reason]), [[11, true, false, "low", "gone"], [11, false, false, "high", "boom"], [11, true, true, "medium", "far"]]);
assert.deepEqual(rv.asks.map((a) => [a.coverage, a.hunks]), [["extra", [rh[1].id]], ["absent", []]]);
assert.equal(stepKey(lg), stepKey({ hunks: [rh[0].id], title: "renamed later" }));
// Architecture-review findings stay in their layer, in the reviewer findings' shape, with an id from category, file and title.
{
  const fs = [{ file: "./a.js", line: 11, severity: "high", category: "scope", title: "Unrelated rename", detail: "d", suggestion: "s" },
    { file: "a.js", line: 3, severity: "??", category: "scope", title: "Unrelated rename" }, { file: "", title: "no file" }, { file: "b.js", line: "7", end: 9, title: "Leaky boundary" }];
  const one = mapReview({ steps: [{ title: "logic", hunks: ["h1"], findings: fs }, { title: "tests", hunks: ["h2"] }] }, rh);
  const [st] = one.steps, k = stepKey(st);
  assert.deepEqual(st.findings.map((f) => [f.file, f.line, f.end, f.severity, f.category, f.reviewer, f.step]),
    [["a.js", 11, 11, "high", "scope", "analysis", k], ["b.js", 7, 9, "medium", "structure", "analysis", k]]);
  assert.equal(st.findings[0].suggestion, "s"); assert.deepEqual(one.steps[1].findings, []);
  const again = mapReview({ steps: [{ title: "renamed", hunks: ["h2"], findings: [{ file: "a.js", line: 40, category: "scope", title: "Unrelated rename" }] }] }, rh);
  assert.equal(again.steps[0].findings[0].id, st.findings[0].id); // other hunks after a push, same category, file and title: the same finding (its status stays)
  assert.notEqual(st.findings[0].id, st.findings[1].id);
}
// Stale hunk (no lines today): its suspects go, its step keeps the id so the UI can say "veraltet".
assert.deepEqual(mapReview({ steps: [{ title: "s", hunks: ["h1"] }], suspects: [{ hunk: "h1", line: 1, reason: "r" }] }, [{ alias: "h1", id: "gone" }]).suspects, []);

// Suggestion -> pending comment: the same anchor a click on that line gives.
const rows1 = diffRows(rh[0].lines), sc = suspectComment(rv.suspects[1], rows1, "id1");
assert.deepEqual({ ...sc, hunk: undefined }, { id: "id1", file: "a.js", start: 11, end: 11, old: false, hunk: undefined, code: "new", text: "boom", from: "ki" });
assert.equal(sc.hunk, selection(rows1, rows1.findIndex((r) => r.kind === "+")).hunk);
assert.equal(suspectComment({ ...rv.suspects[1], line: 500 }, rows1, "x"), null);

// Files view: gaps between hunks, opened from either side, whole file; tail unknown until the file is loaded.
const fh = [diffRows(["@@ -3,2 +3,2 @@", "-c", "+C", " d"]), diffRows(["@@ -10 +10 @@", "-j", "+J"])];
const kinds = (rs) => rs.map((r) => (r.kind === "gap" ? `gap${r.gap}:${r.hidden}` : r.kind === "@" ? "@" : `${r.kind.trim()}${r.number}`)).join(" ");
assert.equal(kinds(fileRows(fh, null)), "gap0:2 @ -3 +3 4 gap1:5 @ -10 +10 gap2:null");
const file = Array.from({ length: 12 }, (_, i) => `l${i + 1}`);
assert.equal(kinds(fileRows(fh, file, { 1: { down: 2, up: 1 } })), "gap0:2 @ -3 +3 4 5 6 gap1:2 9 @ -10 +10 gap2:2");
assert.equal(kinds(fileRows(fh, file, { 1: { down: 30 } })), "gap0:2 @ -3 +3 4 5 6 7 8 9 @ -10 +10 gap2:2");
assert.equal(kinds(fileRows(fh, file, {}, true)), "1 2 @ -3 +3 4 5 6 7 8 9 @ -10 +10 11 12");
assert.equal(fileRows(fh, file, {}, true)[0].text, "l1");
// Old numbers of opened context: shifted by the lines added/removed before (here none), after a deletion one less.
assert.deepEqual(fileRows([diffRows(["@@ -2,2 +2 @@", "-x", " y"])], ["a", "y", "z"], {}, true).map((r) => [r.o, r.n]), [[1, 1], [undefined, undefined], [2, undefined], [3, 2], [4, 3]]);
assert.equal(kinds(fileRows([diffRows(["@@ -0,0 +1,2 @@", "+a", "+b"])], null, {}, false, false)), "@ +1 +2");
assert.equal(kinds(fileRows([diffRows(["@@ -5,2 +4,0 @@", "-x", "-y"])], file.slice(0, 6), {}, true)), "1 2 3 4 @ -5 -6 5 6");
assert.equal(fileRows(fh, null)[2].h, 0);

// File tree: folders once, before their files; a closed folder hides everything below it.
const tree = (c) => fileTree(["a.js", "src/x.js", "src/y/z.js", "src/z.js"], new Set(c)).map((n) => `${"  ".repeat(n.depth)}${n.name}${n.dir ? "/" : ""}`).join("|");
assert.equal(tree([]), "a.js|src/|  x.js|  y/|    z.js|  z.js");
assert.equal(tree(["src/y"]), "a.js|src/|  x.js|  y/|  z.js");
assert.equal(tree(["src"]), "a.js|src/");

// Request: low-value hunks are cut first, what's sent stays in diff order, cache names carry the model.
const rq = splitPatch(["diff --git a/package-lock.json b/package-lock.json", "--- a/package-lock.json", "+++ b/package-lock.json", "@@ -1 +1 @@", "-" + "x".repeat(200), "+" + "y".repeat(200),
  "diff --git a/b.js b/b.js", "--- a/b.js", "+++ b/b.js", "@@ -1 +1 @@", "-a", "+b", "diff --git a/c.js b/c.js", "--- a/c.js", "+++ b/c.js", "@@ -1 +1 @@", "-a", "+b"].join("\n"));
assert.ok(lowValue("web/package-lock.json") && lowValue("dist/app.js") && !lowValue("src/lock.js"));
const full = reviewRequest({ url: "u", files: rq, model: "haiku", context: { id: "default", env: null }, dir: "/d" });
assert.deepEqual([full.req.hunks.map((h) => h.alias), full.req.cut], [["h1", "h2", "h3"], []]);
assert.ok(full.out.endsWith("-haiku.json") && full.latest.endsWith("-haiku.json") && full.out !== full.latest);
const MODELS0 = (await import("./pr.js")).MODELS;
const was = MODELS0.haiku.chars; MODELS0.haiku.chars = 100;
const capped = reviewRequest({ url: "u", files: rq, model: "haiku", context: { id: "default", env: null }, dir: "/d" });
MODELS0.haiku.chars = was;
assert.deepEqual([capped.req.hunks.map((h) => h.alias), capped.req.cut], [["h2", "h3"], ["h1"]]);
// A model from the CLI's list: its class sets the budget, and its id is safe in a file name.
const { tierOf } = await import("./pr.js");
assert.deepEqual(["haiku", "claude-haiku-4-5-20251001", "sonnet", "claude-sonnet-5", "opus", "fable", "claude-fable-5-1[1m]", undefined].map(tierOf),
  ["haiku", "haiku", "sonnet", "sonnet", "opus", "opus", "opus", "opus"]);
// Code is read and judged by at least Sonnet: a stored haiku (an old pick) becomes sonnet.
assert.deepEqual(["haiku", "claude-haiku-4-5-20251001", undefined, "sonnet", "opus", "claude-fable-5-1"].map((await import("./pr.js")).codeModel),
  ["sonnet", "sonnet", "sonnet", "sonnet", "opus", "claude-fable-5-1"]);
MODELS0.haiku.chars = 100;
const byId = reviewRequest({ url: "u", files: rq, model: "claude-haiku-4-5[1m]", context: { id: "default", env: null }, dir: "/d" });
MODELS0.haiku.chars = was;
assert.deepEqual(byId.req.cut, ["h1"], "a haiku id gets haiku's budget");
assert.ok(byId.out.endsWith("-claude-haiku-4-5_1m_.json") && byId.req.model === "claude-haiku-4-5[1m]", byId.out);
// Prices by the longest id prefix; an unknown model costs its class's price.
const { priceOf } = await import("./pr.js");
assert.deepEqual([priceOf("claude-opus-5-5"), priceOf("claude-opus-5"), priceOf("claude-fable-5-2"), priceOf("claude-fable-5-1"), priceOf("claude-sonnet-5-5"), priceOf("claude-haiku-5-5"), priceOf("claude-haiku-4-5-20251001"), priceOf("sonnet")],
  [[4, 20], [5, 25], [8, 40], [10, 50], [2, 10], [0.1, 0.5], [1, 5], [3, 15]]);

// Range selection by line keys: survives new row arrays, works either way round and across hunks of a file;
// expanded context in between is part of it, a hidden gap is left out of the quoted code.
const fr = fileRows(fh, file, { 1: { down: 1 } });
const k3 = lineKey(fr.find((r) => r.kind === "+")), k10 = lineKey(fr.filter((r) => r.kind === "+")[1]);
assert.deepEqual([k3, lineKey(fr.find((r) => r.kind === "-")), lineKey(fr.find((r) => r.kind === "@")), lineKey(fr.find((r) => r.kind === "gap"))], ["+3", "-3", null, null]);
const again = fileRows(fh, file, { 1: { down: 1 } }); // a re-render: new objects, same keys
const [lo, hi] = rangeOf(again, k10, k3);
const across = selection(again, lo, hi);
assert.deepEqual([across.start, across.end, across.old], [3, 10, false]);
assert.ok(!across.hunk.includes("undefined") && across.hunk.includes("+C") && across.hunk.includes("+J"));
assert.equal(rangeOf(again, "+3", "+99"), null);
assert.deepEqual(rangeOf(again, "+3", "+3"), [lo, lo]);

console.log("ok");

// Findings: reports (last line wins, half lines skipped) never settle a finding; moved code asks for a recheck.
const { parseReports, findingStatus, fixPrompt, mergeFindings, findingCounts, countLine } = await import("./pr.js");
const reps = parseReports('{"id":"a","status":"wontfix"}\n{"id":"a","status":"fixed","commit":"abc"}\n{"id":"b","sta');
assert.deepEqual(Object.keys(reps), ["a"]);
const fa = { id: "a", head: "h1", code: "x()" }, fb = { id: "b", head: "h1", code: "y()" };
// The agent reports "fixed": the finding stays "Fix sent" (progress) until a verification, also when the head moved.
assert.equal(findingStatus(fa, { a: { s: "progress", fixHead: "h1" } }, reps, "h1", "x()"), "progress");
assert.equal(findingStatus(fa, { a: { s: "progress", fixHead: "h1" } }, reps, "h2", "z()"), "progress");
assert.equal(findingStatus(fa, { a: { s: "fixed", fixHead: "h1", verify: { result: "fixed" } } }, reps, "h2", "z()"), "fixed");
assert.equal(findingStatus(fa, {}, reps, "h1", "x()"), "open", "a report alone settles nothing");
// The agent declined, or "progress" came from a chat draft (no fixHead): unresolved again.
assert.equal(findingStatus(fb, { b: { s: "progress", fixHead: "h1" } }, { b: { id: "b", status: "wontfix" } }, "h1", "y()"), "open");
assert.equal(findingStatus(fb, { b: { s: "progress" } }, reps, "h1", "y()"), "open");
// A dismissal covers the sources of then: a source that joins the line later makes it unresolved again.
assert.equal(findingStatus({ id: "b", ids: ["b", "s1"] }, { b: { s: "dismissed", ids: ["b", "s1"] } }, {}, "h1", undefined), "dismissed");
assert.equal(findingStatus({ id: "b", ids: ["sec", "b", "s1"] }, { b: { s: "dismissed", ids: ["b", "s1"] } }, {}, "h1", undefined), "open");
assert.equal(findingStatus({ id: "b", ids: ["sec", "b"] }, { b: { s: "dismissed" } }, {}, "h1", undefined), "dismissed", "an older dismissal without its sources stays");
assert.equal(findingStatus(fb, {}, reps, "h2", "  y()"), "open");
assert.equal(findingStatus(fb, {}, reps, "h2", "y(1)"), "recheck");
assert.equal(findingStatus(fb, { b: { s: "dismissed" } }, reps, "h2", "y(1)"), "dismissed");
{
  // One finding per defect: same file and new-side line merge, the highest severity leads, every source stays.
  const A = (id, file, line, severity, extra = {}) => ({ id, reviewer: "analysis", step: "k1", file, line, end: line, severity, category: "structure", title: `T ${id}`, detail: `D ${id}`, suggestion: "", ...extra });
  const S = (path, line, severity, reason, extra = {}) => ({ key: `${path}:+${line}:${reason}`, hunk: "h", path, line, old: false, severity, reason, approx: false, ...extra });
  const sec = { id: "sec1", reviewer: "security", file: "t.yaml", line: 18, end: 20, severity: "high", title: "Token unset", detail: "Fails open", suggestion: "Fail closed", code: "x", head: "h1" };
  const list = [sec, A("a1", "t.yaml", 18, "medium", { category: "security", suggestion: "Set it", title: "Token unset in the template" }), A("a2", "e.py", 9, "high", { title: "No id, so dedupe is impossible" }), A("a3", "e.py", 30, "medium")];
  const sugs = [S("e.py", 9, "high", "No id. Dedupe is impossible."), S("t.yaml", 18, "medium", "Token is unset"), S("e.py", 12, "low", "Nit"), S("e.py", 40, "high", "Import couples the two. Split it."),
    S("e.py", 50, "medium", "Open bucket", { category: "security" }), S("e.py", 9, "low", "old side", { old: true })];
  const m = mergeFindings(list, sugs);
  assert.deepEqual(m.findings.map((f) => [f.file, f.line, f.severity, f.sources.map((x) => `${x.reviewer}:${x.severity}`).join(" ")]), [
    ["e.py", 9, "high", "analysis:high ai:high"], ["e.py", 40, "high", "ai:high"], ["t.yaml", 18, "high", "security:high analysis:medium ai:medium"],
    ["e.py", 30, "medium", "analysis:medium"], ["e.py", 50, "medium", "ai:medium"]]);
  assert.deepEqual(m.notes.map((s) => s.reason), ["Nit", "old side"], "a suggestion alone on its line is a note; a high or security one is a finding");
  const tok = m.findings[2];
  assert.deepEqual([tok.id, tok.ids.length, tok.title, tok.security, tok.step, tok.end, tok.head], ["sec1", 3, "Token unset", true, "k1", 20, "h1"]);
  assert.deepEqual([m.findings[1].title, m.findings[1].detail, m.findings[1].security, m.findings[4].security], ["Import couples the two", "Split it.", false, true]);
  // The source that already has a status keeps the id, so a fix sent for it and its report stay with the finding.
  assert.equal(mergeFindings(list, sugs, { a1: { s: "progress", fixHead: "h1", at: "2" } }).findings[2].id, "a1");
  assert.equal(mergeFindings([{ ...sec, line: 0 }, { ...sec, id: "sec2", line: 0 }]).findings.length, 2, "findings without a line never merge");
  // line and end come from a model: whole numbers with line <= end for every caller, whatever it wrote (0: no line).
  assert.deepEqual(mergeFindings([{ ...sec, end: 3 }, { ...sec, id: "s2", file: "b", line: 4, end: 1e9 }, { ...sec, id: "s3", file: "c", line: 2.5, end: "9" }, { ...sec, id: "s4", file: "d", line: 5, end: 7.5 }])
    .findings.map((f) => [f.file, f.line, f.end]), [["b", 4, 1e9], ["c", 0, 0], ["d", 5, 5], ["t.yaml", 18, 18]]);
  // One count for every view: the severities add up to the unresolved ones; a fix sent is still unresolved.
  const st = { sec1: "progress", a2: "open", a3: "dismissed" };
  const c = findingCounts(m.findings, (f) => st[f.id] ?? (f.line === 40 ? "fixed" : "recheck"));
  assert.deepEqual(c, { total: 5, unresolved: 3, sent: 1, fixed: 1, dismissed: 1, high: 2, medium: 1, low: 0, security: 2 });
  assert.equal(countLine(c), "3 unresolved: 2 high, 1 medium · 1 with a fix sent · 1 fixed · 1 dismissed");
  assert.equal(countLine(findingCounts([], () => "open")), "No findings");
}
const fp = fixPrompt([{ id: "a1", severity: "high", reviewer: "codex", file: "a.js", line: 3, end: 4, title: "T", detail: "D", suggestion: "S" }], { number: 7, title: "Fix", url: "u" }, "/r.jsonl");
assert.ok(fp.includes("[a1] high · codex · `a.js`:3–4: T") && fp.includes(">> /r.jsonl") && fp.includes('"id": "a1"'));
assert.ok(fp.includes("\nSuggestion: S\n"), "a short suggestion stays on its line");
assert.ok(fixPrompt([{ id: "a2", severity: "low", reviewer: "ai", file: "a.js", line: 1, title: "T", detail: "D", suggestion: "```js\nx()\n```" }], null, "/r").includes("Suggestion:\n```js\nx()\n```"), "a code block starts on its own line");
console.log("ok");

// Open reviews: created once (startedAt kept), merged by url, merged/closed PRs turn done after a day, done ones
// go after 14 days, in-progress ones stay.
const { touchReview, expireReviews, progressLine } = await import("./pr.js");
const D = 86400000;
let reg = touchReview([], { url: "a", progress: { steps: 9, stepsChecked: 1 } }, 1000);
reg = touchReview(reg, { url: "b" }, 2000);
reg = touchReview(reg, { url: "a", progress: { stepsChecked: 3, comments: 2 } }, 3000);
assert.deepEqual(reg.map((r) => [r.url, r.startedAt, r.lastTouched, r.status]), [["a", 1000, 3000, "in-progress"], ["b", 2000, 2000, "in-progress"]]);
assert.equal(progressLine(reg[0].progress), "3/9 steps · 2 comments");
reg = touchReview(reg, { url: "b", status: "sent" }, 4000);
const prsNow = [{ url: "a", state: "merged", updatedAt: new Date(0).toISOString() }];
let ex = expireReviews(reg, prsNow, 2 * D);
assert.deepEqual(ex.map((r) => [r.url, r.status]), [["b", "sent"], ["a", "done"]]);
ex = expireReviews(ex, prsNow, 2 * D + 15 * D);
assert.deepEqual(ex, []);
assert.deepEqual(expireReviews([{ url: "c", status: "in-progress", lastTouched: 0 }], [], 100 * D).map((r) => r.url), ["c"]);
console.log("ok");

// Resume roundtrip: what review.js saves (uiState, as JSON in review-progress.json) comes back as the same fields.
const { resumeFields } = await import("./pr.js");
const ui = { tab: "steps", fileFocus: "a.js", focusHunk: "a.js:abc", cur: 3, order: "reading", fsel: { path: "a.js", a: "+3", b: "+10" }, page: null, model: "opus", values: false };
const back = resumeFields(JSON.parse(JSON.stringify(ui)));
assert.deepEqual(back.fields, { tab: "steps", fileFocus: "a.js", focusHunk: "a.js:abc", cur: 3, order: "reading", fsel: { path: "a.js", a: "+3", b: "+10" }, page: null });
assert.deepEqual([back.scroll, back.model, back.values], ["a.js:abc", "opus", false]);
assert.equal(resumeFields(undefined), null);
console.log("ok");

// List keys: unique, and the same for every other item when a definition card is inserted under a row.
const { itemKeys, expandTabs, offsetAt, tokenAt } = await import("./pr.js");
const krows = diffRows(["@@ -1,2 +1,2 @@", " a", "-b", "+b"]);
const base = krows.map((r, ri) => ({ t: "row", path: "x.py", src: krows, ri }));
base.splice(1, 0, { t: "file", f: { path: "x.py" } });
const k1 = itemKeys(base), withDef = [...base.slice(0, 3), { t: "def", d: { key: "x.py:+1" } }, ...base.slice(3)], k2 = itemKeys(withDef);
assert.equal(new Set(k1).size, k1.length);
assert.deepEqual(k2.filter((k) => !k.startsWith("d|")), k1);
assert.deepEqual(itemKeys([base[2], base[2]]), [k1[2], `${k1[2]}#1`]); // a hunk in two steps
// A wrapped line's visual lines: each its own key, the first the line's key as before.
assert.deepEqual(itemKeys([0, 1, 2].map((part) => ({ ...base[2], part }))), [k1[2], `${k1[2]}~1`, `${k1[2]}~2`]);
// Click → token → position: tabs expand to the next stop of 4, the character is the UTF-16 offset in the original
// line, the line is the row's new line (old line on a removed row).
assert.equal(expandTabs("\tx\ty"), "    x   y");
assert.deepEqual([offsetAt("\tfoo", 0), offsetAt("\tfoo", 3), offsetAt("\tfoo", 4), offsetAt("\tfoo", 6)], [0, 0, 1, 3]);
const prow = diffRows(["@@ -10,2 +20,2 @@", "-\told_call()", "+\tnew_call(x)"]);
const sp = [{ start: 4, end: 12, kind: "function", ref: true }];
assert.deepEqual(tokenAt(prow[2], sp, 122 + 5 * 8 + 1, 122, 8), { name: "new_call", side: "+", line: 20, character: 1 });
assert.deepEqual(tokenAt(prow[1], [{ start: 4, end: 12, ref: true }], 122 + 4 * 8, 122, 8), { name: "old_call", side: "-", line: 10, character: 1 });
assert.equal(tokenAt(prow[2], sp, 122 + 1 * 8, 122, 8), null); // on the indentation
assert.equal(tokenAt(prow[2], sp, 100, 122, 8), null); // in the gutter
console.log("ok");

// since your last review, verification, pictures, pre-merge checks, triage
{
  const { markReviewed, sinceBase, verifyCandidates, applyVerification, levels, blastArch, preMergeChecks, mergeBlockers, triageOf, findingStatus, mapReview } = await import("./pr.js");
  // A visit marks the head as seen; it never downgrades a sent mark of the same head; send always moves it.
  const sent = markReviewed(null, "a1", "sent", 1);
  assert.deepEqual(sent, { sha: "a1", how: "sent", at: 1 });
  assert.equal(markReviewed(sent, "a1", "seen", 2), sent);
  assert.deepEqual(markReviewed(sent, "b2", "seen", 3), { sha: "b2", how: "seen", at: 3 });
  assert.equal(markReviewed(sent, null, "seen", 3), sent); // head unknown: keep
  assert.equal(sinceBase({ reviewed: sent }, "a1"), null); // nothing moved
  assert.equal(sinceBase({ reviewed: sent }, "b2").sha, "a1");
  assert.equal(sinceBase({}, "b2"), null);

  // Verification: only Fix-sent findings on an older head, not verified on this one; verdicts merge into the status.
  const fs = [{ id: "f1" }, { id: "f2" }, { id: "f3" }, { id: "f4" }];
  const st = { f1: { s: "progress", fixHead: "a1" }, f2: { s: "progress", fixHead: "b2" }, f3: { s: "open" }, f4: { s: "progress", fixHead: "a1", verify: { head: "b2" } } };
  assert.deepEqual(verifyCandidates(fs, st, "b2", () => "progress").map((f) => f.id), ["f1"]);
  const out = applyVerification(st, [{ id: "f1", verdict: "fixed", reason: "guarded" }, { id: "f2", verdict: "not_fixed", reason: "still null" }, { id: "f3", verdict: "unclear", reason: "?" }], "b2", 0);
  assert.equal(out.f1.s, "fixed"); assert.equal(out.f1.fixHead, "a1"); assert.equal(out.f1.verify.reason, "guarded");
  assert.equal(out.f2.s, "open"); assert.equal(out.f2.verify.result, "not_fixed");
  assert.equal(out.f3.s, "open"); assert.equal(out.f3.verify.result, "unclear");
  // Only the verification settles it: "not fixed" reopens, the agent's "fixed" report alone leaves "Fix sent".
  assert.equal(findingStatus({ id: "f2" }, out, { f2: { id: "f2", status: "fixed" } }, null, undefined), "open");
  assert.equal(findingStatus({ id: "f1" }, out, { f1: { id: "f1", status: "fixed" } }, null, undefined), "fixed");
  assert.equal(findingStatus({ id: "f2" }, st, { f2: { id: "f2", status: "fixed" } }, null, undefined), "progress");

  // Columns: longest path from the sources; a cycle does not hang.
  const lv = levels([{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }], [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "a", to: "c" }, { from: "x", to: "d" }]);
  assert.deepEqual(["a", "b", "c", "d"].map((k) => lv.get(k)), [0, 1, 2, 0]);
  const cyc = levels([{ id: "p" }, { id: "q" }], [{ from: "p", to: "q" }, { from: "q", to: "p" }]);
  assert.deepEqual([cyc.get("p"), cyc.get("q")], [0, 0]);

  // Architecture: columns by calls, nodes stacked, an edge between columns as segments with its badge on the lane.
  const arch = { groups: [{ id: "web", label: "Web" }, { id: "api", label: "API" }], nodes: [{ id: "ui", group: "web", status: "changed" }, { id: "inv", group: "api", status: "new" }, { id: "db", group: "api", status: "removed" }, { id: "x", group: "nope" }],
    edges: [{ from: "ui", to: "inv", label: "Creates" }, { from: "inv", to: "db", label: "Persists" }] };
  const { archLayout } = await import("./arch.js");
  const L = archLayout(arch);
  assert.deepEqual(L.groups.map((g) => g.label), ["Web", "API", "System"]);
  const [ui, inv, db] = ["ui", "inv", "db"].map((id) => L.nodes.find((n) => n.id === id));
  assert.deepEqual([ui.col, inv.col, db.col], [0, 1, 2]); // inv calls db: db one column right, inside the API group
  const e = L.paths[0];
  assert.ok(e.segments.length >= 2); // the lane leg drops out when both ports are level
  assert.equal(e.segments[0].x1, ui.x + ui.w); // leaves the right edge of the source
  assert.equal(e.segments.at(-1).x2, inv.x); // ends at the left edge of the target
  assert.ok(e.badge.x > ui.x + ui.w && e.badge.x < inv.x && e.label === "Creates" && e.mark === "①");
  assert.ok(L.paths[1].segments.at(-1).x2 === db.x && L.groups[1].x + L.groups[1].w > db.x + db.w); // the API frame spans both columns
  assert.deepEqual(archLayout(arch, "before").nodes.map((n) => n.id).sort(), ["db", "ui", "x"]);
  assert.deepEqual(archLayout(arch, "after").paths.length, 1);
  const b = blastArch({ units: [{ id: "u1", label: "API", status: "added", files: ["api.ts"], spots: 5 }], context: [{ id: "c1", file: "src/perm.ts", direction: "upstream", relation: "Checks admin", links_to: "u1" }, { id: "c2", file: "mail.ts", direction: "downstream", relation: "Sends", links_to: "u1" }] }, [{ file: "api.ts", severity: "high" }]);
  assert.deepEqual(archLayout(b).nodes.map((n) => n.col), [0, 1, 2]);
  assert.deepEqual(b.counts, { added: 1, changed: 0, up: 1, down: 1 });
  assert.equal(b.nodes[1].findings.length, 1);

  // Pre-merge checks and blockers.
  const checks = preMergeChecks({ title: "Fix it", rules: [{ rule: "No secrets", status: "fail", why: "token in config" }, { rule: "Docs", status: "n/a" }],
    ctx: { checks: [{ name: "build", bucket: "pass" }, { name: "lint", bucket: "fail" }, { name: "e2e", bucket: "pending" }, { name: "x", bucket: "skipping" }], mergeable: "CONFLICTING" } });
  assert.deepEqual(checks.map((c) => c.ok), [false, false, true, false, null, false]);
  assert.equal(preMergeChecks({ title: "feat(api): SHELF-1 add x" })[0].ok, true);
  const bl = mergeBlockers({ checks, findings: [{ id: "f", title: "SQL injection", severity: "high", file: "a", line: 1 }, { id: "g", severity: "low" }], unverified: 2, sent: (f) => f.id === "f",
    related: { open: [{ number: 9, overlap: 2, files: ["a", "b"] }, { number: 10, overlap: 0 }] } });
  assert.deepEqual(bl.map((x) => x.title), ["Code conflicts need to be resolved", "1 CI check is failing", "Rule not met: Conventional Commit title", "Rule not met: No secrets", "SQL injection", "2 fixes are not verified", "Overlaps with open PR #9"]);
  assert.equal(bl[4].why, "a:1 · unresolved high finding · fix sent, not verified");

  // Triage: type from the prefix, effort from the analysis else the size, P1 for overlap or high risk.
  const tr = triageOf({ pr: { title: "feat(x): y" }, analysis: { effort: { score: 3 }, mergeRisk: { level: "high", why: "auth" } } });
  assert.deepEqual([tr.priority, tr.chips], [1, ["High security risk", "Feature", "Medium effort"]]);
  assert.match(tr.why, /merge risk is high \(auth\)/);
  // A high merge risk on a small PR: no "Deep review" beside "Low effort".
  assert.ok(!triageOf({ pr: { title: "fix: a" }, size: { files: 1, lines: 5 }, analysis: { mergeRisk: { level: "high" } } }).chips.some((c) => /review|look/i.test(c)));
  const small = triageOf({ pr: { title: "docs: z" }, size: { files: 1, lines: 10 } });
  assert.deepEqual([small.priority, small.chips, small.why], [3, ["Docs", "Low effort"], "A quick look should do: small and low risk."]);
  assert.equal(triageOf({ pr: { title: "x" }, related: { open: [{ overlap: 1 }] }, llm: { priority: 2, why: "w" } }).why, "w");

  // Old analyses (no merge risk, rules, pictures) still map.
  const old = mapReview({ steps: [{ title: "t", risk: "high", hunks: [] }] }, []);
  assert.deepEqual([old.mergeRisk, old.effort, old.rules, old.arch, old.blast, old.steps[0].visuals, old.steps[0].isNew], [null, null, [], null, null, [], false]);
  // Several pictures per layer (and for the whole PR); the older single `visual` reads as a list of one.
  const pic = (kind) => ({ kind, title: kind, nodes: [{ id: "a", label: "A" }], edges: [] });
  const vis = mapReview({ visuals: [pic("state_machine")], steps: [{ title: "t", hunks: [], visuals: [pic("architecture"), pic("state_machine"), { kind: "flow", nodes: [] }] }, { title: "u", hunks: [], visual: pic("flow") }] }, []);
  assert.deepEqual(vis.steps.map((s) => s.visuals.map((v) => v.kind)), [["architecture", "state_machine"], ["flow"]]);
  assert.deepEqual(vis.visuals.map((v) => v.kind), ["state_machine"]);
  // Sources on statements; asks name the spec-only elements of the pictures they describe.
  const { specElements } = await import("./pr.js");
  const src = mapReview({ intent: [{ text: "Remind members", source: "implemented", evidence: "src/r.ts:9" }, { text: "Fine overdue loans", source: "spec" }, { text: "x", source: "bogus" }],
    behavior_points: [{ text: "Mails go out at 08:00", source: "existing" }],
    architecture: { groups: [], nodes: [{ id: "fee", label: "Fee service", source: "spec" }, { id: "rem", label: "Reminders", source: "implemented" }], edges: [] },
    asks: [{ text: "Charge fees", coverage: "absent", hunks: [], elements: ["fee"] }], steps: [{ title: "t", hunks: [], visuals: [{ kind: "state_machine", nodes: [{ id: "over", label: "Overdue", source: "spec" }], edges: [] }] }] }, []);
  assert.deepEqual(src.intent.map((x) => [x.source, x.evidence]), [["implemented", "src/r.ts:9"], ["spec", null], [null, null]]);
  assert.deepEqual(src.behaviorPoints.map((x) => x.source), ["existing"]);
  assert.deepEqual(src.asks[0].elements, ["fee"]);
  assert.deepEqual([...specElements(src).values()].map((x) => [x.id, x.page, x.step]), [["fee", "arch", null], ["over", null, 0]]);
  // Diagrams refreshed after the text analysis: "updated for <head>"; made for another head: older.
  const { diagramsState } = await import("./pr.js");
  const saved = { generated: "2026-01-01T10:00:00Z", diagrams: { generated: "2026-01-02T10:00:00Z", head: "abc1234567" } };
  assert.deepEqual(diagramsState(saved, "abc1234567"), { updated: true, short: "abc1234", older: false });
  assert.deepEqual(diagramsState(saved, "fff0000000"), { updated: true, short: "abc1234", older: true });
  assert.deepEqual(diagramsState({ generated: "x" }, "abc", true), { updated: false, short: null, older: false }); // never refreshed: as the analysis
  assert.equal(diagramsState({ generated: "x" }, "abc", false).older, true); // the analysis is for other hunks
  const plain0 = mapReview({ behavior: "b", steps: [] }, []);
  assert.deepEqual([plain0.intent, plain0.behaviorPoints], [[], []]); // old analyses: the text as before
  const neu = mapReview({ merge_risk: { level: "high", why: "w" }, effort: { score: 7 }, rule_checks: [{ rule: "a", status: "pass" }, { rule: "b", status: "fail" }], steps: [{ title: "t", new: true, hunks: [] }] }, []);
  assert.deepEqual([neu.mergeRisk.level, neu.effort.score, neu.rules.map((r) => r.rule), neu.steps[0].isNew], ["high", 5, ["b", "a"], true]);
  console.log("ok since/verify/pictures/checks/triage");
}

// PRs you didn't open
{
  const { parsePrRef, ghTarget, pruneSources } = await import("./pr.js");
  assert.deepEqual(parsePrRef("acme/bookshelf#12"), { repo: "acme/bookshelf", number: 12, url: "https://github.com/acme/bookshelf/pull/12" });
  assert.equal(parsePrRef(" https://github.com/o/r.js/pull/7/files ")?.url, "https://github.com/o/r.js/pull/7"); // a tab of the PR page
  assert.equal(parsePrRef("https://github.com/o/r.js/pull/7").repo, "o/r.js");
  assert.equal(parsePrRef("o/r/pull/7#issuecomment-1").number, 7);
  assert.equal(parsePrRef("nope"), null);
  const t = ghTarget({ number: 5, title: "x", url: "https://github.com/o/r/pull/5", author: { login: "kim" }, isDraft: true, headRefOid: "abc", reviewDecision: "" }, { context: "blue", source: "repo" });
  assert.deepEqual([t.repo, t.author, t.state, t.headSha, t.review, t.session], ["o/r", "kim", "draft", "abc", null, null]);
  assert.equal(ghTarget({ number: 6, url: "u", repository: { nameWithOwner: "a/b" } }, { context: "blue" }).repo, "a/b");
  assert.deepEqual(Object.keys(pruneSources({ a: { at: 1 }, b: { at: 3 }, c: { at: 2 } }, 2)), ["b", "c"]);
  console.log("ok sources");
}

// A newer analysis' fields pass through; an analysis cached before them loads with empty ones.
{
  const { mapReview, mergeFindings, findingFacts, runsOf, hunksOf, splitPatch } = await import("./pr.js");
  const hs = hunksOf(splitPatch("diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1,2 +1,3 @@\n x\n+y\n z\n")).map((h, i) => ({ ...h, alias: `h${i + 1}` }));
  const old = mapReview({ steps: [{ title: "s", hunks: ["h1"], check_questions: ["q1?"], findings: [{ file: "a.py", line: 2, title: "T", severity: "high", category: "bug" }] }],
    asks: [{ text: "one", coverage: "seen" }, { text: "two", coverage: "absent" }, { text: "three" }] }, hs);
  assert.deepEqual(old.asks.map((a) => [a.id, a.state, a.why, a.acceptance, a.findings]), [["c1", "met", "", null, []], ["c2", "not_done", "", null, []], ["c3", "not_done", "", null, []]]);
  assert.deepEqual([old.unlinked, old.components, old.componentCounts, old.access, old.steps[0].questionFiles], [[], [], null, [], [""]]);
  const of = old.steps[0].findings[0];
  assert.match(of.id, /^a[0-9a-f]+$/);
  assert.deepEqual(findingFacts(of), { impact: null, effect: "", preconditions: [], certainty: null, criteria: [], breaks: null, effort: null, reachable_from: [], reachability: null });
  const now = mapReview({ unlinked: ["c2"], components: [{ name: "Queue", status: "new" }], component_counts: { new: 1, changed: 0, no_owner: 1, codeowners: false }, access: [{ resource: "Api", public: true }],
    steps: [{ title: "s", hunks: ["h1"], check_questions: ["", "q1?", "q2?"], question_files: ["x.py", "a.py", ""],
      suggestions: [{ hunk: "h1", line: 2, side: "new", severity: "low", category: "availability", text: "No retry. Add one." }],
      findings: [{ id: "a5587afa0", file: "a.py", line: 9, title: "No id", severity: "high", category: "test", impact: "breaks_requirement", effect: "Repeated mails.", preconditions: ["redelivery"],
        certainty: "derived", criteria: ["c1"], breaks: { from: "n1", to: "n2", edge: "e5" }, reachable_from: ["acc1"], reachability: "public" },
        { file: "a.py", line: 9, title: "x", category: "availability", certainty: "guessed", reachability: "from the moon" }] }],
    asks: [{ id: "c1", text: "one", state: "broken", why: "because", acceptance: true, findings: ["a5587afa0"], coverage: "absent" }, { id: "x1", text: "extra", state: "extra", acceptance: false, coverage: "extra" }] }, hs);
  assert.deepEqual(now.asks.map((a) => [a.id, a.state, a.why, a.acceptance, a.findings, a.coverage]), [["c1", "broken", "because", true, ["a5587afa0"], "absent"], ["x1", "extra", "", false, [], "extra"]]);
  assert.deepEqual([now.unlinked, now.components[0].name, now.componentCounts.codeowners, now.access[0].public], [["c2"], "Queue", false, true]);
  assert.deepEqual([now.steps[0].questions, now.steps[0].questionFiles], [["q1?", "q2?"], ["a.py", ""]], "a question keeps its file when an empty one is dropped");
  const [nf, nf2] = now.steps[0].findings;
  assert.deepEqual([nf.id, nf.category, nf.impact, nf.effect, nf.preconditions, nf.certainty, nf.criteria, nf.breaks], ["a5587afa0", "test", "breaks_requirement", "Repeated mails.", ["redelivery"], "derived", ["c1"], { from: "n1", to: "n2", edge: "e5" }]);
  assert.deepEqual([nf2.category, nf2.certainty], ["availability", null]);
  assert.deepEqual([nf.reachable_from, nf.reachability, nf2.reachable_from, nf2.reachability], [["acc1"], "public", [], null], "where a finding can be reached from; an unknown word is dropped");
  assert.equal(now.suspects[0].category, "availability");
  // Merged: a low suggestion about availability is a finding of its own; the facts come from the leading source,
  // and what that one lacks (a reviewer has no criteria and no breaks) from the first source that has it.
  const sec = { id: "s1", reviewer: "security", file: "a.py", line: 9, end: 9, severity: "high", title: "No id on the event", detail: "d", impact: "unauthorized_access", effect: "Anyone reads it.", certainty: "confirmed" };
  const m = mergeFindings([sec, { ...nf, severity: "medium" }], now.suspects);
  assert.deepEqual(m.findings.map((f) => [f.file, f.line, f.severity, f.reviewer, f.category]), [["a.py", 9, "high", "security", undefined], ["a.py", 2, "low", "ai", "availability"]]);
  assert.deepEqual(m.notes, []);
  assert.deepEqual(findingFacts(m.findings[0]), { impact: "unauthorized_access", effect: "Anyone reads it.", preconditions: ["redelivery"], certainty: "confirmed", criteria: ["c1"], breaks: { from: "n1", to: "n2", edge: "e5" }, effort: null,
    reachable_from: ["acc1"], reachability: "public" }, "a reviewer names no reachability: the merged finding has the analysis's");
  assert.ok(m.findings[0].ids.includes(now.asks[0].findings[0]), "an ask finds its finding through ids");
  assert.deepEqual(findingFacts(m.findings[1]), { impact: null, effect: "", preconditions: [], certainty: null, criteria: [], breaks: null, effort: null, reachable_from: [], reachability: null });
  // Reviewer runs: the state as written, or derived for an entry from before it was.
  const runs = runsOf({ a: { busy: true, started: "t" }, b: { at: "t", count: 0 }, c: { error: "boom", at: "t" }, d: { state: "failed", error: "x" }, e: { state: "done", scope: { read: ["a.py"], checked: [], skipped: [] }, at: "t" }, f: {} });
  assert.deepEqual(Object.values(runs).map((r) => r.state), ["running", "done", "failed", "failed", "done", null]);
  assert.deepEqual([runs.b.scope, runs.b.error, runs.b.count, runs.e.scope.read, runs.d.error], [null, null, 0, ["a.py"], "x"]);
  assert.deepEqual(runsOf(undefined), {});
  console.log("ok analysis fields");
}

{
  // The Overview: the task check as one list, the verdict line, the copied review state, a stacked PR.
  const { taskList, taskHead, verdictParts, reviewState, certaintyLine, severityTip, componentLine, mergeBlockers, triageOf } = await import("./pr.js");
  const f = (id, severity, extra = {}) => ({ id, ids: [id], severity, title: `T ${id}`, file: "a.py", line: 3, security: false, criteria: [], preconditions: [], certainty: null, impact: null, ...extra });
  const asks = [{ id: "c1", text: "one", state: "broken", why: "w1", acceptance: true, findings: ["f1"] }, { id: "c2", text: "two", state: "partly", why: "w2", acceptance: true, findings: [] },
    { id: "c3", text: "three", state: "met", why: "", acceptance: false, findings: [] }, { id: "x1", text: "more", state: "extra", why: "", acceptance: false, findings: [] }];
  const all = [f("s1", "high", { security: true, certainty: "assumed", preconditions: ["no token set", "no authorizer"], impact: "unauthorized_access" }), f("f1", "high"), f("f2", "medium", { ids: ["f2", "r9"], criteria: ["c2"] }),
    f("f3", "medium"), f("f4", "low", { criteria: ["c1"] }), f("s2", "medium", { security: true })];
  const st = { f4: "dismissed", s2: "fixed", f3: "progress" }, statusOf = (x) => st[x.id] ?? "open";
  const list = taskList(asks, all, ["c2", "c9"], statusOf);
  assert.deepEqual(list.security.map((x) => x.id), ["s1"], "the Security group has the unresolved security findings");
  assert.deepEqual(list.rows.map((r) => [r.ask.id, r.findings.map((x) => x.id), r.unlinked]), [["c1", ["f1", "f4"], false], ["c2", ["f2"], false], ["c3", [], false]], "an ask's findings come from its own list and from the findings' criteria");
  assert.deepEqual(list.extra.map((r) => r.ask.id), ["x1"]);
  assert.deepEqual(list.other.map((x) => x.id), ["f3"], "not in the task: unresolved, no security, linked to no ask");
  assert.equal(taskHead(list), "0 of 2 acceptance criteria met, 1 extra");
  assert.equal(taskList([{ ...asks[1], findings: [] }], [], ["c2"], statusOf).rows[0].unlinked, true, "partly without a finding: nothing backs it");
  // An older analysis says nothing about acceptance: every ask that is not extra counts.
  const old = taskList(asks.map((a) => ({ ...a, acceptance: null })), [], [], statusOf);
  assert.equal(taskHead(old), "1 of 3 criteria met, 1 extra");
  assert.equal(taskHead(taskList([], [], [], statusOf)), "");
  const counts = { unresolved: 4, high: 2, medium: 2, low: 0, security: 1 };
  assert.deepEqual(verdictParts(list, counts).map((p) => [p.text, p.tone]), [["1 security finding (high)", "high"], ["0 of 2 acceptance criteria met", "high"], ["2 high findings", "high"]]);
  assert.deepEqual(verdictParts(taskList(asks, [f("a", "high", { security: true }), f("b", "low", { security: true })], [], statusOf), { unresolved: 2, high: 1, low: 1, security: 2 })[0].text, "2 security findings, 1 high");
  assert.deepEqual(verdictParts(taskList([asks[2]], [], [], statusOf), { unresolved: 0, security: 0 }).map((p) => [p.text, p.tone]), [["1 of 1 criteria met", "ok"], ["No unresolved findings", "ok"]]);
  assert.deepEqual(verdictParts(list, counts, { failed: 1, toVerify: 2 }).slice(3).map((p) => [p.key, p.text, p.tone]), [["checks", "1 check failed", "high"], ["verify", "2 fixes to verify", "medium"]]);
  assert.equal(certaintyLine(all[0]), "Assumed, not checked · only if no token set (and 1 more)");
  assert.equal(certaintyLine(f("x", "low", { certainty: "derived" })), "Derived from the code");
  assert.deepEqual([["The caller passes auth"], ["SQS redelivery"]].map((preconditions) => certaintyLine(f("x", "low", { preconditions }))), ["only if the caller passes auth", "only if SQS redelivery"]);
  assert.equal(certaintyLine(f("x", "low")), "", "an older finding says nothing about it");
  assert.match(severityTip(all[0]), /^High severity: .*unauthorized access.*Here: unauthorized access\.$/);
  assert.doesNotMatch(severityTip(f("x", "low")), /Here:/);
  assert.equal(componentLine({ new: 8, changed: 0, no_owner: 7, codeowners: true }), "8 new components, 7 without an owner");
  assert.equal(componentLine({ new: 1, changed: 2, no_owner: 0, codeowners: true }), "1 new and 2 changed components, each with an owner");
  assert.equal(componentLine({ new: 0, changed: 1, no_owner: 1, codeowners: false }), "1 changed component; the repository has no CODEOWNERS file");
  assert.equal(componentLine({ new: 0, changed: 0 }), null);
  assert.equal(componentLine(null), null);
  // The copied state: a security finding with its title only (no file, no line, no facts), the others with their place.
  const text = reviewState({ pr: { repo: "o/r", number: 2, title: "feat: x", url: "https://example.test/pull/2" }, head: "abcdef1234", list, counts, findings: all, statusOf, progress: "1 of 9 files viewed" });
  assert.match(text, /^Review state of o\/r#2: feat: x\nhttps:\/\/example\.test\/pull\/2 at abcdef1\n/);
  assert.match(text, /\n1 security finding \(high\) · 0 of 2 acceptance criteria met · 2 high findings\n/);
  assert.match(text, /\n- broken: one \(acceptance criterion\). w1\n- partly: two \(acceptance criterion\). w2\n- met: three\n- extra: more\n/);
  assert.match(text, /\nUnresolved \(3\):\n- high, security: T s1\n- high: T f1 \(a\.py:3\)\n- medium: T f2 \(a\.py:3\)\n/);
  assert.match(text, /\nFix sent \(1\):\n- medium: T f3 \(a\.py:3\)\n/);
  assert.match(text, /\nFixed \(1\):\n- medium, security: T s2\n/);
  assert.match(text, /\n1 of 9 files viewed\n/);
  assert.doesNotMatch(text, /no token set|T s1 \(/, "nothing of a security finding but its title");
  // A stacked PR is the base of this one: no blocker, and no reason to review early.
  const related = { open: [{ number: 1, overlap: 4, files: ["a"], stacked: true }, { number: 5, overlap: 1, files: ["b"] }] };
  assert.deepEqual(mergeBlockers({ related }).map((b) => b.title), ["Overlaps with open PR #5"]);
  assert.equal(triageOf({ pr: { title: "x" }, related: { open: [related.open[0]] } }).priority, 3);
  console.log("ok overview");
}

// One plain line of a Markdown text: its first paragraph, no code block, no list markers, no marks.
{
  const { plainText, mergeFindings } = await import("./pr.js");
  assert.equal(plainText("`TOKEN` defaults to `\"\"`. **Bad**.\n\nSecond paragraph."), 'TOKEN defaults to "". Bad.');
  assert.equal(plainText("Refuse it.\n\n```python\nx = 1\n```"), "Refuse it.", "a code block's language word does not show");
  assert.equal(plainText("```python\nx = 1\n```\n\nThen the reason."), "Then the reason.");
  assert.equal(plainText("```suggestion\n  return 1\n```"), "return 1", "nothing but a code block: its first line");
  assert.equal(plainText("- one\n- two\n1. three"), "one two three");
  assert.equal(plainText("## Why\nsee [the docs](https://example.com) now"), "Why see the docs now");
  assert.deepEqual([plainText("#2 feat: loan_id"), plainText("plain title"), plainText(null)], ["#2 feat: loan_id", "plain title", ""]);
  // A suggestion's title is cut at the first sentence end outside inline code, and is plain.
  const sug = (line, reason) => ({ key: `e.py:+${line}`, hunk: "h", path: "e.py", line, old: false, severity: "high", reason });
  assert.deepEqual(mergeFindings([], [sug(1, "`json.loads(x); y` raises `KeyError` on a missing id; both return 500."), sug(2, "Import couples the two. Split it."), sug(3, "No sentence end here")]).findings.map((f) => [f.title, f.detail]),
    [["json.loads(x); y raises KeyError on a missing id", "both return 500."], ["Import couples the two", "Split it."], ["No sentence end here", ""]]);
  console.log("ok plain text");
}

// The Findings tab: a finding's steps, how the count comes about, owners, effort.
{
  const { findingSteps, funnel, funnelLine, ownerOf, quickFirst, hasEffort, findingFacts, mergeFindings } = await import("./pr.js");
  const show = (steps) => steps.map((s) => `${s.done ? "+" : s.next ? ">" : "-"}${s.key}`).join(" ");
  const facts = [["Agent", "a sub-agent (t2), done"], ["Branch", "fix/2-x"], ["Commit", "68999a3"], ["Report", "The agent reports it fixed."], ["Check", "Verified at ccddf95: unclear"]];
  // Only reported: the next step says what is missing, by the finding's certainty; every step not reached has its sentence.
  const s0 = findingSteps({ certainty: "derived" }, undefined);
  assert.equal(show(s0), "+reported >evidence -sent -verified -in_pr");
  assert.equal(s0[1].missing, "No evidence yet: the finding is derived from the code.");
  assert.deepEqual(s0.map((s) => Boolean(s.missing)), [false, true, true, true, true]);
  assert.match(findingSteps({ certainty: "assumed" }, {})[1].missing, /could not be checked/);
  // A fix sent without evidence: evidence stays unmarked, the next step is the check; the fix's details sit at their step.
  const s1 = findingSteps({ certainty: "derived" }, { s: "progress", fixHead: "h1" }, { report: { status: "fixed", commit: "68999a3" }, facts: facts.slice(0, 4) });
  assert.equal(show(s1), "+reported -evidence +sent >verified -in_pr");
  assert.match(s1[3].missing, /^Not verified yet: Verify checks the commit/);
  assert.deepEqual([s1[2].details.map(([l]) => l), s1[3].details, s1[0].details], [["Agent", "Branch", "Commit", "Report"], [], []]);
  // The agent declined: no fix on its way, with its reason; a check that did not pass says so.
  const sd = findingSteps({ certainty: "confirmed" }, { s: "progress", fixHead: "h1" }, { report: { status: "wontfix", note: "not in this repo" }, facts: facts.slice(0, 4) });
  assert.equal(show(sd), "+reported +evidence >sent -verified -in_pr");
  assert.equal(sd[2].missing, "No fix on its way: the agent declined, not in this repo"); assert.equal(sd[2].details.length, 4, "what the agent said stays at its step");
  const s2 = findingSteps({ certainty: "confirmed" }, { s: "open", fixHead: "h1", verify: { result: "not_fixed", reason: "still raises", head: "abcdef1234" } }, { facts });
  assert.equal(show(s2), "+reported +evidence +sent >verified -in_pr");
  assert.equal(s2[3].missing, "Not verified: the check at abcdef1 says not fixed, still raises");
  assert.deepEqual(s2[3].details, [facts[4]]);
  // Checked on the fix branch: verified, not in the PR; on the PR head: all five; an older mark by hand.
  const branch = { s: "progress", fixHead: "h1", verify: { result: "fixed", head: "68999a3", branch: "fix/2-x" } };
  const sb = findingSteps({ certainty: "derived" }, branch, { report: { status: "fixed" } });
  assert.equal(show(sb), "+reported -evidence +sent +verified >in_pr");
  assert.equal(sb[4].missing, "Verified on the fix branch, not in the PR yet: Apply to PR brings it in, then Verify checks the PR head.");
  assert.match(findingSteps({}, { ...branch, verify: { ...branch.verify, result: "not_fixed" } })[3].missing, /^Not verified: the check on fix\/2-x at 68999a3 says not fixed\.$/);
  assert.equal(show(findingSteps({ certainty: "confirmed" }, { s: "fixed", fixHead: "h1", verify: { result: "fixed", head: "h2" } })), "+reported +evidence +sent +verified +in_pr");
  const sh = findingSteps({}, { s: "fixed" });
  assert.equal(show(sh), "+reported -evidence -sent +verified >in_pr"); assert.equal(sh[4].missing, "Marked fixed by hand: no check has read the PR head.");
  // The funnel: reported per source, merged, unresolved, of those on security, of those confirmed.
  const A = (id, line, extra = {}) => ({ id, reviewer: "analysis", file: "a.py", line, end: line, severity: "medium", category: "bug", title: `T${line}`, detail: "", ...extra });
  const m = mergeFindings([{ ...A("s1", 3), reviewer: "security", severity: "high", certainty: "confirmed" }, { ...A("c1", 7), reviewer: "claude" }, A("a1", 3), A("a2", 7), A("a3", 9, { effort: "heavy" }), A("a4", 11, { effort: "quick" })],
    [{ key: "k", path: "a.py", line: 9, old: false, severity: "low", reason: "T9" }]);
  const st = { a4: "dismissed" }, x = funnel(m.findings, (f) => st[f.id] ?? "open");
  assert.deepEqual(x, { by: [["analysis", 4], ["claude", 1], ["security", 1], ["ai", 1]], reported: 7, merged: 4, unresolved: 3, security: 1, confirmed: 1 });
  const names = { analysis: "Analysis", claude: "Claude code review", security: "Security review", ai: "AI suggestion" };
  assert.equal(funnelLine(x, (k) => names[k]),
    "Analysis reported 4, Claude code review 1, Security review 1 and AI suggestion 1, 7 in all. Merged by file and line, that is 4 findings. 3 are unresolved, 1 of them on security, 1 of those confirmed by a run.");
  assert.equal(funnelLine(funnel([m.findings[2]], () => "open")), "analysis reported 1 and ai 1, 2 in all. Merged by file and line, that is 1 finding. 1 is unresolved, none of them on security.");
  assert.equal(funnelLine(funnel([m.findings[1]], () => "fixed")), "analysis reported 1 and claude 1, 2 in all. Merged by file and line, that is 1 finding. None are unresolved.");
  assert.equal(funnelLine(funnel([], () => "open")), "No findings reported.");
  // The owner of a finding's file, when a component there names one.
  const comps = [{ name: "Queue", at: "a.py:6", owner: null }, { name: "Event", at: "a.py:20", owner: "@platform-team" }, { name: "Other", at: "b.py:1", owner: "@web" }];
  assert.deepEqual([ownerOf({ file: "a.py" }, comps), ownerOf({ file: "b.py" }, comps), ownerOf({ file: "c.py" }, comps), ownerOf({ file: "a.py" }, undefined)], ["@platform-team", "@web", null, null]);
  // Effort: passed through and merged; quick wins first keeps the order within one effort, the ones without it last.
  assert.deepEqual([findingFacts({ effort: "quick" }).effort, findingFacts({ effort: "tiny" }).effort, findingFacts({}).effort], ["quick", null, null]);
  assert.deepEqual(m.findings.map((f) => [f.line, f.effort]), [[3, null], [7, null], [9, "heavy"], [11, "quick"]]);
  assert.deepEqual(quickFirst(m.findings).map((f) => f.line), [11, 9, 3, 7]);
  assert.deepEqual([hasEffort(m.findings), hasEffort(m.findings.slice(0, 2))], [true, false]);
  console.log("ok findings tab");
}

// The security view: the security run's block (findings file) in the analysis' old places, else the analysis' own
// (an older cache). Data cut from the demo PR's fixtures: analysis-split / findings-split and analysis-zones.
{
  const { withSecurity, mapReview, mergeFindings } = await import("./pr.js");
  const node = (id) => ({ id, label: id }), edge = ([from, to]) => ({ from, to, label: "" });
  const split = { title: "T", architecture: { groups: [], nodes: ["handler", "consumer", "reminders", "status", "events", "store", "mailer", "sqs"].map(node),
    edges: [["handler", "consumer"], ["reminders", "mailer"], ["reminders", "status"], ["status", "events"], ["events", "sqs"], ["sqs", "consumer"], ["consumer", "mailer"], ["consumer", "store"]].map(edge) },
    steps: [{ title: "Events", hunks: [], findings: [] }, { title: "Front desk handler", depends_on: ["Events"], hunks: [], findings: [] }] };
  const head = "ccddf9524aec9c46d338d296bacce38d994af5fb", generated = "2026-11-14T12:57:55.771992+01:00";
  const security = { head, at: "2026-11-14T13:03:00+0100", picture: generated,
    zones: [{ id: "z1", name: "Internet", trust: "public", evidence: "template.yaml:24", nodes: [] }, { id: "z2", name: "Front desk function", trust: "authenticated", evidence: "", nodes: ["handler", "consumer", "reminders", "status", "events", "mailer", "store"] },
            { id: "z3", name: "Loan events queue", trust: "data", evidence: "", nodes: ["sqs"] }],
    crossing: [{ from: "events", to: "sqs", edge: "e4" }, { from: "sqs", to: "consumer", edge: "e5" }],
    access: [{ id: "acc1", resource: "FrontDesk Api (HttpApi)", node: "handler", public: true, opened_by_pr: true }, { id: "acc2", resource: "FrontDesk SQSSendMessagePolicy", node: "sqs", public: false, opened_by_pr: true }],
    threats: [{ id: "t1", where: { access: "acc1" }, boundary: "Internet → Front desk function", threat: "An empty token passes.", findings: ["e3cec57be283"], result: "finding", note: "" }] };
  const ctx = { head, security_trigger: { run: true, reasons: [{ file: "template.yaml", line: 21, rule: "permissions", text: "template.yaml changes IAM policies or permissions" }], why_not: null } };
  const ai = { ...mapReview(split, []), generated };
  assert.deepEqual(ai.steps.map((s) => s.dependsOn), [[], ["Events"]], "depends_on per layer");
  const v = withSecurity(ai, security, ctx, head);
  assert.deepEqual(v.arch.zones.map((z) => [z.id, z.trust]), [["z1", "public"], ["z2", "authenticated"], ["z3", "data"]]);
  assert.deepEqual(v.arch.nodes.map((n) => n.zone ?? null), ["z2", "z2", "z2", "z2", "z2", "z2", "z2", "z3"]);
  assert.deepEqual(v.arch.edges.map((e) => Boolean(e.crosses)), [false, false, false, false, true, true, false, false]);
  assert.deepEqual([v.access.map((r) => r.id), v.threats.map((t) => t.id), v.securityTrigger.run], [["acc1", "acc2"], ["t1"], true]);
  assert.deepEqual(v.securityFrom, { source: "security", head, at: security.at, older: false, why: null });
  assert.equal(ai.arch.zones, undefined, "the analysis itself is not changed");
  assert.deepEqual(withSecurity(v, security, ctx, head), v, "again on its own result: the same");
  assert.deepEqual([withSecurity(ai, security, ctx, "other").securityFrom.why, withSecurity({ ...ai, generated: "later" }, security, ctx, head).securityFrom.why], ["head", "analysis"], "an older run says so");
  const moved = withSecurity({ ...ai, arch: { ...ai.arch, edges: [edge(["sqs", "consumer"])] } }, security, null, head);
  assert.deepEqual([moved.arch.edges[0].crosses, moved.securityTrigger], [true, null], "a crossing call found by its ends, not by e<k>");
  // An older cache: zones, nodes' zone, crossing edges and access in the analysis' own answer stay, no threats.
  const zonesAnswer = { architecture: { groups: [], zones: [{ id: "z_net", name: "Internet", trust: "public" }, { id: "z_fd", name: "Front desk", trust: "authenticated" }],
    nodes: [{ id: "caller", zone: "z_net" }, { id: "handler", zone: "z_fd" }, { id: "store" }], edges: [{ from: "caller", to: "handler", crosses: true }, { from: "handler", to: "store" }] },
    access: [{ id: "acc1", resource: "FrontDesk HttpApi event", node: "handler" }], steps: [] };
  const old = withSecurity(mapReview(zonesAnswer, []), null, null, head);
  assert.deepEqual([old.arch.zones.length, old.arch.nodes[0].zone, old.arch.edges[0].crosses, old.access[0].id, old.threats, old.securityFrom.source], [2, "z_net", true, "acc1", [], "analysis"]);
  assert.equal(withSecurity(mapReview({ steps: [] }, []), null, null).securityFrom, null, "nothing about security anywhere");
  // The security block wins: the old zones go, a node outside every zone has none.
  const both = withSecurity(mapReview(zonesAnswer, []), { head, zones: [{ id: "a", trust: "public", nodes: ["store"] }], crossing: [], access: [], threats: [] }, null, head);
  assert.deepEqual([both.arch.zones.map((z) => z.id), both.arch.nodes.map((n) => n.zone ?? null), both.arch.edges[0].crosses, both.access], [["a"], [null, null, "a"], undefined, []]);
  // reachable_from, reachability and effort come through on the merged finding from the security run's source.
  const m = mergeFindings([{ id: "aX", reviewer: "analysis", file: "library/handler.py", line: 9, severity: "high", title: "Empty token passes", effort: "moderate" }, // same claim, so one finding
    { id: "e3cec57be283", reviewer: "security", file: "library/handler.py", line: 9, severity: "high", title: "Empty token", reachable_from: ["acc1"], reachability: "public", effort: "quick" }]).findings[0];
  assert.deepEqual([m.reachable_from, m.reachability, m.effort], [["acc1"], "public", "moderate"]);
  console.log("ok security view");
}

// Neighbouring lines: one defect when the titles make the same claim, two when they do not (the real pairs of PR #2).
{
  const { mergeFindings, sameClaim } = await import("./pr.js");
  const F = (id, reviewer, file, line, title, extra = {}) => ({ id, reviewer, file, line, end: line, severity: "high", category: "bug", title, detail: "", suggestion: "", ...extra });
  const pr2 = [
    F("a477", "analysis", "library/consumer.py", 19, "Consumer reads loans from a per-process in-memory store"),
    F("7413", "claude", "library/consumer.py", 20, "Consumer reads from an in-memory store the front desk does not share", { head: "h", code: "if message" }),
    F("a83a", "analysis", "library/consumer.py", 23, "Consumer sets reminded_on directly"),
    F("a9b8", "analysis", "library/reminders.py", 21, "Reminder is mailed inline and again by the consumer"),
    F("43e8", "claude", "library/reminders.py", 22, "Mail is sent before the state change and event, with no atomicity", { severity: "medium" }),
    F("29c1", "claude", "library/reminders.py", 23, "Reminder mailed twice: directly and again by the consumer"),
    F("a03f", "analysis", "library/reminders.py", 33, "publish_overdue always raises ValueError"),
    F("36f9", "claude", "library/reminders.py", 35, "publish_overdue always raises ValueError"),
    F("95ea", "claude", "library/handler.py", 18, "/remind bypasses the state machine and has no input or error handling", { severity: "medium" }),
    F("1cf1", "security", "library/handler.py", 19, "/remind skips the state machine and sends mail for any loan id", { severity: "medium" }),
    F("a09f", "analysis", "library/handler.py", 21, "/remind mails inline and skips the state machine"),
    F("a28d", "analysis", "library/handler.py", 6, "Front desk imports the consumer module"),
    F("1a5f", "security", "library/handler.py", 8, "Front desk auth falls back to an empty token, so `Authorization: Bearer ` passes"),
  ];
  const m = mergeFindings(pr2).findings, at = (f) => `${f.file.split("/").pop()}:${f.line}-${f.end} ${f.ids.join("+")}`;
  // 13 → 9: four pairs join; the different claims next to them stay apart (store vs. reminded_on, mailed twice vs. no
  // atomicity, the review's wider /remind finding, the import vs. the token).
  assert.deepEqual(m.map(at).sort(), ["consumer.py:19-20 a477+7413", "consumer.py:23-23 a83a", "handler.py:18-18 95ea", "handler.py:19-21 1cf1+a09f", "handler.py:6-6 a28d",
    "handler.py:8-8 1a5f", "reminders.py:21-23 a9b8+29c1", "reminders.py:22-22 43e8", "reminders.py:33-35 a03f+36f9"]);
  // The anchor is the first line; the line's code (for "line changed") only comes from a source on that line.
  const store = m.find((f) => f.ids.includes("a477"));
  assert.deepEqual([store.line, store.end, store.head, store.security, mergeFindings(pr2.slice(1, 2)).findings[0].head], [19, 20, undefined, false, "h"]);
  assert.equal(m.find((f) => f.ids.includes("1cf1")).security, true, "the security source carries over");
  // Four lines apart is too far, another file never joins, a finding without a line never joins.
  assert.equal(mergeFindings([pr2[6], { ...pr2[7], line: 37, end: 37 }]).findings.length, 2);
  assert.equal(mergeFindings([pr2[6], { ...pr2[7], file: "library/other.py" }]).findings.length, 2);
  assert.equal(mergeFindings([{ ...pr2[6], line: 0 }, { ...pr2[7], line: 0 }]).findings.length, 2);
  // The measure: the pairs above score 0.40 and more when they are one claim, 0.27 and less when they are two.
  assert.deepEqual([sameClaim(pr2[0].title, pr2[1].title), sameClaim(pr2[1].title, pr2[2].title), sameClaim(pr2[8].title, pr2[10].title)], [true, false, false]);
  // A suggestion joins the finding on its line whatever it says (consumer.py:19: the store finding and the KeyError
  // suggestion), since it is worded as a fix; alone on its line it is a note, or a finding when it is high, about
  // security or availability. The merged finding has the criteria of all its sources.
  const keyErr = { key: "k19", hunk: "h1", path: "library/consumer.py", line: 19, old: false, severity: "medium", category: "bug", reason: "A missing loan raises KeyError and fails the whole batch; handle unknown ids explicitly." };
  const same = mergeFindings(pr2.slice(0, 2), [keyErr, { ...keyErr, key: "k21", line: 21 }, { ...keyErr, key: "k22", line: 22, category: "availability" }, { ...keyErr, key: "k22b", line: 22, severity: "low" }]);
  assert.deepEqual([same.findings.map((f) => `${f.line} ${f.sources.map((y) => y.reviewer).join("+")}`), same.notes.map((x) => x.key)], [["19 analysis+claude+ai", "22 ai+ai"], ["k21"]]);
  assert.deepEqual(mergeFindings([{ ...pr2[0], criteria: ["c4"] }, { ...pr2[1], criteria: ["c2", "c4"] }]).findings[0].criteria, ["c4", "c2"]);
  console.log("ok neighbouring lines");
}

// The security review starts by itself only on a trusted PR; on someone else's it is offered with the reasons.
{
  const { securityStart } = await import("./pr.js");
  const trigger = { run: true, reasons: [{ text: "template.yaml changes IAM policies or permissions" }, { text: "library/handler.py touches auth or token code" }] };
  const base = { trigger, head: "h2", ctxHead: "h2", run: null, known: true, ready: true };
  assert.deepEqual(securityStart({ ...base, trusted: true }), { start: true, offer: false, reasons: trigger.reasons.map((x) => x.text) });
  assert.deepEqual(securityStart({ ...base, trusted: false }), { start: false, offer: true, reasons: trigger.reasons.map((x) => x.text) }, "someone else's PR: offered, never started");
  assert.equal(securityStart({ ...base, trusted: false, ready: false }).offer, true, "offered before the analysis is there");
  assert.equal(securityStart({ ...base, trusted: true, ready: false }).start, false, "after the analysis");
  for (const run of [{ head: "h2", state: "failed" }, { head: "h2", state: "done" }, { state: "running" }])
    assert.deepEqual([securityStart({ ...base, trusted: true, run }).start, securityStart({ ...base, run }).offer], [false, false], "once per head");
  assert.equal(securityStart({ ...base, trusted: true, run: { head: "h1", state: "done" } }).start, true, "a new head starts again");
  assert.deepEqual([securityStart({ ...base, trusted: true, ctxHead: "h1" }).start, securityStart({ ...base, trusted: true, known: false }).start], [false, false]);
  assert.deepEqual(securityStart({ ...base, trusted: true, trigger: { run: false, reasons: [], why_not: "Only documentation changed." } }), { start: false, offer: false, reasons: [] });
  assert.deepEqual(securityStart(), { start: false, offer: false, reasons: [] });
  console.log("ok security start");
}
