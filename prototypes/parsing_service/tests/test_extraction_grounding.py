"""Grounding is an interchangeable technique: `run.extract` calls whatever `grounding.technique` returns."""
import pytest

from kei_exp.kie.extract import grounding, run
from kei_exp.kie.extract.models import Router
from kei_exp.kie.extract.stages import Link
from tests.test_extract_grounded import CountingChat, WordCounter
from tests.test_extract_stages import SCHEMA, evidence, passages


@pytest.mark.parametrize("choice,expected", [(None, grounding.semantic), ("semantic", grounding.semantic),
                                             ("quoted", grounding.quoted), ("spans", grounding.spans), ("off", grounding.off)])
def test_every_article_grounding_choice_and_the_reference_name_a_technique(choice, expected):
    assert grounding.technique(choice) is expected


def recording(received):
    """A substitute technique: it records what it was given and links each record's year to its first passage."""
    def ground(passages, fields, schema, chat, *, record, budget, counter, record_context, before_call, proofs, skip_paths):
        received.append({"record": record, "passages": [p.id for p in passages], "counter": counter,
                         "record_context": record_context})
        first = passages[0]
        return [Link(("records", record, "year"), first.id, first.page, first.bbox_pt, False, 0, "substitute")], [], []
    return ground


def test_a_substituted_technique_grounds_each_articles_contexts_once_per_record_without_run_changes(monkeypatch):
    source = passages(["Hill and Brook " + "context " * 3000, "methods " * 3000, "Results: Hill 1827. Brook 1828."])
    monkeypatch.setattr(run, "load", lambda _: evidence(source))
    chosen, received = [], []
    monkeypatch.setattr(grounding, "technique", lambda choice: chosen.append(choice) or recording(received))

    def reason(system, user, schema):
        assert "records" in schema["properties"], "the substitute replaces every grounding call"
        shown = schema["properties"]["records"]["items"]["properties"]["passages"]["items"]["enum"]
        return {"records": [{"label": name, "identity": {"site": name}, "passages": shown[:1]}
                            for name in ("Hill", "Brook")]}

    def fields(system, user, schema):
        return {"title": None} if "title" in schema["properties"] else {"year": 1827}
    request = run.ExtractRequest(schema=SCHEMA, options={"strategy": "article", "article": {
        "context": "bounded", "context_tokens": 8192, "identity": "conservative", "identity_fields": ["site"],
        "grounding": "quoted"}})
    result = run.extract(None, request, Router(CountingChat(fields), CountingChat(reason)),
                         counter={role: WordCounter() for role in ("fields", "reasoning")})
    contexts = [[*context["overlap"], *context["primary"]] for context in result["contexts"]]
    assert chosen == ["quoted"] and len(contexts) >= 2 and len(result["records"]) == 2
    assert [(item["record"], item["passages"]) for item in received] == [
        (record, group) for record in range(2) for group in contexts]
    assert all(item["counter"] is not None and item["record_context"] for item in received)
    assert not any(call["stage"] == "grounding" for call in result["calls"])
    assert [(link["path"], link["linked_by"]) for link in result["evidence"]] == [
        (["records", record, "year"], "substitute") for record in range(2)]
    assert ["records", 0, "year"] not in result["ungrounded"]


def test_the_version_1_catalog_grounds_each_record_through_the_reference_technique_lookup(monkeypatch):
    monkeypatch.setattr(run, "load", lambda _: evidence())
    chosen, received = [], []
    monkeypatch.setattr(grounding, "technique", lambda choice: chosen.append(choice) or recording(received))

    def script(system, user, schema):
        if "starts" in schema["properties"]:
            return {"starts": ["B2", "B4"], "end": "B5"}
        return {"title": None} if "title" in schema["properties"] else {"entry_no": "31", "year": 1827}
    result = run.extract(None, run.ExtractRequest(schema=SCHEMA), CountingChat(script))
    assert chosen == [None]
    assert received == [{"record": 0, "passages": ["p1_s1", "p1_s2"], "counter": None, "record_context": None},
                        {"record": 1, "passages": ["p1_s3"], "counter": None, "record_context": None}]
    assert all(link["linked_by"] == "substitute" for link in result["evidence"])
