// Run: node test_render.mjs  (the review view rendered against stand-ins for gpui-kit, gpui-base and herdr: the first
// render, the Files list's layout and scrolling (autoFold), 0 / 3 / 310 files, the Architecture page with the Ask drawer
// open, folded and squeezing, a layer's findings and the Findings tab. An exception, a null or non-finite number given to an element, a bad virtual-list size
// or key fails it; a ReferenceError here once showed in Herdr as "This view could not be re-rendered — Null".)
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const S = (globalThis.__rv = { errs: [], lists: [], store: new Map() });
const where = () => new Error().stack.split("\n").slice(3, 6).map((s) => s.trim()).join(" | ");
const bad = (v) => v === null || v === undefined || (typeof v === "number" && !Number.isFinite(v));
S.el = () => {
  const p = new Proxy(function () {}, {
    get(_, k) {
      if (k === "then") return undefined;
      return (...a) => {
        if (k === "when") return a[0] ? a[1](p) : p;
        if (k === "map") return a[0](p);
        if (k === "children") { for (const c of a[0]) if (bad(c)) S.errs.push(`children: ${c} at ${where()}`); return p; }
        a.forEach((v, i) => { if (bad(v)) S.errs.push(`${String(k)}(arg ${i} = ${v}) at ${where()}`); });
        return p;
      };
    },
  });
  return p;
};
S.handle = () => new Proxy({}, { get: (_, k) => (k === "then" ? undefined : (...a) => {
  if (k === "scroll_to_item" && !(Number.isInteger(a[0]) && a[0] >= 0)) S.errs.push(`scroll_to_item(${a[0]}) at ${where()}`);
  return k === "value" ? "" : k === "is_focused" ? false : undefined;
}) });
S.vlist = (id, n, sizes, key, render) => {
  S.lists.push({ id, n, render });
  if (n > 10000) S.errs.push(`${id}: ${n} items`);
  if (Array.isArray(sizes)) { if (sizes.length !== n) S.errs.push(`${id}: ${sizes.length} sizes for ${n} items`); sizes.forEach((s, i) => { if (bad(s)) S.errs.push(`${id}: size ${i} = ${s}`); }); }
  for (let i = 0; i < n; i++) if (typeof key(i) !== "string") { S.errs.push(`${id}: key ${i}`); break; }
  return S.el();
};
const STUBS = {
  "gpui-kit": "const S = globalThis.__rv; export class View {} export const div = S.el, svg = S.el, image = S.el;",
  "gpui-base": `const S = globalThis.__rv, f = () => S.el(), n = { new: () => S.handle() };
    export const v_flex = f, h_flex = f, v_virtual_list = S.vlist, Scrollbar = { vertical: f, horizontal: f }, TextView = { markdown: f };
    export const Input = Object.assign(f, { new: f }), Textarea = Object.assign(() => S.el(), { new: f }), Editor = Object.assign(() => S.el(), { new: f });
    export const VirtualListScrollHandle = n, ScrollHandle = n, TextareaState = n, InputState = n, EditorState = n;`,
  herdr: `const S = globalThis.__rv, no = async () => { throw new Error("stub"); }, never = () => new Promise(() => {});
    export const exec = no, hc = no, readTextFile = no, pickFolder = no, writeTextFile = async () => {}, run = () => null;
    export const spaces = () => [], panes = () => [], agents = () => [], terminals = () => [], focused = () => null, layout = () => null;
    export const theme = () => new Proxy({}, { get: () => "#808080" }), settings = () => ({}), props = () => ({ part: "review" });
    export const shared = (k) => S.store.get(k), setShared = (k, v) => S.store.set(k, v), appHome = () => "/h", home = () => "/h";
    export const nextCommand = never, watchFolder = never, openOverlay = () => {}, closeOverlay = () => {};`,
};
registerHooks({
  resolve: (spec, ctx, next) => (STUBS[spec] ? { url: `stub:${spec}`, shortCircuit: true } : next(spec, ctx)),
  load: (url, ctx, next) => (url.startsWith("stub:") ? { format: "module", source: STUBS[url.slice(5)], shortCircuit: true } : next(url, ctx)),
});

const { default: PrReview } = await import("./main.js");
const { splitPatch, hunksOf, diffRows, stepKey } = await import("./pr.js");
const { foldOnOpen } = await import("./views.js");
const { renderMini } = await import("./review.js");
const cx = { notify() {}, timer: { after() {}, every() {} }, spawn() {}, focus_handle: () => ({ focus() {}, is_focused: () => false }), stop_propagation() {}, new() {} };

function review(files) {
  const target = { url: "https://github.com/o/r/pull/1", repo: "o/r", number: 1, title: "t" };
  S.store.set("review.target", target);
  const v = new PrReview(); v.init({}, cx);
  let text = "";
  for (let i = 0; i < files; i++) {
    const n = 5 + ((i * 37) % 120);
    text += `diff --git a/src/f${i}.ts b/src/f${i}.ts\n--- a/src/f${i}.ts\n+++ b/src/f${i}.ts\n@@ -1,${n} +1,${n} @@\n${"+x\n".repeat(n)}`;
  }
  v.prSel = target; v.patch = files ? splitPatch(text) : [];
  v.hunks = hunksOf(v.patch).map((h) => ({ ...h, rows: diffRows(h.lines) }));
  v.byId = new Map(v.hunks.map((h) => [h.id, h])); v.fileHunks = new Map();
  for (const h of v.hunks) v.fileHunks.set(h.path, [...(v.fileHunks.get(h.path) ?? []), h]);
  v.collapsed = new Set(foldOnOpen(v.patch));
  return v;
}
const ok = (what, f) => { S.errs.length = 0; S.lists.length = 0; try { f(); } catch (e) { S.errs.push(`threw ${e?.stack ?? e}`); } assert.deepEqual(S.errs, [], what); };
const files = () => S.lists.find((l) => l.id === "rv-list-files");
const layout = (at) => { const l = files(); if (l) { const s = Math.floor(l.n * at); l.render({ start: s, end: Math.min(l.n, s + 40) }, cx); } };

for (const n of [0, 3, 310]) {
  const v = review(n);
  v.tab = "files"; v.page = null;
  ok(`${n} files: first render`, () => v.render(cx));
  ok(`${n} files: wheel before any layout`, () => v.autoFold(cx));
  for (const at of [0, 0.3, 0.95, 0.5, 0.05]) ok(`${n} files: scroll to ${at}`, () => { v.render(cx); layout(at); v.autoFold(cx); v.render(cx); layout(at); });
  ok(`${n} files: a range from a longer list`, () => { v.vis = { start: 99999, end: 100040 }; v.autoFold(cx); v.render(cx); });
  if (n === 310) assert.ok(v.overBudget.size > 0 && files().n < 10000, "a big PR folds some files and stays under the list's limit");
  v.ai = { cut: [], exact: true, visuals: [], asks: [], model: "sonnet", title: "t", summary: "s", steps: [{ title: "a", why: "w", hunks: [], questions: [], risk: "low" }],
    arch: { nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }], edges: [{ from: "a", to: "b", label: "x" }] } };
  v.tab = "steps"; v.page = "arch";
  for (const [drawer, winW] of [[null, 900], ["open", 900], ["open", 1900], ["collapsed", 900]]) {
    v.deep.drawer[v.deepKey()] = drawer; v.winW = winW;
    ok(`${n} files: Architecture page, drawer ${drawer} at ${winW} px`, () => v.render(cx));
  }
  // A clicked card with its layer opened: the layer's explanation, questions and picture in the card.
  v.ai.arch.nodes[0].at = "src/a.ts:3";
  const lf = { id: "a1", reviewer: "analysis", step: "k", file: "src/f0.ts", line: 2, end: 2, severity: "high", category: "scope", title: "Unrelated", detail: "d", suggestion: "s" };
  v.ai = { ...v.ai, steps: [...v.ai.steps, { title: "b", why: "w", text: "x", hunks: [], questions: ["q?"], risk: "high", evidence: ["src/a.ts:1"], findings: [lf], // a new analysis, as the view gets one
    visuals: [{ kind: "flow", title: "f", nodes: [{ id: "n1", label: "N1", at: "src/a.ts:3" }, { id: "n2", label: "N2" }], edges: [{ from: "n1", to: "n2", label: "y" }] }] }] };
  v.archFocus = "a"; v.cardLayersOpen = null; // the first (riskiest) layer starts open
  ok(`${n} files: Architecture page, a card with its layer analysis open below the details`, () => v.render(cx));
  assert.deepEqual(v.cardLayers.list, [v.ai.steps[1]]);
  v.cardLayersOpen = new Map([[`a|${stepKey(v.ai.steps[1])}`, false]]);
  ok(`${n} files: Architecture page, the layer closed (its highlight still shows)`, () => v.render(cx));
  v.archFocus = null; v.page = null; v.cur = 1;
  ok(`${n} files: the same layer open in the Layers view`, () => v.render(cx));
  // Its picture is a row of the diff list, right after the layer's head; a question names the file the analysis gives.
  assert.deepEqual(v.items.slice(v.at.s1, v.at.s1 + 2).map((it) => it.t), ["step", "vis"], "a layer's picture sits over its code");
  assert.deepEqual([v.asked({ questionFiles: ["src/a.ts", ""] }, "q?", 0), v.asked({ questionFiles: ["src/a.ts", ""] }, "q?", 1), v.asked({}, "q?", 0)], ["a.ts — q?", "q?", "q?"]);
  // Its analysis finding: in the layer above, and in the Findings tab (read live from the analysis, linked to its layer).
  assert.deepEqual(v.findings().map((f) => f.id), ["a1"]); assert.equal(v.layerOf(v.findings()[0]), 1);
  v.tab = "findings";
  ok(`${n} files: the Findings tab with an analysis finding`, () => v.render(cx));
  if (n === 3) {
    // One finding per defect: the security reviewer's finding and an AI suggestion on the same line merge into it,
    // a suggestion alone on its line stays a note. Sent to Fix with a "fixed" report it is still unresolved: counted,
    // a blocker, a card in the diff; the layer lists it although the reviewer, not the analysis, leads it.
    v.find = { ...v.find, list: [{ id: "s1", reviewer: "security", file: "src/f0.ts", line: 2, end: 2, severity: "high", title: "Open door", detail: "d", suggestion: "" }],
      status: { a1: { s: "progress", fixHead: "h0", at: "2024-01-01" } }, reports: { a1: { id: "a1", status: "fixed", commit: "22e31c88f2", note: "done" } } };
    const sug = (line, severity, reason) => ({ key: `src/f0.ts:+${line}:${reason}`, hunk: v.hunks[0].id, path: "src/f0.ts", line, old: false, severity, reason });
    v.ai = { ...v.ai, suspects: [sug(2, "medium", "same line"), sug(4, "low", "a nit")] };
    const [f] = v.findings();
    assert.deepEqual([v.findings().length, f.id, f.ids, f.security, v.sourcesOf(f)], [1, "a1", ["s1", "a1", f.ids[2]], true, "Security review: high · Analysis: high · AI suggestion: medium"]);
    assert.deepEqual(v.openSugs().map((s) => s.reason), ["a nit"]);
    assert.equal(v.fstatus(f), "progress");
    assert.deepEqual([v.counts().unresolved, v.counts().sent, v.counts().security, v.openFindings().length], [1, 1, 1, 1]);
    assert.match(v.blockersNow().find((b) => b.finding === "a1").why, /unresolved high finding · fix sent, not verified/);
    assert.equal(v.fixLine(f), "commit 22e31c88 · agent reports fixed · not verified");
    assert.deepEqual(v.fixFacts(f).map(([k]) => k), ["Commit", "Report", "Check"]);
    assert.deepEqual(v.layerFindings(v.ai.steps[1]).map((x) => x.id), ["a1"]);
    v.ffocus = "a1";
    ok("the Findings tab: a merged finding open, with a fix sent", () => v.render(cx));
    v.tab = "files"; v.page = null; v.sug = v.openSugs()[0].key;
    ok("the diff: the finding's card and the note, opened", () => { v.render(cx); layout(0); });
    assert.deepEqual(v.items.filter((it) => ["find", "fact", "sug"].includes(it.t)).map((it) => it.t), ["find", "fact", "sug"], "a fix sent stays in the diff; one note, no buttons");
    // Cards in the diff: a security finding from high on starts open; folded, a card is one row without buttons.
    assert.equal(v.findOpen(f), true); assert.equal(v.findOpen({ ...f, security: false }), false);
    v.fopen = new Map([[f.id, false]]);
    ok("the diff: the finding's card folded", () => { v.render(cx); layout(0); });
    assert.deepEqual(v.items.filter((it) => ["find", "fact"].includes(it.t)).map((it) => it.t), ["find"]);
    v.fopen = null;
    v.dismiss(f, cx);
    assert.deepEqual([v.fstatus(v.findings()[0]), v.counts().unresolved], ["dismissed", 0]); assert.match(v.note, /all 3 sources of it/);
    v.find = { ...v.find, list: [], status: {}, reports: {} }; v.ai = { ...v.ai, suspects: [] }; v.sug = null; v.ffocus = null; v.note = null; v.tab = "findings";
    console.log("one finding per defect ok");
  }
  v.ai = { ...v.ai, steps: v.ai.steps.map((s) => ({ ...s, findings: [] })) };
  assert.deepEqual(v.findings(), [], "a finding the newest analysis no longer has is gone");
  v.tab = "files"; v.page = null; v.deep.drawer[v.deepKey()] = "open";
  ok(`${n} files: back to the list with the drawer open`, () => { v.render(cx); layout(0.5); v.autoFold(cx); });
}
// The Comments tab and the diff with GitHub's resolved and outdated threads, a bot's old and new comments, and a
// stale comment of yours (its line read "y" when written, "x" now).
{
  const { withThreadState } = await import("./threads.js");
  const v = review(3), g = (id, user, extra) => ({ id, path: "src/f0.ts", line: id, side: "RIGHT", user, user_type: user.endsWith("[bot]") ? "Bot" : "User", at: `2024-01-0${id}`, commit_id: "c1", body: `b${id}`, ...extra });
  v.gh = withThreadState([g(1, "anna"), g(2, "anna", { in_reply_to_id: 1 }), g(3, "lint[bot]"), g(4, "lint[bot]", { commit_id: "c2" }), g(5, "bob", { line: null, original_line: 9, outdated: true })],
    [{ id: 1, resolved: true, outdated: false }]);
  v.head = "new";
  v.comments = [{ id: "s1", file: "src/f0.ts", start: 1, end: 1, old: false, text: "stale", code: "y", head: "old" }, { id: "s2", file: "src/f0.ts", start: 2, end: 2, old: false, text: "fresh", code: "x", head: "old" }];
  assert.deepEqual([...v.staleNow()], ["s1"]);
  assert.deepEqual([v.ghNow().resolved, v.ghNow().botsHidden, v.ghNow().list.map((x) => x.id)], [1, 1, [4, 5]], "resolved hidden, the bot's older commit hidden");
  v.tab = "comments"; v.page = null;
  ok("Comments tab: resolved, bots, outdated, stale", () => v.render(cx));
  assert.ok(v.commentRowsNow().find((r) => r.id === "s1").stale && v.commentRowsNow().find((r) => r.id === "gh5").outdated);
  v.showResolved = true; v.allBots = true;
  ok("Comments tab: resolved and all bot comments shown", () => v.render(cx));
  assert.ok(v.commentRowsNow().find((r) => r.id === "gh1").resolved);
  v.tab = "files";
  ok("Files: the cards with STALE, Resolved and an outdated comment at the file's end", () => { v.render(cx); layout(0); });
  const items = v.filesItems().items;
  assert.ok(items.some((it) => it.t === "gh" && it.loose && it.g.id === 5), "the outdated comment shows loose");
  assert.ok(items.some((it) => it.t === "gh" && !it.loose && it.g.id === 1), "a resolved thread under its line once shown");
}
// The minimized review: nothing without one, an entry with Resume and ✕ with one.
globalThis.__rv.store.set("review.minimized", null);
renderMini();
globalThis.__rv.store.set("review.minimized", { target: { url: "https://github.com/o/r/pull/7", number: 7, title: "feat: x", repo: "o/r" }, at: 1 });
renderMini();
globalThis.__rv.store.set("review.minimized", null);
console.log("render ok");
