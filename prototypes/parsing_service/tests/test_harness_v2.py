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
from experiments.harness.extract import reply_schema, system_prompt
from experiments.harness.model import BudgetExceeded, Provider, ResearchReply
from experiments.harness.run import meter_for, run_case
from kei_exp.kie.extract.schema import Schema, json_schema, notes
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


@pytest.mark.parametrize("shape", ["inline", "ref", "nullable_union", "ref_sibling", "union_sibling", "intersect_ref"])
def test_dataset_string_choices_reach_constraints_and_prompts_without_answer_annotations(shape):
    from jsonschema import Draft202012Validator
    field = {"type": "string", "enum": ["open", "closed"], "description": "The answer is SECRET", "examples": ["SECRET"]}
    defs = {}
    if shape in ("ref", "ref_sibling", "intersect_ref"):
        defs = {"Status": field if shape != "ref_sibling" else {"type": "string"}}
        field = {"$ref": "#/$defs/Status"}
        if shape in ("ref_sibling", "intersect_ref"):
            field["enum"] = ["open", "closed", "invalid"] if shape == "intersect_ref" else ["open", "closed"]
    elif shape in ("nullable_union", "union_sibling"):
        field = {"anyOf": [field if shape == "nullable_union" else {"type": "string"}, {"type": "null"}]}
        if shape == "union_sibling":
            field["enum"] = ["open", "closed", None]
    adapted = inference_schema({"type": "object", "properties": {"status": field}, "$defs": defs})
    schema = Schema.model_validate(adapted)
    assert schema.nodes[0].allowed_values == ["open", "closed"]
    assert "SECRET" not in json.dumps(adapted)
    assert any("open" in line and "closed" in line for line in notes(schema.nodes))
    validator = Draft202012Validator(json_schema(schema.nodes))
    assert not list(validator.iter_errors({"status": "open"}))
    assert list(validator.iter_errors({"status": "invalid"}))
    case = case_of({"id": "choices", "group": "choices", "split": "dev", "schema": adapted,
                    "passages": [{"id": "p1_s0", "page": 1, "text": "Status: open"}], "gold": []}).inference()
    for override in ({}, {"merge": {"continuation": "flags"}}, {"evidence": {"mode": "quote"}},
                     {"input": {"mode": "layout"}, "evidence": {"mode": "ids"}}):
        cfg = Config.model_validate({"chunking": {"mode": "fixed", "max_chars": 4000}, **override})
        response = reply_schema(schema.nodes, cfg, ["p1_s0"])
        field_response = response["properties"]["records"]["items"]["properties"]["status"]
        constraint = field_response["properties"]["value"] if cfg.evidence.mode != "none" else field_response
        assert constraint["enum"] == ["open", "closed", None]
        prompt = system_prompt(case, schema.nodes, cfg, response)
        assert "open" in prompt and "closed" in prompt and "SECRET" not in prompt


def test_dataset_choices_survive_refs_inside_repeated_objects():
    source = {"type": "object", "properties": {"rows": {"type": "array", "items": {"$ref": "#/$defs/Row"}}},
              "$defs": {"Row": {"type": "object", "properties": {"status": {"type": ["string", "null"],
                       "enum": ["open", "closed", None]}}}}}
    schema = Schema.model_validate(inference_schema(source))
    assert schema.nodes[0].children[0].allowed_values == ["open", "closed"]
    assert any("rows.status" in line and "closed" in line for line in notes(schema.nodes))


@pytest.mark.parametrize("field", [
    {"type": "string", "enum": ["single"]},
    {"type": "integer", "enum": [1, 2]},
    {"type": "array", "items": {"type": "string", "enum": ["open", "closed"]}},
])
def test_unrepresentable_dataset_choices_refuse_instead_of_silently_relaxing_the_task(field):
    with pytest.raises(ValueError, match="enum"):
        inference_schema({"type": "object", "properties": {"status": field}})


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


# --- assembly across chunks, parent/child scoring, unannotated collections ----------------------------------------------

def paged_case(scope="document"):
    schema = inference_schema({"type": "object", "properties": {"title": {"type": "string"},
        "vendor": {"type": "object", "properties": {"name": {"type": "string"}, "city": {"type": "string"}}},
        "items": {"type": "array", "items": {"type": "object", "properties": {"name": {"type": "string"}, "quantity": {"type": "number"}}}}}})
    expected = {"title": "Invoice", "vendor": {"name": "Acme", "city": "Rome"},
                "items": [{"name": "A", "quantity": 1}, {"name": "B", "quantity": 2}, {"name": "A", "quantity": 3}, {"name": "C", "quantity": 1}]}
    return case_of({"id": "paged", "group": "g", "split": "dev", "record_scope": scope, "schema": schema,
                    "passages": [{"id": f"p{k}_s0", "page": k, "text": f"PAGE{k}"} for k in (1, 2, 3)],
                    "gold": [{"fields": {k: {"value": v} for k, v in expected.items()}}],
                    "annotations": {"adapter": "extractbench-v1", "expected_output": expected, "field_rules": {}}})


PAGE_REPLIES = {    # one document read page by page: a partial vendor, an item repeated at the cut, a similar but distinct item
    1: [{"title": "Invoice", "vendor": {"name": "Acme", "city": None}, "items": [{"name": "A", "quantity": 1}, {"name": "B", "quantity": 2}]}],
    2: [{"title": None, "vendor": {"name": "Acme", "city": "Rome"}, "items": [{"name": "B", "quantity": 2}, {"name": "A", "quantity": 3}]}],
    3: [{"title": None, "vendor": None, "items": [{"name": "C", "quantity": 1}]}]}


class Pages:
    """Answers each page's chunk with its scripted records; under continuation flags every page continues the document."""
    model, accepts_sampling = "stub", True

    def __init__(self, replies):
        self.replies = replies

    def complete(self, *, system, user, schema, **_):
        from tests.helpers.harness_chat import sections
        page = next(k for k in self.replies if f"PAGE{k}" in sections(user)["SOURCE"])
        flags = {"begins_inside_record": page > 1, "ends_inside_record": page < len(self.replies)} if "begins_inside_record" in system else {}
        return ResearchReply(json.dumps({"records": self.replies[page], **flags}), 10, 5, "stop", 0.0)


def run_pages(case, replies=PAGE_REPLIES, **config):
    cfg = Config.model_validate({"chunking": {"mode": "page", "max_chars": 2000}, **config})
    return run_case(case, cfg, meter_for(Provider(Pages(replies)), cfg))


def by_field(artifact, record=0):
    return {r["field"]: r for r in artifact["fields"] if r["record"] == record}


def test_a_document_root_read_in_chunks_is_one_record_that_keeps_every_nested_item():
    case = paged_case()
    artifact = run_pages(case)
    assert len(artifact["records"]) == 1
    rows = by_field(artifact)
    expected = case.annotations["expected_output"]["items"]
    assert rows["items"]["value"] == rows["items"]["raw"] == [*expected[:2], expected[1], *expected[2:]]   # reading order, raw aligned
    assert "possible_repeated_items" in rows["items"]["flags"] and len(rows["items"]["contributors"]) == 3
    assert rows["vendor"]["value"] == {"name": "Acme", "city": "Rome"}   # a null child does not erase a stated one
    counts, _ = score_case(case, artifact, Eval())
    assert not check_invariants(counts) and counts["tp"] == counts["gold_value_fields"] == 11
    assert counts.get("hallucinated_records", 0) == 0 and counts["repeated_duplicated_records"] == 1   # B at the cut stays visible


def items_of(replies, **config):
    rows = by_field(run_pages(paged_case(), replies, **config))
    return [(i["name"], i["quantity"]) for i in rows["items"]["value"]], rows["items"]["flags"]


def test_identical_looking_rows_are_never_folded_by_value_alone():
    row = lambda name, quantity: {"name": name, "quantity": quantity}
    reply = lambda *items: [{"title": None, "vendor": None, "items": list(items)}]
    within = items_of({1: reply(row("A", 1), row("A", 1)), 2: reply(), 3: reply()})
    assert within == ([("A", 1), ("A", 1)], [])                                      # two rows of one reply
    across = items_of({1: reply(row("A", 1)), 2: reply(row("A", 1)), 3: reply()})
    assert across == ([("A", 1), ("A", 1)], ["possible_repeated_items"])              # equal whole lists from two chunks
    overlap = items_of({1: reply(row("A", 1), row("B", 2)), 2: reply(row("B", 2), row("C", 1)), 3: reply()},
                       chunking={"mode": "page", "max_chars": 2000, "overlap": 1})
    assert overlap == ([("A", 1), ("B", 2), ("B", 2), ("C", 1)], ["possible_repeated_items"])   # B re-read through the overlap
    similar = items_of({1: reply(row("A", 1)), 2: reply(row("A", 3)), 3: reply()})
    assert similar == ([("A", 1), ("A", 3)], [])                                      # alike, not equal: no flag


def test_a_continuation_merge_unions_nested_items_and_a_collection_scope_keeps_chunk_records_apart():
    case = paged_case("records")
    joined = run_pages(case, merge={"continuation": "flags"})
    assert len(joined["records"]) == 1 and len(joined["records"][0]["items"]) == 5   # was: a false conflict, no items; B at the cut stays twice
    apart = run_pages(case)
    assert [len(r["items"]) for r in apart["records"]] == [2, 2, 1]                   # nothing declares one record per document


def test_a_conflicting_nested_value_is_held_and_repeats_within_one_reply_are_kept():
    replies = {**PAGE_REPLIES, 2: [{"title": None, "vendor": {"name": "Acme", "city": "Milan"}, "items": []}],
               3: [{"title": None, "vendor": {"name": "Acme", "city": "Rome"}, "items": [{"name": "C", "quantity": 1}, {"name": "C", "quantity": 1}]}]}
    rows = by_field(run_pages(paged_case(), replies))
    assert rows["vendor"]["status"] == "unresolved" and "conflict" in rows["vendor"]["flags"]
    assert {a["value"]["city"] for a in rows["vendor"]["alternatives"]} == {"Rome", "Milan", None}
    assert [i["name"] for i in rows["items"]["value"]] == ["A", "B", "C", "C"] and "possible_repeated_items" not in rows["items"]["flags"]


def test_samples_of_a_document_root_align_into_one_record_even_when_they_share_nothing():
    from experiments.harness.merge import align_samples
    field = lambda v: {"status": "value", "value": v, "entries": []}
    per_sample = [[{"first": (0, 0), "fields": {"title": field("A")}}], [{"first": (0, 0), "fields": {"title": field("B")}}]]
    assert len(align_samples(per_sample, paged_case(), Config())) == 1
    assert len(align_samples(per_sample, paged_case("records"), Config())) == 2


def structured_prediction(*records):
    rows = [{"record": i, "field": k, "status": "value" if v is not None else "absent", "raw": v, "value": v, "evidence": [],
             "flags": [], "signals": {}} for i, record in enumerate(records) for k, v in record.items()]
    return {"records": list(records), "fields": rows, "cost": {}, "validity": {}}


def nested_case(schema, expected):
    return case_of({"id": "n", "group": "n", "split": "dev", "passages": [{"id": "p1_s0", "page": 1, "text": "x"}],
                    "schema": inference_schema(schema), "gold": [{"fields": {k: {"value": v} for k, v in expected.items()}}],
                    "annotations": {"adapter": "extractbench-v1", "expected_output": expected, "field_rules": {}}})


def test_children_are_scored_under_their_own_parent_when_parents_share_attributes():
    spec = {"type": "array", "items": {"type": "object", "properties": {"label": {"type": "string"}, "value": {"type": "string"}}}}
    schema = {"type": "object", "properties": {"products": {"type": "array", "items": {"type": "object", "properties": {
        "model": {"type": "string"}, "brand": {"type": "string"}, "kind": {"type": "string"}, "specs": spec}}}}}
    first = {"model": "312C", "brand": "CAT", "kind": "excavator", "specs": [{"label": "Weight", "value": "10 t"}, {"label": "Power", "value": "70 kW"}]}
    second = {"model": "320C", "brand": "CAT", "kind": "excavator", "specs": [{"label": "Weight", "value": "20 t"}, {"label": "Power", "value": "100 kW"}]}
    case = nested_case(schema, {"products": [first, second]})
    right, _ = score_case(case, structured_prediction({"products": [first, second]}), Eval())
    assert right["tp"] == right["gold_value_fields"] == 14
    swapped = [{**first, "specs": second["specs"]}, {**second, "specs": first["specs"]}]      # right children, wrong parent
    counts, _ = score_case(case, structured_prediction({"products": swapped}), Eval())
    assert not check_invariants(counts) and counts["tp"] == 6                               # only the parents' own fields
    assert counts["repeated_matched_records"] == 2 and counts["repeated_hallucinated_records"] == counts["repeated_missing_records"] == 4


def test_an_unannotated_nested_collection_is_unscored_under_every_parent():
    adjust = {"type": "array", "items": {"type": "object", "properties": {"name": {"type": "string"}, "amount": {"type": "number"}}}}
    schema = {"type": "object", "properties": {"vehicles": {"type": "array", "items": {"type": "object", "properties": {
        "vin": {"type": "string"}, "price": {"type": "number"}, "adjustments": adjust}}}}}
    case = nested_case(schema, {"vehicles": [{"vin": "V1", "price": 100}, {"vin": "V2", "price": 200}]})   # adjustments never annotated

    def scored(extra):
        vehicles = [{"vin": "V1", "price": 100, "adjustments": extra[:1]}, {"vin": "V2", "price": 200, "adjustments": extra[1:2]},
                    {"vin": "V9", "price": 900, "adjustments": extra[2:]}]                    # V9 is spurious
        counts, _ = score_case(case, structured_prediction({"vehicles": vehicles}), Eval())
        assert not check_invariants(counts)
        return counts
    many, none = scored([{"name": n, "amount": 1} for n in "abcd"]), scored([])
    keys = ("tp", "gold_value_fields", "pred_records", "hallucinated_records", "extra_record_values", "wrong_values")
    assert {k: many.get(k, 0) for k in keys} == {k: none.get(k, 0) for k in keys}
    assert many["hallucinated_records"] == 1 and many["unscored_records"] == 4 and none.get("unscored_records", 0) == 0
    assert metrics(many)["field"]["f1"] == metrics(none)["field"]["f1"]


def test_a_singular_root_pairs_structurally_but_its_wrong_values_stay_wrong():
    schema = {"type": "object", "properties": {"number": {"type": "string"}, "total": {"type": "number"}, "vendor": {"type": "string"}}}
    case = nested_case(schema, {"number": "INV-1", "total": 10, "vendor": "Acme"})
    counts, _ = score_case(case, structured_prediction({"number": "INV-9", "total": 99, "vendor": "Other"}), Eval())
    assert not check_invariants(counts) and counts["matched_records"] == 1                  # an alignment decision
    assert counts.get("tp", 0) == 0 and counts["wrong_values"] == 3 and counts.get("strict_records", 0) == 0


def test_unannotated_and_explicitly_empty_collections_differ_under_matched_duplicate_and_extra_parents():
    adjust = {"type": "array", "items": {"type": "object", "properties": {"name": {"type": "string"}, "amount": {"type": "number"}}}}
    schema = {"type": "object", "properties": {"vehicles": {"type": "array", "items": {"type": "object", "properties": {
        "vin": {"type": "string"}, "price": {"type": "number"}, "adjustments": adjust}}}}}
    gold = [{"vin": "V1", "price": 1}, {"vin": "V2", "price": 2, "adjustments": []}, {"vin": "V3", "price": 3, "adjustments": None}]
    case = nested_case(schema, {"vehicles": gold})         # one path, unannotated under V1 and annotated empty under V2/V3
    one = lambda name: [{"name": name, "amount": 1}]
    predicted = [{"vin": "V1", "price": 1, "adjustments": one("a")},   # matched, unannotated: unscored
                 {"vin": "V2", "price": 2, "adjustments": one("b")},   # matched, explicitly empty: spurious
                 {"vin": "V3", "price": 3, "adjustments": one("c")},   # matched, explicit null: spurious
                 {"vin": "V1", "price": 1, "adjustments": one("d")},   # duplicate of V1: unscored like V1's
                 {"vin": "V2", "price": 2, "adjustments": one("e")},   # duplicate of V2: spurious like V2's
                 {"vin": "V9", "price": 9, "adjustments": one("f")}]   # extra: its availability is unknown on a mixed path
    counts, _ = score_case(case, structured_prediction({"vehicles": predicted}), Eval())
    assert not check_invariants(counts)
    path = lambda key: counts.get(f"path|document.vehicles.adjustments|{key}", 0)
    assert (path("hallucinated_records"), path("unscored_records"), path("unknown_availability_records")) == (3, 3, 1)
    assert path("matched_records") == path("gold_records") == 0
    parents = lambda key: counts.get(f"path|document.vehicles|{key}", 0)
    assert (parents("matched_records"), parents("duplicated_records"), parents("hallucinated_records")) == (3, 2, 1)   # V9 stays spurious
    assert counts["repeated_pred_records"] == 6 + 3 and counts["unscored_records"] == 3


def test_a_nested_loss_in_one_collection_shows_in_its_own_path_counts():
    spec = {"type": "array", "items": {"type": "object", "properties": {"k": {"type": "string"}, "v": {"type": "string"}}}}
    schema = {"type": "object", "properties": {"id": {"type": "string"}, "left": spec, "right": spec}}
    rows = lambda *ks: [{"k": k, "v": k} for k in ks]
    case = nested_case(schema, {"id": "D", "left": rows("a", "b"), "right": rows("c", "d")})
    counts, _ = score_case(case, structured_prediction({"id": "D", "left": rows("a", "b", "x", "y"), "right": []}), Eval())
    path = lambda p, key: counts.get(f"path|document.{p}|{key}", 0)
    assert (path("left", "matched_records"), path("right", "matched_records"), path("right", "missing_records")) == (2, 0, 2)
    assert counts["repeated_matched_records"] == 2 and path("left", "hallucinated_records") == 2


def test_a_collection_task_and_a_document_task_stay_distinguishable():
    from experiments.harness.synth import catalogue
    assert case_of(catalogue("s", records=3)).record_scope == "records"          # a collection of keyed records
    assert paged_case().record_scope == "document"
    with pytest.raises(ValueError, match="record_scope"):
        paged_case("rows")
