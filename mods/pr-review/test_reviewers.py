"""Run: python3 test_reviewers.py  (no network, no model): the security reviewer's view of a PR."""
import json
import os
import pathlib
import sys
import tempfile
import time

sys.dont_write_bytecode = True
import reviewers  # noqa: E402

# The security reviewer answers with its view too; the other reviewers do not.
sec, code = reviewers.findings_schema("security"), reviewers.findings_schema("claude")
assert {"zones", "access", "threats"} <= set(sec["required"]) and not {"zones", "access", "threats"} & set(code["properties"])
assert "ref" in sec["properties"]["findings"]["items"]["required"] and "reachability" not in code["properties"]["findings"]["items"]["properties"]
for part in ("zones: the trust zones", "auth_kind (none:", "threats: a threat model", "at least one entry for each of them", "gates: the check", "principal_kind (internet", "without an authorizer"):
    assert part in sec["description"] and part not in code["description"], part

# The security run's own prompt carries the steps of the /security-review template (which cannot run: its template runs
# plain git) plus rights and retries; it asks for nothing it could only guess.
plain = reviewers.PLAIN["security"].format(base="b", number=2)
for part in ("authentication and authorization", "a grant with no such call is a finding", "error and retry paths", "re-run a whole batch",
             "state across components", "secrets:", "personal data and logging", "dependencies:", "Leave out what you could not confirm"):
    assert part in plain, part

# A reviewer reads someone else's code: only the checkout, read-only git, no network, and nothing that is not allowed.
p = reviewers.permissions("/work/check out")
assert p[:3] == ("--restricted", "--permission-mode", "dontAsk"), "file tools confined to the checkout, its .claude settings ignored, the rest refused"
allowed, denied = p[p.index("--allowedTools") + 1:p.index("--disallowedTools")], p[p.index("--disallowedTools") + 1:]
git = f"Bash(python3 {reviewers.review.SAFEGIT} '/work/check out' *)"
assert allowed == ("Read", "Grep", "Glob", "Agent", git), allowed
assert "Bash(git *)" in denied, "no plain git at all: only safegit.py, fixed to this checkout"
assert reviewers.allowed({"kind": "security", "worktree": "/work/check out"}) == list(allowed), "the run records what it was allowed"
assert reviewers.allowed({"kind": "codex", "worktree": "/w"})[0].startswith("codex review: sandbox_mode read-only")
assert reviewers.review.git_hint("/work/check out").startswith(f"Call git only as `python3 {reviewers.review.SAFEGIT} '/work/check out' <command>")
assert reviewers.review.git_hint("/w") in reviewers.findings_schema("claude", "/w")["description"], "a slash command's fork sees the schema"
assert reviewers.review.permissions(None, "Read")[3:5] == ("--allowedTools", "Read") and reviewers.review.git_hint(None) == "", "no checkout: no git"
import llm  # noqa: E402
assert llm.env_for(None)["GIT_TEST_DISALLOW_ABBREVIATED_OPTIONS"] == "1"
assert json.loads(llm.LEAN[llm.LEAN.index("--settings") + 1])["permissions"] == {"blockReadsOutsideWorkingDirectories": True,
    "additionalDirectories": [str(reviewers.review.SAFEGIT.parent)]}, "built-in reads stay in the checkout and the mod's folder (for safegit.py)"
assert {"Edit", "Write", "WebFetch", "WebSearch"} <= set(denied)

# The picture comes from the newest analysis of the same PR that has one; a request file next to it is no analysis.
home = pathlib.Path(tempfile.mkdtemp())
(home / "cache").mkdir()
(home / "findings").mkdir()
write = lambda name, doc, age: (home / "cache" / name).write_text(json.dumps(doc)) or os.utime(home / "cache" / name, (time.time() - age,) * 2)  # noqa: E731
write("rv-123-aa-sonnet.json", {"answer": {"architecture": {"nodes": [{"id": "old"}]}}, "generated": "g1"}, 300)
write("rv-123-bb-sonnet.json", {"answer": {"architecture": {"nodes": [{"id": "new"}]}}, "generated": "g2"}, 200)
write("rv-123-cc-sonnet.json", {"answer": {"architecture": {"nodes": []}}}, 100)
write("rv-123-bb-sonnet.json.req.json", {"answer": {"architecture": {"nodes": [{"id": "req"}]}}}, 0)
write("rv-999-sonnet.json", {"answer": {"architecture": {"nodes": [{"id": "other PR"}]}}}, 0)
pic, made = reviewers.picture(home / "findings" / "123.json")
assert pic["architecture"]["nodes"] == [{"id": "new"}] and made == "g2", (pic, made)
assert reviewers.picture(home / "findings" / "7.json") == ({}, None)
assert "- new: " in reviewers.picture_text(pic) and "no architecture picture" in reviewers.picture_text({})

# The view: zones over the picture's nodes, the calls between zones of different trust, access rows with their place
# in the diff, and from where each finding is reached (the access rows in its lines, at its node, or at its callers).
pic = {"architecture": {
    "nodes": [{"id": "client", "status": "unchanged"}, {"id": "api", "at": "template.yaml:24", "status": "new"}, {"id": "handler", "at": "lib/handler.py:9", "status": "changed"},
              {"id": "store", "at": "lib/store.py:1", "status": "unchanged"}, {"id": "queue", "status": "new"}, {"id": "worker", "status": "unchanged"},
              {"id": "lone", "status": "unchanged"}, {"id": "cron", "status": "unchanged"}],
    "edges": [{"from": "client", "to": "api", "status": "new"}, {"from": "api", "to": "handler", "status": "new"}, {"from": "handler", "to": "store", "status": "unchanged"},
              {"from": "handler", "to": "queue", "status": "new"}, {"from": "queue", "to": "worker", "status": "new"}, {"from": "cron", "to": "worker", "status": "unchanged"}]},
    "components": [{"name": "FrontDesk", "at": "template.yaml:26", "node": "handler"}]}
answer = {
    "zones": [{"id": "net", "name": "Internet", "trust": "public", "nodes": ["client", "api", "made-up"]}, {"id": "fd", "name": "Front desk", "trust": "authenticated", "nodes": ["handler", "store", "api"]},
              {"id": "q", "name": "Queue", "trust": "data", "nodes": ["queue"]}, {"id": "w", "name": "Worker", "trust": "internal", "nodes": ["worker", "cron"]},
              {"id": "odd", "name": "?", "trust": "secret", "nodes": ["lone"]}, {"id": "net", "name": "again", "trust": "data", "nodes": []}],
    "access": [{"id": "acc1", "resource": "Api", "principal": "anyone on the internet", "public": True, "auth_kind": "code", "at": "template.yaml:24", "node": "api"},
               {"id": "acc2", "resource": "Queue", "principal": "handler", "public": False, "auth_kind": "iam", "at": "./template.yaml:30", "node": "queue"},
               {"id": "acc3", "resource": "Docs", "principal": "anyone", "public": True, "auth_kind": "none", "at": "template.yaml", "node": "lone"},
               {"id": "acc4", "resource": "Ghost", "principal": "x", "public": False, "auth_kind": "iam", "at": "template.yaml:40", "node": "nowhere"},
               {"resource": ""}],
    "threats": [{"where": {"access": "acc1"}, "boundary": "Internet → Front desk", "threat": "An empty token passes the check in `handler.py`.", "findings": ["f1", "f9"], "result": "checked_clean"},
                {"where": {"access": "acc2"}, "boundary": "Front desk → Queue", "threat": "Unchanged grant.", "findings": [], "result": "checked_clean"},
                {"where": {"from": "handler", "to": "queue"}, "boundary": "Front desk → Queue", "threat": "Any loan id lands on the queue.", "findings": [], "result": "checked_clean", "note": "id checked"},
                {"where": {"from": "handler", "to": "store"}, "boundary": "none", "threat": "Same trust, no boundary.", "findings": [], "result": "not_checked"},
                {"where": {"from": "cron", "to": "worker"}, "boundary": "x", "threat": "Unchanged call.", "findings": [], "result": "not_checked"},
                {"where": {"access": "acc3"}, "boundary": "Internet → Docs", "threat": "", "findings": [], "result": "not_checked"},
                {"where": {"from": "client", "to": "api"}, "boundary": "Internet → API", "threat": "Says finding, names none.", "findings": ["f7"], "result": "finding"},
                {"where": {}, "boundary": "", "threat": "Nowhere.", "findings": [], "result": "not_checked"},
                {"where": {"from": "queue", "to": "worker"}, "boundary": "Queue → Worker", "threat": "A forged message.", "stride": "T", "findings": [], "result": "mitigated",
                 "evidence": "worker.py:3", "goal": "Mail any member."}],
    "gates": [{"where": {"access": "acc1"}, "principal": "anyone", "check": "token", "at": "lib/handler.py:9", "source": "code", "holds_if": "FRONT_DESK_TOKEN is set", "carries": ["Authorization header"]},
              {"where": {"from": "handler", "to": "queue"}, "principal": "FrontDesk role", "check": "iam", "at": "template.yaml:30", "source": "config", "holds_if": "", "carries": ["body.id"]},
              {"where": {"from": "api", "to": "handler"}, "principal": "anyone", "check": "none", "at": "template.yaml:24", "source": "config", "holds_if": "", "carries": ["body"]},
              {"where": {"from": "client", "to": "api"}, "principal": "x", "check": "none", "at": "", "source": "config", "holds_if": "", "carries": []},
              {"where": {"access": "acc2"}, "principal": "x", "check": "magic", "at": "", "source": "code", "holds_if": "", "carries": []}]}
f = lambda **kw: {"file": "lib/handler.py", "line": 9, "impact": "edge_case", **kw}  # noqa: E731
findings = [f(id="s1", ref="f1", title="token check fails open", impact="unauthorized_access"),
            f(id="s2", ref="f2", title="by its node, above its line", line=30),
            f(id="s3", title="no place, the model's word", file="nowhere.py", reachability="internal_only"),
            f(id="s4", title="no place, no word", file="nowhere.py"),
            f(id="s5", title="unused grant", file="template.yaml", line=29, end=31),
            f(id="s6", title="by the component above it", file="template.yaml", line=27)]
changed = {"template.yaml": {24, 40}}
v = reviewers.security_view(answer, findings, pic, changed)
assert [(z["id"], z["nodes"]) for z in v["zones"]] == [("net", ["client", "api"]), ("fd", ["handler", "store"]), ("q", ["queue"]), ("w", ["worker", "cron"])], \
    "unknown trust, unknown nodes, a node's second zone and a second zone of the same id go"
assert v["crossing"] == [{"from": "api", "to": "handler", "edge": "e1"}, {"from": "handler", "to": "queue", "edge": "e3"}, {"from": "queue", "to": "worker", "edge": "e4"}], v["crossing"]
assert [(r["id"], r.get("node"), r["opened_by_pr"]) for r in v["access"]] == [("acc1", "api", True), ("acc2", "queue", False), ("acc3", "lone", False), ("acc4", None, True)]
got = {x["title"]: (x["reachable_from"], x["reachability"]) for x in findings}
assert got["token check fails open"] == (["acc1"], "public"), "the broken check itself is reached before any check"
assert got["by its node, above its line"] == (["acc1"], "authenticated"), "the node above its line, then its callers to the entry"
assert got["no place, the model's word"] == ([], "internal_only") and got["no place, no word"] == ([], "unknown")
assert got["unused grant"] == (["acc2"], "internal_only"), "an access row in the finding's own lines is its place"
assert got["by the component above it"] == (["acc1"], "authenticated")
assert not any("ref" in x for x in findings), "the refs are the model's, the ids stay"
t = v["threats"]
assert [(x["id"], x["where"], x["result"], x.get("derived", False)) for x in t] == [
    ("t1", {"access": "acc1"}, "finding", False), ("t2", {"from": "handler", "to": "queue", "edge": "e3"}, "not_assessed", False),
    ("t3", {"from": "queue", "to": "worker", "edge": "e4"}, "mitigated", False),
    ("t4", {"access": "acc4"}, "not_assessed", True), ("t5", {"from": "api", "to": "handler", "edge": "e1"}, "not_assessed", True)], \
    "an unchanged grant, a call within one trust level, an unchanged call, an empty threat and no place go; every new crossing has an entry"
assert (t[0]["findings"], t[0]["stride"]) == (["s1"], "") and (t[2]["stride"], t[2]["goal"], t[2]["evidence"]) == ("T", "Mail any member.", "worker.py:3"), \
    "findings by ref; mitigated keeps its evidence; mitigated without evidence (t2, an older checked_clean) is not assessed"
assert t[4]["boundary"] == "Internet → Front desk" and t[3]["threat"] == "No threat was named for this crossing."
assert [(g["where"], g["check"], g["source"]) for g in v["gates"]] == [({"access": "acc1"}, "token", "code"), ({"from": "handler", "to": "queue", "edge": "e3"}, "iam", "config"),
                                                                      ({"from": "api", "to": "handler", "edge": "e1"}, "none", "config")], "a gate at no crossing or with an unknown check goes"
assert v["effective_zones"] == [{"node": "handler", "drawn": "authenticated", "effective": "public", "where": {"from": "api", "to": "handler", "edge": "e1"}}], \
    "nothing checks the call into handler: it stands in its caller's zone; acc1's check in code leaves api public, as drawn"
code_gate = reviewers.security_view({**answer, "gates": [{**answer["gates"][0], "where": {"from": "api", "to": "handler"}, "check": "token", "source": "code"}]}, [], pic, changed)
assert [z["effective"] for z in code_gate["effective_zones"]] == ["public"], "a check in the card's own code: the card is as exposed as its caller"
assert reviewers.security_view({"threats": [answer["threats"][6]]}, [], {"architecture": {"nodes": pic["architecture"]["nodes"], "edges": pic["architecture"]["edges"]}}, None)["threats"] == [], \
    "no zones: no call crosses a boundary"
lone = reviewers.security_view({"access": [{"resource": "Api", "at": "t.yaml:3", "principal": "anyone", "principal_kind": "robot", "change": "added"}],
                                "threats": [{"where": {"access": "acc1"}, "threat": "x", "result": "finding", "findings": []}]}, [], {}, None)
assert "opened_by_pr" not in lone["access"][0] and "principal_kind" not in lone["access"][0] and lone["access"][0]["change"] == "added"
assert [x["result"] for x in lone["threats"]] == ["not_assessed"], "no diff: the row stays; a finding result needs a finding"
assert reviewers.security_view({"access": [{"resource": "Old", "at": "t.yaml:3", "change": "unchanged"}]}, [], {}, {"t.yaml": {3}})["threats"] == [], "an unchanged grant needs no entry"
assert reviewers.security_view({}, [], {}, {}) == {"zones": [], "access": [], "crossing": [], "gates": [], "threats": [], "effective_zones": []}
entry = {"architecture": {"nodes": [{"id": "c", "status": "unchanged"}, {"id": "h", "status": "changed"}], "edges": [{"from": "c", "to": "h", "status": "changed"}]}}
ez = {"zones": [{"id": "p", "trust": "public", "nodes": ["c"]}, {"id": "a", "trust": "authenticated", "nodes": ["h"]}],
      "access": [{"resource": "Api", "public": True, "node": "h", "at": "t.yaml:1", "change": "added"}], "threats": [{"where": {"access": "acc1"}, "threat": "x", "result": "not_assessed"}]}
assert [x["where"] for x in reviewers.security_view(ez, [], entry, None)["threats"]] == [{"access": "acc1"}], "the caller's edge into a public entry is that entry, not a second crossing"
assert [x["where"] for x in reviewers.security_view({**ez, "threats": []}, [], entry, None)["threats"]] == [{"access": "acc1"}], "one way in, one not assessed entry"

# The view lands in the findings file next to the runs; a run without one leaves it.
file = home / "findings" / "123.json"
reviewers.merge(file, "security", "h1", [{"id": "s1", "reviewer": "security"}], {"state": "done"}, {"threats": []})
reviewers.merge(file, "security", "h1", None, {"state": "running"})
doc = json.loads(file.read_text())
assert doc["security"] == {"threats": []} and doc["runs"]["security"] == {"state": "running"} and doc["findings"][0]["head"] == "h1"
print("ok")
