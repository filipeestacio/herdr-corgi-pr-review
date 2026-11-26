"""How pr-review calls an LLM headless (`claude -p`), its settings, and an optional usage ledger.

    import llm
    data = llm.claude("Review analysis", prompt, context={"id": "default", "env": None}, model="sonnet", schema=SCHEMA)

Settings come from pr-review.config.json in the Herdr app home (HERDR_APP_HOME, else ~/.config/herdr-app); every
key is optional (see PROVIDERS.md):
  language      the language the AI answers in (default "English")
  ledger        a folder: each call appends one JSON line to usage-YYYY-MM.jsonl there; unset: no ledger
  globalRules   conventions every PR is checked against, besides the repo's own rules files
  harness       the active harness profile's name, or a legacy {command, label, timeout, models, modelList, prefix}
  harnesses     named profiles: {command, label, env, timeout, models}
  providers     model catalogs read over HTTP by models.py: {label, kind, baseUrl, apiKeyEnv, headers, timeout, priceOverrides}
A context ({id, env}) comes from the panel: env vars for the call (null unsets one); id is recorded in the ledger.
"""
import datetime as dt
import json
import os
import pathlib
import re
import subprocess
import time

APP = pathlib.Path(os.environ.get("HERDR_APP_HOME") or pathlib.Path.home() / ".config/herdr-app")
CONFIG = APP / "pr-review.config.json"
KEEP_MONTHS = 24
# No hooks; and the read-only commands Claude Code runs by itself (cat, ls, git log …) read only inside the working
# directories (the checkout, --add-dir): a run reads someone else's PR and must not reach files outside it. This mod's
# own folder is one of them, so a run can call safegit.py, its only way to git (the folder holds only the mod's code;
# pr-data and the config lie beside it). Measured: readAllowPaths did not let the call through, a working directory does.
SETTINGS = {"disableAllHooks": True, "permissions": {"blockReadsOutsideWorkingDirectories": True,
                                                      "additionalDirectories": [str(pathlib.Path(__file__).resolve().parent)]}}
LEAN = ["--no-session-persistence", "--output-format", "json",
        "--settings", json.dumps(SETTINGS), "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
        "--disable-slash-commands"]


def quote(text, n=200):
    """A message shortened for one sentence, with an ellipsis when it was cut."""
    text = str(text or "")
    return text if len(text) <= n else text[:n].rstrip() + "…"


class MissingEnv(RuntimeError):
    """A profile env value reads a variable that is not set. name: the variable."""

    def __init__(self, name):
        super().__init__(name)
        self.name = name


# The profile Claude Code runs as when no config names another: its own argv, so `claude -p` stays the path it knows.
BUILTIN = {"name": "claude", "label": "Claude Code", "command": ["claude", "-p", "--model", "{model}"], "env": {},
           "timeout": None, "models": {}, "builtin": True}


def _entry(base, spec):
    """One profile: the keys `spec` has, over `base`'s. `command`, `label` and `timeout` must have the right kind to
    count, so a broken config keeps the profile it would otherwise have."""
    spec = spec if isinstance(spec, dict) else {}
    got = dict(base)
    if isinstance(spec.get("label"), str) and spec["label"]:
        got["label"] = spec["label"]
    cmd = spec.get("command")
    if isinstance(cmd, (list, tuple)) and cmd:
        got["command"] = [str(x) for x in cmd]
    env = spec.get("env")
    if isinstance(env, dict):
        got["env"] = {str(k): (None if v is None else str(v)) for k, v in env.items()}
    timeout = spec.get("timeout")
    if isinstance(timeout, (int, float)) and not isinstance(timeout, bool) and timeout > 0:
        got["timeout"] = int(timeout)
    models = spec.get("models")
    if isinstance(models, dict):
        got["models"] = dict(models)
    elif isinstance(models, (list, tuple)) and models:  # a profile written with the legacy harness.models argv
        got["models"] = {"command": [str(x) for x in models]}
    return got


def _legacy_spec(cfg):
    """The legacy harness object, when it can do something: a command, a models argv, or a modelList. An object with
    none of them is ignored, so Claude Code runs as when no harness is configured (0.15 ran it too)."""
    legacy = cfg.get("harness")
    if not isinstance(legacy, dict):
        return None
    for key in ("command", "models", "modelList"):
        got = legacy.get(key)
        if isinstance(got, (list, tuple)) and got:
            return legacy
    return None


def _legacy(spec):
    """A legacy harness object as the profile named "harness": harness.command is its command, harness.models an argv
    that prints ids, harness.modelList a shortlist, harness.prefix a filter."""
    got = _entry({"name": "harness", "label": "harness", "command": None, "env": {}, "timeout": None, "models": {},
                  "builtin": False}, {k: v for k, v in spec.items() if k not in ("models", "modelList", "prefix")})
    models = {}
    cmd = spec.get("models")
    if isinstance(cmd, (list, tuple)) and cmd:
        models["command"] = [str(x) for x in cmd]
    if isinstance(spec.get("prefix"), str) and spec["prefix"]:
        models["prefix"] = spec["prefix"]
    listed = spec.get("modelList")
    if isinstance(listed, (list, tuple)) and listed:
        models["shortlist"] = list(listed)
    got["models"] = models
    return got


def profiles():
    """Every harness profile by name: the built-in "claude", config `harnesses`, and a legacy `harness` object with a
    command as "harness". A broken entry is kept with what it has; a bad config never raises."""
    cfg = config()
    got = {"claude": dict(BUILTIN)}
    named = cfg.get("harnesses")
    for name, spec in (named.items() if isinstance(named, dict) else ()):
        if isinstance(name, str) and name:
            base = got.get(name) or {"name": name, "label": name, "command": None, "env": {}, "timeout": None,
                                     "models": {}, "builtin": False}
            got[name] = _entry(base, spec)
    legacy = _legacy_spec(cfg)
    if legacy is not None:
        got["harness"] = _legacy(legacy)
    return got


def active():
    """The active profile's name: config `harness` when it is a string, a legacy harness object that can do something
    as "harness", else the built-in "claude"."""
    harness = config().get("harness")
    if isinstance(harness, str):
        return harness
    return "harness" if _legacy_spec(config()) is not None else "claude"


def _is_legacy(prof):
    """Whether a profile is the legacy harness object, the only no-command profile that runs Claude Code (0.15 did)."""
    return prof["name"] == "harness" and _legacy_spec(config()) is not None


def _profile_arg(given):
    """A caller's argument as a profile: a profile dict as it is, a name looked up, None the active profile."""
    return given if isinstance(given, dict) else profile(given)


def profile(name=None):
    """The profile named `name` (default: the active one), as {name, label, command, env, timeout, models, builtin}."""
    known = profiles()
    want = active() if name is None else name
    if isinstance(want, str) and want in known:
        return known[want]
    raise RunFailed("Harness", f"No harness profile is named {want!r}. Known profiles: {', '.join(sorted(known))}.",
                    "harness", {})


def harness():
    """The active profile's argv with {model} and {prompt} placeholders, or None for the built-in Claude: the prompt is
    appended when the command has no {prompt}."""
    got = profile()
    return list(got["command"]) if got["command"] and not got["builtin"] else None


def harness_label():
    """The active profile's label, for sentences."""
    try:
        return profile()["label"]
    except RunFailed:
        return str(active())


def harness_argv(cmd, model, prompt):
    """The command with {model} and {prompt} filled in; a {model} with no model chosen leaves no argument."""
    args = [a.replace("{model}", model or "").replace("{prompt}", prompt) for a in cmd]
    if not any("{prompt}" in a for a in cmd):
        args.append(prompt)
    return [a for a in args if a != ""]


def json_in(text):
    """The JSON object an answer carries: the text itself, else the first object in it (a fence, a sentence around
    it). Claude's {answer} wrapper is unwrapped; any other object is the answer itself."""
    text = str(text or "").strip()
    try:
        got = json.loads(text)
        return (got["answer"] if isinstance(got, dict) and set(got) == {"answer"} else got) if isinstance(got, dict) else None
    except ValueError:
        pass
    dec = json.JSONDecoder()
    for i, ch in enumerate(text):
        if ch != "{":
            continue
        try:
            got, _ = dec.raw_decode(text, i)
        except ValueError:
            continue
        if isinstance(got, dict):
            return got["answer"] if set(got) == {"answer"} else got
    return None


def run_harness(feature, prompt, *, context=None, model="", schema=None, system=None, timeout=180, cwd=None, meta=None,
                profile=None):
    """Runs a harness profile's command and reads its answer: the JSON object it prints (with a schema) or its text.
    No cost or token count is reported for a command the mod does not own. The built-in Claude profile is not a
    harness: it runs through claude()."""
    prof = _profile_arg(profile)
    label, cmd = prof["label"], prof["command"]
    if prof["builtin"]:
        raise RunFailed(feature, f"No harness is configured: {label} runs through its own command. Set harness in "
                                "pr-review.config.json to a profile.", "harness", {})
    if not cmd:
        raise RunFailed(feature, f"No command is configured for {label}. Set its command in pr-review.config.json.",
                        "harness", {})
    if any("{model}" in a for a in cmd) and not model:
        raise RunFailed(feature, f"Choose a model for {label}: its command needs one ({cmd[0]} has {{model}}).",
                        "model", {})
    text = f"{system}\n\n{prompt}" if system else prompt
    if schema is not None:
        text += "\n\nAnswer with one JSON object and nothing else, matching this schema:\n" + json.dumps(schema)
    # A harness has no cost cap, so its own timeout (config harness.timeout, in seconds) may be longer than a CLI's.
    alive = int(prof.get("timeout") or timeout)
    try:
        run_env = env_for(context, profile=prof)
    except MissingEnv as e:
        raise RunFailed(feature, f"{label} needs the environment variable {e.name}, and it is not set. Export it and "
                                "try again.", "harness", {}) from None
    started = time.monotonic()
    try:
        out = subprocess.run(harness_argv(cmd, model, text), capture_output=True, text=True, timeout=alive,
                             env=run_env, cwd=str(cwd or APP))
    except subprocess.TimeoutExpired:
        raise RunFailed(feature, f"{label} did not answer within {alive} s. Try again.", "timeout", {}) from None
    except FileNotFoundError:
        raise RunFailed(feature, f"The command for {label} ({cmd[0]!r}) was not found. Check its command in "
                                "pr-review.config.json.", "harness", {}) from None
    except OSError as e:
        raise RunFailed(feature, f"The command for {label} could not start ({e}). Check it in "
                                "pr-review.config.json.", "harness", {}) from None
    ms = int((time.monotonic() - started) * 1000)
    log(feature, (context or {}).get("id") or "default", model or "harness", 0, 0, ms, out.returncode == 0, tool="harness")
    if out.returncode != 0:
        said = (out.stderr or out.stdout or "").strip().splitlines()
        raise RunFailed(feature, f"{label} failed: {quote(said[0] if said else f'exit {out.returncode}', 200)}. "
                                "Choose another model, or check its command in pr-review.config.json.", "harness",
                     {"stderr": (out.stderr or "")[:2000]})
    got = json_in(out.stdout)
    if meta is not None:
        meta.update(cost=None, tokens=0, usage={}, ms=ms, model_id=model or "harness", result=got, text=out.stdout)
    if schema is not None:
        if got is None:
            raise RunFailed(feature, f"The answer from {label} could not be read "
                                    f"({quote(' '.join(out.stdout.split()), 100)}). It must print one JSON object.",
                            "unreadable", {"stdout": out.stdout[:2000]})
        return got
    return got if got is not None else out.stdout

def config():
    try:
        got = json.loads(CONFIG.read_text())
    except (OSError, ValueError):
        return {}
    return got if isinstance(got, dict) else {}


def language():
    return config().get("language") or "English"


def ledger_dir():
    path = config().get("ledger")
    return pathlib.Path(os.path.expanduser(path)) if path else None


# What a model run gets from the window's environment: an allowlist, everything else is dropped (API keys, passwords,
# tokens, SSH_AUTH_SOCK, GIT_*, cloud and GitHub credentials: a model reads the PR's text and can run allowed commands).
# Kept: what a CLI needs to start (KEEP), locale and XDG folders, proxy and CA settings, the run's own login (LOGIN:
# CLAUDE_*, ANTHROPIC_*, e.g. CLAUDE_CODE_OAUTH_TOKEN; CODEX_LOGIN for a Codex run), the cloud login when Claude runs
# on Bedrock (AWS_*) or Vertex (GOOGLE_*, CLOUD_ML_*), and whatever the context sets itself.
KEEP = {"PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TZ", "TMPDIR", "TERM", "COLORTERM", "NO_COLOR", "__CF_USER_TEXT_ENCODING",
        "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"}
KEEP_PREFIX = ("LC_", "XDG_")
LOGIN = re.compile(r"^(CLAUDE_|ANTHROPIC_)")
CODEX_LOGIN = re.compile(r"^(CODEX_|OPENAI_)")
CLOUD = {"CLAUDE_CODE_USE_BEDROCK": ("AWS_",), "CLAUDE_CODE_USE_VERTEX": ("GOOGLE_", "CLOUD_ML_")}


READ_ENV = re.compile(r"^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$")


def _env_values(env):
    """A profile's env with "${VAR}" read from os.environ, None kept as an unset. MissingEnv when a variable is unset."""
    got = {}
    for k, v in (env or {}).items():
        if v is None:
            got[str(k)] = None
        elif isinstance(v, str):
            m = READ_ENV.match(v)
            if m:
                if m.group(1) not in os.environ:
                    raise MissingEnv(m.group(1))
                got[str(k)] = os.environ[m.group(1)]
            else:
                got[str(k)] = os.path.expanduser(v)
        else:
            got[str(k)] = str(v)
    return got


def env_for(context, login=LOGIN, profile=None):
    """The process env reduced to the allowlist above (login: whose login stays), then the profile's env, then the
    context's (None unsets; the context is more specific). `profile` is a profile dict; None adds no profile env.
    git refuses abbreviated long options in every run: a model's `git blame --con` would else be --contents, past a
    rule that denies the full name."""
    mine = (context or {}).get("env") or {}
    on = lambda flag: str(mine.get(flag, os.environ.get(flag, ""))).lower() not in ("", "0", "false")  # noqa: E731
    cloud = tuple(p for flag, prefixes in CLOUD.items() if on(flag) for p in prefixes)
    keep = lambda k: k.upper() in KEEP or k.startswith(KEEP_PREFIX) or bool(login.match(k)) or k.startswith(cloud)  # noqa: E731
    env = {**{k: v for k, v in os.environ.items() if keep(k)}, "GIT_TEST_DISALLOW_ABBREVIATED_OPTIONS": "1"}
    for k, v in _env_values(_profile_arg(profile).get("env") if profile else {}).items():
        if v is None:
            env.pop(k, None)
        else:
            env[k] = v
    for k, v in mine.items():
        if v is None:
            env.pop(k, None)
        else:
            env[k] = os.path.expanduser(str(v))
    return env


def log(feature, context_id, model, cost, tokens=0, ms=0, ok=True, tool="claude"):
    """One ledger line, only when a ledger folder is configured. `account` holds the context id."""
    folder = ledger_dir()
    if not folder:
        return
    folder.mkdir(parents=True, exist_ok=True)
    now = dt.datetime.now().astimezone()
    line = json.dumps({"at": now.isoformat(timespec="seconds"), "feature": feature, "account": context_id, "model": model,
                       "cost": round(float(cost or 0), 6), "tokens": int(tokens or 0), "ms": int(ms), "ok": ok, "tool": tool})
    with open(folder / f"usage-{now:%Y-%m}.jsonl", "a", encoding="utf-8") as f:  # one short O_APPEND write per call
        f.write(line + "\n")
    for old in sorted(folder.glob("usage-*.jsonl"))[:-KEEP_MONTHS]:
        old.unlink(missing_ok=True)


def tier(model):
    """A model's budget class for the caps: haiku, sonnet, or opus (the bigger ones, and any model not named)."""
    m = str(model or "").lower()
    return "haiku" if "haiku" in m else "sonnet" if "sonnet" in m else "opus"


def code_model(model):
    """The model for a call that reads or judges code: at least sonnet. Haiku is fine for text (triage, turning a
    reviewer's prose into findings) but too weak to reason about code, so a passed haiku (an old caller) becomes sonnet."""
    return "sonnet" if not model or tier(model) == "haiku" else model


def parse(stdout):
    """What `claude -p` printed, as its result object: the JSON itself (--output-format json), or a stream's result
    line (stream-json). A slash command may run as a fork and answer there: the result then is only "Command
    completed" without structured_output, so the stream's last StructuredOutput call counts as the answer, and
    `text` holds what forks and subagents wrote (a review given as text)."""
    try:
        data = json.loads(stdout)
        return data if isinstance(data, dict) else {}
    except ValueError:
        pass
    events = []
    for line in stdout.splitlines():
        try:
            events.append(json.loads(line))
        except ValueError:
            continue
    events = [e for e in events if isinstance(e, dict)]
    data = next((e for e in reversed(events) if e.get("type") == "result"), {})
    said = [(e.get("parent_tool_use_id"), c) for e in events if e.get("type") == "assistant"
            for c in (e.get("message") or {}).get("content") or [] if isinstance(c, dict)]
    calls = [c.get("input") for _, c in said if c.get("type") == "tool_use" and c.get("name") == "StructuredOutput"]
    if data and data.get("structured_output") is None and calls:
        data["structured_output"] = calls[-1]
    if data:
        data["text"] = "\n\n".join(c["text"] for parent, c in said if parent and c.get("type") == "text" and c.get("text"))
    return data


class RunFailed(RuntimeError):
    """A model run that gave no answer. str(): "<feature>: <one sentence: what happened, what the CLI said, what to
    do>", for the person. kind: limit | login | model | budget | turns | timeout | stopped | empty | unreadable | other.
    detail: what the CLI printed, for a "Details" fold; never shown in the sentence's place."""

    def __init__(self, feature, sentence, kind, detail=""):
        super().__init__(f"{feature}: {sentence}")
        self.kind, self.detail = kind, detail


def failed(e, limit=500):
    """What a run's status file says of an exception: {error: the sentence}, and for a RunFailed its kind and what
    the CLI printed (detail), for a "Details" fold."""
    more = {"kind": e.kind, "detail": str(e.detail or "")[:2000]} if isinstance(e, RunFailed) else {}  # detail may be a dict
    return {"error": str(e)[:limit], **more}


def failure(feature, returncode, stdout, stderr, data=None, *, model=None, timeout=None):
    """The RunFailed of a `claude -p` call that failed, from what it left: its exit code, what it printed, the parsed
    result object (parse) and, for a call that was stopped for taking too long, the seconds it had. The CLI's own
    message is in the result object's `result` (or error.message); the object itself goes to `detail` only."""
    data = data if isinstance(data, dict) else {}
    err, raw = (stderr or "").strip(), (stdout or "").strip()
    detail = (raw or err)[:4000]
    spent = sum((data.get("usage") or {}).get(k) or 0 for k in ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"))
    said = data.get("result") if isinstance(data.get("result"), str) else ""
    if not said and isinstance(data.get("error"), dict):
        said = str(data["error"].get("message") or "")
    said = said or str(data.get("message") or data.get("error") or "")
    said = " ".join((said or err).split())
    tail = re.match(r"^(.*?)\s*(\{.*\})$", said)  # 'API Error: 404 {"type":"error","error":{"message":"model: x"}}': its message
    if tail:
        try:
            inner = json.loads(tail.group(2))
            inner = inner.get("error") if isinstance(inner.get("error"), dict) else inner
            said = f"{tail.group(1).rstrip(': ')}: {inner.get('message')}" if inner.get("message") else said
        except (ValueError, AttributeError):
            pass
    said = said.rstrip(". ")
    low, subtype = said.lower(), str(data.get("subtype") or "")
    how = "ended at once without an answer" if not spent else "failed"
    if timeout is not None:
        return RunFailed(feature, f"The run took longer than {int(timeout)} s and was stopped. Try again, or choose a faster model.", "timeout", detail)
    if "usage limit" in low or "hit your limit" in low or "rate limit" in low or "credit balance" in low or "quota" in low:
        m = re.search(r"\|(\d{10})\b", said)  # "Claude AI usage limit reached|1794700000": when it resets
        when = f" It resets at {dt.datetime.fromtimestamp(int(m.group(1))).strftime('%H:%M')}." if m else ""
        told = quote(re.sub(r"\|\d{10}\b", "", said).rstrip(". "))
        return RunFailed(feature, f"The run {how}: {told}.{when} Choose another model or try again later.", "limit", detail)
    if "/login" in low or "api key" in low or "not logged in" in low or "authentication" in low or "unauthorized" in low or "oauth" in low:
        return RunFailed(feature, f"The run {how}: Claude Code is not signed in for this context ({quote(said)}). Run `claude` in a terminal, sign in, and try again.", "login", detail)
    if "model" in low and any(w in low for w in ("not exist", "not found", "not_found", "may not have access", "not available", "invalid model", "unknown model", "not supported", "404")):
        return RunFailed(feature, f"The run {how}: the model{f' {model}' if model else ''} is not available here ({quote(said)}). Choose another model.", "model", detail)
    if subtype == "error_max_budget_usd" or "maximum budget" in low:
        return RunFailed(feature, f"The run stopped at its cost cap before it had an answer{f' ({quote(said)})' if said else ''}. Try again, or choose another model.", "budget", detail)
    if subtype == "error_max_turns":
        return RunFailed(feature, "The run used all its turns without an answer. Try again.", "turns", detail)
    if returncode is not None and (returncode < 0 or returncode in (130, 137, 143)):
        return RunFailed(feature, "The run was stopped before it answered. Try again.", "stopped", detail)
    if said:
        return RunFailed(feature, f"The run {how}: {quote(said)}. Choose another model or try again.", "other", detail)
    if not raw and not err:
        return RunFailed(feature, f"The run ended without any output (exit code {returncode}). Try again.", "empty", detail)
    if not data:
        return RunFailed(feature, f"The run's answer could not be read (it starts with: {quote(' '.join(raw.split()), 80)}). Try again.", "unreadable", detail)
    return RunFailed(feature, f"The run {how} and gave no reason (exit code {returncode}). Choose another model or try again.", "other", detail)


def claude(feature, prompt, *, context=None, model="sonnet", schema=None, system=None, budget=0.2,
           timeout=180, tools="", cwd=None, extra=(), meta=None, skills=False):
    """Runs `claude -p`, records the call, returns structured_output (with a schema) or the result text.
    meta: a dict that gets {cost, tokens, usage ({input, output, cache_read, cache_write} tokens), ms, model_id,
    result, text} of the call, for callers that show them.
    skills: keep skills and slash commands (a prompt like "/code-review medium 12") and read the run as a stream, since
    such a command may answer in a fork (parse); everything else stays lean."""
    prof = profile()
    if not prof["builtin"]:
        if prof["command"]:
            return run_harness(feature, prompt, context=context, model=model, schema=schema, system=system,
                               timeout=timeout, cwd=cwd, meta=meta, profile=prof)
        if not _is_legacy(prof):  # a named profile without a command must not run another provider's CLI
            raise RunFailed(feature, f"No command is configured for {prof['label']}: set its command in "
                                    "pr-review.config.json.", "harness", {})
    try:
        run_env = env_for(context, profile=prof)
    except MissingEnv as e:
        raise RunFailed(feature, f"{prof['label']} needs the environment variable {e.name}, and it is not set. "
                                "Export it and try again.", "harness", {}) from None
    lean = [a for a in LEAN if not (skills and a == "--disable-slash-commands")]
    if skills:
        lean = ["stream-json" if a == "json" else a for a in lean] + ["--verbose"]  # stream-json needs --verbose with -p
    args = ["claude", "-p", "--model", model, *lean, "--max-budget-usd", str(budget)]
    if tools is not None:
        args += ["--tools", tools]
    if schema is not None:
        # The whole answer under one top-level property. With many of them the model mixes the tool call's own syntax
        # into the JSON of nested objects, the call does not parse and the whole answer is sent again (seen in every
        # watched analysis, one to three times: a third of the price and a minute each).
        args += ["--json-schema", json.dumps({"type": "object", "required": ["answer"], "properties": {"answer": schema}})]
    if system:
        args += ["--system-prompt", system]
    started = time.monotonic()
    for attempt in (1, 2):  # ponytail: one retry covers the moment a Claude Code self-update swaps the binary
        try:
            out = subprocess.run([*args, *extra], input=prompt, capture_output=True, text=True, timeout=timeout,
                                 env=run_env, cwd=str(cwd or APP))
            break
        except subprocess.TimeoutExpired as e:
            raise failure(feature, None, e.stdout if isinstance(e.stdout, str) else "", e.stderr if isinstance(e.stderr, str) else "", model=model, timeout=timeout) from None
        except FileNotFoundError:
            if attempt == 2:
                raise RuntimeError(f"{feature}: the claude command was not found on PATH") from None
            time.sleep(3)
    ms = (time.monotonic() - started) * 1000
    data = parse(out.stdout)
    usage = data.get("usage") or {}
    parts = {"input": "input_tokens", "output": "output_tokens", "cache_read": "cache_read_input_tokens", "cache_write": "cache_creation_input_tokens"}
    tokens = sum(usage.get(k) or 0 for k in parts.values())
    ok = out.returncode == 0 and not data.get("is_error")
    log(feature, (context or {}).get("id") or "default", model, data.get("total_cost_usd") or 0, tokens, int(ms), ok)
    if meta is not None:
        meta.update(cost=data.get("total_cost_usd"), tokens=tokens, usage={k: usage.get(v) or 0 for k, v in parts.items()}, ms=int(ms), model_id=next(iter(data.get("modelUsage") or {}), model),
                    result=data.get("result"), text=data.get("text") or "")
    if not ok:  # one sentence for the person, never the result object itself (failure)
        raise failure(feature, out.returncode, out.stdout, out.stderr, data, model=model)
    return (data.get("structured_output") or {}).get("answer") if schema is not None else data.get("result")
