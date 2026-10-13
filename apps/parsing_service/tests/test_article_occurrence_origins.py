"""List occurrences keep their own reply coordinates through Article grounding and retained publication."""
from copy import deepcopy
from dataclasses import replace

import pytest

from kei_exp.kie.extract import article, run
from kei_exp.kie.extract.contexts import Context, assemble_document
from kei_exp.kie.extract.models import Router
from kei_exp.kie.extract.routing import value_origins
from tests.test_durable_extraction import MemoryLease, finish, linked_while_running
from tests.test_extract_grounded import CountingChat, WordCounter
from tests.test_extract_stages import evidence, passages


def test_disjoint_equal_items_keep_only_their_actual_reading_and_position():
    readings = [{"fees": [10, 10], "title": "Book", "year": 1800},
                {"fees": [10], "title": "Book", "year": 1801}]
    original = deepcopy(readings)
    item_sources = {}
    root, conflicts, _, _ = assemble_document(readings, item_sources=item_sources)
    origins = {tuple(each["path"]): each["sources"] for each in
               value_origins(readings, root, {}, [], item_sources=item_sources)}
    assert root == {"fees": [10, 10, 10], "title": "Book", "year": None} and conflicts
    assert origins == {
        ("fees", 0): [{"unit": 0, "path": ["fees", 0]}],
        ("fees", 1): [{"unit": 0, "path": ["fees", 1]}],
        ("fees", 2): [{"unit": 1, "path": ["fees", 0]}],
        ("title",): [{"unit": 0, "path": ["title"]}, {"unit": 1, "path": ["title"]}],
    }
    assert readings == original


def test_overlap_joins_only_its_contributing_occurrences_and_preserves_nested_positions():
    item = {"name": "urn", "parts": [{"material": "clay"}, {"material": "clay"}]}
    readings = [{"site": {"finds": [deepcopy(item), deepcopy(item)]}},
                {"site": {"finds": [deepcopy(item)]}}]
    original = deepcopy(readings)
    item_sources = {}
    root, _, _, joined = assemble_document(readings, lambda *_: True, item_sources=item_sources)
    origins = {tuple(each["path"]): each["sources"] for each in
               value_origins(readings, root, {}, [], item_sources=item_sources)}
    assert root["site"]["finds"] == [item, item]
    assert joined == [{"path": ["site", "finds"], "contexts": [0, 1], "index": 0}]
    for index in (0, 1):
        assert origins[("site", "finds", 0, "parts", index, "material")] == [
            {"unit": unit, "path": ["site", "finds", 0, "parts", index, "material"]} for unit in (0, 1)]
        assert origins[("site", "finds", 1, "parts", index, "material")] == [
            {"unit": 0, "path": ["site", "finds", 1, "parts", index, "material"]}]
    assert readings == original


def test_an_empty_occurrence_map_never_falls_back_to_value_equality():
    readings, root = [{"fees": [10]}, {"fees": [10]}], {"fees": [10]}
    assert len(value_origins(readings, root, {}, [])[0]["sources"]) == 2  # captured union studies
    assert value_origins(readings, root, {}, [], strict=False, item_sources={}) == [
        {"path": ["fees", 0], "kind": "value", "sources": []}]
    with pytest.raises(ValueError, match="no extraction origin"):
        value_origins(readings, root, {}, [], item_sources={})
    item_sources = {("fees", 0): [{"unit": 0, "path": ["fees", 0]}]}
    assert value_origins(readings, {"fees": [20]}, {}, [], strict=False, item_sources=item_sources)[0]["sources"] == []


def occurrence_input(monkeypatch, grounding):
    source = replace(evidence(passages(["Fee 10."]) + passages(["Fee 10."], page=2)), page_count=2)
    contexts = [Context((p,)) for p in source.passages]
    monkeypatch.setattr(article, "source_contexts", lambda *_: contexts)
    monkeypatch.setattr(article, "partition", lambda *_args, **_kwargs: contexts)
    request = run.ExtractRequest(schema={"recordDescription": "One document of charges.", "recordScope": "document",
        "schemaNodes": [{"id": "fees", "name": "fees", "type": "array", "itemType": "integer"}]},
        options={"strategy": "article", "article": {"context": "bounded", "grounding": grounding}})
    return source, request


def occurrence_reply(system, user, schema):
    if "### Claims" not in user:
        return {"fees": [10]}
    answer = {}
    for claim, shape in schema["properties"].items():
        if "enum" in shape:
            answer[claim] = shape["enum"][0]
        else:
            answer[claim] = {"label": shape["properties"]["label"]["enum"][0], "attribution": True}
            if "quote" in shape["properties"]:
                answer[claim]["quote"] = "10"
    return answer


@pytest.mark.parametrize("grounding", ["semantic", "quoted", "spans"])
def test_each_equal_occurrence_is_grounded_first_in_its_own_source(monkeypatch, grounding):
    source, request = occurrence_input(monkeypatch, grounding)
    chat = CountingChat(occurrence_reply)
    result = run.dispatch(None, source, request, Router(chat, chat),
        counter={role: WordCounter() for role in ("fields", "reasoning")})
    assert result["records"] == [{"fees": [10, 10]}]
    assert {tuple(link["path"]): link["segment"] for link in result["evidence"]} == {
        ("records", 0, "fees", 0): "p1_s0", ("records", 0, "fees", 1): "p2_s0"}
    assert result["grounding"]["supported"] == 2
    assert len([call for call in result["calls"] if call["stage"] == "grounding"]) == 2


def test_normalized_reading_positions_survive_null_items_and_later_page_first(monkeypatch):
    source, request = occurrence_input(monkeypatch, "spans")
    request = request.model_copy(update={"options": request.options.model_copy(update={"start_page": 2})})

    def answer(system, user, schema):
        return {"fees": [None, 10, None]} if "### Claims" not in user else occurrence_reply(system, user, schema)

    chat = CountingChat(answer)
    result = run.dispatch(None, source, request, Router(chat, chat),
        counter={role: WordCounter() for role in ("fields", "reasoning")})
    assert result["records"] == [{"fees": [10, 10]}]
    assert {tuple(link["path"]): link["segment"] for link in result["evidence"]} == {
        ("records", 0, "fees", 0): "p1_s0", ("records", 0, "fees", 1): "p2_s0"}


def test_an_unsupported_origin_still_searches_other_contexts(monkeypatch):
    source, request = occurrence_input(monkeypatch, "spans")
    checked = []

    def answer(system, user, schema):
        if "### Claims" in user:
            second = "p2_s0" in user
            checked.append(2 if second else 1)
            if second:
                return {claim: {"label": "NONE", "attribution": False} for claim in schema["properties"]}
        return occurrence_reply(system, user, schema)

    chat = CountingChat(answer)
    result = run.dispatch(None, source, request, Router(chat, chat),
        counter={role: WordCounter() for role in ("fields", "reasoning")})
    assert checked == [1, 2, 1]
    assert result["grounding"]["supported"] == 2
    assert {link["segment"] for link in result["evidence"]} == {"p1_s0"}  # origins do not prove support


def test_occurrence_evidence_is_retained_while_running_and_replayed_without_more_calls(monkeypatch):
    source, request = occurrence_input(monkeypatch, "spans")
    lease = MemoryLease(request.schema_.model_dump(by_alias=True, exclude_none=True))
    chat = CountingChat(occurrence_reply)
    extract = lambda router, counter: run.dispatch(None, source, request, router,
        counter={"fields": counter, "reasoning": counter})
    result = finish(lease, chat, extract)
    running, final = linked_while_running(lease)
    assert running and running == final
    for saved in final.values():
        assert {tuple(each["producer"]["path"]): each["producer"]["segment"] for each in saved} == {
            ("records", 0, "fees", 0): "p1_s0", ("records", 0, "fees", 1): "p2_s0"}
    count = len(chat.calls)
    assert finish(lease, chat, extract)["evidence"] == result["evidence"]
    assert len(chat.calls) == count
