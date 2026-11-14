"""Run: python3 test_safegit.py  (a scratch repo, no network): the read-only git of the model runs."""
import os
import pathlib
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
import safegit  # noqa: E402

no = lambda cmd, *a: safegit.refused(cmd, list(a))  # noqa: E731
for cmd, args in [("diff", ["/etc/hosts", "README.md"]), ("diff", ["~/x", "a.py"]), ("diff", ["../x", "a.py"]), ("diff", ["a/../../x", "a.py"]),
                  ("diff", ["--no-index", "a", "b"]), ("diff", ["--ou=x"]), ("diff", ["--output=x"]), ("diff", ["--ext", "HEAD"]), ("diff", ["--textconv"]),
                  ("blame", ["--con", "x", "a.py"]), ("blame", ["-S", "revs", "a.py"]), ("blame", ["--ignore-revs-f", "x", "a.py"]), ("diff", ["-Ox", "HEAD"]),
                  ("show", ["HEAD:../x"]), ("show", ["HEAD:/etc/hosts"]), ("diff", ["--relative=../"]), ("log", ["-L1,5:/etc/hosts"]), ("diff", ["HEAD", "--", "../x"]),
                  ("ls-files", ["-X", "x"]), ("rev-parse", ["--resolve-git-dir", "x"]), ("grep", ["x"]), ("config", ["--list"]), ("diff", ["..\\x"])]:
    assert no(cmd, *args), (cmd, args)
for cmd, args in [("diff", ["base..head", "--", "lib/x.py"]), ("diff", ["origin/main...HEAD", "--stat"]), ("log", ["--oneline", "-5"]), ("show", ["HEAD:lib/x.py"]),
                  ("blame", ["-L", "1,5", "lib/x.py"]), ("log", ["-Sneedle", "--format=%H"]), ("diff", ["--exit-code", "--name-only"]), ("ls-files", []),
                  ("rev-parse", ["--show-toplevel"]), ("merge-base", ["HEAD", "origin/main"]), ("status", ["--short"]), ("log", ["--follow", "--", "lib/x.py"])]:
    assert no(cmd, *args) is None, (cmd, args, no(cmd, *args))

# Run for real in a scratch repo: a file outside is never read, an inside diff works, the root must be absolute.
top = pathlib.Path(tempfile.mkdtemp())
(top / "outside.txt").write_text("SECRET\n")
repo = top / "repo"
repo.mkdir()
run = lambda *a: subprocess.run(["git", *a], cwd=repo, capture_output=True, text=True, check=True)  # noqa: E731
run("init", "-q")
(repo / "a.py").write_text("x = 1\n")
run("-c", "user.name=t", "-c", "user.email=t", "add", "a.py")
run("-c", "user.name=t", "-c", "user.email=t", "commit", "-qm", "one")
me = str(pathlib.Path(__file__).with_name("safegit.py"))
call = lambda *a: subprocess.run([sys.executable, me, *a], capture_output=True, text=True)  # noqa: E731
out = call(str(repo), "diff", str(top / "outside.txt"), "a.py")
assert out.returncode == 2 and "SECRET" not in out.stdout + out.stderr and "refused" in out.stderr
assert call(str(repo), "log", "--oneline").stdout.strip().endswith("one")
assert call(str(repo), "show", "HEAD:a.py").stdout == "x = 1\n"
assert call("repo", "log").returncode == 2 and call(str(repo / "nowhere"), "log").returncode == 2, "the checkout is an absolute, existing folder"
os.chdir(top)
print("ok")
