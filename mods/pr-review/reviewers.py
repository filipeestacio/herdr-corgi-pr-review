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
# What a reviewer may do: the analysis' rules (review.permissions: the checkout, read-only git, no network, no writes,
# whatever no rule allows refused), plus Agent for the slash commands that split their work.
def permissions(worktree):
    return review.permissions(worktree, "Read", "Grep", "Glob", "Agent")
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
THREAT_RESULTS = ["finding", "mitigated", "not_assessed"]
OLD_RESULTS = {"checked_clean": "mitigated", "not_checked": "not_assessed"}  # a security view written before
CHECKS = ["none", "network", "token", "signature", "iam"]  # what a gate checks
PRINCIPAL_KINDS = ["internet", "operator", "ci", "role"]
CHANGES = ["added", "widened", "narrowed", "removed", "unchanged"]
STRIDE = ["S", "T", "R", "I", "D", "E"]
S = review.S
WHERE = {"type": "object", "properties": {"access": S, "from": S, "to": S}}
SECURITY = {
    "zones": {"type": "array", "maxItems": 8, "items": {"type": "object", "required": ["id", "name", "trust", "evidence", "nodes"], "properties": {
        "id": S, "name": S, "trust": {"enum": TRUST}, "evidence": S, "nodes": review.STRINGS}}},
    "access": {"type": "array", "maxItems": 16, "items": {"type": "object", "required": ["id", "resource", "kind", "principal", "principal_kind", "change", "actions", "public",
                                                                                         "auth", "auth_kind", "at"], "properties": {
        "id": S, "resource": S, "kind": S, "principal": S, "principal_kind": {"enum": PRINCIPAL_KINDS}, "change": {"enum": CHANGES}, "actions": review.STRINGS,
        "public": {"type": "boolean"}, "auth": S, "auth_kind": {"enum": AUTH_KINDS}, "used": {"type": "boolean"}, "at": S, "node": S}}},
    "gates": {"type": "array", "items": {"type": "object", "required": ["where", "principal", "check", "at", "source", "holds_if", "carries"], "properties": {
        "where": WHERE, "principal": S, "check": {"enum": CHECKS}, "at": S, "source": {"enum": ["config", "code"]}, "holds_if": S, "carries": review.STRINGS}}},
    "threats": {"type": "array", "items": {"type": "object", "required": ["where", "boundary", "threat", "stride", "findings", "result", "goal"], "properties": {
        "where": WHERE, "boundary": S, "threat": S, "stride": {"enum": STRIDE}, "findings": review.STRINGS, "result": {"enum": THREAT_RESULTS}, "goal": S,
        "evidence": S, "note": S}}}}
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
    "that the PR's code and infrastructure code add or change (IAM policies and roles, resource policies, routes and their "
    "authorizers, public flags), one row per grant or entry point, at most 16: id (acc1, acc2, … in order), resource (its "
    "name in the template), kind (e.g. queue, function, route, bucket, table), principal (who gets it: a function, a role, "
    "\"anyone on the internet\"), principal_kind (internet: anyone from outside; operator: a person running a script, the "
    "console or a manual deploy; ci: a CI or deploy pipeline; role: a role or function of the system), change (added, "
    "widened, narrowed, removed or unchanged: what this PR does to the grant or entry), actions (e.g. sqs:SendMessage, "
    "\"call GET /items\"), public (true when it is reachable without credentials of the cloud account), auth (what checks "
    "the caller, e.g. \"bearer token checked in handler.py\"), auth_kind (none: nothing checks the caller; code: a check in "
    "the application's code; gateway: an authorizer or key at the gateway; iam: the cloud's IAM), used (false when nothing "
    "in the code uses the grant), at (file:line), node (the id of its picture node, if any). Ways of operators and CI that "
    "the PR adds or changes (admin scripts, workflows, deploy jobs, guardrails they switch) are rows of their own; empty "
    "when the PR touches no such place. A crossing is an access row, or a call between two picture nodes in zones of "
    "different trust: once you have the zones, go through the picture's edges and take every edge whose two ends lie in "
    "zones of different trust; the PR adds or changes it when the edge or one of its ends is new or changed. gates: the check at each crossing the PR adds or changes, where it really happens: where (access: "
    "the id of an access row; or from and to: the two picture nodes), principal (the identity the request goes on with), "
    "check (none, network, token, signature, iam), at (file:line of the check), source (config: a gateway, authorizer or "
    "policy checks before the code runs; code: the receiving function's own code checks), holds_if (what must be true for "
    "the check to hold, e.g. \"FRONT_DESK_TOKEN is set and not empty\"; empty when nothing), carries (the parts of the "
    "request an attacker controls past this point, e.g. \"body.id\", \"Authorization header\"; never empty for a crossing "
    "from public). threats: a threat model of the crossings this PR adds or changes, at least one entry for each of them, "
    "one entry per concrete threat, no two alike: where (as for gates), boundary (the boundary crossed, e.g. \"Internet → "
    "Front desk function\"), threat (one sentence about this code: who does what, through which line), stride (one letter: "
    "S spoofing, T tampering, R repudiation, I information disclosure, D denial of service, E elevation of privilege), "
    "findings (the refs of your findings that show it), result (finding: a finding shows it; mitigated: the code holds "
    "against it, and evidence names the file:line that shows it; not_assessed: you did not check it), goal (what an "
    "attacker reaches in the end, one sentence), evidence (file:line, for mitigated), note (a few words).")
ASK_JSON = "\n\n" + ASK


def findings_schema(kind, worktree=None):
    """What a Claude reviewer answers with. The ask is also the schema's description: a slash command that runs as a
    fork takes no extra prompt text (it would read it as the review target), but it sees the schema; so the way to call
    git (review.git_hint) stands there too. The security reviewer also answers with its view (SECURITY)."""
    sec = kind == "security"
    extra = {"ref": S, "reachability": {"enum": REACH}} if sec else {}  # every Claude reviewer may name the way from outside (review.PATH)
    return {"type": "object", "description": review.git_hint(worktree) + ASK + (ASK_SECURITY if sec else ""), "required": ["findings", "scope", *(SECURITY if sec else [])], "properties": {
        "findings": {"type": "array", "items": {"type": "object", "required": ["file", "line", "title", "detail", *review.JUDGED, *(["ref"] if sec else [])],
                                               "properties": {**PLACE, **review.JUDGED, **review.PATH, **extra}}},
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
                    "code": code, **{k: f[k] for k in (*review.JUDGED, *review.PATH, "ref", "reachability") if f.get(k) not in (None, "", [])}})
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
    reachability (reach) and drops its ref. Returns:
    zones [{id, name, trust, evidence, nodes}]; access [{id: acc1.., …, principal_kind, change, opened_by_pr (only with
    a known diff)}]; crossing [{from, to, edge: e<k> in the picture's edges}] (the calls between zones of different
    trust); gates [{where, principal, check, at, source, holds_if, carries}]; threats [{id: t1.., where, boundary,
    threat, stride, findings: finding ids, result, goal, evidence, note, derived?}]; effective_zones [{node, drawn,
    effective, where}]. where is {access} or {from, to, edge}.
    Only what has its place stays: a zone's node must be on the picture; a gate sits at a crossing (an access row or a
    crossing call); a threat at a crossing this PR adds or changes (an access row whose change is not unchanged, or that
    sits in added lines; a call whose edge or one of its ends is new or changed). A threat with findings is a finding;
    mitigated needs its evidence, else not_assessed. Each such crossing without a threat gets one, derived and
    not_assessed, so an unchecked crossing is never silent. Derived, never asked: a card's effective zone, when the
    check at a crossing into it is none or in its own code (source code): then it stands in its caller's zone (an
    access row from public counts as public), and only the cards where that is more exposed than their drawn zone."""
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
        row = {**{k: v for k, v in r.items() if (k != "node" or v in ids) and (k != "principal_kind" or v in PRINCIPAL_KINDS) and (k != "change" or v in CHANGES)},
               "id": f"acc{len(rows) + 1}"}
        named.setdefault(str(r.get("id") or row["id"]), row["id"])
        if changed is not None:
            path, line = spot(row)
            row["opened_by_pr"] = line in changed.get(path, ())
        rows.append(row)
    reach(nodes, edges, pic.get("components") or [], rows, findings)
    refs = {f.pop("ref"): f["id"] for f in findings if f.get("ref")}
    status = {n.get("id"): n.get("status") for n in nodes}

    def place(w):  # a model's where as (where, the access row or None, new or changed by this PR), or None
        w = w if isinstance(w, dict) else {}
        row = next((r for r in rows if r["id"] == named.get(str(w.get("access")))), None)
        if row is not None:
            new = row.get("change") in CHANGES[:4] or (row.get("change") is None and row.get("opened_by_pr") is not False)
            return {"access": row["id"]}, row, new
        cross = next((c for c in crossing if (c["from"], c["to"]) == (w.get("from"), w.get("to"))), None)
        if cross:
            return dict(cross), None, bool({edges[int(cross["edge"][1:])].get("status"), status.get(cross["from"]), status.get(cross["to"])} & {"new", "changed"})
        return None
    gates = []
    for g in answer.get("gates") or []:
        at = place((g or {}).get("where"))
        if at and g.get("check") in CHECKS:
            gates.append({"where": at[0], "principal": str(g.get("principal") or ""), "check": g["check"], "at": str(g.get("at") or ""),
                          "source": g.get("source") if g.get("source") in ("config", "code") else "code", "holds_if": str(g.get("holds_if") or ""),
                          "carries": [str(x) for x in g.get("carries") or []]})
    threats = []
    for t in answer.get("threats") or []:
        at, text = place((t or {}).get("where")), str((t or {}).get("threat") or "").strip()
        if not at or not at[2] or not text:
            continue
        found = [refs[x] for x in dict.fromkeys(t.get("findings") or []) if x in refs]
        said = OLD_RESULTS.get(t.get("result"), t.get("result"))
        result = "finding" if found else "mitigated" if said == "mitigated" and str(t.get("evidence") or "").strip() else "not_assessed"
        threats.append({"id": f"t{len(threats) + 1}", "where": at[0], "boundary": str(t.get("boundary") or ""), "threat": text,
                        "stride": t.get("stride") if t.get("stride") in STRIDE else "", "findings": found, "result": result, "goal": str(t.get("goal") or ""),
                        "evidence": str(t.get("evidence") or ""), "note": str(t.get("note") or "")})
    name = lambda n: (zone_of.get(n) or {}).get("name") or n  # noqa: E731
    open_ = [({"access": r["id"]}, f"{r.get('principal') or 'caller'} → {r['resource']}") for r in rows if place({"access": r["id"]})[2]] + \
            [(dict(c), f"{name(c['from'])} → {name(c['to'])}") for c in crossing if place(c)[2]]
    # A call from a public card into a card with a public access row is that row's way in, not a second crossing.
    same = lambda w: [{"access": r["id"]} for r in rows if w.get("edge") and r.get("public") and r.get("node") == w["to"] and trust(w["from"]) == "public"]  # noqa: E731
    for where, boundary in open_:
        if not any(t["where"] in (where, *same(where)) for t in threats):
            threats.append({"id": f"t{len(threats) + 1}", "where": where, "boundary": boundary, "threat": "No threat was named for this crossing.", "stride": "",
                            "findings": [], "result": "not_assessed", "goal": "", "evidence": "", "note": "", "derived": True})
    effective = {}
    for g in gates:
        if g["check"] != "none" and g["source"] != "code":
            continue
        w = g["where"]
        row = next((r for r in rows if r["id"] == w.get("access")), None)
        node, caller = (row.get("node"), "public" if row.get("public") else None) if row else (w.get("to"), trust(w.get("from")))
        drawn = trust(node)
        if caller and drawn and TRUST.index(caller) < TRUST.index(drawn) and (node not in effective or TRUST.index(caller) < TRUST.index(effective[node]["effective"])):
            effective[node] = {"node": node, "drawn": drawn, "effective": caller, "where": w}
    return {"zones": zones, "access": rows, "crossing": crossing, "gates": gates, "threats": threats, "effective_zones": list(effective.values())}


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
                            schema=findings_schema(req["kind"], req["worktree"]), budget=BUDGET[llm.tier(req["model"])], timeout=TIMEOUT, tools="Read,Grep,Glob,Agent,Bash",
                            cwd=req["worktree"], skills=skills, meta=meta,
                            extra=permissions(req["worktree"]))
        return answer, meta
    try:
        answer, meta = ask(command, True)
        if answer is None and missing_command(meta.get("result")):
            raise RuntimeError(meta.get("result"))
    except RuntimeError as e:
        if not missing_command(e):
            raise
        answer, meta = ask(review.git_hint(req["worktree"]) + PLAIN[req["kind"]].format(base=req["base"], number=req["number"]) + req.get("more", "") + ASK_JSON
                           + (ASK_SECURITY if req["kind"] == "security" else ""), False)
        meta["fallback"] = True
    # Prose from a fork, else the main answer's own prose (a slash command that wrote its review instead of calling the
    # answer tool; a bare "Command completed" is no review).
    prose = (meta.get("text") or "").strip() or (str(meta.get("result") or "").strip() if len(str(meta.get("result") or "").strip()) > 80 else "")
    if answer is None and prose:
        answer = from_text(prose, req, meta)
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
                                          f"(git diff origin/{req['base']}...HEAD), which are PR #{req['number']}. " + review.git_hint(req["worktree"]) + req["more"] + ASK_JSON + ASK_SECURITY)
    else:
        answer, meta = codex_review(req)
    findings = normalize(answer.get("findings"), req["kind"], wt)
    try:  # the lines the PR adds: a finding in them is the PR's (introduced_here), an access row there opened by it
        diff = related.diff_files(git("diff", "--no-color", "--no-ext-diff", "-U0", f"origin/{req['base']}...HEAD", cwd=wt))
        changed = {f["path"]: {n for n, _ in f["added"]} for f in diff}
    except (RuntimeError, OSError, subprocess.SubprocessError):
        changed = None
    for f in findings:
        review.introduced(f, changed)
    security = None
    if req["kind"] == "security":
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
