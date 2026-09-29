"""Evidence selection retains source units and exposes omissions rather than asserting recall."""
import dataclasses

import pytest

from kei_exp.kie.extract.contexts import Context
from kei_exp.kie.extract.method import ArticleOptions
from kei_exp.kie.extract.schema import Schema
from kei_exp.kie.extract.selection import select_contexts
from tests.test_extract_stages import SCHEMA, passages


def test_support_neighbors_and_shared_methods_are_retained_without_joining_units():
    source = passages(["preface", "preceding qualifier", "Subject Alpha", "following qualifier",
                       "unrelated acknowledgments", "temperature measured with calorimetry", "bibliography"])
    source[5] = dataclasses.replace(source[5], label="Table")
    units = [Context((p,)) for p in source]
    schema = Schema.model_validate({"recordDescription": "One subject", "schemaNodes": [
        {"id": "temperature", "name": "temperature", "type": "number",
         "description": "temperature measured with calorimetry"}]})
    selected, trace = select_contexts(units, source, [source[2].id], schema)
    assert selected == [units[i] for i in (1, 2, 3, 5)]
    assert selected[-1] is units[5] and selected[-1].primary[0] is source[5]
    assert trace["omitted_units"] == [0, 4, 6]
    assert trace["selected_units"][-1] == {"index": 5, "reasons": ["schema_context"]}
    assert trace["relevance_recall"] == "unmeasured"
    assert set(trace["selected_passages"]).isdisjoint(trace["omitted_passages"])
    assert set(trace["selected_passages"] + trace["omitted_passages"]) == {p.id for p in source}


def test_support_in_overlap_does_not_replace_its_primary_owner():
    source = passages(["Alpha", "qualifier", "irrelevant", "irrelevant"])
    units = [Context((source[0],)), Context((source[1],), (source[0],)),
             Context(tuple(source[2:]), (source[1],))]
    selected, trace = select_contexts(units, source, [source[0].id], SCHEMA)
    assert selected == units[:2]
    assert trace["selected_units"] == [
        {"index": 0, "reasons": ["identity_support"]},
        {"index": 1, "reasons": ["neighboring_passage"]}]


@pytest.mark.parametrize("support", [[], ["foreign"]])
def test_missing_or_foreign_support_is_an_explicit_error(support):
    source = passages()
    with pytest.raises(ValueError, match="canonical inventory support"):
        select_contexts([Context(tuple(source))], source, support, SCHEMA)


def test_selection_requires_bounded_context_and_does_not_change_default_serialization():
    with pytest.raises(ValueError, match="requires bounded"):
        ArticleOptions(selection="supported")
    assert "selection" not in ArticleOptions().model_dump()
    assert "selection" not in ArticleOptions(context="bounded").model_dump(mode="json")
    assert ArticleOptions(context="bounded", selection="supported").model_dump()["selection"] == "supported"


def test_pipeline_omits_unselected_value_calls_but_preserves_inventory_coverage(monkeypatch):
    from kei_exp.kie.extract import run
    from kei_exp.kie.extract.models import Router
    from tests.test_extract_grounded import CountingChat, WordCounter
    from tests.test_extract_stages import evidence

    source = passages(["Alpha " + "description " * 3000, "qualifier " * 3000,
                       "unrelated " * 3000, "temperature calorimetry " * 1500,
                       "bibliography " * 3000])
    monkeypatch.setattr(run, "load", lambda _: evidence(source))
    schema = Schema.model_validate({"recordDescription": "One subject", "schemaNodes": [
        {"id": "site", "name": "site", "type": "string"},
        {"id": "temperature", "name": "temperature", "type": "number",
         "description": "temperature calorimetry"}]})
    seen = {"inventory": [], "fields": []}

    def inventory(system, user, reply_schema):
        seen["inventory"].append(user)
        return {"records": [{"label": "Alpha", "identity": {"site": "Alpha"},
                              "passages": [source[0].id]}] if "Alpha" in user else []}

    def fields(system, user, reply_schema):
        seen["fields"].append(user)
        return {"site": "Alpha", "temperature": 42 if "calorimetry" in user else None}

    request = run.ExtractRequest(schema=schema, options={"strategy": "article", "article": {
        "context": "bounded", "context_tokens": 8192, "selection": "supported", "prompt": "schema",
        "identity": "conservative", "identity_fields": ["site"], "grounding": "off"}})
    result = run.extract(None, request, Router(CountingChat(fields), CountingChat(inventory)),
                         counter={role: WordCounter() for role in ("fields", "reasoning")})
    assert len(seen["inventory"]) == 5 and len(seen["fields"]) == 3
    assert result["records"][0]["temperature"] == 42
    assert not any("bibliography" in user or "unrelated" in user for user in seen["fields"])
    assert result["selections"][0]["omitted_units"] == [2, 4]
    assert result["selection_version"] == 1 and not result["complete"]
