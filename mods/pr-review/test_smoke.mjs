// Run: node test_smoke.mjs  (a render smoke test: the review loaded the way Herdr loads it, from the analyses, findings
// files, context and diffs in demo/fixtures/review, then every tab, page, layer, card, crossing, finding and step,
// the popovers, the offers and the other parts of the mod drawn with every virtual list's rows. Also without an
// analysis, without findings, while runs are going, after they failed, and for someone else's PR. Any exception,
// sync or in a spawned task, and any null or non-finite value handed to an element fails it.)
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { S, cx as base } from "./render_stub.mjs";

// The fixtures live in the repository, not in the mod folder: a copy of mods/pr-review alone (an installed mod, a
// bundle) cannot run this test, and says so instead of failing on a missing file or passing on nothing.
const FIXTURES = new URL("../../demo/fixtures/review/", import.meta.url);
if (!existsSync(FIXTURES)) {
  console.error(`test_smoke: no fixtures at ${FIXTURES.pathname}. This test needs demo/fixtures/review of the mod's repository; run it in a checkout of the repository, not in a copy of the mod folder.`);
  process.exit(1);
}

const { default: PrReview } = await import("./main.js");
const { splitPatch, hunksOf, diffRows, hash, mapReview } = await import("./pr.js");
const { foldOnOpen, resWatch } = await import("./views.js");
const R = await import("./review.js");
const { withThreadState, addThreads, addFollowup } = await import("./threads.js");
const { mapAnswer, threadAdd, pinAdd } = await import("./explore.js");
const fx = (name) => readFileSync(new URL(name, FIXTURES), "utf8");

// cx.spawn runs the task (as Herdr does) and keeps it, to wait for; a task that throws is a failure, except for the
// stand-ins' own "stub" (no exec, no files) that the real code meets as a failed command.
const late = [];
const cx = { ...base, spawn(fn) { void (Promise.resolve().then(() => fn(cx)).catch((e) => { if (e?.message !== "stub") late.push(e?.stack ?? String(e)); })); } };
// Some tasks wait for ever (a folder watch, the next command): settle lets the others run to their end, not those.
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

let shown = 0;
// The frame: the view, then each virtual list's every row (lists inside rows join the queue).
function frame(what, draw) {
  S.errs.length = 0; S.lists.length = 0; S.clicks.clear();
  try { draw(); for (let k = 0; k < S.lists.length && k < 200; k++) S.lists[k].render({ start: 0, end: S.lists[k].n }, cx); }
  catch (e) { S.errs.push(`threw ${e?.stack ?? e}`); }
  assert.deepEqual(S.errs, [], what); shown++;
}
const draw = (v, what) => frame(what, () => v.render(cx));
const act = (v, c, what = c) => { v.command(c, cx); draw(v, `${what}`); };
// What openOverlay was asked for since the last call, each drawn as Herdr would: the mod's part with its props.
function overlays(what) {
  for (const o of S.overlays.splice(0)) {
    if (o.mod !== "pr-review") continue; // the floating agent window: a terminal block, nothing of the mod's
    S.props = { ...o.props, overlay: "ov1" }; const p = new PrReview(); p.init({}, cx);
    frame(`${what}: overlay ${o.props?.part} ${o.props?.key ?? ""}`.trim(), () => p.render(cx)); S.props = null;
  }
}
// A click on an element of the last frame, by its id (the stand-in keeps each id's on_click).
const click = (id, what) => { const h = S.clicks.get(id); assert.ok(h, `${what}: no element ${id} to click`); h({ modifiers: {}, click_count: 1 }, cx); };
// A file of the repository for the read-only view (go-to-definition, a file an exploration cites).
const FILE = Array.from({ length: 80 }, (_x, i) => (i === 8 ? "class Loan:" : i === 9 ? "    def give_back(self, on):" : `    x${i} = ${i}  # line ${i + 1}`)).join("\n");
// An exploration's saved answer, built from an analysis' own parts (explore.py writes this shape).
const exploration = (a) => ({ topic: "How does a reminder reach a member?", root: "/h/repo", repo: "saefty/corgi-demo", model: "sonnet", cost: 0.41, ms: 90000, generated: "2026-11-14T10:00:00+01:00",
  answer: { title: a.title, summary: a.summary, question: [{ text: "Where does a reminder start?", source: "existing" }, { text: "Who mails it?", source: "new" }],
    how_it_works: [{ text: "The front desk calls send_reminders.", source: "existing", evidence: "library/reminders.py:21" }, { text: "The consumer mails on each event.", source: "new", evidence: "library/consumer.py:20" }],
    architecture: a.architecture, visuals: [], steps: (a.steps ?? []).map((x, k) => ({ title: x.title, why_it_matters: x.why_it_matters ?? "", explanation: x.explanation ?? "", reading_order: k + 1,
      evidence: [...(x.evidence ?? []), "library/loans.py:9", "not a place"], flows: x.flows ?? [], visuals: x.visuals ?? [] })) } });

// The Ask drawer with answers (a card lit, evidence, an empty answer), being asked, failed, and the question sent;
// Look inside a card, failed and with its picture; go-to-definition into a file outside the diff.
async function deep(v, at) {
  const a = v.ai?.arch, key = v.deepKey();
  if (a && key) {
    const node = a.nodes?.[0]?.id, a1 = mapAnswer({ text: "It **mails** twice:\n\n- once inline\n- once in the consumer", highlights: { nodes: [node, "nope"], edges: ["e0", "e99"] },
      evidence: [{ at: "library/reminders.py:21", why: "the inline mail" }, { at: "not a place", why: "x" }] }, a);
    v.deep = { ...v.deep, threads: threadAdd(threadAdd(v.deep.threads, key, { q: "Why two mails?", about: "the map", a: a1, scope: { kind: "node", node: { id: node } }, cost: 0.04 }),
      key, { q: "And the queue?", about: "Layer 1", a: mapAnswer({ text: "" }, a), scope: { kind: "layer" } }) };
    for (const page of ["arch", "overview", "blast"]) for (const d of ["open", "fold", "open"]) { v.command(`page:${page}`, cx); act(v, `ask:${d}`, at(`${page}, Ask drawer ${d}`)); }
    v.command("page:arch", cx); v.showAnswer(a1); draw(v, at("an answer lit on the map"));
    v.page = null; v.cur = 0; draw(v, at("a layer with the Ask drawer open"));
    v.askBusy = { q: "What else?", label: "the map", started: Date.now() }; draw(v, at("Ask, being asked")); v.askBusy = null;
    v.askIn.set_value("What else?"); v.askNow(cx); await settle(); draw(v, at("Ask, the call failed"));
    v.askErr = null; v.askHl = null; act(v, "ask:close", at("Ask drawer closed"));
    for (const n of (a.nodes ?? []).slice(0, 3)) {
      v.command(`inside:${n.id}`, cx); await settle(); draw(v, at(`Look inside ${n.id}, the call failed`));
      const d = v.drillAt(`arch:${n.id}`);
      if (d) { v.deep = { ...v.deep, drills: { ...v.deep.drills, [v.drillCacheKey(d.stack)]: JSON.parse(fx("drill.json")) } }; draw(v, at(`Look inside ${n.id}, with its picture`)); }
    }
    v.drills = null; v.archFocus = null;
  }
  const wt = v.worktree; v.worktree = { url: v.prSel?.url, head: v.head, path: "/h/w" }; S.files.set("/h/w/library/loans.py", FILE);
  v.tab = "files"; v.goDef({ path: "library/loans.py", line: 9, inRoot: true }, cx); await settle(); draw(v, at("go to a definition outside the diff"));
  v.goDef({ path: "library/gone.py", line: 3, inRoot: true }, cx); await settle(); draw(v, at("a definition that cannot be opened"));
  v.defFile = null; v.worktree = wt;
}

async function open({ diff, analysis = null, findings = null, ctx = null, pr = 2, title = "feat(events): loan events", trusted = true }) {
  const url = `https://github.com/saefty/corgi-demo/pull/${pr}`, target = { url, repo: "saefty/corgi-demo", number: pr, title, base: "main", ...(trusted ? {} : { source: "repo", author: "someone" }) };
  S.store.clear(); S.files.clear(); S.props = null;
  S.store.set("review.target", target);
  if (findings) S.files.set(`/h/pr-data/findings/${hash(url)}.json`, findings);
  const v = new PrReview(); v.init({}, cx);
  v.prSel = target; v.patch = splitPatch(diff);
  await v.applyResume(cx); assert.equal(v.resumed, url, "where you were is read: frames are no longer held");
  v.hunks = hunksOf(v.patch).map((h) => ({ ...h, rows: diffRows(h.lines) }));
  v.byId = new Map(v.hunks.map((h) => [h.id, h])); v.fileHunks = new Map();
  for (const h of v.hunks) v.fileHunks.set(h.path, [...(v.fileHunks.get(h.path) ?? []), h]);
  v.collapsed = new Set(foldOnOpen(v.patch));
  v.ctx = ctx ? JSON.parse(ctx) : null; v.head = v.ctx?.head ?? null;
  await v.loadFindings(cx);
  if (analysis) v.ai = v.mapSaved(JSON.parse(analysis), true);
  v.securityNow(cx); v.publish();
  await settle();
  return v;
}

// Everything one review shows.
async function tour(v, name) {
  const at = (x) => `${name}: ${x}`;
  for (const tab of ["files", "steps", "comments", "findings"]) act(v, tab, at(`tab ${tab}`));
  // A comment written at a line: the composer, then a pending comment in the diff, the Comments tab and Finish.
  const line = v.hunks[0] && `${v.hunks[0].path}:${v.hunks[0].rows.find((r) => r.kind === "+")?.n ?? 1}`;
  // GitHub's comments on that line: Markdown, a suggestion, a reply, a bot, an outdated one, a resolved thread.
  if (line) {
    const [path, n] = [line.slice(0, line.lastIndexOf(":")), Number(line.slice(line.lastIndexOf(":") + 1))];
    const g = (id, user, body, extra = {}) => ({ id, path, line: n, side: "RIGHT", user, user_type: user.endsWith("[bot]") ? "Bot" : "User", at: `2026-11-1${id % 10}T10:00:00Z`, commit_id: "c1", body, ...extra });
    v.gh = withThreadState([g(1, "anna", "**Why** this?\n\n```suggestion\nx = 1\n```\n\n- a\n- [link](https://example.org)"), g(2, "bob", "> quoted\n\nagreed `code`", { in_reply_to_id: 1 }),
      g(3, "lint[bot]", "<details><summary>Lint</summary>\n\n| a | b |\n|---|---|\n| 1 | 2 |\n</details>"), g(4, "carol", "old", { line: null, original_line: 2, outdated: true })], [{ id: 1, resolved: true, outdated: false }]);
    act(v, "comments", at("Comments with GitHub's threads")); v.showResolved = true; v.allBots = true; act(v, "files", at("files with GitHub's threads")); act(v, "comments", at("Comments, resolved and bots shown"));
  }
  if (line) { act(v, `comment:${line}`, at("composer open")); act(v, "draft:Why this?", at("composer with text")); act(v, "add", at("a pending comment")); assert.ok(v.comments.length > 0, at("the comment was added")); act(v, "comments", at("Comments with a pending comment")); act(v, "files", at("files again")); }
  // Two more comments on that line sent to an agent (one answered and followed up, one reported fixed: folded to a
  // line), and an Ask answer pinned to it: their cards in the diff and on the Comments tab.
  if (line && v.comments[0]) {
    const c = v.comments[0], key = v.threadKey(), how = { route: "agent", agent: "claude · pane 2" };
    v.threadDoc = addFollowup(addThreads(v.threadDoc, key, [{ ...c, id: "t1", text: "Why **this**?" }, { ...c, id: "t2", text: "Rename it" }], how), key, "t1", "And the caller?", 1);
    v.replies = { t1: [{ reply: "Because of `x`.", status: "answered", commit: null }, { reply: "The caller is fine.", status: "question", commit: null }], t2: [{ reply: "Renamed.", status: "fixed", commit: "abc1234def" }] };
    v.deep = { ...v.deep, pins: pinAdd(v.deep.pins, v.deepKey(), { q: "What reads this?", at: 1, a: { text: "The consumer reads it.\n\nIt mails **once** per event.", evidence: [{ at: line, why: "here" }] },
      scope: { kind: "range", range: { file: c.file, start: c.start, end: c.end, old: Boolean(c.old) } } }) };
    act(v, "files", at("files with a sent thread, a fixed one and a note")); act(v, "comments", at("Comments with sent threads")); v.command("files", cx);
  }
  // The pages, with their folds and rows clicked.
  for (const p of ["overview", "blast", "arch", "res"]) act(v, `page:${p}`, at(`page ${p}`));
  // Resilience: every path opened (its picture and probe), all paths, the clean checks, a probe's script, and none open.
  v.command("page:res", cx);
  for (const p of v.resNow()?.paths ?? []) act(v, `res-path:${p.id}`, at(`Resilience, path ${p.id}`));
  for (const c of ["res-more", "res-clean", "res-add", ...v.probeList().map((p) => `res-probe-open:${p.id}`), "res-path:"]) act(v, c, at(`Resilience, ${c}`));
  v.command("page:overview", cx); v.rulesOpen = true; draw(v, at("Overview, rules open"));
  for (const a of [...(v.ai?.asks ?? []).map((x) => x.id), "other", "crit", "extra", "nc", "bm-all"]) act(v, `criterion:${a}`, at(`Overview, criterion ${a}`));
  // The bar: the verdict's excerpt stands in for the Overview's verdict line, so not beside it; the diff's switches
  // (what shows under the lines, one or two columns, line wrap) only beside a diff.
  act(v, "page:overview", at("Overview, the bar")); assert.ok(!S.clicks.has("rv-mr") && !S.clicks.has("rv-diffmode"), at("no excerpt and no diff switches beside the Overview"));
  act(v, "page:arch", at("Architecture, the bar")); assert.ok(S.clicks.has("rv-mr") === v.verdictNow().length > 0 && !S.clicks.has("rv-diffmode"), at("the excerpt beside another page, no diff switches"));
  act(v, "files", at("files, the bar")); assert.ok(S.clicks.has("rv-diffmode") && S.clicks.has("rv-wrap"), at("the diff's switches beside the diff")); v.command("steps", cx);
  v.command("page:blast", cx);
  for (const k of ["quiet", "unchanged", ...(v.ai?.access ?? []).map((x) => `a:${x.id}`), ...(v.ai?.arch?.edges ?? []).map((_e, k) => `e:${k}`)]) act(v, `cross:${k}`, at(`Security, crossing ${k}`));
  for (const n of v.ai?.arch?.nodes ?? []) act(v, `sec-card:${n.id}`, at(`Security, card ${n.id}`));
  for (const k of [...(v.ai?.scope?.checked ?? []).map((x) => x.area), "run:claude", "run:security"]) act(v, `scope-row:${k}`, at(`Security, scope row ${k}`));
  v.command("page:arch", cx);
  for (const m of ["before", "after", "diff"]) act(v, `arch-view:${m}`, at(`Architecture, ${m}`));
  for (const n of v.ai?.arch?.nodes ?? []) act(v, `card:${n.id}`, at(`Architecture, card ${n.id}`));
  act(v, "card:", at("Architecture, no card")); act(v, "arch-fit", at("Architecture, fit")); act(v, "arch-wrap", at("Architecture, wrap")); act(v, "arch-wrap", at("Architecture, unwrap"));
  // Each layer, in both orders, with its pictures folded and open.
  for (const order of ["risk", "reading"]) {
    v.command(`order:${order}`, cx); v.page = null;
    v.steps().forEach((s, k) => {
      act(v, `step:${k}`, at(`layer ${k} (${order})`));
      (s.visuals ?? []).forEach((_x, j) => { act(v, `vis:vis|${k}|${j}`, at(`layer ${k}, picture ${j} toggled`)); v.command(`vis:vis|${k}|${j}`, cx); });
    });
  }
  // Each finding open, each of its steps' details, its card in the diff folded and open.
  v.command("findings", cx);
  for (const f of v.findings()) {
    act(v, `finding:${f.id}`, at(`finding ${f.id}`));
    for (const k of ["reported", "evidence", "sent", "verified", "in_pr"]) { v.fstep = { id: f.id, key: k }; draw(v, at(`finding ${f.id}, step ${k}`)); }
    v.fstep = null;
  }
  // The order is a switch of two (Severity | Quickest fix), offered once a finding says how much work its fix is.
  act(v, "findings-sort:quick", at("findings, quickest fix first")); assert.equal(S.clicks.has("rv-fsort-quick"), v.findings().some((f) => f.effort), at("the order switch is there with efforts only"));
  act(v, "findings-sort:", at("findings, by severity"));
  v.tab = "files";
  for (const f of v.findings()) act(v, `finding-card:${f.id}`, at(`files, card ${f.id} toggled`));
  v.fopen = null;
  // The popovers: Finish your review (verdicts, the approval asked about), a fix's and a verify agent's previews.
  act(v, "finish", at("Finish open"));
  for (const k of ["approve", "request_changes", "comment"]) act(v, `verdict:${k}`, at(`Finish, ${k}`));
  v.command("verdict:approve", cx); v.approveAsk = true; draw(v, at("Finish, approval asked about")); v.approveAsk = false;
  act(v, "finish", at("Finish closed"));
  const f = v.findings()[0];
  if (f) {
    for (const c of [`fix-finding:${f.id}`, `discuss:${f.id}`, `verify-agent:${f.id}`, "fix-several"]) {
      v.command(c, cx); await settle(); draw(v, at(`preview of ${c}`)); v.sendP = null;
    }
  }
  // The mod's other parts, on what this review published.
  for (const part of ["bar", "reviews", "agentbar", "keys", "cmenu", "mini"]) {
    S.props = { part }; const p = new PrReview(); p.init({}, cx); frame(at(`part ${part}`), () => p.render(cx)); S.props = null;
  }
  for (const r of [R.renderReviews, R.renderAgentBar, R.renderKeys, R.renderCardMenu, R.renderMini]) frame(at(r.name), () => r());
  // The popups the header opens: Run review, the keys, Codex's models, ⋯ and the model menu.
  S.overlays.length = 0;
  for (const c of ["reviews", "keys", "codex-menu"]) v.command(c, cx);
  v.tab = "files"; v.page = null; draw(v, at("the header"));
  for (const id of ["rv-more", "rv-model"]) click(id, at(id));
  overlays(at("popups"));
  // A comment card's ⋯ in the diff (the sent threads, the note, the pending comment): its menu as a popup, then each
  // of its items picked (pr-review.cmenu:<index>|<card>).
  for (const [k, obj] of [...v.threads().map((x) => ["th", x]), ...v.pins().map((x) => ["pin", x]), ...v.comments.slice(0, 1).map((x) => ["c", x])]) {
    const it = { t: "ch", k, obj }, x = v.cardZones(v.cardOf(it)).menu[0];
    v.tab = "files";
    if (v.cardOf(it).folded) { v.cardClick(it, x, cx); draw(v, at(`card ${k}:${obj.id}, unfolded by a click`)); } // a fixed thread is one line until clicked
    const c = v.cardOf(it); v.cardClick(it, x, cx);
    assert.equal(S.overlays.length, 1, at(`card ${c.key}: ⋯ opens its menu`)); overlays(at(`card ${c.key} ⋯`));
    for (let i = 0; i < c.menu.length; i++) {
      v.command(`cmenu:${i}|${c.key}`, cx); await settle(); draw(v, at(`card ${c.key}, ${c.menu[i][0]}`));
      v.sendP = null; v.replyTo = null; if (v.composing) v.closeComposer(cx);
    }
  }
  // A probe of the resilience run asks before it starts on this machine (no sandbox here): the question, then no.
  // (A probe shows in its path, open: the path that names it, or the one it is of.)
  for (const p of v.probeList().slice(0, 2)) {
    const path = (v.resNow()?.paths ?? []).find((x) => x.probe === p.id || x.id === p.of);
    v.command(`probe:${p.id}`, cx); await settle(); v.command("page:res", cx); if (path) v.command(`res-path:${path.id}`, cx);
    draw(v, at(`probe ${p.id} asks first`)); act(v, `probe:${p.id}:no`, at(`probe ${p.id}, not started`)); v.command("res-path:", cx);
  }
  await deep(v, at);
  await settle();
}

const PR2 = { diff: fx("pr2.diff"), ctx: fx("ctx.json") };
const pairs = [["analysis.json", "findings.json"], ["analysis-split.json", "findings-split.json"], ["analysis-zones.json", "findings.json"], ["analysis-md.json", "findings-md.json"],
  ["analysis-s.json", "findings-s.json"], ["analysis-w4.json", "findings-w4.json"]];
for (const [a, f] of pairs) await tour(await open({ ...PR2, analysis: fx(a), findings: fx(f) }), `PR #2 ${a} + ${f}`);
await tour(await open({ diff: fx("pr1.diff"), analysis: fx("analysis-pr1.json"), pr: 1, title: "feat(reminders): due-date reminders" }), "PR #1 without findings or context");
await tour(await open({ ...PR2, findings: fx("findings-split.json") }), "PR #2 without an analysis");
await tour(await open({ ...PR2 }), "PR #2 with nothing yet");

// Runs going: the analysis and every reviewer.
{
  const doc = JSON.parse(fx("findings-split.json")), now = new Date().toISOString();
  for (const k of ["claude", "security", "codex"]) doc.runs[k] = { state: "running", busy: true, started: now };
  const v = await open({ ...PR2, analysis: fx("analysis-split.json"), findings: JSON.stringify(doc) });
  v.aiBusy = { model: "sonnet", started: Date.now(), status: "/h/s" }; v.verifyBusy = { started: Date.now(), n: 2 };
  await tour(v, "PR #2 with every run going");
}
// Runs failed: the analysis and every reviewer, a verification that said not fixed.
{
  const doc = JSON.parse(fx("findings-split.json")), at = new Date().toISOString(), id = doc.findings[0].id;
  for (const k of ["claude", "security", "codex"]) doc.runs[k] = { state: "failed", error: "Stopped without a result", at };
  doc.status = { ...doc.status, [id]: { s: "progress", fixHead: "abc", verify: { result: "not_fixed", reason: "still there", head: "def", branch: "fix/2-x" } } };
  const v = await open({ ...PR2, analysis: fx("analysis-split.json"), findings: JSON.stringify(doc) });
  v.aiError = "The model gave no answer";
  await tour(v, "PR #2 after every run failed");
  v.ai = null; await tour(v, "PR #2, the analysis failed and none is shown");
}
// The Resilience run's block: read, on another head (stale), running, failed, and on someone else's PR (a probe asks first).
{
  const res = JSON.parse(fx("resilience-view.json")), doc = JSON.parse(fx("findings-s.json"));
  await tour(await open({ ...PR2, analysis: fx("analysis-s.json"), findings: JSON.stringify({ ...doc, resilience: res }) }), "PR #2 with its resilience paths");
  await tour(await open({ ...PR2, analysis: fx("analysis-s.json"), findings: JSON.stringify({ ...doc, resilience: { ...res, head: "0000000aaaa" } }) }), "PR #2, resilience of an older head");
  await tour(await open({ ...PR2, analysis: fx("analysis-s.json"), findings: JSON.stringify({ ...doc, resilience: { ...res, paths: res.paths.map((p) => ({ ...p, blocker: null, result: "mitigated", limited_by: "template.yaml:11" })) } }) }), "PR #2, every path limited");
  for (const state of ["running", "failed"]) await tour(await open({ ...PR2, analysis: fx("analysis-s.json"), findings: JSON.stringify({ ...doc, runs: { ...doc.runs, resilience: { state, busy: state === "running", error: "Stopped", at: new Date().toISOString() } } }) }), `PR #2, resilience ${state}`);
  await tour(await open({ ...PR2, analysis: fx("analysis-s.json"), findings: JSON.stringify({ ...doc, resilience: res }), trusted: false }), "someone else's PR with resilience paths");
  // Wave R2: signal and seen_as, a base not comparable, blind spots and calls for the watch list, a doubled effect, a
  // tool text to leave out, a race without on-call words, a probe that never ran and one with an unknown base.
  const r2 = { ...res, not_checked: [...(res.not_checked ?? []), "Runtime behaviour: nothing was executed, because Bash was denied"],
    blind_spots: [{ failure: "Mail transport failure is not visible", at: "library/mailer.py:19", signal: "none", alarm: "none" }, { failure: "Queue age is not monitored", at: "template.yaml:11", signal: "platform_only", alarm: "none" }],
    deps: [{ edge: "e6", at: "template.yaml:32", mode: "async" }], effects: [{ kind: "mail", node: "reminders" }, { kind: "mail", node: "consumer" }],
    paths: res.paths.map((p, k) => ({ ...p, signal: k % 2 ? "none" : "log", seen_as: "Lambda errors in the log", pre_existing: k === 0 ? "unknown" : p.pre_existing, failing: [...(p.failing ?? []), "duplicate_effect", "poison_message"],
      race: p.race ? { ...p.race, oncall: undefined } : p.race, kind: k === 2 ? "timeout" : p.kind, budget: k === 2 ? null : p.budget, ladder: k === 2 ? [] : p.ladder })) };
  const v2 = await open({ ...PR2, analysis: fx("analysis-s.json"), findings: JSON.stringify({ ...doc, resilience: r2 }) });
  v2.deep = { ...v2.deep, probes: { [v2.probeKey("pr1")]: { state: "done", status: "script_failed", line: "The agent ended without running the probe.", ms: 0, head: null },
    [v2.probeKey("pr2")]: { state: "done", status: "reproduced", line: "handled 1, no mail", ms: 1100, head: "ccddf95", base: { status: "unknown", line: "TypeError" }, pre_existing: "unknown", network_barrier: true, sandbox: "sandbox-exec" } } };
  await tour(v2, "PR #2, resilience with signals, blind spots and probes not run");
  const w = v2.resNow() && resWatch(v2.resNow(), v2.ai?.arch);
  assert.equal(w.before.length, 1, "a blind spot without any signal goes before the merge");
  assert.ok(!v2.mergeRows().some((r) => /Bash was denied/.test(r.title)) && v2.verdictNow().some((p) => p.key === "resilience"), "the Overview names the resilience blockers");
  // A real run with the R2 schema (deps bound to the map, signal, unseen and watch, same cause, an unclear blocker,
  // state with its rule, a race not possible today), a probe done with its base verdict.
  const r3 = JSON.parse(fx("resilience-r2.json")), v3 = await open({ ...PR2, analysis: fx("analysis-s.json"), findings: JSON.stringify({ ...doc, resilience: r3 }) });
  v3.deep = { ...v3.deep, probes: { [v3.probeKey("r1")]: { state: "done", status: "reproduced", line: "handled=1, no mail", ms: 1100, head: "ccddf95", base: { status: "script_failed", verdict: "new_in_pr", line: "ImportError" }, pre_existing: false, network_barrier: true, sandbox: "sandbox-exec" } } };
  assert.ok((v3.resNow()?.unseen ?? []).length > 0 && v3.resNow().paths.some((p) => p.same_cause), "unseen and one cause blocking once come from the data");
  await tour(v3, "PR #2, a real resilience run with the R2 schema");
  // The picture "Timing": a click on a row's words opens the path that shows it, a click on a row shows its line, its
  // head folds it; a run from before the pauses came in seconds draws its retries open and offers a new run.
  {
    act(v3, "page:res", "Resilience with its timing"); const over = (await import("./timeline.js")).timelineOf(v3.resNow(), v3.ai?.arch).groups[0];
    assert.equal(over.verdict.kind, "over", "the batch over its function's timeout comes first");
    click("rv-res-tl-g0-r2-v", "the mark of the batch over its timeout"); assert.equal(v3.resOpen, over.path, "the mark opens the path that shows it");
    draw(v3, "after the mark"); click("rv-res-tl-g1-r1", "a retry's row"); draw(v3, "after a row of the timing");
    assert.ok(!S.clicks.has("rv-res-time-rerun"), "a run with the pauses in seconds offers no new run there");
    act(v3, "res-time", "the timing folded"); assert.ok(v3.pageParts.includes("timing") && !S.clicks.has("rv-res-tl-g0-r2-v"), "folded: its head stays, the picture goes");
    const old = { ...r3, deps: r3.deps.map((d) => (d.retry ? { ...d, retry: { ...d.retry, backoff_s: undefined } } : d)) };
    const v5 = await open({ ...PR2, analysis: fx("analysis-s.json"), findings: JSON.stringify({ ...doc, resilience: old }) });
    act(v5, "page:res", "the timing of a run without seconds for its pauses"); assert.ok(S.clicks.has("rv-res-time-rerun"), "the older run offers a new one");
    const none = await open({ ...PR2, analysis: fx("analysis-s.json"), findings: JSON.stringify({ ...doc, resilience: { ...r3, deps: [] } }) });
    act(none, "page:res", "a run without calls"); assert.ok(!none.pageParts.includes("timing"), "no numbers, no picture");
  }
  // Dependencies that fail or are overloaded: a row each under the map; a click on a case opens the path that shows
  // how it spreads and marks the dependency on the map; a run without them (the one above) draws no such rows.
  assert.ok(!S.clicks.has("rv-res-dep-0-slow"), "no rows without dependencies");
  const ps = r3.paths.map((p) => p.id), dn = [{ dep: "Mailer", kind: "external", node: "mailer", edge: null, at: "library/mailer.py:14", mode: "sync", cases: [
    { when: "slow", at: "library/mailer.py:16", handled: "no", how: "waits up to 7 s of the 10 s request", effect: "The request hangs.", path: ps.at(-1), findings: [] },
    { when: "down", at: "library/mailer.py:19", handled: "yes", how: "fails fast", effect: "", path: null, findings: [] }, { when: "overloaded", at: "library/mailer.py:17", handled: "partly", how: "", effect: "", path: "nope", findings: [] },
    { when: "recovers", at: null, handled: "not_checkable", how: "", effect: "", path: null, findings: [] }] }];
  for (const head of [r3.head, "0000000aaaa"]) {
    const v4 = await open({ ...PR2, analysis: fx("analysis-s.json"), findings: JSON.stringify({ ...doc, resilience: { ...r3, head, downstream: dn } }) });
    act(v4, "page:res", "Resilience with dependencies"); click("rv-res-dep-0-slow", "a dependency's case"); draw(v4, "the path of a dependency's case, open");
    assert.equal(v4.resOpen, ps.at(-1), "the case opens its path");
    assert.ok(v4.pageParts.includes(`p:${ps.at(-1)}`), "its path is a part of the page, also one under \"n more\", so the click can scroll to it");
    assert.ok(v4.resNow().paths.find((p) => p.id === ps.at(-1)).marks.some((m) => m.at === "mailer" && m.mark === "✕ when slow"), "and the map marks the dependency");
    for (const id of ["rv-res-dep-0-down", "rv-res-dep-at-0"]) { click(id, "a dependency's line"); draw(v4, `after ${id}`); }
    assert.match((await import("./markdown.js")).resilienceMd({ pr: {}, head: v4.head, res: v4.resNow(), arch: v4.ai?.arch }), /## When a dependency fails \(\d+\)\n\n- Mailer/, "the export has the dependencies");
  }
}
// The analysis read again after the findings file (a reload of the mod reads them in either order; Refresh diagrams
// reads the analysis again): the resilience block is derived on the new analysis too, never the raw block.
{
  const doc = JSON.parse(fx("findings-s.json")), v = await open({ ...PR2, analysis: fx("analysis-s.json"), findings: JSON.stringify(doc) });
  assert.ok(v.ai.resilience?.summary && v.resNow().downstreamLine, "derived on open");
  const { reviewRequest } = await import("./pr.js");
  const job = reviewRequest({ url: v.prSel.url, pr: v.prSel.url, worktree: null, files: v.patch, hunks: v.hunks, model: v.aiModel ?? "sonnet", context: v.ctxReq(), dir: "/h/pr-data/cache" });
  S.files.set(job.latest, fx("analysis-s.json"));
  v.loadAi(cx, "cache"); await settle();
  assert.ok(v.ai?.arch && v.ai.resilience?.summary && v.resNow().downstreamLine, "still derived after the analysis was read again");
  draw(v, "after the analysis was read again");
}
// The Security page with what a webhook PR adds to it: a deny rule (a guard), a right on something off the map, an
// operator's script whose row and call are one way, two derived operator ways that say the same, a finding that only
// a threat makes part of the page.
{
  const doc = JSON.parse(fx("findings-s.json")), sec = doc.security, row = (id, more) => ({ id, public: false, auth_kind: "iam", change: "added", principal_kind: "role", at: "template.yaml:30", ...more });
  sec.access.push(row("acc5", { resource: "QueuePolicy", kind: "queue", principal: "everyone but the FrontDesk role", principal_node: null, node: "queue", actions: ["deny sqs:SendMessage"], auth: "resource policy" }),
    row("acc6", { resource: "FrontDesk logs", kind: "log group", principal: "FrontDesk function", principal_node: "g_fd", actions: ["logs:PutLogEvents"] }),
    row("acc7", { resource: "replay.sh", kind: "script", principal: "operator with queue credentials", principal_node: null, principal_kind: "operator", node: "events", actions: ["sqs:SendMessage"] }),
    row("acc8", { resource: "configuration", principal: "operator who deploys handler", principal_node: null, principal_kind: "operator", node: "handler", actions: ["set configuration"], change: "unchanged", derived: true, from_gate: 0, value_from: null }),
    row("acc9", { resource: "configuration", principal: "operator who deploys handler", principal_node: null, principal_kind: "operator", node: "handler", actions: ["set configuration"], change: "unchanged", derived: true, from_gate: 0, value_from: null }));
  sec.threats.push({ id: "t8", where: { access: "acc5" }, boundary: "Account → queue", threat: "Another principal sends to the queue.", stride: "S", findings: [], result: "mitigated", goal: "Forged events.", path: ["queue"], evidence: "template.yaml:30", note: "" });
  const v = await open({ ...PR2, analysis: fx("analysis-s.json"), findings: JSON.stringify(doc) });
  const { asideOf, crossingsOf } = await import("./views.js"), data = { arch: v.ai.arch, access: v.ai.access, threats: v.ai.threats, gates: v.ai.gates, bypasses: v.ai.bypasses, findings: v.openFindings() };
  const aside = asideOf(data), rows = crossingsOf(data);
  assert.deepEqual([aside.guards.length, aside.rights.length, rows.filter((r) => r.kind === "operator" && r.derived).length, rows.some((r) => r.key === "a:acc5" || r.key === "a:acc6")], [1, 1, 2, false],
    "one guard and one right off the map under the crossings, and the two same operator rows as one (next to the fixture's own)");
  act(v, "page:blast", "Security with a guard");
  await tour(v, "PR #2 with a guard, a right off the map and an operator's script");
}
// Someone else's PR with reasons for a security review: the offers instead of a start.
{
  const ctx = { ...JSON.parse(fx("ctx.json")), security_trigger: { run: true, reasons: [{ text: "New route /remind" }, { text: "Token check changed" }] } };
  const doc = JSON.parse(fx("findings.json")); delete doc.runs.security;
  const v = await open({ ...PR2, ctx: JSON.stringify(ctx), analysis: fx("analysis-split.json"), findings: JSON.stringify(doc), trusted: false });
  await tour(v, "someone else's PR, security offered");
  // Its checkout made: the trust question with everything trusting turns on.
  v.worktree = { url: v.prSel.url, head: v.head, path: "/h/w" }; v.repoVis = { [v.prSel.repo]: "PUBLIC" };
  for (const tab of ["files", "steps", "findings"]) act(v, tab, `someone else's PR, the trust question on ${tab}`);
  click("rv-trust-no", "stay in Restricted Mode"); draw(v, "someone else's PR, Restricted Mode kept");
  S.store.set("pr-review.trustAsked", []); draw(v, "the trust question again"); click("rv-trust-pr", "trust this PR"); draw(v, "someone else's PR, trusted");
}
// Explore: the start (no repo, no topic), then an exploration with its answer, its pages, layers and cards, the
// Ask drawer and Look inside on it, and a cited file opened; then back to the review.
{
  const v = await open({ ...PR2, analysis: fx("analysis-split.json"), findings: fx("findings-split.json") });
  const saved = exploration(JSON.parse(fx("analysis-split.json")).answer), id = "x1";
  S.files.set(`/h/pr-data/explore/${id}.json`, JSON.stringify(saved));
  S.files.set("/h/pr-data/explore/index.json", JSON.stringify([{ id, topic: saved.topic, root: saved.root, repo: saved.repo, model: "sonnet", at: 1 }, { id: "gone", topic: "Gone", root: "/h/x", at: 0 }]));
  S.store.set("review.explore", { start: true, at: 2, root: "/h/repo" });
  draw(v, "Explore: the start"); await v.loadExploreIndex(cx); draw(v, "Explore: the start with earlier explorations");
  act(v, "explore-open:gone", "Explore: an exploration that is gone"); await settle(); draw(v, "Explore: gone, said");
  v.command(`explore-open:${id}`, cx); await settle();
  assert.ok(v.ai?.explore, "the exploration is shown");
  for (const p of ["overview", "arch"]) act(v, `page:${p}`, `Explore: page ${p}`);
  for (const n of v.ai.arch?.nodes ?? []) act(v, `card:${n.id}`, `Explore: card ${n.id}`);
  v.steps().forEach((_s, k) => act(v, `step:${k}`, `Explore: layer ${k}`));
  v.exBusy = { id: "x2", topic: "Next?", model: "sonnet", started: Date.now() }; draw(v, "Explore: one running"); v.exBusy = null;
  v.exErr = "The model gave no answer"; draw(v, "Explore: one failed"); v.exErr = null;
  await deep(v, (x) => `Explore: ${x}`);
  S.files.set("/h/repo/library/loans.py", FILE); v.openExploreFile("library/loans.py", 9, cx); await settle(); draw(v, "Explore: a cited file open");
  v.defFile = null; S.store.set("review.explore", null); v.leaveExplore(); draw(v, "back to the review");
}
// The PR panel (main.js without a part): each source's list with its groups, In progress, a chosen PR, the minimized
// chip, and a switch of Herdr space (a PR picked in one space is not shown in the next).
{
  S.store.clear(); S.files.clear(); S.props = {};
  const now = Date.now(), iso = (d) => new Date(now - d * 86400000).toISOString();
  const pr = (n, repo, state, d) => ({ url: `https://github.com/${repo}/pull/${n}`, repo, number: n, title: `PR ${n}`, state, updatedAt: iso(d), at: iso(d),
    session: "s1234567", sessionTitle: "a session", head: "feat/x", headSha: "abc", base: "main" });
  const prs = [pr(2, "saefty/corgi-demo", "open", 1), pr(9, "o/else", "open", 1), pr(5, "saefty/corgi-demo", "draft", 40), pr(1, "saefty/corgi-demo", "merged", 2), pr(3, "o/else", "closed", 30)];
  S.files.set("/h/pr-data/prs.json", JSON.stringify({ generated: new Date().toISOString(), prs }));
  const reg = (p, progress, lastTouched = now) => ({ url: p.url, repo: p.repo, number: p.number, title: p.title, status: "in-progress", lastTouched, progress, target: p });
  S.store.set("review.open", [reg(prs[0], { filesViewed: 2, files: 9 }), reg(prs[1], { files: 3 }), reg(prs[3], { stepsChecked: 1 })]);
  S.store.set("review.minimized", { target: prs[3], at: now });
  S.spaces = [{ id: "sA", active: true, folder: "/h/a" }];
  const v = new PrReview(); v.init({}, cx); await settle();
  v.spaceSlug = { root: "/h/a", slug: "saefty/corgi-demo" };
  assert.deepEqual(v.panelProgress().shown.map((r) => r.number), [2], "In progress: work done and not merged; one only opened is not there");
  assert.deepEqual(v.panelProgress().left.map((r) => [r.number, r.state]), [[1, "merged"]], "the merged one is listed apart, dimmed");
  assert.equal(S.store.get("review.minimized"), null, "the chip of a merged PR goes");
  for (const src of ["mine", "repo", "space", "review"]) { S.store.set("pr.source", src); v.picking = true; draw(v, `panel: the ${src} list`); }
  // This space: rows with their branch, the focused pane's PR marked and first, a merged one with its word; and empty.
  { S.store.set("pr.source", "space");
    const row = (n, head, state) => ({ ...pr(n, "saefty/corgi-demo", state, 1), head, author: "me", add: 3, del: 1, review: null, source: "space", session: null, cwd: "/h/a" });
    v.srcLists.space = { key: "space:x", at: now, prs: [row(21, "feat/x", "open"), row(22, "fix/1", "open"), row(20, "fix/1", "merged")] };
    v.spaceHeads = new Map([["/h/a", { cwd: "/h/a", slug: "saefty/corgi-demo", branch: "fix/1" }]]);
    draw(v, "panel: This space with the focused agent's PR"); assert.deepEqual(v.listNow().map((p) => p.number), [21, 22, 20]);
    v.srcLists.space = { key: null, prs: [], why: "Every checkout in this space is on its default branch, so there is no branch to look up a PR for." }; draw(v, "panel: This space, nothing to list");
    v.srcLists.space = { key: "space:x", prs: [], loading: true }; draw(v, "panel: This space, asking GitHub"); v.srcLists.space = { key: "space:x", prs: [], error: "gh: no network" }; draw(v, "panel: This space, gh failed");
    v.panelCommand("source:space", cx); assert.equal(S.store.get("pr.sourceBy")?.sA, "space", "source:space picks it for this space"); S.store.set("pr.sourceBy", null); }
  S.store.set("pr.source", "mine"); v.showOther = v.showDone = true; draw(v, "panel: Mine with the other repos and the merged ones unfolded");
  v.choose(prs[0], cx); await settle(); draw(v, "panel: PR #2 chosen");
  assert.equal(S.store.get("pr.selected")["all@sA"], prs[0].url);
  S.spaces = [{ id: "sB", active: true, folder: "/h/b" }];
  draw(v, "panel: the frame a space switch starts"); v.onSpace(cx); await settle(); draw(v, "panel: another space");
  assert.equal(v.prSel, null, "another space shows its own pick (none yet: the list), not the PR from the first one");
  S.spaces = [{ id: "sA", active: true, folder: "/h/a" }]; v.onSpace(cx);
  assert.equal(v.prSel?.url, prs[0].url, "back in the first space: its pick again");
  // In progress: the other repo's review and one not touched for 20 days wait behind "Show all", the merged one is
  // dimmed with its state; ✕ removes one (its minimized chip too) and offers Undo, which puts it back.
  S.store.set("review.open", [reg(prs[0], { filesViewed: 2, files: 9, comments: 1 }), reg(prs[1], { filesViewed: 1 }, now - 1000), reg(prs[3], { stepsChecked: 1 }, now - 2000), reg(prs[2], { comments: 2 }, now - 20 * 86400000)]);
  S.store.set("review.minimized", { target: prs[0], at: now });
  v.spaceSlug = { root: "/h/a", slug: "saefty/corgi-demo" }; v.picking = true; draw(v, "panel: In progress with more behind Show all");
  assert.deepEqual([v.panelProgress().shown.map((r) => r.number), v.panelProgress().more], [[2], 2]);
  v.allOpen = true; draw(v, "panel: In progress, all shown");
  // A review listed a moment ago whose PR is merged now: the line that says so, once.
  { const before = S.store.get("review.open"), merged = { ...prs[0], state: "merged" }; v.prs = [merged, ...v.prs.slice(1)]; draw(v, "panel: a review left In progress, said in a line");
    assert.equal(v.leftNote, "#2 left In progress: its PR was merged."); v.prs = prs; v.leftNote = null; S.store.set("review.open", before); draw(v, "panel: In progress again"); }
  assert.deepEqual(v.panelProgress().shown.map((r) => r.number), [2, 5, 9], "all: this repo's first, then the other repo's");
  v.dropReview(prs[0].url, cx); await settle(); draw(v, "panel: a review removed, Undo offered");
  assert.ok(!S.store.get("review.open").some((r) => r.number === 2) && S.store.get("review.minimized") === null && v.undo?.number === 2, "✕ takes the review and its chip away and keeps it for Undo");
  v.undoDrop(cx); await settle(); draw(v, "panel: the removal undone");
  assert.deepEqual([S.store.get("review.open")[0].number, v.undo], [2, null], "Undo puts it back");
  v.allOpen = false;
  // A chosen PR with its diff: a line picked (the composer), a comment added, edited, a whole-file one, the pending
  // bar; Walkthrough without and with an analysis; Setup; a diff that did not come; a note.
  S.exec = async (cmd, args) => (cmd === "gh" && args[1] === "diff" ? { code: 0, stdout: fx("pr2.diff"), stderr: "" } : { code: 1, stdout: "", stderr: "stub" });
  v.memo.clear(); v.context = null; v.choose(prs[0], cx); await settle(); draw(v, "panel: PR #2 with its diff");
  assert.ok(v.files.length > 1 && v.rows.length > 0 && !v.error, "the diff is shown");
  v.panelCommand("wrap:on", cx); v.panelH = 900; draw(v, "panel: long lines wrapped, the file list up to 40 % high"); v.panelCommand("wrap:off", cx);
  v.sel = v.rows.findIndex((r) => r.kind === "+"); draw(v, "panel: a line picked, the composer under it");
  v.selEnd = v.sel + 2; v.question = "Why this?"; v.addComment(cx); await settle(); draw(v, "panel: a pending comment and the bar");
  assert.equal(v.comments.length, 1, "the comment was added");
  v.editComment(v.comments[0], cx); draw(v, "panel: the comment being edited"); v.cancel(cx);
  v.panelCommand("discard", cx); draw(v, "panel: Discard asked about"); assert.equal(v.comments.length, 1); v.discardAsk = false;
  // What the review knows, on the files and next to the diff's size.
  S.files.set(`/h/pr-data/findings/${hash(prs[0].url)}.json`, JSON.stringify({ findings: [{ id: "f1", file: v.files[0].path, line: 1, severity: "high", category: "security", title: "t" }, { id: "f2", file: v.files[1].path, line: 2, severity: "low", title: "u" }], status: {} }));
  await v.loadMarks(prs[0].url); draw(v, "panel: findings marked on the files");
  assert.deepEqual([v.fileMarks.get(v.files[0].path)?.top, v.risk.get(prs[0].url)?.open], ["high", 2], "the files and the PR carry the review's findings");
  v.askTop = true; draw(v, "panel: a comment on the whole file"); v.askTop = false;
  v.pick(v.files[1].path, cx); await settle(); draw(v, "panel: another file");
  v.openWalk(cx, false); await settle(); draw(v, "panel: Walkthrough without an analysis");
  {
    const saved = JSON.parse(fx("analysis.json")), hunks = hunksOf(v.patch), at = new Map(hunks.map((h) => [h.id, h])), r = mapReview(saved.answer, saved.hunks.map((h) => ({ ...h, ...(at.get(h.id) ?? {}) })));
    v.walkHunks = hunks; v.walk = { ...saved, title: r.title, summary: r.summary, asks: r.asks, steps: [...r.steps].sort((a, b) => a.order - b.order).map((x) => ({ ...x, text: x.text || x.why })) };
    for (let k = 0; k <= v.walk.steps.length + 1; k++) { v.step = k; draw(v, `panel: Walkthrough, layer ${k}`); }
    v.walkMore = true; v.walkError = "The model gave no answer"; draw(v, "panel: Walkthrough, its options and an error"); v.walkMore = false; v.walkError = null;
  }
  v.panelCommand("setup", cx); draw(v, "panel: Setup"); v.setupOpen = true; draw(v, "panel: Setup, the list of programs unfolded"); v.panelCommand("setup:close", cx); assert.equal(v.view, "diff", "setup:close leaves Setup like its Close button"); draw(v, "panel: Setup closed");
  // The other scripted clicks: the folds, a pick and a removal by owner/repo#number (two repos can share a number).
  for (const c of ["picker", "merged", "other", "progress-all", "progress-all", "merged", "other"]) { v.panelCommand(c, cx); draw(v, `panel: command ${c}`); }
  v.panelCommand(`drop:${prs[0].repo}#${prs[0].number}`, cx); await settle(); assert.equal(v.undo?.url, prs[0].url); v.panelCommand("undrop", cx); await settle(); assert.equal(v.undo, null);
  v.note = "Could not open: gh pr view: not found"; v.error = "Error: gh pr diff: could not resolve"; v.files = []; draw(v, "panel: a diff that did not come, and a note"); v.note = null;
  S.exec = null;
  // A remount with that pick: the frame before prs.json is read shows no list.
  { const w = new PrReview(); w.init({}, cx); draw(w, "panel: the pick from before coming back"); assert.ok(w.restoring && !w.srcAsked); await settle(); assert.ok(!w.restoring); }
  // Back from the review of another PR (minimized, or Back): the panel shows that PR, not the pick from before.
  { S.store.set("pr.fromReview", prs[1]); const w = new PrReview(); w.init({}, cx); await settle(); draw(w, "panel: back from a review, its PR shown");
    assert.deepEqual([w.prSel?.url, S.store.get("pr.fromReview")], [prs[1].url, null], "the review's PR, handed over once"); }
  S.store.set("review.open", [{ ...reg(prs[0], { findingsOpen: 3 }), risk: { top: "high", security: true, open: 3 } }]); // the chip's mark and count
  S.props = { part: "mini" }; S.store.set("review.minimized", { target: prs[0], at: now });
  const mini = new PrReview(); mini.init({}, cx); draw(mini, "the minimized review's chip");
  S.spaces = null; S.props = null;
}
// Fit never puts the map in rows: in a view narrower than the picture, Fit (on by itself, or chosen) draws one row to
// scroll sideways, on the Architecture, Security and Resilience pages; only the Wrap switch draws rows.
{
  const v = await open({ ...PR2, analysis: fx("analysis-s.json"), findings: fx("findings-s.json") });
  for (const id of ["rv-arch-canvas", "rv-sec-canvas", "rv-res-canvas"]) v.hsOf(id).viewW = 420;
  const rows = (what) => { S.ids = new Set(); draw(v, what); const got = [...S.ids].filter((x) => /-(band|cut)\d+$/.test(x)); S.ids = null; return got; };
  for (const page of ["arch", "blast", "res"]) {
    v.command(`page:${page}`, cx);
    assert.ok(v.archFitOn(), "Fit is on by itself in a view narrower than the picture");
    assert.deepEqual(rows(`${page}: Fit by itself`), [], `${page}: Fit by itself draws one row`);
    v.archFit = true; assert.deepEqual(rows(`${page}: Fit chosen`), [], `${page}: Fit chosen draws one row`);
    v.archFit = false; assert.deepEqual(rows(`${page}: Fit off`), [], `${page}: without Wrap the picture is one row`);
    v.archFit = undefined;
  }
  v.command("page:arch", cx); v.command("arch-wrap", cx);
  assert.ok(rows("arch: Wrap").length > 1, "Wrap puts the same picture in rows");
  v.command("arch-wrap", cx);
}
// Copy as Markdown: its button is in the head of every page it can copy and nowhere else, and the footer names what
// was copied. (The stand-in for exec fails, so nothing reaches a clipboard here.)
{
  const v = await open({ ...PR2, analysis: fx("analysis-s.json"), findings: fx("findings-s.json") });
  const drawn = (what) => { S.ids = new Set(); draw(v, what); const got = [...S.ids].filter((x) => /^rv-md(-|$)/.test(x)); S.ids = null; return got; };
  // A click opens the preview (every section with its size, the code context, the first lines); a section and the
  // code can be left out; Copy says in the footer what was copied.
  const copied = (name) => {
    v.note = null; v.command("copy-md", cx);
    assert.ok(v.mdPrev && v.note === null, `${name}: the preview first, nothing copied yet`);
    S.ids = new Set(); draw(v, `${name}: the preview`); const ids = [...S.ids]; S.ids = null;
    const doc = v.mdShown();
    assert.ok(ids.includes("rv-mdprev") && ids.includes("rv-mdprev-copy") && ids.filter((x) => /^rv-mdprev-p\d+$/.test(x)).length === doc.parts.length, `${name}: the preview lists every section`);
    if (doc.parts.length) { act(v, "md-part:0", `${name}: a section left out`); assert.ok(!v.mdText().startsWith("##") && v.mdOff().has(0)); act(v, "md-part:0", `${name}: the section back in`); }
    act(v, "md-code", `${name}: without the code context`); act(v, "md-code", `${name}: with it again`);
    v.command("md-copy", cx);
    assert.ok(!v.mdPrev && v.note?.startsWith(`Copied ${name} as Markdown (`) && v.note.endsWith("Nothing was posted."), `the footer after copying ${name}: ${v.note}`);
  };
  for (const [page, name] of [["overview", "the Overview"], ["arch", "the architecture"], ["blast", "the Security page"], ["res", "the Resilience page"]]) {
    v.command(`page:${page}`, cx);
    assert.deepEqual(drawn(`${page}: Copy as Markdown`), ["rv-md"], `${page} has the button once`); copied(name);
  }
  v.command("order:reading", cx); v.command("step:0", cx);
  assert.deepEqual(drawn("a layer: Copy as Markdown"), ["rv-md-l"], "the open layer's head has the button, the other layers' heads do not"); copied(`the layer "${v.steps()[0].title}"`);
  v.command("findings", cx); v.ffocus = null;
  assert.ok(drawn("Findings: Copy as Markdown").includes("rv-md-f"), "the Findings tab has the button"); copied("the unresolved findings");
  v.command(`finding:${v.findings()[0].id}`, cx);
  assert.ok(drawn("an open finding: Copy as Markdown").includes("rv-md-f")); copied("the open finding");
  for (const tab of ["files", "comments"]) { v.command(tab, cx); assert.deepEqual(drawn(`${tab}: no Copy as Markdown`), [], `${tab} has no page to copy and no button`); }
  const empty = await open({ ...PR2 });
  for (const c of ["page:overview", "copy-md", "md-close", "page:arch", "copy-md", "md-close", "page:blast", "copy-md", "md-close", "page:res", "copy-md", "md-close", "findings", "copy-md", "md-copy"]) act(empty, c, `nothing analyzed yet: ${c}`);
}
// The Markdown of a page says what the page shows: every text the page draws (each crossing and path opened in turn,
// the folds open), sentence by sentence, is in its Markdown, except what only serves the page (NOT_COPIED). Every
// picture is a Mermaid block that reads as one, and the code context has the lines of the places named, no block
// empty or twice.
{
  const { mdParts, codeStats } = await import("./markdown.js");
  const doc = JSON.parse(fx("findings-s.json")); doc.resilience = JSON.parse(fx("resilience-r2.json"));
  const v = await open({ ...PR2, analysis: fx("analysis-s.json"), findings: JSON.stringify(doc) }), tt = S.theme;
  v.deep = { ...v.deep, probes: { [v.probeKey("r1")]: { state: "done", status: "reproduced", line: "handled=1, no mail", ms: 1100, head: "ccddf95", base: { status: "script_failed", verdict: "new_in_pr", line: "ImportError" }, pre_existing: false, network_barrier: true,
    script: "from library.mailer import Mailer\nprint('reproduced handled=1, no mail')\n", output: "reproduced handled=1, no mail\n" } } };
  // (A mark that ends in "and 2 more" counts what the text lists in full: compared without that end.)
  // What a page draws for itself and a text does not need: offers and prices of runs, ages, buttons, hints how to use
  // the page, lines that only fold or count what the text has in full, and the certainty said in the page's own
  // second wording (the text has it as Certainty and Preconditions).
  const NOT_COPIED = [/recommended because/, /^Re-run \(/, /^Run probe/, /^last run .* ago/, /^A click shows the way\.$/, /^Verify (all \d+ )?with an agent/, /^Derived from the code that was read;$/, /^It needs nothing else:$/, /^it holds as the code stands\.$/, /lit on the map, the rest dimmed/, /^Open a path to light it on the map\.$/,
    /^in a sandbox, without network, at most 30 s$/, /^\d+ more: /, /^\d+ [^.]*(criteria|high|medium|low|observable|blockers?|paths?) ▸$/, /^GitHub read .* ago/, /^call over a trust boundary$/, /^Look inside/, /Ask names it/, /^This analysis has no further details for this card\.$/, /^“Look inside” reads/, /^“↻ Refresh diagrams”/,
    /^and \d+ more in the Findings tab$/, /^Ask about this layer$/, /^A finding sent to Fix stays unresolved and shows here/, /^not counted as findings$/, /^Each call has its own scale\.$/];
  const norm = (x) => String(x).toLowerCase().replace(/,? \d+ (s|min|h|d|days?) ago/g, "").replace(/#\d+;|#quot;|#lt;|#gt;/g, " ").replace(/[^a-z0-9äöüß]+/g, " ").trim();
  const drawn = (states, part) => { const all = new Set(); for (const st of states) { st(); S.texts = null; S.lists.length = 0; v.render(cx); S.lists.length = 0; S.texts = all; part(); } S.texts = null; return [...all]; };
  const missing = (texts, md) => { const text = norm(md), segs = [...new Set(texts.flatMap((x) => x.split(/(?<=[.;:])\s+|\s·\s|\n+/)).map((x) => x.replace(/^\*\*Suggested:\*\*\s*/, "").replace(/ and \d+ more$/, "")))].filter((x) => x.trim().length >= 20 && x.trim().split(/\s+/).length >= 4);
    return segs.filter((x) => !NOT_COPIED.some((re) => re.test(x.trim())) && norm(x.replace(/…$/, "")) && !text.includes(norm(x.replace(/…$/, "")))); };
  // A Mermaid block as Mermaid reads it: a known diagram, every line of a known form, frames closed, no call to a card that is not there.
  const mermaidBad = (lines) => {
    const [kind, ...raw] = lines, rest = raw.map((l) => l.replace(/#\w+;/g, "")), ids = new Set(), bad = []; // an entity code ("#58;") is text
    if (kind === "flowchart LR") {
      let open = 0;
      for (const l of rest) { let m;
        if (/^\s*subgraph \w+\["[^"]*"\]$/.test(l)) open++; else if (/^\s*end$/.test(l)) open--;
        else if ((m = /^\s*(\w+)\["[^"]*"\](:::\w+)?$/.exec(l))) ids.add(m[1]);
        else if ((m = /^\s*(\w+) (?:-->|-\.->|==>)(?:\|"[^"]*"\|)? (\w+)$/.exec(l))) { if (!ids.has(m[1]) || !ids.has(m[2])) bad.push(`unknown card: ${l}`); }
        else if (!/^\s*(classDef \w+ [\w:#,. -]+|class [\w,]+ \w+|linkStyle \d+ [\w:#,. -]+)$/.test(l)) bad.push(l); }
      if (open) bad.push("a frame is not closed");
    } else if (kind === "stateDiagram-v2") { for (const l of rest) if (!/^\s*state "[^"]*" as \w+$/.test(l) && !/^\s*(\[\*\]|\w+) --> (\[\*\]|\w+)( : [^:;]+)?$/.test(l)) bad.push(l); }
    else if (kind === "sequenceDiagram") { for (const l of rest) if (!/^\s*participant \w+ as [^:;]+$/.test(l) && !/^\s*\w+-?->>\w+: [^;]+$/.test(l) && !/^\s*Note over \w+: [^:;]*$/.test(l)) bad.push(l); }
    else if (kind === "gantt") { for (const l of rest) if (!/^\s*(title [^:;]+|dateFormat X|axisFormat %s|section [^:;]+|[^:;]+ :(done, |crit, )?\d+, \d+)$/.test(l)) bad.push(l); }
    else bad.push(`unknown diagram: ${kind}`);
    return bad;
  };
  const pictures = (md) => { const out = [], lines = md.split("\n"); for (let i = 0; i < lines.length; i++) if (lines[i] === "```mermaid") { const k = lines.indexOf("```", i + 1); out.push(lines.slice(i + 1, k)); i = k; } return out; };
  const check = (name, texts, want) => {
    const md = v.mdText(true), pics = pictures(md), heads = md.split("\n").filter((l) => /^Code `[^`]+:\d+-\d+`:$/.test(l)), cs = codeStats(md);
    assert.deepEqual(missing(texts, md), [], `${name}: what the page shows and its Markdown does not have`);
    assert.deepEqual(pics.flatMap(mermaidBad), [], `${name}: a Mermaid block does not read as one`);
    for (const [kind, n] of Object.entries(want)) assert.ok(pics.filter((p) => p[0].startsWith(kind)).length >= n, `${name}: ${n} ${kind} pictures as Mermaid, found ${pics.filter((p) => p[0].startsWith(kind)).length}`);
    assert.equal(new Set(heads).size, heads.length, `${name}: a place's code is there once`);
    assert.ok(cs.blocks === heads.length && cs.lines >= cs.blocks && !/```\w*\n```/.test(md), `${name}: no code block is empty`);
    assert.ok(mdParts(md).parts.length > 0 && mdParts(v.mdText(false)).parts.every((p) => !p.lines.some((l) => /^Code `/.test(l))), `${name}: sections for the preview, and none of the code without the code context`);
    return md;
  };
  const a = v.ai.arch, paths = v.resNow().paths, page = () => v.pageView(tt);
  v.command("page:blast", cx); v.crossAll = true;
  const sec = check("Security", drawn(["", ...(v.ai.access ?? []).map((x) => `a:${x.id}`), ...a.edges.map((_e, k) => `e:${k}`)].map((k) => () => v.command(`cross:${k}`, cx)), page), { flowchart: 1 });
  // A security finding with a range of lines has those lines as code, from the diff with its marks.
  const ranged = v.findings().find((f) => f.security && f.end > f.line && v.fileHunks.has(f.file));
  assert.ok(ranged && new RegExp(`Code \`${ranged.file.replace(/[.]/g, "\\.")}:\\d+-\\d+\`:\\n\\n\`\`\`diff\\n`).test(sec), "a finding's lines stand under it as a diff block");
  v.command("page:res", cx);
  check("Resilience", drawn([...paths.map((p) => () => v.command(`res-path:${p.id}`, cx)), () => { v.command("res-more", cx); v.command("res-clean", cx); v.command("res-add", cx); v.command("res-probe-open:r1", cx); }], page),
    { flowchart: 1 + paths.filter((p) => (p.via ?? []).length > 0).length, sequenceDiagram: (v.resNow().races ?? []).filter((r) => paths.some((p) => (p.findings ?? []).some((id) => (r.findings ?? []).includes(id)))).length, gantt: 1 });
  // With dependencies that fail: their part is in the text and in the preview's list.
  {
    const dn = [{ dep: "Mailer", kind: "external", mode: "sync", at: "library/mailer.py:14", cases: [{ when: "slow", handled: "no", how: "waits up to 7 s", effect: "The request hangs until its timeout.", path: paths[0].id, findings: [] },
      { when: "down", at: "library/mailer.py:19", handled: "yes", how: "fails fast", effect: "", path: null, findings: [] }, { when: "recovers", at: null, handled: "not_checkable", how: "", effect: "", path: null, findings: [] }] }];
    const keep = v.find.resilience; v.find.resilience = { ...keep, downstream: dn }; if (v.ai.resilience) v.ai.resilience = { ...v.ai.resilience, downstream: dn };
    const md = check("Resilience with dependencies", drawn([() => v.command("res-path:", cx)], page), {});
    assert.ok(mdParts(md).parts.some((p) => /^When a dependency fails \(1\)$/.test(p.title)) && /- Mailer \(/.test(md), "the dependencies are a part of the text and of the preview");
    v.find.resilience = keep; if (v.ai.resilience) delete v.ai.resilience.downstream;
  }
  v.command("page:overview", cx); v.rulesOpen = true; v.relOpen = true;
  check("Overview", drawn([() => {}, ...[...v.ai.asks.map((x) => x.id), "other"].map((k) => () => v.command(`criterion:${k}`, cx))], page), {});
  v.command("page:arch", cx);
  check("Architecture impact", drawn([() => {}, ...a.nodes.map((n) => () => v.command(`card:${n.id}`, cx))], page), { flowchart: 1 });
  v.command("order:reading", cx); v.command("step:0", cx);
  const st = v.steps()[0];
  check("a layer", drawn([() => {}], () => { v.stepRow(st, 0, tt); v.item({ t: "step", s: st, i: 0 }, tt); }), { stateDiagram: (st.visuals ?? []).filter((x) => x.kind === "state_machine").length });
  v.command("findings", cx); v.ffocus = null;
  const all = drawn([() => {}], () => v.findingsPane(tt));
  const tab = check("the Findings tab", all, {});
  assert.ok(mdParts(tab).parts.length <= 6 && mdParts(tab).parts.some((p) => /^High \(\d+\)$/.test(p.title)), "the preview lists the findings by severity, not one by one");
  const f = v.findings().find((x) => x.sources.length > 1); v.ffocus = f.id;
  const one = drawn(["reported", "evidence", "sent", "verified", "in_pr"].map((k) => () => { v.fstep = { id: f.id, key: k }; }), () => v.findingsPane(tt)).filter((x) => !all.includes(x));
  check("an open finding", one, {}); v.fstep = null;
}
await settle();
assert.deepEqual(late, [], "a spawned task threw");
console.log(`smoke ok: ${shown} frames`);
