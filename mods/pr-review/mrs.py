#!/usr/bin/env python3
"""GitLab merge requests for the panel, in the shape the GitHub path already produces.

  python3 mrs.py list <group/project>        open MRs as PR objects ({number, title, url, ...}, see to_pr)
  python3 mrs.py diff <merge request url>    the MR's unified diff, as `gh pr diff` gives it
  python3 mrs.py view <merge request url>    one MR as a PR object, with its head

Every call goes through `glab`, which must be signed in (`glab auth login`). A failure prints the reason to stderr and
exits 1; the caller shows it as the list's or the diff's error.
"""
import json
import re
import subprocess
import sys

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
    else:
        raise SystemExit(f"unknown command: {what}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
