"""The task scope of an extraction definition: Article is one document-level object, Catalog a collection of records.

`tests/fixtures/contracts/record-scope.json` is the contract Studio tests against too: every request row is admitted or
refused as it says, and every artifact row is published or refused at `run.dispatch`, the one point every
implementation's result passes. The scope is the schema's `recordScope` when it declares one and otherwise the task
selection (`options.strategy`); it is never read off array fields or a model's output.
"""
import json
import re
from pathlib import Path

import pytest
from pydantic import ValidationError

from kei_exp.kie.extract import article, catalog, contexts, run, stages, unified
from kei_exp.kie.extract.schema import Schema
from tests.helpers.chat import FakeChat
from tests.test_extract_grounded import CountingChat, WordCounter
from tests.test_extract_stages import SCHEMA, evidence, passages

CONTRACT = json.loads((Path(__file__).parent / "fixtures" / "contracts" / "record-scope.json").read_text())


def definition(scope: str | None) -> dict:
    schema = SCHEMA.model_dump(by_alias=True, exclude_none=True)
    return schema if scope is None else {**schema, "recordScope": scope}


def test_the_service_strategies_are_the_contracts():
    assert run.SERVICE_STRATEGIES == CONTRACT["service_strategies"]
    assert set(run.SERVICE_STRATEGIES.values()) == set(CONTRACT["scopes"])


@pytest.mark.parametrize("row", CONTRACT["requests"], ids=lambda row: json.dumps(row))
def test_every_contract_request_is_admitted_or_refused_as_it_says(row):
    body = {"schema": definition(row["recordScope"]), "options": row["options"]}
    if not row["valid"]:
        with pytest.raises(ValidationError, match="record_scope_mismatch"):
            run.ExtractRequest.model_validate(body)
        return
    request = run.ExtractRequest.model_validate(body)
    assert request.record_scope == (row["recordScope"] or row["derived"])


@pytest.mark.parametrize("scope", ["document", "records"])
def test_the_declared_scope_round_trips_through_the_artifacts_schema_echo(scope):
    sent = definition(scope)
    assert Schema.model_validate(sent).model_dump(by_alias=True, exclude_none=True) == sent
    assert "recordScope" not in Schema.model_validate(definition(None)).model_dump(by_alias=True, exclude_none=True)
    with pytest.raises(ValidationError):
        Schema.model_validate({**sent, "recordScope": "rows"})


def fake_implementation(count: int, calls: list):
    def extract(run_dir, evidence, request, chat, **kwargs):
        calls.append(request.record_scope)
        return {"records": [{"entry_no": str(number)} for number in range(count)]}
    return extract


@pytest.mark.parametrize("row", CONTRACT["artifacts"], ids=lambda row: json.dumps(row))
def test_every_contract_artifact_is_published_or_refused_at_dispatch(row, monkeypatch):
    calls = []
    strategy = {"document": "article", "records": "catalog"}[row["recordScope"]]
    monkeypatch.setattr({"article": article, "catalog": catalog}[strategy], "extract",
                        fake_implementation(row["records"], calls))
    request = run.ExtractRequest.model_validate({"schema": definition(row["recordScope"]),
                                                 "options": {"strategy": strategy}})
    if row["accepted"]:
        assert len(run.dispatch(None, evidence(), request, FakeChat(dict))["records"]) == row["records"]
    else:
        with pytest.raises(run.RecordScopeViolation) as refused:
            run.dispatch(None, evidence(), request, FakeChat(dict))
        assert str(refused.value).startswith(CONTRACT["violation"]["reason_prefix"])
    assert calls == [row["recordScope"]]


@pytest.mark.parametrize("count", [0, 2])
def test_zero_or_several_article_roots_are_a_record_scope_violation_not_a_result(count, monkeypatch):
    """The cardinality holds for an undeclared (CLI, harness) Article too: its scope derives from the selection."""
    monkeypatch.setattr(article, "extract", fake_implementation(count, []))
    for schema in (definition("document"), definition(None)):
        request = run.ExtractRequest.model_validate({"schema": schema, "options": {"strategy": "article"}})
        with pytest.raises(run.RecordScopeViolation, match=r"^record_scope_violation: .*document.*" + str(count)):
            run.dispatch(None, evidence(), request, FakeChat(dict))


def test_the_unified_catalog_passes_the_same_cardinality_point(monkeypatch):
    calls = []
    monkeypatch.setattr(unified, "extract", fake_implementation(0, calls))
    request = run.ExtractRequest.model_validate({"schema": definition("records"),
                                                 "options": {"strategy": "catalog", "unified": {"defaults": 1}}})
    assert run.dispatch(None, evidence(), request, FakeChat(dict))["records"] == [] and calls == ["records"]


def test_the_document_root_keeps_every_array_item_across_value_contexts():
    """Unlike `reconcile_values` (document-level fields, the legacy Catalog), nothing is deduplicated: equal items
    read in different contexts stay, and are named as possible repeats; scalars still conflict to null."""
    first = {"title": "Report", "year": 1827, "place": None,
             "finds": [{"kind": "sword", "tags": ["iron"]}, {"kind": "urn", "tags": None}],
             "authors": ["Beier", "Hansen"], "site": {"name": "Hill", "parish": None}}
    second = {"title": "Report", "year": 1828, "place": "Ribe",
              "finds": [{"kind": "urn", "tags": None}, {"kind": "spear", "tags": ["iron", "iron"]}],
              "authors": ["Hansen"], "site": {"name": None, "parish": "Vedsted"}}
    root, conflicts, repeats, joined = contexts.assemble_document([first, second])
    assert root == {"title": "Report", "year": None, "place": "Ribe",
                    "finds": [{"kind": "sword", "tags": ["iron"]}, {"kind": "urn", "tags": None},
                              {"kind": "urn", "tags": None}, {"kind": "spear", "tags": ["iron", "iron"]}],
                    "authors": ["Beier", "Hansen", "Hansen"], "site": {"name": "Hill", "parish": "Vedsted"}}
    assert conflicts == [{"path": ["year"], "candidates": [1827, 1828]}]
    assert repeats == [{"path": ["finds"], "contexts": [0, 1], "indices": [1, 2]},
                       {"path": ["authors"], "contexts": [0, 1], "indices": [1, 2]}] and joined == []
    assert contexts.assemble_document([first]) == (first, [], [], [])
    assert contexts.assemble_document([]) == ({}, [], [], [])
    same_context = {"authors": ["Hansen", "Hansen"]}
    assert contexts.assemble_document([same_context, {"authors": None}]) == (same_context, [], [], [])


NESTED = Schema.model_validate({"recordDescription": "One excavation report.", "schemaNodes": [
    {"id": "t", "name": "title", "type": "string"},
    {"id": "y", "name": "year", "type": "integer"},
    {"id": "p", "name": "place", "type": "string"},
    {"id": "a", "name": "authors", "type": "array", "itemType": "string"},
    {"id": "f", "name": "finds", "type": "array", "children": [
        {"id": "k", "name": "kind", "type": "string"},
        {"id": "m", "name": "materials", "type": "array", "itemType": "string"}]},
]})


def grounded_by_first_label(system, user, schema):
    """Every claim attested by the first evidence offered: the semantic technique's reply."""
    return {claim: spec["enum"][0] for claim, spec in schema["properties"].items()}


def test_an_article_with_nested_arrays_is_one_root_with_evidence_for_every_leaf():
    source = passages(["Hill excavation, by Beier and Hansen.", "A sword of iron and bronze; an urn of clay."])
    reply = {"title": "Hill excavation", "year": None, "place": None, "authors": ["Beier", "Hansen"],
             "finds": [{"kind": "sword", "materials": ["iron", "bronze"]}, {"kind": "urn", "materials": ["clay"]}]}
    systems = []

    def script(system, user, schema):
        if "title" in schema["properties"]:
            systems.append(system)
            assert "Hill excavation" in user and "an urn of clay" in user  # the whole document, unsplit
            return reply
        return grounded_by_first_label(system, user, schema)
    request = run.ExtractRequest.model_validate({"schema": {**NESTED.model_dump(by_alias=True, exclude_none=True),
                                                            "recordScope": "document"},
                                                 "options": {"strategy": "article"}})
    result = run.dispatch(None, evidence(source), request, CountingChat(script),
                          counter={role: WordCounter() for role in ("fields", "reasoning")})
    assert result["records"] == [reply] and result["schema"]["recordScope"] == "document"
    assert result["inventory"] == [{"identity": {}, "label": article.DOCUMENT_LABEL, "passages": ["p1_s0", "p1_s1"]}]
    assert [call["stage"] for call in result["calls"]] == ["record", "grounding"]  # no identity inventory
    assert len(systems) == 1 and stages.DOCUMENT in systems[0] and "Extract ONLY the record" not in systems[0]
    leaves = [["records", 0, *path] for path, _ in stages.leaves(reply)]
    assert ["records", 0, "finds", 1, "materials", 0] in leaves and ["records", 0, "authors", 1] in leaves
    assert sorted(link["path"] for link in result["evidence"]) == sorted(leaves)
    assert not result["ungrounded"] and not result["issues"] and result["complete"]


def bounded_article(script, **method):
    """Article over two value contexts: each passage alone fills an 8192-token window."""
    source = passages(["Report by Beier. Finds: sword, urn. Dated 1827. " + "filler " * 3000,
                       "Finds: urn, spear. Dated 1828. Found at Ribe. " + "filler " * 3000])
    request = run.ExtractRequest.model_validate({"schema": NESTED.model_dump(by_alias=True, exclude_none=True),
        "options": {"strategy": "article", "article": {"context": "bounded", "context_tokens": 8192, **method}}})
    return run.dispatch(None, evidence(source), request, CountingChat(script),
                        counter={role: WordCounter() for role in ("fields", "reasoning")})


def two_parts(system, user, schema):
    if "title" not in schema["properties"]:  # grounding: nothing attested
        return {claim: ({"label": "NONE", "quote": "", "attribution": False} if spec.get("type") == "object"
                        else "NONE") for claim, spec in schema["properties"].items()}
    if "Report by Beier" in user:
        return {"title": None, "year": 1827, "place": None, "authors": ["Beier"],
                "finds": [{"kind": "sword", "materials": None}, {"kind": "urn", "materials": None}]}
    return {"title": None, "year": 1828, "place": "Ribe", "authors": None,
            "finds": [{"kind": "urn", "materials": None}, {"kind": "spear", "materials": None}]}


@pytest.mark.parametrize("method", [{"grounding": "off"}, {"grounding": "quoted", "grounding_schedule": "unresolved",
                                                           "grounding_routing": "origin_lexical"}])
def test_a_bounded_article_assembles_one_root_across_contexts_without_deduplicating_items(method):
    result = bounded_article(two_parts, **method)
    assert len(result["value_contexts"]) == 1 and len(result["value_contexts"][0]) == 2
    assert result["records"] == [{"title": None, "year": None, "place": "Ribe", "authors": ["Beier"],
        "finds": [{"kind": "sword", "materials": None}, {"kind": "urn", "materials": None},
                  {"kind": "urn", "materials": None}, {"kind": "spear", "materials": None}]}]
    assert result["conflicts"]["records"] == [{"record": 0, "path": ["year"], "candidates": [1827, 1828]}]
    issues = {issue["code"]: issue for issue in result["issues"]}
    assert json.loads(issues["possible_repeated_items"]["detail"]) == {
        "path": ["finds"], "contexts": [0, 1], "indices": [1, 2]}
    assert issues["possible_repeated_items"]["path"] == ["records", 0, "finds"]
    assert issues["conflicting_values"]["record"] == 0
    assert not any(call["stage"] == "inventory" for call in result["calls"])
    assert result["inventory"][0]["passages"] == ["p1_s0", "p1_s1"] and result["complete"] is False


ENTRIES = Schema.model_validate({"recordDescription": "One numbered catalogue entry.", "schemaNodes": [
    {"id": "e", "name": "entry", "type": "string"},
    {"id": "t", "name": "tags", "type": "array", "itemType": "string"},
    {"id": "f", "name": "finds", "type": "array", "children": [
        {"id": "k", "name": "kind", "type": "string"},
        {"id": "m", "name": "materials", "type": "array", "itemType": "string"}]},
]})


def test_a_records_scope_request_is_the_generic_catalogs_and_keeps_equal_items_of_different_records():
    source = passages(["12. Adorf. Finds: axe of iron, pin of bronze. Tags: grave, grave.",
                       "13. Bdorf. Finds: axe of iron. Tags: grave."])

    def script(system, user, schema):
        if "starts" in schema["properties"]:
            return {"starts": re.findall(r"\[(B\d+)\] \d+\.", user), "end": None}
        if "entry" not in schema["properties"]:
            return grounded_by_first_label(system, user, schema)
        if "12. Adorf" in user:
            return {"entry": "12", "tags": ["grave", "grave"], "finds": [
                {"kind": "axe", "materials": ["iron"]}, {"kind": "pin", "materials": ["bronze"]}]}
        return {"entry": "13", "tags": ["grave"], "finds": [{"kind": "axe", "materials": ["iron"]}]}
    request = run.ExtractRequest.model_validate({"schema": {**ENTRIES.model_dump(by_alias=True, exclude_none=True),
                                                            "recordScope": "records"},
                                                 "options": {"strategy": "catalog"}})
    result = run.dispatch(None, evidence(source), request, FakeChat(script))
    assert result["strategy"] == "catalog" and "inventory" not in result
    assert result["records"] == [
        {"entry": "12", "tags": ["grave", "grave"], "finds": [{"kind": "axe", "materials": ["iron"]},
                                                              {"kind": "pin", "materials": ["bronze"]}]},
        {"entry": "13", "tags": ["grave"], "finds": [{"kind": "axe", "materials": ["iron"]}]}]
    assert ["records", 1, "finds", 0, "materials", 0] in [link["path"] for link in result["evidence"]]


def test_a_records_scope_request_with_options_unified_is_the_unified_catalogs():
    from tests import test_unified_catalog as unified_tests
    source = unified_tests.evidence("12. Adorf. Material: Bronze. Find: Axe (1). Find: Pin (2).\n"
                                    "13. Bdorf. Material: Eisen. Find: Axe (1).")
    request = run.ExtractRequest.model_validate({"schema": {**unified_tests.SCHEMA, "recordScope": "records"},
        "options": {"strategy": "catalog", "unified": {"defaults": 1}}})
    result = run.dispatch(None, source, request, CountingChat(unified_tests.Model(source)), counter=WordCounter())
    assert result["extraction_version"] == 3 and result["schema"]["recordScope"] == "records"
    assert [record["finds"] for record in result["records"]] == [
        [{"name": "Axe", "count": 1}, {"name": "Pin", "count": 2}], [{"name": "Axe", "count": 1}]]
