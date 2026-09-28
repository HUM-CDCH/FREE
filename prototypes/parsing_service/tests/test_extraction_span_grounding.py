"""Span location is exact; model support and skipped work remain explicit."""
from dataclasses import replace

import pytest

from kei_exp.kie.extract import run
from kei_exp.kie.extract.contexts import Context
from kei_exp.kie.extract.method import ArticleOptions
from kei_exp.kie.extract.models import Router
from kei_exp.kie.extract.spans import MAX_PROSE_CHARS, source_spans
from kei_exp.kie.extract.stages import verify
from kei_exp.pagefile import PageTable, TableCell
from tests.test_extract_grounded import CountingChat, WordCounter
from tests.test_extract_stages import SCHEMA, evidence, passages
from tests.test_extraction_rendering import table_passage


@pytest.mark.parametrize("text", ["", "  Hill\t1827\x00\r\n", "🌿e\u0301" * 401,
                                  "x" * 1201, ("Repeated sentence. " * 100)])
def test_prose_ranges_cover_exact_codepoints_without_normalization(text):
    spans = source_spans(passages([text]))
    assert "".join(span.text for span in spans) == text
    assert all(0 < span.end - span.start <= MAX_PROSE_CHARS for span in spans)
    assert [span.id for span in spans] == [span.id for span in source_spans(passages([text]))]
    assert len({span.id for span in spans}) == len(spans)
    assert all(a.end == b.start for a, b in zip(spans, spans[1:]))


def test_sentence_boundary_is_preferred_and_cells_retain_exact_locations():
    text = "a" * 290 + ". " + "b " * 200
    assert source_spans(passages([text]))[0].end == 292
    passage = table_passage()
    spans = source_spans([passage])
    cells = [s for s in spans if s.cell]
    assert [(s.start, s.end, s.text) for s in cells] == [
        (c.start, c.end, c.text) for c in passage.table.cells]
    assert cells[0].cell.colspan == 2 and cells[0].cell.bbox_pt is None
    assert "".join(s.text for s in spans if not s.cell) == passage.text
    passage.table.cells[0] = passage.table.cells[0].model_copy(update={"text": "invented"})
    with pytest.raises(ValueError, match="canonical cell"):
        source_spans([passage])


def test_duplicate_parent_ids_are_refused():
    p = passages(["same"])[0]
    with pytest.raises(ValueError, match="unique"):
        source_spans([p, p])


def span_chat(label="E1", attribution=True):
    return CountingChat(lambda s, u, schema: {
        c: {"label": label, "attribution": attribution} for c in schema["properties"]})


def test_quotes_are_reconstructed_with_controls_and_no_model_quote_field():
    text = "Hill\t1827"
    proofs = []
    chat = span_chat()
    links, calls, issues = verify(passages([text]), {"year": 1827}, SCHEMA, chat, record=0,
        counter=WordCounter(), record_context="Hill", span_ids=True, proofs=proofs)
    assert links and calls[0].ok and not issues
    assert proofs == [{"path": ["records", 0, "year"], "segment": "p1_s0", "cell": None,
                       "span": "p1_s0@0:9", "start": 0, "end": 9, "quote": text,
                       "attribution": "model_attested"}]
    assert set(chat.calls[0]["schema"]["properties"]["C1"]["properties"]) == {"label", "attribution"}


@pytest.mark.parametrize("label,attribution,code", [("p9_s9@0:9", True, "unknown_label"),
    ("E1", False, "unsupported_attribution"), ("p1_s0@0:9", True, "unknown_label"), (None, True, "missing_claim")])
def test_valid_location_does_not_override_missing_or_negative_support(label, attribution, code):
    links, _, issues = verify(passages(["Hill 1827"]), {"year": 1827}, SCHEMA,
        span_chat(label, attribution), record=0, counter=WordCounter(), record_context="Hill", span_ids=True)
    assert not links and issues[0].code == code


def test_cell_keeps_parent_geometry_without_inventing_a_measured_cell_box():
    passage = table_passage()
    proofs = []
    chat = span_chat("E5")
    links, _, issues = verify([passage], {"year": 37}, SCHEMA, chat, record=0,
        counter=WordCounter(), record_context="A", span_ids=True, proofs=proofs)
    assert not issues and links[0].bbox_pt == passage.bbox_pt and links[0].precision == "segment"
    assert proofs[0]["cell"] == "r2_c0" and proofs[0]["quote"] == "37"
    assert "colspan=2" in chat.calls[0]["user"] and "in water" in chat.calls[0]["user"]


def test_long_cell_is_indivisible_and_uses_its_measured_box():
    text = "Hill " * 120
    cell = TableCell(cell_id="r0_c0", row=0, column=0, rowspan=1, colspan=1,
                     role="data", text=text, start=0, end=len(text), bbox_pt=(1, 2, 3, 4))
    passage = replace(passages([text])[0], label="Table", table=PageTable(
        rows=1, columns=1, cells=[cell], producer="docling"))
    offered = [s for s in source_spans([passage]) if s.cell]
    assert len(offered) == 1 and offered[0].text == text and len(text) > MAX_PROSE_CHARS
    proofs = []
    links, _, issues = verify([passage], {"site": "Hill"}, SCHEMA, span_chat("E3"),
        record=0, counter=WordCounter(), record_context="Hill", span_ids=True, proofs=proofs)
    assert not issues and links[0].precision == "cell" and links[0].cell == "r0_c0"
    assert links[0].bbox_pt == (1, 2, 3, 4) and proofs[0]["quote"] == text


def test_repeated_text_resolves_to_selected_occurrence_not_first_string_match():
    proofs = []
    links, _, issues = verify(passages(["Hill 1827", "Hill 1827"]), {"year": 1827}, SCHEMA,
        span_chat("E2"), record=0, counter=WordCounter(), record_context="Hill",
        span_ids=True, proofs=proofs)
    assert not issues and links[0].segment == "p1_s1" and proofs[0]["segment"] == "p1_s1"


def test_larger_batches_retain_every_claim_and_refuse_oversized_source():
    fields = {"finds": ["Hill"] * 65}
    chat = span_chat("E1")
    links, calls, issues = verify(passages(["Hill"]), fields, SCHEMA, chat, record=0,
        counter=WordCounter(), record_context="Hill", span_ids=True)
    assert len(links) == 65 and len(calls) == 3 and not issues
    assert [len(c["schema"]["required"]) for c in chat.calls] == [32, 32, 1]
    counter = WordCounter()
    counter.context_tokens = 2048
    chat = span_chat()
    links, calls, issues = verify(passages(["Hill 1827"]), {"year": 1827}, SCHEMA, chat,
        record=0, counter=counter, record_context="Hill", span_ids=True)
    assert not links and not calls and not chat.calls
    assert issues[0].code == "grounding_exceeds_budget"


def test_truncation_and_cancellation_do_not_accept_span_decisions():
    class CutChat(CountingChat):
        def complete(self, **kwargs):
            return replace(super().complete(**kwargs), finish="length")
    chat = CutChat(lambda *_: {"C1": {"label": "E1", "attribution": True}})
    links, calls, issues = verify(passages(["Hill 1827"]), {"year": 1827}, SCHEMA, chat,
        record=0, counter=WordCounter(), record_context="Hill", span_ids=True)
    assert not links and not calls[-1].ok and issues[0].code == "call_failed"
    def cancel():
        raise RuntimeError("cancelled")
    chat = span_chat()
    with pytest.raises(RuntimeError, match="cancelled"):
        verify(passages(["Hill 1827"]), {"year": 1827}, SCHEMA, chat, record=0,
               counter=WordCounter(), record_context="Hill", span_ids=True, before_call=cancel)
    assert not chat.calls


def test_skip_paths_distinguish_records_and_array_positions():
    chat = span_chat("E1")
    links, _, _ = verify(passages(["Hill"]), {"finds": ["Hill", "Hill"]}, SCHEMA, chat,
        record=1, counter=WordCounter(), record_context="Hill", span_ids=True,
        skip_paths=frozenset({("records", 0, "finds", 1), ("records", 1, "finds", 0)}))
    assert [link.path for link in links] == [("records", 1, "finds", 1)]


@pytest.mark.parametrize("schedule,expected", [(None, [2, 2]), ("unresolved", [2, 1])])
def test_assembled_schedule_retries_unresolved_claims_only(monkeypatch, schedule, expected):
    source = passages(["Hill", "1827"])
    monkeypatch.setattr(run, "load", lambda _: evidence(source))
    monkeypatch.setattr(run, "source_contexts", lambda *_: [Context((p,)) for p in source])
    def reasoning(system, user, schema):
        if "records" in schema["properties"]:
            return {"records": [{"label": "Hill", "identity": {"site": "Hill"}, "passages": [source[0].id]}]}
        first = "E1: p1_s0 " in user
        return {claim: {"label": "E1" if first and "site" in user.split(f"{claim} (")[1].split("):")[0]
                       else "NONE" if first else "E1", "attribution": True}
                for claim in schema["properties"]}
    chat = CountingChat(reasoning)
    request = run.ExtractRequest(schema=SCHEMA, options={"strategy": "article", "article": {
        "context": "bounded", "grounding": "spans", "grounding_schedule": schedule,
        "identity": "conservative", "identity_fields": ["site"]}})
    result = run.extract(None, request, Router(CountingChat(lambda *_: {"year": 1827}), chat),
        counter={role: WordCounter() for role in ("fields", "reasoning")})
    grounding = [c for c in chat.calls if "### Claims" in c["user"]]
    assert [len(c["schema"]["required"]) for c in grounding] == expected
    assert result["span_grounding_version"] == 2 and result["quoted_support"]
    assert {tuple(link["path"]) for link in result["evidence"]} == {
        ("records", 0, "site"), ("records", 0, "year")}


def test_factors_are_independent_and_old_serialization_omits_new_defaults():
    assert "grounding_schedule" not in ArticleOptions().model_dump()
    with pytest.raises(ValueError, match="requires verification"):
        ArticleOptions(grounding="off", grounding_schedule="unresolved")
    requests = [run.ExtractRequest(schema=SCHEMA, options={"strategy": "article", "article": settings})
                for settings in [{"grounding": "quoted"}, {"grounding": "spans"},
                                 {"grounding": "spans", "grounding_schedule": "unresolved"}]]
    assert len({run.fingerprint({"generation": "g", "digest": "d"}, r, {}) for r in requests}) == 3


def test_filtered_cell_labels_stay_stable_across_budget_splits():
    class SplitCounter(WordCounter):
        def request_tokens(self, system, user, schema=None):
            return (self.context_tokens if len(schema["required"]) > 1
                    else super().request_tokens(system, user, schema))

    passage = table_passage()
    proofs = []
    chat = CountingChat(lambda s, u, schema: {
        claim: {"label": "E5" if claim == "C1" else "E6", "attribution": True}
        for claim in schema["properties"]})
    links, _, issues = verify([passage], {"finds": [37, 42]}, SCHEMA, chat, record=0,
        counter=SplitCounter(), record_context="A and B", span_ids=True, proofs=proofs)
    assert not issues and len(links) == 2
    assert [p["span"] for p in proofs] == ["p1_s0/r2_c0", "p1_s0/r2_c1"]
    assert [p["quote"] for p in proofs] == ["37", "42"]
    for call, claim, label in zip(chat.calls, ("C1", "C2"), ("E5", "E6")):
        assert call["schema"]["properties"][claim]["properties"]["label"]["enum"] == ["E1", label, "NONE"]
        assert f"{label}: p1_s0 Table" in call["user"]
        assert "row/header context" in call["user"] and "Group α" in call["user"]


def test_span_version_invalidates_only_span_fingerprints(monkeypatch):
    metadata = {"generation": "g", "digest": "d"}
    requests = [run.ExtractRequest(schema=SCHEMA, options={"strategy": "article", "article": {
        "grounding": mode}}) for mode in ("semantic", "quoted", "spans")]
    current = [run.fingerprint(metadata, request, {}) for request in requests]
    monkeypatch.setattr(run, "SPAN_GROUNDING_VERSION", 1)
    previous = [run.fingerprint(metadata, request, {}) for request in requests]
    assert current[:2] == previous[:2]
    assert current[2] != previous[2]
