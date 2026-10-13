"""Opt-in fast benchmark checks: pytest --import-mode=importlib tests/benchmarks/synthetic_pdf.test.py."""
import copy
from types import SimpleNamespace
from unittest.mock import patch

import pypdfium2 as pdfium
import pytest

from experiments.extraction.manifest import read
from experiments.extraction.replay_reference import Captured
from experiments.extraction.study import Capture
from experiments.synthetic_pdf.evaluate import controls, evaluate
from experiments.synthetic_pdf.generate import expected, generate, validate_truth
from experiments.synthetic_pdf.run import Probes, capture_calls, checked, seal
from kei_exp.kie.extract.llm import OpenAIChat, bounded
from kei_exp.kie.extract.tokens import TokenCounter
from kei_exp.kie.passages import Evidence, Passage
from kei_exp.pagefile import PageTable, TableCell


def test_colliding_cell_ids_are_rejected_before_generation(tmp_path):
    from experiments.extraction.manifest import write_new
    from experiments.synthetic_pdf.run import create, validate_config
    config = {"seed": 1, "documents": [
        {"id": "d--p", "template": "article", "seed": 1, "records": 1},
        {"id": "d", "template": "article", "seed": 2, "records": 1}],
        "providers": [{"id": "q"}, {"id": "p--q"}],
        "methods": [{"id": "m", "options": {"strategy": "article"}}]}
    config_path, dataset = tmp_path / "config.json", tmp_path / "dataset"
    write_new(config_path, config)
    with pytest.raises(ValueError, match="duplicate cell IDs"):
        create(config_path, dataset)
    assert not dataset.exists()
    config["providers"][1]["id"] = "r--q"
    validate_config(config)


@pytest.fixture
def corpus(tmp_path):
    spec = {"id": "test", "template": "catalog", "seed": 17, "records": 2, "repeat_values": True,
            "missing_year_every": 2, "cross_page": True, "repeat_entries": 1}
    directory = tmp_path / "input"
    truth = generate(spec, directory)
    # Independent scoring fixture: one known source passage per rendered location.
    passages = tuple(Passage(id=f"p{a['page']}_s{n}", page=a["page"], index=n, text=a["quote"], label="Text",
                             bbox_pt=tuple(a["bbox_pt"]), extent="block") for n, a in enumerate(truth["annotations"]))
    evidence = Evidence("synthetic", "generation", "digest", "source.pdf", max(p.page for p in passages), passages)
    return truth, evidence, directory


def test_byte_determinism_and_ground_truth(corpus, tmp_path):
    truth, _, directory = corpus
    again = generate(truth["spec"], tmp_path / "again")
    assert again == truth
    assert truth["expected"]["article"]["records"] == expected(truth, "article")
    assert truth["expected"]["catalog"]["records"] == expected(truth, "catalog")
    assert (directory / "source.pdf").read_bytes() == (tmp_path / "again/source.pdf").read_bytes()
    changed = copy.deepcopy(truth)
    changed["annotations"][0]["value_text"] = "unprinted value"
    with pytest.raises(ValueError, match="rendered value differs"):
        validate_truth(changed, directory / "source.native.pdf")


@pytest.mark.parametrize("strategy", ["article", "catalog"])
def test_corruption_controls(corpus, strategy):
    truth, evidence, _ = corpus
    result = controls(truth, {"strategy": strategy}, evidence)
    assert result["oracle"]["evidence"]["precision"] == 1
    assert result["oracle"]["evidence"]["recall"] == 1
    assert result["corruptions"]["wrong_record_evidence"]["evidence"]["source_valid"] == result["oracle"]["evidence"]["source_valid"]
    assert result["corruptions"]["duplicate_record"]["merge"]["duplicate_records"] == 1


@pytest.mark.parametrize("strategy", ["article", "catalog"])
def test_order_invariance_missing_fields_wrong_types_and_duplicates(corpus, strategy):
    truth, evidence, _ = corpus
    artifact = {"strategy": strategy, "records": expected(truth, strategy)}
    items = artifact["records"][0]["items"] if strategy == "article" else artifact["records"]
    items.reverse()
    for item in items:
        item["themes"].reverse()
        item["observations"].reverse()
    assert evaluate(truth, artifact, evidence)["fields"]["f1"] == 1
    items[0]["year"] = 1844  # Gold explicitly has no recorded year for this identity.
    assert evaluate(truth, artifact, evidence)["fields"]["precision"] < 1
    items[0]["year"] = None
    items[0]["observations"][0]["count"] = "42"  # No numeric coercion.
    assert evaluate(truth, artifact, evidence)["fields"]["recall"] < 1
    items[0]["observations"].append(copy.deepcopy(items[0]["observations"][1]))
    result = evaluate(truth, artifact, evidence)
    assert result["arrays"]["precision"] < 1
    assert result["merge"]["duplicate_array_items"] == 1
    assert result["structure"]["invalid_roots"] > 0


def test_repeated_value_from_wrong_record_is_not_evidence(corpus):
    truth, evidence, _ = corpus
    artifact = {"strategy": "catalog", "records": expected(truth, "catalog"), "evidence": []}
    other = next(p for p, a in zip(evidence.passages, truth["annotations"], strict=True)
                 if a["record_id"] == truth["items"][1]["record_id"] and a["path"] == ["holding", "institution"])
    artifact["evidence"] = [{"path": ["records", 0, "holding", "institution"], "segment": other.id,
                             "page": other.page, "bbox_pt": list(other.bbox_pt)}]
    result = evaluate(truth, artifact, evidence)
    assert result["evidence"]["source_valid"] == 1
    assert result["evidence"]["precision"] == 0


def test_identical_count_in_wrong_table_row_is_not_evidence(corpus):
    truth, evidence, _ = corpus
    rid = truth["items"][0]["record_id"]
    annotations = [a for a in truth["annotations"] if a["record_id"] == rid and a["kind"] == "table"][:4]
    text, cells = "", []
    for n, annotation in enumerate(annotations):
        row, column = divmod(n, 2)
        start = len(text)
        text += annotation["value_text"]
        cells.append(TableCell(cell_id=f"r{row}_c{column}", row=row, column=column, rowspan=1, colspan=1,
                               role="body", text=annotation["value_text"], start=start, end=len(text),
                               bbox_pt=tuple(annotation["bbox_pt"])))
        text += "\t" if column == 0 else "\n"
    box = (min(a["bbox_pt"][0] for a in annotations), min(a["bbox_pt"][1] for a in annotations),
           max(a["bbox_pt"][2] for a in annotations), max(a["bbox_pt"][3] for a in annotations))
    passage = Passage("table", annotations[0]["page"], 0, text, "Table", box, "block",
                      table=PageTable(rows=2, columns=2, cells=cells, producer="test"))
    evidence = Evidence(evidence.run_id, evidence.generation, evidence.digest, evidence.source_name,
                        evidence.page_count, (passage,))
    artifact = {"strategy": "catalog", "records": expected(truth, "catalog"), "evidence": [{
        "path": ["records", 0, "observations", 0, "count"], "segment": "table", "page": passage.page,
        "cell": "r1_c1", "bbox_pt": list(cells[3].bbox_pt)}]}
    assert cells[1].text == cells[3].text == "42"
    result = evaluate(truth, artifact, evidence)
    assert result["evidence"]["source_valid"] == 1
    assert result["evidence"]["precision"] == 0


def test_coarse_parse_does_not_turn_unavailable_negative_control_into_model_failure(tmp_path):
    truth = generate({"id": "coarse", "template": "catalog", "seed": 17, "records": 2,
                      "layout": "columns", "repeat_values": True}, tmp_path / "coarse")
    pages = sorted({a["page"] for a in truth["annotations"]})
    passages = tuple(Passage(f"p{page}_s0", page, 0,
                             "\n".join(a["quote"] for a in truth["annotations"] if a["page"] == page),
                             "Text", (0, 0, 595.28, 841.89), "input") for page in pages)
    evidence = Evidence("coarse", "generation", "digest", "source.pdf", max(pages), passages)
    result = controls(truth, {"strategy": "catalog"}, evidence)
    assert result["skipped"] == ["wrong_record_evidence"]
    assert result["oracle"]["fields"]["f1"] == 1


@pytest.mark.parametrize("error", ["wrong_field_quote", "negative_offset"])
def test_quote_requires_this_fields_value_and_valid_offsets(corpus, error):
    truth, evidence, _ = corpus
    text = "\n".join(a["quote"] for a in truth["annotations"] if a["page"] == 1)
    passage = Passage("page", 1, 0, text, "Text", (0, 0, 595.28, 841.89), "input")
    evidence = Evidence(evidence.run_id, evidence.generation, evidence.digest, evidence.source_name,
                        evidence.page_count, (passage,))
    path = ["records", 0, "holding", "box"]
    proof = {"path": path, "segment": "page", "quote": "Holding institution: Riverton Archive"}
    if error == "negative_offset":
        value = truth["items"][0]["holding"]["box"]
        proof.update(quote=value, start=-len(value), end=len(text))
        assert text[proof["start"]:proof["end"]] == value
    artifact = {"strategy": "catalog", "records": expected(truth, "catalog"), "quoted_support": [proof],
                "evidence": [{"path": path, "segment": "page", "page": 1, "bbox_pt": list(passage.bbox_pt)}]}
    result = evaluate(truth, artifact, evidence)
    assert result["evidence"]["source_valid"] == (1 if error == "wrong_field_quote" else 0)
    assert result["evidence"]["precision"] == 0


def test_contradictions_require_alternatives(corpus):
    truth, evidence, _ = corpus
    truth = copy.deepcopy(truth)
    truth["metadata"]["edition"] = None
    truth["contradictions"] = {"edition": [2024, 2025]}
    artifact = {"strategy": "article", "records": expected(truth, "article"),
                "disagreements": [{"names": ["edition"], "alternatives": [{"value": 2024}, {"value": 2025}]}]}
    assert evaluate(truth, artifact, evidence)["merge"]["contradiction_alternatives"]["recall"] == 1
    artifact["disagreements"] = []
    artifact["records"][0]["edition"] = 2024
    result = evaluate(truth, artifact, evidence)
    assert result["merge"]["contradiction_alternatives"]["recall"] == 0
    assert result["metadata"]["precision"] < 1


def test_scan_has_no_text_layer(tmp_path):
    truth = generate({"id": "scan", "template": "catalog", "seed": 1, "records": 1,
                      "raster_dpi": 72, "blur_radius": .5}, tmp_path / "scan")
    assert truth["pdf_sha256"] != truth["native_pdf_sha256"]
    with pdfium.PdfDocument(str(tmp_path / "scan/source.pdf")) as document:
        for page in document:
            text = page.get_textpage()
            assert not text.get_text_bounded().strip()
            text.close()
            page.close()


def test_long_contradictory_generation_and_single_record_controls(tmp_path):
    spec = {"id": "long", "template": "article", "seed": 31, "records": 1, "padding_pages": 1,
            "repeat_entries": 1, "contradiction": True}
    truth = generate(spec, tmp_path / "long")
    assert truth["metadata"]["edition"] is None
    assert truth["contradictions"] == {"edition": [2024, 2025]}
    assert truth["expected"]["article"]["records"][0]["edition"] is None
    placements = [a for a in truth["annotations"] if a["record_id"] == truth["items"][0]["record_id"]]
    assert max(a["page"] for a in placements) - min(a["page"] for a in placements) > 1
    passages = tuple(Passage(f"p{a['page']}_s{n}", a["page"], n, a["quote"], "Text", tuple(a["bbox_pt"]), "block")
                     for n, a in enumerate(truth["annotations"]))
    evidence = Evidence("long", "generation", "digest", "source.pdf", max(p.page for p in passages), passages)
    result = controls(truth, {"strategy": "article"}, evidence)
    assert result["oracle"]["evidence"]["precision"] == 1
    assert result["skipped"] == ["wrong_record_evidence"]


def test_missing_probe_and_changed_pin_fail_without_http(tmp_path):
    identity = TokenCounter("vllm:/tokenize", "model", 8192).identity()
    probes = Probes(tmp_path, identity=identity, context=8192)
    with pytest.raises(ValueError, match="offline replay refuses network"):
        probes.request_tokens("system", "user")
    path = tmp_path / "artifact.json"
    path.write_text("{}")
    pins = seal(tmp_path, [path])
    path.write_text('{"changed":true}')
    with pytest.raises(ValueError, match="changed pinned artifact"):
        checked(tmp_path, pins)


def test_capture_preserves_production_whitespace_recovery(tmp_path):
    chat = OpenAIChat(url="http://localhost/v1/chat/completions", model="model")
    response = SimpleNamespace(raise_for_status=lambda: None, status_code=200, json=lambda: {
        "choices": [{"message": {"content": '{"value":"x"}'}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 5, "completion_tokens": 6}})
    request = {"system": "S", "user": "U", "schema": {"type": "object", "properties": {"value": {"type": "string"}},
               "required": ["value"], "additionalProperties": False}}
    capture = Capture(chat, tmp_path, "fields")
    with patch("requests.post", return_value=response), capture_calls({"fields": chat}, {"fields": capture}, tmp_path):
        recovery = bounded(chat, 16)
        assert type(recovery) is OpenAIChat
        reply = recovery.complete(**request)
    assert "grammar" in read(tmp_path / "fields-0001.payload.json")["structured_outputs"]
    captured = Captured(tmp_path, "fields", "model", 8192)
    with (patch("requests.post", side_effect=AssertionError("replay attempted HTTP")),
          capture_calls({"fields": chat}, {"fields": captured}, tmp_path, offline=True)):
        assert bounded(chat, 16).complete(**request) == reply


@pytest.mark.parametrize("strategy", ["article", "catalog"])
def test_duplicate_matching_is_order_invariant_without_pooling_fields(corpus, strategy):
    truth, evidence, _ = corpus
    artifact = {"strategy": strategy, "records": expected(truth, strategy)}
    items = artifact["records"][0]["items"] if strategy == "article" else artifact["records"]
    wrong = copy.deepcopy(items[0])
    wrong["holding"]["box"] = "WRONG"
    items.insert(0, wrong)
    first = evaluate(truth, artifact, evidence)
    items.reverse()
    assert evaluate(truth, artifact, evidence) == first
    assert first["fields"]["matched"] == first["fields"]["expected"]
    assert first["records"]["exact_recall"] == 1
    assert first["records"]["exact_unique_recall"] == .5
    # Two complementary broken copies must never become one complete object.
    items.pop(1)  # Remove the complete first object after reversal.
    partial = copy.deepcopy(wrong)
    partial["holding"]["box"] = truth["items"][0]["holding"]["box"]
    partial["title"] = "WRONG"
    items.append(partial)
    assert evaluate(truth, artifact, evidence)["records"]["exact_recall"] == .5


def test_duplicate_rows_and_identical_records_with_different_citations_are_order_invariant(corpus):
    truth, evidence, _ = corpus
    artifact = {"strategy": "catalog", "records": expected(truth, "catalog")}
    observations = artifact["records"][0]["observations"]
    bad = copy.deepcopy(observations[0])
    bad["count"] = 999
    observations.insert(0, bad)
    before = evaluate(truth, artifact, evidence)
    observations.reverse()
    assert evaluate(truth, artifact, evidence) == before
    assert before["fields"]["recall"] == 1 and before["arrays"]["precision"] < 1
    artifact["records"] = expected(truth, "catalog")
    artifact["records"].append(copy.deepcopy(artifact["records"][0]))
    source = next(p for p, a in zip(evidence.passages, truth["annotations"], strict=True)
                  if a["record_id"] == truth["items"][0]["record_id"] and a["path"] == ["title"])
    artifact["evidence"] = [{"path": ["records", 2, "title"], "segment": source.id,
                             "page": source.page, "bbox_pt": list(source.bbox_pt)}]
    before = evaluate(truth, artifact, evidence)
    assert before["evidence"]["precision"] == 1
    artifact["records"][0], artifact["records"][2] = artifact["records"][2], artifact["records"][0]
    artifact["evidence"][0]["path"][1] = 0
    assert evaluate(truth, artifact, evidence) == before


@pytest.mark.parametrize("cross_page", [False, True])
def test_reprints_are_distinct_from_primary_cross_page_placements(tmp_path, cross_page):
    truth = generate({"id": "placement", "template": "article", "seed": 17, "records": 2,
                      "repeat_entries": 1, "cross_page": cross_page}, tmp_path / "placement")
    evidence = Evidence("test", "g", "d", "source.pdf", 4, ())
    result = evaluate(truth, {"strategy": "article", "records": expected(truth, "article")}, evidence)
    assert result["merge"]["cross_page_records"] == int(cross_page)
    assert result["merge"]["reprinted_records"] == 1
    assert {a["placement"] for a in truth["annotations"]} == {"primary", "reprint"}


def test_evidence_diagnostics_separate_schema_copies_from_document_claims(corpus):
    truth, evidence, _ = corpus
    artifact = {"strategy": "catalog", "records": expected(truth, "catalog")}
    # Start with all oracle links, then retain document metadata on just one record.
    from experiments.synthetic_pdf.evaluate import bind_gold, project
    gold = project(artifact["records"], "catalog", truth["array_identities"])
    bindings = bind_gold(truth, evidence, "catalog", gold)
    artifact["evidence"] = []
    for path, key in gold["paths"].items():
        if key not in bindings or (key[0] == "metadata" and path[1] != 0):
            continue
        segment, _ = min(bindings[key])
        passage = evidence.by_id(segment)
        artifact["evidence"].append({"path": list(path), "segment": segment, "page": passage.page,
                                     "bbox_pt": list(passage.bbox_pt)})
    result = evaluate(truth, artifact, evidence)["evidence"]
    assert result["recall"] < 1
    assert result["objects"]["recall"] == 1
    assert result["document_metadata"]["recall"] == 1
    assert result["unique_claims"]["recall"] == 1
    assert result["conditional_grounding"]["precision"] == 1


def test_malformed_links_remain_false_positives_without_erasing_values(corpus):
    truth, evidence, _ = corpus
    artifact = {"strategy": "catalog", "records": expected(truth, "catalog"),
                "evidence": [{"path": ["records", 0, "title"], "page": 1, "bbox_pt": [0, 0, 1, 1]}]}
    result = evaluate(truth, artifact, evidence)
    assert result["fields"]["f1"] == 1
    assert result["evidence"]["precision"] == 0
    assert result["evidence"]["predicted"] == result["evidence"]["malformed_links"] == 1


def test_default_headers_keep_roles_separate_during_capture_and_replay(tmp_path):
    chats = {role: OpenAIChat("http://localhost/v1/chat/completions", "model") for role in ("fields", "reasoning")}
    assert chats["fields"].headers is not chats["reasoning"].headers
    captures = {role: Capture(chat, tmp_path, role) for role, chat in chats.items()}
    request = {"system": "S", "user": "U", "schema": None}
    def response(value):
        return SimpleNamespace(raise_for_status=lambda: None, status_code=200, json=lambda: {
            "choices": [{"message": {"content": value}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 5, "completion_tokens": 6}})
    with (patch("requests.post", side_effect=[response("fields reply"), response("reasoning reply")]),
          capture_calls(chats, captures, tmp_path)):
        replies = {role: chat.complete(**request) for role, chat in chats.items()}
    captured = {role: Captured(tmp_path, role, "model", 8192) for role in chats}
    with (patch("requests.post", side_effect=AssertionError("replay attempted HTTP")),
          capture_calls(chats, captured, tmp_path, offline=True)):
        assert {role: chat.complete(**request) for role, chat in chats.items()} == replies


def test_scoring_failure_preserves_inference_and_replays_without_zero_accuracy(corpus, tmp_path, monkeypatch):
    from experiments.extraction.manifest import write_new
    from experiments.synthetic_pdf import run
    truth, evidence, _ = corpus
    dataset, output = tmp_path / "dataset", tmp_path / "results"
    config = {"seed": 1, "documents": [{"id": "test"}],
              "providers": [{"id": "model"}], "methods": [{"id": "catalog", "options": {"strategy": "catalog"}}]}
    write_new(dataset / "documents/test/truth.json", truth)
    write_new(dataset / "inputs.json", {})
    write_new(dataset / "parses.json", {"files": {}})
    monkeypatch.setattr(run, "check_inputs", lambda _: config)
    monkeypatch.setattr(run, "parse", lambda _: None)
    monkeypatch.setattr(run, "load", lambda _: evidence)
    monkeypatch.setattr(run, "provider_settings", lambda _: {
        "base_url": "http://localhost", "model": "model", "context_tokens": 32768})
    monkeypatch.setattr(run, "counter_for", lambda _: TokenCounter("test", "model", 32768))
    artifact = {"strategy": "catalog", "records": expected(truth, "catalog"), "tokens": {"input": 7, "output": 8}}
    monkeypatch.setattr(run, "extract", lambda *args, **kwargs: artifact)
    monkeypatch.setattr(run.requests, "get", lambda *args, **kwargs: SimpleNamespace(
        raise_for_status=lambda: None, json=lambda: {"data": [{"id": "model", "max_model_len": 32768}]}))
    def broken_control(*args):
        raise ValueError("scripted scorer defect")
    monkeypatch.setattr(run, "controls", broken_control)
    with pytest.raises(RuntimeError, match="1 failed cells"):
        run.run(dataset, output)
    cell = next((output / "cells").iterdir())
    assert read(cell / "finished.json")["status"] == "scoring_failed"
    assert read(cell / "artifact.json") == artifact
    assert read(cell / "cost.json")["input_tokens"] == 7
    assert not (cell / "metrics.json").exists()
    assert read(cell / "error.json")["phase"] == "scoring"
    run.score(dataset, output, tmp_path / "score.json")
    assert read(tmp_path / "score.json")["cells"][0]["status"] == "scoring_failed"
    with patch("requests.get", side_effect=AssertionError("HTTP")), patch("requests.post", side_effect=AssertionError("HTTP")):
        run.replay(dataset, output, tmp_path / "replay.json")
    assert read(tmp_path / "replay.json")["cells"][0]["identical_except_top_level_clocks"]


def test_several_correct_citations_do_not_inflate_unique_object_evidence_recall(corpus):
    truth, evidence, _ = corpus
    path = ["records", 0, "holding", "box"]
    passage = next(p for p, a in zip(evidence.passages, truth["annotations"], strict=True)
                   if a["record_id"] == truth["items"][0]["record_id"] and a["path"] == path[2:])
    link = {"path": path, "segment": passage.id, "page": passage.page, "bbox_pt": list(passage.bbox_pt)}
    result = evaluate(truth, {"strategy": "catalog", "records": expected(truth, "catalog"),
                              "evidence": [link, copy.deepcopy(link)]}, evidence)["evidence"]["objects"]
    assert result["precision"] == 1 and result["supported_claims"] == 1
    assert result["recall"] == 1 / result["expected"]
    assert result["f1"] == pytest.approx(2 * result["recall"] / (1 + result["recall"]))


def test_paired_comparison_retains_scorer_failures_and_does_not_count_repeats_as_documents(tmp_path, monkeypatch):
    from experiments.extraction.manifest import write_new
    from experiments.synthetic_pdf import compare
    methods = [{"id": name, "options": {"strategy": "article", "article": {"context": "bounded"}}} for name in ("a", "b")]
    config = {"documents": [{"id": "doc"}], "methods": methods, "repeats": 2}
    cells = [{"id": f"{method}-{repeat}", "document": "doc", "provider": "p", "repeat": repeat, "method": method}
             for repeat in (1, 0) for method in ("b", "a")]
    manifest = {"config": config, "cells": cells}
    monkeypatch.setattr(compare, "verify_run", lambda *args: manifest)
    output = tmp_path / "results"
    write_new(output / "seal.json", {})
    for cell in cells:
        path = output / "cells" / cell["id"]
        failed = cell["method"] == "b" and cell["repeat"] == 1
        write_new(path / "finished.json", {"status": "scoring_failed" if failed else "completed"})
        write_new(path / "artifact.json", {"records": [{"x": cell["method"]}], "seconds": cell["repeat"]})
        write_new(path / "cost.json", {"value_contexts": 2, "input_tokens": 100})
        if not failed:
            write_new(path / "metrics.json", {"fields": {"precision": .8 if cell["method"] == "b" else 1}})
    report = tmp_path / "comparison.json"
    compare.compare(tmp_path, output, "a", "b", report)
    result = read(report)
    assert result["registered_documents"] == 1 and len(result["pairs"]) == 2
    assert result["pairs"][0]["variant_minus_baseline"]["field_precision"] == pytest.approx(-.2)
    assert result["pairs"][1]["variant_minus_baseline"]["field_precision"] is None
    assert result["pairs"][1]["measurements"]["b"]["status"] == "scoring_failed"
    assert result["pairs"][1]["variant_minus_baseline"]["input_tokens"] == 0
    assert all(a["identical"] and a["all_registered_repeats_present"] for a in result["prediction_agreement"])
    with pytest.raises(ValueError, match="two distinct registered"):
        compare.compare(tmp_path, output, "a", "a", tmp_path / "bad.json")


@pytest.mark.parametrize("placement, reason", [("full", "single_value_context"),
                                               ("split", "split_primary_contexts"),
                                               ("unsplit", "unverified_or_unsplit")])
def test_conflict_eligibility_uses_physical_locations_and_actual_value_contexts(tmp_path, placement, reason):
    truth = generate({"id": "conflict", "template": "article", "seed": 17, "records": 2,
                      "contradiction": True}, tmp_path / "conflict")
    passages = tuple(Passage(f"p{a['page']}_s{n}", a["page"], n, a["quote"], "Text",
                             tuple(a["bbox_pt"]), "block") for n, a in enumerate(truth["annotations"]))
    evidence = Evidence("test", "g", "d", "source.pdf", max(p.page for p in passages), passages)
    last = passages[-1].id  # Physically printed conflict statement on the final page.
    primary = [p.id for p in passages]
    contexts = [{"primary": primary, "overlap": []}]
    if placement == "split":
        contexts = [{"primary": primary[:-1], "overlap": []}, {"primary": [last], "overlap": []}]
    elif placement == "unsplit":
        contexts.append({"primary": [], "overlap": []})
    artifact = {"strategy": "article", "records": expected(truth, "article"),
                "contexts": [{"primary": [], "overlap": []}] * 3, "value_contexts": [contexts],
                "disagreements": [{"names": ["edition"], "alternatives": [{"value": 2024}, {"value": 2025}]}]}
    result = evaluate(truth, artifact, evidence)
    conflict = result["merge"]["contradiction_alternatives"]
    assert conflict["eligibility"] == {"edition": reason}
    assert conflict["eligible_recall"] == (1 if placement == "split" else None)
    assert result["cost"]["source_contexts"] == 3
    assert result["cost"]["value_contexts"] == len(contexts)
