#!/usr/bin/env python3
"""The PR head as files for the review layout: reviewers, the AI analysis and the LSP bridge work there.

argv[1]: PR or MR url (https://github.com/<owner>/<repo>/pull/<n>, https://<host>/<group>/<project>/-/merge_requests/<n>);
options --local <dir> (the active space's checkout of
that repo), --root <dir> (repeatable: the clone folders to look in, the first one is where a new clone goes;
default ~/code), --worktrees <dir> (Herdr's folder for worktrees, settings.json `worktrees.directory`; default
~/.herdr/worktrees), --clone.
Uses an existing clone: a dedicated one under a root (<repo> or <owner>-<repo>), else the --local checkout when its
origin is that repo. Without one it clones only with --clone (an explicit click; into the first root,
--filter=blob:none); otherwise exit 3 with {"need_clone": <folder>}.
ONE reusable throwaway worktree per PR, <worktrees>/<repo>/pr-review-<number> (<repo>: the main checkout's folder
name, as Herdr's own New worktree names it): it fetches the PR's head (pull/<n>/head on GitHub, merge-requests/<n>/head
on GitLab) and checks that commit out detached (forced, cleaned). One tree per PR keeps two PRs of one repository from
taking turns, and one path per PR keeps one warm LSP index per PR. Nothing is made inside the clone. A folder at that
path is reset only when it is this clone's checkout and the mod owns it: on no branch, or on a fix's own branch
`pr-review/<n>` (a main fix works there, and its commits stay on that branch when the tree is detached again). A
checkout on any other branch is a person's, and is refused, not cleaned. A `pr-review/<n>` folder with uncommitted
changes is refused too: that may be the fix agent's work. A repository keeps at most MAX_TREES of them, and a tree
unused for MAX_AGE goes too (prune), together with the LSP bridge's index for it (`lsp_bridge.py forget <root>`).
Earlier versions kept one shared tree at <worktrees>/<repo>/pr-review and then at <clone>/.worktrees/review: neither is
used now, and both are left where they are (the first only for prune, which knows its name).
ponytail: one tree per PR and three per repository; a fourth open PR reuses the least recently used tree, so a review
opened there pays one checkout again.
Prints {"path", "head", "clone", "created"}; `created` is true only when this run made the clone, false when it
reused one (also with --clone) or worked in --local; exit 1 with the reason on stderr. A checkout at that path that
belongs to someone else exits 4 with {"foreign": {"path", "branch", "clean", "head"}}: the panel shows that, and
offers to detach it at `head` when `clean`.
`worktree.py since <checkout> <old> <head> [<path>…]`: what changed from old to head (since_diff), as JSON.
`worktree.py contains <checkout> <head> <base> -- <sha> [<sha>…]`: where each commit is in that PR (contains), as JSON.
"""
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import time

sys.dont_write_bytecode = True  # a .pyc written into the mod's folder reloads the mod: the view waiting for this run is gone
import host

BASES = [pathlib.Path.home() / "code"]  # --root replaces it
WORKTREES = pathlib.Path.home() / ".herdr" / "worktrees"  # --worktrees replaces it
NAME = "pr-review"  # the review worktree's folder, where a branch's name would be (lsp_bridge.py throwaway knows it)
FIX = "pr-review/"  # the branches a fix makes in that tree (review.js prepareFixCheckout): the mod's own state
MAX_AGE = 7 * 86400
MAX_TREES = 3  # review checkouts kept per repository: the current one and the newest idle ones
PATCH_WALK = 100  # commits of base..head compared by patch id: enough for a rebase or a reworded fix
BRIDGE = pathlib.Path(__file__).with_name("lsp_bridge.py")


def git(*args, cwd=None, timeout=300):
    r = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError(f"git {args[0]}: {(r.stderr or r.stdout).strip()[:300]}")
    return r.stdout.strip()


class NeedClone(Exception):
    """No local clone of the repo; `dest` is where --clone would put it, `roots` the folders that were searched."""
    def __init__(self, dest, roots=None):
        super().__init__(f"No local clone: {dest}")
        self.dest, self.roots = dest, [str(r) for r in (roots or [])]


def is_repo(path, owner, repo):
    r = subprocess.run(["git", "remote", "get-url", "origin"], cwd=path, capture_output=True, text=True, timeout=30)
    return r.returncode == 0 and bool(re.search(rf"[/:]{re.escape(owner)}/{re.escape(repo)}(\.git)?/?$", r.stdout.strip(), re.I))


def find_clone(owner, repo, local=None):
    """An existing clone of owner/repo: a dedicated one (any root), else the local checkout when it is that repo."""
    for base in BASES:
        for path in (base / repo, base / f"{owner}-{repo}"):
            if (path / ".git").exists() and is_repo(path, owner, repo):
                return path
    if local and pathlib.Path(local).is_dir() and is_repo(local, owner, repo):
        return pathlib.Path(subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=local, capture_output=True, text=True).stdout.strip() or local)
    return None


def origin_of(path):
    """A checkout's origin URL, or None."""
    r = subprocess.run(["git", "remote", "get-url", "origin"], cwd=path, capture_output=True, text=True, timeout=30)
    return r.stdout.strip() if r.returncode == 0 and r.stdout.strip() else None


def clone_for(owner, repo, clone=False, local=None, url=None, hostname=None):
    """(the clone to work in, whether this run made it) from find_clone; none: a new one under the first root with
    clone=True, else NeedClone. A clone that was found is never reported as made."""
    found = find_clone(owner, repo, local)
    if found:
        return found, False
    base = BASES[0]
    dest = next((p for p in (base / repo, base / f"{owner}-{repo}") if not p.exists()), None)
    if dest is None:
        raise RuntimeError(f"No free folder for {owner}/{repo} under {base}")
    if not clone:
        raise NeedClone(dest, BASES)
    base.mkdir(parents=True, exist_ok=True)
    # The space's own checkout already knows the right remote and its login; else try HTTPS, then SSH (a private repo
    # with no credential helper answers only over SSH).
    remotes = [origin_of(local)] if local and is_repo(local, owner, repo) else []
    if hostname:
        remotes += [f"https://{hostname}/{owner}/{repo}.git", f"git@{hostname}:{owner}/{repo}.git"]
    remotes = [r for r in dict.fromkeys(remotes) if r] or [url]
    why = None
    for remote in remotes:
        shutil.rmtree(dest, ignore_errors=True)
        r = subprocess.run(["git", "clone", "--filter=blob:none", "--no-checkout", remote, str(dest)],
                           capture_output=True, text=True, timeout=600)
        if r.returncode == 0:
            return dest, True
        why = (r.stderr or r.stdout).strip()[:300]
    raise RuntimeError(f"git clone: {why or 'no remote to clone from'}")


def remove(clone, tree):
    subprocess.run(["git", "worktree", "remove", "--force", str(tree)], cwd=clone, capture_output=True, timeout=120)
    shutil.rmtree(tree, ignore_errors=True)
    if BRIDGE.exists():
        subprocess.run([sys.executable, str(BRIDGE), "forget", str(tree)], capture_output=True, timeout=60)


def common_dir(path):
    """The git folder a checkout shares with its repo's other checkouts (resolved), or None outside a repo."""
    r = subprocess.run(["git", "rev-parse", "--git-common-dir"], cwd=path, capture_output=True, text=True, timeout=30)
    return os.path.realpath(os.path.join(path, r.stdout.strip())) if r.returncode == 0 else None


def detached(path):
    """A checkout on no branch, as the review worktree is; a person's own worktree sits on its branch."""
    return subprocess.run(["git", "symbolic-ref", "-q", "HEAD"], cwd=path, capture_output=True, timeout=30).returncode == 1


def branch_of(path):
    """The branch a checkout is on, or None when it is on no branch (detached, as the review's own tree is)."""
    r = subprocess.run(["git", "symbolic-ref", "--quiet", "--short", "HEAD"], cwd=path, capture_output=True, text=True, timeout=30)
    return r.stdout.strip() if r.returncode == 0 and r.stdout.strip() else None


def on_fix_branch(path):
    """A fix left the review's tree on its own branch (pr-review/<n>, review.js prepareFixCheckout): the mod put it
    there, and its commits stay on that branch, so the tree may be detached again."""
    return (branch_of(path) or "").startswith(FIX)


def ours(path, clone):
    """The review's own checkout: a worktree of this clone on no branch, or on a fix branch of its own. Any other
    checkout (a person's, on a branch of theirs or of another tool) is theirs: refused, never cleaned."""
    return common_dir(path) == common_dir(clone) and (detached(path) or on_fix_branch(path))


def uncommitted(path):
    """What a checkout has not committed, as git status lists it (empty when the tree is clean)."""
    return git("status", "--porcelain", cwd=path)


class Foreign(RuntimeError):
    """A checkout at the review's own path that belongs to someone else: it is on a branch that is not a fix's, so the
    panel may offer one action, detaching it, and only when its tree is clean. `head` is the PR head to detach at."""
    def __init__(self, path, branch, clean, head):
        where = f"the branch {branch}" if branch else "no branch"
        super().__init__(f"{path} is on {where}: that checkout is not this review's. Detach it at {head[:7]}, "
                         f"move that folder away, or set another worktrees.directory in Herdr's settings.json.")
        self.path, self.branch, self.clean, self.head = path, branch, clean, head


def review_path(clone, number):
    """Where this PR's review worktree is: <worktrees>/<main checkout's folder name>/pr-review-<number>. One tree per
    PR, so two PRs of one repository never share a checkout (a fix on one no longer blocks the other). The legacy
    <worktrees>/<folder>/pr-review is not used any more: a folder there is left for the age prune to take.
    ponytail: a bare clone's name is its parent folder's; clones made here are never bare."""
    return WORKTREES / pathlib.Path(common_dir(clone)).parent.name / f"{NAME}-{number}"


def prunable(wt):
    """A review tree this mod may remove: on no branch or on a fix's branch (pr-review/<n>, on_fix_branch), and with
    nothing uncommitted in it. A person's checkout, or a fix agent's uncommitted work, is left alone."""
    return (detached(wt) or on_fix_branch(wt)) and not uncommitted(wt)


def prune(keep):
    """Review checkouts under the worktrees folder: <worktrees>/<folder>/pr-review-<n>, and the legacy pr-review. Each
    repository folder keeps at most MAX_TREES, the newest by mtime surviving, and `keep` (this run's) always one of
    them; a tree unused for MAX_AGE goes too. Only a tree this mod owns is removed (prunable): never a person's branch
    or a fix agent's uncommitted work, and with each tree taken the LSP bridge's index for it. Trees inside a clone
    (earlier versions) stay."""
    repos = {p.parent for p in WORKTREES.glob(f"*/{NAME}*")}
    for repo in repos:
        trees = sorted((p for p in repo.glob(f"{NAME}*") if (p / ".git").is_file()), key=lambda p: p.stat().st_mtime, reverse=True)
        for i, wt in enumerate(trees):
            if wt == keep: continue
            if (i >= MAX_TREES or time.time() - wt.stat().st_mtime > MAX_AGE) and prunable(wt):
                remove(pathlib.Path(common_dir(wt)).parent, wt)


def since_diff(cwd, old, head, paths=()):
    """The diff from `old` (the head last reviewed) to `head` in the checkout `cwd`, fetching old when missing.
    mode "ancestor": old..head, exactly what was pushed since; "interdiff": old is no ancestor (force push, rebase):
    old..head limited to `paths` (the PR's files), which also shows what a rebase brought into them; "full": old is
    gone, the caller shows the whole PR. Returns {mode, patch, note}."""
    def run(*args, timeout=120):
        return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, timeout=timeout)
    if run("cat-file", "-e", f"{old}^{{commit}}").returncode != 0:
        run("fetch", "--quiet", "origin", old, timeout=300)  # GitHub serves a SHA it still has, even after a force push
        if run("cat-file", "-e", f"{old}^{{commit}}").returncode != 0:
            return {"mode": "full", "patch": "", "note": f"{old[:7]} is gone (force push?): showing the full PR"}
    ancestor = run("merge-base", "--is-ancestor", old, head).returncode == 0
    if not ancestor and not paths:
        return {"mode": "full", "patch": "", "note": f"{old[:7]} is not in the new history: showing the full PR"}
    r = run("diff", "--no-color", "--no-ext-diff", old, head, "--", *(() if ancestor else paths))
    if r.returncode != 0:
        return {"mode": "full", "patch": "", "note": f"git diff: {r.stderr.strip()[:160]}"}
    return {"mode": "ancestor" if ancestor else "interdiff", "patch": r.stdout,
            "note": None if ancestor else f"Force push: {old[:7]} is not an ancestor, so this compares both states of the PR's files (rebased base changes included)"}


def patch_id(cwd, sha):
    """The patch id of one commit (git patch-id --stable: its diff, without line numbers, whitespace or its message),
    or None when its diff is empty here (a merge commit, an empty commit)."""
    diff = subprocess.run(["git", "diff-tree", "-p", "--no-color", "--no-commit-id", sha], cwd=cwd, capture_output=True, text=True, timeout=120)
    if diff.returncode != 0:
        raise RuntimeError(f"git diff-tree: {(diff.stderr or diff.stdout).strip()[:300]}")
    r = subprocess.run(["git", "patch-id", "--stable"], cwd=cwd, input=diff.stdout, capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        raise RuntimeError(f"git patch-id: {(r.stderr or r.stdout).strip()[:300]}")
    return r.stdout.split()[0] if r.stdout.strip() else None


def patch_ids(cwd, base, head, limit=PATCH_WALK):
    """The patch id of each of the newest `limit` commits of base..head, mapped to the commit that carries it."""
    log = subprocess.run(["git", "log", "--no-color", f"--max-count={limit}", "--format=commit %H", "-p", f"{base}..{head}", "--"],
                         cwd=cwd, capture_output=True, text=True, timeout=300)
    if log.returncode != 0:
        raise RuntimeError(f"git log: {(log.stderr or log.stdout).strip()[:300]}")
    r = subprocess.run(["git", "patch-id", "--stable"], cwd=cwd, input=log.stdout, capture_output=True, text=True, timeout=300)
    if r.returncode != 0:
        raise RuntimeError(f"git patch-id: {(r.stderr or r.stdout).strip()[:300]}")
    return {pid: sha for pid, sha in (line.split() for line in r.stdout.splitlines() if line.strip())}


def contains(cwd, head, base, shas):
    """Where each fix commit is in this PR: "in" when it is an ancestor of `head`; "patch" when it is not, but a
    commit of `base..head` (the newest PATCH_WALK) has its patch: the same change, other parents and message, as a
    rebase or a reworded cherry-pick leaves it; "out" when neither, or the sha is unknown to this clone.
    `applyFix` cherry-picks the fix and deletes its branch, so the commit it recorded is "in"; the agent's original
    is its "patch" while that object is still here, else "out". Read only: no fetch, no checkout, nothing written."""
    if not shas:
        raise RuntimeError("contains: no sha to look for")
    if not os.path.isdir(cwd):
        raise RuntimeError(f"Not a checkout: {cwd}")
    def run(*args):
        return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, timeout=120)
    for ref in (head, base):
        if run("cat-file", "-e", f"{ref}^{{commit}}").returncode != 0:
            raise RuntimeError(f"{ref} is not a commit in {cwd}")
    found, patches = {}, None
    for sha in shas:
        if run("cat-file", "-e", f"{sha}^{{commit}}").returncode != 0:
            found[sha] = "out"
            continue
        ancestor = run("merge-base", "--is-ancestor", sha, head)
        if ancestor.returncode == 0:
            found[sha] = "in"
            continue
        if ancestor.returncode != 1:
            raise RuntimeError(f"git merge-base: {(ancestor.stderr or ancestor.stdout).strip()[:300]}")
        patches = patch_ids(cwd, base, head, PATCH_WALK) if patches is None else patches
        found[sha] = "patch" if patch_id(cwd, sha) in patches else "out"
    return found


def main(url, clone=False, local=None):
    link = host.parse_link(url)
    if not link:
        raise RuntimeError(f"Not a PR url: {url}")
    owner, _, repo = link["repo"].rpartition("/")  # GitLab's nested group stays in owner
    n = link["number"]
    clone, created = clone_for(owner or link["repo"], repo or link["repo"], clone, local, url=url, hostname=link["hostname"])
    # GitHub publishes a PR's head as refs/pull/<n>/head; GitLab as refs/merge-requests/<n>/head.
    gitlab = link["host"] == host.GITLAB
    refspec = f"+refs/merge-requests/{n}/head:refs/review/{n}" if gitlab else f"+refs/pull/{n}/head:refs/review/{n}"
    git("fetch", "--quiet", "origin", refspec, cwd=clone)
    head = git("rev-parse", f"refs/review/{n}", cwd=clone)
    path = review_path(clone, n)
    if (path / ".git").exists():
        if not ours(path, clone):  # forced and cleaned below: only our own
            raise Foreign(path, branch_of(path), not uncommitted(path), head)
        if on_fix_branch(path) and uncommitted(path):
            # A fix's branch can be detached again, but its tree may hold that agent's work: it is committed or stashed
            # first, never thrown away.
            raise RuntimeError(f"{path} is on {branch_of(path)} with uncommitted changes: commit or stash them in that folder, then review again.")
        git("checkout", "--quiet", "--detach", "--force", head, cwd=path)
        git("clean", "-fdq", cwd=path)
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
        git("worktree", "prune", cwd=clone)  # a review worktree removed by hand is forgotten, so its path is free again
        git("worktree", "add", "--quiet", "--detach", str(path), head, cwd=clone)
    path.touch()
    prune(path)
    print(json.dumps({"path": str(path), "head": head, "clone": str(clone), "created": created}))


if __name__ == "__main__":
    try:
        if sys.argv[1] == "contains":
            rest = sys.argv[2:]
            cut = rest.index("--") if "--" in rest else len(rest)
            where, shas = rest[:cut], rest[cut + 1:]
            if len(where) != 3 or not shas:
                raise RuntimeError("contains needs <checkout> <head> <base> -- <sha> [<sha>…]")
            print(json.dumps(contains(where[0], where[1], where[2], shas)))
        elif sys.argv[1] == "since":
            print(json.dumps(since_diff(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5:])))
        else:
            args = sys.argv[2:]
            opt = lambda name: args[args.index(name) + 1] if name in args else None  # noqa: E731
            roots = [pathlib.Path(a).expanduser() for o, a in zip(args, args[1:]) if o == "--root"]
            BASES = roots or BASES
            WORKTREES = pathlib.Path(opt("--worktrees")).expanduser() if opt("--worktrees") else WORKTREES
            main(sys.argv[1], "--clone" in args, opt("--local"))
    except NeedClone as e:
        print(json.dumps({"need_clone": str(e.dest), "roots": e.roots}))
        sys.exit(3)
    except Foreign as e:  # the panel offers to detach it, and only when its tree is clean
        print(json.dumps({"foreign": {"path": str(e.path), "branch": e.branch, "clean": e.clean, "head": e.head}}))
        sys.exit(4)
    except Exception as e:  # noqa: BLE001 - the panel shows the reason
        print(str(e), file=sys.stderr)
        sys.exit(1)
