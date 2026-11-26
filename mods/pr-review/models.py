#!/usr/bin/env python3
"""The models the CLIs offer, for the review's model pickers.

argv[1]: JSON {context: {id, env}} (the PR's context: Claude lists what that account may use).
Prints {claude: [...], codex: [...], harness: [...], harnessName: "<active profile>", harnesses: [{name, label,
command, ok}], providers: {"<id>": {label, error}}}; a CLI or provider that is missing or doesn't answer gives an
empty list and an error sentence.
Harness: the active profile's models, from its shortlist, from a declared provider over HTTP (prefix keeps, deny
drops), from a command that prints one id per line (prefix keeps), or from the legacy harness.modelList.
Claude: the CLI's initialize control request, the one the Agent SDK's supportedModels() sends. No model is called,
and hooks, MCP servers and session files stay off. Codex: `codex debug models`, the models it lists in its picker.
"""
import fnmatch
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

sys.dont_write_bytecode = True  # a .pyc written into the mod's folder reloads the mod: the view waiting for this run is gone
import llm

CLAUDE = ["claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
          "--no-session-persistence", "--settings", '{"disableAllHooks":true}', "--strict-mcp-config",
          "--mcp-config", '{"mcpServers":{}}']
INIT = {"type": "control_request", "request_id": "models", "request": {"subtype": "initialize"}}


def claude_list(models):
    """The initialize response's models as picker entries; "default" is left out (it names one of the others)."""
    return [{"value": m["value"], "label": m.get("displayName") or m["value"], "description": m.get("description") or "",
             "resolved": m.get("resolvedModel") or m["value"]} for m in models or [] if m.get("value") and m["value"] != "default"]


def codex_list(catalog):
    """`codex debug models` as picker entries: the listed ones, in Codex's own order."""
    shown = [m for m in (catalog or {}).get("models") or [] if m.get("slug") and m.get("visibility") == "list"]
    return [{"value": m["slug"], "label": m.get("display_name") or m["slug"], "description": m.get("description") or ""}
            for m in sorted(shown, key=lambda m: m.get("priority", 99))]


def claude_models(context, timeout=30):
    """The claude profile's models, so a Claude Code pointed at a gateway lists that gateway's catalog."""
    try:
        env = llm.env_for(context, profile=llm.profile("claude"))
    except llm.MissingEnv:
        return []
    try:
        p = subprocess.Popen(CLAUDE, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
                             env=env, cwd=str(llm.APP))
    except FileNotFoundError:
        return []
    timer = threading.Timer(timeout, p.kill)
    timer.start()
    try:
        p.stdin.write(json.dumps(INIT) + "\n")
        p.stdin.flush()
        for line in p.stdout:  # stdin stays open: the CLI answers the request, then waits for a prompt that never comes
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if msg.get("type") == "control_response" and (msg.get("response") or {}).get("request_id") == "models":
                return claude_list(((msg["response"].get("response")) or {}).get("models"))
        return []
    finally:
        timer.cancel()
        p.kill()


def short(model_id):
    """A model id as a menu shows it: its vendor and name ("anthropic/claude-opus-5-5"), not the namespace before."""
    parts = str(model_id).split("/")
    return "/".join(parts[-2:]) if len(parts) >= 3 else str(model_id)


def _picker(e, label):
    """A shortlist entry as the picker shows it: an id or {id, price}, price in USD per million input and output
    tokens."""
    mid = str(e.get("id") if isinstance(e, dict) else e).strip()
    if not mid:
        return None
    got = {"value": mid, "label": short(mid), "description": label}
    price = e.get("price") if isinstance(e, dict) else None
    if isinstance(price, (list, tuple)) and len(price) == 2:
        got["price"] = [float(price[0]), float(price[1])]
    elif isinstance(price, dict) and price.get("input") is not None and price.get("output") is not None:
        got["price"] = [float(price["input"]), float(price["output"])]
    return got


def _filtered(models, prefix="", deny=()):
    """The catalog entries a profile keeps: those that start with `prefix` and match no deny glob."""
    return [m for m in models if str(m.get("value") or "").startswith(prefix)
            and not any(fnmatch.fnmatch(str(m.get("value") or ""), g) for g in deny)]


# A provider's catalog is used for six hours: a picker asks on every render, and a catalog changes by the day. A failed
# request is kept for a minute only: a network blip must not hide the provider until the next morning.
CACHE_HOURS = 6
CACHE_ERROR_SECONDS = 60
DEFAULT_TIMEOUT = 8


def _provider(provider_id):
    """A provider's settings and its label, from pr-review.config.json."""
    providers = llm.config().get("providers")
    spec = providers.get(provider_id) if isinstance(providers, dict) else None
    spec = spec if isinstance(spec, dict) else {}
    return spec, str(spec.get("label") or provider_id)


def _cache_path():
    return llm.APP / "pr-data" / "providers.json"


def _cache_read():
    try:
        got = json.loads(_cache_path().read_text())
    except (OSError, ValueError):
        return {}
    return got if isinstance(got, dict) else {}


def _cache_write(provider_id, entry):
    """The cache file with one provider's answer replaced. A write that fails changes nothing: the answer stands."""
    got = _cache_read()
    got[provider_id] = entry
    try:
        path = _cache_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(json.dumps(got))
        os.replace(tmp, path)
    except OSError:
        pass


def _fresh(entry, seconds):
    """Whether a cached answer is younger than `seconds`."""
    try:
        return time.time() - float(entry.get("at")) < seconds
    except (TypeError, ValueError):
        return False


def _said(e, n=120):
    """A short reason for a sentence, on one line."""
    text = " ".join(str(e or "").split()).rstrip(". ")
    if not text:
        return "no reason given"
    return text if len(text) <= n else text[:n].rstrip() + "…"


def _price(pricing):
    """OpenRouter's per-token pricing as USD per million input and output tokens."""
    try:
        return [round(float(pricing["prompt"]) * 1e6, 4), round(float(pricing["completion"]) * 1e6, 4)]
    except (KeyError, TypeError, ValueError):
        return None


def _catalog(data, spec, label, kind):
    """A provider's answer as picker entries, or None when it is not the shape pr-review knows: an object with a
    `data` list whose entries have an `id`. priceOverrides win over a catalog price."""
    rows = data.get("data") if isinstance(data, dict) else None
    if not isinstance(rows, list) or not all(isinstance(r, dict) and str(r.get("id") or "").strip() for r in rows):
        return None
    overrides = spec.get("priceOverrides") if isinstance(spec.get("priceOverrides"), dict) else {}
    got = []
    for row in rows:
        mid = str(row["id"]).strip()
        price = _price(row.get("pricing")) if kind == "openrouter" else None
        over = overrides.get(mid)
        if isinstance(over, (list, tuple)) and len(over) == 2:
            try:
                price = [float(over[0]), float(over[1])]
            except (TypeError, ValueError):
                pass
        entry = {"value": mid, "label": str(row.get("name") or row.get("display_name") or short(mid)),
                 "description": label}
        if price:
            entry["price"] = price
        got.append(entry)
    return got


def _failed(provider_id, sentence):
    """A request that gave nothing: the cached models when there are any, and the sentence for the person."""
    entry = _cache_read().get(provider_id)
    kept = entry.get("models") if isinstance(entry, dict) and isinstance(entry.get("models"), list) else []
    return kept, sentence


def _fetch(provider_id, spec, label):
    """One provider's catalog request: (models, error). Never raises for a network, HTTP or shape problem."""
    kind = str(spec.get("kind") or "openai")
    base = str(spec.get("baseUrl") or "").strip().rstrip("/")
    if not base:
        return [], f"{label} has no baseUrl in pr-review.config.json."
    key_env = spec.get("apiKeyEnv")
    key = os.environ.get(str(key_env), "") if key_env else ""
    if key_env and not key:
        return [], f"Its API key is not set: export {key_env}."
    headers = {"User-Agent": "pr-review"}
    extra = spec.get("headers")
    if isinstance(extra, dict):
        headers.update({str(k): str(v) for k, v in extra.items() if v is not None})
    if kind == "anthropic":
        headers.update({"x-api-key": key, "anthropic-version": "2023-06-01"})
    elif kind != "openrouter" and key:
        headers["Authorization"] = f"Bearer {key}"
    try:
        timeout = float(spec.get("timeout") or DEFAULT_TIMEOUT)
    except (TypeError, ValueError):
        timeout = float(DEFAULT_TIMEOUT)
    try:
        with urllib.request.urlopen(urllib.request.Request(base + "/models", headers=headers), timeout=timeout) as got:
            body = got.read()
    except urllib.error.HTTPError as e:
        return _failed(provider_id, f"{label} did not answer: HTTP {e.code}.")
    except urllib.error.URLError as e:
        return _failed(provider_id, f"{label} did not answer: {_said(e.reason)}.")
    except (TimeoutError, OSError, ValueError) as e:  # a timeout, a network failure, or a baseUrl urllib refuses
        return _failed(provider_id, f"{label} did not answer: {_said(e)}.")
    try:
        data = json.loads(body.decode("utf-8", "replace"))
    except ValueError:
        data = None
    models = _catalog(data, spec, label, kind) if data is not None else None
    if models is None:
        return _failed(provider_id, f"{label} answered in a shape pr-review does not know.")
    return models, None


def provider_models(provider_id):
    """A provider's catalog read over HTTP, cached for six hours and a failure for a minute: (picker entries, error
    sentence or None)."""
    spec, label = _provider(provider_id)
    entry = _cache_read().get(provider_id)
    entry = entry if isinstance(entry, dict) else {}
    age = CACHE_ERROR_SECONDS if entry.get("error") else CACHE_HOURS * 3600
    if isinstance(entry.get("models"), list) and _fresh(entry, age):
        return entry["models"], entry.get("error")
    models, error = _fetch(provider_id, spec, label)
    _cache_write(provider_id, {"at": int(time.time()), "models": models, "error": error})
    return models, error


def harness_models(profile, timeout=60):
    """The models a harness profile offers: (picker entries, error sentence or None). Its shortlist needs no request;
    else its provider (prefix keeps, deny drops) or its command (prefix keeps); nothing configured: no models."""
    spec = profile if isinstance(profile, dict) else llm.profile(profile)
    models = spec.get("models") if isinstance(spec.get("models"), dict) else {}
    label = str(spec.get("label") or "")
    shortlist = models.get("shortlist")
    if isinstance(shortlist, list):  # a chosen shortlist: better than 500 ids in a menu, and each may carry its price
        return [m for m in (_picker(e, label) for e in shortlist) if m], None
    provider = models.get("provider")
    if isinstance(provider, str) and provider:
        got, error = provider_models(provider)
        return _filtered(got, str(models.get("prefix") or ""),
                         [g for g in models.get("deny") or [] if isinstance(g, str)]), error
    cmd = models.get("command")
    if isinstance(cmd, (list, tuple)) and cmd:
        try:
            env = llm.env_for(None, profile=spec)
        except llm.MissingEnv as e:
            return [], f"{label} needs the environment variable {e.name}, and it is not set."
        try:
            r = subprocess.run([str(x) for x in cmd], capture_output=True, text=True, timeout=timeout, env=env)
        except (OSError, subprocess.TimeoutExpired):
            return [], None
        if r.returncode != 0:
            return [], None
        prefix = str(models.get("prefix") or "")
        return [{"value": v, "label": short(v), "description": label}
                for v in (line.strip() for line in r.stdout.splitlines()) if v and v.startswith(prefix)], None
    return [], None


def harness_list(timeout=60):
    """The active harness profile's models, as its picker shows them."""
    return harness_models(llm.profile(), timeout=timeout)[0]


def harnesses():
    """Every profile for the picker, the built-in Claude Code first: its name, label, joined command, whether the
    program is on PATH, and whether it is the built-in Claude Code command."""
    got = []
    for name, spec in llm.profiles().items():
        cmd = [str(a) for a in spec.get("command") or []]
        got.append({"name": name, "label": str(spec.get("label") or name), "command": " ".join(cmd),
                    "ok": bool(cmd) and bool(shutil.which(cmd[0])), "builtin": bool(spec.get("builtin"))})
    return got


def codex_models(timeout=30):
    codex = shutil.which("codex")
    if not codex:
        return []
    try:
        r = subprocess.run([codex, "debug", "models"], capture_output=True, text=True, timeout=timeout)
        return codex_list(json.loads(r.stdout)) if r.returncode == 0 else []
    except (subprocess.TimeoutExpired, ValueError):
        return []


def main():
    """One JSON object for the panel. A config or network problem never raises out of it: the object still prints,
    with the errors inside it."""
    req = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    out = {"claude": [], "codex": [], "harness": [], "harnessName": "claude", "harnesses": [], "providers": {}}
    try:
        out["harnessName"] = llm.active()
        spec = llm.profile()
    except Exception:  # a broken config names no profile: no harness, no providers
        spec = None
    try:
        out["harnesses"] = harnesses()
    except Exception:
        pass
    if spec is not None:
        models = spec.get("models") if isinstance(spec.get("models"), dict) else {}
        provider = models.get("provider")
        if isinstance(provider, str) and provider and not isinstance(models.get("shortlist"), list):
            try:  # the panel shows the provider's own error; harness_models then reads the same cached answer
                out["providers"][provider] = {"label": _provider(provider)[1], "error": provider_models(provider)[1]}
            except Exception:
                out["providers"][provider] = {"label": _provider(provider)[1], "error": None}
        try:
            out["harness"] = harness_models(spec)[0]
        except Exception:
            out["harness"] = []
    try:
        out["claude"] = claude_models(req.get("context"))
    except Exception:
        out["claude"] = []
    try:
        out["codex"] = codex_models()
    except Exception:
        out["codex"] = []
    print(json.dumps(out))


if __name__ == "__main__":
    main()
