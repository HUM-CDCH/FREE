"""Resolution filters assembled occurrences without rewriting their original readings."""
from copy import deepcopy
from dataclasses import replace

import pytest

from kei_exp.kie.extract.contexts import Context, assemble_document
from kei_exp.kie.extract.resolution import resolve
from kei_exp.kie.extract.routing import value_origins
from kei_exp.kie.extract.schema import Schema
from kei_exp.kie.extract import run
from kei_exp.kie.extract.models import Router
from tests.test_article_occurrence_origins import occurrence_input, occurrence_reply
from tests.test_durable_extraction import MemoryLease, finish, linked_while_running
from tests.test_extract_grounded import CountingChat, WordCounter, keeps_every_reading, resolving
from tests.test_extract_stages import passages


SCHEMA = Schema(schemaNodes=[{"id": "finds", "name": "finds", "type": "array",
    "children": [{"id": "name", "name": "name", "type": "string"},
                 {"id": "parts", "name": "parts", "type": "array", "itemType": "string"}]}],
    recordDescription="One document's finds")
ITEM = {"name": "urn", "parts": ["clay", "clay"]}


def assembled(readings, chat, *, overlap=False, counter=None):
    groups = [Context(tuple(passages(["An urn made from clay."], page=index + 1))) for index in range(len(readings))]
    item_sources = {}
    root, conflicts, repeats, joined = assemble_document(readings, lambda *_: overlap, item_sources=item_sources)
    result = resolve(readings, groups, root, conflicts, repeats, joined, SCHEMA, chat, counter or WordCounter(),
                     item_sources=item_sources)
    return result, item_sources


def test_keep_all_never_reintroduces_an_overlap_join_and_keeps_nested_origins():
    readings = [{"finds": [deepcopy(ITEM), deepcopy(ITEM)]}, {"finds": [deepcopy(ITEM)]}]
    original = deepcopy(readings)
    chat = CountingChat(lambda s, u, schema: keeps_every_reading(schema))
    (root, _, _, joined, _, _), item_sources = assembled(readings, chat, overlap=True)
    assert root["finds"] == [ITEM, ITEM]
    assert chat.calls[0]["schema"]["properties"]["L1"]["items"]["enum"] == ["I1", "I2"]
    assert joined == [{"path": ["finds"], "contexts": [0, 1], "index": 0}]
    origins = {tuple(entry["path"]): entry["sources"] for entry in
               value_origins(readings, root, {}, [], item_sources=item_sources)}
    for index in (0, 1):
        assert origins[("finds", 0, "parts", index)] == [
            {"unit": unit, "path": ["finds", 0, "parts", index]} for unit in (0, 1)]
        assert origins[("finds", 1, "parts", index)] == [
            {"unit": 0, "path": ["finds", 1, "parts", index]}]
    assert readings == original


def test_dropping_the_first_equal_item_moves_only_the_kept_occurrence_origins():
    readings = [{"finds": [deepcopy(ITEM)]}, {"finds": [deepcopy(ITEM)]}]
    (root, _, _, _, _, issues), item_sources = assembled(readings, CountingChat(lambda *_: {"L1": ["I2"]}))
    assert root["finds"] == [ITEM]
    assert item_sources == {("finds", 0): [{"unit": 1, "path": ["finds", 0]}]}
    assert [entry["sources"] for entry in value_origins(readings, root, {}, [], item_sources=item_sources)] == [
        [{"unit": 1, "path": ["finds", 0, "name"]}],
        [{"unit": 1, "path": ["finds", 0, "parts", 0]}],
        [{"unit": 1, "path": ["finds", 0, "parts", 1]}]]
    assert issues[0].code == "dropped_items"


@pytest.mark.parametrize("keep,expected", [(["I2"], [{"path": ["finds"], "contexts": [0, 1], "index": 0}]),
                                          (["I1"], [])])
def test_overlap_diagnostics_follow_kept_indices(keep, expected):
    readings = [{"finds": [{"name": "sword", "parts": []}, deepcopy(ITEM)]}, {"finds": [deepcopy(ITEM)]}]
    (_, _, _, joined, _, _), _ = assembled(readings, CountingChat(lambda *_: {"L1": keep}), overlap=True)
    assert joined == expected


@pytest.mark.parametrize("answer", [{"L1": ["foreign"]}, {"L1": [{}]}, {"L1": "UNSURE"}])
def test_invalid_list_answers_keep_assembly_and_its_origins(answer):
    readings = [{"finds": [deepcopy(ITEM)]}, {"finds": [deepcopy(ITEM)]}]
    (root, _, repeats, _, _, issues), item_sources = assembled(readings, CountingChat(lambda *_: answer))
    assert root["finds"] == [ITEM, ITEM] and repeats and not issues
    assert item_sources == {("finds", index): [{"unit": index, "path": ["finds", 0]}] for index in (0, 1)}


def test_a_failed_resolution_keeps_values_and_records_a_recovered_failed_call():
    class Failed(CountingChat):
        def complete(self, **kwargs):
            return replace(super().complete(**kwargs), text="{", finish="length")
    readings = [{"finds": [deepcopy(ITEM)]}, {"finds": [deepcopy(ITEM)]}]
    (root, _, repeats, _, calls, issues), item_sources = assembled(readings, Failed(lambda *_: {}))
    assert root["finds"] == [ITEM, ITEM] and repeats and len(item_sources) == 2
    assert len(calls) == 1 and not calls[0].ok and calls[0].recovered
    assert issues[0].code == "resolution_failed"


def test_a_parsed_reply_with_a_wrong_token_count_never_drops_assembled_items():
    class WrongCount(CountingChat):
        def complete(self, **kwargs):
            return replace(super().complete(**kwargs), input_tokens=1)
    readings = [{"finds": [deepcopy(ITEM)]}, {"finds": [deepcopy(ITEM)]}]
    (root, _, repeats, _, calls, issues), item_sources = assembled(readings, WrongCount(lambda *_: {"L1": ["I2"]}))
    assert root["finds"] == [ITEM, ITEM] and repeats and len(item_sources) == 2
    assert len(calls) == 1 and not calls[0].ok and calls[0].recovered
    assert "server reported 1" in calls[0].error
    assert [issue.code for issue in issues] == ["resolution_failed"]


def test_one_failed_list_part_preserves_the_entire_assembled_list():
    readings = [{"finds": [deepcopy(ITEM) for _ in range(61)]}, {"finds": []}]
    (root, _, _, _, _, issues), item_sources = assembled(readings,
        CountingChat(lambda *_: {"L1": [], "L2": "UNSURE"}))
    assert len(root["finds"]) == len(item_sources) == 61 and not issues


def test_an_oversized_resolution_keeps_assembly_before_durable_call_admission():
    class SmallCounter(WordCounter):
        context_tokens = 1

    class Runtime:
        def complete(self, *args, **kwargs):
            pytest.fail("an oversized optional resolution must not be admitted")

    chat = CountingChat(lambda *_: pytest.fail("an oversized request must not reach the provider"))
    readings = [{"finds": [deepcopy(ITEM)]}, {"finds": [deepcopy(ITEM)]}]
    (root, _, repeats, _, calls, issues), item_sources = assembled(readings, Router(chat, chat, runtime=Runtime()),
                                                                 counter=SmallCounter())
    assert root["finds"] == [ITEM, ITEM] and repeats and len(item_sources) == 2 and not calls
    assert issues[0].code == "resolution_exceeds_budget"


def test_failed_resolution_does_not_make_article_processing_incomplete(monkeypatch):
    source, request = occurrence_input(monkeypatch, "off")

    class FailedResolution(CountingChat):
        def complete(self, **kwargs):
            reply = super().complete(**kwargs)
            return replace(reply, text="{", finish="length") if resolving(kwargs["user"]) else reply

    result = run.dispatch(None, source, request, FailedResolution(occurrence_reply),
        counter={role: WordCounter() for role in ("fields", "reasoning")})
    assert result["records"] == [{"fees": [10, 10]}]
    assert result["completion"]["processing"]
    call = next(call for call in result["calls"] if call["stage"] == "arbitration")
    assert not call["ok"] and call["recovered"]
    assert "resolution_failed" in {issue["code"] for issue in result["issues"]}


@pytest.mark.parametrize("grounding", ["semantic", "quoted", "spans"])
def test_a_kept_later_occurrence_is_grounded_and_retained_in_its_own_source(monkeypatch, grounding):
    source, request = occurrence_input(monkeypatch, grounding)
    lease = MemoryLease(request.schema_.model_dump(by_alias=True, exclude_none=True))
    chat = CountingChat(lambda s, u, schema: {"L1": ["I2"]} if resolving(u) else occurrence_reply(s, u, schema))
    extract = lambda router, counter: run.dispatch(None, source, request, router,
        counter={"fields": counter, "reasoning": counter})
    result = finish(lease, chat, extract)
    assert result["records"] == [{"fees": [10]}]
    assert [(entry["path"], entry["segment"]) for entry in result["evidence"]] == [
        (["records", 0, "fees", 0], "p2_s0")]
    _, final = linked_while_running(lease)
    for saved in final.values():
        assert [(entry["producer"]["path"], entry["producer"]["segment"]) for entry in saved] == [
            (["records", 0, "fees", 0], "p2_s0")]
    count = len(chat.calls)
    assert finish(lease, chat, extract)["evidence"] == result["evidence"]
    assert len(chat.calls) == count
