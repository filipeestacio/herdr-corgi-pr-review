"""Run: python3 test_mrs.py  (a GitLab MR as the PR object the GitHub path makes; subprocess.run is stubbed)"""
import json
import subprocess
import mrs

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
