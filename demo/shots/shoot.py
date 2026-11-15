#!/usr/bin/env python3
"""Screenshots of the review from a demo Herdr home, driven by `herdr-app do` only (no mouse, no keys).

  python3 demo/shots/shoot.py home  <home> --from <demo home> [--data <home>] [--mod <folder> …]  a copy with this checkout's mod
  python3 demo/shots/shoot.py start <home> --repo <checkout of the demo repo>  its own window and herdr-core
  python3 demo/shots/shoot.py run   <home> <spec.json> [--only a,b] [--out <folder>]
  python3 demo/shots/shoot.py stop  <home>
  python3 demo/shots/shoot.py all   <home> <spec.json> --from … --repo …       home, start, run, stop

<home> is a Herdr home made for this (never your own): `home` copies the demo home (its window closed), puts
mods/pr-review of this checkout in, and with --data takes pr-data (analysis, findings, threads) from another home.
--mod puts another mod's folder in too (mods/goto of its checkout, say). The window gets HOME=<home> and
HC_SESSION=<the home's folder name>: its own herdr-core, so your spaces and agents never show up in it, and no login
profile of yours, so the stand-ins in <home>/stub come first on its PATH. They stand for every program that would
leave the machine or start something of yours (gh, claude, codex, the editors, open, pbcopy, …), write their call
to <home>/stub/calls.log and fail. <home>/editor.dry-run makes "Open in <Editor>" start nothing, and the home's
pr-review.config.json keeps "dryRun": true, so nothing is posted.

A spec: {"out": folder (relative to the spec), "window": [x, y, w, h], "zoom_out": n, "setup": [commands], "settle": seconds after them,
"scale": width in pixels of a whole-window picture (a shot is twice the window's size on a Retina display),
"shots": [{"name", "do": [commands], "wait": seconds, "crop": [x, y, w, h] of the shot's pixels (kept at that
size), "also": [more files to write the same picture to], "then": [commands] run after the wait, for a state that lasts
a few seconds only ("Opening VS Code …" after a link's click): the first frame after them is the picture}]}. A shot starts from any state: its commands name the
layout and the page. A command is "name" or ["name", {args}]; "pr-review.x" needs no prefix
there: ":x" means "pr-review.x", and "{home}" in a command is the demo home's path. Commands that cost money, post, copy to the clipboard or open a browser are
refused (PAID); nothing a spec does leaves the machine. Explore is opened with its folder (":explore:<folder>"; the
bare command would ask for one in a dialog); its run starts only from the page, never from a command.
"""
import json, os, re, shutil, subprocess, sys, time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
LIVE = ("*.lock", "*.log", "lsp-bridge*")  # what belongs to a running window: its locks and its language-server bridge (port, token, pid)
PAID = re.compile(r"pr-review\.(analyze|diagrams|inside:.*|reviewer:.*|send|verify|single|submit|apply|copy-.*|md-copy|open-gh|open|trust.*|explore|probe:(?!.*:no$).*)$")


def die(msg): sys.exit(f"shoot: {msg}")


def home_of(arg):
    h = Path(arg).expanduser().resolve()
    own = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")).resolve() / "herdr-app"
    if h == own or own in h.parents: die(f"{h} is your own Herdr home; give a demo home")
    return h


def app(home, *args, check=True, quiet=False):
    r = subprocess.run(["herdr-app", *args], env={**os.environ, "HERDR_APP_HOME": str(home)}, capture_output=True, text=True)
    if check and r.returncode: die(f"herdr-app {' '.join(args)}: {r.stderr.strip() or r.stdout.strip()}")
    return None if quiet else r


def status(home):
    r = app(home, "status", check=False)
    try: return json.loads(r.stdout) if r.returncode == 0 else None
    except ValueError: return None


def do(home, cmd):
    name, args = (cmd, None) if isinstance(cmd, str) else cmd
    if name.startswith(":"): name = "pr-review." + name[1:]
    name = name.replace("{home}", str(home))  # a folder of the demo home, wherever that is
    if PAID.match(name): die(f"{name} costs money, posts, copies or opens a browser: not from a spec")
    app(home, "do", name, *([json.dumps(args)] if args else []))


STUBS = ("gh", "claude", "codex", "code", "idea", "cursor", "zed", "open", "xdg-open", "osascript", "pbcopy", "afplay")
EDITORS = ("Visual Studio Code", "IntelliJ IDEA")  # empty app folders in the home: the editor links find both, nothing can start


def own_env(home):
    """The window's environment: the home is its HOME, the stand-ins come first on its PATH."""
    keep = ("USER", "LOGNAME", "TMPDIR")  # not the caller's agent variables, not the caller's PATH
    return {**{k: os.environ[k] for k in keep if k in os.environ}, "HOME": str(home), "SHELL": "/bin/zsh", "LANG": "en_US.UTF-8",
            "TERM": "xterm-256color", "PATH": f"{home}/stub:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            "HERDR_APP_HOME": str(home), "HC_SESSION": home.name, "ZDOTDIR": str(home / "zdot"), "DO_NOT_TRACK": "1"}


def make_safe(home):
    """Nothing this home's window does starts a program of yours or leaves the machine."""
    stub = home / "stub"; stub.mkdir(exist_ok=True)
    for p in STUBS:
        f = stub / p
        if f.exists() and "calls.log" not in f.read_text(): continue  # a stand-in of your own (one that replays recorded answers) stays
        f.write_text(f'#!/bin/sh\necho "$(date +%T) {p} $*" >> "{stub}/calls.log"\nexit 1\n'); f.chmod(0o755)
    # Every shell of the window, also the one a restart gives a kept pane: no line of your own setup, and a prompt
    # without your user and host name.
    (home / "zdot").mkdir(exist_ok=True); (home / "zdot" / ".zshrc").write_text("PROMPT='%1~ %# '\n")
    (home / "editor.dry-run").write_text("shots home: no editor is started\n")
    for a in EDITORS:
        d = home / "Applications" / f"{a}.app" / "Contents"; d.mkdir(parents=True, exist_ok=True)
        (d / "Info.plist").write_text('<?xml version="1.0"?><plist version="1.0"><dict/></plist>\n')
    c = home / "pr-review.config.json"; cfg = json.loads(c.read_text()) if c.exists() else {}
    c.write_text(json.dumps({**cfg, "language": "English", "dryRun": True}))
    s = home / "shared.json"; sh = json.loads(s.read_text()) if s.exists() else {}
    sh["pr-review.contexts"] = {"default": "demo", "contexts": {"demo": {"label": "Demo", "env": {}}}}  # no account of yours
    s.write_text(json.dumps(sh, indent=1))


def make_home(home, src, data, mods=()):
    src = Path(src).expanduser().resolve()
    if status(src) is not None: die(f"{src} has its window open; close it before copying")
    if home.exists():
        if not (home / ".shots-home").exists(): die(f"{home} exists and was not made by this script")
        if status(home) is not None: die(f"{home} has its window open; `stop` it first")
        shutil.rmtree(home)
    shutil.copytree(src, home, symlinks=True, ignore=shutil.ignore_patterns("*.sock", *LIVE, "__pycache__"))
    (home / ".shots-home").write_text("made by demo/shots/shoot.py; safe to delete\n")
    if data: shutil.copytree(Path(data).expanduser() / "pr-data", home / "pr-data", dirs_exist_ok=True, ignore=shutil.ignore_patterns(*LIVE))
    mod = home / "mods" / "pr-review"; shutil.rmtree(mod, ignore_errors=True)
    shutil.copytree(REPO / "mods" / "pr-review", mod, ignore=shutil.ignore_patterns("__pycache__", "gpui-kit.d.ts", "jsconfig.json"))
    for m in mods:
        m = Path(m).expanduser().resolve(); shutil.rmtree(home / "mods" / m.name, ignore_errors=True)
        shutil.copytree(m, home / "mods" / m.name, ignore=shutil.ignore_patterns("__pycache__", "gpui-kit.d.ts", "jsconfig.json"))
    # Paths of the homes copied from become this home's (its own caches, time sheets and status files).
    old = [str(src)] + ([str(Path(data).expanduser().resolve())] if data else [])
    for f in [*home.glob("*.json"), *(home / "pr-data").rglob("*.json"), *(home / "control").glob("*.json")]:
        try: text = f.read_text()
        except (UnicodeDecodeError, OSError): continue
        new = text
        for o in old: new = new.replace(o, str(home))
        if new != text: f.write_text(new)
    for g in (home / "work").glob("*/.git"):  # a clone copied with the home: its worktrees name the old place
        wts = [str(w.parent) for w in g.parent.glob(".worktrees/*/.git")]
        if wts: subprocess.run(["git", "-C", str(g.parent), "worktree", "repair", *wts], capture_output=True)
    make_safe(home)
    print(f"home ready: {home}")


def start(home, repo, spec):
    if status(home) is not None: die(f"{home} is open already")
    if spec.get("window"):  # the window's place and size, so every run gives the same picture
        w = home / "window.json"; cur = json.loads(w.read_text()) if w.exists() else {}
        w.write_text(json.dumps({**cur, "state": "windowed", "bounds": [float(v) for v in spec["window"]]}))
    if not (home / ".shots-home").exists(): die(f"{home} was not made by this script (`home` makes one)")
    make_safe(home)
    log = open(home / "app.log", "w")  # what the window says while it starts
    subprocess.Popen([shutil.which("herdr-app")], cwd=home, env=own_env(home), stdout=log, stderr=log, start_new_session=True)
    for _ in range(60):
        if "error" not in (status(home) or {"error": 1}): break
        time.sleep(0.5)
    else: die(f"the window did not come up; see {home}/app.log")
    do(home, ["layout.switch", {"name": "corgi"}])
    # One space on the demo repo; herdr-core keeps a session's spaces, so a second run finds the first run's.
    if repo and Path(repo).name not in app(home, "ls").stdout:
        do(home, ["space.new", {"name": Path(repo).name, "folder": str(Path(repo).expanduser()), "tab": "notes", "argv": ["env", "PROMPT=%1~ %# ", "/bin/zsh", "-f"]}])
    time.sleep(2)
    errs = (status(home) or {}).get("errors")
    if errs: die(f"the window reports errors: {errs}")
    print(f"window open: HERDR_APP_HOME={home} HC_SESSION={home.name}")


def shot(home, path, tries=6):
    # A covered window draws only when resized: maximize and back, then take the frame it drew. Again until two
    # frames in a row are the same: a load or a layout switch shows up a frame late (a blinking cursor never settles).
    last = None
    for _ in range(tries):
        for _ in range(2): app(home, "do", "window.maximize", quiet=True)
        time.sleep(0.6)
        if app(home, "shot", str(path), check=False).returncode: time.sleep(0.4); app(home, "shot", str(path))
        cur = path.read_bytes()
        if cur == last: break
        last = cur


def run(home, spec_path, only, out):
    spec = json.loads(Path(spec_path).read_text()); base = Path(spec_path).resolve().parent
    trial = bool(out)  # --out: a look at the pictures somewhere else; the "also" copies stay as they are
    out = Path(out).expanduser() if out else (base / spec.get("out", ".")).resolve(); out.mkdir(parents=True, exist_ok=True)
    if status(home) is None: die(f"{home} has no window; `start` it first")
    do(home, "app.zoom_reset")
    for _ in range(spec.get("zoom_out", 0)): do(home, "app.zoom_out")
    for c in spec.get("setup", []): do(home, c); time.sleep(1.5)
    time.sleep(spec.get("settle", 0))  # the first PR list of a fresh window takes a few seconds
    made = []
    for s in spec["shots"]:
        if only and s["name"] not in only: continue
        for c in s.get("do", []): do(home, c); time.sleep(s.get("step", 0.8))  # a shot starts from any state: it names its layout and page
        time.sleep(s.get("wait", 1.2))
        for c in s.get("then", []): do(home, c)
        f = out / f"{s['name']}.png"; shot(home, f, 1 if s.get("then") else 6)
        vf = ([f"crop={s['crop'][2]}:{s['crop'][3]}:{s['crop'][0]}:{s['crop'][1]}"] if s.get("crop") else []) + ([f"scale={spec['scale']}:-2:flags=lanczos"] if spec.get("scale") and not s.get("crop") else [])
        if vf:
            tmp = f.with_suffix(".full.png"); f.rename(tmp)
            subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(tmp), "-vf", ",".join(vf), str(f)], check=True); tmp.unlink()
        for a in ([] if trial else s.get("also", [])): shutil.copy(f, (base / a).resolve())
        made.append(f.name)
    errs = (status(home) or {}).get("errors")
    if errs: die(f"the window reports errors after the run: {errs}")
    seen = {}  # a command that did nothing (an id the data no longer has) leaves the picture before it
    for name in made:
        twin = seen.setdefault((out / name).read_bytes(), name)
        if twin != name: print(f"warning: {name} is the same picture as {twin}; check its commands")
    print(f"{len(made)} shots in {out}: {' '.join(made)}")


def stop(home):
    if status(home) is not None: app(home, "do", "app.quit", check=False)
    subprocess.run([shutil.which("hc"), "server", "stop"], env=own_env(home), capture_output=True)
    bridge = home / "mods" / "pr-review" / "lsp_bridge.py"  # the language servers of this home; else they stay for 20 minutes
    if bridge.exists(): subprocess.run([sys.executable, str(bridge), "stop"], env={**own_env(home), "PATH": os.environ["PATH"]}, capture_output=True)
    track = home / "mods" / "timetrack" / "track.py"
    if track.exists(): subprocess.run([sys.executable, str(track), "--stop"], env=own_env(home), capture_output=True)
    print(f"stopped: {home}")


def main():
    a = sys.argv[1:]
    def opt(k):
        if k not in a: return None
        i = a.index(k); v = a[i + 1]; del a[i:i + 2]; return v
    src, data, repo, only, out = opt("--from"), opt("--data"), opt("--repo"), opt("--only"), opt("--out")
    mods = []
    while "--mod" in a: mods.append(opt("--mod"))
    if len(a) < 2: die(__doc__)
    cmd, home = a[0], home_of(a[1]); spec = a[2] if len(a) > 2 else None
    only = set(only.split(",")) if only else None
    if cmd in ("home", "all"):
        if not src: die("--from <demo home> is needed")
        make_home(home, src, data, mods)
    if cmd in ("start", "all"): start(home, repo, json.loads(Path(spec).read_text()) if spec else {})
    if cmd in ("run", "all"):
        if not spec: die("a spec is needed")
        try: run(home, spec, only, out)
        finally:
            if cmd == "all": stop(home)
    if cmd == "stop": stop(home)


if __name__ == "__main__":
    main()
