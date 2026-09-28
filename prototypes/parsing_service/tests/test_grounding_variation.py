"""Repeated-request disagreement is observable variation, not method attribution."""
from copy import deepcopy
from pathlib import Path
import runpy

helper = runpy.run_path(str(Path(__file__).resolve().parents[3] /
                           "docs/validation/extraction_grounding_variation.py"))


def capture(identity, text, *, limit=2048, finish="stop"):
    return {"id": identity, "request": {"system": "verify", "user": "same", "max_tokens": limit,
        "schema": {"required": ["C1", "C2"]}}, "reply": {"text": text, "finish": finish}}


def test_all_unordered_pairs_distinguish_missing_keys_and_ignore_json_formatting():
    a = capture("a", '{"C1":{"label":"E1","attribution":true},"C2":"NONE"}')
    b = capture("b", '{"C2":"NONE", "C1": {"attribution":true, "label":"E1"}}')
    c = capture("c", '{"C1":{"label":"E2","attribution":true}}')
    result = helper["compare"]([a, b, c])
    assert result["unique_requests"] == result["divergent_groups"] == 1
    assert result["claim_pair_comparisons"] == 6 and result["different_decisions"] == 4
    assert {d["claim"] for d in result["groups"][0]["differences"]} == {"C1", "C2"}


def test_output_budget_changes_do_not_form_identical_requests():
    a = capture("a", '{"C1":"NONE","C2":"NONE"}')
    b = deepcopy(a)
    b["request"]["max_tokens"] = 4096
    assert helper["compare"]([a, b])["shared_request_groups"] == 0


def test_schema_property_order_is_part_of_the_request():
    a = capture("a", '{"C1":"NONE","C2":"NONE"}')
    b = deepcopy(a)
    a["request"]["schema"]["properties"] = {"C1": {}, "C2": {}}
    b["request"]["schema"]["properties"] = {"C2": {}, "C1": {}}
    assert helper["compare"]([a, b])["shared_request_groups"] == 0


def test_truncated_malformed_and_missing_replies_are_not_agreement():
    result = helper["compare"]([capture("valid", '{"C1":"NONE","C2":"NONE"}'),
        capture("cut", '{"C1":"NONE","C2":"NONE"}', finish="length"),
        capture("bad", '{"C1":'), capture("missing", '', finish=None)])
    assert result["claim_pair_comparisons"] == result["different_decisions"] == 0
    assert result["groups"][0]["unreadable_or_truncated"] == ["cut", "bad", "missing"]
