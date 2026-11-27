"""Run: python3 test_related.py  (no network)."""
import json

import related

# Overlap: shared files only, most shared first, PRs sharing nothing left out.
prs = [{"number": 1, "title": "a", "files": ["x.py", "y.py"]}, {"number": 2, "title": "b", "files": ["z.py"]},
       {"number": 3, "title": "c", "files": ["y.py", "x.py", "w.py"]}, {"number": 4, "title": "d", "files": ["y.py"]}]
out = related.overlap(["x.py", "y.py"], prs)
assert [(p["number"], p["overlap"], p["files"]) for p in out] == [(3, 2, ["x.py", "y.py"]), (1, 2, ["x.py", "y.py"]), (4, 1, ["y.py"])], out

# Merged PRs from git log: merge commits (title from the body), squashes (" (#n)" dropped), others skipped.
log = ("\x1eMerge pull request #12 from o/feat-x\x1ffeat: add x\n\nmore\x1d\n\nsrc/a.py\nsrc/b.py\n"
       "\x1efix: guard null (#15)\x1f\x1d\n\nsrc/a.py\n"
       "\x1echore: local commit\x1f\x1d\n\nsrc/a.py\n")
got = {p["number"]: p for p in related.merged_from_log(log)}
assert sorted(got) == [12, 15]
assert got[12]["title"] == "feat: add x" and got[12]["files"] == ["src/a.py", "src/b.py"]
assert got[15]["title"] == "fix: guard null" and got[15]["files"] == ["src/a.py"]

# A stacked PR: the base branch is another open PR's head branch (not a fork's branch of the same name).
others = [{"number": 1, "title": "base work", "url": "u1", "branch": "feat/a", "fork": False}, {"number": 7, "title": "fork", "url": "u7", "branch": "main", "fork": True}]
assert related.stacked_on("feat/a", others) == {"number": 1, "title": "base work", "url": "u1"}
assert related.stacked_on("main", others) is None and related.stacked_on(None, others) is None
# The other way round: a PR whose base is this PR's head branch builds on this one (PR #1 under PR #2).
others = [{"number": 2, "title": "events", "url": "u2", "branch": "feat/b", "base": "feat/a"}, {"number": 3, "title": "x", "url": "u3", "branch": "feat/c", "base": "main"}]
assert related.stacked_above("feat/a", others) == [{"number": 2, "title": "events", "url": "u2"}]
assert related.stacked_above(None, others) == [] and related.stacked_above("feat/z", others) == []

# The security reviewer starts by itself when the diff gives a reason, and says which; no model.
diff = lambda path, *added, removed=(): (f"diff --git a/{path} b/{path}\n--- a/{path}\n+++ b/{path}\n@@ -1,{len(removed)} +10,{len(added)} @@\n"  # noqa: E731
                                         + "".join(f"-{x}\n" for x in removed) + "".join(f"+{x}\n" for x in added))
# The demo's first PR: a front desk entry with a bearer token, and a new dependency.
pr1 = related.diff_files(diff("library/handler.py", "TOKEN = os.environ.get(\"FRONT_DESK_TOKEN\", \"\")", "def handler(event, context):",
                              "    auth = (event.get(\"headers\") or {}).get(\"authorization\", \"\")", "    if not hmac.compare_digest(auth[len(\"Bearer \"):], TOKEN):")
                         + diff("requirements.txt", "requests==2.32.3") + diff("library/status.py", "class Status(str, Enum):")
                         + diff("library/tests/test_status.py", "def test_token(): assert handler({}, None)"))
assert pr1[0] == {"path": "library/handler.py", "added": [(10, 'TOKEN = os.environ.get("FRONT_DESK_TOKEN", "")'), (11, "def handler(event, context):"),
                                                           (12, '    auth = (event.get("headers") or {}).get("authorization", "")'), (13, '    if not hmac.compare_digest(auth[len("Bearer "):], TOKEN):')], "removed": []}
t1 = related.security_trigger(pr1)
assert t1["run"] and t1["why_not"] is None
assert [(r["file"], r["rule"], r["line"]) for r in t1["reasons"]] == [("library/handler.py", "auth", 10), ("library/handler.py", "route", 11), ("requirements.txt", "dependencies", 0)], t1["reasons"]
assert t1["reasons"][0]["text"] == "library/handler.py touches auth or token code", "tests and plain code give no reason"
# The second PR: a template with a queue policy and an HTTP entry, and a new route in the handler.
pr2 = related.diff_files(diff("template.yaml", "  FrontDesk:", "      Policies:", "        - SQSSendMessagePolicy:", "      Events:", "        Api:", "          Type: HttpApi")
                         + diff("library/handler.py", "    if event.get(\"rawPath\") == \"/remind\":", "        consumer.handle(loan)") + diff("library/events.py", "class Queue:"))
t2 = related.security_trigger(pr2)
assert [(r["rule"], r["line"], r["text"]) for r in t2["reasons"]] == [("permissions", 11, "template.yaml changes IAM policies or permissions"),
    ("entry", 15, "template.yaml opens or changes a way in from outside"), ("route", 10, "library/handler.py adds or changes a route or handler")], t2["reasons"]
# Documentation only, plain code only, a removed check, a secret, and file names without a diff.
docs = related.security_trigger(related.diff_files(diff("README.md", "Set the token in FRONT_DESK_TOKEN.") + diff("docs/adr/0002-events.md", "## Decision")))
assert docs == {"run": False, "reasons": [], "why_not": "Only documentation changed."}
plain = related.security_trigger(related.diff_files(diff("library/dates.py", "def format_day(day):", "    return day.isoformat()")))
assert not plain["run"] and plain["why_not"].startswith("Nothing in the diff touches")
gone = related.security_trigger(related.diff_files(diff("api/views.py", "    return items", removed=["    check_permission(user)"])))
assert [(r["rule"], r["line"]) for r in gone["reasons"]] == [("auth", 0)], "a removed check counts"
leak = related.security_trigger(related.diff_files(diff("api/client.py", "API_KEY = \"sk_live_0123456789abcdef\"", "r = requests.get(url)")))
assert [r["rule"] for r in leak["reasons"]] == ["secrets", "auth", "access"] and "sk_live" not in json.dumps(leak), "the reason never repeats the value"
names = related.security_trigger([{"path": "infra/main.tf"}, {"path": "src/app.py"}])
assert [r["text"] for r in names["reasons"]] == ["infra/main.tf changes infrastructure"]
assert related.security_trigger([{"path": "src/app.py"}])["why_not"].startswith("The diff could not be read here")
print("ok")

# A CLI that is not installed is skipped, never run; a merge request's checks and mergeability come from its project.
assert related.have("git") and not related.have("definitely-not-a-command")
calls = []


def fake(cmd, cwd=None, timeout=120):
    calls.append(cmd)
    if "pipelines" in cmd[-1]:
        return json.dumps([{"id": 12, "status": "success", "web_url": "u"}, {"id": 13, "status": "running", "web_url": "v"}])
    return json.dumps({"has_conflicts": False, "detailed_merge_status": "mergeable"})
related.run = fake
checks, mergeable, state = related.glab_state({"repo": "g/sub/p", "number": 7})
assert [(c["name"], c["bucket"]) for c in checks] == [("Pipeline #12", "pass"), ("Pipeline #13", "pending")], checks
assert (mergeable, state) == ("MERGEABLE", "mergeable"), (mergeable, state)
assert calls[0][:3] == ["glab", "api", "projects/g%2Fsub%2Fp/merge_requests/7/pipelines?per_page=10"], calls[0]
print("merge request context ok")

# The base fetch: two runs on one clone fetch one at a time, and a ref another git process still held is retried.
# Real files in a temp dir; only the fetch itself is stubbed.
import os  # noqa: E402
import pathlib  # noqa: E402
import subprocess  # noqa: E402
import tempfile  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402
with tempfile.TemporaryDirectory() as d:
    g = lambda *a: subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t", *a], cwd=d, check=True, capture_output=True, text=True,  # noqa: E731
                                  env={**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"})
    g("init", "-q"), pathlib.Path(d, "f.txt").write_text("x\n"), g("add", "."), g("commit", "-qm", "c")
    head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=d, capture_output=True, text=True).stdout.strip()
    real = subprocess.run  # related's own git lookups, which run against the temp dir
    state = {"calls": 0, "live": 0, "most": 0, "fail": (), "delay": 0.15,
             "stderr": "error: cannot lock ref 'refs/remotes/origin/main': is at 9b81998 but expected 8f09225"}

    def fetch(args, cwd=None, timeout=120, **kw):
        if args[:3] != ["git", "fetch", "--quiet"]:
            return real(args, cwd=cwd, timeout=timeout, **kw)
        state["calls"] += 1
        state["live"] += 1
        state["most"] = max(state["most"], state["live"])
        try:
            time.sleep(state["delay"])
            return subprocess.CompletedProcess(args, 128, "", state["stderr"]) if state["calls"] in state["fail"] \
                else subprocess.CompletedProcess(args, 0, "", "")
        finally:
            state["live"] -= 1
    subprocess.run = fetch
    try:
        # Two runs at once: the second waits for the lock, so the fetches never overlap.
        done = []
        threads = [threading.Thread(target=lambda: done.append(related.fetch_base(d, "main"))) for _ in range(2)]
        [t.start() for t in threads], [t.join() for t in threads]
        assert done == [None, None] and state["most"] == 1 and state["calls"] == 2, (done, state, "the fetches interleaved")
        assert pathlib.Path(d, ".git", related.LOCK_NAME).exists(), "the lock lives in the clone's git directory"

        # The first fetch loses the ref to another git process: the retry gets it, and the run goes on without a note.
        state.update(calls=0, fail=(1,))
        assert related.fetch_base(d, "main") is None and state["calls"] == 2, (state, "a held ref is retried once")

        # Still failing, but origin/main resolves: the run goes on with the last fetch and a note to record.
        g("update-ref", "refs/remotes/origin/main", head)
        state.update(calls=0, fail=(1, 2))
        note = related.fetch_base(d, "main")
        assert note == "the base could not be refreshed; using the last fetch of origin/main" and state["calls"] == 2, (note, state)

        # Any other git error is not retried; the ref still resolves, so the run continues with the note.
        state.update(calls=0, fail=(1,), stderr="fatal: couldn't find remote ref main")
        assert related.fetch_base(d, "main").startswith("the base could not be refreshed") and state["calls"] == 1, state

        # No ref either: the run fails, as it did before there was a retry.
        g("update-ref", "-d", "refs/remotes/origin/main")
        state.update(calls=0, fail=(1, 2),
                     stderr="error: cannot lock ref 'refs/remotes/origin/main': is at 9b81998 but expected 8f09225")
        try:
            related.fetch_base(d, "main")
            raise AssertionError("a base that cannot be fetched and does not exist must fail the run")
        except RuntimeError as e:
            assert str(e).startswith("git fetch:") and "cannot lock ref" in str(e) and state["calls"] == 2, (str(e), state)
    finally:
        subprocess.run = real
print("base fetch ok")
