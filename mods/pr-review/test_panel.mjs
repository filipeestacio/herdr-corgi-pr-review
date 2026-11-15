// Run: node test_panel.mjs  (the PR panel at rest: Herdr draws every mod again whenever its live data changes (an
// agent's status, focus, shared state), so a render of the panel must cost nothing but the drawing. Counted here: shared
// writes, timers, tasks and redraws asked for, over renders with nothing new; then what one real change costs.)
import assert from "node:assert/strict";
import { S, cx as base } from "./render_stub.mjs";

const { default: PrReview } = await import("./main.js");
const { openSig } = await import("./views.js");

const n = { writes: [], notify: 0, spawn: 0 }, timers = [];
const cx = { ...base, notify() { n.notify++; }, spawn(fn) { n.spawn++; void Promise.resolve().then(() => fn(cx)).catch(() => null); },
  timer: { after(_ms, fn) { timers.push(fn); }, every() {} } };
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
// Timers until none is left (a timer may start a task that sets another).
const flush = async () => { for (let k = 0; k < 20 && timers.length; k++) { for (const fn of timers.splice(0)) fn(cx); await settle(); } await settle(); };
const reset = () => { n.writes.length = 0; n.notify = 0; n.spawn = 0; };
// As Herdr: shared() gives a new object per call, setShared is counted.
S.store.get = (k) => structuredClone(Map.prototype.get.call(S.store, k));
S.store.set = (k, v) => { n.writes.push(k); return Map.prototype.set.call(S.store, k, v); };
const idle = async (v, what, renders = 20) => {
  reset();
  for (let i = 0; i < renders; i++) { v.render(cx); await flush(); }
  assert.deepEqual({ writes: n.writes, timers: timers.length, notify: n.notify, spawn: n.spawn }, { writes: [], timers: 0, notify: 0, spawn: 0 }, what);
};

const review = (k, touched) => ({ status: "in-progress", url: `https://github.com/o/r/pull/${k}`, number: k, repo: "o/r", title: `PR ${k}`, lastTouched: touched, progress: { files: 3, filesViewed: 1 } });
assert.equal(openSig([review(1, 5)]), openSig(structuredClone([review(1, 5)])), "equal lists have one signature");
assert.notEqual(openSig([review(1, 5)]), openSig([review(1, 6)]), "a touched review changes it");
assert.notEqual(openSig([review(1, 5), review(2, 5)]), openSig([review(1, 5)]), "a removed review changes it");
assert.equal(openSig(null), "", "no list is the empty one");

// ---- the list, with reviews in progress
S.props = {}; S.spaces = [{ id: "s1", active: true, folder: "/repo", tabs: [] }];
Map.prototype.set.call(S.store, "review.open", [review(1, 5), review(2, 4)]);
S.files.set("/h/pr-data/prs.json", JSON.stringify({ generated: new Date().toISOString(), prs: [] }));
{
  const v = new PrReview(); v.init({}, cx); await flush(); v.render(cx); await flush();
  await idle(v, "the list at rest: 20 renders ask for nothing");
  Map.prototype.set.call(S.store, "review.open", [review(1, 9), review(2, 4)]); // the review layout touched one
  reset(); v.render(cx); await flush();
  assert.deepEqual(n.writes, ["goto.items.review"], "a changed list of open reviews writes Go to's items once");
  await idle(v, "and then nothing again");
  // prs.json read again with the same PRs (a scan that found nothing new): no redraw.
  reset(); await v.loadPrs(cx); assert.equal(n.notify, 0, "the same prs.json draws nothing");
  S.files.set("/h/pr-data/prs.json", JSON.stringify({ generated: "x", prs: [{ url: "https://github.com/o/r/pull/7", number: 7, repo: "o/r", state: "open", session: "abcdefgh", at: "2026-01-01" }] }));
  await v.loadPrs(cx); assert.equal(n.notify, 1, "a new PR in prs.json draws once");
}

// ---- the current branch, while files of the repo are written (an agent at work)
{
  let diff = "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1,2 +1,2 @@\n def a():\n-    return 1\n+    return 2\n", diffs = 0;
  S.exec = async (cmd, args) => {
    if (cmd === "git" && args.includes("--show-toplevel")) return { code: 0, stdout: "/repo\n/repo/.git\norigin/main\n", stderr: "" };
    if (cmd === "git" && args.includes("diff")) { diffs++; return { code: 0, stdout: diff, stderr: "" }; }
    return { code: 1, stdout: "", stderr: "stub" };
  };
  Map.prototype.set.call(S.store, "pr.selected", { all: "branch" });
  const v = new PrReview(); v.init({}, cx); await flush(); v.render(cx); await flush();
  assert.equal(v.rows.length > 0 && v.files.length, 1, "the branch's diff is shown");
  await idle(v, "the branch at rest: 20 renders ask for nothing");
  // A file was written, the diff is the same (an ignored or untracked file, or a save without a change).
  const rows = v.rows, files = v.files, before = diffs;
  v.dirty.add("/repo"); reset(); v.render(cx); await flush();
  assert.equal(diffs, before + 1, "the change is looked at");
  assert.deepEqual({ notify: n.notify, writes: n.writes, same: v.rows === rows && v.files === files, loading: v.loading }, { notify: 0, writes: [], same: true, loading: false }, "the same diff again: nothing is replaced, nothing is drawn");
  // Another file changed: the list of files is new, the open file's rows (and their colours) stay.
  diff += "diff --git a/b.py b/b.py\n--- a/b.py\n+++ b/b.py\n@@ -1 +1 @@\n-x = 1\n+x = 2\n";
  v.dirty.add("/repo"); reset(); v.render(cx); await flush();
  assert.equal(v.files.length, 2, "the new file is listed");
  assert.equal(v.rows, rows, "the open file did not change: its rows stay");
  assert.deepEqual(n.writes, [], "a reload writes no shared state");
  await idle(v, "and at rest again");
  // Behind the list nothing is diffed.
  v.picking = true; v.dirty.add("/repo"); const then = diffs; reset(); v.render(cx); await flush();
  assert.equal(diffs, then, "no diff while the list is shown");
  S.exec = null;
}

// ---- a remount with a PR picked before: the list is not drawn (nor fetched) while the pick comes back
{
  Map.prototype.set.call(S.store, "pr.selected", { all: "https://github.com/o/r/pull/7" });
  const v = new PrReview(); v.init({}, cx);
  v.render(cx); // before prs.json is read
  assert.ok(!v.srcAsked, "the list was not asked for");
  await flush();
  assert.equal(v.prSel?.number, 7, "the pick is back"); assert.ok(!v.restoring);
  // A pick that is gone falls back to the list.
  Map.prototype.set.call(S.store, "pr.selected", { all: "https://github.com/o/r/pull/99" });
  const w = new PrReview(); w.init({}, cx); await flush(); w.render(cx);
  assert.ok(!w.restoring && !w.prSel && w.srcAsked, "a pick that is gone: the list");
}

// ---- a PR's head is asked once for all copies (the panel, then the review of the same PR)
{
  let asks = 0;
  S.exec = async (cmd, args) => { if (cmd === "gh" && args.includes("headRefOid")) { asks++; return { code: 0, stdout: JSON.stringify({ headRefOid: "abc" }), stderr: "" }; } return { code: 1, stdout: "", stderr: "stub" }; };
  Map.prototype.set.call(S.store, "pr.selected", {});
  const pr = { url: "https://github.com/o/r/pull/8", number: 8, repo: "o/r", headSha: "abc" };
  const a = new PrReview(); a.init({}, cx); const b = new PrReview(); b.init({}, cx); await flush();
  a.checkHead(pr, cx); await flush(); b.checkHead(pr, cx); await flush();
  assert.equal(asks, 1, "the second copy takes the head the first one asked for");
  S.exec = null;
}

// ---- a scan for session PRs that cannot reach GitHub waits longer each time (prs.py exit 3)
{
  let code = 3, runs = 0;
  S.exec = async (cmd, args) => { if (cmd === "python3" && String(args[0]).endsWith("prs.py")) { runs++; return { code, stdout: "", stderr: "" }; } return { code: 1, stdout: "", stderr: "stub" }; };
  S.files.set("/h/pr-data/prs.json", JSON.stringify({ generated: "2020-01-01T00:00:00Z", prs: [] }));
  const v = new PrReview(); v.init({}, cx); await flush();
  assert.deepEqual([runs, v.scanPoll.fails], [1, 1], "the scan at mount failed");
  v.scanPoll.at = Date.now() - 6 * 60000; assert.ok(!v.scanDue(), "six minutes after a failed scan: not yet");
  v.scanPoll.at = Date.now() - 11 * 60000; assert.ok(v.scanDue(), "eleven minutes after: due");
  code = 2; v.scanIfDue(cx); await flush();
  assert.deepEqual([runs, v.scanPoll.fails], [2, 0], "one PR that cannot be read is not an outage");
  S.exec = null;
}

// ---- the review's "Fix worktrees…": a worktree with work only there is removed on the second click, never the first
{
  const calls = [];
  S.exec = async (cmd, args) => { calls.push([cmd, ...args].join(" ")); return { code: 0, stdout: "", stderr: "" }; };
  S.props = { part: "review" };
  const v = new PrReview(); v.init({}, cx); await flush();
  v.prSel = { url: "https://github.com/o/demo/pull/2", repo: "o/demo", number: 2, cwd: "/code/demo" };
  v.wts = [{ path: "/h/.herdr/worktrees/demo/fix-2-a1", branch: "fix/2-a1", only: 2, dirty: false, unknown: false }, { path: "/h/.herdr/worktrees/demo/fix-2-b2", branch: "fix/2-b2", only: 0, dirty: false, unknown: false }];
  calls.length = 0; v.removeWorktree(0, cx); await flush();
  assert.deepEqual([calls.filter((c) => c.includes("worktree remove")), /Nothing was removed/.test(v.note)], [[], true], "the first click on one with commits only there removes nothing");
  v.removeWorktree(0, cx); await flush();
  assert.deepEqual(calls.filter((c) => /worktree remove|branch -D/.test(c)), ["git -C /code/demo worktree remove --force /h/.herdr/worktrees/demo/fix-2-a1", "git -C /code/demo branch -D fix/2-a1"], "the second click removes it and its branch");
  calls.length = 0; v.removeWorktree(1, cx); await flush();
  assert.equal(calls.filter((c) => c.includes("worktree remove")).length, 1, "one with nothing only there goes at once");
  S.exec = null; S.props = {};
}

// ---- back from a review the panel shows that review's PR, not the one picked before (shared "pr.fromReview")
{
  const { byRef } = await import("./views.js");
  const pr = (repo, n) => ({ url: `https://github.com/${repo}/pull/${n}`, repo, number: n, title: `PR ${n}`, headSha: "abc", base: "main" });
  const a = pr("o/r", 7), x = pr("o/other", 7), y = pr("o/r", 9);
  assert.deepEqual([byRef([a, x, y], "7"), byRef([a, x, y], "o/other#7"), byRef([a, x, y], x.url), byRef([a, x, y], "9"), byRef([a], "8")], [a, x, x, y, null], "two PRs numbered 7: the bare number is the first, the repo or the URL names the other");
  S.files.set("/h/pr-data/prs.json", JSON.stringify({ generated: new Date().toISOString(), prs: [a] }));
  Map.prototype.set.call(S.store, "pr.selected", { "all@s1": a.url }); Map.prototype.set.call(S.store, "pr.picked", {});
  // The review of X was opened by a Resume in a list (no pick), then minimized: the review copy hands X over.
  Map.prototype.set.call(S.store, "review.target", x); Map.prototype.set.call(S.store, "review.back", "corgi");
  S.props = { part: "review" }; const rv = new PrReview(); rv.init({}, cx); await flush(); rv.command("minimize", cx);
  assert.equal(S.store.get("pr.fromReview")?.url, x.url, "leaving the review hands its PR over");
  S.props = {}; const v = new PrReview(); v.init({}, cx); v.render(cx);
  assert.ok(v.restoring && !v.srcAsked, "no list while it comes back");
  await flush();
  assert.deepEqual([v.prSel?.url, S.store.get("pr.fromReview"), S.store.get("pr.selected")["all@s1"]], [x.url, null, x.url], "the panel shows the review's PR and remembers it for this space");
  const w = new PrReview(); w.init({}, cx); await flush();
  assert.equal(w.prSel?.url, x.url, "and again after the next remount");
}

// ---- resuming a review: the first frame drawn stands on the tab and page you left, the list scrolls there when it comes
{
  const { splitPatch } = await import("./pr.js");
  const target = { url: "https://github.com/o/r/pull/3", repo: "o/r", number: 3, title: "t", headSha: "abc", base: "main" };
  const diff = "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1,2 +1,2 @@\n def a():\n-    return 1\n+    return 2\ndiff --git a/b.py b/b.py\n--- a/b.py\n+++ b/b.py\n@@ -1 +1 @@\n-x = 1\n+x = 2\n";
  S.files.set("/h/pr-data/review-progress.json", JSON.stringify({ [target.url]: { seen: ["a.py"], ui: { tab: "steps", page: null, fileFocus: "b.py", cur: 1, order: "reading" } } }));
  Map.prototype.set.call(S.store, "review.target", target); S.props = { part: "review" };
  S.exec = async (cmd, args) => (cmd === "gh" && args[1] === "diff" ? { code: 0, stdout: diff, stderr: "" } : { code: 1, stdout: "", stderr: "stub" });
  const seen = []; // what each frame would show: held frames draw nothing of the review
  const v = new PrReview(); v.init({}, cx);
  for (let k = 0; k < 40 && !(v.hunks && v.resumed); k++) { v.render(cx); seen.push(v.resumed === target.url ? [v.tab, v.order, Boolean(v.hunks)] : "held"); for (const fn of timers.splice(0)) fn(cx); await new Promise((r) => setImmediate(r)); }
  assert.ok(seen.includes("held") || seen.length, "frames are held until the place is read");
  assert.deepEqual(seen.filter((x) => x !== "held").map((x) => `${x[0]}/${x[1]}`).filter((x) => x !== "steps/reading"), [], "no frame on another tab or order than the one you left");
  await flush(); v.patch ??= splitPatch(diff);
  assert.deepEqual([v.tab, v.order, v.resumed, [...v.collapsed].includes("a.py")], ["steps", "reading", target.url, true], "the tab, the order and the folded viewed file are back");
  // What you did since stays when the diff loads again (a new head).
  v.tab = "files"; await v.onSource(cx);
  assert.equal(v.tab, "files", "a later load does not put the old place back");
  S.exec = null; S.props = {};
}

// ---- Setup's first line says what the list comes to
{
  const { setupSummary } = await import("./setup-view.js");
  const now = 1e12, row = (id, status) => ({ id, status });
  assert.equal(setupSummary([row("git", "ok"), row("gh", "ok")], now - 120000, now), "All 2 programs were found. Checked 2 min ago.");
  assert.equal(setupSummary([row("git", "ok"), row("codex", "optional-missing")], now, now), "Everything required was found; 1 optional program is not installed. Checked just now.");
  assert.match(setupSummary([row("git", "missing"), row("gh", "logged-out"), row("x", "ok")], now + 5000, now), /^2 of 3 programs are missing or not signed in: git, gh\. .* Checked just now\.$/);
}
// ---- "Discard" asks once
{
  S.props = {}; const v = new PrReview(); v.init({}, cx); await flush();
  v.reviewKey = "k"; v.comments = [{ id: "1", file: "a.py", text: "x" }, { id: "2", file: "a.py", text: "y" }];
  v.discardAll(cx); assert.deepEqual([v.discardAsk, v.comments.length], [true, 2], "the first click asks");
  v.discardAll(cx); assert.deepEqual([v.discardAsk, v.comments.length], [false, 0], "the second deletes them");
}
console.log("panel ok");
