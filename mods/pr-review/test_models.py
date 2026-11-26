"""Run: python3 test_models.py  (models.py's parsing and llm.tier, without calling a CLI or reaching the network)."""
import contextlib
import io
import json
import os
import pathlib
import shutil
import subprocess
import sys
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
    assert error is None and got == [{"id": "anthropic/one", "value": "anthropic/one", "label": "One",
                                     "description": "LLM Gateway"}], (got, error)
    req, timeout = asked[-1]
    assert req.full_url == "https://gateway.example/v1/models" and timeout == 8, (req.full_url, timeout)
    assert headers_of(req)["authorization"] == "Bearer secret" and headers_of(req)["user-agent"] == "pr-review"

    # A young cache answers again without a request.
    before = len(asked)
    got, error = models.provider_models("gw")
    assert got == [{"id": "anthropic/one", "value": "anthropic/one", "label": "One", "description": "LLM Gateway"}]
    assert error is None
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
    assert got == [{"id": "anthropic/one", "value": "anthropic/one", "label": "One", "description": "LLM Gateway"}], got
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

    # ---- a catalog is cached raw: a changed modelId, prefix or deny re-maps it, with no second request
    ROWS = {"data": [
        {"id": "google/gemini-3", "display_name": "Gemini 3", "family": "google",
         "pricing": {"prompt": "0.000002", "completion": "0.000010"}},
        {"id": "openai/gpt-6", "name": "GPT 6", "family": "openai",
         "pricing": {"prompt": "0.000001", "completion": "0.000004"}},
        {"id": "vendor/text-1", "name": "Text 1", "family": "vendor",
         "architecture": {"output_modalities": ["text"]}},
        {"id": "vendor/image-1", "name": "Image 1", "family": "vendor",
         "architecture": {"output_modalities": ["image"]}},
        {"id": "vendor/embed-1", "name": "Embed 1", "family": "vendor",
         "architecture": {"output_modalities": ["embedding"]}},
    ]}
    llm.CONFIG.write_text(json.dumps({"providers": {"raw": {
        "label": "Raw", "kind": "openai", "baseUrl": "https://raw.example/v1", "modelId": "runner/{family}/{id}"}}}))
    before = len(asked)
    urllib.request.urlopen = opener(ROWS)
    got, error = models.provider_models("raw")
    assert len(asked) == before + 1 and error is None, (len(asked) - before, error)
    assert [m["id"] for m in got] == ["google/gemini-3", "openai/gpt-6", "vendor/text-1"], got  # no image or embedding
    assert [m["value"] for m in got] == ["runner/google/google/gemini-3", "runner/openai/openai/gpt-6",
                                         "runner/vendor/vendor/text-1"], got
    # Pricing is read for kind "openai" too: per token becomes USD per million; the row's own name is the label.
    assert got[0] == {"id": "google/gemini-3", "value": "runner/google/google/gemini-3", "label": "Gemini 3",
                      "description": "Raw", "price": [2.0, 10.0]}, got[0]
    assert got[1]["label"] == "GPT 6" and "price" not in got[2], got[1:]
    assert json.loads(CACHE.read_text())["raw"]["rows"] == ROWS["data"], "the cache does not hold the raw rows"

    def no_request(req, timeout=None):
        raise AssertionError("a mapping change made a request")

    urllib.request.urlopen = no_request
    llm.CONFIG.write_text(json.dumps({"providers": {"raw": {
        "label": "Raw", "kind": "openai", "baseUrl": "https://raw.example/v1",
        "modelId": "run/{vendor}:{id}", "prefix": "vendor/"}}}))
    got, error = models.provider_models("raw")
    assert error is None and [(m["id"], m["value"]) for m in got] == [("vendor/text-1", "run/vendor:vendor/text-1")], got
    llm.CONFIG.write_text(json.dumps({"providers": {"raw": {
        "label": "Raw", "kind": "openai", "baseUrl": "https://raw.example/v1", "deny": ["google/*"]}}}))
    got, error = models.provider_models("raw")
    assert error is None and [m["id"] for m in got] == ["openai/gpt-6", "vendor/text-1"], got

    # {family} takes the aliases, {vendor} stays the raw family, and a template without {family} ignores the aliases.
    llm.CONFIG.write_text(json.dumps({"providers": {"raw": {
        "label": "Raw", "kind": "openai", "baseUrl": "https://raw.example/v1",
        "modelId": "gw/{family}/{id}", "families": {"google": "google-ai-studio"}}}}))
    got, error = models.provider_models("raw")
    assert error is None and [m["value"] for m in got] == [
        "gw/google-ai-studio/google/gemini-3", "gw/openai/openai/gpt-6", "gw/vendor/vendor/text-1"], got
    llm.CONFIG.write_text(json.dumps({"providers": {"raw": {
        "label": "Raw", "kind": "openai", "baseUrl": "https://raw.example/v1",
        "modelId": "gw/{vendor}-{id}", "families": {"google": "google-ai-studio"}}}}))
    got, error = models.provider_models("raw")
    assert error is None and got[0]["value"] == "gw/google-google/gemini-3", got
    # No template: the runner receives the catalog id.
    llm.CONFIG.write_text(json.dumps({"providers": {"raw": {
        "label": "Raw", "kind": "openai", "baseUrl": "https://raw.example/v1"}}}))
    got, pinned, error = models.provider_catalog("raw")
    assert error is None and got[0]["value"] == "google/gemini-3" == got[0]["id"], got
    assert pinned == [], pinned  # no shortlist: no pins

    # Pricing is read for kind "anthropic" too, and priceOverrides still win over the catalog's price.
    llm.CONFIG.write_text(json.dumps({"providers": {
        "claudeprice": {"label": "Claude price", "kind": "anthropic", "baseUrl": "https://cp.example"},
        "withoverride": {"label": "Override", "kind": "openai", "baseUrl": "https://wo.example",
                         "priceOverrides": {"a/b": [2, 10]}}}}))
    PRICED = {"data": [{"id": "a/b", "name": "B", "family": "a",
                        "pricing": {"prompt": "0.000003", "completion": "0.000015"}}]}
    urllib.request.urlopen = opener(PRICED)
    got, error = models.provider_models("claudeprice")
    assert error is None and got[0]["price"] == [3.0, 15.0], (got, error)
    got, error = models.provider_models("withoverride")
    assert error is None and got[0]["price"] == [2.0, 10.0], got

    # A shortlist is a pin order, not a filter: every filtered model stays, in catalog order, and `pinned` names the
    # ids the catalog holds, in config order. An id the catalog lacks, or a row a filter drops, is neither.
    llm.CONFIG.write_text(json.dumps({"providers": {"pins": {
        "label": "Pins", "kind": "openai", "baseUrl": "https://pins.example", "modelId": "pin/{family}/{id}",
        "shortlist": ["vendor/text-1", "gone/model", {"id": "google/gemini-3", "price": [9, 11]},
                      "openai/gpt-6", "vendor/image-1", "gone/priced"]}}}))
    urllib.request.urlopen = opener(ROWS)
    got, pinned, error = models.provider_catalog("pins")
    assert error is None and pinned == ["vendor/text-1", "google/gemini-3", "openai/gpt-6"], (got, pinned, error)
    assert [m["id"] for m in got] == ["google/gemini-3", "openai/gpt-6", "vendor/text-1"], got  # the whole catalog
    assert got[0] == {"id": "google/gemini-3", "value": "pin/google/google/gemini-3", "label": "Gemini 3",
                      "description": "Pins", "price": [9.0, 11.0]}, got[0]  # the shortlist price wins
    assert got[1]["price"] == [1.0, 4.0] and got[1]["value"] == "pin/openai/openai/gpt-6", got[1]
    assert "price" not in got[2], got[2]

    # The filters apply to the whole list, pins included: a pinned id a filter drops is no pin.
    llm.CONFIG.write_text(json.dumps({"providers": {"pins": {
        "label": "Pins", "kind": "openai", "baseUrl": "https://pins.example",
        "prefix": "vendor/", "deny": ["*/image*"], "shortlist": ["openai/gpt-6", "vendor/text-1"]}}}))
    got, pinned, error = models.provider_catalog("pins")
    assert error is None and [m["id"] for m in got] == ["vendor/text-1"] and pinned == ["vendor/text-1"], (got, pinned)

    # ---- providers(): every declared provider in config order, a broken entry included, never a raise
    llm.CONFIG.write_text(json.dumps({"providers": {
        "bee": {"label": "Bee", "kind": "anthropic", "baseUrl": "https://b.example"},
        "plain": {"baseUrl": "https://a.example"},
        "broken": "not an object"}}))
    assert models.providers() == [{"name": "bee", "label": "Bee", "kind": "anthropic"},
                                  {"name": "plain", "label": "plain", "kind": "openai"},
                                  {"name": "broken", "label": "broken", "kind": "openai"}], models.providers()
    llm.CONFIG.write_text(json.dumps({}))
    assert models.providers() == []
    assert models.provider_models("plain") == ([], "plain has no baseUrl in pr-review.config.json.")

    # ---- main(): the provider asked for, else the first declared; every existing key keeps its place
    real_claude, real_codex, real_argv = models.claude_models, models.codex_models, sys.argv
    models.claude_models = lambda context, timeout=30: [{"value": "opus", "label": "Opus", "description": "",
                                                         "resolved": "opus"}]
    models.codex_models = lambda timeout=30: []

    def run_main(req):
        out = io.StringIO()
        sys.argv = ["models.py", json.dumps(req)]
        try:
            with contextlib.redirect_stdout(out):
                models.main()
        finally:
            sys.argv = real_argv
        return json.loads(out.getvalue())

    try:
        # No providers declared: provider null, providerModels empty, and today's fields as they were.
        llm.CONFIG.write_text(json.dumps({"harness": "gw", "harnesses": {
            "gw": {"label": "Gateway", "command": ["gw", "run", "--model", "{model}"]}}}))
        got = run_main({})
        assert set(got) == {"claude", "codex", "harness", "harnessName", "harnesses", "providers", "provider",
                            "providerModels", "providerError", "pinned"}, sorted(got)
        assert got["provider"] is None and got["providers"] == [] and got["providerModels"] == [], got
        assert got["providerError"] is None and got["pinned"] == [], got
        assert got["harnessName"] == "gw" and got["harness"] == [], got
        assert [h["name"] for h in got["harnesses"]] == ["claude", "gw"], got["harnesses"]
        assert [m["value"] for m in got["claude"]] == ["opus"] and got["codex"] == [], got

        # Providers declared, no argument: the first is active, and it is the only catalog fetched.
        llm.CONFIG.write_text(json.dumps({
            "harness": "gw",
            "harnesses": {"gw": {"label": "Gateway", "command": ["gw", "run", "--model", "{model}"]}},
            "providers": {"one": {"label": "One", "kind": "openai", "baseUrl": "https://one.example"},
                          "two": {"label": "Two", "kind": "openai", "baseUrl": "https://two.example"}}}))
        before = len(asked)
        urllib.request.urlopen = opener({"data": [{"id": "a/b", "name": "B", "family": "a"}]})
        got = run_main({})
        assert got["provider"] == "one" and [m["id"] for m in got["providerModels"]] == ["a/b"], got
        assert got["providerError"] is None and got["pinned"] == [], got
        assert got["providers"] == [{"name": "one", "label": "One", "kind": "openai"},
                                    {"name": "two", "label": "Two", "kind": "openai"}], got["providers"]
        assert len(asked) == before + 1 and asked[-1][0].full_url == "https://one.example/models", \
            (len(asked) - before, asked[-1][0].full_url)

        # The argument names the provider to use.
        got = run_main({"provider": "two"})
        assert got["provider"] == "two" and [m["id"] for m in got["providerModels"]] == ["a/b"], got
        assert asked[-1][0].full_url == "https://two.example/models", asked[-1][0].full_url

        # A catalog that fails: providerError carries the sentence, and providers still lists the provider.
        llm.CONFIG.write_text(json.dumps({
            "harness": "gw",
            "harnesses": {"gw": {"label": "Gateway", "command": ["gw", "run", "--model", "{model}"]}},
            "providers": {"one": {"label": "One", "kind": "openai", "baseUrl": "https://one.example"},
                          "broken": {"label": "Broken", "kind": "openai", "baseUrl": "https://broken.example"}}}))
        urllib.request.urlopen = opener(error=urllib.error.URLError("no route to host"))
        got = run_main({"provider": "broken"})
        assert got["provider"] == "broken" and got["providerModels"] == [] and got["pinned"] == [], got
        assert got["providerError"] == "Broken did not answer: no route to host.", got["providerError"]
        assert [p["name"] for p in got["providers"]] == ["one", "broken"], got["providers"]
        # The next answer clears it: a catalog in the cache has no sentence.
        got = run_main({})
        assert got["provider"] == "one" and [m["id"] for m in got["providerModels"]] == ["a/b"], got
        assert got["providerError"] is None and got["pinned"] == [], got

        # A shortlist reaches `pinned` in config order and its price wins; the entry it names stays, with the rest.
        llm.CONFIG.write_text(json.dumps({
            "harness": "gw",
            "harnesses": {"gw": {"label": "Gateway", "command": ["gw", "run", "--model", "{model}"]}},
            "providers": {"one": {"label": "One", "kind": "openai", "baseUrl": "https://one.example",
                                  "shortlist": [{"id": "a/b", "price": [7, 8]}, "gone/model"]}}}))
        got = run_main({})
        assert [m["id"] for m in got["providerModels"]] == ["a/b"] and got["pinned"] == ["a/b"], got
        assert got["providerModels"][0]["price"] == [7.0, 8.0], got

        # The merged harness-profile path: a profile that still names a provider fills `harness` from it, and the
        # active provider reads the same cached catalog: no second request.
        llm.CONFIG.write_text(json.dumps({
            "harness": "gw",
            "harnesses": {"gw": {"label": "Gateway", "command": ["gw", "run", "--model", "{model}"],
                                 "models": {"provider": "one", "prefix": "a/"}}},
            "providers": {"one": {"label": "One", "kind": "openai", "baseUrl": "https://one.example"},
                          "two": {"label": "Two", "kind": "openai", "baseUrl": "https://two.example"}}}))
        before = len(asked)
        got = run_main({})
        assert [m["value"] for m in got["harness"]] == ["a/b"] and got["provider"] == "one", got
        assert [m["id"] for m in got["providerModels"]] == ["a/b"], got
        assert len(asked) == before, "the active provider's catalog was fetched again"
    finally:
        models.claude_models, models.codex_models = real_claude, real_codex

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
    assert got[0]["label"] == "anthropic/one", got[0]  # no name in the row: short(id)

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
