#!/usr/bin/env python3
"""The clones this mod made, once nothing needs them any more.

python3 cleanup.py check [--max-age <days>] [--repo <repo>]
python3 cleanup.py apply [--max-age <days>] [--repo <repo>]

Reads <app home>/pr-data/clones.json, where the panel records each clone it made:
{"<repo>": {"path": "/abs/clone", "at": 1795000000, "used": 1795600000}}, epoch seconds. Only a path
recorded there can go, and only when all of this holds: it is a folder and not a link; no checkout has used
it for more than --max-age days (default 30); git reports no local change; no review worktree is left for it
at <worktrees>/<folder>/pr-review (nor inside an earlier version's <clone>/.worktrees/review); its host
reports no open pull request (GitHub through gh, GitLab through glab, one call); it lies outside the app home
and is not one of the clone roots. A host that cannot be asked, or that answers with an error, keeps the clone.

Options: --max-age <days>; --repo <owner/repo> narrows to that repository; --root <dir> (repeatable, the clone
roots as worktree.py takes them, default ~/code); --worktrees <dir> (Herdr's folder for worktrees,
PR_REVIEW_WORKTREES, else ~/.herdr/worktrees).

check prints {"max_age", "candidates": [{"repo", "path", "used", "days", "size", "eligible", "why"}]};
`why` is a sentence for the person and empty when the clone is eligible. apply prints
{"removed": [{"repo", "path"}], "kept": [{"repo", "path", "why"}]}, removes the eligible clones and rewrites
the registry without them and without entries whose folder is gone. Exit 1 with one sentence on stderr only
for a real failure.
"""
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import time
from urllib.parse import quote

sys.dont_write_bytecode = True
import host

HOME = pathlib.Path.home()
APP = pathlib.Path(os.environ.get("HERDR_APP_HOME") or HOME / ".config/herdr-app")
REGISTRY = APP / "pr-data" / "clones.json"
ROOTS = [HOME / "code"]
WORKTREES = pathlib.Path(os.environ.get("PR_REVIEW_WORKTREES") or HOME / ".herdr" / "worktrees")
NAME = "pr-review"
MAX_AGE = 30
HOST_TIMEOUT = 60
MAX_FILES = 200000


def call(argv, timeout=60):
    """Run a program without a shell: (exit code, stdout, stderr). 127 when it is not installed, 124 on timeout."""
    try:
        r = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError:
        return 127, "", f"{argv[0]} is not installed"
    except subprocess.TimeoutExpired:
        return 124, "", f"{argv[0]} did not answer in {timeout} s"
    return r.returncode, r.stdout, r.stderr


def registry():
    """The panel's record of the clones this mod made, by repository; a file that is not a JSON object is no record."""
    try:
        value = json.loads(REGISTRY.read_text())
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def save(value):
    """Rewrite the registry in one step, so a read at the same time sees the old file or the new one."""
    REGISTRY.parent.mkdir(parents=True, exist_ok=True)
    tmp = REGISTRY.with_name(f".{REGISTRY.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=1))
    tmp.replace(REGISTRY)


def records(value, only=None):
    """The usable registry entries, by repository: a path string, and the repository asked for when one is given."""
    return {repo: entry for repo, entry in value.items()
            if (only is None or repo == only) and isinstance(entry, dict)
            and isinstance(entry.get("path"), str) and entry["path"]}


def size_of(path):
    """Bytes of the files under a folder, as du -sh counts them; a bounded walk that skips links and errors."""
    total = seen = 0
    for root, _dirs, files in os.walk(path, followlinks=False):
        for name in files:
            seen += 1
            if seen > MAX_FILES:
                return total
            try:
                total += os.lstat(os.path.join(root, name)).st_size
            except OSError:
                continue
    return total


def origin(path):
    """The clone's origin URL, or None when git cannot give one."""
    code, out, _err = call(["git", "-C", str(path), "remote", "get-url", "origin"])
    return out.strip() if code == 0 and out.strip() else None


def open_change(kind, repo):
    """Whether the host reports an open pull or merge request: ("open" | "none" | "unknown", the sentence for a person)."""
    if kind == host.GITHUB:
        code, out, err = call(["gh", "pr", "list", "-R", repo, "--state", "open", "--limit", "1", "--json", "number"],
                              HOST_TIMEOUT)
        what = "pull request"
    elif kind == host.GITLAB:
        code, out, err = call(["glab", "api", f"projects/{quote(repo, safe='')}/merge_requests?state=opened&per_page=1"],
                              HOST_TIMEOUT)
        what = "merge request"
    else:
        return "unknown", "The clone's host cannot be told, so open changes cannot be checked."
    if code != 0:
        return "unknown", f"Could not ask the host about open changes: {(err or out).strip()[:200] or f'exit {code}'}"
    try:
        found = json.loads(out)
    except ValueError:
        return "unknown", "The host's answer about open changes could not be read."
    if not isinstance(found, list):
        return "unknown", "The host's answer about open changes could not be read."
    return ("open", f"The repository still has an open {what}.") if found else ("none", "")


def within(path, folder):
    """`path` is `folder` or lies inside it, both resolved."""
    path, folder = os.path.realpath(path), os.path.realpath(folder)
    return path == folder or path.startswith(folder.rstrip(os.sep) + os.sep)


def evaluate(repo, entry, now, max_age, worktrees, roots, recorded):
    """One registry entry as the person sees it: size and age, and `why` when it must stay."""
    path = pathlib.Path(entry["path"]).expanduser()
    used = entry.get("used")
    if used is None:
        used = entry.get("at")
    item = {"repo": repo, "path": str(path), "used": used if isinstance(used, (int, float)) else None,
            "days": None, "size": 0, "eligible": False, "why": ""}

    def keep(why):
        item["why"] = why
        return item

    if path.is_symlink():
        return keep("The path is a link, not a folder.")
    if not path.is_absolute():
        return keep("The registry path is not absolute.")
    if not path.exists():
        return keep("The folder is gone.")
    if not path.is_dir():
        return keep("The path is not a folder.")
    item["size"] = size_of(path)
    if within(path, APP):
        return keep("The path is inside the app's own folder.")
    if any(os.path.realpath(path) == os.path.realpath(root) for root in roots):
        return keep("The path is a clone root itself.")
    for other, record in recorded.items():
        if other != repo and isinstance(record, dict) and isinstance(record.get("path"), str) and record["path"] and \
                os.path.realpath(pathlib.Path(record["path"]).expanduser()) == os.path.realpath(path):
            return keep(f"The path is also recorded for {other}.")
    if item["used"] is None:
        return keep("The registry entry has no usable time.")
    age = now - item["used"]
    item["days"] = round(max(age, 0) / 86400, 1)
    if age <= max_age * 86400:
        return keep(f"Used {item['days']:g} days ago, within the {max_age:g} days kept.")

    code, out, err = call(["git", "-C", str(path), "status", "--porcelain"], 60)
    if code != 0:
        return keep(f"git could not read the clone: {(err or out).strip()[:200] or f'exit {code}'}")
    if out.strip():
        return keep("The clone has uncommitted changes.")
    remote = origin(path)
    if not remote:
        return keep("The clone has no origin, so its host cannot be told.")
    if not re.search(rf"[/:]{re.escape(repo)}(?:\.git)?/?$", remote, re.I):
        return keep(f"The clone's origin is not {repo}.")
    tree = worktrees / path.name / NAME
    if tree.exists():
        return keep(f"A review checkout is still there: {tree}.")
    older = path / ".worktrees" / "review"
    if (older / ".git").exists():
        return keep(f"An earlier review checkout is still inside the clone: {older}.")
    state, why = open_change(host.host_of(remote), repo)
    if state != "none":
        return keep(why)
    item["eligible"] = True
    return item


def report(max_age=None, only=None, worktrees=None, roots=None, recorded=None, now=None):
    """What `check` prints: every usable registry entry, with its size, its age and the reason it stays."""
    max_age = MAX_AGE if max_age is None else max_age
    worktrees = WORKTREES if worktrees is None else worktrees
    roots = ROOTS if roots is None else roots
    recorded = registry() if recorded is None else recorded
    now = time.time() if now is None else now
    candidates = [evaluate(repo, entry, now, max_age, worktrees, roots, recorded)
                  for repo, entry in records(recorded, only).items()]
    candidates.sort(key=lambda c: c["path"])
    return {"max_age": max_age, "candidates": candidates}


def apply(max_age=None, only=None, worktrees=None, roots=None, recorded=None, now=None):
    """Remove the clones `check` calls eligible for the same arguments, then rewrite the registry."""
    max_age = MAX_AGE if max_age is None else max_age
    recorded = registry() if recorded is None else recorded
    result = report(max_age, only, worktrees, roots, recorded, now)
    removed, kept = [], []
    for item in result["candidates"]:
        if not item["eligible"]:
            kept.append({"repo": item["repo"], "path": item["path"], "why": item["why"]})
            continue
        path = pathlib.Path(item["path"])
        try:
            if path.is_symlink() or not path.is_dir():
                raise OSError("the folder changed while it was checked")
            shutil.rmtree(path)
        except OSError as e:
            kept.append({"repo": item["repo"], "path": item["path"], "why": f"The folder could not be removed: {e}"})
            continue
        removed.append({"repo": item["repo"], "path": item["path"]})

    gone = {r["repo"] for r in removed}
    kept_registry, changed = {}, bool(removed)
    for repo, entry in recorded.items():
        if repo in gone:
            continue
        path = entry.get("path") if isinstance(entry, dict) else None
        if isinstance(path, str) and path and not pathlib.Path(path).expanduser().exists():
            changed = True
            continue
        kept_registry[repo] = entry
    if changed:
        save(kept_registry)
    return {"removed": removed, "kept": kept}


def option(args, name):
    if name not in args:
        return None
    i = args.index(name)
    if i + 1 >= len(args):
        raise RuntimeError(f"{name} needs a value.")
    return args[i + 1]


def main(argv):
    mode = argv[0] if argv else None
    if mode not in ("check", "apply"):
        raise RuntimeError("Say check or apply.")
    args = argv[1:]
    days = option(args, "--max-age")
    try:
        max_age = float(days) if days is not None else MAX_AGE
    except ValueError:
        raise RuntimeError("--max-age needs a number of days.") from None
    if max_age < 0:
        raise RuntimeError("--max-age cannot be negative.")
    max_age = int(max_age) if max_age.is_integer() else max_age
    roots = [pathlib.Path(a).expanduser() for name, a in zip(args, args[1:]) if name == "--root"]
    folder = option(args, "--worktrees")
    worktrees = pathlib.Path(folder).expanduser() if folder else None
    only = option(args, "--repo")
    if only is not None and not only.strip():
        raise RuntimeError("--repo needs a repository.")
    return (report if mode == "check" else apply)(max_age, only, worktrees, roots or None)


if __name__ == "__main__":
    try:
        print(json.dumps(main(sys.argv[1:])))
    except Exception as e:  # noqa: BLE001 - the panel shows the one sentence
        print(str(e), file=sys.stderr)
        sys.exit(1)
