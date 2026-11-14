#!/usr/bin/env python3
"""Automated reviewers for the review layout: Claude's /code-review, Claude's /security-review, `codex review`.

argv[1]: JSON {kind: "claude"|"security"|"codex", url, number, context ({id, env}: the PR's), model (a Claude
model or alias from models.py; haiku runs as sonnet, llm.code_model), codexModel (a Codex slug from models.py; none: Codex's default), worktree (a detached checkout of the PR head, worktree.py), base (the PR's base branch),
head (sha), level (code-review effort: low|medium|high), file (pr-data/findings/<url hash>.json)}.
Runs the reviewer read-only in the worktree (Claude: Read/Grep/Glob/Agent and read-only git/gh Bash only, no edits;
Codex: sandbox_mode=read-only), turns its answer into findings {id, reviewer, file, line, end, severity, title,
detail, suggestion, code, and when the reviewer gave them: category, impact, effect, preconditions, certainty (see
review.py: the severity follows from the impact by the fixed scale)} and merges them into `file` under that reviewer
(other reviewers' findings and every status stay). A review that comes back as text (Codex's, or a slash command that
answered in prose) goes through a cheap Haiku pass in the PR's context. Every call goes to the optional
ledger (llm.py). The slash-command reviewers need those commands in the Claude setup: when one is missing, the same
review runs as a plain prompt. Codex is optional (`codex` on PATH).
runs[kind] in `file` says how the run went: {state: "running", busy, started, pid, head}, then {state: "done", count, cost,
ms, model, at, head, scope, note?} or {state: "failed", error, at, head}; each also auto (why it started by itself) when
the request had it; no entry: never run. scope is the reviewer's own report
{read: [files], checked: [{area, result: finding|clean|not_checked, note}], skipped: [what it left out]}, or None when
it gave none. A run without an answer fails; it is never "0 findings". Prints the run; exit 1 with the reason on stderr.
The security run also draws the PR's security view over the newest analysis' architecture picture (picture()) and
writes it as `security` {head, at, picture, zones, access, crossing, threats} into `file` (security_view()); its
findings get reachable_from and reachability. The analysis draws none of it.
"""
import fcntl
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import time

sys.dont_write_bytecode = True  # a .pyc written into the mod's folder reloads the mod: the view waiting for this run is gone
import llm  # noqa: E402  (this folder)
import related  # noqa: E402  (the diff read as files and added lines)
import review  # noqa: E402  (the severity scale and the areas of a run's self-report)

FEATURE = {"claude": "Claude code review", "security": "Security review", "codex": "Codex review"}
BUDGET = {"haiku": 0.5, "sonnet": 3.0, "opus": 8.0}
TIMEOUT = 1500
READ_ONLY = ["Read", "Grep", "Glob", "Agent",
             "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)", "Bash(git status:*)", "Bash(git blame:*)",
             "Bash(git merge-base:*)", "Bash(git rev-parse:*)", "Bash(git ls-files:*)", "Bash(gh pr diff:*)", "Bash(gh pr view:*)"]
PLACE = {"file": review.S, "line": {"type": "integer"}, "end": {"type": "integer"}, **review.PROSE}
# A review turned from text: what its words give, nothing judged on top.
PLAIN_FINDINGS = {"type": "object", "required": ["findings"], "properties": {"findings": {"type": "array", "items": {
    "type": "object", "required": ["file", "line", "severity", "title", "detail"], "properties": {
        **PLACE, "severity": {"enum": review.LEVELS}, "category": {"enum": review.CATEGORIES}}}}}}
ASK_PLAIN = ("\n\nAnswer with the findings in the requested JSON: file (path in the repo), line (line number on the new "
             "side, as in the PR head), end (last line, optional), severity (high|medium|low), category (optional), title "
             "(one line), detail (why it is a problem), suggestion (the fix, optional). An empty list is fine.")
AREAS = {"claude": review.AREAS_CODE, "security": review.AREAS_SECURITY}
ASK = ("When you are done, answer with the requested JSON. findings: file (path in the repo), line (line number on the new "
       "side, as in the PR head), end (last line, optional), category (structure, security, data, scope, requirement, bug, "
       "test, availability), " + review.JUDGED_TEXT + ", title (one line, plain text), detail (why it is a problem; claim only what the "
       "certainty covers), suggestion (the fix, optional). " + review.TEXTS + " Only real problems; an empty list is fine. scope: your own report "
       "of the work: read (the files you read), checked (one row per area, each with " + review.CHECKED_TEXT + "), skipped "
       "(what you left out and why, short phrases).")
# ---- The security view: trust zones over the analysis' picture, who may do what on the PR's resources (access), from
# where each finding is reachable, and a threat model of the places the PR opens or changes across a trust boundary.
TRUST = ["public", "authenticated", "internal", "data"]
AUTH_KINDS = ["none", "code", "gateway", "iam"]
REACH = ["public", "authenticated", "internal_only", "unknown"]
THREAT_RESULTS = ["finding", "checked_clean", "not_checked"]
S = review.S
SECURITY = {
    "zones": {"type": "array", "maxItems": 8, "items": {"type": "object", "required": ["id", "name", "trust", "evidence", "nodes"], "properties": {
        "id": S, "name": S, "trust": {"enum": TRUST}, "evidence": S, "nodes": review.STRINGS}}},
    "access": {"type": "array", "maxItems": 16, "items": {"type": "object", "required": ["id", "resource", "kind", "principal", "actions", "public", "auth", "auth_kind", "at"], "properties": {
        "id": S, "resource": S, "kind": S, "principal": S, "actions": review.STRINGS, "public": {"type": "boolean"}, "auth": S, "auth_kind": {"enum": AUTH_KINDS},
        "used": {"type": "boolean"}, "at": S, "node": S}}},
    "threats": {"type": "array", "items": {"type": "object", "required": ["where", "boundary", "threat", "findings", "result"], "properties": {
        "where": {"type": "object", "properties": {"access": S, "from": S, "to": S}}, "boundary": S, "threat": S, "findings": review.STRINGS,
        "result": {"enum": THREAT_RESULTS}, "note": S}}}}
ASK_SECURITY = (
    " Each finding also has ref (f1, f2, … in order; threats name findings by it) and reachability (who can reach the flaw: "
    "public, authenticated, internal_only, or unknown when the code does not show it). In infrastructure code, a permission "
    "the diff grants that no code uses and an entry point (a route, a function URL, a public bucket) without an authorizer "
    "are findings at their lines. zones: the trust zones the code and the infrastructure code show, at most 8, none from "
    "guessing: id, name (e.g. \"Internet\", \"HTTP API\", \"Orders function\", \"Orders queue\"), trust (public: anyone "
    "reaches it without credentials; authenticated: reached only after the caller was checked, at a gateway or in code; "
    "internal: reached only by the system's own parts, through IAM or the network; data: where state is kept, e.g. a queue, "
    "table, bucket or store), evidence (file:line), nodes (the ids of the picture's nodes in it, from the list in the prompt; "
    "a module takes the zone of the unit it runs in; a node in at most one zone). access: who may do what on the resources "
    "that the PR's infrastructure code adds or changes (IAM policies and roles, resource policies, routes and their "
    "authorizers, public flags), one row per grant or entry point, at most 16: id (acc1, acc2, … in order), resource (its "
    "name in the template), kind (e.g. queue, function, route, bucket, table), principal (who gets it: a function, a role, "
    "\"anyone on the internet\"), actions (e.g. sqs:SendMessage, \"call GET /items\"), public (true when it is reachable "
    "without credentials of the cloud account), auth (what checks the caller, e.g. \"bearer token checked in handler.py\"), "
    "auth_kind (none: nothing checks the caller; code: a check in the application's code; gateway: an authorizer or key at "
    "the gateway; iam: the cloud's IAM), used (false when nothing in the code uses the grant), at (file:line), node (the id "
    "of its picture node, if any); empty when the PR has no infrastructure code. threats: a threat model of the places this "
    "PR opens or changes where something crosses a trust boundary; one entry per concrete threat, as many as the code "
    "gives, none to fill a list, empty when the PR opens or changes no such place: where (access: the id of an access row "
    "the PR adds or changes; or from and to: two picture nodes in zones of different trust whose call the PR adds or "
    "changes), boundary (the boundary crossed, e.g. \"Internet → Front desk function\"), threat (one sentence about this "
    "code: who does what, through which line), findings (the refs of your findings that show it), result (finding: a "
    "finding shows it; checked_clean: you read the code and it holds; not_checked: you could not check it), note (what you "
    "checked or why not, a few words).")
ASK_JSON = "\n\n" + ASK


def findings_schema(kind):
    """What a Claude reviewer answers with. The ask is also the schema's description: a slash command that runs as a
    fork takes no extra prompt text (it would read it as the review target), but it sees the schema. The security
    reviewer also answers with its view (SECURITY)."""
    sec = kind == "security"
    extra = {"ref": S, "reachability": {"enum": REACH}} if sec else {}
    return {"type": "object", "description": ASK + (ASK_SECURITY if sec else ""), "required": ["findings", "scope", *(SECURITY if sec else [])], "properties": {
        "findings": {"type": "array", "items": {"type": "object", "required": ["file", "line", "title", "detail", *review.JUDGED, *(["ref"] if sec else [])],
                                               "properties": {**PLACE, **review.JUDGED, **extra}}},
        "scope": {"type": "object", "required": ["read", "checked", "skipped"], "properties": {
            "read": review.STRINGS, "checked": review.checked_schema(AREAS[kind]), "skipped": review.STRINGS}},
        **(SECURITY if sec else {})}}


MISSING = re.compile(r"unknown (slash )?(command|skill)|no such (command|skill)|not a (known|valid) (command|skill)", re.I)
PLAIN = {"claude": "Review the changes of this checkout against origin/{base} (git diff origin/{base}...HEAD), which are "
                   "PR #{number}, for bugs and correctness problems: read the surrounding code before you report anything.",
         "security": "Do a security review of the changes of this checkout against origin/{base} (git diff "
                     "origin/{base}...HEAD), which are PR #{number}: injection, auth, secrets, unsafe input handling, "
                     "data exposure. Report only real, exploitable problems."}


def git(*args, cwd):
    r = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, timeout=300)
    if r.returncode != 0:
        raise RuntimeError(f"git {args[0]}: {(r.stderr or r.stdout).strip()[:200]}")
    return r.stdout


def normalize(raw, reviewer, worktree):
    """Reviewer findings with a stable id and the code line they point at (to notice when a push changes it)."""
    out = []
    for f in raw or []:
        f = review.judge(dict(f))
        path = str(f.get("file") or "").strip().removeprefix("./")
        if path.startswith(str(worktree)):
            path = path[len(str(worktree)):].lstrip("/")
        line = int(f.get("line") or 0)
        title = str(f.get("title") or "").strip()
        if not path or not title:
            continue
        code = ""
        try:
            lines = (pathlib.Path(worktree) / path).read_text(errors="replace").splitlines()
            code = lines[line - 1] if 0 < line <= len(lines) else ""
        except OSError:
            pass
        fid = hashlib.sha1(f"{reviewer}|{path}|{line}|{title}".encode()).hexdigest()[:12]
        out.append({"id": fid, "reviewer": reviewer, "file": path, "line": line, "end": int(f.get("end") or line),
                    "severity": f["severity"], "title": title, "detail": str(f.get("detail") or ""), "suggestion": str(f.get("suggestion") or ""),
                    "code": code, **{k: f[k] for k in (*review.JUDGED, "ref", "reachability") if f.get(k)}})
    return out


def picture(file):
    """The newest analysis of this PR that has an architecture picture (pr-data/cache/rv-<the findings file's
    name>-….json next to pr-data/findings): its answer and when it was made; ({}, None) without one."""
    file = pathlib.Path(file)
    for f in sorted(file.parent.parent.joinpath("cache").glob(f"rv-{file.stem}-*.json"), key=lambda f: f.stat().st_mtime, reverse=True):
        try:
            doc = json.loads(f.read_text()) if "." not in f.name.removesuffix(".json") else {}
        except (OSError, ValueError):
            continue
        if ((doc.get("answer") or {}).get("architecture") or {}).get("nodes"):
            return doc["answer"], doc.get("generated")
    return {}, None


def picture_text(pic):
    """The analysis' picture for the security reviewer's prompt: the node ids it may name."""
    arch = pic.get("architecture") or {}
    if not arch.get("nodes"):
        return "\n\nThis PR has no architecture picture yet: zones name no nodes, and threats sit only at access rows."
    return ("\n\nThe architecture picture of this PR from its analysis. Nodes (id: label, type, status, file:line):\n"
            + "\n".join(f"- {n.get('id')}: {n.get('label')}, {n.get('type') or ''}, {n.get('status') or ''}, {n.get('at') or ''}" for n in arch["nodes"])
            + "\nEdges (caller -> callee: label, status):\n"
            + "\n".join(f"- {e.get('from')} -> {e.get('to')}: {e.get('label') or ''}, {e.get('status') or ''}" for e in arch.get("edges") or []))


def spot(x):
    """(file, line) of an `at` such as "a.py:12"; line 0 when it names none."""
    path, _, line = str(x.get("at") or "").removeprefix("./").rpartition(":")
    m = re.match(r"\d+", line)
    return (path, int(m[0])) if m else (path or line, 0)


def reach(nodes, edges, components, rows, findings):
    """From where each finding's place can be reached: reachable_from, the ids of the access rows that sit in the
    finding's own lines; else of those at the finding's node (the nearest place of the picture above its line: a
    node's, component's or access row's `at` in the same file); else, when that node has none, at the nearest nodes
    that call it (edges backwards). reachability is the most exposed of them: public (a public row that nothing checks,
    or the finding is the broken check itself: impact unauthorized_access), authenticated (a public row behind a
    check), internal_only. Without any row the model's own reachability stays (reachable_from is then empty), else
    unknown. ponytail: one node per finding and breadth-first over call edges."""
    callers = {}
    for e in edges:
        callers.setdefault(e.get("to"), []).append(e.get("from"))
    at = lambda n: [r for r in rows if r.get("node") == n]  # noqa: E731
    anchors = [(*spot(x), x.get("id")) for x in nodes] + [(*spot(x), x.get("node")) for x in [*components, *rows]]
    for f in findings:
        file, line = str(f.get("file") or "").removeprefix("./"), int(f.get("line") or 0)
        here = sorted((n, node) for path, n, node in anchors if path == file and node)
        start = next((node for n, node in reversed(here) if n <= line), here[0][1] if here else None)
        found = [r for r in rows if spot(r)[0] == file and line and line <= spot(r)[1] <= int(f.get("end") or line)]
        layer, seen = [start] if start and not found else [], set()
        while layer and not found:
            seen.update(layer)
            found = [r for n in layer for r in at(n)]
            layer = [c for n in layer for c in callers.get(n, []) if c not in seen]
        level = lambda r: ("public" if r.get("auth_kind") == "none" or f.get("impact") == "unauthorized_access" else "authenticated") if r.get("public") else "internal_only"  # noqa: E731
        f["reachable_from"] = [r["id"] for r in found]
        if found:
            f["reachability"] = min((level(r) for r in found), key=REACH.index)
        elif f.get("reachability") not in REACH:
            f["reachability"] = "unknown"


def security_view(answer, findings, pic, changed):
    """The security reviewer's view checked against the analysis' picture (pic: its answer, {} without one) and the
    diff (changed: {path: line numbers the diff adds}, None when unknown). Sets each finding's reachable_from and
    reachability (reach) and drops its ref. Returns {zones: [{id, name, trust, evidence, nodes}], access: [{id: acc1..,
    …, opened_by_pr (only with a known diff)}], crossing: [{from, to, edge: e<k> in the picture's edges}] (the calls
    between zones of different trust), threats: [{id: t1.., where: {access} | {from, to, edge}, boundary, threat,
    findings: finding ids, result, note}]}. Only what has its place stays, nothing is filled in: a zone's node must be
    on the picture; a threat must sit at an access row the PR adds or changes, or at a crossing call that the PR adds or
    changes (the edge or one of its ends new or changed); a threat with findings is result finding, one that names
    none cannot be."""
    arch = pic.get("architecture") or {}
    nodes, edges = arch.get("nodes") or [], arch.get("edges") or []
    ids = {n.get("id") for n in nodes}
    zones, zone_of = [], {}
    for z in answer.get("zones") or []:
        if isinstance(z, dict) and z.get("id") and z.get("trust") in TRUST and z["id"] not in [x["id"] for x in zones]:
            mine = [n for n in dict.fromkeys(z.get("nodes") or []) if n in ids and n not in zone_of]
            zone_of.update((n, z) for n in mine)
            zones.append({"id": str(z["id"]), "name": str(z.get("name") or z["id"]), "trust": z["trust"], "evidence": str(z.get("evidence") or ""), "nodes": mine})
    trust = lambda n: (zone_of.get(n) or {}).get("trust")  # noqa: E731
    crossing = [{"from": e["from"], "to": e["to"], "edge": f"e{k}"} for k, e in enumerate(edges)
                if trust(e.get("from")) and trust(e.get("to")) and trust(e["from"]) != trust(e["to"])]
    rows, named = [], {}
    for r in answer.get("access") or []:
        if not isinstance(r, dict) or not r.get("resource"):
            continue
        row = {**{k: v for k, v in r.items() if k != "node" or v in ids}, "id": f"acc{len(rows) + 1}"}
        named.setdefault(str(r.get("id") or row["id"]), row["id"])
        if changed is not None:
            path, line = spot(row)
            row["opened_by_pr"] = line in changed.get(path, ())
        rows.append(row)
    reach(nodes, edges, pic.get("components") or [], rows, findings)
    refs = {f.pop("ref"): f["id"] for f in findings if f.get("ref")}
    status = {n.get("id"): n.get("status") for n in nodes}
    threats = []
    for t in answer.get("threats") or []:
        w, text = (t.get("where") or {}) if isinstance(t, dict) else {}, str((t or {}).get("threat") or "").strip()
        row = next((r for r in rows if r["id"] == named.get(str(w.get("access")))), None)
        cross = next((c for c in crossing if (c["from"], c["to"]) == (w.get("from"), w.get("to"))), None)
        if row is not None and row.get("opened_by_pr") is not False:
            where = {"access": row["id"]}
        elif row is None and cross and {edges[int(cross["edge"][1:])].get("status"), status.get(cross["from"]), status.get(cross["to"])} & {"new", "changed"}:
            where = dict(cross)
        else:
            continue
        if not text:
            continue
        found = [refs[x] for x in dict.fromkeys(t.get("findings") or []) if x in refs]
        result = "finding" if found else t.get("result") if t.get("result") in THREAT_RESULTS[1:] else "not_checked"
        threats.append({"id": f"t{len(threats) + 1}", "where": where, "boundary": str(t.get("boundary") or ""), "threat": text,
                        "findings": found, "result": result, "note": str(t.get("note") or "")})
    return {"zones": zones, "access": rows, "crossing": crossing, "threats": threats}


def scope(raw, kind):
    """The reviewer's own report of its work: {read, checked (every area of this reviewer; left out: not_checked),
    skipped}. None when it gave none (Codex, a review turned from text)."""
    if not isinstance(raw, dict) or kind not in AREAS:
        return None
    return {"read": [str(x).removeprefix("./") for x in raw.get("read") or []], "checked": review.checked(raw.get("checked"), AREAS[kind]),
            "skipped": [str(x) for x in raw.get("skipped") or []]}


def from_text(text, req, meta):
    """A review written as text turned into findings by a cheap Haiku pass in the PR's context; its cost joins meta."""
    m = {}
    answer = llm.claude(FEATURE[req["kind"]], "Turn this code review into findings. Keep its wording; do not add findings.\n\n"
                        + text[-60000:] + ASK_PLAIN, context=req.get("context"), model="haiku", schema=PLAIN_FINDINGS, budget=0.3,
                        timeout=300, meta=m)
    if answer is None:
        raise RuntimeError(f"{FEATURE[req['kind']]}: the review could not be turned into findings")
    meta.update(cost=(meta.get("cost") or 0) + (m.get("cost") or 0), ms=(meta.get("ms") or 0) + (m.get("ms") or 0),
                model_id=meta.get("model_id") or m.get("model_id"))
    return answer


def merge(file, reviewer, head, findings, run, security=None):
    """Replace this reviewer's findings (None: keep them, only the run changes) and, given one, the security view in
    the PR's file, under a lock; statuses (set by the panel) stay. ponytail: the panel writes statuses without this lock (compare-and-swap on the
    whole file), so a status set in the very moment a reviewer finishes can be lost."""
    file.parent.mkdir(parents=True, exist_ok=True)
    with open(file.with_suffix(".lock"), "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        doc = json.loads(file.read_text()) if file.exists() else {}
        if findings is not None:
            doc["findings"] = [f for f in doc.get("findings", []) if f["reviewer"] != reviewer] + [{**f, "head": head} for f in findings]
        doc.setdefault("runs", {})[reviewer] = run
        if security is not None:
            doc["security"] = security
        tmp = file.with_name(f".{file.name}.{os.getpid()}.tmp")
        tmp.write_text(json.dumps(doc, ensure_ascii=False, indent=1))
        tmp.replace(file)


def missing_command(text):
    return bool(MISSING.search(str(text or "")))


def code_review_command(req):
    """The /code-review call: the level, then the PR's own range as the target. Nothing after it: the command takes
    every word after the level as the target. Not the PR number: for a PR stacked on another one the command then
    reviews against the default branch, the PR below it included."""
    return f"/code-review {req.get('level') or 'medium'} origin/{req['base']}...HEAD"


def claude_review(req, command):
    """The slash command; when the Claude setup doesn't have it, the same review as a plain prompt. Returns the answer
    {findings, scope?}. A command that answered in text only: that text through from_text. No answer at all is an
    error, not an empty review."""
    def ask(text, skills):
        meta = {}
        answer = llm.claude(FEATURE[req["kind"]], text, context=req.get("context"), model=req["model"],
                            schema=findings_schema(req["kind"]), budget=BUDGET[llm.tier(req["model"])], timeout=TIMEOUT, tools="Read,Grep,Glob,Agent,Bash",
                            cwd=req["worktree"], skills=skills, meta=meta,
                            extra=("--allowedTools", *READ_ONLY, "--disallowedTools", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch"))
        return answer, meta
    try:
        answer, meta = ask(command, True)
        if answer is None and missing_command(meta.get("result")):
            raise RuntimeError(meta.get("result"))
    except RuntimeError as e:
        if not missing_command(e):
            raise
        answer, meta = ask(PLAIN[req["kind"]].format(base=req["base"], number=req["number"]) + req.get("more", "") + ASK_JSON
                           + (ASK_SECURITY if req["kind"] == "security" else ""), False)
        meta["fallback"] = True
    if answer is None and (meta.get("text") or "").strip():
        answer = from_text(meta["text"], req, meta)
        meta["converted"] = True
    if not isinstance(answer, dict) or not isinstance(answer.get("findings"), list):
        raise RuntimeError(f"{FEATURE[req['kind']]}: the reviewer ran but gave no findings answer ({str(meta.get('result') or '')[:120]})")
    return answer, meta


def codex_review(req):
    started = time.monotonic()
    codex = shutil.which("codex")
    if not codex:
        raise RuntimeError("codex is not installed (optional): see Setup")
    pick = ["-c", f"model={json.dumps(req['codexModel'])}"] if req.get("codexModel") else []  # else Codex's own default
    r = subprocess.run([codex, "review", "--base", f"origin/{req['base']}",
                        "-c", 'sandbox_mode="read-only"', "-c", 'approval_policy="never"', *pick],
                       cwd=req["worktree"], capture_output=True, text=True, timeout=TIMEOUT)
    ms = int((time.monotonic() - started) * 1000)
    text = (r.stdout or "") + ("\n" + r.stderr if r.returncode != 0 else "")
    used = re.search(r"tokens used[:\s]*([\d,.]+)", text, re.I)
    tokens = int(re.sub(r"[^\d]", "", used[1])) if used else 0
    llm.log(FEATURE["codex"], (req.get("context") or {}).get("id") or "default", "codex", 0, tokens, ms, r.returncode == 0, tool="codex")  # Codex reports no price
    if r.returncode != 0:
        raise RuntimeError(f"codex review: {(r.stderr or r.stdout).strip()[-300:]}")
    meta = {"ms": ms, "tokens": tokens}
    return from_text(text, req, meta), meta


def main(arg):
    req = json.loads(arg)
    req["model"] = llm.code_model(req.get("model"))  # a reviewer judges code: never haiku (the prose pass stays haiku)
    wt = req["worktree"]
    git("fetch", "--quiet", "origin", req["base"], cwd=wt)  # the base for "what changed"
    started = time.monotonic()
    if req["kind"] == "claude":
        answer, meta = claude_review(req, code_review_command(req))
    elif req["kind"] == "security":
        pic, made = picture(req["file"])
        req = {**req, "more": picture_text(pic)}
        answer, meta = claude_review(req, f"/security-review\n\nReview the changes of this checkout against origin/{req['base']} "
                                          f"(git diff origin/{req['base']}...HEAD), which are PR #{req['number']}." + req["more"] + ASK_JSON + ASK_SECURITY)
    else:
        answer, meta = codex_review(req)
    findings = normalize(answer.get("findings"), req["kind"], wt)
    security = None
    if req["kind"] == "security":
        try:
            diff = related.diff_files(git("diff", "--no-color", "--no-ext-diff", "-U0", f"origin/{req['base']}...HEAD", cwd=wt))
            changed = {f["path"]: {n for n, _ in f["added"]} for f in diff}
        except (RuntimeError, OSError, subprocess.SubprocessError):
            changed = None
        security = {"head": req["head"], "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "picture": made, **security_view(answer, findings, pic, changed)}
    for f in findings:
        f.pop("ref", None)
    notes = [f"/{'code-review' if req['kind'] == 'claude' else 'security-review'} not available: ran as a plain prompt"] if meta.get("fallback") else []
    notes += ["The reviewer answered in text: a Haiku pass turned it into findings"] if meta.get("converted") else []
    run = {"state": "done", "cost": meta.get("cost"), "ms": int((time.monotonic() - started) * 1000), "model": meta.get("model_id"),
           "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "count": len(findings), "head": req["head"], "scope": scope(answer.get("scope"), req["kind"]),
           **({"note": ". ".join(notes)} if notes else {}), **({"auto": req["auto"]} if req.get("auto") else {})}
    merge(pathlib.Path(req["file"]), req["kind"], req["head"], findings, run, security)
    print(json.dumps(run))


if __name__ == "__main__":
    # The panel starts this detached and follows the file: runs[kind] says busy, done or the error.
    req = json.loads(sys.argv[1])
    auto = {"auto": req["auto"]} if req.get("auto") else {}  # why it started by itself (the panel's security trigger)
    merge(pathlib.Path(req["file"]), req["kind"], req["head"], None, {"state": "running", "busy": True, "started": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "pid": os.getpid(), "head": req["head"], **auto})
    try:
        main(sys.argv[1])
    except Exception as e:  # noqa: BLE001 - the panel shows the reason
        merge(pathlib.Path(req["file"]), req["kind"], req["head"], None, {"state": "failed", "error": str(e)[:400], "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "head": req["head"], **auto})
        print(str(e), file=sys.stderr)
        sys.exit(1)
