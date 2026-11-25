#!/usr/bin/env python3
"""The models the CLIs offer, for the review's model pickers.

argv[1]: JSON {context: {id, env}} (the PR's context: Claude lists what that account may use).
Prints {claude: [{value, label, description, resolved}], codex: [{value, label, description}], harness:
[{value, label, description}]}; a CLI that is missing or doesn't answer gives an empty list.
Harness: config harness.modelList names the models, or harness.models prints one id per line (harness.prefix
keeps a subset).
Claude: the CLI's initialize control request, the one the Agent SDK's supportedModels() sends. No model is called,
and hooks, MCP servers and session files stay off. Codex: `codex debug models`, the models it lists in its picker.
"""
import json
import shutil
import subprocess
import sys
import threading

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
    try:
        p = subprocess.Popen(CLAUDE, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
                             env=llm.env_for(context), cwd=str(llm.APP))
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


def harness_list(timeout=60):
    """The configured harness's models: config harness.models (argv) prints one model id per line; harness.prefix keeps
    the ones that start with it, harness.label describes them."""
    spec = llm.config().get("harness") or {}
    picked = [str(v) for v in (spec.get("modelList") or []) if str(v).strip()]
    if picked:  # a chosen shortlist: better than 500 ids in a menu
        label = str(spec.get("label") or "")
        return [{"value": v, "label": v, "description": label} for v in picked]
    cmd = spec.get("models")
    if not isinstance(cmd, list) or not cmd:
        return []
    try:
        r = subprocess.run([str(x) for x in cmd], capture_output=True, text=True, timeout=timeout, env=llm.env_for(None))
    except (OSError, subprocess.TimeoutExpired):
        return []
    if r.returncode != 0:
        return []
    prefix, label = str(spec.get("prefix") or ""), str(spec.get("label") or "")
    return [{"value": v, "label": v, "description": label}
            for v in (line.strip() for line in r.stdout.splitlines()) if v and v.startswith(prefix)]


def codex_models(timeout=30):
    codex = shutil.which("codex")
    if not codex:
        return []
    try:
        r = subprocess.run([codex, "debug", "models"], capture_output=True, text=True, timeout=timeout)
        return codex_list(json.loads(r.stdout)) if r.returncode == 0 else []
    except (subprocess.TimeoutExpired, ValueError):
        return []


if __name__ == "__main__":
    req = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    print(json.dumps({"claude": claude_models(req.get("context")), "codex": codex_models(), "harness": harness_list()}))
