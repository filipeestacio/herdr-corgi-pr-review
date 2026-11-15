// Run: node test_perf.mjs  (what a frame costs, counted with the render stand-ins on the fixture of PR #2 and on a
// synthetic big review (perf_fixture.mjs: 100 files, 10 000 diff lines, 74 findings, 80 cards). A frame that changes
// nothing must not merge findings, lay out a map, read a file's rows or ask Herdr for anything; the memos that make
// it so must give what a fresh computation gives after everything that changes their inputs. Counts, not times: the
// one time check is generous and takes the best of three. perf_bench.mjs prints the numbers.)
import assert from "node:assert/strict";
import { hasFixtures, openReview, PR2, BIG, STATES, measure, counted, frame, later, settled, quiet, cx, settle, N } from "./perf_bench.mjs";
import { S } from "./render_stub.mjs";

if (!hasFixtures) {
  console.error("test_perf: no fixtures. This test needs demo/fixtures/review of the mod's repository; run it in a checkout of the repository, not in a copy of the mod folder.");
  process.exit(1);
}

// What the views read of the findings, as text; fresh: the same with every memo dropped first.
const MEMOS = ["findMemo", "fstMemo", "perMemo", "marksMemo", "rowsKey", "anchorMemo", "rowsMemo", "kept"];
const snap = (v) => JSON.stringify({ findings: v.findings(), notes: v.merged().notes, status: v.findings().map((f) => v.fstatus(f)), counts: v.counts(), open: v.openFindings().map((f) => f.id),
  marks: [[...v.archMarksNow().nodes.keys()], [...v.archMarksNow().edges.keys()]], crossings: v.crossingsNow(), rows: v.patch.slice(0, 12).map((f) => v.rowsFor(f.path, true).length) });
const fresh = (v) => { for (const k of MEMOS) v[k] = null; return snap(v); };
const same = (v, what) => { const kept = snap(v); assert.equal(kept, fresh(v), `${what}: the remembered findings, statuses, counts and marks are the ones a fresh computation gives`); };

// ---- the memos follow their inputs
for (const [name, data] of [["PR #2", PR2()], ["the big review", BIG()]]) {
  const v = await openReview(data), at = (x) => `${name}, ${x}`;
  same(v, at("opened"));
  // A file's rows change in place (the whole file, opened context, the file's text arriving): rowsSig is another value.
  const withFinding = v.findings().find((f) => f.line > 0 && v.fileHunks.has(f.file)).file, other = v.patch.find((f) => f.path !== withFinding).path;
  v.worktree = { url: v.prSel.url, head: v.head, path: "/h/w" };
  for (const p of [withFinding, other]) S.files.set(`/h/w/${p}`, Array.from({ length: 200 }, (_x, i) => `line ${i + 1}`).join("\n"));
  let sig = v.rowsSig();
  const moved = (what) => { assert.notEqual(v.rowsSig(), sig, at(`${what}: the rows' signature is a new one`)); sig = v.rowsSig(); assert.equal(v.rowsSig(), sig, "and stays the same while nothing changes"); same(v, at(what)); };
  v.toggleWhole(withFinding, cx); moved("a whole file asked for");
  await settle(); moved("the whole file's text arrived");
  v.expand(other, 0, "down", cx); moved("context opened");
  await settle(); moved("its file's text arrived");
  v.toggleWhole(withFinding, cx); moved("the whole file closed");
  // Statuses are replaced, never changed in place (writeStatus).
  const [a, b] = v.findings();
  v.find.status = { ...v.find.status, [a.id]: { s: "dismissed", at: "2026-11-15T10:00:00Z", ids: a.ids } }; same(v, at("a finding dismissed"));
  assert.equal(v.fstatus(v.findingById(a.id)), "dismissed");
  v.find.status = { ...v.find.status, [b.id]: { s: "progress", fixHead: "abc", at: "2026-11-15T10:00:00Z" } }; same(v, at("a fix sent"));
  v.head = "0000000000000000000000000000000000000000"; same(v, at("a new head"));
  // securityNow puts a new object around the same analysis: nothing is merged again.
  const ran = counted(() => { v.securityNow(cx); v.findings(); });
  assert.deepEqual([ran("pr.mergeFindings"), ran("pr.resilienceStart")], [0, 0], at("securityNow on unchanged data merges no findings and does not read the diff again"));
  same(v, at("after securityNow"));
  // A suggestion handled (changed in place, counted by its keys) and a probe's result.
  v.prog.handled.x = "dropped"; same(v, at("a suggestion handled")); delete v.prog.handled.x;
  v.deep = { ...v.deep, probes: { ...(v.deep.probes ?? {}) } }; same(v, at("the probes read again"));
}

// ---- a frame that changes nothing
// At most this many of the mod's own functions run in it (measured on the big review, with room: before the memos
// the Overview ran 13 350, a layer 38 900), and none of the expensive ones.
const BUDGET = { "Files (as opened)": 14000, "Files (all open)": 14000, "Findings": 15000, "Findings, one open": 15000, "Comments": 14000, "Walkthrough, a layer": 22000, "Overview": 3000, "Architecture": 3200,
  "Architecture, a card": 3200, "Security": 2600, "Resilience": 3500, "Markdown preview": 3000 };
const NEVER = ["pr.mergeFindings", "arch.archLayout", "pr.fileRows", "pr.resilienceStart", "pr.diffRows", "pr.splitPatch", "pr.hunksOf", "views.findingAnchor", "views.crossingsOf", "views.areaFindings"];
{
  const v = await openReview(BIG());
  for (const id of ["rv-arch-canvas", "rv-sec-canvas", "rv-res-canvas"]) v.hsOf(id).viewW = 1300; // measured, as in a window: Fit decides from it
  for (const [state, go] of Object.entries(STATES)) {
    go(v); await settle();
    let m = await measure(v, 1), best = m.warm.ms;
    for (let k = 0; k < 2 && best > 150; k++) best = Math.min(best, (await measure(v, 1)).warm.ms); // a busy machine: the best of three
    const fns = [...m.stat.values()].reduce((n, s) => n + s.n, 0);
    assert.deepEqual(NEVER.filter((f) => m.calls(f) > 0 && !(f === "views.findingAnchor" && m.calls(f) < 200)), [], `${state}: a frame that changes nothing computes none of these again`);
    assert.ok(fns <= BUDGET[state], `${state}: ${fns} function calls in a frame that changes nothing, at most ${BUDGET[state]}`);
    assert.deepEqual(m.asked, { notify: 0, after: 0, every: 0, spawn: 0, exec: 0, read: 0, shared: 0 }, `${state}: a frame that changes nothing asks for no redraw, timer, task, command or shared write`);
    assert.ok(best < 150, `${state}: ${best.toFixed(0)} ms for a frame that changes nothing (best of three; a few ms on an idle machine)`);
    if (v.mdPrev) v.command("md-close", cx);
  }
}
// ---- the diff's list asks what hangs under a line only where something does
{
  const v = await openReview(BIG());
  STATES["Files (as opened)"](v); await settle(); settled(v);
  const rows = v.items.filter((it) => it.t === "row").length, under = v.items.filter((it) => !["row", "file", "fold", "gap", "note", "pad"].includes(it.t)).length;
  const ran = counted(() => v.filesItems());
  assert.ok(rows > 2000 && under > 20, `the list has ${rows} lines and ${under} items under them`);
  assert.ok(ran("pr.lineThreads") < 200, `${ran("pr.lineThreads")} lines were asked for their comments while listing ${rows} (before: each of them)`);
}

// ---- timers ask for nothing while the window is behind another
{
  const v = await openReview(PR2()), key = v.threadKey();
  v.threadDoc = { ...v.threadDoc, [key]: { ...(v.threadDoc?.[key] ?? {}), fixes: [{ id: "j1", state: "running", target: "sub", path: "/h/fix", at: Date.now(), items: [] }] } };
  let execs = 0; S.exec = async () => { execs++; return { code: 1, stdout: "", stderr: "stub" }; };
  const active = globalThis.window.is_window_active;
  globalThis.window.is_window_active = () => false;
  v.fixCostTick(cx); v.ghTick(cx); await settle();
  assert.equal(execs, 0, "behind another window neither a running fix's cost nor GitHub is asked for");
  globalThis.window.is_window_active = () => true;
  v.fixCostTick(cx); await settle();
  assert.equal(execs, 1, "in front, a running fix's log is looked for");
  // The job's agent is gone (no terminal of that name): read that once, then never again; alive again, read again.
  v.fixCostTick(cx); await settle(); v.fixCostTick(cx); await settle();
  assert.equal(execs, 1, "a job whose agent ended is not asked about every 20 s");
  v.threadDoc = { ...v.threadDoc, [key]: { ...v.threadDoc[key], fixes: [{ ...v.threadDoc[key].fixes[0], terminal: "t9" }] } }; S.terminals = [{ address: "t9", state: "live" }];
  v.fixCostTick(cx); await settle(); v.fixCostTick(cx); await settle();
  assert.equal(execs, 3, "a job whose agent's terminal is live is asked about on every tick");
  S.terminals = null; v.fixCostTick(cx); await settle(); v.fixCostTick(cx); await settle();
  assert.equal(execs, 4, "and once more after it ended");
  // GitHub's poll and the threads' files: a frame only for something new.
  const comment = JSON.stringify({ id: 1, path: "library/loans.py", line: 3, side: "RIGHT", user: "anna", user_type: "User", body: "Why?", at: "2026-11-15T10:00:00Z" });
  S.exec = async (cmd, args) => (args.includes("graphql") ? { code: 0, stdout: "", stderr: "" } : args.some((a) => /pulls\/2\/comments/.test(String(a))) ? { code: 0, stdout: comment, stderr: "" } : { code: 1, stdout: "", stderr: "stub" });
  v.cfg = { ...v.cfg, dryRun: false };
  const polled = async () => { v.ghPoll = null; v.ghIn = null; const n0 = N.notify; v.ghTick(cx); await settle(); return N.notify - n0; };
  assert.ok((await polled()) > 0 && v.gh.length === 1, "a new comment from GitHub is drawn");
  const list = v.gh;
  assert.deepEqual([await polled(), v.gh === list], [0, true], "the same comments again: no frame, and the list stays the one it was");
  globalThis.window.is_window_active = active; S.exec = null;
}

// ---- opening a review: where a resilience run would start is counted after the review is there
{
  later(); // what the reviews above left for later
  const v = await openReview(BIG());
  assert.equal(v.ai.resilienceStart, undefined, "not counted while the review opens");
  const ran = counted(() => later());
  assert.ok(ran("pr.resilienceStart") === 1 && /^This PR adds /.test(v.ai.resilienceStart?.sentence ?? ""), "counted once, a moment later, and then on the analysis");
  assert.equal(counted(() => { v.securityNow(cx); later(); })("pr.resilienceStart"), 0, "and never again for the same diff");
}

// ---- the review of a PR does not ask git again what the panel asked
{
  const { default: PrReview } = await import("./main.js");
  let asked = 0, fail = true;
  S.exec = async (cmd, args) => { if (cmd !== "git" || args[0] !== "rev-parse") return { code: 1, stdout: "", stderr: "stub" }; asked++; if (fail) throw new Error("no git"); return { code: 0, stdout: "/h/x\n/h/x/.git\norigin/main\n", stderr: "" }; };
  S.store.clear(); S.props = {}; const panel = new PrReview(); panel.init({}, cx);
  assert.equal(await panel.repoOf("/h/x"), null, "git did not run: no repo");
  fail = false;
  assert.deepEqual(await panel.repoOf("/h/x"), { root: "/h/x", gitdir: "/h/x/.git", base: "origin/main" }, "asked again after a command that did not run");
  S.props = { part: "review" }; const review = new PrReview(); review.init({}, cx);
  const before = asked;
  assert.deepEqual([await review.repoOf("/h/x"), asked - before], [{ root: "/h/x", gitdir: "/h/x/.git", base: "origin/main" }, 0], "another copy of the mod gets the folder's repo without a command");
  S.exec = null; S.props = null; await settle();
}

// ---- shared state is written for another value only, and a visit alone does not write the register again
{
  later(); S.writes = true;
  const v = await openReview(PR2()), wrote = async (f) => { const n0 = N.shared; f(); later(); await settle(); later(); await settle(); return N.shared - n0; };
  assert.ok((await wrote(() => v.registerReview(cx))) >= 2 && S.store.get("review.open")?.[0]?.url === v.prSel.url, "the review registers itself: review.open and review.registry");
  assert.equal(await wrote(() => v.registerReview(cx)), 0, "a visit a moment later, nothing else new: no file, no shared write");
  assert.equal(await wrote(() => { v.prog.seen.add(v.patch[0].path); v.registerReview(cx); }), 2, "a file viewed: written");
  assert.equal(await wrote(() => { v.publish(); v.publish(); }), 0, "the bar's facts published again unchanged: not written");
  assert.equal(await wrote(() => { v.comments = [...v.comments, { id: "c9", file: v.patch[0].path, start: 1, end: 1, text: "x" }]; v.publish(); }), 1, "one more pending comment: written once");
  S.writes = false;
}
// ---- the panel with a PR chosen does not build the list of PRs behind it
{
  const { openPanel } = await import("./perf_bench.mjs");
  const { v: p, prs } = await openPanel(PR2(), 40);
  p.picking = true; const list = counted(() => frame(p));
  p.memo.clear(); p.context = null; p.choose(prs[0], cx); await settle();
  const chosen = counted(() => frame(p));
  assert.ok(list("context.ruleContext") >= 40 && chosen("context.ruleContext") === 0 && chosen("view.picker") === 0, "the list's rows are made while the list shows, not behind a chosen PR");
  S.exec = null; S.props = null; S.spaces = null;
}
// ---- the list's triage reads a PR's cached diff once per head, not each time the list opens
{
  const { hash } = await import("./pr.js"), { openPanel } = await import("./perf_bench.mjs");
  const { v: p, prs } = await openPanel(PR2(), 6), pr = prs.find((x) => x.state === "open"), base = `/h/pr-data/cache/diff-${hash(pr.url)}-${pr.headSha}`;
  S.files.set(`${base}.json`, JSON.stringify({ url: pr.url, head: pr.headSha, parts: 1 })); S.files.set(`${base}.0.txt`, PR2().diff);
  let reads = 0; const get = S.files.get.bind(S.files); S.files.get = (k) => { if (k === `${base}.0.txt`) reads++; return get(k); };
  p.picking = true; p.loadTriage(cx); await settle(); p.loadTriage(cx); await settle();
  assert.deepEqual([reads, p.triage.has(pr.url)], [1, true], "two loads of the list's triage read the diff once");
  S.files.get = get; S.exec = null; S.props = null; S.spaces = null;
}

// ---- the command loop goes on after a command that threw, and starts again after one that Herdr stopped
{
  const waiters = []; S.nextCommand = () => new Promise((r) => waiters.push(r));
  const v = await openReview(PR2()), send = async (c) => { waiters.shift()(c); await settle(); };
  assert.equal(waiters.length, 1, "the review waits for its commands");
  await send("findings"); assert.equal(v.tab, "findings");
  const command = v.command; v.command = () => { throw new Error("boom"); };
  await send("files"); assert.equal(v.note, 'The command "files" failed: boom', "a command that throws is said");
  v.command = command;
  await send("files"); assert.equal(v.tab, "files", "and the next one runs");
  // Stopped by Herdr: the loop's task is gone with its wait, and cmdAt was never taken back.
  waiters.length = 0; v.cmdAt = Date.now() - 10000;
  frame(v); await settle();
  assert.equal(waiters.length, 1, "the next frame starts the loop again");
  await send("comments"); assert.equal(v.tab, "comments", "and commands run again");
  frame(v); await settle(); assert.equal(waiters.length, 1, "a loop that waits is not started twice");
  S.nextCommand = null;
}

// ---- frames that Herdr stopped: the view draws less there
// (A stopped frame leaves `drawing` set: no code of the mod runs after it. Two in a row on one tab and page count.)
{
  const ids = (v) => { S.ids = new Set(); frame(v); const got = S.ids; S.ids = null; return got; };
  const stopped = (v) => { v.drawing = true; return ids(v); }; // the frame after a stopped one
  const big = await openReview(BIG());
  STATES.Resilience(big); await settle(); await quiet(big);
  assert.ok(ids(big).has("rv-res-canvas") && big.leanLevel() === 0, "the map is drawn");
  assert.ok(stopped(big).has("rv-res-canvas") && stopped(big).has("rv-res-canvas"), "two stopped frames change nothing (a busy machine does that to a frame of 25 ms)");
  assert.ok(ids(big).has("rv-res-canvas") && big.cut === 0, "and a frame that ended starts the count again");
  stopped(big); stopped(big); const lean = stopped(big);
  assert.ok(!lean.has("rv-res-canvas") && lean.has("rv-res-canvas-lean") && lean.has("rv-res-canvas-again"), "three in a row: the page without its picture, with a sentence and a way back");
  assert.ok(!ids(big).has("rv-res-canvas"), "it stays so");
  STATES.Architecture(big); await settle(); await quiet(big);
  assert.ok(ids(big).has("rv-arch-canvas"), "another page is drawn as before");
  STATES.Resilience(big); await settle();
  assert.ok(!ids(big).has("rv-res-canvas"), "back on the page: still without the picture, no frames are stopped again to find out");
  S.clicks.get("rv-res-canvas-again")({ modifiers: {}, click_count: 1 }, cx);
  assert.ok(ids(big).has("rv-res-canvas"), "Draw it again brings the picture back");
  // The list: the lines listed halve per level, and the Walkthrough has its own number whatever the Files tab did.
  STATES["Files (as opened)"](big); await settle(); frame(big);
  STATES["Walkthrough, a layer"](big); await settle(); frame(big);
  const rows = () => big.items.filter((it) => it.t === "row").length, before = rows();
  assert.ok(before > 2000 && before <= 3000, `the Walkthrough lists up to 3 000 lines (${before}), also after the Files tab was drawn`);
  // The open layer has its lines wherever it stands; the room left goes to the layers after it, then to the ones before.
  const shown = (k) => { const s = big.steps()[k], ids = new Set(big.present(s)); return [big.items.filter((it) => it.t === "row" && ids.has(it.hunk)).length, big.present(s).reduce((n, id) => n + big.byId.get(id).rows.length, 0)]; };
  for (const k of [0, 9, big.steps().length - 1]) {
    big.command(`step:${k}`, cx); frame(big);
    const [got, all] = shown(k);
    assert.ok(all > 0 && got >= all, `layer ${k} open: all of its ${all} lines are listed (${got})`);
    assert.ok(rows() <= 3000 + 200, `and the list still holds about 3 000 (${rows()})`);
  }
  const last = big.steps().length - 1; assert.ok(shown(last - 1)[0] > 0 && shown(1)[0] === 0, "the last layer open: the room left goes to the ones before it, the first ones wait");
  big.command("step:0", cx); frame(big);
  stopped(big); stopped(big); stopped(big);
  assert.ok(rows() <= 1500 && rows() > 700, `after three stopped frames it lists half (${rows()})`);
  // After a while it tries all of it again.
  const now = Date.now; Date.now = () => now() + 6 * 60000;
  frame(big); assert.ok(rows() > 2000, `five minutes later the list is whole again (${rows()})`);
  Date.now = now;
  // An exception is not a stopped frame.
  const boom = big.renderReview; big.renderReview = () => { throw new Error("boom"); };
  for (let k = 0; k < 3; k++) assert.throws(() => big.render(cx), /boom/);
  big.renderReview = boom; frame(big);
  assert.equal(big.leanLevel(), 1, "three frames that threw did not count as stopped");
}

// ---- a big map is laid out after the frame, a small one in it
// (In Herdr the layout of 80 cards takes 208 ms and a render is stopped after about 50: laid out in the frame, the
// page never came.)
{
  const drawn = (v) => { S.ids = new Set(); const ran = counted(() => frame(v)); const ids = S.ids; S.ids = null; return { layouts: ran("arch.archLayout"), map: ["rv-arch-canvas", "rv-res-canvas"].filter((id) => ids.has(id)) }; };
  const big = await openReview(BIG());
  for (const [state, id] of [["Architecture", "rv-arch-canvas"], ["Resilience", "rv-res-canvas"]]) {
    STATES[state](big); await settle(); big.fitMemos = null;
    assert.deepEqual(drawn(big), { layouts: 0, map: [] }, `${state}, 80 cards: the first frame lays nothing out and draws the page without its picture`);
    later();
    assert.equal(big.fitMemos && Object.keys(big.fitMemos).length, 1, `${state}: one layout per task`);
    settled(big);
    assert.deepEqual(drawn(big), { layouts: 0, map: [id] }, `${state}, 80 cards: the picture is there once its layout is, and the frame still lays nothing out`);
  }
  // Marks changed (a finding dismissed): the frame draws the layout from before until the new one is there.
  STATES.Architecture(big); settled(big);
  const marked = big.openFindings().find((f) => big.archMarksNow().nodes.size && [...big.archMarksNow().nodes.values()].some((m) => m.findings.includes(f) && m.findings.length === 1));
  assert.ok(marked, "the fixture has a card marked by one finding");
  { big.find.status = { ...big.find.status, [marked.id]: { s: "dismissed", at: "2026-11-15T10:00:00Z", ids: marked.ids } };
    assert.deepEqual(drawn(big), { layouts: 0, map: ["rv-arch-canvas"] }, "new marks on a big map: the picture from before stays for the frame"); settled(big); }
  const small = await openReview(PR2());
  STATES.Architecture(small); await settle(); small.fitMemos = null;
  const first = drawn(small);
  assert.ok(first.layouts > 0 && first.map.includes("rv-arch-canvas"), "9 cards: laid out and drawn in the first frame, as before");
}
await settle();
console.log("perf ok");
