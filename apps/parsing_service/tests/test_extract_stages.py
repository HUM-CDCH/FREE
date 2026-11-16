"""The stages over a scripted model: discovery, one record at a time, model verification of every claim, and
the merge into one grounded artifact. Passages are built by hand; the parse-run projection has its own tests."""
import dataclasses
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
import requests

from kei_exp.kie.extract import article, llm
from kei_exp.kie.extract.calls import WHITESPACE_LOOP
from kei_exp.kie.extract.llm import OpenAIChat, Reply
from kei_exp.kie.extract.models import Router
from kei_exp.kie.extract.assembly import PROMPT_VERSION, fingerprint
from kei_exp.kie.extract.run import ExtractRequest, extract
from kei_exp.kie.extract.schema import Schema
from experiments.extraction.legacy_article import inventory
from kei_exp.kie.extract.grounding import verify
from kei_exp.kie.extract.stages import contains, extract_record, merge
from kei_exp.kie.passages import Evidence, Passage
from kei_exp.result import write_result
from tests.helpers.chat import FakeChat
from tests.helpers.replay import Replay
from tests.helpers.synthetic import cases

TEXTS = ["Fund fra Hjortlund", "31. Hjortlund sogn. Gravhøj med spyd, 1827.", "Se også nr. 32.",
         "32. Vester Vedsted. Urne af ler.", "Litteratur: Bauer 1988."]


def passages(texts=TEXTS, page=1) -> list[Passage]:
    return [Passage(id=f"p{page}_s{i}", page=page, index=i, text=text, label="Text",
                    bbox_pt=(0, i * 10, 100, i * 10 + 9), extent="block") for i, text in enumerate(texts)]


def evidence(items=None) -> Evidence:
    return Evidence(run_id="run-x", generation="g1", digest="d1", source_name="bauer.pdf", page_count=1,
                    passages=tuple(items or passages()))


def hand_built_complete(digital_pdf: Path, tmp_path: Path) -> Replay:
    """The `hand-built` synthetic case written under `tmp_path/result` as a complete run.

    The case gives its errored block's record an incomplete reason, which makes the whole manifest incomplete and
    `evidence.load` refuse it; clearing just that reason keeps the block's own error status while letting the run
    finish as a whole (`tests/test_extract_evidence.py` does the same)."""
    run = cases()["hand-built"](digital_pdf, tmp_path)
    first, *rest = run.outcome.pages
    outcome = dataclasses.replace(run.outcome, pages=[dataclasses.replace(first, incomplete=None), *rest])
    write_result(outcome, run.execution, run.inventory, run.source, ingest_digest=run.ingest_digest,
                 directory=tmp_path / "result")
    return run


SCHEMA = Schema.model_validate({"recordDescription": "One numbered catalogue entry.", "schemaNodes": [
    {"id": "no", "name": "entry_no", "type": "verbatim-string", "description": "the printed number"},
    {"id": "site", "name": "site", "type": "string"},
    {"id": "year", "name": "year", "type": "integer"},
    {"id": "finds", "name": "finds", "type": "array", "itemType": "string"},
    {"id": "title", "name": "title", "type": "string", "valueSource": "document"},
    {"id": "file", "name": "filename", "type": "string", "valueSource": "source-filename"},
]})


class FixedCounter:
    context_tokens = 32_768

    def request_tokens(self, *args):
        return 10  # FakeChat's reported count


@pytest.fixture(autouse=True)
def article_counters(monkeypatch):
    monkeypatch.setattr("kei_exp.kie.extract.tokens.counter_for", lambda chat: FixedCounter())


def one_identity(reply_schema, identity="31. Hjortlund"):
    labels = reply_schema["properties"]["records"]["items"]["properties"]["passages"]["items"]["enum"]
    return {"records": [{"label": identity, "identity": {}, "passages": [labels[0]]}]}


def six_pages() -> list[Passage]:
    """One passage of about 3,000 characters per page: three chunks of two pages at a 7,000 budget."""
    return [Passage(id=f"p{page}_s0", page=page, index=0, text=f"{page}. Entry " + "x" * 3000, label="Text",
                    bbox_pt=(0, 0, 1, 1), extent="block") for page in range(1, 7)]


def test_a_record_is_extracted_under_the_guardrail_with_the_schema_and_conformed():
    seen = {}

    def script(system, user, schema):
        seen.update(system=system, user=user, schema=schema)
        return {"entry_no": "31", "site": "Hjortlund sogn", "year": 1827, "finds": ["spyd"], "junk": True}
    fields, (call,), issues = extract_record(passages()[1:3], SCHEMA, FakeChat(script), budget=24_000)
    assert fields == {"entry_no": "31", "site": "Hjortlund sogn", "year": 1827, "finds": ["spyd"]}
    assert "do not invent" in seen["system"] and "One numbered catalogue entry." in seen["system"]
    assert "- entry_no: the printed number" in seen["system"]
    assert "31. Hjortlund sogn" in seen["user"] and "title" not in seen["schema"]["properties"]
    assert call.stage == "record" and call.ok and call.input_tokens == 10 and not issues


def test_a_truncated_or_unreadable_answer_is_a_failed_call_with_null_fields():
    cut = FakeChat(lambda s, u, schema: Reply('{"entry_no": "3', 5, 8192, "length", 0.1))
    fields, (call,), issues = extract_record(passages()[1:3], SCHEMA, cut, budget=24_000)
    assert fields == {"entry_no": None, "site": None, "year": None, "finds": None}
    assert not call.ok and "length" in (call.error or "") and issues[0].code == "call_failed"


def test_a_reply_that_loops_on_whitespace_is_named_as_such():
    looping = FakeChat(lambda s, u, schema: Reply('{"entry_no": "3", "items": [' + "\r   " * 1000, 5, 8192, "length", 0.1))
    _, (call,), issues = extract_record(passages()[1:3], SCHEMA, looping, budget=24_000)
    assert not call.ok and issues[0].code == "call_failed"
    assert "whitespace loop" in (call.error or "") and "finish_reason length" in (call.error or "")


def test_a_whitespace_loop_before_another_json_token_is_named_as_such():
    from kei_exp.kie.extract.calls import _cut_off
    text = '{"volume":{"value":' + " \r" * 100 + '"quote":'
    assert "whitespace loop" in _cut_off(text)


def test_whitespace_copied_inside_a_quoted_value_is_not_a_decoding_loop():
    from kei_exp.kie.extract.calls import _cut_off
    text = '{"quote":"escaped \\\"' + " " * 500 + '\\ntext","value":'
    assert "whitespace loop" not in _cut_off(text)


def test_a_generic_record_call_is_capped_at_2048_tokens():
    chat = FakeChat(lambda s, u, schema: {"entry_no": "31"})
    extract_record(passages()[1:3], SCHEMA, chat, budget=24_000)
    assert [call["max_tokens"] for call in chat.calls] == [2048]


@pytest.mark.parametrize("budget, unshown", [
    (5, "p1_s0 from code point 7 through p1_s2 (page 1)"),   # inside a passage: offsets count its leading spaces
    (11, "p1_s1 through p1_s2 (page 1)"),                    # inside the blank line between two passages
    (12, "p1_s1 through p1_s2 (page 1)"),                    # exactly at the next passage's first character
    (23, "p1_s2 (page 1)"),
    (25, "p1_s2 from code point 1 (page 1)"),
])
def test_a_record_over_the_text_budget_names_the_source_it_did_not_show(budget, unshown):
    """The character budget cuts the text the model is shown; the issue names what was cut in the canonical
    segments' own terms, so the result never claims the whole record was read."""
    chat = FakeChat(lambda s, u, schema: {"entry_no": None})
    _, _, issues = extract_record(passages(["  " + "a" * 10, "b" * 10, "c" * 10]), SCHEMA, chat, budget=budget,
                                  record=3)
    assert [(issue.code, issue.record) for issue in issues] == [("text_truncated", 3)]
    assert issues[0].detail == f"34 characters of text, {budget} shown to the model; not shown: {unshown}"


def test_a_record_within_the_text_budget_reports_no_cut():
    _, _, issues = extract_record(passages(["  " + "a" * 10, "b" * 10, "c" * 10]), SCHEMA,
                                  FakeChat(lambda s, u, schema: {"entry_no": None}), budget=34)
    assert issues == []


def pages_with_a_late_marker() -> list[Passage]:
    """One record over three pages whose only site name lies on the last page."""
    return [Passage(id=f"p{page}_s0", page=page, index=0,
                    text=("1. Entry " if page == 1 else "") + "x" * 690 + (" Site: Marker Hill." if page == 3 else ""),
                    label="Text", bbox_pt=(0, 0, 1, 1), extent="block") for page in (1, 2, 3)]


def test_verification_asks_the_model_for_every_claim_including_a_uniquely_found_value():
    seen = {}

    def script(system, user, schema):
        seen.update(user=user, schema=schema)
        return {"C1": "E1", "C2": "E1", "C3": "E1", "C4": "E1", "C5": "NONE"}
    chat = FakeChat(script)
    fields = {"entry_no": "31", "site": "Hjortlund parish", "year": 1827, "finds": ["spyd", "sword"]}
    links, calls, issues = verify(passages()[1:3], fields, SCHEMA, chat, record=0)
    by_path = {tuple(link.path): link for link in links}
    entry_no = by_path[("records", 0, "entry_no")]
    assert (entry_no.linked_by, entry_no.verbatim) == ("model", True)
    assert by_path[("records", 0, "year")].segment == "p1_s1" and by_path[("records", 0, "finds", 0)].segment == "p1_s1"
    assert seen["schema"]["properties"]["C1"]["enum"] == ["E1", "E2", "NONE"]
    assert "C1 (entry_no: the printed number): 31" in seen["user"] and "C2 (site): Hjortlund parish" in seen["user"]
    assert "C5 (finds): sword" in seen["user"] and "E1: 31. Hjortlund sogn" in seen["user"]
    site = by_path[("records", 0, "site")]
    assert site.linked_by == "model" and site.segment == "p1_s1" and site.verbatim is False
    assert ("records", 0, "finds", 1) not in by_path  # NONE: the model found no passage for the sword
    assert [call.stage for call in calls] == ["grounding"] and len(chat.calls) == 1 and not issues


def test_verification_reports_unknown_labels_and_missing_claims_and_leaves_them_ungrounded():
    chat = FakeChat(lambda s, u, schema: {"C1": "E7"})
    fields = {"entry_no": None, "site": "Hjortlund parish", "year": None, "finds": ["a sword nobody mentioned"]}
    links, _, issues = verify(passages()[1:3], fields, SCHEMA, chat, record=2)
    assert links == []
    assert {(issue.code, tuple(issue.path or ())) for issue in issues} == {
        ("unknown_label", ("records", 2, "site")), ("missing_claim", ("records", 2, "finds", 0))}


def test_merge_orders_fields_as_the_schema_does_and_adds_document_and_filename_values():
    merged = merge({"site": "Hjortlund", "entry_no": "31", "year": None, "finds": None}, {"title": "Bauer 1988"},
                   "bauer.pdf", SCHEMA)
    assert list(merged) == ["entry_no", "site", "year", "finds", "title", "filename"]
    assert merged["title"] == "Bauer 1988" and merged["filename"] == "bauer.pdf"


def test_an_article_whose_document_states_nothing_is_one_empty_root_and_the_inventory_unit_reports_none():
    """Document scope: the document is the object even when it gives none of the fields; nothing is 'not found'. The
    retained research inventory still reports a reply with no records as `no_records_found`."""
    request = ExtractRequest.model_validate({"schema": SCHEMA.model_dump(by_alias=True, exclude_none=True),
                                             "options": {"strategy": "article"}})
    chat = FakeChat(lambda s, u, schema: pytest.fail("no inventory") if "records" in schema["properties"] else {})
    result = extract_over(evidence(), request, chat)
    assert result["records"] == [{"entry_no": None, "site": None, "year": None, "finds": None, "title": None,
                                  "filename": "bauer.pdf"}]
    assert result["issues"] == [] and result["ungrounded"] == [] and result["complete"] is True
    without = FakeChat(lambda s, u, schema: {"nothing": 1})
    found, (call,), issues = inventory(passages(), SCHEMA, without, counter=FixedCounter())
    assert found == [] and call.ok and [issue.code for issue in issues] == ["no_records_found"]


def test_an_integral_float_is_verified_as_its_integer_text():
    chat = FakeChat(lambda s, u, schema: {"C1": "E1"})
    links, calls, issues = verify(passages()[1:3], {"year": 1827.0}, SCHEMA, chat, record=0)
    assert [(link.segment, link.linked_by, link.verbatim) for link in links] == [("p1_s1", "model", True)]
    assert len(calls) == 1 and issues == []
    assert contains("Urne af ler, 18.5 cm", 18.5) and not contains("nr. 1827", 182.0)


def test_verification_without_passages_makes_no_call_and_reports_no_evidence():
    chat = FakeChat(lambda s, u, schema: {"C1": "NONE"})
    links, calls, issues = verify([], {"entry_no": "31"}, SCHEMA, chat, record=3)
    assert links == [] and calls == [] and chat.calls == []
    assert [(issue.code, issue.record) for issue in issues] == [("no_evidence", 3)]


def test_the_fingerprint_follows_generation_schema_options_model_and_prompt_version():
    base = {"generation": "g1", "digest": "d1"}
    request = ExtractRequest.model_validate({"schema": SCHEMA.model_dump(by_alias=True, exclude_none=True)})
    other = ExtractRequest.model_validate({"schema": SCHEMA.model_dump(by_alias=True, exclude_none=True),
                                           "options": {"strategy": "article"}})
    assert fingerprint(base, request, "m") == fingerprint(base, request, "m")
    assert fingerprint(base, request, "m") != fingerprint({**base, "generation": "g2"}, request, "m")
    assert fingerprint(base, request, "m") != fingerprint(base, other, "m")
    assert fingerprint(base, request, "m") != fingerprint(base, request, "n")


def extract_over(found: Evidence, request: ExtractRequest, chat: FakeChat) -> dict:
    """`extract` over passages built by hand: the run-directory projection is monkeypatched away."""
    from kei_exp.kie.extract import run as run_module
    original = run_module.load
    run_module.load = lambda run_dir: found
    try:
        return extract(Path("/nonexistent/run-x"), request, chat)
    finally:
        run_module.load = original


@pytest.mark.parametrize("body, reason", [
    ({"schema": {"recordDescription": "x", "schemaNodes": []}}, "at least 1"),
    ({"schema": {"recordDescription": "x", "schemaNodes": [{"id": "a", "name": "a", "type": "string"}]},
      "options": {"strategy": "batch"}}, "strategy"),
    ({"options": {}}, "schema"),
])
def test_a_malformed_request_is_refused(body, reason):
    from pydantic import ValidationError
    with pytest.raises(ValidationError, match=reason):
        ExtractRequest.model_validate(body)


def test_a_refused_attempt_is_recorded_as_its_own_failed_call():
    reply = Reply(text='{"starts": ["B2"], "end": null}', input_tokens=10, output_tokens=5, finish="stop", seconds=0.1,
                  attempts=("HTTP 400: response_format is not supported",))
    chat = FakeChat(lambda s, u, schema: reply)
    _, calls, _ = extract_record(passages(), SCHEMA, chat, record=0, budget=24_000)
    assert [(call.ok, call.error) for call in calls] == [
        (False, "HTTP 400: response_format is not supported"), (True, None)]
