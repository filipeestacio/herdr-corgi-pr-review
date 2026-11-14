// Run: node test_threads.mjs  (threads.js: sent comments as threads, agent replies, GitHub's exact payload, the
// agent preview)
import assert from "node:assert/strict";
import * as TH from "./threads.js";
import { buildReview } from "./pr.js";

// ---- ids: the creation id stays; older comments without one get one from their content, the same every load
const old = { file: "a.py", start: 3, end: 4, old: false, text: "why?" };
assert.equal(TH.commentId(old), TH.commentId({ ...old }));
assert.notEqual(TH.commentId(old), TH.commentId({ ...old, end: 5 }));
assert.equal(TH.commentId({ ...old, id: "lx1" }), "lx1");
assert.deepEqual(TH.withIds([old, { ...old, id: "k" }]).map((c) => c.id), [TH.commentId(old), "k"], "old pending comments still load");

// ---- threads: added once per id, bounded per PR and in PRs
let doc = TH.addThreads({}, "pr1", [{ id: "c1", file: "a.py", start: 3, end: 4, text: "Warum?", hunk: "+x" }], { route: "agent", agent: "PR #7 · main conversation" }, 100);
doc = TH.addThreads(doc, "pr1", [{ id: "c1", file: "a.py", start: 3, end: 4, text: "Warum nochmal?" }], { route: "agent" }, 200);
assert.equal(TH.threadsOf(doc, "pr1").length, 1);
assert.equal(TH.threadsOf(doc, "pr1")[0].text, "Warum nochmal?");
for (let i = 0; i < 55; i++) doc = TH.addThreads(doc, `p${i}`, [{ id: "x", file: "f", end: 1, text: "t" }], { route: "github" }, 1000 + i);
assert.equal(Object.keys(doc).length, 50);
assert.ok(!doc.pr1 && doc.p54);

// ---- replies: parsed per id in file order, merged into the thread; follow-ups between them; fixed folds
const text = ['{"id": "c1", "reply": "Weil X.", "status": "answered"}', "{half", '{"id": "c1", "reply": "Behoben.", "status": "fixed", "commit": "abc1234def"}',
  '{"id": "c2", "reply": "", "status": "fixed"}', '{"id": "c3", "reply": "ok", "status": "weird"}'].join("\n");
const rep = TH.parseReplies(text);
assert.deepEqual(Object.keys(rep), ["c1", "c3"]);
assert.equal(rep.c3[0].status, "answered");
let d = TH.addThreads({}, "pr", [{ id: "c1", file: "a.py", start: 3, end: 4, text: "Warum?" }], { route: "agent" }, 1);
d = TH.addFollowup(d, "pr", "c1", "Und Y?", 1, 2);
const th = TH.threadsOf(d, "pr")[0];
const v = TH.threadView(th, rep.c1);
assert.deepEqual(v.entries.map((e) => [e.who, e.text]), [["agent", "Weil X."], ["you", "Und Y?"], ["agent", "Behoben."]]);
assert.equal(v.status, "fixed");
assert.equal(v.fixedIn, "abc1234def");
assert.equal(v.collapsed, true, "a fixed thread folds to one line");
assert.equal(TH.threadView(th, rep.c1, [], true).collapsed, false, "and opens");
assert.equal(TH.threadView(th, []).status, "sent");
assert.equal(TH.threadView({ ...th, route: "github" }, []).status, "posted");
const gh = [{ id: 9, in_reply_to_id: 5, user: "anna", body: "Seh ich auch so", at: "2026-11-10T10:00:00Z" }, { id: 5, user: "me", body: "root" }];
assert.deepEqual(TH.threadView({ ...th, followups: [], ghId: 5 }, [], TH.ghRepliesTo(gh, 5)).entries.map((e) => e.who), ["anna"], "GitHub replies in the thread");
assert.deepEqual(TH.threadCounts([th, { id: "zz" }], rep, gh), { threads: 2, replies: 2, fixed: 1 });

// ---- the agent: ids and the replies contract in the prompt; the preview sends exactly what it shows
const prompt = buildReview({ pr: { number: 7, title: "T" }, comments: [{ id: "c1", file: "a.py", start: 3, end: 4, text: "Warum?" }], lang: "German", replies: "/x/replies/p.jsonl", contract: TH.repliesContract });
assert.ok(prompt.includes("[c1] `a.py` lines 3–4"));
assert.ok(prompt.includes(`echo '{"id": "c1", "reply": "briefly, what you did or your answer", "status": "fixed", "commit": "<sha>"}' >> /x/replies/p.jsonl`));
assert.ok(!buildReview({ pr: null, base: "main", comments: [{ file: "a", text: "t" }] }).includes(">>"), "the panel's prompt stays without a contract");
const up = TH.followupPrompt({ pr: { number: 7, title: "T" }, thread: th, replies: rep.c1, text: "Und Z?", file: "/x/r.jsonl", lang: "English" });
assert.ok(up.includes("[c1]") && up.includes("You: Weil X.") && up.includes("Reviewer: Und Z?") && up.includes(">> /x/r.jsonl"));
const pv = TH.preview({ what: "Comment", agent: "PR #7 · main conversation", own: "Warum?", prompt });
assert.equal(TH.confirm(pv).text, prompt, "unedited: exactly the preview's text");
assert.equal(TH.confirm(pv, "edited").text, "edited", "edited: exactly the edit");
assert.equal(TH.agentLabel({ tab_name: "PR #7" }, "x"), "PR #7 · main conversation");
assert.ok(TH.agentLabel({ tab_name: "Sub", parent: "t1" }, "x").includes("sub-agent"));
assert.equal(TH.agentLabel(null, "a new Claude tab"), "a new Claude tab");

// ---- GitHub: exactly the ticked items with their edited text; nothing else
const lines = new Map([["a.py", new Set(["R3", "R4", "R10"])]]);
const comments = [{ id: "c1", file: "a.py", start: 3, end: 4, text: "Warum? (edited)" }, { id: "c2", file: "a.py", start: 10, end: 10, text: "Typo" },
  { id: "c3", file: "b.py", start: 1, end: 1, text: "outside" }];
let plan = TH.ghPlan({ comments, off: new Set(["c2"]), summary: "Overall", summaryOn: true, event: "comment", commit: "h", lines, repo: "acme/x#7" });
assert.deepEqual(plan.payload.comments.map((c) => c.body), ["Warum? (edited)"]);
assert.ok(plan.payload.body.includes("Overall") && plan.payload.body.includes("outside"), "out-of-diff notes go into the body when ticked");
assert.equal(plan.label, "Post 1 comment and a review body");
assert.equal(TH.ghPlan({ comments, summary: "", event: "approve", commit: "h", lines, repo: "acme/x#7", login: "saefty" }).target, "as saefty · acme/x#7 · Approve");
assert.equal(TH.ghPlan({ comments: [], summary: "  ", summaryOn: true, event: "comment", commit: "h", lines }).ready, false, "an empty body is not posted");
plan = TH.ghPlan({ comments, off: new Set(["c1", "c2", "c3"]), summary: "Overall", summaryOn: false, event: "comment", commit: "h", lines });
assert.equal(plan.ready, false, "nothing ticked and no body: Submit is off");
assert.equal(TH.ghPlan({ comments, off: new Set(["c1", "c2", "c3"]), summaryOn: false, event: "approve", commit: "h", lines }).ready, true, "a verdict alone posts");
const finding = { id: "f1", file: "a.py", line: 3, title: "SQL injection", detail: "…" }, suggestion = { key: "s1", path: "a.py", line: 4, reason: "AI says" };
plan = TH.ghPlan({ comments, summary: "", event: "comment", commit: "h", lines });
assert.ok(!JSON.stringify(plan.payload).includes(finding.title) && !JSON.stringify(plan.payload).includes(suggestion.reason), "findings and AI suggestions never ride along");
plan = TH.ghPlan({ comments: [...comments, { id: "f1c", file: "a.py", start: 3, end: 3, text: `${finding.title}: ${finding.detail}`, from: "security" }], summary: "", event: "comment", commit: "h", lines });
assert.ok(plan.payload.comments.some((c) => c.body.startsWith("SQL injection")), "unless added as a comment");
assert.deepEqual(TH.singlePayload(comments[0], "h", true), { commit_id: "h", path: "a.py", line: 4, side: "RIGHT", start_line: 3, start_side: "RIGHT", body: "Warum? (edited)" });
assert.equal(TH.singlePayload(comments[2], "h", false), null);
assert.equal(TH.postedItems(plan.payload)[1], "a.py:3–4: Warum? (edited)");

// ---- Fix: selection, jobs, the sub-agent's launch, Apply only on a clean checkout
let fx = TH.addThreads({}, "pr", [{ id: "c1", file: "a.py", end: 3, text: "t" }], { route: "agent" }, 1);
fx = TH.toggleSelected(fx, "pr", "c1", 2);
fx = TH.toggleSelected(fx, "pr", "p9", 3);
assert.deepEqual(TH.selectedOf(fx, "pr"), ["c1", "p9"]);
assert.equal(TH.threadsOf(fx, "pr").length, 1, "the selection keeps the threads");
assert.deepEqual(TH.selectedOf(TH.toggleSelected(fx, "pr", "c1", 4), "pr"), ["p9"]);
assert.deepEqual(TH.selectedOf(JSON.parse(JSON.stringify(fx)), "pr"), ["c1", "p9"], "it persists with the threads");
fx = TH.addThreads(fx, "pr", [{ id: "c2", file: "b.py", end: 1, text: "u" }], { route: "agent" }, 5);
assert.deepEqual(TH.selectedOf(fx, "pr"), ["c1", "p9"], "adding threads keeps the selection");
assert.equal(TH.fixBranch(7, ["mwb8736v"]), "fix/7-mwb8736v");
assert.equal(TH.fixBranch(7, ["a", "b", "c"]), "fix/7-a-and-2");
assert.equal(TH.fixPath("/h", "acme/bookshelf", "fix/7-a"), "/h/.herdr/worktrees/bookshelf/fix-7-a");
const job = { id: "j1", branch: "fix/7-c1", path: "/w", base: "/repo", head: "abc", items: [{ kind: "comment", id: "c1" }, { kind: "finding", id: "f1" }], target: "sub", state: "running" };
fx = TH.addFix(fx, "pr", job, 6);
assert.equal(TH.fixFor(fx, "pr", "f1").id, "j1");
assert.equal(TH.fixFor(TH.setFix(fx, "pr", "j1", { state: "applied" }, 7), "pr", "f1"), null, "an applied job is no longer live");
assert.equal(TH.fixCommit(job, {}, {}), null);
assert.equal(TH.fixCommit(job, { c1: [{ status: "answered" }, { status: "fixed", commit: "beef" }] }, {}), "beef", "a comment reply with the commit");
assert.equal(TH.fixCommit(job, {}, { f1: { status: "fixed", commit: "cafe" } }), "cafe", "a finding report with the commit");
const args = TH.subAgentArgs({ parent: "t3", cwd: "/w", name: "fix-j1", env: ["env", "CLAUDE_CONFIG_DIR=/c"], task: "Fix it", job: "j1", auto: true });
assert.deepEqual(args.slice(0, 2), ["run", "--bg"]);
assert.ok(args.includes("--no-notify"), "nothing typed into the parent");
assert.equal(args[args.indexOf("--parent") + 1], "t3", "a sub-agent of the PR's agent");
assert.equal(args[args.indexOf("--cwd") + 1], "/w", "in its own worktree");
assert.deepEqual(args.slice(args.indexOf("--") + 1, args.indexOf("claude") + 1), ["env", "CLAUDE_CONFIG_DIR=/c", "claude"], "on the PR's context");
assert.deepEqual(args.slice(args.indexOf("--permission-mode")), ["--permission-mode", "auto", "Fix it"], "in auto mode");
assert.ok(TH.subAgentArgs({ parent: null, cwd: "/w", name: "n", task: "x", job: "j" }).includes("--no-parent"));
const untrusted = TH.subAgentArgs({ parent: null, cwd: "/w", name: "n", task: "x", job: "j" });
assert.deepEqual(untrusted.slice(untrusted.indexOf("--permission-mode")), ["--permission-mode", "manual", "--setting-sources", "user", "x"], "an untrusted PR: manual, said outright, without the checkout's settings");
assert.equal(TH.applyPlan({ status: " M src/a.ts\n?? x", head: "abc", branch: "fix/7-c1" }).ok, false, "a dirty checkout: refused");
assert.match(TH.applyPlan({ status: " M a\n", head: "abc", branch: "b" }).reason, /1 uncommitted change/);
assert.deepEqual(TH.applyPlan({ status: "", head: "abc", branch: "fix/7-c1" }), { ok: true, args: ["cherry-pick", "abc..fix/7-c1"] });
assert.ok(TH.applyPrompt(job).includes("git cherry-pick abc..fix/7-c1"));
// The fix branch starts at the PR head, also when the local clone has another branch checked out; a space's own branch
// diff starts at its checkout. Apply refuses a checkout that does not contain that start.
assert.equal(TH.fixStart({ prHead: "pr1", checkoutHead: "other" }), "pr1", "the PR head, not the clone's HEAD");
assert.equal(TH.fixStart({ local: true, prHead: "pushed", checkoutHead: "here" }), "here", "a branch diff: its checkout");
assert.equal(TH.fixStart({ prHead: null, checkoutHead: "here" }), "here", "no PR head known: the checkout");
const off = TH.applyPlan({ status: "", head: "abcdef0123", branch: "fix/7-c1", onHead: false, where: "feat/other" });
assert.equal(off.ok, false); assert.equal(off.off, true);
assert.match(off.reason, /on feat\/other.*abcdef0.*git cherry-pick abcdef0\.\.fix\/7-c1/);
// A fix is checked on its own branch once the agent reports a commit; the verdict stays next to the finding and never
// makes it "fixed", which needs the fix in the PR head.
{
  const fjob = { id: "j9", branch: "fix/7-f1", path: "/w", head: "abc", items: [{ kind: "finding", id: "f1" }], target: "sub", state: "running" };
  const fs = [{ id: "f1", ids: ["f1", "s1"] }, { id: "f2", ids: ["f2"] }], st = { f1: { s: "progress", fixHead: "abc" } }, open = () => "progress";
  assert.deepEqual(TH.branchChecks(fs, [fjob], st, {}, open), [], "no report yet");
  assert.deepEqual(TH.branchChecks(fs, [fjob], st, { f1: { status: "wontfix", note: "no" } }, open), [], "declined");
  const checks = TH.branchChecks(fs, [fjob], st, { f1: { status: "fixed", commit: "cafe1234" } }, open);
  assert.deepEqual(checks.map((c) => [c.f.id, c.job.id, c.commit]), [["f1", "j9", "cafe1234"]]);
  assert.deepEqual(TH.branchChecks(fs, [{ ...fjob, state: "applied" }], st, { f1: { status: "fixed", commit: "cafe1234" } }, open), [], "applied: the PR head is checked instead");
  assert.deepEqual(TH.branchChecks(fs, [{ ...fjob, target: "main", path: undefined }], st, { f1: { status: "fixed", commit: "cafe1234" } }, open), [], "the main agent has no fix branch");
  const after = TH.applyBranchChecks(st, [{ id: "f1", verdict: "fixed", reason: "the guard is there" }, { id: "zz", verdict: "fixed" }], checks, 0);
  assert.equal(after.f1.s, "progress", "still Fix sent");
  assert.deepEqual(after.f1.verify, { result: "fixed", reason: "the guard is there", head: "cafe1234", branch: "fix/7-f1", at: "1970-01-01T00:00:00.000Z" });
  assert.equal(after.zz, undefined);
  assert.deepEqual(TH.branchChecks(fs, [fjob], after, { f1: { status: "fixed", commit: "cafe1234" } }, open), [], "checked at this commit already");
  assert.equal(TH.branchChecks(fs, [fjob], after, { f1: { status: "fixed", commit: "beef5678" } }, open).length, 1, "a newer commit is checked again");
  assert.equal(TH.checkText(after.f1.verify), "Verified on the fix branch, not in the PR yet (fix/7-f1 at cafe123): the guard is there");
  assert.equal(TH.checkText(after.f1.verify, true), "verified on the fix branch, not in the PR yet");
  assert.equal(TH.checkText({ result: "not_fixed", reason: "", head: "cafe1234", branch: "fix/7-f1" }), "Not fixed on the fix branch (fix/7-f1 at cafe123).");
  assert.equal(TH.checkText({ result: "fixed", reason: "ok", head: "0123456789" }), "Verified at 0123456: fixed, ok", "on the PR head, as before");
  assert.equal(TH.checkText(null, true), "not verified");
}
// A fix agent cannot push: deny rules before the permission mode, the task last.
assert.deepEqual(args.slice(args.indexOf("claude") + 1, args.indexOf("--permission-mode")), ["--disallowedTools", ...TH.NO_PUSH]);
assert.ok(TH.NO_PUSH.includes("Bash(git push *)") && untrusted.includes("Bash(git push *)") && untrusted.at(-1) === "x");
// The target choice: the sub-agent's text names its worktree, the main agent's doesn't; the preview sends that text.
const sub = TH.fixCommentsPrompt({ pr: { number: 7, title: "T" }, comments: [{ id: "c1", file: "a.py", start: 3, end: 3, text: "Warum?" }], file: "/r.jsonl", branch: "fix/7-c1", path: "/w" });
const main = TH.fixCommentsPrompt({ pr: { number: 7, title: "T" }, comments: [{ id: "c1", file: "a.py", start: 3, end: 3, text: "Warum?" }], file: "/r.jsonl" });
assert.ok(sub.includes("own git worktree /w on branch fix/7-c1") && sub.includes("[c1]") && sub.includes(">> /r.jsonl"));
assert.ok(!main.includes("worktree") && main.includes("[c1]"));
assert.equal(TH.confirm(TH.preview({ what: "Fix", agent: "x", prompt: sub })).text, sub);
assert.ok(!sub.includes("hc send") && sub.includes("the reviewer applies it"), "no live PR agent: no send step");
assert.ok(!main.includes("hc send"), "the main agent itself: no handoff");
// The handoff: with the PR agent's address the sub-agent's last step is one hc send to it; the main agent pushes.
const handed = TH.fixCommentsPrompt({ pr: { number: 7, title: "T" }, comments: [{ id: "c1", file: "a.py", start: 3, end: 3, text: "Warum?" }], file: "/r.jsonl", branch: "fix/7-c1", path: "/w", head: "abc", main: "t3" });
assert.ok(handed.includes('hc send t3 "Fix ready: branch fix/7-c1, commit <sha>, worktree /w.'), "the send to the PR agent's address");
assert.ok(handed.indexOf("hc send t3") > handed.indexOf(">> /r.jsonl"), "after the report line");
assert.ok(handed.includes("git cherry-pick abc..fix/7-c1") && handed.includes("push to the PR branch"), "the PR agent cherry-picks and pushes");
assert.ok(handed.includes("git worktree remove /w && git branch -D fix/7-c1"), "then the worktree and branch go");
assert.ok(handed.includes("never push") && handed.includes("Never push yourself"), "the sub-agent never pushes");
assert.equal(TH.handoffNote({ main: null, branch: "b", path: "/w", head: "abc" }), null, "no address: no send step");
assert.equal(TH.handoffNote({ main: "t3", branch: "b", path: "/w", head: null }), null, "no head: no send step");
assert.ok(TH.applyPrompt(job).includes("push to the PR branch") && TH.applyPrompt(job).includes("git worktree remove"), "Hand over…: the same take-over");
const notice = TH.startNotice({ pr: { number: 7 }, branch: "fix/7-c1", path: "/w", terminal: "t9", labels: ["a.py L3: Warum\nso?", "b.py L1: x"] });
assert.equal(notice, "PR #7: the reviewer started a fix sub-agent (t9) on branch fix/7-c1, worktree /w, for: a.py L3: Warum so?; b.py L1: x. It reports back here when done; nothing to do yet.");
console.log("threads ok");
// ---- the Comments tab: rows, summary, filters
{
  const rows = TH.commentRows({ pending: [{ id: "p1", file: "b.py", end: 4, text: "p" }, { id: "p2", file: "a.py", end: 9, text: "ai", from: "ki" }],
    threads: [{ id: "t1", file: "a.py", end: 2, text: "w" }, { id: "t2", file: "a.py", end: 5, text: "f" }, { id: "t3", file: "c.py", end: 1, text: "r", ghId: 7, route: "github" }],
    replies: { t2: [{ status: "fixed", commit: "c" }] }, gh: [{ id: 8, in_reply_to_id: 7, body: "ok" }, { id: 9, path: "a.py", line: 1, body: "theirs", user: "anna" }],
    ghOwn: (g) => g.id === 7 || g.in_reply_to_id === 7, notes: [{ id: "n1", anchor: { file: "a.py", end: 3 }, summary: "note" }, { id: "n2", anchor: { node: "x" }, summary: "card" }] });
  assert.deepEqual(rows.map((r) => `${r.file}:${r.line}:${r.state}`), ["a.py:1:github", "a.py:2:waiting", "a.py:3:note", "a.py:5:fixed", "a.py:9:pending", "b.py:4:pending", "c.py:1:replied"], "by file and line");
  assert.equal(rows.find((r) => r.id === "t3").replies, 1, "a GitHub reply counts");
  assert.equal(TH.commentSummary(rows), "5 comments · 2 pending · 1 sent to an agent · 1 replied · 1 reported fixed");
  const show = TH.showOf({ github: false });
  assert.deepEqual(show, { mine: true, ai: true, agents: true, github: false, notes: true });
  assert.deepEqual(TH.filterRows(rows, "all", show).map((r) => r.id), ["t1", "n1", "t2", "p2", "p1", "t3"], "GitHub hidden");
  assert.deepEqual(TH.filterRows(rows, "pending", TH.showOf({ ai: false })).map((r) => r.id), ["p2", "p1"], "a comment taken from an AI note is yours: the Findings switch leaves it");
  assert.deepEqual(TH.showCounts({ rows, findings: 3, agents: 2 }), { mine: 5, ai: 3, agents: 2, github: 1, notes: 1 }, "Findings shows the findings' own count");
  assert.equal(TH.SHOW_KINDS.find(([k]) => k === "ai")[1], "Findings");
  console.log("comments tab ok");
}
// ---- GitHub: resolved threads, bots by their latest reviewed commit, outdated comments; STALE on own rows
{
  const g = (id, user, at, commit, extra = {}) => ({ id, path: "a.py", line: id, side: "RIGHT", user, user_type: user.endsWith("[bot]") ? "Bot" : "User", at, commit_id: commit, body: `b${id}`, ...extra });
  const gh = [g(1, "anna", "2024-01-01", "c1"), g(2, "anna", "2024-01-01", "c1", { in_reply_to_id: 1 }),
    g(3, "lint[bot]", "2024-01-02", "c1"), g(4, "lint[bot]", "2024-01-02", "c1"), g(5, "anna", "2024-01-03", "c1", { in_reply_to_id: 3 }),
    g(6, "lint[bot]", "2024-01-05", "c2"), g(7, "ci", "2024-01-01", "c0", { user_type: "Bot" }), g(8, "anna", "2024-01-09", "c0")];
  const st = TH.withThreadState(gh, [{ id: 1, resolved: true, outdated: false }, { id: 6, resolved: false, outdated: true }, { id: null, resolved: true }]);
  assert.deepEqual(st.filter((x) => x.resolved).map((x) => x.id), [1, 2], "a resolved thread: its first comment and its replies");
  assert.equal(st.find((x) => x.id === 6).outdated, true);
  assert.ok(TH.isBot(gh[2]) && TH.isBot(gh[6]) && !TH.isBot(gh[0]));
  const { kept, hidden } = TH.latestBotComments(st);
  assert.deepEqual(kept.map((x) => x.id), [1, 2, 6, 7, 8], "lint[bot]'s comments on c1 go with the reply to them; ci keeps its only commit; people stay");
  assert.equal(hidden, 3);
  assert.deepEqual(TH.ghShown(st), { list: kept.filter((x) => !x.resolved), resolved: 1, botsHidden: 3 }, "by default: no resolved threads, no older bot comments");
  assert.deepEqual(TH.ghShown(st, { resolved: true, allBots: true }).list.map((x) => x.id), [1, 2, 3, 4, 5, 6, 7, 8]);
  // Outdated (line null) and STALE rows.
  const rows = TH.commentRows({ pending: [{ id: "p1", file: "a.py", end: 2, text: "p" }], gh: [{ id: 9, path: "a.py", line: null, original_line: 4, outdated: true, resolved: true, body: "old" }],
    notes: [{ id: "n1", anchor: { file: "a.py", end: 3 }, summary: "n" }], stale: (id) => id === "p1" || id === "n1" });
  assert.deepEqual(rows.map((r) => [r.id, r.line, Boolean(r.stale), Boolean(r.outdated), Boolean(r.resolved)]), [["p1", 2, true, false, false], ["n1", 3, true, false, false], ["gh9", 4, false, true, true]]);
  // Threads keep what the lines read when written.
  const d2 = TH.addThreads({}, "k", [{ id: "c9", file: "a.py", start: 1, end: 1, text: "x", code: "line", head: "h1" }], { route: "agent" }, 1);
  assert.deepEqual([TH.threadsOf(d2, "k")[0].code, TH.threadsOf(d2, "k")[0].head], ["line", "h1"]);
  console.log("github comments ok");
}

// The send preview's facts: a sub-agent's account, rights and the push ban; a live session is not ours to limit.
{
  const sub = Object.fromEntries(TH.sendFacts({ kind: "sub", account: "Claude Code (Anthropic) · account in ~/.claude", trusted: true, branch: "fix/7-f1" }));
  assert.equal(sub["Runs as"], "Claude Code (Anthropic) · account in ~/.claude");
  assert.match(sub.May, /auto mode/); assert.match(sub.Push, /^Never/); assert.match(sub.Result, /fix\/7-f1.*until you apply it/);
  assert.equal(sub.Starts, undefined, "the choice above says where it starts");
  assert.match(Object.fromEntries(TH.sendFacts({ kind: "sub", account: "a", trusted: false })).May, /someone else's PR.*asks before every edit/);
  const handed = Object.fromEntries(TH.sendFacts({ kind: "sub", account: "a", trusted: true, branch: "fix/7-f1", handoff: "PR #7" }));
  assert.match(handed.Push, /^Not by this agent.*PR #7 pushes/); assert.match(handed.Result, /PR #7 then applies it/);
  const main = Object.fromEntries(TH.sendFacts({ kind: "main", account: "a", name: "PR #7" }));
  assert.match(main["Runs as"], /^PR #7, on its own account/); assert.match(main.Push, /^Possible/);
  const live = Object.fromEntries(TH.sendFacts({ kind: "live", account: "a", name: "PR #7", chat: true }));
  assert.match(live.Starts, /^Nothing new.*chat box of PR #7 as a draft/);
  assert.match(Object.fromEntries(TH.sendFacts({ kind: "new", account: "a", where: "/w" })).Starts, /new agent in a new tab.*\(\/w\)/);
  // Finish your review: a suggestion from the findings, and the blockers as a body (security: the title only).
  assert.deepEqual(TH.suggestVerdict({ unresolved: 3, high: 1 }), { event: "request_changes", why: "1 unresolved finding is of high severity" });
  assert.equal(TH.suggestVerdict({ unresolved: 2, high: 0 }).event, "comment");
  assert.equal(TH.suggestVerdict({ unresolved: 0, high: 0 }), null, "nothing unresolved: no suggestion, an approval is the reviewer's call");
  assert.equal(TH.blockersDraft([{ severity: "high", title: "Mails twice", file: "a.py", line: 3 }, { severity: "high", security: true, title: "Empty token passes", file: "h.py", line: 8 }, { severity: "medium", title: "m", file: "b", line: 1 }]),
    "Blocking before merge (2):\n- Mails twice (a.py:3)\n- Security: Empty token passes");
  assert.equal(TH.blockersDraft([{ severity: "low", title: "x" }]), "");
  // The reviewers popup: a zero is put in relation, one finding is singular, a failure and "not run" are their own words.
  assert.equal(TH.runLine({ state: "done", count: 0, cost: 0.0886 }, 16, { took: "0:40", ago: "34 min ago" }), "No findings. It reviews on its own; the other sources have 16 · $0.089 · 0:40 · 34 min ago");
  assert.equal(TH.runLine({ state: "done", count: 1 }), "1 finding");
  assert.equal(TH.runLine({ state: "done", count: 2, cost: 0.12 }), "2 findings · $0.120");
  assert.equal(TH.runLine({ state: "failed", error: "no JSON" }), "Failed: no JSON");
  assert.equal(TH.runLine(undefined), "Not run on this PR yet");
  assert.equal(TH.runLine({ state: "running" }, 0, { running: "0:12" }), "Running · 0:12");
  console.log("preview, verdict and runs ok");
}
