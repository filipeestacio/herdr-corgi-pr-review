// Pure helpers for the panel's state (main.js) and a layer's flow picture (stack.js visualCard). No gpui imports, so
// node tests them (test_views.mjs).
import { transitionText } from "./arch.js";

// The panel is either picking a PR (none chosen yet, or PRs ▾ open) or showing the chosen one (its diff or walkthrough).
// chosen: a PR, or the current branch picked from the list.
export const panelState = ({ chosen, picking }) => (!chosen || picking ? "picking" : "selected");

// The body tab of a chosen PR: "walk" or "diff" (Setup has its own page).
export const bodyTab = (view) => (view === "walk" ? "walk" : "diff");

// In progress: the newest `max` unless all are asked for; more: how many are left out.
export const IN_PROGRESS_MAX = 3;
export function capped(list, all = false, max = IN_PROGRESS_MAX) {
  return all ? { shown: list, more: 0 } : { shown: list.slice(0, max), more: Math.max(0, list.length - max) };
}

// ---- the PR list (main.js picker)

// Open and draft PRs first; merged and closed ones are their own group, folded, without a way into the review.
export const isOpenPr = (p) => p.state === "open" || p.state === "draft";
export const byState = (list) => ({ open: list.filter(isOpenPr), done: list.filter((p) => !isOpenPr(p)) });

// One row per PR: the ones shown under "In progress" leave the list (above: how many). started: the review in
// progress of a PR by url, so a row that stays (over the cap there) resumes instead of starting again.
export function listRows(list, inProgress, shown) {
  const top = new Set(shown.map((r) => r.url)), rest = list.filter((p) => !top.has(p.url));
  return { list: rest, above: list.length - rest.length, started: new Map(inProgress.map((r) => [r.url, r])) };
}

// A row's risk signal, from cached files only (null without any): the highest severity among the open findings, and
// whether one of them is about security. analysis: a mapReview result (its layers' findings); findings and status:
// the reviewers' findings file. A fixed or dismissed finding is settled; a fix that was only sent is not.
const SEVERITIES = ["critical", "high", "medium", "low"];
export function riskSignal({ analysis = null, findings = null, status = null } = {}) {
  if (!analysis && !findings) return null;
  const open = [...(findings ?? []), ...(analysis?.steps ?? []).flatMap((s) => s.findings ?? [])].filter((f) => !["fixed", "dismissed"].includes(status?.[f.id]?.s));
  return { top: SEVERITIES.find((s) => open.some((f) => f.severity === s)) ?? null, open: open.length,
    security: open.some((f) => f.reviewer === "security" || f.category === "security") };
}

// "0/6 layers · 2/9 files · 1 comment · 11 open findings" for a review in progress (open-reviews.json `progress`,
// whose fields keep their names: steps, stepsChecked).
export function progressText(p = {}) {
  const n = (count, one, many) => (count ? `${count} ${count === 1 ? one : many}` : null);
  return [p.steps ? `${p.stepsChecked ?? 0}/${p.steps} layers` : null, p.files ? `${p.filesViewed ?? 0}/${p.files} files` : null,
    n(p.comments, "comment", "comments"), n(p.replies, "reply", "replies"), p.fixedThreads ? `${p.fixedThreads} fixed` : null,
    n(p.findingsOpen, "open finding", "open findings")].filter(Boolean).join(" · ");
}

// "3 pending comments in 2 files": what "Finish your review" would take along.
export function pendingText(comments) {
  const n = comments.length, files = new Set(comments.map((c) => c.file)).size;
  return `${n} pending ${n === 1 ? "comment" : "comments"} in ${files} ${files === 1 ? "file" : "files"}`;
}

// A flow (or a layer's architecture) visual as archLayout's input: its groups, else one implicit group for all nodes;
// a node's note is its card's description; `changed` becomes status "changed"; an edge's text is its label (or
// "event [guard] / action"). Sources (implemented, existing, spec) pass through, so the cards style the same way.
export function flowArch(v) {
  const groups = (v?.groups ?? []).filter((g) => g?.id);
  const implicit = groups.length ? null : { id: "flow", label: "", kind: "" };
  const status = (x) => x.status ?? (x.changed ? "changed" : undefined);
  return {
    groups: implicit ? [implicit] : groups,
    nodes: (v?.nodes ?? []).map((n) => ({ id: n.id, label: n.label ?? n.id, description: n.description ?? n.note ?? "", type: n.type,
      group: implicit ? implicit.id : n.group, status: status(n), source: n.source, at: n.at, evidence: n.evidence })),
    edges: [...(v?.edges ?? []), ...(v?.transitions ?? [])].map((e) => ({ from: e.from, to: e.to, label: transitionText(e),
      status: status(e), source: e.source, evidence: e.evidence, dashed: e.dashed })),
  };
}

// One wheel/trackpad event over a sideways scroller inside the scrolling page (review.js hscroll). g: the gesture so
// far ({axis, at} | null); a gesture keeps the axis it starts with (mostly sideways: only the picture moves; mostly
// down: the page scrolls) and ends after GESTURE_MS without an event or on a new touch; shift+wheel is sideways.
// Gives the gesture, the offset clamped to [0, max] and used (the picture took the event: the page must not).
export const GESTURE_MS = 150;
export function wheelStep(g, { dx = 0, dy = 0, t, phase, shift = false }, x, max) {
  let axis = phase === "started" || !g || t - g.at > GESTURE_MS ? null : g.axis;
  if (!axis && (dx || dy)) axis = Math.abs(dx) > Math.abs(dy) || shift ? "x" : "y";
  const used = axis === "x" && max > 0, clamp = (v) => Math.max(0, Math.min(max, v));
  return { g: { axis, at: t }, x: clamp(used ? x - (dx || (shift ? dy : 0)) : x), used };
}

// gh pr diff refuses PRs over 300 files (HTTP 406 / too_large): then the diff is made from a local clone.
export const diffTooLarge = (msg) => /HTTP 406|exceeded the maximum number of files|too_large/i.test(String(msg));

// The "List pull request files" API's files as gh-pr-diff-shaped text (pr.js splitPatch). A file without a patch
// (binary, or too large for GitHub) keeps its header and a note.
export function filesToDiff(files) {
  const out = [];
  for (const f of files) {
    const from = f.previous_filename ?? f.filename, added = f.status === "added", removed = f.status === "removed";
    out.push(`diff --git a/${from} b/${f.filename}`);
    if (added) out.push("new file mode 100644");
    else if (removed) out.push("deleted file mode 100644");
    else if (f.status === "renamed") out.push(`rename from ${from}`, `rename to ${f.filename}`);
    if (f.patch) out.push(`--- ${added ? "/dev/null" : `a/${from}`}`, `+++ ${removed ? "/dev/null" : `b/${f.filename}`}`, f.patch);
    else out.push(`Binary files a/${from} and b/${f.filename} differ`, `No diff from GitHub for this file (binary or too large): +${f.additions ?? 0} -${f.deletions ?? 0}`);
  }
  return out.join("\n") + "\n";
}

// ---- files folded when a review opens: lock files and generated output, and big changes (click the header to open)
const LOCK = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|Gemfile\.lock|composer\.lock|go\.sum|flake\.lock|gradle\.lockfile|[^/]*\.lock|[^/]*\.min\.(js|css)|[^/]*\.map)$/;
export const FOLD_LINES = 400;
export const foldOnOpen = (patch) => (patch ?? []).filter((f) => LOCK.test(f.path) || (f.add ?? 0) + (f.del ?? 0) > FOLD_LINES).map((f) => f.path);

// ---- the Files list's room (review.js filesItems): gpui-kit's virtual list holds at most 10000 items, so a big PR
// opens the files around where you read and folds the rest; each folded file keeps its height as one tall item, so
// the scrollbar spans the whole PR and nothing jumps when files open or fold while you scroll.
// files: the files that could open, in document order: {path, i (place in the PR), n (rows)}. Which fold
// (overBudget): the file at `center` first, then the ones you opened last (the newest RECENT), then the nearest
// to `center`, below before above on a tie; what doesn't fit in `cap` rows folds.
export const RECENT = 8;
export function allocate({ files, center = 0, recent = [], cap }) {
  const rank = new Map(recent.slice(0, RECENT).map((p, i) => [p, i]));
  const key = (f) => (f.i === center ? 0 : rank.has(f.path) ? 1 + rank.get(f.path) : 1e6 + 2 * Math.abs(f.i - center) + (f.i < center ? 1 : 0));
  const over = new Set();
  let used = 0;
  for (const f of [...files].sort((a, b) => key(a) - key(b))) { if (used + f.n > cap) over.add(f.path); else used += f.n; }
  return over;
}

// Index of the last sorted value <= x (0 when none): the file whose header is at or above an item.
export function lastAtOrBelow(sorted, x) {
  let lo = 0, hi = sorted.length - 1, k = 0;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (sorted[m] <= x) { k = m; lo = m + 1; } else hi = m - 1; }
  return k;
}

// Whether to open the files around the view again, and around which file (null: leave it). heads: the item index
// of each file's header, in order; top: each item's y (top[i], one past the last too); folds: [top, bottom] of the
// folded files' items, in order; start..end: the items on screen; center: the file the room was given around.
// Only when a folded file is within `margin` px of the view and you have moved to another file: scrolling inside
// the open part changes nothing, so it doesn't reshuffle while you read.
export function recenter({ heads, top, folds, start, end, center, margin }) {
  if (!folds.length || !heads.length) return null;
  const at = lastAtOrBelow(heads, start);
  if (at === center) return null;
  const y0 = top[start] - margin, y1 = top[Math.min(end, top.length - 1)] + margin;
  let lo = 0, hi = folds.length; // the first fold that ends below y0
  while (lo < hi) { const m = (lo + hi) >> 1; if (folds[m][1] < y0) lo = m + 1; else hi = m; }
  return lo < folds.length && folds[lo][0] <= y1 ? at : null;
}

// A sideways scroller's visible width (review.js hscroll): its measured width less what the Ask drawer covers at the
// right, so the scroll reaches the picture's last columns; never under 100 px.
export const hsVisible = (measured, covered = 0) => Math.max(100, measured - covered);

// ---- bringing a list item to the top of its view (review.js settleTop)

// The kit's scroll_to_item(i, "top") reveals an item at the near edge: one below the view lands at the view's bottom.
// To land item i at the top from anywhere, the view first goes just past it: this is the item to centre for that, the
// first whose centre lies more than half a view below i's top, so i's top is cut off above by less than that item's
// height. "top" on i itself then pulls it exactly to the top edge. sizes: every item's height; viewH: the list's.
export function pastTop(sizes, i, viewH) {
  let y = 0;
  for (let k = 0; k < i; k++) y += sizes[k];
  const want = y + viewH / 2;
  for (let j = i; j < sizes.length; j++) { if (y + sizes[j] / 2 > want) return j; y += sizes[j]; }
  return sizes.length - 1; // less than a view below it: the list's end, which is as high as it gets
}

// ---- the review's left column

// The layers in the analysis' order (closest reading first) and in reading order: do the two lists differ? Only then
// is a switch between them worth showing.
export const orderDiffers = (steps) => [...steps].sort((a, b) => a.order - b.order).some((s, i) => s !== steps[i]);

// What a layer row or a file row says about its unresolved findings: the highest severity with its count ("2 high"),
// every severity in words for the tooltip, and how many are security findings. null without findings.
export function worst(findings) {
  if (!findings.length) return null;
  const n = {};
  for (const f of findings) n[f.severity] = (n[f.severity] ?? 0) + 1;
  const order = [...SEVERITIES, ...Object.keys(n).filter((k) => !SEVERITIES.includes(k))].filter((k) => n[k]);
  return { severity: order[0], count: n[order[0]], total: findings.length, label: `${n[order[0]]} ${order[0]}`,
    words: order.map((k) => `${n[k]} ${k}`).join(", "), security: findings.filter((f) => f.security).length };
}

// Merge blockers for "Needs your attention": by severity, security first within one severity, else in their order.
export function byUrgency(blockers, security = () => false) {
  const rank = (b) => { const i = SEVERITIES.indexOf(b.severity); return i < 0 ? SEVERITIES.length : i; };
  return blockers.map((b, i) => ({ b, i, sec: security(b) ? 0 : 1 })).sort((x, y) => rank(x.b) - rank(y.b) || x.sec - y.sec || x.i - y.i).map((x) => x.b);
}

// ---- what a finding claims (an open card in the diff; any other place that names the same facts)

// The scale behind a severity: the analysis names a finding's impact, and the impact fixes the severity.
export const IMPACT = {
  breaks_requirement: ["high", "it breaks a requirement of the task"], dead_path: ["high", "it leaves the new path without effect"],
  unauthorized_access: ["high", "it allows access without permission"], data_exposure: ["high", "it exposes data"], data_loss: ["high", "it loses data"],
  edge_case: ["medium", "it fails in an edge case"], degraded_operation: ["medium", "it makes the system harder to operate"],
  fragile_structure: ["medium", "it makes the structure fragile"], untested: ["medium", "it is not covered by a test"],
  maintainability: ["low", "it makes the code harder to maintain"], unrequested: ["low", "the task did not ask for it"],
};
export const CERTAINTY = { confirmed: "Confirmed: something that ran shows it.", derived: "Derived: it follows from the code that was read.",
  assumed: "Assumed: it depends on something that could not be checked." };

// The help text of a severity chip: the whole scale, one line per severity.
export const SEVERITY_SCALE = ["high", "medium", "low"].map((s) => `${s}: ${Object.values(IMPACT).filter(([sev]) => sev === s).map(([, why]) => why).join(", ")}.`).join("\n");

// A finding's facts as [label, text] rows: why it has its severity, its effect, how sure the claim is, and what has
// to hold for it to happen. A finding from an older analysis has none of these fields and gives no rows.
export function factRows(f) {
  const why = IMPACT[f?.impact]?.[1], known = Boolean(f?.effect || f?.certainty);
  return [why && ["Severity", `${f.severity ?? IMPACT[f.impact][0]}, because ${why}.`], f?.effect && ["Effect", f.effect],
    CERTAINTY[f?.certainty] && ["Certainty", CERTAINTY[f.certainty]],
    f?.preconditions?.length ? ["Preconditions", f.preconditions.join("; ")] : known && ["Preconditions", "None: it always happens."]].filter(Boolean);
}

// The line a finding's card sits under: the first line with code from its own line on (new side), so the card never
// hangs under an empty line. Its own line when the next code is more than three lines past its range (line..end), not
// shown, or in another block: a function or class starts there, or it is indented less than the code just above (a
// finding after a function's last line or a YAML block's last key belongs to that one). rows: a file's rows ({kind,
// number, text}).
const DEFINES = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:def|class|function)\b/;
export function findingAnchor(rows, line, end = line) {
  const code = (x) => x.kind !== "-" && Number.isInteger(x.number) && String(x.text ?? "").trim(), indent = (x) => /^\s*/.exec(x.text)[0].length;
  const r = rows.find((x) => code(x) && x.number >= line), above = rows.filter((x) => code(x) && x.number < line).at(-1);
  const other = r && r.number > line && (DEFINES.test(r.text) || (above && indent(r) < indent(above)));
  return r && r.number <= Math.max(line, end ?? line) + 3 && !other ? r.number : line;
}

// The gutter marks of ranges of lines: Map(new-side line number -> mark) for the rows that are really shown. A
// range's line and end come from a model's answer, so the work goes over the rows, never over the range (an end of
// 1e9 costs nothing); a range whose line or end is not a whole number, or that ends before it starts, marks nothing.
// ranges: [{line, end, mark}]; the first range that holds a row marks it.
export function rangeMarks(rows, ranges) {
  const ok = ranges.filter((x) => Number.isInteger(x.line) && Number.isInteger(x.end) && x.end >= x.line), out = new Map();
  if (ok.length) for (const r of rows) {
    if (r.kind === "-" || !Number.isInteger(r.number)) continue;
    const hit = ok.find((x) => r.number >= x.line && r.number <= x.end);
    if (hit) out.set(r.number, hit.mark);
  }
  return out;
}

// How many lines a text takes when it wraps at words in `width` px of the UI font (13.5 px unless `size` says
// otherwise): the virtual list needs every row's height before it draws. Character widths by class, measured on
// screenshots (within 2 %) and taken 4 % wider, so a card is never a line short.
const CH_W = (ch) => (ch === " " || "iljtfI.,:;'|!()[]{}-/`\"".includes(ch) ? 4 : ch > "\u2e7f" ? 13.5 : /[A-Zmw_@%&]/.test(ch) ? 8.5 : /\d/.test(ch) ? 8 : 7.3);
export function wrapCount(text, width, size = 13.5) {
  const k = (size / 13.5) * 1.04, room = Math.max(40, width);
  let n = 0;
  for (const para of String(text ?? "").split("\n")) {
    let x = 0;
    n++;
    for (const word of para.split(" ")) {
      const w = [...word].reduce((sum, ch) => sum + CH_W(ch), 0) * k;
      if (x > 0 && x + 4 * k + w > room) { n++; x = 0; }
      x += (x > 0 ? 4 * k : 0) + w;
      if (x > room) { n += Math.floor(x / room); x %= room; } // a word longer than a line breaks inside
    }
  }
  return n;
}

// A sequence visual as a sequence diagram: one column per participant with its lifeline at x, one row per call in
// the given order, from the caller's lifeline (x1) to the callee's (x2; the same for a call to itself). The columns
// share `width`, each between SEQ.MIN and SEQ.MAX px. Returns {cols, calls, width, height}.
export const SEQ = { MIN: 130, MAX: 280, HEAD: 30, ROW: 38, PAD: 6 };
export function seqLayout(v, width) {
  const nodes = (v?.nodes ?? []).filter((n) => n?.id), col = Math.max(SEQ.MIN, Math.min(SEQ.MAX, Math.floor(width / Math.max(1, nodes.length))));
  const x = new Map(nodes.map((n, k) => [n.id, Math.round(col * (k + 0.5))]));
  const calls = [...(v?.edges ?? []), ...(v?.transitions ?? [])].filter((e) => x.has(e.from) && x.has(e.to))
    .map((e, k) => ({ ...e, n: k + 1, text: transitionText(e), x1: x.get(e.from), x2: x.get(e.to), y: SEQ.HEAD + SEQ.PAD + k * SEQ.ROW }));
  return { cols: nodes.map((n) => ({ ...n, x: x.get(n.id), w: col - 16 })), calls, width: col * nodes.length, height: SEQ.HEAD + 2 * SEQ.PAD + calls.length * SEQ.ROW };
}

// ---- the height of a Markdown text (review.js: comment and finding cards are rows of the virtual list)

// What TextView.markdown takes at `width` px, in px: the list needs it before it draws, and a row that is too low
// cuts its text. Counted by block: a paragraph or a heading by its wrapped lines (each source line on its own, which
// is never fewer than the joined paragraph), a list by its items (indented, a little apart), a fenced code block by
// its lines (a long one wraps) plus its frame; MD.GAP between blocks. Inline code counts as ordinary letters without
// narrow ones. lh: the line height, size: the font size of the place. Measured on screenshots at 13.5 px.
export const MD = { GAP: 10, CODE_LH: 24, CODE_PAD: 48, CODE_CH: 8.8, CODE_IN: 32, ITEM_IN: 24, ITEM_GAP: 4, HEAD: 1.5 };
const codeWide = (line) => line.replace(/`([^`]*)`/g, (_m, code) => `aa${code.replace(/\S/g, "a")}`);
const codeRows = (line, width) => { const n = (line.length * MD.CODE_CH) / Math.max(40, width - MD.CODE_IN); return n <= 1 ? 1 : Math.ceil(n * 1.15); }; // it wraps at words
export function mdHeight(text, width, lh = 21, size = 13.5) {
  const lines = String(text ?? "").replace(/\r/g, "").split("\n"), blocks = [];
  let open = false; // a paragraph or a list goes on
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i], fence = /^\s*(```|~~~)/.exec(l);
    if (fence) {
      let n = 0;
      for (i++; i < lines.length && !lines[i].trimStart().startsWith(fence[1]); i++) n += codeRows(lines[i], width);
      blocks.push(MD.CODE_PAD + Math.max(1, n) * MD.CODE_LH); open = false;
    } else if (!l.trim()) open = false;
    else {
      const head = /^\s*#{1,6}\s+/.test(l), item = /^\s*(?:[-*+]|\d+[.)])\s+/.test(l), indent = item || (open && /^\s{2,}/.test(l)) ? MD.ITEM_IN : 0;
      const h = head ? MD.HEAD * lh * wrapCount(l, width, size * MD.HEAD) : lh * wrapCount(codeWide(l), width - indent, size) + (item ? MD.ITEM_GAP : 0);
      if (open && !head) blocks[blocks.length - 1] += h; else blocks.push(h);
      open = !head;
    }
  }
  return Math.ceil(blocks.reduce((a, b) => a + b, lh * !blocks.length) + MD.GAP * Math.max(0, blocks.length - 1));
}

// ---- the Security page's "what each run checked"
export const AREA_NAME = { authentication: "Authentication", authorization: "Authorization", input_validation: "Input validation", secrets: "Secrets", permissions: "Permissions",
  personal_data: "Personal data", dependencies: "Dependencies", correctness: "Correctness", error_handling: "Error handling", concurrency: "Concurrency", state: "State", contracts: "Contracts", tests: "Tests" };
// One row per area, one column per run that reported a scope. analysis: the analysis file's `scope` ({checked: [{area,
// result, note}]} or null); runs: pr.js runsOf. → {cols: [run key], rows: [{area, cells: {<run key>: {result, note} |
// null}}]}: areas in the order they are first named, null where a run does not cover the area, an unknown result
// counted as not_checked.
export function scopeTable(analysis, runs = {}) {
  const sources = [["analysis", analysis?.checked], ...Object.entries(runs ?? {}).map(([k, r]) => [k, r?.scope?.checked])].filter(([, c]) => Array.isArray(c) && c.length > 0);
  const areas = [...new Set(sources.flatMap(([, c]) => c.map((x) => x.area)))];
  const cell = (x) => (x ? { result: ["finding", "clean", "not_checked"].includes(x.result) ? x.result : "not_checked", note: String(x.note ?? "") } : null);
  return { cols: sources.map(([k]) => k), rows: areas.map((area) => ({ area, cells: Object.fromEntries(sources.map(([k, c]) => [k, cell(c.find((x) => x.area === area))])) })) };
}
// A run in words, so "not run", "failed" and "no findings" never look alike. r: a run of runsOf (or {state}); count:
// its findings on the list now.
export const runSummary = (r, count = r?.count ?? 0) => (!r?.state ? "not run" : r.state === "running" ? "running" : r.state === "failed" ? `failed: ${r.error || "no error text"}`
  : count ? `${count} ${count === 1 ? "finding" : "findings"}` : "no findings");

// ---- the Security page's attack surface
// How exposed an access row is: "open" (reachable without the cloud account's credentials and nothing checks the
// caller), "public" (reachable so, something checks the caller), "internal". What checks: `auth_kind` (none | code |
// gateway | iam) when the analysis has it, else the first word of the free text `auth`.
export const exposureOf = (x) => (!x?.public ? "internal" : (x.auth_kind ? x.auth_kind === "none" : /^(|none|no|nothing|unauthenticated|-|–)$/i.test(String(x.auth ?? "").trim().replace(/[\s.(:;,].*$/, ""))) ? "open" : "public");
export const EXPOSURE = { open: "Public, no auth", failopen: "Auth, can fail open", public: "Public, auth", internal: "Internal" };
// A public way in whose check an unresolved finding says can be passed (impact unauthorized_access): "failopen" while
// that finding is open, else the row's own exposure. findings: the unresolved findings at this way in.
export const exposureNow = (x, findings = []) => (x?.exposure === "public" && findings.some((f) => f.impact === "unauthorized_access") ? "failopen" : x?.exposure ?? "internal");
// The analysis' access rows as the ways in (entry points: everything public, and routes, endpoints and APIs) and the
// rights granted (the rest: IAM and resource policies). Each row keeps its index `k` and gets its `exposure`; the
// entries come most exposed first, then in the given order.
export function surfaceOf(access) {
  const order = Object.keys(EXPOSURE), rows = (access ?? []).map((x, k) => ({ ...x, k, exposure: exposureOf(x) }));
  const entry = (x) => Boolean(x.public) || /route|endpoint|api|url|http|gateway|ingress/i.test(String(x.kind ?? ""));
  return { entries: rows.filter(entry).sort((a, b) => order.indexOf(a.exposure) - order.indexOf(b.exposure) || a.k - b.k), grants: rows.filter((x) => !entry(x)) };
}

// ---- the Security page's order of findings, the way in the PR opens unasked, and what a zone's component may do
// How far out a finding can be reached from: the analysis' word when it has one (stated), else from the most exposed
// way in at it (derived: open → public, public with a check → authenticated, internal → internal_only), else unknown.
export const REACH = ["public", "authenticated", "internal_only", "unknown"];
const FROM_EXPOSURE = { open: "public", failopen: "public", public: "authenticated", internal: "internal_only" };
export const reachLevel = (f, ways = []) => (REACH.includes(f?.reachability) ? f.reachability
  : ways.map((x) => FROM_EXPOSURE[x.exposure]).filter(Boolean).sort((a, b) => REACH.indexOf(a) - REACH.indexOf(b))[0] ?? "unknown");
const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
const REACH_WHY = { public: "Reachable from the internet", authenticated: "Reachable by an authenticated caller", internal_only: "Reachable only from inside", unknown: "Not known from where it can be reached" };
// rows [{f, level, crosses: true | false | null (the analysis names no zones)}], most exposed first, then the ones whose
// way crosses a trust boundary, then by severity; each with `why` it stands there, in a few words.
export function secOrder(rows) {
  return [...rows].sort((a, b) => REACH.indexOf(a.level) - REACH.indexOf(b.level) || Number(Boolean(b.crosses)) - Number(Boolean(a.crosses)) || (SEV_RANK[a.f.severity] ?? 9) - (SEV_RANK[b.f.severity] ?? 9))
    .map((r) => ({ ...r, why: [REACH_WHY[r.level], r.crosses === true ? "over a trust boundary" : r.crosses === false ? "no trust boundary on the way" : null, `${r.f.severity} severity`].filter(Boolean).join(", ") + "." }));
}

// The way in this PR opens although the task does not ask for it: an ask of state "extra" whose places (files: its
// hunks' and its findings' files) hold the way in's place or its card's (files). Only a one-to-one match counts:
// [{entry, ask}]. asks [{state, files}], entries [{opened_by_pr, files}].
export function extraWays(asks, entries) {
  const extra = (asks ?? []).filter((a) => a.state === "extra"), open = (entries ?? []).filter((x) => x.opened_by_pr !== false);
  const hits = (a, x) => x.files.some((f) => a.files.includes(f));
  return extra.flatMap((a) => {
    const mine = open.filter((x) => hits(a, x));
    return mine.length === 1 && extra.filter((b) => hits(b, mine[0])).length === 1 ? [{ entry: mine[0], ask: a }] : [];
  });
}

// What a component in a zone with a way in may do: the access rows whose principal is the zone or one of its cards
// (by name). [{zone, rights: [{resource, actions, used}]}] for each zone that holds a way in's card, in zone order.
export function zoneRights(zones, nodes, entries, access) {
  const norm = (s) => String(s ?? "").replace(/\s+/g, "").toLowerCase(), cards = nodes ?? []; // "FrontDesk function" is the zone "Front desk function"
  const zoneOf = (id) => cards.find((n) => n.id === id)?.zone;
  const held = new Set((entries ?? []).map((x) => zoneOf(x.node)).filter(Boolean));
  return (zones ?? []).filter((z) => held.has(z.id)).map((z) => {
    const names = new Set([z.name, z.id, ...cards.filter((n) => n.zone === z.id).flatMap((n) => [n.label, n.id])].filter(Boolean).map(norm));
    return { zone: z, rights: (access ?? []).filter((x) => names.has(norm(x.principal))).map((x) => ({ resource: x.resource ?? "", actions: x.actions ?? [], used: x.used })) };
  });
}
// That as a sentence: "If FrontDesk function is compromised, it can sqs:SendMessage on LoanEvents (granted, never used)."
export function blastLine({ zone, rights }) {
  const name = zone.name ?? zone.id;
  if (!rights.length) return `If ${name} is compromised, it holds no right the analysis names.`;
  return `If ${name} is compromised, it can ${rights.map((r) => `${r.actions.join(", ") || "act"} on ${r.resource}${r.used === false ? " (granted, never used)" : ""}`).join("; ")}.`;
}

// ---- the diff with the old and the new side next to each other (review.js pushRows)

// A file's rows (pr.js fileRows or a hunk's diffRows: {kind: "@" | "gap" | " " | "-" | "+" | "", …}) as what the
// side-by-side view draws, top to bottom, by index into `rows`:
// {full: i} a row over the whole width (a hunk header, a gap that still hides lines, a note);
// {l, r} a pair: an unchanged line on both sides (l === r); a changed block's removed lines beside its added ones,
// first with first, and where the block has more lines on one side the other side is empty (null).
export function pairRows(rows) {
  const out = [];
  for (let i = 0; i < rows.length;) {
    const k = rows[i].kind;
    if (k === " ") out.push({ l: i, r: i++ });
    else if (k !== "-" && k !== "+") out.push({ full: i++ });
    else {
      // One changed block: its removed lines, then its added ones (a diff writes them in this order).
      let a = i;
      while (a < rows.length && rows[a].kind === "-") a++;
      let b = a;
      while (b < rows.length && rows[b].kind === "+") b++;
      for (let n = 0; n < Math.max(a - i, b - a); n++) out.push({ l: i + n < a ? i + n : null, r: a + n < b ? a + n : null });
      i = b;
    }
  }
  return out;
}

// ---- long code lines wrap (review.js pushRows: one list item per visual line, so a click knows its line by its key)

// Where a code line breaks to fit `cols` columns: the offset each visual line starts at ([0] when it fits). A break
// goes after the last space or , ; ( [ { in the line's last third, else at `cols` exactly. At most `max` lines; the
// last one is cut as before.
export const WRAP_MAX = 40;
const WRAP_AFTER = /[\s,;([{]/;
export function wrapCode(text, cols, max = WRAP_MAX) {
  const s = String(text ?? ""), c = Math.max(8, Math.floor(cols)), out = [0];
  for (let a = 0; s.length - a > c && out.length < max;) {
    let e = a + c;
    for (let j = e; j > a + Math.ceil((2 * c) / 3); j--) if (WRAP_AFTER.test(s[j - 1])) { e = j; break; }
    out.push(e);
    a = e;
  }
  return out;
}
// The height a code line takes: one row per visual line.
export const wrapHeight = (starts, row) => row * Math.max(1, starts.length);
// The code columns of a diff row `width` px wide whose code starts `gutter` px from its left (12 px right of it).
export const codeCols = (width, gutter, charW) => Math.max(8, Math.floor((width - gutter - 12) / (charW || 7.8)));
// The syntax spans of text[a, b), shifted to the slice: a wrapped line keeps its colors on every visual line.
export const sliceSpans = (spans, a, b) => spans.filter((s) => s.end > a && s.start < b).map((s) => ({ ...s, start: Math.max(s.start, a) - a, end: Math.min(s.end, b) - a }));

// ---- side by side (review.js pushRows, lineView): two halves of equal width, each its own line number and sign
export const HALF_GUTTER = 4 + 48 + 22;
// Which half a press at x on a side-by-side row `w` px wide hit: the row index there (null: the half is empty), x from
// the half's left edge, the half's width, and the side ("l" old, "r" new).
export function pairSide(x, w, l, r) {
  const half = w / 2, right = x >= half;
  return { side: right ? "r" : "l", ri: right ? r : l, x: right ? x - half : x, w: half };
}
// The diff's view: the person's choice ("split" | "unified", kept in shared), else side by side when both halves of a
// list `width` px wide hold about 80 columns of code.
export const SPLIT_COLS = 80;
export const diffModeOf = (chosen, width, charW) => (chosen === "split" || chosen === "unified" ? chosen : codeCols(width / 2, HALF_GUTTER, charW) >= SPLIT_COLS ? "split" : "unified");
// A file whose lines are all on one side (a new or a deleted file): side by side it keeps one column over the whole
// width instead of an empty half.
export const oneSided = (rows) => !rows.some((r) => r.kind === " ") && !(rows.some((r) => r.kind === "+") && rows.some((r) => r.kind === "-"));

// A colour with transparency laid over the base, as one opaque colour: cards drawn with it hide the grid behind them
// (a tint with alpha let the grid show through a card). Colours are #rgb, #rrggbb or #rrggbbaa; anything else is
// returned as it is.
export function solidOver(base, over) {
  const rgba = (c) => {
    const s = String(c ?? "").replace("#", "");
    const h = s.length === 3 || s.length === 4 ? [...s].map((x) => x + x).join("") : s;
    if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(h)) return null;
    return [0, 2, 4, 6].map((k) => (k < h.length ? parseInt(h.slice(k, k + 2), 16) : 255));
  };
  const b = rgba(base), o = rgba(over);
  if (!b || !o) return over;
  const a = o[3] / 255, hex = (v) => Math.round(v).toString(16).padStart(2, "0");
  return "#" + [0, 1, 2].map((k) => hex(o[k] * a + b[k] * (1 - a))).join("");
}

// ---- "What each run checked": the findings behind an area's "Finding"
// ponytail: an area is matched by its words in a finding's title, effect and detail (findings name no area); a run
// that reports areas per finding would make this exact.
const AREA_WORDS = { authentication: /authenticat|\btoken|bearer|login|credential|session/i, authorization: /authori[sz]|access control|\brole|allowed to|any (?:caller|member|loan)/i,
  input_validation: /input|validat|inject|saniti[sz]|unvalidated|request body/i, secrets: /secret|\btoken|api key|password|credential/i, permissions: /\biam\b|policy|permission|grant|least privilege/i,
  personal_data: /personal|\bpii\b|e-?mail address|\bmembers?\b|\bnames?\b|\bcustomers?\b|\busers?'? (?:data|names?|e-?mails?)/i, dependencies: /dependenc|package|library version|requirements|lockfile/i,
  error_handling: /error|exception|raises?\b|retr(?:y|ies)|fails?\b|failure/i, concurrency: /concurren|race|idempoten|redeliver|at[- ]least[- ]once|twice|duplicate|dedup/i,
  state: /\bstate\b|status|transition/i, contracts: /contract|interface|schema|signature|requirement|acceptance/i };
const AREA_CATEGORY = { correctness: ["bug"], tests: ["test"], contracts: ["requirement"] };
// The findings of run `k` ("analysis" or a reviewer) that fall under `area`: by category where one fits, else by words.
export function areaFindings(area, k, findings) {
  const mine = (findings ?? []).filter((f) => (f.sources ?? [{ reviewer: f.reviewer }]).some((s) => s.reviewer === k));
  const words = AREA_WORDS[area], cats = AREA_CATEGORY[area] ?? [];
  return mine.filter((f) => cats.includes(f.category) || (words && words.test([f.title, f.effect, f.detail].filter(Boolean).join(" "))));
}

// ---- a state diagram's transitions and the findings at them
// The unresolved findings at each transition of a state visual: one whose file and line fall on the transition's place
// (`evidence` or `at`: "file:line" or "file:line-end"; a finding's own range counts). Returns Map(index in edges then
// transitions -> {findings, severity: the highest}); a transition without a place has none.
const RANK = { critical: 0, high: 1, medium: 2, low: 3 };
export function transitionMarks(v, findings) {
  const out = new Map(), place = (s) => /^(.+?):(\d+)(?:-(\d+))?/.exec(String(s ?? ""));
  [...(v?.edges ?? []), ...(v?.transitions ?? [])].forEach((e, i) => {
    const m = place(e.evidence) ?? place(e.at);
    if (!m) return;
    const [path, a, b] = [m[1], Number(m[2]), Number(m[3] ?? m[2])];
    const hit = (findings ?? []).filter((f) => f.file && (f.file === path || f.file.endsWith(`/${path}`) || path.endsWith(`/${f.file}`)) && (f.line ?? 0) <= b && (f.end ?? f.line ?? 0) >= a);
    if (hit.length) out.set(i, { findings: hit, severity: hit.map((f) => f.severity).sort((x, y) => (RANK[x] ?? 9) - (RANK[y] ?? 9))[0] });
  });
  return out;
}

// Where the runs' self-reports in "What each run checked" contradict each other or the findings: an area one run calls
// clean and another finds something in ("cross"), or one a run calls clean while an unresolved security finding names
// it in its effect, by the area's words ("effect": "personal data clean" and "they can read members' names"). tab: scopeTable;
// open: the unresolved findings. Returns Map(area -> {kind, text, findings}).
export function scopeConflicts(tab, open = []) {
  const out = new Map();
  for (const r of tab?.rows ?? []) {
    const cells = Object.entries(r.cells).filter(([, c]) => c), clean = cells.filter(([, c]) => c.result === "clean").map(([k]) => k), found = cells.filter(([, c]) => c.result === "finding").map(([k]) => k);
    if (!clean.length) continue;
    if (found.length) { out.set(r.area, { kind: "cross", text: `${clean.join(", ")} ${clean.length === 1 ? "calls" : "call"} it clean, ${found.join(", ")} ${found.length === 1 ? "finds" : "find"} something here.`, findings: [] }); continue; }
    // Only a finding about security says something an area of the security run should have seen.
    const words = AREA_WORDS[r.area], hit = words ? open.filter((f) => (f.security || ["unauthorized_access", "data_exposure"].includes(f.impact)) && words.test(String(f.effect ?? ""))) : [];
    if (hit.length) out.set(r.area, { kind: "effect", text: `Called clean, but ${hit.length === 1 ? "an unresolved finding names" : `${hit.length} unresolved findings name`} it in ${hit.length === 1 ? "its" : "their"} effect: ${hit.slice(0, 2).map((f) => f.title).join("; ")}.`, findings: hit });
  }
  return out;
}

// A PR row's marks in the PR list (main.js), at most three by weight: the highest open severity, with ⛨ when an open
// finding is about security (one mark, the only red one), then the priority, then the type. Effort is left out: the
// review itself has no "Review effort" either.
export function rowMarks(risk, tri) {
  return [risk?.top && { text: `${risk.security ? "⛨ " : ""}${risk.top}`, security: Boolean(risk.security), kind: "risk" },
    tri && { text: `P${tri.priority}`, kind: "priority" }, tri?.type && { text: tri.type, kind: "type" }].filter(Boolean).slice(0, 3);
}

// A stack of PRs around this one (related.py stacked_on, stacked_above), bottom first: [{number, title, url, self}];
// null when this PR is in no stack. The review's bar shows it as "Stack: #1 → #2".
export function stackOf(ctx, number) {
  const below = ctx?.stacked_on ?? null, above = ctx?.stacked_above ?? [];
  return below || above.length ? [...(below ? [below] : []), { number, self: true }, ...above] : null;
}

// ---- "Depends on" in a layer's head (review.js item "step"): small chips at the right end of the title row
// A text's width in px of the UI font at `size` (the estimate wrapCount uses), for chips whose clicks are placed by x.
export const textW = (text, size = 13.5) => Math.ceil([...String(text ?? "")].reduce((w, ch) => w + CH_W(ch), 0) * (size / 13.5) * 1.04);
// Which of the chips laid out right-aligned (the last one ending at `right`, `gap` px between) a press at x hit: its
// index, or -1.
export function chipAt(x, right, widths, gap = 6) {
  let r = right;
  for (let k = widths.length - 1; k >= 0; k--) {
    const l = r - widths[k];
    if (x >= l && x < r) return k;
    r = l - gap;
  }
  return -1;
}

// "By focus": the layers by what their rows show (worst): the highest unresolved severity first, a layer with a
// security finding first among equals, then more findings, then reading order; layers without one last.
// open(s): a layer's unresolved findings.
export function byFocus(steps, open) {
  const rank = (w) => (w ? (SEVERITIES.indexOf(w.severity) + 1 || SEVERITIES.length + 1) : SEVERITIES.length + 2);
  return steps.map((s) => ({ s, w: worst(open(s)) }))
    .sort((a, b) => rank(a.w) - rank(b.w) || Number(Boolean(b.w?.security)) - Number(Boolean(a.w?.security)) || (b.w?.count ?? 0) - (a.w?.count ?? 0) || a.s.order - b.s.order)
    .map((x) => x.s);
}

// The "Needs your attention" heading counts by decision, not by severity: "⛨ 2 · 3 criteria not met · 4 other
// blockers". list: the box's items ({security}); notMet: the task's criteria broken or not done.
export function attentionCounts(list, notMet = 0) {
  const sec = list.filter((a) => a.security).length, rest = list.length - sec;
  return [sec && `⛨ ${sec}`, notMet && `${notMet} ${notMet === 1 ? "criterion" : "criteria"} not met`, rest && `${rest} ${sec ? "other " : ""}${rest === 1 ? "blocker" : "blockers"}`].filter(Boolean);
}

// A layer's ways in and rights: the access rows (the analysis' or the security run's) at one of its files that are
// public or opened by this PR, with the sentence for the mark at its row ("This layer opens a public route (Api)."),
// so a layer that adds a way in shows it without a finding. null: none.
export function layerAccess(access, files) {
  const at = (x) => String(x.at ?? "").replace(/:\d+(?:-\d+)?$/, ""), has = (p) => files.some((f) => f === p || f.endsWith(`/${p}`) || p.endsWith(`/${f}`));
  const rows = (access ?? []).filter((x) => (x.public || x.opened_by_pr) && at(x) && has(at(x)));
  if (!rows.length) return null;
  const { entries, grants } = surfaceOf(rows);
  const say = [...entries.map((x) => `opens ${x.public ? "a public" : "a"} ${x.kind || "way in"}${x.resource ? ` (${x.resource})` : ""}`),
    ...grants.map((x) => `grants ${x.principal || "someone"} ${(x.actions ?? []).join(", ") || "a right"}${x.resource ? ` on ${x.resource}` : ""}`)];
  return { entries: entries.length, grants: grants.length, text: `This layer ${say.join(", and ")}.` };
}

// The analysis' line at the top of the Analysis tab: the head it read and its age, "stale" (amber) once the PR moved
// on (another head, or not this diff). head: the analysis file's (null: from before it said so); now: the PR's head.
export function analysisAge({ head = null, exact = true, now = null, age = "" }) {
  const at = (x) => String(x).slice(0, 7), moved = !exact || Boolean(head && now && head !== now);
  return { stale: moved, text: `Analysis of ${head ? at(head) : exact ? "this diff" : "an older diff"}${age ? `, ${age}` : ""}${moved && now && head ? ` · the PR is at ${at(now)} now` : ""}` };
}
