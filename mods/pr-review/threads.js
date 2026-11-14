// Pure helpers (node-testable) for review comments after they leave the pending review: sent and posted comments stay
// as threads under their lines (pr-data/threads.json, per PR, bounded), the agent answers each by id in
// pr-data/replies/<pr hash>.jsonl, GitHub replies come from its review comments. Plus what a GitHub submit posts
// (exactly the ticked items) and the preview before anything is typed into an agent's session.
import { hash, ghReview, lineLabel, answerIn } from "./pr.js";

export const MAX_PRS = 50, MAX_THREADS = 100;
export const STATUSES = ["fixed", "answered", "wontfix", "question"];

// A comment's id: the one it was made with (Date.now base 36), else (older pending comments) one from its content.
export const commentId = (c) => c.id ?? `c${hash(`${c.file}\0${c.start}\0${c.end}\0${c.old ? 1 : 0}\0${c.text}`)}`;
export const withIds = (list) => (list ?? []).map((c) => (c.id ? c : { ...c, id: commentId(c) }));

// ---- threads.json: {<pr key>: {at, threads: [{id, file, start, end, old, hunk, text, from, route, sentAt, agent, ghId,
// url, dry, followups: [{text, at, after}]}]}}

export const threadsOf = (doc, key) => doc?.[key]?.threads ?? [];
function bound(doc, key, threads, now, extra = {}) {
  const next = { ...(doc ?? {}), [key]: { ...doc?.[key], ...extra, at: now, threads: threads.slice(-MAX_THREADS) } };
  for (const k of Object.keys(next).sort((a, b) => next[b].at - next[a].at).slice(MAX_PRS)) delete next[k];
  return next;
}
// Comments that went out (how: {route: "agent" | "github", agent, dry, gh: {<comment id>: {ghId, url}}}) become threads;
// one sent again replaces its thread.
export function addThreads(doc, key, comments, how, now = Date.now()) {
  const made = withIds(comments).map((c) => ({ id: c.id, file: c.file, start: c.start, end: c.end, old: Boolean(c.old), hunk: c.hunk ?? null, text: c.text, from: c.from ?? null,
    route: how.route, sentAt: now, agent: how.agent ?? null, dry: Boolean(how.dry), ghId: how.gh?.[c.id]?.ghId ?? null, url: how.gh?.[c.id]?.url ?? null, followups: [],
    code: c.code ?? null, head: c.head ?? null })); // what the lines read when written (pr.js isStale)
  const ids = new Set(made.map((t) => t.id));
  return bound(doc, key, [...threadsOf(doc, key).filter((t) => !ids.has(t.id)), ...made], now);
}
// The reviewer's follow-up in a thread; after: how many agent replies it came after (that's where it shows).
export function addFollowup(doc, key, id, text, after, now = Date.now()) {
  return bound(doc, key, threadsOf(doc, key).map((t) => (t.id === id ? { ...t, followups: [...(t.followups ?? []), { text, at: now, after }] } : t)), now);
}

// The agent's answers: one JSON line each {id, reply, status, commit?}; all kept per id in file order, broken lines
// (half-written) skipped, an unknown status read as "answered".
export function parseReplies(text) {
  const out = {};
  for (const line of String(text ?? "").split("\n")) {
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (!r?.id || !String(r.reply ?? "").trim()) continue;
    (out[r.id] ??= []).push({ reply: String(r.reply).trim(), status: STATUSES.includes(r.status) ? r.status : "answered", commit: r.commit ? String(r.commit) : null });
  }
  return out;
}

// GitHub's replies to a posted comment (gh: the PR's review comments with in_reply_to_id), oldest first.
export const ghRepliesTo = (gh, ghId) => (ghId ? (gh ?? []).filter((g) => g.in_reply_to_id === ghId).sort((a, b) => String(a.at).localeCompare(String(b.at))) : []);

// What a thread shows: the agent's replies with the reviewer's follow-ups between them, GitHub replies after; its
// status (the last agent reply's, else sent/posted); a fixed thread folds to one line ("Fixed in <sha>") unless open.
export function threadView(th, replies = [], gh = [], open = false) {
  const entries = [];
  const ups = th.followups ?? [];
  for (const u of ups.filter((x) => (x.after ?? 0) <= 0)) entries.push({ who: "you", text: u.text });
  replies.forEach((r, k) => {
    entries.push({ who: "agent", text: r.reply, status: r.status, commit: r.commit });
    for (const u of ups.filter((x) => x.after === k + 1)) entries.push({ who: "you", text: u.text });
  });
  for (const u of ups.filter((x) => x.after > replies.length)) entries.push({ who: "you", text: u.text });
  for (const g of gh) entries.push({ who: g.user ?? "GitHub", text: g.body ?? "", url: g.url ?? null });
  const last = replies[replies.length - 1], status = last?.status ?? (th.route === "github" ? "posted" : "sent");
  const fixedIn = status === "fixed" ? [...replies].reverse().find((r) => r.commit)?.commit ?? null : null;
  return { status, fixedIn, collapsed: (status === "fixed" || status === "wontfix") && !open, entries };
}

// For the open-reviews registry: threads, replies and fixed ones of a PR.
export function threadCounts(threads, replies, gh = []) {
  let n = 0, fixed = 0;
  for (const t of threads) { const r = replies[t.id] ?? []; n += r.length + ghRepliesTo(gh, t.ghId).length; if (r[r.length - 1]?.status === "fixed") fixed++; }
  return { threads: threads.length, replies: n, fixed };
}

// ---- the agent: replies contract, follow-ups, and the preview before anything is typed into its session

// The contract appended to a review sent to the agent (mirrors the findings' report contract of fixPrompt).
export function repliesContract(file, id) {
  return `Answer each point once it is handled: append one JSON line per point to ${file}, for example\n` +
    `echo '{"id": "${id ?? "<id>"}", "reply": "briefly, what you did or your answer", "status": "fixed", "commit": "<sha>"}' >> ${file}\n` +
    `(status: fixed with the commit, answered for a question, wontfix with the reason, question when you need an answer from the reviewer).`;
}

// A follow-up in one thread: the comment, what was said so far, the new words, the same contract.
export function followupPrompt({ pr, thread, replies = [], text, file, lang }) {
  const said = threadView(thread, replies).entries.map((e) => `${e.who === "you" ? "Reviewer" : "You"}: ${e.text}`);
  return [`${pr ? `PR #${pr.number} "${pr.title}"` : "This branch"}: a follow-up on review point [${thread.id}] \`${thread.file}\`${thread.start === undefined ? "" : ` ${lineLabel(thread)}`}.`,
    thread.hunk ? "```diff\n" + thread.hunk + "\n```" : null, `Reviewer: ${thread.text}`, ...said, `Reviewer: ${text.trim()}`, repliesContract(file, thread.id)]
    .filter(Boolean).join("\n\n") + answerIn(lang);
}

// The preview of a send: own (the reviewer's words, shown apart) and the whole text, which the user may edit; confirm
// gives back exactly what goes out. send() is only called with confirm's result.
export const preview = ({ what, agent, own, prompt }) => ({ what, agent, own: own ?? "", prompt, text: prompt });
export const confirm = (p, edited) => ({ what: p.what, text: edited ?? p.text });
// Who it goes to, in words: the agent's tab, its main conversation (never a sub-agent's), or what opens instead.
export function agentLabel(agent, fallback) {
  if (!agent) return fallback;
  return `${agent.tab_name || agent.title || "Agent"} · ${agent.parent ? "a sub-agent (not the main conversation)" : "main conversation"}`;
}

// ---- GitHub: exactly what is ticked goes out

// off: the ids unticked; summaryOn: the summary ticked. ready: something to post (a verdict alone counts).
export function ghPlan({ comments, off = new Set(), summary = "", summaryOn = true, event = "comment", commit, lines, repo, login = null }) {
  const picked = withIds(comments).filter((c) => !off.has(c.id));
  const { payload, outside } = ghReview({ comments: picked, event, summary: summaryOn ? summary : "", commit, lines });
  const n = payload.comments.length, word = { comment: "Comment", approve: "Approve", request_changes: "Request changes" }[event] ?? (event === null ? "no verdict chosen yet" : "Comment");
  const ready = n > 0 || Boolean(payload.body) || payload.event !== "COMMENT";
  const what = [n ? `${n} ${n === 1 ? "comment" : "comments"}` : null, payload.body ? "a review body" : null].filter(Boolean).join(" and ") || "a review";
  // label: the button (short); target: the line above it, which says who posts where (it wraps, never clipped).
  return { payload, outside, picked, ready, label: `Post ${what}`, target: `as ${login ?? "your gh login"} · ${repo ?? "GitHub"} · ${word}` };
}

// One line comment posted at once (POST repos/{o}/{r}/pulls/{n}/comments); null when GitHub can't take it on a line.
export function singlePayload(c, commit, inDiffNow) {
  if (!inDiffNow) return null;
  const side = c.old ? "LEFT" : "RIGHT";
  return { commit_id: commit, path: c.file, line: c.end, side, ...(c.start !== c.end ? { start_line: c.start, start_side: side } : {}), body: c.text.trim() };
}

// What a GitHub post carried, for the popover afterwards: the body and each line comment.
export const postedItems = (payload) => [...(payload.body ? [`Review body: ${payload.body.slice(0, 120)}`] : []),
  ...payload.comments.map((c) => `${c.path}:${c.start_line ? `${c.start_line}–` : ""}${c.line}: ${c.body.slice(0, 120)}`)];

// ---- Fix: comments (and findings) to a sub-agent in its own worktree, or to the main agent; the selection

export const MAX_FIXES = 30;
export const selectedOf = (doc, key) => doc?.[key]?.selected ?? [];
// The selection for "Fix selected": comment ids, kept per PR.
export const toggleSelected = (doc, key, id, now = Date.now()) => {
  const sel = selectedOf(doc, key);
  return bound(doc, key, threadsOf(doc, key), now, { selected: sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id] });
};
export const clearSelected = (doc, key, now = Date.now()) => bound(doc, key, threadsOf(doc, key), now, { selected: [] });

// Fix jobs: {id, branch, path (its worktree), base (the PR's checkout), head (where the branch starts), items: [{kind:
// "comment" | "finding", id}], terminal, target: "sub" | "main", at, state: "running" | "applied" | "discarded"}.
// A sub-agent's fix stays on its branch until the reviewer applies it; nothing hands it on by itself.
export const fixesOf = (doc, key) => doc?.[key]?.fixes ?? [];
export const addFix = (doc, key, job, now = Date.now()) => bound(doc, key, threadsOf(doc, key), now, { fixes: [...fixesOf(doc, key).filter((f) => f.id !== job.id), job].slice(-MAX_FIXES) });
export const setFix = (doc, key, id, change, now = Date.now()) => bound(doc, key, threadsOf(doc, key), now, { fixes: fixesOf(doc, key).map((f) => (f.id === id ? { ...f, ...change } : f)) });
// The live job (not applied or discarded) an item belongs to.
export const fixFor = (doc, key, id) => [...fixesOf(doc, key)].reverse().find((f) => f.state === "running" && f.items.some((x) => x.id === id)) ?? null;

// A fix branch per job: fix/<pr number>-<first item>.
export const fixBranch = (number, ids) => `fix/${number ?? "pr"}-${String(ids[0] ?? "x").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 12)}${ids.length > 1 ? `-and-${ids.length - 1}` : ""}`;
// Where its worktree goes (Herdr's convention for worktrees): ~/.herdr/worktrees/<repo>/<branch with - for />.
export const fixPath = (home, repo, branch) => `${home}/.herdr/worktrees/${String(repo ?? "repo").split("/").pop()}/${branch.replace(/\//g, "-")}`;

// Where a fix branch starts: at the PR's head (the commit the review shows), not at whatever the local clone has
// checked out, which may be another branch. A space's own branch diff has no head apart from its checkout.
export const fixStart = ({ local = false, prHead = null, checkoutHead = null }) => (local ? checkoutHead : prHead) || checkoutHead || null;

// The commit a job's items report (a comment's reply or a finding's report with status fixed); null while none.
export function fixCommit(job, replies = {}, reports = {}) {
  for (const it of job.items) {
    const r = it.kind === "finding" ? reports[it.id] : (replies[it.id] ?? []).at(-1);
    if (r?.status === "fixed" && r.commit) return r.commit;
  }
  return null;
}

// ---- a fix checked on its own branch, before it is in the PR (verify.py)

// The findings whose fix can be checked there: the newest job is a live sub-agent one (its worktree is still there)
// and the agent's report names a commit that was not checked yet. Settled findings are left alone.
export function branchChecks(findings, fixes, status, reports, statusOf) {
  return findings.flatMap((f) => {
    const job = [...fixes].reverse().find((j) => j.items.some((x) => (f.ids ?? [f.id]).includes(x.id)));
    const r = reports[f.id], commit = r?.status === "fixed" && r.commit ? String(r.commit) : null;
    if (!commit || job?.state !== "running" || job.target !== "sub" || !job.path || !job.head) return [];
    return status[f.id]?.verify?.head === commit || ["fixed", "dismissed"].includes(statusOf(f)) ? [] : [{ f, job, commit }];
  });
}
// verify.py's verdicts for those: kept next to the finding as {verify: {result, reason, head: the commit, branch, at}}
// and never as its state. "Fixed" stays with a passed check on the PR head (pr.js applyVerification).
export function applyBranchChecks(status, results, checks, now) {
  const out = { ...status }, at = new Date(now).toISOString();
  for (const r of results ?? []) {
    const c = checks.find((x) => x.f.id === r.id);
    if (c) out[r.id] = { ...status[r.id], verify: { result: r.verdict, reason: r.reason ?? "", head: c.commit, branch: c.job.branch, at } };
  }
  return out;
}
// A finding's check in words (v: its status' verify, or none): on the PR head, or on the fix branch, which never
// reads "fixed" because the PR does not have the fix yet. short: for one line in a card.
export function checkText(v, short = false) {
  if (!v) return short ? "not verified" : "Not verified. Verify checks a reported commit on its fix branch, and the PR head once the fix is pushed there.";
  const word = String(v.result).replace("_", " "), at = String(v.head ?? "").slice(0, 7), why = v.reason ? `: ${v.reason}` : ".";
  if (!v.branch) return short ? `verified: ${word}` : `Verified at ${at}: ${word}${v.reason ? `, ${v.reason}` : ""}`;
  const head = { fixed: "Verified on the fix branch, not in the PR yet", not_fixed: "Not fixed on the fix branch" }[v.result] ?? "Unclear on the fix branch";
  return short ? head[0].toLowerCase() + head.slice(1) : `${head} (${v.branch} at ${at})${why}`;
}

// What the sub-agent is told on top of the comments or findings: its worktree, its branch, commit there, and that
// this is where its work ends: it never pushes and never hands the fix on. The reviewer decides what happens to it.
export const worktreeNote = (branch, path) => `You work in your own git worktree ${path} on branch ${branch}, started from the PR head. ` +
  `Make the change there, commit it on ${branch} (one commit per point is fine), then stop: never push, and do not hand the fix to another agent or session. ` +
  `It stays on ${branch} until the reviewer applies it to the PR.`;

// What the PR's agent does with a ready fix once the reviewer hands it over ("Hand over…", applyPrompt): cherry-pick,
// tests, push, then the fix worktree and branch go.
const takeOver = ({ branch, head, path }) => `Please take it over: on your PR branch run git cherry-pick ${head}..${branch}, resolve conflicts if any, run the tests, ` +
  `and push to the PR branch. Then remove the fix worktree and branch: git worktree remove ${path} && git branch -D ${branch}`;
// The comments as one fix task, with ids and the replies contract (each point answered with status fixed and the commit).
export function fixCommentsPrompt({ pr, comments, file, lang, branch = null, path = null }) {
  const items = withIds(comments).map((c, i) => [`${i + 1}. [${c.id}] \`${c.file}\`${c.start === undefined ? "" : ` ${lineLabel(c)}`}`, c.hunk ? "```diff\n" + c.hunk + "\n```" : null, c.text.trim()].filter(Boolean).join("\n"));
  return [`${pr ? `PR #${pr.number} "${pr.title}"${pr.url ? ` (${pr.url})` : ""}` : "This branch"}: please fix ${comments.length === 1 ? "this review comment" : `these ${comments.length} review comments`}.`,
    branch ? worktreeNote(branch, path) : null, ...items, repliesContract(file, withIds(comments)[0]?.id)].filter(Boolean).join("\n\n") + answerIn(lang);
}

// hc run for the sub-agent: under the PR's agent (parent) so it shows there, in its worktree, on the PR's context
// (env: the context's command prefix), no notes typed into the parent.
export function subAgentArgs({ parent, cwd, name, env = [], task, job, auto = false }) {
  return ["run", "--bg", "--json", "--no-notify", "--name", name, "--cwd", cwd, ...(parent ? ["--parent", parent] : ["--no-parent"]),
    "--label", `pr-review.fix=${job}`, "--", ...env, "claude", "--disallowedTools", ...NO_PUSH, ...permissionArgs(auto), task];
}
// A fix agent never pushes, never opens a PR and never hands its fix to another session (hc send): the task says so,
// and these deny rules refuse the commands in any permission mode. The list takes any number of rules, so an option with one value has to follow it (permissionArgs).
// ponytail: a guard for the plain commands, not a sandbox (a push wrapped in a script gets past it).
export const NO_PUSH = ["Bash(git push)", "Bash(git push *)", "Bash(gh pr create *)", "Bash(gh pr merge *)", "Bash(hc send *)"];
// A trusted PR: auto (the classifier approves the harmless commands, reads, edits, commit, tests, and asks about risky
// ones). An untrusted one: the task quotes its text and findings, which may carry injected instructions, and its
// checkout's .claude/settings.json could allow anything or run hooks, so: manual, said outright (not left to the
// settings), and only the user's own settings (the review shows "waits for your OK").
export function permissionArgs(trusted) {
  return trusted ? ["--permission-mode", "auto"] : ["--permission-mode", "manual", "--setting-sources", "user"];
}

// Apply to PR: a cherry-pick of the branch's commits onto the PR's checkout, only when that checkout is clean.
// onHead: false when that checkout does not contain the commit the fix started from (it is on another branch than the
// PR's): a cherry-pick there would put the fix on the wrong branch.
export function applyPlan({ status, head, branch, onHead = true, where = null }) {
  if (!onHead) return { ok: false, off: true, reason: `The local checkout is on ${where || "another branch"}, which does not contain the PR head ${String(head).slice(0, 7)} the fix starts from. ` +
    `Check out the PR's branch there and apply again, or run git cherry-pick ${String(head).slice(0, 7)}..${branch} on the PR's branch yourself. The fix branch stays.` };
  const dirty = String(status ?? "").split("\n").filter((l) => l.trim());
  if (dirty.length) return { ok: false, reason: `The PR's checkout has ${dirty.length} uncommitted ${dirty.length === 1 ? "change" : "changes"}: Apply needs a clean checkout.` };
  return { ok: true, args: ["cherry-pick", `${head}..${branch}`] };
}
// The hand-over when the checkout isn't clean: the reviewer asks the main agent to take the fix over, through a preview.
export const applyPrompt = (job) => `The reviewer's fix is ready on branch ${job.branch} (worktree ${job.path}). ${takeOver(job)}.`;

// ---- the Comments tab and the Show switch

// "ai" (the stored key) is the findings and the AI notes under their lines.
export const SHOW_KINDS = [["mine", "Yours"], ["ai", "Findings"], ["agents", "Agents"], ["github", "GitHub"], ["notes", "Notes"]];
export const showOf = (s) => Object.fromEntries(SHOW_KINDS.map(([k]) => [k, s?.[k] !== false])); // all on by default
// Every comment of the PR as a row for the Comments tab: pending ones, sent threads (with their state and replies),
// other people's GitHub comments, notes. state: pending | waiting | replied | fixed | declined | github | note.
// stale(id): the person's own comment or note whose lines changed since (pr.js isStale).
export function commentRows({ pending = [], threads = [], replies = {}, gh = [], ghOwn = () => false, notes = [], stale = () => false }) {
  // A comment taken from an AI note or a finding is yours once it is pending.
  const rows = withIds(pending).map((c) => ({ id: c.id, kind: "pending", src: "mine", file: c.file, line: c.end, old: Boolean(c.old), text: c.text, state: "pending", replies: 0, stale: stale(c.id) }));
  for (const t of threads) {
    const r = replies[t.id] ?? [], last = r.at(-1)?.status, g = ghRepliesTo(gh, t.ghId).length;
    const state = last === "fixed" ? "fixed" : last === "wontfix" ? "declined" : last || g ? "replied" : "waiting";
    rows.push({ id: t.id, kind: "thread", src: "mine", file: t.file, line: t.end, old: Boolean(t.old), text: t.text, state, replies: r.length + g, route: t.route, stale: stale(t.id) });
  }
  for (const g of gh) if (!ghOwn(g) && !g.in_reply_to_id) rows.push({ id: `gh${g.id}`, kind: "gh", src: "github", file: g.path, line: g.line ?? g.original_line ?? 0, old: g.side === "LEFT", text: g.body ?? "", state: "github",
    replies: gh.filter((x) => x.in_reply_to_id === g.id).length, author: g.user, resolved: Boolean(g.resolved), outdated: Boolean(g.outdated) });
  for (const p of notes) if (p.anchor?.file) rows.push({ id: p.id, kind: "note", src: "notes", file: p.anchor.file, line: p.anchor.end, old: Boolean(p.anchor.old), text: p.summary, state: "note", replies: 0, stale: stale(p.id) });
  return rows.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

// ---- GitHub comments: resolved threads, bots, outdated ones

// The review threads' state (GraphQL reviewThreads nodes {resolved, outdated, id: the first comment's databaseId})
// onto the REST comments: a thread's first comment has that id, its replies point to it with in_reply_to_id.
export function withThreadState(gh, threads = []) {
  const by = new Map(threads.filter((t) => t?.id != null).map((t) => [t.id, t]));
  return gh.map((g) => { const t = by.get(g.in_reply_to_id ?? g.id); return t ? { ...g, resolved: Boolean(t.resolved), outdated: Boolean(g.outdated || t.outdated) } : g; });
}
export const isBot = (g) => g.user_type === "Bot" || /\[bot\]$/.test(g.user ?? "");
// Bots comment again on every push: per bot only its comments on the commit it reviewed last (the newest comment's
// commit_id) stay, with the replies to them. People's comments always stay. hidden: how many went.
export function latestBotComments(gh) {
  const last = {};
  for (const g of gh) if (isBot(g) && !g.in_reply_to_id && (!last[g.user] || String(g.at) > String(last[g.user].at))) last[g.user] = g;
  const drop = new Set(gh.filter((g) => isBot(g) && !g.in_reply_to_id && g.commit_id !== last[g.user].commit_id).map((g) => g.id));
  const kept = gh.filter((g) => !drop.has(g.id) && !drop.has(g.in_reply_to_id));
  return { kept, hidden: gh.length - kept.length };
}
// What the review shows of GitHub's comments: older bot comments only with allBots, resolved threads only with
// resolved. Counts for the switches: resolved threads (after the bot filter) and the bot comments hidden.
export function ghShown(gh, { resolved = false, allBots = false } = {}) {
  const { kept, hidden } = latestBotComments(gh ?? []), list = allBots ? gh ?? [] : kept;
  return { list: resolved ? list : list.filter((g) => !g.resolved), resolved: list.filter((g) => g.resolved && !g.in_reply_to_id).length, botsHidden: hidden };
}
// "5 comments · 2 pending · 1 sent to an agent · 2 reported fixed": a comment's own states. "Fixed" alone is a
// finding's word, after a verification; here the agent only says so.
export function commentSummary(rows) {
  const mine = rows.filter((r) => r.kind === "pending" || r.kind === "thread"), n = (s) => mine.filter((r) => r.state === s).length;
  return [`${mine.length} ${mine.length === 1 ? "comment" : "comments"}`, n("pending") && `${n("pending")} pending`, n("waiting") && `${n("waiting")} sent to an agent`,
    n("replied") && `${n("replied")} replied`, n("fixed") && `${n("fixed")} reported fixed`, n("declined") && `${n("declined")} declined`].filter(Boolean).join(" · ");
}
// The Comments list: what the Show switch's kinds let through (state: "all", or one state).
export const filterRows = (rows, state, show) => rows.filter((r) => show[r.src] !== false && (state === "all" || r.state === state));
// The Show switch's counts: comments per kind in the diff; ai: the unresolved findings, the Findings tab's number.
export const showCounts = ({ rows, findings = 0, agents = 0 }) => ({ mine: rows.filter((r) => r.src === "mine").length, ai: findings, agents,
  github: rows.filter((r) => r.src === "github").length, notes: rows.filter((r) => r.src === "notes").length });

// ---- what a send preview says before an agent starts (review.js sendPopover)

// The facts above the buttons, as [label, text] rows: who runs it and on which account, what it gets, what it may do,
// whether it can push, what comes back and what it costs. kind: "sub" (a fix agent in its own checkout), "main" (the
// PR's live agent session), "new" (a new agent tab for a question), "live" (a question put into a live agent's
// input: nothing starts), "resume" (the PR's session, resumed in a new tab), anything else: a live session.
export function sendFacts({ kind, account, trusted = false, branch = null, name = null, chat = false, where = null }) {
  const own = kind === "sub" || kind === "new", who = name ?? "the agent";
  const starts = { new: `A new agent in a new tab, in the review's checkout of the PR head${where ? ` (${where})` : ""}.`,
    live: `Nothing new. The text goes into the ${chat ? "chat box" : "terminal"} of ${who} as a draft, and you send it there.`,
    resume: `The PR's own session again, in a new tab${where ? ` in ${where}` : ""}. The text is on your clipboard to paste there.` }[kind];
  const may = kind === "sub" ? (trusted ? "Edit files, run commands and commit in its checkout without asking (auto mode). Risky commands still ask you."
    : "Nothing without your OK: this is someone else's PR, so it asks before every edit and command.")
    : kind === "new" ? "Read and answer. It asks you before every edit and command (manual mode)." : "Whatever that session allows, in the PR's checkout itself.";
  const result = kind === "sub" ? `A commit on ${branch ?? "its branch"} and a report here. Nothing reaches the PR until you apply it.`
    : kind === "main" ? "Commits in the PR's checkout and a report here." : `An answer in ${kind === "new" ? "the new tab" : "that session"}. The finding stays as it is.`;
  return [
    starts && ["Starts", starts],
    ["Runs as", own ? account : `${name ?? "The PR's session"}, on its own account and with its own permissions.`],
    ["Gets", own ? "The text below and every file it opens in its checkout. All of it goes to the provider." : "The text below. The session reads what it needs in its own checkout."],
    ["May", may],
    ["Push", kind === "sub" ? "Never: git push and gh pr create are denied, and the task forbids them." : kind === "new" ? "Only if you approve the command." : "Possible. Nothing here prevents it."],
    ["Result", result],
    ["Cost", own ? `Not capped and not estimated; billed to that account.${kind === "sub" ? " One finding usually takes a few minutes." : ""}` : "Billed to that session's account."],
  ].filter(Boolean);
}

// ---- Finish your review: what the findings say about the verdict

// The verdict the findings suggest (c: pr.js findingCounts): shown next to the choice and never chosen for the
// reviewer, since the findings are a model's claims.
export function suggestVerdict(c) {
  const are = (n) => (n === 1 ? "finding is" : "findings are");
  if (c?.high) return { event: "request_changes", why: `${c.high} unresolved ${are(c.high)} of high severity` };
  if (c?.unresolved) return { event: "comment", why: `${c.unresolved} ${are(c.unresolved)} unresolved, none of high severity` };
  return null;
}
// The verdict in force (picked: the reviewer's choice or null; c: findingCounts): the pick, else "comment" as on
// GitHub. While a finding of high severity is unresolved nothing is chosen for the reviewer: null, and Submit waits.
export const verdictOf = (picked, c) => picked ?? (c?.high > 0 ? null : "comment");
// "Insert blockers": the unresolved findings from high up as a review body to edit. It starts with a sentence that
// counts them, then one line per finding with its file and line. A security finding goes in with its title only (no
// place, no detail): the text is public once it is posted. AI notes are not findings and never part of it.
export function blockersDraft(findings) {
  const high = (findings ?? []).filter((f) => f.severity === "high" || f.severity === "critical"), n = high.length;
  if (!n) return "";
  return `${n} ${n === 1 ? "finding needs" : "findings need"} a change before this can merge.\n\n`
    + high.map((f) => (f.security ? `- Security: ${f.title}` : `- \`${f.file}:${f.line}\`: ${f.title}`)).join("\n");
}

// ---- the "Run review" popup: one line per run

// r: a run of pr.js runsOf (or none), others: the findings the other sources have. A zero says what it means: the
// reviewer ran and found nothing, which is not "not run". times: {running, took, ago} as text.
export function runLine(r, others = 0, times = {}) {
  const auto = r?.auto ? ` · Started by itself: ${r.auto}` : ""; // the security trigger's reasons
  if (r?.state === "running") return ["Running", times.running].filter(Boolean).join(" · ") + auto;
  if (r?.state === "failed") return `Failed: ${r.error ?? "no result"}${auto}`;
  if (r?.state !== "done") return "Not run on this PR yet";
  const n = r.count ?? 0, found = n ? `${n} ${n === 1 ? "finding" : "findings"}` : `No findings${others ? `. It reviews on its own; the other sources have ${others}` : ""}`;
  return [found, r.cost != null ? `$${Number(r.cost).toFixed(3)}` : null, times.took, times.ago].filter(Boolean).join(" · ") + auto;
}

// ---- a finding as a review comment (review.js "Add to review", "Ask an agent…")

// The comment made from a finding, as Markdown for GitHub. It goes out under the reviewer's name and reads like their
// own words: the title bold in the first line (one sentence: what is wrong or what to do), the detail as its own
// paragraph, then the suggestion as its own paragraph. No severity, category or source labels. Markdown in the
// detail and the suggestion stays as written (inline code, lists, code blocks). A suggestion with a code block goes
// into a folded block so the comment stays short (fold: false for a text an agent reads); a short one stays open.
export function findingCommentText(f, { fold = true } = {}) {
  const md = (x) => String(x ?? "").replace(/\r\n/g, "\n").trim();
  const title = md(f.title).replace(/\s*\n\s*/g, " "), detail = md(f.detail), sug = md(f.suggestion);
  const suggested = !sug ? "" : sug.includes("```") && fold ? `<details><summary>Suggested fix</summary>\n\n${sug}\n\n</details>`
    : sug.includes("\n") ? `Suggested:\n\n${sug}` : `Suggested: ${sug}`;
  return [title && `**${title}**`, detail, suggested].filter(Boolean).join("\n\n");
}

