// Run: node test_smoke.mjs  (a render smoke test: the review loaded the way Herdr loads it, from the analyses, findings
// files, context and diffs in demo/fixtures/review, then every tab, page, layer, card, crossing, finding and step,
// the popovers, the offers and the other parts of the mod drawn with every virtual list's rows. Also without an
// analysis, without findings, while runs are going, after they failed, and for someone else's PR. Any exception,
// sync or in a spawned task, and any null or non-finite value handed to an element fails it.)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { S, cx as base } from "./render_stub.mjs";

const { default: PrReview } = await import("./main.js");
const { splitPatch, hunksOf, diffRows, hash } = await import("./pr.js");
const { foldOnOpen, resWatch } = await import("./views.js");
const R = await import("./review.js");
const { withThreadState, addThreads, addFollowup } = await import("./threads.js");
const { mapAnswer, threadAdd, pinAdd } = await import("./explore.js");
const fx = (name) => readFileSync(new URL(`../../demo/fixtures/review/${name}`, import.meta.url), "utf8");

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
  for (const a of [...(v.ai?.asks ?? []).map((x) => x.id), "other"]) act(v, `criterion:${a}`, at(`Overview, criterion ${a}`));
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
  act(v, "findings-sort:quick", at("findings, quick wins first")); act(v, "findings-sort:", at("findings, usual order"));
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
    assert.ok(v4.resNow().paths.find((p) => p.id === ps.at(-1)).marks.some((m) => m.at === "mailer" && m.mark === "✕ when slow"), "and the map marks the dependency");
    for (const id of ["rv-res-dep-0-down", "rv-res-dep-at-0"]) { click(id, "a dependency's line"); draw(v4, `after ${id}`); }
    assert.match((await import("./markdown.js")).resilienceMd({ pr: {}, head: v4.head, res: v4.resNow(), arch: v4.ai?.arch }), /## When a dependency fails\n\n- Mailer/, "the export has the dependencies");
  }
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
  assert.deepEqual(v.inProgressList().map((r) => r.number), [2], "In progress: work done and not merged; one only opened is not there");
  assert.equal(S.store.get("review.minimized"), null, "the chip of a merged PR goes");
  for (const src of ["mine", "repo", "review"]) { S.store.set("pr.source", src); v.picking = true; draw(v, `panel: the ${src} list`); }
  S.store.set("pr.source", "mine"); v.showOther = v.showDone = true; draw(v, "panel: Mine with the other repos and the merged ones unfolded");
  v.choose(prs[0], cx); await settle(); draw(v, "panel: PR #2 chosen");
  assert.equal(S.store.get("pr.selected")["all@sA"], prs[0].url);
  S.spaces = [{ id: "sB", active: true, folder: "/h/b" }];
  draw(v, "panel: the frame a space switch starts"); v.onSpace(cx); await settle(); draw(v, "panel: another space");
  assert.equal(v.prSel, null, "another space shows its own pick (none yet: the list), not the PR from the first one");
  S.spaces = [{ id: "sA", active: true, folder: "/h/a" }]; v.onSpace(cx);
  assert.equal(v.prSel?.url, prs[0].url, "back in the first space: its pick again");
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
  const copied = (name) => { v.note = null; v.command("copy-md", cx); assert.ok(v.note?.startsWith(`Copied ${name} as Markdown (`) && v.note.endsWith("Nothing was posted."), `the footer after copying ${name}: ${v.note}`); };
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
  for (const c of ["page:overview", "page:arch", "page:blast", "page:res", "findings", "copy-md"]) act(empty, c, `nothing analyzed yet: ${c}`);
}
await settle();
assert.deepEqual(late, [], "a spawned task threw");
console.log(`smoke ok: ${shown} frames`);
