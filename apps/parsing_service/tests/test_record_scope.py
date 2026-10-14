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
from tests.test_extract_grounded import CountingChat, WordCounter, resolving
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
             "authors": ["Bauer", "Hansen"], "site": {"name": "Hill", "parish": None}}
    second = {"title": "Report", "year": 1828, "place": "Ribe",
              "finds": [{"kind": "urn", "tags": None}, {"kind": "spear", "tags": ["iron", "iron"]}],
              "authors": ["Hansen"], "site": {"name": None, "parish": "Vedsted"}}
    root, conflicts, repeats, joined = contexts.assemble_document([first, second])
    assert root == {"title": "Report", "year": None, "place": "Ribe",
                    "finds": [{"kind": "sword", "tags": ["iron"]}, {"kind": "urn", "tags": None},
                              {"kind": "urn", "tags": None}, {"kind": "spear", "tags": ["iron", "iron"]}],
                    "authors": ["Bauer", "Hansen", "Hansen"], "site": {"name": "Hill", "parish": "Vedsted"}}
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
    source = passages(["Hill excavation, by Bauer and Hansen.", "A sword of iron and bronze; an urn of clay."])
    reply = {"title": "Hill excavation", "year": None, "place": None, "authors": ["Bauer", "Hansen"],
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
    source = passages(["Report by Bauer. Finds: sword, urn. Dated 1827. " + "filler " * 3000,
                       "Finds: urn, spear. Dated 1828. Found at Ribe. " + "filler " * 3000])
    request = run.ExtractRequest.model_validate({"schema": NESTED.model_dump(by_alias=True, exclude_none=True),
        "options": {"strategy": "article", "article": {"context": "bounded", "context_tokens": 8192, **method}}})
    return run.dispatch(None, evidence(source), request, CountingChat(script),
                        counter={role: WordCounter() for role in ("fields", "reasoning")})


def settle(user: str, schema: dict, **choices) -> dict:
    """A resolution answer by field name: a label, NONE or UNSURE per scalar place, each item's label per list place."""
    names = dict(re.findall(r"^([SL]\d+) · (\S+)", user, re.MULTILINE))
    return {key: choices[names[key]] for key in schema["properties"]}


def two_parts(system, user, schema):
    if resolving(user):  # the year stays open, Ribe is the place, the second context's urn repeats the first's
        return settle(user, schema, year="UNSURE", place="C1", authors={"I1": "OWN"},
                      finds={"I1": "OWN", "I2": "OWN", "I3": "REPEAT", "I4": "OWN"})
    if "title" not in schema["properties"]:  # grounding: nothing attested
        return {claim: ({"label": "NONE", "quote": "", "attribution": False} if spec.get("type") == "object"
                        else "NONE") for claim, spec in schema["properties"].items()}
    if "Report by Bauer" in user:
        return {"title": None, "year": 1827, "place": None, "authors": ["Bauer"],
                "finds": [{"kind": "sword", "materials": None}, {"kind": "urn", "materials": None}]}
    return {"title": None, "year": 1828, "place": "Ribe", "authors": None,
            "finds": [{"kind": "urn", "materials": None}, {"kind": "spear", "materials": None}]}


@pytest.mark.parametrize("method", [{"grounding": "off"}, {"grounding": "quoted", "grounding_schedule": "unresolved",
                                                           "grounding_routing": "origin_lexical"}])
def test_a_bounded_article_resolves_one_root_across_contexts(method):
    """Each context answers the whole root; the model then settles each place: an UNSURE year stays a Value
    Disagreement, Ribe (read by one context only) is confirmed, and the urn the second context repeats is dropped."""
    result = bounded_article(two_parts, **method)
    assert len(result["value_contexts"]) == 1 and len(result["value_contexts"][0]) == 2
    assert result["records"] == [{"title": None, "year": None, "place": "Ribe", "authors": ["Bauer"],
        "finds": [{"kind": "sword", "materials": None}, {"kind": "urn", "materials": None},
                  {"kind": "spear", "materials": None}]}]
    assert result["conflicts"]["records"] == [{"record": 0, "path": ["year"], "candidates": [1827, 1828]}]
    issues = {issue["code"]: issue for issue in result["issues"]}
    assert "possible_repeated_items" not in issues  # the resolved list has no unsettled repeats
    assert json.loads(issues["dropped_items"]["detail"]) == {"path": ["finds"],
                                                             "dropped": [{"kind": "urn", "materials": None}]}
    assert json.loads(issues["resolved_value"]["detail"]) == {"path": ["place"], "chosen": "Ribe",
                                                              "alternatives": ["Ribe"]}
    assert issues["conflicting_values"]["record"] == 0
    assert sum(call["stage"] == "arbitration" for call in result["calls"]) == 1
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


def disagreement_article_input(start_page=None, grounding="off"):
    """Three independent bounded readings of an Article and its bibliography: A / null / C."""
    nodes = [{"id": "title-id", "name": "title", "type": "string"},
             {"id": "year-id", "name": "year", "type": "integer"},
             {"id": "authors-id", "name": "authors", "type": "array", "itemType": "string"}]
    request = run.ExtractRequest.model_validate({"schema": {"recordDescription": "The observed article.",
        "recordScope": "document", "schemaNodes": nodes}, "options": {"strategy": "article", "start_page": start_page,
        "article": {"context": "bounded", "context_tokens": 8192, "grounding": grounding}}})
    source = sum((passages([text + " filler" * 3000], page=index+1) for index, text in enumerate([
        "Observed article: The observed article. Year 1827. Author A.",
        "No title or year here. Author B.", "Bibliography: The cited title. Year 1828. Author C."])), [])
    return request, evidence(source)


def disagreement_article_reply(system, user, schema):
    if "title" in schema["properties"]:
        if "Observed article:" in user:
            return {"title": "The observed article", "year": 1827, "authors": ["A"]}
        if "Bibliography:" in user:
            return {"title": "The cited title", "year": 1828, "authors": ["C"]}
        return {"title": None, "year": None, "authors": ["B"]}
    from tests.test_article_claims_contract import quoting
    return quoting(system, user, schema)


def disagreement_article(start_page=None, grounding="off"):
    request, source = disagreement_article_input(start_page, grounding)
    return run.dispatch(None, source, request, CountingChat(disagreement_article_reply),
                        counter={role: WordCounter() for role in ("fields", "reasoning")})


def test_value_disagreements_keep_each_reading_of_the_observed_article_and_cited_title():
    result = disagreement_article()
    assert len(result["value_contexts"][0]) == 3
    assert result["records"] == [{"title": None, "year": None, "authors": ["A", "B", "C"]}]
    assert {tuple(d["path"]): [a["value"] for a in d["alternatives"]] for d in result["disagreements"]} == {
        ("title-id",): ["The observed article", "The cited title"], ("year-id",): [1827, 1828]}
    for entry in result["disagreements"]:
        assert entry["names"] in (["title"], ["year"])
        assert [a["segments"] for a in entry["alternatives"]] == [["p1_s0"], ["p3_s0"]]


def test_a_disagreement_is_the_same_whatever_page_the_run_starts_at():
    results = [disagreement_article(page) for page in (None, 1, 3)]
    assert all(result["disagreements"] == results[0]["disagreements"] for result in results)
    assert all(result["records"] == results[0]["records"] for result in results)


def test_value_disagreements_name_a_nested_child_by_id_and_never_enter_lists():
    schema = Schema.model_validate({"recordDescription": "An article", "schemaNodes": [
        {"id": "work-id", "name": "work", "type": "object", "children": [
            {"id": "title-id", "name": "title", "type": "string"}, {"id": "year-id", "name": "year", "type": "integer"}]},
        {"id": "items-id", "name": "items", "type": "array", "itemType": "string"}]})
    readings = [{"work": {"title": "A", "year": 1827}, "items": ["A"]},
                {"work": {"title": "C", "year": 1827}, "items": ["C"]}]
    root, conflicts, _, _ = contexts.assemble_document(readings)
    found = contexts.value_disagreements(readings, conflicts, schema.nodes)
    assert root == {"work": {"title": None, "year": 1827}, "items": ["A", "C"]}
    assert found == [{"path": ["work-id", "title-id"], "names": ["work", "title"],
        "alternatives": [{"value": "A", "readings": [0]}, {"value": "C", "readings": [1]}]}]


def test_an_article_with_a_disagreement_never_reports_grounding_complete():
    result = disagreement_article(grounding="quoted")
    assert result["completion"]["grounding"] == "partial"
    assert result["grounding"]["reasons"]["conflicting_values"] == 2
    assert result["grounding"]["claims"] == 5
    assert all("verdict" not in a for d in result["disagreements"] for a in d["alternatives"])


@pytest.mark.parametrize("kind,value,valid", [
    ("string", "A", True), ("string", 5, False), ("string", ["x"], False), ("string", " ", False),
    ("integer", 1827, True), ("integer", 1827.0, False), ("integer", True, False),
    ("number", 1.5, True), ("number", float("inf"), False), ("number", float("nan"), False),
    ("boolean", False, True), ("boolean", 0, False), ("date", "1827", True), ("string", None, False),
    ("integer", 10**400, True),
])
def test_typed_reads_a_scalar_as_valid_value_does(kind, value, valid):
    from kei_exp.kie.extract.schema import Node, typed
    assert typed(value, Node(id="value", name="value", type=kind)) is valid


def test_typed_reads_a_label_only_from_its_allowed_values():
    from kei_exp.kie.extract.schema import Node, typed
    labelled = Node(id="sex", name="sex", type="string", allowedValues=["mand", "kvinde"])
    assert typed("mand", labelled) and not typed("female", labelled)


@pytest.mark.parametrize("middle,cited,title,invalid", [
    ({}, {"title": 5}, "The observed article", [{"path": ["title"], "value": 5}]),
    ({"title": ["x"]}, {}, None, [{"path": ["title"], "value": ["x"]}]),
    ({"year": 1827.0}, {}, None, []),
])
def test_a_reading_not_of_its_type_is_null_before_assembly(middle, cited, title, invalid):
    """A valid reading and an invalid one make the valid value, the invalid one an issue; a whole-number float is the
    integer it reads as."""
    def reply(system, user, schema):
        answer = disagreement_article_reply(system, user, schema)
        if "title" in schema["properties"]:
            answer.update(cited if "Bibliography:" in user else middle if "No title" in user else {})
        return answer
    request, source = disagreement_article_input()
    result = run.dispatch(None, source, request, CountingChat(reply),
                          counter={role: WordCounter() for role in ("fields", "reasoning")})
    assert result["records"][0]["title"] == title
    alternatives = {tuple(d["names"]): [a["value"] for a in d["alternatives"]] for d in result["disagreements"]}
    assert alternatives == {**({} if title else {("title",): ["The observed article", "The cited title"]}),
                            ("year",): [1827, 1828]}
    assert [type(value) for value in alternatives[("year",)]] == [int, int]
    assert [json.loads(issue["detail"]) for issue in result["issues"] if issue["code"] == "invalid_value"] == invalid
