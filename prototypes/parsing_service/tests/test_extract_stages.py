"""The stages over a scripted model: discovery, one record at a time, deterministic-then-model verification, and
the merge into one grounded artifact. Passages are built by hand; the parse-run projection has its own tests."""
import dataclasses
import json
from pathlib import Path

import pytest

from kei_exp.kie.extract.evidence import Evidence, Passage
from kei_exp.kie.extract.llm import Reply
from kei_exp.kie.extract.run import PROMPT_VERSION, ExtractRequest, extract, fingerprint, publish_extraction
from kei_exp.kie.extract.schema import Schema
from kei_exp.kie.extract.article import inventory
from kei_exp.kie.extract.stages import contains, discover, extract_record, merge, verify
from kei_exp.result import write_result
from tests.helpers.chat import FakeChat
from tests.helpers.replay import Replay
from tests.helpers.synthetic import cases

TEXTS = ["Fund fra Hjortlund", "31. Hjortlund sogn. Gravhøj med spyd, 1827.", "Se også nr. 32.",
         "32. Vester Vedsted. Urne af ler.", "Litteratur: Beier 1988."]


def passages(texts=TEXTS, page=1) -> list[Passage]:
    return [Passage(id=f"p{page}_s{i}", page=page, index=i, text=text, label="Text",
                    bbox_pt=(0, i * 10, 100, i * 10 + 9), extent="block") for i, text in enumerate(texts)]


def evidence(items=None) -> Evidence:
    return Evidence(run_id="run-x", generation="g1", digest="d1", source_name="beier.pdf", page_count=1,
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
    monkeypatch.setattr("kei_exp.kie.extract.run.counter_for", lambda chat: FixedCounter())


def one_identity(reply_schema, identity="31. Hjortlund"):
    labels = reply_schema["properties"]["records"]["items"]["properties"]["passages"]["items"]["enum"]
    return {"records": [{"label": identity, "identity": {}, "passages": [labels[0]]}]}


def test_discovery_labels_every_passage_and_cuts_records_at_the_starts_it_is_told():
    seen = {}

    def script(system, user, schema):
        seen["user"], seen["schema"] = user, schema
        return {"starts": ["B2", "B4"], "end": "B5"}
    chat = FakeChat(script)
    slices, calls, issues = discover(evidence(), SCHEMA, chat, budget=48_000)
    assert "[B1] Fund fra Hjortlund" in seen["user"] and "[B5] Litteratur" in seen["user"]
    assert seen["schema"]["properties"]["starts"]["items"]["enum"] == ["B1", "B2", "B3", "B4", "B5"]
    assert [[p.id for p in group] for group in slices] == [["p1_s1", "p1_s2"], ["p1_s3"]]
    assert calls[0].stage == "discovery" and calls[0].ok and not issues


def test_discovery_reports_a_numbered_entry_that_its_end_cuts_off():
    # qwen3:8b without reasoning named the second entry as `end` after a heading: a dropped record, not a finish.
    items = passages(["Site catalogue", "1. Hill: pottery dated 1801.", "2. Valley: flint dated 1802."])
    chat = FakeChat(lambda s, u, schema: {"starts": ["B2"], "end": "B3"})
    slices, _, issues = discover(evidence(items), SCHEMA, chat, budget=48_000)
    assert [[p.id for p in group] for group in slices] == [["p1_s1"]]
    assert [(issue.code, issue.detail) for issue in issues] == [
        ("discovery_numbered_after_end", "'B3' is numbered like every record start, but the end 'B3' drops it")]


def test_discovery_reports_an_unnumbered_start_among_numbered_ones():
    items = passages(["Kreis Nord", "1. Hill: pottery dated 1801.", "Kreis Sued", "2. Valley: flint dated 1802."])
    chat = FakeChat(lambda s, u, schema: {"starts": ["B1", "B2", "B3", "B4"], "end": None})
    slices, _, issues = discover(evidence(items), SCHEMA, chat, budget=48_000)
    assert len(slices) == 4
    assert [(issue.code, issue.detail) for issue in issues] == [
        ("discovery_unnumbered_start", f"start {label!r} is not numbered like the other record starts")
        for label in ("B1", "B3")]


def test_discovery_does_not_judge_numbering_where_the_records_have_none():
    items = passages(["Hill: pottery dated 1801.", "Valley: flint dated 1802.", "Index of sites", "3. Hill, 2. Valley"])
    chat = FakeChat(lambda s, u, schema: {"starts": ["B1", "B2"], "end": "B3"})
    assert discover(evidence(items), SCHEMA, chat, budget=48_000)[2] == []


def test_discovery_ignores_out_of_order_and_unknown_starts_with_an_issue():
    chat = FakeChat(lambda s, u, schema: {"starts": ["B4", "B2", "B9", "B4"], "end": None})
    slices, _, issues = discover(evidence(), SCHEMA, chat, budget=48_000)
    assert [[p.id for p in group] for group in slices] == [["p1_s3", "p1_s4"]]
    assert {issue.code for issue in issues} == {"discovery_ignored_label"}


def test_discovery_over_a_long_source_is_chunked_by_page_and_labels_run_on():
    long = [Passage(id=f"p{page}_s0", page=page, index=0, text=f"{page}. Entry " + "x" * 3000, label="Text",
                    bbox_pt=(0, 0, 1, 1), extent="block") for page in range(1, 7)]
    users = []
    chat = FakeChat(lambda s, u, schema: users.append(u) or {"starts": [label for label in
                    schema["properties"]["starts"]["items"]["enum"]], "end": None})
    slices, calls, _ = discover(evidence(long), SCHEMA, chat, budget=7_000)
    assert len(calls) == 3 and len(slices) == 6
    assert "[B3]" in users[1] and "[B1]" not in users[1]


def test_discovery_asks_its_hook_before_every_window_and_stops_when_it_raises():
    """The worker's cooperative cancellation: a hook that raises ends discovery before its next call."""
    asked, windows = [], []

    def before_call():
        if len(asked) == 2:
            raise RuntimeError("cancelled")
        windows.append(len(asked))
    chat = FakeChat(lambda s, u, schema: asked.append(u) or {"starts": [], "end": None})
    with pytest.raises(RuntimeError, match="cancelled"):
        discover(evidence(six_pages()), SCHEMA, chat, budget=7_000, before_call=before_call)  # three windows
    assert windows == [0, 1] and len(asked) == 2


def six_pages() -> list[Passage]:
    """One passage of about 3,000 characters per page: three chunks of two pages at a 7,000 budget."""
    return [Passage(id=f"p{page}_s0", page=page, index=0, text=f"{page}. Entry " + "x" * 3000, label="Text",
                    bbox_pt=(0, 0, 1, 1), extent="block") for page in range(1, 7)]


def test_discovery_honours_an_end_only_from_the_final_chunk():
    """An earlier chunk cannot know what follows it: its end is ignored with an issue and every later record
    survives."""
    def script(system, user, schema):
        shown = schema["properties"]["starts"]["items"]["enum"]
        return {"starts": [shown[0]], "end": shown[1] if shown[0] == "B1" else None}
    slices, calls, issues = discover(evidence(six_pages()), SCHEMA, FakeChat(script), budget=7_000)
    assert len(calls) == 3
    assert [[p.id for p in group] for group in slices] == [["p1_s0", "p2_s0"], ["p3_s0", "p4_s0"], ["p5_s0", "p6_s0"]]
    assert [issue.code for issue in issues] == ["discovery_ignored_label"] and "final chunk" in issues[0].detail


def test_discovery_still_closes_the_records_at_an_end_from_the_final_chunk():
    def script(system, user, schema):
        shown = schema["properties"]["starts"]["items"]["enum"]
        return {"starts": [shown[0]], "end": shown[1] if shown[0] == "B5" else None}
    # What follows the records is not an entry: a numbered block there would be reported as dropped.
    items = [*six_pages()[:5], dataclasses.replace(six_pages()[5], text="Literature " + "x" * 3000)]
    slices, _, issues = discover(evidence(items), SCHEMA, FakeChat(script), budget=7_000)
    assert [[p.id for p in group] for group in slices] == [["p1_s0", "p2_s0"], ["p3_s0", "p4_s0"], ["p5_s0"]]
    assert not issues


def test_discovery_ignores_an_end_that_lies_before_a_record_start_with_an_issue():
    chat = FakeChat(lambda s, u, schema: {"starts": ["B2", "B4"], "end": "B3"})
    slices, _, issues = discover(evidence(), SCHEMA, chat, budget=48_000)
    assert [[p.id for p in group] for group in slices] == [["p1_s1", "p1_s2"], ["p1_s3", "p1_s4"]]
    assert [issue.code for issue in issues] == ["discovery_inconsistent_end"]


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


def test_verification_links_a_unique_verbatim_value_without_the_model_and_asks_for_the_rest():
    seen = {}

    def script(system, user, schema):
        seen.update(user=user, schema=schema)
        return {"C1": "E1", "C2": "NONE"}
    chat = FakeChat(script)
    fields = {"entry_no": "31", "site": "Hjortlund parish", "year": 1827, "finds": ["spyd", "sword"]}
    links, calls, issues = verify(passages()[1:3], fields, SCHEMA, chat, record=0)
    by_path = {tuple(link.path): link for link in links}
    assert by_path[("records", 0, "entry_no")].linked_by == "lexical" and by_path[("records", 0, "entry_no")].verbatim
    assert by_path[("records", 0, "year")].segment == "p1_s1" and by_path[("records", 0, "finds", 0)].segment == "p1_s1"
    assert seen["schema"]["properties"]["C1"]["enum"] == ["E1", "E2", "NONE"]
    assert "C1 (site): Hjortlund parish" in seen["user"] and "C2 (finds): sword" in seen["user"]
    assert "E1: 31. Hjortlund sogn" in seen["user"]
    site = by_path[("records", 0, "site")]
    assert site.linked_by == "model" and site.segment == "p1_s1" and site.verbatim is False and site.hits == 0
    assert ("records", 0, "finds", 1) not in by_path  # NONE: the model found no passage for the sword
    assert calls[0].stage == "grounding" and not issues


def test_verification_asks_its_hook_before_every_grounding_batch_and_stops_when_it_raises():
    """Cancellation reaches inside a record, including the budget probe before splitting its claims."""
    fields = {"entry_no": "31", "site": "Hjortlund parish", "year": 1827, "finds": ["spyd", "sword"]}
    sizes = []
    probe = FakeChat(lambda s, u, schema: sizes.append(len(s) + len(u) + len(json.dumps(schema))) or {"C1": "NONE", "C2": "NONE"})
    verify(passages()[1:3], fields, SCHEMA, probe, record=0, budget=10**9)
    budget = sizes[0] - 1                        # the two pending claims no longer fit one batch: two batches
    asked, calls = [], []

    def before_call():
        if len(calls) == 1:
            raise RuntimeError("cancelled")
        asked.append(len(calls))
    chat = FakeChat(lambda s, u, schema: calls.append(u) or {claim: "NONE" for claim in schema["properties"]})
    with pytest.raises(RuntimeError, match="cancelled"):
        verify(passages()[1:3], fields, SCHEMA, chat, record=0, budget=budget, before_call=before_call)
    assert asked == [0, 0] and len(calls) == 1  # oversized parent, first child, then cancelled before second child


def test_extract_passes_its_check_to_verification(monkeypatch):
    """The hook each grounding batch asks is the very `before_entry` extract was given."""
    from kei_exp.kie.extract import run as run_module
    request = ExtractRequest.model_validate({"schema": SCHEMA.model_dump(by_alias=True, exclude_none=True),
                                             "options": {"strategy": "article"}})
    received = []

    def spy(*args, before_call=None, **kwargs):
        received.append(before_call)
        return [], [], []

    def before_entry():
        pass
    monkeypatch.setattr(run_module, "load", lambda run_dir: evidence())
    monkeypatch.setattr(run_module, "verify", spy)
    def script(system, user, schema):
        if "records" in schema["properties"]:
            return one_identity(schema)
        if "entry_no" in schema["properties"]:
            return {"entry_no": "31", "site": "Hjortlund", "year": None, "finds": None}
        return {"title": None}
    chat = FakeChat(script)
    extract(Path("/nonexistent/run-x"), request, chat, before_entry=before_entry)
    assert received == [before_entry]


def test_verification_reports_unknown_labels_and_missing_claims_and_leaves_them_ungrounded():
    chat = FakeChat(lambda s, u, schema: {"C1": "E7"})
    fields = {"entry_no": None, "site": "Hjortlund parish", "year": None, "finds": ["a sword nobody mentioned"]}
    links, _, issues = verify(passages()[1:3], fields, SCHEMA, chat, record=2)
    assert links == []
    assert {(issue.code, tuple(issue.path or ())) for issue in issues} == {
        ("unknown_label", ("records", 2, "site")), ("missing_claim", ("records", 2, "finds", 0))}


def test_merge_orders_fields_as_the_schema_does_and_adds_document_and_filename_values():
    merged = merge({"site": "Hjortlund", "entry_no": "31", "year": None, "finds": None}, {"title": "Beier 1988"},
                   "beier.pdf", SCHEMA)
    assert list(merged) == ["entry_no", "site", "year", "finds", "title", "filename"]
    assert merged["title"] == "Beier 1988" and merged["filename"] == "beier.pdf"


def test_extract_composes_the_stages_into_a_complete_grounded_artifact(digital_pdf, tmp_path):
    run = hand_built_complete(digital_pdf, tmp_path)
    request = ExtractRequest.model_validate({"schema": SCHEMA.model_dump(by_alias=True, exclude_none=True),
                                             "options": {"strategy": "article"}})

    def script(system, user, schema):
        if "records" in schema["properties"]:
            return one_identity(schema, "1")
        if "title" in schema["properties"]:
            return {"title": "Grüße"}
        if "entry_no" in schema["properties"]:
            return {"entry_no": "1", "site": None, "year": None, "finds": None}
        return {label: "NONE" for label in schema["properties"]}
    chat = FakeChat(script)
    result = extract(tmp_path, request, chat)
    assert result["extraction_version"] == 1 and result["run_id"] == tmp_path.name
    assert result["generation"] and result["digest"] and result["strategy"] == "article"
    assert result["model"] == "fake/extractor" and result["prompt_version"] == PROMPT_VERSION
    assert result["models"] == {"fields": "fake/extractor", "reasoning": "fake/extractor"}  # one chat serves both
    assert result["schema"] == request.schema_.model_dump(by_alias=True, exclude_none=True)
    assert result["records"][0]["title"] == "Grüße" and result["records"][0]["filename"] == run.source.name
    assert result["records"][0]["entry_no"] == "1"
    assert isinstance(result["evidence"], list) and isinstance(result["issues"], list)
    assert result["tokens"] == {"input": 10 * len(chat.calls), "output": 5 * len(chat.calls)}
    assert result["seconds"] >= 0 and result["started"]
    assert result["fingerprint"] == fingerprint(result, request, {"fields": chat.model, "reasoning": chat.model})
    path = publish_extraction(tmp_path, "x-1", result)
    assert path == tmp_path / "extractions" / "x-1" / "result.json"
    assert json.loads(path.read_text(encoding="utf-8")) == result
    assert not list((tmp_path / "extractions" / "x-1").glob("*.part"))


def test_the_article_strategy_reports_no_records_found_and_is_incomplete_without_records():
    request = ExtractRequest.model_validate({"schema": SCHEMA.model_dump(by_alias=True, exclude_none=True),
                                             "options": {"strategy": "article"}})
    chat = FakeChat(lambda s, u, schema: {"records": []} if "records" in schema["properties"] else {"title": None})
    result = extract_over(evidence(), request, chat)
    assert result["records"] == [] and result["complete"] is False
    assert [issue["code"] for issue in result["issues"]] == ["no_records_found"]
    without = FakeChat(lambda s, u, schema: {"nothing": 1})
    found, (call,), issues = inventory(passages(), SCHEMA, without, counter=FixedCounter())
    assert found == [] and call.ok and [issue.code for issue in issues] == ["no_records_found"]


def test_document_fields_are_declared_unverified():
    """Document-level fields are extracted but not grounded in this slice; the artifact says which ones."""
    request = ExtractRequest.model_validate({"schema": SCHEMA.model_dump(by_alias=True, exclude_none=True),
                                             "options": {"strategy": "article"}})
    def script(s, u, schema):
        if "records" in schema["properties"]:
            return one_identity(schema)
        if "entry_no" in schema["properties"]:
            return {"entry_no": "31"}
        return {"title": "Beier 1988"} if "title" in schema["properties"] else {"C1": "E2"}
    chat = FakeChat(script)
    result = extract_over(evidence(), request, chat)
    assert result["unverified"] == ["title"] and result["complete"] is True
    record_only = {"recordDescription": "x",
                   "schemaNodes": [{"id": "no", "name": "entry_no", "type": "verbatim-string"}]}
    request = ExtractRequest.model_validate({"schema": record_only, "options": {"strategy": "article"}})
    result = extract_over(evidence(), request, FakeChat(script))
    assert result["unverified"] == [] and result["complete"] is True


def test_an_integral_float_is_verified_as_its_integer_text():
    silent = FakeChat(lambda s, u, schema: {})
    links, calls, issues = verify(passages()[1:3], {"year": 1827.0}, SCHEMA, silent, record=0)
    assert [(link.segment, link.linked_by, link.verbatim) for link in links] == [("p1_s1", "lexical", True)]
    assert calls == [] and issues == []
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


def test_completeness_needs_every_call_ok_and_every_value_grounded():
    request = ExtractRequest.model_validate({"schema": SCHEMA.model_dump(by_alias=True, exclude_none=True),
                                             "options": {"strategy": "article"}})
    calls = []

    def script(system, user, schema):
        calls.append(schema)
        if "records" in schema["properties"]:
            return one_identity(schema)
        if "entry_no" in schema["properties"]:
            return {"entry_no": "31", "site": "Nowhere", "year": None, "finds": None}
        if "title" in schema["properties"]:
            return {"title": None}
        return {label: "E2" if label == "C1" else "NONE" for label in schema["properties"]}
    result = extract_over(evidence(), request, FakeChat(script))
    assert result["complete"] is False and ["records", 0, "site"] in result["ungrounded"]
    assert [link["segment"] for link in result["evidence"]] == ["p1_s1"]


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
    _, calls, _ = discover(evidence(), SCHEMA, chat, budget=48_000)
    assert [(call.ok, call.error) for call in calls] == [
        (False, "HTTP 400: response_format is not supported"), (True, None)]
