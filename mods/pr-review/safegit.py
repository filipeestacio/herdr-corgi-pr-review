#!/usr/bin/env python3
"""Read-only git for model runs that read someone else's PR (review.py, reviewers.py). The runs may call git only as

    python3 <this file> <checkout> <command> [args…]

and never git itself. Allowed commands: diff, log, show, status, blame, merge-base, rev-parse, ls-files. Refused, with
exit 2: any other command; a path that is absolute, starts with ~ or has a .. segment (git diff with a path outside
the repository silently turns into --no-index and reads any file; a revision range like base..head is no path
segment and stays allowed); options that write a file, run a program or read a file outside the checkout, also
abbreviated (git takes abbreviations in some commands: blame --con is --contents). git runs as `git -C <checkout>`,
without pager, external diff or textconv, with GIT_CEILING_DIRECTORIES above the checkout and abbreviated options
disallowed. Standard library only.
"""
import os
import re
import subprocess
import sys

COMMANDS = ("diff", "log", "show", "status", "blame", "merge-base", "rev-parse", "ls-files")
# Long options refused, also as any abbreviation of them: they write a file, run a program or read a file by path.
LONG = ("output", "ext-diff", "textconv", "no-index", "contents", "ignore-revs-file", "orderfile", "exclude-from",
        "exclude-per-directory", "open-files-in-pager", "resolve-git-dir", "git-dir", "work-tree", "exec", "paginate")
# Short options that take a file: diff/log/show -O<orderfile>, blame -S <revs-file>, ls-files -X <exclude-file>.
SHORT = {"diff": "O", "log": "O", "show": "O", "blame": "S", "ls-files": "X"}


def refused(cmd, args):
    """The reason the call is refused, or None."""
    if cmd not in COMMANDS:
        return f"only {', '.join(COMMANDS)} are allowed"
    paths = False
    for a in args:
        if a == "--":
            paths = True
            continue
        if a.startswith("--") and not paths:
            name = a[2:].split("=", 1)[0]
            if name and any(full.startswith(name) for full in LONG):
                return f"option {a.split('=', 1)[0]} is not allowed"
            values = a.split("=", 1)[1:]
        elif a.startswith("-") and len(a) > 1 and not paths:
            if SHORT.get(cmd) and SHORT[cmd] in a[1:]:
                return f"option -{SHORT[cmd]} is not allowed for git {cmd}"
            values = [a[2:]]  # an attached value, e.g. log -L1,5:path
        else:
            values = [a]
        for v in values:
            for part in re.split(r"[:=]", v):  # rev:path and --opt=path
                if part.startswith(("/", "~")) or ".." in part.replace("\\", "/").split("/"):
                    return f"{a}: paths must stay inside the checkout (no absolute path, ~ or ..)"
    return None


def main(argv):
    if len(argv) < 2 or not os.path.isabs(argv[0]) or not os.path.isdir(argv[0]):
        print("usage: safegit.py <checkout> <command> [args…]", file=sys.stderr)
        return 2
    root, cmd, args = os.path.realpath(argv[0]), argv[1], argv[2:]
    why = refused(cmd, args)
    if why:
        print(f"safegit: refused: {why}", file=sys.stderr)
        return 2
    env = {**os.environ, "GIT_CEILING_DIRECTORIES": os.path.dirname(root), "GIT_TEST_DISALLOW_ABBREVIATED_OPTIONS": "1",
           "GIT_PAGER": "cat", "PAGER": "cat"}
    env.pop("GIT_EXTERNAL_DIFF", None)
    env.pop("GIT_DIR", None)
    env.pop("GIT_WORK_TREE", None)
    plain = ["--no-ext-diff", "--no-textconv"] if cmd in ("diff", "log", "show") else []
    return subprocess.run(["git", "--no-pager", "-C", root, "-c", "core.fsmonitor=false", cmd, *plain, *args], env=env).returncode


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
