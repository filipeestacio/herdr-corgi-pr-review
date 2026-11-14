#!/usr/bin/env python3
"""Automated reviewers for the review layout: Claude's /code-review, Claude's /security-review, `codex review`.

argv[1]: JSON {kind: "claude"|"security"|"codex", url, number, context ({id, env}: the PR's), model (a Claude
model or alias from models.py), codexModel (a Codex slug from models.py; none: Codex's default), worktree (a detached checkout of the PR head, worktree.py), base (the PR's base branch),
head (sha), level (code-review effort: low|medium|high), file (pr-data/findings/<url hash>.json)}.
Runs the reviewer read-only in the worktree (Claude: Read/Grep/Glob/Agent and read-only git/gh Bash only, no edits;
Codex: sandbox_mode=read-only), turns its answer into findings {id, reviewer, file, line, end, severity, title,
detail, suggestion, code, and when the reviewer gave them: category, impact, effect, preconditions, certainty (see
review.py: the severity follows from the impact by the fixed scale)} and merges them into `file` under that reviewer
(other reviewers' findings and every status stay). A review that comes back as text (Codex's, or a slash command that
answered in prose) goes through a cheap Haiku pass in the PR's context. Every call goes to the optional
ledger (llm.py). The slash-command reviewers need those commands in the Claude setup: when one is missing, the same
review runs as a plain prompt. Codex is optional (`codex` on PATH).
runs[kind] in `file` says how the run went: {state: "running", busy, started, pid}, then {state: "done", count, cost, ms,
model, at, head, scope, note?} or {state: "failed", error, at}; no entry: never run. scope is the reviewer's own report
{read: [files], checked: [{area, result: finding|clean|not_checked, note}], skipped: [what it left out]}, or None when
it gave none. A run without an answer fails; it is never "0 findings". Prints the run; exit 1 with the reason on stderr.
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
ASK_JSON = "\n\n" + ASK


def findings_schema(kind):
    """What a Claude reviewer answers with. The ask is also the schema's description: a slash command that runs as a
    fork takes no extra prompt text (it would read it as the review target), but it sees the schema."""
    return {"type": "object", "description": ASK, "required": ["findings", "scope"], "properties": {
        "findings": {"type": "array", "items": {"type": "object", "required": ["file", "line", "title", "detail", *review.JUDGED],
                                               "properties": {**PLACE, **review.JUDGED}}},
        "scope": {"type": "object", "required": ["read", "checked", "skipped"], "properties": {
            "read": review.STRINGS, "checked": review.checked_schema(AREAS[kind]), "skipped": review.STRINGS}}}}


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
                    "code": code, **{k: f[k] for k in review.JUDGED if f.get(k)}})
    return out


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


def merge(file, reviewer, head, findings, run):
    """Replace this reviewer's findings (None: keep them, only the run changes) in the PR's file, under a lock;
    statuses (set by the panel) stay. ponytail: the panel writes statuses without this lock (compare-and-swap on the
    whole file), so a status set in the very moment a reviewer finishes can be lost."""
    file.parent.mkdir(parents=True, exist_ok=True)
    with open(file.with_suffix(".lock"), "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        doc = json.loads(file.read_text()) if file.exists() else {}
        if findings is not None:
            doc["findings"] = [f for f in doc.get("findings", []) if f["reviewer"] != reviewer] + [{**f, "head": head} for f in findings]
        doc.setdefault("runs", {})[reviewer] = run
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
        answer, meta = ask(PLAIN[req["kind"]].format(base=req["base"], number=req["number"]) + ASK_JSON, False)
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
    wt = req["worktree"]
    git("fetch", "--quiet", "origin", req["base"], cwd=wt)  # the base for "what changed"
    started = time.monotonic()
    if req["kind"] == "claude":
        answer, meta = claude_review(req, code_review_command(req))
    elif req["kind"] == "security":
        answer, meta = claude_review(req, f"/security-review\n\nReview the changes of this checkout against origin/{req['base']} "
                                          f"(git diff origin/{req['base']}...HEAD), which are PR #{req['number']}." + ASK_JSON)
    else:
        answer, meta = codex_review(req)
    findings = normalize(answer.get("findings"), req["kind"], wt)
    notes = [f"/{'code-review' if req['kind'] == 'claude' else 'security-review'} not available: ran as a plain prompt"] if meta.get("fallback") else []
    notes += ["The reviewer answered in text: a Haiku pass turned it into findings"] if meta.get("converted") else []
    run = {"state": "done", "cost": meta.get("cost"), "ms": int((time.monotonic() - started) * 1000), "model": meta.get("model_id"),
           "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "count": len(findings), "head": req["head"], "scope": scope(answer.get("scope"), req["kind"]),
           **({"note": ". ".join(notes)} if notes else {})}
    merge(pathlib.Path(req["file"]), req["kind"], req["head"], findings, run)
    print(json.dumps(run))


if __name__ == "__main__":
    # The panel starts this detached and follows the file: runs[kind] says busy, done or the error.
    req = json.loads(sys.argv[1])
    merge(pathlib.Path(req["file"]), req["kind"], req["head"], None, {"state": "running", "busy": True, "started": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "pid": os.getpid()})
    try:
        main(sys.argv[1])
    except Exception as e:  # noqa: BLE001 - the panel shows the reason
        merge(pathlib.Path(req["file"]), req["kind"], req["head"], None, {"state": "failed", "error": str(e)[:400], "at": time.strftime("%Y-%m-%dT%H:%M:%S%z")})
        print(str(e), file=sys.stderr)
        sys.exit(1)
