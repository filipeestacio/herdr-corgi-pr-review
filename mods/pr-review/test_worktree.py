"""Run: python3 test_worktree.py  (a throwaway git repo, no network)."""
import os
import pathlib
import subprocess
import tempfile

import worktree

os.environ.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1")  # no hooks or templates of this machine, also for worktree.py's own git

with tempfile.TemporaryDirectory() as d:
    git = lambda *a: subprocess.run(["git", *a], cwd=d, check=True, capture_output=True, text=True).stdout.strip()
    git("init", "-q", "-b", "main")
    git("config", "user.email", "t@t"); git("config", "user.name", "t")
    f = pathlib.Path(d, "a.py")
    f.write_text("x = 1\n"); git("add", "."); git("commit", "-qm", "base")
    base = git("rev-parse", "HEAD")
    f.write_text("x = 2\n"); git("commit", "-qam", "pr v1")
    v1 = git("rev-parse", "HEAD")
    pathlib.Path(d, "b.py").write_text("y = 1\n"); git("add", "."); git("commit", "-qm", "pr v2")
    v2 = git("rev-parse", "HEAD")
    # A plain push: exactly the new commit.
    r = worktree.since_diff(d, v1, v2, ["a.py", "b.py"])
    assert r["mode"] == "ancestor" and "b.py" in r["patch"] and "a.py" not in r["patch"], r
    # A force push (v1 rewritten): both states of the PR's files compared.
    git("checkout", "-q", base); f.write_text("x = 3\n"); git("commit", "-qam", "pr v1 rewritten")
    v3 = git("rev-parse", "HEAD")
    r = worktree.since_diff(d, v1, v3, ["a.py"])
    assert r["mode"] == "interdiff" and "-x = 2" in r["patch"] and "+x = 3" in r["patch"] and r["note"], r
    # The old head is gone (no origin to fetch it from): the full PR.
    r = worktree.since_diff(d, "1" * 40, v3, ["a.py"])
    assert r["mode"] == "full" and r["patch"] == "", r
    # Fix verification's evidence: the finding's file diff since it went to Fix, else the file around the line now.
    import verify
    req = {"worktree": d, "head": v2, "items": [{"id": "f1", "file": "b.py", "line": 1, "title": "t", "since": v1}, {"id": "f2", "file": "a.py", "line": 1, "title": "u", "since": v1}]}
    p = verify.prompt(req)
    assert "[f1]" in p and "+y = 1" in p and "No change to the file" in p and "The file now, from line 1:" in p, p  # the checkout as it is (here: the rewritten head)
    # A fix checked on its own branch, before it is in the PR: the item's own start, commit and worktree, not the PR head's.
    git("checkout", "-q", "-b", "fix/1-f3", v2); pathlib.Path(d, "b.py").write_text("y = 2\n"); f.write_text("x = 4\n"); git("commit", "-qam", "fix")
    fix = git("rev-parse", "HEAD")
    req = {"worktree": d, "head": v2, "items": [{"id": "f3", "file": "b.py", "line": 1, "title": "t", "since": v2, "head": fix, "worktree": d, "branch": "fix/1-f3"}]}
    p = verify.prompt(req)
    assert "The whole diff of the fix branch fix/1-f3, not in the PR yet" in p and "+y = 2" in p and "+x = 4" in p, p  # the fix's other files too

# Clones: a dedicated one first, else the local checkout of that repo; none: NeedClone with the first root's folder.
with tempfile.TemporaryDirectory() as d:
    base = pathlib.Path(d)
    worktree.BASES = [base / "blue", base / "red"]
    def repo_at(path, url):
        path.mkdir(parents=True)
        subprocess.run(["git", "init", "-q"], cwd=path, check=True)
        subprocess.run(["git", "remote", "add", "origin", url], cwd=path, check=True)
    repo_at(base / "space", "git@github.com:acme/api.git")
    assert worktree.find_clone("acme", "api", base / "space").resolve() == (base / "space").resolve()
    assert worktree.find_clone("acme", "web", base / "space") is None  # another repo's checkout is not used
    try:
        worktree.clone_for("acme", "web")
        raise AssertionError("cloned without being asked")
    except worktree.NeedClone as e:
        assert e.dest == base / "blue" / "web"
    repo_at(base / "red" / "api", "https://github.com/other/api")  # taken by another repo: the owner-repo name
    repo_at(base / "red" / "acme-api", "https://github.com/acme/api.git")
    assert worktree.find_clone("acme", "api", base / "space") == base / "red" / "acme-api"  # dedicated beats local

# The review worktree: in Herdr's folder for worktrees (<worktrees>/<repo>/pr-review), never inside the clone; reused
# for the next head; a person's own checkout at that path is refused, not cleaned; one an earlier version made inside
# the clone is used on and never removed.
import contextlib  # noqa: E402
import io  # noqa: E402
import json  # noqa: E402
import time  # noqa: E402
with tempfile.TemporaryDirectory() as d:
    base = pathlib.Path(d).resolve()
    g = lambda *a, cwd: subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", *a], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()  # noqa: E731
    origin = base / "github.com" / "acme" / "api.git"
    origin.mkdir(parents=True); g("init", "-q", "-b", "main", cwd=origin)
    (origin / "a.py").write_text("x = 1\n"); g("add", ".", cwd=origin); g("commit", "-qm", "base", cwd=origin)
    def push(text):  # the PR's head moves
        (origin / "a.py").write_text(text); g("commit", "-qam", "pr", cwd=origin); g("update-ref", "refs/pull/7/head", "HEAD", cwd=origin)
        return g("rev-parse", "HEAD", cwd=origin)
    def run(clone=False):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            worktree.main("https://github.com/acme/api/pull/7", clone=clone)
        return json.loads(out.getvalue())
    for name in ("api", "old"):  # two clones: a fresh one, and one with an earlier version's review worktree inside
        g("clone", "-q", str(origin), str(base / ("code" if name == "api" else "code-old") / "api"), cwd=base)
    clone, old = base / "code" / "api", base / "code-old" / "api"
    worktree.WORKTREES = base / "wt"
    worktree.BASES = [base / "code"]
    h1 = push("x = 2\n")
    r = run()
    tree = base / "wt" / "api" / "pr-review"
    assert r == {"path": str(tree), "head": h1, "clone": str(clone), "created": False}, r
    assert (tree / ".git").is_file() and worktree.detached(tree) and (tree / "a.py").read_text() == "x = 2\n"
    assert not (clone / ".worktrees").exists() and g("status", "--porcelain", cwd=clone) == "", "nothing is made inside the clone"
    (tree / "left.txt").write_text("from the review before\n")
    h2 = push("x = 3\n")
    assert run() == {"path": str(tree), "head": h2, "clone": str(clone), "created": False} and (tree / "a.py").read_text() == "x = 3\n" and not (tree / "left.txt").exists()
    # The clone is there, so --clone reuses it: created stays false, and the panel must not record it.
    assert run(clone=True)["created"] is False
    # A person's own checkout of a branch at that path: refused, and nothing in it is touched.
    g("worktree", "remove", "--force", str(tree), cwd=clone); g("worktree", "add", "-q", "-b", "pr-review", str(tree), cwd=clone)
    (tree / "mine.txt").write_text("my work\n")
    try:
        run()
        raise AssertionError("reset a checkout that is not the review's")
    except RuntimeError as e:
        assert "is not this review's checkout" in str(e), e
    assert (tree / "mine.txt").read_text() == "my work\n"
    # … nor is it removed for its age (only detached trees are), and an aged review tree of another repo is.
    aged = time.time() - worktree.MAX_AGE - 60
    g("worktree", "add", "-q", "--detach", str(base / "wt" / "other" / "pr-review"), cwd=old)
    for t in (tree, base / "wt" / "other" / "pr-review"):
        os.utime(t, (aged, aged))
    worktree.prune(None)
    assert tree.exists() and not (base / "wt" / "other" / "pr-review").exists()
    # An earlier version's <clone>/.worktrees/review: used on, however old, and no second tree in the folder.
    g("worktree", "add", "-q", "--detach", str(old / ".worktrees" / "review"), cwd=old)
    os.utime(old / ".worktrees" / "review", (aged, aged))
    worktree.BASES = [base / "code-old"]
    r = run()
    assert r["path"] == str(old / ".worktrees" / "review") and r["head"] == h2 and len(g("worktree", "list", cwd=old).splitlines()) == 2, r
    worktree.prune(None)
    assert (old / ".worktrees" / "review" / "a.py").read_text() == "x = 3\n"
print("ok")

# A merge request link: a nested group stays in the owner, and without a clone the script asks for one under the
# project's folder, never touching the real ~/code.
with tempfile.TemporaryDirectory() as roots:
    worktree.BASES = [pathlib.Path(roots)]
    try:
        worktree.main("https://gitlab.com/group/sub/project/-/merge_requests/7")
        raise AssertionError("a merge request with no clone must ask for one")
    except worktree.NeedClone as e:
        assert pathlib.Path(e.dest).parent == pathlib.Path(roots), e.dest
        assert pathlib.Path(e.dest).name in ("project", "group-sub-project"), e.dest
    assert worktree.is_repo  # the parser came from host.py; a wrong link is refused before any git call
    try:
        worktree.main("https://example.com/x")
        raise AssertionError("a link that is not a PR must be refused")
    except RuntimeError as e:
        assert "Not a PR url" in str(e), e
print("merge request ok")

# Two roots: a clone in the second is found, and the refusal names every folder searched.
with tempfile.TemporaryDirectory() as one, tempfile.TemporaryDirectory() as two:
    worktree.BASES = [pathlib.Path(one), pathlib.Path(two)]
    pathlib.Path(two, "p").mkdir()
    worktree.subprocess.run(["git", "init", "-q", "-b", "main"], cwd=str(pathlib.Path(two, "p")), check=True)
    worktree.subprocess.run(["git", "remote", "add", "origin", "https://gitlab.com/g/sub/p.git"], cwd=str(pathlib.Path(two, "p")), check=True)
    assert str(worktree.find_clone("g/sub", "p")) == str(pathlib.Path(two, "p")), "a clone in the second root is found"
    try:
        worktree.clone_for("g/sub", "other")
    except worktree.NeedClone as e:
        assert e.roots == [one, two], e.roots
print("roots ok")

# --clone makes the clone: created is true, so the panel may record it. Every later run reuses it and says false.
# The host URLs point at a local mirror through `url.<base>.insteadOf`, so git does the whole clone without a network.
with tempfile.TemporaryDirectory() as d:
    base = pathlib.Path(d).resolve()
    def g(*a, cwd):
        return subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", *a], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()
    source = base / "source"
    source.mkdir()
    g("init", "-q", "-b", "main", cwd=source)
    (source / "a.py").write_text("x = 1\n"); g("add", ".", cwd=source); g("commit", "-qm", "base", cwd=source)
    g("update-ref", "refs/pull/7/head", "HEAD", cwd=source)
    served = base / "github.com" / "acme" / "api.git"
    served.parent.mkdir(parents=True)
    g("clone", "-q", "--mirror", str(source), str(served), cwd=base)
    config = base / "gitconfig"
    config.write_text(f'[url "file://{base}/github.com/"]\n\tinsteadOf = https://github.com/\n\tinsteadOf = git@github.com:\n')
    before = os.environ.get("GIT_CONFIG_GLOBAL")
    os.environ["GIT_CONFIG_GLOBAL"] = str(config)
    try:
        worktree.BASES = [base / "code"]
        worktree.WORKTREES = base / "wt"
        def run(clone=False):
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                worktree.main("https://github.com/acme/api/pull/7", clone=clone)
            return json.loads(out.getvalue())
        made, tree = base / "code" / "api", base / "wt" / "api" / "pr-review"
        r = run(clone=True)
        assert r["created"] is True and r["clone"] == str(made) and r["path"] == str(tree) and r["head"], r
        assert (made / ".git").is_dir() and (tree / "a.py").read_text() == "x = 1\n", r
        r = run()
        assert r["created"] is False and r["clone"] == str(made), r
        r = run(clone=True)
        assert r["created"] is False and r["clone"] == str(made), r
    finally:
        os.environ["GIT_CONFIG_GLOBAL"] = before if before is not None else os.devnull
print("created ok")
