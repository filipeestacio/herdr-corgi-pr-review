// Run: node test_views.mjs  (the panel's picking / selected state, the in-progress cap, a flow visual as archLayout input)
import assert from "node:assert/strict";
import { panelState, bodyTab, capped, flowArch, IN_PROGRESS_MAX, wheelStep, GESTURE_MS, byState, listRows, riskSignal, progressText, pendingText } from "./views.js";
import { archLayout } from "./arch.js";

// Picking until something is chosen; PRs ▾ goes back to picking without dropping the choice.
assert.equal(panelState({ chosen: null, picking: false }), "picking");
assert.equal(panelState({ chosen: { url: "u" }, picking: false }), "selected");
assert.equal(panelState({ chosen: { url: "u" }, picking: true }), "picking");
assert.equal(panelState({ chosen: "branch", picking: false }), "selected");
assert.equal(bodyTab("walk"), "walk");
assert.equal(bodyTab("diff"), "diff");
assert.equal(bodyTab(undefined), "diff");

// In progress: three, then "Show all (n)".
const six = [1, 2, 3, 4, 5, 6];
assert.equal(IN_PROGRESS_MAX, 3);
assert.deepEqual(capped(six), { shown: [1, 2, 3], more: 3 });
assert.deepEqual(capped(six, true), { shown: six, more: 0 });
assert.deepEqual(capped([1, 2]), { shown: [1, 2], more: 0 });
assert.deepEqual(capped([]), { shown: [], more: 0 });

// A flow: one implicit group, notes as descriptions, changed as status, transition text as labels, sources kept.
const flow = { kind: "flow", title: "One run", nodes: [
  { id: "job", label: "Job" }, { id: "rem", label: "sendDueReminders", changed: true, note: "new", source: "implemented", at: "src/loans/reminders.ts:3" },
  { id: "mail", label: "sendEmail", source: "existing" }, { id: "sms", label: "SMS", source: "spec" }],
  edges: [{ from: "job", to: "rem", label: "run" }, { from: "rem", to: "mail", label: "reminder", changed: true, source: "implemented" },
    { from: "rem", to: "sms", event: "due", guard: "opted in", source: "spec" }] };
const a = flowArch(flow);
assert.deepEqual(a.groups, [{ id: "flow", label: "", kind: "" }]);
assert.ok(a.nodes.every((n) => n.group === "flow"));
const rem = a.nodes.find((n) => n.id === "rem");
assert.equal(rem.description, "new"); assert.equal(rem.status, "changed"); assert.equal(rem.source, "implemented"); assert.equal(rem.at, "src/loans/reminders.ts:3");
assert.equal(a.nodes.find((n) => n.id === "job").status, undefined);
assert.equal(a.edges[1].status, "changed");
assert.equal(a.edges[2].label, "due [opted in]");
assert.equal(a.edges[2].source, "spec");
// Laid out like Architecture impact: left to right, one numbered path per edge, the spec one dashed.
const L = archLayout(a);
const x = new Map(L.nodes.map((n) => [n.id, n.x]));
assert.ok(x.get("job") < x.get("rem") && x.get("rem") < x.get("mail"));
assert.deepEqual(L.paths.map((p) => p.num), [1, 2, 3]);
assert.ok(L.paths.find((p) => p.to === "sms").dashed);
assert.equal(L.groups.length, 1);

// Its own groups stay; transitions count as edges too; an empty visual lays out empty.
const g = flowArch({ groups: [{ id: "api", label: "API", kind: "service" }], nodes: [{ id: "a", label: "A", group: "api" }], transitions: [{ from: "a", to: "a", label: "loop" }] });
assert.deepEqual(g.groups.map((x) => x.id), ["api"]);
assert.equal(g.nodes[0].group, "api");
assert.equal(g.edges.length, 1);
assert.equal(archLayout(flowArch({})).nodes.length, 0);
console.log("views: ok");

// Sideways scrollers: one axis per gesture, the offset clamped to [0, max].
{
  const run = (events, x = 0, max = 100) => { let g = null, used = []; for (const e of events) { const r = wheelStep(g, e, x, max); g = r.g; x = r.x; used.push(r.used); } return { axis: g?.axis, x, used }; };
  assert.deepEqual(run([{ dx: -10, dy: 2, t: 0 }, { dx: -5, dy: 30, t: 20 }]), { axis: "x", x: 15, used: [true, true] }, "starts sideways: stays sideways, the page gets nothing");
  assert.deepEqual(run([{ dx: 1, dy: 10, t: 0 }, { dx: -40, dy: 0, t: 20 }]), { axis: "y", x: 0, used: [false, false] }, "starts down: the picture never moves in that gesture");
  assert.deepEqual(run([{ dx: 1, dy: 10, t: 0 }, { dx: -40, dy: 0, t: GESTURE_MS + 1 }]), { axis: "x", x: 40, used: [false, true] }, "a pause ends the gesture");
  assert.deepEqual(run([{ dx: 1, dy: 10, t: 0 }, { dx: -40, dy: 0, t: 10, phase: "started" }]), { axis: "x", x: 40, used: [false, true] }, "a new touch ends it too");
  assert.deepEqual(run([{ dy: -30, t: 0, shift: true }]), { axis: "x", x: 30, used: [true] }, "shift+wheel is sideways");
  assert.equal(run([{ dx: -500, t: 0 }]).x, 100, "clamped at max");
  assert.equal(run([{ dx: 500, t: 0 }], 20).x, 0, "clamped at 0");
  assert.deepEqual(run([{ dx: -10, t: 0 }], 0, 0), { axis: "x", x: 0, used: [false] }, "nothing to scroll: the page keeps the event");
  assert.equal(run([], 300).x, 300); assert.equal(wheelStep(null, { dy: 5, t: 0 }, 300, 100).x, 100, "an offset beyond a shrunk max is clamped");
  console.log("wheel ok");
}

// gh pr diff too large -> local fallback; other errors rethrow.
import { diffTooLarge, filesToDiff } from "./views.js";
assert.ok(diffTooLarge("could not find pull request diff: HTTP 406: Sorry, the diff exceeded the maximum number of files (300)."));
assert.ok(diffTooLarge("... too_large ..."));
assert.ok(!diffTooLarge("HTTP 404: Not Found"));
assert.ok(!diffTooLarge(""));

// The files API as diff text, parsed by pr.js.
import { splitPatch } from "./pr.js";
const fs = splitPatch(filesToDiff([
  { filename: "a.js", status: "added", patch: "@@ -0,0 +1,2 @@\n+x\n+y" },
  { filename: "b.js", status: "removed", patch: "@@ -1 +0,0 @@\n-z" },
  { filename: "n.js", previous_filename: "o.js", status: "renamed", patch: "@@ -1 +1 @@\n-a\n+b" },
  { filename: "img.png", status: "modified", additions: 0, deletions: 0 },
]));
assert.deepEqual(fs.map((f) => [f.path, f.status, f.add, f.del, f.binary]), [["a.js", "added", 2, 0, false], ["b.js", "deleted", 0, 1, false], ["n.js", "renamed", 1, 1, false], ["img.png", "modified", 0, 0, true]]);
assert.equal(fs[2].from, "o.js");
assert.ok(filesToDiff([{ filename: "i.png", status: "modified" }]).includes("No diff from GitHub for this file"));

// Lock files and big changes fold when a review opens.
{
  const { foldOnOpen } = await import("./views.js");
  const f = (path, add = 1, del = 0) => ({ path, add, del });
  const out = foldOnOpen([f("package-lock.json"), f("web/yarn.lock"), f("Cargo.lock"), f("go.sum"), f("dist/app.min.js"), f("src/big.ts", 300, 150), f("src/small.ts", 10, 2), f("docs/locking.md")]);
  assert.deepEqual(out, ["package-lock.json", "web/yarn.lock", "Cargo.lock", "go.sum", "dist/app.min.js", "src/big.ts"]);
  assert.deepEqual(foldOnOpen(null), []);
}

// The Files list's room: the file in view first, the newest opened next, then nearest (below first); the cap holds.
{
  const { allocate, recenter, lastAtOrBelow, RECENT } = await import("./views.js");
  const files = ["a", "b", "c", "d", "e"].map((path, i) => ({ path, i, n: 10 }));
  const open = (o) => files.map((f) => f.path).filter((p) => !o.has(p));
  assert.deepEqual(open(allocate({ files, center: 2, cap: 30 })), ["b", "c", "d"]); // centre, then d (below) before b
  assert.deepEqual(open(allocate({ files, center: 2, cap: 20 })), ["c", "d"]);
  assert.deepEqual(open(allocate({ files, center: 0, cap: 30 })), ["a", "b", "c"]); // the top: in order
  assert.deepEqual(open(allocate({ files, center: 4, cap: 20 })), ["d", "e"]);
  assert.deepEqual(open(allocate({ files, center: 2, recent: ["a"], cap: 20 })), ["a", "c"]); // opened by you: before the neighbours
  const many = Array.from({ length: RECENT + 1 }, (_, k) => `r${k}`);
  assert.equal(allocate({ files: [{ path: many[RECENT], i: 9, n: 10 }, { path: "x", i: 1, n: 10 }], center: 0, recent: many, cap: 10 }).has("x"), false); // only the newest RECENT jump the queue
  assert.deepEqual([...allocate({ files: files.filter((f) => f.path !== "c"), center: 2, cap: 20 })].sort(), ["a", "e"]); // a collapsed file isn't offered, never in the set
  const big = allocate({ files: [{ path: "a", i: 0, n: 5 }, { path: "b", i: 1, n: 50 }, { path: "c", i: 2, n: 5 }], center: 0, cap: 20 });
  assert.deepEqual([...big], ["b"]); // the cap holds; smaller files further away still fit
  assert.equal(allocate({ files: [{ path: "a", i: 0, n: 50 }], center: 0, cap: 20 }).has("a"), true);

  assert.equal(lastAtOrBelow([0, 5, 9], 0), 0); assert.equal(lastAtOrBelow([0, 5, 9], 7), 1); assert.equal(lastAtOrBelow([0, 5, 9], 99), 2);
  // Items 20 px each; files start at items 0, 50, 100, 150; file 3 (items 150..) is folded: one item 150..151.
  const top = Array.from({ length: 153 }, (_, i) => i * 20), heads = [0, 50, 100, 150], folds = [[3000, 3020]];
  const at = (start, center, margin = 500) => recenter({ heads, top, folds, start, end: start + 10, center, margin });
  assert.equal(at(10, 0), null); // the file the room was given around: nothing changes
  assert.equal(at(55, 0), null); // another file, but the fold is far below (3000 > 65*20+500)
  assert.equal(at(120, 0), 2); // near the fold: open around file 2
  assert.equal(at(120, 2), null); // already there
  assert.equal(at(120, 0, 0), null); // margin 0: the fold isn't on screen yet
  assert.equal(recenter({ heads, top, folds: [], start: 120, end: 130, center: 0, margin: 500 }), null); // nothing folded
  assert.equal(recenter({ heads, top, folds: [[0, 20]], start: 55, end: 65, center: 3, margin: 500 }), null); // fold far above
  assert.equal(recenter({ heads, top, folds: [[0, 20]], start: 52, end: 62, center: 3, margin: 1500 }), 1); // fold above, near
  console.log("room ok");
}

// Under the Ask drawer: the scroll's max counts only the visible width.
{
  const { hsVisible } = await import("./views.js");
  const max = (contentW, measured, covered) => Math.max(0, contentW - hsVisible(measured, covered));
  assert.equal(max(1500, 1000, 0), 500);
  assert.equal(max(1500, 1000, 380), 880); // drawer open over the picture: 380 px more to scroll
  assert.equal(max(1500, 1000, 28), 528); // folded strip
  assert.equal(max(500, 1000, 380), 0); // fits beside the drawer
  assert.equal(hsVisible(300, 380), 100);
  console.log("hscroll ok");
}

// A jump lands at the top: the item to centre so the view sits just past the target (review.js settleTop).
{
  const { pastTop } = await import("./views.js");
  const rows = Array.from({ length: 100 }, () => 20); // 20 px each: item k spans 20k..20k+20
  // Target 10 (top 200), view 400: centring item 20 (centre 410) puts the view at 210, 10 px past the target's top.
  assert.equal(pastTop(rows, 10, 400), 20);
  const j = pastTop(rows, 10, 400), offset = j * 20 + 10 - 200;
  assert.ok(offset > 200 && offset < 220, "the target's top is cut off above, by less than one item");
  assert.equal(pastTop(rows, 0, 400), 10);
  assert.equal(pastTop(rows, 95, 400), 99, "less than a view below the target: the list's end");
  // A tall card where the centre would fall: the next item whose centre is past it.
  const mixed = [20, 20, 300, 20, 20, 20, 20];
  assert.equal(pastTop(mixed, 0, 200), 2, "centre of the card (190) is past 100");
  assert.equal(pastTop(mixed, 1, 500), 3, "the card's centre (190) is not past 270, the row after it is");
  console.log("jump to top ok");
}
// ---- the PR list (main.js picker)

// Mine mixes open and merged PRs: open and draft ones first, the rest in their own group; only open ones get a way
// into the review.
const mine = [{ url: "m1", state: "merged" }, { url: "o1", state: "open" }, { url: "c1", state: "closed" }, { url: "d1", state: "draft" }, { url: "m2", state: "merged" }];
assert.deepEqual(byState(mine).open.map((p) => p.url), ["o1", "d1"]);
assert.deepEqual(byState(mine).done.map((p) => p.url), ["m1", "c1", "m2"]);
assert.deepEqual(byState([]), { open: [], done: [] });

// One row per PR: a PR shown under "In progress" leaves the list below; one that is in progress but not shown there
// (over the cap) stays, and its row resumes instead of starting again.
const started = [{ url: "o1" }, { url: "x" }, { url: "y" }, { url: "d1" }];
const rows = listRows(mine, started, started.slice(0, 3));
assert.deepEqual(rows.list.map((p) => p.url), ["m1", "c1", "d1", "m2"]);
assert.equal(rows.above, 1);
assert.equal(rows.started.get("d1"), started[3]);
assert.equal(rows.started.has("m1"), false);
assert.deepEqual(listRows(mine, [], []).list, mine);

// The risk signal of a row comes from cached files only: the highest severity among the open findings (the analysis'
// own and the reviewers'), and whether one of them is about security. Nothing cached: nothing shown.
assert.equal(riskSignal({}), null);
assert.equal(riskSignal({ analysis: null, findings: undefined }), null);
const layers = { steps: [{ findings: [{ id: "a1", severity: "medium", category: "bug" }, { id: "a2", severity: "high", category: "security" }] }, { findings: [{ id: "a3", severity: "low", category: "structure" }] }, {}] };
const reviewers = [{ id: "r1", reviewer: "security", severity: "critical" }, { id: "r2", reviewer: "claude", severity: "medium" }];
assert.deepEqual(riskSignal({ analysis: layers, findings: reviewers }), { top: "critical", open: 5, security: true });
// A fixed or dismissed finding no longer counts; one with a fix sent (progress) still does.
assert.deepEqual(riskSignal({ analysis: layers, findings: reviewers, status: { r1: { s: "fixed" }, a2: { s: "progress" } } }), { top: "high", open: 4, security: true });
assert.deepEqual(riskSignal({ analysis: layers, findings: reviewers, status: { r1: { s: "dismissed" }, a2: { s: "fixed" } } }), { top: "medium", open: 3, security: false });
assert.deepEqual(riskSignal({ analysis: { steps: [] }, findings: [] }), { top: null, open: 0, security: false });
// An analysis cached before layers had findings still loads.
assert.deepEqual(riskSignal({ analysis: {} }), { top: null, open: 0, security: false });

// The progress of a review in progress says "layers", like the review's tab, and leaves out what is zero.
assert.equal(progressText({ steps: 6, stepsChecked: 0, files: 9, filesViewed: 2, comments: 1, replies: 0, fixedThreads: 0, findingsOpen: 11 }), "0/6 layers · 2/9 files · 1 comment · 11 open findings");
assert.equal(progressText({ steps: 1, stepsChecked: 1, comments: 2, replies: 1, fixedThreads: 3, findingsOpen: 1 }), "1/1 layers · 2 comments · 1 reply · 3 fixed · 1 open finding");
assert.equal(progressText(), "");

assert.equal(pendingText([{ file: "a.py" }]), "1 pending comment in 1 file");
assert.equal(pendingText([{ file: "a.py" }, { file: "a.py" }, { file: "b.py" }]), "3 pending comments in 2 files");

// The review's left column. The order switch only matters when reading order and the analysis' order differ.
{
  const { orderDiffers, worst, byUrgency } = await import("./views.js");
  assert.equal(orderDiffers([{ order: 1 }, { order: 2 }, { order: 3 }]), false);
  assert.equal(orderDiffers([{ order: 2 }, { order: 1 }]), true);
  assert.equal(orderDiffers([]), false);
  // A row's findings in words: the highest severity with its count, all of them for the tooltip, security counted.
  assert.equal(worst([]), null);
  assert.deepEqual(worst([{ severity: "medium" }, { severity: "high", security: true }, { severity: "medium" }, { severity: "low" }]),
    { severity: "high", count: 1, total: 4, label: "1 high", words: "1 high, 2 medium, 1 low", security: 1 });
  assert.equal(worst([{ severity: "low" }, { severity: "low" }]).label, "2 low");
  // Blockers by severity, security first among equals, the rest in their order.
  const bs = [{ severity: "medium", title: "rule" }, { severity: "high", title: "bug" }, { severity: "low", title: "overlap" }, { severity: "high", title: "auth", finding: "s1" }, { severity: "high", title: "bug 2" }];
  assert.deepEqual(byUrgency(bs, (b) => b.finding === "s1").map((b) => b.title), ["auth", "bug", "bug 2", "rule", "overlap"]);
  assert.deepEqual(byUrgency(bs).map((b) => b.title), ["bug", "auth", "bug 2", "rule", "overlap"]);
}
// ---- a finding's facts, its card's line, the rows' heights, the sequence diagram (the diff and a layer's head)
import { factRows, findingAnchor, wrapCount, seqLayout, IMPACT, SEVERITY_SCALE, SEQ } from "./views.js";

// An open card says why the finding has its severity, what it does, how sure the claim is and what it depends on.
assert.deepEqual(factRows({ severity: "high", impact: "unauthorized_access", effect: "Anyone can call /late.", certainty: "assumed", preconditions: ["TOKEN is not set", "no authorizer"] }), [
  ["Severity", "high, because it allows access without permission."], ["Effect", "Anyone can call /late."],
  ["Certainty", "Assumed: it depends on something that could not be checked."], ["Preconditions", "TOKEN is not set; no authorizer"]]);
// No preconditions means it always happens; a finding from an older analysis has no such fields and gets no rows.
assert.deepEqual(factRows({ severity: "medium", effect: "Two mails.", certainty: "derived", preconditions: [] }).at(-1), ["Preconditions", "None: it always happens."]);
assert.deepEqual(factRows({ severity: "high", title: "x", detail: "y", preconditions: [] }), []);
assert.deepEqual(factRows(null), []);
// The scale names every impact under the severity it fixes.
assert.equal(SEVERITY_SCALE.split("\n").length, 3);
for (const [sev, why] of Object.values(IMPACT)) assert.ok(SEVERITY_SCALE.split("\n").find((l) => l.startsWith(`${sev}:`)).includes(why));

// A card sits under the first line with code from the finding's line on: not under an empty one.
const fr = [{ kind: " ", number: 7, text: "import os" }, { kind: "+", number: 8, text: "" }, { kind: "-", number: 8, text: "old" }, { kind: " ", number: 9, text: "TOKEN = 1" }, { kind: "gap" }, { kind: "+", number: 30, text: "x" }];
assert.equal(findingAnchor(fr, 8, 8), 9);
assert.equal(findingAnchor(fr, 8, 16), 9);
assert.equal(findingAnchor(fr, 7, 9), 7);
assert.equal(findingAnchor(fr, 10, 10), 10); // the next code is far below: it stays on its own line
assert.equal(findingAnchor([], 3), 3);
// Not into the next function (reminders.py:35 on PR #2 is a blank line before `def overdue`): it stays on its line.
const fn = [{ kind: " ", number: 34, text: "    return len(late)" }, { kind: " ", number: 35, text: "" }, { kind: " ", number: 36, text: "" }, { kind: " ", number: 37, text: "def overdue(loans, on=None):" }];
assert.deepEqual([findingAnchor(fn, 35), findingAnchor(fn, 37), findingAnchor([{ kind: "+", number: 5, text: "export async function f() {" }], 4)], [35, 37, 4]);
// Nor out of a YAML block (template.yaml:9 is a blank line after `Timeout: 10`, before `Resources:`).
const ym = [{ kind: " ", number: 8, text: "    Timeout: 10" }, { kind: " ", number: 9, text: "" }, { kind: " ", number: 10, text: "Resources:" }];
assert.deepEqual([findingAnchor(ym, 9), findingAnchor([{ kind: " ", number: 7, text: "import os" }, ...ym.slice(1)], 9)], [9, 10]);

// Lines of a wrapped text: at words, a long word inside, a newline always.
assert.equal(wrapCount("", 300), 1);
assert.equal(wrapCount("one two", 300), 1);
assert.equal(wrapCount("a\nb", 300), 2);
assert.equal(wrapCount("word ".repeat(40).trim(), 300), Math.ceil(40 / Math.floor((300 + 4.16) / (4 * 7.3 * 1.04 + 4.16)))); // 9 words a line
assert.ok(wrapCount("x".repeat(200), 300) >= 5);
assert.ok(wrapCount("FRONT_DESK_TOKEN ".repeat(10), 400) > wrapCount("front desk token ".repeat(10), 400)); // capitals are wider
assert.ok(wrapCount("some text that wraps", 100, 13.5) >= wrapCount("some text that wraps", 100, 10));

// A sequence diagram: a column per participant, a row per call in order, from the caller's lifeline to the callee's.
const sq = seqLayout({ nodes: [{ id: "a", label: "Client" }, { id: "b", label: "Handler" }, { id: "c", label: "Store" }],
  edges: [{ from: "a", to: "b", label: "GET /late" }, { from: "b", to: "c", event: "late", action: "reads" }, { from: "b", to: "b", label: "check" }, { from: "c", to: "a", label: "200" }, { from: "a", to: "zz", label: "nowhere" }] }, 900);
assert.deepEqual(sq.cols.map((c) => c.x), [140, 420, 700]); // 900 px for three: SEQ.MAX each
assert.equal(sq.width, 3 * SEQ.MAX);
assert.deepEqual(sq.calls.map((c) => [c.n, c.x1, c.x2, c.text]), [[1, 140, 420, "GET /late"], [2, 420, 700, "late / reads"], [3, 420, 420, "check"], [4, 700, 140, "200"]]);
assert.deepEqual(sq.calls.map((c) => c.y), [0, 1, 2, 3].map((k) => SEQ.HEAD + SEQ.PAD + k * SEQ.ROW));
assert.equal(sq.height, SEQ.HEAD + 2 * SEQ.PAD + 4 * SEQ.ROW);
assert.equal(seqLayout({ nodes: [{ id: "a" }, { id: "b" }] }, 100).width, 2 * SEQ.MIN); // never narrower than SEQ.MIN a column
assert.equal(seqLayout(null, 500).calls.length, 0);

// The gutter marks of a finding's lines go over the rows that are shown: a range to line 1e9 (a model wrote it) marks
// three rows and allocates nothing; a range that is no range marks nothing.
import { rangeMarks } from "./views.js";
const mr = [{ kind: " ", number: 7 }, { kind: "-", number: 8 }, { kind: "+", number: 8 }, { kind: "gap" }, { kind: "+", number: 30 }];
assert.deepEqual([...rangeMarks(mr, [{ line: 8, end: 1e9, mark: "a" }, { line: 7, end: 7, mark: "b" }])], [[7, "b"], [8, "a"], [30, "a"]]);
assert.equal(rangeMarks(mr, [{ line: 7.5, end: 9, mark: "x" }, { line: 9, end: 7, mark: "x" }, { line: 7, end: Infinity, mark: "x" }, { line: "7", end: 8, mark: "x" }, { line: 7, end: undefined, mark: "x" }]).size, 0);

// The height of a Markdown text: paragraphs, a list and a fenced code block each count, with a gap between blocks.
import { mdHeight, MD } from "./views.js";
assert.equal(mdHeight("", 600), 21);
assert.equal(mdHeight("One line with `code`.", 600), 21);
assert.equal(mdHeight("One.\n\nTwo.\n\nThree.", 600), 3 * 21 + 2 * MD.GAP);
assert.equal(mdHeight("Do this:\n\n- one\n- two\n- three", 600, 20), 20 + MD.GAP + 3 * (20 + MD.ITEM_GAP));
assert.equal(mdHeight("Fix it.\n\n```python\na = 1\nb = 2\nc = 3\n```", 600), 21 + MD.GAP + MD.CODE_PAD + 3 * MD.CODE_LH);
assert.equal(mdHeight("```suggestion\nreturn 1\n```", 600), MD.CODE_PAD + MD.CODE_LH); // a GitHub suggestion is a code block
assert.equal(mdHeight("```\nopen to the end", 600), MD.CODE_PAD + MD.CODE_LH);
// A code line longer than the block wraps; a list item has less room than a paragraph; a heading is taller.
assert.ok(mdHeight("```\n" + "x".repeat(120) + "\n```", 300) >= MD.CODE_PAD + 4 * MD.CODE_LH);
const long = "word ".repeat(30).trim();
assert.ok(mdHeight(`- ${long}`, 300) >= mdHeight(long, 300));
assert.ok(mdHeight("# Title", 600) > mdHeight("Title", 600));
// It never gives less than the plain wrapped text does, so nothing that fit before is cut now.
for (const w of [200, 420, 900]) assert.ok(mdHeight(long, w) >= 21 * wrapCount(long, w));
