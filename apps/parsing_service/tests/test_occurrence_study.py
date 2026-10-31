"""The offline scorer separates missing occurrences, wrong values, pages and exact source ranges."""
from copy import deepcopy

from experiments.extraction.occurrence_study import fixture, metrics, origin_gold


def result_for(case):
    origins = origin_gold(case)
    return {
        "records": [deepcopy(case["expected"])],
        "evidence": [{"path": ["records", 0, *leaf["path"]], "page": leaf["page"],
                      "segment": leaf["segment"]} for leaf in case["gold"]],
        "quoted_support": [{"path": ["records", 0, *leaf["path"]],
                            **{key: leaf[key] for key in ("segment", "start", "end")}} for leaf in case["gold"]],
        "value_origins": [{"path": ["records", 0, *path], "sources": sources} for path, sources in origins.items()],
        "calls": [], "tokens": {"input": 0, "output": 0}, "issues": [], "completion": {},
        "complete": False, "ungrounded": [],
    }


def test_same_page_mislink_passes_page_metric_but_fails_exact_span_metric():
    case = fixture("equal", [["Item Slot0000: amount 10.", "Item Slot0000: amount 10."]])
    result = result_for(case)
    for proof in result["quoted_support"]:
        proof["segment"] = "p1_s0"
    score = metrics(case, result)
    assert score["array_occurrence_f1"] == score["field_value_f1"] == 1
    assert score["page_occurrence_accuracy"] == score["exact_origin_source_accuracy"] == 1
    assert score["canonical_span_occurrence_accuracy"] == .5


def test_equal_counts_can_hide_one_missing_and_one_extra_occurrence():
    case = fixture("wrong", [["Item Slot0000: amount 10.", "Item Slot0001: amount 11."]])
    result = result_for(case)
    result["records"][0]["items"][1]["amount"] = 99
    score = metrics(case, result)
    assert score["array_count_delta"] == 0
    assert score["missing_array_occurrences"] == score["extra_array_occurrences"] == 1
    assert score["array_occurrence_f1"] == .5
    assert score["page_occurrence_accuracy"] == .5


def test_missing_tail_lowers_recall_even_if_every_returned_value_is_correct():
    case = fixture("missing", [["Item Slot0000: amount 10.", "Item Slot0001: amount 11."]])
    result = result_for(case)
    result["records"][0]["items"].pop()
    for key in ("evidence", "quoted_support", "value_origins"):
        result[key] = [entry for entry in result[key] if entry["path"][3] == 0]
    score = metrics(case, result)
    assert score["array_occurrence_precision"] == score["field_value_precision"] == 1
    assert score["array_occurrence_recall"] == score["field_value_recall"] == .5
    assert score["supported_returned_leaves"] == 2
