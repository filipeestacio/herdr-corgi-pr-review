#!/usr/bin/env python3
"""The one way a probe agent runs code from a PR (threads.js, kind "probe"): a small script that shows a suspected
failure, run in a sandbox. The agent may call nothing but

    python3 <this file> <checkout> <id> [--base <rev>]

(`python3 <this file> --barrier` prints the fence this machine has: sandbox-exec, bwrap or none.)
<checkout> is the agent's worktree at the PR head (absolute), <id> names its script <checkout>/.pr-review-probe/<id>.py.
For the head (and the base, when given) the runner:
- exports the commit with `git archive` into a new, empty folder (only what git tracks: no .env, no build output);
- copies the script there and runs it as `python3 -I <script> <export>` from that folder, with `env -i` (PATH, a
  temporary HOME and TMPDIR, nothing else: no AWS_*, GH_TOKEN, context variables);
- on macOS under `sandbox-exec`: no network, writes only in its own temporary folder, nothing read from the user's home,
  no new processes; on Linux under bubblewrap (`bwrap`: no network, the whole file system read-only, the user's home an
  empty tmpfs, only its own temporary folder writable, its own PID namespace that dies with the runner); without
  either it still runs and says so
  (`network_barrier: false`: the review then asks before every probe);
- stops it after 30 s, keeps at most 4 KB of its output and blacks out e-mail addresses and token patterns.
The script ends with a line `reproduced <what it shows>` or `not_reproduced <what it saw>` (exit 0 or 1), optionally
`strength: forced_schedule | models_env` (default runs_pr_code). Anything else, a crash or the time limit is
`script_failed`: never read as a refutation.
The result is printed as JSON and written to <checkout>/.pr-review-probe/<id>.result.json (only by this runner):
{id, status, strength, line, exit, ms, head, base: {rev, status, line, exit, ms} | null, pre_existing, network_barrier,
sandbox, output, at}. Exit 2 when the call is refused. Standard library only.
"""
import datetime as dt
import io
import json
import os
import pwd
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading
import time

PROBE_DIR = ".pr-review-probe"
ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}")
REV = re.compile(r"[A-Za-z0-9][A-Za-z0-9_./^~-]{0,199}")
LIMIT_S, OUT_CAP, READ_CAP = 30, 4096, 65536
STRENGTHS = ("runs_pr_code", "forced_schedule", "models_env")
VERDICT = re.compile(r"^\s*(reproduced|not_reproduced|refuted)\b[\s:]*(.*)$")
# What is blacked out of an output before anyone sees it: e-mail addresses and the usual token shapes.
SECRETS = [re.compile(p) for p in (
    r"[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63})+", r"\bgh[pousr]_[A-Za-z0-9]{20,}", r"\bgithub_pat_[A-Za-z0-9_]{20,}", r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b",
    r"\bsk-[A-Za-z0-9_-]{20,}", r"\bxox[abposr]-[A-Za-z0-9-]{10,}", r"(?i)\bbearer\s+[A-Za-z0-9._~+/-]{10,}=*",
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)",
    r"(?i)\b(?:secret|token|password|passwd|api[_-]?key)\b(\s*[=:]\s*)\S+")]


def redact(text):
    for p in SECRETS:
        text = p.sub(lambda m: f"{m.group(0)[:m.start(1) - m.start(0)]}{m.group(1)}[redacted]" if p.groups else "[redacted]", text)
    return text


def git(checkout, *args):
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}  # as safegit: no GIT_DIR or GIT_CONFIG_* from outside
    env.update(GIT_CEILING_DIRECTORIES=os.path.dirname(checkout), GIT_CONFIG_NOSYSTEM="1", GIT_PAGER="cat")
    return subprocess.run(["git", "--no-pager", "-C", checkout, "-c", "core.fsmonitor=false", *args], env=env, capture_output=True, timeout=120)


def commit_of(checkout, rev):
    """The commit a revision names, or None."""
    if not REV.fullmatch(rev) or ".." in rev:
        return None
    r = git(checkout, "rev-parse", "--verify", "--quiet", f"{rev}^{{commit}}")
    return r.stdout.decode().strip() or None if r.returncode == 0 else None


def export(checkout, sha, dest):
    """The commit's tracked files into dest: regular files and folders only, nothing outside dest (no links, no
    absolute or .. names)."""
    r = git(checkout, "archive", "--format=tar", sha)
    if r.returncode != 0:
        raise RuntimeError(f"git archive failed: {r.stderr.decode()[:200]}")
    root = os.path.realpath(dest)
    with tarfile.open(fileobj=io.BytesIO(r.stdout)) as tar:
        for m in tar.getmembers():
            name = os.path.normpath(m.name)
            target = os.path.realpath(os.path.join(root, name))
            if name.startswith(("/", "..")) or not (target == root or target.startswith(root + os.sep)) or not (m.isfile() or m.isdir()):
                continue
            if m.isdir():
                os.makedirs(target, exist_ok=True)
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with tar.extractfile(m) as src, open(target, "wb") as out:
                shutil.copyfileobj(src, out)


def user_home():
    return os.path.realpath(pwd.getpwuid(os.getuid()).pw_dir)  # from the account, not from $HOME


def barrier():
    """How the script is fenced in here: sandbox-exec (macOS), bwrap (Linux, when it is installed and may make its
    namespaces) or none. A network namespace alone (unshare -rn) is not enough: it leaves the files readable and
    writable, so it counts as none and the review asks before every probe."""
    if sys.platform == "darwin" and shutil.which("sandbox-exec"):
        return "sandbox-exec"
    if sys.platform.startswith("linux") and shutil.which("bwrap") and subprocess.run(["bwrap", "--unshare-all", "--die-with-parent", "--ro-bind", "/", "/", "true"], capture_output=True).returncode == 0:
        return "bwrap"
    return "none"


def bwrap_args(root, extra_deny=()):
    """Linux: no namespace shared (network, PID, IPC, UTS, user), the file system read-only, the user's home (and the
    extra folders) hidden behind an empty tmpfs, only root writable, the interpreter's own files readable again when
    they sit in the home; the script dies with the runner and gets its own session (no terminal to inject into)."""
    hidden = [user_home(), *[os.path.realpath(d) for d in extra_deny]]
    py = [os.path.realpath(x) for x in (sys.base_prefix, sys.prefix)]
    again = [x for x in dict.fromkeys(py) if any(x == h or x.startswith(h + os.sep) for h in hidden)]
    return ["bwrap", "--unshare-all", "--die-with-parent", "--new-session", "--ro-bind", "/", "/", *[a for h in hidden for a in ("--tmpfs", h)],
            *[a for x in again for a in ("--ro-bind", x, x)], "--bind", root, root, "--dev", "/dev", "--proc", "/proc"]


def profile(root, extra_deny=()):
    """macOS: everything as usual, except: no network, no new process, writes only under root, and nothing read from
    the user's home (nor from the extra folders) but root and the interpreter's own files."""
    q = lambda p: json.dumps(os.path.realpath(p))  # noqa: E731  (a quoted SBPL string)
    deny = [user_home(), *extra_deny]
    allow = [root, sys.base_prefix, sys.prefix, os.path.dirname(os.path.realpath(sys.executable))]
    return "\n".join(["(version 1)", "(allow default)", "(deny network*)", "(deny process-fork)", "(deny file-write*)",
                      f"(allow file-write* (subpath {q(root)}) (literal \"/dev/null\") (literal \"/dev/dtracehelper\"))",
                      *[f"(deny file-read* (subpath {q(d)}))" for d in deny], *[f"(allow file-read* (subpath {q(a)}))" for a in allow]])


def run_one(script, export_dir, root, how, limit):
    """Runs the script in its export; → {status, strength, line, exit, ms, output}."""
    home, tmp = os.path.join(root, "home"), os.path.join(root, "tmp")
    os.makedirs(home), os.makedirs(tmp)
    env = ["/usr/bin/env", "-i", "PATH=/usr/bin:/bin", f"HOME={home}", f"TMPDIR={tmp}", "PYTHONDONTWRITEBYTECODE=1", "LANG=C.UTF-8"]
    cmd = [*env, os.path.realpath(sys.executable), "-I", script, export_dir]
    extra = [p for p in os.environ.get("PROBE_EXTRA_DENY", "").split(os.pathsep) if p]  # tests: more folders it may not read
    if how == "sandbox-exec":
        cmd = ["sandbox-exec", "-p", profile(root, extra), *cmd]
    elif how == "bwrap":
        cmd = [*bwrap_args(root, extra), *cmd]
    started, chunks, size = time.monotonic(), [], [0]
    p = subprocess.Popen(cmd, cwd=export_dir, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)

    def read():  # keep the first READ_CAP bytes, stop the script once it writes more
        while True:
            b = p.stdout.read(4096)
            if not b:
                return
            if size[0] < READ_CAP:
                chunks.append(b[:READ_CAP - size[0]])
            size[0] += len(b)
            if size[0] > READ_CAP:
                kill(p)
    reader = threading.Thread(target=read, daemon=True)
    reader.start()
    try:
        code, why = p.wait(timeout=limit), None
    except subprocess.TimeoutExpired:
        kill(p)
        code, why = p.wait(), f"stopped after {limit} s"
    reader.join(5)
    ms = int((time.monotonic() - started) * 1000)
    text = b"".join(chunks).decode("utf-8", "replace")
    if size[0] > READ_CAP:
        why = why or f"stopped: more than {READ_CAP // 1024} KB of output"
    found = [m for m in map(VERDICT.match, text.splitlines()) if m]
    strength = next((m.group(1) for m in re.finditer(r"(?m)^\s*strength:\s*(\w+)", text) if m.group(1) in STRENGTHS), "runs_pr_code")
    if why or code not in (0, 1) or not found:
        status, line = "script_failed", why or (f"exit {code}" if code not in (0, 1) else "no line starting with reproduced or not_reproduced")
    else:
        word, line = found[-1].group(1), found[-1].group(2).strip()
        status = "reproduced" if word == "reproduced" else "not_reproduced"
    # Cut first, then black out (the patterns run on 4 KB, not on 64 KB of one word); a secret cut in two at the edge
    # is blacked out as far as it is shown.
    out = redact(text[:OUT_CAP + 200])[:OUT_CAP] + ("\n[cut at 4 KB]" if len(text) > OUT_CAP else "")
    return {"status": status, "strength": strength, "line": redact(line[:400])[:300], "exit": code, "ms": ms, "output": out}


def kill(p):
    try:
        os.killpg(p.pid, 9)
    except (ProcessLookupError, PermissionError):
        pass


def probe(checkout, pid, base=None, limit=LIMIT_S):
    """Runs probe pid on the checkout's HEAD (and on base); → the result, also written next to the script."""
    folder = os.path.join(checkout, PROBE_DIR)
    if os.path.islink(folder) or os.path.realpath(folder) != os.path.join(checkout, PROBE_DIR):
        raise ValueError(f"{PROBE_DIR} must be a plain folder in the checkout")
    script = os.path.join(folder, f"{pid}.py")
    if os.path.islink(script) or not os.path.isfile(script):
        raise ValueError(f"{PROBE_DIR}/{pid}.py must be a plain file")
    with open(script, "rb") as f:
        code = f.read()
    head = commit_of(checkout, "HEAD")
    base_sha = commit_of(checkout, base) if base else None
    if not head or (base and not base_sha):
        raise ValueError(f"no commit for {'HEAD' if not head else base}")
    how = barrier()

    def on(sha):
        root = os.path.realpath(tempfile.mkdtemp(prefix="pr-review-probe-"))
        try:
            ex = os.path.join(root, "export")
            os.makedirs(ex)
            export(checkout, sha, ex)
            target = os.path.join(ex, PROBE_DIR, f"{pid}.py")
            os.makedirs(os.path.dirname(target), exist_ok=True)
            if os.path.lexists(target):
                os.remove(target)
            with open(target, "wb") as f:
                f.write(code)
            return run_one(target, ex, root, how, limit)
        finally:
            shutil.rmtree(root, ignore_errors=True)
    r = on(head)
    b = on(base_sha) if base_sha else None
    out = {"id": pid, **{k: r[k] for k in ("status", "strength", "line", "exit", "ms")}, "head": head,
           "base": {"rev": base_sha, **{k: b[k] for k in ("status", "line", "exit", "ms")}} if b else None,
           "pre_existing": bool(b and b["status"] == "reproduced" and r["status"] == "reproduced"),
           "network_barrier": how != "none", "sandbox": how, "output": r["output"], "at": dt.datetime.now().astimezone().isoformat(timespec="seconds")}
    # Next to the script, for the review; never through a link (the folder is the agent's).
    fd = os.open(os.path.join(folder, f"{pid}.result.json"), os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0), 0o644)
    with os.fdopen(fd, "w") as f:
        json.dump(out, f)
    return out


def main(argv):
    if argv == ["--barrier"]:  # the review asks before a probe when there is none
        print(barrier())
        return 0
    args, base = list(argv), None
    if "--base" in args:
        k = args.index("--base")
        if k + 1 >= len(args):
            return refuse("--base needs a revision")
        base = args.pop(k + 1)
        args.pop(k)
    if len(args) != 2 or not os.path.isabs(args[0]) or not os.path.isdir(args[0]):
        return refuse("usage: probe.py <checkout> <id> [--base <rev>]")
    checkout, pid = os.path.realpath(args[0]), args[1]
    if not ID.fullmatch(pid):
        return refuse("an id is letters, digits, - and _ (at most 64)")
    t = os.environ.get("PROBE_TIMEOUT", "")  # tests: a shorter limit, never a longer one
    limit = min(LIMIT_S, max(1, int(t))) if t.isdigit() else LIMIT_S
    try:
        print(json.dumps(probe(checkout, pid, base, limit), indent=1))
    except (ValueError, RuntimeError, OSError) as e:
        return refuse(str(e))
    return 0


def refuse(why):
    print(f"probe: refused: {why}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
