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
// hangs under an empty line. Its own line when the next code is more than three lines past its range (line..end) or
// not shown. rows: a file's rows ({kind, number, text}).
export function findingAnchor(rows, line, end = line) {
  const r = rows.find((x) => x.kind !== "-" && x.number >= line && String(x.text ?? "").trim());
  return r && r.number <= Math.max(line, end ?? line) + 3 ? r.number : line;
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
