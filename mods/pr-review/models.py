#!/usr/bin/env python3
"""The models the CLIs offer and the provider catalogs, for the review's model pickers.

argv[1]: JSON {context: {id, env}, provider?: "<name>"} (the PR's context: Claude lists what that account may use; the
provider is the one the panel picked for this review).
Prints {claude: [...], codex: [...], harness: [...], harnessName: "<active profile>", harnesses: [{name, label,
command, ok}], providers: [{name, label, kind}], provider: "<name>" | null, providerModels: [...], pinned: [...],
providerError: "<sentence>" | null}; a CLI that is missing or doesn't answer gives an empty list. A provider whose
request fails gives no entries, or the rows from its cache while the failure lasts, and its sentence in providerError.
Provider: the declared provider's catalog from its baseUrl, cached raw in pr-data/providers.json. Its picker entries
are built on every read: text-only rows, then prefix keeps and deny drops on the catalog id; `value` is the id through
the provider's modelId template, the id the runner receives; a price comes from `pricing`, in USD per million tokens,
for any kind, with priceOverrides winning. The whole filtered catalog is listed, in catalog order; `shortlist` pins
catalog ids in its own order and may set their price, and `pinned` names the pins the catalog holds.
Harness: the active profile's models, from its shortlist, from a declared provider over HTTP (prefix keeps, deny
drops), from a command that prints one id per line (prefix keeps), or from the legacy harness.modelList.
Claude: the CLI's initialize control request, the one the Agent SDK's supportedModels() sends. No model is called,
and hooks, MCP servers and session files stay off. Codex: `codex debug models`, the models it lists in its picker.
"""
import fnmatch
import json
import os
import re
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


def _pair(price):
    """A shortlist or priceOverrides price as [input, output] USD per million tokens, or None when it is not one."""
    if isinstance(price, (list, tuple)) and len(price) == 2:
        try:
            return [float(price[0]), float(price[1])]
        except (TypeError, ValueError):
            return None
    if isinstance(price, dict) and price.get("input") is not None and price.get("output") is not None:
        try:
            return [float(price["input"]), float(price["output"])]
        except (TypeError, ValueError):
            return None
    return None


def _picker(e, label):
    """A shortlist entry as the picker shows it: an id or {id, price}, price in USD per million input and output
    tokens."""
    mid = str(e.get("id") if isinstance(e, dict) else e).strip()
    if not mid:
        return None
    got = {"value": mid, "label": short(mid), "description": label}
    price = _pair(e.get("price")) if isinstance(e, dict) else None
    if price is not None:
        got["price"] = price
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
    declared = llm.config().get("providers")
    spec = declared.get(provider_id) if isinstance(declared, dict) else None
    spec = spec if isinstance(spec, dict) else {}
    return spec, str(spec.get("label") or provider_id)


def providers():
    """Every provider pr-review.config.json declares, in its order: {name, label, kind} for the picker. A broken entry
    is still listed with what it has, so a bad config never hides the others."""
    got = []
    declared = llm.config().get("providers")
    for name, spec in (declared.items() if isinstance(declared, dict) else ()):
        if not isinstance(name, str) or not name:
            continue
        spec = spec if isinstance(spec, dict) else {}
        got.append({"name": name, "label": str(spec.get("label") or name), "kind": str(spec.get("kind") or "openai")})
    return got


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
    """A row's per-token pricing as USD per million input and output tokens, 4 decimals."""
    try:
        return [round(float(pricing["prompt"]) * 1e6, 4), round(float(pricing["completion"]) * 1e6, 4)]
    except (KeyError, TypeError, ValueError):
        return None


def _text(row):
    """Whether a catalog row can answer in text. A row whose architecture.output_modalities is there and holds no
    "text" is an image, speech, embedding or decision model, and stays out of the picker; a row without the field is
    kept."""
    arch = row.get("architecture")
    mods = arch.get("output_modalities") if isinstance(arch, dict) else None
    if isinstance(mods, (list, tuple)):
        return any(str(m).strip().lower() == "text" for m in mods)
    if isinstance(mods, str):
        return "text" in mods.lower()
    return True


def _model_id(catalog_id, family, spec, families):
    """The id the runner receives: the provider's modelId template, with {id} the catalog id, {vendor} the raw family
    and {family} the family with `families` applied. No template: the catalog id."""
    template = spec.get("modelId")
    if not isinstance(template, str) or not template:
        return catalog_id
    raw = "" if family is None else str(family)
    alias = families.get(raw) if isinstance(families, dict) else None
    values = {"id": catalog_id, "vendor": raw, "family": raw if alias is None else str(alias)}
    return re.sub(r"\{(id|vendor|family)\}", lambda m: values[m.group(1)], template)


def _catalog(data):
    """A provider's answer as its raw rows, or None when it is not the shape pr-review knows: an object with a `data`
    list whose entries have an `id`."""
    rows = data.get("data") if isinstance(data, dict) else None
    if not isinstance(rows, list) or not all(isinstance(r, dict) and str(r.get("id") or "").strip() for r in rows):
        return None
    return rows


def _entries(rows, spec, label):
    """A provider's raw rows as picker entries, built on every read so a mapping or a filter change needs no request.
    Text-only rows, then prefix keeps and deny drops on the catalog id; `value` goes through the modelId template; a
    price comes from the row's pricing for any kind, priceOverrides winning. A shortlist pins ids in its own order and
    may set their price; it does not hide the rest. Returns (entries in catalog order, the pinned ids the catalog
    holds)."""
    prefix = str(spec.get("prefix") or "")
    deny = [g for g in spec.get("deny") or [] if isinstance(g, str)]
    overrides = spec.get("priceOverrides") if isinstance(spec.get("priceOverrides"), dict) else {}
    families = spec.get("families") if isinstance(spec.get("families"), dict) else {}
    known = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        mid = str(row.get("id") or "").strip()
        if not mid or not mid.startswith(prefix) or any(fnmatch.fnmatch(mid, g) for g in deny) or not _text(row):
            continue
        price = _price(row.get("pricing")) if isinstance(row.get("pricing"), dict) else None
        over = _pair(overrides.get(mid))
        if over is not None:
            price = over
        entry = {"id": mid, "value": _model_id(mid, row.get("family"), spec, families),
                 "label": str(row.get("display_name") or row.get("name") or short(mid)), "description": label}
        if price is not None:
            entry["price"] = price
        known.setdefault(mid, entry)
    pinned = []
    shortlist = spec.get("shortlist")
    if isinstance(shortlist, list):
        for e in shortlist:
            mid = str((e.get("id") if isinstance(e, dict) else e) or "").strip()
            if not mid or mid in pinned or mid not in known:
                continue
            price = _pair(e.get("price")) if isinstance(e, dict) else None
            if price is not None:
                known[mid]["price"] = price
            pinned.append(mid)
    return list(known.values()), pinned


def _failed(provider_id, sentence):
    """A request that gave nothing: the cached rows when there are any, and the sentence for the person."""
    entry = _cache_read().get(provider_id)
    kept = entry.get("rows") if isinstance(entry, dict) and isinstance(entry.get("rows"), list) else []
    return kept, sentence


def _fetch(provider_id, spec, label):
    """One provider's catalog request: (raw rows, error). Never raises for a network, HTTP or shape problem."""
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
    rows = _catalog(data) if data is not None else None
    if rows is None:
        return _failed(provider_id, f"{label} answered in a shape pr-review does not know.")
    return rows, None


def provider_catalog(provider_id):
    """A provider's catalog read over HTTP, cached raw for six hours and a failure for a minute: (picker entries, pinned
    catalog ids, error sentence or None). The entries are built from the cached rows on every read, so a mapping or
    filter change follows the config without a request."""
    spec, label = _provider(provider_id)
    entry = _cache_read().get(provider_id)
    entry = entry if isinstance(entry, dict) else {}
    rows = entry.get("rows") if isinstance(entry.get("rows"), list) else None
    age = CACHE_ERROR_SECONDS if entry.get("error") else CACHE_HOURS * 3600
    if rows is not None and _fresh(entry, age):
        entries, pinned = _entries(rows, spec, label)
        return entries, pinned, entry.get("error")
    rows, error = _fetch(provider_id, spec, label)
    _cache_write(provider_id, {"at": int(time.time()), "rows": rows, "error": error})
    entries, pinned = _entries(rows, spec, label)
    return entries, pinned, error


def provider_models(provider_id):
    """A provider's catalog: (picker entries, error sentence or None)."""
    entries, _, error = provider_catalog(provider_id)
    return entries, error


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
    out = {"claude": [], "codex": [], "harness": [], "harnessName": "claude", "harnesses": [], "providers": [],
           "provider": None, "providerModels": [], "providerError": None, "pinned": []}
    try:
        out["harnessName"] = llm.active()
        spec = llm.profile()
    except Exception:  # a broken config names no profile: no harness, no providers
        spec = None
    try:
        out["harnesses"] = harnesses()
    except Exception:
        pass
    try:
        out["providers"] = providers()
    except Exception:
        out["providers"] = []
    asked = req.get("provider") if isinstance(req, dict) else None
    names = [p["name"] for p in out["providers"]]
    active = asked if isinstance(asked, str) and asked else (names[0] if names else None)
    out["provider"] = active
    if spec is not None:
        try:
            out["harness"] = harness_models(spec)[0]
        except Exception:
            out["harness"] = []
    if active is not None:
        try:
            out["providerModels"], out["pinned"], out["providerError"] = provider_catalog(active)
        except Exception:
            out["providerModels"], out["pinned"] = [], []
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
