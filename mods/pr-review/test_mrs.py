"""Run: python3 test_mrs.py  (a GitLab MR as the PR object the GitHub path makes; subprocess.run is stubbed)"""
import contextlib
import io
import json
import subprocess
import mrs
import pathlib

MR = {"iid": 4556, "title": "chore(deps): update", "state": "opened", "draft": False, "source_branch": "renovate/x",
      "target_branch": "main", "sha": "26a03336956ffd4964b829aaf729e05a8756e5c6",
      "web_url": "https://gitlab.com/gitlab-org/cli/-/merge_requests/4556", "updated_at": "2026-11-25T10:14:21.216Z",
      "author": {"username": "bot"}}

calls = []


def fake(stdout, code=0, stderr=""):
    def run(args, **kw):
        calls.append(args)
        return subprocess.CompletedProcess(args, code, stdout, stderr)
    return run


mrs.subprocess.run = fake(json.dumps([MR]))
pr = mrs.list_open("gitlab-org/cli")[0]
assert pr == {"number": 4556, "title": "chore(deps): update", "url": "https://gitlab.com/gitlab-org/cli/-/merge_requests/4556",
              "state": "open", "isDraft": False, "headRefName": "renovate/x", "headRefOid": "26a03336956ffd4964b829aaf729e05a8756e5c6",
              "baseRefName": "main", "updatedAt": "2026-11-25T10:14:21.216Z", "reviewDecision": None, "additions": None,
              "deletions": None, "author": {"login": "bot"}}, pr
assert calls[-1][:4] == ["glab", "mr", "list", "--repo"] and calls[-1][4] == "gitlab-org/cli", calls[-1]

assert mrs.STATE == {"opened": "open", "locked": "closed", "closed": "closed", "merged": "merged"}
assert mrs.to_pr({**MR, "state": "merged", "draft": True})["state"] == "merged"
assert mrs.to_pr({**MR, "draft": True})["isDraft"] is True

assert mrs.parse("https://gitlab.com/g/sub/p/-/merge_requests/7/diffs") == {"hostname": "gitlab.com", "repo": "g/sub/p", "iid": 7}
assert mrs.parse("https://github.com/o/r/pull/7") is None

mrs.subprocess.run = fake(json.dumps(MR))
assert mrs.view("https://gitlab.com/g/sub/p/-/merge_requests/7")["number"] == 4556
assert calls[-1][:5] == ["glab", "mr", "view", "7", "--repo"] and calls[-1][5] == "g/sub/p", calls[-1]

mrs.subprocess.run = fake("diff --git a/a.py b/a.py\n")
assert mrs.diff("https://gitlab.com/g/sub/p/-/merge_requests/7").startswith("diff --git")
assert calls[-1][:5] == ["glab", "mr", "diff", "7", "--repo"], calls[-1]

mrs.subprocess.run = fake("", 1, "glab: not signed in\nfor host gitlab.com")
try:
    mrs.list_open("g/p")
    raise AssertionError("a failed glab call must stop the script")
except SystemExit as e:
    assert "not signed in" in str(e), e
print("ok")


# A file at the head, and a project's visibility.
mrs.subprocess.run = fake(json.dumps(MR))
assert mrs.view("https://gitlab.com/g/sub/p/-/merge_requests/7")["headRefOid"].startswith("26a0")
def routed(args, **kw):
    calls.append(args)
    if "view" in args:
        return subprocess.CompletedProcess(args, 0, json.dumps(MR), "")
    return subprocess.CompletedProcess(args, 0, "print(1)\n", "")
mrs.subprocess.run = routed
assert mrs.file_at("https://gitlab.com/g/sub/p/-/merge_requests/7", "src/a b.py") == "print(1)\n"
assert calls[-1][:3] == ["glab", "api", "projects/g%2Fsub%2Fp/repository/files/src%2Fa%20b.py/raw?ref=26a03336956ffd4964b829aaf729e05a8756e5c6"], calls[-1]
mrs.subprocess.run = fake(json.dumps({"visibility": "private"}))
assert mrs.visibility("g/sub/p") == "private"
assert calls[-1][2] == "projects/g%2Fsub%2Fp", calls[-1]
assert mrs.glab("gitlab.com") == ["glab"] and mrs.glab("gitlab.example.com") == ["glab", "--hostname", "gitlab.example.com"]
print("file and visibility ok")


# The discussions page: a line comment, its reply, a system note and a general note (left out), one thread.
NOTE = {"id": 5, "body": "why?", "system": False, "author": {"username": "ann"}, "created_at": "2026-01-01T00:00:00Z",
        "position": {"new_path": "a.py", "old_path": "a.py", "new_line": 3, "old_line": None, "head_sha": "h", "base_sha": "b"},
        "resolved": False}
SYSTEM = {"id": 6, "body": "added 1 commit", "system": True, "author": {"username": "ann"}}
GENERAL = {"id": 8, "body": "nice work", "system": False, "author": {"username": "bob"}}
TALK = [{"id": 1, "notes": [NOTE, {**NOTE, "id": 7, "body": "fixed"}]}, {"id": 2, "notes": [SYSTEM]}, {"id": 3, "notes": [GENERAL]}]
mrs.subprocess.run = fake(json.dumps(TALK))
got = mrs.threads("https://gitlab.com/g/p/-/merge_requests/1")
assert [c["id"] for c in got["comments"]] == [5, 7], got["comments"]
assert got["comments"][1]["in_reply_to_id"] == 5 and got["comments"][0]["in_reply_to_id"] is None
assert (got["comments"][0]["side"], got["comments"][0]["path"], got["comments"][0]["line"]) == ("RIGHT", "a.py", 3)
assert got["threads"] == [{"id": 5, "resolved": False, "outdated": False}], got["threads"]
assert calls[-1][:3] == ["glab", "api", "--paginate"], calls[-1]
assert "merge_requests/1/discussions" in calls[-1][3], calls[-1]
assert mrs.is_bot({"username": "renovate-bot"}) and not mrs.is_bot({"username": "ann"})

# --paginate prints one array per page, one after the other: both pages are read.
assert mrs.pages('[{"a": 1}]\n[{"a": 2}]') == [{"a": 1}, {"a": 2}]
print("threads ok")

# A review posted as discussions: the position names the changed line, an old-side comment its old line, the summary
# note carries the verdict, and the approval follows.
def post_fake(args, **kw):
    calls.append((args, kw.get("input")))
    path = next((a for a in args if str(a).startswith("projects/")), "")
    if path.endswith("/approve"):
        return subprocess.CompletedProcess(args, 0, json.dumps({}), "")
    if "discussions" in path:
        return subprocess.CompletedProcess(args, 0, json.dumps({"notes": [{"id": 91}]}), "")
    if path.endswith("/notes"):
        return subprocess.CompletedProcess(args, 0, json.dumps({"id": 92}), "")
    return subprocess.CompletedProcess(args, 0, json.dumps({"diff_refs": {"base_sha": "b", "start_sha": "s", "head_sha": "h"}}), "")
calls.clear()
mrs.subprocess.run = post_fake
out = mrs.post("https://gitlab.com/g/sub/p/-/merge_requests/7", {"event": "APPROVE", "body": "Looks right.",
    "comments": [{"path": "a.py", "line": 3, "side": "RIGHT", "body": "why?"},
                 {"path": "a.py", "line": 2, "side": "LEFT", "body": "old side"},
                 {"path": "b.py", "line": 9, "start_line": 4, "side": "RIGHT", "body": "range"}]})
assert out["notes"][0]["id"] == 91 and out["summary"] == 92 and out["approved"] is True, out
path_of = lambda a: next((x for x in a if str(x).startswith("projects/")), "")
posted = [(path_of(a), json.loads(s)) for a, s in calls if path_of(a).endswith("/discussions")]
assert len(posted) == 3, posted
assert posted[0][1]["position"] == {"position_type": "text", "base_sha": "b", "start_sha": "s", "head_sha": "h", "new_path": "a.py", "new_line": 3}, posted[0][1]
assert posted[1][1]["position"].get("old_path") == "a.py" and posted[1][1]["position"].get("old_line") == 2, posted[1][1]
assert posted[2][1]["body"].startswith("Lines 4–9:"), posted[2][1]
summary = [json.loads(s) for a, s in calls if path_of(a).endswith("/notes")][0]
assert summary["body"].startswith("**Approved.**") and "Looks right." in summary["body"], summary
assert any(path_of(a).endswith("/approve") for a, _ in calls), calls
print("post ok")

# A space's branches: only the open merge requests of those source branches.
mrs.subprocess.run = fake(json.dumps([{**MR, "iid": 1, "source_branch": "feat/a"}, {**MR, "iid": 2, "source_branch": "feat/b"}, {**MR, "iid": 3, "source_branch": "main"}]))
got = mrs.branches("g/p", ["feat/a", "feat/b", ""])
assert [p["number"] for p in got] == [1, 2], got
assert calls[-1][:4] == ["glab", "mr", "list", "--repo"], calls[-1]
print("branches ok")

# The person's own merge requests: assigned first, then created, an MR in both once, each with its project path.
ASSIGNED = {**MR, "iid": 7, "web_url": "https://gitlab.com/g/sub/p/-/merge_requests/7"}
BOTH = {**MR, "iid": 8, "web_url": "https://gitlab.com/g/nested/team/-/merge_requests/8"}
CREATED = {**MR, "iid": 9, "web_url": "https://gitlab.com/g/other/-/merge_requests/9"}
NOWEB = {k: v for k, v in MR.items() if k != "web_url"} | {"iid": 10}
FOREIGN = {**MR, "iid": 11, "web_url": "https://github.com/o/r/pull/12"}
def scoped(args, **kw):
    calls.append(args)
    if "scope=assigned_to_me" in args[-1]:
        return subprocess.CompletedProcess(args, 0, json.dumps([ASSIGNED]) + "\n" + json.dumps([NOWEB, BOTH]), "")
    return subprocess.CompletedProcess(args, 0, json.dumps([BOTH, FOREIGN, CREATED]), "")
calls.clear()
mrs.subprocess.run = scoped
got = mrs.mine()
assert [p["number"] for p in got] == [7, 8, 9], got
assert [p["repo"] for p in got] == ["g/sub/p", "g/nested/team", "g/other"], got
assert 10 not in [p["number"] for p in got] and 11 not in [p["number"] for p in got], got
assert got[0] == {**mrs.to_pr(ASSIGNED), "repo": "g/sub/p"}, got[0]
needed = {"number", "url", "state", "isDraft", "headRefName", "headRefOid", "baseRefName", "updatedAt", "author"}
assert needed <= set(got[1]), sorted(got[1])
assert calls == [["glab", "api", "--paginate", "merge_requests?scope=assigned_to_me&state=opened&per_page=100"],
                 ["glab", "api", "--paginate", "merge_requests?scope=created_by_me&state=opened&per_page=100"]], calls
out = io.StringIO()
with contextlib.redirect_stdout(out):
    assert mrs.main(["mrs.py", "mine"]) == 0
assert [p["number"] for p in json.loads(out.getvalue())] == [7, 8, 9], out.getvalue()
print("mine ok")

# One scope failing keeps the other's list; both failing stops the script with the reason.
def half(args, **kw):
    if "scope=created_by_me" in args[-1]:
        return subprocess.CompletedProcess(args, 1, "", "glab: 403 Forbidden\n")
    return subprocess.CompletedProcess(args, 0, json.dumps([ASSIGNED]), "")
mrs.subprocess.run = half
assert [p["number"] for p in mrs.mine()] == [7]

def other_half(args, **kw):
    if "scope=assigned_to_me" in args[-1]:
        return subprocess.CompletedProcess(args, 1, "", "glab: 403 Forbidden\n")
    return subprocess.CompletedProcess(args, 0, json.dumps([CREATED]), "")
mrs.subprocess.run = other_half
assert [p["number"] for p in mrs.mine()] == [9]

mrs.subprocess.run = fake("", 1, "glab: not signed in\nfor host gitlab.com")
try:
    mrs.mine()
    raise AssertionError("two failed glab calls must stop the script")
except SystemExit as e:
    assert "not signed in" in str(e), e
print("mine failures ok")
