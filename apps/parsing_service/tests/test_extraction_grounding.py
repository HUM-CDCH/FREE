"""Grounding is an interchangeable technique: `run.extract` calls whatever `grounding.technique` returns."""
import json

import pytest

from kei_exp.kie.extract import grounding, run
from kei_exp.kie.extract.assembly import ground_records
from kei_exp.kie.extract.models import Router
from kei_exp.kie.extract.schema import Schema
from kei_exp.kie.extract.stages import Link
from kei_exp.kie.passages import Passage
from tests.helpers.chat import FakeChat
from tests.test_article_grounding_negative import grid, offered_cells
from tests.test_extract_grounded import CountingChat, WordCounter
from tests.test_extract_stages import SCHEMA, evidence, passages


@pytest.mark.parametrize("choice,expected", [(None, grounding.semantic), ("semantic", grounding.semantic),
                                             ("quoted", grounding.quoted), ("spans", grounding.spans), ("off", grounding.off)])
def test_every_article_grounding_choice_and_the_reference_name_a_technique(choice, expected):
    assert grounding.technique(choice) is expected


def recording(received):
    """A substitute technique: it records what it was given and links each record's year to its first passage."""
    def ground(passages, fields, schema, chat, *, record, budget, counter, record_context, proofs, skip_paths,
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


TABLE_ITEMS = Schema(recordDescription="One catalogue entry with a list of finds.", schemaNodes=[
    {"id": "items", "name": "items", "type": "array", "children": [
        {"id": "number", "name": "number", "type": "verbatim-string"},
        {"id": "description", "name": "description", "type": "verbatim-string"},
        {"id": "notes", "name": "notes", "type": "verbatim-string"}]}])


@pytest.mark.parametrize("wrong_row", [False, True])
def test_generic_catalog_repeated_cells_are_linked_only_in_their_items_row(wrong_row):
    table = grid([("header", ("number", "description", "notes")),
                  ("data", ("26-12", "Tand, human", "Niv. 6")),
                  ("data", ("26-28", "Tand, human", "Niv. 6"))])
    # Extraction order differs from source order: the item number identifies the row, never the list index.
    fields = {"items": [{"number": number, "description": "Tand, human", "notes": "Niv. 6"}
                        for number in ("26-28", "26-12")]}
    selected = {}

    def script(system, user, schema):
        labels = {cell: label for label, (cell, _) in offered_cells(user).items()}
        for claim, cell in zip(schema["properties"],
                               ("r2_c0", "r1_c1" if wrong_row else "r2_c1",
                                "r1_c2" if wrong_row else "r2_c2", "r1_c0", "r1_c1", "r1_c2"), strict=True):
            selected[claim] = labels[cell]
        return selected

    chat = FakeChat(script)
    result = ground_records([([table], fields)], TABLE_ITEMS, chat, budget=24_000)
    linked = {link.path[2:]: link for link in result.links}
    expected = {("items", item, field): f"r{row}_c{column}"
                for item, row in enumerate((2, 1)) for column, field in enumerate(("number", "description", "notes"))}
    if wrong_row:
        del expected[("items", 0, "description")]
        del expected[("items", 0, "notes")]
        assert [(issue.code, issue.path[2:]) for issue in result.issues] == [
            ("unknown_label", ("items", 0, "description")), ("unknown_label", ("items", 0, "notes"))]
        # The bad labels are real and offered for the other item in this same request; per-claim validation refuses them.
        for claim in ("C2", "C3"):
            assert selected[claim] not in chat.calls[0]["schema"]["properties"][claim]["enum"]
    else:
        assert result.issues == []
    assert {path: link.cell for path, link in linked.items()} == expected
    assert all(link.precision == "cell" and link.verbatim for link in result.links)
    assert all(link.hits == 2 for path, link in linked.items() if path[-1] != "number")
    assert len(chat.calls) == 1


def test_generic_catalog_keeps_both_rows_eligible_when_an_item_has_no_distinctive_value():
    table = grid([("header", ("number", "description", "notes")),
                  ("data", ("26-12", "Tand, human", "Niv. 6")),
                  ("data", ("26-28", "Tand, human", "Niv. 6"))])
    fields = {"items": [{"number": None, "description": "Tand, human", "notes": "Niv. 6"}]}

    def script(system, user, schema):
        labels = {cell: label for label, (cell, _) in offered_cells(user).items()}
        for claim, column in (("C1", 1), ("C2", 2)):
            assert all(labels[f"r{row}_c{column}"] in schema["properties"][claim]["enum"] for row in (1, 2))
        return {"C1": labels["r2_c1"], "C2": labels["r2_c2"]}

    result = ground_records([([table], fields)], TABLE_ITEMS, FakeChat(script), budget=24_000)
    assert [link.cell for link in result.links] == ["r2_c1", "r2_c2"]
    assert all(link.hits == 2 for link in result.links) and result.issues == []


def test_generic_catalog_offers_other_rows_for_a_claim_its_items_row_leaves_unsupported():
    """An item may span rows (a blank-name continuation row): its row locates the precise candidates first, then
    every row printing the value is offered for what that row leaves unsupported."""
    schema = Schema(recordDescription="One catalogue entry.", schemaNodes=[
        {"id": "items", "name": "items", "type": "array", "children": [
            {"id": "name", "name": "name", "type": "verbatim-string"},
            {"id": "warm", "name": "warm_value", "type": "verbatim-string"},
            {"id": "cold", "name": "cold_value", "type": "verbatim-string"}]}])
    table = grid([("header", ("Name", "Condition", "Value")),
                  ("data", ("A", "warm", "42")),
                  ("data", ("", "cold", "42"))])
    fields = {"items": [{"name": "A", "warm_value": "42", "cold_value": "42"}]}
    wanted = {"C1": "r1_c0", "C2": "r1_c2", "C3": "r2_c2"}
    offered = []

    def script(system, user, schema):
        labels = {cell: label for label, (cell, _) in offered_cells(user).items()}
        offered.append({claim: schema["properties"][claim]["enum"] for claim in schema["properties"]})
        return {claim: labels[wanted[claim]] if labels.get(wanted[claim]) in schema["properties"][claim]["enum"]
                else "NONE" for claim in schema["properties"]}

    result = ground_records([([table], fields)], schema, FakeChat(script), budget=24_000)
    assert result.issues == [] and len(offered) == 2 and list(offered[1]) == ["C3"]
    assert {link.path[2:]: link.cell for link in result.links} == {
        ("items", 0, "name"): "r1_c0", ("items", 0, "warm_value"): "r1_c2", ("items", 0, "cold_value"): "r2_c2"}


def test_generic_catalog_fallback_too_large_for_the_budget_leaves_the_claim_unsupported_without_an_issue():
    schema = Schema(recordDescription="One price list.", schemaNodes=[
        {"id": "items", "name": "items", "type": "array", "children": [
            {"id": "sku", "name": "sku", "type": "verbatim-string"},
            {"id": "qty", "name": "pack_size", "type": "verbatim-string"}]}])
    table = grid([("header", ("Article", "Qty")), *(("data", (f"S{n:04}", "1")) for n in range(150))])
    chat = FakeChat(lambda system, user, schema: {claim: "NONE" for claim in schema["properties"]})
    result = ground_records([([table], {"items": [{"sku": "S0007", "pack_size": "1"}]})], schema, chat, budget=24_000)
    # The sku's fallback fits and is asked; pack_size's (every row prints "1") is not, and stays unsupported.
    assert result.links == [] and result.issues == []
    assert [list(call["schema"]["properties"]) for call in chat.calls] == [["C1", "C2"], ["C1"]]
