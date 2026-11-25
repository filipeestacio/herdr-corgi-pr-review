#!/usr/bin/env python3
"""GitLab merge requests for the panel, in the shape the GitHub path already produces.

  python3 mrs.py list <group/project>        open MRs as PR objects ({number, title, url, ...}, see to_pr)
  python3 mrs.py diff <merge request url>    the MR's unified diff, as `gh pr diff` gives it
  python3 mrs.py view <merge request url>    one MR as a PR object, with its head
  python3 mrs.py threads <merge request url> the line comments and their threads, as the review reads GitHub's
  python3 mrs.py file <merge request url> <path>   that file at the MR's head commit
  python3 mrs.py visibility <group/project>  the project's visibility (public, internal, private)
  python3 mrs.py post <merge request url> <payload.json>   one discussion per comment, then the summary note
  python3 mrs.py branches <group/project> <branch> ...   open MRs of these source branches

Every call goes through `glab`, which must be signed in (`glab auth login`). A failure prints the reason to stderr and
exits 1; the caller shows it as the list's or the diff's error.
"""
import json
import pathlib
import re
import subprocess
import sys
from urllib.parse import quote

GLAB = ["glab"]
URL = re.compile(r"^https://([\w.-]+)/(.+?)/-/merge_requests/(\d+)")


def run(args, cwd=None, stdin=None):
    r = subprocess.run(args, capture_output=True, text=True, cwd=cwd, timeout=120, input=stdin)
    if r.returncode != 0:
        why = (r.stderr or r.stdout or "").strip().splitlines()
        raise SystemExit(f"{' '.join(args[:3])}: {why[0] if why else f'exit {r.returncode}'}")
    return r.stdout


def parse(url):
    """{hostname, repo, iid} for a merge request link; None when the link is not one."""
    m = URL.match(str(url or "").strip())
    return {"hostname": m.group(1), "repo": m.group(2), "iid": int(m.group(3))} if m else None


STATE = {"opened": "open", "locked": "closed", "closed": "closed", "merged": "merged"}


def to_pr(m):
    """A GitLab MR as the PR object the panel's GitHub path makes (ghTarget in pr.js reads these names)."""
    return {
        "number": m.get("iid"),
        "title": m.get("title"),
        "url": m.get("web_url"),
        "state": STATE.get(str(m.get("state", "")).lower(), str(m.get("state", ""))),
        "isDraft": bool(m.get("draft")),
        "headRefName": m.get("source_branch"),
        "headRefOid": m.get("sha"),
        "baseRefName": m.get("target_branch"),
        "updatedAt": m.get("updated_at"),
        "reviewDecision": None,
        "additions": None,
        "deletions": None,
        "author": {"login": (m.get("author") or {}).get("username")},
    }


def pages(text):
    """`glab api --paginate` prints one JSON array per page, one after the other."""
    out, i, dec = [], 0, json.JSONDecoder()
    while i < len(text):
        while i < len(text) and text[i].isspace():
            i += 1
        if i >= len(text):
            break
        value, i = dec.raw_decode(text, i)
        out.extend(value if isinstance(value, list) else [value])
    return out


def is_bot(author):
    return str((author or {}).get("username", "")).endswith("-bot")


def threads(url):
    """The MR's line comments in GitHub REST's shape, and a thread per discussion (resolved, outdated), so the review's
    threads.js reads them unchanged. A note without a position is a general comment, not a line one: it is left out,
    as the GitHub path also reads only that pull request's review comments."""
    ref = parse(url)
    if not ref:
        raise SystemExit(f"not a merge request link: {url}")
    path = f"projects/{quote(ref['repo'], safe='')}/merge_requests/{ref['iid']}/discussions"
    talks, comments, states = pages(run(GLAB + ["api", "--paginate", f"{path}?per_page=100"])), [], []
    for d in talks:
        notes = [n for n in d.get("notes", []) if not n.get("system")]
        placed = [n for n in notes if n.get("position")]
        if not placed:
            continue
        root = notes[0]["id"]
        for n in placed:
            pos = n["position"]
            new, old = pos.get("new_line"), pos.get("old_line")
            comments.append({
                "id": n["id"], "path": pos.get("new_path") or pos.get("old_path"),
                "line": new, "original_line": old, "side": "RIGHT" if new else "LEFT",
                "user": (n.get("author") or {}).get("username"), "user_type": "Bot" if is_bot(n.get("author")) else "User",
                "commit_id": pos.get("head_sha"), "original_commit_id": pos.get("base_sha"),
                "outdated": new is None and old is None, "body": n.get("body") or "",
                "at": n.get("created_at"), "in_reply_to_id": None if n["id"] == root else root,
            })
        first = placed[0]
        states.append({"id": root, "resolved": bool(first.get("resolved")), "outdated": bool(placed[0].get("position", {}).get("new_line") is None)})
    return {"comments": comments, "threads": states}


def glab(hostname):
    """glab for that host: it defaults to gitlab.com."""
    return GLAB if not hostname or hostname == "gitlab.com" else GLAB + ["--hostname", hostname]


def file_at(url, path):
    """A file of the MR's head commit, as its text."""
    ref = parse(url)
    if not ref:
        raise SystemExit(f"not a merge request link: {url}")
    head = view(url)["headRefOid"]
    project = quote(ref["repo"], safe="")
    return run(glab(ref["hostname"]) + ["api", f"projects/{project}/repository/files/{quote(path, safe='')}/raw?ref={head}"])


def visibility(repo):
    """A project's visibility, as `gh repo view --json visibility` gives it for GitHub."""
    got = json.loads(run(GLAB + ["api", f"projects/{quote(repo, safe='')}"]))
    return str(got.get("visibility") or "").strip() or "unknown"


def branches(repo, names):
    """A project's open merge requests whose source branch is one of these, as PR objects (a space's branches)."""
    want = {n for n in names if n}
    got = json.loads(run(GLAB + ["mr", "list", "--repo", repo, "--per-page", "100", "--output", "json"]) or "[]")
    return [to_pr(m) for m in got if m.get("source_branch") in want]


def post(url, payload):
    """A review as GitLab takes it: one discussion per line comment, then one note for the summary (and the verdict
    as a word at its head), then an approval when the verdict asks for one. Returns the notes' ids, matched by path,
    line and body, so the review can show what it sent as threads."""
    ref = parse(url)
    if not ref:
        raise SystemExit(f"not a merge request link: {url}")
    gl, project = glab(ref["hostname"]), quote(ref["repo"], safe="")
    mr_path = f"projects/{project}/merge_requests/{ref['iid']}"

    def api(path, method="GET", body=None):
        args = gl + ["api", *(["-X", method] if method != "GET" else []), path]
        if body is not None:
            args += ["-H", "Content-Type: application/json", "--input", "-"]
        return json.loads(run(args, stdin=json.dumps(body) if body is not None else None) or "{}")

    refs = api(mr_path).get("diff_refs") or {}
    at = {k: refs.get(k) for k in ("base_sha", "start_sha", "head_sha")}
    notes = []
    for c in payload.get("comments") or []:
        old = c.get("side") == "LEFT"
        text = c.get("body") or ""
        start = c.get("start_line")
        if start and start != c.get("line"):
            text = f"Lines {start}–{c['line']}:\n\n{text}"  # a GitLab position names one line: the range is said in the body
        pos = {"position_type": "text", **at, ("old_path" if old else "new_path"): c.get("path"),
               ("old_line" if old else "new_line"): c.get("line")}
        got = api(f"{mr_path}/discussions", "POST", {"body": text, "position": pos})
        note = (got.get("notes") or [{}])[0]
        notes.append({"id": note.get("id"), "path": c.get("path"), "line": c.get("line"), "body": c.get("body")})
    event = str(payload.get("event") or "COMMENT").upper()
    head = {"APPROVE": "**Approved.**", "REQUEST_CHANGES": "**Requested changes.**"}.get(event)
    summary = "\n\n".join(x for x in (head, (payload.get("body") or "").strip()) if x)
    summary_id = api(f"{mr_path}/notes", "POST", {"body": summary}).get("id") if summary else None
    approved = False
    if event == "APPROVE":
        try:
            api(f"{mr_path}/approve", "POST")
            approved = True
        except SystemExit:  # an approval the project does not take (or a self-approval) is not a lost review
            approved = False
    return {"url": url, "notes": notes, "summary": summary_id, "approved": approved}


def list_open(repo):
    return [to_pr(m) for m in json.loads(run(GLAB + ["mr", "list", "--repo", repo, "--per-page", "50", "--output", "json"]))]


def view(url):
    ref = parse(url)
    if not ref:
        raise SystemExit(f"not a merge request link: {url}")
    return to_pr(json.loads(run(GLAB + ["mr", "view", str(ref["iid"]), "--repo", ref["repo"], "--output", "json"])))


def diff(url):
    ref = parse(url)
    if not ref:
        raise SystemExit(f"not a merge request link: {url}")
    return run(GLAB + ["mr", "diff", str(ref["iid"]), "--repo", ref["repo"]])


def main(argv):
    if len(argv) < 3:
        raise SystemExit(__doc__.strip().splitlines()[0])
    what, target = argv[1], argv[2]
    if what == "list":
        print(json.dumps(list_open(target)))
    elif what == "view":
        print(json.dumps(view(target)))
    elif what == "diff":
        sys.stdout.write(diff(target))
    elif what == "threads":
        print(json.dumps(threads(target)))
    elif what == "file":
        if len(argv) < 4:
            raise SystemExit("file needs a merge request link and a path")
        sys.stdout.write(file_at(target, argv[3]))
    elif what == "visibility":
        print(visibility(target))
    elif what == "branches":
        print(json.dumps(branches(target, argv[3:])))
    elif what == "post":
        if len(argv) < 4:
            raise SystemExit("post needs a merge request link and a payload file")
        print(json.dumps(post(target, json.loads(pathlib.Path(argv[3]).read_text()))))
    else:
        raise SystemExit(f"unknown command: {what}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
