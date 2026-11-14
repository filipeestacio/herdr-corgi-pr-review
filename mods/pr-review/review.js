// The review layout (layouts/review.json): one PR in the whole window, as two copies of this mod.
// Part "bar": back, PR, context tag, model picker, cost. Part "review": left the AI's steps in risk order (or the file
// tree), right every diff line in one virtual list with suggestions and comments inline. Mixed into PrReview
// (main.js), so comments, the pending review and "Send review" are the panel's own code.
// Tabs: Files (since your last review, or the full PR), Layers (Overview, Security blast radius, Architecture impact,
// Verify, then the AI's layers; stack.js draws the pictures), Findings. Cheap context (since-diff, related PRs, CI checks)
// loads by itself; every LLM call (Analyze, Only new changes, Verify fixes) is a click.
// UI text is English; the AI's content stays as it answers. Keys (diff focused): j/k step (Files tab: file), n/p hunk, c comment, a/x take/drop suggestion, s/f Layers/Files, Esc back.
// Commenting works like GitHub's "Files changed": a click on a line number (shift-click: a range) or c opens the
// composer under that line, pending comments show as threads there, and "Finish your review" in the bar opens the
// submit popover: one GitHub review (gh api) or, for a PR with an agent session, the prompt to that session.
import { div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, TextView, v_virtual_list, VirtualListScrollHandle, ScrollHandle, Textarea, TextareaState, Input, InputState } from "gpui-base";
import { exec, hc, run, spaces, agents, terminals, focused, pickFolder, theme, settings, readTextFile, writeTextFile, shared, setShared, appHome, nextCommand, watchFolder, openOverlay, closeOverlay, props, home } from "herdr";
import { parseReports, findingStatus, mergeFindings, findingCounts, countLine, runsOf, fixPrompt, hash, touchReview, expireReviews, resumeFields, itemKeys, expandTabs, tokenAt } from "./pr.js";
import * as C from "./context.js";
import { hasTool, copyText, openUrl, loadSetup, readConfig } from "./setup-view.js";
import { taskList, taskHead, verdictParts, reviewState, certaintyLine, severityTip, componentLine } from "./pr.js"; // the Overview page
import { findingSteps, funnel, funnelLine, ownerOf, quickFirst, hasEffort } from "./pr.js"; // the Findings tab
import { highlightJob, highlightStep, highlightLines, langOf, colors, renderLine, refAt } from "./syntax.js";
import { lookup, warm, contents, vscodeArgs, where, setTrusted } from "./defs.js";
import { diffRows, hunksOf, selection, uiLine, lineKey, rangeOf, MODELS, tierOf, codeModel, priceOf, reviewRequest, mapReview, suspectComment, stepKey, fileRows, fileTree, atLine, splitPatch } from "./pr.js";
import { ghTarget, lowValue, markReviewed, sinceBase, verifyCandidates, applyVerification, blastArch, preMergeChecks, mergeBlockers, triageOf } from "./pr.js";
import { diffLines, inDiff, ghReview, lineThreads, suggestionBlock, buildReview, layoutPlan, specElements, diagramsState, codeOf, isStale } from "./pr.js";
import { wheelStep, foldOnOpen, allocate, recenter, hsVisible, pastTop } from "./views.js";
import { orderDiffers, worst, byUrgency } from "./views.js";
import { archView, archModel, archLegend, visualsCard, visualCard, segBar, foldCard, chip, legend, specTag, sourceLegend, SEVERITY_COLOR } from "./stack.js";
import { visualPlan } from "./stack.js";
import { factRows, findingAnchor, rangeMarks, wrapCount, mdHeight, SEVERITY_SCALE } from "./views.js";
import { plainText } from "./pr.js";
import { hasSources, archLayout, archBands } from "./arch.js";
import * as TH from "./threads.js";
import { leftWidth, rowClick, CHIP_W, ASK_W, keyRoute, scopeLine, pictureOf, scopeOf, scopeFiles, hunksFor, mapAnswer, threadAdd, threadOf, history, highlightOf, rangeLabel, pinAnchor, pinAdd, pinDrop, pinsOf, pinsOn, codePins, drillPush, drillTo, crumbs, drillKey, cachePut, mapDrill, exploreId, exploreIndex, exploreAi, pathOf, lineOf, repoOfRemote, exploreTrust, layersForNode } from "./explore.js";

const LEVEL = { high: "ansi1", medium: "ansi3", low: "ansi4", skim: "muted" };
const COVER = { seen: ["done", "ansi2"], partly: ["partly", "ansi3"], absent: ["missing", "ansi1"], extra: ["extra (not asked)", "ansi4"] };
// ponytail: GitHub's saturated diff hues; the theme's olive ansi2 under alpha turned the code background grey and dulled the syntax colors.
const tint = (kind) => (kind === "+" ? "#2ea043" : "#f85149");
const GH_GREEN = "#238636"; // GitHub's "Review changes" button
const STATUS = { added: ["A", "ansi2"], deleted: ["D", "ansi1"], renamed: ["R", "ansi4"], modified: ["M", "ansi3"] };
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
// Diff column geometry: clicks inside the virtual list are placed by x (one click handler per list).
const FOLD_MARGIN = 1500 * 22; // px: open the files around the view again this close to a folded one
const SPLIT = 6, ROW = 22, GUTTER = 4 + 48 + 48 + 22, GAP_SEG = 110, BTN = 110, BTN_GAP = 8, ACT = 44;
const FILE_CHEV = 30, FILE_SEEN = 100, FILE_WHOLE = 124;
const MORE = 20; // lines per ↑/↓ click
const KEYS_POP = { width: 340, height: 330 }; // the "?" popup: sized to its rows and the last line
const COMPOSE = 168; // the composer row: header + a fixed-height textarea (the list needs every row's height up front)
const progressFile = () => `${appHome()}/pr-data/review-progress.json`; // per PR: progress and where you were (bounded)
const MAX_PROGRESS = 100;
// Open reviews, for other mods (PROVIDERS.md). Resume contract for any mod:
//   setShared("review.target", <a PR from pr-data/prs.json, or a registry entry's `target`>); run("layout.switch", { name: shared("review.layout") ?? "review" })
// shared("review.open") is this file's in-progress and sent entries: [{url, number, repo, title, context, startedAt,
// lastTouched, headSha, status, progress: {stepsChecked, steps, filesViewed, files, comments, findingsOpen}, target}].
const openFile = () => `${appHome()}/pr-data/open-reviews.json`;
// shared("review.registry") is every entry, done ones too, with {at}: for plug-ins that mirror reviews elsewhere
// (PROVIDERS.md). Written on each registry change, 1.5 s after the last edit.
// The AI analysis' model: any value the claude CLI offers (models.py), Sonnet until one is picked.
// At least Sonnet (pr.js codeModel): every use reads or judges code, which Haiku is too weak for.
const model = () => { const m = shared("review.model"); return codeModel(typeof m === "string" && m ? m : "sonnet"); };
// The models the CLIs offer per context ({at, claude, codex}, models.py), shared so the Reviews popup sees them too;
// pr-data/models.json keeps them across restarts.
const modelsFile = () => `${appHome()}/pr-data/models.json`;
const modelsDoc = () => shared("review.models") ?? {};
// A model's name as its CLI calls it ("Opus 5.5"), else the class label, else the value itself.
export const modelLabel = (m) => Object.values(modelsDoc()).flatMap((d) => d?.claude ?? []).find((x) => x.value === m)?.label ?? MODELS[m]?.label ?? m;
// Codex's models (one login for every context): from whichever context asked last.
const codexChoices = () => Object.values(modelsDoc()).map((d) => d?.codex ?? []).find((l) => l.length) ?? [];
// The model id a picker value stands for ("opus" -> "claude-opus-5-5"), from the CLI's list.
const resolvedOf = (m) => Object.values(modelsDoc()).flatMap((d) => d?.claude ?? []).find((x) => x.value === m)?.resolved ?? m;
// "$4 / $20 per MTok": input and output.
const priceText = (m) => { const [i, o] = priceOf(resolvedOf(m)); return `$${i} / $${o} per MTok`; };
// The choices for a context: the CLI's aliases (opus, fable, sonnet: each its family's newest model; older models by
// full id are left out, unless one is the current pick), or the classes until the CLI answered. Never Haiku: every
// choice here reads or judges code (codeModel).
const modelChoices = (ctx) => {
  const list = modelsDoc()[ctx]?.claude ?? [], cur = model();
  const shown = list.filter((c) => (!c.value.startsWith("claude-") || c.value === cur) && tierOf(c.value) !== "haiku");
  return shown.length ? shown : Object.entries(MODELS).filter(([k]) => k !== "haiku").map(([value, v]) => ({ value, label: v.label, description: "" }));
};
const cacheDir = () => `${appHome()}/pr-data/cache`;
const valuesOn = () => shared("review.values") !== false; // inline example values (flow traces), on by default
const clock = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
const CAP = { haiku: 1, sonnet: 3, opus: 10 }; // review.py BUDGET, per tierOf class
const findDir = () => `${appHome()}/pr-data/findings`;
const threadsFile = () => `${appHome()}/pr-data/threads.json`; // sent and posted comments as threads (threads.js bounds it)
const repliesDir = () => `${appHome()}/pr-data/replies`; // the agent's answers, <pr hash>.jsonl
const exploreDir = () => `${appHome()}/pr-data/explore`; // explorations: <id>.json and index.json (the newest 20)
const deepFile = () => `${appHome()}/pr-data/deep.json`; // Ask threads per PR and drill-downs per node (explore.js bounds both)
const ctxDoc = () => shared(C.CONTEXTS_KEY);
const prCtx = (pr) => C.prContext(ctxDoc(), pr, home());
const ALL_REVIEWERS = { claude: ["Claude code review", "ansi5"], security: ["Security review", "ansi1"], codex: ["Codex review", "ansi6"] };
// Codex is optional: offered only when `codex` is on PATH (Setup's last check). Labels stay for findings already there.
// The analysis files its own findings inside its layers, and an AI suggestion can be one source of a finding (pr.js
// mergeFindings): a label and colour here, never a run of their own.
const REVIEWERS = { ...ALL_REVIEWERS, analysis: ["Analysis", "ansi4"], ai: ["AI suggestion", "ansi3"] };
const reviewersNow = () => Object.entries(ALL_REVIEWERS).filter(([k]) => k !== "codex" || hasTool("codex"));
// A finding's state words (pr.js findingStatus): "Fixed" only after a passed verification.
const FSTATUS = { open: ["Unresolved", "muted"], progress: ["Fix sent", "ansi3"], fixed: ["Fixed", "ansi2"], dismissed: ["Dismissed", "dim"], recheck: ["Unresolved, line changed", "ansi3"] };
const SEV = { high: "ansi1", medium: "ansi3", low: "ansi4" };
// Where a card comes from: its stripe, and the Show switch's colours.
const SOURCE = { mine: "accent", ai: "ansi3", agents: "ansi6", github: "ansi4", notes: "ansi5" };
// Hover texts for the Show chips, the Comments tab's filters and its state chips.
const SHOW_TIP = { mine: "Comments you wrote: drafts (local until you finish the review), sent to agents, or posted", ai: "Findings and AI notes under their lines", agents: "Replies from agent sessions", github: "Comments other people left on GitHub", notes: "Your pinned notes, private to you" };

const TAB_TIP = { files: "The changed files; tick the ones you have viewed", steps: "The AI's layers of this change, with explanations and pictures", findings: "Every finding once, with its sources and its state; fixes sent to an agent and their verification", comments: "All comments on this PR: yours, the agents' and GitHub's" };
const COVER_TIP = { seen: "The diff does what this asks", partly: "The diff does only part of what this asks", absent: "Nothing in the diff does this", extra: "The diff does this, but it was not asked for" };
const COMPOSE_TIP = { insertSuggestion: "Insert the selected lines as a GitHub suggestion block", closeComposer: "Close the composer without saving (Esc)", addDraft: "Add to your pending review; nothing is posted yet (⌘↩)", singleComment: "Post this one comment at once, or preview it first when it goes to an agent" };
const STATE_TIP = { pending: "Pending: written by you, not sent yet", waiting: "Sent to agent: no reply yet", replied: "Agent replied, or someone answered on GitHub", fixed: "Reported fixed: the agent says it is done; nothing has checked it", declined: "Declined: the agent chose not to change it", github: "A comment from GitHub", note: "A pinned note, private to you" };
const STALE_TIP = "The code here changed since this comment was written";
const CARD_W = 720, CARD_MIN = 420, CARD_HEAD = 32, CARD_REPLY = 34, CARD_GAP = 6;
const THREAD_COLOR = { fixed: "ansi2", answered: "accent", wontfix: "muted", question: "ansi3", sent: "ansi4", posted: "ansi4" };
const PROBE = "0".repeat(40);
const CTX_MS = 10 * 60000; // related PRs, CI checks, mergeability (related.py): asked again after this while the review is open
const OPEN_ST = ["open", "progress", "recheck"];
// A finding's card in the diff: its height folded, the label column of an open one, the link at its head's right end.
const FIND_FOLDED = 34, FIND_LABEL = 112, FIND_LINK = 150;
// A layer's head over its code: its texts wrap at about 95 characters instead of running across the whole column.
const LAYER_TEXT = 640;
// The Layers tab's pages (left nav); null: the diff of the current layer.
const PAGES = [["overview", "Overview"], ["blast", "Security blast radius"], ["arch", "Architecture impact"]]; // measures the mono font's character width, for clicks on tokens inside the virtual list

// "Reviews ▾" in the bar opens this popup (props {part: "reviews"}): each reviewer with its last run; Run reaches the
// review copy through its nextCommand.
// Every run that makes findings is a row, the analysis first: what it found (a zero says whether it ran, threads.js
// runLine), its price and when. Below: who gets the code, on which account. The popup is as high as its rows.
const REVIEW_CAP = { haiku: 0.5, sonnet: 3, opus: 8 }; // reviewers.py BUDGET, per tierOf class
const codexMenu = () => [{ value: "", label: "Codex default" }, ...codexChoices()];
const openCodexMenu = () => { const cur = shared("review.codexModel") || ""; return openOverlay({ mod: "pr-review", props: { part: "cmenu", key: "codex",
  items: codexMenu().map((c) => [`${c.value === cur ? "✓ " : ""}${c.label}`, false, `codex-model:${c.value}`]) }, kind: "popup", width: 240, height: 14 + 32 * codexMenu().length }); };
const reviewsPop = () => { const cx = hasTool("codex"); return { width: 500, height: 28 + 60 * (reviewersNow().length + 1) + (cx && codexChoices().length ? 36 : 0) + (cx ? 96 : 60) }; };
export function renderReviews() {
  const t = theme(), runs = runsOf(shared("review.reviewers") ?? {}), meta = shared("review.meta") ?? {}, pr = shared("review.target"), mine = meta.url === pr?.url;
  const total = mine ? meta.findings?.total ?? 0 : 0, a = mine ? meta.shown : null, cap = REVIEW_CAP[tierOf(model())];
  const row = (k, label, c, line, bad, right) => h_flex().id(`rv-rr-${k}`).gap(10).px(8).py(6).rounded(7).items_center()
    .child(div().w(8).h(8).flex_none().rounded_full().bg(t[c]))
    .child(v_flex().flex_1().min_w(0).child(div().font_semibold().child(label)).child(div().text_size(12).line_height(1.4).whitespace_normal().text_color(bad ? t.ansi1 : t.muted).child(line)))
    .children([right].filter(Boolean));
  const cur = codexMenu().find((c) => c.value === (shared("review.codexModel") || "")) ?? codexMenu()[0];
  return v_flex().id("rv-reviews").size_full().p(8).gap(4).bg(t.popover).text_color(t.foreground).text_size(13)
    .child(row("analysis", REVIEWERS.analysis[0], REVIEWERS.analysis[1], mine && meta.busy ? `Running with ${modelLabel(meta.busy)}`
      : a ? [`${meta.findings?.analysis ?? 0} ${meta.findings?.analysis === 1 ? "finding" : "findings"}`, a.cost != null ? `$${Number(a.cost).toFixed(3)}` : null, modelLabel(a.model)].filter(Boolean).join(" · ")
      : "Not run on this PR yet. It starts from the Overview page.", false, null))
    .children(reviewersNow().map(([k, [label, c]]) => {
      const r = runs[k], n = r?.count ?? 0, done = r?.state === "done";
      const line = TH.runLine(r, n ? 0 : total, { running: r?.started ? clock(Date.now() - Date.parse(r.started)) : "", took: r?.ms ? clock(r.ms) : null, ago: r?.at ? ago(r.at) : null })
        + (k === "codex" ? (done ? " · Codex does not report its price" : "") : !r?.state ? ` · capped at $${cap}` : "");
      return row(k, label, c, line, r?.state === "failed", r?.state === "running" ? div().flex_none().child(SPIN[0]).frames(SPIN, 90)
        : pill(`rv-rrun-${k}`, t, r?.state ? "Run again" : "Run", () => { run(`pr-review.reviewer:${k}`); closeOverlay(props().overlay); }).flex_none()
          .tooltip(k === "codex" ? "Run the codex CLI read-only on the PR head, with its own login; its price is not reported" : `One read-only review of the PR head with ${modelLabel(model())}, capped at $${cap}`));
    }))
    .when(hasTool("codex") && codexChoices().length > 0, (e) => e.child(h_flex().px(8).gap(8).items_center()
      .child(div().text_size(12).text_color(t.muted).child("Codex review model"))
      .child(pill("rv-cxm", t, `${cur.label} ▾`, () => openCodexMenu()).tooltip(cur.description || "The model in Codex's own settings"))))
    .child(div().px(8).pt(4).text_size(11.5).line_height(1.45).whitespace_normal().text_color(t.muted)
      .child(`Claude reviews: ${accountOf(pr ? prCtx(pr) : C.defaultOf(ctxDoc()))}. They read the PR head in a checkout, read-only, and send the diff and the files they open to the provider.`
        + (hasTool("codex") ? " Codex review: the codex CLI with its own login. It is a second provider (OpenAI) and gets the same checkout." : "")));
}

// "?" in the bar (or the ? key) opens this popup (props {part: "keys"}): the review's keys.
export function renderKeys() {
  const t = theme();
  return v_flex().id("rv-keys-pop").size_full().p(12).gap(7).bg(t.popover).text_color(t.foreground).text_size(13)
    .child(div().font_semibold().child("Keyboard shortcuts"))
    .child(div().pb(2).text_size(12.5).whitespace_normal().child("Click a line number or press c to comment; shift-click for a range."))
    .children([["j k", "next / previous file (Layers: step)"], ["n p", "next / previous hunk"], ["c", "comment on the selected line"], ["a x", "add the open AI note as a comment / hide it"],
      ["⌘ click", "go to definition"], ["⌘ ↩", "add the comment (in the composer)"], ["Esc", "close composer or popover, else back"]].map(([k, what]) =>
      h_flex().gap(10).items_center().child(h_flex().w(74).flex_none().gap(3).children(k.split(" ").map((x) => kbd(t, x)))).child(div().text_color(t.muted).child(what))));
}

// A small menu (props {part: "cmenu", key, items: [[label, danger, command?]]}): an item runs pr-review.<command>, or
// for a comment card's "⋯" pr-review.cmenu:<index>|<card key>, in the review copy.
export function renderCardMenu() {
  const t = theme(), { key, items = [], overlay } = props();
  return v_flex().id("rv-cmenu").size_full().p(4).gap(1).bg(t.popover).text_color(t.foreground).text_size(13)
    .children(items.map(([label, danger], k) => div().id(`rv-cm-${k}`).px(10).py(5).rounded(5).cursor_pointer().hover((s) => s.bg(t.hover))
      .text_color(danger ? t.ansi1 : t.foreground).on_click(() => { run(`pr-review.${items[k][2] ?? `cmenu:${k}|${key}`}`); closeOverlay(overlay); }).child(label)));
}

// The title bar of the floating agent terminal (props {part: "agentbar", title}): drag it, close it.
export function renderAgentBar() {
  const t = theme();
  return h_flex().id("rv-agentbar").size_full().px(12).gap(8).items_center().bg(t.chrome).text_size(13).text_color(t.foreground)
    .child(div().flex_1().min_w(0).truncate().font_semibold().child(props().title ?? "Agent"))
    .child(div().text_size(12).text_color(t.muted).child("prompt pasted, not sent: add words, Enter to send"))
    .child(pill("rv-agent-close", t, "Close", () => closeOverlay(props().overlay)).tooltip("Close this agent window"));
}
const stop = (_e, cx) => cx.stop_propagation(); // a control in the window-drag bar

// ponytail: last writer wins per key; a retry covers a concurrent write, not two copies editing one key at once.
export async function saveKey(path, key, value) {
  for (let attempt = 0; ; attempt++) {
    const before = await readTextFile(path).catch(() => null);
    const doc = before ? JSON.parse(before) : {};
    if (value === undefined) delete doc[key]; else doc[key] = value;
    try { return await writeTextFile(path, JSON.stringify(doc, null, 1), before); } catch (e) { if (attempt) throw e; }
  }
}

// Opens a PR in the review layout; Back returns to the layout shown now. The first time, the layout is copied from
// this folder into layouts/ ("review", or "pr-review" when another "review" layout is there; pr.js layoutPlan).
export async function startReview(target) {
  const dir = `${appHome()}/layouts`, read = (name) => readTextFile(`${dir}/${name}.json`).catch(() => null);
  const plan = layoutPlan(await read("review"), await read("pr-review"));
  if (plan.write) {
    await exec("mkdir", ["-p", dir]).catch(() => null);
    const text = await readTextFile(`${appHome()}/mods/pr-review/review-layout.json`);
    await writeTextFile(`${dir}/${plan.name}.json`, text, null).catch(() => null); // null: only when still missing
  }
  const back = shared("layout");
  if (back && back !== plan.name) setShared("review.back", back);
  setShared("review.layout", plan.name);
  setShared("review.explore", null);
  setShared("review.target", target);
  if (shared("review.minimized")?.target?.url === target?.url) setShared("review.minimized", null); // back in it: no entry
  run("layout.switch", { name: plan.name });
}

// Opens Explore in the review layout (pr-review.explore, the panel's "Explore a topic…", the review's ⋯ menu): a topic
// walked through in existing code, no PR. root: the repo to explore (default: the active space's repo, chosen there).
export async function startExplore(root = null) {
  const dir = `${appHome()}/layouts`, read = (name) => readTextFile(`${dir}/${name}.json`).catch(() => null);
  const plan = layoutPlan(await read("review"), await read("pr-review"));
  if (plan.write) {
    await exec("mkdir", ["-p", dir]).catch(() => null);
    await writeTextFile(`${dir}/${plan.name}.json`, await readTextFile(`${appHome()}/mods/pr-review/review-layout.json`), null).catch(() => null);
  }
  const back = shared("layout");
  if (back && back !== plan.name) setShared("review.back", back);
  setShared("review.layout", plan.name);
  setShared("review.explore", { start: true, root, space: focused()?.space ?? null, at: Date.now() });
  run("layout.switch", { name: plan.name });
}
const leave = () => run("layout.switch", { name: shared("review.back") || "main" });
// Minimize: back to the previous layout with the review kept as one entry (part "mini", a float in the main layout):
// Open brings it back where it was, ✕ drops it. One at a time: minimizing another review replaces it.
const minimize = () => { const pr = shared("review.target"); if (pr) setShared("review.minimized", { target: pr, at: Date.now() }); leave(); };
export function renderMini() {
  const t = theme(), pr = shared("review.minimized")?.target;
  if (!pr) return div();
  // A small chip, so it covers little of the terminal under it: the PR number, its full title in the tooltip.
  return h_flex().id("rv-mini").h(28).pl(10).pr(3).gap(6).items_center().rounded_full().border_1().border_color(t.border).bg(t.popover)
    .text_size(12).text_color(t.foreground).tooltip(`${pr.repo ?? ""}#${pr.number ?? ""} ${pr.title ?? ""}`)
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation()) // a press the mod doesn't stop would drag the float
    .child(div().flex_none().font_semibold().child(`Review #${pr.number ?? ""}`))
    .child(div().id("rv-mini-open").px(8).h(22).flex().items_center().rounded_full().cursor_pointer().text_color(t.accent).hover((x) => x.bg(t.hover))
      .tooltip("Back to the review, where you left it").on_click(() => startReview(pr)).child("Resume"))
    .child(div().id("rv-mini-x").w(22).h(22).flex().items_center().justify_center().rounded_full().cursor_pointer().text_color(t.muted).hover((x) => x.bg(t.hover))
      .tooltip("Close the minimized review").accessibility_label("Close minimized review").on_click(() => setShared("review.minimized", null)).child("✕"));
}

const pill = (id, t, label, click, on = false, color) => div().id(id).px(9).h(26).flex().items_center().rounded(6).border_1()
  .border_color(on ? t.accent : t.border).text_size(12.5).text_color(color ?? (on ? t.foreground : t.muted)).cursor_pointer()
  .hover((s) => s.text_color(t.foreground)).on_mouse_down("left", stop).on_click(click).child(label);
const badge = (t, label, color) => div().flex_none().px(6).py(1).rounded(5).border_1().border_color(color).text_size(11.5).font_semibold().text_color(color).child(label);
// A layer's "risk" is how closely to read it (what its code touches), not a finding: named and coloured as reading
// depth, so it doesn't look like a problem next to the findings' high/medium/low.
const FOCUS = { high: ["Read closely", "it touches security, data or migrations, auth or concurrency"], medium: ["Read", "it changes core logic or an API/contract"],
  low: ["Glance", "configuration or small things"], skim: ["Skim", "tests, renames, formatting, generated code or docs"] };
const focusLabel = (s) => FOCUS[s.risk]?.[0] ?? s.risk;
const focusTip = (s) => (FOCUS[s.risk] ? `How closely to read this layer: ${FOCUS[s.risk][1]}. Not a finding.` : "How closely to read this layer");
const focusColor = (t, s) => (s.risk === "high" ? t.accent : t.muted);
const riskBadge = (t, s) => badge(t, focusLabel(s), focusColor(t, s));
const kbd = (t, k) => div().px(5).min_w(18).h(18).flex().items_center().justify_center().rounded(4).border_1().border_color(t.border).bg(t.raised)
  .text_size(11).text_color(t.foreground).child(k);
// A button drawn inside the virtual list (no handler there: onItem places the click by x).
const button = (t, label, border, color) => div().w(BTN).h(28).flex_none().flex().items_center().justify_center().rounded(6).border_1()
  .border_color(border).bg(t.background).text_size(12.5).text_color(color).child(label);
// The model picker (shared "review.model": the AI analysis, Sonnet by default).
// The picker's short form: the CLI's aliases (opus, sonnet, …: each its family's newest), else the three classes.
export const modelPills = (t, id) => {
  const seen = new Map();
  for (const c of Object.values(modelsDoc()).flatMap((d) => d?.claude ?? [])) if (!c.value.startsWith("claude-") && tierOf(c.value) !== "haiku" && !seen.has(c.value)) seen.set(c.value, c.label);
  const pills = seen.size ? [...seen] : Object.entries(MODELS).filter(([k]) => k !== "haiku").map(([k, v]) => [k, v.label]);
  return h_flex().gap(4).flex_wrap().children(pills.map(([k, label]) =>
    pill(`${id}-${k}`, t, label, () => setShared("review.model", k), model() === k).tooltip(`Use ${label} for the AI calls`)));
};

// What goes into and out of a changed function (review.py "flows"): signature, In and Out examples, side effects.
// onJump(event, cx): the function name was clicked.
export function flowCard(f, t, id, onJump) {
  const mono = settings().font_family ?? "JetBrains Mono";
  const code = (text) => v_flex().p(8).rounded(6).bg(t.background).font_family(mono).text_size(12).text_color(t.foreground)
    .children(String(text ?? "").split("\n").slice(0, 14).map((l) => div().child(l.replace(/^ +/, (m) => " ".repeat(m.length)) || " ")));
  const block = (label, parts) => v_flex().gap(4)
    .child(h_flex().gap(6).items_center().text_size(11.5).text_color(t.muted).child(div().font_semibold().child(label)).child(div().child("example")))
    .children(parts.map(([head, ex], k) => v_flex().id(`${id}-${label}-${k}`).gap(2)
      .child(div().font_family(mono).text_size(12).text_color(t.accent).child(head)).child(code(ex))));
  return v_flex().id(id).flex_none().mt(4).p(10).gap(8).rounded(8).border_1().border_color(t.border).bg(t.surface).text_size(13)
    .child(h_flex().gap(8).items_center()
      .child(div().id(`${id}-fn`).font_family(mono).font_semibold().text_color(t.accent).when(Boolean(onJump), (e) => e.cursor_pointer().on_click(onJump))
        .child(`${f.function}(${(f.inputs ?? []).map((i) => i.name).join(", ")})`))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(f.at ?? "")))
    .when((f.inputs ?? []).length > 0, (e) => e.child(block("In", f.inputs.map((i) => [`${i.name}: ${i.type}`, i.example]))))
    .when(Boolean(f.output), (e) => e.child(block("Out", [[f.output.type, f.output.example]])))
    .when((f.side_effects ?? []).length > 0, (e) => e.child(h_flex().flex_wrap().gap(4).children(f.side_effects.map((x) =>
      div().px(6).py(1).rounded(5).bg(t.raised).text_size(11.5).text_color(t.foreground).child(x)))))
    .when((f.calls ?? []).length > 0, (e) => e.child(div().text_size(11.5).text_color(t.muted).child(`calls: ${f.calls.join(", ")}`)));
}

// Markdown markers dropped where a line is drawn as plain text (list rows).
const plain = plainText; // one plain line of a Markdown text: its first paragraph, no code blocks, no marks (pr.js)
const ago = (iso) => { const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return !Number.isFinite(m) ? "" : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };


export const ReviewMode = {
  initReview(cx) {
    this.tab = "files"; this.cur = 0; this.focusHunk = null; this.fsel = null; this.sug = null;
    this.ai = null; this.aiBusy = false; this.aiError = null; this.aiModel = null; this.diaBusy = null; this.diaError = null;
    this.prog = { visited: new Set(), checked: {}, handled: {}, seen: new Set() };
    this.full = {}; this.gaps = {}; this.whole = new Set(); this.collapsed = new Set(); this.closedDirs = new Set();
    // Handles are made here only: creating one later (in a task) throws, which broke the definition view.
    this.lists = { steps: VirtualListScrollHandle.new(), files: VirtualListScrollHandle.new(), def: VirtualListScrollHandle.new() };
    this.leftScroll = ScrollHandle.new(); // the Layers tab's left column
    this.pageScroll = ScrollHandle.new(); this.pageAnchors = {}; this.askOpen = new Set(); // the right pane's pages (pageView) and the open rows of the task check
    this.order = "reading"; this.flowSel = null;
    this.page = "overview"; this.archMode = "diff"; this.fold = { summary: true, blockers: true, checks: false }; this.blastOpen = false;
    this.ctx = null; this.since = null; this.sinceOn = false; this.lastReviewed = null; this.verifyBusy = false;
    this.find = { list: [], runs: {}, status: {}, reports: {} };
    // Reviewer runs and the fixing agent's reports land in pr-data/findings: follow that folder.
    cx.spawn(async (cx) => {
      await exec("mkdir", ["-p", findDir()]).catch(() => null);
      for (;;) { await watchFolder(findDir()).catch(() => null); await this.loadFindings(cx); }
    });
    this.press = { x: 0, w: 0, shift: false }; this.items = []; this.at = {};
    // The inline composer (one at a time, under the selection) and the Finish-your-review popover's summary.
    this.composing = false; this.finishOpen = false; this.event = null; this.route = null; this.posted = null; this.gh = [];
    this.draft = TextareaState.new({ placeholder: "Leave a comment" });
    this.summary = TextareaState.new({ placeholder: "Leave a comment" });
    // Threads: sent/posted comments with their replies; the GitHub preview's ticks and inline edit; the agent preview.
    this.threadDoc = {}; this.replies = {}; this.openThreads = new Set(); this.off = new Set(); this.summaryOn = true; this.editItem = null; this.replyTo = null; this.sendP = null;
    this.itemEdit = TextareaState.new({ placeholder: "Comment text" });
    this.sendText = TextareaState.new({ placeholder: "What the agent gets" });
    this.sendText.set_auto_grow(4, 11); // short texts get a short box; a long one scrolls inside (the preview says so)
    this.replyIn = InputState.new({ placeholder: "Reply in this thread… (Enter: preview)" });
    this.exTopic = InputState.new({ placeholder: "How does the reminder job get scheduled and sent? (Enter)" });
    this.exTopic.on("submit", (_e, cx) => this.runExplore(cx));
    this.replyIn.on("submit", (_e, cx) => this.followup(cx));
    cx.spawn(async (cx) => {
      await exec("mkdir", ["-p", repliesDir()]).catch(() => null);
      for (;;) { await watchFolder(repliesDir()).catch(() => null); await this.loadThreads(cx); }
    });
    cx.timer.every(180000, (cx) => { if (this.prSel) { this.loadGhComments(cx); this.loadThreads(cx); } }); // GitHub replies: every 3 min while open
    for (const [st, k] of [[this.draft, "draft"], [this.summary, "summary"], [this.itemEdit, "item"], [this.sendText, "send"]]) {
      st.on("focus", (_e, cx) => { this.typing = k; cx.notify(); });
      st.on("blur", (_e, cx) => { if (this.typing === k) this.typing = false; cx.notify(); });
    }
    this.prSel = shared("review.target") ?? null;
    // An old pick of Haiku: switched to Sonnet once, with the reason.
    if (tierOf(String(shared("review.model") ?? "sonnet")) === "haiku") {
      setShared("review.model", "sonnet");
      this.note = "Switched the model from Haiku to Sonnet: Haiku is fine for text, but too weak to reason about code.";
    }
    cx.spawn(async (cx) => { this.cfg = await readConfig(); await loadSetup(this, cx); });
    if (!shared("review.models")) cx.spawn(async (cx) => { try { setShared("review.models", JSON.parse(await readTextFile(modelsFile()))); cx.notify(); } catch { /* none yet */ } });
    // Ask about this: one input (the Architecture page's or the shown layer's), threads and drill-downs from deep.json.
    this.askIn = InputState.new({ placeholder: "Ask about this… (Enter)" });
    this.askIn.on("submit", (_e, cx) => this.askNow(cx));
    this.deep = { threads: {}, drills: {}, pins: {}, drawer: {} }; this.askBusy = null; this.askErr = null; this.askAbout = null;
    cx.spawn(async (cx) => { const d = JSON.parse(await readTextFile(deepFile()).catch(() => null) ?? "null"); if (d) this.deep = { threads: d.threads ?? {}, drills: d.drills ?? {}, pins: d.pins ?? {}, drawer: d.drawer ?? {} }; cx.notify(); });
    this.refresh(cx);
    this.fh.focus();
    cx.timer.after(400, () => this.fh.focus());
    // Commands for keys.json ("pr-review.files") and scripts (herdr-app do pr-review.step:2).
    cx.spawn(async (cx) => { for (;;) { const c = await nextCommand(); this.command(String(c), cx); cx.notify(); } });
  },

  command(c, cx) {
    const [name, ...rest] = c.split(":"), arg = rest.join(":");
    if (name === "steps" || name === "files" || name === "findings" || name === "comments") this.tab = name;
    else if (name === "def") this.defineAt(arg, cx);
    // page:verify is the Findings tab now: fixes sent and their verification sit there, under "Fix sent".
    else if (name === "page" && arg === "verify") this.tab = "findings";
    else if (name === "page") { this.tab = "steps"; this.page = PAGES.some(([k]) => k === arg) ? arg : "overview"; }
    else if (name === "finding") { const f = this.findingById(arg); if (f) { this.openFinding(f); this.jumpTo(`${f.file}:${f.line}`, cx); } } // finding:<id>: a click on its row in the Findings tab
    // The same as their clicks in the Findings tab: a step of the open finding (finding-step:sent | verified, again to
    // fold it) and the order (findings-sort:quick, findings-sort: for the usual one).
    else if (name === "finding-step") this.fstep = this.fstep?.id === this.ffocus && this.fstep.key === arg ? null : { id: this.ffocus, key: arg };
    else if (name === "findings-sort") this.fsort = arg === "quick";
    else if (name === "verify") this.runVerify(cx);
    else if (name === "step") this.goStep(arg === "next" ? this.cur + 1 : arg === "prev" ? this.cur - 1 : Number(arg), cx);
    else if (name === "hunk") this.goHunk(arg === "prev" ? -1 : 1, cx);
    else if (name === "file") { this.tab = "files"; this.fileFocus = arg; this.unfold(arg); this.scrollTo("files", arg); }
    else if (name === "whole") { this.tab = "files"; this.toggleWhole(arg, cx); this.scrollTo("files", arg); }
    else if (name === "gap") { const [path, k] = arg.split("#"); this.tab = "files"; this.expand(path, Number(k), "all", cx); }
    else if (name === "analyze") this.loadAi(cx, "run");
    else if (name === "cancel") this.cancelAi(cx);
    else if (name === "reviewer") this.runReviewer(arg, cx);
    else if (name === "done") { this.registerReview(cx, { status: "done", doneAt: Date.now() }); this.note = "Marked done: it leaves the open reviews"; }
    else if (name === "findings") this.tab = "findings";
    else if (name === "back") leave();
    else if (name === "finish") { this.finishOpen = !this.finishOpen; this.approveAsk = this.discardAsk = false; if (this.finishOpen) this.loadGhLogin(cx); }
    else if (name === "discuss") { const f = this.findingById(arg); if (f) this.discuss(f, cx); } // discuss:<finding id> (scripts, keys)
    else if (name === "keys") openOverlay({ mod: "pr-review", props: { part: "keys" }, kind: "popup", ...KEYS_POP });
    else if (name === "comment") { // comment:<path>:<line>[-<end>]: the composer under that new-side line (scripts, tests)
      const m = /^(.*):(\d+)(?:-(\d+))?$/.exec(arg);
      if (m) { this.tab = "files"; this.unfold(m[1]); this.fsel = { path: m[1], a: `+${m[2]}`, b: `+${m[3] ?? m[2]}` }; this.openComposer(cx, null, true); }
    }
    // Scripts and tests: the composer's text, then its "Post now / Send to agent…" button; the preview's "Send to agent".
    else if (name === "draft") { this.draft.set_value(arg); }
    else if (name === "single") this.singleComment(cx);
    // The same as their clicks: the ▾ beside the composer's main button, and a finding's card in the diff
    // (finding-card:<finding id> opens or folds it).
    else if (name === "compose-more") this.toggleComposeMore();
    else if (name === "comment-row") { // comment-row:<id>: a click on that row of the Comments tab (its whole text shows, the diff jumps to it)
      const r = this.commentRowsNow().find((x) => x.id === arg);
      if (r) { this.tab = "comments"; this.crow = r.id; this.jumpTo(`${r.file}:${r.line}`, cx); }
    }
    else if (name === "note") { const n = this.openSugs().find((x) => `${x.path}:${x.line}` === arg); this.sug = n && this.sug !== n.key ? n.key : null; } // note:<path>:<line>: a click on the AI note there
    else if (name === "finding-card") { const f = this.findingById(arg); if (f) (this.fopen ??= new Map()).set(f.id, !this.findOpen(f)); }
    else if (name === "send") this.sendConfirmed(cx);
    // The same as their clicks, for scripts: the preview's Cancel; "Fix several…" and a tick in its list; the Codex
    // model in the reviewers popup; in "Finish your review" a verdict, "Insert blockers" and the submit button.
    else if (name === "send-cancel") this.sendP = null;
    else if (name === "fix-several") this.fixSeveral(cx);
    else if (name === "fix-pick") this.fixPick(arg, cx);
    else if (name === "codex-model") setShared("review.codexModel", arg);
    else if (name === "codex-menu") openCodexMenu();
    else if (name === "verdict") { this.event = arg; this.approveAsk = false; }
    else if (name === "insert-blockers") this.insertBlockers();
    else if (name === "submit") this.submitClick(cx);
    else if (name === "discard-pending") this.discardAsk = true; // the first click on "Discard N pending…": it only asks
    else if (name === "add-finding") { const f = this.findingById(arg); if (f) this.findingComment(f, cx); } // a finding's "Add to review"
    else if (name === "route") this.route = arg; // github | agent: where Submit and single comments go
    else if (name === "fix") this.fixComments(arg ? arg.split(",") : this.selected(), cx); // fix:<comment id>[,<id>…], else the selected ones (the preview opens)
    else if (name === "fix-target") this.fixTarget(arg); // sub | main, in the open preview
    else if (name === "explore") startExplore(arg || null);
    else if (name === "explore-open") this.openExploration(arg, cx);
    else if (name === "trust-repo") { // the explored repo, or the folder when it has no github.com remote
      const key = this.ex?.repo ? "pr-review.trustedRepos" : "pr-review.trustedRoots", v = this.ex?.repo ?? this.ex?.root;
      if (v) setShared(key, [v, ...(shared(key) ?? []).filter((x) => x !== v)].slice(0, 200));
      this.applyExploreTrust();
    }
    else if (name === "copy-link") copyText(this.prSel?.url ?? "");
    else if (name === "copy-state") this.copyState();
    // For scripts: what the wheel does in the right pane's page (scroll:top | bottom | <a section of the page>), and a
    // click on a row of the task check (ask:<ask id>, ask:other).
    else if (name === "scroll") this.scrollPage(arg, cx);
    else if (name === "ask") this.toggleAsk(arg);
    else if (name === "open-gh") { if (this.prSel?.url) openUrl(this.prSel.url); }
    else if (name === "model") { if (arg) setShared("review.model", codeModel(arg)); }
    // For keys and scripted demos: a card's panel on the Architecture page (card:<node id>), the layers' order
    // (order:reading | order:risk) and Minimize, the same as their clicks.
    else if (name === "card") { this.page = "arch"; this.tab = "steps"; this.archFocus = arg || null; }
    // The same model calls as their buttons (a click each, never by themselves): Refresh diagrams, and a card's
    // Look inside / Explain (inside:<node id>).
    else if (name === "diagrams") this.refreshDiagrams(cx);
    else if (name === "inside") {
      const n = (this.ai?.arch?.nodes ?? []).find((x) => x.id === arg);
      if (n) { this.page = "arch"; this.tab = "steps"; this.archFocus = n.id;
        this.showDetails({ id: n.id, label: n.label ?? n.id, group: (this.ai.arch.groups ?? []).find((g) => g.id === n.group)?.label, at: n.at ?? n.evidence, kind: "node", description: n.description }, `arch:${n.id}`, cx, false, true); }
    }
    else if (name === "order") { if (arg === "reading" || arg === "risk") { this.order = arg; this.cur = 0; } }
    else if (name === "viewed") { if (this.patch?.some((f) => f.path === arg)) this.toggleSeen(arg, cx); } // viewed:<path>: a click on that file's "Viewed" box
    else if (name === "minimize") minimize();
    // The same as their clicks: "Run review" (the reviewers popup), the composer's "Start a review / Add review
    // comment" (add), and a finding's "Fix…" (fix-finding:<finding id>: the preview opens).
    else if (name === "reviews") { // reviews[:<x>,<y>]: where a click on the button would open it (default: the pointer)
      const [x, y] = arg.split(",").map(Number);
      openOverlay({ mod: "pr-review", props: { part: "reviews" }, kind: "popup", ...reviewsPop(), ...(Number.isFinite(y) ? { at: { x, y } } : {}) });
    }
    else if (name === "add") this.addDraft(cx);
    else if (name === "fix-finding") { const f = this.findingById(arg); if (f) this.fix([f], cx); }
    else if (name === "trust") this.trust("pr", cx);
    else if (name === "cmenu") { const [k, ...key] = arg.split("|"), card = this.cardByKey(key.join("|")); card?.menu[Number(k)]?.[2]?.(cx); }
    else if (name === "ask") this.setDrawer(arg === "close" ? null : arg === "fold" ? "collapsed" : "open", cx); // the Ask drawer: open | fold | close
    else if (name === "apply") { const j = this.fixes().find((f) => f.id === arg) ?? this.fixes().filter((f) => f.state === "running").at(-1); if (j) this.applyFix(j, cx); }
    else if (name === "open") {
      cx.spawn(async () => {
        const prs = JSON.parse(await readTextFile(`${appHome()}/pr-data/prs.json`).catch(() => null) ?? "{}").prs ?? [];
        const pr = prs.find((p) => p.url === arg) ?? (shared("pr.picked") ?? {})[arg];
        if (pr) setShared("review.target", pr);
      });
    }
  },

  resetReview() {
    this.reviewKey = null; this.ai = null; this.aiError = null; this.aiModel = null; this.cur = 0; this.focusHunk = null; this.fsel = null; this.sug = null;
    this.composing = false; this.editing = null; this.finishOpen = false; this.posted = null; this.gh = []; this.route = null; this.event = null;
    this.full = {}; this.gaps = {}; this.whole = new Set(); this.collapsed = new Set(); this.hunks = null;
    this.ctx = null; this.since = null; this.sinceOn = false; this.lastReviewed = null; this.page = "overview"; this.aiFile = null; this.needClone = null;
  },

  // A new diff: its hunks, progress and the cached analysis, if any.
  async onSource(cx) {
    const url = this.prSel?.url;
    if (!url || !this.patch) return;
    // Herdr stops a script slice after ~50 ms ("interrupted"): a big PR's hunks are made file by file, with a pause
    // (a timer, so a fresh slice) every 12 ms; the same ids and aliases as hunksOf over the whole patch.
    const patch = this.patch, hunks = [], fileHunks = new Map();
    this.hunks = null; // until they match this patch (loadAi reuses them)
    let t = Date.now();
    for (const f of patch) {
      const hs = hunksOf([f]).map((h, i) => ({ ...h, alias: `h${hunks.length + i + 1}`, rows: diffRows(h.lines) }));
      hunks.push(...hs);
      if (hs.length) fileHunks.set(f.path, hs);
      if (Date.now() - t > 12) { await new Promise((r) => cx.timer.after(0, r)); t = Date.now(); if (this.patch !== patch) return; }
    }
    this.hunks = hunks; this.fileHunks = fileHunks;
    this.byId = new Map(this.hunks.map((h) => [h.id, h]));
    this.diffLines = diffLines(this.hunks);
    this.loadGhComments(cx);
    await this.loadThreads(cx);
    const p = JSON.parse(await readTextFile(progressFile()).catch(() => null) ?? "{}")[url] ?? {};
    this.prog = { visited: new Set(p.visited ?? []), checked: p.checked ?? {}, handled: p.handled ?? {}, seen: new Set(p.seen ?? []) };
    this.collapsed = new Set([...this.prog.seen, ...foldOnOpen(this.patch)]);
    const back = resumeFields(p.ui);
    if (back) { // resume: where you were
      Object.assign(this, back.fields);
      if (back.model && codeModel(back.model) !== shared("review.model")) setShared("review.model", codeModel(back.model));
      if (back.values !== undefined && back.values !== valuesOn()) setShared("review.values", back.values);
      this.pendingScroll = back.scroll;
    }
    this.uiSaved = JSON.stringify(this.uiState());
    this.head = this.prSel.headSha ?? null; // from prs.json (prs.py) or the branch's gh pr view; else asked when a file is opened
    // Since your last review: the mark before this visit (registerReview moves it to this head as "seen" afterwards).
    const reg = JSON.parse(await readTextFile(openFile()).catch(() => null) ?? "[]").find((r) => r.url === url);
    this.lastReviewed = reg?.reviewed ?? null;
    this.makeWorktree(cx);
    this.loadAi(cx, "cache"); // never runs by itself: Analyze is a click
    await this.loadFindings(cx);
    this.registerReview(cx); // opened: an open review from now on
    this.publish(); cx.notify();
  },

  // The PR head as files (worktree.py: a detached worktree of a dedicated clone under the clone root), for reviewers,
  // whole files and the LSP bridge: shared("review.worktree") = {url, head, path}. The current branch: its repo root.
  // clone: the "Clone to …" click; never otherwise (worktree.py exits 3 with the folder it would use).
  // Someone else's PR is untrusted: its language servers run in safe mode (no build scripts, proc macros, project
  // TypeScript, module downloads) and aren't warmed up. Trusted: your branch, your sessions' PRs, PRs you authored,
  // and PRs (or repos) you chose to trust.
  trustedPr(pr = this.prSel) {
    if (!pr) return false;
    if (pr.space || !pr.source || pr.source === "mine") return true;
    if (pr.author && pr.author === shared("gh.login")) return true;
    return (shared("pr-review.trusted") ?? []).includes(pr.url) || (shared("pr-review.trustedRepos") ?? []).includes(pr.repo);
  },
  // Like VS Code's Workspace Trust: asked once per PR (Restricted Mode stays until you trust it).
  trustAsked(pr = this.prSel) { return (shared("pr-review.trustAsked") ?? []).includes(pr?.url); },
  trust(kind, cx) {
    const pr = this.prSel, add = (key, v) => setShared(key, [v, ...(shared(key) ?? []).filter((x) => x !== v)].slice(0, 200));
    if (kind === "pr") add("pr-review.trusted", pr.url);
    if (kind === "repo" && pr.repo) add("pr-review.trustedRepos", pr.repo);
    add("pr-review.trustAsked", pr.url);
    this.applyTrust(); cx.notify();
  },
  trustPrompt(t) {
    const pr = this.prSel, who = pr.author ? `@${pr.author}` : "someone else";
    return v_flex().flex_none().px(14).py(10).gap(8).bg(t.ansi3 + "1c").border_b(1).border_color(t.border).text_size(12.5)
      .child(div().font_semibold().text_color(t.foreground).child(`Do you trust the authors of this code? This PR is by ${who}.`))
      .child(div().whitespace_normal().text_color(t.muted).child("Language servers for go-to-definition can run code from the repository (build scripts, proc macros, its own TypeScript). In Restricted Mode they don't: Java has no build import, Rust has no go-to-definition, and nothing is downloaded. Reading the diff, reviewers and the AI analysis work the same either way."))
      .child(h_flex().gap(8).flex_wrap()
        .child(pill("rv-trust-pr", t, "Trust this PR", (_e, cx) => this.trust("pr", cx), false, t.foreground).tooltip("Allow language servers to run this PR's build scripts for full go-to-definition"))
        .when(Boolean(pr.repo), (e) => e.child(pill("rv-trust-repo", t, `Trust all PRs in ${pr.repo}`, (_e, cx) => this.trust("repo", cx)).tooltip("Trust every PR in this repository from now on")))
        .child(pill("rv-trust-no", t, "Stay in Restricted Mode", (_e, cx) => this.trust("ask", cx)).tooltip("Keep language servers from running this code; go-to-definition may find less")));
  },
  applyTrust() {
    const w = this.worktree, yes = this.trustedPr();
    if (!w?.path) return;
    setTrusted(w.path, yes);
    if (yes) warm(w.path, (this.patch ?? []).map((f) => f.path)); // Java needs ~25 s cold
  },

  makeWorktree(cx, clone = false) {
    const url = this.prSel.url;
    this.worktree = null;
    if (this.prSel.space && this.root) {
      this.worktree = { url, head: this.head, path: this.root, local: true }; setShared("review.worktree", this.worktree); this.applyTrust();
      this.loadSince(cx); this.loadContext(cx); return;
    }
    // A PR you didn't open may use the active space's checkout of its repo (cwd); your own PRs keep the dedicated clones.
    const local = this.prSel.source && this.root ? ["--local", this.root] : [];
    this.cloning = clone;
    cx.spawn(async (cx) => {
      const roots = C.cloneRoots(ctxDoc(), this.ctxId(), this.cfg?.cloneRoot ?? "~/code").flatMap((d) => ["--root", d.replace(/^~(?=\/|$)/, home())]);
      const env = this.ctxEnv(this.ctxId()), argv = [...env, "python3", `${appHome()}/mods/pr-review/worktree.py`, url, ...roots, ...local, ...(clone ? ["--clone"] : [])];
      const r = await exec(argv[0], argv.slice(1), { timeout: 600000 })
        .catch((e) => ({ code: 1, stderr: String(e) }));
      this.cloning = false;
      if (this.prSel?.url !== url) return;
      if (r.code === 3) { this.needClone = JSON.parse(r.stdout).need_clone; this.loadContext(cx); cx.notify(); return; }
      this.needClone = null;
      if (r.code !== 0) { this.note = `Could not check out the PR head: ${r.stderr.trim().slice(0, 200)}`; cx.notify(); return; }
      const w = JSON.parse(r.stdout);
      this.head ??= w.head;
      this.worktree = { url, head: w.head, path: w.path };
      setShared("review.worktree", this.worktree);
      if (!shared("gh.login")) exec("gh", ["api", "user", "--jq", ".login"]).then((r) => { if (r.code === 0) { setShared("gh.login", r.stdout.trim()); this.applyTrust(); } }).catch(() => null);
      this.applyTrust();
      if (this.pendingRun) { this.pendingRun = false; this.loadAi(cx, "run"); }
      this.loadSince(cx); this.loadContext(cx);
      cx.notify();
    });
  },

  // What changed since the head you last reviewed (worktree.py since: git in the checkout, no LLM). The Files tab
  // shows only that while "Since last review" is on.
  loadSince(cx) {
    const url = this.prSel?.url, w = this.worktree, base = sinceBase({ reviewed: this.lastReviewed }, w?.head ?? this.head);
    if (!w || !base) return;
    cx.spawn(async (cx) => {
      const r = await exec("python3", [`${appHome()}/mods/pr-review/worktree.py`, "since", w.path, base.sha, w.head ?? this.head, ...(this.patch ?? []).flatMap((f) => [f.path, ...(f.from ? [f.from] : [])])], { timeout: 400000 })
        .catch((e) => ({ code: 1, stderr: String(e) }));
      if (this.prSel?.url !== url) return;
      const d = r.code === 0 ? JSON.parse(r.stdout) : { mode: "full", patch: "", note: `Could not diff: ${r.stderr.trim().slice(0, 160)}` };
      const files = splitPatch(d.patch || ""), hunks = hunksOf(files).map((h) => ({ ...h, rows: diffRows(h.lines) })), fileHunks = new Map();
      for (const h of hunks) fileHunks.set(h.path, [...(fileHunks.get(h.path) ?? []), h]);
      this.since = { base, head: w.head ?? this.head, mode: d.mode, note: d.note, files: d.patch ? files : [], hunks, fileHunks };
      this.sinceOn = files.length > 0 && d.mode !== "full"; // start on the new changes; the banner switches back
      this.gaps = {};
      cx.notify();
    });
  },

  // Related PRs, CI checks and mergeability (related.py: gh and git, no LLM), cached per PR head in pr-data/cache.
  loadContext(cx) {
    const url = this.prSel?.url, head = this.worktree?.head ?? this.head;
    if (!url?.startsWith("https://") || !head) return;
    const out = `${cacheDir()}/ctx-${hash(url)}-${head}.json`;
    cx.spawn(async (cx) => {
      const before = JSON.parse(await readTextFile(out).catch(() => null) ?? "null");
      if (this.prSel?.url !== url) return;
      if (before) { this.ctx = before; this.publish(); cx.notify(); }
      if (before && Date.now() - Date.parse(before.at) < CTX_MS) return;
      const req = { url, head, base: this.prSel.base ?? "main", worktree: this.worktree?.path ?? null, files: (this.patch ?? []).map((f) => f.path).filter((f) => !lowValue(f)), out }; // lockfiles would relate everything
      const r = await exec("python3", [`${appHome()}/mods/pr-review/related.py`, JSON.stringify(req)], { timeout: 400000 }).catch(() => null);
      if (this.prSel?.url !== url || r?.code !== 0) return;
      this.ctx = JSON.parse(r.stdout);
      exec("python3", [`${appHome()}/mods/pr-review/prs.py`, "--prune"]).catch(() => null); // bounds the cache folder
      this.publish(); cx.notify();
    });
  },

  // Progress and where you were (tab, file, hunk, step, order, selection, model, values) for resuming; the oldest
  // PRs beyond MAX_PROGRESS go.
  saveProgress(cx) {
    const url = this.prSel?.url, p = this.prog;
    if (!url) return;
    const value = { visited: [...p.visited], checked: p.checked, handled: p.handled, seen: [...p.seen], ui: this.uiState(), at: Date.now() };
    cx.spawn(async (cx) => {
      try {
        for (let attempt = 0; ; attempt++) {
          const before = await readTextFile(progressFile()).catch(() => null), doc = before ? JSON.parse(before) : {};
          doc[url] = value;
          for (const k of Object.keys(doc).sort((a, b) => (doc[b].at ?? 0) - (doc[a].at ?? 0)).slice(MAX_PROGRESS)) delete doc[k];
          try { await writeTextFile(progressFile(), JSON.stringify(doc, null, 1), before); break; } catch (e) { if (attempt) throw e; }
        }
        if (this.saveErr) { this.saveErr = null; this.note = "Your progress is saved again."; cx.notify(); }
      } catch (e) { this.saveErr = String(e).replace(/^Error: /, "").replace(/^`[^`]+`: /, ""); cx.notify(); } // saveErrBar: said with what is kept, and Save again
    });
    this.registerReview(cx);
  },

  uiState() {
    return { tab: this.tab, fileFocus: this.fileFocus ?? null, focusHunk: this.focusHunk ?? null, cur: this.cur, order: this.order,
      fsel: this.fsel ?? null, page: this.page ?? null, model: model(), values: valuesOn() };
  },

  // Saves where you are a second after it last changed (render calls this; no timer runs while nothing changes).
  uiChanged(cx) {
    const now = JSON.stringify(this.uiState());
    if (now === this.uiSaved || !this.hunks) return;
    this.uiSaved = now;
    const gen = (this.uiGen = (this.uiGen ?? 0) + 1);
    cx.timer.after(1000, (cx) => { if (this.uiGen === gen) this.saveProgress(cx); });
  },

  progressNow() {
    const steps = this.ai?.steps ?? [];
    const th = TH.threadCounts(this.threads(), this.replies, this.gh);
    return { steps: steps.length, stepsChecked: steps.filter((s) => this.done(s)).length, files: this.patch?.length ?? 0, filesViewed: this.prog.seen.size,
      comments: this.comments.length, threads: th.threads, replies: th.replies, fixedThreads: th.fixed, findingsOpen: this.counts().unresolved };
  },

  // This PR in pr-data/open-reviews.json (and shared "review.open"), 1.5 s after the last change: opened, worked on,
  // sent, done. Merged/closed PRs turn done, old done/sent entries go (pr.js expireReviews).
  registerReview(cx, extra = {}) {
    const pr = this.prSel;
    if (!pr?.url || !this.hunks) return;
    this.regExtra = { ...this.regExtra, ...extra };
    if (extra.status === "sent" || extra.status === "done") { this.since = null; this.sinceOn = false; } // reviewed up to this head now
    const gen = (this.regGen = (this.regGen ?? 0) + 1);
    cx.timer.after(1500, (cx) => cx.spawn(async (cx) => {
      if (this.regGen !== gen || this.prSel?.url !== pr.url) return;
      const entry = { url: pr.url, number: pr.number, repo: pr.repo, title: pr.title ?? this.pr?.title, context: this.ctxId(), headSha: this.head,
        progress: this.progressNow(), target: pr, triage: this.triageNow(), ...this.regExtra };
      const how = this.regExtra.status === "sent" || this.regExtra.status === "done" ? this.regExtra.status : "seen";
      this.regExtra = {};
      const prs = JSON.parse(await readTextFile(`${appHome()}/pr-data/prs.json`).catch(() => null) ?? "{}").prs ?? [];
      for (let attempt = 0; attempt < 3; attempt++) {
        const before = await readTextFile(openFile()).catch(() => null);
        entry.reviewed = markReviewed((before ? JSON.parse(before) : []).find((r) => r.url === pr.url)?.reviewed, this.worktree?.head ?? this.head, how, Date.now());
        const list = expireReviews(touchReview(before ? JSON.parse(before) : [], entry, Date.now()), prs, Date.now());
        try {
          await writeTextFile(openFile(), JSON.stringify(list, null, 1), before);
          setShared("review.open", list.filter((r) => r.status !== "done"));
          setShared("review.registry", { at: Date.now(), touched: entry.url, entries: list }); // already debounced (1.5 s)
          return;
        } catch { /* written meanwhile: again */ }
      }
    }));
  },

  // ---- the AI analysis (review.py), cached per hunk set and model

  // mode: "cache" shows what is there (exact, else this PR's last one for the model) and follows a run still going;
  // "run" (a click) starts review.py detached: it may take 15 minutes, longer than exec waits. Its status file says
  // busy/done/error; a gentle poll (5 s) follows it while it runs.
  // incremental (a click on "Only new changes"): sends only the changes since your last review plus the shown analysis;
  // review.py merges the new layers into it and saves the result for today's whole diff.
  loadAi(cx, mode, incremental = false) {
    const m = model(), url = this.prSel?.url;
    this.aiModel = m;
    if (!url || !this.patch) return;
    const job = reviewRequest({ url, pr: url.startsWith("https://") ? url : null, worktree: this.worktree?.path ?? null, files: this.patch, hunks: this.hunks, model: m, context: this.ctxReq(), dir: cacheDir() });
    if (mode === "run") {
      if (this.aiBusy) return;
      if (!job.req.hunks.length) { this.aiError = "No diff"; return cx.notify(); }
      if (!this.worktree && !this.prSel.space) { this.pendingRun = true; this.note = "Analysis starts once the PR head is checked out…"; return cx.notify(); }
      // Every hunk goes along: review.py inlines what fits and lets the model read the rest (no "too large" cut).
      const all = (hs) => hs.map(({ alias, id, path, lines }) => ({ alias, id, path, lines }));
      let req = { ...job.req, hunks: all(job.hunks), cut: [] };
      if (incremental) {
        if (!this.since?.files.length || !this.aiFile) return;
        const inc = reviewRequest({ url, files: this.since.files, model: m, context: this.ctxReq(), dir: cacheDir() }), n = (a) => a.replace(/^h/, "n");
        req = { ...job.req, hunks: all(inc.hunks).map((h) => ({ ...h, alias: n(h.alias) })), cut: [], previous: this.aiFile,
          since: { base: this.since.base.sha, head: this.since.head }, full: job.hunks.map((h) => ({ alias: h.alias, id: h.id, path: h.path, head: h.lines[0] })) };
      }
      this.aiError = null; this.aiBusy = { model: m, started: Date.now(), status: job.status, incremental };
      // The request as a file: a big PR's hunks outgrow a command line.
      const reqFile = `${job.out}.req.json`;
      cx.spawn(async (cx) => {
        const before = await readTextFile(reqFile).catch(() => null);
        await writeTextFile(reqFile, JSON.stringify(req), before).catch((e) => { this.aiError = String(e); });
        exec("sh", ["-c", 'nohup python3 "$0" "$1" >/dev/null 2>&1 &', `${appHome()}/mods/pr-review/review.py`, `@${reqFile}`])
        .catch((e) => { this.aiError = String(e); this.aiBusy = false; cx.notify(); });
      });
      this.publish(); this.pollAi(cx, job, url, m);
      return cx.notify();
    }
    cx.spawn(async (cx) => {
      const [text, fallback, st] = await Promise.all([readTextFile(job.out).catch(() => null), readTextFile(job.latest).catch(() => null), readTextFile(job.status).catch(() => null)]);
      if (this.prSel?.url !== url || model() !== m) return;
      const status = st ? JSON.parse(st) : null;
      this.ai = text || fallback ? this.mapSaved(JSON.parse(text ?? fallback), Boolean(text)) : null;
      this.aiFile = text ? job.out : fallback ? job.latest : null;
      if (status?.busy && Date.now() - Date.parse(status.started) < 20 * 60000) { // a run started earlier, maybe from another copy
        this.aiBusy = { model: m, started: Date.parse(status.started), status: job.status, pid: status.pid };
        this.pollAi(cx, job, url, m);
      }
      if (this.ai && !this.focusHunk) this.goStep(0, cx, false);
      this.publish(); cx.notify();
    });
  },

  // Refresh diagrams (a click, never by itself): review.py redraws only the pictures of the shown analysis for today's
  // diff, with its layers as context (one cheaper call, "Review diagrams" in the ledger), and writes them into the
  // files holding this analysis. The old pictures stay until the new ones arrive.
  refreshDiagrams(cx) {
    const url = this.prSel?.url, file = this.aiFile, m = model();
    if (!url || !file || !this.patch || this.diaBusy) return;
    const job = reviewRequest({ url, pr: url.startsWith("https://") ? url : null, worktree: this.worktree?.path ?? null, files: this.patch, hunks: this.hunks, model: m, context: this.ctxReq(), dir: cacheDir() });
    const status = `${file}.diagrams.status`;
    const req = { diagrams: file, also: [job.out, job.latest].filter((x) => x !== file), head: this.head, model: m, context: this.ctxReq(), pr: job.req.pr,
      worktree: job.req.worktree, hunks: job.req.hunks, status };
    this.diaBusy = { status, file, url }; this.diaError = null;
    exec("sh", ["-c", 'nohup python3 "$0" "$1" >/dev/null 2>&1 &', `${appHome()}/mods/pr-review/review.py`, JSON.stringify(req)])
      .catch((e) => { this.diaError = String(e); this.diaBusy = null; cx.notify(); });
    this.pollDiagrams(cx);
    cx.notify();
  },

  pollDiagrams(cx) {
    cx.timer.after(5000, (cx) => cx.spawn(async (cx) => {
      const b = this.diaBusy;
      if (!b || this.prSel?.url !== b.url) { this.diaBusy = null; return; }
      const st = JSON.parse(await readTextFile(b.status).catch(() => null) ?? "null");
      if (!st || st.busy) return this.pollDiagrams(cx);
      this.diaBusy = null;
      if (st.error) this.diaError = st.error;
      else if (this.aiFile === b.file) {
        const text = await readTextFile(b.file).catch(() => null);
        if (text) this.ai = this.mapSaved(JSON.parse(text), this.ai?.exact ?? true);
      }
      cx.notify();
    }));
  },

  // The Refresh diagrams button with its state: Refreshing…, "updated for <head>", "diagrams from an older diff".
  diagramsBar(t, id, label) {
    if (!this.ai || !this.aiFile) return div();
    const st = diagramsState({ diagrams: this.ai.diagrams, generated: this.ai.generated }, this.head, this.ai.exact);
    return h_flex().flex_wrap().gap(8).items_center().text_size(12)
      .child(this.diaBusy ? h_flex().gap(6).text_color(t.muted).child(div().child(SPIN[0]).frames(SPIN, 90)).child("Refreshing…")
        : pill(id, t, `↻ ${label}`, (_e, cx) => { this.refreshDiagrams(cx); cx.stop_propagation(); }).tooltip("Rebuild the diagrams for the current diff: one model call"))
      .when(st.updated && Boolean(st.short), (e) => e.child(div().text_color(t.muted).child(`updated for ${st.short}`)))
      .when(st.older, (e) => e.child(div().text_color(t.ansi3).child("diagrams from an older diff")))
      .when(Boolean(this.diaError), (e) => e.child(div().max_w(260).truncate().text_color(t.ansi1).tooltip(this.diaError ?? "").child(this.diaError ?? "")));
  },

  pollAi(cx, job, url, m) {
    cx.timer.after(5000, (cx) => cx.spawn(async (cx) => {
      if (this.prSel?.url !== url || !this.aiBusy) return;
      const st = JSON.parse(await readTextFile(job.status).catch(() => null) ?? "null");
      if (st?.busy || !st) { if (st?.pid) this.aiBusy.pid = st.pid; if (st?.passes) Object.assign(this.aiBusy, { pass: st.pass, passes: st.passes }); cx.notify(); return this.pollAi(cx, job, url, m); }
      this.aiBusy = false;
      if (st.error) this.aiError = st.error;
      else {
        const text = await readTextFile(job.out).catch(() => null);
        if (text && model() === m) { this.ai = this.mapSaved(JSON.parse(text), true); this.aiFile = job.out; this.goStep(0, cx, false); }
      }
      this.publish(); cx.notify();
    }));
  },

  cancelAi(cx) {
    const b = this.aiBusy;
    if (!b) return;
    this.aiBusy = false; this.aiError = "Cancelled";
    cx.spawn(async (cx) => {
      if (b.pid) await exec("sh", ["-c", 'pkill -P "$0"; kill "$0"', String(b.pid)]).catch(() => null); // review.py and its claude
      const before = await readTextFile(b.status).catch(() => null);
      await writeTextFile(b.status, JSON.stringify({ error: "Cancelled" }), before).catch(() => null);
      this.publish(); cx.notify();
    });
  },

  // A saved analysis on today's diff: hunks by id (gone ones make a step "veraltet"), plus the hunks no step covers.
  mapSaved(saved, exact) {
    const hs = saved.hunks.map((h) => ({ ...h, ...(this.byId.get(h.id) ?? {}) }));
    const r = mapReview(saved.answer, hs), covered = new Set(r.steps.flatMap((s) => s.hunks));
    const cut = new Set(exact ? saved.cut : []), left = this.hunks.filter((h) => !covered.has(h.id));
    const extra = (title, why, list) => (list.length ? [{ title, why, text: "", risk: "low", order: 9999, questions: [], flows: [], hunks: list.map((h) => h.id), pseudo: true }] : []);
    r.steps.push(...extra(`Not analyzed (${left.filter((h) => cut.has(h.alias)).length} hunks)`, "Too large for the model: read these yourself.", left.filter((h) => cut.has(h.alias))),
      ...extra(`In no step (${left.filter((h) => !cut.has(h.alias)).length} hunks)`, exact ? "The model put these hunks in no step." : "New since the analysis.", left.filter((h) => !cut.has(h.alias))));
    for (const s of r.steps) s.stale = s.hunks.length > 0 && !s.hunks.some((id) => this.byId.has(id));
    return { ...r, exact, diagrams: saved.diagrams ?? null, cost: saved.cost, ms: saved.ms, budget: saved.budget, model: saved.model, model_id: saved.model_id, generated: saved.generated, cut: saved.cut ?? [], task: saved.task ?? {},
      incremental: saved.incremental ?? null, scope: saved.scope ?? null, usage: saved.usage ?? null }; // scope.checked and usage: newer analyses only
  },

  // What the bar shows: the analysis on screen, or the one running.
  publish() {
    const a = this.ai;
    setShared("review.meta", { url: this.prSel?.url ?? null, pending: this.comments?.length ?? 0, selected: this.prSel ? this.selected().length : 0, model: this.aiModel, busy: this.aiBusy?.model ?? null, error: this.aiError,
      shown: a ? { model: a.model, model_id: a.model_id, cost: a.cost, exact: a.exact, mergeRisk: a.mergeRisk, effort: a.effort } : null,
      checks: this.prSel ? this.checksNow().reduce((n, c) => ({ ok: n.ok + (c.ok === true), fail: n.fail + (c.ok === false) }), { ok: 0, fail: 0 }) : null,
      // For the bar's "Dry run" chip and the "Run review" popup (findings: all, and the analysis' own).
      dry: Boolean(this.cfg?.dryRun), findings: this.prSel ? { total: this.findings().length, analysis: this.findings().filter((f) => f.sources.some((y) => y.reviewer === "analysis")).length } : null });
  },

  // The AI steps in risk order or in reading order (the toggle); without an analysis one step with every hunk.
  steps() {
    const all = this.ai?.steps ?? (this.hunks?.length ? [{ title: "All changes", why: "No analysis yet.", text: "", risk: "low", order: 1, questions: [], flows: [], hunks: this.hunks.map((h) => h.id), pseudo: true }] : []);
    return this.order === "reading" ? [...all].sort((a, b) => a.order - b.order) : all;
  },
  present(s) { return s.hunks.filter((id) => this.byId?.has(id)); },
  // A layer is done once you ticked every file in it as "Viewed": never by opening it, and there is no tick of its own.
  done(s) {
    const files = this.filesOf(s);
    return files.length > 0 && files.every((p) => this.prog.seen.has(p));
  },
  // The AI suggestions that stay margin notes (not merged into a finding, not handled yet); path: of that file.
  openSugs(path) { return this.merged().notes.filter((s) => !path || s.path === path); },

  // ---- findings: one per defect (pr.js mergeFindings); every view reads findings(), counts() and fstatus()

  // The reviewers' findings (reviewers.py: pr-data/findings/<url hash>.json), the analysis' own, read live from its
  // layers (so one the newest analysis no longer has is gone everywhere), and the AI suggestions on their lines,
  // merged per file and line. Only statuses are stored. Memoized: render calls this often.
  merged() {
    const ai = this.ai, list = this.find.list, st = this.find.status, handled = this.prog.handled, n = Object.keys(handled).length, m = this.findMemo;
    if (m?.ai === ai && m.list === list && m.st === st && m.handled === handled && m.n === n) return m;
    return (this.findMemo = { ai, list, st, handled, n,
      ...mergeFindings([...list, ...(ai?.steps ?? []).flatMap((s) => s.findings ?? [])], (ai?.suspects ?? []).filter((s) => !handled[s.key]), st) });
  },
  findings() { return this.merged().findings; },
  findingById(id) { return this.findings().find((f) => f.ids.includes(id)) ?? null; },
  // The one count every view shows (pr.js findingCounts): unresolved, of them with a fix sent, by severity, security.
  counts() { return findingCounts(this.findings(), (f) => this.fstatus(f)); },
  // "Security review: high · Analysis: medium": a finding's sources with their own severities (one source: its name).
  sourcesOf(f) {
    const name = (x) => REVIEWERS[x.reviewer]?.[0] ?? x.reviewer;
    return f.sources.length === 1 ? name(f.sources[0]) : f.sources.map((x) => `${name(x)}: ${x.severity}`).join(" · ");
  },
  // The Findings tab with f open.
  openFinding(f) { this.tab = "findings"; this.ffocus = f.id; },
  // A finding's card in the diff is one line until a click opens it (fopen: id -> bool); a security finding from high
  // on starts open.
  findOpen(f) { return this.fopen?.get(f.id) ?? Boolean(f.security && ["critical", "high"].includes(f.severity)); },
  // An open card's rows under its title: what the finding claims (views.js factRows), its text and its suggestion.
  // The texts are Markdown (inline code, paragraphs, a code block in a suggestion) and are drawn as such.
  findRows(f) { return [...factRows(f), f.detail && ["Detail", f.detail], f.suggestion && ["Suggestion", f.suggestion]].filter(Boolean); },
  // The index (in steps()) of the layer an analysis finding belongs to, or -1.
  layerOf(f) { return f.step ? this.steps().findIndex((s) => s.findings?.some((x) => f.ids.includes(x.id))) : -1; },
  // A layer's findings: the ones the analysis filed in it, and every other finding in one of its files (a reviewer's).
  layerFindings(s) {
    const files = new Set(this.filesOf(s)), own = new Set((s.findings ?? []).map((x) => x.id));
    return this.findings().filter((f) => f.ids.some((id) => own.has(id)) || (!f.step && files.has(f.file)));
  },
  // The fix a finding was sent to: its newest job, also once applied or discarded.
  fixJob(f) { return [...this.fixes()].reverse().find((j) => j.items.some((x) => f.ids.includes(x.id))) ?? null; },
  // What is known about a finding's fix, as [label, text] pairs: agent, branch, commit, report, check. Empty when it
  // was never sent.
  fixFacts(f) {
    const st = this.find.status[f.id] ?? {}, r = this.find.reports[f.id], fv = this.fixView(this.fixJob(f)), job = fv?.job, v = st.verify;
    if (!st.fixHead && !r) return [];
    return [
      job && ["Agent", `${job.target === "main" ? "the PR's agent" : "a sub-agent"}${job.terminal ? ` (${job.terminal})` : ""}, ${job.state === "running" ? fv.status : job.state}`],
      job?.branch && ["Branch", job.branch],
      ["Commit", r?.commit ? String(r.commit).slice(0, 8) : "none reported yet"],
      r && ["Report", `${r.status === "fixed" ? "The agent reports it fixed" : "The agent declined"}${r.note ? `: ${r.note}` : "."}`],
      ["Check", TH.checkText(v)],
    ].filter(Boolean);
  },
  // The same in one line, for a card in the diff: "sub-agent t12 · fix/2-x · commit 22e31c88 · agent reports fixed · not verified".
  fixLine(f) {
    const st = this.find.status[f.id] ?? {}, r = this.find.reports[f.id], job = this.fixJob(f), v = st.verify;
    if (!st.fixHead && !r) return "";
    return [job && `${job.target === "main" ? "PR agent" : "sub-agent"}${job.terminal ? ` ${job.terminal}` : ""}`, job?.branch, r?.commit && `commit ${String(r.commit).slice(0, 8)}`,
      r && (r.status === "fixed" ? "agent reports fixed" : "agent declined"), TH.checkText(v, true)].filter(Boolean).join(" · ");
  },

  async loadFindings(cx) {
    const url = this.prSel?.url;
    if (!url) return;
    const base = `${findDir()}/${hash(url)}`;
    const [doc, rep] = await Promise.all([readTextFile(`${base}.json`).catch(() => null), readTextFile(`${base}.jsonl`).catch(() => null)]);
    if (this.prSel?.url !== url) return;
    const d = doc ? JSON.parse(doc) : {};
    this.find = { ...this.find, list: d.findings ?? [], runs: runsOf(d.runs), status: d.status ?? {}, reports: parseReports(rep) };
    for (const r of Object.values(this.find.runs)) if (r.busy && Date.now() - Date.parse(r.started) > 30 * 60000) { r.busy = false; r.state = "failed"; r.error = "Stopped without a result"; }
    setShared("review.reviewers", this.find.runs);
    cx.notify();
  },

  runReviewer(kind, cx) {
    const pr = this.prSel, w = this.worktree;
    if (!reviewersNow().some(([k]) => k === kind) || !pr?.url) return;
    if (!w || w.local) { this.note = !w ? "Could not run: the PR head is not checked out yet" : "Could not run: reviewers need a PR (not a branch diff)"; return cx.notify(); }
    const req = { kind, url: pr.url, number: pr.number, context: this.ctxReq(), model: model(), codexModel: shared("review.codexModel") || null, worktree: w.path, base: pr.base ?? "main",
      head: w.head, level: "medium", file: `${findDir()}/${hash(pr.url)}.json` };
    this.find.runs[kind] = { state: "running", busy: true, started: new Date().toISOString(), scope: null, error: null };
    setShared("review.reviewers", { ...this.find.runs });
    exec("sh", ["-c", 'nohup python3 "$0" "$1" >/dev/null 2>&1 &', `${appHome()}/mods/pr-review/reviewers.py`, JSON.stringify(req)])
      .catch((e) => { this.note = `Could not start ${REVIEWERS[kind][0]}: ${e}`; cx.notify(); });
    cx.notify();
  },

  // A finding's line in the diff's rows (hunks plus opened context), or -1: then it is "outside the diff".
  findRow(f) { return this.rowsFor(f.file, true).findIndex((r) => atLine(r, f.line, false)); },
  fstatus(f) {
    const rows = this.rowsFor(f.file, true), r = rows.find((x) => atLine(x, f.line, false));
    return findingStatus(f, this.find.status, this.find.reports, this.head, r?.text);
  },
  // A status set by hand drops an earlier verification; extra: {fixHead} when it goes to Fix.
  setFinding(f, st, cx, extra = {}) {
    const at = new Date().toISOString();
    this.writeStatus(cx, (status) => ({ ...status, [f.id]: { ...status[f.id], s: st, at, verify: undefined, ...extra } }));
  },
  // Dismiss says what goes: the one finding, with every source merged into it.
  dismiss(f, cx) {
    this.setFinding(f, "dismissed", cx, { ids: f.ids }); // a source that joins the line later was not dismissed (pr.js findingStatus)
    this.note = `Dismissed "${f.title}"${f.sources.length > 1 ? `, all ${f.sources.length} sources of it (${this.sourcesOf(f)})` : ` (${this.sourcesOf(f)})`}. It stays in the Findings tab under Dismissed; Reopen brings it back.`;
  },

  // The findings' status map changed by fn, here and in the file (compare-and-swap against reviewers.py writing it).
  writeStatus(cx, fn) {
    const file = `${findDir()}/${hash(this.prSel.url)}.json`;
    this.find.status = fn(this.find.status);
    cx.spawn(async (cx) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const before = await readTextFile(file).catch(() => null), doc = before ? JSON.parse(before) : {};
        doc.status = fn(doc.status ?? {});
        try { await writeTextFile(file, JSON.stringify(doc, null, 1), before); return; } catch { /* changed meanwhile: again */ }
      }
      this.note = "Could not save the finding's status"; cx.notify();
    });
    cx.notify();
  },

  headNow() { return this.worktree?.head ?? this.head; },
  verifyList() { return verifyCandidates(this.findings(), this.find.status, this.headNow(), (f) => this.fstatus(f)); },

  // Fixes that can be checked on their own branch, before they are in the PR (threads.js branchChecks); a finding
  // whose PR head moved is checked there instead.
  branchVerifyList() {
    const onHead = new Set(this.verifyList().map((f) => f.id));
    return TH.branchChecks(this.findings(), this.fixes(), this.find.status, this.find.reports, (f) => this.fstatus(f)).filter((c) => !onHead.has(c.f.id));
  },

  // "Verify fixes (N)" (a click): one call (verify.py, "PR fix verification") in the PR's context with the review's
  // model. On the PR head: fixed → ✓, not fixed → open again with the reason, unclear → as it was with the note. On a
  // fix branch the verdict only stands next to the finding: it stays "Fix sent" until the fix is in the PR head.
  runVerify(cx) {
    const list = this.verifyList(), onBranch = this.branchVerifyList(), head = this.headNow(), w = this.worktree, url = this.prSel?.url;
    if (this.verifyBusy) return;
    if (!list.length && !onBranch.length) { this.note = "No fix to verify yet: no fix agent has reported a commit, and the PR head has not moved since the fixes were sent."; return cx.notify(); }
    if (!w) { this.note = "Could not verify: the PR head is not checked out yet"; return cx.notify(); }
    this.verifyBusy = { started: Date.now(), n: list.length + onBranch.length };
    const item = (f) => ({ id: f.id, file: f.file, line: f.line, title: f.title, detail: f.detail, suggestion: f.suggestion });
    const req = { context: this.ctxReq(), model: model(), worktree: w.path, head,
      items: [...list.map((f) => ({ ...item(f), since: this.find.status[f.id].fixHead })),
        ...onBranch.map((c) => ({ ...item(c.f), since: c.job.head, head: c.commit, worktree: c.job.path, branch: c.job.branch }))] };
    cx.spawn(async (cx) => {
      const r = await exec("python3", [`${appHome()}/mods/pr-review/verify.py`, JSON.stringify(req)], { timeout: 600000 }).catch((e) => ({ code: 1, stderr: String(e) }));
      this.verifyBusy = false;
      if (this.prSel?.url !== url) return;
      if (r.code !== 0) { this.note = `Could not verify: ${r.stderr.trim().slice(0, 200)}`; return cx.notify(); }
      const { results, cost } = JSON.parse(r.stdout);
      const there = new Set(onBranch.map((c) => c.f.id)), pr = results.filter((x) => !there.has(x.id)), br = results.filter((x) => there.has(x.id));
      this.writeStatus(cx, (st) => TH.applyBranchChecks(applyVerification(st, pr, head, Date.now()), br, onBranch, Date.now()));
      const say = (rs, fixed) => `${rs.filter((x) => x.verdict === "fixed").length} ${fixed}, ${rs.filter((x) => x.verdict === "not_fixed").length} not fixed, ${rs.filter((x) => x.verdict === "unclear").length} unclear`;
      this.note = [pr.length && `On the PR head: ${say(pr, "fixed")}`, br.length && `On a fix branch, not in the PR yet: ${say(br, "verified")}`].filter(Boolean).join(". ") + (cost != null ? ` · $${Number(cost).toFixed(3)}` : "");
      cx.notify();
    });
    cx.notify();
  },

  findingText(f) {
    const rows = this.rowsFor(f.file), i = rows.findIndex((r) => atLine(r, f.line, false));
    const code = i >= 0 ? selection(rows, i, rows.findIndex((r) => atLine(r, f.end ?? f.line, false)) >= 0 ? rows.findIndex((r) => atLine(r, f.end ?? f.line, false)) : i).hunk : f.code;
    // Where it is and who found it in the first line (the preview is editable), then the finding as paragraphs.
    return `${REVIEWERS[f.reviewer]?.[0] ?? f.reviewer} (${f.severity}): \`${f.file}\`:${f.line}\n\n${TH.findingCommentText(f, { fold: false })}\n\n\`\`\`\n${code ?? ""}\n\`\`\`\n\n`;
  },

  findingComment(f, cx) {
    const rows = this.rowsFor(f.file), i = rows.findIndex((r) => atLine(r, f.line, false));
    const anchor = i >= 0 ? selection(rows, i) : { start: f.line, end: f.line, old: false, hunk: f.code };
    this.comments = [...this.comments, { id: Date.now().toString(36), file: f.file, ...anchor, head: this.head, text: TH.findingCommentText(f), from: f.reviewer, ...(f.security ? { security: true } : {}) }];
    this.persist(cx); this.note = `Added to the pending review.${f.security ? ` ${PUBLIC_TIP}` : ""}`; cx.notify();
  },

  // "Ask an agent…": what a click would start, decided before the preview so that it can say so. live: the PR's agent
  // runs already, the text goes into its input as a draft; resume: its session comes back in a new tab; new: a fresh
  // agent tab in the review's checkout of the PR head.
  askPlan() {
    const origin = this.prSel;
    // A PR picked from a list or handed over by Go to has no space: the agent is the one in a space at the PR's checkout.
    const space = origin?.space ?? spaces().find((s) => origin?.cwd && s.folder === origin.cwd)?.id ?? null;
    const agent = origin?.session ? this.sessionAgent(origin) : this.target(space);
    if (agent) return { kind: "live", agent, name: agent.tab_name || agent.title || "the agent", chat: Boolean(shared("chatbar.api")) };
    if (origin?.session && origin.cwd) return { kind: "resume", where: origin.cwd };
    return { kind: "new", where: this.worktree?.path ?? origin?.cwd ?? this.root ?? null };
  },
  // The preview first, always. With a live agent the text is pasted, not sent: through the chatbar mod's bubble when
  // it is there (shared "chatbar.api"; PROVIDERS.md, chatbar.request), else into the agent's terminal in a floating
  // window. ponytail: that goes through the clipboard (hc send always presses Enter), which holds the text after.
  discuss(f, cx) {
    const text = this.findingText(f);
    this.previewSend(cx, { what: "Ask an agent", own: `${f.title}: ${f.detail}`, ownLabel: "FINDING", ask: this.askPlan(), prompt: text, go: (edited, cx) => this.discussNow(edited, cx) });
  },
  discussNow(text, cx) {
    const origin = this.prSel, plan = this.askPlan(), agent = plan.agent;
    cx.spawn(async (cx) => {
      if (agent && plan.chat) { // the chat bubble drafts it; nothing is sent
        setShared("chatbar.request", { action: "draft", terminal: agent.address, text, from: "pr-review", at: Date.now() });
        return cx.notify(); // a question changes nothing about the finding: it stays unresolved
      }
      if (plan.kind === "new" && plan.where) {
        run("tab.new", { space: this.spaceFor(this.ctxId(), origin?.cwd, this.root), folder: plan.where, name: `Ask · PR #${origin?.number ?? ""}`,
          argv: [...this.ctxEnv(this.ctxId()), "claude", "--model", model(), ...(this.trustedPr() ? ["--permission-mode", "manual"] : TH.permissionArgs(false))], task: text });
        this.note = "Started a new agent tab with your question. The finding stays as it is.";
        return cx.notify();
      }
      await copyText(text);
      if (!agent) {
        if (plan.kind === "resume") run("tab.new", { space: this.spaceFor(this.ctxId(), origin.cwd), folder: origin.cwd, name: `PR #${origin.number}`,
          argv: [...this.ctxEnv(origin.sessionContext ?? this.ctxId()), "claude", "--resume", origin.session] });
        this.note = plan.kind === "resume" ? "Resumed the PR's session in a new tab; the finding is on the clipboard (⌘V)" : "No checkout to start an agent in: the finding is on the clipboard";
        return cx.notify();
      }
      openOverlay({ kind: "window", key: "review-agent", width: 920, height: 620, layout: { type: "column", children: [
        { type: "block", size: { px: 34 }, content: { mod: "pr-review", props: { part: "agentbar", title: agent.tab_name || agent.title || "Agent" } } },
        { type: "block", content: { terminal: agent.address } }] } });
      cx.timer.after(450, () => { run("pane.focus", { terminal: agent.address }); run("terminal.paste"); });
    });
  },

  // Fix with agent: one finding, or the ones ticked in the preview. pool: the findings "Fix several…" offers (then
  // list is what is ticked so far, which may be nothing yet); alone: how many security findings it leaves out.
  fix(list, cx, pool = null, alone = 0) {
    if (!list.length && !pool) return;
    const report = `${findDir()}/${hash(this.prSel.url)}.jsonl`;
    const labels = list.map((f) => `${f.title} (${f.file}:${f.line})`), target = pool ? this.sendP?.fix?.target : null;
    this.previewFix(cx, { what: "Fix with agent", own: labels.join("\n"), ownLabel: list.length === 1 ? "FINDING" : "FINDINGS", items: list.map((f) => ({ kind: "finding", id: f.id })), labels,
      pool, alone, target,
      prompt: (sub) => [fixPrompt(list, this.pr, report, this.lang()), sub ? TH.worktreeNote(sub.branch, sub.path) : null].filter(Boolean).join("\n\n"),
      sent: (cx) => { for (const f of list) this.setFinding(f, "progress", cx, { fixHead: this.headNow() }); } });
  },
  // "Fix several…": the reviewer picks which unresolved findings one agent fixes together. Security findings are not
  // offered: each goes alone, so that its change stays one commit to check.
  fixSeveral(cx) {
    const open = this.findings().filter((f) => ["open", "recheck"].includes(this.fstatus(f)));
    this.fix([], cx, open.filter((f) => !f.security), open.filter((f) => f.security).length);
  },
  // A tick in that list: the preview is built again for what is ticked now (branch name and text follow).
  fixPick(id, cx) {
    const f = this.sendP?.fix;
    if (!f?.pool) return;
    const ids = new Set(f.items.map((x) => x.id));
    if (ids.has(id)) ids.delete(id); else ids.add(id);
    this.fix(f.pool.filter((x) => ids.has(x.id)), cx, f.pool, f.alone);
  },

  // ---- definitions (defs.js: language servers through lsp_bridge.py, on the PR head checkout)

  lspRoot() { return this.exMode ? this.ex?.root ?? null : this.worktree?.path ?? (this.prSel?.space ? this.root : null); },

  define(it, r, cx) {
    const spans = this.spanMap?.get(it.src)?.spans?.[it.ri] ?? [];
    const tok = tokenAt(r, spans, this.press.x, GUTTER, this.charW ?? 7.8);
    if (!tok) { this.note = "⌘-click a name for its definition"; return cx.notify(); }
    this.lookupDef(it.path, r, tok, cx);
  },

  // The command "def:<path>:<line>:<name>": the definition of the first <name> on that new-side line, like a ⌘-click.
  defineAt(arg, cx) {
    const [path, line, name] = String(arg ?? "").split(":"), r = path && this.rowsFor(path).find((x) => atLine(x, Number(line), false));
    const character = r && name ? r.text.indexOf(name) : -1;
    if (character < 0) { this.note = `No ${name ?? "name"} on ${path}:${line}`; return cx.notify(); }
    this.tab = "files"; this.jumpTo(`${path}:${line}`, cx);
    this.lookupDef(path, r, { name, line: Number(line), character, side: "+" }, cx);
  },

  lookupDef(path, r, tok, cx) {
    const q = { root: this.lspRoot(), rev: this.worktree?.head ?? this.head ?? "", path, line: tok.line, character: tok.character, side: tok.side };
    const d = { key: `${path}:${lineKey(r)}`, name: tok.name, res: null };
    this.defAt = d;
    cx.spawn(async (cx) => {
      d.res = await lookup(q).catch((e) => ({ status: "error", message: String(e), definitions: [] }));
      // The last lookup, for debugging: what was clicked, where it was asked, what came back.
      setShared("pr.defs.last", { ...q, name: tok.name, status: d.res.status, message: d.res.message, def: d.res.definitions?.[0] ? where(d.res.definitions[0]) : null, at: new Date().toISOString() });
      if (this.defAt === d) cx.notify();
    });
    cx.notify();
  },

  // ⌘-click a name in the file view: its definition (the language servers of the repo; Restricted Mode as for PRs).
  defViewClick(i, cx) {
    const f = this.defFile, line = f?.lines[i];
    if (!f || line === undefined || !this.press.cmd) return;
    const row = { text: line, number: f.from + i + 1, n: f.from + i + 1, kind: " " }, tok = tokenAt(row, f.spans[i] ?? [], this.press.x, 56, this.charW ?? 7.8);
    if (!tok) { this.note = "⌘-click a name for its definition"; return cx.notify(); }
    const q = { root: this.lspRoot(), rev: this.exMode ? "" : this.worktree?.head ?? this.head ?? "", path: f.path, line: tok.line, character: tok.character, side: "+" };
    const d = { key: `view:${f.path}:${tok.line}`, name: tok.name, res: null, inView: true };
    this.defAt = d;
    cx.spawn(async (cx) => { d.res = await lookup(q).catch((e) => ({ status: "error", message: String(e), definitions: [] })); if (this.defAt === d) cx.notify(); });
    cx.notify();
  },

  // Jump to a definition: in the diff, its line; else the file at that line in a read-only view (Back or Esc returns).
  // Files beyond 6000 lines (system headers) show 6000 lines around it.
  goDef(def, cx) {
    const inDiff = def.inRoot && this.fileHunks?.has(def.path) && this.rowsFor(def.path).some((r) => atLine(r, def.line, false));
    if (inDiff) { this.defAt = null; return this.jumpTo(`${def.path}:${def.line}`, cx); }
    const root = this.lspRoot();
    cx.spawn(async (cx) => {
      const text = def.inRoot ? await readTextFile(`${root}/${def.path}`).catch(() => null) : await contents(root, def.uri).catch(() => null);
      if (text === null || text === undefined) { this.note = `Could not open ${where(def)}`; return cx.notify(); }
      const all = text.replace(/\n$/, "").split("\n"), from = Math.max(0, def.line - 3000);
      const lines = all.slice(from, from + 6000).map(expandTabs);
      this.defFile = { path: def.path, line: def.line, from, lines, spans: highlightLines(lines, langOf(def.path), `def:${def.uri ?? def.path}:${from}`) };
      this.lists.def.scroll_to_item(Math.max(0, def.line - from - 1), "center"); // "top" only reveals at the near edge: the line would sit under the view's bottom
      cx.notify();
    });
  },

  // What a lookup that found nothing says, per status.
  defMessage(res) {
    return { none: "no definition found", starting: "the language server is starting (first use can take ~25 s): ⌘-click again in a moment",
      timeout: "the language server took too long: ⌘-click again", "no-root": "the PR head is not checked out yet", "old-side": "removed lines have no definition (new side only)" }[res.status]
      ?? res.message ?? res.status;
  },

  defItem(it, t) {
    const d = it.d, res = d.res, def = res?.definitions?.[0], c = colors(t);
    const head = !res ? `Looking up ${d.name}…` : def ? `${d.name} → ${where(def)}${res.definitions.length > 1 ? ` (+${res.definitions.length - 1})` : ""}` : `${d.name}: ${this.defMessage(res)}`;
    // The bridge sends the preview as lines (an array): splitting it as text threw and took the whole review down.
    const raw = Array.isArray(def?.preview) ? def.preview : String(def?.preview ?? "").split("\n");
    const pre = raw.slice(0, 5).map(expandTabs), spans = def ? highlightLines(pre, langOf(def.path)) : [], first = def?.previewStart ?? def?.line ?? 1;
    return div().w_full().h(this.sizeOf(it)).pl(GUTTER).pr(16).py(6).child(v_flex().size_full().px(12).py(8).gap(6).rounded(8).border_1().border_l(4)
      .border_color(t.accent).bg(t.surface).text_size(13)
      .child(h_flex().h(18).gap(8).items_center().child(div().font_semibold().child(head)).when(!res, (e) => e.child(div().child(SPIN[0]).frames(SPIN, 90))))
      .child(v_flex().flex_1().min_h(0).overflow_hidden().p(6).rounded(6).bg(t.background).font_family(settings().font_family ?? "JetBrains Mono").text_size(12.5)
        .children(pre.map((l, i) => h_flex().h(18).overflow_hidden().when(first + i === def?.line, (e) => e.bg(t.accent + "1f"))
          .child(div().w(40).flex_none().pr(8).text_right().text_color(t.muted).child(String(first + i))).children(renderLine(div, l, spans[i] ?? [], c)))))
      .child(h_flex().gap(BTN_GAP)
        .child(div().id("rv-di-go").tooltip("Open the file that defines this in the review").w(BTN + 40).h(26).flex().items_center().justify_center().rounded(6).border_1().border_color(def ? t.accent : t.border).text_size(12.5).text_color(def ? t.foreground : t.muted).child("Go to definition"))
        .child(div().id("rv-di-code").tooltip("Open the defining file in VS Code").w(BTN + 40).h(26).flex().items_center().justify_center().rounded(6).border_1().border_color(t.border).text_size(12.5).text_color(def ? t.foreground : t.muted).child("Open in VS Code"))
        .child(div().id("rv-di-x").tooltip("Close this definition preview").px(10).h(26).flex().items_center().text_size(12.5).text_color(t.muted).child("Close"))));
  },

  // The file behind a definition outside the diff, highlighted, read-only.
  defView(t) {
    const f = this.defFile, c = colors(t), mono = settings().font_family ?? "JetBrains Mono";
    return v_flex().flex_1().min_h(0)
      .child(h_flex().flex_none().h(40).px(12).gap(10).items_center().bg(t.raised).border_b(1).border_color(t.border).text_size(13)
        .child(pill("rv-def-back", t, this.exMode ? "← Back" : "← Back to the diff", (_e, cx) => { this.defFile = null; this.defAt = null; cx.notify(); }).tooltip("Return to the previous view (Esc)"))
        .child(div().flex_1().min_w(0).truncate().font_family(mono).font_semibold().child(`${f.path}:${f.line}`)))
      .when(Boolean(this.defAt?.inView), (e) => { const d = this.defAt, def = d.res?.definitions?.[0];
        return e.child(h_flex().flex_none().px(12).py(6).gap(8).items_center().border_b(1).border_color(t.border).bg(t.surface).text_size(12.5)
          .child(div().flex_1().min_w(0).truncate().child(!d.res ? `Looking up ${d.name}…` : def ? `${d.name} → ${where(def)}` : `${d.name}: ${this.defMessage(d.res)}`))
          .when(Boolean(def), (x) => x.child(pill("rv-defv-go", t, "Go to definition", (_e, cx) => this.goDef(def, cx), false, t.foreground).tooltip("Open the file that defines this")))
          .child(pill("rv-defv-x", t, "✕", (_e, cx) => { this.defAt = null; cx.notify(); }).tooltip("Dismiss this hint").accessibility_label("Dismiss"))); })
      .child(div().flex_1().min_h(0).relative()
        .on_mouse_down("left", (e) => { this.press = { x: e.local_position?.x ?? 0, w: e.bounds?.width ?? 0, shift: e.modifiers.shift, cmd: e.modifiers.platform }; })
        .child(v_virtual_list("rv-def-list", f.lines.length, ROW, (i) => String(i), (range) => f.lines.slice(range.start, range.end).map((l, k) => {
          const i = range.start + k;
          return h_flex().h(ROW).w_full().font_family(mono).text_size(13).when(f.from + i + 1 === f.line, (e) => e.bg(t.accent + "26"))
            .child(div().w(56).flex_none().pr(10).text_right().text_color(t.muted).child(String(f.from + i + 1)))
            .child(h_flex().flex_1().min_w(0).overflow_hidden().children(renderLine(div, l, f.spans[i] ?? [], c)));
        })).track_scroll(this.lists.def).on_item_click((key, cx) => this.defViewClick(Number(key), cx)).size_full())
        .child(Scrollbar.vertical("rv-def-list").absolute().inset_0()));
  },

  // ---- navigation

  visit(id, cx) {
    this.focusHunk = id;
    if (id && !this.prog.visited.has(id)) { this.prog.visited.add(id); this.saveProgress(cx); }
  },

  itemsOf(view) { return view === "steps" ? this.stepsItems() : this.filesItems(); }, // the Findings tab shows the Files list

  // Bring an item of a list (by its key in `at`, or its index) to the top of the view. The kit's scroll_to_item only
  // reveals an item at the near edge, so a target below the view would land at its bottom, under the code read
  // before. renderReview settles it in two frames (settleTop): just past the target first, then exactly to the top.
  scrollTo(view, key) { this.top = { view, key }; },
  settleTop(view, at, sizes, cx) {
    const go = this.top, i = go?.i ?? at[go?.key];
    if (!go || go.view !== view) return;
    if (i === undefined || i >= sizes.length) { this.top = null; return; }
    if (go.past) { this.top = null; this.lists[view].scroll_to_item(i, "top"); return; } // cut off above now: "top" aligns it
    // on_size_change reports logical px, item heights scale with the person's zoom: the view's height in item px.
    go.past = true; this.lists[view].scroll_to_item(pastTop(sizes, i, (this.listH ?? 800) / (settings().zoom || 1)), "center");
    cx.timer.after(0, (cx) => cx.notify());
  },

  // A flow's "path:line" to the hunk that holds it (in the AI list, else the Files view).
  jumpTo(at, cx) {
    if (this.exMode) return this.openExploreFile(pathOf(at), lineOf(at) ?? 1, cx); // no diff: the file itself
    const [, path, line] = /^(.*?):(\d+)/.exec(at ?? "") ?? [];
    const h = (this.hunks ?? []).find((x) => path && (x.path === path || x.path.endsWith(`/${path}`)) && x.rows.some((r) => r.n === Number(line)))
      ?? (this.hunks ?? []).find((x) => path && (x.path === path || x.path.endsWith(`/${path}`)));
    if (!h) { this.note = `Could not find ${at} in the diff`; return cx.notify(); }
    this.visit(h.id, cx); this.page = null; // from a Layers page: show the diff
    const view = this.tab === "steps" && this.itemsOf("steps").at[h.id] !== undefined ? "steps" : "files";
    if (view === "files") { if (this.tab !== "findings" && this.tab !== "comments") this.tab = "files"; this.unfold(h.path); this.sinceOn = false; } // the whole PR has every hunk
    const k = `+${line}`, { items } = this.itemsOf(view), row = items.findIndex((x) => x.t === "row" && x.path === h.path && lineKey(x.src[x.ri]) === k);
    if (view === "files") this.fileFocus = h.path; // marked in the file tree
    if (line && row >= 0) { this.fsel = { path: h.path, a: k, b: k }; this.top = { view, i: Math.max(0, row - 3) }; }
    else this.scrollTo(view, h.id);
    cx.notify();
  },

  goStep(i, cx, scroll = true) {
    const steps = this.steps();
    if (!steps.length) return;
    this.cur = Math.max(0, Math.min(i, steps.length - 1));
    this.visit(this.present(steps[this.cur])[0] ?? null, cx);
    this.fsel = null; this.sug = null;
    if (scroll) { this.tab = "steps"; this.page = null; this.scrollTo("steps", `s${this.cur}`); this.leftTop = 1; } // the open layer to the top on both sides
  },

  // n/p: the next hunk of the step (Layers) or of the whole diff (Files).
  goHunk(dir, cx) {
    const list = this.tab === "steps" ? this.present(this.steps()[this.cur] ?? { hunks: [] }) : this.shown().hunks.map((h) => h.id);
    const id = list[list.indexOf(this.focusHunk) + dir] ?? (list.includes(this.focusHunk) ? null : list[0]);
    if (!id) return;
    if (this.tab === "files") { const fp = (this.byId.get(id) ?? this.shown().hunks.find((h) => h.id === id))?.path; if (fp) this.unfold(fp); }
    this.visit(id, cx); this.fsel = null; this.sug = this.openSugs().find((s) => s.hunk === id)?.key ?? null;
    this.scrollTo(this.tab, id);
  },

  goFile(dir) {
    const paths = this.shown().patch.map((f) => f.path);
    const path = paths[paths.indexOf(this.fileFocus) + dir] ?? paths[0];
    if (path) { this.fileFocus = path; this.scrollTo("files", path); }
  },

  // ---- the diff as list items (one virtual list per tab)

  pushRows(items, at, rows, path, hunkOf) {
    // ponytail: gpui-kit's virtual list holds at most 10000 items; past the budget a file's lines fold to one note
    // (collapse other files to open it) instead of crashing the render. A paged list would lift the limit.
    const cap = this.rowCap ?? 9000;
    if (items.length + rows.length > cap) { items.push({ t: "note", text: `${rows.length} lines not shown: the view holds about ${cap} lines at once. Collapse other files (click their header) to open this one.` }); return []; }
    const sugs = this.openSugs(path), cms = this.comments.filter((c) => c.file === path), used = new Set();
    const finds = this.findings().filter((f) => f.file === path && OPEN_ST.includes(this.fstatus(f))); // a fix sent stays here until it is verified
    // A card sits under the first code line of its finding's range; an open one marks the range in the gutter.
    const under = new Map(finds.map((f) => [f, findingAnchor(rows, f.line, f.end)]));
    (this.fmarks ??= new Map()).set(path, rangeMarks(rows, finds.filter((f) => this.findOpen(f)).map((f) => ({ line: f.line, end: Math.max(f.end ?? f.line, under.get(f)), mark: SEV[f.severity] }))));
    const own = this.ghOwn(), gh = this.ghNow().list.filter((g) => g.path === path && !own(g)), ghUsed = new Set(), f = this.fsel, range = this.composing && f?.path === path && rangeOf(rows, f.a, f.b);
    const ths = this.threads().filter((x) => x.file === path), notes = codePins(this.pins(), path);
    const show = this.show();
    const thread = { gh, editId: this.composing ? this.editing?.id ?? null : null, composeKey: range && at.compose === undefined ? lineKey(rows[range[1]]) : null };
    rows.forEach((r, ri) => {
      if (r.kind === "gap") { items.push({ t: "gap", path, r }); return; }
      const hunk = hunkOf(r);
      if (hunk && at[hunk] === undefined) at[hunk] = items.length;
      items.push({ t: "row", path, src: rows, ri, hunk });
      if (r.number === undefined) return;
      if (this.defAt && this.defAt.key === `${path}:${lineKey(r)}`) items.push({ t: "def", d: this.defAt });
      // The Show switch: a kind switched off folds away here, never silently ("n hidden").
      const hidden = {}, hide = (k) => { hidden[k] = (hidden[k] ?? 0) + 1; };
      for (const s of sugs) if (atLine(r, s.line, s.old)) { if (show.ai) items.push({ t: "sug", s }); else hide("Findings"); }
      for (const it of lineThreads(r, cms, thread)) {
        if (it.c) used.add(it.c);
        if (it.t === "compose") { if (at.compose !== undefined) continue; at.compose = items.length; } // one composer, even when a hunk shows twice
        if (it.t === "composeact" && at.compose !== items.length - 1) continue;
        if (it.t === "comment") { if (show.mine) items.push(...this.cardItems("c", it.c)); else hide("Yours"); continue; } // also one taken from an AI note: it is yours now
        if (it.t === "cact") continue;
        if (it.t === "gh") ghUsed.add(it.g);
        if (it.t === "gh" && !show.github) { hide("GitHub"); continue; }
        items.push(it);
      }
      for (const th of ths) if (atLine(r, th.end, th.old)) { if (show.mine) items.push(...this.cardItems("th", th)); else hide("Yours"); }
      for (const pin of notes) if (atLine(r, pin.anchor.end, pin.anchor.old)) { if (show.notes) items.push(...this.cardItems("pin", pin)); else hide("Notes"); }
      if (r.kind !== "-") for (const f of finds) if (under.get(f) === r.number) { if (show.ai) items.push({ t: "find", f }, ...(this.findOpen(f) ? [{ t: "fact", f }] : [])); else hide("Findings"); }
      const n = Object.values(hidden).reduce((a, b) => a + b, 0);
      if (n) items.push({ t: "hidden", text: `${n} hidden · ${Object.keys(hidden).join(", ")}`, key: `${path}:${lineKey(r)}` });
    });
    // What found no line here (pending comments, GitHub's outdated ones): the file's end shows them (filesItems).
    return [...cms.filter((c) => !used.has(c)), ...gh.filter((g) => !ghUsed.has(g)).map((g) => ({ gh: g }))];
  },

  stepsItems(steps = this.steps()) {
    const items = [], at = {};
    steps.forEach((s, i) => {
      at[`s${i}`] = items.length;
      items.push({ t: "step", s, i }, ...(s.visuals ?? []).map((v, k) => ({ t: "vis", v, i, text: `vis|${i}|${k}` })));
      const present = this.present(s);
      if (s.stale) items.push({ t: "note", text: "Outdated: these hunks are no longer in the diff." });
      for (const id of present) {
        const h = this.byId.get(id);
        at[id] = items.length;
        items.push({ t: "path", h });
        this.pushRows(items, at, h.rows, h.path, () => id);
      }
    });
    return { items, at };
  },

  // The diff the Files tab shows: only the changes since your last review while that is on, else the whole PR.
  shown() {
    return this.sinceOn && this.since ? { patch: this.since.files, fileHunks: this.since.fileHunks, hunks: this.since.hunks }
      : { patch: this.patch ?? [], fileHunks: this.fileHunks, hunks: this.hunks ?? [] };
  },

  // Open a file and give it the list's room first (filesItems: overBudget).
  unfold(p) { this.collapsed.delete(p); this.recentOpen = [p, ...(this.recentOpen ?? []).filter((x) => x !== p)].slice(0, 200); },
  filesItems() {
    const items = [], at = {}, sh = this.shown();
    // 2500 lines open at most: every render walks the list's items, and Herdr stops a slice after ~50 ms; 9000 open
    // lines took that long. The virtual list's own limit (10000) leaves room for every file's header and one note.
    const cap = this.rowCap = Math.min(2500, Math.max(1000, 9700 - 2 * sh.patch.length));
    // The virtual list holds at most 10000 items: the files around the one you read (this.center, autoFold) and the
    // ones you opened last get the room (views.js allocate); the rest fold to one item of their height (overBudget).
    const rowsOf = new Map(), open = [], heads = []; // not `rows`: the loop below has its own
    sh.patch.forEach((f, i) => {
      if (this.collapsed.has(f.path) || f.binary || !sh.fileHunks?.get(f.path)?.length) return;
      rowsOf.set(f.path, this.memoRows(`0\0${f.path}`, f.path, sh.fileHunks.get(f.path), Array.isArray(this.full[f.path]) ? this.full[f.path] : null, f));
      open.push({ path: f.path, i, n: rowsOf.get(f.path).length });
    });
    this.overBudget = allocate({ files: open, center: this.center ?? 0, recent: this.recentOpen ?? [], cap });
    for (const f of sh.patch) {
      at[f.path] = items.length;
      heads.push(items.length);
      items.push({ t: "file", f });
      if (this.overBudget.has(f.path)) { items.push({ t: "fold", path: f.path, n: rowsOf.get(f.path).length, h: this.foldH(f.path, rowsOf.get(f.path)) }); continue; }
      if (this.collapsed.has(f.path)) continue;
      const hs = sh.fileHunks?.get(f.path) ?? [], full = Array.isArray(this.full[f.path]) ? this.full[f.path] : null;
      if (typeof this.full[f.path] === "string") items.push({ t: "note", text: this.full[f.path] });
      if (f.binary) { items.push({ t: "note", text: "Binary file" }); continue; }
      if (!hs.length) { items.push({ t: "note", text: f.status === "renamed" ? `Renamed from ${f.from}, content unchanged` : "No text change" }); continue; }
      const rows = this.memoRows(`0\0${f.path}`, f.path, hs, full, f);
      const loose = this.pushRows(items, at, rows, f.path, (r) => (r.h === undefined ? null : hs[r.h].id));
      for (const c of loose) {
        if (c.gh) { if (this.show().github) items.push({ t: "gh", g: c.gh, loose: true }); continue; }
        if (this.composing && this.editing?.id === c.id && at.compose === undefined) { at.compose = items.length; items.push({ t: "compose", c, loose: true }, { t: "composeact", c }); }
        else items.push(...this.cardItems("c", c, true));
      }
    }
    return { items, at, heads };
  },
  // A folded file's height: what it took when last open (renderReview keeps openH), else its rows'.
  foldH(path, rows) {
    const o = this.openH?.get(path);
    if (o?.rows === rows) return o.h;
    const memo = (this.rowsH ??= new WeakMap());
    if (!memo.has(rows)) memo.set(rows, rows.reduce((h, r) => h + (r.kind === "@" || r.kind === "gap" ? 30 : ROW), 0));
    return memo.get(rows);
  },
  // Scrolled near a folded file in another file than the room was given around: give it around this one, keeping
  // the item at the top of the view where it is (renderReview: anchor).
  autoFold(cx) {
    const L = this.filesList, v = this.vis;
    if (!L || !v || this.tab === "steps") return;
    const c = recenter({ heads: L.heads, top: L.top, folds: L.folds, start: v.start, end: v.end, center: this.center ?? 0, margin: FOLD_MARGIN });
    if (c === null) return;
    this.center = c; this.anchor = { key: L.keys[v.start], y: L.top[v.start] }; cx.notify();
  },


  // ---- clicks in the list: one handler for all rows (gpui-kit); where in the row comes from the press

  onItem(key, cx) {
    const it = this.byKey?.get(key); // a stable key: the item pressed, even if the list changed since
    if (!it) return;
    const { x, shift } = this.press;
    if (it.t === "compose") return this.draft.focus();
    this.fh.focus();
    if (it.t === "row") {
      if (it.hunk) this.visit(it.hunk, cx);
      const r = it.src[it.ri];
      if (r.number === undefined) return;
      if (this.press.cmd) return this.define(it, r, cx); // ⌘-click a name: its definition
      // Selections are (file, line keys), not row indexes: rows are rebuilt on every render.
      // A line number (GitHub's gutter "+") opens the composer there; shift-click makes it a range.
      const k = lineKey(r), f = this.fsel;
      const d = rowClick({ x, w: this.press.w, shift, gutterW: GUTTER, composing: this.composing, editing: Boolean(this.editing), sel: f, path: it.path, k,
        rangeOk: Boolean(f && f.path === it.path && rangeOf(this.rowsFor(it.path), f.a, k)) });
      if (d.focus) return this.draft.focus(); // the open composer keeps its line
      if (d.ask) { this.setDrawer("open", cx, null); return cx.notify(); }
      this.fsel = d.sel; this.sug = null;
      if (d.open) this.openComposer(cx);
    } else if (it.t === "sug") { this.sug = this.sug === it.s.key ? null : it.s.key; this.visit(it.s.hunk, cx); }
    else if (it.t === "ch" || it.t === "cb" || it.t === "cr") this.cardClick(it, x, cx);

    else if (it.t === "composeact") { const b = this.composeButtons().find((b) => x >= b.x && x < b.x + b.w); if (b) this[b.act](cx); }
    else if (it.t === "def") {
      const b = x - GUTTER - 12, which = b >= 0 && b < BTN + 40 ? 0 : b >= BTN + 40 + BTN_GAP && b < 2 * (BTN + 40) + BTN_GAP ? 1 : b >= 2 * (BTN + 40 + BTN_GAP) ? 2 : -1;
      const d = it.d.res?.definitions?.[0];
      if (which === 2) this.defAt = null;
      else if (d && which === 0) this.goDef(d, cx);
      else if (d && which === 1) { const a = vscodeArgs(this.lspRoot(), d); if (a) exec("code", a); else this.note = "Could not open: the definition is not a local file"; }
    } else if (it.t === "fact") {
      const b = x - GUTTER - 12, which = Math.floor(b / (BTN + BTN_GAP)), inside = b >= 0 && b % (BTN + BTN_GAP) < BTN;
      if (inside && which === 0) this.findingComment(it.f, cx);
      else if (inside && which === 1) this.discuss(it.f, cx);
      else if (inside && which === 2) { const job = this.fixOf(it.f.id); if (job?.terminal) this.goFix(job); else this.fix([it.f], cx); }
      else if (inside && which === 3) this.dismiss(it.f, cx);
    } else if (it.t === "find") {
      if (this.findOpen(it.f) && x >= this.press.w - 16 - FIND_LINK) this.openFinding(it.f);
      else (this.fopen ??= new Map()).set(it.f.id, !this.findOpen(it.f));
    }
    else if (it.t === "cact") {
      const b = x - GUTTER - 12, which = b >= 0 && b < BTN ? 0 : b >= BTN + BTN_GAP && b < 2 * BTN + BTN_GAP ? 1 : -1;
      if (it.t === "cact" && which === 0) this.openComposer(cx, it.c);
      else if (it.t === "cact" && which === 1) this.dropComment(it.c, cx);
      else if (it.t === "cact" && which === 2) this.fixComments([TH.commentId(it.c)], cx);
    } else if (it.t === "gap") this.expand(it.path, it.r.gap, x < GUTTER + GAP_SEG ? "down" : x < GUTTER + 2 * GAP_SEG ? "up" : "all", cx);
    else if (it.t === "file") {
      const p = it.f.path;
      this.fileFocus = p;
      if (x >= FILE_CHEV && x < FILE_CHEV + FILE_SEEN) this.toggleSeen(p, cx);
      else if (x >= FILE_CHEV + FILE_SEEN && x < FILE_CHEV + FILE_SEEN + FILE_WHOLE && this.shown().fileHunks?.has(p)) this.toggleWhole(p, cx);
      else if (this.collapsed.has(p) || this.overBudget?.has(p)) this.unfold(p); else this.collapsed.add(p);
    } else if (it.t === "fold") this.unfold(it.path);
    else if (it.t === "step") this.goStep(it.i, cx, false);
    else if (it.t === "path") this.visit(it.h.id, cx);
    cx.notify();
  },

  toggleSeen(path, cx) {
    if (this.prog.seen.has(path)) { this.prog.seen.delete(path); this.collapsed.delete(path); }
    else { this.prog.seen.add(path); this.collapsed.add(path); }
    this.saveProgress(cx);
  },

  toggleWhole(path, cx) {
    if (this.whole.has(path)) this.whole.delete(path);
    else { this.whole.add(path); this.unfold(path); this.loadFull(path, cx); }
  },

  expand(path, k, how, cx) {
    const g = (this.gaps[path] ??= {}), cur = g[k] ?? { down: 0, up: 0 };
    g[k] = how === "all" ? { down: 1e9, up: 0 } : { ...cur, [how]: cur[how] + MORE };
    this.loadFull(path, cx);
  },

  // The file at the PR head: from the local clone when it has that commit, else from GitHub.
  loadFull(path, cx) {
    if (this.full[path] !== undefined && !String(this.full[path]).startsWith("Could not load")) return;
    this.full[path] = "Loading file…";
    const url = this.prSel.url, repo = /github\.com\/([^/]+\/[^/]+)\/pull/.exec(url)?.[1];
    cx.spawn(async (cx) => {
      let text = null;
      try {
        if (!this.head) {
          const v = await exec("gh", ["pr", "view", url, "--json", "headRefOid"], { timeout: 30000 });
          if (v.code !== 0) throw new Error("PR head unknown");
          this.head = JSON.parse(v.stdout).headRefOid;
        }
        const head = this.head, w = this.worktree;
        // The worktree's file needs no process; a clone that has the commit one; GitHub the network.
        if (w && w.head === head && !w.local) text = await readTextFile(`${w.path}/${path}`).catch(() => null);
        const local = text === null && this.root ? await exec("git", ["cat-file", "-p", `${head}:${path}`], { cwd: this.root }).catch(() => null) : null;
        if (text !== null) {} else if (local?.code === 0) text = local.stdout;
        else {
          const r = await exec("gh", ["api", "-H", "Accept: application/vnd.github.raw", `repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${head}`], { timeout: 60000 });
          if (r.code !== 0) throw new Error(r.stderr.trim().slice(0, 160));
          text = r.stdout;
        }
      } catch (e) { if (this.prSel?.url === url) this.full[path] = `Could not load the file: ${String(e).replace(/^Error: /, "")}`; }
      if (this.prSel?.url !== url) return;
      if (text !== null) this.full[path] = text.replace(/\n$/, "").split("\n");
      cx.notify();
    });
  },

  // ---- suggestions and comments

  focusedSug() {
    const open = this.openSugs();
    return open.find((s) => s.key === this.sug) ?? open.find((s) => s.hunk === this.focusHunk) ?? null;
  },

  takeSug(s, cx) {
    const h = this.byId.get(s.hunk), c = h && suspectComment(s, h.rows, Date.now().toString(36));
    if (!c) { this.note = "Could not accept: that line is no longer in the diff"; return; }
    this.comments = [...this.comments, { ...c, head: this.head }]; this.persist(cx);
    this.prog.handled[s.key] = "taken"; this.saveProgress(cx); this.sug = null;
  },

  dropSug(s, cx) { this.prog.handled[s.key] = "dropped"; this.saveProgress(cx); this.sug = null; },

  // One file's rows as the Files view shows them (hunks plus opened context): what selections are measured on.
  // whole: of the whole PR even while only the changes since your last review are shown (findings are on the PR).
  rowsFor(path, whole = false) {
    const sh = whole ? { patch: this.patch ?? [], fileHunks: this.fileHunks } : this.shown();
    const hs = sh.fileHunks?.get(path) ?? [], f = sh.patch.find((x) => x.path === path), full = Array.isArray(this.full[path]) ? this.full[path] : null;
    return this.memoRows(`${whole ? 1 : 0}\0${path}`, path, hs, full, f);
  },
  // Memoized on their inputs: findings call rowsFor per finding on every render, and the Files view keeps the same row
  // arrays across renders, which the highlight cache (spanMap) is keyed on (a big PR timed the render out).
  memoRows(key, path, hs, full, f) {
    const deps = [hs, full, JSON.stringify(this.gaps[path] ?? null), this.whole.has(path), f?.status];
    const memo = (this.rowsMemo ??= new Map()), hit = memo.get(key);
    if (hit && hit.deps.every((d, i) => d === deps[i])) return hit.rows;
    const rows = fileRows(hs.map((h) => h.rows), full, this.gaps[path], this.whole.has(path), f?.status === "modified" || f?.status === "renamed");
    if (memo.size > 8000) memo.clear(); // ponytail: two entries per file (whole/shown); 3000-file PRs fit
    memo.set(key, { deps, rows });
    return rows;
  },

  // The selected range as a comment anchor (lines, side, quoted code); null when nothing (or nothing valid) is selected.
  selAnchor() {
    const f = this.fsel, rows = f ? this.rowsFor(f.path) : null, range = rows && rangeOf(rows, f.a, f.b);
    return range ? selection(rows, range[0], range[1]) : null;
  },

  // c: the selection, else the focused suggestion's line, else the first change of the focused hunk.
  ensureSel() {
    if (this.fsel) return;
    const h = this.byId?.get(this.focusHunk) ?? this.hunks?.[0];
    if (!h) return;
    const s = this.focusedSug(), i = s ? h.rows.findIndex((r) => atLine(r, s.line, s.old)) : h.rows.findIndex((r) => r.kind === "+" || r.kind === "-");
    if (i >= 0) this.fsel = { path: h.path, a: lineKey(h.rows[i]), b: lineKey(h.rows[i]) };
  },

  // ---- threads: comments that went out stay under their lines with the agent's or GitHub's replies

  threadKey() { return this.prSel?.url ?? null; },
  repliesFile() { return `${repliesDir()}/${hash(this.threadKey() ?? "")}.jsonl`; },
  threads() { return TH.threadsOf(this.threadDoc, this.threadKey()); },
  async loadThreads(cx) {
    const key = this.threadKey();
    if (!key) return;
    const [doc, rep] = await Promise.all([readTextFile(threadsFile()).catch(() => null), readTextFile(this.repliesFile()).catch(() => null)]);
    if (this.threadKey() !== key) return;
    this.threadDoc = doc ? JSON.parse(doc) : {}; this.replies = TH.parseReplies(rep);
    cx.notify();
  },
  // threads.json changed by fn, here and in the file (compare-and-swap, like the findings' status).
  updateThreads(cx, fn) {
    this.threadDoc = fn(this.threadDoc);
    cx.spawn(async (cx) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const before = await readTextFile(threadsFile()).catch(() => null);
        try { await writeTextFile(threadsFile(), JSON.stringify(fn(before ? JSON.parse(before) : {})), before); this.registerReview(cx); this.publish(); return; } catch { /* written meanwhile: again */ }
      }
      this.note = "Could not save the sent comments"; cx.notify();
    });
  },
  // GitHub comments this review shows itself (a posted thread and the replies to it) stay out of the plain list.
  ghOwn() {
    const ids = new Set(this.threads().map((t) => t.ghId).filter(Boolean));
    return (g) => ids.has(g.id) || ids.has(g.in_reply_to_id);
  },
  // A fixed thread folds, unless its fix still waits for Apply to PR.
  threadOfView(th) { return TH.threadView(th, this.replies[th.id] ?? [], TH.ghRepliesTo(this.gh, th.ghId), this.openThreads.has(th.id) || Boolean(this.fixOf(th.id))); },

  // The agent a send goes to (as deliver picks it) and how that reads.
  sendAgent() {
    const origin = this.prSel, space = origin?.space ?? focused()?.space ?? null;
    const agent = origin?.session ? this.sessionAgent(origin) : space ? this.target(space) : null;
    return { agent, label: TH.agentLabel(agent, origin?.session ? "the PR's session, resumed in a new tab (claude --resume)" : "a new Claude tab in this repo") };
  },
  // Nothing is typed into an agent's session without this preview: who gets it, the reviewer's own words apart, the
  // exact text (editable). go(text, cx): what "Send to agent" does with the confirmed text (default: deliver it).
  previewSend(cx, { what, own, prompt, onSent, go, ownLabel = "YOUR COMMENT", ask = null }) {
    const { agent, label } = this.sendAgent();
    this.sendP = { ...TH.preview({ what, agent: label, own, prompt }), onSent, go, ownLabel, ask, address: agent?.address ?? null };
    this.sendText.set_value(prompt); this.finishOpen = false;
    cx.notify();
  },
  sendConfirmed(cx) {
    const p = this.sendP;
    if (!p || this.sending) return;
    if (p.fix?.pool && !p.fix.items.length) return; // "Fix several…" with nothing ticked: the button is off
    const out = TH.confirm(p, this.sendText.value());
    this.sendP = null;
    if (p.fix?.target === "sub") return this.startSubFix(p, out.text, cx);
    if (p.go) p.go(out.text, cx);
    else this.deliver(out.text, cx, out.what, (cx) => p.onSent?.(cx));
    cx.notify();
  },

  // "Reply" in a thread: one follow-up to the same agent with the thread as context (through the preview).
  followup(cx) {
    const th = this.threads().find((t) => t.id === this.replyTo), text = this.replyIn.value().trim();
    if (!th || !text) return;
    const replies = this.replies[th.id] ?? [], key = this.threadKey();
    this.previewSend(cx, { what: "Reply", own: text, prompt: TH.followupPrompt({ pr: this.pr, thread: th, replies, text, file: this.repliesFile(), lang: this.lang() }),
      onSent: (cx) => { this.updateThreads(cx, (d) => TH.addFollowup(d, key, th.id, text, replies.length)); this.replyIn.set_value(""); this.replyTo = null; } });
  },
  // A thread's buttons, left to right (clicks placed by x in onItem): Reply, the agent's last commit, GitHub, fold.
  threadButtons(th, v = this.threadOfView(th)) {
    const fv = this.fixView(this.fixOf(th.id));
    const fix = !fv ? [{ label: "Fix…", act: (cx) => this.fixComments([th.id], cx) }]
      : [...(fv.job.terminal ? [{ label: "Go to fix", act: () => this.goFix(fv.job) }] : []), ...(fv.commit && fv.job.target === "sub" ? [{ label: "Apply to PR", primary: true, act: (cx) => this.applyFix(fv.job, cx) }] : []),
        ...(fv.job.target === "sub" ? [{ label: "Discard fix", act: (cx) => this.discardFix(fv.job, cx) }] : [])];
    return [...fix, { label: "Reply", primary: !fv?.commit, act: (cx) => { this.replyTo = th.id; this.replyIn.set_value(""); cx.timer.after(0, () => this.replyIn.focus()); } },
      ...(v.fixedIn || v.entries.some((e) => e.commit) ? [{ label: `Open ${String(v.fixedIn ?? [...v.entries].reverse().find((e) => e.commit).commit).slice(0, 7)}`, act: () => this.openCommit(v.fixedIn ?? [...v.entries].reverse().find((e) => e.commit).commit) }] : []),
      ...(th.url ? [{ label: "On GitHub ↗", act: () => openUrl(th.url) }] : []),
      ...(v.status === "fixed" ? [{ label: "Fold", act: () => this.openThreads.delete(th.id) }] : [])];
  },
  // ---- Fix: comments (pending or sent) and findings to a sub-agent in its own worktree (default) or the main agent,
  // always through the preview; the sub-agent never pushes and hands its fix to nobody: it stays on its branch until
  // the reviewer picks "Apply to PR" (cherry-pick onto the PR's checkout) or "Hand over…" (the main agent takes it).

  selected() { return TH.selectedOf(this.threadDoc, this.threadKey()); },
  toggleSel(id, cx) { const key = this.threadKey(); this.updateThreads(cx, (d) => TH.toggleSelected(d, key, id)); },
  fixes() { return TH.fixesOf(this.threadDoc, this.threadKey()); },
  fixOf(id) { return TH.fixFor(this.threadDoc, this.threadKey(), id); },
  // The local checkout a fix branch is made in and applied to: the session's folder or the clone the PR was picked in
  // (which may be on another branch: the fix still starts at the PR head, threads.js fixStart), the branch's repo, else
  // the review's checkout of the PR head.
  fixBase() { return this.prSel?.cwd ?? (this.prSel?.space ? this.root : null) ?? this.worktree?.path ?? null; },
  // A job's state for its rows: running (with its agent's status), ready (a fixed report with a commit), main.
  fixView(job) {
    const commit = job && TH.fixCommit(job, this.replies, this.find.reports);
    // agents() has only terminals shown in a pane; a sub-agent runs in the background, so terminals() (hc ls) too.
    const agent = job?.terminal ? agents().find((a) => a.address === job.terminal) ?? terminals().find((x) => x.address === job.terminal && x.state === "live") : null;
    const status = agent?.status === "blocked" ? "waits for your OK" : agent?.status;
    return job ? { job, commit, status: status ?? (job.target === "main" ? "main agent" : "ended") } : null;
  },
  // Comments by id: the pending ones and the sent threads.
  commentsById(ids) {
    const all = [...TH.withIds(this.comments), ...this.threads()];
    return ids.map((id) => all.find((c) => c.id === id)).filter(Boolean);
  },
  fixComments(ids, cx) {
    const comments = this.commentsById(ids);
    if (!comments.length) return;
    const items = comments.map((c) => ({ kind: "comment", id: c.id }));
    const prompt = (sub) => TH.fixCommentsPrompt({ pr: this.pr, comments, file: this.repliesFile(), lang: this.lang(), ...sub });
    this.previewFix(cx, { what: "Fix with agent", ownLabel: comments.length === 1 ? "YOUR COMMENT" : "YOUR COMMENTS", own: comments.map((c) => `${c.file} ${uiLine(c)}: ${c.text}`).join("\n\n"), items, prompt,
      labels: comments.map((c) => `${c.file} ${uiLine(c)}: ${c.text}`),
      sent: (cx, how) => {
        const key = this.threadKey(), pending = TH.withIds(this.comments).filter((c) => ids.includes(c.id));
        if (pending.length) { this.comments = TH.withIds(this.comments).filter((c) => !ids.includes(c.id)); this.persist(cx); }
        this.updateThreads(cx, (d) => TH.clearSelected(TH.addThreads(d, key, pending, how)));
      } });
  },
  // The preview with the target choice; prompt(sub) gives the text for a sub-agent (sub: {branch, path, head}: its
  // worktree and the PR head it starts from) or, with null, for the main agent.
  previewFix(cx, { what, own, ownLabel, items, labels, prompt, sent, pool = null, alone = 0, target = null }) {
    const ids = items.map((x) => x.id), branch = TH.fixBranch(this.prSel?.number, ids), path = TH.fixPath(home(), this.prSel?.repo, branch), base = this.fixBase();
    cx.spawn(async (cx) => {
      const at = base ? (await exec("git", ["-C", base, "rev-parse", "HEAD"], { timeout: 20000 }).catch(() => null))?.stdout?.trim() || null : null;
      const head = TH.fixStart({ local: Boolean(this.worktree?.local), prHead: this.headNow(), checkoutHead: at });
      const { label } = this.sendAgent(), sub = { branch, path, head };
      this.previewSend(cx, { what, own, ownLabel, prompt: prompt(sub), onSent: (cx) => {
        const job = { id: `${Date.now().toString(36)}`, items, target: "main", at: Date.now(), state: "running" };
        this.updateThreads(cx, (d) => TH.addFix(d, this.threadKey(), job));
        sent(cx, { route: "agent", agent: label });
      } });
      this.sendP.fix = { target: "sub", ...sub, items, labels, prompt, sent, pool, alone };
      if (target) this.fixTarget(target);
    });
  },
  // "Main agent" is a choice only when the PR has a live agent session and the PR is trusted: someone else's PR is
  // fixed in a separate checkout, never in a session with its own rights.
  mainOffered() { return Boolean(this.sendAgent().agent) && this.trustedPr(); },
  // The target switch in the preview: the text follows (a sub-agent gets its worktree note).
  fixTarget(target) {
    const f = this.sendP?.fix;
    if (!f || f.target === target || (target === "main" && !this.mainOffered())) return;
    f.target = target;
    this.sendText.set_value(f.prompt(target === "sub" ? f : null));
  },
  // A new Claude in a fresh worktree on the fix branch from the PR head the preview named (shown under the PR's agent
  // when one runs). Nothing is typed into another session: the fix stays on its branch until the reviewer applies it.
  startSubFix(p, text, cx) {
    const f = p.fix, base = this.fixBase(), key = this.threadKey(), trusted = this.trustedPr(); // trust of the PR the prompt is for
    if (!base) { this.note = "Not started: the PR has no local checkout to branch the fix from"; return cx.notify(); }
    this.sending = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        const git = (args) => exec("git", ["-C", base, ...args], { timeout: 60000 });
        const head = f.head ?? (await git(["rev-parse", "HEAD"])).stdout.trim();
        if (!head) throw new Error(`${base} is not a git checkout`);
        // The PR head may not be in this clone yet (the review's checkout can live in another one): fetch it.
        if ((await git(["cat-file", "-e", `${head}^{commit}`])).code !== 0 && this.prSel?.number) await git(["fetch", "--quiet", "origin", `pull/${this.prSel.number}/head`]);
        await exec("mkdir", ["-p", f.path.replace(/\/[^/]+$/, "")]).catch(() => null);
        const w = await git(["worktree", "add", "-b", f.branch, f.path, head]);
        if (w.code !== 0) throw new Error(w.stderr.trim().slice(0, 200));
        const id = Date.now().toString(36), { agent } = this.sendAgent();
        const r = await hc(TH.subAgentArgs({ parent: agent?.address ?? null, cwd: f.path, name: `fix-${id}`, env: this.ctxEnv(this.ctxId()), task: text, job: id, auto: trusted, model: model() }));
        if (r.code !== 0) { await git(["worktree", "remove", "--force", f.path]); await git(["branch", "-D", f.branch]); throw new Error((r.stderr || r.stdout).trim().slice(0, 200)); }
        const terminal = JSON.parse(r.stdout).address;
        this.updateThreads(cx, (d) => TH.addFix(d, key, { id, branch: f.branch, path: f.path, base, head, items: f.items, terminal, target: "sub", at: Date.now(), state: "running" }));
        f.sent(cx, { route: "agent", agent: `Fix sub-agent · ${f.branch}` });
        this.note = `Fix started: a sub-agent works on ${f.branch} in its own worktree. Its fix stays there until you apply it.`;
      } catch (e) { this.note = `Not started: ${String(e).replace(/^Error: /, "")}`; }
      finally { this.sending = false; cx.notify(); }
    });
  },
  // A finding's buttons in the Findings tab, by where it stands. At most one is lit, the next step: "Add to review" on
  // an unresolved finding, "Go to fix" while the agent works or after a failed check, "Apply to PR" once the fix is
  // verified on its branch (before that the section's "Verify fixes" is the lit one). What ends something (Discard
  // fix, Dismiss finding) comes last and stays quiet. A settled finding only reopens.
  findingActions(x, settled, t) {
    if (settled) return [pill(`rv-fro-${x.id}`, t, "Reopen", (_e, cx) => this.setFinding(x, "open", cx)).tooltip("Make this finding unresolved again")];
    const fv = this.fixView(this.fixOf(x.id)), v = this.find.status[x.id]?.verify, lit = t.foreground;
    const add = (on) => pill(`rv-fcm-${x.id}`, t, "Add to review", (_e, cx) => this.findingComment(x, cx), false, on ? lit : undefined).tooltip("Add this finding to your pending review comments; nothing is posted until you finish the review");
    const ask = pill(`rv-fdi-${x.id}`, t, "Ask an agent…", (_e, cx) => this.discuss(x, cx)).tooltip("Ask an agent about this finding: a preview first says what starts and what it may do");
    const dismiss = pill(`rv-fdm-${x.id}`, t, "Dismiss finding", (_e, cx) => this.dismiss(x, cx)).tooltip(`Dismiss this finding${x.sources.length > 1 ? ` with all ${x.sources.length} of its sources` : ""}; it stays here under Dismissed`);
    // The same order as on the card in the diff: Add, Ask, Fix, Dismiss.
    if (!fv) return [add(true), ask, pill(`rv-ffx-${x.id}`, t, "Fix with agent…", (_e, cx) => this.fix([x], cx)).tooltip("Have an agent fix this: a preview first says where it works, what it may do and that it never pushes"), dismiss];
    const sub = fv.job.target === "sub", ready = Boolean(fv.commit) && sub, checked = v?.branch ? v.result : null;
    return [badge(t, fv.commit ? `Fix ready on ${fv.job.branch ?? "the PR"}` : `Fixing · ${fv.status}`, fv.commit ? t.ansi2 : t.ansi3).id(`rv-ffb-${x.id}`).tooltip("The fix agent's progress on this finding"),
      ...(fv.job.terminal ? [pill(`rv-fgo-${x.id}`, t, "Go to fix", () => this.goFix(fv.job), false, !ready || checked === "not_fixed" ? lit : undefined).tooltip("Show the fix agent's terminal")] : []),
      ...(ready ? [pill(`rv-fap-${x.id}`, t, "Apply to PR", (_e, cx) => this.applyFix(fv.job, cx), false, checked === "fixed" ? t.ansi2 : undefined)
        .tooltip("Cherry-pick the fix commits onto the local checkout of the PR's branch; nothing is pushed")] : []),
      add(false), ask,
      ...(sub ? [pill(`rv-fdc-${x.id}`, t, "Discard fix", (_e, cx) => this.discardFix(fv.job, cx)).tooltip("Delete the fix's worktree and branch")] : []), dismiss];
  },
  goFix(job) { if (job?.terminal) run("terminal.peek", { terminal: job.terminal }); },
  // Apply to PR: the branch's commits cherry-picked onto
  // the PR's checkout, only when it is clean (else the main agent can do it, through the preview); then the worktree and
  // branch go. Nothing is pushed here.
  applyFix(job, cx) {
    const key = this.threadKey(), git = (args) => exec("git", ["-C", job.base, ...args], { timeout: 120000 });
    cx.spawn(async (cx) => {
      const plan = TH.applyPlan({ status: (await git(["status", "--porcelain"])).stdout, head: job.head, branch: job.branch,
        onHead: (await git(["merge-base", "--is-ancestor", job.head, "HEAD"])).code === 0, where: (await git(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim() });
      if (!plan.ok) {
        this.note = plan.off ? plan.reason : `${plan.reason} Hand the cherry-pick to the main agent instead (Hand over…).`; this.applyBlocked = plan.off ? null : job;
        return cx.notify();
      }
      const r = await git(plan.args);
      if (r.code !== 0) { await git(["cherry-pick", "--abort"]); this.note = `Not applied (conflict?): ${r.stderr.trim().slice(0, 200)}`; return cx.notify(); }
      await git(["worktree", "remove", "--force", job.path]); await git(["branch", "-D", job.branch]);
      if (job.terminal) run("terminal.kill", { terminal: job.terminal });
      this.updateThreads(cx, (d) => TH.setFix(d, key, job.id, { state: "applied", appliedAt: Date.now() }));
      this.applyBlocked = null; this.note = `Applied ${job.branch} to the PR's checkout (not pushed). Verify when you're ready.`;
      cx.notify();
    });
  },
  handOverApply(job, cx) {
    this.previewSend(cx, { what: "Apply fix", own: "", prompt: TH.applyPrompt(job), onSent: () => { this.applyBlocked = null; } });
  },
  discardFix(job, cx) {
    const key = this.threadKey(), git = (args) => exec("git", ["-C", job.base, ...args], { timeout: 60000 });
    cx.spawn(async (cx) => {
      if (job.terminal) run("terminal.kill", { terminal: job.terminal });
      if (job.path) { await git(["worktree", "remove", "--force", job.path]); await git(["branch", "-D", job.branch]); }
      this.updateThreads(cx, (d) => TH.setFix(d, key, job.id, { state: "discarded" }));
      this.note = `Discarded ${job.branch ?? "the fix"}`; cx.notify();
    });
  },

  // A commit an agent named: its diff on GitHub (a PR there), else a note.
  openCommit(sha) {
    const m = /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(this.prSel?.url ?? "");
    if (m) openUrl(`https://github.com/${m[1]}/commit/${sha}`); else this.note = `Commit ${sha}: open it with git show ${sha}`;
  },

  // ---- comment cards (GitHub-like, compact): pending comments, sent threads and notes under their line. A card is up to
  // three rows of the list: its head (avatar, author, time, status, a ghost action and ⋯), its body (text and replies)
  // and, for a sent thread, a one-line Reply. Clicks are placed by x in each row (cardClick).

  cardItems(k, obj, loose = false) {
    const card = { t: "ch", k, obj, loose }, c = this.cardOf(card);
    if (c.folded) return [card];
    return [card, { t: "cb", k, obj, loose }, ...(k === "th" ? [{ t: "cr", k, obj }] : [])];
  },
  cardMax() { return Math.max(320, Math.min(CARD_W, (this.listW ?? 900) - GUTTER - 16)); },
  // A card is as wide as its text needs, 420 to 720 px (narrower only when the diff is).
  cardW(c) {
    if (c && c.src !== "notes") return Math.max(320, (this.listW ?? 900) - GUTTER - 16); // your own words: as wide as a finding's card
    const longest = c ? Math.max(String(c.text).split("\n").reduce((n, l) => Math.max(n, l.length), 0) * 7.4 + 28, ...c.replies.map((r) => r.text.length * 7 + 60), 300 + c.status[0].length * 6.5) : CARD_W;
    return Math.min(this.cardMax(), Math.max(CARD_MIN, Math.round(longest)));
  },
  // Lines a text takes in a card (UI font ≈ 7.4 px per char at 13.5 px).
  cardLines(text, w = this.cardMax()) { return Math.max(1, Math.ceil(String(text).length / Math.max(30, (w - 28) / 7.4))) + (String(text).match(/\n/g)?.length ?? 0); },
  cardByKey(key) {
    const [k, ...rest] = key.split(":"), id = rest.join(":");
    const obj = k === "c" ? TH.withIds(this.comments).find((c) => c.id === id) : k === "th" ? this.threads().find((x) => x.id === id) : this.pins().find((x) => x.id === id);
    return obj ? this.cardOf({ k, obj }) : null;
  },
  // What a card shows and offers: {key, src, author, time, status: [label, colour], text, replies, action: [label, fn] |
  // null, menu: [[label, danger, fn]], folded: one-line text | null, sel}.
  cardOf(it) {
    const o = it.obj, hm = (ms) => (Number.isFinite(ms) ? new Date(ms).toTimeString().slice(0, 5) : "");
    const where = (x) => `${x.file}:${x.start ?? x.end}${x.end !== x.start && x.start !== undefined ? `-${x.end}` : ""}`;
    if (it.k === "c") {
      const id = TH.commentId(o);
      return { key: `c:${id}`, id, src: o.from === "ki" ? "ai" : "mine", author: "You", time: hm(Number.parseInt(o.id, 36)), sel: true,
        status: [it.loose ? `Pending · ${uiLine(o)}, not shown` : o.from === "ki" ? "Pending · from AI suggestion" : "Pending", "ansi3"], text: o.text, replies: [], folded: null,
        action: ["Fix", (cx) => this.fixComments([id], cx)],
        menu: [["Edit", false, (cx) => this.openComposer(cx, o)], ["Fix…", false, (cx) => this.fixComments([id], cx)], ["Select", false, (cx) => this.toggleSel(id, cx)],
          ["Copy position", false, () => copyText(where(o))], ["Delete", true, (cx) => this.dropComment(o, cx)]] };
    }
    if (it.k === "th") {
      const v = this.threadOfView(o), fv = this.fixView(this.fixOf(o.id)), agent = o.agent?.split(" · ")[0] || "Agent";
      const status = fv?.commit ? ["Fix ready", "ansi2"] : fv ? [`Fixing · ${fv.status}`, "ansi3"] : v.status === "fixed" ? [`Reported fixed${v.fixedIn ? ` in ${v.fixedIn.slice(0, 7)}` : ""}`, "ansi2"]
        : v.status === "wontfix" ? ["Declined", "muted"] : v.status === "answered" || v.status === "question" ? ["Agent replied", "accent"]
        : o.route === "github" ? [o.dry ? "Dry run: not posted" : "Posted", "ansi4"] : ["Sent to agent", "ansi6"];
      const action = fv?.commit && fv.job.target === "sub" ? ["Apply to PR", (cx) => this.applyFix(fv.job, cx)] : fv ? ["Go to fix", () => this.goFix(fv.job)] : ["Fix", (cx) => this.fixComments([o.id], cx)];
      return { key: `th:${o.id}`, id: o.id, src: "mine", author: "You", time: hm(o.sentAt), sel: true, status, text: o.text, action,
        folded: v.collapsed ? `You: ${plain(o.text)} · ${status[0]}` : null,
        replies: v.entries.filter((e) => this.show().agents || e.who !== "agent").map((e) => ({ author: e.who === "you" ? "You" : e.who === "agent" ? agent : e.who, src: e.who === "you" ? "mine" : e.who === "agent" ? "agents" : "github",
          text: e.text, status: e.status ? [{ fixed: `Reported fixed${e.commit ? ` in ${String(e.commit).slice(0, 7)}` : ""}`, wontfix: "Declined", answered: "Answered", question: "Question" }[e.status] ?? e.status, THREAD_COLOR[e.status] ?? "muted"] : null })),
        menu: [["Reply", false, (cx) => this.startReply(o.id, cx)], ...(fv?.job.terminal ? [["Go to fix", false, () => this.goFix(fv.job)]] : []),
          ...(fv?.job.target === "sub" ? [["Discard fix", true, (cx) => this.discardFix(fv.job, cx)]] : []), ...(v.status === "fixed" || v.status === "wontfix" ? [[this.openThreads.has(o.id) ? "Fold" : "Unfold", false, () => { if (this.openThreads.has(o.id)) this.openThreads.delete(o.id); else this.openThreads.add(o.id); }]] : []),
          ["Select", false, (cx) => this.toggleSel(o.id, cx)], ...(o.url ? [["Open on GitHub", false, () => openUrl(o.url)]] : []), ["Copy position", false, () => copyText(where(o))]] };
    }
    const open = this.openNotes?.has(o.id);
    return { key: `pin:${o.id}`, id: o.id, src: "notes", author: "Note · private", time: hm(o.at), sel: false, status: [o.q ? `on: ${o.q}` : "Ask answer", "muted"], text: open ? o.text : o.summary,
      replies: [], folded: null, action: ["To comment", (cx) => this.noteToComment(o, cx)],
      menu: [[open ? "Show less" : "Show the whole answer", false, () => { this.openNotes ??= new Set(); if (open) this.openNotes.delete(o.id); else this.openNotes.add(o.id); }],
        ["Turn into comment", false, (cx) => this.noteToComment(o, cx)], ["Copy position", false, () => copyText(where(o.anchor))], ["Unpin", true, (cx) => this.unpin(o.id, cx)]] };
  },
  startReply(id, cx) { this.replyTo = id; this.replyIn.set_value(""); cx.timer.after(0, () => this.replyIn.focus()); },
  // Header geometry (x from the list's left edge): the box, the ghost action, ⋯.
  cardZones(c) {
    const right = GUTTER + this.cardW(c), aw = c.action ? Math.round(c.action[0].length * 7.2 + 30) : 0;
    return { box: [GUTTER + 6, GUTTER + 26], menu: [right - 30, right - 6], action: [right - 34 - aw, right - 34] };
  },
  cardClick(it, x, cx) {
    const c = this.cardOf(it), z = this.cardZones(c), inz = ([a, b]) => x >= a && x < b;
    if (it.t === "ch" && c.folded) { this.openThreads.add(c.id); return; }
    if (it.t === "ch" && c.sel && inz(z.box)) return this.toggleSel(c.id, cx);
    if (it.t === "ch" && inz(z.menu)) {
      openOverlay({ mod: "pr-review", props: { part: "cmenu", key: c.key, items: c.menu.map(([label, danger]) => [label, danger]) }, kind: "popup", width: 210, height: 12 + 30 * c.menu.length });
      return;
    }
    if (it.t === "ch" && c.action && inz(z.action)) return c.action[1](cx);
    if (it.t === "cr") return this.startReply(c.id, cx);
    if (it.k === "c") return this.openComposer(cx, it.obj);
    if (it.k === "pin") { this.openNotes ??= new Set(); if (this.openNotes.has(c.id)) this.openNotes.delete(c.id); else this.openNotes.add(c.id); }
  },
  cardRow(it, t) {
    const c = this.cardOf(it), W = this.cardW(c), col = c.src === "notes" ? t[SOURCE.notes] : t.foreground, selMode = this.selected().length > 0, sel = this.selected().includes(c.id);
    const avatar = (name, src, size = 18) => div().w(size).h(size).flex_none().rounded_full().flex().items_center().justify_center().bg((t[SOURCE[src]] ?? t.accent) + "33")
      .text_size(size * 0.58).font_semibold().text_color(t.foreground).child(String(name).replace(/^Note.*/, "N")[0]?.toUpperCase() ?? "?");
    const pillC = ([label, k]) => div().flex_none().px(6).h(18).flex().items_center().rounded(9).border_1().border_color(t[k] ?? t.muted).text_size(11).text_color(t[k] ?? t.muted).child(label);
    // The card's surface: lighter than the diff, a 1 px border all round (the head, body and reply rows draw their parts
    // of it), rounded 8, the source's stripe on the left.
    const bg = c.src === "notes" ? t.ansi5 + "14" : t.raised, stripe = (e) => e.child(div().absolute().left(0).top(0).bottom(0).w(3).bg(col));
    const frame = (e) => e.relative().w(W).bg(bg).border_color(t.border).border_l(1).border_r(1);
    if (it.t === "ch" && c.folded) {
      return div().w_full().h(28 + 2 * CARD_GAP).pl(GUTTER).py(CARD_GAP).child(stripe(frame(h_flex()).id(`rv-cfold-${c.key}`).tooltip("Unfold this thread").h(28).pl(12).pr(10).gap(8).items_center().border_t(1).border_b(1).rounded(8).overflow_hidden().text_size(12.5).cursor_pointer()
        .child(div().flex_none().text_color(t.muted).child("▸")).child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(c.folded))));
    }
    if (it.t === "ch") {
      const z = this.cardZones(c);
      return div().w_full().h(CARD_HEAD).pl(GUTTER).pt(CARD_GAP).child(stripe(frame(h_flex()).h(CARD_HEAD - CARD_GAP).pl(8).pr(6).gap(6).items_center().border_t(1).rounded_tl(8).rounded_tr(8).overflow_hidden().text_size(12)
        .when(c.sel, (e) => e.child(div().id(`rv-cbox-${c.key}`).tooltip("Select to fix this comment with an agent").accessibility_label("Select comment").w(14).h(14).flex_none().rounded(3).border_1().border_color(sel ? t.accent : t.input).bg(sel ? t.accent : t.background)
          .flex().items_center().justify_center().text_size(10).text_color(t.accent_foreground).opacity(selMode ? 1 : 0).hover((s) => s.opacity(1)).child(sel ? "✓" : "")))
        .child(avatar(c.author, c.src)).child(div().flex_none().font_semibold().text_color(c.src === "notes" ? t.ansi5 : t.foreground).child(c.author))
        .child(div().flex_none().text_color(t.muted).child(c.time)).child(pillC(c.status).id(`rv-chs-${c.key}`).tooltip(`Where this comment stands: ${c.status[0]}`))
        .when(this.staleNow().has(c.id), (e) => e.child(pillC(["STALE", "ansi3"]).id(`rv-chst-${c.key}`).tooltip(STALE_TIP)))
        .child(div().flex_1())
        .when(Boolean(c.action), (e) => e.child(div().id(`rv-cha-${c.key}`).tooltip(c.action[0] === "Fix" ? "Fix this with an agent: a preview first; a sub-agent works on its own branch and never pushes" : c.action[0] === "Apply to PR" ? "Cherry-pick the fix onto the PR's checkout; nothing is pushed" : c.action[0] === "Go to fix" ? "Show the fix agent's terminal" : "Turn this note into a pending comment").accessibility_label(c.action[0]).w(z.action[1] - z.action[0]).h(22).flex_none().flex().items_center().justify_center().gap(4).rounded(5)
          .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).child(c.action[0] === "Fix" ? "✦ Fix" : c.action[0])))
        .child(div().id(`rv-chm-${c.key}`).tooltip("More actions for this comment").accessibility_label("More actions").w(24).h(22).flex_none().flex().items_center().justify_center().rounded(5).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).child("⋯"))));
    }
    if (it.t === "cr") {
      return div().w_full().h(CARD_REPLY + CARD_GAP).pl(GUTTER).pb(CARD_GAP).child(stripe(frame(h_flex()).h(CARD_REPLY).px(12).items_center().border_b(1).rounded_bl(8).rounded_br(8).overflow_hidden()
        .child(div().id(`rv-crr0-${c.key}`).tooltip("Reply in this thread; a preview comes before anything is sent").flex_1().h(24).px(8).flex().items_center().rounded(5).border_1().border_color(t.border).bg(t.background).text_size(12.5).text_color(t.muted).cursor_text().child("Reply…"))));
    }
    const reply = (r, k) => v_flex().id(`rv-crp-${c.key}-${k}`).ml(22).gap(1).pt(4)
      .child(h_flex().h(20).gap(6).items_center().text_size(11.5).child(avatar(r.author, r.src, 16)).child(div().font_semibold().child(r.author)).when(Boolean(r.status), (e) => e.child(pillC(r.status).id(`rv-crps-${c.key}-${k}`).tooltip(`What the reply reported: ${r.status[0]}`))))
      .child(div().pl(22).text_size(12.5).line_height(1.5).text_color(t.foreground).child(TextView.markdown(`rv-crm-${c.key}-${k}`, String(r.text ?? ""))));
    const last = it.k !== "th";
    return div().w_full().h(this.sizeOf(it)).pl(GUTTER).when(last, (e) => e.pb(CARD_GAP)).child(stripe(frame(v_flex()).h_full().px(12).pt(2).pb(8).overflow_hidden()
      .when(last, (e) => e.border_b(1).rounded_bl(8).rounded_br(8)).text_size(13.5)
      .child(div().line_height(1.48).text_color(t.foreground).child(TextView.markdown(`rv-cbm-${c.key}`, String(c.text ?? ""))))
      .children(c.replies.map(reply))));
  },

  // ---- the inline composer (a row of the diff list under the selection; edit: in place of that comment)

  openComposer(cx, edit = null, scroll = false) {
    if (edit) {
      const side = edit.old ? "-" : "+";
      this.editing = edit; this.fsel = { path: edit.file, a: `${side}${edit.start ?? edit.end}`, b: `${side}${edit.end}` };
      this.draft.set_value(edit.text);
    } else {
      this.ensureSel();
      if (!this.fsel) { this.note = "Select a line first (click its number; shift-click: a range)"; return cx.notify(); }
      if (this.editing) { this.editing = null; this.draft.set_value(""); }
    }
    this.composing = true; this.note = null; this.scrollCompose = scroll;
    cx.timer.after(0, (cx) => { this.draft.focus(); cx.notify(); }); // its row exists once the list drew it
    cx.notify();
  },

  closeComposer(cx) {
    this.composing = false; this.editing = null; this.composeMore = false; this.draft.set_value(""); this.fh.focus(); cx.notify();
  },

  // The composer's buttons, left to right: x from the list's left edge (clicks are placed by x, see onItem). The main
  // button adds to the pending review. Posting this one comment to GitHub at once is public and cannot be taken back,
  // so it waits behind the ▾ beside the main button (composeMore) instead of sitting next to it.
  composeButtons() {
    const now = this.routeNow() === "github" ? [["▾", 28, "toggleComposeMore"], ...(this.composeMore ? [["Post now to GitHub", 160, "singleComment"]] : [])] : [["Send to agent…", 160, "singleComment"]];
    const list = this.editing ? [["Suggestion", 104, "insertSuggestion"], ["Cancel", 80, "closeComposer"], ["Update comment", 140, "addDraft", true]]
      : [["Suggestion", 104, "insertSuggestion"], ["Cancel", 80, "closeComposer"], [this.comments.length ? "Add review comment" : "Start a review", 160, "addDraft", true], ...now];
    let x = GUTTER + 16; // the card's 4 px border and 12 px padding
    return list.map(([label, w, act, primary], i) => { const b = { label, w, act, primary, x: x + (i === 1 ? 24 : 0) }; x = b.x + w + (list[i + 1]?.[2] === "toggleComposeMore" ? 2 : BTN_GAP); return b; });
  },
  toggleComposeMore() { this.composeMore = !this.composeMore; },

  // A ```suggestion block with the selected lines, for GitHub's "Commit suggestion".
  insertSuggestion() {
    const f = this.fsel, rows = f && this.rowsFor(f.path), range = rows && rangeOf(rows, f.a, f.b);
    if (!range) return;
    const cur = this.draft.value();
    this.draft.set_value(`${cur}${cur && !cur.endsWith("\n") ? "\n" : ""}${suggestionBlock(rows.slice(range[0], range[1] + 1))}`);
    this.draft.focus();
  },

  // The composer's comment: its text with the selection as anchor (file, lines, side, quoted code); null when empty.
  draftComment() {
    const text = this.draft.value().trim(), anchor = this.selAnchor();
    if (!text) return null;
    if (!anchor) { this.note = "Select a line first (click its number; shift-click: a range)"; return null; }
    return { id: Date.now().toString(36), file: this.fsel.path, ...anchor, head: this.head, text };
  },

  // "Start a review" / "Add review comment" / "Update comment" (⌘↩): into the pending review.
  addDraft(cx) {
    if (this.editing) {
      const text = this.draft.value().trim();
      if (!text) return;
      this.comments = this.comments.map((c) => (c.id === this.editing.id ? { ...c, text } : c));
    } else {
      const c = this.draftComment();
      if (!c) return cx.notify();
      this.comments = [...this.comments, c];
    }
    this.fsel = null; this.closeComposer(cx); this.persist(cx);
  },

  // "Post now to GitHub" / "Send to agent…": this one comment alone, now. GitHub: one review comment at once; agent: the
  // preview first. Either way it then stays under its line as a thread; on failure it stays in the composer.
  singleComment(cx) {
    const c = this.draftComment(), key = this.threadKey();
    if (!c) return cx.notify();
    const done = (cx, how) => { this.updateThreads(cx, (d) => TH.addThreads(d, key, [c], how)); this.fsel = null; this.closeComposer(cx); };
    if (this.routeNow() === "github") { setShared("review.hintPostNow", true); return this.postSingleGh(c, cx, done); }
    const { label } = this.sendAgent();
    this.previewSend(cx, { what: "Comment", own: c.text, prompt: buildReview({ pr: this.pr, base: this.base, comments: [c], lang: this.lang(), replies: this.repliesFile(), contract: TH.repliesContract }),
      onSent: (cx) => done(cx, { route: "agent", agent: label }) });
  },

  // One line comment on GitHub now (POST pulls/{n}/comments), as the PR's context; dry run: the payload into a file.
  postSingleGh(c, cx, done) {
    const pr = this.prSel, m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(pr?.url ?? "");
    if (!m || this.sending) return;
    const payload = TH.singlePayload(c, this.head, inDiff(this.diffLines ?? new Map(), c));
    if (!payload) { this.note = "Not posted: GitHub takes line comments only on lines of the PR diff. Use Start a review: it goes into the review body."; return cx.notify(); }
    this.sending = true; this.note = null;
    const env = this.ctxEnv(this.ctxId()), sh = (script, ...args) => exec(env[0] ?? "sh", [...env.slice(1), ...(env.length ? ["sh"] : []), "-c", script, ...args], { timeout: 60000 });
    cx.spawn(async (cx) => {
      try {
        if (this.cfg?.dryRun) {
          const file = `${appHome()}/pr-data/review-dry-run.json`, before = await readTextFile(file).catch(() => null);
          await writeTextFile(file, JSON.stringify({ endpoint: `repos/${m[1]}/pulls/${m[2]}/comments`, payload }, null, 1), before);
          this.note = `Dry run: nothing posted, the payload is in ${file.replace(home(), "~")}`;
          return done(cx, { route: "github", dry: true });
        }
        const r = await sh('printf %s "$1" | gh api -X POST "$0" --input -', `repos/${m[1]}/pulls/${m[2]}/comments`, JSON.stringify(payload));
        if (r.code !== 0) { let msg = (r.stderr || "").trim(); try { msg = JSON.parse(r.stdout).message ?? msg; } catch { /* not JSON */ } throw new Error(msg || "gh api failed"); }
        const j = JSON.parse(r.stdout);
        this.note = `Posted to GitHub: ${j.html_url ?? pr.url}`;
        done(cx, { route: "github", gh: { [c.id]: { ghId: j.id, url: j.html_url } } });
        this.loadGhComments(cx);
      } catch (e) { this.note = `Not posted: ${String(e).replace(/^Error: /, "")}`; } // the composer keeps the draft
      finally { this.sending = false; cx.notify(); }
    });
    cx.notify();
  },

  // ---- where reviews go: GitHub (any PR there) or the PR's agent session (a PR made in a session; branch diffs)

  routes() {
    const gh = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(this.prSel?.url ?? "");
    return [...(gh ? ["github"] : []), ...(this.prSel?.session || !gh ? ["agent"] : [])];
  },
  routeNow() {
    const all = this.routes();
    return all.includes(this.route) ? this.route : all.includes("agent") && this.prSel?.session ? "agent" : all[0];
  },

  // Submit review (the popover): every pending comment, the verdict and the summary, in one go.
  // GitHub: exactly the ticked items (threads.js ghPlan); agent: every pending comment, through the preview. What went
  // out stays as threads.
  submitReview(cx) {
    const gh = this.routeNow() === "github", key = this.threadKey(), summary = this.summary.value();
    const sent = gh ? this.ghPlanNow().picked : TH.withIds(this.comments);
    const done = (cx, how) => {
      const ids = new Set(sent.map((c) => c.id));
      this.comments = TH.withIds(this.comments).filter((c) => !ids.has(c.id)); this.summary.set_value(""); this.event = null; this.off = new Set(); this.summaryOn = true;
      this.updateThreads(cx, (d) => TH.addThreads(d, key, sent, how));
      this.persist(cx); this.registerReview(cx, { status: "sent", sentAt: Date.now() });
    };
    const event = this.verdict();
    if (!event) { this.note = "Not sent: choose Comment, Approve or Request changes first"; return cx.notify(); }
    if (gh) return this.postGh(sent, event, this.summaryOn ? summary : "", cx, done);
    if (!sent.length) { this.note = "Nothing to send: add a comment first"; return cx.notify(); }
    const { label } = this.sendAgent();
    this.previewSend(cx, { what: "Review", own: [summary.trim(), ...sent.map((c) => `${c.file} ${uiLine(c)}: ${c.text}`)].filter(Boolean).join("\n\n"),
      prompt: buildReview({ pr: this.pr, base: this.base, comments: sent, lang: this.lang(), event, summary, replies: this.repliesFile(), contract: TH.repliesContract }),
      onSent: (cx) => done(cx, { route: "agent", agent: label }) });
  },
  // The gh login that posts for this PR's context (its env picks the account), asked once per context.
  loadGhLogin(cx) {
    const id = this.ctxId();
    if (this.ghLogin?.[id] !== undefined) return;
    this.ghLogin = { ...this.ghLogin, [id]: null };
    const argv = [...this.ctxEnv(id), "gh", "api", "user", "--jq", ".login"];
    cx.spawn(async (cx) => {
      const r = await exec(argv[0], argv.slice(1), { timeout: 20000 }).catch(() => null);
      if (r?.code === 0 && r.stdout.trim()) { this.ghLogin = { ...this.ghLogin, [id]: r.stdout.trim() }; cx.notify(); }
    });
  },
  ghPlanNow() {
    const repo = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(this.prSel?.url ?? "");
    return TH.ghPlan({ comments: this.comments, off: this.off, summary: this.summary.value(), summaryOn: this.summaryOn, event: this.verdict(), commit: this.head,
      lines: this.diffLines ?? new Map(), repo: repo ? `${repo[1]}#${repo[2]}` : null, login: this.ghLogin?.[this.ctxId()] ?? null });
  },

  // One GitHub review with these comments (pr.js ghReview), JSON on stdin, as the PR's context (its gh account).
  // Config "dryRun": true writes the payload to pr-data/review-dry-run.json instead of posting.
  postGh(comments, event, summary, cx, done) {
    const pr = this.prSel, m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(pr?.url ?? "");
    if (!m || this.sending) return;
    this.sending = true; this.note = null; this.posted = null;
    const env = this.ctxEnv(this.ctxId()), sh = (script, ...args) => exec(env[0] ?? "sh", [...env.slice(1), ...(env.length ? ["sh"] : []), "-c", script, ...args], { timeout: 60000 });
    cx.spawn(async (cx) => {
      try {
        if (!this.head) {
          const v = await sh('gh pr view "$0" --json headRefOid --jq .headRefOid', pr.url);
          if (v.code !== 0 || !v.stdout.trim()) throw new Error("PR head unknown");
          this.head = v.stdout.trim();
        }
        const { payload, outside } = ghReview({ comments, event, summary, commit: this.head, lines: this.diffLines ?? new Map() });
        if (!payload.comments.length && !payload.body && payload.event !== "APPROVE") throw new Error("Nothing to post: add a comment or a summary");
        if (this.cfg?.dryRun) {
          const file = `${appHome()}/pr-data/review-dry-run.json`, before = await readTextFile(file).catch(() => null);
          await writeTextFile(file, JSON.stringify({ endpoint: `repos/${m[1]}/pulls/${m[2]}/reviews`, payload }, null, 1), before);
          this.posted = { dry: file, outside: outside.length, items: TH.postedItems(payload) };
          this.note = `Dry run: nothing posted, the payload is in ${file.replace(home(), "~")}`;
          return done(cx, { route: "github", dry: true });
        }
        const r = await sh('printf %s "$1" | gh api -X POST "$0" --input -', `repos/${m[1]}/pulls/${m[2]}/reviews`, JSON.stringify(payload));
        if (r.code !== 0) {
          let msg = (r.stderr || "").trim();
          try { const j = JSON.parse(r.stdout); msg = [j.message, ...(j.errors ?? []).map((e) => (typeof e === "string" ? e : e.message ?? JSON.stringify(e)))].filter(Boolean).join(": "); } catch { /* not JSON */ }
          const where = payload.comments.map((c) => `${c.path}:${c.start_line ? `${c.start_line}–` : ""}${c.line}`).join(", ");
          throw new Error(`${msg || "gh api failed"}${/diff|line|position/i.test(msg) && where ? ` (line comments: ${where})` : ""}`);
        }
        const review = JSON.parse(r.stdout), url = review.html_url ?? pr.url;
        // The posted line comments' ids (by path, line and text), so their GitHub replies land in their threads.
        const mine = review.id ? await sh('gh api "$0" --jq ".[] | {id, path, line, body, url: .html_url}"', `repos/${m[1]}/pulls/${m[2]}/reviews/${review.id}/comments`).catch(() => null) : null;
        const got = (mine?.stdout ?? "").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean), map = {};
        for (const c of TH.withIds(comments)) { const g = got.find((x) => x.path === c.file && x.line === c.end && x.body === c.text.trim()); if (g) map[c.id] = { ghId: g.id, url: g.url }; }
        this.posted = { url, items: TH.postedItems(payload) }; this.note = `Review posted: ${url}`;
        done(cx, { route: "github", gh: map });
        this.loadGhComments(cx);
      } catch (e) { this.note = `Not posted: ${String(e).replace(/^Error: /, "")}`; }
      finally { this.sending = false; cx.notify(); }
    });
    cx.notify();
  },

  // GitHub's review comments on this PR, under their lines (read only). Outdated ones (no line now, GitHub's "Outdated")
  // stay and show like other comments whose line is gone. One GraphQL call adds each thread's resolved state; when it
  // fails the comments still show, just none as resolved.
  loadGhComments(cx) {
    const pr = this.prSel, m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(pr?.url ?? "");
    if (!m || this.cfg?.dryRun) return; // dry run: no network (the demo)
    const env = this.ctxEnv(this.ctxId()), [owner, name] = m[1].split("/");
    const rest = [...env, "gh", "api", "--paginate", `repos/${m[1]}/pulls/${m[2]}/comments?per_page=100`,
      "--jq", ".[] | {id, path, line, original_line, side, user: .user.login, user_type: .user.type, commit_id, original_commit_id, outdated: (.line == null and .subject_type != \"file\"), body, at: .created_at, in_reply_to_id, url: .html_url}"];
    const query = "query($owner: String!, $name: String!, $number: Int!, $endCursor: String) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { " +
      "reviewThreads(first: 100, after: $endCursor) { pageInfo { hasNextPage endCursor } nodes { isResolved isOutdated comments(first: 1) { nodes { databaseId } } } } } } }";
    const graph = [...env, "gh", "api", "graphql", "--paginate", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${m[2]}`,
      "--jq", ".data.repository.pullRequest.reviewThreads.nodes[] | {id: .comments.nodes[0].databaseId, resolved: .isResolved, outdated: .isOutdated}"];
    const lines = (r) => (r?.code === 0 ? r.stdout.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : null);
    cx.spawn(async (cx) => {
      const [r, t] = await Promise.all([rest, graph].map((a) => exec(a[0], a.slice(1), { timeout: 30000 }).catch(() => null)));
      if (r?.code !== 0 || this.prSel?.url !== pr.url) return;
      this.gh = TH.withThreadState(lines(r), lines(t) ?? []);
      cx.notify();
    });
  },
  // GitHub's comments as the review shows them (threads.js ghShown), memoized: the Show switch's resolved and bots.
  ghNow() {
    const deps = [this.gh, this.showResolved, this.allBots];
    if (!this.ghOf || this.ghOf.deps.some((d, i) => d !== deps[i])) this.ghOf = { deps, ...TH.ghShown(this.gh, { resolved: this.showResolved, allBots: this.allBots }) };
    return this.ghOf;
  },

  onReviewKey(e, cx) {
    const route = keyRoute({ typing: this.typing, rootFocused: this.fh.is_focused(), key: e.key });
    if (route === "pass") return; // an input inside the review has the keyboard: its letters are text
    if (route === "blur") { this.fh.focus(); cx.notify(); return cx.stop_propagation(); }
    if (route === "typing") {
      if (this.typing === "draft" && e.keystroke === "cmd-enter") this.addDraft(cx);
      else if (e.key === "escape" && this.typing === "send") { this.sendP = null; this.fh.focus(); cx.notify(); }
      else if (e.key === "escape" && this.typing === "item") { this.editItem = null; this.fh.focus(); cx.notify(); }
      else if (e.key === "escape" && this.typing === "summary") { this.finishOpen = false; this.fh.focus(); cx.notify(); }
      else if (e.key === "escape") this.closeComposer(cx);
      else return;
      return cx.stop_propagation();
    }
    const k = e.keystroke;
    if (k === "j" || k === "k") {
      const d = k === "j" ? 1 : -1;
      if (this.tab === "steps") this.goStep(this.cur + d, cx); else this.goFile(d);
    }
    else if (k === "n" || k === "p") this.goHunk(k === "n" ? 1 : -1, cx);
    else if (k === "c") this.openComposer(cx, null, true);
    else if (k === "shift-/" || e.key === "?") this.command("keys", cx);
    else if (k === "a" || k === "x") { const s = this.openSugs().find((x) => x.key === this.sug); if (s) (k === "a" ? this.takeSug(s, cx) : this.dropSug(s, cx)); } // only the note that is open: its line says so
    else if (k === "s" || k === "f") this.tab = k === "s" ? "steps" : "files";
    else if (k === "escape") { if (this.sendP) this.sendP = null; else if (this.replyTo) this.replyTo = null; else if (this.selected().length) this.clearSel(cx); else if (this.finishOpen) this.finishOpen = false; else if (this.composing) this.closeComposer(cx); else if (this.defFile) this.defFile = null; else if (this.defAt) this.defAt = null; else if (this.drawerState() === "open") this.setDrawer(null, cx); else if (this.archFocus || this.blastFocus || this.askHl) this.archFocus = this.blastFocus = this.askHl = null; else leave(); }
    else return;
    cx.stop_propagation(); cx.notify();
  },

  // The submit button. An approval while a finding of high severity is unresolved is asked about once: the first
  // click only says what is open, the second one submits.
  // The verdict in force (threads.js verdictOf): null while a high finding is unresolved and nothing is picked.
  verdict() { return TH.verdictOf(this.event, this.counts()); },
  submitClick(cx) {
    if (this.event === "approve" && this.counts().high > 0 && !this.approveAsk) { this.approveAsk = true; return cx.notify(); }
    this.approveAsk = false;
    this.submitReview(cx);
  },
  // "Insert blockers": the unresolved findings of high severity as the review's text, under what is written already.
  insertBlockers() {
    const draft = TH.blockersDraft(this.openFindings()), now = this.summary.value().trim();
    if (draft && !now.includes(draft)) this.summary.set_value([now, draft].filter(Boolean).join("\n\n"));
  },

  // ---- render: Finish your review (opened from the bar's button: the "finish" command)

  finishPopover(t) {
    const all = TH.withIds(this.comments), n = all.length, routes = this.routes(), route = this.routeNow(), gh = route === "github";
    const plan = gh ? this.ghPlanNow() : null, inline = new Set((plan?.picked ?? []).filter((c) => inDiff(this.diffLines ?? new Map(), c)).map((c) => c.id));
    const label = { comment: "Comment", approve: "Approve", request_changes: "Request changes" };
    // What the review found, next to what is about to go out: the findings suggest a verdict (threads.js
    // suggestVerdict) and never pick it; an approval over unresolved high findings is asked about once (submitClick).
    const fc = this.counts(), sug = TH.suggestVerdict(fc), ev = this.verdict(), risky = ev === "approve" && fc.high > 0;
    const radio = (k, what) => h_flex().id(`rv-ev-${k}`).gap(10).px(6).py(4).rounded(6).items_start().cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.event = k; this.approveAsk = false; cx.notify(); })
      .child(div().w(16).flex_none().text_color(ev === k ? t.accent : t.muted).child(ev === k ? "◉" : "○"))
      .child(v_flex().flex_1().min_w(0).child(h_flex().gap(8).items_center().child(div().font_semibold().child(label[k]))
        .when(sug?.event === k, (e) => e.child(div().id(`rv-ev-sug-${k}`).tooltip("A suggestion from the findings, which are a model's claims. The choice is yours.").text_size(12).text_color(t.ansi3).child(`Suggested: ${sug.why}`))))
        .child(div().text_size(12).text_color(t.muted).whitespace_normal().child(what)));
    const tick = (id, on, click) => tickBox(t, on).id(id).tooltip("Tick to include this in what is posted, untick to leave it out").accessibility_label("Include in review").mt(1).cursor_pointer().on_click((_e, cx) => { click(); cx.notify(); });
    const origin = (c) => (c.from === "ki" ? "from an AI suggestion" : c.from ? `from a finding (${REVIEWERS[c.from]?.[0] ?? c.from})` : null);
    // Each item that can go out, ticked or not; GitHub: the summary too, and Edit in place.
    const item = (c) => {
      const on = !gh || !this.off.has(c.id), editing = this.editItem === c.id;
      return h_flex().id(`rv-fi-${c.id}`).gap(8).items_start().p(6).rounded(6).bg(on ? t.surface : t.background)
        .when(gh, (e) => e.child(tick(`rv-fit-${c.id}`, on, () => { if (on) this.off.add(c.id); else this.off.delete(c.id); })))
        .child(v_flex().id(`rv-fir-${c.id}`).flex_1().min_w(0).gap(3).when(gh && !editing, (e) => e.cursor_pointer().on_click((_e, cx) => { if (on) this.off.add(c.id); else this.off.delete(c.id); cx.notify(); }))
          .child(h_flex().gap(6).items_center().text_size(12)
            .child(div().flex_1().min_w(0).truncate().font_semibold().text_color(on ? t.foreground : t.muted).child(`${c.file} ${uiLine(c)}`))
            .when(gh, (e) => e.child(div().flex_none().text_color(inline.has(c.id) || !on ? t.muted : t.ansi3).child(inDiff(this.diffLines ?? new Map(), c) ? "line comment" : "goes into the body")))
            .when(!editing, (e) => e.child(pill(`rv-fie-${c.id}`, t, "Edit", (_e, cx) => { this.editItem = c.id; this.itemEdit.set_value(c.text); cx.timer.after(0, () => this.itemEdit.focus()); cx.stop_propagation(); cx.notify(); }).tooltip("Edit the text before it is posted"))))
          .when(Boolean(origin(c)), (e) => e.child(div().text_size(11.5).text_color(t.ansi5).child(origin(c))))
          .when(gh && on && Boolean(c.security), (e) => e.child(div().id(`rv-fi-pub-${c.id}`).text_size(12).line_height(1.4).whitespace_normal().text_color(t.ansi1).child(PUBLIC_TIP)))
          .child(editing
            ? v_flex().gap(6).child(div().h(90).px(8).py(4).rounded(6).border_1().border_color(t.accent).bg(t.background).cursor_text().on_click(() => this.itemEdit.focus())
              .child(Textarea.new(this.itemEdit).size_full().text_size(13).text_color(t.foreground)))
              .child(h_flex().gap(6).child(pill(`rv-fis-${c.id}`, t, "Save", (_e, cx) => { const text = this.itemEdit.value().trim(); if (text) { this.comments = all.map((x) => (x.id === c.id ? { ...x, text } : x)); this.persist(cx); } this.editItem = null; cx.notify(); }, false, t.foreground).tooltip("Keep the edited text"))
                .child(pill(`rv-fic-${c.id}`, t, "Cancel", (_e, cx) => { this.editItem = null; cx.notify(); }).tooltip("Discard the edit")))
            : div().text_size(12.5).line_height(1.45).text_color(on ? t.foreground : t.muted).child(TextView.markdown(`rv-fim-${c.id}`, c.text))));
    };
    const summary = this.summary.value().trim(), repo = plan ? /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(this.prSel?.url ?? "") : null;
    const ready = !this.sending && Boolean(ev) && (gh ? plan.ready : n > 0);
    return v_flex().id("rv-finish").absolute().top(8).right(12).w(520).max_h(760).p(14).gap(10).rounded(10).border_1().border_color(t.border).bg(t.popover).shadow_lg()
      .text_size(13).text_color(t.foreground).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(h_flex().gap(8).items_center().child(div().font_semibold().text_size(14).child("Finish your review"))
        .when(Boolean(this.cfg?.dryRun), (e) => e.child(badge(t, "Dry run", t.ansi3).id("rv-finish-dry").tooltip(DRY_TIP))).child(div().flex_1())
        .child(pill("rv-finish-x", t, "✕", (_e, cx) => { this.finishOpen = false; this.fh.focus(); cx.notify(); }).tooltip("Close without sending anything").accessibility_label("Close")))
      .when(routes.length > 1, (e) => e.child(h_flex().gap(6).items_center().child(div().text_size(12).text_color(t.muted).child("Send to"))
        .child(pill("rv-route-github", t, "GitHub", (_e, cx) => { this.route = "github"; cx.notify(); }, route === "github").tooltip("Post these as one GitHub review"))
        .child(pill("rv-route-agent", t, "Agent session", (_e, cx) => { this.route = "agent"; cx.notify(); }, route === "agent").tooltip("Send these as a prompt to the PR's agent session instead"))))
      .child(div().text_size(12.5).text_color(t.muted).child(gh ? `Target: ${repo ? `${repo[1]}#${repo[2]}` : "GitHub"} on GitHub` : `Target: ${this.sendAgent().label}`))
      .child(div().id("rv-summary").tooltip("The review's summary: posted as the review body").h(76).px(10).py(6).rounded(6).border_1().border_color(this.typing === "summary" ? t.accent : t.border).bg(t.background).cursor_text()
        .on_click(() => this.summary.focus()).child(Textarea.new(this.summary).size_full().text_size(13.5).text_color(t.foreground)))
      .when(fc.unresolved > 0, (e) => e.child(h_flex().id("rv-finish-found").gap(8).items_center().text_size(12.5)
        .child(div().flex_1().min_w(0).whitespace_normal().text_color(t.muted).child(`${fc.unresolved} unresolved ${fc.unresolved === 1 ? "finding is" : "findings are"} not part of this review${fc.high ? `, ${fc.high} of high severity` : ""}.`))
        .when(fc.high > 0, (x) => x.child(pill("rv-blockers", t, "Insert blockers", (_e, cx) => { this.insertBlockers(); cx.notify(); }).flex_none()
          .tooltip("Put the unresolved findings of high severity into the text above, to edit. A security finding goes in with its title only.")))
        .when(typeof this.copyState === "function", (x) => x.child(pill("rv-copy-state", t, "Copy review state", (_e, cx) => { this.copyState(); cx.notify(); }).flex_none()
          .tooltip("Copy the verdict, the task check and the findings by state as text for a colleague. Nothing is posted; security findings are in it with their title only.")))))
      .child(v_flex().gap(1)
        .child(radio("comment", "Submit general feedback without explicit approval."))
        .child(radio("approve", "Give your approval to merge these changes."))
        .child(radio("request_changes", "Submit feedback that must be addressed before merging.")))
      .when(risky, (e) => e.child(div().id("rv-approve-ask").p(8).rounded(6).bg(t.ansi1 + "1c").text_size(12.5).line_height(1.45).whitespace_normal()
        .child(`${fc.high} unresolved ${fc.high === 1 ? "finding is" : "findings are"} of high severity${fc.security ? `, ${fc.security} about security` : ""}. An approval on GitHub says nothing about them.${this.approveAsk ? " Click the button again to approve anyway." : ""}`)))
      // Exactly what goes out: nothing else (AI suggestions, findings, the analysis) unless it was added as a comment.
      .child(div().text_size(11.5).font_semibold().text_color(t.muted).child(gh ? "WHAT IS POSTED (only what is ticked)" : `WHAT IS SENT · ${n} ${n === 1 ? "comment" : "comments"}`))
      .child(div().flex_1().min_h(0).relative().max_h(250)
        .child(v_flex().id("rv-finish-items").gap(4).max_h(250).overflow_y_scroll()
          .when(gh && Boolean(summary), (e) => e.child(h_flex().id("rv-fi-summary").gap(8).items_start().p(6).rounded(6).bg(this.summaryOn ? t.surface : t.background)
            .child(tick("rv-fit-summary", this.summaryOn, () => { this.summaryOn = !this.summaryOn; }))
            .child(v_flex().id("rv-fir-summary").flex_1().min_w(0).gap(2).cursor_pointer().on_click((_e, cx) => { this.summaryOn = !this.summaryOn; cx.notify(); })
              .child(div().text_size(12).font_semibold().text_color(this.summaryOn ? t.foreground : t.muted).child("Review body (your text in the box above)"))
              .child(div().text_size(12.5).whitespace_normal().text_color(this.summaryOn ? t.foreground : t.muted).child(summary.length > 160 ? `${summary.slice(0, 160)}… (${summary.split("\n").length} lines)` : summary)))))
          .children(all.map(item))
          .when(!n, (e) => e.child(div().p(6).text_size(12.5).text_color(t.muted).child("No pending comments. AI suggestions and findings go out only after you add them as comments.")))))
      .when(Boolean(this.posted?.url || this.posted?.dry), (e) => e.child(v_flex().gap(2).p(8).rounded(6).bg(t.surface).text_size(12)
        .child(h_flex().gap(8).items_center().text_color(this.posted.dry ? t.muted : t.ansi2)
          .child(div().flex_1().min_w(0).truncate().child(this.posted.dry ? "Dry run: this is what would have been posted" : `Posted: ${this.posted.url}`))
          .when(Boolean(this.posted.url), (x) => x.child(pill("rv-posted-open", t, "Show on GitHub", () => openUrl(this.posted.url)).tooltip("Show the posted review on GitHub"))))
        .children((this.posted.items ?? []).map((w) => div().truncate().text_color(t.muted).child(`· ${w}`)))))
      .when(Boolean(this.note) && /^(Not posted|Not sent|Dry run|Nothing)/.test(this.note ?? ""), (e) => e.child(div().text_size(12).whitespace_normal()
        .text_color(/^Dry run/.test(this.note) ? t.muted : t.ansi1).child(this.note)))
      .when(gh, (e) => e.child(div().text_size(12.5).text_color(t.muted).whitespace_normal().text_right().child(plan.target)))
      .child(h_flex().gap(8).items_center()
        .when(n > 0 && !this.discardAsk, (e) => e.child(pill("rv-rdrop", t, `Discard ${n} pending ${n === 1 ? "comment" : "comments"}…`, (_e, cx) => { this.discardAsk = true; cx.notify(); }, false, t.ansi1).tooltip("Delete your pending comments on this PR; asks first")))
        .when(n > 0 && Boolean(this.discardAsk), (e) => e.child(div().text_size(12.5).text_color(t.ansi1).child(`Delete ${n === 1 ? "this comment" : `these ${n} comments`} for good?`))
          .child(pill("rv-rdrop-yes", t, "Delete", (_e, cx) => { this.comments = []; this.discardAsk = false; this.persist(cx); cx.notify(); }, false, t.ansi1).tooltip("Delete them now; this cannot be undone"))
          .child(pill("rv-rdrop-no", t, "Keep", (_e, cx) => { this.discardAsk = false; cx.notify(); }).tooltip("Keep your pending comments")))
        .child(div().flex_1())
        .when(!this.discardAsk, (e) => e.child(div().id("rv-submit").tooltip(this.cfg?.dryRun && gh ? DRY_TIP : "Sends only what is listed above, to the target shown; nothing leaves before this click").px(14).h(32).flex().items_center().rounded(8).text_size(13).font_semibold().bg(ready ? GH_GREEN : t.raised)
          .text_color(ready ? "#ffffff" : t.muted).when(ready, (e) => e.cursor_pointer())
          .on_click((_e, cx) => { if (ready) this.submitClick(cx); }).child(this.sending ? "Submitting…" : !ev ? "Choose a verdict first" : risky && this.approveAsk ? "Approve anyway" : gh ? plan.label : "Send to agent…"))));
  },

  // The preview before an agent starts or anything is typed into a session: what it is about (the finding or the
  // reviewer's words), who gets it (a fix: the choice between a sub-agent and the PR's agent, each with what separates
  // it from the PR), the facts (threads.js sendFacts: account, what it gets, what it may do, push, result, cost) and
  // the exact text, editable. Only the button at the bottom sends.
  sendPopover(t) {
    const p = this.sendP, fix = p.fix, sub = fix?.target === "sub", kind = fix ? fix.target : p.ask?.kind ?? null, short = (x) => (x ? String(x).replace(home(), "~") : null);
    const live = this.sendAgent().agent, name = live ? p.agent.split(" · ")[0] : null;
    const facts = kind ? TH.sendFacts({ kind, account: accountOf(this.ctxId()), trusted: this.trustedPr(), branch: fix?.branch, name: p.ask?.name ?? name, chat: p.ask?.chat, where: short(p.ask?.where), model: modelLabel(model()) }) : [];
    const picking = Boolean(fix?.pool), n = fix?.items.length ?? 0, some = !picking || n > 0, ready = !this.sending && some, text = this.sendText.value();
    const go = this.sending ? "Sending…" : sub ? (picking && n ? `Start fix agent for ${n} ${n === 1 ? "finding" : "findings"}` : "Start fix agent") : fix ? "Send to main agent"
      : p.ask ? { new: "Start agent", resume: "Resume its session", live: p.ask.chat ? "Draft in chat" : "Paste to agent" }[p.ask.kind] : "Send to agent";
    const head = (label) => div().text_size(11.5).font_semibold().text_color(t.muted).child(label);
    const choice = (k, title, what) => h_flex().id(`rv-fix-${k}`).gap(10).px(6).py(4).rounded(6).items_start().cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.fixTarget(k); cx.notify(); })
      .child(div().w(16).flex_none().text_color(fix.target === k ? t.accent : t.muted).child(fix.target === k ? "◉" : "○"))
      .child(v_flex().flex_1().min_w(0).child(div().font_semibold().child(title)).child(div().text_size(12).line_height(1.45).text_color(t.muted).whitespace_normal().child(what)));
    const picked = new Set((fix?.items ?? []).map((x) => x.id));
    return v_flex().id("rv-send").absolute().top(8).right(12).w(640).max_h_full().overflow_y_scroll().p(14).gap(10).rounded(10).border_1().border_color(t.border).bg(t.popover).shadow_lg()
      .text_size(13).text_color(t.foreground).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(h_flex().items_center().child(div().flex_1().font_semibold().text_size(14).child(fix || p.ask ? `${p.what}: preview` : `${p.what}: send to agent`))
        .child(pill("rv-send-x", t, "✕", (_e, cx) => { this.sendP = null; this.fh.focus(); cx.notify(); }).tooltip("Close the preview without sending").accessibility_label("Close")))
      // "Fix several…": the reviewer ticks what one agent fixes together; nothing is ticked for them.
      .when(picking, (e) => e.child(v_flex().gap(4).child(head(`FINDINGS · tick the ones one agent should fix together · ${n} of ${fix.pool.length} ticked`))
        .child(v_flex().id("rv-fix-pool").max_h(178).overflow_y_scroll().gap(1).children(fix.pool.map((f) => h_flex().id(`rv-fxp-${f.id}`).h(26).flex_none().px(6).gap(8).items_center().rounded(6).cursor_pointer()
          .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.fixPick(f.id, cx)).child(tickBox(t, picked.has(f.id)))
          .child(div().w(52).flex_none().text_size(12).text_color(t[SEV[f.severity]] ?? t.muted).child(f.severity)).child(div().flex_1().min_w(0).truncate().child(f.title))
          .child(div().flex_none().text_size(12).text_color(t.muted).child(`${f.file.split("/").pop()}:${f.line}`)))))
        .when(fix.alone > 0, (x) => x.child(div().text_size(12).line_height(1.45).text_color(t.muted).whitespace_normal()
          .child(`${fix.alone} security ${fix.alone === 1 ? "finding is" : "findings are"} not in this list. Each is fixed on its own, so that its change stays one commit to check.`)))))
      .when(!picking && Boolean(p.own), (e) => e.child(v_flex().gap(4).child(head(p.ownLabel))
        .child(div().max_h(110).overflow_hidden().p(8).rounded(6).border_l(3).border_color(t.accent).bg(t.surface).text_size(12.5).line_height(1.45).whitespace_normal().child(p.own))))
      .when(Boolean(fix) && some, (e) => e.child(v_flex().gap(1).child(head("WHO FIXES IT"))
        .child(choice("sub", "Sub-agent", `A new agent in a separate checkout, on the new branch ${fix.branch} from ${this.worktree?.local ? "this branch's head" : "the PR head"}${fix.head ? ` ${fix.head.slice(0, 7)}` : ""}. It works apart from the PR's checkout and hands its fix to nobody: nothing reaches the PR until you apply it.`))
        .when(this.mainOffered(), (x) => x.child(choice("main", "Main agent", `${name}, the PR's own agent session. It changes the PR's checkout directly, with its own permissions; nothing separates the fix from the PR.`)))
        .when(!this.mainOffered(), (x) => x.child(div().pl(32).text_size(12).text_color(t.dim).whitespace_normal()
          .child(`The PR's own agent is not offered: ${this.trustedPr() ? "this PR has no live agent session" : "this is someone else's PR, so its code is only changed in a separate checkout"}.`)))))
      .when(!kind, (e) => e.child(h_flex().gap(6).items_center().text_size(12.5).child(div().text_color(t.muted).child("To")).child(div().flex_1().min_w(0).whitespace_normal().font_semibold().child(p.agent))))
      .when(facts.length > 0 && some, (e) => e.child(v_flex().id("rv-send-facts").p(8).gap(3).rounded(6).border_1().border_color(t.border)
        .children(facts.map(([label, what]) => h_flex().gap(8).items_start().text_size(12.5).line_height(1.45)
          .child(div().w(58).flex_none().text_color(t.muted).child(label)).child(div().flex_1().min_w(0).whitespace_normal().child(what))))))
      .when(some, (e) => e.child(head(`EXACT TEXT SENT · ${text.split("\n").length} lines, editable${text.length > 700 || text.split("\n").length > 11 ? " · longer than the box: scroll inside it to read the end" : ""}`))
        .child(div().id("rv-send-text").tooltip("The exact text the agent gets; you can edit it").px(10).py(6).rounded(6).border_1().border_color(this.typing === "send" ? t.accent : t.border).bg(t.background).cursor_text()
          .on_click(() => this.sendText.focus()).child(Textarea.new(this.sendText).w_full().text_size(12.5).text_color(t.foreground))))
      .child(h_flex().gap(8).items_center().child(div().flex_1())
        .child(pill("rv-send-cancel", t, "Cancel", (_e, cx) => { this.sendP = null; this.fh.focus(); cx.notify(); }).tooltip("Close the preview without sending"))
        .child(div().id("rv-send-go").tooltip(picking && !n ? "Tick at least one finding first" : "The only click that sends or starts anything").px(14).h(32).flex().items_center().rounded(8).text_size(13).font_semibold()
          .bg(ready ? t.solid : t.raised).text_color(ready ? t.solid_foreground : t.muted).when(ready, (x) => x.cursor_pointer())
          .on_click((_e, cx) => { if (ready) this.sendConfirmed(cx); }).child(go)));
  },

  // ---- the Comments tab and the Show switch (shared "review.show": per user, all on by default)

  show() { return TH.showOf(shared("review.show")); },
  toggleShow(k) { setShared("review.show", { ...this.show(), [k]: !this.show()[k] }); },
  // Every comment of the PR as rows (threads.js commentRows), memoized on what they come from.
  commentRowsNow() {
    const gh = this.ghNow().list, stale = this.staleNow(), deps = [this.comments, this.threadDoc, this.replies, gh, this.deep.pins, this.prSel?.url, stale];
    if (!this.rowsOf || this.rowsOf.deps.some((d, i) => d !== deps[i])) {
      // Your own posted threads keep all their GitHub replies; the rest is what the Show switch lets through.
      const own = this.ghOwn();
      this.rowsOf = { deps, rows: TH.commentRows({ pending: this.comments ?? [], threads: this.threads(), replies: this.replies, gh: [...this.gh.filter(own), ...gh.filter((g) => !own(g))],
        ghOwn: own, notes: this.pins(), stale: (id) => stale.has(id) }) };
    }
    return this.rowsOf.rows;
  },
  // Your comments and notes whose lines changed since you wrote them (pr.js isStale), by id; memoized, since the
  // cards ask on every render. Only ones that recorded their lines (new since this check) can be marked.
  staleNow() {
    const deps = [this.comments, this.threadDoc, this.deep.pins, this.fileHunks, this.head, this.prSel?.url];
    if (!this.staleOf || this.staleOf.deps.some((d, i) => d !== deps[i])) {
      const ids = new Set(), check = (id, a) => { if (a?.code != null && a.file && isStale(a, this.head, codeOf(this.rowsFor(a.file, true), a))) ids.add(id); };
      for (const c of TH.withIds(this.comments ?? [])) check(c.id, c);
      for (const th of this.threads()) check(th.id, th);
      for (const p of this.pins()) check(p.id, p.anchor);
      this.staleOf = { deps, ids };
    }
    return this.staleOf.ids;
  },
  showCountsNow() {
    const agents = Object.values(this.replies ?? {}).reduce((n, r) => n + r.length, 0);
    return TH.showCounts({ rows: this.commentRowsNow(), findings: this.counts().unresolved, agents });
  },
  // The one filter for what sits under the diff's lines and in the Comments list, as chips with counts (the bar only).
  // Findings carries the Findings tab's number, or says whether anything has looked for findings yet; a kind of
  // comment with nothing in it has no chip. Resolved GitHub threads (off by default) get a chip of their own while
  // there are any; older bot comments a muted line that shows them all.
  showChips(t, id) {
    const show = this.show(), counts = this.showCountsNow(), g = this.ghNow();
    const sw = (k, on, label, n, tip, click) => div().id(`${id}-${k}`).tooltip(tip).px(10).h(24).flex().items_center().gap(5).rounded(12).border_1().cursor_pointer().text_size(12)
      .border_color(on ? t[SOURCE[k]] ?? t.accent : t.border).text_color(on ? t.foreground : t.dim).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { click(); cx.notify(); }).child(label).when(n !== null, (e) => e.child(div().text_color(t.muted).child(String(n ?? 0))));
    const looked = Boolean(this.ai) || Object.values(this.find.runs).some((r) => r.state === "done");
    const label = (k, l) => (k === "ai" && !this.findings().length ? (looked ? "Findings: none" : "Findings: not run") : l);
    return h_flex().flex_none().gap(6).items_center().child(div().text_size(12.5).text_color(t.muted).child("Show"))
      .children(TH.SHOW_KINDS.filter(([k]) => k === "ai" || counts[k] > 0).map(([k, l]) => sw(k, show[k], label(k, l), k === "ai" && !this.findings().length ? null : counts[k], `${SHOW_TIP[k]}: click to hide or show them in the diff`, () => this.toggleShow(k))))
      .when(g.resolved > 0, (e) => e.child(sw("resolved", this.showResolved, "Resolved", g.resolved, "GitHub threads marked resolved: hidden by default, click to show or hide them", () => { this.showResolved = !this.showResolved; })))
      .when(g.botsHidden > 0, (e) => e.child(div().id(`${id}-bots`).tooltip(this.allBots ? "Show only each bot's comments on the commit it reviewed last" : "Bots comment again on every push: only each bot's comments on the commit it reviewed last show. Click to show them all")
        .flex_none().text_size(12).text_color(t.muted).cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => { this.allBots = !this.allBots; cx.notify(); })
        .child(this.allBots ? `Hide ${g.botsHidden} older bot comments` : `${g.botsHidden} older bot ${g.botsHidden === 1 ? "comment" : "comments"} hidden`)));
  },
  commentsPane(t) {
    // No filters here: the bar's Show switch is the one filter, each row carries its state. A comment's states are
    // its own (the talk with the agent), not a finding's: "Fixed" is a finding's word, after a verification.
    const all = this.commentRowsNow(), rows = TH.filterRows(all, "all", this.show()), sel = new Set(this.selected());
    const STATE = { pending: ["Pending", "ansi3"], waiting: ["Sent to agent", "ansi6"], replied: ["Agent replied", "accent"], fixed: ["Reported fixed", "ansi2"], declined: ["Declined", "muted"], github: ["GitHub", "ansi4"], note: ["Note", "ansi5"] };
    const files = [...new Set(rows.map((r) => r.file))];
    return v_flex().flex_1().min_h(0)
      .child(v_flex().flex_none().px(14).py(10).gap(8).border_b(1).border_color(t.border)
        .child(div().text_size(12.5).text_color(t.muted).whitespace_normal().child(TH.commentSummary(all) || "No comments yet")))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("rv-comments-left").absolute().inset_0().overflow_y_scroll().p(8).gap(2)
          .when(!rows.length, (e) => e.child(div().p(6).text_size(12.5).text_color(t.muted).whitespace_normal().child(all.length ? "The Show switch in the bar hides these comments." : "Comments you write, send or post show here, with their replies.")))
          .children(files.flatMap((file) => [div().pt(8).pb(2).px(6).text_size(11.5).font_semibold().text_color(t.muted).truncate().child(file),
            ...rows.filter((r) => r.file === file).flatMap((r) => {
              const st = STATE[r.state], mine = r.kind === "pending" || r.kind === "thread";
              // A row is one line; the one clicked last shows its whole text under it, as Markdown.
              const whole = this.crow === r.id ? [div().id(`rv-crw-${r.id}`).ml(68).mr(6).mb(6).px(10).py(6).rounded(6).bg(t.surface).text_size(13).line_height(1.5).child(TextView.markdown(`rv-crwm-${r.id}`, String(r.text ?? "")))] : [];
              return [h_flex().id(`rv-cr-${r.id}`).tooltip("Jump to this comment in the diff").gap(8).items_center().px(6).h(30).rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
                .on_click((_e, cx) => { this.crow = r.id; if (r.kind === "thread") this.openThreads.add(r.id); if (r.kind === "note") (this.openNotes ??= new Set()).add(r.id); this.jumpTo(`${r.file}:${r.line}`, cx); })
                .child(div().id(`rv-crb-${r.id}`).tooltip((mine ? "Select to fix this comment with an agent" : "Only your own comments can be selected")).accessibility_label("Select comment").w(14).h(14).flex_none().rounded(3).border_1().border_color(sel.has(r.id) ? t.accent : mine ? t.input : "#00000000").bg(sel.has(r.id) ? t.accent : "#00000000")
                  .flex().items_center().justify_center().text_size(10).text_color(t.accent_foreground).child(sel.has(r.id) ? "✓" : "")
                  .when(mine, (e) => e.on_click((_e, cx) => { this.toggleSel(r.id, cx); cx.stop_propagation(); })))
                .child(div().w(40).flex_none().text_size(11.5).text_color(t.muted).child(`${r.old ? "−" : ""}${r.line}`))
                .child(div().flex_1().min_w(0).truncate().text_size(13).child(plain(r.text)))
                .when(r.replies > 0, (e) => e.child(div().id(`rv-crr-${r.id}`).tooltip(`${r.replies} replies in this thread`).flex_none().text_size(11.5).text_color(t.muted).child(`↩ ${r.replies}`)))
                .when(Boolean(r.stale), (e) => e.child(badge(t, "STALE", t.ansi3).id(`rv-crst-${r.id}`).tooltip(STALE_TIP)))
                .when(Boolean(r.outdated), (e) => e.child(badge(t, "Outdated", t.muted).id(`rv-cro-${r.id}`).tooltip("GitHub marks this comment outdated: the code it was on changed since")))
                .when(Boolean(r.resolved), (e) => e.child(badge(t, "Resolved", t.ansi2).id(`rv-crv-${r.id}`).tooltip("This thread is resolved on GitHub")))
                .child(div().id(`rv-crs-${r.id}`).tooltip(STATE_TIP[r.state] ?? st[0]).flex_none().px(6).h(18).flex().items_center().rounded(9).border_1().border_color(t[st[1]] ?? t.muted).text_size(11).text_color(t[st[1]] ?? t.muted).child(st[0])), ...whole];
            })])))
        .child(Scrollbar.vertical("rv-comments-left").absolute().inset_0()));
  },

  // While comments are selected: a toolbar floating at the bottom centre of the diff (the list keeps room for it).
  selectionBar(t) {
    const n = this.selected().length, w = 340, left = Math.max(8, Math.round(((this.listW ?? 900) - w) / 2));
    return h_flex().id("rv-selbar").absolute().bottom(12).left(left).w(w).h(38).pl(14).pr(5).gap(10).items_center().rounded_full().bg(t.popover).border_1().border_color(t.border).shadow_lg()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(div().flex_none().text_size(13).font_semibold().child(`${n} selected`))
      .child(div().w(1).h(18).flex_none().bg(t.border))
      .child(div().id("rv-selfix").tooltip("Fix the selected comments with an agent; a preview first. A sub-agent works on its own branch and never pushes").flex_none().px(14).h(28).flex().items_center().rounded_full().bg(t.accent).text_color(t.accent_foreground).text_size(13).font_semibold().cursor_pointer()
        .on_click((_e, cx) => this.fixComments(this.selected(), cx)).child(`✦ Fix selected (${n})`))
      .child(div().flex_1())
      .child(div().id("rv-selx").w(28).h(28).flex_none().flex().items_center().justify_center().rounded_full().text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip("Clear selection (Esc)").accessibility_label("Clear selection").on_click((_e, cx) => this.clearSel(cx)).child("✕"));
  },
  clearSel(cx) { const key = this.threadKey(); this.updateThreads(cx, (d) => TH.clearSelected(d, key)); },

  // "Reply" in a thread: the follow-up's input under the diff (Enter: the preview).
  replyBar(t) {
    const th = this.threads().find((x) => x.id === this.replyTo);
    if (!th) return div();
    return h_flex().flex_none().px(14).py(8).gap(8).items_center().border_t(1).border_color(t.border).bg(t.surface)
      .child(div().flex_none().text_size(12.5).text_color(t.muted).child(`Reply on ${th.file.split("/").pop()} ${uiLine(th)}`))
      .child(div().id("rv-reply-in").tooltip("Your follow-up in this thread; Enter opens a preview").flex_1().min_w(0).h(30).px(8).flex().items_center().rounded(6).border_1().border_color(t.accent).bg(t.background).cursor_text()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.replyIn).h_full().text_size(13).text_color(t.foreground)))
      .child(pill("rv-reply-go", t, "Send to agent…", (_e, cx) => this.followup(cx), false, t.foreground).tooltip("Preview your follow-up; it goes to the agent only after you confirm"))
      .child(pill("rv-reply-x", t, "Cancel", (_e, cx) => { this.replyTo = null; cx.notify(); }).tooltip("Close the reply without sending"));
  },

  // ---- render: the bar

  // Row 1, the bar copy: back, the title (all the room left, cut only at its end, whole as tooltip), repo#n, state and
  // context; on the right only actions: Fix selected (while some are), Run review, Finish your review. The rest (risk,
  // effort, checks, model, values, help, ⋯) is row 2 at the top of the review (metaRow).
  renderBar() {
    if (shared("review.explore")) return this.renderExploreBar(shared("review.explore"));
    const t = theme(), pr = shared("review.target"), meta = shared("review.meta") ?? {};
    const pending = meta.url === pr?.url ? meta.pending ?? 0 : 0, selected = meta.url === pr?.url ? meta.selected ?? 0 : 0;
    const title = pr ? `#${pr.number} ${pr.title ?? ""}` : "Review";
    const runs = Object.values(shared("review.reviewers") ?? {}), openRuns = () => openOverlay({ mod: "pr-review", props: { part: "reviews" }, kind: "popup", ...reviewsPop() });
    const runLabel = runs.some((r) => r.busy) ? "Reviews running ⋯" : "Run review ▾";
    return h_flex().id("rv-bar").size_full().pl(84).pr(16).gap(12).items_center().bg(t.chrome).text_color(t.foreground).text_size(13.5)
      .child(pill("rv-back", t, "← Back", () => leave()).tooltip("Leave the review and return to the previous layout (Esc)").flex_none())
      .when(Boolean(pr), (e) => e.child(pill("rv-min", t, "▁ Minimize", () => minimize()).flex_none()
        .tooltip("Go back to your chats and keep this review as one entry at the top; open it from there where you left it")))
      .child(div().id("rv-title").flex_1().min_w(0).truncate().font_semibold().text_size(14).tooltip(title).child(title))
      .when(Boolean(pr), (e) => e.child(div().id("rv-bar-repo").tooltip("Repository and PR number").flex_none().text_size(12).text_color(t.muted).child(`${pr.repo ?? ""}#${pr.number ?? ""}`))
        .child(badge(t, `PR ${pr.state ?? "?"}`, t[{ open: "ansi2", draft: "dim", merged: "ansi5", closed: "ansi1" }[pr.state]] ?? t.dim).id("rv-bar-state").tooltip("The PR's state on GitHub"))
        .when(C.tagged(ctxDoc()), (e) => e.child(badge(t, C.labelOf(ctxDoc(), prCtx(pr)), C.colorOf(ctxDoc(), prCtx(pr), t)).id("rv-bar-ctx").tooltip("The context this PR belongs to"))))
      .when(selected > 0, (e) => e.child(div().id("rv-bar-fixsel").tooltip("Fix the selected comments with an agent; a preview first. A sub-agent works on its own branch and never pushes").flex_none().px(14).h(32).flex().items_center().rounded(7).bg(t.accent).text_color(t.accent_foreground)
        .text_size(13).font_semibold().cursor_pointer().on_mouse_down("left", stop).on_click(() => run("pr-review.fix")).child(`✦ Fix selected (${selected})`)))
      // Until a reviewer ran, the deep review is the button to find: green, like Finish your review.
      .child(runs.some((r) => r.at || r.busy) ? pill("rv-reviews-btn", t, runLabel, openRuns).tooltip("Run Claude or security reviews of this PR, read-only; see each run's status").flex_none()
        : div().id("rv-reviews-btn").tooltip("Run Claude or security reviews of this PR, read-only; see each run's status").flex_none().px(14).h(32).flex().items_center().rounded(7).bg(GH_GREEN).text_color("#ffffff").text_size(13).font_semibold()
          .cursor_pointer().on_mouse_down("left", stop).on_click(openRuns).child(runLabel))
      .when(meta.url === pr?.url && Boolean(meta.dry), (e) => e.child(badge(t, "Dry run", t.ansi3).id("rv-bar-dry").tooltip(DRY_TIP)))
      // GitHub's green "Review changes" / "Finish your review", with the pending count; the review copy draws the popover.
      .child(div().id("rv-finish-btn").tooltip("Preview your pending comments, then post them to GitHub or send them to an agent").flex_none().px(14).h(32).flex().items_center().gap(6).rounded(7).bg(GH_GREEN).text_color("#ffffff").text_size(13).font_semibold()
        .cursor_pointer().on_mouse_down("left", stop).on_click(() => run("pr-review.finish"))
        .child(pending ? "Finish your review" : "Review changes")
        .when(pending > 0, (e) => e.child(div().px(6).rounded_full().bg("#ffffff").text_color(GH_GREEN).text_size(11.5).child(String(pending))))
        .child("▾"));
  },

  // Row 2, at the top of the review: the facts as plain text with separators (risk, the rules and checks by name),
  // then the model as one dropdown, Example values, help and ⋯ (Mark done, Copy link, Copy review state, Open on
  // GitHub). Narrow: it wraps.
  metaRow(t) {
    const ai = this.ai, m = model(), ck = this.checkFacts();
    const sep = () => div().flex_none().text_color(t.dim).child("·"), cap = (x) => x[0].toUpperCase() + x.slice(1);
    const link = (id, child, click) => h_flex().id(id).flex_none().gap(4).items_center().px(6).h(26).rounded(6).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(click).child(child);
    const menu = (id, items, w = 230) => (_e, cx) => { openOverlay({ mod: "pr-review", props: { part: "cmenu", key: id, items }, kind: "popup", width: w, height: 12 + 30 * items.length }); cx.stop_propagation(); };
    // Without an analysis the risk still comes from what there is: the reviewers' unresolved findings, said so.
    const fc = this.prSel ? this.counts() : { unresolved: 0 }, top = ["high", "medium", "low"].find((k) => fc[k]);
    const facts = [
      ai?.mergeRisk && div().id("rv-mr").flex_none().tooltip(ai.mergeRisk.why || "").child(h_flex().gap(4).child("Merge risk:").child(div().text_color(t[SEVERITY_COLOR[ai.mergeRisk.level]] ?? t.muted).child(cap(ai.mergeRisk.level)))),
      !ai?.mergeRisk && top && link("rv-mr", h_flex().gap(4).child("Risk from findings:").child(div().text_color(t[SEVERITY_COLOR[top]] ?? t.muted).child(cap(top))).child(`(${fc[top]} ${top}, no analysis)`),
        (_e, cx) => { this.tab = "findings"; cx.notify(); }).tooltip("No analysis has rated the merge risk; this is the highest severity among the unresolved findings. Click for the Findings tab"),
      ck && link("rv-ck", h_flex().gap(4).children(ck.parts.map(([text, bad]) => div().when(bad, (e) => e.text_color(t.ansi1)).child(text))),
        (_e, cx) => { this.tab = "steps"; this.page = "overview"; this.scrollPage("checks", cx); cx.notify(); }).tooltip(ck.tip),
    ].filter(Boolean);
    const modelText = this.aiBusy ? `${modelLabel(this.aiBusy.model)} analyzing…` : `${modelLabel(m)}${ai?.cost != null && ai.model === m ? ` · $${Number(ai.cost).toFixed(2)}` : ""}`;
    return h_flex().id("rv-meta").flex_none().flex_wrap().min_h(40).px(16).py(6).gap(10).items_center().border_b(1).border_color(t.border).bg(t.chrome).text_size(12.5).text_color(t.muted)
      .children(facts.flatMap((f, k) => (k ? [sep(), f] : [f])))
      .child(div().flex_1())
      .child(this.showChips(t, "rv-show")).child(sep())
      .when(Boolean(this.worktree?.path) && !this.trustedPr(), (e) => e.child(link("rv-trust", div().text_color(t.ansi3).child("Restricted Mode · Trust"), (_e, cx) => this.trust("pr", cx))
        .tooltip("Someone else's code: language servers don't run anything from the repository, so go-to-definition may find less. Click to trust this PR.")))
      .child(link("rv-model", h_flex().gap(4).child(this.aiBusy ? div().child(SPIN[0]).frames(SPIN, 90) : div()).child(modelText).child("▾"),
        menu("models", modelChoices(this.ctxId()).map((c) => [`${c.value === m ? "✓ " : ""}${c.label} · ${priceText(c.value)} · ${this.estimate(c.value)}`, false, `model:${c.value}`]), 470)).tooltip("Pick the model for the AI analysis; each option shows its cost estimate").accessibility_label("Model"))
      .child(sep())
      .child(link("rv-values", div().text_color(valuesOn() ? t.foreground : t.muted).child(`Example values ${valuesOn() ? "on" : "off"}`), () => setShared("review.values", !valuesOn())).tooltip("Example values from the flow traces, shown inline in the diff: click to switch"))
      .child(link("rv-keys", div().child("?"), () => openOverlay({ mod: "pr-review", props: { part: "keys" }, kind: "popup", ...KEYS_POP })).tooltip("Keyboard shortcuts").accessibility_label("Keyboard shortcuts"))
      .child(link("rv-more", div().child("⋯"), menu("more", [["Explore a topic…", false, "explore"], ["Mark done", false, "done"], ["Copy link", false, "copy-link"], ["Copy review state", false, "copy-state"], ...(this.prSel?.url?.startsWith("https://github.com") ? [["Open on GitHub", false, "open-gh"]] : [])])).tooltip("Explore a topic, mark done, copy the link or the review's state as text, open on GitHub").accessibility_label("More actions"));
  },

  // ---- render: the left column

  stepRow(s, i, t) {
    const on = i === this.cur && !this.page, done = this.done(s), files = this.filesOf(s), seen = files.filter((p) => this.prog.seen.has(p)).length;
    const list = on && !s.pseudo, w = worst(this.layerFindings(s).filter((f) => OPEN_ST.includes(this.fstatus(f)))), n = (k) => `${k} unresolved ${k === 1 ? "finding" : "findings"}`;
    return v_flex().id(`rv-step-${i}`).tooltip("Open this layer: its explanation, flows and changed code").flex_none().px(10).py(8).gap(6).rounded(8).cursor_pointer().when(on, (e) => e.bg(t.selected)).hover((st) => st.bg(t.hover))
      .on_click((_e, cx) => { this.goStep(i, cx); cx.notify(); })
      .child(h_flex().gap(8).items_center()
        .child(div().id(`rv-chk-${i}`).tooltip(done ? "You ticked every file in this layer as viewed" : "The layer gets its tick once you ticked every file in it as viewed").w(18).flex_none().text_size(14).text_color(done ? t.ansi2 : t.dim).child(done ? "✓" : String(i + 1)))
        .child(div().flex_1().min_w(0).text_size(14.5).font_semibold().text_color(s.stale ? t.dim : t.foreground).when(!on, (e) => e.truncate()).child(plain(s.title)))
        .when(Boolean(s.isNew), (e) => e.child(badge(t, "new", t.accent).id(`rv-new-${i}`).tooltip("New since the previous analysis")))
        .when(Boolean(s.stale), (e) => e.child(badge(t, "outdated", t.ansi3).id(`rv-old-${i}`).tooltip("These hunks are no longer in the diff: the code changed since the analysis")))
        // Its unresolved findings, whoever found them: the highest severity with its count, security with its own mark.
        .when(Boolean(w?.security), (e) => e.child(div().id(`rv-sec-${i}`).tooltip(`${w.security} of them ${w.security === 1 ? "is a security finding" : "are security findings"}`).flex_none().text_size(13).text_color(t.ansi1).child("⛨")))
        .when(Boolean(w), (e) => e.child(badge(t, w.label, t[SEV[w.severity]] ?? t.ansi1).id(`rv-risk-${i}`).tooltip(`${n(w.total)} in this layer: ${w.words}`))))
      .when(!list, (e) => e.child(div().pl(26).text_size(12).text_color(t.muted).child(`${seen} of ${files.length} ${files.length === 1 ? "file" : "files"} viewed`)))
      // The open layer: its files, each with the same "Viewed" tick as in the Files tab (a long list: its first ones).
      .when(list, (e) => e.child(v_flex().pl(22).children(files.slice(0, LAYER_FILES).map((p, k) => h_flex().id(`rv-lfile-${i}-${k}`).tooltip("Tick this file as viewed; the layer is ticked once all its files are").accessibility_label("Viewed")
        .h(26).px(4).gap(8).items_center().rounded(5).cursor_pointer().hover((st) => st.bg(t.hover))
        .on_click((_e, cx) => { this.toggleSeen(p, cx); cx.stop_propagation(); cx.notify(); })
        .child(viewedBox(t, this.prog.seen.has(p)))
        .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(this.prog.seen.has(p) ? t.muted : t.foreground).child(p))))
        .when(files.length > LAYER_FILES, (x) => x.child(div().h(22).px(4).text_size(12).text_color(t.muted).child(`${seen} of ${files.length} files viewed: the other ${files.length - LAYER_FILES} are in the Files tab`)))))
      .child(div().pl(26).text_size(13.5).line_height(1.5).text_color(on ? t.foreground : t.muted)
        .child(on ? TextView.markdown(`rv-why-${stepKey(s)}`, s.why) : div().truncate().child(plain(s.why))))
      .when(on, (e) => e.children(this.layerParts(s, t, "rv", i, i, s.visuals?.length > 0 && this.diagramsBar(t, `rv-dia-${i}`, "Refresh this view")).map((x) => div().pl(26).child(x))))
      .when(on && !s.pseudo && Boolean(this.ai), (e) => e.child(h_flex().pl(26).gap(6).child(pill(`rv-ask-l${i}`, t, "Ask about this layer", (_e, cx) => {
        const k = (this.ai?.steps ?? []).indexOf(s); this.setDrawer("open", cx, k >= 0 ? { layer: k } : null); cx.stop_propagation(); }).tooltip("Ask one model question about this layer; the answer stays private"))
        .child(pill(`rv-drill-l${i}`, t, "Show details", (_e, cx) => { this.showDetails(this.layerSubject(s), `layer:${stepKey(s)}`, cx); cx.stop_propagation(); }).tooltip("One model call breaks this layer down further")))
        .child(div().pl(26).child(this.drillPanel(t, `layer:${stepKey(s)}`))))
      .when(on, (e) => e.children((s.flows ?? []).map((f, k) => {
        const picked = this.flowOf()?.f === f;
        return div().pl(26).child(div().rounded(9).border_1().border_color(picked ? t.accent : t.chrome).child(flowCard(f, t, `rv-flow-${i}-${k}`,
          (_e, cx) => { this.flowSel = { step: stepKey(s), k }; this.jumpTo(f.at, cx); cx.stop_propagation(); })));
      })))
      ;
  },

  // A layer's explanation, findings and pictures; a card's "In the layer analysis" shows them. The Layers view (p
  // "rv") has the pictures, like the check questions, once: over the layer's code (item: "step" and "vis").
  // p, n: keep the ids unique per place; tab: the key of the shown picture in this.visTab; bar: drawn above the pictures.
  layerParts(s, t, p, n, tab, bar = null) {
    const pics = p !== "rv" && s.visuals?.length > 0;
    return [
      Boolean(s.text) && div().text_size(13.5).line_height(1.5).text_color(t.foreground).child(TextView.markdown(`${p}-ex-${stepKey(s)}`, s.text)),
      // Every finding in this layer's files, whoever found it: one line each with its source and state.
      this.layerFindings(s).length > 0 && v_flex().pt(2).gap(6)
        .child(div().text_size(11.5).font_semibold().text_color(t.muted).child("FINDINGS"))
        .children(this.layerFindings(s).map((f, k) => {
          const st = this.fstatus(f), settled = ["fixed", "dismissed"].includes(st);
          return h_flex().id(`${p}-f-${n}-${k}`).tooltip(`${this.sourcesOf(f)}: open this finding in the Findings tab`).gap(8).items_center().text_size(13.5).cursor_pointer()
            .on_click((_e, cx) => { this.openFinding(f); cx.stop_propagation(); cx.notify(); })
            .child(badge(t, f.severity, t[SEV[f.severity]]))
            .child(div().flex_1().min_w(0).truncate().text_color(settled ? t.dim : t.foreground).child(f.title))
            .child(div().flex_none().text_size(11.5).text_color(t.muted).child(f.sources.length === 1 ? this.sourcesOf(f) : `${f.sources.length} sources`))
            .when(st !== "open", (e) => e.child(div().flex_none().text_size(11.5).text_color(t[FSTATUS[st]?.[1]] ?? t.muted).child(FSTATUS[st]?.[0] ?? st)));
        })),
      pics && bar,
      pics && visualsCard(s.visuals, t, `${p}-vis-${n}`, (at, cx) => this.jumpTo(at, cx),
        this.visTab?.[tab] ?? 0, (k, cx) => { this.visTab = { ...this.visTab, [tab]: k }; cx.notify(); }, this.wrapX()),
    ].filter(Boolean);
  },

  // The flow whose trace shows inline: the one picked in the current step, else its first.
  flowOf() {
    const s = this.steps()[this.cur];
    if (!s?.flows?.length) return null;
    const k = this.flowSel?.step === stepKey(s) ? this.flowSel.k : 0;
    return { f: s.flows[k] ?? s.flows[0] };
  },

  // Inline example values (IntelliJ-style) for rows: "path:line" -> "name = value, …" from the shown flow's trace.
  traceMap() {
    const f = valuesOn() ? this.flowOf()?.f : null, out = new Map();
    for (const tr of f?.trace ?? []) {
      const path = this.patch?.find((x) => x.path === tr.path || x.path.endsWith(`/${tr.path}`))?.path ?? tr.path;
      out.set(`${path}:${tr.line}`, tr.values);
    }
    return out;
  },

  // ---- the left column: the pages row above the tabs, the Layers tab (what needs attention, the layers), the pages

  checksNow() { return preMergeChecks({ title: this.pr?.title ?? this.prSel?.title, rules: this.ai?.rules ?? [], ctx: this.ctx }); },
  openFindings() { return this.findings().filter((f) => OPEN_ST.includes(this.fstatus(f))); },
  blockersNow(checks = this.checksNow()) { return mergeBlockers({ checks, findings: this.openFindings(), unverified: this.verifyList().length, related: this.ctx, sent: (f) => this.fstatus(f) === "progress" }); },
  // The triage for this PR (pr.js triageOf, no LLM), for the registry and its consumers.
  triageNow() {
    const lines = (this.patch ?? []).reduce((n, f) => n + f.add + f.del, 0);
    return triageOf({ pr: this.prSel ?? {}, analysis: this.ai, size: { files: this.patch?.length ?? 0, lines },
      security: this.openFindings().filter((f) => f.security), related: this.ctx });
  },
  filesOf(s) { return [...new Set(this.present(s).map((id) => this.byId.get(id).path))]; },
  // "file.ts — question": a check question with the file it is about (the analysis names it; none when the question
  // is about several files, or in an analysis from before it did).
  asked(s, q, k) { const f = s.questionFiles?.[k]; return f ? `${f.split("/").pop()} — ${q}` : q; },

  // What stands in the way of a merge, most urgent first: the merge blockers (pr.js mergeBlockers, the Overview's
  // list) by severity, security first among equals. No layers: those are the list below.
  attention() {
    const of = (b) => (b.finding ? this.findingById(b.finding) : null);
    return byUrgency(this.blockersNow(), (b) => Boolean(of(b)?.security)).map((b) => {
      const f = of(b);
      return { severity: b.severity, label: b.title, why: b.why ?? "", security: Boolean(f?.security), finding: Boolean(f), sent: Boolean(f) && this.fstatus(f) === "progress", at: f ? `${f.file.split("/").pop()}:${f.line}` : "",
        go: (cx) => { if (f) this.openFinding(f); else if (b.where) this.jumpTo(b.where, cx); else this.page = "overview"; } };
    });
  },

  // The box above the layers: the first few blockers, one line each. Folded to its heading while a layer is open
  // (attFold: your own click on the heading, until another page or layer view opens).
  attentionBox(t, list, folded) {
    const SHOWN = 5, rest = list.slice(SHOWN);
    return v_flex().flex_none().p(10).gap(4).rounded(8).border_1().border_l(3).border_color(t.ansi3).bg(t.ansi3 + "10")
      .child(h_flex().id("rv-att-head").tooltip(folded ? "Show what stands in the way of a merge" : "Fold this list").gap(6).items_center().cursor_pointer().text_size(11.5)
        .on_click((_e, cx) => { this.attFold = !folded; cx.notify(); })
        .child(div().flex_none().w(10).text_color(t.ansi3).child(folded ? "▸" : "▾"))
        .child(div().flex_1().font_semibold().text_color(t.ansi3).child("NEEDS YOUR ATTENTION"))
        .child(div().flex_none().text_color(t.muted).child(worst(list).words)))
      .when(!folded, (e) => e.children(list.slice(0, SHOWN).map((a, k) => h_flex().id(`rv-att-${k}`).tooltip(a.why || "Go to this item").h(26).px(4).gap(8).items_center().rounded(5).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { a.go(cx); cx.notify(); })
        .child(badge(t, a.severity, t[SEV[a.severity]] ?? t.ansi1))
        .when(a.security, (x) => x.child(div().flex_none().text_size(13).text_color(t.ansi1).child("⛨")))
        .child(div().flex_1().min_w(0).truncate().text_size(13).child(a.label))
        .when(a.sent, (x) => x.child(div().flex_none().text_size(11.5).text_color(t[FSTATUS.progress[1]]).child(FSTATUS.progress[0])))
        .when(Boolean(a.at), (x) => x.child(div().flex_none().text_size(11.5).text_color(t.muted).child(a.at)))))
        .when(rest.length > 0, (x) => x.child(div().id("rv-att-more").tooltip(rest.some((a) => a.finding) ? "Open the Findings tab" : "Open the Overview page").h(22).px(4).flex().items_center().rounded(5).cursor_pointer()
          .text_size(12).text_color(t.muted).hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => { if (rest.some((a) => a.finding)) this.tab = "findings"; else this.page = "overview"; cx.notify(); })
          .child(`${rest.length} more: ${worst(rest).words} →`))));
  },

  // The PR's pages (Overview, Architecture, Security) above the tabs: reachable from every tab, and not layers.
  pagesRow(t) {
    const sec = this.prSel ? this.counts().security : 0, changed = (this.ai?.arch?.nodes ?? []).some((n) => n.status && n.status !== "unchanged");
    const mark = { blast: sec > 0 && badge(t, `⛨ ${sec}`, t.ansi1).id("rv-nav-sec").tooltip(`${sec} unresolved security ${sec === 1 ? "finding" : "findings"}`),
      arch: changed && badge(t, "Changed", t.accent).id("rv-nav-arch").tooltip("The architecture picture differs before and after this PR") };
    return h_flex().flex_none().px(8).pt(8).gap(4)
      .children(["overview", "arch", "blast"].map((k) => {
        const label = PAGES.find(([p]) => p === k)[1], on = this.tab === "steps" && this.page === k;
        return h_flex().id(`rv-nav-${k}`).tooltip(`Open the ${label} page`).min_w(0).h(28).px(10).gap(6).items_center().rounded(7).cursor_pointer()
          .when(on, (e) => e.bg(t.selected).font_semibold()).hover((st) => st.bg(t.hover)).on_click((_e, cx) => { this.tab = "steps"; this.page = k; cx.notify(); })
          .child(div().min_w(0).truncate().text_size(13).text_color(on ? t.foreground : t.muted).child(label))
          .children([mark[k]].filter(Boolean));
      }));
  },

  stepsPane(t, cx) {
    const steps = this.steps(), ai = this.ai, m = model(), all = this.patch ?? [], viewed = all.filter((f) => this.prog.seen.has(f.path)).length;
    const run = (label) => div().id("rv-run").tooltip("Starts the AI analysis: one model call, it can take several minutes").px(12).h(30).flex().items_center().rounded(8).text_size(13).bg(t.solid).text_color(t.solid_foreground)
      .cursor_pointer().on_click((_e, cx) => this.loadAi(cx, "run")).child(label);
    const attention = this.prSel ? this.attention() : [];
    // The run's cost, time and age are not for the first line of this column: they are in Re-analyze's tooltip.
    const last = ai ? ` The shown run: ${modelLabel(ai.model) ?? ai.model}${ai.cost != null ? `, $${Number(ai.cost).toFixed(3)}` : ""}${ai.budget ? ` of $${ai.budget} cap` : ""}${ai.ms ? `, ${clock(ai.ms)}` : ""}, ${ago(ai.generated)}${ai.incremental ? ", with the changes since your last review merged in" : ""}.` : "";
    // goStep: the open layer to the top of this column too. A plain scroll area only reveals a child at its near edge
    // (one below the view lands at its bottom), so the last child first, then, a frame later, the layer: it is above
    // the view then and lands at the top. The layers come after the heading.
    if (this.page !== this.leftPage) { this.leftPage = this.page; this.attFold = null; if (this.page) this.leftScroll.scroll_to_item(0); } // a page opened: the list from its top, the attention box open again
    if (this.leftTop && steps.length) {
      const first = 1;
      if (this.leftTop === 1) { this.leftTop = 2; this.leftScroll.scroll_to_item(first + steps.length - 1); cx.timer.after(0, (cx) => cx.notify()); }
      else { this.leftTop = 0; this.leftScroll.scroll_to_item(first + this.cur); }
    }
    const canInc = Boolean(ai && this.aiFile && this.since?.files.length && !this.aiBusy);
    return v_flex().flex_1().min_h(0)
      .child(v_flex().flex_none().px(14).py(10).gap(8).border_b(1).border_color(t.border)
        .when(!ai && !this.aiBusy, (e) => e.child(v_flex().gap(8).py(4)
          .child(div().text_size(13.5).line_height(1.5).child(`No ${modelLabel(m)} analysis for this diff yet. One thorough run reads the code around the changes and groups them into layers by intent, with explanations, check questions, suspicious lines, merge risk, review effort, repo rule checks, pictures and example values. It can take several minutes.`))
          .child(h_flex().gap(10).items_center().child(run(`Analyze with ${modelLabel(m)}`))
            .child(div().text_size(12).text_color(t.muted).child(this.estimate(m))))))
        .when(Boolean(this.aiBusy), (e) => e.child(h_flex().gap(8).items_center().text_size(13).text_color(t.muted).child(div().child(SPIN[0]).frames(SPIN, 90))
          .child(div().flex_1().child(`${modelLabel(this.aiBusy.model)} is reading ${this.aiBusy.incremental ? "the new changes" : "the code"}${this.aiBusy.passes ? ` · Pass ${this.aiBusy.pass} of ${this.aiBusy.passes}` : ""} · ${clock(Date.now() - this.aiBusy.started)} · cap $${CAP[tierOf(this.aiBusy.model)]}`))
          .child(pill("rv-cancel", t, "Cancel", (_e, cx) => this.cancelAi(cx), false, t.ansi1).tooltip("Stop the running analysis"))))
        .when(Boolean(this.aiError), (e) => e.child(div().text_size(12.5).text_color(t.ansi1).whitespace_normal().child(this.aiError)))
        .when(Boolean(ai && !ai.exact), (e) => e.child(div().text_size(12.5).text_color(t.ansi3).whitespace_normal().child(canInc ? "Analysis of an older diff: re-analyze, or analyze only the new changes." : "Analysis of an older diff: re-analyze for the current state.")))
        .when(Boolean(ai?.scope?.skimmed), (e) => e.child(div().text_size(12.5).text_color(t.muted).whitespace_normal().child(scopeLine(ai.scope)))) // only when something was not read in detail
        .when(Boolean(ai?.cut.length) && !ai?.scope, (e) => e.child(div().text_size(12.5).text_color(t.ansi3).whitespace_normal().child(`${ai.cut.length} hunks were too large for ${modelLabel(ai.model) ?? ai.model} and are not analyzed (an older analysis: re-analyze to read them).`)))
        .child(h_flex().flex_wrap().gap(6).items_center().text_size(12.5)
          .when(orderDiffers(ai?.steps ?? []), (e) => e.child(h_flex().gap(2).p(2).rounded(7).border_1().border_color(t.border).children([["reading", "Layers"], ["risk", "By focus"]].map(([k, label]) =>
            div().id(`rv-order-${k}`).tooltip((k === "risk" ? "List the layers that need the closest reading first" : "List the layers in the order to read them")).px(8).h(22).flex().items_center().rounded(5).cursor_pointer().bg(this.order === k ? t.selected : t.chrome)
              .text_color(this.order === k ? t.foreground : t.muted).on_click((_e, cx) => { this.order = k; this.cur = 0; cx.notify(); }).child(label)))))
          .child(pill("rv-prev", t, "‹ Prev", (_e, cx) => { this.goStep(this.cur - 1, cx); cx.notify(); }).tooltip("Previous layer (k)"))
          .child(pill("rv-next", t, "Next ›", (_e, cx) => { this.goStep(this.cur + 1, cx); cx.notify(); }).tooltip("Next layer (j)"))
          .when(Boolean(ai || this.aiError), (e) => e.child(pill("rv-rerun", t, this.aiBusy ? "Running…" : "Re-analyze", (_e, cx) => this.loadAi(cx, "run")).tooltip(`Run the AI analysis again: one model call.${last}`)))
          .when(canInc, (e) => e.child(pill("rv-reinc", t, "Only new changes", (_e, cx) => this.loadAi(cx, "run", true), false, t.accent)
            .tooltip(`Analyze only the ${this.since.files.length} files changed since your last review and merge the new layers in`))))
        // Above the list, not in it: folded to one line while a layer is open, it still says what is left to decide.
        .when(attention.length > 0, (e) => e.child(this.attentionBox(t, attention, this.attFold ?? !this.page))))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("rv-steps-left").absolute().inset_0().overflow_y_scroll().track_scroll(this.leftScroll).p(8).gap(4)
          .child(h_flex().flex_none().mt(2).px(10).gap(8).items_center().text_size(11.5).font_semibold().text_color(t.muted)
            .child(div().flex_1().child("LAYERS")).child(div().id("rv-lv-seen").tooltip("Files you ticked as viewed; a layer is ticked once all its files are").child(`${viewed} of ${all.length} files viewed`)))
          .children(steps.map((s, i) => this.stepRow(s, i, t))))
        .child(Scrollbar.vertical("rv-steps-left").absolute().inset_0()));
  },

  riskBadges(t, ai, id) {
    const r = ai.mergeRisk, e = ai.effort, cap = (x) => x[0].toUpperCase() + x.slice(1);
    return h_flex().flex_wrap().gap(6)
      .when(Boolean(r), (x) => x.child(badge(t, `Merge risk: ${cap(r.level)}`, t[SEVERITY_COLOR[r.level]]).id(`${id}-risk`).tooltip(r.why || r.level)))
      .when(Boolean(e), (x) => x.child(badge(t, `Review effort ${e.score}/5`, e.score >= 4 ? t.ansi3 : t.muted).id(`${id}-eff`).tooltip(e.why || "")));
  },

  // The page beside the Layers nav (instead of the diff).
  pageView(t) {
    const body = { overview: () => this.overviewPage(t), arch: () => this.archPage(t), blast: () => this.blastPage(t) }[this.page];
    const kids = [].concat(body ? body() : div()); // a page may return its sections: scrollPage reaches each
    this.pageLen = kids.length;
    return div().flex_1().min_h(0).relative()
      .child(v_flex().id(`rv-page-${this.page}`).absolute().inset_0().overflow_y_scroll().track_scroll(this.pageScroll).px(24).py(18).gap(14).children(kids))
      .child(Scrollbar.vertical(`rv-page-${this.page}`).absolute().inset_0());
  },

  // "4 files changed since your last review (abc1234 → def5678)" with Since last review / Full PR.
  sinceBanner(t) {
    const s = this.since;
    if (!s) return null;
    const seg = (on, label, click) => div().id(`rv-since-${on}`).tooltip((on ? "Show only the files changed since your last review" : "Show the whole PR")).px(10).h(24).flex().items_center().rounded(5).cursor_pointer().text_size(12.5)
      .bg(this.sinceOn === on ? t.selected : t.chrome).text_color(this.sinceOn === on ? t.foreground : t.muted).on_click(click).child(label);
    const text = s.files.length ? `${s.files.length} ${s.files.length === 1 ? "file" : "files"} changed since your last review (${s.base.sha.slice(0, 7)} → ${String(s.head).slice(0, 7)})`
      : `The PR moved since your last review (${s.base.sha.slice(0, 7)} → ${String(s.head).slice(0, 7)})`;
    return v_flex().flex_none().px(14).py(8).gap(4).bg(t.accent + "14").border_b(1).border_color(t.border)
      .child(h_flex().gap(10).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(13).font_semibold().child(text))
        .when(s.files.length > 0, (e) => e.child(h_flex().gap(2).p(2).rounded(7).border_1().border_color(t.border)
          .child(seg(true, "Since last review", (_e, cx) => { this.sinceOn = true; this.gaps = {}; this.tab = "files"; cx.notify(); }))
          .child(seg(false, "Full PR", (_e, cx) => { this.sinceOn = false; this.gaps = {}; cx.notify(); })))))
      .when(Boolean(s.note), (e) => e.child(div().text_size(12).text_color(t.ansi3).whitespace_normal().child(s.note)));
  },

  // The Overview, top to bottom: the title, the verdict in the title's size (security first), what this PR sits on and
  // adds, the task check as one list (asksPane), what changed and the behavior as running text of about 85 characters
  // a line, the rules and checks by name, related PRs. Each fact once: the PR's state and the merge risk are in the
  // bar. It returns its sections, so scrollPage reaches each by name (pageAnchors).
  overviewPage(t) {
    const pr = this.prSel ?? {}, ai = this.ai, task = ai?.task ?? {}, ctx = this.ctx, fc = this.counts(), list = this.taskNow(), W = 560;
    const checks = this.checksNow(), TONE = { high: t.ansi1, medium: t.ansi3, low: t.ansi4, ok: t.ansi2 };
    const section = (title) => div().pt(4).text_size(11.5).font_semibold().text_color(t.muted).child(title), dot = () => div().flex_none().text_color(t.dim).child("·");
    const related = [...(ctx?.open ?? []).map((p) => ({ ...p, state: "open" })), ...(ctx?.merged ?? []).map((p) => ({ ...p, state: "merged" }))];
    const verdict = ai || fc.total ? verdictParts(list, fc, { failed: checks.filter((c) => c.ok === false).length, toVerify: this.verifyList().length }) : [];
    const go = { security: [(_e, cx) => { this.page = "blast"; cx.notify(); }, "Unresolved security findings: click for the Security page"],
      criteria: [null, "How many of the task's criteria this PR meets: the list is below"],
      findings: [(_e, cx) => { this.tab = "findings"; cx.notify(); }, "Unresolved findings of the highest severity there is: click for the Findings tab"],
      checks: [(_e, cx) => this.scrollPage("checks", cx), "Rules or checks that failed: click for the list"],
      verify: [(_e, cx) => { this.tab = "findings"; cx.notify(); }, "Fixes sent before the last push, not verified on the new head: click for the Findings tab"] };
    const part = (p) => div().id(`rv-vd-${p.key}`).tooltip(go[p.key][1]).text_color(TONE[p.tone]).when(Boolean(go[p.key][0]), (e) => e.cursor_pointer().hover((s) => s.underline()).on_click(go[p.key][0]))
      .child(p.key === "security" ? `⛨ ${p.text}` : p.text);
    const fact = (id, text, tip, click) => div().id(id).tooltip(tip).cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click(click).child(text);
    const facts = [ctx?.stacked_on && fact("rv-ov-stacked", `Stacked on #${ctx.stacked_on.number} ${ctx.stacked_on.title ?? ""}`, `This PR's base is the branch of #${ctx.stacked_on.number}, so it merges after it. Click to open #${ctx.stacked_on.number} in its own review.`, (_e, cx) => this.openRelated(ctx.stacked_on, cx)),
      componentLine(ai?.componentCounts) && fact("rv-ov-comp", componentLine(ai.componentCounts), "Components this PR adds or changes, as the analysis counts them: click for the Architecture impact page", (_e, cx) => { this.page = "arch"; cx.notify(); })].filter(Boolean);
    const head = v_flex().flex_none().gap(8).max_w(1100)
      .child(div().text_size(22).font_semibold().line_height(1.3).whitespace_normal().child(pr.title ?? `#${pr.number}`))
      .when(verdict.length > 0, (e) => e.child(h_flex().id("rv-verdict").flex_wrap().gap(10).items_center().text_size(22).font_semibold().line_height(1.3)
        .children(verdict.flatMap((p, k) => (k ? [dot(), part(p)] : [part(p)])))))
      .when(facts.length > 0, (e) => e.child(h_flex().flex_wrap().gap(8).items_center().text_size(12.5).text_color(t.muted).children(facts.flatMap((f, k) => (k ? [dot(), f] : [f])))))
      .when(Boolean(this.since), (e) => e.child(div().rounded(8).overflow_hidden().border_1().border_color(t.border).child(this.sinceBanner(t))))
      .when(!ai && !this.aiBusy, (e) => e.child(this.startCards(t)));
    const intent = Boolean(task.jira || task.note || ai?.intent?.length || (task.title && task.title !== pr.title));
    const changed = () => v_flex().flex_none().gap(8).max_w(W).text_size(13.5).line_height(1.5)
      .child(section("WHAT CHANGED"))
      .when(intent, (e) => e.child(v_flex().gap(4)
        .child(h_flex().flex_wrap().gap(6).items_center().when(Boolean(task.title) && task.title !== pr.title, (x) => x.child(div().whitespace_normal().child(task.title)))
          .when(Boolean(task.jira), (x) => x.child(chip(t, `Linked issue ${task.jira}`, t.accent, false, "rv-jira", "The issue this PR links to"))))
        .when(Boolean(task.note), (x) => x.child(div().text_size(12).text_color(t.ansi3).whitespace_normal().child(task.note)))
        .when(ai.intent?.length > 0, (x) => x.child(this.statements(t, ai.intent, "rv-int")))))
      .when(Boolean(ai.summary), (e) => e.child(div().child(TextView.markdown(`rv-sum-${ai.generated}`, ai.summary))))
      .when(Boolean(ai.behavior) || ai.behaviorPoints?.length > 0, (e) => e.child(section("BEHAVIOR"))
        .child(ai.behaviorPoints?.length ? this.statements(t, ai.behaviorPoints, "rv-bp") : div().child(TextView.markdown(`rv-beh-${ai.generated}`, ai.behavior))));
    // The checks that are no repo rule (the title's form, CI, conflicts), then the analysis' repo rules with where they
    // come from; what failed first.
    const rank = (r) => [false, null, true, "n/a"].indexOf(r.ok);
    const rows = [...checks.filter((c) => !c.rule).map((c) => ({ ok: c.ok, name: c.name, sub: c.ok === true ? "" : c.why ?? "", where: c.where })),
      ...(ai?.rules ?? []).map((r) => ({ ok: r.status === "pass" ? true : r.status === "fail" ? false : "n/a", name: r.rule, sub: `${r.source}${r.where ? ` · ${r.where}` : ""}${r.why ? ` — ${r.why}` : ""}`, where: r.where }))]
      .sort((a, b) => rank(a) - rank(b));
    const decided = rows.filter((r) => r.ok !== "n/a");
    const MARK = { true: ["✓", "ansi2", "Passed"], false: ["✗", "ansi1", "Failed"], null: ["…", "ansi3", "Not decided yet"], "n/a": ["n/a", "muted", "Does not apply to this PR"] };
    const checksEl = () => v_flex().flex_none().gap(2).max_w(W + 98)
      .child(section(`REPO RULES AND CHECKS · ${decided.filter((r) => r.ok === true).length} of ${decided.length} passed`))
      .children(rows.map((r, k) => h_flex().id(`rv-ck-${k}`).tooltip(`${MARK[r.ok][2]}${r.where ? ": click to jump to the code" : ""}`).gap(10).items_start().px(6).py(3).rounded(6).text_size(13.5)
        .when(Boolean(r.where), (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.jumpTo(r.where, cx)))
        .child(div().w(28).flex_none().font_semibold().text_color(t[MARK[r.ok][1]]).child(MARK[r.ok][0]))
        .child(v_flex().flex_1().min_w(0).child(div().whitespace_normal().child(r.name))
          .when(Boolean(r.sub), (e) => e.child(div().text_size(12).text_color(t.muted).whitespace_normal().child(r.sub))))))
      .when(!ctx, (e) => e.child(div().px(6).text_size(12).text_color(t.muted).child("CI checks and mergeability load in the background…")));
    const relatedEl = v_flex().flex_none().gap(6).max_w(W + 240).child(section(`RELATED PRS${ctx ? ` · ${related.length}` : ""}`))
      .when(!ctx, (e) => e.child(div().text_size(12.5).text_color(t.muted).child("Looking for PRs that touch the same files…")))
      .when(Boolean(ctx) && !related.length, (e) => e.child(div().text_size(12.5).text_color(t.muted).child("No other open PR and no PR merged in the last 90 days touches these files.")))
      .children(related.map((p) => h_flex().id(`rv-rel-${p.number}`).tooltip("Open this related PR in its own review").gap(8).items_center().p(6).rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.openRelated(p, cx))
        .child(chip(t, p.stacked ? "base" : p.state, p.stacked ? t.accent : p.state === "open" ? t.ansi2 : t.ansi5, false, `rv-relst-${p.number}`, p.stacked ? "This PR is stacked on that one: its branch is this PR's base" : "Whether that PR is still open or already merged"))
        .child(div().flex_none().text_size(13).text_color(t.muted).child(`#${p.number}`))
        .child(div().flex_1().min_w(0).truncate().text_size(13.5).child(p.title))
        .child(div().id(`rv-relf-${p.number}`).flex_none().text_size(12).text_color(t.muted).tooltip((p.files ?? []).join("\n") || "-").child(p.stacked ? "this PR builds on it" : `${p.overlap} ${p.overlap === 1 ? "file" : "files"} overlap`))));
    const out = [["top", head], (ai || fc.total > 0) && ["task", this.asksPane(t, list, W)], ai && ["changed", changed()], rows.length > 0 && ["checks", checksEl()], ["related", relatedEl]].filter(Boolean);
    this.pageAnchors = Object.fromEntries(out.map(([k], i) => [k, i]));
    return out.map(([, el]) => el);
  },

  // A related PR in the review layout (the resume contract): prs.json's entry, else one built from gh pr view on this
  // review's context; the browser when gh can't read it.
  openRelated(p, cx) {
    cx.spawn(async () => {
      const prs = JSON.parse(await readTextFile(`${appHome()}/pr-data/prs.json`).catch(() => null) ?? "{}").prs ?? [];
      const known = prs.find((x) => x.url === p.url);
      if (known) return startReview(known);
      const r = p.url ? await exec("gh", ["pr", "view", p.url, "--json", "number,title,author,headRefName,headRefOid,baseRefName,updatedAt,isDraft,state,url,additions,deletions,reviewDecision"], { timeout: 30000 }).catch(() => null) : null;
      if (r?.code === 0) startReview(ghTarget(JSON.parse(r.stdout), { context: this.ctxId(), source: "related", cwd: this.prSel?.cwd ?? null }));
      else if (p.url) openUrl(p.url);
    });
  },

  // The picture's highlight (hovered badge or legend row), focus (clicked card; Esc or a second click clears it) and
  // hover (a lighter focus) for the architecture ("arch") or blast radius ("blast") page.
  archOpts(k) {
    const set = (name, v, cx) => { if (this[name] !== v) { this[name] = v; cx.notify(); } };
    return { hl: this[`${k}Hl`] ?? (k === "arch" ? this.askHl : null), focus: this[`${k}Focus`] ?? null, hover: this[`${k}Hover`] ?? null,
      onHl: (v, cx) => set(`${k}Hl`, v, cx), onHover: (v, cx) => set(`${k}Hover`, v, cx),
      onFocus: (v, cx) => { this.fh.focus(); set(`${k}Focus`, v, cx); }, onJump: (at, cx) => this.jumpTo(at, cx) };
  },

  archPage(t) {
    const a = this.ai?.arch;
    const seg = (k, label) => div().id(`rv-av-${k}`).tooltip((k === "diff" ? "What changed in the architecture" : k === "before" ? "The architecture before this PR" : "The architecture after this PR")).px(10).h(24).flex().items_center().rounded(5).cursor_pointer().text_size(12.5)
      .bg(this.archMode === k ? t.selected : t.chrome).text_color(this.archMode === k ? t.foreground : t.muted).on_click((_e, cx) => { this.archMode = k; cx.notify(); }).child(label);
    const more = () => visualsCard(this.ai.visuals, t, "rv-arch-vis", (at, cx) => this.jumpTo(at, cx), this.archVisTab ?? 0, (k, cx) => { this.archVisTab = k; cx.notify(); }, this.wrapX());
    if (!a) return v_flex().gap(12).child(this.diagramsBar(t, "rv-dia-arch", "Refresh diagrams")).child(div().text_size(13.5).text_color(t.muted).child(this.ai ? "This analysis has no architecture picture (older analysis, or the PR touches no architecture). Re-analyze for one." : "No analysis yet: Analyze in the left column."))
      .when(this.ai?.visuals?.length > 0, (e) => e.child(div().max_w(760).child(more())));
    const groups = new Set(a.nodes.map((n) => n.group)).size, L = this.archL(), fit = this.archFitOn();
    const opts = this.archOpts("arch");
    return v_flex().gap(12)
      .child(h_flex().gap(12).items_center().flex_wrap().child(div().text_size(20).font_semibold().child("Architecture impact")).child(this.diagramsBar(t, "rv-dia-arch", "Refresh diagrams"))
        .when(this.drawerState() !== "open", (e) => e.child(pill("rv-ask-open", t, "Ask", (_e, cx) => this.setDrawer("open", cx, null)).tooltip("Ask one model question about the architecture picture")))
)
      .child(h_flex().w_full().gap(12).items_center().flex_wrap() // wraps onto two rows when narrow
        .child(div().flex_none().text_size(13).text_color(t.muted).child(`${groups} ${groups === 1 ? "system" : "systems"} | ${(a.edges ?? []).length} edges`))
        .child(div().flex_none().child(legend(t)))
        .when(hasSources(a) || (this.ai.visuals ?? []).some(hasSources), (e) => e.child(div().flex_none().child(sourceLegend(t))))
        .child(h_flex().flex_none().gap(2).p(2).rounded(7).border_1().border_color(t.border).child(seg("diff", "Structural diff")).child(seg("before", "Before")).child(seg("after", "After")))
        .child(div().id("rv-av-fit").flex_none().px(10).h(28).flex().items_center().rounded(7).border_1().border_color(fit ? t.accent : t.border).cursor_pointer().text_size(12.5)
          .text_color(fit ? t.foreground : t.muted).tooltip("Narrow cards, so a wide picture fits the view").on_click((_e, cx) => { this.archFit = !fit; this.hsOf("rv-arch-canvas").x = 0; cx.notify(); }).child("Fit"))
        .child(div().id("rv-av-wrap").flex_none().px(10).h(28).flex().items_center().rounded(7).border_1().border_color(this.archWrapOn() ? t.accent : t.border).cursor_pointer().text_size(12.5)
          .text_color(this.archWrapOn() ? t.foreground : t.muted).tooltip("On: a picture wider than the view in bands, top to bottom. Off: one row to scroll sideways")
          .on_click((_e, cx) => { this.archWrap = !this.archWrapOn(); this.hsOf("rv-arch-canvas").x = 0; cx.notify(); }).child("Wrap")))
      .child(this.archCanvas(t, L, opts))
      .child(this.archCard(t, a))
      .when(Boolean(this.archFocus), (e) => e.child(this.drillPanel(t, `arch:${this.archFocus}`)))
      .child(archLegend(L, t, "rv-arch-edges", "Edges", opts))
      .when(this.ai?.visuals?.length > 0, (e) => e.child(div().pt(6).text_size(13).font_semibold().text_color(t.muted).child("More views"))
        .child(div().max_w(760).child(more())));
  },

  // The picture: wider than the view and Wrap on (archWrapOn), in bands stacked top to bottom (arch.js archBands: lines run on in the next band
  // at the same height); else one row in the sideways scroller (40 px of room after the last column).
  archCanvas(t, L, opts) {
    const s = this.hsOf("rv-arch-canvas"), B = archBands(L, s.viewW && this.archWrapOn() ? hsVisible(s.viewW, this.drawerCover()) - 4 : 0); // 0: not measured yet or Wrap off, one row
    const pic = (k) => [archView(L, t, `rv-arch${k ? `-${k}` : ""}`, (n, _e, cx) => this.jumpTo(n.at, cx), null, opts), ...this.pinNotes(t, L)];
    if (B.length < 2) return this.hscroll("rv-arch-canvas", L.width + 4 + 40, L.height + 4, pic(0), t);
    return v_flex().id("rv-arch-canvas").w_full().gap(6)
      .on_size_change((size, cx) => { if (Math.abs(s.viewW - size.width) > 2) { s.viewW = size.width; cx.notify(); } })
      .children(B.flatMap((b, k) => [
        ...(k ? [div().id(`rv-arch-cut${k}`).w_full().h(0).border_t(1).border_dashed().border_color(t.border).tooltip("The picture goes on here: lines leaving the band above on the right come in on the left at the same height")] : []),
        div().id(`rv-arch-band${k}`).w(b.x1 - b.x0).h(L.height + 4).relative().overflow_hidden()
          .child(div().absolute().top(0).left(-b.x0).w(L.width).h(L.height + 4).children(pic(k)))]));
  },
  // The clicked card, under the picture: its whole description and the analysis's details (what it does overall, what
  // the PR changes in it). An analysis without details (older ones): Explain, one model call (the drill-down below).
  // Two tabs keep it short: Overview (the card itself) and Layer analysis (the layers on its code), picked per card.
  archCard(t, a) {
    const n = this.archFocus && a.nodes.find((x) => x.id === this.archFocus);
    if (!n) return div();
    const g = (a.groups ?? []).find((x) => x.id === n.group), at = n.at ?? n.evidence;
    const explain = (_e, cx) => this.showDetails({ id: n.id, label: n.label ?? n.id, group: g?.label, at, kind: "node", description: n.description }, `arch:${n.id}`, cx, false, true);
    const layers = this.cardLayerList(n);
    return v_flex().id("rv-arch-card").gap(10).p(12).rounded(10).border_1().border_color(t.border).bg(t.surface)
      .child(h_flex().gap(8).items_center().flex_wrap()
        .child(div().text_size(15).font_semibold().child(n.label ?? n.id))
        .child(div().text_size(12).text_color(t.muted).child([g?.label, n.type, n.status === "new" ? "added" : n.status].filter(Boolean).join(" · ")))
        .child(div().flex_1())
        .when(Boolean(at), (e) => e.child(pill("rv-arch-card-open", t, "Show in diff ↗", (_e, cx) => this.jumpTo(at, cx)).tooltip(`Show ${at} in the diff`)))
        .child(pill("rv-arch-card-explain", t, n.details ? "Look inside" : "Explain", explain, false, n.details ? null : t.foreground)
          .tooltip(`One ${modelLabel(model())} call reads the code: what this does overall, what the PR changes in it, and a picture of its inside`))
        .when(this.drawerState() !== "open", (e) => e.child(pill("rv-arch-card-ask", t, "Ask", (_e, cx) => this.setDrawer("open", cx, null)).tooltip("Ask one model question about this card")))
        .child(pill("rv-arch-card-x", t, "✕", (_e, cx) => { this.archFocus = null; cx.notify(); }).tooltip("Close (Esc)").accessibility_label("Close card details")))
      .child(this.archCardFacts(t, a, n, at))
      .when(Boolean(n.description), (e) => e.child(div().text_size(13).text_color(t.muted).whitespace_normal().line_height(1.5).child(n.description)))
      .child(n.details ? div().pt(2).text_size(13.5).line_height(1.55).child(TextView.markdown(`rv-arch-det-${this.ai?.generated}-${n.id}`, n.details))
        : div().text_size(12.5).text_color(t.muted).whitespace_normal().child("No further details for this card in this analysis: Refresh diagrams (above) adds them for every card, Explain reads just this one."))
      // What the layer analysis found in this card's code, in the same view: no tab to discover.
      .when(layers.length > 0, (e) => e.child(div().pt(6).text_size(11.5).font_semibold().text_color(t.muted).child("FROM THE LAYER ANALYSIS"))
        .child(this.archCardLayers(t, n, layers)));
  },
  // The layers that look at the card's code (explore.js layersForNode). Memoized per analysis and card: filesOf walks
  // the hunks, and the tab's count needs the list on every render.
  cardLayerList(n) {
    const m = this.cardLayers;
    if (m?.ai !== this.ai || m.byId !== this.byId || m.n !== n) this.cardLayers = { ai: this.ai, byId: this.byId, n, list: layersForNode(this.ai?.steps, n, (s) => this.filesOf(s)) };
    return this.cardLayers.list;
  },
  // The Layer analysis tab: a bordered box per layer; its header opens what the Layers view shows of it, drawn inside
  // the box so it reads as that layer's, the card's flows one click away. Open layer goes to it in the Layers view.
  // Riskiest first; the first layer starts open, the rest closed (cardLayersOpen: key -> true/false once toggled). Each
  // shows its highlight (the analysis' own one-line finding, whatever it is) even closed, with a bar in its risk colour.
  archCardLayers(t, n, list) {
    const open = (this.cardLayersOpen ??= new Map()), rank = { high: 0, medium: 1, low: 2, skim: 3 };
    const sorted = list.map((s, i) => [s, i]).sort(([a, i], [b, k]) => (rank[a.risk] ?? 4) - (rank[b.risk] ?? 4) || i - k).map(([s]) => s);
    return v_flex().gap(6).children(sorted.map((s, j) => {
      const key = `${n.id}|${stepKey(s)}`, on = open.get(key) ?? j === 0, id = `rv-acl-${j}`;
      return v_flex().rounded(8).border_1().border_color(on ? t.accent : t.border)
        .child(h_flex().id(`${id}-show`).px(10).py(6).gap(8).items_center().rounded(8).cursor_pointer().hover((x) => x.bg(t.hover))
          .tooltip(on ? "Hide this layer's analysis" : "Show this layer's explanation, check questions and pictures here")
          .on_click((_e, cx) => { open.set(key, !on); cx.notify(); })
          .child(div().flex_none().w(12).text_color(t.muted).child(on ? "▾" : "▸"))
          .child(div().min_w(0).truncate().text_size(13.5).font_semibold().child(plain(s.title)))
          .when(Boolean(s.risk), (e) => e.child(riskBadge(t, s).id(`${id}-risk`).tooltip(focusTip(s)))))
        .when(Boolean(s.why), (e) => e.child(div().mx(10).mb(8).pl(10).border_l(3).border_color(focusColor(t, s))
          .text_size(14).font_semibold().line_height(1.45).child(TextView.markdown(`${id}-why-${stepKey(s)}`, s.why))))
        .when(on, (e) => e.child(v_flex().pl(30).pr(10).pt(8).pb(10).gap(6).border_t(1).border_color(t.border)
          .children(this.layerParts(s, t, "rv-acl", j, `arch:${stepKey(s)}`))
          .child(div().id(`${id}-go`).self_start().text_size(12.5).text_color(t.accent).cursor_pointer().hover((x) => x.underline()).tooltip("Go to this layer in the Layers view")
            .on_click((_e, cx) => { this.goStep(this.steps().indexOf(s), cx); cx.notify(); }).child("Open layer →"))));
    }));
  },
  // What the card is, as key: value rows: its file (path:line, a click opens it; how many changed places of this PR are
  // in it) and its links to the other cards, incoming first, one line each (a click shows that card).
  archCardFacts(t, a, n, at) {
    const path = at ? String(at).replace(/:\d+.*$/, "") : null;
    const hs = path ? [...(this.fileHunks ?? new Map())].filter(([p]) => p === path || p.endsWith(`/${path}`) || path.endsWith(`/${p}`)).flatMap(([, h]) => h) : [];
    const name = (id) => a.nodes.find((x) => x.id === id)?.label ?? id;
    const into = (e) => (e.to === n.id ? 0 : 1);
    const links = (a.edges ?? []).map((e, i) => [e, i]).filter(([e]) => e.from === n.id || e.to === n.id).sort(([x], [y]) => into(x) - into(y));
    const row = (label, body) => h_flex().gap(8).items_start().child(div().flex_none().w(84).text_color(t.muted).child(label)).child(body.flex_1().min_w(0));
    return v_flex().gap(4).text_size(12.5).line_height(1.5)
      .child(row("File", at ? h_flex().gap(8).flex_wrap()
        .child(div().id("rv-arch-card-file").text_color(t.accent).cursor_pointer().hover((s) => s.underline()).tooltip("Open this place in the code").on_click((_e, cx) => this.jumpTo(at, cx)).child(String(at)))
        .child(div().text_color(t.muted).child(hs.length ? `${hs.length} changed ${hs.length === 1 ? "place" : "places"} in this PR` : "not in this PR's diff"))
        : div().text_color(t.muted).child("The analysis names no file for this card (Ask names it)")))
      .when(links.length > 0, (e) => e.child(row("Connections", v_flex().gap(2).children(links.map(([x, i]) => {
        const out = x.from === n.id, other = out ? x.to : x.from, arrow = out ? "→" : "←";
        // The label on one line; the whole text in the tooltip.
        return h_flex().id(`rv-arch-card-l${i}`).gap(6).min_w(0).rounded(4).cursor_pointer().hover((s) => s.bg(t.hover))
          .tooltip(`${arrow} ${name(other)}${x.label ? `: ${x.label}` : ""}. Click to show it`).on_click((_e, cx) => { this.archFocus = other; cx.notify(); })
          .child(div().flex_none().text_color(t.muted).child(arrow))
          .child(div().flex_none().font_semibold().child(name(other)))
          .when(Boolean(x.label), (e) => e.child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(x.label)));
      })))));
  },
  // Wrap: only when clicked (by itself the page would jump whenever the room changes).
  archWrapOn() { return this.archWrap === true; },
  // The picture shown: its layout with normal or narrow cards (Fit), memoized like stack.js archModel.
  archFitOn() {
    if (this.archFit !== undefined) return this.archFit;
    const a = this.ai?.arch;
    return Boolean(a) && archModel(a, this.archMode).width > 1.3 * (this.hs?.get("rv-arch-canvas")?.viewW || 1e9); // auto: much wider than the view
  },
  archL() {
    const a = this.ai?.arch;
    if (!a) return null;
    const fit = this.archFitOn(), key = `${fit}|${this.archMode}|${JSON.stringify(a)}`; // per render: memoized, both kinds
    if (this.fitMemo?.key !== key) this.fitMemo = { key, L: fit ? archLayout(a, this.archMode, () => 0, true) : archModel(a, this.archMode) };
    return this.fitMemo.L;
  },
  // ---- sideways scrollers inside the scrolling page (the architecture canvas, the flow, state-machine and blast
  // pictures): clipped at their box, the content moved by left(-x); wheel and trackpad through wheelStep (one axis per
  // gesture, so page and picture never move together; shift+wheel sideways), drag to pan, a thumb bar when wider than
  // the view. Per id in this.hs: {x, viewW, maxX, contentW}; one gesture (this.gesture) and one drag (this.hsDrag).
  hsOf(id) { const m = (this.hs ??= new Map()); if (!m.has(id)) m.set(id, { x: 0, viewW: 0, maxX: 0, contentW: 0 }); return m.get(id); },
  wrapX() { return (this.wrapXFn ??= (id, w, h, el) => this.hscroll(id, w, h, el)); }, // stack.js visualsCard's wrapX
  hscroll(id, contentW, h, content, t = theme()) {
    // viewW: what shows of the picture, the part under the Ask drawer (drawerCover) left out.
    const s = this.hsOf(id), viewW = hsVisible(s.viewW || 800, this.drawerCover()), maxX = Math.max(0, contentW - viewW), x = Math.min(s.x, maxX);
    s.maxX = maxX; s.contentW = contentW; s.visW = viewW; // for the wheel and drag handlers
    return v_flex().w_full().gap(4)
      .child(div().id(id).w_full().h(h).relative().overflow_hidden().when(maxX > 0, (e) => e.cursor_grab())
        .on_size_change((size, cx) => { if (Math.abs(s.viewW - size.width) > 2) { s.viewW = size.width; cx.notify(); } })
        .on_scroll_wheel((e, cx) => this.hsWheel(id, e, cx))
        .on_mouse_down("left", (e) => { if (maxX > 0) this.hsDrag = { id, x0: e.position.x, from: x }; })
        .child(div().absolute().top(0).left(-x).w(contentW).h(h).children([].concat(content))))
      .when(maxX > 0, (e) => e.child(div().id(`${id}-hbar`).tooltip("Scroll bar for the picture").w(viewW).h(10).relative().rounded(5).bg(t.raised)
        .child(div().id(`${id}-thumb`).tooltip("Drag to scroll the picture sideways").absolute().top(1).left(Math.round((x / contentW) * viewW)).w(Math.max(30, Math.round((viewW * viewW) / contentW))).h(8).rounded(4).bg(t.muted).cursor_pointer()
          .on_mouse_down("left", (ev, cx) => { this.hsDrag = { id, x0: ev.position.x, from: x, thumb: true }; cx.stop_propagation(); }))));
  },
  hsWheel(id, e, cx) {
    const s = this.hsOf(id), r = wheelStep(this.gesture, { dx: e.delta?.x ?? 0, dy: e.delta?.y ?? 0, t: Date.now(), phase: e.touch_phase, shift: Boolean(e.modifiers?.shift) }, s.x, s.maxX);
    this.gesture = r.g;
    if (!r.used) return;
    s.x = r.x; cx.stop_propagation();
    // One render per frame at most: a trackpad sends more events than frames.
    if (!this.hsFlush) { this.hsFlush = true; cx.timer.after(16, (cx) => { this.hsFlush = false; cx.notify(); }); }
  },
  // A drag on a picture (pan) or its thumb, from the root's mouse move; the root's mouse up ends it.
  hsMove(e, cx) {
    const p = this.hsDrag, s = p && this.hs?.get(p.id);
    if (!s) return;
    const d = e.position.x - p.x0;
    s.x = Math.max(0, Math.min(s.maxX, p.thumb ? p.from + (d * s.contentW) / (s.visW || 1) : p.from - d)); cx.notify();
  },

  // The two deep looks, side by side on a fresh review: the analysis (understanding) and the code review (findings).
  startCards(t) {
    const m = model(), cr = this.find.runs.claude ?? {};
    const card = (id, label, what, click, busy) => v_flex().id(id).flex_1().min_w(0).gap(6).p(12).rounded(10).border_1().border_color(t.border).bg(t.surface)
      .child(div().id(`${id}-go`).flex_none().px(12).h(30).flex().items_center().justify_center().rounded(8).text_size(13).font_semibold().bg(busy ? t.raised : t.solid)
        .text_color(busy ? t.muted : t.solid_foreground).cursor_pointer().on_click(click).child(busy ? `${label}…` : label))
      .child(div().text_size(12.5).text_color(t.muted).whitespace_normal().child(what));
    return h_flex().gap(12).items_start()
      .child(card("rv-start-ai", `Analyze with ${modelLabel(m)}`, `Understand the change: layers in reading order, pictures, sample values and a walkthrough. ${this.estimate(m)}.`, (_e, cx) => this.loadAi(cx, "run"), Boolean(this.aiBusy)))
      .child(card("rv-start-cr", "Run Claude code review", "Find problems: bugs and risks as findings on their lines, each with Fix and Verify.", (_e, cx) => this.runReviewer("claude", cx), Boolean(cr.busy)));
  },

  // ---- Ask about this (review.py main_ask, "Review: architecture question"): a question on the picture, a node or a
  // layer; the answer lights its nodes and edges (the focus mechanism) and links its evidence. One thread per PR.

  deepKey() { return this.exMode ? (this.ex?.id ? `explore:${this.ex.id}` : null) : this.prSel?.url ?? null; },
  // What a question is about: on the Architecture page the focused card (else the whole picture); else what was picked
  // to ask about (a layer), else the selected lines in the diff.
  askFocus() {
    if (this.tab === "steps" && this.page === "arch") return this.archFocus ? { node: this.archFocus } : null;
    if (this.askAbout) return this.askAbout;
    const a = this.fsel && this.selAnchor();
    return a ? { range: { file: this.fsel.path, start: a.start, end: a.end, old: a.old } } : null;
  },
  askLabel(scope) {
    return scope.kind === "node" ? scope.node.label ?? scope.node.id : scope.kind === "layer" ? plain(scope.layer.title) : scope.kind === "range" ? rangeLabel(scope.range) : "the architecture";
  },

  // ---- Show details (review.py main_drill, "Review: drill down"): a card or a layer from the inside, a sub-diagram
  // inline under the picture with a breadcrumb; its cards open further. Cached per node path and diff head (deep.json).

  layerSubject(s) {
    const files = this.filesOf ? this.filesOf(s) : [];
    return { id: `layer:${stepKey(s)}`, label: plain(s.title), kind: "layer", why: plain(s.why), text: s.text, files, evidence: s.evidence ?? [], hunks: s.hunks };
  },
  drillCacheKey(stack) { return drillKey(this.deepKey(), this.headNow?.() ?? this.head ?? "", stack); },
  drillResult(stack) { return this.deep.drills?.[this.drillCacheKey(stack)] ?? null; },
  // Drill-downs per place (from: a layer, "arch:<card id>"), each with its own stack: several run at once, and each
  // place shows its own when you come back to it. fresh: start at the item (a card's Explain), not one level deeper.
  drillAt(from) { return (this.drills ??= new Map()).get(from) ?? null; },
  setDrill(from, stack) { if (stack?.length) (this.drills ??= new Map()).set(from, { from, stack }); else this.drills?.delete(from); },
  showDetails(item, from, cx, force = false, fresh = false) {
    const stack = drillPush(fresh ? [] : this.drillAt(from)?.stack ?? [], item);
    this.setDrill(from, stack);
    if (force || !this.drillResult(stack)) this.runDrill(cx, from);
    cx.notify();
  },
  runDrill(cx, from) {
    const d = this.drillAt(from), ai = this.ai, key = this.deepKey(), busy = (this.drillsBusy ??= new Set()), errs = (this.drillErrs ??= new Map());
    if (!d || !ai) return;
    const top = d.stack.at(-1), ck = this.drillCacheKey(d.stack), root = d.from.startsWith("arch") ? "Architecture" : plain(d.stack[0]?.label ?? "Layer");
    if (busy.has(ck)) return;
    const subject = { ...top, parent: d.stack.length > 1 ? d.stack.at(-2).label : null };
    const scope = top.kind === "node" ? scopeOf(ai, { node: top.id }) : top.kind === "layer" ? { kind: "layer", layer: { title: top.label, why: top.why, text: top.text, visuals: [], evidence: top.evidence } }
      : { kind: "node", node: { id: top.id, label: top.label, evidence: top.at ?? null }, edges: [] };
    const files = [...new Set([...(top.files ?? []), ...scopeFiles(scope)])];
    const req = { drill: { label: top.label, path: crumbs(d.stack, root).map((c) => c.label), subject }, model: model(), context: this.ctxReq(), root: this.lspRoot(), explore: Boolean(ai.explore),
      analysis: { title: ai.title, summary: ai.summary, layers: ai.steps.filter((x) => !x.pseudo).map((x) => ({ title: plain(x.title), why: plain(x.why) })) },
      picture: pictureOf(ai.arch), scope, hunks: hunksFor(files, this.exMode ? [] : this.hunks, top.hunks ?? []) };
    busy.add(ck); errs.delete(ck);
    cx.spawn(async (cx) => {
      const r = await exec("python3", [`${appHome()}/mods/pr-review/review.py`, JSON.stringify(req)], { timeout: 600000 }).catch((e) => ({ code: 1, stderr: String(e) }));
      busy.delete(ck);
      if (this.deepKey() !== key) return;
      if (r.code !== 0) { errs.set(ck, `Could not show details: ${(r.stderr || r.stdout).trim().slice(0, 200)}`); return cx.notify(); }
      const out = JSON.parse(r.stdout);
      this.updateDeep(cx, (doc) => ({ ...doc, drills: cachePut(doc.drills, ck, { ...mapDrill(out.answer), cost: out.cost }) }));
      cx.notify();
    });
  },
  // The sub-diagram under the picture (or the layer): breadcrumb (click a level to go back), the summary, the picture
  // with sample values, its cards to open further, Refresh and ✕.
  drillPanel(t, from) {
    const d = this.drillAt(from);
    if (!d) return div();
    const res = this.drillResult(d.stack), ck = this.drillCacheKey(d.stack), root = from.startsWith("arch") ? "Architecture" : "Layer", top = d.stack.at(-1);
    const busy = this.drillsBusy?.has(ck), err = this.drillErrs?.get(ck);
    const crumb = (c, k) => div().id(`rv-crumb-${k}`).flex_none().text_size(12.5).text_color(c.depth === null ? t.muted : k === crumbs(d.stack, root).length - 1 ? t.foreground : t.accent)
      .when(c.depth !== null && k < crumbs(d.stack, root).length - 1, (e) => e.cursor_pointer().tooltip("Go back to this level").on_click((_e, cx) => { this.setDrill(from, c.depth === 0 ? null : drillTo(d.stack, c.depth)); cx.notify(); }))
      .child(c.label);
    return v_flex().id(`rv-drill-${from}`).gap(8).p(12).rounded(10).border_1().border_color(t.border).bg(t.surface)
      .child(h_flex().flex_wrap().gap(6).items_center()
        .children(crumbs(d.stack, root).flatMap((c, k) => (k ? [div().text_color(t.dim).text_size(12).child("›"), crumb(c, k)] : [crumb(c, k)])))
        .child(div().flex_1())
        .child(busy ? h_flex().gap(6).text_size(12).text_color(t.muted).child(div().child(SPIN[0]).frames(SPIN, 90)).child("Reading the code…")
          : pill(`rv-drill-re-${from}`, t, "↻ Refresh", (_e, cx) => { this.runDrill(cx, from); cx.notify(); }).tooltip("Run the model call again for a fresh answer"))
        .child(pill(`rv-drill-x-${from}`, t, "✕", (_e, cx) => { this.setDrill(from, null); cx.notify(); }).tooltip("Close the details").accessibility_label("Close details")))
      .when(Boolean(err), (e) => e.child(div().text_size(12.5).text_color(t.ansi1).whitespace_normal().child(err)))
      .when(!res && !busy && !err, (e) => e.child(div().text_size(12.5).text_color(t.muted).child(`One ${modelLabel(model())} call opens up ${top.label}.`)))
      .when(Boolean(res), (e) => e.child(div().text_size(13).line_height(1.5).child(TextView.markdown(`rv-drill-s-${from}-${d.stack.length}-${top.id}`, res.summary || "")))
        .child(visualCard(res.visual, t, `rv-drill-v-${from}`, (at, cx) => this.jumpTo(at, cx)))
        .when(res.visual.nodes.length > 0, (x) => x.child(h_flex().flex_wrap().gap(4).items_center().child(div().text_size(12).text_color(t.muted).child("Open further:"))
          .children(res.visual.nodes.map((n) => pill(`rv-drill-n-${from}-${n.id}`, t, n.label, (_e, cx) => this.showDetails({ id: `${top.id}/${n.id}`, label: n.label, at: n.at, kind: "sub", note: n.note }, from, cx)).tooltip("Show details of this part: one more model call"))))));
  },

  // ---- Explore: a topic walked through in existing code (explore.py, "Explore: walkthrough"), shown like an analysis
  // without a diff: Overview, Layers, Architecture; Files lists the places it cites (the read-only file view, with
  // go-to-definition). Ask and Show details work as for a PR. Explorations are kept per repo and topic (the newest 20).

  async loadExploreIndex(cx) {
    const doc = JSON.parse(await readTextFile(`${exploreDir()}/index.json`).catch(() => null) ?? "[]");
    this.exIndex = Array.isArray(doc) ? doc : []; cx.notify();
  },
  // The repo a new exploration starts in: the one chosen, else the active space's (its git root).
  async exploreRoot(dir) {
    const r = dir ? await exec("git", ["-C", dir, "rev-parse", "--show-toplevel"]).catch(() => null) : null;
    const root = r?.code === 0 ? r.stdout.trim() : dir;
    const remote = root ? await exec("git", ["-C", root, "remote", "get-url", "origin"]).catch(() => null) : null;
    const repo = repoOfRemote(remote?.code === 0 ? remote.stdout : ""); // only a github.com remote names a repo
    return { root, repo };
  },
  // Your own repos are trusted (a github.com repo whose owner is your gh login, or a repo or folder you trusted); a
  // folder without a github.com remote starts in Restricted Mode, as PRs by someone else do.
  exploreTrusted(ex = this.ex) {
    return exploreTrust({ repo: ex?.repo ?? null, root: ex?.root ?? null, login: shared("gh.login"), trustedRepos: shared("pr-review.trustedRepos") ?? [], trustedRoots: shared("pr-review.trustedRoots") ?? [] });
  },
  applyExploreTrust() { if (this.ex?.root) setTrusted(this.ex.root, this.exploreTrusted()); },
  enterExplore(ex, cx) {
    if (!this.exMode) { this.prAiSaved = this.ai; this.exMode = true; }
    this.exStart = ex; this.ai = this.exAi ?? null;
    if (!this.exIndex) { this.exIndex = []; cx.timer.after(0, (cx) => this.loadExploreIndex(cx)); }
    if (ex.start && !this.exRoot) {
      cx.timer.after(0, (cx) => cx.spawn(async (cx) => {
        const dir = ex.root ?? spaces().find((x) => x.id === ex.space)?.folder ?? spaces().find((x) => x.active)?.folder ?? null;
        this.exRoot = await this.exploreRoot(dir); cx.notify();
      }));
    }
  },
  leaveExplore() { if (this.exMode) { this.exMode = false; this.ai = this.prAiSaved ?? null; this.defFile = null; this.drills = null; } },
  chooseExploreRepo(cx) {
    cx.spawn(async (cx) => { const dir = await pickFolder({ prompt: "Repository to explore" }); if (dir) { this.exRoot = await this.exploreRoot(dir); cx.notify(); } });
  },
  runExplore(cx) {
    const topic = this.exTopic.value().trim(), r = this.exRoot, m = model();
    if (!topic || !r?.root || this.exBusy) return;
    const id = exploreId(r.root, topic), out = `${exploreDir()}/${id}.json`, status = `${out}.status`;
    const ctx = C.spaceContext(ctxDoc(), this.exStart?.space ?? focused()?.space);
    const req = { root: r.root, repo: r.repo, topic, model: m, context: this.ctxReq(ctx), out, status };
    this.exBusy = { id, topic, model: m, started: Date.now(), status, out, ctx }; this.exErr = null;
    cx.spawn(async (cx) => {
      await exec("mkdir", ["-p", exploreDir()]).catch(() => null);
      const reqFile = `${out}.req.json`, before = await readTextFile(reqFile).catch(() => null);
      await writeTextFile(reqFile, JSON.stringify(req), before).catch(() => null);
      await exec("sh", ["-c", 'nohup python3 "$0" "$1" >/dev/null 2>&1 &', `${appHome()}/mods/pr-review/explore.py`, `@${reqFile}`]).catch((e) => { this.exErr = String(e); this.exBusy = null; });
      this.pollExplore(cx); cx.notify();
    });
    cx.notify();
  },
  pollExplore(cx) {
    cx.timer.after(5000, (cx) => cx.spawn(async (cx) => {
      const b = this.exBusy;
      if (!b) return;
      const st = JSON.parse(await readTextFile(b.status).catch(() => null) ?? "null");
      if (!st || st.busy) { cx.notify(); return this.pollExplore(cx); }
      this.exBusy = null;
      if (st.error) { this.exErr = st.error; return cx.notify(); }
      const entry = { id: b.id, topic: b.topic, root: this.exRoot.root, repo: this.exRoot.repo, model: b.model, ctx: b.ctx, at: Date.now() };
      const before = await readTextFile(`${exploreDir()}/index.json`).catch(() => null), next = exploreIndex(before ? JSON.parse(before) : [], entry);
      await writeTextFile(`${exploreDir()}/index.json`, JSON.stringify(next.list, null, 1), before).catch(() => null);
      for (const old of next.dropped) exec("rm", ["-f", `${exploreDir()}/${old}.json`, `${exploreDir()}/${old}.json.status`, `${exploreDir()}/${old}.json.req.json`]).catch(() => null);
      this.exIndex = next.list;
      this.openExploration(b.id, cx);
    }));
  },
  openExploration(id, cx) {
    cx.spawn(async (cx) => {
      const text = await readTextFile(`${exploreDir()}/${id}.json`).catch(() => null);
      if (!text) { this.exErr = "That exploration is gone"; return cx.notify(); }
      const entry = (this.exIndex ?? []).find((x) => x.id === id) ?? {};
      this.exAi = exploreAi(JSON.parse(text));
      this.ex = { id, root: this.exAi.root, repo: this.exAi.repo, topic: this.exAi.topic, ctx: entry.ctx ?? null };
      this.ai = this.exAi; this.page = "overview"; this.tab = "steps"; this.defFile = null; this.drills = null; this.archFocus = null;
      this.applyExploreTrust();
      setShared("review.explore", { id, topic: this.ex.topic, repo: this.ex.repo, root: this.ex.root, at: Date.now() });
      cx.notify();
    });
  },
  // A cited file in the read-only view at a line (go-to-definition works there: the repo is local).
  openExploreFile(path, line, cx) {
    const root = this.ex?.root;
    if (!root || !path) return;
    cx.spawn(async (cx) => {
      const text = await readTextFile(`${root}/${path}`).catch(() => null);
      if (text === null) { this.note = `Could not open ${path}`; return cx.notify(); }
      const all = text.replace(/\n$/, "").split("\n"), from = Math.max(0, line - 3000), lines = all.slice(from, from + 6000).map(expandTabs);
      this.defFile = { path, line, from, lines, spans: highlightLines(lines, langOf(path), `explore:${root}:${path}:${from}`) };
      this.lists.def.scroll_to_item(Math.max(0, line - from - 1), "center"); // as in goDef
      cx.notify();
    });
  },

  // The bar in Explore: back, the topic, the repo, Restricted Mode, a new topic.
  renderExploreBar(ex) {
    const t = theme(), title = ex.topic ? `Explore: ${ex.topic}` : "Explore a topic", trusted = this.exploreTrusted(ex);
    return h_flex().id("rv-bar").size_full().pl(84).pr(16).gap(12).items_center().bg(t.chrome).text_color(t.foreground).text_size(13.5)
      .child(pill("rv-back", t, "← Back", () => { setShared("review.explore", null); if (!shared("review.target")) leave(); }).tooltip("Leave Explore and return to the previous layout (Esc)").flex_none())
      .child(div().id("rv-title").flex_1().min_w(0).truncate().font_semibold().text_size(14).tooltip(title).child(title))
      .when(Boolean(ex.repo), (e) => e.child(div().id("rv-ex-repo").tooltip("The repository being explored").flex_none().text_size(12).text_color(t.muted).child(ex.repo)))
      .when(Boolean(ex.id) && !trusted, (e) => e.child(div().id("rv-ex-trust-wrap").flex_none().tooltip("Restricted Mode: language servers run nothing from this code, so go-to-definition may find less. Trust it only if it is yours.")
        .child(pill("rv-ex-trust", t, ex.repo ? `Restricted Mode · Trust ${ex.repo}` : "Restricted Mode · Trust folder", () => run("pr-review.trust-repo"), false, t.ansi3))))
      .when(Boolean(ex.id), (e) => e.child(pill("rv-ex-new", t, "New topic", () => setShared("review.explore", { start: true, root: ex.root, at: Date.now() })).tooltip("Start another exploration").flex_none()));
  },

  renderExplore(cx, ex, root) {
    const t = theme();
    if (!ex.id || ex.start) return root.child(this.exploreStart(t));
    if (!this.exAi || this.ex?.id !== ex.id) { if (this.exOpening !== ex.id) { this.exOpening = ex.id; cx.timer.after(0, (cx) => this.openExploration(ex.id, cx)); } return root.child(div().p(20).text_color(t.muted).child("Opening…")); }
    const ai = this.exAi, files = ai.files ?? [], tab = this.tab === "files" ? "files" : "steps";
    const tabBtn = (id, label) => div().id(`rv-tab-${id}`).tooltip(id === "files" ? "The files this walkthrough cites" : "The walkthrough's layers, in reading order").flex_1().h(32).flex().items_center().justify_center().rounded(7).text_size(13.5).cursor_pointer()
      .bg(tab === id ? t.selected : t.chrome).text_color(tab === id ? t.foreground : t.muted).on_click((_e, cx) => { this.tab = id; cx.notify(); }).child(label);
    const nav = (k, label) => h_flex().id(`rv-exnav-${k}`).tooltip(`Open the ${label} page`).flex_none().h(30).px(10).items_center().rounded(7).cursor_pointer().when(this.page === k, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.page = k; this.defFile = null; cx.notify(); }).child(div().text_size(13.5).font_semibold().text_color(this.page === k ? t.foreground : t.muted).child(label));
    const left = tab === "files"
      ? v_flex().id("rv-exfiles").flex_1().min_h(0).overflow_y_scroll().p(8).gap(2).child(div().px(6).pb(4).text_size(12).text_color(t.muted).child(`${files.length} files the walkthrough cites`))
        .children(files.map((f) => h_flex().id(`rv-exf-${f.path}`).tooltip("Open this file at the line the walkthrough cites").gap(8).px(8).h(28).items_center().rounded(6).cursor_pointer().when(this.defFile?.path === f.path, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.openExploreFile(f.path, f.lines[0] ?? 1, cx))
          .child(div().flex_1().min_w(0).truncate().text_size(13).child(f.path)).child(div().flex_none().text_size(11.5).text_color(t.muted).child(f.lines.slice(0, 3).map((l) => `:${l}`).join(" ")))))
      : v_flex().id("rv-exlayers").flex_1().min_h(0).overflow_y_scroll().p(8).gap(4)
        .child(nav("overview", "Overview")).child(nav("arch", "Architecture"))
        .child(div().pt(8).px(10).text_size(11.5).font_semibold().text_color(t.muted).child("LAYERS"))
        .children(ai.steps.map((s, i) => v_flex().id(`rv-exl-${i}`).px(10).tooltip("Open this layer of the walkthrough").py(8).gap(2).rounded(8).cursor_pointer().when(this.page === `layer:${i}`, (e) => e.bg(t.selected)).hover((x) => x.bg(t.hover))
          .on_click((_e, cx) => { this.page = `layer:${i}`; this.cur = i; this.defFile = null; cx.notify(); })
          .child(h_flex().gap(8).child(div().w(18).flex_none().text_color(t.muted).child(String(i + 1))).child(div().flex_1().min_w(0).truncate().text_size(14).font_semibold().child(plain(s.title))))
          .child(div().pl(26).text_size(12.5).text_color(t.muted).truncate().child(plain(s.why)))));
    const page = this.defFile ? this.defView(t) : div().flex_1().min_h(0).relative()
      .child(v_flex().id(`rv-expage-${this.page}`).absolute().inset_0().overflow_y_scroll().px(24).py(18).gap(14)
        .child(this.page === "arch" ? this.archPage(t) : this.page?.startsWith("layer:") ? this.exploreLayer(t, Number(this.page.slice(6))) : this.exploreOverview(t)))
      .child(Scrollbar.vertical(`rv-expage-${this.page}`).absolute().inset_0());
    return root
      .child(h_flex().flex_1().min_h(0)
        .child(v_flex().w(this.leftW()).flex_none().h_full().bg(t.chrome)
          .child(h_flex().flex_none().p(8).gap(6).border_b(1).border_color(t.border).child(tabBtn("files", `Files · ${files.length}`)).child(tabBtn("steps", `Layers · ${ai.steps.length}`)))
          .child(left))
        .child(this.splitter(t))
        .child(v_flex().flex_1().min_w(0).h_full().relative()
          .child(div().id("rv-probe").absolute().top(-100).font_family(settings().font_family ?? "JetBrains Mono").text_size(13).whitespace_nowrap()
            .on_size_change((size, cx) => { const w = size.width / PROBE.length; if (w > 0 && Math.abs((this.charW ?? 0) - w) > 0.01) { this.charW = w; cx.notify(); } }).child(PROBE))
          .child(page)
          .when(Boolean(this.note), (e) => e.child(div().flex_none().px(14).py(8).border_t(1).border_color(t.border).text_size(12.5).text_color(t.muted).child(this.note)))
          .when(this.drawerState() === "open", (e) => e.child(div().absolute().top(0).right(0).bottom(0).child(this.askDrawer(t))))
          .when(this.drawerState() === "collapsed", (e) => e.child(div().absolute().top(0).right(0).bottom(0).child(this.drawerStrip(t))))));
  },

  exploreOverview(t) {
    const ai = this.exAi;
    return v_flex().gap(14).max_w(1000)
      .child(div().text_size(12).text_color(t.muted).child(`${modelLabel(ai.model) ?? ai.model ?? ""}${ai.cost != null ? ` · $${Number(ai.cost).toFixed(3)}` : ""}${ai.budget ? ` of $${ai.budget} cap` : ""} · ${ago(ai.generated)} · ${ai.repo ?? ai.root}`))
      .child(div().text_size(22).font_semibold().line_height(1.3).whitespace_normal().child(ai.title || ai.topic))
      .child(div().text_size(14).line_height(1.5).whitespace_normal().child(TextView.markdown(`rv-exs-${ai.generated}`, ai.summary || "")))
      .child(h_flex().gap(8).child(pill("rv-ex-ask", t, "Ask about this", (_e, cx) => this.setDrawer("open", cx, null)).tooltip("Ask one model question about this exploration")).child(pill("rv-ex-arch", t, "Architecture", (_e, cx) => { this.page = "arch"; cx.notify(); }).tooltip("Open the architecture picture")))
      .when(ai.intent?.length > 0, (e) => e.child(v_flex().gap(4).child(div().text_size(12).font_semibold().text_color(t.muted).child("QUESTION")).child(this.statements(t, ai.intent, "rv-exq"))))
      .when(ai.behaviorPoints?.length > 0, (e) => e.child(v_flex().gap(4).child(div().text_size(12).font_semibold().text_color(t.muted).child("HOW IT WORKS")).child(this.statements(t, ai.behaviorPoints, "rv-exh"))))
      .child(v_flex().gap(4).child(div().text_size(12).font_semibold().text_color(t.muted).child("LAYERS, IN READING ORDER"))
        .children(ai.steps.map((s, i) => h_flex().id(`rv-exo-${i}`).tooltip("Open this layer of the walkthrough").gap(8).p(6).rounded(6).cursor_pointer().hover((x) => x.bg(t.hover)).on_click((_e, cx) => { this.page = `layer:${i}`; cx.notify(); })
          .child(div().w(18).flex_none().text_color(t.muted).child(String(i + 1))).child(div().flex_1().min_w(0).whitespace_normal().text_size(13.5).child(`${plain(s.title)}: ${plain(s.why)}`)))));
  },

  exploreLayer(t, i) {
    const s = this.exAi.steps[i];
    if (!s) return div();
    return v_flex().gap(12).max_w(1000)
      .child(div().text_size(20).font_semibold().whitespace_normal().child(`${i + 1}. ${plain(s.title)}`))
      .child(div().text_size(14).text_color(t.muted).whitespace_normal().child(plain(s.why)))
      .child(div().text_size(14).line_height(1.5).child(TextView.markdown(`rv-exl-${this.exAi.generated}-${i}`, s.text || "")))
      .when((s.evidence ?? []).length > 0, (e) => e.child(h_flex().flex_wrap().gap(6).children(s.evidence.map((ev, k) => pill(`rv-exev-${i}-${k}`, t, `${ev.split("/").pop()} ↗`, (_e, cx) => this.jumpTo(ev, cx)).tooltip("Open the cited code")))))
      .child(h_flex().gap(6).child(pill(`rv-exask-${i}`, t, "Ask about this layer", (_e, cx) => this.setDrawer("open", cx, { layer: this.exAi.steps.indexOf(s) })).tooltip("Ask one model question about this layer; the answer stays private"))
        .child(pill(`rv-exdrill-${i}`, t, "Show details", (_e, cx) => this.showDetails({ id: `layer:${i}`, label: plain(s.title), kind: "layer", why: plain(s.why), text: s.text, files: (s.evidence ?? []).map(pathOf), evidence: s.evidence ?? [] }, `exlayer:${i}`, cx)).tooltip("One model call breaks this layer down further")))
      .child(this.drillPanel(t, `exlayer:${i}`))
      .when(s.visuals?.length > 0, (e) => e.child(div().max_w(760).child(visualsCard(s.visuals, t, `rv-exvis-${i}`, (at, cx) => this.jumpTo(at, cx), this.visTab?.[`x${i}`] ?? 0, (k, cx) => { this.visTab = { ...this.visTab, [`x${i}`]: k }; cx.notify(); }, this.wrapX()))))
      .children((s.flows ?? []).map((f, k) => div().max_w(760).child(flowCard(f, t, `rv-exflow-${i}-${k}`, (_e, cx) => { this.jumpTo(f.at, cx); cx.stop_propagation(); }))));
  },

  // Start: the repo (the active space's, or any folder), the topic, the model with its cap, the explorations so far.
  exploreStart(t) {
    const r = this.exRoot, m = model(), busy = this.exBusy;
    return v_flex().id("rv-exstart").flex_1().min_h(0).overflow_y_scroll().items_center().py(40)
      .child(v_flex().w(640).gap(14)
        .child(div().text_size(22).font_semibold().child("Explore a topic"))
        .child(div().text_size(13.5).text_color(t.muted).whitespace_normal().child("For code you don't know: ask how something works and get a walkthrough of the existing code, like a PR analysis without a diff: the question, how it works, layers in reading order, the architecture, pictures and sample values, each with file:line."))
        .child(h_flex().gap(8).items_center().text_size(13)
          .child(div().flex_none().text_color(t.muted).child("Repository"))
          .child(div().flex_1().min_w(0).truncate().font_semibold().child(r?.root ? `${r.repo ?? r.root.split("/").pop()} · ${r.root.replace(home(), "~")}` : "Finding the active space's repo…"))
          .child(pill("rv-ex-pick", t, "Choose folder…", (_e, cx) => this.chooseExploreRepo(cx)).tooltip("Pick another folder to explore")))
        .child(div().id("rv-ex-topic").tooltip("Your topic or question about this code; Enter starts the walkthrough").h(36).px(10).flex().items_center().rounded(8).border_1().border_color(t.accent).bg(t.background).cursor_text()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.exTopic).h_full().text_size(14).text_color(t.foreground)))
        .child(h_flex().gap(10).items_center()
          .child(modelPills(t, "rv-ex-m"))
          .child(div().text_size(12).text_color(t.muted).child(`cap $${CAP[tierOf(m)]}`))
          .child(div().flex_1())
          .child(div().id("rv-ex-go").tooltip("One model call walks through the code for this topic; the cost is capped").px(14).h(32).flex().items_center().rounded(8).text_size(13.5).font_semibold().bg(busy ? t.raised : t.solid).text_color(busy ? t.muted : t.solid_foreground)
            .cursor_pointer().on_click((_e, cx) => this.runExplore(cx)).child(busy ? "Exploring…" : "Explore")))
        .when(Boolean(busy), (e) => e.child(h_flex().gap(8).items_center().text_size(13).text_color(t.muted).child(div().child(SPIN[0]).frames(SPIN, 90))
          .child(`${modelLabel(busy.model)} is reading the code · ${clock(Date.now() - busy.started)} · cap $${CAP[tierOf(busy.model)]}`)))
        .when(Boolean(this.exErr), (e) => e.child(div().text_size(12.5).text_color(t.ansi1).whitespace_normal().child(this.exErr)))
        .when((this.exIndex ?? []).length > 0, (e) => e.child(div().pt(10).text_size(11.5).font_semibold().text_color(t.muted).child(`EXPLORATIONS · ${this.exIndex.length}`))
          .children(this.exIndex.map((x) => h_flex().id(`rv-exi-${x.id}`).tooltip("Open this saved exploration").gap(8).px(8).h(32).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => this.openExploration(x.id, cx))
            .child(div().flex_1().min_w(0).truncate().text_size(13.5).child(x.topic))
            .child(div().flex_none().text_size(12).text_color(t.muted).child(`${x.repo ?? String(x.root).split("/").pop()} · ${ago(new Date(x.at).toISOString())}`))))));
  },

  // ---- the Ask drawer, one for every view: open (380 px at the right), folded to a 28 px strip, or closed; kept per
  // review. Over the Architecture page it lies on top (the picture keeps its width); beside the diff it squeezes the
  // diff when there is room (from 1100 px), else it lies on top too.
  drawerState() { return this.deep.drawer?.[this.deepKey()] ?? null; },
  setDrawer(state, cx, about) {
    const key = this.deepKey();
    if (about !== undefined) this.askAbout = about;
    if (state === "open") { this.askUnseen = false; cx.timer.after(0, () => this.askIn.focus()); }
    this.updateDeep(cx, (d) => ({ ...d, drawer: { ...d.drawer, [key]: state } }));
    cx.notify();
  },
  // Px of the right column the drawer lies on (not when it squeezes the column): open 380, folded strip 28.
  drawerCover() { const d = this.drawerState(); return d === "open" ? (this.drawerSqueezes() ? 0 : 380) : d === "collapsed" ? 28 : 0; },
  drawerSqueezes() { return this.drawerState() === "open" && !(this.tab === "steps" && this.page) && (this.winW ?? 0) - this.leftW() - SPLIT >= 1100; },

  askNow(cx) {
    const q = this.askIn.value().trim(), ai = this.ai, key = this.deepKey();
    if (!ai && q) { this.askErr = "Analyze first: answers build on the analysis"; return cx.notify(); }
    if (!q || !ai || !key || this.askBusy) return;
    const scope = scopeOf(ai, this.askFocus()), layer = scope.kind === "layer" ? this.ai.steps.find((s) => plain(s.title) === plain(scope.layer.title)) : null;
    const req = { ask: q, model: model(), context: this.ctxReq(), root: this.lspRoot(), explore: Boolean(ai.explore),
      analysis: { title: ai.title, summary: ai.summary, layers: ai.steps.filter((s) => !s.pseudo).map((s) => ({ title: plain(s.title), why: plain(s.why) })) },
      picture: pictureOf(ai.arch), scope, hunks: hunksFor(scopeFiles(scope), this.exMode ? [] : this.hunks, layer?.hunks ?? []), history: history(threadOf(this.deep.threads, key)) };
    const about = this.askLabel(scope);
    this.askBusy = { q, label: about, started: Date.now() }; this.askErr = null;
    cx.spawn(async (cx) => {
      const r = await exec("python3", [`${appHome()}/mods/pr-review/review.py`, JSON.stringify(req)], { timeout: 600000 }).catch((e) => ({ code: 1, stderr: String(e) }));
      this.askBusy = null;
      if (this.deepKey() !== key) return;
      if (r.code !== 0) { this.askErr = `Could not ask: ${(r.stderr || r.stdout).trim().slice(0, 200)}`; return cx.notify(); }
      const out = JSON.parse(r.stdout), a = mapAnswer(out.answer, ai.arch);
      this.askIn.set_value("");
      const sc = scope.kind === "node" ? { kind: "node", node: { id: scope.node.id } } : scope.kind === "range" ? scope : { kind: scope.kind };
      this.updateDeep(cx, (d) => ({ ...d, threads: threadAdd(d.threads, key, { q, about, a, scope: sc, cost: out.cost }) }));
      if (this.drawerState() !== "open") this.askUnseen = true;
      this.showAnswer(a);
      cx.notify();
    });
    cx.notify();
  },

  // The answer's highlights on the Architecture page: its first node focused, its first edge's badge lit.
  showAnswer(a) {
    if (!this.ai?.arch) return;
    const h = highlightOf(this.archL(), a);
    if (h.focus) this.archFocus = h.focus;
    this.askHl = h.hl;
  },

  // deep.json changed by fn, here and in the file (compare-and-swap: another copy may write it too).
  updateDeep(cx, fn) {
    this.deep = fn(this.deep);
    cx.spawn(async () => {
      await exec("mkdir", ["-p", `${appHome()}/pr-data`]).catch(() => null);
      for (let attempt = 0; attempt < 3; attempt++) {
        const before = await readTextFile(deepFile()).catch(() => null), doc = before ? JSON.parse(before) : {};
        try { await writeTextFile(deepFile(), JSON.stringify(fn({ ...doc, threads: doc.threads ?? {}, drills: doc.drills ?? {}, pins: doc.pins ?? {}, drawer: doc.drawer ?? {} })), before); return; } catch { /* written meanwhile: again */ }
      }
    });
  },

  pins() { return pinsOf(this.deep.pins, this.deepKey()); },
  // A code note records what its lines read (STALE once they change, staleNow).
  pin(turn, cx) {
    const key = this.deepKey(), a = pinAnchor(turn), code = a?.file ? codeOf(this.rowsFor(a.file, true), a) : undefined;
    this.updateDeep(cx, (d) => ({ ...d, pins: pinAdd(d.pins, key, turn, Date.now(), code === undefined ? null : { code, head: this.head }) }));
  },
  unpin(id, cx) { const key = this.deepKey(); this.updateDeep(cx, (d) => ({ ...d, pins: pinDrop(d.pins, key, id) })); },
  // A code note: still on a line of the diff, else outdated (kept, shown in the drawer).
  pinOutdated(pin) { const a = pin.anchor; return Boolean(a?.file) && !this.rowsFor(a.file, true).some((r) => atLine(r, a.end, a.old)); },
  // A note (pinned answer) as a turn into a pending comment: the usual flow from there (pending, preview).
  noteToComment(pin, cx) {
    const a = pin.anchor, rows = a?.file ? this.rowsFor(a.file, true) : [], i = rows.findIndex((r) => atLine(r, a.end, a.old));
    if (i < 0) { this.note = "Not turned into a comment: its lines are no longer in the diff"; return cx.notify(); }
    const anchor = selection(rows, Math.max(0, rows.findIndex((r) => atLine(r, a.start, a.old))), i);
    this.comments = [...this.comments, { id: Date.now().toString(36), file: a.file, ...anchor, head: this.head, text: pin.text }]; this.persist(cx);
    this.note = "The note is a pending comment now: it goes out with your review"; cx.notify();
  },

  // The strip a folded drawer leaves: "Ask" down the edge, a dot when an answer came in meanwhile.
  drawerStrip(t) {
    return v_flex().id("rv-drawer-strip").tooltip("Open the Ask drawer").accessibility_label("Open the Ask drawer").w(28).h_full().flex_none().items_center().pt(12).gap(2).border_l(1).border_color(t.border).bg(t.chrome).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.setDrawer("open", cx))
      .children(["A", "s", "k"].map((c) => div().text_size(12).font_semibold().text_color(t.muted).child(c)))
      .when(Boolean(this.askUnseen || this.askBusy), (e) => e.child(div().mt(6).w(8).h(8).rounded_full().bg(this.askBusy ? t.ansi3 : t.accent)));
  },

  // The drawer: what it is about, the input, the notes pinned in this review, the thread (newest first).
  askDrawer(t) {
    const ai = this.ai, scope = scopeOf(ai, this.askFocus()), turns = threadOf(this.deep.threads, this.deepKey()).slice().reverse(), id = "rv-drawer";
    const pins = this.pins(), pinned = new Set(pins.map((p) => p.id));
    const chipBtn = (cid, label, color, click) => div().id(cid).flex_none().px(6).py(1).rounded(5).border_1().border_color(color).text_size(11.5).text_color(color)
      .cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { click(cx); cx.stop_propagation(); cx.notify(); }).child(label);
    const name = new Map((ai?.arch?.nodes ?? []).map((n) => [n.id, n.label ?? n.id])), edges = pictureOf(ai?.arch).edges;
    const L = ai?.arch ? this.archL() : null, off = new Set(pinsOn(pins, L).off.map((p) => p.id));
    const answer = (tu, k) => v_flex().id(`${id}-t${k}`).gap(6).pt(8).border_t(1).border_color(t.border)
      .child(h_flex().gap(6).items_start().child(div().flex_1().min_w(0).text_size(13).font_semibold().whitespace_normal().child(tu.q))
        .child(div().flex_none().max_w(130).truncate().text_size(11).text_color(t.muted).child(tu.about ?? "")))
      .child(div().text_size(13).line_height(1.5).child(TextView.markdown(`${id}-a${tu.at}`, tu.a.text || "–")))
      .when((tu.a.highlights.nodes.length + tu.a.highlights.edges.length) > 0, (e) => e.child(h_flex().flex_wrap().gap(4)
        .children(tu.a.highlights.nodes.map((n) => chipBtn(`${id}-hn${k}-${n}`, name.get(n) ?? n, t.accent, () => { this.page = "arch"; this.tab = "steps"; this.archFocus = n; }).tooltip("Show this card on the Architecture page")))
        .children(tu.a.highlights.edges.map((x) => { const e = edges.find((y) => y.id === x); return chipBtn(`${id}-he${k}-${x}`, e ? `${name.get(e.from) ?? e.from} → ${name.get(e.to) ?? e.to}` : x, t.accent,
          () => { this.page = "arch"; this.tab = "steps"; this.archFocus = null; this.askHl = highlightOf(this.archL(), { highlights: { nodes: [], edges: [x] } }).hl; }).tooltip("Highlight this link on the Architecture page"); }))))
      .when(tu.a.evidence.length > 0, (e) => e.child(v_flex().gap(2).children(tu.a.evidence.map((ev, j) => h_flex().id(`${id}-ev${k}-${j}`).tooltip("Jump to this code in the diff").gap(6).text_size(12).cursor_pointer()
        .on_click((_e, cx) => { this.jumpTo(ev.at, cx); cx.stop_propagation(); })
        .child(div().flex_none().text_color(t.accent).child(`${ev.at.split("/").pop()} ↗`)).child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(ev.why))))))
      .child(h_flex().gap(6).child(pinned.has(`p${tu.at}`) ? chipBtn(`${id}-unpin${k}`, "Pinned · unpin", t.ansi5, (cx) => this.unpin(`p${tu.at}`, cx)).tooltip("Remove this note from the review")
        : pinAnchor(tu) ? chipBtn(`${id}-pin${k}`, tu.scope?.kind === "range" ? "Pin to the code" : "Pin to diagram", t.muted, (cx) => this.pin(tu, cx)).tooltip((tu.scope?.kind === "range" ? "Keep this answer on the code as a private note; it is never sent anywhere" : "Keep this answer on the diagram as a private note; it is never sent anywhere")) : div()));
    const note = (p) => v_flex().id(`${id}-pin-${p.id}`).gap(3).p(8).rounded(6).border_l(3).border_color(t.ansi5).bg(t.ansi5 + "12")
      .child(h_flex().gap(6).items_center().text_size(11.5)
        .child(div().id(`${id}-pv-${p.id}`).tooltip("A pinned answer: a private note, never sent anywhere").flex_none().font_semibold().text_color(t.ansi5).child("Note · private"))
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(p.anchor.file ? rangeLabel(p.anchor) : name.get(p.anchor.node) ?? p.anchor.node ?? p.anchor.edge))
        .when(off.has(p.id) || this.pinOutdated(p), (e) => e.child(badge(t, off.has(p.id) ? "unattached" : "outdated", t.ansi3).id(`${id}-pst-${p.id}`).tooltip(off.has(p.id) ? "Its card is not on the picture now" : "Its lines are no longer in the diff")))
        .child(chipBtn(`${id}-pinx-${p.id}`, "✕", t.muted, (cx) => this.unpin(p.id, cx)).tooltip("Remove this note").accessibility_label("Remove note")))
      .child(div().text_size(12.5).line_height(1.45).whitespace_normal().child(p.summary))
      .when(Boolean(p.anchor.file), (e) => e.child(h_flex().child(chipBtn(`${id}-pinc-${p.id}`, "Turn into comment", t.foreground, (cx) => this.noteToComment(p, cx)).tooltip("Make this note a pending comment; it goes out only with your review"))));
    return v_flex().id(id).w(380).h_full().flex_none().border_l(1).border_color(t.border).bg(t.surface).shadow_lg()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(v_flex().flex_none().p(10).gap(8).border_b(1).border_color(t.border)
        .child(h_flex().gap(6).items_center().child(div().flex_1().min_w(0).truncate().text_size(13.5).font_semibold().child(`Ask about ${this.askLabel(scope)}`))
          .child(pill(`${id}-fold`, t, "›", (_e, cx) => this.setDrawer("collapsed", cx)).tooltip("Fold to the edge").accessibility_label("Fold the Ask drawer"))
          .child(pill(`${id}-x`, t, "✕", (_e, cx) => this.setDrawer(null, cx)).tooltip("Close (Esc); the thread stays").accessibility_label("Close the Ask drawer")))
        .child(h_flex().gap(6).items_center()
          .child(div().id(`${id}-in`).tooltip("Your question: one model call about the selected code or layer; Enter asks").flex_1().min_w(0).h(30).px(8).flex().items_center().rounded(6).border_1().border_color(t.border).bg(t.background).cursor_text()
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.askIn).h_full().text_size(13).text_color(t.foreground)))
          .child(this.askBusy ? div().flex_none().child(SPIN[0]).frames(SPIN, 90) : pill(`${id}-go`, t, "Ask", (_e, cx) => this.askNow(cx), false, t.foreground).tooltip("Ask: one model call about the selected code, card or layer (Enter)")))
        .child(div().text_size(11.5).text_color(t.muted).whitespace_normal().child(`One ${modelLabel(model())} call with the analysis${this.hunks ? ", the diff" : ""} and this thread. Click a card or select lines to ask about them.`)))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id(`${id}-scroll`).absolute().inset_0().overflow_y_scroll().p(10).gap(8)
          .when(Boolean(this.askBusy), (e) => e.child(div().text_size(12.5).text_color(t.muted).whitespace_normal().child(`${this.askBusy.q} · reading…`)))
          .when(Boolean(this.askErr), (e) => e.child(div().text_size(12.5).text_color(t.ansi1).whitespace_normal().child(this.askErr)))
          .when(pins.length > 0, (e) => e.child(div().text_size(11.5).font_semibold().text_color(t.muted).child(`NOTES · ${pins.length}`)).children(pins.map(note)))
          .when(turns.length > 0, (e) => e.child(h_flex().pt(4).items_center().child(div().flex_1().text_size(11.5).font_semibold().text_color(t.muted).child(`THREAD · ${turns.length}`))
            .child(pill(`${id}-clear`, t, "Clear", (_e, cx) => { const key = this.deepKey(); this.updateDeep(cx, (d) => { const th = { ...d.threads }; delete th[key]; return { ...d, threads: th }; }); this.askHl = null; cx.notify(); }).tooltip("Delete this thread of questions and answers; pinned notes stay"))))
          .children(turns.map((tu, k) => answer(tu, k))))
        .child(Scrollbar.vertical(`${id}-scroll`).absolute().inset_0()));
  },

  // Pinned answers on the picture: a note on the card or edge they are about (click: the drawer; ✕: unpin).
  pinNotes(t, L) {
    return pinsOn(this.pins(), L).on.map(({ pin, x, y, w }) => h_flex().id(`rv-pn-${pin.id}`).absolute().left(x).top(y).max_w(w).h(18).px(6).gap(4).items_center().rounded(9)
      .border_1().border_color(t.ansi5).bg(t.background).text_size(10.5).text_color(t.foreground).cursor_pointer().tooltip(pin.text.slice(0, 600))
      .on_click((_e, cx) => { this.setDrawer("open", cx); cx.stop_propagation(); })
      .child(div().flex_none().text_color(t.ansi5).child("✎")).child(div().min_w(0).truncate().child(`${pin.summary}${pin.evidence ? ` · ${pin.evidence.split("/").pop()}` : ""}`))
      .child(div().id(`rv-pnx-${pin.id}`).tooltip("Remove this note").accessibility_label("Remove note").flex_none().text_color(t.muted).hover((s) => s.text_color(t.foreground)).child("✕").on_click((_e, cx) => { this.unpin(pin.id, cx); cx.stop_propagation(); })));
  },

  blastPage(t) {
    const sec = this.findings().filter((f) => f.security), runs = this.find.runs.security; // security comes from a finding's content, not only from the security run
    const blast = this.ai?.blast ?? (sec.length ? { units: [...new Set(sec.map((f) => f.file))].map((file, k) => ({ id: `f${k}`, label: file.split("/").pop(), type: "file", status: "changed", files: [file], spots: (this.fileHunks?.get(file) ?? []).length })), context: [] } : null);
    const header = v_flex().p(12).gap(8).rounded(10).border_1().border_color(t.border).bg(t.surface)
      .child(h_flex().gap(10).items_center().child(div().flex_1().text_size(20).font_semibold().child("Security blast radius"))
        .when(Boolean(blast), (e) => e.child(pill("rv-bl-expand", t, this.blastOpen ? "Collapse all" : "Expand all", (_e, cx) => { this.blastOpen = !this.blastOpen; cx.notify(); }).tooltip("Expand or collapse the details of every part")))
        .child(!sec.length && !runs?.at && !runs?.busy ? div().text_size(12.5).text_color(t.muted).child("No security review yet:") : chip(t, `Security · ${this.counts().security}`, this.counts().security ? t.ansi1 : t.muted, false, "rv-bl-secn", "Unresolved security findings, from every source"))
        .child(pill("rv-bl-run", t, runs?.busy ? "Security review running…" : runs?.at ? "Run security review again" : "Run security review", (_e, cx) => this.runReviewer("security", cx)).tooltip("Run the security reviewer on the PR head, read-only; findings show here")))
      .child(div().text_size(13).text_color(t.muted).child("See the risks and the parts of the diff driving them."));
    if (!blast) return v_flex().gap(12).child(header).child(div().text_size(13.5).text_color(t.muted).child(this.ai ? "No blast radius in this analysis and no security findings yet." : "No analysis yet: Analyze in the left column, or run the security review."));
    const b = blastArch(blast, sec.filter((f) => OPEN_ST.includes(this.fstatus(f))));
    const L = archModel(b, "diff", (n) => Math.min(2, n.findings?.length ?? 0));
    const opts = this.archOpts("blast");
    const deco = (n) => (n.findings ?? []).slice(0, 2).map((f, j) => h_flex().gap(4).items_center().child(chip(t, f.severity, t[SEVERITY_COLOR[f.severity]] ?? t.muted, true, `rv-deco-${n.id}-${j}`, `A ${f.severity}-severity security finding`))
      .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.foreground).child(f.title)));
    const go = (n, _e, cx) => { const h = this.fileHunks?.get(n.file)?.[0]; if (h) this.jumpTo(`${n.file}:${h.rows.find((r) => r.n)?.n ?? ""}`, cx); else if (n.file) { this.note = `${n.file} is not in the diff (related context)`; cx.notify(); } };
    return v_flex().gap(12)
      .child(header.child(div().text_size(13).font_semibold().child(`${b.counts.added} Added | ${b.counts.changed} Changed | ${b.counts.up} Upstream | ${b.counts.down} Downstream`)))
      .child(this.hscroll("rv-blast-scroll", L.width + 4, L.height + 4, archView(L, t, "rv-blast", go, deco, opts), t))
      .child(archLegend(L, t, "rv-blast-edges", "How the context links to the changes", opts, true))
      .when(this.blastOpen, (e) => e.children((blast.units ?? []).flatMap((u) => (u.files ?? []).flatMap((file) => (this.fileHunks?.get(file) ?? []).map((h) => this.hunkBlock(h, t, `${u.id}`))))));
  },

  // A hunk drawn plainly (pages: outside the virtual list), at most 60 lines.
  hunkBlock(h, t, key) {
    const mono = settings().font_family ?? "JetBrains Mono";
    return v_flex().id(`rv-hb-${key}-${h.id}`).flex_none().rounded(8).border_1().border_color(t.border).overflow_hidden().font_family(mono).text_size(12)
      .child(div().px(10).py(4).bg(t.raised).text_color(t.muted).truncate().child(`${h.path}  ${h.rows[0]?.text ?? ""}`))
      .children(h.rows.slice(1, 61).map((r) => h_flex().h(18).when(r.kind === "+" || r.kind === "-", (e) => e.bg(tint(r.kind) + "1a"))
        .child(div().w(44).flex_none().pr(6).text_right().text_color(t.muted).child(r.number === undefined ? "" : String(r.number)))
        .child(div().w(14).flex_none().text_color(r.kind === "+" ? t.ansi2 : r.kind === "-" ? t.ansi1 : t.muted).child(r.kind === " " ? "" : r.kind))
        .child(div().flex_1().min_w(0).truncate().child(expandTabs(r.text)))));
  },

  // The CLIs' models for this PR's context (models.py), asked at most once a day per context: Claude lists what that
  // account may use, Codex what it offers. Kept in shared "review.models" and pr-data/models.json.
  loadModels(cx) {
    const ctx = this.ctxReq(), id = ctx?.id ?? "default", d = modelsDoc()[id], busy = (this.modelsBusy ??= new Set());
    if ((d && Date.now() - d.at < 86400000) || busy.has(id)) return;
    busy.add(id);
    cx.spawn(async (cx) => {
      const r = await exec("python3", [`${appHome()}/mods/pr-review/models.py`, JSON.stringify({ context: ctx })], { timeout: 90000 }).catch(() => null);
      let out = null;
      try { out = r?.code === 0 ? JSON.parse(r.stdout) : null; } catch { /* no answer */ }
      if (!out?.claude?.length && !out?.codex?.length) return; // busy stays: no second try this session
      busy.delete(id);
      const doc = { ...modelsDoc(), [id]: { at: Date.now(), claude: out.claude ?? [], codex: out.codex ?? [] } };
      setShared("review.models", doc);
      writeTextFile(modelsFile(), JSON.stringify(doc)).catch(() => null);
      cx.notify();
    });
  },
  // A rough price before running: input from the diff size, output and thinking from earlier runs; the cap is review.py's.
  estimate(m) {
    const chars = Math.min(MODELS[tierOf(m)].chars, (this.hunks ?? []).reduce((n, h) => n + h.lines.reduce((k, l) => k + l.length + 1, 0), 0));
    const [inp, out] = priceOf(resolvedOf(m));
    // ponytail: reading the code with tools multiplies input; ×4 from the first runs, a guess until the ledger says more.
    const usd = (((chars / 3.5 + 3000) * 4) * inp + 15000 * out) / 1e6;
    return `≈ $${usd.toFixed(2)} · cap $${CAP[tierOf(m)]}`;
  },

  // Statements with their source: a "spec" tag before spec-only ones (only in the description/ticket, not in the
  // diff), existing ones muted, and the evidence (file:line) as a link into the diff.
  statements(t, list, id) {
    return v_flex().gap(3).children(list.map((x, k) => h_flex().id(`${id}-${k}`).gap(6).items_start().text_size(13.5).line_height(1.5)
      .when(x.source === "spec", (e) => e.child(div().pt(2).child(specTag(t, `${id}-${k}-sp`))))
      .child(div().flex_1().min_w(0).whitespace_normal().text_color(x.source === "existing" ? t.muted : t.foreground).child(x.text))
      .when(Boolean(x.evidence) && x.source !== "spec", (e) => e.child(div().id(`${id}-${k}-ev`).tooltip("Jump to this code in the diff").flex_none().text_size(11.5).text_color(t.accent).cursor_pointer()
        .child(`${String(x.evidence).split("/").pop()} ↗`).on_click((_e, cx) => { this.jumpTo(x.evidence, cx); cx.stop_propagation(); })))));
  },

  // An ask's link to a spec-only element of the pictures: the Architecture page focused on it, or its layer.
  openSpec(el, cx) {
    if (el.page === "arch") { this.page = "arch"; if ((this.ai.arch?.nodes ?? []).some((n) => n.id === el.id)) this.archFocus = el.id; }
    else if (el.step !== null) { const i = this.steps().indexOf(this.ai.steps[el.step]); if (i >= 0) this.goStep(i, cx); }
    cx.notify();
  },

  // The task check as one list (pr.js taskList): the unresolved security findings, then each ask with its state as a
  // chip with a symbol, why, and on a click of the row the findings that break it (file and line, a click jumps
  // there); the acceptance criteria as a group of their own; then what is not in the task: the extras and the findings
  // that belong to no ask. An analysis from before the newer fields shows the rows without why and findings.
  asksPane(t, list, W) {
    const ai = this.ai, task = ai?.task ?? {}, specs = ai ? specElements(ai) : new Map(), n = (k, one) => `${k} ${k === 1 ? one : `${one}s`}`;
    const STATE = { met: ["✓", "met", "ansi2", "The diff does what this asks"], partly: ["◐", "partly", "ansi3", "The diff does only part of what this asks"],
      broken: ["✗", "broken", "ansi1", "The code for this is there and breaks what this asks"], not_done: ["○", "not done", "ansi1", "Nothing in the diff does this"],
      extra: ["+", "extra", "ansi4", "The diff does this, but the task did not ask for it"] };
    const label = (text) => div().pt(8).px(6).text_size(11.5).font_semibold().text_color(t.muted).child(text);
    // A finding: its severity (the scale as tooltip), title, place, and how sure it is with what it hangs on.
    const finding = (f, id, w, nested = false) => {
      const st = this.fstatus(f), settled = st === "fixed" || st === "dismissed";
      return h_flex().id(id).tooltip("Open this finding and show its line in the diff").gap(10).items_start().px(nested ? 0 : 6).py(3).rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.openFinding(f); this.jumpTo(`${f.file}:${f.line}`, cx); cx.stop_propagation(); })
        .child(div().w(w).flex_none().pt(1).child(h_flex().child(chip(t, f.severity, t[SEVERITY_COLOR[f.severity]] ?? t.muted, !settled, `${id}-sv`, severityTip(f)))))
        .child(v_flex().flex_1().min_w(0).max_w(W)
          .child(div().whitespace_normal().text_color(settled ? t.dim : t.foreground).child(f.title))
          .child(div().text_size(12).text_color(t.muted).whitespace_normal().child([nested && f.security && "⛨ Security", `${f.file}:${f.line}`, certaintyLine(f), st !== "open" && FSTATUS[st]?.[0]].filter(Boolean).join(" · "))));
    };
    const ask = (r) => {
      const a = r.ask, [sym, word, col, tip] = STATE[a.state], open = this.askOpen.has(a.id), fs = r.findings, hunk = a.hunks.find((x) => this.byId.has(x));
      return h_flex().id(`rv-ask-${a.id}`).gap(10).items_start().px(6).py(5).rounded(6)
        .when(fs.length > 0 || Boolean(hunk), (e) => e.cursor_pointer().hover((s) => s.bg(t.hover))
          .tooltip(fs.length ? (open ? "Hide the findings" : "Show the findings that break this, each with its file and line") : "No finding is linked to this: show the code it is about in the diff")
          .on_click((_e, cx) => { if (fs.length) this.toggleAsk(a.id); else { this.tab = "files"; this.unfold(this.byId.get(hunk).path); this.visit(hunk, cx); this.scrollTo("files", hunk); } cx.notify(); }))
        .child(div().w(88).flex_none().pt(1).child(h_flex().child(chip(t, `${sym} ${word}`, t[col], true, `rv-ask-${a.id}-st`, tip))))
        .child(v_flex().flex_1().min_w(0).max_w(W).gap(2)
          .child(div().line_height(1.5).child(TextView.markdown(`rv-ask-${ai.generated}-${a.id}`, a.text)))
          .when(Boolean(a.why), (e) => e.child(div().text_size(12.5).line_height(1.45).text_color(t.muted).whitespace_normal().child(a.why)))
          .when(r.unlinked, (e) => e.child(div().text_size(12).text_color(t.ansi3).child("No finding backs this state.")))
          .when(a.elements.some((x) => specs.has(x)), (e) => e.child(h_flex().flex_wrap().gap(6).children(a.elements.filter((x) => specs.has(x)).map((x, k) => div().id(`rv-ask-${a.id}-sp${k}`).flex_none().px(5).rounded(4).border_1().border_dashed().border_color(t.ansi5)
            .text_size(11).text_color(t.ansi5).cursor_pointer().tooltip("Spec only: in the picture, not found in the diff").child(`spec: ${specs.get(x).label} ↗`)
            .on_click((_e, cx) => { this.openSpec(specs.get(x), cx); cx.stop_propagation(); })))))
          .when(open, (e) => e.child(v_flex().pt(4).gap(2).children(fs.map((f) => finding(f, `rv-ask-${a.id}-f-${f.id}`, 60, true))))))
        .child(div().w(96).flex_none().pt(2).text_size(12).text_color(t.muted).child(fs.length ? `${n(fs.length, "finding")} ${open ? "▾" : "▸"}` : hunk ? "Show in diff ↗" : ""));
    };
    const marked = list.rows.filter((r) => list.marked && r.ask.acceptance), rest = list.rows.filter((r) => !marked.includes(r)), hasTask = list.rows.length + list.extra.length > 0;
    const otherOpen = this.askOpen.has("other") || !hasTask; // no task to fold them under: the findings are the list
    const sev = ["high", "medium", "low"].map((k) => [k, list.other.filter((f) => f.severity === k).length]).filter(([, c]) => c).map(([k, c]) => `${c} ${k}`).join(", ");
    return v_flex().flex_none().gap(2).max_w(W + 240).text_size(13.5)
      .child(h_flex().flex_wrap().gap(10).items_center().px(6)
        .child(div().font_semibold().text_size(14.5).child(ai ? "Check against the task" : "Unresolved findings"))
        .when(Boolean(taskHead(list)), (e) => e.child(div().id("rv-ask-head").tooltip("The criteria this PR meets; a row's chip says how each one stands").child(taskHead(list))))
        .when(Boolean(ai), (e) => e.child(div().text_size(12).text_color(t.muted).child(`From the PR description${task.jira ? ` and Jira ${task.jira}` : ""}`))))
      .when(Boolean(task.note), (e) => e.child(div().px(6).text_size(12).text_color(t.ansi3).whitespace_normal().child(task.note)))
      .when(Boolean(ai) && !hasTask, (e) => e.child(div().px(6).text_color(t.muted).child("The analysis found no task in the PR description.")))
      .when(list.security.length > 0, (e) => e.child(h_flex().pt(8).px(6).child(chip(t, "⛨ Security", t.ansi1, true, "rv-ask-sec", "Unresolved security findings; they stand before the task's criteria")))
        .children(list.security.map((f) => finding(f, `rv-ask-s-${f.id}`, 88))))
      .when(marked.length > 0, (e) => e.child(label("ACCEPTANCE CRITERIA")).children(marked.map(ask)))
      .when(rest.length > 0, (e) => e.child(label(list.marked ? "ALSO IN THE DESCRIPTION" : "CRITERIA")).children(rest.map(ask)))
      .when(list.extra.length + list.other.length > 0, (e) => e.when(hasTask || list.security.length > 0, (x) => x.child(label(hasTask ? "NOT IN THE TASK" : "OTHER FINDINGS"))).children(list.extra.map(ask))
        .when(list.other.length > 0 && hasTask, (x) => x.child(h_flex().id("rv-ask-other").tooltip(otherOpen ? "Hide these findings" : "Show these findings, each with its file and line").gap(10).items_start().px(6).py(5).rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.toggleAsk("other"); cx.notify(); })
          .child(div().w(88).flex_none())
          .child(div().flex_1().min_w(0).max_w(W).whitespace_normal().child(`${n(list.other.length, "unresolved finding")} ${list.other.length === 1 ? "belongs" : "belong"} to no criterion: ${sev}`))
          .child(div().w(96).flex_none().pt(2).text_size(12).text_color(t.muted).child(otherOpen ? "▾" : "▸"))))
        .when(otherOpen, (x) => x.child(v_flex().pl(hasTask ? 98 : 0).gap(2).children(list.other.map((f) => finding(f, `rv-ask-o-${f.id}`, hasTask ? 60 : 88, hasTask))))));
  },

  // The Findings tab: every finding once, one line each, in sections by state (pr.js findingStatus): the unresolved
  // ones with a fix sent (what is known about each fix, and Verify) and without, Fixed, Dismissed, then the AI notes. A click opens a finding in
  // place and shows its line in the diff. It has no filters of its own: the bar's Show switch is the one filter.
  findingsPane(t) {
    const all = this.findings(), c = this.counts(), runs = this.find.runs, toVerify = [...this.verifyList(), ...this.branchVerifyList()], notes = this.openSugs(), m = model();
    const by = (...st) => all.filter((x) => st.includes(this.fstatus(x)));
    const unresolved = by("open", "recheck"), sent = by("progress");
    const name = (k) => REVIEWERS[k]?.[0] ?? k;
    // Each source with what it found: a number, "no findings" (it ran), "failed" or "not run".
    const ran = { analysis: Boolean(this.ai), ...Object.fromEntries(Object.keys(ALL_REVIEWERS).map((k) => [k, runs[k]?.state === "done"])) };
    const sources = [...new Set(["analysis", ...reviewersNow().map(([k]) => k), ...all.flatMap((x) => x.sources.map((y) => y.reviewer))])].map((k) => {
      const n = all.filter((x) => x.sources.some((y) => y.reviewer === k)).length;
      return { k, n, text: runs[k]?.state === "running" ? `${name(k)}: running` : n ? `${name(k)} ${n}` : runs[k]?.state === "failed" ? `${name(k)}: failed` : ran[k] ? `${name(k)}: no findings` : `${name(k)}: not run` };
    }).filter((x) => x.k !== "ai" || x.n);
    // "Quick wins first" is offered once a finding says how much work its fix is; it reorders every section.
    const efforts = hasEffort(all), order = (list) => (efforts && this.fsort ? quickFirst(list) : list);
    const row = (x) => {
      const st = this.fstatus(x), on = this.ffocus === x.id, col = t[SEV[x.severity]] ?? t.accent, li = this.layerOf(x), settled = st === "fixed" || st === "dismissed";
      const wide = on || (x.security && x.severity === "high" && !settled); // an unresolved high security finding keeps its whole title
      const others = x.sources.filter((y) => y.title !== x.title || y.detail !== x.detail), owner = on ? ownerOf(x, this.ai?.components) : null;
      // Its way into the PR as five steps in one line; the step that is next says what is missing, a step with
      // details (the fix's agent, branch, commit and report, the check's result) opens them on a click.
      const steps = on ? findingSteps(x, this.find.status[x.id], { report: this.find.reports[x.id], facts: this.fixFacts(x) }) : [];
      const next = steps.find((s) => s.next), shown = steps.find((s) => this.fstep?.id === x.id && s.key === this.fstep.key && s.details.length);
      return v_flex().id(`rv-fc-${x.id}`).flex_none().px(8).py(on ? 8 : 4).gap(6).rounded(7).border_l(3).border_color(on ? t.accent : col).when(on, (e) => e.bg(t.surface)).text_size(13.5)
        .child(h_flex().id(`rv-ft-${x.id}`).tooltip("Open this finding and show its line in the diff").gap(8).items_start().cursor_pointer().hover((h) => h.text_color(t.foreground))
          .on_click((_e, cx) => { this.ffocus = on ? null : x.id; if (!on) this.jumpTo(`${x.file}:${x.line}`, cx); cx.notify(); })
          .child(badge(t, x.severity, col))
          .when(Boolean(x.effort), (e) => e.child(div().id(`rv-fef-${x.id}`).tooltip("How much work the fix is, as the analysis sees it: quick, moderate or heavy").flex_none().pt(1).text_size(12).text_color(t.muted).child(x.effort)))
          .when(Boolean(x.security), (e) => e.child(badge(t, "⛨ Security", t.ansi1).bg(t.ansi1 + "26")))
          .child(div().flex_1().min_w(0).font_semibold().text_color(settled ? t.dim : t.foreground).when(!wide, (e) => e.truncate()).when(wide, (e) => e.whitespace_normal()).child(x.title))
          .child(div().flex_none().text_size(12).text_color(t.muted).child(`${x.file.split("/").pop()}:${x.line}${this.findRow(x) < 0 ? " · outside the diff" : ""}`))
          .child(div().flex_none().text_size(12).font_semibold().text_color(t[FSTATUS[st]?.[1]] ?? t.muted).child(FSTATUS[st]?.[0] ?? st)))
        .when(on, (e) => e
          .child(div().text_size(12).text_color(t.muted).whitespace_normal().child(`Found by ${this.sourcesOf(x)}${owner ? ` · Owner: ${owner}` : ""}`))
          // An analysis finding is part of its layer: name it, a click opens it.
          .when(li >= 0, (e) => e.child(div().id(`rv-fly-${x.id}`).tooltip("Open the layer this finding belongs to").truncate().text_size(12).text_color(t.accent).cursor_pointer()
            .on_click((_e, cx) => { this.goStep(li, cx); cx.notify(); }).child(`${x.category} · layer: ${plain(this.steps()[li]?.title)} →`)))
          .child(div().line_height(1.5).child(TextView.markdown(`rv-fd-${x.id}`, x.detail + (x.suggestion ? `\n\n**Suggested:** ${x.suggestion}` : ""))))
          // What the other sources say about the same line, in their own words and with their own severity.
          .children(others.map((y, k) => div().id(`rv-fsrc-${x.id}-${k}`).text_size(12.5).text_color(t.muted).line_height(1.5).whitespace_normal().child(`${name(y.reviewer)} (${y.severity}): ${plain(y.title)}${y.detail ? `. ${plain(y.detail)}` : ""}`)))
          .child(v_flex().gap(4)
            .child(h_flex().flex_wrap().gap(4).items_center().text_size(12).children(steps.flatMap((s, k) => [k > 0 && div().flex_none().text_color(t.dim).child("→"),
              div().id(`rv-fstep-${x.id}-${s.key}`).tooltip(`${s.done ? `${s.label}: reached.` : s.missing}${s.details.length ? " Click for the details." : ""}`)
                .flex_none().px(7).h(20).flex().items_center().gap(4).rounded(10).border_1().border_color(s.done ? t.ansi2 : s.next ? t.ansi3 : t.border).text_color(s.done || s.next ? t.foreground : t.dim)
                .when(s.done, (e) => e.bg(t.ansi2 + "1f")).when(shown === s, (e) => e.border_color(t.accent))
                .when(s.details.length > 0, (e) => e.cursor_pointer().hover((h) => h.bg(t.hover)).on_click((_e, cx) => { this.fstep = shown === s ? null : { id: x.id, key: s.key }; cx.stop_propagation(); cx.notify(); }))
                .child(s.done ? `✓ ${s.label}` : s.label).when(s.details.length > 0, (e) => e.child(div().text_color(t.muted).child(shown === s ? "▾" : "▸")))].filter(Boolean))))
            .when(Boolean(next), (e) => e.child(div().id(`rv-fnext-${x.id}`).text_size(12.5).line_height(1.5).text_color(t.muted).whitespace_normal().child(next.missing)))
            .when(Boolean(shown), (e) => e.child(v_flex().p(8).gap(3).rounded(6).border_1().border_color(t.border)
              .children(shown.details.map(([label, text]) => h_flex().gap(8).items_start().text_size(12.5).line_height(1.5)
                .child(div().w(52).flex_none().text_color(t.muted).child(label)).child(div().flex_1().min_w(0).whitespace_normal().child(text)))))))
          .child(h_flex().flex_wrap().gap(6).items_center().children(this.findingActions(x, settled, t))));
    };
    const section = (title, list, right = null, hint = null) => v_flex().flex_none().gap(2)
      .child(h_flex().pt(10).pb(2).px(6).gap(8).items_center().child(div().flex_1().text_size(11.5).font_semibold().text_color(t.muted).child(`${title} · ${list.length}`)).children([right].filter(Boolean)))
      .when(Boolean(hint), (e) => e.child(div().px(6).pb(2).text_size(12.5).line_height(1.5).text_color(t.muted).whitespace_normal().child(hint)))
      .children(order(list).map(row));
    const verify = div().id("rv-verify").tooltip("One model call checks the fixes sent: a reported commit on its fix branch, or the PR head once it moved").px(9).h(26).flex().items_center().gap(6).rounded(6).border_1().text_size(12.5)
      .border_color(toVerify.length && !this.verifyBusy ? t.foreground : t.border).text_color(toVerify.length && !this.verifyBusy ? t.foreground : t.dim)
      .when(toVerify.length > 0 && !this.verifyBusy, (e) => e.cursor_pointer().hover((h) => h.bg(t.hover)).on_click((_e, cx) => this.runVerify(cx)))
      .child(this.verifyBusy ? `Verifying ${this.verifyBusy.n}…` : `Verify fixes (${toVerify.length})`);
    const sentHint = !sent.length ? "No fix is out. A finding sent to Fix stays unresolved and shows here until it is verified."
      : `A fix sent does not resolve a finding. Verify is one ${modelLabel(m)} call: it checks a reported commit on its fix branch, and the PR head once the fix is pushed. Only a passed check on the PR head moves a finding to Fixed.${toVerify.length ? "" : " Nothing to verify yet."}`;
    return v_flex().flex_1().min_h(0)
      .child(v_flex().flex_none().px(14).py(10).gap(8).border_b(1).border_color(t.border)
        // How this number comes about is its help text: a line of its own would make the head three lines.
        .child(div().id("rv-fcount").tooltip(`${funnelLine(funnel(all, (f) => this.fstatus(f)), name)} A finding with a fix sent stays unresolved until it is verified.`).text_size(13.5).font_semibold().child(countLine(c)))
        .child(h_flex().flex_wrap().gap(4).children(sources.map((x) => div().id(`rv-fsrcn-${x.k}`).tooltip(x.n ? `Findings ${name(x.k)} is a source of` : runs[x.k]?.state === "failed" ? `${name(x.k)} failed: ${runs[x.k].error ?? "no result"}` : ran[x.k] ? `${name(x.k)} ran and found nothing` : `${name(x.k)} has not run on this PR`)
          .px(8).h(22).flex().items_center().rounded(6).border_1().border_color(t.border).text_size(12).text_color(x.n ? t.foreground : t.muted).child(x.text)))
          .when(efforts, (e) => e.child(div().id("rv-fsort").tooltip(this.fsort ? "Listed with the quickest fixes first; click for the usual order, by severity" : "List the findings with the quickest fixes first")
            .px(8).h(22).flex().items_center().rounded(6).border_1().cursor_pointer().text_size(12).border_color(this.fsort ? t.accent : t.border).bg(this.fsort ? t.selected : t.chrome).text_color(this.fsort ? t.foreground : t.muted)
            .hover((h) => h.text_color(t.foreground)).on_click((_e, cx) => { this.fsort = !this.fsort; cx.notify(); }).child(this.fsort ? "✓ Quick wins first" : "Quick wins first"))))
        .when(Object.values(runs).some((r) => r.busy), (e) => e.child(div().text_size(12).text_color(t.muted).child("A reviewer is running…"))))
      .when(!all.length, (e) => e.child(h_flex().flex_none().flex_wrap().px(14).py(8).gap(6).items_center().border_b(1).border_color(t.border)
        .child(div().text_size(12).text_color(t.muted).child("Run a reviewer:"))
        .children(reviewersNow().map(([k, [label]]) => pill(`rv-frun-${k}`, t, runs[k]?.busy ? `${label} running…` : label, (_e, cx) => this.runReviewer(k, cx), false, t.foreground).tooltip("Run this reviewer read-only on the PR head; its findings show here")))))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("rv-find-left").absolute().inset_0().overflow_y_scroll().px(8).pb(12).gap(2)
          // The two kinds of unresolved findings add up to the number in the tab and in the line above.
          .child(section("FIX SENT", sent, verify, sentHint))
          .child(section("NO FIX SENT", unresolved, unresolved.filter((x) => !x.security).length > 1 && pill("rv-fixall", t, "Fix several…", (_e, cx) => this.fixSeveral(cx)).tooltip("Pick which of these findings one agent fixes together; a preview first. Security findings are fixed one at a time.")))
          .when(c.fixed > 0, (e) => e.child(section("FIXED", by("fixed"))))
          .when(c.dismissed > 0, (e) => e.child(section("DISMISSED", by("dismissed"))))
          // Suggestions alone on their lines: notes, not findings, not counted above.
          .when(notes.length > 0, (e) => e.child(v_flex().flex_none().gap(2)
            .child(div().pt(10).pb(2).px(6).text_size(11.5).font_semibold().text_color(t.muted).child(`AI NOTES · ${notes.length} · not counted as findings`))
            .children(notes.map((s) => h_flex().id(`rv-fnote-${s.key}`).tooltip("Show this note's line in the diff").flex_none().px(8).h(26).gap(8).items_center().rounded(6).cursor_pointer().hover((h) => h.bg(t.hover)).text_size(12.5).text_color(t.muted)
              .on_click((_e, cx) => { this.sug = s.key; this.jumpTo(`${s.path}:${s.line}`, cx); cx.notify(); })
              .child(div().flex_none().child(s.severity)).child(div().flex_1().min_w(0).truncate().child(plain(s.reason))).child(div().flex_none().child(`${s.path.split("/").pop()}:${s.line}`)))))))
        .child(Scrollbar.vertical("rv-find-left").absolute().inset_0()));
  },

  filesPane(t) {
    const files = this.shown().patch, byPath = new Map(files.map((f) => [f.path, f]));
    const seen = files.filter((f) => this.prog.seen.has(f.path)).length, open = this.openFindings(); // the flags add up to the Findings tab's number
    const add = files.reduce((n, f) => n + f.add, 0), del = files.reduce((n, f) => n + f.del, 0);
    return v_flex().flex_1().min_h(0)
      .child(h_flex().flex_none().px(14).h(38).gap(10).items_center().border_b(1).border_color(t.border).text_size(12.5)
        .child(div().id("rv-fp-seen").tooltip("Files you ticked as viewed").flex_1().text_color(t.muted).child(`${seen} of ${files.length} files viewed`))
        .child(div().id("rv-fp-add").tooltip("Lines added in the whole PR").text_color(t.ansi2).child(`+${add}`)).child(div().id("rv-fp-del").tooltip("Lines removed in the whole PR").text_color(t.ansi1).child(`−${del}`)))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("rv-tree").absolute().inset_0().overflow_y_scroll().p(6)
          .children(fileTree(files.map((f) => f.path), this.closedDirs).map((n) => {
            // A file's unresolved findings in words, in the colour of the highest severity; security with its own mark.
            const f = byPath.get(n.path), cm = f ? this.comments.filter((c) => c.file === f.path).length : 0, w = f ? worst(open.filter((x) => x.file === f.path)) : null;
            return h_flex().id(`rv-t-${n.dir ? "d" : "f"}-${n.path}`).tooltip((n.dir ? "Fold or unfold this folder" : "Show this file's diff")).h(28).flex_none().pl(8 + 14 * n.depth).pr(n.dir ? 8 : 0).gap(8).items_center().rounded(6).text_size(13).cursor_pointer()
              .when(!n.dir && this.fileFocus === n.path, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
              .on_click((_e, cx) => {
                if (n.dir) { if (this.closedDirs.has(n.path)) this.closedDirs.delete(n.path); else this.closedDirs.add(n.path); }
                else { this.tab = "files"; this.fileFocus = n.path; this.unfold(n.path); this.scrollTo("files", n.path); }
                cx.notify();
              })
              .child(div().w(12).flex_none().text_color(t.muted).child(n.dir ? (this.closedDirs.has(n.path) ? "▸" : "▾") : ""))
              .when(!n.dir, (e) => e.child(div().id(`rv-tst-${n.path}`).tooltip(`File ${f.status}`).w(14).flex_none().text_size(11.5).font_semibold().text_color(t[STATUS[f.status][1]]).child(STATUS[f.status][0])))
              .child(div().flex_1().min_w(0).truncate().text_color(n.dir ? t.muted : this.prog.seen.has(n.path) ? t.muted : t.foreground).child(n.dir ? `${n.name}/` : n.name))
              .when(Boolean(w?.security), (e) => e.child(div().id(`rv-tsec-${n.path}`).tooltip(`${w.security} of them ${w.security === 1 ? "is a security finding" : "are security findings"}`).flex_none().text_color(t.ansi1).child("⛨")))
              .when(Boolean(w), (e) => e.child(div().id(`rv-tsg-${n.path}`).tooltip(`${w.total} unresolved ${w.total === 1 ? "finding" : "findings"} in this file: ${w.words}`).flex_none().text_size(11.5).font_semibold().text_color(t[SEV[w.severity]] ?? t.ansi1).child(w.label)))
              .when(cm > 0, (e) => e.child(div().id(`rv-tcm-${n.path}`).tooltip(`${cm} pending ${cm === 1 ? "comment" : "comments"} of yours in this file`).flex_none().text_size(11.5).text_color(t.accent).child(`${cm} ${cm === 1 ? "comment" : "comments"}`)))
              .when(!n.dir && f.add > 0, (e) => e.child(div().id(`rv-tad-${n.path}`).tooltip(`${f.add} lines added`).text_size(11.5).text_color(t.ansi2).child(`+${f.add}`)))
              .when(!n.dir && f.del > 0, (e) => e.child(div().id(`rv-tdl-${n.path}`).tooltip(`${f.del} lines removed`).text_size(11.5).text_color(t.ansi1).child(`−${f.del}`)))
              // The tick: a 16 px box, and the whole right end of the row takes the click.
              .when(!n.dir, (e) => e.child(div().id(`rv-seen-${n.path}`).tooltip("Mark this file as viewed; it collapses in the diff").accessibility_label("Viewed").w(36).h(28).flex_none().flex().items_center().justify_center()
                .on_click((_e, cx) => { this.toggleSeen(n.path, cx); cx.stop_propagation(); cx.notify(); }).child(viewedBox(t, this.prog.seen.has(n.path)))));
          })))
        .child(Scrollbar.vertical("rv-tree").absolute().inset_0()));
  },

  // ---- render: the diff list (inside the virtual list: no handlers, onItem places clicks by x)

  // Lines a wrapped text takes in a card of the diff column (views.js wrapCount); less: what a label column takes.
  lines(text, less = 0) { return wrapCount(text, (this.listW ?? 900) - GUTTER - 45 - less); },
  // The height of a Markdown text in such a card (views.js mdHeight).
  md(text, less = 0) { return mdHeight(text, (this.listW ?? 900) - GUTTER - 45 - less); },

  sizeOf(it) {
    if (it.t === "row") return it.src[it.ri].kind === "@" ? 30 : ROW;
    if (it.t === "step") { const w = Math.min(LAYER_TEXT, (this.listW ?? 900) - 32), qs = it.s.questions; return 48 + mdHeight(it.s.why, w) + (qs.length ? 26 + qs.reduce((n, q, k) => n + 4 + mdHeight(this.asked(it.s, q, k), w - 20), 0) : 0); }
    if (it.t === "vis") return visualPlan(it.v, (this.listW ?? 900) - 32).h + 8;
    if (it.t === "sug") return this.sug === it.s.key ? 56 + this.md(it.s.reason) : 26;
    if (it.t === "pad") return 60;
    if (it.t === "fold") return it.h;
    if (it.t === "hidden") return 24;
    if (it.t === "ch") return this.cardOf(it).folded ? 28 + 2 * CARD_GAP : CARD_HEAD;
    if (it.t === "cb") { const c = this.cardOf(it), w = this.cardW(c) - 26; return 12 + mdHeight(c.text, w, 20) + c.replies.reduce((n, r) => n + 26 + mdHeight(r.text, w - 44, 19, 12.5), 0) + (it.k === "th" ? 0 : CARD_GAP); }
    if (it.t === "cr") return CARD_REPLY + CARD_GAP;
    if (it.t === "gh") return 50 + this.md(it.g.body);
    if (it.t === "compose") return COMPOSE;
    if (it.t === "composeact") return ACT + 4;
    if (it.t === "cact" || it.t === "fact") return ACT;
    if (it.t === "def") return 190;
    if (it.t === "find") return this.findOpen(it.f) ? 48 + (this.fixLine(it.f) ? 21 : 0) + 21 * this.lines(it.f.title) + this.findRows(it.f).reduce((n, [, v]) => n + 4 + this.md(v, FIND_LABEL), 0) : FIND_FOLDED;
    return { path: 30, file: 44, gap: 30, note: 30 }[it.t];
  },

  item(it, t) {
    const mono = (e) => e.font_family(settings().font_family ?? "JetBrains Mono");
    if (it.t === "row") {
      const r = it.src[it.ri];
      if (r.kind === "@") {
        const m = /^(@@[^@]*@@)\s?(.*)$/.exec(r.text) ?? [null, r.text, ""];
        return mono(h_flex()).h(30).w_full().pl(GUTTER - 4).pr(12).gap(10).items_center().bg(t.accent + "14").border_t(1).border_b(1).border_color(t.border).text_size(12.5)
          .child(div().flex_none().text_color(t.muted).child(m[1])).child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(m[2]));
      }
      const on = Boolean(this.selKeys && this.fsel?.path === it.path && this.selKeys.has(lineKey(r)));
      const tone = r.kind === "+" ? t.ansi2 : r.kind === "-" ? t.ansi1 : null, focus = it.hunk && it.hunk === this.focusHunk;
      const num = (n) => div().w(48).h_full().flex_none().pr(8).flex().items_center().justify_end().text_color(t.muted).child(n === undefined ? "" : String(n));
      return mono(h_flex()).h(ROW).w_full().text_size(13).cursor_pointer()
        .when(Boolean(tone), (e) => e.bg(tint(r.kind) + "1a")).when(on, (e) => e.bg(t.selection))
        .child(div().w(4).h_full().flex_none().when(on, (e) => e.bg(t.accent)).when(!on && Boolean(focus), (e) => e.bg(t.accent + "55"))
          .when(!on && !focus && Boolean(this.pinMarks?.has(`${it.path}:${r.n}`)), (e) => e.bg(t.ansi5))
          .when(!on && r.kind !== "-" && Boolean(this.fmarks?.get(it.path)?.get(r.n)), (e) => e.bg(t[this.fmarks.get(it.path).get(r.n)]))) // the lines of an open finding
        .child(h_flex().h_full().flex_none().relative().when(Boolean(tone), (e) => e.bg(tint(r.kind) + "40")).child(num(r.o)).child(num(r.n))
          // GitHub's "+" on hover: the line numbers are the comment button (onItem: x inside the gutter).
          .child(h_flex().absolute().inset_0().justify_end().items_center().text_color("#00000000").hover((s) => s.text_color(t.accent_foreground).bg(t.accent + "26"))
            .child(div().w(18).h(18).mr(2).rounded(4).flex().items_center().justify_center().font_semibold().hover((s) => s.bg(t.accent)).child("+"))))
        .child(div().w(22).flex_none().text_center().font_semibold().text_color(tone ?? t.muted).child(r.kind === " " ? "" : r.kind === "-" ? "−" : "+"))
        .child(div().flex_1().min_w(0).pr(12).truncate().text_color(t.foreground).child(this.code(r, it)))
        .when(Boolean(this.traces?.get(`${it.path}:${r.n}`)) && r.kind !== "-", (e) => e.child(div().id("rv-trace").tooltip("Example values from the flow trace; Values in the top bar switches them").flex_none().max_w(460).mr(12).px(8).h(18).flex().items_center()
          .rounded(9).bg(t.accent + "1f").italic().text_size(12).text_color(t.muted).truncate().child(this.traces.get(`${it.path}:${r.n}`))))
        // The selection's last row: "+ Comment (c)" at its right end (onItem places the click by x, rowClick).
        .when(on && !this.composing && this.fsel?.b === lineKey(r), (e) => e.child(div().w(ASK_W).h(18).mr(8).flex_none().flex().items_center().justify_center()
          .rounded(9).border_1().border_color(t.accent).text_size(12).text_color(t.accent).child("Ask").id("rv-sel-ask").tooltip("Ask one model question about the selected lines")))
        .when(on && !this.composing && this.fsel?.b === lineKey(r), (e) => e.child(div().w(CHIP_W).h(18).mr(12).flex_none().flex().items_center().justify_center()
          .rounded(9).bg(t.accent).text_size(12).font_semibold().text_color(t.accent_foreground).child("+ Comment (c)").id("rv-sel-comment").tooltip("Comment on the selected lines (c)")));
    }
    if (it.t === "gap") {
      const h = it.r.hidden, seg = (label) => div().w(GAP_SEG).flex_none().child(label);
      return h_flex().h(30).w_full().items_center().bg(t.surface).border_t(1).border_b(1).border_color(t.border).text_size(12.5).text_color(t.accent).cursor_pointer()
        .child(div().w(GUTTER).flex_none().text_center().text_color(t.muted).child("⋯"))
        .child(seg(`↓ ${MORE} lines`).id(`rv-gap-${it.path}-${it.r.gap}-d`).tooltip(`Show ${MORE} more lines below the hunk above`)).child(seg(`↑ ${MORE} lines`).id(`rv-gap-${it.path}-${it.r.gap}-u`).tooltip(`Show ${MORE} more lines above the next hunk`))
        .child(div().id(`rv-gap-${it.path}-${it.r.gap}-a`).tooltip("Show every hidden line of this gap").flex_1().child(h === null ? "Load rest of file" : `Show all ${h} lines`));
    }
    // An AI suggestion alone on its line: a one-line margin note without buttons, not a finding and not counted. A
    // click opens its whole text (this.sug); a and x still take it as a comment or hide it.
    if (it.t === "sug") {
      const s = it.s, open = this.sug === s.key;
      return div().w_full().h(this.sizeOf(it)).pl(GUTTER).pr(16).py(2).cursor_pointer().child(v_flex().size_full().px(12).justify_center().gap(4).border_l(2).border_color(t[SEV[s.severity]] ?? t.border).text_size(12.5)
        .child(h_flex().h(20).flex_none().gap(8).items_center().text_color(t.muted)
          .child(div().flex_none().child(`${open ? "▾" : "▸"} AI note · ${s.severity}${s.approx ? " · near this line" : ""}`))
          .when(!open, (e) => e.child(div().flex_1().min_w(0).truncate().child(plain(s.reason)))))
        .when(open, (e) => e.child(div().flex_1().min_h(0).text_size(13.5).line_height(1.55).text_color(t.foreground).child(TextView.markdown(`rv-sgm-${s.key}`, s.reason)))
          .child(div().h(20).flex_none().text_size(12).text_color(t.muted).child("A note, not a finding. Press a to add it as a comment, x to hide it."))));
    }
    if (it.t === "find" || it.t === "fact") {
      const f = it.f, c = t[SEV[f.severity]] ?? t.accent, st = this.fstatus(f), line = this.fixLine(f);
      const card = (e) => e.border_l(4).border_r(1).border_color(c).bg(c + "12");
      if (it.t === "fact") {
        const live = Boolean(this.fixOf(f.id)?.terminal);
        return div().w_full().h(ACT).pl(GUTTER).pr(16).pb(6).child(card(h_flex()).size_full().px(12).gap(BTN_GAP).items_center().border_b(1)
          .child(button(t, "Add to review", live ? t.border : c, t.foreground).id(`rv-fa-c-${f.id}`).tooltip("Add this finding to your pending review comments; nothing is posted until you finish the review"))
          .child(button(t, "Ask an agent…", t.border, t.foreground).id(`rv-fa-d-${f.id}`).tooltip("Ask an agent about this finding: a preview first says what starts and what it may do"))
          .child(button(t, live ? "Go to fix" : "Fix with agent…", live ? c : t.border, t.foreground).id(`rv-fa-f-${f.id}`).tooltip(live ? "Show the fix agent's terminal" : "Have an agent fix this: a preview first says where it works, what it may do and that it never pushes"))
          .child(button(t, "Dismiss finding", t.border, t.muted).id(`rv-fa-x-${f.id}`).tooltip(`Dismiss this finding${f.sources.length > 1 ? ` with all ${f.sources.length} of its sources` : ""}; it stays in the Findings tab under Dismissed`)));
      }
      // One line folded (severity, title, sources, state); open: the head, the fix line, the title and findRows.
      const open = this.findOpen(f), state = div().id(`rv-lfst-${f.id}`).tooltip("Where this finding stands: unresolved, fix sent, fixed (verified) or dismissed").flex_none().text_size(12).font_semibold().text_color(t[FSTATUS[st]?.[1]] ?? t.muted).child(FSTATUS[st]?.[0] ?? st);
      const head = (e) => e.child(div().w(10).flex_none().text_size(12).text_color(t.muted).child(open ? "▾" : "▸"))
        .child(badge(t, f.severity, c).id(`rv-lfs-${f.id}`).tooltip(`${f.severity} is the highest severity among this finding's sources. The scale:\n${SEVERITY_SCALE}`))
        .when(Boolean(f.security), (x) => x.child(badge(t, "⛨ Security", t.ansi1).bg(t.ansi1 + "26").id(`rv-lfsec-${f.id}`).tooltip("A security finding: the security review found it, or its content is about security")));
      const sources = div().id(`rv-lfr-${f.id}`).tooltip("Where this finding comes from, each source with its own severity").min_w(0).truncate().text_size(12).font_semibold().text_color(t.muted).child(this.sourcesOf(f));
      if (!open) return div().id(`rv-lf-${f.id}`).tooltip("Open this finding: what it claims, its text, its suggestion and its actions").w_full().h(FIND_FOLDED).pl(GUTTER).pr(16).pt(6).pb(2).cursor_pointer()
        .child(head(card(h_flex())).size_full().px(12).gap(8).items_center().border_t(1).border_b(1).text_size(13.5)
          .child(div().flex_1().min_w(0).truncate().child(f.title)).child(div().flex_none().max_w(300).child(sources)).child(state));
      return div().w_full().h(this.sizeOf(it)).pl(GUTTER).pr(16).pt(6).cursor_pointer().child(card(v_flex()).size_full().px(12).pt(8).gap(4).border_t(1).text_size(13.5).overflow_hidden()
        .child(head(h_flex().h(18).flex_none().gap(8).items_center()).child(sources).child(state).child(div().flex_1())
          .child(div().id(`rv-lfo-${f.id}`).tooltip("Open this finding in the Findings tab").w(FIND_LINK - 12).flex_none().text_right().text_size(12).text_color(t.accent).child("Open in Findings ↗")))
        .when(Boolean(line), (e) => e.child(div().h(17).flex_none().truncate().text_size(12).text_color(t.muted).child(line)))
        .child(div().flex_none().line_height(1.55).whitespace_normal().font_semibold().child(f.title))
        .children(this.findRows(f).map(([label, text]) => h_flex().flex_none().items_start().line_height(1.55)
          .child(div().w(FIND_LABEL).flex_none().text_size(12).text_color(t.muted).child(label)).child(div().flex_1().min_w(0).child(TextView.markdown(`rv-lfm-${f.id}-${label}`, text))))));
    }
    if (it.t === "ch" || it.t === "cb" || it.t === "cr") return this.cardRow(it, t);
    if (it.t === "pad") return div().w_full().h(60);
    if (it.t === "hidden") return div().w_full().h(24).pl(GUTTER + 4).flex().items_center().text_size(11.5).italic().text_color(t.muted).child(it.text);
    if (it.t === "gh") {
      const g = it.g;
      return div().w_full().h(this.sizeOf(it)).pl(GUTTER).pr(16).pt(6).child(v_flex().size_full().px(12).pt(8).gap(6).border_l(4).border_r(1).border_t(1).border_b(1)
        .border_color(t.border).bg(t.raised).rounded(4).text_size(13.5)
        .child(h_flex().h(18).gap(8).items_center().text_size(12)
          .child(div().font_semibold().text_color(t.foreground).child(g.user ?? "?")).child(div().text_color(t.muted).child(`on GitHub · ${g.at ? ago(g.at) : ""}`))
          // Its line is gone: say which one it was on (GitHub's original line).
          .when(Boolean(it.loose), (e) => e.child(div().text_color(t.muted).child(g.line ?? g.original_line ? `· line ${g.line ?? g.original_line}, not shown` : "· on the file")))
          .when(Boolean(g.outdated), (e) => e.child(badge(t, "Outdated", t.muted).id(`rv-gho-${g.id}`).tooltip("GitHub marks this comment outdated: the code it was on changed since")))
          .when(Boolean(g.resolved), (e) => e.child(badge(t, "Resolved", t.ansi2).id(`rv-ghr-${g.id}`).tooltip("This thread is resolved on GitHub"))))
        .child(div().flex_1().min_h(0).line_height(1.55).text_color(t.foreground).child(TextView.markdown(`rv-ghm-${g.id}`, String(g.body ?? "")))));
    }
    if (it.t === "compose") {
      const c = this.editing, a = c ?? this.selAnchor(), out = Boolean(a) && this.routeNow() === "github" && !inDiff(this.diffLines ?? new Map(), { file: this.fsel?.path, ...a });
      return div().w_full().h(COMPOSE).pl(GUTTER).pr(16).pt(6).child(v_flex().size_full().px(12).pt(8).pb(4).gap(6).border_l(4).border_r(1).border_t(1)
        .border_color(t.muted).bg(t.surface).rounded_tl(4).rounded_tr(4)
        .child(h_flex().h(18).gap(8).items_center().text_size(12)
          .child(div().font_semibold().text_color(t.foreground).child(c ? `Edit comment · ${uiLine(c)}` : a ? `Comment on ${uiLine(a)}` : "Comment"))
          .when(out, (e) => e.child(badge(t, "not in the diff: will go into the review body", t.ansi3).id("rv-compose-out").tooltip("GitHub cannot attach a line comment outside the diff, so it goes into the review body")))
          .child(div().flex_1().min_w(0).truncate().text_right().text_color(t.muted).child(`⌘↩: ${this.composeButtons().find((b) => b.primary).label} · Esc: Cancel`)))
        .child(div().flex_1().min_h(0).px(10).py(6).rounded(6).border_1().border_color(this.typing === "draft" ? t.accent : t.border).bg(t.background).cursor_text()
          .child(Textarea.new(this.draft).size_full().text_size(13.5).text_color(t.foreground))));
    }
    if (it.t === "composeact") {
      const bs = this.composeButtons();
      return div().w_full().h(ACT + 4).pl(GUTTER).pr(16).pb(6).child(h_flex().size_full().px(12).items_center().border_l(4).border_r(1).border_b(1)
        .border_color(t.muted).bg(t.surface).rounded_bl(4).rounded_br(4)
        .children(bs.map((b, i) => div().id(`rv-cb-${b.act}`).tooltip(COMPOSE_TIP[b.act] ?? (this.composeMore ? "Hide Post now to GitHub" : "Another way to send this comment: post it to GitHub at once, outside the review")).w(b.w).h(28).flex_none().ml(i === 0 ? 0 : b.x - bs[i - 1].x - bs[i - 1].w)
          .flex().items_center().justify_center().rounded(6).border_1().border_color(b.primary ? t.solid : t.border).bg(b.primary ? t.solid : t.background)
          .text_size(12.5).text_color(b.primary ? t.solid_foreground : t.foreground).when(Boolean(b.primary), (e) => e.font_semibold())
          .child(this.sending && b.act !== "closeComposer" && b.act !== "insertSuggestion" ? "…" : b.label))));
    }
    if (it.t === "file") {
      const f = it.f, closed = this.collapsed.has(f.path) || Boolean(this.overBudget?.has(f.path)), seen = this.prog.seen.has(f.path), [letter, col] = STATUS[f.status];
      const n = this.comments.filter((c) => c.file === f.path).length, whole = this.whole.has(f.path);
      return h_flex().h(44).w_full().items_center().bg(this.fileFocus === f.path ? t.selected : t.raised).border_t(1).border_b(1).border_color(t.border).text_size(13).cursor_pointer()
        .child(div().id(`rv-fh-chev-${f.path}`).tooltip(closed ? "Expand this file" : "Collapse this file").accessibility_label(closed ? "Expand file" : "Collapse file").w(FILE_CHEV).flex_none().text_center().text_color(t.muted).child(closed ? "▸" : "▾"))
        .child(div().id(`rv-fh-seen-${f.path}`).tooltip("Mark this file as viewed; it collapses and counts in your progress").accessibility_label("Viewed").w(FILE_SEEN).flex_none().text_size(12.5).text_color(seen ? t.ansi2 : t.muted).child(seen ? "☑ Viewed" : "☐ Viewed"))
        .child(div().id(`rv-fh-whole-${f.path}`).when(this.shown().fileHunks?.has(f.path), (e) => e.tooltip("Show the whole file instead of only the changed hunks")).w(FILE_WHOLE).flex_none().text_size(12.5).text_color(whole ? t.accent : t.muted).child(this.shown().fileHunks?.has(f.path) ? (whole ? "◉ Whole file" : "○ Whole file") : ""))

        .child(div().id(`rv-fh-st-${f.path}`).tooltip(`File ${f.status}`).w(22).flex_none().text_size(12).font_semibold().text_color(t[col]).child(letter))
        .child(mono(div()).flex_1().min_w(0).truncate().font_semibold().text_size(13.5).child(f.status === "renamed" ? `${f.from} → ${f.path}` : f.path))
        .when(n > 0, (e) => e.child(div().id(`rv-fh-cm-${f.path}`).tooltip(`${n} pending comments in this file`).px(8).text_size(12).text_color(t.accent).child(`● ${n}`)))
        .child(div().id(`rv-fh-ad-${f.path}`).tooltip(`${f.add} lines added`).px(4).text_size(12.5).text_color(t.ansi2).child(`+${f.add}`)).child(div().id(`rv-fh-dl-${f.path}`).tooltip(`${f.del} lines removed`).pl(2).pr(16).text_size(12.5).text_color(t.ansi1).child(`−${f.del}`));
    }
    // A layer's head over its code: title, why, and the check questions, once and whole, each with the file the
    // analysis names for it. Its pictures follow as rows of their own, as wide as the column.
    if (it.t === "step") {
      const s = it.s, on = it.i === this.cur;
      return v_flex().w_full().h(this.sizeOf(it)).px(16).pt(10).gap(4).bg(on ? t.selected : t.raised).border_t(1).border_color(t.border).cursor_pointer()
        .child(h_flex().h(24).flex_none().gap(10).items_center()
          .child(div().id(`rv-lstep-${it.i}`).tooltip(this.done(s) ? "This layer is checked off" : "Layer number").text_size(14).font_semibold().text_color(this.done(s) ? t.ansi2 : t.muted).child(this.done(s) ? "✓" : `${it.i + 1}`))
          .child(div().flex_1().min_w(0).truncate().text_size(15).font_semibold().child(plain(s.title))))
        .child(div().flex_none().max_w(LAYER_TEXT).line_height(1.55).text_size(13.5).text_color(t.foreground).child(TextView.markdown(`rv-lwhy-${it.i}`, s.why)))
        .when(s.questions.length > 0, (e) => e.child(div().id(`rv-lq-${it.i}`).tooltip("Questions to check while you read this layer's code").h(18).flex_none().mt(4).text_size(11.5).font_semibold().text_color(t.muted).child("CHECK"))
          .children(s.questions.map((q, k) => h_flex().flex_none().max_w(LAYER_TEXT).gap(8).items_start().text_size(13.5).line_height(1.55)
            .child(div().w(12).flex_none().text_color(t.accent).child("?")).child(div().flex_1().min_w(0).child(TextView.markdown(`rv-lqm-${it.i}-${k}`, this.asked(s, q, k)))))));
    }
    if (it.t === "vis") return div().w_full().h(this.sizeOf(it)).px(16).pb(8).bg(it.i === this.cur ? t.selected : t.raised).child(visualCard(it.v, t, `rv-lvis-${it.i}-${it.text}`, null, null, (this.listW ?? 900) - 32));
    if (it.t === "def") return this.defItem(it, t);
    if (it.t === "fold") return div().h(it.h).w_full().pl(GUTTER).pt(8).text_size(12.5).text_color(t.muted).cursor_pointer().child(`${it.n} lines folded to keep the list fast · they open as you scroll here, or click`);
    if (it.t === "path") return mono(h_flex()).h(30).w_full().px(16).items_center().text_size(12.5).text_color(t.muted).truncate().child(it.h.path);
    return div().h(30).w_full().px(16).flex().items_center().text_size(12.5).text_color(t.ansi3).child(it.text);
  },

  // A row's code: plain text now; phase 3 (syntax.js) swaps in highlighted spans here.
  // Highlights queued files outside render, ~12 ms per slice, then redraws; the next render finds them in the cache.
  drainHighlight(cx) {
    const start = Date.now();
    for (const [k, job] of this.hlQueue ?? []) {
      job.hl ??= highlightJob(job.shown, job.lang); // a big file takes several slices: the job keeps its place
      const out = highlightStep(job.hl, Math.max(1, 12 - (Date.now() - start)));
      if (!out) break;
      job.inf.spans = out;
      this.hlQueue.delete(k);
      if (Date.now() - start > 12) break;
    }
    this.hlBusy = false;
    if (this.hlQueue?.size) { this.hlBusy = true; cx.timer.after(0, (cx) => this.drainHighlight(cx)); }
    cx.notify();
  },
  // A row's code, highlighted (syntax.js); spans per row array are computed once per render (spanMap).
  code(r, it) {
    const m = this.spanMap?.get(it.src);
    return h_flex().overflow_hidden().children(renderLine(div, m?.shown[it.ri]?.text ?? r.text, m?.spans[it.ri] ?? [], this.syn));
  },

  // The left column's width: while dragging the pointer's, else the kept one (default 560, 340 to 65% of the window).
  leftW() { return leftWidth(this.dragW ?? shared("review.leftWidth"), this.winW); },
  // The 6 px divider between the column and the diff: drag to resize, double-click for the default width.
  // The Files list's geometry for autoFold (item tops, file headers, folded spans), each open file's height for
  // foldH, and the anchor: after the room moved, the item that was at the top of the view goes back there.
  layFiles(items, keys, sizes, heads) {
    const top = new Float64Array(items.length + 1), folds = [], openH = (this.openH ??= new Map());
    for (let i = 0; i < items.length; i++) top[i + 1] = top[i] + sizes[i];
    const n = items.at(-1)?.t === "pad" ? items.length - 1 : items.length; // the selection toolbar's room isn't a file's
    heads.forEach((h, k) => {
      const end = heads[k + 1] ?? n, it = items[h + 1];
      if (it?.t === "fold") folds.push([top[h + 1], top[h + 2]]);
      else if (it?.t === "row") openH.set(it.path, { rows: it.src, h: top[end] - top[h + 1] }); // rows first: no "Loading file…" note
    });
    this.filesList = { heads, top, folds, keys };
    const a = this.anchor;
    if (a) { this.anchor = null; const i = keys.indexOf(a.key); if (i >= 0 && top[i] !== a.y && !this.top) this.top = { view: "files", i }; }
  },

  splitter(t) {
    return h_flex().id("rv-split").tooltip("Drag to resize the left column; double-click to reset").w(SPLIT).h_full().flex_none().justify_center().cursor_col_resize().bg(this.drag ? t.accent + "33" : t.chrome).hover((s) => s.bg(t.accent + "33"))
      .on_mouse_down("left", (_e, cx) => { this.drag = true; cx.stop_propagation(); cx.notify(); })
      .on_click((e, cx) => { if (e.click_count === 2) { this.drag = false; this.dragW = null; setShared("review.leftWidth", null); cx.notify(); } })
      .child(div().w(1).h_full().bg(this.drag ? t.accent : t.border));
  },

  renderReview(cx) {
    const t = theme(), target = shared("review.target") ?? null, ex = shared("review.explore");
    if (ex) {
      if (this.exStart !== ex) { if (ex.start && this.exStart?.at !== ex.at) this.exRoot = null; this.enterExplore(ex, cx); }
      const root = v_flex().id("rv-root").size_full().bg(t.background).text_color(t.foreground).text_size(13.5)
        .on_size_change((size, cx) => { if (Math.abs((this.winW ?? 0) - size.width) > 8) { this.winW = size.width; cx.notify(); } })
        .on_mouse_move((e, cx) => { if (this.drag) { this.dragW = leftWidth(e.local_position?.x ?? e.position.x, this.winW); cx.notify(); } this.hsMove(e, cx); })
        .on_mouse_up("left", (_e, cx) => { this.hsDrag = null; if (this.drag) { this.drag = false; if (this.dragW !== null && this.dragW !== undefined) setShared("review.leftWidth", this.dragW); this.dragW = null; cx.notify(); } })
        .track_focus(this.fh).on_key_down((e, cx) => this.onReviewKey(e, cx));
      return this.renderExplore(cx, ex, root);
    }
    this.leaveExplore();
    if (target?.url !== this.prSel?.url) { this.prSel = target; this.resetReview(); }
    // After a refresh for the previous target ended; queued, since refresh() notifies and render may not.
    if (!this.refreshQueued && this.prSel && this.key() !== this.context) {
      this.refreshQueued = true;
      cx.timer.after(0, (cx) => { this.refreshQueued = false; this.refresh(cx); });
    }
    if (this.hunks && model() !== this.aiModel && !this.aiBusy) this.loadAi(cx, "cache");
    if (this.prSel) this.loadModels(cx);
    // The diff column's width: card heights wrap to it. on_size_change reports the window in logical px; the column and
    // its rows are laid out in px scaled by the person's zoom (as in settleTop).
    if (this.winW) this.listW = this.winW / (settings().zoom || 1) - this.leftW() - SPLIT - (this.drawerSqueezes() ? 380 : 0);
    // Lines a pinned answer cites: marked in the diff's gutter (memoized on the pins).
    if (this.pinMarksOf !== this.pins()) { this.pinMarksOf = this.pins(); this.pinMarks = new Set(this.pinMarksOf.flatMap((p) => (p.evidence ? [p.evidence.replace(/^(.*?):(\d+).*$/, "$1:$2")] : []))); }
    const other = target && !C.shown(ctxDoc(), prCtx(target), shared);
    const root = v_flex().id("rv-root").size_full().bg(t.background).text_color(t.foreground).text_size(13.5)
      .on_size_change((size, cx) => { if (Math.abs((this.winW ?? 0) - size.width) > 8) { this.winW = size.width; cx.notify(); } })
      // Dragging the divider: the column follows the pointer; the width is kept (shared "review.leftWidth") on release.
      // ponytail: a release outside the window keeps dragging until the next release here.
      .on_mouse_move((e, cx) => {
        if (this.drag) { this.dragW = leftWidth(e.local_position?.x ?? e.position.x, this.winW); cx.notify(); }
        this.hsMove(e, cx);
      })
      .on_mouse_up("left", (_e, cx) => { this.hsDrag = null; if (this.drag) { this.drag = false; if (this.dragW !== null && this.dragW !== undefined) setShared("review.leftWidth", this.dragW); this.dragW = null; cx.notify(); } })
      .track_focus(this.fh).on_key_down((e, cx) => this.onReviewKey(e, cx));
    if (!target || other) {
      return root.items_center().justify_center().gap(12).text_color(t.muted)
        .child(div().child(other ? `This PR belongs to ${C.nameOf(ctxDoc(), prCtx(target))}, which the current view hides.`
          : 'No PR selected: click "Review" on a PR in the PR panel.'))
        .child(pill("rv-empty-back", t, "← Back (Esc)", () => leave()).tooltip("Leave the review (Esc)"));
    }
    // A page (Overview, Architecture…) or a definition covers the list: skip building it (a big PR's diff is the bulk
    // of a render, and a picture's sideways scroll renders per wheel event); this.items/at/byKey keep the last list.
    const listShown = !this.defFile && !(this.tab === "steps" && this.page);
    if (listShown) this.traces = this.traceMap();
    const { items, at, heads } = listShown ? this.itemsOf(this.tab === "steps" ? "steps" : "files") : { items: [], at: {} };
    if (this.selected().length) items.push({ t: "pad" }); // room for the selection toolbar
    if (this.pendingScroll && at[this.pendingScroll] !== undefined) { this.scrollTo(this.tab === "steps" ? "steps" : "files", this.pendingScroll); this.pendingScroll = null; }
    if (this.scrollCompose && at.compose !== undefined) { this.lists[this.tab === "steps" ? "steps" : "files"].scroll_to_item(at.compose, "center"); this.scrollCompose = false; }
    this.uiChanged(cx);
    this.syn = colors(t);
    // Per row array (memoRows keeps them across renders), so a render neither hashes nor tokenizes a big diff again:
    // uncolored until drainHighlight fills in the spans.
    const head = this.worktree?.head ?? "";
    if (!this.spanMap || this.spanHead !== head) { this.spanMap = new WeakMap(); this.spanHead = head; }
    for (const it of items) {
      if (it.t !== "row" || this.spanMap.has(it.src)) continue;
      const shown = it.src.map((r) => (r.text?.includes("\t") ? { ...r, text: expandTabs(r.text) } : r)); // tabs drawn as spaces: clicks map back
      const inf = { shown, spans: [] }, lang = langOf(it.path);
      this.spanMap.set(it.src, inf);
      if (lang) (this.hlQueue ??= new Map()).set(inf, { shown, lang, hkey: `${head}:${it.path}`, inf });
    }
    if (this.hlQueue?.size && !this.hlBusy) { this.hlBusy = true; cx.timer.after(0, (cx) => this.drainHighlight(cx)); }
    if (items.length > 9990) items.length = 9990; // the virtual list's hard limit is 10000
    const keys = itemKeys(items), sizes = items.map((it) => this.sizeOf(it));
    if (listShown) { this.items = items; this.at = at; this.byKey = new Map(keys.map((k, i) => [k, items[i]])); }
    if (heads) this.layFiles(items, keys, sizes, heads.filter((h) => h < items.length));
    if (listShown) this.settleTop(this.tab === "steps" ? "steps" : "files", at, sizes, cx);
    const listId = `rv-list-${this.tab === "steps" ? "steps" : "files"}`;
    const range = this.fsel && rangeOf(this.rowsFor(this.fsel.path), this.fsel.a, this.fsel.b);
    this.selKeys = range ? new Set(this.rowsFor(this.fsel.path).slice(range[0], range[1] + 1).map(lineKey)) : null;
    const tabBtn = (id, label) => div().id(`rv-tab-${id}`).tooltip(TAB_TIP[id]).flex_1().h(32).flex().items_center().justify_center().rounded(7).text_size(13.5).cursor_pointer()
      .bg(this.tab === id ? t.selected : t.chrome).text_color(this.tab === id ? t.foreground : t.muted).when(this.tab === id, (e) => e.font_semibold()).hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => { this.tab = id; cx.notify(); }).child(label);
    return root
      .child(this.metaRow(t))
      .child(h_flex().flex_1().min_h(0)
        .child(v_flex().w(this.leftW()).flex_none().h_full().bg(t.chrome)
          .child(this.pagesRow(t))
          .child(h_flex().flex_none().p(8).gap(6).border_b(1).border_color(t.border)
            .child(tabBtn("files", `Files · ${this.shown().patch.length}`)).child(tabBtn("steps", `Layers${this.ai ? ` · ${this.ai.steps.filter((s) => !s.pseudo).length}` : ""}`))
            .child(tabBtn("comments", `Comments${this.commentRowsNow().length ? ` · ${this.commentRowsNow().length}` : ""}`))
            .child(tabBtn("findings", `Findings${this.findings().length ? ` · ${this.counts().unresolved}` : ""}`)))
          .child(this.tab === "steps" ? this.stepsPane(t, cx) : this.tab === "findings" ? this.findingsPane(t) : this.tab === "comments" ? this.commentsPane(t) : this.filesPane(t)))
        .child(this.splitter(t))
        .child(v_flex().flex_1().min_w(0).h_full().relative()
          .child(div().id("rv-probe").absolute().top(-100).font_family(settings().font_family ?? "JetBrains Mono").text_size(13).whitespace_nowrap()
            .on_size_change((size, cx) => { const w = size.width / PROBE.length; if (w > 0 && Math.abs((this.charW ?? 0) - w) > 0.01) { this.charW = w; cx.notify(); } }).child(PROBE))
          .when(Boolean(this.defFile), (e) => e.child(this.defView(t)))
          .when(!this.defFile && this.tab === "steps" && Boolean(this.page), (e) => e.child(this.pageView(t)))
          .when(!this.defFile && this.tab === "files" && Boolean(this.since), (e) => e.child(this.sinceBanner(t)))
          .when(Boolean(this.worktree?.path) && !this.trustedPr() && !this.trustAsked(), (e) => e.child(this.trustPrompt(t)))
          .when(Boolean(this.needClone), (e) => e.child(h_flex().flex_none().px(14).py(8).gap(10).items_center().bg(t.ansi3 + "1c").border_b(1).border_color(t.border).text_size(12.5)
            .child(div().flex_1().min_w(0).whitespace_normal().child(`No local clone of ${target.repo ?? "this repo"}: reviewers, whole files, definitions and the AI analysis need one. The diff works without.`))
            .child(pill("rv-clone", t, this.cloning ? "Cloning…" : `Clone to ${this.needClone.replace(home(), "~")}`, (_e, cx) => { if (!this.cloning) { this.makeWorktree(cx, true); cx.notify(); } }, false, t.foreground).tooltip("Clone the repository once, so the PR head can be checked out for reviewers and go-to-definition"))))

          .when(listShown, (e) => e.child(div().id(`${listId}-wrap`).flex_1().min_h(0).relative().on_size_change((size) => { this.listH = size.height; })

            // The Files list: scrolling, or dragging its scrollbar, near a folded file opens the files around the view.
            .when(Boolean(heads), (e) => e.on_scroll_wheel((_e, cx) => this.autoFold(cx)).on_mouse_move((_e, cx) => this.autoFold(cx)).on_mouse_up("left", (_e, cx) => this.autoFold(cx)))
            // With the composer open, onItem decides where the keyboard goes (a press in the textarea keeps it).
            .on_mouse_down("left", (e, cx) => { this.press = { x: e.local_position?.x ?? 0, w: e.bounds?.width ?? this.listW ?? 900, shift: e.modifiers.shift, cmd: e.modifiers.platform }; if (!this.composing) this.fh.focus(); })
            .child(items.length
              ? v_virtual_list(listId, items.length, sizes, (i) => keys[i], (range) => { if (heads) this.vis = { start: range.start, end: range.end }; return items.slice(range.start, range.end).map((it) => this.item(it, t)); })
                .track_scroll(this.lists[this.tab === "steps" ? "steps" : "files"]).on_item_click((key, cx) => this.onItem(key, cx)).size_full()
              : div().p(20).text_size(13.5).text_color(this.error ? t.ansi1 : t.muted).child(this.error || (this.loading || !this.patch
                ? h_flex().gap(8).child(div().child(SPIN[0]).frames(SPIN, 90)).child("Loading…") : "No diff")))
            .child(Scrollbar.vertical(listId).absolute().inset_0())))
          .when(Boolean(this.note), (e) => e.child(div().flex_none().px(14).py(8).border_t(1).border_color(t.border).text_size(12.5).text_color(/Could not|Not sent|Not posted|Select a line/.test(this.note ?? "") ? t.ansi1 : t.muted).child(this.note)))
          .when(Boolean(this.saveErr), (e) => e.child(this.saveErrBar(t)))
          .when(Boolean(this.replyTo), (e) => e.child(this.replyBar(t)))
          .when(this.selected().length > 0, (e) => e.child(this.selectionBar(t)))
          .when(Boolean(this.applyBlocked), (e) => e.child(h_flex().flex_none().px(14).py(8).gap(8).items_center().border_t(1).border_color(t.border).bg(t.ansi3 + "1c").text_size(12.5)
            .child(div().flex_1().whitespace_normal().child(`${this.applyBlocked.branch}: the PR's checkout isn't clean, so it can't be applied here.`))
            .child(pill("rv-handover", t, "Hand over…", (_e, cx) => this.handOverApply(this.applyBlocked, cx), false, t.foreground).tooltip("Ask the main agent to apply the fix; a preview first"))
            .child(pill("rv-handover-x", t, "Later", (_e, cx) => { this.applyBlocked = null; cx.notify(); }).tooltip("Dismiss this notice"))))
          .when(this.finishOpen && !this.sendP, (e) => e.child(this.finishPopover(t)))
          .when(Boolean(this.sendP), (e) => e.child(this.sendPopover(t)))
          .when(!this.drawerSqueezes() && this.drawerState() === "open", (e) => e.child(div().absolute().top(0).right(0).bottom(0).child(this.askDrawer(t))))
          .when(this.drawerState() === "collapsed", (e) => e.child(div().absolute().top(0).right(0).bottom(0).child(this.drawerStrip(t)))))
        .when(this.drawerSqueezes(), (e) => e.child(this.askDrawer(t))));
  },

  // ---- the Overview page's helpers

  taskNow() { return taskList(this.ai?.asks ?? [], this.findings(), this.ai?.unlinked ?? [], (f) => this.fstatus(f)); },
  toggleAsk(id) { if (!this.askOpen.delete(id)) this.askOpen.add(id); },

  // The bar's "Repo rules 2/2": the rules this PR is checked against (the title's form and the analysis' repo rules)
  // by name in the tooltip; CI and conflicts only when GitHub reports some. null: nothing to say yet.
  checkFacts() {
    if (!this.prSel) return null;
    const checks = this.checksNow(), ci = checks.filter((c) => c.ci), rules = checks.filter((c) => !c.ci && c.name !== "No merge conflicts"), ok = (l) => l.filter((c) => c.ok === true).length;
    const parts = [rules.length > 0 && [`Repo rules ${ok(rules)}/${rules.length}`, rules.some((c) => c.ok === false)], ci.length > 0 && [`CI ${ok(ci)}/${ci.length}`, ci.some((c) => c.ok === false)],
      checks.some((c) => c.name === "No merge conflicts" && c.ok === false) && ["Merge conflicts", true]].filter(Boolean);
    if (!parts.length) return null;
    return { parts, tip: `${rules.length ? `Rules this PR is checked against: ${rules.map((c) => `${c.name} (${c.ok ? "met" : "not met"})`).join(", ")}. ` : ""}${this.ctx && !ci.length ? "GitHub reports no CI checks for this PR. " : ""}Click for the list on the Overview page.` };
  },

  // The right pane's page to its top, its bottom or one of its sections (pageAnchors: name → child), as the wheel
  // would. A plain scroll area only reveals a child at its near edge, so the bottom first, then the section: it is
  // above the view then and lands at the top.
  scrollPage(key, cx) {
    cx.timer.after(30, (cx) => { // after the render that shows the page
      this.pageScroll.scroll_to_item((this.pageLen ?? 1) - 1); cx.notify();
      if (key !== "bottom") cx.timer.after(60, (cx) => { const i = key === "top" ? 0 : this.pageAnchors[key]; if (i !== undefined) this.pageScroll.scroll_to_item(i); cx.notify(); });
    });
  },

  // "Copy review state" (the ⋯ menu): the verdict, the task check and the findings by state as text for a colleague.
  copyState() {
    if (!this.prSel) return;
    const p = this.progressNow();
    const text = reviewState({ pr: this.prSel, head: this.worktree?.head ?? this.prSel.headSha ?? "", list: this.taskNow(), counts: this.counts(), findings: this.findings(), statusOf: (f) => this.fstatus(f),
      progress: `Reviewer's progress: ${p.filesViewed} of ${p.files} files viewed, ${p.comments} pending ${p.comments === 1 ? "comment" : "comments"}.` });
    copyText(text);
    this.note = `Review state copied as text (${text.trim().split("\n").length} lines), nothing was posted.${this.findings().some((f) => f.security) ? " Security findings are in it with their title only." : ""}`;
  },

  // Progress that could not be saved: what that means, and the one thing to do about it.
  saveErrBar(t) {
    const why = /changed outside/i.test(this.saveErr) ? "the progress file changed while it was written" : this.saveErr;
    return h_flex().id("rv-save-err").flex_none().px(14).py(8).gap(10).items_center().border_t(1).border_color(t.border).bg(t.ansi1 + "26").text_size(12.5)
      .child(div().flex_1().min_w(0).whitespace_normal().child(`Could not save your progress (viewed files, checked layers, your place): ${why}. It is kept in this window; it is lost if you close the review before it is saved.`))
      .child(pill("rv-save-again", t, "Save again", (_e, cx) => this.saveProgress(cx), false, t.foreground).tooltip("Write your progress to disk again"));
  },
};

const LAYER_FILES = 12; // an open layer lists this many of its files in the left column
// The "Viewed" tick of a file in the left column: a 16 px box, its row is the click target.
function viewedBox(t, seen) {
  return div().w(16).h(16).flex_none().flex().items_center().justify_center().rounded(4).border_1().border_color(seen ? t.ansi2 : t.muted)
    .text_size(11.5).font_semibold().text_color(t.ansi2).child(seen ? "✓" : "");
}

// Who serves a model call of a context and where its login lives: the config folder, never an account's name.
function accountOf(ctx) {
  const env = C.infoOf(ctxDoc(), ctx).env ?? {};
  const via = env.CLAUDE_CODE_USE_BEDROCK ? "Amazon Bedrock" : env.CLAUDE_CODE_USE_VERTEX ? "Google Vertex AI" : "Anthropic";
  return `Claude Code (${via}) · account in ${String(env.CLAUDE_CONFIG_DIR ?? "~/.claude").replace(home(), "~")}`;
}

// A tick box big enough to hit (16 px), drawn: the glyphs ☑ and ☐ are 8 px marks in this font.
function tickBox(t, on) {
  return div().w(16).h(16).flex_none().flex().items_center().justify_center().rounded(4).border_1().border_color(on ? t.accent : t.muted).bg(on ? t.accent : t.background)
    .text_size(11).font_semibold().text_color(t.accent_foreground).child(on ? "✓" : "");
}
const DRY_TIP = "Dry run: this installation posts nothing to GitHub. What a post would send is written to a file instead (\"dryRun\": true in pr-review.config.json).";
const PUBLIC_TIP = "This comes from a security finding: once posted, its text is readable by everyone who can see the PR.";
