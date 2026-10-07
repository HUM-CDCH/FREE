"""Grounding is an interchangeable technique: `run.extract` calls whatever `grounding.technique` returns."""
import json

import pytest

from kei_exp.kie.extract import grounding, run
from kei_exp.kie.extract.models import Router
from kei_exp.kie.extract.schema import Schema
from kei_exp.kie.extract.stages import Link
from kei_exp.kie.passages import Passage
from tests.helpers.chat import FakeChat
from tests.test_extract_grounded import CountingChat, WordCounter
from tests.test_extract_stages import SCHEMA, evidence, passages


@pytest.mark.parametrize("choice,expected", [(None, grounding.semantic), ("semantic", grounding.semantic),
                                             ("quoted", grounding.quoted), ("spans", grounding.spans), ("off", grounding.off)])
def test_every_article_grounding_choice_and_the_reference_name_a_technique(choice, expected):
    assert grounding.technique(choice) is expected


def recording(received):
    """A substitute technique: it records what it was given and links each record's year to its first passage."""
    def ground(passages, fields, schema, chat, *, record, budget, counter, record_context, before_call, proofs, skip_paths,
               projected=False, on_batch=None):
        received.append({"record": record, "passages": [p.id for p in passages], "counter": counter,
                         "record_context": record_context, "projected": projected})
        first = passages[0]
        return [Link(("records", record, "year"), first.id, first.page, first.bbox_pt, False, 0, "substitute")], [], []
    return ground


def test_a_substituted_technique_grounds_the_articles_one_root_where_its_value_is_without_run_changes(monkeypatch):
    source = passages(["Hill and Brook " + "context " * 3000, "methods " * 3000, "Results: Hill 1827. Brook 1828."])
    monkeypatch.setattr(run, "load", lambda _: evidence(source))
    chosen, received = [], []
    monkeypatch.setattr(grounding, "technique", lambda choice: chosen.append(choice) or recording(received))

    def reason(system, user, schema):
        raise AssertionError("no inventory, and the substitute replaces every grounding call")

    def fields(system, user, schema):
        return {"title": None} if "title" in schema["properties"] else {"year": 1827}
    request = run.ExtractRequest(schema=SCHEMA, options={"strategy": "article", "article": {
        "context": "bounded", "context_tokens": 8192, "grounding": "quoted"}})
    result = run.extract(None, request, Router(CountingChat(fields), CountingChat(reason)),
                         counter={role: WordCounter() for role in ("fields", "reasoning")})
    contexts = [[*context["overlap"], *context["primary"]] for context in result["contexts"]]
    assert chosen == ["quoted"] and len(contexts) >= 2 and len(result["records"]) == 1
    # Every context returned the year; it is checked first where the source prints it, and its support ends the search.
    assert [(item["record"], item["passages"]) for item in received] == [
        (0, next(group for group in contexts if "p1_s2" in group))]
    assert all(item["counter"] is not None and item["record_context"] and item["projected"] for item in received)
    assert not any(call["stage"] == "grounding" for call in result["calls"])
    assert [(link["path"], link["linked_by"]) for link in result["evidence"]] == [
        (["records", 0, "year"], "substitute")]
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
    assert received == [{"record": 0, "passages": ["p1_s1", "p1_s2"], "counter": None, "record_context": None, "projected": False},
                        {"record": 1, "passages": ["p1_s3"], "counter": None, "record_context": None, "projected": False}]
    assert all(link["linked_by"] == "substitute" for link in result["evidence"])


# A unique text hit is a candidate location, not field evidence (overfitting audit O5): the generic Catalog's
# reference technique sends every claim, uniquely found or not, to the model with its field and sibling fields.

BIOGRAPHY = Schema(recordDescription="One biography.", schemaNodes=[
    {"id": "n", "name": "name", "type": "string"}, {"id": "b", "name": "birth_year", "type": "integer"}])
ADA = Passage("p1_s0", 1, 0, "Ada was born in 1815. This catalogue was published in 1843.", "text",
              (0, 0, 100, 100), "block")


def test_a_number_found_once_under_the_wrong_field_is_verified_and_stays_unsupported():
    """The audit's probe: 1843 occurs once, but as the catalogue's publication year, not Ada's birth year."""
    chat = FakeChat(lambda system, user, schema: {"C1": "NONE", "C2": "NONE"})
    links, calls, issues = grounding.semantic([ADA], {"name": "Ada", "birth_year": 1843}, BIOGRAPHY, chat,
                                              record=0)
    assert links == [] and issues == []
    assert [call.stage for call in calls] == ["grounding"] and len(chat.calls) == 1
    user = chat.calls[0]["user"]
    assert "C2 (birth_year): 1843" in user
    assert 'Sibling fields: {"name": "Ada", "birth_year": 1843}' in user
    assert chat.calls[0]["schema"]["properties"]["C2"]["enum"] == ["E1", "NONE"]


def test_a_number_found_once_in_another_records_text_is_verified_and_stays_unsupported():
    """Two entries share one passage; record 0 claims the year printed for entry 32."""
    shared = Passage("p1_s0", 1, 0, "31. Hjortlund sogn, 1827. 32. Vester Vedsted, 1830.", "text",
                     (0, 0, 100, 100), "block")
    chat = FakeChat(lambda system, user, schema: {"C1": "E1", "C2": "E1", "C3": "NONE"})
    links, calls, issues = grounding.semantic([shared], {"entry_no": "31", "site": "Hjortlund sogn", "year": 1830},
                                              SCHEMA, chat, record=0)
    assert [(link.path, link.linked_by) for link in links] == [
        (("records", 0, "entry_no"), "model"), (("records", 0, "site"), "model")]
    assert issues == [] and len(calls) == len(chat.calls) == 1
    user = chat.calls[0]["user"]
    assert "C3 (year): 1830" in user
    assert 'Sibling fields: {"entry_no": "31", "site": "Hjortlund sogn", "year": 1830}' in user


def test_a_correct_unique_claim_links_only_after_the_model_attests_it():
    chat = FakeChat(lambda system, user, schema: {"C1": "E1", "C2": "E1"})
    links, calls, issues = grounding.semantic([ADA], {"name": "Ada", "birth_year": 1815}, BIOGRAPHY, chat, record=0)
    assert len(chat.calls) == 1 and issues == [] and [call.stage for call in calls] == ["grounding"]
    birth = {link.path: link for link in links}[("records", 0, "birth_year")]
    assert (birth.segment, birth.linked_by, birth.verbatim, birth.hits) == ("p1_s0", "model", True, 1)
    assert "lexical" not in {link.linked_by for link in links}


# A claim split into its own grounding batch still names its record (final review F1). Without Article's record
# context, a nested claim batched apart from the record's identifying fields was verified blind: Ada's and Grace's
# requests for the same birth year were identical, so no verifier could tell the right record from the wrong one.

NESTED = Schema(recordDescription="One biography.", schemaNodes=[
    {"id": "n", "name": "name", "type": "string"},
    {"id": "d", "name": "details", "type": "object", "children": [
        {"id": "b", "name": "birth_year", "type": "integer"}]}])
BORN = Passage("p1_s0", 1, 0, "Ada was born in 1815. Grace was born in 1843.", "text", (0, 0, 100, 100), "block")


def reads_its_record(system, user, schema):
    """A verifier answering from the request alone: 1843 is Grace's birth year, not Ada's. A year request that does
    not say whose record it is reads as supported, since the passage does print a birth in 1843."""
    answer = {claim: "E1" for claim in schema["properties"]}
    if "C2" in answer and '"name": "Ada"' in user:
        answer["C2"] = "NONE"
    return answer


def request_size(call):
    return len(call["system"]) + len(call["user"]) + len(json.dumps(call["schema"], ensure_ascii=False))


def test_a_nested_claim_split_from_its_records_name_is_verified_with_the_record():
    ada = {"name": "Ada", "details": {"birth_year": 1843}}
    grace = {"name": "Grace", "details": {"birth_year": 1843}}
    whole = []
    for fields in (ada, grace):
        chat = FakeChat(reads_its_record)
        grounding.semantic([BORN], fields, NESTED, chat, record=0)
        assert len(chat.calls) == 1
        whole.append(request_size(chat.calls[0]))
    budget = min(whole) - 1  # both claims no longer fit one request: each is verified in its own batch

    runs = {}
    for label, fields in (("ada", ada), ("grace", grace)):
        chat = FakeChat(reads_its_record)
        links, calls, issues = grounding.semantic([BORN], fields, NESTED, chat, record=0, budget=budget)
        assert issues == [] and len(calls) == len(chat.calls) == 2
        assert all(request_size(call) <= budget for call in chat.calls), "the record's fields count toward the budget"
        year = next(call["user"] for call in chat.calls if "C2" in call["schema"]["properties"])
        runs[label] = year, {link.path for link in links}

    (ada_year, ada_links), (grace_year, grace_links) = runs["ada"], runs["grace"]
    assert ada_year != grace_year
    assert "C1" not in ada_year and '"name": "Ada"' in ada_year and "Grace" not in ada_year.split("### Evidence")[0]
    assert ada_links == {("records", 0, "name")}, "1843 under Ada's record stays unsupported"
    assert grace_links == {("records", 0, "name"), ("records", 0, "details", "birth_year")}
