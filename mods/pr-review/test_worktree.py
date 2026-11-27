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

# The review worktree: one per PR at <worktrees>/<repo>/pr-review-<number>, reused for that PR's next head; a person's
# own checkout at that path is refused, not cleaned; a fix's branch is reset; at most MAX_TREES per repository and an
# aged tree goes; the legacy shared paths are not used any more.
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
    def push(text, n=7):  # that PR's head moves
        (origin / "a.py").write_text(text); g("commit", "-qam", "pr", cwd=origin); g("update-ref", f"refs/pull/{n}/head", "HEAD", cwd=origin)
        return g("rev-parse", "HEAD", cwd=origin)
    def run(n=7, clone=False):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            worktree.main(f"https://github.com/acme/api/pull/{n}", clone=clone)
        return json.loads(out.getvalue())
    # Two clones: the one these runs use, and one under another folder name for the prune cases (its trees go to its own
    # folder under the worktrees folder).
    g("clone", "-q", str(origin), str(base / "code" / "api"), cwd=base)
    g("clone", "-q", str(origin), str(base / "code-old" / "acme-api"), cwd=base)
    clone, old = base / "code" / "api", base / "code-old" / "acme-api"
    worktree.WORKTREES = base / "wt"
    worktree.BASES = [base / "code"]
    h1 = push("x = 2\n")
    r = run()
    tree = base / "wt" / "api" / "pr-review-7"
    assert r == {"path": str(tree), "head": h1, "clone": str(clone), "created": False}, r
    assert (tree / ".git").is_file() and worktree.detached(tree) and (tree / "a.py").read_text() == "x = 2\n"
    assert not (clone / ".worktrees").exists() and g("status", "--porcelain", cwd=clone) == "", "nothing is made inside the clone"
    # A second PR of the same repository: its own checkout at its own head, and the first one stays where it was.
    h8 = push("x = 8\n", 8)
    r8 = run(8)
    t8 = base / "wt" / "api" / "pr-review-8"
    assert [r8["path"], r8["head"]] == [str(t8), h8] and t8 != tree, r8
    assert (t8 / "a.py").read_text() == "x = 8\n" and (tree / "a.py").read_text() == "x = 2\n", "two PRs, two checkouts, each at its own head"
    # The legacy shared folder (pr-review, no number) is not used: this PR's checkout is still its own, and a folder
    # left there stays as it is (the age prune knows its name).
    (base / "wt" / "api" / "pr-review").mkdir()
    assert run()["path"] == str(tree) and not (base / "wt" / "api" / "pr-review" / ".git").exists()
    # Its next head: the same checkout, reset (forced, cleaned).
    (tree / "left.txt").write_text("from the review before\n")
    h2 = push("x = 3\n")
    assert run() == {"path": str(tree), "head": h2, "clone": str(clone), "created": False} and (tree / "a.py").read_text() == "x = 3\n" and not (tree / "left.txt").exists()
    # The clone is there, so --clone reuses it: created stays false, and the panel must not record it.
    assert run(clone=True)["created"] is False
    # A person's own checkout of a branch at that path: refused with the branch it is on, and nothing in it is touched.
    g("worktree", "remove", "--force", str(tree), cwd=clone); g("worktree", "add", "-q", "-b", "feature/x", str(tree), cwd=clone)
    (tree / "mine.txt").write_text("my work\n")
    try:
        run()
        raise AssertionError("reset a checkout that is not the review's")
    except worktree.Foreign as e:
        assert e.branch == "feature/x" and e.clean is False and pathlib.Path(e.path) == tree, (e.path, e.branch, e.clean)
        assert "is on the branch feature/x" in str(e) and "not this review's" in str(e), e
    assert (tree / "mine.txt").read_text() == "my work\n"
    # The same checkout made clean: still refused (the branch is a person's), and the panel may detach it.
    (tree / "mine.txt").unlink()
    try:
        run()
        raise AssertionError("reset a checkout that is not the review's")
    except worktree.Foreign as e:
        assert e.clean is True and e.head == h2, (e.clean, e.head)
    # A branch a fix made there (pr-review/<n>) is the mod's own state: a dirty one is refused (its agent may still
    # have work in it), and a clean one is reset to the head with its branch kept.
    g("checkout", "-q", "-b", "pr-review/7", cwd=tree)
    g("commit", "-q", "--allow-empty", "-m", "a fix", cwd=tree)
    assert worktree.on_fix_branch(tree) and not worktree.detached(tree)
    (tree / "a.py").write_text("x = 4\n")
    try:
        run()
        raise AssertionError("a dirty fix branch is not refused")
    except RuntimeError as e:
        assert "uncommitted changes" in str(e) and "pr-review/7" in str(e), e
    assert (tree / "a.py").read_text() == "x = 4\n"
    g("checkout", "-q", "--", "a.py", cwd=tree)
    r = run()
    assert r["head"] == h2 and worktree.detached(tree) and g("branch", "--list", "pr-review/7", cwd=tree), r
    assert (tree / "a.py").read_text() == "x = 3\n"
    # A branch named exactly `pr-review` is a person's, not a fix's: never ours.
    g("checkout", "-q", "pr-review/7", cwd=tree)
    g("branch", "-m", "pr-review/7", "pr-review", cwd=tree)  # the same name without a number
    assert not worktree.on_fix_branch(tree) and not worktree.ours(tree, clone)
    g("branch", "-m", "pr-review", "pr-review/7", cwd=tree)
    g("checkout", "-q", "--detach", "HEAD", cwd=tree)
    # Another clone's tree, never used now: a run for it makes its own path, in its own folder.
    g("worktree", "add", "-q", "--detach", str(old / ".worktrees" / "review"), cwd=old)
    worktree.BASES = [base / "code-old"]
    ro = run()
    tf = base / "wt" / "acme-api" / "pr-review-7"
    assert ro["path"] == str(tf) and ro["head"] == h2, ro
    assert not (old / ".worktrees" / "review").samefile(tf), "the tree inside the clone is not used"
    worktree.BASES = [base / "code"]
    # A tree on another branch, or with uncommitted changes, is never pruned, however old and however many there are.
    fx = base / "wt" / "acme-api" / "pr-review-8"
    g("worktree", "add", "-q", "-b", "feature/y", str(fx), "HEAD", cwd=old)
    dirty = base / "wt" / "acme-api" / "pr-review-9"
    g("worktree", "add", "-q", "--detach", str(dirty), "HEAD", cwd=old)
    (dirty / "a.py").write_text("uncommitted\n")
    aged = time.time() - worktree.MAX_AGE - 60
    for p in (tf, fx, dirty):
        os.utime(p, (aged, aged))
    worktree.prune(None)
    assert not tf.exists(), "an aged tree this mod owns goes"
    assert fx.exists() and (fx / "a.py").exists() and dirty.exists() and (dirty / "a.py").read_text() == "uncommitted\n", "a person's branch, and uncommitted work, stay"
    # Four checkouts of one repository: the oldest idle one goes, and this run's with the two newest stay.
    keep = t8
    extra = [base / "wt" / "api" / f"pr-review-{n}" for n in (9, 10)]
    for p in extra:
        g("worktree", "add", "-q", "--detach", str(p), "HEAD", cwd=clone)
    now = time.time()
    for p, back in ((tree, 4000), (extra[0], 3000), (extra[1], 2000), (keep, 1000)):
        os.utime(p, (now - back, now - back))
    worktree.prune(keep)
    assert not tree.exists(), "the oldest idle checkout goes"
    assert keep.exists() and all(p.exists() for p in extra), "this run's checkout and the two newest stay"
    # … and the current one is kept even when it is the oldest.
    os.utime(keep, (now - 5000, now - 5000))
    worktree.prune(keep)
    assert keep.exists(), "prune never removes the checkout it is given"
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
        made, tree = base / "code" / "api", base / "wt" / "api" / "pr-review-7"
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

# contains: a fix already in the PR, proven by git alone. applyFix cherry-picks the fix and deletes its branch, so the
# commit the panel recorded is an ancestor ("in"); a rebase or a reworded cherry-pick keeps the patch instead
# ("patch"); a change the head does not carry, or a sha this clone does not have, is "out"; a bad checkout, a bad ref
# or bad arguments exit 1 with one sentence. Nothing is fetched, checked out or written.
import sys  # noqa: E402
with tempfile.TemporaryDirectory() as d:
    base = pathlib.Path(d).resolve()
    def g(*a):
        return subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", *a], cwd=base, check=True, capture_output=True, text=True).stdout.strip()
    def write(name, text):
        (base / name).write_text(text)
    g("init", "-q", "-b", "main")
    write("a.py", "x = 1\n"); g("add", "."); g("commit", "-qm", "base")
    root = g("rev-parse", "HEAD")
    g("checkout", "-q", "-b", "pr")
    write("b.py", "y = 1\n"); g("add", "."); g("commit", "-qm", "pr one")
    p1 = g("rev-parse", "HEAD")
    write("c.py", "z = 1\n"); g("add", "."); g("commit", "-qm", "pr two")
    p2 = g("rev-parse", "HEAD")
    # The fix on its own branch off the older PR tip; applyFix cherry-picks it onto the PR and deletes the branch.
    g("checkout", "-q", "-b", "fix/1", p1)
    write("b.py", "y = 2\n"); g("commit", "-qam", "fix: the finding")
    fix = g("rev-parse", "HEAD")
    g("checkout", "-q", "pr"); g("cherry-pick", fix)
    applied = g("rev-parse", "HEAD")
    g("branch", "-qD", "fix/1")
    assert applied != fix  # another parent, so another commit with the same patch
    assert worktree.contains(base, applied, root, [applied, p2, fix]) == {applied: "in", p2: "in", fix: "patch"}
    assert g("status", "--porcelain") == "", "contains writes nothing"
    # A reworded cherry-pick: another commit and message, the same patch.
    g("checkout", "-q", "-b", "fix/2", p2)
    write("d.py", "w = 1\n"); g("add", "."); g("commit", "-qm", "fix: another finding")
    worded = g("rev-parse", "HEAD")
    g("checkout", "-q", "pr"); g("cherry-pick", worded); g("commit", "-q", "--amend", "-m", "fix: the other finding")
    reworded = g("rev-parse", "HEAD")
    assert reworded != worded and worktree.contains(base, reworded, root, [worded]) == {worded: "patch"}
    # A rebase: the fix built on the older PR tip and moved onto the newer one keeps its patch.
    g("checkout", "-q", "-b", "fix/3", p1)
    write("f.py", "f = 1\n"); g("add", "."); g("commit", "-qm", "fix: also this")
    moved = g("rev-parse", "HEAD")
    g("rebase", "-q", p2)
    rebased = g("rev-parse", "HEAD")
    assert rebased != moved and worktree.contains(base, rebased, root, [moved]) == {moved: "patch"}
    # The walk is bounded: a patch older than the newest PATCH_WALK commits is not looked for, so it is "out".
    write("g.py", "g = 1\n"); g("add", "."); g("commit", "-qm", "pr goes on")
    later = g("rev-parse", "HEAD")
    assert worktree.contains(base, later, root, [moved]) == {moved: "patch"}
    worktree.PATCH_WALK = 1
    assert worktree.contains(base, later, root, [moved]) == {moved: "out"}
    worktree.PATCH_WALK = 100
    # A change this head does not carry, and a sha this clone does not have.
    g("checkout", "-q", "-b", "elsewhere", root)
    write("e.py", "v = 1\n"); g("add", "."); g("commit", "-qm", "not in the PR")
    elsewhere = g("rev-parse", "HEAD")
    assert worktree.contains(base, reworded, root, [elsewhere, "0" * 40, p2]) == {elsewhere: "out", "0" * 40: "out", p2: "in"}
    # The panel's call: JSON states on stdout and exit 0; a missing checkout, a ref that is not a commit, and bad
    # arguments each exit 1 with one sentence on stderr.
    here = pathlib.Path(worktree.__file__).parent
    def cli(*argv):
        return subprocess.run([sys.executable, "worktree.py", "contains", *argv], cwd=here, capture_output=True, text=True)
    r = cli(str(base), reworded, root, "--", applied, worded, "0" * 40)
    assert r.returncode == 0 and json.loads(r.stdout) == {applied: "in", worded: "patch", "0" * 40: "out"}, (r.stdout, r.stderr)
    r = cli(str(base / "missing"), reworded, root, "--", applied)
    assert r.returncode == 1 and r.stdout == "" and "Not a checkout" in r.stderr and len(r.stderr.strip().splitlines()) == 1, r
    r = cli(str(base), "nope", root, "--", applied)  # a ref the clone does not have: a git failure, not "out"
    assert r.returncode == 1 and r.stdout == "" and "not a commit" in r.stderr and len(r.stderr.strip().splitlines()) == 1, r
    r = cli(str(base), reworded, root)  # no -- and no sha
    assert r.returncode == 1 and r.stdout == "" and "contains needs" in r.stderr, r
    try:
        worktree.contains(base / "missing", reworded, root, [applied])
        raise AssertionError("a missing checkout must be refused")
    except RuntimeError as e:
        assert "Not a checkout" in str(e), e
print("contains ok")
