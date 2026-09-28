"""Evidence eligibility is schema metadata, not a field-name rule or a truth label."""
from copy import deepcopy
import json
from pathlib import Path

import pytest

from experiments.extraction.analyze import diagnostic
from kei_exp.kie.extract import run
from kei_exp.kie.extract.method import ArticleOptions
from kei_exp.kie.extract.models import Router
from kei_exp.kie.extract.schema import Schema, evidence_policy
from tests.test_extract_grounded import CountingChat, WordCounter
from tests.test_extract_stages import evidence, passages

TREE = json.loads((Path(__file__).parent / "fixtures/contracts/evidence-policy.schema.json").read_text())


def test_policy_transport_and_inheritance_use_the_shared_schema_fixture():
    schema = Schema.model_validate(TREE)
    assert schema.model_dump(by_alias=True, exclude_none=True) == TREE
    assert evidence_policy(schema.nodes, ("diagnostic", 0, "status")) == "derived"
    assert evidence_policy(schema.nodes, ("diagnostic", 1, "observation")) == "quoted"
    assert evidence_policy(schema.nodes, ("review",)) == "unverified"
    with pytest.raises(ValueError, match="leaves schema"):
        evidence_policy(schema.nodes, ("absent",))


@pytest.mark.parametrize("policy", [None, "inferred", True, {}])
def test_unknown_and_null_policies_are_rejected(policy):
    tree = deepcopy(TREE)
    tree["schemaNodes"][0]["evidencePolicy"] = policy
    with pytest.raises(ValueError):
        Schema.model_validate(tree)


@pytest.mark.parametrize("grounding", ["semantic", "off"])
def test_policy_factor_requires_a_quoted_evidence_method(grounding):
    with pytest.raises(ValueError, match="requires quoted or span"):
        ArticleOptions(grounding=grounding, evidence_policy="schema")
    assert "evidence_policy" not in ArticleOptions().model_dump()


def assembled(monkeypatch, *, enabled, name="diagnostic"):
    tree = deepcopy(TREE)
    tree["schemaNodes"][1]["name"] = name
    source = passages(["Hill. Source observation."])
    monkeypatch.setattr(run, "load", lambda _: evidence(source))
    def reason(system, user, schema):
        if "records" in schema["properties"]:
            return {"records": [{"label": "Hill", "identity": {"site": "Hill"}, "passages": ["p1_s0"]}]}
        return {claim: {"label": "E1", "attribution": True}
                for claim in schema["properties"]}
    fields = CountingChat(lambda *_: {name: [{"status": "reported", "observation": "Source observation"}],
                                     "review": "check later"})
    reasoning = CountingChat(reason)
    request = run.ExtractRequest(schema=tree, options={"strategy": "article", "article": {
        "grounding": "spans", "evidence_policy": "schema" if enabled else None}})
    result = run.extract(None, request, Router(fields, reasoning),
        counter={role: WordCounter() for role in ("fields", "reasoning")})
    return result, fields.calls, reasoning.calls


@pytest.mark.parametrize("name", ["diagnostic", "field_statuses", "renamed"])
def test_policy_skips_explicit_nodes_and_retains_truth_boundaries(monkeypatch, name):
    result, _, calls = assembled(monkeypatch, enabled=True, name=name)
    eligible = result["grounding_eligibility"]
    assert eligible == {"all_record_leaves": 4, "eligible_record_leaves": 2, "skipped": [
        {"path": ["records", 0, name, 0, "status"], "policy": "derived"},
        {"path": ["records", 0, "review"], "policy": "unverified"}]}
    assert {tuple(x["path"]) for x in result["evidence"]} == {
        ("records", 0, "site"), ("records", 0, name, 0, "observation")}
    assert len(calls[-1]["schema"]["required"]) == 2
    assert result["completion"]["eligible_grounding"] == "complete"
    assert result["completion"]["grounding"] == "partial" and not result["complete"]
    assert len(result["ungrounded"]) == 2
    assert [x["code"] for x in result["issues"]].count("evidence_policy_skipped") == 2
    metrics = diagnostic(result)
    assert metrics["populated_record_leaves"] == 4 and metrics["link_rate"] == 0.5
    assert metrics["grounding_eligibility"]["eligible_link_rate"] == 1


def test_disabling_policy_keeps_upstream_records_and_all_claims(monkeypatch):
    on, on_fields, on_reason = assembled(monkeypatch, enabled=True)
    off, off_fields, off_reason = assembled(monkeypatch, enabled=False)
    assert on["records"] == off["records"] and on_fields == off_fields and on_reason[:-1] == off_reason[:-1]
    assert len(off_reason[-1]["schema"]["required"]) == 4
    assert "grounding_eligibility" not in off and "eligible_grounding" not in off["completion"]
    assert on["fingerprint"] != off["fingerprint"]


def test_reporting_refuses_hidden_denominator_changes(monkeypatch):
    result, _, _ = assembled(monkeypatch, enabled=True)
    result["grounding_eligibility"]["all_record_leaves"] = 2
    with pytest.raises(ValueError, match="eligibility disagrees"):
        diagnostic(result)


def test_all_skipped_is_not_applicable_and_never_complete(monkeypatch):
    for node in (TREE["schemaNodes"][0], TREE["schemaNodes"][1]["children"][1]):
        monkeypatch.setitem(node, "evidencePolicy", "derived")
    result, _, _ = assembled(monkeypatch, enabled=True)
    assert not any(call["stage"] == "grounding" for call in result["calls"])
    assert result["evidence"] == [] and len(result["ungrounded"]) == 4
    assert result["completion"]["eligible_grounding"] == "not_applicable"
    assert result["completion"]["grounding"] == "partial" and not result["complete"]
    assert diagnostic(result)["grounding_eligibility"]["eligible_link_rate"] is None


def test_reporting_rejects_a_link_on_a_policy_skipped_field(monkeypatch):
    result, _, _ = assembled(monkeypatch, enabled=True)
    result["evidence"][0]["path"] = ["records", 0, "review"]
    with pytest.raises(ValueError, match="policy-skipped fields"):
        diagnostic(result)
