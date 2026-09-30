"""The evaluator counts every pairing of prediction and gold apart; a filtered population never beats the whole."""
import copy
from collections import defaultdict
from dataclasses import replace

import pytest

from experiments.harness import synth
from experiments.harness.data import case_of, check_splits
from experiments.harness.evaluate import Eval, bootstrap, check_invariants, metrics, score_case

RULES = Eval()


def make(records: int = 4, **kwargs):
    return case_of(synth.catalogue("c", records=records, **kwargs))


def row(record: int, field: str, status: str = "value", value=None, spans=(), **extra) -> dict:
    return {"record": record, "field": field, "status": status, "raw": value, "value": value,
            "evidence": [{"spans": list(spans)}] if spans else [], "flags": [], "signals": {}, **extra}


def predict(case, edit=None) -> dict:
    """A prediction copied from the gold: every annotated value is a value row citing the gold evidence."""
    fields = []
    for i, record in enumerate(case.gold):
        for name, item in record["fields"].items():
            if "value" in item:
                fields.append(row(i, name, "value", item["value"], [s for s in item.get("evidence", []) if s.get("supports", True)]))
            else:
                fields.append(row(i, name, "absent"))
    pred = {"records": [{} for _ in case.gold], "fields": fields, "cost": {}, "validity": {}}
    if edit:
        edit(pred)
    return pred


def find(pred: dict, record: int, field: str) -> dict:
    return next(r for r in pred["fields"] if r["record"] == record and r["field"] == field)


def score(case, pred):
    counts, outcomes = score_case(case, pred, RULES)
    assert check_invariants(counts) == []
    return defaultdict(int, counts), outcomes


def repeated_site_case():
    for seed in range(60):
        case = make(6, seed=seed)
        if any(not s.get("supports", True) for r in case.gold for s in r["fields"]["site"]["evidence"]):
            return case
    raise AssertionError("no seed repeats a site")


def test_a_prediction_copied_from_the_gold_scores_perfectly():
    case = make()
    counts, outcomes = score(case, predict(case))
    result = metrics(counts)
    assert counts["tp"] == 19 and counts["absent_ok"] == 1 and counts["gold_value_fields"] == 19
    assert result["field"]["precision"] == result["field"]["recall"] == result["field"]["f1"] == 1.0
    assert result["records"]["strict_documents"] == 1.0 and result["evidence"]["joint"] == 1.0
    assert result["evidence"]["decoy_hit"] == 0.0 and all(o["correct"] for o in outcomes)


def test_absent_unresolved_omitted_withheld_and_unannotated_are_counted_apart():
    case = make()
    gold = copy.deepcopy(list(case.gold))
    gold[3]["fields"]["site"] = {}                      # not annotated: leaves every denominator
    case = replace(case, gold=tuple(gold))

    def edit(pred):
        find(pred, 0, "site")["status"] = "absent"      # the model says the source does not give it
        find(pred, 0, "kreis")["status"] = "unresolved"
        find(pred, 1, "site")["status"] = "omitted"
        withheld = find(pred, 1, "kreis")
        withheld["status"] = "unsupported"              # raw value right, withheld by a gate
    counts, _ = score(case, predict(case, edit))
    assert (counts["missed_as_absent"], counts["unresolved_fields"], counts["omitted_fields"], counts["withheld_fields"],
            counts["withheld_correct"], counts["unannotated_fields"]) == (1, 1, 1, 1, 1, 1)
    assert counts["gold_value_fields"] == 18 and counts["tp"] == 14
    result = metrics(counts)["field"]
    assert result["precision"] == 1.0 and result["recall"] == 14 / 18   # abstentions cost recall, never precision


def test_a_value_where_the_gold_says_absent_is_a_hallucination_and_an_answered_absence_is_credit():
    case = make()
    counts, _ = score(case, predict(case, lambda p: find(p, 2, "date").update(status="value", value="1900", raw="1900")))
    assert counts["hallucinated_fields"] == 1 and counts["absent_ok"] == 0
    assert metrics(counts)["field"]["precision"] == 19 / 20
    counts, _ = score(case, predict(case, lambda p: find(p, 2, "date").update(status="omitted")))
    assert counts["absent_not_answered"] == 1 and counts["absent_ok"] == 0 and counts["hallucinated_fields"] == 0


def test_extra_records_are_wrong_only_when_the_gold_is_exhaustive():
    def edit(pred):
        pred["records"].append({})
        pred["fields"] += [row(4, "entry_no", value=99), row(4, "site", value="Aue")]
    case = make()
    counts, outcomes = score(case, predict(case, edit))
    assert counts["hallucinated_records"] == 1 and counts["extra_record_values"] == 2 and counts["duplicated_records"] == 0
    assert metrics(counts)["field"]["precision"] == 19 / 21
    assert sum(not o["correct"] for o in outcomes) == 2
    open_gold = replace(case, exhaustive=False)
    counts, outcomes = score(open_gold, predict(open_gold, edit))
    assert counts["unadjudicated_records"] == 1 and counts["extra_record_values"] == 0
    assert metrics(counts)["field"]["precision"] == 1.0 and all(o["correct"] for o in outcomes)


def test_a_repeated_key_is_a_duplicate_and_not_a_hallucination():
    def edit(pred):
        pred["records"].append({})
        pred["fields"] += [row(4, "entry_no", value=40), row(4, "site", value="Zzz")]
    case = make()
    counts, _ = score(case, predict(case, edit))
    assert counts["duplicated_records"] == 1 and counts["hallucinated_records"] == 0
    assert metrics(counts)["records"]["strict_documents"] == 0.0     # a duplicate breaks strict document correctness


def test_records_without_a_key_are_assigned_order_insensitively_and_by_shared_values():
    case = replace(make(), record_key=())
    pred = predict(case)
    shuffled = {**pred, "fields": [{**r, "record": (r["record"] + 1) % 4} for r in pred["fields"]]}
    counts, _ = score(case, shuffled)
    assert counts["matched_records"] == 4 and counts["tp"] == 19          # order does not matter
    stranger = predict(case, lambda p: [r.update(value="Nope") for r in p["fields"] if r["record"] == 0 and r["field"] in ("site", "kreis")])
    counts, _ = score(replace(case, gold=tuple(case.gold)), stranger)
    assert counts["matched_records"] == 4                                  # two of five annotated fields still agree


def test_a_repeated_quote_cited_at_the_wrong_occurrence_is_a_decoy_hit_with_a_correct_value():
    case = repeated_site_case()
    j = next(i for i, r in enumerate(case.gold) if any(not s.get("supports", True) for s in r["fields"]["site"]["evidence"]))
    decoy = next(s for s in case.gold[j]["fields"]["site"]["evidence"] if not s.get("supports", True))
    cited = {k: v for k, v in decoy.items() if k != "supports"}

    def edit(pred):
        find(pred, j, "site")["evidence"] = [{"spans": [cited]}]
    counts, outcomes = score(case, predict(case, edit))
    result = metrics(counts)["evidence"]
    assert counts["ev_decoy_hit"] == 1 and counts["tp"] == counts["gold_value_fields"]      # the value is right
    assert counts["ev_joint"] == counts["ev_gold_fields"] - 1                                # the evidence is not
    assert result["span_hit_given_correct"] == (counts["ev_gold_fields"] - 1) / counts["ev_value_correct"]
    assert next(o for o in outcomes if (o["record"], o["field"]) == (j, "site"))["supported"] is False


def test_unannotated_evidence_is_neither_right_nor_wrong():
    case = make()
    gold = copy.deepcopy(list(case.gold))
    del gold[0]["fields"]["site"]["evidence"]
    case = replace(case, gold=tuple(gold))
    counts, outcomes = score(case, predict(case))
    assert counts["ev_gold_fields"] == 18                                  # one field left the evidence denominators
    assert next(o for o in outcomes if (o["record"], o["field"]) == (0, "site"))["supported"] is None
    counts, _ = score(case, predict(case, lambda p: find(p, 0, "site").update(evidence=[])))
    assert counts["ev_gold_fields"] == 18 and counts["ev_cited"] == 18     # no citation on it changes nothing


def test_a_verifier_verdict_is_scored_against_annotated_spans_only():
    case = repeated_site_case()
    j = next(i for i, r in enumerate(case.gold) if any(not s.get("supports", True) for s in r["fields"]["site"]["evidence"]))
    decoy = {k: v for k, v in next(s for s in case.gold[j]["fields"]["site"]["evidence"] if not s.get("supports", True)).items() if k != "supports"}

    def edit(pred):
        for r in pred["fields"]:
            r["verdict"] = {"supports_value": True}
        find(pred, j, "site")["evidence"] = [{"spans": [decoy]}]           # the verifier accepted a decoy
    counts, _ = score(case, predict(case, edit))
    assert counts["verdict_fp"] == 1
    assert counts["verdict_tp"] == counts["ev_gold_fields"] - 1


def test_cross_page_records_and_their_fragments_are_reported():
    def edit(pred):
        find(pred, 2, "finds")["status"] = "omitted"        # entry 42 continues on page 2: the model lost its tail
    case = make()
    counts, _ = score(case, predict(case, edit))
    assert counts["cross_page_gold"] == 1 and counts["cross_page_matched"] == 1 and counts["cross_page_strict"] == 0

    def fragment(pred):
        pred["records"].append({})
        pred["fields"] += [row(4, "site", value=case.gold[2]["fields"]["site"]["value"]),
                           row(4, "finds", value=list(case.gold[2]["fields"]["finds"]["value"]))]
    keyless = replace(case, record_key=())
    counts, _ = score(keyless, predict(keyless, fragment))
    assert counts["duplicated_records"] == 1 and counts["cross_page_fragments"] == 1


def test_the_partition_invariant_flags_a_counting_bug():
    counts, _ = score(make(), predict(make()))
    counts["tp"] += 1
    assert check_invariants(counts)


def test_filtering_a_population_never_beats_the_whole():
    case = make(6)
    counts, outcomes = score(case, predict(case, lambda p: find(p, 0, "site").update(value="Nope")))
    everything = [o for o in outcomes]
    original = sum(o["correct"] for o in everything) / len(everything)
    for cut in range(len(everything) + 1):
        kept = everything[:cut]
        if kept:
            assert len(kept) / len(everything) * (sum(o["correct"] for o in kept) / len(kept)) <= original + 1e-12


def test_intervals_resample_groups_not_fields():
    cases = [make(3, seed=s) for s in range(4)]
    per_group = {f"g{i}": score(c, predict(c, lambda p, i=i: find(p, 0, "site").update(value="Nope") if i % 2 else None))[0]
                 for i, c in enumerate(cases)}
    statistic = lambda total: metrics(total)["field"]["recall"]   # noqa: E731
    first = bootstrap(per_group, statistic, draws=300)
    assert first == bootstrap(per_group, statistic, draws=300)           # seeded: reproducible
    assert first["unit"] == "group" and first["groups"] == 4 and first["interval"][0] <= first["point"] <= first["interval"][1]
    assert bootstrap({"only": per_group["g0"]}, statistic)["interval"] is None       # one group: no interval claimed


def test_a_dataset_whose_group_spans_two_splits_is_refused():
    inline = [synth.catalogue("a", group="x", split="dev"), synth.catalogue("b", group="x", split="test")]
    with pytest.raises(ValueError, match="split leakage"):
        check_splits([case_of(item) for item in inline])
    with pytest.raises(ValueError, match="repeat"):
        check_splits([case_of(synth.catalogue("a")), case_of(synth.catalogue("a", group="other"))])
    with pytest.raises(ValueError, match="not one of"):
        check_splits([case_of(synth.catalogue("a", split="validation"))])


def test_one_shared_value_does_not_make_a_duplicate_and_ineligible_edges_do_not_steal_pairs():
    case = replace(make(), record_key=())
    one = predict(case, lambda p: (p["records"].append({}), p["fields"].append(row(4, "kreis", value=case.gold[0]["fields"]["kreis"]["value"]))))
    counts, _ = score(case, one)
    assert counts["duplicated_records"] == 0 and counts["hallucinated_records"] == 1     # one shared value proves nothing


def test_an_ineligible_edge_cannot_displace_an_eligible_pair():
    import numpy as np
    from experiments.harness.evaluate import assign
    assert sorted(assign(np.array([[5.0, 3.0], [3.0, 2.0]]), [3, 3])) == [(0, 1), (1, 0)]   # two eligible pairs beat the higher diagonal
    assert assign(np.array([[1.0, 0.0], [0.0, 1.0]]), [2, 2]) == []


def test_a_citation_outside_the_source_snapshot_is_an_error_not_a_miss():
    case = make()
    pred = predict(case)
    find(pred, 0, "site")["evidence"] = [{"spans": [{"segment": "p1_s0", "start": 5, "end": 9999}]}]
    with pytest.raises(ValueError, match="does not resolve"):
        score_case(case, pred, RULES)
    find(pred, 0, "site")["evidence"] = [{"spans": [{"segment": "p9_s9", "start": 0, "end": 3}]}]
    with pytest.raises(ValueError, match="does not resolve"):
        score_case(case, pred, RULES)


def test_every_predicted_value_with_a_defined_correctness_is_exactly_one_outcome_duplicates_and_extras_included():
    case = make()
    key = case.gold[0]["fields"]["entry_no"]["value"]

    def edit(pred):
        find(pred, 2, "date").update(status="value", value="1900", raw="1900")                     # a value the gold says is absent
        find(pred, 1, "site").update(value="Zzz", raw="Zzz")                                        # a wrong value
        pred["records"] += [{}, {}]
        pred["fields"] += [row(4, "entry_no", "value", key), row(4, "site", "value", "Zzz"),        # a copy of the record keyed like gold record 0
                           row(5, "entry_no", "value", 999)]                                        # a record the exhaustive gold lacks
    counts, outcomes = score(case, predict(case, edit))
    assert (counts["duplicate_values"], counts["extra_record_values"], counts["hallucinated_fields"], counts["wrong_values"]) == (2, 1, 1, 1)
    assert len(outcomes) == counts["tp"] + counts["wrong_values"] + counts["hallucinated_fields"] + counts["duplicate_values"] + counts["extra_record_values"]
    assert metrics(counts)["field"]["predicted_values"] == len(outcomes)
    assert not any(o["correct"] for o in outcomes if o["record"] >= 4)                             # copies and extras are never right


def test_a_run_that_found_nothing_has_f1_zero_and_only_nothing_at_all_is_undefined():
    case = make()
    counts, _ = score(case, {"records": [], "fields": [], "cost": {}, "validity": {}})
    field = metrics(counts)["field"]
    assert field["precision"] is None and field["recall"] == 0.0 and field["f1"] == 0.0               # a total miss is a zero, not a gap
    assert metrics({})["field"]["f1"] is None
    counts, _ = score(case, predict(case, lambda p: find(p, 0, "site").update(value="Zzz", raw="Zzz")))
    field = metrics(counts)["field"]
    assert field["f1"] == pytest.approx(2 * field["precision"] * field["recall"] / (field["precision"] + field["recall"]))
