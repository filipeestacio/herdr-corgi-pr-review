// Run: node test_views.mjs  (the panel's picking / selected state, the in-progress cap, a flow visual as archLayout input)
import assert from "node:assert/strict";
import { panelState, bodyTab, capped, flowArch, IN_PROGRESS_MAX, wheelStep, GESTURE_MS, byState, listRows, riskSignal, progressText, pendingText } from "./views.js";
import { scopeTable, runSummary, exposureOf, surfaceOf } from "./views.js";
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

// ---- the Security page: what each run checked, and a run in words
{
  const analysis = { checked: [{ area: "authentication", result: "finding", note: "empty token" }, { area: "secrets", result: "clean", note: "" }, { area: "tests", result: "weird" }] };
  const runs = { security: { state: "done", scope: { checked: [{ area: "secrets", result: "not_checked", note: "out of scope" }, { area: "dependencies", result: "clean", note: "none new" }] } },
    claude: { state: "done", scope: null }, codex: { state: "failed", error: "no output" } };
  const tab = scopeTable(analysis, runs);
  assert.deepEqual(tab.cols, ["analysis", "security"], "only runs that reported a scope get a column");
  assert.deepEqual(tab.rows.map((r) => r.area), ["authentication", "secrets", "tests", "dependencies"]);
  assert.deepEqual(tab.rows[1].cells, { analysis: { result: "clean", note: "" }, security: { result: "not_checked", note: "out of scope" } });
  assert.equal(tab.rows[0].cells.security, null, "an area a run does not cover is empty, not clean");
  assert.equal(tab.rows[2].cells.analysis.result, "not_checked", "an unknown result is never read as clean");
  assert.deepEqual(scopeTable(null, {}), { cols: [], rows: [] }); // an older analysis, nothing run
  assert.deepEqual(scopeTable(undefined, undefined), { cols: [], rows: [] });
  assert.equal(runSummary(null), "not run"); assert.equal(runSummary({ state: null }), "not run");
  assert.equal(runSummary({ state: "running" }), "running");
  assert.equal(runSummary({ state: "failed", error: "Codex review: no findings file" }), "failed: Codex review: no findings file");
  assert.equal(runSummary({ state: "done", count: 0 }), "no findings"); assert.equal(runSummary({ state: "done", count: 2 }), "2 findings");
  assert.equal(runSummary({ state: "done", count: 2 }, 1), "1 finding", "the count on the list now wins over the run's own");
}

// ---- the Security page: the attack surface from the access rows
{
  assert.equal(exposureOf({ public: true, auth: "none" }), "open"); assert.equal(exposureOf({ public: true, auth: "" }), "open");
  assert.equal(exposureOf({ public: true }), "open"); assert.equal(exposureOf({ public: true, auth: "None (no authorizer on the route)" }), "open");
  assert.equal(exposureOf({ public: true, auth: "bearer token checked in handler.py" }), "public");
  assert.equal(exposureOf({ public: true, auth: "nonce check in the handler" }), "public", "a word that only starts like none is a check");
  assert.equal(exposureOf({ public: false, auth: "none" }), "internal"); assert.equal(exposureOf(null), "internal");
  assert.equal(exposureOf({ public: true, auth: "nothing checks it", auth_kind: "code" }), "public", "auth_kind wins over the free text");
  assert.equal(exposureOf({ public: true, auth: "bearer token", auth_kind: "none" }), "open");
  const access = [{ resource: "role policy", kind: "queue", public: false, auth: "IAM" }, { resource: "admin route", kind: "route", public: false, auth: "IAM" },
    { resource: "api", kind: "route", public: true, auth: "an authorizer" }, { resource: "bucket", kind: "bucket", public: true, auth: "none" }];
  const s = surfaceOf(access);
  assert.deepEqual(s.entries.map((x) => [x.resource, x.exposure, x.k]), [["bucket", "open", 3], ["api", "public", 2], ["admin route", "internal", 1]], "most exposed first; a public bucket is a way in");
  assert.deepEqual(s.grants.map((x) => x.resource), ["role policy"]);
  assert.deepEqual(surfaceOf(undefined), { entries: [], grants: [] });
}

// ---- the Security page: order of the findings, the way in the PR opens unasked, a zone's rights
{
  const { reachLevel, secOrder, extraWays, zoneRights, blastLine } = await import("./views.js");
  assert.equal(reachLevel({ reachability: "authenticated" }, [{ exposure: "open" }]), "authenticated", "the analysis' word wins");
  assert.equal(reachLevel({}, [{ exposure: "internal" }, { exposure: "public" }]), "authenticated", "derived: the most exposed way in");
  assert.equal(reachLevel({}, [{ exposure: "open" }]), "public"); assert.equal(reachLevel({ reachability: "moon" }), "unknown");
  const f = (id, severity) => ({ id, severity });
  const o = secOrder([{ f: f("a", "high"), level: "internal_only", crosses: true }, { f: f("b", "low"), level: "public", crosses: false }, { f: f("c", "medium"), level: "public", crosses: true },
    { f: f("d", "high"), level: "public", crosses: true }, { f: f("e", "high"), level: "unknown", crosses: null }]);
  assert.deepEqual(o.map((r) => r.f.id), ["d", "c", "b", "a", "e"]);
  assert.equal(o[0].why, "Reachable from the internet, over a trust boundary, high severity.");
  assert.equal(o[4].why, "Not known from where it can be reached, high severity.", "no zones: nothing said about boundaries");
  // PR #2: the extra ask "/remind" sits in handler.py; the route's card is the handler. Two extras on one way, or one
  // extra on two ways: no match. A way in the PR does not open: no match.
  const route = { k: 0, opened_by_pr: true, files: ["template.yaml", "library/handler.py"] }, other = { k: 1, opened_by_pr: true, files: ["library/api.py"] };
  const x1 = { id: "x1", state: "extra", files: ["library/handler.py"] };
  assert.deepEqual(extraWays([{ id: "c1", state: "broken", files: ["library/handler.py"] }, x1], [route, other]).map((m) => [m.entry.k, m.ask.id]), [[0, "x1"]]);
  assert.deepEqual(extraWays([x1, { id: "x2", state: "extra", files: ["template.yaml"] }], [route]), []);
  assert.deepEqual(extraWays([{ ...x1, files: ["library/handler.py", "library/api.py"] }], [route, other]), []);
  assert.deepEqual(extraWays([x1], [{ ...route, opened_by_pr: false }]), []); assert.deepEqual(extraWays(undefined, undefined), []);
  const zones = [{ id: "z_net", name: "Internet", trust: "public" }, { id: "z_fd", name: "FrontDesk function", trust: "authenticated" }, { id: "z_c", name: "Consumer", trust: "internal" }];
  const nodes = [{ id: "caller", zone: "z_net" }, { id: "handler", label: "handler", zone: "z_fd" }, { id: "consumer", zone: "z_c" }];
  const access = [{ resource: "LoanEvents", principal: "FrontDesk function", actions: ["sqs:SendMessage"], used: false }, { resource: "Loans", principal: "Consumer", actions: ["sqs:ReceiveMessage"], used: true }];
  const zr = zoneRights(zones, nodes, [{ node: "handler" }], access);
  assert.deepEqual(zr.map((z) => [z.zone.id, z.rights.map((r) => r.resource)]), [["z_fd", ["LoanEvents"]]], "only zones with a way in");
  assert.equal(blastLine(zr[0]), "If FrontDesk function is compromised, it can sqs:SendMessage on LoanEvents (granted, never used).");
  assert.equal(blastLine({ zone: zones[2], rights: [] }), "If Consumer is compromised, it holds no right the analysis names.");
  assert.deepEqual(zoneRights([], nodes, [{ node: "handler" }], access), []);
}
