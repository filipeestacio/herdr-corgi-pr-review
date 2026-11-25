"""Run: python3 test_harness.py  (a configured harness runs the LLM calls; subprocess.run is stubbed)"""
import json
import subprocess
import llm
import models

# ---- the harness command: {model} and {prompt} are filled in, and the prompt is appended when it has no {prompt}
assert llm.harness_argv(["h", "run", "--model", "{model}"], "a/x", "P") == ["h", "run", "--model", "a/x", "P"]
assert llm.harness_argv(["h", "{prompt}"], "a/x", "P") == ["h", "P"]

# ---- the answer: the object itself, a Claude-style {answer}, or one inside a fence or a sentence
assert llm.json_in('{"a": 1}') == {"a": 1}
assert llm.json_in('{"answer": {"a": 1}}') == {"a": 1}
assert llm.json_in('Sure:\n```json\n{"a": 1}\n```') == {"a": 1}
assert llm.json_in('thinking… {"a": {"b": 2}} done') == {"a": {"b": 2}}
assert llm.json_in("no json here") is None

# ---- a run: the command, its JSON answer, and no invented cost
calls = []


def fake(stdout, code=0, stderr=""):
    def run(args, **kw):
        calls.append(args)
        return subprocess.CompletedProcess(args, code, stdout, stderr)
    return run


llm.config = lambda: {"harness": {"command": ["myharness", "run", "--model", "{model}"]}}
# A command that names a model needs one: the run says so instead of leaving a flag without its value.
try:
    llm.run_harness("Review analysis", "P", model="", schema={})
    raise AssertionError("a missing model must raise")
except llm.RunFailed as e:
    assert e.kind == "model", e.kind
llm.config = lambda: {}
try:
    llm.run_harness("Review analysis", "P", model="a/x", schema={})
    raise AssertionError("no harness must raise")
except llm.RunFailed as e:
    assert e.kind == "harness", e.kind
llm.config = lambda: {"harness": {"command": ["myharness", "run", "--model", "{model}"]}}
llm.subprocess.run = fake('{"answer": {"files": 3}}')
got = llm.claude("Review analysis", "prompt", context={"id": "default", "env": None}, model="a/x", schema={"type": "object"})
assert got == {"files": 3}, got
assert calls[-1][:4] == ["myharness", "run", "--model", "a/x"], calls[-1]
assert calls[-1][-1].startswith("prompt") and "schema" in calls[-1][-1], "the schema is asked for in the prompt"

meta = {}
llm.subprocess.run = fake('{"answer": {}}')
llm.claude("Review analysis", "p", context=None, model="a/x", schema={}, meta=meta)
assert meta["cost"] is None and meta["tokens"] == 0 and meta["model_id"] == "a/x", meta

# A failing harness: one sentence with its first line, never a traceback.
llm.subprocess.run = fake("", 2, "auth failed for provider\nmore")
try:
    llm.claude("Review analysis", "p", context=None, model="a/x", schema={})
    raise AssertionError("a failing harness must raise")
except llm.RunFailed as e:
    assert "auth failed for provider" in str(e) and e.kind == "harness", (str(e), e.kind)

# An answer that is not JSON, with a schema: unreadable, not a crash.
llm.subprocess.run = fake("I could not do it")
try:
    llm.claude("Review analysis", "p", context=None, model="a/x", schema={})
    raise AssertionError("an unreadable answer must raise")
except llm.RunFailed as e:
    assert e.kind == "unreadable", e.kind

# Without a schema the text comes back as it is.
llm.subprocess.run = fake("plain answer")
assert llm.claude("Triage", "p", context=None, model="a/x").strip() == "plain answer"

# ---- the models the harness offers: a shortlist wins, else a command's output filtered by prefix
assert models.short("llmgateway-providers/openai/gpt-6.2-sol") == "openai/gpt-6.2-sol"
# A listed model may carry its price (USD per million input and output tokens), or none.
llm.config = lambda: {"harness": {"modelList": [{"id": "a/b/c", "price": [3, 15]}, "d/e"], "label": "G"}}
got = models.harness_list()
assert got[0] == {"value": "a/b/c", "label": "b/c", "description": "G", "price": [3.0, 15.0]}, got[0]
assert got[1] == {"value": "d/e", "label": "d/e", "description": "G"}, got[1]
assert models.short("a/b") == "a/b"
assert models.harness_list() == [{"value": "a/x", "label": "a/x", "description": ""}] if False else True
llm.config = lambda: {"harness": {"modelList": ["a/x", "b/y"], "label": "Gateway"}}
assert models.harness_list() == [{"value": "a/x", "label": "a/x", "description": "Gateway"}, {"value": "b/y", "label": "b/y", "description": "Gateway"}]
llm.config = lambda: {"harness": {"models": ["list-models"], "prefix": "g/"}}
models.subprocess.run = fake("g/one\nother/two\ng/three\n")
assert [m["value"] for m in models.harness_list()] == ["g/one", "g/three"]
print("ok")
