#!/usr/bin/env python3
"""GitLab merge requests for the panel, in the shape the GitHub path already produces.

  python3 mrs.py list <group/project>        open MRs as PR objects ({number, title, url, ...}, see to_pr)
  python3 mrs.py diff <merge request url>    the MR's unified diff, as `gh pr diff` gives it
  python3 mrs.py view <merge request url>    one MR as a PR object, with its head
  python3 mrs.py threads <merge request url> the line comments and their threads, as the review reads GitHub's

Every call goes through `glab`, which must be signed in (`glab auth login`). A failure prints the reason to stderr and
exits 1; the caller shows it as the list's or the diff's error.
"""
import json
import re
import subprocess
import sys
from urllib.parse import quote

GLAB = ["glab"]
URL = re.compile(r"^https://([\w.-]+)/(.+?)/-/merge_requests/(\d+)")


def run(args, cwd=None):
    r = subprocess.run(args, capture_output=True, text=True, cwd=cwd, timeout=120)
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
    else:
        raise SystemExit(f"unknown command: {what}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
