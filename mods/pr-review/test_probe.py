"""Run: python3 test_probe.py  (a scratch repo, no network): the runner of the probe agents. Harmless probes give
their result; hostile ones (network, writes and reads outside, the environment, endless loops, forks, floods of
output, links out of the folder) get nowhere and still give a result the review can show."""
import json
import os
import pathlib
import socket
import subprocess
import sys
import tempfile
import threading

sys.dont_write_bytecode = True
import probe  # noqa: E402

ME = str(pathlib.Path(__file__).with_name("probe.py"))
top = pathlib.Path(os.path.realpath(tempfile.mkdtemp()))
repo, outside = top / "repo", top / "outside"
repo.mkdir(), outside.mkdir()
(outside / "secret.txt").write_text("TOPSECRET\n")
# The machine's own git settings (signing, hooks) stay out of the scratch repo.
GIT_ENV = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}
git = lambda *a: subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t", *a], cwd=repo, capture_output=True, text=True, check=True, env=GIT_ENV)  # noqa: E731
git("init", "-q")
(repo / "lib.py").write_text("def mails(n):\n    return n\n")
git("add", "lib.py"), git("commit", "-qm", "base")
base = git("rev-parse", "HEAD").stdout.strip()
(repo / "lib.py").write_text("def mails(n):\n    return 2 * n  # the bug\n")
(repo / ".env").write_text("TOKEN=untracked\n")  # not tracked: never in the export
git("add", "lib.py"), git("commit", "-qm", "head")
(repo / probe.PROBE_DIR).mkdir()


def run(name, body, *extra, env=None, cli=False):
    """The probe through the command line (cli) or in this process (faster: one interpreter less per probe)."""
    (repo / probe.PROBE_DIR / f"{name}.py").write_text(body)
    env = env or {}
    if cli:
        r = subprocess.run([sys.executable, ME, str(repo), name, *extra], capture_output=True, text=True, env={**os.environ, **env}, timeout=120)
        return r.returncode, (json.loads(r.stdout) if r.returncode == 0 else r.stderr)
    saved = dict(os.environ)
    os.environ.update({k: v for k, v in env.items() if k != "PROBE_TIMEOUT"})
    try:
        return 0, probe.probe(str(repo), name, extra[1] if extra else None, int(env.get("PROBE_TIMEOUT", probe.LIMIT_S)))
    finally:
        os.environ.clear(), os.environ.update(saved)


HEADER = "import sys\nsys.path.insert(0, sys.argv[1])\nimport lib\n"
# A harmless probe: it reproduces on the head, not on the base; the result file sits next to the script.
code, r = run("double", HEADER + "n = lib.mails(10)\nprint('strength: forced_schedule')\nprint(f'reproduced mailer.send: {n} calls for 10 records' if n != 10 else f'not_reproduced {n} calls')\n", "--base", base, cli=True)
assert code == 0 and r["status"] == "reproduced" and r["line"] == "mailer.send: 20 calls for 10 records" and r["strength"] == "forced_schedule", r
assert r["base"]["status"] == "not_reproduced" and r["pre_existing"] is False and r["head"] and r["base"]["rev"] == base, r
assert json.loads((repo / probe.PROBE_DIR / "double.result.json").read_text())["status"] == "reproduced"
# The same failure on the base: there before this PR.
code, r = run("old", HEADER + "print('reproduced it returns', lib.mails(1) >= 1)\n", "--base", base)
assert r["status"] == "reproduced" and r["pre_existing"] is True, r
# A crash, no verdict line or a bad exit code is script_failed, never not_reproduced.
for name, body in (("crash", "raise KeyError(7)\n"), ("silent", "print('hello')\n"), ("exit3", "print('reproduced x')\nraise SystemExit(3)\n")):
    code, r = run(name, body)
    assert code == 0 and r["status"] == "script_failed", (name, r)
# Only tracked files are exported: the untracked .env is not there.
code, r = run("env-file", "import os\nprint('reproduced' if os.path.exists('.env') else 'not_reproduced no .env in the export')\n")
assert r["status"] == "not_reproduced", r

if probe.barrier() == "sandbox-exec":
    assert r["network_barrier"] is True and r["sandbox"] == "sandbox-exec"
    # One hostile probe tries everything at once and names what got through: the network (a listener on this machine,
    # a name lookup and a connection out), writes outside its own folder (next to the checkout, in another folder),
    # reads from a denied folder and from the user's home, new processes (a fork bomb, a spawned command).
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0)), srv.listen(5)
    threading.Thread(target=lambda: [srv.accept() for _ in range(5)], daemon=True).start()
    port, target, home = srv.getsockname()[1], outside / "written.txt", probe.user_home()
    hostile = f"""import os, socket, subprocess
got = []
def tries(name, fn):
    try:
        fn(); got.append(name)
    except Exception:
        pass
tries("local socket", lambda: socket.create_connection(("127.0.0.1", {port}), timeout=3))
tries("internet", lambda: (socket.getaddrinfo("example.com", 443), socket.create_connection(("example.com", 443), timeout=3)))
tries("write outside", lambda: open({str(target)!r}, "w").write("x"))
tries("write checkout", lambda: open({str(repo / 'pwned.txt')!r}, "w").write("x"))
tries("read denied", lambda: open({str(outside / 'secret.txt')!r}).read())
tries("read home", lambda: os.listdir({home!r}))
def bomb():
    for _ in range(50):
        if os.fork() == 0:
            os._exit(0)
tries("fork", bomb)
tries("spawn", lambda: subprocess.run(["/bin/echo", "hi"]))
open("inside.txt", "w").write("fine")
print("reproduced got through: " + ", ".join(got) if got else "not_reproduced all blocked")
"""
    code, r = run("hostile", hostile, env={"PROBE_EXTRA_DENY": str(outside)})
    assert r["status"] == "not_reproduced" and r["line"] == "all blocked", r
    assert not target.exists() and not (repo / "pwned.txt").exists() and "TOPSECRET" not in json.dumps(r), r
else:
    print(f"(no sandbox-exec here: {probe.barrier()}; the network, write, read and fork checks are skipped)")

# The environment: only PATH, HOME, TMPDIR and the locale reach the script; HOME is its own temporary folder.
code, r = run("environ", "import os\nprint('reproduced', sorted(os.environ), os.environ['HOME'])\n", env={"GH_TOKEN": "ghp_" + "x" * 30, "AWS_SECRET_ACCESS_KEY": "abc"})
assert r["status"] == "reproduced" and "GH_TOKEN" not in r["output"] and "AWS_" not in r["output"] and "pr-review-probe-" in r["line"], r
# An endless loop stops at the limit (shortened for the test), a flood of output at its cap; both are script_failed.
code, r = run("loop", "while True:\n    pass\n", env={"PROBE_TIMEOUT": "2"}, cli=True)
assert r["status"] == "script_failed" and "stopped after 2 s" in r["line"] and r["ms"] < 10000, r
code, r = run("flood", "import sys\nwhile True:\n    sys.stdout.write('x' * 10000)\n")
assert r["status"] == "script_failed" and "more than" in r["line"] and len(r["output"]) <= probe.OUT_CAP + 20, r
code, r = run("long", "print('y' * 9000)\nprint('reproduced long')\n")
assert r["status"] == "reproduced" and r["output"].endswith("[cut at 4 KB]"), r
# Secrets are blacked out of what is shown.
code, r = run("leak", "print('ada@example.com ghp_' + 'a' * 36 + ' token=abc123 Bearer abcdefghijklmn AKIA' + 'A' * 16)\nprint('reproduced mail to ada@example.com')\n")
assert r["status"] == "reproduced" and "ada@" not in json.dumps(r) and "ghp_" not in r["output"] and "abc123" not in r["output"] and "AKIA" not in r["output"] and "token=[redacted]" in r["output"], r
assert probe.redact("password: hunter2 and x@y.io") == "password: [redacted] and [redacted]"

# Refused calls: a bad id, a script that is a link, a result path that is a link, the folder as a link, no checkout.
r = subprocess.run([sys.executable, ME, str(repo), "../x"], capture_output=True, text=True)
assert r.returncode == 2 and "refused" in r.stderr
(outside / "evil.py").write_text("print('reproduced from outside')\n")
os.symlink(outside / "evil.py", repo / probe.PROBE_DIR / "linked.py")
r = subprocess.run([sys.executable, ME, str(repo), "linked"], capture_output=True, text=True)
assert r.returncode == 2 and "plain file" in r.stderr, r.stderr
(repo / probe.PROBE_DIR / "trap.py").write_text("print('reproduced x')\n")
os.symlink(outside / "victim.json", repo / probe.PROBE_DIR / "trap.result.json")
r = subprocess.run([sys.executable, ME, str(repo), "trap"], capture_output=True, text=True)
assert r.returncode == 2 and not (outside / "victim.json").exists(), r
r = subprocess.run([sys.executable, ME, "repo", "double"], capture_output=True, text=True)
assert r.returncode == 2
r = subprocess.run([sys.executable, ME, str(repo), "double", "--base", "--output=x"], capture_output=True, text=True)
assert r.returncode == 2 and "no commit" in r.stderr, r.stderr
other = top / "other"
other.mkdir(), subprocess.run(["git", "init", "-q"], cwd=other, check=True, env=GIT_ENV)
os.symlink(outside, other / probe.PROBE_DIR)
r = subprocess.run([sys.executable, ME, str(other), "evil"], capture_output=True, text=True)
assert r.returncode == 2 and "plain folder" in r.stderr, r.stderr
assert subprocess.run([sys.executable, ME, "--barrier"], capture_output=True, text=True).stdout.strip() == probe.barrier()
print("ok")
