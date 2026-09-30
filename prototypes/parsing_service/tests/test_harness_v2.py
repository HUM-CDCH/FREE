"""Contract regressions: raw values, alternative annotations, evidence scopes, and bounded execution."""
import copy
import json
from dataclasses import replace
from types import SimpleNamespace

import pytest

from experiments.harness.config import Config
from experiments.harness.data import case_of
from experiments.harness.evidence import entries_for
from experiments.harness.evaluate import Eval, check_invariants, metrics, score_case
from experiments.harness.extractbench import inference_schema
from experiments.harness.model import BudgetExceeded, Provider, ResearchReply
from experiments.harness.run import meter_for, run_case
from tests.test_harness_evaluate import make, predict, find


def test_raw_values_stay_exact_and_normalization_never_drops_punctuation():
    case = make()
    prediction = predict(case)
    value = find(prediction, 0, "site")["value"]
    find(prediction, 0, "site").update(value=value.upper() + "  ", raw=value.upper() + "  ")
    counts, _ = score_case(case, prediction, Eval())
    assert counts["tp"] == counts["gold_value_fields"]
    assert counts["raw_tp"] == counts["gold_value_fields"] - 1
    find(prediction, 0, "site").update(value=value + ".", raw=value + ".")
    counts, _ = score_case(case, prediction, Eval())
    assert counts["wrong_values"] == counts["raw_wrong_values"] == 1


def test_quote_and_id_refinement_keep_raw_selection_and_localize_identically():
    case = case_of({"id": "c", "group": "c", "split": "dev", "passages": [{"id": "p1_s0", "page": 1, "text": "City: Rome."}],
                    "schema": {"recordDescription": "City", "schemaNodes": [{"id": "city", "name": "city", "type": "string"}]}, "gold": []})
    candidate = {"value": "Rome", "raw": "Rome", "quotes": ["City: Rome."], "ids": ["p1_s0"]}
    entries = [entries_for(candidate, "Rome", case.inference(), case.evidence.passages,
                           Config.model_validate({"input": {"mode": "layout"}, "evidence": {"mode": mode}}))[0] for mode in ("quote", "ids")]
    assert entries[0]["spans"] == entries[1]["spans"] == [{"segment": "p1_s0", "start": 6, "end": 10}]
    assert entries[0]["raw_spans"] == entries[1]["raw_spans"] == [{"segment": "p1_s0", "start": 0, "end": 11}]
    assert all(e["semantic_support"] is None and e["refined"] for e in entries)


def test_structural_schema_discards_answer_examples_but_preserves_record_arrays():
    source = {"type": "object", "description": "Gold answer at page 3", "properties": {
        "items": {"type": "array", "items": {"type": "object", "properties": {
            "code": {"type": "string", "description": "The answer is SECRET", "examples": ["SECRET"]},
            "quantity": {"anyOf": [{"type": "number"}, {"type": "null"}]}}}}}}
    schema = inference_schema(source)
    assert "SECRET" not in json.dumps(schema) and "page 3" not in json.dumps(schema)
    assert schema["schemaNodes"][0]["type"] == "array"
    assert schema["schemaNodes"][0]["children"][1]["type"] == "number"


def structured_case():
    schema = inference_schema({"type": "object", "properties": {"title": {"type": "string"}, "code": {"type": "string"},
        "items": {"type": "array", "items": {"type": "object", "properties": {"name": {"type": "string"}, "quantity": {"type": "number"}}}}}})
    expected = {"title": "Invoice", "code": "X", "items": [{"name": "A", "quantity": 1}, {"name": "B", "quantity": 2}]}
    rules = {"title": {"evidence": [{"value": "INVOICE", "page": None}]},
             "items[0].name": {"evidence": [{"value": "Alpha", "page": 2}, {"value": "A", "page": 1}]}}
    return case_of({"id": "c", "group": "g", "split": "dev", "passages": [{"id": "p1_s0", "page": 1, "text": "Invoice X A 1 B 2"}],
                    "schema": schema, "gold": [{"fields": {k: {"value": v} for k, v in expected.items()}}],
                    "annotations": {"adapter": "extractbench-v1", "expected_output": expected, "field_rules": rules}})


def test_alternate_values_evidence_and_record_arrays_are_preserved_and_scored():
    case = structured_case()
    prediction = predict(case)
    prediction["records"] = [copy.deepcopy(case.annotations["expected_output"])]
    prediction["records"][0]["items"].reverse()
    prediction["records"][0]["items"][1]["name"] = "Alpha"
    for row in prediction["fields"]:
        row.update(value=prediction["records"][0][row["field"]], raw=prediction["records"][0][row["field"]])
        row["evidence"] = [{"spans": [{"segment": "p1_s0", "start": 0, "end": 7}]}]
    counts, _ = score_case(case, prediction, Eval())
    assert not check_invariants(counts)
    assert counts["tp"] == counts["gold_value_fields"] == 6
    assert counts["gold_records"] == 3 and counts["pred_records"] == 3
    report = metrics(counts)
    assert report["evidence"]["annotated_fields"] == 1
    assert report["evidence"]["annotated_page_joint"] == 1
    assert report["evidence"]["joint"] is None and report["evidence"]["semantic_support"] is None
    prediction["records"][0]["items"].append(copy.deepcopy(prediction["records"][0]["items"][0]))
    counts, _ = score_case(case, prediction, Eval())
    assert counts["duplicated_records"] == 1


def test_no_annotations_can_cross_the_inference_boundary(monkeypatch):
    case = make()
    from experiments.harness import extract
    original = extract.groups_of
    def inspect(source, config):
        assert not hasattr(source, "gold") and not hasattr(source, "annotations")
        return original(source, config)
    monkeypatch.setattr(extract, "groups_of", inspect)
    from tests.helpers.harness_chat import Reader
    cfg = Config()
    run_case(case, cfg, meter_for(Provider(Reader()), cfg))


def test_token_budget_reserves_input_plus_maximum_output_before_sending():
    class Chat:
        model = "fake"
        def complete(self, **kw):
            return ResearchReply("{}", 900, 20, "stop", 0)
    counter = SimpleNamespace(request_tokens=lambda *args: 900)
    meter = Provider(Chat(), counter=counter).view(5, 1000)
    with pytest.raises(BudgetExceeded):
        meter.complete(system="s", user="u", schema=None, max_tokens=101)
    assert meter.spent["fresh"]["calls"] == 0
    meter.complete(system="s", user="u", schema=None, max_tokens=100)
    with pytest.raises(BudgetExceeded):
        meter.complete(system="s", user="other", schema=None, max_tokens=100)
    assert meter.spent["fresh"]["calls"] == 1


def test_transport_failure_reports_unknown_usage_and_keeps_its_token_reservation():
    class Chat:
        model = "fake"
        sent = 0
        def complete(self, **kw):
            self.sent += 1
            raise OSError("connection lost after sending")
    chat = Chat()
    meter = Provider(chat, counter=SimpleNamespace(request_tokens=lambda *args: 100)).view(2, 140)
    with pytest.raises(OSError, match="connection lost"):
        meter.complete(system="s", user="u", schema=None, max_tokens=40)
    fresh = meter.spent["fresh"]
    assert fresh["calls"] == fresh["failed"] == fresh["unknown_usage"] == 1
    assert fresh["input_tokens"] == fresh["output_tokens"] == 0  # lower bounds, not known zero usage
    with pytest.raises(BudgetExceeded):
        meter.complete(system="s", user="another", schema=None, max_tokens=40)
    assert chat.sent == fresh["calls"] == 1


def test_recovery_continuations_join_effective_source_parts():
    case = case_of({"id": "c", "group": "c", "split": "dev", "passages": [
        {"id": "p1_s0", "page": 1, "text": "Alice"}, {"id": "p2_s0", "page": 2, "text": "Paris"}],
        "schema": {"recordDescription": "person", "schemaNodes": [{"id": n, "name": n, "type": "string"} for n in ("a", "b")]}, "gold": []})
    class Chat:
        model = "fake"
        calls = 0
        def complete(self, **kw):
            self.calls += 1
            if self.calls == 1:
                return ResearchReply("{", 10, 64, "length", 0)
            first = self.calls == 2
            reply = {"records": [{"a": "Alice" if first else None, "b": None if first else "Paris"}],
                     "begins_inside_record": not first, "ends_inside_record": first}
            return ResearchReply(json.dumps(reply), 10, 30, "stop", 0)
    cfg = Config.model_validate({"chunking": {"mode": "fixed", "max_chars": 1000}, "output": {"max_tokens": 64},
                                 "recovery": {"subdivide": True, "depth": 1}, "merge": {"continuation": "flags"}})
    artifact = run_case(case, cfg, meter_for(Provider(Chat()), cfg))
    assert artifact["records"] == [{"a": "Alice", "b": "Paris"}]


def test_unfinished_attempts_cannot_refund_spent_study_budget(tmp_path):
    from tests.test_harness_study import write
    from experiments.harness import study
    from tests.helpers.harness_chat import Reader
    path = write(tmp_path)
    directory = tmp_path / "out" / "cells" / "base--c1"
    directory.mkdir(parents=True)
    (directory / "attempt-001.started.json").write_text("{}")
    with pytest.raises(ValueError, match="unfinished attempts"):
        study.run_study(path, tmp_path / "out", execute=True, uncounted=True, splits=["dev"], variants=None, provider=Provider(Reader()))


def test_canonical_production_artifacts_must_bind_the_source_snapshot():
    from tests.test_harness_production import case as production_case, ARTIFACT
    from experiments.harness.production import adapt
    case = production_case()
    case = replace(case, evidence=replace(case.evidence, generation="canonical"))
    artifact = copy.deepcopy(ARTIFACT)
    artifact.pop("digest", None)
    with pytest.raises(ValueError):
        adapt(artifact, case)


def test_wrong_headers_do_not_erase_correct_nested_records_and_nested_raw_is_not_typed():
    case = structured_case()
    prediction = predict(case)
    prediction['records'] = [copy.deepcopy(case.annotations['expected_output'])]
    for name in ('title', 'code'):
        prediction['records'][0][name] = 'wrong'
        find(prediction, 0, name).update(value='wrong', raw='wrong')
    items = find(prediction, 0, 'items')
    items['raw'] = copy.deepcopy(items['raw'])
    items['raw'][0]['quantity'] = 1.0
    count, _ = score_case(case, prediction, Eval())
    assert count['tp'] == 4 and count['raw_tp'] == 3 and count['raw_wrong_values'] == 3


def test_missing_collection_is_unannotated_and_partial_record_gold_is_not_exhaustive():
    case = structured_case()
    prediction = predict(case)
    prediction['records'] = [copy.deepcopy(case.annotations['expected_output'])]
    case.annotations['expected_output'].pop('items')
    count, _ = score_case(case, prediction, Eval())
    assert count.get('extra_record_values', 0) == 0 and count.get('hallucinated_records', 0) == 0
    case = structured_case()
    case.annotations['field_rules']['items'] = {'exhaustive': False}
    prediction['records'][0]['items'].append({'name': 'C', 'quantity': 3})
    count, _ = score_case(case, prediction, Eval())
    assert count['unadjudicated_records'] == 1 and count.get('extra_record_values', 0) == 0


def test_null_expected_accepts_documented_optional_value_without_changing_f1_denominator():
    case = structured_case()
    prediction = predict(case)
    prediction['records'] = [copy.deepcopy(case.annotations['expected_output'])]
    case.annotations['expected_output']['code'] = None
    case.annotations['field_rules']['code'] = {'evidence': [{'value': 'X', 'page': None}]}
    count, _ = score_case(case, prediction, Eval())
    assert count['optional_values_accepted'] == 1 and count.get('hallucinated_fields', 0) == 0
    assert count['gold_value_fields'] == 5 and count['tp'] == 5


def test_quote_refinement_preserves_offsets_when_quote_starts_inside_passage():
    case = case_of({"id": "c", "group": "c", "split": "dev", "passages": [{"id": "p1_s0", "page": 1, "text": "Prefix City: Rome."}],
                    "schema": {"recordDescription": "city", "schemaNodes": [{"id": "c", "name": "city", "type": "string"}]}, "gold": []})
    candidate = {"value": "Rome", "raw": "Rome", "quotes": ["City: Rome."], "ids": ["p1_s0"]}
    result = [entries_for(candidate, "Rome", case.inference(), case.evidence.passages,
                          Config.model_validate({"input": {"mode": "layout"}, "evidence": {"mode": mode}}))[0]
              for mode in ("quote", "ids")]
    assert result[0]["spans"] == result[1]["spans"] == [{"segment": "p1_s0", "start": 13, "end": 17}]
    assert result[0]["raw_spans"][0]["start"] == 7
