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
