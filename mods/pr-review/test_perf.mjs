// Run: node test_perf.mjs  (what a frame costs, counted with the render stand-ins on the fixture of PR #2 and on a
// synthetic big review (perf_fixture.mjs: 100 files, 10 000 diff lines, 74 findings, 80 cards). A frame that changes
// nothing must not merge findings, lay out a map, read a file's rows or ask Herdr for anything; the memos that make
// it so must give what a fresh computation gives after everything that changes their inputs. Counts, not times: the
// one time check is generous and takes the best of three. perf_bench.mjs prints the numbers.)
import assert from "node:assert/strict";
import { hasFixtures, openReview, PR2, BIG, STATES, measure, counted, frame, later, settled, quiet, cx, settle } from "./perf_bench.mjs";
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
const BUDGET = { "Files (as opened)": 14000, "Files (all open)": 14000, "Findings": 15000, "Findings, one open": 15000, "Comments": 14000, "Walkthrough, a layer": 17000, "Overview": 3000, "Architecture": 3200,
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

// ---- a frame lays a map out only as far as a frame can afford; the rest comes in slices after it
// (In Herdr a render is stopped after about 50 ms and the page never came: the full layout of 80 cards took 208 ms
// there. One mechanism, stack.js laidOut: up to 16 calls the full layout in the frame; up to 40 one rough pass with no
// order priced; more, as here (80 cards, 102 calls), nothing in the frame and the rough pass in the first slice after
// it. The search for the better layout, arch.js layoutJob, follows, one slice per timer tick, and replaces the picture
// once.)
{
  // priced: the orders of cards and lanes a layout tried (a pass counts its finished lines' overlaps once: not that).
  const ids = (f) => { S.ids = new Set(); const ran = counted(f), seen = S.ids; S.ids = null; return { ran, map: ["rv-arch-canvas", "rv-res-canvas"].filter((id) => seen.has(id)) }; };
  const drawn = (v) => { const { ran, map } = ids(() => frame(v)); return { layouts: ran("arch.archLayout"), priced: ran("arch.permutations") + ran("arch.overlapsOf") - ran("arch.archLayout"), map }; };
  // One timer tick: what ran in it. A tick is at most one slice (one layoutStep) or one rough pass, never both.
  const tick = (what) => { const ran = counted(() => later()), n = { steps: ran("arch.layoutStep"), layouts: ran("arch.archLayout"), priced: ran("arch.permutations") + ran("arch.overlapsOf") - ran("arch.archLayout") };
    assert.ok(n.steps <= 1 && !(n.steps && n.layouts), `${what}: one slice per timer tick (${JSON.stringify(n)})`); return n; };
  const searched = (what) => { let ticks = 0; while (ticks < 5000 && tick(what).steps) ticks++; return ticks; };
  const big = await openReview(BIG());
  for (const id of ["rv-arch-canvas", "rv-res-canvas"]) big.hsOf(id).viewW = 1300; // measured, as in a window: Fit decides from it
  for (const [state, id] of [["Architecture", "rv-arch-canvas"], ["Resilience", "rv-res-canvas"]]) {
    STATES[state](big); await settle(); settled(big); searched(state); big.fitMemos = null;
    assert.deepEqual(drawn(big), { layouts: 0, priced: 0, map: [] }, `${state}, 80 cards: the first frame lays nothing out and draws the page without its picture`);
    assert.equal(Object.keys(big.fitMemos).length, 1, `${state}: only the card size shown is asked for`);
    // The first slice after the frame: one layout, and that one rough (no order of cards or lanes priced).
    assert.deepEqual(tick(state), { steps: 0, layouts: 1, priced: 0 }, `${state}: the first slice lays the map out once, roughly`);
    const rough = Object.values(big.fitMemos)[0].L;
    assert.deepEqual(drawn(big), { layouts: 0, priced: 0, map: [id] }, `${state}: the picture is there, and the frame lays nothing out`);
    // How many slices that takes depends on the machine (a slice is about 10 ms); that a slice is ten steps of the
    // layout and never a whole one is counted with a stepping clock in test_arch.mjs.
    assert.ok(searched(state) >= 1, `${state}: the search runs in slices after the frame`);
    assert.notEqual(Object.values(big.fitMemos)[0].L, rough, `${state}: the search's layout replaced the rough one`);
    assert.deepEqual(drawn(big), { layouts: 0, priced: 0, map: [id] }, `${state}: the frame after the search lays nothing out`);
    assert.equal((await measure(big, 1)).asked.after, 0, `${state}: and asks for no timer once the search is through`);
  }
  // Marks changed (a finding dismissed): the frame draws the layout from before until the search for the new one is
  // through; no rough picture in between.
  STATES.Architecture(big); settled(big); searched("Architecture");
  const marked = big.openFindings().find((f) => big.archMarksNow().nodes.size && [...big.archMarksNow().nodes.values()].some((m) => m.findings.includes(f) && m.findings.length === 1));
  assert.ok(marked, "the fixture has a card marked by one finding");
  { const shown = () => big.fitMemos.true.L, before = shown(); // the map with narrow cards (Fit), the one on the page
    big.find.status = { ...big.find.status, [marked.id]: { s: "dismissed", at: "2026-11-15T10:00:00Z", ids: marked.ids } };
    assert.deepEqual(drawn(big), { layouts: 0, priced: 0, map: ["rv-arch-canvas"] }, "new marks on a big map: the picture from before stays for the frame");
    assert.equal(shown(), before);
    { const n = tick("new marks"); assert.deepEqual([n.steps, n.layouts], [1, 0], "no rough pass: the picture from before stands in while the search runs"); }
    searched("new marks");
    assert.notEqual(shown(), before, "and the search's layout replaces it"); }
  const small = await openReview(PR2());
  for (const id of ["rv-arch-canvas", "rv-res-canvas"]) small.hsOf(id).viewW = 1300;
  STATES.Architecture(small); await settle(); settled(small); searched("PR #2"); small.fitMemos = null;
  const first = drawn(small);
  assert.deepEqual([first.layouts, first.map, first.priced > 0], [1, ["rv-arch-canvas"], true], "9 cards: laid out once and drawn in the first frame, with the orders tried (the full layout: nothing crosses, so one pass)");
}
await settle();
console.log("perf ok");
