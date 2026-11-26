"""Run: python3 test_models.py  (models.py's parsing and llm.tier, without calling a CLI or reaching the network)."""
import io
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

import llm
import models

claude = models.claude_list([
    {"value": "default", "resolvedModel": "claude-fable-5-2", "displayName": "Default (recommended)"},
    {"value": "opus", "resolvedModel": "claude-opus-5-5", "displayName": "Opus 5.5", "description": "Complex work"},
    {"value": "claude-haiku-4-5-20251001", "displayName": "Haiku 4.5"},
    {"displayName": "no value"},
])
assert [m["value"] for m in claude] == ["opus", "claude-haiku-4-5-20251001"], claude  # "default" names another entry
assert claude[0] == {"value": "opus", "label": "Opus 5.5", "description": "Complex work", "resolved": "claude-opus-5-5"}
assert claude[1]["resolved"] == "claude-haiku-4-5-20251001" and claude[1]["description"] == ""

codex = models.codex_list({"models": [
    {"slug": "b", "display_name": "B", "visibility": "list", "priority": 3},
    {"slug": "hidden", "visibility": "hide", "priority": 1},
    {"slug": "a", "display_name": "A", "description": "fast", "visibility": "list", "priority": 2},
]})
assert codex == [{"value": "a", "label": "A", "description": "fast"}, {"value": "b", "label": "B", "description": ""}], codex
assert models.codex_list(None) == [] and models.claude_list(None) == []

assert [llm.tier(m) for m in ("haiku", "claude-haiku-4-5", "sonnet", "claude-sonnet-5", "opus", "fable", "claude-fable-5-1", None)] == \
    ["haiku", "haiku", "sonnet", "sonnet", "opus", "opus", "opus", "opus"]

# ---- provider catalogs: HTTP against a stubbed opener, cached under llm.APP, and never a raise
home = tempfile.TemporaryDirectory()
llm.APP = pathlib.Path(home.name)
llm.CONFIG = llm.APP / "pr-review.config.json"
CACHE = llm.APP / "pr-data" / "providers.json"
asked = []


class Answer:
    def __init__(self, body):
        self.body = body

    def read(self):
        return self.body if isinstance(self.body, bytes) else json.dumps(self.body).encode()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def opener(body=None, error=None):
    def open_(req, timeout=None):
        asked.append((req, timeout))
        if error is not None:
            raise error
        return Answer(body)
    return open_


PROVIDERS = {"providers": {
    "gw": {"label": "LLM Gateway", "kind": "openai", "baseUrl": "https://gateway.example/v1", "apiKeyEnv": "PR_REVIEW_GW_KEY"},
    "claudeish": {"label": "Claude gateway", "kind": "anthropic", "baseUrl": "https://gateway.example", "apiKeyEnv": "PR_REVIEW_GW_KEY"},
    "or": {"label": "OpenRouter", "kind": "openrouter", "baseUrl": "https://openrouter.example/api/v1"},
    "priced": {"label": "Priced", "kind": "openai", "baseUrl": "https://gateway.example/v1",
               "priceOverrides": {"anthropic/claude-sonnet-5-5": [2, 10]}},
    "nokey": {"label": "No key", "kind": "openai", "baseUrl": "https://gateway.example/v1", "apiKeyEnv": "PR_REVIEW_NOPE"},
    "odd": {"label": "Odd", "kind": "openai", "baseUrl": "https://odd.example"},
}}


def headers_of(req):
    return {k.lower(): v for k, v in req.headers.items()}


real_open, real_run, real_popen = urllib.request.urlopen, subprocess.run, subprocess.Popen
saved_env = {k: os.environ.get(k) for k in ("PR_REVIEW_GW_KEY", "PR_REVIEW_NOPE", "PR_REVIEW_MODELS_KEY", "PR_REVIEW_MODELS_MISSING")}
os.environ["PR_REVIEW_GW_KEY"] = "secret"
os.environ.pop("PR_REVIEW_NOPE", None)
llm.CONFIG.write_text(json.dumps(PROVIDERS))
try:
    # openai: GET baseUrl/models, the key from os.environ, its name as the description.
    urllib.request.urlopen = opener({"data": [{"id": "anthropic/one", "name": "One"}]})
    got, error = models.provider_models("gw")
    assert error is None and got == [{"value": "anthropic/one", "label": "One", "description": "LLM Gateway"}], (got, error)
    req, timeout = asked[-1]
    assert req.full_url == "https://gateway.example/v1/models" and timeout == 8, (req.full_url, timeout)
    assert headers_of(req)["authorization"] == "Bearer secret" and headers_of(req)["user-agent"] == "pr-review"

    # A young cache answers again without a request.
    before = len(asked)
    got, error = models.provider_models("gw")
    assert got == [{"value": "anthropic/one", "label": "One", "description": "LLM Gateway"}] and error is None
    assert len(asked) == before, "a cached catalog made a request"

    # anthropic: the key in x-api-key, with the API version.
    urllib.request.urlopen = opener({"data": [{"id": "claude-x", "display_name": "Claude X"}]})
    got, error = models.provider_models("claudeish")
    assert error is None and got[0]["label"] == "Claude X" and got[0]["description"] == "Claude gateway"
    assert headers_of(asked[-1][0])["x-api-key"] == "secret" and headers_of(asked[-1][0])["anthropic-version"] == "2023-06-01"

    # OpenRouter: no key needed, and its per-token pricing becomes USD per million tokens.
    urllib.request.urlopen = opener({"data": [{"id": "vendor/model", "name": "Model",
                                               "pricing": {"prompt": "0.000003", "completion": "0.000015"}}]})
    got, error = models.provider_models("or")
    assert error is None and got[0]["price"] == [3.0, 15.0], (got, error)
    assert "authorization" not in headers_of(asked[-1][0])

    # priceOverrides win over the catalog.
    urllib.request.urlopen = opener({"data": [{"id": "anthropic/claude-sonnet-5-5", "name": "Sonnet"}]})
    got, error = models.provider_models("priced")
    assert error is None and got[0]["price"] == [2.0, 10.0], got

    # apiKeyEnv set and its variable empty: no request, one sentence for the person.
    before = len(asked)
    got, error = models.provider_models("nokey")
    assert got == [] and error == "Its API key is not set: export PR_REVIEW_NOPE." and len(asked) == before, (got, error)

    # A body in another shape: an error, not a raise.
    urllib.request.urlopen = opener({"models": []})
    got, error = models.provider_models("odd")
    assert got == [] and error == "Odd answered in a shape pr-review does not know.", (got, error)

    # A stale cache plus a failed request: the cached models stay, with the reason.
    doc = json.loads(CACHE.read_text())
    doc["gw"]["at"] = int(time.time()) - 7 * 3600
    CACHE.write_text(json.dumps(doc))
    urllib.request.urlopen = opener(error=urllib.error.URLError("no route to host"))
    got, error = models.provider_models("gw")
    assert got == [{"value": "anthropic/one", "label": "One", "description": "LLM Gateway"}], got
    assert error == "LLM Gateway did not answer: no route to host.", error
    before = len(asked)
    got, error = models.provider_models("gw")
    assert error == "LLM Gateway did not answer: no route to host." and len(asked) == before, "the failure was not cached"

    # An error is retired after a minute: the next call asks again, and a success clears it.
    doc = json.loads(CACHE.read_text())
    doc["gw"]["at"] = int(time.time()) - 61
    CACHE.write_text(json.dumps(doc))
    urllib.request.urlopen = opener({"data": [{"id": "anthropic/one", "name": "One"}]})
    before = len(asked)
    got, error = models.provider_models("gw")
    assert len(asked) == before + 1 and error is None and got[0]["value"] == "anthropic/one", (len(asked) - before, error)
    assert json.loads(CACHE.read_text())["gw"]["error"] is None, "a success left the old error in the cache"

    # A success keeps its six hours: a minute later it still answers without a request.
    doc = json.loads(CACHE.read_text())
    doc["gw"]["at"] = int(time.time()) - 61
    CACHE.write_text(json.dumps(doc))
    before = len(asked)
    got, error = models.provider_models("gw")
    assert len(asked) == before and error is None and got[0]["value"] == "anthropic/one", "a 60 s-old success was fetched again"

    # ---- harness_models: shortlist, provider + prefix + deny, command, and nothing
    short = {"name": "s", "label": "Short", "command": ["x"], "env": {}, "timeout": None, "builtin": False,
             "models": {"shortlist": [{"id": "anthropic/a", "price": [1, 2]}, "b"]}}
    got, error = models.harness_models(short)
    assert error is None and got[0] == {"value": "anthropic/a", "label": "anthropic/a", "description": "Short", "price": [1.0, 2.0]}, got
    assert got[1] == {"value": "b", "label": "b", "description": "Short"}, got[1]

    llm.CONFIG.write_text(json.dumps({"providers": {"menu": {"label": "Menu", "kind": "openai", "baseUrl": "https://menu.example"}}}))
    urllib.request.urlopen = opener({"data": [{"id": "anthropic/one"}, {"id": "anthropic/tiny-mini"}, {"id": "other/two"}]})
    got, error = models.harness_models({"label": "Menu", "models": {"provider": "menu", "prefix": "anthropic/", "deny": ["*-mini"]}})
    assert [m["value"] for m in got] == ["anthropic/one"] and error is None, (got, error)

    subprocess.run = lambda args, **kw: subprocess.CompletedProcess(args, 0, "g/one\nother/two\ng/three\n", "")
    got, error = models.harness_models({"label": "G", "models": {"command": ["list-models"], "prefix": "g/"}})
    assert [m["value"] for m in got] == ["g/one", "g/three"] and error is None, (got, error)
    assert got[0]["description"] == "G"

    assert models.harness_models({"label": "None", "models": {}}) == ([], None)

    # ---- harnesses: the built-in Claude Code first, then every declared profile, with whether its program is on PATH
    llm.CONFIG.write_text(json.dumps({"harnesses": {"here": {"label": "Here", "command": ["/bin/sh", "-c", "true"]},
                                                    "gone": {"label": "Gone", "command": ["pr-review-no-such-program"]}}}))
    real_which = shutil.which
    try:
        shutil.which = lambda name: name if name in ("claude", "/bin/sh") else None
        got = models.harnesses()
        assert [(h["name"], h["label"], h["command"], h["ok"], h["builtin"]) for h in got] == [
            ("claude", "Claude Code", "claude -p --model {model}", True, True),
            ("here", "Here", "/bin/sh -c true", True, False),
            ("gone", "Gone", "pr-review-no-such-program", False, False)], got
        # The built-in's ok follows the claude program on PATH, so the picker can get back to it.
        shutil.which = lambda name: None
        assert models.harnesses()[0]["ok"] is False
        shutil.which = lambda name: "/usr/bin/claude" if name == "claude" else None
        assert models.harnesses()[0]["ok"] is True
    finally:
        shutil.which = real_which

    # ---- claude_models: the CLI runs with the claude profile's env, so a gateway's catalog is the one listed
    class Proc:
        def __init__(self, answer):
            self.stdin = io.StringIO()
            self.stdout = iter([json.dumps(answer) + "\n"])

        def kill(self):
            pass

    started = []

    def popen(args, **kw):
        started.append((args, kw))
        return Proc({"type": "control_response",
                     "response": {"request_id": "models", "response": {"models": [{"value": "opus", "displayName": "Opus"}]}}})

    os.environ["PR_REVIEW_MODELS_KEY"] = "secret"
    os.environ.pop("PR_REVIEW_MODELS_MISSING", None)
    llm.CONFIG.write_text(json.dumps({"harnesses": {"claude": {"env": {
        "ANTHROPIC_BASE_URL": "https://gateway.example",
        "ANTHROPIC_API_KEY": "${PR_REVIEW_MODELS_KEY}"}}}}))
    subprocess.Popen = popen
    got = models.claude_models(None)
    assert [m["value"] for m in got] == ["opus"], got
    assert started[-1][1]["env"]["ANTHROPIC_BASE_URL"] == "https://gateway.example", "the claude profile's env reaches the CLI"
    assert started[-1][1]["env"]["ANTHROPIC_API_KEY"] == "secret"

    # A ${VAR} the profile reads but that is not set: no process, an empty list.
    llm.CONFIG.write_text(json.dumps({"harnesses": {"claude": {"env": {"ANTHROPIC_API_KEY": "${PR_REVIEW_MODELS_MISSING}"}}}}))
    before = len(started)
    assert models.claude_models(None) == [] and len(started) == before, "a missing variable started the CLI"
finally:
    urllib.request.urlopen, subprocess.run, subprocess.Popen = real_open, real_run, real_popen
    for name, value in saved_env.items():
        if value is None:
            os.environ.pop(name, None)
        else:
            os.environ[name] = value
    home.cleanup()
print("ok")
