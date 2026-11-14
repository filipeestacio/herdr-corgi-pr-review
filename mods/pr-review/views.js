// Pure helpers for the panel's state (main.js) and a layer's flow picture (stack.js visualCard). No gpui imports, so
// node tests them (test_views.mjs).
import { transitionText } from "./arch.js";
import { isSecurity } from "./pr.js";

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
    security: open.some(isSecurity) }; // as the review's ⛨ (pr.js isSecurity): what it does, not who found it
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
// share `width`, each between SEQ.MIN and SEQ.MAX px: a picture with room spreads over it, one without scrolls. A
// participant's name that does not fit its column's head goes on a second line (head: the heads' height). Each call
// carries its numbered caption and where it starts (tx) and how wide it may be (tw): from the arrow's left end, moved
// left so it ends inside the picture rather than being cut at its edge. Returns {cols, calls, head, width, height}.
export const SEQ = { MIN: 130, MAX: 420, HEAD: 30, HEAD2: 46, ROW: 38, PAD: 6 };
// A text's width in px at `size` (the same letter widths as wrapCount).
export const textWidth = (text, size = 13.5) => Math.ceil([...String(text ?? "")].reduce((w, ch) => w + CH_W(ch), 0) * (size / 13.5) * 1.04);
export function seqLayout(v, width) {
  const nodes = (v?.nodes ?? []).filter((n) => n?.id), col = Math.max(SEQ.MIN, Math.min(SEQ.MAX, Math.floor(width / Math.max(1, nodes.length))));
  const x = new Map(nodes.map((n, k) => [n.id, Math.round(col * (k + 0.5))])), W = col * nodes.length;
  const head = nodes.some((n) => textWidth(n.label ?? n.id, 12) * 1.05 > col - 28) ? SEQ.HEAD2 : SEQ.HEAD; // semibold: a little wider
  const calls = [...(v?.edges ?? []), ...(v?.transitions ?? [])].filter((e) => x.has(e.from) && x.has(e.to)).map((e, k) => {
    const text = transitionText(e), caption = /^\d+[.)]/.test(text) ? text : `${k + 1}. ${text}`; // some analyses number the calls themselves
    const x1 = x.get(e.from), x2 = x.get(e.to), self = x1 === x2, start = Math.min(x1, x2) + (self ? 28 : 8), want = textWidth(caption, 11.5) + 8;
    // A call to itself whose text does not fit right of its loop puts it left of the lifeline, so it never covers the loop.
    const tx = self && start + want > W - 4 ? Math.max(4, x1 - 6 - want) : Math.max(4, Math.min(start, W - 4 - want));
    return { ...e, n: k + 1, text, caption, x1, x2, y: head + SEQ.PAD + k * SEQ.ROW, tx, tw: self && tx < x1 ? x1 - 6 - tx : W - tx - 4 };
  });
  return { cols: nodes.map((n) => ({ ...n, x: x.get(n.id), w: col - 16 })), calls, head, width: W, height: head + 2 * SEQ.PAD + calls.length * SEQ.ROW };
}

// ---- the height of a Markdown text (review.js: comment and finding cards are rows of the virtual list)

// What TextView.markdown takes at `width` px, in px: the list needs it before it draws, and a row that is too low
// cuts its text. Counted by block: a paragraph or a heading by its wrapped lines (a paragraph's lines joined as
// TextView joins them, apart at hard breaks), a list by its items (indented, a little apart), a fenced code block by
// its lines (a long one wraps) plus its frame; MD.GAP between blocks. Inline code counts as ordinary letters without
// narrow ones. lh: the line height, size: the font size of the place. Measured on screenshots at 13.5 px.
export const MD = { GAP: 10, CODE_LH: 24, CODE_PAD: 48, CODE_CH: 8.8, CODE_IN: 32, ITEM_IN: 24, ITEM_GAP: 4, HEAD: 1.5, HEADS: [1.5, 1.35, 1.2, 1.1, 1.1, 1.1], ROW_PAD: 13, CELL_PAD: 24, QUOTE_IN: 20 };
const codeWide = (line) => line.replace(/`([^`]*)`/g, (_m, code) => `aa${code.replace(/\S/g, "a")}`);
const codeRows = (line, width) => { const n = (line.length * MD.CODE_CH) / Math.max(40, width - MD.CODE_IN); return n <= 1 ? 1 : Math.ceil(n * 1.15); }; // it wraps at words
export function mdHeight(text, width, lh = 21, size = 13.5) {
  const lines = String(text ?? "").replace(/\r/g, "").split("\n"), blocks = [];
  // A paragraph's lines join (soft breaks), except after a hard break (two spaces or a backslash at the end); a link
  // counts its text, not its address; emphasis marks take no room.
  const vis = (l) => codeWide(l).replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\*\*|__|~~/g, "");
  let open = false, run = null; // a paragraph or a list goes on; run: the paragraph's text since its last hard break
  const flushRun = () => { if (run) { blocks[blocks.length - 1] += lh * wrapCount(vis(run.text.trim()), width - run.indent, size); run = null; } };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i], fence = /^\s*(```|~~~)/.exec(l);
    if (fence) {
      flushRun();
      let n = 0;
      for (i++; i < lines.length && !lines[i].trimStart().startsWith(fence[1]); i++) n += codeRows(lines[i], width);
      blocks.push(MD.CODE_PAD + Math.max(1, n) * MD.CODE_LH); open = false;
    } else if (!l.trim()) { flushRun(); open = false; }
    else if (/^\s*\|/.test(l)) { // a table: a row per line (not the --- line), as high as its tallest cell
      flushRun();
      let h = 0;
      for (; i < lines.length && /^\s*\|/.test(lines[i]); i++) {
        if (/^\s*\|?[\s:|-]+$/.test(lines[i]) && lines[i].includes("-")) continue;
        const cells = lines[i].trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/), w = width / Math.max(1, cells.length) - MD.CELL_PAD;
        h += lh * Math.max(...cells.map((c) => wrapCount(vis(c.trim()), w, size))) + MD.ROW_PAD;
      }
      i--; blocks.push(h); open = false;
    } else if (/^\s*>/.test(l)) { // a quote: its own Markdown, narrower
      flushRun();
      const q = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) q.push(lines[i].replace(/^\s*>\s?/, ""));
      i--; blocks.push(mdHeight(q.join("\n"), width - MD.QUOTE_IN, lh, size)); open = false;
    } else {
      const head = /^\s*#{1,6}\s+/.test(l), level = /^\s*(#+)/.exec(l)?.[1].length ?? 0, item = /^\s*(?:[-*+]|\d+[.)])\s+/.test(l), indent = item || (open && /^\s{2,}/.test(l)) ? MD.ITEM_IN : 0;
      if (head) { flushRun(); const k = MD.HEADS[level - 1] ?? 1.1; blocks.push(k * lh * wrapCount(l.replace(/^\s*#+\s+/, ""), width, size * k)); open = false; continue; }
      if (item || !open) { flushRun(); if (!open) blocks.push(0); if (item) blocks[blocks.length - 1] += MD.ITEM_GAP; }
      run = run ? { ...run, text: `${run.text} ${l.trim()}` } : { text: l, indent };
      if (/( {2,}|\\)$/.test(l)) flushRun();
      open = true;
    }
  }
  flushRun();
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

// The state hints at the top of the Analysis tab, where they are seen instead of a grey line under the page: the PR
// head's checkout, an analysis waiting for it, reviewer runs. checkout: {busy} | {error} | null; runs: the findings
// file's runs (busy while one runs); names: kind -> label. -> [{key, text, spin, error}]
export function stateHints({ checkout = null, pendingRun = false, runs = {}, names = {} }) {
  return [
    checkout?.busy && { key: "checkout", spin: true, text: `Checking out the PR head${pendingRun ? ": the analysis starts once it is there" : ""}…` },
    checkout?.error && { key: "checkout", error: true, text: `Could not check out the PR head: ${checkout.error}` },
    pendingRun && !checkout && { key: "wait", text: "The analysis starts once the PR head is checked out." },
    ...Object.entries(runs ?? {}).filter(([, r]) => r?.busy).map(([k]) => ({ key: `run-${k}`, spin: true, text: `${names[k] ?? k} is running…` })),
  ].filter(Boolean);
}

// How the line under the right pane shows a note about an action just taken: an error (it did not happen) in red with
// a mark, kept until it is closed or the next action; anything else in the text color, gone by itself after ttl ms.
export const NOTE_TTL = 8000;
const NOTE_ERROR = /^(Could not|Not |Nothing to |Select a line|Line \d+ of .* is not in)|^No \S+ on |Could not/;
export const noteRule = (text) => (NOTE_ERROR.test(String(text ?? "")) ? { error: true, ttl: null } : { error: false, ttl: NOTE_TTL });
// ---- the zone a card is really reachable from (derived, not the model's word)
// A card behind a public way in whose check sits in the card's own code (auth_kind "code") or that nothing checks is
// reachable from the public side, whatever zone the analysis draws it in. Returns Map(node id -> {trust: "public",
// drawn: the drawn zone's trust, zone, why}) for the cards where the two differ.
export function effectiveZones(arch, access) {
  const zones = new Map((arch?.zones ?? []).map((z) => [z.id, z])), out = new Map();
  for (const x of access ?? []) {
    const n = (arch?.nodes ?? []).find((m) => m.id === x?.node), z = zones.get(n?.zone), open = exposureOf(x) === "open";
    if (!x?.public || !n || !z || z.trust === "public" || !(x.auth_kind === "code" || open) || out.has(n.id)) continue;
    out.set(n.id, { trust: "public", drawn: z.trust, zone: z, why: open ? "nothing checks the caller before it" : `its only check (${x.auth || "in the code"}) is in its own code, so every request from the internet reaches it` });
  }
  return out;
}

// ---- the Security page as a boundary map (panel-secview, panel-check): the crossings of trust boundaries
// Every crossing the data names: a way in from the public side (an access row that is public), a right that reaches
// into another zone (an access row whose principal is a frame or a card of one), a call over a boundary (an edge with
// `crosses`, or between cards of different zones), a call in the same process that bypasses a boundary (kind
// "bypass": no crossing, but code written for another way in gets this caller's input), and an operator's way (kind
// "operator": access rows of principal_kind operator or ci; without them, one derived from a gate whose condition
// names configuration or a secret). Each row: {key, kind, from, to: {name, trust}, identity (who arrives: the access
// row's principal), expects (the gate's principal), check, at, holds_if, carries, change, result: finding | mitigated
// | not_assessed (from threats[] only: a named threat's result, or a finding a threat names or that names exactly this
// crossing), reason (why not assessed), findings, threats (named ones), stride, goal, path (node ids, from a threat),
// conflicts (findings whose own place and their threat's disagree), unmapped (a right whose principal is no card or
// frame), unused (a right granted but not used), ends: {from, to} (card ids, null outside), access?, edge?}.
export const TRUST_ORDER = ["public", "authenticated", "internal", "data"];
// A gate's check in words: its kind and where it sits ("token, in the code"); null without a check.
const checkText = (g) => (g?.check ? `${g.check}${g.source ? `, in the ${g.source === "code" ? "code" : "config"}` : ""}` : null);
const CHANGED = ["added", "widened", "narrowed", "changed", "removed"];
// A name without spaces, case or a generic last word, so "FrontDesk function" is the frame "Front desk Lambda".
const nameKey = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "").replace(/(function|lambda|role|service|deployment|container|task|job)$/, "");
// A call in one process (no boundary): the data says so, or its words do. ponytail: the words only until every
// analysis sets in_process.
export const inProcess = (e) => (typeof e?.in_process === "boolean" ? e.in_process : /\bin[- ]process\b|\bimports?\b|\bin the same process\b/i.test(String(e?.label ?? "")));
// A gate's condition that names configuration or a secret: someone sets it at deploy time (an operator's way).
const CONFIG = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b|\bsecret|\benv(?:ironment)?\b|\bconfig|\bparameter|\bvariable/;
// gates: the security run's checks per crossing ({where: {access} | {from, to, edge}, principal, check, at, source,
// holds_if, carries}); a gate on the row itself (x.gate, e.gate) is the older place. A threat with `derived` is a
// placeholder ("no threat was named") and names no result.
// bypasses: the security run's calls in one process that bypass a boundary ({from, to, edge}); without them (an
// older run), a call in one process bypasses one when the code it reaches also gets calls from another frame.
export function crossingsOf({ arch = null, access = [], threats = [], findings = [], gates = [], bypasses = [] } = {}) {
  const zones = arch?.zones ?? [], nodes = arch?.nodes ?? [], groups = arch?.groups ?? [], edges = arch?.edges ?? [];
  const zone = (id) => zones.find((z) => z.id === id) ?? null, node = (id) => nodes.find((n) => n.id === id);
  // A card's zone: the zone of what it runs in (runs_in), else its own. A frame's zone: the one its cards share.
  const zoneOfFrame = (gid) => zone(nodes.find((n) => n.group === gid && n.zone)?.zone);
  const zoneOfNode = (nid, seen = 0) => { const n = node(nid); if (!n) return zoneOfFrame(nid); return n.runs_in && n.runs_in !== nid && seen < 4 ? zoneOfNode(n.runs_in, seen + 1) ?? zone(n.zone) : zone(n.zone); };
  const label = (nid) => node(nid)?.label ?? groups.find((g) => g.id === nid)?.label ?? nid;
  // The card or frame a principal is: principal_node, else the frame or card of that name; null: not mapped.
  const principalNode = (x) => (x.principal_node !== undefined ? x.principal_node
    : groups.find((g) => nameKey(g.label) && nameKey(g.label) === nameKey(x.principal))?.id ?? nodes.find((n) => n.id === x.principal || (nameKey(n.label) && nameKey(n.label) === nameKey(x.principal)))?.id ?? null);
  const cardOf = (pid) => (node(pid) ? pid : nodes.find((n) => n.group === pid)?.id ?? null); // a frame: its first card
  const z = (x) => (x ? { name: x.name ?? x.id, trust: x.trust ?? null } : { name: "no zone named", trust: null });
  const named = (threats ?? []).filter((t) => !t.derived), byId = new Map((access ?? []).map((x) => [x.id, x]));
  // Where a finding belongs: the access rows its threats place it at, and its own reachable_from. When they disagree,
  // the outer one counts (public before the rest) and the finding is marked (or the data's own reach_conflict).
  const conflicts = new Map(), homeOf = new Map();
  for (const f of findings ?? []) {
    const ids = f.ids ?? [f.id], byThreat = [...new Set(named.filter((t) => (t.findings ?? []).some((i) => ids.includes(i)) && t.where?.access).map((t) => t.where.access))];
    const own = f.reachable_from ?? [], clash = byThreat.length && own.length && !own.some((a) => byThreat.includes(a));
    const all = [...new Set([...byThreat, ...own])], outer = all.filter((a) => byId.get(a)?.public);
    homeOf.set(f, clash ? (outer.length ? outer : byThreat) : all);
    // The run's own reach_conflict ({finding: {reachable_from}, threat: {where}}) says the same in its words.
    const rc = f.reach_conflict, where = rc?.threat?.where;
    if (rc) conflicts.set(f.id, { finding: rc.finding?.reachable_from ?? own, threat: [where?.access ?? where?.edge ?? (where?.from ? `${where.from} → ${where.to}` : null)].filter(Boolean), conflict: rc });
    else if (clash) conflicts.set(f.id, { finding: own, threat: byThreat, conflict: null });
  }
  const RESULT = { finding: "finding", mitigated: "mitigated", checked_clean: "mitigated", not_assessed: "not_assessed", not_checked: "not_assessed" };
  const row = (base, match) => {
    const ts = (threats ?? []).filter(match.threat), ns = ts.filter((t) => !t.derived), cited = new Set(ns.flatMap((t) => t.findings ?? []));
    const fs = (findings ?? []).filter((f) => (f.ids ?? [f.id]).some((i) => cited.has(i)) || (f.security && match.finding(f)));
    const results = ns.map((t) => RESULT[t.result]).filter(Boolean);
    const result = fs.length || results.includes("finding") ? "finding" : results.includes("mitigated") ? "mitigated" : "not_assessed";
    const reason = result !== "not_assessed" ? null : (ts.find((t) => t.derived)?.threat || "No threat names this crossing.");
    return { ...base, result, reason, findings: fs, threats: ns, stride: [...new Set(ns.map((t) => t.stride).filter(Boolean))].join(""), goal: ns.map((t) => t.goal).find(Boolean) ?? null,
      path: ns.map((t) => t.path).find((p) => Array.isArray(p) && p.length > 1) ?? null, evidence: ns.map((t) => t.evidence).find(Boolean) ?? null,
      conflicts: fs.filter((f) => conflicts.has(f.id)).map((f) => ({ f, ...conflicts.get(f.id) })) };
  };
  const changeOf = (x) => x.change ?? (x.opened_by_pr === true ? "added" : x.opened_by_pr === false ? "unchanged" : null);
  const rows = [];
  for (const x of access ?? []) {
    const to = zoneOfNode(x.node), gate = (gates ?? []).find((g) => g.where?.access === x.id) ?? x.gate ?? {}, op = ["operator", "ci"].includes(x.principal_kind);
    // A way in starts outside, with whoever arrives (the principal); a right starts at its principal's frame or card.
    const pn = x.public ? null : principalNode(x), from = x.public ? null : pn ? zoneOfNode(pn) : null;
    if (!x.public && !op && from && to && from.trust === to.trust && from.name === to.name) continue; // a right inside one zone crosses nothing
    rows.push(row({ key: `a:${x.id ?? x.resource}`, kind: op ? "operator" : x.public ? "entry" : "right", from: x.public ? { name: x.principal || "Internet", trust: "public" } : pn ? z(from) : { name: x.principal ?? "unnamed", trust: null },
      to: z(to), identity: x.principal ?? null, expects: gate.principal ?? null, check: checkText(gate) ?? x.auth ?? null, at: gate.at ?? x.at ?? null, holds_if: gate.holds_if ?? null,
      carries: gate.carries ?? null, change: changeOf(x), ends: { from: pn ? cardOf(pn) : null, to: x.node ?? null }, access: x, what: x.resource ?? "", actions: x.actions ?? [],
      unmapped: !x.public && !op && !pn, unused: x.used === false, ...(op ? { valueFrom: x.value_from ?? null, derived: Boolean(x.derived) } : {}) },
    { threat: (t) => t.where?.access === x.id, finding: (f) => (homeOf.get(f) ?? []).includes(x.id) }));
  }
  edges.forEach((e, i) => {
    const a = zoneOfNode(e.from), b = zoneOfNode(e.to), gate = (gates ?? []).find((g) => g.where?.edge === `e${i}` || (g.where?.from === e.from && g.where?.to === e.to)) ?? e.gate ?? {};
    const st = e.status === "new" ? "added" : e.status === "changed" || e.changed ? "changed" : e.status === "unchanged" ? "unchanged" : null;
    const match = { threat: (t) => t.where?.edge === `e${i}` || (t.where?.from === e.from && t.where?.to === e.to), finding: (f) => f.breaks?.edge === `e${i}` || (f.breaks?.from === e.from && f.breaks?.to === e.to) };
    const base = { key: `e:${i}`, from: z(a), to: z(b), identity: label(e.from), expects: gate.principal ?? null, check: checkText(gate), at: gate.at ?? null, holds_if: gate.holds_if ?? null,
      carries: gate.carries ?? null, change: st, ends: { from: e.from, to: e.to }, edge: i, what: e.label ?? "" };
    // In one process: no crossing. It bypasses a boundary when the code it reaches also gets calls from another frame
    // (a consumer written for a queue, here called directly), or the data marks it as a crossing.
    if (inProcess(e) || (node(e.from)?.group && node(e.from)?.group === node(e.to)?.group)) {
      const other = edges.some((x, j) => j !== i && x.to === e.to && node(x.from)?.group !== node(e.to)?.group && !inProcess(x));
      const named = (bypasses ?? []).length ? bypasses.some((x) => x.edge === `e${i}` || (x.from === e.from && x.to === e.to)) : inProcess(e) && (e.crosses || other);
      if (named) rows.push(row({ ...base, kind: "bypass", check: null, what: `${e.label ?? "a direct call"}: bypasses the boundary of ${label(e.to)}` }, match));
      return;
    }
    if (!e.crosses && !(a && b && a.id !== b.id)) return;
    if (node(e.from)?.type === "external" && (access ?? []).some((x) => x.public && x.node === e.to)) return; // the way in's row says it
    rows.push(row({ ...base, kind: "call" }, match));
  });
  // No operator way in the data, but a gate's condition names configuration or a secret: whoever deploys sets it.
  if (!rows.some((r) => r.kind === "operator")) for (const r of [...rows]) {
    const v = CONFIG.exec(String(r.holds_if ?? ""));
    if (v) rows.push({ key: `o:${r.key}`, kind: "operator", from: { name: "Operator (deploy)", trust: null }, to: r.to, identity: "whoever deploys", expects: null, check: null, at: r.at, holds_if: null,
      carries: null, change: null, ends: { from: null, to: r.ends.to }, what: `sets ${/^[A-Z]/.test(v[0]) ? v[0] : "the configuration"} that check ${rows.indexOf(r) + 1} holds on`, result: "not_assessed",
      reason: "Derived from the condition of a check: the data names no operator way.", findings: [], threats: [], stride: "", goal: null, path: null, evidence: null, conflicts: [], derived: true });
  }
  return rows;
}
// Whether a crossing is new or changed in this PR (not said counts as such: better shown than hidden).
// An operator's way derived from a gate's condition belongs to that gate, so it shows with it whatever its own change.
export const crossingChanged = (r) => r.change === null || CHANGED.includes(r.change) || (r.kind === "operator" && Boolean(r.derived));

// The sentence over the Security page, from the data: the door and its check, the condition it holds on and whether a
// finding says it breaks, what lies behind it, the other changes, and how many crossings are assessed. "Security · 0"
// is never alone.
export function secSentence(rows, openSecurity = 0) {
  const now = (rows ?? []).filter(crossingChanged), n = (k) => now.filter((r) => r.kind === k).length;
  const many = (c, one, more) => `${c} ${c === 1 ? one : more}`;
  const door = (r) => {
    const top = [...r.findings].sort((a, b) => (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9))[0];
    const broken = top && (top.impact === "unauthorized_access" || top.security) && ["critical", "high"].includes(top.severity);
    return `The way in is ${r.what || r.to.name}, open to ${r.identity ?? "the outside"}; ${r.check ? `its check (${r.check})` : "no check is named"}${r.holds_if ? ` holds only if ${r.holds_if.replace(/\.$/, "")}` : r.check ? " is named without its condition" : ""}${broken ? `, and an unresolved ${top.severity} finding says it does not: ${top.title.replace(/\.$/, "")}` : ""}.${r.goal ? ` Behind it: ${r.goal.replace(/\.$/, "")}.` : ""}`;
  };
  const doors = now.filter((r) => r.kind === "entry").map(door);
  const more = [n("right") && many(n("right"), "right into another zone", "rights into another zone"), n("call") && many(n("call"), "call over a trust boundary", "calls over a trust boundary"),
    n("bypass") && many(n("bypass"), "call that bypasses a boundary", "calls that bypass a boundary"), n("operator") && many(n("operator"), "operator way", "operator ways")].filter(Boolean);
  const first = doors.length ? doors.join(" ") : "This PR opens no way in from the public side that the data names.";
  const rest = more.length ? ` It also adds or changes ${more.length > 1 ? `${more.slice(0, -1).join(", ")} and ${more.at(-1)}` : more[0]}.` : "";
  const na = now.filter((r) => r.result === "not_assessed").length;
  const tally = now.length ? ` ${now.length - na} of ${many(now.length, "crossing", "crossings")} ${now.length - na === 1 ? "is" : "are"} assessed, ${na} not assessed.` : "";
  return `${first}${rest}${tally} ${openSecurity ? `${many(openSecurity, "security finding is", "security findings are")} unresolved.` : "No security finding is unresolved."}`;
}

// The security run's effective zones ([{node, drawn, effective, where}], derived from its gates) in the shape of
// effectiveZones: Map(node id -> {trust, drawn, zone, why}); empty list: none.
export function effectiveFrom(list, arch) {
  const zones = arch?.zones ?? [], zoneOf = (nid) => zones.find((z) => z.id === (arch?.nodes ?? []).find((n) => n.id === nid)?.zone) ?? null, out = new Map();
  for (const x of list ?? []) if (x?.node && x.effective && x.effective !== x.drawn) out.set(x.node, { trust: x.effective, drawn: x.drawn, zone: zoneOf(x.node) ?? { name: x.drawn, trust: x.drawn }, why: x.where ? `its first check is at ${x.where}` : "its first check is in its own code" });
  return out;
}

// ---- the architecture map with the boundary as it really runs (panel check, wave 5)
// The analysis' picture for Architecture impact: a card runs in what it is deployed in, so code without a deployment
// of its own takes the zone of what it runs in (runs_in) or, in a frame of shared code, none (no zone dot); a call in
// one process crosses nothing ("‖" off) and, when it reaches code that also gets calls from another frame or the run
// marked it as a crossing, `bypass`; a caller from outside is a card "Internet" (the outermost principal) with a call
// to each public way in, the "‖" on it. The calls keep their indexes (the new ones come last).
const SHARED = /librar|shared|common|module|package|util/i;
export function mapArch(arch, access = [], bypasses = []) {
  if (!arch) return arch;
  const nodes = arch.nodes ?? [], node = (id) => nodes.find((n) => n.id === id), frame = (id) => (arch.groups ?? []).find((g) => g.id === node(id)?.group);
  // runs_in names a card or a frame (a deployment): a frame's zone is the one its own cards carry.
  const frameZone = (gid) => nodes.find((n) => n.group === gid && n.zone && !n.runs_in)?.zone;
  const zoneOf = (n, k = 0) => (n?.runs_in && k < 4 ? (node(n.runs_in) ? zoneOf(node(n.runs_in), k + 1) : frameZone(n.runs_in)) ?? n.zone : SHARED.test(frame(n?.id)?.label ?? "") && k === 0 ? undefined : n?.zone);
  const feeds = (e, i) => (arch.edges ?? []).some((x, j) => j !== i && x.to === e.to && node(x.from)?.group !== node(e.to)?.group && !inProcess(x));
  const named = (e, i) => ((bypasses ?? []).length ? bypasses.some((x) => x.edge === `e${i}` || (x.from === e.from && x.to === e.to)) : Boolean(e.crosses || feeds(e, i)));
  const edges = (arch.edges ?? []).map((e, i) => (inProcess(e) ? { ...e, crosses: false, bypass: named(e, i) } : e));
  // A way in the analysis already draws a caller from outside for (an external card that calls it) needs no other.
  const doors = (access ?? []).filter((x) => x.public && node(x.node) && !(arch.edges ?? []).some((e) => e.to === x.node && node(e.from)?.type === "external"));
  const out = { ...arch, nodes: nodes.map((n) => ({ ...n, zone: zoneOf(n) })), edges };
  if (!doors.length) return out;
  const who = doors.map((x) => x.principal).filter(Boolean);
  return { ...out, groups: [{ id: "\0outside", label: "Outside", kind: "" }, ...(arch.groups ?? [])],
    nodes: [{ id: "\0in", label: "Internet", type: "external", group: "\0outside", status: "unchanged", description: [...new Set(who)].join(", ") || "callers from outside" }, ...out.nodes],
    edges: [...edges, ...doors.map((x) => ({ from: "\0in", to: x.node, label: x.resource ?? "", crosses: true, status: x.change === "added" || x.opened_by_pr ? "new" : undefined, evidence: x.at }))] };
}

// ---- a GitHub comment as the review shows it (review.js item "gh")

// GitHub renders the HTML in a comment; TextView.markdown shows most of it as raw text and the list's height counts
// it too (a bot's badge line alone is hundreds of letters). ghMd turns the HTML GitHub renders into Markdown: HTML
// comments go, <details> folds to its summary unless `open` (as on GitHub), a picture or badge becomes its alt text as a
// chip, an image a link, <br> a line break, tables a Markdown table, <pre> a fence; a tag GitHub drops (an unknown
// element) goes and keeps its text; code (fences, `inline`) stays as it is. A type like `Vec<T>` is no tag and stays.
const ENTITY = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: " ", ensp: " ", emsp: " ", thinsp: " ", mdash: "—", ndash: "–", hellip: "…" };
const entities = (s) => s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+\d*);/gi, (m, e) => ENTITY[e.toLowerCase()] ?? (e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : m));
const GH_TAG = /<\/?(?:a|abbr|b|blockquote|br|caption|center|code|dd|del|details|div|dl|dt|em|font|h[1-6]|hr|i|img|ins|kbd|li|mark|ol|p|picture|pre|q|s|samp|small|source|span|strike|strong|sub|summary|sup|table|tbody|td|tfoot|th|thead|tr|tt|u|ul|var|[a-z]+-[a-z-]+)\b[^>]*>/gi;
const attr = (tag, name) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag)?.slice(1).find((x) => x !== undefined) ?? "";
const inner = (html) => entities(html.replace(GH_TAG, "")).replace(/\s+/g, " ").trim();
function htmlTable(t) {
  const rows = [...t.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) => [...r[1].matchAll(/<t([hd])\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) => inner(c[2]).replace(/\|/g, "\\|")));
  if (!rows.length) return inner(t);
  const n = Math.max(...rows.map((r) => r.length)), line = (r) => `| ${[...r, ...Array(n - r.length).fill("")].join(" | ")} |`;
  return `\n\n${line(rows[0])}\n|${" --- |".repeat(n)}\n${rows.slice(1).map(line).join("\n")}\n\n`;
}
export function ghMd(body, open = false) {
  const keep = [], hold = (x) => `\u0000${keep.push(x) - 1}\u0000`;
  let s = String(body ?? "").replace(/\r/g, "").replace(/<!--[\s\S]*?(-->|$)/g, "");
  // Code first, held out of everything below: fences, <pre>, inline code.
  s = s.replace(/^([ \t]*)(```|~~~)[^\n]*\n[\s\S]*?(?:\n[ \t]*\2[^\n]*|$)/gm, (m) => hold(m));
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, x) => `\n\n${hold(`\`\`\`\n${entities(x.replace(/<\/?code\b[^>]*>/gi, "")).replace(/\n$/, "")}\n\`\`\``)}\n\n`);
  s = s.replace(/(`+)[^`\n]+?\1/g, (m) => hold(m));
  // <details>, innermost first: its summary as a line; its content only when open.
  for (let k = 0; k < 20 && /<details\b/i.test(s); k++) {
    s = s.replace(/<details\b[^>]*>((?:(?!<details\b)[\s\S])*?)(<\/details>|$)/i, (_m, x) => {
      const sum = /<summary\b[^>]*>([\s\S]*?)<\/summary>/i.exec(x), rest = sum ? x.replace(sum[0], "") : x, title = (sum && inner(sum[1])) || "Details";
      return `\n\n**${open ? "▾" : "▸"} ${title}**\n\n${open ? `${rest}\n\n` : ""}`;
    });
  }
  s = s.replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, htmlTable);
  s = s.replace(/<picture\b[^>]*>[\s\S]*?<\/picture>/gi, (m) => { const a = attr(/<img\b[^>]*>/i.exec(m)?.[0] ?? "", "alt"); return a ? hold(`\`${a}\``) : ""; });
  s = s.replace(/<img\b[^>]*>/gi, (m) => { const a = attr(m, "alt"), src = attr(m, "src"); return src ? `[🖼 ${a || "image"}](${src})` : a; });
  s = s.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_m, a, x) => { const href = attr(`<a ${a}>`, "href"), t = x.trim(); return href && t ? `[${t}](${href})` : t; });
  s = s.replace(/^[ \t]*<br\s*\/?>[ \t]*$/gim, "\n").replace(/<br\s*\/?>/gi, "  \n");
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n, x) => `\n\n${"#".repeat(Number(n))} ${x.trim()}\n\n`);
  s = s.replace(/<\/?(?:strong|b)\b[^>]*>/gi, "**").replace(/<\/?(?:em|i)\b[^>]*>/gi, "*").replace(/<\/?(?:del|s|strike)\b[^>]*>/gi, "~~").replace(/<\/?(?:code|kbd|tt|samp)\b[^>]*>/gi, "`");
  s = s.replace(/<hr\b[^>]*>/gi, "\n\n---\n\n").replace(/<li\b[^>]*>/gi, "\n- ").replace(/<\/?(?:p|div|ul|ol|blockquote|dl|center)\b[^>]*>/gi, "\n\n");
  s = entities(s.replace(GH_TAG, ""));
  s = s.replace(/\]\(([^)\s]+)\s+"[^"]*"\)/g, "]($1)"); // a link's title shows on hover on GitHub; here it would show as text
  s = s.replace(/[ \t]+\n(?!\n)/g, (m) => (m.startsWith("  ") ? "  \n" : "\n")).replace(/\n{3,}/g, "\n\n").trim();
  return s.replace(/\u0000(\d+)\u0000/g, (_m, k) => keep[Number(k)]).replace(/\u0000(\d+)\u0000/g, (_m, k) => keep[Number(k)]);
}
// A Markdown text cut at its fenced code blocks, which the review draws itself (their font follows the card, and
// their height is exact): [{text}] and [{code: lines, lang}] in order; a block without its closing fence runs to the end.
export function mdBlocks(md) {
  const out = [], lines = String(md ?? "").split("\n");
  let text = [];
  const flush = () => { const t = text.join("\n").trim(); if (t) out.push({ text: t }); text = []; };
  for (let i = 0; i < lines.length; i++) {
    const f = /^[ \t]*(```+|~~~+)\s*([\w+-]*)/.exec(lines[i]);
    if (!f) { text.push(lines[i]); continue; }
    flush();
    const code = [];
    for (i++; i < lines.length && !lines[i].trimStart().startsWith(f[1]); i++) code.push(lines[i]);
    out.push({ code, lang: f[2] || "" });
  }
  flush();
  return out;
}

// ---- the Resilience page (CONCEPT-RESILIENCE.md): pure helpers for the view
// Before the run: where it would start, counted from the picture and the ways in without a model ("This PR adds 1
// queue, 2 Lambdas and 1 public route."). nodes: the cards to mark with ○. ponytail: a rough count by type and frame
// words until the data's own count (ai.resilienceStart) is there.
export function resStartOf(arch, access = []) {
  const nodes = arch?.nodes ?? [], groups = arch?.groups ?? [], isNew = (x) => x.status === "new" || x.status === "added";
  const queues = nodes.filter((n) => /queue|sqs|topic|stream|bus/i.test(`${n.type ?? ""} ${n.label ?? ""}`));
  const fns = groups.filter((g) => /lambda|function|service|container|worker|job/i.test(`${g.kind ?? ""} ${g.label ?? ""}`));
  const routes = (access ?? []).filter((x) => x.public), many = (k, one, more) => `${k} ${k === 1 ? one : more}`;
  const parts = [queues.length && many(queues.length, "queue", "queues"), fns.length && many(fns.length, "function", "functions"), routes.length && many(routes.length, "public way in", "public ways in")].filter(Boolean);
  const verb = [...queues, ...nodes.filter((n) => fns.some((g) => g.id === n.group))].some(isNew) ? "adds or changes" : "touches";
  const text = parts.length ? `This PR ${verb} ${parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0]}: the run starts there.` : "The picture names no queue, function or public way in: the run reads the diff itself.";
  return { text, nodes: [...new Set([...queues.map((n) => n.id), ...routes.map((x) => x.node).filter(Boolean), ...nodes.filter((n) => fns.some((g) => g.id === n.group) && (n.type === "function" || /handler|consumer/i.test(n.label ?? ""))).map((n) => n.id)])] };
}
// The paths in the order of the page: blockers first, then findings, not assessed, limited ones; the order otherwise kept.
const RES_RANK = (p) => (p.blocker ? 0 : p.result === "finding" ? 1 : p.result === "not_assessed" ? 2 : 3);
export const resOrder = (paths) => [...(paths ?? [])].sort((a, b) => RES_RANK(a) - RES_RANK(b));
// The one picture of an opened path, by what it has: a ladder (retries), a budget (a timeout), a race's timeline, or
// the writers of a shared state (two writers or more); null: none.
export function resPicture(p) {
  const has = { ladder: p?.ladder?.length > 0, budget: Boolean(p?.budget), race: (p?.race?.steps ?? []).length > 0, writers: (p?.writers ?? []).filter((w) => w.kind === "W").length >= 2 };
  const pick = { retry: "ladder", timeout: "budget", race: "race", state: "writers" }[p?.kind];
  return pick && has[pick] ? pick : ["ladder", "budget", "race", "writers"].find((k) => has[k]) ?? null;
}
// A budget as a bullet bar in px: the value's bar, the limit's line, the part over it. width: the bar's room.
export function budgetBar({ value_s, limit_s }, width = 320) {
  const max = Math.max(value_s, limit_s) * 1.1 || 1, px = (s) => Math.round((s / max) * width);
  return { value: px(value_s), limit: px(limit_s), over: Math.max(0, px(value_s) - px(limit_s)), overS: Math.max(0, value_s - limit_s) };
}
// A path in the shape the page draws, from either shape: this view's own fixture or R-D's withResilience (blocker.why,
// ladder {factors [{label, n, at}], text}, budget {…, text}, races[] and state[] at the top). Pure.
export function resPathView(p, res = {}) {
  const lad = Array.isArray(p.ladder) ? p.ladder : (p.ladder?.factors ?? []).map((f) => ({ name: f.label, factor: f.n === null || f.n === undefined ? "no limit" : `×${f.n}`, at: f.at }));
  const race = p.race ?? (res.races ?? []).find((r) => (r.findings ?? []).some((id) => (p.findings ?? []).includes(id))) ?? (p.kind === "race" ? (res.races ?? [])[0] : null) ?? null;
  const st = p.writers ? null : (res.state ?? []).find((x) => (x.writers ?? []).length >= 2 && x.writers.some((w) => (p.steps ?? []).includes(w.node)));
  const writers = p.writers ?? (st ? [...st.writers.map((w) => ({ ...w, kind: "W", guard: w.guard ?? "none" })), ...(st.readers ?? []).map((r) => ({ ...r, kind: "R", guard: "" }))] : undefined);
  const budget = p.budget ? { ...p.budget, note: p.budget.note ?? p.budget.text } : null;
  return { ...p, ladder: lad, product: p.product ?? (Array.isArray(p.ladder) ? null : p.ladder?.text) ?? null, budget, race, writers, state: p.state ?? st?.what ?? st?.id,
    blocker: p.blocker ? { reason: p.blocker.reason ?? p.blocker.why ?? "" } : null };
}
