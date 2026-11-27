"""Run: python3 test_cleanup.py  (every host call and every git call stubbed; no network, no git, temp folders)."""
import json
import pathlib
import tempfile
import time

import cleanup

TMP = tempfile.TemporaryDirectory()
BASE = pathlib.Path(TMP.name).resolve()
APP = BASE / "app"
ROOTS = BASE / "code"
WORKTREES = BASE / "wt"
NOW = 1800000000
DAY = 86400

cleanup.APP = APP
cleanup.REGISTRY = APP / "pr-data" / "clones.json"
cleanup.ROOTS = [ROOTS]
cleanup.WORKTREES = WORKTREES


def write_registry(value):
    cleanup.REGISTRY.parent.mkdir(parents=True, exist_ok=True)
    cleanup.REGISTRY.write_text(value if isinstance(value, str) else json.dumps(value))


def stub(remote="https://github.com/acme/api.git", status="", host=(0, "[]", "")):
    def call(argv, timeout=60):
        if argv[0] == "git" and "status" in argv:
            value = status(pathlib.Path(argv[2]).name) if callable(status) else status
            return (0, value, "") if value is not None else (1, "", "fatal: not a git repository")
        if argv[0] == "git" and "remote" in argv:
            return (0, remote, "") if remote is not None else (1, "", "no origin")
        if argv[0] in ("gh", "glab"):
            return host
        raise AssertionError(f"unexpected command: {argv}")
    return call


def folder(name):
    path = ROOTS / name
    path.mkdir(parents=True)
    return path


def entry(path, used=NOW - 40 * DAY, at=NOW - 90 * DAY):
    return {"path": str(path), "at": at, "used": used}


def candidates(reg, **kw):
    return cleanup.report(recorded=reg, now=NOW, **kw)["candidates"]


def only_one(reg, **kw):
    found = candidates(reg, **kw)
    assert len(found) == 1, found
    return found[0]


# A clone the registry does not know: never a candidate, never removed.
cleanup.call = stub()
stranger = folder("stranger")
assert candidates({}) == []
assert cleanup.apply(recorded={}, now=NOW) == {"removed": [], "kept": []}
assert stranger.exists()
print("unrecorded clone ok")

# A recorded folder that is gone: reported, not removed, and dropped from the registry.
write_registry({"acme/api": entry(ROOTS / "gone")})
item = only_one({"acme/api": entry(ROOTS / "gone")})
assert item["eligible"] is False and item["size"] == 0 and "gone" in item["why"], item
out = cleanup.apply(recorded={"acme/api": entry(ROOTS / "gone")}, now=NOW)
assert out["removed"] == [] and out["kept"] == [{"repo": "acme/api", "path": str(ROOTS / "gone"), "why": item["why"]}], out
assert json.loads(cleanup.REGISTRY.read_text()) == {}, cleanup.REGISTRY.read_text()
print("missing folder ok")

# A link where the registry says a clone is: never followed, never removed.
target = BASE / "elsewhere"
target.mkdir()
link = ROOTS / "link"
link.symlink_to(target)
item = only_one({"acme/api": entry(link)})
assert item["eligible"] is False and "link" in item["why"], item
assert cleanup.apply(recorded={"acme/api": entry(link)}, now=NOW)["removed"] == []
assert link.is_symlink() and target.exists()
print("symlink ok")

# A registry path that is not absolute: refused, because it would mean whatever the caller's folder holds.
item = only_one({"acme/api": {"path": "code/api", "at": NOW - 90 * DAY, "used": NOW - 40 * DAY}})
assert item["eligible"] is False and "not absolute" in item["why"], item
print("relative path ok")

# Used too recently: kept, and the sentence names both ages.
recent = folder("recent")
item = only_one({"acme/api": entry(recent, used=NOW - 5 * DAY)})
assert item["eligible"] is False and item["days"] == 5.0 and "5 days" in item["why"] and "30" in item["why"], item
print("recent ok")

# A clone with local changes: never removed, whatever else holds.
dirty = folder("dirty")
cleanup.call = stub(status=" M a.py\n")
item = only_one({"acme/api": entry(dirty)})
assert item["eligible"] is False and "uncommitted" in item["why"], item
assert cleanup.apply(recorded={"acme/api": entry(dirty)}, now=NOW)["removed"] == [] and dirty.exists()
print("dirty ok")

# A review checkout still there: kept. One per PR (pr-review-<number>) keeps the clone as the shared one did.
left = folder("left")
cleanup.call = stub()
(WORKTREES / "left" / "pr-review-7").mkdir(parents=True)
item = only_one({"acme/api": entry(left)})
assert item["eligible"] is False and "review checkout" in item["why"] and "pr-review-7" in item["why"], item
(WORKTREES / "left" / "pr-review-7").rmdir()
(WORKTREES / "left" / "pr-review").mkdir(parents=True)
item = only_one({"acme/api": entry(left)})
assert item["eligible"] is False and "review checkout" in item["why"], item
print("review worktree ok")

# An earlier version's review checkout inside the clone: kept too.
older = folder("older")
(older / ".worktrees" / "review").mkdir(parents=True)
(older / ".worktrees" / "review" / ".git").write_text("gitdir: /somewhere\n")
item = only_one({"acme/api": entry(older)})
assert item["eligible"] is False and "earlier review checkout" in item["why"], item
(older / ".worktrees" / "review" / ".git").unlink()
print("old review worktree ok")

# The host reports an open pull request: kept.
open_pr = folder("open")
cleanup.call = stub(host=(0, json.dumps([{"number": 7}]), ""))
item = only_one({"acme/api": entry(open_pr)})
assert item["eligible"] is False and "open pull request" in item["why"], item
print("open PR ok")

# The host cannot be asked: kept, with the reason.
closed = folder("closed")
cleanup.call = stub(host=(1, "", "HTTP 502 from github.com"))
item = only_one({"acme/api": entry(closed)})
assert item["eligible"] is False and "Could not ask" in item["why"] and "502" in item["why"], item
cleanup.call = stub(host=(0, "not json", ""))
item = only_one({"acme/api": entry(closed)})
assert item["eligible"] is False and "could not be read" in item["why"], item
print("host failure ok")

# No open PR for a clean, old clone: eligible, and no reason shown.
cleanup.call = stub(host=(0, "[]", ""))
item = only_one({"acme/api": entry(closed)})
assert item["eligible"] is True and item["why"] == "" and item["days"] == 40.0 and item["size"] == 0, item
assert item["used"] == NOW - 40 * DAY and item["repo"] == "acme/api" and item["path"] == str(closed), item
print("eligible ok")

# A GitLab clone asks glab with the project path encoded, nested groups kept.
gl = folder("project")
cleanup.call = stub(remote="git@gitlab.com:group/sub/project.git", host=(0, "[]", ""))
seen = []
calls = cleanup.call
cleanup.call = lambda argv, timeout=60: (seen.append(argv), calls(argv, timeout))[1]
item = only_one({"group/sub/project": entry(gl)})
assert item["eligible"] is True and seen[-1][0] == "glab" and \
    seen[-1][2] == "projects/group%2Fsub%2Fproject/merge_requests?state=opened&per_page=1", seen
print("gitlab ok")

# A clone whose origin is another repository: kept, because the registry cannot be trusted for it.
foreign = folder("foreign")
cleanup.call = stub(remote="https://github.com/other/api.git")
item = only_one({"acme/api": entry(foreign)})
assert item["eligible"] is False and "origin is not" in item["why"], item
cleanup.call = stub(remote=None)
item = only_one({"acme/api": entry(foreign)})
assert item["eligible"] is False and "no origin" in item["why"], item
print("origin ok")

# Two repositories recorded at one path: kept, because removal would take the other one too.
both = {"acme/api": entry(foreign), "acme/web": entry(foreign)}
cleanup.call = stub()
item = only_one(both, only="acme/api")
assert item["eligible"] is False and "also recorded for acme/web" in item["why"], item
print("shared path ok")

# --repo narrows the report to one repository.
two = {"acme/api": entry(closed), "acme/web": entry(folder("web"))}
assert len(candidates(two)) == 2
assert [c["repo"] for c in candidates(two, only="acme/api")] == ["acme/api"]
print("repo narrowing ok")

# --max-age from the command line is the age kept, and the report says which.
write_registry({"acme/api": entry(closed, used=time.time() - 5 * DAY)})
out = cleanup.main(["check", "--max-age", "10"])
assert out["max_age"] == 10 and out["candidates"][0]["eligible"] is False, out
assert cleanup.main(["check", "--repo", "acme/api"])["candidates"][0]["repo"] == "acme/api"
try:
    cleanup.main(["keep"])
    raise AssertionError("an unknown mode must fail")
except RuntimeError as e:
    assert "check or apply" in str(e), e
print("arguments ok")

# apply removes the eligible clone, keeps the dirty one, and rewrites the registry without the removed one.
gone = folder("gone-soon")
dirty2 = folder("dirty-two")
write_registry({"acme/api": entry(gone, used=time.time() - 40 * DAY),
                "acme/web": entry(dirty2, used=time.time() - 40 * DAY)})
cleanup.call = stub(status=lambda name: "" if name == "gone-soon" else " M b.py\n")
out = cleanup.main(["apply"])
assert out["removed"] == [{"repo": "acme/api", "path": str(gone)}], out
assert gone.exists() is False and dirty2.exists()
assert [k["repo"] for k in out["kept"]] == ["acme/web"] and out["kept"][0]["why"], out
left_registry = json.loads(cleanup.REGISTRY.read_text())
assert list(left_registry) == ["acme/web"], left_registry
print("apply ok")

# A path inside the app home is refused, and a clone root itself is refused.
inside = APP / "inner"
inside.mkdir(parents=True)
cleanup.call = stub()
item = only_one({"acme/api": entry(inside)})
assert item["eligible"] is False and "app's own folder" in item["why"], item
item = only_one({"acme/api": entry(ROOTS)})
assert item["eligible"] is False and "clone root" in item["why"], item
print("app home ok")

# A registry that is not JSON counts as empty, and apply leaves the file alone.
write_registry("{not json")
assert candidates(cleanup.registry()) == []
assert cleanup.apply(now=NOW) == {"removed": [], "kept": []}
assert cleanup.REGISTRY.read_text() == "{not json"
print("bad registry ok")

# No `used`, only `at`: the clone was never used since it was made, so it ages from then.
unused = folder("unused")
item = only_one({"acme/api": {"path": str(unused), "at": NOW - 45 * DAY}})
assert item["used"] == NOW - 45 * DAY and item["eligible"] is True, item
print("unused ok")

TMP.cleanup()
print("ok")
