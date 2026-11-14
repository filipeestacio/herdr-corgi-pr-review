"""Run: python3 test_resilience.py  (no network, no model): the resilience run's schema, prompt and checks."""
import json
import pathlib
import sys
import tempfile

sys.dont_write_bytecode = True
import resilience  # noqa: E402
import reviewers  # noqa: E402

# The run is a reviewer like the others: its schema asks for the block, the prompt says hints are no limit.
s = reviewers.findings_schema("resilience", "/w")
assert {"paths", "deps", "effects", "state", "races", "blind_spots", "checks", "probes", "not_checked"} <= set(s["required"]) and "ref" in s["properties"]["findings"]["items"]["required"]
plain = reviewers.PLAIN["resilience"].format(base="b", number=2)
for part in ("are hints, not your limit", "unchanged templates and infrastructure", "worst_record_s", "a reader of state another process holds is no race",
             "never advice without a line", "what happens when they run out"):
    assert part in plain, part
assert reviewers.allowed({"kind": "resilience", "worktree": "/w"}) == list(reviewers.review.allowed_rules(reviewers.permissions("/w"))), "the same rights as the other reviewers"
assert reviewers.AREAS["resilience"] == resilience.AREAS and "consistency" in reviewers.review.CATEGORIES

# Hints: the security view and the findings so far, by id.
h = resilience.hints({}, {"zones": [{"name": "Front desk", "trust": "authenticated", "nodes": ["handler"]}], "access": [{"id": "acc1", "resource": "Api", "principal": "anyone", "at": "t.yaml:3"}]},
                     [{"id": "a1", "file": "x.py", "line": 3, "title": "Mailed twice", "reviewer": "analysis"}])
assert "Front desk (authenticated): handler" in h and "acc1 Api for anyone at t.yaml:3" in h and "- a1: x.py:3 Mailed twice (analysis)" in h
assert resilience.hints({}, None, []) == ""

# The answer, checked against the picture and the findings: unknown edges, nodes, enums and ids go; a finding result
# names a finding; mitigated names what limits it; a path's probe exists.
pic = {"architecture": {"nodes": [{"id": "handler"}, {"id": "consumer"}, {"id": "mailer"}], "edges": [{"from": "handler", "to": "consumer"}, {"from": "consumer", "to": "mailer"}]}}
new = [{"id": "n1", "ref": "r_f1", "title": "Batch retried"}]
answer = {
    "deps": [{"edge": "e1", "at": "./library/consumer.py:12", "mode": "async", "retry": {"layer": "platform", "attempts": 3, "exhausted": "explode"},
              "trigger": {"batch": 10, "fn_timeout_s": 10, "worst_record_s": 7, "dlq": False, "retention_s": 345600}, "context": {"kind": "weird"}},
             {"edge": "e9", "at": "x.py:1", "mode": "telepathy"}],
    "effects": [{"id": "mail", "kind": "mail", "at": "library/mailer.py:10", "node": "mailer", "order": "after_commit", "retried_by": ["sqs"], "findings": ["a1", "r_f1", "zz"]},
                {"kind": "no id"}],
    "state": [{"id": "store", "what": "loans", "writers": [{"node": "handler", "at": "a.py:1", "guard": ""}, {"node": "ghost", "at": "b.py:2"}], "readers": [{"node": "consumer", "at": "c.py:3"}]}],
    "races": [{"id": "x1", "shared": "store", "pattern": "check_then_act", "actors": ["a", "b"], "steps": [["a", "reads", "c.py:1"], ["b"], ["b", "writes", "c.py:2", "extra"]], "breaks_at": 1, "findings": []}],
    "blind_spots": [{"id": "b1", "failure": "publish never reaches SQS", "at": "events.py:20", "signal": "none", "alarm": "maybe", "findings": ["a1"]}],
    "paths": [{"id": "anything", "kind": "retry", "trigger": "one record raises", "steps": ["consumer", "e1", "library/consumer.py:12", "nowhere", "e7"], "end": "mails again",
               "result": "finding", "failing": ["unbounded_retry", "no_dlq", "vibes"], "visible": False, "findings": ["r_f1"], "probe": "r1"},
              {"kind": "timeout", "trigger": "t", "steps": [], "end": "e", "result": "finding", "failing": [], "visible": True, "findings": ["nope"]},
              {"kind": "effect", "trigger": "t", "steps": [], "end": "e", "result": "mitigated", "failing": [], "visible": True, "findings": []},
              {"kind": "effect", "trigger": "t", "steps": [], "end": "e", "result": "mitigated", "limited_by": "library/x.py:4", "failing": [], "visible": True, "probe": "r9"}],
    "checks": [{"check": "cors", "result": "clean", "why": "no browser route"}, {"check": "rollback", "result": "nah", "why": "?"}],
    "probes": [{"id": "r1", "claim": "mailer.send: 19 calls for 10 records", "of": "p1", "kind": "redelivery", "strength": "runs_pr_code"}, {"id": "r2", "of": "p2"}],
    "not_checked": ["load under real traffic"]}
v = resilience.view(answer, new, pic, ["a1"])
d = v["deps"]
assert [(x["edge"], x["at"], x["mode"]) for x in d] == [("e1", "library/consumer.py:12", "async"), (None, "x.py:1", None)]
assert d[0]["retry"]["exhausted"] is None and d[0]["context"]["kind"] is None and d[0]["trigger"]["worst_record_s"] == 7
assert v["effects"] == [{"id": "mail", "kind": "mail", "idempotency_key": None, "at": "library/mailer.py:10", "node": "mailer", "order": "after_commit", "retried_by": ["sqs"], "findings": ["a1", "n1"]}]
assert [w["node"] for w in v["state"][0]["writers"]] == ["handler", None] and v["races"][0]["steps"] == [["a", "reads", "c.py:1"], ["b", "writes", "c.py:2"]]
assert v["blind_spots"][0]["alarm"] == "unknown"
p = v["paths"]
assert [(x["id"], x["result"]) for x in p] == [("p1", "finding"), ("p2", "not_assessed"), ("p3", "not_assessed"), ("p4", "mitigated")]
assert p[0]["steps"] == ["consumer", "e1", "library/consumer.py:12"] and p[0]["failing"] == ["unbounded_retry", "no_dlq"] and p[0]["findings"] == ["n1"] and p[0]["probe"] == "r1"
assert p[3]["probe"] is None and p[3]["limited_by"] == "library/x.py:4"
assert [(c["check"], c["result"]) for c in v["checks"]] == [("cors", "clean"), ("rollback", "not_checkable")]
assert [(x["id"], x["status"]) for x in v["probes"]] == [("r1", "proposed")] and v["not_checked"] == ["load under real traffic"]
assert "ref" not in new[0], "the ref is the model's, the id stays"
assert resilience.view({}, [], {}, []) == {"deps": [], "effects": [], "state": [], "races": [], "db_calls": [], "caches": [], "clocks": [], "blind_spots": [], "paths": [],
                                           "checks": [], "probes": [], "not_checked": []}

# The block lands in the findings file next to the security view; another run keeps it.
file = pathlib.Path(tempfile.mkdtemp()) / "findings" / "1.json"
reviewers.merge(file, "resilience", "h", [], {"state": "done"}, None, {"resilience": {"paths": []}})
reviewers.merge(file, "security", "h", [], {"state": "done"}, {"threats": []})
doc = json.loads(file.read_text())
assert doc["resilience"] == {"paths": []} and doc["security"] == {"threats": []}
print("ok")
